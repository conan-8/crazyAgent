#!/usr/bin/env node
/**
 * Real-extension clicking checks against e2e/fixtures/click.html in Edge.
 *
 *   python3 -m http.server 17872 --bind 127.0.0.1 --directory e2e/fixtures
 *   microsoft-edge --user-data-dir=/tmp/ca-edge --load-extension=$PWD/extension \
 *     --remote-debugging-port=9228 http://127.0.0.1:17872/click.html
 *   node scripts/edge-click-e2e.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9228'
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
  await new Promise(resolve => setTimeout(resolve, 800))
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

await evaluate(`(async () => {
  const tabs = await chrome.tabs.query({})
  const tab = tabs.find(item => item.url?.includes('second.html') || item.url?.includes('click.html'))
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.tabs.update(tab.id, { url: 'http://127.0.0.1:17872/click.html' })
  await new Promise(resolve => setTimeout(resolve, 700))
  return 'reset'
})()`)

const prefix = `const mod = await import('./browser.js')
  const tabs = await chrome.tabs.query({})
  const tab = tabs.find(item => item.url?.includes('click.html'))
  const settings = { ...mod.DEFAULT_SETTINGS }
  const read = async id => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: id => document.getElementById(id).textContent, args: [id] }))[0].result
`
const snapshot = await evaluate(`(async () => { ${prefix}
  const view = await mod.execute('snapshot', {}, settings)
  const byText = text => view.labels.find(label => label.text === text)
  return {
    count: view.labels.length,
    labelMs: view.labelMs,
    totalMs: view.totalMs,
    ids: {
      counter: byText('Increment')?.id,
      disabled: byText('Disabled action')?.id,
      role: byText('Role button')?.id,
      noop: byText('Does nothing')?.id,
      nested: byText('Nested label')?.id,
      next: byText('Go to second page')?.id,
      checkbox: byText('Toggle me')?.id,
      icon: byText('Close dialog')?.id,
    },
    covered: Boolean(byText('Covered action')),
    hidden: Boolean(byText('Hidden action')),
  }
})()`)

assert.equal(snapshot.count, 9, 'labels the nine visible controls')
assert.equal(snapshot.covered, false, 'covered button is not labelled')
assert.equal(snapshot.hidden, false, 'display:none button is not labelled')
assert.ok(snapshot.ids.icon, 'icon button gets an accessible name')
assert.ok(snapshot.labelMs < 100, `labelling is fast (${snapshot.labelMs}ms)`)

const counter = await evaluate(`(async () => { ${prefix}
  const view = await mod.execute('click', { label: ${snapshot.ids.counter} }, settings)
  return {
    changed: view.changed,
    signals: view.signals,
    clickMs: view.clickMs,
    count: await read('count'),
    stable: view.labels.find(label => label.text === 'Increment')?.id === ${snapshot.ids.counter},
  }
})()`)
assert.equal(counter.changed, true, 'counter click reports a change')
assert.equal(counter.count, '1', 'counter incremented exactly once')
assert.equal(counter.stable, true, 'label id is stable across views')
console.log(`PASS counter click — ${counter.clickMs}ms, ${counter.signals.join(', ')}`)

const role = await evaluate(`(async () => { ${prefix}
  const view = await mod.execute('click', { label: ${snapshot.ids.role} }, settings)
  return { changed: view.changed, count: await read('role-count') }
})()`)
assert.equal(role.changed, true, 'role=button click reports a change')
assert.equal(role.count, '1', 'role=button handler ran')
console.log('PASS role=button click')

const nested = await evaluate(`(async () => { ${prefix}
  const view = await mod.execute('click', { label: ${snapshot.ids.nested} }, settings)
  return { changed: view.changed, signals: view.signals }
})()`)
assert.equal(nested.changed, false, 'no-op click reports no visible change')
assert.deepEqual(nested.signals, [], 'no-op click has no change signals')
console.log('PASS no-op click is reported honestly')

const checkbox = await evaluate(`(async () => { ${prefix}
  const view = await mod.execute('click', { label: ${snapshot.ids.checkbox} }, settings)
  return { changed: view.changed, state: await read('check-state') }
})()`)
assert.equal(checkbox.changed, true, 'checkbox click reports a change')
assert.equal(checkbox.state, 'checked', 'checkbox toggled')
console.log('PASS checkbox click')

const disabled = await evaluate(`(async () => { ${prefix}
  try { await mod.execute('click', { label: ${snapshot.ids.disabled} }, settings); return 'NO_ERROR' }
  catch (error) { return error.code || error.message }
})()`)
assert.equal(disabled, 'DISABLED', 'disabled control is refused')

const unknown = await evaluate(`(async () => { ${prefix}
  try { await mod.execute('click', { label: 999999 }, settings); return 'NO_ERROR' }
  catch (error) { return error.code || error.message }
})()`)
assert.equal(unknown, 'UNKNOWN_LABEL', 'unknown label is refused')
console.log('PASS disabled and unknown labels are refused')

const link = await evaluate(`(async () => { ${prefix}
  const view = await mod.execute('click', { label: ${snapshot.ids.next} }, settings)
  return { changed: view.changed, navigated: view.navigated, clickMs: view.clickMs, url: view.tab.url }
})()`)
assert.equal(link.navigated, true, 'link click navigates')
assert.match(link.url, /second\.html$/)
console.log(`PASS link click navigates — ${link.clickMs}ms`)

console.log('\nALL CLICK CHECKS PASSED')
panel.close()
