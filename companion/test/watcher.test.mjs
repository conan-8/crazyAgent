import test from 'node:test'
import assert from 'node:assert/strict'
import { Watcher, decideWatch, decideEndedIncomplete, WATCH_ALERT_LIMITS, WATCH_TICK_MS } from '../watcher.mjs'
import { WatchLedger, WATCH_THRESHOLDS } from '../watch-ledger.mjs'

const LIMITS = WATCH_ALERT_LIMITS

function baseInput(overrides = {}) {
  return {
    hardKind: 'TOOL_HANG',
    signals: [{ kind: 'TOOL_HANG', level: 'hard', detail: 'unanswered' }],
    openAlert: null,
    recovery: { effectfulActs: 0, completedUp: false, signalsAbsentTicks: 0 },
    snoozedUntil: {},
    now: 1_000_000,
    alertsThisTurn: 0,
    pushesThisTurn: 0,
    ...overrides,
  }
}

test('decideWatch: a hard signal with no open alert alerts and pushes', () => {
  const decision = decideWatch(baseInput())
  assert.equal(decision.emit.type, 'alert')
  assert.equal(decision.emit.kind, 'TOOL_HANG')
  assert.equal(decision.emit.push, true)
})

test('decideWatch: no hard signal never alerts', () => {
  assert.equal(decideWatch(baseInput({ hardKind: null })).emit, null)
})

test('decideWatch: a snoozed kind is suppressed', () => {
  assert.equal(decideWatch(baseInput({ snoozedUntil: { TOOL_HANG: 2_000_000 } })).emit, null)
  // Once the snooze expires it may alert again.
  assert.equal(decideWatch(baseInput({ snoozedUntil: { TOOL_HANG: 500_000 } })).emit.type, 'alert')
})

test('decideWatch: the per-turn alert and push budgets hold', () => {
  assert.equal(decideWatch(baseInput({ alertsThisTurn: LIMITS.maxAlertsPerTurn })).emit, null)
  const decision = decideWatch(baseInput({ pushesThisTurn: LIMITS.maxPushesPerTurn }))
  assert.equal(decision.emit.type, 'alert')
  assert.equal(decision.emit.push, false, 'alert still shows, but no push past the budget')
})

test('decideWatch: same kind waits for reAlertMs; a kind change alerts at once', () => {
  const openAlert = { kind: 'TOOL_HANG', at: 1_000_000, planRevision: 0 }
  assert.equal(decideWatch(baseInput({ openAlert, now: 1_000_000 + LIMITS.reAlertMs - 1 })).emit, null)
  assert.equal(decideWatch(baseInput({ openAlert, now: 1_000_000 + LIMITS.reAlertMs })).emit.type, 'alert')
  assert.equal(decideWatch(baseInput({ openAlert, hardKind: 'EXECUTOR_DOWN', now: 1_000_001 })).emit.type, 'alert')
})

test('decideWatch: V2 recovery needs >=2 effectful acts AND signals absent 2 ticks, OR completed-count up', () => {
  const openAlert = { kind: 'TOOL_HANG', at: 0, planRevision: 0 }
  // 1 effectful act (even with signals absent 2 ticks) is not enough.
  assert.equal(decideWatch(baseInput({ openAlert, hardKind: null, recovery: { effectfulActs: 1, completedUp: false, signalsAbsentTicks: 2 } })).emit, null)
  // 2 effectful acts but signals absent only 1 tick is not enough.
  assert.equal(decideWatch(baseInput({ openAlert, hardKind: null, recovery: { effectfulActs: 2, completedUp: false, signalsAbsentTicks: 1 } })).emit, null)
  // 2 effectful acts AND signals absent 2 ticks -> recovered (even if a hard signal still shows this tick).
  const recovered = decideWatch(baseInput({ openAlert, hardKind: 'TOOL_HANG', recovery: { effectfulActs: 2, completedUp: false, signalsAbsentTicks: 2 } }))
  assert.equal(recovered.emit.type, 'recovered')
  assert.equal(recovered.emit.push, false)
  // Completed count up alone recovers (no effectful acts / absent ticks needed).
  const byCompleted = decideWatch(baseInput({ openAlert, hardKind: null, recovery: { effectfulActs: 0, completedUp: true, signalsAbsentTicks: 0 } }))
  assert.equal(byCompleted.emit.type, 'recovered')
  // Effectful acts without signals absent (signals still present) is not recovery.
  assert.equal(decideWatch(baseInput({ openAlert, hardKind: null, recovery: { effectfulActs: 3, completedUp: false, signalsAbsentTicks: 0 } })).emit, null)
  // A plan revision alone (completedUp false) is NOT recovery anymore.
  assert.equal(decideWatch(baseInput({ openAlert, hardKind: null, recovery: { effectfulActs: 0, completedUp: false, signalsAbsentTicks: 5 } })).emit, null)
})

test('decideEndedIncomplete follows the plan table', () => {
  assert.equal(decideEndedIncomplete({ marathon: false, outcome: 'error' }), false)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'error' }), true)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'stopped' }), false)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'done', help: { category: 'login', reason: 'x' } }), false)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'done', confirm: { action: 'x', target: 'y' } }), false)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'done', planOutcome: 'unfinished' }), true)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'done', planOutcome: 'blocked' }), true)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'done', label: 'partial' }), true)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'done', label: 'blocked' }), true)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'done', deadTurn: true }), true)
  assert.equal(decideEndedIncomplete({ marathon: true, outcome: 'done', label: 'done', planOutcome: 'reported-complete' }), false)
})

/* ------------------------------------------------------------------ */
/* Scheduler with an injected clock and timers                         */
/* ------------------------------------------------------------------ */

function harness({ marathon = true } = {}) {
  let now = 0
  const frames = []
  const pushes = []
  const logs = []
  let enabled = marathon
  const ledger = new WatchLedger({ now: () => now })
  let tickFn = null
  const watcher = new Watcher({
    ledger,
    marathonEnabled: () => enabled,
    publish: frame => frames.push(frame),
    now: () => now,
    wallNow: () => 1_700_000_000_000 + now,
    setTimer: fn => { tickFn = fn; return 1 },
    clearTimer: () => { tickFn = null },
    push: meta => pushes.push(meta),
    log: (type, data, severity) => logs.push({ type, data, severity }),
  })
  watcher.start()
  ledger.startTurn({ turnId: 'turn-1', prompt: 'long task', marathon })
  watcher.turnStarted({ marathon })
  return {
    watcher, ledger, frames, pushes, logs,
    advance: ms => { now += ms },
    tick: () => tickFn(),
    setMarathon: value => { enabled = value },
    call: (callId, name = 'browser_click', args = { label: 1 }) => ledger.noteFrame({ type: 'chat.tool_call', callId, name, args }),
    result: (callId, ok = true, text = 'clicked') => ledger.noteFrame({ type: 'chat.tool_result', callId, ok, text }),
  }
}

test('the scheduler alerts on a hard signal within one tick and pushes once', () => {
  const h = harness()
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  h.tick()
  const alerts = h.frames.filter(frame => frame.type === 'chat.watch' && frame.state === 'open')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'TOOL_HANG')
  assert.equal(alerts[0].source, 'heuristic')
  assert.equal(h.pushes.length, 1)
  assert.equal(h.watcher.checks, 1)
  assert.equal(h.watcher.watchProjection().open.kind, 'TOOL_HANG')
})

test('the scheduler does not re-alert before reAlertMs, then re-alerts, capped at 3', () => {
  const h = harness()
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  h.tick()
  h.advance(WATCH_TICK_MS)
  h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.state === 'open').length, 1, 'no re-alert yet')
  h.advance(LIMITS.reAlertMs)
  h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.state === 'open').length, 2)
  h.advance(LIMITS.reAlertMs)
  h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.state === 'open').length, 3)
  h.advance(LIMITS.reAlertMs)
  h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.state === 'open').length, 3, 'capped at 3 alerts')
  assert.equal(h.pushes.length, 3, 'capped at 3 pushes')
})

test('recovery emits a recovered notice after >=2 effectful acts AND signals absent 2 ticks', () => {
  const h = harness()
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  h.tick()
  h.result('hang')
  h.advance(1_000)
  for (let i = 0; i < 3; i += 1) { h.call(`ok${i}`, 'browser_click', { label: i }); h.result(`ok${i}`) }
  // First tick with the hang signal absent: absentTicks=1, not yet recovered.
  h.advance(WATCH_TICK_MS)
  h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'recovered').length, 0, 'one absent tick is not enough')
  assert.equal(h.watcher.watchProjection().open?.kind, 'TOOL_HANG')
  // Second consecutive absent tick: absentTicks=2 + 3 effectful acts -> recovered.
  h.advance(WATCH_TICK_MS)
  h.tick()
  const recovered = h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'recovered')
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].state, 'recovered')
  assert.equal(h.watcher.watchProjection().open, null)
})

test('V2: no-effect acts do not recover an alert; a completed plan item does', () => {
  const h = harness()
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  h.tick()
  h.result('hang')
  h.advance(1_000)
  // 4 ok acts but all NO VISIBLE CHANGE: no effectful acts -> no recovery.
  for (let i = 0; i < 4; i += 1) { h.call(`ne${i}`, 'browser_click', { label: i }); h.result(`ne${i}`, true, 'result: NO VISIBLE CHANGE — the page did not change') }
  h.advance(WATCH_TICK_MS); h.tick()
  h.advance(WATCH_TICK_MS); h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'recovered').length, 0, 'no-effect acts are not progress')
  assert.equal(h.watcher.watchProjection().open?.kind, 'TOOL_HANG')
  // A plan item completes -> completed count up -> recovery (even without effectful acts).
  h.ledger.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 2, items: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] })
  h.advance(WATCH_TICK_MS); h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'recovered').length, 1, 'completed count up recovers')
  assert.equal(h.watcher.watchProjection().open, null)
})

test('V2: a plan revision alone (no completion) does not recover an alert', () => {
  const h = harness()
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  h.tick()
  h.result('hang')
  h.advance(1_000)
  // Revision bumps but no item completes; marking blocked is not progress.
  h.ledger.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 2, items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'blocked' }] })
  h.advance(WATCH_TICK_MS); h.tick()
  h.advance(WATCH_TICK_MS); h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'recovered').length, 0, 'revision/blocked is not recovery')
  assert.equal(h.watcher.watchProjection().open?.kind, 'TOOL_HANG')
})

test('ack dismisses the alert, snoozes the kind, and suppresses re-alerts', () => {
  const h = harness()
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  h.tick()
  const id = h.watcher.watchProjection().open.id
  assert.deepEqual(h.watcher.ack(id), { ok: true })
  assert.equal(h.watcher.watchProjection().open, null)
  const dismissed = h.frames.filter(f => f.type === 'chat.watch' && f.state === 'dismissed')
  assert.equal(dismissed.length, 1)
  // Still within the 15-minute snooze: the same hard kind must not re-alert.
  h.advance(WATCH_TICK_MS)
  h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.state === 'open').length, 1, 'snoozed kind does not re-alert')
  const unknown = h.watcher.ack('unknown-id')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'WATCH_NOT_FOUND')
})

test('a kind change alerts immediately even with an open alert', () => {
  const h = harness()
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  h.tick()
  h.ledger.setConnectivity({ uiConnected: false, toolsConnected: true })
  h.advance(WATCH_THRESHOLDS.executorDownHardMs)
  h.tick()
  const open = h.frames.filter(f => f.type === 'chat.watch' && f.state === 'open')
  assert.equal(open.length, 2)
  assert.equal(open[1].kind, 'EXECUTOR_DOWN')
})

test('turnEnded emits ended-incomplete and the additive watch summary', () => {
  const h = harness()
  h.advance(WATCH_TICK_MS)
  h.tick()
  const summary = h.watcher.turnEnded({ outcome: 'done', label: 'done', planOutcome: 'unfinished' })
  assert.deepEqual(summary, { checks: 1, alerts: 0, usage: 0 })
  const ended = h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'ended-incomplete')
  assert.equal(ended.length, 1)
  assert.equal(h.ledger.snapshot().running, false)
})

test('a clean marathon turn ends without an ended-incomplete notice', () => {
  const h = harness()
  const summary = h.watcher.turnEnded({ outcome: 'done', label: 'done', planOutcome: 'reported-complete' })
  assert.deepEqual(summary, { checks: 0, alerts: 0, usage: 0 })
  assert.equal(h.frames.filter(f => f.type === 'chat.watch').length, 0)
})

test('W2: non-marathon turns are watched for mid-turn stalls, while ended-incomplete stays marathon-only', () => {
  const h = harness({ marathon: false })
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  const assessment = h.tick()
  assert.equal(assessment.level, 'hard')
  assert.equal(h.watcher.checks, 1)
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'TOOL_HANG' && f.state === 'open').length, 1)
  assert.equal(h.watcher.turnEnded({ outcome: 'done', planOutcome: 'unfinished' }).alerts, 1)
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'ended-incomplete').length, 0, 'ended-incomplete stays marathon-only')
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.state === 'closed').length, 1, 'open alert closes on turn end')
})

test('W2: turning marathon off mid-turn keeps watching the running turn', () => {
  const h = harness({ marathon: true })
  h.setMarathon(false)
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  h.tick()
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.state === 'open').length, 1, 'watching stays active when marathon toggles off')
})

test('stop() clears the timer', () => {
  const h = harness()
  assert.equal(typeof h.tick, 'function')
  h.watcher.stop()
  assert.equal(h.watcher.timer, null)
})

/* ------------------------------------------------------------------ */
/* V1 alert lifecycle (§3.2): explicit close frames, one open notice   */
/* ------------------------------------------------------------------ */

function openHardAlert(h) {
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs)
  h.tick()
  return h.watcher.watchProjection().open
}

test('V1: turn end closes an open mid-turn alert with its own id (Turn ended.)', () => {
  const h = harness()
  const alert = openHardAlert(h)
  h.watcher.turnEnded({ outcome: 'done', label: 'done', planOutcome: 'reported-complete' })
  const closed = h.frames.filter(f => f.type === 'chat.watch' && f.state === 'closed')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].id, alert.id, 'the close frame carries the alert OWN id')
  assert.equal(closed[0].kind, 'info')
  assert.equal(closed[0].reason, 'Turn ended.')
  assert.equal(closed[0].turnId, 'turn-1')
  assert.equal(h.watcher.watchProjection().open, null, 'no stale open alert after turn end')
  assert.equal(h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'ended-incomplete').length, 0)
})

test('V1: ended-incomplete supersedes the mid-turn alert (closed same step, one open notice)', () => {
  const h = harness()
  const alert = openHardAlert(h)
  h.watcher.turnEnded({ outcome: 'done', label: 'partial', planOutcome: 'unfinished' })
  const watch = h.frames.filter(f => f.type === 'chat.watch')
  const closed = watch.filter(f => f.state === 'closed')
  const ended = watch.filter(f => f.kind === 'ended-incomplete' && f.state === 'open')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].id, alert.id, 'the mid-turn alert is closed in the same step')
  assert.equal(ended.length, 1, 'ended-incomplete becomes the one open notice')
  assert.ok(watch.indexOf(closed[0]) < watch.indexOf(ended[0]), 'close precedes the ended-incomplete open frame')
  const open = h.watcher.watchProjection().open
  assert.equal(open.kind, 'ended-incomplete')
  assert.equal(open.id, ended[0].id)
  assert.equal(h.watcher.openAlert, null, 'only one open notice')
})

test('V1: It\'s fine on ended-incomplete returns 200, closes it, no snooze', () => {
  const h = harness()
  openHardAlert(h)
  h.watcher.turnEnded({ outcome: 'done', label: 'partial', planOutcome: 'unfinished' })
  const id = h.watcher.watchProjection().open.id
  const result = h.watcher.ack(id)
  assert.equal(result.ok, true)
  const dismissed = h.frames.filter(f => f.type === 'chat.watch' && f.state === 'dismissed')
  assert.equal(dismissed.length, 1)
  assert.equal(dismissed[0].id, id)
  assert.equal(h.watcher.watchProjection().open, null)
  assert.deepEqual(h.watcher.snoozedUntil, {}, 'no snooze for ended-incomplete')
  assert.equal(h.watcher.ack(id).code, 'WATCH_NOT_FOUND', 'already closed')
})

test('V1: closeEndedIncomplete closes the remembered notice before a new turn', () => {
  const h = harness()
  h.watcher.turnEnded({ outcome: 'done', label: 'partial', planOutcome: 'unfinished' })
  const id = h.watcher.watchProjection().open.id
  assert.equal(h.watcher.closeEndedIncomplete('A new turn started.'), true)
  const closed = h.frames.filter(f => f.type === 'chat.watch' && f.state === 'closed')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].id, id)
  assert.equal(closed[0].reason, 'A new turn started.')
  assert.equal(h.watcher.watchProjection().open, null)
  assert.equal(h.watcher.closeEndedIncomplete('A new turn started.'), false, 'nothing left to close')
})

test('V1: a clean turn end with no open alert emits no close frame', () => {
  const h = harness()
  h.watcher.turnEnded({ outcome: 'done', label: 'done', planOutcome: 'reported-complete' })
  assert.equal(h.frames.filter(f => f.type === 'chat.watch').length, 0)
  assert.equal(h.watcher.watchProjection().open, null)
})

test('V1: clearNotices clears both open notices (marathon off / new / switch)', () => {
  const h = harness()
  openHardAlert(h)
  assert.equal(h.watcher.watchProjection().open.kind, 'TOOL_HANG')
  h.watcher.clearNotices()
  assert.equal(h.watcher.watchProjection().open, null)
  assert.equal(h.watcher.openAlert, null)
  assert.equal(h.watcher.openEndedIncomplete, null)
  // ended-incomplete path too
  h.watcher.turnEnded({ outcome: 'done', label: 'partial', planOutcome: 'unfinished' })
  assert.equal(h.watcher.watchProjection().open.kind, 'ended-incomplete')
  h.watcher.clearNotices()
  assert.equal(h.watcher.watchProjection().open, null)
})

test('V1: mid-turn ack still snoozes the kind (unchanged behavior)', () => {
  const h = harness()
  const alert = openHardAlert(h)
  const result = h.watcher.ack(alert.id)
  assert.equal(result.ok, true)
  assert.ok(h.watcher.snoozedUntil.TOOL_HANG > 0, 'mid-turn alert ack snoozes')
  assert.equal(h.watcher.watchProjection().open, null)
})
