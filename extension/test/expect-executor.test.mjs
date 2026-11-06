import test from 'node:test'
import assert from 'node:assert/strict'
import { execute } from '../sidepanel/browser.js'
import { evaluateActionExpect } from '../sidepanel/action-expect.js'
import { expectLabelledTextProbe, finalizeActionEvidence, finalizeBatchEvidence, focusedTextSnapshot } from '../sidepanel/expect-executor.js'
import { assertBatchExpectSequence } from '../sidepanel/action-expect.js'

let nextTabId = 8_000

function chromeEvent() {
  const listeners = new Set()
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => { for (const listener of [...listeners]) listener(...args) },
  }
}

function fakeExpectBrowser(t, options = {}) {
  const previous = {
    chrome: globalThis.chrome,
    createImageBitmap: globalThis.createImageBitmap,
    OffscreenCanvas: globalThis.OffscreenCanvas,
    fetch: globalThis.fetch,
  }
  const docs = options.docs === true
  const tab = {
    id: nextTabId++, windowId: 1, index: 0, active: true,
    title: 'Expect fixture',
    url: docs ? 'https://docs.google.com/document/d/doc/edit' : 'https://example.test/expect',
    status: 'complete',
  }
  const state = {
    value: options.initialValue ?? '',
    count: 0,
    dialogOpen: false,
    bold: false,
    exportBody: 'old text',
    mutations: 0,
    probeCalls: 0,
    guardResults: [...(options.guardResults ?? [])],
    scriptCalls: [],
    captures: 0,
    timeOrigin: 1_000_000,
  }
  const labels = () => [
    { id: 3, tag: 'button', role: 'button', text: state.count > 0 ? 'Incremented' : 'Increment', disabled: false, x: 10, y: 10, w: 90, h: 30 },
    { id: 4, tag: 'button', role: 'button', text: 'Open dialog', disabled: false, x: 10, y: 50, w: 90, h: 30 },
    { id: 7, tag: 'input', role: 'textbox', text: 'Name', disabled: false, x: 10, y: 90, w: 160, h: 30 },
    ...state.count > 0 ? [{ id: 9, tag: 'button', role: 'button', text: 'Created', disabled: false, x: 10, y: 130, w: 90, h: 30 }] : [],
  ]
  const metrics = () => ({
    title: tab.title,
    url: tab.url,
    timeOrigin: state.timeOrigin,
    readyState: 'complete',
    viewport: { width: 800, height: 600, dpr: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 0, container: 'document', pageHeight: 600, pageWidth: 800, atTop: true, atBottom: true },
    fingerprint: { url: tab.url, title: tab.title, scrollX: 0, scrollY: 0, textLen: state.exportBody.length, active: '', layout: [] },
  })
  const fieldProbe = expected => {
    state.probeCalls += 1
    if (options.staleAfter && state.probeCalls > 1) return { readable: false, target: 'stale' }
    return {
      readable: true, target: 'unique', tag: 'input', type: 'text',
      documentUrl: tab.url, timeOrigin: state.timeOrigin,
      contains: state.value.includes(expected), complete: true, chars: state.value.length,
    }
  }
  globalThis.createImageBitmap = async blob => ({ width: 800, height: 600, pixel: Number(await blob.text()) || 0, close: () => {} })
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; this.pixel = 0 }
    getContext() {
      return {
        drawImage: bitmap => { this.pixel = bitmap.pixel },
        getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(this.pixel) }),
      }
    }
    async convertToBlob({ type }) { return new Blob([String(this.pixel)], { type }) }
  }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/export?format=')) {
      if (options.exportFailure) return new Response('unavailable', { status: 500 })
      return new Response(state.exportBody, { status: 200 })
    }
    return previous.fetch(input, init)
  }
  const debuggerEvents = chromeEvent()
  const detachEvents = chromeEvent()
  state.trustedDispatches = 0
  state.syntheticDispatches = 0
  globalThis.chrome = {
    windows: { getCurrent: async () => ({ id: 1, focused: true, state: 'normal' }), get: async () => ({ id: 1, focused: true, state: 'normal' }), update: async () => {} },
    tabs: {
      query: async () => [{ ...tab }],
      get: async () => ({ ...tab }),
      captureVisibleTab: async () => {
        state.captures += 1
        return `data:image/jpeg;base64,${Buffer.from(String(state.count > 0 ? 30 : 0)).toString('base64')}`
      },
      onUpdated: chromeEvent(),
      onRemoved: chromeEvent(),
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    scripting: {
      executeScript: async request => {
        const name = request.func?.name
        const args = request.args ?? []
        state.scriptCalls.push({ name, args })
        if (name === 'labelPage') return [{ result: { ...metrics(), labels: labels(), knownLabels: labels(), surfaces: [] } }]
        if (name === 'pageMetrics') return [{ result: metrics() }]
        if (name === 'clearLabelsPage') return [{ result: { ok: true } }]
        if (name === 'waitForPaint' || name === 'waitInPage') return [{ result: {} }]
        if (name === 'expectLabelledTextProbe') return [{ result: fieldProbe(args[1]) }]
        if (name === 'expectFocusedTextProbe') return [{ result: { ...fieldProbe(args[0]), identity: 'input#name', hasFocus: true } }]
        if (name === 'expectDialogProbe') return [{ result: { visible: state.dialogOpen ? 1 : 0 } }]
        if (name === 'typeLabelled') {
          state.mutations += 1
          const before = state.value
          const text = args[1]
          state.value = args[2] === 'append' ? before + text : text
          return [{ result: {
            ok: true, tag: 'input', type: 'text', isPassword: false,
            beforeChars: before.length, beforePreview: before,
            afterChars: state.value.length, valuePreview: state.value, verified: true,
          } }]
        }
        if (name === 'clickLabelled') {
          const label = args[0]
          state.mutations += 1
          if (options.navigateAfter) {
            tab.url = 'https://example.test/other-document'
            state.timeOrigin += 1
          }
          if (label === 3) {
            state.count += 1
            state.exportBody = 'old text new marker'
            state.bold = true
            return [{ result: { ok: true, clicked: { label, tag: 'button', role: 'button', text: 'Increment' }, changed: true, signals: ['dom-mutations:1'], mutations: 1, newText: ['Created'] } }]
          }
          if (label === 4) {
            state.dialogOpen = true
            return [{ result: { ok: true, clicked: { label, tag: 'button', role: 'button', text: 'Open dialog' }, changed: true, signals: ['dialog-change'], mutations: 1, newText: ['Confirm?'] } }]
          }
          return [{ result: { ok: true, clicked: { label, tag: 'button', role: 'button', text: 'Noop' }, changed: false, signals: [], mutations: 0, newText: [] } }]
        }
        if (name === 'waitForConditionsPage') {
          const found = state.guardResults.length > 0 ? state.guardResults.shift() : true
          return [{ result: { found, elapsedMs: 1 } }]
        }
        if (name === 'docsPageProbe') {
          assert.equal(args[0], 'format')
          return [{ result: { ok: true, bold: state.bold } }]
        }
        if (name === 'syntheticClickBurst') {
          state.syntheticDispatches += 1
          return [{ result: [true] }]
        }
        throw new Error(`unexpected page function ${name}`)
      },
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      onEvent: debuggerEvents,
      onDetach: detachEvents,
      sendCommand: async (_target, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') state.trustedDispatches += 1
        if (method === 'Page.handleJavaScriptDialog') {
          debuggerEvents.emit({ tabId: tab.id }, 'Page.javascriptDialogClosed', { result: params.accept === true })
        }
        return {}
      },
    },
  }
  t.after(() => {
    globalThis.chrome = previous.chrome
    globalThis.createImageBitmap = previous.createImageBitmap
    globalThis.OffscreenCanvas = previous.OffscreenCanvas
    globalThis.fetch = previous.fetch
  })
  return {
    state,
    tab,
    openNativeDialog() {
      debuggerEvents.emit({ tabId: tab.id }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Pending', url: tab.url })
    },
    async initialize() {
      const mod = await import('../sidepanel/browser.js')
      await mod.execute('snapshot', {}, {})
      return mod
    },
  }
}

test('direct type verifies a scoped absent-to-present transition without returning field text', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  const result = await mod.execute('type', { label: 7, text: 'new marker', expect: { text_landed: 'marker' }, view: 'none' }, {})

  assert.equal(fake.state.value, 'new marker')
  assert.equal(result.observed, 'changed')
  assert.equal(result.expectation.status, 'verified')
  assert.equal(result.expectation.checks[0].reason, 'appeared')
  assert.equal(result.outcome.ok, true)
  assert.equal(result.outcome.attempted, true)
  assert.equal(result.mutationPossible, true)
  assert.equal(result.expectEvidence.text_landed.before.contains, false)
  assert.equal(result.expectEvidence.text_landed.after.contains, true)
  assert.equal('text' in result.expectEvidence.text_landed.after, false)
})

test('pre-existing target text and a stale after-scope cannot verify typing', async t => {
  const existing = fakeExpectBrowser(t, { initialValue: 'already here' })
  let mod = await existing.initialize()
  const preexisting = await mod.execute('type', { label: 7, text: ' appended', mode: 'append', expect: { text_landed: 'already' }, view: 'none' }, {})
  assert.equal(preexisting.expectation.status, 'unverified')
  assert.equal(preexisting.expectation.checks[0].reason, 'preexisting-text')
  assert.equal(preexisting.observed, 'changed')
  assert.equal(existing.state.value, 'already here appended')

  const stale = fakeExpectBrowser(t, { staleAfter: true })
  mod = await stale.initialize()
  const after = await mod.execute('type', { label: 7, text: 'marker', expect: { text_landed: 'marker' }, view: 'none' }, {})
  assert.equal(after.expectation.status, 'unverified')
  assert.equal(after.expectation.checks[0].scope.after.target, 'stale')
  assert.equal(after.mutationPossible, true)
  assert.equal(stale.state.value, 'marker')
})

test('pixel expectation forces full measurement and returns bounded semantic deltas', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  const result = await mod.execute('click', { label: 3, view: 'none', expect: { pixel_changed: true } }, {})

  assert.equal(fake.state.count, 1)
  assert.equal(result.view, 'full')
  assert.equal(result.expectation.status, 'verified', JSON.stringify(result.expectEvidence.pixel_changed))
  assert.equal(result.expectation.diagnosticOnly, true)
  assert.equal(result.observed, 'changed')
  assert.deepEqual(result.semanticDelta.newOnScreen.map(label => label.id), [9])
  assert.deepEqual(result.semanticDelta.changed.map(entry => [entry.id, entry.fields]), [[3, ['text']]])
  assert.deepEqual(result.semanticDelta.newText, ['Created'])
  assert.match(result.semanticDelta.text, /New on screen:[\s\S]*Changed:[\s\S]*New text:/u)
})

test('off-screen coordinate bursts keep pixels unknown and report no dispatch or mutation risk', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  const result = await mod.execute('click_at', { x: 9_999, y: 9_999, space: 'css', expect: { pixel_changed: true } }, {})

  assert.equal(result.expectation.status, 'unverified')
  assert.equal(result.expectation.checks[0].observed, 'unknown')
  assert.equal(result.outcome.attempted, false)
  assert.equal(result.outcome.ok, true)
  assert.equal(result.mutationPossible, false)
  assert.equal(fake.state.mutations, 0)
})

test('dialog expectations verify final state independently of dispatch outcome', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  const result = await mod.execute('click', { label: 4, expect: { dialog: 'open' }, view: 'none' }, {})

  assert.equal(fake.state.dialogOpen, true)
  assert.equal(result.expectation.status, 'verified')
  assert.equal(result.expectation.checks[0].observed, 'changed')
  assert.equal(result.outcome.ok, true)
  assert.equal(result.mutationPossible, true)
})

test('batch expectations compose with guards and retain each step outcome', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  const result = await mod.execute('batch', {
    view: 'none',
    actions: [
      { op: 'type', args: { label: 7, text: 'batch marker', expect: { text_landed: 'marker' }, before: { ms: 0 }, after: { ms: 0 } } },
      { op: 'click', args: { label: 4, expect: { dialog: 'open' } } },
    ],
  }, {})

  assert.equal(fake.state.value, 'batch marker')
  assert.equal(fake.state.dialogOpen, true)
  assert.equal(result.batch.ok, true)
  assert.equal(result.observed, 'changed')
  assert.equal(result.outcome.ok, true)
  assert.equal(result.expectation.status, 'verified')
  assert.equal(result.actions[0].observed, 'changed')
  assert.equal(result.actions[0].expectation.status, 'verified')
  assert.equal(result.actions[0].attempted, true)
  assert.equal(result.actions[0].mutationPossible, true)
  assert.equal(result.actions[0].before.found, true)
  assert.equal(result.actions[0].after.found, true)
  assert.equal(result.actions[1].expectation.status, 'verified')
})

test('batch postcondition failure preserves verified text evidence and mutation risk', async t => {
  const fake = fakeExpectBrowser(t, { guardResults: [false] })
  const mod = await fake.initialize()
  const result = await mod.execute('batch', {
    view: 'none',
    actions: [{ op: 'type', args: { label: 7, text: 'landed', expect: { text_landed: 'landed' }, after: { text: 'NEVER', timeout_ms: 1000 } } }],
  }, {})

  assert.equal(fake.state.value, 'landed')
  assert.equal(result.batch.ok, false)
  assert.equal(result.actions[0].error.code, 'BATCH_POSTCONDITION_FAILED')
  assert.equal(result.actions[0].outcome.ok, false)
  assert.equal(result.actions[0].attempted, true)
  assert.equal(result.actions[0].mutationPossible, true)
  assert.equal(result.actions[0].expectation.status, 'verified')
})

test('batch precondition failure prevents dispatch and leaves expectation unverified', async t => {
  const fake = fakeExpectBrowser(t, { guardResults: [false] })
  const mod = await fake.initialize()
  const result = await mod.execute('batch', {
    view: 'none',
    actions: [{ op: 'type', args: { label: 7, text: 'never', expect: { text_landed: 'never' }, before: { text: 'NOT READY', timeout_ms: 1000 } } }],
  }, {})

  assert.equal(fake.state.value, '')
  assert.equal(fake.state.mutations, 0)
  assert.equal(result.actions[0].attempted, false)
  assert.equal(result.actions[0].mutationPossible, false)
  assert.equal(result.actions[0].expectation.status, 'unverified')
})

test('malformed and incompatible direct expectations fail before mutation', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  const cases = [
    [{ pixel_changed: false }, 'BAD_EXPECT'],
    [{ surprise: true }, 'BAD_EXPECT'],
    [{ export_contains: 'marker' }, 'EXPECT_UNSUPPORTED'],
    [{ toolbar_style: { color: '#ffffff' } }, 'EXPECT_UNSUPPORTED'],
  ]
  for (const [expect, code] of cases) {
    await assert.rejects(mod.execute('type', { label: 7, text: 'never', expect }, {}), error => error.code === code)
  }
  assert.equal(fake.state.value, '')
  assert.equal(fake.state.mutations, 0)
})

test('one invalid batch expectation prevents every earlier action and guard', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  await assert.rejects(mod.execute('batch', {
    actions: [
      { op: 'type', args: { label: 7, text: 'first' } },
      { op: 'click', args: { label: 3, expect: { pixel_changed: true } } },
    ],
  }, {}), error => error.code === 'EXPECT_UNSUPPORTED' && error.path === 'actions[1].expect.pixel_changed')

  assert.equal(fake.state.value, '')
  assert.equal(fake.state.mutations, 0)
  assert.equal(fake.state.scriptCalls.some(call => call.name === 'waitForConditionsPage' || call.name === 'typeLabelled' || call.name === 'clickLabelled'), false)
})

test('Docs export and toolbar expectations use explicit final scopes', async t => {
  const fake = fakeExpectBrowser(t, { docs: true })
  const mod = await fake.initialize()
  const result = await mod.execute('click', {
    label: 3,
    expect: { export_contains: 'new marker', toolbar_style: { bold: true } },
  }, {})

  assert.equal(fake.state.exportBody, 'old text new marker')
  assert.equal(fake.state.bold, true)
  assert.equal(result.expectation.status, 'verified')
  assert.deepEqual(result.expectation.checks.map(check => [check.key, check.status]), [
    ['export_contains', 'verified'], ['toolbar_style', 'verified'],
  ])
  assert.equal(result.expectEvidence.export_contains.before.contains, false)
  assert.equal(result.expectEvidence.export_contains.after.contains, true)
  assert.equal(result.expectEvidence.toolbar_style.after.style.bold, true)
  assert.ok(result.expectEvidence.toolbar_style.after.limits.includes('selection-identity-untracked'))
})

test('Docs export baseline failure prevents the requested mutation', async t => {
  const fake = fakeExpectBrowser(t, { docs: true, exportFailure: true })
  const mod = await fake.initialize()
  await assert.rejects(
    mod.execute('click', { label: 3, expect: { export_contains: 'new marker' } }, {}),
    error => error.code === 'EXPECT_BASELINE_UNAVAILABLE',
  )
  assert.equal(fake.state.count, 0)
  assert.equal(fake.state.mutations, 0)
})

test('containment-only snapshots retain partial-read and scope safeguards', () => {
  const scope = { kind: 'field', id: 7, target: 'unique' }
  const partial = evaluateActionExpect({ text_landed: 'marker' }, {
    text_landed: {
      before: { scope, contains: false, complete: true },
      after: { scope, contains: false, complete: false },
    },
  })
  assert.equal(partial.expectation.status, 'unverified')
  assert.equal(partial.observed, 'unknown')

  const present = evaluateActionExpect({ text_landed: 'marker' }, {
    text_landed: {
      before: { scope, contains: false, complete: true },
      after: { scope, contains: true, complete: false },
    },
  })
  assert.equal(present.expectation.status, 'verified')
  assert.equal(present.observed, 'changed')
})

test('labelled text probes follow the same associated input as typing', t => {
  const previous = { crazyagent: globalThis.__crazyagent, location: globalThis.location }
  t.after(() => {
    globalThis.__crazyagent = previous.crazyagent
    globalThis.location = previous.location
  })
  globalThis.location = { href: 'https://example.test/expect' }
  const input = {
    nodeType: 1,
    tagName: 'INPUT',
    id: 'name',
    type: 'text',
    value: '',
    isContentEditable: false,
    parentElement: null,
    matches: () => true,
  }
  const surface = {
    nodeType: 1,
    isConnected: true,
    isContentEditable: false,
    parentElement: null,
    querySelector: () => input,
  }
  globalThis.__crazyagent = { byId: new Map([[7, surface]]) }
  const before = expectLabelledTextProbe(7, 'Ada')
  assert.equal(before.readable, true)
  assert.equal(before.target, 'unique')
  assert.equal(before.identity, 'input#name')
  assert.equal(before.contains, false)
  input.value = 'Ada'
  assert.equal(expectLabelledTextProbe(7, 'Ada').contains, true)
})

test('pending native dialogs never swallow expect validation and preserve null outcomes', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  await mod.beginDebuggerRun()
  try {
    fake.openNativeDialog()
    await assert.rejects(
      mod.execute('type', { label: 7, text: 'never', expect: { pixel_changed: false } }, {}),
      error => error.name === 'ActionExpectError' && error.code === 'BAD_EXPECT',
    )
    assert.equal(fake.state.value, '')
    assert.equal(fake.state.mutations, 0)

    const pending = await mod.execute('type', { label: 7, text: 'never', expect: { text_landed: 'never' } }, {})
    assert.equal(pending.dialog.status, 'pending')
    assert.deepEqual(pending.expect, { text_landed: 'never' })
    assert.equal(pending.outcome.attempted, null)
    assert.equal(pending.outcome.ok, null)
    assert.equal(pending.mutationPossible, null)
    assert.equal(pending.expectation.status, 'unverified')
    assert.equal(fake.state.value, '')
    assert.equal(fake.state.mutations, 0)
  } finally {
    await mod.execute('dialog', { action: 'dismiss' }, {}).catch(() => {})
    await mod.endDebuggerRun()
  }
})

test('focused-field evidence requires the same document URL and navigation generation', () => {
  const frame = {
    frameId: 0,
    result: {
      readable: true, hasFocus: true, identity: 'input#name', tag: 'input', type: 'text',
      documentUrl: 'https://example.test/first', timeOrigin: 100,
      contains: true, complete: true, chars: 5,
    },
  }
  const before = focusedTextSnapshot([frame])
  for (const difference of [{ documentUrl: 'https://example.test/second' }, { timeOrigin: 101 }]) {
    const after = focusedTextSnapshot([{ ...frame, result: { ...frame.result, ...difference } }])
    const result = evaluateActionExpect({ text_landed: 'value' }, { text_landed: { before, after } })
    assert.equal(result.expectation.status, 'unverified')
    assert.equal(result.expectation.checks[0].reason, 'scope-mismatch')
  }
  const missing = focusedTextSnapshot([{ ...frame, result: { ...frame.result, timeOrigin: undefined } }])
  assert.equal(missing.scope.target, 'unknown')
  assert.ok(missing.limits.includes('document-identity-unavailable'))
})

test('pixel checks reject equal-sized viewports from different documents', async t => {
  const fake = fakeExpectBrowser(t, { navigateAfter: true })
  const mod = await fake.initialize()
  const result = await mod.execute('click', { label: 3, expect: { pixel_changed: true } }, {})
  assert.equal(result.expectation.status, 'unverified')
  assert.equal(result.expectation.checks[0].reason, 'scope-mismatch')
  assert.equal(result.expectation.diagnosticOnly, true)
  assert.equal(result.expectEvidence.pixel_changed.before.scope.detail.includes('example.test/expect'), true)
  assert.equal(result.expectEvidence.pixel_changed.after.scope.detail.includes('example.test/other-document'), true)
  assert.equal(fake.state.count, 1)
})

test('URL-sensitive batch expectations fail before any earlier navigation side effect', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  await assert.rejects(mod.execute('batch', {
    actions: [
      { op: 'navigate', args: { url: 'https://docs.google.com/document/d/doc/edit' } },
      { op: 'type', args: { label: 7, text: 'later', expect: { text_landed: 'later' } } },
    ],
  }, {}), error => error.code === 'EXPECT_UNSUPPORTED' && error.path === 'actions[1].expect.text_landed')
  assert.equal(fake.state.mutations, 0)
  assert.equal(fake.state.scriptCalls.some(call => call.name === 'typeLabelled' || call.name === 'waitForConditionsPage'), false)

  assert.doesNotThrow(() => assertBatchExpectSequence([
    { op: 'wait_for', args: {} },
    { op: 'type', args: { expect: { text_landed: 'later' } } },
  ]))
  for (const op of ['navigate', 'click', 'click_at', 'type', 'press_key', 'scroll', 'select_option']) {
    assert.throws(() => assertBatchExpectSequence([
      { op, args: {} },
      { op: 'type', args: { expect: { text_landed: 'later' } } },
    ]), error => error.code === 'EXPECT_UNSUPPORTED', op)
  }
})

test('explicit null outcome states are never inferred as true', () => {
  const result = finalizeActionEvidence({
    op: 'click', attempted: null, ok: null, mutationPossible: null,
    changed: null, signals: [],
  })
  assert.equal(result.outcome.attempted, null)
  assert.equal(result.outcome.ok, null)
  assert.equal(result.mutationPossible, null)
  assert.equal(finalizeBatchEvidence({ batch: { ok: null }, actions: [] }).outcome.ok, null)
})

test('diverged expectations do not trigger repair or a second mutation', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  const result = await mod.execute('type', {
    label: 7, text: 'Once', expect: { text_landed: 'NOT_PRESENT' }, view: 'none',
  }, {})
  assert.equal(result.expectation.status, 'diverged')
  assert.equal(result.expectation.checks[0].reason, 'missing-after')
  assert.equal(fake.state.value, 'Once')
  assert.equal(fake.state.mutations, 1)
  assert.equal(fake.state.scriptCalls.filter(call => call.name === 'typeLabelled').length, 1)
})

test('off-screen bursts have no trusted or synthetic dispatch and unknown root observation', async t => {
  const fake = fakeExpectBrowser(t)
  const mod = await fake.initialize()
  const result = await mod.execute('click_at', { x: 9_999, y: 9_999, space: 'css', expect: { pixel_changed: true } }, {})
  assert.equal(result.observed, 'unknown')
  assert.equal(result.outcome.attempted, false)
  assert.equal(result.mutationPossible, false)
  assert.equal(fake.state.trustedDispatches, 0)
  assert.equal(fake.state.syntheticDispatches, 0)
  assert.equal(fake.state.count, 0)
})
