import { describe, expect, it } from "vitest";
import {
  runAgentTask,
  truncateHistory,
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
  const deps: LoopDeps = {
    llm: new FakeLlm(script),
    emit: (e) => events.push(e),
    save: async (cp) => void saves.push(cp.stepIndex),
    shouldStop: () => false,
    execute: async (name, args) => {
      executed.push({ name, args });
      return { ok: true, payload: { fine: true } };
    },
    stepCap: 5,
    sendScreenshots: true,
    ...overrides,
  };
  return { events, saves, executed, deps };
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

  it("feeds validation errors back without executing, then recovers", async () => {
    const cp = makeCheckpoint();
    const { events, executed, deps } = harness([
      toolCall("click", {}, "bad"), // missing required ref
      toolCall("click", { ref: "2" }, "good"),
      { text: "done", toolCalls: [], stopReason: "end" },
    ]);
    const outcome = await runAgentTask(cp, deps);

    expect(outcome).toBe("completed");
    expect(executed).toEqual([{ name: "click", args: { ref: "2" } }]);
    const badResult = events.find(
      (e) => e.kind === "tool_result" && e.ok === false,
    ) as Extract<StepEvent, { kind: "tool_result" }>;
    expect(badResult.result).toContain("missing required parameter: ref");
    const errToolMsg = cp.messages.find(
      (m) => m.role === "tool" && m.content.startsWith("ERROR"),
    );
    expect(errToolMsg?.content).toContain("missing required");
  });

  it("aborts after three consecutive invalid calls", async () => {
    const cp = makeCheckpoint();
    const { events, deps } = harness([
      {
        text: "",
        toolCalls: [
          { id: "a", name: "click", args: {} },
          { id: "b", name: "click", args: {} },
          { id: "c", name: "click", args: {} },
        ],
        stopReason: "tool_use",
      },
    ]);
    const outcome = await runAgentTask(cp, deps);

    expect(outcome).toBe("stopped");
    expect(events.at(-1)).toMatchObject({ kind: "done" });
    expect(events.some((e) => e.kind === "error")).toBe(true);
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

  it("attaches screenshot images to tool messages and honors sendScreenshots", async () => {
    const big: ExecuteResult = { ok: true, payload: {}, text: "[shot]", image: "data:image/jpeg;base64,AAA" };
    const finisher: LlmResult = { text: "x", toolCalls: [], stopReason: "end" };
    const cp1 = makeCheckpoint();
    await runAgentTask(cp1, harness([toolCall("screenshot", {}, "s"), finisher], {
      execute: async () => big,
    }).deps);
    expect(cp1.messages.find((m) => m.role === "tool")?.images).toEqual([
      "data:image/jpeg;base64,AAA",
    ]);

    const cp2 = makeCheckpoint();
    await runAgentTask(cp2, harness([toolCall("screenshot", {}, "s"), { ...finisher }], {
      execute: async () => big,
      sendScreenshots: false,
    }).deps);
    expect(cp2.messages.find((m) => m.role === "tool")?.images).toBeUndefined();
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
