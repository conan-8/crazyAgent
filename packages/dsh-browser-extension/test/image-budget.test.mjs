import test from 'node:test'
import assert from 'node:assert/strict'
import { planImageOffload, planMidTurnOffload } from '../lib/image-budget.js'

test('keeps the newest images and offloads the oldest', () => {
  const entries = [
    { seq: 1, liveIndexes: [0] },
    { seq: 4, liveIndexes: [1] },
    { seq: 7, liveIndexes: [1] },
  ]
  const plan = planImageOffload(entries, 2)
  assert.equal(plan.live, 3)
  assert.equal(plan.offloaded, 1)
  assert.deepEqual(plan.targets, [{ seq: 1, imageIndexes: [0] }])
})

test('is a no-op when history fits the budget', () => {
  const plan = planImageOffload([{ seq: 2, liveIndexes: [1, 3] }], 2)
  assert.deepEqual(plan.targets, [])
  assert.equal(plan.offloaded, 0)
})

test('offloads across messages when one message is not enough', () => {
  const plan = planImageOffload([
    { seq: 3, liveIndexes: [0] },
    { seq: 6, liveIndexes: [0, 2] },
    { seq: 9, liveIndexes: [1] },
  ], 1)
  assert.equal(plan.offloaded, 3)
  assert.deepEqual(plan.targets, [
    { seq: 3, imageIndexes: [0] },
    { seq: 6, imageIndexes: [0, 2] },
  ])
})

test('ignores malformed entries and a zero budget drops everything', () => {
  const plan = planImageOffload([{ seq: 1, liveIndexes: [0] }, null, { seq: 'x', liveIndexes: [0] }, { seq: 2, liveIndexes: [] }], 0)
  assert.deepEqual(plan.targets, [{ seq: 1, imageIndexes: [0] }])
})

test('midturn pruning waits until history grows past keep + threshold', () => {
  const below = Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, liveIndexes: [0] }))
  const idle = planMidTurnOffload(below, 2, 8)
  assert.equal(idle.triggered, false)
  assert.deepEqual(idle.targets, [])
  assert.equal(idle.live, 10)
  assert.equal(idle.after, 10)

  const above = [...below, { seq: 11, liveIndexes: [0] }]
  const plan = planMidTurnOffload(above, 2, 8)
  assert.equal(plan.triggered, true)
  assert.equal(plan.live, 11)
  assert.equal(plan.offloaded, 9)
  assert.equal(plan.after, 2)
  assert.deepEqual(plan.targets.map(target => target.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('midturn pruning keeps the newest images across messages', () => {
  const plan = planMidTurnOffload([
    { seq: 3, liveIndexes: [0] },
    { seq: 6, liveIndexes: [0, 2] },
    { seq: 9, liveIndexes: [1] },
    { seq: 12, liveIndexes: [0] },
    { seq: 15, liveIndexes: [0, 1] },
    { seq: 18, liveIndexes: [0] },
    { seq: 21, liveIndexes: [0] },
    { seq: 24, liveIndexes: [0] },
    { seq: 27, liveIndexes: [0] },
    { seq: 30, liveIndexes: [0] },
    { seq: 33, liveIndexes: [0] },
  ], 3, 8)
  assert.equal(plan.triggered, true)
  assert.equal(plan.live, 13)
  assert.equal(plan.offloaded, 10)
  assert.equal(plan.after, 3)
  assert.deepEqual(plan.targets.map(target => target.seq), [3, 6, 9, 12, 15, 18, 21, 24])
})

test('midturn pruning ignores malformed entries and never over-offloads', () => {
  const idle = planMidTurnOffload([null, { seq: 'x', liveIndexes: [0] }, { seq: 2, liveIndexes: [] }], 2)
  assert.equal(idle.triggered, false)
  assert.deepEqual(idle.targets, [])

  const all = planMidTurnOffload(Array.from({ length: 12 }, (_, index) => ({ seq: index + 1, liveIndexes: [0] })), 0)
  assert.equal(all.triggered, true)
  assert.equal(all.after, 0)
  assert.equal(all.targets.length, 12)
})
