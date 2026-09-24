// Phase 1 demo task ("echo"): a deterministic multi-step stand-in for the
// Phase 4 agent loop. Exercises the exact same machinery — step events,
// cooperative stop, per-step checkpointing, resume from stepIndex.
import type { Checkpoint, DemoConfig, StepEvent } from "../../shared/protocol";

export const DEFAULT_DEMO: DemoConfig = { steps: 20, intervalMs: 30_000 };

export type EchoOutcome = "completed" | "stopped";

export interface EchoDeps {
  emit(event: StepEvent): void;
  save(cp: Checkpoint): Promise<void>;
  shouldStop(): boolean;
  sleep(ms: number): Promise<void>;
}

export async function runEchoTask(
  cp: Checkpoint,
  deps: EchoDeps,
): Promise<EchoOutcome> {
  const demo = cp.demo ?? DEFAULT_DEMO;
  for (let i = cp.stepIndex; i < demo.steps; i++) {
    if (deps.shouldStop()) break;
    deps.emit({ kind: "step_started", stepIndex: i });
    deps.emit({
      kind: "tool_call",
      stepIndex: i,
      name: "echo",
      args: { text: `${cp.task} · step ${i + 1}/${demo.steps}` },
    });
    await deps.sleep(demo.intervalMs);
    if (deps.shouldStop()) break; // interrupted mid-step: leave stepIndex untouched
    deps.emit({
      kind: "tool_result",
      stepIndex: i,
      name: "echo",
      result: `step ${i + 1} ok`,
      ok: true,
    });
    cp.stepIndex = i + 1;
    cp.updatedAt = Date.now();
    cp.messages.push({ role: "tool", content: `echo step ${i + 1} ok` });
    await deps.save(cp);
  }
  const outcome: EchoOutcome = deps.shouldStop() ? "stopped" : "completed";
  cp.done = true;
  cp.updatedAt = Date.now();
  deps.emit({
    kind: "done",
    summary:
      outcome === "completed"
        ? `demo completed (${cp.stepIndex} steps)`
        : `demo stopped at step ${cp.stepIndex}`,
  });
  return outcome;
}
