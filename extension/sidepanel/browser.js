/**
 * Chrome-side browser executor for Phase 1.
 *
 * Everything here runs in the side panel document. Page code is injected only
 * for the duration of one scroll or metrics call; no persistent content script
 * is installed.
 */

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
/** Most recent labelled view per tab, used for pixel-diff verification. */
const lastViewByTab = new Map()
/** Global label id -> owning frame for iframe-aware clicks. */
const labelFrames = new Map()
const lastScrollByTab = new Map()

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
async function labelAllFrames(tabId, limit) {
  const frames = await listFrames(tabId)
  const topIndex = frames.findIndex(frame => frame.frameId === 0)
  if (topIndex > 0) frames.unshift(frames.splice(topIndex, 1)[0])
  const outcomes = await Promise.all(frames.map(async frame => {
    const cap = frame.frameId === 0 ? limit : Math.min(40, limit)
    try {
      const result = await runInFrame(tabId, frame.frameId, labelPage, [cap], 2_000)
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
  labelFrames.clear()
  const labels = []
  for (const item of outcomes) {
    const data = item.result
    if (!data || data.__labelError) continue
    for (const label of data.labels) {
      const globalId = item.frameId === 0 ? label.id : item.frameId * 100_000 + label.id
      labelFrames.set(globalId, { frameId: item.frameId, localId: label.id })
      labels.push({ ...label, id: globalId, ...item.frameId === 0 ? {} : { frame: item.frameId } })
    }
  }
  return { metrics: top.result, labels }
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
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
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
 */
async function labelPage(limit) {
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
  // A timeout fallback keeps this progressing where rAF is throttled.
  await Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise(resolve => setTimeout(resolve, 60)),
  ])

  // Drop ids whose elements are gone so the map does not grow forever.
  if (state.byId.size > 800) {
    for (const [id, el] of state.byId) {
      if (!el.isConnected) state.byId.delete(id)
    }
  }

  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
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
  el.focus?.({ preventScroll: true })
  el.value = match.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 80))
  return {
    ok: true,
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

  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const __tScroll = performance.now()
  await Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise(resolve => setTimeout(resolve, 60)),
  ])

  const __tRaf = performance.now()
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) {
    return { ok: false, code: 'NOT_VISIBLE', message: `Label ${label} has no visible box. Take a fresh screenshot.` }
  }
  const vw = window.innerWidth
  const vh = window.innerHeight
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
    return { ok: true, clicked: { label, tag, role, text }, changed: true, signals: ['navigation-possible'], mutations: 0, pendingNavigation: true }
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
    timings: {
      resolveMs: Math.round(__tScroll - __t0),
      rafMs: Math.round(__tRaf - __tScroll),
      dispatchMs: Math.round(__tDispatch - __tRaf),
      observeMs: Math.round(performance.now() - __tDispatch),
    },
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
      if (/quota|MAX_CAPTURE_VISIBLE_TAB/i.test(message)) {
        let retryError
        for (const delay of [650, 900]) {
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
 * @param {'normal'|'high'} detail
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
  const quality = detail === 'high' ? 80 : Number(settings.quality) || 72
  const maxWidth = detail === 'high' ? 2048 : Number(settings.captureWidth) || 1280
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
    at: Date.now(),
  })
  if (lastViewByTab.size > 20) {
    const oldest = lastViewByTab.keys().next().value
    if (oldest !== undefined) lastViewByTab.delete(oldest)
  }
  return {
    op: 'snapshot',
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
  const shot = await snapshot('normal', settings)
  const scroll = wheelUsed ? shot.scroll : scrollInfo.scroll
  const moved = wheelUsed
    ? { dx: Math.round(scroll.x - beforeX), dy: Math.round(scroll.y - beforeY) }
    : scrollInfo.moved
  lastScrollByTab.set(tab.id, { at: Date.now(), url: shot.tab.url, scroll })
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
 * matching behavior is testable without Chrome.
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
  return best === undefined ? undefined : { tab: best.tab, score: best.score, matchCount: scored.length }
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
 * one legacy `x`/`y` pair or a `points` array of 1..8 pairs, never both.
 * @param {Record<string, any>} args
 * @returns {{points: Array<{x: number, y: number}>, space: 'image'|'css', view: 'fresh'|'none', settleMs: number|undefined}}
 */
function parseClickAtArgs(args) {
  const hasPoints = args.points !== undefined
  const hasCoordinates = args.x !== undefined || args.y !== undefined
  if (hasPoints && hasCoordinates) {
    throw new BrowserError('BAD_POINTS', 'Provide either x/y or points for click_at, not both.')
  }
  if (!hasPoints && !hasCoordinates) {
    throw new BrowserError('BAD_POINTS', 'click_at requires x/y or a points array.')
  }
  const space = args.space === 'css' ? 'css' : 'image'
  const view = args.view === 'none' ? 'none' : 'fresh'
  const settleMs = parseSettleMs(args.settle_ms)
  if (hasPoints) {
    if (!Array.isArray(args.points) || args.points.length === 0 || args.points.length > 8) {
      throw new BrowserError('BAD_POINTS', 'points must be an array of 1 to 8 {x, y} coordinate objects.')
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
 * Click one or more points in the current view. Used for canvas/video/iframe
 * surfaces where no DOM label exists. Coordinates default to screenshot pixels;
 * `space: "css"` is direct viewport CSS. A burst clicks up to 8 points with one
 * debugger attach, one settle, and one capture; `view: "none"` skips the
 * capture entirely and reports changed: null. Uses trusted browser input when
 * possible and verifies with a pixel diff, which is the only change signal
 * those surfaces produce.
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
  const targets = request.points.map(point => ({
    space: request.space,
    x: point.x,
    y: point.y,
    cssX: Math.max(0, Math.min(viewport.width - 1, request.space === 'css' ? point.x : point.x * imageScale)),
    cssY: Math.max(0, Math.min(viewport.height - 1, request.space === 'css' ? point.y : point.y * imageScale)),
  }))

  let trusted = true
  try {
    // One attach for the whole burst: the debugger handshake is not paid per point.
    await withDebugger(tab.id, async () => {
      for (const target of targets) await trustedClick(tab.id, target.cssX, target.cssY)
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'DEBUGGER_BUSY') throw error
    trusted = false
    const dispatched = await runInTab(tab.id, syntheticClickBurst, [targets.map(target => ({ x: target.cssX, y: target.cssY }))], 4_000)
    if (!Array.isArray(dispatched) || !dispatched.some(Boolean)) {
      throw new BrowserError('CLICK_POINT_EMPTY', 'There is no element at that point.')
    }
  }

  let shot
  let diffs = targets.map(() => ({ changed: false, percent: 0, mean: 0 }))
  if (request.view === 'none') {
    // No screenshot: a cheap page-metrics read keeps tab/viewport/scroll in the
    // snapshot shape without paying capture or label cost.
    const metrics = await runInTab(tab.id, pageMetrics, [])
    shot = {
      tab: {
        id: tab.id,
        title: metrics.title || tab.title || '',
        url: metrics.url || tab.url || '',
        windowId,
        status: tab.status ?? 'unknown',
      },
      viewport: metrics.viewport,
      scroll: lastScrollFor(tab.id, metrics.url) ?? metrics.scroll,
      labelCount: 0,
      labelMs: 0,
      captureMs: 0,
      encodeMs: 0,
      totalMs: Math.round(performance.now() - started),
    }
  } else {
    await settleAfterInput(tab.id, request.settleMs)
    shot = await snapshot('normal', settings)
    diffs = await Promise.all(targets.map(target => diffRegion(before, shot, target.cssX, target.cssY, 120)))
    // A canvas frame can occasionally miss the first capture; retry once
    // before reporting no change. Never more than two captures per burst.
    if (diffs.every(diff => !diff.changed) && before?.image?.data) {
      await pauseInTab(tab.id, 120)
      shot = await snapshot('normal', settings)
      diffs = await Promise.all(targets.map(target => diffRegion(before, shot, target.cssX, target.cssY, 120)))
    }
  }

  const skipChange = request.view === 'none'
  const points = targets.map((target, index) => ({
    space: target.space,
    x: target.x,
    y: target.y,
    cssX: Math.round(target.cssX),
    cssY: Math.round(target.cssY),
    changed: skipChange ? null : diffs[index].changed,
    pixelsChanged: skipChange ? null : diffs[index].percent,
    pixelMean: skipChange ? null : diffs[index].mean,
  }))
  const result = {
    ...shot,
    op: 'click_at',
    points,
    trusted,
    changedCount: points.filter(point => point.changed === true).length,
    clickMs: Math.round(performance.now() - started),
  }
  if (skipChange) {
    result.view = 'none'
    result.screenshotSkipped = true
  }
  if (points.length === 1) {
    // Legacy single-point shape: existing consumers read point/changed directly.
    result.point = { space: points[0].space, x: points[0].x, y: points[0].y, cssX: points[0].cssX, cssY: points[0].cssY }
    result.changed = points[0].changed
    result.pixelsChanged = points[0].pixelsChanged
    result.pixelMean = points[0].pixelMean
    result.signals = points[0].changed === true ? ['pixels-changed'] : []
  }
  return result
}

/**
 * Click a labelled element and return the resulting view.
 * @param {import('./protocol.js').Settings} settings
 * @param {number} label
 */
async function click(settings, label) {
  const id = Number(label)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BrowserError('BAD_LABEL', 'label must be a positive integer shown on the current view')
  }
  const started = performance.now()
  const windowId = await getWindowId()
  const tab = await getActiveTab(windowId)
  assertCapturable(tab)
  const beforeUrl = tab.url ?? ''
  const __afterLookup = performance.now()
  const target = labelFrames.get(id)
  if (!target) throw new BrowserError('UNKNOWN_LABEL', `Label ${id} is not in the current view. Take a fresh screenshot to get current labels.`)
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
      result = { ok: true, clicked: { label: id, tag: '', role: '', text: '' }, changed: true, signals: ['navigation'], navigated: true }
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
    throw error
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
  const shot = await snapshot('normal', settings)
  const __afterSnapshot = performance.now()
  const navigated = shot.tab.url !== beforeUrl
  const pendingNavigation = result.pendingNavigation === true
  const changed = pendingNavigation
    ? navigated || (shot.tab.title ?? '') !== (tab.title ?? '')
    : result.changed === true
  return {
    ...shot,
    op: 'click',
    clicked: result.clicked,
    changed,
    signals: Array.isArray(result.signals) ? result.signals : [],
    navigated,
    clickMs: Math.round(performance.now() - started),
    clickTimings: {
      ...result.timings,
      lookupMs: Math.round(__afterLookup - started),
      runTabMs: Math.round(__afterClick - __afterLookup),
      sleepMs: Math.round(__afterTabGet - __afterClick),
      waitMs: Math.round(__afterWait - __afterTabGet),
      snapshotMs: Math.round(__afterSnapshot - __afterWait),
      tabStatus: current?.status,
    },
  }
}

export { labelPage as labelElements, clickLabelled as clickElementByLabel }

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
    const detail = args.detail === 'high' ? 'high' : 'normal'
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
    return click(normalized, args.label)
  }
  if (op === 'click_at') {
    return clickAt(normalized, args)
  }
  if (op === 'select_option') {
    const windowId = await getWindowId()
    const tab = await getActiveTab(windowId)
    assertCapturable(tab)
    const selectTarget = labelFrames.get(Number(args.label))
    if (!selectTarget) throw new BrowserError('UNKNOWN_LABEL', `Label ${args.label} is not in the current view. Take a fresh screenshot.`)
    const picked = await runInFrame(tab.id, selectTarget.frameId, selectOption, [selectTarget.localId, String(args.option ?? '')], 3_000)
    if (picked?.ok === false) throw new BrowserError(picked.code ?? 'SELECT_FAILED', picked.message ?? 'Could not select the option')
    await pauseInTab(tab.id, 90)
    const shot = await snapshot('normal', normalized)
    return { ...shot, op: 'select_option', selected: picked.selected, selectedIndex: picked.selectedIndex }
  }
  if (op === 'hover') {
    const windowId = await getWindowId()
    const tab = await getActiveTab(windowId)
    assertCapturable(tab)
    const hoverTarget = labelFrames.get(Number(args.label))
    if (!hoverTarget) throw new BrowserError('UNKNOWN_LABEL', `Label ${args.label} is not in the current view. Take a fresh screenshot.`)
    const hovered = await runInFrame(tab.id, hoverTarget.frameId, hoverLabelled, [hoverTarget.localId], 3_000)
    if (hovered?.ok === false) throw new BrowserError(hovered.code ?? 'HOVER_FAILED', hovered.message ?? 'Could not hover')
    await pauseInTab(tab.id, 80)
    const shot = await snapshot('normal', normalized)
    return { ...shot, op: 'hover', hovered: hovered.hovered }
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