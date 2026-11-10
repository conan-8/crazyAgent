#!/usr/bin/env node
/**
 * Real-extension check of what the user sees while the agent works: the agent's
 * glowing cursor, and no hitboxes. A fresh isolated Edge profile, the real
 * service worker and Bridge. Page effects and on-screen pixels are read over a
 * separate CDP connection, independently of tool results.
 *
 *   node scripts/edge-cursor-e2e.mjs            # headless
 *   HEADED=1 node scripts/edge-cursor-e2e.mjs   # visible window
 *
 * A direct executor check: it does not evaluate model decisions.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Bridge } from '../companion/bridge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
const CDP_PORT = Number(process.env.CDP_PORT ?? 9353)
const CDP = `http://127.0.0.1:${CDP_PORT}`
const TOKEN = 'cursor-e2e-token'
const USER_DIR = mkdtempSync(join(tmpdir(), 'ca-edge-cursor-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(what, predicate, timeoutMs = 10_000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    assert.ok(Date.now() - started < timeoutMs, `timed out waiting for ${what}`)
    await sleep(100)
  }
}

async function cdp(url) {
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let seq = 0
  const pending = new Map()
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  return {
    send(method, params = {}) {
      const id = ++seq
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value
    },
    close() { ws.close() },
  }
}

const targets = async () => (await fetch(`${CDP}/json`)).json()

const PAGE = `<!doctype html><meta charset=utf-8><title>Cursor fixture</title>
<style>html,body{margin:0;background:#fff}button{position:fixed;width:150px;height:44px;background:#eee;border:1px solid #888}</style>
<button id=go style="left:700px;top:500px" onclick="window.count=(window.count||0)+1;document.getElementById('n').textContent=window.count">Increment</button>
<button id=noop style="left:120px;top:90px">Does nothing</button>
<span id=n style="position:fixed;left:20px;top:300px;color:#333">0</span>`

const results = []
const pass = name => { results.push(name); process.stdout.write(`ok - ${name}\n`) }

// Runs inside the fixture page: decoding is only used to read pixels back.
const YELLOW = 'r > 225 && g > 165 && g < 225 && b < 110'
const scanImage = (base64, mimeType) => `(async () => {
  const blob = await (await fetch('data:${mimeType};base64,${base64}')).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  let count = 0, sumX = 0, sumY = 0, minX = Infinity, minY = Infinity;
  for (let y = 0; y < bitmap.height; y += 1) for (let x = 0; x < bitmap.width; x += 1) {
    const i = (y * bitmap.width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    if (${YELLOW}) { count += 1; sumX += x; sumY += y; minX = Math.min(minX, x); minY = Math.min(minY, y); }
  }
  return { count, x: count ? sumX / count : null, y: count ? sumY / count : null, minX, minY, width: bitmap.width, height: bitmap.height };
})()`

let edge
let bridge
let browser
let page
const pageHttp = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })

async function run() {
  await new Promise(resolve => pageHttp.listen(0, '127.0.0.1', resolve))
  const pageUrl = `http://127.0.0.1:${pageHttp.address().port}/`
  const shown = []
  bridge = new Bridge({ host: '127.0.0.1', port: 0, token: TOKEN, log: () => {}, onChat() {}, onNewChat() {}, uiGraceMs: 0, onImage: info => shown.push(info.image) })
  await bridge.start()
  const bridgeUrl = `ws://127.0.0.1:${bridge.port}/bridge`
  const command = (op, args = {}, timeoutMs = 20_000) => bridge.requestUi({ op, args }, 'e2e', timeoutMs, { wait: false })

  edge = spawn(EDGE_BIN, [
    `--user-data-dir=${USER_DIR}`,
    `--load-extension=${join(ROOT, 'extension')}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1200,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    ...(process.env.HEADED ? [] : ['--headless=new']),
    pageUrl,
  ], { detached: true, stdio: 'ignore' })

  const version = await until('Edge CDP', async () => { try { return await (await fetch(`${CDP}/json/version`)).json() } catch { return false } }, 20_000)
  browser = await cdp(version.webSocketDebuggerUrl)
  const worker = await until('the extension service worker', async () => (await targets()).find(target => target.type === 'service_worker' && target.url.includes('background.js')), 20_000)
  const workerCdp = await cdp(worker.webSocketDebuggerUrl)
  const pageTarget = await until('the fixture page', async () => (await targets()).find(target => target.type === 'page' && target.url.startsWith(pageUrl)))
  page = await cdp(pageTarget.webSocketDebuggerUrl)
  const read = expression => page.evaluate(expression)

  await until('the worker APIs', () => workerCdp.evaluate('typeof chrome.storage?.local?.set === "function" && typeof chrome.alarms?.create === "function"'), 8_000)
  await workerCdp.evaluate(`chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify({ bridgeUrl, token: TOKEN, captureWidth: 1280, quality: 72, autoCapture: true, paused: false })}, 'crazyagent.disclaimerPending': false })`)
  await workerCdp.evaluate(`chrome.alarms.create('crazyagent-keepalive-now', { when: Date.now() + 100 })`).catch(() => {})
  await until('the worker to claim the executor', () => bridge.executorHost() === 'background', 40_000)

  // What is really on screen, not what the agent was given.
  const screen = async () => {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    return read(scanImage(data, 'image/png'))
  }
  const cursorHosts = () => read(`document.querySelectorAll('[data-crazyagent-cursor]').length`)

  await assert.rejects(until('no cursor outside a turn', async () => (await cursorHosts()) > 0, 1_500), /timed out/)
  pass('no cursor is shown outside a turn')

  bridge.sendToUi({ v: 1, type: 'chat.user', turnId: 'turn-e2e', origin: 'remote', text: 'x', imageCount: 0 })
  await until('the cursor to appear', async () => (await cursorHosts()) === 1)
  await sleep(500)
  const appeared = await until('yellow pixels on screen', async () => {
    const seen = await screen()
    return seen.count > 40 ? seen : false
  })
  pass(`the cursor glows on screen (${appeared.count} yellow px)`)
  if (process.env.CURSOR_SHOT) {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    writeFileSync(process.env.CURSOR_SHOT, Buffer.from(data, 'base64'))
  }

  // Hitboxes: nothing on the page, boxes only on the model's copy.
  const view = await command('snapshot', { detail: 'normal' })
  assert.ok(view.labels.length >= 2, 'the agent still receives its labels')
  assert.equal(await read(`document.querySelectorAll('#__crazyagent_label_overlay').length`), 0)
  const button = view.labels.find(label => label.text === 'Increment')
  assert.ok(button, 'the target is labelled')
  const onPage = await read(`(() => {
    const walker = [...document.documentElement.querySelectorAll('*')];
    return walker.filter(node => node.textContent === ${JSON.stringify(String(button.id))} && node.id !== 'n').length;
  })()`)
  assert.equal(onPage, 0, 'no badge text exists in the page')
  pass('the page holds no hitbox overlay or badge during a turn')

  const modelCopy = await read(scanImage(view.image.data, view.image.mimeType))
  assert.ok(modelCopy.count > 200, `the model's copy has its boxes and badges: ${JSON.stringify(modelCopy)}`)
  const scale = view.image.width / view.viewport.width
  assert.ok(modelCopy.minX < (view.labels.reduce((min, label) => Math.min(min, label.x), Infinity) + 8) * scale, 'boxes sit at the label positions')
  pass(`the model's screenshot still carries the numbered boxes (${modelCopy.count} yellow px)`)

  const clean = shown.at(-1)
  assert.notEqual(clean.data, view.image.data, 'people get a different copy')
  assert.equal(clean.width, view.image.width)
  const cleanPixels = await read(scanImage(clean.data, clean.mimeType))
  assert.ok(cleanPixels.count < 12, `no boxes and no cursor in the clean copy: ${JSON.stringify(cleanPixels)}`)
  pass(`the phone/sidebar copy has no boxes and no cursor (${cleanPixels.count} yellow px)`)
  assert.equal(JSON.stringify(view).includes('displayImage'), false, 'the clean copy never reaches the model')

  await until('the cursor to fade back in', async () => (await screen()).count > 40, 3_000)

  // Idle: stays where it is and grows and shrinks.
  const breaths = []
  for (let sample = 0; sample < 10; sample += 1) {
    breaths.push(await screen())
    await sleep(220)
  }
  const sizes = breaths.map(seen => seen.count)
  const moved = Math.max(...breaths.map(seen => Math.hypot(seen.x - breaths[0].x, seen.y - breaths[0].y)))
  assert.ok(moved < 12, `the idle cursor stays put: ${moved}`)
  assert.ok(Math.max(...sizes) / Math.min(...sizes) > 1.25, `the idle cursor breathes: ${sizes}`)
  pass(`the idle cursor breathes in place (${Math.min(...sizes)}-${Math.max(...sizes)} yellow px, moved ${moved.toFixed(1)} px)`)

  // A click: exactly one, on target, with the cursor having travelled there.
  const clicked = await command('click', { label: button.id, view: 'none' })
  assert.equal(clicked.ok ?? true, true)
  const atTarget = await screen()
  assert.equal(await read(`window.count`), 1, 'exactly one click reached the page')
  assert.equal(await read(`document.getElementById('n').textContent`), '1')
  const centre = { x: button.x + button.w / 2, y: button.y + button.h / 2 }
  const off = Math.hypot(atTarget.x - centre.x, atTarget.y - centre.y)
  assert.ok(off < 70, `the cursor went to the button: ${JSON.stringify(atTarget)} vs ${JSON.stringify(centre)}`)
  pass(`the click landed once with the cursor on the button (${Math.round(off)} px away)`)

  const noopLabel = view.labels.find(label => label.text === 'Does nothing')
  const noop = await command('click', { label: noopLabel.id, view: 'none' })
  assert.equal(noop.changed, false, 'the cursor does not count as a page change')
  assert.equal(await read(`window.count`), 1)
  pass('a no-op click still reports no change')

  const hit = await read(`document.elementFromPoint(${centre.x}, ${centre.y}).id`)
  assert.equal(hit, 'go', 'the cursor never takes a hit')

  // Survives a reload mid-turn.
  await read(`location.reload()`).catch(() => {})
  await until('the cursor after a reload', async () => { try { return (await cursorHosts()) === 1 } catch { return false } }, 8_000)
  pass('the cursor comes back after the page reloads mid-turn')

  bridge.sendToUi({ v: 1, type: 'chat.done', text: 'done' })
  await until('the cursor to leave', async () => (await cursorHosts()) === 0, 4_000)
  pass('the cursor leaves when the turn ends')

  // If the extension dies mid-turn, the cursor must not stay forever.
  bridge.sendToUi({ v: 1, type: 'chat.user', turnId: 'turn-e2e-2', origin: 'remote', text: 'y', imageCount: 0 })
  await until('the cursor on the second turn', async () => (await cursorHosts()) === 1)
  await browser.send('Target.closeTarget', { targetId: worker.id ?? worker.targetId })
  const killedAt = Date.now()
  await until('the orphaned cursor to remove itself', async () => (await cursorHosts()) === 0, 25_000)
  pass(`an orphaned cursor removes itself after ${((Date.now() - killedAt) / 1000).toFixed(0)} s`)
  workerCdp.close()
}

let failed = false
try {
  await run()
  process.stdout.write(`\n${results.length} checks passed\n`)
} catch (error) {
  failed = true
  process.stderr.write(`\nFAILED after ${results.length} checks: ${error.stack ?? error}\n`)
} finally {
  page?.close()
  browser?.close()
  await bridge?.stop().catch(() => {})
  pageHttp.close()
  // Only the process group this script started.
  if (edge?.pid) { try { process.kill(-edge.pid, 'SIGTERM') } catch { /* already gone */ } }
  await sleep(1_500)
  if (edge?.pid) { try { process.kill(-edge.pid, 'SIGKILL') } catch { /* already gone */ } }
  await sleep(300)
  rmSync(USER_DIR, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
