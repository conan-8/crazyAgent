#!/usr/bin/env node
/** Isolated real provider/executor acceptance for browser_drag. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { apply } from '../packages/dsh-browser-extension/lib/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
const CDP_PORT = Number(process.env.CDP_PORT ?? (20_000 + process.pid % 20_000))
const CDP = `http://127.0.0.1:${CDP_PORT}`
const USER_DIR = mkdtempSync(join(tmpdir(), 'crazyagent-drag-e2e-'))
const FIXTURES = join(ROOT, 'e2e', 'fixtures')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = message => process.stderr.write(`[drag-e2e] ${message}\n`)
const extensionId = (() => {
  const hex = createHash('sha256').update(join(ROOT, 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + Number.parseInt(char, 16))).join('')
})()

function makeContext() {
  const tools = new Map()
  const disposers = []
  const listeners = new Map()
  const ctx = {
    logger: { info: () => {} },
    browserUse: { register: () => () => {} },
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
    effect: fn => {
      const iterator = fn()
      let step = iterator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = iterator.next()
      }
      return () => { for (const dispose of disposers.reverse()) dispose() }
    },
  }
  return { ctx, tools, dispose: () => { for (const dispose of disposers.reverse()) dispose() } }
}

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
  ws.on('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('CDP socket closed'))
    pending.clear()
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

const fixtureServer = createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0])
  const file = join(FIXTURES, path === '/' ? 'drag.html' : path)
  if (!file.startsWith(`${FIXTURES}/`) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.txt': 'text/plain' }
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
  response.end(readFileSync(file))
})

let edge
let browser
let panel
let fixture
let relayServer
let provider
let debuggerStarted = false
let fixtureUrl
const commands = []
const rawResults = new Map()
let uiSocket
let toolsSocket

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}

async function cleanup() {
  if (debuggerStarted && panel) {
    await evaluate(`(async () => { const mod = await import('./browser.js'); await mod.endDebuggerRun(); return 'ended' })()`).catch(() => {})
  }
  try { provider?.dispose() } catch {}
  for (const client of relayServer?.clients ?? []) client.terminate()
  if (relayServer) await new Promise(resolve => relayServer.close(resolve)).catch(() => {})
  for (const socket of [panel, fixture, browser]) {
    try { socket?.close() } catch {}
  }
  fixtureServer.close()
  try { if (edge?.pid) process.kill(-edge.pid, 'SIGTERM') } catch {}
  if (!await waitForExit(edge, 2_500)) {
    try { if (edge?.pid) process.kill(-edge.pid, 'SIGKILL') } catch {}
    await waitForExit(edge, 1_000)
  }
  try { rmSync(USER_DIR, { recursive: true, force: true }) } catch {}
}
process.on('SIGINT', () => { void cleanup().finally(() => process.exit(1)) })
process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(1)) })

async function evaluate(expression) {
  const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

async function fixtureEvaluate(expression) {
  const result = await fixture.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

async function state() {
  return fixtureEvaluate('window.dragFixtureSnapshot()')
}

let callSequence = 0
async function call(name, args) {
  const before = commands.length
  try {
    const content = await provider.tools.get(name).execute(args, {
      callId: `drag-e2e-${++callSequence}`,
      signal: new AbortController().signal,
    })
    const command = commands.at(-1)
    return { content, command, result: rawResults.get(command?.id)?.result }
  } catch (error) {
    return {
      error: { code: error?.code ?? 'ERROR', message: error instanceof Error ? error.message : String(error) },
      commandCount: commands.length - before,
      command: commands.at(-1),
    }
  }
}

function successful(result) {
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.ok(result.result, 'real executor result was returned')
  return result.result
}

function label(view, text) {
  const found = view.labels.find(item => item.text === text)
  assert.ok(found, `label ${JSON.stringify(text)} exists`)
  return found
}

function center(item, view, image = false) {
  const point = { x: item.x + item.w / 2, y: item.y + item.h / 2 }
  if (!image) return point
  const scale = view.viewport.width / view.image.width
  return { x: point.x / scale, y: point.y / scale }
}

async function selectionPoints() {
  return fixtureEvaluate(`(() => {
    const element = document.getElementById('selection-text')
    const node = element.firstChild
    const phrase = 'selectable sentence'
    const start = node.textContent.indexOf(phrase)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + phrase.length)
    const first = range.getClientRects()[0]
    const last = range.getClientRects().item(range.getClientRects().length - 1)
    return {
      from: { x: first.left + 1, y: first.top + first.height / 2 },
      to: { x: last.right - 1, y: last.top + last.height / 2 },
    }
  })()`)
}

async function screenshot(detail = 'normal') {
  const response = await call('browser_screenshot', { detail })
  return successful(response)
}

async function reset(selector) {
  await fixture.send('Page.navigate', { url: fixtureUrl })
  await sleep(650)
  if (selector) {
    await fixtureEvaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', inline: 'center' })`)
    await sleep(120)
  }
  return screenshot()
}

function semantic(state) {
  return {
    pointerOrder: state.pointerOrder,
    html5Parent: state.html5Parent,
    html5Drop: state.html5Events[2],
    cloneParent: state.cloneParent,
    cloneCopies: state.cloneCopies,
    rangeValue: state.rangeValue,
    customValue: state.customValue,
    longParent: state.longPress.parent,
    longMoves: state.longPress.moves,
    rerenders: state.rerenders,
    selection: state.selection,
  }
}

function guardSemantic(state) {
  return { ...semantic(state), pointerEvents: state.pointerEvents }
}

try {
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject)
    fixtureServer.listen(0, '127.0.0.1', resolve)
  })
  fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/drag.html`

  relayServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => { relayServer.once('listening', resolve); relayServer.once('error', reject) })
  const bridgeUrl = `ws://127.0.0.1:${relayServer.address().port}/bridge`
  relayServer.on('connection', ws => {
    ws.on('message', async data => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') {
        log(`bridge hello ${message.role}`)
        if (message.role === 'ui') uiSocket = ws
        if (message.role === 'tools') toolsSocket = ws
        ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
        return
      }
      if (message.type === 'browser.command') {
        const command = message.command ?? {}
        commands.push({ id: message.id, op: command.op, args: command.args ?? {} })
        try {
          const outcome = await evaluate(`(async () => {
            const mod = await import('./browser.js')
            try {
              const result = await mod.execute(${JSON.stringify(command.op)}, ${JSON.stringify(command.args ?? {})}, { ...mod.DEFAULT_SETTINGS })
              return { result }
            } catch (error) {
              return { error: { code: error?.code ?? 'BROWSER_ERROR', message: error instanceof Error ? error.message : String(error), ...(typeof error?.mutationPossible === 'boolean' ? { mutationPossible: error.mutationPossible } : {}) } }
            }
          })()`)
          const response = outcome.error
            ? { v: 1, type: 'browser.result', id: message.id, ok: false, error: outcome.error }
            : { v: 1, type: 'browser.result', id: message.id, ok: true, result: outcome.result }
          rawResults.set(message.id, response)
          if (toolsSocket?.readyState === WebSocket.OPEN) toolsSocket.send(JSON.stringify(response))
        } catch (error) {
          const response = {
            v: 1,
            type: 'browser.result',
            id: message.id,
            ok: false,
            error: { code: error?.code ?? 'BROWSER_ERROR', message: error instanceof Error ? error.message : String(error) },
          }
          rawResults.set(message.id, response)
          if (toolsSocket?.readyState === WebSocket.OPEN) toolsSocket.send(JSON.stringify(response))
        }
        return
      }
      if (message.type === 'browser.result') {
        rawResults.set(message.id, message)
        if (toolsSocket?.readyState === WebSocket.OPEN) toolsSocket.send(JSON.stringify(message))
      }
    })
  })

  edge = spawn(EDGE_BIN, [
    `--user-data-dir=${USER_DIR}`,
    `--load-extension=${join(ROOT, 'extension')}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1200,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], { detached: true, stdio: 'ignore' })

  let version
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { version = await (await fetch(`${CDP}/json/version`)).json(); break } catch { await sleep(150) }
  }
  assert.ok(version, 'isolated Edge exposes CDP')
  browser = await connect(version.webSocketDebuggerUrl)
  const fixtureCreated = await browser.send('Target.createTarget', { url: fixtureUrl })
  const panelCreated = await browser.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true,
  })
  await sleep(900)
  const targets = await (await fetch(`${CDP}/json`)).json()
  fixture = await connect(targets.find(target => target.id === fixtureCreated.targetId).webSocketDebuggerUrl)
  panel = await connect(targets.find(target => target.id === panelCreated.targetId).webSocketDebuggerUrl)
  await panel.send('Runtime.enable')
  await fixture.send('Runtime.enable')
  await evaluate(`chrome.storage.local.set({ 'crazyagent.disclaimerPending': false, 'crazyagent.settings': ${JSON.stringify({
    bridgeUrl,
    token: '',
    captureWidth: 1280,
    quality: 72,
    autoCapture: true,
    showHitboxes: true,
    paused: false,
  })} })`)
  await evaluate('location.reload()')
  await sleep(1_000)

  provider = makeContext()
  apply(provider.ctx, { bridgeUrl, bridgeToken: '', requestTimeoutMs: 30_000 })
  for (let attempt = 0; attempt < 100 && !toolsSocket; attempt += 1) await sleep(50)
  assert.ok(toolsSocket && panel, 'provider and real side-panel executor share the test bridge')
  await browser.send('Target.activateTarget', { targetId: fixtureCreated.targetId })
  await sleep(300)
  debuggerStarted = true
  const started = await evaluate(`(async () => { const mod = await import('./browser.js'); await mod.beginDebuggerRun(); return 'started' })()`)
  assert.equal(started, 'started')

  let view = await reset('#pointer-alpha')
  const first = await call('browser_drag', {
    ref: `e${label(view, 'Pointer Alpha').id}`,
    to_ref: `e${label(view, 'Pointer Gamma').id}`,
    to_position: 'bottom',
  })
  let result = successful(first)
  assert.equal(result.observed, 'changed')
  assert.equal(result.outcome.ok, true)
  assert.equal(result.mutationPossible, true)
  assert.ok(result.drag.sourceOutcome.signals.includes('index-changed'))
  assert.deepEqual((await state()).pointerOrder, ['Beta', 'Gamma', 'Alpha'])
  assert.equal((await state()).html5Parent, 'html5-origin')
  assert.equal((await state()).cloneCopies, 0)
  log('PASS pointer sortable after reorder with collateral checks')

  view = await screenshot()
  const gamma = center(label(view, 'Pointer Gamma'), view)
  const beta = center(label(view, 'Pointer Beta'), view)
  beta.y = label(view, 'Pointer Beta').y + 2
  const second = await call('browser_drag', { x: gamma.x, y: gamma.y, to_x: beta.x, to_y: beta.y, space: 'css' })
  result = successful(second)
  assert.equal(result.observed, 'changed', JSON.stringify({ gamma, beta, drag: result.drag, state: await state() }))
  assert.deepEqual((await state()).pointerOrder, ['Gamma', 'Beta', 'Alpha'])
  log('PASS pointer sortable before/top reorder through CSS coordinates')

  view = await reset('#html5-source')
  const accepted = await call('browser_drag', {
    label: label(view, 'HTML5 payload').id,
    to_label: label(view, 'HTML5 accepting destination').id,
  })
  result = successful(accepted)
  assert.equal(result.observed, 'changed')
  assert.equal(result.drag.dispatch.mode, 'html5')
  assert.equal(result.drag.sourceOutcome.checks.parent, 'changed')
  assert.equal(result.drag.destinationOutcome.checks.children, 'changed')
  let current = await state()
  assert.equal(current.html5Parent, 'html5-accept')
  assert.equal(current.html5Events[2], 1)
  assert.equal(current.html5Payload, 'fixture-payload-742')
  assert.deepEqual(current.pointerOrder, ['Alpha', 'Beta', 'Gamma'])
  assert.equal(current.cloneCopies, 0)
  log('PASS accepted native HTML5 move with independent drop receipt')

  view = await reset('#html5-source')
  const refusedBefore = semantic(await state())
  const refused = await call('browser_drag', {
    label: label(view, 'HTML5 payload').id,
    to_label: label(view, 'HTML5 rejecting destination').id,
  })
  result = successful(refused)
  assert.equal(result.observed, 'unchanged')
  assert.equal(result.outcome.ok, false)
  assert.equal(result.error.code, 'DRAG_NO_EFFECT')
  assert.equal(result.mutationPossible, true)
  current = await state()
  assert.deepEqual(semantic(current), refusedBefore, 'refused drop has no application-state mutation')
  assert.equal(current.html5Events[0] > 0 && current.html5Events[3] > 0, true, 'native drag events are only diagnostic receipts')
  assert.equal(current.html5Events[2], 0)
  log('PASS refused HTML5 drop is measured no-op with zero application-state mutation')

  view = await reset('#clone-source')
  const cloneFrom = center(label(view, 'Clone payload'), view, true)
  const cloneTo = center(label(view, 'Clone accepting destination'), view, true)
  const cloned = await call('browser_drag', {
    x: cloneFrom.x,
    y: cloneFrom.y,
    to_x: cloneTo.x,
    to_y: cloneTo.y,
    view_id: view.viewId,
  })
  result = successful(cloned)
  assert.equal(result.observed, 'changed')
  assert.equal(result.drag.sourceOutcome.changed, false)
  assert.equal(result.drag.destinationOutcome.changed, true)
  assert.equal(result.drag.destinationOutcome.checks.children, 'changed')
  current = await state()
  assert.equal(current.cloneParent, 'clone-origin')
  assert.equal(current.cloneCopies, 1)
  assert.equal(current.html5Parent, 'html5-origin')
  log('PASS static-source clone succeeds from destination-only evidence with view_id mapping')

  view = await reset('#range')
  const nativeGeometry = await fixtureEvaluate(`(() => { const rect = document.getElementById('range').getBoundingClientRect(); return { left: rect.left, width: rect.width, center: rect.left + rect.width / 2 } })()`)
  const expectedNative = Math.max(0, Math.min(100, Math.round((nativeGeometry.center + 80 - nativeGeometry.left - 8) / Math.max(1, nativeGeometry.width - 16) * 100)))
  const ranged = await call('browser_drag', { label: label(view, 'Native range').id, dx: 80 })
  result = successful(ranged)
  assert.equal(result.observed, 'changed')
  assert.equal(result.drag.sourceOutcome.checks.value, 'changed')
  current = await state()
  assert.ok(Number(current.rangeValue) > 20)
  assert.ok(Math.abs(Number(current.rangeValue) - expectedNative) <= 6, JSON.stringify({ actual: current.rangeValue, expectedNative, nativeGeometry }))
  assert.equal(current.customValue, '20')
  const rangeLabel = label(view, 'Native range').id
  const exact = await call('browser_type', { label: rangeLabel, text: '35', mode: 'replace', view: 'none' })
  successful(exact)
  current = await state()
  assert.equal(current.rangeValue, '35')
  assert.ok(current.rangeEvents[0] >= 1 && current.rangeEvents[1] >= 1)
  log('PASS native range drag readback and exact browser_type value/events')

  view = await reset('#custom-thumb')
  const customGeometry = await fixtureEvaluate(`(() => { const track = document.getElementById('custom-track').getBoundingClientRect(); const thumb = document.getElementById('custom-thumb').getBoundingClientRect(); return { left: track.left, width: track.width, thumbCenter: thumb.left + thumb.width / 2 } })()`)
  const expectedCustom = Math.round(Math.max(0, Math.min(100, (customGeometry.thumbCenter + 80 - customGeometry.left) / customGeometry.width * 100)))
  const custom = await call('browser_drag', { label: label(view, 'Custom slider').id, dx: 80 })
  result = successful(custom)
  assert.equal(result.observed, 'changed')
  assert.equal(result.drag.sourceOutcome.checks.ariaValueNow, 'changed')
  current = await state()
  assert.ok(Number(current.customValue) > 20)
  assert.ok(Math.abs(Number(current.customValue) - expectedCustom) <= 1, JSON.stringify({ actual: current.customValue, expectedCustom, customGeometry }))
  assert.equal(current.rangeValue, '20')
  log('PASS custom ARIA slider value and aria-valuenow readback')

  view = await reset('#longpress-item')
  const held = await call('browser_drag', {
    label: label(view, 'Long press item').id,
    to_label: label(view, 'Long press destination').id,
    hold_ms: 380,
  })
  result = successful(held)
  assert.equal(result.observed, 'changed')
  current = await state()
  assert.equal(current.longPress.parent, 'longpress-destination')
  assert.equal(current.longPress.moves, 1)
  assert.ok(current.longPress.heldMs >= 300)
  assert.equal(current.longPress.early, 0)
  log('PASS long-press activation and destination move')

  view = await reset('#longpress-item')
  const early = await call('browser_drag', {
    label: label(view, 'Long press item').id,
    to_label: label(view, 'Long press destination').id,
    hold_ms: 20,
  })
  result = successful(early)
  assert.equal(result.outcome.ok, false)
  assert.equal(result.error.code, 'DRAG_NO_EFFECT')
  current = await state()
  assert.equal(current.longPress.parent, 'longpress-origin')
  assert.equal(current.longPress.moves, 0)
  assert.equal(current.longPress.ready, 0)
  assert.ok(current.longPress.early > 0)
  log('PASS early long-press movement is measured no-op')

  view = await reset('#noop')
  const noopBefore = semantic(await state())
  const noop = await call('browser_drag', { label: label(view, 'Intentional no-op').id, dx: 40 })
  result = successful(noop)
  assert.equal(result.observed, 'unchanged')
  assert.equal(result.outcome.ok, false)
  assert.equal(result.error.code, 'DRAG_NO_EFFECT')
  current = await state()
  assert.deepEqual(semantic(current), noopBefore, 'intentional no-op has zero application-state mutation')
  assert.ok(current.noopEvents[0] > 0 && current.noopEvents[2] > 0, 'input counters independently show dispatch occurred')
  log('PASS intentional no-op excludes unrelated event-counter evidence')

  view = await reset('#rerender-item')
  const rerendered = await call('browser_drag', { label: label(view, 'Rerender item').id, dx: 60 })
  result = successful(rerendered)
  assert.equal(result.observed, 'unknown')
  assert.equal(result.outcome.ok, null)
  assert.equal(result.changed, null)
  assert.equal(result.drag.sourceOutcome.changed, null)
  current = await state()
  assert.equal(current.rerenders, 1)
  assert.equal(await fixtureEvaluate(`document.getElementById('rerender-state').dataset.originalConnected`), 'false')
  assert.equal(current.html5Parent, 'html5-origin')
  assert.equal(current.cloneCopies, 0)
  log('PASS detached rerender is unknown, not moved or no-op')

  view = await reset('#selection-text')
  let points = await selectionPoints()
  const selected = await call('browser_drag', { x: points.from.x, y: points.from.y, to_x: points.to.x, to_y: points.to.y, space: 'css' })
  result = successful(selected)
  assert.equal(result.observed, 'changed')
  assert.equal(result.drag.sourceOutcome.checks.selection, 'changed')
  assert.equal((await state()).selection, 'selectable sentence')
  log('PASS exact-substring selection with selection readback')

  view = await reset('#selection-text')
  points = await selectionPoints()
  const collapsed = await call('browser_drag', { x: points.from.x, y: points.from.y, to_x: points.from.x, to_y: points.from.y, space: 'css' })
  result = successful(collapsed)
  assert.equal(result.observed, 'unchanged')
  assert.equal(result.outcome.ok, false)
  assert.equal(result.error.code, 'DRAG_NO_EFFECT')
  assert.equal((await state()).selection, '')
  log('PASS collapsed/no-selection case remains measured no-op')

  view = await reset('#pointer-gamma')
  await fixtureEvaluate('window.__dragTestMid = "source-move"')
  const sourceMoved = await call('browser_drag', {
    label: label(view, 'Pointer Gamma').id,
    to_label: label(view, 'Pointer Beta').id,
    to_position: 'top',
    destinationHoldMs: 100,
  })
  assert.equal(sourceMoved.error.code, 'DRAG_STALE_TARGET', JSON.stringify(sourceMoved.error))
  assert.equal(sourceMoved.error.mutationPossible, true)
  current = await state()
  assert.deepEqual(current.pointerOrder, ['Alpha', 'Beta', 'Gamma'])
  assert.deepEqual(current.midDragEvents, ['source-move'])
  assert.equal(current.pointerCommits, 0)
  assert.equal(current.pointerLastDrop.x, 0)
  assert.ok(current.pointerEvents[0] > 0 && current.pointerEvents[2] > 0)
  log('PASS mid-drag source movement cancels without drop or collateral')

  view = await reset('#pointer-gamma')
  await fixtureEvaluate('window.__dragTestMid = "destination-detach"')
  const destinationDetached = await call('browser_drag', {
    label: label(view, 'Pointer Gamma').id,
    to_label: label(view, 'Pointer Beta').id,
    to_position: 'top',
    destinationHoldMs: 100,
  })
  assert.equal(destinationDetached.error.code, 'DRAG_STALE_TARGET')
  assert.equal(destinationDetached.error.mutationPossible, true)
  current = await state()
  assert.deepEqual(current.pointerOrder, ['Alpha', 'Gamma'])
  assert.deepEqual(current.midDragEvents, ['destination-detach'])
  assert.equal(current.pointerCommits, 0)
  assert.equal(current.pointerLastDrop.x, 0)
  assert.ok(current.pointerEvents[0] > 0 && current.pointerEvents[2] > 0)
  log('PASS mid-drag destination detachment cancels without drop or collateral')

  view = await reset('#pointer-alpha')
  const guardBefore = guardSemantic(await state())
  let commandCount = commands.length
  const ambiguous = await call('browser_drag', { label: label(view, 'Pointer Alpha').id, ref: 'e1', dx: 20 })
  assert.ok(ambiguous.error)
  assert.equal(commands.length, commandCount, 'provider rejects ambiguous sources before bridge traffic')
  assert.deepEqual(guardSemantic(await state()), guardBefore)

  const offscreen = await call('browser_drag', {
    label: label(view, 'Pointer Alpha').id, to_x: 9999, to_y: 9999, space: 'css',
  })
  assert.equal(offscreen.error.code, 'DRAG_OFF_SCREEN')
  assert.deepEqual(guardSemantic(await state()), guardBefore)
  log('PASS ambiguous and off-screen guards cause no application mutation')

  const alphaImage = center(label(view, 'Pointer Alpha'), view, true)
  const betaImage = center(label(view, 'Pointer Beta'), view, true)
  const alphaCss = center(label(view, 'Pointer Alpha'), view)
  const betaCss = center(label(view, 'Pointer Beta'), view)
  await fixtureEvaluate('window.scrollTo(0, 200)')
  await sleep(100)
  const stale = await call('browser_drag', {
    x: alphaImage.x, y: alphaImage.y, to_x: betaImage.x, to_y: betaImage.y, view_id: view.viewId,
  })
  assert.equal(stale.error.code, 'STALE_VIEW')
  assert.deepEqual(guardSemantic(await state()), guardBefore)
  log('PASS stale image view is refused before dispatch')

  const staleCss = await call('browser_drag', {
    x: alphaCss.x, y: alphaCss.y, to_x: betaCss.x, to_y: betaCss.y, space: 'css',
  })
  assert.equal(staleCss.error.code, 'STALE_VIEW')
  assert.deepEqual(guardSemantic(await state()), guardBefore, 'scrolled CSS view must produce zero pointer input')
  log('PASS scrolled CSS view is refused with zero pointer input')

  view = await reset('#pointer-alpha')
  const firstScale = center(label(view, 'Pointer Alpha'), view, true)
  const firstDestination = center(label(view, 'Pointer Beta'), view, true)
  await screenshot('fast')
  const scaleAmbiguous = await call('browser_drag', {
    x: firstScale.x, y: firstScale.y, to_x: firstDestination.x, to_y: firstDestination.y,
  })
  assert.equal(scaleAmbiguous.error.code, 'AMBIGUOUS_VIEW')
  assert.deepEqual(guardSemantic(await state()), guardBefore)
  log('PASS ambiguous image scale is refused before dispatch')

  view = await reset('#child-drag-frame')
  const childFrame = await call('browser_drag', { label: label(view, 'Child frame drag item').id, dx: 20 })
  assert.equal(childFrame.error.code, 'DRAG_FRAME_UNSUPPORTED')
  assert.equal(childFrame.error.mutationPossible, false)
  current = await state()
  assert.equal(current.frameInputs, 0)
  assert.deepEqual(current.pointerEvents, [0, 0, 0])
  log('PASS unsupported child frame is refused with zero independent input counters')

  view = await reset('#longpress-item')
  const switchedDrag = call('browser_drag', {
    label: label(view, 'Long press item').id,
    to_label: label(view, 'Long press destination').id,
    hold_ms: 1000,
  })
  await sleep(150)
  const otherTabId = await evaluate(`(async () => {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true })
    return tab.id
  })()`)
  try {
    const switched = await switchedDrag
    assert.equal(switched.error.code, 'DRAG_STALE_TAB')
    assert.equal(switched.error.mutationPossible, true)
    assert.equal(switched.result, undefined)
    assert.equal(switched.content, undefined, 'no other-tab success content was produced')
    assert.equal((await state()).longPress.parent, 'longpress-destination', 'the original tab may have mutated, but its result is stale/unverified')
    log('PASS active-tab switch after measurement returns stale/unverified without another-tab view')
  } finally {
    await evaluate(`(async () => {
      const tabs = await chrome.tabs.query({})
      const fixture = tabs.find(item => item.url?.includes('drag.html'))
      if (fixture) await chrome.tabs.update(fixture.id, { active: true })
      await chrome.tabs.remove(${otherTabId})
      return true
    })()`).catch(() => {})
  }

  await evaluate(`(async () => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find(item => item.url?.includes('drag.html'))
    await chrome.tabs.update(tab.id, { url: 'https://docs.google.com/document/d/isolated-drag-guard/edit' })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await chrome.tabs.get(tab.id)
      if (current.url?.startsWith('https://docs.google.com/document/d/isolated-drag-guard/')) return current.id
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Docs guard URL did not become active')
  })()`)
  const docs = await call('browser_drag', { label: 1, dx: 10 })
  assert.equal(docs.error.code, 'DOCS_CANVAS_SELECT_UNSUPPORTED')
  await fixture.send('Page.navigate', { url: fixtureUrl })
  await sleep(400)
  assert.equal((await state()).html5Parent, 'html5-origin')
  log('PASS Google Docs prohibition through real executor route')

  await evaluate(`(async () => { const mod = await import('./browser.js'); await mod.endDebuggerRun(); return 'ended' })()`)
  debuggerStarted = false
  log('ALL DRAG CHECKS PASSED')
} finally {
  await cleanup()
}
