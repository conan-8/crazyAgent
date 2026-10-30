#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9233'
const BASE = process.env.FIXTURE_URL ?? 'http://127.0.0.1:17872'
const PORT = Number(process.env.BRIDGE_PORT ?? 17_873)
const token = readFileSync(join(process.cwd(), '.dsh-home', 'browser-agent', 'token'), 'utf8').trim()
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
let panel = await connect(panelTarget.webSocketDebuggerUrl)
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
    && document.getElementById('activity-phase').textContent === 'Ready'
    && document.getElementById('session-info').dataset.model?.length > 0
    && !document.getElementById('send').disabled`, 90_000)
}

await evaluate(`chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify({
  bridgeUrl: `ws://127.0.0.1:${PORT}/bridge`, token, captureWidth: 1280, quality: 72, autoCapture: true, paused: false,
})} }).then(() => location.reload()).then(() => 'reloading')`).catch(() => {})
panel.close()
await sleep(1_500)
panelTarget = (await list()).find(target => target.id === panelTarget.id)
assert.ok(panelTarget, 'side panel did not return after companion configuration')
panel = await connect(panelTarget.webSocketDebuggerUrl)
await panel.send('Runtime.enable')

const started = Date.now()
try {
  await waitFor(`document.getElementById('status-text').textContent === 'Connected'`, 90_000)
  await setEffort('medium')
  assert.ok(await evaluate(`document.getElementById('setting-model').value.length > 0`), 'a model is selected')
  const dispatch = await evaluate(`(async () => {
    const tabs = await chrome.tabs.query({})
    let fixture = tabs.find(tab => tab.url?.includes('/find.html'))
    if (!fixture) fixture = await chrome.tabs.create({ url: '${BASE}/find.html', active: true })
    else await chrome.tabs.update(fixture.id, { active: true, url: '${BASE}/find.html' })
    document.getElementById('new-chat').click()
    const input = document.getElementById('input')
    input.value = ${JSON.stringify('On the current fixture page, find the unique off-screen marker UNIQUE-FIND-MARKER, bring it into view, and click the Destination action button. Do not change any input or other text.')}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('send').click()
    return {
      started: !document.getElementById('stop').classList.contains('hidden'),
      phase: document.getElementById('activity-phase').textContent,
      banner: document.getElementById('banner-text').textContent,
    }
  })()`)
  assert.equal(dispatch.started, true, `chat.send did not start a turn: ${dispatch.phase}; ${dispatch.banner}`)
  await waitFor(`document.getElementById('stop').classList.contains('hidden')
    && document.querySelectorAll('.activity-answer').length > 0`, 180_000)
  const evidence = await evaluate(`(async () => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find(item => item.url?.includes('/find.html'))
    const state = (await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        destination: document.getElementById('destination-state')?.textContent,
        clicks: document.getElementById('click-count')?.textContent,
        value: document.getElementById('focus-field')?.value,
        markerTop: document.getElementById('destination')?.getBoundingClientRect().top,
      }),
    }))[0].result
    return {
      state,
      answers: [...document.querySelectorAll('.answer-text')].map(node => node.textContent),
      toolNames: [...document.querySelectorAll('.activity-entry.tool .act-kind')].map(node => node.textContent),
      timing: document.getElementById('timing')?.textContent ?? '',
    }
  })()`)
  assert.equal(evidence.state.destination, 'destination activated', 'the intended button changed independent page state')
  assert.equal(evidence.state.clicks, 'clicks 1', 'exactly one page click was dispatched')
  assert.equal(evidence.state.value, 'preserve this value', 'input content was preserved')
  assert.ok(evidence.toolNames.includes('find'), 'the model selected browser_find without being told a tool name')
  for (const forbidden of ['type', 'press key', 'batch']) {
    assert.equal(evidence.toolNames.includes(forbidden), false, `${forbidden} was not needed for the find task`)
  }
  console.log(JSON.stringify({
    durationMs: Date.now() - started,
    answers: evidence.answers,
    toolNames: evidence.toolNames,
    timing: evidence.timing,
    finalState: evidence.state,
    finalStateVerified: true,
  }, null, 2))
} finally {
  await setEffort('auto').catch(error => console.error(`effort restore failed: ${error.message}`))
  panel.close()
}
