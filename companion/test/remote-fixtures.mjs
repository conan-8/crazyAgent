/**
 * Shared fakes for session-controller / remote API tests. No model, network,
 * or DSH runtime is used.
 */

import { request as httpRequest } from 'node:http'
import WebSocket from 'ws'

/** No-op LogStore stand-in. */
export function fakeLogStore() {
  const calls = []
  return new Proxy({ sessionId: undefined, calls }, {
    get(target, key) {
      if (key in target) return target[key]
      return (...args) => { calls.push([key, ...args]) }
    },
  })
}

/** Controllable DSH runner: each run() waits until the test finishes it. */
export class FakeRunner {
  constructor(sessionId = 'session-1') {
    this.sessionId = sessionId
    this.resumeSessionId = undefined
    /** @type {any[]} */
    this.runs = []
    this.interrupts = 0
    this.sessions = 1
    /** @type {undefined | {resolve: (text?: string) => void, reject: (error: Error) => void, notify: (n: any) => void}} */
    this.current = undefined
    /** @type {Array<() => void>} */
    this.runWaiters = []
  }

  run(blocks, onNotification) {
    this.runs.push(blocks)
    return new Promise((resolve, reject) => {
      this.current = {
        resolve: (text = 'done') => {
          this.current = undefined
          resolve({ sessionId: this.sessionId, finalResponse: text, events: [] })
        },
        reject: error => {
          this.current = undefined
          reject(error)
        },
        notify: notification => onNotification?.(notification),
      }
      for (const waiter of this.runWaiters.splice(0)) waiter()
    })
  }

  /** Resolve once a run() is in flight. */
  started() {
    if (this.current !== undefined) return Promise.resolve()
    return new Promise(resolve => this.runWaiters.push(resolve))
  }

  async interrupt() {
    this.interrupts += 1
    const current = this.current
    if (current === undefined) return { sessionId: this.sessionId, interrupted: false }
    current.reject(new Error('transport closed'))
    return { sessionId: this.sessionId, interrupted: true }
  }

  async newSession() {
    this.sessions += 1
    this.sessionId = `session-${this.sessions}`
    return this.sessionId
  }

  async resume(sessionId) {
    if (this.unresumable?.has(sessionId)) throw new Error('session not found on disk')
    this.sessionId = sessionId
    return sessionId
  }

  /** Emit any committed session event. */
  event(type, data) {
    this.current?.notify({
      method: 'session.event',
      params: { sessionId: this.sessionId, event: { type, data } },
    })
  }

  /** Emit a committed assistant message notification. */
  assistant(text, usage) {
    this.event('assistant/message', {
      message: { content: [{ type: 'text', text }] },
      ...(usage === undefined ? {} : { usage }),
    })
  }

  /** Emit a tool call/result pair (the result counts as failed when isError). */
  toolCall(callId, name = 'browser_click', args = '{}') {
    this.event('tool/call', { callId, name, arguments: args })
  }

  toolResult({ callId = 'call-1', isError = false, text = 'result' } = {}) {
    this.event('tool/result', {
      message: {
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError,
      },
    })
  }
}

/** Minimal bridge stand-in for the controller (no side panel). */
export function fakeBridge() {
  return {
    currentTurnId: undefined,
    requests: [],
    turnModes: [],
    setTurnId(id, options = {}) {
      this.currentTurnId = id
      this.turnModes.push({ id, planMode: options.planMode === true })
    },
    async requestUi(command) {
      this.requests.push(command)
      return { view: 'compact', screenshotSkipped: true }
    },
  }
}

/**
 * Raw HTTP request (lets tests set Host, which fetch forbids).
 * @param {number} port
 * @param {{method?: string, path: string, token?: string, body?: unknown, rawBody?: string, headers?: Record<string, string>}} options
 * @returns {Promise<{status: number, headers: Record<string, any>, body: any}>}
 */
export function http(port, options) {
  return new Promise((resolve, reject) => {
    const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
    const headers = {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...options.headers,
    }
    const req = httpRequest({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body = text
        try {
          body = JSON.parse(text)
        } catch {
          // Leave raw.
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, raw: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/**
 * Open /remote/v1/events and queue parsed frames.
 * @param {number} port
 * @param {{token?: string, query?: string, headers?: Record<string, string>}} options
 */
export function openEvents(port, options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/remote/v1/events${options.query ? `?${options.query}` : ''}`, {
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
  })
  const frames = []
  const waiters = []
  ws.on('message', data => {
    const frame = JSON.parse(data.toString())
    frames.push(frame)
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    }
  })
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (_req, res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const error = new Error(`unexpected ${res.statusCode}`)
        error.status = res.statusCode
        error.body = Buffer.concat(chunks).toString('utf8')
        reject(error)
      })
    })
    ws.once('error', reject)
  })
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })))
  return {
    ws,
    frames,
    opened,
    closed,
    next(predicate = () => true, timeoutMs = 2_000) {
      const found = frames.find(predicate)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve }
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1)
          reject(new Error('timed out waiting for a remote event'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    close() {
      ws.close()
      return closed
    },
  }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
