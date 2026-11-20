import test from 'node:test'
import assert from 'node:assert/strict'
import { BUSY_MESSAGE, NOT_READY_MESSAGE, STOPPING_MESSAGE, SessionController, confirmationPromptBlock, isLeakedToolCallText, normalizeConfirmRequest, parseReportedLabel, uiRejectionFrame } from '../session-controller.mjs'
import { FakeRunner, fakeBridge, fakeLogStore } from './remote-fixtures.mjs'
import { assess } from '../watch-ledger.mjs'
import { pushTypeForTurn } from '../remote-push.mjs'

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
    watch: options.watch,
  })
  return { controller, runner, bridge, frames, observed, logStore }
}

test('submit reserves the single turn slot synchronously', async () => {
  const { controller, runner, frames, observed, bridge } = setup()
  const first = controller.submit({ text: ' hi ', origin: 'remote', clientMessageId: 'client-0001' })
  const second = controller.submit({ text: 'again', origin: 'ui' })
  assert.equal(first.ok, true)
  assert.deepEqual(second, { ok: false, code: 'TURN_BUSY', message: BUSY_MESSAGE, retryable: true })
  assert.equal(runner.runs.length, 1)
  assert.equal(observed[0][0], 'start')
  assert.equal(observed[0][1].text, 'hi')
  assert.equal(observed[0][1].origin, 'remote')
  assert.equal(observed[0][1].clientMessageId, 'client-0001')
  assert.deepEqual(bridge.turnPrompts[0], { id: first.turnId, prompt: 'hi' }, 'classification receives the raw prompt, not the wrapped turn text')

  runner.assistant('answer')
  runner.current.resolve('final')
  await first.done
  assert.equal(controller.running, false)
  assert.deepEqual(bridge.turnPrompts.at(-1), { id: undefined, prompt: null }, 'turn context clears with the turn')
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

test('the running turn is exposed for a client that connects mid-turn, and cleared at the end', async () => {
  const { controller, runner } = setup()
  assert.equal(controller.runningTurn(), null)
  const turn = controller.submit({ text: ' make the doc ', origin: 'remote' })
  assert.deepEqual(controller.runningTurn(), { running: true, turnId: turn.turnId, origin: 'remote', text: 'make the doc', imageCount: 0, marathon: false })
  runner.current.resolve('DONE')
  await turn.done
  assert.equal(controller.runningTurn(), null)
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

test('a Docs tab in the turn-start view arms the Docs guidance block; other pages do not', async () => {
  const { controller, runner, bridge } = setup({ autoCapture: true })
  let url = 'https://docs.google.com/document/d/abc123/edit'
  bridge.requestUi = async () => ({ tab: { id: 7, title: 'Doc', url }, viewport: { width: 1280, height: 720 }, scroll: { y: 0, maxY: 0 } })
  const docsTurn = controller.submit({ text: 'edit the document' })
  await runner.started()
  assert.ok(runner.runs[0][0].text.includes('<docs_mode>'), 'the Docs turn carries the conditional block')
  assert.match(runner.runs[0][0].text, /make browser_docs_replace your FIRST tool call/u)
  runner.current.resolve('done')
  await docsTurn.done

  url = 'https://example.com/page'
  const plainTurn = controller.submit({ text: 'read the page' })
  await runner.started()
  assert.doesNotMatch(runner.runs[1][0].text, /<docs_mode>/u, 'a non-Docs turn stays on the core guidance')
  runner.current.resolve('done')
  await plainTurn.done
})

test('the malformed-reply retry keeps the Docs block armed for the same turn', async () => {
  const { controller, runner, bridge } = setup({ autoCapture: true })
  bridge.requestUi = async () => ({ tab: { id: 7, title: 'Doc', url: 'https://docs.google.com/document/u/0/d/abc/edit' }, viewport: { width: 1280, height: 720 }, scroll: { y: 0, maxY: 0 } })
  const turn = controller.submit({ text: 'edit the document' })
  await runner.started()
  assert.ok(runner.runs[0][0].text.includes('<docs_mode>'))
  runner.event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'MALFORMED_RESPONSE', message: 'bad JSON' } } })
  runner.current.resolve('')
  await new Promise(resolve => setImmediate(resolve))
  await runner.started()
  assert.equal(runner.runs.length, 2)
  assert.deepEqual(bridge.turnPrompts.filter(entry => entry.id === turn.turnId).map(entry => entry.prompt), ['edit the document', 'edit the document'], 'the same-turn retry keeps the raw prompt')
  assert.match(runner.runs[1][0].text, /Automatic notice, not a new request/u)
  assert.ok(runner.runs[1][0].text.includes('<docs_mode>'), 'the retry re-sends the turn Docs block')
  runner.event('turn/end', { turn: 2, reason: { kind: 'completed' } })
  runner.current.resolve('DONE: edited')
  await turn.done
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
  assert.match(runner.runs[0][0].text, /<marathon_mode>/)
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
  assert.match(remote.runner.runs[0][0].text, /<marathon_mode>|browser_plan/)
  remote.runner.current.resolve()
  await turn.done
  assert.equal(remote.frames.find(frame => frame.type === 'chat.done').planMode, true)

  const ordinary = setup()
  const own = ordinary.controller.submit({ text: 'ordinary panel task', origin: 'ui' })
  assert.equal(ordinary.observed[0][1].planMode, false)
  assert.doesNotMatch(ordinary.runner.runs[0][0].text, /<marathon_mode>|browser_plan/)
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
  assert.deepEqual(bridge.turnGuards[0], { id: turn.turnId, confirmGuard: true }, 'an unapproved turn runs with the executor backstop')
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
  assert.deepEqual(bridge.turnGuards.at(-1), { id: answer.turnId, confirmGuard: false }, 'only the approved turn runs without the backstop')
  // People (other clients, saved history) see the decision in plain words, never the model block.
  assert.equal(frames.filter(frame => frame.type === 'chat.user').at(-1).text, 'Approved: Submit the assignment for grading')
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
  runner.toolCall('call-3', 'browser_click_at', '{}')
  runner.toolResult({ callId: 'call-3', isError: false, text: 'refused NO_VIEW: the previous view went stale\nno input was dispatched (attempted=false, mutationPossible=false).' })
  const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 162, cacheReadTokens: 40, cacheWriteTokens: 12, reasoningTokens: 9 }
  runner.assistant('PARTIAL — did most of it', usage)
  runner.current.resolve('PARTIAL — did most of it')
  await turn.done

  const done = frames.find(frame => frame.type === 'chat.done')
  assert.equal(done.label, 'partial')
  assert.deepEqual(done.usage, usage)
  assert.equal(done.timings.failedCalls, 2)
  assert.equal(done.timings.toolCalls, 3)
  assert.equal(frames.find(frame => frame.type === 'chat.tool_result' && frame.callId === 'call-3').ok, true)

  const ended = observed.at(-1)[1]
  assert.equal(ended.label, 'partial')
  assert.deepEqual(ended.usage, usage)
  assert.equal(ended.timings.failedCalls, 2)

  const logged = logStore.calls.filter(([name]) => name === 'turnEnd').at(-1)[2]
  assert.equal(logged.label, 'partial')
  assert.deepEqual(logged.usage, usage)
  assert.equal(logged.timings.failedCalls, 2)
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
  runner.toolCall('call-2', 'browser_click_at', '{}')
  runner.toolResult({ callId: 'call-2', isError: false, text: 'refused STALE_VIEW: measure a fresh view' })
  const usage = { inputTokens: 60, outputTokens: 10, totalTokens: 70, cacheReadTokens: 5 }
  runner.assistant('working on it', usage)
  const stop = controller.stop()
  await stop.done
  await turn.done

  const stopped = frames.find(frame => frame.type === 'chat.stopped')
  assert.equal(stopped.reason, 'user')
  assert.deepEqual(stopped.usage, usage)
  assert.equal(stopped.timings.failedCalls, 2)
  assert.ok(Number.isFinite(stopped.timings.totalMs) && stopped.timings.totalMs >= 0)

  const ended = observed.at(-1)[1]
  assert.equal(ended.outcome, 'stopped')
  assert.equal(ended.label, null)
  assert.deepEqual(ended.usage, usage)
  assert.equal(ended.timings.failedCalls, 2)

  const logged = logStore.calls.filter(([name]) => name === 'turnEnd').at(-1)[2]
  assert.equal(logged.aborted, true)
  assert.equal(logged.label, null)
  assert.deepEqual(logged.usage, usage)
  assert.equal(logged.timings.failedCalls, 2)
})

test('a tool call written as DSML text is never shown, and a turn ending on one is reported as blocked', async () => {
  const leaked = '\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="browser_batch">\n</｜DSML｜ invoke>'
  assert.equal(isLeakedToolCallText(leaked), true)
  assert.equal(isLeakedToolCallText('@@browser_batch {}\n</｜DSML｜ parameter>\n</｜DSML｜ invoke>'), true)
  assert.equal(isLeakedToolCallText('DONE: the page mentions <|DSML| invoke markup'), false)
  assert.equal(isLeakedToolCallText('DONE: all good'), false)
  assert.equal(isLeakedToolCallText(undefined), false)

  // Recovered: the provider retried and the turn finished normally.
  const recovered = setup()
  const first = recovered.controller.submit({ text: 'fill the form' })
  recovered.runner.assistant(leaked)
  recovered.runner.assistant('DONE: submitted')
  recovered.runner.current.resolve('DONE: submitted')
  await first.done
  assert.deepEqual(recovered.frames.filter(frame => frame.type === 'chat.assistant').map(frame => frame.text), ['DONE: submitted'])
  assert.equal(recovered.frames.find(frame => frame.type === 'chat.done').label, 'done')
  assert.ok(recovered.logStore.calls.some(call => call[0] === 'record' && call[2] === 'assistant.leaked_tool_call'))

  // Not recovered: the final response is still markup.
  const dead = setup()
  const second = dead.controller.submit({ text: 'fill the form' })
  dead.runner.assistant(leaked)
  dead.runner.current.resolve(leaked)
  await second.done
  assert.equal(dead.frames.some(frame => frame.type === 'chat.assistant'), false)
  const done = dead.frames.find(frame => frame.type === 'chat.done')
  assert.match(done.text, /^BLOCKED: the model sent an empty or malformed reply/)
  assert.equal(done.label, 'blocked')
  // A blank final answer with nothing done is reported the same way.
  const blank = setup()
  const third = blank.controller.submit({ text: 'fill the form' })
  blank.runner.current.resolve('\n')
  await third.done
  assert.match(blank.frames.find(frame => frame.type === 'chat.done').text, /^BLOCKED: the model sent an empty/)
  // ...but not when the turn did something.
  const acted = setup()
  const fourth = acted.controller.submit({ text: 'click it' })
  acted.runner.toolCall('call-1')
  acted.runner.toolResult({ callId: 'call-1' })
  acted.runner.current.resolve('')
  await fourth.done
  assert.equal(acted.frames.find(frame => frame.type === 'chat.done').text, '')
  const end = dead.logStore.calls.find(call => call[0] === 'turnEnd')
  assert.equal(end[2].ok, false)
  assert.doesNotMatch(end[2].finalText, /DSML/)
})

test('a turn the runtime ended on a malformed reply is retried once, then reported as an error', async () => {
  const malformed = { turn: 1, reason: { kind: 'error', error: { code: 'MALFORMED_RESPONSE', message: 'Tool call "browser_batch": Expected , in JSON' } } }

  // Recovered on the retry, with this turn's conditional modes re-armed.
  const recovered = setup({ confirmIrreversible: true })
  const first = recovered.controller.submit({ text: 'fill the form' })
  await recovered.runner.started()
  recovered.runner.event('turn/end', malformed)
  recovered.runner.current.resolve('')
  await new Promise(resolve => setImmediate(resolve))
  await recovered.runner.started()
  assert.equal(recovered.runner.runs.length, 2, 'one automatic retry')
  assert.match(recovered.runner.runs[1][0].text, /Automatic notice, not a new request/)
  recovered.runner.event('turn/end', { turn: 2, reason: { kind: 'completed' } })
  recovered.runner.current.resolve('DONE: submitted')
  await first.done
  assert.equal(recovered.frames.find(frame => frame.type === 'chat.done').text, 'DONE: submitted')
  assert.equal(recovered.frames.some(frame => frame.type === 'chat.error'), false)
  assert.equal(recovered.frames.filter(frame => frame.type === 'chat.user').length <= 1, true, 'the notice is not shown as a user prompt')

  // Malformed twice: an error, not an empty "done".
  const dead = setup()
  const second = dead.controller.submit({ text: 'fill the form' })
  await dead.runner.started()
  dead.runner.event('turn/end', malformed)
  dead.runner.current.resolve('')
  await new Promise(resolve => setImmediate(resolve))
  await dead.runner.started()
  dead.runner.event('turn/end', malformed)
  dead.runner.current.resolve('')
  await second.done
  assert.equal(dead.runner.runs.length, 2, 'never more than one retry')
  assert.equal(dead.frames.some(frame => frame.type === 'chat.done'), false)
  assert.match(dead.frames.find(frame => frame.type === 'chat.error').message, /MALFORMED_RESPONSE.*nothing was done/)
  assert.equal(dead.observed.at(-1)[1].outcome, 'error')

  // After an action already ran, do not retry: report it.
  const acted = setup()
  const third = acted.controller.submit({ text: 'fill the form' })
  await acted.runner.started()
  acted.runner.toolCall('call-1')
  acted.runner.toolResult({ callId: 'call-1' })
  acted.runner.event('turn/end', malformed)
  acted.runner.current.resolve('')
  await third.done
  assert.equal(acted.runner.runs.length, 1)
  assert.match(acted.frames.find(frame => frame.type === 'chat.error').message, /after 1 action\. Check the page/)
})

test('a request that failed in transit before any action is rerun once with a continue notice', async () => {
  const transport = { turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed: Bearer abcdefghijklmnop sk-or-v1-0123456789abcdef' } } }

  const recovered = setup({ confirmIrreversible: true })
  const first = recovered.controller.submit({ text: 'tell me when it is done' })
  await recovered.runner.started()
  // The prompt reached the session before the request failed.
  recovered.runner.event('user/message', { content: [{ type: 'text', text: 'tell me when it is done' }] })
  recovered.runner.event('turn/end', transport)
  recovered.runner.current.resolve('')
  await new Promise(resolve => setImmediate(resolve))
  await recovered.runner.started()
  assert.equal(recovered.runner.runs.length, 2, 'one automatic rerun')
  assert.match(recovered.runner.runs[1][0].text, /Automatic notice, not a new request: the model request .* failed before any reply/)
  const retry = recovered.logStore.calls.find(call => call[0] === 'record' && call[2] === 'turn.retry')
  assert.equal(retry[3].code, 'TRANSPORT')
  assert.equal(retry[3].resend, false)
  assert.doesNotMatch(retry[3].message, /abcdefghijklmnop|0123456789abcdef/, 'credential-shaped text is masked in the log')
  recovered.runner.event('turn/end', { turn: 2, reason: { kind: 'completed' } })
  recovered.runner.current.resolve('DONE: it finished')
  await first.done
  assert.equal(recovered.frames.find(frame => frame.type === 'chat.done').text, 'DONE: it finished')
  assert.equal(recovered.frames.some(frame => frame.type === 'chat.error'), false)

  // Failing twice ends as a request failure, not as an unusable reply.
  const dead = setup()
  const second = dead.controller.submit({ text: 'tell me when it is done' })
  await dead.runner.started()
  dead.runner.event('turn/end', transport)
  dead.runner.current.resolve('')
  await new Promise(resolve => setImmediate(resolve))
  await dead.runner.started()
  dead.runner.event('turn/end', transport)
  dead.runner.current.resolve('')
  await second.done
  assert.equal(dead.runner.runs.length, 2, 'never more than one rerun')
  assert.equal(dead.frames.find(frame => frame.type === 'chat.error').message, 'The model request failed (TRANSPORT), so nothing was done. Send the request again.')

  // After an action already ran, never rerun.
  const acted = setup()
  const third = acted.controller.submit({ text: 'tell me when it is done' })
  await acted.runner.started()
  acted.runner.toolCall('call-1')
  acted.runner.toolResult({ callId: 'call-1' })
  acted.runner.event('turn/end', transport)
  acted.runner.current.resolve('')
  await third.done
  assert.equal(acted.runner.runs.length, 1)
  assert.equal(acted.frames.find(frame => frame.type === 'chat.error').message, 'The model request failed (TRANSPORT) after 1 action. Check the page before sending the request again.')
})

test('a model-switch compaction failure before the prompt was committed resends the prompt itself once', async () => {
  const switchFailed = { turn: 1, reason: { kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED', message: 'Cannot switch to openrouter/model-y: context compaction failed' } } }
  const { controller, runner, frames, logStore } = setup()
  const turn = controller.submit({ text: 'yo' })
  await runner.started()
  // No user/message event: the runtime failed while preparing the request.
  runner.event('turn/end', switchFailed)
  runner.current.resolve('')
  await new Promise(resolve => setImmediate(resolve))
  await runner.started()
  assert.equal(runner.runs.length, 2)
  assert.deepEqual(runner.runs[1], runner.runs[0], 'the original prompt blocks are sent again, not a notice')
  assert.equal(logStore.calls.find(call => call[0] === 'record' && call[2] === 'turn.retry')[3].resend, true)
  runner.event('turn/end', switchFailed)
  runner.current.resolve('')
  await turn.done
  assert.equal(runner.runs.length, 2)
  assert.equal(frames.find(frame => frame.type === 'chat.error').message, 'The model request failed (MODEL_SWITCH_COMPACTION_FAILED), so nothing was done. Send the request again.')
  assert.ok(logStore.calls.some(call => call[0] === 'record' && call[2] === 'turn.runtime_error' && /context compaction failed/.test(call[3].message)))
})

test('a turn interrupted by the companion shutting down ends as stopped, not as a runtime crash', async () => {
  const { controller, runner, frames, logStore, observed } = setup()
  const turn = controller.submit({ text: 'get started on the mcq' })
  await runner.started()
  controller.dispose('SIGTERM')
  runner.current.reject(new Error('dsh profile "sdk-minimal": DeepSeek Harness runtime exited\nexit code: 0'))
  await turn.done
  assert.equal(frames.some(frame => frame.type === 'chat.error'), false)
  const stopped = frames.find(frame => frame.type === 'chat.stopped')
  assert.equal(stopped.reason, 'shutdown')
  assert.match(stopped.message, /The companion shut down \(SIGTERM\) during this turn/)
  const end = logStore.calls.find(call => call[0] === 'turnEnd')
  assert.equal(end[2].aborted, true)
  assert.equal(end[2].reason, 'shutdown')
  assert.equal(observed.at(-1)[1].outcome, 'stopped')
  // Disposing with no turn running changes nothing for later turns.
  const idle = setup()
  idle.controller.dispose('SIGINT')
  assert.equal(idle.controller.shutdownSignal, undefined)
})

test('other runtime errors are not rerun', async () => {
  const { controller, runner, frames } = setup()
  const turn = controller.submit({ text: 'hi' })
  await runner.started()
  runner.event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', message: 'out of credits' } } })
  runner.current.resolve('')
  await turn.done
  assert.equal(runner.runs.length, 1)
  assert.equal(frames.find(frame => frame.type === 'chat.error').message, 'The model request failed (QUOTA), so nothing was done. Send the request again.')
})

test('the executor backstop is on for denied and ordinary turns of the setting, and never when it is off', async () => {
  const on = setup({ confirmIrreversible: true })
  const asked = on.controller.submit({ text: 'submit it' })
  on.controller.noteActivity({ kind: 'confirm-request', turnId: asked.turnId, action: 'Submit', target: 'Submit button' })
  on.runner.current.resolve('waiting')
  await asked.done
  const denied = on.controller.submit({ text: '', confirm: 'deny' })
  assert.deepEqual(on.bridge.turnGuards.at(-1), { id: denied.turnId, confirmGuard: true })
  on.runner.current.resolve('DONE: not submitted')
  await denied.done

  const off = setup()
  const plain = off.controller.submit({ text: 'submit it' })
  assert.deepEqual(off.bridge.turnGuards.at(-1), { id: plain.turnId, confirmGuard: false })
  off.runner.current.resolve('done')
  await plain.done
})

/* ------------------------------------------------------------------ */
/* M1: the shared companion-owned marathon switch (§3.1)               */
/* ------------------------------------------------------------------ */

test('setMarathon toggles both directions, publishes marathon.state, and is accepted in any turn state', async () => {
  const { controller, runner, frames } = setup()
  assert.deepEqual(controller.marathonState(), { enabled: false, sessionId: null, since: null, origin: null, plan: null })

  const on = controller.setMarathon({ enabled: true, origin: 'remote' })
  assert.equal(on.ok, true)
  assert.equal(on.enabled, true)
  assert.equal(on.sessionId, 'session-1')
  const stateFrame = frames.find(frame => frame.type === 'marathon.state')
  assert.equal(stateFrame.v, 1)
  assert.equal(stateFrame.enabled, true)
  assert.equal(stateFrame.origin, 'remote')
  assert.equal(stateFrame.sessionId, 'session-1')
  assert.equal(typeof stateFrame.since, 'string')
  assert.equal(stateFrame.plan, null)
  assert.deepEqual(stateFrame.watcher, { active: false, checks: 0, lastCheckAt: null, lastVerdict: null })

  // Accepted while a turn runs: the switch flips, the running turn is untouched.
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  const midTurn = controller.setMarathon({ enabled: false, origin: 'ui' })
  assert.equal(midTurn.ok, true)
  assert.equal(controller.running, true)
  assert.deepEqual(controller.marathonState(), { enabled: false, sessionId: null, since: null, origin: null, plan: null })
  // And while stopping.
  controller.stop()
  assert.equal(controller.setMarathon({ enabled: true, origin: 'ui' }).ok, true)
  await turn.done

  // Idempotent re-set publishes nothing new.
  const count = frames.filter(frame => frame.type === 'marathon.state').length
  assert.equal(controller.setMarathon({ enabled: true, origin: 'remote' }).changed, false)
  assert.equal(frames.filter(frame => frame.type === 'marathon.state').length, count)

  // Non-boolean fails closed without a publication.
  const bad = controller.setMarathon({ enabled: 'yes' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'INVALID_MARATHON')
  assert.equal(frames.filter(frame => frame.type === 'marathon.state').length, count)
})

test('with marathon on, every turn arms without planMode and chat.done carries both flags', async () => {
  const { controller, runner, bridge, frames, observed } = setup()
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const first = controller.submit({ text: 'step one' })
  assert.deepEqual(bridge.turnModes[0], { id: first.turnId, planMode: true })
  assert.equal(observed[0][1].planMode, true)
  assert.equal(observed[0][1].marathon, true)
  assert.match(runner.runs[0][0].text, /<marathon_mode>/)
  runner.current.resolve('DONE: one')
  await first.done
  const firstDone = frames.find(frame => frame.type === 'chat.done')
  assert.equal(firstDone.planMode, true)
  assert.equal(firstDone.marathon, true)

  // Sticky: the next turn arms too, with no per-message flag anywhere.
  const second = controller.submit({ text: 'step two' })
  assert.deepEqual(bridge.turnModes.at(-1), { id: second.turnId, planMode: true })
  assert.match(runner.runs[1][0].text, /<marathon_mode>/)
  runner.current.resolve('DONE: two')
  await second.done

  // Off: ordinary turns again.
  controller.setMarathon({ enabled: false, origin: 'ui' })
  const third = controller.submit({ text: 'quick question' })
  assert.deepEqual(bridge.turnModes.at(-1), { id: third.turnId, planMode: false })
  assert.doesNotMatch(runner.runs[2][0].text, /<marathon_mode>/)
  runner.current.resolve('42')
  await third.done
  const thirdDone = frames.filter(frame => frame.type === 'chat.done').at(-1)
  assert.equal(thirdDone.planMode, false)
  assert.equal(thirdDone.marathon, false)
})

test('legacy planMode:true first turns marathon on with the sender origin, then submits', async () => {
  for (const origin of ['ui', 'remote']) {
    const { controller, runner, bridge, frames } = setup()
    const turn = controller.submit({ text: 'old client task', origin, planMode: true })
    assert.equal(turn.ok, true)
    assert.equal(controller.marathonState().enabled, true)
    assert.equal(controller.marathonState().origin, origin)
    assert.deepEqual(bridge.turnModes[0], { id: turn.turnId, planMode: true })
    assert.match(runner.runs[0][0].text, /<marathon_mode>/)
    if (origin === 'remote') {
      const user = frames.find(frame => frame.type === 'chat.user')
      assert.equal(user.marathon, true)
      const types = frames.map(frame => frame.type)
      assert.ok(types.indexOf('marathon.state') < types.indexOf('chat.user'))
    }
    runner.current.resolve('done')
    await turn.done
    const done = frames.find(frame => frame.type === 'chat.done')
    assert.equal(done.planMode, true)
    assert.equal(done.marathon, true)
    const types = frames.map(frame => frame.type)
    assert.ok(types.indexOf('marathon.state') < types.indexOf('chat.done'), 'the switch lights before the turn ends')
    // The switch stays on for the next turn (sticky, not one-shot).
    const next = controller.submit({ text: 'follow-up', origin })
    assert.deepEqual(bridge.turnModes.at(-1), { id: next.turnId, planMode: true })
    runner.current.resolve('done again')
    await next.done
  }
})

test('a legacy planMode steer arms the shared switch when the steered turn begins', async () => {
  const { controller, runner } = setup()
  const first = controller.submit({ text: 'long task', origin: 'ui' })
  await runner.started()
  const steer = controller.submit({ text: 'plan the rest', origin: 'remote', planMode: true, steer: true })
  assert.equal(steer.steered, true)
  // The running turn was unarmed and stays unarmed; the queued legacy flag
  // flips the switch when the steered turn actually begins (§3.1).
  assert.equal(controller.marathonState().enabled, false)
  await first.done
  assert.equal(controller.marathonState().enabled, true)
  assert.equal(controller.marathonState().origin, 'remote')
  await runner.started()
  assert.match(runner.runs[1][0].text, /<marathon_mode>/)
  runner.current.resolve('done')
  await steer.done
})

test('mid-turn toggles never re-arm the running turn; the next turn picks the new state up', async () => {
  const { controller, runner, bridge } = setup()
  // On while running: the running turn stays unarmed, the next one arms.
  const plain = controller.submit({ text: 'ordinary task' })
  await runner.started()
  assert.deepEqual(bridge.turnModes[0], { id: plain.turnId, planMode: false })
  controller.setMarathon({ enabled: true, origin: 'remote' })
  assert.deepEqual(bridge.turnModes.at(-1), { id: plain.turnId, planMode: false }, 'no plan.mode re-sync mid-turn')
  assert.doesNotMatch(runner.runs[0][0].text, /<marathon_mode>/)
  runner.current.resolve('done')
  await plain.done
  const armed = controller.submit({ text: 'next task' })
  assert.deepEqual(bridge.turnModes.at(-1), { id: armed.turnId, planMode: true })
  runner.current.resolve('done')
  await armed.done

  // Off while running: the running turn keeps browser_plan until it ends.
  const planned = controller.submit({ text: 'planned task' })
  await runner.started()
  assert.deepEqual(bridge.turnModes.at(-1), { id: planned.turnId, planMode: true })
  controller.setMarathon({ enabled: false, origin: 'ui' })
  assert.deepEqual(bridge.turnModes.at(-1), { id: planned.turnId, planMode: true }, 'the running turn keeps its modes')
  runner.current.resolve('done')
  await planned.done
  const after = controller.submit({ text: 'after off' })
  assert.deepEqual(bridge.turnModes.at(-1), { id: after.turnId, planMode: false })
  runner.current.resolve('done')
  await after.done
})

test('new chat and a real chat switch reset marathon to off; resume-to-same-session keeps it', async () => {
  const { controller, runner, frames } = setup()
  controller.setMarathon({ enabled: true, origin: 'ui' })
  await controller.newChat()
  assert.equal(controller.marathonState().enabled, false)
  const offFrame = frames.filter(frame => frame.type === 'marathon.state').at(-1)
  assert.equal(offFrame.enabled, false)
  assert.ok(frames.indexOf(offFrame) < frames.findIndex(frame => frame.type === 'chat.session' && frame.sessionId === 'session-2'))

  // Resume to the SAME session is not a chat switch: the state survives.
  controller.setMarathon({ enabled: true, origin: 'remote' })
  assert.deepEqual(await controller.resumeChat('session-2'), { ok: true, sessionId: 'session-2', already: true })
  assert.equal(controller.marathonState().enabled, true)

  // A real switch to another saved chat resets off.
  await controller.resumeChat('session-old')
  assert.equal(controller.marathonState().enabled, false)
  assert.equal(frames.filter(frame => frame.type === 'marathon.state').at(-1).enabled, false)

  // A failed resume keeps the current session and the switch.
  controller.setMarathon({ enabled: true, origin: 'ui' })
  runner.unresumable = new Set(['session-gone'])
  assert.equal((await controller.resumeChat('session-gone')).ok, false)
  assert.equal(controller.marathonState().enabled, true)
})

test('a fresh controller (companion restart) starts with marathon off — fail-safe', () => {
  const first = setup()
  first.controller.setMarathon({ enabled: true, origin: 'ui' })
  const restarted = setup()
  assert.equal(restarted.controller.marathonState().enabled, false)
  assert.deepEqual(restarted.controller.marathonState(), { enabled: false, sessionId: null, since: null, origin: null, plan: null })
})

/* ------------------------------------------------------------------ */
/* M2: plan carry-over (§3.2)                                          */
/* ------------------------------------------------------------------ */

const CARRIED_ITEMS = [
  { content: 'Step one', status: 'completed' },
  { content: 'Step two', status: 'in_progress' },
  { content: 'Step three', status: 'pending' },
]

test('plan activities become the carried snapshot; the next turn seeds from it', async () => {
  const { controller, runner, bridge, frames } = setup()
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const first = controller.submit({ text: 'long task' })
  await runner.started()
  assert.equal(bridge.turnSeeds[0].seed, null, 'the first turn has nothing to carry')
  assert.doesNotMatch(runner.runs[0][0].text, /Carried plan/)
  controller.noteActivity({ kind: 'plan', turnId: first.turnId, revision: 1, items: CARRIED_ITEMS, awaitingUser: false })
  // Malformed plan frames are ignored, never stored.
  controller.noteActivity({ kind: 'plan', turnId: first.turnId, revision: 'one', items: CARRIED_ITEMS })
  controller.noteActivity({ kind: 'plan', turnId: first.turnId, revision: 2, items: [{ content: 'x', status: 'done' }] })
  controller.noteActivity({ kind: 'plan', turnId: 'turn-old', revision: 9, items: CARRIED_ITEMS })
  runner.current.resolve('PARTIAL — two items remain')
  await first.done

  const plan = controller.marathonState().plan
  assert.ok(plan, 'open items keep the snapshot')
  assert.equal(plan.revision, 1)
  assert.deepEqual(plan.items, CARRIED_ITEMS)
  assert.equal(plan.turnId, first.turnId)
  assert.equal(typeof plan.updatedAt, 'string')
  const stateFrame = frames.filter(frame => frame.type === 'marathon.state').at(-1)
  assert.deepEqual(stateFrame.plan, plan, 'clients see the carried plan')

  const second = controller.submit({ text: 'continue' })
  assert.deepEqual(bridge.turnSeeds.at(-1).seed, { revision: 1, items: CARRIED_ITEMS })
  assert.match(runner.runs[1][0].text, /Carried plan, revision 1 \(2 open\)/)
  assert.match(runner.runs[1][0].text, /use expected_revision:1/)
  runner.current.resolve('DONE — all steps complete')
  await second.done
  // No plan activity this turn: the carried snapshot survives untouched.
  assert.deepEqual(controller.marathonState().plan, plan)
})

test('a fully completed plan is dropped at turn end; marathon off never carries', async () => {
  const { controller, runner } = setup()
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const first = controller.submit({ text: 'task' })
  await runner.started()
  controller.noteActivity({ kind: 'plan', turnId: first.turnId, revision: 2, items: [{ content: 'Only step', status: 'completed' }] })
  runner.current.resolve('DONE')
  await first.done
  assert.equal(controller.marathonState().plan, null, 'no open items → dropped')

  // With the switch off, plan activities never become a carried plan.
  controller.setMarathon({ enabled: false, origin: 'ui' })
  const second = controller.submit({ text: 'ordinary task', planMode: false })
  await runner.started()
  controller.noteActivity({ kind: 'plan', turnId: second.turnId, revision: 1, items: CARRIED_ITEMS })
  runner.current.resolve('done')
  await second.done
  assert.equal(controller.marathonState().enabled, false)
  assert.equal(controller.marathonState().plan, null)
})

test('the MALFORMED_RESPONSE rerun re-arms with the CURRENT snapshot, not the turn-start one', async () => {
  const { controller, runner, bridge } = setup()
  controller.setMarathon({ enabled: true, origin: 'ui' })
  // Carry a revision-1 plan into this turn.
  const warm = controller.submit({ text: 'warm-up' })
  await runner.started()
  controller.noteActivity({ kind: 'plan', turnId: warm.turnId, revision: 1, items: CARRIED_ITEMS })
  runner.current.resolve('PARTIAL')
  await warm.done

  const turn = controller.submit({ text: 'continue the work' })
  await runner.started()
  assert.deepEqual(bridge.turnSeeds.at(-1).seed, { revision: 1, items: CARRIED_ITEMS })
  // The turn advances the plan to revision 3 before the malformed ending.
  controller.noteActivity({ kind: 'plan', turnId: turn.turnId, revision: 3, items: [{ content: 'Step two', status: 'in_progress' }, { content: 'Step three', status: 'pending' }] })
  runner.event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'MALFORMED_RESPONSE', message: 'bad JSON' } } })
  runner.current.resolve('')
  await new Promise(resolve => setImmediate(resolve))
  await runner.started()
  assert.equal(runner.runs.length, 3)
  assert.deepEqual(bridge.turnSeeds.at(-1).seed, { revision: 3, items: [{ content: 'Step two', status: 'in_progress' }, { content: 'Step three', status: 'pending' }] }, 'the rerun seeds the latest snapshot')
  assert.match(runner.runs[2][0].text, /Carried plan, revision 3 \(2 open\)/)
  assert.match(runner.runs[2][0].text, /Automatic notice, not a new request/)
  runner.event('turn/end', { turn: 2, reason: { kind: 'completed' } })
  runner.current.resolve('DONE')
  await turn.done
  assert.equal(controller.marathonState().plan.revision, 3)
})

test('a steered turn inherits the stopped turn’s plan snapshot', async () => {
  const { controller, runner, bridge } = setup()
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const first = controller.submit({ text: 'long task' })
  await runner.started()
  controller.noteActivity({ kind: 'plan', turnId: first.turnId, revision: 3, items: CARRIED_ITEMS })
  const steer = controller.submit({ text: 'go left instead', steer: true })
  assert.equal(steer.steered, true)
  await first.done
  await runner.started()
  assert.deepEqual(bridge.turnSeeds.at(-1).seed, { revision: 3, items: CARRIED_ITEMS })
  assert.match(runner.runs[1][0].text, /Carried plan, revision 3/)
  assert.match(runner.runs[1][0].text, /go left instead/)
  runner.current.resolve('went left')
  await steer.done
})

test('a new chat drops the carried plan with the switch', async () => {
  const { controller, runner, frames } = setup()
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = controller.submit({ text: 'task' })
  await runner.started()
  controller.noteActivity({ kind: 'plan', turnId: turn.turnId, revision: 2, items: CARRIED_ITEMS })
  runner.current.resolve('PARTIAL')
  await turn.done
  assert.ok(controller.marathonState().plan)
  await controller.newChat()
  assert.equal(controller.marathonState().plan, null)
  assert.equal(controller.marathonState().enabled, false)
  assert.equal(frames.filter(frame => frame.type === 'marathon.state').at(-1).plan, null)
})

/* ------------------------------------------------------------------ */
/* M3: the deterministic watcher wired into the controller             */
/* ------------------------------------------------------------------ */

function watchClock() {
  let now = 0
  return {
    advance: ms => { now += ms },
    options: { now: () => now, wallNow: () => 1_700_000_000_000 + now, setTimer: () => 0, clearTimer: () => {} },
  }
}

test('a hanging tool call on a marathon turn alerts TOOL_HANG and rides the watch summary', async () => {
  const clock = watchClock()
  const { controller, runner, frames } = setup({ watch: clock.options })
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  // A tool call that never returns (the provider emitted the call, no result).
  runner.event('tool/call', { callId: 'hang-1', name: 'browser_wait_for', arguments: '{}' })
  clock.advance(240_000)
  controller.watcher.tick()
  const alert = frames.find(frame => frame.type === 'chat.watch' && frame.state === 'open')
  assert.ok(alert, 'a TOOL_HANG alert was published')
  assert.equal(alert.kind, 'TOOL_HANG')
  assert.equal(alert.source, 'heuristic')
  assert.equal(controller.watchState().open.kind, 'TOOL_HANG')
  // The turn finishes; the summary is additive on chat.done and never changes ok.
  runner.toolResult({ callId: 'hang-1', text: 'waited' })
  runner.current.resolve('DONE — finished')
  await turn.done
  const done = frames.find(frame => frame.type === 'chat.done')
  assert.deepEqual(done.watch, { checks: 1, alerts: 1, usage: 0 })
  assert.equal(done.label, 'done')
  assert.equal(controller.watchState().open, null)
})

test('EXECUTOR_DOWN alerts when the panel socket drops mid-marathon-turn', async () => {
  const clock = watchClock()
  const { controller, runner, frames } = setup({ watch: clock.options })
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  controller.setConnectivity({ uiConnected: false, toolsConnected: true })
  clock.advance(120_000)
  controller.watcher.tick()
  const alert = frames.find(frame => frame.type === 'chat.watch' && frame.state === 'open')
  assert.equal(alert?.kind, 'EXECUTOR_DOWN')
  controller.setConnectivity({ uiConnected: true, toolsConnected: true })
  runner.current.resolve('done')
  await turn.done
})

test('W2: a non-marathon turn also watches for hangs and closes alerts on end without ended-incomplete', async () => {
  const clock = watchClock()
  const { controller, runner, frames } = setup({ watch: clock.options })
  const turn = controller.submit({ text: 'quick task' })
  await runner.started()
  runner.event('tool/call', { callId: 'hang-1', name: 'browser_wait_for', arguments: '{}' })
  clock.advance(180_000)
  const assessment = controller.watcher.tick()
  assert.equal(assessment.level, 'hard')
  assert.equal(frames.filter(frame => frame.type === 'chat.watch' && frame.kind === 'TOOL_HANG' && frame.state === 'open').length, 1)
  runner.toolResult({ callId: 'hang-1' })
  runner.current.resolve('done')
  await turn.done
  assert.equal(frames.filter(frame => frame.type === 'chat.watch' && frame.kind === 'ended-incomplete').length, 0)
  assert.deepEqual(frames.find(frame => frame.type === 'chat.done').watch, { checks: 1, alerts: 1, usage: 0 })
  assert.equal(controller.watchState().open, null)
})

test('a marathon turn ending unfinished emits ended-incomplete; a clean one does not', async () => {
  const clock = watchClock()
  const { controller, runner, frames } = setup({ watch: clock.options })
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  controller.noteActivity({ kind: 'turn-outcome', turn: 1, planOutcome: 'unfinished', planRevision: 2 })
  runner.current.resolve('PARTIAL — items remain')
  await turn.done
  const ended = frames.filter(frame => frame.type === 'chat.watch' && frame.kind === 'ended-incomplete')
  assert.equal(ended.length, 1)
  assert.equal(ended[0].state, 'open')

  const clean = setup({ watch: watchClock().options })
  clean.controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn2 = clean.controller.submit({ text: 'task' })
  await clean.runner.started()
  clean.controller.noteActivity({ kind: 'turn-outcome', turn: 1, planOutcome: 'reported-complete', planRevision: 1 })
  clean.runner.current.resolve('DONE — all complete')
  await turn2.done
  assert.equal(clean.frames.filter(frame => frame.type === 'chat.watch' && frame.kind === 'ended-incomplete').length, 0)
})

test('watchAck dismisses the open alert through the controller', async () => {
  const clock = watchClock()
  const { controller, runner, frames } = setup({ watch: clock.options })
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  runner.event('tool/call', { callId: 'hang-1', name: 'browser_wait_for', arguments: '{}' })
  clock.advance(240_000)
  controller.watcher.tick()
  const id = controller.watchState().open.id
  assert.deepEqual(controller.watchAck(id), { ok: true })
  assert.equal(controller.watchState().open, null)
  assert.ok(frames.some(frame => frame.type === 'chat.watch' && frame.state === 'dismissed'))
  assert.equal(controller.watchAck('nope').code, 'WATCH_NOT_FOUND')
  runner.toolResult({ callId: 'hang-1' })
  runner.current.resolve('done')
  await turn.done
})

test('M3 fix: live activities via noteActivity reach the ledger (plan/text/reasoning/model-start)', async () => {
  const clock = watchClock()
  const { controller, runner } = setup({ watch: clock.options })
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  // These arrive through the provider onActivity path, NOT publish.
  controller.noteActivity({ kind: 'plan', turnId: turn.turnId, revision: 1, items: [{ content: 'Fill the form', status: 'in_progress' }] })
  controller.noteActivity({ kind: 'text', turnId: turn.turnId, text: 'working on it' })
  controller.noteActivity({ kind: 'reasoning', turnId: turn.turnId, text: 'thinking hard' })
  controller.noteActivity({ kind: 'model-start', turnId: turn.turnId })
  const snap = controller.ledger.snapshot()
  assert.equal(snap.plan?.revision, 1, 'the plan reached the ledger via noteActivity')
  assert.equal(snap.plan.items[0].content, 'Fill the form')
  assert.match(snap.assistantTail, /working on it/)
  assert.match(snap.reasoningTail, /thinking hard/)
  assert.notEqual(snap.lastModelDeltaAt, null, 'model-start/text/reasoning bump the model-delta timestamp')
  // A stale-turn activity is still ignored by the guard.
  controller.noteActivity({ kind: 'plan', turnId: 'turn-old', revision: 9, items: [{ content: 'x', status: 'pending' }] })
  assert.equal(controller.ledger.snapshot().plan.revision, 1)
  runner.current.resolve('done')
  await turn.done
})

test('M3 fix: PLAN_STALLED is reachable live via the activity path (plan via noteActivity)', async () => {
  const clock = watchClock()
  const { controller, runner } = setup({ watch: clock.options })
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  // The plan arrives via noteActivity (the live path); without the fix the
  // ledger would have no plan and PLAN_STALLED could never fire.
  controller.noteActivity({ kind: 'plan', turnId: turn.turnId, revision: 1, items: [{ content: 'Step', status: 'in_progress' }] })
  // 25 successful mutations via the runner (publish path), distinct args.
  for (let i = 0; i < 25; i += 1) {
    runner.toolCall(`p${i}`, 'browser_click', JSON.stringify({ label: i }))
    runner.toolResult({ callId: `p${i}` })
  }
  clock.advance(1_000)
  const assessment = assess(controller.ledger.snapshot(), clock.options.now())
  assert.ok(assessment.signals.some(signal => signal.kind === 'PLAN_STALLED' && signal.level === 'suspect'),
    `PLAN_STALLED must fire via activities: ${JSON.stringify(assessment.signals)}`)
  // A plan revision (via noteActivity) resets the stall counter.
  controller.noteActivity({ kind: 'plan', turnId: turn.turnId, revision: 2, items: [{ content: 'Step', status: 'in_progress' }] })
  assert.ok(!assess(controller.ledger.snapshot(), clock.options.now()).signals.some(signal => signal.kind === 'PLAN_STALLED'))
  runner.current.resolve('done')
  await turn.done
})

test('M3 fix: turnEnded ending info drives pushTypeForTurn to watch for an unfinished marathon turn (real wiring)', async () => {
  const clock = watchClock()
  const { controller, runner, observed } = setup({ watch: clock.options })
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  controller.noteActivity({ kind: 'turn-outcome', turnId: turn.turnId, turn: 1, planOutcome: 'unfinished', planRevision: 2 })
  runner.current.resolve('PARTIAL — items remain')
  await turn.done
  const endInfo = observed.find(([kind]) => kind === 'end')[1]
  assert.equal(endInfo.marathon, true)
  assert.equal(endInfo.endedIncomplete, true, 'the authoritative watcher decision is carried')
  assert.equal(endInfo.planOutcome, 'unfinished')
  assert.equal(pushTypeForTurn(endInfo), 'watch', 'the real controller→push wiring yields a watch push')
  // The chat.done watch summary keeps its {checks,alerts,usage} shape.
  assert.deepEqual(Object.keys(endInfo).filter(k => k === 'watch'), [], 'ending info has no watch blob; summary rides chat.done')
})

test('M3 fix: a clean marathon turn pushes done; a non-marathon turn pushes done', async () => {
  const clock = watchClock()
  const clean = setup({ watch: clock.options })
  clean.controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = clean.controller.submit({ text: 'task' })
  await clean.runner.started()
  clean.controller.noteActivity({ kind: 'turn-outcome', turn: 1, planOutcome: 'reported-complete', planRevision: 1 })
  clean.runner.current.resolve('DONE — all complete')
  await turn.done
  const cleanEnd = clean.observed.find(([kind]) => kind === 'end')[1]
  assert.equal(cleanEnd.endedIncomplete, false)
  assert.equal(pushTypeForTurn(cleanEnd), 'done')

  const plain = setup({ watch: watchClock().options })
  const turn2 = plain.controller.submit({ text: 'quick' })
  await plain.runner.started()
  plain.runner.current.resolve('done')
  await turn2.done
  const plainEnd = plain.observed.find(([kind]) => kind === 'end')[1]
  assert.equal(plainEnd.marathon, false)
  assert.equal(pushTypeForTurn(plainEnd), 'done')
})

/* ------------------------------------------------------------------ */
/* V1 alert lifecycle (§3.2): close frames through the controller      */
/* ------------------------------------------------------------------ */

async function startMarathonHang(setupResult, clock) {
  const { controller, runner } = setupResult
  controller.setMarathon({ enabled: true, origin: 'ui' })
  const turn = controller.submit({ text: 'long task' })
  await runner.started()
  runner.event('tool/call', { callId: 'hang-1', name: 'browser_wait_for', arguments: '{}' })
  clock.advance(240_000)
  controller.watcher.tick()
  return turn
}

test('V1: turn end closes the open mid-turn alert; no stale open notice', async () => {
  const clock = watchClock()
  const s = setup({ watch: clock.options })
  const turn = await startMarathonHang(s, clock)
  const alertId = s.controller.watchState().open.id
  s.runner.toolResult({ callId: 'hang-1' })
  s.runner.current.resolve('DONE — finished')
  await turn.done
  const closed = s.frames.find(f => f.type === 'chat.watch' && f.state === 'closed')
  assert.equal(closed.id, alertId)
  assert.equal(closed.reason, 'Turn ended.')
  assert.equal(s.controller.watchState().open, null, 'no stale alert after turn end')
})

test('V1: ended-incomplete is dismissable through the controller (ack 200)', async () => {
  const clock = watchClock()
  const s = setup({ watch: clock.options })
  const turn = await startMarathonHang(s, clock)
  s.controller.noteActivity({ kind: 'turn-outcome', turnId: turn.turnId, turn: 1, planOutcome: 'unfinished', planRevision: 2 })
  s.runner.toolResult({ callId: 'hang-1' })
  s.runner.current.resolve('PARTIAL — items remain')
  await turn.done
  const open = s.controller.watchState().open
  assert.equal(open.kind, 'ended-incomplete')
  assert.deepEqual(s.controller.watchAck(open.id), { ok: true })
  assert.equal(s.controller.watchState().open, null)
  assert.equal(s.controller.watchAck(open.id).code, 'WATCH_NOT_FOUND')
})

test('V1: #begin closes the open ended-incomplete BEFORE the new turn first frame', async () => {
  const clock = watchClock()
  const s = setup({ watch: clock.options })
  const turn = await startMarathonHang(s, clock)
  s.controller.noteActivity({ kind: 'turn-outcome', turnId: turn.turnId, turn: 1, planOutcome: 'unfinished', planRevision: 2 })
  s.runner.toolResult({ callId: 'hang-1' })
  s.runner.current.resolve('PARTIAL — items remain')
  await turn.done
  const endedId = s.controller.watchState().open.id
  assert.equal(s.controller.watchState().open.kind, 'ended-incomplete')
  // Start a new turn; the close frame must precede the new turn's first frame.
  const before = s.frames.length
  const turn2 = s.controller.submit({ text: 'continue' })
  await s.runner.started()
  const newFrames = s.frames.slice(before)
  const closedIdx = newFrames.findIndex(f => f.type === 'chat.watch' && f.state === 'closed')
  const firstTurnFrameIdx = newFrames.findIndex(f => f.type === 'chat.session' || f.type === 'chat.user' || f.type === 'chat.tool_call')
  assert.ok(closedIdx >= 0, 'a close frame was emitted at turn start')
  assert.equal(newFrames[closedIdx].id, endedId)
  assert.equal(newFrames[closedIdx].reason, 'A new turn started.')
  assert.ok(firstTurnFrameIdx === -1 || closedIdx < firstTurnFrameIdx, 'close precedes the new turn first frame')
  assert.equal(s.controller.watchState().open, null, 'amber never carries into the new turn')
  s.runner.current.resolve('done')
  await turn2.done
})

test('V1: marathon off clears the open ended-incomplete notice', async () => {
  const clock = watchClock()
  const s = setup({ watch: clock.options })
  const turn = await startMarathonHang(s, clock)
  s.controller.noteActivity({ kind: 'turn-outcome', turnId: turn.turnId, turn: 1, planOutcome: 'unfinished', planRevision: 2 })
  s.runner.toolResult({ callId: 'hang-1' })
  s.runner.current.resolve('PARTIAL — items remain')
  await turn.done
  const endedId = s.controller.watchState().open.id
  s.controller.setMarathon({ enabled: false, origin: 'ui' })
  assert.equal(s.controller.watchState().open, null)
  assert.equal(s.controller.watchAck(endedId).code, 'WATCH_NOT_FOUND')
})

test('V1: newChat clears the open ended-incomplete notice', async () => {
  const clock = watchClock()
  const s = setup({ watch: clock.options })
  const turn = await startMarathonHang(s, clock)
  s.controller.noteActivity({ kind: 'turn-outcome', turnId: turn.turnId, turn: 1, planOutcome: 'unfinished', planRevision: 2 })
  s.runner.toolResult({ callId: 'hang-1' })
  s.runner.current.resolve('PARTIAL — items remain')
  await turn.done
  assert.equal(s.controller.watchState().open.kind, 'ended-incomplete')
  await s.controller.newChat()
  assert.equal(s.controller.watchState().open, null)
})
