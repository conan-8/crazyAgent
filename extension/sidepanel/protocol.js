/** Wire constants shared by the side panel and the companion. */

export const PROTOCOL_VERSION = 1
export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:17871/bridge'

/**
 * @typedef {Object} Settings
 * @property {string} bridgeUrl
 * @property {string} token
 * @property {number} captureWidth
 * @property {number} quality
 * @property {boolean} autoCapture
 * @property {boolean} paused
 */

/** @param {string} value @param {number} max */
export function truncate(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** @param {unknown} error */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/** @param {number} ms */
export function shortDuration(ms) {
  if (!Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`
}
