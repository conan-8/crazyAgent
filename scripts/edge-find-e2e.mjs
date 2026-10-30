#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9233'
const BASE = process.env.FIXTURE_URL ?? 'http://127.0.0.1:17872'
const extensionId = (() => {
  const hex = createHash('sha256').update(join(process.cwd(), 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()
const list = async () => (await fetch(`${CDP}/json`)).json()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function connect(url) {
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let seq = 0
  const pending = new Map()
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
    if (!message.id || !pending.has(message.id)) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
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
  await sleep(900)
  panelTarget = (await list()).find(target => target.id === created.targetId)
  browser.close()
}
assert.ok(panelTarget, 'side panel target not found')
const panel = await connect(panelTarget.webSocketDebuggerUrl)
await panel.send('Page.enable')
await panel.send('Page.reload', { ignoreCache: true })
await sleep(1_000)
await panel.send('Runtime.enable')
async function evaluate(expression) {
  const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

const fixture = await evaluate(`(async () => {
  const tabs = await chrome.tabs.query({})
  let tab = tabs.find(item => item.url?.includes('/find.html'))
  if (!tab) tab = await chrome.tabs.create({ url: '${BASE}/find.html', active: true })
  else await chrome.tabs.update(tab.id, { active: true, url: '${BASE}/find.html' })
  await new Promise(resolve => setTimeout(resolve, 900))
  return { id: tab.id }
})()`)
assert.ok(fixture?.id, 'fixture tab id')
const tabId = fixture.id
const prefix = `const mod = await import('./browser.js')
  const tabId = ${tabId}
  const settings = { ...mod.DEFAULT_SETTINGS }
  const page = async func => (await chrome.scripting.executeScript({ target: { tabId }, func }))[0].result
  const state = async () => page(() => ({
    scrollY: window.scrollY,
    activeId: document.activeElement?.id ?? '',
    selection: window.getSelection()?.toString() ?? '',
    value: document.getElementById('focus-field')?.value,
    clicks: document.getElementById('click-count')?.textContent,
    targetRect: (() => { const rect = document.getElementById('destination').getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom } })(),
  }))
  const preserveSelection = async () => page(() => {
    const input = document.getElementById('focus-field')
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('selection'))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
`

await evaluate(`(async () => { ${prefix}
  await page(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await preserveSelection()
})()`)
const initial = await evaluate(`(async () => { ${prefix}
  const auto = await mod.execute('auto_view', {}, settings)
  const overlays = await page(() => document.querySelectorAll('#__crazyagent_label_overlay').length)
  const view = await mod.execute('snapshot', {}, settings)
  return { auto, overlays, viewId: view.viewId, labels: view.labels, state: await state(), html: await page(() => document.body.innerHTML) }
})()`)
assert.equal(initial.auto.op, 'auto_view')
assert.equal(initial.auto.image, undefined, 'ordinary auto-view is DOM-first without an image')
assert.match(initial.auto.text, /Semantic find fixture/)
assert.ok(initial.auto.labels.length > 0, 'ordinary auto-view retains clickable labels')
assert.equal(initial.auto.capture.reason, 'DOM_FIRST_AUTO_VIEW')
assert.equal(initial.overlays, 0, 'DOM-first auto-view cleans up label overlays')
assert.ok(initial.viewId > 0)
assert.equal(initial.state.activeId, 'focus-field')
assert.equal(initial.state.selection, 'Preserve this exact selection during semantic find.')
console.log('PASS ordinary auto-view uses DOM text + labels, no image, and no leftover overlay')

const inline = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('find', { query: 'silver key' }, settings)
  return { result, state: await state(), html: await page(() => document.body.innerHTML) }
})()`)
assert.equal(inline.result.find.matchCount, 1)
assert.match(inline.result.matches[0].snippet, /silver key/)
assert.equal(inline.result.view, 'none')
assert.equal(inline.result.image, undefined)
assert.equal(inline.state.scrollY, 0)
assert.equal(inline.state.activeId, 'focus-field')
assert.equal(inline.state.selection, initial.state.selection)
assert.equal(inline.html, initial.html, 'search does not mutate page HTML')
console.log('PASS text-only find matches across inline elements without DOM mutation')

const exclusions = await evaluate(`(async () => { ${prefix}
  const hidden = await mod.execute('find', { query: 'HIDDEN-FIND-NEEDLE' }, settings)
  const aria = await mod.execute('find', { query: 'ARIA-HIDDEN-FIND-NEEDLE' }, settings)
  const password = await mod.execute('find', { query: 'PASSWORD-FIND-SECRET' }, settings)
  const control = await mod.execute('find', { query: 'CONTROL-VALUE-NEEDLE' }, settings)
  const label = await mod.execute('find', { query: 'Find control label' }, settings)
  return { hidden, aria, password, control, label }
})()`)
assert.equal(exclusions.hidden.find.matchCount, 0)
assert.equal(exclusions.aria.find.matchCount, 0)
assert.equal(exclusions.password.find.matchCount, 0)
assert.equal(exclusions.password.matches.length, 0, 'a password value produces no result or snippet')
assert.equal(exclusions.control.find.matchCount, 1)
assert.equal(exclusions.control.matches[0].source, 'value')
assert.equal(exclusions.label.find.matchCount, 1)
assert.equal(exclusions.label.matches[0].source, 'accessible-name')
assert.ok(exclusions.label.matches[0].label > 0, 'an already-labelled control keeps its click label')
console.log('PASS hidden/password exclusion plus control values and accessible labels')

const structures = await evaluate(`(async () => { ${prefix}
  const shadow = await mod.execute('find', { query: 'SHADOW-FIND-MARKER' }, settings)
  const frame = await mod.execute('find', { query: 'Frame action' }, settings)
  const second = await mod.execute('find', { query: 'Duplicate needle', occurrence: 2 }, settings)
  return { shadow, frame, second }
})()`)
assert.equal(structures.shadow.find.matchCount, 1)
assert.equal(structures.shadow.matches[0].tag, 'button')
assert.equal(structures.frame.find.matchCount, 1)
assert.ok(structures.frame.matches[0].frame > 0)
assert.equal(structures.second.find.occurrence, 2)
assert.match(structures.second.matches[0].snippet, /second/)
console.log('PASS open shadow root, iframe, and explicit occurrence discovery')

const ambiguous = await evaluate(`(async () => { ${prefix}
  const before = await state()
  let error
  try { await mod.execute('find', { query: 'Duplicate needle', reveal: true }, settings) } catch (caught) { error = { code: caught.code, message: caught.message } }
  return { error, after: await state() }
})()`)
assert.equal(ambiguous.error?.code, 'FIND_AMBIGUOUS')
assert.equal(ambiguous.after.scrollY, ambiguous.before?.scrollY ?? 0)
assert.equal(ambiguous.after.scrollY, 0)
console.log('PASS ambiguous reveal fails before scrolling')

const reveal = await evaluate(`(async () => { ${prefix}
  await preserveSelection()
  const result = await mod.execute('find', { query: 'UNIQUE-FIND-MARKER', reveal: true }, settings)
  let staleError
  try { await mod.execute('click_at', { x: 10, y: 10, view_id: ${initial.viewId}, view: 'none' }, settings) } catch (caught) { staleError = { code: caught.code, message: caught.message } }
  return { result, state: await state(), staleError }
})()`)
assert.equal(reveal.result.find.revealed, true)
assert.equal(reveal.result.find.matchCount, 1)
assert.equal(reveal.result.reveal.inViewport, true)
assert.equal(reveal.result.matches[0].inViewport, true, 'match metadata reflects post-reveal visibility')
assert.equal(reveal.result.view, 'full')
assert.ok(reveal.result.image?.width > 0)
assert.ok(reveal.state.scrollY > 500, 'reveal independently moved the page to the destination')
assert.ok(reveal.state.targetRect.top >= 0 && reveal.state.targetRect.top < 720, 'destination is independently in the viewport')
assert.equal(reveal.state.activeId, 'focus-field', 'reveal preserves focus')
assert.equal(reveal.state.selection, initial.state.selection, 'reveal preserves the selection')
assert.equal(reveal.state.value, 'preserve this value', 'reveal preserves field content')
assert.equal(reveal.state.clicks, 'clicks 0', 'reveal dispatches no click')
assert.equal(reveal.staleError?.code, 'NO_VIEW', 'reveal invalidates the previous coordinate basis')
console.log('PASS reveal scrolls only, preserves user state, returns a fresh view, and rejects old coordinates')

const canvas = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { active: true, url: '${BASE}/canvas.html' })
  await new Promise(resolve => setTimeout(resolve, 700))
  const result = await mod.execute('auto_view', {}, settings)
  return { op: result.op, view: result.view, image: result.image, labels: result.labels, text: result.text }
})()`)
assert.equal(canvas.op, 'snapshot', 'canvas auto-view falls back to a screenshot')
assert.equal(canvas.view, 'full')
assert.ok(canvas.image?.width > 0)
assert.ok(canvas.labels.length > 0, 'canvas fallback retains ARIA labels')
assert.equal(canvas.text, undefined, 'canvas fallback does not present unreliable DOM text')
console.log('PASS canvas auto-view retains a full labelled screenshot')

console.log('\nALL FIND AND AUTO-VIEW CHECKS PASSED')
panel.close()
