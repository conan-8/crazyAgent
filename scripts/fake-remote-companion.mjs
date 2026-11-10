#!/usr/bin/env node
/**
 * Fake companion for exercising the Android app without a model, DSH, Edge,
 * or the side panel. It serves the real Milestone 1 remote API
 * (`RemoteServer` + `RemoteHub` + `SessionController`) in front of a scripted
 * runner that streams canned text and one fake tool call per turn.
 *
 *   node scripts/fake-remote-companion.mjs              # serve on 127.0.0.1:17883
 *   node scripts/fake-remote-companion.mjs --rotate     # rotate its token (running server picks it up)
 *
 * Reach it from a phone either through `adb reverse tcp:17883 tcp:17883`
 * (debug APK, address http://127.0.0.1:17883) or through tailnet-only
 * Tailscale Serve with `--public-host <name>.ts.net`.
 *
 * Prompt keywords: "slow" makes a ~40 s turn (for force-close/network tests),
 * "fail" ends the turn with an error. Everything else takes ~8 s. Every turn
 * also publishes synthetic 1280x800 screenshots for the phone's live view;
 * "tall" (720x2400) and "square" (900x900) change their shape.
 *
 * The token printed here belongs to this fake server only. It is stored in
 * `.dsh-home/fake-remote/remote-token` (git-ignored), never in the real
 * companion's `.dsh-home/browser-agent/remote-token`.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'
import { RemoteHub } from '../companion/remote-hub.mjs'
import { RemoteServer } from '../companion/remote-server.mjs'
import { SessionController } from '../companion/session-controller.mjs'
import { createRemoteTokenSource, resolveRemoteToken } from '../companion/remote-token.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_FAKE_PORT = 17883
export const DEFAULT_FAKE_TOKEN_FILE = join(root, '.dsh-home/fake-remote/remote-token')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** No-op LogStore: the fake records nothing to disk. */
function silentLogStore() {
  return new Proxy({ sessionId: undefined }, {
    get(target, key) {
      if (key in target) return target[key]
      return () => {}
    },
  })
}

/**
 * A synthetic "browser screenshot" PNG (grid, a title bar, and a block whose
 * position depends on `step`) so the phone's live view visibly changes.
 * @param {number} width @param {number} height @param {number} step
 */
export function fakeScreenshotPng(width, height, step) {
  const row = width * 3 + 1
  const raw = Buffer.alloc(row * height)
  const blockX = (step * 137) % Math.max(1, width - 160)
  const blockY = 60 + ((step * 89) % Math.max(1, height - 220))
  for (let y = 0; y < height; y += 1) {
    const base = y * row
    for (let x = 0; x < width; x += 1) {
      let r = 246, g = 246, b = 248
      if (y < 44) { r = 38; g = 40; b = 46 } else if (x % 80 === 0 || y % 80 === 0) { r = 214; g = 216; b = 222 }
      if (x >= blockX && x < blockX + 160 && y >= blockY && y < blockY + 110) { r = 250; g = 204; b = 21 }
      const at = base + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Streams a canned reply through the same paths the real runtime uses:
 * provider activity deltas into the hub, then DSH notifications for the
 * committed assistant message and a tool call/result.
 */
export class ScriptedRunner {
  /** @param {{ingestActivity: (frame: Record<string, any>) => void, addScreenshot?: (input: Record<string, any>) => void, stepMs?: number}} options */
  constructor(options) {
    this.ingestActivity = options.ingestActivity
    this.addScreenshot = options.addScreenshot ?? (() => {})
    /** Stands in for the provider's help-request activity. */
    this.requestHelp = options.requestHelp ?? (() => {})
    this.shots = 0
    this.stepMs = options.stepMs ?? 300
    this.sessionId = 'fake-session-1'
    this.resumeSessionId = undefined
    this.sessions = 1
    this.turns = 0
    /** @type {string | undefined} */
    this.nextPrompt = undefined
    /** @type {undefined | {reject: (error: Error) => void, cancelled: boolean}} */
    this.current = undefined
  }

  async run(blocks, onNotification) {
    this.turns += 1
    // The controller reports the user's own words at turn start; fall back to the block text.
    const prompt = (this.nextPrompt ?? promptText(blocks)).trim()
    this.nextPrompt = undefined
    const slow = /\bslow\b/iu.test(prompt)
    const fail = /\bfail\b/iu.test(prompt)
    // Screenshot shape: a desktop viewport by default; "tall"/"square" exercise other aspect ratios.
    const [shotWidth, shotHeight] = /\btall\b/iu.test(prompt) ? [720, 2400] : /\bsquare\b/iu.test(prompt) ? [900, 900] : [1280, 800]
    const shoot = callId => {
      this.shots += 1
      this.addScreenshot({
        data: fakeScreenshotPng(shotWidth, shotHeight, this.shots).toString('base64'),
        mimeType: 'image/png',
        width: shotWidth,
        height: shotHeight,
        callId,
        source: 'tool',
      })
    }
    const state = { cancelled: false, reject: () => {} }
    const cancelled = new Promise((_, reject) => { state.reject = reject })
    cancelled.catch(() => {})
    this.current = state
    const wait = async ms => {
      await Promise.race([sleep(ms), cancelled])
      if (state.cancelled) throw new Error('transport closed')
    }
    const event = (type, data) => onNotification?.({ method: 'session.event', params: { sessionId: this.sessionId, event: { type, data } } })
    try {
      onNotification?.({ method: 'session.status', params: { status: 'running' } })
      this.ingestActivity({ type: 'chat.activity', kind: 'model-start' })
      this.ingestActivity({ type: 'chat.activity', kind: 'reasoning', text: 'Planning a fake reply.' })
      const intro = `Fake companion turn ${this.turns}. You said: "${prompt.slice(0, 80)}"`
      for (const word of intro.split(/(?<= )/u)) {
        await wait(this.stepMs / 3)
        this.ingestActivity({ type: 'chat.activity', kind: 'text', text: word })
      }
      const callId = `fake-call-${this.turns}`
      this.ingestActivity({ type: 'chat.activity', kind: 'tool-call-delta', id: callId, name: 'browser_read_text', argumentsDelta: '{"max_chars":' })
      this.ingestActivity({ type: 'chat.activity', kind: 'tool-call-delta', id: callId, argumentsDelta: '2000}' })
      event('assistant/message', { message: { content: [{ type: 'text', text: intro }] } })
      event('tool/call', { callId, name: 'browser_read_text', arguments: '{"max_chars":2000}' })
      await wait(slow ? 8 * this.stepMs : this.stepMs)
      if (fail) throw new Error('Scripted failure requested by the prompt.')
      // "stuck"/"captcha"/"login" in the prompt: ask for the user as agent_request_help does.
      const blocker = /\bcaptcha\b/iu.test(prompt) ? 'captcha' : /\b(log ?in|sign ?in)\b/iu.test(prompt) ? 'login' : /\bstuck\b/iu.test(prompt) ? 'other' : undefined
      if (blocker !== undefined) {
        event('tool/result', { message: { source: { callId }, content: [{ type: 'text', text: 'Fake page text: a blocker is in the way.' }] } })
        const final = `Fake companion: I am blocked (${blocker}) and need you. Reply to continue.`
        event('assistant/message', { message: { content: [{ type: 'text', text: final }] } })
        this.requestHelp({ category: blocker, reason: `Fake blocker (${blocker}): do the step on the computer, then reply here to continue.` })
        onNotification?.({ method: 'session.status', params: { status: 'idle' } })
        return { sessionId: this.sessionId, finalResponse: final, events: [] }
      }
      shoot(callId)
      event('tool/result', { message: { source: { callId }, content: [{ type: 'text', text: 'Fake page text: three products, one cart.' }] } })
      this.ingestActivity({ type: 'chat.activity', kind: 'model-start' })
      // "slow" turns take ~40 s at the default step so force-close/network tests land mid-turn.
      const steps = slow ? 30 : 6
      const stepWait = slow ? 4 * this.stepMs : this.stepMs
      let final = ''
      for (let index = 1; index <= steps; index += 1) {
        const line = `Step ${index} of ${steps}.\n`
        final += line
        await wait(stepWait)
        this.ingestActivity({ type: 'chat.activity', kind: 'text', text: line })
        if (index % 2 === 0) shoot(null)
      }
      final += 'Done (fake companion; no browser was used).'
      this.ingestActivity({ type: 'chat.activity', kind: 'text', text: 'Done (fake companion; no browser was used).' })
      event('assistant/message', { message: { content: [{ type: 'text', text: final }] } })
      onNotification?.({ method: 'session.status', params: { status: 'idle' } })
      return { sessionId: this.sessionId, finalResponse: final, events: [] }
    } finally {
      this.current = undefined
    }
  }

  async interrupt() {
    const current = this.current
    if (current === undefined) return { sessionId: this.sessionId, interrupted: false }
    current.cancelled = true
    current.reject(new Error('transport closed'))
    return { sessionId: this.sessionId, interrupted: true }
  }

  async newSession() {
    this.sessions += 1
    this.sessionId = `fake-session-${this.sessions}`
    return this.sessionId
  }

  /** Continue a saved chat (the fake keeps no model context; only the ID changes). */
  async resume(sessionId) {
    this.sessionId = sessionId
    return sessionId
  }
}

function promptText(blocks) {
  return Array.isArray(blocks) ? blocks.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n') : ''
}

/**
 * Start a fake companion. Port 0 picks a free port (tests).
 * @param {{port?: number, tokenFile?: string, publicHost?: string, stepMs?: number, log?: (line: string) => void}} [options]
 */
export async function startFakeCompanion(options = {}) {
  const tokenFile = options.tokenFile ?? DEFAULT_FAKE_TOKEN_FILE
  mkdirSync(dirname(tokenFile), { recursive: true })
  const { token } = resolveRemoteToken(tokenFile)
  const health = { uiConnected: true, toolsConnected: true, dsh: 'ready', dshMessage: null, provider: 'fake', model: 'fake/scripted', autoCapture: false }
  const hub = new RemoteHub({ serverVersion: 'fake-companion', getHealth: () => health })
  let controller
  const runner = new ScriptedRunner({
    ingestActivity: frame => hub.ingest(frame),
    addScreenshot: input => hub.addScreenshot(input),
    requestHelp: request => controller.noteActivity({ type: 'chat.activity', kind: 'help-request', turnId: controller.turnId, ...request }),
    stepMs: options.stepMs,
  })
  controller = new SessionController({
    bridge: {
      setTurnId() {},
      hasUi: () => health.uiConnected === true,
      // A companion-made capture (the phone's refresh button, or a help request) gets a synthetic image.
      async requestUi(command, _callId, _timeoutMs, extra = {}) {
        if (command?.op !== 'snapshot') return { view: 'compact', screenshotSkipped: true }
        runner.shots += 1
        const image = { data: fakeScreenshotPng(1280, 800, runner.shots).toString('base64'), mimeType: 'image/png', width: 1280, height: 800 }
        hub.addScreenshot({ ...image, source: extra.source ?? 'manual' })
        return { op: 'snapshot', image }
      },
    },
    getRunner: () => runner,
    isDisabled: () => false,
    logStore: silentLogStore(),
    log: options.log ?? (() => {}),
    autoCapture: false,
    provider: 'fake',
    getModelId: () => health.model,
    publish: frame => hub.ingest(frame),
    observers: [{
      turnStarted: info => {
        runner.nextPrompt = info.text
        hub.turnStarted(info)
      },
      turnEnded: info => hub.turnEnded(info),
    }],
  })
  hub.setSession(runner.sessionId)
  const server = new RemoteServer({
    port: options.port ?? DEFAULT_FAKE_PORT,
    getToken: createRemoteTokenSource(tokenFile),
    publicHost: options.publicHost,
    hub,
    controller,
    log: options.log,
  })
  await server.start()
  hub.updateHealth()
  return {
    hub,
    runner,
    controller,
    server,
    token,
    tokenFile,
    url: `http://127.0.0.1:${server.port}`,
    /** Flip simulated desktop health (for exercising the phone's indicators). */
    setHealth(next) {
      Object.assign(health, next)
      hub.updateHealth()
    },
    async stop() {
      await server.stop()
      hub.close()
    },
  }
}

function parseArgs(argv) {
  const args = { rotate: false, port: DEFAULT_FAKE_PORT, tokenFile: DEFAULT_FAKE_TOKEN_FILE, publicHost: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--rotate') args.rotate = true
    else if (arg === '--port') args.port = Number(argv[++index])
    else if (arg === '--token-file') args.tokenFile = argv[++index]
    else if (arg === '--public-host') args.publicHost = argv[++index]
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/fake-remote-companion.mjs [--port 17883] [--public-host host.ts.net] [--token-file path] [--rotate]\n')
      process.exit(0)
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`)
      process.exit(2)
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    process.stderr.write('--port must be 1-65535\n')
    process.exit(2)
  }
  return args
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2))
  if (args.rotate) {
    mkdirSync(dirname(args.tokenFile), { recursive: true })
    const { token } = resolveRemoteToken(args.tokenFile, { rotate: true })
    process.stdout.write(`fake companion token rotated (a running fake picks it up within ~2 s)\ntoken: ${token}\n`)
    process.exit(0)
  }
  const fake = await startFakeCompanion({ port: args.port, tokenFile: args.tokenFile, publicHost: args.publicHost, log: line => process.stderr.write(`[fake] ${line}\n`) })
  process.stdout.write([
    'crazyAgent FAKE remote companion (scripted replies; no model, DSH, or browser)',
    `  listening: ${fake.server.address} (loopback only)`,
    `  instance:  ${fake.hub.instanceId}`,
    `  phone via USB:  adb reverse tcp:${fake.server.port} tcp:${fake.server.port}  →  address http://127.0.0.1:${fake.server.port} (debug APK)`,
    args.publicHost ? `  phone via Serve: https://${args.publicHost}` : '  phone via Serve: rerun with --public-host <name>.ts.net',
    `  token (fake server only): ${fake.token}`,
    '  prompts containing "slow" run ~40 s; "fail" ends with an error. Ctrl+C stops (a restart gets a new instance).',
    '',
  ].join('\n'))
  const shutdown = async () => {
    await fake.stop().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
