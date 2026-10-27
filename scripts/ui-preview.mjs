#!/usr/bin/env node
/**
 * Side-panel UI preview harness (mock bridge).
 *
 * Opens the side-panel page in an isolated Edge instance, replaces the bridge
 * WebSocket with an in-page mock, injects a scripted conversation, and writes
 * screenshots of the interesting UI states. Use it to iterate on the side panel
 * without starting the companion or spending model tokens.
 *
 *   node scripts/ui-preview.mjs --scenario empty      # idle dark + light
 *   node scripts/ui-preview.mjs --scenario turn       # finished turn: dark/narrow/wide/light
 *   node scripts/ui-preview.mjs --scenario live       # mid-turn live clocks
 *   node scripts/ui-preview.mjs --scenario states     # finished feed / expanded step / new chat
 *   node scripts/ui-preview.mjs --scenario tools      # browser-command rows + tab-list card
 *   node scripts/ui-preview.mjs --scenario modals     # settings + debug log modals
 *
 * Options: --out DIR (default /tmp/crazyagent-ui-preview) and SHOT_FORMAT=jpeg.
 * Needs Node >= 22 (global WebSocket) and microsoft-edge or (set EDGE_BIN) on PATH.
 * The page is opened as a normal extension tab; the docked side panel is not
 * automated here.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const OUT = resolve(arg('out', '/tmp/crazyagent-ui-preview'))
const SCENARIO = arg('scenario', 'turn')
const CDP_PORT = Number(process.env.CDP_PORT ?? (10_000 + process.pid % 20_000))
const CDP = `http://127.0.0.1:${CDP_PORT}`
const USER_DIR = process.env.UI_PREVIEW_PROFILE ?? `/tmp/crazyagent-ui-preview-profile-${process.pid}`
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
let fixtureUrl = ''
let fixtureServer = null

mkdirSync(OUT, { recursive: true })

const extensionId = (() => {
  const hex = createHash('sha256').update(join(ROOT, 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...parts) => process.stderr.write(`[ui-preview] ${parts.join(' ')}\n`)

async function waitForCdp() {
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${CDP}/json/version`)
      return
    } catch {
      await sleep(150)
    }
  }
  throw new Error('CDP did not come up; is another Edge instance on the debug port?')
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej })
  let seq = 0
  const pending = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') {
      log('PAGE EXCEPTION', JSON.stringify(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails).slice(0, 1600))
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
  }
  return {
    send(method, params = {}) {
      const id = ++seq
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result?.value
    },
    close() { socket.close() },
  }
}

const MOCK_BRIDGE = `(() => {
  class MockWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      this.url = String(url);
      this.readyState = 1;
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      window.__mockSocket = this;
      window.__frames = window.__frames || [];
      setTimeout(() => { try { this.onopen && this.onopen({}) } catch (e) {} }, 15);
    }
    send(data) {
      try { window.__frames.push(JSON.parse(String(data))); } catch (e) {}
    }
    close() { this.readyState = 3; }
  }
  Object.defineProperty(window, 'WebSocket', { value: MockWebSocket, configurable: true, writable: true });
  window.__mockReceive = frame => {
    const socket = window.__mockSocket;
    if (socket && socket.onmessage) socket.onmessage({ data: JSON.stringify(frame) });
  };
  window.__mockBatch = frames => { for (const frame of frames) window.__mockReceive(frame); };
})();`

const settings = {
  bridgeUrl: 'ws://127.0.0.1:17871/bridge',
  token: 'preview-token',
  captureWidth: 1280,
  quality: 72,
  autoCapture: true,
  paused: false,
  reasoningEffort: 'auto',
  modelId: 'deepseek/deepseek-v4.1-flash-1017',
}

const HELLO_FRAMES = [
  { v: 1, type: 'hello.ok', version: 1, companion: { version: 'preview' }, provider: 'openrouter' },
  {
    v: 1,
    type: 'chat.hello',
    companion: { version: 'preview', pid: 1, startedAt: Date.now() },
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4.1-flash-1017',
    autoCapture: true,
    dsh: { state: 'ready' },
    llm: {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash 1017', reasoning: true, imageInput: true },
      reasoningEffort: 'auto',
    },
    credentials: { configured: true, source: 'stored' },
    log: { runId: 'run-preview', path: OUT },
  },
  { v: 1, type: 'chat.status', status: 'ready' },
  { v: 1, type: 'chat.session', sessionId: 'session-preview0001' },
  {
    v: 1,
    type: 'llm.models.result',
    ok: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash 1017', reasoning: true, imageInput: true, contextWindow: 1000000 },
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true, imageInput: true, contextWindow: 1000000 },
      { id: 'openai/gpt-5', name: 'GPT-5', reasoning: true, imageInput: true, contextWindow: 400000 },
    ],
  },
]

function makePage(page) {
  return {
    recv: frame => page.evaluate(`window.__mockReceive(${JSON.stringify(frame)})`),
    batch: frames => page.evaluate(`window.__mockBatch(${JSON.stringify(frames)})`),
  }
}

async function sendPrompt(page, text) {
  await page.evaluate(`(() => {
    const input = document.getElementById('input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input'));
    document.getElementById('composer').requestSubmit();
  })()`)
  await sleep(250)
}

async function assertVisibleReasoning(page, selector, expectedText) {
  const actual = await page.evaluate(`(() => {
    const entry = document.querySelector(${JSON.stringify(selector)});
    if (!entry) return { found: false, visible: false, text: '' };
    const style = getComputedStyle(entry);
    return {
      found: true,
      visible: entry.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      text: entry.querySelector('.activity-text')?.textContent ?? '',
    };
  })()`)
  assert.deepEqual(actual, { found: true, visible: true, text: expectedText }, selector)
}

/**
 * Scripted turn (model text, reasoning, tool rows, finish).
 * `stopAfter: 'step2-running'` stops mid-step so the live clocks stay visible.
 * @param {{stopAfter?: 'step2-running'}} [options]
 */
async function playTurn(page, options = {}) {
  const { recv, batch } = makePage(page)
  await batch(HELLO_FRAMES)
  await sleep(300)

  await sendPrompt(page, 'Find the Increment button, click it twice, and tell me the count. Then check the switch tabs behavior.')
  await recv({ v: 1, type: 'chat.activity', kind: 'policy', policy: 'auto', classification: 'inspect', effort: 'low' })

  // Step 1: think, then click.
  await recv({ v: 1, type: 'chat.activity', kind: 'model-start', turn: 1, step: 1, attemptId: 'a1' })
  await sleep(420)
  let streamedReasoning = ''
  for (const text of ['Looking at the current view. ', 'The Increment button is labelled ', '#12. I will click it.']) {
    await recv({ v: 1, type: 'chat.activity', kind: 'reasoning', text })
    streamedReasoning += text
    await assertVisibleReasoning(page, '.activity-step.running .activity-entry.reasoning.streaming', streamedReasoning)
    await sleep(200)
  }
  await recv({ v: 1, type: 'chat.activity', kind: 'tool-call-delta', id: 'call-1', name: 'browser_click', argumentsDelta: '{"label":' })
  await recv({ v: 1, type: 'chat.activity', kind: 'tool-call-delta', id: 'call-1', name: 'browser_click', argumentsDelta: '"12"}' })
  await sleep(700)
  await recv({ v: 1, type: 'chat.activity', kind: 'usage', usage: { inputTokens: 18422, outputTokens: 322, cacheReadTokens: 12000 } })
  await recv({ v: 1, type: 'chat.activity', kind: 'finish', reason: { kind: 'tool_calls' } })
  await recv({ v: 1, type: 'chat.activity', kind: 'model-end', outcome: { kind: 'committed' } })
  await recv({ v: 1, type: 'chat.tool_call', callId: 'call-1', name: 'browser_click', args: '{"label":"12"}' })
  await sleep(1100)
  await recv({ v: 1, type: 'chat.tool_result', callId: 'call-1', ok: true, text: 'clicked #12 Increment · changed · trusted input · pixels-changed 2.4% · click 611ms' })
  // Step 2: reply + click.
  await recv({ v: 1, type: 'chat.activity', kind: 'model-start', turn: 1, step: 2, attemptId: 'a2' })
  await sleep(320)
  await recv({ v: 1, type: 'chat.activity', kind: 'text', text: 'The count is now 1. Clicking again to reach 2. ' })
  await recv({ v: 1, type: 'chat.activity', kind: 'tool-call-delta', id: 'call-2', name: 'browser_click', argumentsDelta: '{"label":"12"}' })
  await sleep(900)
  if (options.stopAfter === 'step2-running') {
    await sleep(1200)
    return
  }
  await recv({ v: 1, type: 'chat.activity', kind: 'finish', reason: { kind: 'tool_calls' } })
  await recv({ v: 1, type: 'chat.activity', kind: 'model-end', outcome: { kind: 'committed' } })
  await recv({ v: 1, type: 'chat.tool_call', callId: 'call-2', name: 'browser_click', args: '{"label":"12"}' })
  await sleep(900)
  await recv({ v: 1, type: 'chat.tool_result', callId: 'call-2', ok: true, text: 'clicked #12 Increment · changed · pixels-changed 2.1% · click 488ms' })

  // Step 3: committed-only reasoning, then read text.
  await recv({ v: 1, type: 'chat.activity', kind: 'model-start', turn: 1, step: 3, attemptId: 'a3' })
  await sleep(260)
  const committedReasoning = 'The count should now be 2. I will verify the visible text before answering.'
  await recv({ v: 1, type: 'chat.activity', kind: 'reasoning-committed', text: committedReasoning })
  await assertVisibleReasoning(page, '.activity-step.running .activity-entry.reasoning:not(.streaming)', committedReasoning)
  await recv({ v: 1, type: 'chat.activity', kind: 'tool-call-delta', id: 'call-3', name: 'browser_read_text', argumentsDelta: '{"scope":"viewport"}' })
  await sleep(650)
  await recv({ v: 1, type: 'chat.activity', kind: 'finish', reason: { kind: 'stop' } })
  await recv({ v: 1, type: 'chat.activity', kind: 'model-end', outcome: { kind: 'committed' } })
  await recv({ v: 1, type: 'chat.tool_call', callId: 'call-3', name: 'browser_read_text', args: '{"scope":"viewport"}' })
  await sleep(600)
  await recv({ v: 1, type: 'chat.tool_result', callId: 'call-3', ok: true, text: 'count: 2 · Counter page · Increment · Reset · The counter reads 2.' })

  // Step 4: final answer.
  await recv({ v: 1, type: 'chat.activity', kind: 'model-start', turn: 1, step: 4, attemptId: 'a4' })
  await sleep(380)
  for (const text of ['Done — I clicked Increment twice. ', 'The counter now reads 2. ', 'Tab switching is ready when you need it.']) {
    await recv({ v: 1, type: 'chat.activity', kind: 'text', text })
    await sleep(180)
  }
  await recv({ v: 1, type: 'chat.activity', kind: 'finish', reason: { kind: 'stop' } })
  await recv({ v: 1, type: 'chat.activity', kind: 'model-end', outcome: { kind: 'committed' } })
  await sleep(180)
  await recv({
    v: 1,
    type: 'chat.done',
    sessionId: 'session-preview0001',
    text: 'Done — **I clicked Increment twice**. The counter now reads **2**.\n\n- First bullet\n- Second bullet\n\n1. First numbered item\n2. Second numbered item\n\n| Plan | Price |\n| --- | ---: |\n| Pro | $24 |\n| Team | $39 |',
    timings: { totalMs: 28400, autoCaptureMs: 412, firstEventMs: 910, toolCalls: 3, promptTextBytes: 18422, imageBytes: 182000, images: 1 },
    model: 'deepseek/deepseek-v4.1-flash-1017',
    provider: 'openrouter',
  })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
  assert.match(await page.evaluate(`document.querySelector('.agent-turn-summary').textContent`), /^3 actions · 28.4s/)
  assert.equal(await page.evaluate(`document.querySelectorAll('.activity-entry.policy, .activity-entry.done, .activity-entry.usage, .answer-label, .step-index').length`), 0)
  assert.equal(await page.evaluate(`document.querySelector('.agent-turn').classList.contains('collapsed')`), true)
  assert.equal(await page.evaluate(`document.querySelectorAll('.answer-text strong').length`), 2)
  assert.equal(await page.evaluate(`document.querySelectorAll('.answer-text ul li').length`), 2)
  assert.equal(await page.evaluate(`document.querySelectorAll('.answer-text ol li').length`), 2)
  assert.equal(await page.evaluate(`document.querySelectorAll('.answer-text tbody tr').length`), 2)
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.answer-text li'), '::marker').color`), 'rgb(255, 195, 0)')
}

/** Exercise real browser-command rows + tab-list cards through the executor. */
async function playToolScenario(page) {
  const { recv, batch } = makePage(page)
  await batch(HELLO_FRAMES)
  await page.send('Target.createTarget', { url: fixtureUrl })
  await sleep(800)
  const modelMeta = await page.evaluate(`(() => {
    const button = document.getElementById('composer-model')
    const effort = document.getElementById('composer-model-effort')
    return {
      flexGrow: getComputedStyle(button).flexGrow,
      maxWidth: getComputedStyle(button).maxWidth,
      width: button.getBoundingClientRect().width,
      buttonTitle: button.title,
      modelName: document.getElementById('composer-model-name').textContent,
      effortText: effort.textContent,
      effortTitle: effort.title,
      effortColor: getComputedStyle(effort).color,
    }
  })()`)
  assert.equal(modelMeta.flexGrow, '1')
  assert.equal(modelMeta.maxWidth, 'none')
  assert.ok(modelMeta.width > 200, `model selector uses available width (${modelMeta.width}px)`)
  assert.equal(modelMeta.modelName, 'DeepSeek V4.1 Flash 1017')
  assert.equal(modelMeta.effortText, '· low')
  assert.equal(modelMeta.effortTitle, 'Reasoning effort: Auto (low from the first step)')
  assert.equal(modelMeta.effortColor, 'rgb(255, 195, 0)')
  assert.match(modelMeta.buttonTitle, /deepseek\/deepseek-v4\.1-flash-1017/)
  await recv({ v: 1, type: 'chat.activity', kind: 'usage', usage: { totalTokens: 250000, inputTokens: 250000 } })
  const contextMeta = await page.evaluate(`(() => {
    const progress = document.getElementById('composer-context-progress')
    const percent = document.getElementById('composer-context-percent')
    const context = document.getElementById('composer-model-context')
    const rect = context.getBoundingClientRect()
    return {
      progressStroke: getComputedStyle(progress).stroke,
      progressOffset: progress.style.strokeDashoffset,
      usage: document.getElementById('composer-context-usage').textContent,
      percent: percent.textContent,
      percentColor: getComputedStyle(percent).color,
      centerX: rect.x + rect.width / 2,
      centerY: rect.y + rect.height / 2,
    }
  })()`)
  assert.equal(contextMeta.progressStroke, 'rgb(255, 195, 0)')
  assert.equal(contextMeta.progressOffset, '32.99')
  assert.equal(contextMeta.usage, '250,000 / 1,000,000 tokens')
  assert.equal(contextMeta.percent, '25.0%')
  assert.equal(contextMeta.percentColor, 'rgb(255, 195, 0)')
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: contextMeta.centerX, y: contextMeta.centerY })
  await sleep(200)
  assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('composer-context-tooltip')).visibility`), 'visible')
  await sendPrompt(page, 'List the open tabs and pick the fixture page.')
  await recv({ v: 1, type: 'browser.command', id: 'cmd-auto', callId: 'auto', turnId: 'turn-1', command: { op: 'tabs.list', args: {} } })
  await sleep(1200)
  await recv({ v: 1, type: 'chat.activity', kind: 'model-start', turn: 1, step: 1, attemptId: 'a1' })
  await sleep(400)
  await recv({ v: 1, type: 'chat.tool_call', callId: 'call-shot', name: 'browser_screenshot', args: '{}' })
  await recv({ v: 1, type: 'browser.command', id: 'cmd-shot', callId: 'call-shot', turnId: 'turn-1', command: { op: 'snapshot', args: {} } })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.evaluate(`Boolean(document.querySelector('.activity-step:not(.collapsed) .activity-screenshot img')?.src.startsWith('data:image/'))`)) break
    await sleep(150)
  }
  const shotResult = await page.evaluate(`window.__frames.filter(frame => frame.type === 'browser.result' && frame.id === 'cmd-shot').at(-1)`)
  assert.equal(shotResult?.ok, true, JSON.stringify(shotResult))
  assert.ok(shotResult.result?.image?.data, 'snapshot result should include image data')
  assert.equal(await page.evaluate(`Boolean(document.querySelector('.activity-step:not(.collapsed) .activity-screenshot img')?.src.startsWith('data:image/'))`), true)
  await recv({ v: 1, type: 'browser.command', id: 'cmd-auto-shot', callId: 'auto', turnId: 'turn-1', command: { op: 'snapshot', args: {} } })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.evaluate(`window.__frames.some(frame => frame.type === 'browser.result' && frame.id === 'cmd-auto-shot')`)) break
    await sleep(150)
  }
  const autoShotResult = await page.evaluate(`window.__frames.filter(frame => frame.type === 'browser.result' && frame.id === 'cmd-auto-shot').at(-1)`)
  assert.equal(autoShotResult?.ok, true, JSON.stringify(autoShotResult))
  assert.equal(await page.evaluate(`[...document.querySelectorAll('.activity-entry.browser')].some(entry => /capture \\d+ms|encode \\d+ms|KiB|scroll document/.test(entry.textContent))`), false, 'successful auto-capture leaves no telemetry row')
  await recv({ v: 1, type: 'chat.tool_result', callId: 'call-shot', ok: true, text: 'screenshot captured' })
  await recv({ v: 1, type: 'chat.tool_call', callId: 'call-tabs', name: 'browser_tabs', args: '{}' })
  await sleep(300)
  await recv({ v: 1, type: 'browser.command', id: 'cmd-tabs', callId: 'call-tabs', turnId: 'turn-1', command: { op: 'tabs.list', args: {} } })
  await sleep(1200)
  await recv({ v: 1, type: 'chat.tool_result', callId: 'call-tabs', ok: true, text: 'tabs listed · current window' })
  await recv({ v: 1, type: 'chat.activity', kind: 'model-end', outcome: { kind: 'committed' } })
  await recv({ v: 1, type: 'chat.activity', kind: 'model-start', turn: 1, step: 2, attemptId: 'a2' })
  assert.equal(await page.evaluate(`document.querySelector('.activity-screenshot').getClientRects().length`), 0)
  await sleep(500)
  await recv({ v: 1, type: 'chat.activity', kind: 'text', text: 'I can see the fixture page in the tab list.' })
  await recv({ v: 1, type: 'chat.activity', kind: 'model-end', outcome: { kind: 'committed' } })
  await recv({
    v: 1,
    type: 'chat.done',
    sessionId: 'session-preview0001',
    text: 'I can see the fixture page in the tab list. The tab list card above shows every open tab.',
    timings: { totalMs: 6200, autoCaptureMs: 0, firstEventMs: 620, toolCalls: 1 },
    model: 'deepseek/deepseek-v4.1-flash-1017',
    provider: 'openrouter',
  })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
}

async function main() {
  if (!existsSync(join(ROOT, 'extension', 'manifest.json'))) throw new Error(`extension/ not found under ${ROOT}`)
  if (SCENARIO === 'tools') {
    fixtureServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>UI preview fixture</title><button>Increment</button><p>Fixture page</p>')
    })
    await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve))
    fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`
  }
  spawn(EDGE_BIN, [
    `--user-data-dir=${USER_DIR}`,
    `--load-extension=${join(ROOT, 'extension')}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref()

  await waitForCdp()
  const target = (await (await fetch(`${CDP}/json`)).json()).find(item => item.type === 'page')
  if (!target) throw new Error('no page target')
  const page = await connect(target.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 940, deviceScaleFactor: 2, mobile: false })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_BRIDGE })

  await page.send('Page.navigate', { url: `chrome-extension://${extensionId}/sidepanel/index.html` })
  await sleep(1300)
  await page.evaluate(`chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify(settings)} })`)
  await page.send('Page.reload')
  await sleep(1600)
  for (let i = 0; i < 40; i += 1) {
    if (await page.evaluate('Boolean(window.__mockSocket)')) break
    await sleep(150)
  }

  const shotFormat = process.env.SHOT_FORMAT ?? 'png'
  const shot = async name => {
    await page.send('Page.bringToFront').catch(() => {})
    await sleep(250)
    const params = shotFormat === 'jpeg'
      ? { format: 'jpeg', quality: 86, fromSurface: true, captureBeyondViewport: false }
      : { format: 'png', fromSurface: true, captureBeyondViewport: false }
    const { data } = await page.send('Page.captureScreenshot', params)
    const path = join(OUT, `${SCENARIO}-${name}.${shotFormat}`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    log('wrote', path)
  }

  const setWidth = async width => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 940, deviceScaleFactor: 2, mobile: false })
    await sleep(300)
  }

  const setTheme = async theme => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    await sleep(250)
  }

  if (SCENARIO === 'empty') {
    await page.evaluate(`window.__mockBatch(${JSON.stringify(HELLO_FRAMES)})`)
    await sleep(400)
    await shot('dark')
    await setTheme('light')
    await shot('light')
  } else if (SCENARIO === 'live') {
    await playTurn(page, { stopAfter: 'step2-running' })
    await shot('dark')
  } else if (SCENARIO === 'states') {
    await playTurn(page)
    await sleep(300)
    await shot('finished')
    await page.evaluate(`document.querySelector('.agent-turn-summary').click()`)
    await page.evaluate(`document.querySelector('.activity-step .step-head').click()`)
    await sleep(250)
    await shot('step-expanded')
    await page.evaluate(`document.getElementById('new-chat').click()`)
    await sleep(300)
    await shot('new-chat')
  } else if (SCENARIO === 'tools') {
    await playToolScenario(page)
    await sleep(400)
    await shot('dark')
  } else if (SCENARIO === 'modals') {
    await page.evaluate(`window.__mockBatch(${JSON.stringify(HELLO_FRAMES)})`)
    await sleep(400)
    await page.evaluate(`document.getElementById('settings').click()`)
    await sleep(300)
    await shot('settings')
    await page.evaluate(`document.getElementById('settings-close').click()`)
    await sleep(200)
    await page.evaluate(`document.getElementById('debug-log').click()`)
    await sleep(300)
    await shot('debug-log')
  } else if (SCENARIO === 'interactions') {
    await page.evaluate(`window.__mockBatch(${JSON.stringify(HELLO_FRAMES)})`)
    await sleep(400)
    await page.evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['alpha\\nbeta'], 'notes.txt', { type: 'text/plain' }));
      const picker = document.getElementById('file-input');
      picker.files = transfer.files;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await sleep(200)
    await sendPrompt(page, 'Review the notes')
    const sent = await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.send').at(-1)`)
    assert.match(sent.text, /Review the notes/)
    assert.match(sent.text, /<attached-file name="notes.txt">/)
    assert.match(sent.text, /alpha\nbeta/)
    await page.evaluate(`document.getElementById('stop').click()`)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.stop').length`), 1)
    await page.evaluate(`window.__mockReceive({ v: 1, type: 'chat.stopped', reason: 'user', sessionId: 'session-preview0001' })`)
    await sleep(200)
    await page.evaluate(`document.getElementById('new-chat').click()`)
    await sleep(250)
    assert.equal(await page.evaluate(`document.querySelectorAll('.activity-turn').length`), 0)
    await page.evaluate(`document.getElementById('history').click()`)
    await page.evaluate(`(() => {
      const search = document.getElementById('history-search');
      search.value = 'Review';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    assert.equal(await page.evaluate(`document.querySelectorAll('.history-item').length`), 1)
    await shot('history')
    await page.evaluate(`document.querySelector('.history-open').click()`)
    await sleep(200)
    assert.match(await page.evaluate(`document.querySelector('.turn-prompt').textContent`), /Review the notes/)
    await page.evaluate(`document.getElementById('composer-model').click()`)
    await page.evaluate(`document.querySelectorAll('.model-menu-item')[1].click()`)
    const configured = await page.evaluate(`window.__frames.filter(frame => frame.type === 'llm.configure').at(-1)`)
    assert.equal(configured.model, 'anthropic/claude-sonnet-4.5')
    await page.evaluate(`window.__mockReceive({ v: 1, type: 'llm.configured', ok: true, llm: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true }, reasoningEffort: 'auto' }, credentials: { configured: true, source: 'stored' }, dsh: { state: 'ready' } })`)
    await page.evaluate(`document.getElementById('settings').click()`)
    await page.evaluate(`document.querySelector('[data-effort="high"]').click()`)
    await page.evaluate(`document.getElementById('settings-save').click()`)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'llm.configure').at(-1).reasoningEffort`), 'high')
    await page.evaluate(`window.__mockReceive({ v: 1, type: 'llm.configured', ok: true, llm: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true }, reasoningEffort: 'high' }, credentials: { configured: true, source: 'stored' }, dsh: { state: 'ready' } })`)
    await page.evaluate(`document.getElementById('debug-log').click()`)
    await page.evaluate(`document.getElementById('log-include-screenshots').click()`)
    await page.evaluate(`document.getElementById('log-export').click()`)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'log.export').at(-1).includeScreenshots`), false)
    await page.evaluate(`document.getElementById('log-copy-summary').click()`)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'log.summary').length`), 1)
    await shot('debug-actions')
  } else {
    await playTurn(page)
    await sleep(400)
    await shot('dark')
    await setWidth(320)
    await shot('narrow')
    await setWidth(560)
    await shot('wide')
    await setWidth(420)
    await setTheme('light')
    await shot('light')
  }

  page.close()
  const version = await (await fetch(`${CDP}/json/version`)).json()
  const browser = await connect(version.webSocketDebuggerUrl)
  await browser.send('Browser.close')
  fixtureServer?.close()
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error)
  process.exit(1)
})