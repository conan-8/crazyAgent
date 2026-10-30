const TABLE_MAX_EDITS = 100
const TABLE_MAX_VALUE_CHARS = 2_000
const TABLE_MAX_TOTAL_CHARS = 20_000
const TABLE_MAX_TABLES = 10

function tableFailure(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function normalizedName(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function validIndex(value) {
  return Number.isSafeInteger(value) && value > 0
}

function parseCellRef(value, label) {
  if (validIndex(value)) return value
  if (typeof value === 'string' && normalizedName(value).length > 0 && normalizedName(value).length <= 200) return normalizedName(value)
  throw tableFailure('BAD_TABLE', `${label} must be a positive one-based index or a non-empty exact name`)
}

export function parseTableArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['action', 'table', 'edits'].includes(key))) {
    throw tableFailure('BAD_TABLE', 'table accepts only action, table, and edits')
  }
  if (!['read', 'write'].includes(args.action)) throw tableFailure('BAD_TABLE', 'table action must be read or write')
  if (args.table !== undefined && !validIndex(args.table)) throw tableFailure('BAD_TABLE', 'table must be a positive one-based table index')
  if (args.action === 'read') {
    if (args.edits !== undefined) throw tableFailure('BAD_TABLE', 'edits are valid only for table action write')
    return { action: 'read', table: args.table }
  }
  if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > TABLE_MAX_EDITS) {
    throw tableFailure('BAD_TABLE', `write requires 1 to ${TABLE_MAX_EDITS} edits`)
  }
  let totalChars = 0
  const edits = args.edits.map((edit, index) => {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) || Object.keys(edit).some(key => !['row', 'column', 'value'].includes(key))) {
      throw tableFailure('BAD_TABLE', `edits[${index}] must contain only row, column, and value`)
    }
    if (typeof edit.value !== 'string' || edit.value.length > TABLE_MAX_VALUE_CHARS || /[\r\n\t]/u.test(edit.value)) {
      throw tableFailure('BAD_TABLE', `edits[${index}].value must be a single-line string of at most ${TABLE_MAX_VALUE_CHARS} characters without tabs`)
    }
    totalChars += edit.value.length
    return { row: parseCellRef(edit.row, `edits[${index}].row`), column: parseCellRef(edit.column, `edits[${index}].column`), value: edit.value }
  })
  if (totalChars > TABLE_MAX_TOTAL_CHARS) throw tableFailure('BAD_TABLE', `write values may contain at most ${TABLE_MAX_TOTAL_CHARS} characters in total`)
  return { action: 'write', table: args.table, edits }
}

export function tableStructure(table) {
  return JSON.stringify({
    headers: table.headers,
    rows: table.rows.map(row => row.label),
    columns: table.rows.reduce((maximum, row) => Math.max(maximum, row.cells.length), 0),
  })
}

function publicTable(table) {
  return {
    index: table.index,
    headers: table.headers,
    rows: table.rows.map(row => ({ label: row.label, cells: row.cells.map(cell => ({ ...cell })) })),
    ...(table.truncated ? { truncated: true } : {}),
  }
}

function selectTable(tables, selector) {
  if (selector !== undefined) {
    const table = tables.find(item => item.index === selector)
    if (!table) throw tableFailure('TABLE_NOT_FOUND', `Table ${selector} was not found; call browser_table action:"read" for current table indexes`)
    return table
  }
  if (tables.length === 0) throw tableFailure('TABLE_NOT_FOUND', 'No visible editable data tables were found in the active tab')
  if (tables.length > 1) {
    const choices = tables.map(table => `${table.index}: ${table.headers.join(' | ')}`).join('; ')
    throw tableFailure('TABLE_REQUIRED', `More than one editable table is present; pass table:<index>. Choices: ${choices}`)
  }
  return tables[0]
}

function resolveIndex(reference, names, kind) {
  if (validIndex(reference)) {
    const index = reference - 1
    if (index >= names.length) throw tableFailure('TABLE_TARGET_NOT_FOUND', `${kind} ${reference} is outside the table's ${names.length} ${kind.toLowerCase()}s`)
    return index
  }
  const matches = []
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] === reference) matches.push(index)
  }
  if (matches.length === 0) throw tableFailure('TABLE_TARGET_NOT_FOUND', `${kind} ${JSON.stringify(reference)} was not found; use an exact name from browser_table action:"read"`)
  if (matches.length > 1) throw tableFailure('TABLE_AMBIGUOUS', `${kind} ${JSON.stringify(reference)} occurs ${matches.length} times; use its one-based numeric index`)
  return matches[0]
}

export function planTableWrite(table, edits) {
  const targets = new Set()
  return edits.map((edit, index) => {
    const rowIndex = resolveIndex(edit.row, table.rows.map(row => row.label), 'Row')
    const columnIndex = resolveIndex(edit.column, table.headers, 'Column')
    const cell = table.rows[rowIndex]?.cells[columnIndex]
    if (!cell) throw tableFailure('TABLE_TARGET_NOT_FOUND', `edits[${index}] targets a cell that does not exist`)
    if (cell.editable !== true) throw tableFailure('TABLE_READ_ONLY', `edits[${index}] targets read-only row ${rowIndex + 1}, column ${columnIndex + 1}; no cells were changed`)
    const key = `${rowIndex}:${columnIndex}`
    if (targets.has(key)) throw tableFailure('TABLE_DUPLICATE_TARGET', `edits[${index}] targets the same cell as an earlier edit; no cells were changed`)
    targets.add(key)
    return { ...edit, index, rowIndex, columnIndex, before: cell.value }
  })
}

async function discoverTables(tabId, io) {
  const frames = await io.runInAllFrames(tabId, tableProbe, [{ mode: 'read' }], 5_000)
  const tables = []
  for (const frame of frames) {
    if (!Array.isArray(frame.result?.tables)) continue
    for (const table of frame.result.tables) {
      if (tables.length >= TABLE_MAX_TABLES) break
      const item = {
        index: tables.length + 1,
        frameId: frame.frameId,
        localIndex: table.localIndex,
        headers: table.headers,
        rows: table.rows,
        ...(table.truncated ? { truncated: true } : {}),
      }
      item.signature = tableStructure(item)
      tables.push(item)
    }
  }
  return tables
}

async function probeCell(tabId, table, plan, mode, io) {
  const result = await io.runInFrame(tabId, table.frameId, tableProbe, [{
    mode,
    tableIndex: table.localIndex,
    rowIndex: plan.rowIndex,
    columnIndex: plan.columnIndex,
  }], 4_000)
  if (!result?.ok) throw tableFailure(result?.code ?? 'TABLE_PROBE_FAILED', result?.message ?? 'The table cell could not be resolved', { mutationPossible: false })
  if (result.signature !== table.signature) {
    throw tableFailure('TABLE_STALE', 'The table structure changed; no further cells were changed. Read the table again before retrying.', { mutationPossible: false })
  }
  return result
}

async function readSelectedTable(tabId, table, io) {
  const result = await io.runInFrame(tabId, table.frameId, tableProbe, [{ mode: 'table', tableIndex: table.localIndex }], 4_000)
  if (!result?.ok || !result.table) throw tableFailure(result?.code ?? 'TABLE_PROBE_FAILED', result?.message ?? 'The table could not be read')
  const current = { ...result.table, index: table.index }
  if (tableStructure(current) !== table.signature) throw tableFailure('TABLE_STALE', 'The table structure changed during verification; inspect it with a fresh browser_table read')
  return publicTable(current)
}

export async function executeTable(args, io) {
  const request = parseTableArgs(args)
  const tab = await io.getActiveTab()
  await io.assertCapturable(tab)
  const tables = await discoverTables(tab.id, io)
  if (request.action === 'read') {
    const selected = request.table === undefined ? tables : [selectTable(tables, request.table)]
    return {
      op: 'table',
      view: 'none',
      screenshotSkipped: true,
      capture: { status: 'skipped', reason: 'TABLE_TEXT_ONLY' },
      tab: io.tabSummary(tab),
      table: { action: 'read', status: 'completed', count: selected.length },
      tables: selected.map(publicTable),
    }
  }

  const selected = selectTable(tables, request.table)
  const plan = planTableWrite(selected, request.edits)
  const results = []
  let failure
  for (const item of plan) {
    const result = {
      index: item.index,
      row: item.rowIndex + 1,
      column: item.columnIndex + 1,
      value: item.value,
      before: item.before,
      attempted: false,
      mutationPossible: false,
    }
    results.push(result)
    if (item.before === item.value) {
      Object.assign(result, { status: 'already_applied', after: item.before, verifiedBy: 'cell-readback' })
      continue
    }
    try {
      const prepared = await probeCell(tab.id, selected, item, 'prepare', io)
      if (prepared.value === item.value) {
        Object.assign(result, { status: 'already_applied', after: prepared.value, verifiedBy: 'cell-readback' })
        continue
      }
      if (prepared.value !== item.before) {
        throw tableFailure('TABLE_STALE', `The target cell changed from ${JSON.stringify(item.before)} to ${JSON.stringify(prepared.value)} before input; it was not overwritten`, { mutationPossible: false })
      }
      result.attempted = true
      result.mutationPossible = true
      await io.editCell(tab.id, prepared, item.value)
      await io.settle(tab.id)
      const verified = await probeCell(tab.id, selected, item, 'cell', io)
      if (verified.value !== item.value) {
        throw tableFailure('TABLE_VERIFY_FAILED', `Cell readback was ${JSON.stringify(verified.value)} instead of ${JSON.stringify(item.value)}; do not retry blindly`, { actual: verified.value, mutationPossible: true })
      }
      Object.assign(result, { status: 'applied', after: verified.value, verifiedBy: 'cell-readback' })
    } catch (error) {
      failure = {
        index: item.index,
        code: error?.code ?? 'TABLE_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        ...(error?.actual === undefined ? {} : { actual: error.actual }),
      }
      result.status = 'failed'
      result.error = failure
      result.mutationPossible = result.mutationPossible || error?.mutationPossible === true
      break
    }
  }
  if (failure) {
    for (const item of plan.slice(results.length)) {
      results.push({
        index: item.index,
        row: item.rowIndex + 1,
        column: item.columnIndex + 1,
        value: item.value,
        before: item.before,
        status: 'unattempted',
        attempted: false,
        mutationPossible: false,
      })
    }
  }

  let readback
  let readbackError
  try {
    readback = await readSelectedTable(tab.id, selected, io)
  } catch (error) {
    readbackError = error instanceof Error ? error.message : String(error)
  }
  const appliedCount = results.filter(result => result.status === 'applied').length
  const alreadyAppliedCount = results.filter(result => result.status === 'already_applied').length
  const verifiedCount = appliedCount + alreadyAppliedCount
  const status = !failure ? 'completed' : verifiedCount > 0 ? 'partial' : 'failed'
  return {
    op: 'table',
    view: 'none',
    screenshotSkipped: true,
    capture: { status: 'skipped', reason: failure ? 'TABLE_CELL_RESULTS' : 'TABLE_CELL_VERIFIED' },
    tab: io.tabSummary(tab),
    table: {
      action: 'write',
      status,
      index: selected.index,
      editCount: plan.length,
      appliedCount,
      alreadyAppliedCount,
      verifiedCount,
      remainingCount: plan.length - verifiedCount,
      results,
      ...(failure ? { failure } : {}),
      ...(readbackError ? { readbackError } : {}),
    },
    ...(readback ? { tables: [readback] } : {}),
  }
}

export function tableProbe(request) {
  const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim()
  const hidden = element => {
    let current = element
    while (current) {
      if (current.hidden === true || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return true
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return true
      current = current.parentElement
    }
    return false
  }
  const controls = cell => Array.from(cell.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]'))
    .filter(control => !hidden(control) || control.matches('[data-tablenav]'))
  const valueControl = cell => controls(cell).find(control => /column \d+ row \d+ value/u.test(control.getAttribute('aria-label') ?? '')) ?? controls(cell)[0]
  const valueFor = cell => {
    const control = valueControl(cell)
    if (!control) return normalize(cell.innerText ?? cell.textContent)
    if (control.matches('input,textarea')) return String(control.value ?? '')
    return String(control.innerText ?? control.textContent ?? '')
  }
  const editableFor = cell => {
    const editableControls = controls(cell).filter(control => {
      if (control.disabled === true || control.readOnly === true || control.getAttribute('aria-disabled') === 'true') return false
      if (control.matches('[contenteditable="true"]')) return true
      return control.matches('input:not([type]),input[type="text"],input[type="number"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"],textarea')
    })
    return editableControls.length === 1 && cell.getAttribute('aria-readonly') !== 'true'
  }
  const rowHeader = row => row.querySelector(':scope > th[scope="row"],:scope > th.row-header')
  const dataCells = row => Array.from(row.children).filter(cell => {
    if (!cell.matches('td,th')) return false
    return cell !== rowHeader(row) && !cell.matches('.data-grid-header__menu-cell')
  })
  const bodyRows = table => {
    if (table.tBodies?.length) return Array.from(table.tBodies).flatMap(body => Array.from(body.rows))
    return Array.from(table.querySelectorAll('tr')).filter(row => !row.closest('thead,tfoot'))
  }
  const headerName = (cell, index) => {
    const input = Array.from(cell.querySelectorAll('input')).find(control => control.getAttribute('aria-label') === `column ${index + 1} name`)
    const named = input ?? cell.querySelector('.column-header__name')
    if (input) return normalize(input.value || input.placeholder)
    if (named) return normalize(named.value || named.textContent || named.getAttribute('title'))
    const clone = cell.cloneNode(true)
    for (const element of clone.querySelectorAll('button,.resizer,.sr-only')) element.remove()
    return normalize(clone.textContent)
  }
  const readTable = (table, localIndex) => {
    const rows = bodyRows(table).map((row, rowIndex) => {
      const header = rowHeader(row)
      return {
        label: normalize(header?.innerText ?? header?.textContent) || String(rowIndex + 1),
        cells: dataCells(row).slice(0, 20).map(cell => ({ value: valueFor(cell), editable: editableFor(cell) })),
        source: row,
      }
    }).filter(row => row.cells.length > 0)
    const columnCount = rows.reduce((maximum, row) => Math.max(maximum, row.cells.length), 0)
    const headerRows = Array.from(table.tHead?.rows ?? [])
    const candidates = headerRows.map(row => Array.from(row.children).filter(cell => cell.matches('th[scope="col"],th:not([scope])'))).filter(cells => cells.length >= columnCount && columnCount > 0)
    const headerCells = candidates.sort((left, right) => right.length - left.length)[0] ?? []
    const headers = Array.from({ length: columnCount }, (_, index) => headerCells[index] ? headerName(headerCells[index], index) || `Column ${index + 1}` : `Column ${index + 1}`)
    const truncated = rows.length > 50 || rows.some(row => dataCells(row.source).length > 20)
    return {
      localIndex,
      headers,
      rows: rows.slice(0, 50).map(row => ({ label: row.label, cells: row.cells })),
      ...(truncated ? { truncated: true } : {}),
    }
  }
  const candidates = Array.from(document.querySelectorAll('table')).filter(table => {
    if (hidden(table) || table.parentElement?.closest('table')) return false
    return bodyRows(table).some(row => dataCells(row).some(cell => controls(cell).length > 0))
  })
  if (request.mode === 'read') return { tables: candidates.slice(0, 10).map((table, index) => readTable(table, index)) }
  const table = candidates[request.tableIndex]
  if (!table) return { ok: false, code: 'TABLE_NOT_FOUND', message: 'The selected table is no longer visible or connected' }
  const current = readTable(table, request.tableIndex)
  if (request.mode === 'table') return { ok: true, table: current }
  const row = bodyRows(table).filter(item => dataCells(item).length > 0)[request.rowIndex]
  const cell = row ? dataCells(row)[request.columnIndex] : undefined
  if (!cell) return { ok: false, code: 'TABLE_TARGET_NOT_FOUND', message: 'The selected cell no longer exists' }
  if (request.mode === 'cell') return { ok: true, signature: JSON.stringify({ headers: current.headers, rows: current.rows.map(item => item.label), columns: current.rows.reduce((maximum, item) => Math.max(maximum, item.cells.length), 0) }), value: valueFor(cell) }
  if (request.mode !== 'prepare') return { ok: false, code: 'BAD_TABLE', message: 'Unknown table probe mode' }
  if (!editableFor(cell)) return { ok: false, code: 'TABLE_READ_ONLY', message: 'The selected cell is read-only or has ambiguous editable controls' }
  const control = valueControl(cell)
  if (!control) return { ok: false, code: 'TABLE_NOT_EDITABLE', message: 'The selected cell has no editable control' }
  control.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  control.focus({ preventScroll: true })
  if (document.activeElement !== control) return { ok: false, code: 'TABLE_FOCUS_FAILED', message: 'The selected cell could not receive focus' }
  return {
    ok: true,
    signature: JSON.stringify({ headers: current.headers, rows: current.rows.map(item => item.label), columns: current.rows.reduce((maximum, item) => Math.max(maximum, item.cells.length), 0) }),
    value: valueFor(cell),
    editMode: control.hasAttribute('data-tablenav') ? 'enter' : 'direct',
  }
}
