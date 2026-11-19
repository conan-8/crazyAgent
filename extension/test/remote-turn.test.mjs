import test from 'node:test'
import assert from 'node:assert/strict'
import { BUSY_REFUSAL_CODES, foreignPrompt, helpNotice, confirmNotice, isBusyRefusal, runningTurnPrompt } from '../sidepanel/remote-turn.js'

test('a phone prompt becomes a labelled turn with name-only image placeholders', () => {
  assert.deepEqual(foreignPrompt({ type: 'chat.user', turnId: 'turn-1', origin: 'remote', text: 'check the cart', imageCount: 2 }), {
    turnId: 'turn-1',
    origin: 'remote',
    label: 'From phone',
    text: 'check the cart',
    marathon: null,
    attachments: [{ name: 'phone image 1' }, { name: 'phone image 2' }],
  })
})

test('the marathon arming flag passes through only as an explicit boolean', () => {
  assert.equal(foreignPrompt({ type: 'chat.user', origin: 'remote', text: 'x', marathon: true }).marathon, true)
  assert.equal(foreignPrompt({ type: 'chat.user', origin: 'remote', text: 'x', marathon: false }).marathon, false)
  assert.equal(foreignPrompt({ type: 'chat.user', origin: 'remote', text: 'x', marathon: 'yes' }).marathon, null)
  assert.equal(foreignPrompt({ type: 'chat.user', origin: 'remote', text: 'x' }).marathon, null)
})

test('panel-originated, malformed, and non-user frames are not foreign prompts', () => {
  for (const frame of [
    { type: 'chat.user', origin: 'ui', text: 'mine' },
    { type: 'chat.user', text: 'no origin' },
    { type: 'chat.user', origin: '', text: 'empty origin' },
    { type: 'chat.assistant', origin: 'remote', text: 'x' },
    null,
    'chat.user',
    [],
  ]) {
    assert.equal(foreignPrompt(frame), null, JSON.stringify(frame))
  }
})

test('unknown origins get a generic label, and image counts are bounded', () => {
  const prompt = foreignPrompt({ type: 'chat.user', origin: 'telegram', text: 'x', imageCount: 99 })
  assert.equal(prompt.label, 'From telegram')
  assert.equal(prompt.attachments.length, 4)
  assert.equal(foreignPrompt({ type: 'chat.user', origin: 'remote', imageCount: -3 }).attachments.length, 0)
  assert.equal(foreignPrompt({ type: 'chat.user', origin: 'remote', text: 7 }).text, '')
})

test('only slot-held refusal codes count as busy refusals', () => {
  for (const code of BUSY_REFUSAL_CODES) assert.equal(isBusyRefusal({ type: 'chat.error', code }), true)
  for (const frame of [
    { type: 'chat.error', message: 'A turn is already running.' },
    { type: 'chat.error', code: 'RUNTIME_NOT_READY' },
    { type: 'chat.error', code: 'TURN_ERROR' },
    null,
  ]) {
    assert.equal(isBusyRefusal(frame), false)
  }
})

test('a help notice comes only from the structured help field of a finished turn', () => {
  assert.deepEqual(helpNotice({ type: 'chat.done', text: 'x', help: { category: 'login', reason: ' Sign in to the site. ' } }), {
    label: 'Sign-in needed', reason: 'Sign in to the site.', category: 'login',
  })
  assert.equal(helpNotice({ help: { category: 'mystery', reason: 'x' } }).label, 'Your help needed')
  assert.equal(helpNotice({ help: { category: 'constructor', reason: 'x' } }).label, 'Your help needed')
  for (const frame of [
    null,
    { type: 'chat.done', text: 'I need help, please log in' },
    { help: 'log in' },
    { help: { category: 'login', reason: '   ' } },
    { help: { category: 'login' } },
    { help: { reason: 'x' } },
  ]) assert.equal(helpNotice(frame), null)
})

test('a confirm notice comes only from the structured confirm field of a finished turn', () => {
  assert.deepEqual(confirmNotice({ type: 'chat.done', text: 'x', confirm: { action: ' Submit the assignment. ', target: ' Submit button ' } }), {
    action: 'Submit the assignment.', target: 'Submit button',
  })
  assert.equal(confirmNotice({ confirm: { action: 'x'.repeat(300), target: 'y' } }).action.length, 200)
  assert.equal(confirmNotice({ confirm: { action: 'x', target: 'y'.repeat(300) } }).target.length, 200)
  for (const frame of [
    null,
    { type: 'chat.done', text: 'I will submit it after you approve' },
    { confirm: 'approve' },
    { confirm: { action: '   ', target: 'x' } },
    { confirm: { action: 'x', target: '' } },
    { confirm: { action: 'x' } },
    { confirm: { target: 'x' } },
    { confirm: { action: 5, target: 'x' } },
  ]) assert.equal(confirmNotice(frame), null)
})

test('a turn already running when the panel connects is shown, whichever client started it', () => {
  assert.deepEqual(runningTurnPrompt({ running: true, turnId: 'turn-9', origin: 'ui', text: 'make the doc', imageCount: 1, marathon: true }), {
    turnId: 'turn-9',
    origin: 'ui',
    label: 'Still running',
    text: 'make the doc',
    marathon: true,
    attachments: [{ name: 'image 1' }],
  })
  const phone = runningTurnPrompt({ running: true, turnId: 'turn-8', origin: 'remote', text: 'check the cart', imageCount: 0 })
  assert.equal(phone.label, 'From phone')
  assert.equal(phone.origin, 'remote')
  for (const turn of [null, undefined, {}, { running: false, origin: 'ui', text: 'x' }, 'running', []]) {
    assert.equal(runningTurnPrompt(turn), null)
  }
})
