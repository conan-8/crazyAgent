import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { Bridge } from '../bridge.mjs'

const TOKEN = 'test-token'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function queueMessages(ws) {
  const items = []
  const waiters = []
  const seen = []
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
    seen.push(message)
    const index = waiters.findIndex(waiter => waiter.predicate(message))
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    } else {
      items.push(message)
    }
  })
  return {
    seen,
    next(predicate = () => true, timeoutMs = 2_000) {
      const index = items.findIndex(predicate)
      if (index >= 0) return Promise.resolve(items.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve }
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error('timed out waiting for a bridge message'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
  }
}

async function connect(url, role, token = TOKEN) {
  const ws = new WebSocket(url)
  const messages = queueMessages(ws)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ v: 1, type: 'hello', role, token, version: 1 }))
  const hello = await messages.next(message => message.type === 'hello.ok')
  assert.equal(hello.type, 'hello.ok')
  return { ws, messages }
}

async function setup(t, options = {}) {
  const chats = []
  const events = []
  const bridge = new Bridge({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    log: () => {},
    onChat: (text, ws, message) => { chats.push({ text, ws, autoCapture: message.autoCapture }) },
    onNewChat: () => {},
    // Existing behavior tests do not exercise the reconnect window, so keep
    // them immediate; grace tests opt in explicitly.
    uiGraceMs: 0,
    onLog: entry => events.push(entry),
    ...options,
  })
  await bridge.start()
  t.after(async () => {
    await bridge.stop()
  })
  return { bridge, url: `ws://127.0.0.1:${bridge.port}/bridge`, chats, events }
}

/** @param {Array<{frame: Record<string, any>}>} events */
function uiWaitEvent(events) {
  return events.find(entry => entry.frame?.type === 'bridge.ui.wait')?.frame
}

test('routes a provider command to the sidebar and the result back', async t => {
  const { bridge, url } = await setup(t)
  const ui = await connect(url, 'ui')
  const tools = await connect(url, 'tools')
  t.after(() => { ui.ws.close(); tools.ws.close() })

  tools.ws.send(JSON.stringify({
    v: 1,
    type: 'browser.command',
    id: 'cmd-1',
    callId: 'call-1',
    command: { op: 'scroll', args: { direction: 'down' } },
  }))

  const forwarded = await ui.messages.next(message => message.type === 'browser.command')
  assert.equal(forwarded.id, 'cmd-1')
  assert.equal(forwarded.callId, 'call-1')
  assert.equal(forwarded.command.op, 'scroll')

  ui.ws.send(JSON.stringify({
    v: 1,
    type: 'browser.result',
    id: 'cmd-1',
    ok: true,
    result: { op: 'scroll', scroll: { y: 612, maxY: 2400 } },
  }))

  const result = await tools.messages.next(message => message.type === 'browser.result')
  assert.equal(result.id, 'cmd-1')
  assert.equal(result.ok, true)
  assert.equal(result.result.scroll.y, 612)
  assert.equal(bridge.upstream.size, 0)
})

test('companion auto-capture requests use the same sidebar transport', async t => {
  const { bridge, url } = await setup(t)
  const ui = await connect(url, 'ui')
  t.after(() => ui.ws.close())

  const pending = bridge.requestUi({ op: 'snapshot', args: { detail: 'normal' } }, 'auto', 1_000)
  const forwarded = await ui.messages.next(message => message.type === 'browser.command')
  assert.equal(forwarded.callId, 'auto')
  assert.equal(forwarded.command.op, 'snapshot')

  ui.ws.send(JSON.stringify({
    v: 1,
    type: 'browser.result',
    id: forwarded.id,
    ok: true,
    result: { op: 'snapshot', tab: { id: 1 }, image: { data: 'AAAA', mimeType: 'image/jpeg' } },
  }))
  const result = await pending
  assert.equal(result.tab.id, 1)
  assert.equal(result.image.mimeType, 'image/jpeg')
})

test('returns SIDE_PANEL_CLOSED to the provider when the sidebar is absent', async t => {
  const { url, events } = await setup(t)
  const tools = await connect(url, 'tools')
  t.after(() => tools.ws.close())

  tools.ws.send(JSON.stringify({
    v: 1,
    type: 'browser.command',
    id: 'cmd-2',
    callId: 'call-2',
    command: { op: 'snapshot', args: {} },
  }))
  const result = await tools.messages.next(message => message.type === 'browser.result')
  assert.equal(result.id, 'cmd-2')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SIDE_PANEL_CLOSED')
  assert.match(result.error.message, /reloading/)
  const wait = uiWaitEvent(events)
  assert.equal(wait.type, 'bridge.ui.wait')
  assert.equal(wait.connected, false)
  assert.equal(wait.command.op, 'snapshot')
})

test('fails pending provider commands with SIDE_PANEL_CLOSED when the sidebar disconnects', async t => {
  const { url } = await setup(t)
  const ui = await connect(url, 'ui')
  const tools = await connect(url, 'tools')
  t.after(() => tools.ws.close())

  tools.ws.send(JSON.stringify({
    v: 1,
    type: 'browser.command',
    id: 'cmd-3',
    callId: 'call-3',
    command: { op: 'snapshot', args: {} },
  }))
  await ui.messages.next(message => message.type === 'browser.command')
  ui.ws.close()

  const result = await tools.messages.next(message => message.type === 'browser.result')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SIDE_PANEL_CLOSED')
  assert.match(result.error.message, /disconnected/)
})

test('rejects a bad pairing token', async t => {
  const { url } = await setup(t)
  const ws = new WebSocket(url)
  t.after(() => ws.close())
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const closed = new Promise(resolve => ws.once('close', code => resolve(code)))
  ws.send(JSON.stringify({ v: 1, type: 'hello', role: 'ui', token: 'wrong', version: 1 }))
  const code = await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 2_000)),
  ])
  assert.equal(code, 4001)
})

test('forwards chat.send to the companion callback', async t => {
  const { url, chats } = await setup(t)
  const ui = await connect(url, 'ui')
  t.after(() => ui.ws.close())
  ui.ws.send(JSON.stringify({ v: 1, type: 'chat.send', text: 'hello', autoCapture: false }))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(chats.length, 1)
  assert.equal(chats[0].text, 'hello')
  assert.equal(chats[0].autoCapture, false)
})

test('forwards live provider activity to the sidebar', async t => {
  const { url } = await setup(t)
  const ui = await connect(url, 'ui')
  const tools = await connect(url, 'tools')
  t.after(() => { ui.ws.close(); tools.ws.close() })

  tools.ws.send(JSON.stringify({
    v: 1,
    type: 'activity',
    activity: { kind: 'reasoning', text: 'checking the page', index: 0 },
  }))
  const activity = await ui.messages.next(message => message.type === 'chat.activity')
  assert.equal(activity.kind, 'reasoning')
  assert.equal(activity.text, 'checking the page')
})

test('requestUi waits for the sidebar to reconnect within the grace window', async t => {
  const { bridge, url, events } = await setup(t, { uiGraceMs: 500 })
  const pending = bridge.requestUi({ op: 'snapshot', args: { detail: 'normal' } }, 'auto', 1_000)
  assert.equal(bridge.uiWaiters.size, 1, 'request should be waiting for the sidebar')

  const ui = await connect(url, 'ui')
  t.after(() => ui.ws.close())

  const forwarded = await ui.messages.next(message => message.type === 'browser.command')
  assert.equal(forwarded.command.op, 'snapshot')
  ui.ws.send(JSON.stringify({
    v: 1,
    type: 'browser.result',
    id: forwarded.id,
    ok: true,
    result: { tab: { id: 7 } },
  }))
  const result = await pending
  assert.equal(result.tab.id, 7)
  assert.equal(bridge.uiRequests.size, 0)

  const wait = uiWaitEvent(events)
  assert.equal(wait.type, 'bridge.ui.wait')
  assert.equal(wait.connected, true)
  assert.equal(wait.command.op, 'snapshot')
  assert.ok(Number.isFinite(wait.waitedMs) && wait.waitedMs >= 0)
})

test('requestUi rejects with SIDE_PANEL_CLOSED after the grace window', async t => {
  const { bridge, events } = await setup(t, { uiGraceMs: 80 })
  const started = Date.now()
  await assert.rejects(
    bridge.requestUi({ op: 'snapshot', args: {} }, 'auto', 1_000),
    error => {
      assert.equal(error.code, 'SIDE_PANEL_CLOSED')
      assert.match(error.message, /may be reloading/)
      assert.match(error.message, /retry this call/)
      return true
    },
  )
  assert.ok(Date.now() - started >= 60, 'should have waited for roughly the full grace window')
  assert.equal(bridge.uiWaiters.size, 0)
  assert.equal(bridge.uiRequests.size, 0)
  const wait = uiWaitEvent(events)
  assert.equal(wait.connected, false)
  assert.ok(wait.waitedMs >= 60)
})

test('holds a provider command until the sidebar reconnects within the grace window', async t => {
  const { bridge, url, events } = await setup(t, { uiGraceMs: 500 })
  const tools = await connect(url, 'tools')
  t.after(() => tools.ws.close())

  tools.ws.send(JSON.stringify({
    v: 1,
    type: 'browser.command',
    id: 'cmd-grace',
    callId: 'call-grace',
    command: { op: 'snapshot', args: { detail: 'normal' } },
  }))
  await sleep(40)
  assert.deepEqual(
    tools.messages.seen.filter(message => message.type === 'browser.result'),
    [],
    'the command must be held during the grace window',
  )

  const ui = await connect(url, 'ui')
  t.after(() => ui.ws.close())
  const forwarded = await ui.messages.next(message => message.type === 'browser.command')
  assert.equal(forwarded.id, 'cmd-grace')
  assert.equal(forwarded.command.op, 'snapshot')

  ui.ws.send(JSON.stringify({
    v: 1,
    type: 'browser.result',
    id: 'cmd-grace',
    ok: true,
    result: { op: 'snapshot', tab: { id: 3 } },
  }))
  const result = await tools.messages.next(message => message.type === 'browser.result')
  assert.equal(result.ok, true)
  assert.equal(result.result.tab.id, 3)
  assert.equal(bridge.upstream.size, 0)

  const wait = uiWaitEvent(events)
  assert.equal(wait.connected, true)
  assert.equal(wait.command.op, 'snapshot')
})

test('returns SIDE_PANEL_CLOSED to the provider after the grace window expires', async t => {
  const { url, events } = await setup(t, { uiGraceMs: 70 })
  const tools = await connect(url, 'tools')
  t.after(() => tools.ws.close())

  const started = Date.now()
  tools.ws.send(JSON.stringify({
    v: 1,
    type: 'browser.command',
    id: 'cmd-grace-timeout',
    callId: 'call-grace-timeout',
    command: { op: 'click', args: { label: '1' } },
  }))
  const result = await tools.messages.next(message => message.type === 'browser.result')
  assert.equal(result.id, 'cmd-grace-timeout')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SIDE_PANEL_CLOSED')
  assert.match(result.error.message, /disconnected or reloading/)
  assert.ok(Date.now() - started >= 60)
  assert.equal(uiWaitEvent(events).connected, false)
})

test('grace 0 preserves the immediate SIDE_PANEL_CLOSED rejection', async t => {
  const { bridge, events } = await setup(t, { uiGraceMs: 0 })
  const started = Date.now()
  await assert.rejects(
    bridge.requestUi({ op: 'snapshot', args: {} }, 'auto', 1_000),
    error => error.code === 'SIDE_PANEL_CLOSED',
  )
  assert.ok(Date.now() - started < 100, 'grace 0 must not wait')
  const wait = uiWaitEvent(events)
  assert.equal(wait.connected, false)
})

test('bridge stop during a grace wait rejects cleanly', async t => {
  const { bridge } = await setup(t, { uiGraceMs: 1_000 })
  const pending = bridge.requestUi({ op: 'snapshot', args: {} }, 'auto', 1_000)
  const direct = bridge.waitForUi(1_000)
  assert.equal(bridge.uiWaiters.size, 2)

  await sleep(20)
  await bridge.stop()

  await assert.rejects(pending, error => error.message === 'bridge stopped')
  await assert.rejects(direct, error => error.message === 'bridge stopped')
  assert.equal(bridge.uiWaiters.size, 0)
  assert.equal(bridge.uiRequests.size, 0)
  await assert.rejects(bridge.requestUi({ op: 'snapshot', args: {} }, 'auto', 1_000), error => error.message === 'bridge stopped')
})

test('waitForUi resolves on a sidebar hello and immediately when connected', async t => {
  const { bridge, url } = await setup(t, { uiGraceMs: 500 })
  const waiting = bridge.waitForUi(500)
  const ui = await connect(url, 'ui')
  t.after(() => ui.ws.close())
  await waiting
  assert.equal(bridge.hasUi(), true)
  await bridge.waitForUi(0)
  assert.equal(bridge.uiWaiters.size, 0)
})

test('rejects pending auto-capture with SIDE_PANEL_CLOSED when the sidebar disconnects', async t => {
  const { bridge, url } = await setup(t)
  const ui = await connect(url, 'ui')
  t.after(() => ui.ws.close())

  const pending = bridge.requestUi({ op: 'snapshot', args: {} }, 'auto', 1_000)
  await ui.messages.next(message => message.type === 'browser.command')
  ui.ws.close()

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'SIDE_PANEL_CLOSED')
    assert.match(error.message, /disconnected/)
    return true
  })
  assert.equal(bridge.uiRequests.size, 0)
})

function makeBridge(options = {}) {
  return new Bridge({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    log: () => {},
    onChat: () => {},
    onNewChat: () => {},
    ...options,
  })
}

test('configures the UI grace window from option, CRAZYAGENT_UI_GRACE_MS, then the 8000ms default', () => {
  const previous = process.env.CRAZYAGENT_UI_GRACE_MS
  try {
    delete process.env.CRAZYAGENT_UI_GRACE_MS
    assert.equal(makeBridge().uiGraceMs, 8_000)
    assert.equal(makeBridge({ uiGraceMs: 0 }).uiGraceMs, 0)
    assert.equal(makeBridge({ uiGraceMs: 125 }).uiGraceMs, 125)

    process.env.CRAZYAGENT_UI_GRACE_MS = '275'
    assert.equal(makeBridge().uiGraceMs, 275)
    assert.equal(makeBridge({ uiGraceMs: 50 }).uiGraceMs, 50, 'an explicit option wins over the environment')

    process.env.CRAZYAGENT_UI_GRACE_MS = 'not-a-number'
    assert.equal(makeBridge().uiGraceMs, 8_000, 'an invalid environment value falls back to the default')
  } finally {
    if (previous === undefined) delete process.env.CRAZYAGENT_UI_GRACE_MS
    else process.env.CRAZYAGENT_UI_GRACE_MS = previous
  }
})

test('routes chat.stop to onStop exactly once without touching onChat', async t => {
  const stops = []
  const { url, chats } = await setup(t, {
    onStop: (ws, message) => { stops.push({ ws, message }) },
  })
  const ui = await connect(url, 'ui')
  t.after(() => ui.ws.close())

  ui.ws.send(JSON.stringify({ v: 1, type: 'chat.stop' }))
  await sleep(50)
  assert.equal(stops.length, 1)
  assert.equal(stops[0].message.type, 'chat.stop')
  assert.ok(stops[0].ws !== undefined)
  assert.equal(chats.length, 0, 'chat.stop must not be delivered as a prompt')
})

test('survives a failing onStop handler and keeps the bridge alive', async t => {
  const { url } = await setup(t, {
    onStop: () => { throw new Error('stop handler exploded') },
  })
  const ui = await connect(url, 'ui')
  t.after(() => ui.ws.close())

  ui.ws.send(JSON.stringify({ v: 1, type: 'chat.stop' }))
  ui.ws.send(JSON.stringify({ v: 1, type: 'ping' }))
  const pong = await ui.messages.next(message => message.type === 'pong')
  assert.equal(pong.type, 'pong')
})
