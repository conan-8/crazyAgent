#!/usr/bin/env node
/** Real-extension direct and batch expectation checks against expect.html. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9228'
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
async function evaluate(expression) {
  const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

let debuggerStarted = false
try {
await evaluate(`(async () => {
  const tabs = await chrome.tabs.query({})
  let tab = tabs.find(item => item.url?.includes('/expect.html'))
  if (!tab) tab = await chrome.tabs.create({ url: '${BASE}/expect.html', active: true })
  else {
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.tabs.update(tab.id, { url: '${BASE}/expect.html' })
  }
  await new Promise(resolve => setTimeout(resolve, 900))
  return 'reset'
})()`)
debuggerStarted = true
const debuggerRun = await evaluate(`(async () => {
  const mod = await import('./browser.js')
  await mod.beginDebuggerRun()
  return 'started'
})()`)
assert.equal(debuggerRun, 'started')

const prefix = `const mod = await import('./browser.js')
  const tabs = await chrome.tabs.query({})
  const tab = tabs.find(item => item.url?.includes('/expect.html'))
  const settings = { ...mod.DEFAULT_SETTINGS }
  const prop = async (id, name) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (id, name) => document.getElementById(id)?.[name] ?? null, args: [id, name] }))[0].result
  const text = async id => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: id => document.getElementById(id)?.textContent ?? '', args: [id] }))[0].result
  const globalValue = async name => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: name => window[name] ?? null, args: [name] }))[0].result
  const state = async () => ({
    value: await prop('name', 'value'),
    count: await text('create-count'),
    status: await text('status'),
    dialogOpen: await prop('dialog', 'open'),
    followUp: Boolean(await prop('follow-up', 'id')),
    dispatchCount: await globalValue('__expectDispatchCount'),
    inputEvents: await globalValue('__expectInputEvents'),
  })
`
const setup = await evaluate(`(async () => { ${prefix}
  const view = await mod.execute('snapshot', {}, settings)
  const byText = text => view.labels.find(label => label.text === text)
  return {
    name: byText('Name')?.id,
    input: view.labels.find(label => label.text === 'Name' && label.tag === 'input')?.id,
    create: byText('Create')?.id,
    openDialog: byText('Open dialog')?.id,
  }
})()`)
assert.ok(setup.name && setup.input && setup.create && setup.openDialog, 'expect controls are labelled')

const typed = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('type', { label: ${setup.name}, text: 'Ada', view: 'none', expect: { text_landed: 'Ada' } }, settings)
  return { observed: result.observed, expectation: result.expectation, outcome: result.outcome, mutationPossible: result.mutationPossible, evidence: result.expectEvidence, state: await state() }
})()`)
assert.equal(typed.observed, 'changed')
assert.equal(typed.expectation.status, 'verified', JSON.stringify({ expectation: typed.expectation, evidence: typed.evidence, state: typed.state }))
assert.equal(typed.outcome.ok, true)
assert.equal(typed.mutationPossible, true)
assert.equal(typed.state.value, 'Ada')
assert.equal(typed.evidence.text_landed.before.contains, false)
assert.equal(typed.evidence.text_landed.after.contains, true)
assert.equal('text' in typed.evidence.text_landed.after, false)
console.log('PASS direct text_landed transition with independent field readback')

const preexisting = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('type', { label: ${setup.name}, text: ' Lovelace', mode: 'append', view: 'none', expect: { text_landed: 'Ada' } }, settings)
  return { expectation: result.expectation, observed: result.observed, state: await state() }
})()`)
assert.equal(preexisting.expectation.status, 'unverified')
assert.equal(preexisting.expectation.checks[0].reason, 'preexisting-text')
assert.equal(preexisting.observed, 'changed')
assert.equal(preexisting.state.value, 'Ada Lovelace')
console.log('PASS pre-existing text stays unverified without retyping')

const diverged = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('type', { label: ${setup.input}, text: 'Once', view: 'none', expect: { text_landed: 'NOT_PRESENT' } }, settings)
  return { expectation: result.expectation, outcome: result.outcome, state: await state() }
})()`)
assert.equal(diverged.expectation.status, 'diverged')
assert.equal(diverged.expectation.checks[0].reason, 'missing-after')
assert.equal(diverged.outcome.ok, true)
assert.equal(diverged.state.value, 'Once')
assert.equal(diverged.state.inputEvents, 3, JSON.stringify(diverged.state))
console.log('PASS diverged expectation performs no repair or second input')

const pixels = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('click', { label: ${setup.create}, view: 'none', expect: { pixel_changed: true } }, settings)
  return { view: result.view, expectation: result.expectation, observed: result.observed, semantic: result.semanticDelta, state: await state() }
})()`)
assert.equal(pixels.view, 'full')
assert.equal(pixels.expectation.status, 'verified')
assert.equal(pixels.expectation.diagnosticOnly, true)
assert.equal(pixels.observed, 'changed')
assert.equal(pixels.state.count, '1')
assert.equal(pixels.state.status, 'Created')
assert.equal(pixels.state.followUp, true)
assert.deepEqual(pixels.semantic.newOnScreen.map(label => label.text), ['Follow up'])
assert.deepEqual(pixels.semantic.changed.map(entry => [entry.after.text, entry.fields]), [['Created', ['text']]])
assert.deepEqual([...pixels.semantic.newText].sort(), ['Created', 'Follow up'], JSON.stringify(pixels.semantic))
assert.equal(pixels.semantic.newText.includes('Expect fixture'), false)
assert.equal(pixels.semantic.newText.includes('Name'), false)
console.log('PASS direct pixels plus New on screen/Changed/New text with independent DOM state')

const dialog = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('click', { label: ${setup.openDialog}, view: 'none', expect: { dialog: 'open' } }, settings)
  return { expectation: result.expectation, outcome: result.outcome, mutationPossible: result.mutationPossible, state: await state() }
})()`)
assert.equal(dialog.expectation.status, 'verified')
assert.equal(dialog.outcome.ok, true)
assert.equal(dialog.mutationPossible, true)
assert.equal(dialog.state.dialogOpen, true)
const dialogClosed = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('press_key', { key: 'Escape', expect: { dialog: 'closed' }, view: 'none' }, settings)
  return { expectation: result.expectation, outcome: result.outcome, state: await state() }
})()`)
assert.equal(dialogClosed.expectation.status, 'verified')
assert.equal(dialogClosed.outcome.ok, true)
assert.equal(dialogClosed.state.dialogOpen, false)
console.log('PASS dialog open and closed final-state evidence')

const directKey = await evaluate(`(async () => { ${prefix}
  await mod.execute('click', { label: ${setup.input}, view: 'none' }, settings)
  await mod.execute('press_key', { key: 'End', view: 'none' }, settings)
  const result = await mod.execute('press_key', { key: 'X', view: 'none', expect: { text_landed: 'X' } }, settings)
  return { expectation: result.expectation, outcome: result.outcome, state: await state() }
})()`)
assert.equal(directKey.expectation.status, 'verified')
assert.equal(directKey.outcome.ok, true)
assert.equal(directKey.state.value, 'OnceX')
assert.equal(directKey.state.inputEvents, 4)
console.log('PASS direct press_key scoped text evidence')

const coordinate = await evaluate(`(async () => { ${prefix}
  const view = await mod.execute('snapshot', {}, settings)
  const target = view.labels.find(label => label.id === ${setup.create})
  const result = await mod.execute('click_at', {
    x: Math.round(target.x + target.w / 2), y: Math.round(target.y + target.h / 2),
    space: 'css', expect: { pixel_changed: true },
  }, settings)
  return { expectation: result.expectation, outcome: result.outcome, observed: result.observed, state: await state() }
})()`)
assert.equal(coordinate.expectation.status, 'verified')
assert.equal(coordinate.expectation.diagnosticOnly, true)
assert.equal(coordinate.outcome.attempted, true)
assert.equal(coordinate.observed, 'changed')
assert.equal(coordinate.state.count, '2')
assert.ok(coordinate.state.dispatchCount >= 2)
console.log('PASS on-screen click_at pixel and independent dispatch evidence')

const batch = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('batch', { view: 'none', actions: [
    { op: 'type', args: { label: ${setup.input}, text: 'Batch', before: { ms: 0 }, after: { ms: 0 }, expect: { text_landed: 'Batch' } } },
    { op: 'click', args: { label: ${setup.openDialog}, expect: { dialog: 'open' } } },
  ] }, settings)
  return { batch: result.batch, observed: result.observed, outcome: result.outcome, expectation: result.expectation, actions: result.actions, state: await state() }
})()`)
assert.equal(batch.batch.ok, true)
assert.equal(batch.observed, 'changed')
assert.equal(batch.outcome.ok, true)
assert.equal(batch.expectation.status, 'verified')
assert.equal(batch.actions[0].expectation.status, 'verified')
assert.equal(batch.actions[0].attempted, true)
assert.equal(batch.actions[0].mutationPossible, true)
assert.equal(batch.actions[0].before.found, true)
assert.equal(batch.actions[0].after.found, true)
assert.equal(batch.actions[1].expectation.status, 'verified')
assert.equal(batch.state.value, 'Batch')
assert.equal(batch.state.dialogOpen, true)
await evaluate(`(async () => { ${prefix}
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.getElementById('dialog').close() })
  return 'closed'
})()`)
console.log('PASS batch guards plus per-action text/dialog expectations')

const postGuard = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('batch', { view: 'none', actions: [
    { op: 'type', args: { label: ${setup.input}, text: 'AfterGuard', after: { text: 'NEVER', timeout_ms: 1000 }, expect: { text_landed: 'AfterGuard' } } },
  ] }, settings)
  return { batch: result.batch, action: result.actions[0], state: await state() }
})()`)
assert.equal(postGuard.batch.ok, false)
assert.equal(postGuard.action.error.code, 'BATCH_POSTCONDITION_FAILED')
assert.equal(postGuard.action.outcome.ok, false)
assert.equal(postGuard.action.attempted, true)
assert.equal(postGuard.action.mutationPossible, true)
assert.equal(postGuard.action.expectation.status, 'verified')
assert.equal(postGuard.state.value, 'AfterGuard')
console.log('PASS postcondition failure preserves text evidence and mutation risk')

const directInvalid = await evaluate(`(async () => { ${prefix}
  let failure
  try { await mod.execute('type', { label: ${setup.name}, text: 'SHOULD_NOT_TYPE', expect: { pixel_changed: false } }, settings) }
  catch (error) { failure = { code: error.code, message: error.message } }
  return { failure, state: await state() }
})()`)
assert.equal(directInvalid.failure.code, 'BAD_EXPECT')
assert.equal(directInvalid.state.value, 'AfterGuard')
const batchInvalid = await evaluate(`(async () => { ${prefix}
  let failure
  try {
    await mod.execute('batch', { actions: [
      { op: 'type', args: { label: ${setup.input}, text: 'SHOULD_NOT_TYPE' } },
      { op: 'click', args: { label: ${setup.create}, expect: { pixel_changed: true } } },
    ] }, settings)
  } catch (error) { failure = { code: error.code, path: error.path, message: error.message } }
  return { failure, state: await state() }
})()`)
assert.equal(batchInvalid.failure.code, 'EXPECT_UNSUPPORTED')
assert.equal(batchInvalid.failure.path, 'actions[1].expect.pixel_changed')
assert.equal(batchInvalid.state.value, 'AfterGuard')
assert.equal(batchInvalid.state.count, '2')
console.log('PASS direct and all-or-nothing batch validation before mutation')

const offscreen = await evaluate(`(async () => { ${prefix}
  const beforeDispatch = (await state()).dispatchCount
  const result = await mod.execute('click_at', { x: 9999, y: 9999, space: 'css', expect: { pixel_changed: true } }, settings)
  return { beforeDispatch, observed: result.observed, expectation: result.expectation, outcome: result.outcome, mutationPossible: result.mutationPossible, state: await state() }
})()`)
assert.equal(offscreen.observed, 'unknown')
assert.equal(offscreen.expectation.status, 'unverified')
assert.equal(offscreen.expectation.checks[0].observed, 'unknown')
assert.equal(offscreen.outcome.attempted, false)
assert.equal(offscreen.mutationPossible, false)
assert.equal(offscreen.state.value, 'AfterGuard')
assert.equal(offscreen.state.count, '2')
assert.equal(offscreen.state.dispatchCount, offscreen.beforeDispatch)
console.log('PASS off-screen pixels remain unknown with no dispatch')

const preGuard = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('batch', { view: 'none', actions: [
    { op: 'type', args: { label: ${setup.input}, text: 'NEVER', before: { text: 'NOT READY', timeout_ms: 1000 }, expect: { text_landed: 'NEVER' } } },
  ] }, settings)
  return { action: result.actions[0], state: await state() }
})()`)
assert.equal(preGuard.action.error.code, 'BATCH_PRECONDITION_FAILED')
assert.equal(preGuard.action.attempted, false)
assert.equal(preGuard.action.mutationPossible, false)
assert.equal(preGuard.action.expectation.status, 'unverified')
assert.equal(preGuard.state.value, 'AfterGuard')
console.log('PASS precondition failure prevents dispatch and expectation verification')

const debuggerRunEnd = await evaluate(`(async () => {
  const mod = await import('./browser.js')
  await mod.endDebuggerRun()
  return 'ended'
})()`)
assert.equal(debuggerRunEnd, 'ended')
debuggerStarted = false
console.log('\nALL EXPECT CHECKS PASSED')
} finally {
  if (debuggerStarted) {
    await evaluate(`(async () => {
      const mod = await import('./browser.js')
      await mod.endDebuggerRun()
      return 'ended'
    })()`).catch(() => {})
  }
  panel.close()
}
