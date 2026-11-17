/**
 * Marathon mode state (MARATHON-PLAN.md §3.1).
 *
 * A pure state holder: no I/O, no timers, no publishing. The SessionController
 * owns the only instance and is the single path through which the panel and
 * the remote API change the switch ("one runner, one turn slot" applies to
 * chat-level state too). Clients render the state; they never assume it.
 *
 * M1: the shared sticky switch. M2: the carried plan snapshot. The watcher
 * fields stay idle until M3/M4.
 */

import { PLAN_LIMITS, PLAN_STATUSES } from '../packages/dsh-browser-extension/lib/plan.js'

/** Origins allowed to flip the switch. */
export const MARATHON_ORIGINS = Object.freeze(['ui', 'remote'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * M2: validate a carried-plan snapshot ({revision, items, updatedAt, turnId}).
 * Fail closed: anything malformed returns null rather than a partial plan.
 * @param {unknown} value
 * @returns {null | {revision: number, items: Array<{content: string, status: string}>, updatedAt: string, turnId: string}}
 */
export function normalizeMarathonPlan(value) {
  if (!isRecord(value)) return null
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) return null
  if (typeof value.updatedAt !== 'string' || typeof value.turnId !== 'string') return null
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > PLAN_LIMITS.maxItems) return null
  const items = []
  const contents = new Set()
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.content !== 'string' || item.content.trim().length === 0) return null
    if (typeof item.status !== 'string' || !PLAN_STATUSES.includes(item.status)) return null
    if (contents.has(item.content)) return null
    contents.add(item.content)
    items.push({ content: item.content, status: item.status })
  }
  return { revision: value.revision, items, updatedAt: value.updatedAt, turnId: value.turnId }
}

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

/**
 * V4 (§3.5, G2): the internal carry chain — prompts of up to the last 3 turns in
 * the current carried-plan chain, each clipped to 500 chars, oldest first. It is
 * INTERNAL (never published to clients via marathon.state) and feeds the judge
 * digest's carriedFrom so a continuation ("continue") carries its ancestor task.
 */
export const CARRY_CHAIN_LIMITS = Object.freeze({ maxTurns: 3, promptChars: 500 })

const CARRY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/gu
function clipCarryPrompt(text) {
  const value = String(text ?? '').replace(CARRY_CONTROL_CHARS, ' ')
  return value.length > CARRY_CHAIN_LIMITS.promptChars ? value.slice(0, CARRY_CHAIN_LIMITS.promptChars) : value
}

export class MarathonState {
  /** @param {{now?: () => Date}} [options] `now` is injected for tests. */
  constructor(options = {}) {
    this.now = options.now ?? (() => new Date())
    /** @type {MarathonSnapshot} */
    this.state = initialMarathonState()
    /** @type {Array<{prompt: string, turnId: string}>} V4 internal carry chain (not published). */
    this.carryChain = []
  }

  /** A plain copy; callers may never mutate the holder through it. */
  snapshot() {
    return { ...this.state, plan: this.state.plan === null ? null : { ...this.state.plan, items: this.state.plan.items.map(item => ({ ...item })) } }
  }

  /**
   * V4: the internal carry chain for the judge digest (ancestors, oldest first).
   * NOT part of snapshot() — never published to clients.
   * @returns {Array<{prompt: string, turnId: string}>}
   */
  carryChainForDigest() {
    return this.carryChain.map(entry => ({ ...entry }))
  }

  /**
   * V4: push the current turn's prompt into the carry chain (called after a turn
   * ends with the carried plan persisting, so it becomes an ancestor for the next
   * turn). Clipped to 500 chars; trimmed to the last 3, oldest first.
   * @param {string} prompt @param {string} turnId
   */
  pushCarryPrompt(prompt, turnId) {
    if (!this.state.enabled) return
    this.carryChain.push({ prompt: clipCarryPrompt(prompt), turnId: typeof turnId === 'string' ? turnId : '' })
    if (this.carryChain.length > CARRY_CHAIN_LIMITS.maxTurns) this.carryChain = this.carryChain.slice(-CARRY_CHAIN_LIMITS.maxTurns)
  }

  /** V4: clear the carry chain (carried plan dropped / marathon off / chat change). */
  clearCarryChain() {
    this.carryChain = []
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
      this.carryChain = [] // V4: marathon off resets the carry chain
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
    this.carryChain = [] // V4: new chat / real chat switch / restart resets the chain
    return { changed, state: this.snapshot() }
  }

  /**
   * M2: store the carried plan at turn end. Only while enabled (off clears the
   * plan); a snapshot with no open items drops the carried plan instead.
   * @param {null | {revision: number, items: Array<{content: string, status: string}>, updatedAt: string, turnId: string}} snapshot
   * @returns {{changed: boolean, state: MarathonSnapshot}}
   */
  storePlan(snapshot) {
    if (!this.state.enabled) return { changed: false, state: this.snapshot() }
    const normalized = normalizeMarathonPlan(snapshot)
    const open = normalized !== null && normalized.items.some(item => item.status === 'pending' || item.status === 'in_progress')
    const next = open ? normalized : null
    const changed = JSON.stringify(next) !== JSON.stringify(this.state.plan)
    this.state = { ...this.state, plan: next }
    if (next === null) this.carryChain = [] // V4: carried plan dropped resets the chain
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
