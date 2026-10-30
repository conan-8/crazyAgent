import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FULL_PAGE_MAX_DIMENSION,
  FULL_PAGE_MAX_PIXELS,
  checkedFullPageSize,
  mapScreenshotRegion,
  parseScreenshotArgs,
} from '../sidepanel/capture.js'

test('screenshot args preserve the viewport default and accept capture options', () => {
  assert.deepEqual(parseScreenshotArgs({}), {
    detail: 'normal', delayMs: 0, scope: 'viewport', region: undefined, space: 'image', viewId: undefined, toClipboard: false,
  })
  assert.deepEqual(parseScreenshotArgs({
    detail: 'high', delay_ms: 250, scope: 'region', region: { x: 10, y: 20, width: 300, height: 200 }, view_id: 4, to_clipboard: true,
  }), {
    detail: 'high', delayMs: 250, scope: 'region', region: { x: 10, y: 20, width: 300, height: 200 }, space: 'image', viewId: 4, toClipboard: true,
  })
  assert.equal(parseScreenshotArgs({ scope: 'full_page' }).scope, 'full_page')
})

test('screenshot args reject malformed and mismatched fields before capture', () => {
  const rejected = [
    [{ detail: 'ultra' }, 'BAD_SCREENSHOT'],
    [{ delay_ms: -1 }, 'BAD_SCREENSHOT'],
    [{ delay_ms: 5001 }, 'BAD_SCREENSHOT'],
    [{ scope: 'element' }, 'BAD_SCREENSHOT'],
    [{ scope: 'region' }, 'BAD_REGION'],
    [{ scope: 'region', region: { x: 0, y: 0, width: 0, height: 2 } }, 'BAD_REGION'],
    [{ scope: 'region', region: { x: 0, y: 0, width: 2, height: 2, label: 3 } }, 'BAD_REGION'],
    [{ scope: 'full_page', region: { x: 0, y: 0, width: 2, height: 2 } }, 'BAD_REGION'],
    [{ scope: 'region', region: { x: 0, y: 0, width: 2, height: 2 }, view_id: 0 }, 'BAD_VIEW'],
    [{ to_clipboard: 'yes' }, 'BAD_SCREENSHOT'],
    [{ unexpected: true }, 'BAD_SCREENSHOT'],
  ]
  for (const [args, code] of rejected) {
    assert.throws(() => parseScreenshotArgs(args), error => error.code === code, JSON.stringify(args))
  }
})

test('region mapping uses the selected screenshot scale and preserves the full area', () => {
  assert.deepEqual(
    mapScreenshotRegion({ x: 100.2, y: 50.1, width: 200.3, height: 100.2 }, 'image', { width: 800, height: 600 }, 2),
    { x: 200, y: 100, width: 401, height: 201 },
  )
  assert.deepEqual(
    mapScreenshotRegion({ x: 10, y: 20, width: 30, height: 40 }, 'css', { width: 800, height: 600 }),
    { x: 10, y: 20, width: 30, height: 40 },
  )
  assert.throws(
    () => mapScreenshotRegion({ x: 700, y: 20, width: 101, height: 40 }, 'css', { width: 800, height: 600 }),
    error => error.code === 'OFF_SCREEN_REGION',
  )
  assert.throws(
    () => mapScreenshotRegion({ x: -1, y: 20, width: 10, height: 40 }, 'css', { width: 800, height: 600 }),
    error => error.code === 'OFF_SCREEN_REGION',
  )
})

test('full-page bounds fail closed instead of truncating the page', () => {
  assert.deepEqual(checkedFullPageSize(800.2, 1200.1), { width: 801, height: 1201 })
  assert.throws(() => checkedFullPageSize(0, 100), error => error.code === 'CAPTURE_EMPTY')
  assert.throws(() => checkedFullPageSize(FULL_PAGE_MAX_DIMENSION + 1, 100), error => error.code === 'CAPTURE_TOO_LARGE')
  assert.throws(() => checkedFullPageSize(FULL_PAGE_MAX_PIXELS, 2), error => error.code === 'CAPTURE_TOO_LARGE')
})
