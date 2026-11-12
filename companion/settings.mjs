/**
 * Companion-owned behavior settings, persisted next to the other browser-agent
 * state so phone-started and panel-less turns honor them too. The side panel
 * updates them through the `settings.update` control message; the remote API
 * only reads them (through `/state` health).
 *
 * B9a: `confirmIrreversible` arms the opt-in "Ask before submitting, sending,
 * paying, or deleting" confirmation flow. Off by default; with it off, behavior
 * is exactly as before.
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isRecord } from './protocol.mjs'

export const DEFAULT_SETTINGS = Object.freeze({ confirmIrreversible: false })

/**
 * Read the persisted settings. A missing, unreadable, or malformed file falls
 * back to the defaults; unknown keys are dropped, never forwarded.
 * @param {string} path
 * @returns {{confirmIrreversible: boolean}}
 */
export function readSettings(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  if (!isRecord(parsed)) return { ...DEFAULT_SETTINGS }
  return { confirmIrreversible: parsed.confirmIrreversible === true }
}

/**
 * Persist settings atomically with owner-only permissions.
 * @param {string} path
 * @param {{confirmIrreversible?: unknown}} settings
 * @returns {{confirmIrreversible: boolean}} the normalized stored value
 */
export function writeSettings(path, settings) {
  const normalized = { confirmIrreversible: isRecord(settings) && settings.confirmIrreversible === true }
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(temp, 0o600)
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  renameSync(temp, path)
  return normalized
}
