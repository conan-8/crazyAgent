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

async function evaluate(expression, userGesture = false) {
  const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

const fixtureUrl = `${BASE}/chat.html?run=${Date.now()}`
const fixture = await evaluate(`(async () => {
  const tabs = await chrome.tabs.query({})
  let tab = tabs.find(item => item.url?.includes('/chat.html'))
  if (!tab) tab = await chrome.tabs.create({ url: '${fixtureUrl}', active: true })
  else {
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.tabs.update(tab.id, { url: '${fixtureUrl}' })
  }
  await new Promise(resolve => setTimeout(resolve, 900))
  return { id: tab.id }
})()`)
assert.ok(fixture?.id, 'chat fixture tab id')
const tabId = fixture.id
const prefix = `const mod = await import('./browser.js')
  const tabId = ${tabId}
  const settings = { ...mod.DEFAULT_SETTINGS }
  const pageState = async () => (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => ({
    text: document.getElementById('composer')?.innerText ?? '',
    active: document.activeElement?.id ?? '',
    attachments: document.getElementById('attachments')?.children.length ?? -1,
    uploads: window.chatFixtureState?.uploads ?? -1,
    viewerOpens: window.chatFixtureState?.viewerOpens ?? -1,
  }) }))[0].result
`

const labelledTyping = await evaluate(`(async () => { ${prefix}
  const snapshot = await mod.execute('snapshot', { detail: 'fast' }, settings)
  const composer = snapshot.labels.find(label => label.tag === 'div' && label.role === 'textbox' && label.text === 'Ask anything about the question')
  if (!composer) return { labels: snapshot.labels }
  const typed = await mod.execute('type', { label: composer.id, text: 'Which option?', view: 'none' }, settings)
  const state = await pageState()
  const staleClick = await mod.execute('click_at', { x: 10, y: 10, view: 'compact' }, settings)
  return { composer, viewId: snapshot.viewId, typed: typed.typed, changed: typed.changed, state, staleClick: { code: staleClick.refused?.code, message: staleClick.refused?.message, attempted: staleClick.attempted } }
})()`)
assert.ok(labelledTyping.composer, `composer label exists: ${JSON.stringify(labelledTyping.labels)}`)
assert.equal(labelledTyping.typed.label, labelledTyping.composer.id)
assert.equal(labelledTyping.typed.method, 'dom')
assert.equal(labelledTyping.typed.afterChars, 'Which option?'.length)
assert.equal(labelledTyping.changed, true)
assert.equal(labelledTyping.state.text, 'Which option?')
assert.equal(labelledTyping.state.active, 'composer')
assert.equal(labelledTyping.state.attachments, 2)
assert.equal(labelledTyping.state.uploads, 0)
assert.equal(labelledTyping.state.viewerOpens, 0)
assert.equal(labelledTyping.staleClick.code, 'NO_VIEW')
assert.equal(labelledTyping.staleClick.attempted, false)
assert.match(labelledTyping.staleClick.message, new RegExp(`View #${labelledTyping.viewId} went stale: .*layout|View #${labelledTyping.viewId} went stale: .*controls`, 'u'))
console.log('PASS chat contenteditable has a textbox label and labelled typing lands without collateral changes')

const clickEvidence = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { url: '${fixtureUrl}' })
  await new Promise(resolve => setTimeout(resolve, 700))
  const composerView = await mod.execute('snapshot', { detail: 'fast' }, settings)
  const composer = composerView.labels.find(label => label.role === 'textbox' && label.text === 'Ask anything about the question')
  const composerClick = await mod.execute('click_at', { x: composer.x + composer.w / 2, y: composer.y + composer.h / 2, space: 'css', view: 'none' }, settings)
  const composerState = await pageState()
  await chrome.tabs.update(tabId, { url: '${fixtureUrl}' })
  await new Promise(resolve => setTimeout(resolve, 700))
  await mod.execute('snapshot', { detail: 'fast' }, settings)
  const box = (await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const rect = document.querySelector('.attachment img').getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  } }))[0].result
  const thumbnailClick = await mod.execute('click_at', { x: box.x + box.width / 2, y: box.y + box.height / 2, space: 'css', view: 'none' }, settings)
  return {
    composerId: composer.id,
    composerHit: composerClick.points[0]?.hit,
    composerFocus: composerClick.focus,
    composerState,
    thumbnailHit: thumbnailClick.points[0]?.hit,
    thumbnailState: await pageState(),
  }
})()`)
assert.equal(clickEvidence.composerHit.label, clickEvidence.composerId)
assert.equal(clickEvidence.composerHit.role, 'textbox')
assert.equal(clickEvidence.composerHit.editable, true)
assert.equal(clickEvidence.composerFocus.editable, true)
assert.equal(clickEvidence.composerState.active, 'composer')
assert.equal(clickEvidence.composerState.viewerOpens, 0)
assert.equal(clickEvidence.thumbnailHit.tag, 'img')
assert.equal(clickEvidence.thumbnailHit.label, undefined)
assert.equal(clickEvidence.thumbnailState.viewerOpens, 1)
console.log('PASS click_at reports composer label/focus and identifies an unlabelled thumbnail hit')

const nonEditableTyping = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('type', { text: 'not into an editor', view: 'none' }, settings)
  return { typed: result.typed, changed: result.changed, state: await pageState() }
})()`)
assert.equal(nonEditableTyping.changed, null)
assert.equal(nonEditableTyping.typed.canvasEditor, false)
assert.equal(nonEditableTyping.typed.focusEditable, false)
assert.equal(nonEditableTyping.typed.targetKind, 'body')
assert.equal(nonEditableTyping.state.text, '')
assert.equal(nonEditableTyping.state.viewerOpens, 1)
console.log('PASS typing with viewer/body focus reports a non-editable target instead of a canvas editor')

const singlePaste = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { url: '${fixtureUrl}' })
  await new Promise(resolve => setTimeout(resolve, 700))
  const view = await mod.execute('snapshot', { detail: 'fast' }, settings)
  const composer = view.labels.find(label => label.role === 'textbox' && label.text === 'Ask anything about the question')
  const region = (await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const rect = document.getElementById('question-card').getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  } }))[0].result
  await mod.execute('snapshot', { scope: 'region', region, space: 'css', to_clipboard: true }, settings)
  const pasted = await mod.execute('clipboard', { action: 'paste', label: composer.id, view: 'none' }, settings)
  return { pasted: pasted.pasted, state: await pageState() }
})()`, true)
assert.equal(singlePaste.pasted.via, 'synthetic', `expected the synthetic fallback, got ${JSON.stringify(singlePaste.pasted)}`)
assert.equal(singlePaste.pasted.handledBy, 'page-mutation')
assert.equal(singlePaste.pasted.dropDispatched, false)
assert.equal(singlePaste.state.uploads, 1)
assert.equal(singlePaste.state.attachments, 3)
assert.equal(singlePaste.state.viewerOpens, 0)
console.log('PASS synthetic image paste observes one insertion and never doubles through drop')

const regionMismatch = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { url: '${fixtureUrl}' })
  await new Promise(resolve => setTimeout(resolve, 700))
  const normal = await mod.execute('snapshot', { detail: 'normal' }, settings)
  const fast = await mod.execute('snapshot', { detail: 'fast' }, settings)
  let failure
  try {
    await mod.execute('snapshot', { scope: 'region', region: { x: 300, y: 100, width: 900, height: 600 }, view_id: fast.viewId }, settings)
  } catch (error) {
    failure = { code: error.code, message: error.message }
  }
  return { failure, normalView: normal.viewId, fastView: fast.viewId }
})()`)
assert.equal(regionMismatch.failure?.code, 'STALE_VIEW')
assert.match(regionMismatch.failure.message, new RegExp(`coordinates fit view #${regionMismatch.normalView} \\(\\d+x\\d+ image\\)`, 'u'))
console.log('PASS stale region error names the source view that fits the coordinates')

panel.close()
