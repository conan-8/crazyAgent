import { describe, expect, it } from "vitest";
import {
  runEchoTask,
  type EchoDeps,
} from "../extension/src/background/tasks/echo";
import type {
  Checkpoint,
  StepEvent,
} from "../extension/src/shared/protocol";

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    task: "demo",
    mode: "standard",
    demo: { steps: 3, intervalMs: 5 },
    stepIndex: 0,
    messages: [{ role: "user", content: "demo" }],
    startedAt: 1,
    updatedAt: 1,
    done: false,
    ...overrides,
  };
}

/**
 * Fake deps. `stopOnCheck` is the 1-based shouldStop() call number from which
 * stop requests are honored (shouldStop is called at each loop top, after each
 * step wait, and once at finish). Infinity = never stop.
 */
function harness(stopOnCheck = Infinity) {
  const events: StepEvent[] = [];
  const saves: Checkpoint[] = [];
  let stopChecks = 0;
  const deps: EchoDeps = {
    emit: (e) => events.push(e),
    save: async (cp) => {
      saves.push({ ...cp });
    },
    shouldStop: () => ++stopChecks >= stopOnCheck,
    sleep: async () => {},
  };
  return { events, saves, deps };
}

describe("runEchoTask", () => {
  it("runs every step and saves a checkpoint after each", async () => {
    const cp = makeCheckpoint();
    const { events, saves, deps } = harness();
    const outcome = await runEchoTask(cp, deps);

    expect(outcome).toBe("completed");
    expect(saves.map((s) => s.stepIndex)).toEqual([1, 2, 3]);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("step_started");
    expect(kinds.at(-1)).toBe("done");
    expect(kinds.filter((k) => k === "tool_call")).toHaveLength(3);
    expect(cp.done).toBe(true);
  });

  it("resumes from a mid-task checkpoint without redoing steps", async () => {
    const cp = makeCheckpoint({ stepIndex: 2 });
    const { events, saves, deps } = harness();
    await runEchoTask(cp, deps);

    expect(saves).toHaveLength(1); // only the remaining step 3
    expect(saves[0]?.stepIndex).toBe(3);
    expect(events[0]).toEqual({ kind: "step_started", stepIndex: 2 });
  });

  it("stops cooperatively between steps", async () => {
    const cp = makeCheckpoint();
    // Checks: 1 loop-top step0 (run), 2 post-wait step0 (run), 3 loop-top
    // step1 (stop) → exactly one completed step.
    const { events, saves, deps } = harness(3);
    const outcome = await runEchoTask(cp, deps);

    expect(outcome).toBe("stopped");
    expect(cp.stepIndex).toBe(1);
    expect(saves).toHaveLength(1);
    const done = events.at(-1);
    expect(done).toMatchObject({
      kind: "done",
      summary: expect.stringContaining("stopped"),
    });
  });

  it("interrupts a step mid-wait and leaves the checkpoint untouched", async () => {
    const cp = makeCheckpoint();
    // Checks: 1 loop-top (run), 2 post-wait (stop) → step 0 aborted.
    const { saves, deps } = harness(2);
    const outcome = await runEchoTask(cp, deps);

    expect(outcome).toBe("stopped");
    expect(cp.stepIndex).toBe(0);
    expect(saves).toHaveLength(0);
  });

  it("keeps the message log growing per step", async () => {
    const cp = makeCheckpoint();
    const { deps } = harness();
    await runEchoTask(cp, deps);
    expect(cp.messages).toHaveLength(4); // user + 3 tool results
  });
});
