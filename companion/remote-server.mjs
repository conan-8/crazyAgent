/**
 * Opt-in phone-facing remote API (`/remote/v1`).
 *
 * A separate loopback HTTP listener (default 127.0.0.1:17873) intended to be
 * published only through tailnet-only Tailscale Serve. It never touches the
 * privileged 17871 bridge roles: it cannot claim `ui`/`tools`, send
 * `browser.command`, configure the LLM, or read logs/files. It only calls the
 * shared session controller (submit/stop/new) and reads the RemoteHub,
 * including the screenshots the agent already captured (by opaque ID).
 *
 * Native clients authenticate with `Authorization: Bearer <remote token>`;
 * there is no cookie or CORS surface. Host is validated, bodies are bounded,
 * and every error is `{error:{code,message,retryable}}`.
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { errorMessage, isRecord } from './protocol.mjs'
import { fingerprint } from './remote-hub.mjs'
import { remoteTokenMatches } from './remote-token.mjs'
import { parsePushRegistration } from './remote-push.mjs'

export const REMOTE_PREFIX = '/remote/v1'
export const DEFAULT_REMOTE_PORT = 17873
export const MAX_MESSAGE_BODY_BYTES = 18 * 1024 * 1024
export const MAX_COMMAND_BODY_BYTES = 16 * 1024
export const MAX_PROMPT_CHARS = 100_000
export const MAX_EVENT_SUBSCRIBERS = 8
export const WS_HEARTBEAT_MS = 25_000
export const WS_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u
const SCREENSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u

const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
})

/** Fixed-window limiter. */
class WindowLimiter {
  /** @param {number} limit @param {number} windowMs @param {() => number} now */
  constructor(limit, windowMs, now) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
    this.start = 0
    this.count = 0
  }

  /** @returns {boolean} true when the event is allowed */
  take() {
    const t = this.now()
    if (t - this.start >= this.windowMs) {
      this.start = t
      this.count = 0
    }
    if (this.count >= this.limit) return false
    this.count += 1
    return true
  }

  /** True when the window is already exhausted, without consuming. */
  exhausted() {
    return this.now() - this.start < this.windowMs && this.count >= this.limit
  }
}

class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {boolean} [retryable] @param {Record<string, string>} [headers] */
  constructor(status, code, message, retryable = false, headers = {}) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
    this.headers = headers
  }
}

export class RemoteServer {
  /**
   * @param {{
   *   host?: string,
   *   port?: number,
   *   getToken: () => string | undefined,
   *   publicHost?: string,
   *   hub: import('./remote-hub.mjs').RemoteHub,
   *   controller: {
   *     submit: (input: Record<string, any>) => {ok: true, turnId: string, done: Promise<void>} | {ok: false, code: string, message: string, retryable: boolean},
   *     stop: () => {state: string, turnId?: string, done: Promise<void>},
   *     newChat: () => Promise<{ok: true, sessionId: string} | {ok: false, code: string, message: string, retryable: boolean}>,
   *     resumeChat: (sessionId: string) => Promise<{ok: true, sessionId: string} | {ok: false, code: string, message: string, retryable: boolean}>,
   *     captureSnapshot?: () => Promise<{ok: true} | {ok: false, code: string, message: string, retryable: boolean}>,
   *   },
   *   log?: (message: string) => void,
   *   audit?: (event: string, data: Record<string, unknown>) => void,
   *   now?: () => number,
   *   limits?: {authFailuresPerMinute?: number, messagesPerMinute?: number, requestsPerMinute?: number, snapshotsPerMinute?: number, pushRegistrationsPerMinute?: number},
   *   push?: import('./remote-push.mjs').PushService,
   *   heartbeatMs?: number,
   * }} options
   */
  constructor(options) {
    this.host = options.host ?? '127.0.0.1'
    if (this.host !== '127.0.0.1' && this.host !== '::1' && this.host !== 'localhost') {
      throw new Error('the remote API binds loopback only; publish it with tailnet-only Tailscale Serve')
    }
    this.requestedPort = options.port ?? DEFAULT_REMOTE_PORT
    this.port = this.requestedPort
    this.getToken = options.getToken
    this.publicHost = normalizeHost(options.publicHost)
    this.hub = options.hub
    this.controller = options.controller
    this.log = options.log ?? (() => {})
    this.audit = options.audit ?? (() => {})
    this.now = options.now ?? Date.now
    const limits = options.limits ?? {}
    this.authFailures = new WindowLimiter(limits.authFailuresPerMinute ?? 20, 60_000, this.now)
    this.messageLimiter = new WindowLimiter(limits.messagesPerMinute ?? 30, 60_000, this.now)
    this.requestLimiter = new WindowLimiter(limits.requestsPerMinute ?? 600, 60_000, this.now)
    this.snapshotLimiter = new WindowLimiter(limits.snapshotsPerMinute ?? 20, 60_000, this.now)
    this.pushLimiter = new WindowLimiter(limits.pushRegistrationsPerMinute ?? 30, 60_000, this.now)
    /** @type {import('./remote-push.mjs').PushService | undefined} */
    this.push = options.push
    this.heartbeatMs = options.heartbeatMs ?? WS_HEARTBEAT_MS
    /** @type {import('node:http').Server | undefined} */
    this.http = undefined
    /** @type {WebSocketServer | undefined} */
    this.wss = undefined
    /** @type {Set<{ws: import('ws').WebSocket, token: string, unsubscribe: () => void, alive: boolean}>} */
    this.clients = new Set()
    /** @type {NodeJS.Timeout | undefined} */
    this.heartbeat = undefined
    /** @type {Set<import('node:net').Socket>} */
    this.sockets = new Set()
  }

  get address() {
    return `http://${this.host}:${this.port}${REMOTE_PREFIX}`
  }

  async start() {
    const http = createServer((req, res) => { void this.#handle(req, res) })
    http.headersTimeout = 15_000
    http.requestTimeout = 120_000
    http.on('connection', socket => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    http.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head))
    this.http = http
    await new Promise((resolve, reject) => {
      const onError = error => {
        http.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        http.off('error', onError)
        const address = http.address()
        if (address !== null && typeof address === 'object') this.port = address.port
        resolve()
      }
      http.once('error', onError)
      http.once('listening', onListening)
      http.listen(this.requestedPort, this.host)
    })
    this.heartbeat = setInterval(() => this.#beat(), this.heartbeatMs)
    this.heartbeat.unref?.()
    this.log(`remote: listening on ${this.address}`)
  }

  async stop() {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const client of this.clients) {
      client.unsubscribe()
      try {
        client.ws.close(1001, 'companion shutting down')
      } catch {
        client.ws.terminate()
      }
    }
    this.clients.clear()
    this.wss?.close()
    const http = this.http
    this.http = undefined
    this.wss = undefined
    if (http === undefined) return
    await new Promise(resolve => {
      http.close(() => resolve())
      http.closeIdleConnections?.()
      // Bounded: do not let a stalled client hold shutdown open.
      setTimeout(() => {
        for (const socket of this.sockets) socket.destroy()
        resolve()
      }, 1_000).unref?.()
    })
  }

  /** @param {import('node:http').IncomingMessage} req */
  #hostOk(req) {
    const host = normalizeHost(req.headers.host)
    if (host === undefined) return false
    const local = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]
    if (local.includes(host)) return true
    if (this.publicHost === undefined) return false
    return host === this.publicHost || host === `${this.publicHost}:443`
  }

  /**
   * Authenticate one request. A valid token is never throttled; invalid
   * attempts share a bounded failure window (Serve makes every peer look like
   * loopback, so per-address buckets would be meaningless).
   * @param {import('node:http').IncomingMessage} req
   * @returns {string} the token that matched
   */
  #authenticate(req) {
    const header = req.headers.authorization
    const given = typeof header === 'string' && /^Bearer [^\s]+$/u.test(header) ? header.slice(7) : undefined
    const expected = this.getToken()
    if (expected !== undefined && remoteTokenMatches(given, expected)) return expected
    if (!this.authFailures.take()) {
      throw new HttpError(429, 'AUTH_THROTTLED', 'Too many failed authentication attempts. Wait a minute.', true, { 'retry-after': '60' })
    }
    this.audit('auth.failed', { reason: given === undefined ? 'missing' : expected === undefined ? 'no-remote-token' : 'mismatch' })
    throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid remote token.', false, { 'www-authenticate': 'Bearer' })
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async #handle(req, res) {
    const requestId = randomUUID()
    const started = this.now()
    let status = 500
    let code = 'INTERNAL'
    const url = parseUrl(req.url)
    try {
      if (!this.#hostOk(req)) throw new HttpError(421, 'HOST_NOT_ALLOWED', 'Unexpected Host header.')
      if (url === undefined || !url.pathname.startsWith(`${REMOTE_PREFIX}/`)) throw new HttpError(404, 'NOT_FOUND', 'Unknown route.')
      this.#authenticate(req)
      if (!this.requestLimiter.take()) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests.', true, { 'retry-after': '60' })
      const result = await this.#route(req, url)
      status = result.status
      code = 'OK'
      if (result.binary !== undefined) sendBinary(res, result.status, result.binary, requestId)
      else sendJson(res, result.status, result.body, requestId)
    } catch (error) {
      const failure = error instanceof HttpError
        ? error
        : new HttpError(500, 'INTERNAL', 'Internal remote API error.', true)
      if (!(error instanceof HttpError)) this.log(`remote: ${req.method} ${url?.pathname ?? '?'} failed: ${errorMessage(error)}`)
      status = failure.status
      code = failure.code
      sendJson(res, failure.status, { error: { code: failure.code, message: failure.message, retryable: failure.retryable } }, requestId, failure.headers)
      if (failure.status === 413 || failure.status === 400) req.resume()
    } finally {
      this.audit('request', {
        requestId,
        method: req.method,
        route: routeLabel(url?.pathname),
        status,
        code,
        ms: this.now() - started,
      })
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   * @returns {Promise<{status: number, body?: Record<string, any>, binary?: {data: Buffer, mimeType: string}}>}
   */
  async #route(req, url) {
    const path = url.pathname.slice(REMOTE_PREFIX.length)
    const method = req.method ?? 'GET'

    if (path === '/state') {
      allow(method, ['GET'])
      return { status: 200, body: this.hub.projection() }
    }
    if (path === '/sessions') {
      allow(method, ['GET'])
      return { status: 200, body: { sessions: this.hub.sessionSummaries() } }
    }
    const session = /^\/sessions\/([^/]+)$/u.exec(path)
    if (session !== null) {
      allow(method, ['GET'])
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(session[1])) throw new HttpError(400, 'INVALID_SESSION_ID', 'Session IDs are opaque tokens.')
      const transcript = this.hub.transcript(session[1])
      if (transcript === undefined) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Unknown or expired saved chat.')
      return { status: 200, body: transcript }
    }
    const resume = /^\/sessions\/([^/]+)\/resume$/u.exec(path)
    if (resume !== null) {
      allow(method, ['POST'])
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(resume[1])) throw new HttpError(400, 'INVALID_SESSION_ID', 'Session IDs are opaque tokens.')
      return this.#postResume(resume[1], await readJson(req, MAX_COMMAND_BODY_BYTES))
    }
    if (path === '/messages') {
      allow(method, ['POST'])
      return this.#postMessage(await readJson(req, MAX_MESSAGE_BODY_BYTES))
    }
    if (path === '/stop') {
      allow(method, ['POST'])
      return this.#postStop(await readJson(req, MAX_COMMAND_BODY_BYTES))
    }
    if (path === '/new') {
      allow(method, ['POST'])
      return this.#postNew(await readJson(req, MAX_COMMAND_BODY_BYTES))
    }
    if (path === '/events') {
      throw new HttpError(426, 'UPGRADE_REQUIRED', 'Open /events as a WebSocket.', false, { upgrade: 'websocket' })
    }
    if (path === '/snapshots') {
      allow(method, ['POST'])
      return this.#postSnapshot(await readJson(req, MAX_COMMAND_BODY_BYTES))
    }
    const screenshot = /^\/screenshots\/([^/]+)$/u.exec(path)
    if (screenshot !== null) {
      allow(method, ['GET'])
      if (!SCREENSHOT_ID_PATTERN.test(screenshot[1])) throw new HttpError(400, 'INVALID_SCREENSHOT_ID', 'Screenshot IDs are opaque tokens.')
      // An opaque key into the hub's in-memory mirror; never resolved as a path.
      const image = this.hub.screenshot(screenshot[1])
      if (image === undefined) throw new HttpError(404, 'SCREENSHOT_NOT_FOUND', 'Unknown or expired screenshot.')
      return { status: 200, binary: image }
    }
    const device = /^\/push\/devices\/([^/]+)$/u.exec(path)
    if (device !== null) {
      allow(method, ['PUT', 'DELETE'])
      if (!DEVICE_ID_PATTERN.test(device[1])) throw new HttpError(400, 'INVALID_DEVICE_ID', 'Device IDs are opaque tokens.')
      if (method === 'DELETE') return this.#deletePushDevice(device[1])
      return this.#putPushDevice(device[1], await readJson(req, MAX_COMMAND_BODY_BYTES))
    }
    throw new HttpError(404, 'NOT_FOUND', 'Unknown route.')
  }

  /** @param {Record<string, any>} body */
  #postMessage(body) {
    const clientMessageId = requireClientId(body.clientMessageId, 'clientMessageId')
    if (typeof body.text !== 'string') throw new HttpError(422, 'INVALID_TEXT', 'text must be a string.')
    if (body.text.length > MAX_PROMPT_CHARS) throw new HttpError(413, 'TEXT_TOO_LARGE', `text exceeds ${MAX_PROMPT_CHARS} characters.`)
    if (body.images !== undefined && !Array.isArray(body.images)) throw new HttpError(422, 'INVALID_ATTACHMENT', 'images must be an array.')
    if (body.autoCapture !== undefined && typeof body.autoCapture !== 'boolean') throw new HttpError(422, 'INVALID_AUTO_CAPTURE', 'autoCapture must be a boolean.')
    if (body.planMode !== undefined && typeof body.planMode !== 'boolean') throw new HttpError(422, 'INVALID_PLAN_MODE', 'planMode must be a boolean.')
    if (body.steer !== undefined && typeof body.steer !== 'boolean') throw new HttpError(422, 'INVALID_STEER', 'steer must be a boolean.')
    if (body.confirm !== undefined && body.confirm !== 'approve' && body.confirm !== 'deny') throw new HttpError(422, 'INVALID_CONFIRMATION', 'confirm must be "approve" or "deny".')
    const print = fingerprint({ text: body.text, images: body.images ?? [], autoCapture: body.autoCapture ?? null, planMode: body.planMode === true, ...(body.steer === true ? { steer: true } : {}), ...(body.confirm !== undefined ? { confirm: body.confirm } : {}) })
    const cached = this.#cached('message', clientMessageId, print)
    if (cached !== undefined) return cached
    if (!this.messageLimiter.take()) throw new HttpError(429, 'RATE_LIMITED', 'Too many prompts. Wait a minute.', true, { 'retry-after': '60' })

    const result = this.controller.submit({
      text: body.text,
      images: body.images,
      autoCapture: body.autoCapture,
      planMode: body.planMode === true,
      steer: body.steer === true,
      ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
      origin: 'remote',
      clientMessageId,
    })
    /** @type {{status: number, body: Record<string, any>}} */
    let outcome
    if (result.ok) {
      result.done.catch(() => {})
      outcome = {
        status: 202,
        body: {
          accepted: true,
          clientMessageId,
          turnId: result.turnId,
          instanceId: this.hub.instanceId,
          sessionId: this.hub.sessionId,
          sequence: this.hub.seq,
          // The running turn is being stopped; this turn starts when it ends.
          ...(result.steered === true ? { steered: true } : {}),
        },
      }
    } else {
      outcome = rejection(result, { clientMessageId, instanceId: this.hub.instanceId })
    }
    this.hub.rememberCommand('message', clientMessageId, print, outcome)
    return outcome
  }

  /** @param {Record<string, any>} body */
  #postStop(body) {
    const clientCommandId = requireClientId(body.clientCommandId, 'clientCommandId')
    const cached = this.#cached('stop', clientCommandId, '')
    if (cached !== undefined) return cached
    const result = this.controller.stop()
    result.done.catch(() => {})
    const outcome = {
      status: result.state === 'idle' ? 200 : 202,
      body: {
        clientCommandId,
        // `stopping` means requested; the actual end arrives as chat.stopped.
        state: result.state === 'idle' ? 'idle' : 'stopping',
        turnId: result.turnId ?? null,
        instanceId: this.hub.instanceId,
      },
    }
    this.hub.rememberCommand('stop', clientCommandId, '', outcome)
    return outcome
  }

  /** @param {Record<string, any>} body */
  async #postNew(body) {
    const clientCommandId = requireClientId(body.clientCommandId, 'clientCommandId')
    const cached = this.#cached('new', clientCommandId, '')
    if (cached !== undefined) return cached
    const pending = (async () => {
      const result = await this.controller.newChat()
      if (result.ok) {
        return { status: 200, body: { clientCommandId, sessionId: result.sessionId, instanceId: this.hub.instanceId } }
      }
      return rejection(result, { clientCommandId, instanceId: this.hub.instanceId })
    })()
    // Remember the in-flight promise so a concurrent duplicate awaits the same result.
    this.hub.rememberCommand('new', clientCommandId, '', pending)
    try {
      const outcome = await pending
      this.hub.rememberCommand('new', clientCommandId, '', outcome)
      return outcome
    } catch (error) {
      const outcome = { status: 500, body: { error: { code: 'NEW_CHAT_FAILED', message: errorMessage(error), retryable: true }, clientCommandId } }
      this.hub.rememberCommand('new', clientCommandId, '', outcome)
      return outcome
    }
  }

  /**
   * Continue a saved chat: only sessions in the bounded history can be named.
   * @param {string} sessionId @param {Record<string, any>} body
   */
  async #postResume(sessionId, body) {
    const clientCommandId = requireClientId(body.clientCommandId, 'clientCommandId')
    const cached = this.#cached('resume', clientCommandId, sessionId)
    if (cached !== undefined) return cached
    if (this.hub.transcript(sessionId) === undefined) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Unknown or expired saved chat.')
    const pending = (async () => {
      const result = await this.controller.resumeChat(sessionId)
      if (result.ok) {
        return { status: 200, body: { clientCommandId, sessionId: result.sessionId, instanceId: this.hub.instanceId } }
      }
      return rejection(result, { clientCommandId, instanceId: this.hub.instanceId })
    })()
    this.hub.rememberCommand('resume', clientCommandId, sessionId, pending)
    try {
      const outcome = await pending
      this.hub.rememberCommand('resume', clientCommandId, sessionId, outcome)
      return outcome
    } catch (error) {
      const outcome = { status: 500, body: { error: { code: 'RESUME_FAILED', message: errorMessage(error), retryable: true }, clientCommandId } }
      this.hub.rememberCommand('resume', clientCommandId, sessionId, outcome)
      return outcome
    }
  }

  /**
   * Register or replace this phone's FCM token. The remote credential
   * authorizes it; the FCM token itself is not a controller credential.
   * @param {string} deviceId @param {Record<string, any>} body
   */
  #putPushDevice(deviceId, body) {
    const push = this.push
    if (push === undefined || !push.configured) {
      throw new HttpError(503, 'PUSH_NOT_CONFIGURED', 'Push notifications are not set up on this computer.')
    }
    if (!this.pushLimiter.take()) throw new HttpError(429, 'RATE_LIMITED', 'Too many push registrations. Wait a minute.', true, { 'retry-after': '60' })
    const checked = parsePushRegistration(body)
    if (!checked.ok) throw new HttpError(422, checked.code, checked.message)
    const { created } = push.registry.put(deviceId, checked.registration)
    this.audit('push.registered', { deviceId, created, devices: push.registry.size })
    return { status: 200, body: { deviceId, registered: true, created, instanceId: this.hub.instanceId } }
  }

  /** Unregister one phone's notifications; nothing else is rotated. Idempotent. @param {string} deviceId */
  #deletePushDevice(deviceId) {
    const removed = this.push?.registry.delete(deviceId) === true
    this.audit('push.unregistered', { deviceId, removed })
    return { status: 200, body: { deviceId, registered: false, removed, instanceId: this.hub.instanceId } }
  }

  /**
   * One fresh capture between turns. While the agent works nothing is
   * injected: the refusal names the latest image the agent already took.
   * @param {Record<string, any>} body
   */
  async #postSnapshot(body) {
    const clientCommandId = requireClientId(body.clientCommandId, 'clientCommandId')
    const cached = this.#cached('snapshot', clientCommandId, '')
    if (cached !== undefined) return cached
    if (typeof this.controller.captureSnapshot !== 'function') {
      throw new HttpError(501, 'NOT_IMPLEMENTED', 'On-demand screenshots are not available in this companion.')
    }
    if (!this.snapshotLimiter.take()) throw new HttpError(429, 'RATE_LIMITED', 'Too many screenshot requests. Wait a minute.', true, { 'retry-after': '60' })
    const pending = (async () => {
      const before = this.hub.latestScreenshot?.screenshotId ?? null
      const result = await this.controller.captureSnapshot()
      const latest = this.hub.latestScreenshot
      const extra = { clientCommandId, instanceId: this.hub.instanceId, latestScreenshotId: latest?.screenshotId ?? null }
      if (result.ok && latest !== null && latest.screenshotId !== before) {
        return { status: 201, body: { ...extra, screenshotId: latest.screenshotId, screenshot: { ...latest } } }
      }
      const failure = result.ok
        ? { code: 'SNAPSHOT_FAILED', message: 'The capture could not be kept (unsupported or too large).', retryable: true }
        : result
      const status = failure.code === 'UI_DISCONNECTED' ? 503 : failure.code === 'SNAPSHOT_FAILED' ? 502 : 409
      return { status, body: { error: { code: failure.code, message: failure.message, retryable: failure.retryable }, ...extra } }
    })()
    this.hub.rememberCommand('snapshot', clientCommandId, '', pending)
    const outcome = await pending
    this.hub.rememberCommand('snapshot', clientCommandId, '', outcome)
    return outcome
  }

  /**
   * @param {string} kind @param {string} id @param {string} print
   * @returns {any}
   */
  #cached(kind, id, print) {
    const hit = this.hub.lookupCommand(kind, id, print)
    if (hit === undefined) return undefined
    if (hit.conflict) {
      throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This client ID was already used for a different command.')
    }
    const replay = outcome => ({ status: outcome.status, body: { ...outcome.body, replayed: true } })
    return hit.outcome instanceof Promise ? hit.outcome.then(replay) : replay(hit.outcome)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  #upgrade(req, socket, head) {
    const url = parseUrl(req.url)
    const reject = (status, code, message, headers = {}) => {
      const body = JSON.stringify({ error: { code, message, retryable: status === 429 || status === 503 } })
      const lines = [
        `HTTP/1.1 ${status} ${statusText(status)}`,
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(body)}`,
        'connection: close',
        ...Object.entries({ ...SECURITY_HEADERS, ...headers }).map(([k, v]) => `${k}: ${v}`),
      ]
      socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`)
      this.audit('events.rejected', { status, code })
    }
    if (!this.#hostOk(req)) return reject(421, 'HOST_NOT_ALLOWED', 'Unexpected Host header.')
    if (url === undefined || url.pathname !== `${REMOTE_PREFIX}/events`) return reject(404, 'NOT_FOUND', 'Unknown route.')
    let token
    try {
      token = this.#authenticate(req)
    } catch (error) {
      const failure = /** @type {HttpError} */ (error)
      return reject(failure.status, failure.code, failure.message, failure.headers)
    }
    if (this.clients.size >= MAX_EVENT_SUBSCRIBERS) return reject(503, 'TOO_MANY_SUBSCRIBERS', 'Too many event streams are open.')
    const wss = this.wss
    if (wss === undefined) return reject(503, 'SHUTTING_DOWN', 'The remote API is stopping.')
    wss.handleUpgrade(req, socket, head, ws => this.#attach(ws, token, url))
  }

  /**
   * Replay then subscribe in one synchronous block: Node runs no other
   * publication between them, so live events cannot interleave or reorder.
   * @param {import('ws').WebSocket} ws @param {string} token @param {URL} url
   */
  #attach(ws, token, url) {
    const cursor = {
      after: url.searchParams.get('after') ?? undefined,
      instance: url.searchParams.get('instance') ?? undefined,
    }
    const plan = this.hub.catchUp(cursor)
    const client = { ws, token, unsubscribe: () => {}, alive: true }
    const deliver = frame => {
      if (ws.readyState !== 1) return
      if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
        // A stalled reader must reconnect and resync rather than grow memory.
        ws.close(1013, 'slow consumer; reconnect and resync')
        return
      }
      try {
        ws.send(JSON.stringify(frame))
      } catch {
        // close handler cleans up
      }
    }
    if (plan.mode === 'resync') deliver(this.hub.resyncFrame(plan.reason))
    else for (const envelope of plan.events) deliver(envelope)
    client.unsubscribe = this.hub.subscribe(deliver)
    this.clients.add(client)
    this.audit('events.open', { mode: plan.mode, replayed: plan.mode === 'replay' ? plan.events.length : 0, reason: plan.mode === 'resync' ? plan.reason : undefined })
    ws.on('pong', () => { client.alive = true })
    ws.on('message', () => {
      // The event stream is server → client only.
    })
    const cleanup = () => {
      client.unsubscribe()
      this.clients.delete(client)
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)
  }

  #beat() {
    const current = this.getToken()
    for (const client of [...this.clients]) {
      if (current === undefined || !remoteTokenMatches(client.token, current)) {
        // Token rotated or removed: revoke open streams too.
        client.ws.close(4401, 'remote token revoked')
        continue
      }
      if (!client.alive) {
        client.ws.terminate()
        continue
      }
      client.alive = false
      try {
        client.ws.ping()
      } catch {
        client.ws.terminate()
      }
    }
  }
}

/** @param {{code: string, message: string, retryable: boolean}} result @param {Record<string, any>} extra */
function rejection(result, extra) {
  const status = result.code === 'RUNTIME_NOT_READY' ? 503
    : result.code === 'INVALID_ATTACHMENT' || result.code === 'EMPTY_PROMPT' || result.code === 'INVALID_CONFIRMATION' ? 422
      : 409
  return {
    status,
    body: { error: { code: result.code, message: result.message, retryable: result.retryable }, ...extra },
  }
}

/** @param {unknown} value @param {string} field */
function requireClientId(value, field) {
  if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) {
    throw new HttpError(422, 'INVALID_CLIENT_ID', `${field} must be 8-128 characters of [A-Za-z0-9_-] (a UUID works).`)
  }
  return value
}

/** @param {string} method @param {string[]} methods */
function allow(method, methods) {
  if (!methods.includes(method)) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Use ${methods.join(' or ')}.`, false, { allow: methods.join(', ') })
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Record<string, any>>}
 */
async function readJson(req, limit) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json.')
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${limit} bytes.`)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${limit} bytes.`)
    chunks.push(chunk)
  }
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'MALFORMED_JSON', 'Body is not valid JSON.')
  }
  if (!isRecord(value)) throw new HttpError(400, 'MALFORMED_JSON', 'Body must be a JSON object.')
  return value
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, any>} body
 * @param {string} requestId
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, body, requestId, headers = {}) {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-request-id': requestId,
    ...SECURITY_HEADERS,
    ...headers,
  })
  res.end(text)
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {{data: Buffer, mimeType: string}} image
 * @param {string} requestId
 */
function sendBinary(res, status, image, requestId) {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': image.mimeType,
    'content-length': image.data.length,
    'x-request-id': requestId,
    ...SECURITY_HEADERS,
  })
  res.end(image.data)
}

/** @param {string | undefined} raw */
function parseUrl(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return undefined
  try {
    const url = new URL(raw, 'http://remote.invalid')
    // Reject encoded separators/traversal outright; nothing here is a path.
    if (/%2f|%5c|\.\./iu.test(raw.split('?')[0])) return undefined
    return url
  } catch {
    return undefined
  }
}

/** @param {unknown} value */
function normalizeHost(value) {
  if (typeof value !== 'string') return undefined
  const host = value.trim().toLowerCase().replace(/\.$/u, '')
  return host.length > 0 && host.length <= 255 && /^[a-z0-9.:[\]-]+$/u.test(host) ? host : undefined
}

/** @param {string | undefined} pathname */
function routeLabel(pathname) {
  if (typeof pathname !== 'string') return null
  return pathname
    .replace(/\/sessions\/[^/]+\/resume$/u, '/sessions/:id/resume')
    .replace(/\/sessions\/[^/]+$/u, '/sessions/:id')
    .replace(/\/screenshots\/[^/]+$/u, '/screenshots/:id')
    .replace(/\/push\/devices\/[^/]+$/u, '/push/devices/:id')
    .slice(0, 80)
}

/** @param {number} status */
function statusText(status) {
  return {
    401: 'Unauthorized',
    404: 'Not Found',
    421: 'Misdirected Request',
    429: 'Too Many Requests',
    503: 'Service Unavailable',
  }[status] ?? 'Error'
}
