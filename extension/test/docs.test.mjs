import test from 'node:test'
import assert from 'node:assert/strict'
import {
  docsFontName,
  docsFormat,
  docsPageProbe,
  docsRename,
  docsReplaceMany,
  docsReplaceText,
  docsSameDocumentUrl,
  docsSetFont,
  docsToolbarFont,
  parseDocsMatchCounter,
} from '../sidepanel/browser.js'

const DOCS_URL = 'https://docs.google.com/document/d/abc/edit'

function fakeDocs(options = {}) {
  const state = {
    toolbar: options.toolbar ?? 'Arial',
    installed: new Set(options.installed ?? ['Arial', 'Syne']),
    allFonts: new Set(options.allFonts ?? options.installed ?? ['Arial', 'Syne']),
    matches: options.matches ?? 1,
    findOpen: false,
    findValue: '',
    dialogOpen: false,
    searchValue: '',
    checked: false,
    removed: false,
  }
  const events = []
  let snapshots = 0
  let currentChecks = 0
  let menuProbes = 0
  let doneProbes = 0
  let now = 1_000
  const tab = { id: 7, url: DOCS_URL }
  const actions = ['fontControl', 'applyFont', 'moreFonts', 'addFont', 'done', 'cancel']
  const point = action => ({ x: actions.indexOf(action) + 1, y: 20 })
  const find = () => ({
    ok: true,
    open: state.findOpen,
    enabled: true,
    value: state.findValue,
    match: {
      current: state.removed || state.matches === 0 ? 0 : 1,
      total: state.removed ? 0 : state.matches,
      text: state.removed ? '0 of 0' : `${state.matches === 0 ? 0 : 1} of ${state.matches}`,
    },
  })
  const io = {
    now: () => now,
    sleep: async ms => { now += ms },
    getWindowId: async () => 1,
    getActiveTab: async () => ({ ...tab }),
    getTab: async () => {
      currentChecks += 1
      if (options.hashAfter === currentChecks) return { ...tab, url: `${DOCS_URL}#heading=h.test` }
      return options.staleAfter === currentChecks ? { ...tab, url: 'https://example.com/stale' } : { ...tab }
    },
    withDebugger: async (_tabId, fn) => fn(),
    dispatchTrustedKey: async (_tabId, spec, mask) => {
      events.push(`key:${spec.key}:${mask}`)
      if (spec.key.toLowerCase() === 'f' && mask === 2) {
        state.findOpen = true
        state.findValue = ''
      } else if (spec.key === 'Escape') {
        state.findOpen = false
      } else if (spec.key === 'Delete') {
        state.removed = true
      }
    },
    trustedClick: async (_tabId, x) => {
      const action = actions[x - 1]
      events.push(`click:${action}`)
      if (action === 'fontControl') state.menuOpen = true
      if (action === 'applyFont' && !options.toolbarMismatch) state.toolbar = options.requestedFont
      if (action === 'moreFonts') state.dialogOpen = true
      if (action === 'addFont') state.checked = true
      if (action === 'done') {
        state.installed.add(options.requestedFont)
        state.dialogOpen = false
      }
      if (action === 'cancel') state.dialogOpen = false
    },
    runInTab: async (_tabId, _func, [command, args]) => {
      events.push(`probe:${command}`)
      switch (command) {
        case 'find': return find()
        case 'setFind':
          state.findValue = args.value
          events.push(`setFind:${args.value}`)
          return { ok: true, readback: state.findValue === args.value, value: state.findValue }
        case 'toolbar': return { ok: true, font: state.toolbar, controlName: `Font list. ${state.toolbar} selected.` }
        case 'fontControl': return { ok: true, point: point('fontControl') }
        case 'fontMenu': {
          if (options.menuDelay && menuProbes++ < options.menuDelay) return { ok: true, found: false, moreFonts: undefined }
          if (options.duplicateFont && state.installed.has(args.font)) {
            return { ok: false, code: 'DUPLICATE_FONT', message: 'duplicate exact font rows' }
          }
          const found = state.installed.has(args.font)
          return {
            ok: true,
            found,
            checked: found && state.toolbar === args.font,
            point: found ? point('applyFont') : undefined,
            moreFonts: point('moreFonts'),
          }
        }
        case 'setSearch':
          state.searchValue = args.value
          events.push(`setSearch:${args.value}`)
          return { ok: true, readback: state.searchValue === args.value, value: state.searchValue }
        case 'fontDialog': {
          if (!state.dialogOpen) return { ok: true, open: false }
          const found = state.allFonts.has(args.font)
          return {
            ok: true,
            open: true,
            searchEnabled: true,
            searchValue: state.searchValue,
            noFonts: state.searchValue === args.font && !found,
            signature: `${state.searchValue}:${found}:${state.checked}`,
            found,
            checked: found && state.checked,
            point: found ? point('addFont') : undefined,
            done: doneProbes++ < (options.doneDelay ?? 0) ? undefined : point('done'),
            cancel: point('cancel'),
          }
        }
        default: throw new Error(`unexpected probe ${command}`)
      }
    },
    snapshot: async () => {
      snapshots += 1
      return { op: 'snapshot', view: 'full', fakeSnapshot: snapshots }
    },
  }
  return { io, state, events, snapshots: () => snapshots }
}

async function runDocs(fake, overrides = {}) {
  return docsSetFont({}, {
    action: 'set_font',
    text: 'needle',
    font: 'Syne',
    ...overrides,
  }, fake.io)
}

test('Docs match counters normalize only one unambiguous counter', () => {
  assert.deepEqual(parseDocsMatchCounter('Find in document\n  1   of  1'), { current: 1, total: 1, text: '1 of 1' })
  assert.deepEqual(parseDocsMatchCounter('0 of 0'), { current: 0, total: 0, text: '0 of 0' })
  assert.equal(parseDocsMatchCounter('2 of 8').total, 8)
  assert.equal(parseDocsMatchCounter('no counter'), undefined)
  assert.equal(parseDocsMatchCounter('1 of 1 and 2 of 2'), undefined)
})

test('Docs accessible font names strip only a trailing submenu marker', () => {
  assert.equal(docsFontName('  Syne   ▸ '), 'Syne')
  assert.equal(docsFontName('Playfair Display ►'), 'Playfair Display')
  assert.equal(docsFontName('Syne Mono'), 'Syne Mono')
  assert.notEqual(docsFontName('Syne'), docsFontName('Syne Mono'))
  assert.equal(docsToolbarFont('Font list. Syne selected.'), 'Syne')
  assert.equal(docsToolbarFont('Font list. Syne Mono selected.'), 'Syne Mono')
  assert.equal(docsToolbarFont('Outfit'), 'Outfit')
  assert.equal(docsToolbarFont('Font list. Syne'), undefined)
})

test('Docs same-document heading hashes are allowed, but real URL changes are not', () => {
  assert.equal(docsSameDocumentUrl(DOCS_URL, `${DOCS_URL}#heading=h.test`), true)
  assert.equal(docsSameDocumentUrl(DOCS_URL, `${DOCS_URL}?tab=t.1`), false)
  assert.equal(docsSameDocumentUrl(DOCS_URL, 'https://example.com/stale'), false)
})

test('Docs page probe serializes without external Find and Replace helpers', () => {
  const source = docsPageProbe.toString()
  assert.doesNotMatch(source, /findReplaceRoot|docsFindReplaceRoot/)
  const revived = new Function(`return (${source})`)()
  assert.deepEqual(revived('invalid'), { ok: false, code: 'BAD_PROBE', message: 'Unknown Docs probe invalid' })
})

test('Docs replace probe scopes role buttons to the structural dialog', () => {
  class FakeElement {
    constructor(tagName, { label, roleName, text = '', x = 0 } = {}, children = []) {
      this.tagName = tagName.toUpperCase()
      this.attributes = { ...label === undefined ? {} : { 'aria-label': label }, ...roleName === undefined ? {} : { role: roleName } }
      this.innerText = text
      this.textContent = text
      this.x = x
      this.children = children
      this.parentElement = undefined
      this.isConnected = true
      this.disabled = false
      this.value = ''
      for (const child of children) child.parentElement = this
    }
    matches(selector) {
      return selector.split(',').some(part => {
        const wanted = part.trim()
        const roleMatch = /^\[role="([^"]+)"\]$/u.exec(wanted)
        if (roleMatch) return this.attributes.role === roleMatch[1]
        if (wanted === 'input' || wanted === 'textarea' || wanted === 'button') return this.tagName === wanted.toUpperCase()
        if (wanted === '[inert]') return 'inert' in this.attributes
        if (wanted === '[aria-hidden="true"]') return this.attributes['aria-hidden'] === 'true'
        if (wanted === ':disabled') return this.disabled
        return false
      })
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...child.matches(selector) ? [child] : [],
        ...child.querySelectorAll(selector),
      ])
    }
    closest(selector) {
      let current = this
      while (current) {
        if (current.matches(selector)) return current
        current = current.parentElement
      }
      return null
    }
    getAttribute(name) { return this.attributes[name] ?? null }
    getBoundingClientRect() { return { left: this.x, top: 0, width: 10, height: 10 } }
    contains(other) {
      let current = other
      while (current) {
        if (current === this) return true
        current = current.parentElement
      }
      return false
    }
    click() { this.clickCount = (this.clickCount ?? 0) + 1 }
  }
  const make = (tag, options, children) => new FakeElement(tag, options, children)
  const find = make('input', { label: 'Find' })
  const replacement = make('input', { label: 'Replace with' })
  const replace = make('div', { label: 'Replace', roleName: 'button', x: 30 })
  const dialog = make('div', { text: 'Find Replace with Replace Replace all Close 1 of 1' }, [
    find,
    replacement,
    replace,
    make('div', { label: 'Replace all', roleName: 'button', x: 50 }),
    make('div', { label: 'Close', roleName: 'button', x: 70 }),
  ])
  const root = make('div', {}, [dialog, make('button', { label: 'Replace', x: 100 })])
  const keys = ['Element', 'document', 'getComputedStyle', 'innerWidth', 'innerHeight']
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let hitElement = find
  Object.assign(globalThis, {
    Element: FakeElement,
    innerWidth: 1790,
    innerHeight: 925,
    document: {
      querySelectorAll: selector => root.querySelectorAll(selector),
      getElementById: () => undefined,
      elementFromPoint: () => hitElement,
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  })
  try {
    const result = docsPageProbe('replace')
    assert.equal(result.ok, true)
    assert.equal(result.open, true)
    assert.deepEqual(result.replace, { x: 35, y: 5 })
    assert.deepEqual(result.match, { current: 1, total: 1, text: '1 of 1' })
    globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'hidden', opacity: '1' })
    hitElement = root
    dialog.innerText = ''
    const cssHidden = docsPageProbe('replace')
    assert.equal(cssHidden.ok, true)
    assert.equal(cssHidden.open, false)
    assert.equal(cssHidden.findEnabled, true)
    assert.equal(cssHidden.replacementEnabled, true)
    assert.deepEqual(cssHidden.replace, { x: 35, y: 5 })
    assert.deepEqual(cssHidden.match, { current: 1, total: 1, text: '1 of 1' })
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})

test('Docs font menu filters unusable duplicates and rejects conflicting active menus', () => {
  class FakeElement {
    constructor(tagName, { label = '', roleName, x = 0, y = 0, covered = false, checked = false, isDisabled = false, hidden = false } = {}) {
      this.tagName = tagName.toUpperCase()
      this.attributes = {
        'aria-label': label,
        ...roleName === undefined ? {} : { role: roleName },
        'aria-checked': String(checked),
        'aria-pressed': String(checked),
      }
      this.innerText = label
      this.textContent = label
      this.rect = { left: x, top: y, width: 100, height: 20 }
      this.covered = covered
      this.hidden = hidden
      this.disabled = isDisabled
      this.isConnected = true
      this.children = []
      this.parentElement = undefined
    }
    matches(selector) {
      return selector.split(',').some(part => {
        const wanted = part.trim()
        const roleMatch = /^\[role="([^"]+)"\]$/u.exec(wanted)
        if (roleMatch) return this.attributes.role === roleMatch[1]
        if (wanted === 'input' || wanted === 'textarea' || wanted === 'button' || wanted === 'label') return this.tagName === wanted.toUpperCase()
        if (wanted === ':disabled') return this.disabled
        if (wanted === '[inert]') return false
        if (wanted === '[aria-hidden="true"]') return false
        return false
      })
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...child.matches(selector) ? [child] : [],
        ...child.querySelectorAll(selector),
      ])
    }
    querySelector() { return null }
    closest(selector) {
      let current = this
      while (current) {
        if (current.matches(selector)) return current
        current = current.parentElement
      }
      return null
    }
    getAttribute(name) { return this.attributes[name] ?? null }
    getBoundingClientRect() { return this.rect }
    contains(other) {
      let current = other
      while (current) {
        if (current === this) return true
        current = current.parentElement
      }
      return false
    }
  }
  const make = (tag, options) => new FakeElement(tag, options)
  const root = make('div')
  const rows = []
  const build = groups => {
    root.children = []
    rows.length = 0
    for (const group of groups) {
      const menu = make('div', { roleName: 'menu' })
      menu.parentElement = root
      root.children.push(menu)
      for (const options of group) {
        const row = make('div', { roleName: 'menuitemcheckbox', ...options })
        row.parentElement = menu
        menu.children.push(row)
        rows.push(row)
      }
    }
  }
  const keys = ['Element', 'document', 'getComputedStyle', 'innerWidth', 'innerHeight']
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, {
    Element: FakeElement,
    innerWidth: 1000,
    innerHeight: 1000,
    document: {
      querySelectorAll: selector => root.querySelectorAll(selector),
      getElementById: id => document[id],
      elementFromPoint: (x, y) => rows.find(row => !row.covered && row.rect.left + 50 === x && row.rect.top + 10 === y) ?? root,
    },
    getComputedStyle: element => element.hidden
      ? { display: 'none', visibility: 'hidden', opacity: '0' }
      : { display: 'block', visibility: 'visible', opacity: '1' },
  })
  try {
    build([[{ label: 'Arial', covered: true }, { label: 'Arial', y: 30 }]])
    const covered = docsPageProbe('fontMenu', { font: 'Arial' })
    assert.equal(covered.ok, true)
    assert.deepEqual(covered.point, { x: 50, y: 40 })

    build([[{ label: 'Arial' }, { label: 'Arial', y: 30, checked: true }]])
    const equivalent = docsPageProbe('fontMenu', { font: 'Arial' })
    assert.equal(equivalent.ok, true)
    assert.equal(equivalent.checked, true)
    assert.deepEqual(equivalent.point, { x: 50, y: 40 })

    build([[{ label: 'Arial' }], [{ label: 'Arial', y: 30 }]])
    assert.equal(docsPageProbe('fontMenu', { font: 'Arial' }).code, 'DUPLICATE_FONT')

    build([[{ label: 'Arial' }, { label: 'Arial', y: 30, isDisabled: true }]])
    assert.equal(docsPageProbe('fontMenu', { font: 'Arial' }).code, 'FONT_DISABLED')

    root.children = []
    rows.length = 0
    const toolbar = make('div', { label: 'Main', roleName: 'toolbar' })
    const numbered = make('div', { label: 'Numbered list (Ctrl+Shift+7)', roleName: 'button', hidden: true, checked: true })
    toolbar.parentElement = root
    numbered.parentElement = toolbar
    toolbar.children = [numbered]
    root.children = [toolbar]
    rows.push(numbered)
    assert.deepEqual(docsPageProbe('format', { attributes: ['numbered'] }), { ok: true, numbered: true })

    const staleHex = make('input', { label: 'Hex color', hidden: true })
    const activeHex = make('input', { label: 'Hex color' })
    activeHex.value = '#0000ff'
    root.children = [staleHex, activeHex]
    rows.length = 0
    rows.push(activeHex)
    assert.deepEqual(docsPageProbe('colorDialog'), {
      ok: true, open: true, enabled: true, focused: false, value: '#0000ff', point: { x: 50, y: 10 },
    })
    const secondVisibleHex = make('input', { label: 'Hex color', y: 30 })
    root.children.push(secondVisibleHex)
    rows.push(secondVisibleHex)
    assert.equal(docsPageProbe('colorDialog').code, 'AMBIGUOUS_DIALOG')

    const more = make('div', { label: 'More', roleName: 'button' })
    toolbar.children = [more]
    root.children = [toolbar]
    rows.length = 0
    rows.push(more)
    assert.deepEqual(docsPageProbe('format', { attributes: ['numbered'] }), {
      ok: true, numbered: undefined, revealPoint: { x: 50, y: 10 },
    })
    const overflowNumbered = make('div', { label: 'Numbered list (Ctrl+Shift+7)', roleName: 'button', checked: true, y: 30 })
    root.children = [toolbar, overflowNumbered]
    rows.push(overflowNumbered)
    assert.deepEqual(docsPageProbe('format', { attributes: ['numbered'] }), { ok: true, numbered: true })

    const portraitRadio = make('input', { roleName: 'radio' })
    portraitRadio.checked = true
    const landscapeRadio = make('input', { roleName: 'radio' })
    landscapeRadio.checked = false
    document['portrait-radio'] = portraitRadio
    document['landscape-radio'] = landscapeRadio
    const portraitLabel = make('label', { label: 'Portrait', y: 10 })
    portraitLabel.htmlFor = 'portrait-radio'
    const landscapeLabel = make('label', { label: 'Landscape', y: 20 })
    landscapeLabel.htmlFor = 'landscape-radio'
    const paper = make('div', { label: 'Paper size', roleName: 'combobox', y: 30 })
    const margins = ['Top', 'Bottom', 'Left', 'Right'].map((label, index) => make('input', { label, y: 40 + index * 10 }))
    const ok = make('div', { label: 'OK', roleName: 'button', y: 80 })
    const setupControls = [paper, portraitLabel, landscapeLabel, ...margins, ok]
    root.children = setupControls
    rows.length = 0
    rows.push(...setupControls)
    const setup = docsPageProbe('pageSetup')
    assert.equal(setup.open, true)
    assert.equal(setup.portrait, true)
    assert.equal(setup.landscape, false)
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})

test('Docs direct font success applies once and returns exactly one final snapshot', async () => {
  const fake = fakeDocs({ requestedFont: 'Syne' })
  const result = await runDocs(fake)
  assert.equal(result.op, 'docs')
  assert.deepEqual(result.docs, {
    action: 'set_font', status: 'applied', matchCount: 1, fontAdded: false, verifiedBy: 'toolbar',
  })
  assert.equal(fake.state.toolbar, 'Syne')
  assert.equal(fake.snapshots(), 1)
  assert.equal(fake.events.filter(event => event === 'click:applyFont').length, 1)
})

test('Docs heading hash changes do not abort a same-document font operation', async () => {
  const fake = fakeDocs({ hashAfter: 2, requestedFont: 'Syne' })
  const result = await runDocs(fake)
  assert.equal(result.docs.status, 'applied')
  assert.equal(fake.snapshots(), 1)
})

test('Docs adds a font, clicks Done, reopens the ordinary menu, then applies', async () => {
  const fake = fakeDocs({ installed: ['Arial'], allFonts: ['Arial', 'Syne'], requestedFont: 'Syne' })
  const result = await runDocs(fake)
  assert.equal(result.docs.status, 'applied')
  assert.equal(result.docs.fontAdded, true)
  assert.deepEqual(fake.events.filter(event => event.startsWith('click:')), [
    'click:fontControl', 'click:moreFonts', 'click:addFont', 'click:done', 'click:fontControl', 'click:applyFont',
  ])
  assert.equal(fake.snapshots(), 1)
})

test('Docs waits for an asynchronously rendered ordinary font menu', async () => {
  const fake = fakeDocs({ menuDelay: 2, requestedFont: 'Syne' })
  const result = await runDocs(fake)
  assert.equal(result.docs.status, 'applied')
  assert.equal(fake.events.filter(event => event === 'click:applyFont').length, 1)
})

test('Docs waits for an asynchronously enabled More fonts Done button', async () => {
  const fake = fakeDocs({ installed: ['Arial'], allFonts: ['Arial', 'Syne'], doneDelay: 2, requestedFont: 'Syne' })
  const result = await runDocs(fake)
  assert.equal(result.docs.status, 'applied')
  assert.equal(result.docs.fontAdded, true)
  assert.equal(fake.events.includes('click:done'), true)
})

test('Docs already-correct toolbar is a no-op after find verification', async () => {
  const fake = fakeDocs({ toolbar: 'Syne', requestedFont: 'Syne' })
  const result = await runDocs(fake)
  assert.equal(result.docs.status, 'already_applied')
  assert.equal(result.docs.fontAdded, false)
  assert.equal(fake.events.some(event => event.startsWith('click:')), false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs rejects zero and duplicate text matches without claiming success', async () => {
  for (const matches of [0, 2]) {
    const fake = fakeDocs({ matches, requestedFont: 'Syne' })
    await assert.rejects(runDocs(fake), error => error.code === 'DOCS_MATCH_NOT_UNIQUE' && error.stage === 'find-match')
    assert.equal(fake.snapshots(), 0)
  }
})

test('Docs exact matching never confuses Syne with Syne Mono', async () => {
  const fake = fakeDocs({ installed: ['Arial', 'Syne Mono'], allFonts: ['Arial', 'Syne Mono'], requestedFont: 'Syne' })
  const result = await runDocs(fake)
  assert.equal(result.docs.status, 'font_missing')
  assert.equal(fake.state.toolbar, 'Arial')
  assert.equal(fake.events.includes('click:applyFont'), false)
})

test('Docs duplicate exact font rows fail closed', async () => {
  const fake = fakeDocs({ duplicateFont: true, requestedFont: 'Syne' })
  await assert.rejects(runDocs(fake), error => error.code === 'DOCS_DUPLICATE_FONT')
  assert.equal(fake.events.includes('click:applyFont'), false)
  assert.equal(fake.snapshots(), 0)
})

test('Docs missing font cancels the dialog and returns font_missing', async () => {
  const fake = fakeDocs({ installed: ['Arial'], allFonts: ['Arial'], requestedFont: 'Syne' })
  const result = await runDocs(fake)
  assert.equal(result.docs.status, 'font_missing')
  assert.equal(result.docs.matchCount, 1)
  assert.equal(fake.state.dialogOpen, false)
  assert.equal(fake.events.includes('click:cancel'), true)
  assert.equal(fake.snapshots(), 1)
})

test('Docs remove_if_missing deletes once and verifies zero matches', async () => {
  const fake = fakeDocs({ installed: ['Arial'], allFonts: ['Arial'], requestedFont: 'Syne' })
  const result = await runDocs(fake, { remove_if_missing: true })
  assert.deepEqual(result.docs, {
    action: 'set_font', status: 'removed_text', matchCount: 0, fontAdded: false,
    verifiedBy: 'find-counter', removedText: true,
  })
  assert.equal(fake.events.filter(event => event === 'key:Delete:0').length, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs toolbar mismatch fails instead of claiming the font applied', async () => {
  const fake = fakeDocs({ toolbarMismatch: true, requestedFont: 'Syne' })
  await assert.rejects(runDocs(fake), error => error.code === 'DOCS_TOOLBAR_MISMATCH' && error.stage === 'verify-toolbar')
  assert.equal(fake.snapshots(), 0)
})

test('Docs stale tab check stops before the next mutation', async () => {
  const fake = fakeDocs({ staleAfter: 2, requestedFont: 'Syne' })
  await assert.rejects(runDocs(fake), error => error.code === 'DOCS_STALE_TAB' && error.stage === 'find-query')
  assert.equal(fake.events.includes('setFind:needle'), false)
  assert.equal(fake.snapshots(), 0)
})

function fakeReplaceDocs(options = {}) {
  const state = {
    document: options.document ?? 'Benchmarks: yea\nThis paragraph must remain exactly unchanged.',
    open: false,
    findOpen: false,
    findValue: '',
    replacementValue: '',
    replaceClicks: 0,
    title: 'Untitled document - Google Docs',
    renameValue: '',
    renameFocused: false,
  }
  const events = []
  let snapshots = 0
  let currentChecks = 0
  let now = 1_000
  const tab = { id: 7, url: DOCS_URL }
  const occurrences = value => {
    if (!value) return 0
    return state.document.toLowerCase().split(String(value).toLowerCase()).length - 1
  }
  const replaceState = () => {
    if (options.missingControls) return { ok: false, code: 'REPLACE_CONTROLS', message: 'Replace or Close is missing or ambiguous' }
    if (!state.open) return { ok: true, open: false }
    const total = occurrences(state.findValue)
    return {
      ok: true,
      open: true,
      findEnabled: true,
      replacementEnabled: true,
      findValue: state.findValue,
      replacementValue: state.replacementValue,
      match: { current: total ? 1 : 0, total, text: `${total ? 1 : 0} of ${total}` },
      replace: { x: 1, y: 20 },
      close: { x: 2, y: 20 },
    }
  }
  const io = {
    now: () => now,
    sleep: async ms => { now += ms },
    getWindowId: async () => 1,
    getActiveTab: async () => ({ ...tab }),
    getTab: async () => {
      currentChecks += 1
      return options.staleAfter === currentChecks ? { ...tab, url: 'https://example.com/stale' } : { ...tab }
    },
    withDebugger: async (_tabId, fn) => fn(),
    dispatchTrustedKey: async (_tabId, spec, mask) => {
      events.push(`key:${spec.key}:${mask}`)
      if (spec.key.toLowerCase() === 'f' && mask === 2) {
        state.findOpen = true
        state.findValue = ''
      } else if (spec.key.toLowerCase() === 'h' && mask === 2 && !options.shortcutFails) {
        state.open = true
        state.findValue = ''
        state.replacementValue = ''
      } else if (spec.key === 'Escape') {
        state.open = false
        state.findOpen = false
      } else if (spec.key === 'Enter') {
        if (!options.commitFails) state.title = `${state.renameValue} - Google Docs`
        state.renameFocused = false
      }
    },
    trustedClick: async (_tabId, x) => {
      events.push(`click:${x === 1 ? 'Replace' : x === 3 ? 'Rename' : x === 4 ? 'Edit' : x === 5 ? 'Find and replace' : 'Close'}`)
      if (x === 3) {
        state.renameFocused = !options.focusFails
        return
      }
      if (x === 4) return
      if (x === 5) {
        state.open = true
        return
      }
      if (x === 1) {
        state.replaceClicks += 1
        if (!options.mutationFails) state.document = state.document.replace(state.findValue, state.replacementValue)
        if (options.findAfterReplace) state.findValue = state.replacementValue
      } else {
        state.open = false
      }
    },
    insertTrustedText: async (_tabId, text) => {
      state.renameValue = text
      state.renameFocused = !options.focusFails
      events.push(`insert:${text}`)
    },
    runInTab: async (_tabId, _func, [command, args]) => {
      events.push(`probe:${command}`)
      if (command === 'rename') {
        return {
          ok: true,
          present: true,
          enabled: true,
          value: state.renameValue,
          focused: state.renameFocused,
          point: { x: 3, y: 20 },
          title: state.title,
        }
      }
      if (command === 'editMenu') return { ok: true, present: true, point: { x: 4, y: 20 }, disabled: false }
      if (command === 'replaceMenuItem') return { ok: true, present: true, point: { x: 5, y: 20 }, disabled: false }
      if (command === 'find') {
        const total = occurrences(state.findValue)
        return {
          ok: true,
          open: state.findOpen,
          enabled: true,
          value: state.findValue,
          match: { current: total ? 1 : 0, total, text: `${total ? 1 : 0} of ${total}` },
        }
      }
      if (command === 'setFind') {
        state.findValue = args.value
        events.push(`setFind:${args.value}`)
        return { ok: true, readback: true, value: state.findValue }
      }
      if (command === 'replace') return replaceState()
      if (command === 'setReplaceFind') {
        state.findValue = args.value
        events.push(`setReplaceFind:${args.value}`)
        return { ok: true, readback: !options.findReadbackFails, value: state.findValue }
      }
      if (command === 'setReplaceWith') {
        state.replacementValue = args.value
        events.push(`setReplaceWith:${args.value}`)
        return { ok: true, readback: !options.replacementReadbackFails, value: state.replacementValue }
      }
      throw new Error(`unexpected probe ${command}`)
    },
    snapshot: async () => {
      snapshots += 1
      return { op: 'snapshot', view: 'full', fakeSnapshot: snapshots }
    },
  }
  return { io, state, events, snapshots: () => snapshots }
}

async function runReplaceDocs(fake, overrides = {}) {
  return docsReplaceText({}, {
    action: 'replace_text',
    text: 'yea',
    replacement: '',
    ...overrides,
  }, fake.io)
}

test('Docs replace_text deletes one unique match with one Replace click and one final view', async () => {
  const fake = fakeReplaceDocs()
  const result = await runReplaceDocs(fake)
  assert.equal(result.op, 'docs')
  assert.deepEqual(result.docs, {
    action: 'replace_text', status: 'removed_text', matchCount: 0,
    verifiedBy: 'find-counter', removedText: 'yea',
  })
  assert.equal(fake.state.document, 'Benchmarks: \nThis paragraph must remain exactly unchanged.')
  assert.equal(fake.state.replaceClicks, 1)
  assert.equal(fake.state.open, false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs replace_text opens the native menu when Ctrl+H cannot open the dialog', async () => {
  const fake = fakeReplaceDocs({ shortcutFails: true })
  const result = await runReplaceDocs(fake)
  assert.equal(result.docs.status, 'removed_text')
  assert.equal(fake.events.filter(event => event === 'click:Edit').length, 1)
  assert.equal(fake.events.filter(event => event === 'click:Find and replace').length, 1)
  assert.equal(fake.state.replaceClicks, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs replace_text replaces a whole title and verifies old and new counters', async () => {
  const fake = fakeReplaceDocs({ document: 'The Quiet Art of Noticing Things\nKeep this.' })
  const result = await runReplaceDocs(fake, {
    text: 'The Quiet Art of Noticing Things',
    replacement: 'he uiet rt of oticing hings',
  })
  assert.equal(result.docs.status, 'replaced_text')
  assert.equal(result.docs.matchCount, 1)
  assert.equal(result.docs.verifiedBy, 'find-counter')
  assert.equal(fake.state.document, 'he uiet rt of oticing hings\nKeep this.')
  assert.equal(fake.state.replaceClicks, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs replace_text verifies a duplicate replacement after Docs changes the query', async () => {
  const fake = fakeReplaceDocs({
    document: 'Benchmarks:\nThis Benchmarks turn vague progress into numbers.',
    findAfterReplace: true,
  })
  const result = await runReplaceDocs(fake, { text: 'This Benchmarks', replacement: 'Benchmarks' })
  assert.equal(result.docs.status, 'replaced_text')
  assert.equal(result.docs.matchCount, 2)
  assert.equal(fake.state.document, 'Benchmarks:\nBenchmarks turn vague progress into numbers.')
  assert.equal(fake.state.replaceClicks, 1)
  assert.deepEqual(fake.events.filter(event => event.startsWith('setReplaceFind:')), [
    'setReplaceFind:This Benchmarks',
    'setReplaceFind:Benchmarks',
    'setReplaceFind:This Benchmarks',
  ])
  assert.equal(fake.events.filter(event => event === 'key:h:2').length, 1)
  assert.equal(fake.events.filter(event => event === 'key:f:2').length, 1)
})

test('Docs replace_text rechecks the old text when the replacement counter cannot prove mutation', async () => {
  const fake = fakeReplaceDocs({ document: 'Benchmarks:\nThis Benchmarks turn vague progress into numbers.', mutationFails: true, findAfterReplace: true })
  await assert.rejects(
    runReplaceDocs(fake, { text: 'This Benchmarks', replacement: 'Benchmarks' }),
    error => error.code === 'DOCS_VERIFY_FAILED' && error.stage === 'verify-replacement',
  )
  assert.equal(fake.state.document, 'Benchmarks:\nThis Benchmarks turn vague progress into numbers.')
  assert.equal(fake.state.replaceClicks, 1)
  assert.equal(fake.snapshots(), 0)
})

test('Docs replace_text verifies an old string contained in its replacement', async () => {
  const fake = fakeReplaceDocs({ document: 'cat' })
  const result = await runReplaceDocs(fake, { text: 'cat', replacement: 'catcat' })
  assert.equal(result.docs.status, 'replaced_text')
  assert.equal(fake.state.document, 'catcat')
  assert.equal(fake.state.replaceClicks, 1)
})

test('Docs replace_text rejects missing and duplicate matches before mutation', async () => {
  for (const document of ['no target here', 'yea and yea']) {
    const fake = fakeReplaceDocs({ document })
    await assert.rejects(runReplaceDocs(fake), error => error.code === 'DOCS_MATCH_NOT_UNIQUE' && error.stage === 'replace-match')
    assert.equal(fake.state.document, document)
    assert.equal(fake.state.replaceClicks, 0)
    assert.equal(fake.snapshots(), 0)
  }
})

test('Docs replace_text rejects a no-op and invalid replacement before using the tab', async () => {
  const fake = fakeReplaceDocs()
  await assert.rejects(runReplaceDocs(fake, { text: 'same', replacement: 'same' }), error => error.code === 'DOCS_BAD_DOCS_REPLACEMENT')
  await assert.rejects(runReplaceDocs(fake, { replacement: 4 }), error => error.code === 'DOCS_BAD_DOCS_REPLACEMENT')
  assert.equal(fake.events.length, 0)
  assert.equal(fake.snapshots(), 0)
})

test('Docs replace_text does not claim success when Replace does not mutate', async () => {
  const fake = fakeReplaceDocs({ mutationFails: true })
  await assert.rejects(runReplaceDocs(fake), error => (
    error.code === 'DOCS_WAIT_TIMEOUT' && error.stage === 'verify-replacement'
      && error.message.includes('open=true') && error.message.includes('match=1 of 1')
  ))
  assert.equal(fake.state.replaceClicks, 1)
  assert.equal(fake.snapshots(), 0)
})

test('Docs replace_text stops on a stale tab before filling the query', async () => {
  const fake = fakeReplaceDocs({ staleAfter: 2 })
  await assert.rejects(runReplaceDocs(fake), error => error.code === 'DOCS_STALE_TAB' && error.stage === 'replace-query')
  assert.equal(fake.events.some(event => event.startsWith('setReplaceFind:')), false)
  assert.equal(fake.state.replaceClicks, 0)
  assert.equal(fake.snapshots(), 0)
})

async function runReplaceManyDocs(fake, edits) {
  return docsReplaceMany({}, { action: 'replace_many', edits }, fake.io)
}

test('Docs replace_many applies ordered edits with one dialog session and one final view', async () => {
  const fake = fakeReplaceDocs({ document: 'alpha beta gamma delta' })
  const result = await runReplaceManyDocs(fake, [
    { text: 'alpha', replacement: 'one' },
    { text: 'beta ', replacement: '' },
    { text: 'gamma', replacement: 'three' },
  ])
  assert.equal(fake.state.document, 'one three delta')
  assert.equal(result.docs.action, 'replace_many')
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.editCount, 3)
  assert.equal(result.docs.appliedCount, 3)
  assert.equal(result.docs.remainingCount, 0)
  assert.equal(result.docs.verifiedBy, 'find-counter')
  assert.equal(fake.state.replaceClicks, 3)
  assert.ok(fake.events.filter(event => event === 'key:h:2').length >= 1)
  assert.ok(fake.events.filter(event => event === 'click:Close').length >= 1)
  assert.equal(fake.state.open, false)
  assert.equal(fake.state.findOpen, false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs replace_many stops on ambiguity and reports partial completion precisely', async () => {
  const fake = fakeReplaceDocs({ document: 'alpha yea yea omega' })
  const result = await runReplaceManyDocs(fake, [
    { text: 'alpha', replacement: 'ONE' },
    { text: 'yea', replacement: '' },
    { text: 'omega', replacement: 'O' },
  ])
  assert.equal(fake.state.document, 'ONE yea yea omega')
  assert.equal(result.docs.status, 'partial')
  assert.equal(result.docs.appliedCount, 1)
  assert.equal(result.docs.remainingCount, 1)
  assert.equal(result.docs.failure.index, 1)
  assert.equal(result.docs.failure.code, 'DOCS_MATCH_NOT_UNIQUE')
  assert.deepEqual(result.docs.results, [
    { index: 0, status: 'replaced_text', matchCount: 1 },
    { index: 1, status: 'failed', code: 'DOCS_MATCH_NOT_UNIQUE' },
  ])
  assert.equal(fake.state.replaceClicks, 1)
  assert.equal(fake.state.open, false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs replace_many reports a first-edit failure without mutation', async () => {
  const fake = fakeReplaceDocs({ document: 'alpha omega' })
  const result = await runReplaceManyDocs(fake, [
    { text: 'missing', replacement: '' },
    { text: 'omega', replacement: 'O' },
  ])
  assert.equal(fake.state.document, 'alpha omega')
  assert.equal(result.docs.status, 'failed')
  assert.equal(result.docs.appliedCount, 0)
  assert.equal(result.docs.remainingCount, 1)
  assert.equal(result.docs.failure.index, 0)
  assert.equal(fake.state.replaceClicks, 0)
  assert.equal(fake.snapshots(), 1)
})

test('Docs replace_many validates every edit before using the tab', async () => {
  const fake = fakeReplaceDocs()
  await assert.rejects(runReplaceManyDocs(fake, []), error => error.code === 'DOCS_BAD_DOCS_EDITS')
  await assert.rejects(runReplaceManyDocs(fake, [{ text: 'same', replacement: 'same' }]), error => error.code === 'DOCS_BAD_DOCS_REPLACEMENT')
  await assert.rejects(runReplaceManyDocs(fake, [{ text: 'valid', replacement: '' }, null]), error => error.code === 'DOCS_BAD_DOCS_EDITS')
  assert.equal(fake.events.length, 0)
  assert.equal(fake.snapshots(), 0)
})

async function runRenameDocs(fake, title = 'Release notes') {
  return docsRename({}, { action: 'rename', title }, fake.io)
}

test('Docs rename verifies title focus before Enter and the committed title afterward', async () => {
  const fake = fakeReplaceDocs()
  const result = await runRenameDocs(fake)
  assert.deepEqual(result.docs, {
    action: 'rename',
    status: 'renamed',
    verifiedBy: 'document-title',
    title: 'Release notes',
  })
  assert.equal(fake.state.title, 'Release notes - Google Docs')
  assert.equal(fake.events.filter(event => event === 'key:Enter:0').length, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs rename refuses to press Enter when title focus is unverified', async () => {
  const fake = fakeReplaceDocs({ focusFails: true })
  await assert.rejects(runRenameDocs(fake), error => error.code === 'DOCS_WAIT_TIMEOUT' && error.stage === 'rename-focus')
  assert.equal(fake.events.includes('key:Enter:0'), false)
  assert.equal(fake.state.title, 'Untitled document - Google Docs')
  assert.equal(fake.snapshots(), 0)
})

test('Docs rename does not claim success when the title does not commit', async () => {
  const fake = fakeReplaceDocs({ commitFails: true })
  await assert.rejects(runRenameDocs(fake), error => error.code === 'DOCS_WAIT_TIMEOUT' && error.stage === 'rename-commit')
  assert.equal(fake.state.title, 'Untitled document - Google Docs')
  assert.equal(fake.snapshots(), 0)
})

test('Docs rename validates the title before using the tab', async () => {
  const fake = fakeReplaceDocs()
  await assert.rejects(runRenameDocs(fake, '   '), error => error.code === 'DOCS_BAD_DOCS_TITLE')
  await assert.rejects(runRenameDocs(fake, 'x'.repeat(201)), error => error.code === 'DOCS_BAD_DOCS_TITLE')
  assert.equal(fake.events.length, 0)
  assert.equal(fake.snapshots(), 0)
})

function fakeFormatDocs(options = {}) {
  const fake = fakeDocs(options)
  const { state, events } = fake
  Object.assign(state, {
    paragraphStyle: options.paragraphStyle ?? 'Normal text',
    fontSize: options.fontSize ?? 11,
    fontSizeValue: String(options.fontSize ?? 11),
    fontSizeFocused: false,
    bold: options.bold ?? false,
    italic: options.italic ?? false,
    underline: options.underline ?? false,
    styleMenuOpen: false,
    requestedStyle: undefined,
  })
  const dispatchTrustedKey = fake.io.dispatchTrustedKey
  fake.io.dispatchTrustedKey = async (tabId, spec, mask) => {
    const toggle = { b: 'bold', i: 'italic', u: 'underline' }[spec.key.toLowerCase()]
    if (mask === 2 && toggle) {
      events.push(`key:${spec.key}:${mask}`)
      if (options[`${toggle}Mismatch`] !== true) state[toggle] = !state[toggle]
      return
    }
    if (mask === 2 && spec.key.toLowerCase() === 'a' && state.fontSizeFocused) {
      events.push(`key:${spec.key}:${mask}`)
      return
    }
    if (spec.key === 'Enter' && state.fontSizeFocused) {
      events.push(`key:${spec.key}:${mask}`)
      if (options.sizeCommitFails !== true) state.fontSize = Number(state.fontSizeValue)
      state.fontSizeFocused = false
      return
    }
    return dispatchTrustedKey(tabId, spec, mask)
  }
  const trustedClick = fake.io.trustedClick
  fake.io.trustedClick = async (tabId, x, y) => {
    if (x === 100) {
      events.push('click:styleControl')
      state.styleMenuOpen = true
      return
    }
    if (x === 101) {
      events.push('click:styleApply')
      if (options.styleMismatch !== true) state.paragraphStyle = state.requestedStyle
      if (options.styleResetsBold === true) state.bold = false
      state.styleMenuOpen = false
      return
    }
    if (x === 102) {
      events.push('click:fontSize')
      state.fontSizeFocused = options.sizeFocusFails !== true
      return
    }
    return trustedClick(tabId, x, y)
  }
  fake.io.insertTrustedText = async (_tabId, text) => {
    if (!state.fontSizeFocused) return
    events.push(`insert:${text}`)
    state.fontSizeValue = text
  }
  const runInTab = fake.io.runInTab
  fake.io.runInTab = async (tabId, func, [command, args]) => {
    if (command === 'format') {
      events.push('probe:format')
      const result = { ok: true }
      for (const attribute of args.attributes) {
        if (options.unknownState === attribute) return { ok: false, code: 'DOCS_FORMAT_STATE_UNKNOWN', message: `${attribute} state is unavailable` }
        if (attribute === 'paragraph_style') Object.assign(result, {
          paragraphStyle: state.paragraphStyle,
          paragraphStylePoint: { x: 100, y: 20 },
        })
        else if (attribute === 'font_size') Object.assign(result, {
          fontSize: state.fontSize,
          fontSizeValue: state.fontSizeValue,
          fontSizeFocused: state.fontSizeFocused,
          fontSizePoint: { x: 102, y: 20 },
        })
        else if (attribute === 'font') result.font = state.toolbar
        else result[attribute] = state[attribute]
      }
      return result
    }
    if (command === 'formatStyleMenu') {
      events.push('probe:formatStyleMenu')
      state.requestedStyle = args.style
      return { ok: true, open: state.styleMenuOpen, point: state.styleMenuOpen ? { x: 101, y: 20 } : undefined }
    }
    return runInTab(tabId, func, [command, args])
  }
  return fake
}

async function runFormatDocs(fake, overrides = {}) {
  return docsFormat({}, { action: 'format', text: 'needle', bold: true, ...overrides }, fake.io)
}

test('Docs format combines six attributes in order with one Find and one final view', async () => {
  const fake = fakeFormatDocs({ italic: true, requestedFont: 'Syne' })
  const result = await runFormatDocs(fake, {
    paragraph_style: 'Title',
    font_size: 28,
    bold: true,
    italic: false,
    underline: true,
    font: 'Syne',
  })
  assert.equal(result.docs.action, 'format')
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.attributeCount, 6)
  assert.equal(result.docs.appliedCount, 6)
  assert.equal(result.docs.alreadyAppliedCount, 0)
  assert.equal(result.docs.results.length, 6)
  assert.equal(fake.state.paragraphStyle, 'Title')
  assert.equal(fake.state.fontSize, 28)
  assert.equal(fake.state.bold, true)
  assert.equal(fake.state.italic, false)
  assert.equal(fake.state.underline, true)
  assert.equal(fake.state.toolbar, 'Syne')
  const order = ['click:styleApply', 'insert:28', 'key:b:2', 'key:i:2', 'key:u:2', 'click:applyFont']
  const indices = order.map(event => fake.events.indexOf(event))
  assert.ok(indices.every(index => index >= 0))
  assert.deepEqual(indices, [...indices].sort((left, right) => left - right))
  assert.equal(fake.events.filter(event => event === 'key:f:2').length, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs format skips every already-correct attribute without a formatting mutation', async () => {
  const fake = fakeFormatDocs({
    paragraphStyle: 'Title', fontSize: 28, bold: true, italic: false, underline: true,
    toolbar: 'Syne', requestedFont: 'Syne',
  })
  const result = await runFormatDocs(fake, {
    paragraph_style: 'Title', font_size: 28, bold: true, italic: false, underline: true, font: 'Syne',
  })
  assert.equal(result.docs.status, 'already_applied')
  assert.equal(result.docs.appliedCount, 0)
  assert.equal(result.docs.alreadyAppliedCount, 6)
  assert.equal(fake.events.some(event => event.startsWith('click:')), false)
  assert.equal(fake.events.some(event => /^key:[biu]:2$/u.test(event)), false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs format rereads desired states after paragraph style changes them', async () => {
  const fake = fakeFormatDocs({ bold: true, styleResetsBold: true })
  const result = await runFormatDocs(fake, { paragraph_style: 'Title', bold: true })
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.appliedCount, 2)
  assert.equal(fake.state.bold, true)
  assert.equal(fake.events.filter(event => event === 'key:b:2').length, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs format can explicitly turn bold off', async () => {
  const fake = fakeFormatDocs({ bold: true })
  const result = await runFormatDocs(fake, { bold: false })
  assert.equal(result.docs.status, 'completed')
  assert.deepEqual(result.docs.results, [{ attribute: 'bold', value: false, status: 'applied', verifiedBy: 'toolbar-pressed' }])
  assert.equal(fake.state.bold, false)
  assert.equal(fake.events.filter(event => event === 'key:b:2').length, 1)
})

test('Docs format rejects missing and duplicate text before formatting', async () => {
  for (const matches of [0, 2]) {
    const fake = fakeFormatDocs({ matches })
    await assert.rejects(runFormatDocs(fake), error => error.code === 'DOCS_MATCH_NOT_UNIQUE' && error.stage === 'find-match')
    assert.equal(fake.events.some(event => event === 'click:styleControl' || event === 'key:b:2'), false)
    assert.equal(fake.snapshots(), 0)
  }
})

test('Docs format never commits font size without verified field focus', async () => {
  const fake = fakeFormatDocs({ sizeFocusFails: true })
  await assert.rejects(runFormatDocs(fake, { bold: undefined, font_size: 100 }), error => (
    error.code === 'DOCS_WAIT_TIMEOUT' && error.stage === 'format-size-focus' && error.message.includes('font_size is unverified')
  ))
  assert.equal(fake.events.some(event => event.startsWith('insert:')), false)
  assert.equal(fake.events.includes('key:Enter:0'), false)
  assert.equal(fake.state.fontSize, 11)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format reports verified earlier changes when a missing font stops the compound request', async () => {
  const fake = fakeFormatDocs({ installed: ['Arial'], allFonts: ['Arial'], requestedFont: 'Missing Sans' })
  const result = await runFormatDocs(fake, { bold: true, font: 'Missing Sans' })
  assert.equal(result.docs.status, 'partial')
  assert.equal(result.docs.appliedCount, 1)
  assert.equal(result.docs.failure.attribute, 'font')
  assert.equal(result.docs.failure.code, 'DOCS_FONT_MISSING')
  assert.deepEqual(result.docs.results.map(result => [result.attribute, result.status]), [['bold', 'applied'], ['font', 'font_missing']])
  assert.equal(fake.state.bold, true)
  assert.equal(fake.state.toolbar, 'Arial')
  assert.equal(fake.events.includes('key:Delete:0'), false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs format stops later attributes after a verification failure and names prior changes', async () => {
  const fake = fakeFormatDocs({ underlineMismatch: true })
  await assert.rejects(
    runFormatDocs(fake, { bold: true, underline: true, italic: true, font: 'Syne' }),
    error => error.code === 'DOCS_FORMAT_MISMATCH' && error.stage === 'format-underline-verify'
      && error.message.includes('bold=true (applied)') && error.message.includes('underline is unverified'),
  )
  assert.equal(fake.state.bold, true)
  assert.equal(fake.events.includes('click:applyFont'), false)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format stops on a stale tab before changing the selection or formatting', async () => {
  const fake = fakeFormatDocs({ staleAfter: 2 })
  await assert.rejects(runFormatDocs(fake), error => error.code === 'DOCS_STALE_TAB' && error.stage === 'find-query')
  assert.equal(fake.events.some(event => event.startsWith('setFind:')), false)
  assert.equal(fake.events.includes('key:b:2'), false)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format validates every argument before using the tab', async () => {
  const fake = fakeFormatDocs()
  const rejected = [
    [{ bold: undefined }, 'DOCS_BAD_DOCS_FORMAT'],
    [{ font_size: 0 }, 'DOCS_BAD_DOCS_FONT_SIZE'],
    [{ font_size: 401 }, 'DOCS_BAD_DOCS_FONT_SIZE'],
    [{ font_size: 1.5 }, 'DOCS_BAD_DOCS_FONT_SIZE'],
    [{ paragraph_style: 'Huge' }, 'DOCS_BAD_DOCS_PARAGRAPH_STYLE'],
    [{ bold: 'yes' }, 'DOCS_BAD_DOCS_FORMAT'],
    [{ font: ' ' }, 'DOCS_BAD_DOCS_FONT'],
    [{ surprise: true }, 'DOCS_BAD_DOCS_FORMAT'],
  ]
  for (const [overrides, code] of rejected) {
    await assert.rejects(runFormatDocs(fake, overrides), error => error.code === code)
  }
  assert.equal(fake.events.length, 0)
  assert.equal(fake.snapshots(), 0)
})
