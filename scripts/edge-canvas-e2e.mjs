#!/usr/bin/env node
/** Canvas coordinate clicking, trusted-input, pixel-diff, and wheel scroll checks. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9230'
const extensionId = (() => {
  const hex = createHash('sha256').update(join(process.cwd(), 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()
const list = async () => (await fetch(`${CDP}/json`)).json()

async function connect(url) {
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let seq = 0
  const pending = new Map()
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    }
  })
  return {
    send(method, params = {}) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { ws.close() },
  }
}

const targets = await list()
let panelTarget = targets.find(target => target.type === 'page' && target.url.includes('/sidepanel/index.html'))
if (!panelTarget) {
  const version = await (await fetch(`${CDP}/json/version`)).json()
  const browser = await connect(version.webSocketDebuggerUrl)
  const created = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
  await new Promise(resolve => setTimeout(resolve, 900))
  panelTarget = (await list()).find(target => target.id === created.targetId)
  browser.close()
}
assert.ok(panelTarget, 'side panel target not found')
const panel = await connect(panelTarget.webSocketDebuggerUrl)
await panel.send('Runtime.enable')
async function evaluate(expression) {
  const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

const prefix = `const mod = await import('./browser.js')
  const tabs = await chrome.tabs.query({})
  const tab = tabs.find(item => item.url?.includes('canvas.html'))
  const settings = { ...mod.DEFAULT_SETTINGS }
  const read = async id => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: id => document.getElementById(id).textContent, args: [id] }))[0].result
  const rect = async id => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }, args: [id] }))[0].result
`
const view = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.tabs.update(tab.id, { url: 'http://127.0.0.1:17872/canvas.html' })
  await chrome.tabs.reload(tab.id, { bypassCache: true })
  await new Promise(resolve => setTimeout(resolve, 800))
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollTo(0, 0) })
  const snapshot = await mod.execute('snapshot', {}, settings)
  return {
    surfaces: snapshot.surfaces,
    labels: snapshot.labels.map(label => label.text),
    image: { width: snapshot.image.width, height: snapshot.image.height },
    viewport: snapshot.viewport,
    canvas: await rect('board'),
    state: await read('state'),
  }
})()`)
assert.ok(view.surfaces.some(surface => surface.kind === 'canvas'), 'snapshot reports the canvas surface')
assert.ok(view.labels.includes('DOM button'), 'DOM controls are still labelled next to the canvas')
console.log('PASS canvas surface is reported and DOM labels coexist')

const center = { x: view.canvas.x + view.canvas.w / 2, y: view.canvas.y + view.canvas.h / 2 }
const cssClick = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('click_at', { space: 'css', x: ${center.x}, y: ${center.y} }, settings)
  return { trusted: result.trusted, changed: result.changed, pixelsChanged: result.pixelsChanged, trustedCount: await read('state') }
})()`)
assert.equal(cssClick.trusted, true, 'coordinate click uses trusted input')
assert.equal(cssClick.changed, true, 'coordinate click detects a visual change')
assert.ok(cssClick.pixelsChanged > 0, 'pixel diff reports changed pixels')
assert.match(cssClick.trustedCount, /^trusted 1 · synthetic 0/, 'canvas saw one trusted click and no synthetic click')
console.log(`PASS trusted canvas click — ${cssClick.pixelsChanged}% pixels changed`)

const imagePoint = {
  x: (center.x + 90) * (view.image.width / view.viewport.width),
  y: (center.y + 40) * (view.image.width / view.viewport.width),
}
const imageClick = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('click_at', { x: ${imagePoint.x}, y: ${imagePoint.y} }, settings)
  return { changed: result.changed, pixelsChanged: result.pixelsChanged, point: result.point, trustedCount: await read('state') }
})()`)
assert.equal(imageClick.changed, true, 'image-space click maps to the same canvas point')
assert.match(imageClick.trustedCount, /^trusted 2 · synthetic 0/)
console.log('PASS image-pixel coordinates map correctly')

const wheel = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('scroll', { direction: 'down', amount_px: 160 }, settings)
  return { wheel: result.wheel, moved: result.moved, state: await read('state') }
})()`)
assert.equal(wheel.wheel, true, 'canvas scroll falls back to a trusted wheel')
assert.match(wheel.state, /offset 160/, 'canvas received the wheel delta')
console.log('PASS canvas wheel fallback')

const noopPoint = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('click_at', { space: 'css', x: 5, y: 5 }, settings)
  return { changed: result.changed, pixelsChanged: result.pixelsChanged }
})()`)
assert.equal(noopPoint.changed, false, 'click on empty canvas margin reports no change')
console.log('PASS empty-area click reports no change')

const trustedCount = state => Number(/trusted (\d+)/.exec(String(state ?? ''))?.[1]) || 0

const burstPoints = [
  { x: center.x, y: center.y },
  { x: center.x - 160, y: center.y - 80 },
  { x: center.x + 160, y: center.y - 80 },
  { x: center.x - 160, y: center.y + 80 },
  { x: center.x + 160, y: center.y + 80 },
]
const burst = await evaluate(`(async () => { ${prefix}
  const stateBefore = await read('state')
  const result = await mod.execute('click_at', { points: ${JSON.stringify(burstPoints)}, space: 'css' }, settings)
  return {
    trusted: result.trusted,
    pointCount: result.points?.length,
    changedCount: result.changedCount,
    changed: result.points?.map(point => point.changed),
    image: result.image ? { width: result.image.width, height: result.image.height, hasData: typeof result.image.data === 'string' } : null,
    labelCount: Array.isArray(result.labels) ? result.labels.length : null,
    surfaceCount: Array.isArray(result.surfaces) ? result.surfaces.length : null,
    stateBefore,
    stateAfter: await read('state'),
  }
})()`)
assert.equal(burst.trusted, true, 'burst uses trusted input')
assert.equal(burst.pointCount, 5, 'burst reports all five points')
assert.ok(burst.changedCount >= 1, 'burst detects canvas changes')
assert.ok(burst.image?.hasData && burst.image.width > 0, 'burst returns one labelled image')
assert.ok(burst.labelCount > 0, 'burst result keeps the snapshot labels')
assert.ok(burst.surfaceCount > 0, 'burst result keeps the snapshot surfaces')
assert.equal(
  trustedCount(burst.stateAfter) - trustedCount(burst.stateBefore),
  5,
  'canvas saw five trusted clicks in one burst',
)
console.log(`PASS 5-point CSS burst — one capture, ${burst.changedCount}/5 points changed, +5 trusted clicks`)

const nonePoints = [
  { x: center.x + 60, y: center.y },
  { x: center.x, y: center.y + 120 },
  { x: center.x - 60, y: center.y - 120 },
]
const noneBurst = await evaluate(`(async () => { ${prefix}
  const stateBefore = await read('state')
  const result = await mod.execute('click_at', { points: ${JSON.stringify(nonePoints)}, space: 'css', view: 'none' }, settings)
  return {
    trusted: result.trusted,
    pointCount: result.points?.length,
    view: result.view,
    screenshotSkipped: result.screenshotSkipped,
    hasImage: result.image !== undefined,
    hasLabels: result.labels !== undefined,
    hasSurfaces: result.surfaces !== undefined,
    changedValues: result.points?.map(point => point.changed),
    changedCount: result.changedCount,
    stateBefore,
    stateAfter: await read('state'),
  }
})()`)
assert.equal(noneBurst.trusted, true, 'view:none burst still uses trusted input')
assert.equal(noneBurst.pointCount, 3, 'view:none burst reports all points')
assert.equal(noneBurst.view, 'none', 'view:none is reported')
assert.equal(noneBurst.screenshotSkipped, true, 'view:none reports screenshotSkipped')
assert.equal(noneBurst.hasImage, false, 'view:none omits the image')
assert.equal(noneBurst.hasLabels, false, 'view:none omits labels')
assert.equal(noneBurst.hasSurfaces, false, 'view:none omits surfaces')
assert.ok(noneBurst.changedValues.every(value => value === null), 'view:none cannot report pixel changes')
assert.equal(noneBurst.changedCount, 0, 'view:none reports a numeric changedCount')
assert.equal(
  trustedCount(noneBurst.stateAfter) - trustedCount(noneBurst.stateBefore),
  3,
  'view:none burst still reaches the page',
)
console.log('PASS view:none burst — no screenshot, +3 trusted clicks')

const delayed = await evaluate(`(async () => { ${prefix}
  const started = performance.now()
  const result = await mod.execute('snapshot', { delay_ms: 300 }, settings)
  return {
    op: result.op,
    totalMs: result.totalMs,
    wallMs: Math.round(performance.now() - started),
    hasImage: typeof result.image?.data === 'string',
    width: result.image?.width,
  }
})()`)
assert.equal(delayed.op, 'snapshot', 'delay_ms keeps the snapshot op')
assert.ok(delayed.totalMs >= 300, `snapshot delay_ms waits in the page (totalMs ${delayed.totalMs})`)
assert.ok(delayed.wallMs >= 300, `snapshot delay_ms is in the call wall time (${delayed.wallMs}ms)`)
assert.ok(delayed.hasImage && delayed.width > 0, 'delayed snapshot still returns the image')
console.log(`PASS snapshot delay_ms:300 — totalMs ${delayed.totalMs}, image ${delayed.width}px`)

const legacyPoint = { x: center.x + 40, y: center.y - 40 }
const legacy = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('click_at', { space: 'css', x: ${legacyPoint.x}, y: ${legacyPoint.y} }, settings)
  return {
    trusted: result.trusted,
    pointCount: result.points?.length,
    point: result.point,
    changed: result.changed,
    pixelsChanged: result.pixelsChanged,
    pixelMean: result.pixelMean,
    signals: result.signals,
    changedCount: result.changedCount,
    hasImage: typeof result.image?.data === 'string',
  }
})()`)
assert.equal(legacy.pointCount, 1, 'single click reports one point')
assert.equal(legacy.point?.space, 'css', 'legacy point keeps its coordinate space')
assert.ok(
  Math.abs(legacy.point.x - legacyPoint.x) < 0.01 && Math.abs(legacy.point.y - legacyPoint.y) < 0.01,
  'legacy point echoes the requested coordinates',
)
assert.ok(Number.isInteger(legacy.point.cssX) && Number.isInteger(legacy.point.cssY), 'legacy point reports integer CSS coordinates')
assert.equal(typeof legacy.changed, 'boolean', 'legacy result keeps changed')
assert.equal(typeof legacy.pixelsChanged, 'number', 'legacy result keeps pixelsChanged')
assert.equal(typeof legacy.pixelMean, 'number', 'legacy result keeps pixelMean')
assert.ok(Array.isArray(legacy.signals), 'legacy result keeps signals')
assert.equal(legacy.changedCount, legacy.changed ? 1 : 0, 'changedCount matches the single point')
assert.equal(legacy.trusted, true, 'single-point click stays trusted')
assert.ok(legacy.hasImage, 'single-point click still returns the image')
console.log(`PASS single-point legacy fields — changed=${legacy.changed}, ${legacy.pixelsChanged}% pixels`)

const editorBox = await evaluate(`(async () => { ${prefix} return await rect('editor') })()`)
const editorClick = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('click_at', {
    space: 'css', x: ${editorBox.x + 36}, y: ${editorBox.y + 44}, view: 'full',
  }, settings)
  return { trusted: result.trusted, changed: result.changed, state: await read('editor-state') }
})()`)
assert.equal(editorClick.trusted, true, 'canvas editor is focused by trusted coordinate input')
assert.equal(editorClick.changed, true, 'focusing the canvas editor visibly changes its frame')
assert.equal(editorClick.state, 'Ready: ', 'focusing does not change editor content')
console.log('PASS canvas editor receives trusted focus')

const canvasType = await evaluate(`(async () => { ${prefix}
  const before = await read('editor-state')
  const result = await mod.execute('type', { text: 'Canvas edit exactly once.', view: 'full' }, settings)
  const after = await read('editor-state')
  return {
    before,
    after,
    changed: result.changed,
    typed: result.typed,
    view: result.view,
    hasImage: typeof result.image?.data === 'string',
  }
})()`)
assert.equal(canvasType.before, 'Ready: ')
assert.equal(canvasType.after, 'Ready: Canvas edit exactly once.', 'trusted text reaches the canvas model exactly once')
assert.equal(canvasType.after.split('Canvas edit exactly once.').length - 1, 1, 'no duplicate insertion')
assert.equal(canvasType.changed, null, 'DOM mutations cannot prove a canvas document edit')
assert.equal(canvasType.typed.canvasEditor, true)
assert.equal(canvasType.typed.measured, 'none')
assert.equal(canvasType.typed.charsAdded, null, 'no fabricated page-level character measurement')
assert.equal(canvasType.typed.dispatched, true)
assert.equal(canvasType.typed.verified, false)
assert.equal(canvasType.typed.delivered, undefined, 'never claim delivery from a DOM hint')
assert.equal(canvasType.view, 'full', 'the caller receives a fresh visual confirmation')
assert.equal(canvasType.hasImage, true)
console.log('PASS canvas typing lands exactly once and stays explicitly UNVERIFIED')

console.log('\nALL CANVAS CHECKS PASSED')
panel.close()
