import test from 'node:test'
import assert from 'node:assert/strict'
import { BUSY_MESSAGE, NOT_READY_MESSAGE, STOPPING_MESSAGE, SessionController, uiRejectionFrame } from '../session-controller.mjs'
import { FakeRunner, fakeBridge, fakeLogStore } from './remote-fixtures.mjs'

function setup(options = {}) {
  const runner = options.runner === null ? undefined : (options.runner ?? new FakeRunner())
  const bridge = fakeBridge()
  const frames = []
  const observed = []
  const controller = new SessionController({
    bridge,
    getRunner: () => runner,
    isDisabled: () => options.disabled === true,
    logStore: fakeLogStore(),
    autoCapture: options.autoCapture ?? false,
    provider: 'openrouter',
    getModelId: () => 'model-x',
    publish: frame => frames.push(frame),
    observers: [{ turnStarted: info => observed.push(['start', info]), turnEnded: info => observed.push(['end', info]) }],
  })
  return { controller, runner, bridge, frames, observed }
}

test('submit reserves the single turn slot synchronously', async () => {
  const { controller, runner, frames, observed } = setup()
  const first = controller.submit({ text: ' hi ', origin: 'remote', clientMessageId: 'client-0001' })
  const second = controller.submit({ text: 'again', origin: 'ui' })
  assert.equal(first.ok, true)
  assert.deepEqual(second, { ok: false, code: 'TURN_BUSY', message: BUSY_MESSAGE, retryable: true })
  assert.equal(runner.runs.length, 1)
  assert.equal(observed[0][0], 'start')
  assert.equal(observed[0][1].text, 'hi')
  assert.equal(observed[0][1].origin, 'remote')
  assert.equal(observed[0][1].clientMessageId, 'client-0001')

  runner.assistant('answer')
  runner.current.resolve('final')
  await first.done
  assert.equal(controller.running, false)
  assert.deepEqual(observed.at(-1), ['end', { turnId: first.turnId, outcome: 'done', sessionId: 'session-1' }])
  const types = frames.map(frame => frame.type)
  assert.ok(types.includes('chat.assistant'))
  assert.ok(types.includes('chat.done'))
  assert.equal(frames.find(frame => frame.type === 'chat.done').text, 'final')
})

test('empty prompts, bad attachments, and an unready runtime are rejected without a turn', () => {
  assert.equal(setup().controller.submit({ text: '   ' }).code, 'EMPTY_PROMPT')
  const bad = setup().controller.submit({ text: 'x', images: [{ mimeType: 'text/plain', data: 'AAAA' }] })
  assert.equal(bad.code, 'INVALID_ATTACHMENT')
  assert.deepEqual(setup({ runner: null }).controller.submit({ text: 'x' }), { ok: false, code: 'RUNTIME_NOT_READY', message: NOT_READY_MESSAGE, retryable: true })
  assert.equal(setup({ disabled: true }).controller.submit({ text: 'x' }).code, 'RUNTIME_NOT_READY')
})

test('stop interrupts once, reports stopping then stopped, and the slot frees afterwards', async () => {
  const { controller, runner, frames, observed } = setup()
  const turn = controller.submit({ text: 'work' })
  const stop = controller.stop()
  assert.equal(stop.state, 'stopping')
  assert.equal(controller.submit({ text: 'during stop' }).message, STOPPING_MESSAGE)
  assert.equal(controller.stop().state, 'already-stopping')
  await stop.done
  await turn.done
  assert.equal(runner.interrupts, 1)
  const types = frames.map(frame => frame.type)
  assert.ok(types.indexOf('chat.stopping') < types.indexOf('chat.stopped'))
  assert.equal(frames.find(frame => frame.type === 'chat.stopped').reason, 'user')
  assert.equal(observed.at(-1)[1].outcome, 'stopped')
  assert.equal(controller.running, false)
  assert.equal(controller.stop().state, 'idle')
})

test('a run error publishes chat.error and ends the turn as error', async () => {
  const { controller, runner, frames, observed } = setup()
  const turn = controller.submit({ text: 'work' })
  runner.current.reject(new Error('model failed'))
  await turn.done
  assert.equal(frames.find(frame => frame.type === 'chat.error').message, 'model failed')
  assert.deepEqual(observed.at(-1)[1], { turnId: turn.turnId, outcome: 'error', error: 'model failed' })
})

test('stop during auto-capture ends the turn without starting the model', async () => {
  const { controller, runner, bridge } = setup({ autoCapture: true })
  let release
  bridge.requestUi = () => new Promise(resolve => { release = resolve })
  const turn = controller.submit({ text: 'work' })
  controller.stop()
  release({})
  await turn.done
  assert.equal(runner.runs.length, 0)
})

test('new chat refuses while running and blocks submissions while switching', async () => {
  const { controller, runner, frames } = setup()
  const turn = controller.submit({ text: 'work' })
  assert.equal((await controller.newChat()).code, 'TURN_BUSY')
  runner.current.resolve()
  await turn.done

  let release
  const original = runner.newSession.bind(runner)
  runner.newSession = () => new Promise(resolve => { release = () => resolve(original()) })
  const pending = controller.newChat()
  assert.equal(controller.submit({ text: 'mid-switch' }).code, 'SESSION_CHANGING')
  release()
  const result = await pending
  assert.deepEqual(result, { ok: true, sessionId: 'session-2' })
  assert.equal(frames.filter(frame => frame.type === 'chat.session').at(-1).sessionId, 'session-2')
  assert.equal(controller.sessionChanging, false)
})

test('a remote-origin turn tells the panel its prompt; a panel turn does not echo', async () => {
  const remote = setup()
  const turn = remote.controller.submit({ text: 'from phone', origin: 'remote', images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }] })
  const user = remote.frames.find(frame => frame.type === 'chat.user')
  assert.deepEqual(user, { v: 1, type: 'chat.user', turnId: turn.turnId, origin: 'remote', text: 'from phone', imageCount: 1 })
  assert.ok(!('images' in user), 'image bytes are not echoed to the panel')
  assert.ok(remote.frames.indexOf(user) < remote.frames.findIndex(frame => frame.type === 'chat.status'), 'the prompt precedes the turn status')
  remote.runner.current.resolve()
  await turn.done

  const panel = setup()
  const own = panel.controller.submit({ text: 'from panel', origin: 'ui' })
  assert.ok(!panel.frames.some(frame => frame.type === 'chat.user'))
  panel.runner.current.resolve()
  await own.done
})

test('panel plan mode reaches the turn, prompt, and done metadata', async () => {
  const { controller, runner, bridge, frames, observed } = setup()
  const turn = controller.submit({ text: 'complete the long task', origin: 'ui', planMode: true })
  assert.deepEqual(bridge.turnModes[0], { id: turn.turnId, planMode: true })
  assert.equal(observed[0][1].planMode, true)
  assert.match(runner.runs[0][0].text, /<plan_mode>/)
  assert.match(runner.runs[0][0].text, /browser_plan/)

  runner.current.notify({
    method: 'session.event',
    params: {
      sessionId: runner.sessionId,
      event: { type: 'turn/end', data: { turn: 1, planOutcome: 'unfinished', planRevision: 2 } },
    },
  })
  runner.current.resolve('Open work remains')
  await turn.done
  const done = frames.find(frame => frame.type === 'chat.done')
  assert.equal(done.planMode, true)
  assert.equal(done.planOutcome, 'unfinished')
  assert.equal(done.planRevision, 2)
  assert.deepEqual(bridge.turnModes.at(-1), { id: undefined, planMode: false })
})

test('remote prompts opt into plan mode only explicitly and ordinary prompts stay unarmed', async () => {
  const remote = setup()
  const turn = remote.controller.submit({ text: 'from phone', origin: 'remote', planMode: true })
  assert.deepEqual(remote.bridge.turnModes[0], { id: turn.turnId, planMode: true })
  assert.equal(remote.observed[0][1].planMode, true)
  assert.match(remote.runner.runs[0][0].text, /<plan_mode>|browser_plan/)
  remote.runner.current.resolve()
  await turn.done
  assert.equal(remote.frames.find(frame => frame.type === 'chat.done').planMode, true)

  const ordinary = setup()
  const own = ordinary.controller.submit({ text: 'ordinary panel task', origin: 'ui' })
  assert.equal(ordinary.observed[0][1].planMode, false)
  assert.doesNotMatch(ordinary.runner.runs[0][0].text, /<plan_mode>|browser_plan/)
  ordinary.runner.current.resolve()
  await own.done
  assert.equal(ordinary.frames.find(frame => frame.type === 'chat.done').planMode, false)
})

test('panel rejection frames carry the refusal code', () => {
  assert.deepEqual(uiRejectionFrame({ code: 'TURN_BUSY', message: BUSY_MESSAGE }), {
    v: 1, type: 'chat.error', code: 'TURN_BUSY', message: BUSY_MESSAGE, recoverable: true,
  })
})

test('steer stops the running turn and starts the new message in the freed slot', async () => {
  const { controller, runner, frames, observed } = setup()
  const first = controller.submit({ text: 'long task', origin: 'ui' })
  await runner.started()
  const steer = controller.submit({ text: ' go left instead ', origin: 'remote', clientMessageId: 'client-0002', steer: true })
  assert.equal(steer.ok, true)
  assert.equal(steer.steered, true)
  assert.notEqual(steer.turnId, first.turnId)
  // A second steer and a plain send both wait their turn; nothing else is interrupted.
  assert.equal(controller.submit({ text: 'another', steer: true }).code, 'STEER_PENDING')
  assert.equal(controller.submit({ text: 'plain' }).code, 'TURN_STOPPING')
  assert.equal((await controller.newChat()).ok, false)

  await first.done
  assert.equal(runner.interrupts, 1)
  // The steered turn owns the slot immediately after the stopped one releases it.
  assert.equal(controller.running, true)
  assert.equal(controller.turnId, steer.turnId)
  assert.equal(controller.stopRequested, false)
  await runner.started()
  assert.equal(runner.runs.length, 2)
  assert.match(runner.runs[1][0].text, /go left instead/)
  runner.current.resolve('went left')
  await steer.done
  assert.equal(controller.running, false)

  assert.deepEqual(observed.map(([hook, info]) => [hook, info.turnId, info.outcome ?? info.text]), [
    ['start', first.turnId, 'long task'],
    ['end', first.turnId, 'stopped'],
    ['start', steer.turnId, 'go left instead'],
    ['end', steer.turnId, 'done'],
  ])
  assert.equal(observed[2][1].clientMessageId, 'client-0002')
  const types = frames.map(frame => frame.type).filter(type => type !== 'chat.status')
  assert.deepEqual(types, ['chat.stopping', 'chat.stopped', 'chat.user', 'chat.done'])
})

test('steer while idle is an ordinary send, and a steer after Stop does not interrupt twice', async () => {
  const { controller, runner } = setup()
  const idle = controller.submit({ text: 'hello', steer: true })
  assert.equal(idle.ok, true)
  assert.equal(idle.steered, undefined)
  await runner.started()
  controller.stop()
  const steer = controller.submit({ text: 'new direction', steer: true })
  assert.equal(steer.steered, true)
  await idle.done
  await runner.started()
  assert.equal(runner.interrupts, 1)
  runner.current.resolve()
  await steer.done
})

test('a steer that cannot start reports an error and frees the slot', async () => {
  let disabled = false
  const runner = new FakeRunner()
  const frames = []
  const controller = new SessionController({
    bridge: fakeBridge(), getRunner: () => runner, isDisabled: () => disabled, logStore: fakeLogStore(), autoCapture: false,
    provider: 'openrouter', getModelId: () => 'model-x', publish: frame => frames.push(frame),
  })
  const first = controller.submit({ text: 'task' })
  await runner.started()
  const steer = controller.submit({ text: 'redirect', steer: true })
  disabled = true
  await first.done
  await steer.done
  assert.equal(controller.running, false)
  assert.equal(runner.runs.length, 1)
  assert.equal(frames.at(-1).type, 'chat.error')
  assert.equal(frames.at(-1).code, 'RUNTIME_NOT_READY')
})

test('resume switches to a saved session only when idle and keeps the current one on failure', async () => {
  const { controller, runner, frames } = setup()
  runner.unresumable = new Set(['session-gone'])
  assert.deepEqual(await controller.resumeChat('session-1'), { ok: true, sessionId: 'session-1', already: true })
  assert.equal(frames.length, 0)

  const resumed = await controller.resumeChat('session-old')
  assert.deepEqual(resumed, { ok: true, sessionId: 'session-old' })
  assert.equal(runner.sessionId, 'session-old')
  assert.deepEqual(frames.find(frame => frame.type === 'chat.session'), { v: 1, type: 'chat.session', sessionId: 'session-old', resumed: true })

  const gone = await controller.resumeChat('session-gone')
  assert.equal(gone.ok, false)
  assert.equal(gone.code, 'SESSION_NOT_RESUMABLE')
  assert.equal(runner.sessionId, 'session-old')
  assert.equal(controller.sessionChanging, false)

  const turn = controller.submit({ text: 'continue' })
  await runner.started()
  assert.equal((await controller.resumeChat('session-1')).code, 'TURN_BUSY')
  runner.current.resolve()
  await turn.done
})
