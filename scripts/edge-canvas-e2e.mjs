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
  await new Promise(resolve => setTimeout(resolve, 800))
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

console.log('\nALL CANVAS CHECKS PASSED')
panel.close()
