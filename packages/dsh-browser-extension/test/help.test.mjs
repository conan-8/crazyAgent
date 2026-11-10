import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'
import { AGENT_HELP_TOOL, HELP_CATEGORIES, HELP_REASON_MAX_CHARS, createHelpRuntime, parseHelpRequest } from '../lib/help.js'

test('parseHelpRequest accepts only the strict {reason, category} shape', () => {
  assert.deepEqual(parseHelpRequest({ reason: '  Sign in.  ', category: 'login' }), { reason: 'Sign in.', category: 'login' })
  for (const category of HELP_CATEGORIES) assert.equal(parseHelpRequest({ reason: 'x', category }).category, category)
  for (const bad of [
    null, 'help', [], {},
    { reason: 'x' },
    { category: 'login' },
    { reason: '', category: 'login' },
    { reason: '   ', category: 'login' },
    { reason: 5, category: 'login' },
    { reason: 'x', category: 'approve' },
    { reason: 'x', category: 'login', screenshot: true },
    { reason: 'x'.repeat(HELP_REASON_MAX_CHARS + 1), category: 'other' },
  ]) {
    assert.throws(() => parseHelpRequest(bad), error => error.code === 'HELP_INVALID', JSON.stringify(bad)?.slice(0, 60))
  }
  assert.deepEqual(AGENT_HELP_TOOL.inputSchema.required, ['reason', 'category'])
  assert.equal(AGENT_HELP_TOOL.inputSchema.additionalProperties, false)
})

test('the runtime sends one help-request activity, logs no reason text, and never claims an undelivered request', () => {
  const logs = []
  const activities = []
  let connected = true
  const runtime = createHelpRuntime({ bridge: {
    activity: activity => { if (!connected) return false; activities.push(activity); return true },
    logEvent: (type, data, severity) => logs.push({ type, data, severity }),
  } })
  assert.throws(() => runtime.request({ reason: 'x', category: 'login' }, {}), error => error.code === 'HELP_NO_ACTIVE_TURN')
  assert.equal(activities.length, 0)
  const exec = { agent: { session: { id: 'session-a' } } }
  const result = runtime.request({ reason: 'Type the SMS code 123456 prompt', category: 'captcha' }, exec)
  assert.equal(result.structuredContent.recorded, true)
  assert.match(result.content[0].text, /End your turn now/u)
  assert.deepEqual(activities, [{ kind: 'help-request', category: 'captcha', reason: 'Type the SMS code 123456 prompt' }])
  assert.ok(!JSON.stringify(logs).includes('SMS code'), 'the reason is chat content, not diagnostics')

  // Bridge down: the model is told plainly, so it does not promise a notification.
  connected = false
  assert.throws(() => runtime.request({ reason: 'Approve the prompt.', category: 'permission' }, exec), error => error.code === 'HELP_NOT_DELIVERED')
  assert.equal(activities.length, 1)
  assert.deepEqual(logs.map(entry => [entry.data.delivered, entry.severity]), [[true, 'info'], [false, 'warn']])
})

function makeContext() {
  const tools = new Map()
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { info: () => {} },
    browserUse: { register: () => () => {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
    on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event) },
    effect(fn) {
      const iterator = fn()
      let step = iterator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = iterator.next()
      }
      return () => { for (const dispose of disposers.reverse()) dispose() }
    },
  }
  return { ctx, tools, listeners, dispose: () => { for (const dispose of disposers.reverse()) dispose() } }
}

test('the registered tool sends no browser command and its request rides the durable turn/end event', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const frames = []
  let socket
  server.on('connection', ws => {
    socket = ws
    ws.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
      else frames.push(message)
    })
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: `ws://127.0.0.1:${server.address().port}/bridge`, bridgeToken: 'test', requestTimeoutMs: 500 })
  t.after(async () => {
    fake.dispose()
    for (const client of server.clients) client.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  const started = Date.now()
  while (socket?.readyState !== 1 && Date.now() - started < 2_000) await new Promise(resolve => setTimeout(resolve, 20))

  const tool = fake.tools.get('agent_request_help')
  assert.ok(tool, 'agent_request_help is a standing tool')
  assert.equal(tool.isConcurrencySafe, undefined, 'it stays an ordering barrier')
  const session = { id: 'session-help', surface: { nodes: [] }, append: () => {} }
  const exec = { callId: 'help-call-1', agent: { session, steer: () => {} }, signal: new AbortController().signal }

  await assert.rejects(tool.execute({ reason: 'x', category: 'nope' }, exec), /HELP_INVALID/u)
  const result = await tool.execute({ reason: 'Log in to the bank site.', category: 'login' }, exec)
  assert.equal(result.structuredContent.recorded, true)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(frames.filter(frame => frame.type === 'browser.command'), [], 'a help request is not a browser command')

  const sent = frames.filter(frame => frame.type === 'activity' && frame.activity?.kind === 'help-request')
  assert.deepEqual(sent.map(frame => frame.activity), [{ kind: 'help-request', category: 'login', reason: 'Log in to the bank site.' }])

  // DSH deep-freezes committed session events; the turn/end listener must not try to annotate one.
  const frozen = Object.freeze({ type: 'turn/end', data: Object.freeze({ turn: 1, reason: Object.freeze({ kind: 'completed' }) }) })
  assert.doesNotThrow(() => fake.listeners.get('session/event')(session, frozen))
  assert.deepEqual(Object.keys(frozen.data), ['turn', 'reason'])
})
