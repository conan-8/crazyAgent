#!/usr/bin/env node
/**
 * Real-extension native dialog checks against e2e/fixtures/dialog.html.
 *
 *   python3 -m http.server 17872 --bind 127.0.0.1 --directory e2e/fixtures
 *   microsoft-edge --user-data-dir=/tmp/ca-edge-dialog --load-extension=$PWD/extension \
 *     --remote-debugging-port=9238 about:blank
 *   node scripts/edge-dialog-e2e.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9238'
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
  await sleep(800)
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

const fixture = await evaluate(`(async () => {
  const tab = await chrome.tabs.create({ url: '${BASE}/dialog.html?run=' + Date.now(), active: true })
  await new Promise(resolve => setTimeout(resolve, 800))
  return { id: tab.id }
})()`)
assert.ok(fixture?.id, 'fixture tab created')
const prefix = `const mod = await import('./browser.js')
  const tabId = ${fixture.id}
  const settings = { ...mod.DEFAULT_SETTINGS }
  const readState = async () => (await chrome.scripting.executeScript({ target: { tabId }, func: () => document.getElementById('state')?.textContent ?? '' }))[0].result
  const clickButton = async text => {
    const view = await mod.execute('snapshot', {}, settings)
    const label = view.labels.find(item => item.text === text)
    if (!label) throw new Error('No visible label for ' + text)
    return mod.execute('click', { label: label.id, view: 'none' }, settings)
  }
`

try {
  await evaluate(`(async () => { ${prefix}; await mod.beginDebuggerRun() })()`)

  const alert = await evaluate(`(async () => { ${prefix}
    const result = await clickButton('Open alert')
    await new Promise(resolve => setTimeout(resolve, 80))
    return { dialog: result.dialog, state: await readState(), hasImage: result.image !== undefined }
  })()`)
  assert.equal(alert.dialog?.type, 'alert')
  assert.equal(alert.dialog?.status, 'resolved')
  assert.equal(alert.dialog?.automatic, true)
  assert.match(alert.dialog?.message ?? '', /fixture alert: work can continue/)
  assert.match(alert.state, /alert=returned/)
  console.log('PASS alert auto-accepts, returns text, and page work resumes')

  const confirmDismiss = await evaluate(`(async () => { ${prefix}
    const pending = await clickButton('Open confirm')
    const resolved = await mod.execute('dialog', { action: 'dismiss' }, settings)
    await new Promise(resolve => setTimeout(resolve, 80))
    return { pending, resolved: resolved.dialog, state: await readState() }
  })()`)
  assert.equal(confirmDismiss.pending.dialog?.type, 'confirm')
  assert.equal(confirmDismiss.pending.dialog?.status, 'pending')
  assert.equal(confirmDismiss.pending.view, 'none')
  assert.equal(confirmDismiss.pending.image, undefined)
  assert.equal(confirmDismiss.pending.capture?.reason, 'DIALOG_PENDING')
  assert.equal(confirmDismiss.resolved?.action, 'dismiss')
  assert.match(confirmDismiss.resolved?.message ?? '', /fixture confirm: delete the draft\?/)
  assert.match(confirmDismiss.state, /confirm=dismissed/)
  console.log('PASS confirm stays pending without a stale view, then dismisses')

  const confirmAccept = await evaluate(`(async () => { ${prefix}
    const pending = await clickButton('Open confirm')
    const resolved = await mod.execute('dialog', { action: 'accept' }, settings)
    await new Promise(resolve => setTimeout(resolve, 80))
    return { pending: pending.dialog, resolved: resolved.dialog, state: await readState() }
  })()`)
  assert.equal(confirmAccept.pending?.status, 'pending')
  assert.equal(confirmAccept.resolved?.action, 'accept')
  assert.match(confirmAccept.state, /confirm=accepted/)
  console.log('PASS explicit confirm acceptance reaches page state')

  const prompt = await evaluate(`(async () => { ${prefix}
    const pending = await clickButton('Open prompt')
    const resolved = await mod.execute('dialog', { action: 'accept', prompt_text: 'e2e-draft' }, settings)
    await new Promise(resolve => setTimeout(resolve, 80))
    return { pending: pending.dialog, resolved: resolved.dialog, state: await readState() }
  })()`)
  assert.equal(prompt.pending?.type, 'prompt')
  assert.equal(prompt.pending?.defaultPrompt, 'default-draft')
  assert.equal(prompt.resolved?.userInput, 'e2e-draft')
  assert.match(prompt.state, /prompt=accepted:e2e-draft/)
  console.log('PASS prompt returns explicit text to the page')

  const unintendedLeave = await evaluate(`(async () => { ${prefix}
    await clickButton('Arm beforeunload')
    // Chrome requires trusted user activation before it will show beforeunload.
    const pending = await mod.execute('click_role', { path: [{ role: 'link', name: 'Navigate away' }] }, settings)
    const resolved = await mod.execute('dialog', { action: 'dismiss' }, settings)
    const tab = await chrome.tabs.get(tabId)
    return { pending, resolved: resolved.dialog, url: tab.url, state: await readState() }
  })()`)
  assert.equal(unintendedLeave.pending.dialog?.type, 'beforeunload')
  assert.equal(unintendedLeave.pending.dialog?.status, 'pending')
  assert.equal(unintendedLeave.resolved?.action, 'dismiss')
  assert.match(unintendedLeave.url, /dialog\.html/)
  assert.match(unintendedLeave.state, /beforeunload=armed/)
  console.log('PASS unintended beforeunload fails closed and dismissal stays on the page')

  const intendedLeave = await evaluate(`(async () => { ${prefix}
    const result = await mod.execute('navigate', { url: '${BASE}/second.html?from=dialog' }, settings)
    const tab = await chrome.tabs.get(tabId)
    return { dialog: result.dialog, navigated: result.navigated, url: tab.url }
  })()`)
  assert.equal(intendedLeave.dialog?.type, 'beforeunload')
  assert.equal(intendedLeave.dialog?.status, 'resolved')
  assert.equal(intendedLeave.dialog?.automatic, true)
  assert.equal(intendedLeave.navigated?.timedOut, false)
  assert.match(intendedLeave.url, /second\.html\?from=dialog$/)
  console.log('PASS intended navigate auto-accepts beforeunload and completes')

  console.log('\nALL DIALOG CHECKS PASSED')
} finally {
  await evaluate(`(async () => { const mod = await import('./browser.js'); await mod.endDebuggerRun() })()`).catch(() => {})
  panel.close()
}
