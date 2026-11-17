/**
 * Marathon mode state (MARATHON-PLAN.md §3.1).
 *
 * A pure state holder: no I/O, no timers, no publishing. The SessionController
 * owns the only instance and is the single path through which the panel and
 * the remote API change the switch ("one runner, one turn slot" applies to
 * chat-level state too). Clients render the state; they never assume it.
 *
 * M1 scope: the shared sticky switch only. `plan` stays null until M2 wires
 * plan carry-over; the watcher fields stay idle until M3/M4.
 */

/** Origins allowed to flip the switch. */
export const MARATHON_ORIGINS = Object.freeze(['ui', 'remote'])

/**
 * The watcher projection while no watcher exists (M1). M3 replaces this with
 * the live scheduler state; the frame shape stays the same.
 */
export const MARATHON_WATCHER_IDLE = Object.freeze({
  active: false,
  checks: 0,
  lastCheckAt: null,
  lastVerdict: null,
})

/**
 * @typedef {{
 *   enabled: boolean,
 *   sessionId: string | null,
 *   since: string | null,
 *   origin: 'ui' | 'remote' | null,
 *   plan: null | {revision: number, items: Array<{content: string, status: string}>, updatedAt: string, turnId: string},
 * }} MarathonSnapshot
 */

/** The fail-safe initial state: off. A companion restart constructs a new one. */
export function initialMarathonState() {
  return { enabled: false, sessionId: null, since: null, origin: null, plan: null }
}

export class MarathonState {
  /** @param {{now?: () => Date}} [options] `now` is injected for tests. */
  constructor(options = {}) {
    this.now = options.now ?? (() => new Date())
    /** @type {MarathonSnapshot} */
    this.state = initialMarathonState()
  }

  /** A plain copy; callers may never mutate the holder through it. */
  snapshot() {
    return { ...this.state, plan: this.state.plan === null ? null : { ...this.state.plan, items: this.state.plan.items.map(item => ({ ...item })) } }
  }

  /**
   * Flip the shared switch. Accepted in any turn state; the running turn keeps
   * the modes it started with (the controller captured them at turn start).
   * Turning off clears the carried plan. Enabling an already-on switch keeps
   * the original `since`/`origin` (idempotent, no re-arming timestamp).
   * @param {{enabled: unknown, origin?: unknown, sessionId?: unknown}} input
   * @returns {{ok: true, changed: boolean, state: MarathonSnapshot} | {ok: false, code: string, message: string, retryable: boolean}}
   */
  set({ enabled, origin = 'ui', sessionId = null }) {
    if (typeof enabled !== 'boolean') {
      return { ok: false, code: 'INVALID_MARATHON', message: 'enabled must be a boolean.', retryable: false }
    }
    const normalizedOrigin = MARATHON_ORIGINS.includes(origin) ? origin : 'ui'
    const normalizedSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
    const before = this.state
    if (enabled) {
      if (before.enabled) return { ok: true, changed: false, state: this.snapshot() }
      this.state = {
        enabled: true,
        sessionId: normalizedSessionId,
        since: this.now().toISOString(),
        origin: normalizedOrigin,
        plan: null,
      }
    } else {
      if (!before.enabled && before.plan === null) return { ok: true, changed: false, state: this.snapshot() }
      // Off clears the carried plan (M2) and every enable-time marker.
      this.state = initialMarathonState()
    }
    return { ok: true, changed: true, state: this.snapshot() }
  }

  /**
   * Reset to off without an origin (new chat, a real chat switch, restart).
   * @returns {{changed: boolean, state: MarathonSnapshot}}
   */
  reset() {
    const changed = this.state.enabled || this.state.plan !== null
    this.state = initialMarathonState()
    return { changed, state: this.snapshot() }
  }
}

/**
 * The `marathon.state` frame body (panel bridge) and the `remote.marathon`
 * envelope body share this shape: the snapshot plus the watcher projection.
 * @param {MarathonSnapshot} snapshot
 */
export function marathonFrameBody(snapshot) {
  return { ...snapshot, watcher: { ...MARATHON_WATCHER_IDLE } }
}
