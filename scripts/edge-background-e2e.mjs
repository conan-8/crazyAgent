#!/usr/bin/env node
/**
 * Real-extension check of the panel-less executor: a fresh isolated Edge
 * profile, the real service worker, the real Bridge, and no side panel. Page
 * effects are read back from the page over CDP, independently of tool results.
 *
 *   node scripts/edge-background-e2e.mjs            # headless
 *   HEADED=1 node scripts/edge-background-e2e.mjs   # visible window
 *
 * A direct executor check: it does not evaluate model decisions.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Bridge } from '../companion/bridge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
const CDP_PORT = Number(process.env.CDP_PORT ?? 9343)
const CDP = `http://127.0.0.1:${CDP_PORT}`
const TOKEN = 'background-e2e-token'
const USER_DIR = mkdtempSync(join(tmpdir(), 'ca-edge-background-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const extensionId = (() => {
  const hex = createHash('sha256').update(join(ROOT, 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()

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
const workerTarget = async () => (await targets()).find(target => target.type === 'service_worker' && target.url.includes(extensionId))
const panelTargets = async () => (await targets()).filter(target => target.url.includes('/sidepanel/index.html'))

const PAGE = `<!doctype html><meta charset=utf-8><title>Background fixture</title>
<h1>Background executor</h1><p>marker-text-4412</p>
<button id=go onclick="window.count=(window.count||0)+1;document.getElementById('n').textContent=window.count">Increment</button>
<span id=n>0</span> <input id=field aria-label="Note field"><div style="height:3000px"></div><p>page-bottom</p>`

const results = []
const pass = name => { results.push(name); process.stdout.write(`ok - ${name}\n`) }

let edge
let bridge
let browser
let page
const pageHttp = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })

async function run() {
  await new Promise(resolve => pageHttp.listen(0, '127.0.0.1', resolve))
  const pageUrl = `http://127.0.0.1:${pageHttp.address().port}/`
  const logs = []
  bridge = new Bridge({ host: '127.0.0.1', port: 0, token: TOKEN, log: line => logs.push(line), onChat() {}, onNewChat() {}, uiGraceMs: 0 })
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

  const version = await until('Edge CDP', async () => { try { return await (await fetch(`${CDP}/json/version`)).json() } catch { return null } }, 25_000)
  browser = await cdp(version.webSocketDebuggerUrl)
  const worker = await until('the extension service worker', workerTarget, 20_000)
  const workerCdp = await cdp(worker.webSocketDebuggerUrl)
  const pageTarget = await until('the fixture page', async () => (await targets()).find(target => target.type === 'page' && target.url.startsWith(pageUrl)))
  page = await cdp(pageTarget.webSocketDebuggerUrl)
  const read = expression => page.evaluate(expression)

  assert.equal(bridge.hasUi(), false)
  try {
    await until('the worker APIs', () => workerCdp.evaluate('typeof chrome.storage?.local?.set === "function" && typeof chrome.alarms?.create === "function"'), 8_000)
  } catch (error) {
    process.stderr.write(`worker chrome keys: ${await workerCdp.evaluate('Object.keys(chrome).join(",")')}\nworker url: ${worker.url}\n`)
    throw error
  }
  await workerCdp.evaluate(`chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify({ bridgeUrl, token: TOKEN, captureWidth: 1280, quality: 72, autoCapture: true, showHitboxes: true, paused: false })} })`)
  try {
    await until('the worker to claim the executor', () => bridge.executorHost() === 'background')
  } catch (error) {
    const probe = await workerCdp.evaluate(`(async () => ({
      alarms: await chrome.alarms.getAll(),
      contexts: (await chrome.runtime.getContexts({})).map(c => [c.contextType, c.documentUrl]),
      settings: Object.keys((await chrome.storage.local.get('crazyagent.settings'))['crazyagent.settings'] ?? {}),
      health: await fetch(${JSON.stringify(bridgeUrl.replace('ws:', 'http:').replace('/bridge', '/health'))}).then(r => r.status + ' ' + r.headers.get('content-type')).catch(e => String(e)),
      healthBody: await fetch(${JSON.stringify(bridgeUrl.replace('ws:', 'http:').replace('/bridge', '/health'))}).then(r => r.text()).catch(e => String(e)),
    }))()`)
    process.stderr.write(`probe: ${JSON.stringify(probe)}\nbridge log: ${logs.join(' | ')}\n`)
    throw error
  }
  workerCdp.close()
  assert.equal((await panelTargets()).length, 0, 'no side panel exists')
  pass('the service worker connects with no side panel open')

  const snap = await command('snapshot', { detail: 'normal' })
  assert.ok(typeof snap.image?.data === 'string' && snap.image.data.length > 1_000)
  const bytes = Buffer.from(snap.image.data, 'base64')
  assert.ok(bytes[0] === 0xff && bytes[1] === 0xd8 || bytes[0] === 0x89, 'a real JPEG or PNG')
  assert.equal(snap.tab.url, pageUrl)
  assert.equal(await read('document.title'), 'Background fixture')
  pass(`snapshot of the active tab (${snap.image.width}x${snap.image.height}, ${bytes.length} bytes)`)

  const button = snap.labels.find(label => /Increment/u.test(JSON.stringify(label)))
  const field = snap.labels.find(label => /Note field/u.test(JSON.stringify(label)) || label.tag === 'input')
  assert.ok(button && field, `labels include the controls: ${JSON.stringify(snap.labels).slice(0, 300)}`)
  await command('click', { label: button.label ?? button.id ?? button.n })
  assert.equal(await read('window.count'), 1, 'exactly one real click landed')
  assert.equal(await read(`document.getElementById('n').textContent`), '1')
  pass('click by label changed the page exactly once')

  const again = await command('snapshot', { detail: 'normal' })
  const input = again.labels.find(label => /Note field/u.test(JSON.stringify(label)) || label.tag === 'input')
  await command('type', { label: input.label ?? input.id ?? input.n, text: 'typed from the worker' })
  assert.equal(await read(`document.getElementById('field').value`), 'typed from the worker')
  pass('type into a labelled field')

  const text = await command('read_text', { max_chars: 4_000 })
  assert.match(text.text, /marker-text-4412/u)
  const tabs = await command('tabs.list')
  assert.ok(tabs.tabs.some(tab => tab.url === pageUrl))
  const view = await command('auto_view')
  assert.equal(view.tab.url, pageUrl)
  await command('scroll', { direction: 'down', pages: 1 })
  assert.ok(await read('window.scrollY') > 100, 'the page really scrolled')
  pass('read_text, tabs.list, auto_view, and scroll')

  await assert.rejects(command('click', { label: 99_999 }), /label/iu)
  assert.equal(await read('window.count'), 1, 'a refused click changed nothing')
  pass('guards still refuse a missing label')

  // A phone turn's lifecycle: one debugger lease, labels gone at the end.
  bridge.sendToUi({ v: 1, type: 'chat.user', turnId: 'turn-e2e', origin: 'remote', text: 'x', imageCount: 0 })
  await command('snapshot', { detail: 'normal' })
  assert.equal(await read(`document.querySelectorAll('#__crazyagent_label_overlay').length`), 0, 'hitboxes never touch the page')
  await until('the agent cursor on the page', async () => await read(`document.querySelectorAll('[data-crazyagent-cursor]').length`) === 1)
  bridge.sendToUi({ v: 1, type: 'chat.done', text: 'done' })
  await until('the cursor gone after the turn', async () => await read(`document.querySelectorAll('[data-crazyagent-cursor]').length`) === 0)
  pass('a turn shows the cursor, keeps hitboxes off the page, and cleans up')

  // Longer than Chrome's 30 s idle limit, with nothing to do.
  await sleep(45_000)
  assert.equal(bridge.executorHost(), 'background', 'the worker stayed connected while idle')
  assert.equal((await command('tabs.list')).tabs.length > 0, true)
  pass('still connected and working after 45 s idle')

  // Chrome may stop a worker at any time: the alarm brings it back.
  const live = await workerTarget()
  await browser.send('Target.closeTarget', { targetId: live.id })
  await until('the bridge to see the worker go', () => !bridge.hasUi(), 15_000)
  const stoppedAt = Date.now()
  await until('the worker to return', () => bridge.executorHost() === 'background', 75_000)
  pass(`a stopped worker reconnected after ${Math.round((Date.now() - stoppedAt) / 1000)} s`)
  await command('tabs.list')

  // An opened panel takes over, after the command in flight.
  const slow = command('wait_for', { ms: 2_500 }, 15_000)
  await sleep(300)
  const panelCreated = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
  await sleep(800)
  assert.equal(bridge.executorHost(), 'background', 'no takeover while a command is running')
  const waited = await slow
  assert.ok(waited, 'the in-flight command finished and reported back')
  await until('the panel to take over', () => bridge.executorHost() === 'panel', 10_000)
  assert.ok(logs.some(line => /background executor connected/u.test(line)))
  pass('an opened panel waits for the running command, then takes over')

  const before = await read('window.count')
  const panelSnap = await command('snapshot', { detail: 'normal' })
  const panelButton = panelSnap.labels.find(label => /Increment/u.test(JSON.stringify(label)))
  if (panelButton) {
    await command('click', { label: panelButton.label ?? panelButton.id ?? panelButton.n })
    assert.equal(await read('window.count'), before + 1, 'one executor, one click')
  }
  await sleep(4_000)
  assert.equal(bridge.executorHost(), 'panel', 'the worker does not take the role back while the panel is open')
  pass('the panel executes alone while open')

  await browser.send('Target.closeTarget', { targetId: panelCreated.targetId })
  const closedAt = Date.now()
  await until('the worker to resume after the panel closes', () => bridge.executorHost() === 'background', 12_000)
  assert.equal((await command('tabs.list')).tabs.length > 0, true)
  pass(`closing the panel hands back to the worker in ${((Date.now() - closedAt) / 1000).toFixed(1)} s`)
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
