#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'
import { parseDocStructure } from '../extension/sidepanel/docs-structure.js'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9233'
const extensionId = (() => {
  const hex = createHash('sha256').update(join(process.cwd(), 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
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

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

async function waitFor(client, expression, timeoutMs = 45_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(client, expression)) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

const initialTargets = await list()
const docsHome = initialTargets.find(target => target.type === 'page' && /docs\.google\.com|accounts\.google\.com/u.test(target.url))
if (!docsHome) throw new Error('Open Google Docs in the isolated browser before running this acceptance harness')
const home = await connect(docsHome.webSocketDebuggerUrl)
const homeState = await evaluate(home, '({url:location.href,text:document.body?.innerText.slice(0,1500)})')
home.close()
if (homeState.url.includes('accounts.google.com') || /Sign in\s+to continue to Google Docs/u.test(homeState.text)) {
  throw new Error('AUTH_REQUIRED: the isolated Docs profile is signed out; no document was created or modified')
}

const version = await (await fetch(`${CDP}/json/version`)).json()
const browser = await connect(version.webSocketDebuggerUrl)
const created = await browser.send('Target.createTarget', { url: 'https://docs.google.com/document/create', background: false })
await sleep(1_500)
const docTarget = (await list()).find(target => target.id === created.targetId)
assert.ok(docTarget, 'disposable Docs target was created')
const doc = await connect(docTarget.webSocketDebuggerUrl)
await doc.send('Runtime.enable')
await waitFor(doc, `location.pathname.includes('/document/d/') && document.body?.innerText.includes('Document content')`, 60_000)

let panelTarget = (await list()).find(target => target.type === 'page' && target.url.includes('/sidepanel/index.html'))
if (!panelTarget) {
  const createdPanel = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
  await sleep(900)
  panelTarget = (await list()).find(target => target.id === createdPanel.targetId)
}
assert.ok(panelTarget, 'side panel target not found')
const panel = await connect(panelTarget.webSocketDebuggerUrl)
await panel.send('Runtime.enable')
const tabId = await evaluate(panel, `(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  return tabs.find(tab => tab.url?.includes('/document/d/'))?.id
})()`)
assert.ok(tabId, 'active disposable Docs tab id')
const prefix = `const mod = await import('./browser.js')
  const tabId = ${tabId}
  const settings = { ...mod.DEFAULT_SETTINGS }
`
const execute = (tableAction, extra = {}) => evaluate(panel, `(async () => { ${prefix}
  return await mod.execute('docs', { action: 'table', tableAction: ${JSON.stringify(tableAction)}, ...${JSON.stringify(extra)} }, settings)
})()`)
const readExport = async () => {
  const exported = await evaluate(doc, `(async () => {
    const id = location.pathname.split('/document/d/')[1].split('/')[0]
    const response = await fetch('/document/d/' + id + '/export?format=html', { credentials: 'include' })
    return { status: response.status, body: await response.text() }
  })()`)
  assert.equal(exported.status, 200, 'independent authenticated export succeeds')
  return parseDocStructure(exported.body)
}
const summarize = result => ({
  action: result.docs?.tableAction,
  status: result.docs?.status,
  failure: result.docs?.failure,
  verifiedCount: result.docs?.verifiedCount,
  completedCount: result.docs?.completedCount,
})
const completed = result => {
  assert.equal(result.docs?.status, 'completed', JSON.stringify(result.docs))
  return summarize(result)
}

const started = Date.now()
const evidence = []
try {
  const title = `CrazyAgent Docs Table Acceptance ${new Date().toISOString()}`
  await evaluate(panel, `(async () => { ${prefix}
    const result = await mod.execute('docs', { action: 'rename', title: ${JSON.stringify(title)} }, settings)
    if (result.docs?.status !== 'renamed') throw new Error(JSON.stringify(result.docs))
    return result.docs.status
  })()`)

  const values = [
    ['Kerfuffle', 'Gobsmacked', 'Wombat', 'Shenanigans'],
    ['Bumbershoot', 'Flibbertigibbet', 'Discombobulated', 'Malarkey'],
    ['Snickerdoodle', 'Hullabaloo', 'Brouhaha', 'Borborygmus'],
  ]
  evidence.push(completed(await execute('create', { rows: 3, columns: 4, values })))
  evidence.push(completed(await execute('format', { edits: [{ row: 1, bold: true, highlight: '#ffff00' }] })))
  evidence.push(completed(await execute('insert_rows', { count: 2 })))
  evidence.push(completed(await execute('insert_columns', { count: 1 })))
  evidence.push(completed(await execute('write', { edits: [
    { row: 2, column: 1, value: 'Kerfuffle' },
    { row: 4, column: 5, value: 'new-row' },
    { row: 5, column: 5, value: 'last-row' },
  ] })))
  evidence.push(completed(await execute('delete_rows', { rows: [5] })))
  evidence.push(completed(await execute('delete_columns', { columns: [5] })))
  const read = await execute('read')
  assert.equal(read.docs.status, 'completed')
  assert.equal(read.tables[0].rows, 4)
  assert.equal(read.tables[0].columns, 4)

  await doc.send('Page.enable')
  await doc.send('Page.reload', { ignoreCache: true })
  await sleep(2_000)
  await waitFor(doc, `location.pathname.includes('/document/d/') && document.readyState === 'complete'`, 60_000)
  const blocks = await readExport()
  const tables = blocks.filter(block => block.kind === 'table')
  assert.equal(tables.length, 1, 'one table persists after reload')
  const finalTable = tables[0]
  assert.equal(finalTable.rows.length, 4)
  assert.equal(finalTable.rows[0].length, 4)
  assert.deepEqual(finalTable.rows.map(row => row.map(item => item.text)), [
    values[0],
    ['Kerfuffle', ...values[1].slice(1)],
    values[2],
    ['', '', '', ''],
  ])
  for (const headerCell of finalTable.rows[0]) {
    for (const paragraph of headerCell.paragraphs) {
      for (const run of paragraph.runs) {
        if (!run.text) continue
        assert.equal(run.bold, true, 'header text remains bold after reload')
        assert.equal(run.highlight, '#ffff00', 'header text remains highlighted after reload')
      }
    }
  }
  for (const row of finalTable.rows.slice(1)) {
    for (const item of row) {
      for (const paragraph of item.paragraphs) {
        for (const run of paragraph.runs) assert.notEqual(run.highlight, '#ffff00', 'no collateral header highlight')
      }
    }
  }

  evidence.push(completed(await execute('delete_table')))
  const afterDelete = await readExport()
  assert.equal(afterDelete.some(block => block.kind === 'table'), false, 'table deletion persists in the server export')
  console.log(JSON.stringify({
    durationMs: Date.now() - started,
    title,
    documentUrl: docTarget.url,
    evidence,
    independentExportVerified: true,
    reloadPersistenceVerified: true,
    finalShape: '4 rows × 4 columns before explicit delete_table',
    finalStateVerified: true,
  }, null, 2))
} finally {
  panel.close()
  doc.close()
  browser.close()
}
