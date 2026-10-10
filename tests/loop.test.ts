import { describe, expect, it } from "vitest";
import {
  boundCheckpoint,
  capCheckpointImages,
  createStuckGuard,
  estimateMessages,
  isRoutineStep,
  malformedHint,
  precheckCall,
  shouldStallNudge,
  TODO_STALE_STEPS,
  JEV_PROGRESS_CONFIDENCE,
  OFF_REASONING_CAP_CHARS,
  reasoningCapChars,
  runAgentTask,
  truncateHistory,
  type ExecuteBatch,
  type ExecuteResult,
  type LoopDeps,
} from "../extension/src/background/agent/loop";
import type {
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResult,
} from "../extension/src/shared/llm";
import type { Checkpoint, StepEvent } from "../extension/src/shared/protocol";
import type { Tool } from "../extension/src/background/tools/types";
import { validateToolArgs } from "../extension/src/background/tools/types";

class FakeLlm implements LlmClient {
  calls = 0;
  /** Requests as received, so tests can assert thinking flags reach the LLM. */
  seen: LlmRequest[] = [];
  constructor(private script: LlmResult[]) {}
  async complete(
    req: LlmRequest,
    onText?: (t: string) => void,
    _signal?: AbortSignal,
    onReasoning?: (t: string) => void,
  ): Promise<LlmResult> {
    this.seen.push(req);
    onReasoning?.("…");
    onText?.("…");
    return this.script[this.calls++] ?? { text: "done", toolCalls: [], stopReason: "end" };
  }
}

function toolCall(name: string, args: Record<string, unknown>, id = "c1"): LlmResult {
  return {
    text: "thinking",
    toolCalls: [{ id, name, args }],
    stopReason: "tool_use",
  };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    task: "task",
    mode: "standard",
    stepIndex: 0,
    messages: [{ role: "user", content: "task" }],
    toolSpecs: [
      {
        name: "navigate",
        description: "",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
      {
        name: "click",
        description: "",
        parameters: {
          type: "object",
          properties: { ref: { type: "string" } },
          required: ["ref"],
        },
      },
      { name: "snapshot", description: "", parameters: { type: "object", properties: {} } },
      { name: "screenshot", description: "", parameters: { type: "object", properties: {} } },
    ],
    startedAt: 1,
    updatedAt: 1,
    done: false,
    ...overrides,
  };
}

function harness(script: LlmResult[], overrides: Partial<LoopDeps> = {}) {
  const events: StepEvent[] = [];
  const saves: number[] = [];
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const batches: (ExecuteBatch | undefined)[] = [];
  const deps: LoopDeps = {
    llm: new FakeLlm(script),
    emit: (e) => events.push(e),
    save: async (cp) => void saves.push(cp.stepIndex),
    shouldStop: () => false,
    execute: async (name, args, batch) => {
      executed.push({ name, args });
      batches.push(batch);
      return { ok: true, payload: { fine: true } };
    },
    stepCap: 5,
    ...overrides,
  };
  return { events, saves, executed, batches, deps };
}

describe("runAgentTask", () => {
  it("runs tools then completes on a plain-text answer", async () => {
    const cp = makeCheckpoint();
    const { events, executed, deps } = harness([
      toolCall("navigate", { url: "http://x" }),
      { text: "All done!", toolCalls: [], stopReason: "end_turn" },
    ]);
    const outcome = await runAgentTask(cp, deps);

    expect(outcome).toBe("completed");
    expect(executed).toEqual([{ name: "navigate", args: { url: "http://x" } }]);
    expect(cp.done).toBe(true);
    expect(cp.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({ kind: "done", summary: "All done!" });
  });

  it("does not end the run on an empty reply — it re-prompts the model", async () => {
    // Some models close a step with a reasoning-only or completely empty
    // reply. The loop used to read "no tool calls" as "final answer" and end
    // the run as `task finished (no summary)` while the model was still
    // mid-plan — the mid-run stop. An empty reply is a hiccup: store nothing
    // for it (a contentless assistant turn is wire-invalid on OpenAI-style
    // providers and 400s every later request on the thread), nudge the model,
    // and keep going.
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      toolCall("navigate", { url: "http://x" }),
      { text: "", toolCalls: [], stopReason: "end_turn", reasoning: "thoughts only" },
      { text: "All done!", toolCalls: [], stopReason: "end_turn" },
    ]);
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    // user → assistant(tool_calls) → tool result → user(nudge) → assistant.
    expect(cp.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
    expect(cp.messages[3]!.content).toContain("EMPTY");
    // The run closes on the real answer, not on the dead reply.
    expect(events.at(-1)).toMatchObject({ kind: "done", summary: "All done!" });
  });

  it("recovers a reply cut off at the output limit by raising the output cap", async () => {
    // Reasoning that runs into max_tokens streams back nothing but thinking.
    // The next attempt needs a bigger output budget, not the same wall again.
    const cp = makeCheckpoint();
    const llm = new FakeLlm([
      { text: "", toolCalls: [], stopReason: "length", reasoning: "cut off mid-thought" },
      { text: "Done.", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { events, deps } = harness([], { llm, maxTokens: 8_192 });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    expect(llm.seen[0]!.maxTokens).toBe(8_192);
    expect(llm.seen[1]!.maxTokens).toBeGreaterThan(8_192);
    expect(
      events.some((e) => e.kind === "info" && e.message.includes("output token limit")),
    ).toBe(true);
  });

  it("falls back to the configured output cap when the raised one is rejected", async () => {
    // Providers cap output per model (Anthropic 400s on max_tokens above it).
    // A rejected recovery must not kill the run — retry at the configured cap.
    const cp = makeCheckpoint();
    let calls = 0;
    const llm: LlmClient = {
      async complete(req) {
        calls++;
        if (calls === 1) {
          return { text: "", toolCalls: [], stopReason: "length" };
        }
        if ((req.maxTokens ?? 0) > 8_192) {
          throw new Error("LLM API error 400: max_tokens: 16384 > 8192");
        }
        return { text: "Done.", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const { deps } = harness([], { llm, maxTokens: 8_192 });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    // The raised-cap request is retried (and rejected) before the fallback.
    expect(calls).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it("stops honestly after repeated empty replies instead of looping", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      { text: "", toolCalls: [], stopReason: "end_turn" },
      { text: "", toolCalls: [], stopReason: "end_turn" },
      { text: "", toolCalls: [], stopReason: "end_turn" },
      { text: "", toolCalls: [], stopReason: "end_turn" },
    ]);
    const outcome = await runAgentTask(cp, deps);
    // "stopped", never "completed" — the task was NOT finished.
    expect(outcome).toBe("stopped");
    expect(
      events.some((e) => e.kind === "error" && e.message.includes("no answer")),
    ).toBe(true);
    // The empty turns themselves leave no assistant message behind.
    expect(
      cp.messages.every((m) => m.role !== "assistant" || m.content || m.toolCalls?.length),
    ).toBe(true);
  });

  it("keeps an empty-text assistant turn that carries tool calls", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness([
      { text: "", toolCalls: [{ id: "c1", name: "click", args: { ref: "1" } }], stopReason: "tool_use" },
      { text: "Done.", toolCalls: [], stopReason: "end_turn" },
    ]);
    await runAgentTask(cp, deps);
    const callTurn = cp.messages[1]!;
    // The tool-call turn must survive (the tool result pairs with it) even
    // with no prose; the wire mapper sends content null + tool_calls.
    expect(callTurn.role).toBe("assistant");
    expect(callTurn.content).toBe("");
    expect(callTurn.toolCalls).toHaveLength(1);
  });

  it("reports final run stats on the done event", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      { text: "Done.", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 700, outputTokens: 50 } },
    ]);
    await runAgentTask(cp, deps);
    const done = events.at(-1);
    expect(done?.kind).toBe("done");
    const stats = (done as Extract<StepEvent, { kind: "done" }>).stats;
    expect(stats).toBeDefined();
    expect(stats!.inputTokens).toBe(700);
    expect(stats!.outputTokens).toBe(50);
    expect(stats!.totalTokens).toBe(750);
    expect(stats!.steps).toBe(1);
    expect(stats!.contextWindow).toBe(128_000);
  });

  it("streams reasoning deltas as their own event kind", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      { text: "Done.", toolCalls: [], stopReason: "end_turn" },
    ]);
    await runAgentTask(cp, deps);
    expect(events.some((e) => e.kind === "reasoning_delta")).toBe(true);
  });

  it("emits one turn_timing event per step with the TTFT/decode split", async () => {
    const cp = makeCheckpoint();
    const step = (id: string) => ({
      text: "",
      toolCalls: [{ id, name: "snapshot", args: {} }],
      stopReason: "tool_use" as const,
    });
    const { events, deps } = harness([step("a"), { text: "done", toolCalls: [], stopReason: "end_turn" }]);
    await runAgentTask(cp, deps);
    const timings = events.filter((e) => e.kind === "turn_timing");
    expect(timings).toHaveLength(2);
    // The fake client streams a token before returning, so both halves exist.
    for (const t of timings) {
      const e = t as Extract<StepEvent, { kind: "turn_timing" }>;
      expect(e.ttftMs).toBeGreaterThanOrEqual(0);
      expect(e.decodeMs).toBeGreaterThanOrEqual(0);
      expect(e.stepIndex).toBeLessThan(2);
    }
  });

  it("notes a silent endpoint exactly once, not once per step", async () => {
    const cp = makeCheckpoint();
    const step = (id: string) => ({
      text: "",
      toolCalls: [{ id, name: "snapshot", args: {} }],
      stopReason: "tool_use" as const,
    });
    const { events, deps } = harness([
      step("a"),
      step("b"),
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    await runAgentTask(cp, deps);
    const notes = events.filter(
      (e) => e.kind === "info" && e.message.includes("returned no usage"),
    );
    expect(notes).toHaveLength(1);
  });

  // The cache figure is rendered as a share of inputTokens, so a step that
  // reported no cache number would silently deflate it. Same rule as
  // usageEstimated: an untrustworthy number is not shown at all.
  describe("prompt-cache stats", () => {
    const step = (id: string) => ({
      text: "",
      toolCalls: [{ id, name: "snapshot", args: {} }],
      stopReason: "tool_use" as const,
    });
    const doneStats = (events: StepEvent[]) =>
      (events.at(-1) as Extract<StepEvent, { kind: "done" }>).stats!;

    it("totals cached input when every step reports one", async () => {
      const cp = makeCheckpoint();
      const { events, deps } = harness([
        { ...step("a"), usage: { inputTokens: 1_000, outputTokens: 10, cachedInputTokens: 900 } },
        { ...step("b"), usage: { inputTokens: 1_200, outputTokens: 10, cachedInputTokens: 1_100 } },
        {
          text: "done",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 1_500, outputTokens: 20, cachedInputTokens: 1_400 },
        },
      ]);
      await runAgentTask(cp, deps);
      expect(doneStats(events).cachedInputTokens).toBe(3_400);
      // The fixed prefix is reported too: it is the floor cost per step.
      expect(doneStats(events).prefixTokens).toBeGreaterThan(0);
    });

    it("omits the cache total when a step stayed silent about it", async () => {
      const cp = makeCheckpoint();
      const { events, deps } = harness([
        { ...step("a"), usage: { inputTokens: 1_000, outputTokens: 10, cachedInputTokens: 900 } },
        { ...step("b"), usage: { inputTokens: 1_200, outputTokens: 10 } },
        {
          text: "done",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 1_500, outputTokens: 20 },
        },
      ]);
      await runAgentTask(cp, deps);
      expect(doneStats(events).cachedInputTokens).toBeUndefined();
    });

    it("omits the cache total when usage was estimated", async () => {
      const cp = makeCheckpoint();
      const { events, deps } = harness([
        { text: "done", toolCalls: [], stopReason: "end_turn" },
      ]);
      await runAgentTask(cp, deps);
      expect(doneStats(events).usageEstimated).toBe(true);
      expect(doneStats(events).cachedInputTokens).toBeUndefined();
    });
  });

  it("counts reasoning characters into the stats", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      { text: "Done.", toolCalls: [], stopReason: "end_turn", reasoning: "abcdef" },
    ]);
    await runAgentTask(cp, deps);
    const stats = (events.at(-1) as Extract<StepEvent, { kind: "done" }>).stats;
    expect(stats!.reasoningChars).toBe(6);
  });

  it("forwards the thinking level to the LLM request", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness([{ text: "Done.", toolCalls: [], stopReason: "end_turn" }], {
      thinking: "high",
    });
    await runAgentTask(cp, deps);
    expect((deps.llm as FakeLlm).seen[0]).toMatchObject({ thinking: "high" });
  });

  it("retries a transient LLM failure and completes", async () => {
    const cp = makeCheckpoint();
    let attempts = 0;
    const flaky: LlmClient = {
      async complete() {
        attempts++;
        if (attempts === 1) throw new Error("HTTP 500: boom");
        return { text: "recovered", toolCalls: [], stopReason: "end_turn" };
      },
    };
    const { events, deps } = harness([], { llm: flaky });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    expect(attempts).toBe(2);
    expect(
      events.some((e) => e.kind === "info" && e.message.includes("retrying")),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "done", summary: "recovered" });
  }, 15_000);

  it("gives up after repeated LLM failures", async () => {
    const cp = makeCheckpoint();
    let attempts = 0;
    const dead: LlmClient = {
      async complete() {
        attempts++;
        throw new Error("HTTP 503: down");
      },
    };
    const { events, deps } = harness([], { llm: dead });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("stopped");
    expect(attempts).toBe(3);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  }, 15_000);

  it("aborts a silent attempt via the TTFT stall guard and retries", async () => {
    const cp = makeCheckpoint();
    let attempts = 0;
    const stalling: LlmClient = {
      complete(_req, onText, signal) {
        attempts++;
        if (attempts === 1) {
          // A connection that stays alive but never streams a token — the
          // exact shape of the 108s stall in the archived run. Must honor the
          // abort signal the way a real fetch-backed stream would.
          return new Promise((_resolve, reject) => {
            const t = setTimeout(() => {
              onText?.("late");
              _resolve({ text: "late", toolCalls: [], stopReason: "end_turn" });
            }, 5_000);
            signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error("The user aborted a request."));
            }, { once: true });
          });
        }
        onText?.("fast");
        return Promise.resolve({ text: "recovered", toolCalls: [], stopReason: "end_turn" });
      },
    };
    const { events, deps } = harness([], { llm: stalling, ttftStallMs: 60 });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    expect(attempts).toBe(2);
    expect(
      events.some((e) => e.kind === "info" && e.message.includes("stalled — no first token")),
    ).toBe(true);
  }, 15_000);

  it("runs read-only batches concurrently but records results in call order", async () => {
    const cp = makeCheckpoint();
    const finished: string[] = [];
    const { deps } = harness(
      [
        {
          text: "",
          toolCalls: [
            { id: "slow", name: "snapshot", args: { tag: "slow" } },
            { id: "fast", name: "screenshot", args: { tag: "fast" } },
          ],
          stopReason: "tool_use",
        },
        { text: "done", toolCalls: [], stopReason: "end_turn" },
      ],
      {
        execute: async (name, args) => {
          // The first call takes longer — concurrency means the second
          // finishes first, yet messages must stay in call order.
          await new Promise((r) =>
            setTimeout(r, args.tag === "slow" ? 60 : 5),
          );
          finished.push(String(args.tag));
          return { ok: true, payload: { name } };
        },
      },
    );
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    expect(finished).toEqual(["fast", "slow"]); // actually ran in parallel
    const toolMsgs = cp.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["slow", "fast"]);
  });

  it("keeps mutating batches sequential", async () => {
    const cp = makeCheckpoint();
    const order: string[] = [];
    const { deps } = harness(
      [
        {
          text: "",
          toolCalls: [
            { id: "a", name: "click", args: { ref: "1" } },
            { id: "b", name: "click", args: { ref: "2" } },
          ],
          stopReason: "tool_use",
        },
        { text: "done", toolCalls: [], stopReason: "end_turn" },
      ],
      {
        execute: async (name, args) => {
          await new Promise((r) => setTimeout(r, args.ref === "1" ? 30 : 1));
          order.push(String(args.ref));
          return { ok: true, payload: { name } };
        },
      },
    );
    await runAgentTask(cp, deps);
    expect(order).toEqual(["1", "2"]); // call order, not completion order
  });

  // The executor defers its settle+snapshot to the LAST call of a step, so the
  // loop must tell it where each call sits. Getting this wrong either observes
  // after every action (the duplicated work this exists to remove) or never
  // observes at all (a blind model).
  it("tells the executor where each call sits in the step's batch", async () => {
    const cp = makeCheckpoint();
    const { batches, deps } = harness([
      {
        text: "",
        toolCalls: [
          { id: "a", name: "click", args: { ref: "1" } },
          { id: "b", name: "click", args: { ref: "2" } },
          { id: "c", name: "click", args: { ref: "3" } },
        ],
        stopReason: "tool_use",
      },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    await runAgentTask(cp, deps);
    expect(batches).toEqual([
      { index: 0, count: 3 },
      { index: 1, count: 3 },
      { index: 2, count: 3 },
    ]);
  });

  it("marks a lone call as the last of its batch", async () => {
    const cp = makeCheckpoint();
    const { batches, deps } = harness([
      { text: "", toolCalls: [{ id: "a", name: "click", args: { ref: "1" } }], stopReason: "tool_use" },
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    await runAgentTask(cp, deps);
    expect(batches).toEqual([{ index: 0, count: 1 }]);
  });

  it("drops an invalid call from history, hints in-band, then recovers", async () => {
    const cp = makeCheckpoint();
    const { events, executed, deps } = harness([
      toolCall("click", {}, "bad"), // missing required ref
      toolCall("click", { ref: "2" }, "good"),
      { text: "done", toolCalls: [], stopReason: "end" },
    ]);
    const outcome = await runAgentTask(cp, deps);

    expect(outcome).toBe("completed");
    expect(executed).toEqual([{ name: "click", args: { ref: "2" } }]);
    // The malformed call never became part of the model's own history…
    const committedIds = cp.messages.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []);
    expect(committedIds).toEqual(["good"]);
    expect(cp.messages.some((m) => m.role === "tool" && m.toolCallId === "bad")).toBe(false);
    // …the model is told what arrived and what was missing instead.
    const hint = cp.messages.find((m) => m.role === "user" && m.content.startsWith("[harness]"));
    expect(hint?.content).toContain("click arrived as {}");
    expect(hint?.content).toContain("missing required parameter: ref");
    expect(hint?.content).toContain("NOT kept in history");
    // …and the log records it raw, per turn.
    const timing = events.find((e) => e.kind === "turn_timing") as Extract<
      StepEvent,
      { kind: "turn_timing" }
    >;
    expect(timing.malformed).toEqual([
      { name: "click", reason: "missing required parameter: ref", raw: "{}" },
    ]);
  });

  it("prefers the provider's raw argument string in the malformed record", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      { ...toolCall("click", {}, "bad"), rawArgs: { bad: '{"space":"screenshot"' } },
      { text: "done", toolCalls: [], stopReason: "end" },
    ]);
    await runAgentTask(cp, deps);
    const timing = events.find((e) => e.kind === "turn_timing") as Extract<
      StepEvent,
      { kind: "turn_timing" }
    >;
    expect(timing.malformed?.[0]?.raw).toBe('{"space":"screenshot"');
  });

  it("drops coordinate calls with no target and never feeds the identical-call ban", async () => {
    const cp = makeCheckpoint({
      toolSpecs: [
        {
          name: "click_at",
          description: "",
          parameters: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" }, space: { type: "string" } },
          },
        },
      ],
    });
    const noPoint = { space: "screenshot", expect: "menu opens" };
    const { executed, deps } = harness(
      [
        toolCall("click_at", noPoint, "a"),
        toolCall("click_at", noPoint, "b"),
        toolCall("click_at", noPoint, "c"),
        toolCall("click_at", { x: 5, y: 6, space: "screenshot" }, "d"),
        { text: "done", toolCalls: [], stopReason: "end" },
      ],
      { stepCap: 10 },
    );
    await runAgentTask(cp, deps);
    expect(executed).toEqual([{ name: "click_at", args: { x: 5, y: 6, space: "screenshot" } }]);
    const hints = cp.messages.filter((m) => m.role === "user" && m.content.includes("arrived as"));
    expect(hints).toHaveLength(3);
    expect(hints[0]!.content).toContain("click_at arrived as {space, expect} — x and y (or ref) missing");
    expect(cp.messages.some((m) => m.content.includes("BLOCKED"))).toBe(false);
  });

  it("does not treat an all-malformed turn as a final answer", async () => {
    const cp = makeCheckpoint();
    const { executed, events, deps } = harness([
      { text: "I'll click it.", toolCalls: [{ id: "x", name: "click", args: {} }], stopReason: "tool_use" },
      toolCall("click", { ref: "1" }, "y"),
      { text: "done", toolCalls: [], stopReason: "end" },
    ]);
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    expect(executed).toHaveLength(1);
    expect(events.filter((e) => e.kind === "done")).toHaveLength(1);
    // The text survives as a plain assistant turn, without the dropped call.
    const first = cp.messages.find((m) => m.role === "assistant");
    expect(first).toMatchObject({ content: "I'll click it." });
    expect(first?.toolCalls).toBeUndefined();
  });

  it("goes non-streamed with thinking off after two malformed turns", async () => {
    const cp = makeCheckpoint();
    const llm = new FakeLlm([
      toolCall("click", {}, "a"),
      toolCall("click", {}, "b"),
      toolCall("click", { ref: "1" }, "c"),
      { text: "done", toolCalls: [], stopReason: "end" },
    ]);
    const { events, deps } = harness([], { llm, thinking: "medium", stepCap: 10 });
    await runAgentTask(cp, deps);
    expect(llm.seen.map((r) => r.stream)).toEqual([undefined, undefined, false, false]);
    expect(llm.seen[2]!.thinking).toBe("off");
    expect(
      events.some((e) => e.kind === "info" && e.message.includes("non-streamed")),
    ).toBe(true);
  });

  it("nudges at 3 idle steps and every 5 after, never ending the run", async () => {
    const cp = makeCheckpoint();
    const script: LlmResult[] = [];
    for (let i = 0; i < 9; i++) script.push(toolCall("click", {}, `bad${i}`));
    script.push(toolCall("click", { ref: "1" }, "good"));
    for (let i = 0; i < 3; i++) script.push(toolCall("click", {}, `late${i}`));
    script.push({ text: "done", toolCalls: [], stopReason: "end" });
    const { deps } = harness(script, { stepCap: 30 });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    const nudges = cp.messages.filter(
      (m) => m.role === "user" && m.content.includes("in a row have executed nothing"),
    );
    // Streak 3 and 8, then reset by the executed call, then 3 again.
    expect(nudges.map((m) => m.content.match(/^\[harness\] (\d+) steps/)?.[1])).toEqual([
      "3",
      "8",
      "3",
    ]);
    expect(nudges[0]!.content).toContain("todo_write");
  });

  it("keeps running through consecutive invalid calls — no abort", async () => {
    const cp = makeCheckpoint();
    const { events, executed, deps } = harness([
      toolCall("click", {}, "bad1"), // missing required ref
      toolCall("click", {}, "bad2"),
      toolCall("click", {}, "bad3"),
      toolCall("click", { ref: "2" }, "good"),
      { text: "done", toolCalls: [], stopReason: "end" },
    ]);
    const outcome = await runAgentTask(cp, deps);

    expect(outcome).toBe("completed");
    expect(executed).toEqual([{ name: "click", args: { ref: "2" } }]);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  it("stops at the step cap", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness(
      [
        toolCall("snapshot", {}, "1"),
        toolCall("snapshot", {}, "2"),
        toolCall("snapshot", {}, "3"),
      ],
      { stepCap: 2 },
    );
    const outcome = await runAgentTask(cp, deps);

    expect(outcome).toBe("capped");
  });

  it("runs uncapped when no stepCap is given (the default)", async () => {
    const cp = makeCheckpoint();
    // 30 tool-calling steps, far past the old presets (15/40/80 era caps were
    // enforced here) — the loop should keep going until the model answers.
    const script: LlmResult[] = Array.from({ length: 30 }, (_, i) =>
      toolCall("snapshot", {}, `c${i}`),
    );
    const { deps } = harness([
      ...script,
      { text: "Finished after many steps.", toolCalls: [], stopReason: "end_turn" },
    ]);
    // harness() sets stepCap: 5 by default; drop it to exercise the uncapped path.
    delete (deps as { stepCap?: number }).stepCap;

    const outcome = await runAgentTask(cp, deps);

    expect(outcome).toBe("completed");
    expect((deps.llm as FakeLlm).calls).toBe(31);
  });

  it("still stops uncapped runs on request", async () => {
    const cp = makeCheckpoint();
    let checks = 0;
    const { deps } = harness(
      // Keep requesting tools so the loop would otherwise run forever.
      Array.from({ length: 50 }, (_, i) => toolCall("snapshot", {}, `s${i}`)),
      { shouldStop: () => ++checks > 5 },
    );
    delete (deps as { stepCap?: number }).stepCap;
    const outcome = await runAgentTask(cp, deps);
    // Unbounded step count, but cooperative stop still ends it.
    expect(outcome).toBe("stopped");
  });

  it("stops cooperatively between tool calls", async () => {
    const cp = makeCheckpoint();
    let stop = false;
    const { deps } = harness([toolCall("snapshot", {}, "1")], {
      shouldStop: () => stop,
      execute: async () => {
        stop = true;
        return { ok: true };
      },
    });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("stopped");
  });

  it("attaches screenshot images to tool messages — always, and on failures too", async () => {
    // The model takes image input: a dropped screenshot is a blind model (a
    // real run traced a PNG pixel-by-pixel for 10 minutes because of this).
    const big: ExecuteResult = { ok: true, payload: {}, text: "[shot]", image: "data:image/jpeg;base64,AAA" };
    const finisher: LlmResult = { text: "x", toolCalls: [], stopReason: "end" };
    const cp1 = makeCheckpoint();
    await runAgentTask(cp1, harness([toolCall("screenshot", {}, "s"), finisher], {
      execute: async () => big,
    }).deps);
    expect(cp1.messages.find((m) => m.role === "tool")?.images).toEqual([
      "data:image/jpeg;base64,AAA",
    ]);

    // A failed tool that still captured the page state passes the image along.
    const failed: ExecuteResult = {
      ok: false,
      error: "FRAME-FAILED: nope",
      image: "data:image/jpeg;base64,BBB",
    };
    const cp2 = makeCheckpoint();
    await runAgentTask(cp2, harness([toolCall("snapshot", {}, "s"), { ...finisher }], {
      execute: async () => failed,
    }).deps);
    const failMsg = cp2.messages.find((m) => m.role === "tool");
    expect(failMsg?.images).toEqual(["data:image/jpeg;base64,BBB"]);
    expect(failMsg?.content).toContain("FRAME-FAILED");
  });

  it("appends mid-run user input before the next model call", async () => {
    // Steer without stopping: queued input lands as a normal user turn.
    const queue = ["also check the sidebar", ""];
    const { deps } = harness(
      [toolCall("snapshot", {}, "1"), { text: "fin", toolCalls: [], stopReason: "end" }],
      { takeUserInput: () => queue.splice(0) },
    );
    const cp = makeCheckpoint();
    await runAgentTask(cp, deps);
    const userTexts = cp.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts).toContain("also check the sidebar");
    expect(userTexts).not.toContain(""); // blanks are ignored
  });

  it("saves a checkpoint after every tool step", async () => {
    const cp = makeCheckpoint();
    const { saves, deps } = harness([
      toolCall("snapshot", {}, "1"),
      toolCall("snapshot", {}, "2"),
      { text: "fin", toolCalls: [], stopReason: "end" },
    ]);
    await runAgentTask(cp, deps);
    expect(saves).toEqual([1, 2, 2]); // per-step saves + final
  });
});

describe("completion gate", () => {
  const end = { text: "all done", toolCalls: [], stopReason: "end_turn" as const };
  const openPlan = [
    { content: "Set page to Letter", status: "pending" as const },
    { content: "Insert the table", status: "in_progress" as const },
  ];

  it("asks for a plan update after TODO_STALE_STEPS steps without todo_write", async () => {
    const steps = Array.from({ length: TODO_STALE_STEPS + 2 }, (_, i) =>
      toolCall("snapshot", { n: i }, `s${i}`),
    );
    const cp = makeCheckpoint({ todos: openPlan });
    const { events, deps } = harness(steps, { stepCap: TODO_STALE_STEPS + 2 });
    await runAgentTask(cp, deps);
    const nudges = cp.messages.filter(
      (m) => m.role === "user" && String(m.content).includes("since the plan was last updated"),
    );
    expect(nudges).toHaveLength(1);
    expect(String(nudges[0]!.content)).toContain("Insert the table");
    expect(events.some((e) => e.kind === "info" && e.message.includes("without a plan update"))).toBe(true);
  });

  it("never asks for a plan update when the plan is ticked or empty", async () => {
    const ticking = Array.from({ length: TODO_STALE_STEPS + 2 }, (_, i) =>
      toolCall(i % 10 === 0 ? "todo_write" : "snapshot", { n: i }, `t${i}`),
    );
    for (const [cp, script] of [
      [makeCheckpoint({ todos: openPlan }), ticking],
      [makeCheckpoint(), ticking.map((_, i) => toolCall("snapshot", { n: i }, `u${i}`))],
    ] as const) {
      const { deps } = harness([...script], { stepCap: TODO_STALE_STEPS + 2 });
      await runAgentTask(cp, deps);
      expect(
        cp.messages.some((m) => String(m.content).includes("since the plan was last updated")),
      ).toBe(false);
    }
  });

  it("bounces a final answer while the plan still owes work", async () => {
    const cp = makeCheckpoint({ todos: openPlan });
    const { events, deps } = harness([end, end], { stepCap: 6 });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    const llm = deps.llm as FakeLlm;
    // Two scripted "final" answers are both bounced (the budget is 2); the
    // third call is the harness's default reply, which is allowed through.
    expect(llm.seen).toHaveLength(3);
    // The nudge is in-band (it survives checkpointing) and names the items.
    const nudged = llm.seen[1]!.messages.at(-1)!;
    expect(nudged.content).toContain("Not finished");
    expect(nudged.content).toContain("Set page to Letter");
    expect(nudged.content).toContain("blocked");
    expect(
      events.some(
        (e) => e.kind === "info" && e.message.includes("2 open plan item(s)"),
      ),
    ).toBe(true);
  });

  it("gives up after the nudge budget and says the summary is unfinished", async () => {
    const cp = makeCheckpoint({ todos: openPlan });
    const { events, deps } = harness([end, end, end, end], { stepCap: 8 });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    expect((deps.llm as FakeLlm).seen).toHaveLength(3);
    expect(
      events.some(
        (e) => e.kind === "info" && e.message.includes("still open after 2 completion nudges"),
      ),
    ).toBe(true);
  });

  it("accepts a plan whose remaining items are explicitly blocked", async () => {
    const cp = makeCheckpoint({
      todos: [
        { content: "Insert the image (upload blocked by host)", status: "blocked" },
        { content: "Set page to Letter", status: "completed" },
      ],
    });
    const { events, deps } = harness([end], { stepCap: 4 });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    expect((deps.llm as FakeLlm).seen).toHaveLength(1);
    expect(
      events.some((e) => e.kind === "info" && e.message.includes("open plan item")),
    ).toBe(false);
  });

  it("does not gate a run with no plan at all", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness([end], { stepCap: 4 });
    await runAgentTask(cp, deps);
    expect((deps.llm as FakeLlm).seen).toHaveLength(1);
  });
});

describe("validateToolArgs", () => {
  const tool: Tool = {
    name: "type",
    description: "",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" }, n: { type: "number" } },
      required: ["ref"],
    },
    run: async () => null,
  };

  it("accepts valid args", () => {
    expect(validateToolArgs(tool, { ref: "1", n: 2 })).toEqual({});
  });
  it("rejects missing required", () => {
    expect(validateToolArgs(tool, {}).error).toContain("missing required");
  });
  it("rejects wrong types", () => {
    expect(validateToolArgs(tool, { ref: 5 }).error).toContain("must be a string");
  });
  it("rejects invalid JSON markers", () => {
    expect(validateToolArgs(tool, { __invalidJson: "oops" } as never).error).toContain(
      "not valid JSON",
    );
  });
});

describe("truncateHistory", () => {
  it("collapses old tool results and drops old images over budget", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "task" },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: "tool" as const,
        toolCallId: `t${i}`,
        content: `x${i}${"y".repeat(5_000)}`,
        images: [`data:image/jpeg;base64,IMG${i}`],
      })),
    ];
    const out = truncateHistory(messages, 20_000);
    expect(out[1]?.content).toBe("[older tool result omitted]");
    expect(out[1]?.images).toBeUndefined();
    // only the newest images survive
    const withImages = out.filter((m) => m.images?.length);
    expect(withImages.length).toBeLessThanOrEqual(4);
  });

  it("elides old tool-call arguments — they are context too", () => {
    const fat = { expression: "x".repeat(4_000) };
    const messages: LlmMessage[] = [
      { role: "user", content: "task" },
      ...Array.from({ length: 8 }, (_, i) => ({
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: `c${i}`, name: "evaluate_js", args: { ...fat } }],
      })),
      { role: "assistant", content: "done" },
    ];
    const out = truncateHistory(messages, 20_000);
    const first = out[1]?.toolCalls?.[0];
    // the args of an old call are dead weight; the id must survive (it pairs
    // with the tool result) and the checkpoint itself must not be mutated
    expect(first?.args).toEqual({
      _elided: "this older call's arguments were trimmed from history",
    });
    expect(first?.id).toBe("c0");
    expect(messages[1]?.toolCalls?.[0]?.args).toEqual(fat);
  });

  it("honors a token budget on top of the char budget", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "task" },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: "tool" as const,
        toolCallId: `t${i}`,
        content: `x${i}${"y".repeat(4_000)}`,
      })),
    ];
    // Room for roughly one of these messages: everything older collapses.
    const out = truncateHistory(messages, 1_000_000, 4_500);
    const omitted = out.filter((m) => m.content === "[older tool result omitted]");
    expect(omitted.length).toBeGreaterThan(0);
    expect(out.at(-1)?.content).not.toBe("[older tool result omitted]");
  });

  // The property the whole compaction policy exists to protect: a provider
  // prefix cache matches on the longest byte-identical prefix of the previous
  // request, so what matters is where the FIRST difference sits. The old sweep
  // collapsed the single oldest message each time the budget was crossed, which
  // advanced the rewrite point by a message on nearly every step — the first
  // difference stayed early and the bulk of the conversation re-prefilled every
  // step no matter how little was new.
  describe("prefix stability (prompt-cache property)", () => {
    const ser = (m: LlmMessage) => JSON.stringify(m);

    /**
     * Simulate a run: one tool call plus an observation per step, exactly the
     * shape the archived logs show. Reports how much of each request was a
     * byte-identical prefix of the previous one, and how often anything moved.
     *
     * Measured against the previous creeping sweep, over 60 steps:
     *
     *   obs=5KB, budget=120K   old: cached 0.640, 37 rewrites
     *                          new: cached 0.929, 10 rewrites
     *   obs=2KB, budget= 80K   old: cached 0.725, 21 rewrites
     *                          new: cached 0.945,  6 rewrites
     *
     * Budget adherence is unchanged (the compacted view lands within ~2% of the
     * old one), so this is cache stability bought without spending context.
     */
    function measure(budget: number, steps: number, observationChars: number) {
      const msgs: LlmMessage[] = [{ role: "user", content: "task" }];
      let prev = truncateHistory(msgs, budget);
      let rewrites = 0;
      let cachedFraction = 0;
      for (let i = 0; i < steps; i++) {
        msgs.push({
          role: "assistant",
          content: "",
          toolCalls: [{ id: `c${i}`, name: "click", args: { ref: String(i) } }],
        });
        msgs.push({
          role: "tool",
          toolCallId: `c${i}`,
          content: `result ${i} ${"y".repeat(observationChars)}`,
        });
        const view = truncateHistory(msgs, budget);
        let firstDiff = prev.length;
        for (let k = 0; k < prev.length; k++) {
          if (ser(prev[k]!) !== ser(view[k]!)) {
            firstDiff = k;
            break;
          }
        }
        if (firstDiff < prev.length) rewrites++;
        cachedFraction += firstDiff / Math.max(1, prev.length);
        prev = view;
      }
      return { rewrites, meanCached: cachedFraction / steps };
    }

    it("keeps most of every request byte-identical to the previous one", () => {
      // The real budget and a heavy run (observations at the 6KB auto-observe
      // cap): the history runs well past the budget, so compaction engages.
      const { rewrites, meanCached } = measure(120_000, 60, 5_000);
      expect(meanCached).toBeGreaterThanOrEqual(0.85); // creeping sweep: 0.64
      expect(rewrites).toBeLessThanOrEqual(20); // creeping sweep: 37
    });

    it("stays stable on a lighter run too", () => {
      const { meanCached } = measure(80_000, 60, 2_000);
      expect(meanCached).toBeGreaterThanOrEqual(0.85); // creeping sweep: 0.73
    });

    it("leaves the history completely untouched while under budget", () => {
      const messages: LlmMessage[] = [
        { role: "user", content: "task" },
        ...Array.from({ length: 5 }, (_, i) => ({
          role: "tool" as const,
          toolCallId: `t${i}`,
          content: `payload ${i} ${"z".repeat(3_000)}`,
        })),
      ];
      const out = truncateHistory(messages, 1_000_000);
      expect(out.map((m) => m.content)).toEqual(messages.map((m) => m.content));
      expect(out.map((m) => m.images)).toEqual(messages.map((m) => m.images));
    });

    it("never compacts the newest messages, even while still over budget", () => {
      const messages: LlmMessage[] = [
        { role: "user", content: "task" },
        { role: "tool", toolCallId: "old", content: `old ${"y".repeat(3_000)}` },
        { role: "tool", toolCallId: "new", content: `new ${"y".repeat(3_000)}` },
      ];
      // 100 chars is far below the history's size: the sweep still keeps the
      // newest messages intact rather than leaving the model blind.
      const out = truncateHistory(messages, 100);
      expect(out.at(-1)?.content).toContain("new");
      expect(out.at(-1)?.content).not.toBe("[older tool result omitted]");
    });

    it("is idempotent — compacting an already-compacted view changes nothing", () => {
      const messages: LlmMessage[] = [
        { role: "user", content: "task" },
        ...Array.from({ length: 12 }, (_, i) => ({
          role: "tool" as const,
          toolCallId: `t${i}`,
          content: `payload ${i} ${"z".repeat(4_000)}`,
        })),
      ];
      const once = truncateHistory(messages, 20_000);
      const twice = truncateHistory(once, 20_000);
      expect(twice.map(ser)).toEqual(once.map(ser));
    });
  });
});

describe("boundCheckpoint", () => {
  const msg = (role: LlmMessage["role"], content: string): LlmMessage => ({ role, content });

  it("returns the identical array when the ceiling is not crossed (no per-step copy)", () => {
    const messages = [msg("user", "task"), msg("assistant", "hi")];
    const out = boundCheckpoint(messages);
    expect(out.dropped).toBe(0);
    expect(out.messages).toBe(messages);
  });

  it("drops the oldest messages and records it in-band once the ceiling is crossed", () => {
    const big = "x".repeat(200_000);
    const messages = [
      msg("user", "task"),
      msg("assistant", big),
      msg("tool", big),
      msg("assistant", big),
      msg("tool", "recent result"),
    ];
    const out = boundCheckpoint(messages);
    expect(out.dropped).toBeGreaterThan(0);
    expect(out.messages.length).toBeLessThan(messages.length);
    expect(out.messages[0]!.content).toContain("compacted away");
    expect(out.messages.at(-1)!.content).toBe("recent result");
  });

  it("never orphans a tool result — the cut lands on a non-tool message", () => {
    // Sizes chosen so the naive cut lands exactly on the tool message at
    // index 2; the guard must advance past it.
    const messages: LlmMessage[] = [
      msg("user", "task"),
      msg("assistant", "y".repeat(200_000)),
      msg("tool", "z".repeat(200_000)),
      msg("assistant", "a".repeat(100_000)),
      msg("tool", "b".repeat(100_000)),
      msg("assistant", "recent"),
      msg("tool", "recent result"),
    ];
    const out = boundCheckpoint(messages);
    expect(out.dropped).toBe(3);
    // Head of the kept transcript is the assistant call, never its tool result.
    expect(out.messages[0]!.role).toBe("user"); // the harness note
    expect(out.messages[1]!.role).toBe("assistant");
  });
});

describe("capCheckpointImages", () => {
  it("frees all but the newest MAX_LIVE_IMAGES screenshots in place", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "task" },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: "tool" as const,
        toolCallId: `t${i}`,
        content: `shot ${i}`,
        images: [`data:image/jpeg;base64,IMG${i}`],
      })),
    ];
    capCheckpointImages(messages);
    const kept = messages.filter((m) => m.images?.length);
    // The loop's request view never re-sends more than the newest 2, so the
    // older payloads must be released from the checkpoint itself (worker RAM).
    expect(kept).toHaveLength(2);
    expect(kept[0]?.images?.[0]).toBe("data:image/jpeg;base64,IMG4");
    expect(messages[1]?.images).toBeUndefined();
    // Text content is untouched — only image bytes are freed.
    expect(messages[1]?.content).toBe("shot 0");
  });

  it("leaves a checkpoint within the allowance untouched", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "task" },
      { role: "tool", toolCallId: "t0", content: "s", images: ["data:image/jpeg;base64,A"] },
    ];
    capCheckpointImages(messages);
    expect(messages[1]?.images).toHaveLength(1);
  });
});

describe("createStuckGuard", () => {
  it("flags a literal retry of a failed call and a failing streak", () => {
    const guard = createStuckGuard();
    expect(guard.note("evaluate_js", { frame: 287 }, true)).toBe("");
    // exact same call again → hard warning, not another silent retry
    expect(guard.note("evaluate_js", { frame: 287 }, true)).toContain("RETRY WARNING");
    // third consecutive failure of the tool (fresh args) → stuck
    expect(guard.note("evaluate_js", { other: 1 }, true)).toContain("STUCK");
    // success resets the streak
    expect(guard.note("evaluate_js", { other: 2 }, false)).toBe("");
    expect(guard.note("evaluate_js", { other: 3 }, true)).toBe("");
  });

  it("nags only after several identical successful polls", () => {
    const guard = createStuckGuard();
    for (let i = 0; i < 2; i++) expect(guard.note("snapshot", {}, false)).toBe("");
    expect(guard.note("snapshot", {}, false)).toContain("run 3 times");
  });

  it("never nags a wait tool for waiting", () => {
    const guard = createStuckGuard();
    for (let i = 0; i < 5; i++) expect(guard.note("wait_for", { text: "done" }, false)).toBe("");
    for (let i = 0; i < 5; i++) {
      expect(guard.note("wait_for_settle", { timeoutMs: 5000 }, false)).toBe("");
    }
    // Failures still count — a broken wait is a broken tool like any other.
    expect(guard.note("wait_for", { text: "x" }, true)).toBe("");
    expect(guard.note("wait_for", { text: "x" }, true)).toContain("RETRY WARNING");
  });

  it("bans an exact call after two identical failures — enforced, not advisory", () => {
    const guard = createStuckGuard();
    // Before any failure: nothing is blocked.
    expect(guard.blocked("click_at", { x: 5, y: 5 })).toBeNull();
    // First identical failure: ordinary warning, still not blocked.
    guard.note("click_at", { x: 5, y: 5 }, true);
    expect(guard.blocked("click_at", { x: 5, y: 5 })).toBeNull();
    // Second identical failure: the note announces the ban, and it is real.
    const second = guard.note("click_at", { x: 5, y: 5 }, true);
    expect(second).toContain("RETRY WARNING");
    expect(second).toContain("will NOT be executed");
    const refusal = guard.blocked("click_at", { x: 5, y: 5 });
    expect(refusal).toContain("BLOCKED — NOT EXECUTED");
    expect(refusal).toContain("MOVE ON");
    // A DIFFERENT call (even the same tool) is untouched by the ban.
    expect(guard.blocked("click_at", { x: 6, y: 5 })).toBeNull();
    // The ban applies to wait tools too — a timeout repeated on identical
    // arguments will time out again — but a LONGER timeout is a different
    // call and stays allowed.
    guard.note("wait_for", { text: "x", timeout_ms: 5000 }, true);
    guard.note("wait_for", { text: "x", timeout_ms: 5000 }, true);
    expect(guard.blocked("wait_for", { text: "x", timeout_ms: 5000 })).toContain("BLOCKED");
    expect(guard.blocked("wait_for", { text: "x", timeout_ms: 30000 })).toBeNull();
  });

  it("refuses the third identical failing call WITHOUT executing it", async () => {
    const cp = makeCheckpoint();
    const executed: string[] = [];
    const { events, deps } = harness(
      [
        toolCall("click", { ref: "12" }, "c1"),
        toolCall("click", { ref: "12" }, "c2"),
        toolCall("click", { ref: "12" }, "c3"),
        { text: "giving up on that", toolCalls: [], stopReason: "end_turn" },
      ],
      {
        execute: async (name) => {
          executed.push(name);
          return { ok: false, error: "boom" };
        },
      },
    );
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    // The third identical call was refused by the guard: the executor saw two
    // calls, not three.
    expect(executed).toEqual(["click", "click"]);
    const results = events.filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(3);
    const third = results[2] as { ok: boolean; result: string };
    expect(third.ok).toBe(false);
    expect(third.result).toContain("BLOCKED — NOT EXECUTED");
    // The refusal reaches the model as the tool message, so it can change plan.
    const toolMsgs = cp.messages.filter((m) => m.role === "tool");
    expect(toolMsgs[2]?.content).toContain("BLOCKED — NOT EXECUTED");
    // A refusal is a failed step, not an invalid tool call: three of them in
    // a row must NOT trip the invalid-call abort.
    expect(outcome).not.toBe("stopped");
  });
});

describe("adaptive per-step thinking", () => {
  const step = (id: string) => ({
    text: "",
    toolCalls: [{ id, name: "snapshot", args: {} }],
    stopReason: "tool_use" as const,
    reasoning: "ok",
  });

  it("isRoutineStep accepts only cheap single-call non-navigating successes", () => {
    const base = { toolCalls: 1, failed: false, reasoningChars: 100, pageChanging: false };
    expect(isRoutineStep(base)).toBe(true);
    expect(isRoutineStep({ ...base, toolCalls: 2 })).toBe(false);
    expect(isRoutineStep({ ...base, failed: true })).toBe(false);
    expect(isRoutineStep({ ...base, pageChanging: true })).toBe(false);
    expect(isRoutineStep({ ...base, reasoningChars: 5_000 })).toBe(false);
    expect(isRoutineStep({ ...base, toolCalls: 0 })).toBe(false);
  });

  it("lowers thinking to off after a routine streak, and restores on failure", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness(
      [step("a"), step("b"), step("c"), step("d"), { text: "done", toolCalls: [], stopReason: "end_turn" }],
      { thinking: "low", adaptiveThinking: true },
    );
    await runAgentTask(cp, deps);
    const llm = deps.llm as FakeLlm;
    // Steps 1-3 run at the configured level; step 4 (after 3 routine steps)
    // is sent with thinking off.
    expect(llm.seen[0]!.thinking).toBe("low");
    expect(llm.seen[1]!.thinking).toBe("low");
    expect(llm.seen[2]!.thinking).toBe("low");
    expect(llm.seen[3]!.thinking).toBe("off");
    expect(
      events.some((e) => e.kind === "info" && e.message.includes("adaptive thinking")),
    ).toBe(true);
  });

  it("does not lower when the switch is off", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness(
      [step("a"), step("b"), step("c"), { text: "done", toolCalls: [], stopReason: "end_turn" }],
      { thinking: "low" },
    );
    await runAgentTask(cp, deps);
    const llm = deps.llm as FakeLlm;
    for (const req of llm.seen) expect(req.thinking).toBe("low");
  });

  it("resets the streak when a step fails or navigates", async () => {
    const cp = makeCheckpoint();
    const failing = {
      text: "",
      toolCalls: [{ id: "f", name: "navigate", args: { url: "x" } }],
      stopReason: "tool_use" as const,
      reasoning: "ok",
    };
    const { deps } = harness(
      [step("a"), step("b"), failing, step("d"), step("e"), step("f2"), step("g"), { text: "done", toolCalls: [], stopReason: "end_turn" }],
      { thinking: "low", adaptiveThinking: true },
    );
    await runAgentTask(cp, deps);
    const llm = deps.llm as FakeLlm;
    // The navigate step at index 2 breaks the streak; steps 3,4,5 rebuild it
    // (0-based: seen[5] is the 4th routine... streak counts AFTER a step), so
    // seen[6] (step "g") still runs at low — and a run at "off" never applies.
    for (const [i, req] of llm.seen.entries()) {
      if (i <= 5) expect(req.thinking).toBe("low");
    }
  });
});

describe("madman mode wiring", () => {
  it("sends the plain prompt and emits no madman event when off", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      toolCall("snapshot", {}),
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    await runAgentTask(cp, deps);
    expect(events.some((e) => e.kind === "madman")).toBe(false);
    const llm = deps.llm as FakeLlm;
    expect(llm.seen[0]!.system).not.toContain("Madman mode");
  });

  it("seeds the profane voice into the system prompt when on", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness(
      [{ text: "done", toolCalls: [], stopReason: "end_turn" }],
      { madman: true },
    );
    await runAgentTask(cp, deps);
    const llm = deps.llm as FakeLlm;
    expect(llm.seen[0]!.system).toContain("Madman mode — ON");
    // Additive: the mandate and style contract must survive.
    expect(llm.seen[0]!.system).toContain("unrestricted execution");
    expect(llm.seen[0]!.system).toContain("ruthlessly concise");
  });

  it("emits one swearing exclamation per step that calls tools", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness(
      [
        toolCall("snapshot", {}),
        toolCall("click", { ref: "1" }, "c2"),
        { text: "done", toolCalls: [], stopReason: "end_turn" },
      ],
      { madman: true },
    );
    await runAgentTask(cp, deps);
    const madman = events.filter(
      (e): e is Extract<StepEvent, { kind: "madman" }> => e.kind === "madman",
    );
    expect(madman).toHaveLength(2);
    // Every exclamation carries a curse word — the core contract.
    for (const m of madman) expect(m.message).toMatch(/fuck|shit|damn|hell|ass|bastard|goddamn|piss|crap|bloody/i);
  });

  it("stays silent on a run that only answers, never acting", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness(
      [{ text: "no tools needed", toolCalls: [], stopReason: "end_turn" }],
      { madman: true },
    );
    await runAgentTask(cp, deps);
    expect(events.some((e) => e.kind === "madman")).toBe(false);
  });
});

describe("madman tool_call labels", () => {
  it("decorates every tool_call event with a cuss word when on", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness(
      [
        toolCall("snapshot", {}),
        toolCall("click", { ref: "1" }, "c2"),
        { text: "done", toolCalls: [], stopReason: "end_turn" },
      ],
      { madman: true },
    );
    await runAgentTask(cp, deps);
    const calls = events.filter(
      (e): e is Extract<StepEvent, { kind: "tool_call" }> => e.kind === "tool_call",
    );
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.label).toBeDefined();
      // The label carries a cuss word AND still names the tool.
      expect(c.label!).toContain(c.name);
      expect(c.label!).toMatch(/fuck|shit|damn|hell|ass|bastard|goddamn|piss|crap|bloody/i);
    }
  });

  it("omits the label entirely when off", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      toolCall("snapshot", {}),
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    await runAgentTask(cp, deps);
    const call = events.find(
      (e): e is Extract<StepEvent, { kind: "tool_call" }> => e.kind === "tool_call",
    )!;
    expect(call.label).toBeUndefined();
  });
});

describe("prompt-cache split and honest usage accounting", () => {
  // The clock rides in a volatile tail, never inside the cached system block:
  // a run that put it there re-prefilled its whole prompt on every one of 112
  // steps. And when the provider reports no usage, the loop must estimate from
  // what it actually SENT — not the raw checkpoint (whose base64 screenshots
  // once logged "context 1215933/128000").
  it("sends a per-step volatile clock tail and a stable system prompt", async () => {
    const cp = makeCheckpoint();
    const llm = new FakeLlm([
      toolCall("snapshot", {}),
      { text: "done", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { deps } = harness([], { llm });
    await runAgentTask(cp, deps);
    expect(llm.seen.length).toBeGreaterThanOrEqual(2);
    for (const req of llm.seen) {
      // Stable block carries rules + task, never the clock.
      expect(req.system).toContain("Current task: task");
      expect(req.system).not.toContain("Current date and time:");
      // Volatile tail carries the clock.
      expect(req.systemVolatile).toContain("Current date and time:");
    }
    // The stable block is byte-identical across steps (the cacheable prefix).
    expect(llm.seen[0]!.system).toBe(llm.seen[1]!.system);
  });

  it("marks usage estimated and counts images flat when the provider reports none", async () => {
    const cp = makeCheckpoint();
    // A tool result carrying a big base64 image: the old fallback counted its
    // chars/4 (~hundreds of thousands of tokens); the fix counts one flat
    // per-image estimate and works from the truncated request view.
    const bigImage = `data:image/jpeg;base64,${"A".repeat(400_000)}`;
    const { events, deps } = harness(
      [
        { text: "shoot", toolCalls: [{ id: "c1", name: "screenshot", args: {} }], stopReason: "tool_use" },
        { text: "done", toolCalls: [], stopReason: "end_turn" }, // no usage reported
      ],
      {
        execute: async () => ({ ok: true, payload: null, image: bigImage }),
      },
    );
    await runAgentTask(cp, deps);
    const stats = (events.at(-1) as Extract<StepEvent, { kind: "done" }>).stats!;
    expect(stats.usageEstimated).toBe(true);
    // Nowhere near the 400k-char image's naive chars/4 (~100k) — one flat
    // image estimate plus the small text, comfortably under the window.
    expect(stats.contextTokens).toBeLessThan(20_000);
    expect(stats.contextTokens).toBeGreaterThan(0);
  });

  it("leaves usage unmarked when the provider reports real numbers", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      { text: "Done.", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 700, outputTokens: 50 } },
    ]);
    await runAgentTask(cp, deps);
    const stats = (events.at(-1) as Extract<StepEvent, { kind: "done" }>).stats!;
    expect(stats.usageEstimated).toBeUndefined();
    expect(stats.totalTokens).toBe(750);
  });

  it("estimateMessages counts text at chars/4 and each image at a flat rate", () => {
    expect(estimateMessages([{ role: "user", content: "abcd" }])).toBe(1);
    expect(
      estimateMessages([{ role: "user", content: "", images: ["data:1", "data:2"] }]),
    ).toBe(2 * 1_500);
    // Tool-call args are real context whether or not they live in content.
    expect(
      estimateMessages([
        { role: "assistant", content: "", toolCalls: [{ id: "c", name: "n", args: { a: "xxxx" } }] },
      ]),
    ).toBeGreaterThan(0);
  });
});

/**
 * A client that thinks past any cap and only answers once thinking is off —
 * the shape of the archived run that asked for "low" and got 196,918 reasoning
 * tokens back. It honours the abort signal the way `readSse` does (the real
 * stream rejects out of the reader), so the loop's recovery path is exercised
 * exactly as it is in production.
 */
class RunawayLlm implements LlmClient {
  seen: LlmRequest[] = [];
  /** Attempts that were cut short by the reasoning cap. */
  capHits = 0;
  private offCalls = 0;
  constructor(private replies: LlmResult[]) {}
  async complete(
    req: LlmRequest,
    onText?: (t: string) => void,
    signal?: AbortSignal,
    onReasoning?: (t: string) => void,
  ): Promise<LlmResult> {
    this.seen.push(req);
    if (req.thinking === "off") {
      const reply =
        this.replies[this.offCalls++] ?? { text: "done", toolCalls: [], stopReason: "end" };
      onText?.(reply.text);
      return reply;
    }
    for (let k = 0; k < 80; k++) {
      onReasoning?.("x".repeat(400));
      if (signal?.aborted) {
        this.capHits += 1;
        throw new Error("aborted");
      }
    }
    return { text: "never reached", toolCalls: [], stopReason: "end" };
  }
}

describe("reasoning cap", () => {
  it("derives the ceiling from the level's own budget, and still caps Off", () => {
    // low = 1,024 tokens × 4 chars × the overrun factor of 3.
    expect(reasoningCapChars("low")).toBe(12_288);
    expect(reasoningCapChars("medium")).toBe(4_096 * 4 * 3);
    expect(reasoningCapChars("off")).toBe(OFF_REASONING_CAP_CHARS);
    expect(reasoningCapChars(undefined)).toBe(OFF_REASONING_CAP_CHARS);
  });

  it("cuts a runaway stream and re-asks the SAME step with its conclusions and thinking off", async () => {
    const llm = new RunawayLlm([{ text: "the answer", toolCalls: [], stopReason: "end" }]);
    const cp = makeCheckpoint();
    const { events, deps } = harness([], { llm, thinking: "low", stepCap: 2 });
    const outcome = await runAgentTask(cp, deps);

    expect(outcome).toBe("completed");
    expect(llm.capHits).toBe(1);
    expect(llm.seen).toHaveLength(2);
    expect(llm.seen[0]!.thinking).toBe("low");
    expect(llm.seen[1]!.thinking).toBe("off");
    // Same history plus one salvage note carrying the cut reasoning's tail.
    const reask = llm.seen[1]!.messages;
    expect(reask.slice(0, -1)).toEqual(llm.seen[0]!.messages);
    const note = reask.at(-1)!;
    expect(note.role).toBe("user");
    expect(String(note.content)).toContain("Do not deliberate further");
    expect(String(note.content)).toContain("xxxx");
    // The salvage note is request-only; it never lands in the checkpoint.
    expect(cp.messages.some((m) => String(m.content).includes("Do not deliberate"))).toBe(false);
    expect(
      events.some(
        (e) => e.kind === "info" && e.message.includes("overran the 1024-token budget"),
      ),
    ).toBe(true);
  });

  it("counts the reasoning it threw away, so a capped run never looks cheap", async () => {
    const llm = new RunawayLlm([{ text: "the answer", toolCalls: [], stopReason: "end" }]);
    const cp = makeCheckpoint();
    const { events, deps } = harness([], { llm, thinking: "low", stepCap: 2 });
    await runAgentTask(cp, deps);
    const stats = (events.at(-1) as Extract<StepEvent, { kind: "done" }>).stats!;
    // The cut attempt streamed past 12,288 chars ≈ 3,072 tokens before it died.
    expect(stats.reasoningChars).toBeGreaterThan(12_288);
    expect(stats.outputTokens).toBeGreaterThan(3_000);
  });

  it("switches thinking off for the rest of the run after three overruns", async () => {
    const llm = new RunawayLlm([
      { text: "", toolCalls: [{ id: "a", name: "snapshot", args: {} }], stopReason: "tool_use" },
      { text: "", toolCalls: [{ id: "b", name: "snapshot", args: {} }], stopReason: "tool_use" },
      { text: "", toolCalls: [{ id: "c", name: "snapshot", args: {} }], stopReason: "tool_use" },
      { text: "finished", toolCalls: [], stopReason: "end" },
    ]);
    const cp = makeCheckpoint();
    const { events, deps } = harness([], { llm, thinking: "low", stepCap: 8 });
    const outcome = await runAgentTask(cp, deps);

    expect(outcome).toBe("completed");
    expect(llm.capHits).toBe(3);
    // 3 capped attempts + 3 off-retries + 1 step that never asked for thinking.
    expect(llm.seen).toHaveLength(7);
    expect(llm.seen[6]!.thinking).toBe("off");
    expect(
      events.some(
        (e) => e.kind === "info" && e.message.includes("thinking is off for the rest of this run"),
      ),
    ).toBe(true);
  });

  it("counts cuts across the whole run — they need not be consecutive", async () => {
    // Field shape: runs E and F paid 14 and 11 cuts but never three in a row,
    // so the old "three in a row" rule never tripped and each cut cost a
    // wasted round trip forever. Here cuts sit on attempts 0, 3 and 6 with
    // healthy thinking steps in between.
    const CpLlm = class implements LlmClient {
      seen: LlmRequest[] = [];
      capHits = 0;
      private attempt = 0;
      private reply = 0;
      constructor(
        private capPlan: boolean[],
        private replies: LlmResult[],
      ) {}
      async complete(
        req: LlmRequest,
        onText?: (t: string) => void,
        signal?: AbortSignal,
        onReasoning?: (t: string) => void,
      ): Promise<LlmResult> {
        this.seen.push(req);
        const cut = this.capPlan[this.attempt++] === true;
        if (cut && req.thinking !== "off") {
          for (let k = 0; k < 80; k++) {
            onReasoning?.("x".repeat(400));
            if (signal?.aborted) {
              this.capHits += 1;
              throw new Error("aborted");
            }
          }
        }
        const reply =
          this.replies[this.reply++] ?? { text: "done", toolCalls: [], stopReason: "end" };
        onText?.(reply.text);
        return reply;
      }
    };
    const toolStep = (id: string): LlmResult => ({
      text: "",
      toolCalls: [{ id, name: "snapshot", args: {} }],
      stopReason: "tool_use",
    });
    const llm = new CpLlm(
      [true, false, false, true, false, false, true, false, false, false],
      [toolStep("a"), toolStep("b"), toolStep("c"), toolStep("d"), toolStep("e"), {
        text: "done",
        toolCalls: [],
        stopReason: "end",
      }],
    );
    const { events, deps } = harness([], { llm, thinking: "low", stepCap: 12 });
    const outcome = await runAgentTask(makeCheckpoint(), deps);
    expect(outcome).toBe("completed");
    expect(llm.capHits).toBe(3);
    const levels = llm.seen.map((r) => r.thinking);
    // Attempt 5 is a healthy `low` step AFTER a cut — the counter must survive
    // it — and everything from the third cut onward is off.
    expect(levels[2]).toBe("low");
    expect(levels[5]).toBe("low");
    expect(levels.slice(7)).toEqual(["off", "off"]);
    expect(
      events.some(
        (e) =>
          e.kind === "info" &&
          e.message.includes("thinking is off for the rest of this run"),
      ),
    ).toBe(true);
  });

  it("leaves a step that thinks inside its budget completely alone", async () => {
    // FakeLlm streams one character of reasoning: the cap must not fire, and
    // the step must not pay a second round trip.
    const cp = makeCheckpoint();
    const { deps } = harness([{ text: "done", toolCalls: [], stopReason: "end" }], {
      thinking: "low",
    });
    const llm = deps.llm as FakeLlm;
    await runAgentTask(cp, deps);
    expect(llm.seen).toHaveLength(1);
    expect(llm.seen[0]!.thinking).toBe("low");
  });

  it("caps a model that reasons at Off, and survives the salvage re-ask overrunning too", async () => {
    // The endpoint ignores thinking:off — every call streams a soliloquy until
    // the 8,192-char floor cuts it. Both cuts in a step must fall to the
    // empty-reply nudge, never kill the run.
    let calls = 0;
    const ignoresOff: LlmClient = {
      async complete(_req, onText, signal, onReasoning) {
        calls++;
        if (calls <= 2) {
          for (let k = 0; k < 80; k++) {
            onReasoning?.("y".repeat(400));
            if (signal?.aborted) throw new Error("aborted");
          }
        }
        onText?.("done");
        return { text: "done", toolCalls: [], stopReason: "end" };
      },
    };
    const cp = makeCheckpoint();
    const { events, deps } = harness([], { llm: ignoresOff, thinking: "off", stepCap: 4 });
    const outcome = await runAgentTask(cp, deps);
    expect(outcome).toBe("completed");
    expect(calls).toBe(3);
    expect(
      events.some(
        (e) => e.kind === "info" && e.message.includes(`${OFF_REASONING_CAP_CHARS.toLocaleString()}-char ceiling`),
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.kind === "info" && e.message.includes("salvage re-ask overran"),
      ),
    ).toBe(true);
    const nudge = cp.messages.find(
      (m) => m.role === "user" && String(m.content).includes("act without deliberating"),
    );
    expect(nudge).toBeDefined();
  });

  it("names an endpoint that ignores thinking:off, once", async () => {
    const chatty: LlmClient = {
      async complete(_req, onText, _signal, onReasoning) {
        onReasoning?.("z".repeat(2_000));
        onText?.("ok");
        return {
          text: "",
          toolCalls: [{ id: `t${Math.random()}`, name: "snapshot", args: {} }],
          stopReason: "tool_use",
        };
      },
    };
    const { events, deps } = harness([], { llm: chatty, thinking: "off", stepCap: 3 });
    await runAgentTask(makeCheckpoint(), deps);
    const notices = events.filter(
      (e) => e.kind === "info" && e.message.includes("ignores thinking:off"),
    );
    expect(notices).toHaveLength(1);
  });
});

describe("stream idle guard", () => {
  it("aborts a stream that goes silent mid-reply and retries the attempt", async () => {
    let attempts = 0;
    const stalls: LlmClient = {
      complete(_req, onText, signal) {
        attempts++;
        if (attempts === 1) {
          onText?.("partial");
          return new Promise((resolve, reject) => {
            const t = setTimeout(
              () => resolve({ text: "late", toolCalls: [], stopReason: "end" }),
              5_000,
            );
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new Error("The user aborted a request."));
              },
              { once: true },
            );
          });
        }
        onText?.("fast");
        return Promise.resolve({ text: "recovered", toolCalls: [], stopReason: "end" });
      },
    };
    const { events, deps } = harness([], { llm: stalls, streamIdleMs: 60 });
    const outcome = await runAgentTask(makeCheckpoint(), deps);
    expect(outcome).toBe("completed");
    expect(attempts).toBe(2);
    expect(
      events.some((e) => e.kind === "info" && e.message.includes("went silent")),
    ).toBe(true);
  }, 15_000);
});

describe("Jev per-step effort routing", () => {
  const toolStep = (id: string, name = "snapshot") => ({
    text: "",
    toolCalls: [{ id, name, args: name === "navigate" ? { url: "x" } : {} }],
    stopReason: "tool_use" as const,
    reasoning: "ok",
  });
  const end = { text: "done", toolCalls: [], stopReason: "end_turn" as const };

  /** An executor returning scripted per-call verdicts (in call order). */
  function verdictExecute(verdicts: Partial<ExecuteResult>[]) {
    let i = 0;
    return async (): Promise<ExecuteResult> => ({
      ok: true,
      payload: { fine: true },
      ...(verdicts[i++] ?? {}),
    });
  }
  const levels = (deps: LoopDeps): (string | undefined)[] =>
    (deps.llm as FakeLlm).seen.map((r) => r.thinking);

  it("a confident routine hint buys a RUN of cheap steps, not one (sticky until a surprise)", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness([toolStep("a"), toolStep("b"), toolStep("c"), end], {
      thinking: "medium",
      thinkingCeiling: "high",
      stepCap: 8,
      // One routine verdict, then no further verdicts (Jev did not answer).
      execute: verdictExecute([{ jevEffort: { choice: "routine", confidence: 0.9 } }, {}, {}]),
    });
    await runAgentTask(cp, deps);
    // Measured: run E got exactly ONE such verdict in 341 turns and then spent
    // the rest of its life at `low` (3.6s decode per step, 14 wasted cap
    // round trips). The local adaptive streak cannot cover that run either —
    // it needs reasoning under ADAPTIVE_ROUTINE_MAX_REASONING_CHARS, which a
    // model thinking at `low` never produces. One verdict describes a run of
    // routine steps, so it covers one.
    expect(levels(deps)).toEqual(["medium", "off", "off", "off"]);
  });

  it("raises a confident deep step back to the ceiling (never past it)", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness([toolStep("a"), toolStep("b"), end], {
      thinking: "low",
      thinkingCeiling: "high",
      stepCap: 8,
      execute: verdictExecute([{ jevEffort: { choice: "deep", confidence: 0.85 } }, {}]),
    });
    await runAgentTask(cp, deps);
    expect(levels(deps)).toEqual(["low", "high", "low"]);
  });

  it("drops the hint when the producing step fails — it never propagates", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness([toolStep("a"), toolStep("b"), toolStep("c"), end], {
      thinking: "medium",
      thinkingCeiling: "high",
      stepCap: 8,
      execute: verdictExecute([
        { jevEffort: { choice: "routine", confidence: 0.9 } }, // step0 ok → step1 off
        { ok: false, error: "boom", jevEffort: { choice: "routine", confidence: 0.9 } }, // step1 fails → verdict dropped
        {}, // step2 baseline (the failed step's hint did NOT carry)
      ]),
    });
    await runAgentTask(cp, deps);
    expect(levels(deps)).toEqual(["medium", "off", "medium", "medium"]);
  });

  it("drops the hint when the producing step navigates", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness([toolStep("a", "navigate"), toolStep("b"), end], {
      thinking: "medium",
      thinkingCeiling: "high",
      stepCap: 8,
      execute: verdictExecute([{ jevEffort: { choice: "routine", confidence: 0.9 } }, {}]),
    });
    await runAgentTask(cp, deps);
    // The navigate step's routine verdict is dropped → step1 stays baseline.
    expect(levels(deps)).toEqual(["medium", "medium", "medium"]);
  });

  it("is a no-op when the baseline is already off (deep cannot raise past an off ceiling)", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness([toolStep("a"), toolStep("b"), end], {
      thinking: "off",
      thinkingCeiling: "off",
      stepCap: 8,
      execute: verdictExecute([{ jevEffort: { choice: "deep", confidence: 0.9 } }, {}]),
    });
    await runAgentTask(cp, deps);
    expect(levels(deps)).toEqual(["off", "off", "off"]);
  });

  it("ignores a low-confidence routine verdict (below the floor)", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness([toolStep("a"), toolStep("b"), end], {
      thinking: "medium",
      thinkingCeiling: "high",
      stepCap: 8,
      execute: verdictExecute([{ jevEffort: { choice: "routine", confidence: 0.3 } }, {}]),
    });
    await runAgentTask(cp, deps);
    expect(levels(deps)).toEqual(["medium", "medium", "medium"]);
  });

  it("records the effective thinking level on turn_timing (the verification rig)", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([toolStep("a"), toolStep("b"), end], {
      thinking: "medium",
      thinkingCeiling: "high",
      stepCap: 8,
      execute: verdictExecute([{ jevEffort: { choice: "routine", confidence: 0.9 } }, {}]),
    });
    await runAgentTask(cp, deps);
    const timings = events.filter((e) => e.kind === "turn_timing");
    expect(timings.some((e) => e.kind === "turn_timing" && e.thinking === "off")).toBe(true);
  });

  it("announces Jev effort routing exactly once, on the first level change", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness(
      [toolStep("a"), toolStep("b"), toolStep("c"), toolStep("d"), end],
      {
        thinking: "medium",
        thinkingCeiling: "high",
        stepCap: 8,
        // Routine hints on every gated call → multiple lowered steps, one note.
        execute: verdictExecute([
          { jevEffort: { choice: "routine", confidence: 0.9 } },
          { jevEffort: { choice: "routine", confidence: 0.9 } },
          { jevEffort: { choice: "routine", confidence: 0.9 } },
          { jevEffort: { choice: "routine", confidence: 0.9 } },
        ]),
      },
    );
    await runAgentTask(cp, deps);
    const notes = events.filter(
      (e) => e.kind === "info" && e.message.includes("Jev effort routing"),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ jev: true });
  });

  it("arms a one-shot coaching line on the next tool result when progress is 'stuck'", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([toolStep("a"), toolStep("b"), end], {
      thinking: "medium",
      thinkingCeiling: "high",
      stepCap: 8,
      execute: verdictExecute([
        { jevProgress: { choice: "stuck", confidence: JEV_PROGRESS_CONFIDENCE } },
        {},
      ]),
    });
    await runAgentTask(cp, deps);
    // The note rides the NEXT step's tool result (armed after step0, consumed in step1).
    const coached = events.filter(
      (e) => e.kind === "tool_result" && e.result.includes("Jev progress check"),
    );
    expect(coached).toHaveLength(1);
  });

  it("does not coach on 'advancing' or a low-confidence progress verdict", async () => {
    for (const verdict of [
      { choice: "advancing", confidence: 0.95 },
      { choice: "stuck", confidence: JEV_PROGRESS_CONFIDENCE - 0.01 },
    ]) {
      const cp = makeCheckpoint();
      const { events, deps } = harness([toolStep("a"), toolStep("b"), end], {
        thinking: "medium",
        thinkingCeiling: "high",
        stepCap: 8,
        execute: verdictExecute([{ jevProgress: verdict }, {}]),
      });
      await runAgentTask(cp, deps);
      expect(
        events.some((e) => e.kind === "tool_result" && e.result.includes("Jev progress check")),
      ).toBe(false);
    }
  });
});

describe("precheckCall", () => {
  const specs = new Map([
    ["docs_op", { name: "docs_op", description: "", parameters: { type: "object" as const, properties: { op: { type: "string" }, rows: { type: "number" } }, required: ["op"] } }],
    ["click_at", { name: "click_at", description: "", parameters: { type: "object" as const, properties: { x: { type: "number" } } } }],
  ]);

  it("passes a complete call", () => {
    expect(precheckCall({ id: "1", name: "click_at", args: { x: 1, y: 2 } }, specs)).toBeNull();
    expect(precheckCall({ id: "1", name: "docs_op", args: { op: "apply_style", style: "h1" } }, specs)).toBeNull();
  });

  it("names the layer that is wrong", () => {
    expect(precheckCall({ id: "1", name: "nope", args: {} }, specs)).toContain("no tool named 'nope'");
    expect(precheckCall({ id: "1", name: "click_at", args: {}, invalidJson: "{x" }, specs)).toContain("not valid JSON");
    expect(precheckCall({ id: "1", name: "click_at", args: { x: "1" } }, specs)).toBe("parameter x must be a number");
    expect(precheckCall({ id: "1", name: "click_at", args: { space: "screenshot" } }, specs)).toBe("x and y (or ref) missing");
  });

  it("applies docs_op's own op rules", () => {
    const reason = precheckCall({ id: "1", name: "docs_op", args: { op: "apply_style", cols: 0 } }, specs);
    expect(reason).toContain("apply_style needs style");
    expect(reason).not.toMatch(/^INPUT-FAILED/);
  });

  it("hints with what arrived and a complete form", () => {
    const hint = malformedHint([
      { call: { id: "1", name: "click_at", args: { space: "screenshot", expect: "x" } }, reason: "x and y (or ref) missing" },
    ]);
    expect(hint).toContain("click_at arrived as {space, expect} — x and y (or ref) missing.");
    expect(hint).toContain('click_at {"x": 412');
  });

  it("nudges at 3, 8, 13 …", () => {
    expect([1, 2, 3, 4, 7, 8, 9, 13].filter(shouldStallNudge)).toEqual([3, 8, 13]);
  });
});
