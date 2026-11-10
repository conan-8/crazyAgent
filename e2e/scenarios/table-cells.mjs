/**
 * A1 seed scenario: set two named data cells in a semantically labelled table.
 *
 * Independent check: the table's committed cell state and displayed input
 * values are read from the fixture DOM, and every non-target cell is compared
 * with its known initial value. The tool result and the model's answer are
 * never consulted.
 */
export const name = 'table-cells'
export const fixture = 'table.html'
export const prompt = 'In the "Dye measurements" table on this page, set the Dye Distance for Yellow to 4.2 and the Solvent Distance for Teal to 1.6. Leave every other cell as it is.'
export const maxTurnSeconds = 120

const ROW_NAMES = ['Pink', 'Red-Orange', 'Orange', 'Yellow', 'Green', 'Teal', 'Aqua']
const COLUMNS = ['Dye', 'Dye Distance', 'Solvent Distance', 'Retention Factor']
const TARGETS = [
  { row: 3, column: 1, label: 'Yellow Dye Distance', value: 4.2 },
  { row: 5, column: 2, label: 'Teal Solvent Distance', value: 1.6 },
]

function initialValue(row, column) {
  return column === 0 ? ROW_NAMES[row] ?? null : ''
}

async function snapshot(ctx) {
  return ctx.evaluate(`(() => {
    const cells = [...document.querySelectorAll('#dyes input[data-row]')].map(input => ({
      row: Number(input.dataset.row),
      column: Number(input.dataset.column),
      value: String(input.value ?? ''),
      committed: String(input.dataset.committed ?? ''),
      readOnly: input.readOnly === true
    }))
    return {
      tableCount: document.querySelectorAll('table').length,
      tableLabel: document.getElementById('dyes')?.getAttribute('aria-label') ?? null,
      headers: [...document.querySelectorAll('.column-header__name')].map(input => String(input.value ?? '')),
      rowHeaders: [...document.querySelectorAll('#dyes tbody th')].map(th => String(th.textContent ?? '')),
      cells,
      events: String(document.getElementById('events')?.textContent ?? '')
    }
  })()`)
}

function numberMatches(value, expected) {
  const trimmed = String(value ?? '').trim()
  return trimmed !== '' && Number(trimmed) === expected
}

export async function check(ctx) {
  let state
  try {
    state = await snapshot(ctx)
  } catch (error) {
    return { status: 'fail', reasons: [`could not read the table state: ${error.message}`], evidence: null }
  }
  let url = null
  try { url = await ctx.currentUrl() } catch { /* ignore */ }
  const urlOk = typeof url !== 'string' || url.length === 0 || url.includes('/table.html')

  const integrity = state.tableCount === 1
    && state.tableLabel === 'Dye measurements'
    && state.headers.join('|') === COLUMNS.join('|')
    && state.rowHeaders.join('|') === ROW_NAMES.map((_, index) => String(index + 1)).join('|')
    && state.cells.length === ROW_NAMES.length * COLUMNS.length
    && state.cells.every(cell => (cell.column === 3) === cell.readOnly)

  const cellAt = (row, column) => state.cells.find(cell => cell.row === row && cell.column === column) ?? null
  const targets = TARGETS.map(target => {
    const cell = cellAt(target.row, target.column)
    return {
      ...target,
      displayed: cell?.value ?? null,
      committed: cell?.committed ?? null,
      displayedMatches: numberMatches(cell?.value, target.value),
      committedMatches: numberMatches(cell?.committed, target.value),
    }
  })
  const collateral = state.cells
    .filter(cell => !TARGETS.some(target => target.row === cell.row && target.column === cell.column))
    .filter(cell => cell.value !== initialValue(cell.row, cell.column) || cell.committed !== initialValue(cell.row, cell.column))
    .map(cell => ({ row: cell.row, column: cell.column, value: cell.value, committed: cell.committed, expected: initialValue(cell.row, cell.column) }))
  const evidence = { url, integrity, targetChecks: targets, collateral: collateral.slice(0, 8), eventsTail: state.events.slice(-160) }

  if (!urlOk) return { status: 'fail', reasons: [`the tracked page is not table.html (${url})`], evidence }
  if (!integrity) return { status: 'fail', reasons: ['the table structure, headers, or read-only cells changed'], evidence }
  if (collateral.length > 0) return { status: 'fail', reasons: [`${collateral.length} non-target cell(s) changed`], evidence }

  const targetsCommitted = targets.every(target => target.committedMatches)
  const targetsDisplayed = targets.every(target => target.displayedMatches)
  if (targetsCommitted && targetsDisplayed) {
    return { status: 'pass', reasons: ['both named cells hold the requested committed values and no other cell changed'], evidence }
  }
  if (targetsCommitted) {
    return { status: 'partial', reasons: ['committed values are right but the displayed input values disagree'], evidence }
  }
  if (targetsDisplayed || targets.some(target => target.displayedMatches || target.committedMatches)) {
    return { status: 'partial', reasons: ['some but not all target cells hold the requested value'], evidence }
  }
  return { status: 'fail', reasons: ['neither requested cell was committed'], evidence }
}

/**
 * Plausible-but-wrong: one collateral cell is committed, while the two target
 * inputs only *display* the requested values (typing without committing).
 */
export async function tamper(ctx) {
  await ctx.evaluate(`(() => {
    const commit = (row, column, value) => {
      const input = document.querySelector('input[data-row="' + row + '"][data-column="' + column + '"]')
      if (!input) return
      input.focus()
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    commit(0, 1, '9.9')
    const yellow = document.querySelector('input[data-row="3"][data-column="1"]')
    if (yellow) yellow.value = '4.2'
    const teal = document.querySelector('input[data-row="5"][data-column="2"]')
    if (teal) teal.value = '1.6'
    return true
  })()`)
}