import test from 'node:test'
import assert from 'node:assert/strict'
import { docsWrite } from '../sidepanel/browser.js'
import { parseDocStructure } from '../sidepanel/docs-structure.js'

const URL = 'https://docs.google.com/document/d/abc/edit'
const NORMAL = { font: 'Arial', fontSize: 11, bold: false, italic: false, underline: false, strike: false, color: '#000000', highlight: 'none' }
const para = (text, style = 'P', format = {}) => ({ kind: 'para', style, text, format: { ...NORMAL, ...format } })
const item = (text, ordered, number, format = {}, extra = {}) => ({ kind: 'para', style: 'LI', text, ordered, number, listLevel: 0, format: { ...NORMAL, ...format }, ...extra })
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const styleAttr = format => [
  `font-weight:${format.bold ? 700 : 400}`,
  `font-style:${format.italic ? 'italic' : 'normal'}`,
  format.underline ? 'text-decoration:underline' : format.strike ? 'text-decoration:line-through' : 'text-decoration:none',
  format.font ? `font-family:'${format.font}'` : '',
  format.fontSize ? `font-size:${format.fontSize}pt` : '',
  `color:${format.color ?? '#000000'}`,
  `background-color:${format.highlight && format.highlight !== 'none' ? format.highlight : 'transparent'}`,
].filter(Boolean).join(';')
const spans = block => (block.runsData ?? [{ text: block.text, format: block.format }])
  .map(run => `<span style="${styleAttr(run.format)}">${escapeHtml(run.text)}</span>`).join('')

function exportHtml(blocks) {
  const body = []
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]
    if (block.kind === 'pagebreak') {
      body.push('<hr style="page-break-before:always">')
      index += 1
      continue
    }
    if (block.style !== 'LI') {
      const tag = block.style === 'P' || block.style === 'TITLE' || block.style === 'SUBTITLE' ? 'p' : block.style.toLowerCase()
      const className = block.style === 'TITLE' ? ' class="title"' : block.style === 'SUBTITLE' ? ' class="subtitle"' : ''
      body.push(`<${tag}${className} style="${styleAttr(block.format)}">${spans(block)}</${tag}>`)
      index += 1
      continue
    }
    const ordered = block.ordered
    const checklist = block.checklist === true
    const start = block.number ?? 1
    const items = []
    while (index < blocks.length && blocks[index].style === 'LI' && blocks[index].ordered === ordered && (blocks[index].checklist === true) === checklist) {
      const current = blocks[index]
      const checkbox = checklist ? `<input type="checkbox"${current.checked ? ' checked="checked"' : ''}>` : ''
      items.push(`<li style="${styleAttr(current.format)}">${checkbox}${spans(current)}</li>`)
      index += 1
    }
    body.push(`<${ordered ? 'ol' : 'ul'}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
  }
  return `<html><body style="font-family:Arial;font-size:11pt">${body.join('')}</body></html>`
}

function fakeWrite(options = {}) {
  const state = {
    blocks: structuredClone(options.blocks ?? [para('Sentinel')]),
    paragraphStyle: 'Normal text',
    font: 'Arial',
    fontSize: 11,
    fontSizeValue: '11',
    fontSizeFocused: false,
    documentFocused: false,
    bold: false,
    italic: false,
    underline: false,
    color: '#000000',
    highlight: 'none',
    colorTarget: 'color',
    colorMenuOpen: false,
    highlightMenuOpen: false,
    colorDialogOpen: false,
    hexFocused: false,
    hexValue: '',
    numbered: false,
    bulleted: false,
    checklist: false,
    listMode: undefined,
    controlsRevealed: false,
    styleMenuOpen: false,
    dialogOpen: false,
    searchValue: '',
    requestedStyle: undefined,
    requestedFont: undefined,
  }
  const initialLast = state.blocks.at(-1)
  if (initialLast?.format) {
    state.color = initialLast.format.color ?? state.color
    state.highlight = initialLast.format.highlight ?? state.highlight
  }
  if (initialLast?.style === 'LI') {
    state.listMode = initialLast.ordered ? 'numbered' : initialLast.checklist ? 'checklist' : 'bulleted'
    state.numbered = initialLast.ordered
    state.bulleted = !initialLast.ordered && !initialLast.checklist
    state.checklist = initialLast.checklist === true
  }
  const events = []
  const exports = []
  let snapshots = 0
  let now = 1000
  let tabChecks = 0
  const tab = { id: 7, url: URL }
  const currentFormat = () => ({
    font: state.font,
    fontSize: state.fontSize,
    bold: state.bold,
    italic: state.italic,
    underline: state.underline,
    strike: false,
    color: state.color,
    highlight: state.highlight,
  })
  const io = {
    now: () => now,
    sleep: async ms => { now += ms },
    getWindowId: async () => 1,
    getActiveTab: async () => ({ ...tab }),
    getTab: async () => {
      tabChecks += 1
      return options.staleAfter === tabChecks ? { ...tab, url: 'https://example.com/stale' } : { ...tab }
    },
    withDebugger: async (_tabId, fn) => fn(),
    fetchExport: async () => {
      exports.push(state.blocks.map(block => `${block.style}:${block.text}`))
      if (options.exportError) throw options.exportError
      if (options.mutatePrefixOnVerify && exports.length > 2) state.blocks[0].text = 'Changed sentinel'
      const stale = options.staleVerifyReads && exports.length > 2 && exports.length - 2 <= options.staleVerifyReads
      return { body: exportHtml(stale ? (options.blocks ?? [para('Sentinel')]) : state.blocks) }
    },
    dispatchTrustedKey: async (_tabId, spec, mask) => {
      events.push(`key:${spec.key}:${mask}`)
      if (options.mutatePrefix && spec.key === 'End') state.blocks[0].text = 'Changed sentinel'
      if (spec.key === 'End' && mask === 2) return
      if (state.hexFocused && spec.key.toLowerCase() === 'a' && mask === 2) return
      if (spec.key === 'Enter' && state.hexFocused) {
        state[state.colorTarget] = state.hexValue
        state.hexFocused = false
        state.colorDialogOpen = false
        return
      }
      if (state.fontSizeFocused && spec.key.toLowerCase() === 'a' && mask === 2) return
      if (spec.key === 'Enter' && state.fontSizeFocused) {
        state.fontSize = Number(state.fontSizeValue)
        state.fontSizeFocused = false
        return
      }
      const toggle = { b: 'bold', i: 'italic', u: 'underline' }[spec.key.toLowerCase()]
      if (mask === 2 && toggle) {
        state[toggle] = !state[toggle]
        return
      }
      if (spec.key === 'Enter' && mask === 2) {
        state.blocks.push({ kind: 'pagebreak' })
        state.blocks.push(para('', state.paragraphStyle === 'Normal text' ? 'P' : state.paragraphStyle === 'Title' ? 'TITLE' : state.paragraphStyle === 'Subtitle' ? 'SUBTITLE' : `H${state.paragraphStyle.slice(-1)}`, currentFormat()))
        return
      }
      if (['7', '8', '9'].includes(spec.key) && mask === 10) {
        const kind = { 7: 'numbered', 8: 'bulleted', 9: 'checklist' }[spec.key]
        if (options[`${kind}StartFails`] !== true) {
          state.listMode = kind
          state.numbered = kind === 'numbered'
          state.bulleted = kind === 'bulleted'
          state.checklist = kind === 'checklist'
        }
        return
      }
      if (spec.key === 'Enter' && mask === 10 && state.listMode === 'checklist') {
        const last = state.blocks.at(-1)
        if (last?.style === 'LI') last.checked = !last.checked
        return
      }
      if (options.enterFails && spec.key === 'Enter') return
      if (spec.key === 'Enter') {
        const last = state.blocks.at(-1)
        if (state.listMode && last?.style === 'LI' && !last.text) {
          state.blocks[state.blocks.length - 1] = para('', 'P', currentFormat())
          state.listMode = undefined
          state.numbered = false
          state.bulleted = false
          state.checklist = false
        } else if (state.listMode) {
          const number = state.listMode === 'numbered' ? (last?.number ?? 0) + 1 : undefined
          state.blocks.push(item('', state.listMode === 'numbered', number, currentFormat(), state.listMode === 'checklist' ? { checklist: true, checked: false } : {}))
        } else state.blocks.push(para('', state.paragraphStyle === 'Normal text' ? 'P' : state.paragraphStyle === 'Title' ? 'TITLE' : state.paragraphStyle === 'Subtitle' ? 'SUBTITLE' : `H${state.paragraphStyle.slice(-1)}`, currentFormat()))
      }
    },
    insertTrustedText: async (_tabId, text) => {
      if (state.hexFocused) {
        state.hexValue = text
        events.push(`hex:${text}`)
        return
      }
      if (state.fontSizeFocused) {
        state.fontSizeValue = text
        events.push(`size:${text}`)
        return
      }
      events.push(`insert:${text}`)
      if (options.dropText) return
      if (state.listMode) {
        const items = text.split('\n')
        const last = state.blocks.at(-1)
        if (last?.style === 'P' && !last.text) state.blocks.pop()
        else if (last?.style === 'LI' && !last.text) state.blocks.pop()
        for (const value of items) {
          const number = state.listMode === 'numbered' ? state.blocks.filter(block => block.style === 'LI' && block.ordered).length + 1 : undefined
          state.blocks.push(item(value, state.listMode === 'numbered', number, currentFormat(), state.listMode === 'checklist' ? { checklist: true, checked: false } : {}))
        }
        return
      }
      const format = currentFormat()
      if (options.wrongInlineFont === text) format.font = '__wrong__'
      const last = state.blocks.at(-1)
      if (last?.style === 'P' && !last.text) {
        last.text = text
        last.style = state.paragraphStyle === 'Normal text' ? 'P' : state.paragraphStyle === 'Title' ? 'TITLE' : state.paragraphStyle === 'Subtitle' ? 'SUBTITLE' : `H${state.paragraphStyle.slice(-1)}`
        last.format = format
        last.runsData = [{ text, format }]
      } else if (last) {
        last.runsData ??= [{ text: last.text, format: last.format }]
        last.text += text
        last.format = format
        last.runsData.push({ text, format })
      }
    },
    trustedClick: async (_tabId, x) => {
      events.push(`click:${x}`)
      if (x === 100) state.styleMenuOpen = true
      else if (x === 101) {
        state.paragraphStyle = state.requestedStyle
        const last = state.blocks.at(-1)
        if (last?.style !== 'LI' && !last?.text) {
          last.style = state.paragraphStyle === 'Normal text' ? 'P' : state.paragraphStyle === 'Title' ? 'TITLE' : state.paragraphStyle === 'Subtitle' ? 'SUBTITLE' : `H${state.paragraphStyle.slice(-1)}`
        }
        state.styleMenuOpen = false
      } else if (x === 102) state.fontSizeFocused = options.sizeFocusFails !== true
      else if (x === 1) state.menuOpen = true
      else if (x === 2) state.font = state.requestedFont
      else if (x === 3) state.dialogOpen = true
      else if (x === 6) state.dialogOpen = false
      else if (x === 10) state.colorMenuOpen = true
      else if (x === 11) state.highlightMenuOpen = true
      else if (x === 12) {
        state.colorDialogOpen = true
        state.colorMenuOpen = false
        state.highlightMenuOpen = false
      } else if (x === 13) {
        state.highlight = 'none'
        state.highlightMenuOpen = false
      } else if (x === 14) state.hexFocused = true
      else if (x === 15) state.controlsRevealed = true
    },
    runInTab: async (_tabId, _func, [command, args]) => {
      events.push(`probe:${command}`)
      if (command === 'format') {
        if (options.listControlsHidden && !state.controlsRevealed && args.attributes.some(attribute => ['numbered', 'bulleted', 'checklist'].includes(attribute))) {
          return { ok: true, revealPoint: { x: 15, y: 20 } }
        }
        const result = { ok: true }
        for (const attribute of args.attributes) {
          if (attribute === 'paragraph_style') Object.assign(result, { paragraphStyle: state.paragraphStyle, paragraphStylePoint: { x: 100, y: 20 } })
          else if (attribute === 'font_size') Object.assign(result, {
            fontSize: state.fontSize,
            fontSizeValue: state.fontSizeValue,
            fontSizeFocused: state.fontSizeFocused,
            fontSizePoint: { x: 102, y: 20 },
          })
          else if (attribute === 'font') result.font = state.font
          else result[attribute] = state[attribute]
        }
        return result
      }
      if (command === 'formatStyleMenu') {
        state.requestedStyle = args.style
        return { ok: true, open: state.styleMenuOpen, point: state.styleMenuOpen ? { x: 101, y: 20 } : undefined }
      }
      if (command === 'toolbar') return { ok: true, font: state.font, controlName: `Font list. ${state.font} selected.` }
      if (command === 'fontControl') return { ok: true, point: { x: 1, y: 20 } }
      if (command === 'fontMenu') {
        state.requestedFont = args.font
        const found = (options.installed ?? ['Arial', 'Roboto', 'Playfair Display']).includes(args.font)
        return { ok: true, found, checked: found && state.font === args.font, point: found ? { x: 2, y: 20 } : undefined, moreFonts: { x: 3, y: 20 } }
      }
      if (command === 'setSearch') {
        state.searchValue = args.value
        return { ok: true, readback: true, value: state.searchValue }
      }
      if (command === 'fontDialog') {
        const found = (options.allFonts ?? options.installed ?? ['Arial', 'Roboto', 'Playfair Display']).includes(args.font)
        return {
          ok: true,
          open: state.dialogOpen,
          searchEnabled: true,
          searchValue: state.searchValue,
          noFonts: state.searchValue === args.font && !found,
          signature: `${state.searchValue}:${found}`,
          found,
          checked: false,
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
      if (command === 'colorDialog') {
        return {
          ok: true,
          open: state.colorDialogOpen,
          enabled: true,
          focused: state.hexFocused,
          value: state.hexValue,
          point: { x: 14, y: 20 },
        }
      }
      if (command === 'documentContent') return { ok: true, present: true, focused: state.documentFocused }
      if (command === 'focusDocument') {
        state.documentFocused = true
        return { ok: true, focused: state.documentFocused }
      }
      throw new Error(`unexpected probe ${command}`)
    },
    snapshot: async () => {
      snapshots += 1
      return { op: 'snapshot', view: 'full' }
    },
  }
  return { io, state, events, exports, snapshots: () => snapshots }
}

const runWrite = (fake, blocks) => docsWrite({}, { action: 'write', blocks }, fake.io)

test('Docs write composes formatted paragraphs, blank space, and adjacent lists with export verification', async () => {
  const fake = fakeWrite()
  const result = await runWrite(fake, [
    { text: 'Release heading', paragraph_style: 'Title', font: 'Playfair Display', font_size: 28, bold: true },
    { blank: true },
    { items: ['first', 'second', 'third'], list: 'numbered', font: 'Roboto' },
    { items: ['alpha', 'beta'], list: 'bulleted' },
    { text: 'Closing', italic: true },
  ])
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.blockCount, 5)
  assert.equal(result.docs.verifiedCount, 5)
  assert.equal(result.docs.attemptedCount, 5)
  assert.equal(result.docs.verifiedBy, 'export')
  assert.match(result.docs.outline, /TITLE: \*\*Release heading\*\*/)
  assert.match(result.docs.outline, /1\. first/)
  assert.match(result.docs.outline, /• alpha/)
  assert.equal(fake.state.blocks[0].text, 'Sentinel')
  assert.equal(fake.state.blocks[1].style, 'TITLE')
  assert.equal(fake.state.blocks[1].format.font, 'Playfair Display')
  assert.equal(fake.state.blocks[2].text, '')
  assert.deepEqual(fake.state.blocks.slice(3, 6).map(block => [block.text, block.number]), [['first', 1], ['second', 2], ['third', 3]])
  assert.deepEqual(fake.state.blocks.slice(6, 8).map(block => [block.text, block.ordered]), [['alpha', false], ['beta', false]])
  assert.equal(fake.state.blocks.some(block => block.style === 'LI' && !block.text), false)
  assert.equal(fake.state.blocks.at(-1).format.font, 'Arial')
  assert.equal(fake.state.blocks.at(-1).format.italic, true)
  const numbered = fake.events.indexOf('key:7:10')
  const numberedItems = fake.events.indexOf('insert:first\nsecond\nthird')
  const bulleted = fake.events.indexOf('key:8:10')
  const bulletedItems = fake.events.indexOf('insert:alpha\nbeta')
  assert.ok(numbered >= 0 && numbered < numberedItems && numberedItems < bulleted && bulleted < bulletedItems)
  assert.equal(fake.exports.length, 3)
  assert.equal(fake.snapshots(), 1)
  assert.equal(fake.events.some(event => event.startsWith('hex:')), false)
})

test('Docs write reveals collapsed list controls for pressed-state verification', async () => {
  const fake = fakeWrite({ listControlsHidden: true })
  const result = await runWrite(fake, [{ items: ['first', 'second'], list: 'numbered' }])
  assert.equal(result.docs.status, 'completed', JSON.stringify(result.docs))
  assert.ok(fake.events.indexOf('key:7:10') < fake.events.indexOf('click:15'))
  assert.ok(fake.events.indexOf('click:15') < fake.events.indexOf('insert:first\nsecond'))
  assert.deepEqual(fake.state.blocks.slice(1, 3).map(block => [block.text, block.number]), [['first', 1], ['second', 2]])
})

test('Docs write inserts a page break and verifies checked checklist items', async () => {
  const fake = fakeWrite()
  const result = await runWrite(fake, [
    { text: 'Intro' },
    { page_break: true },
    { text: 'Section One', paragraph_style: 'Heading 1' },
    { items: [{ text: 'Completed task', checked: true }, 'Pending task'], list: 'checklist' },
    { text: 'After' },
  ])
  assert.equal(result.docs.status, 'completed', JSON.stringify(result.docs))
  assert.equal(result.docs.blockCount, 5)
  assert.equal(result.docs.verifiedCount, 5)
  assert.deepEqual(fake.state.blocks.map(block => [block.kind, block.style, block.text]), [
    ['para', 'P', 'Sentinel'],
    ['para', 'P', 'Intro'],
    ['pagebreak', undefined, undefined],
    ['para', 'H1', 'Section One'],
    ['para', 'LI', 'Completed task'],
    ['para', 'LI', 'Pending task'],
    ['para', 'P', 'After'],
  ])
  assert.equal(fake.state.blocks[4].checklist, true)
  assert.equal(fake.state.blocks[4].checked, true)
  assert.equal(fake.state.blocks[5].checklist, true)
  assert.equal(fake.state.blocks[5].checked, false)
  assert.match(result.docs.outline, /═══ page break ═══/)
  assert.match(result.docs.outline, /☑ Completed task/)
  assert.match(result.docs.outline, /☐ Pending task/)
  assert.ok(fake.events.indexOf('key:Enter:2') < fake.events.indexOf('key:9:10'))
  assert.ok(fake.events.indexOf('insert:Completed task') < fake.events.indexOf('key:Enter:10'))
  assert.ok(fake.events.indexOf('key:Enter:10') < fake.events.indexOf('insert:Pending task'))
  assert.equal(fake.events.filter(event => event === 'insert:Completed task').length, 1)
  assert.equal(fake.exports.length, 3)
  assert.equal(fake.snapshots(), 1)
})

test('Docs write resets non-default baseline colors only when needed', async () => {
  const fake = fakeWrite({ blocks: [para('Sentinel', 'P', { color: '#ff0000', highlight: '#ffff00' })] })
  const result = await runWrite(fake, [{ text: 'After' }])
  assert.equal(result.docs.status, 'completed')
  assert.ok(fake.events.indexOf('hex:#000000') < fake.events.indexOf('insert:After'))
  assert.ok(fake.events.indexOf('click:13') < fake.events.indexOf('insert:After'))
  assert.equal(fake.state.blocks[1].format.color, '#000000')
  assert.equal(fake.state.blocks[1].format.highlight, 'none')
})

test('Docs write styles mixed inline runs before insertion and verifies exact run boundaries', async () => {
  const fake = fakeWrite({ installed: ['Arial', 'Roboto', 'Playfair Display', 'Merriweather'] })
  const result = await runWrite(fake, [{
    runs: [
      { text: 'Welcome ', font: 'Roboto', font_size: 11, bold: true, color: '#0000FF' },
      { text: 'quick ', font: 'Roboto', font_size: 11, bold: false, highlight: '#FFFF00' },
      { text: 'tour', font: 'Merriweather', font_size: 11, italic: true, color: '#000000', highlight: 'none' },
    ],
  }])
  assert.equal(result.docs.status, 'completed', JSON.stringify({ failure: result.docs.failure, runs: parseDocStructure(exportHtml(fake.state.blocks))[1].runs }))
  assert.equal(result.docs.verifiedCount, 1)
  const paragraph = fake.state.blocks[1]
  assert.equal(paragraph.text, 'Welcome quick tour')
  assert.deepEqual(paragraph.runsData.map(run => ({
    text: run.text,
    font: run.format.font,
    bold: run.format.bold,
    italic: run.format.italic,
    color: run.format.color,
    highlight: run.format.highlight,
  })), [
    { text: 'Welcome ', font: 'Roboto', bold: true, italic: false, color: '#0000ff', highlight: 'none' },
    { text: 'quick ', font: 'Roboto', bold: false, italic: false, color: '#000000', highlight: '#ffff00' },
    { text: 'tour', font: 'Merriweather', bold: false, italic: true, color: '#000000', highlight: 'none' },
  ])
  assert.ok(fake.events.indexOf('hex:#0000FF') < fake.events.indexOf('insert:Welcome '))
  assert.ok(fake.events.indexOf('hex:#FFFF00') < fake.events.indexOf('insert:quick '))
  assert.ok(fake.events.lastIndexOf('hex:#000000') < fake.events.indexOf('insert:tour'))
  assert.equal(fake.events.filter(event => event === 'key:b:2').length, 2)
  assert.equal(fake.events.filter(event => event === 'click:2').length, 2)
  assert.equal(fake.events.some(event => event === 'probe:find' || event === 'probe:setFind'), false)
  assert.equal(fake.exports.length, 3)
  assert.equal(fake.snapshots(), 1)
})

test('Docs write rejects a wrong exported inline run instead of claiming success', async () => {
  const fake = fakeWrite({ wrongInlineFont: 'tour', installed: ['Arial', 'Merriweather'] })
  const result = await runWrite(fake, [{ runs: [{ text: 'tour', font: 'Merriweather' }] }])
  assert.equal(result.docs.status, 'failed')
  assert.equal(result.docs.failure.code, 'DOCS_WRITE_VERIFY_FAILED')
  assert.equal(fake.events.filter(event => event === 'insert:tour').length, 1)
  assert.equal(fake.exports.length, 8)
  assert.equal(fake.snapshots(), 1)
})

test('Docs write reuses a fresh document empty paragraph without a stray leading blank', async () => {
  const fake = fakeWrite({ blocks: [para('')] })
  const result = await runWrite(fake, [{ text: 'First' }, { text: 'Second' }])
  assert.equal(result.docs.status, 'completed')
  assert.deepEqual(fake.state.blocks.map(block => block.text), ['First', 'Second'])
  const first = fake.events.indexOf('insert:First')
  const second = fake.events.indexOf('insert:Second')
  assert.equal(fake.events.slice(first, second).filter(event => event === 'key:Enter:0').length, 1)
})

test('Docs write exits a preexisting list before appending and preserves it', async () => {
  const fake = fakeWrite({ blocks: [item('existing', true, 1)] })
  const result = await runWrite(fake, [{ text: 'After list' }])
  assert.equal(result.docs.status, 'completed')
  assert.equal(fake.state.blocks[0].text, 'existing')
  assert.equal(fake.state.blocks[0].ordered, true)
  assert.equal(fake.state.blocks[1].text, 'After list')
  assert.ok(fake.events.indexOf('key:Enter:0') < fake.events.indexOf('insert:After list'))
  assert.equal(fake.state.blocks.some(block => block.style === 'LI' && !block.text), false)
})

test('Docs write validates every block before any tab or export access', async () => {
  const fake = fakeWrite()
  const rejected = [
    [], null, [{ text: 'x', items: ['y'], list: 'bulleted' }], [{ text: 'two\nlines' }],
    [{ items: [], list: 'numbered' }], [{ items: [' '], list: 'numbered' }],
    [{ items: ['x'], list: 'numbered', paragraph_style: 'Title' }],
    [{ blank: true, bold: true }], [{ text: 'x', font_size: 0 }],
    [{ runs: [] }], [{ runs: [{ text: 'x', paragraph_style: 'Title' }] }],
    [{ runs: [{ text: 'x', color: 'blue' }] }], [{ runs: [{ text: 'x', highlight: '#fff' }] }],
    [{ runs: [{ text: 'x\ny' }] }], [{ runs: [{ text: 'x' }], items: ['y'], list: 'bulleted' }],
    [{ page_break: true, text: 'x' }], [{ page_break: false }], [{ blank: true, page_break: true }],
    [{ items: [{ text: 'x', checked: 'yes' }], list: 'checklist' }],
    [{ items: [{ text: 'x', checked: true }], list: 'numbered' }],
    [{ text: 'x'.repeat(20_001) }],
  ]
  for (const blocks of rejected) await assert.rejects(runWrite(fake, blocks))
  assert.equal(fake.events.length, 0)
  assert.equal(fake.exports.length, 0)
  assert.equal(fake.snapshots(), 0)
})

test('Docs write waits for export convergence without retyping or extra snapshots', async () => {
  const fake = fakeWrite({ staleVerifyReads: 2 })
  const result = await runWrite(fake, [{ text: 'Converged' }])
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.verifiedCount, 1)
  assert.equal(fake.exports.length, 5)
  assert.equal(fake.events.filter(event => event === 'insert:Converged').length, 1)
  assert.equal(fake.snapshots(), 1)
})

test('Docs write bounds verification reads and never retries missing input', async () => {
  const fake = fakeWrite({ dropText: true })
  const result = await runWrite(fake, [{ text: 'Must land once' }])
  assert.equal(result.docs.status, 'failed')
  assert.equal(result.docs.verifiedCount, 0)
  assert.equal(result.docs.failure.code, 'DOCS_WRITE_VERIFY_FAILED')
  assert.equal(fake.events.filter(event => event === 'insert:Must land once').length, 1)
  assert.equal(fake.exports.length, 8)
  assert.equal(fake.snapshots(), 1)
})

test('Docs write stops before formatting when document end is not established', async () => {
  for (const options of [{ mutatePrefix: true }, { enterFails: true }]) {
    const fake = fakeWrite(options)
    await assert.rejects(runWrite(fake, [{ text: 'New content' }]), error => error.code === 'DOCS_WRITE_POSITION')
    assert.equal(fake.events.some(event => event.startsWith('insert:')), false)
    assert.equal(fake.exports.length, 2)
    assert.equal(fake.snapshots(), 0)
  }
})

test('Docs write rejects collateral changes during final verification', async () => {
  const fake = fakeWrite({ mutatePrefixOnVerify: true })
  const result = await runWrite(fake, [{ text: 'New content' }])
  assert.equal(result.docs.status, 'failed')
  assert.equal(result.docs.failure.index, -1)
  assert.equal(result.docs.failure.code, 'DOCS_WRITE_COLLATERAL')
  assert.equal(fake.exports.length, 3)
  assert.equal(fake.snapshots(), 1)
})

test('Docs write never inserts items when list mode does not become active', async () => {
  const fake = fakeWrite({ numberedStartFails: true })
  await assert.rejects(runWrite(fake, [{ items: ['one', 'two'], list: 'numbered' }]), error => (
    error.code === 'DOCS_FORMAT_MISMATCH' && error.stage === 'write-list-start-verify' && error.message.includes('use browser_docs_read')
  ))
  assert.equal(fake.events.some(event => event.startsWith('insert:')), false)
  assert.equal(fake.snapshots(), 0)
})

test('Docs write stops before typing a block with an unavailable font', async () => {
  const fake = fakeWrite({ installed: ['Arial'], allFonts: ['Arial'] })
  await assert.rejects(runWrite(fake, [{ text: 'Do not type', font: 'Missing Sans' }]), error => error.code === 'DOCS_FONT_MISSING')
  assert.equal(fake.events.some(event => event.startsWith('insert:')), false)
  assert.equal(fake.state.blocks[0].text, 'Sentinel')
  assert.equal(fake.snapshots(), 0)
})

test('Docs write refuses to mutate when the baseline export is unavailable', async () => {
  const error = new Error('forbidden')
  error.code = 'DOCS_EXPORT_PERMISSION'
  const fake = fakeWrite({ exportError: error })
  await assert.rejects(runWrite(fake, [{ text: 'Not typed' }]), error => error.code === 'DOCS_EXPORT_PERMISSION')
  assert.equal(fake.events.some(event => event.startsWith('key:') || event.startsWith('insert:')), false)
  assert.equal(fake.snapshots(), 0)
})
