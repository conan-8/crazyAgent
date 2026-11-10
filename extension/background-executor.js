/**
 * Runs browser commands from the extension's service worker while no side
 * panel is open, so a phone can use the agent with the panel closed.
 *
 * The side panel stays the preferred executor. This worker connects to the
 * bridge only when no panel exists and nothing else holds the `ui` role, and
 * gives the connection up (after any command in flight) as soon as a panel
 * opens, so two executors never run commands at once.
 *
 * Everything chrome-specific is injected so the rules can be unit-tested.
 */

export const PANEL_PORT_NAME = 'crazyagent-panel'
export const EXECUTOR_ALARM = 'crazyagent-executor'
export const SETTINGS_KEY = 'crazyagent.settings'
/** Below Chrome's 30 s worker idle limit; each frame resets that timer. */
export const KEEPALIVE_MS = 20_000
const RECONNECT_MS = 2_500
/** A closed panel's socket can take a moment to disappear from /health. */
const AFTER_PANEL_RETRIES_MS = Object.freeze([300, 1_500, 3_500])
const HEALTH_TIMEOUT_MS = 2_000
const PROTOCOL_VERSION = 1

/**
 * The bridge's loopback health URL for its WebSocket URL, or null if it is not
 * a local bridge address (this worker never probes anything else).
 * @param {unknown} bridgeUrl
 */
export function bridgeHealthUrl(bridgeUrl) {
  try {
    const url = new URL(String(bridgeUrl))
    if (url.protocol !== 'ws:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) return null
    return `http://${url.host}/health`
  } catch {
    return null
  }
}

export class BackgroundExecutor {
  /**
   * @param {{
   *   loadSettings: () => Promise<Record<string, any>>,
   *   isPanelOpen: () => Promise<boolean>,
   *   execute: (op: string, args: Record<string, any>, settings: Record<string, any>) => Promise<any>,
   *   beginRun: () => Promise<unknown>,
   *   endRun: () => Promise<unknown>,
   *   setBadge?: (active: boolean) => void,
   *   WebSocketImpl?: typeof WebSocket,
   *   fetchImpl?: typeof fetch,
   *   setTimer?: typeof setTimeout,
   *   clearTimer?: typeof clearTimeout,
   *   setRepeat?: typeof setInterval,
   *   clearRepeat?: typeof clearInterval,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps
    this.WebSocketImpl = deps.WebSocketImpl ?? WebSocket
    this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args))
    // Wrapped: a bare browser timer called as a method throws Illegal invocation.
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer))
    this.setRepeat = deps.setRepeat ?? ((fn, ms) => setInterval(fn, ms))
    this.clearRepeat = deps.clearRepeat ?? (timer => clearInterval(timer))
    /** @type {WebSocket | null} */
    this.socket = null
    this.ready = false
    this.inFlight = 0
    this.ticking = false
    this.authFailedToken = null
    /** @type {Set<{postMessage: (message: any) => void}>} */
    this.panels = new Set()
    this.keepalive = undefined
    this.settings = {}
  }

  /** Connect if this worker should be the executor right now. Safe to call often. */
  async tick() {
    if (this.ticking || this.socket !== null || this.panels.size > 0) return
    this.ticking = true
    try {
      const settings = await this.deps.loadSettings()
      if (typeof settings.token !== 'string' || settings.token.length === 0) return
      if (settings.token === this.authFailedToken) return
      const healthUrl = bridgeHealthUrl(settings.bridgeUrl)
      if (healthUrl === null) return
      if (await this.deps.isPanelOpen()) return
      // /health is loopback and carries no secrets. An executor that already
      // holds the role (a panel, even in another profile) is left alone.
      const health = await this.#health(healthUrl)
      if (health === null || health.ui === true) return
      if (this.socket !== null || this.panels.size > 0) return
      this.settings = settings
      this.#connect(settings)
    } catch {
      // The next alarm tries again.
    } finally {
      this.ticking = false
    }
  }

  async #health(url) {
    const controller = new AbortController()
    const timer = this.setTimer(() => controller.abort(), HEALTH_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(url, { cache: 'no-store', signal: controller.signal })
      return response.ok ? await response.json() : null
    } catch {
      return null
    } finally {
      this.clearTimer(timer)
    }
  }

  #connect(settings) {
    const socket = new this.WebSocketImpl(settings.bridgeUrl)
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      // `host` only labels this connection for the phone's diagnostics.
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', role: 'ui', token: settings.token, version: PROTOCOL_VERSION, host: 'background' }))
    }
    socket.onmessage = event => {
      if (this.socket !== socket) return
      let frame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame !== null && typeof frame === 'object') this.#onFrame(socket, frame)
    }
    socket.onerror = () => {}
    socket.onclose = event => {
      if (this.socket !== socket) return
      this.#clearConnection()
      this.#finishRun()
      if (event.code === 4001) {
        // Do not hammer the bridge with a rejected token; a new one retries.
        this.authFailedToken = settings.token
        return
      }
      this.setTimer(() => { void this.tick() }, RECONNECT_MS)
    }
  }

  #clearConnection() {
    this.socket = null
    this.ready = false
    if (this.keepalive !== undefined) this.clearRepeat(this.keepalive)
    this.keepalive = undefined
  }

  #onFrame(socket, frame) {
    switch (frame.type) {
      case 'hello.ok':
        this.ready = true
        this.keepalive = this.setRepeat(() => {
          if (this.socket === socket && socket.readyState === 1) socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ping' }))
        }, KEEPALIVE_MS)
        return
      case 'browser.command':
        void this.#runCommand(socket, frame)
        return
      case 'chat.user':
        // Only turns the panel did not start reach this frame; they hold one
        // debugger lease for the whole turn, as the panel does.
        void Promise.resolve().then(() => this.deps.beginRun()).catch(() => {})
        return
      case 'chat.done':
      case 'chat.stopped':
      case 'chat.error':
        this.#finishRun()
        return
      default:
    }
  }

  #finishRun() {
    void Promise.resolve().then(() => this.deps.endRun()).catch(() => {})
    void Promise.resolve()
      .then(() => this.deps.execute('labels.clear', {}, this.settings))
      .catch(() => {})
  }

  async #runCommand(socket, frame) {
    const command = frame.command !== null && typeof frame.command === 'object' ? frame.command : {}
    const op = String(command.op ?? '')
    const args = command.args !== null && typeof command.args === 'object' ? command.args : {}
    this.inFlight += 1
    this.deps.setBadge?.(true)
    let reply
    try {
      const settings = await this.deps.loadSettings()
      this.settings = settings
      reply = { ok: true, result: await this.deps.execute(op, args, settings) }
    } catch (error) {
      reply = {
        ok: false,
        error: {
          code: error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'BROWSER_ERROR',
          message: error instanceof Error ? error.message : String(error),
          ...(typeof error?.mutationPossible === 'boolean' ? { mutationPossible: error.mutationPossible } : {}),
        },
      }
    }
    this.inFlight -= 1
    if (this.inFlight === 0) this.deps.setBadge?.(false)
    if (typeof frame.id === 'string' && this.socket === socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'browser.result', id: frame.id, ...reply, ...(reply.ok ? this.deps.displayImageField?.(reply.result) : {}) }))
    }
    this.#yieldIfPanelWaiting()
  }

  /** @param {{postMessage: (message: any) => void}} port a newly opened side panel */
  panelConnected(port) {
    this.panels.add(port)
    this.#yieldIfPanelWaiting()
  }

  /** @param {{postMessage: (message: any) => void}} port */
  panelDisconnected(port) {
    this.panels.delete(port)
    if (this.panels.size > 0) return
    for (const delay of AFTER_PANEL_RETRIES_MS) this.setTimer(() => { void this.tick() }, delay)
  }

  /** Hand over between commands, then tell the panel it may connect. */
  #yieldIfPanelWaiting() {
    if (this.panels.size === 0 || this.inFlight > 0) return
    const socket = this.socket
    if (socket !== null) {
      this.#clearConnection()
      this.#finishRun()
      try {
        socket.close(1000, 'side panel opened')
      } catch {
        // Already closing.
      }
    }
    for (const port of this.panels) {
      try {
        port.postMessage({ type: 'executor.released' })
      } catch {
        // That panel is gone; its disconnect event removes it.
      }
    }
  }
}
