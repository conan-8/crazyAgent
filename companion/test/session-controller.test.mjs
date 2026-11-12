import test from 'node:test'
import assert from 'node:assert/strict'
import { BUSY_MESSAGE, NOT_READY_MESSAGE, STOPPING_MESSAGE, SessionController, confirmationPromptBlock, normalizeConfirmRequest, parseReportedLabel, uiRejectionFrame } from '../session-controller.mjs'
import { FakeRunner, fakeBridge, fakeLogStore } from './remote-fixtures.mjs'

function setup(options = {}) {
  const runner = options.runner === null ? undefined : (options.runner ?? new FakeRunner())
  const bridge = fakeBridge()
  const frames = []
  const observed = []
  const logStore = fakeLogStore()
  const controller = new SessionController({
    bridge,
    getRunner: () => runner,
    isDisabled: () => options.disabled === true,
    logStore,
    autoCapture: options.autoCapture ?? false,
    provider: 'openrouter',
    getModelId: () => 'model-x',
    getConfirmIrreversible: () => options.confirmIrreversible === true,
    publish: frame => frames.push(frame),
    observers: [{ turnStarted: info => observed.push(['start', info]), turnEnded: info => observed.push(['end', info]) }],
  })
  return { controller, runner, bridge, frames, observed, logStore }
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
  const ended = observed.at(-1)
  assert.equal(ended[0], 'end')
  assert.equal(ended[1].turnId, first.turnId)
  assert.equal(ended[1].outcome, 'done')
  assert.equal(ended[1].sessionId, 'session-1')
  assert.equal(ended[1].label, null)
  assert.equal(ended[1].timings.failedCalls, 0)
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

test('stop interrupts once, preserves the session ID, reports stopping then stopped, and frees the slot', async () => {
  const { controller, runner, frames, observed } = setup()
  const turn = controller.submit({ text: 'work' })
  assert.deepEqual(frames[0], { v: 1, type: 'chat.session', sessionId: 'session-1' })
  const interrupt = runner.interrupt.bind(runner)
  runner.interrupt = async () => {
    const result = await interrupt()
    runner.resumeSessionId = result.sessionId
    runner.sessionId = undefined
    return result
  }
  const stop = controller.stop()
  assert.equal(stop.state, 'stopping')
  assert.equal(controller.submit({ text: 'during stop' }).message, STOPPING_MESSAGE)
  assert.equal(controller.stop().state, 'already-stopping')
  await stop.done
  await turn.done
  assert.equal(runner.interrupts, 1)
  const types = frames.map(frame => frame.type)
  assert.ok(types.indexOf('chat.stopping') < types.indexOf('chat.stopped'))
  const stopped = frames.find(frame => frame.type === 'chat.stopped')
  assert.equal(stopped.reason, 'user')
  assert.equal(stopped.sessionId, 'session-1')
  assert.equal(observed.at(-1)[1].outcome, 'stopped')
  assert.equal(observed.at(-1)[1].sessionId, 'session-1')
  assert.equal(controller.running, false)
  assert.equal(controller.stop().state, 'idle')
})

test('a run error publishes chat.error and ends the turn as error', async () => {
  const { controller, runner, frames, observed } = setup()
  const turn = controller.submit({ text: 'work' })
  runner.current.reject(new Error('model failed'))
  await turn.done
  assert.equal(frames.find(frame => frame.type === 'chat.error').message, 'model failed')
  const ended = observed.at(-1)[1]
  assert.equal(ended.turnId, turn.turnId)
  assert.equal(ended.outcome, 'error')
  assert.equal(ended.error, 'model failed')
  assert.equal(ended.label, null)
  assert.equal(ended.timings.failedCalls, 0)
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

test('provider turn-outcome reaches plan and Docs metadata without annotating turn/end', async () => {
  const { controller, runner, bridge, frames, observed } = setup()
  const turn = controller.submit({ text: 'complete the long task', origin: 'ui', planMode: true })
  assert.deepEqual(bridge.turnModes[0], { id: turn.turnId, planMode: true })
  assert.equal(observed[0][1].planMode, true)
  assert.match(runner.runs[0][0].text, /<plan_mode>/)
  assert.match(runner.runs[0][0].text, /browser_plan/)

  controller.noteActivity({
    kind: 'turn-outcome',
    turnId: turn.turnId,
    sessionId: runner.sessionId,
    turn: 1,
    planOutcome: 'unfinished',
    planRevision: 2,
    docsVerification: 'unverified',
    docsVerificationReason: 'read-error',
  })
  runner.current.resolve('Open work remains')
  await turn.done
  const done = frames.find(frame => frame.type === 'chat.done')
  assert.equal(done.planMode, true)
  assert.equal(done.planOutcome, 'unfinished')
  assert.equal(done.planRevision, 2)
  assert.equal(done.docsVerification, 'unverified')
  assert.equal(done.docsVerificationReason, 'read-error')
  assert.deepEqual(bridge.turnModes.at(-1), { id: undefined, planMode: false })
})

test('turn-outcome ignores stale turns, sessions, and malformed values and resets between turns', async () => {
  const { controller, runner, frames } = setup()
  const first = controller.submit({ text: 'first planned task', planMode: true })
  controller.noteActivity({ kind: 'turn-outcome', turnId: 'turn-old', sessionId: runner.sessionId, turn: 1, planOutcome: 'blocked', docsVerification: 'unverified' })
  controller.noteActivity({ kind: 'turn-outcome', turnId: first.turnId, sessionId: 'session-old', turn: 1, planOutcome: 'blocked', docsVerification: 'unverified' })
  controller.noteActivity({ kind: 'turn-outcome', turnId: first.turnId, sessionId: runner.sessionId, turn: 'one', planOutcome: 'blocked', docsVerification: 'unverified' })
  controller.noteActivity({ kind: 'turn-outcome', turnId: first.turnId, sessionId: runner.sessionId, turn: 1, planOutcome: 'success', planRevision: -1, docsVerification: 'unknown' })
  runner.current.resolve('first response')
  await first.done
  const firstDone = frames.find(frame => frame.type === 'chat.done')
  assert.equal(firstDone.planOutcome, undefined)
  assert.equal(firstDone.planRevision, undefined)
  assert.equal(firstDone.docsVerification, undefined)

  const second = controller.submit({ text: 'second planned task', planMode: true })
  controller.noteActivity({ kind: 'turn-outcome', turnId: second.turnId, sessionId: runner.sessionId, turn: 2, planOutcome: 'blocked', planRevision: 3 })
  runner.current.resolve('second response')
  await second.done
  const secondDone = frames.filter(frame => frame.type === 'chat.done').at(-1)
  assert.equal(secondDone.planOutcome, 'blocked')
  assert.equal(secondDone.planRevision, 3)

  const third = controller.submit({ text: 'ordinary task' })
  runner.current.resolve('ordinary response')
  await third.done
  const thirdDone = frames.filter(frame => frame.type === 'chat.done').at(-1)
  assert.equal(thirdDone.planOutcome, undefined)
  assert.equal(thirdDone.planRevision, undefined)
  assert.equal(thirdDone.docsVerification, undefined)
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

test('normalizeConfirmRequest accepts only the strict shape and confirmationPromptBlock escapes the action', () => {
  assert.deepEqual(normalizeConfirmRequest({ action: '  Submit it.  ', target: ' Submit ' }), { action: 'Submit it.', target: 'Submit' })
  for (const bad of [null, 'x', [], {}, { action: 'x' }, { target: 'x' }, { action: '', target: 'x' }, { action: 'x', target: '  ' }, { action: 5, target: 'x' }]) {
    assert.equal(normalizeConfirmRequest(bad), undefined, JSON.stringify(bad))
  }
  assert.equal(normalizeConfirmRequest({ action: 'x'.repeat(300), target: 'y' }).action.length, 200)
  assert.equal(confirmationPromptBlock('approve', 'Submit "A" & <B>'), '<user_confirmation decision="approve" action="Submit &quot;A&quot; &amp; &lt;B&gt;"/>')
  assert.equal(confirmationPromptBlock('deny', 'Delete it'), '<user_confirmation decision="deny" action="Delete it"/>')
})

test('a confirmation request ends the turn waiting; approve writes the companion block and consumes the request', async () => {
  const { controller, runner, bridge, frames, observed } = setup({ confirmIrreversible: true })
  bridge.requestUi = async command => {
    bridge.requests.push(command)
    return command.op === 'snapshot' ? { image: { data: 'AAAA', mimeType: 'image/jpeg' } } : {}
  }
  const turn = controller.submit({ text: 'fill in the form and submit it', origin: 'remote' })
  assert.deepEqual(bridge.turnOptions[0], { id: turn.turnId, planMode: false, confirmMode: true })
  assert.match(runner.runs[0][0].text, /<confirm_mode>/)
  assert.match(runner.runs[0][0].text, /agent_request_confirmation/)

  controller.noteActivity({ kind: 'confirm-request', turnId: turn.turnId, action: 'Submit the assignment for grading', target: 'Submit for Grading button' })
  runner.current.resolve('BLOCKED — waiting for your approval to submit.')
  await turn.done

  const done = frames.find(frame => frame.type === 'chat.done')
  assert.deepEqual(done.confirm, { action: 'Submit the assignment for grading', target: 'Submit for Grading button' })
  assert.equal(done.help, undefined)
  const ended = observed.at(-1)[1]
  assert.equal(ended.outcome, 'done')
  assert.deepEqual(ended.confirm, { action: 'Submit the assignment for grading', target: 'Submit for Grading button', captureError: null })
  assert.ok(controller.pendingConfirmation, 'the chat waits for an answer')
  assert.equal(controller.pendingConfirmation.action, 'Submit the assignment for grading')
  // The confirm capture is a companion-made snapshot, cleaned up afterwards.
  assert.ok(bridge.requests.some(request => request.op === 'snapshot'))
  assert.ok(bridge.requests.some(request => request.op === 'labels.clear'))

  // Approve with no extra text: the companion writes the decision block.
  const answer = controller.submit({ text: '', confirm: 'approve', origin: 'remote' })
  assert.equal(answer.ok, true)
  assert.equal(controller.pendingConfirmation, undefined)
  assert.equal(runner.runs[1][0].text.endsWith('<user_confirmation decision="approve" action="Submit the assignment for grading"/>'), true)
  runner.current.resolve('DONE — submitted.')
  await answer.done
  const answerDone = frames.filter(frame => frame.type === 'chat.done').at(-1)
  assert.equal(answerDone.confirm, undefined)

  // Nothing is pending anymore: a second approve is refused, not replayed.
  assert.deepEqual(controller.submit({ text: '', confirm: 'approve' }), {
    ok: false, code: 'NO_CONFIRMATION_PENDING', message: 'No confirmation is waiting for an answer in this chat. Send an ordinary prompt instead.', retryable: false,
  })
  assert.equal(runner.runs.length, 2)
})

test('deny writes a deny block; an ordinary prompt abandons the request without deciding it', async () => {
  const { controller, runner } = setup({ confirmIrreversible: true })
  const turn = controller.submit({ text: 'send the message' })
  controller.noteActivity({ kind: 'confirm-request', turnId: turn.turnId, action: 'Send the email', target: 'Send button' })
  runner.current.resolve('Waiting for approval.')
  await turn.done

  const denied = controller.submit({ text: 'actually do not send it', confirm: 'deny' })
  assert.equal(denied.ok, true)
  assert.match(runner.runs[1][0].text, /<user_confirmation decision="deny" action="Send the email"\/>\n\nactually do not send it$/u)
  runner.current.resolve('Understood, not sent.')
  await denied.done

  // A fresh request abandoned by an ordinary prompt counts as neither decision.
  const second = controller.submit({ text: 'delete the file' })
  controller.noteActivity({ kind: 'confirm-request', turnId: second.turnId, action: 'Delete the file', target: 'Delete button' })
  runner.current.resolve('Waiting for approval.')
  await second.done
  assert.ok(controller.pendingConfirmation)
  const ordinary = controller.submit({ text: 'never mind, do something else' })
  assert.equal(ordinary.ok, true)
  assert.equal(controller.pendingConfirmation, undefined)
  assert.equal(runner.runs[3][0].text.endsWith('never mind, do something else'), true)
  assert.doesNotMatch(runner.runs[3][0].text, /<user_confirmation decision="[a-z]+" action=/u)
  runner.current.resolve('OK')
  await ordinary.done
  assert.equal(controller.submit({ text: '', confirm: 'approve' }).code, 'NO_CONFIRMATION_PENDING')
})

test('confirm answers are validated, session-scoped, and cleared by new chat or resume', async () => {
  const { controller, runner } = setup({ confirmIrreversible: true })
  assert.equal(controller.submit({ text: '', confirm: 'maybe' }).code, 'INVALID_CONFIRMATION')
  assert.equal(controller.submit({ text: 'x', confirm: 'approve', steer: true }).code, 'INVALID_CONFIRMATION')
  assert.equal(controller.submit({ text: '   ' }).code, 'EMPTY_PROMPT')
  assert.equal(controller.submit({ text: '', confirm: 'approve' }).code, 'NO_CONFIRMATION_PENDING')

  const turn = controller.submit({ text: 'publish the page' })
  controller.noteActivity({ kind: 'confirm-request', turnId: turn.turnId, action: 'Publish the page', target: 'Publish button' })
  runner.current.resolve('Waiting.')
  await turn.done

  // A different session cannot answer this chat's confirmation.
  const other = new FakeRunner('session-other')
  const savedRunner = runner
  Object.defineProperty(controller, 'getRunner', { value: () => other, configurable: true })
  assert.equal(controller.submit({ text: '', confirm: 'approve' }).code, 'NO_CONFIRMATION_PENDING')
  Object.defineProperty(controller, 'getRunner', { value: () => savedRunner, configurable: true })

  // New chat clears the waiting request.
  assert.ok(controller.pendingConfirmation)
  await controller.newChat()
  assert.equal(controller.pendingConfirmation, undefined)
  assert.equal(controller.submit({ text: '', confirm: 'deny' }).code, 'NO_CONFIRMATION_PENDING')

  // And so does resuming another saved chat.
  const third = controller.submit({ text: 'pay the invoice' })
  controller.noteActivity({ kind: 'confirm-request', turnId: third.turnId, action: 'Pay the invoice', target: 'Pay button' })
  runner.current.resolve('Waiting.')
  await third.done
  assert.ok(controller.pendingConfirmation)
  await controller.resumeChat('session-saved')
  assert.equal(controller.pendingConfirmation, undefined)
})

test('stale or malformed confirm activities are ignored and a help request wins over a confirm in the same turn', async () => {
  const { controller, runner, frames } = setup({ confirmIrreversible: true })
  const turn = controller.submit({ text: 'work' })
  controller.noteActivity({ kind: 'confirm-request', turnId: 'turn-old', action: 'x', target: 'y' })
  controller.noteActivity({ kind: 'confirm-request', turnId: turn.turnId, action: '   ', target: 'y' })
  controller.noteActivity({ kind: 'confirm-request', turnId: turn.turnId, action: 'x', target: 5 })
  assert.equal(controller.confirmTurnRequest, undefined)
  controller.noteActivity({ kind: 'confirm-request', turnId: turn.turnId, action: 'Submit it', target: 'Submit button' })
  controller.noteActivity({ kind: 'help-request', turnId: turn.turnId, category: 'login', reason: 'Sign in first.' })
  runner.current.resolve('Blocked.')
  await turn.done
  const done = frames.find(frame => frame.type === 'chat.done')
  assert.deepEqual(done.help, { category: 'login', reason: 'Sign in first.' })
  assert.equal(done.confirm, undefined)
  assert.equal(controller.pendingConfirmation, undefined)
})

test('stop during the confirmation capture ends as stopped, not waiting', async () => {
  const { controller, runner, bridge, frames, observed } = setup({ confirmIrreversible: true })
  let release
  bridge.requestUi = command => {
    bridge.requests.push(command)
    if (command.op === 'snapshot') return new Promise(resolve => { release = resolve })
    return Promise.resolve({})
  }
  const turn = controller.submit({ text: 'submit it' })
  controller.noteActivity({ kind: 'confirm-request', turnId: turn.turnId, action: 'Submit it', target: 'Submit button' })
  runner.current.resolve('Waiting.')
  await new Promise(resolve => setTimeout(resolve, 20))
  controller.stop()
  release({ image: { data: 'AAAA', mimeType: 'image/jpeg' } })
  await turn.done
  assert.equal(observed.at(-1)[1].outcome, 'stopped')
  assert.equal(controller.pendingConfirmation, undefined)
  assert.ok(frames.some(frame => frame.type === 'chat.stopped'))
  assert.ok(!frames.some(frame => frame.type === 'chat.done'))
})

test('with the setting off, turns carry no confirm mode or guidance', async () => {
  const { controller, runner, bridge, frames } = setup()
  const turn = controller.submit({ text: 'submit the form' })
  assert.deepEqual(bridge.turnOptions[0], { id: turn.turnId, planMode: false, confirmMode: false })
  assert.doesNotMatch(runner.runs[0][0].text, /<confirm_mode>|agent_request_confirmation/)
  runner.current.resolve('DONE — submitted.')
  await turn.done
  assert.equal(frames.find(frame => frame.type === 'chat.done').confirm, undefined)
  assert.equal(controller.pendingConfirmation, undefined)
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
  assert.deepEqual(types, ['chat.session', 'chat.stopping', 'chat.stopped', 'chat.session', 'chat.user', 'chat.done'])
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

test('reported completion label is parsed only from a leading word', () => {
  assert.equal(parseReportedLabel('DONE — clicked once'), 'done')
  assert.equal(parseReportedLabel('**Partial** because the sidebar did not answer'), 'partial')
  assert.equal(parseReportedLabel('blocked: sign-in required'), 'blocked')
  assert.equal(parseReportedLabel('  Done.'), 'done')
  assert.equal(parseReportedLabel('`BLOCKED` by CAPTCHA'), 'blocked')
  assert.equal(parseReportedLabel('Donegal is a county'), null)
  assert.equal(parseReportedLabel('The page says done.'), null)
  assert.equal(parseReportedLabel('All set.'), null)
  assert.equal(parseReportedLabel('OK — done'), null)
  assert.equal(parseReportedLabel('PARTIALLY done'), null)
  assert.equal(parseReportedLabel(''), null)
  assert.equal(parseReportedLabel(undefined), null)
})

test('turn.end and chat.done report the model label, failed calls, and token usage', async () => {
  const { controller, runner, frames, observed, logStore } = setup()
  const turn = controller.submit({ text: 'work' })
  await runner.started()
  runner.toolCall('call-1', 'browser_click', '{}')
  runner.toolResult({ callId: 'call-1', isError: true, text: 'target moved' })
  runner.toolCall('call-2', 'browser_click', '{}')
  runner.toolResult({ callId: 'call-2', isError: false, text: 'clicked' })
  const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadTokens: 40 }
  runner.assistant('PARTIAL — did most of it', usage)
  runner.current.resolve('PARTIAL — did most of it')
  await turn.done

  const done = frames.find(frame => frame.type === 'chat.done')
  assert.equal(done.label, 'partial')
  assert.deepEqual(done.usage, usage)
  assert.equal(done.timings.failedCalls, 1)
  assert.equal(done.timings.toolCalls, 2)

  const ended = observed.at(-1)[1]
  assert.equal(ended.label, 'partial')
  assert.deepEqual(ended.usage, usage)
  assert.equal(ended.timings.failedCalls, 1)

  const logged = logStore.calls.filter(([name]) => name === 'turnEnd').at(-1)[2]
  assert.equal(logged.label, 'partial')
  assert.deepEqual(logged.usage, usage)
  assert.equal(logged.timings.failedCalls, 1)
})

test('an answer without a leading completion label records null', async () => {
  const { controller, runner, frames, observed } = setup()
  const turn = controller.submit({ text: 'work' })
  await runner.started()
  runner.assistant('All set.')
  runner.current.resolve('All set.')
  await turn.done
  assert.equal(frames.find(frame => frame.type === 'chat.done').label, null)
  assert.equal(observed.at(-1)[1].label, null)
})

test('a stopped turn records elapsed time, failed calls, and partial usage without a label', async () => {
  const { controller, runner, frames, observed, logStore } = setup()
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  runner.toolCall('call-1', 'browser_click', '{}')
  runner.toolResult({ callId: 'call-1', isError: true, text: 'failed' })
  const usage = { inputTokens: 60, outputTokens: 10, totalTokens: 70, cacheReadTokens: 5 }
  runner.assistant('working on it', usage)
  const stop = controller.stop()
  await stop.done
  await turn.done

  const stopped = frames.find(frame => frame.type === 'chat.stopped')
  assert.equal(stopped.reason, 'user')
  assert.deepEqual(stopped.usage, usage)
  assert.equal(stopped.timings.failedCalls, 1)
  assert.ok(Number.isFinite(stopped.timings.totalMs) && stopped.timings.totalMs >= 0)

  const ended = observed.at(-1)[1]
  assert.equal(ended.outcome, 'stopped')
  assert.equal(ended.label, null)
  assert.deepEqual(ended.usage, usage)
  assert.equal(ended.timings.failedCalls, 1)

  const logged = logStore.calls.filter(([name]) => name === 'turnEnd').at(-1)[2]
  assert.equal(logged.aborted, true)
  assert.equal(logged.label, null)
  assert.deepEqual(logged.usage, usage)
  assert.equal(logged.timings.failedCalls, 1)
})
