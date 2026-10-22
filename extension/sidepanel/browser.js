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

export const DEFAULT_SETTINGS = {
  bridgeUrl: 'ws://127.0.0.1:17871/bridge',
  token: '',
  captureWidth: 1280,
  quality: 72,
  autoCapture: true,
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
 * Cumulative label registry per tab: global label id -> owning frame. Labels
 * merge across views so an id from an earlier view on the same page still
 * resolves. A URL change invalidates the whole entry.
 * @type {Map<number, {url: string, labels: Map<number, {frameId: number, localId: number}>, at: number}>}
 */
const tabLabelsByTab = new Map()
const MAX_LABEL_TABS = 20
const lastScrollByTab = new Map()
/** Upper bound for one click_at points burst (raised from 8 so a 19-point
 * whack-a-dot burst is one attach, one capture). */
const CLICK_AT_MAX_POINTS = 20
/** Scroll drift (CSS px) that makes a stored screenshot's coordinates stale. */
const STALE_SCROLL_THRESHOLD_PX = 40
/** Margin (CSS px) that still counts as "fully inside" the viewport. */
const SCROLL_VISIBLE_MARGIN_PX = 4
/** Click failure codes that mean the label list moved on; the retry hint applies. */
const STALE_LABEL_CODES = new Set(['DETACHED', 'NOT_VISIBLE', 'UNKNOWN_LABEL'])
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

/** Dispatch a trusted left click at CSS viewport coordinates. */
async function trustedClick(tabId, x, y) {
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
      registry.labels.set(globalId, { frameId: item.frameId, localId: label.id })
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

/** Remove overlays from every frame. */
async function clearAllFrames(tabId) {
  const frames = await listFrames(tabId)
  await Promise.all(frames.map(frame => runInFrame(tabId, frame.frameId, clearLabelsPage, [], 1_500).catch(() => {})))
}

/**
 * Collect title, URL, viewport, and document scroll information.
 * @returns {Record<string, any>}
 */
function pageMetrics() {
  const root = document.scrollingElement || document.documentElement
  const maxY = Math.max(0, root.scrollHeight - root.clientHeight)
  const maxX = Math.max(0, root.scrollWidth - root.clientWidth)
  const active = document.activeElement
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
 * Append a fresh label list to a stale-label BrowserError before it is logged
 * and forwarded, so the model can retry without paying a whole view round trip.
 * Fail-closed: it never re-resolves or auto-clicks anything, and it only appends
 * to the message — the original error code and message are preserved. Label
 * collection is best effort; a failure here leaves the original error untouched.
 * @param {chrome.tabs.Tab} tab
 * @param {BrowserError} error
 * @param {string} [preferText]
 */
async function decorateStaleLabelError(tab, error, preferText) {
  if (!error || !STALE_LABEL_CODES.has(error.code)) return error
  try {
    const labelled = await labelOnly(tab)
    const hint = formatLabelsHint(labelled.labels, { preferText })
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

/**
 * @param {number} windowId
 * @param {number} quality
 * @returns {Promise<{dataUrl: string, captureMs: number}>}
 */
async function captureVisibleTab(windowId, quality) {
  const run = async () => {
    const wait = Math.max(0, CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt))
    if (wait > 0) await sleep(wait)
    lastCaptureAt = Date.now()
    const started = performance.now()
    let dataUrl
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const quotaFailure = /quota|MAX_CAPTURE_VISIBLE_TAB/i.test(message)
      const transientFailure = /image readback failed|failed to capture tab/i.test(message)
      if (quotaFailure || transientFailure) {
        let retryError
        for (const delay of quotaFailure ? [650, 900] : [150, 400]) {
          await sleep(delay)
          lastCaptureAt = Date.now()
          try {
            dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality })
            retryError = undefined
            break
          } catch (error) {
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

  const tabAfter = await getActiveTab(windowId)
  if (tabAfter.id !== tab.id && !retried) return snapshot(detail, settings, true)

  const image = await compressDataUrl(captured.dataUrl, maxWidth, quality)
  const cssPerImagePixel = metrics.viewport.width / image.width
  const scroll = lastScrollFor(tab.id, metrics.url) ?? metrics.scroll
  lastViewByTab.set(tab.id, {
    image: { data: image.data, mimeType: image.mimeType, width: image.width, height: image.height },
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
 * identity, or we have been compact for a while. Scroll changes do not force a
 * full view (every DOM click centres its element); instead storeCompactView
 * invalidates the stale image when the page scrolls, so image-space clicks fail
 * with NO_VIEW rather than mapping from an old screenshot.
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
async function labelOnly(tab) {
  const started = performance.now()
  const labelled = await labelAllFrames(tab.id, LABEL_LIMIT, { paint: false })
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
 * Store a compact view: refresh labels/scroll/fingerprint, keep the previous
 * image only while the page has not scrolled (a scrolled screenshot is stale
 * for image-space coordinate mapping).
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
  const after = scrollFor(tab, metrics)
  stored.tab = { id: tab.id, title: metrics.title, url: metrics.url }
  stored.viewport = metrics.viewport
  stored.labels = labels
  stored.scroll = after
  stored.fingerprint = metrics.fingerprint
  stored.compactStreak = (stored.compactStreak ?? 0) + 1
  stored.at = Date.now()
  if (Math.abs((after?.y ?? 0) - (before?.y ?? 0)) > 40 || Math.abs((after?.x ?? 0) - (before?.x ?? 0)) > 40) {
    delete stored.image
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
  const baseChanged = options.changed === true
  const baseSignals = Array.isArray(options.signals) ? options.signals : []
  if (requested === 'none') {
    const metrics = await runInTab(tab.id, pageMetrics, [])
    let changed = baseChanged
    let signals = baseSignals
    if (typeof options.derive === 'function') {
      const derived = options.derive({ stored: lastViewByTab.get(tab.id), metrics, labels: undefined, delta: undefined }) ?? {}
      changed = derived.changed === true
      signals = Array.isArray(derived.signals) ? derived.signals : []
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
      },
    }
  }
  if (requested === 'full') {
    const shot = await snapshot('normal', settings)
    return { mode: 'full', payload: shot }
  }
  // compact or auto: one labels-only pass decides and feeds the delta
  const labelled = await labelOnly(tab)
  const stored = lastViewByTab.get(tab.id)
  if (requested === 'auto' && autoEscalate(stored, labelled.metrics)) {
    const shot = await snapshot('normal', settings)
    return { mode: 'full', payload: shot }
  }
  const delta = labelDelta(stored?.labels ?? [], labelled.labels)
  let changed = baseChanged
  let signals = baseSignals
  if (typeof options.derive === 'function') {
    const derived = options.derive({ stored, metrics: labelled.metrics, labels: labelled.labels, delta }) ?? {}
    changed = derived.changed === true
    signals = Array.isArray(derived.signals) ? derived.signals : []
  }
  const payload = compactPayload(tab, labelled.metrics, labelled.labels, labelled.labelMs, delta)
  payload.changed = changed
  payload.signals = signals
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
    const metrics = await runInTab(tab.id, pageMetrics, [])
    return {
      mode: 'none',
      payload: {
        view: 'none',
        screenshotSkipped: true,
        tab: tabSummary(tab, metrics),
        viewport: metrics.viewport,
        scroll: scrollFor(tab, metrics),
      },
    }
  }
  if (requested === 'full') {
    const shot = await snapshot('normal', settings)
    return { mode: 'full', payload: shot }
  }
  const labelled = await labelOnly(tab)
  const stored = lastViewByTab.get(tab.id)
  if (requested === 'auto' && autoEscalate(stored, labelled.metrics)) {
    const shot = await snapshot('normal', settings)
    return { mode: 'full', payload: shot }
  }
  const delta = labelDelta(stored?.labels ?? [], labelled.labels)
  const payload = compactPayload(tab, labelled.metrics, labelled.labels, labelled.labelMs, delta)
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
 * Read rendered page text without a screenshot. Runs inside the tab, so it must
 * not reference module state.
 * @param {'page'|'viewport'} scope
 * @param {number} offset
 * @param {number} maxChars
 */
function readPageText(scope, offset, maxChars) {
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
  const result = await runInTab(tab.id, readPageText, [scope, offset, maxChars])
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
 * Validate click_at arguments into a single burst request. A burst is either
 * one legacy `x`/`y` pair or a `points` array of 1..20 pairs, never both.
 * @param {Record<string, any>} args
 * @returns {{points: Array<{x: number, y: number}>, space: 'image'|'css', view: 'fresh'|'none', settleMs: number|undefined}}
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
    return { points, space, view, settleMs }
  }
  const x = Number(args.x)
  const y = Number(args.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new BrowserError('BAD_POINT', 'x and y must be finite numbers from the current view')
  }
  return { points: [{ x, y }], space, view, settleMs }
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
 * Click one or more points in the current view. Used for canvas/video/iframe
 * surfaces where no DOM label exists. Coordinates default to screenshot pixels;
 * `space: "css"` is direct viewport CSS. A burst clicks up to 20 points with one
 * debugger attach, one settle, and one capture; `view: "none"` skips the
 * capture entirely and reports changed: null. Points outside the viewport are
 * reported with offScreen:true and are never dispatched. Uses trusted browser
 * input when possible and verifies with a pixel diff, which is the only change
 * signal those surfaces produce.
 * @param {import('./protocol.js').Settings} settings
 * @param {Record<string, any>} args
 */
async function clickAt(settings, args) {
  const started = performance.now()
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const request = parseClickAtArgs(args)
  const before = lastViewByTab.get(tab.id)
  const viewport = before?.viewport ?? await runInTab(tab.id, pageMetrics, [])
  // Every image-space point shares the scale of the same previous view, so a
  // whole burst maps consistently instead of drifting point by point.
  if (request.space === 'image' && (!before?.image?.data || !Number.isFinite(before.image.width))) {
    throw new BrowserError('NO_VIEW', 'Take a screenshot first so image coordinates can be mapped to the page.')
  }
  const imageScale = request.space === 'image' ? viewport.width / before.image.width : 1
  // An off-screen coordinate used to be clamped to a viewport edge and clicked
  // silently, which is how a stale burst became a "frozen board". Off-screen
  // points are marked and skipped instead; on-screen points keep the clamp.
  const targets = mapClickPoints(request.points, request.space, viewport, imageScale)
  const onScreen = targets.filter(target => target.offScreen !== true)
  const offScreenCount = targets.length - onScreen.length

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
    // cheap changed signal for the batch item.
    const metrics = await runInTab(tab.id, pageMetrics, [])
    const derived = deriveFingerprintOutcome(lastViewByTab.get(tab.id), metrics)
    const staleScroll = staleScrollInfo(before?.scroll, metrics?.scroll)
    return {
      points,
      trusted,
      offScreenCount,
      changed: derived.changed,
      ...(staleScroll ? { staleScroll } : {}),
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
  const viewMode = parseViewArg(args, 'auto')
  const started = performance.now()
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const beforeUrl = tab.url ?? ''
  const __afterLookup = performance.now()
  const target = resolveLabelTarget(tab, label)
  if (!target) {
    throw await decorateStaleLabelError(
      tab,
      new BrowserError('UNKNOWN_LABEL', `Label ${label} is not in the current view. Take a fresh screenshot to get current labels.`),
    )
  }
  let result
  try {
    result = await runInFrame(tab.id, target.frameId, clickLabelled, [target.localId], 1_200)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    // A navigation can destroy the frame mid-dispatch; that is a successful click.
    const current = await chrome.tabs.get(tab.id).catch(() => undefined)
    const navigated = current !== undefined && (current.url ?? '') !== beforeUrl
    if (navigated || /frame.*(removed|gone)|cannot access contents|no frame|tab was closed/i.test(message)) {
      result = { ok: true, clicked: { label, tag: '', role: '', text: '' }, changed: true, signals: ['navigation'], navigated: true }
    } else if (code === 'SCRIPT_TIMEOUT') {
      throw new BrowserError('CLICK_TIMEOUT', 'The click did not complete. Take a fresh view before trying again.')
    } else {
      throw error
    }
  }
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
  return {
    ...payload,
    op: 'click',
    clicked: result.clicked,
    changed,
    signals: mode === 'full' ? signals : (Array.isArray(payload.signals) ? payload.signals : []),
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
  const target = resolveLabelTarget(tab, label)
  if (!target) throw new BrowserError('UNKNOWN_LABEL', `Label ${label} is not in the current view. Take a fresh screenshot.`)
  const hovered = await runInFrame(tab.id, target.frameId, hoverLabelled, [target.localId], 3_000)
  if (hovered?.ok === false) throw new BrowserError(hovered.code ?? 'HOVER_FAILED', hovered.message ?? 'Could not hover')
  await pauseInTab(tab.id, 80)
  if (batchDepth > 0) {
    const metrics = await runInTab(tab.id, pageMetrics, [])
    const derived = deriveFingerprintOutcome(lastViewByTab.get(tab.id), metrics)
    return { changed: derived.changed, signals: derived.signals, hovered: hovered.hovered }
  }
  const activeTab = await getActiveTab(windowId).catch(() => tab)
  const { payload } = await buildActionView(activeTab, settings, viewMode, {
    derive: ({ stored, metrics, delta }) => delta
      ? deriveLabelDeltaOutcome(delta)
      : deriveFingerprintOutcome(stored, metrics),
  })
  return { ...payload, op: 'hover', hovered: hovered.hovered }
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
  if (!target) throw new BrowserError('UNKNOWN_LABEL', `Label ${label} is not in the current view. Take a fresh screenshot.`)
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
 */
async function trustedTypeIntoFocus(tabId, request) {
  let before
  try {
    before = await runInTab(tabId, readFocusedField, [], 2_000)
  } catch {
    before = undefined
  }
  await withDebugger(tabId, () => chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: request.text }))
  await settleAfterInput(tabId, undefined)
  let after
  try {
    after = await runInTab(tabId, readFocusedField, [], 2_000)
  } catch {
    after = undefined
  }
  return {
    method: 'trusted',
    isPassword: before?.isPassword === true || after?.isPassword === true,
    beforeChars: before?.chars ?? 0,
    beforePreview: before?.preview ?? '',
    afterChars: after?.chars ?? 0,
    valuePreview: after?.preview ?? '',
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
  let outcome
  if (request.label !== undefined) {
    const target = resolveLabelTarget(tab, request.label)
    if (!target) throw new BrowserError('UNKNOWN_LABEL', `Label ${request.label} is not in the current view. Take a fresh screenshot.`)
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
        // Docs-style cards: the labelled surface is a div that wraps an editable
        // child. Focus that child and use trusted input.
        outcome = await trustedTypeIntoFallbackTarget(tab.id, target, request)
      } else {
        throw new BrowserError(domResult.code ?? 'TYPE_FAILED', domResult.message ?? 'Could not type into this field.')
      }
    } else {
      outcome = domResult.verified
        ? { method: 'dom', ...domResult }
        : await trustedTypeIntoLabel(tab.id, target, request, domResult)
    }
  } else {
    outcome = await trustedTypeIntoFocus(tab.id, request)
  }
  let submitted = false
  if (request.submit) {
    await pressEnter(tab.id)
    submitted = true
  }
  const beforeChars = outcome.beforeChars ?? 0
  const afterChars = outcome.afterChars ?? 0
  const beforePreview = outcome.beforePreview ?? ''
  const valuePreview = outcome.valuePreview ?? ''
  const changed = afterChars !== beforeChars || valuePreview !== beforePreview
  const signals = changed ? ['text-changed'] : []
  const typed = {
    ...(request.label === undefined ? {} : { label: request.label }),
    chars: request.text.length,
    mode: request.mode,
    submitted,
    method: outcome.method,
    beforeChars,
    afterChars,
    valuePreview,
  }
  if (batchDepth > 0) return { changed, signals, typed }
  const viewMode = parseViewArg(args, 'auto')
  const activeTab = await getActiveTab(windowId).catch(() => tab)
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
  const viewMode = parseViewArg(args, 'auto')
  const before = lastViewByTab.get(tab.id)
  const pressed = { key: request.key, modifiers: request.modifiers, trusted: true }
  try {
    await withDebugger(tab.id, () => dispatchTrustedKey(tab.id, request.spec, request.mask))
  } catch (error) {
    if (isDebuggerBusy(error)) throw error
    pressed.trusted = false
    await runInTab(tab.id, syntheticKeyPage, [request.spec.key, request.spec.code, request.spec.keyCode, request.mask], 2_000)
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
function parseWaitForArgs(args) {
  const conditions = {}
  if (args.text !== undefined) {
    if (typeof args.text !== 'string' || args.text.length === 0) {
      throw new BrowserError('BAD_WAIT', 'text must be a non-empty string')
    }
    conditions.text = args.text
  }
  if (args.url !== undefined) {
    if (typeof args.url !== 'string') throw new BrowserError('BAD_WAIT', 'url must be a string')
    conditions.url = args.url
  }
  if (args.idle === true) conditions.idle = true
  if (args.ms !== undefined) {
    const ms = Number(args.ms)
    if (!Number.isFinite(ms) || ms < 0 || ms > 30_000) {
      throw new BrowserError('BAD_WAIT', 'ms must be an integer from 0 to 30000')
    }
    conditions.ms = Math.round(ms)
  }
  if (Object.keys(conditions).length === 0) {
    throw new BrowserError('BAD_WAIT', 'wait_for needs at least one of text, url, idle, or ms')
  }
  let timeoutMs = 10_000
  if (args.timeout_ms !== undefined) {
    const value = Number(args.timeout_ms)
    if (!Number.isInteger(value) || value < 1_000 || value > 30_000) {
      throw new BrowserError('BAD_TIMEOUT', 'timeout_ms must be an integer from 1000 to 30000')
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
  return { from, to, space, view }
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
  const before = lastViewByTab.get(tab.id)
  const viewport = before?.viewport ?? await runInTab(tab.id, pageMetrics, [])
  // Image space maps through the stored view exactly like click_at.
  if (request.space === 'image' && (!before?.image?.data || !Number.isFinite(before.image.width))) {
    throw new BrowserError('NO_VIEW', 'Take a screenshot first so image coordinates can be mapped to the page.')
  }
  const scale = request.space === 'image' ? viewport.width / before.image.width : 1
  const cssPoint = point => ({
    x: Math.max(0, Math.min(viewport.width - 1, request.space === 'css' ? point.x : point.x * scale)),
    y: Math.max(0, Math.min(viewport.height - 1, request.space === 'css' ? point.y : point.y * scale)),
  })
  const fromCss = cssPoint(request.from)
  const toCss = cssPoint(request.to)
  try {
    await withDebugger(tab.id, () => trustedDrag(tab.id, fromCss.x, fromCss.y, toCss.x, toCss.y))
  } catch (error) {
    if (isDebuggerBusy(error)) throw error
    try {
      await runInTab(tab.id, syntheticDrag, [fromCss.x, fromCss.y, toCss.x, toCss.y], 2_000)
    } catch {
      // Fall through: the selection read below reports the real outcome.
    }
  }
  let selection
  try {
    selection = await runInTab(tab.id, readSelection, [], 2_000)
  } catch (error) {
    throw new BrowserError('SELECT_FAILED', `Could not read the selection: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = typeof selection?.text === 'string' ? selection.text : ''
  const chars = Number.isFinite(Number(selection?.chars)) ? Number(selection.chars) : text.length
  const selected = {
    chars,
    textPreview: text.slice(0, 200),
    collapsed: selection?.collapsed !== false,
    from: { space: request.space, x: request.from.x, y: request.from.y, cssX: Math.round(fromCss.x), cssY: Math.round(fromCss.y) },
    to: { space: request.space, x: request.to.x, y: request.to.y, cssX: Math.round(toCss.x), cssY: Math.round(toCss.y) },
  }
  const changed = chars > 0
  const signals = changed ? ['selection-changed'] : []
  if (batchDepth > 0) return { changed, signals, selected }
  const activeTab = await getActiveTab(windowId).catch(() => tab)
  const { payload } = await buildActionView(activeTab, settings, request.view, { changed, signals })
  return { ...payload, op: 'select', selected, changed, signals }
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
    if (!target) {
      throw new BrowserError('UNKNOWN_LABEL', `Label ${request.label} is not in the current view. Take a fresh screenshot to get current labels.`)
    }
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

const BATCH_OPS = new Set(['click', 'click_at', 'hover', 'select_option', 'type', 'press_key', 'scroll', 'wait_for', 'navigate', 'select'])
const BATCH_ACTION_FIELDS = [
  'changed', 'signals', 'clicked', 'hovered', 'selected', 'selectedIndex',
  'typed', 'pressed', 'points', 'trusted', 'changedCount', 'offScreenCount', 'clickMs',
  'scroll', 'moved', 'wheel', 'requestedPixels', 'container', 'waited', 'navigated',
  'staleScroll', 'scrolledIntoView',
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
  const requestedView = parseViewArg(args, 'full')
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
  const built = await buildBatchView(tab, settings, requestedView)
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