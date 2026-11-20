import test from 'node:test'
import assert from 'node:assert/strict'
import { clickLabelled, reconcileClickViewChange } from '../sidepanel/browser.js'
import { deriveObservedChange } from '../sidepanel/action-evidence.js'

function setupClickEnv(t, { tag = 'button', type = 'submit', form = null, mutateOnClick = true } = {}) {
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    MutationObserver: globalThis.MutationObserver,
    PointerEvent: globalThis.PointerEvent,
    MouseEvent: globalThis.MouseEvent,
    ShadowRoot: globalThis.ShadowRoot,
    __crazyagent: globalThis.__crazyagent,
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete globalThis[k]
      else globalThis[k] = v
    }
  })

  const observers = []
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; this.active = false }
    observe() { this.active = true; observers.push(this) }
    disconnect() { this.active = false }
  }
  globalThis.PointerEvent = class { constructor(name, init) { this.type = name; Object.assign(this, init) } }
  globalThis.MouseEvent = class { constructor(name, init) { this.type = name; Object.assign(this, init) } }
  globalThis.ShadowRoot = class {}

  const rect = { left: 20, top: 20, right: 120, bottom: 50, width: 100, height: 30 }
  const el = {
    tagName: tag.toUpperCase(),
    type,
    form,
    isConnected: true,
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => rect,
    getRootNode: () => globalThis.document,
    contains: other => other === el,
    focus: () => {},
    dispatchEvent(event) {
      if (event.type === 'click' && mutateOnClick) {
        setTimeout(() => {
          for (const obs of observers) {
            if (obs.active) obs.cb([{ type: 'childList', target: { nodeType: 1, matches: () => false }, addedNodes: [], removedNodes: [] }])
          }
        }, 30)
      }
      return true
    },
  }

  globalThis.window = { innerWidth: 1000, innerHeight: 800 }
  globalThis.location = { href: 'https://docs.google.com/document/d/abc/edit' }
  globalThis.document = {
    title: 'Feature Test Document',
    scrollingElement: { scrollTop: 0 },
    documentElement: { scrollTop: 0 },
    body: { innerText: 'Doc' },
    querySelectorAll: () => [],
    elementFromPoint: () => el,
  }
  globalThis.__crazyagent = {
    byId: new Map([[10, el]]),
    infoById: new Map([[10, { tag, role: 'button', text: 'Image options', disabled: false }]]),
    idsByElement: new WeakMap([[el, 10]]),
  }
}

test('standalone button (default type=submit, form=null) observes DOM mutations instead of pendingNavigation', async t => {
  setupClickEnv(t, { tag: 'button', type: 'submit', form: null, mutateOnClick: true })
  const res = await clickLabelled(10)
  assert.equal(res.ok, true)
  assert.equal(res.pendingNavigation, undefined)
  assert.equal(res.changed, true)
  assert.ok(res.signals.some(s => s.startsWith('dom-mutations:')))
  assert.equal(res.signals.includes('navigation-possible'), false)
})

test('button inside a form with type=submit keeps pendingNavigation guard', async t => {
  setupClickEnv(t, { tag: 'button', type: 'submit', form: {}, mutateOnClick: false })
  const res = await clickLabelled(10)
  assert.equal(res.ok, true)
  assert.equal(res.pendingNavigation, true)
  assert.deepEqual(res.signals, ['navigation-possible'])
})

test('reconcileClickViewChange promotes full-view and iframe label deltas from NO VISIBLE CHANGE', () => {
  const before = [{ id: 1, tag: 'button', role: 'button', text: 'Restricted' }]
  const after = [
    { id: 1, tag: 'button', role: 'button', text: 'Restricted' },
    { id: 24900011, tag: 'li', role: 'menuitemradio', text: 'Anyone with the link', frame: 249 },
  ]
  const rec = reconcileClickViewChange({
    changed: false,
    signals: ['navigation-possible'],
    pendingNavigation: true,
    navigated: false,
    beforeLabels: before,
    afterLabels: after,
    layoutChanged: false,
  })
  assert.equal(rec.changed, true)
  assert.deepEqual(rec.signals, ['labels-added'])
  const evidence = deriveObservedChange({ op: 'click', changed: rec.changed, signals: rec.signals, navigated: false })
  assert.equal(evidence.observed, 'changed')
  assert.equal(evidence.diagnosticOnly, true)
})

test('reconcileClickViewChange preserves genuine no-op clicks as unchanged', () => {
  const same = [{ id: 1, tag: 'button', role: 'button', text: 'Dead button' }]
  const rec = reconcileClickViewChange({
    changed: false,
    signals: [],
    pendingNavigation: false,
    navigated: false,
    beforeLabels: same,
    afterLabels: same,
    layoutChanged: false,
  })
  assert.equal(rec.changed, false)
  assert.deepEqual(rec.signals, [])
  const evidence = deriveObservedChange({ op: 'click', changed: rec.changed, signals: rec.signals, navigated: false })
  assert.equal(evidence.observed, 'unchanged')
})
