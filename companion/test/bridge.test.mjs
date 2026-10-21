import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { Bridge } from '../bridge.mjs'

const TOKEN = 'test-token'

function queueMessages(ws) {
  const items = []
  const waiters = []
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
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

async function setup(t) {
  const chats = []
  const bridge = new Bridge({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    log: () => {},
    onChat: (text, ws, message) => { chats.push({ text, ws, autoCapture: message.autoCapture }) },
    onNewChat: () => {},
  })
  await bridge.start()
  t.after(async () => {
    await bridge.stop()
  })
  return { bridge, url: `ws://127.0.0.1:${bridge.port}/bridge`, chats }
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

test('returns NO_UI to the provider when the sidebar is absent', async t => {
  const { url } = await setup(t)
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
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'NO_UI')
})

test('fails pending provider commands when the sidebar disconnects', async t => {
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
  assert.equal(result.error.code, 'UI_DISCONNECTED')
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
