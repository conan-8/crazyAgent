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

export class Bridge {
  /**
   * @param {{
   *   host: string,
   *   port: number,
   *   token: string,
   *   log: (message: string) => void,
   *   onChat: (text: string, ui: import('ws').WebSocket, message: Record<string, unknown>) => void | Promise<void>,
   *   onNewChat: (ui: import('ws').WebSocket) => void | Promise<void>,
   *   onConnectionChange?: () => void,
   *   onLog?: (entry: {direction: 'in'|'out'|'event', role?: string, frame: Record<string, any>}) => void,
   *   onControl?: (message: Record<string, any>, ui: import('ws').WebSocket) => void | Promise<void>,
   * }} options
   */
  constructor(options) {
    this.host = options.host
    this.requestedPort = options.port
    this.token = options.token
    this.log = options.log
    this.onChat = options.onChat
    this.onNewChat = options.onNewChat
    this.onConnectionChange = options.onConnectionChange
    this.onLog = options.onLog
    this.onControl = options.onControl
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
  }

  async start() {
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
   * @param {{op: string, args?: Record<string, unknown>}} command
   * @param {string} callId
   * @param {number} [timeoutMs]
   * @returns {Promise<Record<string, any>>}
   */
  requestUi(command, callId, timeoutMs = UI_COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.hasUi()) {
        reject(new Error('the CrazyAgent side panel is not connected'))
        return
      }
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
        reject(new Error('the CrazyAgent side panel is not connected'))
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
          request.reject(new Error('the CrazyAgent side panel disconnected'))
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
    this.log(`bridge: side panel connected${origin === undefined ? '' : ` (${origin})`}`)
    this.#emit({ direction: 'event', role: 'companion', frame: { type: 'bridge.connected', role: 'ui', origin } })
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
      if (!this.hasUi()) {
        this.#send(ws, role, {
          v: PROTOCOL_VERSION,
          type: 'browser.result',
          id: message.id,
          ok: false,
          error: { code: 'NO_UI', message: 'the CrazyAgent side panel is not connected; open it and keep it open during a run' },
        })
        return
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
          error: { code: 'NO_UI', message: 'the CrazyAgent side panel disconnected' },
        })
      }
      return
    }

    this.#emit({ direction: 'in', role: 'tools', frame: message })
    if (message.type === 'ping') this.#send(ws, role, { v: PROTOCOL_VERSION, type: 'pong' })
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
        error: { code: 'UI_DISCONNECTED', message: error.message },
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