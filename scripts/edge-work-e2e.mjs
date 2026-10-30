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
  const result = await mod.execute('type', { label: ${nameLabel}, text: 'Ada Lovelace', view: 'full' }, settings)
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
  return {
    typed: result.typed,
    value: await prop('name', 'value'),
    changed: result.changed,
    inputDelta: after - before,
    view: result.view,
    screenshotSkipped: result.screenshotSkipped,
    hasImage: result.image !== undefined,
    hasLabels: result.labels !== undefined,
    delta: result.labelsDelta,
  }
})()`)
assert.equal(append.typed.mode, 'append', 'append mode is echoed')
assert.equal(append.typed.method, 'dom', 'append uses the DOM path')
assert.equal(append.typed.beforeChars, 12, 'append starts from the existing text')
assert.equal(append.typed.afterChars, 13, 'append adds one character')
assert.equal(append.value, 'Ada Lovelace!', 'append preserved the old text')
assert.equal(append.changed, true, 'append reports a change')
assert.equal(append.inputDelta, 1, 'append fires exactly one input event')
assert.equal(append.view, 'compact', 'auto view stays compact after a fresh full view')
assert.equal(append.screenshotSkipped, true, 'compact view skips the screenshot')
assert.equal(append.hasImage, false, 'compact view has no image')
assert.equal(append.hasLabels, false, 'compact view has no label list')
assert.ok(append.delta && append.delta.count > 0 && typeof append.delta.addedCount === 'number', 'compact view carries a label delta')
console.log(`PASS compact type — no image, delta ${append.delta.count} labels (+${append.delta.addedCount}/-${append.delta.removedCount}), changed`)

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
  const result = await mod.execute('press_key', { key: 'Tab', view: 'full' }, settings)
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

const placesMarker = `CrazyAgent Places ${Date.now()}`
const places = await evaluate(`(async () => { ${prefix}
  const bookmark = await chrome.bookmarks.create({ title: '${placesMarker}', url: '${BASE}/second.html?from=bookmark' })
  try {
    const bookmarkResult = await mod.execute('places.search', { query: '${placesMarker}', sources: ['bookmarks'], limit: 5 }, settings)
    const historyResult = await mod.execute('places.search', { query: 'second.html', sources: ['history'], limit: 20 }, settings)
    const shortcutResult = await mod.execute('places.search', { sources: ['shortcuts'], limit: 20 }, settings)
    const target = bookmarkResult.places.find(place => place.title === '${placesMarker}')
    const opened = target ? await mod.execute('navigate', { url: target.url }, settings) : undefined
    return {
      bookmarkUrl: target?.url,
      bookmarkCount: bookmarkResult.places.length,
      historyFound: historyResult.places.some(place => place.url.includes('/second.html')),
      shortcutsValid: shortcutResult.places.every(place => /^https?:\\/\\//.test(place.url)),
      requestedUrl: opened?.navigated?.requestedUrl,
      openedUrl: opened?.tab?.url,
      openedText: opened ? await pageText() : '',
    }
  } finally {
    await chrome.bookmarks.remove(bookmark.id)
  }
})()`)
assert.equal(places.bookmarkCount, 1, 'unique bookmark query returns one destination')
assert.equal(places.bookmarkUrl, `${BASE}/second.html?from=bookmark`, 'bookmark URL is returned exactly')
assert.equal(places.historyFound, true, 'fixture navigation is discoverable in recent history')
assert.equal(places.shortcutsValid, true, 'shortcut results are empty or navigable HTTP(S) URLs')
assert.equal(places.requestedUrl, places.bookmarkUrl, 'navigation uses the exact returned bookmark URL')
assert.equal(places.openedUrl, places.bookmarkUrl, 'active tab independently shows the bookmark destination')
assert.match(places.openedText, /SECOND-MARKER/, 'bookmark destination content is loaded')
const remainingPlaceBookmarks = await evaluate(`chrome.bookmarks.search(${JSON.stringify(placesMarker)})`)
assert.equal(remainingPlaceBookmarks.length, 0, 'temporary bookmark is removed')
console.log('PASS places lookup — bookmark + recent history + shortcuts, exact URL opened, cleanup verified')

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

const autoViews = await evaluate(`(async () => {
  const mod = await import('./browser.js')
  const settings = { ...mod.DEFAULT_SETTINGS }
  const created = await chrome.tabs.create({ url: '${BASE}/form.html?autoview=1', active: true })
  await new Promise(resolve => setTimeout(resolve, 900))
  const views = []
  for (let index = 0; index < 7; index += 1) {
    const result = await mod.execute('type', { text: 'x' }, settings)
    views.push({ view: result.view, hasImage: typeof result.image?.data === 'string', hasDelta: result.labelsDelta !== undefined })
  }
  await chrome.tabs.remove(created.id)
  const original = (await chrome.tabs.query({})).find(item => item.url?.includes('/form.html'))
  await chrome.tabs.update(original.id, { active: true })
  return views
})()`)
assert.equal(autoViews[0].view, 'full', 'first action without a prior view uses a full view')
assert.equal(autoViews[0].hasImage, true, 'first action carries the image')
assert.equal(autoViews[1].view, 'compact', 'immediate follow-up action is compact')
assert.equal(autoViews[1].hasImage, false, 'follow-up compact action has no image')
assert.equal(autoViews[1].hasDelta, true, 'follow-up compact action carries a label delta')
assert.ok(autoViews.slice(1, 6).every(item => item.view === 'compact'), 'auto stays compact during the streak')
assert.equal(autoViews[6].view, 'full', 'compactStreak >= 5 escalates to a full view')
console.log('PASS auto view policy — full first, compact streak, escalation after 5')

const batch = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { active: true })
  await chrome.tabs.update(tabId, { url: '${BASE}/form.html' })
  await new Promise(resolve => setTimeout(resolve, 900))
  const snap = await mod.execute('snapshot', {}, settings)
  const name = snap.labels.find(item => item.tag === 'input' && item.text === 'Name')
  const notes = snap.labels.find(item => item.tag === 'textarea' && item.text === 'Notes')
  const started = performance.now()
  const result = await mod.execute('batch', { actions: [
    { op: 'type', args: { label: name.id, text: 'Batch Name' } },
    { op: 'press_key', args: { key: 'Tab' } },
    { op: 'type', args: { label: notes.id, text: 'batch notes' } },
    { op: 'type', args: { label: name.id, text: 'Batch Submit', submit: true } },
  ] }, settings)
  return {
    op: result.op,
    view: result.view,
    batch: result.batch,
    actions: result.actions.map(item => ({
      index: item.index,
      op: item.op,
      ok: item.ok,
      hasImage: item.image !== undefined,
      hasLabels: item.labels !== undefined,
      hasTyped: item.typed !== undefined,
      hasPressed: item.pressed !== undefined,
    })),
    hasImage: typeof result.image?.data === 'string',
    labelCount: Array.isArray(result.labels) ? result.labels.length : null,
    hasCaptureMs: result.captureMs !== undefined,
    totalMs: result.totalMs,
    wallMs: Math.round(performance.now() - started),
    resultText: await read('result'),
  }
})()`)
assert.equal(batch.op, 'batch', 'batch reports its op')
assert.equal(batch.view, 'full', 'batch default view is full')
assert.equal(batch.batch.total, 4, 'batch reports the requested action count')
assert.equal(batch.batch.executed, 4, 'batch executed every action')
assert.equal(batch.batch.succeeded, 4, 'batch reports four succeeded actions')
assert.equal(batch.batch.ok, true, 'batch reports overall success')
assert.equal(batch.batch.stoppedEarly, false, 'successful batch did not stop early')
assert.equal(batch.batch.failedIndex, undefined, 'successful batch has no failed index')
assert.ok(batch.batch.elapsedMs >= 0 && batch.batch.viewMs >= 0, 'batch reports action and view timing')
assert.equal(batch.actions.length, 4, 'one result per attempted action')
assert.ok(batch.actions.every(item => item.ok === true), 'every batch action succeeded')
assert.deepEqual(batch.actions.map(item => item.op), ['type', 'press_key', 'type', 'type'])
assert.ok(batch.actions.every(item => item.hasImage === false && item.hasLabels === false), 'inner actions build no view payload')
assert.ok(batch.actions[0].hasTyped && batch.actions[1].hasPressed, 'inner actions return their outcome fields')
assert.ok(batch.hasImage && batch.labelCount > 0, 'batch returns exactly one final full view')
assert.ok(batch.hasCaptureMs, 'final view carries capture timing')
assert.ok(batch.totalMs >= batch.batch.elapsedMs + batch.batch.viewMs - 5, 'batch totalMs covers actions and view')
assert.match(batch.resultText, /name=Batch Submit/, 'batched typing and submit reached the form')
console.log(`PASS batch sequence — 4 known-label actions, one final view (${batch.batch.elapsedMs}ms actions + ${batch.batch.viewMs}ms view)`)

const batchErrors = await evaluate(`(async () => { ${prefix}
  const stopped = await mod.execute('batch', { actions: [
    { op: 'type', args: { label: 987654, text: 'x' } },
    { op: 'press_key', args: { key: 'Tab' } },
  ] }, settings)
  const continued = await mod.execute('batch', { actions: [
    { op: 'press_key', args: { key: 'not-a-key' } },
    { op: 'press_key', args: { key: 'Tab' } },
  ], stop_on_error: false }, settings)
  const compact = await mod.execute('batch', { actions: [{ op: 'press_key', args: { key: 'Escape' } }], view: 'compact' }, settings)
  const bad = await (async () => {
    try { await mod.execute('batch', { actions: [{ op: 'snapshot' }] }, settings); return 'NO_ERROR' }
    catch (error) { return error.code }
  })()
  return {
    stopped: { batch: stopped.batch, actionCount: stopped.actions.length, errorCode: stopped.actions[0]?.error?.code },
    continued: { batch: continued.batch, actionCount: continued.actions.length, oks: continued.actions.map(item => item.ok) },
    compact: { view: compact.view, hasImage: compact.image !== undefined, hasLabels: compact.labels !== undefined, hasDelta: compact.labelsDelta !== undefined },
    bad,
  }
})()`)
assert.equal(batchErrors.stopped.batch.ok, false, 'stop_on_error batch reports failure')
assert.equal(batchErrors.stopped.batch.stoppedEarly, true, 'stop_on_error stops at the first failure')
assert.equal(batchErrors.stopped.batch.failedIndex, 1, 'stop_on_error reports the failed index')
assert.equal(batchErrors.stopped.batch.executed, 1, 'executed counts the failed attempt')
assert.equal(batchErrors.stopped.batch.succeeded, 0, 'failed batch has no succeeded actions')
assert.equal(batchErrors.stopped.actionCount, 1, 'actions stop at the failure')
assert.equal(batchErrors.stopped.errorCode, 'UNKNOWN_LABEL', 'action validation error is captured per action')
assert.equal(batchErrors.continued.batch.ok, false, 'continue batch is not ok when an action failed')
assert.equal(batchErrors.continued.batch.executed, 2, 'continue batch attempts later actions')
assert.equal(batchErrors.continued.batch.succeeded, 1, 'continue batch reports its succeeded count')
assert.equal(batchErrors.continued.batch.stoppedEarly, false, 'continue batch does not stop early')
assert.deepEqual(batchErrors.continued.oks, [false, true], 'later action still ran')
assert.equal(batchErrors.compact.view, 'compact', 'batch-level compact view is honoured')
assert.equal(batchErrors.compact.hasImage, false, 'compact batch has no image')
assert.equal(batchErrors.compact.hasLabels, false, 'compact batch has no label list')
assert.equal(batchErrors.compact.hasDelta, true, 'compact batch carries a label delta')
assert.equal(batchErrors.bad, 'BAD_BATCH', 'unknown batch ops are rejected')
console.log('PASS batch stop_on_error / continue / compact view / BAD_BATCH')

const punctuation = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { url: '${BASE}/form.html' })
  await new Promise(resolve => setTimeout(resolve, 900))
  const snap = await mod.execute('snapshot', {}, settings)
  const name = snap.labels.find(item => item.tag === 'input' && item.text === 'Name')
  await mod.execute('type', { label: name.id, text: '', view: 'none' }, settings)
  const slash = await mod.execute('press_key', { key: '/', view: 'none' }, settings)
  const question = await mod.execute('press_key', { key: '?', view: 'none' }, settings)
  const semicolon = await mod.execute('press_key', { key: ';', view: 'none' }, settings)
  const bracket = await mod.execute('press_key', { key: ']', view: 'none' }, settings)
  return {
    value: await prop('name', 'value'),
    slash: slash.pressed,
    question: question.pressed,
    semicolon: semicolon.pressed,
    bracket: bracket.pressed,
  }
})()`)
assert.equal(punctuation.slash.key, '/', 'slash is a supported key')
assert.equal(punctuation.question.key, '?', 'shifted punctuation is a supported key')
assert.equal(punctuation.slash.trusted, true, 'punctuation uses trusted input')
assert.equal(punctuation.value, '/?;]', 'punctuation characters reached the field')
console.log('PASS punctuation keys / ? ; ]')

const persistence = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { url: '${BASE}/form.html' })
  await new Promise(resolve => setTimeout(resolve, 900))
  const first = await mod.execute('snapshot', {}, settings)
  const name = first.labels.find(item => item.tag === 'input' && item.text === 'Name')
  await mod.execute('scroll', { direction: 'down', amount_px: 600 }, settings)
  const clicked = await mod.execute('click', { label: name.id, view: 'full' }, settings)
  return {
    nameLabel: name.id,
    view: clicked.view,
    clickedLabel: clicked.clicked?.label,
    image: clicked.image?.width ?? null,
    url: clicked.tab.url,
  }
})()`)
assert.equal(persistence.clickedLabel, persistence.nameLabel, 'a label id from an earlier view still resolves')
assert.equal(persistence.view, 'full', 'explicit full view is honoured')
assert.ok(persistence.image > 0, 'label-persistence click returns a labelled view')
assert.match(persistence.url, /form\.html/, 'label persistence is on the same page')
console.log('PASS label persistence across views')

const fastView = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { active: true })
  await chrome.tabs.update(tabId, { url: '${BASE}/form.html' })
  await new Promise(resolve => setTimeout(resolve, 900))
  const result = await mod.execute('snapshot', { detail: 'fast' }, settings)
  return {
    op: result.op,
    view: result.view,
    width: result.image?.width ?? null,
    height: result.image?.height ?? null,
    labelCount: result.labelCount,
    hasLabels: Array.isArray(result.labels) && result.labels.length > 0,
    hasSurfaces: Array.isArray(result.surfaces),
    captureMs: result.captureMs,
  }
})()`)
assert.equal(fastView.op, 'snapshot', 'detail:fast keeps the snapshot op')
assert.equal(fastView.view, 'full', 'detail:fast still returns a full view')
assert.equal(fastView.width, 640, 'detail:fast captures a 640px-wide image')
assert.ok(fastView.height > 0, 'detail:fast reports the image height')
assert.ok(fastView.labelCount > 0 && fastView.hasLabels, 'detail:fast still draws labels')
console.log(`PASS detail:fast snapshot — ${fastView.width}x${fastView.height}, ${fastView.labelCount} labels, ${fastView.captureMs}ms capture`)

const dragSelect = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { url: '${BASE}/form.html' })
  await new Promise(resolve => setTimeout(resolve, 900))
  const box = (await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.getElementById('selectable')
      el.scrollIntoView({ block: 'center' })
      const rect = el.getBoundingClientRect()
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    },
  }))[0].result
  await mod.execute('snapshot', {}, settings)
  const midY = box.y + box.h / 2
  const drag = await mod.execute('select', { from: { x: box.x + 3, y: midY }, to: { x: box.x + box.w - 3, y: midY }, space: 'css' }, settings)
  const collapsed = await mod.execute('select', { from: { x: box.x + 6, y: midY }, to: { x: box.x + 6, y: midY }, space: 'css', view: 'none' }, settings)
  return {
    drag: {
      view: drag.view,
      selected: drag.selected,
      changed: drag.changed,
      signals: drag.signals,
      hasImage: drag.image !== undefined,
      hasLabels: drag.labels !== undefined,
    },
    collapsed: {
      view: collapsed.view,
      selected: collapsed.selected,
      changed: collapsed.changed,
      signals: collapsed.signals,
    },
  }
})()`)
assert.equal(dragSelect.drag.view, 'compact', 'auto view after a full snapshot stays compact')
assert.equal(dragSelect.drag.selected.collapsed, false, 'drag creates a non-collapsed selection')
assert.ok(dragSelect.drag.selected.chars >= 10, `drag selected characters (${dragSelect.drag.selected.chars})`)
assert.match(dragSelect.drag.selected.textPreview, /SELECT-ME/, 'selected text preview names the paragraph')
assert.equal(dragSelect.drag.changed, true, 'selection reports a change')
assert.deepEqual(dragSelect.drag.signals, ['selection-changed'], 'selection signal is reported')
assert.equal(dragSelect.drag.hasImage, false, 'compact select has no image')
assert.equal(dragSelect.drag.hasLabels, false, 'compact select has no label list')
assert.equal(dragSelect.collapsed.view, 'none', 'explicit none select view is honoured')
assert.equal(dragSelect.collapsed.selected.chars, 0, 'collapsed drag selects nothing')
assert.equal(dragSelect.collapsed.selected.collapsed, true, 'collapsed drag is reported as collapsed')
assert.equal(dragSelect.collapsed.changed, false, 'collapsed drag reports no change')
assert.deepEqual(dragSelect.collapsed.signals, [], 'collapsed drag has no signals')
console.log(`PASS drag selection — ${dragSelect.drag.selected.chars} chars, preview ${JSON.stringify(dragSelect.drag.selected.textPreview.slice(0, 40))}`)

const batchSelect = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { url: '${BASE}/form.html' })
  await new Promise(resolve => setTimeout(resolve, 900))
  const box = (await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.getElementById('selectable')
      el.scrollIntoView({ block: 'center' })
      const rect = el.getBoundingClientRect()
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    },
  }))[0].result
  await mod.execute('snapshot', {}, settings)
  const midY = box.y + box.h / 2
  const result = await mod.execute('batch', { actions: [
    { op: 'select', args: { from: { x: box.x + 3, y: midY }, to: { x: box.x + box.w - 3, y: midY }, space: 'css' } },
    { op: 'press_key', args: { key: 'ArrowRight' } },
  ] }, settings)
  return {
    op: result.op,
    view: result.view,
    batch: result.batch,
    hasImage: result.image !== undefined,
    labelCount: Array.isArray(result.labels) ? result.labels.length : null,
    actions: result.actions.map(item => ({
      op: item.op,
      ok: item.ok,
      changed: item.changed,
      hasSelected: item.selected !== undefined,
      textPreview: item.selected?.textPreview,
      pressed: item.pressed?.key,
      hasImage: item.image !== undefined,
      hasLabels: item.labels !== undefined,
    })),
  }
})()`)
assert.equal(batchSelect.op, 'batch', 'select runs inside a batch')
assert.equal(batchSelect.view, 'full', 'batch default view is full')
assert.equal(batchSelect.batch.ok, true, 'batch with select succeeds')
assert.equal(batchSelect.batch.executed, 2, 'both batch actions ran')
assert.equal(batchSelect.batch.succeeded, 2, 'both batch actions succeeded')
assert.equal(batchSelect.actions[0].op, 'select', 'select is the first action')
assert.equal(batchSelect.actions[0].hasSelected, true, 'batch select returns the selection')
assert.match(batchSelect.actions[0].textPreview, /SELECT-ME/, 'batch select selected the paragraph text')
assert.equal(batchSelect.actions[1].pressed, 'ArrowRight', 'the follow-up key ran in the same batch')
assert.ok(batchSelect.actions.every(item => item.hasImage === false && item.hasLabels === false), 'inner select builds no view payload')
assert.ok(batchSelect.hasImage && batchSelect.labelCount > 0, 'batch returns one final view')
console.log('PASS batch [select, ArrowRight] — both actions ok, one final view')

const focusFallback = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { url: '${BASE}/form.html' })
  await new Promise(resolve => setTimeout(resolve, 900))
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.getElementById('comment-card').scrollIntoView({ block: 'center' }),
  })
  const snap = await mod.execute('snapshot', {}, settings)
  const card = snap.labels.find(item => item.tag === 'div' && item.text === 'Comment card')
  const result = await mod.execute('type', { label: card.id, text: 'focus fallback text', view: 'none' }, settings)
  const value = (await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.getElementById('comment-edit')?.innerText ?? '',
  }))[0].result
  return { labelFound: Boolean(card), typed: result.typed, changed: result.changed, value, view: result.view }
})()`)
assert.equal(focusFallback.labelFound, true, 'comment card label is visible after scrolling')
assert.equal(focusFallback.typed.method, 'trusted-focus', 'non-editable label falls back to focused trusted typing')
assert.ok(focusFallback.typed.afterChars > 0, 'fallback typing reports inserted characters')
assert.match(focusFallback.value, /focus fallback text/, 'text landed in the editable descendant')
assert.equal(focusFallback.changed, true, 'fallback typing reports a change')
assert.equal(focusFallback.view, 'none', 'explicit none view on fallback typing is honoured')
console.log(`PASS focus-fallback typing — method ${focusFallback.typed.method}, ${focusFallback.typed.afterChars} chars`)

const namedKeys = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tabId, { url: '${BASE}/form.html' })
  await new Promise(resolve => setTimeout(resolve, 900))
  const snap = await mod.execute('snapshot', {}, settings)
  const name = snap.labels.find(item => item.tag === 'input' && item.text === 'Name')
  await mod.execute('type', { label: name.id, text: '', view: 'none' }, settings)
  const period = await mod.execute('press_key', { key: 'Period', view: 'none' }, settings)
  const colon = await mod.execute('press_key', { key: 'Colon', view: 'none' }, settings)
  const value = (await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.getElementById('name')?.value ?? '',
  }))[0].result
  return { period: period.pressed, colon: colon.pressed, value }
})()`)
assert.equal(namedKeys.period.key, 'Period', 'named Period key is echoed')
assert.equal(namedKeys.period.trusted, true, 'named Period uses trusted input')
assert.equal(namedKeys.colon.key, 'Colon', 'named Colon key is echoed')
assert.equal(namedKeys.colon.trusted, true, 'named Colon uses trusted input')
assert.equal(namedKeys.value, '.:', 'named punctuation keys type their characters')
console.log('PASS named punctuation keys — Period and Colon')

console.log('\nALL WORK CHECKS PASSED')
panel.close()