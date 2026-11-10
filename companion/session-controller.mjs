/**
 * Transport-independent chat/new/stop/resume operations.
 *
 * Both the side-panel bridge transport and the opt-in remote API call this one
 * controller, so there is still exactly one DSH runner, one active turn, and
 * one stop path (runtime interrupt + session resume). Turn reservation is
 * synchronous: `submit()` sets the busy flag before its first await, so two
 * concurrent submissions from any mix of clients cannot both start a turn.
 *
 * Lifecycle frames go through `publish` (side panel + remote hub). Rejections
 * are returned to the caller, which replies only to the requesting client.
 */

import { randomBytes } from 'node:crypto'
import { buildPromptBlocks, normalizeImageAttachments, promptStats } from './prompt.mjs'
import { PROTOCOL_VERSION, errorMessage, isRecord } from './protocol.mjs'

export const BUSY_MESSAGE = 'A turn is already running. Wait for it to finish.'
export const STOPPING_MESSAGE = 'A turn is still stopping. Wait a moment, then send your message again.'
export const SNAPSHOT_TIMEOUT_MS = 15_000
export const NOT_READY_MESSAGE = 'OpenRouter is not ready. Open Settings, enter your API key, choose an image-capable model, and Save.'

/**
 * @typedef {{
 *   turnStarted?: (info: {turnId: string, origin: string, clientMessageId?: string | null, text: string, imageCount: number, planMode: boolean, sessionId?: string | null}) => void,
 *   turnEnded?: (info: {turnId: string, outcome: 'done' | 'stopped' | 'error', error?: string, sessionId?: string | null, help?: {category: string, reason: string, captureError: string | null}, label?: 'done' | 'partial' | 'blocked' | null, usage?: Record<string, number>, timings?: Record<string, number | null>}) => void,
 * }} TurnObserver
 */

export class SessionController {
  /**
   * @param {{
   *   bridge: {requestUi: Function, setTurnId: (id: string | undefined, options?: {planMode?: boolean}) => void, currentTurnId?: string},
   *   getRunner: () => any,
   *   isDisabled?: () => boolean,
   *   logStore: any,
   *   log?: (message: string) => void,
   *   autoCapture: boolean,
   *   provider: string,
   *   getModelId: () => string | undefined,
   *   publish: (frame: Record<string, any>) => void,
   *   observers?: TurnObserver[],
   * }} options
   */
  constructor(options) {
    this.bridge = options.bridge
    this.getRunner = options.getRunner
    this.isDisabled = options.isDisabled ?? (() => false)
    this.logStore = options.logStore
    this.log = options.log ?? (() => {})
    this.autoCapture = options.autoCapture
    this.provider = options.provider
    this.getModelId = options.getModelId
    this.publish = options.publish
    /** @type {TurnObserver[]} */
    this.observers = options.observers ?? []
    this.running = false
    this.stopRequested = false
    this.sessionChanging = false
    /** @type {string | undefined} */
    this.turnId = undefined
    /** @type {{status: string, reason?: string} | undefined} */
    this.docsTurnVerification = undefined
    /** @type {{outcome: string, revision?: number} | undefined} */
    this.planTurnOutcome = undefined
    /**
     * The model's structured "I need the user" request for the running turn
     * (agent_request_help), received as a provider `help-request` activity.
     * @type {{category: string, reason: string} | undefined}
     */
    this.helpTurnRequest = undefined
    /**
     * At most one message waiting to replace the running turn. It starts in
     * the same tick the stopped turn releases the slot, so nothing can slip in
     * between.
     * @type {undefined | {turnId: string, prompt: string, images: any[], input: Record<string, any>, resolve: () => void}}
     */
    this.pendingSteer = undefined
    /**
     * The one companion-made capture in flight, if any. A turn that starts
     * meanwhile waits for it, so the capture never overlaps agent browser work.
     * @type {Promise<any> | undefined}
     */
    this.snapshotInFlight = undefined
  }

  /**
   * Capture one fresh view for a remote client. Only between turns: while the
   * agent is working the caller shows the latest existing image instead, so no
   * browser command is injected into a running turn.
   * @param {{source?: string}} [options]
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string, retryable: boolean}>}
   */
  captureSnapshot(options = {}) {
    if (this.running) {
      return Promise.resolve({ ok: false, code: this.stopRequested ? 'TURN_STOPPING' : 'TURN_BUSY', message: 'The agent is working. Showing its latest view instead.', retryable: true })
    }
    if (this.sessionChanging) {
      return Promise.resolve({ ok: false, code: 'SESSION_CHANGING', message: 'A chat is being opened. Try again in a moment.', retryable: true })
    }
    if (this.snapshotInFlight !== undefined) {
      return Promise.resolve({ ok: false, code: 'SNAPSHOT_BUSY', message: 'A screenshot is already being taken.', retryable: true })
    }
    if (typeof this.bridge.hasUi === 'function' && !this.bridge.hasUi()) {
      return Promise.resolve({ ok: false, code: 'UI_DISCONNECTED', message: 'The browser side panel is not connected, so the screen cannot be captured.', retryable: true })
    }
    const work = (async () => {
      try {
        return await this.#capture(options.source ?? 'manual')
      } finally {
        this.snapshotInFlight = undefined
        // The panel shows a busy phase for any browser command; put it back.
        if (!this.running) this.sendStatus('idle')
      }
    })()
    this.snapshotInFlight = work
    return work
  }

  /**
   * One viewport capture through the side panel. The image itself reaches the
   * remote hub through the bridge's image observer, labelled with `source`.
   * @param {string} source
   * @returns {Promise<{ok: true} | {ok: false, code: string, message: string, retryable: boolean}>}
   */
  async #capture(source) {
    if (typeof this.bridge.hasUi === 'function' && !this.bridge.hasUi()) {
      return { ok: false, code: 'UI_DISCONNECTED', message: 'The browser side panel is not connected, so the screen cannot be captured.', retryable: true }
    }
    try {
      const view = await this.bridge.requestUi(
        { op: 'snapshot', args: { detail: 'normal' } },
        'auto',
        SNAPSHOT_TIMEOUT_MS,
        { source, wait: false },
      )
      if (!isRecord(view?.image) || typeof view.image.data !== 'string') {
        return { ok: false, code: 'SNAPSHOT_FAILED', message: 'The browser returned no image for this page.', retryable: true }
      }
      return { ok: true }
    } catch (error) {
      this.logStore.record('companion', 'snapshot.error', { source, message: errorMessage(error) }, { severity: 'warn' })
      return { ok: false, code: 'SNAPSHOT_FAILED', message: errorMessage(error), retryable: true }
    } finally {
      // A viewport capture draws numbered labels into the page. A turn removes
      // them when it ends; a capture made outside one must clean up itself.
      try {
        await this.bridge.requestUi({ op: 'labels.clear', args: {} }, 'auto', 3_000, { wait: false })
      } catch {
        // Best effort: the next turn clears them as well.
      }
    }
  }

  /**
   * Provider activity that concerns the turn itself. `help-request` is the
   * agent_request_help tool's signal; `turn-outcome` carries Docs/plan metadata
   * that cannot be written onto DSH's frozen committed turn/end event.
   * @param {Record<string, any>} frame
   */
  noteActivity(frame) {
    if (!isRecord(frame) || !this.running || this.turnId === undefined || frame.turnId !== this.turnId) return
    if (frame.kind === 'help-request') {
      const help = normalizeHelpRequest(frame)
      if (help !== undefined) this.helpTurnRequest = help
      return
    }
    if (frame.kind !== 'turn-outcome' || !Number.isSafeInteger(frame.turn)) return
    const sessionId = this.getRunner()?.sessionId
    if (typeof frame.sessionId === 'string' && typeof sessionId === 'string' && frame.sessionId !== sessionId) return
    this.noteOutcome(frame)
  }

  /** @param {Record<string, any>} frame */
  noteOutcome(frame) {
    if (frame.docsVerification === 'verified' || frame.docsVerification === 'unverified') {
      this.docsTurnVerification = {
        status: frame.docsVerification,
        reason: typeof frame.docsVerificationReason === 'string' ? frame.docsVerificationReason : undefined,
      }
    }
    if (['unfinished', 'blocked', 'reported-complete', 'not-assessed', 'aborted', 'user-input-needed'].includes(frame.planOutcome)) {
      this.planTurnOutcome = {
        outcome: frame.planOutcome,
        revision: Number.isSafeInteger(frame.planRevision) && frame.planRevision >= 0 ? frame.planRevision : undefined,
      }
    }
  }

  /** @param {TurnObserver} observer */
  addObserver(observer) {
    this.observers.push(observer)
  }

  /** @param {string} status @param {Record<string, unknown>} [extra] */
  sendStatus(status, extra = {}) {
    this.publish({ v: PROTOCOL_VERSION, type: 'chat.status', status, ...extra })
  }

  /**
   * Reserve the single turn slot and start the turn. Returns synchronously with
   * either an accepted turn (plus a `done` promise) or a rejection the caller
   * reports only to its own client.
   *
   * `steer: true` redirects a running turn: the turn is stopped (the same
   * runtime interrupt as Stop) and this message starts the next turn in the
   * resumed session as soon as the slot is free. When idle it is an ordinary
   * send.
   * @param {{text: unknown, images?: unknown, autoCapture?: unknown, planMode?: unknown, steer?: unknown, origin?: string, clientMessageId?: string | null}} input
   * @returns {{ok: true, turnId: string, done: Promise<void>, steered?: boolean} | {ok: false, code: string, message: string, retryable: boolean}}
   */
  submit(input) {
    const prompt = typeof input.text === 'string' ? input.text.trim() : ''
    if (prompt.length === 0) return { ok: false, code: 'EMPTY_PROMPT', message: 'The message is empty.', retryable: false }
    let images
    try {
      images = normalizeImageAttachments(input.images)
    } catch (error) {
      return { ok: false, code: 'INVALID_ATTACHMENT', message: errorMessage(error), retryable: false }
    }
    if (this.running) {
      if (input.steer === true) {
        if (this.pendingSteer !== undefined) {
          return { ok: false, code: 'STEER_PENDING', message: 'Another message is already waiting to steer this turn.', retryable: true }
        }
        const turnId = newTurnId()
        let resolve = () => {}
        const done = new Promise(settle => { resolve = settle })
        this.pendingSteer = { turnId, prompt, images, input, resolve }
        this.logStore.record('companion', 'turn.steer.request', { turnId, replaces: this.turnId, origin: input.origin ?? 'ui' }, { turnId: this.turnId, severity: 'info' })
        if (!this.stopRequested) this.stop().done.catch(() => {})
        return { ok: true, turnId, done, steered: true }
      }
      return this.stopRequested
        ? { ok: false, code: 'TURN_STOPPING', message: STOPPING_MESSAGE, retryable: true }
        : { ok: false, code: 'TURN_BUSY', message: BUSY_MESSAGE, retryable: true }
    }
    if (this.sessionChanging) {
      return { ok: false, code: 'SESSION_CHANGING', message: 'A new chat is starting. Wait a moment, then send your message again.', retryable: true }
    }
    const runner = this.getRunner()
    if (this.isDisabled() || runner === undefined) {
      return { ok: false, code: 'RUNTIME_NOT_READY', message: NOT_READY_MESSAGE, retryable: true }
    }
    return { ok: true, ...this.#begin({ turnId: newTurnId(), prompt, images, input, runner }) }
  }

  /**
   * Reserve the turn slot and start the turn. Synchronous up to the first
   * await inside the turn, so callers can rely on `running` immediately.
   * @param {{turnId: string, prompt: string, images: any[], input: Record<string, any>, runner: any}} start
   * @returns {{turnId: string, done: Promise<void>}}
   */
  #begin({ turnId, prompt, images, input, runner }) {
    this.running = true
    this.docsTurnVerification = undefined
    this.planTurnOutcome = undefined
    this.helpTurnRequest = undefined
    this.turnId = turnId
    const origin = input.origin ?? 'ui'
    const planMode = input.planMode === true
    this.#notify('turnStarted', {
      turnId,
      origin,
      clientMessageId: input.clientMessageId ?? null,
      text: prompt,
      imageCount: images.length,
      planMode,
      sessionId: runner.sessionId ?? null,
    })
    if (typeof runner.sessionId === 'string') {
      this.publish({ v: PROTOCOL_VERSION, type: 'chat.session', sessionId: runner.sessionId })
    }
    if (origin !== 'ui') {
      // The panel renders its own prompts locally; it only needs prompts that
      // another client (the phone) started, so it can show the turn and queue
      // desktop input instead of colliding with it.
      this.publish({ v: PROTOCOL_VERSION, type: 'chat.user', turnId, origin, text: prompt, imageCount: images.length })
    }
    const done = this.#runTurn({ turnId, runner, prompt, images, autoCaptureFlag: input.autoCapture, origin, planMode })
    return { turnId, done }
  }

  /** Start the message that was waiting to steer, now that the slot is free. */
  #startPendingSteer() {
    const steer = this.pendingSteer
    if (steer === undefined) return
    this.pendingSteer = undefined
    const runner = this.getRunner()
    if (this.isDisabled() || runner === undefined) {
      this.publish({ v: PROTOCOL_VERSION, type: 'chat.error', code: 'RUNTIME_NOT_READY', message: `The steering message was not sent. ${NOT_READY_MESSAGE}`, recoverable: true })
      steer.resolve()
      return
    }
    this.#begin({ turnId: steer.turnId, prompt: steer.prompt, images: steer.images, input: steer.input, runner }).done.then(steer.resolve, steer.resolve)
  }

  /**
   * Stop the active turn. DSH has no turn-cancel RPC, so the runner interrupts
   * the runtime subprocess and the turn reports chat.stopped when the in-flight
   * run() rejects. The next turn resumes the same session.
   * @returns {{state: 'idle' | 'stopping' | 'already-stopping', turnId?: string, done: Promise<void>}}
   */
  stop() {
    const turnId = this.bridge.currentTurnId ?? this.turnId
    if (!this.running) {
      this.logStore.record('companion', 'turn.stop.idle', { turnId }, { turnId, severity: 'info' })
      return { state: 'idle', done: Promise.resolve() }
    }
    if (this.stopRequested) {
      // The first stop already sent chat.stopping and owns the teardown;
      // duplicate presses must not interrupt twice.
      this.logStore.record('companion', 'turn.stop.duplicate', { turnId }, { turnId, severity: 'debug' })
      return { state: 'already-stopping', turnId, done: Promise.resolve() }
    }
    this.stopRequested = true
    const runner = this.getRunner()
    this.logStore.record('companion', 'turn.stop.request', {
      turnId,
      sessionId: runner?.sessionId,
    }, { turnId, severity: 'info' })
    this.publish({ v: PROTOCOL_VERSION, type: 'chat.stopping', turnId, message: 'Stopping…' })
    const done = (async () => {
      try {
        const result = await runner?.interrupt()
        this.logStore.record('companion', 'turn.stop.interrupted', {
          turnId,
          sessionId: result?.sessionId,
          interrupted: result?.interrupted === true,
        }, { turnId, severity: 'info' })
      } catch (error) {
        this.logStore.record('companion', 'turn.stop.error', {
          turnId,
          message: errorMessage(error),
        }, { turnId, severity: 'warn' })
        this.log(`stop: ${errorMessage(error)}`)
      }
    })()
    return { state: 'stopping', turnId, done }
  }

  /**
   * Start a fresh DSH session when no turn is running or stopping.
   * @returns {Promise<{ok: true, sessionId: string} | {ok: false, code: string, message: string, retryable: boolean}>}
   */
  async newChat() {
    if (this.running) {
      return { ok: false, code: this.stopRequested ? 'TURN_STOPPING' : 'TURN_BUSY', message: 'A turn is already running.', retryable: true }
    }
    if (this.sessionChanging) {
      return { ok: false, code: 'SESSION_CHANGING', message: 'A new chat is already starting.', retryable: true }
    }
    const runner = this.getRunner()
    if (runner === undefined || this.isDisabled()) {
      return { ok: false, code: 'RUNTIME_NOT_READY', message: 'OpenRouter is not configured yet. Open Settings.', retryable: true }
    }
    this.sessionChanging = true
    try {
      const sessionId = await runner.newSession()
      this.logStore.sessionStart(sessionId)
      this.publish({ v: PROTOCOL_VERSION, type: 'chat.session', sessionId })
      this.sendStatus('idle')
      return { ok: true, sessionId }
    } finally {
      this.sessionChanging = false
    }
  }

  /**
   * Switch to a saved DSH session so the next turn continues that chat. Only
   * when no turn is running; the current session stays in place if the saved
   * one cannot be restored.
   * @param {string} sessionId
   * @returns {Promise<{ok: true, sessionId: string, already?: boolean} | {ok: false, code: string, message: string, retryable: boolean}>}
   */
  async resumeChat(sessionId) {
    if (this.running) {
      return { ok: false, code: this.stopRequested ? 'TURN_STOPPING' : 'TURN_BUSY', message: 'A turn is already running.', retryable: true }
    }
    if (this.sessionChanging) {
      return { ok: false, code: 'SESSION_CHANGING', message: 'Another chat is already being opened.', retryable: true }
    }
    const runner = this.getRunner()
    if (runner === undefined || this.isDisabled()) {
      return { ok: false, code: 'RUNTIME_NOT_READY', message: 'OpenRouter is not configured yet. Open Settings.', retryable: true }
    }
    if (runner.sessionId === sessionId) return { ok: true, sessionId, already: true }
    if (typeof runner.resume !== 'function') {
      return { ok: false, code: 'SESSION_NOT_RESUMABLE', message: 'This runtime cannot continue saved chats.', retryable: false }
    }
    this.sessionChanging = true
    try {
      let resumed
      try {
        resumed = await runner.resume(sessionId)
      } catch (error) {
        this.log(`resume: ${errorMessage(error)}`)
        this.logStore.record('companion', 'session.resume.error', { sessionId, message: errorMessage(error) }, { severity: 'warn' })
        return { ok: false, code: 'SESSION_NOT_RESUMABLE', message: 'This chat can no longer be continued. Its saved model session is gone.', retryable: false }
      }
      this.logStore.sessionStart(resumed)
      this.publish({ v: PROTOCOL_VERSION, type: 'chat.session', sessionId: resumed, resumed: true })
      this.sendStatus('idle')
      return { ok: true, sessionId: resumed }
    } finally {
      this.sessionChanging = false
    }
  }

  /**
   * @param {{turnId: string, runner: any, prompt: string, images: any[], autoCaptureFlag: unknown, origin: string, planMode: boolean}} turn
   */
  async #runTurn({ turnId, runner, prompt, images, autoCaptureFlag, planMode }) {
    const logStore = this.logStore
    const bridge = this.bridge
    const turnStart = performance.now()
    const wantAutoCapture = this.autoCapture && autoCaptureFlag !== false
    let autoCaptureMs = 0
    let imageBytes = 0
    let promptTextBytes = 0
    let firstEventMs = null
    const toolCalls = new Set()
    const toolStarts = new Map()
    // Incremental per-turn stats: they also survive an aborted run, where the
    // runner rejects and never returns its collected event list.
    const turnStats = { failedCalls: 0, usage: emptyUsageTotals() }
    /** @type {{outcome: 'done' | 'stopped' | 'error', error?: string, sessionId?: string | null, help?: {category: string, reason: string, captureError: string | null}}} */
    let ending = { outcome: 'error', error: 'turn ended unexpectedly' }

    bridge.setTurnId(turnId, { planMode })
    logStore.turnStart(turnId, prompt, {
      autoCapture: wantAutoCapture,
      planMode,
      provider: this.provider,
      model: this.getModelId(),
      sessionId: runner.sessionId,
    })

    try {
      // A capture requested just before this turn finishes first (bounded).
      if (this.snapshotInFlight !== undefined) await this.snapshotInFlight
      this.sendStatus(wantAutoCapture ? 'capturing' : 'thinking')
      let view = null
      if (wantAutoCapture) {
        logStore.record('companion', 'autoCapture.start', { detail: 'normal' }, { turnId, severity: 'info' })
        const captureStart = performance.now()
        try {
          view = await bridge.requestUi({ op: 'auto_view', args: {} }, 'auto', 5_000)
        } catch (error) {
          logStore.record('companion', 'autoCapture.error', { message: errorMessage(error) }, { turnId, severity: 'warn' })
          this.log(`auto-capture: ${errorMessage(error)}`)
        }
        autoCaptureMs = performance.now() - captureStart
        logStore.record('companion', 'autoCapture.end', {
          ok: view !== null,
          autoCaptureMs: Math.round(autoCaptureMs),
          image: view?.image
            ? { width: view.image.width, height: view.image.height, bytes: view.image.bytes, mimeType: view.image.mimeType }
            : undefined,
          tab: view?.tab,
        }, { turnId, severity: 'info' })
      }

      // The user may press Stop while the auto-capture round trip is in flight.
      // The runtime was never asked to run, so there is nothing to interrupt;
      // finish the turn as a user abort instead of starting the model.
      if (this.stopRequested) {
        logStore.record('companion', 'turn.stop.duringCapture', {
          turnId,
          autoCaptureMs: Math.round(autoCaptureMs),
        }, { turnId, severity: 'info' })
        throw new Error('turn stopped by user before the model run')
      }

      const blocks = buildPromptBlocks(view, prompt, new Date(), images, { planMode })
      const stats = promptStats(blocks)
      promptTextBytes = stats.textBytes
      imageBytes = stats.imageBytes
      logStore.record('companion', 'prompt.build', {
        textBytes: promptTextBytes,
        imageBytes,
        images: stats.images,
        planMode,
        text: blocks[0]?.text,
      }, { turnId, severity: 'debug' })

      this.sendStatus('thinking')
      const result = await runner.run(blocks, notification => {
        if (firstEventMs === null) firstEventMs = Math.round(performance.now() - turnStart)
        logStore.recordDshNotification(notification, turnId)
        this.forwardNotification(notification, turnId, toolCalls, toolStarts, turnStats)
      })

      // The model asked for the user. Its run has finished, so one capture of
      // what it is stuck on cannot overlap any browser work of its own.
      const helpRequest = this.helpTurnRequest
      let help
      if (helpRequest !== undefined) {
        const captured = await this.#capture('help')
        help = { ...helpRequest, captureError: captured.ok ? null : captured.message }
        logStore.record('companion', 'help.request', {
          category: helpRequest.category,
          reasonChars: helpRequest.reason.length,
          captured: captured.ok,
          ...(captured.ok ? {} : { captureCode: captured.code }),
        }, { turnId, severity: 'info' })
        // Stop pressed during that capture: end as stopped, not as waiting.
        if (this.stopRequested) throw new Error('turn stopped by user during the help capture')
      }

      const collectedUsage = collectUsage(result.events)
      const usage = hasUsageTotals(collectedUsage) ? collectedUsage : { ...turnStats.usage }
      const label = parseReportedLabel(result.finalResponse)
      const timings = {
        totalMs: Math.round(performance.now() - turnStart),
        autoCaptureMs: Math.round(autoCaptureMs),
        firstEventMs,
        toolCalls: toolCalls.size,
        failedCalls: turnStats.failedCalls,
        promptTextBytes,
        imageBytes,
        images: blocks.filter(block => block.type === 'image').length,
      }
      if (logStore.sessionId !== result.sessionId) logStore.sessionStart(result.sessionId)
      const verification = this.docsTurnVerification
      const unverified = verification?.status === 'unverified'
      const plan = this.planTurnOutcome
      const planIncomplete = plan?.outcome === 'unfinished' || plan?.outcome === 'blocked'
      const completionError = unverified
        ? `Docs verification incomplete (${verification.reason ?? 'one-nudge-only'})`
        : planIncomplete ? `Plan ${plan.outcome} (revision ${plan.revision ?? 0})` : undefined
      logStore.turnEnd(turnId, {
        ok: !unverified && !planIncomplete,
        finalText: result.finalResponse,
        timings,
        usage,
        label,
        planOutcome: plan?.outcome,
        planRevision: plan?.revision,
        ...completionError ? { error: completionError } : {},
      })
      this.publish({
        v: PROTOCOL_VERSION,
        type: 'chat.done',
        sessionId: result.sessionId,
        text: result.finalResponse,
        timings,
        usage,
        label,
        model: this.getModelId(),
        provider: this.provider,
        docsVerification: verification?.status,
        docsVerificationReason: verification?.reason,
        planMode,
        planOutcome: plan?.outcome,
        planRevision: plan?.revision,
        ...(help === undefined ? {} : { help: { category: help.category, reason: help.reason } }),
      })
      this.sendStatus('idle')
      ending = { outcome: 'done', sessionId: result.sessionId, label, usage, timings, ...(help === undefined ? {} : { help }) }
    } catch (error) {
      const message = errorMessage(error)
      const timings = {
        totalMs: Math.round(performance.now() - turnStart),
        autoCaptureMs: Math.round(autoCaptureMs),
        firstEventMs,
        toolCalls: toolCalls.size,
        failedCalls: turnStats.failedCalls,
        promptTextBytes,
        imageBytes,
      }
      // There is no final text on a stopped/failed turn, so no reported label.
      const usage = { ...turnStats.usage }
      const label = null
      const current = this.getRunner()
      if (this.stopRequested) {
        // A user stop tears the runtime down; the transport error is expected and
        // must not surface as a tool failure to the model/user.
        logStore.record('companion', 'turn.stop.done', {
          turnId,
          sessionId: current?.resumeSessionId ?? current?.sessionId,
          elapsedMs: Math.round(performance.now() - turnStart),
        }, { turnId, severity: 'info' })
        // log-store.turnEnd() records the TURN_STOPPED signal for aborted turns.
        logStore.turnEnd(turnId, { ok: false, aborted: true, reason: 'user', timings, usage, label })
        const sessionId = current?.sessionId ?? current?.resumeSessionId
        this.publish({
          v: PROTOCOL_VERSION,
          type: 'chat.stopped',
          turnId,
          reason: 'user',
          sessionId,
          message: 'Stopped by user.',
          timings,
          usage,
        })
        this.sendStatus('idle')
        ending = { outcome: 'stopped', sessionId: sessionId ?? null, label, usage, timings }
      } else {
        logStore.error(message, { turnId, code: 'TURN_ERROR' })
        logStore.turnEnd(turnId, { ok: false, error: message, timings, usage, label })
        this.publish({ v: PROTOCOL_VERSION, type: 'chat.error', message, recoverable: true })
        this.sendStatus('error')
        ending = { outcome: 'error', error: message, label, usage, timings }
      }
    } finally {
      this.#notify('turnEnded', { turnId, ...ending })
      this.running = false
      this.stopRequested = false
      this.docsTurnVerification = undefined
      this.planTurnOutcome = undefined
      this.helpTurnRequest = undefined
      this.turnId = undefined
      bridge.setTurnId(undefined)
      this.#startPendingSteer()
    }
  }

  /**
   * @param {{ method: string, params: Record<string, unknown> }} notification
   * @param {string} turnId
   * @param {Set<string>} toolCalls
   * @param {Map<string, number>} toolStarts
   * @param {{failedCalls: number, usage: Record<string, number>}} [turnStats]
   */
  forwardNotification(notification, turnId, toolCalls, toolStarts, turnStats = { failedCalls: 0, usage: emptyUsageTotals() }) {
    const { method, params } = notification
    if (method === 'session.status') {
      const status = params.status
      if (status === 'running') this.sendStatus('thinking')
      if (status === 'idle') this.sendStatus('idle')
      return
    }
    if (method !== 'session.event') return
    const rootSessionId = this.getRunner()?.sessionId
    if (typeof params.sessionId === 'string' && rootSessionId !== undefined && params.sessionId !== rootSessionId) return
    const event = params.event
    if (!isRecord(event)) return
    const data = isRecord(event.data) ? event.data : {}

    if (event.type === 'turn/end') {
      this.noteOutcome(data)
      return
    }
    if (event.type === 'assistant/message') {
      const reasoning = extractReasoningText(data)
      if (reasoning.length > 0) {
        this.publish({ v: PROTOCOL_VERSION, type: 'chat.activity', kind: 'reasoning-committed', text: reasoning })
      }
      const usage = isRecord(data.usage) ? data.usage : undefined
      if (usage !== undefined) addUsageTotals(turnStats.usage, usage)
      const text = extractAssistantText(data)
      if (text.length > 0) {
        this.logStore.assistant(turnId, text)
        this.publish({ v: PROTOCOL_VERSION, type: 'chat.assistant', text })
      }
      return
    }
    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      if (callId !== undefined) {
        toolCalls.add(callId)
        toolStarts.set(callId, performance.now())
      }
      let args = data.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          // Keep raw.
        }
      }
      this.logStore.toolCall(turnId, { callId, name: data.name, args })
      this.publish({
        v: PROTOCOL_VERSION,
        type: 'chat.tool_call',
        callId,
        name: data.name,
        args: data.arguments,
      })
      this.sendStatus('tool', { tool: data.name })
      return
    }
    if (event.type === 'tool/result') {
      const message = isRecord(data.message) ? data.message : {}
      const raw = Array.isArray(message.content) ? message.content : []
      const legacy = raw.length === 1 && isRecord(raw[0]) && Array.isArray(raw[0].content)
      const blocks = legacy ? raw[0].content : raw
      const callId = isRecord(message.source) && typeof message.source.callId === 'string'
        ? message.source.callId
        : typeof message.toolCallId === 'string' ? message.toolCallId
          : isRecord(raw[0]) && typeof raw[0].toolCallId === 'string' ? raw[0].toolCallId : undefined
      const text = extractToolResultText(blocks)
      const isError = message.isError === true || (isRecord(raw[0]) && raw[0].isError === true)
      if (isError) turnStats.failedCalls += 1
      const started = callId ? toolStarts.get(callId) : undefined
      const durationMs = started === undefined ? undefined : Math.round(performance.now() - started)
      if (callId) toolStarts.delete(callId)
      this.logStore.toolResult(turnId, { callId, ok: !isError, text, durationMs })
      this.publish({
        v: PROTOCOL_VERSION,
        type: 'chat.tool_result',
        callId,
        ok: !isError,
        text,
      })
      this.sendStatus('thinking')
    }
  }

  /** @param {'turnStarted' | 'turnEnded'} hook @param {any} info */
  #notify(hook, info) {
    for (const observer of this.observers) {
      try {
        observer[hook]?.(info)
      } catch (error) {
        this.log(`session observer ${hook} failed: ${errorMessage(error)}`)
      }
    }
  }
}

export const HELP_CATEGORIES = Object.freeze(['login', 'captcha', 'permission', 'ambiguous', 'error', 'other'])
export const HELP_REASON_MAX_CHARS = 500

/**
 * Accept only the exact structured shape the provider tool produces.
 * @param {unknown} value
 * @returns {{category: string, reason: string} | undefined}
 */
export function normalizeHelpRequest(value) {
  if (!isRecord(value) || typeof value.reason !== 'string' || typeof value.category !== 'string') return undefined
  const reason = value.reason.trim().slice(0, HELP_REASON_MAX_CHARS)
  if (reason.length === 0 || !HELP_CATEGORIES.includes(value.category)) return undefined
  return { category: value.category, reason }
}

function newTurnId() {
  return `turn-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
}

/**
 * The side-panel reply for a refused submit/new. `code` lets the panel tell a
 * lost race with another client (busy) from a real failure.
 * @param {{code: string, message: string}} result
 */
export function uiRejectionFrame(result) {
  return { v: PROTOCOL_VERSION, type: 'chat.error', code: result.code, message: result.message, recoverable: true }
}

export const REPORTED_LABELS = Object.freeze(['done', 'partial', 'blocked'])

/**
 * The model's own completion word, parsed conservatively: only the first word
 * of the final answer, case-insensitively, with optional leading whitespace or
 * markdown emphasis. Anything else is null. This is model-reported evidence,
 * never independent verification.
 * @param {unknown} text
 * @returns {'done' | 'partial' | 'blocked' | null}
 */
export function parseReportedLabel(text) {
  if (typeof text !== 'string') return null
  const match = /^\s*(?:[*_~`]{1,3})?\s*(done|partial|blocked)\b/iu.exec(text)
  return match === null ? null : /** @type {'done' | 'partial' | 'blocked'} */ (match[1].toLowerCase())
}

function emptyUsageTotals() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 }
}

/** @param {Record<string, number>} target @param {Record<string, unknown>} usage */
function addUsageTotals(target, usage) {
  for (const key of Object.keys(target)) target[key] += Number(usage[key]) || 0
  return target
}

/** @param {Record<string, number> | undefined | null} usage */
function hasUsageTotals(usage) {
  if (!isRecord(usage)) return false
  return Object.values(usage).some(value => Number(value) > 0)
}

/** @param {unknown[]} events */
export function collectUsage(events) {
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 }
  for (const event of Array.isArray(events) ? events : []) {
    if (!isRecord(event) || event.type !== 'assistant/message') continue
    const data = isRecord(event.data) ? event.data : {}
    const usage = isRecord(data.usage) ? data.usage : undefined
    if (!usage) continue
    for (const key of Object.keys(totals)) totals[key] += Number(usage[key]) || 0
  }
  return totals
}

/** @param {Record<string, any>} data */
function extractReasoningText(data) {
  const message = isRecord(data.message) ? data.message : {}
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** @param {Record<string, any>} data */
function extractAssistantText(data) {
  const message = isRecord(data.message) ? data.message : {}
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** @param {unknown[]} blocks */
export function extractToolResultText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
  }
  return parts.join('\n').slice(0, 4_000)
}
