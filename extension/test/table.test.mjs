import test from 'node:test'
import assert from 'node:assert/strict'
import { executeTable, parseTableArgs, planTableWrite, tableStructure } from '../sidepanel/table.js'

function fixtureTable() {
  const rows = ['Pink', 'Red-Orange'].map((name, index) => ({
    label: String(index + 1),
    cells: [
      { value: name, editable: true },
      { value: '', editable: true },
      { value: '', editable: true },
      { value: '', editable: false },
    ],
  }))
  return { localIndex: 0, headers: ['Dye', 'Dye Distance', 'Solvent Distance', 'Retention Factor'], rows }
}

function fakeIo(overrides = {}) {
  const current = fixtureTable()
  const calls = []
  const io = {
    current,
    calls,
    getActiveTab: async () => ({ id: 7, title: 'Table fixture', url: 'https://example.test/table' }),
    assertCapturable: async () => {},
    tabSummary: tab => ({ id: tab.id, title: tab.title, url: tab.url }),
    runInAllFrames: async (_tabId, _probe, args) => {
      calls.push(['discover', args[0]])
      return [{ frameId: 0, result: { tables: [structuredClone(current)] } }]
    },
    runInFrame: async (_tabId, _frameId, _probe, args) => {
      const request = args[0]
      calls.push([request.mode, request])
      const signature = tableStructure(current)
      if (request.mode === 'table') return { ok: true, table: structuredClone(current) }
      const cell = current.rows[request.rowIndex]?.cells[request.columnIndex]
      if (!cell) return { ok: false, code: 'TABLE_TARGET_NOT_FOUND', message: 'missing cell' }
      return { ok: true, signature, value: cell.value, ...(request.mode === 'prepare' ? { editMode: 'enter' } : {}) }
    },
    editCell: async (_tabId, _prepared, value) => {
      const prepare = calls.findLast(call => call[0] === 'prepare')?.[1]
      current.rows[prepare.rowIndex].cells[prepare.columnIndex].value = value
      const distance = Number(current.rows[prepare.rowIndex].cells[1].value)
      const solvent = Number(current.rows[prepare.rowIndex].cells[2].value)
      current.rows[prepare.rowIndex].cells[3].value = distance && solvent ? String(distance / solvent) : ''
    },
    settle: async () => {},
    ...overrides,
  }
  return io
}

const validEdit = () => ({ row: 1, column: 'Dye Distance', value: '0.7' })

test('table arguments validate the bounded read/write contract before browser access', () => {
  assert.deepEqual(parseTableArgs({ action: 'read' }), { action: 'read', table: undefined })
  assert.deepEqual(parseTableArgs({ action: 'write', table: 1, edits: [validEdit()] }), { action: 'write', table: 1, edits: [validEdit()] })
  const invalid = [
    {},
    { action: 'other' },
    { action: 'read', edits: [validEdit()] },
    { action: 'read', table: 0 },
    { action: 'write', edits: [] },
    { action: 'write', edits: [{ ...validEdit(), row: 0 }] },
    { action: 'write', edits: [{ ...validEdit(), column: '' }] },
    { action: 'write', edits: [{ ...validEdit(), value: 'two\nlines' }] },
    { action: 'write', edits: [{ ...validEdit(), value: 'has\ttab' }] },
    { action: 'write', edits: [{ ...validEdit(), surprise: true }] },
  ]
  for (const args of invalid) assert.throws(() => parseTableArgs(args), error => error.code === 'BAD_TABLE')
})

test('table write planning resolves exact names and rejects duplicates, ambiguity, and read-only cells', () => {
  const table = fixtureTable()
  const plan = planTableWrite(table, [validEdit(), { row: 2, column: 3, value: '14' }])
  assert.deepEqual(plan.map(item => [item.rowIndex, item.columnIndex]), [[0, 1], [1, 2]])
  assert.throws(() => planTableWrite(table, [validEdit(), { row: 1, column: 2, value: '2' }]), error => error.code === 'TABLE_DUPLICATE_TARGET')
  assert.throws(() => planTableWrite(table, [{ row: 1, column: 4, value: '0.5' }]), error => error.code === 'TABLE_READ_ONLY')
  assert.throws(() => planTableWrite(table, [{ row: 1, column: 'Missing', value: '2' }]), error => error.code === 'TABLE_TARGET_NOT_FOUND')
  table.headers[1] = 'Dye'
  assert.throws(() => planTableWrite(table, [{ row: 1, column: 'Dye', value: '2' }]), error => error.code === 'TABLE_AMBIGUOUS')
})

test('table read returns semantic headers, values, and read-only state', async () => {
  const result = await executeTable({ action: 'read' }, fakeIo())
  assert.equal(result.table.status, 'completed')
  assert.equal(result.table.count, 1)
  assert.deepEqual(result.tables[0].headers, ['Dye', 'Dye Distance', 'Solvent Distance', 'Retention Factor'])
  assert.equal(result.tables[0].rows[0].cells[0].value, 'Pink')
  assert.equal(result.tables[0].rows[0].cells[3].editable, false)
  assert.equal(result.view, 'none')
})

test('table write verifies each target and preserves non-target name cells', async () => {
  const io = fakeIo()
  const edits = [
    { row: 1, column: 'Dye Distance', value: '0.7' },
    { row: 1, column: 'Solvent Distance', value: '14' },
    { row: 2, column: 'Dye Distance', value: '2' },
    { row: 2, column: 'Solvent Distance', value: '14' },
    { row: 2, column: 'Dye', value: 'Red-Orange' },
  ]
  const result = await executeTable({ action: 'write', edits }, io)
  assert.equal(result.table.status, 'completed')
  assert.equal(result.table.appliedCount, 4)
  assert.equal(result.table.alreadyAppliedCount, 1)
  assert.equal(result.table.verifiedCount, 5)
  assert.equal(io.calls.filter(call => call[0] === 'prepare').length, 4)
  assert.deepEqual(io.current.rows.map(row => row.cells[0].value), ['Pink', 'Red-Orange'])
  assert.equal(io.current.rows[0].cells[3].value, String(0.7 / 14))
  assert.equal(result.tables[0].rows[1].cells[1].value, '2')
})

test('table target validation fails before any mutation', async () => {
  const io = fakeIo()
  let edits = 0
  io.editCell = async () => { edits += 1 }
  await assert.rejects(executeTable({ action: 'write', edits: [validEdit(), { row: 2, column: 4, value: 'bad' }] }, io), error => error.code === 'TABLE_READ_ONLY')
  assert.equal(edits, 0)
  assert.equal(io.calls.filter(call => call[0] === 'prepare').length, 0)
})

test('table verification failure reports partial progress and leaves later edits unattempted', async () => {
  const io = fakeIo()
  io.editCell = async () => {}
  const result = await executeTable({ action: 'write', edits: [validEdit(), { row: 1, column: 3, value: '14' }] }, io)
  assert.equal(result.table.status, 'failed')
  assert.equal(result.table.failure.code, 'TABLE_VERIFY_FAILED')
  assert.equal(result.table.results[0].status, 'failed')
  assert.equal(result.table.results[0].mutationPossible, true)
  assert.equal(result.table.results[1].status, 'unattempted')
  assert.equal(result.table.remainingCount, 2)
  assert.ok(result.tables)
})

test('table writes require an explicit table when discovery is ambiguous', async () => {
  const io = fakeIo()
  const original = io.runInAllFrames
  io.runInAllFrames = async (...args) => {
    const frames = await original(...args)
    frames[0].result.tables.push({ ...structuredClone(fixtureTable()), localIndex: 1 })
    return frames
  }
  await assert.rejects(executeTable({ action: 'write', edits: [validEdit()] }, io), error => error.code === 'TABLE_REQUIRED')
  const result = await executeTable({ action: 'write', table: 2, edits: [validEdit()] }, io)
  assert.equal(result.table.status, 'completed')
  assert.equal(result.table.index, 2)
})
