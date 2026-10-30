import test from 'node:test'
import assert from 'node:assert/strict'
import { execute } from '../sidepanel/browser.js'

function chromeEvent() {
  const listeners = new Set()
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
  }
}

function fakeSelectionBrowser(t) {
  const previousChrome = globalThis.chrome
  const previousCreateImageBitmap = globalThis.createImageBitmap
  const tab = { id: 900, windowId: 1, index: 0, active: true, title: 'Selection fixture', url: 'https://example.test/form', status: 'complete' }
  const timeline = []
  let selection = ''
  let finalMove = false
  let dragStartX
  const metrics = () => ({
    title: tab.title,
    url: tab.url,
    readyState: 'complete',
    viewport: { width: 800, height: 600, dpr: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 0, container: 'document', pageHeight: 600, pageWidth: 800, atTop: true, atBottom: true },
    fingerprint: { url: tab.url, title: tab.title, scrollX: 0, scrollY: 0, textLen: 0, active: '', layout: [] },
  })
  globalThis.createImageBitmap = async () => ({ width: 640, height: 360, close: () => {} })
  globalThis.chrome = {
    windows: { getCurrent: async () => ({ id: 1 }), update: async () => {} },
    tabs: {
      query: async () => [{ ...tab }],
      get: async () => ({ ...tab }),
      captureVisibleTab: async () => 'data:image/jpeg;base64,dW51c2Vk',
      onUpdated: chromeEvent(),
      onRemoved: chromeEvent(),
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    scripting: {
      executeScript: async request => {
        const name = request.func?.name
        timeline.push(name)
        if (name === 'readSelection') return [{ result: { text: selection, chars: selection.length, collapsed: selection.length === 0, rect: null } }]
        if (name === 'waitInPage') {
          if (finalMove) selection = 'SELECT-ME-ALPHA BETA GAMMA'
          return [{ result: {} }]
        }
        if (name === 'pageMetrics') return [{ result: metrics() }]
        if (name === 'labelPage') return [{ result: { ...metrics(), labels: [], knownLabels: [] } }]
        throw new Error(`unexpected page function ${name}`)
      },
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      onEvent: chromeEvent(),
      onDetach: chromeEvent(),
      sendCommand: async (_target, method, params) => {
        if (method !== 'Input.dispatchMouseEvent') return
        timeline.push(`${params.type}:${params.x}`)
        if (params.type === 'mousePressed') {
          selection = ''
          finalMove = false
          dragStartX = params.x
        } else if (params.type === 'mouseMoved' && params.button === 'left') {
          if (params.x !== dragStartX) selection = 'SELECT'
          finalMove = params.x === 150
        }
      },
    },
  }
  t.after(() => {
    globalThis.chrome = previousChrome
    globalThis.createImageBitmap = previousCreateImageBitmap
  })
  return { timeline }
}

test('trusted drag settles every move before release and preserves collapsed drags', async t => {
  const fake = fakeSelectionBrowser(t)
  await execute('snapshot', {}, {})
  const selected = await execute('select', {
    from: { x: 27, y: 100 }, to: { x: 150, y: 100 }, space: 'css', view: 'none',
  }, {})

  assert.equal(selected.selected.textPreview, 'SELECT-ME-ALPHA BETA GAMMA')
  assert.equal(selected.selected.chars, 26)
  assert.equal(selected.selected.collapsed, false)
  assert.equal(selected.changed, true)
  const finalMove = fake.timeline.lastIndexOf('mouseMoved:150')
  const settle = fake.timeline.indexOf('waitInPage', finalMove)
  const release = fake.timeline.indexOf('mouseReleased:150', finalMove)
  assert.ok(finalMove >= 0 && finalMove < settle && settle < release, JSON.stringify(fake.timeline))
  const press = fake.timeline.indexOf('mousePressed:27')
  const moves = fake.timeline.map((event, index) => ({ event, index })).filter(item => item.index > press && item.index < release && item.event.startsWith('mouseMoved:'))
  assert.equal(moves.length, 4)
  for (const move of moves) assert.equal(fake.timeline[move.index + 1], 'waitInPage', JSON.stringify(fake.timeline))

  const collapsed = await execute('select', {
    from: { x: 27, y: 100 }, to: { x: 27, y: 100 }, space: 'css', view: 'none',
  }, {})
  assert.equal(collapsed.selected.chars, 0)
  assert.equal(collapsed.selected.collapsed, true)
  assert.equal(collapsed.changed, false)
  assert.deepEqual(collapsed.signals, [])
})
