import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LifetimeUsageStore, normalizeTokenUsage } from '../lifetime-usage.mjs'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crazyagent-lifetime-usage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('token totals keep input/cache categories disjoint and reasoning inside output', () => {
  assert.deepEqual(normalizeTokenUsage({
    inputTokens: 100,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 5,
    reasoningTokens: 12,
  }), {
    inputTokens: 100,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 5,
    reasoningTokens: 12,
    totalTokens: 175,
  })
  assert.equal(normalizeTokenUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 99 }).totalTokens, 99)
  assert.equal(normalizeTokenUsage({ outputTokens: 5, reasoningTokens: 20 }).reasoningTokens, 5)
  assert.deepEqual(normalizeTokenUsage({ inputTokens: -10, outputTokens: 'bad', totalTokens: NaN }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  })
})

test('lifetime totals survive reconstruction, accumulate once per turn, and stay owner-only', t => {
  const file = join(tempDir(t), 'nested', 'usage.json')
  let current = new Date('2026-11-18T10:00:00.000Z')
  const now = () => current
  const store = new LifetimeUsageStore({ file, now })
  const first = store.record('turn-1', {
    inputTokens: 100,
    outputTokens: 30,
    cacheReadTokens: 40,
    cacheWriteTokens: 5,
    reasoningTokens: 12,
    totalTokens: 175,
  })
  assert.equal(first.changed, true)
  assert.equal(first.usage.turns, 1)
  assert.equal(first.usage.totalTokens, 175)
  assert.equal(first.usage.startedAt, '2026-11-18T10:00:00.000Z')
  assert.equal(first.usage.updatedAt, first.usage.startedAt)
  assert.equal('processedTurnIds' in first.usage, false)

  assert.equal(store.record('turn-1', { totalTokens: 999_999 }).changed, false)
  assert.equal(store.snapshot().totalTokens, 175)

  current = new Date('2026-11-19T11:00:00.000Z')
  const afterUpdate = new LifetimeUsageStore({ file, now })
  assert.deepEqual(afterUpdate.snapshot(), store.snapshot())
  assert.equal(afterUpdate.record('turn-1', { totalTokens: 999_999 }).changed, false, 'the dedupe marker survives restart')
  const second = afterUpdate.record('turn-2', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 })
  assert.equal(second.changed, true)
  assert.deepEqual(second.usage, {
    version: 1,
    turns: 2,
    inputTokens: 110,
    outputTokens: 35,
    cacheReadTokens: 42,
    cacheWriteTokens: 5,
    reasoningTokens: 12,
    totalTokens: 192,
    startedAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-19T11:00:00.000Z',
  })
  assert.equal(existsSync(`${file}.tmp`), false, 'atomic temp file was renamed')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).processedTurnIds, ['turn-1', 'turn-2'])
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('empty, malformed, or unidentifiable turns do not create or change history', t => {
  const file = join(tempDir(t), 'usage.json')
  const store = new LifetimeUsageStore({ file, now: () => new Date('2026-11-18T10:00:00.000Z') })
  for (const [turnId, usage] of [
    ['turn-zero', {}],
    ['turn-negative', { totalTokens: -20 }],
    ['', { totalTokens: 20 }],
    [undefined, { totalTokens: 20 }],
  ]) {
    assert.equal(store.record(turnId, usage).changed, false)
  }
  assert.equal(store.snapshot().turns, 0)
  assert.equal(store.snapshot().totalTokens, 0)
  assert.equal(existsSync(file), false)
})

test('missing or malformed stored data starts clean without throwing', t => {
  const file = join(tempDir(t), 'usage.json')
  assert.equal(new LifetimeUsageStore({ file }).snapshot().totalTokens, 0)
  writeFileSync(file, '{broken')
  assert.equal(new LifetimeUsageStore({ file }).snapshot().totalTokens, 0)
  writeFileSync(file, JSON.stringify({ version: 2, totalTokens: 500 }))
  assert.equal(new LifetimeUsageStore({ file }).snapshot().totalTokens, 0)
})
