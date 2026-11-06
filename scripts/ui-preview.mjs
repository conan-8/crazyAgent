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
 *   node scripts/ui-preview.mjs --scenario waiting    # pre-stream bouncing ball
 *   node scripts/ui-preview.mjs --scenario states     # finished feed / expanded step / new chat
 *   node scripts/ui-preview.mjs --scenario tools      # browser-command rows + tab-list card
 *   node scripts/ui-preview.mjs --scenario modals     # settings + debug log modals
 *   node scripts/ui-preview.mjs --scenario disclaimer # one-time full-screen notice after a reload
 *   node scripts/ui-preview.mjs --scenario queue      # queued messages + steer/cancel actions
 *   node scripts/ui-preview.mjs --scenario recent     # new-chat recents + running session indicator
 *   node scripts/ui-preview.mjs --scenario composer   # image paste + model search + dictation dots
 *   node scripts/ui-preview.mjs --scenario slash      # slash-command palette: filter, keys, execution
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
  window.__mockDrop = (code = 1006, reason = 'preview disconnect') => {
    const socket = window.__mockSocket;
    if (!socket) return false;
    socket.readyState = 3;
    if (typeof socket.onclose === 'function') {
      try { socket.onclose({ code, reason }) } catch (e) {}
    }
    return true;
  };
  class MockSpeechRecognition {
    constructor() { window.__mockSpeech = this; }
    start() { this.started = true; }
    stop() { this.started = false; setTimeout(() => { try { this.onend && this.onend({}) } catch (e) {} }, 0); }
  }
  Object.defineProperty(window, 'SpeechRecognition', { value: MockSpeechRecognition, configurable: true, writable: true });
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: MockSpeechRecognition, configurable: true, writable: true });
  window.__mockSpeechResults = results => {
    const recognition = window.__mockSpeech;
    if (!recognition || !recognition.onresult) return;
    recognition.onresult({ results: results.map(([transcript, isFinal]) => {
      const result = [{ transcript }];
      result.isFinal = isFinal;
      return result;
    }) });
  };
})();`

const settings = {
  bridgeUrl: 'ws://127.0.0.1:17871/bridge',
  token: 'preview-token',
  captureWidth: 1280,
  quality: 72,
  autoCapture: true,
  paused: false,
  reasoningEffort: 'medium',
  modelId: 'deepseek/deepseek-v4.1-flash',
}

const HELLO_FRAMES = [
  { v: 1, type: 'hello.ok', version: 1, companion: { version: 'preview' }, provider: 'openrouter' },
  {
    v: 1,
    type: 'chat.hello',
    companion: { version: 'preview', pid: 1, startedAt: Date.now() },
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4.1-flash',
    autoCapture: true,
    dsh: { state: 'ready' },
    llm: {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: DeepSeek V4.1 Flash', reasoning: true, imageInput: true },
      reasoningEffort: 'medium',
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
      { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: DeepSeek V4.1 Flash', reasoning: true, imageInput: true, tools: true, contextWindow: 1000000 },
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true, imageInput: true, tools: true, contextWindow: 1000000 },
      { id: 'openai/gpt-5', name: 'GPT-5', reasoning: true, imageInput: true, tools: true, contextWindow: 400000 },
      { id: 'acme/text-only', name: 'Text Only Model', reasoning: true, imageInput: false, tools: true, contextWindow: 128000 },
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

async function finishPrompt(page, sessionId, text = '') {
  const { recv } = makePage(page)
  await recv({ v: 1, type: 'chat.done', sessionId, text, timings: { totalMs: 1 } })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
  await sleep(180)
}

async function pasteImage(page, name = 'screenshot.png') {
  await page.evaluate(`(() => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    document.getElementById('input').dispatchEvent(event);
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
    model: 'deepseek/deepseek-v4.1-flash',
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
  assert.equal(modelMeta.modelName, 'DeepSeek V4.1 Flash')
  assert.equal(modelMeta.effortText, '· medium')
  assert.equal(modelMeta.effortTitle, 'Reasoning effort: Medium')
  assert.equal(modelMeta.effortColor, 'rgb(255, 195, 0)')
  assert.match(modelMeta.buttonTitle, /deepseek\/deepseek-v4\.1-flash\s/)
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
    model: 'deepseek/deepseek-v4.1-flash',
    provider: 'openrouter',
  })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
}

async function playQueueScenario(page, capture) {
  const { recv, batch } = makePage(page)
  await batch(HELLO_FRAMES)
  await sleep(300)
  const idleComposerHeight = await page.evaluate(`document.querySelector('.composer-field').getBoundingClientRect().height`)
  await sendPrompt(page, 'Start the first task')
  const runningComposer = await page.evaluate(`(() => {
    const field = document.querySelector('.composer-field');
    const style = getComputedStyle(field);
    return { height: field.getBoundingClientRect().height, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, gap: style.gap };
  })()`)
  assert.ok(runningComposer.height < idleComposerHeight)
  assert.equal(runningComposer.paddingTop, '8px')
  assert.equal(runningComposer.paddingBottom, '8px')
  assert.equal(runningComposer.gap, '4px')
  assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('input')).paddingRight`), '48px')

  await pasteImage(page, 'notes.png')
  await sendPrompt(page, 'Queue this direction')

  await pasteImage(page, 'later.png')
  await sendPrompt(page, 'A second queued note')

  assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.send').length`), 1)
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.queued-message-preview')].map(node => node.textContent)`), [
    'Queue this direction',
    'A second queued note',
  ])
  assert.equal(await page.evaluate(`document.getElementById('send').disabled`), false)
  assert.equal(await page.evaluate(`document.getElementById('send').getAttribute('aria-label')`), 'Queue message')
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.queued-message-steer')).backgroundColor`), 'rgb(255, 195, 0)')
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.queued-message-cancel')).opacity`), '0')
  await capture('stack')

  await page.evaluate(`document.querySelector('.queued-message-cancel').focus()`)
  await sleep(200)
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.queued-message-cancel')).opacity`), '1')
  await recv({ v: 1, type: 'chat.tool_call', callId: 'queue-focus-check', name: 'browser_read_text', args: '{}' })
  assert.equal(await page.evaluate(`document.activeElement.classList.contains('queued-message-cancel')`), true)
  await page.evaluate(`document.getElementById('input').value = 'Draft in progress'`)
  await page.evaluate(`document.querySelectorAll('.queued-message-cancel')[1].click()`)
  assert.equal(await page.evaluate(`document.getElementById('input').value`), 'A second queued note\n\nDraft in progress')
  assert.equal(await page.evaluate(`document.querySelector('.image-chip').textContent.includes('later.png')`), true)
  assert.equal(await page.evaluate(`document.querySelectorAll('.queued-message').length`), 1)
  await page.evaluate(`(() => {
    document.querySelector('.image-chip button').click();
    const input = document.getElementById('input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)

  await page.evaluate(`document.querySelector('.queued-message-steer').click()`)
  assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.stop').length`), 1)
  assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.send').length`), 1)
  assert.equal(await page.evaluate(`document.querySelector('.queued-message-steer').disabled`), true)
  await recv({ v: 1, type: 'chat.stopping', turnId: 'turn-preview-1' })
  await recv({ v: 1, type: 'chat.stopped', turnId: 'turn-preview-1', reason: 'user', sessionId: 'session-preview0001' })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
  await sleep(250)
  const steered = await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.send').at(-1)`)
  assert.match(steered.text, /^Queue this direction/)
  assert.equal(steered.images.length, 1)
  assert.equal(steered.images[0].name, 'notes.png')
  assert.equal(steered.images[0].mimeType, 'image/png')
  assert.ok(steered.images[0].data.length > 0)
  assert.equal(await page.evaluate(`document.querySelectorAll('.queued-message').length`), 0)

  await sendPrompt(page, 'FIFO one')
  await sendPrompt(page, 'FIFO two')
  assert.equal(await page.evaluate(`document.querySelectorAll('.queued-message').length`), 2)
  await recv({ v: 1, type: 'chat.done', sessionId: 'session-preview0001', text: '', timings: { totalMs: 1 } })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
  await sleep(250)
  assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.send').at(-1).text`), 'FIFO one')
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.queued-message-preview')].map(node => node.textContent)`), ['FIFO two'])

  await recv({ v: 1, type: 'chat.done', sessionId: 'session-preview0001', text: '', timings: { totalMs: 1 } })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
  await sleep(250)
  assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.send').at(-1).text`), 'FIFO two')
  assert.equal(await page.evaluate(`document.querySelectorAll('.queued-message').length`), 0)
  assert.equal(await page.evaluate(`document.getElementById('message-queue').classList.contains('hidden')`), true)
}

async function playComposerScenario(page, capture) {
  const { recv, batch } = makePage(page)
  await batch(HELLO_FRAMES)
  await sleep(300)

  await page.evaluate(`document.getElementById('composer-model').click()`)
  await sleep(100)
  assert.equal(await page.evaluate(`document.activeElement.id`), 'model-search')
  const initialConfigureCount = await page.evaluate(`window.__frames.filter(frame => frame.type === 'llm.configure').length`)
  await page.evaluate(`(() => {
    const search = document.getElementById('model-search');
    search.value = 'text-only';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  assert.equal(await page.evaluate(`document.querySelectorAll('.model-menu-item').length`), 1)
  assert.match(await page.evaluate(`document.querySelector('.model-menu-item').textContent`), /acme\/text-only · text only/)
  assert.equal(await page.evaluate(`document.querySelector('.model-menu-item').disabled`), true)
  await page.evaluate(`document.querySelector('.model-menu-item').click()`)
  assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'llm.configure').length`), initialConfigureCount)
  await page.evaluate(`(() => {
    const search = document.getElementById('model-search');
    search.value = 'claude';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  assert.equal(await page.evaluate(`document.querySelectorAll('.model-menu-item').length`), 1)
  assert.match(await page.evaluate(`document.querySelector('.model-menu-item').textContent`), /anthropic\/claude-sonnet-4\.5/)
  await capture('model-search')
  await page.evaluate(`(() => {
    const search = document.getElementById('model-search');
    search.value = 'not-a-model';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  assert.equal(await page.evaluate(`document.querySelector('.model-menu-empty').textContent`), 'No models match your search')
  await page.evaluate(`(() => {
    const search = document.getElementById('model-search');
    search.value = 'claude';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`)
  assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'llm.configure').at(-1).model`), 'anthropic/claude-sonnet-4.5')
  await recv({ v: 1, type: 'llm.configured', ok: true, llm: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true }, reasoningEffort: 'medium' }, credentials: { configured: true, source: 'stored' }, dsh: { state: 'ready' } })

  // Empty composer: starting dictation shows the listening dots inside the
  // textarea, they bounce, and stopping removes them.
  assert.equal(await page.evaluate(`document.getElementById('dictation-indicator').hidden`), true)
  await page.evaluate(`document.getElementById('mic').click()`)
  await sleep(250)
  const dictation = await page.evaluate(`(() => {
    const indicator = document.getElementById('dictation-indicator');
    const input = document.getElementById('input');
    const dots = [...indicator.querySelectorAll('.dictation-dot')];
    const rect = indicator.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    return {
      visible: !indicator.hidden && indicator.getClientRects().length > 0,
      label: indicator.textContent.trim(),
      insideTextArea: rect.left >= inputRect.left - 1 && rect.right <= inputRect.right + 1 && rect.top >= inputRect.top - 1 && rect.bottom <= inputRect.bottom + 1,
      dotCount: dots.length,
      animationNames: dots.map(dot => getComputedStyle(dot).animationName),
      animationDelays: dots.map(dot => Math.round(parseFloat(getComputedStyle(dot).animationDelay) * 1000)),
      playState: getComputedStyle(dots[0]).animationPlayState,
      paddingRight: parseFloat(getComputedStyle(input).paddingRight),
    };
  })()`)
  assert.equal(dictation.visible, true)
  assert.equal(dictation.label, 'Listening')
  assert.equal(dictation.insideTextArea, true)
  assert.equal(dictation.dotCount, 3)
  assert.deepEqual(dictation.animationNames, ['dictation-dot', 'dictation-dot', 'dictation-dot'])
  assert.deepEqual(dictation.animationDelays, [0, 160, 320])
  assert.equal(dictation.playState, 'running')
  assert.ok(dictation.paddingRight >= 100, `dictation should reserve textarea space, got ${dictation.paddingRight}`)
  const bouncing = await page.evaluate(`(async () => {
    const dot = document.querySelector('.dictation-dot');
    const seen = new Set();
    for (let index = 0; index < 12; index += 1) {
      seen.add(getComputedStyle(dot).transform);
      if (seen.size > 1) return true;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    return false;
  })()`)
  assert.equal(bouncing, true, 'bouncing dots should animate')
  await sleep(2_700) // let the model-configured toast fade before the screenshot
  await capture('dictation')

  // Narrowest supported panel: the pill must stay inside the field and leave
  // enough room for dictated text next to the reserved corner.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 280, height: 940, deviceScaleFactor: 2, mobile: false })
  await sleep(250)
  const narrowDictation = await page.evaluate(`(() => {
    const field = document.querySelector('.composer-field').getBoundingClientRect();
    const indicatorEl = document.getElementById('dictation-indicator');
    const indicator = indicatorEl.getBoundingClientRect();
    const input = document.getElementById('input');
    return {
      insideField: indicator.left >= field.left - 1 && indicator.right <= field.right + 1 && indicator.bottom <= field.bottom + 1,
      labelClipped: indicatorEl.scrollWidth > indicatorEl.clientWidth + 1,
      inputContentWidth: input.clientWidth - parseFloat(getComputedStyle(input).paddingRight),
    };
  })()`)
  assert.equal(narrowDictation.insideField, true, 'listening pill must stay inside the composer field')
  assert.equal(narrowDictation.labelClipped, false)
  assert.ok(narrowDictation.inputContentWidth > 80, `narrow dictation textarea is too tight: ${narrowDictation.inputContentWidth}`)
  await capture('dictation-narrow')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 940, deviceScaleFactor: 2, mobile: false })
  await sleep(250)

  await page.evaluate(`document.getElementById('mic').click()`)
  await sleep(50)
  assert.equal(await page.evaluate(`document.getElementById('dictation-indicator').hidden`), true)

  await page.evaluate(`(() => {
    const input = document.getElementById('input');
    input.value = 'Hello world';
    input.setSelectionRange(5, 5);
    document.getElementById('mic').click();
  })()`)
  assert.equal(await page.evaluate(`document.getElementById('mic').classList.contains('recording')`), true)
  assert.equal(await page.evaluate(`document.getElementById('mic').getAttribute('aria-pressed')`), 'true')
  assert.equal(await page.evaluate(`document.getElementById('dictation-indicator').hidden`), false)
  await sleep(200)
  assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('mic')).color`), 'rgb(255, 195, 0)')
  await page.evaluate(`window.__mockSpeechResults([['team', false]])`)
  assert.equal(await page.evaluate(`document.getElementById('input').value`), 'Hello team world')
  await page.evaluate(`window.__mockSpeechResults([['team', true], [' mates', false]])`)
  assert.equal(await page.evaluate(`document.getElementById('input').value`), 'Hello team mates world')
  await pasteImage(page, 'screenshot.png')
  assert.equal(await page.evaluate(`document.querySelector('.image-chip').textContent.includes('screenshot.png')`), true)
  assert.equal(await page.evaluate(`document.querySelector('.image-chip img').src.startsWith('data:image/png;base64,')`), true)
  await sleep(2_700)
  await capture('composer')
  await page.evaluate(`document.getElementById('mic').click()`)
  assert.equal(await page.evaluate(`document.getElementById('mic').classList.contains('recording')`), false)
  assert.equal(await page.evaluate(`document.getElementById('mic').getAttribute('aria-pressed')`), 'false')
  assert.equal(await page.evaluate(`document.getElementById('dictation-indicator').hidden`), true)
  await sleep(250)
  assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('input')).paddingRight`), '4px')
  await page.evaluate(`document.getElementById('composer').requestSubmit()`)
  await sleep(250)
  const sent = await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.send').at(-1)`)
  assert.equal(sent.text, 'Hello team mates world')
  assert.equal(sent.images.length, 1)
  assert.equal(sent.images[0].name, 'screenshot.png')
}

/** Slash-command composer: trigger rules, filtering, keyboard selection, execution. */
async function playSlashScenario(page, capture) {
  const { recv, batch } = makePage(page)
  await batch(HELLO_FRAMES)
  await sleep(300)

  const type = async value => {
    await page.evaluate(`(() => {
      const input = document.getElementById('input');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await sleep(140)
  }
  const press = async (target, key) => {
    const source = target === 'document' ? 'document' : `document.querySelector(${JSON.stringify(target)})`
    await page.evaluate(`${source}.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, cancelable: true })}))`)
    await sleep(140)
  }
  const menuState = async () => page.evaluate(`(() => {
    const menu = document.getElementById('slash-menu');
    const list = document.getElementById('slash-menu-list');
    const input = document.getElementById('input');
    return {
      visible: !menu.classList.contains('hidden'),
      expanded: input.getAttribute('aria-expanded'),
      controls: input.getAttribute('aria-controls'),
      activeDescendant: input.getAttribute('aria-activedescendant'),
      hint: menu.querySelector('.slash-menu-hint').textContent,
      menuRole: menu.getAttribute('role'),
      listRole: list.getAttribute('role'),
      listLabel: list.getAttribute('aria-label'),
      items: [...menu.querySelectorAll('.slash-command')].map(item => ({
        id: item.dataset.command,
        name: item.querySelector('.slash-command-name').textContent,
        description: item.querySelector('.slash-command-description').textContent,
        selected: item.getAttribute('aria-selected') === 'true',
        role: item.getAttribute('role'),
      })),
    };
  })()`)
  const frameCount = async type => page.evaluate(`window.__frames.filter(frame => frame.type === ${JSON.stringify(type)}).length`)
  const inputValue = async () => page.evaluate(`document.getElementById('input').value`)
  const modelMenuHidden = async () => page.evaluate(`document.getElementById('model-menu').classList.contains('hidden')`)
  const focusComposer = async () => {
    await page.evaluate(`document.getElementById('input').focus()`)
    await sleep(60)
  }
  /** Dispatch a real CDP key press so preventDefault/default actions are exercised. */
  const trustedKey = async (key, options = {}) => {
    const spec = {
      Enter: { code: 'Enter', vk: 13, text: '\r' },
      Tab: { code: 'Tab', vk: 9 },
      Escape: { code: 'Escape', vk: 27 },
      ArrowUp: { code: 'ArrowUp', vk: 38 },
      ArrowDown: { code: 'ArrowDown', vk: 40 },
    }[key] ?? { code: key, vk: 0 }
    const modifiers = options.modifiers ?? 0
    const base = { key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}) })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(160)
  }
  const trustedClickAt = async (x, y) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(180)
  }
  const trustedClick = async selector => {
    const point = await page.evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`)
    await trustedClickAt(point.x, point.y)
  }
  /** Read the real accessibility tree (not DOM attributes) for the composer. */
  const axState = async () => {
    const { root } = await page.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#input' })
    const { nodes } = await page.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })
    const node = nodes[0]
    const property = name => node?.properties?.find(item => item.name === name)?.value?.value
    return { role: node?.role?.value, expanded: property('expanded'), activeDescendant: property('activedescendant') }
  }
  await page.send('Accessibility.enable')
  const sendCount = await frameCount('chat.send')
  const newCount = await frameCount('chat.new')

  // Dormant until the draft is a single leading slash token.
  assert.equal((await menuState()).visible, false)
  assert.equal((await menuState()).expanded, 'false')
  await type('hello')
  assert.equal((await menuState()).visible, false)

  // A bare slash lists both commands, first selected, with ARIA wiring.
  await type('/')
  const open = await menuState()
  assert.equal(open.visible, true)
  assert.equal(open.expanded, 'true')
  assert.equal(open.activeDescendant, 'slash-command-new')
  assert.deepEqual(open.items.map(item => item.name), ['/new', '/model'])
  assert.deepEqual(open.items.map(item => item.description), ['Start a new chat', 'Choose the model for your next turn'])
  assert.deepEqual(open.items.map(item => item.selected), [true, false])
  assert.deepEqual(open.items.map(item => item.role), ['option', 'option'])
  assert.match(open.hint, /↑↓ navigate · Enter run · Esc dismiss/)
  assert.equal(open.controls, 'slash-menu-list')
  assert.equal(open.listRole, 'listbox')
  assert.equal(open.listLabel, 'Slash commands')
  assert.equal(open.menuRole, null, 'only the list itself carries the listbox role')
  const openAx = await axState()
  assert.equal(openAx.role, 'combobox')
  assert.equal(openAx.expanded, true, 'the accessibility tree must expose expanded=true')
  await capture('commands')

  // Narrowest supported panel: the palette stays inside the panel and the
  // hint line never clips.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 280, height: 940, deviceScaleFactor: 2, mobile: false })
  await sleep(250)
  const narrow = await page.evaluate(`(() => {
    const menu = document.getElementById('slash-menu');
    const hint = menu.querySelector('.slash-menu-hint');
    const rect = menu.getBoundingClientRect();
    return {
      insidePanel: rect.left >= 0 && rect.right <= innerWidth,
      menuOverflow: menu.scrollWidth > menu.clientWidth + 1,
      hintOverflow: hint.scrollWidth > hint.clientWidth + 1,
    };
  })()`)
  assert.deepEqual(narrow, { insidePanel: true, menuOverflow: false, hintOverflow: false })
  await capture('commands-narrow')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 940, deviceScaleFactor: 2, mobile: false })
  await sleep(250)

  // Arrow keys move and wrap the active option without rewriting the draft.
  await press('#input', 'ArrowDown')
  assert.deepEqual((await menuState()).items.map(item => item.selected), [false, true])
  assert.equal((await menuState()).activeDescendant, 'slash-command-model')
  assert.equal(await inputValue(), '/')
  await press('#input', 'ArrowUp')
  assert.deepEqual((await menuState()).items.map(item => item.selected), [true, false])
  await press('#input', 'ArrowUp')
  assert.deepEqual((await menuState()).items.map(item => item.selected), [false, true])

  // Filtering narrows the list and resets the selection.
  await type('/m')
  assert.deepEqual((await menuState()).items.map(item => item.name), ['/model'])
  assert.deepEqual((await menuState()).items.map(item => item.selected), [true])

  // Escape dismisses the palette without rewriting the draft.
  await press('#input', 'Escape')
  const dismissed = await menuState()
  assert.equal(dismissed.visible, false)
  assert.equal(dismissed.expanded, 'false')
  assert.equal(dismissed.activeDescendant, null, 'closing must drop aria-activedescendant')
  assert.equal((await axState()).expanded, false)
  assert.equal(await inputValue(), '/m')

  // Prose that merely starts with a slash is never treated as a command.
  for (const draft of ['please /new', '/usr/local/bin', '/new chat', '/new ']) {
    await type(draft)
    assert.equal((await menuState()).visible, false, draft)
  }

  // Trusted Enter (real CDP key, not a synthetic event) runs /new exactly once
  // and preventDefault keeps the stray newline out of the cleared composer.
  await type('/ne')
  assert.deepEqual((await menuState()).items.map(item => item.name), ['/new'])
  await focusComposer()
  await trustedKey('Enter')
  assert.equal(await frameCount('chat.new'), newCount + 1)
  assert.equal(await frameCount('chat.send'), sendCount)
  assert.equal((await menuState()).visible, false)
  assert.equal(await inputValue(), '', 'preventDefault must stop the Enter newline')
  assert.equal(await page.evaluate(`document.activeElement.id`), 'input')

  // Trusted arrows move the highlight and keep focus in the textarea.
  await type('/')
  await focusComposer()
  await trustedKey('ArrowDown')
  assert.deepEqual((await menuState()).items.map(item => item.selected), [false, true])
  assert.equal(await page.evaluate(`document.activeElement.id`), 'input')
  await trustedKey('ArrowUp')
  assert.deepEqual((await menuState()).items.map(item => item.selected), [true, false])

  // Trusted Escape closes the palette and drops activedescendant wiring.
  await trustedKey('Escape')
  assert.equal((await menuState()).visible, false)
  assert.equal(await page.evaluate(`document.getElementById('input').getAttribute('aria-activedescendant')`), null)
  assert.equal((await axState()).expanded, false)

  // Trusted Shift+Enter inserts a newline instead of running the highlight.
  await type('/n')
  await focusComposer()
  await trustedKey('Enter', { modifiers: 8 })
  assert.equal((await menuState()).visible, false)
  assert.equal(await page.evaluate(`document.getElementById('input').value.includes('\\n')`), true)
  assert.equal(await frameCount('chat.new'), newCount + 1)
  await type('')

  // A trusted outside click dismisses the palette and keeps the draft.
  await type('/model')
  await focusComposer()
  const outside = await page.evaluate(`(() => {
    const rect = document.getElementById('activity').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + Math.min(160, rect.height / 2) };
  })()`)
  await trustedClickAt(outside.x, outside.y)
  assert.equal((await menuState()).visible, false)
  assert.equal(await inputValue(), '/model')

  // A trusted row click runs the command, keeps focus in the textarea, and
  // does not let the click bubble close the picker the command just opened.
  await type('/m')
  await focusComposer()
  await trustedClick('.slash-command[data-command="model"]')
  assert.equal(await modelMenuHidden(), false, 'row click must open the model picker')
  // A missed click (blur closes the palette before mouseup) would leave the
  // picker closed; the command then hands focus to its search field.
  assert.equal(await page.evaluate(`document.activeElement.id`), 'model-search')
  assert.equal(await inputValue(), '')
  assert.equal((await menuState()).visible, false)
  await trustedKey('Escape')
  assert.equal(await modelMenuHidden(), true)
  assert.equal(await page.evaluate(`document.activeElement.id`), 'input', 'Escape must return focus to the composer')

  // Tab runs the highlighted command too; /model opens the real model picker.
  await type('/m')
  await focusComposer()
  await trustedKey('Tab')
  assert.equal(await modelMenuHidden(), false)
  assert.equal(await page.evaluate(`document.activeElement.id`), 'model-search')
  assert.equal((await menuState()).visible, false)
  assert.equal(await frameCount('chat.send'), sendCount)
  await press('document', 'Escape')
  assert.equal(await modelMenuHidden(), true)
  assert.equal(await page.evaluate(`document.activeElement.id`), 'input', 'Escape must return focus to the composer')

  // The Send button runs an exact token, never sends it as text.
  await type('/model')
  await page.evaluate(`document.getElementById('send').click()`)
  await sleep(220)
  assert.equal(await modelMenuHidden(), false)
  assert.equal(await inputValue(), '')
  assert.equal(await frameCount('chat.send'), sendCount)
  await press('document', 'Escape')
  assert.equal(await modelMenuHidden(), true)
  assert.equal(await page.evaluate(`document.activeElement.id`), 'input', 'Escape must return focus to the composer')

  // A path-like draft remains ordinary text: a trusted Enter sends it
  // verbatim and leaves no stray newline behind.
  await type('/usr/local/bin')
  await focusComposer()
  await trustedKey('Enter')
  await sleep(250)
  const sent = await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.send').at(-1)`)
  assert.equal(sent.text, '/usr/local/bin')
  assert.equal(await frameCount('chat.send'), sendCount + 1)
  assert.equal(await inputValue(), '')
  await recv({ v: 1, type: 'chat.done', sessionId: 'session-preview0001', text: '', timings: { totalMs: 1 } })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
  await sleep(200)

  // While a turn is running, /model refuses with a visible wait message and
  // never opens the picker or sends the text.
  await sendPrompt(page, 'Stay busy while I try to switch models.')
  const busySendCount = await frameCount('chat.send')
  await type('/model')
  await focusComposer()
  await trustedKey('Enter')
  assert.equal(await modelMenuHidden(), true)
  assert.equal(await page.evaluate(`document.getElementById('toast').classList.contains('hidden')`), false)
  assert.match(await page.evaluate(`document.getElementById('toast').textContent`), /Wait for the current operation to finish/)
  assert.equal(await frameCount('chat.send'), busySendCount)
  await recv({ v: 1, type: 'chat.done', sessionId: 'session-preview0001', text: '', timings: { totalMs: 1 } })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
  await sleep(200)

  // /new during a running turn opens the draft view and keeps the session
  // alive; chat.done then retires the draft with a fresh chat.new.
  await sendPrompt(page, 'Keep working while I start another chat.')
  await type('/new')
  assert.equal((await menuState()).visible, true)
  await focusComposer()
  await trustedKey('Enter')
  assert.equal(await frameCount('chat.new'), newCount + 1, 'busy /new must not retire the running session early')
  assert.equal(await page.evaluate(`document.querySelector('.app').classList.contains('new-chat-draft')`), true)
  assert.equal(await inputValue(), '')
  assert.equal((await menuState()).visible, false)
  await recv({ v: 1, type: 'chat.done', sessionId: 'session-preview0001', text: '', timings: { totalMs: 1 } })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
  await sleep(250)
  assert.equal(await frameCount('chat.new'), newCount + 2)
  assert.equal(await page.evaluate(`document.querySelector('.app').classList.contains('new-chat-draft')`), false)
  assert.equal(await inputValue(), '')

  // Attachments pasted in the draft view survive retirement: finishing the old
  // turn must not silently discard the next message the user prepared.
  await sendPrompt(page, 'Finish this while I prepare the next one.')
  await type('/new')
  await focusComposer()
  await trustedKey('Enter')
  assert.equal(await page.evaluate(`document.querySelector('.app').classList.contains('new-chat-draft')`), true)
  await pasteImage(page, 'draft.png')
  assert.equal(await page.evaluate(`Boolean(document.querySelector('.image-chip')?.textContent.includes('draft.png'))`), true)
  await recv({ v: 1, type: 'chat.done', sessionId: 'session-preview0001', text: '', timings: { totalMs: 1 } })
  await recv({ v: 1, type: 'chat.status', status: 'idle' })
  await sleep(250)
  assert.equal(await page.evaluate(`document.querySelector('.app').classList.contains('new-chat-draft')`), false)
  assert.equal(
    await page.evaluate(`Boolean(document.querySelector('.image-chip')?.textContent.includes('draft.png'))`),
    true,
    'draft-view attachments must survive the draft retirement',
  )
  await page.evaluate(`document.querySelector('.image-chip button').click()`)
  await sleep(120)
  assert.equal(await page.evaluate(`document.querySelectorAll('.image-chip').length`), 0)

  assert.equal(await page.evaluate(`document.getElementById('pause')`), null)
  assert.equal(await page.evaluate(`document.querySelector('.pause-toggle')`), null)

  // A dropped bridge ends the live turn instead of stranding a "Working…" clock
  // or a /new draft whose sends would report a session that no longer exists.
  await sendPrompt(page, 'Dropped bridge test.')
  await type('/new')
  await focusComposer()
  await trustedKey('Enter')
  assert.equal(await page.evaluate(`document.querySelector('.app').classList.contains('new-chat-draft')`), true)
  assert.equal(await page.evaluate('window.__mockDrop()'), true)
  await sleep(350)
  const droppedState = await page.evaluate(`(() => ({
    draft: document.querySelector('.app').classList.contains('new-chat-draft'),
    runningSteps: document.querySelectorAll('.activity-step.running').length,
    runningTurns: document.querySelectorAll('.agent-turn.running').length,
    sendLabel: document.getElementById('send').getAttribute('aria-label'),
    phase: document.getElementById('activity-phase').textContent,
    timingLive: document.querySelectorAll('.timing-live').length,
    timerHidden: document.getElementById('activity-timer').classList.contains('hidden'),
    waitToast: /Wait for the running session/.test(document.getElementById('toast').textContent),
  }))()`)
  assert.deepEqual(droppedState, {
    draft: false,
    runningSteps: 0,
    runningTurns: 0,
    sendLabel: 'Send',
    phase: 'Companion offline',
    timingLive: 0,
    timerHidden: true,
    waitToast: false,
  })
  await sleep(2_700)
  assert.equal(await page.evaluate('Boolean(window.__mockSocket)'), true, 'the panel must reconnect after a dropped bridge')
  await batch(HELLO_FRAMES)
  await sleep(350)
  const reconnectedState = await page.evaluate(`(() => ({
    draft: document.querySelector('.app').classList.contains('new-chat-draft'),
    sendLabel: document.getElementById('send').getAttribute('aria-label'),
    phase: document.getElementById('activity-phase').textContent,
  }))()`)
  assert.deepEqual(reconnectedState, { draft: false, sendLabel: 'Send', phase: 'Ready' })
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
  // The background worker flags the one-time disclaimer on install/reload;
  // clear it here so every scenario starts from an already-dismissed notice.
  await page.evaluate(`chrome.storage.local.set({ 'crazyagent.settings': ${JSON.stringify(settings)}, 'crazyagent.disclaimerPending': false })`)
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
  } else if (SCENARIO === 'waiting') {
    const { recv, batch } = makePage(page)
    await batch(HELLO_FRAMES)
    await sleep(300)
    await sendPrompt(page, 'Think before answering.')
    await recv({ v: 1, type: 'chat.activity', kind: 'model-start', turn: 1, step: 1, attemptId: 'waiting' })
    await sleep(320)
    const waiting = await page.evaluate(`(() => {
      const loader = document.querySelector('.activity-step.running .thinking-wait');
      if (!loader) return null;
      const ball = loader.querySelector('.thinking-ball');
      const shadow = loader.querySelector('.thinking-ball-shadow');
      return {
        visible: loader.getClientRects().length > 0,
        label: loader.textContent,
        ballAnimation: getComputedStyle(ball).animationName,
        shadowAnimation: getComputedStyle(shadow).animationName,
        glossy: getComputedStyle(ball).backgroundImage.includes('radial-gradient'),
      };
    })()`)
    assert.deepEqual(waiting, {
      visible: true,
      label: 'gathering thoughts',
      ballAnimation: 'thinking-ball-bounce',
      shadowAnimation: 'thinking-ball-shadow',
      glossy: true,
    })
    const firstBallTransform = await page.evaluate(`getComputedStyle(document.querySelector('.thinking-ball')).transform`)
    await sleep(180)
    const nextBallTransform = await page.evaluate(`getComputedStyle(document.querySelector('.thinking-ball')).transform`)
    assert.notEqual(nextBallTransform, firstBallTransform)
    await shot('dark')
    await recv({ v: 1, type: 'chat.activity', kind: 'reasoning', text: 'The first streamed thought.' })
    await assertVisibleReasoning(page, '.activity-step.running .activity-entry.reasoning.streaming', 'The first streamed thought.')
    assert.equal(await page.evaluate(`document.querySelector('.thinking-wait') === null`), true)
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
    const settingsSections = await page.evaluate(`[...document.querySelectorAll('#settings-modal .settings-body > .settings-section > h3')].map(node => node.textContent)`)
    assert.deepEqual(settingsSections, ['Model', 'Connection', 'Capture'], 'Settings should lead with the model info')
    const settingsScroll = await page.evaluate(`(() => {
      const body = document.querySelector('#settings-modal .settings-body');
      const model = document.getElementById('model-label').getBoundingClientRect();
      const frame = body.getBoundingClientRect();
      return { scrollTop: body.scrollTop, modelTop: model.top, frameTop: frame.top, active: document.activeElement.id };
    })()`)
    assert.equal(settingsScroll.scrollTop, 0, 'Settings should open at the top')
    assert.ok(settingsScroll.modelTop >= settingsScroll.frameTop, 'Model heading should be visible at the top of the settings body')
    assert.equal(settingsScroll.active, 'setting-apikey', 'A configured setup should open focused on the model section')
    await shot('settings')
    // The docked panel can be much shorter than this preview; opening settings
    // must still land on the model section instead of auto-scrolling to the
    // pairing token.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 620, deviceScaleFactor: 2, mobile: false })
    await sleep(200)
    await page.evaluate(`document.getElementById('settings-close').click()`)
    await sleep(150)
    assert.equal(
      await page.evaluate(`document.activeElement.id`),
      'input',
      'closing settings must return focus to the composer',
    )
    await page.evaluate(`document.getElementById('settings').click()`)
    await sleep(300)
    const shortSettings = await page.evaluate(`(() => {
      const body = document.querySelector('#settings-modal .settings-body');
      const model = document.getElementById('model-label').getBoundingClientRect();
      const frame = body.getBoundingClientRect();
      return { scrollTop: body.scrollTop, modelTop: model.top, frameTop: frame.top };
    })()`)
    assert.equal(shortSettings.scrollTop, 0, 'Settings should not auto-scroll away from the model section on a short panel')
    assert.ok(shortSettings.modelTop >= shortSettings.frameTop, 'Model heading should stay visible on a short panel')
    await page.evaluate(`document.getElementById('settings-close').click()`)
    await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 940, deviceScaleFactor: 2, mobile: false })
    await sleep(200)
    await page.evaluate(`document.getElementById('debug-log').click()`)
    await sleep(300)
    await shot('debug-log')
  } else if (SCENARIO === 'disclaimer') {
    // The background worker flags the notice on extension install/reload. Set
    // the flag directly so the preview shows exactly what a user sees, then
    // verify the hands-off warning is the dominant block, it covers the whole
    // panel, is cleared once, and stays gone when the panel is merely reopened.
    const noticeState = () => page.evaluate(`(async () => {
      const dialog = document.getElementById('disclaimer');
      const rect = dialog.open ? dialog.getBoundingClientRect() : null;
      const stored = await chrome.storage.local.get('crazyagent.disclaimerPending');
      const warning = document.querySelector('.disclaimer-warning');
      const copy = document.getElementById('disclaimer-copy');
      const styles = el => {
        const computed = getComputedStyle(el);
        return {
          fontSize: parseFloat(computed.fontSize),
          fontWeight: Number(computed.fontWeight),
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          backgroundImage: computed.backgroundImage,
          borderWidth: parseFloat(computed.borderTopWidth),
        };
      };
      return {
        open: dialog.open,
        rect: rect && { width: rect.width, height: rect.height, left: rect.left, top: rect.top },
        viewport: { width: innerWidth, height: innerHeight },
        title: document.getElementById('disclaimer-title').textContent,
        warning: warning.textContent.replace(/\\s+/g, ' ').trim(),
        copy: copy.textContent,
        warningStyles: styles(warning),
        titleStyles: styles(document.getElementById('disclaimer-title')),
        copyStyles: styles(copy),
        warningBeforeCopy: Boolean(warning.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING),
        warningAboveCopy: warning.getBoundingClientRect().bottom <= copy.getBoundingClientRect().top + 1,
        describedBy: (dialog.getAttribute('aria-describedby') || '').split(/\\s+/),
        focused: document.activeElement?.id,
        pending: stored['crazyagent.disclaimerPending'],
      };
    })()`)
    await page.evaluate(`chrome.storage.local.set({ 'crazyagent.disclaimerPending': true, 'crazyagent.settings': ${JSON.stringify({ ...settings, paused: true })} })`)
    await page.send('Page.reload')
    await sleep(1400)
    const opened = await noticeState()
    assert.equal(opened.open, true)
    assert.deepEqual(opened.rect, { width: opened.viewport.width, height: opened.viewport.height, left: 0, top: 0 })
    // The warning is the point of the notice: it must spell out the hands-off
    // rule, and it must read as the dominant block ahead of the quiet copy.
    assert.equal(opened.title, "Don't touch the browser")
    assert.match(opened.warning, /while the agent is running/i)
    assert.match(opened.warning, /don'?t touch the browser/i)
    assert.match(opened.warning, /clicking, typing, scrolling, or switching tabs/i)
    assert.match(opened.warning, /break the task/i)
    assert.match(opened.copy, /unexpected/)
    assert.ok(opened.describedBy.includes('disclaimer-warning-kicker'), 'the warning lead-in must be part of the dialog description')
    assert.ok(opened.describedBy.includes('disclaimer-warning-copy'), 'the warning body must be part of the dialog description')
    assert.ok(opened.describedBy.includes('disclaimer-copy'), 'the supporting copy must stay part of the dialog description')
    assert.equal(opened.warningBeforeCopy, true, 'the warning must come before the supporting copy')
    assert.equal(opened.warningAboveCopy, true, 'the warning must sit above the supporting copy')
    assert.ok(opened.titleStyles.fontSize >= opened.copyStyles.fontSize * 1.5, 'the warning headline must dominate the supporting copy')
    assert.ok(opened.titleStyles.fontWeight > opened.copyStyles.fontWeight, 'the warning headline must be heavier than the supporting copy')
    assert.notEqual(opened.titleStyles.color, opened.copyStyles.color, 'the warning headline must use warning color')
    assert.ok(opened.warningStyles.borderWidth > 0, 'the warning must own a bordered surface')
    assert.notEqual(opened.warningStyles.backgroundColor, 'rgba(0, 0, 0, 0)', 'the warning surface must be filled')
    assert.match(opened.warningStyles.backgroundImage, /gradient/, 'the warning surface must carry the warm gradient')
    assert.equal(opened.focused, 'disclaimer-dismiss')
    assert.equal(opened.pending, false, 'showing the notice must consume the pending flag')
    assert.equal(await page.evaluate(`document.querySelectorAll('.modal:not(.hidden)').length`), 0)
    await shot('full-screen')
    // Escape is a second, non-button way out; it must not leave the notice stuck.
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(250)
    assert.equal((await noticeState()).open, false)
    assert.equal(
      await page.evaluate(`document.activeElement.id`),
      'input',
      'dismissing the one-time notice must leave focus in the composer',
    )
    // Reopening the panel (page reload, same extension load) stays quiet.
    await page.send('Page.reload')
    await sleep(1400)
    const reopened = await noticeState()
    assert.equal(reopened.open, false)
    assert.equal(reopened.pending, false)
    assert.equal(await page.evaluate(`Boolean(window.__mockSocket)`), true)
    const pauseMigration = await page.evaluate(`(async () => {
      const stored = await chrome.storage.local.get('crazyagent.settings');
      return {
        present: document.getElementById('pause') !== null,
        paused: stored['crazyagent.settings']?.paused,
      };
    })()`)
    assert.deepEqual(pauseMigration, { present: false, paused: false })
  } else if (SCENARIO === 'interactions') {
    await page.evaluate(`window.__mockBatch(${JSON.stringify(HELLO_FRAMES)})`)
    await sleep(400)
    await page.evaluate(`window.__mockReceive({ v: 1, type: 'browser.command', id: 'auto-protected', callId: 'auto', turnId: 'turn-protected', command: { op: 'snapshot', args: {} } })`)
    await sleep(300)
    const protectedResult = await page.evaluate(`window.__frames.filter(frame => frame.type === 'browser.result' && frame.id === 'auto-protected').at(-1)`)
    assert.equal(protectedResult.ok, false)
    assert.equal(protectedResult.error.code, 'PROTECTED_PAGE')
    assert.equal(await page.evaluate(`document.getElementById('activity-log').textContent.includes('Chrome blocks screenshots and scripts on this page')`), false)
    assert.equal(await page.evaluate(`document.getElementById('attach')`), null)
    assert.equal(await page.evaluate(`document.getElementById('file-input')`), null)
    assert.equal(await page.evaluate(`document.getElementById('mic') !== null`), true)
    await pasteImage(page, 'notes.png')
    await sendPrompt(page, 'Review the notes')
    const sent = await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.send').at(-1)`)
    assert.match(sent.text, /Review the notes/)
    assert.equal(sent.images.length, 1)
    assert.equal(sent.images[0].name, 'notes.png')
    assert.equal(sent.images[0].mimeType, 'image/png')
    const controlRects = await page.evaluate(`(() => {
      const stop = document.getElementById('stop').getBoundingClientRect();
      const send = document.getElementById('send').getBoundingClientRect();
      return { stopBottom: stop.bottom, sendTop: send.top, stopX: stop.x + stop.width / 2, sendX: send.x + send.width / 2 };
    })()`)
    assert.ok(controlRects.stopBottom <= controlRects.sendTop)
    assert.equal(controlRects.stopX, controlRects.sendX)
    await page.evaluate(`document.getElementById('stop').click()`)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.stop').length`), 1)
    await page.evaluate(`window.__mockReceive({ v: 1, type: 'chat.stopped', reason: 'user', sessionId: 'session-preview0001' })`)
    await sleep(200)
    const newChatsBeforeReopen = await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.new').length`)
    assert.equal(newChatsBeforeReopen, 1)
    await page.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.new').length`), newChatsBeforeReopen)
    await page.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`)
    await sleep(250)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.new').length`), newChatsBeforeReopen + 1)
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
    assert.equal(await page.evaluate(`document.activeElement.id`), 'input', 'selecting a model must return focus to the composer')
    await page.evaluate(`window.__mockReceive({ v: 1, type: 'llm.configured', ok: true, llm: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true }, reasoningEffort: 'medium' }, credentials: { configured: true, source: 'stored' }, dsh: { state: 'ready' } })`)
    await page.evaluate(`document.getElementById('settings').click()`)
    await page.evaluate(`document.querySelector('[data-effort="high"]').click()`)
    await page.evaluate(`document.getElementById('settings-save').click()`)
    assert.equal(
      await page.evaluate(`document.activeElement.id`),
      'input',
      'saving settings must return focus to the composer',
    )
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'llm.configure').at(-1).reasoningEffort`), 'high')
    await page.evaluate(`window.__mockReceive({ v: 1, type: 'llm.configured', ok: true, llm: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true }, reasoningEffort: 'high' }, credentials: { configured: true, source: 'stored' }, dsh: { state: 'ready' } })`)
    await page.evaluate(`document.getElementById('debug-log').click()`)
    await page.evaluate(`document.getElementById('log-include-screenshots').click()`)
    await page.evaluate(`document.getElementById('log-export').click()`)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'log.export').at(-1).includeScreenshots`), false)
    await page.evaluate(`document.getElementById('log-copy-summary').click()`)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'log.summary').length`), 1)
    await shot('debug-actions')
  } else if (SCENARIO === 'recent') {
    const { batch } = makePage(page)
    await batch(HELLO_FRAMES)
    await sleep(300)
    for (const title of ['First task', 'Second task', 'Third task', 'Fourth task']) {
      await sendPrompt(page, title)
      await finishPrompt(page, `session-${title.toLowerCase().replaceAll(' ', '-')}`, `${title} complete`)
      await page.evaluate(`document.getElementById('new-chat').click()`)
      await sleep(180)
    }
    const recentTitles = () => page.evaluate(`[...document.querySelectorAll('.recent-session-title')].map(node => node.textContent)`)
    assert.deepEqual(await recentTitles(), ['Fourth task', 'Third task', 'Second task'])
    assert.equal(await page.evaluate(`document.querySelectorAll('.recent-session-open').length`), 3)
    assert.equal(await page.evaluate(`document.getElementById('activity-empty').getClientRects().length > 0`), true)
    await shot('three')
    await page.evaluate(`document.querySelector('.recent-session-title').textContent = 'Fourth task ' + 'x'.repeat(240)`)
    await setWidth(280)
    const narrowLayout = await page.evaluate(`(() => Object.fromEntries(['#activity-empty', '#recent-sessions', '#recent-sessions-list', '.recent-session-open', '.recent-session-title', '#recent-sessions-all'].map(selector => {
      const node = document.querySelector(selector);
      const rect = node.getBoundingClientRect();
      return [selector, { left: rect.left, right: rect.right, width: rect.width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, overflowX: getComputedStyle(node).overflowX }];
    })))()`)
    for (const selector of ['#activity-empty', '#recent-sessions', '#recent-sessions-list', '.recent-session-open', '#recent-sessions-all']) {
      const layout = narrowLayout[selector]
      assert.ok(layout.left >= 0 && layout.right <= 280, `${selector} exceeds the 280px viewport: ${JSON.stringify(layout)}`)
      assert.equal(layout.scrollWidth, layout.clientWidth, `${selector} scrolls horizontally: ${JSON.stringify(layout)}`)
    }
    assert.ok(narrowLayout['.recent-session-title'].scrollWidth > narrowLayout['.recent-session-title'].clientWidth, 'long title should truncate instead of widening the list')
    await shot('narrow')
    await setWidth(420)

    await page.evaluate(`document.getElementById('recent-sessions-all').click()`)
    assert.equal(await page.evaluate(`document.querySelectorAll('.history-item').length`), 4)
    await page.evaluate(`document.getElementById('history-close').click()`)
    await page.evaluate(`document.querySelector('.recent-session-open').click()`)
    await sleep(180)
    assert.equal(await page.evaluate(`document.querySelector('.turn-prompt').textContent`), 'Fourth task')
    assert.equal(await page.evaluate(`document.getElementById('activity-empty').getClientRects().length`), 0)
    const backLayout = await page.evaluate(`(() => {
      const button = document.getElementById('back-home');
      const rect = button.getBoundingClientRect();
      return {
        visible: button.getClientRects().length > 0,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        radius: getComputedStyle(button).borderRadius,
        firstTurnTop: document.querySelector('.activity-turn').getBoundingClientRect().top,
      };
    })()`)
    assert.equal(backLayout.visible, true)
    assert.equal(backLayout.width, 36)
    assert.equal(backLayout.height, 36)
    assert.equal(backLayout.radius, '50%')
    assert.ok(backLayout.firstTurnTop >= backLayout.bottom, 'back button must not cover the first message')
    await shot('chat')
    await page.evaluate(`document.getElementById('back-home').click()`)
    await sleep(180)
    assert.equal(await page.evaluate(`document.getElementById('back-home').getClientRects().length`), 0)
    assert.equal(await page.evaluate(`document.getElementById('activity-empty').getClientRects().length > 0`), true)

    await sendPrompt(page, 'Keep this task running')
    assert.equal(await page.evaluate(`document.getElementById('back-home').getClientRects().length > 0`), true)
    const newChatsBeforeDraft = await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.new').length`)
    await page.evaluate(`document.getElementById('back-home').click()`)
    await sleep(180)
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.new').length`), newChatsBeforeDraft)
    assert.equal(await page.evaluate(`document.querySelectorAll('.activity-turn').length`), 1)
    assert.equal(await page.evaluate(`document.getElementById('back-home').getClientRects().length`), 0)
    assert.equal(await page.evaluate(`document.getElementById('activity-empty').getClientRects().length > 0`), true)
    assert.deepEqual(await recentTitles(), ['Keep this task running', 'Fourth task', 'Third task'])
    assert.equal(await page.evaluate(`document.querySelectorAll('.recent-session-open.running').length`), 1)
    assert.equal(await page.evaluate(`document.querySelector('.recent-session-running').textContent`), 'Running')
    const spinnerStyle = await page.evaluate(`(() => {
      const style = getComputedStyle(document.querySelector('.recent-session-spinner'));
      return { color: style.borderTopColor, animation: style.animationName };
    })()`)
    assert.deepEqual(spinnerStyle, { color: 'rgb(255, 195, 0)', animation: 'recent-session-spin' })
    await setWidth(280)
    const runningLayout = await page.evaluate(`(() => {
      const empty = document.getElementById('activity-empty');
      const row = document.querySelector('.recent-session-open.running');
      return { clientWidth: empty.clientWidth, scrollWidth: empty.scrollWidth, rowRight: row.getBoundingClientRect().right };
    })()`)
    assert.equal(runningLayout.scrollWidth, runningLayout.clientWidth)
    assert.ok(runningLayout.rowRight <= 280)
    await shot('running')
    await setWidth(420)

    await page.evaluate(`document.querySelector('.recent-session-open.running').click()`)
    await sleep(180)
    assert.equal(await page.evaluate(`document.getElementById('activity-empty').getClientRects().length`), 0)
    assert.equal(await page.evaluate(`document.querySelector('.turn-prompt').textContent`), 'Keep this task running')
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.new').length`), newChatsBeforeDraft)

    await page.evaluate(`document.getElementById('new-chat').click()`)
    await sleep(180)
    await finishPrompt(page, 'session-running', 'Running task complete')
    assert.equal(await page.evaluate(`window.__frames.filter(frame => frame.type === 'chat.new').length`), newChatsBeforeDraft + 1)
    assert.equal(await page.evaluate(`document.querySelectorAll('.activity-turn').length`), 0)
    assert.equal(await page.evaluate(`document.getElementById('activity-empty').getClientRects().length > 0`), true)
    assert.equal(await page.evaluate(`document.querySelectorAll('.recent-session-open.running, .recent-session-spinner').length`), 0)
    assert.deepEqual(await recentTitles(), ['Keep this task running', 'Fourth task', 'Third task'])
    await shot('finished')
  } else if (SCENARIO === 'queue') {
    await playQueueScenario(page, shot)
  } else if (SCENARIO === 'composer') {
    await playComposerScenario(page, shot)
  } else if (SCENARIO === 'slash') {
    await playSlashScenario(page, shot)
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