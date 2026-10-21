import test from 'node:test'
import assert from 'node:assert/strict'
import { computeScrollPixels, isProtectedUrl, scaleDimensions } from '../sidepanel/browser.js'

test('scaleDimensions preserves aspect ratio and never upscales', () => {
  assert.deepEqual(scaleDimensions(2560, 1440, 1280), { width: 1280, height: 720 })
  assert.deepEqual(scaleDimensions(800, 600, 1280), { width: 800, height: 600 })
  assert.deepEqual(scaleDimensions(0, 0, 1280), { width: 1, height: 1 })
  assert.deepEqual(scaleDimensions(1920, 1080, 2048), { width: 1920, height: 1080 })
})

test('computeScrollPixels uses pages, then amount_px, and clamps to one pixel', () => {
  const viewport = { width: 1280, height: 720 }
  assert.equal(computeScrollPixels('down', undefined, undefined, viewport), 612)
  assert.equal(computeScrollPixels('right', 0.5, undefined, viewport), 640)
  assert.equal(computeScrollPixels('down', 1, 1000, viewport), 1000)
  assert.equal(computeScrollPixels('down', 0, 0, viewport), 612)
})

test('isProtectedUrl identifies browser-owned and blocked surfaces', () => {
  assert.equal(isProtectedUrl('chrome://settings'), true)
  assert.equal(isProtectedUrl('edge://extensions'), true)
  assert.equal(isProtectedUrl('chrome-extension://abc/sidepanel.html'), true)
  assert.equal(isProtectedUrl('devtools://devtools/bundled/inspector.html'), true)
  assert.equal(isProtectedUrl('view-source:https://example.com'), true)
  assert.equal(isProtectedUrl('https://chromewebstore.google.com/detail/x'), true)
  assert.equal(isProtectedUrl('https://example.com/article'), false)
  assert.equal(isProtectedUrl('http://127.0.0.1:8080/'), false)
  assert.equal(isProtectedUrl(undefined), true)
})