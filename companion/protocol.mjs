/** Shared wire constants for the companion, provider, and side panel. */

export const PROTOCOL_VERSION = 1
export const BRIDGE_PATH = '/bridge'
export const DEFAULT_PORT = 17871
export const DEFAULT_HOST = '127.0.0.1'
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
export const HANDSHAKE_TIMEOUT_MS = 5_000
export const UI_COMMAND_TIMEOUT_MS = 5_000

/** @param {import('ws').WebSocket | null | undefined} ws @param {Record<string, unknown>} frame */
export function send(ws, frame) {
  if (ws === null || ws === undefined) return false
  if (ws.readyState !== 1) return false
  try {
    ws.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

/** @param {unknown} error @returns {string} */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}