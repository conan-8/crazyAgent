#!/usr/bin/env node
/** Exercise the Debug log modal and export from the real extension page. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9224'
const token = readFileSync(join(ROOT, '.dsh-home', 'browser-agent', 'token'), 'utf8').trim()
const extensionId = (() => {
  const hex = createHash('sha256').update(join(ROOT, 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + Number.parseInt(char, 16))).join('')
})()
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
  return { send(method, params = {}) { const id = ++next; return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) }) }, close() { ws.close() } }
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
if (!sideTarget) {
  const created = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
  await sleep(500)
  list = await json('/json')
  sideTarget = list.find(t => t.id === created.targetId)
}
if (!sideTarget) throw new Error('could not open the sidepanel page')
let side = await connect(sideTarget.webSocketDebuggerUrl)
await side.send('Runtime.enable')
await evaluate(side, `chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify({ bridgeUrl: 'ws://127.0.0.1:17871/bridge', token, captureWidth: 1280, quality: 72, autoCapture: true, paused: false })} }).then(() => location.reload()).then(() => 'ok')`).catch(() => {})
side.close()
await sleep(1_200)
list = await json('/json')
const refreshed = list.find(t => t.id === sideTarget.id)
if (!refreshed) throw new Error('sidepanel target disappeared')
side = await connect(refreshed.webSocketDebuggerUrl)
await side.send('Runtime.enable')
await evaluate(side, `window.__downloads = []; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { if (this.download) window.__downloads.push(this.download); return orig.call(this); }; window.__uiErrors = []; window.addEventListener('error', e => window.__uiErrors.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__uiErrors.push(String(e.reason))); 'patched'`)

const fixture = list.find(t => t.type === 'page' && t.url.includes('article.html'))
if (!fixture) throw new Error('fixture page not found')
await browser.send('Target.activateTarget', { targetId: fixture.id })
await sleep(400)
for (let i = 0; i < 40; i += 1) {
  const status = await evaluate(side, `document.getElementById('status-text')?.textContent ?? ''`)
  if (String(status).includes('Connected')) break
  await sleep(250)
}
console.log('status:', await evaluate(side, `document.getElementById('status-text')?.textContent ?? ''`))
await evaluate(side, `(() => { const input = document.getElementById('input'); input.value = 'What section is visible? Answer in one short sentence.'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('composer').requestSubmit(); return 'sent'; })()`)
for (let i = 0; i < 120; i += 1) {
  await sleep(500)
  const status = await evaluate(side, `document.getElementById('status-text')?.textContent ?? ''`)
  if (i > 6 && String(status).includes('Connected')) break
}
console.log('transcript:', await evaluate(side, `document.getElementById('chat')?.innerText.slice(0, 1200)`))

await evaluate(side, `document.getElementById('debug-log').click()`)
await sleep(800)
const statsText = await evaluate(side, `document.getElementById('log-stats')?.textContent ?? ''`)
const signalsText = await evaluate(side, `document.getElementById('log-signals')?.textContent ?? ''`)
console.log('log modal stats:\n' + statsText)
console.log('log modal signals:', signalsText.trim() || '(none)')
await evaluate(side, `document.getElementById('log-export').click()`)
await sleep(2_000)
const result = await evaluate(side, `({ downloads: window.__downloads, toast: document.getElementById('toast')?.textContent ?? '', errors: window.__uiErrors ?? [], modalOpen: !document.getElementById('log-modal').classList.contains('hidden') })`)
console.log('export result:', JSON.stringify(result, null, 2))
side.close()
browser.close()
if (result.errors.length > 0) process.exit(1)
if (!statsText.includes('events:')) process.exit(2)
if (!result.downloads.some(name => String(name).endsWith('.zip'))) process.exit(3)
