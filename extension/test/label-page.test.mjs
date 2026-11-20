import test from 'node:test'
import assert from 'node:assert/strict'
import { labelPage } from '../sidepanel/browser.js'

function runWithMockDom(t, elements) {
  const prev = {
    Element: globalThis.Element,
    ShadowRoot: globalThis.ShadowRoot,
    document: globalThis.document,
    window: globalThis.window,
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
  class MockElement {
    constructor(spec) {
      this.tagName = spec.tag.toUpperCase()
      this.type = spec.type ?? ''
      this.value = spec.value
      this.innerText = spec.innerText ?? ''
      this.textContent = spec.textContent ?? spec.innerText ?? ''
      this.attrs = spec.attrs ?? {}
      this.disabled = spec.disabled === true
      this.isContentEditable = spec.isContentEditable === true
      this.rect = spec.rect ?? { left: 10, top: 10, right: 120, bottom: 40, width: 110, height: 30 }
    }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null }
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) }
    getBoundingClientRect() { return this.rect }
    getRootNode() { return globalThis.document }
    matches() { return false }
    contains(other) { return other === this }
    querySelector() { return null }
  }
  class MockShadowRoot {}
  const instances = elements.map(spec => new MockElement(spec))
  globalThis.Element = MockElement
  globalThis.ShadowRoot = MockShadowRoot
  globalThis.__crazyagent = undefined
  globalThis.window = { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 }
  globalThis.location = { href: 'https://docs.google.com/document/d/abc/edit' }
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' })
  globalThis.document = {
    title: 'Test Doc',
    readyState: 'complete',
    activeElement: null,
    scrollingElement: { scrollLeft: 0, scrollTop: 0, scrollHeight: 800, scrollWidth: 1200, clientHeight: 800, clientWidth: 1200 },
    documentElement: { scrollLeft: 0, scrollTop: 0, scrollHeight: 800, scrollWidth: 1200, clientHeight: 800, clientWidth: 1200 },
    body: { innerText: '' },
    getElementById: () => null,
    querySelectorAll: sel => (sel === '*' || sel === 'canvas,video,iframe' ? [] : instances),
    elementFromPoint: (x, y) => instances.find(el => x >= el.rect.left && x <= el.rect.right && y >= el.rect.top && y <= el.rect.bottom) ?? null,
  }
  return instances
}

test('labelPage reads visible text on li menuitemradio and option instead of default HTMLLIElement value 0', async t => {
  runWithMockDom(t, [
    {
      tag: 'li',
      value: 0,
      innerText: 'Anyone with the link',
      attrs: { role: 'menuitemradio' },
      rect: { left: 10, top: 10, right: 200, bottom: 40, width: 190, height: 30 },
    },
    {
      tag: 'li',
      value: 0,
      innerText: 'Commenter',
      attrs: { role: 'menuitemradio' },
      rect: { left: 10, top: 50, right: 200, bottom: 80, width: 190, height: 30 },
    },
    {
      tag: 'li',
      value: 0,
      innerText: 'Section Two',
      attrs: { role: 'option' },
      rect: { left: 10, top: 90, right: 200, bottom: 120, width: 190, height: 30 },
    },
    {
      tag: 'input',
      type: 'text',
      value: 'Feature Test Document',
      rect: { left: 10, top: 130, right: 200, bottom: 160, width: 190, height: 30 },
    },
    {
      tag: 'input',
      type: 'password',
      value: 'super-secret',
      attrs: { placeholder: 'Password' },
      rect: { left: 10, top: 170, right: 200, bottom: 200, width: 190, height: 30 },
    },
  ])
  const out = await labelPage(50)
  assert.equal(out.labels.length, 5)
  assert.deepEqual(
    out.labels.map(l => ({ role: l.role, text: l.text })),
    [
      { role: 'menuitemradio', text: 'Anyone with the link' },
      { role: 'menuitemradio', text: 'Commenter' },
      { role: 'option', text: 'Section Two' },
      { role: 'textbox', text: 'Feature Test Document' },
      { role: 'textbox', text: 'Password' },
    ],
  )
})
