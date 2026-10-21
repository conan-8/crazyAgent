import test from 'node:test'
import assert from 'node:assert/strict'
import { planImageOffload } from '../lib/image-budget.js'

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
