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
import { MarathonState, marathonFrameBody } from './marathon.mjs'
import { WatchLedger } from './watch-ledger.mjs'
import { Watcher } from './watcher.mjs'
import { formatDiaryPromptBlock, hostnameFromUrl, matchDiaryForTurn } from './diary.mjs'
import { DiaryTurnCollector } from './diary-suggester.mjs'
import { buildPromptBlocks, isDocsDocumentUrl, normalizeImageAttachments, normalizePlanSeed, promptStats } from './prompt.mjs'
import { PROTOCOL_VERSION, errorMessage, isRecord } from './protocol.mjs'

export const BUSY_MESSAGE = 'A turn is already running. Wait for it to finish.'
export const STOPPING_MESSAGE = 'A turn is still stopping. Wait a moment, then send your message again.'
export const SNAPSHOT_TIMEOUT_MS = 15_000
export const NOT_READY_MESSAGE = 'OpenRouter is not ready. Open Settings, enter your API key, choose an image-capable model, and Save.'

/**
 * @typedef {{
 *   turnStarted?: (info: {turnId: string, origin: string, clientMessageId?: string | null, text: string, imageCount: number, planMode: boolean, marathon?: boolean, sessionId?: string | null}) => void,
 *   turnEnded?: (info: {turnId: string, outcome: 'done' | 'stopped' | 'error', error?: string, sessionId?: string | null, help?: {category: string, reason: string, captureError: string | null}, confirm?: {action: string, target: string, captureError: string | null}, label?: 'done' | 'partial' | 'blocked' | null, usage?: Record<string, number>, timings?: Record<string, number | null>}) => void,
 * }} TurnObserver
 */

export class SessionController {
  /**
   * @param {{
   *   bridge: {requestUi: Function, setTurnId: (id: string | undefined, options?: {planMode?: boolean, confirmMode?: boolean}) => void, currentTurnId?: string},
   *   getRunner: () => any,
   *   isDisabled?: () => boolean,
   *   logStore: any,
   *   log?: (message: string) => void,
   *   autoCapture: boolean,
   *   provider: string,
   *   getModelId: () => string | undefined,
   *   getConfirmIrreversible?: () => boolean,
   *   publish: (frame: Record<string, any>) => void,
   *   observers?: TurnObserver[],
   *   watch?: {now?: () => number, wallNow?: () => number, setTimer?: Function, clearTimer?: Function, tickMs?: number, push?: Function, limits?: Record<string, number>, enabled?: boolean},
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
    this.getConfirmIrreversible = options.getConfirmIrreversible ?? (() => false)
    this.getWatchAutoSteer = options.getWatchAutoSteer ?? (() => true)
    this.diaryStore = options.diaryStore ?? null
    this.diarySuggester = options.diarySuggester ?? null
    this.getDiaryAutoSuggest = options.getDiaryAutoSuggest ?? (() => true)
    /** @type {DiaryTurnCollector} */
    this.diaryCollector = new DiaryTurnCollector()
    /** @type {Array<Record<string, any>>} */
    this.pendingDiarySuggestions = []
    /** @type {AbortController | null} */
    this.diarySuggestAbort = null
    /**
     * M3: the watch ledger runs for EVERY turn (marathon or not) so a mid-turn
     * toggle already has history. It is fed from every published frame; the
     * watcher reads it on its deterministic tick. Both are pure of I/O.
     * @type {WatchLedger}
     */
    this.ledger = new WatchLedger({ now: options.watch?.now })
    const basePublish = options.publish
    this.publish = frame => {
      this.ledger.noteFrame(frame)
      basePublish(frame)
    }
    /** @type {TurnObserver[]} */
    this.observers = options.observers ?? []
    this.running = false
    this.stopRequested = false
    this.sessionChanging = false
    /**
     * The one companion-owned marathon switch (MARATHON-PLAN.md §3.1). Both
     * transports change it only through setMarathon(); a fresh controller
     * (companion restart) starts off — the fail-safe default.
     * @type {MarathonState}
     */
    this.marathon = new MarathonState()
    /**
     * M3: the deterministic watcher; M4 wires the optional model judge. It only
     * reports via chat.watch; it never steers/stops/mutates. Timers are injected
     * for tests and .unref()'d in production. Disabled watchers still keep the
     * ledger. With judge===null (the default until index.mjs wires it) behavior
     * is exactly the deterministic M3 watcher.
     * @type {Watcher}
     */
    this.watcher = new Watcher({
      ledger: this.ledger,
      marathonEnabled: () => this.marathon.state.enabled,
      publish: frame => this.publish(frame),
      now: options.watch?.now,
      wallNow: options.watch?.wallNow,
      setTimer: options.watch?.setTimer,
      clearTimer: options.watch?.clearTimer,
      tickMs: options.watch?.tickMs,
      push: options.watch?.push,
      limits: options.watch?.limits,
      judge: options.watch?.judge ?? null,
      judgeLimits: options.watch?.judgeLimits,
      steerLimits: options.watch?.steerLimits,
      autoSteerEnabled: () => this.getWatchAutoSteer() === true,
      onSteer: typeof options.watch?.onSteer === 'function'
        ? options.watch.onSteer
        : (payload => typeof this.bridge?.sendWatchSteer === 'function' && this.bridge.sendWatchSteer(payload) === true),
      log: (type, data, severity) => this.logStore.record('companion', type, data, { severity: severity ?? 'info', turnId: this.turnId }),
    })
    this.watchEnabled = options.watch?.enabled !== false
    if (this.watchEnabled) this.watcher.start()
    /** @type {{checks: number, alerts: number, usage: number} | undefined} */
    this.watchTurnSummary = undefined
    /** The watcher's authoritative ended-incomplete decision for this turn (M3). */
    this.watchEndedIncomplete = false
    /** @type {string | undefined} */
    this.turnId = undefined
    /** What a client that connects mid-turn is shown (`chat.hello.turn`). */
    /** @type {{turnId: string, origin: string, text: string, imageCount: number, marathon: boolean} | undefined} */
    this.currentTurnInfo = undefined
    /** Set while the companion shuts down with a turn running. @type {string | undefined} */
    this.shutdownSignal = undefined
    /** @type {{status: string, reason?: string} | undefined} */
    this.docsTurnVerification = undefined
    /** @type {{outcome: string, revision?: number} | undefined} */
    this.planTurnOutcome = undefined
    /**
     * M2: the latest plan snapshot observed during the running turn (provider
     * `plan` activities). Kept into marathon.state at turn end iff open items
     * remain; re-seeds the next turn and the MALFORMED_RESPONSE rerun.
     * @type {undefined | {revision: number, items: Array<{content: string, status: string}>, updatedAt: string, turnId: string}}
     */
    this.planTurnSnapshot = undefined
    /**
     * The model's structured "I need the user" request for the running turn
     * (agent_request_help), received as a provider `help-request` activity.
     * @type {{category: string, reason: string} | undefined}
     */
    this.helpTurnRequest = undefined
    /**
     * The model's structured confirmation request for the running turn
     * (agent_request_confirmation), received as a `confirm-request` activity.
     * @type {{action: string, target: string} | undefined}
     */
    this.confirmTurnRequest = undefined
    /**
     * The open confirmation the user has not answered yet. It survives the end
     * of the turn that asked (the chat is waiting), and is cleared by the next
     * prompt of any kind, a new chat, or a resume to another session. Only an
     * answer submitted while this is set may carry confirm:"approve"|"deny".
     * @type {{action: string, target: string, turnId: string, sessionId: string | undefined} | undefined}
     */
    this.pendingConfirmation = undefined
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
    // M3 fix: live provider activities (plan/text/reasoning/model-start/...)
    // arrive here, not through publish. Feed the watch ledger so the digest has
    // the plan, the reasoning tail, and model-delta timestamps — without this
    // PLAN_STALLED can never fire live. Wrap as chat.activity (the ledger routes
    // on type); unknown kinds only bump lastEventAt. Tool events still flow via
    // publish, so there is no double feed.
    this.ledger.noteFrame({ ...frame, type: 'chat.activity' })
    if (frame.kind === 'help-request') {
      const help = normalizeHelpRequest(frame)
      if (help !== undefined) this.helpTurnRequest = help
      return
    }
    if (frame.kind === 'confirm-request') {
      const confirm = normalizeConfirmRequest(frame)
      if (confirm !== undefined) this.confirmTurnRequest = confirm
      return
    }
    if (frame.kind === 'watch-steer') {
      this.logStore.record('companion', 'watch.steer.ack', {
        turnId: this.turnId,
        steerId: typeof frame.steerId === 'string' ? frame.steerId : null,
        status: typeof frame.status === 'string' ? frame.status : 'unknown',
        reason: typeof frame.reason === 'string' ? frame.reason : undefined,
      }, { severity: frame.status === 'injected' ? 'info' : 'warn', turnId: this.turnId })
      return
    }
    if (frame.kind === 'plan') {
      // M2: capture the live plan as the carry-over snapshot. Malformed frames
      // are ignored (fail closed); the provider already validated the list.
      const seed = normalizePlanSeed(frame)
      if (seed !== null) {
        this.planTurnSnapshot = { ...seed, updatedAt: new Date().toISOString(), turnId: this.turnId }
      }
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
   * The shared marathon switch, accepted in any turn state (idle, running,
   * stopping, switching). The running turn keeps the modes it started with;
   * the new state applies from the next turn. Publishing `marathon.state` is
   * the only way clients learn the switch — they never flip it optimistically.
   * @param {{enabled: unknown, origin?: 'ui' | 'remote'}} input
   * @returns {{ok: true, enabled: boolean, sessionId: string | null, changed: boolean} | {ok: false, code: string, message: string, retryable: boolean}}
   */
  setMarathon({ enabled, origin = 'ui' }) {
    const result = this.marathon.set({ enabled, origin, sessionId: this.getRunner()?.sessionId ?? null })
    if (!result.ok) return result
    if (result.changed) {
      this.logStore.record('companion', 'marathon.set', { enabled: result.state.enabled, origin: result.state.origin, sessionId: result.state.sessionId }, { severity: 'info' })
      // W2: all turns are watched now, so turning marathon off mid-turn only
      // clears a marathon-specific ended-incomplete notice, not a live alert.
      if (!result.state.enabled) this.watcher.clearEndedIncomplete()
      this.#publishMarathon()
    }
    return { ok: true, enabled: result.state.enabled, sessionId: result.state.sessionId, changed: result.changed }
  }

  /** The current switch state as a plain snapshot (chat.hello, diagnostics). */
  marathonState() {
    return this.marathon.snapshot()
  }

  /** Publish the authoritative state to the panel and the remote hub. */
  #publishMarathon() {
    this.publish({ v: PROTOCOL_VERSION, type: 'marathon.state', ...marathonFrameBody(this.marathon.snapshot()), watcher: this.watcherPanelState() })
  }

  /**
   * Panel-facing watcher projection (marathon.state.watcher).
   * `active` means the current running turn is being watched.
   * @returns {{active: boolean, checks: number, lastCheckAt: string | null, lastVerdict: string | null}}
   */
  watcherPanelState() {
    const projection = this.watcher.watchProjection()
    return {
      active: this.watchEnabled && this.running,
      checks: projection.checks,
      lastCheckAt: projection.lastCheckAt,
      lastVerdict: projection.lastVerdict,
    }
  }

  /** New chat / real chat switch / restart: the switch resets to off and open notices clear. */
  #resetMarathon() {
    this.watcher.clearNotices()
    const { changed } = this.marathon.reset()
    if (changed) {
      this.logStore.record('companion', 'marathon.reset', {}, { severity: 'info' })
      this.#publishMarathon()
    }
  }

  /** M3: executor connectivity from the bridge (onConnectionChange). */
  setConnectivity(info) {
    this.ledger.setConnectivity(info)
  }

  /** M3: "It's fine" — dismiss the open watch alert and snooze its kind. */
  watchAck(id) {
    return this.watcher.ack(id)
  }

  /** M3: the open-alert projection for chat.hello and the remote /state. */
  watchState() {
    return this.watcher.watchProjection()
  }

  /**
   * M3: finish the watch for a terminal frame. Emits any ended-incomplete
   * notice (via chat.watch) and returns the additive per-turn summary. Never
   * changes the turn's outcome. Called once per turn, before the terminal frame.
   * @param {{outcome: string, label?: string | null, planOutcome?: string | null, help?: unknown, confirm?: unknown, deadTurn?: boolean}} info
   */
  #finishWatch(info) {
    if (this.watchTurnSummary !== undefined) return this.watchTurnSummary
    this.watchTurnSummary = this.watcher.turnEnded(info)
    // Capture the watcher's actual decision (not a recomputation) so the push
    // type and the transcript notice agree by construction. The chat.done watch
    // summary keeps its {checks,alerts,usage} shape.
    this.watchEndedIncomplete = this.watcher.lastEndedIncomplete === true
    return this.watchTurnSummary
  }

  /** Stop the watcher timer (companion shutdown / test teardown). */
  /**
   * Stop the watcher. Called while the companion shuts down: a turn still
   * running then ends as stopped by the shutdown, not as a runtime crash.
   * @param {string} [signal] the signal that is shutting the companion down
   */
  dispose(signal) {
    if (this.running && this.shutdownSignal === undefined) this.shutdownSignal = signal ?? 'shutdown'
    this.#abortDiarySuggestion()
    this.watcher.stop()
  }

  /** @returns {Array<Record<string, any>>} */
  diarySuggestionsState() {
    return this.pendingDiarySuggestions.map(item => ({
      ...item,
      sites: Array.isArray(item.sites) ? [...item.sites] : [],
      ...(item.previousEntry ? { previousEntry: { ...item.previousEntry, sites: [...(item.previousEntry.sites ?? [])] } } : {}),
    }))
  }

  /** Sync current enabled site entries to the DSH provider (mid-turn safe). */
  syncDiaryToTools() {
    if (this.diaryStore === null) return false
    return this.bridge.syncDiaryContext?.({ entries: this.diaryStore.listEnabledSiteEntries() }) === true
  }

  /**
   * Accept and persist one pending post-run Diary suggestion (optionally edited
   * by the user before saving).
   * @param {unknown} id
   * @param {{scope?: unknown, sites?: unknown, title?: unknown, content?: unknown}} [override]
   */
  acceptDiarySuggestion(id, override = {}) {
    if (typeof id !== 'string' || id.length === 0 || this.diaryStore === null) {
      return { ok: false, code: 'NOT_FOUND', error: 'Diary suggestion is no longer pending.' }
    }
    const index = this.pendingDiarySuggestions.findIndex(item => item.id === id)
    if (index < 0) {
      return { ok: false, code: 'NOT_FOUND', error: 'Diary suggestion is no longer pending.' }
    }
    const suggestion = this.pendingDiarySuggestions[index]
    const scope = override?.scope !== undefined ? override.scope : suggestion.scope
    const sites = override?.sites !== undefined ? override.sites : suggestion.sites
    const title = override?.title !== undefined ? override.title : suggestion.title
    const content = override?.content !== undefined ? override.content : suggestion.content

    let result
    if (suggestion.action === 'update' && typeof suggestion.replacesId === 'string' && suggestion.replacesId.length > 0) {
      result = this.diaryStore.update(suggestion.replacesId, { scope, sites, title, content, enabled: true })
      if (!result.ok && result.code === 'NOT_FOUND') {
        result = this.diaryStore.create({ scope, sites, title, content, enabled: true, source: 'suggested' })
      }
    } else {
      result = this.diaryStore.create({ scope, sites, title, content, enabled: true, source: 'suggested' })
    }
    if (!result.ok) {
      return { ok: false, code: result.code, error: result.error }
    }
    this.pendingDiarySuggestions = this.pendingDiarySuggestions.filter(item => item.id !== id)
    this.syncDiaryToTools()
    this.logStore.record('companion', 'diary.suggestion.accepted', {
      action: suggestion.action,
      scope: result.entry.scope,
      entryId: result.entry.id,
    }, { severity: 'info' })
    return {
      ok: true,
      entry: result.entry,
      diary: this.diaryStore.snapshot(),
      suggestions: this.diarySuggestionsState(),
    }
  }

  /**
   * Dismiss one (or all) pending post-run Diary suggestions and record
   * suppression fingerprints so dismissed topics are not re-suggested.
   * @param {unknown} id
   * @param {{all?: boolean}} [options]
   */
  dismissDiarySuggestion(id, options = {}) {
    if (options.all === true) {
      if (this.diaryStore !== null) {
        for (const item of this.pendingDiarySuggestions) this.diaryStore.suppress(item)
      }
      const count = this.pendingDiarySuggestions.length
      this.pendingDiarySuggestions = []
      if (count > 0) {
        this.logStore.record('companion', 'diary.suggestion.dismissed', { all: true, count }, { severity: 'info' })
      }
      return {
        ok: true,
        diary: this.diaryStore?.snapshot() ?? null,
        suggestions: [],
      }
    }
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, code: 'NOT_FOUND', error: 'Diary suggestion is no longer pending.' }
    }
    const suggestion = this.pendingDiarySuggestions.find(item => item.id === id)
    if (!suggestion) {
      return { ok: false, code: 'NOT_FOUND', error: 'Diary suggestion is no longer pending.' }
    }
    this.diaryStore?.suppress(suggestion)
    this.pendingDiarySuggestions = this.pendingDiarySuggestions.filter(item => item.id !== id)
    this.logStore.record('companion', 'diary.suggestion.dismissed', {
      action: suggestion.action,
      scope: suggestion.scope,
    }, { severity: 'info' })
    return {
      ok: true,
      diary: this.diaryStore?.snapshot() ?? null,
      suggestions: this.diarySuggestionsState(),
    }
  }

  #abortDiarySuggestion() {
    if (this.diarySuggestAbort !== null) {
      this.diarySuggestAbort.abort()
      this.diarySuggestAbort = null
    }
  }

  #clearDiarySuggestions() {
    if (this.pendingDiarySuggestions.length === 0) return
    this.pendingDiarySuggestions = []
    this.bridge.sendToUi?.({ v: PROTOCOL_VERSION, type: 'diary.suggestions', turnId: null, suggestions: [] })
  }

  async #runDiarySuggestion(turnId, sessionId, turnDigest) {
    this.#abortDiarySuggestion()
    const abortController = new AbortController()
    this.diarySuggestAbort = abortController
    try {
      const { existing, suppressed } = this.diaryStore.listForExtractor(turnDigest.visitedHosts)
      const result = await this.diarySuggester.suggest({
        turnDigest,
        existingEntries: existing,
        suppressed,
        isSuppressed: candidate => this.diaryStore.isSuppressed(candidate),
        signal: abortController.signal,
      })
      if (this.diarySuggestAbort !== abortController || abortController.signal.aborted) return
      this.diarySuggestAbort = null
      if (this.running || this.sessionChanging) return
      const currentSessionId = this.getRunner()?.sessionId
      if (typeof sessionId === 'string' && typeof currentSessionId === 'string' && sessionId !== currentSessionId) return
      if (!Array.isArray(result?.suggestions) || result.suggestions.length === 0) return
      this.pendingDiarySuggestions = result.suggestions
      this.bridge.sendToUi?.({
        v: PROTOCOL_VERSION,
        type: 'diary.suggestions',
        turnId,
        suggestions: this.diarySuggestionsState(),
      })
    } catch (error) {
      if (this.diarySuggestAbort === abortController) this.diarySuggestAbort = null
      this.logStore.record('companion', 'diary.suggest.error', { turnId, message: errorMessage(error) }, { severity: 'warn', turnId })
    }
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
   * @param {{text: unknown, images?: unknown, autoCapture?: unknown, planMode?: unknown, steer?: unknown, confirm?: unknown, origin?: string, clientMessageId?: string | null}} input
   * @returns {{ok: true, turnId: string, done: Promise<void>, steered?: boolean} | {ok: false, code: string, message: string, retryable: boolean}}
   */
  submit(input) {
    const confirm = input.confirm
    if (confirm !== undefined && confirm !== 'approve' && confirm !== 'deny') {
      return { ok: false, code: 'INVALID_CONFIRMATION', message: 'confirm must be "approve" or "deny".', retryable: false }
    }
    if (confirm !== undefined && input.steer === true) {
      return { ok: false, code: 'INVALID_CONFIRMATION', message: 'A confirmation answer cannot steer a running turn; answers are only valid while the chat waits.', retryable: false }
    }
    let prompt = typeof input.text === 'string' ? input.text.trim() : ''
    // An approve/deny answer may carry no text of its own; the companion writes
    // the confirmation block. An ordinary empty prompt is still refused.
    if (prompt.length === 0 && confirm === undefined) return { ok: false, code: 'EMPTY_PROMPT', message: 'The message is empty.', retryable: false }
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
    /** @type {string | undefined} What clients show for this turn when it differs from the model's prompt. */
    let displayText
    if (confirm !== undefined) {
      const pending = this.pendingConfirmation
      if (pending === undefined || (typeof runner.sessionId === 'string' && pending.sessionId !== runner.sessionId)) {
        return { ok: false, code: 'NO_CONFIRMATION_PENDING', message: 'No confirmation is waiting for an answer in this chat. Send an ordinary prompt instead.', retryable: false }
      }
      // The companion, not the client, writes the decision block the model sees.
      const block = confirmationPromptBlock(confirm, pending.action)
      // People see their decision in plain words; only the model gets the block.
      displayText = confirmationDisplayText(confirm, pending.action, prompt)
      prompt = prompt.length > 0 ? `${block}\n\n${prompt}` : block
      this.logStore.record('companion', 'confirm.answered', {
        decision: confirm,
        actionChars: pending.action.length,
        requestedTurnId: pending.turnId,
      }, { severity: 'info' })
      this.pendingConfirmation = undefined
    }
    return { ok: true, ...this.#begin({ turnId: newTurnId(), prompt, displayText, images, input, runner, confirmApproved: confirm === 'approve' }) }
  }

  /**
   * Reserve the turn slot and start the turn. Synchronous up to the first
   * await inside the turn, so callers can rely on `running` immediately.
   * `displayText` replaces the prompt in what clients and saved history show
   * (a confirmation answer); the model still receives `prompt`.
   * @param {{turnId: string, prompt: string, displayText?: string, images: any[], input: Record<string, any>, runner: any}} start
   * @returns {{turnId: string, done: Promise<void>}}
   */
  #begin({ turnId, prompt, displayText, images, input, runner, confirmApproved = false }) {
    const shownText = displayText ?? prompt
    this.running = true
    this.docsTurnVerification = undefined
    this.planTurnOutcome = undefined
    this.planTurnSnapshot = undefined
    this.helpTurnRequest = undefined
    this.confirmTurnRequest = undefined
    this.watchTurnSummary = undefined
    this.watchEndedIncomplete = false
    // Any prompt answers an open confirmation; an approve/deny answer already
    // consumed it in submit(). The same session continues either way.
    this.pendingConfirmation = undefined
    this.#abortDiarySuggestion()
    this.#clearDiarySuggestions()
    this.turnId = turnId
    const origin = input.origin ?? 'ui'
    // Legacy one-shot arming (old APK /plan, queued panel items): the explicit
    // planMode flag first turns the shared switch on with the sender's origin,
    // then the turn arms from the switch like any marathon turn (§3.1).
    if (input.planMode === true && !this.marathon.state.enabled) {
      this.setMarathon({ enabled: true, origin })
    }
    const planMode = this.marathon.state.enabled || input.planMode === true
    this.currentTurnInfo = { turnId, origin, text: shownText, imageCount: images.length, marathon: planMode }
    const confirmMode = this.getConfirmIrreversible() === true
    // Executor backstop: on unless this turn starts from the user's approval.
    const confirmGuard = confirmMode && confirmApproved !== true
    // V1: close any open ended-incomplete notice from the previous turn BEFORE
    // the new turn's first frame, so the amber state never carries into a turn.
    this.watcher.closeEndedIncomplete('A new turn started.')
    // M3: the ledger records every turn; the watcher only alerts on marathon
    // turns. Starting them here means a mid-turn toggle already has history.
    const planSeed = this.#carriedPlanSeed()
    this.ledger.startTurn({ turnId, prompt: shownText, marathon: planMode })
    // V4 (§3.5, G2): the judge learns the task — pass the internal carry chain
    // (ancestor prompts) + the marathon carried-plan revision when this turn is
    // seeded. The current prompt stays the digest `task`; carriedFrom is ancestors.
    this.watcher.turnStarted({
      marathon: planMode,
      carry: {
        seeded: planSeed !== null,
        seededRevision: this.marathon.state.plan?.revision ?? null,
        carriedFrom: this.marathon.carryChainForDigest(),
      },
    })
    this.#notify('turnStarted', {
      turnId,
      origin,
      clientMessageId: input.clientMessageId ?? null,
      text: shownText,
      imageCount: images.length,
      planMode,
      marathon: planMode,
      sessionId: runner.sessionId ?? null,
    })
    if (typeof runner.sessionId === 'string') {
      this.publish({ v: PROTOCOL_VERSION, type: 'chat.session', sessionId: runner.sessionId })
    }
    if (origin !== 'ui') {
      // The panel renders its own prompts locally; it only needs prompts that
      // another client (the phone) started, so it can show the turn and queue
      // desktop input instead of colliding with it.
      this.publish({ v: PROTOCOL_VERSION, type: 'chat.user', turnId, origin, text: shownText, imageCount: images.length, ...(planMode ? { marathon: true } : {}) })
    }
    const done = this.#runTurn({ turnId, runner, prompt, shownText, images, autoCaptureFlag: input.autoCapture, origin, planMode, confirmMode, confirmGuard, planSeed })
    return { turnId, done }
  }

  /**
   * M2: the seed for a turn about to start — the carried marathon plan, if any.
   * @returns {null | {revision: number, items: Array<{content: string, status: string}>}}
   */
  #carriedPlanSeed() {
    const plan = this.marathon.state.plan
    return plan === null ? null : { revision: plan.revision, items: plan.items.map(item => ({ ...item })) }
  }

  /**
   * M2: the CURRENT snapshot for the MALFORMED_RESPONSE rerun — the latest
   * plan observed this turn, falling back to the carried one (§3.2).
   */
  #currentPlanSeed() {
    const snapshot = this.planTurnSnapshot
    if (snapshot !== undefined) return { revision: snapshot.revision, items: snapshot.items.map(item => ({ ...item })) }
    return this.#carriedPlanSeed()
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
  /**
   * The running turn, for a client that connects mid-turn (`chat.hello.turn`),
   * or null when the slot is free.
   */
  runningTurn() {
    if (!this.running || this.currentTurnInfo === undefined) return null
    return { running: true, ...this.currentTurnInfo }
  }

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
      this.pendingConfirmation = undefined
      this.#abortDiarySuggestion()
      this.#clearDiarySuggestions()
      this.diaryCollector.resetSession()
      // A new chat never inherits the previous chat's marathon switch.
      this.#resetMarathon()
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
      this.pendingConfirmation = undefined
      this.#abortDiarySuggestion()
      this.#clearDiarySuggestions()
      this.diaryCollector.resetSession()
      // Continuing a different saved chat resets the switch (the `already`
      // path above never reaches here: the session did not change).
      this.#resetMarathon()
      this.publish({ v: PROTOCOL_VERSION, type: 'chat.session', sessionId: resumed, resumed: true })
      this.sendStatus('idle')
      return { ok: true, sessionId: resumed }
    } finally {
      this.sessionChanging = false
    }
  }

  /**
   * @param {{turnId: string, runner: any, prompt: string, images: any[], autoCaptureFlag: unknown, origin: string, planMode: boolean, confirmMode: boolean, planSeed?: {revision: number, items: Array<{content: string, status: string}>} | null}} turn
   */
  async #runTurn({ turnId, runner, prompt, shownText = prompt, images, autoCaptureFlag, planMode, confirmMode, confirmGuard = false, planSeed = null }) {
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
    let ending = { outcome: 'error', error: 'turn ended unexpectedly', marathon: planMode, endedIncomplete: this.watchEndedIncomplete }
    let diaryFinalizeArgs = { outcome: 'error' }

    bridge.setTurnId(turnId, { planMode, confirmMode, confirmGuard, planSeed, userPrompt: prompt })
    logStore.turnStart(turnId, prompt, {
      autoCapture: wantAutoCapture,
      planMode,
      marathon: planMode,
      planSeedRevision: planSeed?.revision ?? null,
      confirmMode,
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

      // D2: a Docs tab in the turn-start view arms the conditional Docs
      // guidance block; a mid-turn switch is covered by the provider's
      // first-Docs-call fail-safe.
      const docsMode = isDocsDocumentUrl(view?.tab?.url)
      const diaryMatch = this.diaryStore !== null
        ? matchDiaryForTurn(this.diaryStore.snapshot().entries, { url: view?.tab?.url, prompt: shownText })
        : { entries: [], ids: [], globalCount: 0, siteCount: 0, omitted: 0 }
      const diaryBlock = formatDiaryPromptBlock(diaryMatch.entries, { omitted: diaryMatch.omitted })
      const diaryContext = this.diaryStore !== null
        ? { entries: this.diaryStore.listEnabledSiteEntries(), deliveredIds: diaryMatch.ids }
        : null
      if (diaryContext !== null) bridge.syncDiaryContext?.(diaryContext)
      if (diaryMatch.entries.length > 0) {
        logStore.record('companion', 'diary.prompt.injected', {
          count: diaryMatch.entries.length,
          globalCount: diaryMatch.globalCount,
          siteCount: diaryMatch.siteCount,
          omitted: diaryMatch.omitted,
          chars: diaryBlock.length,
        }, { turnId, severity: 'info' })
        const siteEntries = diaryMatch.entries.filter(entry => entry.scope === 'site')
        if (siteEntries.length > 0) {
          const startHost = hostnameFromUrl(view?.tab?.url) ?? siteEntries[0]?.sites?.[0] ?? ''
          bridge.sendToUi?.({
            v: PROTOCOL_VERSION,
            type: 'chat.activity',
            kind: 'diary-applied',
            scope: 'site',
            ...(startHost ? { host: startHost } : {}),
            count: siteEntries.length,
            titles: siteEntries.map(entry => entry.title),
          })
        }
      }
      this.diaryCollector.startTurn({
        turnId,
        sessionId: runner.sessionId ?? null,
        prompt: shownText,
        startUrl: view?.tab?.url ?? null,
      })
      const blocks = buildPromptBlocks(view, prompt, new Date(), images, { planMode, confirmMode, docsMode, diaryBlock, marathon: { seed: planSeed } })
      const stats = promptStats(blocks)
      promptTextBytes = stats.textBytes
      imageBytes = stats.imageBytes
      logStore.record('companion', 'prompt.build', {
        textBytes: promptTextBytes,
        imageBytes,
        images: stats.images,
        planMode,
        confirmMode,
        text: blocks[0]?.text,
      }, { turnId, severity: 'debug' })

      this.sendStatus('thinking')
      const run = runBlocks => runner.run(runBlocks, notification => {
        if (firstEventMs === null) firstEventMs = Math.round(performance.now() - turnStart)
        logStore.recordDshNotification(notification, turnId)
        this.forwardNotification(notification, turnId, toolCalls, toolStarts, turnStats)
      })
      turnStats.userMessageSeen = false
      let result = await run(blocks)
      // The runtime ended the turn on an error before any browser action: a
      // reply that could not be parsed (typically a tool call with broken JSON
      // arguments), a request that still failed in transit after the
      // provider's own retries, or a model switch whose context compaction
      // failed. Run once more in the same companion turn, re-arming this
      // turn's conditional tools, instead of ending on an empty answer.
      const rerunCode = turnStats.endError?.code
      if (ZERO_ACTION_RERUN_CODES.has(rerunCode) && toolCalls.size === 0 && !this.stopRequested && this.shutdownSignal === undefined) {
        // DSH commits the user message only after it prepares the request, and
        // a model-switch compaction failure happens while preparing it: then the
        // prompt never reached the session and is sent again as it was.
        // Otherwise the prompt is in the session and a notice continues it.
        const resend = rerunCode === 'MODEL_SWITCH_COMPACTION_FAILED' && turnStats.userMessageSeen !== true
        logStore.record('companion', 'turn.retry', {
          reason: rerunCode === 'MALFORMED_RESPONSE' ? 'malformed-response' : 'request-failed',
          code: rerunCode,
          resend,
          ...(turnStats.endError.message === undefined ? {} : { message: turnStats.endError.message }),
        }, { turnId, severity: 'warn' })
        turnStats.endError = undefined
        turnStats.userMessageSeen = false
        // M2: re-arm with the CURRENT plan snapshot, not the turn-start one.
        const currentSeed = this.#currentPlanSeed()
        bridge.setTurnId(turnId, { planMode, confirmMode, confirmGuard, planSeed: currentSeed, userPrompt: prompt, ...(diaryContext ? { diaryContext } : {}) })
        const notice = rerunCode === 'MALFORMED_RESPONSE' ? MALFORMED_RETRY_NOTICE : REQUEST_RETRY_NOTICE
        result = await run(resend ? blocks : buildPromptBlocks(null, notice, new Date(), [], { planMode, confirmMode, docsMode, marathon: { seed: currentSeed } }))
      }
      // A run that still ended in a runtime error is a failed turn, never an
      // empty successful one.
      if (turnStats.endError !== undefined && !this.stopRequested) {
        const code = turnStats.endError.code ?? 'runtime error'
        if (turnStats.endError.message !== undefined) {
          logStore.record('companion', 'turn.runtime_error', { code, message: turnStats.endError.message }, { turnId, severity: 'warn' })
        }
        throw new Error(runtimeErrorText(code, toolCalls.size))
      }

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

      // The model asked to perform an irreversible action and wants approval.
      // Same shape as help: one capture after the run, then the chat waits.
      // A help request in the same turn wins (blocked is the stronger signal).
      const confirmRequest = this.confirmTurnRequest
      let confirm
      if (confirmRequest !== undefined && helpRequest !== undefined) {
        logStore.record('companion', 'confirm.superseded', { turnId }, { turnId, severity: 'info' })
      } else if (confirmRequest !== undefined) {
        const captured = await this.#capture('confirm')
        confirm = { ...confirmRequest, captureError: captured.ok ? null : captured.message }
        logStore.record('companion', 'confirm.request', {
          actionChars: confirmRequest.action.length,
          targetChars: confirmRequest.target.length,
          captured: captured.ok,
          ...(captured.ok ? {} : { captureCode: captured.code }),
        }, { turnId, severity: 'info' })
        // Stop pressed during that capture: end as stopped, not as waiting.
        if (this.stopRequested) throw new Error('turn stopped by user during the confirmation capture')
      }

      const collectedUsage = collectUsage(result.events)
      const usage = hasUsageTotals(collectedUsage) ? collectedUsage : { ...turnStats.usage }
      // A turn that still ends on a tool call written as text did nothing.
      // So did a turn with no tool call, no request to the user, and no words.
      const blankTurn = toolCalls.size === 0 && help === undefined && confirm === undefined
        && String(result.finalResponse ?? '').trim().length === 0
      const deadTurn = blankTurn || isLeakedToolCallText(result.finalResponse)
      const finalText = deadTurn ? DEAD_TURN_TEXT : result.finalResponse
      const label = parseReportedLabel(finalText)
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
      const completionError = deadTurn
        ? (blankTurn ? 'Model returned an empty reply; nothing was executed' : 'Model wrote its tool call as text; nothing was executed')
        : unverified
        ? `Docs verification incomplete (${verification.reason ?? 'one-nudge-only'})`
        : planIncomplete ? `Plan ${plan.outcome} (revision ${plan.revision ?? 0})` : undefined
      // M3: the additive watch summary (and any ended-incomplete notice) before
      // the terminal frame. Never changes ok/label/plan/docsVerification.
      const watch = this.#finishWatch({ outcome: 'done', label, planOutcome: plan?.outcome, help, confirm, deadTurn })
      logStore.turnEnd(turnId, {
        ok: !deadTurn && !unverified && !planIncomplete,
        finalText,
        timings,
        usage,
        label,
        planOutcome: plan?.outcome,
        planRevision: plan?.revision,
        watch,
        ...(confirm === undefined ? {} : { confirmRequested: true }),
        ...completionError ? { error: completionError } : {},
      })
      this.publish({
        v: PROTOCOL_VERSION,
        type: 'chat.done',
        sessionId: result.sessionId,
        text: finalText,
        timings,
        usage,
        label,
        model: this.getModelId(),
        provider: this.provider,
        docsVerification: verification?.status,
        docsVerificationReason: verification?.reason,
        planMode,
        // M1 emits both names for one release: they describe the same armed
        // turn. planOutcome/planRevision keep their names (§3.4).
        marathon: planMode,
        planOutcome: plan?.outcome,
        planRevision: plan?.revision,
        watch,
        ...(help === undefined ? {} : { help: { category: help.category, reason: help.reason } }),
        ...(confirm === undefined ? {} : { confirm: { action: confirm.action, target: confirm.target } }),
      })
      this.sendStatus('idle')
      if (confirm !== undefined) {
        // The chat now waits for the user's Approve/Deny. The next prompt of
        // any kind clears this; only an answer while it is set may decide.
        this.pendingConfirmation = { action: confirm.action, target: confirm.target, turnId, sessionId: result.sessionId }
      }
      ending = { outcome: 'done', sessionId: result.sessionId, label, usage, timings, marathon: planMode, planOutcome: plan?.outcome ?? null, deadTurn, endedIncomplete: this.watchEndedIncomplete, ...(help === undefined ? {} : { help }), ...(confirm === undefined ? {} : { confirm }) }
      diaryFinalizeArgs = { outcome: 'done', finalText, help, confirm, deadTurn }
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
        const watch = this.#finishWatch({ outcome: 'stopped', label })
        logStore.turnEnd(turnId, { ok: false, aborted: true, reason: 'user', timings, usage, label, watch })
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
          watch,
        })
        this.sendStatus('idle')
        ending = { outcome: 'stopped', sessionId: sessionId ?? null, label, usage, timings, marathon: planMode, endedIncomplete: this.watchEndedIncomplete }
      } else if (this.shutdownSignal !== undefined) {
        // The companion is shutting down: the runtime exit is expected.
        const shutdownMessage = `The companion shut down (${this.shutdownSignal}) during this turn; nothing more ran. Check the page before sending the request again.`
        logStore.record('companion', 'turn.shutdown', { turnId, signal: this.shutdownSignal, runtimeError: message.slice(0, 300) }, { turnId, severity: 'warn' })
        const watch = this.#finishWatch({ outcome: 'stopped', label })
        logStore.turnEnd(turnId, { ok: false, aborted: true, reason: 'shutdown', error: shutdownMessage, timings, usage, label, watch })
        this.publish({ v: PROTOCOL_VERSION, type: 'chat.stopped', turnId, reason: 'shutdown', message: shutdownMessage, timings, usage, watch })
        ending = { outcome: 'stopped', sessionId: current?.sessionId ?? current?.resumeSessionId ?? null, label, usage, timings, marathon: planMode, endedIncomplete: this.watchEndedIncomplete }
      } else {
        logStore.error(message, { turnId, code: 'TURN_ERROR' })
        const watch = this.#finishWatch({ outcome: 'error', label })
        logStore.turnEnd(turnId, { ok: false, error: message, timings, usage, label, watch })
        this.publish({ v: PROTOCOL_VERSION, type: 'chat.error', message, recoverable: true, watch })
        this.sendStatus('error')
        ending = { outcome: 'error', error: message, label, usage, timings, marathon: planMode, endedIncomplete: this.watchEndedIncomplete }
      }
    } finally {
      this.#notify('turnEnded', { turnId, ...ending })
      this.running = false
      this.stopRequested = false
      this.docsTurnVerification = undefined
      this.planTurnOutcome = undefined
      this.helpTurnRequest = undefined
      this.confirmTurnRequest = undefined
      this.turnId = undefined
      this.currentTurnInfo = undefined
      bridge.setTurnId(undefined)
      // M2: keep the observed plan into the next turn iff open items remain
      // (a completed/blocked-only plan is dropped). A turn that never touched
      // the plan leaves the carried snapshot untouched (seeded-untouched).
      if (this.planTurnSnapshot !== undefined && this.marathon.state.enabled) {
        const stored = this.marathon.storePlan(this.planTurnSnapshot)
        if (stored.changed) {
          this.logStore.record('companion', 'marathon.plan.carried', { revision: stored.state.plan?.revision ?? null, open: stored.state.plan !== null }, { severity: 'info' })
          this.#publishMarathon()
        }
        // V4 (§3.5): if the carried plan persists, this turn's prompt becomes an
        // ancestor for the next continuation turn (carry chain, internal). A
        // dropped plan already reset the chain in storePlan.
        if (stored.state.plan !== null) this.marathon.pushCarryPrompt(prompt, turnId)
      }
      this.planTurnSnapshot = undefined
      const diaryDigest = this.diaryCollector.finishTurn(
        ending.outcome === 'done' ? diaryFinalizeArgs : { outcome: ending.outcome },
      )
      const hasPendingSteer = this.pendingSteer !== undefined
      this.#startPendingSteer()
      if (
        !hasPendingSteer
        && diaryDigest !== null
        && this.diaryStore !== null
        && this.diarySuggester !== null
        && this.getDiaryAutoSuggest() === true
        && this.shutdownSignal === undefined
      ) {
        void this.#runDiarySuggestion(turnId, ending.sessionId ?? null, diaryDigest)
      }
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
      // Remember a runtime-error ending (for example MALFORMED_RESPONSE); a
      // later turn of the same run that ends normally clears it.
      const reason = isRecord(data.reason) ? data.reason : {}
      const error = isRecord(reason.error) ? reason.error : {}
      turnStats.endError = reason.kind === 'error'
        ? {
          code: typeof error.code === 'string' ? error.code.slice(0, 60) : undefined,
          ...(typeof error.message === 'string' && error.message.length > 0 ? { message: redactRuntimeErrorMessage(error.message) } : {}),
        }
        : undefined
      return
    }
    if (event.type === 'user/message') {
      // The runtime committed this run's prompt (or its context) to the session.
      turnStats.userMessageSeen = true
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
      if (isLeakedToolCallText(text)) {
        // The model wrote a tool call as markup: nothing ran and the provider
        // retries the step. Log it, but do not show the markup to people.
        this.logStore.record('dsh', 'assistant.leaked_tool_call', { chars: text.length }, { turnId, severity: 'warn' })
      } else if (text.length > 0) {
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
      this.diaryCollector.noteToolCall({ name: data.name, args })
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
      if (isError || /^refused [A-Z_]+:/u.test(text)) turnStats.failedCalls += 1
      const started = callId ? toolStarts.get(callId) : undefined
      const durationMs = started === undefined ? undefined : Math.round(performance.now() - started)
      if (callId) toolStarts.delete(callId)
      this.logStore.toolResult(turnId, { callId, ok: !isError, text, durationMs })
      this.diaryCollector.noteToolResult({ ok: !isError, text })
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

export const CONFIRM_ACTION_MAX_CHARS = 200
export const CONFIRM_TARGET_MAX_CHARS = 200

/**
 * Accept only the exact structured shape the provider tool produces.
 * @param {unknown} value
 * @returns {{action: string, target: string} | undefined}
 */
export function normalizeConfirmRequest(value) {
  if (!isRecord(value) || typeof value.action !== 'string' || typeof value.target !== 'string') return undefined
  const action = value.action.trim().slice(0, CONFIRM_ACTION_MAX_CHARS)
  const target = value.target.trim().slice(0, CONFIRM_TARGET_MAX_CHARS)
  if (action.length === 0 || target.length === 0) return undefined
  return { action, target }
}

/**
 * What people see for a confirmation answer (panel, phone, saved history):
 * the decision in plain words plus any text they added. Never the model block.
 * @param {'approve' | 'deny'} decision
 * @param {string} action
 * @param {string} [text]
 */
export function confirmationDisplayText(decision, action, text = '') {
  const line = `${decision === 'approve' ? 'Approved' : 'Denied'}: ${action}`
  return text.length > 0 ? `${line}\n\n${text}` : line
}

/**
 * The companion-written decision block the next turn's prompt carries. The
 * model guidance keys off this exact shape; clients never write it themselves.
 * @param {'approve' | 'deny'} decision
 * @param {string} action
 */
export function confirmationPromptBlock(decision, action) {
  const escaped = String(action)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
  return `<user_confirmation decision="${decision}" action="${escaped}"/>`
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

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

function emptyUsageTotals() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 }
}

/** @param {Record<string, number>} target @param {Record<string, unknown>} usage */
function addUsageTotals(target, usage) {
  for (const key of USAGE_KEYS) {
    const value = Number(usage[key]) || 0
    if (key in target || value !== 0) target[key] = (target[key] ?? 0) + value
  }
  return target
}

/** @param {Record<string, number> | undefined | null} usage */
function hasUsageTotals(usage) {
  if (!isRecord(usage)) return false
  return Object.values(usage).some(value => Number(value) > 0)
}

/** @param {unknown[]} events */
export function collectUsage(events) {
  const totals = emptyUsageTotals()
  for (const event of Array.isArray(events) ? events : []) {
    if (!isRecord(event) || event.type !== 'assistant/message') continue
    const data = isRecord(event.data) ? event.data : {}
    const usage = isRecord(data.usage) ? data.usage : undefined
    if (!usage) continue
    addUsageTotals(totals, usage)
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

const MALFORMED_RETRY_NOTICE = 'Automatic notice, not a new request: your previous reply could not be parsed (a tool call with malformed JSON arguments), so nothing was executed and the browser is unchanged. Continue the request above now, and send every tool call with valid JSON arguments.'

const REQUEST_RETRY_NOTICE = 'Automatic notice, not a new request: the model request for the request above failed before any reply, so nothing was executed and the browser is unchanged. Continue the request above now.'

/**
 * Runtime turn errors that are rerun once when no browser action ran: an
 * unparseable reply, a request that still failed in transit after the
 * provider retry policy, and a model switch whose context compaction failed
 * (the user resending the same prompt recovered it in the field).
 */
export const ZERO_ACTION_RERUN_CODES = new Set(['MALFORMED_RESPONSE', 'TRANSPORT', 'MODEL_SWITCH_COMPACTION_FAILED'])

/** Runtime codes for a model request that failed, as opposed to a reply that could not be used. */
const REQUEST_FAILURE_CODES = new Set([
  'TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE', 'QUOTA', 'ACCOUNT_QUOTA',
  'CONTEXT_WINDOW_EXCEEDED', 'MODEL_SWITCH_COMPACTION_FAILED', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'NO_ADAPTER',
])

/**
 * The user-facing text for a turn the runtime ended on an error.
 * @param {string} code
 * @param {number} actions browser actions that ran before the error
 */
export function runtimeErrorText(code, actions) {
  const subject = REQUEST_FAILURE_CODES.has(code) ? `The model request failed (${code})` : `The model's reply could not be used (${code})`
  return actions === 0
    ? `${subject}, so nothing was done. Send the request again.`
    : `${subject} after ${actions} action${actions === 1 ? '' : 's'}. Check the page before sending the request again.`
}

/** Bound a runtime error message for the logs, masking anything shaped like a credential. */
function redactRuntimeErrorMessage(message) {
  return message
    .replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}/gu, '$1…')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, '$1…')
    .slice(0, 400)
}

const DEAD_TURN_TEXT = 'BLOCKED: the model sent an empty or malformed reply, so nothing was done on the page. Send the request again.'

/**
 * True when the text is a tool call written as DeepSeek DSML markup instead
 * of a structured call (the provider retries such steps).
 * @param {unknown} text
 */
export function isLeakedToolCallText(text) {
  // Fullwidth-bar DSML tags never occur in ordinary prose; the ASCII form
  // counts only at the very start of the reply.
  return typeof text === 'string'
    && (/<\/?｜\s*DSML\s*｜\s*(?:calls|invoke|function_calls|parameter)\b/.test(text) || /^\s*<\/?\|\s*DSML\s*\|/.test(text))
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
