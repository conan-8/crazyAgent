#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9239'
const BASE = process.env.FIXTURE_URL ?? 'http://127.0.0.1:17872'
const extensionId = (() => {
  const hex = createHash('sha256').update(join(process.cwd(), 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()
const list = async () => (await fetch(`${CDP}/json`)).json()

async function connect(url) {
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let seq = 0
  const pending = new Map()
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
    if (!message.id || !pending.has(message.id)) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  return {
    send(method, params = {}) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { ws.close() },
  }
}

const targets = await list()
let panelTarget = targets.find(target => target.type === 'page' && target.url.includes('/sidepanel/index.html'))
if (!panelTarget) {
  const version = await (await fetch(`${CDP}/json/version`)).json()
  const browser = await connect(version.webSocketDebuggerUrl)
  const created = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
  await new Promise(resolve => setTimeout(resolve, 900))
  panelTarget = (await list()).find(target => target.id === created.targetId)
  browser.close()
}
assert.ok(panelTarget, 'side panel target not found')
const panel = await connect(panelTarget.webSocketDebuggerUrl)
await panel.send('Runtime.enable')
async function evaluate(expression) {
  const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

const fixture = await evaluate(`(async () => {
  const tabs = await chrome.tabs.query({})
  let tab = tabs.find(item => item.url?.includes('/table.html'))
  if (!tab) tab = await chrome.tabs.create({ url: '${BASE}/table.html', active: true })
  else {
    await chrome.tabs.update(tab.id, { active: true, url: '${BASE}/table.html' })
  }
  await new Promise(resolve => setTimeout(resolve, 900))
  return { id: tab.id }
})()`)
assert.ok(fixture?.id, 'fixture tab id')
const tabId = fixture.id
const prefix = `const mod = await import('./browser.js')
  const tabId = ${tabId}
  const settings = { ...mod.DEFAULT_SETTINGS }
  const committed = async () => (await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Array.from(document.querySelectorAll('input[data-row]')).map(input => ({
      row: Number(input.dataset.row), column: Number(input.dataset.column), value: input.dataset.committed,
    })),
  }))[0].result
  const commits = async () => (await chrome.scripting.executeScript({
    target: { tabId }, func: () => document.getElementById('events')?.textContent ?? '',
  }))[0].result
`

const initial = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('table', { action: 'read' }, settings)
  return { summary: result.table, tables: result.tables, image: result.image, commits: await commits() }
})()`)
assert.equal(initial.summary.status, 'completed')
assert.equal(initial.summary.count, 1)
assert.equal(initial.tables.length, 1)
assert.deepEqual(initial.tables[0].headers, ['Dye', 'Dye Distance', 'Solvent Distance', 'Retention Factor'])
assert.equal(initial.tables[0].rows.length, 7)
assert.equal(initial.image, undefined)
assert.match(initial.commits, /commits 0/)
console.log('PASS semantic table discovery — 7 rows, 4 named columns, text only')

const rejected = await evaluate(`(async () => { ${prefix}
  let error
  try {
    await mod.execute('table', { action: 'write', edits: [
      { row: 1, column: 'Dye Distance', value: '0.7' },
      { row: 1, column: 'Retention Factor', value: '0.05' },
    ] }, settings)
  } catch (caught) { error = { code: caught.code, message: caught.message } }
  return { error, values: await committed(), commits: await commits() }
})()`)
assert.equal(rejected.error?.code, 'TABLE_READ_ONLY')
assert.match(rejected.commits, /commits 0/)
assert.ok(rejected.values.every(cell => cell.value === '' || cell.column === 0), 'no value was mutated by the rejected write')
console.log('PASS read-only target rejects the complete write before input')

const distances = [0.7, 2, 4.2, 7, 6, 3.5, 5]
const edits = distances.flatMap((value, index) => [
  { row: index + 1, column: 'Dye Distance', value: String(value) },
  { row: index + 1, column: 'Solvent Distance', value: '14' },
])
const written = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('table', { action: 'write', edits: ${JSON.stringify(edits)} }, settings)
  return { summary: result.table, tables: result.tables, image: result.image, values: await committed(), commits: await commits() }
})()`)
assert.equal(written.summary.status, 'completed')
assert.equal(written.summary.appliedCount, 14)
assert.equal(written.summary.verifiedCount, 14)
assert.equal(written.summary.remainingCount, 0)
assert.equal(written.image, undefined)
assert.match(written.commits, /commits 14/)
const names = ['Pink', 'Red-Orange', 'Orange', 'Yellow', 'Green', 'Teal', 'Aqua']
for (let row = 0; row < 7; row += 1) {
  const cells = written.values.filter(cell => cell.row === row).sort((left, right) => left.column - right.column).map(cell => cell.value)
  assert.deepEqual(cells, [names[row], String(distances[row]), '14', String(Number((distances[row] / 14).toFixed(4)))], `row ${row + 1} committed state`)
}
assert.deepEqual(written.tables[0].rows.map(row => row.cells[0].value), names)
console.log('PASS 14-cell trusted write — all values and formulas committed; all 7 names preserved')

console.log('\nALL TABLE CHECKS PASSED')
panel.close()
