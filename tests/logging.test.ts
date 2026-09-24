// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  LOG_MAX_RUNS,
  appendRecord,
  findResumable,
  foldLogEvent,
  newTurnRecord,
  summarizeRecord,
  toJsonl,
  toMarkdown,
  type LogTurnRecord,
} from "../extension/src/shared/logging";

describe("run log folding", () => {
  it("records a full turn with per-turn timestamps and tool timings", () => {
    const rec = newTurnRecord("Book a table", { conversationId: "c1", mode: "standard", at: 1_000 });
    foldLogEvent(rec, { kind: "step_started", stepIndex: 0 }, 1_000);
    foldLogEvent(rec, { kind: "reasoning_delta", text: "thinking…" }, 1_050);
    foldLogEvent(rec, { kind: "token_delta", text: "Looking " }, 1_100);
    foldLogEvent(rec, { kind: "token_delta", text: "around." }, 1_200);
    foldLogEvent(
      rec,
      { kind: "tool_call", stepIndex: 0, name: "navigate", args: { url: "x" } },
      1_300,
    );
    foldLogEvent(
      rec,
      { kind: "tool_result", stepIndex: 0, name: "navigate", result: "ok", ok: true },
      1_500,
    );
    foldLogEvent(rec, { kind: "done", summary: "Booked." }, 2_000);

    expect(rec.turns).toHaveLength(1);
    const turn = rec.turns[0]!;
    expect(turn.startedAt).toBe(1_000);
    expect(turn.endedAt).toBe(2_000);
    expect(turn.durationMs).toBe(1_000);
    expect(turn.text).toBe("Looking around.");
    expect(turn.reasoning).toBe("thinking…");
    expect(turn.summary).toBe("Booked.");
    expect(rec.toolCalls).toBe(1);
    expect(rec.status).toBe("done");
    expect(rec.durationMs).toBe(1_000);

    // tool call carries its own timing + raw args
    const call = turn.tools[0]!;
    expect(call).toMatchObject({
      index: 0,
      name: "navigate",
      args: '{"url":"x"}',
      at: 1_300,
      ok: true,
      result: "ok",
      finishedAt: 1_500,
      durationMs: 200,
    });
  });

  it("splits turns and keeps call order across steps", () => {
    const rec = newTurnRecord("t", { at: 0 });
    foldLogEvent(rec, { kind: "step_started", stepIndex: 0 }, 0);
    foldLogEvent(rec, { kind: "token_delta", text: "one" }, 10);
    foldLogEvent(rec, { kind: "step_started", stepIndex: 1 }, 100);
    foldLogEvent(rec, { kind: "token_delta", text: "two" }, 110);
    foldLogEvent(rec, { kind: "done", summary: "fin" }, 200);

    expect(rec.turns).toHaveLength(2);
    expect(rec.turns[0]).toMatchObject({ index: 0, generation: 0, text: "one", endedAt: 100 });
    expect(rec.turns[1]).toMatchObject({ index: 1, generation: 1, text: "two" });
  });

  it("does not open an empty turn on a bare step boundary", () => {
    const rec = newTurnRecord("t");
    foldLogEvent(rec, { kind: "step_started", stepIndex: 0 });
    foldLogEvent(rec, { kind: "step_started", stepIndex: 1 });
    expect(rec.turns).toHaveLength(1);
  });

  it("matches results to calls in call order and flags images", () => {
    const rec = newTurnRecord("t");
    foldLogEvent(rec, { kind: "tool_call", stepIndex: 0, name: "snapshot", args: {} });
    foldLogEvent(rec, { kind: "tool_call", stepIndex: 0, name: "screenshot", args: {} });
    foldLogEvent(rec, {
      kind: "tool_result",
      stepIndex: 0,
      name: "snapshot",
      result: "tree",
      ok: true,
    });
    foldLogEvent(rec, {
      kind: "tool_result",
      stepIndex: 0,
      name: "screenshot",
      result: "[captured]",
      ok: true,
      image: "data:image/jpeg;base64,AAA",
    });
    const tools = rec.turns[0]!.tools;
    expect(tools[0]).toMatchObject({ name: "snapshot", result: "tree" });
    expect(tools[1]).toMatchObject({ name: "screenshot", result: "[captured]", image: true });
    // the data URL itself never lands in the log
    expect(JSON.stringify(rec)).not.toContain("base64");
  });

  it("truncates oversized tool results", () => {
    const rec = newTurnRecord("t");
    foldLogEvent(rec, { kind: "tool_call", stepIndex: 0, name: "read_page", args: {} });
    foldLogEvent(rec, {
      kind: "tool_result",
      stepIndex: 0,
      name: "read_page",
      result: "x".repeat(9_000),
      ok: true,
    });
    const call = rec.turns[0]!.tools[0]!;
    expect(call.truncated).toBe(true);
    expect(call.result!.length).toBeLessThan(9_000);
    expect(call.result).toContain("[truncated");
  });

  it("captures exclamations, confirmations and errors", () => {
    const rec = newTurnRecord("t", { at: 0 });
    foldLogEvent(rec, { kind: "madman", message: "MOVE IT" }, 5);
    foldLogEvent(
      rec,
      { kind: "need_confirm", id: "n1", tool: "type", summary: "password field" },
      6,
    );
    foldLogEvent(rec, { kind: "error", message: "boom" }, 7);
    const turn = rec.turns[0]!;
    expect(turn.exclamations).toEqual([{ at: 5, message: "MOVE IT" }]);
    expect(turn.confirmations[0]).toMatchObject({ id: "n1", tool: "type" });
    expect(turn.errors).toEqual([{ at: 7, message: "boom" }]);
    expect(rec.status).toBe("error");
    expect(rec.durationMs).toBe(7);
  });

  it("accumulates usage totals from done stats", () => {
    const rec = newTurnRecord("t", { at: 0 });
    foldLogEvent(
      rec,
      {
        kind: "done",
        summary: "s",
        stats: {
          steps: 3,
          totalTokens: 120,
          outputTokens: 40,
          inputTokens: 80,
          tokensPerSec: 12.5,
          contextTokens: 900,
          contextWindow: 128_000,
          elapsedMs: 5_000,
        },
      },
      10,
    );
    expect(rec.totalTokens).toBe(120);
    expect(rec.turns[0]!.stats?.steps).toBe(3);
  });
});

describe("run log store helpers", () => {
  it("keeps records newest-first and caps the ring", () => {
    let all: LogTurnRecord[] = [];
    for (let i = 0; i < LOG_MAX_RUNS + 5; i += 1) {
      all = appendRecord(all, newTurnRecord(`t${i}`, { at: i }), LOG_MAX_RUNS);
    }
    expect(all).toHaveLength(LOG_MAX_RUNS);
    expect(all[0]!.task).toBe(`t${LOG_MAX_RUNS + 4}`);
    expect(all[all.length - 1]!.task).toBe("t5");
  });

  it("replaces a record with the same id instead of duplicating it", () => {
    const rec = newTurnRecord("t", { at: 1 });
    let all = appendRecord([], rec);
    rec.status = "done";
    all = appendRecord(all, rec);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("done");
  });

  it("resumes only an open record for the same conversation", () => {
    const open = newTurnRecord("a", { conversationId: "c1", at: 1 });
    const closed = newTurnRecord("b", { conversationId: "c2", at: 2 });
    closed.status = "done";
    expect(findResumable([open, closed], "c1")?.task).toBe("a");
    expect(findResumable([open, closed], "c2")).toBeNull();
    expect(findResumable([open, closed], undefined)).toBeNull();
  });

  it("summarizes a record for the list view", () => {
    const rec = newTurnRecord("Do the thing", { conversationId: "c9", at: 100 });
    foldLogEvent(rec, { kind: "tool_call", stepIndex: 0, name: "click", args: {} });
    foldLogEvent(rec, { kind: "done", summary: "done" }, 300);
    expect(summarizeRecord(rec)).toMatchObject({
      task: "Do the thing",
      conversationId: "c9",
      status: "done",
      turns: 1,
      toolCalls: 1,
      durationMs: 200,
    });
  });
});

describe("run log export", () => {
  const build = () => {
    const rec = newTurnRecord("Search HN", { conversationId: "c1", mode: "standard", at: 0 });
    foldLogEvent(rec, { kind: "step_started", stepIndex: 0 }, 0);
    foldLogEvent(rec, { kind: "token_delta", text: "On it." }, 10);
    foldLogEvent(
      rec,
      { kind: "tool_call", stepIndex: 0, name: "navigate", args: { url: "https://x" } },
      20,
    );
    foldLogEvent(
      rec,
      { kind: "tool_result", stepIndex: 0, name: "navigate", result: "loaded", ok: true },
      40,
    );
    foldLogEvent(rec, { kind: "done", summary: "Summary here." }, 60);
    return rec;
  };

  it("writes one parseable JSON object per record", () => {
    const rec = build();
    const lines = toJsonl([rec]).trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.task).toBe("Search HN");
    expect(parsed.turns[0].tools[0].name).toBe("navigate");
  });

  it("renders a readable markdown transcript with turn timings", () => {
    const md = toMarkdown([build()]);
    expect(md).toContain("# Search HN");
    expect(md).toContain("**status:** done");
    expect(md).toMatch(/## Turn 1 — .+ \(60ms\)/);
    expect(md).toContain("**✓ navigate**");
    expect(md).toContain("On it.");
    expect(md).toContain("**Summary:** Summary here.");
  });

  it("produces empty output for no records", () => {
    expect(toJsonl([])).toBe("");
    expect(toMarkdown([])).toBe("");
  });
});