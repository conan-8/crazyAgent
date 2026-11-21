import test from 'node:test'
import assert from 'node:assert/strict'
import { labelPage, pageMetrics } from '../sidepanel/browser.js'

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

test('labelPage labels Shadow DOM Web Component buttons with slotted light-DOM text', async t => {
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
      this.innerText = spec.innerText ?? ''
      this.textContent = spec.textContent ?? ''
      this.attrs = spec.attrs ?? {}
      this.disabled = false
      this.isContentEditable = false
      this.rect = spec.rect
      this.parentElement = spec.parentElement ?? null
      this.assignedSlot = spec.assignedSlot ?? null
      this.rootNode = spec.rootNode ?? null
      this.slots = spec.slots ?? []
    }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null }
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) }
    getBoundingClientRect() { return this.rect }
    getRootNode() { return this.rootNode ?? globalThis.document }
    matches() { return false }
    contains(other) { return other === this }
    querySelector() { return null }
    querySelectorAll(sel) { return sel === 'slot' ? this.slots : [] }
  }
  class MockShadowRoot {
    constructor(host) { this.host = host }
  }
  globalThis.Element = MockElement
  globalThis.ShadowRoot = MockShadowRoot
  globalThis.__crazyagent = undefined
  globalThis.window = { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 }
  globalThis.location = { href: 'https://m3a.vhlcentral.com/sections/1/activities/2' }
  globalThis.getComputedStyle = () => ({ display: 'inline-flex', visibility: 'visible', opacity: '1', pointerEvents: 'auto' })

  const rect = { left: 700, top: 490, right: 840, bottom: 526, width: 140, height: 36 }
  const slButton = new MockElement({ tag: 'sl-button', rect })
  const slottedLabel = new MockElement({ tag: 'span', textContent: 'Save Answers', rect, parentElement: slButton })
  const shadow = new MockShadowRoot(slButton)
  const slot = new MockElement({ tag: 'slot', rect, rootNode: shadow })
  slot.assignedNodes = () => [slottedLabel]
  slot.assignedElements = () => [slottedLabel]
  const innerButton = new MockElement({ tag: 'button', rect, rootNode: shadow, slots: [slot] })
  slot.parentElement = innerButton
  slottedLabel.assignedSlot = slot
  shadow.querySelectorAll = sel => (sel === '*' ? [innerButton, slot] : [innerButton])
  shadow.elementFromPoint = () => slottedLabel
  slButton.shadowRoot = shadow

  globalThis.document = {
    title: 'VHL Central',
    readyState: 'complete',
    activeElement: null,
    scrollingElement: { scrollLeft: 0, scrollTop: 0, scrollHeight: 800, scrollWidth: 1200, clientHeight: 800, clientWidth: 1200 },
    documentElement: { scrollLeft: 0, scrollTop: 0, scrollHeight: 800, scrollWidth: 1200, clientHeight: 800, clientWidth: 1200 },
    body: { innerText: '' },
    getElementById: () => null,
    querySelectorAll: sel => (sel === '*' ? [slButton, slottedLabel] : []),
    elementFromPoint: () => slButton,
  }

  const out = await labelPage(50)
  assert.equal(out.labels.length, 1)
  assert.equal(out.labels[0].role, 'button')
  assert.equal(out.labels[0].text, 'Save Answers')
})

test('H2: pageMetrics and labelPage detect an inner viewport scroll container (.kix-appview-editor) when root does not scroll', async t => {
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
      this.nodeType = 1
      this.tagName = spec.tag.toUpperCase()
      this.id = spec.id ?? ''
      this.className = spec.className ?? ''
      this.scrollLeft = spec.scrollLeft ?? 0
      this.scrollTop = spec.scrollTop ?? 0
      this.scrollHeight = spec.scrollHeight ?? 0
      this.scrollWidth = spec.scrollWidth ?? 0
      this.clientHeight = spec.clientHeight ?? 0
      this.clientWidth = spec.clientWidth ?? 0
      this.parentElement = spec.parentElement ?? null
      this.rect = spec.rect
      this.style = spec.style ?? { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible', overflowX: 'visible' }
      this.attrs = spec.attrs ?? {}
    }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null }
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) }
    getBoundingClientRect() { return this.rect }
    getRootNode() { return globalThis.document }
    matches() { return false }
    contains(other) { return other === this }
    querySelector() { return null }
  }
  globalThis.Element = MockElement
  globalThis.ShadowRoot = class {}
  globalThis.__crazyagent = undefined
  globalThis.window = { innerWidth: 1162, innerHeight: 770, devicePixelRatio: 1 }
  globalThis.location = { href: 'https://docs.google.com/document/d/abc/edit' }
  globalThis.getComputedStyle = el => el.style

  const docRoot = { scrollLeft: 0, scrollTop: 0, scrollHeight: 770, scrollWidth: 1162, clientHeight: 770, clientWidth: 1162 }
  const editor = new MockElement({
    tag: 'div',
    className: 'kix-appview-editor',
    scrollTop: 1050,
    scrollHeight: 3200,
    clientHeight: 640,
    scrollWidth: 1162,
    clientWidth: 1162,
    rect: { left: 0, top: 130, right: 1162, bottom: 770, width: 1162, height: 640 },
    style: { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'scroll', overflowX: 'hidden' },
  })
  const canvas = new MockElement({
    tag: 'canvas',
    parentElement: editor,
    rect: { left: 173, top: 140, right: 989, bottom: 770, width: 816, height: 630 },
  })
  const smallSidebar = new MockElement({
    tag: 'div',
    className: 'navigation-widget-content',
    scrollTop: 80,
    scrollHeight: 1500,
    clientHeight: 640,
    scrollWidth: 200,
    clientWidth: 200,
    rect: { left: 0, top: 130, right: 200, bottom: 770, width: 200, height: 640 },
    style: { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto', overflowX: 'hidden' },
  })
  globalThis.document = {
    title: 'Feature Test Document - Google Docs',
    readyState: 'complete',
    activeElement: null,
    scrollingElement: docRoot,
    documentElement: docRoot,
    body: { innerText: '' },
    getElementById: () => null,
    querySelectorAll: () => [],
    elementsFromPoint: (x, y) => (x < 200 ? [smallSidebar, editor] : [canvas, editor]),
    elementFromPoint: () => canvas,
  }

  // Mid-document inner scroll.
  const pm = pageMetrics()
  assert.equal(pm.scroll.container, 'div.kix-appview-editor')
  assert.equal(pm.scroll.y, 1050)
  assert.equal(pm.scroll.maxY, 2560)
  assert.equal(pm.scroll.atTop, false)
  assert.equal(pm.scroll.atBottom, false)
  assert.equal(pm.fingerprint.scrollY, 1050)

  const lp = await labelPage(50)
  assert.equal(lp.scroll.container, 'div.kix-appview-editor')
  assert.equal(lp.scroll.y, 1050)
  assert.equal(lp.scroll.maxY, 2560)
  assert.equal(lp.scroll.atTop, false)
  assert.equal(lp.scroll.atBottom, false)
  assert.equal(lp.fingerprint.scrollY, 1050)

  // At bottom of inner scroll container.
  editor.scrollTop = 2560
  assert.equal(pageMetrics().scroll.atBottom, true)
  assert.equal(pageMetrics().scroll.atTop, false)

  // Standard document scrolling remains untouched when root scrolls.
  docRoot.scrollHeight = 2400
  docRoot.scrollTop = 300
  const normal = pageMetrics()
  assert.equal(normal.scroll.container, 'document')
  assert.equal(normal.scroll.y, 300)
  assert.equal(normal.scroll.maxY, 1630)
  assert.equal(normal.fingerprint.scrollY, 300)

  // Small sidebar alone (covering <30% width) does not override document scroll.
  docRoot.scrollHeight = 770
  docRoot.scrollTop = 0
  globalThis.document.elementsFromPoint = () => [smallSidebar]
  const smallOnly = pageMetrics()
  assert.equal(smallOnly.scroll.container, 'document')
  assert.equal(smallOnly.scroll.y, 0)
  assert.equal(smallOnly.scroll.maxY, 0)
})

test('H3: labelPage tags open menu/dialog/listbox items with popup:true while excluding menubar and toolbar chrome', async t => {
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
      this.innerText = spec.innerText ?? ''
      this.textContent = spec.textContent ?? spec.innerText ?? ''
      this.attrs = spec.attrs ?? {}
      this.classes = new Set(spec.classes ?? [])
      this.disabled = false
      this.isContentEditable = false
      this.parentElement = spec.parentElement ?? null
      this.rect = spec.rect
    }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null }
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) }
    getBoundingClientRect() { return this.rect }
    getRootNode() { return globalThis.document }
    matches(selector) {
      return selector.split(',').some(part => {
        const s = part.trim()
        const roleMatch = /^\[role="([^"]+)"\]$/u.exec(s)
        if (roleMatch) return this.attrs.role === roleMatch[1]
        if (s.startsWith('.')) return this.classes.has(s.slice(1))
        return false
      })
    }
    contains(other) { return other === this }
    querySelector() { return null }
  }
  globalThis.Element = MockElement
  globalThis.ShadowRoot = class {}
  globalThis.__crazyagent = undefined
  globalThis.window = { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1 }
  globalThis.location = { href: 'https://docs.google.com/document/d/abc/edit' }
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' })

  const menubar = new MockElement({ tag: 'div', attrs: { role: 'menubar' }, rect: { left: 0, top: 0, right: 600, bottom: 30, width: 600, height: 30 } })
  const insertTop = new MockElement({ tag: 'div', innerText: 'Insert', attrs: { role: 'menuitem' }, parentElement: menubar, rect: { left: 100, top: 4, right: 160, bottom: 26, width: 60, height: 22 } })
  const toolbar = new MockElement({ tag: 'div', attrs: { role: 'toolbar' }, rect: { left: 0, top: 32, right: 900, bottom: 64, width: 900, height: 32 } })
  const fontOption = new MockElement({ tag: 'div', innerText: 'Font list. Roboto selected.', attrs: { role: 'option' }, parentElement: toolbar, rect: { left: 200, top: 36, right: 320, bottom: 60, width: 120, height: 24 } })
  const openMenu = new MockElement({ tag: 'div', attrs: { role: 'menu' }, classes: ['goog-menu'], rect: { left: 100, top: 30, right: 340, bottom: 420, width: 240, height: 390 } })
  const pageElements = new MockElement({ tag: 'div', innerText: 'Page elements Updated ►', attrs: { role: 'menuitem' }, parentElement: openMenu, rect: { left: 104, top: 360, right: 336, bottom: 390, width: 232, height: 30 } })
  const dialog = new MockElement({ tag: 'div', attrs: { role: 'dialog' }, rect: { left: 400, top: 200, right: 700, bottom: 400, width: 300, height: 200 } })
  const dialogBtn = new MockElement({ tag: 'button', innerText: 'Apply', parentElement: dialog, rect: { left: 600, top: 350, right: 680, bottom: 382, width: 80, height: 32 } })

  const items = [insertTop, fontOption, pageElements, dialogBtn]
  globalThis.document = {
    title: 'Test Doc',
    readyState: 'complete',
    activeElement: null,
    scrollingElement: { scrollLeft: 0, scrollTop: 0, scrollHeight: 800, scrollWidth: 1200, clientHeight: 800, clientWidth: 1200 },
    documentElement: { scrollLeft: 0, scrollTop: 0, scrollHeight: 800, scrollWidth: 1200, clientHeight: 800, clientWidth: 1200 },
    body: { innerText: '' },
    getElementById: () => null,
    querySelectorAll: sel => (sel === '*' || sel === 'canvas,video,iframe' ? [] : items),
    elementFromPoint: (x, y) => items.find(el => x >= el.rect.left && x <= el.rect.right && y >= el.rect.top && y <= el.rect.bottom) ?? null,
  }

  const out = await labelPage(50)
  const byText = new Map(out.labels.map(l => [l.text, l]))
  assert.equal(byText.get('Insert').popup, undefined, 'menubar item must not be tagged popup')
  assert.equal(byText.get('Font list. Roboto selected.').popup, undefined, 'toolbar option must not be tagged popup')
  assert.equal(byText.get('Page elements Updated ►').popup, true, 'open menu item must be tagged popup')
  assert.equal(byText.get('Apply').popup, true, 'button inside dialog must be tagged popup')
})
