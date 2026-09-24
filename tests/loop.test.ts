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
  constructor(private script: LlmResult[]) {}
  async complete(req: LlmRequest, onText?: (t: string) => void): Promise<LlmResult> {
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
