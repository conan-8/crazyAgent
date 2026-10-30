import test from 'node:test'
import assert from 'node:assert/strict'
import { execute } from '../sidepanel/browser.js'

let nextTabId = 4_000

function chromeEvent() {
  return { addListener: () => {}, removeListener: () => {} }
}

function fakeCaptureBrowser(t, { pageWidth = 800, pageHeight = 1_200, scrollY = 0 } = {}) {
  const previous = {
    chrome: globalThis.chrome,
    createImageBitmap: globalThis.createImageBitmap,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  }
  const tab = { id: nextTabId++, windowId: 1, active: true, title: 'Capture fixture', url: 'https://example.test/capture', status: 'complete' }
  const commands = []
  const scripts = []
  const stored = new Map()
  let bitmap = { width: 800, height: 600 }
  const metrics = () => ({
    title: tab.title,
    url: tab.url,
    readyState: 'complete',
    viewport: { width: 800, height: 600, dpr: 1 },
    scroll: { x: 0, y: scrollY, maxX: 0, maxY: Math.max(0, pageHeight - 600), container: 'document', pageHeight, pageWidth, atTop: scrollY === 0, atBottom: false },
    fingerprint: { url: tab.url, title: tab.title, scrollX: 0, scrollY, textLen: 0, active: '', layout: [] },
    labels: [],
    knownLabels: [],
    surfaces: [],
  })
  globalThis.createImageBitmap = async () => ({ ...bitmap, close: () => {} })
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height }
    getContext() { return { drawImage: () => {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'medium' } }
    async convertToBlob({ type }) { return new Blob(['display-image'], { type }) }
  }
  globalThis.chrome = {
    windows: { getCurrent: async () => ({ id: 1 }), update: async () => {} },
    tabs: {
      query: async () => [{ ...tab }],
      get: async () => ({ ...tab }),
      captureVisibleTab: async () => {
        bitmap = { width: 800, height: 600 }
        return 'data:image/jpeg;base64,dW51c2Vk'
      },
      onUpdated: chromeEvent(),
      onRemoved: chromeEvent(),
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    scripting: {
      executeScript: async request => {
        const name = request.func?.name
        scripts.push(name)
        if (name === 'labelPage') return [{ result: metrics() }]
        if (name === 'clearLabelsPage') return [{ result: { cleared: true } }]
        if (name === 'pageMetrics') return [{ result: metrics() }]
        if (name === 'waitInPage') return [{ result: {} }]
        if (name === 'restorePageScroll') return [{ result: { x: 0, y: scrollY } }]
        throw new Error(`unexpected page function ${name}`)
      },
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      onEvent: chromeEvent(),
      onDetach: chromeEvent(),
      sendCommand: async (_target, method, params) => {
        commands.push({ method, params })
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: pageWidth, height: pageHeight } }
        if (method === 'Page.captureScreenshot') {
          bitmap = { width: params.clip.width, height: params.clip.height }
          return { data: 'iVBORw==' }
        }
        return {}
      },
    },
    storage: {
      session: {
        get: async key => ({ [key]: stored.get(key) }),
        set: async values => { for (const [key, value] of Object.entries(values)) stored.set(key, value) },
        remove: async key => { stored.delete(key) },
      },
    },
  }
  t.after(() => {
    globalThis.chrome = previous.chrome
    globalThis.createImageBitmap = previous.createImageBitmap
    globalThis.OffscreenCanvas = previous.OffscreenCanvas
  })
  return { commands, scripts, stored }
}

test('full-page capture stores a clean PNG without creating a viewport coordinate basis', async t => {
  const fake = fakeCaptureBrowser(t, { scrollY: 100 })
  const result = await execute('snapshot', { scope: 'full_page', to_clipboard: true }, {})
  const capture = fake.commands.find(command => command.method === 'Page.captureScreenshot')
  assert.deepEqual(capture.params.clip, { x: 0, y: 0, width: 800, height: 1_200, scale: 1 })
  assert.equal(capture.params.captureBeyondViewport, true)
  const override = fake.commands.find(command => command.method === 'Emulation.setDeviceMetricsOverride')
  assert.deepEqual(override.params, { width: 800, height: 1_200, deviceScaleFactor: 1, mobile: false })
  assert.ok(fake.commands.some(command => command.method === 'Emulation.clearDeviceMetricsOverride'))
  assert.ok(fake.scripts.includes('restorePageScroll'))
  assert.ok(fake.scripts.indexOf('clearLabelsPage') < fake.scripts.lastIndexOf('labelPage') || fake.scripts.includes('clearLabelsPage'))
  assert.equal(result.viewId, undefined)
  assert.equal(result.labelCount, 0)
  assert.deepEqual(result.capture, { scope: 'full_page', unlabelled: true, cssWidth: 800, cssHeight: 1_200 })
  assert.equal(result.clipboard.kind, 'image')
  assert.equal(result.clipboard.width, 800)
  assert.equal(result.clipboard.height, 1_200)

  const read = await execute('clipboard', { action: 'read' }, {})
  assert.equal(read.clipboard.kind, 'image')
  assert.equal(read.image.data, 'iVBORw==')
  assert.equal(read.image.mimeType, 'image/png')
  assert.equal(read.text, undefined)
})

test('region capture maps current-view image coordinates into page clip coordinates', async t => {
  const fake = fakeCaptureBrowser(t, { scrollY: 100 })
  const initial = await execute('snapshot', {}, {})
  const result = await execute('snapshot', {
    scope: 'region', region: { x: 100, y: 50, width: 200, height: 100 }, view_id: initial.viewId, to_clipboard: true,
  }, {})
  const capture = fake.commands.find(command => command.method === 'Page.captureScreenshot')
  assert.deepEqual(capture.params.clip, { x: 100, y: 150, width: 200, height: 100, scale: 1 })
  assert.equal(result.capture.scope, 'region')
  assert.deepEqual(result.capture.region, { x: 100, y: 50, width: 200, height: 100 })
  assert.equal(result.basis.viewId, initial.viewId)
  assert.equal(result.viewId, undefined)
  assert.equal(result.clipboard.width, 200)
  assert.equal(result.clipboard.height, 100)
})
