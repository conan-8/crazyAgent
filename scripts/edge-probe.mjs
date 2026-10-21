#!/usr/bin/env node
/** Probe the extension executor in a live Chromium via CDP, without the side panel UI. */
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function json(path) {
  const res = await fetch(`${CDP}${path}`)
  return res.json()
}

async function connect(url) {
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let nextId = 0
  const pending = new Map()
  ws.on('message', data => {
    const msg = JSON.parse(data.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else resolve(msg.result)
    }
  })
  return {
    send(method, params = {}) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { ws.close() },
  }
}

const version = await json('/json/version')
const browser = await connect(version.webSocketDebuggerUrl)
const targets = await json('/json')
const fixture = targets.find(t => t.type === 'page' && t.url.includes('article.html'))
if (!fixture) throw new Error('fixture page target not found')

// The unpacked extension ID is the SHA-256 of its absolute path, mapped a-p.
function unpackedId(directory) {
  const hex = createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + Number.parseInt(char, 16))).join('')
}
const extensionId = process.env.EXTENSION_ID ?? unpackedId(new URL('../extension', import.meta.url).pathname)
let sideTarget
try {
  const created = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
  await sleep(500)
  const list = await json('/json')
  sideTarget = list.find(t => t.id === created.targetId)
} catch (error) {
  console.error('createTarget failed', error.message)
}
if (!sideTarget) throw new Error(`could not open the side panel page for extension ${extensionId}`)
console.log('extension', extensionId, 'side target', sideTarget.id)

// Ensure the fixture page is the active tab of the window.
await browser.send('Target.activateTarget', { targetId: fixture.id })
await sleep(600)

const side = await connect(sideTarget.webSocketDebuggerUrl)
await side.send('Runtime.enable')
const evaluation = await side.send('Runtime.evaluate', {
  expression: `(async () => {
    const m = await import('./browser.js');
    const settings = { bridgeUrl: 'ws://127.0.0.1:17871/bridge', token: '', captureWidth: 1280, quality: 72, autoCapture: true, paused: false };
    const r = await m.execute('snapshot', { detail: 'normal' }, settings);
    window.__probe = r;
    return { op: r.op, tab: r.tab, viewport: r.viewport, scroll: r.scroll, image: r.image ? { width: r.image.width, height: r.image.height, bytes: r.image.bytes, len: r.image.data.length, mime: r.image.mimeType, scale: r.image.cssPerImagePixel } : null, timings: { captureMs: r.captureMs, encodeMs: r.encodeMs, totalMs: r.totalMs } };
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
if (evaluation.exceptionDetails) {
  console.error('snapshot exception', JSON.stringify(evaluation.exceptionDetails, null, 2))
  process.exit(1)
}
console.log('snapshot', JSON.stringify(evaluation.result.value, null, 2))
const image = await side.send('Runtime.evaluate', { expression: `'data:' + window.__probe.image.mimeType + ';base64,' + window.__probe.image.data`, returnByValue: true })
if (image.result?.value) {
  writeFileSync('/tmp/crazyagent-live-shot.jpg', Buffer.from(image.result.value.split(',')[1], 'base64'))
  console.log('wrote /tmp/crazyagent-live-shot.jpg')
}

const scroll = await side.send('Runtime.evaluate', {
  expression: `(async () => {
    const m = await import('./browser.js');
    const settings = { bridgeUrl: 'ws://127.0.0.1:17871/bridge', token: '', captureWidth: 1280, quality: 72, autoCapture: true, paused: false };
    const r = await m.execute('scroll', { direction: 'down', amount_px: 420 }, settings);
    window.__probe2 = r;
    return { op: r.op, scroll: r.scroll, moved: r.moved, image: r.image ? { width: r.image.width, height: r.image.height } : null, timings: { captureMs: r.captureMs, encodeMs: r.encodeMs, totalMs: r.totalMs } };
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
if (scroll.exceptionDetails) console.error('scroll exception', JSON.stringify(scroll.exceptionDetails, null, 2))
else console.log('scroll', JSON.stringify(scroll.result.value, null, 2))

const tabs = await side.send('Runtime.evaluate', {
  expression: `(async () => { const m = await import('./browser.js'); return await m.execute('tabs.list', {}, { paused: false }); })()`,
  awaitPromise: true,
  returnByValue: true,
})
if (tabs.exceptionDetails) console.error('tabs exception', JSON.stringify(tabs.exceptionDetails, null, 2))
else console.log('tabs', JSON.stringify(tabs.result.value, null, 2))

side.close()
browser.close()
