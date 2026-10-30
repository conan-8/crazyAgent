/**
 * CrazyAgent side panel: chat UI, bridge client, and browser-command executor.
 *
 * The panel owns the WebSocket to the local companion. It renders model text
 * and tool activity, executes browser commands from the DSH provider, and
 * attaches a fresh DOM/text or screenshot view to each user turn.
 */

import { DEFAULT_SETTINGS, execute, testCapture, imageDataUrl, beginDebuggerRun, endDebuggerRun } from './browser.js'
import { ClientLogger } from './logger.js'
import { renderMarkdown } from './markdown.js'
import { PROTOCOL_VERSION, truncate, errorMessage, formatBytes } from './protocol.js'

const SETTINGS_KEY = 'crazyagent.settings'
const RECONNECT_MS = 2_500
const STOP_CONFIRM_TIMEOUT_MS = 15_000
const DEFAULT_MODEL_BASE_URL = 'https://openrouter.ai/api/v1'
const RECOMMENDED_MODEL_ID = 'deepseek/deepseek-v4.1-flash-1017'
const HISTORY_KEY = 'crazyagent.history'
const MAX_HISTORY = 12
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 5_000_000
const MAX_TOTAL_IMAGE_BYTES = 12_000_000
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
let settingsDraftEffort = 'auto'
let conversationHistory = []
let currentConversationId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let newChatOnNextConnect = true
let historySaveTimer = null
let attachedImages = []
/** @type {Array<{id: string, text: string, images: Array<{name: string, size: number, mimeType: string, data: string}>}>} */
let queuedMessages = []
let dictation = null
let queuedMessageSequence = 0
let steeringMessageId = null
let queueDispatchTimer = null
let renderedQueueKey = ''

/** @type {import('./protocol.js').Settings} */
let settings = { ...DEFAULT_SETTINGS }
/** @type {WebSocket | null} */
let ws = null
let reconnectTimer = null
let manualDisconnect = false
let authFailed = false
let connected = false
let busy = false
let stopAvailable = false
let stopping = false
let stopTimer = null
let dshState = 'unknown'
let lastAssistantText = ''
let lastAnswerText = ''
let sessionId = ''
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
let latestContextTokens = 0
/** @type {Record<string, any> | null} */
let pendingLlmConfig = null
let setupPrompted = false
let modelsTimer = null
let activityTurnStart = 0
/** @type {{entry: HTMLElement, textEl: HTMLElement, kind: string, id?: string} | null} */
let lastStreamEntry = null
let lastReasoningStreamText = ''
let sawReasoningStream = false
let sawTextStream = false
let liveClockTimer = null
let turnNumber = 0
/** @type {{number: number, startedAt: number, root: HTMLElement, divider: HTMLElement, durationEl: HTMLElement, stepCount: number, totalMs: number | null, done: boolean} | null} */
let currentTurn = null
let lastAgentTurn = null
/** @type {{index: number, block: HTMLElement, head: HTMLElement, titleEl: HTMLElement, metaEl: HTMLElement, durationEl: HTMLElement, bodyEl: HTMLElement, startedAt: number, modelStartedAt: number, modelMs?: number, liveMs: number, open: boolean, collapsed: boolean, finish?: string, totalMs?: number} | null} */
let currentStep = null
/** Completed step durations for the current turn (ms), rendered in the footer. */
let lastStepDurations = []
/** Live footer chip element, updated without rebuilding the footer each tick. */
let footerLiveEl = null
/** In-flight tool activity rows by call id. */
const toolRows = new Map()
/** Streamed tool-call rows keyed by call id, reused when the call commits. */
const streamToolEntries = new Map()
/** Browser-command activity rows keyed by call id, reused if the tool call lands late. */
const browserRows = new Map()

const $ = id => document.getElementById(id)

const els = {
  app: document.querySelector('.app'),
  input: $('input'),
  send: $('send'),
  stop: $('stop'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  activeTab: $('active-tab'),
  activity: $('activity'),
  activityDot: $('activity-dot'),
  activityPhase: $('activity-phase'),
  activityLatest: $('activity-latest'),
  activityLog: $('activity-log'),
  activityEmpty: $('activity-empty'),
  activityTimer: $('activity-timer'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerAction: $('banner-action'),
  sessionInfo: $('session-info'),
  timing: $('timing'),
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
  settingHitboxes: $('setting-hitboxes'),
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
  history: $('history'),
  historyModal: $('history-modal'),
  historyClose: $('history-close'),
  historySearch: $('history-search'),
  historyList: $('history-list'),
  historyCurrent: $('history-current'),
  historyCurrentTitle: $('history-current-title'),
  historyEmpty: $('history-empty'),
  composerModel: $('composer-model'),
  composerModelName: $('composer-model-name'),
  composerModelEffort: $('composer-model-effort'),
  composerModelContext: $('composer-model-context'),
  composerContextProgress: $('composer-context-progress'),
  composerContextUsage: $('composer-context-usage'),
  composerContextPercent: $('composer-context-percent'),
  modelMenu: $('model-menu'),
  modelMenuList: $('model-menu-list'),
  modelSearch: $('model-search'),
  mic: $('mic'),
  imageChips: $('image-chips'),
  messageQueue: $('message-queue'),
  promptRail: $('prompt-rail'),
  promptRailList: $('prompt-rail-list'),
  settingsStatus: $('settings-status'),
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
  els.settingHitboxes.checked = settings.showHitboxes !== false
}

function setEffortSelection(value) {
  settingsDraftEffort = EFFORT_LABELS[value] ? value : 'auto'
  for (const button of els.settingEffort.querySelectorAll('[data-effort]')) {
    const selected = button.dataset.effort === settingsDraftEffort
    button.classList.toggle('active', selected)
    button.setAttribute('aria-pressed', String(selected))
  }
}

function shortModelName(model) {
  const raw = model?.name || model?.id?.split('/').pop() || 'Select model'
  const withoutPath = raw.includes('/') ? raw.split('/').pop() : raw
  return withoutPath.replace(/^[^:]+:\s*/u, '') || withoutPath
}

function isAgentModel(model) {
  return model?.imageInput !== false && model?.tools !== false
}

function modelLimitations(model) {
  return [model?.imageInput === false ? 'text only' : '', model?.tools === false ? 'no tool calls' : ''].filter(Boolean).join(' · ')
}

function contextWindowBadge(model) {
  const tokens = Number(model?.contextWindow)
  return {
    tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    title: tokens > 0 ? `${tokens.toLocaleString('en-US')} token context window` : '',
  }
}

function renderComposerModel() {
  const model = modelsState.models.find(item => item.id === llmState.model?.id) ?? llmState.model
  const policy = llmState.reasoningEffort ?? settings.reasoningEffort ?? 'auto'
  const context = contextWindowBadge(model)
  const effortText = model?.reasoning === false ? 'no CoT' : policy === 'auto' ? 'low' : policy
  const effortTitle = model?.reasoning === false
    ? 'This model does not support reasoning'
    : `Reasoning effort: ${policy === 'auto' ? 'Auto (low from the first step)' : effortLabel(policy)}`
  const used = Number.isFinite(latestContextTokens) ? Math.max(0, latestContextTokens) : 0
  const ratio = context.tokens > 0 ? used / context.tokens : 0
  const percentage = ratio * 100
  const percentText = percentage > 0 && percentage < 0.1 ? '<0.1' : percentage.toFixed(1)
  const circumference = 2 * Math.PI * 7
  const progressRatio = Math.min(1, Math.max(0, ratio))
  els.composerModelName.textContent = shortModelName(model)
  els.composerModelName.title = model?.id || 'Select a model in Settings'
  els.composerModelEffort.textContent = model ? `· ${effortText}` : ''
  els.composerModelEffort.hidden = !model
  els.composerModelEffort.title = effortTitle
  els.composerModelEffort.classList.toggle('muted', model?.reasoning === false)
  els.composerContextProgress.style.strokeDasharray = circumference.toFixed(2)
  els.composerContextProgress.style.strokeDashoffset = (circumference * (1 - progressRatio)).toFixed(2)
  els.composerContextUsage.textContent = `${used.toLocaleString('en-US')} / ${context.tokens.toLocaleString('en-US')} tokens`
  els.composerContextPercent.textContent = `${percentText}%`
  els.composerModelContext.hidden = !context.tokens
  els.composerModelContext.setAttribute('aria-label', `${used.toLocaleString('en-US')} of ${context.tokens.toLocaleString('en-US')} tokens used, ${percentText}%`)
  els.composerModel.title = model
    ? `${model.id} · ${effortTitle}${context.title ? ` · ${context.title}` : ''}`
    : 'Choose a model in Settings'
  els.composerModel.disabled = busy
}

function closeModelMenu() {
  els.modelMenu.classList.add('hidden')
  els.composerModel.setAttribute('aria-expanded', 'false')
}

function renderModelMenu() {
  const query = els.modelSearch.value.trim().toLowerCase()
  const available = [...modelsState.models]
  if (llmState.model && !available.some(item => item.id === llmState.model.id)) available.unshift(llmState.model)
  const models = available.filter(model => !query || model.id.toLowerCase().includes(query) || model.name?.toLowerCase().includes(query))
  els.modelMenuList.replaceChildren()
  if (models.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'model-menu-empty'
    empty.textContent = query ? 'No models match your search' : connected ? 'Loading models…' : 'Connect to load models'
    els.modelMenuList.appendChild(empty)
    if (!query && connected && !modelsState.loading) void refreshModels()
    return
  }
  for (const model of models.slice(0, 80)) {
    const compatible = isAgentModel(model)
    const limitations = modelLimitations(model)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'model-menu-item'
    button.disabled = !compatible
    button.classList.toggle('unavailable', !compatible)
    button.title = compatible ? model.id : `${model.id} · ${limitations}; browser-agent models require images and tool calls`
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(model.id === llmState.model?.id))
    const copy = document.createElement('span')
    const name = document.createElement('span')
    name.textContent = shortModelName(model)
    const id = document.createElement('small')
    id.textContent = limitations ? `${model.id} · ${limitations}` : model.id
    copy.append(name, id)
    const check = document.createElement('span')
    check.textContent = model.id === llmState.model?.id ? '✓' : ''
    button.append(copy, check)
    button.addEventListener('click', () => {
      if (!compatible) return
      closeModelMenu()
      if (model.id === llmState.model?.id || busy) return
      sendLlmConfigure({
        baseUrl: llmState.baseUrl || settings.modelBaseUrl || DEFAULT_MODEL_BASE_URL,
        model: model.id,
        remember: true,
        reasoningEffort: llmState.reasoningEffort ?? settings.reasoningEffort ?? 'auto',
      })
    })
    els.modelMenuList.appendChild(button)
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function renderImageChips() {
  els.imageChips.replaceChildren()
  els.imageChips.classList.toggle('hidden', attachedImages.length === 0)
  attachedImages.forEach((image, index) => {
    const chip = document.createElement('span')
    chip.className = 'image-chip'
    const thumbnail = document.createElement('img')
    thumbnail.src = imageDataUrl(image)
    thumbnail.alt = ''
    const name = document.createElement('span')
    name.textContent = image.name
    name.title = image.name
    const size = document.createElement('small')
    size.textContent = formatFileSize(image.size)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.title = `Remove ${image.name}`
    remove.setAttribute('aria-label', `Remove ${image.name}`)
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      attachedImages.splice(index, 1)
      renderImageChips()
    })
    chip.append(thumbnail, name, size, remove)
    els.imageChips.appendChild(chip)
  })
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      if (!result.startsWith('data:') || comma < 0) reject(new Error('invalid image data'))
      else resolve(result.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('could not read image'))
    reader.readAsDataURL(file)
  })
}

async function addImages(fileList) {
  const files = [...fileList]
  let used = attachedImages.reduce((sum, image) => sum + image.size, 0)
  for (const file of files) {
    if (attachedImages.length >= MAX_IMAGES) {
      toast(`Up to ${MAX_IMAGES} images can be attached`)
      break
    }
    if (!IMAGE_MIME_TYPES.has(file.type)) {
      toast(`${file.name || 'Clipboard item'}: paste a PNG, JPEG, WebP, or GIF image`)
      continue
    }
    if (file.size > MAX_IMAGE_BYTES || used + file.size > MAX_TOTAL_IMAGE_BYTES) {
      toast(`Images are limited to ${formatFileSize(MAX_IMAGE_BYTES)} each and ${formatFileSize(MAX_TOTAL_IMAGE_BYTES)} total`)
      continue
    }
    try {
      const data = await readImage(file)
      const extension = file.type.split('/')[1]
      attachedImages.push({
        name: file.name || `pasted-image.${extension}`,
        size: file.size,
        mimeType: file.type,
        data,
      })
      used += file.size
    } catch {
      toast(`Could not read ${file.name || 'pasted image'}`)
    }
  }
  renderImageChips()
}

async function loadHistory() {
  try {
    const stored = await chrome.storage.local.get(HISTORY_KEY)
    conversationHistory = Array.isArray(stored?.[HISTORY_KEY])
      ? stored[HISTORY_KEY].filter(item => item && typeof item.html === 'string').slice(0, MAX_HISTORY)
      : []
  } catch {
    conversationHistory = []
  }
}

function persistHistory() {
  clearTimeout(historySaveTimer)
  historySaveTimer = setTimeout(() => {
    void chrome.storage.local.set({ [HISTORY_KEY]: conversationHistory }).catch(error => {
      toast(`Could not save chat history: ${errorMessage(error)}`)
    })
  }, 100)
}

function conversationTitle() {
  return els.activityLog.querySelector('.turn-prompt')?.textContent || 'Untitled chat'
}

function hasConversation() {
  return Boolean(els.activityLog.querySelector('.activity-turn'))
}

function archiveCurrentConversation() {
  if (!hasConversation()) return
  const html = [...els.activityLog.children]
    .filter(child => child !== els.activityEmpty)
    .map(child => child.outerHTML)
    .join('')
  const record = {
    id: currentConversationId,
    title: conversationTitle(),
    updatedAt: Date.now(),
    turnNumber,
    html,
  }
  conversationHistory = [record, ...conversationHistory.filter(item => item.id !== record.id)].slice(0, MAX_HISTORY)
  persistHistory()
}

function renderHistory() {
  const query = els.historySearch.value.trim().toLowerCase()
  els.historyCurrent.classList.toggle('hidden', !hasConversation() || Boolean(query))
  els.historyCurrentTitle.textContent = conversationTitle()
  for (const row of els.historyList.querySelectorAll('.history-item')) row.remove()
  const matches = conversationHistory.filter(item => item.title.toLowerCase().includes(query))
  for (const item of matches) {
    const row = document.createElement('div')
    row.className = 'history-item'
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'history-open'
    const title = document.createElement('span')
    title.textContent = item.title
    const when = document.createElement('small')
    when.textContent = new Date(item.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    open.append(title, when)
    open.addEventListener('click', () => restoreConversation(item.id))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'history-delete'
    remove.title = `Delete ${item.title}`
    remove.setAttribute('aria-label', `Delete ${item.title}`)
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      conversationHistory = conversationHistory.filter(entry => entry.id !== item.id)
      persistHistory()
      renderHistory()
    })
    row.append(open, remove)
    els.historyList.appendChild(row)
  }
  els.historyEmpty.classList.toggle('hidden', matches.length > 0 || (hasConversation() && !query))
}

function openHistory() {
  closeModelMenu()
  renderHistory()
  els.historyModal.classList.remove('hidden')
  setTimeout(() => els.historySearch.focus(), 10)
}

function closeHistory() {
  els.historyModal.classList.add('hidden')
  els.historySearch.value = ''
}

function restoreConversation(id) {
  if (busy) {
    toast('Wait for the current turn to finish')
    return
  }
  const item = conversationHistory.find(entry => entry.id === id)
  if (!item) return
  archiveCurrentConversation()
  clearChat()
  els.activityEmpty?.classList.add('hidden')
  els.activityLog.insertAdjacentHTML('beforeend', item.html)
  for (const head of els.activityLog.querySelectorAll('.step-head')) {
    head.addEventListener('click', () => {
      const block = head.closest('.activity-step')
      const collapsed = block.classList.toggle('collapsed')
      head.setAttribute('aria-expanded', String(!collapsed))
    })
  }
  for (const summary of els.activityLog.querySelectorAll('.agent-turn-summary')) {
    summary.addEventListener('click', () => {
      const collapsed = summary.closest('.agent-turn').classList.toggle('collapsed')
      summary.setAttribute('aria-expanded', String(!collapsed))
    })
  }
  lastAgentTurn = els.activityLog.querySelector('.agent-turn:last-of-type')
  turnNumber = item.turnNumber || els.activityLog.querySelectorAll('.activity-turn').length
  currentConversationId = item.id
  sessionId = ''
  sendFrame({ v: PROTOCOL_VERSION, type: 'chat.new' })
  closeHistory()
  renderPromptRail()
  scrollActivity()
}

const EFFORT_LABELS = {
  auto: 'Auto (low for every turn)',
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
    ? 'Auto: low reasoning from the first model step for every turn.'
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
  const compatibleCount = modelsState.models.filter(isAgentModel).length
  let text
  let kind = 'hint'
  if (modelsState.loading) {
    text = 'Loading OpenRouter models…'
  } else if (modelsState.error) {
    text = `Model list: ${modelsState.error}`
    kind = 'hint error'
  } else if (selected) {
    text = modelLabel(selected)
      + (selected.reasoning ? ` · effort ${effortLabel(llmState.reasoningEffort ?? 'auto')}` : ' · no reasoning')
      + (compatibleCount > 0 ? ` · ${compatibleCount} agent-compatible models loaded` : '')
  } else if (compatibleCount > 0) {
    text = `${compatibleCount} agent-compatible models loaded. Choose one above.`
  } else if (connected) {
    text = 'OpenRouter models have not been loaded. Click Refresh.'
  } else {
    text = 'Connect to the companion, then click Refresh to load models.'
  }
  els.modelStatus.textContent = text
  els.modelStatus.className = kind
  renderComposerModel()
}

function fillModelOptions() {
  const query = els.settingModel.value.trim().toLowerCase()
  const compatibleModels = modelsState.models.filter(isAgentModel)
  const matches = compatibleModels.filter(model => !query || model.id.toLowerCase().includes(query) || model.name?.toLowerCase().includes(query))
  els.modelOptions.replaceChildren()
  for (const model of matches.slice(0, 60)) {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'model-option'
    const name = document.createElement('span')
    name.textContent = model.name || model.id
    const detail = document.createElement('small')
    detail.textContent = modelLabel(model)
    option.append(name, detail)
    option.addEventListener('mousedown', event => event.preventDefault())
    option.addEventListener('click', () => {
      els.settingModel.value = model.id
      els.modelOptions.classList.add('hidden')
      renderProviderStatus()
    })
    els.modelOptions.appendChild(option)
  }
  if (matches.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'model-menu-empty'
    empty.textContent = 'No models match'
    els.modelOptions.appendChild(empty)
  }
  if (els.settingModel.value.trim().length === 0) {
    const preferred = [RECOMMENDED_MODEL_ID, settings.modelId, llmState.model?.id]
      .find(id => id && compatibleModels.some(model => model.id === id))
    if (preferred) els.settingModel.value = preferred
    else if (compatibleModels[0]) els.settingModel.value = compatibleModels[0].id
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
    setEffortSelection(llmState.reasoningEffort)
  }
  renderEffortStatus()
  if (frame.dsh?.state) dshState = frame.dsh.state
  renderProviderStatus()
  if (frame.ok === true) {
    hideBanner()
    void saveSettings()
    const name = llmState.model?.name ?? llmState.model?.id ?? 'model'
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
  setBusy(true, { stoppable: false })
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
  setEffortSelection(llmState.reasoningEffort ?? 'auto')
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

function setBusy(value, options = {}) {
  busy = value
  stopAvailable = value && options.stoppable !== false
  els.send.disabled = value && !stopAvailable
  const sendLabel = value && stopAvailable ? 'Queue message' : 'Send'
  els.send.title = sendLabel
  els.send.setAttribute('aria-label', sendLabel)
  renderComposerModel()
  updateStopButton()
  refreshStatus()
}

/** Reflect the stop affordance: visible whenever a stoppable turn is running. */
function updateStopButton() {
  if (!els.stop) return
  const visible = stopAvailable
  els.stop.classList.toggle('hidden', !visible)
  els.stop.hidden = !visible
  els.stop.disabled = stopping
  els.stop.classList.toggle('stopping', stopping)
  const label = stopping ? 'Stopping…' : 'Stop the current turn'
  els.stop.title = label
  els.stop.setAttribute('aria-label', label)
  els.stop.setAttribute('aria-busy', String(stopping))
  renderQueuedMessages()
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
    stopping = false
    steeringMessageId = null
    clearTimeout(stopTimer)
    stopTimer = null
    clearTimeout(queueDispatchTimer)
    queueDispatchTimer = null
    setBusy(false)
    void endDebuggerRun()
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

const LIVE_TICK_MS = 100

/** Monotonic clock used for every duration shown in the UI. */
function now() {
  return performance.now()
}

/** Compact duration for completed spans: 812ms / 1.4s / 1m 05s. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** Live clock with tenths of a second so running steps visibly tick. */
function formatClock(ms) {
  const value = Math.max(0, Number(ms) || 0)
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.floor((value % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
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
  requestAnimationFrame(() => {
    els.activityLog.scrollTop = els.activityLog.scrollHeight
  })
}

function renderPromptRail() {
  const prompts = [...els.activityLog.querySelectorAll('.activity-turn')]
  els.promptRail.classList.toggle('hidden', prompts.length === 0)
  els.promptRailList.replaceChildren()
  prompts.forEach((prompt, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'prompt-rail-dot'
    button.title = prompt.querySelector('.turn-prompt')?.textContent || `Message ${index + 1}`
    button.setAttribute('aria-label', button.title)
    const label = document.createElement('span')
    label.className = 'prompt-rail-label'
    label.textContent = button.title
    label.setAttribute('aria-hidden', 'true')
    button.appendChild(label)
    button.addEventListener('click', () => prompt.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    els.promptRailList.appendChild(button)
  })
  updatePromptRail()
}

function updatePromptRail() {
  const prompts = [...els.activityLog.querySelectorAll('.activity-turn')]
  const dots = [...els.promptRailList.children]
  const feedTop = els.activityLog.getBoundingClientRect().top
  let active = 0
  prompts.forEach((prompt, index) => {
    if (prompt.getBoundingClientRect().top - feedTop < els.activityLog.clientHeight * 0.4) active = index
  })
  dots.forEach((dot, index) => dot.classList.toggle('active', index === active))
}

/** True while a turn is being rendered (used by the live footer). */
function turnIsLive() {
  return currentTurn !== null
}

/** Where new activity rows go: inside the live step, else the turn, else the log. */
function activityContainer() {
  return currentStep?.bodyEl ?? currentTurn?.root ?? els.activityLog
}

function trimActivity() {
  const steps = [...els.activityLog.querySelectorAll('.activity-step')]
  for (const step of steps.slice(0, Math.max(0, steps.length - 60))) step.remove()
  const entries = [...els.activityLog.querySelectorAll('.activity-entry')]
  for (const entry of entries.slice(0, Math.max(0, entries.length - 400))) entry.remove()
}

/* ----- live ticker ------------------------------------------------- */

function startLiveClocks() {
  if (liveClockTimer !== null) return
  liveClockTimer = setInterval(refreshLiveClocks, LIVE_TICK_MS)
  refreshLiveClocks()
}

function stopLiveClocks() {
  if (liveClockTimer === null) return
  clearInterval(liveClockTimer)
  liveClockTimer = null
}

/** Tick every visible running clock: step header, tool cards, footer, activity head. */
function refreshLiveClocks() {
  const at = now()
  const stepMs = currentStep?.open ? at - currentStep.startedAt : undefined
  if (currentStep?.open && stepMs !== undefined) updateStepDuration(currentStep, stepMs)
  if (currentTurn && !currentTurn.done) currentTurn.summaryEl.textContent = `Working… · ${formatClock(at - currentTurn.startedAt)}`
  updateActivityTimer(stepMs)
  updateFooterLive(stepMs)
}

function updateStepDuration(step, ms) {
  step.liveMs = ms
  step.durationEl.textContent = formatClock(ms)
  step.durationEl.classList.add('live')
}

function updateActivityTimer(stepMs) {
  if (!els.activityTimer) return
  const show = currentStep?.open === true && Number.isFinite(stepMs)
  els.activityTimer.classList.toggle('hidden', !show)
  if (!show) {
    els.activityTimer.textContent = ''
    return
  }
  els.activityTimer.textContent = `step ${currentStep.index} · ${formatClock(stepMs)}`
}

/* ----- footer timing ------------------------------------------------- */

/**
 * Render the footer timing strip. During a turn the running step is shown
 * live; when the turn ends every step keeps its own duration plus the total.
 * @param {{steps?: number[], liveMs?: number, totalMs?: number}} [options]
 */
function renderTiming({ steps = [], liveMs, totalMs } = {}) {
  footerLiveEl = null
  if (steps.length === 0 && !Number.isFinite(liveMs) && !Number.isFinite(totalMs)) {
    els.timing.replaceChildren()
    els.timing.removeAttribute('title')
    return
  }
  els.timing.replaceChildren()
  const clock = document.createElement('span')
  clock.className = 'timing-clock'
  clock.textContent = '⏱'
  els.timing.appendChild(clock)
  steps.forEach((ms, index) => {
    const chip = document.createElement('span')
    chip.className = 'timing-step'
    chip.textContent = `s${index + 1} ${formatDuration(ms)}`
    chip.title = `Step ${index + 1}: ${formatDuration(ms)}`
    els.timing.appendChild(chip)
  })
  if (Number.isFinite(liveMs)) {
    const live = document.createElement('span')
    live.className = 'timing-live'
    live.textContent = `s${steps.length + 1} ${formatClock(liveMs)}`
    els.timing.appendChild(live)
    footerLiveEl = live
  }
  if (Number.isFinite(totalMs)) {
    const total = document.createElement('span')
    total.className = 'timing-total'
    total.textContent = `total ${formatDuration(totalMs)}`
    els.timing.appendChild(total)
  }
  if (Number.isFinite(totalMs) && steps.length > 0) {
    els.timing.title = [
      ...steps.map((ms, index) => `step ${index + 1} ${formatDuration(ms)}`),
      `total ${formatDuration(totalMs)}`,
    ].join(' · ')
  }
}

function updateFooterLive(stepMs) {
  if (!turnIsLive()) return
  if (currentStep?.open && Number.isFinite(stepMs)) {
    if (footerLiveEl !== null && footerLiveEl.isConnected) {
      footerLiveEl.textContent = `s${lastStepDurations.length + 1} ${formatClock(stepMs)}`
      return
    }
    renderTiming({ steps: lastStepDurations, liveMs: stepMs })
    return
  }
  renderTiming({ steps: lastStepDurations })
}

/* ----- turns and steps ----------------------------------------------- */

/**
 * Start rendering a new turn: divider in the timeline, fresh step list and
 * live clocks. Called when the user sends a message.
 * @param {string} text
 */
function startTurn(text, attachments = []) {
  closeStep()
  turnNumber += 1
  activityTurnStart = now()
  lastStepDurations = []
  footerLiveEl = null
  toolRows.clear()
  streamToolEntries.clear()
  browserRows.clear()
  els.activityEmpty?.classList.add('hidden')

  const divider = document.createElement('div')
  divider.className = 'activity-turn'
  const bubble = document.createElement('div')
  bubble.className = 'user-bubble'
  const label = document.createElement('span')
  label.className = 'turn-label hidden'
  label.textContent = `Turn ${turnNumber}`
  const prompt = document.createElement('span')
  prompt.className = 'turn-prompt'
  prompt.textContent = text || 'Attached images'
  prompt.title = String(text ?? '')
  bubble.append(prompt)
  if (attachments.length > 0) {
    const images = document.createElement('span')
    images.className = 'user-images'
    images.textContent = attachments.map(image => image.name).join(' · ')
    bubble.appendChild(images)
  }
  const duration = document.createElement('span')
  duration.className = 'turn-duration hidden'
  divider.append(label, bubble, duration)
  els.activityLog.appendChild(divider)
  renderPromptRail()

  const agentTurn = document.createElement('section')
  agentTurn.className = 'agent-turn running'
  const summary = document.createElement('button')
  summary.type = 'button'
  summary.className = 'agent-turn-summary'
  summary.setAttribute('aria-expanded', 'true')
  summary.textContent = 'Working…'
  summary.addEventListener('click', () => {
    const collapsed = agentTurn.classList.toggle('collapsed')
    summary.setAttribute('aria-expanded', String(!collapsed))
  })
  const steps = document.createElement('div')
  steps.className = 'agent-turn-steps'
  agentTurn.append(summary, steps)
  els.activityLog.appendChild(agentTurn)
  lastAgentTurn = agentTurn
  currentTurn = {
    number: turnNumber,
    startedAt: activityTurnStart,
    root: agentTurn,
    stepsEl: steps,
    summaryEl: summary,
    divider,
    durationEl: duration,
    stepCount: 0,
    totalMs: null,
    done: false,
  }
  renderTiming({})
  trimActivity()
  startLiveClocks()
  scrollActivity()
}

function createStepIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('class', 'step-icon')
  icon.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', '#icon-step-think')
  icon.appendChild(use)
  return icon
}

function setStepKind(step, kind) {
  step.block.dataset.kind = kind
  step.block.querySelector('.step-icon use').setAttribute('href', `#icon-step-${kind}`)
}

/**
 * Open a new step group. The step header carries the step's own live and
 * final duration, so every model step is measurable at a glance.
 * @param {Record<string, any>} frame
 */
function beginStep(frame) {
  const at = now()
  closeStep(at)
  footerLiveEl = null
  const index = Number.isFinite(frame?.step) ? frame.step : (currentTurn?.stepCount ?? 0) + 1

  const block = document.createElement('div')
  block.className = 'activity-step running'
  block.dataset.kind = 'think'
  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'step-head'
  head.setAttribute('aria-expanded', 'true')
  const caret = document.createElement('span')
  caret.className = 'step-caret'
  caret.textContent = '▾'
  const title = document.createElement('span')
  title.className = 'step-title'
  title.textContent = 'thinking'
  const meta = document.createElement('span')
  meta.className = 'step-meta'
  const duration = document.createElement('span')
  duration.className = 'step-duration live'
  duration.textContent = '0.0s'
  head.append(createStepIcon(), caret, title, meta, duration)
  const body = document.createElement('div')
  body.className = 'step-body'
  const waiting = document.createElement('div')
  waiting.className = 'thinking-wait'
  waiting.setAttribute('role', 'status')
  const ballScene = document.createElement('span')
  ballScene.className = 'thinking-ball-scene'
  ballScene.setAttribute('aria-hidden', 'true')
  const shadow = document.createElement('span')
  shadow.className = 'thinking-ball-shadow'
  const ball = document.createElement('span')
  ball.className = 'thinking-ball'
  ballScene.append(shadow, ball)
  const waitingLabel = document.createElement('span')
  waitingLabel.textContent = 'gathering thoughts'
  waiting.append(ballScene, waitingLabel)
  body.appendChild(waiting)
  block.append(head, body)

  const step = {
    index,
    block,
    head,
    titleEl: title,
    metaEl: meta,
    durationEl: duration,
    bodyEl: body,
    startedAt: at,
    modelStartedAt: at,
    modelMs: undefined,
    liveMs: 0,
    open: true,
    collapsed: false,
    finish: undefined,
  }
  head.addEventListener('click', () => {
    step.collapsed = !step.collapsed
    block.classList.toggle('collapsed', step.collapsed)
    head.setAttribute('aria-expanded', String(!step.collapsed))
    if (!step.collapsed) scrollActivity()
  })

  ;(currentTurn?.stepsEl ?? activityContainer()).appendChild(block)
  currentStep = step
  if (currentTurn) currentTurn.stepCount = Math.max(currentTurn.stepCount ?? 0, index)
  refreshLiveClocks()
  scrollActivity()
}

/** Mark the model portion of the live step as finished (tool execution follows). */
function endModelStep(outcome) {
  if (currentStep === null) return
  currentStep.modelMs = Math.max(0, now() - currentStep.modelStartedAt)
  currentStep.metaEl.textContent = `model ${formatDuration(currentStep.modelMs)}`
  if (outcome?.kind === 'abandoned') currentStep.block.classList.add('abandoned')
}

/**
 * Close the live step: freeze its total duration (model + tool round trip)
 * and add it to the footer breakdown.
 * @param {number} [at]
 */
function closeStep(at = now()) {
  const step = currentStep
  if (step === null) return null
  currentStep = null
  step.open = false
  // Finished steps collapse to their header (title + own duration); the user can
  // expand any step again by clicking it.
  step.collapsed = true
  step.block.classList.add('collapsed')
  step.head.setAttribute('aria-expanded', 'false')
  step.totalMs = Math.max(0, at - step.startedAt)
  step.block.classList.remove('running')
  step.durationEl.classList.remove('live')
  step.durationEl.textContent = formatDuration(step.totalMs)
  step.durationEl.title = [
    `step ${step.index}: ${formatDuration(step.totalMs)}`,
    Number.isFinite(step.modelMs) ? `model ${formatDuration(step.modelMs)}` : '',
    step.finish ? `finish ${step.finish}` : '',
  ].filter(Boolean).join(' · ')
  lastStepDurations.push(step.totalMs)
  renderTiming({ steps: lastStepDurations })
  footerLiveEl = null
  scrollActivity()
  return step
}

/**
 * Finish the turn: close the open step, stamp the turn divider with the total,
 * and render the final per-step + total footer.
 * @param {{totalMs?: number}} [options]
 */
function finishTurn({ totalMs } = {}) {
  const at = now()
  closeStep(at)
  const total = Number.isFinite(totalMs) ? totalMs : (currentTurn ? at - currentTurn.startedAt : undefined)
  if (currentTurn) {
    currentTurn.done = true
    currentTurn.totalMs = total
    currentTurn.divider.classList.add('done')
    currentTurn.durationEl.textContent = formatDuration(total)
    currentTurn.durationEl.title = `turn ${currentTurn.number} total`
    currentTurn.root.classList.remove('running')
    currentTurn.root.classList.add('collapsed')
    currentTurn.summaryEl.setAttribute('aria-expanded', 'false')
    const actions = currentTurn.root.querySelectorAll('.activity-entry.tool, .activity-entry.browser').length
    const failures = currentTurn.root.querySelectorAll('.activity-entry.fail').length
    const summary = actions > 0 ? `${actions} action${actions === 1 ? '' : 's'}` : `${currentTurn.stepCount} step${currentTurn.stepCount === 1 ? '' : 's'}`
    currentTurn.summaryEl.textContent = `${summary}${failures ? ` · ${failures} failed` : ''} · ${formatDuration(total)}`
    currentTurn.summaryEl.setAttribute('aria-label', `${summary}, ${formatDuration(total)}. Toggle activity details`)
  }
  renderTiming({ steps: lastStepDurations, totalMs: total })
  updateActivityTimer(undefined)
  stopLiveClocks()
  currentTurn = null
  scrollActivity()
}

/**
 * Append one activity row to the current step (or turn/log when no step is
 * open). Returns a handle that lets callers finish the row with a duration.
 * @param {string} kind
 * @param {string} label
 * @param {string} text
 * @param {{durationMs?: number, running?: boolean, latest?: string}} [options]
 */
function pushActivity(kind, label, text, options = {}) {
  if (kind === 'error' || currentTurn !== null) els.activityEmpty?.classList.add('hidden')
  activityContainer().querySelector(':scope > .thinking-wait')?.remove()
  const entry = document.createElement('div')
  entry.className = `activity-entry ${kind}${options.running ? ' running' : ''}`
  const kindEl = document.createElement('span')
  kindEl.className = 'act-kind'
  kindEl.textContent = label
  const textEl = document.createElement('span')
  textEl.className = 'activity-text'
  textEl.textContent = String(text ?? '')
  entry.append(kindEl, textEl)
  const created = { entry, kindEl, textEl, kind, durationEl: null }
  if (Number.isFinite(options.durationMs)) setEntryDuration(created, options.durationMs)
  activityContainer().appendChild(entry)
  trimActivity()
  const latest = options.latest ?? `${label}: ${text}`
  els.activityLatest.textContent = activityPreview(latest)
  els.activityLatest.title = String(latest ?? '')
  scrollActivity()
  return created
}

/** @param {{entry: HTMLElement, durationEl: HTMLElement | null}} created @param {number} ms */
function setEntryDuration(created, ms) {
  if (!Number.isFinite(ms)) return
  if (created.durationEl === null) {
    created.durationEl = document.createElement('span')
    created.durationEl.className = 'act-time'
    created.entry.appendChild(created.durationEl)
  }
  created.durationEl.textContent = formatDuration(ms)
}

/**
 * Complete a running activity row with its measured duration.
 * @param {any} created
 * @param {{text?: string, ok?: boolean, durationMs?: number}} [result]
 */
function finishActivityEntry(created, result = {}) {
  if (!created) return
  created.entry.classList.remove('running')
  if (result.ok === true) created.entry.classList.add('ok')
  if (result.ok === false) created.entry.classList.add('fail')
  if (typeof result.text === 'string') created.textEl.textContent = result.text
  if (Number.isFinite(result.durationMs)) setEntryDuration(created, result.durationMs)
}

/** Reuse the in-progress streamed tool-call row for the committed tool call. */
function takeStreamedToolEntry(id) {
  /** @type {any} */
  let entry = null
  if (typeof id === 'string' && streamToolEntries.has(id)) {
    entry = streamToolEntries.get(id)
    streamToolEntries.delete(id)
    if (lastStreamEntry === entry) lastStreamEntry = null
  } else if (lastStreamEntry !== null && lastStreamEntry.kind === 'tool') {
    if (typeof id === 'string' && lastStreamEntry.id !== id) return null
    entry = lastStreamEntry
    lastStreamEntry = null
  }
  if (entry !== null) entry.entry.classList.remove('streaming')
  return entry
}

function appendStreamActivity(kind, text) {
  if (typeof text !== 'string' || text.length === 0) return
  if (lastStreamEntry !== null && lastStreamEntry.kind === kind) {
    lastStreamEntry.textEl.textContent = truncate(lastStreamEntry.textEl.textContent + text, 40_000)
    lastStreamEntry.entry.classList.add('streaming')
  } else {
    finalizeStreamActivity()
    const label = kind === 'reasoning' ? 'thinking' : 'reply'
    const created = pushActivity(kind, label, text)
    created.kind = kind
    created.entry.classList.add('streaming')
    lastStreamEntry = created
    if (currentStep) currentStep.titleEl.textContent = kind === 'reasoning' ? 'thinking' : 'responding'
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
  for (const child of [...els.activityLog.children]) {
    if (child !== els.activityEmpty) child.remove()
  }
  els.activityEmpty?.classList.remove('hidden')
  lastStreamEntry = null
  lastReasoningStreamText = ''
  sawReasoningStream = false
  sawTextStream = false
  liveClockTimer !== null && stopLiveClocks()
  currentTurn = null
  lastAgentTurn = null
  currentStep = null
  lastStepDurations = []
  footerLiveEl = null
  toolRows.clear()
  streamToolEntries.clear()
  browserRows.clear()
  els.activityTimer?.classList.add('hidden')
  els.activityLatest.textContent = 'Waiting for a turn'
  els.activityLatest.title = ''
  latestContextTokens = 0
  renderComposerModel()
  renderPromptRail()
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

/** Compact one-line preview of a tool-call argument payload. */
function argsPreview(raw) {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  if (text.length === 0) return ''
  try {
    return truncate(JSON.stringify(JSON.parse(text)), 170)
  } catch {
    return truncate(text, 170)
  }
}

function handleActivity(frame) {
  switch (frame.kind) {
    case 'policy':
      return
    case 'model-start':
      finalizeStreamActivity()
      sawReasoningStream = false
      lastReasoningStreamText = ''
      sawTextStream = false
      setActivityPhase('Thinking…', 'busy')
      beginStep(frame)
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
      const label = toolLabel(frame.name)
      setActivityPhase(`Using ${label}…`, 'busy')
      if (currentStep) {
        currentStep.titleEl.textContent = label
        setStepKind(currentStep, toolKind(frame.name))
      }
      if (lastStreamEntry !== null && lastStreamEntry.kind === 'tool' && lastStreamEntry.id === frame.id) {
        lastStreamEntry.textEl.textContent = truncate(lastStreamEntry.textEl.textContent + (frame.argumentsDelta ?? ''), 4_000)
      } else {
        finalizeStreamActivity()
        const created = pushActivity('tool', label, frame.argumentsDelta ?? '')
        created.kind = 'tool'
        created.id = frame.id
        lastStreamEntry = created
        if (typeof frame.id === 'string') streamToolEntries.set(frame.id, created)
      }
      scrollActivity()
      return
    }
    case 'usage': {
      const tokens = Number(frame.usage?.totalTokens ?? frame.usage?.inputTokens ?? 0)
      latestContextTokens = Number.isFinite(tokens) ? Math.max(0, tokens) : 0
      renderComposerModel()
      return
    }
    case 'finish': {
      const reason = frame.reason && typeof frame.reason === 'object'
        ? (frame.reason.kind ?? JSON.stringify(frame.reason))
        : (frame.reason ?? 'finished')
      if (currentStep) {
        currentStep.finish = String(reason)
        currentStep.titleEl.title = `finish: ${reason}`
      }
      finalizeStreamActivity()
      return
    }
    case 'model-end':
      finalizeStreamActivity()
      endModelStep(frame.outcome)
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
      if (newChatOnNextConnect) newChat()
      refreshStatus()
      return
    case 'chat.status':
      handleStatus(frame)
      return
    case 'chat.activity':
      handleActivity(frame)
      if (stopping) setActivityPhase('Stopping…', 'busy')
      return
    case 'chat.assistant':
      if (typeof frame.text === 'string' && frame.text.length > 0) {
        lastAssistantText = frame.text.trim()
        if (!sawTextStream) pushActivity('text', 'reply', frame.text)
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
    case 'chat.stopping':
      handleStopping(frame)
      return
    case 'chat.stopped':
      handleStopped(frame)
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
  if (stopping && status !== 'ready' && status !== 'idle' && status !== 'error') {
    // The stop request owns the visible state until chat.stopped/chat.error lands.
    setStatus('busy', 'Stopping…')
    setActivityPhase('Stopping…', 'busy')
    return
  }
  if (status === 'ready' || status === 'idle') {
    connected = true
    if (dshState === 'unknown' || dshState === 'starting') dshState = 'ready'
    setBusy(false)
    setActivityPhase('Ready', 'online')
    finalizeStreamActivity()
    refreshStatus()
    scheduleQueuedMessage()
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
/* activity rendering                                                  */
/* ------------------------------------------------------------------ */

/** @param {string} name */
function toolLabel(name) {
  switch (name) {
    case 'browser_screenshot': return 'screenshot'
    case 'browser_click': return 'click'
    case 'browser_click_at': return 'click at'
    case 'browser_hover': return 'hover'
    case 'browser_scroll': return 'scroll'
    case 'browser_tabs': return 'tabs'
    case 'browser_switch_tab': return 'switch tab'
    case 'browser_read_text': return 'read text'
    case 'browser_find': return 'find'
    case 'browser_type': return 'type'
    case 'browser_press_key': return 'press key'
    case 'browser_navigate': return 'navigate'
    case 'browser_wait_for': return 'wait'
    case 'browser_select': return 'select'
    case 'browser_select_option': return 'select option'
    case 'browser_batch': return 'batch'
    case 'browser_clipboard': return 'clipboard'
    case 'auto': return 'current view'
    default: return String(name ?? 'tool').replace(/^browser_/, '')
  }
}

function toolKind(name) {
  if (/click/.test(name)) return 'click'
  if (/type|press_key/.test(name)) return 'type'
  if (/scroll/.test(name)) return 'scroll'
  if (/navigate|switch_tab/.test(name)) return 'open'
  if (/read|tabs/.test(name)) return 'read'
  if (/screenshot/.test(name)) return 'shot'
  return 'tool'
}

/** @param {Record<string, any>} frame */
function handleToolCall(frame) {
  logger.log('ui.tool_call', { callId: frame.callId, name: frame.name, args: truncate(frame.args, 500) }, 'debug')
  finalizeStreamActivity()
  const label = toolLabel(frame.name)
  setActivityPhase(`Using ${label}…`, 'busy')
  let streamed = takeStreamedToolEntry(frame.callId)
  let startedAtOverride
  if (streamed === null && typeof frame.callId === 'string' && browserRows.has(frame.callId)) {
    // The provider's browser.command can reach the UI before chat.tool_call;
    // adopt the row (and clock) the browser command already opened.
    const browserRow = browserRows.get(frame.callId)
    browserRows.delete(frame.callId)
    streamed = browserRow.row
    startedAtOverride = browserRow.startedAt
  }
  const row = streamed ?? pushActivity('tool', label, argsPreview(frame.args))
  row.entry.classList.add('running')
  row.textEl.textContent = argsPreview(frame.args) || 'running…'
  if (typeof frame.callId === 'string') {
    toolRows.set(frame.callId, { row, startedAt: startedAtOverride ?? now() })
  }
  if (currentStep) {
    currentStep.titleEl.textContent = label
    setStepKind(currentStep, toolKind(frame.name))
  }
  setBusy(true)
  setStatus('busy', `Using ${label}…`)
  scrollActivity()
}

/** @param {Record<string, any>} frame */
function handleToolResult(frame) {
  logger.log('ui.tool_result', { callId: frame.callId, ok: frame.ok !== false, text: truncate(frame.text, 500) }, 'debug')
  const ok = frame.ok !== false
  const at = now()
  const summary = truncate(frame.text || (ok ? 'completed' : 'failed'), 320)
  const record = typeof frame.callId === 'string' ? toolRows.get(frame.callId) : undefined
  if (record) {
    finishActivityEntry(record.row, {
      text: record.uiMs === undefined ? summary : `${summary} · ui ${formatDuration(record.uiMs)}`,
      ok,
      durationMs: at - record.startedAt,
    })
    record.row.entry.title = String(frame.text ?? '')
    toolRows.delete(frame.callId)
  } else {
    const created = pushActivity('tool', ok ? 'done' : 'failed', summary)
    finishActivityEntry(created, { ok })
  }
  if (currentStep !== null) {
    // The collapsed step header carries the latest outcome, so a finished step
    // stays readable as a one-line summary without expanding it.
    currentStep.titleEl.textContent = activityPreview(summary, 66)
    currentStep.titleEl.title = summary
  }
  setActivityPhase('Thinking…', 'busy')
  finalizeStreamActivity()
  scrollActivity()
}

/**
 * Append the turn's final answer as a highlighted block outside the step list,
 * so it stays readable after every step collapses.
 * @param {string} text
 */
function pushAnswer(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0 || value === lastAnswerText) return
  lastAnswerText = value
  els.activityEmpty?.classList.add('hidden')
  const block = document.createElement('div')
  block.className = 'activity-answer'
  const body = document.createElement('div')
  body.className = 'answer-text'
  renderMarkdown(body, value)
  block.appendChild(body)
  ;(lastAgentTurn ?? activityContainer()).appendChild(block)
  trimActivity()
  els.activityLatest.textContent = activityPreview(value)
  els.activityLatest.title = value
  scrollActivity()
  return block
}

/** Reset per-turn state and open the turn divider when a message is sent. */
function beginUserTurn(text, attachments = []) {
  lastAssistantText = ''
  lastAnswerText = ''
  sawReasoningStream = false
  sawTextStream = false
  lastReasoningStreamText = ''
  finalizeStreamActivity()
  setActivityPhase('Sending…', 'busy')
  startTurn(text, attachments)
}

/** Shared terminal cleanup for a turn: clear busy, pending stop, streaming markers, labels. */
function cleanupAfterTurn() {
  stopping = false
  clearTimeout(stopTimer)
  stopTimer = null
  setBusy(false)
  void endDebuggerRun()
  void execute('labels.clear', {}, settings).catch(() => {})
  finalizeStreamActivity()
}

/** @param {Record<string, any>} frame */
function handleDone(frame) {
  cleanupAfterTurn()
  dshState = 'ready'
  const timing = frame.timings
  const totalMs = Number.isFinite(timing?.totalMs) ? timing.totalMs : undefined
  finishTurn({ totalMs })
  const finalText = typeof frame.text === 'string' ? frame.text.trim() : ''
  if (finalText.length > 0) pushAnswer(finalText)
  setActivityPhase('Ready', 'online')
  logger.log('chat.done', {
    sessionId: frame.sessionId,
    timings: frame.timings,
    stepDurations: lastStepDurations,
    textLength: typeof frame.text === 'string' ? frame.text.length : 0,
  }, 'info')
  if (typeof frame.sessionId === 'string' && frame.sessionId.length > 0) {
    sessionId = frame.sessionId
  }
  updateFooter()
  refreshStatus()
  archiveCurrentConversation()
}

/** @param {Record<string, any>} frame */
function handleChatError(frame) {
  if (stopping) {
    // A stop can race an in-flight error; the user asked to stop, so report a stop.
    logger.log('chat.error.after_stop', { message: frame.message }, 'info')
    handleStopped({ turnId: frame.turnId, reason: 'user', message: frame.message })
    return
  }
  cleanupAfterTurn()
  const message = typeof frame.message === 'string' ? frame.message : 'Unknown companion error'
  finishTurn({})
  pushActivity('error', 'error', message)
  setActivityPhase('Error', 'error')
  logger.log('chat.error', { message, recoverable: frame.recoverable !== false }, 'error')
  setStatus('error', 'Error')
  if (/companion|not connected|script|invalid pairing|dsh/i.test(message)) {
    showBanner(message, 'Open settings', openSettings)
  }
}

/** @param {Record<string, any>} frame */
function handleStopping(frame = {}) {
  if (!busy && !stopping) return
  stopping = true
  updateStopButton()
  setStatus('busy', 'Stopping…')
  setActivityPhase('Stopping…', 'busy')
  logger.log('chat.stopping', { turnId: frame.turnId }, 'info')
}

/** @param {Record<string, any>} frame */
function handleStopped(frame = {}) {
  const wasActive = busy || stopping
  const reason = frame.reason === 'idle' ? 'idle' : 'user'
  if (frame.local === true) steeringMessageId = null
  cleanupAfterTurn()
  dshState = 'ready'
  finishTurn({})
  if (lastAgentTurn) {
    const summary = lastAgentTurn.querySelector('.agent-turn-summary')
    if (summary && !summary.textContent.includes('Stopped')) summary.textContent += ' · Stopped'
  }
  setActivityPhase('Stopped', 'idle')
  setStatus('idle', 'Stopped')
  logger.log('chat.stopped', { turnId: frame.turnId, reason, stepDurations: lastStepDurations }, 'info')
  if (wasActive) {
    if (frame.local === true) {
      toast('Stop requested — no confirmation from the companion')
    } else if (reason === 'user') {
      toast('Stopped')
    } else {
      toast('No turn was running')
    }
  }
  if (typeof frame.sessionId === 'string' && frame.sessionId.length > 0) sessionId = frame.sessionId
  updateFooter()
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

async function handleBrowserCommand(frame) {
  const command = frame.command ?? {}
  const op = String(command.op ?? '')
  const args = command.args && typeof command.args === 'object' ? command.args : {}
  const started = now()
  setActivityPhase(
    op === 'tabs.list' ? 'Listing tabs…'
      : op === 'tabs.activate' ? 'Switching tabs…'
        : op === 'places.search' ? 'Finding places…'
          : op === 'scroll' ? 'Scrolling…'
            : op === 'click' ? 'Clicking…'
              : op === 'read_text' || op === 'auto_view' ? 'Reading text…'
                : op === 'find' ? 'Finding text…'
                  : op === 'clipboard' ? 'Clipboard…'
                    : 'Capturing…',
    'busy',
  )
  // Auto-capture outcomes stay in the debug log rather than the conversation.
  const isAutoCapture = (op === 'snapshot' || op === 'auto_view') && frame.callId === 'auto'
  const toolRecord = typeof frame.callId === 'string' ? toolRows.get(frame.callId) : undefined
  const rowKey = typeof frame.callId === 'string' ? frame.callId : String(frame.id)
  const ownRow = toolRecord === undefined && !isAutoCapture
    ? pushActivity('browser', op === 'tabs.list' ? 'tabs' : op, argsPreview(JSON.stringify(args)), { running: true })
    : null
  if (ownRow !== null) browserRows.set(rowKey, { row: ownRow, startedAt: started })
  if (toolRecord !== undefined) {
    toolRecord.row.textEl.textContent = argsPreview(JSON.stringify(args)) || 'running…'
  }
  logger.log('browser.command.start', {
    commandId: frame.id,
    callId: frame.callId,
    turnId: frame.turnId,
    op,
    args,
  }, 'debug')
  if (settings.paused) {
    const error = { code: 'PAUSED', message: 'Browser access is paused in the side panel.' }
    if (ownRow !== null) {
      finishActivityEntry(ownRow, { text: error.message, ok: false, durationMs: now() - started })
      browserRows.delete(rowKey)
    } else if (!isAutoCapture) {
      pushActivity('error', 'browser', error.message)
    }
    setActivityPhase('Paused', 'paused')
    logger.log('browser.command.error', { commandId: frame.id, callId: frame.callId, op, error, durationMs: Math.round(performance.now() - started) }, 'warn')
    sendBrowserResult(frame.id, false, undefined, error)
    return
  }

  setActivity(true)
  setStatus('busy', 'Seeing the page…')
  try {
    const result = await execute(op, args, settings)
    const uiMs = now() - started
    const summary = browserActivitySummary(op, result)
    if (ownRow !== null) {
      finishActivityEntry(ownRow, { text: summary, ok: true, durationMs: uiMs })
      browserRows.delete(rowKey)
    } else if (toolRecord !== undefined) {
      toolRecord.uiMs = uiMs
      toolRecord.row.textEl.textContent = truncate(`${summary} · ui ${formatDuration(uiMs)}`, 340)
    }
    if (op === 'snapshot' && toolRecord !== undefined) showStepScreenshot(result.image)
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
      places: Array.isArray(result.places) ? result.places.length : undefined,
      placeCounts: result.counts,
      tab: result.tab ? { id: result.tab.id, title: result.tab.title, url: result.tab.url } : undefined,
      typed: result.typed,
      pressed: result.pressed,
      navigated: result.navigated,
      waited: result.waited,
      selected: result.selected,
      view: result.view,
      labelsDelta: result.labelsDelta,
      batch: result.batch,
    }, 'info')
    sendBrowserResult(frame.id, true, result)
  } catch (error) {
    const message = errorMessage(error)
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BROWSER_ERROR'
    if (ownRow !== null) {
      finishActivityEntry(ownRow, { text: `${op}: ${message}`, ok: false, durationMs: now() - started })
      browserRows.delete(rowKey)
    } else if (!isAutoCapture) {
      pushActivity('error', 'browser', `${op}: ${message}`)
    }
    setActivityPhase('Browser error', 'error')
    logger.log('browser.command.error', {
      commandId: frame.id,
      callId: frame.callId,
      turnId: frame.turnId,
      op,
      durationMs: Math.round(performance.now() - started),
      error: { code, message },
    }, 'error')
    sendBrowserResult(frame.id, false, undefined, { code, message })
  } finally {
    setActivity(false)
    if (!busy) refreshStatus()
  }
}

function browserActivitySummary(op, result) {
  if (!result || typeof result !== 'object') return op
  if (Array.isArray(result.places)) return `${result.places.length} places${result.query ? ` · ${truncate(result.query, 60)}` : ''}`
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
  if (result.roleClick) {
    const roleClick = result.roleClick
    const path = Array.isArray(roleClick.path) ? roleClick.path : []
    const description = path.map(step => `${step?.role ?? step?.tag ?? 'element'} ${step?.name ?? step?.text ?? ''}`.trim()).join(' → ')
    parts.push(`role click ${roleClick.status ?? 'result'} · ${roleClick.completed ?? path.length} step(s)${description ? ` · ${truncate(description, 80)}` : ''}`)
    if (roleClick.failure) parts.push(`failed at ${roleClick.failure.index ?? '?'} ${roleClick.failure.code ?? 'error'}`)
  }
  if (result.clicked) {
    parts.push(`click #${result.clicked.label} ${truncate(result.clicked.text || result.clicked.tag || '', 50)}`)
    parts.push(result.changed ? 'changed' : 'no visible change')
  }
  if (result.typed) {
    parts.push(`${result.typed.method} typed ${result.typed.chars} chars${result.typed.submitted ? ' · submitted' : ''}`)
    parts.push(result.changed ? 'changed' : 'no visible change')
  }
  if (result.pressed) {
    const mods = Array.isArray(result.pressed.modifiers) && result.pressed.modifiers.length > 0
      ? `${result.pressed.modifiers.join('+')}+`
      : ''
    parts.push(`pressed ${mods}${result.pressed.key}${result.pressed.trusted === false ? ' · synthetic' : ''}`)
    parts.push(result.changed ? 'changed' : 'no visible change')
  }
  if (result.navigated) {
    const action = result.navigated.history ?? 'url'
    parts.push(`${action} → ${truncate(result.navigated.toUrl || result.navigated.requestedUrl || '', 70)}`)
    if (result.navigated.timedOut) parts.push('load timed out')
    if (result.navigated.newTab) parts.push('new tab')
  }
  if (result.waited) {
    parts.push(`${result.waited.found ? 'found' : 'timed out'} after ${Math.round(result.waited.elapsedMs ?? 0)}ms`)
  }
  if (result.selected) {
    parts.push(`selected ${result.selected.chars} chars${result.selected.collapsed ? ' · collapsed' : ''}`)
    parts.push(result.changed ? 'changed' : 'no visible change')
  }
  if (result.docs) {
    parts.push(`docs ${result.docs.action ?? 'set_font'} · ${result.docs.status ?? 'unverified'}`)
    if (result.docs.fontAdded === true) parts.push('added to font list')
    if (result.docs.verifiedBy) parts.push(`verified by ${result.docs.verifiedBy}`)
    if (result.docs.removedText === true) parts.push('matched text removed')
  }
  if (result.clipboard) {
    const clip = result.clipboard
    parts.push(`clipboard ${result.action ?? ''} ${clip.target ?? 'virtual'}${Number.isFinite(clip.chars) ? ` · ${clip.chars} chars` : ''}${clip.truncated ? ` of ${clip.originalChars}` : ''}`)
    if (typeof clip.preview === 'string' && clip.preview.length > 0) parts.push(truncate(clip.preview, 60))
  }
  if (result.pasted) {
    const pasted = result.pasted
    parts.push(`pasted ${pasted.via === 'keys' ? 'system clipboard (Ctrl+V)' : `${pasted.chars ?? '?'} chars from ${pasted.via ?? 'virtual'}`}${pasted.submitted ? ' · submitted' : ''}`)
    parts.push(result.changed ? 'changed' : 'no visible change')
  }
  if (result.batch) {
    parts.push(`batch ${result.batch.executed}/${result.batch.total} · ${result.batch.succeeded ?? result.batch.executed} succeeded${result.batch.ok ? '' : ' · failed'}${result.batch.failedIndex === undefined ? '' : ` at ${result.batch.failedIndex}`}`)
  }
  if (result.view === 'compact') {
    const delta = result.labelsDelta ?? {}
    parts.push(`compact view · ${delta.count ?? 0} labels (+${delta.addedCount ?? 0}/-${delta.removedCount ?? 0})`)
  } else if (result.view === 'none') {
    parts.push('no screenshot')
  }
  if (Number.isFinite(result.labelCount)) parts.push(`${result.labelCount} labels`)
  if (Number.isFinite(result.captureMs)) parts.push(`capture ${result.captureMs}ms`)
  if (Number.isFinite(result.encodeMs)) parts.push(`encode ${result.encodeMs}ms`)
  return parts.join(' · ') || op
}

function showStepScreenshot(image) {
  const src = imageDataUrl(image)
  const container = currentStep?.bodyEl
  if (!src || !container) return
  container.querySelectorAll('.activity-screenshot').forEach(element => element.remove())
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'activity-screenshot'
  button.title = 'Open screenshot'
  button.setAttribute('aria-label', `Open screenshot ${image.width} by ${image.height}`)
  const img = document.createElement('img')
  img.src = src
  img.alt = `Screenshot captured at ${image.width} by ${image.height}`
  const caption = document.createElement('span')
  caption.textContent = `${image.width}×${image.height} · click to expand`
  button.append(img, caption)
  button.addEventListener('click', () => openImage(src))
  container.appendChild(button)
  scrollActivity()
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

function updateMicButton() {
  const supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  const active = dictation !== null
  const label = active ? 'Stop dictation' : supported ? 'Start dictation' : 'Dictation is not supported in this browser'
  els.mic.disabled = !supported
  els.mic.classList.toggle('recording', active)
  els.mic.title = label
  els.mic.setAttribute('aria-label', label)
  els.mic.setAttribute('aria-pressed', String(active))
}

function stopDictation() {
  if (dictation === null) return
  const session = dictation
  dictation = null
  try {
    session.recognition.stop()
  } catch {
    // The recognition may already have ended.
  }
  updateMicButton()
  logger.log('speech.stop', {}, 'info')
}

function dictationError(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed': return 'Microphone permission was denied'
    case 'audio-capture': return 'No microphone is available'
    case 'network': return 'The speech recognition service is unavailable'
    case 'no-speech': return 'No speech was detected'
    case 'language-not-supported': return 'This browser does not support dictation in your language'
    default: return `Dictation stopped${code ? `: ${code}` : ''}`
  }
}

function toggleDictation() {
  if (dictation !== null) {
    stopDictation()
    return
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!Recognition) {
    toast('Dictation is not supported in this browser')
    return
  }
  const recognition = new Recognition()
  const start = els.input.selectionStart ?? els.input.value.length
  const end = els.input.selectionEnd ?? start
  const rawBefore = els.input.value.slice(0, start)
  const rawAfter = els.input.value.slice(end)
  const before = rawBefore && !/\s$/u.test(rawBefore) ? `${rawBefore} ` : rawBefore
  const after = rawAfter && !/^\s/u.test(rawAfter) ? ` ${rawAfter}` : rawAfter
  const session = { recognition, before, after }
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = navigator.language || 'en-US'
  recognition.onresult = event => {
    if (dictation !== session) return
    let transcript = ''
    for (let index = 0; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript
    }
    els.input.value = `${session.before}${transcript}${session.after}`
    const caret = session.before.length + transcript.length
    els.input.setSelectionRange(caret, caret)
    resizeInput()
  }
  recognition.onerror = event => {
    if (dictation !== session) return
    dictation = null
    updateMicButton()
    logger.log('speech.error', { code: event.error }, 'warn')
    toast(dictationError(event.error))
  }
  recognition.onend = () => {
    if (dictation !== session) return
    dictation = null
    updateMicButton()
    logger.log('speech.end', {}, 'info')
  }
  try {
    recognition.start()
    dictation = session
    updateMicButton()
    els.input.focus()
    logger.log('speech.start', { language: recognition.lang }, 'info')
  } catch (error) {
    dictation = null
    updateMicButton()
    toast(`Could not start dictation: ${errorMessage(error)}`)
  }
}

function resizeInput() {
  els.input.style.height = 'auto'
  els.input.style.height = `${Math.min(els.input.scrollHeight, 132)}px`
}

function queuedMessagePreview(item) {
  return item.text || item.images.map(image => image.name).join(', ') || 'Attached images'
}

function queueIcon(symbol) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('class', 'icon')
  icon.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#${symbol}`)
  icon.appendChild(use)
  return icon
}

function renderQueuedMessages() {
  const renderKey = JSON.stringify([queuedMessages.map(item => item.id), busy, stopAvailable, stopping, connected])
  if (renderKey === renderedQueueKey) return
  renderedQueueKey = renderKey
  els.messageQueue.replaceChildren()
  els.messageQueue.classList.toggle('hidden', queuedMessages.length === 0)
  for (const item of queuedMessages) {
    const preview = queuedMessagePreview(item)
    const row = document.createElement('div')
    row.className = 'queued-message'
    row.dataset.queueId = item.id

    const steer = document.createElement('button')
    steer.type = 'button'
    steer.className = 'queued-message-steer'
    steer.disabled = stopping || !connected || (busy && !stopAvailable)
    steer.title = busy ? 'Stop the current turn and steer this message' : 'Send queued message'
    steer.setAttribute('aria-label', `${busy ? 'Steer' : 'Send'} queued message: ${preview}`)
    steer.appendChild(queueIcon('icon-arrow-up'))
    steer.addEventListener('click', () => steerQueuedMessage(item.id))

    const body = document.createElement('div')
    body.className = 'queued-message-body'
    body.title = preview
    const grip = document.createElement('span')
    grip.className = 'queued-message-grip'
    grip.setAttribute('aria-hidden', 'true')
    const text = document.createElement('span')
    text.className = 'queued-message-preview'
    text.textContent = preview
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'queued-message-cancel'
    cancel.title = 'Remove from queue and edit'
    cancel.setAttribute('aria-label', `Edit queued message: ${preview}`)
    cancel.appendChild(queueIcon('icon-close'))
    cancel.addEventListener('click', () => restoreQueuedMessage(item.id))

    body.append(grip, text, cancel)
    row.append(steer, body)
    els.messageQueue.appendChild(row)
  }
}

function clearComposerDraft() {
  attachedImages = []
  renderImageChips()
  els.input.value = ''
  resizeInput()
}

function restoreQueuedMessage(id) {
  const item = queuedMessages.find(entry => entry.id === id)
  if (!item) return
  const images = [...item.images, ...attachedImages]
  const bytes = images.reduce((sum, image) => sum + image.size, 0)
  if (images.length > MAX_IMAGES || bytes > MAX_TOTAL_IMAGE_BYTES) {
    toast('Make room in the composer before restoring these images')
    return
  }
  queuedMessages = queuedMessages.filter(entry => entry.id !== id)
  if (steeringMessageId === id) steeringMessageId = null
  const existing = els.input.value
  els.input.value = item.text && existing.trim() ? `${item.text}\n\n${existing}` : item.text || existing
  attachedImages = images
  renderImageChips()
  renderQueuedMessages()
  resizeInput()
  els.input.focus()
  els.input.setSelectionRange(els.input.value.length, els.input.value.length)
  logger.log('chat.queue.restore', { queueId: id, remaining: queuedMessages.length }, 'info')
}

function dispatchMessage(item) {
  if (busy || stopping) return false
  if (!connected) {
    showBanner('Not connected to the companion. Start it with npm run dev and reconnect.', 'Reconnect', () => connect())
    return false
  }
  if (!llmState.model || !credentialState.configured) {
    showBanner('Enter your OpenRouter API key and select a model before asking.', 'Open settings', openSettings)
    openSettings()
    return false
  }
  clearTimeout(stopTimer)
  stopTimer = null
  clearTimeout(queueDispatchTimer)
  queueDispatchTimer = null
  const prompt = item.text || 'Review the attached image(s).'
  const images = item.images.map(image => ({ name: image.name, mimeType: image.mimeType, data: image.data }))
  const frame = {
    v: PROTOCOL_VERSION,
    type: 'chat.send',
    text: prompt,
    autoCapture: settings.autoCapture !== false,
    ...images.length > 0 ? { images } : {},
  }
  void beginDebuggerRun().catch(() => {})
  if (!sendFrame(frame)) {
    void endDebuggerRun()
    return false
  }
  logger.log('chat.send', {
    textLength: prompt.length,
    autoCapture: settings.autoCapture !== false,
    images: item.images.map(image => ({ name: image.name, size: image.size, mimeType: image.mimeType })),
    preview: truncate(item.text, 300),
  }, 'info')
  beginUserTurn(item.text, item.images)
  setBusy(true)
  setStatus('busy', 'Sending…')
  return true
}

function dispatchQueuedMessage(id) {
  if (busy || stopping || !connected) return
  const index = queuedMessages.findIndex(item => item.id === id)
  if (index < 0) return
  const [item] = queuedMessages.splice(index, 1)
  steeringMessageId = null
  renderQueuedMessages()
  if (!dispatchMessage(item)) {
    queuedMessages.splice(index, 0, item)
    renderQueuedMessages()
    return
  }
  logger.log('chat.queue.dispatch', { queueId: id, remaining: queuedMessages.length }, 'info')
}

function scheduleQueuedMessage() {
  clearTimeout(queueDispatchTimer)
  queueDispatchTimer = null
  if (busy || stopping || !connected || queuedMessages.length === 0) return
  queueDispatchTimer = setTimeout(() => {
    queueDispatchTimer = null
    if (busy || stopping || !connected) return
    dispatchQueuedMessage(steeringMessageId ?? queuedMessages[0]?.id)
  }, 0)
}

function steerQueuedMessage(id) {
  const item = queuedMessages.find(entry => entry.id === id)
  if (!item || stopping) return
  if (!busy) {
    dispatchQueuedMessage(id)
    return
  }
  if (!stopAvailable) {
    toast('Wait for the current operation to finish')
    return
  }
  steeringMessageId = id
  logger.log('chat.queue.steer', { queueId: id, preview: truncate(item.text, 300) }, 'info')
  stopTurn()
}

function sendMessage() {
  stopDictation()
  const text = els.input.value.trim()
  if (text.length === 0 && attachedImages.length === 0) return
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
    if (!stopAvailable) {
      toast('Wait for the current operation to finish')
      return
    }
    const item = {
      id: `queue-${Date.now().toString(36)}-${++queuedMessageSequence}`,
      text,
      images: attachedImages,
    }
    queuedMessages.push(item)
    clearComposerDraft()
    renderQueuedMessages()
    logger.log('chat.queue.add', {
      queueId: item.id,
      textLength: text.length,
      images: item.images.map(image => ({ name: image.name, size: image.size, mimeType: image.mimeType })),
      queued: queuedMessages.length,
    }, 'info')
    return
  }
  if (dispatchMessage({ id: '', text, images: attachedImages })) clearComposerDraft()
}

/** Ask the companion to stop the running turn; the UI waits for chat.stopping/chat.stopped. */
function stopTurn() {
  if (!busy || stopping) return
  if (!connected) {
    toast('Not connected to the companion')
    return
  }
  if (!sendFrame({ v: PROTOCOL_VERSION, type: 'chat.stop' })) return
  stopping = true
  updateStopButton()
  setStatus('busy', 'Stopping…')
  setActivityPhase('Stopping…', 'busy')
  logger.log('chat.stop.request', { sessionId }, 'info')
  clearTimeout(stopTimer)
  stopTimer = setTimeout(() => {
    stopTimer = null
    if (!stopping) return
    logger.log('chat.stop.timeout', {}, 'warn')
    if (!busy) {
      stopping = false
      updateStopButton()
      return
    }
    handleStopped({ reason: 'user', sessionId, local: true })
  }, STOP_CONFIRM_TIMEOUT_MS)
}

function newChat() {
  logger.log('chat.new', {}, 'info')
  if (busy) {
    toast('Wait for the current turn to finish')
    return
  }
  newChatOnNextConnect = !connected
  stopDictation()
  stopping = false
  clearTimeout(stopTimer)
  stopTimer = null
  archiveCurrentConversation()
  sendFrame({ v: PROTOCOL_VERSION, type: 'chat.new' })
  clearChat()
  currentConversationId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  attachedImages = []
  renderImageChips()
  sessionId = ''
  updateFooter()
  if (connected) setStatus('online', 'Connected')
}

function clearChat() {
  clearTimeout(queueDispatchTimer)
  queueDispatchTimer = null
  queuedMessages = []
  steeringMessageId = null
  renderQueuedMessages()
  toolRows.clear()
  streamToolEntries.clear()
  browserRows.clear()
  lastAssistantText = ''
  lastAnswerText = ''
  turnNumber = 0
  currentTurn = null
  lastAgentTurn = null
  currentStep = null
  lastStepDurations = []
  footerLiveEl = null
  stopLiveClocks()
  els.timing.replaceChildren()
  els.timing.removeAttribute('title')
  clearActivity()
  setActivityPhase('Ready', 'online')
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
  const reasoningEffort = settingsDraftEffort
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
    showHitboxes: els.settingHitboxes.checked,
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
  if (!settings.showHitboxes) void execute('labels.clear', {}, settings).catch(() => {})
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
els.settingModel.addEventListener('input', () => {
  fillModelOptions()
  els.modelOptions.classList.remove('hidden')
})
els.settingModel.addEventListener('focus', () => {
  els.settingModel.select()
  fillModelOptions()
  els.modelOptions.classList.remove('hidden')
})
els.settingModel.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    const first = els.modelOptions.querySelector('.model-option')
    if (first && !els.modelOptions.classList.contains('hidden')) {
      event.preventDefault()
      first.click()
    }
  }
})
els.settingEffort.addEventListener('click', event => {
  const button = event.target.closest('[data-effort]')
  if (button) setEffortSelection(button.dataset.effort)
})
els.history.addEventListener('click', openHistory)
els.historyClose.addEventListener('click', closeHistory)
els.historyCurrent.addEventListener('click', closeHistory)
els.historySearch.addEventListener('input', renderHistory)
els.historyModal.addEventListener('click', event => {
  if (event.target === els.historyModal) closeHistory()
})
els.composerModel.addEventListener('click', () => {
  const opening = els.modelMenu.classList.contains('hidden')
  if (opening) {
    els.modelSearch.value = ''
    renderModelMenu()
  }
  els.modelMenu.classList.toggle('hidden', !opening)
  els.composerModel.setAttribute('aria-expanded', String(opening))
  if (opening) setTimeout(() => els.modelSearch.focus(), 0)
})
els.modelSearch.addEventListener('input', renderModelMenu)
els.modelSearch.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault()
    els.modelMenuList.querySelector('.model-menu-item')?.click()
  }
})
els.mic.addEventListener('click', toggleDictation)
els.input.addEventListener('paste', event => {
  const files = [...(event.clipboardData?.items ?? [])]
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter(file => file && file.type.startsWith('image/'))
  if (files.length === 0) return
  event.preventDefault()
  void addImages(files)
})
els.activityLog.addEventListener('scroll', updatePromptRail, { passive: true })
document.querySelector('.topbar').addEventListener('pointerenter', () => {
  els.app.classList.add('utilities-open')
})
document.addEventListener('pointermove', event => {
  if (event.clientX < window.innerWidth - 84) els.app.classList.remove('utilities-open')
})
document.addEventListener('click', event => {
  if (!els.modelMenu.contains(event.target) && !els.composerModel.contains(event.target)) closeModelMenu()
  if (!event.target.closest('.model-field')) els.modelOptions.classList.add('hidden')
})
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

els.newChat.addEventListener('click', newChat)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (connected) newChat()
  else newChatOnNextConnect = true
})
els.stop.addEventListener('click', () => {
  steeringMessageId = null
  stopTurn()
})

for (const chip of document.querySelectorAll('#activity-empty [data-prompt]')) {
  chip.addEventListener('click', () => {
    const prompt = chip.dataset.prompt ?? ''
    if (prompt.length === 0) return
    els.input.value = prompt
    resizeInput()
    els.input.focus()
    logger.log('ui.suggestion', { prompt: truncate(prompt, 120) }, 'debug')
  })
}

els.input.addEventListener('input', event => {
  resizeInput()
  if (event.isTrusted) stopDictation()
})
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
    if (!els.modelMenu.classList.contains('hidden')) closeModelMenu()
    else if (!els.modelOptions.classList.contains('hidden')) els.modelOptions.classList.add('hidden')
    else if (!els.imageModal.classList.contains('hidden')) closeImage()
    else if (!els.historyModal.classList.contains('hidden')) closeHistory()
    else if (!els.logModal.classList.contains('hidden')) closeLogModal()
    else if (!els.settingsModal.classList.contains('hidden')) closeSettings()
  }
})

window.addEventListener('beforeunload', () => {
  stopDictation()
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
  await loadHistory()
  populateSettings()
  setEffortSelection(settings.reasoningEffort ?? 'auto')
  renderComposerModel()
  renderImageChips()
  updateMicButton()
  logger.log('settings.loaded', {
    hasToken: settings.token.length > 0,
    bridgeUrl: settings.bridgeUrl,
    captureWidth: settings.captureWidth,
    quality: settings.quality,
    autoCapture: settings.autoCapture,
    paused: settings.paused,
  }, 'debug')
  logger.setContext(clientContext())
  await refreshActiveTab()
  updateFooter()
  setStatus('offline', 'Connecting…')
  if (!settings.token) openSettings()
  connect()
  logger.log('app.boot.ready', {}, 'info')
}

void boot()