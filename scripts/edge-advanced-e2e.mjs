#!/usr/bin/env node
/** Shadow DOM, iframe, native select, and hover checks against the real extension. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9231'
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
const panel = await connect(panelTarget.webSocketDebuggerUrl)
await panel.send('Runtime.enable')
async function evaluate(expression) {
  const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

const prefix = `const mod = await import('./browser.js')
  const tabs = await chrome.tabs.query({})
  const tab = tabs.find(item => item.url?.includes('advanced.html'))
  const settings = { ...mod.DEFAULT_SETTINGS }
  const frameStates = async () => (await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => document.getElementById('inner-state')?.textContent ?? null })).map(r => ({ frameId: r.frameId, state: r.result }))
`

const view = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.tabs.update(tab.id, { url: 'http://127.0.0.1:17872/advanced.html' })
  await new Promise(resolve => setTimeout(resolve, 1000))
  const snapshot = await mod.execute('snapshot', {}, settings)
  const byText = text => snapshot.labels.find(label => label.text === text)
  return {
    labels: snapshot.labels.map(label => ({ id: label.id, text: label.text, frame: label.frame ?? 0, role: label.role })),
    shadow: Boolean(byText('Shadow action')),
    select: snapshot.labels.find(label => label.role === 'combobox')?.id,
    menu: byText('Menu')?.id,
    frames: snapshot.labels.filter(label => label.frame).length,
    surfaces: snapshot.surfaces,
    states: await frameStates(),
  }
})()`)
assert.equal(view.shadow, true, 'shadow DOM control is labelled')
assert.ok(view.frames >= 2, `iframe controls are labelled (${view.frames})`)
assert.ok(view.surfaces.some(surface => surface.kind === 'iframe'), 'iframe surfaces are reported')
console.log('PASS shadow DOM and iframe labels')

const shadowId = view.labels.find(label => label.text === 'Shadow action').id
const shadow = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('click', { label: ${shadowId} }, settings)
  const state = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.querySelector('my-widget').shadowRoot.getElementById('shadow-state').textContent }))[0].result
  return { changed: result.changed, state }
})()`)
assert.equal(shadow.state, '1', 'shadow DOM button ran')
console.log('PASS shadow DOM click')

const frameLabels = view.labels.filter(label => label.frame).map(label => label.id)
const frameClicks = await evaluate(`(async () => { ${prefix}
  const ids = ${JSON.stringify(frameLabels)}
  const results = []
  for (const label of ids) results.push((await mod.execute('click', { label }, settings)).changed)
  return { results, states: await frameStates() }
})()`)
assert.ok(frameClicks.states.some(item => item.state === '1'), 'an iframe button received the click')
console.log('PASS iframe click (same/cross origin)')

const select = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('select_option', { label: ${view.select}, option: 'Canada' }, settings)
  const state = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.getElementById('country-state').textContent }))[0].result
  return { selected: result.selected, state }
})()`)
assert.equal(select.state, 'ca', 'select change handler ran')
assert.equal(select.selected.value, 'ca')
console.log('PASS native select')

const hover = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('hover', { label: ${view.menu} }, settings)
  const item = result.labels.find(label => label.text === 'Menu item')
  const clicked = item ? await mod.execute('click', { label: item.id }, settings) : undefined
  const state = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.getElementById('menu-state').textContent }))[0].result
  return { item: Boolean(item), clicked: clicked?.changed, state }
})()`)
assert.equal(hover.item, true, 'hover revealed the menu item')
assert.equal(hover.state, '1', 'menu item click ran')
console.log('PASS hover menu')

console.log('\nALL ADVANCED CHECKS PASSED')
panel.close()
