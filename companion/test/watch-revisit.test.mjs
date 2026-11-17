import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchLedger, assess, WATCH_AGGREGATE_LIMITS, READ_ONLY_TOOLS } from '../watch-ledger.mjs'
import { buildDigest } from '../watch-judge.mjs'

function clock() {
  let now = 0
  return { now: () => now, advance: ms => { now += ms }, set: ms => { now = ms } }
}
function ledger(t) {
  const l = new WatchLedger({ now: t.now })
  l.startTurn({ turnId: 'turn-1', prompt: 'long task', marathon: true })
  return l
}
function call(l, callId, name, args) { l.noteFrame({ type: 'chat.tool_call', callId, name, args }) }
function result(l, callId, ok = true, text = 'clicked') { l.noteFrame({ type: 'chat.tool_result', callId, ok, text }) }
function plan(l, revision, items) { l.noteFrame({ type: 'chat.activity', kind: 'plan', revision, items }) }
const has = (a, kind) => a.signals.some(s => s.kind === kind)
const PENDING = n => Array.from({ length: n }, (_, i) => ({ content: `step ${i}`, status: 'pending' }))

/* ------------------------------------------------------------------ */
/* REVISIT_HINT — mutation-revisit signature                           */
/* ------------------------------------------------------------------ */

test('mutationRevisit: 2 identical successful mutations do not fire, 3 do', () => {
  const t = clock(); const l = ledger(t)
  for (let i = 0; i < 2; i += 1) { call(l, `a${i}`, 'browser_click', { label: 'Submit' }); result(l, `a${i}`, true, 'submitted ok') }
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false)
  call(l, 'a2', 'browser_click', { label: 'Submit' }); result(l, 'a2', true, 'submitted ok')
  const a = assess(l.snapshot(), t.now())
  assert.equal(has(a, 'REVISIT_HINT'), true)
  assert.equal(a.signals.find(s => s.kind === 'REVISIT_HINT').level, 'suspect')
})

test('mutationRevisit: varying result heads suppress it (forward progress, not a redo)', () => {
  const t = clock(); const l = ledger(t)
  for (let i = 0; i < 4; i += 1) { call(l, `b${i}`, 'browser_click', { label: 6 }); result(l, `b${i}`, true, `clicked Continue to station ${i}`) }
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false)
})

test('mutationRevisit: read-only tools are excluded', () => {
  const t = clock(); const l = ledger(t)
  for (let i = 0; i < 4; i += 1) { call(l, `r${i}`, 'browser_read_text', {}); result(l, `r${i}`, true, 'same text') }
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false)
})

test('mutationRevisit: requires a successful occurrence', () => {
  const t = clock(); const l = ledger(t)
  for (let i = 0; i < 4; i += 1) { call(l, `f${i}`, 'browser_click', { label: 'X' }); result(l, `f${i}`, false, 'STALE_VIEW: nope') }
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false)
})

/* ------------------------------------------------------------------ */
/* REVISIT_HINT — open-item flat/rising trajectory                     */
/* ------------------------------------------------------------------ */

test('openFlat: fires at 150s flat with >=3 mutations, not at 149s', () => {
  const t = clock(); const l = ledger(t)
  plan(l, 1, PENDING(2)) // open=2 at t=0, lastDecreaseAt=0
  for (let i = 0; i < 3; i += 1) { call(l, `m${i}`, 'browser_click', { label: i }); result(l, `m${i}`, true, `done ${i}`) }
  t.advance(WATCH_AGGREGATE_LIMITS.openFlatMs - 1)
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false)
  t.advance(1)
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), true)
})

test('openFlat: fewer than 3 mutations since the decrease does not fire', () => {
  const t = clock(); const l = ledger(t)
  plan(l, 1, PENDING(2))
  for (let i = 0; i < 2; i += 1) { call(l, `m${i}`, 'browser_click', { label: i }); result(l, `m${i}`, true, `done ${i}`) }
  t.advance(WATCH_AGGREGATE_LIMITS.openFlatMs + 10_000)
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false)
})

test('openFlat: a decrease of open items resets the flat clock and mutation count', () => {
  const t = clock(); const l = ledger(t)
  plan(l, 1, PENDING(3)) // open 3
  for (let i = 0; i < 3; i += 1) { call(l, `m${i}`, 'browser_click', { label: i }); result(l, `m${i}`, true, `done ${i}`) }
  t.advance(WATCH_AGGREGATE_LIMITS.openFlatMs)
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), true)
  // A revision that completes an item decreases open 3 -> 2 and resets.
  plan(l, 2, [{ content: 'step 0', status: 'completed' }, { content: 'step 1', status: 'pending' }, { content: 'step 2', status: 'pending' }])
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false)
  t.advance(WATCH_AGGREGATE_LIMITS.openFlatMs - 1)
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false)
})

test('openFlat: a converging (decreasing) plan never fires on timing alone', () => {
  const t = clock(); const l = ledger(t)
  plan(l, 1, PENDING(5))
  for (let rev = 2; rev <= 5; rev += 1) {
    for (let i = 0; i < 3; i += 1) { call(l, `c${rev}-${i}`, 'browser_click', { label: `${rev}-${i}` }); result(l, `c${rev}-${i}`, true, 'ok') }
    t.advance(40_000)
    plan(l, rev, PENDING(5 - (rev - 1)))
  }
  t.advance(200_000)
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false)
})

/* ------------------------------------------------------------------ */
/* Navigation revisits are digest info, and bounds                     */
/* ------------------------------------------------------------------ */

test('navigation revisits populate navRevisits digest info', () => {
  const t = clock(); const l = ledger(t)
  for (let i = 0; i < 3; i += 1) { call(l, `n${i}`, 'browser_navigate', { history: 'back' }); result(l, `n${i}`, true, 'navigated back') }
  const ag = l.snapshot().aggregates
  assert.ok(ag.navRevisits.some(n => n.target === 'history:back' && n.count === 3))
})

test('aggregate bounds: fingerprint keys, nav targets, and open samples are capped', () => {
  const t = clock(); const l = ledger(t)
  for (let i = 0; i < WATCH_AGGREGATE_LIMITS.fingerprintKeys + 5; i += 1) { call(l, `x${i}`, 'browser_click', { label: i }); result(l, `x${i}`, true, 'ok') }
  assert.equal(l.snapshot().aggregates.distinctFingerprints, WATCH_AGGREGATE_LIMITS.fingerprintKeys)
  for (let i = 0; i < WATCH_AGGREGATE_LIMITS.navTargetKeys + 5; i += 1) { call(l, `nv${i}`, 'browser_navigate', { url: `http://x/${i}` }); result(l, `nv${i}`, true, 'ok') }
  assert.ok(l.state.navTargetCounts.size <= WATCH_AGGREGATE_LIMITS.navTargetKeys)
  for (let rev = 1; rev <= WATCH_AGGREGATE_LIMITS.planOpenSamples + 5; rev += 1) plan(l, rev, PENDING(2))
  assert.ok(l.state.planOpenSamples.length <= WATCH_AGGREGATE_LIMITS.planOpenSamples)
})

test('digest turnAggregates is bounded (~200 tokens) and text-only', () => {
  const t = clock(); const l = ledger(t)
  plan(l, 1, PENDING(4))
  for (let i = 0; i < 60; i += 1) { call(l, `c${i}`, 'browser_click', { label: i % 7 }); result(l, `c${i}`, true, `result text ${i}`) }
  for (let i = 0; i < 10; i += 1) { call(l, `n${i}`, 'browser_navigate', { url: `http://x/${i % 4}` }); result(l, `n${i}`, true, 'ok') }
  t.advance(200_000)
  const digest = buildDigest(l.snapshot(), t.now(), { signals: [], hints: [], previousVerdicts: [] })
  const ag = digest.turnAggregates
  assert.ok(ag.mutationRevisits.length <= WATCH_AGGREGATE_LIMITS.digestRevisits)
  assert.ok(ag.navRevisits.length <= WATCH_AGGREGATE_LIMITS.digestNavRevisits)
  assert.ok(ag.openItems.trajectory.length <= WATCH_AGGREGATE_LIMITS.digestOpenSamples)
  for (const r of ag.mutationRevisits) assert.ok(r.args.length <= WATCH_AGGREGATE_LIMITS.digestArgsChars)
  const chars = JSON.stringify(ag).length
  assert.ok(chars < 1600, `turnAggregates bounded, got ${chars} chars`)
  assert.equal(JSON.stringify(digest).includes('base64'), false)
})

/* ------------------------------------------------------------------ */
/* M3 regression: existing signals unchanged with aggregates present   */
/* ------------------------------------------------------------------ */

test('M3 signals still fire with aggregates present; REVISIT_HINT is suspect-only (never hard)', () => {
  const t = clock(); const l = ledger(t)
  call(l, 'hang', 'browser_wait_for')
  t.advance(240_000)
  const a = assess(l.snapshot(), t.now())
  assert.ok(a.signals.some(s => s.kind === 'TOOL_HANG' && s.level === 'hard'))
  assert.equal(a.level, 'hard')
  // REVISIT_HINT never appears as a hard signal.
  assert.ok(a.signals.filter(s => s.kind === 'REVISIT_HINT').every(s => s.level === 'suspect'))
})

test('a fresh turn with aggregates assesses ok', () => {
  const t = clock(); const l = ledger(t)
  assert.deepEqual(assess(l.snapshot(), t.now()), { level: 'ok', signals: [], hints: [] })
  assert.equal(l.snapshot().aggregates.calls, 0)
})
