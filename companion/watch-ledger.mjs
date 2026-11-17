/**
 * Watch ledger (MARATHON-PLAN.md §3.3.1) and the deterministic assess()
 * (§3.3.2). Both are pure: no I/O, no timers, no publishing. The companion
 * feeds the ledger from publish(frame), onActivity, and onConnectionChange;
 * the watcher reads assess() on its tick. The ledger runs for EVERY turn
 * (marathon or not) so a mid-turn toggle already has history.
 *
 * Timestamps are monotonic (an injected `now`, performance.now() in
 * production). assess() never mutates the ledger and never decides an outcome;
 * it only reports signals. Soft signals never alert on their own — they bring
 * the next judge call forward (M4). Hard signals alert without the model.
 */

import { noProgressResultText } from '../packages/dsh-browser-extension/lib/repeat-guards.js'

/** Observation tools that mutate nothing (the OBSERVE_ONLY list, §3.3.2). */
export const READ_ONLY_TOOLS = Object.freeze(new Set([
  'browser_screenshot', 'browser_read_text', 'browser_find', 'browser_tabs',
  'browser_places', 'browser_docs_read', 'browser_downloads', 'browser_wait_for',
]))

/**
 * V2 control tools (§3.3): plan/help/confirmation are not page actions. Their
 * results are excluded from FAIL_STREAK, SAME_ERROR, REPEAT_LOOP, OBSERVE_ONLY,
 * the mutation counters, and recovery. A PLAN_* error is plan friction (V8),
 * not a stuck browser. Plan calls still feed the plan snapshot via activity.
 */
export const CONTROL_TOOLS = Object.freeze(new Set([
  'browser_plan', 'agent_request_help', 'agent_request_confirmation',
]))

/**
 * V2 tool class (§3.3): observe (observation), control (none of the counters),
 * act (page actions). Replaces the single read-only list as the progress basis.
 * @param {string} name
 * @returns {'observe' | 'control' | 'act'}
 */
export function toolClass(name) {
  if (READ_ONLY_TOOLS.has(name)) return 'observe'
  if (CONTROL_TOOLS.has(name)) return 'control'
  return 'act'
}

export const WATCH_LIMITS = Object.freeze({
  toolEvents: 40,
  argsDigestChars: 200,
  headChars: 300,
  tailChars: 600,
  promptChars: 1500,
})

/** Every threshold from the plan's table (§3.3.2), in one place. */
export const WATCH_THRESHOLDS = Object.freeze({
  silentStallSuspectMs: 120_000,
  silentStallHardMs: 300_000,
  toolHangSuspectMs: 90_000,
  toolHangHardMs: 240_000,
  executorDownSuspectMs: 30_000,
  executorDownHardMs: 120_000,
  failStreak: 5,
  repeatLoopWindow: 8,
  repeatLoopCount: 3,
  repeatLoopDistinctWindow: 10,
  repeatLoopDistinctMax: 2,
  sameErrorWindow: 10,
  sameErrorCount: 4,
  observeOnlyWindow: 12,
  noEffectWindow: 8,
  noEffectCount: 4,
  planStalledResults: 25,
  planStalledMs: 600_000,
  sidePanelClosedTrigger: 2,
})

/** Text patterns that hint at a wall the agent keeps acting against (§3.3.2). */
const WALL_HINT_PATTERN = /sign[- ]?in|log[- ]?in|captcha|verify (?:you are|that you're) human|access denied|payment required|checkout|subscription required|create an account to continue/iu

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/gu

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clip(text, max) {
  const value = String(text ?? '').replace(CONTROL_CHARS, ' ')
  return value.length > max ? value.slice(0, max) : value
}

/** A stable fingerprint for a tool call: name + canonically-ordered args. */
export function toolFingerprint(name, args) {
  return `${String(name ?? '')}|${stableStringify(args)}`
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** The leading error code of a result text (`CODE: …` or `refused CODE: …`). */
export function resultCode(text) {
  const value = String(text ?? '').trim()
  const match = /^(?:refused\s+)?([A-Z][A-Z0-9_]{2,})\b/u.exec(value)
  return match ? match[1] : null
}

function emptyLedgerState() {
  return {
    turnId: null,
    marathon: false,
    running: false,
    prompt: '',
    turnStartAt: 0,
    lastEventAt: 0,
    lastModelDeltaAt: 0,
    lastToolCallAt: 0,
    lastToolResultAt: 0,
    lastOkMutationAt: 0,
    lastPlanRevisionAt: 0,
    /** @type {Map<string, {name: string, args: unknown, since: number}>} */
    inFlight: new Map(),
    /** @type {Array<{n: number, at: number, name: string, argsDigest: string, fingerprint: string, ok: boolean, code: string | null, head: string, durationMs: number | null, readOnly: boolean}>} */
    events: [],
    eventCount: 0,
    assistantTail: '',
    reasoningTail: '',
    plan: null,
    planRevision: 0,
    nonPlanResultsSinceRevision: 0,
    sidePanelClosedStreak: 0,
    uiConnected: true,
    toolsConnected: true,
    executorDownSince: null,
    // M4 bounded per-turn aggregates (cheap counters; no new I/O). They surface
    // wander that the last-40 event window misses: whole-turn fingerprint and
    // navigation-target occurrence counts, and the open-item trajectory.
    /** @type {Map<string, {count: number, ok: number, headsVary: boolean, firstHead: string, name: string, argsDigest: string, readOnly: boolean}>} */
    fingerprintStats: new Map(),
    /** @type {Map<string, number>} */
    navTargetCounts: new Map(),
    okMutationCount: 0,
    // V2 (§3.3): effectful act results (ok, not no-effect, not control) for
    // evidence-based recovery, and the plan completed count (a rise clears an
    // alert; a revision alone or marking blocked never does).
    okEffectfulActCount: 0,
    planCompletedCount: 0,
    firstPlanOpen: null,
    currentPlanOpen: null,
    openLastDecreasedAt: 0,
    okMutationsSinceOpenDecrease: 0,
    /** @type {Array<{at: number, open: number}>} */
    planOpenSamples: [],
  }
}

/** Bounds for the M4 aggregates (keep them cheap and the digest ~200 tokens). */
export const WATCH_AGGREGATE_LIMITS = Object.freeze({
  fingerprintKeys: 1000,
  navTargetKeys: 200,
  navTargetChars: 120,
  planOpenSamples: 40,
  digestRevisits: 5,
  digestNavRevisits: 3,
  digestOpenSamples: 8,
  digestArgsChars: 60,
  revisitCount: 3,
  openFlatMs: 150_000,
  openFlatMutations: 3,
})

/** The navigation target of a browser_navigate call (url, or history direction). */
function navigationTarget(args) {
  if (args === null || typeof args !== 'object') return null
  const raw = typeof args.url === 'string' ? args.url
    : typeof args.target === 'string' ? args.target
      : typeof args.history === 'string' ? `history:${args.history}` : null
  if (raw === null) return null
  return raw.length > WATCH_AGGREGATE_LIMITS.navTargetChars ? raw.slice(0, WATCH_AGGREGATE_LIMITS.navTargetChars) : raw
}

export class WatchLedger {
  /** @param {{now?: () => number}} [options] monotonic clock, injected for tests. */
  constructor(options = {}) {
    this.now = options.now ?? (() => performance.now())
    this.state = emptyLedgerState()
  }

  /** Begin a turn (every turn, marathon or not). */
  startTurn({ turnId, prompt = '', marathon = false }) {
    const at = this.now()
    const connectivity = { uiConnected: this.state.uiConnected, toolsConnected: this.state.toolsConnected }
    this.state = emptyLedgerState()
    this.state.uiConnected = connectivity.uiConnected
    this.state.toolsConnected = connectivity.toolsConnected
    this.state.turnId = typeof turnId === 'string' ? turnId : null
    this.state.marathon = marathon === true
    this.state.running = true
    this.state.prompt = clip(prompt, WATCH_LIMITS.promptChars)
    this.state.turnStartAt = at
    this.state.lastEventAt = at
    this.state.lastModelDeltaAt = at
    this.state.executorDownSince = this.#executorDown() ? at : null
  }

  /** End the turn: stop tracking, keep the final snapshot for the summary. */
  endTurn() {
    this.state.running = false
    this.state.inFlight.clear()
  }

  /** Executor connectivity from the bridge (onConnectionChange). */
  setConnectivity({ uiConnected, toolsConnected }) {
    if (typeof uiConnected === 'boolean') this.state.uiConnected = uiConnected
    if (typeof toolsConnected === 'boolean') this.state.toolsConnected = toolsConnected
    const down = this.#executorDown()
    if (down && this.state.executorDownSince === null) this.state.executorDownSince = this.now()
    if (!down) this.state.executorDownSince = null
  }

  #executorDown() {
    return this.state.running && (!this.state.uiConnected || !this.state.toolsConnected
      || this.state.sidePanelClosedStreak >= WATCH_THRESHOLDS.sidePanelClosedTrigger)
  }

  /**
   * Feed one companion frame (publish / onActivity). Pure state update; the
   * caller decides what to publish. Unknown frames only bump lastEventAt.
   * @param {Record<string, any>} frame
   */
  noteFrame(frame) {
    if (!isRecord(frame) || !this.state.running) return
    const at = this.now()
    this.state.lastEventAt = at
    const type = frame.type
    if (type === 'chat.tool_call') {
      this.#noteToolCall(frame, at)
      return
    }
    if (type === 'chat.tool_result') {
      this.#noteToolResult(frame, at)
      return
    }
    if (type === 'chat.assistant') {
      if (typeof frame.text === 'string') this.state.assistantTail = clip(frame.text, WATCH_LIMITS.tailChars)
      return
    }
    if (type === 'chat.activity') {
      this.#noteActivity(frame, at)
      return
    }
    if (type === 'chat.done' || type === 'chat.stopped' || type === 'chat.error') {
      this.endTurn()
    }
  }

  #noteToolCall(frame, at) {
    const callId = typeof frame.callId === 'string' ? frame.callId : null
    const name = typeof frame.name === 'string' ? frame.name : 'unknown'
    this.state.lastToolCallAt = at
    if (callId !== null) this.state.inFlight.set(callId, { name, args: frame.args, since: at })
  }

  #noteToolResult(frame, at) {
    const callId = typeof frame.callId === 'string' ? frame.callId : null
    const pending = callId !== null ? this.state.inFlight.get(callId) : undefined
    if (callId !== null) this.state.inFlight.delete(callId)
    const name = pending?.name ?? (typeof frame.name === 'string' ? frame.name : 'unknown')
    const args = pending?.args
    const ok = frame.ok === true
    const text = typeof frame.text === 'string' ? frame.text : ''
    const code = ok ? null : resultCode(text)
    const cls = toolClass(name)
    const readOnly = cls === 'observe'
    const control = cls === 'control'
    const durationMs = pending ? Math.max(0, at - pending.since) : null
    const argsDigest = clip(stableStringify(args), WATCH_LIMITS.argsDigestChars)
    const fingerprint = toolFingerprint(name, args)
    const head = clip(text, WATCH_LIMITS.headChars)
    this.state.lastToolResultAt = at
    // V2: an ok ACT result whose text matches the provider's NO VISIBLE CHANGE
    // marker made no effect (shared predicate, agree by construction).
    const noEffect = ok && cls === 'act' && noProgressResultText(text)
    // V2: only an ok ACT result is a mutation; control and observe are not.
    if (ok && cls === 'act') {
      this.state.lastOkMutationAt = at
      this.state.okMutationCount += 1
      this.state.okMutationsSinceOpenDecrease += 1
      if (!noEffect) this.state.okEffectfulActCount += 1
    }
    // Connectivity streak is about the executor, not progress: keep for all.
    if (code === 'SIDE_PANEL_CLOSED') this.state.sidePanelClosedStreak += 1
    else if (ok) this.state.sidePanelClosedStreak = 0
    // V2: control results are left out of every progress counter and the event
    // window (FAIL_STREAK/SAME_ERROR/REPEAT_LOOP/OBSERVE_ONLY read `events`).
    if (control) {
      const down = this.#executorDown()
      if (down && this.state.executorDownSince === null) this.state.executorDownSince = at
      if (!down) this.state.executorDownSince = null
      return
    }
    if (cls === 'act') this.state.nonPlanResultsSinceRevision += 1
    this.state.eventCount += 1
    // M4 whole-turn aggregates: fingerprint occurrence + outcome variation, and
    // navigation-target revisits (digest info; the redo signature is a repeated
    // successful MUTATION with the same outcome, not mere navigation).
    const stats = this.state.fingerprintStats.get(fingerprint)
    if (stats !== undefined) {
      stats.count += 1
      if (ok) stats.ok += 1
      if (!stats.headsVary && head !== stats.firstHead) stats.headsVary = true
    } else if (this.state.fingerprintStats.size < WATCH_AGGREGATE_LIMITS.fingerprintKeys) {
      this.state.fingerprintStats.set(fingerprint, { count: 1, ok: ok ? 1 : 0, headsVary: false, firstHead: head, name, argsDigest, readOnly, toolClass: cls })
    }
    if (name === 'browser_navigate') {
      const target = navigationTarget(args)
      if (target !== null && this.state.navTargetCounts.size < WATCH_AGGREGATE_LIMITS.navTargetKeys) {
        this.state.navTargetCounts.set(target, (this.state.navTargetCounts.get(target) ?? 0) + 1)
      } else if (target !== null) {
        const existing = this.state.navTargetCounts.get(target)
        if (existing !== undefined) this.state.navTargetCounts.set(target, existing + 1)
      }
    }
    this.state.events.push({
      n: this.state.eventCount,
      at,
      name,
      argsDigest,
      fingerprint,
      ok,
      code,
      head,
      durationMs,
      readOnly,
      toolClass: cls,
      noEffect,
    })
    if (this.state.events.length > WATCH_LIMITS.toolEvents) this.state.events.shift()
    const down = this.#executorDown()
    if (down && this.state.executorDownSince === null) this.state.executorDownSince = at
    if (!down) this.state.executorDownSince = null
  }

  #noteActivity(frame, at) {
    const kind = frame.kind
    if (kind === 'text' || kind === 'reasoning' || kind === 'tool-call-delta' || kind === 'model-start') {
      this.state.lastModelDeltaAt = at
    }
    if (kind === 'text' && typeof frame.text === 'string') {
      this.state.assistantTail = clip(this.state.assistantTail + frame.text, WATCH_LIMITS.tailChars)
    }
    if (kind === 'reasoning' && typeof frame.text === 'string') {
      this.state.reasoningTail = clip(this.state.reasoningTail + frame.text, WATCH_LIMITS.tailChars)
    }
    if (kind === 'plan') {
      const revision = Number.isSafeInteger(frame.revision) ? frame.revision : this.state.planRevision
      if (revision !== this.state.planRevision || this.state.plan === null) {
        this.state.planRevision = revision
        this.state.lastPlanRevisionAt = at
        this.state.nonPlanResultsSinceRevision = 0
      }
      if (Array.isArray(frame.items)) {
        this.state.plan = { revision, items: frame.items.map(item => ({ content: String(item?.content ?? ''), status: String(item?.status ?? '') })) }
        // V2: the completed count rises only when items actually complete; a
        // revision alone or marking items blocked never raises it.
        this.state.planCompletedCount = this.state.plan.items.filter(item => item.status === 'completed').length
        // M4 open-item trajectory: a decrease resets the flat clock; flat/rising
        // open items while mutations continue is the wander/stall signature.
        const open = this.state.plan.items.filter(item => item.status === 'pending' || item.status === 'in_progress').length
        if (this.state.firstPlanOpen === null) {
          this.state.firstPlanOpen = open
          this.state.openLastDecreasedAt = at
          this.state.okMutationsSinceOpenDecrease = 0
        } else if (this.state.currentPlanOpen !== null && open < this.state.currentPlanOpen) {
          this.state.openLastDecreasedAt = at
          this.state.okMutationsSinceOpenDecrease = 0
        }
        this.state.currentPlanOpen = open
        this.state.planOpenSamples.push({ at, open })
        if (this.state.planOpenSamples.length > WATCH_AGGREGATE_LIMITS.planOpenSamples) this.state.planOpenSamples.shift()
      }
    }
  }

  /** A plain, bounded snapshot for the judge digest (M4) and diagnostics. */
  snapshot() {
    const s = this.state
    return {
      turnId: s.turnId,
      marathon: s.marathon,
      running: s.running,
      prompt: s.prompt,
      turnStartAt: s.turnStartAt,
      lastEventAt: s.lastEventAt,
      lastModelDeltaAt: s.lastModelDeltaAt,
      lastToolCallAt: s.lastToolCallAt,
      lastToolResultAt: s.lastToolResultAt,
      lastOkMutationAt: s.lastOkMutationAt,
      lastPlanRevisionAt: s.lastPlanRevisionAt,
      inFlight: [...s.inFlight.entries()].map(([callId, call]) => ({ callId, name: call.name, since: call.since })),
      events: s.events.map(event => ({ ...event })),
      eventCount: s.eventCount,
      assistantTail: s.assistantTail,
      reasoningTail: s.reasoningTail,
      plan: s.plan === null ? null : { revision: s.plan.revision, items: s.plan.items.map(item => ({ ...item })) },
      planRevision: s.planRevision,
      nonPlanResultsSinceRevision: s.nonPlanResultsSinceRevision,
      okEffectfulActCount: s.okEffectfulActCount,
      planCompletedCount: s.planCompletedCount,
      sidePanelClosedStreak: s.sidePanelClosedStreak,
      uiConnected: s.uiConnected,
      toolsConnected: s.toolsConnected,
      executorDownSince: s.executorDownSince,
      aggregates: this.#aggregates(),
    }
  }

  /** Bounded M4 turn aggregates for assess() and the judge digest. */
  #aggregates() {
    const s = this.state
    const lim = WATCH_AGGREGATE_LIMITS
    const stats = [...s.fingerprintStats.values()]
    const mutationRevisit = stats.some(st => !st.readOnly && st.count >= lim.revisitCount && st.ok >= 1 && !st.headsVary)
    const mutationRevisits = stats
      .filter(st => !st.readOnly && st.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, lim.digestRevisits)
      .map(st => ({ tool: st.name, args: st.argsDigest.slice(0, lim.digestArgsChars), count: st.count, ok: st.ok, sameOutcome: !st.headsVary }))
    const navRevisits = [...s.navTargetCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, lim.digestNavRevisits)
      .map(([target, count]) => ({ target: target.slice(0, lim.digestArgsChars), count }))
    return {
      calls: s.eventCount,
      distinctFingerprints: s.fingerprintStats.size,
      okMutations: s.okMutationCount,
      mutationRevisit,
      mutationRevisits,
      navRevisits,
      openItems: {
        first: s.firstPlanOpen,
        current: s.currentPlanOpen,
        lastDecreaseAt: s.openLastDecreasedAt,
        okMutationsSinceDecrease: s.okMutationsSinceOpenDecrease,
        samples: s.planOpenSamples.slice(-lim.digestOpenSamples).map(sample => ({ ...sample })),
      },
    }
  }
}

/**
 * The deterministic assessment (§3.3.2). Pure: reads a ledger snapshot and a
 * monotonic `now`, returns `{level, signals, hints}`. `level` is the strongest
 * signal level ('hard' > 'suspect' > 'ok'). Hints (WALL_HINT) never alert.
 * @param {ReturnType<WatchLedger['snapshot']>} state
 * @param {number} now
 * @returns {{level: 'ok' | 'suspect' | 'hard', signals: Array<{kind: string, level: 'suspect' | 'hard', detail: string}>, hints: string[]}}
 */
export function assess(state, now) {
  const signals = []
  const hints = []
  const t = WATCH_THRESHOLDS
  const push = (kind, level, detail) => signals.push({ kind, level, detail })

  // SILENT_STALL — no event of any kind and no tool in flight.
  if (state.running && state.inFlight.length === 0) {
    const silentMs = now - state.lastEventAt
    if (silentMs >= t.silentStallHardMs) push('SILENT_STALL', 'hard', `no event for ${Math.round(silentMs / 1000)}s`)
    else if (silentMs >= t.silentStallSuspectMs) push('SILENT_STALL', 'suspect', `no event for ${Math.round(silentMs / 1000)}s`)
  }

  // TOOL_HANG — the oldest tool call still without a result.
  if (state.running && state.inFlight.length > 0) {
    const oldest = state.inFlight.reduce((min, call) => (call.since < min.since ? call : min), state.inFlight[0])
    const hangMs = now - oldest.since
    if (hangMs >= t.toolHangHardMs) push('TOOL_HANG', 'hard', `${oldest.name} unanswered for ${Math.round(hangMs / 1000)}s`)
    else if (hangMs >= t.toolHangSuspectMs) push('TOOL_HANG', 'suspect', `${oldest.name} unanswered for ${Math.round(hangMs / 1000)}s`)
  }

  // EXECUTOR_DOWN — socket gone during a running turn, or repeated SIDE_PANEL_CLOSED.
  if (state.running && state.executorDownSince !== null) {
    const downMs = now - state.executorDownSince
    const why = !state.uiConnected ? 'side panel disconnected' : !state.toolsConnected ? 'provider disconnected' : `${state.sidePanelClosedStreak} SIDE_PANEL_CLOSED results`
    if (downMs >= t.executorDownHardMs) push('EXECUTOR_DOWN', 'hard', `${why} for ${Math.round(downMs / 1000)}s`)
    else if (downMs >= t.executorDownSuspectMs) push('EXECUTOR_DOWN', 'suspect', `${why} for ${Math.round(downMs / 1000)}s`)
  }

  const events = state.events
  // FAIL_STREAK — consecutive failed results at the tail.
  let failStreak = 0
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].ok) break
    failStreak += 1
  }
  if (failStreak >= t.failStreak) push('FAIL_STREAK', 'suspect', `${failStreak} consecutive failed results`)

  // REPEAT_LOOP — a fingerprint >=3 of the last 8, or <=2 distinct in the last 10.
  const last8 = events.slice(-t.repeatLoopWindow)
  if (last8.length >= t.repeatLoopCount) {
    const counts = new Map()
    for (const event of last8) counts.set(event.fingerprint, (counts.get(event.fingerprint) ?? 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top && top[1] >= t.repeatLoopCount) push('REPEAT_LOOP', 'suspect', `same call ${top[1]} of the last ${last8.length}`)
  }
  const last10 = events.slice(-t.repeatLoopDistinctWindow)
  if (last10.length >= t.repeatLoopDistinctWindow) {
    const distinct = new Set(last10.map(event => event.fingerprint)).size
    if (distinct <= t.repeatLoopDistinctMax) push('REPEAT_LOOP', 'suspect', `only ${distinct} distinct calls in the last ${last10.length}`)
  }

  // SAME_ERROR — one error code >=4 of the last 10 results.
  const last10Results = events.slice(-t.sameErrorWindow)
  const codeCounts = new Map()
  for (const event of last10Results) if (event.code) codeCounts.set(event.code, (codeCounts.get(event.code) ?? 0) + 1)
  const topCode = [...codeCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (topCode && topCode[1] >= t.sameErrorCount) push('SAME_ERROR', 'suspect', `${topCode[0]} ${topCode[1]} of the last ${last10Results.length}`)

  // OBSERVE_ONLY — the last 12 calls are all read-only.
  const last12 = events.slice(-t.observeOnlyWindow)
  if (last12.length >= t.observeOnlyWindow && last12.every(event => event.readOnly)) {
    push('OBSERVE_ONLY', 'suspect', `last ${last12.length} calls are all observation`)
  }

  // NO_EFFECT (V2) — at least 4 of the last 8 ACT results had no visible effect
  // (the provider's NO VISIBLE CHANGE marker). Soft: never alerts alone; brings
  // the judge call forward and corroborates a stuck verdict under two-strike.
  const lastAct = events.filter(event => event.toolClass === 'act').slice(-t.noEffectWindow)
  if (lastAct.length >= t.noEffectCount) {
    const noEffect = lastAct.filter(event => event.noEffect).length
    if (noEffect >= t.noEffectCount) push('NO_EFFECT', 'suspect', `${noEffect} of the last ${lastAct.length} actions had no visible effect`)
  }

  // PLAN_STALLED — open items and no revision for 25 non-plan results or 10 min.
  const openItems = state.plan?.items.filter(item => item.status === 'pending' || item.status === 'in_progress').length ?? 0
  if (state.running && openItems > 0) {
    const sinceRevisionMs = now - state.lastPlanRevisionAt
    if (state.nonPlanResultsSinceRevision >= t.planStalledResults) push('PLAN_STALLED', 'suspect', `${state.nonPlanResultsSinceRevision} results without a plan revision`)
    else if (sinceRevisionMs >= t.planStalledMs) push('PLAN_STALLED', 'suspect', `no plan revision for ${Math.round(sinceRevisionMs / 1000)}s`)
  }

  // REVISIT_HINT (M4) — a soft suspect signal for wander the last-40 window
  // misses. It NEVER alerts alone (like every soft signal): it brings the next
  // judge call forward and corroborates a stuck verdict under the two-strike
  // rule, exactly like PLAN_STALLED. It prioritizes the redo signature — a
  // repeated successful MUTATION with the same outcome across the whole turn —
  // and open items flat/rising while mutations continue. Mere navigation
  // revisits are digest info (aggregates.navRevisits), NOT corroboration, so a
  // faithful re-reading wander does not corroborate a wrong stuck verdict.
  if (state.running && state.aggregates !== undefined) {
    const ag = state.aggregates
    const open = ag.openItems
    const openFlatMs = open.current !== null && open.current > 0 ? now - open.lastDecreaseAt : 0
    const openFlat = open.current !== null && open.current > 0
      && openFlatMs >= WATCH_AGGREGATE_LIMITS.openFlatMs
      && open.okMutationsSinceDecrease >= WATCH_AGGREGATE_LIMITS.openFlatMutations
    if (ag.mutationRevisit) push('REVISIT_HINT', 'suspect', 'a successful mutation repeats with the same outcome across the turn')
    else if (openFlat) push('REVISIT_HINT', 'suspect', `open plan items flat for ${Math.round(openFlatMs / 1000)}s while mutations continue`)
  }

  // WALL_HINT — a wall pattern in recent result text while the agent keeps acting.
  const recentHead = events.slice(-3).map(event => event.head).join('\n')
  if (recentHead && WALL_HINT_PATTERN.test(recentHead)) hints.push('WALL_HINT')

  const level = signals.some(signal => signal.level === 'hard') ? 'hard'
    : signals.length > 0 ? 'suspect' : 'ok'
  return { level, signals, hints }
}
