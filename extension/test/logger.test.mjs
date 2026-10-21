import test from 'node:test'
import assert from 'node:assert/strict'
import { ClientLogger } from '../sidepanel/logger.js'

test('buffers before ready and flushes after hello', () => {
  const frames = []
  let online = false
  const logger = new ClientLogger({
    send: frame => {
      if (!online) return false
      frames.push(frame)
      return true
    },
    context: { extensionVersion: '0.1.0', settings: { tokenLength: 64 } },
  })

  logger.log('app.boot', { version: '0.1.0' }, 'info')
  logger.log('bridge.open', { url: 'ws://127.0.0.1:1/bridge' }, 'info')
  assert.equal(logger.pending, 2)
  assert.equal(frames.length, 0)

  online = true
  logger.setReady(true)
  assert.equal(logger.pending, 0)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].type, 'log.event')
  assert.equal(frames[0].event.source, 'extension')
  assert.equal(frames[0].event.type, 'app.boot')
  assert.equal(frames[0].event.severity, 'info')
  assert.deepEqual(frames[0].event.data, { version: '0.1.0' })
})

test('keeps events when the bridge drops and flushes on reconnect', () => {
  const frames = []
  let online = true
  const logger = new ClientLogger({ send: frame => { if (!online) return false; frames.push(frame); return true } })
  logger.setReady(true)
  logger.log('chat.send', { textLength: 3 }, 'info')
  assert.equal(frames.length, 1)
  online = false
  logger.log('bridge.closed', { code: 1006 }, 'warn')
  assert.equal(logger.pending, 1)
  online = true
  logger.setReady(false)
  logger.setReady(true)
  assert.equal(logger.pending, 0)
  assert.equal(frames.length, 2)
  assert.equal(frames[1].event.type, 'bridge.closed')
})

test('caps the offline buffer', () => {
  const logger = new ClientLogger({ send: () => false, maxBuffer: 3 })
  for (let i = 0; i < 10; i += 1) logger.log('x', { i }, 'debug')
  assert.equal(logger.pending, 3)
  const frames = []
  logger.send = frame => { frames.push(frame); return true }
  logger.setReady(true)
  assert.equal(frames.length, 3)
  assert.deepEqual(frames.map(frame => frame.event.data.i), [7, 8, 9])
})

test('context updates are logged without requiring a token', () => {
  const frames = []
  const logger = new ClientLogger({ send: frame => { frames.push(frame); return true } })
  logger.setReady(true)
  logger.setContext({ extensionVersion: '0.1.0', settings: { tokenLength: 64 } })
  assert.equal(frames.length, 1)
  assert.equal(frames[0].event.type, 'app.context')
  assert.equal(frames[0].event.data.settings.tokenLength, 64)
  assert.ok(!('token' in frames[0].event.data.settings))
})