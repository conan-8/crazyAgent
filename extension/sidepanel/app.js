/**
 * CrazyAgent side panel: chat UI, bridge client, and browser-command executor.
 *
 * The panel owns the WebSocket to the local companion. It renders model text
 * and tool activity, executes browser commands from the DSH provider, and
 * attaches a fresh screenshot to each user turn (via the companion's prompt).
 */

import { DEFAULT_SETTINGS, execute, testCapture, imageDataUrl } from './browser.js'
import { ClientLogger } from './logger.js'
import { PROTOCOL_VERSION, truncate, errorMessage, shortDuration, formatBytes } from './protocol.js'

const SETTINGS_KEY = 'crazyagent.settings'
const RECONNECT_MS = 2_500
const DEFAULT_MODEL_BASE_URL = 'https://openrouter.ai/api/v1'
const RECOMMENDED_MODEL_ID = 'deepseek/deepseek-v4.1-flash-1017'

/** @type {import('./protocol.js').Settings} */
let settings = { ...DEFAULT_SETTINGS }
/** @type {WebSocket | null} */
let ws = null
let reconnectTimer = null
let manualDisconnect = false
let authFailed = false
let connected = false
let busy = false
let dshState = 'unknown'
let lastAssistantText = ''
let sessionId = ''
let localCardSeq = 0
let bannerAction = () => {}
let statusKind = 'offline'
let statusLabel = 'Connecting…'
let toastTimer = null
let tabRefreshTimer = null
let lastTabSignature = ''
/** @type {Record<string, any> | null} */
let currentLogStats = null
let currentLogPath = ''
let copySummaryRequested = false
/** @type {{provider: string, baseUrl: string, model: Record<string, any> | null, reasoningEffort?: string | null}} */
let llmState = { provider: 'openrouter', baseUrl: DEFAULT_MODEL_BASE_URL, model: null }
/** @type {{configured: boolean, source: string}} */
let credentialState = { configured: false, source: 'none' }
/** @type {{baseUrl: string, models: Array<Record<string, any>>, loading: boolean, error: string}} */
let modelsState = { baseUrl: '', models: [], loading: false, error: '' }
/** @type {Record<string, any> | null} */
let pendingLlmConfig = null
let setupPrompted = false
let modelsTimer = null
let activityExpanded = true
let activityTurnStart = 0
/** @type {{entry: HTMLElement, textEl: HTMLElement, kind: string, id?: string} | null} */
let lastStreamEntry = null
let lastReasoningStreamText = ''
let sawReasoningStream = false
let sawTextStream = false

/** @type {Map<string, any>} */
const cards = new Map()

const $ = id => document.getElementById(id)

const els = {
  chat: $('chat'),
  empty: $('empty'),
  input: $('input'),
  send: $('send'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  activeTab: $('active-tab'),
  activity: $('activity'),
  activityDot: $('activity-dot'),
  activityPhase: $('activity-phase'),
  activityLatest: $('activity-latest'),
  activityToggle: $('activity-toggle'),
  activityLog: $('activity-log'),
  activityEmpty: $('activity-empty'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerAction: $('banner-action'),
  sessionInfo: $('session-info'),
  timing: $('timing'),
  pause: $('pause'),
  newChat: $('new-chat'),
  settings: $('settings'),
  settingsModal: $('settings-modal'),
  settingsClose: $('settings-close'),
  settingUrl: $('setting-url'),
  settingToken: $('setting-token'),
  settingApiKey: $('setting-apikey'),
  settingBaseUrl: $('setting-base-url'),
  settingModel: $('setting-model'),
  modelOptions: $('model-options'),
  refreshModels: $('refresh-models'),
  keyStatus: $('key-status'),
  modelStatus: $('model-status'),
  settingRememberKey: $('setting-remember-key'),
  settingEffort: $('setting-effort'),
  effortStatus: $('effort-status'),
  settingWidth: $('setting-width'),
  settingQuality: $('setting-quality'),
  settingAutoCapture: $('setting-autocapture'),
  settingsSave: $('settings-save'),
  testCapture: $('test-capture'),
  imageModal: $('image-modal'),
  imageModalImg: $('image-modal-img'),
  imageClose: $('image-close'),
  toast: $('toast'),
  debugLog: $('debug-log'),
  logModal: $('log-modal'),
  logClose: $('log-close'),
  logStats: $('log-stats'),
  logSignals: $('log-signals'),
  logIncludeScreenshots: $('log-include-screenshots'),
  logIncludeSession: $('log-include-session'),
  logCopySummary: $('log-copy-summary'),
  logCopyPath: $('log-copy-path'),
  logExport: $('log-export'),
}

const logger = new ClientLogger({
  send: frame => sendLogFrame(frame),
  context: clientContext(),
})

window.addEventListener('error', event => {
  logger.log('ui.error', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  }, 'error')
})
window.addEventListener('unhandledrejection', event => {
  logger.log('ui.unhandled_rejection', { reason: String(event.reason).slice(0, 2_000) }, 'error')
})
const originalConsoleError = console.error.bind(console)
console.error = (...args) => {
  logger.log('ui.console.error', {
    args: args.map(value => typeof value === 'string' ? truncate(value, 2_000) : String(value).slice(0, 2_000)),
  }, 'error')
  originalConsoleError(...args)
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY)
    const value = stored?.[SETTINGS_KEY]
    if (value && typeof value === 'object') {
      settings = { ...DEFAULT_SETTINGS, ...value, paused: false }
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
  } catch (error) {
    toast(`Could not save settings: ${errorMessage(error)}`)
  }
}

function populateSettings() {
  els.settingUrl.value = settings.bridgeUrl
  els.settingToken.value = settings.token
  els.settingWidth.value = String(settings.captureWidth)
  els.settingQuality.value = String(settings.quality)
  els.settingAutoCapture.checked = settings.autoCapture !== false
}

const EFFORT_LABELS = {
  auto: 'Auto (off for navigation, low otherwise)',
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

function effortLabel(value) {
  return EFFORT_LABELS[value] ?? EFFORT_LABELS.auto
}

function renderEffortStatus() {
  if (!els.effortStatus) return
  const policy = llmState.reasoningEffort ?? 'auto'
  if (!llmState.model) {
    els.effortStatus.textContent = 'Select a model to configure reasoning.'
    return
  }
  if (!llmState.model.reasoning) {
    els.effortStatus.textContent = 'This model has no reasoning support; effort is not sent.'
    return
  }
  els.effortStatus.textContent = policy === 'auto'
    ? 'Auto: navigation-only prompts use off; reading, describing, and synthesis use low.'
    : `Every turn requests ${effortLabel(policy).toLowerCase()}.`
}

function modelLabel(model) {
  if (!model) return ''
  const context = model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k ctx` : ''
  const pricing = model.pricing?.prompt === 0 && model.pricing?.completion === 0
    ? 'free'
    : Number.isFinite(model.pricing?.prompt)
      ? `$${(Number(model.pricing.prompt) * 1_000_000).toFixed(2)}/M in`
      : ''
  return [model.name || model.id, model.id, context, pricing, model.reasoning ? 'reasoning' : '']
    .filter(Boolean)
    .join(' · ')
}

function selectedModelInfo() {
  const id = els.settingModel.value.trim()
  return modelsState.models.find(model => model.id === id)
    ?? (llmState.model?.id === id ? llmState.model : null)
}

function credentialSourceLabel(source) {
  switch (source) {
    case 'environment': return 'CRAZYAGENT_API_KEY environment variable'
    case 'stored': return 'saved on this machine'
    case 'legacy-environment': return 'OPENROUTER_API_KEY environment variable'
    case 'credentials-file': return 'DSH credential file'
    case 'manual': return 'entered this session'
    default: return 'not configured'
  }
}

function renderProviderStatus() {
  if (!els.keyStatus) return
  if (credentialState.configured) {
    els.keyStatus.textContent = `API key configured (${credentialSourceLabel(credentialState.source)}). Enter a new key to replace it.`
    els.keyStatus.className = 'hint configured'
    els.settingApiKey.placeholder = 'Configured — enter a new key to replace'
  } else {
    els.keyStatus.textContent = 'No OpenRouter API key configured. Paste one above.'
    els.keyStatus.className = 'hint'
    els.settingApiKey.placeholder = 'sk-or-v1-…'
  }

  renderEffortStatus()
  const selected = selectedModelInfo()
  let text
  let kind = 'hint'
  if (modelsState.loading) {
    text = 'Loading image-capable OpenRouter models…'
  } else if (modelsState.error) {
    text = `Model list: ${modelsState.error}`
    kind = 'hint error'
  } else if (selected) {
    text = modelLabel(selected)
      + (selected.reasoning ? ` · effort ${effortLabel(llmState.reasoningEffort ?? 'auto')}` : ' · no reasoning')
      + (modelsState.models.length > 0 ? ` · ${modelsState.models.length} image-capable models loaded` : '')
  } else if (modelsState.models.length > 0) {
    text = `${modelsState.models.length} image-capable models loaded. Choose one above.`
  } else if (connected) {
    text = 'OpenRouter models have not been loaded. Click Refresh.'
  } else {
    text = 'Connect to the companion, then click Refresh to load models.'
  }
  els.modelStatus.textContent = text
  els.modelStatus.className = kind
}

function fillModelOptions() {
  els.modelOptions.replaceChildren()
  for (const model of modelsState.models) {
    const option = document.createElement('option')
    option.value = model.id
    option.label = modelLabel(model)
    els.modelOptions.appendChild(option)
  }
  if (els.settingModel.value.trim().length === 0) {
    const preferred = [RECOMMENDED_MODEL_ID, settings.modelId, llmState.model?.id]
      .find(id => id && modelsState.models.some(model => model.id === id))
    if (preferred) els.settingModel.value = preferred
    else if (modelsState.models[0]) els.settingModel.value = modelsState.models[0].id
  }
  renderProviderStatus()
}

async function refreshModels() {
  if (!connected) {
    modelsState = { ...modelsState, loading: false, error: 'Connect to the companion first' }
    renderProviderStatus()
    return
  }
  if (modelsState.loading) return
  const baseUrl = (els.settingBaseUrl.value.trim() || DEFAULT_MODEL_BASE_URL)
  if (!/^https?:\/\//u.test(baseUrl)) {
    modelsState = { ...modelsState, loading: false, error: 'Base URL must start with http:// or https://' }
    renderProviderStatus()
    return
  }
  modelsState = { ...modelsState, baseUrl, loading: true, error: '' }
  els.refreshModels.disabled = true
  renderProviderStatus()
  clearTimeout(modelsTimer)
  modelsTimer = setTimeout(() => {
    if (!modelsState.loading) return
    modelsState = { ...modelsState, loading: false, error: 'Timed out waiting for the companion' }
    els.refreshModels.disabled = false
    renderProviderStatus()
  }, 30_000)
  const sent = sendFrame({ v: PROTOCOL_VERSION, type: 'llm.models', baseUrl })
  if (!sent) {
    clearTimeout(modelsTimer)
    els.refreshModels.disabled = false
    modelsState = { ...modelsState, loading: false, error: 'Not connected to the companion' }
    renderProviderStatus()
    return
  }
  logger.log('llm.models.request', { baseUrl }, 'info')
}

/** @param {Record<string, any>} frame */
function handleModelsResult(frame) {
  clearTimeout(modelsTimer)
  els.refreshModels.disabled = false
  if (frame.ok !== true) {
    modelsState = { ...modelsState, loading: false, error: String(frame.error ?? 'model list request failed') }
    renderProviderStatus()
    logger.log('llm.models.result', { ok: false, error: frame.error }, 'error')
    return
  }
  modelsState = {
    baseUrl: typeof frame.baseUrl === 'string' ? frame.baseUrl : els.settingBaseUrl.value.trim(),
    models: Array.isArray(frame.models) ? frame.models : [],
    loading: false,
    error: '',
  }
  fillModelOptions()
  renderProviderStatus()
  logger.log('llm.models.result', { ok: true, count: modelsState.models.length, baseUrl: modelsState.baseUrl }, 'info')
}

/** @param {Record<string, any>} frame */
function handleLlmConfigured(frame) {
  pendingLlmConfig = null
  setBusy(false)
  if (frame.llm && typeof frame.llm === 'object') llmState = { ...llmState, ...frame.llm }
  if (frame.credentials && typeof frame.credentials === 'object') credentialState = { ...credentialState, ...frame.credentials }
  if (llmState.baseUrl) {
    settings.modelBaseUrl = llmState.baseUrl
    els.settingBaseUrl.value = llmState.baseUrl
  }
  if (llmState.model?.id) {
    settings.modelId = llmState.model.id
    els.settingModel.value = llmState.model.id
    els.sessionInfo.dataset.model = llmState.model.id
  }
  if (llmState.reasoningEffort) {
    settings.reasoningEffort = llmState.reasoningEffort
    els.settingEffort.value = llmState.reasoningEffort
  }
  renderEffortStatus()
  if (frame.dsh?.state) dshState = frame.dsh.state
  renderProviderStatus()
  if (frame.ok === true) {
    hideBanner()
    void saveSettings()
    const name = llmState.model?.name ?? llmState.model?.id ?? 'model'
    pushActivity('model', 'ready', `OpenRouter ready: ${name}${llmState.model?.reasoning ? ` · reasoning ${effortLabel(llmState.reasoningEffort ?? 'auto')}` : ' · no reasoning'}`)
    setActivityPhase('Ready', 'online')
    toast(`OpenRouter ready: ${name}`)
    logger.log('llm.configured', {
      ok: true,
      model: llmState.model?.id,
      baseUrl: llmState.baseUrl,
      source: credentialState.source,
      resumed: frame.resumed === true,
    }, 'info')
    refreshStatus()
    if (dshState === 'error') showBanner(`DSH error: ${frame.dsh?.message ?? 'unknown'}`, 'Open settings', openSettings)
  } else {
    const message = String(frame.error ?? 'configuration failed')
    pushActivity('error', 'error', `OpenRouter setup failed: ${message}`)
    setActivityPhase('Model setup failed', 'error')
    toast(`OpenRouter setup failed: ${message}`)
    showBanner(`OpenRouter setup failed: ${message}`, 'Open settings', openSettings)
    logger.log('llm.configured', { ok: false, error: message }, 'error')
    setStatus('error', 'Model setup failed')
  }
}

/** @param {{baseUrl: string, model: string, remember: boolean, apiKey?: string} | null} update */
function sendLlmConfigure(update) {
  if (!update) {
    refreshStatus()
    return
  }
  if (!connected) {
    pendingLlmConfig = update
    return
  }
  setBusy(true)
  setStatus('busy', 'Configuring OpenRouter…')
  pendingLlmConfig = update
  const frame = {
    v: PROTOCOL_VERSION,
    type: 'llm.configure',
    baseUrl: update.baseUrl,
    model: update.model,
    remember: update.remember,
    ...update.reasoningEffort === undefined ? {} : { reasoningEffort: update.reasoningEffort },
  }
  if (update.apiKey) frame.apiKey = update.apiKey
  const sent = sendFrame(frame)
  if (!sent) {
    setBusy(false)
    pendingLlmConfig = update
    return
  }
  logger.log('llm.configure.request', {
    baseUrl: update.baseUrl,
    model: update.model,
    keyUpdated: Boolean(update.apiKey),
    keyLength: update.apiKey?.length ?? 0,
    remember: update.remember,
  }, 'info')
  toast('Applying OpenRouter settings…')
}

function syncProviderInputs() {
  if (llmState.baseUrl) els.settingBaseUrl.value = llmState.baseUrl
  if (llmState.model?.id) els.settingModel.value = llmState.model.id
  renderProviderStatus()
}

function openSettings() {
  populateSettings()
  els.settingApiKey.value = ''
  els.settingBaseUrl.value = llmState.baseUrl || settings.modelBaseUrl || DEFAULT_MODEL_BASE_URL
  els.settingModel.value = llmState.model?.id || settings.modelId || ''
  els.settingRememberKey.checked = true
  els.settingEffort.value = llmState.reasoningEffort ?? 'auto'
  renderProviderStatus()
  els.settingsModal.classList.remove('hidden')
  setTimeout(() => els.settingToken.focus(), 10)
  if (connected && (modelsState.models.length === 0 || modelsState.baseUrl !== els.settingBaseUrl.value.trim())) {
    void refreshModels()
  } else if (modelsState.models.length > 0) {
    fillModelOptions()
  }
}

function closeSettings() {
  els.settingsModal.classList.add('hidden')
}

/* ------------------------------------------------------------------ */
/* status / banner / toast                                             */
/* ------------------------------------------------------------------ */

function setStatus(kind, label) {
  statusKind = kind
  statusLabel = label
  els.statusDot.className = `dot ${kind}`
  els.statusText.textContent = label
}

function refreshStatus() {
  if (settings.paused) {
    setStatus('paused', 'Paused')
    return
  }
  if (!connected) {
    setStatus(authFailed ? 'error' : 'offline', authFailed ? 'Pairing failed' : 'Companion offline')
    return
  }
  if (dshState === 'error') {
    setStatus('error', 'DSH error')
    return
  }
  if (dshState === 'disabled') {
    setStatus('error', 'DSH disabled')
    return
  }
  if (busy) {
    setStatus('busy', statusLabel === 'Connected' ? 'Working…' : statusLabel)
    return
  }
  setStatus('online', dshState === 'starting' ? 'Starting DSH…' : 'Connected')
}

function showBanner(text, actionLabel = 'Reconnect', action = () => connect()) {
  els.bannerText.textContent = text
  els.bannerAction.textContent = actionLabel
  bannerAction = action
  els.banner.classList.remove('hidden')
}

function hideBanner() {
  els.banner.classList.add('hidden')
}

function toast(text) {
  els.toast.textContent = text
  els.toast.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2_600)
}

function setBusy(value) {
  busy = value
  els.send.disabled = value
  els.send.textContent = value ? '·' : '↑'
  refreshStatus()
}

function setActivity(active) {
  try {
    chrome.runtime.sendMessage({ type: 'activity', active }).catch(() => {})
  } catch {
    // The badge is a nicety.
  }
}

/* ------------------------------------------------------------------ */
/* websocket                                                           */
/* ------------------------------------------------------------------ */

function connect() {
  manualDisconnect = false
  authFailed = false
  logger.log('bridge.connect.start', { bridgeUrl: settings.bridgeUrl, hasToken: settings.token.length > 0 }, 'info')
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (ws) {
    try {
      ws.onclose = null
      ws.close()
    } catch {
      // ignore
    }
    ws = null
  }
  connected = false
  dshState = 'unknown'
  refreshStatus()

  if (!settings.token) {
    showBanner('Pair first: start the companion with npm run dev, then paste its token here.', 'Open settings', openSettings)
    setStatus('offline', 'Not paired')
    return
  }

  let socket
  try {
    socket = new WebSocket(settings.bridgeUrl)
  } catch (error) {
    showBanner(`Invalid bridge URL: ${errorMessage(error)}`, 'Open settings', openSettings)
    return
  }
  ws = socket
  setStatus('busy', 'Connecting…')

  socket.onopen = () => {
    if (ws !== socket) return
    logger.log('bridge.open', { bridgeUrl: settings.bridgeUrl }, 'info')
    sendFrame({
      v: PROTOCOL_VERSION,
      type: 'hello',
      role: 'ui',
      token: settings.token,
      version: PROTOCOL_VERSION,
    })
  }

  socket.onmessage = event => {
    if (ws !== socket) return
    let frame
    try {
      frame = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (frame && typeof frame === 'object') handleFrame(frame)
  }

  socket.onerror = () => {
    logger.log('bridge.error', {}, 'error')
    // The close handler owns user-facing state.
  }

  socket.onclose = event => {
    if (ws !== socket) return
    ws = null
    connected = false
    setBusy(false)
    setActivity(false)
    setActivityPhase('Companion offline', 'offline')
    finalizeStreamActivity()
    els.refreshModels.disabled = false
    if (modelsState.loading) modelsState = { ...modelsState, loading: false, error: 'Companion disconnected' }
    logger.log('bridge.closed', { code: event.code, reason: event.reason, wasAuthFailure: event.code === 4001 }, event.code === 4001 ? 'warn' : 'info')
    logger.setReady(false)
    if (event.code === 4001) {
      authFailed = true
      showBanner('Invalid pairing token. Copy the token printed by npm run dev into Settings.', 'Open settings', openSettings)
      setStatus('error', 'Pairing failed')
      return
    }
    if (manualDisconnect) return
    showBanner('Companion offline. Start it with npm run dev, then reconnect.', 'Reconnect', () => connect())
    refreshStatus()
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (authFailed || manualDisconnect) return
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (ws === null && !authFailed) connect()
  }, RECONNECT_MS)
}

function sendFrame(frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('Not connected to the companion')
    return false
  }
  try {
    ws.send(JSON.stringify(frame))
    return true
  } catch (error) {
    toast(`Send failed: ${errorMessage(error)}`)
    return false
  }
}

/** Bridge-only log transport; never toasts and never throws at callers. */
function sendLogFrame(frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  try {
    ws.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

/** Environment and safe settings sent with the debug context. No token value. */
function clientContext() {
  let extensionVersion = '0.1.0'
  try {
    extensionVersion = chrome.runtime.getManifest().version
  } catch {
    // Development fallback.
  }
  return {
    extensionVersion,
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio },
    settings: {
      bridgeUrl: settings.bridgeUrl,
      captureWidth: settings.captureWidth,
      quality: settings.quality,
      autoCapture: settings.autoCapture,
      paused: settings.paused,
      tokenLength: settings.token.length,
      provider: llmState.provider,
      modelBaseUrl: llmState.baseUrl,
      modelId: llmState.model?.id ?? settings.modelId,
      reasoningEffort: llmState.reasoningEffort ?? settings.reasoningEffort,
      credentialSource: credentialState.source,
    },
  }
}

/* ------------------------------------------------------------------ */
/* live activity feed                                                  */
/* ------------------------------------------------------------------ */

function activityTimeLabel() {
  if (!activityTurnStart) return ''
  return `+${((Date.now() - activityTurnStart) / 1000).toFixed(1)}s`
}

function activityPreview(text, max = 190) {
  return truncate(String(text ?? '').replace(/\s+/gu, ' ').trim(), max)
}

function setActivityPhase(phase, state = 'online', latest) {
  els.activityPhase.textContent = phase
  els.activityDot.className = `dot ${state}`
  if (latest !== undefined) {
    els.activityLatest.textContent = activityPreview(latest)
    els.activityLatest.title = String(latest ?? '')
  }
}

function scrollActivity() {
  if (!activityExpanded) return
  requestAnimationFrame(() => {
    els.activityLog.scrollTop = els.activityLog.scrollHeight
  })
}

function pushActivity(kind, label, text, options = {}) {
  els.activityEmpty?.classList.add('hidden')
  const entry = document.createElement('div')
  entry.className = `activity-entry ${kind}`
  const time = document.createElement('span')
  time.className = 'activity-time'
  time.textContent = options.time ?? activityTimeLabel()
  const kindEl = document.createElement('span')
  kindEl.className = 'activity-kind'
  kindEl.textContent = label
  const textEl = document.createElement('span')
  textEl.className = 'activity-text'
  textEl.textContent = String(text ?? '')
  entry.append(time, kindEl, textEl)
  els.activityLog.appendChild(entry)
  while (els.activityLog.querySelectorAll('.activity-entry').length > 300) {
    els.activityLog.querySelector('.activity-entry')?.remove()
  }
  const latest = options.latest ?? `${label}: ${text}`
  els.activityLatest.textContent = activityPreview(latest)
  els.activityLatest.title = String(latest ?? '')
  scrollActivity()
  return { entry, textEl, kind }
}

function appendStreamActivity(kind, text) {
  if (typeof text !== 'string' || text.length === 0) return
  if (lastStreamEntry && lastStreamEntry.kind === kind) {
    lastStreamEntry.textEl.textContent = truncate(lastStreamEntry.textEl.textContent + text, 40_000)
    lastStreamEntry.entry.classList.add('streaming')
  } else {
    finalizeStreamActivity()
    const label = kind === 'reasoning' ? 'thinking' : 'assistant'
    const created = pushActivity(kind, label, text)
    created.kind = kind
    created.entry.classList.add('streaming')
    lastStreamEntry = created
  }
  if (kind === 'reasoning') {
    sawReasoningStream = true
    lastReasoningStreamText = truncate(lastReasoningStreamText + text, 40_000)
  }
  els.activityLatest.textContent = activityPreview(`${kind === 'reasoning' ? 'thinking' : 'assistant'}: ${text}`)
  scrollActivity()
}

function finalizeStreamActivity() {
  for (const entry of els.activityLog.querySelectorAll('.activity-entry.streaming')) {
    entry.classList.remove('streaming')
  }
  lastStreamEntry = null
}

function clearActivity() {
  for (const entry of [...els.activityLog.querySelectorAll('.activity-entry')]) entry.remove()
  els.activityEmpty?.classList.remove('hidden')
  lastStreamEntry = null
  lastReasoningStreamText = ''
  sawReasoningStream = false
  sawTextStream = false
  els.activityLatest.textContent = 'Waiting for a turn'
  els.activityLatest.title = ''
}

function toggleActivity() {
  activityExpanded = !activityExpanded
  els.activity.classList.toggle('collapsed', !activityExpanded)
  els.activityToggle.textContent = activityExpanded ? '▴' : '▾'
  els.activityToggle.title = activityExpanded ? 'Collapse activity' : 'Expand activity'
  logger.log('ui.activity.toggle', { expanded: activityExpanded }, 'debug')
  if (activityExpanded) scrollActivity()
}

function formatTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return ''
  const parts = []
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'reasoningTokens']) {
    if (Number.isFinite(usage[key]) && usage[key] !== 0) {
      parts.push(`${key.replace(/Tokens$/u, '').toLowerCase()} ${usage[key]}`)
    }
  }
  return parts.join(' · ')
}

function handleActivity(frame) {
  switch (frame.kind) {
    case 'policy':
      pushActivity('model', 'policy', `reasoning ${frame.effort} (${frame.classification}${frame.policy && frame.policy !== 'auto' ? `, ${frame.policy}` : ', auto'})`)
      return
    case 'model-start':
      finalizeStreamActivity()
      sawTextStream = false
      setActivityPhase('Thinking…', 'busy')
      pushActivity('model', 'model', `started · turn ${frame.turn ?? '?'} step ${frame.step ?? '?'}`)
      return
    case 'reasoning':
      setActivityPhase('Thinking…', 'busy')
      appendStreamActivity('reasoning', frame.text)
      return
    case 'text':
      sawTextStream = true
      setActivityPhase('Responding…', 'busy')
      appendStreamActivity('text', frame.text)
      return
    case 'tool-call-delta': {
      setActivityPhase(`Using ${frame.name ?? 'tool'}…`, 'busy')
      if (lastStreamEntry && lastStreamEntry.kind === 'tool' && lastStreamEntry.id === frame.id) {
        lastStreamEntry.textEl.textContent = truncate(lastStreamEntry.textEl.textContent + (frame.argumentsDelta ?? ''), 40_000)
      } else {
        finalizeStreamActivity()
        const created = pushActivity('tool', 'tool', `${frame.name ?? 'tool'} ${frame.argumentsDelta ?? ''}`)
        created.kind = 'tool'
        created.id = frame.id
        lastStreamEntry = created
      }
      return
    }
    case 'usage': {
      const usage = formatTokenUsage(frame.usage)
      if (usage) pushActivity('usage', 'tokens', usage)
      return
    }
    case 'finish': {
      const reason = frame.reason && typeof frame.reason === 'object'
        ? (frame.reason.kind ?? JSON.stringify(frame.reason))
        : (frame.reason ?? 'finished')
      pushActivity('model', 'finish', String(reason))
      finalizeStreamActivity()
      return
    }
    case 'model-end':
      finalizeStreamActivity()
      pushActivity('model', 'model', frame.outcome?.kind === 'committed' ? 'attempt committed' : 'attempt ended')
      return
    case 'reasoning-committed':
      if (sawReasoningStream) return
      setActivityPhase('Thinking…', 'busy')
      pushActivity('reasoning', 'thinking', frame.text)
      return
    default:
      return
  }
}

function disconnect() {
  manualDisconnect = true
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (ws) {
    try {
      ws.close()
    } catch {
      // ignore
    }
    ws = null
  }
  connected = false
  setStatus('offline', 'Disconnected')
  showBanner('Disconnected. Reconnect when you want the agent to use the page.', 'Reconnect', () => connect())
}

/* ------------------------------------------------------------------ */
/* frame handling                                                      */
/* ------------------------------------------------------------------ */

/** @param {Record<string, any>} frame */
function handleFrame(frame) {
  switch (frame.type) {
    case 'hello.ok':
      connected = true
      authFailed = false
      hideBanner()
      logger.setReady(true)
      logger.log('bridge.connected', { version: frame.version }, 'info')
      logger.setContext(clientContext())
      if (pendingLlmConfig) {
        const update = pendingLlmConfig
        pendingLlmConfig = null
        sendLlmConfigure(update)
      } else {
        refreshStatus()
      }
      if (!els.settingsModal.classList.contains('hidden') && connected && modelsState.models.length === 0) {
        void refreshModels()
      }
      return
    case 'chat.hello':
      dshState = frame.dsh?.state ?? 'unknown'
      if (frame.llm && typeof frame.llm === 'object') llmState = { ...llmState, ...frame.llm }
      if (frame.credentials && typeof frame.credentials === 'object') credentialState = { ...credentialState, ...frame.credentials }
      if (llmState.model?.id) {
        settings.modelId = llmState.model.id
        els.sessionInfo.dataset.model = llmState.model.id
      }
      if (llmState.reasoningEffort) settings.reasoningEffort = llmState.reasoningEffort
      if (llmState.baseUrl) settings.modelBaseUrl = llmState.baseUrl
      if (typeof frame.log?.path === 'string') currentLogPath = frame.log.path
      logger.log('companion.hello', {
        companion: frame.companion,
        provider: frame.provider,
        model: frame.model,
        autoCapture: frame.autoCapture,
        dsh: frame.dsh,
        credentials: { configured: credentialState.configured, source: credentialState.source },
        runId: frame.log?.runId,
        logPath: frame.log?.path,
      }, 'info')
      if (!llmState.model || !credentialState.configured) setActivityPhase('Setup needed', 'error')
      else if (dshState === 'ready') setActivityPhase('Ready', 'online')
      else if (dshState === 'error') setActivityPhase('Model setup failed', 'error')
      if (els.activityLog.querySelectorAll('.activity-entry').length === 0) {
        pushActivity('model', 'ready', dshState === 'ready' ? 'Companion connected · OpenRouter ready' : 'Companion connected · setup needed')
      }
      renderProviderStatus()
      if (!els.settingsModal.classList.contains('hidden')) {
        syncProviderInputs()
        if (connected && modelsState.models.length === 0 && !modelsState.loading) void refreshModels()
      }
      if (!setupPrompted && (!llmState.model || !credentialState.configured)) {
        setupPrompted = true
        showBanner('Enter your OpenRouter API key and select a model to start.', 'Open settings', openSettings)
        openSettings()
      }
      if (dshState === 'error') {
        showBanner(`DSH failed to start: ${frame.dsh?.message ?? 'unknown error'}`, 'Open settings', openSettings)
      } else if (dshState === 'disabled') {
        showBanner('DSH is disabled (companion started with --no-dsh).', 'Reconnect', () => connect())
      } else {
        hideBanner()
      }
      refreshStatus()
      return
    case 'chat.status':
      handleStatus(frame)
      return
    case 'chat.activity':
      handleActivity(frame)
      return
    case 'chat.assistant':
      if (typeof frame.text === 'string' && frame.text.length > 0) {
        if (!sawTextStream) pushActivity('text', 'assistant', frame.text)
        appendAssistant(frame.text)
      }
      return
    case 'chat.tool_call':
      handleToolCall(frame)
      return
    case 'chat.tool_result':
      handleToolResult(frame)
      return
    case 'chat.done':
      handleDone(frame)
      return
    case 'chat.error':
      handleChatError(frame)
      return
    case 'chat.session':
      if (typeof frame.sessionId === 'string') {
        sessionId = frame.sessionId
        updateFooter()
      }
      return
    case 'browser.command':
      void handleBrowserCommand(frame)
      return
    case 'llm.models.result':
      handleModelsResult(frame)
      return
    case 'llm.configured':
      handleLlmConfigured(frame)
      return
    case 'log.stats.result':
      renderLogStats(frame.stats)
      return
    case 'log.summary.result':
      handleSummaryResult(frame)
      return
    case 'log.export.result':
      handleExportResult(frame)
      return
    case 'log.error':
      els.logExport.disabled = false
      toast(`Log request failed: ${frame.message ?? 'unknown error'}`)
      logger.log('log.request.error', { message: frame.message, request: frame.request }, 'error')
      return
    case 'pong':
      return
    default:
      return
  }
}

/** @param {Record<string, any>} frame */
function handleStatus(frame) {
  const status = frame.status
  logger.log('bridge.status', { status: frame.status, tool: frame.tool }, 'debug')
  if (status === 'ready' || status === 'idle') {
    connected = true
    if (dshState === 'unknown' || dshState === 'starting') dshState = 'ready'
    setBusy(false)
    setActivityPhase('Ready', 'online')
    finalizeStreamActivity()
    refreshStatus()
    return
  }
  if (status === 'capturing') {
    setStatus('busy', 'Seeing the page…')
    setActivityPhase('Seeing the page…', 'busy')
    return
  }
  if (status === 'thinking') {
    setStatus('busy', 'Thinking…')
    setActivityPhase('Thinking…', 'busy')
    return
  }
  if (status === 'tool') {
    const tool = typeof frame.tool === 'string' ? toolLabel(frame.tool) : 'a tool'
    setStatus('busy', `Using ${tool}…`)
    setActivityPhase(`Using ${tool}…`, 'busy')
    return
  }
  if (status === 'error') {
    setStatus('error', 'Error')
    setActivityPhase('Error', 'error')
    finalizeStreamActivity()
    return
  }
  if (status === 'starting') {
    setStatus('busy', 'Starting DSH…')
    setActivityPhase('Starting DSH…', 'busy')
  }
}

/* ------------------------------------------------------------------ */
/* chat rendering                                                      */
/* ------------------------------------------------------------------ */

function hideEmpty() {
  els.empty.classList.add('hidden')
}

function showEmpty() {
  els.empty.classList.remove('hidden')
}

function scrollChat() {
  requestAnimationFrame(() => {
    els.chat.scrollTop = els.chat.scrollHeight
  })
}

/** @param {string} text */
function appendUser(text) {
  activityTurnStart = Date.now()
  sawReasoningStream = false
  sawTextStream = false
  lastReasoningStreamText = ''
  finalizeStreamActivity()
  setActivityPhase('Sending…', 'busy')
  pushActivity('user', 'you', truncate(text, 2_000), { time: '+0.0s' })
  hideEmpty()
  const el = document.createElement('div')
  el.className = 'bubble user'
  el.textContent = text
  els.chat.appendChild(el)
  scrollChat()
}

/** @param {string} text */
function appendAssistant(text) {
  const value = text.trim()
  if (value.length === 0) return
  hideEmpty()
  const el = document.createElement('div')
  el.className = 'bubble assistant'
  el.textContent = value
  els.chat.appendChild(el)
  lastAssistantText = value
  scrollChat()
}

/** @param {string} text */
function appendError(text) {
  hideEmpty()
  const el = document.createElement('div')
  el.className = 'bubble error'
  el.textContent = text
  els.chat.appendChild(el)
  scrollChat()
}

/** @param {string} name */
function toolLabel(name) {
  switch (name) {
    case 'browser_screenshot': return 'screenshot'
    case 'browser_scroll': return 'scroll'
    case 'browser_tabs': return 'tabs'
    case 'browser_switch_tab': return 'switch tab'
    case 'browser_read_text': return 'read text'
    case 'browser_click': return 'click'
    case 'auto': return 'current view'
    default: return String(name ?? 'tool').replace(/^browser_/, '')
  }
}

/**
 * @param {string | null | undefined} callId
 * @param {string} fallbackName
 */
function ensureCard(callId, fallbackName) {
  const key = typeof callId === 'string' && callId.length > 0 ? callId : `local-${++localCardSeq}`
  const existing = cards.get(key)
  if (existing) return existing

  hideEmpty()
  const root = document.createElement('div')
  root.className = 'tool-card'
  const head = document.createElement('div')
  head.className = 'tool-head'
  const name = document.createElement('span')
  name.className = 'tool-name'
  name.textContent = toolLabel(fallbackName)
  const status = document.createElement('span')
  status.className = 'tool-status'
  status.textContent = 'running'
  head.append(name, status)
  const body = document.createElement('div')
  body.className = 'tool-body'
  const args = document.createElement('pre')
  args.className = 'tool-args hidden'
  const view = document.createElement('div')
  view.className = 'view hidden'
  const result = document.createElement('pre')
  result.className = 'tool-result hidden'
  body.append(args, view, result)
  root.append(head, body)
  els.chat.appendChild(root)

  const card = {
    key,
    root,
    nameEl: name,
    statusEl: status,
    argsEl: args,
    viewEl: view,
    resultEl: result,
    view: null,
    name: fallbackName,
    callId: typeof callId === 'string' ? callId : undefined,
  }
  cards.set(key, card)
  scrollChat()
  return card
}

/** @param {any} card @param {string} text @param {'running'|'ok'|'fail'} kind */
function setCardStatus(card, text, kind = 'running') {
  card.statusEl.textContent = text
  card.statusEl.className = `tool-status ${kind === 'ok' ? 'ok' : kind === 'fail' ? 'fail' : ''}`
}

/** @param {any} card @param {string} text */
function setCardArgs(card, text) {
  if (!text) return
  card.argsEl.textContent = truncate(text, 1_200)
  card.argsEl.classList.remove('hidden')
}

/** @param {Record<string, any>} frame */
function handleToolCall(frame) {
  logger.log('ui.tool_call', { callId: frame.callId, name: frame.name, args: truncate(frame.args, 500) }, 'debug')
  finalizeStreamActivity()
  setActivityPhase(`Using ${toolLabel(frame.name)}…`, 'busy')
  pushActivity('tool', 'call', `${toolLabel(frame.name)} ${truncate(frame.args ?? '{}', 500)}`)
  const card = ensureCard(frame.callId, frame.name)
  card.name = frame.name ?? card.name
  card.nameEl.textContent = toolLabel(card.name)
  if (typeof frame.args === 'string' && frame.args.length > 0) {
    try {
      setCardArgs(card, JSON.stringify(JSON.parse(frame.args), null, 2))
    } catch {
      setCardArgs(card, frame.args)
    }
  }
  setCardStatus(card, 'running')
  setBusy(true)
  if (typeof frame.name === 'string') setStatus('busy', `Using ${toolLabel(frame.name)}…`)
}

/** @param {Record<string, any>} frame */
function handleToolResult(frame) {
  logger.log('ui.tool_result', { callId: frame.callId, ok: frame.ok !== false, text: truncate(frame.text, 500) }, 'debug')
  const ok = frame.ok !== false
  pushActivity('tool', ok ? 'result' : 'failed', truncate(frame.text || (ok ? 'completed' : 'failed'), 700))
  setActivityPhase('Thinking…', 'busy')
  finalizeStreamActivity()
  const card = ensureCard(frame.callId, 'tool')
  setCardStatus(card, ok ? 'done' : 'failed', ok ? 'ok' : 'fail')
  if (!card.view && typeof frame.text === 'string' && frame.text.length > 0) {
    card.resultEl.textContent = truncate(frame.text, 2_000)
    card.resultEl.classList.remove('hidden')
  }
  if (!ok && typeof frame.text === 'string' && frame.text.length > 0 && !card.view) {
    card.resultEl.textContent = truncate(frame.text, 2_000)
    card.resultEl.classList.remove('hidden')
  }
  scrollChat()
}

/** @param {Record<string, any>} frame */
function handleDone(frame) {
  setBusy(false)
  dshState = 'ready'
  void execute('labels.clear', {}, settings).catch(() => {})
  const total = frame.timings?.totalMs
  pushActivity('done', 'done', `turn complete${Number.isFinite(total) ? ` · ${shortDuration(total)}` : ''}${Number.isFinite(frame.timings?.toolCalls) ? ` · ${frame.timings.toolCalls} tools` : ''}`)
  setActivityPhase('Ready', 'online')
  finalizeStreamActivity()
  logger.log('chat.done', {
    sessionId: frame.sessionId,
    timings: frame.timings,
    textLength: typeof frame.text === 'string' ? frame.text.length : 0,
  }, 'info')
  if (typeof frame.text === 'string' && frame.text.trim().length > 0 && frame.text.trim() !== lastAssistantText) {
    appendAssistant(frame.text)
  }
  if (typeof frame.sessionId === 'string' && frame.sessionId.length > 0) {
    sessionId = frame.sessionId
  }
  const timing = frame.timings
  if (timing && typeof timing === 'object') {
    const parts = [shortDuration(timing.totalMs)]
    if (Number.isFinite(timing.autoCaptureMs) && timing.autoCaptureMs > 0) parts.push(`look ${shortDuration(timing.autoCaptureMs)}`)
    if (Number.isFinite(timing.toolCalls) && timing.toolCalls > 0) parts.push(`${timing.toolCalls} tool${timing.toolCalls === 1 ? '' : 's'}`)
    els.timing.textContent = parts.filter(Boolean).join(' · ')
  }
  updateFooter()
  refreshStatus()
}

/** @param {Record<string, any>} frame */
function handleChatError(frame) {
  setBusy(false)
  void execute('labels.clear', {}, settings).catch(() => {})
  const message = typeof frame.message === 'string' ? frame.message : 'Unknown companion error'
  pushActivity('error', 'error', message)
  setActivityPhase('Error', 'error')
  finalizeStreamActivity()
  logger.log('chat.error', { message, recoverable: frame.recoverable !== false }, 'error')
  appendError(message)
  setStatus('error', 'Error')
  if (/companion|not connected|script|invalid pairing|dsh/i.test(message)) {
    showBanner(message, 'Open settings', openSettings)
  }
}

function updateFooter() {
  if (sessionId) {
    els.sessionInfo.textContent = sessionId.startsWith('session-') ? `session ${sessionId.slice(8, 16)}` : sessionId
    els.sessionInfo.title = sessionId
  } else {
    const model = els.sessionInfo.dataset.model
    els.sessionInfo.textContent = model ? `ready · ${model}` : 'ready'
    els.sessionInfo.title = ''
  }
}

/* ------------------------------------------------------------------ */
/* browser commands                                                    */
/* ------------------------------------------------------------------ */

/** @param {Record<string, any>} frame */
async function handleBrowserCommand(frame) {
  const command = frame.command ?? {}
  const op = String(command.op ?? '')
  const args = command.args && typeof command.args === 'object' ? command.args : {}
  const started = performance.now()
  setActivityPhase(
    op === 'tabs.list' ? 'Listing tabs…'
      : op === 'tabs.activate' ? 'Switching tabs…'
        : op === 'scroll' ? 'Scrolling…'
          : op === 'click' ? 'Clicking…'
            : op === 'read_text' ? 'Reading text…'
              : 'Capturing…',
    'busy',
  )
  pushActivity('browser', 'browser', `${op} ${truncate(JSON.stringify(args), 300)}`)
  logger.log('browser.command.start', {
    commandId: frame.id,
    callId: frame.callId,
    turnId: frame.turnId,
    op,
    args,
  }, 'debug')
  const card = ensureCard(frame.callId, frame.callId === 'auto' ? 'auto' : op)
  if (card.name === 'browser' || card.name === op) {
    card.name = op === 'tabs.list' ? 'browser_tabs'
      : op === 'tabs.activate' ? 'browser_switch_tab'
        : op === 'scroll' ? 'browser_scroll'
          : op === 'read_text' ? 'browser_read_text'
            : op === 'click' ? 'browser_click'
              : 'browser_screenshot'
    card.nameEl.textContent = toolLabel(frame.callId === 'auto' ? 'auto' : card.name)
  }

  if (settings.paused) {
    const error = { code: 'PAUSED', message: 'Browser access is paused in the side panel.' }
    pushActivity('error', 'browser', error.message)
    setActivityPhase('Paused', 'paused')
    logger.log('browser.command.error', { commandId: frame.id, callId: frame.callId, op, error, durationMs: Math.round(performance.now() - started) }, 'warn')
    setCardStatus(card, 'paused', 'fail')
    setCardArgs(card, JSON.stringify(args, null, 2))
    sendBrowserResult(frame.id, false, undefined, error)
    return
  }

  setCardStatus(card, 'looking')
  setActivity(true)
  setStatus('busy', 'Seeing the page…')
  try {
    const result = await execute(op, args, settings)
    attachView(card, result)
    setCardStatus(card, 'captured', 'ok')
    pushActivity('browser', op === 'tabs.list' ? 'tabs' : 'view', browserActivitySummary(op, result))
    setActivityPhase('Thinking…', 'busy')
    logger.log('browser.command.result', {
      commandId: frame.id,
      callId: frame.callId,
      turnId: frame.turnId,
      op,
      durationMs: Math.round(performance.now() - started),
      captureMs: result.captureMs,
      encodeMs: result.encodeMs,
      totalMs: result.totalMs,
      image: result.image ? {
        width: result.image.width,
        height: result.image.height,
        bytes: result.image.bytes,
        mimeType: result.image.mimeType,
        reencoded: result.image.reencoded,
      } : undefined,
      scroll: result.scroll,
      moved: result.moved,
      tabs: Array.isArray(result.tabs) ? result.tabs.length : undefined,
      tab: result.tab ? { id: result.tab.id, title: result.tab.title, url: result.tab.url } : undefined,
    }, 'info')
    sendBrowserResult(frame.id, true, result)
  } catch (error) {
    const message = errorMessage(error)
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BROWSER_ERROR'
    pushActivity('error', 'browser', `${op}: ${message}`)
    setActivityPhase('Browser error', 'error')
    logger.log('browser.command.error', {
      commandId: frame.id,
      callId: frame.callId,
      turnId: frame.turnId,
      op,
      durationMs: Math.round(performance.now() - started),
      error: { code, message },
    }, 'error')
    setCardStatus(card, 'failed', 'fail')
    card.resultEl.textContent = message
    card.resultEl.classList.remove('hidden')
    sendBrowserResult(frame.id, false, undefined, { code, message })
  } finally {
    setActivity(false)
    if (!busy) refreshStatus()
  }
}

function browserActivitySummary(op, result) {
  if (!result || typeof result !== 'object') return op
  if (Array.isArray(result.tabs)) return `${result.tabs.length} tabs · ${result.tabs.filter(tab => tab.active).map(tab => tab.title).join('') || 'no active marker'}`
  const parts = []
  if (result.tab?.title) parts.push(truncate(result.tab.title, 60))
  if (result.image) parts.push(`${result.image.width}×${result.image.height} · ${formatBytes(result.image.bytes)}`)
  if (result.scroll) {
    parts.push(`scroll ${result.scroll.container ?? 'document'} y=${Math.round(result.scroll.y ?? 0)}/${Math.round(result.scroll.maxY ?? 0)}${result.scroll.atBottom ? ' bottom' : ''}`)
  }
  if (result.moved) parts.push(`moved ${Math.round(result.moved.dx ?? 0)},${Math.round(result.moved.dy ?? 0)}`)
  if (typeof result.text === 'string') {
    parts.push(`${result.text.length} chars${result.truncated ? ` of ${result.totalChars}` : ''} · ${Math.round(result.totalMs ?? 0)}ms`)
  }
  if (result.clicked) {
    parts.push(`click #${result.clicked.label} ${truncate(result.clicked.text || result.clicked.tag || '', 50)}`)
    parts.push(result.changed ? 'changed' : 'no visible change')
  }
  if (Number.isFinite(result.labelCount)) parts.push(`${result.labelCount} labels`)
  if (Number.isFinite(result.captureMs)) parts.push(`capture ${result.captureMs}ms`)
  if (Number.isFinite(result.encodeMs)) parts.push(`encode ${result.encodeMs}ms`)
  return parts.join(' · ') || op
}

function sendBrowserResult(id, ok, result, error) {
  if (typeof id !== 'string') return
  sendFrame({
    v: PROTOCOL_VERSION,
    type: 'browser.result',
    id,
    ok,
    ...(ok ? { result } : { error }),
  })
}

/** @param {any} card @param {Record<string, any>} result */
function attachView(card, result) {
  card.view = result
  card.viewEl.replaceChildren()
  card.viewEl.classList.remove('hidden')
  card.resultEl.classList.add('hidden')

  const meta = document.createElement('div')
  meta.className = 'view-meta'
  const addChip = (text, strong = false) => {
    if (!text) return
    const chip = document.createElement('span')
    chip.className = `chip${strong ? ' strong' : ''}`
    chip.textContent = text
    chip.title = text
    meta.appendChild(chip)
  }

  if (result?.tab) {
    addChip(truncate(result.tab.title || result.tab.url || 'tab', 48), true)
    addChip(`#${result.tab.id}`)
  }
  if (result?.viewport) addChip(`${result.viewport.width}×${result.viewport.height} css`)
  if (result?.image) addChip(`${result.image.width}×${result.image.height} px`)
  if (result?.scroll) {
    addChip(`${result.scroll.container ?? 'document'} y=${Math.round(result.scroll.y ?? 0)}/${Math.round(result.scroll.maxY ?? 0)}`)
    if (result.scroll.atTop) addChip('top')
    if (result.scroll.atBottom) addChip('bottom')
  }
  if (result?.moved) addChip(`moved ${Math.round(result.moved.dx ?? 0)},${Math.round(result.moved.dy ?? 0)}`)
  if (typeof result?.text === 'string') {
    addChip(`${result.text.length} chars${result.truncated ? ` / ${result.totalChars}` : ''}`)
    addChip(`read ${Math.round(result.totalMs ?? 0)}ms`)
  }
  if (result?.clicked) {
    addChip(`clicked #${result.clicked.label}`, true)
    addChip(truncate(result.clicked.text || result.clicked.tag || '', 40))
    addChip(result.changed ? 'changed' : 'no change')
    if (result.navigated) addChip('navigated')
  }
  if (Number.isFinite(result?.labelCount)) addChip(`${result.labelCount} labels`)
  if (Number.isFinite(result?.captureMs)) addChip(`capture ${result.captureMs}ms`)
  if (Number.isFinite(result?.encodeMs)) addChip(`encode ${result.encodeMs}ms`)
  card.viewEl.appendChild(meta)

  if (Array.isArray(result?.tabs)) {
    const list = document.createElement('div')
    list.className = 'tab-list'
    for (const tab of result.tabs) {
      const row = document.createElement('div')
      row.className = `tab-row${tab.active ? ' active' : ''}`
      const id = document.createElement('span')
      id.className = 'id'
      id.textContent = String(tab.id)
      const title = document.createElement('span')
      title.className = 'title'
      title.textContent = tab.title || tab.url || '(untitled)'
      title.title = tab.url || ''
      const flags = document.createElement('span')
      flags.className = 'flags'
      flags.textContent = [tab.active ? 'active' : '', tab.pinned ? 'pinned' : '', tab.discarded ? 'discarded' : ''].filter(Boolean).join(' ')
      row.append(id, title, flags)
      list.appendChild(row)
    }
    card.viewEl.appendChild(list)
  }

  if (typeof result?.text === 'string') {
    const preview = document.createElement('pre')
    preview.className = 'text-preview'
    preview.textContent = truncate(result.text, 4_000)
    card.viewEl.appendChild(preview)
  }

  const src = imageDataUrl(result?.image)
  if (src) {
    const img = document.createElement('img')
    img.className = 'thumb'
    img.src = src
    img.alt = result?.tab?.title ? `Screenshot of ${result.tab.title}` : 'Screenshot'
    img.addEventListener('click', () => openImage(src))
    card.viewEl.appendChild(img)
  }

  scrollChat()
}

function openImage(src) {
  els.imageModalImg.src = src
  els.imageModal.classList.remove('hidden')
}

function closeImage() {
  els.imageModal.classList.add('hidden')
  els.imageModalImg.removeAttribute('src')
}

/* ------------------------------------------------------------------ */
/* composer / controls                                                 */
/* ------------------------------------------------------------------ */

function resizeInput() {
  els.input.style.height = 'auto'
  els.input.style.height = `${Math.min(els.input.scrollHeight, 132)}px`
}

function sendMessage() {
  const text = els.input.value.trim()
  if (text.length === 0) return
  if (!connected) {
    showBanner('Not connected to the companion. Start it with npm run dev and reconnect.', 'Reconnect', () => connect())
    return
  }
  if (!llmState.model || !credentialState.configured) {
    showBanner('Enter your OpenRouter API key and select a model before asking.', 'Open settings', openSettings)
    openSettings()
    return
  }
  if (busy) {
    toast('Wait for the current turn to finish')
    return
  }
  if (sendFrame({ v: PROTOCOL_VERSION, type: 'chat.send', text, autoCapture: settings.autoCapture !== false })) {
    logger.log('chat.send', {
      textLength: text.length,
      autoCapture: settings.autoCapture !== false,
      preview: truncate(text, 300),
    }, 'info')
    appendUser(text)
    els.input.value = ''
    resizeInput()
    lastAssistantText = ''
    setBusy(true)
    setStatus('busy', 'Sending…')
  }
}

function newChat() {
  logger.log('chat.new', {}, 'info')
  if (busy) {
    toast('Wait for the current turn to finish')
    return
  }
  sendFrame({ v: PROTOCOL_VERSION, type: 'chat.new' })
  clearChat()
  sessionId = ''
  updateFooter()
  if (connected) setStatus('online', 'Connected')
}

function clearChat() {
  for (const child of [...els.chat.children]) {
    if (child !== els.empty) child.remove()
  }
  cards.clear()
  lastAssistantText = ''
  els.timing.textContent = ''
  clearActivity()
  setActivityPhase('Ready', 'online')
  showEmpty()
}

function togglePause() {
  settings.paused = !settings.paused
  logger.log('settings.pause', { paused: settings.paused }, 'info')
  els.pause.classList.toggle('active', settings.paused)
  els.pause.title = settings.paused ? 'Resume browser access' : 'Pause browser access'
  void saveSettings()
  if (settings.paused) {
    setStatus('paused', 'Paused')
    toast('Browser access paused. The agent can still chat but cannot see the page.')
  } else {
    refreshStatus()
    toast('Browser access resumed')
  }
}

/* ------------------------------------------------------------------ */
/* active tab header                                                   */
/* ------------------------------------------------------------------ */

async function refreshActiveTab() {
  try {
    const win = await chrome.windows.getCurrent()
    const tabs = await chrome.tabs.query({ windowId: win.id, active: true })
    const tab = tabs[0]
    if (tab) {
      const signature = `${tab.id ?? ''}|${tab.url ?? ''}|${tab.title ?? ''}`
      if (signature !== lastTabSignature) {
        lastTabSignature = signature
        logger.log('tab.active', { id: tab.id, title: tab.title, url: tab.url, status: tab.status }, 'debug')
      }
      els.activeTab.textContent = truncate(tab.title || tab.url || 'Untitled tab', 60)
      els.activeTab.title = tab.url || ''
    } else {
      els.activeTab.textContent = 'No active tab'
      els.activeTab.title = ''
    }
  } catch {
    els.activeTab.textContent = 'No active tab'
  }
}

function scheduleTabRefresh() {
  clearTimeout(tabRefreshTimer)
  tabRefreshTimer = setTimeout(() => { void refreshActiveTab() }, 120)
}

/* ------------------------------------------------------------------ */
/* debug log modal and export                                          */
/* ------------------------------------------------------------------ */

function openLogModal() {
  els.logModal.classList.remove('hidden')
  els.logStats.textContent = 'Requesting log stats…'
  els.logSignals.replaceChildren()
  logger.log('log.modal.open', {}, 'debug')
  if (!connected) {
    els.logStats.textContent = 'Companion offline. Start it with npm run dev, then reconnect to export logs.'
    return
  }
  sendFrame({ v: PROTOCOL_VERSION, type: 'log.stats' })
}

function closeLogModal() {
  els.logModal.classList.add('hidden')
}

/** @param {Record<string, any> | null} stats */
function renderLogStats(stats) {
  currentLogStats = stats ?? null
  if (stats?.path) currentLogPath = stats.path
  if (!stats) {
    els.logStats.textContent = 'Waiting for the companion…'
    els.logSignals.replaceChildren()
    return
  }
  const lines = [
    `run:        ${stats.runId ?? '?'}`,
    `path:       ${stats.path ?? '?'}`,
    `events:     ${stats.events ?? 0}    screenshots: ${stats.screenshots ?? 0}    turns: ${stats.turns ?? 0}`,
    `warnings:   ${stats.warnings ?? 0}    errors: ${stats.errors ?? 0}    signals: ${stats.signals ?? 0}`,
    `size:       ${formatBytes(stats.bytes ?? 0)}`,
    `session:    ${stats.sessionId ?? '—'}`,
    `model:      ${stats.meta?.provider ?? '—'} / ${stats.meta?.model ?? '—'}`,
    `extension:  ${stats.context?.extensionVersion ?? '—'}   ${stats.context?.platform ?? ''}`,
  ]
  els.logStats.textContent = lines.join('\n')

  els.logSignals.replaceChildren()
  const signals = Array.isArray(stats.recentSignals) ? stats.recentSignals : []
  if (signals.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'log-signal info'
    empty.textContent = 'No recent warnings or errors.'
    els.logSignals.appendChild(empty)
    return
  }
  for (const signal of signals) {
    const row = document.createElement('div')
    row.className = `log-signal ${signal.severity ?? 'info'}`
    row.textContent = `${String(signal.severity ?? 'info').toUpperCase()} ${signal.code ?? 'signal'}: ${signal.message ?? ''}`
    els.logSignals.appendChild(row)
  }
}

/** @param {Record<string, any>} frame */
function handleSummaryResult(frame) {
  const summary = typeof frame.summary === 'string' ? frame.summary : ''
  if (frame.stats) renderLogStats(frame.stats)
  logger.log('log.summary.result', { chars: summary.length }, 'info')
  if (copySummaryRequested) copySummaryRequested = false
  if (summary.length === 0) {
    toast('The summary is empty')
    return
  }
  void copyText(summary).then(copied => {
    toast(copied ? 'Summary copied to clipboard' : 'Could not copy the summary')
  })
}

/** @param {Record<string, any>} frame */
function handleExportResult(frame) {
  els.logExport.disabled = false
  if (frame.ok !== true) {
    const message = frame.error?.message ?? frame.message ?? 'unknown export error'
    toast(`Export failed: ${message}`)
    logger.log('log.export.error', { message }, 'error')
    return
  }
  if (frame.stats) renderLogStats(frame.stats)
  if (typeof frame.path === 'string' && frame.path.length > 0) currentLogPath = frame.path
  if (frame.inline === true && typeof frame.base64 === 'string' && frame.base64.length > 0) {
    downloadBase64(frame.filename, frame.base64)
    toast(`Downloaded ${frame.filename} (${formatBytes(frame.sizeBytes)})`)
  } else {
    toast(`Bundle written to ${currentLogPath || 'the companion log directory'}`)
  }
  logger.log('log.export.result', {
    ok: true,
    inline: frame.inline === true,
    filename: frame.filename,
    sizeBytes: frame.sizeBytes,
    path: frame.path,
    contents: Array.isArray(frame.contents) ? frame.contents.length : undefined,
  }, 'info')
}

function exportLog() {
  if (!connected) {
    toast('Companion offline — start it with npm run dev and reconnect')
    return
  }
  const includeScreenshots = els.logIncludeScreenshots.checked
  const includeSession = els.logIncludeSession.checked
  els.logExport.disabled = true
  const sent = sendFrame({
    v: PROTOCOL_VERSION,
    type: 'log.export',
    includeScreenshots,
    includeSession,
    requestId: `export-${Date.now()}`,
  })
  if (!sent) {
    els.logExport.disabled = false
    return
  }
  logger.log('log.export.request', { includeScreenshots, includeSession }, 'info')
  toast('Building debug bundle…')
}

function copySummary() {
  if (!connected) {
    toast('Companion offline — start it with npm run dev and reconnect')
    return
  }
  copySummaryRequested = true
  logger.log('log.summary.request', {}, 'info')
  toast('Preparing summary…')
  sendFrame({ v: PROTOCOL_VERSION, type: 'log.summary' })
}

function copyLogPath() {
  const path = currentLogPath || currentLogStats?.path || ''
  if (!path) {
    toast('No log path yet')
    return
  }
  void copyText(path).then(copied => toast(copied ? 'Logs path copied' : 'Could not copy the path'))
}

/** @param {string} filename @param {string} base64 */
function downloadBase64(filename, base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** @param {string} text @returns {Promise<boolean>} */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

els.settingsSave.addEventListener('click', () => {
  const url = els.settingUrl.value.trim()
  const token = els.settingToken.value.trim()
  const apiKey = els.settingApiKey.value.trim()
  const baseUrl = (els.settingBaseUrl.value.trim() || DEFAULT_MODEL_BASE_URL).replace(/\/+$/u, '')
  const model = els.settingModel.value.trim()
  const remember = els.settingRememberKey.checked
  const reasoningEffort = els.settingEffort.value
  const width = Number(els.settingWidth.value)
  const quality = Number(els.settingQuality.value)
  if (!/^wss?:\/\//u.test(url)) {
    toast('Bridge URL must start with ws:// or wss://')
    return
  }
  if (token.length === 0) {
    toast('Paste the pairing token printed by npm run dev')
    return
  }
  if (!/^https?:\/\//u.test(baseUrl)) {
    toast('Model base URL must start with http:// or https://')
    return
  }
  if (model.length === 0) {
    toast('Select an OpenRouter model (click Refresh if the list is empty)')
    return
  }
  if (apiKey.length === 0 && !credentialState.configured) {
    toast('Enter your OpenRouter API key')
    return
  }
  if (!Number.isFinite(width) || width < 640 || width > 2048) {
    toast('Capture width must be between 640 and 2048')
    return
  }
  if (!Number.isFinite(quality) || quality < 40 || quality > 90) {
    toast('JPEG quality must be between 40 and 90')
    return
  }
  const reconnectNeeded = settings.bridgeUrl !== url || settings.token !== token
  const modelChanged = model !== (llmState.model?.id ?? '') || baseUrl !== (llmState.baseUrl ?? settings.modelBaseUrl)
  const effortChanged = reasoningEffort !== (llmState.reasoningEffort ?? 'auto')
  const llmUpdate = (modelChanged || effortChanged || apiKey.length > 0)
    ? { baseUrl, model, remember, reasoningEffort, ...(apiKey.length > 0 ? { apiKey } : {}) }
    : null

  settings = {
    ...settings,
    bridgeUrl: url,
    token,
    captureWidth: Math.round(width),
    quality: Math.round(quality),
    autoCapture: els.settingAutoCapture.checked,
    modelBaseUrl: baseUrl,
    modelId: model,
  }
  logger.log('settings.save', {
    bridgeUrl: url,
    captureWidth: settings.captureWidth,
    quality: settings.quality,
    autoCapture: settings.autoCapture,
    tokenLength: token.length,
    modelBaseUrl: baseUrl,
    modelId: model,
    reasoningEffort,
    apiKeyUpdated: apiKey.length > 0,
    apiKeyLength: apiKey.length,
    remember,
    reconnectNeeded,
  }, 'info')
  logger.setContext(clientContext())
  void saveSettings()
  els.settingApiKey.value = ''
  closeSettings()
  if (reconnectNeeded || !connected) {
    pendingLlmConfig = llmUpdate
    connect()
  } else if (llmUpdate) {
    sendLlmConfigure(llmUpdate)
  } else {
    refreshStatus()
  }
})

els.testCapture.addEventListener('click', async () => {
  clearToast()
  logger.log('testCapture.start', {}, 'info')
  try {
    const result = await testCapture(settings)
    const src = imageDataUrl(result.image)
    if (src) openImage(src)
    logger.log('testCapture.result', {
      width: result.image.width,
      height: result.image.height,
      bytes: result.image.bytes,
      captureMs: result.captureMs,
      encodeMs: result.encodeMs,
      totalMs: result.totalMs,
    }, 'info')
    toast(`Captured ${result.image.width}×${result.image.height} in ${result.captureMs + result.encodeMs}ms`)
  } catch (error) {
    logger.log('testCapture.error', { message: errorMessage(error) }, 'error')
    toast(errorMessage(error))
  }
})

function clearToast() {
  clearTimeout(toastTimer)
  els.toast.classList.add('hidden')
}

els.settings.addEventListener('click', openSettings)
els.settingsClose.addEventListener('click', closeSettings)
els.debugLog.addEventListener('click', openLogModal)
els.logClose.addEventListener('click', closeLogModal)
els.logModal.addEventListener('click', event => {
  if (event.target === els.logModal) closeLogModal()
})
els.logExport.addEventListener('click', exportLog)
els.logCopySummary.addEventListener('click', copySummary)
els.logCopyPath.addEventListener('click', copyLogPath)
els.refreshModels.addEventListener('click', () => { void refreshModels() })
els.settingBaseUrl.addEventListener('change', () => {
  if (connected) void refreshModels()
})
els.settingModel.addEventListener('input', renderProviderStatus)
els.imageClose.addEventListener('click', closeImage)
els.imageModal.addEventListener('click', event => {
  if (event.target === els.imageModal) closeImage()
})
els.settingsModal.addEventListener('click', event => {
  if (event.target === els.settingsModal) closeSettings()
})

els.bannerAction.addEventListener('click', () => {
  const action = bannerAction
  hideBanner()
  action()
})

els.pause.addEventListener('click', togglePause)
els.newChat.addEventListener('click', newChat)
els.activityToggle.addEventListener('click', toggleActivity)

els.input.addEventListener('input', resizeInput)
els.input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
})
document.getElementById('composer').addEventListener('submit', event => {
  event.preventDefault()
  sendMessage()
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!els.imageModal.classList.contains('hidden')) closeImage()
    else if (!els.logModal.classList.contains('hidden')) closeLogModal()
    else if (!els.settingsModal.classList.contains('hidden')) closeSettings()
  }
})

window.addEventListener('beforeunload', () => {
  manualDisconnect = true
  try {
    ws?.close()
  } catch {
    // ignore
  }
})

chrome.tabs.onActivated.addListener(() => scheduleTabRefresh())
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.title !== undefined || changeInfo.url !== undefined || changeInfo.status !== undefined)) scheduleTabRefresh()
})
chrome.tabs.onRemoved.addListener(() => scheduleTabRefresh())
chrome.windows.onFocusChanged.addListener(() => scheduleTabRefresh())

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  logger.log('app.boot', { href: location.href, userAgent: navigator.userAgent }, 'info')
  await loadSettings()
  populateSettings()
  logger.log('settings.loaded', {
    hasToken: settings.token.length > 0,
    bridgeUrl: settings.bridgeUrl,
    captureWidth: settings.captureWidth,
    quality: settings.quality,
    autoCapture: settings.autoCapture,
    paused: settings.paused,
  }, 'debug')
  logger.setContext(clientContext())
  els.pause.classList.toggle('active', settings.paused)
  els.pause.title = settings.paused ? 'Resume browser access' : 'Pause browser access'
  await refreshActiveTab()
  updateFooter()
  setStatus('offline', 'Connecting…')
  if (!settings.token) openSettings()
  connect()
  logger.log('app.boot.ready', {}, 'info')
}

void boot()