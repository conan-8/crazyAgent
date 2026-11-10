#!/usr/bin/env node
/**
 * Real-model scenario harness (plan-temporary.md, Track A / A1).
 *
 * One command runs a named scenario N times with a real model against an
 * isolated browser, an isolated companion and an isolated DSH home, then
 * reports pass/partial/fail from an independent check plus wall time, model
 * steps, tool calls, failed calls, token usage and the model's own final text.
 *
 * Isolation rules (AGENTS.md):
 *   - a fresh Edge profile with the unpacked extension, loaded in this process;
 *   - a second companion on free ports with its own `.dsh-home`;
 *   - a fixture server the checker can read without asking the agent;
 *   - it never touches the running service (17871/17873), the user's normal
 *     Edge profile, the user's real `.dsh-home`, or any recorded token file.
 *
 * The model key comes only from `CRAZYAGENT_API_KEY` in the environment. The
 * harness never reads `.dsh-home/browser-agent/api-key` and never prints a key.
 *
 * Usage:
 *   node scripts/model-eval.mjs --list
 *   node scripts/model-eval.mjs --self-test              # no model, no companion
 *   CRAZYAGENT_API_KEY=... node scripts/model-eval.mjs --scenario click-once --repeat 3
 *   CRAZYAGENT_API_KEY=... node scripts/model-eval.mjs --scenario all --repeat 5
 *
 * Flags: --scenario <name> (repeatable), --repeat <n>, --self-test, --list,
 *        --max-turn-seconds <n>, --max-total-tokens <n>, --json <path>,
 *        --label <name>, --headed, --keep, --dsh-home <path>, --reset-dsh-home,
 *        --model <id>, --effort <level>, --verbose, --help
 *
 * Scenario contract (e2e/scenarios/<name>.mjs):
 *   export const name; export const fixture; export const prompt;
 *   export const maxTurnSeconds?; export async function setup?(ctx);
 *   export async function check(ctx);      // -> {status,reasons,evidence}
 *   export async function tamper?(ctx);    // used by --self-test
 *
 * ctx = {
 *   fixtureUrl(path), currentUrl(), evaluate(expression), navigateFixture(path),
 *   requests(), resetRequests(), turn
 * }
 * `check` must read independent ground truth: page state through the harness's
 * own CDP connection, or the fixture server request log. It never sees tool
 * results and must not trust the agent's final text as proof.
 *
 * A direct-model eval: it does not replace a real-sidebar acceptance run.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES_DIR = join(ROOT, 'e2e', 'fixtures')
const SCENARIOS_DIR = join(ROOT, 'e2e', 'scenarios')
const BASELINES_DIR = join(ROOT, 'e2e', 'baselines')
const EXTENSION_DIR = join(ROOT, 'extension')
const COMPANION_ENTRY = join(ROOT, 'companion', 'index.mjs')
const SETUP_ENTRY = join(ROOT, 'scripts', 'setup.mjs')
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash'
const DEFAULT_EFFORT = 'medium'
const DEFAULT_DSH_HOME = join(tmpdir(), 'crazyagent-model-eval', 'dsh-home')
const EXTENSION_ID = (() => {
  const hex = createHash('sha256').update(EXTENSION_DIR).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const nowIso = () => new Date().toISOString()
const fmtMs = ms => (ms === null || ms === undefined ? '-' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)
const clip = (value, max = 300) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

class ApiError extends Error {
  constructor(status, body) {
    const detail = body?.error?.message ?? body?.error?.code ?? JSON.stringify(body ?? {}).slice(0, 200)
    super(`${status} ${detail}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/**
 * Poll `predicate` until it returns a truthy value.
 * @template T
 * @param {string} what
 * @param {() => Promise<T>} predicate
 * @param {number} [timeoutMs]
 * @param {number} [intervalMs]
 * @returns {Promise<T>}
 */
async function until(what, predicate, timeoutMs = 15_000, intervalMs = 150) {
  const started = Date.now()
  let lastError
  for (;;) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      if (error instanceof ApiError) throw error
      lastError = error
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${lastError ? ` (last error: ${lastError.message})` : ''}`)
    }
    await sleep(intervalMs)
  }
}

/** @returns {Promise<number>} */
async function freePort() {
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/** @param {string} url @param {RequestInit} [options] */
async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) throw new ApiError(response.status, body)
  return body
}

function newestRunDir(logsRoot) {
  if (!existsSync(logsRoot)) return null
  const dirs = readdirSync(logsRoot)
    .filter(name => name.startsWith('run-'))
    .map(name => join(logsRoot, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return dirs[0] ?? null
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const options = {
    scenarios: [],
    repeat: 1,
    selfTest: false,
    list: false,
    maxTurnSeconds: 120,
    maxTotalTokens: 0,
    json: null,
    label: null,
    headed: false,
    keep: false,
    dshHome: null,
    resetDshHome: false,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    verbose: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${token} needs a value`)
      return next
    }
    if (token === '--scenario') options.scenarios.push(value())
    else if (token === '--repeat') options.repeat = Number(value())
    else if (token === '--self-test') options.selfTest = true
    else if (token === '--list') options.list = true
    else if (token === '--max-turn-seconds') options.maxTurnSeconds = Number(value())
    else if (token === '--max-total-tokens') options.maxTotalTokens = Number(value())
    else if (token === '--json') options.json = value()
    else if (token === '--label') options.label = value()
    else if (token === '--headed') options.headed = true
    else if (token === '--keep') options.keep = true
    else if (token === '--dsh-home') options.dshHome = value()
    else if (token === '--reset-dsh-home') options.resetDshHome = true
    else if (token === '--model') options.model = value()
    else if (token === '--effort') options.effort = value()
    else if (token === '--verbose') options.verbose = true
    else if (token === '--help' || token === '-h') options.help = true
    else if (token.startsWith('--')) throw new Error(`unknown flag ${token}`)
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat must be a positive integer')
  if (!Number.isFinite(options.maxTurnSeconds) || options.maxTurnSeconds < 5) throw new Error('--max-turn-seconds must be >= 5')
  if (!Number.isFinite(options.maxTotalTokens) || options.maxTotalTokens < 0) throw new Error('--max-total-tokens must be >= 0')
  return options
}

function printHelp() {
  process.stdout.write(`crazyAgent real-model scenario harness

  node scripts/model-eval.mjs --list
  node scripts/model-eval.mjs --self-test [--scenario <name>]
  CRAZYAGENT_API_KEY=... node scripts/model-eval.mjs --scenario click-once --repeat 3

  --scenario <name>       scenario id (repeatable) or "all"; default all
  --repeat <n>            runs per scenario (default 1)
  --self-test             mutation-check every checker without a model
  --list                  list available scenarios
  --max-turn-seconds <n>  per-run cap before /stop (default 120)
  --max-total-tokens <n>  stop the batch after this many tokens (0 = no cap)
  --json <path>           write the batch JSON here (default e2e/baselines/...)
  --label <name>          label for the default JSON filename
  --headed                show the Edge window
  --keep                  keep the temporary Edge profile/log directory
  --dsh-home <path>       isolated harness home (default: ${DEFAULT_DSH_HOME})
  --reset-dsh-home        delete and re-run setup for the isolated harness home
  --model <id>            default ${DEFAULT_MODEL}
  --effort <level>        default ${DEFAULT_EFFORT} (kept fixed for comparisons)
  --verbose               print companion/Edge diagnostics
  --help

The API key is read only from CRAZYAGENT_API_KEY (or OPENROUTER_API_KEY is NOT
accepted here: export CRAZYAGENT_API_KEY yourself). It is passed to the
isolated companion's environment and never written to a file or printed.
`)
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const pad = (value, width) => String(value).padEnd(width)
const truncate = (value, width) => (String(value).length > width ? `${String(value).slice(0, width - 1)}…` : String(value))

let tableHeaderPrinted = false

function printTable(rows) {
  const header = ['scenario', 'run', 'check', 'turn', 'wall', 'steps', 'calls', 'failed', 'in/out', 'reasons']
  const widths = [22, 4, 8, 6, 8, 6, 6, 7, 14, 60]
  const line = values => values.map((value, index) => pad(truncate(value ?? '', widths[index]), widths[index])).join(' ')
  if (!tableHeaderPrinted) {
    process.stdout.write(`${line(header)}\n${line(header.map(value => '-'.repeat(value.length)))}\n`)
    tableHeaderPrinted = true
  }
  for (const row of rows) process.stdout.write(`${line(row)}\n`)
}

function printSummary(results) {
  for (const group of results) {
    const { scenario, runs } = group
    const counts = { pass: 0, partial: 0, fail: 0 }
    for (const run of runs) counts[run.check.status] += 1
    const walls = runs.map(run => run.turn.wallMs).filter(value => typeof value === 'number' && value > 0).sort((a, b) => a - b)
    const median = walls.length === 0 ? null : walls[Math.floor(walls.length / 2)]
    const calls = runs.reduce((sum, run) => sum + run.turn.toolCalls, 0)
    const failed = runs.reduce((sum, run) => sum + run.turn.failedCalls, 0)
    process.stdout.write(
      `${pad(scenario.name, 22)} pass ${counts.pass}/${runs.length}  partial ${counts.partial}  fail ${counts.fail}  `
      + `median ${fmtMs(median)}  calls ${calls}  failed ${failed}\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// Recording fixture server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

/**
 * Serve e2e/fixtures and record every request. `body` is utf8 for text-like
 * bodies and base64 otherwise; upload bodies are reported by length and name.
 * @returns {Promise<{baseUrl: string, port: number, requests: Array<Record<string, any>>, reset: () => void, close: () => Promise<void>}>}
 */
async function startFixtureServer() {
  /** @type {Array<Record<string, any>>} */
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => {
      chunks.push(chunk)
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 16 * 1024 * 1024) request.destroy()
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks)
      const contentType = String(request.headers['content-type'] ?? '')
      const textLike = /^(?:text\/|application\/(?:json|xml|x-www-form-urlencoded))/u.test(contentType)
      const record = {
        method: request.method,
        url: request.url,
        path: new URL(request.url, 'http://127.0.0.1').pathname,
        at: nowIso(),
        contentType,
        bodyLength: raw.length,
        body: textLike ? raw.toString('utf8') : raw.toString('base64'),
        bodyEncoding: textLike ? 'utf8' : 'base64',
      }
      requests.push(record)
      if (request.method !== 'GET' && request.method !== 'HEAD' && record.path === '/upload') {
        const match = /filename="([^"\r\n]+)"/u.exec(record.bodyEncoding === 'utf8' ? record.body : Buffer.from(record.body, 'base64').toString('latin1'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ filename: match?.[1] ?? 'upload.bin', size: raw.length }))
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ received: true, path: record.path, size: raw.length }))
        return
      }
      let pathname
      try {
        pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      } catch {
        response.writeHead(400).end('bad path')
        return
      }
      const relative = pathname === '/' ? 'click.html' : pathname.replace(/^\/+/u, '')
      const absolute = resolve(FIXTURES_DIR, relative)
      if (!absolute.startsWith(FIXTURES_DIR + sep) || !existsSync(absolute) || !statSync(absolute).isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end(`fixture not found: ${pathname}`)
        return
      }
      response.writeHead(200, { 'content-type': MIME[extname(absolute)] ?? 'application/octet-stream' })
      response.end(readFileSync(absolute))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    reset: () => { requests.length = 0 },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

/** @param {string} wsUrl */
const CDP_SEND_TIMEOUT_MS = 20_000

async function connectCdp(wsUrl) {
  const websocket = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { websocket.terminate() } catch { /* already closed */ }
      reject(new Error(`CDP handshake timed out for ${wsUrl}`))
    }, 15_000)
    timer.unref?.()
    websocket.once('open', () => { clearTimeout(timer); resolve() })
    websocket.once('error', error => { clearTimeout(timer); reject(error) })
  })
  let sequence = 0
  const pending = new Map()
  const failPending = reason => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
  }
  websocket.on('message', data => {
    const message = JSON.parse(data.toString())
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  // A closed target must reject every in-flight command; otherwise a page that
  // disappears under the harness can hang a run forever.
  websocket.on('close', () => failPending('CDP connection closed'))
  websocket.on('error', error => failPending(`CDP socket error: ${error.message}`))
  const close = () => {
    try { websocket.close() } catch { /* already closed */ }
  }
  return {
    send(method, params = {}) {
      if (websocket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection is closed'))
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP ${method} timed out after ${CDP_SEND_TIMEOUT_MS}ms`))
        }, CDP_SEND_TIMEOUT_MS)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        websocket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed')
      }
      return result.result?.value
    },
    get closed() {
      return websocket.readyState !== WebSocket.OPEN
    },
    close,
  }
}

async function listTargets(cdpHttp) {
  return fetchJson(`${cdpHttp}/json`)
}

/**
 * Start an isolated Edge with the unpacked extension. The browser-level CDP
 * connection is used only for target bookkeeping; page work uses per-target ws.
 */
async function startEdge({ profileDir, cdpPort, initialUrl, headed, loadExtension, verbose }) {
  const cdpHttp = `http://127.0.0.1:${cdpPort}`
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    '--window-size=1280,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    ...(loadExtension ? [`--load-extension=${EXTENSION_DIR}`] : []),
    ...(headed ? [] : ['--headless=new']),
    initialUrl,
  ]
  const child = spawn(EDGE_BIN, args, { detached: true, stdio: 'ignore' })
  const killGroup = () => {
    const pid = child.pid
    if (typeof pid !== 'number' || pid <= 1) return
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }
  /** @type {{webSocketDebuggerUrl: string, Browser?: string} | null} */
  let version = null
  let browser
  try {
    const deadline = Date.now() + 60_000
    while (version === null) {
      if (Date.now() > deadline) throw new Error(`Edge did not expose CDP on ${cdpPort} within 60s`)
      try {
        version = await fetchJson(`${cdpHttp}/json/version`)
      } catch {
        await sleep(150)
      }
    }
    browser = await connectCdp(version.webSocketDebuggerUrl)
  } catch (error) {
    // A failed startup must not leave a detached browser keeping this process
    // (and the port) alive after the error is reported.
    killGroup()
    throw error
  }
  if (verbose) process.stderr.write(`[eval] edge: ${version.Browser ?? 'unknown'} (CDP ${cdpPort})\n`)
  return {
    child,
    browser,
    cdpHttp,
    version,
    async stop() {
      try { browser.close() } catch { /* already closed */ }
      const pid = child.pid
      if (typeof pid === 'number' && pid > 1) {
        try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 3_000)
          child.once('exit', () => { clearTimeout(timer); resolve() })
        })
        try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
      }
    },
  }
}

/**
 * One page target, tracked across navigations and (rarely) recreation.
 */
class PageController {
  constructor({ edge, fixtureBaseUrl }) {
    this.edge = edge
    this.fixtureBaseUrl = fixtureBaseUrl
    this.targetId = null
    /** @type {Awaited<ReturnType<typeof connectCdp>> | null} */
    this.page = null
  }

  async list() {
    return listTargets(this.edge.cdpHttp)
  }

  async attach(target) {
    this.targetId = target.id
    this.page = await connectCdp(target.webSocketDebuggerUrl)
    return this.page
  }

  async ensure() {
    if (this.page !== null && !this.page.closed) {
      const targets = await this.list()
      const current = targets.find(target => target.id === this.targetId && target.type === 'page')
      if (current) return this.page
      this.page.close()
      this.page = null
    }
    const targets = await this.list()
    const pages = targets.filter(target => target.type === 'page')
    const target = pages.find(page => page.id === this.targetId)
      ?? pages.find(page => page.url.startsWith(this.fixtureBaseUrl))
      ?? pages[0]
    if (target) return this.attach(target)
    const created = await this.edge.browser.send('Target.createTarget', { url: this.fixtureBaseUrl })
    const fresh = await until('a recreated page target', async () => {
      const next = await this.list()
      return next.find(page => page.id === created.targetId)
    }, 10_000)
    return this.attach(fresh)
  }

  async evaluate(expression) {
    const page = await this.ensure()
    return page.evaluate(expression)
  }

  async currentUrl() {
    try {
      return await this.evaluate('location.href')
    } catch {
      return null
    }
  }

  async navigate(url) {
    const page = await this.ensure()
    await page.send('Page.navigate', { url })
    await until(`page readyState for ${url}`, async () => {
      try { return (await page.evaluate('document.readyState')) === 'complete' } catch { return false }
    }, 20_000)
    await sleep(80)
  }

  async closeOtherTabs() {
    const targets = await this.list()
    for (const target of targets) {
      if (target.type !== 'page' || target.id === this.targetId) continue
      try { await this.edge.browser.send('Target.closeTarget', { targetId: target.id }) } catch { /* race */ }
    }
  }

  async activate() {
    if (this.targetId === null) return
    try { await this.edge.browser.send('Target.activateTarget', { targetId: this.targetId }) } catch { /* best effort */ }
  }

  async reset(fixturePath) {
    await this.closeOtherTabs()
    await this.ensure()
    await this.navigate(`${this.fixtureBaseUrl}/${fixturePath}`)
    await this.activate()
  }

  close() {
    try { this.page?.close() } catch { /* best effort */ }
  }
}

/** Point the extension's background executor at the isolated companion. */
async function injectExtensionSettings({ edge, bridgeUrl, token, verbose }) {
  const worker = await until('the extension service worker target', async () => {
    const targets = await listTargets(edge.cdpHttp)
    return targets.find(target => target.type === 'service_worker' && target.url.includes(EXTENSION_ID))
  }, 30_000)
  const workerPage = await connectCdp(worker.webSocketDebuggerUrl)
  try {
    await until('worker chrome APIs', () => workerPage.evaluate(
      'typeof chrome.storage?.local?.set === "function" && typeof chrome.runtime?.id === "string"',
    ), 10_000)
    const settings = {
      bridgeUrl,
      token,
      captureWidth: 1280,
      quality: 72,
      autoCapture: true,
      showHitboxes: true,
      paused: false,
    }
    await workerPage.evaluate(`(async () => {
      await chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify(settings)} })
      const stored = (await chrome.storage.local.get('crazyagent.settings'))['crazyagent.settings']
      return stored?.bridgeUrl === ${JSON.stringify(bridgeUrl)}
    })()`)
    if (verbose) process.stderr.write('[eval] extension settings injected; waiting for the background executor\n')
  } finally {
    workerPage.close()
  }
}

// ---------------------------------------------------------------------------
// Companion process
// ---------------------------------------------------------------------------

/**
 * Start a second companion with its own harness home and the real model.
 * The API key is passed in the environment only.
 */
async function startCompanion({ dshHome, bridgePort, remotePort, model, effort, apiKey, logPath }) {
  const stream = createWriteStream(logPath, { mode: 0o600 })
  const child = spawn(process.execPath, [
    COMPANION_ENTRY,
    '--dsh-home', dshHome,
    '--port', String(bridgePort),
    '--remote',
    '--remote-port', String(remotePort),
    '--model', model,
    '--reasoning-effort', effort,
  ], {
    cwd: ROOT,
    env: { ...process.env, CRAZYAGENT_API_KEY: apiKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)
  const logTail = () => {
    try {
      return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-20).join('\n')
    } catch {
      return '(no log)'
    }
  }
  const health = async () => {
    if (exited !== null) throw new Error(`companion exited early (${JSON.stringify(exited)}):\n${logTail()}`)
    try { return await fetchJson(`http://127.0.0.1:${bridgePort}/health`) } catch { return null }
  }
  try {
    await until('the companion bridge health endpoint', health, 30_000)
    const bridgeTokenFile = join(dshHome, 'browser-agent', 'token')
    await until('the bridge pairing token file', () => existsSync(bridgeTokenFile) && readFileSync(bridgeTokenFile, 'utf8').trim().length > 0, 20_000)
    const bridgeToken = readFileSync(bridgeTokenFile, 'utf8').trim()
    const tokenFile = join(dshHome, 'browser-agent', 'remote-token')
    await until('the remote credential file', () => existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim().length === 64, 20_000)
    const token = readFileSync(tokenFile, 'utf8').trim()
    await until('the remote API', async () => {
      try {
        await fetchJson(`http://127.0.0.1:${remotePort}/remote/v1/state`, { headers: { authorization: `Bearer ${token}` } })
        return true
      } catch {
        return false
      }
    }, 20_000)
    return {
      child,
      token,
      bridgeToken,
      bridgeUrl: `ws://127.0.0.1:${bridgePort}/bridge`,
      remoteUrl: `http://127.0.0.1:${remotePort}/remote/v1`,
      logTail,
      get exited() { return exited },
      async stop() {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 10_000)
          child.once('exit', () => { clearTimeout(timer); resolve() })
        })
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        stream.end()
      },
    }
  } catch (error) {
    child.kill('SIGKILL')
    stream.end()
    throw new Error(`${error.message}\n--- companion log tail ---\n${logTail()}`)
  }
}

/** Prepare a cached isolated DSH harness home (profiles + symlinks). */
async function prepareDshHome(dshHome, reset) {
  if (reset && existsSync(dshHome)) {
    const resolved = resolve(dshHome)
    const allowed = [resolve(tmpdir()), resolve(ROOT)]
    if (!allowed.some(prefix => resolved === prefix || resolved.startsWith(`${prefix}${sep}`))) {
      throw new Error(`refusing to delete --dsh-home outside a temp or repo path: ${resolved}`)
    }
    rmSync(resolved, { recursive: true, force: true })
  }
  const marker = join(dshHome, 'profiles', 'sdk-minimal', 'package.json')
  if (existsSync(marker)) return
  mkdirSync(dshHome, { recursive: true })
  const result = spawnSync(process.execPath, [SETUP_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, CRAZYAGENT_DSH_HOME: dshHome },
    encoding: 'utf8',
    timeout: 240_000,
  })
  if (result.status !== 0) {
    throw new Error(`isolated dsh-home setup failed:\n${result.stderr || result.stdout || 'no output'}`)
  }
}

/** Authenticated client for the isolated companion's remote API. */
function makeRemote({ remoteUrl, token }) {
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
    if (!response.ok) throw new ApiError(response.status, json)
    return json
  }
  return {
    state: () => request('GET', '/state'),
    newChat: () => request('POST', '/new', { clientCommandId: randomUUID() }),
    send: text => request('POST', '/messages', { clientMessageId: randomUUID(), text }),
    stop: () => request('POST', '/stop', { clientCommandId: randomUUID() }),
  }
}

// ---------------------------------------------------------------------------
// Turn metrics from the companion run log
// ---------------------------------------------------------------------------

function resolveRunEvents(logsRoot, runId) {
  if (runId !== null) {
    const candidate = join(logsRoot, runId, 'events.jsonl')
    if (existsSync(candidate)) return candidate
  }
  const dir = newestRunDir(logsRoot)
  return dir === null ? null : join(dir, 'events.jsonl')
}

/**
 * The companion publishes the turn outcome before its log writer has flushed
 * the final `turn.end` record, so an immediate read can miss usage/finalText.
 * Wait (bounded) for that record before deriving metrics.
 * @param {string} eventsPath @param {string} turnId @param {number} [timeoutMs]
 */
async function waitForTurnEndInLog(eventsPath, turnId, timeoutMs = 10_000) {
  try {
    await until(`the turn.end record for ${turnId} in the run log`, () => {
      if (!existsSync(eventsPath)) return false
      const text = readFileSync(eventsPath, 'utf8')
      return text.includes(turnId) && text.split('\n').some(line => line.includes(turnId) && line.includes('"type":"turn.end"'))
    }, timeoutMs, 100)
  } catch {
    // Keep going with whatever is on disk; the run records logComplete below.
  }
}

/**
 * Everything the report needs about one model turn, read from the companion's
 * own run log (not from tool results).
 * @param {string} eventsPath
 * @param {string} turnId
 */
function readTurnMetrics(eventsPath, turnId) {
  const metrics = {
    steps: 0,
    toolCalls: 0,
    failedCalls: 0,
    failed: [],
    toolCounts: {},
    usage: null,
    finalText: null,
    logOk: null,
    logWallMs: null,
    reportedLabel: null,
    loggedFailedCalls: null,
  }
  if (!existsSync(eventsPath)) return metrics
  const names = new Map()
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.includes(turnId)) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.turnId !== turnId) continue
    if (event.type === 'tool.call') {
      metrics.toolCalls += 1
      const name = event.data?.name ?? 'unknown'
      names.set(event.data?.callId, name)
      metrics.toolCounts[name] = (metrics.toolCounts[name] ?? 0) + 1
    } else if (event.type === 'tool.result') {
      if (event.data?.ok === false) {
        metrics.failedCalls += 1
        metrics.failed.push({
          kind: 'tool',
          tool: names.get(event.data?.callId) ?? null,
          message: clip(event.data?.text ?? ''),
        })
      }
    } else if (event.type === 'bridge.command.error') {
      metrics.failed.push({
        kind: 'command',
        tool: event.data?.op ?? null,
        code: event.data?.code ?? null,
        message: clip(event.data?.error ?? ''),
      })
    } else if (event.type === 'notification' && event.data?.params?.event?.type === 'step/start') {
      metrics.steps += 1
    } else if (event.type === 'turn.end') {
      metrics.logOk = event.data?.ok ?? null
      metrics.logWallMs = Number(event.data?.timings?.totalMs) || null
      metrics.usage = event.data?.usage ?? null
      metrics.finalText = typeof event.data?.finalText === 'string' ? event.data.finalText : null
      metrics.reportedLabel = typeof event.data?.label === 'string' ? event.data.label : null
      metrics.loggedFailedCalls = Number.isFinite(Number(event.data?.timings?.failedCalls))
        ? Number(event.data.timings.failedCalls)
        : null
    }
  }
  if (metrics.failed.length > 20) metrics.failed.length = 20
  return metrics
}

// ---------------------------------------------------------------------------
// Scenario loading and the context handed to checkers
// ---------------------------------------------------------------------------

async function loadScenarios(selected) {
  if (!existsSync(SCENARIOS_DIR)) throw new Error(`no scenario directory at ${SCENARIOS_DIR}`)
  const files = readdirSync(SCENARIOS_DIR)
    .filter(name => name.endsWith('.mjs') && !name.startsWith('_'))
    .sort()
  /** @type {Array<Record<string, any>>} */
  const scenarios = []
  for (const file of files) {
    const modulePath = join(SCENARIOS_DIR, file)
    const module = await import(pathToFileURL(modulePath).href)
    const scenario = {
      name: module.name,
      fixture: module.fixture,
      prompt: module.prompt,
      maxTurnSeconds: module.maxTurnSeconds,
      setup: module.setup,
      check: module.check,
      tamper: module.tamper,
      file,
    }
    if (typeof scenario.name !== 'string' || scenario.name.length === 0) throw new Error(`${file} exports no name`)
    if (typeof scenario.fixture !== 'string' || scenario.fixture.length === 0) throw new Error(`${file} exports no fixture`)
    if (typeof scenario.prompt !== 'string' || scenario.prompt.length === 0) throw new Error(`${file} exports no prompt`)
    if (typeof scenario.check !== 'function') throw new Error(`${file} exports no check()`)
    scenarios.push(scenario)
  }
  const requested = selected.length === 0 || selected.includes('all') ? null : new Set(selected)
  const filtered = requested === null ? scenarios : scenarios.filter(scenario => requested.has(scenario.name))
  if (requested !== null) {
    const missing = [...requested].filter(name => !scenarios.some(scenario => scenario.name === name))
    if (missing.length > 0) {
      throw new Error(`unknown scenario(s): ${missing.join(', ')}\navailable: ${scenarios.map(scenario => scenario.name).join(', ')}`)
    }
  }
  if (filtered.length === 0) throw new Error('no scenarios matched')
  return filtered
}

function normalizeCheck(value) {
  if (value === null || typeof value !== 'object') throw new Error('check() must return an object')
  const status = String(value.status)
  if (!['pass', 'partial', 'fail'].includes(status)) throw new Error(`check() returned invalid status "${status}"`)
  return {
    status,
    reasons: Array.isArray(value.reasons) ? value.reasons.map(String) : [],
    evidence: value.evidence ?? null,
  }
}

const EMPTY_TURN = Object.freeze({
  status: 'none',
  waitingForUser: false,
  wallMs: 0,
  steps: 0,
  toolCalls: 0,
  failedCalls: 0,
  failed: [],
  toolCounts: {},
  inputTokens: 0,
  outputTokens: 0,
  finalText: null,
})

function makeCtx({ fixtureServer, page, turn }) {
  return {
    fixtureUrl: path => `${fixtureServer.baseUrl}/${String(path).replace(/^\/+/u, '')}`,
    currentUrl: () => page.currentUrl(),
    evaluate: expression => page.evaluate(expression),
    navigateFixture: path => page.navigate(`${fixtureServer.baseUrl}/${String(path).replace(/^\/+/u, '')}`),
    requests: () => fixtureServer.requests.map(request => ({ ...request })),
    resetRequests: () => fixtureServer.reset(),
    turn,
  }
}

// ---------------------------------------------------------------------------
// Self-test: mutation-check every checker without spending model tokens
// ---------------------------------------------------------------------------

async function runSelfTest(options, scenarios) {
  process.stdout.write('model-eval self-test (no model, no companion)\n')
  const stage = label => process.stderr.write(`[self-test] ${label}\n`)
  const fixtureServer = await startFixtureServer()
  stage(`fixture server on ${fixtureServer.baseUrl}`)
  const runRoot = mkdtempSync(join(tmpdir(), 'ca-model-eval-selftest-'))
  /** @type {ReturnType<typeof startEdge> | null} */
  let edge = null
  /** @type {PageController | null} */
  let page = null
  try {
    const initialFixture = scenarios[0]?.fixture ?? 'click.html'
    edge = await startEdge({
      profileDir: join(runRoot, 'edge-profile'),
      cdpPort: await freePort(),
      initialUrl: `${fixtureServer.baseUrl}/${initialFixture}`,
      headed: options.headed,
      loadExtension: false,
      verbose: options.verbose,
    })
    stage(`edge CDP ready (${edge.version?.Browser ?? 'unknown'})`)
    await until('the initial page target', async () => {
      const targets = await listTargets(edge.cdpHttp)
      return targets.find(target => target.type === 'page')
    }, 20_000)
    page = new PageController({ edge, fixtureBaseUrl: fixtureServer.baseUrl })
    await page.ensure()
    stage('page ready')
    const failures = []
    for (const scenario of scenarios) {
      stage(`scenario ${scenario.name}`)
      const context = fixtureServer
      const baseCtx = turn => makeCtx({ fixtureServer, page, turn: turn ?? EMPTY_TURN })
      // 1. The untouched start state must never pass.
      await page.reset(scenario.fixture)
      if (typeof scenario.setup === 'function') await scenario.setup(baseCtx())
      fixtureServer.reset()
      let initial
      try {
        initial = normalizeCheck(await scenario.check(baseCtx()))
      } catch (error) {
        failures.push(`${scenario.name}: check() threw on the untouched page: ${error.message}`)
        process.stdout.write(`FAIL ${pad(scenario.name, 22)} untouched state threw: ${error.message}\n`)
        continue
      }
      if (initial.status === 'pass') {
        failures.push(`${scenario.name}: check() passed on the untouched, unmodified page`)
        process.stdout.write(`FAIL ${pad(scenario.name, 22)} untouched state returned pass (checker is too lax)\n`)
        continue
      }
      let tamperedStatus = '(no tamper hook)'
      let tamperedOk = true
      if (typeof scenario.tamper === 'function') {
        await page.reset(scenario.fixture)
        if (typeof scenario.setup === 'function') await scenario.setup(baseCtx())
        fixtureServer.reset()
        try {
          await scenario.tamper(baseCtx())
          const tampered = normalizeCheck(await scenario.check(baseCtx()))
          tamperedStatus = tampered.status
          if (tampered.status === 'pass') {
            tamperedOk = false
            failures.push(`${scenario.name}: check() passed a tampered plausible-but-wrong state`)
          }
        } catch (error) {
          tamperedOk = false
          failures.push(`${scenario.name}: tamper/check threw: ${error.message}`)
          tamperedStatus = `threw: ${error.message}`
        }
      }
      const line = `ok   ${pad(scenario.name, 22)} untouched ${pad(initial.status, 7)} tampered ${tamperedStatus}`
      process.stdout.write(`${tamperedOk ? line : `FAIL ${line.slice(5)}`}\n`)
    }
    if (failures.length > 0) {
      process.stdout.write(`\nself-test FAILED (${failures.length}):\n${failures.map(line => `  - ${line}`).join('\n')}\n`)
      return 1
    }
    process.stdout.write(`\nself-test passed for ${scenarios.length} scenario(s): every checker rejects the untouched and tampered states.\n`)
    stage('scenarios done; cleaning up')
  } finally {
    try { page?.close() } catch { /* best effort */ }
    await edge?.stop().catch(() => {})
    await fixtureServer.close().catch(() => {})
    if (!options.keep) safeRemoveTemp(runRoot)
    else process.stdout.write(`kept self-test scratch: ${runRoot}\n`)
  }
}

function safeRemoveTemp(path) {
  const resolved = resolve(path)
  if (resolved.startsWith(`${resolve(tmpdir())}${sep}`)) rmSync(resolved, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Real-model batch
// ---------------------------------------------------------------------------

async function waitForRemoteReady({ remote, bridgePort, companion, timeoutMs = 180_000 }) {
  return until('the isolated companion runtime (dsh ready, tools + background executor connected)', async () => {
    if (companion.exited !== null) throw new Error(`companion exited: ${JSON.stringify(companion.exited)}`)
    const [state, health] = await Promise.all([
      remote.state().catch(() => null),
      fetchJson(`http://127.0.0.1:${bridgePort}/health`).catch(() => null),
    ])
    if (state === null || health === null) return null
    const runtime = state.health ?? {}
    if (runtime.dsh === 'ready' && runtime.toolsConnected === true && runtime.uiConnected === true && runtime.executorHost === 'background' && health.ui === true && health.tools === true) {
      return { state, health }
    }
    return null
  }, timeoutMs, 250)
}

async function waitForTurn({ remote, turnId, deadline }) {
  let transient = 0
  for (;;) {
    try {
      const state = await remote.state()
      transient = 0
      const turn = state.turn ?? {}
      if (turn.turnId === turnId && !['running', 'stopping', 'starting'].includes(String(turn.status))) {
        return state
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      transient += 1
      if (transient >= 5) throw new Error(`remote state polling failed ${transient} times: ${error.message}`)
    }
    if (Date.now() > deadline) throw new Error('turn-timeout')
    await sleep(200)
  }
}

function turnFromState(state) {
  const turn = state.turn ?? {}
  const waitingForUser = turn.status === 'waiting_for_user' || state.help !== null
  let status = 'unknown'
  if (turn.outcome === 'done') status = 'done'
  else if (turn.outcome === 'stopped') status = 'stopped'
  else if (turn.outcome === 'error') status = 'error'
  else if (waitingForUser) status = 'done'
  const wallMs = turn.startedAt && turn.endedAt
    ? Math.max(0, Date.parse(turn.endedAt) - Date.parse(turn.startedAt))
    : null
  return {
    status,
    waitingForUser,
    wallMs,
    error: turn.error ?? null,
    outcome: turn.outcome ?? null,
  }
}

async function runModelBatch(options, scenarios) {
  const apiKey = (process.env.CRAZYAGENT_API_KEY ?? '').trim()
  if (apiKey.length === 0) {
    throw new Error('CRAZYAGENT_API_KEY is not set. Export the model key in the environment (the harness never reads the key file).')
  }
  const dshHome = resolve(options.dshHome ?? DEFAULT_DSH_HOME)
  await prepareDshHome(dshHome, options.resetDshHome)
  const runRoot = mkdtempSync(join(tmpdir(), 'ca-model-eval-'))
  const edgeProfile = join(runRoot, 'edge-profile')
  const companionLog = join(runRoot, 'companion.log')
  mkdirSync(edgeProfile, { recursive: true })
  const logsRoot = join(dshHome, 'browser-agent', 'logs')
  const startedAt = nowIso()
  const results = []
  let totalTokens = 0
  let stopReason = null
  const outputPath = options.json ?? join(
    BASELINES_DIR,
    `${new Date().toISOString().replace(/[:.]/gu, '-')}${options.label ? `-${options.label}` : ''}.json`,
  )
  const buildBatch = () => ({
    startedAt,
    finishedAt: nowIso(),
    model: options.model,
    effort: options.effort,
    node: process.version,
    dshHome,
    repeat: options.repeat,
    maxTurnSeconds: options.maxTurnSeconds,
    maxTotalTokens: options.maxTotalTokens || null,
    totalTokens,
    stopReason,
    scenarios: results.map(group => ({
      name: group.scenario.name,
      fixture: group.scenario.fixture,
      prompt: group.scenario.prompt,
      file: group.scenario.file,
      runs: group.runs.map(run => ({
        runIndex: run.runIndex,
        turnId: run.accepted?.turnId ?? null,
        status: run.check.status,
        reasons: run.check.reasons,
        evidence: run.check.evidence,
        collateral: run.collateral,
        turn: run.turn,
        skipped: run.skipped ?? false,
      })),
    })),
  })
  const writeBatch = () => {
    try {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, `${JSON.stringify(buildBatch(), null, 2)}\n`)
    } catch (error) {
      process.stderr.write(`model-eval: could not write ${outputPath}: ${error.message}\n`)
    }
  }

  /** @type {{close: () => Promise<void>} | null} */
  let fixtureServer = null
  /** @type {Awaited<ReturnType<typeof startCompanion>> | null} */
  let companion = null
  /** @type {Awaited<ReturnType<typeof startEdge>> | null} */
  let edge = null
  /** @type {PageController | null} */
  let page = null

  try {
    fixtureServer = await startFixtureServer()
    const bridgePort = await freePort()
    const remotePort = await freePort()
    companion = await startCompanion({
      dshHome,
      bridgePort,
      remotePort,
      model: options.model,
      effort: options.effort,
      apiKey,
      logPath: companionLog,
    })
    const remote = makeRemote({ remoteUrl: companion.remoteUrl, token: companion.token })
    const initialFixture = scenarios[0]?.fixture ?? 'click.html'
    edge = await startEdge({
      profileDir: edgeProfile,
      cdpPort: await freePort(),
      initialUrl: `${fixtureServer.baseUrl}/${initialFixture}`,
      headed: options.headed,
      loadExtension: true,
      verbose: options.verbose,
    })
    await injectExtensionSettings({ edge, bridgeUrl: companion.bridgeUrl, token: companion.bridgeToken, verbose: options.verbose })
    await waitForRemoteReady({ remote, bridgePort, companion })
    await until('the companion run log', () => {
      const dir = newestRunDir(logsRoot)
      return dir !== null && existsSync(join(dir, 'events.jsonl')) ? dir : null
    }, 20_000)
    await until('the initial page target', async () => {
      const targets = await listTargets(edge.cdpHttp)
      return targets.find(target => target.type === 'page')
    }, 20_000)
    page = new PageController({ edge, fixtureBaseUrl: fixtureServer.baseUrl })
    await page.ensure()
    const eventsPath = resolveRunEvents(logsRoot, null)
    process.stdout.write(`model-eval: ${options.model} @ ${options.effort} · ${scenarios.length} scenario(s) × ${options.repeat}\n`)
    process.stdout.write(`isolated home: ${dshHome}\nscratch: ${runRoot}\n\n`)

    for (const scenario of scenarios) {
      const scenarioRuns = []
      results.push({ scenario, runs: scenarioRuns })
      for (let index = 0; index < options.repeat; index += 1) {
        if (stopReason !== null) {
          scenarioRuns.push({ runIndex: index, skipped: true, reason: stopReason, check: { status: 'fail', reasons: [stopReason], evidence: null }, turn: { ...EMPTY_TURN } })
          continue
        }
        // Reset page + conversation so every run starts from the same state.
        await page.reset(scenario.fixture)
        if (typeof scenario.setup === 'function') await scenario.setup(makeCtx({ fixtureServer, page, turn: EMPTY_TURN }))
        // A settled turn may be idle, waiting_for_user (help/confirmation) or
        // error; only an active turn blocks starting a fresh chat.
        await until('the companion to be settled before a new chat', async () => {
          const state = await remote.state()
          const status = String(state.turn?.status ?? '')
          return ['running', 'stopping', 'starting'].includes(status) ? null : state
        }, 60_000)
        try {
          await remote.newChat()
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error
          await sleep(500)
          await remote.newChat()
        }
        await page.reset(scenario.fixture)
        if (typeof scenario.setup === 'function') await scenario.setup(makeCtx({ fixtureServer, page, turn: EMPTY_TURN }))
        fixtureServer.reset()

        const maxTurnSeconds = Number(scenario.maxTurnSeconds ?? options.maxTurnSeconds)
        let accepted
        try {
          accepted = await remote.send(scenario.prompt)
        } catch (error) {
          if (error instanceof ApiError && ['TURN_BUSY', 'TURN_STOPPING', 'SESSION_CHANGING', 'RUNTIME_NOT_READY'].some(code => String(error.body?.error?.code ?? '').includes(code))) {
            await sleep(1_000)
            accepted = await remote.send(scenario.prompt)
          } else {
            throw error
          }
        }
        const deadline = Date.now() + maxTurnSeconds * 1_000
        let state = null
        let timedOut = false
        let settled = false
        // Independent watchdog: even if status polling stalls, the turn is told
        // to stop at the deadline instead of running unbounded.
        const stopTimer = setTimeout(() => {
          if (settled) return
          timedOut = true
          void remote.stop().catch(() => {})
        }, Math.max(1_000, deadline - Date.now()))
        stopTimer.unref?.()
        try {
          state = await waitForTurn({ remote, turnId: accepted.turnId, deadline })
        } catch (error) {
          if (error.message !== 'turn-timeout') throw error
          timedOut = true
          process.stdout.write(`  ${scenario.name} run ${index + 1}: exceeded ${maxTurnSeconds}s, stopping the turn\n`)
          await remote.stop().catch(() => {})
          try {
            state = await waitForTurn({ remote, turnId: accepted.turnId, deadline: Date.now() + 60_000 })
          } catch {
            state = null
          }
        } finally {
          settled = true
          clearTimeout(stopTimer)
        }
        const baseTurn = state === null ? { ...EMPTY_TURN, status: 'timeout' } : turnFromState(state)
        const turn = {
          ...baseTurn,
          status: timedOut ? 'timeout' : baseTurn.status,
          waitingForUser: baseTurn.waitingForUser === true,
        }
        await waitForTurnEndInLog(eventsPath, accepted.turnId)
        const metrics = readTurnMetrics(eventsPath, accepted.turnId)
        turn.steps = metrics.steps
        turn.toolCalls = metrics.toolCalls
        turn.failedCalls = metrics.failedCalls
        turn.failed = metrics.failed
        turn.toolCounts = metrics.toolCounts
        turn.inputTokens = Number(metrics.usage?.inputTokens) || 0
        turn.outputTokens = Number(metrics.usage?.outputTokens) || 0
        turn.cacheReadTokens = Number(metrics.usage?.cacheReadTokens) || 0
        turn.totalTokens = Number(metrics.usage?.totalTokens) || turn.inputTokens + turn.outputTokens
        turn.usage = metrics.usage
        turn.finalText = metrics.finalText
        turn.logOk = metrics.logOk
        turn.logComplete = metrics.logOk !== null
        turn.reportedLabel = metrics.reportedLabel
        turn.loggedFailedCalls = metrics.loggedFailedCalls
        if (turn.wallMs === null || turn.wallMs === 0) turn.wallMs = metrics.logWallMs
        if (timedOut && turn.status !== 'timeout') turn.status = 'timeout'
        // The hub projection after the turn shows what panel/phone clients get
        // (label, usage, failedCalls) without scraping private logs.
        turn.finalTurnState = state?.turn ?? null
        totalTokens += turn.totalTokens

        const ctx = makeCtx({ fixtureServer, page, turn })
        let check
        try {
          check = normalizeCheck(await scenario.check(ctx))
        } catch (error) {
          check = { status: 'fail', reasons: [`check() threw: ${error.message}`], evidence: null }
        }
        let collateral = null
        if (typeof scenario.collateral === 'function') {
          try {
            collateral = await scenario.collateral(ctx)
          } catch (error) {
            collateral = { ok: false, error: error.message }
          }
        }
        scenarioRuns.push({
          runIndex: index,
          accepted: { turnId: accepted.turnId, clientMessageId: accepted.clientMessageId },
          check,
          collateral,
          turn,
          finishedAt: nowIso(),
        })
        printTable([[
          scenario.name,
          index + 1,
          check.status.toUpperCase(),
          turn.status,
          fmtMs(turn.wallMs),
          turn.steps,
          turn.toolCalls,
          turn.failedCalls,
          `${turn.inputTokens}/${turn.outputTokens}`,
          check.reasons.length > 0 ? check.reasons.join('; ') : (turn.waitingForUser ? 'waiting_for_user' : ''),
        ]])
        writeBatch()
        if (options.maxTotalTokens > 0 && totalTokens >= options.maxTotalTokens) {
          stopReason = `stopped by --max-total-tokens (${totalTokens} >= ${options.maxTotalTokens})`
        }
      }
    }

    process.stdout.write('\n')
    printSummary(results)
    writeBatch()
    process.stdout.write(`\nbatch JSON: ${outputPath}\ntotal tokens: ${totalTokens}\n`)
    return 0
  } finally {
    if (results.length > 0) writeBatch()
    page?.close()
    await edge?.stop().catch(() => {})
    await companion?.stop().catch(() => {})
    await fixtureServer?.close().catch(() => {})
    if (!options.keep) {
      safeRemoveTemp(runRoot)
    } else {
      process.stdout.write(`kept scratch: ${runRoot}\n`)
      process.stdout.write(`companion log: ${companionLog}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return 0
  }
  const scenarios = await loadScenarios(options.scenarios)
  if (options.list) {
    for (const scenario of scenarios) {
      process.stdout.write(`${pad(scenario.name, 22)} fixture ${pad(scenario.fixture, 22)} ${clip(scenario.prompt, 120)}\n`)
    }
    return 0
  }
  const run = options.selfTest ? runSelfTest(options, scenarios) : runModelBatch(options, scenarios)
  const interrupted = new Promise(resolve => {
    process.once('SIGINT', () => resolve(130))
    process.once('SIGTERM', () => resolve(143))
  })
  return await Promise.race([run, interrupted])
}

function finish(code) {
  process.exitCode = code
  // Safety net: if a failed step ever leaks a detached child handle, exit
  // instead of hanging the command after its result was already decided.
  const guard = setTimeout(() => process.exit(code), 3_000)
  guard.unref?.()
}

main()
  .then(code => finish(code ?? 0))
  .catch(error => {
    process.stderr.write(`model-eval: ${error.message}\n`)
    if (error.stack && process.env.MODEL_EVAL_DEBUG === '1') process.stderr.write(`${error.stack}\n`)
    finish(1)
  })