/**
 * Metadata-only push for paired phones.
 *
 * - `PushRegistry` owns the per-device FCM registrations (a small `0600` file).
 * - `PushService` decides what to send when a turn ends and talks to a
 *   provider behind a small interface, so tests use a fake and another
 *   provider (UnifiedPush) can be added without touching chat logic.
 * - `FcmHttpV1Provider` is the real provider: FCM HTTP v1 with an OAuth token
 *   from google-auth-library. Service-account JWTs are never built by hand.
 *
 * A push carries only `{type, turnId, instanceId, sequence}`. It never holds
 * prompt or answer text, the help reason, page titles or URLs, image bytes, or
 * any credential; the phone fetches all of that over the authenticated remote
 * API after it is opened. A provider success means FCM accepted the message,
 * not that Android displayed it or that this host is reachable.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { errorMessage, isRecord } from './protocol.mjs'

export const PUSH_TYPES = Object.freeze(['help', 'done', 'error'])
export const MAX_PUSH_DEVICES = 8
export const MAX_FCM_TOKEN_CHARS = 4_096
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
// FCM registration tokens are URL-safe base64 with ':' separators.
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.\-]{20,4096}$/u
const APP_VERSION_PATTERN = /^[A-Za-z0-9._+\-]{1,40}$/u
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

/**
 * Validate a registration body. Returns the normalized registration or a
 * `{code, message}` failure; nothing here is trusted beyond its shape.
 * @param {unknown} body
 */
export function parsePushRegistration(body) {
  if (!isRecord(body)) return { ok: false, code: 'INVALID_PUSH_REGISTRATION', message: 'Send {fcmToken, platform, appVersion}.' }
  if (typeof body.fcmToken !== 'string' || !FCM_TOKEN_PATTERN.test(body.fcmToken)) {
    return { ok: false, code: 'INVALID_PUSH_TOKEN', message: 'fcmToken is not a valid FCM registration token.' }
  }
  if (body.platform !== 'android') return { ok: false, code: 'INVALID_PUSH_PLATFORM', message: 'platform must be "android".' }
  if (body.appVersion !== undefined && (typeof body.appVersion !== 'string' || !APP_VERSION_PATTERN.test(body.appVersion))) {
    return { ok: false, code: 'INVALID_PUSH_REGISTRATION', message: 'appVersion must be a short version string.' }
  }
  return { ok: true, registration: { fcmToken: body.fcmToken, platform: 'android', appVersion: body.appVersion ?? null } }
}

export class PushRegistry {
  /**
   * @param {{file?: string, limit?: number, now?: () => number, log?: (message: string) => void}} [options]
   */
  constructor(options = {}) {
    this.file = options.file
    this.limit = options.limit ?? MAX_PUSH_DEVICES
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    /** @type {Map<string, {fcmToken: string, platform: string, appVersion: string | null, updatedAt: string}>} */
    this.devices = new Map()
    this.#load()
  }

  get size() {
    return this.devices.size
  }

  /** @returns {Array<{deviceId: string, fcmToken: string}>} */
  list() {
    return [...this.devices].map(([deviceId, device]) => ({ deviceId, fcmToken: device.fcmToken }))
  }

  /** @param {string} deviceId */
  has(deviceId) {
    return this.devices.has(deviceId)
  }

  /**
   * Register or replace one device. The same FCM token under another device
   * ID moves to the new ID, so one phone is never notified twice.
   * @param {string} deviceId
   * @param {{fcmToken: string, platform: string, appVersion: string | null}} registration
   * @returns {{created: boolean}}
   */
  put(deviceId, registration) {
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('invalid device id')
    const created = !this.devices.has(deviceId)
    for (const [otherId, other] of this.devices) {
      if (otherId !== deviceId && other.fcmToken === registration.fcmToken) this.devices.delete(otherId)
    }
    this.devices.delete(deviceId)
    this.devices.set(deviceId, { ...registration, updatedAt: new Date(this.now()).toISOString() })
    while (this.devices.size > this.limit) this.devices.delete(this.devices.keys().next().value)
    this.#save()
    return { created }
  }

  /** @param {string} deviceId @returns {boolean} whether a registration was removed */
  delete(deviceId) {
    const removed = this.devices.delete(deviceId)
    if (removed) this.#save()
    return removed
  }

  /** Drop the registration that owns this token (FCM said it is dead). */
  pruneToken(fcmToken) {
    let removed = false
    for (const [deviceId, device] of this.devices) {
      if (device.fcmToken === fcmToken) {
        this.devices.delete(deviceId)
        removed = true
      }
    }
    if (removed) this.#save()
    return removed
  }

  #load() {
    if (this.file === undefined || !existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const entries = isRecord(parsed) && isRecord(parsed.devices) ? Object.entries(parsed.devices) : []
      for (const [deviceId, value] of entries) {
        if (!DEVICE_ID_PATTERN.test(deviceId)) continue
        const checked = parsePushRegistration(value)
        if (!checked.ok) continue
        this.devices.set(deviceId, { ...checked.registration, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(this.now()).toISOString() })
        if (this.devices.size >= this.limit) break
      }
    } catch (error) {
      // A damaged file must not stop the companion; phones re-register on launch.
      this.log(`push: ignoring unreadable registrations (${errorMessage(error)})`)
    }
  }

  #save() {
    if (this.file === undefined) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify({ version: 1, devices: Object.fromEntries(this.devices) })}\n`, { mode: 0o600 })
      try {
        chmodSync(temp, 0o600)
      } catch {
        // Best effort on filesystems without POSIX modes.
      }
      renameSync(temp, this.file)
    } catch (error) {
      this.log(`push: could not save registrations (${errorMessage(error)})`)
    }
  }
}

/**
 * @typedef {{ok: true} | {ok: false, kind: 'invalid-token' | 'retryable' | 'fatal', detail?: string}} PushSendResult
 * @typedef {{name: string, send: (fcmToken: string, data: Record<string, string>, options: {priority: 'high' | 'normal'}) => Promise<PushSendResult>}} PushProvider
 */

export class PushService {
  /**
   * @param {{
   *   registry: PushRegistry,
   *   provider?: PushProvider,
   *   maxAttempts?: number,
   *   retryDelayMs?: number,
   *   sleep?: (ms: number) => Promise<void>,
   *   log?: (message: string) => void,
   *   audit?: (event: string, data: Record<string, unknown>) => void,
   * }} options
   */
  constructor(options) {
    this.registry = options.registry
    this.provider = options.provider
    this.maxAttempts = options.maxAttempts ?? 3
    this.retryDelayMs = options.retryDelayMs ?? 1_000
    this.sleep = options.sleep ?? (ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.() }))
    this.log = options.log ?? (() => {})
    this.audit = options.audit ?? (() => {})
    /** Turns already announced, so one turn produces one notification per device. */
    this.sentTurns = new Set()
  }

  /** Whether a provider is configured; without one, registration is refused. */
  get configured() {
    return this.provider !== undefined
  }

  /**
   * Announce the end of one turn to every registered device. Call only after
   * the corresponding state is committed, so the phone can fetch what the
   * notification refers to. Never throws.
   * @param {{type: string, turnId: string, instanceId: string, sequence: number}} event
   * @returns {Promise<{sent: number, failed: number, pruned: number, skipped?: string}>}
   */
  async notify(event) {
    const summary = { sent: 0, failed: 0, pruned: 0 }
    if (this.provider === undefined) return { ...summary, skipped: 'not-configured' }
    if (!PUSH_TYPES.includes(event.type) || typeof event.turnId !== 'string' || event.turnId.length === 0) {
      return { ...summary, skipped: 'invalid-event' }
    }
    if (this.sentTurns.has(event.turnId)) return { ...summary, skipped: 'duplicate-turn' }
    this.sentTurns.add(event.turnId)
    while (this.sentTurns.size > 200) this.sentTurns.delete(this.sentTurns.values().next().value)
    const devices = this.registry.list()
    if (devices.length === 0) return { ...summary, skipped: 'no-devices' }
    // Exactly these keys, all strings: FCM data values must be strings.
    const data = {
      type: event.type,
      turnId: event.turnId,
      instanceId: String(event.instanceId),
      sequence: String(event.sequence),
    }
    const priority = event.type === 'help' ? 'high' : 'normal'
    await Promise.all(devices.map(async device => {
      const result = await this.#deliver(device.fcmToken, data, priority)
      if (result.ok) {
        summary.sent += 1
      } else {
        summary.failed += 1
        if (result.kind === 'invalid-token' && this.registry.pruneToken(device.fcmToken)) summary.pruned += 1
      }
      // Tokens, reasons and text never reach the log: device ID and category only.
      this.audit('push.delivery', { deviceId: device.deviceId, type: event.type, turnId: event.turnId, ok: result.ok, kind: result.ok ? null : result.kind })
    }))
    return summary
  }

  /**
   * @param {string} fcmToken @param {Record<string, string>} data @param {'high' | 'normal'} priority
   * @returns {Promise<PushSendResult>}
   */
  async #deliver(fcmToken, data, priority) {
    /** @type {PushSendResult} */
    let last = { ok: false, kind: 'retryable' }
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) await this.sleep(this.retryDelayMs * 2 ** (attempt - 1))
      try {
        last = await /** @type {PushProvider} */ (this.provider).send(fcmToken, data, { priority })
      } catch (error) {
        last = { ok: false, kind: 'retryable', detail: errorMessage(error) }
      }
      if (last.ok || last.kind !== 'retryable') return last
    }
    return last
  }
}

/** Real provider: FCM HTTP v1. */
export class FcmHttpV1Provider {
  /**
   * @param {{
   *   projectId: string,
   *   getAccessToken: () => Promise<string>,
   *   fetch?: typeof fetch,
   *   timeoutMs?: number,
   * }} options
   */
  constructor(options) {
    if (typeof options.projectId !== 'string' || !/^[a-z0-9-]{4,40}$/u.test(options.projectId)) throw new Error('invalid Firebase project id')
    this.name = 'fcm-http-v1'
    this.projectId = options.projectId
    this.getAccessToken = options.getAccessToken
    this.fetch = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  /**
   * @param {string} fcmToken @param {Record<string, string>} data @param {{priority: 'high' | 'normal'}} options
   * @returns {Promise<PushSendResult>}
   */
  async send(fcmToken, data, options) {
    let accessToken
    try {
      accessToken = await this.getAccessToken()
    } catch (error) {
      return { ok: false, kind: 'fatal', detail: `auth: ${errorMessage(error)}` }
    }
    let response
    try {
      response = await this.fetch(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        // A data-only message: the app builds the notification itself.
        body: JSON.stringify({ message: { token: fcmToken, data, android: { priority: options.priority === 'high' ? 'HIGH' : 'NORMAL' } } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      return { ok: false, kind: 'retryable', detail: errorMessage(error) }
    }
    if (response.ok) return { ok: true }
    let status = ''
    try {
      const body = await response.json()
      status = String(body?.error?.details?.find?.(detail => typeof detail?.errorCode === 'string')?.errorCode ?? body?.error?.status ?? '')
    } catch {
      // Classified from the HTTP status alone.
    }
    return { ok: false, kind: classifyFcmFailure(response.status, status), detail: `HTTP ${response.status}${status ? ` ${status}` : ''}` }
  }
}

/**
 * @param {number} httpStatus @param {string} errorCode
 * @returns {'invalid-token' | 'retryable' | 'fatal'}
 */
export function classifyFcmFailure(httpStatus, errorCode) {
  if (httpStatus === 404 || errorCode === 'UNREGISTERED') return 'invalid-token'
  // A malformed token is INVALID_ARGUMENT, but so is a bad request of ours:
  // only UNREGISTERED/404 prove the token is dead.
  if (httpStatus === 429 || httpStatus >= 500 || errorCode === 'UNAVAILABLE' || errorCode === 'INTERNAL' || errorCode === 'QUOTA_EXCEEDED') return 'retryable'
  return 'fatal'
}

/**
 * Build the real provider from a service-account key file. Returns undefined
 * (push stays off) when no file is configured; throws on an unusable file so a
 * misconfiguration is visible at startup rather than at the first help request.
 * @param {{credentialsFile?: string, log?: (message: string) => void}} options
 * @returns {Promise<FcmHttpV1Provider | undefined>}
 */
export async function createFcmProvider(options) {
  const file = options.credentialsFile
  if (typeof file !== 'string' || file.trim().length === 0) return undefined
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(parsed) || parsed.type !== 'service_account' || typeof parsed.project_id !== 'string') {
    throw new Error('the FCM credentials file is not a service-account key')
  }
  const { GoogleAuth } = await import('google-auth-library')
  const auth = new GoogleAuth({ keyFile: file, scopes: [FCM_SCOPE] })
  return new FcmHttpV1Provider({
    projectId: parsed.project_id,
    getAccessToken: async () => {
      const token = await auth.getAccessToken()
      if (typeof token !== 'string' || token.length === 0) throw new Error('no access token')
      return token
    },
  })
}

/**
 * What kind of push, if any, the end of a turn deserves. A stopped turn was
 * ended by the user and announces nothing.
 * @param {{outcome: string, help?: unknown}} info
 * @returns {'help' | 'done' | 'error' | null}
 */
export function pushTypeForTurn(info) {
  if (info.outcome === 'done') return isRecord(info.help) ? 'help' : 'done'
  if (info.outcome === 'error') return 'error'
  return null
}
