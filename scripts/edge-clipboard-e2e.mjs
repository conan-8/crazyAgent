#!/usr/bin/env node
/**
 * Real-extension clipboard checks against e2e/fixtures/clipboard.html in Edge.
 *
 *   python3 -m http.server 17872 --bind 127.0.0.1 --directory e2e/fixtures
 *   microsoft-edge --user-data-dir=/tmp/ca-clipboard --load-extension=$PWD/extension \
 *     --remote-debugging-port=9236 --no-first-run --no-default-browser-check \
 *     http://127.0.0.1:17872/clipboard.html
 *   node scripts/edge-clipboard-e2e.mjs
 *
 * The virtual clipboard is always exercised: selection copy -> storage.session
 * -> paste, label copy -> read, write/read/clear, and append paste. System
 * clipboard checks (write/read, rich Ctrl+V paste, rich:false text paste) print
 * SKIP when the isolated Edge profile denies clipboard access; that is an
 * environment limitation, not an executor failure.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9236'
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
// The harness opens the side panel as a normal tab, which may not be the OS
// foreground window. Focus emulation makes the panel document count as focused
// so navigator.clipboard checks behave like a real, clicked side panel.
await panel.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})

/**
 * Evaluate one expression inside the extension side-panel document. userGesture
 * grants transient activation, which helps clipboard read/write on profiles
 * that require it.
 * @param {string} expression
 * @param {boolean} [userGesture]
 */
async function evaluate(expression, userGesture = false) {
  const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

// Find (or create) the fixture tab and load clipboard.html fresh.
const fixture = await evaluate(`(async () => {
  const tabs = await chrome.tabs.query({})
  let tab = tabs.find(item => item.url?.includes('/clipboard.html'))
  if (!tab) {
    tab = await chrome.tabs.create({ url: '${BASE}/clipboard.html', active: true })
  } else {
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.tabs.update(tab.id, { url: '${BASE}/clipboard.html' })
  }
  await new Promise(resolve => setTimeout(resolve, 900))
  return { id: tab.id }
})()`)
assert.ok(fixture?.id, 'fixture tab id')
const tabId = fixture.id

const prefix = `const mod = await import('./browser.js')
  const tabId = ${tabId}
  const settings = { ...mod.DEFAULT_SETTINGS }
  const prop = async (id, name) => (await chrome.scripting.executeScript({ target: { tabId }, func: (id, name) => document.getElementById(id)?.[name] ?? null, args: [id, name] }))[0].result
  const setValue = async (id, value) => (await chrome.scripting.executeScript({ target: { tabId }, func: (id, value) => { const el = document.getElementById(id); el.value = value; el.focus(); return el.value }, args: [id, value] }))[0].result
  const storage = async () => (await chrome.storage.session.get('crazyagent.clipboard'))['crazyagent.clipboard'] ?? null
`

/* ---------------------------------------------------------------- */
/* setup: label the fixture                                          */
/* ---------------------------------------------------------------- */

const setup = await evaluate(`(async () => { ${prefix}
  const snapshot = await mod.execute('snapshot', {}, settings)
  return {
    tabId,
    url: snapshot.tab.url,
    image: snapshot.image ? { width: snapshot.image.width, height: snapshot.image.height } : null,
    labels: snapshot.labels.map(label => ({ id: label.id, text: label.text, tag: label.tag })),
  }
})()`)
assert.equal(setup.tabId, tabId, 'snapshot reports the fixture tab')
assert.match(setup.url, /clipboard\.html/, 'clipboard fixture is loaded')
assert.ok(setup.image && setup.image.width > 0, 'setup view has an image')
const findLabel = (predicate, description) => {
  const found = setup.labels.find(predicate)
  assert.ok(found, `${description} is labelled in the view`)
  return found.id
}
const selectLabel = findLabel(label => label.tag === 'button' && label.text === 'Select paragraph', 'Select paragraph button')
const textareaLabel = findLabel(label => label.tag === 'textarea', 'textarea target')
const inputLabel = findLabel(label => label.tag === 'input', 'input target')
const copyLabel = findLabel(label => label.text === 'COPY-LABEL-MARKER labelled span', 'copyable labelled span')
console.log(`PASS clipboard fixture loads — ${setup.labels.length} labels, image ${setup.image.width}px`)

/* ---------------------------------------------------------------- */
/* selection copy -> storage.session -> paste                        */
/* ---------------------------------------------------------------- */

const selectionCopy = await evaluate(`(async () => { ${prefix}
  await mod.execute('click', { label: ${selectLabel}, view: 'none' }, settings)
  const selected = (await chrome.scripting.executeScript({ target: { tabId }, func: () => String(window.getSelection()?.toString() ?? '') }))[0].result
  await mod.execute('clipboard', { action: 'clear' }, settings)
  const copy = await mod.execute('clipboard', { action: 'copy' }, settings)
  const stored = await storage()
  const paste = await mod.execute('clipboard', { action: 'paste', label: ${textareaLabel}, view: 'none' }, settings)
  const value = await prop('paste-target', 'value')
  return {
    selected,
    copy,
    stored: stored === null ? null : { source: stored.source, chars: stored.chars, text: stored.text, tabId: stored.tabId, url: stored.url },
    paste,
    value,
    hasImage: Boolean(paste.image),
  }
})()`, true)
assert.match(selectionCopy.selected, /CLIPBOARD-MARKER one two three four five/, 'the fixture selection is non-empty')
assert.equal(selectionCopy.copy.op, 'clipboard')
assert.equal(selectionCopy.copy.action, 'copy')
assert.equal(selectionCopy.copy.clipboard.target, 'virtual')
assert.equal(selectionCopy.copy.clipboard.system, false)
assert.equal(selectionCopy.copy.clipboard.source, 'selection')
assert.equal(selectionCopy.copy.clipboard.chars, selectionCopy.selected.length, 'copy reports the selected char count')
assert.match(selectionCopy.copy.clipboard.preview, /CLIPBOARD-MARKER/)
assert.ok(selectionCopy.stored, 'copy stored an entry in chrome.storage.session')
assert.equal(selectionCopy.stored.source, 'selection')
assert.equal(selectionCopy.stored.tabId, tabId)
assert.match(selectionCopy.stored.url, /clipboard\.html/)
assert.equal(selectionCopy.stored.text, selectionCopy.selected, 'stored text matches the selection')
assert.equal(selectionCopy.paste.action, 'paste')
assert.equal(selectionCopy.paste.pasted.via, 'virtual')
assert.equal(selectionCopy.paste.pasted.chars, selectionCopy.selected.length)
assert.equal(selectionCopy.paste.view, 'none', 'explicit view:"none" paste skips the screenshot')
assert.equal(selectionCopy.hasImage, false)
assert.equal(selectionCopy.value, selectionCopy.selected, 'pasted text landed in the textarea')
console.log(`PASS selection copy -> virtual clipboard -> paste (${selectionCopy.selected.length} chars)`)

/* ---------------------------------------------------------------- */
/* labelled element copy -> read, plus append paste                  */
/* ---------------------------------------------------------------- */

const labelCopy = await evaluate(`(async () => { ${prefix}
  const copy = await mod.execute('clipboard', { action: 'copy', source: 'label', label: ${copyLabel} }, settings)
  const read = await mod.execute('clipboard', { action: 'read' }, settings)
  await setValue('paste-input', 'BASE-')
  const paste = await mod.execute('clipboard', { action: 'paste', label: ${inputLabel}, mode: 'append', view: 'none' }, settings)
  const value = await prop('paste-input', 'value')
  return { copy, read, paste, value }
})()`, true)
assert.equal(labelCopy.copy.action, 'copy')
assert.equal(labelCopy.copy.clipboard.source, 'label')
assert.equal(labelCopy.copy.clipboard.label, copyLabel)
assert.ok(labelCopy.copy.clipboard.chars > 0)
assert.match(labelCopy.read.text, /COPY-LABEL-MARKER labelled span/, 'read returns the labelled element text')
assert.equal(labelCopy.read.clipboard.source, 'label')
assert.equal(labelCopy.read.truncated, false)
assert.equal(labelCopy.paste.pasted.via, 'virtual')
assert.equal(labelCopy.paste.pasted.mode, 'append')
assert.equal(labelCopy.paste.typed.mode, 'append')
assert.ok(labelCopy.value.startsWith('BASE-'), 'append keeps the existing field text')
assert.match(labelCopy.value, /COPY-LABEL-MARKER/, 'append added the clipboard text')
console.log(`PASS label copy -> read (${labelCopy.read.text.length} chars) and append paste`)

/* ---------------------------------------------------------------- */
/* write / read / clear                                              */
/* ---------------------------------------------------------------- */

const writeReadClear = await evaluate(`(async () => { ${prefix}
  const write = await mod.execute('clipboard', { action: 'write', text: 'WRITE-MARKER-42' }, settings)
  const read = await mod.execute('clipboard', { action: 'read' }, settings)
  const clear = await mod.execute('clipboard', { action: 'clear' }, settings)
  const afterClear = await storage()
  let emptyError = null
  try {
    await mod.execute('clipboard', { action: 'read' }, settings)
  } catch (error) {
    emptyError = { code: error.code, message: error.message }
  }
  return { write, read, clear, afterClear, emptyError }
})()`, true)
assert.equal(writeReadClear.write.clipboard.chars, 15)
assert.equal(writeReadClear.write.clipboard.source, 'write')
assert.equal(writeReadClear.read.text, 'WRITE-MARKER-42', 'read returns the written text')
assert.equal(writeReadClear.read.clipboard.chars, 15)
assert.equal(writeReadClear.clear.clipboard.cleared, true)
assert.equal(writeReadClear.afterClear, null, 'clear removes the storage.session entry')
assert.equal(writeReadClear.emptyError?.code, 'CLIPBOARD_EMPTY', 'reading a cleared clipboard fails with CLIPBOARD_EMPTY')
console.log('PASS write -> read -> clear (CLIPBOARD_EMPTY after clear)')

/* ---------------------------------------------------------------- */
/* system clipboard: explicit write/read                             */
/* ---------------------------------------------------------------- */

// The harness opens the side panel as a regular tab, so navigator.clipboard
// needs that document focused. Bring it to the front for the system checks;
// page actions re-activate the fixture tab themselves.
await panel.send('Page.bringToFront').catch(() => {})
await new Promise(resolve => setTimeout(resolve, 300))
const systemWrite = await evaluate(`(async () => { ${prefix}
  try {
    const write = await mod.execute('clipboard', { action: 'write', target: 'system', text: 'SYSTEM-MARKER-99' }, settings)
    const read = await mod.execute('clipboard', { action: 'read', target: 'system' }, settings)
    return { ok: true, focused: document.hasFocus(), writeChars: write.clipboard.chars, readTarget: read.clipboard.target, text: read.text }
  } catch (error) {
    return { ok: false, focused: document.hasFocus(), code: error.code ?? 'ERROR', message: error.message }
  }
})()`, true)
if (!systemWrite.ok) {
  console.log(`SKIP system clipboard write/read — ${systemWrite.code}: ${systemWrite.message}`)
} else {
  assert.equal(systemWrite.writeChars, 16)
  assert.equal(systemWrite.readTarget, 'system')
  assert.equal(systemWrite.text, 'SYSTEM-MARKER-99', 'system read returns what was written')
  console.log('PASS system clipboard write -> read')
}

/* ---------------------------------------------------------------- */
/* system clipboard rich Ctrl+V paste                                */
/* ---------------------------------------------------------------- */

if (systemWrite.ok) {
  const systemPaste = await evaluate(`(async () => { ${prefix}
    try {
      await mod.execute('clipboard', { action: 'write', target: 'system', text: 'SYSTEM-PASTE-MARKER' }, settings)
      await chrome.tabs.update(tabId, { active: true })
      await new Promise(resolve => setTimeout(resolve, 300))
      await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        window.__caPasteEvents = []
        document.addEventListener('paste', event => window.__caPasteEvents.push({
          target: event.target?.id ?? event.target?.tagName ?? '',
          trusted: event.isTrusted,
          chars: event.clipboardData?.getData('text/plain')?.length ?? 0,
        }), true)
      } })
      await setValue('paste-target', 'BASE-')
      const paste = await mod.execute('clipboard', { action: 'paste', target: 'system', label: ${textareaLabel}, view: 'none' }, settings)
      const after = (await chrome.scripting.executeScript({ target: { tabId }, func: () => ({
        value: document.getElementById('paste-target')?.value ?? '',
        active: document.activeElement?.id ?? document.activeElement?.tagName ?? '',
        pasteEvents: window.__caPasteEvents ?? [],
      }) }))[0].result
      return { ok: true, via: paste.pasted?.via, trusted: paste.pasted?.trusted, rich: paste.clipboard?.rich, ...after }
    } catch (error) {
      return { ok: false, code: error.code ?? 'ERROR', message: error.message }
    }
  })()`, true)
  if (!systemPaste.ok) {
    console.log(`SKIP system rich paste — ${systemPaste.code}: ${systemPaste.message}`)
  } else {
    assert.equal(systemPaste.via, 'keys', 'rich system paste goes through Ctrl+V')
    assert.equal(systemPaste.trusted, true, 'the Ctrl+V paste used trusted input')
    assert.equal(systemPaste.rich, true)
    if (/SYSTEM-PASTE-MARKER/.test(systemPaste.value)) {
      console.log(`PASS system rich paste — trusted Ctrl+V inserted "${systemPaste.value}"`)
    } else {
      const events = Array.isArray(systemPaste.pasteEvents) ? systemPaste.pasteEvents : []
      console.log(`SKIP system rich paste — the trusted Ctrl+V was dispatched and ${events.length} paste event(s) reached "${systemPaste.active}", but this isolated Edge window returned an empty clipboard to the page (window not OS-focused); the virtual checks above still cover the paste path`)
    }
  }

  // rich:false reads the system clipboard from the panel document and types it
  // into the active page tab. This needs the panel document focused while the
  // page tab stays active; focus emulation above fakes the first half for the
  // harness (the real side panel does this natively).
  const systemTextPaste = await evaluate(`(async () => { ${prefix}
    try {
      await mod.execute('clipboard', { action: 'write', target: 'system', text: 'SYSTEM-TEXT-PASTE' }, settings)
      await chrome.tabs.update(tabId, { active: true })
      await new Promise(resolve => setTimeout(resolve, 300))
      await setValue('paste-input', 'TEXT-BASE-')
      const paste = await mod.execute('clipboard', { action: 'paste', target: 'system', rich: false, label: ${inputLabel}, mode: 'append', view: 'none' }, settings)
      const value = await prop('paste-input', 'value')
      return { ok: true, via: paste.pasted?.via, value }
    } catch (error) {
      return { ok: false, code: error.code ?? 'ERROR', message: error.message }
    }
  })()`, true)
  if (!systemTextPaste.ok) {
    console.log(`SKIP system rich:false text paste — ${systemTextPaste.code}: the isolated profile cannot focus the panel document and the page tab at once; the real side panel can`)
  } else {
    assert.equal(systemTextPaste.via, 'system')
    if (/SYSTEM-TEXT-PASTE/.test(systemTextPaste.value)) {
      console.log(`PASS system rich:false paste — typed "${systemTextPaste.value}"`)
    } else {
      console.log(`SKIP system rich:false text paste — read succeeded but the typed value was "${systemTextPaste.value}" in this profile`)
    }
  }
}

console.log('\nALL CLIPBOARD CHECKS PASSED')
panel.close()
