import test from 'node:test'
import assert from 'node:assert/strict'
import { docsTable } from '../sidepanel/browser.js'
import { planDocsFormatEdits, verifyDocsFormatEdits } from '../sidepanel/docs-format.js'
import { parseDocStructure } from '../sidepanel/docs-structure.js'
import {
  docsTableCreateHtml,
  docsTableFindPlan,
  docsTableFormatEdits,
  docsTableNavigationPlan,
  docsParagraphEntries,
  parseDocsTableArgs,
  planDocsTableWrite,
  selectDocsTable,
  verifyDocsTableStructure,
} from '../sidepanel/docs-table.js'

const URL = 'https://docs.google.com/document/d/abc/edit'
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const para = (text = '') => ({ kind: 'para', style: 'P', text, marked: text, runs: text ? [{ text, bold: false, italic: false, underline: false, strike: false, color: '#000000', highlight: 'none' }] : [] })
const cell = (text = '') => ({ text, paragraphs: [para(text)], rowspan: 1, colspan: 1 })
const table = (values, index = 1) => ({ kind: 'table', index, rows: values.map(row => row.map(cell)) })

function exportHtml(blocks) {
  const runHtml = run => `<span style="font-weight:${run.bold ? 700 : 400};font-style:${run.italic ? 'italic' : 'normal'};text-decoration:${run.underline ? 'underline' : 'none'};color:${run.color ?? '#000000'};background-color:${run.highlight && run.highlight !== 'none' ? run.highlight : 'transparent'}">${escapeHtml(run.text)}</span>`
  const paragraphHtml = block => `<p>${block.runs.map(runHtml).join('')}</p>`
  return `<html><body>${blocks.map(block => {
    if (block.kind === 'para') return paragraphHtml(block)
    if (block.kind === 'table') return `<table>${block.rows.map(row => `<tr>${row.map(item => `<td${item.rowspan > 1 ? ` rowspan="${item.rowspan}"` : ''}${item.colspan > 1 ? ` colspan="${item.colspan}"` : ''}>${item.paragraphs.map(paragraphHtml).join('')}</td>`).join('')}</tr>`).join('')}</table>`
    return ''
  }).join('')}</body></html>`
}

function positions(source, text) {
  const folded = source.toLowerCase()
  const wanted = text.toLowerCase()
  if (!wanted) return []
  const found = []
  for (let index = folded.indexOf(wanted); index >= 0; index = folded.indexOf(wanted, index + wanted.length)) found.push(index)
  return found
}

function fakeDocs(initialBlocks = [para()]) {
  const state = {
    blocks: structuredClone(initialBlocks),
    findOpen: false,
    findValue: '',
    findCurrent: 0,
    selection: undefined,
    currentCell: undefined,
    menuOpen: false,
    menuQuery: '',
    clipboardHtml: undefined,
    restored: 0,
    inserts: 0,
    clicks: [],
  }
  const tab = { id: 7, url: URL }
  let now = 1000
  const entries = () => docsParagraphEntries(state.blocks)
  const matches = () => {
    const all = entries()
    const source = all.map(entry => entry.block.text).join('\n')
    return positions(source, state.findValue).map(start => ({ entry: all.find(item => start >= item.start && start + state.findValue.length <= item.start + item.block.text.length), start }))
  }
  const selectCurrent = () => {
    const match = matches()[state.findCurrent - 1]
    if (!match?.entry) return
    state.selection = { entry: match.entry, start: match.start - match.entry.start, end: match.start - match.entry.start + state.findValue.length }
    if (match.entry.tableIndex !== undefined) {
      state.currentCell = { tableIndex: match.entry.tableIndex, rowIndex: match.entry.rowIndex, columnIndex: match.entry.columnIndex }
    }
  }
  const selectedParagraph = () => state.selection?.entry.block
  const applyBold = () => {
    const block = selectedParagraph()
    if (!block) return
    const start = state.selection.start
    const end = state.selection.end
    let offset = 0
    const runs = []
    for (const run of block.runs) {
      const runStart = offset
      const runEnd = offset + run.text.length
      offset = runEnd
      const segments = []
      if (runStart < start) segments.push({ text: run.text.slice(0, start - runStart), bold: run.bold })
      const middleStart = Math.max(start, runStart)
      const middleEnd = Math.min(end, runEnd)
      if (middleStart < middleEnd) segments.push({ text: run.text.slice(middleStart - runStart, middleEnd - runStart), bold: !run.bold })
      if (runEnd > end) segments.push({ text: run.text.slice(end - runStart), bold: run.bold })
      for (const segment of segments.filter(item => item.text)) runs.push({ ...run, ...segment })
    }
    block.runs = runs
  }
  const currentTableAndCell = () => {
    const current = state.currentCell
    const tableBlock = state.blocks.find(block => block.kind === 'table' && block.index === current?.tableIndex)
    const target = tableBlock?.rows[current.rowIndex]?.[current.columnIndex]
    return { tableBlock, target }
  }
  const io = {
    now: () => now,
    sleep: async ms => { now += ms },
    getWindowId: async () => 1,
    getActiveTab: async () => ({ ...tab }),
    getTab: async () => ({ ...tab }),
    withDebugger: async (_tabId, fn) => fn(),
    fetchExport: async () => ({ body: exportHtml(state.blocks) }),
    preserveClipboard: async () => ({ items: ['before'] }),
    writeClipboardHtml: async (html, text) => { state.clipboardHtml = { html, text } },
    restoreClipboard: async () => { state.restored += 1 },
    snapshot: async () => ({ op: 'snapshot', view: 'full' }),
    insertTrustedText: async (_tabId, text) => {
      state.inserts += 1
      if (state.selection) {
        const block = selectedParagraph()
        block.text = text
        block.marked = text
        block.runs = text ? [{ text, bold: false, italic: false, underline: false, strike: false, color: '#000000', highlight: 'none' }] : []
        state.selection = undefined
        return
      }
      const { target } = currentTableAndCell()
      if (!target) throw new Error('no current table cell')
      target.paragraphs[0].text = text
      target.paragraphs[0].marked = text
      target.paragraphs[0].runs = text ? [{ text, bold: false, italic: false, underline: false, strike: false, color: '#000000', highlight: 'none' }] : []
      target.text = target.paragraphs.map(item => item.text).join('\n')
    },
    dispatchTrustedKey: async (_tabId, spec, mask) => {
      const key = spec.key.toLowerCase()
      if (key === 'f' && mask === 2) {
        state.findOpen = true
        state.findValue = ''
        state.findCurrent = 0
        return
      }
      if (key === 'enter' && state.findOpen) {
        const total = matches().length
        if (total > 0) state.findCurrent = mask === 8 ? (state.findCurrent - 2 + total) % total + 1 : state.findCurrent % total + 1
        return
      }
      if (key === 'escape') {
        if (state.findOpen) selectCurrent()
        state.findOpen = false
        state.menuOpen = false
        return
      }
      if (key === 'arrowright') {
        if (state.selection?.entry.tableIndex !== undefined) {
          const entry = state.selection.entry
          state.currentCell = { tableIndex: entry.tableIndex, rowIndex: entry.rowIndex, columnIndex: entry.columnIndex }
        }
        state.selection = undefined
        return
      }
      if (key === 'tab') {
        const { tableBlock } = currentTableAndCell()
        if (!tableBlock) throw new Error('tab outside table')
        const columns = tableBlock.rows[0].length
        const current = state.currentCell.rowIndex * columns + state.currentCell.columnIndex
        const next = current + (mask === 8 ? -1 : 1)
        if (next < 0 || next >= tableBlock.rows.length * columns) throw new Error('tab left table')
        state.currentCell.rowIndex = Math.floor(next / columns)
        state.currentCell.columnIndex = next % columns
        return
      }
      if (key === '/' && mask === 1) {
        state.menuOpen = true
        state.menuQuery = ''
        return
      }
      if (key === 'v' && mask === 2) {
        const inserted = parseDocStructure(`<html><body>${state.clipboardHtml.html}</body></html>`)
        if (state.blocks.length === 1 && state.blocks[0].kind === 'para' && !state.blocks[0].text) state.blocks = []
        state.blocks.push(...inserted, para())
        return
      }
      if (key === 'delete' && state.selection) {
        const block = selectedParagraph()
        block.text = ''
        block.marked = ''
        block.runs = []
        state.selection = undefined
        return
      }
      if (key === 'b' && mask === 2) {
        applyBold()
        return
      }
      if (key === 'enter' && mask === 0) {
        state.blocks.push(para())
      }
    },
    trustedClick: async (_tabId, x) => {
      state.clicks.push(x)
      if (x !== 50) return
      const { tableBlock } = currentTableAndCell()
      if (!tableBlock) throw new Error('table command outside table')
      const rowIndex = state.currentCell.rowIndex
      const columnIndex = state.currentCell.columnIndex
      const emptyRow = () => Array.from({ length: tableBlock.rows[0].length }, () => cell())
      if (state.menuQuery === 'Insert row above') tableBlock.rows.splice(rowIndex, 0, emptyRow())
      else if (state.menuQuery === 'Insert row below') tableBlock.rows.splice(rowIndex + 1, 0, emptyRow())
      else if (state.menuQuery === 'Insert column left' || state.menuQuery === 'Insert column right') {
        const at = columnIndex + (state.menuQuery.endsWith('right') ? 1 : 0)
        for (const row of tableBlock.rows) row.splice(at, 0, cell())
      } else if (state.menuQuery === 'Delete row') tableBlock.rows.splice(rowIndex, 1)
      else if (state.menuQuery === 'Delete column') {
        for (const row of tableBlock.rows) row.splice(columnIndex, 1)
      } else if (state.menuQuery === 'Delete table') {
        const index = state.blocks.indexOf(tableBlock)
        state.blocks.splice(index, 1)
        state.currentCell = undefined
      } else throw new Error(`unexpected menu command ${state.menuQuery}`)
      state.menuOpen = false
    },
    runInTab: async (_tabId, _func, [command, args]) => {
      if (command === 'find') {
        if (!state.findOpen) return { ok: true, open: false }
        const total = matches().length
        if (total > 0 && state.findCurrent === 0) state.findCurrent = 1
        return { ok: true, open: true, enabled: true, focused: true, value: state.findValue, match: { current: state.findCurrent, total, text: `${state.findCurrent} of ${total}` } }
      }
      if (command === 'setFind') {
        state.findValue = args.value
        state.findCurrent = matches().length > 0 ? 1 : 0
        return { ok: true, readback: true }
      }
      if (command === 'documentContent') return { ok: true, present: true, focused: true }
      if (command === 'focusDocument') return { ok: true, focused: true }
      if (command === 'menuSearch') return { ok: true, present: state.menuOpen, enabled: true, focused: state.menuOpen, value: state.menuQuery }
      if (command === 'setMenuSearch') {
        state.menuQuery = args.value
        return { ok: true, readback: true }
      }
      if (command === 'tableMenuItem') return { ok: true, present: state.menuOpen && state.menuQuery === args.name, disabled: false, point: { x: 50, y: 20 } }
      if (command === 'format') {
        const block = selectedParagraph()
        const bold = Boolean(block?.runs.some(run => positions(block.text, state.findValue).length && run.bold))
        return { ok: true, bold }
      }
      throw new Error(`unexpected probe ${command}`)
    },
  }
  return { io, state }
}

test('Docs table arguments validate every action before browser access', () => {
  assert.deepEqual(parseDocsTableArgs({ action: 'create', rows: 2, columns: 2, values: [['a', 'b'], ['c', 'd']] }), {
    action: 'create', rows: 2, columns: 2, values: [['a', 'b'], ['c', 'd']],
  })
  assert.deepEqual(parseDocsTableArgs({ action: 'insert_rows', row: 2, count: 2 }), { action: 'insert_rows', table: undefined, row: 2, position: 'after', count: 2 })
  assert.deepEqual(parseDocsTableArgs({ action: 'delete_columns', columns: [3, 1] }), { action: 'delete_columns', table: undefined, columns: [3, 1] })
  assert.deepEqual(parseDocsTableArgs({ action: 'format', edits: [{ row: 1, bold: true, highlight: '#FFFF00' }] }), { action: 'format', table: undefined, edits: [{ row: 1, bold: true, highlight: '#ffff00' }] })
  const invalid = [
    {}, { action: 'unknown' }, { action: 'create', rows: 0, columns: 2 },
    { action: 'create', rows: 2, columns: 2, values: [['only one']] },
    { action: 'write', edits: [{ row: 1, column: 1, value: 'bad\nvalue' }] },
    { action: 'write', edits: [{ row: 1, column: 1, value: 'x' }, { row: 1, column: 1, value: 'y' }], surprise: true },
    { action: 'format', edits: [{ row: 1 }] },
    { action: 'insert_rows', position: 'middle' },
    { action: 'delete_rows', rows: [1, 1] },
    { action: 'delete_columns', columns: [] },
  ]
  for (const args of invalid) assert.throws(() => parseDocsTableArgs(args), error => error.code.startsWith('DOCS_TABLE_'))
})

test('Docs table Find plans distinguish duplicate cells and navigate to an empty target', () => {
  const blocks = [para('same'), table([['same', 'x'], ['same', '']])]
  const entries = docsParagraphEntries(blocks)
  const target = entries.find(entry => entry.tableIndex === 1 && entry.rowIndex === 1 && entry.columnIndex === 0)
  assert.deepEqual(docsTableFindPlan(entries, target), { text: 'same', occurrence: 3, matchCount: 3, entry: target })
  const navigation = docsTableNavigationPlan(blocks, selectDocsTable(blocks), 2, 2)
  assert.equal(navigation.text, 'same')
  assert.equal(navigation.occurrence, 3)
  assert.equal(navigation.steps, 1)
})

test('Docs table write planning rejects duplicates, merged cells, and multi-paragraph targets before mutation', () => {
  const simple = selectDocsTable([table([['a', 'b']])])
  assert.throws(() => planDocsTableWrite(simple, [{ row: 1, column: 1, value: 'x' }, { row: 1, column: 1, value: 'y' }]), error => error.code === 'DOCS_TABLE_DUPLICATE_TARGET')
  const merged = table([['a', 'b']])
  merged.rows[0][0].colspan = 2
  merged.rows[0].pop()
  assert.throws(() => planDocsTableWrite(selectDocsTable([merged]), [{ row: 1, column: 1, value: 'x' }]), error => error.code === 'DOCS_TABLE_MERGED_UNSUPPORTED')
  const multiple = selectDocsTable([table([['a']])])
  multiple.rows[0][0].paragraphs.push(para('second'))
  multiple.rows[0][0].text = 'a\nsecond'
  assert.throws(() => planDocsTableWrite(multiple, [{ row: 1, column: 1, value: 'x' }]), error => error.code === 'DOCS_TABLE_CELL_UNSUPPORTED')
})

test('Docs table formatting expands row targets and verifies only requested cell marks', () => {
  const baseline = [para('sentinel'), table([['H1', 'H2'], ['same', 'same']])]
  const selected = selectDocsTable(baseline)
  const { edits } = docsTableFormatEdits(baseline, selected, [{ row: 1, bold: true, highlight: '#ffff00' }])
  assert.deepEqual(edits.map(edit => [edit.text, edit.occurrence]), [['H1', 1], ['H2', 1]])
  const plans = planDocsFormatEdits(baseline, edits)
  const final = structuredClone(baseline)
  for (const target of final[1].rows[0]) {
    for (const run of target.paragraphs[0].runs) {
      run.bold = true
      run.highlight = '#ffff00'
    }
  }
  assert.equal(verifyDocsFormatEdits(baseline, final, plans, edits, edits.length).ok, true)
  final[1].rows[1][0].paragraphs[0].runs[0].bold = true
  assert.equal(verifyDocsFormatEdits(baseline, final, plans, edits, edits.length).failure.collateral, true)
})

test('Docs table structural verification preserves existing cells and detects collateral', () => {
  const baseline = [para('sentinel'), table([['a', 'b'], ['c', 'd']])]
  const inserted = structuredClone(baseline)
  inserted[1].rows.splice(1, 0, [cell(), cell()])
  assert.equal(verifyDocsTableStructure(baseline, inserted, 1, { action: 'insert_rows', row: 1, position: 'after', count: 1 }).ok, true)
  inserted[0].text = 'damaged'
  inserted[0].runs[0].text = 'damaged'
  assert.equal(verifyDocsTableStructure(baseline, inserted, 1, { action: 'insert_rows', row: 1, position: 'after', count: 1 }).code, 'DOCS_TABLE_COLLATERAL')
})

test('Docs table create pastes one populated native table and restores the clipboard', async () => {
  const fake = fakeDocs()
  const values = [['A', 'B', 'C', 'D'], ['E', 'F', 'G', 'H'], ['I', 'J', 'K', 'L']]
  const result = await docsTable({}, { action: 'create', rows: 3, columns: 4, values }, fake.io)
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.tableAction, 'create')
  assert.equal(result.docs.verifiedCount, 12)
  assert.equal(result.view, 'none')
  assert.equal(fake.state.restored, 1)
  assert.deepEqual(result.tables[0].cells.map(row => row.map(item => item.value)), values)
  assert.equal(fake.state.blocks.filter(block => block.kind === 'table').length, 1)
})

test('Docs table write replaces duplicate and empty cells with per-cell export verification', async () => {
  const fake = fakeDocs([para('same'), table([['same', 'same', ''], ['a', 'b', 'c']])])
  const fetchExport = fake.io.fetchExport
  let exportCount = 0
  let staleBody
  fake.io.fetchExport = async () => {
    exportCount += 1
    if (exportCount === 2) return { body: staleBody }
    staleBody = exportHtml(fake.state.blocks)
    return fetchExport()
  }
  const result = await docsTable({}, { action: 'write', edits: [
    { row: 1, column: 1, value: 'first' },
    { row: 1, column: 2, value: 'first' },
    { row: 1, column: 3, value: 'third' },
    { row: 2, column: 1, value: '' },
  ] }, fake.io)
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.appliedCount, 4)
  assert.deepEqual(result.tables[0].cells.map(row => row.map(item => item.value)), [['first', 'first', 'third'], ['', 'b', 'c']])
  assert.equal(fake.state.blocks[0].text, 'same')
  assert.equal(fake.state.inserts, 3)
})

test('Docs table write validates all targets before input and fails closed on an unanchored empty table', async () => {
  const duplicate = fakeDocs([table([['a', 'b']])])
  await assert.rejects(docsTable({}, { action: 'write', edits: [{ row: 1, column: 1, value: 'x' }, { row: 1, column: 1, value: 'y' }] }, duplicate.io), error => error.code === 'DOCS_TABLE_DUPLICATE_TARGET')
  assert.equal(duplicate.state.inserts, 0)
  const empty = fakeDocs([table([['', '']])])
  const result = await docsTable({}, { action: 'write', edits: [{ row: 1, column: 2, value: 'x' }] }, empty.io)
  assert.equal(result.docs.status, 'failed')
  assert.equal(result.docs.failure.code, 'DOCS_TABLE_UNANCHORED')
  assert.equal(empty.state.inserts, 0)
})

test('Docs table formats a header row without changing data rows', async () => {
  const fake = fakeDocs([table([['H1', 'H2'], ['D1', 'D2']])])
  const result = await docsTable({}, { action: 'format', edits: [{ row: 1, bold: true }] }, fake.io)
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.tableAction, 'format')
  const actual = selectDocsTable(fake.state.blocks)
  assert.ok(actual.rows[0].every(item => item.paragraphs[0].runs.every(run => run.bold)))
  assert.ok(actual.rows[1].every(item => item.paragraphs[0].runs.every(run => !run.bold)))
})

test('Docs table inserts and deletes rows and columns through exact native commands', async () => {
  const fake = fakeDocs([table([['a', 'b'], ['c', 'd']])])
  const insertedRows = await docsTable({}, { action: 'insert_rows', count: 2 }, fake.io)
  assert.equal(insertedRows.docs.status, 'completed')
  assert.equal(insertedRows.tables[0].rows, 4)
  const insertedColumns = await docsTable({}, { action: 'insert_columns', column: 1, position: 'before' }, fake.io)
  assert.equal(insertedColumns.docs.status, 'completed')
  assert.equal(insertedColumns.tables[0].columns, 3)
  const populated = await docsTable({}, { action: 'write', edits: [
    { row: 1, column: 1, value: 'u' }, { row: 2, column: 1, value: 'v' },
    { row: 3, column: 1, value: 'e' }, { row: 3, column: 2, value: 'f' }, { row: 3, column: 3, value: 'g' },
    { row: 4, column: 1, value: 'h' }, { row: 4, column: 2, value: 'i' }, { row: 4, column: 3, value: 'j' },
  ] }, fake.io)
  assert.equal(populated.docs.status, 'completed', JSON.stringify(populated.docs))
  const deletedRows = await docsTable({}, { action: 'delete_rows', rows: [3, 4] }, fake.io)
  assert.equal(deletedRows.docs.status, 'completed', JSON.stringify(deletedRows.docs))
  assert.equal(deletedRows.tables[0].rows, 2)
  const deletedColumns = await docsTable({}, { action: 'delete_columns', columns: [1] }, fake.io)
  assert.equal(deletedColumns.docs.status, 'completed')
  assert.deepEqual(deletedColumns.tables[0].cells.map(row => row.map(item => item.value)), [['a', 'b'], ['c', 'd']])
  assert.ok(fake.state.clicks.every(x => x === 50))
})

test('Docs table delete removes only the selected table', async () => {
  const fake = fakeDocs([para('before'), table([['a']]), para('after')])
  const result = await docsTable({}, { action: 'delete_table' }, fake.io)
  assert.equal(result.docs.status, 'completed')
  assert.equal(fake.state.blocks.some(block => block.kind === 'table'), false)
  assert.deepEqual(fake.state.blocks.map(block => block.text), ['before', 'after'])
})

test('Docs table HTML generator escapes cell content and preserves the requested shape', () => {
  const content = docsTableCreateHtml({ rows: 1, columns: 2, values: [['<a>&"', 'plain']] })
  assert.match(content.html, /&lt;a&gt;&amp;&quot;/)
  const parsed = parseDocStructure(`<html><body>${content.html}</body></html>`)
  assert.deepEqual(parsed[0].rows[0].map(item => item.text), ['<a>&"', 'plain'])
})
