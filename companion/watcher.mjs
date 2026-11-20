/**
 * Watcher scheduler (MARATHON-PLAN.md §3.3.4) with the model judge (M4).
 *
 * A deterministic tick every 20 s while a turn runs with marathon on. Hard
 * signals from assess() alert immediately, without the model — the judge can
 * never veto them. The judge (companion/watch-judge.mjs) adds soft, semantic
 * opinion on a cadence: first call 4 min into the turn, then every 6 min with
 * ±15% jitter, growing to 10 min after two consecutive `progressing` verdicts
 * and returning to 4 min on any other verdict; a suspect assessment brings a
 * call forward when ≥90 s have passed since the last one. A per-turn budget
 * (40 calls / 150k input tokens) falls back to deterministic-only with one
 * notice; HTTP 429/timeout skips a check and doubles the next interval once.
 *
 * A judge verdict of stuck/blocked with confidence ≥0.6 alerts ONLY with the
 * two-strike rule: a deterministic signal is also present, or the previous
 * verdict was also not progressing. A single unsupported model opinion never
 * alerts.
 *
 * The alert policy (decideWatch) and the end-of-turn decision
 * (decideEndedIncomplete) are pure functions so every branch is unit-tested
 * with a fake clock. The watcher only reports. It NEVER steers, stops, sends a
 * bridge command, captures, changes ok/label/plan/docsVerification, or triggers
 * a retry. It emits chat.watch frames (the companion also journals them as
 * remote.watch) and an additive per-turn watch summary. Judge usage is reported
 * separately from the agent's usage. Timers are injected for tests and
 * .unref()'d in production so a watcher never keeps the process alive.
 */

import { randomUUID } from 'node:crypto'
import { assess } from './watch-ledger.mjs'
import { buildDigest, sanitizeWatchSteer, WALL_BLOCKERS, WALL_STEER_FALLBACK } from './watch-judge.mjs'

export const WATCH_TICK_MS = 20_000

export const WATCH_ALERT_LIMITS = Object.freeze({
  reAlertMs: 15 * 60_000,
  maxAlertsPerTurn: 3,
  maxPushesPerTurn: 3,
  snoozeMs: 15 * 60_000,
  // V2 (§3.3): recovery needs evidence — >=2 effectful act results since the
  // alert AND the alert's own signals absent 2 consecutive ticks; OR the plan
  // completed count rose. A plan revision alone or marking blocked never counts.
  recoveryEffectfulActs: 2,
  recoveryAbsentTicks: 2,
})

/** Judge cadence and budget (W2 proactive 2-3 min cadence). Injected/overridable for tests. */
export const WATCH_JUDGE_LIMITS = Object.freeze({
  firstCallMs: 2 * 60_000,
  routineMs: 3 * 60_000,
  calmMs: 5 * 60_000,
  alertMs: 2 * 60_000,
  jitter: 0.15,
  triggerFloorMs: 90_000,
  maxCallsPerTurn: 40,
  maxInputTokensPerTurn: 150_000,
  progressingStreakForCalm: 2,
  confidenceAlertMin: 0.6,
  previousVerdictsKept: 6,
})

/** Bounded advisory in-turn steering limits (W3). Injected/overridable for tests. */
export const WATCH_STEER_LIMITS = Object.freeze({
  maxSteersPerTurn: 2,
  cooldownMs: 3 * 60_000,
  confidenceSteerMin: 0.65,
})

const STEER_FALLBACK_TEXT = 'Stop repeating the same failing or no-effect approach. Inspect what is blocking progress, try a different control or strategy, or call agent_request_help / report BLOCKED if you need the user.'

/**
 * Pure advisory steer decision (W3). Never fires on hard stalls (a hung tool
 * or dead socket cannot be fixed by an in-turn message), never fires without
 * two-strike corroboration, respects snooze ("It's fine"), per-turn cap, and
 * cooldown.
 * @param {{
 *   autoSteerEnabled: boolean,
 *   hardKind: string | null,
 *   verdict: {state: string, confidence: number, blocker: string | null, reason: string, steer?: string | null},
 *   corroborated: boolean,
 *   snoozedUntil: Record<string, number>,
 *   now: number,
 *   steersThisTurn: number,
 *   lastSteerAt: number,
 *   limits?: typeof WATCH_STEER_LIMITS,
 * }} input
 * @returns {null | {text: string, kind: string, blocker: string | null}}
 */
export function decideWatchSteer(input) {
  const limits = input.limits ?? WATCH_STEER_LIMITS
  if (input.autoSteerEnabled !== true) return null
  if (input.hardKind !== null) return null
  if (input.corroborated !== true) return null
  const verdict = input.verdict
  if (!verdict || (verdict.state !== 'stuck' && verdict.state !== 'blocked')) return null
  if (typeof verdict.confidence !== 'number' || verdict.confidence < limits.confidenceSteerMin) return null
  if ((input.snoozedUntil[verdict.state] ?? 0) > input.now) return null
  if (input.steersThisTurn >= limits.maxSteersPerTurn) return null
  if (input.lastSteerAt > 0 && (input.now - input.lastSteerAt) < limits.cooldownMs) return null
  const sanitized = sanitizeWatchSteer(verdict.steer, { state: verdict.state, blocker: verdict.blocker ?? null })
  const text = sanitized
    ?? (verdict.blocker !== null && WALL_BLOCKERS.has(verdict.blocker) ? WALL_STEER_FALLBACK : STEER_FALLBACK_TEXT)
  return { text, kind: verdict.state, blocker: verdict.blocker ?? null }
}

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
 * Pure alert policy (§3.3.4). A hard signal alerts immediately; a judge verdict
 * (judgeKind) alerts only when passed in (the caller applies the two-strike
 * rule). One open alert at a time; a new alert only on a kind change or after
 * reAlertMs with the condition still held; at most maxAlertsPerTurn alerts and
 * maxPushesPerTurn pushes. A snoozed kind ("It's fine") is suppressed until its
 * snooze expires. Recovery (3 successful results including one mutation, or a
 * plan revision) emits a recovered notice and clears the open alert.
 * @param {{
 *   hardKind: string | null,
 *   judgeKind?: string | null,
 *   judgeReason?: string,
 *   judgeBlocker?: string | null,
 *   judgeSource?: 'watcher' | 'both',
 *   signals: Array<{kind: string, level: string, detail: string}>,
 *   openAlert: null | {kind: string, at: number, planRevision: number},
 *   recovery: {effectfulActs: number, completedUp: boolean, signalsAbsentTicks: number},
 *   snoozedUntil: Record<string, number>,
 *   now: number,
 *   alertsThisTurn: number,
 *   pushesThisTurn: number,
 *   limits?: typeof WATCH_ALERT_LIMITS,
 * }} input
 * @returns {{emit: null | {type: 'alert' | 'recovered', kind: string, reason: string, signals: Array<any>, push: boolean, source?: string, blocker?: string | null}}}
 */
export function decideWatch(input) {
  const limits = input.limits ?? WATCH_ALERT_LIMITS
  const { hardKind, signals, openAlert, recovery, snoozedUntil, now, alertsThisTurn, pushesThisTurn } = input
  const judgeKind = input.judgeKind ?? null

  // Recovery first (V2): an open alert clears only on evidence of progress —
  // >=2 effectful act results since the alert AND its own signals absent for 2
  // consecutive ticks, OR the plan completed count rose since the alert. A plan
  // revision alone, or marking items blocked, is not progress.
  if (openAlert !== null) {
    const recovered = (recovery.effectfulActs >= limits.recoveryEffectfulActs && recovery.signalsAbsentTicks >= limits.recoveryAbsentTicks) || recovery.completedUp
    if (recovered) {
      return { emit: { type: 'recovered', kind: openAlert.kind, reason: 'The agent is making progress again.', signals: [], push: false } }
    }
  }

  // Hard deterministic signals alert immediately; the judge can never veto them.
  const kind = hardKind !== null ? hardKind : judgeKind
  if (kind === null) return { emit: null }
  if ((snoozedUntil[kind] ?? 0) > now) return { emit: null }
  if (alertsThisTurn >= limits.maxAlertsPerTurn) return { emit: null }

  const isNewKind = openAlert === null || openAlert.kind !== kind
  const reAlertDue = openAlert !== null && openAlert.kind === kind && (now - openAlert.at) >= limits.reAlertMs
  if (!isNewKind && !reAlertDue) return { emit: null }

  const push = pushesThisTurn < limits.maxPushesPerTurn
  if (hardKind !== null) {
    return {
      emit: {
        type: 'alert',
        kind: hardKind,
        reason: ALERT_REASON[hardKind] ?? 'The agent may be stuck.',
        signals,
        push,
        source: 'heuristic',
        blocker: hardKind,
      },
    }
  }
  return {
    emit: {
      type: 'alert',
      kind: judgeKind,
      reason: input.judgeReason ?? 'The agent may be stuck.',
      signals,
      push,
      source: input.judgeSource ?? 'watcher',
      blocker: input.judgeBlocker ?? null,
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
   *   judge?: ReturnType<import('./watch-judge.mjs').createWatchJudge> | null,
   *   now?: () => number,
   *   wallNow?: () => number,
   *   setTimer?: (fn: () => void, ms: number) => any,
   *   clearTimer?: (handle: any) => void,
   *   push?: (meta: {type: string, turnId: string | null, kind: string}) => void,
   *   log?: (type: string, data: Record<string, any>, severity?: string) => void,
   *   random?: () => number,
   *   tickMs?: number,
   *   limits?: typeof WATCH_ALERT_LIMITS,
   *   judgeLimits?: typeof WATCH_JUDGE_LIMITS,
   * }} options
   */
  constructor(options) {
    this.ledger = options.ledger
    this.marathonEnabled = options.marathonEnabled
    this.publish = options.publish
    this.judge = options.judge ?? null
    this.now = options.now ?? (() => performance.now())
    this.wallNow = options.wallNow ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => { const handle = setInterval(fn, ms); handle.unref?.(); return handle })
    this.clearTimer = options.clearTimer ?? clearInterval
    this.push = options.push ?? (() => {})
    this.log = options.log ?? (() => {})
    this.random = options.random ?? Math.random
    this.tickMs = options.tickMs ?? WATCH_TICK_MS
    this.limits = options.limits ?? WATCH_ALERT_LIMITS
    this.judgeLimits = options.judgeLimits ?? WATCH_JUDGE_LIMITS
    this.steerLimits = options.steerLimits ?? WATCH_STEER_LIMITS
    this.onSteer = typeof options.onSteer === 'function' ? options.onSteer : null
    this.autoSteerEnabled = typeof options.autoSteerEnabled === 'function'
      ? options.autoSteerEnabled
      : (() => this.onSteer !== null)
    this.timer = null
    this.checks = 0
    this.alertsThisTurn = 0
    this.pushesThisTurn = 0
    this.steersThisTurn = 0
    this.lastSteerAt = 0
    /** @type {null | {id: string, kind: string, at: number, planRevision: number, atIso: string, reason: string}} */
    this.openAlert = null
    /**
     * V1: the open `ended-incomplete` notice remembered after a turn ends, until
     * the next turn start (or an ack). One open notice invariant: a mid-turn
     * alert and an ended-incomplete notice are never open at the same time.
     * @type {null | {id: string, kind: string, turnId: string | null, atIso: string, reason: string}}
     */
    this.openEndedIncomplete = null
    /** @type {Record<string, number>} */
    this.snoozedUntil = {}
    this.lastAssessment = { level: 'ok', signals: [], hints: [] }
    this.turnMarathon = false
    /** The authoritative ended-incomplete decision for the last turn end (M3). */
    this.lastEndedIncomplete = false
    // Judge per-turn state (reset in turnStarted).
    this.judgeCalls = 0
    this.judgeSkipped = 0
    this.judgeInputTokens = 0
    this.judgeOutputTokens = 0
    this.judgeReasoningTokens = 0
    this.judgeCacheReadTokens = 0
    this.judgeLastCallAt = 0
    this.nextJudgeAt = 0
    this.judgeIntervalMs = this.judgeLimits.routineMs
    this.progressingStreak = 0
    /** @type {Array<{at: number, state: string, confidence: number, blocker: string | null}>} */
    this.previousVerdicts = []
    this.lastVerdict = null
    this.lastJudgeCheckWallAt = null
    this.judgeInFlight = false
    this.judgePending = null
    this.budgetExhausted = false
    this.budgetNoticeEmitted = false
    this.backoffUntil = 0
    /** @type {Set<string>} */
    this.lastJudgeSignals = new Set()
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
  turnStarted({ marathon, carry = null }) {
    this.checks = 0
    this.alertsThisTurn = 0
    this.pushesThisTurn = 0
    this.steersThisTurn = 0
    this.lastSteerAt = 0
    this.openAlert = null
    this.snoozedUntil = {}
    this.lastAssessment = { level: 'ok', signals: [], hints: [] }
    this.turnMarathon = marathon === true
    // V4 (§3.5, G2): internal carry context for the judge digest (ancestor prompts
    // + marathon carried-plan revision when seeded). Never published to clients.
    this.carryContext = carry
    this.lastEndedIncomplete = false
    const at = this.now()
    this.judgeCalls = 0
    this.judgeSkipped = 0
    this.judgeInputTokens = 0
    this.judgeOutputTokens = 0
    this.judgeReasoningTokens = 0
    this.judgeCacheReadTokens = 0
    this.judgeLastCallAt = at
    this.nextJudgeAt = at + this.judgeLimits.firstCallMs
    this.judgeIntervalMs = this.judgeLimits.routineMs
    this.progressingStreak = 0
    this.previousVerdicts = []
    this.lastVerdict = null
    this.lastJudgeCheckWallAt = null
    this.judgeInFlight = false
    this.judgePending = null
    this.budgetExhausted = false
    this.budgetNoticeEmitted = false
    this.backoffUntil = 0
    /** @type {Set<string>} */
    this.lastJudgeSignals = new Set()
  }

  /** Await the in-flight judge call (tests/replay); a no-op when idle. */
  settleJudge() {
    return this.judgePending ?? Promise.resolve()
  }

  /** One deterministic tick. Watches every running turn (normal and marathon). */
  tick() {
    const state = this.ledger.snapshot()
    if (!state.running) return null
    this.checks += 1
    const now = this.now()
    const assessment = assess(state, now)
    this.lastAssessment = assessment
    // V2: track how many consecutive ticks the open alert's own signals have
    // been absent (recovery needs >=2 alongside effectful actions).
    if (this.openAlert !== null) {
      const kinds = this.openAlert.signalKinds ?? []
      const present = assessment.signals.some(signal => kinds.includes(signal.kind))
      this.openAlert.absentTicks = present ? 0 : (this.openAlert.absentTicks ?? 0) + 1
    }
    const hardKind = HARD_ALERT_KINDS.find(kind => assessment.signals.some(signal => signal.kind === kind && signal.level === 'hard')) ?? null

    const decision = decideWatch({
      hardKind,
      signals: assessment.signals,
      openAlert: this.openAlert,
      recovery: this.#recoverySince(state),
      snoozedUntil: this.snoozedUntil,
      now,
      alertsThisTurn: this.alertsThisTurn,
      pushesThisTurn: this.pushesThisTurn,
      limits: this.limits,
    })
    if (decision.emit !== null) this.#emit(decision.emit, state, assessment)
    this.#maybeJudge(state, assessment, now)
    this.log('watch.tick', { turnId: state.turnId, checks: this.checks, level: assessment.level, hardKind, open: this.openAlert?.kind ?? null })
    return assessment
  }

  /** Recovery evidence since the open alert was raised (V2 §3.3). */
  #recoverySince(state) {
    const recovery = { effectfulActs: 0, completedUp: false, signalsAbsentTicks: 0 }
    if (this.openAlert !== null) {
      recovery.effectfulActs = Math.max(0, (state.okEffectfulActCount ?? 0) - (this.openAlert.effectfulActCountAtAlert ?? 0))
      recovery.completedUp = (state.planCompletedCount ?? 0) > (this.openAlert.completedCountAtAlert ?? 0)
      recovery.signalsAbsentTicks = this.openAlert.absentTicks ?? 0
    }
    return recovery
  }

  /** Decide whether a judge call is due now (routine cadence or suspect trigger). */
  #maybeJudge(state, assessment, now) {
    if (this.judge === null || this.judgeInFlight) return
    if (this.judgeCalls >= this.judgeLimits.maxCallsPerTurn || this.judgeInputTokens >= this.judgeLimits.maxInputTokensPerTurn) {
      if (!this.budgetExhausted) {
        this.budgetExhausted = true
        this.log('watch.judge.budget', { turnId: state.turnId, calls: this.judgeCalls, inputTokens: this.judgeInputTokens })
      }
      // The budget notice is informational. Every client shows the latest notice
      // (the panel chip, the phone card, /state marathon.watch.open), so while an
      // alert is open the notice would hide it; it waits until no alert is open.
      if (!this.budgetNoticeEmitted && this.openAlert === null) {
        this.budgetNoticeEmitted = true
        this.publish({
          type: 'chat.watch',
          id: randomUUID(),
          turnId: state.turnId,
          kind: 'info',
          state: 'open',
          blocker: null,
          reason: 'Judge budget spent for this turn; watching with deterministic signals only.',
          signals: [],
          source: 'heuristic',
          at: new Date(this.wallNow()).toISOString(),
        })
      }
      return
    }
    if (now < this.backoffUntil) return
    const dueRoutine = now >= this.nextJudgeAt
    // W2 smart suspect gating: bring a judge call forward early when a suspect
    // assessment arrives after the trigger floor ONLY if this is the first
    // judge check, the previous verdict was not progressing, or a new suspect
    // signal kind appeared since the last judge check. Prevents healthy long
    // runs with one lingering benign signal from firing every 60s and burning
    // the per-turn input budget.
    const signalKinds = assessment.signals.map(signal => signal.kind)
    const suspectEscalated = this.judgeCalls === 0
      || this.lastVerdict !== 'progressing'
      || signalKinds.some(kind => !this.lastJudgeSignals.has(kind))
    const dueTrigger = assessment.level === 'suspect'
      && suspectEscalated
      && (now - this.judgeLastCallAt) >= this.judgeLimits.triggerFloorMs
    if (!dueRoutine && !dueTrigger) return
    this.#startJudgeCall(state, assessment, now, dueRoutine ? 'routine' : 'trigger')
  }

  #startJudgeCall(state, assessment, now, trigger) {
    this.judgeInFlight = true
    this.lastJudgeSignals = new Set(assessment.signals.map(signal => signal.kind))
    const turnId = state.turnId
    const callAt = now
    const digest = buildDigest(state, now, { signals: assessment.signals, hints: assessment.hints, previousVerdicts: this.previousVerdicts, carry: this.carryContext ?? null })
    this.log('watch.judge.start', { turnId, trigger, elapsedSec: Math.round((now - state.turnStartAt) / 1000), events: digest.events.length, signals: digest.signals })
    const promise = this.judge.check({ turnId, digest }).then(result => {
      this.judgeInFlight = false
      this.judgePending = null
      const current = this.ledger.snapshot()
      // A result for a turn that has ended (or changed) is discarded.
      if (!current.running || current.turnId !== turnId) {
        this.log('watch.judge.discard', { turnId, status: result.status })
        return
      }
      this.#applyJudgeResult(result, callAt, trigger)
    }, error => {
      this.judgeInFlight = false
      this.judgePending = null
      this.log('watch.judge.error', { turnId, message: String(error?.message ?? error).slice(0, 120) }, 'warn')
    })
    this.judgePending = promise
  }

  #scheduleNextJudge(callAt, intervalMs) {
    const factor = 1 + this.judgeLimits.jitter * (2 * this.random() - 1)
    this.nextJudgeAt = callAt + Math.round(intervalMs * factor)
  }

  #applyJudgeResult(result, callAt, trigger) {
    const now = this.now()
    const state = this.ledger.snapshot()
    this.judgeCalls += 1
    this.judgeInputTokens += result.usage.inputTokens
    this.judgeOutputTokens += result.usage.outputTokens
    this.judgeReasoningTokens += result.usage.reasoningTokens
    this.judgeCacheReadTokens += result.usage.cacheReadTokens
    this.judgeLastCallAt = callAt
    this.lastJudgeCheckWallAt = new Date(this.wallNow()).toISOString()

    const status = result.status
    if (status === 'rate-limited' || status === 'timeout') {
      // Skip the check; double the next interval once (no trigger spam meanwhile).
      this.judgeSkipped += 1
      this.backoffUntil = callAt + 2 * this.judgeIntervalMs
      this.nextJudgeAt = this.backoffUntil
      this.log('watch.judge.skip', { turnId: state.turnId, status, backoffMs: 2 * this.judgeIntervalMs })
      return
    }
    if (status !== 'ok') {
      this.judgeSkipped += 1
      this.#scheduleNextJudge(callAt, this.judgeIntervalMs)
      this.log('watch.judge.skip', { turnId: state.turnId, status })
      return
    }

    const verdict = result.verdict
    this.lastVerdict = verdict.state
    const previous = this.previousVerdicts.length > 0 ? this.previousVerdicts[this.previousVerdicts.length - 1] : null
    this.previousVerdicts.push({ at: callAt, state: verdict.state, confidence: verdict.confidence, blocker: verdict.blocker })
    if (this.previousVerdicts.length > this.judgeLimits.previousVerdictsKept) this.previousVerdicts.shift()

    if (verdict.state === 'progressing') {
      this.progressingStreak += 1
      this.judgeIntervalMs = this.progressingStreak >= this.judgeLimits.progressingStreakForCalm ? this.judgeLimits.calmMs : this.judgeLimits.routineMs
    } else {
      this.progressingStreak = 0
      this.judgeIntervalMs = this.judgeLimits.alertMs
    }
    this.#scheduleNextJudge(callAt, this.judgeIntervalMs)
    this.log('watch.judge.verdict', { turnId: state.turnId, trigger, state: verdict.state, confidence: verdict.confidence, blocker: verdict.blocker, intervalMs: this.judgeIntervalMs, calls: this.judgeCalls })

    // Two-strike alert rule: a single unsupported model opinion never alerts.
    if ((verdict.state === 'stuck' || verdict.state === 'blocked') && verdict.confidence >= this.judgeLimits.confidenceAlertMin) {
      const assessment = assess(state, now)
      const deterministicSupport = assessment.signals.length > 0
      const previousSupport = previous !== null && previous.state !== 'progressing'
      if (deterministicSupport || previousSupport) {
        const hardKind = HARD_ALERT_KINDS.find(kind => assessment.signals.some(signal => signal.kind === kind && signal.level === 'hard')) ?? null
        let appliedSteer = null
        if (this.onSteer !== null) {
          const steerDecision = decideWatchSteer({
            autoSteerEnabled: this.autoSteerEnabled() === true,
            hardKind,
            verdict,
            corroborated: true,
            snoozedUntil: this.snoozedUntil,
            now,
            steersThisTurn: this.steersThisTurn,
            lastSteerAt: this.lastSteerAt,
            limits: this.steerLimits,
          })
          if (steerDecision !== null) {
            const steerId = randomUUID()
            const sent = this.onSteer({
              turnId: state.turnId,
              steerId,
              text: steerDecision.text,
              kind: steerDecision.kind,
              blocker: steerDecision.blocker,
              reason: verdict.reason,
            }) === true
            if (sent) {
              this.steersThisTurn += 1
              this.lastSteerAt = now
              appliedSteer = { id: steerId, text: steerDecision.text }
              this.log('watch.steer', {
                turnId: state.turnId,
                steerId,
                kind: steerDecision.kind,
                blocker: steerDecision.blocker,
                steers: this.steersThisTurn,
                textChars: steerDecision.text.length,
              }, 'info')
            } else {
              this.log('watch.steer.skipped', { turnId: state.turnId, steerId, reason: 'bridge-not-delivered' }, 'warn')
            }
          }
        }
        const decision = decideWatch({
          hardKind,
          judgeKind: hardKind === null ? verdict.state : null,
          judgeReason: verdict.reason,
          judgeBlocker: verdict.blocker,
          judgeSource: deterministicSupport ? 'both' : 'watcher',
          signals: assessment.signals,
          openAlert: this.openAlert,
          recovery: this.#recoverySince(state),
          snoozedUntil: this.snoozedUntil,
          now,
          alertsThisTurn: this.alertsThisTurn,
          pushesThisTurn: this.pushesThisTurn,
          limits: this.limits,
        })
        if (decision.emit !== null) {
          this.#emit(decision.emit, state, assessment, appliedSteer)
        } else if (appliedSteer !== null && this.openAlert !== null) {
          // A follow-up auto-steer fired while the alert was already open:
          // surface it transparently on the open alert so no steer is hidden.
          this.openAlert.steer = appliedSteer
          this.publish({
            type: 'chat.watch',
            id: this.openAlert.id,
            turnId: state.turnId,
            kind: this.openAlert.kind,
            state: 'open',
            blocker: verdict.blocker ?? this.openAlert.kind,
            reason: verdict.reason || this.openAlert.reason,
            signals: assessment.signals.map(signal => ({ ...signal })),
            source: deterministicSupport ? 'both' : 'watcher',
            steer: appliedSteer,
            at: new Date(this.wallNow()).toISOString(),
          })
        }
      } else {
        this.log('watch.judge.suppressed', { turnId: state.turnId, state: verdict.state, confidence: verdict.confidence })
      }
    }
  }

  #emit(emit, state, assessment, steer = null) {
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
    const reason = emit.reason
    this.openAlert = {
      id, kind: emit.kind, at: this.now(), planRevision: state.planRevision, atIso, reason,
      ...(steer !== null ? { steer } : {}),
      // V2 recovery baseline: effectful-act and completed counts at alert time,
      // the alert's own signal kinds, and the consecutive-absent tick counter.
      effectfulActCountAtAlert: state.okEffectfulActCount ?? 0,
      completedCountAtAlert: state.planCompletedCount ?? 0,
      signalKinds: [...new Set((emit.signals ?? []).map(signal => signal.kind))],
      absentTicks: 0,
    }
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
      blocker: emit.blocker ?? emit.kind,
      reason,
      signals: assessment.signals.map(signal => ({ ...signal })),
      source: emit.source ?? 'heuristic',
      ...(steer !== null ? { steer } : {}),
      at: atIso,
    })
    this.log('watch.alert', { turnId: state.turnId, kind: emit.kind, source: emit.source ?? 'heuristic', alerts: this.alertsThisTurn, pushes: this.pushesThisTurn, steered: steer !== null, signals: assessment.signals }, 'warn')
  }

  /**
   * "It's fine": dismiss the open alert and snooze its kind for snoozeMs.
   * @param {string} id
   * @returns {{ok: true} | {ok: false, code: string, message: string, retryable: boolean}}
   */
  ack(id) {
    if (this.openAlert !== null && this.openAlert.id === id) {
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
    // V1: "It's fine" on the remembered ended-incomplete notice closes it (200).
    // No snooze — there is no next tick to suppress.
    if (this.openEndedIncomplete !== null && this.openEndedIncomplete.id === id) {
      const previous = this.openEndedIncomplete
      this.openEndedIncomplete = null
      this.publish({
        type: 'chat.watch',
        id: previous.id,
        turnId: previous.turnId,
        kind: 'info',
        state: 'dismissed',
        blocker: null,
        reason: 'Dismissed.',
        signals: [],
        source: 'heuristic',
        at: new Date(this.wallNow()).toISOString(),
      })
      this.log('watch.ack', { turnId: previous.turnId, kind: 'ended-incomplete' })
      return { ok: true }
    }
    return { ok: false, code: 'WATCH_NOT_FOUND', message: 'No watch alert is open on this companion.', retryable: false }
  }

  /**
   * End of turn: abort any in-flight judge call, emit the deterministic
   * ended-incomplete notice, and return the per-turn watch summary. Judge usage
   * is reported separately from the agent's usage. Never changes the outcome.
   * @param {{outcome: string, label?: string | null, planOutcome?: string | null, help?: unknown, confirm?: unknown, deadTurn?: boolean}} info
   * @returns {{checks: number, alerts: number, usage: number}}
   */
  turnEnded(info) {
    const state = this.ledger.snapshot()
    if (this.judge !== null) this.judge.abort(state.turnId)
    this.judgeInFlight = false
    const summary = { checks: this.checks, alerts: this.alertsThisTurn, usage: this.judgeInputTokens + this.judgeOutputTokens }
    const endedIncomplete = decideEndedIncomplete({ ...info, marathon: this.turnMarathon })
    this.lastEndedIncomplete = endedIncomplete
    // V1: an open mid-turn alert is closed with an explicit frame carrying its
    // OWN id, so every client collapses the row it shows. If ended-incomplete
    // fires it supersedes the alert: the alert closes in this same step and
    // ended-incomplete becomes the one open notice.
    if (this.openAlert !== null) {
      this.#closeNotice(this.openAlert.id, state.turnId, 'Turn ended.')
      this.openAlert = null
    }
    if (endedIncomplete) {
      const notice = {
        id: randomUUID(),
        kind: 'ended-incomplete',
        turnId: state.turnId,
        atIso: new Date(this.wallNow()).toISOString(),
        reason: ALERT_REASON['ended-incomplete'],
      }
      this.openEndedIncomplete = notice
      this.publish({
        type: 'chat.watch',
        id: notice.id,
        turnId: notice.turnId,
        kind: 'ended-incomplete',
        state: 'open',
        blocker: 'ended-incomplete',
        reason: notice.reason,
        signals: this.lastAssessment.signals.map(signal => ({ ...signal })),
        source: 'heuristic',
        at: notice.atIso,
      })
      this.log('watch.ended_incomplete', { turnId: state.turnId, outcome: info.outcome, planOutcome: info.planOutcome ?? null, label: info.label ?? null }, 'warn')
    }
    this.log('watch.judge.summary', {
      turnId: state.turnId,
      calls: this.judgeCalls,
      skipped: this.judgeSkipped,
      steers: this.steersThisTurn,
      inputTokens: this.judgeInputTokens,
      outputTokens: this.judgeOutputTokens,
      reasoningTokens: this.judgeReasoningTokens,
      cacheReadTokens: this.judgeCacheReadTokens,
      budgetExhausted: this.budgetExhausted,
    })
    this.ledger.endTurn()
    return summary
  }

  /**
   * V1: publish an explicit close frame for a notice (its own id), so every
   * client collapses the row. `closed` is treated like `dismissed` downstream.
   * @param {string} id @param {string | null} turnId @param {string} reason
   */
  #closeNotice(id, turnId, reason) {
    this.publish({
      type: 'chat.watch',
      id,
      turnId,
      kind: 'info',
      state: 'closed',
      blocker: null,
      reason,
      signals: [],
      source: 'heuristic',
      at: new Date(this.wallNow()).toISOString(),
    })
  }

  /**
   * V1: close any open ended-incomplete notice at the start of a new turn,
   * BEFORE the new turn's first frame. Called by the controller's #begin.
   * @param {string} reason
   */
  closeEndedIncomplete(reason) {
    if (this.openEndedIncomplete === null) return false
    const notice = this.openEndedIncomplete
    this.openEndedIncomplete = null
    this.#closeNotice(notice.id, notice.turnId, reason)
    this.log('watch.ended_incomplete.closed', { turnId: notice.turnId, reason })
    return true
  }

  /**
   * V1: clear all open notices without a frame (/new, a real chat switch).
   */
  clearNotices() {
    this.openAlert = null
    this.openEndedIncomplete = null
  }

  /** Clear only a marathon-specific ended-incomplete notice (when marathon turns off). */
  clearEndedIncomplete() {
    this.openEndedIncomplete = null
  }

  /** The /state projection of the open notice (the independent-check surface). */
  watchProjection() {
    // V1: one open notice — a mid-turn alert, or the remembered ended-incomplete.
    const notice = this.openAlert ?? this.openEndedIncomplete
    return {
      open: notice === null ? null : {
        id: notice.id,
        kind: notice.kind,
        at: notice.atIso,
        reason: notice.reason ?? ALERT_REASON[notice.kind] ?? 'The agent may be stuck.',
        ...(notice.steer ? { steer: { ...notice.steer } } : {}),
      },
      lastVerdict: this.lastVerdict,
      lastCheckAt: this.lastJudgeCheckWallAt ?? (this.checks > 0 ? new Date(this.wallNow()).toISOString() : null),
      checks: this.checks,
    }
  }
}
