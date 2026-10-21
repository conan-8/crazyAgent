#!/usr/bin/env node
/** Typing, keys, navigation, and waiting checks against the real extension. */
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
async function evaluate(expression) {
  const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

// Find (or create) the fixture tab and load the form fresh.
const fixture = await evaluate(`(async () => {
  const tabs = await chrome.tabs.query({})
  let tab = tabs.find(item => item.url?.includes('/form.html'))
  if (!tab) {
    tab = await chrome.tabs.create({ url: '${BASE}/form.html', active: true })
  } else {
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.tabs.update(tab.id, { url: '${BASE}/form.html' })
  }
  await new Promise(resolve => setTimeout(resolve, 900))
  return { id: tab.id }
})()`)
assert.ok(fixture?.id, 'fixture tab id')
const tabId = fixture.id

const prefix = `const mod = await import('./browser.js')
  const tabs = await chrome.tabs.query({})
  const tabId = ${tabId}
  const settings = { ...mod.DEFAULT_SETTINGS }
  const read = async id => (await chrome.scripting.executeScript({ target: { tabId }, func: id => document.getElementById(id)?.textContent ?? '', args: [id] }))[0].result
  const prop = async (id, name) => (await chrome.scripting.executeScript({ target: { tabId }, func: (id, name) => document.getElementById(id)?.[name] ?? null, args: [id, name] }))[0].result
  const activeId = async () => (await chrome.scripting.executeScript({ target: { tabId }, func: () => document.activeElement?.id ?? '' }))[0].result
  const pageText = async () => (await chrome.scripting.executeScript({ target: { tabId }, func: () => document.body?.innerText ?? '' }))[0].result
  const textOf = async id => (await chrome.scripting.executeScript({ target: { tabId }, func: id => document.getElementById(id)?.innerText ?? '', args: [id] }))[0].result
`

const setup = await evaluate(`(async () => { ${prefix}
  const snapshot = await mod.execute('snapshot', {}, settings)
  return {
    tabId: tabId,
    url: snapshot.tab.url,
    image: snapshot.image ? { width: snapshot.image.width, height: snapshot.image.height } : null,
    labels: snapshot.labels.map(label => ({ id: label.id, text: label.text, tag: label.tag, role: label.role })),
  }
})()`)
assert.equal(setup.tabId, tabId, 'snapshot reports the fixture tab')
assert.match(setup.url, /form\.html/, 'form fixture is loaded')
assert.ok(setup.image && setup.image.width > 0, 'setup view has an image')
const labelId = (text, tag) => {
  const found = setup.labels.find(item => item.text === text && item.tag === tag)
  assert.ok(found, `label ${JSON.stringify(text)} (${tag}) exists in the view`)
  return found.id
}
const nameLabel = labelId('Name', 'input')
const passLabel = labelId('Password', 'input')
const richLabel = labelId('Rich text', 'div')
console.log(`PASS form fixture loads — ${setup.labels.length} labels, image ${setup.image.width}px`)

const replace = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('type', { label: ${nameLabel}, text: 'Ada Lovelace' }, settings)
  const events = await read('events')
  return {
    op: result.op,
    typed: result.typed,
    changed: result.changed,
    signals: result.signals,
    value: await prop('name', 'value'),
    inputEvents: Number(/input=(\\d+)/.exec(events)?.[1] ?? -1),
    image: result.image?.width ?? null,
  }
})()`)
assert.equal(replace.op, 'type', 'type reports its op')
assert.equal(replace.typed.label, nameLabel, 'typed echoes the label')
assert.equal(replace.typed.method, 'dom', 'label typing uses the DOM path')
assert.equal(replace.typed.mode, 'replace', 'default mode is replace')
assert.equal(replace.typed.submitted, false, 'submit defaults to false')
assert.equal(replace.typed.chars, 12, 'typed reports the requested character count')
assert.equal(replace.typed.beforeChars, 0, 'field started empty')
assert.equal(replace.typed.afterChars, 12, 'field now has the typed text')
assert.equal(replace.typed.valuePreview, 'Ada Lovelace', 'valuePreview shows the field value')
assert.equal(replace.changed, true, 'typing reports a change')
assert.ok(replace.signals.includes('text-changed'), 'typing reports a text-changed signal')
assert.equal(replace.value, 'Ada Lovelace', 'page field holds the typed text')
assert.ok(replace.inputEvents >= 1, 'DOM typing fires an input event')
assert.ok(replace.image > 0, 'type returns a fresh labelled view')
console.log('PASS label type replace — value + input event recorded')

const append = await evaluate(`(async () => { ${prefix}
  const before = Number(/input=(\\d+)/.exec(await read('events'))?.[1] ?? -1)
  const result = await mod.execute('type', { label: ${nameLabel}, text: '!', mode: 'append' }, settings)
  const after = Number(/input=(\\d+)/.exec(await read('events'))?.[1] ?? -1)
  return { typed: result.typed, value: await prop('name', 'value'), changed: result.changed, inputDelta: after - before }
})()`)
assert.equal(append.typed.mode, 'append', 'append mode is echoed')
assert.equal(append.typed.method, 'dom', 'append uses the DOM path')
assert.equal(append.typed.beforeChars, 12, 'append starts from the existing text')
assert.equal(append.typed.afterChars, 13, 'append adds one character')
assert.equal(append.value, 'Ada Lovelace!', 'append preserved the old text')
assert.equal(append.changed, true, 'append reports a change')
assert.equal(append.inputDelta, 1, 'append fires exactly one input event')
console.log('PASS append mode — value kept, one extra input event')

const rich = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('type', { label: ${richLabel}, text: 'Hello rich text' }, settings)
  return { typed: result.typed, text: await textOf('rich'), changed: result.changed }
})()`)
assert.match(rich.text, /Hello rich text/, 'contenteditable received the text')
assert.ok(rich.typed.afterChars >= 15, 'contenteditable reports typed characters')
assert.ok(rich.typed.method === 'dom' || rich.typed.method === 'trusted', 'contenteditable typing reports a method')
assert.equal(rich.changed, true, 'contenteditable typing reports a change')
console.log(`PASS contenteditable typing — method ${rich.typed.method}`)

const pass = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('type', { label: ${passLabel}, text: 'hunter2' }, settings)
  return { typed: result.typed, value: await prop('pass', 'value'), changed: result.changed }
})()`)
assert.equal(pass.typed.valuePreview, '[password 7 chars]', 'password preview is masked')
assert.ok(!String(pass.typed.valuePreview).includes('hunter2'), 'password text never leaves the page')
assert.equal(pass.typed.afterChars, 7, 'password character count is reported')
assert.equal(pass.value, 'hunter2', 'password field actually received the text')
assert.equal(pass.changed, true, 'password typing reports a change')
console.log('PASS password preview is masked')

const submit = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('type', { label: ${nameLabel}, text: 'Submit Me', submit: true }, settings)
  return { typed: result.typed, changed: result.changed, result: await read('result'), events: await read('events') }
})()`)
assert.equal(submit.typed.submitted, true, 'submit:true reports the Enter press')
assert.match(submit.result, /name=Submit Me/, 'Enter submitted the form')
assert.match(submit.events, /submit name=Submit Me/, 'form submit event was recorded')
console.log('PASS submit:true submits the form')

const tabKey = await evaluate(`(async () => { ${prefix}
  await mod.execute('type', { label: ${nameLabel}, text: 'Enter Submit' }, settings)
  const before = await activeId()
  const result = await mod.execute('press_key', { key: 'Tab' }, settings)
  return { before, after: await activeId(), pressed: result.pressed, changed: result.changed, image: result.image?.width ?? null }
})()`)
assert.equal(tabKey.before, 'name', 'typing focused the name field')
assert.equal(tabKey.after, 'notes', 'Tab moves focus to the next field')
assert.equal(tabKey.pressed.key, 'Tab', 'pressed echoes the key')
assert.deepEqual(tabKey.pressed.modifiers, [], 'pressed reports no modifiers')
assert.equal(tabKey.pressed.trusted, true, 'Tab used trusted input')
assert.ok(tabKey.image > 0, 'press_key returns a fresh view')
console.log('PASS press_key Tab moves focus to the next field')

const enterKey = await evaluate(`(async () => { ${prefix}
  await mod.execute('type', { label: ${nameLabel}, text: 'Enter Submit' }, settings)
  const result = await mod.execute('press_key', { key: 'Enter' }, settings)
  return { pressed: result.pressed, changed: result.changed, result: await read('result'), events: await read('events'), url: result.tab.url }
})()`)
assert.equal(enterKey.pressed.trusted, true, 'Enter used trusted input')
assert.match(enterKey.result, /name=Enter Submit/, 'press_key Enter submitted the form')
assert.match(enterKey.events, /submit name=Enter Submit/, 'submit was recorded from the key press')
assert.match(enterKey.url, /form\.html/, 'submission did not navigate away')
console.log('PASS press_key Enter submits the form')

const shortcut = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('press_key', { key: 'k', modifiers: ['ctrl'] }, settings)
  return { pressed: result.pressed, events: await read('events'), changed: result.changed }
})()`)
assert.equal(shortcut.pressed.key, 'k', 'single-character keys are supported')
assert.deepEqual(shortcut.pressed.modifiers, ['ctrl'], 'modifiers are echoed')
assert.equal(shortcut.pressed.trusted, true, 'shortcut used trusted input')
assert.match(shortcut.events, /keydown ctrl\+k trusted/, 'modifier shortcut is recorded as trusted')
console.log('PASS ctrl+k shortcut recorded as trusted')

const navigateAway = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('navigate', { url: '${BASE}/second.html' }, settings)
  return {
    op: result.op,
    navigated: result.navigated,
    tabUrl: result.tab.url,
    image: result.image ? { width: result.image.width, height: result.image.height } : null,
    labels: Array.isArray(result.labels) ? result.labels.length : null,
    text: await pageText(),
  }
})()`)
assert.equal(navigateAway.op, 'navigate', 'navigate reports its op')
assert.equal(navigateAway.navigated.requestedUrl, `${BASE}/second.html`, 'requestedUrl is echoed')
assert.match(navigateAway.navigated.fromUrl, /form\.html/, 'fromUrl is the previous page')
assert.match(navigateAway.navigated.toUrl, /second\.html/, 'toUrl is the loaded page')
assert.equal(navigateAway.navigated.tabId, tabId, 'navigate reports the tab it drove')
assert.equal(navigateAway.navigated.newTab, false, 'existing tab is reused by default')
assert.equal(navigateAway.navigated.status, 'complete', 'navigation waited for load completion')
assert.equal(navigateAway.navigated.timedOut, false, 'navigation did not time out')
assert.ok(navigateAway.navigated.waitMs >= 0, 'navigate reports the load wait')
assert.match(navigateAway.tabUrl, /second\.html/, 'result tab is the new page')
assert.ok(navigateAway.image && navigateAway.image.width > 0, 'navigate returns a fresh view')
assert.match(navigateAway.text, /SECOND-MARKER/, 'new page content is visible')
console.log(`PASS navigate url — ${navigateAway.navigated.waitMs}ms load wait, fresh view`)

const navigateBack = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('navigate', { history: 'back' }, settings)
  return {
    navigated: result.navigated,
    tabUrl: result.tab.url,
    image: result.image ? { width: result.image.width } : null,
    text: await pageText(),
  }
})()`)
assert.equal(navigateBack.navigated.history, 'back', 'history action is echoed')
assert.match(navigateBack.navigated.toUrl, /form\.html/, 'history back returns to the form')
assert.equal(navigateBack.navigated.timedOut, false, 'history navigation did not time out')
assert.match(navigateBack.tabUrl, /form\.html/, 'result tab is the form again')
assert.ok(navigateBack.image && navigateBack.image.width > 0, 'history back returns a fresh view')
assert.match(navigateBack.text, /Work fixture/, 'form content is visible after history back')
console.log('PASS navigate history back — fresh view of the form')

const waitFound = await evaluate(`(async () => { ${prefix}
  await mod.execute('navigate', { url: '${BASE}/form.html?late=5000' }, settings)
  const result = await mod.execute('wait_for', { text: 'late content ready', timeout_ms: 10000 }, settings)
  return {
    op: result.op,
    waited: result.waited,
    image: result.image ? { width: result.image.width } : null,
    text: await pageText(),
  }
})()`)
assert.equal(waitFound.op, 'wait_for', 'wait_for reports its op')
assert.equal(waitFound.waited.conditions.text, 'late content ready', 'conditions are echoed')
assert.equal(waitFound.waited.found, true, 'wait_for found the delayed text')
assert.equal(waitFound.waited.timedOut, false, 'helpful text was not a timeout')
assert.ok(waitFound.waited.elapsedMs >= 800, `wait_for polled for >=800ms (${waitFound.waited.elapsedMs}ms)`)
assert.ok(waitFound.image && waitFound.image.width > 0, 'wait_for returns a fresh view')
assert.match(waitFound.text, /late content ready/, 'late content is in the page text')
console.log(`PASS wait_for text found — ${waitFound.waited.elapsedMs}ms elapsed`)

const waitMissing = await evaluate(`(async () => { ${prefix}
  const result = await mod.execute('wait_for', { text: 'never-appears-zzz', timeout_ms: 1200 }, settings)
  return { waited: result.waited, image: result.image ? { width: result.image.width } : null }
})()`)
assert.equal(waitMissing.waited.found, false, 'missing text is not found')
assert.equal(waitMissing.waited.timedOut, true, 'missing text reports a timeout')
assert.ok(waitMissing.waited.elapsedMs >= 1200, `wait_for honoured the timeout (${waitMissing.waited.elapsedMs}ms)`)
assert.ok(waitMissing.image && waitMissing.image.width > 0, 'a timed-out wait still returns a fresh view')
console.log(`PASS missing text times out — ${waitMissing.waited.elapsedMs}ms`)

const labelLess = await evaluate(`(async () => { ${prefix}
  const scrolled = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.getElementById('editor')
      el.scrollIntoView({ block: 'center' })
      const rect = el.getBoundingClientRect()
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    },
  })
  const box = scrolled[0].result
  await mod.execute('snapshot', {}, settings)
  const click = await mod.execute('click_at', { space: 'css', x: box.x + box.w / 2, y: box.y + box.h / 2 }, settings)
  const before = await prop('editor', 'value')
  const result = await mod.execute('type', { text: 'trusted text' }, settings)
  return {
    clickTrusted: click.trusted,
    focused: await activeId(),
    before,
    typed: result.typed,
    changed: result.changed,
    value: await prop('editor', 'value'),
  }
})()`)
assert.equal(labelLess.clickTrusted, true, 'the caret click used trusted input')
assert.equal(labelLess.focused, 'editor', 'the editor holds focus before label-less typing')
assert.equal(labelLess.before, '', 'the editor started empty')
assert.equal(labelLess.typed.label, undefined, 'label-less typing omits the label')
assert.equal(labelLess.typed.method, 'trusted', 'label-less typing goes through the debugger')
assert.equal(labelLess.typed.beforeChars, 0, 'label-less typing saw an empty field')
assert.equal(labelLess.typed.afterChars, 12, 'label-less typing inserted the text')
assert.equal(labelLess.value, 'trusted text', 'the focused editor received the text')
assert.equal(labelLess.changed, true, 'label-less typing reports a change')
console.log('PASS label-less trusted typing into the focused editor')

console.log('\nALL WORK CHECKS PASSED')
panel.close()