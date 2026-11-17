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

test('V3 mutationRevisit: page-scoped — 2 identical effectful acts on the SAME page fire (threshold 2)', () => {
  const t = clock(); const l = ledger(t)
  const page = 'tab 1 "Form" https://x.test/form'
  const head = 'clicked label 1: button "Submit"'
  call(l, 'a0', 'browser_click', { label: 'Submit' }); result(l, 'a0', true, `${page}\n${head}`)
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false, '1 act is not a revisit')
  call(l, 'a1', 'browser_click', { label: 'Submit' }); result(l, 'a1', true, `${page}\n${head}`)
  const a = assess(l.snapshot(), t.now())
  assert.equal(has(a, 'REVISIT_HINT'), true, '2 identical effectful acts same page+control+outcome fire')
  assert.equal(a.signals.find(s => s.kind === 'REVISIT_HINT').level, 'suspect')
})

test('V3 mutationRevisit: same click on DIFFERENT pages is NOT a revisit (multi-page fix)', () => {
  const t = clock(); const l = ledger(t)
  const head = 'clicked label 1: button "Submit"'
  for (let i = 0; i < 4; i += 1) {
    call(l, `a${i}`, 'browser_click', { label: 'Submit' })
    result(l, `a${i}`, true, `tab 1 "Station ${i}" https://x.test/station?n=${i}\n${head}`)
  }
  assert.equal(has(assess(l.snapshot(), t.now()), 'REVISIT_HINT'), false, 'query-distinct pages do not merge into a revisit')
})

test('V3 mutationRevisit: unknown page excludes acts (fails toward silence)', () => {
  const t = clock(); const l = ledger(t)
  // No tab line / navigate URL anywhere -> page unknown -> excluded even at 4 repeats.
  for (let i = 0; i < 4; i += 1) { call(l, `a${i}`, 'browser_click', { label: 'Submit' }); result(l, `a${i}`, true, 'clicked label 1: button "Submit"') }
  const s = l.snapshot()
  assert.equal(has(assess(s, t.now()), 'REVISIT_HINT'), false, 'unknown page -> no revisit signal')
  assert.equal(s.aggregates.pageIdentity.unknownPageShare, 1, 'all act results unknown page')
  assert.equal(s.aggregates.mutationRevisit, false)
})

test('V3 mutationRevisit: no-effect acts feed NO_EFFECT, not revisits', () => {
  const t = clock(); const l = ledger(t)
  const page = 'tab 1 "Form" https://x.test/form'
  for (let i = 0; i < 4; i += 1) { call(l, `a${i}`, 'browser_click', { label: 'Submit' }); result(l, `a${i}`, true, `${page}\nresult: NO VISIBLE CHANGE — the page did not change`) }
  const a = assess(l.snapshot(), t.now())
  assert.equal(has(a, 'REVISIT_HINT'), false, 'no-effect acts are not effectful revisits')
  assert.equal(has(a, 'NO_EFFECT'), true, 'they feed NO_EFFECT instead')
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
