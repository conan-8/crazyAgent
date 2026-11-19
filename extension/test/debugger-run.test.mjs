import test from 'node:test'
import assert from 'node:assert/strict'
import { beginDebuggerRun, endDebuggerRun, execute, withDebugger } from '../sidepanel/browser.js'

function fakeChrome(t, options = {}) {
  const previous = globalThis.chrome
  const events = []
  let detachCount = 0
  // Sessions this extension holds, like Chrome: attach fails while one is held,
  // and detach succeeds only for a session this extension attached.
  const ours = new Set(options.staleOwn ?? [])
  globalThis.chrome = {
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: {
      query: async () => [{ id: 7, windowId: 1, active: true, title: 'Fixture', url: 'https://example.test/', status: 'complete' }],
    },
    debugger: {
      attach: async ({ tabId }) => {
        events.push(`attach:${tabId}`)
        if (options.attachError) throw new Error(options.attachError)
        if (ours.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`)
        ours.add(tabId)
      },
      detach: async ({ tabId }) => {
        if (!ours.has(tabId)) {
          events.push(`detach-miss:${tabId}`)
          throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`)
        }
        events.push(`detach:${tabId}`)
        ours.delete(tabId)
        detachCount += 1
        if (options.waitForDetach && detachCount === 1) await options.waitForDetach()
      },
      onDetach: { addListener: () => {} },
    },
  }
  t.after(async () => {
    await endDebuggerRun()
    globalThis.chrome = previous
  })
  return events
}

test('trusted input outside a turn still attaches and detaches per operation', async t => {
  const events = fakeChrome(t)
  await withDebugger(7, async () => { events.push('op:1') })
  await withDebugger(7, async () => { events.push('op:2') })
  assert.deepEqual(events, ['attach:7', 'op:1', 'detach:7', 'attach:7', 'op:2', 'detach:7'])
})

test('one turn retains each tab until cleanup and preserves outside-turn behavior', async t => {
  const events = fakeChrome(t)
  await beginDebuggerRun()
  await withDebugger(7, async () => { events.push('op:1') })
  await withDebugger(7, async () => { events.push('op:2') })
  await withDebugger(8, async () => { events.push('op:3') })
  assert.deepEqual(events, ['attach:7', 'op:1', 'op:2', 'attach:8', 'op:3'])
  await endDebuggerRun()
  assert.deepEqual(events, ['attach:7', 'op:1', 'op:2', 'attach:8', 'op:3', 'detach:7', 'detach:8'])
  await withDebugger(7, async () => { events.push('op:4') })
  assert.deepEqual(events.at(-3), 'attach:7')
  assert.deepEqual(events.at(-2), 'op:4')
  assert.deepEqual(events.at(-1), 'detach:7')
})

test('turn cleanup waits for in-flight trusted input before detaching', async t => {
  const events = fakeChrome(t)
  await beginDebuggerRun()
  let release
  const operation = withDebugger(7, () => new Promise(resolve => { release = resolve }))
  for (let index = 0; index < 10 && !release; index += 1) await Promise.resolve()
  assert.ok(release)
  const ending = endDebuggerRun()
  await Promise.resolve()
  assert.equal(events.includes('detach:7'), false)
  release('done')
  assert.equal(await operation, 'done')
  await ending
  assert.deepEqual(events, ['attach:7', 'detach:7'])
})

test('a queued turn waits for the previous detach before attaching', async t => {
  let release
  const events = fakeChrome(t, { waitForDetach: () => new Promise(resolve => { release = resolve }) })
  await beginDebuggerRun()
  const ending = endDebuggerRun()
  const next = beginDebuggerRun()
  for (let index = 0; index < 20 && !release; index += 1) await Promise.resolve()
  assert.ok(release)
  assert.deepEqual(events, ['attach:7', 'detach:7'])
  release()
  await ending
  await next
  assert.deepEqual(events, ['attach:7', 'detach:7', 'attach:7'])
  await endDebuggerRun()
})

test('read-only commands continue when a debugger cannot attach', async t => {
  const events = fakeChrome(t, { attachError: 'Another debugger is active on this tab' })
  await assert.rejects(beginDebuggerRun(), error => error.code === 'DEBUGGER_BUSY')
  const result = await execute('tabs.list', {}, {})
  assert.equal(result.op, 'tabs.list')
  assert.equal(result.tabs[0].id, 7)
  await assert.rejects(withDebugger(7, async () => {}), error => error.code === 'DEBUGGER_BUSY')
  await endDebuggerRun()
  assert.deepEqual(events, ['attach:7', 'detach-miss:7'], 'a foreign debugger is probed once and left alone')
})

test('a stale session this extension left attached is released and re-attached once', async t => {
  // A side panel closed mid-turn kept its session on tab 7.
  const events = fakeChrome(t, { staleOwn: [7] })
  await beginDebuggerRun()
  await withDebugger(7, async () => { events.push('op:1') })
  assert.deepEqual(events, ['attach:7', 'detach:7', 'attach:7', 'op:1'])
  await endDebuggerRun()
  assert.deepEqual(events.at(-1), 'detach:7')
})

test('a busy debugger keeps naming DevTools or another extension', async t => {
  fakeChrome(t, { attachError: 'Another debugger is already attached to the tab with id: 7.' })
  await assert.rejects(withDebugger(7, async () => {}), error => error.code === 'DEBUGGER_BUSY' && /DevTools or another extension/.test(error.message))
})
