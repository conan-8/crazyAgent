#!/usr/bin/env node
/**
 * crazyAgent companion: the local bridge between the Chrome side panel and a
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
import { SessionController, uiRejectionFrame } from './session-controller.mjs'
import { RemoteHub } from './remote-hub.mjs'
import { DEFAULT_REMOTE_PORT, RemoteServer } from './remote-server.mjs'
import { createRemoteTokenSource, resolveRemoteToken } from './remote-token.mjs'
import { PushRegistry, PushService, createFcmProvider, pushTypeForTurn } from './remote-push.mjs'
import { PROTOCOL_VERSION, errorMessage } from './protocol.mjs'
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
const VERSION = '2.1.0-beta'
const PROVIDER = 'openrouter'

const BOOLEAN_FLAGS = new Set(['no-dsh', 'no-auto-capture', 'new-token', 'help', 'remote', 'pair-remote', 'new-remote-token'])

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
    if (BOOLEAN_FLAGS.has(raw)) {
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
  process.stdout.write(`crazyAgent companion ${VERSION}

  --port <n>                    bridge port (default 17871)
  --token <token>               fixed pairing token (default: .dsh-home/browser-agent/token)
  --new-token                   rotate the pairing token
  --base-url <url>              OpenRouter-compatible base URL
                                (default ${DEFAULT_BASE_URL})
  --model <id>                  optional initial model id; otherwise choose it in
                                the side panel after entering your API key
  --reasoning-effort <level>    medium (default), auto, off, low, or high
  --max-tokens <n>              output cap (default: selected model's maximum)
  --dsh-home <path>             harness home (default .dsh-home)
  --patch <path>                base profile overlay (default config/browser.patch.yml)
  --credentials <path>         fallback DSH credential file
  --no-dsh                      bridge-only test mode
  --no-auto-capture             do not attach a fresh DOM/text or screenshot view
  --remote                      also serve the phone remote API on 127.0.0.1
                                (opt-in; publish only via tailnet-only Tailscale Serve)
  --remote-port <n>             remote API port (default ${DEFAULT_REMOTE_PORT})
  --remote-public-host <host>   accepted Tailscale Serve authority, e.g.
                                host.tailnet.ts.net
  --fcm-credentials <path>      Firebase service-account key for phone push
                                (default .dsh-home/browser-agent/fcm-service-account.json
                                when present; without one, push is off)
  --pair-remote                 print the remote token and pairing details, then exit
  --new-remote-token            rotate the remote token (revokes paired phones; a
                                running companion picks it up), then exit
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
    : process.env.CRAZYAGENT_REASONING_EFFORT ?? 'medium',
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

const remoteEnabled = cli.remote === true
const remotePort = Number(cli['remote-port'] ?? process.env.CRAZYAGENT_REMOTE_PORT ?? DEFAULT_REMOTE_PORT)
const remotePublicHost = typeof cli['remote-public-host'] === 'string'
  ? cli['remote-public-host']
  : process.env.CRAZYAGENT_REMOTE_PUBLIC_HOST ?? undefined
const remoteTokenFile = join(browserDir, 'remote-token')
const defaultFcmCredentials = join(browserDir, 'fcm-service-account.json')
const fcmCredentialsFile = typeof cli['fcm-credentials'] === 'string'
  ? resolve(cli['fcm-credentials'])
  : process.env.CRAZYAGENT_FCM_CREDENTIALS?.trim()
    ? resolve(process.env.CRAZYAGENT_FCM_CREDENTIALS.trim())
    : existsSync(defaultFcmCredentials) ? defaultFcmCredentials : undefined

if (!Number.isInteger(remotePort) || remotePort < 0 || remotePort > 65535 || (remotePort === port && port !== 0)) {
  log(`invalid remote port ${String(cli['remote-port'])}`)
  process.exit(2)
}

// One-shot remote credential operations; they never start the companion.
if (cli['pair-remote'] === true || cli['new-remote-token'] === true) {
  const rotate = cli['new-remote-token'] === true
  const { token: remoteToken, created, rotated } = resolveRemoteToken(remoteTokenFile, { rotate })
  if (rotated) process.stderr.write('[crazyagent] remote token rotated; previously paired phones are revoked (a running companion picks this up within a few seconds)\n')
  else if (created) process.stderr.write('[crazyagent] remote token created\n')
  if (cli['pair-remote'] === true) {
    const base = remotePublicHost ? `https://${remotePublicHost}/remote/v1` : `https://<your-host>.<tailnet>.ts.net/remote/v1`
    process.stdout.write(`crazyAgent remote pairing

  server URL:   ${base}
  remote token: ${remoteToken}

Paste both into the Android app. The token is a bearer credential for this
browser agent: do not share, screenshot, or commit it. Rotate it with
--new-remote-token. Start the companion with --remote and publish only
127.0.0.1:${remotePort} through tailnet-only Tailscale Serve (never Funnel).
`)
  } else {
    process.stderr.write('[crazyagent] run --pair-remote to show the new token\n')
  }
  process.exit(0)
}

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
/** @type {RemoteHub | undefined} */
let remoteHub
/** @type {RemoteServer | undefined} */
let remoteServer
/** @type {PushService | undefined} */
let pushService

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
  publish({ v: PROTOCOL_VERSION, type: 'chat.status', status, ...extra })
}

/**
 * Chat broadcaster for allowlisted lifecycle frames: the side panel receives
 * exactly the frame it always did, and the remote hub a normalized copy.
 * Browser commands never pass through here (they stay on bridge.sendToUi).
 * @param {Record<string, any>} frame
 */
function publish(frame) {
  bridge.sendToUi(frame)
  remoteHub?.ingest(frame)
}

/** @param {{state: 'starting' | 'ready' | 'error' | 'disabled', message?: string}} next */
function setDshStatus(next) {
  dshStatus = next
  remoteHub?.updateHealth()
}

function remoteHealth() {
  return {
    uiConnected: bridge.hasUi(),
    executorHost: bridge.executorHost(),
    toolsConnected: bridge.hasTools(),
    dsh: dshStatus.state,
    dshMessage: dshStatus.message ?? null,
    provider: PROVIDER,
    model: llmConfig?.model.id ?? null,
    contextWindow: llmConfig?.model.contextWindow ?? null,
    autoCapture,
    pushConfigured: pushService?.configured === true,
  }
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
  setDshStatus({ state: 'starting' })
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
    setDshStatus({ state: 'ready' })
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
  if (controller.running) throw new Error('A turn is running. Wait for it to finish before changing the model or key.')
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

  setDshStatus({ state: 'starting' })
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
    setDshStatus({ state: 'error', message })
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

/**
 * Side-panel transport for chat.send. Rejections reply to the panel only; the
 * accepted turn's lifecycle is published to the panel and remote clients.
 * @param {string} text @param {import('ws').WebSocket} _ui @param {Record<string, unknown>} [message]
 */
async function handleChat(text, _ui, message) {
  const result = controller.submit({
    text,
    images: message?.images,
    autoCapture: message?.autoCapture,
    planMode: message?.planMode === true,
    origin: 'ui',
  })
  if (result.ok) {
    await result.done
    return
  }
  if (result.code === 'EMPTY_PROMPT') return
  // The bridge reports a thrown error to the panel as chat.error.
  if (result.code === 'INVALID_ATTACHMENT') throw new Error(result.message)
  bridge.sendToUi(uiRejectionFrame(result))
}

/**
 * Side-panel transport for chat.stop. The shared controller owns the single
 * stop path (runtime interrupt + resume).
 * @param {import('ws').WebSocket} _ui
 * @param {Record<string, unknown>} [_message]
 */
async function handleStop(_ui, _message) {
  const result = controller.stop()
  if (result.state === 'idle') {
    bridge.sendToUi({
      v: PROTOCOL_VERSION,
      type: 'chat.stopped',
      reason: 'idle',
      message: 'No turn is running.',
    })
    return
  }
  await result.done
}

/** @param {import('ws').WebSocket} _ui */
async function handleNewChat(_ui) {
  const result = await controller.newChat()
  if (!result.ok) bridge.sendToUi(uiRejectionFrame(result))
}

/** @param {string} sessionId @param {import('ws').WebSocket} _ui */
async function handleResumeChat(sessionId, _ui) {
  const result = await controller.resumeChat(sessionId)
  if (!result.ok) bridge.sendToUi(uiRejectionFrame(result))
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
  onResumeChat: handleResumeChat,
  onStop: handleStop,
  onLog: entry => logStore.recordBridge(entry),
  onControl: handleControl,
  onActivity: frame => {
    controller.noteActivity(frame)
    remoteHub?.ingest(frame)
  },
  onImage: ({ image, turnId, callId, source }) => {
    remoteHub?.addScreenshot({ data: image.data, mimeType: image.mimeType, width: image.width, height: image.height, turnId, callId, source })
  },
  onConnectionChange: () => {
    remoteHub?.updateHealth()
    if (bridge.hasUi()) {
      sendCompanionHello(bridge.ui)
      sendStatus(dshStatus.state === 'ready' ? 'ready' : dshStatus.state === 'error' ? 'error' : 'starting')
    }
  },
})

const controller = new SessionController({
  bridge,
  getRunner: () => runner,
  isDisabled: () => noDsh,
  logStore,
  log,
  autoCapture,
  provider: PROVIDER,
  getModelId: () => llmConfig?.model.id,
  publish,
})

if (remoteEnabled) {
  remoteHub = new RemoteHub({ serverVersion: VERSION, getHealth: remoteHealth, historyFile: join(browserDir, 'remote-history.json'), log })
  controller.addObserver({
    turnStarted: info => remoteHub?.turnStarted(info),
    turnEnded: info => remoteHub?.turnEnded(info),
  })
  let pushProvider
  try {
    pushProvider = await createFcmProvider({ credentialsFile: fcmCredentialsFile })
  } catch (error) {
    log(`push: disabled, the FCM credentials could not be used (${errorMessage(error)})`)
  }
  pushService = new PushService({
    registry: new PushRegistry({ file: join(browserDir, 'push-devices.json'), log }),
    provider: pushProvider,
    log,
    audit: (event, data) => {
      try {
        logStore.record('remote', event, data, { severity: 'info', noSignal: true })
      } catch {
        // Logging must never break a turn.
      }
    },
  })
  // Registered after the hub's observer: the state a notification points at
  // is already committed when the push goes out.
  controller.addObserver({
    turnEnded: info => {
      const type = pushTypeForTurn(info)
      if (type === null || remoteHub === undefined) return
      void pushService?.notify({ type, turnId: info.turnId, instanceId: remoteHub.instanceId, sequence: remoteHub.seq })
    },
  })
}

await bridge.start()

if (remoteHub !== undefined) {
  // Ensure a credential exists without printing it.
  resolveRemoteToken(remoteTokenFile)
  remoteServer = new RemoteServer({
    host,
    port: remotePort,
    getToken: createRemoteTokenSource(remoteTokenFile),
    publicHost: remotePublicHost,
    hub: remoteHub,
    controller,
    push: pushService,
    log,
    audit: (event, data) => {
      try {
        logStore.record('remote', event, data, { severity: event === 'request' ? 'debug' : 'info', noSignal: true })
      } catch {
        // Logging must never break the remote API.
      }
    },
  })
  try {
    await remoteServer.start()
    remoteHub.updateHealth()
  } catch (error) {
    log(`remote: failed to listen on ${host}:${remotePort}: ${errorMessage(error)}`)
    remoteServer = undefined
  }
}

process.stderr.write(`
crazyAgent companion ${VERSION}
  bridge:  ws://${host}:${bridge.port}/bridge
  token:   ${token}
  provider: ${PROVIDER}
  model:   ${llmConfig?.model.id ?? 'not selected — choose one in the side panel'}
  base:    ${llmConfig?.baseUrl ?? baseUrlOption}
  effort:  ${llmConfig?.model?.reasoning ? effortPolicy() : 'n/a (model has no reasoning)'}
  api key: ${credentialsInfo().configured ? `configured (${apiKeySource})` : 'not configured — enter it in the side panel'}
  dsh:     ${noDsh ? 'disabled (--no-dsh)' : !llmConfig ? 'waiting for model selection' : !apiKey ? 'waiting for API key' : 'warming...'}
  push:    ${pushService?.configured ? `FCM (${pushService.registry.size} device${pushService.registry.size === 1 ? '' : 's'})` : remoteEnabled ? 'off (no FCM service-account key)' : 'off'}
  remote:  ${remoteServer ? `${remoteServer.address} (instance ${remoteHub?.instanceId}; token via --pair-remote)` : remoteEnabled ? 'failed to start' : 'off (enable with --remote)'}
  logs:    ${logStore.path}
  run:     ${runId}

Load extension/ unpacked in chrome://extensions, open the side panel, and paste
the token into Settings. Enter your OpenRouter API key, refresh/select a model,
and Save. After that the panel can be closed: the extension keeps running
browser actions in the background while Edge is open.
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
    setDshStatus({ state: 'error', message: 'No OpenRouter model selected. Open Settings and choose one.' })
    log('dsh: no model selected; waiting for side-panel configuration')
  } else if (!apiKey) {
    setDshStatus({ state: 'error', message: 'No OpenRouter API key. Open Settings and enter one.' })
    log('dsh: no OpenRouter API key; waiting for side-panel configuration')
  } else {
    try {
      await warmRunner(undefined)
      log('dsh: warm start complete')
    } catch (error) {
      setDshStatus({ state: 'error', message: errorMessage(error) })
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
  await remoteServer?.stop().catch(() => {})
  remoteHub?.close()
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