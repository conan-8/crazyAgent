import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchLedger, assess, WATCH_AGGREGATE_LIMITS } from '../watch-ledger.mjs'
import { buildDigest } from '../watch-judge.mjs'

function clock() {
  let now = 0
  return { now: () => now, advance: ms => { now += ms }, set: ms => { now = ms } }
}
function ledger(t = clock()) {
  const l = new WatchLedger({ now: t.now })
  l.startTurn({ turnId: 'turn-1', prompt: 'long task', marathon: true })
  return l
}
function plan(l, revision, items) {
  l.noteFrame({ type: 'chat.activity', kind: 'plan', revision, items })
}
const items = (completed, open) => [
  ...Array.from({ length: completed }, (_, i) => ({ content: `done ${i}`, status: 'completed' })),
  ...Array.from({ length: open }, (_, i) => ({ content: `open ${i}`, status: 'pending' })),
]
function digest(l, now) {
  return buildDigest(l.snapshot(), now, { signals: [], hints: [], previousVerdicts: [] })
}

test('V5 c1: completed-count samples ring is bounded (41st shifts)', () => {
  const t = clock(); const l = ledger(t)
  for (let rev = 1; rev <= WATCH_AGGREGATE_LIMITS.planCompletedSamples + 5; rev += 1) {
    plan(l, rev, items(1, 1))
    t.advance(1000)
  }
  assert.ok(l.state.planCompletedSamples.length <= WATCH_AGGREGATE_LIMITS.planCompletedSamples)
  assert.equal(l.state.planCompletedSamples.length, WATCH_AGGREGATE_LIMITS.planCompletedSamples)
})

test('V5 c1: digest completedTrajectory is bounded to digestCompletedSamples', () => {
  const t = clock(); const l = ledger(t)
  for (let rev = 1; rev <= 20; rev += 1) { plan(l, rev, items(rev % 4, 2)); t.advance(1000) }
  const d = digest(l, t.now())
  assert.ok(d.turnAggregates.openItems.completedTrajectory.length <= WATCH_AGGREGATE_LIMITS.digestCompletedSamples)
  assert.equal(d.turnAggregates.openItems.completedTrajectory.length, WATCH_AGGREGATE_LIMITS.digestCompletedSamples)
})

test('V5 c1: a completed-count reversal (redo) is visible in the trajectory', () => {
  const t = clock(); const l = ledger(t)
  plan(l, 1, items(0, 3)); t.advance(10_000)   // completed 0
  plan(l, 2, items(2, 1)); t.advance(10_000)   // completed 2 (progress)
  plan(l, 3, items(1, 2)); t.advance(10_000)   // completed 1 (REVERSAL — reopened)
  const d = digest(l, t.now())
  const traj = d.turnAggregates.openItems.completedTrajectory
  assert.deepEqual(traj.map(s => s.completed), [0, 2, 1])
  assert.equal(d.turnAggregates.openItems.completedFirst, 0)
  assert.equal(d.turnAggregates.openItems.completedCurrent, 1)
  // ages are relative to now (samples at 0/10s/20s, now=30s)
  assert.deepEqual(traj.map(s => s.ageSec), [30, 20, 10])
})

test('V5 c1: completed trajectory resets per turn', () => {
  const t = clock(); const l = ledger(t)
  plan(l, 1, items(2, 1)); t.advance(1000)
  assert.equal(l.snapshot().aggregates.openItems.completedCurrent, 2)
  l.startTurn({ turnId: 'turn-2', prompt: 'next', marathon: true })
  const ag = l.snapshot().aggregates.openItems
  assert.equal(ag.completedFirst, null)
  assert.equal(ag.completedCurrent, null)
  assert.deepEqual(ag.completedSamples, [])
})

test('V5 c1: no plan -> completed fields null, empty trajectory (no crash)', () => {
  const t = clock(); const l = ledger(t)
  const d = digest(l, t.now())
  assert.equal(d.turnAggregates.openItems.completedFirst, null)
  assert.equal(d.turnAggregates.openItems.completedCurrent, null)
  assert.deepEqual(d.turnAggregates.openItems.completedTrajectory, [])
})

test('V5 c1: M3/M4 deterministic signals unchanged (assess byte-identical)', () => {
  const t = clock(); const l = ledger(t)
  // open items flat while mutations continue -> REVISIT_HINT open-flat (M4).
  plan(l, 1, items(0, 2))
  for (let i = 0; i < 4; i += 1) {
    l.noteFrame({ type: 'chat.tool_call', callId: `c${i}`, name: 'browser_click', args: { label: i } })
    l.noteFrame({ type: 'chat.tool_result', callId: `c${i}`, ok: true, text: `clicked ${i}` })
  }
  t.advance(WATCH_AGGREGATE_LIMITS.openFlatMs ?? 150_000)
  const a = assess(l.snapshot(), t.now())
  assert.ok(a.signals.some(s => s.kind === 'REVISIT_HINT' && s.level === 'suspect'))
  // candidate 1 adds NO new signal kind.
  assert.ok(a.signals.every(s => ['SILENT_STALL', 'TOOL_HANG', 'EXECUTOR_DOWN', 'FAIL_STREAK', 'REPEAT_LOOP', 'SAME_ERROR', 'OBSERVE_ONLY', 'PLAN_STALLED', 'REVISIT_HINT', 'NO_EFFECT'].includes(s.kind)))
})

test('V5 c1: digest turnAggregates stays bounded (~+70 tokens for completed history)', () => {
  const t = clock(); const l = ledger(t)
  plan(l, 1, items(0, 4))
  for (let i = 0; i < 60; i += 1) {
    l.noteFrame({ type: 'chat.tool_call', callId: `c${i}`, name: 'browser_click', args: { label: i % 7 } })
    l.noteFrame({ type: 'chat.tool_result', callId: `c${i}`, ok: true, text: `result ${i}` })
    if (i % 10 === 0) plan(l, 2 + i / 10, items(Math.floor(i / 10), 4 - Math.floor(i / 10)))
    t.advance(2000)
  }
  const d = digest(l, t.now())
  const chars = JSON.stringify(d.turnAggregates).length
  assert.ok(chars < 2000, `turnAggregates bounded, got ${chars} chars`)
  assert.equal(JSON.stringify(d).includes('base64'), false)
})
