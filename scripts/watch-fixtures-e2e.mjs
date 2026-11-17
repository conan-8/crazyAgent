#!/usr/bin/env node
/**
 * M3 real-extension watch fixtures (MARATHON-PLAN.md §5 M3): TOOL_HANG (a tool
 * call that never returns) and EXECUTOR_DOWN (the panel socket drops mid-turn,
 * via the reload-midturn-accept approach). No model: a scripted runner holds a
 * turn open with an unanswered tool call. The REAL unpacked side panel connects
 * to a real Bridge; the real SessionController + RemoteHub + RemoteServer run
 * the watcher. The watch clock is injected and accelerated so the deterministic
 * thresholds fire without waiting minutes of wall time — the unit tests prove
 * the exact thresholds; this fixture proves the real wiring end to end.
 *
 *   node scripts/watch-fixtures-e2e.mjs [--out DIR]
 *
 * Independent surface: GET /state -> marathon.watch.open (not the transcript).
 * For TOOL_HANG the real panel DOM is also read (the watch row renders). For
 * EXECUTOR_DOWN the panel is gone, so /state is the proof.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Bridge } from '../companion/bridge.mjs'
import { RemoteHub } from '../companion/remote-hub.mjs'
import { RemoteServer } from '../companion/remote-server.mjs'
import { SessionController } from '../companion/session-controller.mjs'
import { marathonFrameBody } from '../companion/marathon.mjs'
import { WATCH_THRESHOLDS } from '../companion/watch-ledger.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback }
const OUT = resolve(arg('out', join(ROOT, 'docs/marathon/m3-evidence/fixtures')))
mkdirSync(OUT, { recursive: true })
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...parts) => process.stderr.write(`[watch-fixtures] ${parts.join(' ')}\n`)
const transcript = []
const record = (step, detail) => { transcript.push({ step, at: new Date().toISOString(), ...detail }); log(step, JSON.stringify(detail)) }

const extensionId = (() => {
  const hex = createHash('sha256').update(join(ROOT, 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()

async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })
}
async function waitForCdp(cdp) { for (let i = 0; i < 100; i += 1) { try { await fetch(`${cdp}/json/version`); return } catch { await sleep(150) } } throw new Error('CDP did not come up') }
async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej })
  let seq = 0; const pending = new Map()
  socket.onmessage = event => { const m = JSON.parse(String(event.data)); if (m.id && pending.has(m.id)) { const e = pending.get(m.id); pending.delete(m.id); m.error ? e.reject(new Error(JSON.stringify(m.error))) : e.resolve(m.result) } }
  return {
    send(method, params = {}) { const id = ++seq; return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params })) }) },
    async evaluate(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result?.value },
    close() { socket.close() },
  }
}
async function remote(port, token, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/remote/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

/** A runner that holds a turn open with one unanswered tool call. */
class HangingRunner {
  constructor() { this.sessionId = 'fixture-session-1'; this.n = 1; this.current = null }
  run(_blocks, notify) {
    return new Promise((resolveTurn, rejectTurn) => {
      this.current = { resolve: resolveTurn, reject: rejectTurn, notify }
      // Emit a tool call that never gets a result (the hang).
      queueMicrotask(() => notify({ method: 'session.event', params: { sessionId: this.sessionId, event: { type: 'tool/call', data: { callId: 'hang-1', name: 'browser_wait_for', arguments: '{}' } } } }))
    })
  }
  finish(text = 'done') { const c = this.current; this.current = null; c?.resolve({ sessionId: this.sessionId, finalResponse: text, events: [] }) }
  async interrupt() { const c = this.current; this.current = null; c?.reject(new Error('transport closed')); return { sessionId: this.sessionId, interrupted: true } }
  async newSession() { this.n += 1; this.sessionId = `fixture-session-${this.n}`; return this.sessionId }
  async resume(id) { this.sessionId = id; return id }
}

async function main() {
  const runRoot = mkdtempSync(join(tmpdir(), 'crazyagent-watch-fixtures-'))
  const bridgeToken = createHash('sha256').update(`wf-${Date.now()}-${Math.random()}`).digest('hex')
  const remoteToken = createHash('sha256').update(`wf-remote-${Date.now()}-${Math.random()}`).digest('hex')
  const cdpPort = await freePort()
  const cdp = `http://127.0.0.1:${cdpPort}`
  const profileDir = join(runRoot, 'edge-profile')

  // Accelerated, injected watch clock; the harness fires the captured tick.
  let watchNow = 0
  let tickFn = null
  const watchOptions = { now: () => watchNow, wallNow: () => 1_700_000_000_000 + watchNow, setTimer: fn => { tickFn = fn; return 1 }, clearTimer: () => { tickFn = null } }
  const advanceAndTick = ms => { watchNow += ms; tickFn?.() }

  const health = { uiConnected: false, toolsConnected: false, dsh: 'ready', dshMessage: null, provider: 'fake', model: 'fake/hanging', autoCapture: false }
  const hub = new RemoteHub({ serverVersion: 'm3-watch-fixtures', getHealth: () => ({ ...health }) })
  const runner = new HangingRunner()
  let controller
  const bridge = new Bridge({
    host: '127.0.0.1', port: 0, token: bridgeToken, log: () => {},
    onChat: (text, _ui, message) => {
      const result = controller.submit({ text, images: message?.images, autoCapture: false, planMode: message?.planMode === true, origin: 'ui' })
      if (!result.ok && result.code !== 'EMPTY_PROMPT') bridge.sendToUi({ v: 1, type: 'chat.error', code: result.code, message: result.message, recoverable: true })
      if (result.ok) result.done.catch(() => {})
    },
    onNewChat: async () => { const r = await controller.newChat(); if (!r.ok) bridge.sendToUi({ v: 1, type: 'chat.error', code: r.code, message: r.message, recoverable: true }) },
    onStop: async () => { await controller.stop().done },
    onMarathonSet: message => { const r = controller.setMarathon({ enabled: message.enabled, origin: 'ui' }); if (!r.ok) bridge.sendToUi({ v: 1, type: 'chat.error', code: r.code, message: r.message, recoverable: true }) },
    onMarathonWatchAck: message => { const r = controller.watchAck(message.id); if (!r.ok) bridge.sendToUi({ v: 1, type: 'chat.error', code: r.code, message: r.message, recoverable: true }) },
    onActivity: frame => { controller.noteActivity(frame); hub.ingest(frame) },
    onConnectionChange: () => {
      health.uiConnected = bridge.hasUi(); health.toolsConnected = bridge.hasTools()
      controller.setConnectivity({ uiConnected: bridge.hasUi(), toolsConnected: bridge.hasTools() })
      hub.updateHealth()
      if (bridge.hasUi()) {
        bridge.sendToUi({ v: 1, type: 'chat.hello', companion: 'watch-fixtures', provider: 'fake', model: 'fake/hanging', autoCapture: false, dsh: { state: 'ready' }, llm: { provider: 'fake', baseUrl: 'http://127.0.0.1:0', model: { id: 'fake/hanging', name: 'Fake Hanging (no model)', reasoning: false, imageInput: true }, reasoningEffort: null }, credentials: { configured: true, source: 'manual' }, settings: { confirmIrreversible: false }, marathon: { ...marathonFrameBody(controller.marathonState()), watcher: controller.watcherPanelState() }, log: { runId: 'watch-fixtures', path: runRoot } })
        bridge.sendToUi({ v: 1, type: 'chat.status', status: 'ready' })
      }
    },
  })
  controller = new SessionController({
    bridge, getRunner: () => runner, isDisabled: () => false,
    logStore: new Proxy({ sessionId: undefined }, { get: (t, k) => (k in t ? t[k] : () => {}) }),
    log: () => {}, autoCapture: false, provider: 'fake', getModelId: () => 'fake/hanging',
    publish: frame => { bridge.sendToUi(frame); hub.ingest(frame) },
    observers: [{ turnStarted: info => hub.turnStarted(info), turnEnded: info => hub.turnEnded(info) }],
    watch: watchOptions,
  })
  await bridge.start()
  // A standing tools-role client so hasTools() is true (the real companion has
  // the DSH provider here); only the panel drop should trigger EXECUTOR_DOWN.
  const toolsClient = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`)
  await new Promise((res, rej) => { toolsClient.once('open', res); toolsClient.once('error', rej) })
  toolsClient.send(JSON.stringify({ v: 1, type: 'hello', role: 'tools', token: bridgeToken, version: 1 }))
  await sleep(150)
  hub.setSession(runner.sessionId)
  const server = new RemoteServer({ port: 0, getToken: () => remoteToken, hub, controller, log: () => {} })
  await server.start()
  hub.updateHealth()
  const remotePort = server.port
  const state = async () => (await remote(remotePort, remoteToken, 'GET', '/state')).body
  record('stack', { bridgePort: bridge.port, remotePort, profileDir })

  // Real panel in an isolated Edge profile.
  spawn(EDGE_BIN, [`--user-data-dir=${profileDir}`, `--load-extension=${join(ROOT, 'extension')}`, `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter', 'about:blank'], { detached: true, stdio: 'ignore' }).unref()
  await waitForCdp(cdp)
  const target = (await (await fetch(`${cdp}/json`)).json()).find(item => item.type === 'page')
  const page = await connect(target.webSocketDebuggerUrl)
  await page.send('Page.enable'); await page.send('Runtime.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 940, deviceScaleFactor: 2, mobile: false })
  await page.send('Page.navigate', { url: `chrome-extension://${extensionId}/sidepanel/index.html` })
  await sleep(1300)
  await page.evaluate(`chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify({ bridgeUrl: `ws://127.0.0.1:${bridge.port}/bridge`, token: bridgeToken, captureWidth: 1280, quality: 72, autoCapture: false, paused: false, reasoningEffort: 'medium', modelId: 'fake/hanging' })}, 'crazyagent.disclaimerPending': false })`)
  await page.send('Page.reload')
  for (let i = 0; i < 80 && !bridge.hasUi(); i += 1) await sleep(150)
  assert.equal(bridge.hasUi(), true, 'the real panel connected')
  await sleep(800)
  const shot = async name => { await page.send('Page.bringToFront').catch(() => {}); await sleep(250); const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64')); log('wrote', join(OUT, `${name}.png`)) }
  const waitWatchOpen = async (kind, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const open = (await state()).marathon.watch.open
      if (open?.kind === kind) return open
      if (Date.now() > deadline) throw new Error(`watch.open never became ${kind}: ${JSON.stringify(open)}`)
      await sleep(100)
    }
  }

  // --- TOOL_HANG: a never-returning call on a marathon turn ---
  await remote(remotePort, remoteToken, 'POST', '/marathon', { clientCommandId: 'wf-on-0001', enabled: true })
  const hangTurn = await remote(remotePort, remoteToken, 'POST', '/messages', { clientMessageId: 'wf-hang-0001', text: 'a task whose call hangs' })
  assert.equal(hangTurn.status, 202)
  await sleep(300)
  assert.equal((await state()).turn.status, 'running')
  advanceAndTick(WATCH_THRESHOLDS.toolHangHardMs)
  const hangOpen = await waitWatchOpen('TOOL_HANG')
  assert.equal(hangOpen.kind, 'TOOL_HANG')
  // The real panel renders the watch row.
  await sleep(400)
  const hangRow = await page.evaluate(`(() => { const root = document.querySelector('.watch-row[data-watch-kind="TOOL_HANG"]'); return root ? { state: root.dataset.watchState, buttons: [...root.querySelectorAll('.watch-row-actions button')].map(b => b.textContent) } : null })()`)
  assert.deepEqual(hangRow, { state: 'open', buttons: ['Stop', 'Steer…', "It's fine"] })
  await shot('tool-hang')
  record('TOOL_HANG', { watchOpen: hangOpen, panelRow: hangRow, thresholdMs: WATCH_THRESHOLDS.toolHangHardMs })
  runner.finish('DONE — recovered from the hang')
  await sleep(400)

  // --- EXECUTOR_DOWN: close the panel mid-turn (reload-midturn approach) ---
  const downTurn = await remote(remotePort, remoteToken, 'POST', '/messages', { clientMessageId: 'wf-down-0001', text: 'a task whose panel drops' })
  assert.equal(downTurn.status, 202)
  await sleep(300)
  assert.equal((await state()).turn.status, 'running')
  assert.equal(bridge.hasUi(), true)
  // Close the panel mid-turn (the reload-midturn-accept approach: the executor
  // genuinely goes away while the turn runs). Navigating the panel page away
  // destroys its bridge socket deterministically; the turn keeps running.
  await page.send('Page.navigate', { url: 'about:blank' })
  for (let i = 0; i < 60 && bridge.hasUi(); i += 1) await sleep(100)
  assert.equal(bridge.hasUi(), false, 'the panel socket dropped mid-turn')
  advanceAndTick(WATCH_THRESHOLDS.executorDownHardMs)
  const downOpen = await waitWatchOpen('EXECUTOR_DOWN')
  assert.equal(downOpen.kind, 'EXECUTOR_DOWN')
  record('EXECUTOR_DOWN', { watchOpen: downOpen, uiConnected: false, thresholdMs: WATCH_THRESHOLDS.executorDownHardMs })
  // The turn is still running; the watcher only reported, never stopped it.
  assert.equal((await state()).turn.status, 'running', 'the watcher did not stop the turn')
  runner.finish('done')
  await sleep(300)

  writeFileSync(join(OUT, 'transcript.json'), `${JSON.stringify({ checks: transcript, finalWatch: (await state()).marathon.watch }, null, 2)}\n`)
  log('PASS: TOOL_HANG and EXECUTOR_DOWN alert via GET /state marathon.watch.open; the watcher never stopped the turn')

  const version = await (await fetch(`${cdp}/json/version`)).json().catch(() => null)
  if (version) { const browser = await connect(version.webSocketDebuggerUrl); await browser.send('Browser.close').catch(() => {}) }
  await server.stop(); hub.close(); controller.dispose(); await bridge.stop()
  try { toolsClient.close() } catch {}
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error)
  try { writeFileSync(join(OUT, 'transcript.json'), `${JSON.stringify({ checks: transcript, error: String(error?.stack ?? error) }, null, 2)}\n`) } catch {}
  process.exit(1)
})
