/**
 * Watcher scheduler (MARATHON-PLAN.md §3.3.4), WITHOUT the judge (M4 wires it).
 *
 * A deterministic tick every 20 s while a turn runs with marathon on. Hard
 * signals from assess() alert immediately, without the model. The alert policy
 * (decideWatch) and the end-of-turn decision (decideEndedIncomplete) are pure
 * functions so every branch is unit-tested with a fake clock.
 *
 * The watcher only reports. It NEVER steers, stops, sends a bridge command,
 * captures, changes ok/label/plan/docsVerification, or triggers a retry. It
 * emits chat.watch frames (the companion also journals them as remote.watch)
 * and an additive per-turn watch summary. Timers are injected for tests and
 * .unref()'d in production so a watcher never keeps the process alive.
 */

import { randomUUID } from 'node:crypto'
import { assess } from './watch-ledger.mjs'

export const WATCH_TICK_MS = 20_000

export const WATCH_ALERT_LIMITS = Object.freeze({
  reAlertMs: 15 * 60_000,
  maxAlertsPerTurn: 3,
  maxPushesPerTurn: 3,
  snoozeMs: 15 * 60_000,
  recoveryOkResults: 3,
})

/** Hard-signal kinds that may alert without the model, in priority order. */
export const HARD_ALERT_KINDS = Object.freeze(['EXECUTOR_DOWN', 'TOOL_HANG', 'SILENT_STALL'])

const ALERT_REASON = Object.freeze({
  SILENT_STALL: 'The agent has gone quiet — no events for several minutes.',
  TOOL_HANG: 'A browser call has not returned for several minutes.',
  EXECUTOR_DOWN: 'The browser executor disconnected while the turn was running.',
  'ended-incomplete': 'The turn ended with work still open or blocked.',
})

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Pure alert policy (§3.3.4). A hard signal alerts immediately; one open alert
 * at a time; a new alert only on a kind change or after reAlertMs with the
 * condition still held; at most maxAlertsPerTurn alerts and maxPushesPerTurn
 * pushes. A snoozed kind ("It's fine") is suppressed until its snooze expires.
 * Recovery (3 successful results including one mutation, or a plan revision)
 * emits a recovered notice and clears the open alert.
 * @param {{
 *   hardKind: string | null,
 *   signals: Array<{kind: string, level: string, detail: string}>,
 *   openAlert: null | {kind: string, at: number, planRevision: number},
 *   recovery: {okResults: number, okMutation: boolean, planRevision: boolean},
 *   snoozedUntil: Record<string, number>,
 *   now: number,
 *   alertsThisTurn: number,
 *   pushesThisTurn: number,
 *   limits?: typeof WATCH_ALERT_LIMITS,
 * }} input
 * @returns {{emit: null | {type: 'alert' | 'recovered', kind: string, reason: string, signals: Array<any>, push: boolean}}}
 */
export function decideWatch(input) {
  const limits = input.limits ?? WATCH_ALERT_LIMITS
  const { hardKind, signals, openAlert, recovery, snoozedUntil, now, alertsThisTurn, pushesThisTurn } = input

  // Recovery first: an open alert clears once the run visibly progresses.
  if (openAlert !== null) {
    const recovered = (recovery.okResults >= limits.recoveryOkResults && recovery.okMutation) || recovery.planRevision
    if (recovered) {
      return { emit: { type: 'recovered', kind: openAlert.kind, reason: 'The agent is making progress again.', signals: [], push: false } }
    }
  }

  if (hardKind === null) return { emit: null }
  if ((snoozedUntil[hardKind] ?? 0) > now) return { emit: null }
  if (alertsThisTurn >= limits.maxAlertsPerTurn) return { emit: null }

  const isNewKind = openAlert === null || openAlert.kind !== hardKind
  const reAlertDue = openAlert !== null && openAlert.kind === hardKind && (now - openAlert.at) >= limits.reAlertMs
  if (!isNewKind && !reAlertDue) return { emit: null }

  const push = pushesThisTurn < limits.maxPushesPerTurn
  return {
    emit: {
      type: 'alert',
      kind: hardKind,
      reason: ALERT_REASON[hardKind] ?? 'The agent may be stuck.',
      signals,
      push,
    },
  }
}

/**
 * Pure end-of-turn decision (§3.3.4). A marathon turn that ends in error, or
 * ends done with no help/confirm wait and an unfinished/blocked plan, a
 * partial/blocked label, or dead-turn text, emits ended-incomplete. A user stop
 * announces nothing.
 * @param {{marathon: boolean, outcome: string, label?: string | null, planOutcome?: string | null, help?: unknown, confirm?: unknown, deadTurn?: boolean}} info
 * @returns {boolean}
 */
export function decideEndedIncomplete(info) {
  if (info.marathon !== true) return false
  if (info.outcome === 'error') return true
  if (info.outcome !== 'done') return false
  if (isRecord(info.help) || isRecord(info.confirm)) return false
  if (info.planOutcome === 'unfinished' || info.planOutcome === 'blocked') return true
  if (info.label === 'partial' || info.label === 'blocked') return true
  return info.deadTurn === true
}

export class Watcher {
  /**
   * @param {{
   *   ledger: import('./watch-ledger.mjs').WatchLedger,
   *   marathonEnabled: () => boolean,
   *   publish: (frame: Record<string, any>) => void,
   *   now?: () => number,
   *   wallNow?: () => number,
   *   setTimer?: (fn: () => void, ms: number) => any,
   *   clearTimer?: (handle: any) => void,
   *   push?: (meta: {type: string, turnId: string | null, kind: string}) => void,
   *   log?: (type: string, data: Record<string, any>, severity?: string) => void,
   *   tickMs?: number,
   *   limits?: typeof WATCH_ALERT_LIMITS,
   * }} options
   */
  constructor(options) {
    this.ledger = options.ledger
    this.marathonEnabled = options.marathonEnabled
    this.publish = options.publish
    this.now = options.now ?? (() => performance.now())
    this.wallNow = options.wallNow ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => { const handle = setInterval(fn, ms); handle.unref?.(); return handle })
    this.clearTimer = options.clearTimer ?? clearInterval
    this.push = options.push ?? (() => {})
    this.log = options.log ?? (() => {})
    this.tickMs = options.tickMs ?? WATCH_TICK_MS
    this.limits = options.limits ?? WATCH_ALERT_LIMITS
    this.timer = null
    this.checks = 0
    this.alertsThisTurn = 0
    this.pushesThisTurn = 0
    /** @type {null | {id: string, kind: string, at: number, planRevision: number, atIso: string}} */
    this.openAlert = null
    /** @type {Record<string, number>} */
    this.snoozedUntil = {}
    this.lastAssessment = { level: 'ok', signals: [], hints: [] }
    this.turnMarathon = false
  }

  start() {
    if (this.timer !== null) return
    this.timer = this.setTimer(() => this.tick(), this.tickMs)
  }

  stop() {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  /** Reset per-turn counters; the ledger is reset separately by the companion. */
  turnStarted({ marathon }) {
    this.checks = 0
    this.alertsThisTurn = 0
    this.pushesThisTurn = 0
    this.openAlert = null
    this.snoozedUntil = {}
    this.lastAssessment = { level: 'ok', signals: [], hints: [] }
    this.turnMarathon = marathon === true
  }

  /** One deterministic tick. Only assesses/alerts while a marathon turn runs. */
  tick() {
    const state = this.ledger.snapshot()
    if (!state.running || !this.marathonEnabled()) return null
    this.checks += 1
    const now = this.now()
    const assessment = assess(state, now)
    this.lastAssessment = assessment
    const hardKind = HARD_ALERT_KINDS.find(kind => assessment.signals.some(signal => signal.kind === kind && signal.level === 'hard')) ?? null

    // Recovery progress since the open alert was raised.
    const recovery = { okResults: 0, okMutation: false, planRevision: false }
    if (this.openAlert !== null) {
      for (const event of state.events) {
        if (event.at <= this.openAlert.at) continue
        if (event.ok) {
          recovery.okResults += 1
          if (!event.readOnly) recovery.okMutation = true
        }
      }
      recovery.planRevision = state.planRevision > this.openAlert.planRevision
    }

    const decision = decideWatch({
      hardKind,
      signals: assessment.signals,
      openAlert: this.openAlert,
      recovery,
      snoozedUntil: this.snoozedUntil,
      now,
      alertsThisTurn: this.alertsThisTurn,
      pushesThisTurn: this.pushesThisTurn,
      limits: this.limits,
    })
    if (decision.emit !== null) this.#emit(decision.emit, state, assessment)
    this.log('watch.tick', { turnId: state.turnId, checks: this.checks, level: assessment.level, hardKind, open: this.openAlert?.kind ?? null })
    return assessment
  }

  #emit(emit, state, assessment) {
    const atIso = new Date(this.wallNow()).toISOString()
    if (emit.type === 'recovered') {
      const previous = this.openAlert
      this.openAlert = null
      this.publish({
        type: 'chat.watch',
        id: previous?.id ?? randomUUID(),
        turnId: state.turnId,
        kind: 'recovered',
        state: 'recovered',
        blocker: null,
        reason: emit.reason,
        signals: [],
        source: 'heuristic',
        at: atIso,
      })
      this.log('watch.recovered', { turnId: state.turnId, kind: previous?.kind ?? null })
      return
    }
    // A new alert (first, kind change, or re-alert).
    this.alertsThisTurn += 1
    const id = randomUUID()
    this.openAlert = { id, kind: emit.kind, at: this.now(), planRevision: state.planRevision, atIso }
    if (emit.push) {
      this.pushesThisTurn += 1
      this.push({ type: 'watch', turnId: state.turnId, kind: emit.kind })
    }
    this.publish({
      type: 'chat.watch',
      id,
      turnId: state.turnId,
      kind: emit.kind,
      state: 'open',
      blocker: emit.kind,
      reason: emit.reason,
      signals: assessment.signals.map(signal => ({ ...signal })),
      source: 'heuristic',
      at: atIso,
    })
    this.log('watch.alert', { turnId: state.turnId, kind: emit.kind, alerts: this.alertsThisTurn, pushes: this.pushesThisTurn, signals: assessment.signals }, 'warn')
  }

  /**
   * "It's fine": dismiss the open alert and snooze its kind for snoozeMs.
   * @param {string} id
   * @returns {{ok: true} | {ok: false, code: string, message: string, retryable: boolean}}
   */
  ack(id) {
    if (this.openAlert === null || this.openAlert.id !== id) {
      return { ok: false, code: 'WATCH_NOT_FOUND', message: 'No watch alert is open on this companion.', retryable: false }
    }
    const kind = this.openAlert.kind
    this.snoozedUntil[kind] = this.now() + this.limits.snoozeMs
    const previous = this.openAlert
    this.openAlert = null
    this.publish({
      type: 'chat.watch',
      id: previous.id,
      turnId: this.ledger.state.turnId,
      kind: 'info',
      state: 'dismissed',
      blocker: null,
      reason: 'Dismissed; this alert kind is snoozed for 15 minutes.',
      signals: [],
      source: 'heuristic',
      at: new Date(this.wallNow()).toISOString(),
    })
    this.log('watch.ack', { turnId: this.ledger.state.turnId, kind })
    return { ok: true }
  }

  /**
   * End of turn: the deterministic ended-incomplete notice plus the per-turn
   * watch summary. Never changes the turn's outcome.
   * @param {{outcome: string, label?: string | null, planOutcome?: string | null, help?: unknown, confirm?: unknown, deadTurn?: boolean}} info
   * @returns {{checks: number, alerts: number, usage: number}}
   */
  turnEnded(info) {
    const state = this.ledger.snapshot()
    const summary = { checks: this.checks, alerts: this.alertsThisTurn, usage: 0 }
    if (decideEndedIncomplete({ ...info, marathon: this.turnMarathon })) {
      this.publish({
        type: 'chat.watch',
        id: randomUUID(),
        turnId: state.turnId,
        kind: 'ended-incomplete',
        state: 'open',
        blocker: 'ended-incomplete',
        reason: ALERT_REASON['ended-incomplete'],
        signals: this.lastAssessment.signals.map(signal => ({ ...signal })),
        source: 'heuristic',
        at: new Date(this.wallNow()).toISOString(),
      })
      this.log('watch.ended_incomplete', { turnId: state.turnId, outcome: info.outcome, planOutcome: info.planOutcome ?? null, label: info.label ?? null }, 'warn')
    }
    this.openAlert = null
    this.ledger.endTurn()
    return summary
  }

  /** The /state projection of the open alert (the independent-check surface). */
  watchProjection() {
    return {
      open: this.openAlert === null ? null : {
        id: this.openAlert.id,
        kind: this.openAlert.kind,
        at: this.openAlert.atIso,
        reason: ALERT_REASON[this.openAlert.kind] ?? 'The agent may be stuck.',
      },
      lastVerdict: null,
      lastCheckAt: this.checks > 0 ? new Date(this.wallNow()).toISOString() : null,
      checks: this.checks,
    }
  }
}
