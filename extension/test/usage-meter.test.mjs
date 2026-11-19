import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCompactTokenCount, lifetimeUsageSegments, normalizeLifetimeUsage } from '../sidepanel/usage-meter.js'

test('sidebar lifetime usage is normalized and reasoning stays inside output', () => {
  assert.deepEqual(normalizeLifetimeUsage({
    turns: 4,
    inputTokens: 100,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 5,
    reasoningTokens: 99,
    totalTokens: 175,
    startedAt: '2026-11-18T10:00:00.000Z',
    updatedAt: 'invalid',
  }), {
    turns: 4,
    inputTokens: 100,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 5,
    reasoningTokens: 30,
    totalTokens: 175,
    startedAt: '2026-11-18T10:00:00.000Z',
    updatedAt: null,
  })
  assert.equal(normalizeLifetimeUsage(null).totalTokens, 0)
  assert.equal(normalizeLifetimeUsage([]).turns, 0)
  assert.equal(normalizeLifetimeUsage({ totalTokens: -5 }).totalTokens, 0)
  assert.equal(normalizeLifetimeUsage({ inputTokens: 10, outputTokens: 5 }).totalTokens, 15)
  assert.equal(normalizeLifetimeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 2 }).totalTokens, 15)
})

test('compact token labels remain readable at every magnitude', () => {
  assert.equal(formatCompactTokenCount(0), '0')
  assert.equal(formatCompactTokenCount(999), '999')
  assert.equal(formatCompactTokenCount(1200), '1.2K')
  assert.equal(formatCompactTokenCount(1_250_000), '1.3M')
  assert.equal(formatCompactTokenCount(35_900_800), '35.9M')
  assert.equal(formatCompactTokenCount(-100), '0')
})

test('stacked segments cover each disjoint category without counting reasoning twice', () => {
  const segments = lifetimeUsageSegments({
    inputTokens: 400,
    cacheReadTokens: 250,
    cacheWriteTokens: 50,
    outputTokens: 300,
    reasoningTokens: 125,
    totalTokens: 1000,
  })
  assert.deepEqual(segments.map(({ key, value, percent }) => ({ key, value, percent })), [
    { key: 'input', value: 400, percent: 40 },
    { key: 'cache-read', value: 250, percent: 25 },
    { key: 'cache-write', value: 50, percent: 5 },
    { key: 'output', value: 300, percent: 30 },
  ])
  assert.equal(segments.reduce((sum, segment) => sum + segment.percent, 0), 100)
  assert.ok(lifetimeUsageSegments(null).every(segment => segment.percent === 0))
})
