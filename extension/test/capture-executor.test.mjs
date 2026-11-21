import test from 'node:test'
import assert from 'node:assert/strict'
import { execute } from '../sidepanel/browser.js'

let nextTabId = 4_000

function chromeEvent() {
  return { addListener: () => {}, removeListener: () => {} }
}

function fakeCaptureBrowser(t, {
  pageWidth = 800,
  pageHeight = 1_200,
  scrollY = 0,
  focused = true,
  windowState = 'normal',
  captureFailure,
  debuggerFailure,
} = {}) {
  const previous = {
    chrome: globalThis.chrome,
    createImageBitmap: globalThis.createImageBitmap,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  }
  const tab = { id: nextTabId++, windowId: 1, active: true, title: 'Capture fixture', url: 'https://example.test/capture', status: 'complete' }
  const commands = []
  const scripts = []
  const stored = new Map()
  const state = { visibleCaptureCalls: 0, focusCalls: 0 }
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
    getContext() { return { drawImage: () => {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'medium', save() {}, restore() {}, scale() {}, strokeRect() {}, fillRect() {}, fillText() {}, measureText: () => ({ width: 8 }) } }
    async convertToBlob({ type }) { return new Blob(['display-image'], { type }) }
  }
  globalThis.chrome = {
    windows: {
      getCurrent: async () => ({ id: 1, focused, state: windowState }),
      get: async id => ({ id, focused, state: windowState }),
      update: async () => { state.focusCalls += 1 },
    },
    tabs: {
      query: async () => [{ ...tab }],
      get: async () => ({ ...tab }),
      captureVisibleTab: async () => {
        state.visibleCaptureCalls += 1
        if (captureFailure) throw captureFailure
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
      attach: async () => {
        if (debuggerFailure) throw debuggerFailure
      },
      detach: async () => {},
      onEvent: chromeEvent(),
      onDetach: chromeEvent(),
      sendCommand: async (_target, method, params) => {
        commands.push({ method, params })
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: pageWidth, height: pageHeight } }
        if (method === 'Page.captureScreenshot') {
          const width = params.clip?.width ?? 800
          const height = params.clip?.height ?? 600
          bitmap = { width, height }
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
  return { commands, scripts, stored, state }
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

test('focused window keeps the fast visible-tab viewport capture', async t => {
  const fake = fakeCaptureBrowser(t, { focused: true })
  const result = await execute('snapshot', {}, {})
  assert.equal(result.view, 'full')
  assert.equal(result.image.width, 800)
  assert.equal(result.image.mimeType, 'image/jpeg')
  assert.equal(fake.state.visibleCaptureCalls, 1)
  assert.equal(fake.state.focusCalls, 0)
  assert.equal(fake.commands.filter(command => command.method === 'Page.captureScreenshot').length, 0)
})

test('unfocused window captures the viewport through the page debugger without touching the window', async t => {
  const fake = fakeCaptureBrowser(t, { focused: false })
  const result = await execute('snapshot', {}, {})
  assert.equal(result.view, 'full')
  assert.equal(result.image.width, 800)
  assert.equal(result.image.height, 600)
  assert.ok(result.viewId > 0, 'the page capture still creates a viewport coordinate basis')
  const capture = fake.commands.find(command => command.method === 'Page.captureScreenshot')
  assert.deepEqual(capture.params, { format: 'jpeg', quality: 72, fromSurface: true, captureBeyondViewport: false })
  assert.equal(fake.state.visibleCaptureCalls, 0, 'an unfocused window never waits on the visible-tab API')
  assert.equal(fake.state.focusCalls, 0, 'capturing an unfocused window never steals focus')
})

test('minimized window captures through the page debugger and never calls the visible-tab API', async t => {
  const fake = fakeCaptureBrowser(t, { focused: false, windowState: 'minimized' })
  const result = await execute('snapshot', {}, {})
  assert.equal(result.view, 'full')
  assert.equal(result.image.width, 800)
  assert.ok(fake.commands.some(command => command.method === 'Page.captureScreenshot'))
  assert.equal(fake.state.visibleCaptureCalls, 0, 'a minimized window must not hang on captureVisibleTab')
  assert.equal(fake.state.focusCalls, 0)
})

test('a failed visible-tab capture on a focused window falls back to the page capture', async t => {
  const fake = fakeCaptureBrowser(t, {
    focused: true,
    captureFailure: new Error('The active tab is not currently visible'),
  })
  const result = await execute('snapshot', {}, {})
  assert.equal(result.view, 'full')
  assert.equal(fake.state.visibleCaptureCalls, 1)
  assert.deepEqual(
    fake.commands.find(command => command.method === 'Page.captureScreenshot').params,
    { format: 'jpeg', quality: 72, fromSurface: true, captureBeyondViewport: false },
  )
  assert.equal(fake.state.focusCalls, 0)
})

test('a debugger-busy page capture on an unfocused window falls back to the visible-tab API', async t => {
  const fake = fakeCaptureBrowser(t, {
    focused: false,
    debuggerFailure: new Error('Another debugger is already attached to the tab'),
  })
  const result = await execute('snapshot', {}, {})
  assert.equal(result.view, 'full')
  assert.equal(fake.state.visibleCaptureCalls, 1)
  assert.equal(fake.state.focusCalls, 0)
})

test('a minimized window reports a page-capture failure instead of hanging on the visible-tab API', async t => {
  const fake = fakeCaptureBrowser(t, {
    focused: false,
    windowState: 'minimized',
    debuggerFailure: new Error('Another debugger is already attached to the tab'),
  })
  await assert.rejects(
    execute('snapshot', {}, {}),
    error => error.code === 'DEBUGGER_BUSY',
  )
  assert.equal(fake.state.visibleCaptureCalls, 0)
  assert.equal(fake.state.focusCalls, 0)
})

test('H1-A: viewport snapshot captures pixels before labelling so mid-capture popup swaps never yield stale labels', async t => {
  const fake = fakeCaptureBrowser(t, { focused: true })
  const events = []
  let swapped = false
  const origCapture = globalThis.chrome.tabs.captureVisibleTab
  globalThis.chrome.tabs.captureVisibleTab = async (...args) => {
    events.push('captureVisibleTab')
    // Simulate Docs swapping the filtered Alt+/ listbox during capture.
    swapped = true
    return origCapture(...args)
  }
  const origExec = globalThis.chrome.scripting.executeScript
  globalThis.chrome.scripting.executeScript = async request => {
    const name = request.func?.name
    if (name === 'labelPage') {
      events.push('labelPage')
      const base = (await origExec(request))[0].result
      const labels = swapped
        ? [{ id: 170, tag: 'div', role: 'option', text: 'Insert table of contents', disabled: false, popup: true, x: 100, y: 120, w: 220, h: 28 }]
        : [{ id: 160, tag: 'div', role: 'option', text: 'Tab Shift+F11', disabled: false, popup: true, x: 100, y: 120, w: 220, h: 28 }]
      return [{ result: { ...base, labels, knownLabels: labels } }]
    }
    return origExec(request)
  }
  const result = await execute('snapshot', {}, {})
  assert.deepEqual(events.slice(0, 2), ['captureVisibleTab', 'labelPage'])
  assert.equal(result.labels.length, 1)
  assert.equal(result.labels[0].id, 170)
  assert.equal(result.labels[0].text, 'Insert table of contents')
})

test('H1-B: unlabelled type on a Google Docs URL verifies a focused DOM combobox instead of reporting canvas UNVERIFIED', async t => {
  const fake = fakeCaptureBrowser(t, { focused: true })
  const docsUrl = 'https://docs.google.com/document/d/abc123/edit'
  const docsTab = { id: nextTabId++, windowId: 1, active: true, title: 'Feature Test - Google Docs', url: docsUrl, status: 'complete' }
  let inputValue = ''
  globalThis.chrome.tabs.query = async () => [{ ...docsTab }]
  globalThis.chrome.tabs.get = async () => ({ ...docsTab })
  const origSend = globalThis.chrome.debugger.sendCommand
  globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Input.insertText') {
      inputValue += String(params?.text ?? '')
      fake.commands.push({ method, params })
      return {}
    }
    return origSend(target, method, params)
  }
  const origExec = globalThis.chrome.scripting.executeScript
  globalThis.chrome.scripting.executeScript = async request => {
    const name = request.func?.name
    const args = request.args ?? []
    if (name === 'waitForPaint') return [{ result: {} }]
    if (name === 'contentProbePage') {
      return [{
        frameId: 0,
        result: {
          url: docsUrl,
          title: docsTab.title,
          textLen: 120 + inputValue.length,
          mutations: args[0] === 'end' ? 4 : 0,
          observing: args[0] === 'start',
          focus: {
            tag: 'input',
            type: 'text',
            identity: 'div#docs-omnibox/input[0]',
            isField: true,
            editable: false,
            readable: true,
            measurable: true,
            hasFocus: true,
            chars: inputValue.length,
            preview: inputValue,
            isPassword: false,
          },
        },
      }]
    }
    const out = await origExec(request)
    if (name === 'labelPage' || name === 'pageMetrics') {
      out[0].result.url = docsUrl
      out[0].result.title = docsTab.title
    }
    return out
  }
  const result = await execute('type', { text: 'table of contents', view: 'full' }, {})
  assert.equal(result.changed, true)
  assert.equal(result.typed.canvasEditor, false)
  assert.equal(result.typed.measured, 'field')
  assert.equal(result.typed.verified, true)
  assert.equal(result.typed.valuePreview, 'table of contents')
  assert.equal(result.typed.charsAdded, 17)
})

test('H1-B + H4: unlabelled type on Google Docs canvas stays UNVERIFIED and never auto-deletes; append fails honestly', async t => {
  const fake = fakeCaptureBrowser(t, { focused: true })
  const docsUrl = 'https://docs.google.com/document/d/abc456/edit'
  const docsTab = { id: nextTabId++, windowId: 1, active: true, title: 'Feature Test - Google Docs', url: docsUrl, status: 'complete' }
  const probePhases = []
  globalThis.chrome.tabs.query = async () => [{ ...docsTab }]
  globalThis.chrome.tabs.get = async () => ({ ...docsTab })
  const origExec = globalThis.chrome.scripting.executeScript
  globalThis.chrome.scripting.executeScript = async request => {
    const name = request.func?.name
    const args = request.args ?? []
    if (name === 'waitForPaint') return [{ result: {} }]
    if (name === 'contentProbePage') {
      probePhases.push(args[0])
      return [
        {
          frameId: 0,
          result: {
            url: docsUrl,
            title: docsTab.title,
            textLen: 100,
            mutations: 0,
            observing: false,
            focus: { tag: 'iframe', type: '', readable: false, measurable: false, isCanvasProxyIframe: true, hasFocus: true, chars: 0, preview: '' },
          },
        },
        {
          frameId: 7,
          result: {
            url: 'about:blank',
            title: '',
            textLen: 0,
            mutations: 0,
            observing: false,
            focus: { tag: 'div', type: '', readable: true, measurable: false, inCanvasProxyFrame: true, hasFocus: true, chars: 0, preview: '' },
          },
        },
      ]
    }
    const out = await origExec(request)
    if (name === 'labelPage' || name === 'pageMetrics') {
      out[0].result.url = docsUrl
      out[0].result.title = docsTab.title
    }
    return out
  }
  const result = await execute('type', { text: 'Hello Docs', view: 'full' }, {})
  assert.equal(result.changed, null)
  assert.equal(result.typed.canvasEditor, true)
  assert.equal(result.typed.canvasEditorName, 'Google Docs')
  assert.equal(result.typed.measured, 'none')
  assert.equal(result.typed.verified, false)
  assert.deepEqual(probePhases, ['start'], 'canvas path should not run a redundant end probe')
  assert.equal(fake.commands.filter(c => c.method === 'Input.dispatchKeyEvent').length, 0, 'never auto-sends Delete/Backspace')
  assert.equal(fake.commands.filter(c => c.method === 'Input.insertText').length, 1)

  await assert.rejects(
    execute('type', { text: 'more', mode: 'append' }, {}),
    error => error.code === 'CANVAS_TYPE_UNSUPPORTED'
      && /does NOT replace an active canvas selection/u.test(error.message)
      && !/or replaces the current selection/u.test(error.message),
  )
})

test('H2: region and full-page captures on an inner-scrolling app use document scroll (0,0) for clip and restore', async t => {
  const fake = fakeCaptureBrowser(t, { focused: true, pageHeight: 600 })
  const restoredArgs = []
  const origExec = globalThis.chrome.scripting.executeScript
  globalThis.chrome.scripting.executeScript = async request => {
    const name = request.func?.name
    if (name === 'restorePageScroll') {
      restoredArgs.push(request.args)
      return [{ result: { x: 0, y: 0 } }]
    }
    const out = await origExec(request)
    if (name === 'labelPage' || name === 'pageMetrics') {
      out[0].result.scroll = {
        x: 0,
        y: 950,
        maxX: 0,
        maxY: 2400,
        container: 'div.kix-appview-editor',
        pageHeight: 3000,
        pageWidth: 800,
        atTop: false,
        atBottom: false,
      }
      out[0].result.fingerprint.scrollY = 950
    }
    return out
  }
  const initial = await execute('snapshot', {}, {})
  assert.equal(initial.scroll.container, 'div.kix-appview-editor')
  assert.equal(initial.scroll.y, 950)

  await execute('snapshot', {
    scope: 'region', region: { x: 40, y: 60, width: 200, height: 100 }, view_id: initial.viewId, to_clipboard: true,
  }, {})
  const regionCapture = fake.commands.find(c => c.method === 'Page.captureScreenshot')
  assert.deepEqual(regionCapture.params.clip, { x: 40, y: 60, width: 200, height: 100, scale: 1 })

  await execute('snapshot', { scope: 'full_page', to_clipboard: true }, {})
  assert.deepEqual(restoredArgs, [[0, 0]])
})
