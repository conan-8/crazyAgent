#!/usr/bin/env node
/**
 * CrazyAgent companion: the local bridge between the Chrome side panel and a
 * DSH 0.2.1 runtime (sdk-minimal profile + browser-use provider).
 *
 * The model route is OpenRouter. The side panel supplies the API key and picks
 * an image-capable model; the companion writes a small generated DSH overlay,
 * passes the key to DSH as CRAZYAGENT_API_KEY, and warms/restarts the runtime.
 *
 * The companion prints a pairing token. Paste it into the side panel Settings.
 * It binds loopback only; nothing is exposed to the network.
 *
 * Debug logs: .dsh-home/browser-agent/logs/<runId>/
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge } from './bridge.mjs'
import { DshRunner } from './dsh.mjs'
import { LogStore } from './log-store.mjs'
import { buildPromptBlocks, normalizeImageAttachments, promptStats } from './prompt.mjs'
import { PROTOCOL_VERSION, errorMessage, isRecord } from './protocol.mjs'
import { clearKeyFile, resolveApiKey, writeKeyFile } from './credentials.mjs'
import {
  DEFAULT_BASE_URL,
  baseEffortFor,
  buildLlmConfig,
  fetchModels,
  findModel,
  normalizeBaseUrl,
  normalizeReasoningEffort,
  readLlmConfig,
  resolveRequestMaxTokens,
  validateApiKey,
  writeLlmConfig,
  writeLlmPatch,
} from './openrouter.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = '0.1.0'
const PROVIDER = 'openrouter'

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue
    if (!token.startsWith('--')) continue
    const raw = token.slice(2)
    const eq = raw.indexOf('=')
    if (eq !== -1) {
      out[raw.slice(0, eq)] = raw.slice(eq + 1)
      continue
    }
    if (raw === 'no-dsh' || raw === 'no-auto-capture' || raw === 'new-token' || raw === 'help') {
      out[raw] = true
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[raw] = next
      i += 1
    } else {
      out[raw] = true
    }
  }
  return out
}

const cli = parseArgs(process.argv.slice(2))

if (cli.help === true) {
  process.stdout.write(`CrazyAgent companion ${VERSION}

  --port <n>                    bridge port (default 17871)
  --token <token>               fixed pairing token (default: .dsh-home/browser-agent/token)
  --new-token                   rotate the pairing token
  --base-url <url>              OpenRouter-compatible base URL
                                (default ${DEFAULT_BASE_URL})
  --model <id>                  optional initial model id; otherwise choose it in
                                the side panel after entering your API key
  --reasoning-effort <level>    auto (default), off, low, medium, or high
  --max-tokens <n>              output cap (default: selected model's maximum)
  --dsh-home <path>             harness home (default .dsh-home)
  --patch <path>                base profile overlay (default config/browser.patch.yml)
  --credentials <path>         fallback DSH credential file
  --no-dsh                      bridge-only test mode
  --no-auto-capture             do not attach a fresh DOM/text or screenshot view
  --help                        this text

The OpenRouter API key is entered in the side panel, or supplied through
CRAZYAGENT_API_KEY / OPENROUTER_API_KEY. It is passed to DSH as
CRAZYAGENT_API_KEY and redacted from debug logs.
`)
  process.exit(0)
}

/** @type {LogStore | null} */
let logStore = null

/** @param {string} message */
function log(message) {
  process.stderr.write(`[crazyagent] ${message}\n`)
  try {
    logStore?.record('companion', 'terminal', { message }, { severity: 'info', noSignal: true })
  } catch {
    // Logging must never break startup or a turn.
  }
}

const port = Number(cli.port ?? process.env.CRAZYAGENT_PORT ?? 17871)
const host = '127.0.0.1'
const dshHome = resolve(String(cli['dsh-home'] ?? process.env.CRAZYAGENT_DSH_HOME ?? join(ROOT, '.dsh-home')))
const workspace = join(dshHome, 'workspace')
const browserDir = join(dshHome, 'browser-agent')
const tokenFile = join(browserDir, 'token')
const apiKeyFile = join(browserDir, 'api-key')
const llmConfigPath = join(browserDir, 'llm.json')
const llmPatchPath = join(browserDir, 'llm.patch.yml')
const patchFile = resolve(String(cli.patch ?? process.env.CRAZYAGENT_PATCH ?? join(ROOT, 'config', 'browser.patch.yml')))
const credentialsPath = resolve(String(
  cli.credentials
  ?? process.env.CRAZYAGENT_CREDENTIALS_PATH
  ?? join(homedir(), '.dsh', '.credentials.yaml'),
))
const baseUrlOption = normalizeBaseUrl(
  typeof cli['base-url'] === 'string'
    ? cli['base-url']
    : process.env.CRAZYAGENT_BASE_URL ?? DEFAULT_BASE_URL,
)
const modelOverride = typeof cli.model === 'string'
  ? cli.model
  : process.env.CRAZYAGENT_MODEL ?? undefined
const reasoningEffort = normalizeReasoningEffort(
  typeof cli['reasoning-effort'] === 'string'
    ? cli['reasoning-effort']
    : process.env.CRAZYAGENT_REASONING_EFFORT ?? 'auto',
)
const maxTokensOption = cli['max-tokens'] ?? process.env.CRAZYAGENT_MAX_TOKENS
const maxTokens = maxTokensOption === undefined ? undefined : Number(maxTokensOption)
const noDsh = cli['no-dsh'] === true
const autoCapture = cli['no-auto-capture'] !== true

if (typeof cli.provider === 'string' && cli.provider !== PROVIDER) {
  log(`only the ${PROVIDER} provider is supported in this build (got ${cli.provider})`)
  process.exit(2)
}
if (!Number.isFinite(port) || port < 0 || port > 65535) {
  log(`invalid port ${String(cli.port)}`)
  process.exit(2)
}
if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
  log(`invalid max tokens ${String(cli['max-tokens'])}`)
  process.exit(2)
}

mkdirSync(workspace, { recursive: true })
mkdirSync(browserDir, { recursive: true })

/** @returns {string} */
function resolveToken() {
  if (typeof cli.token === 'string' && cli.token.length > 0) return cli.token
  if (cli['new-token'] !== true && existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, 'utf8').trim()
    if (existing.length > 0) return existing
  }
  const generated = randomBytes(32).toString('hex')
  writeFileSync(tokenFile, generated, { mode: 0o600 })
  try {
    chmodSync(tokenFile, 0o600)
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  return generated
}

const token = resolveToken()

let dshVersion = 'unknown'
try {
  dshVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
} catch {
  // Diagnostic only.
}

const keyState = resolveApiKey({
  manualKeyPath: apiKeyFile,
  credentialsPath,
  ref: 'OPENROUTER_API_KEY',
})
let apiKey = keyState.apiKey
let apiKeySource = keyState.source
let llmConfig = readLlmConfig(llmConfigPath)
let modelCatalog = { baseUrl: '', fetchedAt: 0, models: [] }

const runId = `run-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomBytes(3).toString('hex')}`
logStore = new LogStore({
  root: join(browserDir, 'logs'),
  runId,
  secret: token,
  meta: {
    companionVersion: VERSION,
    dshVersion,
    provider: PROVIDER,
    model: llmConfig?.model.id ?? 'unconfigured',
    baseUrl: llmConfig?.baseUrl ?? baseUrlOption,
    reasoningEffort: llmConfig?.model?.reasoning ? (llmConfig.reasoningEffort ?? reasoningEffort) : null,
    maxTokens: maxTokens ?? llmConfig?.model.maxTokens ?? null,
    bridgeUrl: `ws://${host}:${port}/bridge`,
    dshHome,
    workspace,
    patchFile,
    autoCapture,
  },
})
try {
  await logStore.init()
} catch (error) {
  log(`debug log init failed: ${errorMessage(error)}`)
}

if (!existsSync(patchFile)) {
  log(`patch: ${patchFile} not found; the DSH runtime will boot the stock sdk-minimal profile`)
}

/** @type {{state: 'starting' | 'ready' | 'error' | 'disabled', message?: string}} */
let dshStatus = noDsh ? { state: 'disabled' } : { state: 'starting' }
/** @type {DshRunner | undefined} */
let runner
let running = false
let stopRequested = false

/** @param {string} baseUrl @param {boolean} [force] */
async function getModels(baseUrl, force = false) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (
    !force
    && modelCatalog.baseUrl === normalized
    && Date.now() - modelCatalog.fetchedAt < 5 * 60 * 1000
    && modelCatalog.models.length > 0
  ) {
    return modelCatalog.models
  }
  const models = await fetchModels(normalized)
  modelCatalog = { baseUrl: normalized, fetchedAt: Date.now(), models }
  return models
}

function effortPolicy() {
  return llmConfig?.reasoningEffort ?? reasoningEffort
}

function llmInfo() {
  return {
    provider: PROVIDER,
    baseUrl: llmConfig?.baseUrl ?? baseUrlOption,
    model: llmConfig?.model ?? null,
    reasoningEffort: llmConfig?.model?.reasoning ? effortPolicy() : null,
  }
}

function credentialsInfo() {
  return {
    configured: typeof apiKey === 'string' && apiKey.length > 0,
    source: apiKeySource,
  }
}

/** @param {import('ws').WebSocket | undefined} _ui */
function sendCompanionHello(_ui) {
  bridge.sendToUi({
    v: PROTOCOL_VERSION,
    type: 'chat.hello',
    companion: VERSION,
    provider: PROVIDER,
    model: llmConfig?.model.id ?? null,
    autoCapture,
    dsh: dshStatus,
    llm: llmInfo(),
    credentials: credentialsInfo(),
    log: { runId, path: logStore.path },
  })
}

/** @param {string} status @param {Record<string, unknown>} [extra] */
function sendStatus(status, extra = {}) {
  bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'chat.status', status, ...extra })
}

/** @param {unknown[]} events */
function collectUsage(events) {
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 }
  for (const event of events) {
    if (!isRecord(event) || event.type !== 'assistant/message') continue
    const data = isRecord(event.data) ? event.data : {}
    const usage = isRecord(data.usage) ? data.usage : undefined
    if (!usage) continue
    for (const key of Object.keys(totals)) totals[key] += Number(usage[key]) || 0
  }
  return totals
}

function makeRunner() {
  if (!llmConfig) throw new Error('No OpenRouter model is configured')
  if (!apiKey) throw new Error('No OpenRouter API key is configured')
  writeLlmPatch(llmPatchPath, llmConfig)
  return new DshRunner({
    bridgeUrl: `ws://${host}:${bridge.port}/bridge`,
    bridgeToken: token,
    dshHome,
    workspace,
    processCwd: ROOT,
    patchFiles: [patchFile, llmPatchPath],
    provider: PROVIDER,
    model: llmConfig.model.id,
    reasoningEffort: llmConfig.model.reasoning ? baseEffortFor(effortPolicy()) : undefined,
    reasoningPolicy: llmConfig.model.reasoning ? effortPolicy() : 'off',
    maxTokens: resolveRequestMaxTokens(llmConfig.model, maxTokens),
    apiKey,
    credentialsPath,
    log,
  })
}

/** @param {string | undefined} resumeSessionId */
async function warmRunner(resumeSessionId) {
  if (!llmConfig) throw new Error('No OpenRouter model is configured')
  if (!apiKey) throw new Error('No OpenRouter API key is configured')
  dshStatus = { state: 'starting' }
  logStore.record('dsh', 'startup', {
    provider: PROVIDER,
    model: llmConfig.model.id,
    baseUrl: llmConfig.baseUrl,
    profile: 'sdk-minimal',
  }, { severity: 'info' })
  const next = makeRunner()
  try {
    await next.ensureStarted()
    let resumed = false
    if (resumeSessionId) {
      try {
        await next.resume(resumeSessionId)
        resumed = true
        logStore.record('dsh', 'session.resumed', { sessionId: resumeSessionId }, { severity: 'info' })
      } catch (error) {
        logStore.record('dsh', 'session.resume.error', { message: errorMessage(error) }, { severity: 'warn' })
      }
    }
    runner = next
    if (!resumed) logStore.sessionStart(next.sessionId)
    else logStore.sessionStart(resumeSessionId)
    dshStatus = { state: 'ready' }
    logStore.meta.provider = PROVIDER
    logStore.meta.model = llmConfig.model.id
    logStore.meta.baseUrl = llmConfig.baseUrl
    logStore.record('dsh', 'ready', {
      model: llmConfig.model.id,
      baseUrl: llmConfig.baseUrl,
      reasoningEffort: llmConfig.model.reasoning ? effortPolicy() : null,
      sessionId: runner.sessionId,
      resumed,
    }, { severity: 'info' })
    log(`dsh: ready (provider ${PROVIDER}, model ${llmConfig.model.id}, session ${runner.sessionId})`)
    return { resumed }
  } catch (error) {
    await next.close().catch(() => {})
    throw error
  }
}

/**
 * @param {{baseUrl: string, model: string, apiKey: string, remember: boolean, reasoningEffort?: string}} input
 */
async function configureLlm(input) {
  if (running) throw new Error('A turn is running. Wait for it to finish before changing the model or key.')
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const modelId = input.model.trim()
  const newKey = input.apiKey.trim()
  const key = newKey || apiKey
  if (modelId.length === 0) throw new Error('Select an OpenRouter model first')
  if (!key) throw new Error('Enter your OpenRouter API key')

  if (newKey) await validateApiKey(baseUrl, key)
  const models = await getModels(baseUrl)
  const model = findModel(models, modelId)
  if (!model) {
    throw new Error(`Model "${modelId}" is not in the image-capable OpenRouter model list. Refresh models and select one.`)
  }

  const previousSessionId = runner?.sessionId ?? logStore.sessionId
  if (runner) {
    await runner.close().catch(() => {})
    runner = undefined
  }

  llmConfig = buildLlmConfig(baseUrl, model, input.reasoningEffort ?? effortPolicy())
  writeLlmConfig(llmConfigPath, llmConfig)
  writeLlmPatch(llmPatchPath, llmConfig)
  apiKey = key
  apiKeySource = newKey ? 'manual' : apiKeySource
  if (newKey) {
    if (input.remember) {
      writeKeyFile(apiKeyFile, key)
      apiKeySource = 'stored'
    } else {
      clearKeyFile(apiKeyFile)
      apiKeySource = 'manual'
    }
  }

  dshStatus = { state: 'starting' }
  sendCompanionHello(bridge.ui)
  sendStatus('starting')
  logStore.record('companion', 'llm.configured', {
    provider: PROVIDER,
    baseUrl,
    model: modelId,
    reasoningEffort: model.reasoning ? normalizeReasoningEffort(input.reasoningEffort ?? effortPolicy()) : null,
    keyUpdated: Boolean(newKey),
    keyLength: key.length,
    remember: input.remember,
  }, { severity: 'info' })

  try {
    const { resumed } = await warmRunner(previousSessionId)
    sendCompanionHello(bridge.ui)
    sendStatus('ready')
    bridge.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'llm.configured',
      ok: true,
      llm: llmInfo(),
      credentials: credentialsInfo(),
      dsh: dshStatus,
      resumed,
      sessionId: runner?.sessionId,
    })
  } catch (error) {
    const message = errorMessage(error)
    dshStatus = { state: 'error', message }
    logStore.error(`OpenRouter configuration failed: ${message}`, { code: 'LLM_CONFIGURE_FAILED' })
    sendCompanionHello(bridge.ui)
    sendStatus('error')
    bridge.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'llm.configured',
      ok: false,
      error: message,
      llm: llmInfo(),
      credentials: credentialsInfo(),
      dsh: dshStatus,
    })
  }
}

/** @param {string} text @param {import('ws').WebSocket} ui @param {Record<string, unknown>} [message] */
async function handleChat(text, ui, message) {
  const prompt = text.trim()
  if (prompt.length === 0) return
  const images = normalizeImageAttachments(message?.images)
  if (running) {
    bridge.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'chat.error',
      message: stopRequested
        ? 'A turn is still stopping. Wait a moment, then send your message again.'
        : 'A turn is already running. Wait for it to finish.',
      recoverable: true,
    })
    return
  }
  if (noDsh || runner === undefined) {
    bridge.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'chat.error',
      message: 'OpenRouter is not ready. Open Settings, enter your API key, choose an image-capable model, and Save.',
      recoverable: true,
    })
    return
  }

  running = true
  const turnId = `turn-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
  const turnStart = performance.now()
  const wantAutoCapture = autoCapture && message?.autoCapture !== false
  let autoCaptureMs = 0
  let imageBytes = 0
  let promptTextBytes = 0
  let firstEventMs = null
  const toolCalls = new Set()
  const toolStarts = new Map()

  bridge.setTurnId(turnId)
  logStore.turnStart(turnId, prompt, {
    autoCapture: wantAutoCapture,
    provider: PROVIDER,
    model: llmConfig?.model.id,
    sessionId: runner.sessionId,
  })

  try {
    sendStatus(wantAutoCapture ? 'capturing' : 'thinking')
    let view = null
    if (wantAutoCapture) {
      logStore.record('companion', 'autoCapture.start', { detail: 'normal' }, { turnId, severity: 'info' })
      const captureStart = performance.now()
      try {
        view = await bridge.requestUi({ op: 'auto_view', args: {} }, 'auto', 5_000)
      } catch (error) {
        logStore.record('companion', 'autoCapture.error', { message: errorMessage(error) }, { turnId, severity: 'warn' })
        log(`auto-capture: ${errorMessage(error)}`)
      }
      autoCaptureMs = performance.now() - captureStart
      logStore.record('companion', 'autoCapture.end', {
        ok: view !== null,
        autoCaptureMs: Math.round(autoCaptureMs),
        image: view?.image
          ? { width: view.image.width, height: view.image.height, bytes: view.image.bytes, mimeType: view.image.mimeType }
          : undefined,
        tab: view?.tab,
      }, { turnId, severity: 'info' })
    }

    // The user may press Stop while the auto-capture round trip is in flight.
    // The runtime was never asked to run, so there is nothing to interrupt;
    // finish the turn as a user abort instead of starting the model.
    if (stopRequested) {
      logStore.record('companion', 'turn.stop.duringCapture', {
        turnId,
        autoCaptureMs: Math.round(autoCaptureMs),
      }, { turnId, severity: 'info' })
      throw new Error('turn stopped by user before the model run')
    }

    const blocks = buildPromptBlocks(view, prompt, new Date(), images)
    const stats = promptStats(blocks)
    promptTextBytes = stats.textBytes
    imageBytes = stats.imageBytes
    logStore.record('companion', 'prompt.build', {
      textBytes: promptTextBytes,
      imageBytes,
      images: stats.images,
      text: blocks[0]?.text,
    }, { turnId, severity: 'debug' })

    sendStatus('thinking')
    const result = await runner.run(blocks, notification => {
      if (firstEventMs === null) firstEventMs = Math.round(performance.now() - turnStart)
      logStore.recordDshNotification(notification, turnId)
      forwardNotification(notification, turnId, toolCalls, toolStarts)
    })

    const usage = collectUsage(result.events)
    const timings = {
      totalMs: Math.round(performance.now() - turnStart),
      autoCaptureMs: Math.round(autoCaptureMs),
      firstEventMs,
      toolCalls: toolCalls.size,
      promptTextBytes,
      imageBytes,
      images: blocks.filter(block => block.type === 'image').length,
    }
    if (logStore.sessionId !== result.sessionId) logStore.sessionStart(result.sessionId)
    logStore.turnEnd(turnId, { ok: true, finalText: result.finalResponse, timings, usage })
    bridge.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'chat.done',
      sessionId: result.sessionId,
      text: result.finalResponse,
      timings,
      model: llmConfig?.model.id,
      provider: PROVIDER,
    })
    sendStatus('idle')
  } catch (error) {
    const message = errorMessage(error)
    const timings = {
      totalMs: Math.round(performance.now() - turnStart),
      autoCaptureMs: Math.round(autoCaptureMs),
      firstEventMs,
      toolCalls: toolCalls.size,
      promptTextBytes,
      imageBytes,
    }
    if (stopRequested) {
      // A user stop tears the runtime down; the transport error is expected and
      // must not surface as a tool failure to the model/user.
      logStore.record('companion', 'turn.stop.done', {
        turnId,
        sessionId: runner?.resumeSessionId ?? runner?.sessionId,
        elapsedMs: Math.round(performance.now() - turnStart),
      }, { turnId, severity: 'info' })
      // log-store.turnEnd() records the TURN_STOPPED signal for aborted turns.
      logStore.turnEnd(turnId, { ok: false, aborted: true, reason: 'user', timings })
      bridge.sendToUi({
        v: PROTOCOL_VERSION,
        type: 'chat.stopped',
        turnId,
        reason: 'user',
        sessionId: runner?.sessionId ?? runner?.resumeSessionId,
        message: 'Stopped by user.',
      })
      sendStatus('idle')
    } else {
      logStore.error(message, { turnId, code: 'TURN_ERROR' })
      logStore.turnEnd(turnId, { ok: false, error: message, timings })
      bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'chat.error', message, recoverable: true })
      sendStatus('error')
    }
  } finally {
    running = false
    stopRequested = false
    bridge.setTurnId(undefined)
  }
}

/**
 * Stop the active turn. DSH has no turn-cancel RPC, so the runner interrupts
 * the runtime subprocess and the companion reports the abort via chat.stopped
 * when the in-flight run() rejects. The next turn resumes the same session.
 * @param {import('ws').WebSocket} _ui
 * @param {Record<string, unknown>} [_message]
 */
async function handleStop(_ui, _message) {
  const turnId = bridge.currentTurnId
  if (!running) {
    logStore.record('companion', 'turn.stop.idle', { turnId }, { turnId, severity: 'info' })
    bridge.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'chat.stopped',
      reason: 'idle',
      message: 'No turn is running.',
    })
    return
  }
  if (stopRequested) {
    // The first chat.stop already sent chat.stopping and owns the teardown;
    // duplicate presses (double click) must not interrupt twice.
    logStore.record('companion', 'turn.stop.duplicate', { turnId }, { turnId, severity: 'debug' })
    return
  }
  stopRequested = true
  logStore.record('companion', 'turn.stop.request', {
    turnId,
    sessionId: runner?.sessionId,
  }, { turnId, severity: 'info' })
  bridge.sendToUi({
    v: PROTOCOL_VERSION,
    type: 'chat.stopping',
    turnId,
    message: 'Stopping…',
  })
  try {
    const result = await runner?.interrupt()
    logStore.record('companion', 'turn.stop.interrupted', {
      turnId,
      sessionId: result?.sessionId,
      interrupted: result?.interrupted === true,
    }, { turnId, severity: 'info' })
  } catch (error) {
    logStore.record('companion', 'turn.stop.error', {
      turnId,
      message: errorMessage(error),
    }, { turnId, severity: 'warn' })
    log(`stop: ${errorMessage(error)}`)
  }
}

/** @param {import('ws').WebSocket} _ui */
async function handleNewChat(_ui) {
  if (running) {
    bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'chat.error', message: 'A turn is already running.', recoverable: true })
    return
  }
  if (runner === undefined || noDsh) {
    bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'chat.error', message: 'OpenRouter is not configured yet. Open Settings.', recoverable: true })
    return
  }
  const sessionId = await runner.newSession()
  logStore.sessionStart(sessionId)
  bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'chat.session', sessionId })
  sendStatus('idle')
}

/**
 * @param {{ method: string, params: Record<string, unknown> }} notification
 * @param {string} turnId
 * @param {Set<string>} toolCalls
 * @param {Map<string, number>} toolStarts
 */
function forwardNotification(notification, turnId, toolCalls, toolStarts) {
  const { method, params } = notification
  if (method === 'session.status') {
    const status = params.status
    if (status === 'running') sendStatus('thinking')
    if (status === 'idle') sendStatus('idle')
    return
  }
  if (method !== 'session.event') return
  const rootSessionId = runner?.sessionId
  if (typeof params.sessionId === 'string' && rootSessionId !== undefined && params.sessionId !== rootSessionId) return
  const event = params.event
  if (!isRecord(event)) return
  const data = isRecord(event.data) ? event.data : {}

  if (event.type === 'assistant/message') {
    const reasoning = extractReasoningText(data)
    if (reasoning.length > 0) {
      bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'chat.activity', kind: 'reasoning-committed', text: reasoning })
    }
    const text = extractAssistantText(data)
    if (text.length > 0) {
      logStore.assistant(turnId, text)
      bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'chat.assistant', text })
    }
    return
  }
  if (event.type === 'tool/call') {
    const callId = typeof data.callId === 'string' ? data.callId : undefined
    if (callId !== undefined) {
      toolCalls.add(callId)
      toolStarts.set(callId, performance.now())
    }
    let args = data.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        // Keep raw.
      }
    }
    logStore.toolCall(turnId, { callId, name: data.name, args })
    bridge.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'chat.tool_call',
      callId,
      name: data.name,
      args: data.arguments,
    })
    sendStatus('tool', { tool: data.name })
    return
  }
  if (event.type === 'tool/result') {
    const message = isRecord(data.message) ? data.message : {}
    const raw = Array.isArray(message.content) ? message.content : []
    const legacy = raw.length === 1 && isRecord(raw[0]) && Array.isArray(raw[0].content)
    const blocks = legacy ? raw[0].content : raw
    const callId = isRecord(message.source) && typeof message.source.callId === 'string'
      ? message.source.callId
      : typeof message.toolCallId === 'string' ? message.toolCallId
        : isRecord(raw[0]) && typeof raw[0].toolCallId === 'string' ? raw[0].toolCallId : undefined
    const text = extractToolResultText(blocks)
    const isError = message.isError === true || (isRecord(raw[0]) && raw[0].isError === true)
    const started = callId ? toolStarts.get(callId) : undefined
    const durationMs = started === undefined ? undefined : Math.round(performance.now() - started)
    if (callId) toolStarts.delete(callId)
    logStore.toolResult(turnId, { callId, ok: !isError, text, durationMs })
    bridge.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'chat.tool_result',
      callId,
      ok: !isError,
      text,
    })
    sendStatus('thinking')
  }
}

/** @param {Record<string, any>} data */
function extractReasoningText(data) {
  const message = isRecord(data.message) ? data.message : {}
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** @param {Record<string, any>} data */
function extractAssistantText(data) {
  const message = isRecord(data.message) ? data.message : {}
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** @param {unknown[]} blocks */
function extractToolResultText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
  }
  return parts.join('\n').slice(0, 4_000)
}

/** @param {Record<string, any>} message */
async function handleControl(message) {
  try {
    if (message.type === 'llm.models') {
      const baseUrl = normalizeBaseUrl(
        typeof message.baseUrl === 'string' ? message.baseUrl : llmConfig?.baseUrl ?? baseUrlOption,
      )
      logStore.record('extension', 'llm.models.request', { baseUrl }, { severity: 'info' })
      const models = await getModels(baseUrl, true)
      bridge.sendToUi({
        v: PROTOCOL_VERSION,
        type: 'llm.models.result',
        ok: true,
        baseUrl,
        models,
        count: models.length,
        fetchedAt: new Date().toISOString(),
      })
      return
    }
    if (message.type === 'llm.configure') {
      logStore.record('extension', 'llm.configure.request', {
        baseUrl: message.baseUrl,
        model: message.model,
        keyUpdated: typeof message.apiKey === 'string' && message.apiKey.trim().length > 0,
        remember: message.remember === true,
      }, { severity: 'info' })
      await configureLlm({
        baseUrl: typeof message.baseUrl === 'string' ? message.baseUrl : baseUrlOption,
        model: typeof message.model === 'string' ? message.model : '',
        apiKey: typeof message.apiKey === 'string' ? message.apiKey : '',
        remember: message.remember === true,
        reasoningEffort: typeof message.reasoningEffort === 'string' ? message.reasoningEffort : undefined,
      })
      return
    }
    if (message.type === 'log.stats') {
      bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'log.stats.result', stats: logStore.stats() })
      return
    }
    if (message.type === 'log.summary') {
      logStore.record('extension', 'log.summary.request', {}, { severity: 'info' })
      await logStore.flush()
      bridge.sendToUi({
        v: PROTOCOL_VERSION,
        type: 'log.summary.result',
        summary: logStore.summary(),
        stats: logStore.stats(),
      })
      return
    }
    if (message.type === 'log.export') {
      const includeScreenshots = message.includeScreenshots !== false
      const includeSession = message.includeSession !== false
      logStore.record('extension', 'log.export.request', { includeScreenshots, includeSession }, { severity: 'info' })
      const result = await logStore.exportBundle({ includeScreenshots, includeSession })
      bridge.sendToUi({
        v: PROTOCOL_VERSION,
        type: 'log.export.result',
        ...result,
        requestId: message.requestId,
      })
      return
    }
    bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'log.error', message: `unknown control request: ${String(message.type)}` })
  } catch (error) {
    const msg = errorMessage(error)
    logStore.error(`${String(message.type)} failed: ${msg}`, { code: 'CONTROL_REQUEST_FAILED' })
    if (message.type === 'llm.models') {
      bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'llm.models.result', ok: false, error: msg, baseUrl: message.baseUrl })
    } else if (message.type === 'llm.configure') {
      bridge.sendToUi({ v: PROTOCOL_VERSION, type: 'llm.configured', ok: false, error: msg, llm: llmInfo(), credentials: credentialsInfo(), dsh: dshStatus })
    } else {
      bridge.sendToUi({
        v: PROTOCOL_VERSION,
        type: 'log.error',
        message: msg,
        request: message.type,
        requestId: message.requestId,
      })
    }
  }
}

/** @type {Bridge} */
const bridge = new Bridge({
  host,
  port,
  token,
  log,
  onChat: handleChat,
  onNewChat: handleNewChat,
  onStop: handleStop,
  onLog: entry => logStore.recordBridge(entry),
  onControl: handleControl,
  onConnectionChange: () => {
    if (bridge.hasUi()) {
      sendCompanionHello(bridge.ui)
      sendStatus(dshStatus.state === 'ready' ? 'ready' : dshStatus.state === 'error' ? 'error' : 'starting')
    }
  },
})

await bridge.start()

process.stderr.write(`
CrazyAgent companion ${VERSION}
  bridge:  ws://${host}:${bridge.port}/bridge
  token:   ${token}
  provider: ${PROVIDER}
  model:   ${llmConfig?.model.id ?? 'not selected — choose one in the side panel'}
  base:    ${llmConfig?.baseUrl ?? baseUrlOption}
  effort:  ${llmConfig?.model?.reasoning ? effortPolicy() : 'n/a (model has no reasoning)'}
  api key: ${credentialsInfo().configured ? `configured (${apiKeySource})` : 'not configured — enter it in the side panel'}
  dsh:     ${noDsh ? 'disabled (--no-dsh)' : !llmConfig ? 'waiting for model selection' : !apiKey ? 'waiting for API key' : 'warming...'}
  logs:    ${logStore.path}
  run:     ${runId}

Load extension/ unpacked in chrome://extensions, open the side panel, and paste
the token into Settings. Enter your OpenRouter API key, refresh/select a model,
and Save. Keep the side panel open while the agent runs.
The side panel's Debug log button exports a detailed ZIP bundle.
`)

if (!noDsh) {
  if (!llmConfig && modelOverride) {
    try {
      const models = await getModels(baseUrlOption)
      const model = findModel(models, modelOverride)
      if (model) {
        llmConfig = buildLlmConfig(baseUrlOption, model)
        writeLlmConfig(llmConfigPath, llmConfig)
        writeLlmPatch(llmPatchPath, llmConfig)
      } else {
        log(`model "${modelOverride}" is not in the image-capable OpenRouter list`)
      }
    } catch (error) {
      log(`could not resolve initial model: ${errorMessage(error)}`)
    }
  }
  if (!llmConfig) {
    dshStatus = { state: 'error', message: 'No OpenRouter model selected. Open Settings and choose one.' }
    log('dsh: no model selected; waiting for side-panel configuration')
  } else if (!apiKey) {
    dshStatus = { state: 'error', message: 'No OpenRouter API key. Open Settings and enter one.' }
    log('dsh: no OpenRouter API key; waiting for side-panel configuration')
  } else {
    try {
      await warmRunner(undefined)
      log('dsh: warm start complete')
    } catch (error) {
      dshStatus = { state: 'error', message: errorMessage(error) }
      logStore.error(`dsh warm start failed: ${errorMessage(error)}`, { code: 'DSH_START_FAILED' })
      log(`dsh: warm start failed: ${errorMessage(error)}`)
      log('dsh: check the OpenRouter model, key, and generated patch')
    }
  }
  if (bridge.hasUi()) {
    sendCompanionHello(bridge.ui)
    sendStatus(dshStatus.state === 'ready' ? 'ready' : dshStatus.state === 'error' ? 'error' : 'starting')
  }
} else {
  logStore.record('dsh', 'disabled', { reason: '--no-dsh' }, { severity: 'info' })
}

/** @param {string} signal */
async function shutdown(signal) {
  log(`shutting down (${signal})`)
  logStore.record('companion', 'shutdown', { signal }, { severity: 'info' })
  await bridge.stop().catch(() => {})
  await runner?.close().catch(() => {})
  await logStore.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('uncaughtException', error => {
  const message = errorMessage(error)
  log(`uncaught: ${message}`)
  logStore?.error(`uncaught: ${message}`, { code: 'UNCAUGHT' })
})
process.on('unhandledRejection', error => {
  const message = errorMessage(error)
  log(`unhandled: ${message}`)
  logStore?.error(`unhandled: ${message}`, { code: 'UNHANDLED_REJECTION' })
})