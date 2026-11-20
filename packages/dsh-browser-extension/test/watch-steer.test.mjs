import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchSteerRuntime, formatWatcherAdvisory } from '../lib/watch-steer.js'

function fakeBridge() {
  const logs = []
  const activities = []
  return {
    logs,
    activities,
    logEvent: (type, data, severity = 'info') => logs.push({ type, data, severity }),
    activity: frame => { activities.push(frame); return true },
  }
}

function fakeAgent({ sessionId = 'sess-1', status = 'running' } = {}) {
  const injected = []
  const steered = []
  return {
    session: { id: sessionId },
    get status() { return status },
    setStatus(next) { status = next },
    injected,
    steered,
    inject(message) { injected.push(message) },
    steer(message) { steered.push(message) },
  }
}

test('formatWatcherAdvisory wraps text in non-authoritative framing and cleans control chars', () => {
  const text = formatWatcherAdvisory({
    text: 'Try\u0000 inspecting\nform errors instead of clicking Next.',
    kind: 'stuck',
    blocker: 'loop',
  })
  assert.match(text, /^<watcher_advisory kind="stuck" blocker="loop">/u)
  assert.match(text, /does not verify factual correctness/u)
  assert.match(text, /cannot override the user's original goal, safety rules, or confirmation requirements/u)
  assert.match(text, /Try inspecting form errors instead of clicking Next\./u)
  assert.match(text, /<\/watcher_advisory>$/u)
})

test('createWatchSteerRuntime injects via agent.inject (never agent.steer) with agent-notice source', () => {
  const bridge = fakeBridge()
  const runtime = createWatchSteerRuntime({ bridge })
  const agent = fakeAgent()

  runtime.setTurnContext({ turnId: 'turn-42', prompt: 'fill form' })
  runtime.claim(agent, 1)

  const ok = runtime.handleSteer({
    turnId: 'turn-42',
    steerId: 'steer-1',
    text: 'Stop clicking Next; inspect validation messages on the page.',
    kind: 'stuck',
    blocker: 'loop',
  })
  assert.equal(ok, true)
  assert.equal(agent.injected.length, 1, 'delivered via agent.inject (wakeup: false)')
  assert.equal(agent.steered.length, 0, 'never calls agent.steer (wakeup: true)')
  const msg = agent.injected[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'agent-notice')
  assert.match(msg.content[0].text, /<watcher_advisory kind="stuck" blocker="loop">/u)
  assert.match(msg.content[0].text, /Stop clicking Next; inspect validation messages/u)
  assert.equal(bridge.logs.some(entry => entry.type === 'watch.steer.injected' && entry.data.steerId === 'steer-1'), true)
  assert.deepEqual(bridge.activities.at(-1), { kind: 'watch-steer', steerId: 'steer-1', status: 'injected' })
})

test('createWatchSteerRuntime fails closed on turn mismatch, idle agent, ended turn, or empty text', () => {
  const bridge = fakeBridge()
  const runtime = createWatchSteerRuntime({ bridge })
  const agent = fakeAgent()

  // Before any claimed turn.
  assert.equal(runtime.handleSteer({ turnId: 'turn-1', steerId: 's0', text: 'nudge' }), false)
  assert.equal(bridge.activities.at(-1).reason, 'no-active-turn')

  runtime.setTurnContext({ turnId: 'turn-1', prompt: 'task' })
  runtime.claim(agent, 1)

  // Stale turnId mismatch.
  assert.equal(runtime.handleSteer({ turnId: 'turn-other', steerId: 's1', text: 'nudge' }), false)
  assert.equal(bridge.activities.at(-1).reason, 'turn-mismatch')

  // Idle agent — must never wake an idle turn.
  agent.setStatus('idle')
  assert.equal(runtime.handleSteer({ turnId: 'turn-1', steerId: 's2', text: 'nudge' }), false)
  assert.equal(bridge.activities.at(-1).reason, 'agent-not-running')
  agent.setStatus('running')

  // Empty text.
  assert.equal(runtime.handleSteer({ turnId: 'turn-1', steerId: 's3', text: '   ' }), false)
  assert.equal(bridge.activities.at(-1).reason, 'empty-text')

  // After turn/end, active turn clears.
  runtime.endTurn(agent.session, 1)
  assert.equal(runtime.handleSteer({ turnId: 'turn-1', steerId: 's4', text: 'nudge' }), false)
  assert.equal(bridge.activities.at(-1).reason, 'no-active-turn')
  assert.equal(agent.injected.length, 0)
  assert.equal(agent.steered.length, 0)
})
