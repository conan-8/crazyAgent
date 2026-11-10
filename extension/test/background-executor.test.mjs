import test from 'node:test'
import assert from 'node:assert/strict'
import { BackgroundExecutor, KEEPALIVE_MS, bridgeHealthUrl } from '../background-executor.js'

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)) }

function setup(options = {}) {
  const sockets = []
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.closed = null; sockets.push(this) }
    send(text) { this.sent.push(JSON.parse(text)) }
    close(code, reason) { this.closed = { code, reason } }
    open() { this.onopen() }
    frame(frame) { this.onmessage({ data: JSON.stringify(frame) }) }
    drop(code = 1006) { this.readyState = 3; this.onclose({ code }) }
  }
  const state = {
    settings: { token: 'tok', bridgeUrl: 'ws://127.0.0.1:17871/bridge', ...options.settings },
    panelOpen: false,
    health: { ok: true, ui: false },
    calls: [],
    results: new Map(),
    timers: [],
    repeats: [],
    fetches: [],
    badge: [],
  }
  const executor = new BackgroundExecutor({
    loadSettings: async () => state.settings,
    isPanelOpen: async () => state.panelOpen,
    execute: (op, args) => {
      state.calls.push([op, args])
      const result = state.results.get(op)
      if (typeof result === 'function') return result()
      return Promise.resolve(result ?? { op })
    },
    beginRun: async () => { state.calls.push(['beginRun']) },
    endRun: async () => { state.calls.push(['endRun']) },
    setBadge: active => state.badge.push(active),
    WebSocketImpl: FakeSocket,
    fetchImpl: async url => {
      state.fetches.push(url)
      if (state.health === null) throw new Error('refused')
      return { ok: true, json: async () => state.health }
    },
    setTimer: (fn, ms) => { const t = { fn, ms }; state.timers.push(t); return t },
    clearTimer: t => { state.timers.splice(state.timers.indexOf(t), 1) },
    setRepeat: (fn, ms) => { const t = { fn, ms }; state.repeats.push(t); return t },
    clearRepeat: t => { state.repeats.splice(state.repeats.indexOf(t), 1) },
  })
  const port = () => { const p = { messages: [], postMessage(m) { this.messages.push(m) } }; return p }
  const connected = async () => {
    await executor.tick()
    const socket = sockets.at(-1)
    socket.open()
    socket.frame({ type: 'hello.ok' })
    return socket
  }
  return { executor, sockets, state, port, connected }
}

test('the health probe is built only for a local ws bridge', () => {
  assert.equal(bridgeHealthUrl('ws://127.0.0.1:17871/bridge'), 'http://127.0.0.1:17871/health')
  assert.equal(bridgeHealthUrl('ws://localhost:9/bridge'), 'http://localhost:9/health')
  for (const bad of ['wss://127.0.0.1/bridge', 'ws://evil.example/bridge', 'nonsense', undefined]) assert.equal(bridgeHealthUrl(bad), null)
})

test('connects as the ui role with its stored token when nothing else is executing', async () => {
  const { sockets, connected, state } = setup()
  const socket = await connected()
  assert.equal(socket.url, 'ws://127.0.0.1:17871/bridge')
  assert.deepEqual(socket.sent[0], { v: 1, type: 'hello', role: 'ui', token: 'tok', version: 1, host: 'background' })
  assert.equal(sockets.length, 1)
  assert.equal(state.repeats[0].ms, KEEPALIVE_MS)
  state.repeats[0].fn()
  assert.deepEqual(socket.sent.at(-1), { v: 1, type: 'ping' })
})

test('stays off when unpaired, when a panel exists, when another executor holds the role, or when the companion is down', async () => {
  for (const [change, expectFetch] of [
    [s => { s.settings = { ...s.settings, token: '' } }, 0],
    [s => { s.settings = { ...s.settings, bridgeUrl: 'wss://remote.example/bridge' } }, 0],
    [s => { s.panelOpen = true }, 0],
    [s => { s.health = { ok: true, ui: true } }, 1],
    [s => { s.health = null }, 1],
  ]) {
    const { executor, sockets, state } = setup()
    change(state)
    await executor.tick()
    assert.equal(sockets.length, 0)
    assert.equal(state.fetches.length, expectFetch)
  }
})

test('concurrent ticks open one connection', async () => {
  const { executor, sockets } = setup()
  await Promise.all([executor.tick(), executor.tick(), executor.tick()])
  await executor.tick()
  assert.equal(sockets.length, 1)
})

test('a command runs once and its result, or structured failure, goes back by id', async () => {
  const { sockets, connected, state } = setup()
  const socket = await connected()
  state.results.set('snapshot', { op: 'snapshot', image: { data: 'AAAA' } })
  socket.frame({ type: 'browser.command', id: 'c1', callId: 'auto', command: { op: 'snapshot', args: { detail: 'normal' } } })
  await flush()
  assert.deepEqual(state.calls, [['snapshot', { detail: 'normal' }]])
  assert.deepEqual(socket.sent.at(-1), { v: 1, type: 'browser.result', id: 'c1', ok: true, result: { op: 'snapshot', image: { data: 'AAAA' } } })
  assert.deepEqual(state.badge, [true, false])

  state.results.set('click', () => { const e = new Error('stale'); e.code = 'STALE_VIEW'; e.mutationPossible = false; return Promise.reject(e) })
  socket.frame({ type: 'browser.command', id: 'c2', command: { op: 'click', args: { label: 3 } } })
  await flush()
  assert.deepEqual(socket.sent.at(-1), { v: 1, type: 'browser.result', id: 'c2', ok: false, error: { code: 'STALE_VIEW', message: 'stale', mutationPossible: false } })
  assert.equal(sockets.length, 1)
})

test('a phone turn holds one debugger run and cleans up at every end', async () => {
  for (const end of ['chat.done', 'chat.stopped', 'chat.error']) {
    const { connected, state } = setup()
    const socket = await connected()
    socket.frame({ type: 'chat.user', origin: 'remote', turnId: 't1' })
    await flush()
    assert.deepEqual(state.calls, [['beginRun']])
    socket.frame({ type: end })
    await flush()
    assert.deepEqual(state.calls.map(call => call[0]).sort(), ['beginRun', 'endRun', 'labels.clear'])
  }
})

test('a panel opening takes over immediately when idle and nothing runs in both', async () => {
  const { executor, sockets, connected, port, state } = setup()
  const socket = await connected()
  const panel = port()
  executor.panelConnected(panel)
  assert.deepEqual(socket.closed, { code: 1000, reason: 'side panel opened' })
  assert.deepEqual(panel.messages, [{ type: 'executor.released' }])
  await executor.tick()
  assert.equal(sockets.length, 1, 'no reconnect while a panel is open')
  assert.equal(state.repeats.length, 0, 'keepalive stopped')
})

test('a panel opening waits for the command in flight, which still reports its result', async () => {
  const { executor, connected, port, state } = setup()
  const socket = await connected()
  let finish = () => {}
  state.results.set('click', () => new Promise(resolve => { finish = resolve }))
  socket.frame({ type: 'browser.command', id: 'c1', command: { op: 'click', args: {} } })
  await flush()
  const panel = port()
  executor.panelConnected(panel)
  assert.equal(socket.closed, null)
  assert.deepEqual(panel.messages, [])
  finish({ op: 'click' })
  await flush()
  assert.equal(socket.sent.at(-1).id, 'c1')
  assert.equal(socket.closed.code, 1000)
  assert.deepEqual(panel.messages, [{ type: 'executor.released' }])
})

test('with no socket a panel is released at once, and closing the last panel brings the worker back', async () => {
  const { executor, sockets, port, state } = setup()
  const first = port()
  const second = port()
  executor.panelConnected(first)
  executor.panelConnected(second)
  assert.deepEqual(second.messages, [{ type: 'executor.released' }])
  executor.panelDisconnected(first)
  assert.equal(state.timers.length, 0, 'another panel is still open')
  executor.panelDisconnected(second)
  assert.equal(state.timers.length, 3)
  state.timers[0].fn()
  await flush()
  assert.equal(sockets.length, 1)
})

test('a dropped connection retries, a rejected token waits for a new one', async () => {
  const { executor, sockets, connected, state } = setup()
  const socket = await connected()
  socket.drop(1006)
  assert.equal(state.timers.length, 1)
  state.timers[0].fn()
  await flush()
  assert.equal(sockets.length, 2)
  sockets[1].drop(4001)
  await executor.tick()
  assert.equal(sockets.length, 2, 'the same rejected token is not retried')
  state.settings = { ...state.settings, token: 'new-token' }
  await executor.tick()
  assert.equal(sockets.length, 3)
})

test('a replaced connection does not fight the new executor', async () => {
  const { executor, sockets, connected, state } = setup()
  const socket = await connected()
  state.health = { ok: true, ui: true }
  socket.drop(4000)
  await executor.tick()
  assert.equal(sockets.length, 1)
})

test('frames that are not JSON or not for the executor are ignored', async () => {
  const { sockets, connected, state } = setup()
  const socket = await connected()
  socket.onmessage({ data: 'not json' })
  socket.frame({ type: 'chat.status', status: 'thinking' })
  socket.frame({ type: 'chat.assistant', text: 'hello' })
  await flush()
  assert.deepEqual(state.calls, [])
  assert.equal(sockets.length, 1)
})
