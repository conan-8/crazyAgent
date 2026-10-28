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

const shadowRole = await evaluate(`(async () => { ${prefix}
  await mod.execute('click_role', { path: [{ role: 'button', name: 'Shadow action' }] }, settings)
  const state = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.querySelector('my-widget').shadowRoot.getElementById('shadow-state').textContent }))[0].result
  return { state }
})()`)
assert.equal(shadowRole.state, '2', 'accessible role/name traverses the open shadow root')
console.log('PASS shadow DOM role/name click')

const frameLabels = view.labels.filter(label => label.frame).map(label => label.id)
const frameClicks = await evaluate(`(async () => { ${prefix}
  const ids = ${JSON.stringify(frameLabels)}
  const results = []
  for (const label of ids) results.push((await mod.execute('click', { label }, settings)).changed)
  return { results, states: await frameStates() }
})()`)
assert.ok(frameClicks.states.some(item => item.state === '1'), 'an iframe button received the click')
console.log('PASS iframe click (same/cross origin)')

await evaluate(`(async () => { ${prefix}
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const button = document.getElementById('inner-button')
      if (button) button.setAttribute('aria-label', location.hostname === 'localhost' ? 'Cross frame action' : 'Same frame action')
    },
  })
})()`)
for (const kind of ['same', 'cross']) {
  const name = kind === 'same' ? 'Same frame action' : 'Cross frame action'
  const host = kind === 'same' ? '127.0.0.1' : 'localhost'
  const baseline = await evaluate(`(async () => { ${prefix}
    await mod.execute('click_role', { path: [{ role: 'button', name: ${JSON.stringify(name)} }] }, settings)
    return (await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => ({ host: location.hostname, state: document.getElementById('inner-state')?.textContent ?? null }) }))
      .map(result => result.result)
  })()`)
  assert.equal(baseline.find(item => item.host === host && item.state !== null)?.state, '2', `${kind}-origin target accepts an uncovered click`)
  for (const mode of ['overlay', 'clipped']) {
    const blocked = await evaluate(`(async () => { ${prefix}
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: ({ kind, mode }) => {
          document.getElementById('role-frame-overlay')?.remove()
          document.getElementById('same-clip').classList.remove('clipped')
          document.getElementById('cross-clip').classList.remove('clipped')
          if (mode === 'clipped') {
            document.getElementById(kind + '-clip').classList.add('clipped')
            return
          }
          const rect = document.getElementById(kind).getBoundingClientRect()
          const overlay = document.createElement('div')
          overlay.id = 'role-frame-overlay'
          overlay.style.cssText = 'position:fixed;z-index:2147483646;background:rgba(255,255,255,.01);'
          overlay.style.left = rect.left + 'px'
          overlay.style.top = rect.top + 'px'
          overlay.style.width = rect.width + 'px'
          overlay.style.height = rect.height + 'px'
          document.body.appendChild(overlay)
        },
        args: [{ kind: ${JSON.stringify(kind)}, mode: ${JSON.stringify(mode)} }],
      })
      let failure
      try { await mod.execute('click_role', { path: [{ role: 'button', name: ${JSON.stringify(name)} }] }, settings) }
      catch (error) { failure = { code: error.code || 'ERROR', message: error.message } }
      const states = (await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => ({ host: location.hostname, state: document.getElementById('inner-state')?.textContent ?? null }) }))
        .map(result => result.result)
      return { failure, states }
    })()`)
    assert.equal(blocked.failure?.code, 'ROLE_CLICK_COVERED', `${kind}-origin ${mode} is refused`)
    assert.equal(blocked.states.find(item => item.host === host && item.state !== null)?.state, '2', `${kind}-origin ${mode} sends no click`)
  }
  console.log(`PASS ${kind}-origin iframe top-overlay and ancestor-clipping refusal`)
}
await evaluate(`(async () => { ${prefix}
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
    document.getElementById('role-frame-overlay')?.remove()
    document.getElementById('same-clip').classList.remove('clipped')
    document.getElementById('cross-clip').classList.remove('clipped')
  } })
})()`)

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

const roleMenu = await evaluate(`(async () => { ${prefix}
  await chrome.tabs.update(tab.id, { url: 'http://127.0.0.1:17872/advanced.html' })
  await new Promise(resolve => setTimeout(resolve, 1000))
  await mod.execute('click_role', { path: [{ role: 'button', name: 'File' }, { role: 'menuitem', name: 'Page setup' }] }, settings)
  const state = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({
    count: document.getElementById('page-setup-count').textContent,
    dialogOpen: !document.getElementById('page-setup-dialog').hidden,
    expanded: document.getElementById('file-menu').getAttribute('aria-expanded'),
    popupHidden: document.getElementById('file-popup').hidden,
  }) }))[0].result
  return { state }
})()`)
assert.equal(roleMenu.state.count, '1', 'asynchronous File → Page setup item activated once')
assert.equal(roleMenu.state.dialogOpen, true, 'Page setup dialog opened')
assert.equal(roleMenu.state.expanded, 'false', 'File menu collapsed after item activation')
assert.equal(roleMenu.state.popupHidden, true, 'File popup closed after item activation')
console.log('PASS click-open asynchronous ARIA menu path')

console.log('\nALL ADVANCED CHECKS PASSED')
panel.close()
