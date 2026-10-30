/**
 * Pure clipboard helpers shared by the side-panel executor and its unit tests.
 *
 * This module is dependency-free and never touches `chrome`, `navigator`, or
 * the DOM: the executor owns storage and system-clipboard access, while the
 * text shaping, capping, and validation rules live here so node:test can
 * import them directly.
 */

/** chrome.storage.session key for the internal ("virtual") clipboard. */
export const CLIPBOARD_STORAGE_KEY = 'crazyagent.clipboard'
/** Hard cap for virtual clipboard text (also the system clipboard write cap). */
export const CLIPBOARD_MAX_CHARS = 100_000
/** Characters echoed back as a one-line preview. */
export const CLIPBOARD_PREVIEW_CHARS = 200
/** Cap for text returned by the read action; clipboard content can be large. */
export const CLIPBOARD_READ_MAX_CHARS = 20_000
/** browser_type accepts at most 20,000 chars, so a typed paste is capped here. */
export const CLIPBOARD_TYPE_MAX_CHARS = 20_000
/** Decoded byte cap for one PNG in chrome.storage.session's 10 MB quota. */
export const CLIPBOARD_IMAGE_MAX_BYTES = 6_000_000
/** Marker appended to capped text so the model knows it was cut. */
export const CLIPBOARD_TRUNCATION_MARKER = '\n[clipboard truncated]'

export const CLIPBOARD_ACTIONS = ['copy', 'read', 'write', 'paste', 'clear']
export const CLIPBOARD_TARGETS = ['virtual', 'system']
export const CLIPBOARD_SOURCES = ['selection', 'label']

/**
 * Clamp an optional positive integer cap. Falls back to the default on a
 * missing, non-finite, or non-positive value.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function charCap(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.max(1, Math.floor(num))
}

/**
 * One-line preview of clipboard text: whitespace runs collapse to one space and
 * the result is capped with a trailing ellipsis. Never echoes the full text.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function clipboardPreview(text, maxChars = CLIPBOARD_PREVIEW_CHARS) {
  const cap = charCap(maxChars, CLIPBOARD_PREVIEW_CHARS)
  const collapsed = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= cap) return collapsed
  return `${collapsed.slice(0, Math.max(0, cap - 1))}…`
}

/**
 * Apply the virtual clipboard cap. Oversized text keeps its beginning and gets
 * an explicit truncation marker so a later read is not mistaken for complete.
 * The returned text is never longer than `maxChars`; a cap smaller than the
 * marker itself still returns the whole marker so the cut is always visible.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {{text: string, chars: number, truncated: boolean, originalChars: number}}
 */
export function fitClipboardText(text, maxChars = CLIPBOARD_MAX_CHARS) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const cap = charCap(maxChars, CLIPBOARD_MAX_CHARS)
  if (raw.length <= cap) {
    return { text: raw, chars: raw.length, truncated: false, originalChars: raw.length }
  }
  const marker = CLIPBOARD_TRUNCATION_MARKER
  const keep = Math.max(0, cap - marker.length)
  const fitted = `${raw.slice(0, keep)}${marker}`
  return { text: fitted, chars: fitted.length, truncated: true, originalChars: raw.length }
}

/**
 * Slice clipboard text for a read/typed-paste result. Unlike fitClipboardText
 * this adds no marker: it reports the total separately so the caller can tell
 * the model that the clipboard holds more.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {{text: string, chars: number, totalChars: number, truncated: boolean, offset: number}}
 */
export function clipClipboardText(text, maxChars = CLIPBOARD_READ_MAX_CHARS) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const cap = charCap(maxChars, CLIPBOARD_READ_MAX_CHARS)
  const textPart = raw.slice(0, cap)
  return {
    text: textPart,
    chars: textPart.length,
    totalChars: raw.length,
    truncated: raw.length > textPart.length,
    offset: 0,
  }
}

/**
 * Build the object stored under CLIPBOARD_STORAGE_KEY.
 * @param {{text: string, source: string, tabId?: number|null, url?: string, at?: number}} input
 * @returns {{text: string, chars: number, source: string, tabId: number|null, url: string, at: number}}
 */
export function makeClipboardEntry(input) {
  const fitted = fitClipboardText(input?.text)
  return {
    text: fitted.text,
    chars: fitted.chars,
    source: typeof input?.source === 'string' && input.source.length > 0 ? input.source : 'write',
    tabId: Number.isSafeInteger(input?.tabId) ? input.tabId : null,
    url: typeof input?.url === 'string' ? input.url : '',
    at: Number.isFinite(input?.at) ? Number(input.at) : Date.now(),
  }
}

function normalizeClipboardImage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.mimeType !== 'image/png' || typeof value.data !== 'string' || value.data.length === 0) return undefined
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value.data) || value.data.length > Math.ceil(CLIPBOARD_IMAGE_MAX_BYTES * 4 / 3) + 4) return undefined
  const width = Number(value.width)
  const height = Number(value.height)
  const bytes = Number(value.bytes)
  if (!Number.isSafeInteger(width) || width <= 0 || width > 32_768
    || !Number.isSafeInteger(height) || height <= 0 || height > 32_768
    || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > CLIPBOARD_IMAGE_MAX_BYTES) return undefined
  return { data: value.data, mimeType: 'image/png', width, height, bytes }
}

export function makeImageClipboardEntry(input) {
  const image = normalizeClipboardImage(input?.image)
  if (!image) {
    const error = new Error(`image must be a PNG of at most ${CLIPBOARD_IMAGE_MAX_BYTES} decoded bytes with valid dimensions`)
    error.code = 'BAD_CLIPBOARD_IMAGE'
    throw error
  }
  return {
    kind: 'image',
    text: '',
    chars: 0,
    source: typeof input?.source === 'string' && input.source.length > 0 ? input.source : 'screenshot',
    tabId: Number.isSafeInteger(input?.tabId) ? input.tabId : null,
    url: typeof input?.url === 'string' ? input.url : '',
    at: Number.isFinite(input?.at) ? Number(input.at) : Date.now(),
    image,
  }
}

/**
 * Validate one value read back from chrome.storage.session. Storage can hold a
 * partial object after an interrupted write, so every field is re-checked and
 * the text is re-capped. Returns undefined for missing or unusable entries.
 * @param {unknown} value
 * @returns {Record<string, any> | undefined}
 */
export function normalizeClipboardEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.kind === 'image' || value.image !== undefined) {
    const image = normalizeClipboardImage(value.image)
    if (!image) return undefined
    return makeImageClipboardEntry({ ...value, image, at: Number.isFinite(value.at) ? Number(value.at) : 0 })
  }
  if (typeof value.text !== 'string') return undefined
  const fitted = fitClipboardText(value.text)
  return {
    text: fitted.text,
    chars: fitted.chars,
    source: typeof value.source === 'string' && value.source.length > 0 ? value.source : 'unknown',
    tabId: Number.isSafeInteger(value.tabId) ? value.tabId : null,
    url: typeof value.url === 'string' ? value.url : '',
    at: Number.isFinite(value.at) ? Number(value.at) : 0,
  }
}