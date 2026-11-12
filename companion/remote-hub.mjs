/**
 * RemoteHub: the companion-owned canonical event journal for remote (phone)
 * clients.
 *
 * It receives a normalized copy of allowlisted side-panel chat frames plus
 * explicit turn lifecycle calls from the session controller, and owns:
 *   - a random per-process instance ID and a monotonically increasing sequence;
 *   - a bounded journal for ordered replay after a reconnect;
 *   - the current remote projection (turn state, committed messages, the
 *     aggregated streamed draft) for full resync;
 *   - bounded idempotency results for client-generated command IDs;
 *   - a bounded in-memory mirror of the screenshots the agent captured.
 *
 * It never sees or forwards `browser.command` frames, and it is not built from
 * the side panel's rendered HTML history or the debug-log JSONL.
 */

import { createHash, randomBytes } from 'node:crypto'
import { isRecord } from './protocol.mjs'
import { RemoteHistoryStore } from './remote-history.mjs'

export const REMOTE_PROTOCOL_VERSION = 1
export const REMOTE_TURN_STATES = Object.freeze(['starting', 'idle', 'running', 'stopping', 'waiting_for_user', 'error'])

/** Frame types the hub accepts from the companion's chat broadcaster. */
const INGESTED_TYPES = new Set([
  'chat.status',
  'chat.activity',
  'chat.assistant',
  'chat.tool_call',
  'chat.tool_result',
  'chat.done',
  'chat.stopping',
  'chat.stopped',
  'chat.error',
  'chat.session',
])

/** Committed events kept in the resync projection. */
const COMMITTED_TYPES = new Set([
  'chat.user',
  'chat.assistant',
  'chat.tool_call',
  'chat.tool_result',
  'chat.done',
  'chat.stopped',
  'chat.error',
])

const MAX_TEXT_CHARS = 200_000
const MAX_TOOL_ARGS_CHARS = 16_000
/** Screenshot formats a phone can decode; anything else is not mirrored. */
const SCREENSHOT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** Where a mirrored image came from: the agent, or a capture the companion made itself. */
const SCREENSHOT_SOURCES = new Set(['auto', 'tool', 'manual', 'help', 'confirm'])

/**
 * @typedef {{
 *   v: number,
 *   instanceId: string,
 *   seq: number,
 *   type: string,
 *   sessionId: string | null,
 *   turnId?: string,
 *   occurredAt: string,
 *   body: Record<string, any>,
 * }} RemoteEnvelope
 */

export class RemoteHub {
  /**
   * @param {{
   *   instanceId?: string,
   *   serverVersion?: string,
   *   now?: () => number,
   *   journalLimit?: number,
   *   journalByteLimit?: number,
   *   messageLimit?: number,
   *   commandTtlMs?: number,
   *   commandLimit?: number,
   *   getHealth?: () => Record<string, any>,
   *   historyFile?: string,
   *   historyLimit?: number,
   *   screenshotLimit?: number,
   *   screenshotByteLimit?: number,
   *   screenshotMaxBytes?: number,
   *   newScreenshotId?: () => string,
   *   log?: (message: string) => void,
   * }} [options]
   */
  constructor(options = {}) {
    this.instanceId = options.instanceId ?? `companion-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
    this.serverVersion = options.serverVersion ?? 'unknown'
    this.now = options.now ?? Date.now
    this.journalLimit = positive(options.journalLimit, 2_000)
    this.journalByteLimit = positive(options.journalByteLimit, 4_000_000)
    this.messageLimit = positive(options.messageLimit, 300)
    this.commandTtlMs = positive(options.commandTtlMs, 15 * 60_000)
    this.commandLimit = positive(options.commandLimit, 1_000)
    this.getHealth = options.getHealth ?? (() => ({}))
    this.history = new RemoteHistoryStore({ file: options.historyFile, limit: options.historyLimit, log: options.log })

    this.seq = 0
    /** @type {RemoteEnvelope[]} */
    this.journal = []
    /** @type {number[]} */
    this.journalSizes = []
    this.journalBytes = 0
    /** @type {RemoteEnvelope[]} */
    this.messages = []
    /** @type {string | null} */
    this.sessionId = null
    /** @type {{status: string, turnId: string | null, origin: string | null, clientMessageId: string | null, startedAt: string | null, endedAt: string | null, outcome: string | null, error: string | null, label: 'done' | 'partial' | 'blocked' | null, usage: Record<string, number> | null, failedCalls: number | null}} */
    this.turn = {
      status: 'starting',
      turnId: null,
      origin: null,
      clientMessageId: null,
      startedAt: null,
      endedAt: null,
      outcome: null,
      error: null,
      label: null,
      usage: null,
      failedCalls: null,
    }
    /** Activity phase from chat.status (capturing/thinking/tool/...). */
    this.phase = { status: null, tool: null }
    this.step = 0
    /** @type {null | {turnId: string | null, streamId: string, text: string, reasoning: string, tools: Map<string, {name: string | null, args: string}>}} */
    this.draft = null
    /** @type {Set<(envelope: RemoteEnvelope) => void>} */
    this.subscribers = new Set()
    /** @type {Map<string, {kind: string, fingerprint: string, outcome: any, at: number}>} */
    this.commands = new Map()
    this.lastHealthJson = ''
    /** Latest provider-reported context size for this session, not a turn sum. */
    this.contextTokens = null
    // Bounded in-memory mirror of the views the agent captured. Never written
    // to disk and never resolved from a client-supplied path.
    this.screenshotLimit = positive(options.screenshotLimit, 24)
    this.screenshotByteLimit = positive(options.screenshotByteLimit, 48 * 1024 * 1024)
    this.screenshotMaxBytes = positive(options.screenshotMaxBytes, 8 * 1024 * 1024)
    this.newScreenshotId = options.newScreenshotId ?? (() => `shot-${randomBytes(12).toString('hex')}`)
    /** @type {Map<string, {meta: Record<string, any>, data: Buffer}>} */
    this.screenshots = new Map()
    this.screenshotBytes = 0
    /** @type {Record<string, any> | null} */
    this.latestScreenshot = null
    /**
     * The open "agent needs the user" request, while the turn status is
     * `waiting_for_user`. Cleared by the next prompt or a session change.
     * @type {null | {turnId: string, category: string, reason: string, screenshotId: string | null, captureError: string | null, requestedAt: string}}
     */
    this.help = null
    /** @type {null | {turnId: string | null, screenshotId: string}} the capture made for a help request */
    this.helpShot = null
    /**
     * The open irreversible-action confirmation, while the turn status is
     * `waiting_for_user`. Cleared by the next prompt or a session change.
     * @type {null | {turnId: string, action: string, target: string, screenshotId: string | null, captureError: string | null, requestedAt: string}}
     */
    this.confirm = null
    /** @type {null | {turnId: string | null, screenshotId: string}} the capture made for a confirmation request */
    this.confirmShot = null
  }

  get activeTurnId() {
    return this.turn.status === 'running' || this.turn.status === 'stopping' ? this.turn.turnId : null
  }

  /**
   * Append one canonical event to the journal and notify live subscribers.
   * @param {string} type
   * @param {Record<string, any>} body
   * @param {{turnId?: string | null}} [options]
   * @returns {RemoteEnvelope}
   */
  publish(type, body, options = {}) {
    this.seq += 1
    const turnId = options.turnId === undefined ? this.activeTurnId : options.turnId
    /** @type {RemoteEnvelope} */
    const envelope = {
      v: REMOTE_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      seq: this.seq,
      type,
      sessionId: this.sessionId,
      ...(typeof turnId === 'string' ? { turnId } : {}),
      occurredAt: new Date(this.now()).toISOString(),
      body,
    }
    const size = Buffer.byteLength(JSON.stringify(envelope))
    this.journal.push(envelope)
    this.journalSizes.push(size)
    this.journalBytes += size
    while (this.journal.length > 1 && (this.journal.length > this.journalLimit || this.journalBytes > this.journalByteLimit)) {
      this.journal.shift()
      this.journalBytes -= this.journalSizes.shift() ?? 0
    }
    if (COMMITTED_TYPES.has(type)) {
      this.messages.push(envelope)
      if (this.messages.length > this.messageLimit) this.messages.splice(0, this.messages.length - this.messageLimit)
      this.history.ingest(envelope)
    }
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(envelope)
      } catch {
        // A broken subscriber must not affect the companion or other clients.
      }
    }
    return envelope
  }

  /**
   * Normalize one allowlisted companion → side-panel chat frame. Anything else
   * (browser.command, llm.*, log.*, hello) is ignored.
   * @param {Record<string, any>} frame
   */
  ingest(frame) {
    if (!isRecord(frame) || typeof frame.type !== 'string' || !INGESTED_TYPES.has(frame.type)) return
    switch (frame.type) {
      case 'chat.status':
        this.#onStatus(frame)
        return
      case 'chat.activity':
        this.#onActivity(frame)
        return
      case 'chat.assistant': {
        const text = clip(frame.text, MAX_TEXT_CHARS)
        if (text.length === 0) return
        const replaces = this.#takeDraft()
        this.publish('chat.assistant', { text, ...(replaces ? { replacesStreamId: replaces } : {}) })
        return
      }
      case 'chat.tool_call': {
        const replaces = this.#takeDraft()
        this.publish('chat.tool_call', {
          callId: stringOrNull(frame.callId),
          name: stringOrNull(frame.name),
          args: clip(typeof frame.args === 'string' ? frame.args : safeJson(frame.args), MAX_TOOL_ARGS_CHARS),
          ...(replaces ? { replacesStreamId: replaces } : {}),
        })
        return
      }
      case 'chat.tool_result':
        this.publish('chat.tool_result', {
          callId: stringOrNull(frame.callId),
          ok: frame.ok === true,
          text: clip(frame.text, MAX_TEXT_CHARS),
        })
        return
      case 'chat.done': {
        const replaces = this.#takeDraft()
        this.publish('chat.done', {
          text: clip(frame.text, MAX_TEXT_CHARS),
          timings: isRecord(frame.timings) ? frame.timings : null,
          usage: usageOf(frame.usage),
          label: reportedLabel(frame.label),
          model: stringOrNull(frame.model),
          docsVerification: stringOrNull(frame.docsVerification),
          docsVerificationReason: stringOrNull(frame.docsVerificationReason),
          planMode: frame.planMode === true,
          planOutcome: stringOrNull(frame.planOutcome),
          planRevision: Number.isSafeInteger(frame.planRevision) ? frame.planRevision : null,
          ...(isRecord(frame.help) && typeof frame.help.reason === 'string' && typeof frame.help.category === 'string'
            ? { help: { category: frame.help.category, reason: clip(frame.help.reason, 500) } }
            : {}),
          ...(isRecord(frame.confirm) && typeof frame.confirm.action === 'string' && typeof frame.confirm.target === 'string'
            ? { confirm: { action: clip(frame.confirm.action, 200), target: clip(frame.confirm.target, 200) } }
            : {}),
          ...(replaces ? { replacesStreamId: replaces } : {}),
        })
        if (typeof frame.sessionId === 'string') this.sessionId = frame.sessionId
        return
      }
      case 'chat.stopping':
        if (this.turn.status === 'running') this.turn.status = 'stopping'
        this.publish('chat.stopping', { message: stringOrNull(frame.message) })
        return
      case 'chat.stopped':
        // An idle stop is a reply to one client, not a lifecycle event.
        if (frame.reason === 'idle') return
        this.#takeDraft()
        this.publish('chat.stopped', {
          reason: stringOrNull(frame.reason),
          message: stringOrNull(frame.message),
          timings: isRecord(frame.timings) ? frame.timings : null,
          usage: usageOf(frame.usage),
        })
        return
      case 'chat.error': {
        const replaces = this.#takeDraft()
        this.publish('chat.error', {
          message: clip(frame.message, 4_000),
          recoverable: frame.recoverable === true,
          ...(replaces ? { replacesStreamId: replaces } : {}),
        })
        return
      }
      case 'chat.session':
        if (typeof frame.sessionId !== 'string') return
        if (frame.resumed === true) this.restoreSession(frame.sessionId)
        else this.setSession(frame.sessionId)
        return
      default:
    }
  }

  /**
   * A new DSH session replaces the committed conversation projection.
   * @param {string} sessionId
   */
  setSession(sessionId) {
    if (this.sessionId === sessionId) return
    this.sessionId = sessionId
    this.messages = []
    this.#resetSessionState()
    this.publish('chat.session', { sessionId }, { turnId: null })
  }

  /**
   * A saved chat became the live session again: the committed projection is
   * rebuilt from the saved transcript so clients see the conversation they are
   * continuing. `restoredMessages` tells a client to resync for them.
   * @param {string} sessionId
   */
  restoreSession(sessionId) {
    this.sessionId = sessionId
    this.messages = (this.history.transcript(sessionId)?.messages ?? []).slice(-this.messageLimit)
    this.#resetSessionState()
    this.publish('chat.session', { sessionId, resumed: true, restoredMessages: this.messages.length }, { turnId: null })
  }

  /** Per-session state that must not leak into another chat. */
  #resetSessionState() {
    this.draft = null
    this.contextTokens = null
    this.screenshots.clear()
    this.screenshotBytes = 0
    this.latestScreenshot = null
    this.help = null
    this.helpShot = null
    this.confirm = null
    this.confirmShot = null
    // A help request belonged to the chat that was just left.
    if (this.turn.status === 'waiting_for_user') this.turn = { ...this.turn, status: 'idle' }
  }

  /**
   * Mirror one image the agent already captured (an auto view or a tool
   * result). Only metadata is published; the bytes stay in a bounded
   * in-memory store behind an opaque ID. Returns the metadata, or null when
   * the image is not a usable screenshot.
   * @param {{data: unknown, mimeType: unknown, width?: unknown, height?: unknown, turnId?: unknown, callId?: unknown, source?: unknown}} input
   */
  addScreenshot(input) {
    if (!isRecord(input) || typeof input.data !== 'string' || input.data.length === 0) return null
    if (typeof input.mimeType !== 'string' || !SCREENSHOT_MIME_TYPES.has(input.mimeType)) return null
    // Reject before decoding: base64 is 4 characters per 3 bytes.
    if (input.data.length > Math.ceil(this.screenshotMaxBytes / 3) * 4 + 4) return null
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data)) return null
    const data = Buffer.from(input.data, 'base64')
    if (data.length === 0 || data.length > this.screenshotMaxBytes) return null
    const size = imageSize(data, input.mimeType)
    const width = size?.width ?? dimension(input.width)
    const height = size?.height ?? dimension(input.height)
    const turnId = typeof input.turnId === 'string' ? input.turnId : this.activeTurnId
    const meta = {
      screenshotId: this.newScreenshotId(),
      callId: stringOrNull(input.callId),
      capturedAt: new Date(this.now()).toISOString(),
      width,
      height,
      mimeType: input.mimeType,
      bytes: data.length,
      source: SCREENSHOT_SOURCES.has(input.source) ? input.source : 'tool',
    }
    this.screenshots.set(meta.screenshotId, { meta, data })
    this.screenshotBytes += data.length
    while (this.screenshots.size > 1 && (this.screenshots.size > this.screenshotLimit || this.screenshotBytes > this.screenshotByteLimit)) {
      const [oldest, entry] = this.screenshots.entries().next().value
      this.screenshots.delete(oldest)
      this.screenshotBytes -= entry.data.length
    }
    this.latestScreenshot = meta
    if (meta.source === 'help') this.helpShot = { turnId: turnId ?? null, screenshotId: meta.screenshotId }
    if (meta.source === 'confirm') this.confirmShot = { turnId: turnId ?? null, screenshotId: meta.screenshotId }
    this.publish('remote.screenshot', { ...meta }, { turnId: turnId ?? null })
    return meta
  }

  /**
   * Bytes for one mirrored screenshot, by opaque ID only.
   * @param {string} id
   * @returns {{data: Buffer, mimeType: string} | undefined}
   */
  screenshot(id) {
    const entry = this.screenshots.get(id)
    return entry === undefined ? undefined : { data: entry.data, mimeType: entry.meta.mimeType }
  }

  /**
   * Record the start of one reserved turn and its user prompt.
   * @param {{turnId: string, origin: string, clientMessageId?: string | null, text: string, imageCount?: number, sessionId?: string | null}} info
   */
  turnStarted(info) {
    if (typeof info.sessionId === 'string' && this.sessionId !== info.sessionId) {
      if (this.sessionId === null) this.sessionId = info.sessionId
      else this.setSession(info.sessionId)
    }
    this.turn = {
      status: 'running',
      turnId: info.turnId,
      origin: info.origin,
      clientMessageId: info.clientMessageId ?? null,
      startedAt: new Date(this.now()).toISOString(),
      endedAt: null,
      outcome: null,
      error: null,
      label: null,
      usage: null,
      failedCalls: null,
    }
    this.phase = { status: null, tool: null }
    this.draft = null
    // Any prompt answers an open help request; the same session continues.
    this.help = null
    this.helpShot = null
    // Any prompt also answers (or abandons) an open confirmation.
    this.confirm = null
    this.confirmShot = null
    this.publish('chat.user', {
      text: clip(info.text, MAX_TEXT_CHARS),
      origin: info.origin,
      clientMessageId: info.clientMessageId ?? null,
      imageCount: Number.isInteger(info.imageCount) ? info.imageCount : 0,
    }, { turnId: info.turnId })
  }

  /**
   * Record the end of the reserved turn from its actual lifecycle outcome.
   * A finished turn that carries a help or confirmation request ends in
   * `waiting_for_user`.
   * @param {{turnId: string, outcome: 'done' | 'stopped' | 'error', error?: string, sessionId?: string | null, help?: {category: string, reason: string, captureError?: string | null}, confirm?: {action: string, target: string, captureError?: string | null}}} info
   */
  turnEnded(info) {
    if (this.turn.turnId !== info.turnId) return
    if (typeof info.sessionId === 'string') this.sessionId = info.sessionId
    this.draft = null
    const help = info.outcome === 'done' && isRecord(info.help) && typeof info.help.reason === 'string' && typeof info.help.category === 'string'
      ? info.help
      : null
    if (help !== null) {
      const shot = this.helpShot !== null && this.helpShot.turnId === info.turnId && this.screenshots.has(this.helpShot.screenshotId)
        ? this.helpShot.screenshotId
        : null
      this.help = {
        turnId: info.turnId,
        category: help.category,
        reason: clip(help.reason, 500),
        screenshotId: shot,
        // Missing evidence is reported as such, never as a fabricated image.
        captureError: shot === null ? clip(help.captureError ?? 'No screenshot was captured.', 500) : null,
        requestedAt: new Date(this.now()).toISOString(),
      }
      this.publish('remote.help', { ...this.help }, { turnId: info.turnId })
    }
    this.helpShot = null
    const confirm = info.outcome === 'done' && help === null && isRecord(info.confirm) && typeof info.confirm.action === 'string' && typeof info.confirm.target === 'string'
      ? info.confirm
      : null
    if (confirm !== null) {
      const shot = this.confirmShot !== null && this.confirmShot.turnId === info.turnId && this.screenshots.has(this.confirmShot.screenshotId)
        ? this.confirmShot.screenshotId
        : null
      this.confirm = {
        turnId: info.turnId,
        action: clip(confirm.action, 200),
        target: clip(confirm.target, 200),
        screenshotId: shot,
        captureError: shot === null ? clip(confirm.captureError ?? 'No screenshot was captured.', 500) : null,
        requestedAt: new Date(this.now()).toISOString(),
      }
      this.publish('remote.confirm', { ...this.confirm }, { turnId: info.turnId })
    }
    this.confirmShot = null
    const failedCalls = Number(info.timings?.failedCalls)
    this.turn = {
      ...this.turn,
      status: info.outcome === 'error' ? 'error' : help !== null || confirm !== null ? 'waiting_for_user' : 'idle',
      endedAt: new Date(this.now()).toISOString(),
      outcome: info.outcome,
      error: info.outcome === 'error' ? clip(info.error, 4_000) : null,
      // Model-reported completion word, per-turn cost, and the failed-call
      // count; diagnostic evidence, never independent verification.
      label: reportedLabel(info.label),
      usage: usageOf(info.usage),
      failedCalls: Number.isFinite(failedCalls) && failedCalls >= 0 ? failedCalls : null,
    }
    this.phase = { status: null, tool: null }
    this.publish('chat.turn', { ...this.turnProjection() }, { turnId: info.turnId })
  }

  /** Re-read health and publish remote.health only when it changed. */
  updateHealth() {
    const health = this.#health()
    const json = JSON.stringify(health)
    const changed = json !== this.lastHealthJson
    if (changed) {
      this.lastHealthJson = json
      this.publish('remote.health', health, { turnId: null })
    }
    this.#syncIdleStatus(health)
    return changed
  }

  turnProjection() {
    return { ...this.turn }
  }

  draftProjection() {
    if (this.draft === null) return null
    const tools = []
    for (const [id, tool] of this.draft.tools) tools.push({ id, name: tool.name, args: tool.args })
    if (this.draft.text.length === 0 && this.draft.reasoning.length === 0 && tools.length === 0) return null
    return {
      turnId: this.draft.turnId,
      streamId: this.draft.streamId,
      text: this.draft.text,
      reasoning: this.draft.reasoning,
      tools,
    }
  }

  sessionSummaries() {
    const running = this.activeTurnId !== null
    return this.history.summaries().map(summary => ({
      ...summary,
      current: summary.sessionId === this.sessionId,
      running: summary.sessionId === this.sessionId && running,
    }))
  }

  transcript(sessionId) {
    return this.history.transcript(sessionId)
  }

  /** Full authoritative projection used by GET /state and remote.resync. */
  projection() {
    const health = this.#health()
    return {
      protocol: REMOTE_PROTOCOL_VERSION,
      server: { name: 'crazyagent-companion', version: this.serverVersion },
      instanceId: this.instanceId,
      sessionId: this.sessionId,
      latestSequence: this.seq,
      oldestSequence: this.journal[0]?.seq ?? null,
      turn: this.turnProjection(),
      phase: { ...this.phase },
      health,
      messages: this.messages.map(message => ({ ...message })),
      draft: this.draftProjection(),
      latestScreenshotId: this.latestScreenshot?.screenshotId ?? null,
      latestScreenshot: this.latestScreenshot === null ? null : { ...this.latestScreenshot },
      help: this.help === null ? null : { ...this.help },
      confirm: this.confirm === null ? null : { ...this.confirm },
    }
  }

  /**
   * Decide how a reconnecting client catches up.
   * @param {{after?: unknown, instance?: unknown}} cursor
   * @returns {{mode: 'replay', events: RemoteEnvelope[]} | {mode: 'resync', reason: string}}
   */
  catchUp(cursor) {
    if (typeof cursor.instance !== 'string' || cursor.instance !== this.instanceId) {
      return { mode: 'resync', reason: cursor.instance === undefined || cursor.instance === null || cursor.instance === '' ? 'no-instance' : 'instance-changed' }
    }
    const after = typeof cursor.after === 'number' ? cursor.after : Number(cursor.after)
    if (!Number.isSafeInteger(after) || after < 0 || after > this.seq) return { mode: 'resync', reason: 'unknown-sequence' }
    if (after === this.seq) return { mode: 'replay', events: [] }
    const oldest = this.journal[0]?.seq
    if (oldest === undefined || after < oldest - 1) return { mode: 'resync', reason: 'expired-sequence' }
    return { mode: 'replay', events: this.journal.filter(envelope => envelope.seq > after) }
  }

  /** Unsequenced full-state frame; `seq` is the sequence it is current at. */
  resyncFrame(reason) {
    return {
      v: REMOTE_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      seq: this.seq,
      type: 'remote.resync',
      sessionId: this.sessionId,
      occurredAt: new Date(this.now()).toISOString(),
      body: { reason, state: this.projection() },
    }
  }

  /** @param {(envelope: RemoteEnvelope) => void} subscriber */
  subscribe(subscriber) {
    this.subscribers.add(subscriber)
    return () => { this.subscribers.delete(subscriber) }
  }

  /**
   * Look up a remembered command outcome. Returns `{conflict:true}` when the
   * same ID was used for a different command or payload.
   * @param {string} kind
   * @param {string} id
   * @param {string} fingerprint
   */
  lookupCommand(kind, id, fingerprint) {
    this.#pruneCommands()
    const entry = this.commands.get(id)
    if (entry === undefined) return undefined
    if (entry.kind !== kind || entry.fingerprint !== fingerprint) return { conflict: true }
    return { conflict: false, outcome: entry.outcome }
  }

  /** @param {string} kind @param {string} id @param {string} fingerprint @param {any} outcome */
  rememberCommand(kind, id, fingerprint, outcome) {
    this.commands.delete(id)
    this.commands.set(id, { kind, fingerprint, outcome, at: this.now() })
    this.#pruneCommands()
  }

  close() {
    this.subscribers.clear()
    this.history.close()
  }

  #pruneCommands() {
    const cutoff = this.now() - this.commandTtlMs
    for (const [id, entry] of this.commands) {
      if (entry.at >= cutoff && this.commands.size <= this.commandLimit) break
      this.commands.delete(id)
    }
  }

  #health() {
    let health
    try {
      health = this.getHealth()
    } catch {
      health = {}
    }
    const source = isRecord(health) ? health : {}
    const contextWindow = Number(source.contextWindow)
    return {
      ...source,
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? Math.round(contextWindow) : null,
      contextTokens: this.contextTokens,
    }
  }

  /**
   * Outside a turn, the remote turn status follows runtime readiness and the
   * last turn outcome; side-panel status frames are not the source because
   * they are only sent while a panel is connected.
   * @param {Record<string, any>} health
   */
  #syncIdleStatus(health) {
    if (this.activeTurnId !== null || this.turn.status === 'waiting_for_user') return
    const dsh = health.dsh
    const next = dsh === 'ready'
      ? (this.turn.outcome === 'error' ? 'error' : 'idle')
      : dsh === 'starting' || dsh === undefined ? 'starting' : 'error'
    if (next === this.turn.status) return
    this.turn = { ...this.turn, status: next }
    this.publish('chat.status', { status: null, tool: null, turnStatus: next }, { turnId: null })
  }

  /** @param {Record<string, any>} frame */
  #onStatus(frame) {
    // Activity phase only; idle-time status is derived from health.
    if (this.activeTurnId === null) return
    const status = typeof frame.status === 'string' ? frame.status : null
    const tool = typeof frame.tool === 'string' ? frame.tool : null
    if (status === this.phase.status && tool === this.phase.tool) return
    this.phase = { status, tool }
    this.publish('chat.status', { status, tool, turnStatus: this.turn.status })
  }

  /** @param {Record<string, any>} frame */
  #onActivity(frame) {
    const turnId = this.activeTurnId
    if (turnId === null) return
    const kind = frame.kind
    if (kind === 'model-start') {
      this.#takeDraft()
      this.step += 1
      return
    }
    if (kind === 'usage') {
      const usage = isRecord(frame.usage) ? frame.usage : {}
      const tokens = Number(usage.totalTokens ?? usage.inputTokens)
      if (!Number.isFinite(tokens) || tokens < 0) return
      const used = Math.round(tokens)
      if (used === this.contextTokens) return
      this.contextTokens = used
      this.updateHealth()
      return
    }
    if (kind !== 'text' && kind !== 'reasoning' && kind !== 'tool-call-delta') return
    if (this.draft === null || this.draft.turnId !== turnId) {
      if (this.draft !== null) this.step += 1
      this.draft = { turnId, streamId: `${turnId}:s${this.step}`, text: '', reasoning: '', tools: new Map() }
    }
    const draft = this.draft
    if (kind === 'text' || kind === 'reasoning') {
      if (typeof frame.text !== 'string' || frame.text.length === 0) return
      const current = draft[kind]
      if (current.length >= MAX_TEXT_CHARS) return
      const delta = frame.text.slice(0, MAX_TEXT_CHARS - current.length)
      draft[kind] = current + delta
      this.publish('chat.draft', { streamId: draft.streamId, channel: kind, offset: current.length, delta })
      return
    }
    const id = typeof frame.id === 'string' ? frame.id : 'tool'
    const delta = typeof frame.argumentsDelta === 'string' ? frame.argumentsDelta : ''
    const tool = draft.tools.get(id) ?? { name: typeof frame.name === 'string' ? frame.name : null, args: '' }
    if (tool.name === null && typeof frame.name === 'string') tool.name = frame.name
    const offset = tool.args.length
    const clipped = delta.slice(0, Math.max(0, MAX_TOOL_ARGS_CHARS - offset))
    tool.args += clipped
    draft.tools.set(id, tool)
    this.publish('chat.draft', { streamId: draft.streamId, channel: 'tool', toolCallId: id, name: tool.name, offset, delta: clipped })
  }

  /** Drop the current draft (replaced by a committed event); return its stream ID. */
  #takeDraft() {
    const streamId = this.draft?.streamId
    if (this.draft !== null) this.step += 1
    this.draft = null
    return streamId
  }
}

/**
 * Stable fingerprint for idempotency comparison of a command payload.
 * @param {unknown} value
 */
export function fingerprint(value) {
  return createHash('sha256').update(safeJson(value)).digest('hex')
}

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/** @param {unknown} value */
const REPORTED_TURN_LABELS = new Set(['done', 'partial', 'blocked'])

/** @param {unknown} value */
function reportedLabel(value) {
  return typeof value === 'string' && REPORTED_TURN_LABELS.has(value) ? value : null
}

/**
 * Keep only finite, non-negative token counters. Anything else is null rather
 * than a fabricated number.
 * @param {unknown} value
 */
function usageOf(value) {
  if (!isRecord(value)) return null
  /** @type {Record<string, number>} */
  const totals = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens']) {
    const number = Number(value[key])
    if (Number.isFinite(number) && number >= 0) totals[key] = Math.round(number)
  }
  return Object.keys(totals).length > 0 ? totals : null
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null
}

/** @param {unknown} value */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** @param {unknown} value */
function dimension(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000 ? value : null
}

/**
 * Pixel size read from the image header, so the phone can lay the view out
 * before the bytes arrive. Returns null for anything it does not recognize.
 * @param {Buffer} data @param {string} mimeType
 * @returns {{width: number, height: number} | null}
 */
function imageSize(data, mimeType) {
  let width = null
  let height = null
  if (mimeType === 'image/png' && data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) {
    width = data.readUInt32BE(16)
    height = data.readUInt32BE(20)
  } else if (mimeType === 'image/jpeg' && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) break
      const marker = data[offset + 1]
      if (marker === 0xff) {
        offset += 1
        continue
      }
      const length = data.readUInt16BE(offset + 2)
      // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = data.readUInt16BE(offset + 5)
        width = data.readUInt16BE(offset + 7)
        break
      }
      if (length < 2) break
      offset += 2 + length
    }
  } else if (mimeType === 'image/webp' && data.length >= 30 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = data.toString('latin1', 12, 16)
    if (chunk === 'VP8X') {
      width = 1 + data.readUIntLE(24, 3)
      height = 1 + data.readUIntLE(27, 3)
    } else if (chunk === 'VP8 ') {
      width = data.readUInt16LE(26) & 0x3fff
      height = data.readUInt16LE(28) & 0x3fff
    } else if (chunk === 'VP8L') {
      const bits = data.readUInt32LE(21)
      width = 1 + (bits & 0x3fff)
      height = 1 + ((bits >> 14) & 0x3fff)
    }
  }
  return dimension(width) !== null && dimension(height) !== null ? { width, height } : null
}

/** @param {unknown} value @param {number} fallback */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
