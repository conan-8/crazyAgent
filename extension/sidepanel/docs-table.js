const DOCS_TABLE_MAX_ROWS = 100
const DOCS_TABLE_MAX_COLUMNS = 20
const DOCS_TABLE_MAX_EDITS = 100
const DOCS_TABLE_MAX_FORMATS = 50
const DOCS_TABLE_MAX_VALUE_CHARS = 2_000
const DOCS_TABLE_MAX_TOTAL_CHARS = 20_000
const DOCS_TABLE_FORMAT_ATTRIBUTES = ['paragraph_style', 'font_size', 'font', 'bold', 'italic', 'underline', 'color', 'highlight']
const DOCS_TABLE_PARAGRAPH_STYLES = ['Normal text', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']

function tableFailure(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0
}

function boundedIndex(value, maximum, label) {
  if (!positive(value) || value > maximum) throw tableFailure('DOCS_TABLE_BAD_INDEX', `${label} must be a positive one-based index no greater than ${maximum}`)
  return value
}

function checkKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw tableFailure('DOCS_TABLE_BAD_ARGUMENT', `${label} contains an unknown or invalid argument`)
  }
}

function optionalTable(args) {
  if (args.table !== undefined) boundedIndex(args.table, 1_000, 'table')
}

function validateValue(value, label) {
  if (typeof value !== 'string' || value.length > DOCS_TABLE_MAX_VALUE_CHARS || /[\r\n\t]/u.test(value)) {
    throw tableFailure('DOCS_TABLE_BAD_VALUE', `${label} must be a single-line string of at most ${DOCS_TABLE_MAX_VALUE_CHARS} characters without tabs`)
  }
  return value
}

function validateFormat(edit, index) {
  checkKeys(edit, ['row', 'column', ...DOCS_TABLE_FORMAT_ATTRIBUTES], `edits[${index}]`)
  if (edit.row !== undefined) boundedIndex(edit.row, DOCS_TABLE_MAX_ROWS, `edits[${index}].row`)
  if (edit.column !== undefined) boundedIndex(edit.column, DOCS_TABLE_MAX_COLUMNS, `edits[${index}].column`)
  const attributes = DOCS_TABLE_FORMAT_ATTRIBUTES.filter(attribute => edit[attribute] !== undefined)
  if (attributes.length === 0) throw tableFailure('DOCS_TABLE_BAD_FORMAT', `edits[${index}] requires at least one formatting attribute`)
  if (edit.paragraph_style !== undefined && !DOCS_TABLE_PARAGRAPH_STYLES.includes(edit.paragraph_style)) {
    throw tableFailure('DOCS_TABLE_BAD_FORMAT', `edits[${index}].paragraph_style is unsupported`)
  }
  if (edit.font_size !== undefined && (!Number.isInteger(edit.font_size) || edit.font_size < 1 || edit.font_size > 400)) {
    throw tableFailure('DOCS_TABLE_BAD_FORMAT', `edits[${index}].font_size must be an integer from 1 to 400`)
  }
  if (edit.font !== undefined && (typeof edit.font !== 'string' || edit.font.trim().length === 0 || edit.font.length > 100)) {
    throw tableFailure('DOCS_TABLE_BAD_FORMAT', `edits[${index}].font must be a non-empty string of at most 100 characters`)
  }
  for (const attribute of ['bold', 'italic', 'underline']) {
    if (edit[attribute] !== undefined && typeof edit[attribute] !== 'boolean') throw tableFailure('DOCS_TABLE_BAD_FORMAT', `edits[${index}].${attribute} must be a boolean`)
  }
  if (edit.color !== undefined && (typeof edit.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(edit.color))) {
    throw tableFailure('DOCS_TABLE_BAD_FORMAT', `edits[${index}].color must be a six-digit hex color`)
  }
  if (edit.highlight !== undefined && (typeof edit.highlight !== 'string' || edit.highlight !== 'none' && !/^#[0-9a-f]{6}$/iu.test(edit.highlight))) {
    throw tableFailure('DOCS_TABLE_BAD_FORMAT', `edits[${index}].highlight must be "none" or a six-digit hex color`)
  }
  return {
    ...edit.row === undefined ? {} : { row: edit.row },
    ...edit.column === undefined ? {} : { column: edit.column },
    ...Object.fromEntries(attributes.map(attribute => [attribute,
      attribute === 'font' ? edit.font.trim()
        : attribute === 'color' || attribute === 'highlight' && edit.highlight !== 'none' ? edit[attribute].toLowerCase()
          : edit[attribute]])),
  }
}

export function parseDocsTableArgs(args = {}) {
  checkKeys(args, ['action', 'table', 'rows', 'columns', 'values', 'edits', 'row', 'column', 'position', 'count'], 'browser_docs_table')
  if (typeof args.action !== 'string') throw tableFailure('DOCS_TABLE_BAD_ACTION', 'action is required')
  optionalTable(args)
  switch (args.action) {
    case 'read':
      if (Object.keys(args).some(key => !['action', 'table'].includes(key))) throw tableFailure('DOCS_TABLE_BAD_ARGUMENT', 'read accepts only action and table')
      return { action: 'read', table: args.table }
    case 'create': {
      if (Object.keys(args).some(key => !['action', 'rows', 'columns', 'values'].includes(key))) throw tableFailure('DOCS_TABLE_BAD_ARGUMENT', 'create accepts only rows, columns, and optional values')
      const rows = boundedIndex(args.rows, DOCS_TABLE_MAX_ROWS, 'rows')
      const columns = boundedIndex(args.columns, DOCS_TABLE_MAX_COLUMNS, 'columns')
      let total = 0
      if (args.values !== undefined) {
        if (!Array.isArray(args.values) || args.values.length !== rows || args.values.some(row => !Array.isArray(row) || row.length !== columns)) {
          throw tableFailure('DOCS_TABLE_BAD_VALUES', `values must be a ${rows} by ${columns} matrix`)
        }
        for (const [rowIndex, row] of args.values.entries()) {
          for (const [columnIndex, value] of row.entries()) total += validateValue(value, `values[${rowIndex}][${columnIndex}]`).length
        }
      }
      if (total > DOCS_TABLE_MAX_TOTAL_CHARS) throw tableFailure('DOCS_TABLE_BAD_VALUES', `values may contain at most ${DOCS_TABLE_MAX_TOTAL_CHARS} characters in total`)
      return { action: 'create', rows, columns, values: args.values?.map(row => [...row]) }
    }
    case 'write': {
      if (Object.keys(args).some(key => !['action', 'table', 'edits'].includes(key))) throw tableFailure('DOCS_TABLE_BAD_ARGUMENT', 'write accepts only action, table, and edits')
      if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > DOCS_TABLE_MAX_EDITS) throw tableFailure('DOCS_TABLE_BAD_EDITS', `write requires 1 to ${DOCS_TABLE_MAX_EDITS} edits`)
      let total = 0
      const edits = args.edits.map((edit, index) => {
        checkKeys(edit, ['row', 'column', 'value'], `edits[${index}]`)
        const row = boundedIndex(edit.row, DOCS_TABLE_MAX_ROWS, `edits[${index}].row`)
        const column = boundedIndex(edit.column, DOCS_TABLE_MAX_COLUMNS, `edits[${index}].column`)
        total += validateValue(edit.value, `edits[${index}].value`).length
        return { row, column, value: edit.value }
      })
      if (total > DOCS_TABLE_MAX_TOTAL_CHARS) throw tableFailure('DOCS_TABLE_BAD_VALUES', `write values may contain at most ${DOCS_TABLE_MAX_TOTAL_CHARS} characters in total`)
      return { action: 'write', table: args.table, edits }
    }
    case 'format': {
      if (Object.keys(args).some(key => !['action', 'table', 'edits'].includes(key))) throw tableFailure('DOCS_TABLE_BAD_ARGUMENT', 'format accepts only action, table, and edits')
      if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > DOCS_TABLE_MAX_FORMATS) throw tableFailure('DOCS_TABLE_BAD_EDITS', `format requires 1 to ${DOCS_TABLE_MAX_FORMATS} edits`)
      return { action: 'format', table: args.table, edits: args.edits.map(validateFormat) }
    }
    case 'insert_rows':
    case 'insert_columns': {
      const key = args.action === 'insert_rows' ? 'row' : 'column'
      if (Object.keys(args).some(item => !['action', 'table', key, 'position', 'count'].includes(item))) throw tableFailure('DOCS_TABLE_BAD_ARGUMENT', `${args.action} received an unknown argument`)
      if (args[key] !== undefined) boundedIndex(args[key], key === 'row' ? DOCS_TABLE_MAX_ROWS : DOCS_TABLE_MAX_COLUMNS, key)
      if (args.position !== undefined && !['before', 'after'].includes(args.position)) throw tableFailure('DOCS_TABLE_BAD_POSITION', 'position must be before or after')
      if (args.count !== undefined) boundedIndex(args.count, 20, 'count')
      return { action: args.action, table: args.table, [key]: args[key], position: args.position ?? 'after', count: args.count ?? 1 }
    }
    case 'delete_rows':
    case 'delete_columns': {
      const key = args.action === 'delete_rows' ? 'rows' : 'columns'
      if (Object.keys(args).some(item => !['action', 'table', key].includes(item))) throw tableFailure('DOCS_TABLE_BAD_ARGUMENT', `${args.action} received an unknown argument`)
      const maximum = key === 'rows' ? DOCS_TABLE_MAX_ROWS : DOCS_TABLE_MAX_COLUMNS
      if (!Array.isArray(args[key]) || args[key].length < 1 || args[key].length > maximum) throw tableFailure('DOCS_TABLE_BAD_INDEX', `${key} must be a non-empty array`)
      const values = args[key].map((value, index) => boundedIndex(value, maximum, `${key}[${index}]`))
      if (new Set(values).size !== values.length) throw tableFailure('DOCS_TABLE_DUPLICATE_TARGET', `${key} contains a duplicate index`)
      return { action: args.action, table: args.table, [key]: values }
    }
    case 'delete_table':
      if (Object.keys(args).some(key => !['action', 'table'].includes(key))) throw tableFailure('DOCS_TABLE_BAD_ARGUMENT', 'delete_table accepts only action and table')
      return { action: 'delete_table', table: args.table }
    default:
      throw tableFailure('DOCS_TABLE_BAD_ACTION', `Unsupported Docs table action ${JSON.stringify(args.action)}`)
  }
}

export function docsTables(blocks) {
  return blocks.filter(block => block?.kind === 'table')
}

export function docsTableColumns(table) {
  return Math.max(0, ...table.rows.map(row => row.reduce((sum, cell) => sum + cell.colspan, 0)))
}

export function selectDocsTable(blocks, selector) {
  const tables = docsTables(blocks)
  if (selector !== undefined) {
    const table = tables.find(item => item.index === selector)
    if (!table) throw tableFailure('DOCS_TABLE_NOT_FOUND', `Table ${selector} was not found; read the document tables again`)
    return table
  }
  if (tables.length === 0) throw tableFailure('DOCS_TABLE_NOT_FOUND', 'The document contains no tables')
  if (tables.length > 1) throw tableFailure('DOCS_TABLE_REQUIRED', `The document contains ${tables.length} tables; pass a one-based table index`)
  return tables[0]
}

export function publicDocsTable(table) {
  const truncated = table.rows.length > DOCS_TABLE_MAX_ROWS
    || table.rows.some(row => row.length > DOCS_TABLE_MAX_COLUMNS || row.some(cell => cell.text.length > DOCS_TABLE_MAX_VALUE_CHARS))
  return {
    index: table.index,
    rows: table.rows.length,
    columns: docsTableColumns(table),
    ...truncated ? { truncated: true } : {},
    cells: table.rows.slice(0, DOCS_TABLE_MAX_ROWS).map(row => row.slice(0, DOCS_TABLE_MAX_COLUMNS).map(cell => ({
      value: cell.text.slice(0, DOCS_TABLE_MAX_VALUE_CHARS),
      rowspan: cell.rowspan,
      colspan: cell.colspan,
      paragraphs: cell.paragraphs.length,
    }))),
  }
}

function assertSimpleTable(table) {
  const columns = docsTableColumns(table)
  if (columns < 1 || table.rows.length < 1 || table.rows.some(row => row.length !== columns || row.some(cell => cell.rowspan !== 1 || cell.colspan !== 1))) {
    throw tableFailure('DOCS_TABLE_MERGED_UNSUPPORTED', 'This mutation currently requires an unmerged rectangular table; read and whole-table text formatting remain available')
  }
  return columns
}

export function docsParagraphEntries(blocks) {
  const entries = []
  let offset = 0
  const add = (block, location = {}) => {
    entries.push({ block, start: offset, ...location })
    offset += block.text.length + 1
  }
  for (const block of blocks) {
    if (block?.kind === 'para') add(block)
    else if (block?.kind === 'table') {
      for (const [rowIndex, row] of block.rows.entries()) {
        for (const [columnIndex, cell] of row.entries()) {
          for (const [paragraphIndex, paragraph] of cell.paragraphs.entries()) {
            add(paragraph, { tableIndex: block.index, rowIndex, columnIndex, paragraphIndex })
          }
        }
      }
    }
  }
  return entries
}

function literalPositions(haystack, needle) {
  const source = haystack.toLowerCase()
  const wanted = needle.toLowerCase()
  if (!wanted) return []
  const positions = []
  for (let index = source.indexOf(wanted); index >= 0; index = source.indexOf(wanted, index + wanted.length)) positions.push(index)
  return positions
}

export function docsTableFindPlan(entries, entry) {
  const text = entry.block.text
  if (!text || text.length > 1_000 || /[\r\n]/u.test(text)) {
    throw tableFailure('DOCS_TABLE_UNMAPPABLE', 'A table paragraph is empty, multiline, or longer than the 1000-character Find limit')
  }
  const source = entries.map(item => item.block.text).join('\n')
  const matches = literalPositions(source, text)
  const occurrence = matches.findIndex(index => index === entry.start) + 1
  if (occurrence < 1) throw tableFailure('DOCS_TABLE_UNMAPPABLE', 'The table paragraph occurrence could not be reconstructed from the export')
  return { text, occurrence, matchCount: matches.length, entry }
}

function cellAt(table, row, column) {
  const cell = table.rows[row - 1]?.[column - 1]
  if (!cell) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', `Cell row ${row}, column ${column} does not exist`)
  return cell
}

export function planDocsTableWrite(table, edits) {
  assertSimpleTable(table)
  const targets = new Set()
  return edits.map((edit, index) => {
    const key = `${edit.row}:${edit.column}`
    if (targets.has(key)) throw tableFailure('DOCS_TABLE_DUPLICATE_TARGET', `edits[${index}] targets the same cell as an earlier edit`)
    targets.add(key)
    const cell = cellAt(table, edit.row, edit.column)
    if (cell.paragraphs.length !== 1 || cell.paragraphs[0].text.includes('\n')) {
      throw tableFailure('DOCS_TABLE_CELL_UNSUPPORTED', `edits[${index}] targets a multi-paragraph cell; no cells were changed`)
    }
    return { ...edit, index, before: cell.text }
  })
}

export function docsTableCellPlan(blocks, table, row, column) {
  const cell = cellAt(table, row, column)
  if (cell.paragraphs.length !== 1 || !cell.paragraphs[0].text) throw tableFailure('DOCS_TABLE_UNMAPPABLE', 'The requested cell has no single non-empty text paragraph')
  const entries = docsParagraphEntries(blocks)
  const entry = entries.find(item => item.tableIndex === table.index && item.rowIndex === row - 1 && item.columnIndex === column - 1 && item.paragraphIndex === 0)
  if (!entry) throw tableFailure('DOCS_TABLE_UNMAPPABLE', 'The requested cell is missing from the flattened document export')
  return { ...docsTableFindPlan(entries, entry), cell }
}

export function docsTableNavigationPlan(blocks, table, row, column) {
  assertSimpleTable(table)
  const columns = docsTableColumns(table)
  const targetIndex = (row - 1) * columns + column - 1
  const cells = table.rows.flat()
  const entries = docsParagraphEntries(blocks)
  const candidates = cells.map((cell, index) => ({ cell, index, paragraph: cell.paragraphs.at(-1) }))
    .filter(item => item.paragraph?.text && !/[\r\n]/u.test(item.paragraph.text) && item.paragraph.text.length <= 1_000)
  if (candidates.length === 0) throw tableFailure('DOCS_TABLE_UNANCHORED', 'The table has no non-empty cell that can anchor safe keyboard navigation; create it with initial values or add a unique cell value first')
  const anchor = candidates.reduce((best, item) => Math.abs(item.index - targetIndex) < Math.abs(best.index - targetIndex) ? item : best)
  const anchorRow = Math.floor(anchor.index / columns) + 1
  const anchorColumn = anchor.index % columns + 1
  const entry = entries.find(item => item.tableIndex === table.index && item.rowIndex === anchorRow - 1 && item.columnIndex === anchorColumn - 1 && item.paragraphIndex === anchor.cell.paragraphs.length - 1)
  if (!entry) throw tableFailure('DOCS_TABLE_UNMAPPABLE', 'The navigation anchor is missing from the flattened document export')
  const plan = docsTableFindPlan(entries, entry)
  return { ...plan, steps: targetIndex - anchor.index, anchorRow, anchorColumn }
}

export function docsTableAnchor(blocks, table, kind, index) {
  const candidates = []
  if (kind === 'row') {
    const row = table.rows[index - 1]
    if (!row) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', `Row ${index} does not exist`)
    for (const [columnIndex, cell] of row.entries()) candidates.push({ rowIndex: index - 1, columnIndex, cell })
  } else if (kind === 'column') {
    for (const [rowIndex, row] of table.rows.entries()) {
      const cell = row[index - 1]
      if (cell) candidates.push({ rowIndex, columnIndex: index - 1, cell })
    }
    if (candidates.length === 0) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', `Column ${index} does not exist`)
  } else {
    for (const [rowIndex, row] of table.rows.entries()) for (const [columnIndex, cell] of row.entries()) candidates.push({ rowIndex, columnIndex, cell })
  }
  const entries = docsParagraphEntries(blocks)
  for (const candidate of candidates) {
    const paragraphIndex = candidate.cell.paragraphs.length - 1
    const paragraph = candidate.cell.paragraphs[paragraphIndex]
    if (!paragraph?.text || /[\r\n]/u.test(paragraph.text) || paragraph.text.length > 1_000) continue
    const entry = entries.find(item => item.tableIndex === table.index && item.rowIndex === candidate.rowIndex
      && item.columnIndex === candidate.columnIndex && item.paragraphIndex === paragraphIndex)
    if (entry) return docsTableFindPlan(entries, entry)
  }
  throw tableFailure('DOCS_TABLE_UNANCHORED', 'No non-empty cell in the requested table region can anchor the native Docs command')
}

export function docsTableFormatEdits(blocks, table, requests) {
  const edits = []
  const targets = []
  const seen = new Set()
  for (const [requestIndex, request] of requests.entries()) {
    const cells = []
    for (const [rowIndex, row] of table.rows.entries()) {
      if (request.row !== undefined && request.row !== rowIndex + 1) continue
      for (const [columnIndex, cell] of row.entries()) {
        if (request.column !== undefined && request.column !== columnIndex + 1) continue
        cells.push({ rowIndex, columnIndex, cell })
      }
    }
    if (cells.length === 0) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', `edits[${requestIndex}] does not match any table cells`)
    const entries = docsParagraphEntries(blocks)
    let editCount = 0
    for (const { rowIndex, columnIndex, cell } of cells) {
      for (const [paragraphIndex, paragraph] of cell.paragraphs.entries()) {
        if (!paragraph.text) continue
        const key = `${rowIndex}:${columnIndex}:${paragraphIndex}`
        if (seen.has(key)) throw tableFailure('DOCS_TABLE_DUPLICATE_TARGET', `edits[${requestIndex}] overlaps an earlier formatting target`)
        seen.add(key)
        const entry = entries.find(item => item.tableIndex === table.index && item.rowIndex === rowIndex
          && item.columnIndex === columnIndex && item.paragraphIndex === paragraphIndex)
        if (!entry) throw tableFailure('DOCS_TABLE_UNMAPPABLE', 'A formatting target is missing from the flattened document export')
        const plan = docsTableFindPlan(entries, entry)
        const attributes = Object.fromEntries(DOCS_TABLE_FORMAT_ATTRIBUTES.filter(attribute => request[attribute] !== undefined).map(attribute => [attribute, request[attribute]]))
        edits.push({ text: plan.text, occurrence: plan.occurrence, ...attributes })
        targets.push({ requestIndex, row: rowIndex + 1, column: columnIndex + 1, paragraph: paragraphIndex + 1 })
        editCount += 1
      }
    }
    if (editCount === 0) throw tableFailure('DOCS_TABLE_EMPTY_FORMAT', `edits[${requestIndex}] targets only empty cells; there is no text to format`)
  }
  if (edits.length > DOCS_TABLE_MAX_FORMATS) throw tableFailure('DOCS_TABLE_BAD_EDITS', `The requested regions expand to ${edits.length} paragraphs; the limit is ${DOCS_TABLE_MAX_FORMATS}`)
  return { edits, targets }
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function docsTableCreateHtml(request) {
  const values = request.values ?? Array.from({ length: request.rows }, () => Array(request.columns).fill(''))
  const rows = values.map(row => `<tr>${row.map(value => `<td style="border:1px solid #000000;padding:5px;vertical-align:top"><p>${escapeHtml(value)}</p></td>`).join('')}</tr>`).join('')
  return {
    html: `<table style="border-collapse:collapse;width:100%"><tbody>${rows}</tbody></table>`,
    text: values.map(row => row.join('\t')).join('\n'),
  }
}

function outsideTable(blocks, tableIndex) {
  return blocks.filter(block => block?.kind !== 'table' || block.index !== tableIndex)
}

function sameOutside(baseline, final, tableIndex) {
  return JSON.stringify(outsideTable(baseline, tableIndex)) === JSON.stringify(outsideTable(final, tableIndex))
}

function verificationError(code, message, details = {}) {
  return { ok: false, code, message, ...details }
}

export function verifyDocsTableWrite(baseline, final, tableIndex, edit) {
  if (!sameOutside(baseline, final, tableIndex)) return verificationError('DOCS_TABLE_COLLATERAL', 'Content outside the target table changed unexpectedly')
  const before = selectDocsTable(baseline, tableIndex)
  const after = selectDocsTable(final, tableIndex)
  assertSimpleTable(before)
  assertSimpleTable(after)
  if (before.rows.length !== after.rows.length || docsTableColumns(before) !== docsTableColumns(after)) return verificationError('DOCS_TABLE_COLLATERAL', 'The table shape changed during a cell write')
  for (const [rowIndex, row] of before.rows.entries()) {
    for (const [columnIndex, cell] of row.entries()) {
      const actual = after.rows[rowIndex]?.[columnIndex]
      if (edit.row === rowIndex + 1 && edit.column === columnIndex + 1) {
        if (actual?.text !== edit.value) return verificationError('DOCS_TABLE_VERIFY_FAILED', `Cell readback was ${JSON.stringify(actual?.text)} instead of ${JSON.stringify(edit.value)}`, { actual: actual?.text })
      } else if (JSON.stringify(cell) !== JSON.stringify(actual)) {
        return verificationError('DOCS_TABLE_COLLATERAL', `Non-target cell row ${rowIndex + 1}, column ${columnIndex + 1} changed unexpectedly`)
      }
    }
  }
  return { ok: true }
}

function emptyCellMatches(cell) {
  return cell?.text === '' && cell.rowspan === 1 && cell.colspan === 1
}

export function verifyDocsTableStructure(baseline, final, tableIndex, spec) {
  if (!sameOutside(baseline, final, tableIndex)) return verificationError('DOCS_TABLE_COLLATERAL', 'Content outside the target table changed unexpectedly')
  const before = selectDocsTable(baseline, tableIndex)
  const after = selectDocsTable(final, tableIndex)
  assertSimpleTable(before)
  assertSimpleTable(after)
  const columns = docsTableColumns(before)
  let expected
  if (spec.action === 'insert_rows') {
    const at = spec.position === 'before' ? spec.row - 1 : spec.row
    expected = before.rows.map(row => row.map(cell => ({ cell })))
    expected.splice(at, 0, ...Array.from({ length: spec.count }, () => Array.from({ length: columns }, () => ({ empty: true }))))
  } else if (spec.action === 'insert_columns') {
    const at = spec.position === 'before' ? spec.column - 1 : spec.column
    expected = before.rows.map(row => row.map(cell => ({ cell })))
    for (const row of expected) row.splice(at, 0, ...Array.from({ length: spec.count }, () => ({ empty: true })))
  } else if (spec.action === 'delete_rows') {
    const removed = new Set(spec.rows)
    expected = before.rows.filter((_, index) => !removed.has(index + 1)).map(row => row.map(cell => ({ cell })))
  } else if (spec.action === 'delete_columns') {
    const removed = new Set(spec.columns)
    expected = before.rows.map(row => row.filter((_, index) => !removed.has(index + 1)).map(cell => ({ cell })))
  } else {
    return verificationError('DOCS_TABLE_BAD_ACTION', 'Unknown structural verification request')
  }
  if (after.rows.length !== expected.length) return verificationError('DOCS_TABLE_VERIFY_FAILED', `Expected ${expected.length} rows, found ${after.rows.length}`)
  for (const [rowIndex, row] of expected.entries()) {
    if (after.rows[rowIndex]?.length !== row.length) return verificationError('DOCS_TABLE_VERIFY_FAILED', `Expected ${row.length} cells in row ${rowIndex + 1}`)
    for (const [columnIndex, wanted] of row.entries()) {
      const actual = after.rows[rowIndex][columnIndex]
      if (wanted.empty) {
        if (!emptyCellMatches(actual)) return verificationError('DOCS_TABLE_VERIFY_FAILED', `Inserted cell row ${rowIndex + 1}, column ${columnIndex + 1} is not empty and unmerged`)
      } else if (JSON.stringify(wanted.cell) !== JSON.stringify(actual)) {
        return verificationError('DOCS_TABLE_COLLATERAL', `Existing cell row ${rowIndex + 1}, column ${columnIndex + 1} changed during the structural edit`)
      }
    }
  }
  return { ok: true }
}

export function verifyDocsTableDelete(baseline, final, tableIndex) {
  const expectedOutside = baseline.filter(block => block?.kind !== 'table' || block.index !== tableIndex)
  if (docsTables(final).length !== docsTables(baseline).length - 1) return verificationError('DOCS_TABLE_VERIFY_FAILED', 'The selected table was not removed exactly once')
  const withoutIndexes = blocks => blocks.map(block => block?.kind === 'table' ? { ...block, index: undefined } : block)
  if (JSON.stringify(withoutIndexes(expectedOutside)) !== JSON.stringify(withoutIndexes(final))) {
    return verificationError('DOCS_TABLE_COLLATERAL', 'Other document content or tables changed while deleting the selected table')
  }
  return { ok: true }
}

export function docsTableStructureRequest(table, request) {
  const columns = assertSimpleTable(table)
  if (request.action === 'insert_rows') {
    if (request.row !== undefined && request.row > table.rows.length) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', 'The insertion row does not exist')
    if (table.rows.length + request.count > DOCS_TABLE_MAX_ROWS) throw tableFailure('DOCS_TABLE_BAD_INDEX', `A table may contain at most ${DOCS_TABLE_MAX_ROWS} rows after insertion`)
    return { ...request, row: request.row ?? table.rows.length }
  }
  if (request.action === 'insert_columns') {
    if (request.column !== undefined && request.column > columns) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', 'The insertion column does not exist')
    if (columns + request.count > DOCS_TABLE_MAX_COLUMNS) throw tableFailure('DOCS_TABLE_BAD_INDEX', `A table may contain at most ${DOCS_TABLE_MAX_COLUMNS} columns after insertion`)
    return { ...request, column: request.column ?? columns }
  }
  if (request.action === 'delete_rows') {
    if (request.rows.some(row => row > table.rows.length)) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', 'A requested row does not exist')
    if (request.rows.length >= table.rows.length) throw tableFailure('DOCS_TABLE_LAST_ROW', 'delete_rows cannot remove every row; use delete_table explicitly')
    return { ...request, rows: [...request.rows].sort((left, right) => right - left) }
  }
  if (request.action === 'delete_columns') {
    if (request.columns.some(column => column > columns)) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', 'A requested column does not exist')
    if (request.columns.length >= columns) throw tableFailure('DOCS_TABLE_LAST_COLUMN', 'delete_columns cannot remove every column; use delete_table explicitly')
    return { ...request, columns: [...request.columns].sort((left, right) => right - left) }
  }
  if (request.action === 'insert_rows' && request.row > table.rows.length) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', 'The insertion row does not exist')
  if (request.action === 'insert_columns' && request.column > columns) throw tableFailure('DOCS_TABLE_TARGET_NOT_FOUND', 'The insertion column does not exist')
  return request
}
