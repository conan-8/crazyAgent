#!/usr/bin/env node
/**
 * Real-model acceptance: extension reload mid-turn (plan B2 steps 4–5).
 *
 * Runs a control turn and a reload turn against an isolated headless Edge, a
 * second companion with its own DSH home (reuses the model-eval cached home),
 * and the authenticated remote API. Mid-turn, the extension is genuinely
 * reloaded via chrome.runtime.reload() on its service worker. Acceptance: the
 * turn continues after reconnect with the correct page state, or it
 * stops/blocks within ~20 s of the reload. A control turn without reload
 * proves the scenario itself is sound on this setup. Evidence JSON is written
 * under e2e/baselines/.
 *
 *   CRAZYAGENT_API_KEY=... node scripts/reload-midturn-accept.mjs
 *
 * The key is passed to the isolated companion through the environment only and
 * is never printed or written to a file.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXTENSION_DIR = join(ROOT, 'extension')
const FIXTURES = join(ROOT, 'e2e', 'fixtures')
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
const MODEL = process.env.RELOAD_MODEL ?? 'deepseek/deepseek-v4.1-flash'
const EFFORT = 'medium'
const DSH_HOME = join(tmpdir(), 'crazyagent-model-eval', 'dsh-home')
const PROFILE = join(tmpdir(), `crazyagent-reload-${process.pid}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = message => process.stderr.write(`[reload-accept] ${message}\n`)
const EXTENSION_ID = (() => {
  const hex = createHash('sha256').update(EXTENSION_DIR).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + Number.parseInt(char, 16))).join('')
})()

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}
async function until(what, predicate, timeoutMs = 30_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value = null
    try { value = await predicate() } catch { value = null }
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(intervalMs)
  }
}

async function connectCdp(wsUrl) {
  const websocket = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { websocket.terminate() } catch {} reject(new Error('CDP handshake timeout')) }, 15_000)
    websocket.once('open', () => { clearTimeout(timer); resolve() })
    websocket.once('error', error => { clearTimeout(timer); reject(error) })
  })
  let sequence = 0
  const pending = new Map()
  const failPending = reason => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)) } pending.clear() }
  websocket.on('message', data => {
    const message = JSON.parse(data.toString())
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  websocket.on('close', () => failPending('CDP connection closed'))
  websocket.on('error', error => failPending(`CDP socket error: ${error.message}`))
  return {
    send(method, params = {}) {
      if (websocket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection is closed'))
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, 15_000)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        websocket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed')
      return result.result?.value
    },
    get closed() { return websocket.readyState !== WebSocket.OPEN },
    close() { try { websocket.close() } catch {} },
  }
}

const requests = []
const fixtureServer = createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0])
  requests.push({ at: Date.now(), path })
  const file = join(FIXTURES, path === '/' ? 'click.html' : path)
  if (!file.startsWith(`${FIXTURES}/`) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); response.end('not found'); return }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.txt': 'text/plain' }
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
  response.end(readFileSync(file))
})
const fixtureServerV6 = createServer((request, response) => fixtureServer.emit('request', request, response))

let edge, companion, browser, page
const logPath = join(PROFILE, 'companion.log')

async function cleanup() {
  try { await companion?.stop() } catch {}
  try { page?.close() } catch {}
  try { browser?.close() } catch {}
  if (edge?.pid) {
    try { process.kill(-edge.pid, 'SIGTERM') } catch {}
    await sleep(2_000)
    try { process.kill(-edge.pid, 'SIGKILL') } catch {}
  }
  try { fixtureServer.close() } catch {}
  try { fixtureServerV6.close() } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }) } catch {}
}
process.on('SIGINT', () => { void cleanup().finally(() => process.exit(1)) })
process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(1)) })

function makeRemote(remoteUrl, token) {
  const headers = { authorization: `Bearer ${token}` }
  const request = async (method, path, body) => {
    const response = await fetch(`${remoteUrl}${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = text }
    if (!response.ok) throw new Error(`${response.status} ${path}: ${text.slice(0, 200)}`)
    return json
  }
  return {
    state: () => request('GET', '/state'),
    newChat: () => request('POST', '/new', { clientCommandId: randomUUID() }),
    send: text => request('POST', '/messages', { clientMessageId: randomUUID(), text }),
  }
}

async function runTurn(remote, fixtureUrl, { reload }) {
  await page.send('Page.navigate', { url: fixtureUrl })
  await until('fixture reload', async () => (await page.evaluate('document.readyState')) === 'complete', 15_000)
  await sleep(300)
  await browser.send('Target.activateTarget', { targetId: page.targetId })
  await remote.newChat()
  const prompt = `Open ${fixtureUrl} and click the Increment button exactly once, then report the new count.`
  const sentAt = Date.now()
  await remote.send(prompt)
  const timeline = []
  let reloadAt = null
  let reloaded = false
  let sawRunning = false
  let lastKey = ''
  const deadline = Date.now() + 120_000
  let state = null
  for (;;) {
    state = await remote.state().catch(() => null)
    const turn = state?.turn ?? {}
    const key = `${turn.status}|${state?.phase?.status}|${state?.phase?.tool}|${turn.failedCalls}`
    if (key !== lastKey) {
      timeline.push({ at: Date.now() - sentAt, status: turn.status, phase: state?.phase ?? null, failedCalls: turn.failedCalls ?? null })
      lastKey = key
    }
    if (turn.status === 'running' || turn.status === 'stopping' || turn.status === 'starting') sawRunning = true
    if (reload && !reloaded && sawRunning && turn.status === 'running' && state?.phase?.tool) {
      await sleep(250)
      const targets = await fetchJson(`http://127.0.0.1:${edge.cdpPort}/json`)
      const worker = targets.find(target => target.type === 'service_worker' && target.url.includes(EXTENSION_ID))
      if (worker) {
        const workerPage = await connectCdp(worker.webSocketDebuggerUrl)
        reloadAt = Date.now()
        try {
          await Promise.race([workerPage.evaluate('chrome.runtime.reload()'), sleep(3_000)])
        } catch (error) {
          log(`reload evaluate ended: ${error.message} (expected when the worker dies)`)
        }
        workerPage.close()
        reloaded = true
        log(`extension reloaded at +${((reloadAt - sentAt) / 1000).toFixed(1)}s of turn`)
      }
    }
    if (sawRunning && ['idle', 'error', 'waiting_for_user'].includes(turn.status)) break
    if (Date.now() > deadline) break
    await sleep(150)
  }
  const turn = state?.turn ?? {}
  const count = await page.evaluate(`document.getElementById('count')?.textContent`).catch(() => null)
  const endedAt = Date.now()
  return {
    prompt,
    reloadRequested: reload,
    reloaded,
    reloadAtMs: reloadAt === null ? null : reloadAt - sentAt,
    reloadToEndMs: reloadAt === null ? null : endedAt - reloadAt,
    wallMs: endedAt - sentAt,
    turn: { status: turn.status, outcome: turn.outcome, label: turn.label, failedCalls: turn.failedCalls, usage: turn.usage, error: turn.error },
    count,
    timeline,
    hung: !['idle', 'error', 'waiting_for_user'].includes(turn.status),
  }
}

try {
  const apiKey = (process.env.CRAZYAGENT_API_KEY ?? '').trim()
  if (!apiKey) throw new Error('CRAZYAGENT_API_KEY is not set')
  mkdirSync(PROFILE, { recursive: true })
  if (!existsSync(join(DSH_HOME, 'profiles', 'sdk-minimal', 'package.json'))) {
    log('preparing isolated DSH home (first run only)')
    mkdirSync(DSH_HOME, { recursive: true })
    const setup = spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup.mjs')], { cwd: ROOT, env: { ...process.env, CRAZYAGENT_DSH_HOME: DSH_HOME }, encoding: 'utf8', timeout: 240_000 })
    if (setup.status !== 0) throw new Error(`isolated setup failed: ${setup.stderr || setup.stdout}`)
  }
  await new Promise((resolve, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', resolve) })
  await new Promise(resolve => { fixtureServerV6.once('error', () => resolve(false)); fixtureServerV6.listen(fixtureServer.address().port, '::1', () => resolve(true)) })
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/click.html`
  const bridgePort = await freePort()
  const remotePort = await freePort()
  const cdpPort = await freePort()

  // Companion first: the bridge rejects an empty pairing token, so the
  // extension settings must carry the token this companion generates.
  const stream = createWriteStream(logPath, { mode: 0o600 })
  const child = spawn(process.execPath, [
    join(ROOT, 'companion', 'index.mjs'),
    '--dsh-home', DSH_HOME,
    '--port', String(bridgePort),
    '--remote', '--remote-port', String(remotePort),
    '--model', MODEL, '--reasoning-effort', EFFORT,
  ], { cwd: ROOT, env: { ...process.env, CRAZYAGENT_API_KEY: apiKey }, stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)
  companion = {
    async stop() {
      try { child.kill('SIGTERM') } catch {}
      await new Promise(resolve => { const timer = setTimeout(resolve, 8_000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
      try { child.kill('SIGKILL') } catch {}
      stream.end()
    },
  }
  const logTail = () => { try { return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-30).join('\n') } catch { return '(no log)' } }
  await until('companion health', async () => {
    if (exited) throw new Error(`companion exited: ${JSON.stringify(exited)}\n${logTail()}`)
    return fetchJson(`http://127.0.0.1:${bridgePort}/health`).catch(() => null)
  }, 30_000)
  const bridgeToken = await until('bridge token', () => {
    const file = join(DSH_HOME, 'browser-agent', 'token')
    return existsSync(file) && readFileSync(file, 'utf8').trim().length > 0 ? readFileSync(file, 'utf8').trim() : null
  }, 20_000)
  const remoteToken = await until('remote token', () => {
    const file = join(DSH_HOME, 'browser-agent', 'remote-token')
    return existsSync(file) && readFileSync(file, 'utf8').trim().length === 64 ? readFileSync(file, 'utf8').trim() : null
  }, 20_000)
  const remote = makeRemote(`http://127.0.0.1:${remotePort}/remote/v1`, remoteToken)
  await until('remote API', () => remote.state().then(() => true).catch(() => false), 20_000)

  edge = { cdpPort }
  edge.child = spawn(EDGE_BIN, [
    `--user-data-dir=${PROFILE}/edge`,
    `--load-extension=${EXTENSION_DIR}`,
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new', '--window-size=1280,900',
    '--no-first-run', '--no-default-browser-check', '--noerrdialogs',
    '--disable-features=Translate,MediaRouter',
    fixtureUrl,
  ], { detached: true, stdio: 'ignore' })
  const version = await until('Edge CDP', () => fetchJson(`http://127.0.0.1:${cdpPort}/json/version`), 60_000)
  browser = await connectCdp(version.webSocketDebuggerUrl)
  const targets = await until('fixture page target', async () => {
    const list = await fetchJson(`http://127.0.0.1:${cdpPort}/json`)
    return list.find(target => target.type === 'page' && target.url.includes('/click.html'))
  }, 30_000)
  page = await connectCdp(targets.webSocketDebuggerUrl)
  page.targetId = targets.id

  const worker = await until('extension service worker', async () => {
    const list = await fetchJson(`http://127.0.0.1:${cdpPort}/json`)
    return list.find(target => target.type === 'service_worker' && target.url.includes(EXTENSION_ID))
  }, 30_000)
  const workerPage = await connectCdp(worker.webSocketDebuggerUrl)
  await until('worker chrome APIs', () => workerPage.evaluate(
    'typeof chrome.storage?.local?.set === "function" && typeof chrome.runtime?.id === "string"',
  ), 10_000)
  await workerPage.evaluate(`chrome.storage.local.set({ 'crazyagent.settings': {
    bridgeUrl: 'ws://127.0.0.1:${bridgePort}/bridge', token: ${JSON.stringify(bridgeToken)},
    captureWidth: 1280, quality: 72, autoCapture: true, showHitboxes: true, paused: false } })`)
  workerPage.close()

  const health = await until('executor connected (tools:true)', async () => {
    const value = await fetchJson(`http://127.0.0.1:${bridgePort}/health`)
    return value?.tools === true ? value : null
  }, 45_000)
  log(`isolated companion healthy: ${JSON.stringify(health)}`)

  const control = await runTurn(remote, fixtureUrl, { reload: false })
  log(`control: ${JSON.stringify({ count: control.count, turn: control.turn, wallMs: control.wallMs })}`)
  const controlOk = control.count === '1' && control.turn.label === 'done' && control.turn.status === 'idle' && !control.hung
  if (!controlOk) throw new Error(`control turn unsound: ${JSON.stringify(control)}`)

  const reloadRun = await runTurn(remote, fixtureUrl, { reload: true })
  log(`reload run: ${JSON.stringify({ count: reloadRun.count, turn: reloadRun.turn, reloadToEndMs: reloadRun.reloadToEndMs, wallMs: reloadRun.wallMs })}`)
  const continued = !reloadRun.hung && reloadRun.turn.status === 'idle' && reloadRun.turn.label === 'done' && reloadRun.count === '1'
  const stoppedCleanly = !reloadRun.hung && reloadRun.reloadToEndMs !== null && reloadRun.reloadToEndMs <= 20_000
    && (reloadRun.turn.label === 'blocked' || reloadRun.turn.outcome === 'stopped' || reloadRun.turn.status === 'error')
  const verdict = continued ? 'PASS-CONTINUE' : stoppedCleanly ? 'PASS-STOP' : 'FAIL'
  const circuitLines = logTail().split('\n').filter(line => /SIDE_PANEL_CLOSED|executor|circuit|unavailable/i.test(line)).slice(-12)
  const evidence = {
    at: new Date().toISOString(),
    model: MODEL,
    effort: EFFORT,
    verdict,
    acceptance: 'continue after reconnect with correct page state, or stop/blocked within ~20 s of the reload',
    control: { count: control.count, turn: control.turn, wallMs: control.wallMs },
    reloadRun,
    companionLogExcerpt: circuitLines,
  }
  const evidencePath = join(ROOT, 'e2e', 'baselines', `${new Date().toISOString().replace(/[:.]/g, '-')}-reload-midturn.json`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  log(`verdict: ${verdict}; evidence: ${evidencePath}`)
  process.exitCode = verdict === 'FAIL' ? 1 : 0
} catch (error) {
  log(`ERROR: ${error?.stack ?? error}`)
  process.exitCode = 1
} finally {
  await cleanup()
  process.exit(process.exitCode ?? 0)
}