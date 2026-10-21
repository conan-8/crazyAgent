#!/usr/bin/env node
/** Drive the real extension UI through a tab list + tab switch turn. */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9223'
const token = readFileSync(join(ROOT, '.dsh-home', 'browser-agent', 'token'), 'utf8').trim()
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function json(path) { return (await fetch(`${CDP}${path}`)).json() }
async function connect(url) {
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let next = 0
  const pending = new Map()
  ws.on('message', data => {
    const msg = JSON.parse(data.toString())
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result) }
  })
  return {
    send(method, params = {}) { const id = ++next; return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) }) },
    close() { ws.close() },
  }
}
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

const version = await json('/json/version')
const browser = await connect(version.webSocketDebuggerUrl)
let list = await json('/json')
let sideTarget = list.find(t => t.type === 'page' && t.url.includes('/sidepanel/index.html'))
if (!sideTarget) throw new Error('open the side panel page first (edge-e2e.mjs)')
const side = await connect(sideTarget.webSocketDebuggerUrl)
await side.send('Runtime.enable')
await evaluate(side, `chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify({ bridgeUrl: 'ws://127.0.0.1:17871/bridge', token, captureWidth: 1280, quality: 72, autoCapture: true, paused: false })} }).then(() => location.reload()).then(() => 'ok')`).catch(() => {})
side.close()
await sleep(1_200)
list = await json('/json')
sideTarget = list.find(t => t.id === sideTarget.id)
const side2 = await connect(sideTarget.webSocketDebuggerUrl)
await side2.send('Runtime.enable')

let fixture = list.find(t => t.type === 'page' && t.url.includes('article.html'))
let second = list.find(t => t.type === 'page' && t.url.includes('second.html'))
if (!second) {
  const created = await browser.send('Target.createTarget', { url: 'http://127.0.0.1:17872/second.html', background: true })
  await sleep(700)
  list = await json('/json')
  second = list.find(t => t.id === created.targetId)
}
if (!fixture) fixture = list.find(t => t.type === 'page' && t.url.includes('article.html'))
if (!second || !fixture) throw new Error('fixture targets not found')
await browser.send('Target.activateTarget', { targetId: fixture.id })
await sleep(400)

for (let i = 0; i < 40; i += 1) {
  const status = await evaluate(side2, `document.getElementById('status-text')?.textContent ?? ''`)
  if (String(status).includes('Connected')) break
  await sleep(250)
}
console.log('status before send:', await evaluate(side2, `document.getElementById('status-text')?.textContent ?? ''`))
await evaluate(side2, `(() => {
  const input = document.getElementById('input');
  input.value = 'List the tabs in this window. Then switch to the tab titled "Second Fixture Page" and tell me which marker is on it.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('composer').requestSubmit();
  return 'sent';
})()`)

const started = Date.now()
for (let i = 0; i < 160; i += 1) {
  await sleep(500)
  const state = await evaluate(side2, `({
    status: document.getElementById('status-text')?.textContent ?? '',
    transcript: document.getElementById('chat')?.innerText ?? '',
    errors: [...document.querySelectorAll('#chat .bubble.error')].map(e => e.textContent)
  })`)
  if (state.errors.length > 0) { console.error('UI errors:', state.errors); break }
  if (i > 8 && state.status === 'Connected') break
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
const final = await evaluate(side2, `({
  status: document.getElementById('status-text')?.textContent ?? '',
  transcript: document.getElementById('chat')?.innerText ?? '',
  thumbs: document.querySelectorAll('#chat img.thumb').length,
  toolNames: [...document.querySelectorAll('#chat .tool-name')].map(e => e.textContent),
  tabRows: [...document.querySelectorAll('#chat .tab-row')].map(e => e.innerText),
  activeTab: document.getElementById('active-tab')?.textContent ?? '',
  footer: document.getElementById('timing')?.textContent ?? '',
  errors: [...document.querySelectorAll('#chat .bubble.error')].map(e => e.textContent)
})`)
console.log(`elapsed ${elapsed}s`, JSON.stringify(final, null, 2))
side2.close()
browser.close()
if (final.errors.length > 0) process.exit(1)
if (!final.transcript.includes('SECOND-MARKER')) process.exit(2)
if (final.thumbs < 2) process.exit(3)
