/**
 * Unified debug log for one companion run.
 *
 * Writes a full JSONL event stream (bridge frames, extension logs, plugin
 * timings, DSH notifications, tool calls, turns), saves screenshots separately,
 * and builds a summary plus a ZIP bundle for sharing during development.
 *
 * Redaction is applied to every event before it is written: pairing tokens,
 * API-key-shaped strings, authorization headers, secret-named fields, and
 * inline image/base64 payloads never enter events.jsonl. Screenshots are stored
 * as separate files and are included only when the exporter chooses to.
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

const SENSITIVE_KEY = /(?:^|_)(?:token|api[-_]?key|secret|password|passwd|authorization|cookie|credential|private[-_]?key|access[-_]?token|refresh[-_]?token)(?:$|_)/iu
const SENSITIVE_QUERY = /([?&](?:token|key|api_key|apikey|secret|password|passwd|auth|authorization|code|session|sig|signature)=)[^&#\s]+/giu
const API_KEY_SHAPE = /(sk-[A-Za-z0-9_-]{16,})/gu
const BEARER_SHAPE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu

function isoNow() {
  return new Date().toISOString()
}

function truncate(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`
}

function safeName(value, fallback = 'x') {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 48)
  return text.length > 0 ? text : fallback
}

function eventMessage(data) {
  if (!data || typeof data !== 'object') return String(data ?? '').slice(0, 300)
  if (typeof data.message === 'string') return data.message.slice(0, 300)
  if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') return data.error.message.slice(0, 300)
  if (typeof data.error === 'string') return data.error.slice(0, 300)
  if (typeof data.type === 'string') return data.type
  try {
    return JSON.stringify(data).slice(0, 300)
  } catch {
    return '[unserializable]'
  }
}

/** @param {string} text @param {string} secret */
function redactString(text, secret) {
  let value = String(text)
  if (secret.length > 0) value = value.split(secret).join('[redacted-token]')
  value = value.replace(API_KEY_SHAPE, '[redacted-key]')
  value = value.replace(BEARER_SHAPE, '$1[redacted]')
  value = value.replace(SENSITIVE_QUERY, '$1[redacted]')
  return value
}

/**
 * Deep-sanitize an arbitrary JSON-ish value for logging.
 * @param {unknown} value
 * @param {string} secret
 * @param {number} [depth]
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
function sanitize(value, secret, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(truncate(value, 20_000), secret)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return '[function]'
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  if (depth > 8) return '[max-depth]'
  seen.add(value)

  if (value instanceof Error) {
    return sanitize({ name: value.name, message: value.message, stack: value.stack }, secret, depth + 1, seen)
  }
  if (Array.isArray(value)) {
    const cap = 100
    const out = value.slice(0, cap).map(item => sanitize(item, secret, depth + 1, seen))
    if (value.length > cap) out.push(`[truncated ${value.length - cap} items]`)
    return out
  }

  const record = /** @type {Record<string, unknown>} */ (value)
  // An image/base64 payload is never written into JSONL; the caller stores it
  // as a screenshot file and keeps only metadata here.
  if (typeof record.mimeType === 'string' && typeof record.data === 'string' && record.data.length > 256) {
    return {
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
      bytes: Math.floor((record.data.length * 3) / 4),
      omitted: 'inline-image-data',
    }
  }

  const out = {}
  for (const [key, entry] of Object.entries(record)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[redacted]'
      continue
    }
    if (key === 'base64' && typeof entry === 'string') {
      out[key] = `[base64 omitted: ${entry.length} chars]`
      continue
    }
    out[key] = sanitize(entry, secret, depth + 1, seen)
  }
  return out
}

/** @param {string} type @param {string} source */
function severityFor(type, source) {
  if (/error|failed|failure/iu.test(type)) return 'error'
  if (/warn|disconnect|timeout|quota|protected|paused|cancel/iu.test(type)) return 'warn'
  if (/start|end|ready|result|call|export|connected/iu.test(type)) return 'info'
  return 'debug'
}

export class LogStore {
  /**
   * @param {{
   *   root: string,
   *   runId: string,
   *   secret?: string,
   *   meta?: Record<string, unknown>,
   *   maxInlineBytes?: number,
   * }} options
   */
  constructor(options) {
    this.root = options.root
    this.runId = options.runId
    this.secret = options.secret ?? ''
    this.meta = options.meta ?? {}
    this.maxInlineBytes = options.maxInlineBytes ?? 12 * 1024 * 1024
    this.dir = join(this.root, this.runId)
    this.eventsPath = join(this.dir, 'events.jsonl')
    this.screenshotsDir = join(this.dir, 'screenshots')
    this.exportsDir = join(this.dir, 'exports')
    this.startedAt = isoNow()
    this.lastEventAt = this.startedAt
    this.seq = 0
    this.buffer = []
    this.flushTimer = null
    this.flushChain = Promise.resolve()
    this.closed = false
    this.eventBytes = 0
    this.counts = { events: 0, screenshots: 0, warnings: 0, errors: 0, signals: 0 }
    /** @type {Map<string, number>} */
    this.eventTypes = new Map()
    /** @type {Array<Record<string, unknown>>} */
    this.signals = []
    /** @type {Map<string, any>} */
    this.turns = new Map()
    /** @type {string[]} */
    this.turnOrder = []
    /** @type {Array<{name: string, bytes: number, mimeType: string}>} */
    this.screenshotFiles = []
    this.context = {}
    this.sessionId = undefined
    this.currentTurnId = undefined
  }

  async init() {
    await mkdir(this.dir, { recursive: true })
    await mkdir(this.screenshotsDir, { recursive: true })
    await mkdir(this.exportsDir, { recursive: true })
    await this.record('companion', 'run.start', {
      companionVersion: this.meta.companionVersion,
      provider: this.meta.provider,
      model: this.meta.model,
      reasoningEffort: this.meta.reasoningEffort,
      maxTokens: this.meta.maxTokens,
      bridgeUrl: this.meta.bridgeUrl,
      dshHome: this.meta.dshHome,
      workspace: this.meta.workspace,
      patchFile: this.meta.patchFile,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }, { severity: 'info' })
    await this.flush()
  }

  get path() {
    return this.dir
  }

  #sanitize(value) {
    return sanitize(value, this.secret)
  }

  /**
   * Append one structured event.
   * @param {string} source
   * @param {string} type
   * @param {unknown} data
   * @param {{turnId?: string, sessionId?: string, callId?: string, commandId?: string, role?: string, severity?: 'debug'|'info'|'warn'|'error', clientTime?: number, signalCode?: string, noSignal?: boolean}} [meta]
   */
  record(source, type, data, meta = {}) {
    if (this.closed) return
    const severity = meta.severity ?? severityFor(type, source)
    const event = {
      v: 1,
      seq: this.seq + 1,
      time: isoNow(),
      runId: this.runId,
      ...(meta.turnId ? { turnId: meta.turnId } : {}),
      ...(meta.sessionId ? { sessionId: meta.sessionId } : this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(meta.callId ? { callId: meta.callId } : {}),
      ...(meta.commandId ? { commandId: meta.commandId } : {}),
      ...(meta.role ? { role: meta.role } : {}),
      source,
      type,
      severity,
      ...(meta.clientTime !== undefined ? { clientTime: meta.clientTime } : {}),
      data: this.#sanitize(data ?? null),
    }
    this.seq += 1
    let line
    try {
      line = JSON.stringify(event)
    } catch {
      line = JSON.stringify({ ...event, data: '[unserializable]' })
    }
    this.buffer.push(line)
    this.counts.events += 1
    this.eventBytes += Buffer.byteLength(line) + 1
    this.lastEventAt = event.time
    const typeKey = `${source}:${type}`
    this.eventTypes.set(typeKey, (this.eventTypes.get(typeKey) ?? 0) + 1)

    if (severity === 'warn' || severity === 'error') {
      if (severity === 'warn') this.counts.warnings += 1
      else this.counts.errors += 1
      if (!meta.noSignal) {
        this.#pushSignal(meta.signalCode ?? type, eventMessage(event.data), severity, {
          turnId: meta.turnId ?? this.currentTurnId,
          callId: meta.callId,
        })
      }
    }
    this.#scheduleFlush()
  }

  /**
   * Add a signal without necessarily recording a duplicate event.
   * @param {string} code
   * @param {string} message
   * @param {'info'|'warn'|'error'} severity
   * @param {{turnId?: string, callId?: string}} [meta]
   */
  signal(code, message, severity = 'warn', meta = {}) {
    this.#pushSignal(code, message, severity, meta)
    this.record('companion', 'signal', { code, message, severity }, {
      severity: 'debug',
      noSignal: true,
      turnId: meta.turnId,
      callId: meta.callId,
    })
  }

  #pushSignal(code, message, severity, meta = {}) {
    this.counts.signals += 1
    this.signals.push({
      time: isoNow(),
      severity,
      code: truncate(code, 120),
      message: truncate(message, 500),
      turnId: meta.turnId ?? this.currentTurnId,
      callId: meta.callId,
    })
    if (this.signals.length > 200) this.signals.splice(0, this.signals.length - 200)
  }

  /**
   * Record a bridge/log event. This is the intake for frames, client events,
   * screenshots, and plugin timings.
   * @param {{direction: 'in'|'out'|'event', role?: string, frame: Record<string, any>}} entry
   */
  recordBridge(entry) {
    const frame = entry.frame
    if (!frame || typeof frame !== 'object') return

    if (frame.type === 'log.event' && frame.event && typeof frame.event === 'object') {
      const event = frame.event
      if (event.type === 'app.context') {
        this.updateContext(event.data)
        return
      }
      this.record(
        typeof event.source === 'string' ? event.source : entry.role ?? 'client',
        String(event.type ?? 'client.event'),
        event.data ?? null,
        {
          severity: event.severity === 'warn' || event.severity === 'error'
            ? event.severity
            : event.severity === 'info' ? 'info' : 'debug',
          turnId: typeof event.turnId === 'string' ? event.turnId : this.currentTurnId,
          callId: typeof event.callId === 'string' ? event.callId : undefined,
          commandId: typeof event.commandId === 'string' ? event.commandId : undefined,
          role: entry.role,
          clientTime: typeof event.time === 'number' ? event.time : undefined,
        },
      )
      return
    }

    if (frame.type === 'browser.result') {
      const turnId = typeof frame.turnId === 'string' ? frame.turnId : this.currentTurnId
      const callId = typeof frame.callId === 'string' ? frame.callId : undefined
      const result = frame.result && typeof frame.result === 'object' ? frame.result : undefined
      // Save bytes only from the side panel's actual capture. The same result is
      // also forwarded to the provider; logging that outbound frame must not
      // create a second copy of the screenshot.
      const isCapture = entry.direction === 'in' && entry.role === 'ui'
      let screenshot
      let loggedResult = result
      if (result?.image?.data) {
        if (isCapture) {
          screenshot = this.#saveScreenshot(result.image, { turnId, callId, op: result.op })
          const image = { ...result.image, data: undefined, screenshot: screenshot?.path }
          delete image.data
          loggedResult = { ...result, image }
        } else {
          const image = { ...result.image, data: undefined, omitted: 'forwarded-image-data' }
          delete image.data
          loggedResult = { ...result, image }
        }
      }
      const data = {
        ok: frame.ok !== false,
        callId,
        commandId: frame.id,
        command: frame.command,
        result: loggedResult,
        error: frame.error,
        turnId,
      }
      const ok = frame.ok !== false
      this.record('bridge', 'browser.result', data, {
        turnId,
        callId,
        commandId: typeof frame.id === 'string' ? frame.id : undefined,
        role: entry.role,
        severity: ok ? 'debug' : 'warn',
        signalCode: ok ? undefined : (frame.error?.code ?? 'BROWSER_ERROR'),
      })
      if (isCapture) this.#addBrowserResult(turnId, frame, loggedResult, screenshot)
      if (ok && Number(result?.captureMs) > 500) {
        this.signal('SLOW_CAPTURE', `screenshot capture took ${Math.round(result.captureMs)}ms`, 'info', { turnId, callId })
      }
      if (ok && Number(result?.image?.bytes ?? screenshot?.bytes) > 500_000) {
        this.signal('LARGE_SCREENSHOT', `screenshot ${formatBytes(result.image?.bytes ?? screenshot?.bytes)}`, 'info', { turnId, callId })
      }
      return
    }

    if (frame.type === 'browser.command') {
      const turnId = typeof frame.turnId === 'string' ? frame.turnId : this.currentTurnId
      this.#addBrowserCommand(turnId, frame)
      this.record('bridge', `browser.command.${entry.direction}`, {
        commandId: frame.id,
        callId: frame.callId,
        command: frame.command,
      }, {
        turnId,
        callId: typeof frame.callId === 'string' ? frame.callId : undefined,
        commandId: typeof frame.id === 'string' ? frame.id : undefined,
        role: entry.role,
        severity: 'debug',
      })
      return
    }

    this.record('bridge', `frame.${entry.direction}`, {
      role: entry.role,
      frame,
    }, {
      turnId: frame.turnId ?? this.currentTurnId,
      callId: frame.callId,
      severity: frame.type === 'chat.error' ? 'error' : 'debug',
    })
  }

  /** @param {Record<string, any>} context */
  updateContext(context) {
    if (!context || typeof context !== 'object') return
    this.context = { ...this.context, ...this.#sanitize(context) }
    this.record('extension', 'app.context', context, { severity: 'debug', noSignal: true })
  }

  /**
   * @param {string} turnId
   * @param {string} userText
   * @param {Record<string, unknown>} [meta]
   */
  turnStart(turnId, userText, meta = {}) {
    const turn = this.#ensureTurn(turnId)
    turn.userText = userText
    turn.meta = meta
    turn.startedAt = isoNow()
    this.currentTurnId = turnId
    this.record('companion', 'turn.start', {
      userText,
      ...meta,
    }, { turnId, severity: 'info' })
  }

  /**
   * @param {string} turnId
   * @param {string} text
   */
  assistant(turnId, text) {
    const turn = this.#ensureTurn(turnId)
    turn.assistant.push({ time: isoNow(), text })
    this.record('dsh', 'assistant.text', { text }, { turnId, severity: 'debug' })
  }

  /**
   * @param {string} turnId
   * @param {{callId?: string, name?: string, args?: unknown}} call
   */
  toolCall(turnId, call) {
    const turn = this.#ensureTurn(turnId)
    turn.tools.push({
      callId: call.callId,
      name: call.name,
      args: call.args,
      startedAt: isoNow(),
      durationMs: undefined,
      ok: undefined,
      result: undefined,
    })
    this.record('companion', 'tool.call', call, { turnId, callId: call.callId, severity: 'debug' })
  }

  /**
   * @param {string} turnId
   * @param {{callId?: string, ok?: boolean, text?: string, durationMs?: number}} result
   */
  toolResult(turnId, result) {
    const turn = this.#ensureTurn(turnId)
    let tool = result.callId ? turn.tools.find(item => item.callId === result.callId) : undefined
    if (!tool) {
      tool = { callId: result.callId, name: 'tool', startedAt: isoNow() }
      turn.tools.push(tool)
    }
    tool.ok = result.ok !== false
    tool.result = result.text
    tool.durationMs = result.durationMs
    this.record('companion', 'tool.result', result, {
      turnId,
      callId: result.callId,
      severity: tool.ok ? 'debug' : 'warn',
      noSignal: true,
    })
    if (!tool.ok) {
      this.signal('TOOL_FAILED', `${tool.name ?? 'tool'} failed: ${truncate(result.text ?? '', 200)}`, 'warn', { turnId, callId: result.callId })
    }
    if (Number(result.durationMs) > 5_000) {
      this.signal('SLOW_TOOL', `${tool.name ?? 'tool'} took ${Math.round(result.durationMs)}ms`, 'info', { turnId, callId: result.callId })
    }
  }

  /**
   * @param {string} turnId
   * @param {{ok?: boolean, aborted?: boolean, reason?: string, finalText?: string, timings?: Record<string, unknown>, usage?: Record<string, unknown>, error?: string}} end
   */
  turnEnd(turnId, end = {}) {
    const turn = this.#ensureTurn(turnId)
    const aborted = end.aborted === true
    turn.endedAt = isoNow()
    turn.ok = end.ok !== false && !aborted
    turn.aborted = aborted
    turn.timings = end.timings ?? turn.timings
    turn.usage = end.usage ?? turn.usage
    turn.finalText = end.finalText
    turn.error = end.error
    this.record('companion', 'turn.end', end, {
      turnId,
      severity: turn.ok || aborted ? 'info' : 'error',
      noSignal: true,
    })
    if (aborted) {
      // A user stop is a normal terminal state, not a failure: record it as an
      // informational signal so summaries and triage do not flag it as an error.
      this.signal('TURN_STOPPED', end.reason === 'user' ? 'turn stopped by user' : 'turn stopped', 'info', { turnId })
    } else if (!turn.ok) {
      this.signal('TURN_FAILED', end.error ?? 'turn failed', 'error', { turnId })
    }
    if (Number(end.timings?.totalMs) > 15_000) {
      this.signal('SLOW_TURN', `turn took ${Math.round(end.timings.totalMs)}ms`, 'info', { turnId })
    }
    if (Number(end.timings?.firstEventMs) > 5_000) {
      this.signal('SLOW_FIRST_EVENT', `first DSH event after ${Math.round(end.timings.firstEventMs)}ms`, 'info', { turnId })
    }
    this.currentTurnId = undefined
  }

  /** @param {string} sessionId */
  sessionStart(sessionId) {
    this.sessionId = sessionId
    this.record('companion', 'dsh.session', { sessionId }, { sessionId, severity: 'info' })
  }

  /** @param {string} message @param {Record<string, unknown>} [meta] */
  error(message, meta = {}) {
    this.record('companion', 'error', { message }, {
      severity: 'error',
      signalCode: meta.code ?? 'ERROR',
      turnId: meta.turnId,
      callId: meta.callId,
    })
  }

  /**
   * @param {{method: string, params: Record<string, any>}} notification
   * @param {string} [turnId]
   */
  recordDshNotification(notification, turnId) {
    this.record('dsh', 'notification', {
      method: notification.method,
      params: notification.params,
    }, {
      turnId,
      sessionId: typeof notification.params?.sessionId === 'string' ? notification.params.sessionId : undefined,
      severity: 'debug',
    })
  }

  /** @param {string} turnId */
  #ensureTurn(turnId) {
    let turn = this.turns.get(turnId)
    if (!turn) {
      turn = {
        turnId,
        index: this.turnOrder.length + 1,
        startedAt: isoNow(),
        endedAt: undefined,
        userText: '',
        meta: {},
        assistant: [],
        tools: [],
        browser: [],
        images: [],
        errors: [],
        timings: undefined,
        usage: undefined,
        ok: undefined,
        finalText: undefined,
      }
      this.turns.set(turnId, turn)
      this.turnOrder.push(turnId)
    }
    return turn
  }

  /**
   * @param {string | undefined} turnId
   * @param {Record<string, any>} frame
   */
  #addBrowserCommand(turnId, frame) {
    if (!turnId) return
    const turn = this.#ensureTurn(turnId)
    if (turn.browser.length >= 100) return
    if (turn.browser.some(item => item.commandId === frame.id)) return
    turn.browser.push({
      commandId: frame.id,
      callId: frame.callId,
      op: frame.command?.op,
      args: frame.command?.args,
      startedAt: isoNow(),
    })
  }

  /**
   * @param {string | undefined} turnId
   * @param {Record<string, any>} frame
   * @param {Record<string, any> | undefined} result
   * @param {Record<string, any> | undefined} screenshot
   */
  #addBrowserResult(turnId, frame, result, screenshot) {
    if (!turnId) return
    const turn = this.#ensureTurn(turnId)
    let action = turn.browser.find(item => item.commandId === frame.id)
      ?? turn.browser.find(item => item.callId === frame.callId && item.op === result?.op)
    if (!action) {
      action = { commandId: frame.id, callId: frame.callId, op: result?.op, args: {}, startedAt: isoNow() }
      turn.browser.push(action)
    }
    action.ok = frame.ok !== false
    action.captureMs = result?.captureMs
    action.encodeMs = result?.encodeMs
    action.totalMs = result?.totalMs
    action.tab = result?.tab
    action.viewport = result?.viewport
    action.scroll = result?.scroll
    action.moved = result?.moved
    action.tabsCount = Array.isArray(result?.tabs) ? result.tabs.length : undefined
    action.error = frame.error
    if (screenshot) {
      action.screenshot = screenshot.path
    }
  }

  /**
   * @param {Record<string, any>} image
   * @param {{turnId?: string, callId?: string, op?: string}} meta
   */
  #saveScreenshot(image, meta) {
    if (typeof image?.data !== 'string' || image.data.length === 0) return undefined
    let bytes
    try {
      bytes = Buffer.from(image.data, 'base64')
    } catch {
      return undefined
    }
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) return undefined
    const mimeType = typeof image.mimeType === 'string' ? image.mimeType : 'image/jpeg'
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : mimeType === 'image/gif' ? 'gif' : 'jpg'
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
    const name = `${safeName(meta.turnId ?? 'run')}-${this.seq + 1}-${safeName(meta.op ?? 'snapshot')}-${hash}.${ext}`
    const filePath = join(this.screenshotsDir, name)
    try {
      writeFileSync(filePath, bytes)
    } catch (error) {
      this.signal('SCREENSHOT_SAVE_FAILED', error instanceof Error ? error.message : String(error), 'warn', { turnId: meta.turnId })
      return undefined
    }
    this.screenshotFiles.push({ name, bytes: bytes.length, mimeType })
    this.counts.screenshots += 1
    const ref = {
      path: `screenshots/${name}`,
      bytes: bytes.length,
      mimeType,
      width: image.width,
      height: image.height,
      cssPerImagePixel: image.cssPerImagePixel,
      sha256: hash,
    }
    if (meta.turnId) this.#ensureTurn(meta.turnId).images.push(ref)
    return ref
  }

  #scheduleFlush() {
    if (this.flushTimer !== null || this.closed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 60)
    this.flushTimer.unref?.()
  }

  async flush() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.buffer.length === 0) return this.flushChain
    const chunk = this.buffer.join('\n') + '\n'
    this.buffer = []
    this.flushChain = this.flushChain.then(() => appendFile(this.eventsPath, chunk)).catch(() => {})
    return this.flushChain
  }

  stats() {
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      events: this.counts.events,
      screenshots: this.counts.screenshots,
      warnings: this.counts.warnings,
      errors: this.counts.errors,
      signals: this.counts.signals,
      turns: this.turnOrder.length,
      bytes: this.eventBytes,
      path: this.dir,
      sessionId: this.sessionId,
      context: this.context,
      meta: this.meta,
      recentSignals: this.signals.slice(-12),
      eventTypes: [...this.eventTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    }
  }

  serializeTurns() {
    return this.turnOrder.map(id => this.turns.get(id)).filter(Boolean).map(turn => ({
      turnId: turn.turnId,
      index: turn.index,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      ok: turn.ok,
      userText: turn.userText,
      meta: turn.meta,
      timings: turn.timings,
      usage: turn.usage,
      finalText: turn.finalText,
      error: turn.error,
      images: turn.images,
      tools: turn.tools,
      browser: turn.browser,
      assistant: turn.assistant,
    }))
  }

  summary() {
    const stats = this.stats()
    const lines = []
    lines.push(`# CrazyAgent debug log — ${stats.runId}`)
    lines.push('')
    lines.push(`Generated: ${isoNow()}`)
    lines.push(`Started: ${stats.startedAt}`)
    lines.push(`Events: ${stats.events} · Screenshots: ${stats.screenshots} · Turns: ${stats.turns} · Warnings: ${stats.warnings} · Errors: ${stats.errors}`)
    lines.push('')
    lines.push('## Environment')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify({
      provider: this.meta.provider,
      model: this.meta.model,
      reasoningEffort: this.meta.reasoningEffort,
      maxTokens: this.meta.maxTokens,
      bridgeUrl: this.meta.bridgeUrl,
      dshVersion: this.meta.dshVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sessionId: this.sessionId,
      extension: this.context,
    }, null, 2))
    lines.push('```')
    lines.push('')
    lines.push('## Signals')
    lines.push('')
    if (this.signals.length === 0) {
      lines.push('No warnings or errors detected.')
    } else {
      for (const signal of this.signals.slice(-60)) {
        lines.push(`- **${signal.severity.toUpperCase()}** \`${signal.code}\`${signal.turnId ? ` (${signal.turnId})` : ''}: ${signal.message}`)
      }
    }
    lines.push('')
    lines.push('## Turns')
    if (this.turnOrder.length === 0) {
      lines.push('')
      lines.push('No turns were recorded in this run.')
    }
    for (const turnId of this.turnOrder) {
      const turn = this.turns.get(turnId)
      if (!turn) continue
      lines.push('')
      lines.push(`### Turn ${turn.index} — ${truncate(turn.userText.split('\n')[0] || '(no text)', 120)}`)
      lines.push('')
      lines.push(`- turn: \`${turn.turnId}\``)
      lines.push(`- started: ${turn.startedAt}`)
      if (turn.endedAt) lines.push(`- ended: ${turn.endedAt}`)
      if (turn.timings) lines.push(`- timings: \`${JSON.stringify(turn.timings)}\``)
      if (turn.usage) lines.push(`- usage: \`${JSON.stringify(turn.usage)}\``)
      if (turn.ok === false) lines.push(`- **FAILED**: ${turn.error ?? 'unknown error'}`)
      lines.push('')
      lines.push('**User**')
      lines.push('')
      lines.push('```text')
      lines.push(truncate(turn.userText, 2_000))
      lines.push('```')
      if (turn.browser.length > 0) {
        lines.push('')
        lines.push('**Browser actions**')
        lines.push('')
        for (const action of turn.browser) {
          const bits = [
            `\`${action.op ?? 'op'}\``,
            action.callId ? `call ${action.callId}` : '',
            action.ok === false ? 'FAILED' : action.ok === true ? 'ok' : '',
            Number.isFinite(action.captureMs) ? `capture ${action.captureMs}ms` : '',
            Number.isFinite(action.encodeMs) ? `encode ${action.encodeMs}ms` : '',
            action.scroll ? `scroll ${action.scroll.container ?? 'document'} y=${Math.round(action.scroll.y ?? 0)}/${Math.round(action.scroll.maxY ?? 0)}` : '',
            action.moved ? `moved ${Math.round(action.moved.dx ?? 0)},${Math.round(action.moved.dy ?? 0)}` : '',
            Number.isFinite(action.tabsCount) ? `${action.tabsCount} tabs` : '',
            action.error?.message ? `error: ${action.error.message}` : '',
          ].filter(Boolean)
          lines.push(`- ${bits.join(' · ')}`)
          if (action.screenshot) lines.push(`  - screenshot: [${action.screenshot}](${action.screenshot})`)
        }
      }
      if (turn.tools.length > 0) {
        lines.push('')
        lines.push('**Model tool calls**')
        lines.push('')
        for (const tool of turn.tools) {
          lines.push(`- \`${tool.name ?? 'tool'}\`${tool.callId ? ` (${tool.callId})` : ''}${tool.ok === false ? ' — FAILED' : tool.ok === true ? ' — ok' : ''}${Number.isFinite(tool.durationMs) ? ` · ${Math.round(tool.durationMs)}ms` : ''}`)
          if (tool.args !== undefined) lines.push(`  - args: \`${truncate(JSON.stringify(tool.args), 500)}\``)
          if (tool.result) lines.push(`  - result: ${truncate(tool.result, 800).replace(/\n/gu, ' ⏎ ')}`)
        }
      }
      if (turn.assistant.length > 0) {
        lines.push('')
        lines.push('**Assistant**')
        for (const message of turn.assistant) {
          lines.push('')
          lines.push('```text')
          lines.push(truncate(message.text, 4_000))
          lines.push('```')
        }
      }
      if (turn.images.length > 0) {
        lines.push('')
        lines.push('**Screenshots**')
        lines.push('')
        for (const image of turn.images) {
          lines.push(`- [${image.path}](${image.path}) — ${image.width ?? '?'}×${image.height ?? '?'}, ${formatBytes(image.bytes)}`)
        }
      }
      if (turn.ok === false) {
        lines.push('')
        lines.push(`**Error:** ${turn.error ?? 'unknown'}`)
      }
    }
    lines.push('')
    lines.push('## Event counts')
    lines.push('')
    for (const [type, count] of [...this.eventTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      lines.push(`- \`${type}\`: ${count}`)
    }
    lines.push('')
    lines.push('## Raw files')
    lines.push('')
    lines.push('- `events.jsonl` — every bridge/extension/plugin/DSH event with redaction')
    lines.push('- `summary.json` — machine-readable turn model')
    lines.push('- `environment.json` / `manifest.json` — run metadata')
    lines.push('- `screenshots/` — included screenshots (if enabled)')
    lines.push('- `dsh-session.*` — raw DSH session log (if enabled)')
    lines.push('')
    lines.push('Inline image bytes, pairing tokens, API keys, authorization headers, and secret-named fields are redacted. Full page content remains in the screenshots and in assistant/user text.')
    return lines.join('\n')
  }

  async exportBundle(options = {}) {
    const includeScreenshots = options.includeScreenshots !== false
    const includeSession = options.includeSession !== false
    await this.flush()
    this.record('companion', 'log.export', {
      includeScreenshots,
      includeSession,
      screenshots: this.screenshotFiles.length,
      events: this.counts.events,
    }, { severity: 'info' })
    await this.flush()

    const stats = this.stats()
    const summary = this.summary()
    const turns = this.serializeTurns()
    const events = await readFile(this.eventsPath, 'utf8').catch(() => '')
    const environment = {
      ...this.meta,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sessionId: this.sessionId,
      extension: this.context,
      generatedAt: isoNow(),
      redaction: 'tokens, API keys, authorization headers, secret fields, inline base64',
    }
    const manifest = {
      format: 'crazyagent-debug-bundle',
      version: 1,
      runId: this.runId,
      generatedAt: isoNow(),
      includeScreenshots,
      includeSession,
      stats,
      files: {},
      environment,
    }
    /** @type {Record<string, Uint8Array>} */
    const files = {
      'summary.md': strToU8(summary),
      'summary.json': strToU8(JSON.stringify(turns, null, 2)),
      'events.jsonl': strToU8(events),
      'environment.json': strToU8(JSON.stringify(environment, null, 2)),
    }
    if (includeScreenshots) {
      for (const screenshot of this.screenshotFiles) {
        try {
          const data = await readFile(join(this.screenshotsDir, screenshot.name))
          files[`screenshots/${screenshot.name}`] = new Uint8Array(data)
        } catch {
          // A missing screenshot is noted in the manifest rather than failing the export.
          this.signal('SCREENSHOT_MISSING', screenshot.name, 'warn')
        }
      }
    }
    let sessionNote = 'DSH session log was not requested or was not found.'
    if (includeSession) {
      const session = await this.#findSessionFile()
      if (session) {
        try {
          const info = await stat(session)
          const max = 50 * 1024 * 1024
          let data = await readFile(session)
          if (info.size > max) {
            data = data.subarray(data.length - max)
            sessionNote = `DSH session log was truncated to the last ${formatBytes(max)}.`
          }
          const name = session.endsWith('.zst') ? 'dsh-session.jsonl.zst' : 'dsh-session.jsonl'
          files[name] = new Uint8Array(data)
          sessionNote = `Included ${name} (${formatBytes(info.size)}).`
        } catch (error) {
          sessionNote = `Could not read DSH session log: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
    files['README.txt'] = strToU8(`CrazyAgent debug bundle
========================

This bundle was generated for development debugging. It contains:

- summary.md        Human-readable turn timeline, signals, screenshots, timings
- summary.json      Machine-readable turn model
- events.jsonl      Every recorded bridge/extension/plugin/DSH event
- environment.json  Runtime, model, and extension context
- screenshots/      Captured screenshots (if included)
- dsh-session.*     Raw DSH session log (if included)

Redactions: pairing tokens, API keys, authorization headers, secret-named
fields, and inline base64 image data are removed from JSONL events. Screenshots
are separate files and may contain page content.

${sessionNote}
`)
    manifest.files = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, data.length]))
    files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))

    // Also keep the readable artifacts beside events.jsonl so the run folder
    // is useful without unzipping the bundle.
    await Promise.all([
      writeFile(join(this.dir, 'summary.md'), summary).catch(() => {}),
      writeFile(join(this.dir, 'summary.json'), JSON.stringify(turns, null, 2)).catch(() => {}),
      writeFile(join(this.dir, 'environment.json'), JSON.stringify(environment, null, 2)).catch(() => {}),
      writeFile(join(this.dir, 'manifest.json'), JSON.stringify(manifest, null, 2)).catch(() => {}),
    ])

    const zipped = zipSync(files, { level: 1 })
    const buffer = Buffer.from(zipped)
    const filename = `crazyagent-log-${this.runId}.zip`
    const path = join(this.exportsDir, filename)
    await writeFile(path, buffer)
    const inline = buffer.length <= this.maxInlineBytes
    const result = {
      ok: true,
      runId: this.runId,
      filename,
      sizeBytes: buffer.length,
      inline,
      path,
      note: inline ? 'Bundle downloaded in the side panel and written locally.' : 'Bundle is too large to send inline; use the local path.',
      stats: this.stats(),
      contents: Object.keys(files).sort(),
      sessionNote,
    }
    if (inline) result.base64 = buffer.toString('base64')
    return result
  }

  async #findSessionFile() {
    if (!this.sessionId) return undefined
    const sessionsRoot = join(String(this.meta.dshHome ?? ''), 'sessions')
    const stack = [{ dir: sessionsRoot, depth: 0 }]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current || current.depth > 4) continue
      let entries
      try {
        entries = await readdir(current.dir, { withFileTypes: true })
      } catch {
        continue
      }
      const dirEntry = entries.find(entry => entry.isDirectory() && entry.name === this.sessionId)
      if (dirEntry) {
        const sessionDir = join(current.dir, dirEntry.name)
        const files = await readdir(sessionDir).catch(() => [])
        const file = files.find(name => name === 'session.v4.jsonl')
          ?? files.find(name => name === 'session.jsonl')
          ?? files.find(name => name.startsWith('session.') && (name.endsWith('.jsonl') || name.endsWith('.zst')))
        if (file) return join(sessionDir, file)
      }
      for (const entry of entries) {
        if (entry.isDirectory()) stack.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
      }
    }
    return undefined
  }

  async close() {
    if (this.closed) return
    await this.flush()
    this.record('companion', 'run.stop', { at: isoNow() }, { severity: 'info' })
    await this.flush()
    this.closed = true
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flushChain
  }
}