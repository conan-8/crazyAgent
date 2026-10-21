/**
 * API-key resolution for the companion.
 *
 * Precedence:
 *   1. CRAZYAGENT_API_KEY in the launch environment
 *   2. .dsh-home/browser-agent/api-key (the "remember on this machine" file)
 *   3. OPENROUTER_API_KEY in the launch environment (fallback)
 *   4. refs.OPENROUTER_API_KEY in the DSH credential store
 *
 * The resolved key is passed to DSH as CRAZYAGENT_API_KEY. It is never logged
 * or returned by the bridge; only its source and length are reported.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import yaml from 'js-yaml'

export const KEY_ENV = 'CRAZYAGENT_API_KEY'
export const FALLBACK_ENV = 'OPENROUTER_API_KEY'

/** @param {string | undefined} path */
export function readKeyFile(path) {
  if (!path) return undefined
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** @param {string} path @param {string} key */
export function writeKeyFile(path, key) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, key, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

/** @param {string | undefined} path */
export function clearKeyFile(path) {
  if (!path) return
  try {
    rmSync(path, { force: true })
  } catch {
    // Best effort.
  }
}

/**
 * @param {string | undefined} path
 * @param {string} [ref]
 */
export function readCredentialRef(path, ref = FALLBACK_ENV) {
  if (!path || !existsSync(path)) return undefined
  try {
    const doc = yaml.load(readFileSync(path, 'utf8'))
    const value = doc && typeof doc === 'object' ? doc.refs?.[ref] : undefined
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (value && typeof value === 'object' && typeof value.value === 'string' && value.value.trim().length > 0) {
      return value.value.trim()
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   manualKeyPath?: string,
 *   credentialsPath?: string,
 *   ref?: string,
 * }} [options]
 * @returns {{apiKey: string | undefined, source: 'environment'|'stored'|'legacy-environment'|'credentials-file'|'none'}}
 */
export function resolveApiKey(options = {}) {
  const env = options.env ?? process.env
  const ref = options.ref ?? FALLBACK_ENV
  const explicit = (env[KEY_ENV] ?? '').trim()
  if (explicit.length > 0) return { apiKey: explicit, source: 'environment' }

  const stored = readKeyFile(options.manualKeyPath)
  if (stored) return { apiKey: stored, source: 'stored' }

  const legacy = (env[FALLBACK_ENV] ?? '').trim()
  if (legacy.length > 0) return { apiKey: legacy, source: 'legacy-environment' }

  const fromFile = readCredentialRef(options.credentialsPath, ref)
  if (fromFile) return { apiKey: fromFile, source: 'credentials-file' }

  return { apiKey: undefined, source: 'none' }
}
