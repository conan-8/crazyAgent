/**
 * Loopback WebSocket bridge.
 *
 * Two authenticated roles share one port:
 *   ui    — the Chrome side panel, which owns chrome.* and executes browser ops
 *   tools — the DSH browser-use provider, which issues browser ops
 *
 * The companion itself also sends `snapshot` commands to the UI for the
 * per-turn auto-capture. Plugin-issued commands and companion-issued commands
 * are correlated independently but share the same wire frame shape.
 *
 * Every inbound/outbound frame and client log event is optionally forwarded to
 * `onLog` for the debug bundle. Images are passed through to the debug store,
 * which saves them separately instead of writing base64 into events.jsonl.
 */

import { createServer } from 'node:http'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import {
  BRIDGE_PATH,
  HANDSHAKE_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  UI_COMMAND_TIMEOUT_MS,
  errorMessage,
  isRecord,
  send,
} from './protocol.mjs'

/** Default side-panel reconnect grace window before browser commands fail. */
export const DEFAULT_UI_GRACE_MS = 8_000
/** Environment override for the side-panel reconnect grace window. */
export const UI_GRACE_ENV = 'CRAZYAGENT_UI_GRACE_MS'
/** Retryable error code used when the side panel is gone or reloading. */
export const SIDE_PANEL_CLOSED = 'SIDE_PANEL_CLOSED'

/** Failure message for companion-issued commands (auto-capture). */
const REQUEST_UI_CLOSED_MESSAGE = 'the CrazyAgent side panel is not connected; it may be reloading — retry this call (or ask the user to reopen the side panel)'
/** Failure message returned to the provider when its command cannot reach the side panel. */
const PROVIDER_UI_CLOSED_MESSAGE = 'the CrazyAgent side panel is disconnected or reloading; retry this call (or ask the user to reopen the side panel)'

export class Bridge {
  /**
   * @param {{
   *   host: string,
   *   port: number,
   *   token: string,
   *   log: (message: string) => void,
   *   onChat: (text: string, ui: import('ws').WebSocket, message: Record<string, unknown>) => void | Promise<void>,
   *   onNewChat: (ui: import('ws').WebSocket) => void | Promise<void>,
   *   onStop?: (ui: import('ws').WebSocket, message: Record<string, unknown>) => void | Promise<void>,
   *   onConnectionChange?: () => void,
   *   onLog?: (entry: {direction: 'in'|'out'|'event', role?: string, frame: Record<string, any>}) => void,
   *   onControl?: (message: Record<string, any>, ui: import('ws').WebSocket) => void | Promise<void>,
   *   uiGraceMs?: number,
   * }} options
   */
  constructor(options) {
    this.host = options.host
    this.requestedPort = options.port
    this.token = options.token
    this.log = options.log
    this.onChat = options.onChat
    this.onNewChat = options.onNewChat
    this.onStop = options.onStop
    this.onConnectionChange = options.onConnectionChange
    this.onLog = options.onLog
    this.onControl = options.onControl
    /** Reconnect grace window before browser commands fail with SIDE_PANEL_CLOSED. */
    this.uiGraceMs = resolveUiGraceMs(options.uiGraceMs)
    /** @type {import('ws').WebSocket | undefined} */
    this.ui = undefined
    /** @type {import('ws').WebSocket | undefined} */
    this.tools = undefined
    this.port = options.port
    this.currentTurnId = undefined
    /** @type {Map<string, {ws: import('ws').WebSocket, turnId?: string, callId?: string, command?: Record<string, unknown>}>} */
    this.upstream = new Map()
    /** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout, turnId?: string, callId?: string, command?: Record<string, unknown>}>} */
    this.uiRequests = new Map()
    /** @type {import('node:http').Server | undefined} */
    this.http = undefined
    /** @type {WebSocketServer | undefined} */
    this.wss = undefined
    /** @type {Set<{resolve: () => void, reject: (error: Error) => void, timer: NodeJS.Timeout}>} */
    this.uiWaiters = new Set()
    /** @type {boolean} */
    this.stopped = false
  }

  async start() {
    this.stopped = false
    const http = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ui: this.hasUi(), tools: this.tools !== undefined, port: this.port }))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    this.http = http
    this.wss = new WebSocketServer({ server: http, path: BRIDGE_PATH, maxPayload: MAX_PAYLOAD_BYTES })
    this.wss.on('connection', (ws, request) => this.#attach(ws, request))

    await new Promise((resolve, reject) => {
      const onError = (error) => {
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
    this.log(`bridge: listening on ws://${this.host}:${this.port}${BRIDGE_PATH}`)
    this.#emit({ direction: 'event', role: 'companion', frame: { type: 'bridge.listen', host: this.host, port: this.port } })
  }

  async stop() {
    this.stopped = true
    for (const waiter of this.uiWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('bridge stopped'))
    }
    this.uiWaiters.clear()
    for (const request of this.uiRequests.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('bridge stopped'))
    }
    this.uiRequests.clear()
    this.upstream.clear()
    this.#emit({ direction: 'event', role: 'companion', frame: { type: 'bridge.stop' } })
    this.wss?.close()
    this.http?.close()
    this.wss = undefined
    this.http = undefined
    this.ui = undefined
    this.tools = undefined
  }

  hasUi() {
    return this.ui !== undefined && this.ui.readyState === 1
  }

  hasTools() {
    return this.tools !== undefined && this.tools.readyState === 1
  }

  /**
   * Resolve once a side panel is connected (a `ui` hello was accepted), or
   * immediately when one already is. Rejects after `timeoutMs`, when the
   * bridge is stopped, or immediately for a non-positive timeout.
   *
   * This is a pre-send gate only: callers must not queue or replay a browser
   * command that was already forwarded to a side panel (a click must not run
   * twice).
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  waitForUi(timeoutMs = this.uiGraceMs) {
    if (this.hasUi()) return Promise.resolve()
    if (this.stopped) return Promise.reject(new Error('bridge stopped'))
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0
    if (timeout === 0) {
      return Promise.reject(sidePanelClosedError('the CrazyAgent side panel is not connected'))
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined }
      waiter.timer = setTimeout(() => {
        // Deleting first makes stop() and the timeout mutually exclusive.
        if (!this.uiWaiters.delete(waiter)) return
        reject(sidePanelClosedError(`the CrazyAgent side panel did not reconnect within ${timeout}ms`))
      }, timeout)
      waiter.timer.unref?.()
      this.uiWaiters.add(waiter)
    })
  }

  /** @param {string | undefined} turnId */
  setTurnId(turnId) {
    this.currentTurnId = turnId
  }

  /** @param {Record<string, unknown>} frame */
  sendToUi(frame) {
    if (this.ui === undefined) return false
    // Transient model activity is logged on the inbound side only; skip the
    // duplicate outbound copy in events.jsonl.
    if (frame.type === 'chat.activity') return send(this.ui, frame)
    return this.#send(this.ui, 'ui', frame)
  }

  /** @param {Record<string, unknown>} frame */
  sendToTools(frame) {
    if (this.tools === undefined) return false
    return this.#send(this.tools, 'tools', frame)
  }

  /**
   * Ask the side panel to execute one browser command (used for auto-capture).
   * When the panel is absent, wait up to `uiGraceMs` for a reconnect before
   * failing with the retryable SIDE_PANEL_CLOSED code. The per-command timeout
   * only starts once the command has actually been sent.
   * @param {{op: string, args?: Record<string, unknown>}} command
   * @param {string} callId
   * @param {number} [timeoutMs]
   * @returns {Promise<Record<string, any>>}
   */
  async requestUi(command, callId, timeoutMs = UI_COMMAND_TIMEOUT_MS) {
    if (!this.hasUi()) {
      const { connected, error } = await this.#awaitUiGrace(command)
      if (!connected) {
        if (error?.code === SIDE_PANEL_CLOSED) throw sidePanelClosedError(REQUEST_UI_CLOSED_MESSAGE)
        throw error ?? sidePanelClosedError(REQUEST_UI_CLOSED_MESSAGE)
      }
    }
    if (!this.hasUi()) throw sidePanelClosedError(REQUEST_UI_CLOSED_MESSAGE)
    return new Promise((resolve, reject) => {
      const id = `auto-${randomUUID()}`
      const turnId = this.currentTurnId
      const timer = setTimeout(() => {
        this.uiRequests.delete(id)
        this.#emit({
          direction: 'event',
          role: 'companion',
          frame: { type: 'bridge.timeout', id, command, turnId, callId },
        })
        reject(new Error(`side panel did not answer ${command.op} within ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.uiRequests.set(id, { resolve, reject, timer, turnId, callId, command })
      const sent = this.sendToUi({
        v: PROTOCOL_VERSION,
        type: 'browser.command',
        id,
        callId,
        command,
        turnId,
      })
      if (!sent) {
        clearTimeout(timer)
        this.uiRequests.delete(id)
        reject(sidePanelClosedError(REQUEST_UI_CLOSED_MESSAGE))
      }
    })
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {import('node:http').IncomingMessage} request
   */
  #attach(ws, request) {
    const origin = request.headers.origin
    let role
    let handshakeTimer = setTimeout(() => {
      this.#emit({ direction: 'event', role: 'companion', frame: { type: 'bridge.handshake.timeout', origin } })
      close(ws, 4008, 'handshake timeout')
    }, HANDSHAKE_TIMEOUT_MS)
    handshakeTimer.unref?.()

    /** @param {import('ws').RawData} data */
    const onFirst = (data) => {
      const message = parse(data)
      if (message === undefined || message.type !== 'hello' || !this.#tokenOk(message.token) || (message.role !== 'ui' && message.role !== 'tools')) {
        this.#emit({
          direction: 'event',
          role: 'companion',
          frame: { type: 'bridge.auth.failed', origin, requestedRole: message?.role },
        })
        close(ws, 4001, 'invalid pairing token or role')
        return
      }
      clearTimeout(handshakeTimer)
      handshakeTimer = undefined
      role = message.role
      ws.off('message', onFirst)
      if (role === 'ui') this.#claimUi(ws, origin)
      else this.#claimTools(ws, origin)
      this.#emit({ direction: 'in', role, frame: { ...message, token: '[redacted]' } })
      this.#send(ws, role, { v: PROTOCOL_VERSION, type: 'hello.ok', version: PROTOCOL_VERSION })
      ws.on('message', data2 => this.#onMessage(ws, role, data2))
      this.onConnectionChange?.()
    }

    ws.on('message', onFirst)
    ws.on('close', (code, reason) => {
      if (handshakeTimer !== undefined) clearTimeout(handshakeTimer)
      if (this.ui === ws) {
        this.ui = undefined
        this.#failUpstream(new Error('the CrazyAgent side panel disconnected'))
        for (const request of this.uiRequests.values()) {
          clearTimeout(request.timer)
          request.reject(sidePanelClosedError('the CrazyAgent side panel disconnected'))
        }
        this.uiRequests.clear()
        this.#emit({
          direction: 'event',
          role: 'companion',
          frame: { type: 'bridge.disconnect', role: 'ui', code, reason: String(reason ?? '') },
        })
        this.onConnectionChange?.()
      }
      if (this.tools === ws) {
        this.tools = undefined
        this.upstream.clear()
        this.#emit({
          direction: 'event',
          role: 'companion',
          frame: { type: 'bridge.disconnect', role: 'tools', code, reason: String(reason ?? '') },
        })
        this.onConnectionChange?.()
      }
    })
    ws.on('error', error => {
      this.log(`bridge: socket error: ${errorMessage(error)}`)
      this.#emit({
        direction: 'event',
        role: 'companion',
        frame: { type: 'bridge.socket.error', role, message: errorMessage(error) },
      })
    })
  }

  /** @param {import('ws').WebSocket} ws */
  #claimUi(ws, origin) {
    if (this.ui !== undefined && this.ui !== ws) {
      this.#emit({ direction: 'event', role: 'companion', frame: { type: 'bridge.ui.replaced' } })
      this.#failUpstream(new Error('the CrazyAgent side panel was replaced'))
      close(this.ui, 4000, 'replaced by a newer side panel')
    }
    this.ui = ws
    this.#resolveUiWaiters()
    this.log(`bridge: side panel connected${origin === undefined ? '' : ` (${origin})`}`)
    this.#emit({ direction: 'event', role: 'companion', frame: { type: 'bridge.connected', role: 'ui', origin } })
  }

  /** Resolve every pending waitForUi() call after a `ui` hello was accepted. */
  #resolveUiWaiters() {
    if (this.uiWaiters.size === 0) return
    const waiters = [...this.uiWaiters]
    this.uiWaiters.clear()
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  /**
   * Pre-send gate used by browser-command paths: wait up to `uiGraceMs` for a
   * side panel and emit one `bridge.ui.wait` observability frame when a wait
   * was needed. `connected` is false when the grace window elapsed or the
   * bridge stopped first; `error` carries the waitForUi() rejection.
   * @param {Record<string, unknown>} command
   * @returns {Promise<{connected: boolean, error?: Error & {code?: string}}>}
   */
  async #awaitUiGrace(command) {
    if (this.hasUi()) return { connected: true }
    const started = Date.now()
    let error
    try {
      await this.waitForUi(this.uiGraceMs)
    } catch (failure) {
      error = failure
    }
    const connected = error === undefined
    this.#emit({
      direction: 'event',
      role: 'companion',
      frame: { type: 'bridge.ui.wait', command, waitedMs: Date.now() - started, connected },
    })
    return connected ? { connected } : { connected, error }
  }

  /** @param {import('ws').WebSocket} ws */
  #claimTools(ws, origin) {
    if (this.tools !== undefined && this.tools !== ws) {
      this.#emit({ direction: 'event', role: 'companion', frame: { type: 'bridge.provider.replaced' } })
      close(this.tools, 4000, 'replaced by a newer provider')
      this.upstream.clear()
    }
    this.tools = ws
    this.log('bridge: DSH provider connected')
    this.#emit({ direction: 'event', role: 'companion', frame: { type: 'bridge.connected', role: 'tools', origin } })
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {'ui' | 'tools'} role
   * @param {import('ws').RawData} data
   */
  #onMessage(ws, role, data) {
    const message = parse(data)
    if (message === undefined) return

    if (message.type === 'log.event') {
      this.#emit({ direction: 'event', role, frame: message })
      return
    }

    if (role === 'ui') {
      if (message.type === 'browser.result') {
        this.#onBrowserResult(message)
        return
      }
      this.#emit({ direction: 'in', role, frame: message })
      if (message.type === 'chat.send' && typeof message.text === 'string') {
        Promise.resolve(this.onChat(message.text, ws, message)).catch(error => {
          this.#send(ws, role, { v: PROTOCOL_VERSION, type: 'chat.error', message: errorMessage(error), recoverable: true })
        })
        return
      }
      if (message.type === 'chat.new') {
        Promise.resolve(this.onNewChat(ws)).catch(error => {
          this.#send(ws, role, { v: PROTOCOL_VERSION, type: 'chat.error', message: errorMessage(error), recoverable: true })
        })
        return
      }
      if (message.type === 'chat.stop') {
        // A stop is a lifecycle request, not a prompt: route it to its own
        // callback so it cannot be mistaken for chat.send (and vice versa).
        Promise.resolve()
          .then(() => this.onStop?.(ws, message))
          .catch(error => {
            this.log(`bridge: chat.stop handler failed: ${errorMessage(error)}`)
          })
        return
      }
      if (message.type === 'ping') {
        this.#send(ws, role, { v: PROTOCOL_VERSION, type: 'pong' })
        return
      }
      if (typeof message.type === 'string' && (message.type.startsWith('log.') || message.type.startsWith('llm.')) && this.onControl !== undefined) {
        Promise.resolve(this.onControl(message, ws)).catch(error => {
          this.#send(ws, role, { v: PROTOCOL_VERSION, type: 'log.error', message: errorMessage(error) })
        })
      }
      return
    }

    if (message.type === 'activity' && isRecord(message.activity)) {
      const activity = { ...message.activity, turnId: this.currentTurnId }
      this.#emit({ direction: 'in', role: 'tools', frame: { ...message, activity } })
      this.sendToUi({ v: PROTOCOL_VERSION, type: 'chat.activity', ...activity })
      return
    }

    if (message.type === 'browser.command' && typeof message.id === 'string' && isRecord(message.command)) {
      const enriched = {
        ...message,
        turnId: typeof message.turnId === 'string' ? message.turnId : this.currentTurnId,
      }
      this.#emit({ direction: 'in', role: 'tools', frame: enriched })
      this.#onToolsBrowserCommand(ws, role, message, enriched).catch(error => {
        this.log(`bridge: browser.command ${message.id} failed: ${errorMessage(error)}`)
      })
      return
    }

    this.#emit({ direction: 'in', role: 'tools', frame: message })
    if (message.type === 'ping') this.#send(ws, role, { v: PROTOCOL_VERSION, type: 'pong' })
  }

  /**
   * Forward one provider browser command to the side panel. When the panel is
   * absent the command is held for the reconnect grace window before failing;
   * it is never queued or replayed after it has been sent (a click must not
   * double-execute).
   * @param {import('ws').WebSocket} ws
   * @param {'ui' | 'tools'} role
   * @param {Record<string, any>} message
   * @param {Record<string, any>} enriched
   */
  async #onToolsBrowserCommand(ws, role, message, enriched) {
    if (!this.hasUi()) {
      const { connected } = await this.#awaitUiGrace(message.command)
      if (!connected) {
        this.#send(ws, role, {
          v: PROTOCOL_VERSION,
          type: 'browser.result',
          id: message.id,
          ok: false,
          error: { code: SIDE_PANEL_CLOSED, message: PROVIDER_UI_CLOSED_MESSAGE },
        })
        return
      }
    }
    this.upstream.set(message.id, {
      ws,
      turnId: enriched.turnId,
      callId: typeof enriched.callId === 'string' ? enriched.callId : undefined,
      command: enriched.command,
    })
    const sent = this.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'browser.command',
      id: message.id,
      callId: message.callId ?? null,
      command: message.command,
      turnId: enriched.turnId,
    })
    if (!sent) {
      this.upstream.delete(message.id)
      this.#send(ws, role, {
        v: PROTOCOL_VERSION,
        type: 'browser.result',
        id: message.id,
        ok: false,
        error: { code: SIDE_PANEL_CLOSED, message: PROVIDER_UI_CLOSED_MESSAGE },
      })
    }
  }

  /** @param {Record<string, any>} message */
  #onBrowserResult(message) {
    const id = typeof message.id === 'string' ? message.id : undefined
    if (id === undefined) return
    const request = this.uiRequests.get(id)
    const upstream = this.upstream.get(id)
    const annotated = {
      ...message,
      ...(request?.turnId !== undefined || upstream?.turnId !== undefined
        ? { turnId: request?.turnId ?? upstream?.turnId }
        : this.currentTurnId === undefined ? {} : { turnId: this.currentTurnId }),
      ...(request?.callId !== undefined || upstream?.callId !== undefined
        ? { callId: request?.callId ?? upstream?.callId }
        : {}),
      ...(request?.command !== undefined || upstream?.command !== undefined
        ? { command: request?.command ?? upstream?.command }
        : {}),
    }
    this.#emit({ direction: 'in', role: 'ui', frame: annotated })
    if (request !== undefined) {
      this.uiRequests.delete(id)
      clearTimeout(request.timer)
      if (message.ok === true) request.resolve(message.result)
      else request.reject(new Error(message.error?.message ?? 'browser command failed'))
      return
    }
    if (upstream !== undefined) {
      this.upstream.delete(id)
      this.#send(upstream.ws, 'tools', {
        ...message,
        turnId: upstream.turnId,
        callId: upstream.callId,
      })
    }
  }

  #failUpstream(error) {
    for (const [id, entry] of this.upstream) {
      this.#send(entry.ws, 'tools', {
        v: PROTOCOL_VERSION,
        type: 'browser.result',
        id,
        ok: false,
        error: { code: SIDE_PANEL_CLOSED, message: error.message },
      })
    }
    this.upstream.clear()
  }

  /** @param {unknown} token */
  #tokenOk(token) {
    if (typeof token !== 'string' || token.length === 0) return false
    const given = Buffer.from(token)
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  /**
   * @param {{direction: 'in'|'out'|'event', role?: string, frame: Record<string, any>}} entry
   */
  #emit(entry) {
    try {
      this.onLog?.(entry)
    } catch {
      // Logging must never break the bridge.
    }
  }

  /**
   * @param {import('ws').WebSocket | undefined} ws
   * @param {'ui'|'tools'} role
   * @param {Record<string, any>} frame
   */
  #send(ws, role, frame) {
    this.#emit({ direction: 'out', role, frame })
    return send(ws, frame)
  }
}

/** @param {string} message @returns {Error & {code: string}} */
function sidePanelClosedError(message) {
  const error = new Error(message)
  error.code = SIDE_PANEL_CLOSED
  return error
}

/**
 * Resolve the reconnect grace window: explicit constructor option first, then
 * the CRAZYAGENT_UI_GRACE_MS environment variable, then the default.
 * @param {unknown} configured
 * @returns {number}
 */
function resolveUiGraceMs(configured) {
  const explicit = parseGraceMs(configured)
  if (explicit !== undefined) return explicit
  const fromEnv = parseGraceMs(process.env[UI_GRACE_ENV])
  if (fromEnv !== undefined) return fromEnv
  return DEFAULT_UI_GRACE_MS
}

/** @param {unknown} value @returns {number | undefined} */
function parseGraceMs(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.floor(parsed)
}

/** @param {import('ws').WebSocket} ws @param {number} code @param {string} reason */
function close(ws, code, reason) {
  try {
    ws.close(code, reason)
  } catch {
    ws.terminate()
  }
}

/** @param {import('ws').RawData} data */
function parse(data) {
  try {
    const value = JSON.parse(data.toString())
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}