import test from 'node:test'
import assert from 'node:assert/strict'
import { ImageDedupe } from '../lib/image-dedupe.js'

const attach = { attach: true, duplicate: false }
const duplicate = { attach: false, duplicate: true }
const png = data => ({ data, mimeType: 'image/png' })

test('attaches a first image and suppresses its exact repeat', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', png('first')), attach)
  assert.deepEqual(dedupe.admit('session', png('first')), duplicate)
})

test('a changed image replaces the sole comparison basis', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', png('first')), attach)
  assert.deepEqual(dedupe.admit('session', png('second')), attach)
  assert.deepEqual(dedupe.admit('session', png('second')), duplicate)
  assert.deepEqual(dedupe.admit('session', png('first')), attach)
})

test('mimeType is part of the image fingerprint', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', png('same-bytes')), attach)
  assert.deepEqual(dedupe.admit('session', { data: 'same-bytes', mimeType: 'image/jpeg' }), attach)
  assert.deepEqual(dedupe.admit('session', png('same-bytes')), attach)
})

test('different encoded strings are different even when they decode alike', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', png('aW1hZ2U=')), attach)
  assert.deepEqual(dedupe.admit('session', png('aW1hZ2U')), attach)
})

test('sessions have independent latest images', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('one', png('shared')), attach)
  assert.deepEqual(dedupe.admit('two', png('shared')), attach)
  assert.deepEqual(dedupe.admit('one', png('shared')), duplicate)
  assert.deepEqual(dedupe.admit('two', png('changed')), attach)
  assert.deepEqual(dedupe.admit('one', png('shared')), duplicate)
  assert.deepEqual(dedupe.admit('two', png('shared')), attach)
})

test('missing session ids attach repeatedly without caching', () => {
  const dedupe = new ImageDedupe()
  for (const sessionId of [undefined, null, '']) {
    assert.deepEqual(dedupe.admit(sessionId, png('same')), attach)
    assert.deepEqual(dedupe.admit(sessionId, png('same')), attach)
  }
  assert.deepEqual(dedupe.admit('session', png('cached')), attach)
  assert.deepEqual(dedupe.admit(undefined, png('other')), attach)
  assert.deepEqual(dedupe.admit('session', png('cached')), duplicate)
})

test('malformed images attach without caching or clearing valid state', () => {
  const dedupe = new ImageDedupe()
  const malformed = [
    undefined,
    null,
    [],
    {},
    { data: 'image' },
    { mimeType: 'image/png' },
    { data: '', mimeType: 'image/png' },
    { data: 'image', mimeType: '' },
    { data: 123, mimeType: 'image/png' },
    { data: 'image', mimeType: 123 },
  ]
  for (const image of malformed) {
    assert.deepEqual(dedupe.admit('session', image), attach)
    assert.deepEqual(dedupe.admit('session', image), attach)
  }
  assert.deepEqual(dedupe.admit('session', png('cached')), attach)
  for (const image of malformed) {
    assert.deepEqual(dedupe.admit('session', image), attach)
  }
  assert.deepEqual(dedupe.admit('session', png('cached')), duplicate)
})

test('unknown image fields do not affect exact duplicate detection', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', { ...png('same'), width: 100, label: 'first' }), attach)
  assert.deepEqual(dedupe.admit('session', { ...png('same'), width: 200, ignored: { anything: true } }), duplicate)
})

test('interleaved text-only results require no call and preserve the basis', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', png('same')), attach)
  // A text-only tool result performs no ImageDedupe operation.
  assert.deepEqual(dedupe.admit('session', png('same')), duplicate)
})

test('repeated duplicates keep the original basis', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', png('same')), attach)
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(dedupe.admit('session', png('same')), duplicate)
  }
  assert.deepEqual(dedupe.admit('session', png('different')), attach)
  assert.deepEqual(dedupe.admit('session', png('same')), attach)
})

test('the LRU retains 50 sessions and evicts the least recently used', () => {
  const dedupe = new ImageDedupe()
  for (let index = 0; index < 50; index += 1) {
    assert.deepEqual(dedupe.admit(`session-${index}`, png('shared')), attach)
  }
  assert.deepEqual(dedupe.admit('session-0', png('shared')), duplicate)
  assert.deepEqual(dedupe.admit('session-50', png('shared')), attach)

  assert.deepEqual(dedupe.admit('session-1', png('shared')), attach)
  assert.deepEqual(dedupe.admit('session-0', png('shared')), duplicate)
  assert.deepEqual(dedupe.admit('session-50', png('shared')), duplicate)
})

test('identical content attaches again after clear', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', png('same')), attach)
  assert.deepEqual(dedupe.admit('session', png('same')), duplicate)
  dedupe.clear('session')
  assert.deepEqual(dedupe.admit('session', png('same')), attach)
  assert.deepEqual(dedupe.admit('session', png('same')), duplicate)
})

test('repeated clear and unknown ids are harmless', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', png('same')), attach)
  dedupe.clear('unknown')
  dedupe.clear('unknown')
  assert.deepEqual(dedupe.admit('session', png('same')), duplicate)
  dedupe.clear('session')
  dedupe.clear('session')
  assert.deepEqual(dedupe.admit('session', png('same')), attach)
})

test('clear does not disturb other sessions', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('one', png('shared')), attach)
  assert.deepEqual(dedupe.admit('two', png('shared')), attach)
  dedupe.clear('one')
  assert.deepEqual(dedupe.admit('two', png('shared')), duplicate)
  assert.deepEqual(dedupe.admit('one', png('shared')), attach)
  assert.deepEqual(dedupe.admit('two', png('shared')), duplicate)
})

test('malformed clear input does not clear valid state', () => {
  const dedupe = new ImageDedupe()
  assert.deepEqual(dedupe.admit('session', png('same')), attach)
  dedupe.clear()
  assert.deepEqual(dedupe.admit('session', png('same')), duplicate)
  for (const sessionId of [null, '']) {
    dedupe.clear(sessionId)
    assert.deepEqual(dedupe.admit('session', png('same')), duplicate)
  }
})
