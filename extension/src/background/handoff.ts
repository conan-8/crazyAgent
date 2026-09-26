// Human handoff — the gate half (the decision logic is pure, in
// shared/handoff.ts). When the page is a sign-in wall or a CAPTCHA, the run
// pauses and the panel asks the user to take over; the model is told in-band
// what happened instead of silently "succeeding" at a task it never did.
import type { StepEvent } from "../shared/protocol";
import { handoffReason, type AuthSignals, type WallProbe } from "../shared/handoff";
import { runContentAction } from "./tools/content-action";

/**
 * What a human needs to look at right now, or null. `probe` is what the action
 * would target (the wall only counts when the action is part of the wall). A
 * failed probe (no content script, closed tab) is "no wall" — the detector
 * never blocks a run on its own inability to see.
 */
export async function detectAuthWall(
  tabId: number,
  task: string,
  probe?: WallProbe | null,
): Promise<{ reason: string; url: string } | null> {
  const res = await runContentAction(tabId, { action: "authSignals" }).catch(() => null);
  if (!res?.ok) return null;
  const signals = res.data as AuthSignals;
  const reason = handoffReason(signals, task, probe);
  return reason ? { reason, url: signals.url } : null;
}

/** The pause/resume seam, shaped after ConfirmGate. */
export class HumanGate {
  #pending = new Map<string, (handled: boolean) => void>();
  /** URLs already handed off in this run — one prompt per wall, not per step. */
  #seen = new Set<string>();

  constructor(
    private emit: (event: StepEvent) => void,
    private timeoutMs = 300_000,
  ) {}

  reset(): void {
    this.#seen.clear();
  }

  alreadySeen(url: string): boolean {
    return this.#seen.has(url);
  }

  /**
   * Pause the run until the user answers. Times out to "not handled" (the
   * agent continues and reports) rather than deadlocking a run forever.
   */
  async request(reason: string, url: string): Promise<{ handled: boolean }> {
    this.#seen.add(url);
    const id = `hm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.emit({ kind: "need_human", id, reason, url });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ handled: false });
      }, this.timeoutMs);
      this.#pending.set(id, (handled) => {
        clearTimeout(timer);
        resolve({ handled });
      });
    });
  }

  resolve(id: string, handled: boolean): void {
    const resolver = this.#pending.get(id);
    if (resolver) {
      this.#pending.delete(id);
      resolver(handled);
    }
  }
}
