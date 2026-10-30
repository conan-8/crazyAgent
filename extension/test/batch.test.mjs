import test from 'node:test'
import assert from 'node:assert/strict'
import { execute } from '../sidepanel/browser.js'

let nextTabId = 100

function chromeEvent() {
  const listeners = new Set()
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
  }
}

function fakeBrowser(t, options = {}) {
  const previousChrome = globalThis.chrome
  const previousCreateImageBitmap = globalThis.createImageBitmap
  const tab = {
    id: nextTabId++,
    windowId: 1,
    index: 0,
    active: true,
    title: options.title ?? 'Batch fixture',
    url: options.url ?? 'https://example.test/ready',
    status: 'complete',
  }
  const metrics = () => ({
    title: tab.title,
    url: tab.url,
    readyState: 'complete',
    viewport: { width: 800, height: 600, dpr: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 0, container: 'document', pageHeight: 600, pageWidth: 800, atTop: true, atBottom: true },
    fingerprint: { url: tab.url, title: tab.title, scrollX: 0, scrollY: 0, textLen: 0, active: '', layout: [] },
  })
  const fake = {
    tab,
    mutations: 0,
    captures: 0,
    scriptCalls: [],
    conditionResults: [...(options.conditionResults ?? [])],
  }
  globalThis.createImageBitmap = async () => ({ width: 640, height: 360, close: () => {} })
  globalThis.chrome = {
    windows: { getCurrent: async () => ({ id: 1 }), update: async () => {} },
    tabs: {
      query: async () => [{ ...tab }],
      get: async () => ({ ...tab }),
      captureVisibleTab: async () => {
        fake.captures += 1
        return 'data:image/jpeg;base64,dW51c2Vk'
      },
      onUpdated: chromeEvent(),
      onRemoved: chromeEvent(),
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    scripting: {
      executeScript: async request => {
        const name = request.func?.name
        fake.scriptCalls.push({ name, args: request.args })
        if (name === 'waitForConditionsPage') {
          const found = fake.conditionResults.length > 0 ? fake.conditionResults.shift() : true
          return [{ result: { found, elapsedMs: 1 } }]
        }
        if (name === 'syntheticKeyPage') {
          fake.mutations += 1
          return [{ result: { dispatched: true } }]
        }
        if (name === 'pageMetrics') return [{ result: metrics() }]
        if (name === 'labelPage') return [{ result: { ...metrics(), labels: [], knownLabels: [] } }]
        if (name === 'waitForPaint' || name === 'waitInPage') return [{ result: {} }]
        throw new Error(`unexpected page function ${name}`)
      },
    },
    debugger: {
      attach: async () => { throw new Error('debugger unavailable') },
      detach: async () => {},
      onEvent: chromeEvent(),
      onDetach: chromeEvent(),
      sendCommand: async () => {},
    },
  }
  t.after(() => {
    globalThis.chrome = previousChrome
    globalThis.createImageBitmap = previousCreateImageBitmap
  })
  return fake
}

const keyAction = (args = {}) => ({ op: 'press_key', args: { key: 'Enter', ...args } })

test('batch guards run around dispatch with successful outcomes and one final view', async t => {
  const fake = fakeBrowser(t)
  const result = await execute('batch', {
    view: 'full',
    actions: [keyAction({
      before: { text: 'Ready', timeout_ms: 1000 },
      after: { url: '/ready', idle: false, timeout_ms: 1000 },
    })],
  }, {})

  assert.equal(result.batch.ok, true)
  assert.equal(result.view, 'full')
  assert.equal(fake.mutations, 1)
  assert.equal(fake.captures, 1)
  assert.equal(result.actions[0].attempted, true)
  assert.equal(result.actions[0].mutationPossible, true)
  assert.equal(result.actions[0].before.found, true)
  assert.equal(result.actions[0].before.timedOut, false)
  assert.deepEqual(result.actions[0].before.conditions, { text: 'Ready' })
  assert.equal(result.actions[0].after.found, true)
  assert.deepEqual(result.actions[0].after.conditions, { url: '/ready' })
  assert.equal(result.actions[0].pressed.key, 'Enter')
})

test('batch precondition timeout prevents dispatch and stops with stop_on_error false', async t => {
  const fake = fakeBrowser(t, { conditionResults: [false] })
  const result = await execute('batch', {
    view: 'none',
    stop_on_error: false,
    actions: [keyAction({ before: { text: 'Never', timeout_ms: 1000 } }), keyAction()],
  }, {})

  assert.equal(result.batch.ok, false)
  assert.equal(result.batch.stoppedEarly, true)
  assert.equal(result.batch.executed, 1)
  assert.equal(result.actions[0].error.code, 'BATCH_PRECONDITION_FAILED')
  assert.equal(result.actions[0].attempted, false)
  assert.equal(result.actions[0].mutationPossible, false)
  assert.equal(result.actions[0].before.timedOut, true)
  assert.equal(fake.mutations, 0)
  assert.equal(fake.captures, 0)
})

test('batch postcondition timeout reports mutation risk and stops with stop_on_error false', async t => {
  const fake = fakeBrowser(t, { conditionResults: [false] })
  const result = await execute('batch', {
    view: 'none',
    stop_on_error: false,
    actions: [keyAction({ after: { text: 'Never', timeout_ms: 1000 } }), keyAction()],
  }, {})

  assert.equal(result.batch.ok, false)
  assert.equal(result.batch.stoppedEarly, true)
  assert.equal(result.batch.executed, 1)
  assert.equal(result.actions[0].error.code, 'BATCH_POSTCONDITION_FAILED')
  assert.match(result.actions[0].error.message, /blind retry is unsafe/u)
  assert.equal(result.actions[0].attempted, true)
  assert.equal(result.actions[0].mutationPossible, true)
  assert.equal(result.actions[0].after.timedOut, true)
  assert.equal(result.actions[0].pressed.key, 'Enter')
  assert.equal(fake.mutations, 1)
  assert.equal(fake.captures, 0)
})

test('batch validates every guard before the first action or condition wait', async t => {
  const fake = fakeBrowser(t)
  await assert.rejects(execute('batch', {
    view: 'none',
    actions: [keyAction(), keyAction({ after: { url: '/ready', view: 'none' } })],
  }, {}), error => error.code === 'BAD_WAIT' && /action 2 after/u.test(error.message))

  assert.equal(fake.mutations, 0)
  assert.equal(fake.scriptCalls.length, 0)
  assert.equal(fake.captures, 0)
})

test('batch rejects a live-shaped malformed nested argument key before any activity', async t => {
  const fake = fakeBrowser(t)
  const malformedKey = 'value\\"},{"before":{"text":"{{DSML_PLACEHOLDER}}"}'
  await assert.rejects(execute('batch', {
    view: 'full',
    actions: [keyAction(), keyAction({ nested: [{ [malformedKey]: 'value' }] })],
  }, {}), error => error.code === 'BAD_BATCH'
    && /action 2/u.test(error.message)
    && /malformed key/u.test(error.message)
    && /no actions ran/u.test(error.message))

  assert.equal(fake.mutations, 0)
  assert.equal(fake.scriptCalls.length, 0)
  assert.equal(fake.captures, 0)
})

test('batch accepts valid nested guards and DSML-looking user text values', async t => {
  const fake = fakeBrowser(t)
  const userText = 'ordinary {{DSML_PLACEHOLDER}} text with \\ and {"before":true}'
  const result = await execute('batch', {
    view: 'none',
    actions: [{
      op: 'wait_for',
      args: {
        text: userText,
        before: { text: userText, ms: 0 },
        after: { url: '/ready', ms: 0 },
      },
    }],
  }, {})

  assert.equal(result.batch.ok, true)
  assert.equal(result.actions[0].waited.conditions.text, userText)
  assert.equal(result.actions[0].before.conditions.text, userText)
  assert.equal(result.actions[0].after.conditions.url, '/ready')
  assert.equal(fake.scriptCalls.filter(call => call.name === 'waitForConditionsPage').length, 3)
  assert.equal(fake.captures, 0)
})

test('standalone wait_for supports default, auto, compact, and none views', async t => {
  const fake = fakeBrowser(t)
  const full = await execute('wait_for', { url: '/ready' }, {})
  assert.equal(full.view, 'full')
  assert.equal(full.waited.found, true)
  assert.equal(fake.captures, 1)

  const compact = await execute('wait_for', { url: '/ready', view: 'compact' }, {})
  assert.equal(compact.view, 'compact')
  assert.equal(compact.screenshotSkipped, true)
  assert.equal(fake.captures, 1)

  const none = await execute('wait_for', { url: '/ready', view: 'none' }, {})
  assert.equal(none.view, 'none')
  assert.equal(none.screenshotSkipped, true)
  assert.equal(none.image, undefined)
  assert.equal(fake.captures, 1)

  const auto = await execute('wait_for', { url: '/ready', view: 'auto' }, {})
  assert.equal(auto.view, 'compact')
  assert.equal(fake.captures, 1)
})

test('standalone wait_for rejects unknown fields and invalid views before page access', async t => {
  const fake = fakeBrowser(t)
  await assert.rejects(execute('wait_for', { url: '/ready', surprise: true }, {}), error => error.code === 'BAD_WAIT')
  for (const view of ['fresh', null]) {
    await assert.rejects(execute('wait_for', { url: '/ready', view }, {}), error => error.code === 'BAD_VIEW')
  }
  assert.equal(fake.scriptCalls.length, 0)
  assert.equal(fake.captures, 0)
})

test('canvas editors retain batch restrictions before guards or dispatch', async t => {
  const fake = fakeBrowser(t, { url: 'https://docs.google.com/document/d/abc/edit' })
  await assert.rejects(execute('batch', {
    view: 'none',
    actions: [keyAction({ before: { ms: 0 } }), keyAction()],
  }, {}), error => error.code === 'CANVAS_BATCH_UNSUPPORTED')
  assert.equal(fake.mutations, 0)
  assert.equal(fake.scriptCalls.length, 0)
  assert.equal(fake.captures, 0)
})

test('standalone wait_for forces a full view on known canvas editors', async t => {
  const fake = fakeBrowser(t, { url: 'https://docs.google.com/document/d/abc/edit' })
  const result = await execute('wait_for', { url: '/edit', view: 'none' }, {})
  assert.equal(result.view, 'full')
  assert.equal(fake.captures, 1)
  assert.equal(result.waited.found, true)
})

test('read-only canvas batches allow guards but still finish with one full view', async t => {
  const fake = fakeBrowser(t, { url: 'https://docs.google.com/document/d/abc/edit' })
  const result = await execute('batch', {
    view: 'none',
    actions: [
      { op: 'wait_for', args: { url: '/edit', before: { ms: 0 }, after: { ms: 0 } } },
      { op: 'wait_for', args: { ms: 0 } },
    ],
  }, {})
  assert.equal(result.batch.ok, true)
  assert.equal(result.actions[0].before.found, true)
  assert.equal(result.actions[0].after.found, true)
  assert.equal(result.view, 'full')
  assert.equal(fake.captures, 1)
})
