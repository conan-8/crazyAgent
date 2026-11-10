import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'

function makeContext() {
  const tools = new Map()
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { info: () => {} },
    browserUse: { register: () => () => {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      getSectionOrder: () => 3000,
      section: () => () => {},
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(fn) {
      const iterator = fn()
      let step = iterator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = iterator.next()
      }
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    },
  }
  return {
    ctx,
    tools,
    listeners,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for provider condition')
}

test('a real plan.mode frame activates browser_plan before assembly and retires it at turn end', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const activities = []
  let toolsSocket
  server.on('connection', ws => {
    toolsSocket = ws
    ws.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') {
        ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
      } else if (message.type === 'activity') {
        activities.push(message.activity)
      }
    })
  })
  const fake = makeContext()
  apply(fake.ctx, {
    bridgeUrl: `ws://127.0.0.1:${server.address().port}/bridge`,
    bridgeToken: 'test',
    requestTimeoutMs: 500,
  })
  t.after(async () => {
    fake.dispose()
    for (const client of server.clients) client.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  await waitFor(() => toolsSocket?.readyState === 1)
  assert.equal(fake.tools.has('browser_plan'), false, 'ordinary startup has only the standing tools')

  toolsSocket.send(JSON.stringify({ v: 1, type: 'plan.mode', turnId: 'turn-explicit-plan', enabled: true }))
  await new Promise(resolve => setTimeout(resolve, 30))
  const session = { id: 'session-plan', surface: { nodes: [] }, append: () => {} }
  const agent = { session, steer: () => {} }
  let visibleAtAssembly = false
  await fake.listeners.get('agent/request')({ agent, turn: 1 }, async () => {
    visibleAtAssembly = fake.tools.has('browser_plan')
    return {}
  })
  assert.equal(visibleAtAssembly, true)

  const result = await fake.tools.get('browser_plan').execute({
    items: [
      { content: 'Inspect the current state', status: 'in_progress' },
      { content: 'Apply the change', status: 'pending' },
      { content: 'Verify the final state', status: 'pending' },
    ],
    expected_revision: 0,
  }, {
    callId: 'plan-call-1',
    agent,
    signal: new AbortController().signal,
  })
  assert.equal(result.structuredContent.revision, 1)
  await waitFor(() => activities.some(activity => activity.kind === 'plan'))
  assert.deepEqual(activities.at(-1).items.map(item => item.status), ['in_progress', 'pending', 'pending'])

  // DSH deep-freezes committed session events, so the outcome cannot be
  // written onto turn/end: it travels as a turn-outcome activity instead.
  const ending = Object.freeze({ type: 'turn/end', data: Object.freeze({ turn: 1, reason: Object.freeze({ kind: 'completed' }) }) })
  fake.listeners.get('session/event')(session, ending)
  assert.equal(fake.tools.has('browser_plan'), false, 'the plan tool is retired even though the event is frozen')
  await waitFor(() => activities.some(activity => activity.kind === 'turn-outcome'))
  const outcome = activities.find(activity => activity.kind === 'turn-outcome')
  assert.deepEqual(
    { sessionId: outcome.sessionId, turn: outcome.turn, planOutcome: outcome.planOutcome, planRevision: outcome.planRevision },
    { sessionId: 'session-plan', turn: 1, planOutcome: 'unfinished', planRevision: 1 },
  )
  assert.deepEqual(Object.keys(ending.data), ['turn', 'reason'])

  let visibleNextTurn = true
  await fake.listeners.get('agent/request')({ agent, turn: 2 }, async () => {
    visibleNextTurn = fake.tools.has('browser_plan')
    return {}
  })
  assert.equal(visibleNextTurn, false)
})
