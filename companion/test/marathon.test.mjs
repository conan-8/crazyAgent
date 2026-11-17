import test from 'node:test'
import assert from 'node:assert/strict'
import { MARATHON_ORIGINS, MARATHON_WATCHER_IDLE, MarathonState, initialMarathonState, marathonFrameBody, normalizeMarathonPlan } from '../marathon.mjs'

const fixedNow = () => new Date('2026-11-16T19:00:00.000Z')

test('a fresh holder is off — the fail-safe default after a restart', () => {
  const marathon = new MarathonState({ now: fixedNow })
  assert.deepEqual(marathon.snapshot(), { enabled: false, sessionId: null, since: null, origin: null, plan: null })
  assert.deepEqual(initialMarathonState(), marathon.snapshot())
})

test('enabling records since/origin/session; a second enable keeps them (idempotent)', () => {
  const marathon = new MarathonState({ now: fixedNow })
  const first = marathon.set({ enabled: true, origin: 'remote', sessionId: 'session-1' })
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  assert.deepEqual(first.state, { enabled: true, sessionId: 'session-1', since: '2026-11-16T19:00:00.000Z', origin: 'remote', plan: null })
  const again = marathon.set({ enabled: true, origin: 'ui', sessionId: 'session-2' })
  assert.equal(again.changed, false)
  assert.deepEqual(again.state, first.state, 're-enabling never re-stamps since/origin')
})

test('disabling clears every marker including the carried plan', () => {
  const marathon = new MarathonState({ now: fixedNow })
  marathon.set({ enabled: true, origin: 'ui', sessionId: 'session-1' })
  // M2 will store a carried plan here; off must clear it whatever it holds.
  marathon.state.plan = { revision: 2, items: [{ content: 'x', status: 'pending' }], updatedAt: 'now', turnId: 'turn-1' }
  const off = marathon.set({ enabled: false, origin: 'remote' })
  assert.equal(off.changed, true)
  assert.deepEqual(off.state, { enabled: false, sessionId: null, since: null, origin: null, plan: null })
  assert.equal(marathon.set({ enabled: false }).changed, false, 'off when already off is a no-op')
})

test('reset turns off and reports whether anything changed', () => {
  const marathon = new MarathonState({ now: fixedNow })
  assert.equal(marathon.reset().changed, false)
  marathon.set({ enabled: true, origin: 'ui' })
  const reset = marathon.reset()
  assert.equal(reset.changed, true)
  assert.deepEqual(reset.state, initialMarathonState())
})

test('non-boolean enabled fails closed; unknown origins normalize to ui', () => {
  const marathon = new MarathonState({ now: fixedNow })
  for (const enabled of [undefined, null, 'true', 1, {}]) {
    const result = marathon.set({ enabled })
    assert.equal(result.ok, false, JSON.stringify(enabled))
    assert.equal(result.code, 'INVALID_MARATHON')
  }
  assert.equal(marathon.snapshot().enabled, false)
  assert.deepEqual(MARATHON_ORIGINS, ['ui', 'remote'])
  marathon.set({ enabled: true, origin: 'telegram' })
  assert.equal(marathon.snapshot().origin, 'ui')
  marathon.set({ enabled: false })
  marathon.set({ enabled: true })
  assert.equal(marathon.snapshot().origin, 'ui', 'origin defaults to ui')
  assert.equal(marathon.snapshot().sessionId, null, 'a missing session stays null, never guessed')
})

test('snapshots are copies: callers cannot mutate the holder through them', () => {
  const marathon = new MarathonState({ now: fixedNow })
  marathon.set({ enabled: true, origin: 'ui', sessionId: 'session-1' })
  const snapshot = marathon.snapshot()
  snapshot.enabled = false
  snapshot.sessionId = 'hacked'
  assert.equal(marathon.snapshot().enabled, true)
  assert.equal(marathon.snapshot().sessionId, 'session-1')
})

test('the frame body carries the idle watcher projection until M3', () => {
  const marathon = new MarathonState({ now: fixedNow })
  const body = marathonFrameBody(marathon.snapshot())
  assert.deepEqual(body, { enabled: false, sessionId: null, since: null, origin: null, plan: null, watcher: { active: false, checks: 0, lastCheckAt: null, lastVerdict: null } })
  assert.deepEqual(MARATHON_WATCHER_IDLE, body.watcher)
  body.watcher.checks = 99
  assert.equal(MARATHON_WATCHER_IDLE.checks, 0, 'the idle constant is never mutated through a frame')
})

/* M2: carried-plan storage */

const PLAN = Object.freeze({
  revision: 4,
  items: [{ content: 'Fill the form', status: 'in_progress' }, { content: 'Verify', status: 'pending' }],
  updatedAt: '2026-11-16T19:05:00.000Z',
  turnId: 'turn-1',
})

test('storePlan keeps an open plan only while enabled, and drops terminal plans', () => {
  const marathon = new MarathonState({ now: fixedNow })
  // Off: never stores.
  assert.equal(marathon.storePlan(PLAN).changed, false)
  assert.equal(marathon.snapshot().plan, null)
  marathon.set({ enabled: true, origin: 'ui' })
  const stored = marathon.storePlan(PLAN)
  assert.equal(stored.changed, true)
  assert.deepEqual(stored.state.plan, PLAN)
  // Identical store is a no-op.
  assert.equal(marathon.storePlan(PLAN).changed, false)
  // All-terminal plan drops the carry.
  const terminal = { ...PLAN, revision: 5, items: [{ content: 'Fill the form', status: 'completed' }, { content: 'Verify', status: 'blocked' }] }
  assert.equal(marathon.storePlan(terminal).changed, true)
  assert.equal(marathon.snapshot().plan, null)
  // Malformed snapshots fail closed to null.
  marathon.storePlan(PLAN)
  assert.equal(marathon.storePlan({ ...PLAN, revision: -1 }).state.plan, null)
  // Off clears a stored plan.
  marathon.storePlan(PLAN)
  marathon.set({ enabled: false })
  assert.equal(marathon.snapshot().plan, null)
})

test('normalizeMarathonPlan validates the full snapshot shape fail-closed', () => {
  assert.deepEqual(normalizeMarathonPlan(PLAN), PLAN)
  for (const bad of [
    null, undefined, 'plan', [], {},
    { ...PLAN, revision: -1 },
    { ...PLAN, revision: 1.5 },
    { ...PLAN, updatedAt: 5 },
    { ...PLAN, turnId: null },
    { ...PLAN, items: [] },
    { ...PLAN, items: [{ content: 'x', status: 'done' }] },
    { ...PLAN, items: [{ content: '  ', status: 'pending' }] },
    { ...PLAN, items: [{ content: 'x', status: 'pending' }, { content: 'x', status: 'completed' }] },
    { ...PLAN, items: Array.from({ length: 41 }, (_, i) => ({ content: `Task ${i}`, status: 'pending' })) },
  ]) {
    assert.equal(normalizeMarathonPlan(bad), null, JSON.stringify(bad))
  }
  // The result is a copy, not the input reference.
  const copy = normalizeMarathonPlan(PLAN)
  copy.items[0].content = 'changed'
  assert.equal(PLAN.items[0].content, 'Fill the form')
})

/* ------------------------------------------------------------------ */
/* V4 carry chain (§3.5, G2): internal ancestor prompts                */
/* ------------------------------------------------------------------ */

test('V4: carry chain appends ancestor prompts, clips 500, trims to last 3 oldest first', () => {
  const m = new MarathonState({ now: fixedNow })
  m.set({ enabled: true, sessionId: 's' })
  m.pushCarryPrompt('first task', 't1')
  m.pushCarryPrompt('x'.repeat(600), 't2')
  m.pushCarryPrompt('third task', 't3')
  m.pushCarryPrompt('fourth task', 't4')
  const chain = m.carryChainForDigest()
  assert.equal(chain.length, 3, 'trimmed to last 3')
  assert.deepEqual(chain.map(e => e.turnId), ['t2', 't3', 't4'], 'oldest first, oldest dropped')
  assert.equal(chain[0].prompt.length, 500, 'clipped to 500 chars')
  assert.equal(chain[2].prompt, 'fourth task')
})

test('V4: carry chain is INTERNAL — not in the published snapshot', () => {
  const m = new MarathonState({ now: fixedNow })
  m.set({ enabled: true, sessionId: 's' })
  m.pushCarryPrompt('secret ancestor task', 't1')
  assert.equal(m.carryChainForDigest().length, 1)
  const snap = m.snapshot()
  assert.equal(snap.carryChain, undefined, 'snapshot excludes carryChain')
  assert.deepEqual(Object.keys(snap).sort(), ['enabled', 'origin', 'plan', 'sessionId', 'since'])
  assert.equal(marathonFrameBody(snap).carryChain, undefined, 'frame body excludes carryChain')
})

test('V4: carry chain resets on marathon off, reset (chat/new), and carried-plan drop', () => {
  const m = new MarathonState({ now: fixedNow })
  m.set({ enabled: true, sessionId: 's' })
  m.pushCarryPrompt('a', 't1')
  m.set({ enabled: false })
  assert.equal(m.carryChainForDigest().length, 0, 'marathon off resets')
  m.set({ enabled: true, sessionId: 's' })
  m.pushCarryPrompt('b', 't2')
  m.reset()
  assert.equal(m.carryChainForDigest().length, 0, 'reset (new chat / chat switch) resets')
  m.set({ enabled: true, sessionId: 's' })
  m.pushCarryPrompt('c', 't3')
  m.storePlan(PLAN) // open plan persists -> chain kept
  assert.equal(m.carryChainForDigest().length, 1, 'persisting plan keeps chain')
  m.storePlan({ ...PLAN, items: [{ content: 'Fill the form', status: 'completed' }, { content: 'Verify', status: 'completed' }] })
  assert.equal(m.carryChainForDigest().length, 0, 'dropped (terminal) plan resets chain')
})

test('V4: pushCarryPrompt is a no-op while marathon is off', () => {
  const m = new MarathonState({ now: fixedNow })
  m.pushCarryPrompt('a', 't1')
  assert.equal(m.carryChainForDigest().length, 0)
})

test('V4: carryChainForDigest returns a copy (no mutation through it)', () => {
  const m = new MarathonState({ now: fixedNow })
  m.set({ enabled: true, sessionId: 's' })
  m.pushCarryPrompt('a', 't1')
  const copy = m.carryChainForDigest()
  copy[0].prompt = 'changed'
  copy.push({ prompt: 'extra', turnId: 'x' })
  assert.equal(m.carryChainForDigest()[0].prompt, 'a')
  assert.equal(m.carryChainForDigest().length, 1)
})

test('V8: normalizeMarathonPlan accepts and keeps a blocked-item reason; rejects reason on non-blocked', () => {
  const withReason = { ...PLAN, items: [{ content: 'Fill the form', status: 'blocked', reason: 'sign-in wall' }, { content: 'Verify', status: 'pending' }] }
  const normalized = normalizeMarathonPlan(withReason)
  assert.ok(normalized, 'carried seed with reason is accepted (not silently empty)')
  assert.equal(normalized.items[0].reason, 'sign-in wall')
  // reason on a non-blocked item fails closed.
  assert.equal(normalizeMarathonPlan({ ...PLAN, items: [{ content: 'Fill the form', status: 'in_progress', reason: 'x' }, { content: 'Verify', status: 'pending' }] }), null)
  // over-long reason fails closed.
  assert.equal(normalizeMarathonPlan({ ...PLAN, items: [{ content: 'Fill the form', status: 'blocked', reason: 'x'.repeat(241) }, { content: 'Verify', status: 'pending' }] }), null)
  // the stored snapshot keeps the reason through storePlan.
  const m = new MarathonState({ now: fixedNow })
  m.set({ enabled: true, sessionId: 's' })
  m.storePlan(withReason)
  assert.equal(m.snapshot().plan.items[0].reason, 'sign-in wall')
})
