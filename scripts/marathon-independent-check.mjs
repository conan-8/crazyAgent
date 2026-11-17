#!/usr/bin/env node
/**
 * M1 independent check (MARATHON-PLAN.md §5 M1): the marathon switch must
 * agree in BOTH directions between the remote API and the real side panel.
 *
 *   node scripts/marathon-independent-check.mjs [--out DIR]
 *
 * Everything is real except the model: a real Bridge (loopback, free port),
 * the real SessionController + RemoteHub + RemoteServer, the scripted runner
 * from fake-remote-companion.mjs, and the REAL unpacked side panel in an
 * isolated Edge profile (its own token, never the user's live companion).
 * No mock WebSocket: the panel connects to the bridge exactly as in production.
 *
 * Checks (state is inspected independently of tool results):
 *   A. POST /marathon on  -> panel DOM chip lights; GET /state agrees.
 *   B. panel chip ×       -> GET /state marathon off; DOM chip hidden.
 *   C. panel /marathon    -> GET /state on; /marathon again -> off.
 *   D. legacy planMode:true message -> plan turn (prompt carries <plan_mode>),
 *      chat.done planMode+marathon, switch on, foreign turn badge in the DOM.
 *   E. sticky next turn; POST /new resets off in /state AND the DOM.
 *   F. mid-turn off: running turn keeps planMode; the next turn is unarmed.
 *
 * Evidence: screenshots + a JSON transcript under --out
 * (default docs/marathon/m1-evidence/independent-check).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Bridge } from '../companion/bridge.mjs'
import { RemoteHub } from '../companion/remote-hub.mjs'
import { RemoteServer } from '../companion/remote-server.mjs'
import { SessionController } from '../companion/session-controller.mjs'
import { marathonFrameBody } from '../companion/marathon.mjs'
import { ScriptedRunner } from './fake-remote-companion.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const OUT = resolve(arg('out', join(ROOT, 'docs/marathon/m1-evidence/independent-check')))
mkdirSync(OUT, { recursive: true })
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...parts) => process.stderr.write(`[m1-check] ${parts.join(' ')}\n`)
const transcript = []
const record = (step, detail) => {
  transcript.push({ step, at: new Date().toISOString(), ...detail })
  log(step, JSON.stringify(detail))
}

const extensionId = (() => {
  const hex = createHash('sha256').update(join(ROOT, 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()

async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolvePort(port))
    })
  })
}

async function waitForCdp(cdp) {
  for (let i = 0; i < 100; i += 1) {
    try { await fetch(`${cdp}/json/version`); return } catch { await sleep(150) }
  }
  throw new Error('CDP did not come up')
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej })
  let seq = 0
  const pending = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
  }
  return {
    send(method, params = {}) {
      const id = ++seq
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result?.value
    },
    close() { socket.close() },
  }
}

/** Poll the real DOM until the chip reaches the expected visibility. */
async function waitChip(page, visible, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await page.evaluate(`(() => ({
      visible: !document.getElementById('marathon-mode').classList.contains('hidden'),
      badge: document.querySelector('.marathon-mode-badge')?.textContent ?? null,
      placeholder: document.getElementById('input').placeholder,
    }))()`)
    if (state.visible === visible) return state
    if (Date.now() > deadline) throw new Error(`chip never became ${visible ? 'visible' : 'hidden'}: ${JSON.stringify(state)}`)
    await sleep(120)
  }
}

async function remote(port, token, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/remote/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function main() {
  const runRoot = mkdtempSync(join(tmpdir(), 'crazyagent-m1-check-'))
  const bridgeToken = createHash('sha256').update(`m1-${Date.now()}-${Math.random()}`).digest('hex')
  const remoteToken = createHash('sha256').update(`m1-remote-${Date.now()}-${Math.random()}`).digest('hex')
  const cdpPort = await freePort()
  const cdp = `http://127.0.0.1:${cdpPort}`
  const profileDir = join(runRoot, 'edge-profile')

  // --- the real companion stack (scripted model, no DSH, no browser work) ---
  const health = { uiConnected: false, toolsConnected: false, dsh: 'ready', dshMessage: null, provider: 'fake', model: 'fake/scripted', autoCapture: false }
  const hub = new RemoteHub({ serverVersion: 'm1-independent-check', getHealth: () => ({ ...health }) })
  const capturedBlocks = []
  let controller
  const runner = new ScriptedRunner({
    ingestActivity: frame => hub.ingest(frame),
    addScreenshot: input => hub.addScreenshot(input),
    requestHelp: request => controller.noteActivity({ type: 'chat.activity', kind: 'help-request', turnId: controller.turnId, ...request }),
    requestConfirm: request => controller.noteActivity({ type: 'chat.activity', kind: 'confirm-request', turnId: controller.turnId, ...request }),
    stepMs: 40,
  })
  const originalRun = runner.run.bind(runner)
  runner.run = (blocks, notify) => {
    capturedBlocks.push(blocks)
    return originalRun(blocks, notify)
  }
  const bridge = new Bridge({
    host: '127.0.0.1',
    port: 0,
    token: bridgeToken,
    log: () => {},
    onChat: (text, _ui, message) => {
      const result = controller.submit({ text, images: message?.images, autoCapture: false, planMode: message?.planMode === true, origin: 'ui' })
      if (!result.ok && result.code !== 'EMPTY_PROMPT') bridge.sendToUi({ v: 1, type: 'chat.error', code: result.code, message: result.message, recoverable: true })
      if (result.ok) result.done.catch(() => {})
    },
    onNewChat: async () => {
      const result = await controller.newChat()
      if (!result.ok) bridge.sendToUi({ v: 1, type: 'chat.error', code: result.code, message: result.message, recoverable: true })
    },
    onResumeChat: async sessionId => {
      const result = await controller.resumeChat(sessionId)
      if (!result.ok) bridge.sendToUi({ v: 1, type: 'chat.error', code: result.code, message: result.message, recoverable: true })
    },
    onStop: async () => { await controller.stop().done },
    onMarathonSet: message => {
      const result = controller.setMarathon({ enabled: message.enabled, origin: 'ui' })
      if (!result.ok) bridge.sendToUi({ v: 1, type: 'chat.error', code: result.code, message: result.message, recoverable: true })
    },
    onActivity: frame => {
      controller.noteActivity(frame)
      hub.ingest(frame)
    },
    onConnectionChange: () => {
      health.uiConnected = bridge.hasUi()
      hub.updateHealth()
      if (bridge.hasUi()) {
        bridge.sendToUi({
          v: 1,
          type: 'chat.hello',
          companion: 'm1-check',
          provider: 'fake',
          model: 'fake/scripted',
          autoCapture: false,
          dsh: { state: 'ready' },
          llm: { provider: 'fake', baseUrl: 'http://127.0.0.1:0', model: { id: 'fake/scripted', name: 'Fake Scripted (no model)', reasoning: false, imageInput: true }, reasoningEffort: null },
          credentials: { configured: true, source: 'manual' },
          settings: { confirmIrreversible: false },
          marathon: marathonFrameBody(controller.marathonState()),
          log: { runId: 'm1-check', path: runRoot },
        })
        bridge.sendToUi({ v: 1, type: 'chat.status', status: 'ready' })
      }
    },
  })
  controller = new SessionController({
    bridge,
    getRunner: () => runner,
    isDisabled: () => false,
    logStore: new Proxy({ sessionId: undefined }, { get: (t, k) => (k in t ? t[k] : () => {}) }),
    log: () => {},
    autoCapture: false,
    provider: 'fake',
    getModelId: () => 'fake/scripted',
    publish: frame => {
      bridge.sendToUi(frame)
      hub.ingest(frame)
    },
    observers: [{ turnStarted: info => hub.turnStarted(info), turnEnded: info => hub.turnEnded(info) }],
  })
  await bridge.start()
  hub.setSession(runner.sessionId)
  const server = new RemoteServer({ port: 0, getToken: () => remoteToken, hub, controller, log: () => {} })
  await server.start()
  hub.updateHealth()
  const remotePort = server.port
  record('stack', { bridgePort: bridge.port, remotePort, profileDir })

  // --- the real side panel in an isolated Edge profile ---
  spawn(EDGE_BIN, [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${join(ROOT, 'extension')}`,
    `--remote-debugging-port=${cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref()
  await waitForCdp(cdp)
  const target = (await (await fetch(`${cdp}/json`)).json()).find(item => item.type === 'page')
  const page = await connect(target.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 940, deviceScaleFactor: 2, mobile: false })
  await page.send('Page.navigate', { url: `chrome-extension://${extensionId}/sidepanel/index.html` })
  await sleep(1300)
  await page.evaluate(`chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify({
    bridgeUrl: `ws://127.0.0.1:${bridge.port}/bridge`,
    token: bridgeToken,
    captureWidth: 1280,
    quality: 72,
    autoCapture: false,
    paused: false,
    reasoningEffort: 'medium',
    modelId: 'fake/scripted',
  })}, 'crazyagent.disclaimerPending': false })`)
  await page.send('Page.reload')
  // Wait until the panel is really connected to OUR bridge.
  for (let i = 0; i < 80 && !bridge.hasUi(); i += 1) await sleep(150)
  assert.equal(bridge.hasUi(), true, 'the real panel connected to the isolated bridge')
  await sleep(800)
  const shot = async name => {
    await page.send('Page.bringToFront').catch(() => {})
    await sleep(250)
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
    log('wrote', join(OUT, `${name}.png`))
  }
  const state = async () => (await remote(remotePort, remoteToken, 'GET', '/state')).body
  const waitTurnIdle = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const s = await state()
      if (s.turn.status !== 'running' && s.turn.status !== 'stopping') return s
      if (Date.now() > deadline) throw new Error('turn never ended')
      await sleep(150)
    }
  }

  // Initial: off everywhere.
  assert.equal((await state()).marathon.enabled, false)
  await waitChip(page, false)
  record('initial', { stateMarathon: (await state()).marathon, chip: await waitChip(page, false) })
  await shot('00-initial-off')

  // A. remote -> panel.
  const onA = await remote(remotePort, remoteToken, 'POST', '/marathon', { clientCommandId: 'm1-check-on-0001', enabled: true })
  assert.equal(onA.status, 200)
  assert.equal(onA.body.enabled, true)
  const chipA = await waitChip(page, true)
  const stateA = await state()
  assert.equal(stateA.marathon.enabled, true)
  assert.equal(stateA.marathon.since, onA.body.sequence > 0 ? stateA.marathon.since : null)
  record('A-remote-to-panel', { post: onA.body, chip: chipA, stateMarathon: stateA.marathon })
  await shot('01-remote-on')

  // B. panel × -> remote.
  await page.evaluate(`document.getElementById('marathon-mode-cancel').click()`)
  const stateB = await (async () => {
    const deadline = Date.now() + 8_000
    for (;;) {
      const s = await state()
      if (!s.marathon.enabled) return s
      if (Date.now() > deadline) throw new Error('GET /state never saw the panel toggle off')
      await sleep(120)
    }
  })()
  await waitChip(page, false)
  record('B-panel-to-remote', { stateMarathon: stateB.marathon, chipHidden: true })
  await shot('02-panel-off')

  // C. panel /marathon slash both directions.
  await page.evaluate(`(() => { const i = document.getElementById('input'); i.value = '/marathon'; i.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`)
  const stateC = await (async () => {
    const deadline = Date.now() + 8_000
    for (;;) {
      const s = await state()
      if (s.marathon.enabled) return s
      if (Date.now() > deadline) throw new Error('GET /state never saw /marathon on')
      await sleep(120)
    }
  })()
  await waitChip(page, true)
  await page.evaluate(`(() => { const i = document.getElementById('input'); i.value = '/marathon'; i.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`)
  await waitChip(page, false)
  assert.equal((await state()).marathon.enabled, false)
  record('C-slash-both-ways', { onMarathon: stateC.marathon, offAgain: true })

  // D. legacy planMode:true remote message -> a real plan turn.
  const beforeD = capturedBlocks.length
  const legacy = await remote(remotePort, remoteToken, 'POST', '/messages', { clientMessageId: 'm1-check-legacy-0001', text: 'legacy plan task from an old client', planMode: true })
  assert.equal(legacy.status, 202)
  const stateD = await waitTurnIdle()
  assert.equal(stateD.marathon.enabled, true, 'the legacy flag turned the shared switch on')
  const promptD = capturedBlocks[beforeD].filter(b => b.type === 'text').map(b => b.text).join('\n')
  assert.ok(promptD.includes('<plan_mode>'), 'the legacy turn carried the plan guidance')
  const doneD = stateD.messages.filter(m => m.type === 'chat.done').at(-1)
  assert.equal(doneD.body.planMode, true)
  assert.equal(doneD.body.marathon, true)
  const badgeD = await page.evaluate(`[...document.querySelectorAll('.activity-turn')].at(-1)?.querySelector('.marathon-turn-badge')?.textContent ?? null`)
  assert.equal(badgeD, 'Marathon', 'the panel rendered the foreign marathon turn')
  await waitChip(page, true)
  record('D-legacy-plan-turn', { accepted: legacy.body, done: { planMode: doneD.body.planMode, marathon: doneD.body.marathon }, promptHasPlanMode: true, domBadge: badgeD, stateMarathon: stateD.marathon })
  await shot('03-legacy-plan-turn')

  // E. sticky next turn, then /new resets both sides.
  const beforeE = capturedBlocks.length
  const sticky = await remote(remotePort, remoteToken, 'POST', '/messages', { clientMessageId: 'm1-check-sticky-0001', text: 'ordinary follow-up while marathon is on' })
  assert.equal(sticky.status, 202)
  await waitTurnIdle()
  const promptE = capturedBlocks[beforeE].filter(b => b.type === 'text').map(b => b.text).join('\n')
  assert.ok(promptE.includes('<plan_mode>'), 'the switch is sticky: the next turn arms too')
  const fresh = await remote(remotePort, remoteToken, 'POST', '/new', { clientCommandId: 'm1-check-new-0001' })
  assert.equal(fresh.status, 200)
  await waitChip(page, false)
  assert.equal((await state()).marathon.enabled, false)
  record('E-sticky-and-new-reset', { stickyPromptHasPlanMode: true, newSession: fresh.body.sessionId, stateMarathon: (await state()).marathon })
  await shot('04-after-new-off')

  // F. mid-turn off: the running turn keeps its modes; the next turn is unarmed.
  await remote(remotePort, remoteToken, 'POST', '/marathon', { clientCommandId: 'm1-check-on-0002', enabled: true })
  await waitChip(page, true)
  const beforeF = capturedBlocks.length
  const slow = await remote(remotePort, remoteToken, 'POST', '/messages', { clientMessageId: 'm1-check-slow-0001', text: 'slow marathon task' })
  assert.equal(slow.status, 202)
  await sleep(400)
  assert.equal((await state()).turn.status, 'running')
  const midOff = await remote(remotePort, remoteToken, 'POST', '/marathon', { clientCommandId: 'm1-check-off-0002', enabled: false })
  assert.equal(midOff.status, 200)
  await waitChip(page, false)
  assert.equal((await state()).turn.status, 'running', 'the turn keeps running after a mid-turn off')
  await shot('05-mid-turn-off')
  const stateF = await waitTurnIdle()
  const doneF = stateF.messages.filter(m => m.type === 'chat.done').at(-1)
  assert.equal(doneF.body.planMode, true, 'the running turn kept browser_plan to the end')
  assert.equal(doneF.body.marathon, true)
  const promptF = capturedBlocks[beforeF].filter(b => b.type === 'text').map(b => b.text).join('\n')
  assert.ok(promptF.includes('<plan_mode>'))
  const beforeG = capturedBlocks.length
  const after = await remote(remotePort, remoteToken, 'POST', '/messages', { clientMessageId: 'm1-check-after-0001', text: 'quick question after off' })
  assert.equal(after.status, 202)
  await waitTurnIdle()
  const promptG = capturedBlocks[beforeG].filter(b => b.type === 'text').map(b => b.text).join('\n')
  assert.ok(!promptG.includes('<plan_mode>'), 'the next turn is unarmed after off')
  record('F-mid-turn-off', { midOff: midOff.body, runningKeptPlan: doneF.body.planMode, nextTurnUnarmed: true })

  // The event stream journaled every toggle (replay is unit-tested separately).
  const journal = hub.journal.filter(e => e.type === 'remote.marathon').map(e => ({ seq: e.seq, enabled: e.body.enabled, origin: e.body.origin }))
  assert.ok(journal.length >= 6, `expected the toggles journaled, got ${journal.length}`)
  record('journal', { remoteMarathonEnvelopes: journal })

  writeFileSync(join(OUT, 'transcript.json'), `${JSON.stringify({ checks: transcript, finalState: (await state()).marathon }, null, 2)}\n`)
  log('PASS: both directions agree; legacy planMode produces a plan turn; mid-turn semantics hold')

  page.close()
  const version = await (await fetch(`${cdp}/json/version`)).json()
  const browser = await connect(version.webSocketDebuggerUrl)
  await browser.send('Browser.close')
  await server.stop()
  hub.close()
  await bridge.stop()
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error)
  try { writeFileSync(join(OUT, 'transcript.json'), `${JSON.stringify({ checks: transcript, error: String(error?.stack ?? error) }, null, 2)}\n`) } catch {}
  process.exit(1)
})
