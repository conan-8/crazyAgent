import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'
import { AGENT_CONFIRM_TOOL, CONFIRM_ACTION_MAX_CHARS, CONFIRM_TARGET_MAX_CHARS, createConfirmRuntime, parseConfirmRequest } from '../lib/confirm.js'

test('parseConfirmRequest accepts only the strict {action, target} shape', () => {
  assert.deepEqual(parseConfirmRequest({ action: '  Submit the assignment.  ', target: ' Submit button ' }), { action: 'Submit the assignment.', target: 'Submit button' })
  for (const bad of [
    null, 'confirm', [], {},
    { action: 'x' },
    { target: 'x' },
    { action: '', target: 'x' },
    { action: '   ', target: 'x' },
    { action: 'x', target: '' },
    { action: 5, target: 'x' },
    { action: 'x', target: 5 },
    { action: 'x', target: 'y', decision: 'approve' },
    { action: 'x'.repeat(CONFIRM_ACTION_MAX_CHARS + 1), target: 'y' },
    { action: 'x', target: 'y'.repeat(CONFIRM_TARGET_MAX_CHARS + 1) },
  ]) {
    assert.throws(() => parseConfirmRequest(bad), error => error.code === 'CONFIRM_INVALID', JSON.stringify(bad)?.slice(0, 60))
  }
  assert.deepEqual(AGENT_CONFIRM_TOOL.inputSchema.required, ['action', 'target'])
  assert.equal(AGENT_CONFIRM_TOOL.inputSchema.additionalProperties, false)
})

test('the runtime sends one confirm-request activity, logs no action text, and never claims an undelivered request', async () => {
  const logs = []
  const activities = []
  let connected = true
  const tools = new Map()
  const ctx = { tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }
  const runtime = createConfirmRuntime({ ctx, bridge: {
    activity: activity => { if (!connected) return false; activities.push(activity); return true },
    logEvent: (type, data, severity) => logs.push({ type, data, severity }),
  } })
  runtime.setMode({ enabled: true, turnId: 'turn-confirm' })
  runtime.claim({ session: { id: 'session-a' } }, 1)
  const tool = tools.get('agent_request_confirmation')
  assert.ok(tool, 'the tool is registered for the armed turn')
  const exec = { agent: { session: { id: 'session-a' } } }

  await assert.rejects(tool.execute({ action: 'x', target: 'y' }, {}), error => error.code === 'CONFIRM_NO_ACTIVE_TURN')
  assert.equal(activities.length, 0)
  const result = await tool.execute({ action: 'Submit the assignment for grading', target: 'Submit for Grading button' }, exec)
  assert.equal(result.structuredContent.recorded, true)
  assert.match(result.content[0].text, /Do not perform the action in this turn/u)
  assert.match(result.content[0].text, /End your turn now/u)
  assert.deepEqual(activities, [{ kind: 'confirm-request', action: 'Submit the assignment for grading', target: 'Submit for Grading button' }])
  assert.ok(!JSON.stringify(logs).includes('Submit the assignment'), 'the action is chat content, not diagnostics')

  // Bridge down: the model is told plainly, so it does not promise an approval prompt.
  connected = false
  await assert.rejects(tool.execute({ action: 'Send the message.', target: 'Send button' }, exec), error => error.code === 'CONFIRM_NOT_DELIVERED')
  assert.equal(activities.length, 1)
  assert.deepEqual(logs.filter(entry => entry.type === 'confirm.requested').map(entry => [entry.data.delivered, entry.severity]), [[true, 'info'], [false, 'warn']])

  // Turn end retires the tool; a new unarmed turn does not bring it back.
  runtime.endTurn({ id: 'session-a' }, 1)
  assert.equal(tools.has('agent_request_confirmation'), false)
  runtime.claim({ session: { id: 'session-a' } }, 2)
  assert.equal(tools.has('agent_request_confirmation'), false)
  runtime.dispose()
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

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for provider condition')
}

test('a real confirm.mode frame activates agent_request_confirmation only for the armed turn', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const activities = []
  let toolsSocket
  server.on('connection', ws => {
    toolsSocket = ws
    ws.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
      else if (message.type === 'activity') activities.push(message.activity)
    })
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: `ws://127.0.0.1:${server.address().port}/bridge`, bridgeToken: 'test', requestTimeoutMs: 500 })
  t.after(async () => {
    fake.dispose()
    for (const client of server.clients) client.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  await waitFor(() => toolsSocket?.readyState === 1)
  assert.equal(fake.tools.has('agent_request_confirmation'), false, 'ordinary startup has only the standing tools')
  const standingCount = fake.tools.size

  // An ordinary turn: no confirm.mode armed, the tool stays absent.
  const session = { id: 'session-confirm', surface: { nodes: [] }, append: () => {} }
  const agent = { session, steer: () => {} }
  await fake.listeners.get('agent/request')({ agent, turn: 1 }, async () => ({}))
  assert.equal(fake.tools.has('agent_request_confirmation'), false)
  assert.equal(fake.tools.size, standingCount)

  // The companion arms the next turn.
  toolsSocket.send(JSON.stringify({ v: 1, type: 'confirm.mode', turnId: 'turn-armed', enabled: true }))
  await new Promise(resolve => setTimeout(resolve, 30))
  let visibleAtAssembly = false
  await fake.listeners.get('agent/request')({ agent, turn: 2 }, async () => {
    visibleAtAssembly = fake.tools.has('agent_request_confirmation')
    return {}
  })
  assert.equal(visibleAtAssembly, true)
  assert.equal(fake.tools.size, standingCount + 1, 'the conditional tool is the only addition')

  const exec = { callId: 'confirm-call-1', agent, signal: new AbortController().signal }
  await assert.rejects(fake.tools.get('agent_request_confirmation').execute({ action: 'x' }, exec), /CONFIRM_INVALID/u)
  const result = await fake.tools.get('agent_request_confirmation').execute({ action: 'Delete the file', target: 'Delete button' }, exec)
  assert.equal(result.structuredContent.recorded, true)
  await waitFor(() => activities.some(activity => activity.kind === 'confirm-request'))
  assert.deepEqual(activities.find(activity => activity.kind === 'confirm-request'), { kind: 'confirm-request', action: 'Delete the file', target: 'Delete button' })

  // DSH deep-freezes committed session events; the tool is retired without annotating one.
  const frozen = Object.freeze({ type: 'turn/end', data: Object.freeze({ turn: 2, reason: Object.freeze({ kind: 'completed' }) }) })
  assert.doesNotThrow(() => fake.listeners.get('session/event')(session, frozen))
  assert.equal(fake.tools.has('agent_request_confirmation'), false, 'the confirm tool is retired even though the event is frozen')
  assert.deepEqual(Object.keys(frozen.data), ['turn', 'reason'])

  // Disarmed again: the following turn has only the standing tools.
  toolsSocket.send(JSON.stringify({ v: 1, type: 'confirm.mode', turnId: null, enabled: false }))
  await new Promise(resolve => setTimeout(resolve, 30))
  await fake.listeners.get('agent/request')({ agent, turn: 3 }, async () => ({}))
  assert.equal(fake.tools.has('agent_request_confirmation'), false)
  assert.equal(fake.tools.size, standingCount)
})

test('plan and confirmation modes coexist on one armed turn without touching the standing count', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  let toolsSocket
  server.on('connection', ws => {
    toolsSocket = ws
    ws.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
    })
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: `ws://127.0.0.1:${server.address().port}/bridge`, bridgeToken: 'test', requestTimeoutMs: 500 })
  t.after(async () => {
    fake.dispose()
    for (const client of server.clients) client.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  await waitFor(() => toolsSocket?.readyState === 1)
  const standingCount = fake.tools.size
  toolsSocket.send(JSON.stringify({ v: 1, type: 'plan.mode', turnId: 'turn-both', enabled: true }))
  toolsSocket.send(JSON.stringify({ v: 1, type: 'confirm.mode', turnId: 'turn-both', enabled: true }))
  await new Promise(resolve => setTimeout(resolve, 30))
  const session = { id: 'session-both', surface: { nodes: [] }, append: () => {} }
  await fake.listeners.get('agent/request')({ agent: { session, steer: () => {} }, turn: 1 }, async () => ({}))
  assert.equal(fake.tools.has('browser_plan'), true)
  assert.equal(fake.tools.has('agent_request_confirmation'), true)
  assert.equal(fake.tools.size, standingCount + 2)
  const frozen = Object.freeze({ type: 'turn/end', data: Object.freeze({ turn: 1, reason: Object.freeze({ kind: 'completed' }) }) })
  fake.listeners.get('session/event')(session, frozen)
  assert.equal(fake.tools.size, standingCount)
})
