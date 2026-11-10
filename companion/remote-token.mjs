/**
 * Remote (phone) access credential.
 *
 * Independent of the bridge pairing token: rotating it re-pairs Android
 * clients only and never interrupts the side panel or DSH provider. Stored as
 * 64 hex characters in a 0600 file under .dsh-home/browser-agent/. The value
 * is never printed except by an explicit --pair-remote request.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'

export const REMOTE_TOKEN_PATTERN = /^[0-9a-f]{64}$/u

/** @returns {string} */
export function generateRemoteToken() {
  return randomBytes(32).toString('hex')
}

/** @param {string} path @returns {string | undefined} */
export function readRemoteToken(path) {
  if (!existsSync(path)) return undefined
  try {
    const value = readFileSync(path, 'utf8').trim()
    return REMOTE_TOKEN_PATTERN.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** @param {string} path @param {string} token */
export function writeRemoteToken(path, token) {
  if (!REMOTE_TOKEN_PATTERN.test(token)) throw new Error('remote token must be 64 lowercase hex characters')
  mkdirSync(dirname(path), { recursive: true })
  // Write-then-rename so a crash never leaves a truncated credential.
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, token, { mode: 0o600 })
  try {
    chmodSync(temp, 0o600)
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  renameSync(temp, path)
}

/**
 * Load the stored remote token, creating one when missing/invalid or when
 * `rotate` is set. `created` and `rotated` let the caller decide whether an
 * existing phone must be re-paired.
 * @param {string} path
 * @param {{rotate?: boolean}} [options]
 * @returns {{token: string, created: boolean, rotated: boolean}}
 */
export function resolveRemoteToken(path, options = {}) {
  const existing = readRemoteToken(path)
  if (existing !== undefined && options.rotate !== true) return { token: existing, created: false, rotated: false }
  const token = generateRemoteToken()
  writeRemoteToken(path, token)
  return { token, created: existing === undefined, rotated: existing !== undefined }
}

/**
 * Constant-time bearer comparison. Length mismatches return false without
 * comparing contents.
 * @param {unknown} given
 * @param {string} expected
 */
export function remoteTokenMatches(given, expected) {
  if (typeof given !== 'string' || given.length === 0 || typeof expected !== 'string' || expected.length === 0) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Live view of the stored remote token. Re-reads the file when its mtime/size
 * changes (checked at most every `checkIntervalMs`), so `--new-remote-token`
 * from another process revokes old phones without restarting the companion.
 * A missing or invalid file fails closed (returns undefined).
 * @param {string} path
 * @param {{checkIntervalMs?: number, now?: () => number}} [options]
 * @returns {() => string | undefined}
 */
export function createRemoteTokenSource(path, options = {}) {
  const interval = options.checkIntervalMs ?? 2_000
  const now = options.now ?? Date.now
  let checkedAt = -Infinity
  let stamp = ''
  /** @type {string | undefined} */
  let token
  return () => {
    const t = now()
    if (t - checkedAt < interval) return token
    checkedAt = t
    let next = ''
    try {
      const info = statSync(path)
      next = `${info.mtimeMs}:${info.size}:${info.ino}`
    } catch {
      stamp = ''
      token = undefined
      return token
    }
    if (next !== stamp) {
      stamp = next
      token = readRemoteToken(path)
    }
    return token
  }
}
