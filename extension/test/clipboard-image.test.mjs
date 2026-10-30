import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLIPBOARD_IMAGE_MAX_BYTES,
  makeImageClipboardEntry,
  normalizeClipboardEntry,
} from '../sidepanel/clipboard.js'

const image = { data: 'iVBORw==', mimeType: 'image/png', width: 2, height: 3, bytes: 4 }

test('image clipboard entries round-trip without changing legacy text entries', () => {
  const entry = makeImageClipboardEntry({ image, source: 'screenshot', tabId: 7, url: 'https://example.test/', at: 123 })
  assert.deepEqual(entry, {
    kind: 'image', text: '', chars: 0, source: 'screenshot', tabId: 7, url: 'https://example.test/', at: 123, image,
  })
  assert.deepEqual(normalizeClipboardEntry(entry), entry)
  assert.deepEqual(normalizeClipboardEntry({ text: 'legacy', source: 'write' }), {
    text: 'legacy', chars: 6, source: 'write', tabId: null, url: '', at: 0,
  })
})

test('image clipboard normalization rejects corrupt, oversized, and non-PNG data', () => {
  assert.equal(normalizeClipboardEntry({ kind: 'image', image: { ...image, mimeType: 'image/jpeg' } }), undefined)
  assert.equal(normalizeClipboardEntry({ kind: 'image', image: { ...image, data: 'not base64!' } }), undefined)
  assert.equal(normalizeClipboardEntry({ kind: 'image', image: { ...image, width: 0 } }), undefined)
  assert.equal(normalizeClipboardEntry({ kind: 'image', image: { ...image, bytes: CLIPBOARD_IMAGE_MAX_BYTES + 1 } }), undefined)
  assert.equal(normalizeClipboardEntry({ kind: 'image', image: { ...image, data: `A${'A'.repeat(CLIPBOARD_IMAGE_MAX_BYTES * 2)}` } }), undefined)
  assert.throws(() => makeImageClipboardEntry({ image: { ...image, height: -1 } }), error => error.code === 'BAD_CLIPBOARD_IMAGE')
})
