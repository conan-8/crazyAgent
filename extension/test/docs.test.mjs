import test from 'node:test'
import assert from 'node:assert/strict'
import {
  docsFontName,
  docsFormat,
  docsFormatMany,
  docsPageProbe,
  docsRename,
  docsReplaceMany,
  docsReplaceText,
  docsSameDocumentUrl,
  docsSelectText,
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
    focused: state.findOpen,
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
          focused: state.findOpen,
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
      && error.failedAttribute === 'underline'
      && error.priorResults.length === 2
      && error.priorResults.every((result, index) => result.attribute === ['bold', 'italic'][index] && result.status === 'applied')
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

function fakeSelectDocs(options = {}) {
  const paragraphs = options.paragraphs ?? ['needle']
  const state = {
    document: options.document ?? paragraphs.join('\n'),
    findOpen: false,
    findFocused: false,
    findValue: '',
    current: 0,
  }
  const events = []
  let snapshots = 0
  let currentChecks = 0
  let now = 1_000
  const tab = { id: 7, url: DOCS_URL }
  const occurrences = value => {
    const source = state.document.toLowerCase()
    const wanted = String(value).toLowerCase()
    if (!wanted) return 0
    let count = 0
    for (let index = source.indexOf(wanted); index >= 0; index = source.indexOf(wanted, index + wanted.length)) count += 1
    return count
  }
  const total = value => options.nativeTotals?.[value] ?? occurrences(value)
  const find = () => {
    const count = total(state.findValue)
    const current = count ? state.current : 0
    return {
      ok: true,
      open: state.findOpen,
      enabled: true,
      focused: state.findOpen && state.findFocused,
      value: state.findValue,
      match: { current, total: count, text: `${current} of ${count}` },
    }
  }
  const exported = options.exportHtml ?? `<html><body>${paragraphs.map(text => `<p>${String(text)
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')}</p>`).join('')}</body></html>`
  const io = {
    now: () => now,
    sleep: async ms => { now += ms },
    getWindowId: async () => 1,
    getActiveTab: async () => ({ ...tab }),
    getTab: async () => {
      currentChecks += 1
      return options.staleAfter === currentChecks ? { ...tab, url: 'https://example.com/stale' } : { ...tab }
    },
    fetchExport: async () => {
      events.push('export:html')
      return exported
    },
    withDebugger: async (_tabId, fn) => fn(),
    dispatchTrustedKey: async (_tabId, spec, mask) => {
      events.push(`key:${spec.key}:${mask}`)
      if (spec.key.toLowerCase() === 'f' && mask === 2) {
        state.findOpen = true
        state.findFocused = !options.focusFails
        state.findValue = ''
        state.current = 0
      } else if (spec.key === 'Escape') {
        state.findOpen = false
        state.findFocused = false
      } else if (spec.key === 'Enter' && state.findOpen) {
        if (options.focusLossAfterKey) state.findFocused = false
        if (options.queryDriftAfterKey) state.findValue = 'drift'
        if (options.totalChangeAfterKey) state.document += ' needle'
        const count = total(state.findValue)
        if (!count) state.current = 0
        else if (!options.navigationStalls) {
          state.current = mask === 8 ? (state.current - 2 + count) % count + 1 : state.current % count + 1
        }
      }
    },
    runInTab: async (_tabId, _func, [command, args]) => {
      events.push(`probe:${command}`)
      if (command === 'find') return find()
      if (command === 'setFind') {
        state.findValue = args.value
        const count = total(args.value)
        state.current = count ? Math.min(options.initialCurrent ?? 1, count) : 0
        events.push(`setFind:${args.value}`)
        return { ok: true, readback: true, value: state.findValue }
      }
      throw new Error(`unexpected probe ${command}`)
    },
    snapshot: async () => {
      snapshots += 1
      return { op: 'snapshot', view: 'full' }
    },
  }
  return { io, state, events, snapshots: () => snapshots }
}

async function runSelectDocs(fake, overrides = {}) {
  return docsSelectText({}, { action: 'select_text', text: 'needle', ...overrides }, fake.io)
}

test('Docs select_text selects one unique match and returns only Find evidence', async () => {
  const fake = fakeSelectDocs()
  const result = await runSelectDocs(fake)
  assert.deepEqual(result, {
    op: 'docs',
    docs: {
      action: 'select_text',
      status: 'selected',
      scope: 'text',
      text: 'needle',
      occurrence: 1,
      current: 1,
      matchCount: 1,
      verifiedBy: 'find-counter',
      findFocused: true,
    },
  })
  assert.equal(fake.state.findOpen, false)
  assert.equal(fake.events.includes('export:html'), false)
  assert.equal(fake.snapshots(), 0)
})

test('Docs select_text resolves first, last, and nth with bounded wraparound navigation', async () => {
  const cases = [
    { initialCurrent: 3, occurrence: 'first', expected: 1, key: 'key:Enter:0' },
    { initialCurrent: 1, occurrence: 'last', expected: 3, key: 'key:Enter:8' },
    { initialCurrent: 1, occurrence: 2, expected: 2, key: 'key:Enter:0' },
  ]
  for (const item of cases) {
    const fake = fakeSelectDocs({ document: 'needle one needle two needle', initialCurrent: item.initialCurrent })
    const result = await runSelectDocs(fake, { occurrence: item.occurrence })
    assert.equal(result.docs.occurrence, item.expected)
    assert.equal(result.docs.current, item.expected)
    assert.equal(result.docs.matchCount, 3)
    const navigation = fake.events.filter(event => event === 'key:Enter:0' || event === 'key:Enter:8')
    assert.deepEqual(navigation, [item.key])
    assert.equal(fake.events.at(-1), 'probe:find')
    assert.equal(fake.state.findOpen, false)
    assert.equal(fake.snapshots(), 0)
  }
})

test('Docs select_text rejects duplicates, zero matches, and out-of-range ordinals without fallback', async () => {
  const cases = [
    { document: 'needle needle', occurrence: undefined, code: 'DOCS_MATCH_NOT_UNIQUE' },
    { document: 'nothing here', occurrence: undefined, code: 'DOCS_MATCH_NOT_UNIQUE' },
    { document: 'nothing here', occurrence: 'first', code: 'DOCS_MATCH_OUT_OF_RANGE' },
    { document: 'needle one needle two needle', occurrence: 4, code: 'DOCS_MATCH_OUT_OF_RANGE' },
  ]
  for (const item of cases) {
    const fake = fakeSelectDocs({ document: item.document })
    await assert.rejects(runSelectDocs(fake, { occurrence: item.occurrence }), error => error.code === item.code)
    assert.equal(fake.events.includes('key:Escape:0'), false)
    assert.equal(fake.events.some(event => event === 'key:Enter:0' || event === 'key:Enter:8'), false)
    assert.equal(fake.state.findOpen, true)
    assert.equal(fake.snapshots(), 0)
  }
})

test('Docs select_text requires Find focus before filling the query', async () => {
  const fake = fakeSelectDocs({ focusFails: true })
  await assert.rejects(runSelectDocs(fake), error => error.code === 'DOCS_WAIT_TIMEOUT' && error.stage === 'open-find')
  assert.equal(fake.events.some(event => event.startsWith('setFind:')), false)
  assert.equal(fake.events.includes('key:Escape:0'), false)
  assert.equal(fake.snapshots(), 0)
})

test('Docs select_text stops after focus, query, current, or total drift during navigation', async () => {
  const options = [{ focusLossAfterKey: true }, { queryDriftAfterKey: true }, { navigationStalls: true }, { totalChangeAfterKey: true }]
  for (const option of options) {
    const fake = fakeSelectDocs({ document: 'needle one needle two needle', ...option })
    await assert.rejects(runSelectDocs(fake, { occurrence: 2 }), error => (
      error.code === 'DOCS_WAIT_TIMEOUT' && error.stage === 'find-navigate'
    ))
    const navigation = fake.events.filter(event => event === 'key:Enter:0' || event === 'key:Enter:8')
    assert.equal(navigation.length, 1)
    assert.equal(fake.events.includes('key:Escape:0'), false)
    assert.equal(fake.state.findOpen, true)
    assert.equal(fake.snapshots(), 0)
  }
})

test('Docs select_text maps a case-insensitive anchor to the computed full-paragraph occurrence', async () => {
  const fake = fakeSelectDocs({ paragraphs: ['Same Needle', 'other', 'same needle'] })
  const result = await runSelectDocs(fake, { text: 'NEEDLE', occurrence: 2, scope: 'paragraph' })
  assert.deepEqual(result.docs, {
    action: 'select_text',
    status: 'selected',
    scope: 'paragraph',
    text: 'same needle',
    occurrence: 2,
    current: 2,
    matchCount: 2,
    verifiedBy: 'find-counter',
    findFocused: true,
    anchorText: 'NEEDLE',
    paragraphIndex: 3,
  })
  assert.deepEqual(fake.events.filter(event => event.startsWith('setFind:')), ['setFind:NEEDLE', 'setFind:same needle'])
  assert.deepEqual(fake.events.filter(event => event === 'key:Enter:0' || event === 'key:Enter:8'), ['key:Enter:0'])
  assert.equal(fake.events.filter(event => event === 'export:html').length, 1)
  assert.equal(fake.snapshots(), 0)
})

test('Docs select_text paragraph mapping uses literal non-overlapping occurrences', async () => {
  const fake = fakeSelectDocs({ paragraphs: ['aaaa'] })
  const result = await runSelectDocs(fake, { text: 'aa', occurrence: 2, scope: 'paragraph' })
  assert.equal(result.docs.text, 'aaaa')
  assert.equal(result.docs.occurrence, 1)
  assert.equal(result.docs.anchorText, 'aa')
  assert.equal(fake.events.some(event => event === 'key:Enter:0' || event === 'key:Enter:8'), false)
  assert.equal(fake.snapshots(), 0)
})

test('Docs select_text paragraph mode fails closed for ambiguity and unmappable exports', async () => {
  const longParagraph = `${'x'.repeat(1001)} needle`
  const cases = [
    {
      options: { paragraphs: ['needle', 'needle'] }, args: { scope: 'paragraph' }, code: 'DOCS_MATCH_NOT_UNIQUE',
    },
    {
      options: { paragraphs: [], document: 'needle', exportHtml: '<table><tr><td><p>needle</p></td></tr></table>' },
      args: { scope: 'paragraph' }, code: 'DOCS_PARAGRAPH_UNMAPPABLE',
    },
    {
      options: { document: 'before\nneedle after', exportHtml: '<p>before<br>needle after</p>' },
      args: { scope: 'paragraph' }, code: 'DOCS_PARAGRAPH_UNMAPPABLE',
    },
    {
      options: { paragraphs: [longParagraph] }, args: { scope: 'paragraph' }, code: 'DOCS_PARAGRAPH_UNMAPPABLE',
    },
    {
      options: { paragraphs: ['needle'], document: 'needle needle' }, args: { scope: 'paragraph' }, code: 'DOCS_EXPORT_COUNT_MISMATCH',
    },
    {
      options: { paragraphs: ['same needle'], nativeTotals: { needle: 1, 'same needle': 2 } },
      args: { scope: 'paragraph' }, code: 'DOCS_EXPORT_COUNT_MISMATCH',
    },
  ]
  for (const item of cases) {
    const fake = fakeSelectDocs(item.options)
    await assert.rejects(runSelectDocs(fake, item.args), error => error.code === item.code)
    assert.equal(fake.events.includes('key:Escape:0'), false)
    assert.equal(fake.events.some(event => event === 'key:Enter:0' || event === 'key:Enter:8'), false)
    assert.equal(fake.state.findOpen, true)
    assert.equal(fake.snapshots(), 0)
  }
})

test('Docs select_text stops on a stale tab before filling the query', async () => {
  const fake = fakeSelectDocs({ staleAfter: 2 })
  await assert.rejects(runSelectDocs(fake), error => error.code === 'DOCS_STALE_TAB' && error.stage === 'find-query')
  assert.equal(fake.events.some(event => event.startsWith('setFind:')), false)
  assert.equal(fake.snapshots(), 0)
})

test('Docs select_text validates every argument before using the tab', async () => {
  const fake = fakeSelectDocs()
  const rejected = [
    [{ action: 'format' }, 'DOCS_BAD_DOCS_ACTION'],
    [{ text: ' ' }, 'DOCS_BAD_DOCS_TEXT'],
    [{ text: 'x'.repeat(1001) }, 'DOCS_BAD_DOCS_TEXT'],
    [{ occurrence: 'all' }, 'DOCS_BAD_DOCS_OCCURRENCE'],
    [{ occurrence: 0 }, 'DOCS_BAD_DOCS_OCCURRENCE'],
    [{ occurrence: -1 }, 'DOCS_BAD_DOCS_OCCURRENCE'],
    [{ occurrence: 1.5 }, 'DOCS_BAD_DOCS_OCCURRENCE'],
    [{ occurrence: '1' }, 'DOCS_BAD_DOCS_OCCURRENCE'],
    [{ scope: 'all' }, 'DOCS_BAD_DOCS_SCOPE'],
    [{ scope: 'paragraph', text: 'two\nlines' }, 'DOCS_BAD_DOCS_TEXT'],
    [{ surprise: true }, 'DOCS_BAD_DOCS_SELECT'],
  ]
  for (const [overrides, code] of rejected) {
    await assert.rejects(runSelectDocs(fake, overrides), error => error.code === code)
  }
  assert.equal(fake.events.length, 0)
  assert.equal(fake.snapshots(), 0)
})

const FORMAT_MANY_NORMAL = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  font: 'Arial',
  fontSize: 11,
  color: '#000000',
  highlight: 'none',
}
const FORMAT_MANY_MARKS = ['bold', 'italic', 'underline', 'strike', 'font', 'fontSize', 'color', 'highlight']
const formatManyRun = (text, marks = {}) => ({ text, ...FORMAT_MANY_NORMAL, ...marks })
const formatManyPara = (text, style = 'P', marks = {}) => ({
  kind: 'para', style, text, runs: text ? [formatManyRun(text, marks)] : [],
})
const formatManyEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const formatManyStyle = marks => [
  `font-weight:${marks.bold ? 700 : 400}`,
  `font-style:${marks.italic ? 'italic' : 'normal'}`,
  marks.underline ? 'text-decoration:underline' : marks.strike ? 'text-decoration:line-through' : 'text-decoration:none',
  `font-family:'${marks.font}'`,
  `font-size:${marks.fontSize}pt`,
  `color:${marks.color}`,
  `background-color:${marks.highlight === 'none' ? 'transparent' : marks.highlight}`,
].join(';')

function formatManyHtml(blocks) {
  const body = []
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]
    if (block.kind === 'pagebreak') {
      body.push('<hr style="page-break-before:always">')
      index += 1
      continue
    }
    if (block.kind === 'image') {
      body.push('<img src="image.png">')
      index += 1
      continue
    }
    if (block.kind === 'hr') {
      body.push('<hr>')
      index += 1
      continue
    }
    const spans = current => current.runs.map(run => `<span style="${formatManyStyle(run)}">${formatManyEscape(run.text).replaceAll('\n', '<br>')}</span>`).join('')
    if (block.style !== 'LI') {
      const tag = ['P', 'TITLE', 'SUBTITLE'].includes(block.style) ? 'p' : block.style.toLowerCase()
      const className = block.style === 'TITLE' ? ' class="title"' : block.style === 'SUBTITLE' ? ' class="subtitle"' : ''
      body.push(`<${tag}${className}>${spans(block)}</${tag}>`)
      index += 1
      continue
    }
    const ordered = block.ordered === true
    const checklist = block.checklist === true
    const start = block.number ?? 1
    const items = []
    while (index < blocks.length && blocks[index].style === 'LI'
      && (blocks[index].ordered === true) === ordered && (blocks[index].checklist === true) === checklist) {
      const current = blocks[index]
      const checkbox = checklist ? `<input type="checkbox"${current.checked ? ' checked="checked"' : ''}>` : ''
      items.push(`<li class="lst-test-${current.listLevel ?? 0}">${checkbox}${spans(current)}</li>`)
      index += 1
    }
    body.push(`<${ordered ? 'ol' : 'ul'}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
  }
  return `<html><body>${body.join('')}</body></html>`
}

function fakeFormatManyDocs(options = {}) {
  const initialBlocks = structuredClone(options.blocks ?? [formatManyPara('alpha'), formatManyPara('sentinel')])
  const baselineHtml = formatManyHtml(initialBlocks)
  const state = {
    blocks: structuredClone(initialBlocks),
    findOpen: false,
    findFocused: false,
    findValue: '',
    current: 0,
    selection: undefined,
    styleMenuOpen: false,
    requestedStyle: undefined,
    fontSizeFocused: false,
    fontSizeValue: '11',
    requestedFont: undefined,
    menuOpen: false,
    dialogOpen: false,
    searchValue: '',
    checked: false,
    colorTarget: 'color',
    colorMenuOpen: false,
    highlightMenuOpen: false,
    colorDialogOpen: false,
    hexFocused: false,
    hexValue: '',
  }
  const events = []
  const exports = []
  let snapshots = 0
  let tabAccess = 0
  let tabChecks = 0
  let collateralApplied = false
  let now = 1_000
  const tab = { id: 7, url: DOCS_URL }
  const matches = text => {
    const found = []
    const wanted = String(text).toLowerCase()
    if (!wanted) return found
    for (const [blockIndex, block] of state.blocks.entries()) {
      if (block.kind !== 'para') continue
      const source = block.text.toLowerCase()
      for (let start = source.indexOf(wanted); start >= 0; start = source.indexOf(wanted, start + wanted.length)) {
        found.push({ blockIndex, start, end: start + wanted.length })
      }
    }
    return found
  }
  const nativeTotal = () => options.nativeTotals?.[state.findValue] ?? matches(state.findValue).length
  const selectCurrent = () => {
    const currentMatches = matches(state.findValue)
    state.selection = currentMatches[state.current - 1]
  }
  const find = () => {
    const total = nativeTotal()
    return {
      ok: true,
      open: state.findOpen,
      enabled: true,
      focused: state.findOpen && state.findFocused,
      value: state.findValue,
      match: { current: total ? state.current : 0, total, text: `${total ? state.current : 0} of ${total}` },
    }
  }
  const selectedBlock = () => state.blocks[state.selection?.blockIndex]
  const selectedMarks = () => {
    const block = selectedBlock()
    if (!block || !state.selection) return FORMAT_MANY_NORMAL
    let offset = 0
    for (const run of block.runs) {
      if (state.selection.start >= offset && state.selection.start < offset + run.text.length) return run
      offset += run.text.length
    }
    return FORMAT_MANY_NORMAL
  }
  const styleName = code => ({ P: 'Normal text', TITLE: 'Title', SUBTITLE: 'Subtitle' })[code] ?? code?.replace(/^H/u, 'Heading ')
  const styleCode = name => ({ 'Normal text': 'P', Title: 'TITLE', Subtitle: 'SUBTITLE' })[name] ?? `H${name.slice(-1)}`
  const currentAttribute = attribute => {
    if (attribute === 'paragraph_style') return styleName(selectedBlock()?.style)
    if (attribute === 'font_size') return selectedMarks().fontSize
    return selectedMarks()[attribute]
  }
  const mutateSelection = (attribute, value) => {
    const block = selectedBlock()
    if (!block || !state.selection) throw new Error(`No selection for ${attribute}`)
    const field = attribute === 'font_size' ? 'fontSize' : attribute
    const characters = []
    for (const run of block.runs) {
      for (let offset = 0; offset < run.text.length; offset += 1) {
        characters.push({ text: run.text[offset], marks: Object.fromEntries(FORMAT_MANY_MARKS.map(key => [key, run[key]])) })
      }
    }
    for (let offset = state.selection.start; offset < state.selection.end; offset += 1) characters[offset].marks[field] = value
    const runs = []
    for (const character of characters) {
      const previous = runs.at(-1)
      if (previous && FORMAT_MANY_MARKS.every(key => previous[key] === character.marks[key])) previous.text += character.text
      else runs.push({ text: character.text, ...character.marks })
    }
    block.runs = runs
    events.push(`mutate:${attribute}:${String(value)}`)
    options.onMutate?.(attribute, value, state)
  }
  const io = {
    now: () => now,
    sleep: async ms => { now += ms },
    getWindowId: async () => { tabAccess += 1; return 1 },
    getActiveTab: async () => { tabAccess += 1; return { ...tab } },
    getTab: async () => {
      tabChecks += 1
      return options.staleAfter === tabChecks ? { ...tab, url: 'https://example.com/stale' } : { ...tab }
    },
    fetchExport: async () => {
      exports.push(exports.length === 0 ? 'baseline' : 'verify')
      events.push('export:html')
      if (options.exportError) throw options.exportError
      if (options.collateralOnVerify && exports.length > 1 && !collateralApplied) {
        collateralApplied = true
        const sentinel = state.blocks.find(block => block.text === 'sentinel')
        sentinel.runs = [formatManyRun('sentinel', { bold: true })]
      }
      if (exports.length > 1 && exports.length - 1 <= (options.staleVerifyReads ?? 0)) return baselineHtml
      return formatManyHtml(state.blocks)
    },
    withDebugger: async (_tabId, fn) => fn(),
    dispatchTrustedKey: async (_tabId, spec, mask) => {
      events.push(`key:${spec.key}:${mask}`)
      const key = spec.key.toLowerCase()
      if (key === 'f' && mask === 2) {
        state.findOpen = true
        state.findFocused = true
        state.findValue = ''
        state.current = 0
        state.selection = undefined
        return
      }
      if (spec.key === 'Escape') {
        state.findOpen = false
        state.findFocused = false
        return
      }
      if (spec.key === 'Enter' && state.findOpen) {
        const total = nativeTotal()
        state.current = mask === 8 ? (state.current - 2 + total) % total + 1 : state.current % total + 1
        selectCurrent()
        return
      }
      if (spec.key === 'Enter' && state.hexFocused) {
        mutateSelection(state.colorTarget, state.hexValue)
        state.hexFocused = false
        state.colorDialogOpen = false
        return
      }
      if (spec.key === 'Enter' && state.fontSizeFocused) {
        mutateSelection('font_size', Number(state.fontSizeValue))
        state.fontSizeFocused = false
        return
      }
      const toggle = { b: 'bold', i: 'italic', u: 'underline' }[key]
      if (mask === 2 && toggle) mutateSelection(toggle, !currentAttribute(toggle))
    },
    insertTrustedText: async (_tabId, text) => {
      if (state.hexFocused) {
        state.hexValue = text
        events.push(`hex:${text}`)
      } else if (state.fontSizeFocused) {
        state.fontSizeValue = text
        events.push(`insert:${text}`)
      }
    },
    trustedClick: async (_tabId, x) => {
      events.push(`click:${x}`)
      if (x === 1) state.menuOpen = true
      else if (x === 2) mutateSelection('font', state.requestedFont)
      else if (x === 3) state.dialogOpen = true
      else if (x === 4) state.checked = true
      else if (x === 5) state.dialogOpen = false
      else if (x === 6) state.dialogOpen = false
      else if (x === 10) state.colorMenuOpen = true
      else if (x === 11) state.highlightMenuOpen = true
      else if (x === 12) {
        state.colorDialogOpen = true
        state.colorMenuOpen = false
        state.highlightMenuOpen = false
      } else if (x === 13) {
        mutateSelection('highlight', 'none')
        state.highlightMenuOpen = false
      } else if (x === 14) state.hexFocused = true
      else if (x === 100) state.styleMenuOpen = true
      else if (x === 101) {
        selectedBlock().style = styleCode(state.requestedStyle)
        state.styleMenuOpen = false
        events.push(`mutate:paragraph_style:${state.requestedStyle}`)
      } else if (x === 102) state.fontSizeFocused = true
    },
    runInTab: async (_tabId, _func, [command, args]) => {
      events.push(`probe:${command}`)
      if (command === 'find') return find()
      if (command === 'setFind') {
        state.findValue = args.value
        const count = nativeTotal()
        state.current = count ? Math.min(options.initialCurrent ?? 1, count) : 0
        selectCurrent()
        events.push(`setFind:${args.value}`)
        return { ok: true, readback: true, value: state.findValue }
      }
      if (command === 'format') {
        const result = { ok: true }
        for (const attribute of args.attributes) {
          if (attribute === 'paragraph_style') Object.assign(result, {
            paragraphStyle: currentAttribute(attribute), paragraphStylePoint: { x: 100, y: 20 },
          })
          else if (attribute === 'font_size') Object.assign(result, {
            fontSize: currentAttribute(attribute),
            fontSizeValue: state.fontSizeValue,
            fontSizeFocused: state.fontSizeFocused,
            fontSizePoint: { x: 102, y: 20 },
          })
          else result[attribute] = currentAttribute(attribute)
        }
        return result
      }
      if (command === 'formatStyleMenu') {
        state.requestedStyle = args.style
        return { ok: true, open: state.styleMenuOpen, point: state.styleMenuOpen ? { x: 101, y: 20 } : undefined }
      }
      if (command === 'toolbar') return { ok: true, font: currentAttribute('font'), controlName: `Font list. ${currentAttribute('font')} selected.` }
      if (command === 'fontControl') return { ok: true, point: { x: 1, y: 20 } }
      if (command === 'fontMenu') {
        state.requestedFont = args.font
        const found = (options.installed ?? ['Arial', 'Syne', 'Roboto']).includes(args.font)
        return {
          ok: true,
          found,
          checked: found && currentAttribute('font') === args.font,
          point: found ? { x: 2, y: 20 } : undefined,
          moreFonts: { x: 3, y: 20 },
        }
      }
      if (command === 'setSearch') {
        state.searchValue = args.value
        return { ok: true, readback: true, value: state.searchValue }
      }
      if (command === 'fontDialog') {
        const found = (options.allFonts ?? options.installed ?? ['Arial', 'Syne', 'Roboto']).includes(args.font)
        return {
          ok: true,
          open: state.dialogOpen,
          searchEnabled: true,
          searchValue: state.searchValue,
          noFonts: state.searchValue === args.font && !found,
          signature: `${state.searchValue}:${found}:${state.checked}`,
          found,
          checked: found && state.checked,
          point: found ? { x: 4, y: 20 } : undefined,
          done: { x: 5, y: 20 },
          cancel: { x: 6, y: 20 },
        }
      }
      if (command === 'colorControl') {
        state.colorTarget = args.attribute
        return { ok: true, point: { x: args.attribute === 'color' ? 10 : 11, y: 20 } }
      }
      if (command === 'colorMenu') {
        const open = args.attribute === 'color' ? state.colorMenuOpen : state.highlightMenuOpen
        return {
          ok: true,
          open,
          customPoint: open ? { x: 12, y: 20 } : undefined,
          nonePoint: args.attribute === 'highlight' && open ? { x: 13, y: 20 } : undefined,
        }
      }
      if (command === 'colorDialog') return {
        ok: true,
        open: state.colorDialogOpen,
        enabled: true,
        focused: state.hexFocused,
        value: state.hexValue,
        point: { x: 14, y: 20 },
      }
      throw new Error(`unexpected probe ${command}`)
    },
    snapshot: async () => {
      snapshots += 1
      return { op: 'snapshot', view: 'full', fakeSnapshot: snapshots }
    },
  }
  return {
    io,
    state,
    events,
    exports,
    snapshots: () => snapshots,
    tabAccess: () => tabAccess,
    advanceNow: ms => { now += ms },
  }
}

const runFormatManyDocs = (fake, edits) => docsFormatMany({}, { action: 'format_many', edits }, fake.io)

test('Docs format_many applies eight attributes with one baseline, final export, and compact result', async () => {
  const fake = fakeFormatManyDocs({
    blocks: [
      formatManyPara('Alpha beta Alpha'),
      formatManyPara('Second range', 'P', { highlight: '#ffff00' }),
      formatManyPara('sentinel'),
    ],
  })
  const result = await runFormatManyDocs(fake, [
    {
      text: 'Alpha', occurrence: 'last', paragraph_style: 'Heading 2', font_size: 28,
      bold: true, italic: true, underline: true, font: ' Syne ', color: '#A1B2C3', highlight: '#FFFF00',
    },
    { text: 'Second range', color: '#a1b2c3', highlight: 'none' },
  ])
  assert.equal(result.docs.action, 'format_many')
  assert.equal(result.docs.status, 'completed', JSON.stringify(result.docs))
  assert.equal(result.docs.editCount, 2)
  assert.equal(result.docs.attemptedCount, 2)
  assert.equal(result.docs.verifiedCount, 2)
  assert.equal(result.docs.appliedCount, 2)
  assert.equal(result.docs.remainingCount, 0)
  assert.equal(result.docs.verifiedBy, 'export')
  assert.equal(result.op, 'docs')
  assert.equal(result.view, 'none')
  assert.equal(result.screenshotSkipped, true)
  assert.deepEqual(result.capture, { status: 'skipped', reason: 'DOCS_EXPORT_VERIFIED' })
  assert.equal(result.tab.id, 7)
  assert.equal(result.tab.url, DOCS_URL)
  assert.equal(result.fakeSnapshot, undefined)
  assert.deepEqual(result.docs.results.map(edit => [edit.occurrence, edit.status]), [[2, 'completed'], [1, 'completed']])
  assert.equal(result.docs.results[0].results.length, 8)
  assert.ok(result.docs.results.every(edit => edit.results.every(attribute => attribute.verifiedBy === 'export')))
  assert.equal(fake.state.blocks[0].style, 'H2')
  assert.equal(fake.state.blocks[0].runs[0].bold, false)
  assert.deepEqual(fake.state.blocks[0].runs.at(-1), formatManyRun('Alpha', {
    font: 'Syne', fontSize: 28, bold: true, italic: true, underline: true, color: '#a1b2c3', highlight: '#ffff00',
  }))
  assert.equal(fake.state.blocks[1].runs[0].color, '#a1b2c3')
  assert.equal(fake.state.blocks[1].runs[0].highlight, 'none')
  assert.equal(fake.state.blocks[2].runs[0].bold, false)
  assert.equal(fake.events.filter(event => event === 'hex:#a1b2c3').length, 2)
  assert.equal(fake.exports.length, 2)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format_many resolves first, nth, and last ordinal targets independently', async () => {
  const fake = fakeFormatManyDocs({ blocks: [formatManyPara('target target target')] })
  const result = await runFormatManyDocs(fake, [
    { text: 'target', occurrence: 'first', bold: true },
    { text: 'target', occurrence: 2, italic: true },
    { text: 'target', occurrence: 'last', underline: true },
  ])
  assert.equal(result.docs.status, 'completed', JSON.stringify(result.docs))
  assert.deepEqual(fake.state.blocks[0].runs.map(run => [run.text, run.bold, run.italic, run.underline]), [
    ['target', true, false, false], [' ', false, false, false],
    ['target', false, true, false], [' ', false, false, false],
    ['target', false, false, true],
  ])
  assert.deepEqual(result.docs.results.map(edit => edit.occurrence), [1, 2, 3])
  assert.equal(fake.events.filter(event => event === 'key:f:2').length, 3)
  assert.equal(fake.exports.length, 2)
})

test('Docs format_many keeps an all-already-applied batch on toolbar evidence without a final export', async () => {
  const fake = fakeFormatManyDocs({ blocks: [formatManyPara('alpha', 'P', { bold: true })] })
  const result = await runFormatManyDocs(fake, [{ text: 'alpha', bold: true }])
  assert.equal(result.docs.status, 'already_applied')
  assert.equal(result.docs.verifiedCount, 1)
  assert.equal(result.docs.appliedCount, 1)
  assert.equal(result.docs.alreadyAppliedCount, 1)
  assert.equal(result.docs.verifiedBy, 'toolbar')
  assert.deepEqual(result.docs.results[0].results, [{ attribute: 'bold', value: true, status: 'already_applied', verifiedBy: 'toolbar' }])
  assert.equal(fake.exports.length, 1)
  assert.equal(fake.events.some(event => event.startsWith('mutate:')), false)
  assert.equal(fake.snapshots(), 1)
})

test('Docs format_many rejects omitted-occurrence duplicates after baseline planning but before selection or mutation', async () => {
  const fake = fakeFormatManyDocs({ blocks: [formatManyPara('same same')] })
  await assert.rejects(runFormatManyDocs(fake, [{ text: 'same', bold: true }]), error => error.code === 'DOCS_FORMAT_MATCH_NOT_UNIQUE')
  assert.equal(fake.exports.length, 1)
  assert.equal(fake.events.some(event => event.startsWith('setFind:') || event.startsWith('mutate:')), false)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format_many validates every edit and normalizes before any tab access', async () => {
  const fake = fakeFormatManyDocs()
  const rejected = [
    [], null, Array.from({ length: 51 }, () => ({ text: 'x', bold: true })),
    [null], [{ text: ' ', bold: true }], [{ text: 'x'.repeat(1001), bold: true }],
    [{ text: 'x', occurrence: 0, bold: true }], [{ text: 'x', occurrence: 'all', bold: true }],
    [{ text: 'x', font_size: 0 }], [{ text: 'x', font_size: 401 }], [{ text: 'x', font_size: 1.5 }],
    [{ text: 'x', paragraph_style: 'Huge' }], [{ text: 'x', bold: 'yes' }],
    [{ text: 'x', font: ' ' }], [{ text: 'x', font: 'F'.repeat(101) }],
    [{ text: 'x', color: 'blue' }], [{ text: 'x', color: '#fff' }],
    [{ text: 'x', highlight: '#fff' }], [{ text: 'x', highlight: 'NONE' }],
    [{ text: 'x' }], [{ text: 'x', bold: true, surprise: true }],
    [{ text: 'alpha', bold: true }, { text: 'sentinel', color: 'invalid' }],
  ]
  for (const edits of rejected) await assert.rejects(runFormatManyDocs(fake, edits))
  assert.equal(fake.tabAccess(), 0)
  assert.equal(fake.exports.length, 0)
  assert.equal(fake.events.length, 0)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format_many stops at a missing font and reports prior attributes and unattempted edits', async () => {
  const fake = fakeFormatManyDocs({
    installed: ['Arial'], allFonts: ['Arial'],
    blocks: [formatManyPara('alpha'), formatManyPara('omega'), formatManyPara('sentinel')],
  })
  const result = await runFormatManyDocs(fake, [
    { text: 'alpha', bold: true, font: 'Missing Sans' },
    { text: 'omega', italic: true },
    { text: 'sentinel', underline: true },
  ])
  assert.equal(result.docs.status, 'partial', JSON.stringify(result.docs))
  assert.equal(result.docs.attemptedCount, 1)
  assert.equal(result.docs.verifiedCount, 0)
  assert.equal(result.docs.appliedCount, 0)
  assert.equal(result.docs.remainingCount, 2)
  assert.equal(result.docs.failure.attribute, 'font')
  assert.equal(result.docs.failure.code, 'DOCS_FONT_MISSING')
  assert.equal(result.docs.results[0].status, 'partial')
  assert.deepEqual(result.docs.results[0].results.map(attribute => [attribute.attribute, attribute.status]), [
    ['bold', 'applied'], ['font', 'font_missing'],
  ])
  assert.deepEqual(result.docs.results.slice(1).map(edit => [edit.status, edit.results[0].status]), [
    ['unattempted', 'unattempted'], ['unattempted', 'unattempted'],
  ])
  assert.equal(fake.state.blocks[0].runs[0].bold, true)
  assert.equal(fake.state.blocks[1].runs[0].italic, false)
  assert.equal(fake.events.filter(event => event === 'key:f:2').length, 1)
  assert.equal(fake.exports.length, 2)
  assert.equal(fake.snapshots(), 1)
})

test('Docs format_many waits for export convergence without repeating mutations or a final snapshot', async () => {
  const fake = fakeFormatManyDocs({ staleVerifyReads: 2 })
  const result = await runFormatManyDocs(fake, [{ text: 'alpha', bold: true }])
  assert.equal(result.docs.status, 'completed', JSON.stringify(result.docs))
  assert.equal(fake.exports.length, 4)
  assert.equal(fake.events.filter(event => event === 'mutate:bold:true').length, 1)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format_many bounds divergent export reads and never reformats during convergence', async () => {
  const fake = fakeFormatManyDocs({ staleVerifyReads: 99 })
  const result = await runFormatManyDocs(fake, [{ text: 'alpha', bold: true }])
  assert.equal(result.docs.status, 'partial')
  assert.equal(result.docs.verifiedCount, 0)
  assert.equal(result.docs.appliedCount, 0)
  assert.equal(result.docs.failure.code, 'DOCS_FORMAT_VERIFY_FAILED')
  assert.equal(result.docs.results[0].status, 'partial')
  assert.equal(fake.exports.length, 7)
  assert.equal(fake.events.filter(event => event === 'mutate:bold:true').length, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs format_many rejects collateral formatting on the first final export', async () => {
  const fake = fakeFormatManyDocs({ collateralOnVerify: true })
  const result = await runFormatManyDocs(fake, [{ text: 'alpha', bold: true }])
  assert.equal(result.docs.status, 'partial')
  assert.equal(result.docs.failure.index, -1)
  assert.equal(result.docs.failure.code, 'DOCS_FORMAT_COLLATERAL')
  assert.equal(result.docs.failure.attribute, 'bold')
  assert.equal(result.docs.verifiedCount, 0)
  assert.equal(result.docs.results[0].status, 'partial')
  assert.equal(fake.exports.length, 2)
  assert.equal(fake.snapshots(), 1)
})

test('Docs format_many compares native selection occurrence and count to the baseline plan', async () => {
  const fake = fakeFormatManyDocs({ nativeTotals: { alpha: 2 } })
  const result = await runFormatManyDocs(fake, [{ text: 'alpha', occurrence: 'first', bold: true }])
  assert.equal(result.docs.status, 'failed')
  assert.equal(result.docs.failure.code, 'DOCS_FORMAT_SELECTION_MISMATCH')
  assert.deepEqual(result.docs.failure.expected, { occurrence: 1, matchCount: 1 })
  assert.deepEqual(result.docs.failure.actual, { occurrence: 1, matchCount: 2 })
  assert.equal(result.docs.verifiedBy, 'toolbar')
  assert.equal(fake.events.some(event => event.startsWith('mutate:')), false)
  assert.equal(fake.exports.length, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs format_many formats an inline list target while preserving unrelated blocks', async () => {
  const list = { ...formatManyPara('List target', 'LI'), listLevel: 0, ordered: false }
  const fake = fakeFormatManyDocs({
    blocks: [{ kind: 'pagebreak' }, list, formatManyPara('before\nafter'), { kind: 'image' }, formatManyPara('')],
  })
  const result = await runFormatManyDocs(fake, [{ text: 'List target', bold: true }])
  assert.equal(result.docs.status, 'completed', JSON.stringify(result.docs))
  assert.equal(fake.state.blocks[1].runs[0].bold, true)
  assert.equal(fake.state.blocks[2].text, 'before\nafter')
  assert.equal(fake.state.blocks[2].runs[0].bold, false)
  assert.equal(fake.exports.length, 2)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format_many preserves changed-prefix evidence when a later edit goes stale', async () => {
  const fake = fakeFormatManyDocs({ staleAfter: 7 })
  await assert.rejects(runFormatManyDocs(fake, [
    { text: 'alpha', bold: true },
    { text: 'sentinel', italic: true },
  ]), error => error.code === 'DOCS_STALE_TAB'
    && error.formatMany?.attemptedCount === 2
    && error.formatMany.mutationPossible === true
    && error.formatMany.results[0].status === 'completed'
    && error.formatMany.results[1].status === 'unattempted'
    && error.message.includes('earlier prefix'))
  assert.equal(fake.state.blocks[0].runs[0].bold, true)
  assert.equal(fake.state.blocks[1].runs[0].italic, false)
  assert.equal(fake.exports.length, 1)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format_many serializes concurrent batches through the per-tab lock', async () => {
  const fake = fakeFormatManyDocs()
  const originalExport = fake.io.fetchExport
  let active = 0
  let maxActive = 0
  let calls = 0
  let releaseFirst
  let markFirstStarted
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve })
  const gate = new Promise(resolve => { releaseFirst = resolve })
  fake.io.fetchExport = async (...args) => {
    calls += 1
    active += 1
    maxActive = Math.max(maxActive, active)
    if (calls === 1) {
      markFirstStarted()
      await gate
    }
    try {
      return await originalExport(...args)
    } finally {
      active -= 1
    }
  }
  const first = runFormatManyDocs(fake, [{ text: 'alpha', bold: true }])
  await firstStarted
  const second = runFormatManyDocs(fake, [{ text: 'sentinel', italic: true }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  releaseFirst()
  const [left, right] = await Promise.all([first, second])
  assert.equal(left.docs.status, 'completed')
  assert.equal(right.docs.status, 'completed')
  assert.equal(maxActive, 1)
  assert.equal(calls, 4)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format_many rejects an expired queued batch before export, Find, or mutation', async () => {
  const first = fakeFormatManyDocs()
  const queued = fakeFormatManyDocs()
  const originalExport = first.io.fetchExport
  let releaseFirst
  let markFirstStarted
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve })
  const gate = new Promise(resolve => { releaseFirst = resolve })
  first.io.fetchExport = async (...args) => {
    markFirstStarted()
    await gate
    return originalExport(...args)
  }
  const active = runFormatManyDocs(first, [{ text: 'alpha', bold: true }])
  await firstStarted
  const waiting = runFormatManyDocs(queued, [{ text: 'sentinel', italic: true }])
  const rejected = assert.rejects(waiting, error => error.code === 'DOCS_DEADLINE'
    && error.message.includes('before acquiring the tab lock'))
  await new Promise(resolve => setImmediate(resolve))
  queued.advanceNow(600_001)
  releaseFirst()
  const result = await active
  assert.equal(result.docs.status, 'completed')
  await rejected
  assert.equal(queued.exports.length, 0)
  assert.equal(queued.events.some(event => event.startsWith('setFind:') || event.startsWith('mutate:')), false)
  assert.equal(queued.snapshots(), 0)
})

function captureFormatManyTimeouts(t) {
  const scheduled = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  })
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = { callback, ms, args, cleared: false, fired: false }
    scheduled.push(timer)
    return timer
  }
  globalThis.clearTimeout = timer => {
    if (timer) timer.cleared = true
  }
  return {
    fire(ms) {
      const timer = scheduled.find(candidate => candidate.ms === ms && !candidate.cleared && !candidate.fired)
      assert.ok(timer, `missing pending ${ms}ms timeout`)
      timer.fired = true
      timer.callback(...timer.args)
    },
  }
}

test('Docs format_many waits for an in-flight mutation to settle at the deadline', async t => {
  const timeouts = captureFormatManyTimeouts(t)
  const fake = fakeFormatManyDocs()
  const originalDispatch = fake.io.dispatchTrustedKey
  let releaseMutation
  let markMutationStarted
  let markMutationFinished
  const mutationStarted = new Promise(resolve => { markMutationStarted = resolve })
  const mutationFinished = new Promise(resolve => { markMutationFinished = resolve })
  const gate = new Promise(resolve => { releaseMutation = resolve })
  fake.io.dispatchTrustedKey = async (...args) => {
    if (args[1].key.toLowerCase() === 'b' && args[2] === 2) {
      markMutationStarted()
      await gate
      try {
        return await originalDispatch(...args)
      } finally {
        markMutationFinished()
      }
    }
    return originalDispatch(...args)
  }
  const pending = runFormatManyDocs(fake, [{ text: 'alpha', bold: true }])
  const rejected = assert.rejects(pending, error => error.code === 'DOCS_DEADLINE'
    && error.formatMany?.mutationPossible === true)
  await mutationStarted
  fake.advanceNow(600_000)
  timeouts.fire(600_000)
  releaseMutation()
  await mutationFinished
  await rejected
  assert.equal(fake.events.filter(event => event === 'mutate:bold:true').length, 1)
  assert.equal(fake.exports.length, 1)
  assert.equal(fake.snapshots(), 0)
})

test('Docs format_many reports DOCS_UNSETTLED and holds the lock until the in-flight flow finishes', async t => {
  const timeouts = captureFormatManyTimeouts(t)
  const fake = fakeFormatManyDocs()
  const originalDispatch = fake.io.dispatchTrustedKey
  let releaseMutation
  let markMutationStarted
  let markMutationFinished
  const mutationStarted = new Promise(resolve => { markMutationStarted = resolve })
  const mutationFinished = new Promise(resolve => { markMutationFinished = resolve })
  const gate = new Promise(resolve => { releaseMutation = resolve })
  fake.io.dispatchTrustedKey = async (...args) => {
    if (args[1].key.toLowerCase() === 'b' && args[2] === 2) {
      markMutationStarted()
      await gate
      try {
        return await originalDispatch(...args)
      } finally {
        markMutationFinished()
      }
    }
    return originalDispatch(...args)
  }
  const pending = runFormatManyDocs(fake, [{ text: 'alpha', bold: true }])
  const rejected = assert.rejects(pending, error => error.code === 'DOCS_UNSETTLED'
    && error.unsettled === true
    && error.doNotRetry === true
    && error.retryable === false
    && error.formatMany?.doNotRetry === true
    && /do not retry/u.test(error.message))
  await mutationStarted
  fake.advanceNow(600_000)
  timeouts.fire(600_000)
  await new Promise(resolve => setImmediate(resolve))
  timeouts.fire(250)
  await rejected
  assert.equal(fake.exports.length, 1)
  assert.equal(fake.snapshots(), 0)

  const queued = runFormatManyDocs(fake, [{ text: 'sentinel', italic: true }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fake.exports.length, 1)
  releaseMutation()
  await mutationFinished
  const result = await queued
  assert.equal(result.docs.status, 'completed')
  assert.equal(fake.state.blocks[0].runs[0].bold, true)
  assert.equal(fake.state.blocks[1].runs[0].italic, true)
  assert.equal(fake.exports.length, 3)
})
