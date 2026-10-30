#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9233'
const BASE = process.env.FIXTURE_URL ?? 'http://127.0.0.1:17872'
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

let panelTarget = (await list()).find(target => target.type === 'page' && target.url.includes('/sidepanel/index.html'))
if (!panelTarget) {
  const version = await (await fetch(`${CDP}/json/version`)).json()
  const browser = await connect(version.webSocketDebuggerUrl)
  const created = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
  await sleep(900)
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
async function waitFor(expression, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}
async function setEffort(effort) {
  await evaluate(`(() => {
    document.getElementById('settings').click()
    document.querySelector('[data-effort="${effort}"]').click()
    document.getElementById('settings-save').click()
  })()`)
  await waitFor(`document.querySelector('[data-effort="${effort}"]').classList.contains('active')
    && document.getElementById('stop').classList.contains('hidden')
    && document.getElementById('activity-phase').textContent === 'Ready'`, 90_000)
}

const distances = [0.7, 2, 4.2, 7, 6, 3.5, 5]
const names = ['Pink', 'Red-Orange', 'Orange', 'Yellow', 'Green', 'Teal', 'Aqua']
const started = Date.now()
try {
  await waitFor(`document.getElementById('status-text').textContent === 'Connected'
    && document.getElementById('setting-model').value.length > 0`, 90_000)
  await setEffort('medium')
  await evaluate(`(async () => {
    const tabs = await chrome.tabs.query({ windowId: (await chrome.windows.getCurrent()).id })
    let fixture = tabs.find(tab => tab.url?.includes('/table.html'))
    if (!fixture) fixture = await chrome.tabs.create({ url: '${BASE}/table.html', active: true })
    else await chrome.tabs.update(fixture.id, { active: true, url: '${BASE}/table.html' })
    document.getElementById('new-chat').click()
    const input = document.getElementById('input')
    input.value = ${JSON.stringify(`Fill the dye table with these Dye Distance measurements: Pink 0.7, Red-Orange 2, Orange 4.2, Yellow 7, Green 6, Teal 3.5, Aqua 5. Set every Solvent Distance to 14. Keep every dye name unchanged.`)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('send').click()
  })()`)
  await waitFor(`document.getElementById('stop').classList.contains('hidden')
    && document.querySelectorAll('.activity-answer').length > 0`, 180_000)
  const evidence = await evaluate(`(async () => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find(item => item.url?.includes('/table.html'))
    const values = (await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => Array.from(document.querySelectorAll('input[data-row]')).map(input => ({
        row: Number(input.dataset.row), column: Number(input.dataset.column), value: input.dataset.committed,
      })),
    }))[0].result
    const commits = (await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: () => document.getElementById('events')?.textContent ?? '',
    }))[0].result
    return {
      values, commits,
      answers: [...document.querySelectorAll('.answer-text')].map(node => node.textContent),
      toolNames: [...document.querySelectorAll('.tool-name')].map(node => node.textContent),
    }
  })()`)
  for (let row = 0; row < 7; row += 1) {
    const cells = evidence.values.filter(cell => cell.row === row).sort((left, right) => left.column - right.column).map(cell => cell.value)
    assert.deepEqual(cells, [names[row], String(distances[row]), '14', String(Number((distances[row] / 14).toFixed(4)))], `row ${row + 1} committed state`)
  }
  assert.match(evidence.commits, /commits 14/)
  assert.ok(evidence.toolNames.includes('browser_table'), 'the model used browser_table')
  for (const forbidden of ['browser_batch', 'browser_click_at', 'browser_press_key', 'browser_type']) {
    assert.equal(evidence.toolNames.includes(forbidden), false, `${forbidden} was not used for the semantic table task`)
  }
  console.log(JSON.stringify({
    durationMs: Date.now() - started,
    answers: evidence.answers,
    commits: evidence.commits,
    tableToolCalls: evidence.toolNames.filter(name => name === 'browser_table').length,
    primitiveMutationUsed: false,
    finalStateVerified: true,
  }, null, 2))
} finally {
  await setEffort('auto').catch(error => console.error(`effort restore failed: ${error.message}`))
  panel.close()
}
