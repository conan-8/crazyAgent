import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTLE_MS, checkSelfUpdate, isNewerVersion } from '../self-update.js'

function harness({ running = '2.3.0', disk = '2.4.0', busy = false, state } = {}) {
  const h = { state, reloads: 0, now: 1_000_000, disk, busy }
  h.check = () => checkSelfUpdate({
    runningVersion: running,
    readDiskVersion: async () => {
      if (h.disk instanceof Error) throw h.disk
      return h.disk
    },
    isBusy: () => h.busy,
    loadState: async () => h.state,
    saveState: async next => { h.state = next },
    reload: () => { h.reloads += 1 },
    now: () => h.now,
  })
  return h
}

test('isNewerVersion compares dotted numeric versions and rejects anything else', () => {
  assert.equal(isNewerVersion('2.4.0', '2.3.0'), true)
  assert.equal(isNewerVersion('2.10.0', '2.9.9'), true)
  assert.equal(isNewerVersion('2.3.0.1', '2.3.0'), true)
  assert.equal(isNewerVersion('2.3.0', '2.3.0'), false)
  assert.equal(isNewerVersion('2.2.9', '2.3.0'), false)
  assert.equal(isNewerVersion('2.4.0-beta', '2.3.0'), false)
  assert.equal(isNewerVersion(undefined, '2.3.0'), false)
})

test('the same or an older version on disk never reloads', async () => {
  for (const disk of ['2.3.0', '2.2.0', 'garbage', new Error('unreadable')]) {
    const h = harness({ disk })
    assert.equal(await h.check(), 'current')
    assert.equal(h.reloads, 0)
    assert.equal(h.state, undefined)
  }
})

test('a newer version reloads only after it was seen twice, a settle time apart', async () => {
  const h = harness()
  assert.equal(await h.check(), 'seen')
  h.now += SETTLE_MS - 1
  assert.equal(await h.check(), 'settling')
  assert.equal(h.reloads, 0)
  h.now += 1
  assert.equal(await h.check(), 'reloading')
  assert.equal(h.reloads, 1)
  assert.equal(h.state.reloadedFor, '2.4.0')
})

test('a version that changes again on disk restarts the settle wait', async () => {
  const h = harness()
  await h.check()
  h.now += SETTLE_MS
  h.disk = '2.5.0'
  assert.equal(await h.check(), 'seen')
  assert.equal(h.reloads, 0)
})

test('a busy extension waits and reloads once it is idle', async () => {
  const h = harness({ busy: true })
  await h.check()
  h.now += SETTLE_MS
  assert.equal(await h.check(), 'busy')
  assert.equal(h.reloads, 0)
  h.busy = false
  assert.equal(await h.check(), 'reloading')
  assert.equal(h.reloads, 1)
})

test('a version is reloaded at most once, so a reload that changes nothing cannot loop', async () => {
  const h = harness()
  await h.check()
  h.now += SETTLE_MS
  await h.check()
  h.now += 10 * SETTLE_MS
  assert.equal(await h.check(), 'already-tried')
  assert.equal(h.reloads, 1)
})
