import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLIPBOARD_IMAGE_MAX_BYTES,
  makeImageClipboardEntry,
  normalizeClipboardEntry,
} from '../sidepanel/clipboard.js'
import {
  extractImageForClipboard,
  imagePasteDeliveryResult,
  parseClipboardArgs,
} from '../sidepanel/browser.js'

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

test('image paste delivery distinguishes observed insertion from paste and drop handling', () => {
  const target = { tag: 'div', editable: true, body: false }
  assert.deepEqual(imagePasteDeliveryResult({
    pasteHandled: false,
    mutationObserved: true,
    dropDispatched: false,
    dropHandled: false,
    target,
  }), {
    ok: true,
    handled: true,
    pasteHandled: false,
    dropHandled: false,
    dropDispatched: false,
    handledBy: 'page-mutation',
    events: ['paste'],
    target,
  })
  const dropped = imagePasteDeliveryResult({
    pasteHandled: false,
    mutationObserved: false,
    dropDispatched: true,
    dropHandled: true,
    target,
  })
  assert.equal(dropped.handledBy, 'drop')
  assert.deepEqual(dropped.events, ['paste', 'drop'])
})

test('parseClipboardArgs validates image and download copy sources', () => {
  assert.equal(parseClipboardArgs({ action: 'copy', source: 'image', label: 12 }).source, 'image')
  assert.equal(parseClipboardArgs({ action: 'copy', source: 'image' }).label, undefined)
  const dl = parseClipboardArgs({ action: 'copy', filename: 'photo.jpg' })
  assert.equal(dl.source, 'download')
  assert.equal(dl.filename, 'photo.jpg')
  assert.throws(() => parseClipboardArgs({ action: 'copy', source: 'download' }), error => error.code === 'BAD_FILENAME')
  assert.throws(() => parseClipboardArgs({ action: 'copy', source: 'download', filename: 'a.jpg', label: 2 }), error => error.code === 'BAD_LABEL')
  assert.throws(() => parseClipboardArgs({ action: 'copy', source: 'image', target: 'system' }), error => error.code === 'BAD_CLIPBOARD_TARGET')
  assert.throws(() => parseClipboardArgs({ action: 'copy', source: 'selection', filename: 'a.jpg' }), error => error.code === 'BAD_FILENAME')
  const entry = makeImageClipboardEntry({ image, source: 'download', filename: 'mountain.jpg', at: 42 })
  assert.equal(entry.filename, 'mountain.jpg')
  assert.equal(normalizeClipboardEntry(entry).filename, 'mountain.jpg')
})

test('extractImageForClipboard resolves labelled img, clickable thumbnail, solo image tab, and fails closed on ambiguity', t => {
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    getComputedStyle: globalThis.getComputedStyle,
    __crazyagent: globalThis.__crazyagent,
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete globalThis[k]
      else globalThis[k] = v
    }
  })
  const makeImg = (src, alt = 'Mountain', w = 400, h = 300) => ({
    tagName: 'IMG',
    isConnected: true,
    complete: true,
    currentSrc: src,
    src,
    naturalWidth: w,
    naturalHeight: h,
    getAttribute: name => (name === 'alt' ? alt : null),
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 10 + w, bottom: 10 + h, width: w, height: h }),
  })
  const thumbImg = makeImg('https://example.test/thumb.jpg', 'Fjord')
  const linkEl = {
    tagName: 'A',
    isConnected: true,
    querySelectorAll: sel => (sel === 'img' ? [thumbImg] : []),
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 410, bottom: 310, width: 400, height: 300 }),
  }
  const secondImg = makeImg('https://example.test/two.jpg', 'Lake')
  globalThis.window = { innerWidth: 1200, innerHeight: 800 }
  globalThis.location = { href: 'https://example.test/gallery' }
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', backgroundImage: 'none' })
  globalThis.document = {
    contentType: 'text/html',
    querySelector: () => thumbImg,
    querySelectorAll: sel => (sel === 'img' ? [thumbImg, secondImg] : []),
  }
  globalThis.__crazyagent = { byId: new Map([[7, linkEl], [8, thumbImg]]) }

  assert.equal(extractImageForClipboard(7).src, 'https://example.test/thumb.jpg')
  assert.equal(extractImageForClipboard(8).alt, 'Fjord')
  assert.equal(extractImageForClipboard(0).code, 'AMBIGUOUS_IMAGE')

  globalThis.document.contentType = 'image/jpeg'
  assert.equal(extractImageForClipboard(0).src, 'https://example.test/thumb.jpg')
})
