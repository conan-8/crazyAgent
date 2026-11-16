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

// Metrics for the acceptance record: every executor call, every failed call,
// and every export request (the rate-limited resource) is counted.
const metrics = { executorCalls: 0, failedCalls: 0, exportRequests: 0 }
const started = Date.now()
const evidence = []
let browser
let doc
let panel
let docId
let docTarget
let outcome

// Trash ONLY this run's own document, by its ID, through the same File menu
// path a person uses. The mutation rides Docs' persistent RPC channel, so the
// positive proof is the "File moved to trash" toast, not a tool status.
async function trashOwnDocument() {
  if (!doc || !docId) return { attempted: false, reason: 'no run document was created' }
  try {
    const url = await evaluate(doc, 'location.href')
    if (!url.includes(`/document/d/${docId}/`)) return { attempted: false, docId, reason: 'document target no longer addresses the run document; nothing was touched' }
    const escape = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await doc.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...escape })
    await doc.send('Input.dispatchKeyEvent', { type: 'keyUp', ...escape })
    await sleep(300)
    if (await evaluate(doc, `/moved to trash|in trash/i.test(document.body.innerText || '')`)) {
      return { attempted: true, docId, trashed: true, verifiedBy: 'already-trashed banner' }
    }
    const click = async (x, y) => {
      await doc.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
      await sleep(100)
      await doc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await doc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }
    const file = await evaluate(doc, `(() => {
      const items = [...document.querySelectorAll('[role="menuitem"]')].filter(e => (e.getAttribute('aria-label') || e.textContent || '').trim() === 'File' && e.getBoundingClientRect().width > 0)
      if (items.length !== 1) return null
      const r = items[0].getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    if (!file) return { attempted: true, docId, trashed: false, reason: 'File menu control not found' }
    await click(file.x, file.y)
    let trash = null
    for (let i = 0; i < 20 && !trash; i += 1) {
      trash = await evaluate(doc, `(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')].filter(e => /^Move to trash/.test((e.getAttribute('aria-label') || e.textContent || '').trim()) && e.getBoundingClientRect().width > 0)
        if (items.length !== 1) return null
        const r = items[0].getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (!trash) await sleep(200)
    }
    if (!trash) return { attempted: true, docId, trashed: false, reason: 'Move to trash menu item not found' }
    await click(trash.x, trash.y)
    for (let i = 0; i < 25; i += 1) {
      if (await evaluate(doc, `/moved to trash/i.test(document.body.innerText || '')`)) {
        return { attempted: true, docId, trashed: true, verifiedBy: 'File moved to trash toast' }
      }
      await sleep(200)
    }
    return { attempted: true, docId, trashed: false, reason: 'trash toast never appeared; verify the document manually' }
  } catch (error) {
    return { attempted: true, docId, trashed: false, reason: `cleanup error: ${error.message}` }
  }
}

try {
  const version = await (await fetch(`${CDP}/json/version`)).json()
  browser = await connect(version.webSocketDebuggerUrl)
  const created = await browser.send('Target.createTarget', { url: 'https://docs.google.com/document/create', background: false })
  await sleep(1_500)
  docTarget = (await list()).find(target => target.id === created.targetId)
  assert.ok(docTarget, 'disposable Docs target was created')
  doc = await connect(docTarget.webSocketDebuggerUrl)
  await doc.send('Runtime.enable')
  // Know the run's document ID before readiness, so even a setup failure can
  // trash exactly this document in finally.
  docId = /\/document\/d\/([^/?#]+)/u.exec(docTarget.url)?.[1]
  // Ready means the editor textbox the executor itself targets exists. It lives in a
  // same-origin iframe, and its label is not part of the page's visible text.
  await waitFor(doc, `location.pathname.includes('/document/d/') && [document, ...[...document.querySelectorAll('iframe')].map(frame => { try { return frame.contentDocument } catch { return null } }).filter(Boolean)].some(root => root.querySelector('[role="textbox"][aria-label="Document content"]') !== null)`, 60_000)
  docId = await evaluate(doc, `location.pathname.split('/document/d/')[1].split('/')[0]`)

  let panelTarget = (await list()).find(target => target.type === 'page' && target.url.includes('/sidepanel/index.html'))
  if (!panelTarget) {
    const createdPanel = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
    await sleep(900)
    panelTarget = (await list()).find(target => target.id === createdPanel.targetId)
  }
  assert.ok(panelTarget, 'side panel target not found')
  panel = await connect(panelTarget.webSocketDebuggerUrl)
  await panel.send('Runtime.enable')
  // The panel page runs here as a background tab, and the clipboard-preserving table
  // paste refuses to read the system clipboard from an unfocused document. Emulate
  // focus for this harness page only; the product's own focus check is unchanged.
  await panel.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const tabId = await evaluate(panel, `(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    return tabs.find(tab => tab.url?.includes('/document/d/${docId}/'))?.id
  })()`)
  assert.ok(tabId, 'active disposable Docs tab id')
  const prefix = `const mod = await import('./browser.js')
    const tabId = ${tabId}
    const settings = { ...mod.DEFAULT_SETTINGS }
  `
  const execute = async (tableAction, extra = {}) => {
    metrics.executorCalls += 1
    try {
      const result = await evaluate(panel, `(async () => { ${prefix}
        return await mod.execute('docs', { action: 'table', tableAction: ${JSON.stringify(tableAction)}, ...${JSON.stringify(extra)} }, settings)
      })()`)
      const status = result?.docs?.status
      if (status !== 'completed' && status !== 'already_applied') metrics.failedCalls += 1
      return result
    } catch (error) {
      metrics.failedCalls += 1
      throw error
    }
  }
  // Independent authenticated export. Google rate-limits this endpoint (429);
  // retry a bounded number of times with exponential delays, then STOP with an
  // explicit rate-limit error instead of hammering the account.
  const readExport = async () => {
    let delay = 2_000
    for (let attempt = 1; ; attempt += 1) {
      metrics.exportRequests += 1
      const exported = await evaluate(doc, `(async () => {
        const response = await fetch('/document/d/' + ${JSON.stringify(docId)} + '/export?format=html', { credentials: 'include' })
        return { status: response.status, body: await response.text() }
      })()`)
      if (exported.status === 200) return { blocks: parseDocStructure(exported.body), html: exported.body }
      if (exported.status !== 429 || attempt >= 5) {
        throw new Error(exported.status === 429
          ? `DOCS_EXPORT_RATE_LIMITED: export still 429 after ${attempt} bounded attempts; stop live runs and wait at least 15 minutes before retrying`
          : `independent authenticated export failed with status ${exported.status}`)
      }
      await sleep(delay)
      delay = Math.min(15_000, delay * 2)
    }
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

  const assertCompactCells = html => {
    const styles = new Map([...html.matchAll(/\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/gu)].map(match => [match[1], match[2]]))
    const paragraphs = []
    for (const cell of html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)) {
      for (const paragraph of cell[1].matchAll(/<p\b([^>]*)>/gu)) paragraphs.push(paragraph[1])
    }
    assert.ok(paragraphs.length > 0, 'created table contains cell paragraphs')
    for (const attributes of paragraphs) {
      const classes = /\bclass="([^"]*)"/u.exec(attributes)?.[1]?.split(/\s+/u) ?? []
      const inline = /\bstyle="([^"]*)"/u.exec(attributes)?.[1] ?? ''
      const body = `${classes.map(name => styles.get(name) ?? '').join(';')};${inline}`
      const shorthand = /(?:^|;)\s*padding\s*:\s*0(?:pt|px)?(?:;|$)/iu.test(body)
      const top = /padding-top\s*:\s*0(?:pt|px)?(?:;|$)/iu.test(body)
      const bottom = /padding-bottom\s*:\s*0(?:pt|px)?(?:;|$)/iu.test(body)
      assert.ok(shorthand || top && bottom, `cell paragraph has nonzero vertical spacing: ${body}`)
    }
  }

  const title = `crazyAgent Docs Table Acceptance ${new Date().toISOString()}`
  metrics.executorCalls += 1
  try {
    await evaluate(panel, `(async () => { ${prefix}
      const result = await mod.execute('docs', { action: 'rename', title: ${JSON.stringify(title)} }, settings)
      if (result.docs?.status !== 'renamed') throw new Error(JSON.stringify(result.docs))
      return result.docs.status
    })()`)
  } catch (error) {
    metrics.failedCalls += 1
    throw error
  }

  const values = [
    ['Kerfuffle', 'Gobsmacked', 'Wombat', 'Shenanigans'],
    ['Bumbershoot', 'Flibbertigibbet', 'Discombobulated', 'Malarkey'],
    ['Snickerdoodle', 'Hullabaloo', 'Brouhaha', 'Borborygmus'],
  ]
  evidence.push(completed(await execute('create', { rows: 3, columns: 4, values })))
  const createdExport = await readExport()
  assertCompactCells(createdExport.html)
  evidence.push(completed(await execute('format', { edits: [{ row: 1, bold: true, highlight: '#ffff00' }] })))
  evidence.push(completed(await execute('format', { edits: [{ row: 1, cell_background: '#d9d9d9' }] })))
  evidence.push(completed(await execute('insert_rows', { count: 2 })))
  evidence.push(completed(await execute('insert_columns', { count: 1 })))
  evidence.push(completed(await execute('write', { edits: [
    { row: 2, column: 1, value: 'Kerfuffle' },
    { row: 4, column: 5, value: 'new-row' },
    { row: 5, column: 5, value: 'last-row' },
  ] })))
  evidence.push(completed(await execute('delete_rows', { rows: [5] })))
  evidence.push(completed(await execute('delete_columns', { columns: [5] })))
  evidence.push(completed(await execute('merge', { row: 2, column: 1 })))
  evidence.push(completed(await execute('unmerge', { row: 2, column: 1 })))
  const read = await execute('read')
  assert.equal(read.docs.status, 'completed')
  assert.equal(read.tables[0].rows, 4)
  assert.equal(read.tables[0].columns, 4)

  await doc.send('Page.enable')
  await doc.send('Page.reload', { ignoreCache: true })
  await sleep(2_000)
  await waitFor(doc, `location.pathname.includes('/document/d/') && document.readyState === 'complete'`, 60_000)
  const { blocks } = await readExport()
  const tables = blocks.filter(block => block.kind === 'table')
  assert.equal(tables.length, 1, 'one table persists after reload')
  const finalTable = tables[0]
  assert.equal(finalTable.rows.length, 4)
  assert.equal(finalTable.rows[0].length, 4)
  assert.deepEqual(finalTable.rows.map(row => row.map(item => item.text)), [
    values[0],
    // Merge joins the two cells' paragraphs with a line break; unmerge keeps
    // the combined text in the top-left cell and leaves the other cell empty.
    ['Kerfuffle\nFlibbertigibbet', '', 'Discombobulated', 'Malarkey'],
    values[2],
    ['', '', '', ''],
  ])
  assert.ok(finalTable.rows.every(row => row.every(item => item.rowspan === 1 && item.colspan === 1)), 'unmerge leaves a fully unmerged table')
  for (const headerCell of finalTable.rows[0]) {
    assert.equal(headerCell.background, '#d9d9d9', 'native header cell background persists after reload')
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
      assert.notEqual(item.background, '#d9d9d9', 'no collateral native cell background')
      for (const paragraph of item.paragraphs) {
        for (const run of paragraph.runs) assert.notEqual(run.highlight, '#ffff00', 'no collateral header highlight')
      }
    }
  }

  evidence.push(completed(await execute('delete_table')))
  const afterDelete = await readExport()
  assert.equal(afterDelete.blocks.some(block => block.kind === 'table'), false, 'table deletion persists in the server export')
  outcome = {
    title,
    documentUrl: docTarget.url,
    evidence,
    independentExportVerified: true,
    reloadPersistenceVerified: true,
    compactCellsVerified: true,
    nativeCellBackgroundsVerified: true,
    finalShape: '4 rows × 4 columns before explicit delete_table',
    finalStateVerified: true,
  }
} finally {
  const cleanup = await trashOwnDocument()
  try { panel?.close() } catch {}
  try { doc?.close() } catch {}
  try { browser?.close() } catch {}
  console.log(JSON.stringify({
    ...(outcome ?? { failed: true }),
    durationMs: Date.now() - started,
    metrics,
    cleanup,
  }, null, 2))
}