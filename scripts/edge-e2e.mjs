#!/usr/bin/env node
/** Drive the real extension UI in Edge against the running companion. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9223'
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
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
    }
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

async function targetForSidepanel(browser) {
  let list = await json('/json')
  let target = list.find(t => t.type === 'page' && t.url.includes('/sidepanel/index.html'))
  if (!target) {
    const created = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
    await sleep(500)
    list = await json('/json')
    target = list.find(t => t.id === created.targetId)
  }
  if (!target) throw new Error('side panel page target not found')
  return target
}

const version = await json('/json/version')
const browser = await connect(version.webSocketDebuggerUrl)
const sideTarget = await targetForSidepanel(browser)
let side = await connect(sideTarget.webSocketDebuggerUrl)
await side.send('Runtime.enable')
await evaluate(side, `chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify({ bridgeUrl: 'ws://127.0.0.1:17871/bridge', token, captureWidth: 1280, quality: 72, autoCapture: true, paused: false })} }).then(() => location.reload()).then(() => 'reloading')`).catch(() => {})
side.close()
await sleep(1_500)
let list = await json('/json')
const refreshed = list.find(t => t.id === sideTarget.id)
if (!refreshed) throw new Error('side panel target disappeared after reload')
side = await connect(refreshed.webSocketDebuggerUrl)
await side.send('Runtime.enable')

const fixture = list.find(t => t.type === 'page' && t.url.includes('article.html'))
if (!fixture) throw new Error('fixture target not found')
await browser.send('Target.activateTarget', { targetId: fixture.id })
await sleep(500)

// Wait for the app's WebSocket handshake.
for (let i = 0; i < 40; i += 1) {
  const status = await evaluate(side, `document.getElementById('status-text')?.textContent ?? ''`)
  if (String(status).includes('Connected') || String(status).includes('Working')) break
  await sleep(250)
}
const initialStatus = await evaluate(side, `document.getElementById('status-text')?.textContent ?? ''`)
console.log('status before send:', initialStatus)
const before = await evaluate(side, `({ banner: document.getElementById('banner-text')?.textContent, tokenLen: (document.getElementById('setting-token')?.value ?? '').length })`)
console.log('before:', before)

await evaluate(side, `(() => {
  const input = document.getElementById('input');
  input.value = 'What section is visible? Then scroll down by about 700 pixels and tell me which marker is visible.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('composer').requestSubmit();
  return 'sent';
})()`)

const started = Date.now()
let transcript = ''
for (let i = 0; i < 120; i += 1) {
  await sleep(500)
  const state = await evaluate(side, `({
    status: document.getElementById('status-text')?.textContent ?? '',
    transcript: document.getElementById('chat')?.innerText ?? '',
    thumbs: document.querySelectorAll('#chat img.thumb').length,
    toolCards: document.querySelectorAll('#chat .tool-card').length,
    errors: [...document.querySelectorAll('#chat .bubble.error')].map(e => e.textContent)
  })`)
  transcript = state.transcript
  if (state.errors.length > 0) {
    console.error('UI errors:', state.errors)
    break
  }
  if (state.status === 'Connected' && i > 4 && !transcript.includes('Seeing the page')) break
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
const final = await evaluate(side, `({
  status: document.getElementById('status-text')?.textContent ?? '',
  transcript: document.getElementById('chat')?.innerText ?? '',
  thumbs: document.querySelectorAll('#chat img.thumb').length,
  toolCards: document.querySelectorAll('#chat .tool-card').length,
  toolNames: [...document.querySelectorAll('#chat .tool-name')].map(e => e.textContent),
  footer: document.getElementById('timing')?.textContent ?? '',
  errors: [...document.querySelectorAll('#chat .bubble.error')].map(e => e.textContent)
})`)
console.log(`elapsed ${elapsed}s`, JSON.stringify(final, null, 2))
side.close()
browser.close()
if (final.errors.length > 0) process.exit(1)
if (final.thumbs < 1) process.exit(2)
