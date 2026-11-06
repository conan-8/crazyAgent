#!/usr/bin/env node
/**
 * Real-extension check: viewport screenshots keep working when the Edge window
 * is unfocused or minimized.
 *
 * Chrome's `tabs.captureVisibleTab` only returns frames for a window Chrome is
 * painting on screen; behind another app or minimized the call can stay pending
 * until the executor watchdog fires and pauses captures. The executor now takes
 * a page-level CDP capture on those windows instead, without focusing or
 * restoring the window.
 *
 * This harness starts its own isolated Edge profile, fixture server, and CDP
 * port, so it never touches the user's browser profile and needs no companion.
 *
 *   node scripts/edge-capture-e2e.mjs
 *
 * Requires Node >= 22, an Edge binary (`microsoft-edge` on PATH, override with
 * EDGE_BIN), and a graphical session with a window manager so CDP can minimize
 * the window. Exit code 0 means every assertion passed.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
const CDP_PORT = Number(process.env.CDP_PORT ?? (10_000 + process.pid % 20_000))
const CDP = `http://127.0.0.1:${CDP_PORT}`
const USER_DIR = mkdtempSync(join(tmpdir(), 'crazyagent-capture-e2e-'))
const FIXTURES = join(ROOT, 'e2e', 'fixtures')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...parts) => process.stderr.write(`[capture-e2e] ${parts.join(' ')}\n`)

const extensionId = (() => {
  const hex = createHash('sha256').update(join(ROOT, 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + Number.parseInt(char, 16))).join('')
})()

const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.txt': 'text/plain' }
const fixtureServer = createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0])
  const file = join(FIXTURES, path === '/' ? 'click.html' : path)
  if (!existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
  response.end(readFileSync(file))
})
await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve))
const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/click.html`

async function json(path) {
  const response = await fetch(`${CDP}${path}`)
  return response.json()
}

async function connect(url) {
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let seq = 0
  const pending = new Map()
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
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

let edge
let cleanedUp = false
function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
async function cleanup(code) {
  if (cleanedUp) process.exit(code)
  cleanedUp = true
  try { if (edge?.pid) process.kill(-edge.pid, 'SIGTERM') } catch {}
  fixtureServer.close()
  // Let the isolated browser release its profile before deleting it; a failed
  // removal would leave a temp profile behind even though the test passed.
  if (!await waitForExit(edge, 2_500)) {
    try { if (edge?.pid) process.kill(-edge.pid, 'SIGKILL') } catch {}
    await waitForExit(edge, 1_000)
  }
  try { rmSync(USER_DIR, { recursive: true, force: true }) } catch {}
  process.exit(code)
}
process.on('SIGINT', () => void cleanup(1))
process.on('SIGTERM', () => void cleanup(1))

try {
  edge = spawn(EDGE_BIN, [
    `--user-data-dir=${USER_DIR}`,
    `--load-extension=${join(ROOT, 'extension')}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1200,800',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], { detached: true, stdio: 'ignore' })

  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { await json('/json/version'); break } catch { await sleep(150) }
  }
  const version = await json('/json/version')
  const browser = await connect(version.webSocketDebuggerUrl)

  // Fixture tab in window 1, plus the extension side-panel page as a background tab.
  const fixtureCreated = await browser.send('Target.createTarget', { url: fixtureUrl })
  await sleep(700)
  const panelCreated = await browser.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel/index.html`,
    background: true,
  })
  await sleep(700)
  const targets = await json('/json')
  const fixtureTarget = targets.find(target => target.id === fixtureCreated.targetId)
  const panelTarget = targets.find(target => target.id === panelCreated.targetId)
  if (!fixtureTarget || !panelTarget) throw new Error('edge did not expose the fixture and side-panel targets')

  const panel = await connect(panelTarget.webSocketDebuggerUrl)
  await panel.send('Runtime.enable')
  const evaluate = async expression => {
    const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result?.value
  }
  await evaluate(`chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify({
    bridgeUrl: 'ws://127.0.0.1:17871/bridge',
    token: '',
    captureWidth: 1280,
    quality: 72,
    autoCapture: true,
    showHitboxes: true,
    paused: false,
  })} })`)
  await browser.send('Target.activateTarget', { targetId: fixtureTarget.id })
  await sleep(800)
  const windowId = await evaluate('chrome.windows.getCurrent().then(window => window.id)')

  // Mirror the real turn lifecycle: one debugger lease spans the whole session,
  // so the debugging infobar's viewport resize happens before the first view and
  // the image must match the reported viewport on every capture path. Without a
  // lease the per-capture attach resizes the page between labelling and capture.
  const debuggerRun = await evaluate(`(async () => {
    const mod = await import('./browser.js')
    await mod.beginDebuggerRun()
    return 'started'
  })()`)
  assert.equal(debuggerRun, 'started', 'the capture fixture runs inside one debugger lease')

  /**
   * Run one viewport snapshot in the real executor, keep the window state on
   * both sides of it, and decode the returned image in the panel page so the
   * check sees pixels instead of trusting the tool result.
   */
  const capture = async label => {
    const outcome = await evaluate(`(async () => {
      const mod = await import('./browser.js')
      const windowBefore = await chrome.windows.getCurrent()
      const started = performance.now()
      let result
      let error
      try {
        // A capture width above any expected device-pixel width keeps the model
        // image at the raw capture size, so its dimensions can be compared with
        // viewport * devicePixelRatio without accounting for a downscale.
        result = await mod.execute('snapshot', {}, { ...mod.DEFAULT_SETTINGS, captureWidth: 4096 })
      } catch (failure) {
        error = { code: failure?.code, message: String(failure?.message ?? failure) }
      }
      const totalMs = Math.round(performance.now() - started)
      const windowAfter = await chrome.windows.getCurrent()
      const report = {
        windowBefore: { focused: windowBefore.focused, state: windowBefore.state },
        windowAfter: { focused: windowAfter.focused, state: windowAfter.state },
        totalMs,
      }
      if (error) return { ...report, ok: false, ...error }
      const image = result.image
      const blob = await (await fetch('data:' + image.mimeType + ';base64,' + image.data)).blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data
      let sum = 0
      let sumSquares = 0
      let count = 0
      let yellow = 0
      for (let index = 0; index < pixels.length; index += 16) {
        const red = pixels[index]
        const green = pixels[index + 1]
        const blue = pixels[index + 2]
        const luminance = (red + green + blue) / 3
        sum += luminance
        sumSquares += luminance * luminance
        count += 1
        if (red > 230 && green > 180 && blue < 80) yellow += 1
      }
      const mean = sum / count
      const tabs = await chrome.tabs.query({})
      const tab = tabs.find(item => item.url?.includes('click.html'))
      const dpr = tab
        ? (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.devicePixelRatio }))[0].result
        : undefined
      return {
        ...report,
        ok: true,
        viewId: result.viewId,
        labelCount: result.labelCount,
        captureMs: result.captureMs,
        viewport: result.viewport,
        dpr,
        cssPerImagePixel: image.cssPerImagePixel,
        image: { width: bitmap.width, height: bitmap.height, mimeType: image.mimeType, bytes: image.bytes },
        pixels: {
          sampled: count,
          mean: Math.round(mean),
          stdev: Math.round(Math.sqrt(Math.max(0, sumSquares / count - mean * mean))),
          yellowPixels: yellow,
        },
      }
    })()`)
    log(`${label}:`, JSON.stringify(outcome))
    return outcome
  }

  const assertCaptured = (outcome, label, { maxTotalMs } = {}) => {
    assert.equal(outcome.ok, true, `${label}: the snapshot must succeed: ${outcome.code} ${outcome.message ?? ''}`)
    assert.ok(outcome.viewId > 0, `${label}: a viewport capture must create a coordinate basis`)
    assert.ok(outcome.labelCount > 0, `${label}: the fixture controls must still be labelled`)
    assert.ok(outcome.pixels.stdev > 15, `${label}: the captured image must contain real page detail`)
    assert.ok(outcome.pixels.yellowPixels > 0, `${label}: the label overlays must be painted into the capture`)
    assert.equal(outcome.windowAfter.focused, outcome.windowBefore.focused, `${label}: capture must not move window focus`)
    assert.equal(outcome.windowAfter.state, outcome.windowBefore.state, `${label}: capture must not restore or minimize the window`)
    // The image must be exactly the tab viewport at the device-pixel scale on
    // every capture path: the visible-tab API and the page-level CDP capture
    // must report the same scale, otherwise image-space coordinates drift when
    // the window is unfocused or minimized.
    const dpr = outcome.dpr
    assert.ok(Number.isFinite(dpr) && dpr > 0, `${label}: the fixture tab must report a devicePixelRatio`)
    const expectedWidth = outcome.viewport.width * dpr
    const expectedHeight = outcome.viewport.height * dpr
    assert.ok(
      Math.abs(outcome.image.width - expectedWidth) <= 1 && Math.abs(outcome.image.height - expectedHeight) <= 1,
      `${label}: image ${outcome.image.width}x${outcome.image.height} must equal viewport ${outcome.viewport.width}x${outcome.viewport.height} x dpr ${dpr} (expected ${Math.round(expectedWidth)}x${Math.round(expectedHeight)})`,
    )
    assert.ok(
      Math.abs(outcome.cssPerImagePixel - 1 / dpr) < 0.01,
      `${label}: cssPerImagePixel ${outcome.cssPerImagePixel} must match 1/dpr ${(1 / dpr).toFixed(3)}`,
    )
    if (maxTotalMs !== undefined) {
      assert.ok(outcome.totalMs < maxTotalMs, `${label}: capture took ${outcome.totalMs}ms, expected under ${maxTotalMs}ms (no watchdog/cooldown pause)`)
    }
  }

  // 1. Baseline capture. The desktop may refuse to give this window focus in
  // an automation session; either way the baseline must capture successfully.
  const focusRequested = await evaluate(`(async () => chrome.windows.update((await chrome.windows.getCurrent()).id, { focused: true }).then(window => ({ focused: window.focused, state: window.state })))()`)
  await sleep(700)
  log('focus request:', JSON.stringify(focusRequested))
  const baseline = await capture(`baseline window (focus ${focusRequested.focused ? 'granted' : 'not granted'})`)
  assertCaptured(baseline, 'baseline window')

  /**
   * Click a labelled control through image-space `click_at` while the window is
   * unfocused or minimized, then verify independently from page state that the
   * right handler ran and that focus/window state did not change.
   */
  const imageClick = async (label, controlText, readId, otherId) => {
    const outcome = await evaluate(`(async () => {
      const mod = await import('./browser.js')
      const settings = { ...mod.DEFAULT_SETTINGS, captureWidth: 4096 }
      const tabs = await chrome.tabs.query({})
      const tab = tabs.find(item => item.url?.includes('click.html'))
      const read = async id => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: id => document.getElementById(id).textContent, args: [id] }))[0].result
      const windowBefore = await chrome.windows.getCurrent()
      const view = await mod.execute('snapshot', {}, settings)
      const target = view.labels.find(item => item.text === ${JSON.stringify(controlText)})
      if (!target) throw new Error('${controlText} label missing from the view')
      const scale = view.image.width / view.viewport.width
      const imageX = Math.round((target.x + target.w / 2) * scale)
      const imageY = Math.round((target.y + target.h / 2) * scale)
      const before = await read(${JSON.stringify(readId)})
      const otherBefore = await read(${JSON.stringify(otherId)})
      let error
      let click
      try {
        click = await mod.execute('click_at', { x: imageX, y: imageY, space: 'image', view: 'none' }, settings)
      } catch (failure) {
        error = { code: failure?.code, message: String(failure?.message ?? failure) }
      }
      const after = await read(${JSON.stringify(readId)})
      const otherAfter = await read(${JSON.stringify(otherId)})
      const windowAfter = await chrome.windows.getCurrent()
      return {
        ok: error === undefined,
        error,
        imageX,
        imageY,
        scale,
        viewport: view.viewport,
        image: { width: view.image.width, height: view.image.height },
        before,
        after,
        otherBefore,
        otherAfter,
        windowBefore: { focused: windowBefore.focused, state: windowBefore.state },
        windowAfter: { focused: windowAfter.focused, state: windowAfter.state },
        point: click?.point,
        changed: click?.changed,
      }
    })()`)
    log(`${label}:`, JSON.stringify(outcome))
    assert.equal(outcome.ok, true, `${label}: image-space click_at must succeed: ${outcome.error?.code} ${outcome.error?.message ?? ''}`)
    assert.equal(Number(outcome.after), Number(outcome.before) + 1, `${label}: the clicked Increment control must be the one that activated`)
    assert.equal(outcome.otherAfter, outcome.otherBefore, `${label}: a different control's counter must not change`)
    assert.equal(outcome.windowAfter.focused, outcome.windowBefore.focused, `${label}: image-space click must not move window focus`)
    assert.equal(outcome.windowAfter.state, outcome.windowBefore.state, `${label}: image-space click must not change the window state`)
    return outcome
  }

  // 2. Another browser window takes focus: the executor's window is unfocused.
  const secondWindow = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true })
  await sleep(500)
  await browser.send('Target.activateTarget', { targetId: secondWindow.targetId })
  await sleep(900)
  const unfocused = await capture('unfocused window')
  assertCaptured(unfocused, 'unfocused window')
  const unfocusedClick = await imageClick('unfocused image-space click', 'Increment', 'count', 'role-count')
  assert.ok(unfocusedClick.scale > 0, 'the unfocused view exposes a usable image scale')

  // 3. Minimize the executor window: captureVisibleTab hangs here, so this is
  // the case that used to trip the watchdog and pause screenshots.
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  await sleep(1200)
  const directProbe = await evaluate(`(async () => {
    const started = performance.now()
    try {
      const data = await Promise.race([
        chrome.tabs.captureVisibleTab((await chrome.windows.getCurrent()).id, { format: 'jpeg', quality: 60 }),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 2000)),
      ])
      return { ms: Math.round(performance.now() - started), resolved: data !== 'timeout', length: typeof data === 'string' ? data.length : 0 }
    } catch (error) {
      return { ms: Math.round(performance.now() - started), resolved: false, error: String(error?.message ?? error) }
    }
  })()`)
  log('minimized captureVisibleTab probe:', JSON.stringify(directProbe))
  const minimized = await capture('minimized window')
  assertCaptured(minimized, 'minimized window', { maxTotalMs: 4_500 })
  assert.equal(minimized.windowAfter.state, 'minimized', 'the window must stay minimized for the next capture')
  const minimizedAgain = await capture('minimized window (repeat)')
  assertCaptured(minimizedAgain, 'minimized window repeat', { maxTotalMs: 4_500 })
  assert.equal(minimizedAgain.ok, true, 'a repeat minimized capture must not hit CAPTURE_COOLDOWN')
  const minimizedClick = await imageClick('minimized image-space click', 'Increment', 'count', 'role-count')
  assert.ok(minimizedClick.scale > 0, 'the minimized view exposes a usable image scale')

  // 4. Restoring the window returns to the normal capture path.
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await sleep(1200)
  const restored = await capture('restored window')
  assertCaptured(restored, 'restored window')

  const debuggerRunEnd = await evaluate(`(async () => {
    const mod = await import('./browser.js')
    await mod.endDebuggerRun()
    return 'ended'
  })()`)
  assert.equal(debuggerRunEnd, 'ended', 'the capture fixture releases its debugger lease in cleanup')

  console.log('\nPASS: viewport screenshots work while the window is focused, unfocused, and minimized.')
  console.log(`focused baseline: ${baseline.totalMs}ms; unfocused: ${unfocused.totalMs}ms; minimized: ${minimized.totalMs}ms (repeat ${minimizedAgain.totalMs}ms)`)
  console.log(`scale: dpr ${baseline.dpr}; images ${baseline.image.width}x${baseline.image.height} / ${unfocused.image.width}x${unfocused.image.height} / ${minimized.image.width}x${minimized.image.height} for viewport ${baseline.viewport.width}x${baseline.viewport.height}`)
  console.log(`image-space clicks: unfocused Increment ${unfocusedClick.before}->${unfocusedClick.after}; minimized Increment ${minimizedClick.before}->${minimizedClick.after}`)
  cleanup(0)
} catch (error) {
  console.error('FAIL:', error)
  cleanup(1)
}