import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchLedger, assess, WATCH_THRESHOLDS, READ_ONLY_TOOLS, CONTROL_TOOLS, toolClass, toolFingerprint, resultCode, parsePageKey, parseControlName, pageKeyPath } from '../watch-ledger.mjs'

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

/* ------------------------------------------------------------------ */
/* V2 tool classes (§3.3): observe / control / act                     */
/* ------------------------------------------------------------------ */

test('V2: toolClass classifies observe, control, and act', () => {
  for (const name of READ_ONLY_TOOLS) assert.equal(toolClass(name), 'observe', name)
  for (const name of CONTROL_TOOLS) assert.equal(toolClass(name), 'control', name)
  assert.equal(toolClass('browser_click'), 'act')
  assert.equal(toolClass('browser_navigate'), 'act')
  assert.equal(toolClass('browser_type'), 'act')
  assert.equal(toolClass('browser_docs_edit'), 'act')
})

test('V2: control results are excluded from the event window and mutation counters', () => {
  const t = clock()
  const l = ledger(t)
  call(l, 'p1', 'browser_plan', { items: [] }); result(l, 'p1', { text: 'plan updated' })
  call(l, 'h1', 'agent_request_help', {}); result(l, 'h1', { text: 'help requested' })
  call(l, 'cf1', 'agent_request_confirmation', {}); result(l, 'cf1', { text: 'confirmation requested' })
  const s = l.snapshot()
  assert.equal(s.events.length, 0, 'control results not in the event window')
  assert.equal(s.eventCount, 0)
  assert.equal(s.aggregates.okMutations, 0, 'control ok is not a mutation')
  assert.equal(s.nonPlanResultsSinceRevision, 0, 'control excluded from PLAN_STALLED counter')
  // An act result still counts.
  call(l, 'a1', 'browser_click'); result(l, 'a1', { text: 'clicked label 1: button "Go"' })
  assert.equal(l.snapshot().events.length, 1)
  assert.equal(l.snapshot().events[0].toolClass, 'act')
  assert.equal(l.snapshot().aggregates.okMutations, 1)
})

test('V2: an ok observe result is not a mutation; an ok act result is', () => {
  const t = clock()
  const l = ledger(t)
  call(l, 'o1', 'browser_read_text'); result(l, 'o1', { text: 'page text' })
  assert.equal(l.snapshot().aggregates.okMutations, 0)
  assert.equal(l.snapshot().events[0].toolClass, 'observe')
  call(l, 'a1', 'browser_click'); result(l, 'a1', { text: 'clicked' })
  assert.equal(l.snapshot().aggregates.okMutations, 1)
})

test('V2: control failures neither count toward nor break FAIL_STREAK', () => {
  const t = clock()
  // 4 act failures + 1 control failure: the control failure is invisible, so the
  // act tail streak is 4 (< 5) — control does NOT count toward the streak.
  const l = ledger(t)
  for (let i = 0; i < 4; i += 1) { call(l, `a${i}`, 'browser_click'); result(l, `a${i}`, { ok: false, text: 'STALE_VIEW: nope' }) }
  call(l, 'p1', 'browser_plan'); result(l, 'p1', { ok: false, text: 'PLAN_INVALID: bad' })
  assert.ok(!kinds(assess(l.snapshot(), t.now())).some(k => k.startsWith('FAIL_STREAK')), 'control failure does not count (streak 4)')
  // 2 act failures + control failure + 3 act failures: control does NOT break the
  // streak, so the 5 act failures are consecutive in the event window -> fires.
  const l2 = ledger(t)
  for (let i = 0; i < 2; i += 1) { call(l2, `b${i}`, 'browser_click'); result(l2, `b${i}`, { ok: false, text: 'STALE_VIEW: nope' }) }
  call(l2, 'p2', 'browser_plan'); result(l2, 'p2', { ok: false, text: 'PLAN_INVALID: bad' })
  for (let i = 0; i < 3; i += 1) { call(l2, `c${i}`, 'browser_click'); result(l2, `c${i}`, { ok: false, text: 'STALE_VIEW: nope' }) }
  assert.ok(kinds(assess(l2.snapshot(), t.now())).some(k => k.startsWith('FAIL_STREAK')), 'control failure does not break the act streak (5)')
  // 5 consecutive ACT failures (no control) fire FAIL_STREAK.
  const l3 = ledger(t)
  for (let i = 0; i < 5; i += 1) { call(l3, `d${i}`, 'browser_click'); result(l3, `d${i}`, { ok: false, text: 'STALE_VIEW: nope' }) }
  assert.ok(kinds(assess(l3.snapshot(), t.now())).some(k => k.startsWith('FAIL_STREAK')))
})

test('V2: a PLAN_* error is plan friction, not SAME_ERROR browser stuck', () => {
  const t = clock()
  const l = ledger(t)
  for (let i = 0; i < 5; i += 1) { call(l, `p${i}`, 'browser_plan'); result(l, `p${i}`, { ok: false, text: 'PLAN_INVALID: bad items' }) }
  const assessment = assess(l.snapshot(), t.now())
  assert.ok(!kinds(assessment).some(k => k.startsWith('SAME_ERROR')), 'control errors excluded from SAME_ERROR')
  assert.equal(l.snapshot().events.length, 0)
})

test('V2: plan activity still feeds the snapshot even though browser_plan results are excluded', () => {
  const t = clock()
  const l = ledger(t)
  call(l, 'p1', 'browser_plan'); result(l, 'p1', { text: 'plan updated' })
  l.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 1, items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] })
  const s = l.snapshot()
  assert.equal(s.plan.revision, 1)
  assert.equal(s.plan.items.length, 2)
  assert.equal(s.events.length, 0, 'the browser_plan tool result itself is still excluded')
})

test('V2: OBSERVE_ONLY fires on observe-only act window; control does not mask it', () => {
  const t = clock()
  const l = ledger(t)
  for (let i = 0; i < 12; i += 1) {
    call(l, `o${i}`, 'browser_read_text'); result(l, `o${i}`, { text: 'page text' })
    if (i % 3 === 0) { call(l, `p${i}`, 'browser_plan'); result(l, `p${i}`, { text: 'plan updated' }) }
  }
  const assessment = assess(l.snapshot(), t.now())
  assert.ok(kinds(assessment).some(k => k.startsWith('OBSERVE_ONLY')), 'control calls do not count as progress against OBSERVE_ONLY')
})

/* ------------------------------------------------------------------ */
/* V2 no-effect predicate, NO_EFFECT signal, effectful recovery basis  */
/* ------------------------------------------------------------------ */

import { noProgressResultText } from '../../packages/dsh-browser-extension/lib/repeat-guards.js'

test('V2: the shared no-progress predicate matches NO VISIBLE CHANGE (case-insensitive)', () => {
  assert.equal(noProgressResultText('result: NO VISIBLE CHANGE — the pixels did not change'), true)
  assert.equal(noProgressResultText('no visible change'), true)
  assert.equal(noProgressResultText('clicked label 1: button "Go"'), false)
  assert.equal(noProgressResultText(''), false)
  assert.equal(noProgressResultText(null), false)
  assert.equal(noProgressResultText(undefined), false)
})

test('V2: noEffect flags ok act results with the marker; not observe/control/failed', () => {
  const t = clock()
  const l = ledger(t)
  call(l, 'a1', 'browser_click'); result(l, 'a1', { text: 'result: NO VISIBLE CHANGE — the page did not change' })
  call(l, 'a2', 'browser_click'); result(l, 'a2', { text: 'clicked label 1: button "Go"' })
  call(l, 'a3', 'browser_click'); result(l, 'a3', { ok: false, text: 'NO VISIBLE CHANGE' })
  call(l, 'o1', 'browser_read_text'); result(l, 'o1', { text: 'NO VISIBLE CHANGE' })
  const events = l.snapshot().events
  assert.equal(events[0].noEffect, true, 'ok act with marker is no-effect')
  assert.equal(events[1].noEffect, false, 'ok act without marker is effectful')
  assert.equal(events[2].noEffect, false, 'a failed act is not no-effect (it is a failure)')
  assert.equal(events[3].noEffect, false, 'observe is never no-effect')
})

test('V2: okEffectfulActCount counts ok effectful acts only', () => {
  const t = clock()
  const l = ledger(t)
  call(l, 'a1', 'browser_click'); result(l, 'a1', { text: 'clicked label 1' })
  call(l, 'a2', 'browser_click'); result(l, 'a2', { text: 'NO VISIBLE CHANGE — nope' })
  call(l, 'a3', 'browser_type'); result(l, 'a3', { text: 'typed into field' })
  call(l, 'o1', 'browser_read_text'); result(l, 'o1', { text: 'page text' })
  call(l, 'p1', 'browser_plan'); result(l, 'p1', { text: 'plan updated' })
  call(l, 'a4', 'browser_click'); result(l, 'a4', { ok: false, text: 'STALE_VIEW' })
  assert.equal(l.snapshot().okEffectfulActCount, 2, 'a1 + a3 effectful; a2 no-effect, o1 observe, p1 control, a4 failed')
})

test('V2: NO_EFFECT fires at >=4 of last 8 act results no-effect (soft, never hard)', () => {
  const t = clock()
  const l = ledger(t)
  // 3 no-effect acts: below threshold.
  for (let i = 0; i < 3; i += 1) { call(l, `n${i}`, 'browser_click'); result(l, `n${i}`, { text: 'NO VISIBLE CHANGE — nope' }) }
  assert.ok(!kinds(assess(l.snapshot(), t.now())).some(k => k.startsWith('NO_EFFECT')), '3 no-effect is below threshold')
  // 4th no-effect act: fires suspect.
  call(l, 'n3', 'browser_click'); result(l, 'n3', { text: 'NO VISIBLE CHANGE — nope' })
  const a = assess(l.snapshot(), t.now())
  assert.ok(kinds(a).some(k => k === 'NO_EFFECT:suspect'), '4 of last 8 act no-effect fires NO_EFFECT suspect')
  assert.equal(a.level, 'suspect', 'NO_EFFECT never alerts alone (no hard)')
})

test('V2: NO_EFFECT counts only act results; effectful acts dilute the window', () => {
  const t = clock()
  const l = ledger(t)
  // 4 no-effect + 4 effectful acts in the last 8 -> 4 no-effect still fires.
  for (let i = 0; i < 4; i += 1) { call(l, `n${i}`, 'browser_click'); result(l, `n${i}`, { text: 'NO VISIBLE CHANGE' }) }
  for (let i = 0; i < 4; i += 1) { call(l, `e${i}`, 'browser_click'); result(l, `e${i}`, { text: 'clicked label 1' }) }
  assert.ok(kinds(assess(l.snapshot(), t.now())).some(k => k.startsWith('NO_EFFECT')), '4 of last 8')
  // One more effectful act pushes a no-effect out of the last-8 window -> 3 -> clears.
  call(l, 'e9', 'browser_click'); result(l, 'e9', { text: 'clicked label 2' })
  assert.ok(!kinds(assess(l.snapshot(), t.now())).some(k => k.startsWith('NO_EFFECT')), '3 of last 8 clears')
  // Observe/control results never count toward NO_EFFECT.
  const l2 = ledger(t)
  for (let i = 0; i < 8; i += 1) { call(l2, `o${i}`, 'browser_read_text'); result(l2, `o${i}`, { text: 'NO VISIBLE CHANGE' }) }
  assert.ok(!kinds(assess(l2.snapshot(), t.now())).some(k => k.startsWith('NO_EFFECT')), 'observe excluded')
})

test('V2: planCompletedCount rises only on completion, not revision or blocked', () => {
  const t = clock()
  const l = ledger(t)
  l.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 1, items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] })
  assert.equal(l.snapshot().planCompletedCount, 0)
  // Revision bump, same items: completed unchanged.
  l.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 2, items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] })
  assert.equal(l.snapshot().planCompletedCount, 0)
  // Marking blocked: completed unchanged.
  l.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 3, items: [{ content: 'A', status: 'blocked' }, { content: 'B', status: 'pending' }] })
  assert.equal(l.snapshot().planCompletedCount, 0)
  // Completing A: completed rises.
  l.noteFrame({ type: 'chat.activity', kind: 'plan', revision: 4, items: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] })
  assert.equal(l.snapshot().planCompletedCount, 1)
})

/* ------------------------------------------------------------------ */
/* V3 page identity (§3.4): parsing, page key tracking, digest         */
/* ------------------------------------------------------------------ */

test('V3 parsePageKey: tab line, navigate variants, unknown', () => {
  assert.equal(parsePageKey('tab 1 "Form" https://x.test/form?a=1'), 'https://x.test/form?a=1')
  assert.equal(parsePageKey('tab 7 "Station" https://x.test/s?n=3\nsome text'), 'https://x.test/s?n=3')
  assert.equal(parsePageKey('navigated to https://x.test/next · loaded in 50ms'), 'https://x.test/next')
  assert.equal(parsePageKey('navigated back to https://x.test/prev'), 'https://x.test/prev')
  assert.equal(parsePageKey('navigated forward to https://x.test/fwd'), 'https://x.test/fwd')
  assert.equal(parsePageKey('reloaded https://x.test/r'), 'https://x.test/r')
  assert.equal(parsePageKey('clicked label 1: button "Go"'), null)
  assert.equal(parsePageKey(''), null)
  assert.equal(parsePageKey(null), null)
})

test('V3 parseControlName: clicked quoted name, typed field, none', () => {
  assert.equal(parseControlName('clicked label 3: button "Submit order"'), 'Submit order')
  assert.equal(parseControlName('clicked label 1: link "Continue"'), 'Continue')
  assert.equal(parseControlName('typed into [5] email field'), 'field 5')
  assert.equal(parseControlName('submitted ok'), null)
  assert.equal(parseControlName(''), null)
})

test('V3 pageKeyPath: URL path only, <=60 chars, fail-safe', () => {
  assert.equal(pageKeyPath('https://x.test/form?a=1#h'), '/form')
  assert.equal(pageKeyPath('https://x.test/' + 'a'.repeat(80)).length, 60)
  assert.equal(pageKeyPath('not a url'), 'not a url')
  assert.equal(pageKeyPath(null), null)
})

test('V3 page key tracking: most recent URL wins; clicks keep the previous key', () => {
  const t = clock(); const l = ledger(t)
  call(l, 'n1', 'browser_navigate', { url: 'https://x.test/a' }); result(l, 'n1', { text: 'navigated to https://x.test/a' })
  call(l, 'c1', 'browser_click', { label: 1 }); result(l, 'c1', { text: 'clicked label 1: button "Go"' })
  // The click result names no URL -> page key stays https://x.test/a.
  call(l, 'r1', 'browser_read_text', {}); result(l, 'r1', { text: 'tab 1 "B" https://x.test/b\npage text' })
  call(l, 'c2', 'browser_click', { label: 2 }); result(l, 'c2', { text: 'clicked label 2: button "Go"' })
  const events = l.snapshot().events
  assert.equal(events.find(e => e.name === 'browser_click' && e.argsDigest.includes('1')).pageKey, 'https://x.test/a')
  assert.equal(events.find(e => e.name === 'browser_click' && e.argsDigest.includes('2')).pageKey, 'https://x.test/b')
})

test('V3 digest: mutationRevisits carry pageKey path + controlName; pageIdentity reported', () => {
  const t = clock(); const l = ledger(t)
  const page = 'tab 1 "Form" https://x.test/form?session=9'
  const head = 'clicked label 1: button "Submit"'
  for (let i = 0; i < 3; i += 1) { call(l, `a${i}`, 'browser_click', { label: 'Submit' }); result(l, `a${i}`, { text: `${page}\n${head}` }) }
  const ag = l.snapshot().aggregates
  assert.equal(ag.mutationRevisit, true)
  assert.equal(ag.mutationRevisits[0].pageKey, '/form', 'digest page key is the URL path')
  assert.equal(ag.mutationRevisits[0].controlName, 'Submit')
  assert.equal(ag.pageIdentity.unknownPage, 0)
  assert.equal(ag.pageIdentity.distinctPages, 1)
})
