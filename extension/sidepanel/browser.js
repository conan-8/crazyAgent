/**
 * Chrome-side browser executor for Phase 1.
 *
 * Everything here runs in the side panel document. Page code is injected only
 * for the duration of one scroll or metrics call; no persistent content script
 * is installed.
 */

import {
  CLIPBOARD_ACTIONS,
  CLIPBOARD_READ_MAX_CHARS,
  CLIPBOARD_SOURCES,
  CLIPBOARD_STORAGE_KEY,
  CLIPBOARD_TARGETS,
  CLIPBOARD_TYPE_MAX_CHARS,
  clipClipboardText,
  clipboardPreview,
  fitClipboardText,
  makeClipboardEntry,
  normalizeClipboardEntry,
} from './clipboard.js'
import { docsFetchExport } from './docs-export.js'
import { formatOutline, parseDocStructure } from './docs-structure.js'

export const DEFAULT_SETTINGS = {
  bridgeUrl: 'ws://127.0.0.1:17871/bridge',
  token: '',
  captureWidth: 1280,
  quality: 72,
  autoCapture: true,
  showHitboxes: true,
  paused: false,
  modelBaseUrl: 'https://openrouter.ai/api/v1',
  modelId: '',
}

const CAPTURE_INTERVAL_MS = 0
const LABEL_LIMIT = 120
/**
 * Most recent labelled view per tab, used for pixel-diff verification, the
 * auto view policy, and compact label deltas.
 */
const lastViewByTab = new Map()
/**
 * Cumulative label registry per tab: global label id -> owning frame + the
 * signature (tag/role/text) recorded when the id was handed out. Labels merge
 * across views so an id from an earlier view on the same page still resolves,
 * and the signature lets a re-rendered element be recovered under its new id.
 * A URL change invalidates the whole entry.
 * @type {Map<number, {url: string, labels: Map<number, {frameId: number, localId: number, tag?: string, role?: string, text?: string}>, at: number}>}
 */
const tabLabelsByTab = new Map()
const MAX_LABEL_TABS = 20
const lastScrollByTab = new Map()
/**
 * Captured views per tab, newest first, kept as coordinate bases for image-space
 * actions. A `detail:"fast"` capture is a 640px image on the same viewport, so
 * its css/imagePx scale is half the normal view's; without a record of which
 * image a coordinate was measured on, a click measured against the old basis
 * silently maps through the new one (2026-10-23 run: 0.817 → 1.021 → 2.042 px
 * scales while the model reused (247, 514)). Every capture gets a monotonic
 * viewId, and click_at can name the basis it measured on.
 * @type {Map<number, Array<{viewId: number, url: string, imageWidth: number, imageHeight: number, viewport: {width: number, height: number}, at: number}>>}
 */
const imageBasesByTab = new Map()
/** Recent bases per tab; enough to name the view a stale coordinate fits. */
const MAX_IMAGE_BASES = 8
/** Monotonic across the browser session so a viewId is unique in a transcript. */
let nextViewId = 1
/** Layout drift (CSS px) that makes a previous view's coordinates stale. */
const LAYOUT_SHIFT_THRESHOLD_PX = 8
/** Upper bound for one click_at points burst (raised from 8 so a 19-point
 * whack-a-dot burst is one attach, one capture). */
const CLICK_AT_MAX_POINTS = 20
/** Scroll drift (CSS px) that makes a stored screenshot's coordinates stale. */
const STALE_SCROLL_THRESHOLD_PX = 40
/** Margin (CSS px) that still counts as "fully inside" the viewport. */
const SCROLL_VISIBLE_MARGIN_PX = 4
/** Click failure codes that mean the label list moved on; the retry hint applies. */
const STALE_LABEL_CODES = new Set(['DETACHED', 'NOT_VISIBLE', 'UNKNOWN_LABEL'])
/**
 * Stale codes that mean the id no longer names a live labelled element, so the
 * same logical element can only be found again by its recorded signature.
 * NOT_VISIBLE is deliberately excluded: that element still exists, it just has
 * no box right now, and a text lookalike would be a different element.
 */
const RECOVERABLE_LABEL_CODES = new Set(['DETACHED', 'UNKNOWN_LABEL'])
/** Caps for the stale-label retry hint appended to those errors. */
const LABEL_HINT_MAX_LABELS = 25
const LABEL_HINT_MAX_CHARS = 1_200
/** >0 while batch actions run: inner actions must not build their own view. */
let batchDepth = 0
/** Named keys supported by press_key, with DOM and CDP keyboard data. */
const KEY_SPECS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Period: { key: '.', code: 'Period', keyCode: 190, text: '.', shifted: '>' },
  Comma: { key: ',', code: 'Comma', keyCode: 188, text: ',', shifted: '<' },
  Semicolon: { key: ';', code: 'Semicolon', keyCode: 186, text: ';', shifted: ':' },
  Colon: { key: ':', code: 'Semicolon', keyCode: 186, text: ':', shift: true },
  Quote: { key: "'", code: 'Quote', keyCode: 222, text: "'", shifted: '"' },
  Backquote: { key: '`', code: 'Backquote', keyCode: 192, text: '`', shifted: '~' },
  Slash: { key: '/', code: 'Slash', keyCode: 191, text: '/', shifted: '?' },
  Backslash: { key: '\\', code: 'Backslash', keyCode: 220, text: '\\', shifted: '|' },
  Minus: { key: '-', code: 'Minus', keyCode: 189, text: '-', shifted: '_' },
  Equal: { key: '=', code: 'Equal', keyCode: 187, text: '=', shifted: '+' },
  BracketLeft: { key: '[', code: 'BracketLeft', keyCode: 219, text: '[', shifted: '{' },
  BracketRight: { key: ']', code: 'BracketRight', keyCode: 221, text: ']', shifted: '}' },
}
/** CDP Input.dispatchKeyEvent modifier bits. */
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

/**
 * Every printable ASCII character mapped to its physical key and key code.
 * Base characters carry their shifted symbol; shifted variants need shift.
 */
const KEY_CHAR_TABLE = (() => {
  /** @type {Record<string, {key: string, code: string, keyCode: number, shifted?: string, needsShift?: boolean}>} */
  const table = {}
  const add = (key, code, keyCode, extra = {}) => { table[key] = { key, code, keyCode, ...extra } }
  for (let index = 0; index < 26; index += 1) {
    const lower = String.fromCharCode(97 + index)
    const upper = lower.toUpperCase()
    add(lower, `Key${upper}`, 65 + index, { shifted: upper })
    add(upper, `Key${upper}`, 65 + index, { needsShift: true })
  }
  const digitShifted = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')']
  for (let digit = 0; digit <= 9; digit += 1) {
    add(String(digit), `Digit${digit}`, 48 + digit, { shifted: digitShifted[digit] })
    add(digitShifted[digit], `Digit${digit}`, 48 + digit, { needsShift: true })
  }
  const punctuation = [
    ['`', 'Backquote', 192, '~'],
    ['-', 'Minus', 189, '_'],
    ['=', 'Equal', 187, '+'],
    ['[', 'BracketLeft', 219, '{'],
    [']', 'BracketRight', 221, '}'],
    ['\\', 'Backslash', 220, '|'],
    [';', 'Semicolon', 186, ':'],
    ["'", 'Quote', 222, '"'],
    [',', 'Comma', 188, '<'],
    ['.', 'Period', 190, '>'],
    ['/', 'Slash', 191, '?'],
  ]
  for (const [base, code, keyCode, shifted] of punctuation) {
    add(base, code, keyCode, { shifted })
    add(shifted, code, keyCode, { needsShift: true })
  }
  add(' ', 'Space', 32, { shifted: ' ' })
  return table
})()

export class BrowserError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * @param {number} width
 * @param {number} height
 * @param {number} maxWidth
 */
export function scaleDimensions(width, height, maxWidth) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const cap = Math.max(1, Math.round(Number(maxWidth) || 0))
  if (w <= cap) return { width: w, height: h }
  const scale = cap / w
  return { width: cap, height: Math.max(1, Math.round(h * scale)) }
}

/**
 * @param {'up'|'down'|'left'|'right'} direction
 * @param {number|undefined} pages
 * @param {number|undefined} amountPx
 * @param {{width:number,height:number}} viewport
 */
export function computeScrollPixels(direction, pages, amountPx, viewport) {
  if (Number.isFinite(amountPx) && Number(amountPx) > 0) return Math.max(1, Math.round(Number(amountPx)))
  const vertical = direction === 'up' || direction === 'down'
  const base = vertical ? viewport.height : viewport.width
  const lengths = Number.isFinite(pages) && Number(pages) > 0 ? Number(pages) : 0.85
  return Math.max(1, Math.round(base * lengths))
}

/** @param {string | undefined} url */
export function isProtectedUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return true
  const lower = url.toLowerCase()
  return lower.startsWith('chrome://')
    || lower.startsWith('edge://')
    || lower.startsWith('about:')
    || lower.startsWith('chrome-extension://')
    || lower.startsWith('devtools://')
    || lower.startsWith('view-source:')
    || lower.startsWith('https://chrome.google.com/webstore')
    || lower.startsWith('https://chromewebstore.google.com')
}

/** @param {import('./protocol.js').Settings} [settings] */
function normalizeSettings(settings) {
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) }
}

/** @returns {Promise<number>} */
async function getWindowId() {
  try {
    const current = await chrome.windows.getCurrent()
    if (current?.id !== undefined) return current.id
  } catch {
    // Fall through to the last focused window.
  }
  const last = await chrome.windows.getLastFocused()
  if (last?.id === undefined) throw new BrowserError('NO_WINDOW', 'Chrome did not report a window for this side panel')
  return last.id
}

/**
 * @param {number} windowId
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function getActiveTab(windowId) {
  const tabs = await chrome.tabs.query({ windowId, active: true })
  const tab = tabs[0]
  if (tab?.id === undefined) throw new BrowserError('NO_TAB', 'There is no active tab in this window')
  return tab
}

/**
 * @param {number} tabId
 * @param {number} windowId
 * @param {number} timeoutMs
 */
function waitForTabComplete(tabId, windowId, timeoutMs) {
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') finish()
    }).catch(finish)
  })
}

/**
 * @param {number} tabId
 * @param {Function} func
 * @param {unknown[]} args
 * @returns {Promise<any>}
 */
async function runInTab(tabId, func, args, timeoutMs = 4_000) {
  let results
  try {
    results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func,
        args,
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new BrowserError('SCRIPT_TIMEOUT', `The page script did not finish within ${timeoutMs}ms`)),
        timeoutMs,
      )),
    ])
  } catch (error) {
    if (error instanceof BrowserError) throw error
    throw new BrowserError('SCRIPT_FAILED', `Chrome could not run in this tab: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = results?.[0]?.result
  if (result === undefined) throw new BrowserError('SCRIPT_EMPTY', 'The page script returned no result')
  return result
}

/**
 * Run one page function in every frame of the tab and return the per-frame
 * results. Canvas apps keep the real editor (or the hidden event-target) in a
 * subframe, so a top-frame-only probe cannot see what happened there; one
 * scripting call covers all frames, which keeps the round-trip count the same as
 * the old top-frame calls. Frames that refuse injection are skipped; when the
 * whole call fails it falls back to the top frame.
 * @param {number} tabId
 * @param {Function} func
 * @param {unknown[]} [args]
 * @param {number} [timeoutMs]
 * @returns {Promise<Array<{frameId: number, result: any}>>}
 */
async function runInAllFrames(tabId, func, args = [], timeoutMs = 3_000) {
  let results
  try {
    results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func,
        args,
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new BrowserError('SCRIPT_TIMEOUT', `The page script did not finish within ${timeoutMs}ms`)),
        timeoutMs,
      )),
    ])
  } catch (error) {
    if (error instanceof BrowserError) throw error
    try {
      const result = await runInTab(tabId, func, args, timeoutMs)
      return [{ frameId: 0, result }]
    } catch {
      throw new BrowserError('SCRIPT_FAILED', `Chrome could not run in this tab: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (Array.isArray(results) ? results : [])
    .filter(item => item && item.result !== undefined)
    .map(item => ({ frameId: Number(item.frameId) || 0, result: item.result }))
}

/** Page-side timer: the active tab is not throttled like a hidden side panel. */
function waitInPage(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** @param {number} tabId @param {number} ms */
async function pauseInTab(tabId, ms) {
  try {
    await runInTab(tabId, waitInPage, [ms], ms + 1_000)
  } catch {
    await sleep(ms)
  }
}

/**
 * Page-side paint wait for a burst: two animation frames, with a timer
 * fallback so a throttled page still settles. Not a fixed sleep: canvas apps
 * paint immediately after input, so two frames is usually enough.
 * @param {number} maxMs
 */
function waitForPaint(maxMs) {
  return new Promise(resolve => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, Math.max(0, maxMs))
    requestAnimationFrame(() => requestAnimationFrame(finish))
  })
}

/**
 * Settle after input before the capture. Without settle_ms this is an adaptive
 * paint wait (two frames, ~120ms ceiling). An explicit settle_ms waits that
 * long in the page, because the hidden side panel's timers are throttled.
 * @param {number} tabId
 * @param {number|undefined} settleMs
 */
async function settleAfterInput(tabId, settleMs) {
  if (settleMs !== undefined) {
    if (settleMs > 0) await pauseInTab(tabId, settleMs)
    return
  }
  try {
    await runInTab(tabId, waitForPaint, [120], 1_200)
  } catch {
    await pauseInTab(tabId, 120)
  }
}

/**
 * Attach the Chrome DevTools protocol for trusted input. Detaches afterwards;
 * only one client may attach at a time (DevTools counts as a client).
 * @param {number} tabId
 * @param {() => Promise<any>} fn
 */
async function withDebugger(tabId, fn) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/already attached|another debugger/i.test(message)) {
      throw new BrowserError('DEBUGGER_BUSY', 'Another debugger (DevTools) is attached to this tab. Close DevTools and try again.')
    }
    throw new BrowserError('DEBUGGER_FAILED', `Could not attach trusted input to this tab: ${message}`)
  }
  try {
    return await fn()
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {})
  }
}

export function showClickRipple(x, y) {
  const id = '__crazyagent_click_ripple_style'
  const style = document.getElementById(id) ?? document.createElement('style')
  style.id = id
  style.textContent = '@keyframes __crazyagent_click_ripple{0%{transform:scale(.65);opacity:.7}65%{opacity:.35}100%{transform:scale(2.1);opacity:0}}@keyframes __crazyagent_click_crosshair{0%{transform:scale(.85);opacity:1}55%{opacity:.8}100%{transform:scale(1);opacity:0}}'
  if (!style.isConnected) (document.head || document.documentElement).appendChild(style)
  const ripple = document.createElement('div')
  ripple.setAttribute('aria-hidden', 'true')
  ripple.setAttribute('data-crazyagent-click-ripple', '')
  ripple.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2147483647;pointer-events:none;`
  for (let index = 0; index < 2; index += 1) {
    const ring = document.createElement('div')
    ring.setAttribute('data-crazyagent-click-ring', '')
    ring.style.cssText = `position:absolute;left:-9px;top:-9px;width:18px;height:18px;box-sizing:border-box;border:1px solid rgba(255,195,0,.85);border-radius:50%;background:transparent;box-shadow:0 0 6px rgba(255,195,0,.12);animation:__crazyagent_click_ripple .65s cubic-bezier(.2,.55,.3,1) ${index * 0.12}s forwards;`
    ripple.appendChild(ring)
  }
  const crosshair = document.createElement('div')
  crosshair.setAttribute('data-crazyagent-click-crosshair', '')
  crosshair.style.cssText = 'position:absolute;left:-7px;top:-7px;width:14px;height:14px;animation:__crazyagent_click_crosshair .6s ease-out forwards;'
  const parts = [
    'left:6px;top:0;width:2px;height:4px',
    'left:6px;bottom:0;width:2px;height:4px',
    'left:0;top:6px;width:4px;height:2px',
    'right:0;top:6px;width:4px;height:2px',
    'left:6px;top:6px;width:2px;height:2px;border-radius:50%',
  ]
  for (const part of parts) {
    const tick = document.createElement('div')
    tick.style.cssText = `position:absolute;${part};background:#ffc300;box-shadow:0 0 4px rgba(255,195,0,.2);`
    crosshair.appendChild(tick)
  }
  ripple.appendChild(crosshair)
  ;(document.body || document.documentElement).appendChild(ripple)
  setTimeout(() => ripple.remove(), 900)
}

/** Dispatch a trusted left click at CSS viewport coordinates. */
async function trustedClick(tabId, x, y) {
  await runInTab(tabId, showClickRipple, [x, y], 500).catch(() => {})
  const base = { x, y, button: 'left', clickCount: 1 }
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

/** Dispatch a trusted left click without adding overlays to the document. */
async function docsTrustedClick(tabId, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 }
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

/** Dispatch a trusted wheel event at CSS viewport coordinates. */
async function trustedWheel(tabId, x, y, deltaX, deltaY) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX,
    deltaY,
    modifiers: 0,
  })
}

/**
 * Synthetic fallback when trusted input is unavailable. A burst dispatches the
 * full pointer/mouse sequence at every point in one page script, so a failed
 * debugger attach costs one round trip rather than one per point.
 * @param {Array<{x: number, y: number}>} points
 * @returns {boolean[]} whether an element existed at each point
 */
function syntheticClickBurst(points) {
  const clickPoint = (x, y) => {
    const el = document.elementFromPoint(x, y)
    if (!el) return false
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
    return true
  }
  return points.map(point => clickPoint(point.x, point.y))
}

/** Synthetic wheel fallback. */
function syntheticWheelAtPoint(x, y, deltaX, deltaY) {
  const el = document.elementFromPoint(x, y) || document.body
  if (!el) return false
  el.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true }))
  return true
}

/**
 * Read a square CSS region as a small RGBA sample from a captured JPEG.
 * @param {{data: string, mimeType: string, width: number}} image
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {number} cssPerImagePixel
 * @param {number} size
 */
async function sampleRegion(image, rect, cssPerImagePixel, size = 64) {
  const dataUrl = `data:${image.mimeType};base64,${image.data}`
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  try {
    const sx = Math.max(0, Math.round(rect.x / cssPerImagePixel))
    const sy = Math.max(0, Math.round(rect.y / cssPerImagePixel))
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.w / cssPerImagePixel)))
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.h / cssPerImagePixel)))
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(size, size)
      : (() => { const el = document.createElement('canvas'); el.width = size; el.height = size; return el })()
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new BrowserError('DIFF_FAILED', 'Could not sample the screenshot for pixel comparison')
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, size, size)
    return context.getImageData(0, 0, size, size).data
  } finally {
    bitmap.close?.()
  }
}

/**
 * Compare two captured views in a square region around a point. This is the
 * only reliable change signal for canvas/video surfaces, which emit no DOM
 * mutations.
 * @param {{image: Record<string, any>, viewport: Record<string, any>} | undefined} before
 * @param {Record<string, any>} after
 * @param {number} cssX
 * @param {number} cssY
 * @param {number} radius
 */
async function diffRegion(before, after, cssX, cssY, radius = 120) {
  if (!before?.image?.data || !after?.image?.data) return { changed: false, percent: 0, mean: 0 }
  const rect = { x: cssX - radius, y: cssY - radius, w: radius * 2, h: radius * 2 }
  const beforeScale = before.viewport.width / before.image.width
  const afterScale = after.viewport.width / after.image.width
  const [left, right] = await Promise.all([
    sampleRegion(before.image, rect, beforeScale),
    sampleRegion(after.image, rect, afterScale),
  ])
  const total = left.length / 4
  let changedPixels = 0
  let sum = 0
  for (let i = 0; i < left.length; i += 4) {
    const delta = Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) + Math.abs(left[i + 2] - right[i + 2])
    sum += delta
    if (delta > 18) changedPixels += 1
  }
  const percent = Math.round((changedPixels / total) * 1000) / 10
  const mean = Math.round((sum / (total * 3)) / 2.55 * 10) / 10
  return { changed: percent >= 0.4, percent, mean }
}

/**
 * Run one page function in a specific frame.
 * @param {number} tabId
 * @param {number} frameId
 * @param {Function} func
 * @param {unknown[]} args
 * @param {number} [timeoutMs]
 */
async function runInFrame(tabId, frameId, func, args, timeoutMs = 4_000) {
  let results
  try {
    results = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'ISOLATED', func, args }),
      new Promise((_, reject) => setTimeout(
        () => reject(new BrowserError('SCRIPT_TIMEOUT', `The frame script did not finish within ${timeoutMs}ms`)),
        timeoutMs,
      )),
    ])
  } catch (error) {
    if (error instanceof BrowserError) throw error
    throw new BrowserError('SCRIPT_FAILED', `Chrome could not run in this frame: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = results?.[0]?.result
  if (result === undefined) throw new BrowserError('SCRIPT_EMPTY', 'The frame script returned no result')
  return result
}

/**
 * List frames for a tab. Cross-origin frames are included because the
 * extension has <all_urls> host access.
 * @param {number} tabId
 */
async function listFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    return Array.isArray(frames) ? frames.filter(frame => frame.errorOccurred !== true).slice(0, 10) : [{ frameId: 0 }]
  } catch {
    return [{ frameId: 0 }]
  }
}

/**
 * Label the top frame and every accessible child frame. Labels from child
 * frames get a globally unique id (`frameId * 100000 + localId`) and are
 * dispatched back into the owning frame.
 * @param {number} tabId
 * @param {number} limit
 */
async function labelAllFrames(tabId, limit, options = {}) {
  const frames = await listFrames(tabId)
  const topIndex = frames.findIndex(frame => frame.frameId === 0)
  if (topIndex > 0) frames.unshift(frames.splice(topIndex, 1)[0])
  const paint = options.paint !== false
  const outcomes = await Promise.all(frames.map(async frame => {
    const cap = frame.frameId === 0 ? limit : Math.min(40, limit)
    try {
      const result = await runInFrame(tabId, frame.frameId, labelPage, [cap, paint], 2_000)
      return { frameId: frame.frameId, result }
    } catch (error) {
      return { frameId: frame.frameId, error }
    }
  }))
  const top = outcomes.find(item => item.frameId === 0)
  if (!top?.result || top.result.__labelError) {
    const detail = top?.result?.__labelError ?? (top?.error instanceof Error ? top.error.message : 'no result')
    throw new BrowserError('LABEL_FAILED', `Could not label the page: ${detail}`)
  }
  const labels = []
  const registry = labelRegistryFor(tabId, top.result.url)
  for (const item of outcomes) {
    const data = item.result
    if (!data || data.__labelError) continue
    for (const label of data.labels) {
      const globalId = item.frameId === 0 ? label.id : item.frameId * 100_000 + label.id
      registry.labels.set(globalId, {
        frameId: item.frameId,
        localId: label.id,
        tag: label.tag,
        role: label.role,
        text: label.text,
      })
      labels.push({ ...label, id: globalId, ...item.frameId === 0 ? {} : { frame: item.frameId } })
    }
  }
  registry.at = Date.now()
  pruneLabelRegistry(tabId)
  return { metrics: top.result, labels }
}

/**
 * Cumulative label registry for a tab. A different URL invalidates the whole
 * entry, so labels from the previous page can never resolve to new elements.
 * @param {number} tabId
 * @param {string} url
 */
function labelRegistryFor(tabId, url) {
  let registry = tabLabelsByTab.get(tabId)
  if (registry && registry.url !== url) {
    tabLabelsByTab.delete(tabId)
    registry = undefined
  }
  if (!registry) {
    registry = { url, labels: new Map(), at: Date.now() }
    tabLabelsByTab.set(tabId, registry)
  }
  return registry
}

/**
 * Prune least-recently-used tabs beyond the registry limit.
 * @param {number} currentTabId
 */
function pruneLabelRegistry(currentTabId) {
  if (tabLabelsByTab.size <= MAX_LABEL_TABS) return
  for (const tabId of [...tabLabelsByTab.keys()]) {
    if (tabLabelsByTab.size <= MAX_LABEL_TABS) break
    if (tabId === currentTabId) continue
    tabLabelsByTab.delete(tabId)
  }
}

/**
 * Resolve a label id using the tab's cumulative registry. Returns undefined for
 * labels from a different page or an id this page never produced.
 * @param {chrome.tabs.Tab} tab
 * @param {number} label
 */
function resolveLabelTarget(tab, label) {
  const registry = tabLabelsByTab.get(tab.id)
  if (!registry) return undefined
  if (registry.url !== (tab.url ?? '')) {
    tabLabelsByTab.delete(tab.id)
    return undefined
  }
  return registry.labels.get(label)
}

/**
 * Inspect an id the registry cannot resolve against the ids this page ever
 * handed out. Label ids are assigned sequentially per frame (frame 0 gets
 * `id`, a subframe gets `frameId * 100000 + id`), so the highest recorded local
 * id in a frame is exactly the range of ids that can ever have existed there:
 * an id above it was never assigned and can never resolve, no matter how many
 * fresh views are taken. Pure, so the "hallucinated vs stale" distinction is
 * testable without Chrome.
 * @param {number} label
 * @param {{labels?: Map<number, {frameId?: number, localId?: number}>} | undefined} registry
 * @returns {{frameId: number, localId: number, maxLocalId: number, frameLabels: number, everAssigned: boolean, hasAnyLabels: boolean}}
 */
export function inspectLabelAssignment(label, registry) {
  const id = Math.max(0, Math.floor(Number(label) || 0))
  const frameId = Math.floor(id / 100_000)
  const localId = id - frameId * 100_000
  let maxLocalId = 0
  let frameLabels = 0
  const labels = registry?.labels
  if (labels instanceof Map) {
    for (const entry of labels.values()) {
      if ((Number(entry?.frameId) || 0) !== frameId) continue
      frameLabels += 1
      const local = Number(entry?.localId) || 0
      if (local > maxLocalId) maxLocalId = local
    }
  }
  return {
    frameId,
    localId,
    maxLocalId,
    frameLabels,
    everAssigned: localId >= 1 && localId <= maxLocalId,
    hasAnyLabels: labels instanceof Map && labels.size > 0,
  }
}

/**
 * Error text for a label id the registry cannot resolve. The old wording ("is
 * not in the current view") was identical for two very different mistakes: a
 * real id that went stale (a fresh view helps) and an id that was never handed
 * out at all (in the 2026-10-23 run the model clicked label 999, which no view
 * ever contained; no amount of re-viewing can resolve it, and the honest answer
 * is the valid range plus the coordinate alternative). Pure.
 * @param {number} label
 * @param {ReturnType<typeof inspectLabelAssignment>} assignment
 * @returns {{kind: 'never-assigned'|'stale'|'no-labels', message: string}}
 */
export function formatMissingLabelMessage(label, assignment) {
  const frameId = Number(assignment?.frameId) || 0
  const maxLocalId = Number(assignment?.maxLocalId) || 0
  if (!assignment || assignment.hasAnyLabels !== true) {
    return {
      kind: 'no-labels',
      message: `Label ${label} was never assigned: no labels have been handed out on this page yet. Take a fresh view (browser_screenshot) so the page is labelled, or use browser_click_at with coordinates.`,
    }
  }
  if (assignment.everAssigned === true) {
    return {
      kind: 'stale',
      message: `Label ${label} is not in the current view. Take a fresh screenshot to get current labels.`,
    }
  }
  const where = frameId === 0 ? '' : ` in frame ${frameId}`
  // Subframe ids are global ids (`frameId * 100000 + localId`), so the range is
  // reported in the same numbering the model saw in the label list.
  const range = maxLocalId > 0
    ? frameId === 0
      ? `1..${maxLocalId}`
      : `${frameId * 100_000 + 1}..${frameId * 100_000 + maxLocalId} (frame ${frameId})`
    : 'none yet'
  return {
    kind: 'never-assigned',
    message: `Label ${label} was never assigned${where}; labels assigned on this page are ${range}. The target may be unlabelled — use browser_click_at with screenshot coordinates, or take a fresh view and use one of its labels.`,
  }
}

/**
 * Describe a label id the registry cannot resolve, using the cumulative label
 * registry of this page. A registry recorded for a different URL is ignored:
 * those ids belong to the previous page and cannot resolve here.
 * @param {chrome.tabs.Tab} tab
 * @param {number} label
 */
function missingLabelError(tab, label) {
  const registry = tabLabelsByTab.get(tab.id)
  const samePage = registry !== undefined && registry.url === (tab.url ?? '')
  const assignment = inspectLabelAssignment(label, samePage ? registry : undefined)
  const described = formatMissingLabelMessage(label, assignment)
  return new BrowserError('UNKNOWN_LABEL', described.message)
}

/** Remove overlays from every frame. */
async function clearAllFrames(tabId) {
  const frames = await listFrames(tabId)
  await Promise.all(frames.map(frame => runInFrame(tabId, frame.frameId, clearLabelsPage, [], 1_500).catch(() => {})))
}

/**
 * Collect title, URL, viewport, and document scroll information.
 *
 * The fingerprint also carries a compact layout signature (up to 40 visible
 * controls with their rounded viewport rects). A skipped-view action compares
 * it before/after so an expanding row cannot silently move every coordinate the
 * model is holding; see compareLayoutFingerprints. The signature is duplicated
 * in labelPage because page functions are serialized independently.
 * @returns {Record<string, any>}
 */
function pageMetrics() {
  const root = document.scrollingElement || document.documentElement
  const maxY = Math.max(0, root.scrollHeight - root.clientHeight)
  const maxX = Math.max(0, root.scrollWidth - root.clientWidth)
  const active = document.activeElement
  const layout = (() => {
    const items = []
    const nodes = document.querySelectorAll('a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]:not([tabindex="-1"]),canvas,iframe')
    const vw = window.innerWidth
    const vh = window.innerHeight
    let reads = 0
    for (const node of nodes) {
      if (reads >= 600 || items.length >= 40) break
      reads += 1
      const rect = node.getBoundingClientRect()
      if (rect.width < 6 || rect.height < 6) continue
      if (rect.bottom < 1 || rect.right < 1 || rect.top > vh - 1 || rect.left > vw - 1) continue
      // textContent (not innerText) keeps this cheap: no layout/style pass per
      // control, and the key only has to be stable across two views.
      const raw = String(node.textContent ?? '').trim() || String(node.getAttribute?.('aria-label') ?? '')
      const text = raw.slice(0, 256).replace(/\s+/gu, ' ').trim().slice(0, 64)
      items.push({
        tag: node.tagName.toLowerCase(),
        text,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      })
    }
    return items
  })()
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    fingerprint: {
      url: location.href,
      title: document.title,
      scrollX: Math.round(root.scrollLeft || 0),
      scrollY: Math.round(root.scrollTop || 0),
      textLen: String(document.body?.innerText ?? '').length,
      active: active ? `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ''}` : '',
      layout,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    scroll: {
      x: root.scrollLeft || 0,
      y: root.scrollTop || 0,
      maxX,
      maxY,
      container: 'document',
      pageHeight: root.scrollHeight,
      pageWidth: root.scrollWidth,
      atTop: (root.scrollTop || 0) <= 1,
      atBottom: (root.scrollTop || 0) >= maxY - 1,
    },
  }
}

/**
 * Interactive labelling. These functions are serialized into the page and must
 * not reference module state. Label ids are persistent for the lifetime of the
 * page (WeakMap element -> id), so a stale id either resolves to the same
 * element or fails; it never silently lands on a different element.
 *
 * Ids go stale when the page re-renders rather than updates: Gmail-style lists
 * replace list rows and nav links with new nodes, so the labelled element
 * detaches while the replacement is only labelled by the next pass (and gets a
 * new id). The failure shows up as DETACHED while the detached element is still
 * in `byId`; the periodic prune of detached entries above 800 labels drops it,
 * after which the same condition surfaces as UNKNOWN_LABEL from this page
 * context. UNKNOWN_LABEL also covers an id this context never produced (frame
 * navigated, or the registry was reset/pruned). read_text and screenshot do not
 * clear labels themselves — they only give a virtualized page time to re-render.
 * Both codes are recoverable by signature; see resolveLabelSignature below.
 */


/**
 * Label the interactive elements in the current viewport and return view
 * metrics plus the label list. Persistent ids survive relabelling.
 * @param {number} limit maximum labels to render
 * @param {boolean} [paint] wait for the overlay to paint (needed before a capture)
 */
async function labelPage(limit, paint = true) {
  try {
    return await (async () => {
  const LABEL_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    'label',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="radio"]',
    '[role="option"]',
    '[role="combobox"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')
  const OVERLAY_ID = '__crazyagent_label_overlay'
  document.getElementById(OVERLAY_ID)?.remove()
  const state = globalThis.__crazyagent ??= {
    nextId: 1,
    idsByElement: new WeakMap(),
    byId: new Map(),
    infoById: new Map(),
  }
  const labelRole = el => {
    const explicit = el.getAttribute?.('role')
    if (explicit) return explicit
    const tag = el.tagName?.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'label') return 'label'
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    return ''
  }
  const labelText = el => {
    const read = value => String(value ?? '').replace(/\s+/gu, ' ').trim()
    const type = (el.type || '').toLowerCase()
    const labelledBy = el.getAttribute?.('aria-labelledby')
    const candidates = [
      el.getAttribute?.('aria-label'),
      labelledBy
        ? String(labelledBy).split(/\s+/u).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
        : '',
      el.getAttribute?.('title'),
      el.getAttribute?.('alt'),
      type === 'password' ? '' : el.value,
      el.innerText,
      el.textContent,
      el.getAttribute?.('placeholder'),
      el.getAttribute?.('name'),
    ]
    for (const candidate of candidates) {
      const text = read(candidate)
      if (text.length > 0) return text.slice(0, 80)
    }
    return ''
  }

  const root = document.scrollingElement || document.documentElement
  const maxY = Math.max(0, root.scrollHeight - root.clientHeight)
  const maxX = Math.max(0, root.scrollWidth - root.clientWidth)
  const vw = window.innerWidth
  const vh = window.innerHeight

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.setAttribute('aria-hidden', 'true')
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;'

  const labels = []
  const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || 120)))
  // Include open shadow roots: web components keep their controls there.
  const nodes = []
  const collect = root => {
    for (const element of root.querySelectorAll(LABEL_SELECTOR)) nodes.push(element)
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) collect(element.shadowRoot)
    }
  }
  collect(document)
  const candidates = nodes.slice(0, 4000)

  for (const el of candidates) {
    if (labels.length >= cap) break
    if (!(el instanceof Element)) continue
    if (el.closest(`#${OVERLAY_ID}`)) continue
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) continue
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' && (el.type === 'hidden' || el.type === 'file')) continue

    const rect = el.getBoundingClientRect()
    if (rect.width < 6 || rect.height < 6) continue
    if (rect.bottom < 1 || rect.right < 1 || rect.top > vh - 1 || rect.left > vw - 1) continue

    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    if (style.pointerEvents === 'none') continue

    // Only label what a real click would hit at the centre. This keeps modal
    // overlays and cookie banners from exposing targets behind them.
    const cx = Math.max(0, Math.min(vw - 1, rect.left + rect.width / 2))
    const cy = Math.max(0, Math.min(vh - 1, rect.top + rect.height / 2))
    const rootNode = el.getRootNode()
    const hit = rootNode instanceof ShadowRoot && typeof rootNode.elementFromPoint === 'function'
      ? rootNode.elementFromPoint(cx, cy)
      : document.elementFromPoint(cx, cy)
    if (!hit) continue
    const hitRoot = hit.getRootNode?.()
    const hitHost = hitRoot instanceof ShadowRoot ? hitRoot.host : undefined
    if (hit !== el && !el.contains(hit) && !hit.contains(el) && hitHost !== el && !el.contains(hitHost)) continue

    let id = state.idsByElement.get(el)
    if (id === undefined) {
      id = state.nextId++
      state.idsByElement.set(el, id)
      state.byId.set(id, el)
    }
    if (state.byId.get(id) !== el) state.byId.set(id, el)

    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.matches(':disabled')
    const role = labelRole(el)
    const text = labelText(el)
    state.infoById.set(id, { tag, role, text, disabled })
    labels.push({
      id,
      tag,
      role,
      text,
      disabled,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    })

    const badge = document.createElement('div')
    badge.textContent = String(id)
    const bx = Math.max(0, Math.min(vw - 18, rect.left - 7))
    const by = Math.max(0, Math.min(vh - 16, rect.top - 7))
    badge.style.cssText = `position:fixed;left:${bx}px;top:${by}px;min-width:14px;height:15px;padding:0 3px;`
      + 'background:#ffd400;color:#000;border:1px solid #111;border-radius:3px;'
      + 'font:700 10px/14px ui-sans-serif,system-ui,sans-serif;text-align:center;'
      + 'box-shadow:0 1px 2px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;'
    overlay.appendChild(badge)

    const box = document.createElement('div')
    box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;`
      + `width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;`
      + 'border:1px solid rgba(255,196,0,.7);border-radius:2px;pointer-events:none;z-index:2147483646;'
    overlay.appendChild(box)
  }

  const surfaces = []
  for (const candidate of document.querySelectorAll('canvas,video,iframe')) {
    if (surfaces.length >= 8) break
    const box = candidate.getBoundingClientRect()
    if (box.width < 24 || box.height < 24) continue
    if (box.bottom < 1 || box.right < 1 || box.top > vh - 1 || box.left > vw - 1) continue
    surfaces.push({
      kind: candidate.tagName.toLowerCase(),
      x: Math.round(box.left),
      y: Math.round(box.top),
      w: Math.round(box.width),
      h: Math.round(box.height),
    })
  }

  ;(document.body || document.documentElement).appendChild(overlay)

  // Let the compositor paint the overlay before the screenshot is captured.
  // A timeout fallback keeps this progressing where rAF is throttled. Labels-only
  // views skip this: no capture follows, so waiting would only add latency.
  if (paint !== false) {
    await Promise.race([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise(resolve => setTimeout(resolve, 60)),
    ])
  }

  // Drop ids whose elements are gone so the map does not grow forever.
  if (state.byId.size > 800) {
    for (const [id, el] of state.byId) {
      if (!el.isConnected) state.byId.delete(id)
    }
  }

  const activeElement = document.activeElement
  // Same layout signature as pageMetrics: page functions are serialized one at
  // a time, so it cannot share a module helper. A full view stores it as the
  // baseline every skipped-view action is compared against.
  const layout = (() => {
    const items = []
    const nodes = document.querySelectorAll('a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]:not([tabindex="-1"]),canvas,iframe')
    let reads = 0
    for (const node of nodes) {
      if (reads >= 600 || items.length >= 40) break
      reads += 1
      const box = node.getBoundingClientRect()
      if (box.width < 6 || box.height < 6) continue
      if (box.bottom < 1 || box.right < 1 || box.top > vh - 1 || box.left > vw - 1) continue
      // textContent (not innerText) keeps this cheap: no layout/style pass per
      // control, and the key only has to be stable across two views.
      const raw = String(node.textContent ?? '').trim() || String(node.getAttribute?.('aria-label') ?? '')
      const text = raw.slice(0, 256).replace(/\s+/gu, ' ').trim().slice(0, 64)
      items.push({
        tag: node.tagName.toLowerCase(),
        text,
        x: Math.round(box.left),
        y: Math.round(box.top),
        w: Math.round(box.width),
        h: Math.round(box.height),
      })
    }
    return items
  })()
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    fingerprint: {
      url: location.href,
      title: document.title,
      scrollX: Math.round(root.scrollLeft || 0),
      scrollY: Math.round(root.scrollTop || 0),
      textLen: String(document.body?.innerText ?? '').length,
      active: activeElement ? `${activeElement.tagName.toLowerCase()}${activeElement.id ? `#${activeElement.id}` : ''}` : '',
      layout,
    },
    viewport: { width: vw, height: vh, dpr: window.devicePixelRatio || 1 },
    scroll: {
      x: root.scrollLeft || 0,
      y: root.scrollTop || 0,
      maxX,
      maxY,
      container: 'document',
      pageHeight: root.scrollHeight,
      pageWidth: root.scrollWidth,
      atTop: (root.scrollTop || 0) <= 1,
      atBottom: (root.scrollTop || 0) >= maxY - 1,
    },
    labels,
    surfaces,
  }
    })()
  } catch (error) {
    return {
      __labelError: error instanceof Error ? error.message : String(error),
      __stack: error instanceof Error ? String(error.stack) : String(error),
    }
  }
}

/**
 * Choose an option on a native select. A synthetic click cannot open the
 * operating-system dropdown, so the value is set and input/change are fired.
 * @param {number} label
 * @param {string} wanted option text or value
 */
async function selectOption(label, wanted) {
  const state = globalThis.__crazyagent
  const el = state?.byId?.get(label)
  if (!el) return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${label} is not in the current view.` }
  if (el.tagName.toLowerCase() !== 'select') {
    return { ok: false, code: 'NOT_SELECT', message: `Label ${label} is a ${el.tagName.toLowerCase()}, not a select.` }
  }
  const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLowerCase()
  const target = normalize(wanted)
  if (target.length === 0) return { ok: false, code: 'BAD_OPTION', message: 'option must be a non-empty string' }
  const options = Array.from(el.options)
  const match = options.find(option => normalize(option.value) === target)
    ?? options.find(option => normalize(option.textContent) === target)
    ?? options.find(option => normalize(option.textContent).includes(target) || normalize(option.value).includes(target))
  if (!match) {
    return {
      ok: false,
      code: 'OPTION_NOT_FOUND',
      message: `No option matched ${JSON.stringify(wanted)}. Options: ${options.slice(0, 40).map(option => JSON.stringify((option.textContent || '').trim())).join(', ')}`,
    }
  }
  const previousValue = String(el.value ?? '')
  el.focus?.({ preventScroll: true })
  el.value = match.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 80))
  return {
    ok: true,
    previousValue,
    selected: { value: match.value, text: (match.textContent || '').trim() },
    selectedIndex: el.selectedIndex,
  }
}

/**
 * Hover a labelled element: menus that open on hover become visible and
 * clickable in the returned view.
 * @param {number} label
 */
async function hoverLabelled(label) {
  const state = globalThis.__crazyagent
  const el = state?.byId?.get(label)
  if (!el) return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${label} is not in the current view.` }
  if (!el.isConnected) return { ok: false, code: 'DETACHED', message: `Label ${label} no longer exists.` }
  const info = state?.infoById?.get(label) ?? {}
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  await Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise(resolve => setTimeout(resolve, 60)),
  ])
  const rect = el.getBoundingClientRect()
  const cx = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2))
  const cy = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2))
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 }
  el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerType: 'mouse', isPrimary: true }))
  el.dispatchEvent(new PointerEvent('pointerenter', { ...base, pointerType: 'mouse', isPrimary: true }))
  el.dispatchEvent(new MouseEvent('mouseover', base))
  el.dispatchEvent(new MouseEvent('mousemove', base))
  await new Promise(resolve => setTimeout(resolve, 220))
  return { ok: true, hovered: { label, tag: info.tag ?? el.tagName.toLowerCase(), role: info.role ?? '', text: info.text ?? '' } }
}

/** Remove the label overlay from the active tab. */
function clearLabelsPage() {
  document.getElementById('__crazyagent_label_overlay')?.remove()
  return { ok: true }
}

/**
 * True when an element's rect is fully inside the viewport, minus a small
 * margin. This is the scroll policy for labelled clicks. It is a pure copy of
 * the in-page check in clickLabelled because injected functions are serialized
 * alone and cannot reference module helpers.
 * @param {{top: number, left: number, bottom: number, right: number, width?: number, height?: number}} rect
 * @param {{width: number, height: number}} viewport
 * @param {number} [margin]
 */
export function isRectFullyVisible(rect, viewport, margin = SCROLL_VISIBLE_MARGIN_PX) {
  if (!rect) return false
  const width = Number(viewport?.width) || 0
  const height = Number(viewport?.height) || 0
  if (width <= 0 || height <= 0) return false
  if (Number(rect.width) < 1 || Number(rect.height) < 1) return false
  const inset = Math.max(0, Number(margin) || 0)
  return Number(rect.top) >= inset
    && Number(rect.left) >= inset
    && Number(rect.bottom) <= height - inset
    && Number(rect.right) <= width - inset
}

/**
 * Compact retry hint for stale-label failures: the current label list, capped
 * so the error message cannot balloon. Labels whose text matches the failed
 * element's text are listed first so the model can re-aim without paying a
 * fresh view round trip. Pure, so the cap behavior is testable without Chrome.
 * @param {Array<Record<string, any>>} labels
 * @param {{maxLabels?: number, maxChars?: number, preferText?: string}} [options]
 */
export function formatLabelsHint(labels, options = {}) {
  const maxLabels = Math.max(1, Math.min(
    LABEL_HINT_MAX_LABELS,
    Number.isFinite(Number(options.maxLabels)) ? Math.floor(Number(options.maxLabels)) : LABEL_HINT_MAX_LABELS,
  ))
  const maxChars = Math.max(1, Number.isFinite(Number(options.maxChars)) ? Math.floor(Number(options.maxChars)) : LABEL_HINT_MAX_CHARS)
  const prefer = String(options.preferText ?? '').replace(/\s+/gu, ' ').trim().toLowerCase()
  const candidates = []
  for (const label of Array.isArray(labels) ? labels : []) {
    if (!label || !Number.isFinite(Number(label.id))) continue
    const text = String(label.text ?? '').replace(/\s+/gu, ' ').trim()
    const role = String(label.role || label.tag || 'element')
    const haystack = text.toLowerCase()
    let relevance = 0
    if (prefer.length > 0 && haystack.length > 0) {
      if (haystack === prefer) relevance = 2
      else if (haystack.includes(prefer) || prefer.includes(haystack)) relevance = 1
    }
    candidates.push({ id: Number(label.id), role, text, disabled: label.disabled === true, relevance })
  }
  // Stable in modern JS: equal relevance keeps the view's (DOM) order.
  candidates.sort((a, b) => b.relevance - a.relevance)
  const parts = []
  let used = 'Current labels: '.length
  for (const label of candidates) {
    if (parts.length >= maxLabels) break
    const quoted = label.text.length > 0 ? ` ${JSON.stringify(label.text.slice(0, 60))}` : ''
    const part = `[${label.id}] ${label.role}${quoted}${label.disabled ? ' (disabled)' : ''}`
    if (parts.length > 0 && used + part.length + 2 > maxChars) break
    parts.push(part)
    used += part.length + 2
  }
  if (parts.length === 0) return 'Current labels: none visible on the page right now.'
  const remaining = candidates.length - parts.length
  return `Current labels: ${parts.join('; ')}${remaining > 0 ? `; … ${remaining} more` : ''}`
}

/**
 * Normalize one signature source (a recorded label signature or a fresh label)
 * into the comparable {tag, role, text, frame} shape. Inner whitespace is
 * collapsed because a fresh labelling pass reads the text off the live DOM
 * again, and an optional frame keeps recovery inside the frame the label came
 * from. Pure helper.
 * @param {{tag?: unknown, role?: unknown, text?: unknown, frame?: unknown, frameId?: unknown}} [source]
 * @returns {{tag: string, role: string, text: string, frame: number | undefined}}
 */
function normalizeLabelSignature(source) {
  const read = value => String(value ?? '').replace(/\s+/gu, ' ').trim()
  const frameValue = source?.frame ?? source?.frameId
  return {
    tag: read(source?.tag).toLowerCase(),
    role: read(source?.role).toLowerCase(),
    text: read(source?.text),
    frame: Number.isFinite(Number(frameValue)) ? Number(frameValue) : undefined,
  }
}

/**
 * Frame a label belongs to; labels from the top frame carry no frame marker.
 * @param {Record<string, any>} label
 */
function labelFrame(label) {
  return Number.isFinite(Number(label?.frame)) ? Number(label.frame) : 0
}

/**
 * Recover a stale label id by matching its recorded signature against a fresh
 * label list. Label ids are keyed on element identity, so a re-render (Gmail
 * replaces virtualized list rows instead of updating them) detaches the old
 * element and the replacement gets a new id. The only safe recovery is an
 * exact, unique match on tag, role, and text: zero matches or more than one
 * candidate means any pick would be a guess, and a wrong click is worse than a
 * stale-label error. A signature with no text carries no identifying value and
 * is refused too. Pure, so the refusal behavior is testable without Chrome.
 * @param {Array<Record<string, any>>} candidateLabels labels from a fresh pass
 * @param {{tag?: string, role?: string, text?: string, frame?: number, frameId?: number}} signature recorded tag/role/text
 * @returns {{matched: true, label: Record<string, any>, candidateCount: number}
 *   | {matched: false, reason: 'WEAK_SIGNATURE'|'NO_MATCH'|'AMBIGUOUS', candidateCount: number, matchCount: number}}
 */
export function resolveLabelSignature(candidateLabels, signature) {
  const wanted = normalizeLabelSignature(signature)
  const candidates = (Array.isArray(candidateLabels) ? candidateLabels : [])
    .filter(label => label && Number.isFinite(Number(label.id)))
  const candidateCount = candidates.length
  if (wanted.text.length === 0) {
    return { matched: false, reason: 'WEAK_SIGNATURE', candidateCount, matchCount: 0 }
  }
  const matches = candidates.filter(label => {
    if (wanted.frame !== undefined && labelFrame(label) !== wanted.frame) return false
    const candidate = normalizeLabelSignature(label)
    return candidate.tag === wanted.tag
      && candidate.role === wanted.role
      && candidate.text === wanted.text
  })
  if (matches.length === 1) return { matched: true, label: matches[0], candidateCount }
  return {
    matched: false,
    reason: matches.length === 0 ? 'NO_MATCH' : 'AMBIGUOUS',
    candidateCount,
    matchCount: matches.length,
  }
}

/**
 * A recovery is only safe while the tab is still on the page the label was
 * recorded for: an identical control on a different page is a different
 * element. Unknown URLs do not block, matching how the registry resolves ids.
 * @param {chrome.tabs.Tab} tab
 * @param {string} url
 */
async function isSamePage(tab, url) {
  if (typeof url !== 'string' || url.length === 0) return true
  const current = await chrome.tabs.get(tab.id).catch(() => undefined)
  return current !== undefined && (current.url ?? '') === url
}

/**
 * True when a stale-label failure code means the labelled element itself is
 * gone, so the id may be recoverable by signature. NOT_VISIBLE is deliberately
 * not recoverable: that element still exists, it just has no box right now, so
 * a same-text control would be a different element. Pure, so the recovery
 * policy is testable without Chrome.
 * @param {unknown} code
 */
export function isRecoverableLabelCode(code) {
  return RECOVERABLE_LABEL_CODES.has(String(code ?? ''))
}

/**
 * Re-label the active page and try to recover a stale label id by the
 * signature recorded in the label registry. Returns the fresh label list even
 * when recovery is refused, so the retry hint can reuse it instead of paying a
 * second labelling pass. Best effort: any labelling failure means no recovery
 * and the caller keeps its original stale-label error. Refused when the tab has
 * left the page the labels came from, because a lookalike elsewhere is a
 * different element.
 * @param {chrome.tabs.Tab} tab
 * @param {{frameId?: number, tag?: string, role?: string, text?: string}} [recorded] registry entry for the stale id
 * @param {string} [pageUrl] URL the labels were recorded for
 * @returns {Promise<{labels?: Array<Record<string, any>>, recovered?: {label: number, frameId: number, localId: number, signature: {tag: string, role: string, text: string, frame: number | undefined}}}>}
 */
async function recoverStaleLabel(tab, recorded, pageUrl) {
  const signature = {
    tag: recorded?.tag,
    role: recorded?.role,
    text: recorded?.text,
    frame: recorded?.frameId,
  }
  // A signature with no text can never match, so do not pay a label pass for
  // it; the caller's stale-label error path gets its own hint pass instead.
  if (normalizeLabelSignature(signature).text.length === 0) return {}
  if (!(await isSamePage(tab, pageUrl))) return {}
  let labelled
  try {
    labelled = await labelOnly(tab)
  } catch {
    return {}
  }
  const resolved = resolveLabelSignature(labelled.labels, signature)
  if (!resolved.matched) return { labels: labelled.labels }
  const fresh = resolveLabelTarget(tab, resolved.label.id)
  if (!fresh) return { labels: labelled.labels }
  return {
    labels: labelled.labels,
    recovered: {
      label: resolved.label.id,
      frameId: fresh.frameId,
      localId: fresh.localId,
      signature: normalizeLabelSignature(signature),
    },
  }
}

/**
 * Append a fresh label list to a stale-label BrowserError before it is logged
 * and forwarded, so the model can retry without paying a whole view round trip.
 * Fail-closed: it never re-resolves or auto-clicks anything, and it only appends
 * to the message — the original error code and message are preserved. Label
 * collection is best effort; a failure here leaves the original error untouched.
 * @param {chrome.tabs.Tab} tab
 * @param {BrowserError} error
 * @param {string} [preferText]
 * @param {Array<Record<string, any>>} [freshLabels] labels already fetched by a recovery attempt
 */
async function decorateStaleLabelError(tab, error, preferText, freshLabels) {
  if (!error || !STALE_LABEL_CODES.has(error.code)) return error
  try {
    const labels = Array.isArray(freshLabels) ? freshLabels : (await labelOnly(tab)).labels
    const hint = formatLabelsHint(labels, { preferText })
    if (typeof hint === 'string' && hint.length > 0) error.message = `${error.message} ${hint}`
  } catch {
    // Best effort only: never mask the original failure.
  }
  return error
}

/**
 * Click one labelled element by dispatching the pointer/mouse sequence a real
 * click produces, then report whether the page changed.
 * @param {number} label persistent label id
 */
async function clickLabelled(label) {
  const __t0 = performance.now()
  const state = globalThis.__crazyagent
  const el = state?.byId?.get(label)
  if (!el) {
    return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${label} is not in the current view. Take a fresh screenshot to get current labels.` }
  }
  if (!el.isConnected) {
    return { ok: false, code: 'DETACHED', message: `Label ${label} no longer exists on the page. Take a fresh screenshot.` }
  }
  const info = state?.infoById?.get(label) ?? {}
  const tag = info.tag ?? el.tagName.toLowerCase()
  const role = info.role ?? ''
  const text = info.text ?? ''
  const disabled = info.disabled === true || el.disabled === true || el.getAttribute('aria-disabled') === 'true'
  if (disabled) {
    return { ok: false, code: 'DISABLED', message: `Label ${label} (${tag} ${JSON.stringify(text)}) is disabled and cannot be clicked.`, clicked: { label, tag, role, text } }
  }

  // Scroll only when the target is not already fully inside the viewport: a
  // click that scrolls invalidates the stored screenshot's image coordinates,
  // so an already-visible target must never move the page.
  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = 4
  const documentScrollTop = () => Math.round((document.scrollingElement || document.documentElement).scrollTop || 0)
  const fullyVisible = box => box.width >= 1 && box.height >= 1
    && box.top >= margin && box.left >= margin
    && box.bottom <= vh - margin && box.right <= vw - margin
  let rect = el.getBoundingClientRect()
  const scrollFromY = documentScrollTop()
  let scrolledIntoView = false
  if (!fullyVisible(rect)) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    scrolledIntoView = true
    await Promise.race([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise(resolve => setTimeout(resolve, 60)),
    ])
    rect = el.getBoundingClientRect()
  }
  const __tScroll = performance.now()
  const scrollToY = documentScrollTop()
  const scroll = { fromY: scrollFromY, toY: scrollToY, dy: scrollToY - scrollFromY }

  const __tRaf = performance.now()
  if (rect.width < 1 || rect.height < 1) {
    return { ok: false, code: 'NOT_VISIBLE', message: `Label ${label} has no visible box. Take a fresh screenshot.` }
  }
  const cx = Math.max(0, Math.min(vw - 1, rect.left + rect.width / 2))
  const cy = Math.max(0, Math.min(vh - 1, rect.top + rect.height / 2))
  const rootNode = el.getRootNode()
  const hit = rootNode instanceof ShadowRoot && typeof rootNode.elementFromPoint === 'function'
    ? rootNode.elementFromPoint(cx, cy)
    : document.elementFromPoint(cx, cy)
  const hitRoot = hit?.getRootNode?.()
  const hitHost = hitRoot instanceof ShadowRoot ? hitRoot.host : undefined
  if (!hit || (hit !== el && !el.contains(hit) && !hit.contains(el) && hitHost !== el && !el.contains(hitHost))) {
    return {
      ok: false,
      code: 'OBSCURED',
      message: `Label ${label} is covered by another element at its centre. Dismiss the overlay or take a fresh view.`,
      clicked: { label, tag, role, text },
    }
  }

  const rippleStyleId = '__crazyagent_click_ripple_style'
  const style = document.getElementById(rippleStyleId) ?? document.createElement('style')
  style.id = rippleStyleId
  style.textContent = '@keyframes __crazyagent_click_ripple{0%{transform:scale(.65);opacity:.7}65%{opacity:.35}100%{transform:scale(2.1);opacity:0}}@keyframes __crazyagent_click_crosshair{0%{transform:scale(.85);opacity:1}55%{opacity:.8}100%{transform:scale(1);opacity:0}}'
  if (!style.isConnected) (document.head || document.documentElement).appendChild(style)
  const ripple = document.createElement('div')
  ripple.setAttribute('aria-hidden', 'true')
  ripple.setAttribute('data-crazyagent-click-ripple', '')
  ripple.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;z-index:2147483647;pointer-events:none;`
  for (let index = 0; index < 2; index += 1) {
    const ring = document.createElement('div')
    ring.setAttribute('data-crazyagent-click-ring', '')
    ring.style.cssText = `position:absolute;left:-9px;top:-9px;width:18px;height:18px;box-sizing:border-box;border:1px solid rgba(255,195,0,.85);border-radius:50%;background:transparent;box-shadow:0 0 6px rgba(255,195,0,.12);animation:__crazyagent_click_ripple .65s cubic-bezier(.2,.55,.3,1) ${index * 0.12}s forwards;`
    ripple.appendChild(ring)
  }
  const crosshair = document.createElement('div')
  crosshair.setAttribute('data-crazyagent-click-crosshair', '')
  crosshair.style.cssText = 'position:absolute;left:-7px;top:-7px;width:14px;height:14px;animation:__crazyagent_click_crosshair .6s ease-out forwards;'
  const parts = [
    'left:6px;top:0;width:2px;height:4px',
    'left:6px;bottom:0;width:2px;height:4px',
    'left:0;top:6px;width:4px;height:2px',
    'right:0;top:6px;width:4px;height:2px',
    'left:6px;top:6px;width:2px;height:2px;border-radius:50%',
  ]
  for (const part of parts) {
    const tick = document.createElement('div')
    tick.style.cssText = `position:absolute;${part};background:#ffc300;box-shadow:0 0 4px rgba(255,195,0,.2);`
    crosshair.appendChild(tick)
  }
  ripple.appendChild(crosshair)
  ;(document.body || document.documentElement).appendChild(ripple)
  setTimeout(() => ripple.remove(), 900)

  const fingerprint = () => ({
    url: location.href,
    title: document.title,
    scrollY: Math.round((document.scrollingElement || document.documentElement).scrollTop || 0),
    textLen: (document.body?.innerText || '').length,
    dialogs: document.querySelectorAll('dialog[open],[role="dialog"]:not([aria-hidden="true"]),[role="alertdialog"]').length,
  })
  const before = fingerprint()
  const __tDispatch = performance.now()
  let mutations = 0
  const observer = new MutationObserver(records => { mutations += records.length })
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })

  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: cx,
    clientY: cy,
    screenX: cx,
    screenY: cy,
    button: 0,
    detail: 1,
  }
  try {
    el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mouseover', base))
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
    if (typeof el.focus === 'function') el.focus({ preventScroll: true })
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
  } catch (error) {
    observer.disconnect()
    return { ok: false, code: 'DISPATCH_FAILED', message: error instanceof Error ? error.message : String(error), clicked: { label, tag, role, text } }
  }

  // Links and submit buttons may unload the frame; observing would hang until
  // the timeout. Report dispatch and let the tab-level wait confirm navigation.
  const navigationProne = tag === 'a'
    || (tag === 'button' && (el.type === 'submit' || (el.form !== null && el.form !== undefined)))
    || (tag === 'input' && (el.type === 'submit' || el.type === 'image'))
  if (navigationProne) {
    observer.disconnect()
    return { ok: true, clicked: { label, tag, role, text }, changed: true, signals: ['navigation-possible'], mutations: 0, pendingNavigation: true, scroll, scrolledIntoView }
  }

  // Resolve as soon as the page reacts, with a short ceiling. A click that
  // changes nothing still costs the full window so the result is trustworthy.
  await new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      observer.disconnect()
      resolve()
    }
    const timer = setTimeout(finish, 150)
    const settle = new MutationObserver(() => {
      if (performance.now() - __tDispatch > 20) finish()
    })
    settle.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    setTimeout(() => settle.disconnect(), 160)
  })

  const after = fingerprint()
  const signals = []
  if (after.url !== before.url) signals.push('url-change')
  if (after.title !== before.title) signals.push('title-change')
  if (after.scrollY !== before.scrollY) signals.push('scroll-change')
  if (after.textLen !== before.textLen) signals.push('text-change')
  if (after.dialogs !== before.dialogs) signals.push('dialog-change')
  if (mutations > 0) signals.push(`dom-mutations:${mutations}`)
  if ('checked' in el) signals.push(`checked:${Boolean(el.checked)}`)
  const expanded = el.getAttribute('aria-expanded')
  if (expanded !== null) signals.push(`expanded:${expanded}`)
  const selected = el.getAttribute('aria-selected')
  if (selected !== null) signals.push(`selected:${selected}`)

  return {
    ok: true,
    clicked: { label, tag, role, text },
    changed: signals.length > 0,
    signals,
    mutations,
    scroll,
    scrolledIntoView,
    timings: {
      resolveMs: Math.round(__tScroll - __t0),
      rafMs: Math.round(__tRaf - __tScroll),
      dispatchMs: Math.round(__tDispatch - __tRaf),
      observeMs: Math.round(performance.now() - __tDispatch),
    },
  }
}

/**
 * Type into a labelled field from inside the page. Self-contained: chrome
 * scripting serializes this source, so it must not reference module state.
 * Returns verification so the caller can fall back to trusted Input.insertText.
 * @param {number} label
 * @param {string} text
 * @param {'replace'|'append'} mode
 */
async function typeLabelled(label, text, mode) {
  const state = globalThis.__crazyagent
  const el = state?.byId?.get(label)
  if (!el) return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${label} is not in the current view.` }
  if (!el.isConnected) return { ok: false, code: 'DETACHED', message: `Label ${label} no longer exists.` }
  const info = state?.infoById?.get(label) ?? {}
  const tag = el.tagName.toLowerCase()
  const type = (el.type || '').toLowerCase()
  const disabled = info.disabled === true || el.disabled === true || el.getAttribute('aria-disabled') === 'true'
  if (disabled) return { ok: false, code: 'DISABLED', message: `Label ${label} is disabled and cannot be typed into.` }
  const isField = tag === 'input' || tag === 'textarea'
  const isPassword = tag === 'input' && type === 'password'
  const acceptsText = tag === 'input' ? !['checkbox', 'radio', 'file', 'hidden'].includes(type) : tag === 'textarea'
  const editable = acceptsText || el.isContentEditable === true
  if (!editable) {
    return { ok: false, code: 'NOT_EDITABLE', message: `Label ${label} (${tag}${type ? `:${type}` : ''}) does not accept text.` }
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  if (typeof el.focus === 'function') el.focus({ preventScroll: true })
  await Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise(resolve => setTimeout(resolve, 60)),
  ])
  const read = () => isField ? String(el.value ?? '') : String(el.innerText ?? el.textContent ?? '')
  const preview = value => isPassword ? `[password ${value.length} chars]` : value.slice(0, 120)
  const before = read()
  if (isField) {
    // The native setter bypasses framework value trackers so React/Vue see the
    // same event a user would produce.
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    const next = mode === 'append' ? before + text : text
    if (descriptor?.set) descriptor.set.call(el, next)
    else el.value = next
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: text.length === 0 ? 'deleteContentBackward' : 'insertText',
      data: text,
    }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    const selection = window.getSelection()
    selection?.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(el)
    if (mode === 'append') range.collapse(false)
    selection?.addRange(range)
    try {
      if (text.length === 0) document.execCommand('delete')
      else document.execCommand('insertText', false, text)
    } catch {
      // Verification below decides whether the trusted fallback is needed.
    }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: text.length === 0 ? 'deleteContentBackward' : 'insertText',
      data: text,
    }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const after = read()
  const expected = mode === 'append' ? before + text : text
  const normalize = value => String(value).replace(/\s+/gu, ' ').trim()
  const verified = after === expected || (!isField && normalize(after) === normalize(expected))
  return {
    ok: true,
    tag,
    type,
    isPassword,
    beforeChars: before.length,
    beforePreview: preview(before),
    afterChars: after.length,
    valuePreview: preview(after),
    verified,
  }
}

/**
 * Focus a labelled field and place the caret or selection for trusted typing.
 * Self-contained page function.
 * @param {number} label
 * @param {'replace'|'append'} mode
 */
async function prepareLabelledTyping(label, mode) {
  const state = globalThis.__crazyagent
  const el = state?.byId?.get(label)
  if (!el) return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${label} is not in the current view.` }
  if (!el.isConnected) return { ok: false, code: 'DETACHED', message: `Label ${label} no longer exists.` }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  if (typeof el.focus === 'function') el.focus({ preventScroll: true })
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') {
    if (mode === 'replace') el.select?.()
    else {
      const end = String(el.value ?? '').length
      el.setSelectionRange?.(end, end)
    }
  } else if (el.isContentEditable === true) {
    const selection = window.getSelection()
    selection?.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(el)
    if (mode === 'append') range.collapse(false)
    selection?.addRange(range)
  } else {
    return { ok: false, code: 'NOT_EDITABLE', message: `Label ${label} does not accept text.` }
  }
  await Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise(resolve => setTimeout(resolve, 60)),
  ])
  return { ok: true }
}

/**
 * Read a labelled field's value length and masked preview. Self-contained.
 * @param {number} label
 */
function readLabelledField(label) {
  const state = globalThis.__crazyagent
  const el = state?.byId?.get(label)
  if (!el || !el.isConnected) return { ok: false, code: 'DETACHED', message: `Label ${label} no longer exists.` }
  const tag = el.tagName.toLowerCase()
  const type = (el.type || '').toLowerCase()
  const isPassword = tag === 'input' && type === 'password'
  const value = (tag === 'input' || tag === 'textarea')
    ? String(el.value ?? '')
    : String(el.innerText ?? el.textContent ?? '')
  return {
    ok: true,
    chars: value.length,
    preview: isPassword ? `[password ${value.length} chars]` : value.slice(0, 120),
    isPassword,
  }
}

/**
 * Read whatever field currently has focus in the top frame. Self-contained.
 * Used by label-less trusted typing, where the caret was placed by a click.
 */
function readFocusedField() {
  const el = document.activeElement
  if (!el) return { chars: 0, preview: '', isPassword: false, tag: '' }
  const tag = el.tagName.toLowerCase()
  const type = (el.type || '').toLowerCase()
  const isPassword = tag === 'input' && type === 'password'
  let value = ''
  if (tag === 'input' || tag === 'textarea') value = String(el.value ?? '')
  else if (el.isContentEditable === true) value = String(el.innerText ?? el.textContent ?? '')
  return {
    chars: value.length,
    preview: isPassword ? `[password ${value.length} chars]` : value.slice(0, 120),
    isPassword,
    tag: `${tag}${type ? `:${type}` : ''}`,
  }
}

/**
 * Page-level content probe for label-less trusted typing. `start` installs a
 * short-lived MutationObserver and snapshots the frame's rendered text and its
 * focused element; `end` disconnects the observer and returns the same shape
 * plus the accumulated mutation count. Self-contained page function.
 *
 * A visible input/textarea/contenteditable can verify its own value. Aggregate
 * text length and mutations are only hints: they cannot establish that input
 * landed in a canvas document. Known canvas editors skip this probe entirely and
 * use the full fresh view instead.
 * @param {'start'|'end'} phase
 */
function contentProbePage(phase) {
  const KEY = '__crazyagentContentProbe'
  const state = globalThis[KEY] ?? { mutations: 0, startedAt: 0, observer: undefined }
  globalThis[KEY] = state
  const readFocus = () => {
    const el = document.activeElement
    if (!el) return undefined
    const tag = el.tagName.toLowerCase()
    const type = (el.type || '').toLowerCase()
    const isField = tag === 'input' || tag === 'textarea'
    const editable = el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true'
    const readable = isField || editable
    const isPassword = isField && type === 'password'
    const value = isField ? String(el.value ?? '') : String(el.innerText ?? el.textContent ?? '')
    let rect
    try {
      rect = el.getBoundingClientRect()
    } catch {
      rect = undefined
    }
    // A contenteditable body inside a 1px event-target iframe is not the editor
    // and its text is not a measurement of what landed; require a real box.
    const measurable = readable && Boolean(rect) && rect.width >= 8 && rect.height >= 8
    const path = []
    for (let node = el, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
      const nodeTag = node.tagName.toLowerCase()
      if (node.id) {
        path.unshift(`${nodeTag}#${node.id}`)
        break
      }
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName)
        : [node]
      path.unshift(`${nodeTag}[${siblings.indexOf(node)}]`)
    }
    return {
      tag,
      type,
      identity: path.join('/'),
      isField,
      editable,
      readable,
      measurable,
      hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : false,
      chars: readable ? value.length : 0,
      // Passwords are masked exactly like readFocusedField did, so a preview
      // never leaks one; the length still distinguishes empty from filled.
      preview: !readable ? '' : isPassword ? `[password ${value.length} chars]` : value.slice(0, 120),
      isPassword,
    }
  }
  const snapshot = () => ({
    url: location.href,
    title: document.title,
    textLen: String(document.body?.innerText ?? '').length,
    focus: readFocus(),
    mutations: Math.max(0, Math.round(Number(state.mutations) || 0)),
  })
  if (phase === 'start') {
    state.observer?.disconnect()
    state.mutations = 0
    state.startedAt = performance.now()
    state.observer = new MutationObserver(records => { state.mutations += records.length })
    state.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true })
    return { ...snapshot(), startedAt: state.startedAt }
  }
  const snapshotAfter = snapshot()
  const elapsedMs = Math.max(0, Math.round(performance.now() - (Number(state.startedAt) || performance.now())))
  state.observer?.disconnect()
  state.observer = undefined
  state.mutations = 0
  return { ...snapshotAfter, elapsedMs }
}

/**
 * Synthetic key fallback when the debugger cannot attach. Self-contained page
 * function; dispatches keydown/keyup on the focused element.
 * @param {string} key
 * @param {string} code
 * @param {number} keyCode
 * @param {number} modifiers CDP bitmask (alt=1, ctrl=2, meta=4, shift=8)
 */
function syntheticKeyPage(key, code, keyCode, modifiers) {
  const target = document.activeElement || document.body || document.documentElement
  const init = {
    key,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: (modifiers & 2) !== 0,
    altKey: (modifiers & 1) !== 0,
    metaKey: (modifiers & 4) !== 0,
    shiftKey: (modifiers & 8) !== 0,
  }
  target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  return { dispatched: true, target: target.id || target.tagName || '' }
}

/**
 * Poll page conditions until they all hold or the budget expires. Self-contained
 * page function. `ms` is fulfilled by the caller's page-side delay, so it only
 * has to be reported, not waited for again.
 * @param {{text: string|null, url: string|null, idle: boolean}} conditions
 * @param {number} timeoutMs
 */
async function waitForConditionsPage(conditions, timeoutMs) {
  const started = performance.now()
  const deadline = started + Math.max(0, Number(timeoutMs) || 0)
  let lastMutationAt = performance.now()
  let observer
  if (conditions.idle === true) {
    observer = new MutationObserver(() => { lastMutationAt = performance.now() })
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  }
  const wantedText = typeof conditions.text === 'string' ? conditions.text.toLowerCase() : null
  const wantedUrl = typeof conditions.url === 'string' ? conditions.url : null
  const check = () => {
    if (wantedText !== null) {
      const bodyText = String(document.body?.innerText ?? '').toLowerCase()
      if (!bodyText.includes(wantedText)) return false
    }
    if (wantedUrl !== null && !String(location.href).includes(wantedUrl)) return false
    if (conditions.idle === true && performance.now() - lastMutationAt < 300) return false
    return true
  }
  let found = check()
  while (!found && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    found = check()
  }
  observer?.disconnect()
  return { found, elapsedMs: Math.round(performance.now() - started) }
}

/**
 * Read the current top-frame text selection. Self-contained page function.
 */
function readSelection() {
  const selection = window.getSelection()
  const raw = String(selection?.toString() ?? '')
  let rect = null
  try {
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0).getBoundingClientRect()
      rect = {
        x: Math.round(range.left),
        y: Math.round(range.top),
        w: Math.round(range.width),
        h: Math.round(range.height),
      }
    }
  } catch {
    rect = null
  }
  return {
    text: raw.slice(0, 4_000),
    chars: Math.min(raw.length, 4_000),
    totalChars: raw.length,
    collapsed: selection ? selection.isCollapsed !== false : true,
    rect,
  }
}

/**
 * Read the current top-frame text selection for the clipboard. Self-contained
 * page function: the plain `readSelection` used by the select tool caps text at
 * 4,000 chars for preview, but a copy should carry the whole selection up to the
 * clipboard limit.
 * @param {number} limit
 */
function readSelectionForClipboard(limit) {
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 100_000) : 100_000
  const selection = window.getSelection()
  const raw = String(selection?.toString() ?? '')
  return {
    text: raw.slice(0, cap),
    chars: Math.min(raw.length, cap),
    totalChars: raw.length,
    collapsed: selection ? selection.isCollapsed !== false : true,
  }
}

/**
 * Read one labelled element as clipboard text. Self-contained page function:
 * chrome.scripting serializes this source alone, so it must not reference
 * module constants or helpers.
 *
 * Inputs and textareas contribute their value; other elements contribute their
 * rendered innerText, then aria-label, then textContent. Closed shadow roots are
 * intentionally not reachable. Password fields are refused so secrets never
 * flow into the clipboard through a label.
 * @param {number} label
 */
function readLabelClipboardText(label) {
  const state = globalThis.__crazyagent
  const el = state?.byId?.get(label)
  if (!el) return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${label} is not in the current view. Take a fresh screenshot.` }
  if (!el.isConnected) return { ok: false, code: 'DETACHED', message: `Label ${label} no longer exists. Take a fresh screenshot.` }
  const tag = String(el.tagName ?? '').toLowerCase()
  const type = String(el.type ?? '').toLowerCase()
  if (tag === 'input' && type === 'password') {
    return { ok: false, code: 'PROTECTED_FIELD', message: `Label ${label} is a password field; its value cannot be copied.` }
  }
  const LIMIT = 100_000
  let text = ''
  let readFrom = 'innerText'
  if (tag === 'input' || tag === 'textarea') {
    text = String(el.value ?? '')
    readFrom = 'value'
  } else if (el.isContentEditable === true) {
    text = String(el.innerText ?? el.textContent ?? '')
  } else {
    const inner = String(el.innerText ?? '')
    if (inner.trim().length > 0) {
      text = inner
    } else {
      const aria = el.getAttribute?.('aria-label')
      if (typeof aria === 'string' && aria.trim().length > 0) {
        text = aria
        readFrom = 'aria-label'
      } else {
        text = String(el.textContent ?? '')
        readFrom = 'textContent'
      }
    }
  }
  text = text.trim()
  return {
    ok: true,
    text: text.slice(0, LIMIT),
    chars: Math.min(text.length, LIMIT),
    totalChars: text.length,
    tag,
    readFrom,
  }
}

/**
 * Synthetic drag fallback: one self-contained page script pointer/mouse
 * sequence from one point to another.
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 */
async function syntheticDrag(fromX, fromY, toX, toY) {
  const start = document.elementFromPoint(fromX, fromY)
  if (!start) return { ok: false, reason: 'no-element' }
  const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 1 }
  start.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: fromX, clientY: fromY, buttons: 1, pointerType: 'mouse', isPrimary: true }))
  start.dispatchEvent(new MouseEvent('mousedown', { ...base, clientX: fromX, clientY: fromY, buttons: 1 }))
  const steps = 4
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    const x = fromX + (toX - fromX) * progress
    const y = fromY + (toY - fromY) * progress
    const target = document.elementFromPoint(x, y) || start
    target.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, clientY: y, buttons: 1, pointerType: 'mouse', isPrimary: true }))
    target.dispatchEvent(new MouseEvent('mousemove', { ...base, clientX: x, clientY: y, buttons: 1 }))
  }
  start.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: toX, clientY: toY, buttons: 0, pointerType: 'mouse', isPrimary: true }))
  start.dispatchEvent(new MouseEvent('mouseup', { ...base, clientX: toX, clientY: toY, buttons: 0 }))
  return { ok: true }
}

/**
 * Focus a typing target for a non-editable labelled surface: the element itself
 * when it accepts text, otherwise a descendant or ancestor contenteditable,
 * textarea, input, or [role="textbox"]. Self-contained page function.
 * @param {number} label
 */
function focusTypingTarget(label) {
  const state = globalThis.__crazyagent
  const el = state?.byId?.get(label)
  if (!el) return { ok: false, code: 'UNKNOWN_LABEL', message: `Label ${label} is not in the current view.` }
  if (!el.isConnected) return { ok: false, code: 'DETACHED', message: `Label ${label} no longer exists.` }
  const TYPING_SELECTOR = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
  const typingTarget = node => {
    if (!node || node.nodeType !== 1) return null
    if (node.matches?.(TYPING_SELECTOR)) return node
    if (node.isContentEditable === true) return node
    return null
  }
  let target = typingTarget(el)
  if (!target) target = el.querySelector?.(TYPING_SELECTOR) ?? null
  if (!target) {
    let ancestor = el.parentElement
    while (ancestor && !target) {
      target = typingTarget(ancestor) ?? ancestor.querySelector?.(TYPING_SELECTOR) ?? null
      ancestor = ancestor.parentElement
    }
  }
  if (!target) {
    return { ok: false, code: 'NOT_EDITABLE', message: `Label ${label} has no focusable editable target.` }
  }
  if (target.disabled === true || target.getAttribute?.('aria-disabled') === 'true') {
    return { ok: false, code: 'DISABLED', message: `Label ${label} resolves to a disabled editable target.` }
  }
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  if (typeof target.focus === 'function') target.focus({ preventScroll: true })
  const tag = target.tagName.toLowerCase()
  const type = (target.type || '').toLowerCase()
  const isPassword = tag === 'input' && type === 'password'
  const read = () => (tag === 'input' || tag === 'textarea')
    ? String(target.value ?? '')
    : String(target.innerText ?? target.textContent ?? '')
  const before = read()
  const active = document.activeElement
  const activeEditable = Boolean(active && (typingTarget(active) || active.isContentEditable === true))
  return {
    ok: true,
    tag,
    type,
    isPassword,
    beforeChars: before.length,
    beforePreview: isPassword ? `[password ${before.length} chars]` : before.slice(0, 120),
    activeTag: active ? active.tagName.toLowerCase() : '',
    activeEditable,
  }
}

/**
 * Scroll the document or the largest visible nested scroller.
 * This function is serialized into the page; it must not reference module state.
 * @param {'up'|'down'|'left'|'right'} direction
 * @param {number} pages
 * @param {number|null} amountPx
 */
async function scrollPage(direction, pages, amountPx) {
  const vertical = direction === 'up' || direction === 'down'
  const sign = direction === 'down' || direction === 'right' ? 1 : -1
  const doc = document.scrollingElement || document.documentElement
  const vw = window.innerWidth
  const vh = window.innerHeight
  const requested = Number.isFinite(amountPx) && Number(amountPx) > 0
    ? Number(amountPx)
    : (Number.isFinite(pages) && Number(pages) > 0 ? Number(pages) : 0.85) * (vertical ? vh : vw)
  const px = Math.max(1, Math.round(requested))

  const canScroll = (el) => {
    if (!el || el.nodeType !== 1) return false
    const style = getComputedStyle(el)
    if (vertical) {
      return (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay')
        && el.scrollHeight > el.clientHeight + 1
    }
    return (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'overlay')
      && el.scrollWidth > el.clientWidth + 1
  }
  const position = (el) => vertical ? el.scrollTop : el.scrollLeft
  const maximum = (el) => Math.max(0, vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth)
  const atEdge = (el) => sign > 0 ? position(el) >= maximum(el) - 1 : position(el) <= 1
  const visibleArea = (el) => {
    const rect = el.getBoundingClientRect()
    const w = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0))
    const h = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0))
    return w * h
  }
  const describe = (el) => {
    if (el === doc) return 'document'
    const tag = el.tagName ? el.tagName.toLowerCase() : 'element'
    const id = el.id ? `#${el.id}` : ''
    const role = el.getAttribute ? el.getAttribute('role') : null
    return `${tag}${id}${role ? `[role=${role}]` : ''}`
  }

  let target = doc
  if (!canScroll(doc) || atEdge(doc)) {
    let best = null
    const seen = new Set()
    const points = [
      [vw / 2, vh / 2],
      [vw / 2, vh * 0.25],
      [vw / 2, vh * 0.75],
      [vw * 0.2, vh / 2],
      [vw * 0.8, vh / 2],
    ]
    for (const [x, y] of points) {
      let el = document.elementFromPoint(x, y)
      while (el && el !== document.documentElement) {
        if (!seen.has(el)) {
          seen.add(el)
          if (canScroll(el) && !atEdge(el)) {
            const area = visibleArea(el)
            if (best === null || area > best.area) best = { el, area }
          }
        }
        el = el.parentElement
      }
    }
    if (best !== null) target = best.el
  }

  const before = position(target)
  const max = maximum(target)
  const next = Math.max(0, Math.min(max, before + sign * px))
  if (vertical) target.scrollTo({ top: next, left: target.scrollLeft, behavior: 'instant' })
  else target.scrollTo({ top: target.scrollTop, left: next, behavior: 'instant' })

  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await new Promise(resolve => setTimeout(resolve, 90))

  const after = position(target)
  const afterMax = maximum(target)
  return {
    moved: {
      dx: vertical ? 0 : after - before,
      dy: vertical ? after - before : 0,
    },
    container: describe(target),
    scroll: {
      x: vertical ? target.scrollLeft || 0 : after,
      y: vertical ? after : target.scrollTop || 0,
      maxX: Math.max(0, target.scrollWidth - target.clientWidth),
      maxY: Math.max(0, target.scrollHeight - target.clientHeight),
      container: describe(target),
      pageHeight: target.scrollHeight,
      pageWidth: target.scrollWidth,
      atTop: vertical ? after <= 1 : (target.scrollTop || 0) <= 1,
      atBottom: vertical ? after >= afterMax - 1 : (target.scrollTop || 0) >= afterMax - 1,
    },
  }
}

let captureGate = Promise.resolve()
let lastCaptureAt = 0
let captureCooldownUntil = 0
const CAPTURE_WATCHDOG_MS = 5_000
const CAPTURE_COOLDOWN_MS = 30_000

/** @param {number} windowId @param {number} quality */
async function captureChromeWithWatchdog(windowId, quality) {
  let timer
  let timedOut = false
  try {
    return await Promise.race([
      Promise.resolve().then(() => chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new BrowserError('CAPTURE_TIMEOUT', `Chrome did not return a screenshot within ${CAPTURE_WATCHDOG_MS}ms; captures are paused for ${CAPTURE_COOLDOWN_MS / 1000}s`))
        }, CAPTURE_WATCHDOG_MS)
      }),
    ])
  } catch (error) {
    if (timedOut) throw error
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {number} windowId
 * @param {number} quality
 * @returns {Promise<{dataUrl: string, captureMs: number}>}
 */
export async function captureVisibleTab(windowId, quality) {
  const run = async () => {
    const cooldown = captureCooldownUntil - Date.now()
    if (cooldown > 0) {
      throw new BrowserError('CAPTURE_COOLDOWN', `Screenshots are paused for ${Math.ceil(cooldown / 1000)}s after a Chrome capture timeout`)
    }
    const wait = Math.max(0, CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt))
    if (wait > 0) await sleep(wait)
    lastCaptureAt = Date.now()
    const started = performance.now()
    let dataUrl
    try {
      dataUrl = await captureChromeWithWatchdog(windowId, quality)
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'CAPTURE_TIMEOUT') {
        try {
          await chrome.windows?.update?.(windowId, { focused: true })
        } catch {}
        lastCaptureAt = Date.now()
        try {
          dataUrl = await captureChromeWithWatchdog(windowId, quality)
        } catch (focusedError) {
          if (focusedError instanceof BrowserError && focusedError.code === 'CAPTURE_TIMEOUT') captureCooldownUntil = Date.now() + CAPTURE_COOLDOWN_MS
          throw focusedError
        }
      } else {
        const message = error instanceof Error ? error.message : String(error)
        const quotaFailure = /quota|MAX_CAPTURE_VISIBLE_TAB/i.test(message)
        const transientFailure = /image readback failed|failed to capture tab/i.test(message)
        if (quotaFailure || transientFailure) {
          let retryError
          for (const delay of quotaFailure ? [650, 900] : [150, 400]) {
            await sleep(delay)
            lastCaptureAt = Date.now()
            try {
              dataUrl = await captureChromeWithWatchdog(windowId, quality)
              retryError = undefined
              break
            } catch (error) {
              if (error instanceof BrowserError && error.code === 'CAPTURE_TIMEOUT') {
                captureCooldownUntil = Date.now() + CAPTURE_COOLDOWN_MS
                throw error
              }
              retryError = error
            }
          }
          if (dataUrl === undefined) {
            throw new BrowserError('CAPTURE_QUOTA', `Chrome refused the screenshot after retries (${retryError instanceof Error ? retryError.message : String(retryError)})`)
          }
        } else {
          throw new BrowserError('CAPTURE_FAILED', `Chrome could not capture this tab: ${message}`)
        }
      }
    }
    captureCooldownUntil = 0
    return { dataUrl, captureMs: Math.round(performance.now() - started) }
  }
  const next = captureGate.then(run, run)
  captureGate = next.catch(() => {})
  return next
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * @param {string} dataUrl
 * @param {number} maxWidth
 * @param {number} quality
 */
async function compressDataUrl(dataUrl, maxWidth, quality) {
  const started = performance.now()
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new BrowserError('CAPTURE_FORMAT', 'The screenshot data URL is malformed')
  const sourceBase64 = dataUrl.slice(comma + 1)
  const sourceIsJpeg = dataUrl.startsWith('data:image/jpeg')

  let bitmap
  try {
    const blob = await (await fetch(dataUrl)).blob()
    bitmap = await createImageBitmap(blob)
  } catch (error) {
    throw new BrowserError('CAPTURE_DECODE', `Could not decode the screenshot: ${error instanceof Error ? error.message : String(error)}`)
  }
  const sourceWidth = bitmap.width
  const sourceHeight = bitmap.height
  const target = scaleDimensions(sourceWidth, sourceHeight, maxWidth)

  if (sourceIsJpeg && target.width === sourceWidth && target.height === sourceHeight) {
    bitmap.close?.()
    return {
      data: sourceBase64,
      mimeType: 'image/jpeg',
      width: sourceWidth,
      height: sourceHeight,
      bytes: Math.floor((sourceBase64.length * 3) / 4),
      encodeMs: Math.round(performance.now() - started),
      reencoded: false,
    }
  }

  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(target.width, target.height)
    : (() => {
      const element = document.createElement('canvas')
      element.width = target.width
      element.height = target.height
      return element
    })()
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close?.()
    throw new BrowserError('CAPTURE_ENCODE', 'Could not get a 2D canvas context for screenshot compression')
  }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'medium'
  context.drawImage(bitmap, 0, 0, target.width, target.height)
  bitmap.close?.()

  let blob
  if (typeof canvas.convertToBlob === 'function') {
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  } else {
    blob = await new Promise((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('canvas.toBlob returned null')), 'image/jpeg', quality)
    })
  }
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  return {
    data: bytesToBase64(bytes),
    mimeType: 'image/jpeg',
    width: target.width,
    height: target.height,
    bytes: buffer.byteLength,
    encodeMs: Math.round(performance.now() - started),
    reencoded: true,
  }
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {boolean} [force]
 */
function assertCapturable(tab, force = false) {
  if (tab?.id === undefined) throw new BrowserError('NO_TAB', 'There is no active tab')
  if (isProtectedUrl(tab.url) && !force) {
    throw new BrowserError('PROTECTED_PAGE', 'Chrome blocks screenshots and scripts on this page. Switch to a normal website tab.')
  }
}

/**
 * @param {'fast'|'normal'|'high'} detail
 * @param {import('./protocol.js').Settings} settings
 * @param {boolean} [retried]
 * @param {number} [delayMs] page-side delay before labelling and capturing
 */
async function snapshot(detail, settings, retried = false, delayMs = 0) {
  const started = performance.now()
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  // An explicit delay runs in the page: the side panel is hidden and throttled,
  // so its own timers are too coarse. It is counted in totalMs.
  if (delayMs > 0) await pauseInTab(tab.id, delayMs)
  const quality = detail === 'high' ? 80 : detail === 'fast' ? 50 : Number(settings.quality) || 72
  const maxWidth = detail === 'high' ? 2048 : detail === 'fast' ? 640 : Number(settings.captureWidth) || 1280
  // The overlay must be painted before the capture, so label first, then shoot.
  // Only the visible viewport is labelled; persistent ids survive relabelling.
  const labelStarted = performance.now()
  const labelled = await labelAllFrames(tab.id, LABEL_LIMIT)
  const metrics = labelled.metrics
  metrics.labels = labelled.labels
  const labelMs = Math.round(performance.now() - labelStarted)
  const captured = await captureVisibleTab(windowId, quality)
  if (settings.showHitboxes === false) await clearAllFrames(tab.id)

  const tabAfter = await getActiveTab(windowId)
  if (tabAfter.id !== tab.id && !retried) return snapshot(detail, settings, true)

  const image = await compressDataUrl(captured.dataUrl, maxWidth, quality)
  const cssPerImagePixel = metrics.viewport.width / image.width
  const scroll = lastScrollFor(tab.id, metrics.url) ?? metrics.scroll
  // Every capture is a coordinate basis: it records the image size its pixels
  // map through, so a later image-space click can name the view it measured on
  // instead of silently inheriting whatever image happens to be latest (a
  // detail:"fast" capture is 640px wide on the same viewport, half the normal
  // view's scale).
  const basis = {
    viewId: nextViewId++,
    url: metrics.url,
    imageWidth: image.width,
    imageHeight: image.height,
    viewport: metrics.viewport,
    scroll,
    fingerprint: metrics.fingerprint,
    at: Date.now(),
  }
  recordImageBasis(tab.id, basis)
  lastViewByTab.set(tab.id, {
    image: { data: image.data, mimeType: image.mimeType, width: image.width, height: image.height },
    viewId: basis.viewId,
    viewport: metrics.viewport,
    tab: { id: tab.id, title: metrics.title, url: metrics.url },
    labels: metrics.labels,
    scroll,
    fingerprint: metrics.fingerprint ?? {
      url: metrics.url,
      title: metrics.title,
      scrollX: Math.round(scroll?.x ?? 0),
      scrollY: Math.round(scroll?.y ?? 0),
      textLen: null,
      active: '',
      layout: [],
    },
    compactStreak: 0,
    at: Date.now(),
  })
  if (lastViewByTab.size > 20) {
    const oldest = lastViewByTab.keys().next().value
    if (oldest !== undefined) lastViewByTab.delete(oldest)
  }
  return {
    op: 'snapshot',
    view: 'full',
    viewId: basis.viewId,
    labels: metrics.labels,
    surfaces: metrics.surfaces,
    tab: {
      id: tab.id,
      title: metrics.title || tab.title || '',
      url: metrics.url || tab.url || '',
      windowId,
      status: tab.status ?? 'unknown',
    },
    viewport: metrics.viewport,
    scroll,
    labelCount: metrics.labels.length,
    labelMs,
    image: { ...image, cssPerImagePixel },
    captureMs: captured.captureMs,
    encodeMs: image.encodeMs,
    totalMs: Math.round(performance.now() - started),
  }
}

/**
 * Reuse the last scroll container only immediately after a scroll; a later
 * snapshot should not report a stale nested scroll position.
 * @param {number} tabId
 * @param {string} url
 */
function lastScrollFor(tabId, url) {
  const last = lastScrollByTab.get(tabId)
  if (!last) return undefined
  if (Date.now() - last.at > 2_000) {
    lastScrollByTab.delete(tabId)
    return undefined
  }
  if (last.url !== url) return undefined
  return last.scroll
}

/**
 * Parse an optional view mode. Legacy click_at 'fresh' means full.
 * @param {Record<string, any>} args
 * @param {'auto'|'full'|'compact'|'none'} fallback
 * @returns {'auto'|'full'|'compact'|'none'}
 */
function parseViewArg(args, fallback) {
  const raw = args?.view
  if (raw === undefined || raw === null) return fallback
  if (raw === 'fresh') return 'full'
  if (raw === 'auto' || raw === 'full' || raw === 'compact' || raw === 'none') return raw
  return fallback
}

/**
 * Tab summary shared by compact and none views.
 * @param {chrome.tabs.Tab} tab
 * @param {Record<string, any>} metrics
 */
function tabSummary(tab, metrics) {
  return {
    id: tab.id,
    title: metrics?.title || tab.title || '',
    url: metrics?.url || tab.url || '',
    windowId: tab.windowId,
    status: tab.status ?? 'unknown',
  }
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {Record<string, any>} metrics
 */
function scrollFor(tab, metrics) {
  return lastScrollFor(tab.id, metrics.url) ?? metrics.scroll
}

/**
 * Compare layout signatures from two views. A row expanding moves every control
 * below it, so the previous view's pixel coordinates aim at different controls
 * even though nothing the model can read says so. Controls are matched by
 * (tag, text) so a re-rendered row that keeps its text still counts as the same
 * control; changed/added/removed text is structural change and is deliberately
 * not reported as drift (that would warn on every normal page change). Pure, so
 * the "warn, but do not cry wolf" rule is testable without Chrome.
 * @param {Array<{tag?: string, text?: string, x?: number, y?: number, w?: number, h?: number}>} [before]
 * @param {Array<{tag?: string, text?: string, x?: number, y?: number, w?: number, h?: number}>} [after]
 * @param {number} [threshold] px of movement that counts as a shift
 * @returns {{layoutChanged: boolean, movedCount: number, maxDx: number, maxDy: number, structural: boolean, moved: Array<{tag: string, text: string, dx: number, dy: number}>}}
 */
export function compareLayoutFingerprints(before, after, threshold = LAYOUT_SHIFT_THRESHOLD_PX) {
  const unchanged = { layoutChanged: false, movedCount: 0, maxDx: 0, maxDy: 0, structural: false, moved: [] }
  if (!Array.isArray(before) || !Array.isArray(after)) return unchanged
  const limit = Math.max(1, Number(threshold) || LAYOUT_SHIFT_THRESHOLD_PX)
  const keyOf = item => `${String(item?.tag ?? '')}\u0000${String(item?.text ?? '')}`
  const group = items => {
    /** @type {Map<string, Array<Record<string, any>>>} */
    const groups = new Map()
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const key = keyOf(item)
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    for (const bucket of groups.values()) {
      bucket.sort((a, b) => (Number(a?.y) || 0) - (Number(b?.y) || 0) || (Number(a?.x) || 0) - (Number(b?.x) || 0))
    }
    return groups
  }
  const beforeGroups = group(before)
  const afterGroups = group(after)
  let movedCount = 0
  let maxDx = 0
  let maxDy = 0
  const moved = []
  for (const [key, fromItems] of beforeGroups) {
    const toItems = afterGroups.get(key)
    // A different count means controls were added or removed around this one;
    // their own positions cannot be attributed to a shift, so skip the group.
    if (!toItems || toItems.length !== fromItems.length) continue
    for (let index = 0; index < fromItems.length; index += 1) {
      const from = fromItems[index]
      const to = toItems[index]
      const dx = Math.round((Number(to?.x) || 0) - (Number(from?.x) || 0))
      const dy = Math.round((Number(to?.y) || 0) - (Number(from?.y) || 0))
      if (Math.abs(dx) < limit && Math.abs(dy) < limit) continue
      movedCount += 1
      if (Math.abs(dy) > Math.abs(maxDy)) maxDy = dy
      if (Math.abs(dx) > Math.abs(maxDx)) maxDx = dx
      if (moved.length < 5) {
        const separator = key.indexOf('\u0000')
        moved.push({ tag: key.slice(0, separator), text: key.slice(separator + 1), dx, dy })
      }
    }
  }
  const structural = before.length !== after.length
    || beforeGroups.size !== afterGroups.size
    || [...beforeGroups].some(([key, fromItems]) => (afterGroups.get(key)?.length ?? 0) !== fromItems.length)
  return { layoutChanged: movedCount > 0, movedCount, maxDx, maxDy, structural, moved }
}

/**
 * Layout-drift outcome for an action whose view was skipped (view:"none" or
 * compact, where no fresh image is returned): the stored view's layout is
 * compared with the live one, and a shift names itself in the result so the
 * model cannot keep clicking coordinates from a view that no longer matches.
 * Cheap: both signatures were already collected for the fingerprint.
 * @param {Record<string, any> | undefined} stored
 * @param {Record<string, any>} metrics
 * @returns {{layoutChanged: boolean, layoutShift?: Record<string, any>, layoutNote?: string}}
 */
export function deriveLayoutShiftOutcome(stored, metrics) {
  const shift = compareLayoutFingerprints(stored?.fingerprint?.layout, metrics?.fingerprint?.layout)
  if (!shift.layoutChanged && !shift.structural) return { layoutChanged: false }
  const px = Math.max(Math.abs(shift.maxDy), Math.abs(shift.maxDx))
  const detail = shift.layoutChanged
    ? `${shift.movedCount} control(s) moved up to ${px}px`
    : 'controls were added, removed, or renamed'
  return {
    layoutChanged: true,
    layoutShift: {
      maxDx: shift.maxDx,
      maxDy: shift.maxDy,
      movedCount: shift.movedCount,
      structural: shift.structural,
    },
    layoutNote: `layout changed since your last view (${detail}): screenshot coordinates from that view are stale — take a fresh view before the next coordinate action.`,
  }
}

/**
 * Cheap page fingerprint comparison used when no capture was taken.
 * @param {Record<string, any> | undefined} before
 * @param {Record<string, any> | undefined} after
 */
function fingerprintChanged(before, after) {
  if (!before || !after) return false
  return before.url !== after.url
    || before.title !== after.title
    || Math.abs((Number(before.scrollY) || 0) - (Number(after.scrollY) || 0)) > 2
    || before.textLen !== after.textLen
    || before.active !== after.active
    || compareLayoutFingerprints(before.layout, after.layout).layoutChanged
}

/**
 * Derive a compact outcome from the page fingerprint alone.
 * @param {Record<string, any> | undefined} stored
 * @param {Record<string, any>} metrics
 */
function deriveFingerprintOutcome(stored, metrics) {
  const changed = fingerprintChanged(stored?.fingerprint, metrics?.fingerprint)
  return { changed, signals: changed ? ['fingerprint-changed'] : [] }
}

/**
 * Derive a compact outcome from the label delta (hover menus etc.).
 * @param {{addedCount: number, removedCount: number} | undefined} delta
 */
function deriveLabelDeltaOutcome(delta) {
  if (!delta) return { changed: false, signals: [] }
  const signals = []
  if (delta.addedCount > 0) signals.push('labels-added')
  if (delta.removedCount > 0) signals.push('labels-removed')
  return { changed: signals.length > 0, signals }
}

/**
 * Collapse per-frame content probes into one page-level snapshot. Rendered text
 * lengths add up across frames (an iframe's text is not part of its parent's
 * innerText), mutations add up, and the focused element is chosen from whichever
 * frame actually has an element in focus, preferring a readable editor over a
 * parent frame that only reports the iframe element itself. Pure.
 * @param {Array<{frameId: number, result: Record<string, any>}>} [frames]
 * @returns {{textLen: number, mutations: number, focus: Record<string, any> | undefined, frameCount: number}}
 */
export function summarizeContentProbe(frames) {
  const list = (Array.isArray(frames) ? frames : []).filter(frame => frame && frame.result && typeof frame.result === 'object')
  let textLen = 0
  let mutations = 0
  const focuses = []
  for (const frame of list) {
    textLen += Math.max(0, Number(frame.result.textLen) || 0)
    mutations += Math.max(0, Number(frame.result.mutations) || 0)
    if (frame.result.focus && typeof frame.result.focus === 'object') {
      focuses.push({ frameId: Number(frame.frameId) || 0, ...frame.result.focus })
    }
  }
  const focused = focuses.filter(entry => entry.hasFocus === true)
  const ranked = [...(focused.length > 0 ? focused : focuses)].sort((a, b) =>
    Number(b.readable === true) - Number(a.readable === true)
    || Number(b.measurable === true) - Number(a.measurable === true)
    || Number(a.frameId) - Number(b.frameId))
  const focus = ranked[0]
  return { textLen, mutations, focus, frameCount: list.length }
}

/**
 * Verify a normal focused field from its own value. Canvas and missing-probe
 * outcomes stay unknown: unrelated DOM mutations are not evidence that text
 * landed in the document. Pure.
 * @param {ReturnType<typeof summarizeContentProbe> | undefined} before
 * @param {ReturnType<typeof summarizeContentProbe> | undefined} after
 * @returns {{changed: boolean|null, charsAdded: number|null, measured: 'field'|'none', canvasEditor: boolean, fieldChanged: boolean|null, pageChanged: boolean, targetKind: string}}
 */
export function deriveTypeVerdict(before, after) {
  const focus = after?.focus ?? before?.focus
  const targetKind = focus === undefined
    ? 'none'
    : `${focus.tag ?? 'unknown'}${focus.type ? `:${focus.type}` : ''}`
  const pageChanged = Boolean(before && after)
    && (Math.max(0, Number(after.textLen) || 0) !== Math.max(0, Number(before.textLen) || 0)
      || Math.max(0, Number(after.mutations) || 0) > 0)
  const sameIdentity = before?.focus?.identity !== undefined && after?.focus?.identity !== undefined
    ? String(before.focus.identity) === String(after.focus.identity)
    : String(before?.focus?.tag) === String(after?.focus?.tag)
      && String(before?.focus?.type ?? '') === String(after?.focus?.type ?? '')
  const sameField = Boolean(before?.focus && after?.focus)
    && before.focus.measurable === true
    && after.focus.measurable === true
    && sameIdentity
    && String(before.focus.tag) === String(after.focus.tag)
    && String(before.focus.type ?? '') === String(after.focus.type ?? '')
    && Number(before.focus.frameId ?? -1) === Number(after.focus.frameId ?? -1)
  const fieldChanged = sameField
    ? (Number(before.focus.chars) || 0) !== (Number(after.focus.chars) || 0)
      || String(before.focus.preview ?? '') !== String(after.focus.preview ?? '')
    : null
  if (sameField) {
    return {
      changed: fieldChanged === true ? true : pageChanged ? null : false,
      charsAdded: (Number(after.focus.chars) || 0) - (Number(before.focus.chars) || 0),
      measured: 'field',
      canvasEditor: false,
      fieldChanged,
      pageChanged,
      targetKind,
    }
  }
  return {
    changed: null,
    charsAdded: null,
    measured: 'none',
    canvasEditor: true,
    fieldChanged: null,
    pageChanged,
    targetKind,
  }
}

/**
 * Compare the current label ids with the ids stored by the previous view.
 * Ids are persistent per element, so ids are stable within a page.
 * @param {Array<Record<string, any>>} previousLabels
 * @param {Array<Record<string, any>>} currentLabels
 */
function labelDelta(previousLabels, currentLabels) {
  const previous = new Map()
  for (const label of previousLabels ?? []) {
    if (label && Number.isFinite(label.id)) previous.set(label.id, label)
  }
  const current = new Set()
  const added = []
  let unchanged = 0
  for (const label of currentLabels) {
    if (!label || !Number.isFinite(label.id)) continue
    current.add(label.id)
    if (previous.has(label.id)) unchanged += 1
    else added.push(label)
  }
  const removed = []
  for (const [id, label] of previous) {
    if (!current.has(id)) removed.push(label)
  }
  const listed = added.slice(0, 20).map(label => ({
    id: label.id,
    tag: label.tag,
    role: label.role,
    text: label.text,
    disabled: label.disabled === true,
    ...(label.frame === undefined ? {} : { frame: label.frame }),
  }))
  return {
    count: currentLabels.length,
    unchanged,
    addedCount: added.length,
    removedCount: removed.length,
    added: listed,
    ...(added.length > listed.length ? { truncated: true } : {}),
  }
}

/**
 * AUTO POLICY: stay compact unless we have no usable image, the page changed
 * identity, or we have been compact for a while. storeCompactView invalidates
 * the old image after scroll, resize, layout movement, or structural control
 * changes, so a later image-space action cannot use stale coordinates.
 * @param {Record<string, any> | undefined} stored
 * @param {Record<string, any>} metrics
 */
function autoEscalate(stored, metrics) {
  if (!stored?.image?.data) return true
  if ((stored.tab?.url ?? '') !== (metrics?.url ?? '')) return true
  if ((stored.tab?.title ?? '') !== (metrics?.title ?? '')) return true
  if ((stored.compactStreak ?? 0) >= 5) return true
  return false
}

/**
 * Labels-only view pass: no capture, no re-encode.
 * @param {chrome.tabs.Tab} tab
 */
async function labelOnly(tab, showHitboxes = true) {
  const started = performance.now()
  const labelled = await labelAllFrames(tab.id, LABEL_LIMIT, { paint: false })
  if (!showHitboxes) await clearAllFrames(tab.id)
  return { metrics: labelled.metrics, labels: labelled.labels, labelMs: Math.round(performance.now() - started) }
}

/**
 * Compact view payload (without the action outcome fields).
 * @param {chrome.tabs.Tab} tab
 * @param {Record<string, any>} metrics
 * @param {Array<Record<string, any>>} labels
 * @param {number} labelMs
 * @param {Record<string, any>} delta
 */
function compactPayload(tab, metrics, labels, labelMs, delta) {
  return {
    view: 'compact',
    screenshotSkipped: true,
    tab: tabSummary(tab, metrics),
    viewport: metrics.viewport,
    scroll: scrollFor(tab, metrics),
    labelCount: labels.length,
    labelMs,
    labelsDelta: delta,
  }
}

/**
 * Store compact metadata while retaining the previous image only when scroll,
 * viewport, and layout still match it. Any mismatch invalidates the image and
 * every retained coordinate basis.
 * @param {chrome.tabs.Tab} tab
 * @param {Record<string, any>} metrics
 * @param {Array<Record<string, any>>} labels
 */
function storeCompactView(tab, metrics, labels) {
  const stored = lastViewByTab.get(tab.id)
  if (!stored) {
    lastViewByTab.set(tab.id, {
      image: undefined,
      viewport: metrics.viewport,
      tab: { id: tab.id, title: metrics.title, url: metrics.url },
      labels,
      scroll: scrollFor(tab, metrics),
      fingerprint: metrics.fingerprint,
      compactStreak: 1,
      at: Date.now(),
    })
    return
  }
  const before = stored.scroll ?? {}
  const beforeViewport = stored.viewport ?? {}
  const layout = compareLayoutFingerprints(stored.fingerprint?.layout, metrics.fingerprint?.layout)
  const after = scrollFor(tab, metrics)
  stored.tab = { id: tab.id, title: metrics.title, url: metrics.url }
  stored.viewport = metrics.viewport
  stored.labels = labels
  stored.scroll = after
  stored.fingerprint = metrics.fingerprint
  stored.compactStreak = (stored.compactStreak ?? 0) + 1
  stored.at = Date.now()
  const scrolled = Math.abs((after?.y ?? 0) - (before?.y ?? 0)) > 40 || Math.abs((after?.x ?? 0) - (before?.x ?? 0)) > 40
  const resized = Math.abs((beforeViewport.width ?? 0) - (metrics.viewport?.width ?? 0)) > 1
    || Math.abs((beforeViewport.height ?? 0) - (metrics.viewport?.height ?? 0)) > 1
  if (scrolled || resized || layout.layoutChanged || layout.structural) {
    delete stored.image
    imageBasesByTab.delete(tab.id)
  }
}

/**
 * Build an action's view payload without any per-action image for compact and
 * none modes. The caller merges the action outcome fields.
 * @param {chrome.tabs.Tab} tab
 * @param {import('./protocol.js').Settings} settings
 * @param {'auto'|'full'|'compact'|'none'} requested
 * @param {{changed?: boolean, signals?: string[], derive?: Function}} [options]
 * @returns {Promise<{payload: Record<string, any>, mode: 'full'|'compact'|'none'}>}
 */
async function buildActionView(tab, settings, requested, options = {}) {
  // null is a real value: "the action ran but its effect could not be measured"
  // (canvas-editor typing). It must reach the payload unchanged so the provider
  // never renders it as NO VISIBLE CHANGE; only an explicit false is a verdict.
  const baseChanged = options.changed === undefined ? false : options.changed
  const baseSignals = Array.isArray(options.signals) ? options.signals : []
  if (requested === 'none') {
    const stored = lastViewByTab.get(tab.id)
    const metrics = await runInTab(tab.id, pageMetrics, [])
    const shift = deriveLayoutShiftOutcome(stored, metrics)
    const basisViewId = stored?.image?.data ? stored.viewId : undefined
    if (shift.layoutChanged && stored) {
      delete stored.image
      imageBasesByTab.delete(tab.id)
    }
    let changed = baseChanged
    let signals = baseSignals
    if (typeof options.derive === 'function') {
      const derived = options.derive({ stored, metrics, labels: undefined, delta: undefined }) ?? {}
      changed = derived.changed === true ? true : baseChanged === null || derived.changed === null ? null : false
      signals = Array.isArray(derived.signals) ? derived.signals : []
    } else if (changed === false && shift.layoutChanged) {
      // The page did not report a change, but controls moved: that is a state
      // change the old signal missed, and saying otherwise would be a lie.
      changed = true
      signals = [...signals, 'layout-changed']
    }
    return {
      mode: 'none',
      payload: {
        view: 'none',
        screenshotSkipped: true,
        tab: tabSummary(tab, metrics),
        viewport: metrics.viewport,
        scroll: scrollFor(tab, metrics),
        changed,
        signals,
        ...(basisViewId === undefined ? {} : { basisViewId }),
        ...shift,
      },
    }
  }
  if (requested === 'full') {
    const shot = await snapshot('normal', settings)
    return { mode: 'full', payload: shot }
  }
  // compact or auto: one labels-only pass decides and feeds the delta
  const labelled = await labelOnly(tab, settings.showHitboxes !== false)
  const stored = lastViewByTab.get(tab.id)
  if (requested === 'auto' && autoEscalate(stored, labelled.metrics)) {
    const shot = await snapshot('normal', settings)
    return { mode: 'full', payload: shot }
  }
  const delta = labelDelta(stored?.labels ?? [], labelled.labels)
  const shift = deriveLayoutShiftOutcome(stored, labelled.metrics)
  let changed = baseChanged
  let signals = baseSignals
  if (typeof options.derive === 'function') {
    const derived = options.derive({ stored, metrics: labelled.metrics, labels: labelled.labels, delta }) ?? {}
    changed = derived.changed === true ? true : baseChanged === null || derived.changed === null ? null : false
    signals = Array.isArray(derived.signals) ? derived.signals : []
  } else if (changed === false && shift.layoutChanged) {
    changed = true
    signals = [...signals, 'layout-changed']
  }
  const payload = compactPayload(tab, labelled.metrics, labelled.labels, labelled.labelMs, delta)
  payload.changed = changed
  payload.signals = signals
  payload.layoutChanged = shift.layoutChanged
  if (shift.layoutNote !== undefined) {
    payload.layoutShift = shift.layoutShift
    payload.layoutNote = shift.layoutNote
  }
  if (stored?.image?.data) payload.basisViewId = stored.viewId
  storeCompactView(tab, labelled.metrics, labelled.labels)
  return { mode: 'compact', payload }
}

/**
 * Batch-level view: exactly one view for the whole batch, no per-action payload.
 * @param {chrome.tabs.Tab} tab
 * @param {import('./protocol.js').Settings} settings
 * @param {'auto'|'full'|'compact'|'none'} requested
 * @returns {Promise<{payload: Record<string, any>, mode: 'full'|'compact'|'none'}>}
 */
async function buildBatchView(tab, settings, requested) {
  if (requested === 'none') {
    const stored = lastViewByTab.get(tab.id)
    const metrics = await runInTab(tab.id, pageMetrics, [])
    const shift = deriveLayoutShiftOutcome(stored, metrics)
    const basisViewId = stored?.image?.data ? stored.viewId : undefined
    if (shift.layoutChanged && stored) {
      delete stored.image
      imageBasesByTab.delete(tab.id)
    }
    return {
      mode: 'none',
      payload: {
        view: 'none',
        screenshotSkipped: true,
        tab: tabSummary(tab, metrics),
        viewport: metrics.viewport,
        scroll: scrollFor(tab, metrics),
        ...(basisViewId === undefined ? {} : { basisViewId }),
        ...shift,
      },
    }
  }
  if (requested === 'full') {
    const shot = await snapshot('normal', settings)
    return { mode: 'full', payload: shot }
  }
  const labelled = await labelOnly(tab, settings.showHitboxes !== false)
  const stored = lastViewByTab.get(tab.id)
  if (requested === 'auto' && autoEscalate(stored, labelled.metrics)) {
    const shot = await snapshot('normal', settings)
    return { mode: 'full', payload: shot }
  }
  const delta = labelDelta(stored?.labels ?? [], labelled.labels)
  const shift = deriveLayoutShiftOutcome(stored, labelled.metrics)
  const payload = compactPayload(tab, labelled.metrics, labelled.labels, labelled.labelMs, delta)
  payload.layoutChanged = shift.layoutChanged
  if (shift.layoutNote !== undefined) {
    payload.layoutShift = shift.layoutShift
    payload.layoutNote = shift.layoutNote
  }
  if (stored?.image?.data) payload.basisViewId = stored.viewId
  storeCompactView(tab, labelled.metrics, labelled.labels)
  return { mode: 'compact', payload }
}

/**
 * @param {import('./protocol.js').Settings} settings
 */
async function scroll(settings, direction, pages, amountPx, atX, atY) {
  if (!['up', 'down', 'left', 'right'].includes(direction)) {
    throw new BrowserError('BAD_DIRECTION', 'direction must be one of up, down, left, or right')
  }
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const metrics = await runInTab(tab.id, pageMetrics, [])
  const pixels = computeScrollPixels(direction, pages, amountPx, metrics.viewport)
  const scrollInfo = await runInTab(tab.id, scrollPage, [direction, pages ?? 0.85, Number.isFinite(amountPx) ? Number(amountPx) : null])
  const beforeX = metrics.scroll.x
  const beforeY = metrics.scroll.y
  let wheelUsed = false
  if (Math.abs(scrollInfo.moved.dx) < 1 && Math.abs(scrollInfo.moved.dy) < 1) {
    // Canvas apps keep their own scroll state; a trusted wheel is what their
    // handlers expect. Synthetic wheel is the fallback if DevTools is attached.
    let centerX = Math.round(metrics.viewport.width / 2)
    let centerY = Math.round(metrics.viewport.height / 2)
    const lastView = lastViewByTab.get(tab.id)
    if (Number.isFinite(Number(atX)) && Number.isFinite(Number(atY)) && lastView?.image?.width) {
      const scale = lastView.viewport.width / lastView.image.width
      centerX = Math.max(0, Math.min(metrics.viewport.width - 1, Math.round(Number(atX) * scale)))
      centerY = Math.max(0, Math.min(metrics.viewport.height - 1, Math.round(Number(atY) * scale)))
    }
    const deltaX = direction === 'left' ? -pixels : direction === 'right' ? pixels : 0
    const deltaY = direction === 'up' ? -pixels : direction === 'down' ? pixels : 0
    try {
      await withDebugger(tab.id, () => trustedWheel(tab.id, centerX, centerY, deltaX, deltaY))
      wheelUsed = true
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'DEBUGGER_BUSY') throw error
      try {
        await runInTab(tab.id, syntheticWheelAtPoint, [centerX, centerY, deltaX, deltaY], 2_000)
        wheelUsed = true
      } catch {
        wheelUsed = false
      }
    }
    if (wheelUsed) await pauseInTab(tab.id, 180)
  }
  let scroll
  let moved
  if (wheelUsed) {
    const metricsAfter = await runInTab(tab.id, pageMetrics, [])
    scroll = metricsAfter.scroll
    moved = { dx: Math.round(scroll.x - beforeX), dy: Math.round(scroll.y - beforeY) }
  } else {
    scroll = scrollInfo.scroll
    moved = scrollInfo.moved
  }
  lastScrollByTab.set(tab.id, { at: Date.now(), url: metrics.url, scroll })
  if (batchDepth > 0) {
    // Inner batch actions return outcome only; the batch builds one final view.
    return {
      op: 'scroll',
      changed: Math.abs(moved.dx) >= 1 || Math.abs(moved.dy) >= 1,
      signals: [],
      scroll,
      moved,
      wheel: wheelUsed,
      requestedPixels: pixels,
      container: scrollInfo.container,
    }
  }
  const shot = await snapshot('normal', settings)
  return {
    ...shot,
    op: 'scroll',
    scroll,
    moved,
    wheel: wheelUsed,
    requestedPixels: pixels,
    container: scrollInfo.container,
  }
}

/**
 * Known canvas editors: apps that paint their document and expose at most an
 * accessibility copy as DOM text, so read_text must not present DOM text as the
 * page. Patterns are kept as strings because the detector runs inside the page,
 * where a module constant cannot be referenced; the list is passed to the page
 * function, and the same list backs the pure matcher below (testable in Node).
 */
const CANVAS_EDITOR_PATTERNS = [
  { name: 'Google Docs', pattern: '^https://docs\\.google\\.com/document(?:/|$|\\?)' },
  { name: 'Google Sheets', pattern: '^https://docs\\.google\\.com/spreadsheets(?:/|$|\\?)' },
  { name: 'Google Slides', pattern: '^https://docs\\.google\\.com/presentation(?:/|$|\\?)' },
]

/**
 * Name of the canvas editor a URL belongs to, if any. Pure, so the known-editor
 * list is testable without a browser; the regex strings are shared with the
 * in-page detector above.
 * @param {string} [url]
 * @param {Array<{name: string, pattern: string}>} [editors]
 * @returns {string|undefined}
 */
export function canvasEditorForUrl(url, editors = CANVAS_EDITOR_PATTERNS) {
  const value = String(url ?? '')
  for (const editor of Array.isArray(editors) ? editors : []) {
    try {
      if (new RegExp(editor.pattern, 'u').test(value)) return editor.name
    } catch {
      // A malformed pattern must not break read_text.
    }
  }
  return undefined
}

/** @param {chrome.tabs.Tab | undefined} tab @param {'auto'|'full'|'compact'|'none'} requested */
function actionViewForTab(tab, requested) {
  return canvasEditorForUrl(tab?.url) ? 'full' : requested
}

/** Invalidate future coordinates as soon as canvas input may change the page. */
function invalidateCanvasImageBases(tabId) {
  imageBasesByTab.delete(tabId)
}

/**
 * Reject dependent action sequences on canvas editors before their first side effect.
 * @param {string} url
 * @param {Array<{op?: unknown}>} actions
 */
export function canvasBatchError(url, actions) {
  const editor = canvasEditorForUrl(url)
  if (!editor || !Array.isArray(actions) || actions.length <= 1) return undefined
  if (actions.every(action => action?.op === 'wait_for')) return undefined
  return {
    code: 'CANVAS_BATCH_UNSUPPORTED',
    message: `${editor} requires one browser action and a full fresh view at a time. Do not batch document, menu, selection, or formatting actions; continue with the next single action instead.`,
  }
}

/** @param {string} url @param {number} pointCount */
export function canvasBurstError(url, pointCount) {
  const editor = canvasEditorForUrl(url)
  if (!editor || pointCount <= 1) return undefined
  return {
    code: 'CANVAS_BURST_UNSUPPORTED',
    message: `${editor} coordinate actions are limited to one point followed by a full fresh view. Use a labelled control when possible; otherwise click one point and re-read the page.`,
  }
}

/** @param {string} url */
export function canvasSelectionError(url) {
  if (canvasEditorForUrl(url) !== 'Google Docs') return undefined
  return {
    code: 'DOCS_CANVAS_SELECT_UNSUPPORTED',
    message: 'Google Docs drag selection is disabled because it can move text instead of selecting. Use browser_docs_replace_text, browser_docs_replace_many, or an exact Find selection instead.',
  }
}

/**
 * Canvas coordinates may use only the newest retained view.
 * @param {number|undefined} viewId
 * @param {Array<Record<string, any>>} history
 */
export function resolveCanvasImageBasis(viewId, history) {
  const basis = (Array.isArray(history) ? history : []).find(item => item && Number(item.imageWidth) > 0)
  if (!basis) {
    return { error: { code: 'NO_VIEW', message: 'Take a full fresh view before using coordinates in this canvas editor.' } }
  }
  if (viewId !== undefined && Number(viewId) !== Number(basis.viewId)) {
    return {
      error: {
        code: 'STALE_VIEW',
        message: `View #${viewId} is not the newest usable canvas view (#${basis.viewId}). Take a full fresh view and measure the point again.`,
      },
    }
  }
  return { basis }
}

/**
 * Validate the live page against a canvas coordinate basis before dispatch.
 * @param {Record<string, any>} basis
 * @param {Record<string, any>} metrics
 * @param {Record<string, any>} scroll
 */
export function canvasBasisError(basis, metrics, scroll) {
  const stale = reason => ({ code: 'STALE_VIEW', message: `${reason} Take a full fresh view and measure the coordinates again.` })
  if (!basis || !metrics) return { code: 'NO_VIEW', message: 'Take a full fresh view before using coordinates in this canvas editor.' }
  if (String(basis.url ?? '') !== String(metrics.url ?? '')) return stale('The page URL changed since the canvas view was captured.')
  const before = basis.viewport ?? {}
  const after = metrics.viewport ?? {}
  if (Math.abs((Number(before.width) || 0) - (Number(after.width) || 0)) > 1
    || Math.abs((Number(before.height) || 0) - (Number(after.height) || 0)) > 1) {
    return stale('The viewport changed since the canvas view was captured.')
  }
  if (Math.abs((Number(basis.scroll?.x) || 0) - (Number(scroll?.x) || 0)) > 2
    || Math.abs((Number(basis.scroll?.y) || 0) - (Number(scroll?.y) || 0)) > 2) {
    return stale('The page scrolled since the canvas view was captured.')
  }
  const layout = compareLayoutFingerprints(basis.fingerprint?.layout, metrics.fingerprint?.layout)
  if (layout.layoutChanged || layout.structural) return stale('The page controls or layout changed since the canvas view was captured.')
  return undefined
}

/**
 * Read rendered page text without a screenshot. Runs inside the tab, so it must
 * not reference module state.
 * @param {'page'|'viewport'} scope
 * @param {number} offset
 * @param {number} maxChars
 * @param {Array<{name: string, pattern: string}>} [canvasEditors] known canvas editors, passed in for serialization
 */
function readPageText(scope, offset, maxChars, canvasEditors) {
  const start = Math.max(0, Math.floor(Number(offset) || 0))
  const limit = Math.max(500, Math.min(30_000, Math.floor(Number(maxChars) || 12_000)))
  const root = document.scrollingElement || document.documentElement
  const maxY = Math.max(0, root.scrollHeight - root.clientHeight)
  const maxX = Math.max(0, root.scrollWidth - root.clientWidth)
  const viewport = { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }
  const scroll = {
    x: root.scrollLeft || 0,
    y: root.scrollTop || 0,
    maxX,
    maxY,
    container: 'document',
    pageHeight: root.scrollHeight,
    pageWidth: root.scrollWidth,
    atTop: (root.scrollTop || 0) <= 1,
    atBottom: (root.scrollTop || 0) >= maxY - 1,
  }

  const normalize = (value) => String(value || '')
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

  let full = ''
  if (scope === 'viewport') {
    const blockTags = new Set([
      'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
      'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
      'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
    ])
    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'VIDEO', 'AUDIO'])
    const styleCache = new WeakMap()
    const rectCache = new WeakMap()
    const visible = (element) => {
      if (styleCache.has(element)) return styleCache.get(element)
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const ok = style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth
      styleCache.set(element, ok)
      rectCache.set(element, rect)
      return ok
    }
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        if (!parent || skipTags.has(parent.tagName) || !visible(parent)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const parts = []
    let lastParent = null
    while (walker.nextNode()) {
      const node = walker.currentNode
      const parent = node.parentElement
      if (parent !== lastParent && blockTags.has(parent?.tagName)) parts.push('\n')
      parts.push(node.nodeValue)
      lastParent = parent
    }
    full = parts.join(' ')
  } else {
    full = (document.body && document.body.innerText)
      || (document.documentElement && document.documentElement.innerText)
      || ''
  }

  full = normalize(full)
  const totalChars = full.length
  const text = full.slice(start, start + limit)
  const truncated = start + text.length < totalChars

  // Canvas editors paint their content into a canvas, so the DOM text is not a
  // copy of the screen: for Google Docs it is browser chrome plus duplicated
  // accessibility text, and it does not say which document tab is active. The
  // 2026-10-23 run used it as the document's content and to "verify" tab names,
  // which corrupted a multi-tab doc. Detection runs in the page so the honest
  // answer costs no extra round trip.
  const detectCanvasApp = () => {
    for (const editor of Array.isArray(canvasEditors) ? canvasEditors : []) {
      try {
        if (new RegExp(editor.pattern, 'u').test(location.href)) return editor.name
      } catch {
        // Ignore a malformed pattern; the generic heuristic still runs.
      }
    }
    // Generic heuristic: a canvas that dominates the viewport inside an
    // explicitly non-editable (contenteditable="false") or application-role
    // shell is an app painting its own editor, not a decorative image.
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)
    for (const candidate of document.querySelectorAll('canvas')) {
      const box = candidate.getBoundingClientRect()
      if (box.width < 320 || box.height < 200) continue
      if (box.width * box.height < viewportArea * 0.25) continue
      const shell = candidate.closest('[contenteditable="false"],[role="application"],[role="textbox"],[role="document"]')
      if (!shell) continue
      return String(document.title || '').trim().slice(0, 60) || 'this app'
    }
    return undefined
  }
  const canvasApp = detectCanvasApp()
  if (canvasApp !== undefined) {
    return {
      // No misleading `text` and no pagination for a canvas app: the provider
      // renders the note instead, and offers the raw DOM text only as a hint.
      text: '',
      totalChars: 0,
      offset: start,
      maxChars: limit,
      truncated: false,
      nextOffset: null,
      textUnreliable: true,
      canvasApp,
      note: `This page renders its content to canvas (${canvasApp}), so DOM text is not a reliable copy of what is on screen: it can duplicate, omit, or lag the visible content. Use browser_screenshot (with its labels) to see the page and browser_click_at for targets with no label; for Google Docs the document tabs are page UI — use the tab sidebar labels to switch and confirm the active tab.`,
      domText: totalChars >= 400 ? full.slice(0, 2_000) : undefined,
      viewport,
      scroll,
      title: document.title,
      url: location.href,
    }
  }
  return {
    text,
    totalChars,
    offset: start,
    maxChars: limit,
    truncated,
    nextOffset: truncated ? start + text.length : null,
    viewport,
    scroll,
    title: document.title,
    url: location.href,
  }
}

/**
 * Read text from the active tab. This is intentionally much cheaper than a
 * screenshot; the model uses it for text-heavy pages.
 * @param {import('./protocol.js').Settings} settings
 * @param {'page'|'viewport'} scope
 * @param {number} offset
 * @param {number} maxChars
 */
async function readText(settings, scope, offset, maxChars) {
  const started = performance.now()
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const result = await runInTab(tab.id, readPageText, [scope, offset, maxChars, CANVAS_EDITOR_PATTERNS])
  return {
    op: 'read_text',
    tab: {
      id: tab.id,
      title: result.title || tab.title || '',
      url: result.url || tab.url || '',
      windowId,
      status: tab.status ?? 'unknown',
    },
    scope,
    viewport: result.viewport,
    scroll: result.scroll,
    text: result.text,
    totalChars: result.totalChars,
    offset: result.offset,
    maxChars: result.maxChars,
    truncated: result.truncated,
    nextOffset: result.nextOffset,
    ...(result.textUnreliable === true
      ? {
          textUnreliable: true,
          canvasApp: result.canvasApp,
          note: result.note,
          ...(typeof result.domText === 'string' ? { domText: result.domText } : {}),
        }
      : {}),
    totalMs: Math.round(performance.now() - started),
  }
}

/**
 * Score tab title/URL matches for query-based switching. Pure helper so the
 * matching behavior is testable without Chrome. `candidates` lists the best
 * matches (up to five) so an ambiguous query can name them in its error.
 * @param {Array<Record<string, any>>} tabs
 * @param {string} query
 */
export function matchTabQuery(tabs, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle.length === 0) return undefined
  const scored = []
  for (const tab of tabs) {
    if (!tab || tab.id === undefined) continue
    const title = String(tab.title ?? '').toLowerCase()
    const url = String(tab.url ?? '').toLowerCase()
    let score = 0
    if (title === needle || url === needle) score = 100
    else if (title.startsWith(needle) || url.startsWith(needle)) score = 80
    else if (title.includes(needle) || url.includes(needle)) score = 60
    if (score === 0) continue
    if (tab.discarded) score -= 5
    if (tab.active) score -= 1
    scored.push({ tab, score })
  }
  scored.sort((a, b) => b.score - a.score || (Number(a.tab.index) || 0) - (Number(b.tab.index) || 0))
  const best = scored[0]
  return best === undefined
    ? undefined
    : {
        tab: best.tab,
        score: best.score,
        matchCount: scored.length,
        candidates: scored.slice(0, 5).map(entry => entry.tab),
      }
}

/**
 * True when a query matched several tabs and none of them was an exact
 * title/URL match. Such a query must not silently pick the best-scoring tab.
 * @param {{matchCount?: number, score?: number} | undefined} match
 */
export function isAmbiguousTabMatch(match) {
  return Boolean(match) && Number(match.matchCount) > 1 && Number(match.score) < 100
}

/**
 * `id "title" url` lines for an AMBIGUOUS_TAB message.
 * @param {Array<Record<string, any>>} tabs
 * @param {number} [limit]
 */
export function formatTabCandidates(tabs, limit = 5) {
  return (Array.isArray(tabs) ? tabs : [])
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(tab => `${tab.id} ${JSON.stringify(String(tab.title ?? ''))} ${String(tab.url ?? '')}`)
    .join('; ')
}

/**
 * @param {number} windowId
 */
async function listTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId })
  tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return {
    op: 'tabs.list',
    windowId,
    tabs: tabs.map(tab => ({
      id: tab.id,
      index: tab.index,
      title: (tab.title ?? '').slice(0, 300),
      url: (tab.url ?? '').slice(0, 500),
      active: tab.active === true,
      pinned: tab.pinned === true,
      audible: tab.audible === true,
      status: tab.status ?? 'unknown',
      discarded: tab.discarded === true,
    })),
  }
}

/**
 * Activate by id or by a case-insensitive title/URL substring query.
 * @param {import('./protocol.js').Settings} settings
 * @param {number|undefined} tabId
 * @param {string|undefined} query
 */
async function activateTab(settings, tabId, query) {
  const windowId = await getWindowId()
  let target
  let requestedQuery
  let matchCount
  let matchScore
  const hasId = tabId !== undefined && tabId !== null && tabId !== ''
  if (hasId) {
    const id = Number(tabId)
    if (!Number.isSafeInteger(id) || id <= 0) throw new BrowserError('BAD_TAB_ID', 'tab_id must be a positive integer')
    try {
      target = await chrome.tabs.get(id)
    } catch {
      const list = await listTabs(windowId)
      throw new BrowserError('TAB_NOT_FOUND', `Tab ${id} does not exist. Current tabs: ${list.tabs.map(tab => `${tab.id} ${JSON.stringify(tab.title)}`).join('; ')}`)
    }
  } else {
    const text = typeof query === 'string' ? query.trim() : ''
    if (text.length === 0) throw new BrowserError('BAD_TAB_QUERY', 'Provide tab_id or a non-empty query')
    const list = await listTabs(windowId)
    const match = matchTabQuery(list.tabs, text)
    if (match === undefined) {
      throw new BrowserError('TAB_NOT_FOUND', `No tab title or URL matched ${JSON.stringify(text)}. Current tabs: ${list.tabs.map(tab => `${tab.id} ${JSON.stringify(tab.title)}`).join('; ')}`)
    }
    // Several tabs can share a query prefix (e.g. "Cool Document" also matched a
    // Gmail tab). Refuse to guess: the caller must pick a candidate or use
    // tab_id, otherwise the agent acts on the wrong page.
    if (isAmbiguousTabMatch(match)) {
      throw new BrowserError(
        'AMBIGUOUS_TAB',
        `Query ${JSON.stringify(text)} matched ${match.matchCount} tabs and none exactly. Candidates: ${formatTabCandidates(match.candidates)}. Pass tab_id or a more specific query.`,
      )
    }
    requestedQuery = text
    matchCount = match.matchCount
    matchScore = match.score
    try {
      target = await chrome.tabs.get(Number(match.tab.id))
    } catch {
      throw new BrowserError('TAB_NOT_FOUND', `Matched tab ${match.tab.id} disappeared before activation`)
    }
  }
  const id = target.id
  if (target.windowId !== windowId) {
    throw new BrowserError('OTHER_WINDOW', `Tab ${id} is in another window; Phase 1 only switches tabs in this window.`)
  }
  await chrome.tabs.update(id, { active: true })
  // Wait for the activation event instead of a fixed sleep: side-panel timers
  // are throttled when the extension page is not visible.
  await new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      chrome.tabs.onActivated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = info => {
      if (info.tabId === id && info.windowId === windowId) finish()
    }
    const timer = setTimeout(finish, 400)
    chrome.tabs.onActivated.addListener(listener)
  })
  const active = await getActiveTab(windowId)
  if (active.id !== id) throw new BrowserError('ACTIVATE_FAILED', `Chrome did not activate tab ${id}`)
  if (target.discarded) await waitForTabComplete(id, windowId, 2_000)
  const shot = await snapshot('normal', settings)
  return {
    ...shot,
    op: 'tabs.activate',
    requestedTabId: id,
    ...(requestedQuery === undefined ? {} : { requestedQuery, matchCount, matchScore }),
  }
}

/**
 * Clamp an optional model-requested settle delay for a click burst.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function parseSettleMs(value) {
  if (value === undefined || value === null) return undefined
  const ms = Number(value)
  if (!Number.isFinite(ms)) return undefined
  return Math.max(0, Math.min(400, Math.round(ms)))
}

/**
 * Validate an optional `view_id` argument naming the view whose screenshot the
 * coordinates were measured on. The provider validates too, but the executor
 * must not trust the wire.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function parseViewId(value) {
  if (value === undefined || value === null) return undefined
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BrowserError('BAD_VIEW', 'view_id must be a positive integer view id from a previous view')
  }
  return id
}

/**
 * Keep the most recent captures of a tab as coordinate bases, newest first.
 * @param {number} tabId
 * @param {{viewId: number}} basis
 */
function recordImageBasis(tabId, basis) {
  const history = imageBasesByTab.get(tabId) ?? []
  history.unshift(basis)
  if (history.length > MAX_IMAGE_BASES) history.length = MAX_IMAGE_BASES
  imageBasesByTab.set(tabId, history)
}

/**
 * Resolve which captured view an image-space action maps through. An explicit
 * view_id wins (the model says which screenshot it measured on) and must be one
 * of the recent bases; without one the newest capture is used and reported in
 * the result, so a mismatch is visible rather than silent. CSS coordinates do
 * not depend on an image scale and resolve to no basis. Pure, so the selection
 * and refusal rules are testable without Chrome.
 * @param {{space?: 'image'|'css', viewId?: number, points?: Array<{x: number, y: number}>}} request
 * @param {Array<{viewId: number, imageWidth: number, imageHeight: number, viewport: {width: number, height: number}}>} history newest first
 * @returns {{basis?: Record<string, any>, error?: {code: string, message: string}}}
 */
export function resolveImageBasis(request, history) {
  if (request?.space === 'css') return {}
  const bases = (Array.isArray(history) ? history : [])
    .filter(basis => basis && Number.isSafeInteger(Number(basis.viewId)) && Number(basis.imageWidth) > 0)
  if (bases.length === 0) {
    return { error: { code: 'NO_VIEW', message: 'Take a screenshot first so image coordinates can be mapped to the page.' } }
  }
  if (request?.viewId !== undefined && request?.viewId !== null) {
    const wanted = Number(request.viewId)
    const basis = bases.find(item => Number(item.viewId) === wanted)
    if (!basis) {
      return {
        error: {
          code: 'NO_VIEW',
          message: `View ${wanted} is not a recent view of this page, so its image scale is unknown. Take a fresh view and use coordinates measured on that screenshot.`,
        },
      }
    }
    return { basis }
  }
  return { basis: bases[0] }
}

/**
 * Detect coordinates measured on a different captured view. Off-screen under
 * the selected basis but valid under another is stale evidence; materially
 * different mappings that fit two bases are ambiguous. Callers reject both
 * before input. Same-scale bases are ignored because they map identically. Pure.
 * @param {Array<{x: number, y: number}>} points
 * @param {{viewId: number, imageWidth: number, imageHeight: number, viewport: {width: number, height: number}}} basis
 * @param {Array<Record<string, any>>} history newest first
 * @param {number} [margin] px inside a basis that still counts as reachable
 * @returns {{stale: Array<Record<string, any>>, ambiguous: Array<Record<string, any>>}}
 */
export function findCoordinateBasisMismatch(points, basis, history, margin = 2) {
  const result = { stale: [], ambiguous: [] }
  if (!basis || !Array.isArray(points)) return result
  const scaleOf = item => (Number(item?.viewport?.width) || 0) / (Number(item?.imageWidth) || 1)
  const mapPoint = (point, item) => {
    const scale = scaleOf(item)
    return { x: (Number(point?.x) || 0) * scale, y: (Number(point?.y) || 0) * scale }
  }
  const inside = (mapped, item) => mapped.x >= -margin && mapped.y >= -margin
    && mapped.x <= (Number(item?.viewport?.width) || 0) + margin
    && mapped.y <= (Number(item?.viewport?.height) || 0) + margin
  const baseScale = scaleOf(basis)
  const others = (Array.isArray(history) ? history : [])
    .filter(item => item && Number(item.viewId) !== Number(basis.viewId) && Number(item.imageWidth) > 0)
    .filter(item => Math.abs(scaleOf(item) - baseScale) >= baseScale * 0.01)
  for (const [index, point] of points.entries()) {
    if (!Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) continue
    const mapped = mapPoint(point, basis)
    const onScreen = inside(mapped, basis)
    const alternatives = []
    for (const other of others) {
      const mappedOther = mapPoint(point, other)
      if (!inside(mappedOther, other)) continue
      alternatives.push({
        viewId: Number(other.viewId),
        imageWidth: Number(other.imageWidth),
        imageHeight: Number(other.imageHeight),
        cssX: Math.round(mappedOther.x),
        cssY: Math.round(mappedOther.y),
        dx: Math.round(mappedOther.x - mapped.x),
        dy: Math.round(mappedOther.y - mapped.y),
      })
    }
    if (alternatives.length === 0) continue
    if (!onScreen) {
      result.stale.push({
        index,
        x: point.x,
        y: point.y,
        cssX: Math.round(mapped.x),
        cssY: Math.round(mapped.y),
        from: alternatives[0],
      })
      continue
    }
    // Both bases put the point on screen: only report the ones that differ
    // enough that the click would land on a visibly different target.
    const differing = alternatives.filter(item => Math.abs(item.dx) >= 8 || Math.abs(item.dy) >= 8)
    if (differing.length === 0) continue
    result.ambiguous.push({
      index,
      x: point.x,
      y: point.y,
      cssX: Math.round(mapped.x),
      cssY: Math.round(mapped.y),
      alternatives: differing.slice(0, 3),
    })
  }
  return result
}

/**
 * The result-facing coordinate basis: which view the pixels were mapped through
 * and its scale, so the model can tell when a coordinate is not from the view it
 * thinks it is.
 * @param {Record<string, any>} basis
 */
function basisSummary(basis) {
  const width = Number(basis?.imageWidth) || 0
  const viewportWidth = Number(basis?.viewport?.width) || 0
  return {
    viewId: Number(basis?.viewId),
    imageWidth: width,
    imageHeight: Number(basis?.imageHeight) || 0,
    cssPerImagePx: width > 0 ? Number((viewportWidth / width).toFixed(3)) : 0,
  }
}

/**
 * Validate click_at arguments into a single burst request. A burst is either
 * one legacy `x`/`y` pair or a `points` array of 1..20 pairs, never both.
 * @param {Record<string, any>} args
 * @returns {{points: Array<{x: number, y: number}>, space: 'image'|'css', view: 'fresh'|'none', settleMs: number|undefined, viewId: number|undefined}}
 */
export function parseClickAtArgs(args) {
  const hasPoints = args.points !== undefined
  const hasCoordinates = args.x !== undefined || args.y !== undefined
  if (hasPoints && hasCoordinates) {
    throw new BrowserError('BAD_POINTS', 'Provide either x/y or points for click_at, not both.')
  }
  if (!hasPoints && !hasCoordinates) {
    throw new BrowserError('BAD_POINTS', 'click_at requires x/y or a points array.')
  }
  const space = args.space === 'css' ? 'css' : 'image'
  const rawView = parseViewArg(args, 'full')
  const view = rawView === 'auto' ? 'full' : rawView
  const settleMs = parseSettleMs(args.settle_ms)
  const viewId = parseViewId(args.view_id)
  if (hasPoints) {
    if (!Array.isArray(args.points) || args.points.length === 0 || args.points.length > CLICK_AT_MAX_POINTS) {
      throw new BrowserError('BAD_POINTS', `points must be an array of 1 to ${CLICK_AT_MAX_POINTS} {x, y} coordinate objects.`)
    }
    const points = args.points.map((point, index) => {
      const x = Number(point?.x)
      const y = Number(point?.y)
      if (typeof point !== 'object' || point === null || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new BrowserError('BAD_POINTS', `points[${index}] must have finite x and y.`)
      }
      return { x, y }
    })
    return { points, space, view, settleMs, viewId }
  }
  const x = Number(args.x)
  const y = Number(args.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new BrowserError('BAD_POINT', 'x and y must be finite numbers from the current view')
  }
  return { points: [{ x, y }], space, view, settleMs, viewId }
}

/**
 * Map burst points into viewport CSS coordinates. Off-screen points are marked
 * and reported with their raw (unclamped) coordinates; only on-screen points
 * are clamped for dispatch. Pure so the off-screen rule is testable.
 * @param {Array<{x: number, y: number}>} points
 * @param {'image'|'css'} space
 * @param {{width: number, height: number}} viewport
 * @param {number} [imageScale]
 * @returns {Array<{space: 'image'|'css', x: number, y: number, cssX: number, cssY: number, offScreen: boolean}>}
 */
export function mapClickPoints(points, space, viewport, imageScale = 1) {
  const width = Number(viewport?.width) || 0
  const height = Number(viewport?.height) || 0
  const scale = space === 'image' ? (Number.isFinite(Number(imageScale)) ? Number(imageScale) : 1) : 1
  return points.map(point => {
    const rawX = space === 'css' ? Number(point.x) : Number(point.x) * scale
    const rawY = space === 'css' ? Number(point.y) : Number(point.y) * scale
    // A 2px tolerance keeps edge-of-viewport targets clickable; beyond that the
    // point cannot be aimed at the live page, so it must never be dispatched.
    const offScreen = !Number.isFinite(rawX) || !Number.isFinite(rawY)
      || rawX < -2 || rawX > width + 2 || rawY < -2 || rawY > height + 2
    return {
      space,
      x: point.x,
      y: point.y,
      cssX: offScreen ? rawX : Math.max(0, Math.min(width - 1, rawX)),
      cssY: offScreen ? rawY : Math.max(0, Math.min(height - 1, rawY)),
      offScreen,
    }
  })
}

/**
 * Compare the scroll position stored with a view against the current one. A
 * drift larger than the threshold means the stored image's coordinates are
 * stale. Returns undefined when the view scroll is unknown or still accurate.
 * @param {{y?: number} | undefined} storedScroll
 * @param {{y?: number} | undefined} currentScroll
 * @param {number} [threshold]
 */
export function staleScrollInfo(storedScroll, currentScroll, threshold = STALE_SCROLL_THRESHOLD_PX) {
  if (!storedScroll || !currentScroll) return undefined
  const fromY = Math.round(Number(storedScroll.y) || 0)
  const toY = Math.round(Number(currentScroll.y) || 0)
  const dy = toY - fromY
  return Math.abs(dy) > Math.max(0, Number(threshold) || 0) ? { fromY, toY, dy } : undefined
}

/**
 * Click points in the current view on canvas/video/iframe or unlabelled targets.
 * Ordinary pages allow 20-point bursts and skipped captures. Known document
 * editors allow one point plus a full fresh view, and every coordinate basis is
 * validated before input. Off-screen ordinary points are skipped; canvas-editor
 * off-screen points are rejected. Pixel diffs report visual response, not proof
 * of a particular document edit.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function clickAt(settings, args) {
  const started = performance.now()
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const request = parseClickAtArgs(args)
  const canvasEditor = canvasEditorForUrl(tab.url)
  const burstError = canvasBurstError(tab.url ?? '', request.points.length)
  if (burstError) throw new BrowserError(burstError.code, burstError.message)
  request.view = actionViewForTab(tab, request.view)
  const before = lastViewByTab.get(tab.id)
  const history = (imageBasesByTab.get(tab.id) ?? []).filter(basis => basis.url === (tab.url ?? ''))
  const resolved = canvasEditor
    ? resolveCanvasImageBasis(request.viewId, history)
    : request.space === 'image'
      ? resolveImageBasis({ space: request.space, viewId: request.viewId, points: request.points }, history)
      : {}
  if (resolved.error) throw new BrowserError(resolved.error.code, resolved.error.message)
  const basis = resolved.basis
  const liveMetrics = canvasEditor ? await runInTab(tab.id, pageMetrics, []) : undefined
  if (canvasEditor) {
    if (!before?.image?.data || Number(before.viewId) !== Number(basis?.viewId)) {
      throw new BrowserError('NO_VIEW', 'Take a full fresh view before using coordinates in this canvas editor.')
    }
    const basisError = canvasBasisError(basis, liveMetrics, scrollFor(tab, liveMetrics))
    if (basisError) throw new BrowserError(basisError.code, basisError.message)
  }
  const viewport = liveMetrics?.viewport ?? before?.viewport ?? await runInTab(tab.id, pageMetrics, [])
  if (!canvasEditor && request.space === 'image' && (!before?.image?.data || !basis)) {
    throw new BrowserError('NO_VIEW', 'Take a screenshot first so image coordinates can be mapped to the page.')
  }
  const imageScale = request.space === 'image' ? basis.viewport.width / basis.imageWidth : 1
  const mismatch = request.space === 'image'
    ? findCoordinateBasisMismatch(request.points, basis, history)
    : { stale: [], ambiguous: [] }
  if (request.viewId !== undefined) mismatch.ambiguous = []
  const stalePoint = mismatch.stale[0]
  if (stalePoint) {
    const current = basisSummary(basis)
    throw new BrowserError(
      'STALE_VIEW',
      `These image coordinates look like they came from view #${stalePoint.from.viewId} (${stalePoint.from.imageWidth}x${stalePoint.from.imageHeight} image), but the current coordinate basis is view #${current.viewId} (${current.imageWidth}x${current.imageHeight}). Take a fresh view and measure the point again.`,
    )
  }
  if (mismatch.ambiguous.length > 0) {
    const other = mismatch.ambiguous[0].alternatives[0]
    throw new BrowserError(
      'AMBIGUOUS_VIEW',
      `These image coordinates also fit view #${other.viewId} at a different scale. Take a fresh view, measure the point again, and pass its view_id; no click was dispatched.`,
    )
  }
  const targets = mapClickPoints(request.points, request.space, viewport, imageScale)
  const onScreen = targets.filter(target => target.offScreen !== true)
  const offScreenCount = targets.length - onScreen.length
  if (canvasEditor && offScreenCount > 0) {
    throw new BrowserError('OFF_SCREEN', 'A canvas coordinate is outside the current viewport. Take a full fresh view and measure it again; no click was dispatched.')
  }

  let trusted = true
  if (onScreen.length > 0) {
    try {
      // One attach for the whole burst: the debugger handshake is not paid per point.
      await withDebugger(tab.id, async () => {
        for (const target of onScreen) await trustedClick(tab.id, target.cssX, target.cssY)
      })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'DEBUGGER_BUSY') throw error
      trusted = false
      const dispatched = await runInTab(tab.id, syntheticClickBurst, [onScreen.map(target => ({ x: target.cssX, y: target.cssY }))], 4_000)
      if (!Array.isArray(dispatched) || !dispatched.some(Boolean)) {
        throw new BrowserError('CLICK_POINT_EMPTY', 'There is no element at that point.')
      }
    } finally {
      if (canvasEditor) invalidateCanvasImageBases(tab.id)
    }
  }

  const noCapture = request.view === 'none' || request.view === 'compact' || batchDepth > 0
  const unclickedDiff = { changed: null, percent: null, mean: null }
  let shot
  let diffs = targets.map(target => target.offScreen === true ? { ...unclickedDiff } : { changed: false, percent: 0, mean: 0 })
  if (!noCapture) {
    await settleAfterInput(tab.id, request.settleMs)
    shot = await snapshot('normal', settings)
    diffs = await Promise.all(targets.map(target => target.offScreen === true
      ? { ...unclickedDiff }
      : diffRegion(before, shot, target.cssX, target.cssY, 120)))
    // A canvas frame can occasionally miss the first capture; retry once
    // before reporting no change. Never more than two captures per burst, and
    // never when there was nothing to click.
    if (onScreen.length > 0 && diffs.every(diff => !diff.changed) && before?.image?.data) {
      await pauseInTab(tab.id, 120)
      shot = await snapshot('normal', settings)
      diffs = await Promise.all(targets.map(target => target.offScreen === true
        ? { ...unclickedDiff }
        : diffRegion(before, shot, target.cssX, target.cssY, 120)))
    }
  }
  const noPixelDiff = request.view === 'none' || request.view === 'compact' || batchDepth > 0
  const points = targets.map((target, index) => ({
    space: target.space,
    x: target.x,
    y: target.y,
    cssX: Math.round(target.cssX),
    cssY: Math.round(target.cssY),
    offScreen: target.offScreen === true,
    changed: noPixelDiff ? null : diffs[index].changed,
    pixelsChanged: noPixelDiff ? null : diffs[index].percent,
    pixelMean: noPixelDiff ? null : diffs[index].mean,
  }))
  if (batchDepth > 0) {
    // Inner click_at: no capture at all. A fingerprint comparison still gives a
    // cheap changed signal and catches a layout shift for the batch item.
    const stored = lastViewByTab.get(tab.id)
    const metrics = await runInTab(tab.id, pageMetrics, [])
    const derived = deriveFingerprintOutcome(stored, metrics)
    const shift = deriveLayoutShiftOutcome(stored, metrics)
    const staleScroll = staleScrollInfo(before?.scroll, metrics?.scroll)
    return {
      points,
      trusted,
      offScreenCount,
      changed: derived.changed,
      ...(basis ? { basis: basisSummary(basis) } : {}),
      ...(staleScroll ? { staleScroll } : {}),
      ...shift,
      clickMs: Math.round(performance.now() - started),
    }
  }
  let payload
  let mode
  if (request.view === 'none' || request.view === 'compact') {
    const view = await buildActionView(tab, settings, request.view, {
      derive: ({ stored, metrics }) => deriveFingerprintOutcome(stored, metrics),
    })
    payload = view.payload
    mode = view.mode
  } else {
    payload = shot
    mode = 'full'
  }
  // Report scroll drift even for view:"none": the model must know that the
  // image its coordinates came from no longer matches the live page.
  const staleScroll = staleScrollInfo(before?.scroll, payload?.scroll)
  const result = {
    ...payload,
    op: 'click_at',
    points,
    trusted,
    offScreenCount,
    changedCount: points.filter(point => point.changed === true).length,
    ...(basis ? { basis: basisSummary(basis) } : {}),
    // Points that are plausible on two different image scales: the click still
    // uses the current basis, but the result names the other basis it also fits
    // so a mismatched scale is visible instead of silent.
    ...(mismatch.ambiguous.length > 0
      ? {
          basisAmbiguousWith: mismatch.ambiguous.flatMap(item => item.alternatives.map(other => ({
            pointIndex: item.index,
            ...other,
          }))),
        }
      : {}),
    ...(staleScroll ? { staleScroll } : {}),
    clickMs: Math.round(performance.now() - started),
  }
  if (mode !== 'full') {
    result.view = mode
    result.screenshotSkipped = true
  }
  if (points.length === 1) {
    // Legacy single-point shape: existing consumers read point/changed directly.
    result.point = {
      space: points[0].space,
      x: points[0].x,
      y: points[0].y,
      cssX: points[0].cssX,
      cssY: points[0].cssY,
      offScreen: points[0].offScreen,
    }
    result.changed = points[0].changed
    result.pixelsChanged = points[0].pixelsChanged
    result.pixelMean = points[0].pixelMean
    result.signals = points[0].changed === true
      ? ['pixels-changed']
      : (Array.isArray(payload?.signals) ? payload.signals : [])
  }
  return result
}

/**
 * Click a labelled element and return the resulting view.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function click(settings, args) {
  const label = Number(args.label)
  if (!Number.isSafeInteger(label) || label <= 0) {
    throw new BrowserError('BAD_LABEL', 'label must be a positive integer shown on the current view')
  }
  let viewMode = parseViewArg(args, 'auto')
  const started = performance.now()
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const canvasEditor = canvasEditorForUrl(tab.url)
  viewMode = actionViewForTab(tab, viewMode)
  const beforeUrl = tab.url ?? ''
  const __afterLookup = performance.now()
  const target = resolveLabelTarget(tab, label)
  if (!target) throw await decorateStaleLabelError(tab, missingLabelError(tab, label))
  const clickOnce = async labelTarget => {
    try {
      return await runInFrame(tab.id, labelTarget.frameId, clickLabelled, [labelTarget.localId], 1_200)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const current = await chrome.tabs.get(tab.id).catch(() => undefined)
      const navigated = current !== undefined && (current.url ?? '') !== beforeUrl
      if (navigated || /frame.*(removed|gone)|cannot access contents|no frame|tab was closed/i.test(message)) {
        return { ok: true, clicked: { label, tag: '', role: '', text: '' }, changed: true, signals: ['navigation'], navigated: true }
      }
      if (code === 'SCRIPT_TIMEOUT') {
        throw new BrowserError('CLICK_TIMEOUT', 'The click did not complete. Take a fresh view before trying again.')
      }
      throw error
    } finally {
      if (canvasEditor) invalidateCanvasImageBases(tab.id)
    }
  }
  const result = await clickOnce(target)
  if (result?.ok === false) {
    const code = typeof result.code === 'string' ? result.code : 'CLICK_FAILED'
    const error = new BrowserError(code, typeof result.message === 'string' ? result.message : 'Click failed')
    if (result.clicked) error.clicked = result.clicked
    throw await decorateStaleLabelError(tab, error, result.clicked?.text)
  }
  // A click that had to scroll invalidates the stored screenshot: image-space
  // coordinates from the old frame no longer map. Delete only the image (not the
  // labels), reusing the compact-scroll rule, so image-space click_at fails
  // NO_VIEW instead of clicking a stale screenshot.
  const clickScroll = result.scroll && Number.isFinite(Number(result.scroll.dy))
    ? {
        fromY: Math.round(Number(result.scroll.fromY) || 0),
        toY: Math.round(Number(result.scroll.toY) || 0),
        dy: Math.round(Number(result.scroll.dy) || 0),
      }
    : undefined
  const scrolledIntoView = result.scrolledIntoView === true
  if (clickScroll && clickScroll.dy !== 0) {
    const storedView = lastViewByTab.get(tab.id)
    if (storedView) delete storedView.image
  }
  const __afterClick = performance.now()
  let current
  try {
    current = await chrome.tabs.get(tab.id)
  } catch {
    current = undefined
  }
  const __afterTabGet = performance.now()
  if (current?.status === 'loading' || (current?.url ?? '') !== beforeUrl) {
    await waitForTabComplete(tab.id, windowId, 2_500)
  }
  const __afterWait = performance.now()
  const currentAfter = await chrome.tabs.get(tab.id).catch(() => current)
  const navigated = (currentAfter?.url ?? '') !== beforeUrl
  const pendingNavigation = result.pendingNavigation === true
  const baseChanged = pendingNavigation ? navigated : result.changed === true
  const signals = Array.isArray(result.signals) ? result.signals : []
  if (batchDepth > 0) {
    return {
      changed: baseChanged,
      signals,
      clicked: result.clicked,
      navigated,
      scrolledIntoView,
      ...(clickScroll ? { scroll: clickScroll } : {}),
    }
  }
  const activeTab = await getActiveTab(windowId).catch(() => tab)
  const __beforeView = performance.now()
  const { payload, mode } = await buildActionView(activeTab, settings, viewMode, { changed: baseChanged, signals })
  const viewMs = Math.round(performance.now() - __beforeView)
  const changed = mode === 'full' && pendingNavigation
    ? navigated || (payload.tab?.title ?? '') !== (tab.title ?? '')
    : (payload.changed ?? baseChanged)
  // Keep the page-scroll metadata from the view and add the click's own scroll
  // delta, so the provider can report fromY/toY/dy without losing y/maxY/atTop.
  const resultScroll = clickScroll
    ? { ...(payload?.scroll && typeof payload.scroll === 'object' ? payload.scroll : {}), ...clickScroll }
    : undefined
  const reportedSignals = mode === 'full'
    ? signals
    : (Array.isArray(payload.signals) ? payload.signals : [])
  return {
    ...payload,
    op: 'click',
    clicked: result.clicked,
    changed,
    signals: reportedSignals,
    navigated,
    ...(resultScroll ? { scroll: resultScroll } : {}),
    scrolledIntoView,
    clickMs: Math.round(performance.now() - started),
    clickTimings: {
      ...result.timings,
      lookupMs: Math.round(__afterLookup - started),
      runTabMs: Math.round(__afterClick - __afterLookup),
      sleepMs: Math.round(__afterTabGet - __afterClick),
      waitMs: Math.round(__afterWait - __afterTabGet),
      snapshotMs: viewMs,
      tabStatus: current?.status,
    },
  }
}

/**
 * Hover a labelled element and return the resulting view.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function hover(settings, args) {
  const label = Number(args.label)
  if (!Number.isSafeInteger(label) || label <= 0) {
    throw new BrowserError('BAD_LABEL', 'label must be a positive integer shown on the current view')
  }
  const viewMode = parseViewArg(args, 'auto')
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const pageUrl = tab.url ?? ''
  const target = resolveLabelTarget(tab, label)
  if (!target) throw await decorateStaleLabelError(tab, missingLabelError(tab, label))
  let hovered = await runInFrame(tab.id, target.frameId, hoverLabelled, [target.localId], 3_000)
  // Recover a re-rendered target once by its recorded signature; a failed
  // recovery keeps the original stale-label error.
  let staleRecovery
  if (hovered?.ok === false && isRecoverableLabelCode(hovered.code)) {
    staleRecovery = await recoverStaleLabel(tab, target, pageUrl)
    if (staleRecovery.recovered) {
      const retried = await runInFrame(
        tab.id,
        staleRecovery.recovered.frameId,
        hoverLabelled,
        [staleRecovery.recovered.localId],
        3_000,
      ).catch(() => undefined)
      if (retried?.ok === true) hovered = retried
    }
  }
  if (hovered?.ok === false) throw new BrowserError(hovered.code ?? 'HOVER_FAILED', hovered.message ?? 'Could not hover')
  const reResolved = staleRecovery?.recovered && staleRecovery.recovered.label !== label
    ? { from: label, to: staleRecovery.recovered.label, ...staleRecovery.recovered.signature }
    : undefined
  await pauseInTab(tab.id, 80)
  if (batchDepth > 0) {
    const stored = lastViewByTab.get(tab.id)
    const metrics = await runInTab(tab.id, pageMetrics, [])
    const derived = deriveFingerprintOutcome(stored, metrics)
    return {
      changed: derived.changed,
      signals: derived.signals,
      hovered: hovered.hovered,
      ...(reResolved ? { reResolved } : {}),
      ...deriveLayoutShiftOutcome(stored, metrics),
    }
  }
  const activeTab = await getActiveTab(windowId).catch(() => tab)
  const { payload } = await buildActionView(activeTab, settings, viewMode, {
    derive: ({ stored, metrics, delta }) => delta
      ? deriveLabelDeltaOutcome(delta)
      : deriveFingerprintOutcome(stored, metrics),
  })
  return { ...payload, op: 'hover', hovered: hovered.hovered, ...(reResolved ? { reResolved } : {}) }
}

/**
 * Choose an option on a labelled select and return the resulting view.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function selectOptionOp(settings, args) {
  const label = Number(args.label)
  if (!Number.isSafeInteger(label) || label <= 0) {
    throw new BrowserError('BAD_LABEL', 'label must be a positive integer shown on the current view')
  }
  const viewMode = parseViewArg(args, 'auto')
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const target = resolveLabelTarget(tab, label)
  if (!target) throw await decorateStaleLabelError(tab, missingLabelError(tab, label))
  const picked = await runInFrame(tab.id, target.frameId, selectOption, [target.localId, String(args.option ?? '')], 3_000)
  if (picked?.ok === false) throw new BrowserError(picked.code ?? 'SELECT_FAILED', picked.message ?? 'Could not select the option')
  await pauseInTab(tab.id, 90)
  const changed = String(picked.previousValue ?? '') !== String(picked.selected?.value ?? '')
  const signals = changed ? ['value-changed'] : []
  if (batchDepth > 0) {
    return { changed, signals, selected: picked.selected, selectedIndex: picked.selectedIndex }
  }
  const activeTab = await getActiveTab(windowId).catch(() => tab)
  const { payload } = await buildActionView(activeTab, settings, viewMode, {
    changed,
    signals,
    derive: () => ({ changed, signals }),
  })
  return { ...payload, op: 'select_option', selected: picked.selected, selectedIndex: picked.selectedIndex }
}

export { labelPage as labelElements, clickLabelled as clickElementByLabel }

/** @param {unknown} error */
function isDebuggerBusy(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'DEBUGGER_BUSY')
}

/**
 * Validate type arguments.
 * @param {Record<string, any>} args
 * @returns {{text: string, mode: 'replace'|'append', label: number|undefined, submit: boolean}}
 */
function parseTypeArgs(args) {
  if (typeof args.text !== 'string' || args.text.length > 20_000) {
    throw new BrowserError('BAD_TEXT', 'text must be a string of at most 20000 characters')
  }
  let mode = 'replace'
  if (args.mode !== undefined) {
    if (args.mode !== 'replace' && args.mode !== 'append') {
      throw new BrowserError('BAD_MODE', "mode must be 'replace' or 'append'")
    }
    mode = args.mode
  }
  let label
  if (args.label !== undefined && args.label !== null) {
    const value = Number(args.label)
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BrowserError('BAD_LABEL', 'label must be a positive integer from the current view')
    }
    label = value
  }
  return { text: args.text, mode, label, submit: args.submit === true }
}

/**
 * Trusted fallback for a labelled field whose DOM typing did not verify: focus
 * and select in the page, then insert text through the debugger.
 * @param {number} tabId
 * @param {{frameId: number, localId: number}} target
 * @param {{text: string, mode: 'replace'|'append'}} request
 * @param {Record<string, any>} domResult
 */
async function trustedTypeIntoLabel(tabId, target, request, domResult) {
  let prepared
  try {
    prepared = await runInFrame(tabId, target.frameId, prepareLabelledTyping, [target.localId, request.mode], 3_000)
  } catch {
    prepared = undefined
  }
  if (!prepared?.ok) return { method: 'dom', ...domResult }
  try {
    await withDebugger(tabId, () => chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: request.text }))
  } catch (error) {
    if (isDebuggerBusy(error)) throw error
    return { method: 'dom', ...domResult }
  }
  let read
  try {
    read = await runInFrame(tabId, target.frameId, readLabelledField, [target.localId], 3_000)
  } catch {
    read = undefined
  }
  return {
    method: 'trusted',
    isPassword: domResult.isPassword === true,
    beforeChars: domResult.beforeChars ?? 0,
    beforePreview: domResult.beforePreview ?? '',
    afterChars: read?.chars ?? domResult.afterChars ?? 0,
    valuePreview: read?.preview ?? domResult.valuePreview ?? '',
  }
}

/**
 * Label-less trusted typing: Input.insertText goes to whatever already has
 * focus (the canvas-editor case, where a caret click put it there).
 * @param {number} tabId
 * @param {{text: string}} request
 * @param {string|undefined} canvasEditor
 */
async function trustedTypeIntoFocus(tabId, request, canvasEditor) {
  if (canvasEditor) {
    await withDebugger(tabId, () => chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: request.text }))
    await settleAfterInput(tabId, undefined)
    return {
      method: 'trusted',
      beforeChars: 0,
      beforePreview: '',
      afterChars: 0,
      valuePreview: undefined,
      verdict: {
        changed: null,
        charsAdded: null,
        measured: 'none',
        canvasEditor: true,
        fieldChanged: null,
        pageChanged: null,
        targetKind: 'canvas',
      },
    }
  }
  let before
  try {
    before = summarizeContentProbe(await runInAllFrames(tabId, contentProbePage, ['start'], 2_500))
  } catch {
    before = undefined
  }
  try {
    await withDebugger(tabId, () => chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: request.text }))
  } catch (error) {
    // Never leave a MutationObserver running in every frame of the page.
    if (before) await runInAllFrames(tabId, contentProbePage, ['end'], 1_000).catch(() => {})
    throw error
  }
  await settleAfterInput(tabId, undefined)
  let after
  try {
    after = summarizeContentProbe(await runInAllFrames(tabId, contentProbePage, ['end'], 2_500))
  } catch {
    after = undefined
  }
  const verdict = deriveTypeVerdict(before, after)
  const measurable = verdict.measured === 'field'
  return {
    method: 'trusted',
    isPassword: before?.focus?.isPassword === true || after?.focus?.isPassword === true,
    beforeChars: measurable ? Number(before?.focus?.chars) || 0 : 0,
    beforePreview: measurable ? String(before?.focus?.preview ?? '') : '',
    afterChars: measurable ? Number(after?.focus?.chars) || 0 : 0,
    // A canvas-like editor has no readable value to quote; "value now" must not
    // be printed from the page text of the previous view.
    valuePreview: measurable ? String(after?.focus?.preview ?? '') : undefined,
    verdict,
  }
}

/**
 * Press Enter through the debugger, falling back to synthetic key events.
 * @param {number} tabId
 */
async function pressEnter(tabId) {
  const spec = KEY_SPECS.Enter
  try {
    await withDebugger(tabId, () => dispatchTrustedKey(tabId, spec, 0))
    return true
  } catch (error) {
    if (isDebuggerBusy(error)) throw error
    await runInTab(tabId, syntheticKeyPage, [spec.key, spec.code, spec.keyCode, 0], 2_000)
    return false
  }
}

/**
 * Type into a field. Label path prefers the DOM path and falls back to trusted
 * Input.insertText; label-less path always types through the debugger into the
 * focused element. Returns a fresh view plus what was typed.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function typeText(settings, args) {
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const request = parseTypeArgs(args)
  const canvasEditor = canvasEditorForUrl(tab.url)
  if (canvasEditor && request.label === undefined && (request.mode === 'append' || request.text.length === 0)) {
    throw new BrowserError(
      'CANVAS_TYPE_UNSUPPORTED',
      `${canvasEditor} unlabelled typing inserts at the caret or replaces the current selection. Append and empty-text clearing are not verifiable here; use a labelled field, or select the intended range and use Backspace/Delete in a separate action.`,
    )
  }
  let outcome
  try {
    if (request.label !== undefined) {
      const target = resolveLabelTarget(tab, request.label)
      if (!target) throw await decorateStaleLabelError(tab, missingLabelError(tab, request.label))
      let domResult
      try {
        domResult = await runInFrame(tab.id, target.frameId, typeLabelled, [target.localId, request.text, request.mode], 5_000)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code === 'SCRIPT_TIMEOUT') throw new BrowserError('TYPE_TIMEOUT', 'Typing into this field did not complete. Take a fresh view and try again.')
        throw error
      }
      if (domResult?.ok === false) {
        if (domResult.code === 'NOT_EDITABLE') {
          outcome = await trustedTypeIntoFallbackTarget(tab.id, target, request)
        } else {
          const error = new BrowserError(domResult.code ?? 'TYPE_FAILED', domResult.message ?? 'Could not type into this field.')
          throw await decorateStaleLabelError(tab, error, domResult.valuePreview)
        }
      } else {
        outcome = domResult.verified
          ? { method: 'dom', ...domResult }
          : await trustedTypeIntoLabel(tab.id, target, request, domResult)
      }
    } else {
      outcome = await trustedTypeIntoFocus(tab.id, request, canvasEditor)
    }
  } catch (error) {
    if (canvasEditor) invalidateCanvasImageBases(tab.id)
    throw error
  }
  if (canvasEditor) invalidateCanvasImageBases(tab.id)
  let submitted = false
  if (request.submit) {
    await pressEnter(tab.id)
    submitted = true
  }
  const beforeChars = outcome.beforeChars ?? 0
  const afterChars = outcome.afterChars ?? 0
  const beforePreview = outcome.beforePreview ?? ''
  const valuePreview = outcome.valuePreview
  const verdict = outcome.verdict
  const changed = verdict === undefined
    ? afterChars !== beforeChars || valuePreview !== beforePreview
    : verdict.changed
  const signals = changed === true ? ['text-changed'] : []
  const typed = {
    ...(request.label === undefined ? {} : { label: request.label }),
    chars: request.text.length,
    mode: request.mode,
    submitted,
    method: outcome.method,
    beforeChars,
    afterChars,
    charsAdded: verdict === undefined ? afterChars - beforeChars : verdict.charsAdded,
    ...(verdict === undefined
      ? { valuePreview: valuePreview ?? '' }
      : {
          measured: verdict.measured,
          canvasEditor: verdict.canvasEditor,
          pageChanged: verdict.pageChanged,
          ...(verdict.canvasEditor ? { dispatched: true, verified: false } : { verified: changed === true }),
          ...(valuePreview === undefined ? {} : { valuePreview }),
        }),
  }
  if (batchDepth > 0) return { changed, signals, typed }
  const activeTab = await getActiveTab(windowId).catch(() => tab)
  const viewMode = actionViewForTab(activeTab, parseViewArg(args, 'auto'))
  const { payload } = await buildActionView(activeTab, settings, viewMode, { changed, signals })
  return { ...payload, op: 'type', typed, changed, signals }
}

/**
 * Normalize a key argument to its printable character entry. Physical code
 * names KeyA / Digit1 are accepted as well.
 * @param {string} raw
 */
function keyCharEntry(raw) {
  let char = raw
  const codeLetter = /^Key([a-zA-Z])$/u.exec(raw)
  if (codeLetter) char = codeLetter[1].toLowerCase()
  const codeDigit = /^Digit([0-9])$/u.exec(raw)
  if (codeDigit) char = codeDigit[1]
  const entry = KEY_CHAR_TABLE[char]
  return entry ? { char, entry } : undefined
}

/**
 * Resolve a press_key key name into DOM + CDP keyboard data.
 * @param {string} raw
 * @param {number} mask
 * @returns {{key: string, code: string, keyCode: number, text?: string}}
 */
function resolveKeySpec(raw, mask) {
  const named = Object.keys(KEY_SPECS).find(name => name.toLowerCase() === raw.toLowerCase())
  if (named) {
    const base = KEY_SPECS[named]
    const shiftedNamed = (mask & MODIFIER_BITS.shift) !== 0
    if (shiftedNamed && base.shifted) {
      return { key: base.shifted, code: base.code, keyCode: base.keyCode, text: base.shifted }
    }
    return base
  }
  const found = keyCharEntry(raw)
  if (!found) throw new BrowserError('BAD_KEY', `Unsupported key ${JSON.stringify(raw)}`)
  const { char, entry } = found
  const shifted = (mask & MODIFIER_BITS.shift) !== 0
  const plain = (mask & (MODIFIER_BITS.ctrl | MODIFIER_BITS.alt | MODIFIER_BITS.meta)) === 0
  const key = entry.needsShift === true
    ? entry.key
    : (shifted && entry.shifted ? entry.shifted : char)
  return { key, code: entry.code, keyCode: entry.keyCode, ...(plain ? { text: key } : {}) }
}

/**
 * Split an optional composite key string like "shift+Tab",
 * "ctrl+Shift+ArrowLeft", or "meta+Enter" into modifiers and one key token.
 * The later `modifiers` array path keeps working unchanged and is merged in.
 * @param {string} raw
 * @returns {{key: string, modifiers: string[]}}
 */
function splitCompositeKey(raw) {
  if (raw === '+' || !raw.includes('+')) return { key: raw, modifiers: [] }
  const parts = raw.split('+').map(part => part.trim())
  if (parts.length < 2 || parts.some(part => part.length === 0)) {
    throw new BrowserError('BAD_KEY', `Could not parse ${JSON.stringify(raw)}; use a form like shift+Tab or ctrl+Shift+ArrowLeft`)
  }
  const key = parts[parts.length - 1]
  const modifiers = []
  for (const token of parts.slice(0, -1)) {
    const value = token.toLowerCase()
    if (!(value in MODIFIER_BITS)) {
      throw new BrowserError('BAD_KEY', `Unsupported modifier ${JSON.stringify(token)} in ${JSON.stringify(raw)}; use ctrl, alt, shift, meta`)
    }
    if (!modifiers.includes(value)) modifiers.push(value)
  }
  if (key.toLowerCase() in MODIFIER_BITS) {
    throw new BrowserError('BAD_KEY', `${JSON.stringify(raw)} ends with a modifier; put the key last (e.g. shift+Tab)`)
  }
  return { key, modifiers }
}

/**
 * Validate press_key arguments into a dispatchable key request. Accepts a
 * composite key string (`"shift+Tab"`), the legacy `modifiers` array, or both.
 * @param {Record<string, any>} args
 */
export function parsePressKeyArgs(args) {
  if (typeof args.key !== 'string' || args.key.length === 0) {
    throw new BrowserError('BAD_KEY', 'key must be a named key, a single printable ASCII character, or a KeyA/Digit1 code name')
  }
  const composite = splitCompositeKey(args.key)
  const key = composite.key
  const modifiers = [...composite.modifiers]
  if (args.modifiers !== undefined) {
    if (!Array.isArray(args.modifiers)) throw new BrowserError('BAD_KEY', 'modifiers must be an array')
    for (const item of args.modifiers) {
      const value = String(item).toLowerCase()
      if (!(value in MODIFIER_BITS)) throw new BrowserError('BAD_KEY', `Unsupported modifier ${JSON.stringify(item)}; use ctrl, alt, shift, meta`)
      if (!modifiers.includes(value)) modifiers.push(value)
    }
  }
  let mask = 0
  for (const item of modifiers) mask |= MODIFIER_BITS[item]
  // Shifted characters (A, ?, !) and shifted named keys (Colon) imply shift for
  // dispatch; the echoed modifiers stay exactly as the caller supplied them.
  const namedSpec = Object.keys(KEY_SPECS).find(name => name.toLowerCase() === key.toLowerCase())
  if (namedSpec && KEY_SPECS[namedSpec].shift === true && (mask & MODIFIER_BITS.shift) === 0) {
    mask |= MODIFIER_BITS.shift
  }
  if (keyCharEntry(key)?.entry.needsShift === true && (mask & MODIFIER_BITS.shift) === 0) {
    mask |= MODIFIER_BITS.shift
  }
  return { key, modifiers, mask, spec: resolveKeySpec(key, mask) }
}

/**
 * Dispatch one trusted keyDown/keyUp pair through the debugger. Key-down uses
 * text when the key produces one (Enter submits forms, Space inserts), and
 * rawKeyDown otherwise (Tab still moves focus).
 * @param {number} tabId
 * @param {{key: string, code: string, keyCode: number, text?: string}} spec
 * @param {number} mask
 */
async function dispatchTrustedKey(tabId, spec, mask) {
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers: mask,
  }
  const down = typeof spec.text === 'string'
    ? { type: 'keyDown', ...base, text: spec.text, unmodifiedText: spec.text }
    : { type: 'rawKeyDown', ...base }
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', down)
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/**
 * Press one key with optional modifiers, then return the resulting view.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function pressKey(settings, args) {
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const request = parsePressKeyArgs(args)
  const canvasEditor = canvasEditorForUrl(tab.url)
  const viewMode = actionViewForTab(tab, parseViewArg(args, 'auto'))
  const before = lastViewByTab.get(tab.id)
  const pressed = { key: request.key, modifiers: request.modifiers, trusted: true }
  try {
    await withDebugger(tab.id, () => dispatchTrustedKey(tab.id, request.spec, request.mask))
  } catch (error) {
    if (isDebuggerBusy(error)) throw error
    pressed.trusted = false
    await runInTab(tab.id, syntheticKeyPage, [request.spec.key, request.spec.code, request.spec.keyCode, request.mask], 2_000)
  } finally {
    if (canvasEditor) invalidateCanvasImageBases(tab.id)
  }
  await settleAfterInput(tab.id, undefined)
  if (batchDepth > 0) {
    const metrics = await runInTab(tab.id, pageMetrics, [])
    const derived = deriveFingerprintOutcome(before, metrics)
    return { changed: derived.changed, signals: derived.signals, pressed }
  }
  const activeTab = await getActiveTab(windowId).catch(() => tab)
  const { payload, mode } = await buildActionView(activeTab, settings, viewMode, {
    derive: ({ stored, metrics }) => deriveFingerprintOutcome(stored, metrics),
  })
  if (mode === 'full') {
    // Full views still verify the key press with a full-view pixel diff.
    const viewport = payload.viewport ?? { width: 1, height: 1 }
    const diff = await diffRegion(before, payload, viewport.width / 2, viewport.height / 2, Math.max(viewport.width, viewport.height))
    return { ...payload, op: 'press_key', pressed, changed: diff.changed, signals: diff.changed ? ['pixels-changed'] : [] }
  }
  return { ...payload, op: 'press_key', pressed }
}

/**
 * Validate navigate arguments.
 * @param {Record<string, any>} args
 * @returns {{url: string, newTab: boolean} | {history: 'back'|'forward'|'reload'}}
 */
function parseNavigateArgs(args) {
  const hasUrl = args.url !== undefined && args.url !== null && args.url !== ''
  const hasHistory = args.history !== undefined && args.history !== null && args.history !== ''
  if (hasUrl && hasHistory) throw new BrowserError('BAD_NAVIGATE', 'Provide either url or history for navigate, not both.')
  if (!hasUrl && !hasHistory) throw new BrowserError('BAD_NAVIGATE', 'navigate requires a url or a history action')
  if (hasHistory) {
    if (args.new_tab !== undefined) throw new BrowserError('BAD_NAVIGATE', 'new_tab is only valid with a url')
    const action = String(args.history)
    if (action !== 'back' && action !== 'forward' && action !== 'reload') {
      throw new BrowserError('BAD_NAVIGATE', "history must be 'back', 'forward', or 'reload'")
    }
    return { history: action }
  }
  let parsed
  try {
    parsed = new URL(String(args.url))
  } catch {
    throw new BrowserError('BAD_URL', 'url must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserError('BAD_URL', 'Only http and https URLs can be navigated to')
  }
  return { url: parsed.href, newTab: args.new_tab === true }
}

/**
 * Wait until a navigation has visibly started, so waitForTabComplete cannot
 * resolve against the old, already-complete document.
 * @param {number} tabId
 * @param {string|undefined} expectedUrl
 * @param {string} fromUrl
 * @param {boolean} isReload
 * @param {number} timeoutMs
 */
async function waitForNavigationStart(tabId, expectedUrl, fromUrl, isReload, timeoutMs) {
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab) return
    if (tab.status === 'loading') return
    if (typeof tab.pendingUrl === 'string' && tab.pendingUrl.length > 0) return
    if (expectedUrl !== undefined && tab.url === expectedUrl) return
    if (!isReload && tab.url !== fromUrl) return
    // Reload and same-URL history entries may complete before they are observed.
    if (performance.now() - started > 300 && tab.status === 'complete') return
    await sleep(25)
  }
}

/**
 * Navigate the active tab (or a new tab) and return a fresh view. The load wait
 * has a 15s budget; a timed-out load still returns a snapshot with timedOut.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function navigate(settings, args) {
  const request = parseNavigateArgs(args)
  const windowId = await getWindowId()
  const active = await getActiveTab(windowId)
  const fromUrl = active.url ?? ''
  let tabId = active.id
  let newTab = false
  let history
  if (request.url !== undefined) {
    if (request.newTab) {
      let created
      try {
        created = await chrome.tabs.create({ url: request.url, active: true })
      } catch (error) {
        throw new BrowserError('BAD_NAVIGATE', `Chrome could not open a new tab: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (created?.id === undefined) throw new BrowserError('BAD_NAVIGATE', 'Chrome did not create the requested tab')
      tabId = created.id
      newTab = true
    } else {
      try {
        await chrome.tabs.update(tabId, { url: request.url })
      } catch (error) {
        throw new BrowserError('BAD_NAVIGATE', `Chrome could not navigate this tab: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } else {
    history = request.history
    try {
      if (history === 'back') await chrome.tabs.goBack(tabId)
      else if (history === 'forward') await chrome.tabs.goForward(tabId)
      else await chrome.tabs.reload(tabId)
    } catch (error) {
      throw new BrowserError('BAD_NAVIGATE', `Chrome could not ${history} in this tab: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const waitStarted = performance.now()
  await waitForNavigationStart(tabId, request.url, fromUrl, history === 'reload', 1_500)
  const remaining = Math.max(1, 15_000 - (performance.now() - waitStarted))
  await waitForTabComplete(tabId, windowId, remaining)
  const waitMs = Math.round(performance.now() - waitStarted)
  const current = await chrome.tabs.get(tabId).catch(() => undefined)
  const timedOut = (current?.status ?? 'complete') !== 'complete'
  const navigated = {
    ...(request.url === undefined ? {} : { requestedUrl: request.url }),
    fromUrl,
    toUrl: current?.url ?? '',
    tabId,
    newTab,
    ...(history === undefined ? {} : { history }),
    status: current?.status ?? 'unknown',
    timedOut,
    waitMs,
  }
  if (batchDepth > 0) return { navigated }
  const shot = await snapshot('normal', settings)
  return { ...shot, op: 'navigate', navigated }
}

/**
 * Validate wait_for arguments.
 * @param {Record<string, any>} args
 * @returns {{conditions: {text?: string, url?: string, idle?: boolean, ms?: number}, timeoutMs: number}}
 */
export function parseWaitForArgs(args) {
  const conditions = {}
  if (args.text !== undefined) {
    if (typeof args.text !== 'string' || args.text.length === 0) {
      throw new BrowserError('BAD_WAIT', 'text must be a non-empty string')
    }
    conditions.text = args.text
  }
  if (args.url !== undefined) {
    if (typeof args.url !== 'string' || args.url.length === 0) {
      throw new BrowserError('BAD_WAIT', 'url must be a non-empty string')
    }
    conditions.url = args.url
  }
  if (args.idle !== undefined) {
    if (typeof args.idle !== 'boolean') throw new BrowserError('BAD_WAIT', 'idle must be a boolean')
    if (args.idle) conditions.idle = true
  }
  if (args.ms !== undefined) {
    if (!Number.isSafeInteger(args.ms) || args.ms < 0 || args.ms > 30_000) {
      throw new BrowserError('BAD_WAIT', 'ms must be a safe integer from 0 to 30000')
    }
    conditions.ms = args.ms
  }
  if (Object.keys(conditions).length === 0) {
    throw new BrowserError('BAD_WAIT', 'wait_for needs at least one of text, url, idle, or ms')
  }
  let timeoutMs = Math.max(10_000, conditions.ms ?? 0)
  if (args.timeout_ms !== undefined) {
    const value = Number(args.timeout_ms)
    if (!Number.isInteger(value) || value < 1_000 || value > 30_000) {
      throw new BrowserError('BAD_TIMEOUT', 'timeout_ms must be an integer from 1000 to 30000')
    }
    if (value < (conditions.ms ?? 0)) {
      throw new BrowserError('BAD_WAIT', 'timeout_ms must be greater than or equal to ms')
    }
    timeoutMs = value
  }
  return { conditions, timeoutMs }
}

/**
 * Wait for page conditions (text/url/idle), then return a fresh view.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function waitFor(settings, args) {
  const started = performance.now()
  const { conditions, timeoutMs } = parseWaitForArgs(args)
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  if (conditions.ms > 0) await pauseInTab(tab.id, conditions.ms)
  const remaining = Math.max(1, timeoutMs - Math.round(performance.now() - started))
  const pageConditions = {
    text: conditions.text ?? null,
    url: conditions.url ?? null,
    idle: conditions.idle === true,
  }
  const polled = await runInTab(tab.id, waitForConditionsPage, [pageConditions, remaining], remaining + 2_000)
  const found = polled?.found === true
  const elapsedMs = Math.round(performance.now() - started)
  const waited = { conditions, found, timedOut: !found, elapsedMs }
  if (batchDepth > 0) return { waited }
  const shot = await snapshot('normal', settings)
  return { ...shot, op: 'wait_for', waited }
}

/**
 * Validate one side of a select drag.
 * @param {unknown} value
 * @param {string} name
 */
function parseSelectPoint(value, name) {
  const x = Number(value?.x)
  const y = Number(value?.y)
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new BrowserError('BAD_SELECTION', `${name} must be an object with finite x and y`)
  }
  return { x, y }
}

/**
 * Validate select arguments.
 * @param {Record<string, any>} args
 */
function parseSelectArgs(args) {
  const from = parseSelectPoint(args.from, 'from')
  const to = parseSelectPoint(args.to, 'to')
  const space = args.space === 'css' ? 'css' : 'image'
  const view = parseViewArg(args, 'auto')
  const viewId = parseViewId(args.view_id)
  return { from, to, space, view, viewId }
}

/**
 * Trusted drag from one CSS point to another through the debugger.
 * @param {number} tabId
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 */
async function trustedDrag(tabId, fromX, fromY, toX, toY) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: fromX, y: fromY, button: 'none', clickCount: 0,
  })
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1,
  })
  const steps = 4
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: fromX + (toX - fromX) * progress,
      y: fromY + (toY - fromY) * progress,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })
  }
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1,
  })
}

/**
 * Trusted drag selection between two points, then report the selected text.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function selectRange(settings, args) {
  const request = parseSelectArgs(args)
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const canvasEditor = canvasEditorForUrl(tab.url)
  const selectionError = canvasSelectionError(tab.url ?? '')
  if (selectionError) throw new BrowserError(selectionError.code, selectionError.message)
  request.view = actionViewForTab(tab, request.view)
  const before = lastViewByTab.get(tab.id)
  const history = (imageBasesByTab.get(tab.id) ?? []).filter(basis => basis.url === (tab.url ?? ''))
  const resolved = canvasEditor
    ? resolveCanvasImageBasis(request.viewId, history)
    : request.space === 'image'
      ? resolveImageBasis({ space: request.space, viewId: request.viewId, points: [request.from, request.to] }, history)
      : {}
  if (resolved.error) throw new BrowserError(resolved.error.code, resolved.error.message)
  const basis = resolved.basis
  const liveMetrics = canvasEditor ? await runInTab(tab.id, pageMetrics, []) : undefined
  if (canvasEditor) {
    if (!before?.image?.data || Number(before.viewId) !== Number(basis?.viewId)) {
      throw new BrowserError('NO_VIEW', 'Take a full fresh view before using coordinates in this canvas editor.')
    }
    const basisError = canvasBasisError(basis, liveMetrics, scrollFor(tab, liveMetrics))
    if (basisError) throw new BrowserError(basisError.code, basisError.message)
  }
  const viewport = liveMetrics?.viewport ?? before?.viewport ?? await runInTab(tab.id, pageMetrics, [])
  if (!canvasEditor && request.space === 'image' && (!before?.image?.data || !basis)) {
    throw new BrowserError('NO_VIEW', 'Take a screenshot first so image coordinates can be mapped to the page.')
  }
  const mismatch = request.space === 'image'
    ? findCoordinateBasisMismatch([request.from, request.to], basis, history)
    : { stale: [], ambiguous: [] }
  if (request.viewId !== undefined) mismatch.ambiguous = []
  if (mismatch.stale.length > 0) {
    const current = basisSummary(basis)
    const stale = mismatch.stale[0].from
    throw new BrowserError(
      'STALE_VIEW',
      `These image coordinates look like they came from view #${stale.viewId} (${stale.imageWidth}x${stale.imageHeight} image), but the current coordinate basis is view #${current.viewId} (${current.imageWidth}x${current.imageHeight}). Take a fresh view and measure the points again.`,
    )
  }
  if (mismatch.ambiguous.length > 0) {
    throw new BrowserError('AMBIGUOUS_VIEW', 'These selection coordinates fit more than one image scale. Take a fresh view and pass its view_id; no drag was dispatched.')
  }
  const scale = request.space === 'image' ? basis.viewport.width / basis.imageWidth : 1
  const mapped = mapClickPoints([request.from, request.to], request.space, viewport, scale)
  if (mapped.some(point => point.offScreen)) {
    throw new BrowserError('OFF_SCREEN_SELECTION', 'A selection endpoint is outside the current viewport. Take a fresh view and measure both endpoints again; no drag was dispatched.')
  }
  const fromCss = { x: mapped[0].cssX, y: mapped[0].cssY }
  const toCss = { x: mapped[1].cssX, y: mapped[1].cssY }
  try {
    await withDebugger(tab.id, () => trustedDrag(tab.id, fromCss.x, fromCss.y, toCss.x, toCss.y))
  } catch (error) {
    if (isDebuggerBusy(error)) throw error
    try {
      await runInTab(tab.id, syntheticDrag, [fromCss.x, fromCss.y, toCss.x, toCss.y], 2_000)
    } catch {
      // The result below reports the selection as unknown or collapsed.
    }
  } finally {
    if (canvasEditor) invalidateCanvasImageBases(tab.id)
  }
  let selection
  if (!canvasEditor) {
    try {
      selection = await runInTab(tab.id, readSelection, [], 2_000)
    } catch (error) {
      throw new BrowserError('SELECT_FAILED', `Could not read the selection: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const text = typeof selection?.text === 'string' ? selection.text : ''
  const chars = canvasEditor
    ? null
    : Number.isFinite(Number(selection?.chars)) ? Number(selection.chars) : text.length
  const selected = {
    chars,
    textPreview: canvasEditor ? '' : text.slice(0, 200),
    collapsed: canvasEditor ? null : selection?.collapsed !== false,
    verified: canvasEditor ? false : Number(chars) > 0,
    ...(canvasEditor ? { dispatched: true } : {}),
    from: { space: request.space, x: request.from.x, y: request.from.y, cssX: Math.round(fromCss.x), cssY: Math.round(fromCss.y) },
    to: { space: request.space, x: request.to.x, y: request.to.y, cssX: Math.round(toCss.x), cssY: Math.round(toCss.y) },
  }
  const changed = canvasEditor ? null : Number(chars) > 0
  const signals = changed === true ? ['selection-changed'] : []
  const basisFields = basis ? { basis: basisSummary(basis) } : {}
  if (batchDepth > 0) return { changed, signals, selected, ...basisFields }
  const activeTab = await getActiveTab(windowId).catch(() => tab)
  const { payload } = await buildActionView(activeTab, settings, actionViewForTab(activeTab, request.view), { changed, signals })
  return { ...payload, op: 'select', selected, changed, signals, ...basisFields }
}

/**
 * Type into a non-editable labelled surface by focusing the nearest editable
 * target and using trusted Input.insertText.
 * @param {number} tabId
 * @param {{frameId: number, localId: number}} target
 * @param {{text: string, mode: 'replace'|'append'}} request
 */
async function trustedTypeIntoFallbackTarget(tabId, target, request) {
  let focused
  try {
    focused = await runInFrame(tabId, target.frameId, focusTypingTarget, [target.localId], 3_000)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'SCRIPT_TIMEOUT') {
      throw new BrowserError('TYPE_TIMEOUT', 'Focusing the typing target did not complete. Take a fresh view and try again.')
    }
    throw error
  }
  if (focused?.ok === false) {
    throw new BrowserError(focused.code ?? 'NOT_EDITABLE', focused.message ?? 'This element does not accept text.')
  }
  try {
    await withDebugger(tabId, () => chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: request.text }))
  } catch (error) {
    if (isDebuggerBusy(error)) throw error
    if (!focused.activeEditable) {
      throw new BrowserError('NOT_EDITABLE', 'This element does not accept text and trusted input is unavailable.')
    }
    return {
      method: 'trusted-focus',
      isPassword: focused.isPassword === true,
      beforeChars: focused.beforeChars ?? 0,
      beforePreview: focused.beforePreview ?? '',
      afterChars: focused.beforeChars ?? 0,
      valuePreview: focused.beforePreview ?? '',
    }
  }
  await settleAfterInput(tabId, undefined)
  let after
  try {
    after = await runInFrame(tabId, target.frameId, readFocusedField, [], 2_000)
  } catch {
    after = undefined
  }
  const beforeChars = focused.beforeChars ?? 0
  const afterChars = after?.chars ?? 0
  if (afterChars === beforeChars && focused.activeEditable !== true) {
    throw new BrowserError('NOT_EDITABLE', 'This element does not accept text.')
  }
  return {
    method: 'trusted-focus',
    isPassword: focused.isPassword === true || after?.isPassword === true,
    beforeChars,
    beforePreview: focused.beforePreview ?? '',
    afterChars,
    valuePreview: after?.preview ?? '',
  }
}

/* ------------------------------------------------------------------ */
/* Clipboard: internal ("virtual") and system clipboard                 */
/* ------------------------------------------------------------------ */

/** Stable error for denied system-clipboard access, with an alternative. */
function clipboardDeniedError(actionLabel, error) {
  const detail = error instanceof Error ? `${error.name || 'Error'}: ${error.message}` : String(error)
  return new BrowserError(
    'CLIPBOARD_DENIED',
    `The system clipboard is unavailable for ${actionLabel} (${detail}). Keep the side panel focused and allow clipboard access for this extension in chrome://extensions, or use the virtual clipboard with target:"virtual".`,
  )
}

/** @param {string} text */
async function writeSystemClipboard(text) {
  try {
    if (typeof navigator?.clipboard?.writeText !== 'function') throw new Error('navigator.clipboard.writeText is unavailable')
    await navigator.clipboard.writeText(text)
  } catch (error) {
    throw clipboardDeniedError('writing', error)
  }
}

/**
 * Read text from the computer clipboard. Empty and non-text clipboards fail with
 * CLIPBOARD_EMPTY so an empty result is never mistaken for content.
 * @returns {Promise<string>}
 */
async function readSystemClipboard() {
  let raw
  try {
    if (typeof navigator?.clipboard?.readText !== 'function') throw new Error('navigator.clipboard.readText is unavailable')
    raw = await navigator.clipboard.readText()
  } catch (error) {
    throw clipboardDeniedError('reading', error)
  }
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  if (text.trim().length === 0) {
    throw new BrowserError('CLIPBOARD_EMPTY', 'The system clipboard is empty or holds no text. Copy something first, or use the virtual clipboard with target:"virtual".')
  }
  return text
}

/** chrome.storage.session is the virtual clipboard's only backing store. */
function requireClipboardSession() {
  const session = chrome.storage?.session
  if (!session || typeof session.get !== 'function' || typeof session.set !== 'function') {
    throw new BrowserError('CLIPBOARD_UNAVAILABLE', 'chrome.storage.session is unavailable in this extension context. Reload the extension so the virtual clipboard can be stored.')
  }
  return session
}

/** @returns {Promise<{text: string, chars: number, source: string, tabId: number|null, url: string, at: number}|undefined>} */
async function readVirtualClipboard() {
  const session = requireClipboardSession()
  const stored = await session.get(CLIPBOARD_STORAGE_KEY)
  return normalizeClipboardEntry(stored?.[CLIPBOARD_STORAGE_KEY])
}

/** @param {{text: string, chars: number, source: string, tabId: number|null, url: string, at: number}} entry */
async function writeVirtualClipboard(entry) {
  const session = requireClipboardSession()
  await session.set({ [CLIPBOARD_STORAGE_KEY]: entry })
}

async function clearVirtualClipboard() {
  const session = requireClipboardSession()
  if (typeof session.remove !== 'function') {
    await session.set({ [CLIPBOARD_STORAGE_KEY]: undefined })
    return
  }
  await session.remove(CLIPBOARD_STORAGE_KEY)
}

/**
 * Shared metadata on every clipboard result. Clipboard text can be large, so
 * only char counts and a short preview ever appear here.
 * @param {'virtual'|'system'} target
 * @param {{chars?: number|null, preview?: string, source?: string, label?: number, truncated?: boolean, originalChars?: number, cleared?: boolean, rich?: boolean}} [extra]
 */
function clipboardMeta(target, extra = {}) {
  const rawChars = extra.chars
  const chars = rawChars === null || rawChars === undefined
    ? null
    : Number.isFinite(Number(rawChars)) ? Math.max(0, Math.floor(Number(rawChars))) : null
  return {
    target,
    system: target === 'system',
    chars,
    ...(typeof extra.preview === 'string' && extra.preview.length > 0 ? { preview: extra.preview } : {}),
    ...(typeof extra.source === 'string' && extra.source.length > 0 ? { source: extra.source } : {}),
    ...(extra.label === undefined ? {} : { label: extra.label }),
    ...(extra.truncated === true ? { truncated: true } : {}),
    ...(Number.isFinite(Number(extra.originalChars)) ? { originalChars: Math.floor(Number(extra.originalChars)) } : {}),
    ...(extra.cleared === true ? { cleared: true } : {}),
    ...(extra.rich === true ? { rich: true } : {}),
  }
}

/**
 * Validate clipboard arguments before any page, storage, or clipboard access.
 * @param {Record<string, any>} args
 * @returns {{action: string, target: 'virtual'|'system', source: 'selection'|'label', label: number|undefined, text: string|undefined, mode: 'replace'|'append', submit: boolean, rich: boolean, view: 'auto'|'full'|'compact'|'none'}}
 */
export function parseClipboardArgs(args = {}) {
  const raw = args ?? {}
  const action = raw.action
  if (typeof action !== 'string' || !CLIPBOARD_ACTIONS.includes(action)) {
    throw new BrowserError('BAD_CLIPBOARD_ACTION', `action must be one of ${CLIPBOARD_ACTIONS.join(', ')}`)
  }
  let target = 'virtual'
  if (raw.target !== undefined && raw.target !== null) {
    if (typeof raw.target !== 'string' || !CLIPBOARD_TARGETS.includes(raw.target.toLowerCase())) {
      throw new BrowserError('BAD_CLIPBOARD_TARGET', "target must be 'virtual' or 'system'")
    }
    target = raw.target.toLowerCase()
  }
  if (action === 'clear' && target !== 'virtual') {
    throw new BrowserError('BAD_CLIPBOARD_TARGET', 'clear empties the virtual clipboard only; omit target or use target:"virtual"')
  }
  let label
  if (raw.label !== undefined && raw.label !== null) {
    const value = Number(raw.label)
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BrowserError('BAD_LABEL', 'label must be a positive integer from the current view')
    }
    label = value
  }
  let source = 'selection'
  if (action === 'copy') {
    const explicitSource = raw.source
    if (explicitSource !== undefined && explicitSource !== null) {
      if (typeof explicitSource !== 'string' || !CLIPBOARD_SOURCES.includes(explicitSource)) {
        throw new BrowserError('BAD_CLIPBOARD_SOURCE', "source must be 'selection' or 'label'")
      }
      source = explicitSource
    } else if (label !== undefined) {
      source = 'label'
    }
    if (source === 'label' && label === undefined) {
      throw new BrowserError('BAD_LABEL', 'copy with source:"label" requires a label from the current view')
    }
    if (source === 'selection' && label !== undefined) {
      throw new BrowserError('BAD_LABEL', 'label is only valid with copy source:"label"')
    }
  } else if (raw.source !== undefined && raw.source !== null) {
    throw new BrowserError('BAD_CLIPBOARD_SOURCE', 'source is only valid for action "copy"')
  }
  let text
  if (action === 'write') {
    if (typeof raw.text !== 'string') {
      throw new BrowserError('BAD_TEXT', 'write requires a string text')
    }
    if (raw.text.length === 0) {
      throw new BrowserError('BAD_TEXT', 'text must not be empty; use action "clear" to empty the clipboard')
    }
    text = raw.text
  } else if (raw.text !== undefined && typeof raw.text !== 'string') {
    throw new BrowserError('BAD_TEXT', 'text must be a string')
  }
  let mode = 'replace'
  if (raw.mode !== undefined && raw.mode !== null) {
    if (raw.mode !== 'replace' && raw.mode !== 'append') {
      throw new BrowserError('BAD_MODE', "mode must be 'replace' or 'append'")
    }
    mode = raw.mode
  }
  let rich = true
  if (raw.rich !== undefined && raw.rich !== null) {
    if (typeof raw.rich !== 'boolean') throw new BrowserError('BAD_RICH', 'rich must be true or false')
    rich = raw.rich
  }
  return {
    action,
    target,
    source,
    label,
    text,
    mode,
    submit: raw.submit === true,
    rich,
    view: parseViewArg(raw, action === 'paste' ? 'auto' : 'none'),
  }
}

/**
 * action copy: read the current page selection or one labelled element, then
 * store it in the chosen clipboard. Never clicks or edits the page.
 * @param {ReturnType<typeof parseClipboardArgs>} request
 */
async function clipboardCopy(request) {
  const started = performance.now()
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  let text = ''
  let totalChars = 0
  if (request.source === 'label') {
    const target = resolveLabelTarget(tab, request.label)
    if (!target) throw missingLabelError(tab, request.label)
    let read
    try {
      read = await runInFrame(tab.id, target.frameId, readLabelClipboardText, [target.localId], 3_000)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'SCRIPT_TIMEOUT') {
        throw new BrowserError('COPY_TIMEOUT', 'Reading this label did not complete. Take a fresh view and try again.')
      }
      throw error
    }
    if (read?.ok === false) {
      throw new BrowserError(
        typeof read.code === 'string' ? read.code : 'COPY_FAILED',
        typeof read.message === 'string' ? read.message : `Could not read label ${request.label}.`,
      )
    }
    text = typeof read?.text === 'string' ? read.text : ''
    totalChars = Number.isFinite(Number(read?.totalChars)) ? Number(read.totalChars) : text.length
  } else {
    let selection
    try {
      selection = await runInTab(tab.id, readSelectionForClipboard, [100_000], 2_000)
    } catch (error) {
      throw new BrowserError('COPY_FAILED', `Could not read the page selection: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (selection?.collapsed === true || typeof selection?.text !== 'string' || selection.text.length === 0) {
      throw new BrowserError('CLIPBOARD_EMPTY', 'Nothing is selected on the page. Select text first with browser_select, or copy a labelled element with source:"label".')
    }
    text = selection.text
    totalChars = Number.isFinite(Number(selection.totalChars)) ? Number(selection.totalChars) : text.length
  }
  if (text.length === 0) {
    throw new BrowserError('CLIPBOARD_EMPTY', request.source === 'label' ? `Label ${request.label} has no text to copy.` : 'Nothing is selected on the page.')
  }
  const fitted = fitClipboardText(text)
  const originalChars = Math.max(totalChars, fitted.originalChars)
  const truncated = fitted.truncated || originalChars > fitted.chars
  if (request.target === 'system') {
    await writeSystemClipboard(fitted.text)
  } else {
    await writeVirtualClipboard(makeClipboardEntry({
      text: fitted.text,
      source: request.source,
      tabId: tab.id,
      url: typeof tab.url === 'string' ? tab.url : '',
      at: Date.now(),
    }))
  }
  return {
    op: 'clipboard',
    action: 'copy',
    clipboard: clipboardMeta(request.target, {
      chars: fitted.chars,
      preview: clipboardPreview(fitted.text),
      source: request.source,
      ...(request.label === undefined ? {} : { label: request.label }),
      ...(truncated ? { truncated: true, originalChars } : {}),
    }),
    totalMs: Math.round(performance.now() - started),
  }
}

/**
 * action read: return clipboard text. The system clipboard is read only for an
 * explicit target:"system" read. Returned text is capped at 20k chars and the
 * full length is reported separately.
 * @param {ReturnType<typeof parseClipboardArgs>} request
 */
async function clipboardRead(request) {
  const started = performance.now()
  if (request.target === 'system') {
    const raw = await readSystemClipboard()
    const clipped = clipClipboardText(raw, CLIPBOARD_READ_MAX_CHARS)
    return {
      op: 'clipboard',
      action: 'read',
      clipboard: clipboardMeta('system', { chars: raw.length, preview: clipboardPreview(clipped.text) }),
      text: clipped.text,
      totalChars: raw.length,
      offset: clipped.offset,
      truncated: clipped.truncated,
      totalMs: Math.round(performance.now() - started),
    }
  }
  const entry = await readVirtualClipboard()
  if (!entry || entry.text.length === 0) {
    throw new BrowserError('CLIPBOARD_EMPTY', 'The virtual clipboard is empty. Copy text first (action "copy" or "write"), or use target:"system".')
  }
  const clipped = clipClipboardText(entry.text, CLIPBOARD_READ_MAX_CHARS)
  return {
    op: 'clipboard',
    action: 'read',
    clipboard: {
      ...clipboardMeta('virtual', {
        chars: entry.chars,
        preview: clipboardPreview(clipped.text),
        source: entry.source,
      }),
      ...(entry.tabId === null ? {} : { tabId: entry.tabId }),
      ...(entry.url.length === 0 ? {} : { url: entry.url }),
      ...(entry.at > 0 ? { at: entry.at } : {}),
    },
    text: clipped.text,
    totalChars: entry.chars,
    offset: clipped.offset,
    truncated: clipped.truncated,
    totalMs: Math.round(performance.now() - started),
  }
}

/**
 * action write: store caller-supplied text (capped at 100k chars with a clear
 * marker) in the chosen clipboard.
 * @param {ReturnType<typeof parseClipboardArgs>} request
 */
async function clipboardWrite(request) {
  const started = performance.now()
  const fitted = fitClipboardText(request.text)
  if (request.target === 'system') {
    await writeSystemClipboard(fitted.text)
  } else {
    await writeVirtualClipboard(makeClipboardEntry({
      text: fitted.text,
      source: 'write',
      tabId: null,
      url: '',
      at: Date.now(),
    }))
  }
  return {
    op: 'clipboard',
    action: 'write',
    clipboard: clipboardMeta(request.target, {
      chars: fitted.chars,
      preview: clipboardPreview(fitted.text),
      source: 'write',
      ...(fitted.truncated ? { truncated: true, originalChars: fitted.originalChars } : {}),
    }),
    totalMs: Math.round(performance.now() - started),
  }
}

/** action clear: empty the virtual clipboard (the only clipboard it applies to). */
async function clipboardClear() {
  const started = performance.now()
  await clearVirtualClipboard()
  return {
    op: 'clipboard',
    action: 'clear',
    clipboard: clipboardMeta('virtual', { chars: 0, cleared: true }),
    totalMs: Math.round(performance.now() - started),
  }
}

/**
 * action paste: insert clipboard content into the page. The virtual clipboard
 * (and system with rich:false) types text through the existing typeText path so
 * mode/submit/verification match browser_type. system with rich:true (default)
 * focuses the target and sends one trusted Ctrl+V so the page pastes rich text
 * and images itself.
 * @param {import('./protocol.js').Settings} settings
 * @param {ReturnType<typeof parseClipboardArgs>} request
 */
async function clipboardPaste(settings, request) {
  const started = performance.now()
  if (request.target === 'system' && request.rich) {
    if (request.label !== undefined) {
      const focused = await click(settings, { label: request.label, view: 'none' })
      if (focused?.navigated === true) {
        throw new BrowserError('PASTE_NAVIGATED', `Label ${request.label} navigated the page instead of focusing a field; take a fresh view and paste into the loaded page.`)
      }
    }
    const keyed = await pressKey(settings, { key: 'v', modifiers: ['ctrl'], view: request.view })
    const trusted = keyed?.pressed?.trusted === true
    return {
      ...keyed,
      op: 'clipboard',
      action: 'paste',
      clipboard: clipboardMeta('system', { chars: null, rich: true }),
      pasted: {
        chars: null,
        mode: 'keys',
        ...(request.label === undefined ? {} : { label: request.label }),
        via: 'keys',
        trusted,
        rich: true,
        note: trusted
          ? 'rich content (text, images) was pasted by the page via trusted Ctrl+V'
          : 'the trusted Ctrl+V dispatch failed, so a synthetic paste cannot land; focus the page and retry',
      },
      totalMs: Math.round(performance.now() - started),
    }
  }
  let text = ''
  let totalChars = 0
  let source = 'unknown'
  if (request.target === 'system') {
    text = await readSystemClipboard()
    totalChars = text.length
    source = 'system'
  } else {
    const entry = await readVirtualClipboard()
    if (!entry || entry.text.length === 0) {
      throw new BrowserError('CLIPBOARD_EMPTY', 'The virtual clipboard is empty. Copy text first (action "copy" or "write").')
    }
    text = entry.text
    totalChars = entry.chars
    source = entry.source
  }
  const clipped = clipClipboardText(text, CLIPBOARD_TYPE_MAX_CHARS)
  const truncated = clipped.truncated
  const typed = await typeText(settings, {
    text: clipped.text,
    ...(request.label === undefined ? {} : { label: request.label }),
    mode: request.mode,
    submit: request.submit,
    view: request.view,
  })
  const pastedChars = Number.isFinite(Number(typed?.typed?.chars)) ? Number(typed.typed.chars) : clipped.chars
  return {
    ...typed,
    op: 'clipboard',
    action: 'paste',
    clipboard: clipboardMeta(request.target, {
      chars: totalChars,
      preview: clipboardPreview(clipped.text),
      source,
      ...(truncated ? { truncated: true, originalChars: totalChars } : {}),
    }),
    pasted: {
      chars: pastedChars,
      mode: request.mode,
      ...(request.label === undefined ? {} : { label: request.label }),
      via: request.target === 'system' ? 'system' : 'virtual',
      submitted: typed?.typed?.submitted === true,
      ...(truncated ? { truncated: true, totalChars } : {}),
    },
    totalMs: Math.round(performance.now() - started),
  }
}

/**
 * Dispatch one validated clipboard call.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function clipboardOp(settings, args) {
  const request = parseClipboardArgs(args)
  switch (request.action) {
    case 'copy': return clipboardCopy(request)
    case 'read': return clipboardRead(request)
    case 'write': return clipboardWrite(request)
    case 'paste': return clipboardPaste(settings, request)
    case 'clear': return clipboardClear()
    default: throw new BrowserError('BAD_CLIPBOARD_ACTION', `Unsupported clipboard action: ${String(request.action)}`)
  }
}

const DOCS_DEADLINE_MS = 55_000
const DOCS_FORMAT_DEADLINE_MS = 120_000
const DOCS_PARAGRAPH_STYLES = ['Normal text', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']
const DOCS_FORMAT_ATTRIBUTES = ['paragraph_style', 'font_size', 'bold', 'italic', 'underline', 'font']
const docsTabLocks = new Map()

/** @param {unknown} value */
export function parseDocsMatchCounter(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  const matches = [...text.matchAll(/(?:^|\D)(\d+)\s+of\s+(\d+)(?!\d)/giu)]
  if (matches.length !== 1) return undefined
  const current = Number(matches[0][1])
  const total = Number(matches[0][2])
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total)) return undefined
  return { current, total, text: `${current} of ${total}` }
}

/** Strip only the accessible-name suffix used to advertise a submenu. */
export function docsFontName(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().replace(/\s+(?:▸|›|»|▶|►)$/u, '')
}

/** @param {unknown} value */
export function docsToolbarFont(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  const match = /^Font list\.\s+(.+?)\s+selected\.$/u.exec(text)
  if (match) return docsFontName(match[1])
  return text && !text.startsWith('Font list.') ? docsFontName(text) : undefined
}

function docsFailure(stage, code, message) {
  const error = new BrowserError(code.startsWith('DOCS_') ? code : `DOCS_${code}`, `[${stage}] ${message}`)
  error.stage = stage
  return error
}

function docsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'docs.google.com' && /^\/document(?:\/|$)/u.test(url.pathname)
  } catch {
    return false
  }
}

export function docsSameDocumentUrl(before, after) {
  try {
    const left = new URL(before)
    const right = new URL(after)
    return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search && docsUrl(right.href)
  } catch {
    return false
  }
}

/**
 * Self-contained Docs probes. All targets are resolved by role and accessible
 * name; coordinates exist only long enough for the next trusted click.
 */
export function docsPageProbe(command, args = {}) {
  const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim()
  const fontName = value => normalize(value).replace(/\s+(?:▸|›|»|▶|►)$/u, '')
  const visible = element => {
    if (!(element instanceof Element) || !element.isConnected) return false
    if (element.closest('[aria-hidden="true"],[inert]')) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const hitVisible = element => {
    if (!(element instanceof Element) || !element.isConnected || element.closest('[aria-hidden="true"],[inert]')) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false
    const hit = document.elementFromPoint(x, y)
    return hit === element || element.contains(hit)
  }
  const role = element => {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit
    if (element.matches('input,textarea')) return 'textbox'
    if (element.matches('button')) return 'button'
    return ''
  }
  const name = element => {
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) return normalize(labelledBy.split(/\s+/u).map(id => document.getElementById(id)?.textContent ?? '').join(' '))
    return normalize(element.getAttribute('aria-label') || element.innerText || element.textContent || element.getAttribute('title'))
  }
  const nodes = (wanted, root = document, includeHidden = false) => {
    const selector = wanted === 'textbox'
      ? '[role="textbox"],input,textarea'
      : wanted === 'button' ? '[role="button"],button' : `[role="${wanted}"]`
    return [...root.querySelectorAll(selector)].filter(element => role(element) === wanted && (includeHidden || visible(element)))
  }
  const exact = (wanted, wantedName, root = document, includeHidden = false) => nodes(wanted, root, includeHidden).filter(element => name(element) === wantedName)
  const disabled = element => element.disabled === true || element.getAttribute('aria-disabled') === 'true' || element.matches(':disabled')
  const selected = element => element.getAttribute('aria-checked') === 'true'
    || element.getAttribute('aria-selected') === 'true'
    || Boolean(element.querySelector('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]'))
  const point = element => {
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }
  const failure = (code, message) => ({ ok: false, code, message })
  const one = (elements, description) => {
    if (elements.length !== 1) return { error: failure(elements.length > 1 ? 'AMBIGUOUS_CONTROL' : 'CONTROL_NOT_FOUND', `${description}: expected one exact control, found ${elements.length}`) }
    return { element: elements[0] }
  }
  const findBoxes = () => exact('textbox', 'Find in document')
  const counterText = box => {
    let container = box.parentElement
    for (let depth = 0; container && depth < 8; depth += 1, container = container.parentElement) {
      const text = normalize(container.textContent)
      if (/\d+\s+of\s+\d+/iu.test(text)) return text
    }
    return ''
  }
  const readFind = () => {
    const boxes = findBoxes()
    if (boxes.length === 0) return { ok: true, open: false }
    if (boxes.length !== 1) return failure('AMBIGUOUS_FIND', `Expected one Find in document textbox, found ${boxes.length}`)
    const box = boxes[0]
    const raw = counterText(box)
    const matches = [...raw.matchAll(/(?:^|\D)(\d+)\s+of\s+(\d+)(?!\d)/giu)]
    const match = matches.length === 1 ? matches[0] : undefined
    return {
      ok: true,
      open: true,
      enabled: !disabled(box),
      value: String(box.value ?? ''),
      counterText: raw,
      match: match ? { current: Number(match[1]), total: Number(match[2]), text: `${Number(match[1])} of ${Number(match[2])}` } : undefined,
    }
  }
  const replaceControls = () => {
    const replacements = exact('textbox', 'Replace with', document, true)
    if (replacements.length !== 1) return { error: failure('AMBIGUOUS_REPLACE', `Expected one Replace with textbox, found ${replacements.length}`) }
    const replacement = replacements[0]
    let container = replacement.parentElement
    for (let depth = 0; container && depth < 10; depth += 1, container = container.parentElement) {
      const replace = exact('button', 'Replace', container, true)
      const replaceAll = exact('button', 'Replace all', container, true)
      const close = exact('button', 'Close', container, true)
      if (replace.length === 1 && replaceAll.length === 1 && close.length === 1) {
        return { replacement, replace: replace[0], close: close[0] }
      }
    }
    return { error: failure('REPLACE_CONTROLS', 'The scoped Replace, Replace all, and Close controls are missing or ambiguous') }
  }
  const readReplace = () => {
    const finds = exact('textbox', 'Find', document, true)
    const replacements = exact('textbox', 'Replace with', document, true)
    if (finds.length === 0 && replacements.length === 0) return { ok: true, open: false }
    if (finds.length !== 1 || replacements.length !== 1) {
      return failure('AMBIGUOUS_REPLACE', `Expected one Find and one Replace with textbox, found ${finds.length} and ${replacements.length}`)
    }
    const find = finds[0]
    const controls = replaceControls()
    if (controls.error) return controls.error
    const { replacement, replace, close } = controls
    const raw = counterText(find)
    const matches = [...raw.matchAll(/(?:^|\D)(\d+)\s+of\s+(\d+)(?!\d)/giu)]
    const match = matches.length === 1 ? matches[0] : undefined
    return {
      ok: true,
      open: finds.some(hitVisible) || replacements.some(hitVisible),
      findEnabled: !disabled(find),
      replacementEnabled: !disabled(replacement),
      findValue: String(find.value ?? ''),
      replacementValue: String(replacement.value ?? ''),
      counterText: raw,
      match: match ? { current: Number(match[1]), total: Number(match[2]), text: `${Number(match[1])} of ${Number(match[2])}` } : undefined,
      replace: disabled(replace) ? undefined : point(replace),
      close: disabled(close) ? undefined : point(close),
    }
  }
  const menuControl = wantedName => {
    const controls = exact('menuitem', wantedName)
    if (controls.length === 0) return { ok: true, present: false }
    if (controls.length !== 1) return failure('AMBIGUOUS_CONTROL', `Expected one ${wantedName} menu item, found ${controls.length}`)
    return { ok: true, present: true, point: point(controls[0]), disabled: disabled(controls[0]) }
  }
  const renameState = () => {
    const renames = exact('textbox', 'Rename')
    if (renames.length === 0) return { ok: true, present: false }
    if (renames.length !== 1) return failure('RENAME_CONTROLS', `Expected one Rename textbox, found ${renames.length}`)
    const input = renames[0]
    return {
      ok: true,
      present: true,
      enabled: !disabled(input),
      value: String(input.value ?? ''),
      focused: document.activeElement === input,
      point: point(input),
      title: document.title,
    }
  }
  const pageSetupState = () => {
    const papers = exact('combobox', 'Paper size').filter(hitVisible)
    if (papers.length === 0) return { ok: true, open: false }
    if (papers.length !== 1) return failure('AMBIGUOUS_DIALOG', `Expected one Paper size control, found ${papers.length}`)
    const paper = papers[0]
    const margins = {}
    for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
      const boxes = exact('textbox', side).filter(hitVisible)
      if (boxes.length !== 1) return failure('AMBIGUOUS_DIALOG', `Expected one ${side} margin textbox, found ${boxes.length}`)
      const box = boxes[0]
      margins[side] = {
        value: String(box.value ?? '').trim(),
        focused: document.activeElement === box,
        point: disabled(box) ? undefined : point(box),
      }
    }
    const orientation = wanted => {
      const labels = [...document.querySelectorAll('label,[role="radio"]')]
        .filter(element => normalize(element.innerText || element.textContent || element.getAttribute('aria-label')) === wanted)
        .filter(hitVisible)
      if (labels.length !== 1) return { error: failure('AMBIGUOUS_CONTROL', `Expected one ${wanted} orientation control, found ${labels.length}`) }
      const element = labels[0]
      const linked = element.htmlFor ? document.getElementById(element.htmlFor) : undefined
      const input = element.matches('input[type="radio"]') ? element : element.querySelector('input[type="radio"]') ?? linked
      const selected = element.getAttribute('aria-checked') === 'true' || input?.checked === true
      return { ok: true, selected, point: disabled(element) ? undefined : point(element) }
    }
    const portrait = orientation('Portrait')
    if (portrait.error) return portrait.error
    const landscape = orientation('Landscape')
    if (landscape.error) return landscape.error
    const ok = one(exact('button', 'OK').filter(hitVisible), 'Page setup OK')
    if (ok.error) return ok.error
    return {
      ok: true,
      open: true,
      paperSize: normalize(paper.querySelector('input')?.value ?? paper.innerText ?? paper.textContent),
      paperPoint: disabled(paper) ? undefined : point(paper),
      portrait: portrait.selected,
      portraitPoint: portrait.point,
      landscape: landscape.selected,
      landscapePoint: landscape.point,
      margins,
      okPoint: disabled(ok.element) ? undefined : point(ok.element),
    }
  }
  const pagePaperMenu = () => {
    const rows = [...nodes('option'), ...nodes('menuitem')].filter(hitVisible)
      .filter(element => /^Letter(?:\s*\(|\s*$)/u.test(name(element)))
    if (rows.length !== 1) return failure('AMBIGUOUS_CONTROL', `Expected one Letter paper-size row, found ${rows.length}`)
    return { ok: true, point: point(rows[0]) }
  }
  const mainToolbar = () => one([...exact('toolbar', 'Main'), ...exact('toolbar', 'Main toolbar')], 'Main toolbar')
  const fontControl = () => {
    const toolbar = mainToolbar()
    if (toolbar.error) return toolbar
    const options = nodes('option', toolbar.element)
    const controls = [...nodes('button', toolbar.element), ...nodes('combobox', toolbar.element), ...options]
      .filter(element => /^Font list(?:\.\s+.+?\s+selected\.)?$/u.test(name(element)))
    if (controls.length > 0) return one(controls, 'Main toolbar Font list')
    const styles = options.findIndex(element => /^Styles list\./u.test(name(element)))
    return one(styles >= 0 ? options.slice(styles + 1, styles + 2) : [], 'Main toolbar Font list')
  }
  const toolbarState = () => {
    const control = fontControl()
    if (control.error) return control.error
    const controlName = name(control.element)
    const match = /^Font list\.\s+(.+?)\s+selected\.$/u.exec(controlName)
    return { ok: true, controlName, font: match ? fontName(match[1]) : fontName(controlName) }
  }
  const paragraphStyles = ['Normal text', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']
  const paragraphStyleControl = () => {
    const toolbar = mainToolbar()
    if (toolbar.error) return toolbar
    const controls = nodes('option', toolbar.element).filter(element => {
      const controlName = name(element)
      return /^Styles list\./u.test(controlName) || paragraphStyles.includes(fontName(controlName))
    })
    return one(controls, 'Main toolbar Styles list')
  }
  const paragraphStyleState = () => {
    const control = paragraphStyleControl()
    if (control.error) return control.error
    const controlName = name(control.element)
    const match = /^Styles list\.\s+(.+?)\s+selected\.$/u.exec(controlName)
    const plainName = fontName(controlName)
    return {
      ok: true,
      paragraphStyle: match ? fontName(match[1]) : paragraphStyles.includes(plainName) ? plainName : undefined,
      paragraphStylePoint: disabled(control.element) ? undefined : point(control.element),
    }
  }
  const paragraphStyleMenu = wanted => {
    const rows = nodes('menuitemradio').filter(element => fontName(name(element)) === wanted)
    if (rows.length > 1) return failure('AMBIGUOUS_CONTROL', `Expected one ${wanted} paragraph-style row, found ${rows.length}`)
    const row = rows[0]
    if (row && disabled(row)) return failure('CONTROL_DISABLED', `${wanted} paragraph style is disabled`)
    return { ok: true, open: Boolean(row), point: row ? point(row) : undefined }
  }
  const fontSizeState = () => {
    const toolbar = mainToolbar()
    if (toolbar.error) return toolbar
    const control = one(exact('textbox', 'Font size', toolbar.element), 'Main toolbar Font size')
    if (control.error) return control.error
    const options = nodes('option', toolbar.element).filter(element => /^Font size list\./u.test(name(element)))
    if (options.length > 1) return failure('AMBIGUOUS_CONTROL', `Expected at most one Font size list option, found ${options.length}`)
    const match = options.length === 1 ? /^Font size list\.\s+(\d+(?:\.\d+)?)\s+selected\.$/u.exec(name(options[0])) : undefined
    const value = String(control.element.value ?? '').trim()
    return {
      ok: true,
      fontSize: match ? Number(match[1]) : /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : undefined,
      fontSizeValue: value,
      fontSizeFocused: document.activeElement === control.element,
      fontSizePoint: disabled(control.element) ? undefined : point(control.element),
    }
  }
  const toggleState = attribute => {
    const toolbar = mainToolbar()
    if (toolbar.error) return toolbar
    const names = {
      bold: ['Bold', 'Bold (Ctrl+B)'],
      italic: ['Italic', 'Italic (Ctrl+I)'],
      underline: ['Underline', 'Underline (Ctrl+U)'],
      numbered: ['Numbered list', 'Numbered list (Ctrl+Shift+7)'],
      bulleted: ['Bulleted list', 'Bulleted list (Ctrl+Shift+8)'],
      checklist: ['Checklist', 'Checklist (Ctrl+Shift+9)'],
    }
    const localControls = nodes('button', toolbar.element, true).filter(element => names[attribute].includes(name(element)))
    const controls = localControls.length === 0 && ['numbered', 'bulleted', 'checklist'].includes(attribute)
      ? nodes('button', document).filter(hitVisible).filter(element => names[attribute].includes(name(element)))
      : localControls
    if (controls.length === 0 && ['numbered', 'bulleted', 'checklist'].includes(attribute)) {
      const more = one(exact('button', 'More', toolbar.element).filter(hitVisible), 'Main toolbar More')
      if (!more.error && !disabled(more.element)) return { ok: true, pressed: undefined, revealPoint: point(more.element) }
    }
    const control = one(controls, `Main toolbar ${attribute}`)
    if (control.error) return control.error
    if (disabled(control.element)) return failure('CONTROL_DISABLED', `${attribute} is disabled`)
    const pressed = control.element.getAttribute('aria-pressed')
    if (pressed !== 'true' && pressed !== 'false') return failure('FORMAT_STATE_UNKNOWN', `${attribute} does not expose an exact aria-pressed state`)
    return { ok: true, pressed: pressed === 'true' }
  }
  const formatState = attributes => {
    if (!Array.isArray(attributes) || attributes.length === 0 || new Set(attributes).size !== attributes.length) {
      return failure('BAD_PROBE', 'format requires a non-empty list of distinct attributes')
    }
    const result = { ok: true }
    for (const attribute of attributes) {
      if (attribute === 'font') {
        const state = toolbarState()
        if (!state.ok) return state
        result.font = state.font
      } else if (attribute === 'paragraph_style') {
        const state = paragraphStyleState()
        if (!state.ok) return state
        Object.assign(result, state)
      } else if (attribute === 'font_size') {
        const state = fontSizeState()
        if (!state.ok) return state
        Object.assign(result, state)
      } else if (['bold', 'italic', 'underline', 'numbered', 'bulleted', 'checklist'].includes(attribute)) {
        const state = toggleState(attribute)
        if (!state.ok) return state
        result[attribute] = state.pressed
        if (state.revealPoint) result.revealPoint = state.revealPoint
      } else {
        return failure('BAD_PROBE', `Unknown format attribute ${String(attribute)}`)
      }
    }
    return result
  }
  const menuState = wanted => {
    const matches = nodes('menuitemcheckbox').filter(hitVisible).filter(element => fontName(name(element)) === wanted)
    const menus = new Set(matches.map(element => element.closest('[role="menu"]')))
    if (menus.size > 1 || matches.length > 1 && matches.some(element => element.closest('[role="menu"]') === null)) {
      return failure('DUPLICATE_FONT', `Font menu contains ${matches.length} conflicting exact ${wanted} rows`)
    }
    if (matches.some(disabled)) return failure('FONT_DISABLED', `Font ${wanted} has a disabled exact row`)
    const checked = matches.filter(selected)
    const exactRow = checked[0] ?? matches[0]
    const more = exact('menuitem', 'More fonts').filter(hitVisible)
    if (more.length > 1) return failure('AMBIGUOUS_CONTROL', 'More fonts is ambiguous')
    return {
      ok: true,
      found: Boolean(exactRow),
      checked: checked.length > 0,
      point: exactRow ? point(exactRow) : undefined,
      moreFonts: more.length === 1 && !disabled(more[0]) ? point(more[0]) : undefined,
    }
  }
  const dialogParts = () => {
    const searches = exact('textbox', 'Search')
    const lists = exact('listbox', 'List of fonts')
    if (searches.length > 1 || lists.length > 1) return { error: failure('AMBIGUOUS_DIALOG', 'The Fonts dialog controls are ambiguous') }
    const search = searches[0]
    const list = lists[0]
    const anchor = list || search
    const dialog = anchor?.closest('[role="dialog"]') || (anchor ? anchor.parentElement : undefined)
    return { search, list, dialog: dialog || document }
  }
  const dialogState = wanted => {
    const parts = dialogParts()
    if (parts.error) return parts.error
    if (!parts.search && !parts.list) return { ok: true, open: false }
    const root = parts.dialog
    const noFonts = [...root.querySelectorAll('*')].some(element => visible(element) && normalize(element.innerText) === 'No fonts found.')
    const options = parts.list ? nodes('option', parts.list, true) : []
    const visibleOptions = options.filter(visible)
    const matches = options.filter(element => fontName(element.innerText) === wanted)
    if (matches.length > 1) return failure('DUPLICATE_FONT', `Fonts list contains ${matches.length} exact ${wanted} rows`)
    const row = matches[0]
    if (row && !visible(row)) return failure('FONT_HIDDEN', `Font ${wanted} has a hidden exact row`)
    if (row && disabled(row)) return failure('FONT_DISABLED', `Font ${wanted} is disabled`)
    const done = one(exact('button', 'Done', root), 'Done')
    const cancel = one(exact('button', 'Cancel', root), 'Cancel')
    if (done.error || cancel.error) return failure('DIALOG_CONTROLS', 'Done or Cancel is missing or ambiguous')
    return {
      ok: true,
      open: true,
      searchEnabled: parts.search ? !disabled(parts.search) : false,
      searchValue: parts.search ? String(parts.search.value ?? '') : undefined,
      noFonts,
      signature: visibleOptions.map(element => `${fontName(element.innerText)}:${selected(element)}`).join('|') + `:empty=${noFonts}`,
      found: Boolean(row),
      checked: row ? selected(row) : false,
      point: row ? point(row) : undefined,
      done: !disabled(done.element) ? point(done.element) : undefined,
      cancel: !disabled(cancel.element) ? point(cancel.element) : undefined,
    }
  }
  const setText = (wantedRole, wantedName, value, includeHidden = false) => {
    const found = one(exact(wantedRole, wantedName, document, includeHidden), wantedName)
    if (found.error) return found.error
    const element = found.element
    if (disabled(element)) return failure('CONTROL_DISABLED', `${wantedName} is disabled`)
    const prototype = element.matches('textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(element, value)
    else element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, value: String(element.value ?? ''), readback: String(element.value ?? '') === value }
  }

  const documentContent = () => {
    const boxes = exact('textbox', 'Document content', document, true)
    if (boxes.length !== 1) return failure('DOC_CONTENT_AMBIGUOUS', `Expected one Document content editor, found ${boxes.length}`)
    return { ok: true, present: true, focused: document.activeElement === boxes[0] }
  }
  const focusDocument = () => {
    const boxes = exact('textbox', 'Document content', document, true)
    if (boxes.length !== 1) return failure('DOC_CONTENT_AMBIGUOUS', `Expected one Document content editor, found ${boxes.length}`)
    boxes[0].focus({ preventScroll: true })
    return { ok: true, focused: document.activeElement === boxes[0] }
  }

  const colorControl = attribute => {
    if (!['color', 'highlight'].includes(attribute)) return failure('BAD_PROBE', `Unknown color attribute ${String(attribute)}`)
    const toolbar = mainToolbar()
    if (toolbar.error) return toolbar
    const wantedName = attribute === 'color' ? 'Text color' : 'Highlight color'
    const control = one(exact('button', wantedName, toolbar.element).filter(hitVisible), `Main toolbar ${wantedName}`)
    return control.error || { ok: true, point: point(control.element) }
  }
  const colorMenuState = attribute => {
    if (!['color', 'highlight'].includes(attribute)) return failure('BAD_PROBE', `Unknown color attribute ${String(attribute)}`)
    const custom = exact('button', 'Add a custom color').filter(hitVisible)
    const none = attribute === 'highlight' ? exact('button', 'None').filter(hitVisible) : []
    if (custom.length > 1 || none.length > 1) return failure('AMBIGUOUS_CONTROL', `${attribute} menu controls are ambiguous`)
    return {
      ok: true,
      open: custom.length > 0 || none.length > 0,
      customPoint: custom.length === 1 ? point(custom[0]) : undefined,
      nonePoint: none.length === 1 ? point(none[0]) : undefined,
    }
  }
  const colorDialogState = () => {
    const boxes = exact('textbox', 'Hex color', document, true).filter(hitVisible)
    if (boxes.length === 0) return { ok: true, open: false }
    if (boxes.length !== 1) return failure('AMBIGUOUS_DIALOG', 'Expected one visible Hex color textbox')
    const box = boxes[0]
    return {
      ok: true,
      open: true,
      enabled: !disabled(box),
      focused: document.activeElement === box,
      value: String(box.value ?? ''),
      point: disabled(box) ? undefined : point(box),
    }
  }

  switch (command) {
    case 'find': return readFind()
    case 'setFind': return setText('textbox', 'Find in document', args.value)
    case 'replace': return readReplace()
    case 'rename': return renameState()
    case 'fileMenu': return menuControl('File')
    case 'pageSetupMenuItem': return menuControl('Page setup')
    case 'pageSetup': return pageSetupState()
    case 'pagePaperMenu': return pagePaperMenu()
    case 'setPageMargin': {
      if (!['Top', 'Bottom', 'Left', 'Right'].includes(args.side)) return failure('BAD_PROBE', 'Unknown page margin')
      return setText('textbox', args.side, args.value)
    }
    case 'editMenu': return menuControl('Edit')
    case 'replaceMenuItem': return menuControl('Find and replace')
    case 'setReplaceFind': return setText('textbox', 'Find', args.value, true)
    case 'setReplaceWith': return setText('textbox', 'Replace with', args.value, true)
    case 'toolbar': return toolbarState()
    case 'fontControl': {
      const control = fontControl()
      return control.error || { ok: true, point: point(control.element), disabled: disabled(control.element) }
    }
    case 'fontMenu': return menuState(args.font)
    case 'fontDialog': return dialogState(args.font)
    case 'colorControl': return colorControl(args.attribute)
    case 'colorMenu': return colorMenuState(args.attribute)
    case 'colorDialog': return colorDialogState()
    case 'documentContent': return documentContent()
    case 'focusDocument': return focusDocument()
    case 'setSearch': return setText('textbox', 'Search', args.value)
    case 'format': return formatState(args.attributes)
    case 'formatStyleMenu': return paragraphStyleMenu(args.style)
    default: return failure('BAD_PROBE', `Unknown Docs probe ${command}`)
  }
}

function docsDriver(io) {
  const source = io.driver ?? io
  return {
    getWindowId: source.getWindowId ?? getWindowId,
    getActiveTab: source.getActiveTab ?? getActiveTab,
    getTab: source.getTab ?? (tabId => chrome.tabs.get(tabId)),
    fetchExport: source.fetchExport ?? docsFetchExport,
    runInTab: source.runInTab ?? runInTab,
    withDebugger: source.withDebugger ?? withDebugger,
    dispatchTrustedKey: source.dispatchTrustedKey ?? dispatchTrustedKey,
    insertTrustedText: source.insertTrustedText ?? ((tabId, text) => chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text })),
    trustedClick: source.trustedClick ?? docsTrustedClick,
    snapshot: source.snapshot ?? (settings => snapshot('normal', settings)),
    sleep: source.sleep ?? sleep,
    now: source.now ?? (() => Date.now()),
  }
}

function docsCheckDeadline(context, stage) {
  if (context.driver.now() >= context.deadline) throw docsFailure(stage, 'DOCS_DEADLINE', `The Docs operation exceeded ${(context.deadlineMs ?? DOCS_DEADLINE_MS) / 1000}s`)
}

function docsDriverError(stage, code, error) {
  if (error instanceof BrowserError && error.code.startsWith('DOCS_')) return error
  return docsFailure(stage, code, error instanceof Error ? error.message : String(error))
}

async function docsCurrent(context, stage) {
  docsCheckDeadline(context, stage)
  let current
  try {
    current = await context.driver.getTab(context.tab.id)
  } catch (error) {
    throw docsDriverError(stage, 'DOCS_TAB_CHECK_FAILED', error)
  }
  if (!current || current.id !== context.tab.id || !docsSameDocumentUrl(context.initialUrl, current.url)) {
    throw docsFailure(stage, 'DOCS_STALE_TAB', 'The tab or document URL changed; no further mutation was attempted')
  }
  docsCheckDeadline(context, stage)
  return current
}

async function docsProbe(context, stage, command, args = {}) {
  docsCheckDeadline(context, stage)
  let result
  try {
    result = await context.driver.runInTab(context.tab.id, docsPageProbe, [command, args], 4_000)
  } catch (error) {
    throw docsDriverError(stage, 'DOCS_PROBE_FAILED', error)
  }
  if (!result?.ok) throw docsFailure(stage, result?.code ?? 'DOCS_PROBE_FAILED', result?.message ?? 'The Docs page probe returned no result')
  docsCheckDeadline(context, stage)
  return result
}

async function docsExport(context, stage, format) {
  await docsCurrent(context, stage)
  try {
    const result = await context.driver.fetchExport(context.initialUrl, format)
    await docsCurrent(context, stage)
    return typeof result === 'string' ? result : result.body
  } catch (error) {
    throw docsDriverError(stage, error?.code ?? 'DOCS_EXPORT_FAILED', error)
  }
}

async function docsKey(context, stage, spec, mask = 0) {
  await docsCurrent(context, stage)
  try {
    await context.driver.withDebugger(context.tab.id, () => context.driver.dispatchTrustedKey(context.tab.id, spec, mask))
  } catch (error) {
    throw docsDriverError(stage, 'DOCS_INPUT_FAILED', error)
  }
  docsCheckDeadline(context, stage)
}

async function docsInsertText(context, stage, text) {
  await docsCurrent(context, stage)
  try {
    await context.driver.withDebugger(context.tab.id, () => context.driver.insertTrustedText(context.tab.id, text))
  } catch (error) {
    throw docsDriverError(stage, 'DOCS_INPUT_FAILED', error)
  }
  docsCheckDeadline(context, stage)
}

async function docsNativeText(context, stage, command, value) {
  await docsCurrent(context, stage)
  const result = await docsProbe(context, stage, command, { value })
  if (!result.readback) throw docsFailure(stage, 'DOCS_QUERY_MISMATCH', `The ${command} field did not retain the exact value`)
  docsCheckDeadline(context, stage)
}

async function docsClick(context, stage, target) {
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw docsFailure(stage, 'DOCS_CONTROL_UNAVAILABLE', 'The exact Docs control is missing or disabled')
  }
  await docsCurrent(context, stage)
  try {
    await context.driver.withDebugger(context.tab.id, () => context.driver.trustedClick(context.tab.id, target.x, target.y))
  } catch (error) {
    throw docsDriverError(stage, 'DOCS_INPUT_FAILED', error)
  }
  docsCheckDeadline(context, stage)
}

async function docsWait(context, stage, command, args, predicate, timeoutMs = 3_000) {
  const end = Math.min(context.deadline, context.driver.now() + timeoutMs)
  let latest
  while (context.driver.now() < end) {
    latest = await docsProbe(context, stage, command, args)
    if (predicate(latest)) return latest
    await context.driver.sleep(60)
  }
  const observed = latest ? ` (open=${latest.open}, match=${latest.match?.text ?? 'unknown'})` : ''
  throw docsFailure(stage, 'DOCS_WAIT_TIMEOUT', `Docs did not reach the required ${stage} state${observed}`)
}

async function docsCloseFind(context, stage) {
  await docsKey(context, stage, KEY_SPECS.Escape)
  await docsWait(context, stage, 'find', {}, state => !state.open)
}

async function docsOpenFind(context, text) {
  await docsKey(context, 'open-find', { key: 'f', code: 'KeyF', keyCode: 70 }, MODIFIER_BITS.ctrl)
  await docsWait(context, 'open-find', 'find', {}, state => state.open && state.enabled)
  await docsNativeText(context, 'find-query', 'setFind', text)
  return docsWait(context, 'find-query', 'find', {}, state => state.value === text && state.match !== undefined)
}

async function docsVerifyFont(context, font, fontAdded) {
  const end = Math.min(context.deadline, context.driver.now() + 4_000)
  let toolbar
  while (context.driver.now() < end) {
    toolbar = await docsProbe(context, 'verify-toolbar', 'toolbar')
    if (toolbar.font === font) {
      return { status: 'applied', matchCount: 1, fontAdded, verifiedBy: 'toolbar' }
    }
    const menu = await docsProbe(context, 'verify-toolbar', 'fontMenu', { font })
    if (menu.found && menu.checked) {
      return { status: 'applied', matchCount: 1, fontAdded, verifiedBy: 'current-font-option' }
    }
    await context.driver.sleep(80)
  }
  throw docsFailure('verify-toolbar', 'DOCS_TOOLBAR_MISMATCH', `Main toolbar reports ${JSON.stringify(toolbar?.font ?? toolbar?.controlName ?? 'unknown')} instead of ${JSON.stringify(font)}`)
}

async function docsFinish(context, details) {
  docsCheckDeadline(context, 'final-snapshot')
  let shot
  try {
    shot = await context.driver.snapshot(context.settings, context.tab)
  } catch (error) {
    throw docsDriverError('final-snapshot', 'DOCS_SNAPSHOT_FAILED', error)
  }
  return { ...shot, op: 'docs', docs: { action: context.action ?? 'set_font', ...details } }
}

async function docsRemoveMatchedText(context, text) {
  await docsKey(context, 'remove-text', KEY_SPECS.Delete)
  const found = await docsOpenFind(context, text)
  if (found.match.total !== 0) throw docsFailure('verify-removal', 'DOCS_TEXT_STILL_PRESENT', `Expected zero matches after deletion, found ${found.match.text}`)
  await docsCloseFind(context, 'verify-removal')
  return { status: 'removed_text', matchCount: 0, fontAdded: false, verifiedBy: 'find-counter', removedText: true }
}

async function docsMissingFont(context, text, removeIfMissing) {
  const dialog = await docsProbe(context, 'missing-font', 'fontDialog', { font: context.font })
  if (!dialog.noFonts) throw docsFailure('missing-font', 'DOCS_FONT_RESULTS_UNKNOWN', 'The exact font is absent but the scoped no-results message is not visible')
  await docsClick(context, 'missing-font-cancel', dialog.cancel)
  await docsWait(context, 'missing-font-cancel', 'fontDialog', { font: context.font }, state => !state.open)
  if (removeIfMissing) return docsRemoveMatchedText(context, text)
  return { status: 'font_missing', matchCount: 1, fontAdded: false, verifiedBy: 'find-counter' }
}

async function docsAddAndApply(context, text) {
  const font = context.font
  await docsNativeText(context, 'font-search', 'setSearch', font)
  const end = Math.min(context.deadline, context.driver.now() + 8_000)
  let stableSignature
  let stableSince = 0
  while (context.driver.now() < end) {
    const state = await docsProbe(context, 'font-results', 'fontDialog', { font })
    if (state.searchValue !== font) throw docsFailure('font-search', 'DOCS_QUERY_MISMATCH', 'The Fonts search field changed from the exact requested query')
    const now = context.driver.now()
    if (state.signature !== stableSignature) {
      stableSignature = state.signature
      stableSince = now
    } else if (now - stableSince >= 100) {
      if (state.found) {
        if (!state.checked) {
          await docsClick(context, 'font-add', state.point)
          await docsWait(context, 'font-add', 'fontDialog', { font }, next => next.found && next.checked)
        }
        const ready = await docsWait(context, 'font-done', 'fontDialog', { font }, next => next.done)
        await docsClick(context, 'font-done', ready.done)
        await docsWait(context, 'font-done', 'fontDialog', { font }, next => !next.open)
        const control = await docsProbe(context, 'reopen-font-menu', 'fontControl')
        await docsClick(context, 'reopen-font-menu', control.point)
        const menu = await docsWait(context, 'reopen-font-menu', 'fontMenu', { font }, next => next.found)
        await docsClick(context, 'apply-added-font', menu.point)
        return docsVerifyFont(context, font, true)
      }
      if (state.noFonts) return docsMissingFont(context, text, context.removeIfMissing)
    }
    await context.driver.sleep(80)
  }
  throw docsFailure('font-results', 'DOCS_FONT_RESULTS_UNKNOWN', 'Font search results did not stabilize with an exact row or a scoped no-results message')
}

async function docsSelectUnique(context, text) {
  const found = await docsOpenFind(context, text)
  if (found.match.total !== 1 || found.match.current !== 1) {
    throw docsFailure('find-match', 'DOCS_MATCH_NOT_UNIQUE', `Expected normalized 1 of 1, found ${found.match.text}`)
  }
  await docsCloseFind(context, 'close-find')
}

async function docsApplyFont(context, text) {
  const toolbar = await docsProbe(context, 'read-toolbar', 'toolbar')
  if (toolbar.font === context.font) {
    return { status: 'already_applied', matchCount: 1, fontAdded: false, verifiedBy: 'toolbar' }
  }
  const control = await docsProbe(context, 'open-font-menu', 'fontControl')
  await docsClick(context, 'open-font-menu', control.point)
  const menu = await docsWait(context, 'open-font-menu', 'fontMenu', { font: context.font }, next => next.found || next.moreFonts)
  if (menu.found) {
    await docsClick(context, 'apply-font', menu.point)
    return docsVerifyFont(context, context.font, false)
  }
  if (!menu.moreFonts) throw docsFailure('open-font-menu', 'DOCS_FONT_MISSING', `Font ${context.font} is absent and More fonts is unavailable`)
  await docsClick(context, 'more-fonts', menu.moreFonts)
  await docsWait(context, 'more-fonts', 'fontDialog', { font: context.font }, state => state.open && state.searchEnabled)
  return docsAddAndApply(context, text)
}

async function docsSetFontFlow(context, text) {
  await docsSelectUnique(context, text)
  const result = await docsApplyFont(context, text)
  return docsFinish(context, result)
}

async function docsSetFontLocked(settings, args, tab, driver) {
  const context = {
    settings,
    tab,
    driver,
    initialUrl: tab.url,
    font: args.font.trim(),
    removeIfMissing: args.remove_if_missing === true,
    deadline: driver.now() + DOCS_DEADLINE_MS,
  }
  let timer
  try {
    return await Promise.race([
      docsSetFontFlow(context, args.text),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(docsFailure('deadline', 'DOCS_DEADLINE', `The Docs operation exceeded ${DOCS_DEADLINE_MS / 1000}s`)), DOCS_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Apply a font to one uniquely matched Docs selection without model-facing
 * intermediate views. The optional io object is a low-level fake driver seam.
 */
export async function docsSetFont(settings, args, io = {}) {
  if (args?.action !== 'set_font') throw docsFailure('validate', 'BAD_DOCS_ACTION', 'docs action must be set_font')
  if (typeof args.text !== 'string' || args.text.trim().length === 0 || args.text.length > 1000) {
    throw docsFailure('validate', 'BAD_DOCS_TEXT', 'text must be a non-empty string of at most 1000 characters')
  }
  if (typeof args.font !== 'string' || args.font.trim().length === 0 || args.font.length > 100) {
    throw docsFailure('validate', 'BAD_DOCS_FONT', 'font must be a non-empty string of at most 100 characters')
  }
  if (args.remove_if_missing !== undefined && typeof args.remove_if_missing !== 'boolean') {
    throw docsFailure('validate', 'BAD_DOCS_REMOVE', 'remove_if_missing must be a boolean')
  }
  const driver = docsDriver(io)
  let tab
  try {
    const windowId = await driver.getWindowId()
    tab = await driver.getActiveTab(windowId)
  } catch (error) {
    throw docsDriverError('validate-tab', 'DOCS_TAB_CHECK_FAILED', error)
  }
  if (tab?.id === undefined || !docsUrl(tab.url)) {
    throw docsFailure('validate-tab', 'DOCS_URL_UNSUPPORTED', 'The active tab must be an https://docs.google.com/document URL')
  }
  const previous = docsTabLocks.get(tab.id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => docsSetFontLocked(settings, args, tab, driver))
  const gate = run.catch(() => {})
  docsTabLocks.set(tab.id, gate)
  try {
    return await run
  } finally {
    if (docsTabLocks.get(tab.id) === gate) docsTabLocks.delete(tab.id)
  }
}

function docsFormatValue(args, attribute) {
  return attribute === 'font' ? args.font.trim() : args[attribute]
}

function docsFormatObservation(state, attribute) {
  if (attribute === 'paragraph_style') return state.paragraphStyle
  if (attribute === 'font_size') return state.fontSize
  return state[attribute]
}

function docsFormatObservations(state, attributes) {
  return Object.fromEntries(attributes.map(attribute => [attribute, docsFormatObservation(state, attribute)]))
}

function docsFormatResult(attribute, value, status, verifiedBy = 'toolbar') {
  return { attribute, value, status, verifiedBy }
}

async function docsWaitFormat(context, stage, attributes, wanted, timeoutMs = 4_000) {
  const end = Math.min(context.deadline, context.driver.now() + timeoutMs)
  let latest
  while (context.driver.now() < end) {
    latest = await docsProbe(context, stage, 'format', { attributes })
    if (attributes.every(attribute => docsFormatObservation(latest, attribute) === wanted[attribute])) return latest
    if (latest.revealPoint) {
      await docsClick(context, `${stage}-reveal`, latest.revealPoint)
      continue
    }
    await context.driver.sleep(80)
  }
  throw docsFailure(stage, 'DOCS_FORMAT_MISMATCH', `Expected ${JSON.stringify(wanted)}, observed ${JSON.stringify(latest ? docsFormatObservations(latest, attributes) : {})}`)
}

async function docsApplyParagraphStyle(context, value) {
  const control = await docsProbe(context, 'format-style-open', 'format', { attributes: ['paragraph_style'] })
  await docsClick(context, 'format-style-open', control.paragraphStylePoint)
  const menu = await docsWait(context, 'format-style-menu', 'formatStyleMenu', { style: value }, state => state.open && state.point)
  await docsClick(context, 'format-style-apply', menu.point)
  await docsWaitFormat(context, 'format-style-verify', ['paragraph_style'], { paragraph_style: value })
  return docsFormatResult('paragraph_style', value, 'applied')
}

async function docsApplyFontSize(context, value) {
  const control = await docsProbe(context, 'format-size-focus', 'format', { attributes: ['font_size'] })
  await docsClick(context, 'format-size-focus', control.fontSizePoint)
  await docsWait(context, 'format-size-focus', 'format', { attributes: ['font_size'] }, state => state.fontSizeFocused)
  await docsKey(context, 'format-size-select', { key: 'a', code: 'KeyA', keyCode: 65 }, MODIFIER_BITS.ctrl)
  const wanted = String(value)
  await docsInsertText(context, 'format-size-input', wanted)
  await docsWait(context, 'format-size-input', 'format', { attributes: ['font_size'] }, state => state.fontSizeFocused && state.fontSizeValue === wanted)
  await docsKey(context, 'format-size-commit', KEY_SPECS.Enter)
  await docsWaitFormat(context, 'format-size-verify', ['font_size'], { font_size: value })
  return docsFormatResult('font_size', value, 'applied')
}

async function docsApplyToggle(context, attribute, value) {
  const specs = {
    bold: { key: 'b', code: 'KeyB', keyCode: 66 },
    italic: { key: 'i', code: 'KeyI', keyCode: 73 },
    underline: { key: 'u', code: 'KeyU', keyCode: 85 },
  }
  await docsKey(context, `format-${attribute}`, specs[attribute], MODIFIER_BITS.ctrl)
  await docsWaitFormat(context, `format-${attribute}-verify`, [attribute], { [attribute]: value })
  return docsFormatResult(attribute, value, 'applied', 'toolbar-pressed')
}

function docsFormatError(error, attribute, results) {
  if (error instanceof Error) {
    const verified = results.map(result => `${result.attribute}=${JSON.stringify(result.value)} (${result.status})`).join(', ') || 'none'
    error.message += `; formatting stopped at ${attribute}; attributes verified before the failure: ${verified}; ${attribute} is unverified; do not retry the whole format blindly`
  }
  return error
}

async function docsApplyFormatStates(context, wanted, text) {
  const attributes = DOCS_FORMAT_ATTRIBUTES.filter(attribute => wanted[attribute] !== undefined)
  const initial = await docsProbe(context, 'read-format', 'format', { attributes })
  const results = []
  let fontAdded = false
  for (const [index, attribute] of attributes.entries()) {
    const value = wanted[attribute]
    try {
      const current = index === 0 ? initial : await docsProbe(context, 'read-format', 'format', { attributes: [attribute] })
      if (docsFormatObservation(current, attribute) === value) {
        results.push(docsFormatResult(attribute, value, 'already_applied'))
        continue
      }
      if (attribute === 'paragraph_style') results.push(await docsApplyParagraphStyle(context, value))
      else if (attribute === 'font_size') results.push(await docsApplyFontSize(context, value))
      else if (attribute === 'font') {
        context.font = value
        const applied = await docsApplyFont(context, text)
        fontAdded = applied.fontAdded
        if (applied.status === 'font_missing') {
          results.push(docsFormatResult('font', value, 'font_missing', 'font-dialog'))
          return { results, fontAdded, fontMissing: true }
        }
        results.push(docsFormatResult('font', value, applied.status, applied.verifiedBy))
      } else results.push(await docsApplyToggle(context, attribute, value))
    } catch (error) {
      throw docsFormatError(error, attribute, results)
    }
  }
  try {
    await docsWaitFormat(context, 'format-final-verify', attributes, wanted)
  } catch (error) {
    throw docsFormatError(error, 'final verification', results)
  }
  return { results, fontAdded, fontMissing: false }
}

async function docsFormatFlow(context, args) {
  const attributes = DOCS_FORMAT_ATTRIBUTES.filter(attribute => args[attribute] !== undefined)
  const wanted = Object.fromEntries(attributes.map(attribute => [attribute, docsFormatValue(args, attribute)]))
  await docsSelectUnique(context, args.text)
  const { results, fontAdded, fontMissing } = await docsApplyFormatStates(context, wanted, args.text)
  const appliedCount = results.filter(result => result.status === 'applied').length
  const alreadyAppliedCount = results.filter(result => result.status === 'already_applied').length
  if (fontMissing) {
    return docsFinish(context, {
      status: appliedCount > 0 ? 'partial' : 'font_missing',
      matchCount: 1,
      attributeCount: attributes.length,
      appliedCount,
      alreadyAppliedCount,
      fontAdded,
      verifiedBy: 'toolbar',
      results,
      failure: { attribute: 'font', code: 'DOCS_FONT_MISSING', message: `Font ${JSON.stringify(wanted.font)} is unavailable; no text was deleted` },
    })
  }
  return docsFinish(context, {
    status: appliedCount > 0 ? 'completed' : 'already_applied',
    matchCount: 1,
    attributeCount: attributes.length,
    appliedCount,
    alreadyAppliedCount,
    fontAdded,
    verifiedBy: 'toolbar',
    results,
  })
}

async function docsFormatLocked(settings, args, tab, driver) {
  const context = {
    settings,
    tab,
    driver,
    action: 'format',
    initialUrl: tab.url,
    font: typeof args.font === 'string' ? args.font.trim() : undefined,
    removeIfMissing: false,
    deadline: driver.now() + DOCS_FORMAT_DEADLINE_MS,
    deadlineMs: DOCS_FORMAT_DEADLINE_MS,
  }
  let timer
  try {
    return await Promise.race([
      docsFormatFlow(context, args),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(docsFailure('deadline', 'DOCS_DEADLINE', `The Docs format operation exceeded ${DOCS_FORMAT_DEADLINE_MS / 1000}s`)), DOCS_FORMAT_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function docsFormat(settings, args, io = {}) {
  if (args?.action !== 'format') throw docsFailure('validate', 'BAD_DOCS_ACTION', 'docs action must be format')
  if (typeof args.text !== 'string' || args.text.trim().length === 0 || args.text.length > 1000) {
    throw docsFailure('validate', 'BAD_DOCS_TEXT', 'text must be a non-empty string of at most 1000 characters')
  }
  const allowed = new Set(['action', 'text', ...DOCS_FORMAT_ATTRIBUTES])
  if (Object.keys(args).some(key => !allowed.has(key))) throw docsFailure('validate', 'BAD_DOCS_FORMAT', 'unknown Docs format argument')
  const attributes = DOCS_FORMAT_ATTRIBUTES.filter(attribute => args[attribute] !== undefined)
  if (attributes.length === 0) throw docsFailure('validate', 'BAD_DOCS_FORMAT', 'provide at least one Docs format attribute')
  if (args.font !== undefined && (typeof args.font !== 'string' || args.font.trim().length === 0 || args.font.length > 100)) {
    throw docsFailure('validate', 'BAD_DOCS_FONT', 'font must be a non-empty string of at most 100 characters')
  }
  if (args.font_size !== undefined && (!Number.isInteger(args.font_size) || args.font_size < 1 || args.font_size > 400)) {
    throw docsFailure('validate', 'BAD_DOCS_FONT_SIZE', 'font_size must be an integer from 1 to 400')
  }
  if (args.paragraph_style !== undefined && !DOCS_PARAGRAPH_STYLES.includes(args.paragraph_style)) {
    throw docsFailure('validate', 'BAD_DOCS_PARAGRAPH_STYLE', `paragraph_style must be one of: ${DOCS_PARAGRAPH_STYLES.join(', ')}`)
  }
  for (const attribute of ['bold', 'italic', 'underline']) {
    if (args[attribute] !== undefined && typeof args[attribute] !== 'boolean') throw docsFailure('validate', 'BAD_DOCS_FORMAT', `${attribute} must be a boolean`)
  }
  const driver = docsDriver(io)
  let tab
  try {
    const windowId = await driver.getWindowId()
    tab = await driver.getActiveTab(windowId)
  } catch (error) {
    throw docsDriverError('validate-tab', 'DOCS_TAB_CHECK_FAILED', error)
  }
  if (tab?.id === undefined || !docsUrl(tab.url)) {
    throw docsFailure('validate-tab', 'DOCS_URL_UNSUPPORTED', 'The active tab must be an https://docs.google.com/document URL')
  }
  const previous = docsTabLocks.get(tab.id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => docsFormatLocked(settings, args, tab, driver))
  const gate = run.catch(() => {})
  docsTabLocks.set(tab.id, gate)
  try {
    return await run
  } finally {
    if (docsTabLocks.get(tab.id) === gate) docsTabLocks.delete(tab.id)
  }
}

const DOCS_READ_DEADLINE_MS = 45_000

async function docsReadFlow(context, args) {
  const format = args.format ?? 'outline'
  const maxChars = args.max_chars ?? 16_000
  const exported = await docsExport(context, 'read-export', format === 'text' ? 'txt' : 'html')
  const full = format === 'outline' ? formatOutline(parseDocStructure(exported)) : exported
  const truncated = full.length > maxChars
  const content = truncated ? `${full.slice(0, maxChars)}\n… [truncated ${full.length - maxChars} characters]` : full
  return {
    op: 'docs',
    docs: {
      action: 'read',
      status: 'completed',
      format,
      chars: full.length,
      returned: content.length,
      truncated,
      content,
      verifiedBy: 'export',
    },
  }
}

async function docsReadLocked(settings, args, tab, driver) {
  const context = {
    settings,
    tab,
    driver,
    action: 'read',
    initialUrl: tab.url,
    deadline: driver.now() + DOCS_READ_DEADLINE_MS,
    deadlineMs: DOCS_READ_DEADLINE_MS,
  }
  let timer
  try {
    return await Promise.race([
      docsReadFlow(context, args),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(docsFailure('deadline', 'DOCS_DEADLINE', `The Docs read operation exceeded ${DOCS_READ_DEADLINE_MS / 1000}s`)), DOCS_READ_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function docsRead(settings, args, io = {}) {
  if (args?.action !== 'read') throw docsFailure('validate', 'BAD_DOCS_ACTION', 'docs action must be read')
  if (!['outline', 'text', 'html'].includes(args.format ?? 'outline')) throw docsFailure('validate', 'BAD_DOCS_READ_FORMAT', 'format must be outline, text, or html')
  if (args.max_chars !== undefined && (!Number.isInteger(args.max_chars) || args.max_chars < 100 || args.max_chars > 100_000)) {
    throw docsFailure('validate', 'BAD_DOCS_READ_CHARS', 'max_chars must be an integer from 100 to 100000')
  }
  const driver = docsDriver(io)
  let tab
  try {
    const windowId = await driver.getWindowId()
    tab = await driver.getActiveTab(windowId)
  } catch (error) {
    throw docsDriverError('validate-tab', 'DOCS_TAB_CHECK_FAILED', error)
  }
  if (tab?.id === undefined || !docsUrl(tab.url)) {
    throw docsFailure('validate-tab', 'DOCS_URL_UNSUPPORTED', 'The active tab must be an https://docs.google.com/document URL')
  }
  const previous = docsTabLocks.get(tab.id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => docsReadLocked(settings, args, tab, driver))
  const gate = run.catch(() => {})
  docsTabLocks.set(tab.id, gate)
  try {
    return await run
  } finally {
    if (docsTabLocks.get(tab.id) === gate) docsTabLocks.delete(tab.id)
  }
}

const DOCS_WRITE_DEADLINE_MS = 300_000
const DOCS_WRITE_MAX_BLOCKS = 50
const DOCS_WRITE_MAX_CHARS = 20_000
const DOCS_WRITE_FORMAT_FIELDS = ['paragraph_style', 'font_size', 'font', 'bold', 'italic', 'underline', 'color', 'highlight']
const DOCS_WRITE_INLINE_FIELDS = ['font_size', 'font', 'bold', 'italic', 'underline', 'color', 'highlight']

function docsWriteValidateColor(value, allowNone, path) {
  if (!(allowNone && value === 'none') && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value))) {
    throw docsFailure('validate', 'BAD_DOCS_COLOR', `${path} must be ${allowNone ? '"none" or ' : ''}a six-digit hex color`)
  }
}

function docsWriteValidateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > DOCS_WRITE_MAX_BLOCKS) {
    throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks must be an array of 1 to ${DOCS_WRITE_MAX_BLOCKS} blocks`)
  }
  const validateFormat = (entry, path, allowParagraph = true) => {
    if (entry.font !== undefined && (typeof entry.font !== 'string' || entry.font.trim().length === 0 || entry.font.length > 100)) {
      throw docsFailure('validate', 'BAD_DOCS_FONT', `${path}.font must be a non-empty string of at most 100 characters`)
    }
    if (entry.font_size !== undefined && (!Number.isInteger(entry.font_size) || entry.font_size < 1 || entry.font_size > 400)) {
      throw docsFailure('validate', 'BAD_DOCS_FONT_SIZE', `${path}.font_size must be an integer from 1 to 400`)
    }
    for (const attribute of ['bold', 'italic', 'underline']) {
      if (entry[attribute] !== undefined && typeof entry[attribute] !== 'boolean') throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `${path}.${attribute} must be a boolean`)
    }
    if (allowParagraph && entry.paragraph_style !== undefined && !DOCS_PARAGRAPH_STYLES.includes(entry.paragraph_style)) {
      throw docsFailure('validate', 'BAD_DOCS_PARAGRAPH_STYLE', `${path}.paragraph_style is unsupported`)
    }
    if (entry.color !== undefined) docsWriteValidateColor(entry.color, false, `${path}.color`)
    if (entry.highlight !== undefined) docsWriteValidateColor(entry.highlight, true, `${path}.highlight`)
  }
  const normalize = entry => ({
    ...entry,
    ...entry.font ? { font: entry.font.trim() } : {},
    ...entry.color ? { color: entry.color.toLowerCase() } : {},
    ...entry.highlight && entry.highlight !== 'none' ? { highlight: entry.highlight.toLowerCase() } : {},
  })
  const normalized = []
  let totalChars = 0
  for (const [index, block] of blocks.entries()) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}] must be an object`)
    const allowed = new Set(['text', 'runs', 'items', 'list', 'blank', 'page_break', ...DOCS_WRITE_FORMAT_FIELDS])
    if (Object.keys(block).some(key => !allowed.has(key))) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}] has an unknown argument`)
    if (block.blank !== undefined && block.blank !== true) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}].blank must be true when present`)
    if (block.page_break !== undefined && block.page_break !== true) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}].page_break must be true when present`)
    const kinds = [block.text !== undefined, block.runs !== undefined, block.items !== undefined, block.blank === true, block.page_break === true].filter(Boolean).length
    if (kinds !== 1) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}] must contain exactly one of text, runs, items, blank:true, or page_break:true`)
    if (block.blank === true || block.page_break === true) {
      const kind = block.blank === true ? 'blank' : 'page_break'
      if (Object.keys(block).some(key => key !== kind)) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}] ${kind} cannot have text, list, or formatting attributes`)
      normalized.push(block)
      continue
    }
    validateFormat(block, `blocks[${index}]`)
    if (block.text !== undefined) {
      if (typeof block.text !== 'string' || block.text.trim().length === 0 || /[\r\n]/u.test(block.text)) {
        throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}].text must be one non-empty single-line paragraph`)
      }
      if (block.list !== undefined) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}] paragraph text cannot have a list type`)
      totalChars += block.text.length
    } else if (block.runs !== undefined) {
      if (block.list !== undefined) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}] inline runs cannot have a list type`)
      if (!Array.isArray(block.runs) || block.runs.length === 0 || block.runs.length > 100) {
        throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}].runs must contain 1 to 100 runs`)
      }
      for (const [runIndex, run] of block.runs.entries()) {
        const path = `blocks[${index}].runs[${runIndex}]`
        if (!run || typeof run !== 'object' || Array.isArray(run)) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `${path} must be an object`)
        const runAllowed = new Set(['text', ...DOCS_WRITE_INLINE_FIELDS])
        if (Object.keys(run).some(key => !runAllowed.has(key))) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `${path} has an unknown argument`)
        if (typeof run.text !== 'string' || run.text.trim().length === 0 || /[\r\n]/u.test(run.text)) {
          throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `${path}.text must be one non-empty single-line string`)
        }
        validateFormat(run, path, false)
        totalChars += run.text.length
      }
    } else {
      if (!['numbered', 'bulleted', 'checklist'].includes(block.list)) throw docsFailure('validate', 'BAD_DOCS_LIST', `blocks[${index}].list must be numbered, bulleted, or checklist`)
      if (block.paragraph_style !== undefined) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}] list groups cannot set paragraph_style`)
      if (!Array.isArray(block.items) || block.items.length === 0 || block.items.length > 100) {
        throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks[${index}].items must contain 1 to 100 items`)
      }
      for (const [itemIndex, item] of block.items.entries()) {
        const path = `blocks[${index}].items[${itemIndex}]`
        const structured = block.list === 'checklist' && item && typeof item === 'object' && !Array.isArray(item)
        if (structured && (Object.keys(item).some(key => !['text', 'checked'].includes(key)) || (item.checked !== undefined && typeof item.checked !== 'boolean'))) {
          throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `${path} accepts only text and an optional boolean checked state`)
        }
        const text = structured ? item.text : item
        if (typeof text !== 'string' || text.trim().length === 0 || text.length > 1000 || /[\r\n]/u.test(text)) {
          throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `${path} must be one non-empty single-line string of at most 1000 characters${block.list === 'checklist' ? ' or a {text,checked} object' : ''}`)
        }
        totalChars += text.length
      }
      totalChars += block.items.length - 1
    }
    normalized.push({
      ...normalize(block),
      ...block.list === 'checklist' ? {
        items: block.items.map(item => typeof item === 'string' ? { text: item, checked: false } : { text: item.text, checked: item.checked ?? false }),
      } : {},
      ...block.runs ? { runs: block.runs.map(normalize) } : {},
    })
  }
  if (totalChars > DOCS_WRITE_MAX_CHARS) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', `blocks contain more than ${DOCS_WRITE_MAX_CHARS} characters`)
  return normalized
}

async function docsApplyWriteColor(context, attribute, value) {
  const control = await docsProbe(context, `write-${attribute}-open`, 'colorControl', { attribute })
  await docsClick(context, `write-${attribute}-open`, control.point)
  if (attribute === 'highlight' && value === 'none') {
    const menu = await docsWait(context, 'write-highlight-none', 'colorMenu', { attribute }, state => state.nonePoint)
    await docsClick(context, 'write-highlight-none', menu.nonePoint)
    await docsWait(context, 'write-highlight-none-close', 'colorMenu', { attribute }, state => !state.open)
  } else {
    const menu = await docsWait(context, `write-${attribute}-custom`, 'colorMenu', { attribute }, state => state.customPoint)
    await docsClick(context, `write-${attribute}-custom`, menu.customPoint)
    const dialog = await docsWait(context, `write-${attribute}-dialog`, 'colorDialog', {}, state => state.open && state.enabled && state.point)
    await docsClick(context, `write-${attribute}-focus`, dialog.point)
    await docsWait(context, `write-${attribute}-focus`, 'colorDialog', {}, state => state.focused)
    await docsKey(context, `write-${attribute}-select`, { key: 'a', code: 'KeyA', keyCode: 65 }, MODIFIER_BITS.ctrl)
    await docsInsertText(context, `write-${attribute}-input`, value)
    await docsWait(context, `write-${attribute}-input`, 'colorDialog', {}, state => state.focused && state.value === value)
    await docsKey(context, `write-${attribute}-commit`, KEY_SPECS.Enter)
    await docsWait(context, `write-${attribute}-close`, 'colorDialog', {}, state => !state.open)
  }
  context.writeColors[attribute] = value
}

async function docsWriteApplyColors(context, wanted) {
  context.writeColors ??= {}
  for (const attribute of ['color', 'highlight']) {
    const value = wanted[attribute]
    if (context.writeColors[attribute] !== value) await docsApplyWriteColor(context, attribute, value)
  }
}

function docsWriteBlockFormat(block, normal) {
  return {
    paragraph_style: block.list ? 'Normal text' : block.paragraph_style ?? 'Normal text',
    font_size: block.font_size ?? normal.fontSize,
    font: block.font ?? normal.font,
    bold: block.bold ?? false,
    italic: block.italic ?? false,
    underline: block.underline ?? false,
    color: block.color ?? '#000000',
    highlight: block.highlight ?? 'none',
  }
}

function docsWriteRunFormat(run, base) {
  const overrides = Object.fromEntries(DOCS_WRITE_INLINE_FIELDS.filter(field => run[field] !== undefined).map(field => [field, run[field]]))
  return { ...base, ...overrides, paragraph_style: base.paragraph_style }
}

function docsWriteExpectedRuns(text, format) {
  if (!text) return []
  return [{
    text,
    bold: format.bold,
    italic: format.italic,
    underline: format.underline,
    strike: false,
    ...(format.font ? { font: format.font } : {}),
    ...(format.font_size !== undefined ? { fontSize: format.font_size } : {}),
    color: format.color,
    highlight: format.highlight,
  }]
}

function docsWriteExpectedBlocks(blocks, normal) {
  const expected = []
  for (const [owner, block] of blocks.entries()) {
    const format = docsWriteBlockFormat(block, normal)
    if (block.page_break === true) {
      expected.push({ kind: 'pagebreak', owner })
    } else if (block.blank === true) {
      expected.push({ kind: 'para', style: 'P', text: '', runs: [], owner })
    } else if (block.list) {
      for (const [index, item] of block.items.entries()) {
        const text = block.list === 'checklist' ? item.text : item
        expected.push({
          kind: 'para',
          style: 'LI',
          text,
          listLevel: 0,
          ordered: block.list === 'numbered',
          ...block.list === 'numbered' ? { number: index + 1 } : {},
          ...block.list === 'checklist' ? { checklist: true, checked: item.checked === true } : {},
          runs: docsWriteExpectedRuns(text, format),
          owner,
        })
      }
    } else {
      const style = format.paragraph_style === 'Normal text' ? 'P'
        : format.paragraph_style === 'Title' ? 'TITLE'
          : format.paragraph_style === 'Subtitle' ? 'SUBTITLE' : `H${format.paragraph_style.slice(-1)}`
      const runs = block.runs
        ? block.runs.map(run => docsWriteExpectedRuns(run.text, docsWriteRunFormat(run, format))[0])
        : docsWriteExpectedRuns(block.text, format)
      const text = block.runs ? block.runs.map(run => run.text).join('') : block.text
      expected.push({ kind: 'para', style, text, runs, owner })
    }
  }
  if (blocks.at(-1)?.list || blocks.at(-1)?.page_break) expected.push({ kind: 'para', style: 'P', text: '', runs: [], owner: blocks.length - 1 })
  return expected
}

const DOCS_WRITE_RUN_MARK_FIELDS = ['bold', 'italic', 'underline', 'strike', 'font', 'fontSize', 'color', 'highlight']

function docsWriteComparableRuns(runs) {
  const merged = []
  for (const run of runs) {
    const current = { ...run, highlight: run.highlight ?? 'none' }
    const previous = merged.at(-1)
    if (previous && DOCS_WRITE_RUN_MARK_FIELDS.every(field => previous[field] === current[field])) previous.text += current.text
    else merged.push(current)
  }
  return merged
}

function docsWriteBlockMatches(actual, expected) {
  for (const field of ['kind', 'style', 'text', 'listLevel', 'ordered', 'number', 'checklist', 'checked']) {
    if (actual?.[field] !== expected[field]) return false
  }
  if (expected.kind !== 'para') return true
  const wanted = docsWriteComparableRuns(expected.runs ?? [])
  const runs = docsWriteComparableRuns(actual?.runs ?? [])
  if (wanted.length === 0) return runs.length === 0
  if (runs.length !== wanted.length) return false
  return wanted.every((format, index) => (
    runs[index].text === format.text
      && DOCS_WRITE_RUN_MARK_FIELDS.every(field => runs[index][field] === format[field])
  ))
}

function docsWriteVerify(prefix, expected, actual, blockCount) {
  if (actual.length < prefix.length || prefix.some((block, index) => JSON.stringify(block) !== JSON.stringify(actual[index]))) {
    return { ok: false, code: 'DOCS_WRITE_COLLATERAL', index: -1, verifiedCount: 0, message: 'Content before the append position changed unexpectedly' }
  }
  const appended = actual.slice(prefix.length)
  for (const [index, block] of appended.entries()) {
    if (block.kind === 'para' && block.style === 'LI' && !block.text.trim()) {
      const owner = expected[index]?.owner ?? blockCount
      return { ok: false, code: 'DOCS_WRITE_EMPTY_LIST_ITEM', index: owner, verifiedCount: owner, message: `An empty list item remains at appended block ${index}` }
    }
  }
  for (const [index, block] of expected.entries()) {
    if (!docsWriteBlockMatches(appended[index], block)) {
      return {
        ok: false,
        code: 'DOCS_WRITE_VERIFY_FAILED',
        index: block.owner,
        verifiedCount: block.owner,
        message: `Appended content diverged at user block ${block.owner}`,
        expected: { style: block.style, text: block.text },
        actual: appended[index] ? { style: appended[index].style, text: appended[index].text } : undefined,
      }
    }
  }
  if (appended.length !== expected.length) {
    return { ok: false, code: 'DOCS_WRITE_COLLATERAL', index: blockCount, verifiedCount: blockCount, message: 'Unexpected extra content followed the appended blocks' }
  }
  return { ok: true, verifiedCount: blockCount }
}

async function docsFrameProbe(context, frameId, stage, command) {
  await docsCurrent(context, stage)
  try {
    const result = await runInFrame(context.tab.id, frameId, docsPageProbe, [command, {}])
    await docsCurrent(context, stage)
    return result
  } catch (error) {
    await docsCurrent(context, stage)
    throw error
  }
}

async function docsFocusDocument(context) {
  const frames = await listFrames(context.tab.id).catch(() => [{ frameId: 0 }])
  for (const frame of frames) {
    const probe = frame.frameId === 0
      ? command => docsProbe(context, 'write-focus-document', command)
      : command => docsFrameProbe(context, frame.frameId, 'write-focus-document', command)
    try {
      const current = await probe('documentContent')
      if (!current.present) continue
      if (!current.focused) {
        const focused = await probe('focusDocument')
        if (!focused.focused) continue
      }
      const verified = await probe('documentContent')
      if (verified.focused) return
    } catch {}
  }
  throw docsFailure('write-focus-document', 'DOCS_FOCUS_FAILED', `Document content editor was not found or could not be focused in ${frames.length} frame(s)`)
}

function docsWritePositionMatches(baseline, positioned, reused) {
  if (reused) return JSON.stringify(positioned) === JSON.stringify(baseline)
  if (baseline.length === 0) return positioned.length === 0
  if (positioned.length !== baseline.length + 1) return false
  const last = positioned.at(-1)
  if (last?.kind !== 'para' || last.text.trim()) return false
  return baseline.every((block, index) => JSON.stringify(block) === JSON.stringify(positioned[index]))
}

async function docsWriteStart(context, baseline) {
  const last = baseline.at(-1)
  let reused = false
  await docsKey(context, 'write-document-end', { ...KEY_SPECS.End }, MODIFIER_BITS.ctrl)
  if (last?.kind === 'para' && last.style === 'LI') {
    if (last.text.trim()) {
      await docsKey(context, 'write-list-exit', KEY_SPECS.Enter)
      await docsKey(context, 'write-list-exit', KEY_SPECS.Enter)
    } else {
      await docsKey(context, 'write-list-exit', KEY_SPECS.Enter)
      reused = true
    }
  } else if (last?.kind === 'para' && !last.text.trim()) reused = true
  else if (last) await docsKey(context, 'write-next-paragraph', KEY_SPECS.Enter)
  return { prefix: reused ? baseline.slice(0, -1) : baseline, reused }
}

async function docsWriteFlow(context, args) {
  context.attemptedCount = 0
  try {
    const baseline = parseDocStructure(await docsExport(context, 'write-baseline', 'html'))
    const lastRun = baseline.findLast(block => block.runs?.length)?.runs.at(-1)
    context.writeColors = {
      color: lastRun?.color ?? '#000000',
      highlight: lastRun?.highlight ?? 'none',
    }
    await docsFocusDocument(context)
    const { prefix, reused } = await docsWriteStart(context, baseline)
    const positioned = parseDocStructure(await docsExport(context, 'write-position', 'html'))
    if (!docsWritePositionMatches(baseline, positioned, reused)) {
      throw docsFailure('write-position', 'DOCS_WRITE_POSITION', 'Document end was not established before formatting; no blocks were typed')
    }
    await docsApplyFormatStates(context, { paragraph_style: 'Normal text' }, '')
    const normal = await docsProbe(context, 'write-normal-defaults', 'format', { attributes: DOCS_FORMAT_ATTRIBUTES })
    const expected = docsWriteExpectedBlocks(args.blocks, normal)
    const apply = async (wanted, index, runIndex) => {
      const { fontMissing } = await docsApplyFormatStates(context, wanted, '')
      if (fontMissing) throw docsFailure('write-font', 'DOCS_FONT_MISSING', `Font ${JSON.stringify(wanted.font)} is unavailable; block ${index}${runIndex === undefined ? '' : ` run ${runIndex}`} was not typed`)
      await docsWriteApplyColors(context, wanted)
    }
    for (const [index, block] of args.blocks.entries()) {
      context.attemptedCount = index + 1
      const wanted = docsWriteBlockFormat(block, normal)
      if (block.page_break === true) {
        await docsKey(context, 'write-page-break', KEY_SPECS.Enter, MODIFIER_BITS.ctrl)
        continue
      }
      if (block.list) {
        await apply(wanted, index)
        const key = { numbered: '7', bulleted: '8', checklist: '9' }[block.list]
        await docsKey(context, 'write-list-start', {
          key,
          code: `Digit${key}`,
          keyCode: Number(key) + 48,
        }, MODIFIER_BITS.ctrl | MODIFIER_BITS.shift)
        await docsWaitFormat(context, 'write-list-start-verify', [block.list], { [block.list]: true })
        if (block.list === 'checklist') {
          for (const [itemIndex, item] of block.items.entries()) {
            await docsInsertText(context, 'write-checklist-item', item.text)
            if (item.checked) await docsKey(context, 'write-checklist-checked', KEY_SPECS.Enter, MODIFIER_BITS.ctrl | MODIFIER_BITS.shift)
            if (itemIndex < block.items.length - 1) await docsKey(context, 'write-checklist-next', KEY_SPECS.Enter)
          }
        } else {
          await docsInsertText(context, 'write-list-items', block.items.join('\n'))
        }
        await docsKey(context, 'write-list-exit', KEY_SPECS.Enter)
        await docsKey(context, 'write-list-exit', KEY_SPECS.Enter)
        await docsWaitFormat(context, 'write-list-exit-verify', ['numbered', 'bulleted', 'checklist'], { numbered: false, bulleted: false, checklist: false })
      } else {
        if (block.runs) {
          for (const [runIndex, run] of block.runs.entries()) {
            await apply(docsWriteRunFormat(run, wanted), index, runIndex)
            await docsInsertText(context, 'write-inline-run', run.text)
          }
        } else {
          await apply(wanted, index)
          if (!block.blank) await docsInsertText(context, 'write-paragraph', block.text)
        }
        if (index < args.blocks.length - 1 && args.blocks[index + 1].page_break !== true) {
          await docsKey(context, 'write-next-paragraph', KEY_SPECS.Enter)
        }
      }
    }
    const verificationEnd = Math.min(context.deadline, context.driver.now() + 8_000)
    let actual
    let verification
    let retryDelay = 500
    while (true) {
      actual = parseDocStructure(await docsExport(context, 'write-verify', 'html'))
      verification = docsWriteVerify(prefix, expected, actual, args.blocks.length)
      if (verification.ok || verification.code !== 'DOCS_WRITE_VERIFY_FAILED' || context.driver.now() + retryDelay > verificationEnd) break
      await context.driver.sleep(retryDelay)
      retryDelay = Math.min(2_000, retryDelay * 2)
    }
    const outline = formatOutline(actual.slice(prefix.length))
    if (!verification.ok) {
      return await docsFinish(context, {
        status: verification.verifiedCount > 0 ? 'partial' : 'failed',
        blockCount: args.blocks.length,
        attemptedCount: context.attemptedCount,
        verifiedCount: verification.verifiedCount,
        verifiedBy: 'export',
        results: args.blocks.map((_, index) => ({
          index,
          status: index < verification.verifiedCount ? 'verified' : index === verification.index ? 'failed' : 'unverified',
        })),
        failure: {
          index: verification.index,
          code: verification.code,
          message: verification.message,
          ...verification.expected ? { expected: verification.expected } : {},
          ...verification.actual ? { actual: verification.actual } : {},
        },
        outline,
      })
    }
    return await docsFinish(context, {
      status: 'completed',
      blockCount: args.blocks.length,
      attemptedCount: context.attemptedCount,
      verifiedCount: verification.verifiedCount,
      verifiedBy: 'export',
      results: args.blocks.map((_, index) => ({ index, status: 'verified' })),
      outline,
    })
  } catch (error) {
    if (error instanceof Error) error.message += `; ${context.attemptedCount} block(s) were attempted; export verification is incomplete; use browser_docs_read before any retry`
    throw error
  }
}

async function docsWriteLocked(settings, args, tab, driver) {
  const context = {
    settings,
    tab,
    driver,
    action: 'write',
    initialUrl: tab.url,
    deadline: driver.now() + DOCS_WRITE_DEADLINE_MS,
    deadlineMs: DOCS_WRITE_DEADLINE_MS,
  }
  let timer
  try {
    return await Promise.race([
      docsWriteFlow(context, args),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(docsFailure('deadline', 'DOCS_DEADLINE', `The Docs write operation exceeded ${DOCS_WRITE_DEADLINE_MS / 1000}s`)), DOCS_WRITE_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function docsWrite(settings, args, io = {}) {
  if (args?.action !== 'write') throw docsFailure('validate', 'BAD_DOCS_ACTION', 'docs action must be write')
  if (Object.keys(args).some(key => !['action', 'blocks'].includes(key))) throw docsFailure('validate', 'BAD_DOCS_BLOCKS', 'unknown Docs write argument')
  const blocks = docsWriteValidateBlocks(args.blocks)
  const normalizedArgs = { ...args, blocks }
  const driver = docsDriver(io)
  let tab
  try {
    const windowId = await driver.getWindowId()
    tab = await driver.getActiveTab(windowId)
  } catch (error) {
    throw docsDriverError('validate-tab', 'DOCS_TAB_CHECK_FAILED', error)
  }
  if (tab?.id === undefined || !docsUrl(tab.url)) {
    throw docsFailure('validate-tab', 'DOCS_URL_UNSUPPORTED', 'The active tab must be an https://docs.google.com/document URL')
  }
  const previous = docsTabLocks.get(tab.id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => docsWriteLocked(settings, normalizedArgs, tab, driver))
  const gate = run.catch(() => {})
  docsTabLocks.set(tab.id, gate)
  try {
    return await run
  } finally {
    if (docsTabLocks.get(tab.id) === gate) docsTabLocks.delete(tab.id)
  }
}

function docsTextOccurrences(haystack, needle) {
  const source = String(haystack).toLowerCase()
  const wanted = String(needle).toLowerCase()
  return wanted ? source.split(wanted).length - 1 : 0
}

const DOCS_REPLACE_WAIT_MS = 8_000

async function docsApplyReplacement(context, text, replacement) {
  await docsNativeText(context, 'replace-query', 'setReplaceFind', text)
  const found = await docsWait(context, 'replace-query', 'replace', {}, state => state.findValue === text && state.match !== undefined, DOCS_REPLACE_WAIT_MS)
  if (found.match.total !== 1 || found.match.current !== 1) {
    throw docsFailure('replace-match', 'DOCS_MATCH_NOT_UNIQUE', `Expected normalized 1 of 1, found ${found.match.text}`)
  }
  let replacementBaseline = 0
  if (replacement) {
    await docsNativeText(context, 'replacement-baseline', 'setReplaceFind', replacement)
    const baseline = await docsWait(context, 'replacement-baseline', 'replace', {}, state => (
      state.findValue === replacement && state.match !== undefined
    ), DOCS_REPLACE_WAIT_MS)
    replacementBaseline = baseline.match.total
    await docsNativeText(context, 'replace-query-restore', 'setReplaceFind', text)
    await docsWait(context, 'replace-query-restore', 'replace', {}, state => (
      state.findValue === text && state.match?.current === 1 && state.match.total === 1
    ), DOCS_REPLACE_WAIT_MS)
  }
  await docsNativeText(context, 'replacement-value', 'setReplaceWith', replacement)
  const ready = await docsWait(context, 'replace-input', 'replace', {}, state => (
    state.findValue === text && state.replacementValue === replacement && state.match?.total === 1 && state.replace
  ), DOCS_REPLACE_WAIT_MS)
  await docsClick(context, 'replace-text', ready.replace)
  const expectedOldMatches = docsTextOccurrences(replacement, text)
  const expectedNewMatches = replacementBaseline - docsTextOccurrences(text, replacement) + 1
  if (replacement && expectedNewMatches < 0) {
    throw docsFailure('verify-replacement', 'DOCS_COUNTER_MISMATCH', 'The replacement counter baseline became inconsistent')
  }
  const verified = await docsWait(context, 'verify-replacement', 'replace', {}, state => (
    (state.findValue === text && state.match?.total === expectedOldMatches)
      || (replacement && state.findValue === replacement && state.match.total === expectedNewMatches)
  ), DOCS_REPLACE_WAIT_MS)
  if (!replacement) return { matchCount: 0 }
  if (verified.findValue === replacement) {
    if (expectedNewMatches !== replacementBaseline) return { matchCount: verified.match.total }
    await docsCloseReplace(context)
    const oldText = await docsOpenFind(context, text)
    if (oldText.match.total !== expectedOldMatches) {
      throw docsFailure('verify-replacement', 'DOCS_VERIFY_FAILED', `Expected ${expectedOldMatches} old-text matches, found ${oldText.match.text}`)
    }
    await docsCloseFind(context, 'verify-replacement')
    return { matchCount: expectedNewMatches }
  }
  await docsCloseReplace(context)
  const replacementState = await docsOpenFind(context, replacement)
  if (replacementState.match.total !== expectedNewMatches) {
    throw docsFailure('verify-replacement', 'DOCS_VERIFY_FAILED', `Expected ${expectedNewMatches} replacement matches, found ${replacementState.match.text}`)
  }
  await docsCloseFind(context, 'verify-replacement')
  return { matchCount: replacementState.match.total }
}

async function docsOpenReplace(context) {
  const existing = await docsProbe(context, 'open-replace', 'replace')
  if (existing.open) return
  await docsKey(context, 'open-replace', { key: 'h', code: 'KeyH', keyCode: 72 }, MODIFIER_BITS.ctrl)
  try {
    await docsWait(context, 'open-replace', 'replace', {}, state => state.open && state.findEnabled && state.replacementEnabled, DOCS_REPLACE_WAIT_MS)
    return
  } catch (error) {
    if (error?.code !== 'DOCS_WAIT_TIMEOUT') throw error
    const edit = await docsProbe(context, 'open-replace-menu', 'editMenu')
    if (!edit.present || edit.disabled) throw error
    await docsClick(context, 'open-replace-menu', edit.point)
    const item = await docsWait(context, 'open-replace-menu', 'replaceMenuItem', {}, state => state.point && !state.disabled, DOCS_REPLACE_WAIT_MS)
    await docsClick(context, 'open-replace-menu', item.point)
    await docsWait(context, 'open-replace', 'replace', {}, state => state.open && state.findEnabled && state.replacementEnabled, DOCS_REPLACE_WAIT_MS)
  }
}

const DOCS_CLOSE_WAIT_MS = 30_000

async function docsCloseReplace(context) {
  const state = await docsProbe(context, 'close-replace', 'replace')
  if (!state.open) return
  if (state.close) await docsClick(context, 'close-replace', state.close)
  else await docsKey(context, 'close-replace', KEY_SPECS.Escape)
  await docsWait(context, 'close-replace', 'replace', {}, next => !next.open, DOCS_CLOSE_WAIT_MS)
}

async function docsReplaceTextFlow(context, text, replacement) {
  await docsOpenReplace(context)
  const applied = await docsApplyReplacement(context, text, replacement)
  await docsCloseReplace(context)
  return docsFinish(context, {
    status: replacement ? 'replaced_text' : 'removed_text',
    matchCount: applied.matchCount,
    verifiedBy: 'find-counter',
    ...replacement ? {} : { removedText: text },
  })
}

async function docsReplaceTextLocked(settings, args, tab, driver) {
  const context = {
    settings,
    tab,
    driver,
    action: 'replace_text',
    initialUrl: tab.url,
    deadline: driver.now() + DOCS_DEADLINE_MS,
  }
  let timer
  try {
    return await Promise.race([
      docsReplaceTextFlow(context, args.text, args.replacement),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(docsFailure('deadline', 'DOCS_DEADLINE', `The Docs operation exceeded ${DOCS_DEADLINE_MS / 1000}s`)), DOCS_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function docsReplaceText(settings, args, io = {}) {
  if (args?.action !== 'replace_text') throw docsFailure('validate', 'BAD_DOCS_ACTION', 'docs action must be replace_text')
  if (typeof args.text !== 'string' || args.text.trim().length === 0 || args.text.length > 1000) {
    throw docsFailure('validate', 'BAD_DOCS_TEXT', 'text must be a non-empty string of at most 1000 characters')
  }
  if (typeof args.replacement !== 'string' || args.replacement.length > 1000) {
    throw docsFailure('validate', 'BAD_DOCS_REPLACEMENT', 'replacement must be a string of at most 1000 characters')
  }
  if (args.replacement === args.text) throw docsFailure('validate', 'BAD_DOCS_REPLACEMENT', 'replacement must differ from text')
  const driver = docsDriver(io)
  let tab
  try {
    const windowId = await driver.getWindowId()
    tab = await driver.getActiveTab(windowId)
  } catch (error) {
    throw docsDriverError('validate-tab', 'DOCS_TAB_CHECK_FAILED', error)
  }
  if (tab?.id === undefined || !docsUrl(tab.url)) {
    throw docsFailure('validate-tab', 'DOCS_URL_UNSUPPORTED', 'The active tab must be an https://docs.google.com/document URL')
  }
  const previous = docsTabLocks.get(tab.id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => docsReplaceTextLocked(settings, args, tab, driver))
  const gate = run.catch(() => {})
  docsTabLocks.set(tab.id, gate)
  try {
    return await run
  } finally {
    if (docsTabLocks.get(tab.id) === gate) docsTabLocks.delete(tab.id)
  }
}

const DOCS_REPLACE_MANY_MAX_EDITS = 200
const DOCS_REPLACE_MANY_DEADLINE_MS = 600_000

async function docsReplaceManyFlow(context, edits) {
  const results = []
  let appliedCount = 0
  try {
    let failure
    for (const [index, edit] of edits.entries()) {
      let applied
      try {
        await docsOpenReplace(context)
        applied = await docsApplyReplacement(context, edit.text, edit.replacement)
      } catch (error) {
        if (error?.code !== 'DOCS_MATCH_NOT_UNIQUE') throw error
        failure = {
          index,
          text: edit.text,
          code: error.code,
          stage: error.stage,
          message: error.message,
        }
        results.push({ index, status: 'failed', code: error.code })
        break
      }
      appliedCount += 1
      results.push({
        index,
        status: edit.replacement ? 'replaced_text' : 'removed_text',
        matchCount: applied.matchCount,
      })
    }
    await docsCloseReplace(context)
    const status = failure ? appliedCount > 0 ? 'partial' : 'failed' : 'completed'
    return await docsFinish(context, {
      status,
      editCount: edits.length,
      appliedCount,
      remainingCount: edits.length - results.length,
      verifiedBy: 'find-counter',
      results,
      ...failure ? { failure } : {},
    })
  } catch (error) {
    if (appliedCount > 0 && error instanceof Error) {
      error.message += `; ${appliedCount} earlier edit${appliedCount === 1 ? ' was' : 's were'} applied before this failure`
    }
    throw error
  }
}

async function docsReplaceManyLocked(settings, args, tab, driver) {
  const context = {
    settings,
    tab,
    driver,
    action: 'replace_many',
    initialUrl: tab.url,
    deadline: driver.now() + DOCS_REPLACE_MANY_DEADLINE_MS,
  }
  let timer
  try {
    return await Promise.race([
      docsReplaceManyFlow(context, args.edits),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(docsFailure('deadline', 'DOCS_DEADLINE', `The Docs batch operation exceeded ${DOCS_REPLACE_MANY_DEADLINE_MS / 1000}s`)), DOCS_REPLACE_MANY_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function docsReplaceMany(settings, args, io = {}) {
  if (args?.action !== 'replace_many') throw docsFailure('validate', 'BAD_DOCS_ACTION', 'docs action must be replace_many')
  if (!Array.isArray(args.edits) || args.edits.length === 0 || args.edits.length > DOCS_REPLACE_MANY_MAX_EDITS) {
    throw docsFailure('validate', 'BAD_DOCS_EDITS', `edits must be an array of 1 to ${DOCS_REPLACE_MANY_MAX_EDITS} replacement objects`)
  }
  for (const [index, edit] of args.edits.entries()) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
      throw docsFailure('validate', 'BAD_DOCS_EDITS', `edits[${index}] must be an object`)
    }
    if (typeof edit.text !== 'string' || edit.text.trim().length === 0 || edit.text.length > 1000) {
      throw docsFailure('validate', 'BAD_DOCS_TEXT', `edits[${index}].text must be a non-empty string of at most 1000 characters`)
    }
    if (typeof edit.replacement !== 'string' || edit.replacement.length > 1000) {
      throw docsFailure('validate', 'BAD_DOCS_REPLACEMENT', `edits[${index}].replacement must be a string of at most 1000 characters`)
    }
    if (edit.replacement === edit.text) throw docsFailure('validate', 'BAD_DOCS_REPLACEMENT', `edits[${index}] replacement must differ from text`)
  }
  const driver = docsDriver(io)
  let tab
  try {
    const windowId = await driver.getWindowId()
    tab = await driver.getActiveTab(windowId)
  } catch (error) {
    throw docsDriverError('validate-tab', 'DOCS_TAB_CHECK_FAILED', error)
  }
  if (tab?.id === undefined || !docsUrl(tab.url)) {
    throw docsFailure('validate-tab', 'DOCS_URL_UNSUPPORTED', 'The active tab must be an https://docs.google.com/document URL')
  }
  const previous = docsTabLocks.get(tab.id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => docsReplaceManyLocked(settings, args, tab, driver))
  const gate = run.catch(() => {})
  docsTabLocks.set(tab.id, gate)
  try {
    return await run
  } finally {
    if (docsTabLocks.get(tab.id) === gate) docsTabLocks.delete(tab.id)
  }
}

async function docsRenameFlow(context, title) {
  const control = await docsWait(context, 'rename-target', 'rename', {}, state => state.present && state.enabled && state.point, DOCS_REPLACE_WAIT_MS)
  await docsClick(context, 'rename-focus', control.point)
  await docsWait(context, 'rename-focus', 'rename', {}, state => state.focused, DOCS_REPLACE_WAIT_MS)
  await docsKey(context, 'rename-select', { key: 'a', code: 'KeyA', keyCode: 65 }, MODIFIER_BITS.ctrl)
  await docsInsertText(context, 'rename-input', title)
  await docsWait(context, 'rename-input', 'rename', {}, state => state.value === title && state.focused, DOCS_REPLACE_WAIT_MS)
  await docsKey(context, 'rename-commit', KEY_SPECS.Enter)
  await docsWait(context, 'rename-commit', 'rename', {}, state => (
    state.title === title || state.title === `${title} - Google Docs`
  ), DOCS_REPLACE_WAIT_MS)
  return docsFinish(context, { status: 'renamed', verifiedBy: 'document-title', title })
}

async function docsRenameLocked(settings, args, tab, driver) {
  const context = {
    settings,
    tab,
    driver,
    action: 'rename',
    initialUrl: tab.url,
    deadline: driver.now() + DOCS_DEADLINE_MS,
  }
  let timer
  try {
    return await Promise.race([
      docsRenameFlow(context, args.title.trim()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(docsFailure('deadline', 'DOCS_DEADLINE', `The Docs operation exceeded ${DOCS_DEADLINE_MS / 1000}s`)), DOCS_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function docsRename(settings, args, io = {}) {
  if (args?.action !== 'rename') throw docsFailure('validate', 'BAD_DOCS_ACTION', 'docs action must be rename')
  if (typeof args.title !== 'string' || args.title.trim().length === 0 || args.title.length > 200) {
    throw docsFailure('validate', 'BAD_DOCS_TITLE', 'title must be a non-empty string of at most 200 characters')
  }
  const driver = docsDriver(io)
  let tab
  try {
    const windowId = await driver.getWindowId()
    tab = await driver.getActiveTab(windowId)
  } catch (error) {
    throw docsDriverError('validate-tab', 'DOCS_TAB_CHECK_FAILED', error)
  }
  if (tab?.id === undefined || !docsUrl(tab.url)) {
    throw docsFailure('validate-tab', 'DOCS_URL_UNSUPPORTED', 'The active tab must be an https://docs.google.com/document URL')
  }
  const previous = docsTabLocks.get(tab.id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => docsRenameLocked(settings, args, tab, driver))
  const gate = run.catch(() => {})
  docsTabLocks.set(tab.id, gate)
  try {
    return await run
  } finally {
    if (docsTabLocks.get(tab.id) === gate) docsTabLocks.delete(tab.id)
  }
}

function docsPageSetupMatches(state, args) {
  if (!state.open) return false
  if (args.paper_size !== undefined && !state.paperSize.includes(args.paper_size)) return false
  if (args.orientation !== undefined && state[args.orientation] !== true) return false
  for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
    const wanted = args.margins?.[side]
    if (wanted !== undefined && Number(state.margins[side]?.value) !== wanted) return false
  }
  return true
}

async function docsPageSetupFlow(context, args) {
  let state = await docsProbe(context, 'page-setup-resume', 'pageSetup')
  if (!state.open) {
    const file = await docsWait(context, 'page-setup-file', 'fileMenu', {}, current => current.present && !current.disabled && current.point)
    await docsClick(context, 'page-setup-file', file.point)
    const item = await docsWait(context, 'page-setup-open', 'pageSetupMenuItem', {}, current => current.present && !current.disabled && current.point)
    await docsClick(context, 'page-setup-open', item.point)
    state = await docsWait(context, 'page-setup-dialog', 'pageSetup', {}, current => current.open)
  }
  if (args.paper_size !== undefined && !state.paperSize.includes(args.paper_size)) {
    await docsClick(context, 'page-setup-paper-open', state.paperPoint)
    const row = await docsWait(context, 'page-setup-paper', 'pagePaperMenu', {}, current => current.point)
    await docsClick(context, 'page-setup-paper', row.point)
    state = await docsWait(context, 'page-setup-paper-verify', 'pageSetup', {}, current => current.open && current.paperSize.includes(args.paper_size))
  }
  if (args.orientation !== undefined && state[args.orientation] !== true) {
    const point = args.orientation === 'portrait' ? state.portraitPoint : state.landscapePoint
    await docsClick(context, 'page-setup-orientation', point)
    state = await docsWait(context, 'page-setup-orientation-verify', 'pageSetup', {}, current => current.open && current[args.orientation] === true)
  }
  for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
    const wanted = args.margins?.[side]
    if (wanted === undefined || Number(state.margins[side].value) === wanted) continue
    const changed = await docsProbe(context, 'page-setup-margin', 'setPageMargin', { side, value: String(wanted) })
    if (!changed.readback) throw docsFailure('page-setup-margin', 'DOCS_QUERY_MISMATCH', `${side} margin did not retain ${wanted}`)
    state = await docsWait(context, 'page-setup-margin-verify', 'pageSetup', {}, current => current.open && Number(current.margins[side]?.value) === wanted)
  }
  state = await docsWait(context, 'page-setup-verify', 'pageSetup', {}, current => docsPageSetupMatches(current, args))
  await docsClick(context, 'page-setup-ok', state.okPoint)
  try {
    await docsWait(context, 'page-setup-close', 'pageSetup', {}, current => !current.open)
  } catch (error) {
    if (error?.code !== 'DOCS_WAIT_TIMEOUT') throw error
    const latest = await docsProbe(context, 'page-setup-close-recheck', 'pageSetup')
    if (latest.open) {
      await docsClick(context, 'page-setup-ok-retry', latest.okPoint)
      await docsWait(context, 'page-setup-close', 'pageSetup', {}, current => !current.open)
    }
  }
  return docsFinish(context, {
    status: 'completed',
    ...args.paper_size !== undefined ? { paperSize: args.paper_size } : {},
    ...args.orientation !== undefined ? { orientation: args.orientation } : {},
    ...args.margins !== undefined ? { margins: args.margins } : {},
    verifiedBy: 'page-setup-dialog',
  })
}

async function docsPageSetupLocked(settings, args, tab, driver) {
  const context = {
    settings,
    tab,
    driver,
    action: 'page_setup',
    initialUrl: tab.url,
    deadline: driver.now() + DOCS_DEADLINE_MS,
  }
  let timer
  try {
    return await Promise.race([
      docsPageSetupFlow(context, args),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(docsFailure('deadline', 'DOCS_DEADLINE', `The Docs operation exceeded ${DOCS_DEADLINE_MS / 1000}s`)), DOCS_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function docsPageSetup(settings, args, io = {}) {
  if (args?.action !== 'page_setup') throw docsFailure('validate', 'BAD_DOCS_ACTION', 'docs action must be page_setup')
  const allowed = new Set(['action', 'paper_size', 'orientation', 'margins'])
  if (Object.keys(args).some(key => !allowed.has(key))) throw docsFailure('validate', 'BAD_DOCS_PAGE_SETUP', 'unknown Docs page setup argument')
  if (args.paper_size === undefined && args.orientation === undefined && args.margins === undefined) {
    throw docsFailure('validate', 'BAD_DOCS_PAGE_SETUP', 'page setup requires paper_size, orientation, or margins')
  }
  if (args.paper_size !== undefined && args.paper_size !== 'Letter') throw docsFailure('validate', 'BAD_DOCS_PAGE_SETUP', 'paper_size must be Letter')
  if (args.orientation !== undefined && !['portrait', 'landscape'].includes(args.orientation)) {
    throw docsFailure('validate', 'BAD_DOCS_PAGE_SETUP', 'orientation must be portrait or landscape')
  }
  if (args.margins !== undefined) {
    if (!args.margins || typeof args.margins !== 'object' || Array.isArray(args.margins) || Object.keys(args.margins).length === 0
      || Object.keys(args.margins).some(key => !['Top', 'Bottom', 'Left', 'Right'].includes(key))) {
      throw docsFailure('validate', 'BAD_DOCS_PAGE_SETUP', 'margins must name at least one of Top, Bottom, Left, Right')
    }
    for (const value of Object.values(args.margins)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
        throw docsFailure('validate', 'BAD_DOCS_PAGE_SETUP', 'margin values must be numbers from 0 to 10 inches')
      }
    }
  }
  const driver = docsDriver(io)
  let tab
  try {
    const windowId = await driver.getWindowId()
    tab = await driver.getActiveTab(windowId)
  } catch (error) {
    throw docsDriverError('validate-tab', 'DOCS_TAB_CHECK_FAILED', error)
  }
  if (tab?.id === undefined || !docsUrl(tab.url)) {
    throw docsFailure('validate-tab', 'DOCS_URL_UNSUPPORTED', 'The active tab must be an https://docs.google.com/document URL')
  }
  const previous = docsTabLocks.get(tab.id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => docsPageSetupLocked(settings, args, tab, driver))
  const gate = run.catch(() => {})
  docsTabLocks.set(tab.id, gate)
  try {
    return await run
  } finally {
    if (docsTabLocks.get(tab.id) === gate) docsTabLocks.delete(tab.id)
  }
}

const BATCH_OPS = new Set(['click', 'click_at', 'hover', 'select_option', 'type', 'press_key', 'scroll', 'wait_for', 'navigate', 'select'])
const BATCH_ACTION_FIELDS = [
  'changed', 'signals', 'clicked', 'hovered', 'selected', 'selectedIndex',
  'typed', 'pressed', 'points', 'trusted', 'changedCount', 'offScreenCount', 'clickMs',
  'scroll', 'moved', 'wheel', 'requestedPixels', 'container', 'waited', 'navigated',
  'staleScroll', 'scrolledIntoView', 'reResolved',
]

/**
 * Run several already-validated actions in order with ONE final view.
 * Inner actions run at batchDepth > 0 and therefore skip their own view.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function batch(settings, args) {
  const started = performance.now()
  const rawActions = args?.actions
  if (!Array.isArray(rawActions) || rawActions.length === 0 || rawActions.length > 20) {
    throw new BrowserError('BAD_BATCH', 'actions must be an array of 1 to 20 action objects')
  }
  for (const [index, action] of rawActions.entries()) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new BrowserError('BAD_BATCH', `action ${index + 1} must be an object`)
    }
    const op = action.op
    if (typeof op !== 'string' || !BATCH_OPS.has(op)) {
      throw new BrowserError('BAD_BATCH', `action ${index + 1} has unsupported op ${JSON.stringify(op)}; allowed: ${[...BATCH_OPS].join(', ')}`)
    }
    if (action.args !== undefined && (typeof action.args !== 'object' || action.args === null || Array.isArray(action.args))) {
      throw new BrowserError('BAD_BATCH', `action ${index + 1} args must be an object`)
    }
  }
  const stopOnError = args.stop_on_error !== false
  const initialTab = await getActiveTab(await getWindowId())
  const canvasError = canvasBatchError(initialTab.url ?? '', rawActions)
  if (canvasError) throw new BrowserError(canvasError.code, canvasError.message)
  const requestedView = actionViewForTab(initialTab, parseViewArg(args, 'full'))
  /** @type {Array<Record<string, any>>} */
  const actions = []
  let ok = true
  let failedIndex
  let stoppedEarly = false
  const actionsStarted = performance.now()
  batchDepth += 1
  try {
    for (const [index, action] of rawActions.entries()) {
      try {
        const inner = await execute(action.op, action.args ?? {}, settings)
        const item = { index: index + 1, op: action.op, ok: true }
        for (const field of BATCH_ACTION_FIELDS) {
          if (inner && inner[field] !== undefined) item[field] = inner[field]
        }
        actions.push(item)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BATCH_ACTION_FAILED'
        const message = error instanceof Error ? error.message : String(error)
        actions.push({ index: index + 1, op: action.op, ok: false, error: { code, message } })
        ok = false
        failedIndex = index + 1
        if (stopOnError) {
          stoppedEarly = true
          break
        }
      }
    }
  } finally {
    batchDepth -= 1
  }
  const elapsedMs = Math.round(performance.now() - actionsStarted)
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  const viewStarted = performance.now()
  const built = await buildBatchView(tab, settings, actionViewForTab(tab, requestedView))
  const viewMs = Math.round(performance.now() - viewStarted)
  const viewPayload = { ...built.payload }
  // The frozen batch payload flattens the view on the root but drops the
  // snapshot's own op/totalMs.
  delete viewPayload.op
  delete viewPayload.totalMs
  return {
    op: 'batch',
    view: built.mode,
    totalMs: Math.round(performance.now() - started),
    batch: {
      total: rawActions.length,
      executed: actions.length,
      succeeded: actions.filter(item => item.ok === true).length,
      ok,
      stoppedEarly,
      ...(failedIndex === undefined ? {} : { failedIndex }),
      elapsedMs,
      viewMs,
    },
    actions,
    ...viewPayload,
  }
}

/**
 * Clamp an optional model-requested page-side delay for a snapshot.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeDelayMs(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.min(5_000, Math.round(ms)))
}

/**
 * Execute one bridge command.
 * @param {string} op
 * @param {Record<string, any>} args
 * @param {import('./protocol.js').Settings} [settings]
 */
export async function execute(op, args = {}, settings) {
  const normalized = normalizeSettings(settings)
  if (normalized.paused) throw new BrowserError('PAUSED', 'Browser access is paused in the side panel.')
  if (op === 'snapshot') {
    const detail = args.detail === 'high' ? 'high' : args.detail === 'fast' ? 'fast' : 'normal'
    return snapshot(detail, normalized, false, normalizeDelayMs(args.delay_ms))
  }
  if (op === 'scroll') {
    return scroll(normalized, args.direction, args.pages, args.amount_px, args.at_x, args.at_y)
  }
  if (op === 'tabs.list') {
    return listTabs(await getWindowId())
  }
  if (op === 'tabs.activate') {
    return activateTab(normalized, args.tab_id, args.query)
  }
  if (op === 'click') {
    return click(normalized, args)
  }
  if (op === 'click_at') {
    return clickAt(normalized, args)
  }
  if (op === 'select') {
    return selectRange(normalized, args)
  }
  if (op === 'batch') {
    return batch(normalized, args)
  }
  if (op === 'docs') {
    if (args.action === 'replace_text') return docsReplaceText(normalized, args)
    if (args.action === 'replace_many') return docsReplaceMany(normalized, args)
    if (args.action === 'rename') return docsRename(normalized, args)
    if (args.action === 'format') return docsFormat(normalized, args)
    if (args.action === 'read') return docsRead(normalized, args)
    if (args.action === 'write') return docsWrite(normalized, args)
    if (args.action === 'page_setup') return docsPageSetup(normalized, args)
    return docsSetFont(normalized, args)
  }
  if (op === 'type') {
    return typeText(normalized, args)
  }
  if (op === 'press_key') {
    return pressKey(normalized, args)
  }
  if (op === 'navigate') {
    return navigate(normalized, args)
  }
  if (op === 'wait_for') {
    return waitFor(normalized, args)
  }
  if (op === 'select_option') {
    return selectOptionOp(normalized, args)
  }
  if (op === 'hover') {
    return hover(normalized, args)
  }
  if (op === 'labels.clear') {
    const windowId = await getWindowId()
    const tab = await getActiveTab(windowId)
    if (tab?.id === undefined || isProtectedUrl(tab.url)) return { op: 'labels.clear', cleared: false }
    await clearAllFrames(tab.id)
    return { op: 'labels.clear', cleared: true }
  }
  if (op === 'read_text') {
    const scope = args.scope === 'viewport' ? 'viewport' : 'page'
    const offset = Number.isFinite(Number(args.offset)) ? Math.max(0, Math.floor(Number(args.offset))) : 0
    const maxChars = Number.isFinite(Number(args.max_chars)) ? Math.floor(Number(args.max_chars)) : 12_000
    return readText(normalized, scope, offset, maxChars)
  }
  if (op === 'clipboard') {
    return clipboardOp(normalized, args)
  }
  throw new BrowserError('BAD_OP', `Unknown browser operation: ${String(op)}`)
}

/** @param {import('./protocol.js').Settings} [settings] */
export async function testCapture(settings) {
  return snapshot('normal', normalizeSettings(settings))
}

/**
 * @param {import('./protocol.js').Settings | undefined} settings
 * @returns {string}
 */
export function imageDataUrl(image) {
  if (!image?.data || !image?.mimeType) return ''
  return `data:${image.mimeType};base64,${image.data}`
}