// The coach: a second agent on the same model that reviews a finished run.
// The LLM is stubbed — what matters here is the request we send, the tolerant
// reading of the answer, and that every failure path is fail-open.
import { describe, expect, it } from "vitest";
import {
  COACH_THINKING,
  buildCoachSystemPrompt,
  buildCoachUserMessage,
  learnFromRun,
  reviewRun,
} from "../extension/src/background/agent/coach";
import type {
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResult,
  ToolCall,
} from "../extension/src/shared/llm";
import { foldLogEvent, newTurnRecord, type LogTurnRecord } from "../extension/src/shared/logging";
import {
  LESSONS_TOOL_NAME,
  newLesson,
  type Lesson,
} from "../extension/src/shared/lessons";

function failedRun(task = "book a table", at = 1_000): LogTurnRecord {
  const rec = newTurnRecord(task, { at });
  foldLogEvent(rec, { kind: "tool_call", stepIndex: 0, name: "click", args: { ref: "12" } }, at + 1);
  foldLogEvent(
    rec,
    {
      kind: "tool_result",
      stepIndex: 0,
      name: "click",
      result: "ERROR: stale ref '12' — take a fresh snapshot",
      ok: false,
    },
    at + 2,
  );
  foldLogEvent(rec, { kind: "done", summary: "gave up" }, at + 3);
  return rec;
}

function storedLesson(text: string): Lesson {
  return newLesson(
    { category: "tool", text },
    { task: "earlier task", source: "auto", outcome: "done", at: 500 },
  );
}

/** An LlmClient that answers with a fixed result and records the request. */
function stubLlm(
  respond: LlmResult | (() => Promise<LlmResult>),
): { client: LlmClient; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(req: LlmRequest): Promise<LlmResult> {
      requests.push(req);
      return typeof respond === "function" ? respond() : respond;
    },
  };
  return { client, requests };
}

function toolCallResult(args: unknown): LlmResult {
  return {
    text: "",
    toolCalls: [{ id: "c1", name: LESSONS_TOOL_NAME, args: args as Record<string, unknown> }],
    stopReason: "tool_use",
    usage: { inputTokens: 900, outputTokens: 60 },
  };
}

describe("coach prompt", () => {
  it("names the tool and forbids invented lessons", () => {
    const system = buildCoachSystemPrompt();
    expect(system).toContain("Run Coach");
    expect(system).toContain(LESSONS_TOOL_NAME);
    expect(system).toContain("never invent");
    expect(system).toContain("empty lesson list");
  });

  it("gives the coach the digest plus the lessons already on file", () => {
    const msg = buildCoachUserMessage(failedRun("order a pizza"), [
      storedLesson("Existing lesson about refs"),
    ]);
    expect(msg).toContain("Task: order a pizza");
    expect(msg).toContain("stale ref");
    expect(msg).toContain("do not repeat these");
    expect(msg).toContain("Existing lesson about refs");
    expect(msg).toContain(LESSONS_TOOL_NAME);
  });

  it("omits the existing-lessons section when nothing is on file", () => {
    const msg = buildCoachUserMessage(failedRun(), []);
    expect(msg).not.toContain("do not repeat these");
  });
});

describe("reviewRun", () => {
  it("sends one tool-bearing turn on the same model with a bounded digest", async () => {
    const { client, requests } = stubLlm(
      toolCallResult({ lessons: [{ category: "tool", text: "Snapshot before retrying a stale ref." }] }),
    );
    const review = await reviewRun({ llm: client, record: failedRun(), existing: [] });
    expect(review.drafts).toHaveLength(1);
    expect(review.usage).toEqual({ inputTokens: 900, outputTokens: 60 });

    const req = requests[0]!;
    expect(req.tools.map((t) => t.name)).toEqual([LESSONS_TOOL_NAME]);
    expect(req.thinking).toBe(COACH_THINKING);
    expect(req.system).toContain("Run Coach");
    expect(req.maxTokens).toBeGreaterThan(0);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("user");
    expect(req.messages[0]!.content).toContain("Task: book a table");
  });

  it("accepts a JSON answer in the reply text", async () => {
    const { client } = stubLlm({
      text: '```json\n{"lessons":[{"category":"site","text":"This site hides search behind a login."}]}\n```',
      toolCalls: [],
      stopReason: "stop",
    });
    const review = await reviewRun({ llm: client, record: failedRun(), existing: [] });
    expect(review.drafts).toEqual([
      { category: "site", text: "This site hides search behind a login." },
    ]);
  });

  it("returns no drafts (with a note) when the answer is unreadable", async () => {
    const { client } = stubLlm({ text: "All good, nothing to report.", toolCalls: [], stopReason: "stop" });
    const review = await reviewRun({ llm: client, record: failedRun(), existing: [] });
    expect(review.drafts).toEqual([]);
    expect(review.errors.length).toBeGreaterThan(0);
  });

  it("notes a tool call whose arguments were invalid JSON", async () => {
    const broken: ToolCall = {
      id: "c1",
      name: LESSONS_TOOL_NAME,
      args: {},
      invalidJson: "{ nope",
    };
    const { client } = stubLlm({ text: "", toolCalls: [broken], stopReason: "tool_use" });
    const review = await reviewRun({ llm: client, record: failedRun(), existing: [] });
    expect(review.drafts).toEqual([]);
    expect(review.errors.join(" ")).toContain("invalid JSON");
  });

  it("propagates a failed LLM call so the caller can report it", async () => {
    const { client } = stubLlm(async () => {
      throw new Error("LLM API error 429: rate limited");
    });
    await expect(reviewRun({ llm: client, record: failedRun(), existing: [] })).rejects.toThrow(
      /rate limited/,
    );
  });
});

describe("learnFromRun", () => {
  it("stores what the coach learned and reports the counts", async () => {
    const { client } = stubLlm(
      toolCallResult({
        lessons: [
          { category: "tool", text: "After a stale-ref error, snapshot again before retrying." },
          { category: "workflow", text: "Verify the form state before submitting twice." },
        ],
      }),
    );
    const saved: Lesson[][] = [];
    const outcome = await learnFromRun({
      llm: client,
      record: failedRun(),
      existing: [],
      source: "auto",
      save: async (lessons) => {
        saved.push(lessons);
      },
    });
    expect(outcome.status).toBe("added");
    expect(outcome).toMatchObject({ added: 2, merged: 0, total: 2 });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.map((l) => l.text)).toEqual([
      "After a stale-ref error, snapshot again before retrying.",
      "Verify the form state before submitting twice.",
    ]);
    // Run metadata rides along for the drawer.
    expect(saved[0]![0]).toMatchObject({ source: "auto", outcome: "done", task: "book a table" });
  });

  it("records the effective outcome of a stopped run", async () => {
    const rec = failedRun();
    rec.turns[rec.turns.length - 1]!.summary = "stopped at step 2";
    const { client } = stubLlm(toolCallResult({ lessons: [{ text: "Keep going past step 2." }] }));
    const saved: Lesson[][] = [];
    await learnFromRun({
      llm: client,
      record: rec,
      existing: [],
      source: "manual",
      save: async (lessons) => {
        saved.push(lessons);
      },
    });
    expect(saved[0]![0]).toMatchObject({ source: "manual", outcome: "stopped" });
  });

  it("merges into existing lessons instead of overwriting them", async () => {
    const existing = [storedLesson("After a stale-ref error, snapshot again before retrying.")];
    const { client } = stubLlm(
      toolCallResult({ lessons: [{ text: "after a stale-ref error, snapshot again before retrying" }] }),
    );
    const saved: Lesson[][] = [];
    const outcome = await learnFromRun({
      llm: client,
      record: failedRun(),
      existing,
      source: "auto",
      save: async (lessons) => {
        saved.push(lessons);
      },
    });
    expect(outcome).toMatchObject({ status: "added", added: 0, merged: 1, total: 1 });
    expect(saved[0]![0]!.hits).toBe(2);
  });

  it("does not touch storage when the coach learned nothing", async () => {
    const { client } = stubLlm(toolCallResult({ lessons: [] }));
    let saves = 0;
    const outcome = await learnFromRun({
      llm: client,
      record: failedRun(),
      existing: [storedLesson("something already known")],
      source: "manual",
      save: async () => {
        saves += 1;
      },
    });
    expect(outcome.status).toBe("empty");
    expect(saves).toBe(0);
    expect(outcome.total).toBe(1);
  });

  it("fails open: an LLM error is reported, never thrown, and never saves", async () => {
    const { client } = stubLlm(async () => {
      throw new Error("network down");
    });
    let saves = 0;
    const outcome = await learnFromRun({
      llm: client,
      record: failedRun(),
      existing: [],
      source: "auto",
      save: async () => {
        saves += 1;
      },
    });
    expect(outcome.status).toBe("error");
    expect(outcome.message).toContain("network down");
    expect(saves).toBe(0);
  });
});