import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchLedger, assess, WATCH_THRESHOLDS, READ_ONLY_TOOLS, toolFingerprint, resultCode } from '../watch-ledger.mjs'

/** A fake monotonic clock the test advances by hand. */
function clock() {
  let now = 0
  return { now: () => now, advance: ms => { now += ms }, set: ms => { now = ms } }
}

function ledger(t = clock()) {
  const l = new WatchLedger({ now: t.now })
  l.startTurn({ turnId: 'turn-1', prompt: 'do the long task', marathon: true })
  return l
}

function call(l, callId, name = 'browser_click', args = { label: 1 }) {
  l.noteFrame({ type: 'chat.tool_call', callId, name, args })
}
function result(l, callId, { ok = true, text = 'clicked', name } = {}) {
  l.noteFrame({ type: 'chat.tool_result', callId, ok, text, ...(name ? { name } : {}) })
}
function kinds(assessment) {
  return assessment.signals.map(signal => `${signal.kind}:${signal.level}`)
}

test('a fresh turn assesses ok and the ledger records the prompt', () => {
  const t = clock()
  const l = ledger(t)
  assert.deepEqual(assess(l.snapshot(), t.now()), { level: 'ok', signals: [], hints: [] })
  assert.equal(l.snapshot().prompt, 'do the long task')
  assert.equal(l.snapshot().running, true)
})

test('SILENT_STALL: suspect at 120s, hard at 300s, and never while a call is in flight', () => {
  const t = clock()
  const l = ledger(t)
  t.advance(WATCH_THRESHOLDS.silentStallSuspectMs - 1)
  assert.equal(assess(l.snapshot(), t.now()).level, 'ok')
  t.advance(1)
  assert.deepEqual(kinds(assess(l.snapshot(), t.now())), ['SILENT_STALL:suspect'])
  t.advance(WATCH_THRESHOLDS.silentStallHardMs - WATCH_THRESHOLDS.silentStallSuspectMs - 1)
  assert.equal(assess(l.snapshot(), t.now()).signals[0].level, 'suspect')
  t.advance(1)
  assert.deepEqual(kinds(assess(l.snapshot(), t.now())), ['SILENT_STALL:hard'])
  // Any event resets the silence; an in-flight call is not silence.
  const l2 = ledger(t)
  call(l2, 'c1')
  t.advance(WATCH_THRESHOLDS.silentStallHardMs + 10_000)
  assert.ok(!kinds(assess(l2.snapshot(), t.now())).some(k => k.startsWith('SILENT_STALL')))
})

test('TOOL_HANG: suspect at 90s, hard at 240s; a result clears it', () => {
  const t = clock()
  const l = ledger(t)
  call(l, 'c1', 'browser_wait_for')
  t.advance(WATCH_THRESHOLDS.toolHangSuspectMs - 1)
  assert.equal(assess(l.snapshot(), t.now()).level, 'ok')
  t.advance(1)
  assert.deepEqual(kinds(assess(l.snapshot(), t.now())), ['TOOL_HANG:suspect'])
  t.advance(WATCH_THRESHOLDS.toolHangHardMs - WATCH_THRESHOLDS.toolHangSuspectMs)
  assert.deepEqual(kinds(assess(l.snapshot(), t.now())), ['TOOL_HANG:hard'])
  result(l, 'c1')
  assert.equal(assess(l.snapshot(), t.now()).level, 'ok')
})

test('EXECUTOR_DOWN: socket gone suspect at 30s, hard at 120s; reconnect clears', () => {
  const t = clock()
  const l = ledger(t)
  l.setConnectivity({ uiConnected: false, toolsConnected: true })
  const down = () => assess(l.snapshot(), t.now()).signals.filter(s => s.kind === 'EXECUTOR_DOWN')
  t.advance(WATCH_THRESHOLDS.executorDownSuspectMs - 1)
  assert.equal(down().length, 0)
  t.advance(1)
  assert.deepEqual(down().map(s => s.level), ['suspect'])
  t.advance(WATCH_THRESHOLDS.executorDownHardMs - WATCH_THRESHOLDS.executorDownSuspectMs)
  assert.deepEqual(down().map(s => s.level), ['hard'])
  assert.equal(assess(l.snapshot(), t.now()).level, 'hard')
  l.setConnectivity({ uiConnected: true, toolsConnected: true })
  assert.equal(down().length, 0, 'reconnect clears the executor signal')
})

test('EXECUTOR_DOWN: two SIDE_PANEL_CLOSED results trigger it without a socket drop', () => {
  const t = clock()
  const l = ledger(t)
  call(l, 'c1'); result(l, 'c1', { ok: false, text: 'SIDE_PANEL_CLOSED: panel gone' })
  assert.equal(assess(l.snapshot(), t.now()).level, 'ok', 'one is not enough')
  call(l, 'c2'); result(l, 'c2', { ok: false, text: 'SIDE_PANEL_CLOSED: panel gone' })
  t.advance(WATCH_THRESHOLDS.executorDownSuspectMs)
  assert.deepEqual(kinds(assess(l.snapshot(), t.now())), ['EXECUTOR_DOWN:suspect'])
  // A successful result resets the streak.
  call(l, 'c3'); result(l, 'c3', { ok: true })
  assert.ok(!kinds(assess(l.snapshot(), t.now())).some(k => k.startsWith('EXECUTOR_DOWN')))
})

test('FAIL_STREAK: five consecutive failures suspect, an ok resets', () => {
  const t = clock()
  const l = ledger(t)
  // Distinct args and codes so REPEAT_LOOP / SAME_ERROR do not also fire.
  const fail = i => { call(l, `c${i}`, 'browser_click', { label: i }); result(l, `c${i}`, { ok: false, text: `ERR_${i}: failed` }) }
  for (let i = 0; i < 4; i += 1) fail(i)
  assert.ok(!kinds(assess(l.snapshot(), t.now())).includes('FAIL_STREAK:suspect'))
  fail(4)
  assert.ok(kinds(assess(l.snapshot(), t.now())).includes('FAIL_STREAK:suspect'))
  call(l, 'c5', 'browser_click', { label: 5 }); result(l, 'c5', { ok: true })
  assert.ok(!kinds(assess(l.snapshot(), t.now())).includes('FAIL_STREAK:suspect'))
})

test('REPEAT_LOOP: a fingerprint 3 of the last 8, or <=2 distinct in the last 10', () => {
  const t = clock()
  const l = ledger(t)
  // Three identical calls among the last eight.
  for (let i = 0; i < 3; i += 1) { call(l, `a${i}`, 'browser_click', { label: 7 }); result(l, `a${i}`) }
  for (let i = 0; i < 3; i += 1) { call(l, `b${i}`, 'browser_scroll', { direction: i }); result(l, `b${i}`) }
  assert.ok(kinds(assess(l.snapshot(), t.now())).includes('REPEAT_LOOP:suspect'))
  // Ten calls with only two distinct fingerprints.
  const l2 = ledger(t)
  for (let i = 0; i < 10; i += 1) {
    const name = i % 2 === 0 ? 'browser_click' : 'browser_read_text'
    call(l2, `d${i}`, name, { label: 1 }); result(l2, `d${i}`)
  }
  assert.ok(kinds(assess(l2.snapshot(), t.now())).includes('REPEAT_LOOP:suspect'))
})

test('SAME_ERROR: one code 4 of the last 10 results', () => {
  const t = clock()
  const l = ledger(t)
  for (let i = 0; i < 3; i += 1) { call(l, `e${i}`); result(l, `e${i}`, { ok: false, text: 'AMBIGUOUS_VIEW: many' }) }
  assert.ok(!kinds(assess(l.snapshot(), t.now())).includes('SAME_ERROR:suspect'))
  call(l, 'e3'); result(l, 'e3', { ok: false, text: 'AMBIGUOUS_VIEW: many' })
  assert.ok(kinds(assess(l.snapshot(), t.now())).includes('SAME_ERROR:suspect'))
})

test('OBSERVE_ONLY: twelve read-only calls suspect; a mutation breaks it', () => {
  const t = clock()
  const l = ledger(t)
  const readOnly = [...READ_ONLY_TOOLS]
  for (let i = 0; i < 11; i += 1) { call(l, `o${i}`, readOnly[i % readOnly.length]); result(l, `o${i}`) }
  assert.ok(!kinds(assess(l.snapshot(), t.now())).includes('OBSERVE_ONLY:suspect'))
  call(l, 'o11', 'browser_screenshot'); result(l, 'o11')
  assert.ok(kinds(assess(l.snapshot(), t.now())).includes('OBSERVE_ONLY:suspect'))
  call(l, 'm1', 'browser_click'); result(l, 'm1')
  assert.ok(!kinds(assess(l.snapshot(), t.now())).includes('OBSERVE_ONLY:suspect'))
})

test('PLAN_STALLED: open items + 25 non-plan results, or 10 minutes without a revision', () => {
  const t = clock()
  const l = ledger(t)
  l.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 1, items: [{ content: 'Step', status: 'in_progress' }] })
  for (let i = 0; i < 24; i += 1) { call(l, `p${i}`, 'browser_click', { label: i }); result(l, `p${i}`) }
  assert.ok(!kinds(assess(l.snapshot(), t.now())).includes('PLAN_STALLED:suspect'))
  call(l, 'p24', 'browser_click', { label: 99 }); result(l, 'p24')
  assert.ok(kinds(assess(l.snapshot(), t.now())).includes('PLAN_STALLED:suspect'))
  // A revision resets the result counter.
  l.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 2, items: [{ content: 'Step', status: 'in_progress' }] })
  assert.ok(!kinds(assess(l.snapshot(), t.now())).includes('PLAN_STALLED:suspect'))
  // The time path: 10 minutes without a revision.
  const l2 = ledger(t)
  l2.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 1, items: [{ content: 'Step', status: 'pending' }] })
  t.advance(WATCH_THRESHOLDS.planStalledMs)
  assert.ok(kinds(assess(l2.snapshot(), t.now())).includes('PLAN_STALLED:suspect'))
  // A completed-only plan never stalls.
  const l3 = ledger(t)
  l3.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 1, items: [{ content: 'Step', status: 'completed' }] })
  t.advance(WATCH_THRESHOLDS.planStalledMs + 1000)
  assert.ok(!kinds(assess(l3.snapshot(), t.now())).includes('PLAN_STALLED:suspect'))
})

test('WALL_HINT is a hint only and never raises the level', () => {
  const t = clock()
  const l = ledger(t)
  call(l, 'w1'); result(l, 'w1', { ok: false, text: 'Please sign in to continue' })
  const assessment = assess(l.snapshot(), t.now())
  assert.deepEqual(assessment.hints, ['WALL_HINT'])
  assert.equal(assessment.level, 'ok')
})

test('hard outranks suspect; the ledger keeps only the last 40 events', () => {
  const t = clock()
  const l = ledger(t)
  call(l, 'hang', 'browser_wait_for')
  for (let i = 0; i < 5; i += 1) { call(l, `f${i}`); result(l, `f${i}`, { ok: false, text: 'STALE_VIEW: x' }) }
  t.advance(WATCH_THRESHOLDS.toolHangHardMs)
  const assessment = assess(l.snapshot(), t.now())
  assert.equal(assessment.level, 'hard')
  assert.ok(kinds(assessment).includes('TOOL_HANG:hard'))
  assert.ok(kinds(assessment).includes('FAIL_STREAK:suspect'))
  for (let i = 0; i < 60; i += 1) { call(l, `x${i}`, 'browser_scroll', { direction: i }); result(l, `x${i}`) }
  assert.equal(l.snapshot().events.length, 40)
})

test('fingerprint is order-independent and resultCode parses leading codes', () => {
  assert.equal(toolFingerprint('browser_click', { a: 1, b: 2 }), toolFingerprint('browser_click', { b: 2, a: 1 }))
  assert.notEqual(toolFingerprint('browser_click', { a: 1 }), toolFingerprint('browser_click', { a: 2 }))
  assert.equal(resultCode('STALE_VIEW: drifted'), 'STALE_VIEW')
  assert.equal(resultCode('refused AMBIGUOUS_VIEW: many'), 'AMBIGUOUS_VIEW')
  assert.equal(resultCode('clicked the button'), null)
})

test('the ledger runs for non-marathon turns too and ends cleanly', () => {
  const t = clock()
  const l = new WatchLedger({ now: t.now })
  l.startTurn({ turnId: 'turn-plain', prompt: 'quick', marathon: false })
  assert.equal(l.snapshot().marathon, false)
  call(l, 'c1'); result(l, 'c1')
  l.noteFrame({ type: 'chat.done', text: 'ok' })
  assert.equal(l.snapshot().running, false)
  // Frames after the turn ends are ignored.
  call(l, 'c2')
  assert.equal(l.snapshot().events.length, 1)
})
