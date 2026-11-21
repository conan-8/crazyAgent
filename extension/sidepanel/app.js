/**
 * crazyAgent side panel: chat UI, bridge client, and browser-command executor.
 *
 * The panel owns the WebSocket to the local companion. It renders model text
 * and tool activity, executes browser commands from the DSH provider, and
 * attaches a fresh DOM/text or screenshot view to each user turn.
 */

import { DEFAULT_SETTINGS, execute, testCapture, imageDataUrl, beginDebuggerRun, endDebuggerRun, cleanImageFor, displayImageField } from './browser.js'
import { foreignPrompt, helpNotice, confirmNotice, isBusyRefusal, runningTurnPrompt } from './remote-turn.js'
import { textStreamDeltaAction, hasLeakedReplyRow, removeLeakedReplyRows } from './leaked-markup.js'
import { ClientLogger } from './logger.js'
import { renderMarkdown } from './markdown.js'
import { createPlanPanelModel, renderPlanPanel } from './plan-panel.js'
import { watchNotice, watchNoticeFromOpen, renderWatchRow, renderWatchCard, watchIsActionable } from './watch-row.js'
import { PROTOCOL_VERSION, truncate, errorMessage, formatBytes } from './protocol.js'
import { matchSlashCommands, nextSlashIndex, resolveSlashCommand, slashQuery } from './slash.js'
import { completedUpdateNotice, settingsUpdateDetails, updateNotice } from './update-notice.js'
import { formatCompactTokenCount, lifetimeUsageSegments, normalizeLifetimeUsage } from './usage-meter.js'
import { DIARY_CONTENT_MAX_CHARS, filterDiaryEntries, formatDiaryAppliedText, formatDiaryHeaderPill, mergeDiaryAppliedEntries, normalizeDiarySnapshot, normalizeDiarySuggestions, parseSitesInput, siteFromTabUrl } from './diary-panel.js'
import { createInteractiveAuraState, createSpeechAuraState, estimateCaretFocusX, measureAudioFrame, stepInteractiveAura, stepSpeechAura, transcriptImpulse } from './speech-aura.js'
import { browserErrorSummary, browserResultSummary, browserRunningText, chatErrorSummary, reasoningActivityText, toolResultSummary, toolRunningText } from './activity-presenter.js'

const SETTINGS_KEY = 'crazyagent.settings'
const EXECUTOR_CLAIM_TIMEOUT_MS = 15_000
const DISCLAIMER_KEY = 'crazyagent.disclaimerPending'
const UPDATE_NOTICE_PREFS_KEY = 'crazyagent.updateNoticePrefs'
const RECONNECT_MS = 2_500
const STOP_CONFIRM_TIMEOUT_MS = 15_000
const DEFAULT_MODEL_BASE_URL = 'https://openrouter.ai/api/v1'
const RECOMMENDED_MODEL_ID = 'deepseek/deepseek-v4.1-flash-1017'
const HISTORY_KEY = 'crazyagent.history'
const MAX_HISTORY = 12
const MAX_RECENT_SESSIONS = 3
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 5_000_000
const MAX_TOTAL_IMAGE_BYTES = 12_000_000
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
let settingsDraftEffort = 'medium'
let conversationHistory = []
let currentConversationId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let newChatOnNextConnect = true
let newChatDraft = false
let historySaveTimer = null
let conversationStopped = false
let attachedImages = []
/**
 * The companion-owned marathon switch, mirrored from marathon.state /
 * chat.hello. The chip renders ONLY from this state — never an optimistic
 * local flip (MARATHON-PLAN.md §3.5).
 * @type {{enabled: boolean, sessionId: string | null, since: string | null, origin: string | null, plan: Record<string, any> | null, watcher: {active: boolean, checks: number, lastCheckAt: string | null, lastVerdict: string | null}}}
 */
let marathonState = { enabled: false, sessionId: null, since: null, origin: null, plan: null, watcher: { active: false, checks: 0, lastCheckAt: null, lastVerdict: null } }
/** The open watch alert mirrored from chat.watch (null when none); amber chip. */
let watchAlert = null
/** @type {Array<{id: string, text: string, images: Array<{name: string, size: number, mimeType: string, data: string}>}>} */
let queuedMessages = []
let dictation = null
let queuedMessageSequence = 0
let steeringMessageId = null
/** The panel's last sent chat.send item, kept until the companion accepts or refuses it. */
let lastDispatchedItem = null
/** A phone/remote prompt that won the turn slot while our own send was in flight. */
let pendingForeignPrompt = null
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
let updateNoticePrefs = { completed: '', dismissed: '' }
let companionVersion = ''
let updateStatus = null
let lifetimeUsage = normalizeLifetimeUsage(null)
let statusKind = 'offline'
let statusLabel = 'Connecting…'
let toastTimer = null
let tabRefreshTimer = null
let lastTabSignature = ''
let currentActiveTabUrl = ''
/** @type {Record<string, any> | null} */
let currentLogStats = null
let currentLogPath = ''
let copySummaryRequested = false
/** @type {{provider: string, baseUrl: string, model: Record<string, any> | null, reasoningEffort?: string | null}} */
let llmState = { provider: 'openrouter', baseUrl: DEFAULT_MODEL_BASE_URL, model: null }
/** @type {{configured: boolean, source: string}} */
let credentialState = { configured: false, source: 'none' }
/** Companion-owned behavior settings, mirrored from chat.hello / settings.updated. */
let companionSettings = { confirmIrreversible: false, watchAutoSteer: true, diaryAutoSuggest: true }
let sentCompanionSettings = {}
let settingsStatusTimer = null
/** The open approval request shown in the confirm card, if any. */
let confirmRequest = null
/** Diary state mirrored from companion. */
let diaryState = normalizeDiarySnapshot(null)
let diarySuggestions = []
let diaryFilter = 'all'
let diaryEditorOpen = false
let diaryEditingId = null
let diaryEditingEnabled = true
let diaryEditorScope = 'global'
let diaryDeleteConfirmId = null
const DIARY_REQUEST_TIMEOUT_MS = 8_000
let companionHelloReceived = false
let diarySupported = false
let diaryBusy = false
let diaryBusyTimer = null
let diaryEditorAwaitingSave = false
let diarySuggestEditingId = null
const diarySuggestPendingIds = new Set()
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
/** The current reply stream leaked tool-call markup; drop its remaining deltas. */
let textStreamSuppressed = false
let liveClockTimer = null
let turnNumber = 0
/** @type {{number: number, startedAt: number, root: HTMLElement, divider: HTMLElement, durationEl: HTMLElement, stepCount: number, totalMs: number | null, done: boolean} | null} */
let currentTurn = null
let lastAgentTurn = null
let planTerminalPhase = null
/** A help/confirmation wait outlives the idle status frame that follows chat.done. */
let waitingPhase = null
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
  planDock: $('plan-dock'),
  activityEmpty: $('activity-empty'),
  activityTimer: $('activity-timer'),
  recentSessions: $('recent-sessions'),
  recentSessionsList: $('recent-sessions-list'),
  recentSessionsAll: $('recent-sessions-all'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerAction: $('banner-action'),
  updateNotice: $('update-notice'),
  updateNoticeText: $('update-notice-text'),
  updateNoticeDismiss: $('update-notice-dismiss'),
  sessionInfo: $('session-info'),
  timing: $('timing'),
  topbar: document.querySelector('.topbar'),
  utilitiesToggle: $('utilities-toggle'),
  newChat: $('new-chat'),
  backHome: $('back-home'),
  settings: $('settings'),
  settingsModal: $('settings-modal'),
  settingsBody: document.querySelector('#settings-modal .settings-body'),
  settingsClose: $('settings-close'),
  settingsAdvanced: $('settings-advanced'),
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
  effortHint: $('effort-hint'),
  settingWidth: $('setting-width'),
  settingQuality: $('setting-quality'),
  settingAutoCapture: $('setting-autocapture'),
  settingConfirmIrreversible: $('setting-confirm-irreversible'),
  settingWatchAutoSteer: $('setting-watch-auto-steer'),
  settingDiaryAutoSuggest: $('setting-diary-auto-suggest'),
  settingVerboseActivity: $('setting-verbose-activity'),
  settingsDebugLog: $('settings-debug-log'),
  debugLogToggle: $('debug-log-toggle'),
  settingsVersion: $('settings-version'),
  settingsUpdated: $('settings-updated'),
  usageCard: $('usage-card'),
  settingsUsageTurns: $('settings-usage-turns'),
  settingsUsageTotal: $('settings-usage-total'),
  settingsUsageBar: $('settings-usage-bar'),
  settingsUsageInput: $('settings-usage-input'),
  settingsUsageCacheRead: $('settings-usage-cache-read'),
  settingsUsageCacheWrite: $('settings-usage-cache-write'),
  settingsUsageOutput: $('settings-usage-output'),
  settingsUsageReasoningRow: $('settings-usage-reasoning-row'),
  settingsUsageReasoning: $('settings-usage-reasoning'),
  settingsUsageSince: $('settings-usage-since'),
  watchCard: $('watch-card'),
  confirmCard: $('confirm-card'),
  confirmAction: $('confirm-card-action'),
  confirmTarget: $('confirm-card-target'),
  confirmApprove: $('confirm-approve'),
  confirmDeny: $('confirm-deny'),
  diarySuggestCard: $('diary-suggest-card'),
  settingsSave: $('settings-save'),
  testCapture: $('test-capture'),
  imageModal: $('image-modal'),
  imageModalImg: $('image-modal-img'),
  imageClose: $('image-close'),
  disclaimer: $('disclaimer'),
  disclaimerDismiss: $('disclaimer-dismiss'),
  toast: $('toast'),
  diary: $('diary'),
  diaryModal: $('diary-modal'),
  diaryClose: $('diary-close'),
  diaryOfflineNote: $('diary-offline-note'),
  diarySearch: $('diary-search'),
  diaryAdd: $('diary-add'),
  diaryFilters: document.querySelectorAll('[data-diary-filter]'),
  diaryEditor: $('diary-editor'),
  diaryScopeGlobal: $('diary-scope-global'),
  diaryScopeSite: $('diary-scope-site'),
  diarySitesField: $('diary-sites-field'),
  diaryFieldSites: $('diary-field-sites'),
  diaryUseCurrentTab: $('diary-use-current-tab'),
  diaryFieldTitle: $('diary-field-title'),
  diaryFieldContent: $('diary-field-content'),
  diaryContentCount: $('diary-content-count'),
  diaryEditorError: $('diary-editor-error'),
  diaryEditorCancel: $('diary-editor-cancel'),
  diaryEditorSave: $('diary-editor-save'),
  diaryList: $('diary-list'),
  diaryEmpty: $('diary-empty'),
  diaryClearSuppressed: $('diary-clear-suppressed'),
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
  composer: $('composer'),
  composerShell: document.querySelector('.composer-shell'),
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
  slashMenu: $('slash-menu'),
  slashMenuList: $('slash-menu-list'),
  mic: $('mic'),
  imageChips: $('image-chips'),
  messageQueue: $('message-queue'),
  marathonMode: $('marathon-mode'),
  marathonModeCancel: $('marathon-mode-cancel'),
  promptRail: $('prompt-rail'),
  promptRailList: $('prompt-rail-list'),
  promptRailPopup: $('prompt-rail-popup'),
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

function isVerboseActivity() {
  return settings.verboseActivity === true
}

function applyVerboseActivityMode() {
  els.app?.classList.toggle('verbose-activity', isVerboseActivity())
  syncCompactTickerScroll(currentTurn)
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get([SETTINGS_KEY, UPDATE_NOTICE_PREFS_KEY])
    const value = stored?.[SETTINGS_KEY]
    if (value && typeof value === 'object') {
      settings = { ...DEFAULT_SETTINGS, ...value }
    }
    const prefs = stored?.[UPDATE_NOTICE_PREFS_KEY]
    if (prefs && typeof prefs === 'object') {
      updateNoticePrefs = {
        completed: typeof prefs.completed === 'string' ? prefs.completed : '',
        dismissed: typeof prefs.dismissed === 'string' ? prefs.dismissed : '',
      }
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
  const clearLegacyPause = settings.paused === true
  settings.paused = false
  applyVerboseActivityMode()
  if (clearLegacyPause) void saveSettings()
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
  if (els.settingVerboseActivity) els.settingVerboseActivity.checked = isVerboseActivity()
}

function setEffortSelection(value) {
  settingsDraftEffort = EFFORT_LABELS[value] ? value : 'auto'
  if (els.effortHint) {
    els.effortHint.textContent = settingsDraftEffort === 'auto'
      ? 'Low for actions; medium for reading and synthesis'
      : `Every turn requests ${effortLabel(settingsDraftEffort).toLowerCase()}`
  }
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
  // `med` keeps the footer compact so more of the model name fits; the tooltip
  // still spells out the full effort label.
  const effortText = model?.reasoning === false ? 'no CoT' : policy === 'medium' ? 'med' : policy
  const effortTitle = model?.reasoning === false
    ? 'This model does not support reasoning'
    : `Reasoning effort: ${effortLabel(policy)}`
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

/**
 * Close the composer model picker. `focusComposer` is set by the dismissal
 * paths (Escape, outside click, row selection) so the composer is ready for
 * typing again; toggling the picker closed from its own button keeps focus there.
 */
function closeModelMenu({ focusComposer = false } = {}) {
  const hadFocus = els.modelMenu.contains(document.activeElement)
  els.modelMenu.classList.add('hidden')
  els.composerModel.setAttribute('aria-expanded', 'false')
  if (focusComposer || hadFocus) els.input.focus({ preventScroll: true })
}

function openModelMenu() {
  closeSlashMenu()
  els.modelSearch.value = ''
  renderModelMenu()
  els.modelMenu.classList.remove('hidden')
  els.composerModel.setAttribute('aria-expanded', 'true')
  setTimeout(() => els.modelSearch.focus(), 0)
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
      closeModelMenu({ focusComposer: true })
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

/* ------------------------------------------------------------------ */
/* slash commands                                                      */
/* ------------------------------------------------------------------ */

/** Palette state: open while the composer holds a `/name` filter token. */
let slashMenuOpen = false
let slashMenuQuery = ''
/** @type {Array<{id: string, usage: string, description: string}>} */
let slashMenuMatches = []
let slashMenuIndex = 0

function closeSlashMenu() {
  if (!slashMenuOpen && els.slashMenu.classList.contains('hidden')) return
  slashMenuOpen = false
  slashMenuQuery = ''
  slashMenuMatches = []
  slashMenuIndex = 0
  els.slashMenu.classList.add('hidden')
  els.slashMenuList.replaceChildren()
  els.input.setAttribute('aria-expanded', 'false')
  els.input.removeAttribute('aria-activedescendant')
}

function updateSlashSelection() {
  const options = [...els.slashMenuList.children]
  options.forEach((option, index) => option.setAttribute('aria-selected', String(index === slashMenuIndex)))
  const selected = options[slashMenuIndex]
  if (!selected) return
  els.input.setAttribute('aria-activedescendant', selected.id)
  selected.scrollIntoView({ block: 'nearest' })
}

/** Show commands matching the current draft; hide the palette for prose. */
function renderSlashMenu() {
  const query = slashQuery(els.input.value)
  const matches = query === null ? [] : matchSlashCommands(query)
  if (matches.length === 0) {
    closeSlashMenu()
    return
  }
  if (!slashMenuOpen || slashMenuQuery !== query) slashMenuIndex = 0
  slashMenuOpen = true
  slashMenuQuery = query
  slashMenuMatches = matches
  slashMenuIndex = Math.min(slashMenuIndex, matches.length - 1)
  els.slashMenuList.replaceChildren()
  matches.forEach((command, index) => {
    const option = document.createElement('div')
    option.id = `slash-command-${command.id}`
    option.className = 'slash-command'
    option.dataset.command = command.id
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(index === slashMenuIndex))
    const name = document.createElement('span')
    name.className = 'slash-command-name'
    name.textContent = command.usage
    const description = document.createElement('span')
    description.className = 'slash-command-description'
    description.textContent = command.description
    option.append(name, description)
    // Keep the textarea focused so the click never races the blur handler, and
    // keep the click from bubbling to the outside-click closers after the
    // palette has already detached this option.
    option.addEventListener('pointerdown', event => event.preventDefault())
    option.addEventListener('click', event => {
      event.stopPropagation()
      executeSlashCommand(command)
    })
    els.slashMenuList.appendChild(option)
  })
  els.slashMenu.classList.remove('hidden')
  els.input.setAttribute('aria-expanded', 'true')
  updateSlashSelection()
}

function moveSlashSelection(delta) {
  if (!slashMenuOpen || slashMenuMatches.length === 0) return
  slashMenuIndex = nextSlashIndex(slashMenuIndex, slashMenuMatches.length, delta)
  updateSlashSelection()
}

/** Drop the typed command without touching attachments; the command decides their fate. */
function clearSlashDraft() {
  els.input.value = ''
  resizeInput()
}

/** Render the marathon chip strictly from the companion's state (§3.5). */
function renderMarathonChip() {
  els.marathonMode.classList.toggle('hidden', !marathonState.enabled)
  els.marathonMode.classList.toggle('alert', watchAlert !== null)
  els.input.placeholder = marathonState.enabled ? 'Describe a long task to plan and complete…' : 'Ask or tell me what to do…'
  const copy = els.marathonMode.querySelector('.marathon-mode-copy')
  if (!copy) return
  if (!marathonState.enabled) {
    copy.textContent = 'Every turn uses a live checklist'
    return
  }
  if (watchAlert !== null) {
    copy.textContent = 'May be stuck — review the alert'
    return
  }
  const watcher = marathonState.watcher
  if (watcher.active) copy.textContent = 'Watching this turn'
  else if (watcher.checks > 0 && watcher.lastCheckAt) copy.textContent = `Checked ${watchCheckedAgo(watcher.lastCheckAt)}`
  else copy.textContent = 'Every turn uses a live checklist'
}

/** "3m ago" style relative label for the last deterministic watch check. */
function watchCheckedAgo(iso) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 'recently'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/**
 * Mirror one authoritative marathon.state (or the chat.hello copy). Malformed
 * frames fail closed to off rather than guessing a state.
 * @param {unknown} value
 */
function applyMarathonState(value) {
  const frame = value && typeof value === 'object' ? value : {}
  const watcher = frame.watcher && typeof frame.watcher === 'object' ? frame.watcher : {}
  marathonState = {
    enabled: frame.enabled === true,
    sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : null,
    since: typeof frame.since === 'string' ? frame.since : null,
    origin: typeof frame.origin === 'string' ? frame.origin : null,
    plan: frame.plan && typeof frame.plan === 'object' ? frame.plan : null,
    watcher: {
      active: watcher.active === true,
      checks: Number.isSafeInteger(watcher.checks) && watcher.checks >= 0 ? watcher.checks : 0,
      lastCheckAt: typeof watcher.lastCheckAt === 'string' ? watcher.lastCheckAt : null,
      lastVerdict: typeof watcher.lastVerdict === 'string' ? watcher.lastVerdict : null,
    },
  }
  if (!marathonState.enabled && watchAlert?.kind === 'ended-incomplete') {
    syncWatchAlert(null)
    return
  }
  renderMarathonChip()
}

function watchActionHandlers(notice) {
  if (!notice) return {}
  return {
    onStop: () => stopTurn(),
    onSteer: () => {
      els.input.focus({ preventScroll: true })
      toast(busy ? 'Type a steer message and send — it replaces the running turn' : 'Type a message and send')
    },
    onDismiss: () => {
      if (!connected) {
        toast('Not connected to the companion')
        return
      }
      if (sendFrame({ v: PROTOCOL_VERSION, type: 'marathon.watch.ack', id: notice.id })) {
        logger.log('ui.watch.ack', { id: notice.id, kind: notice.kind }, 'info')
      }
    },
  }
}

/** Keep the pinned sidebar watch card and marathon chip in sync with the active alert. */
function syncWatchAlert(notice) {
  watchAlert = watchIsActionable(notice) ? notice : null
  renderWatchCard(els.watchCard, watchAlert, watchActionHandlers(watchAlert))
  renderMarathonChip()
}

/**
 * Toggle the shared switch through the companion. No optimistic flip: the
 * chip changes only when marathon.state arrives. Accepted mid-turn too — the
 * running turn keeps its modes; the next turn picks the new state up.
 */
function toggleMarathon() {
  if (!connected) {
    toast('Not connected to the companion')
    return
  }
  const enabled = !marathonState.enabled
  if (!sendFrame({ v: PROTOCOL_VERSION, type: 'marathon.set', enabled })) return
  logger.log('ui.marathon.toggle', { enabled }, 'info')
}

/**
 * A watch notice. Render/update a durable transcript row at the turn root
 * (never inside a collapsible step body) and mirror actionable alerts into the
 * pinned sidebar Watch Card above the composer; recovered/dismissed/closed
 * notices collapse the row and hide the card.
 * @param {Record<string, any>} frame
 */
function handleWatch(frame) {
  const notice = watchNotice(frame)
  if (notice === null) return
  logger.log('chat.watch', { id: notice.id, kind: notice.kind, state: notice.state, source: notice.source }, notice.state === 'open' ? 'warn' : 'info')
  let root = els.activityLog.querySelector(`.watch-row[data-watch-id="${CSS.escape(notice.id)}"]`)
  if (!root) {
    root = document.createElement('div')
    // Place on the turn root (sibling of .agent-turn-steps), never inside
    // currentStep.bodyEl, so collapsing a completed step never hides the row.
    ;(currentTurn?.root ?? els.activityLog).appendChild(root)
    enterRow(root)
  }
  renderWatchRow(root, notice, watchActionHandlers(notice))
  syncWatchAlert(watchIsActionable(notice) ? notice : null)
  if (notice.state === 'open' && notice.kind !== 'info') {
    els.activityLatest.textContent = activityPreview(`Watch: ${notice.reason}`)
    scrollActivity()
  }
  trimActivity()
}

function executeSlashCommand(command) {
  if (!command) return
  closeSlashMenu()
  clearSlashDraft()
  logger.log('ui.slash', { command: command.id }, 'info')
  if (command.id === 'new') {
    newChat()
    return
  }
  if (command.id === 'model') {
    if (busy) {
      toast('Wait for the current operation to finish')
      return
    }
    openModelMenu()
    return
  }
  if (command.id === 'marathon') toggleMarathon()
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
  updateComposerDraftState()
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
  renderRecentSessions()
}

function persistHistory(immediate = false) {
  clearTimeout(historySaveTimer)
  historySaveTimer = null
  const save = () => {
    void chrome.storage.local.set({ [HISTORY_KEY]: conversationHistory }).catch(error => {
      toast(`Could not save chat history: ${errorMessage(error)}`)
    })
  }
  if (immediate) save()
  else historySaveTimer = setTimeout(save, 100)
}

function conversationTitle() {
  return els.activityLog.querySelector('.turn-prompt')?.textContent || 'Untitled chat'
}

function hasConversation() {
  return Boolean(els.activityLog.querySelector('.activity-turn'))
}

function conversationDate(item) {
  return new Date(item.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Serialize one feed child without elements that exist only for a running animation. */
function archivableHtml(child) {
  // Leaked-markup reply rows never belong in saved history, even if one ever
  // reached the feed (the stream guard removes them; this is the backstop).
  const leaked = hasLeakedReplyRow(child)
  if (!leaked && !child.querySelector('.motion-ghost, .leaving, .gliding')) return child.outerHTML
  const copy = child.cloneNode(true)
  copy.querySelectorAll('.motion-ghost, .leaving').forEach(node => node.remove())
  // A row still gliding open is saved at its full height.
  copy.querySelectorAll('.gliding').forEach(node => {
    node.classList.remove('gliding')
    node.style.removeProperty('height')
    node.style.removeProperty('overflow')
    if (node.getAttribute('style') === '') node.removeAttribute('style')
  })
  if (leaked) removeLeakedReplyRows(copy)
  return copy.outerHTML
}

function archiveCurrentConversation({ immediate = false } = {}) {
  if (!hasConversation()) return
  const html = [...els.activityLog.children]
    .map(archivableHtml)
    .join('')
  const record = {
    id: currentConversationId,
    title: conversationTitle(),
    updatedAt: Date.now(),
    turnNumber,
    sessionId,
    stopped: conversationStopped,
    html,
  }
  conversationHistory = [record, ...conversationHistory.filter(item => item.id !== record.id)].slice(0, MAX_HISTORY)
  persistHistory(immediate)
  renderRecentSessions()
}

function renderRecentSessions() {
  const recent = conversationHistory.slice(0, MAX_RECENT_SESSIONS)
  els.recentSessions.classList.toggle('hidden', recent.length === 0)
  els.recentSessionsList.replaceChildren()
  for (const item of recent) {
    const running = busy && stopAvailable && (item.id === currentConversationId || (sessionId && item.sessionId === sessionId))
    const open = document.createElement('button')
    open.type = 'button'
    open.className = `recent-session-open${running ? ' running' : ''}`
    open.setAttribute('aria-label', `${item.title}${running ? ', running' : ''}`)
    const copy = document.createElement('span')
    copy.className = 'recent-session-copy'
    const title = document.createElement('span')
    title.className = 'recent-session-title'
    title.textContent = item.title
    title.title = item.title
    const when = document.createElement('small')
    when.textContent = conversationDate(item)
    copy.append(title, when)
    open.appendChild(copy)
    if (running) {
      const status = document.createElement('span')
      status.className = 'recent-session-running'
      const spinner = document.createElement('span')
      spinner.className = 'recent-session-spinner'
      spinner.setAttribute('aria-hidden', 'true')
      status.append(spinner, document.createTextNode('Running'))
      open.appendChild(status)
    }
    open.addEventListener('click', () => restoreConversation(item.id))
    els.recentSessionsList.appendChild(open)
  }
}

function setNewChatDraft(value) {
  newChatDraft = value
  els.app.classList.toggle('new-chat-draft', value)
  if (value) els.activityEmpty.classList.remove('hidden')
  const waitingForSession = value && busy
  els.send.disabled = waitingForSession || (busy && !stopAvailable)
  const sendLabel = waitingForSession ? 'Wait for the running session' : busy && stopAvailable ? 'Queue message' : 'Send'
  els.send.title = sendLabel
  els.send.setAttribute('aria-label', sendLabel)
  renderPromptRail()
  renderRecentSessions()
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
    when.textContent = conversationDate(item)
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
      renderRecentSessions()
    })
    row.append(open, remove)
    els.historyList.appendChild(row)
  }
  els.historyEmpty.classList.toggle('hidden', matches.length > 0 || (hasConversation() && !query))
}

function syncUtilitiesAria() {
  const expanded = !els.app.classList.contains('chat-open') || els.app.classList.contains('utilities-open')
  els.utilitiesToggle?.setAttribute('aria-expanded', String(expanded))
}

function setUtilitiesOpen(open) {
  els.app.classList.toggle('utilities-open', open)
  syncUtilitiesAria()
}

function openHistory() {
  setUtilitiesOpen(false)
  closeModelMenu()
  renderHistory()
  els.historyModal.classList.remove('hidden')
  setTimeout(() => els.historySearch.focus(), 10)
}

function closeHistory() {
  const hadFocus = els.historyModal.contains(document.activeElement)
  els.historyModal.classList.add('hidden')
  els.historySearch.value = ''
  if (hadFocus) els.input.focus({ preventScroll: true })
}

function restoreConversation(id) {
  const item = conversationHistory.find(entry => entry.id === id)
  if (!item) return
  if (busy && newChatDraft && item.id === currentConversationId) {
    setNewChatDraft(false)
    els.activityEmpty.classList.add('hidden')
    closeHistory()
    scrollActivity()
    return
  }
  if (busy) {
    toast('Wait for the current turn to finish')
    return
  }
  archiveCurrentConversation()
  clearChat()
  if (!newChatDraft) els.activityEmpty?.classList.add('hidden')
  els.activityLog.insertAdjacentHTML('beforeend', item.html)
  // History saved before the stream guard existed may carry leaked reply rows.
  removeLeakedReplyRows(els.activityLog)
  if (!reducedMotion.matches) els.activityLog.animate({ opacity: [0, 1] }, { duration: MOTION.base, easing: MOTION.ease })
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
  conversationStopped = item.stopped === true
  if (conversationStopped) {
    for (const entry of els.activityLog.querySelectorAll('.running, .streaming')) entry.classList.remove('running', 'streaming')
    if (lastAgentTurn) {
      lastAgentTurn.classList.add('collapsed')
      const summary = lastAgentTurn.querySelector('.agent-turn-summary')
      if (summary) {
        summary.textContent = summary.textContent.includes('Stopped') ? summary.textContent : 'Stopped'
        summary.setAttribute('aria-expanded', 'false')
      }
    }
  }
  const resume = conversationStopped && typeof item.sessionId === 'string' && item.sessionId.length > 0
  sessionId = resume ? item.sessionId : ''
  sendFrame(resume
    ? { v: PROTOCOL_VERSION, type: 'chat.resume', sessionId: item.sessionId }
    : { v: PROTOCOL_VERSION, type: 'chat.new' })
  if (conversationStopped && !resume) toast('Saved model session unavailable; started a new chat')
  updateFooter()
  closeHistory()
  renderPromptRail()
  scrollActivity()
}

const EFFORT_LABELS = {
  auto: 'Auto (task-based)',
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
    ? 'Auto: low for action/navigation/reactive turns; medium for inspection/synthesis.'
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

function setUsageMetric(element, value) {
  element.textContent = formatCompactTokenCount(value)
  element.title = `${value.toLocaleString('en-US')} tokens`
}

function renderLifetimeUsage() {
  const usage = lifetimeUsage
  const segments = lifetimeUsageSegments(usage)
  els.usageCard.dataset.state = usage.turns > 0 ? 'active' : 'empty'
  els.settingsUsageTurns.textContent = `${usage.turns.toLocaleString('en-US')} ${usage.turns === 1 ? 'turn' : 'turns'}`
  els.settingsUsageTotal.textContent = formatCompactTokenCount(usage.totalTokens)
  els.settingsUsageTotal.title = `${usage.totalTokens.toLocaleString('en-US')} total agent tokens`
  setUsageMetric(els.settingsUsageInput, usage.inputTokens)
  setUsageMetric(els.settingsUsageCacheRead, usage.cacheReadTokens)
  setUsageMetric(els.settingsUsageCacheWrite, usage.cacheWriteTokens)
  setUsageMetric(els.settingsUsageOutput, usage.outputTokens)
  for (const segment of segments) {
    const element = els.settingsUsageBar.querySelector(`[data-usage-segment="${segment.key}"]`)
    element.style.width = `${segment.percent}%`
  }
  els.settingsUsageBar.setAttribute('aria-label', usage.totalTokens === 0
    ? 'No agent token usage recorded'
    : `${usage.totalTokens.toLocaleString('en-US')} total agent tokens. ${segments.map(segment => `${segment.label}: ${segment.value.toLocaleString('en-US')}`).join('. ')}`)
  els.settingsUsageReasoningRow.classList.toggle('hidden', usage.reasoningTokens === 0)
  setUsageMetric(els.settingsUsageReasoning, usage.reasoningTokens)
  if (usage.turns === 0) {
    els.settingsUsageSince.textContent = 'Your first recorded turn will appear here. Restarts and updates preserve this history.'
    els.settingsUsageSince.removeAttribute('title')
  } else {
    const since = usage.startedAt === null ? null : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(usage.startedAt))
    els.settingsUsageSince.textContent = `${since === null ? 'Saved on this device' : `Tracking since ${since}`} · watcher tokens are reported separately.`
    if (usage.updatedAt === null) els.settingsUsageSince.removeAttribute('title')
    else els.settingsUsageSince.title = `Last recorded turn: ${usage.updatedAt}`
  }
}

function applyLifetimeUsage(value) {
  lifetimeUsage = normalizeLifetimeUsage(value)
  renderLifetimeUsage()
}

function renderSettingsAbout() {
  const manifestVersion = chrome.runtime.getManifest().version
  const details = settingsUpdateDetails(updateStatus, companionVersion || manifestVersion)
  els.settingsVersion.textContent = details.version ?? 'Unavailable'
  if (details.updatedAt === null) {
    els.settingsUpdated.textContent = 'No completed update recorded'
    els.settingsUpdated.removeAttribute('title')
    return
  }
  const updatedAt = new Date(details.updatedAt)
  els.settingsUpdated.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(updatedAt)
  els.settingsUpdated.title = `Last successful update: ${details.updatedAt}`
}

function openSettings() {
  setUtilitiesOpen(false)
  els.settingsBody.scrollTo({ top: 0, behavior: 'instant' })
  populateSettings()
  renderSettingsAbout()
  renderLifetimeUsage()
  if (els.settingsAdvanced) els.settingsAdvanced.open = !settings.token || authFailed
  if (els.settingsDebugLog) els.settingsDebugLog.open = false
  if (els.settingsStatus) els.settingsStatus.textContent = ''
  clearTimeout(settingsStatusTimer)
  settingsStatusTimer = null
  els.settingApiKey.value = ''
  els.settingBaseUrl.value = llmState.baseUrl || settings.modelBaseUrl || DEFAULT_MODEL_BASE_URL
  els.settingModel.value = llmState.model?.id || settings.modelId || ''
  els.settingRememberKey.checked = true
  els.settingConfirmIrreversible.checked = companionSettings.confirmIrreversible
  if (els.settingWatchAutoSteer) els.settingWatchAutoSteer.checked = companionSettings.watchAutoSteer !== false
  if (els.settingDiaryAutoSuggest) els.settingDiaryAutoSuggest.checked = companionSettings.diaryAutoSuggest !== false
  setEffortSelection(llmState.reasoningEffort ?? 'auto')
  renderProviderStatus()
  els.settingsModal.classList.remove('hidden')
  // Lifetime usage sits at the very top of Settings. On an already-configured
  // setup, focus without scrolling so scrollTop stays 0 and the usage card is visible.
  setTimeout(() => {
    if (!settings.token || authFailed) {
      els.settingToken.focus()
    } else if (!credentialState.configured || !llmState.model) {
      els.settingApiKey.focus()
    } else {
      els.settingApiKey.focus({ preventScroll: true })
      els.settingsBody.scrollTo({ top: 0, behavior: 'instant' })
    }
  }, 10)
  if (connected && (modelsState.models.length === 0 || modelsState.baseUrl !== els.settingBaseUrl.value.trim())) {
    void refreshModels()
  } else if (modelsState.models.length > 0) {
    fillModelOptions()
  }
}

function closeSettings() {
  const hadFocus = els.settingsModal.contains(document.activeElement)
  els.settingsModal.classList.add('hidden')
  if (hadFocus) els.input.focus({ preventScroll: true })
}

/* ------------------------------------------------------------------ */
/* one-time disclaimer                                                 */
/* ------------------------------------------------------------------ */

/**
 * The background worker flags this after the extension is installed or
 * reloaded. Show it on the first panel use after that, then clear the flag so
 * ordinary panel opens stay quiet until the next reload.
 */
async function showDisclaimerIfPending() {
  let pending = false
  try {
    const stored = await chrome.storage.local.get(DISCLAIMER_KEY)
    pending = stored?.[DISCLAIMER_KEY] === true
  } catch (error) {
    logger.log('disclaimer.read_failed', { message: errorMessage(error) }, 'error')
    return false
  }
  if (!pending) return false
  // Consume the flag before showing so reopening the panel cannot repeat it.
  try {
    await chrome.storage.local.set({ [DISCLAIMER_KEY]: false })
  } catch (error) {
    logger.log('disclaimer.clear_failed', { message: errorMessage(error) }, 'error')
  }
  showDisclaimer()
  return true
}

function showDisclaimer() {
  if (els.disclaimer.open) return
  els.disclaimer.showModal()
  els.disclaimerDismiss.focus({ preventScroll: true })
  logger.log('disclaimer.shown', {}, 'info')
}

function dismissDisclaimer() {
  if (!els.disclaimer.open) return
  const hadFocus = els.disclaimer.contains(document.activeElement)
  els.disclaimer.close()
  if (hadFocus) els.input.focus({ preventScroll: true })
  logger.log('disclaimer.dismissed', {}, 'info')
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

function saveUpdateNoticePrefs() {
  void chrome.storage.local.set({ [UPDATE_NOTICE_PREFS_KEY]: updateNoticePrefs }).catch(() => {})
}

function applyUpdateStatus(status) {
  if (status !== undefined) updateStatus = status
  renderSettingsAbout()
  const notice = updateNotice(status)
  if (notice && notice.key !== updateNoticePrefs.dismissed) {
    els.updateNoticeText.textContent = notice.text
    els.updateNotice.dataset.tone = notice.tone
    els.updateNotice.dataset.noticeKey = notice.key
    els.updateNotice.classList.remove('hidden')
  } else {
    els.updateNotice.classList.add('hidden')
    els.updateNotice.dataset.noticeKey = ''
  }
  const completed = completedUpdateNotice(status)
  if (completed && completed.key !== updateNoticePrefs.completed) {
    updateNoticePrefs.completed = completed.key
    saveUpdateNoticePrefs()
    toast(completed.text)
    logger.log('update.completed', { from: status.last.from, to: status.last.to }, 'info')
  }
}

/**
 * Show the B9b approval card for a structured confirmation request. The card
 * stays until the user decides, another prompt abandons the request, or the
 * companion reports it is no longer pending.
 * @param {{action: string, target: string}} notice
 */
function showConfirmCard(notice) {
  confirmRequest = notice
  els.confirmAction.textContent = notice.action
  els.confirmTarget.textContent = `Target: ${notice.target}`
  els.confirmCard.classList.remove('hidden')
  renderDiarySuggestCard()
  els.confirmApprove.focus({ preventScroll: true })
}

function hideConfirmCard() {
  if (confirmRequest === null) return
  confirmRequest = null
  const hadFocus = els.confirmCard.contains(document.activeElement)
  els.confirmCard.classList.add('hidden')
  renderDiarySuggestCard()
  if (hadFocus) els.input.focus({ preventScroll: true })
}

/**
 * Approve/Deny answer the open confirmation through the same chat.send path as
 * an ordinary prompt; the companion writes the decision block. The local echo
 * names the decision so the transcript shows what was answered.
 * @param {'approve' | 'deny'} decision
 */
function sendConfirmation(decision) {
  if (confirmRequest === null) return
  if (busy || stopping) {
    toast('Wait for the current turn to finish before answering')
    return
  }
  const action = confirmRequest.action
  const item = {
    id: `confirm-${Date.now().toString(36)}`,
    text: '',
    confirm: decision,
    confirmAction: action,
    images: [],
  }
  if (!dispatchMessage(item)) return
  logger.log('confirm.answer', { decision, actionChars: action.length }, 'info')
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
  const waitingForSession = value && newChatDraft
  els.send.disabled = waitingForSession || (value && !stopAvailable)
  const sendLabel = waitingForSession ? 'Wait for the running session' : value && stopAvailable ? 'Queue message' : 'Send'
  els.send.title = sendLabel
  els.send.setAttribute('aria-label', sendLabel)
  renderComposerModel()
  updateStopButton()
  refreshStatus()
  renderRecentSessions()
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

/**
 * Tell the background worker this panel exists, so it stops executing browser
 * commands. Resolves once it has let go (after any command in flight) or after
 * a bound, so a stuck worker cannot keep the panel offline. The port stays
 * open for the panel's lifetime: closing it hands execution back.
 * @returns {Promise<void>}
 */
function claimExecutor() {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, EXECUTOR_CLAIM_TIMEOUT_MS)
    const attach = () => {
      let port
      try {
        port = chrome.runtime.connect({ name: 'crazyagent-panel' })
      } catch {
        clearTimeout(timer)
        resolve()
        return
      }
      port.onMessage.addListener(message => {
        if (message?.type !== 'executor.released') return
        clearTimeout(timer)
        resolve()
      })
      // The worker stopped; a new one must still see this panel. Reading
      // lastError consumes Chrome's expected "receiving end does not exist"
      // warning while the worker is restarting, rather than leaving it unchecked.
      port.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) {
          logger.log('executor.claim.disconnected', { message: chrome.runtime.lastError.message }, 'debug')
        }
        setTimeout(attach, 500)
      })
    }
    attach()
  })
}

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
  companionHelloReceived = false
  diarySupported = false
  setDiaryBusy(false)
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
    companionHelloReceived = false
    diarySupported = false
    stopping = false
    steeringMessageId = null
    lastDispatchedItem = null
    pendingForeignPrompt = null
    clearTimeout(stopTimer)
    stopTimer = null
    clearTimeout(queueDispatchTimer)
    queueDispatchTimer = null
    setBusy(false)
    abandonLiveTurnAfterDisconnect()
    void endDebuggerRun()
    setActivity(false)
    setActivityPhase('Companion offline', 'offline')
    finalizeStreamActivity()
    els.refreshModels.disabled = false
    if (modelsState.loading) modelsState = { ...modelsState, loading: false, error: 'Companion disconnected' }
    logger.log('bridge.closed', { code: event.code, reason: event.reason, wasAuthFailure: event.code === 4001 }, event.code === 4001 ? 'warn' : 'info')
    logger.setReady(false)
    setDiaryBusy(false)
    diaryEditorAwaitingSave = false
    diarySuggestPendingIds.clear()
    if (!els.diaryModal.classList.contains('hidden')) renderDiaryModal()
    if (els.settingsDebugLog?.open) {
      els.logStats.textContent = 'Companion offline. Start it with npm run dev, then reconnect to export logs.'
      els.logSignals.replaceChildren()
    }
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

/**
 * The bridge is gone, so a rendered turn can never finish: close the live step
 * and its 100 ms clock, and retire the /new draft view so a later send cannot
 * stall on "Wait for the running session to finish". Called from socket.onclose.
 */
function abandonLiveTurnAfterDisconnect() {
  if (currentTurn !== null || currentStep !== null) {
    finishTurn({})
    if (lastAgentTurn) {
      const summary = lastAgentTurn.querySelector('.agent-turn-summary')
      if (summary && !summary.textContent.includes('Disconnected')) summary.textContent += ' · Disconnected'
    }
  } else {
    stopLiveClocks()
  }
  if (newChatDraft) {
    setNewChatDraft(false)
    if (hasConversation()) els.activityEmpty?.classList.add('hidden')
  }
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
  let extensionVersion = '2.0.0-beta'
  try {
    const manifest = chrome.runtime.getManifest()
    extensionVersion = manifest.version_name || manifest.version
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

/* Shared motion: quick enough to never feel like waiting, long enough to read as movement. */
const MOTION = Object.freeze({ fast: 120, base: 180, slow: 240, ease: 'cubic-bezier(0.2, 0, 0, 1)' })
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

/**
 * Bring a just-created row in by growing its height and fading it, so the rows
 * around it glide instead of jumping. Web Animations, not a CSS animation: it
 * runs once at creation and never replays when a collapsed parent reopens or a
 * saved chat is restored.
 */
function enterRow(element, duration = MOTION.base) {
  if (reducedMotion.matches) return
  const { height } = element.getBoundingClientRect()
  element.animate(
    [
      { opacity: 0, height: '0px', minHeight: '0px', marginTop: '0px', marginBottom: '0px', transform: 'translateY(4px)', overflow: 'clip' },
      { height: `${height}px`, overflow: 'clip' },
    ],
    { duration, easing: MOTION.ease },
  )
}

/** Fade and shrink a row, then remove it. `.leaving` keeps it out of later queries and saved chats. */
function removeRow(element) {
  if (!element?.isConnected || element.classList.contains('leaving')) return
  if (reducedMotion.matches) {
    element.remove()
    return
  }
  element.classList.add('leaving')
  element.animate(
    [
      { opacity: 1, height: `${element.offsetHeight}px`, minHeight: '0px', overflow: 'clip' },
      { opacity: 0, height: '0px', minHeight: '0px', marginTop: '0px', marginBottom: '0px', overflow: 'clip' },
    ],
    { duration: MOTION.base, easing: MOTION.ease, fill: 'forwards' },
  ).finished.catch(() => {}).finally(() => element.remove())
}

const labelGhosts = new WeakMap()

/**
 * Change a label so the old words fade out as the new ones fade in. textContent
 * is updated at once; the old words live on a short-lived aria-hidden sibling.
 */
function crossfadeLabel(element, text) {
  const previous = element.textContent
  if (previous === text) return
  element.textContent = text
  if (reducedMotion.matches || !previous || !element.isConnected || element.offsetParent === null) return
  labelGhosts.get(element)?.remove()
  const ghost = element.cloneNode(false)
  ghost.removeAttribute('id')
  ghost.removeAttribute('title')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.classList.add('motion-ghost')
  ghost.textContent = previous
  ghost.style.left = `${element.offsetLeft}px`
  ghost.style.top = `${element.offsetTop}px`
  element.after(ghost)
  labelGhosts.set(element, ghost)
  ghost.animate(
    { opacity: [1, 0], transform: ['none', 'translateY(-3px)'] },
    { duration: MOTION.fast, easing: MOTION.ease, fill: 'forwards' },
  ).finished.catch(() => {}).finally(() => ghost.remove())
  element.animate(
    { opacity: [0, 1], transform: ['translateY(3px)', 'none'] },
    { duration: MOTION.base, easing: MOTION.ease },
  )
}

/** Fade the whole feed out over its replacement when a chat is cleared. */
function fadeOutFeed() {
  if (reducedMotion.matches || !els.activityLog.querySelector('.activity-turn')) return
  const feed = els.activityLog
  const ghost = feed.cloneNode(true)
  ghost.removeAttribute('id')
  ghost.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
  ghost.classList.add('feed-ghost')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  ghost.style.left = `${feed.offsetLeft}px`
  ghost.style.top = `${feed.offsetTop}px`
  ghost.style.width = `${feed.offsetWidth}px`
  ghost.style.height = `${feed.offsetHeight}px`
  feed.after(ghost)
  ghost.scrollTop = feed.scrollTop
  ghost.animate({ opacity: [1, 0] }, { duration: MOTION.base, easing: MOTION.ease, fill: 'forwards' })
    .finished.catch(() => {}).finally(() => ghost.remove())
}

let newChatFlash = null
let newChatSpin = null
let newChatConfirmTimer = null

/**
 * Localized yellow ripple and icon pulse on #new-chat so clicking it always
 * registers visually, whether clearing a chat or already on the new-chat page.
 */
function pulseNewChat() {
  const button = els.newChat
  if (!button?.isConnected) return
  if (reducedMotion.matches) {
    clearTimeout(newChatConfirmTimer)
    button.classList.add('new-chat-confirmed')
    newChatConfirmTimer = setTimeout(() => {
      button.classList.remove('new-chat-confirmed')
      newChatConfirmTimer = null
    }, MOTION.slow)
    return
  }
  const ring = document.createElement('span')
  ring.className = 'new-chat-ripple'
  ring.setAttribute('aria-hidden', 'true')
  button.prepend(ring)
  ring.animate(
    [
      { opacity: 0.95, transform: 'scale(0.85)' },
      { opacity: 0.85, transform: 'scale(1.42)', offset: 0.35 },
      { opacity: 0.42, transform: 'scale(1.8)', offset: 0.7 },
      { opacity: 0, transform: 'scale(2)' },
    ],
    { duration: 460, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
  ).finished.catch(() => {}).finally(() => ring.remove())

  newChatFlash?.cancel()
  newChatFlash = button.animate(
    [
      { backgroundColor: 'rgba(255, 195, 0, 0.3)', color: '#ffc300' },
      { backgroundColor: 'rgba(255, 195, 0, 0.22)', color: '#ffc300', offset: 0.45 },
      {},
    ],
    { duration: 420, easing: MOTION.ease },
  )

  const icon = button.querySelector('.icon')
  newChatSpin?.cancel()
  newChatSpin = icon?.animate(
    [
      { transform: 'rotate(0deg) scale(0.88)' },
      { transform: 'rotate(90deg) scale(1)' },
    ],
    { duration: MOTION.slow, easing: MOTION.ease },
  ) ?? null
}

const SCROLL_FOLLOW_MS = MOTION.slow + 40
let scrollFollowFrame = null
let scrollFollowUntil = 0
/** The running step's own scroll box, followed too while it is at its bottom. */
let scrollFollowBody = null
/**
 * The turn's final answer. While set, the feed never scrolls past the
 * answer's first line: a short answer still ends at the bottom, a long one
 * stays anchored at its top. Cleared by the next turn or the user's own scroll.
 */
let answerAnchor = null
const ANSWER_TOP_GAP = 12
const CHAT_TOP_FADE_HEIGHT = 64

function answerTopGap() {
  if (!els.app?.classList.contains('chat-open')) return ANSWER_TOP_GAP
  // When #plan-dock sits above #activity-log, the feed starts below the top fade scrim.
  const dockHeight = els.planDock && !els.planDock.hidden ? els.planDock.getBoundingClientRect().height : 0
  return Math.max(ANSWER_TOP_GAP, Math.max(0, CHAT_TOP_FADE_HEIGHT - dockHeight) + 8)
}

function stopScrollFollow() {
  if (scrollFollowFrame !== null) cancelAnimationFrame(scrollFollowFrame)
  scrollFollowFrame = null
  scrollFollowBody = null
  answerAnchor = null
}

/** Where the feed should rest: its bottom, or no lower than the answer's top. */
function feedScrollTarget() {
  const feed = els.activityLog
  const bottom = Math.max(0, feed.scrollHeight - feed.clientHeight)
  if (!answerAnchor?.isConnected) return { top: bottom, anchored: false }
  const answerTop = answerAnchor.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop
  return { top: Math.min(bottom, Math.max(0, answerTop - answerTopGap())), anchored: true }
}

function syncCompactTickerScroll(turn) {
  const steps = turn?.stepsEl
  if (!steps) return
  if (!turn || turn.done || isVerboseActivity()) {
    steps.classList.remove('ticker-scrolling')
    return
  }
  const overflowing = steps.scrollHeight > steps.clientHeight + 2
  steps.classList.toggle('ticker-scrolling', overflowing)
  if (overflowing) {
    steps.scrollTo({ top: steps.scrollHeight, behavior: reducedMotion.matches ? 'instant' : 'smooth' })
  }
}

/** Stay pinned to the bottom for as long as new rows are still growing in. */
function scrollActivity() {
  if (currentTurn && !currentTurn.done) syncCompactTickerScroll(currentTurn)
  scrollFollowUntil = performance.now() + SCROLL_FOLLOW_MS
  const body = currentStep?.bodyEl
  if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 32) scrollFollowBody = body
  if (scrollFollowFrame !== null) return
  const follow = () => {
    const feed = els.activityLog
    const target = feedScrollTarget()
    let settling = false
    if (target.anchored && !reducedMotion.matches) {
      // Glide to the answer rather than jumping; at least 1px a frame so rounding never stalls it.
      const gap = target.top - feed.scrollTop
      if (Math.abs(gap) > 1) {
        feed.scrollTo({ top: feed.scrollTop + Math.sign(gap) * Math.max(1, Math.abs(gap) * 0.2), behavior: 'instant' })
        settling = true
      } else {
        feed.scrollTo({ top: target.top, behavior: 'instant' })
      }
    } else {
      // The feed has CSS scroll-behavior:smooth; per-frame positioning must be instant.
      feed.scrollTo({ top: target.top, behavior: 'instant' })
    }
    if (scrollFollowBody?.isConnected) scrollFollowBody.scrollTop = scrollFollowBody.scrollHeight
    if (settling || performance.now() < scrollFollowUntil) {
      scrollFollowFrame = requestAnimationFrame(follow)
    } else {
      scrollFollowFrame = null
      scrollFollowBody = null
    }
  }
  scrollFollowFrame = requestAnimationFrame(follow)
}

// A wheel gesture wins over a follow still in flight.
els.activityLog.addEventListener('wheel', stopScrollFollow, { passive: true })

function renderPromptRail() {
  const prompts = [...els.activityLog.querySelectorAll('.activity-turn')]
  const chatOpen = prompts.length > 0 && !newChatDraft
  els.app.classList.toggle('chat-open', chatOpen)
  syncUtilitiesAria()
  els.backHome.classList.toggle('hidden', !chatOpen)
  els.promptRail.classList.toggle('hidden', !chatOpen)
  els.promptRailList.replaceChildren()
  els.promptRailPopup.replaceChildren()
  prompts.forEach((prompt, index) => {
    const title = prompt.querySelector('.turn-prompt')?.textContent || `Message ${index + 1}`
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'prompt-rail-dot'
    button.title = title
    button.setAttribute('aria-label', title)
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'prompt-rail-row'
    row.textContent = title
    row.title = title
    const jump = () => prompt.scrollIntoView({ behavior: 'smooth', block: 'start' })
    button.addEventListener('click', jump)
    row.addEventListener('click', jump)
    // Hovering either surface widens the dash and highlights the matching row.
    button.addEventListener('mouseenter', () => row.classList.add('hover'))
    button.addEventListener('mouseleave', () => row.classList.remove('hover'))
    row.addEventListener('mouseenter', () => button.classList.add('hover'))
    row.addEventListener('mouseleave', () => button.classList.remove('hover'))
    els.promptRailList.appendChild(button)
    els.promptRailPopup.appendChild(row)
  })
  updatePromptRail()
}

function updatePromptRail() {
  const prompts = [...els.activityLog.querySelectorAll('.activity-turn')]
  const dots = [...els.promptRailList.children]
  const rows = [...els.promptRailPopup.children]
  const feedTop = els.activityLog.getBoundingClientRect().top
  let active = 0
  prompts.forEach((prompt, index) => {
    if (prompt.getBoundingClientRect().top - feedTop < els.activityLog.clientHeight * 0.4) active = index
  })
  dots.forEach((dot, index) => dot.classList.toggle('active', index === active))
  rows.forEach((row, index) => row.classList.toggle('active', index === active))
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
function startTurn(text, attachments = [], options = {}) {
  closeStep()
  turnNumber += 1
  activityTurnStart = now()
  lastStepDurations = []
  footerLiveEl = null
  stopAllWaitCountdowns()
  toolRows.clear()
  streamToolEntries.clear()
  browserRows.clear()
  if (!newChatDraft) els.activityEmpty?.classList.add('hidden')

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
  if (options.marathon === true) {
    divider.dataset.marathon = 'true'
    const marathonBadge = document.createElement('span')
    marathonBadge.className = 'user-origin marathon-turn-badge'
    marathonBadge.textContent = 'Marathon'
    bubble.append(marathonBadge)
  }
  if (typeof options.originLabel === 'string') {
    divider.dataset.origin = options.origin ?? 'remote'
    const origin = document.createElement('span')
    origin.className = 'user-origin'
    origin.textContent = options.originLabel
    bubble.append(origin)
  }
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
  enterRow(divider)
  renderPromptRail()

  const agentTurn = document.createElement('section')
  agentTurn.className = 'agent-turn running'
  const turnHead = document.createElement('div')
  turnHead.className = 'agent-turn-head'
  const summary = document.createElement('button')
  summary.type = 'button'
  summary.className = 'agent-turn-summary'
  summary.setAttribute('aria-expanded', 'true')
  summary.textContent = 'Working…'
  summary.addEventListener('click', () => {
    const collapsed = agentTurn.classList.toggle('collapsed')
    summary.setAttribute('aria-expanded', String(!collapsed))
  })
  const diaryPill = document.createElement('span')
  diaryPill.className = 'turn-diary-pill hidden'
  diaryPill.setAttribute('role', 'status')
  turnHead.append(summary, diaryPill)
  const steps = document.createElement('div')
  steps.className = 'agent-turn-steps'
  const planModel = options.marathon === true ? createPlanPanelModel() : null
  const planRoot = options.marathon === true ? document.createElement('div') : null
  if (planRoot) {
    // M2: a carried plan renders at the start of the turn from the mirrored
    // marathon.state.plan; live plan activities then update it as usual.
    if (planModel && marathonState.plan && Array.isArray(marathonState.plan.items)) {
      planModel.update(marathonState.plan.items)
    }
    els.planDock.replaceChildren(planRoot)
    els.planDock.hidden = true
  }
  agentTurn.append(turnHead, steps)
  els.activityLog.appendChild(agentTurn)
  enterRow(agentTurn)
  lastAgentTurn = agentTurn
  currentTurn = {
    number: turnNumber,
    startedAt: activityTurnStart,
    root: agentTurn,
    stepsEl: steps,
    summaryEl: summary,
    diaryPillEl: diaryPill,
    diaryApplied: [],
    divider,
    durationEl: duration,
    planModel,
    planRoot,
    stepCount: 0,
    totalMs: null,
    done: false,
  }
  if (currentTurn.planRoot) renderTurnPlan(currentTurn)
  renderTiming({})
  trimActivity()
  startLiveClocks()
  scrollActivity()
}

function renderTurnPlan(turn) {
  if (!turn?.planModel || !turn.planRoot) return
  const state = turn.planModel.getState()
  const heightBefore = els.planDock.hidden ? 0 : els.planDock.offsetHeight
  const statusesBefore = new Map([...turn.planRoot.querySelectorAll('.plan-panel-item')].map((row, index) => [index, row.dataset.status]))
  renderPlanPanel(turn.planRoot, state, {
    onToggle() {
      turn.planModel.toggle()
      renderTurnPlan(turn)
    },
  })
  els.planDock.hidden = !state.visible
  if (reducedMotion.matches || !state.visible) return
  const heightAfter = els.planDock.offsetHeight
  if (heightBefore !== heightAfter) {
    els.planDock.animate(
      { height: [`${heightBefore}px`, `${heightAfter}px`], overflow: ['clip', 'clip'] },
      { duration: MOTION.base, easing: MOTION.ease },
    )
  }
  turn.planRoot.querySelectorAll('.plan-panel-item').forEach((row, index) => {
    const before = statusesBefore.get(index)
    if (before !== undefined && before !== row.dataset.status) {
      row.animate({ opacity: [0.35, 1] }, { duration: MOTION.slow, easing: MOTION.ease })
    }
  })
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

/** Show what the step is doing now. `settled` means the action is over and this is only its outcome. */
function setStepTitle(step, text, { settled = false } = {}) {
  crossfadeLabel(step.titleEl, text)
  step.block.classList.toggle('settled', settled)
  if (currentTurn && !currentTurn.done) syncCompactTickerScroll(currentTurn)
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
  block.className = 'activity-step running entering'
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
  title.textContent = 'Thinking…'
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
  waiting.textContent = 'gathering thoughts'
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
    if (!isVerboseActivity() && block.closest('.agent-turn.running')) return
    step.collapsed = !step.collapsed
    block.classList.toggle('collapsed', step.collapsed)
    head.setAttribute('aria-expanded', String(!step.collapsed))
    if (!step.collapsed) scrollActivity()
  })

  ;(currentTurn?.stepsEl ?? activityContainer()).appendChild(block)
  if (!isVerboseActivity() && currentTurn?.stepsEl) {
    if (!reducedMotion.matches) {
      block.animate(
        { opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0)'] },
        { duration: MOTION.slow, easing: MOTION.ease },
      )
    }
  } else {
    enterRow(block)
  }
  currentStep = step
  if (currentTurn) currentTurn.stepCount = Math.max(currentTurn.stepCount ?? 0, index)
  refreshLiveClocks()
  syncCompactTickerScroll(currentTurn)
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
  step.block.classList.remove('entering')
  step.head.setAttribute('aria-expanded', 'false')
  step.totalMs = Math.max(0, at - step.startedAt)
  step.block.classList.remove('running')
  if (!step.block.classList.contains('abandoned')) {
    if (step.titleEl.textContent === 'Responding…') step.titleEl.textContent = 'Responded'
    else if (step.titleEl.textContent === 'Thinking…') step.titleEl.textContent = 'Thought'
  }
  step.durationEl.classList.remove('live')
  step.durationEl.textContent = formatDuration(step.totalMs)
  step.durationEl.title = [
    `Step ${step.index}: ${formatDuration(step.totalMs)}`,
    Number.isFinite(step.modelMs) ? `Thinking: ${formatDuration(step.modelMs)}` : '',
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
function finishTurn({ totalMs, usage, failedCalls } = {}) {
  stopAllWaitCountdowns()
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
    currentTurn.diaryPillEl?.classList.add('hidden')
    currentTurn.stepsEl?.classList.remove('ticker-scrolling')
    currentTurn.summaryEl.setAttribute('aria-expanded', 'false')
    const actions = currentTurn.root.querySelectorAll('.activity-entry.tool, .activity-entry.browser').length
    const observedFailures = currentTurn.root.querySelectorAll('.activity-entry.fail').length
    const failures = Number.isFinite(failedCalls) ? Math.max(0, Math.round(failedCalls)) : observedFailures
    const summary = actions > 0 ? `${actions} action${actions === 1 ? '' : 's'}` : `${currentTurn.stepCount} step${currentTurn.stepCount === 1 ? '' : 's'}`
    const tokens = turnTokenText(usage)
    currentTurn.summaryEl.textContent = `${summary}${failures ? ` · ${failures} failed` : ''}${tokens ? ` · ${tokens}` : ''} · ${formatDuration(total)}`
    currentTurn.summaryEl.setAttribute('aria-label', `${summary}${tokens ? `, ${tokens}` : ''}, ${formatDuration(total)}. Toggle activity details`)
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
  if ((kind === 'error' || currentTurn !== null) && !newChatDraft) els.activityEmpty?.classList.add('hidden')
  removeRow(activityContainer().querySelector(':scope > .thinking-wait:not(.leaving)'))
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
  if (options.glide === true && !reducedMotion.matches) {
    entry.animate({ opacity: [0, 1] }, { duration: MOTION.slow, easing: MOTION.ease })
    glideStreamRow(entry, 0)
  } else {
    enterRow(entry)
  }
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
  if (typeof result.text === 'string' && result.text !== created.textEl.textContent) {
    created.textEl.textContent = result.text
    if (!reducedMotion.matches) created.textEl.animate({ opacity: [0.3, 1] }, { duration: MOTION.base, easing: MOTION.ease })
  }
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
    appendStreamText(lastStreamEntry, text)
    lastStreamEntry.entry.classList.add('streaming')
  } else {
    finalizeStreamActivity()
    const label = kind === 'reasoning' ? 'thinking' : 'reply'
    const created = pushActivity(kind, label, text, { glide: true })
    created.kind = kind
    created.entry.classList.add('streaming')
    lastStreamEntry = created
    if (currentStep) setStepTitle(currentStep, kind === 'reasoning' ? 'Thinking…' : 'Responding…')
  }
  if (kind === 'reasoning') {
    sawReasoningStream = true
    lastReasoningStreamText = truncate(lastReasoningStreamText + text, 40_000)
    const polished = reasoningActivityText(lastReasoningStreamText)
    if (lastStreamEntry !== null && polished !== lastStreamEntry.textEl.textContent) {
      lastStreamEntry.textEl.textContent = polished
    }
  }
  const latest = kind === 'reasoning' ? reasoningActivityText(lastReasoningStreamText) : text
  els.activityLatest.textContent = activityPreview(`${kind === 'reasoning' ? 'thinking' : 'assistant'}: ${latest}`)
  scrollActivity()
}

/**
 * Add streamed words to a row without re-laying out what is already there.
 * The new words fade in, and the row glides open to show them (`glideStreamRow`).
 */
function appendStreamText(created, text) {
  const { entry, textEl } = created
  const shownHeight = entry.getBoundingClientRect().height
  if (textEl.textContent.length + text.length > 40_000) {
    textEl.textContent = truncate(textEl.textContent + text, 40_000)
  } else {
    const chunk = document.createElement('span')
    chunk.className = 'stream-chunk'
    chunk.textContent = text
    textEl.appendChild(chunk)
  }
  glideStreamRow(entry, shownHeight)
}

/*
 * Streamed text arrives in bursts. Rather than showing each burst at once, a
 * row's visible height glides toward its real height: the speed follows how
 * far behind it is (a ~0.2 s catch-up), with limited acceleration so it never
 * lurches, and the feed and the step's own scroll box ride along with it,
 * trailing the stream only slightly.
 */
const GLIDE = Object.freeze({ catchUpSeconds: 0.2, minSpeed: 40, acceleration: 2600, pinSlack: 32 })
const streamGlides = new Map()
let streamGlideFrame = null
let streamGlideLast = 0

function glideStreamRow(entry, shownHeight) {
  if (reducedMotion.matches) return
  if (!streamGlides.has(entry)) {
    streamGlides.set(entry, { height: shownHeight, velocity: 0 })
    entry.classList.add('gliding')
    entry.style.height = `${shownHeight}px`
    entry.style.overflow = 'clip'
  }
  if (streamGlideFrame === null) {
    streamGlideLast = performance.now()
    streamGlideFrame = requestAnimationFrame(stepStreamGlides)
  }
}

function endStreamGlide(entry) {
  streamGlides.delete(entry)
  entry.classList.remove('gliding')
  entry.style.removeProperty('height')
  entry.style.removeProperty('overflow')
}

function stepStreamGlides(time) {
  const dt = Math.min(0.05, Math.max(0, (time - streamGlideLast) / 1000))
  streamGlideLast = time
  const feed = els.activityLog
  const feedPinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < GLIDE.pinSlack
  for (const [entry, glide] of streamGlides) {
    if (!entry.isConnected) {
      streamGlides.delete(entry)
      continue
    }
    const body = entry.closest('.step-body')
    const bodyPinned = body !== null && body.scrollHeight - body.scrollTop - body.clientHeight < GLIDE.pinSlack
    const target = entry.scrollHeight
    const gap = target - glide.height
    if (gap <= 0.5) {
      endStreamGlide(entry)
      if (bodyPinned) body.scrollTop = body.scrollHeight
      continue
    }
    const desired = Math.max(GLIDE.minSpeed, gap / GLIDE.catchUpSeconds)
    const change = GLIDE.acceleration * dt
    glide.velocity += Math.max(-change, Math.min(change, desired - glide.velocity))
    glide.height = Math.min(target, glide.height + Math.max(0, glide.velocity) * dt)
    entry.style.height = `${glide.height}px`
    if (bodyPinned) body.scrollTop = body.scrollHeight
  }
  if (feedPinned) {
    if (answerAnchor?.isConnected) scrollActivity()
    else feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' })
  }
  streamGlideFrame = streamGlides.size > 0 ? requestAnimationFrame(stepStreamGlides) : null
}

function finalizeStreamActivity() {
  for (const entry of els.activityLog.querySelectorAll('.activity-entry.streaming')) {
    entry.classList.remove('streaming')
    // Plain text again, so saved chats carry no per-chunk markup.
    const textEl = entry.querySelector('.activity-text')
    if (textEl?.querySelector('.stream-chunk')) textEl.textContent = textEl.textContent
  }
  lastStreamEntry = null
  // The reply stream ended; a later stream starts with a clean guard.
  textStreamSuppressed = false
}

function clearActivity() {
  fadeOutFeed()
  for (const child of [...els.activityLog.children]) {
    if (child !== els.activityEmpty) child.remove()
  }
  els.planDock.replaceChildren()
  els.planDock.hidden = true
  els.activityEmpty?.classList.remove('hidden')
  answerAnchor = null
  lastStreamEntry = null
  lastReasoningStreamText = ''
  sawReasoningStream = false
  sawTextStream = false
  liveClockTimer !== null && stopLiveClocks()
  currentTurn = null
  lastAgentTurn = null
  planTerminalPhase = null
  currentStep = null
  lastStepDurations = []
  footerLiveEl = null
  stopAllWaitCountdowns()
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

/** Compact per-turn token count for the turn divider; '' when absent. */
function turnTokenText(usage) {
  if (!usage || typeof usage !== 'object') return ''
  let value = Number(usage.totalTokens)
  if (!Number.isFinite(value) || value <= 0) {
    const input = Number(usage.inputTokens)
    const output = Number(usage.outputTokens)
    value = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
  }
  return Number.isFinite(value) && value > 0 ? `${Math.round(value).toLocaleString('en-US')} tok` : ''
}

function formatTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return ''
  const parts = []
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (Number.isFinite(usage[key]) && usage[key] !== 0) {
      parts.push(`${key.replace(/Tokens$/u, '').toLowerCase()} ${usage[key]}`)
    }
  }
  return parts.join(' · ')
}

function handleActivity(frame) {
  switch (frame.kind) {
    case 'plan': {
      const turn = currentTurn
      const update = turn?.planModel?.update(frame.items)
      if (!update?.accepted) return
      renderTurnPlan(turn)
      const state = update.state
      const latest = frame.awaitingUser === true
        ? 'Plan is waiting for your input'
        : state.current ? `Plan: ${state.current.content}` : `Plan: ${state.done}/${state.total} done`
      setActivityPhase(frame.awaitingUser === true ? 'Waiting for you…' : `Plan ${state.done}/${state.total}`, 'busy', latest)
      return
    }
    case 'policy':
      return
    case 'diary-applied':
      pushDiaryAppliedRow(frame)
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
    case 'text': {
      // A dead step can stream its tool call as literal DSML markup. Match on
      // the accumulated reply so split tags are caught too, and never let the
      // markup render: drop the row at once (no fade-out that shows it) and
      // discard the rest of this stream. The ending still arrives as a
      // BLOCKED answer or a chat.error, never as the markup itself.
      const priorText = lastStreamEntry !== null && lastStreamEntry.kind === 'text' ? lastStreamEntry.textEl.textContent : ''
      const action = textStreamDeltaAction(priorText, frame.text, textStreamSuppressed)
      if (action === 'drop') return
      if (action === 'suppress') {
        textStreamSuppressed = true
        if (lastStreamEntry !== null && lastStreamEntry.kind === 'text') {
          endStreamGlide(lastStreamEntry.entry)
          lastStreamEntry.entry.remove()
          lastStreamEntry = null
        }
        // A fully suppressed step would otherwise keep its "gathering thoughts"
        // placeholder, which the first rendered row normally retires.
        removeRow(activityContainer().querySelector(':scope > .thinking-wait:not(.leaving)'))
        return
      }
      sawTextStream = true
      setActivityPhase('Responding…', 'busy')
      appendStreamActivity('text', frame.text)
      return
    }
    case 'tool-call-delta': {
      const label = toolLabel(frame.name)
      const running = toolRunningText(frame.name)
      setActivityPhase(running, 'busy')
      if (currentStep) {
        setStepTitle(currentStep, running)
        setStepKind(currentStep, toolKind(frame.name))
      }
      if (lastStreamEntry === null || lastStreamEntry.kind !== 'tool' || lastStreamEntry.id !== frame.id) {
        finalizeStreamActivity()
        const created = pushActivity('tool', label, running)
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
      if (currentStep) currentStep.finish = String(reason)
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
      pushActivity('reasoning', 'thinking', reasoningActivityText(frame.text))
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
      if (!els.diaryModal.classList.contains('hidden')) renderDiaryModal()
      return
    case 'chat.hello':
      companionHelloReceived = true
      diarySupported = frame.diary !== null && typeof frame.diary === 'object'
      dshState = frame.dsh?.state ?? 'unknown'
      if (typeof frame.companion === 'string') companionVersion = frame.companion
      if (frame.llm && typeof frame.llm === 'object') llmState = { ...llmState, ...frame.llm }
      if (frame.credentials && typeof frame.credentials === 'object') credentialState = { ...credentialState, ...frame.credentials }
      if (frame.settings && typeof frame.settings === 'object') {
        companionSettings = {
          confirmIrreversible: frame.settings.confirmIrreversible === true,
          watchAutoSteer: frame.settings.watchAutoSteer !== false,
          diaryAutoSuggest: frame.settings.diaryAutoSuggest !== false,
        }
        sentCompanionSettings = {}
        if (!els.settingsModal.classList.contains('hidden')) {
          els.settingConfirmIrreversible.checked = companionSettings.confirmIrreversible
          if (els.settingWatchAutoSteer) els.settingWatchAutoSteer.checked = companionSettings.watchAutoSteer
          if (els.settingDiaryAutoSuggest) els.settingDiaryAutoSuggest.checked = companionSettings.diaryAutoSuggest
        }
      }
      // The hello carries the authoritative switch state and open watch alert (reconnect resync).
      applyMarathonState(frame.marathon)
      syncWatchAlert(watchNoticeFromOpen(frame.watch?.open))
      applyUpdateStatus(frame.update)
      applyLifetimeUsage(frame.lifetimeUsage)
      applyDiarySnapshot(frame.diary)
      applyDiarySuggestions(frame.diarySuggestions)
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
        if (connected && els.settingsDebugLog?.open) sendFrame({ v: PROTOCOL_VERSION, type: 'log.stats' })
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
      // A reconnect after a dropped bridge must not revive a stale /new draft.
      if (newChatDraft) {
        setNewChatDraft(false)
        if (hasConversation()) els.activityEmpty?.classList.add('hidden')
      }
      // A turn already running (this panel reopened mid-turn, or another
      // client's turn) is shown as it runs: a new chat would only be refused
      // as busy and leave the panel in an error state.
      const runningTurn = runningTurnPrompt(frame.turn)
      if (runningTurn !== null) {
        newChatOnNextConnect = false
        if (!busy && !stopping) {
          logger.log('chat.turn.attached', { origin: runningTurn.origin, turnId: runningTurn.turnId }, 'info')
          startForeignTurn(runningTurn)
        }
      } else if (newChatOnNextConnect) newChat()
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
    case 'chat.user':
      handleForeignPrompt(frame)
      return
    case 'chat.session':
      hideConfirmCard()
      if (typeof frame.sessionId === 'string') {
        sessionId = frame.sessionId
        updateFooter()
      }
      return
    case 'marathon.state':
      applyMarathonState(frame)
      logger.log('marathon.state', { enabled: marathonState.enabled, origin: marathonState.origin }, 'info')
      return
    case 'update.state':
      applyUpdateStatus(frame.update)
      return
    case 'usage.updated':
      applyLifetimeUsage(frame.lifetimeUsage)
      return
    case 'chat.watch':
      handleWatch(frame)
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
    case 'settings.updated':
      sentCompanionSettings = {}
      if (frame.ok === true && frame.settings && typeof frame.settings === 'object') {
        companionSettings = {
          confirmIrreversible: frame.settings.confirmIrreversible === true,
          watchAutoSteer: frame.settings.watchAutoSteer !== false,
          diaryAutoSuggest: frame.settings.diaryAutoSuggest !== false,
        }
        els.settingConfirmIrreversible.checked = companionSettings.confirmIrreversible
        if (els.settingWatchAutoSteer) els.settingWatchAutoSteer.checked = companionSettings.watchAutoSteer
        if (els.settingDiaryAutoSuggest) els.settingDiaryAutoSuggest.checked = companionSettings.diaryAutoSuggest
        logger.log('settings.updated', {
          confirmIrreversible: companionSettings.confirmIrreversible,
          watchAutoSteer: companionSettings.watchAutoSteer,
          diaryAutoSuggest: companionSettings.diaryAutoSuggest,
        }, 'info')
      } else {
        toast(typeof frame.error === 'string' ? frame.error : 'The companion refused the settings change')
      }
      return
    case 'diary.state':
      handleDiaryStateFrame(frame)
      return
    case 'diary.suggestions':
      diarySupported = true
      applyDiarySuggestions(frame.suggestions)
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
    stopAllWaitCountdowns()
    setBusy(false)
    setActivityPhase(planTerminalPhase?.label ?? waitingPhase?.label ?? 'Ready', planTerminalPhase?.kind ?? waitingPhase?.kind ?? 'online')
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
    const running = toolRunningText(frame.tool)
    setStatus('busy', running)
    setActivityPhase(running, 'busy')
    return
  }
  if (status === 'error') {
    stopAllWaitCountdowns()
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
    default: return String(name ?? 'tool').replace(/^browser_/, '').replaceAll('_', ' ')
  }
}

/** Running wait countdowns by tool call ID: `{ timer, ms, endsAt }`. */
const waitCountdowns = new Map()

/** Tool arguments arrive as a JSON string from the model and as an object in browser commands. */
function parseToolArgs(raw) {
  if (raw !== null && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** What a browser_wait_for call waits for, in words, or its fixed time. Null for anything else. */
function describeWait(args) {
  if (args === null || typeof args !== 'object') return null
  if (typeof args.text === 'string' && args.text.length > 0) return { title: `Wait for “${truncate(args.text, 48)}”` }
  if (typeof args.url === 'string' && args.url.length > 0) return { title: `Wait for URL “${truncate(args.url, 48)}”` }
  if (args.idle === true) return { title: 'Wait for the page to settle' }
  if (Number.isFinite(args.ms) && args.ms >= 0) return { ms: args.ms }
  return null
}

/**
 * Show a wait as words on the step title and the activity phase. A fixed wait
 * of a second or more counts down once a second. The tool row stays hidden, so
 * the title is the only text; only a failed wait reveals it (`revealWaitRow`). Calling it
 * again for the same call keeps the original end time. Returns whether the
 * arguments were a wait it could describe.
 */
function startWaitCountdown(callId, row, rawArgs, step = currentStep) {
  const wait = describeWait(parseToolArgs(rawArgs))
  if (wait === null || typeof callId !== 'string' || !row) return false
  const previous = waitCountdowns.get(callId)
  stopWaitCountdown(callId)
  row.entry.classList.add('wait-hidden')
  const show = (title, first) => {
    if (step) {
      if (first) setStepTitle(step, title)
      else step.titleEl.textContent = title
    }
    setActivityPhase(`${title}…`, 'busy')
  }
  if (wait.ms === undefined) {
    show(wait.title, true)
    return true
  }
  if (wait.ms < 1000) {
    show(`Wait ${Number((wait.ms / 1000).toFixed(2))}s`, true)
    return true
  }
  const endsAt = previous?.ms === wait.ms ? previous.endsAt : now() + wait.ms
  let shown = -1
  const tick = (first = false) => {
    const left = Math.max(0, Math.ceil((endsAt - now()) / 1000))
    if (left === shown) return
    shown = left
    show(`Wait ${left}s`, first)
  }
  tick(true)
  waitCountdowns.set(callId, { timer: setInterval(tick, 200), ms: wait.ms, endsAt })
  return true
}

/** A finished wait's step title: just "Done", or "Timed out" when its condition never came. */
function waitOutcome(wait, text) {
  if (!wait) return null
  return /\btimed out after\b/u.test(String(text ?? '')) ? 'Timed out' : 'Done'
}

/** Grow a finished wait's row in, now that it has its result to show. */
function revealWaitRow(row) {
  if (!row?.entry.classList.contains('wait-hidden')) return
  row.entry.classList.remove('wait-hidden')
  enterRow(row.entry)
}

function stopWaitCountdown(callId) {
  const countdown = waitCountdowns.get(callId)
  if (countdown === undefined) return
  clearInterval(countdown.timer)
  waitCountdowns.delete(callId)
}

function stopAllWaitCountdowns() {
  for (const countdown of waitCountdowns.values()) clearInterval(countdown.timer)
  waitCountdowns.clear()
}

function toolKind(name) {
  if (/click/.test(name)) return 'click'
  if (/type|press_key/.test(name)) return 'type'
  if (/scroll/.test(name)) return 'scroll'
  if (/navigate|switch_tab/.test(name)) return 'open'
  if (/read|tabs/.test(name)) return 'read'
  if (/screenshot/.test(name)) return 'shot'
  if (/wait/.test(name)) return 'wait'
  return 'tool'
}

/** @param {Record<string, any>} frame */
function handleToolCall(frame) {
  logger.log('ui.tool_call', { callId: frame.callId, name: frame.name, args: truncate(frame.args, 500) }, 'debug')
  finalizeStreamActivity()
  const label = toolLabel(frame.name)
  const running = toolRunningText(frame.name, frame.args)
  setActivityPhase(running, 'busy')
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
  const row = streamed ?? pushActivity('tool', label, running)
  row.entry.classList.add('running')
  row.textEl.textContent = running
  if (typeof frame.callId === 'string') {
    toolRows.set(frame.callId, { row, name: frame.name, args: parseToolArgs(frame.args) ?? frame.args, startedAt: startedAtOverride ?? now() })
  }
  if (currentStep) {
    setStepTitle(currentStep, running)
    setStepKind(currentStep, toolKind(frame.name))
  }
  setBusy(true)
  setStatus('busy', running)
  if (frame.name === 'browser_wait_for' && startWaitCountdown(frame.callId, row, frame.args)) {
    toolRows.get(frame.callId).wait = describeWait(parseToolArgs(frame.args))
  }
  scrollActivity()
}

/** @param {Record<string, any>} frame */
function handleToolResult(frame) {
  logger.log('ui.tool_result', { callId: frame.callId, ok: frame.ok !== false, text: truncate(frame.text, 500) }, 'debug')
  stopWaitCountdown(frame.callId)
  const ok = frame.ok !== false
  const at = now()
  const record = typeof frame.callId === 'string' ? toolRows.get(frame.callId) : undefined
  const summary = truncate(toolResultSummary({
    name: record?.name,
    args: record?.args,
    text: frame.text,
    ok,
    browserSummary: record?.uiSummary,
  }), 320)
  if (record) {
    finishActivityEntry(record.row, {
      text: summary,
      ok,
      durationMs: at - record.startedAt,
    })
    record.row.entry.title = summary
    // A wait that worked says only "Done"; a failed one shows why.
    if (!ok) revealWaitRow(record.row)
    toolRows.delete(frame.callId)
  } else {
    const created = pushActivity('tool', ok ? 'done' : 'failed', summary)
    finishActivityEntry(created, { ok })
    created.entry.title = summary
  }
  if (currentStep !== null) {
    // The collapsed step header carries the latest outcome, so a finished step
    // stays readable as a one-line summary without expanding it.
    const outcome = ok ? waitOutcome(record?.wait, frame.text) : null
    setStepTitle(currentStep, outcome ?? activityPreview(summary, 66), { settled: true })
    currentStep.titleEl.title = summary
  }
  setActivityPhase('Thinking…', 'busy', summary)
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
  if (!newChatDraft) els.activityEmpty?.classList.add('hidden')
  const block = document.createElement('div')
  block.className = 'activity-answer'
  const body = document.createElement('div')
  body.className = 'answer-text'
  renderMarkdown(body, value)
  block.appendChild(body)
  ;(lastAgentTurn ?? activityContainer()).appendChild(block)
  answerAnchor = block
  enterRow(block, MOTION.slow)
  trimActivity()
  els.activityLatest.textContent = activityPreview(value)
  els.activityLatest.title = value
  scrollActivity()
  return block
}

/** Reset per-turn state and open the turn divider when a message is sent. */
function beginUserTurn(text, attachments = [], options = {}) {
  setUtilitiesOpen(false)
  answerAnchor = null
  conversationStopped = false
  planTerminalPhase = null
  waitingPhase = null
  lastAssistantText = ''
  lastAnswerText = ''
  sawReasoningStream = false
  sawTextStream = false
  lastReasoningStreamText = ''
  finalizeStreamActivity()
  setActivityPhase('Sending…', 'busy')
  startTurn(text, attachments, options)
}

/**
 * Another client (the phone) started a turn. Show it like a normal turn and go
 * busy so desktop input queues instead of colliding with the shared turn slot.
 * @param {Record<string, any>} frame
 */
function handleForeignPrompt(frame) {
  const prompt = foreignPrompt(frame)
  if (prompt === null) return
  // Any prompt from another client abandons an open confirmation.
  hideConfirmCard()
  applyDiarySuggestions([])
  logger.log('chat.user.foreign', {
    origin: prompt.origin,
    turnId: prompt.turnId,
    textLength: prompt.text.length,
    images: prompt.attachments.length,
    pendingLocalSend: lastDispatchedItem !== null,
  }, 'info')
  if (busy || stopping) {
    // Our own chat.send is in flight and the companion will refuse it as busy;
    // start this turn when that refusal arrives (handleRefusedSend).
    pendingForeignPrompt = prompt
    return
  }
  startForeignTurn(prompt)
}

/** @param {{text: string, attachments: Array<{name: string}>, label: string, origin: string}} prompt */
function startForeignTurn(prompt) {
  pendingForeignPrompt = null
  clearTimeout(queueDispatchTimer)
  queueDispatchTimer = null
  void beginDebuggerRun().catch(() => {})
  beginUserTurn(prompt.text, prompt.attachments, { originLabel: prompt.label, origin: prompt.origin, marathon: prompt.marathon ?? marathonState.enabled })
  setActivityPhase('Working…', 'busy')
  setBusy(true)
  setStatus('busy', 'Working…')
}

/**
 * The companion refused our send because another client holds the turn slot.
 * Nothing ran for it: put it back at the front of the queue (it dispatches when
 * the other turn ends) and show the other turn instead.
 * @param {Record<string, any>} frame
 */
function handleRefusedSend(frame) {
  const item = lastDispatchedItem
  lastDispatchedItem = null
  queuedMessages.unshift({ ...item, id: `queue-${Date.now().toString(36)}-${++queuedMessageSequence}` })
  finishTurn({})
  if (lastAgentTurn) {
    lastAgentTurn.classList.add('refused')
    const summary = lastAgentTurn.querySelector('.agent-turn-summary')
    if (summary) summary.textContent = 'Not sent · queued until the other turn finishes'
  }
  renderQueuedMessages()
  logger.log('chat.send.refused', { code: frame.code, requeued: true, foreign: pendingForeignPrompt !== null }, 'info')
  toast('Another turn is running; your message is queued')
  if (pendingForeignPrompt !== null) {
    startForeignTurn(pendingForeignPrompt)
  } else {
    setBusy(true)
    setStatus('busy', 'Waiting for another turn…')
    setActivityPhase('Waiting for another turn…', 'busy')
  }
}

/** Shared terminal cleanup for a turn: clear busy, pending stop, streaming markers, labels. */
function cleanupAfterTurn() {
  lastDispatchedItem = null
  pendingForeignPrompt = null
  stopping = false
  waitingPhase = null
  clearTimeout(stopTimer)
  stopTimer = null
  setBusy(false)
  void endDebuggerRun()
  void execute('labels.clear', {}, settings).catch(() => {})
  finalizeStreamActivity()
}

/** @param {Record<string, any>} frame */
function handleDone(frame) {
  conversationStopped = false
  cleanupAfterTurn()
  dshState = 'ready'
  const timing = frame.timings
  const totalMs = Number.isFinite(timing?.totalMs) ? timing.totalMs : undefined
  finishTurn({ totalMs, usage: frame.usage, failedCalls: timing?.failedCalls })
  const finalText = typeof frame.text === 'string' ? frame.text.trim() : ''
  if (finalText.length > 0) pushAnswer(finalText)
  const unverified = frame.docsVerification === 'unverified'
  const planOutcome = typeof frame.planOutcome === 'string' ? frame.planOutcome : undefined
  const planIncomplete = planOutcome === 'unfinished' || planOutcome === 'blocked'
  // A structured agent_request_help from this turn: the chat now waits for the user.
  const help = helpNotice(frame)
  // A structured confirmation request (B9b): the chat waits for Approve/Deny.
  const confirm = help === null ? confirmNotice(frame) : null
  const phase = unverified ? 'Verification incomplete'
    : planOutcome === 'unfinished' ? 'Plan unfinished'
      : planOutcome === 'blocked' ? 'Plan blocked'
        : help !== null ? 'Waiting for you' : confirm !== null ? 'Waiting for approval' : 'Ready'
  planTerminalPhase = planIncomplete ? { label: phase, kind: 'error' } : null
  waitingPhase = help !== null ? { label: 'Waiting for you', kind: 'online' }
    : confirm !== null ? { label: 'Waiting for approval', kind: 'online' } : null
  setActivityPhase(phase, unverified || planIncomplete ? 'error' : 'online')
  logger.log('chat.done', {
    sessionId: frame.sessionId,
    timings: frame.timings,
    usage: frame.usage,
    label: frame.label,
    stepDurations: lastStepDurations,
    textLength: typeof frame.text === 'string' ? frame.text.length : 0,
    docsVerification: frame.docsVerification,
    docsVerificationReason: frame.docsVerificationReason,
    planOutcome,
    planRevision: frame.planRevision,
  }, 'info')
  if (typeof frame.sessionId === 'string' && frame.sessionId.length > 0) {
    sessionId = frame.sessionId
  }
  updateFooter()
  refreshStatus()
  if (unverified) toast(`Docs verification incomplete${typeof frame.docsVerificationReason === 'string' ? `: ${frame.docsVerificationReason}` : ''}`)
  else if (planOutcome === 'unfinished') toast('Plan unfinished: open checklist items remain')
  else if (planOutcome === 'blocked') toast('Plan blocked: review the checklist for the reason')
  else if (help !== null) toast(`${help.label}: ${help.reason}`)
  else if (confirm !== null) toast(`Approval needed: ${confirm.action}`)
  if (confirm !== null) showConfirmCard(confirm)
  else hideConfirmCard()
  archiveCurrentConversation()
  if (newChatDraft) newChat()
}

/** @param {Record<string, any>} frame */
function handleChatError(frame) {
  if (frame.code === 'NO_CONFIRMATION_PENDING' || frame.code === 'INVALID_CONFIRMATION') {
    // Another client answered first, or the request was abandoned: retire the card.
    hideConfirmCard()
    toast('That confirmation is no longer waiting for an answer')
    return
  }
  if (frame.code === 'SESSION_NOT_RESUMABLE') {
    const message = typeof frame.message === 'string' ? frame.message : 'This saved chat can no longer be continued.'
    logger.log('chat.resume.error', { message }, 'warn')
    newChat()
    showBanner(message, 'Open history', openHistory)
    toast('The saved model session is unavailable; started a new chat.')
    return
  }
  if (isBusyRefusal(frame) && lastDispatchedItem !== null) {
    handleRefusedSend(frame)
    return
  }
  if (stopping) {
    // A stop can race an in-flight error; the user asked to stop, so report a stop.
    logger.log('chat.error.after_stop', { message: frame.message }, 'info')
    handleStopped({ turnId: frame.turnId, reason: 'user', message: frame.message })
    return
  }
  cleanupAfterTurn()
  const detail = typeof frame.message === 'string' ? frame.message : 'Unknown companion error'
  const message = chatErrorSummary(detail, frame.code)
  finishTurn({})
  pushActivity('error', 'error', message)
  setActivityPhase('Error', 'error')
  logger.log('chat.error', { message: detail, recoverable: frame.recoverable !== false }, 'error')
  setStatus('error', 'Error')
  if (/companion|not connected|script|invalid pairing|dsh/i.test(message)) {
    showBanner(message, 'Open settings', openSettings)
  }
  if (newChatDraft) newChat()
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
  conversationStopped = reason === 'user'
  if (frame.local === true) steeringMessageId = null
  cleanupAfterTurn()
  dshState = 'ready'
  finishTurn({ totalMs: frame.timings?.totalMs, usage: frame.usage, failedCalls: frame.timings?.failedCalls })
  if (lastAgentTurn) {
    const summary = lastAgentTurn.querySelector('.agent-turn-summary')
    if (summary && !summary.textContent.includes('Stopped')) summary.textContent += ' · Stopped'
  }
  setActivityPhase('Stopped', 'idle')
  setStatus('idle', 'Stopped')
  logger.log('chat.stopped', { turnId: frame.turnId, reason, timings: frame.timings, usage: frame.usage, stepDurations: lastStepDurations }, 'info')
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
  archiveCurrentConversation({ immediate: true })
  if (newChatDraft) newChat()
}

function updateFooter() {
  els.sessionInfo.textContent = ''
  els.sessionInfo.title = ''
}

/* ------------------------------------------------------------------ */
/* browser commands                                                    */
/* ------------------------------------------------------------------ */

async function handleBrowserCommand(frame) {
  const command = frame.command ?? {}
  const op = String(command.op ?? '')
  const args = command.args && typeof command.args === 'object' ? command.args : {}
  const started = now()
  // Auto-capture outcomes stay in the debug log rather than the conversation.
  const isAutoCapture = (op === 'snapshot' || op === 'auto_view') && frame.callId === 'auto'
  const toolRecord = typeof frame.callId === 'string' ? toolRows.get(frame.callId) : undefined
  const running = toolRecord ? toolRunningText(toolRecord.name, args) : browserRunningText(op, args)
  setActivityPhase(running, 'busy')
  const rowKey = typeof frame.callId === 'string' ? frame.callId : String(frame.id)
  const ownRow = toolRecord === undefined && !isAutoCapture
    ? pushActivity('browser', op === 'tabs.list' ? 'tabs' : op.replaceAll('_', ' '), running, { running: true })
    : null
  if (ownRow !== null) browserRows.set(rowKey, { row: ownRow, startedAt: started })
  const waitShown = op === 'wait_for' && startWaitCountdown(rowKey, ownRow ?? toolRecord?.row, args)
  if (toolRecord !== undefined && !waitShown) {
    toolRecord.row.textEl.textContent = running
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
    stopWaitCountdown(rowKey)
    const uiMs = now() - started
    const summary = browserResultSummary(op, result, args)
    if (ownRow !== null) {
      finishActivityEntry(ownRow, { text: summary, ok: true, durationMs: uiMs })
      ownRow.entry.title = summary
      browserRows.delete(rowKey)
    } else if (toolRecord !== undefined) {
      toolRecord.uiSummary = summary
      toolRecord.row.textEl.textContent = summary
      toolRecord.row.entry.title = summary
    }
    if (op === 'snapshot' && toolRecord !== undefined) showStepScreenshot(cleanImageFor(result.image) ?? result.image)
    setActivityPhase('Thinking…', 'busy', summary)
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
    stopWaitCountdown(rowKey)
    const message = errorMessage(error)
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BROWSER_ERROR'
    const summary = browserErrorSummary(op, message, code)
    if (ownRow !== null) {
      finishActivityEntry(ownRow, { text: summary, ok: false, durationMs: now() - started })
      ownRow.entry.title = summary
      revealWaitRow(ownRow)
      browserRows.delete(rowKey)
    } else if (!isAutoCapture) {
      pushActivity('error', 'browser', summary)
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
    sendBrowserResult(frame.id, false, undefined, {
      code,
      message,
      ...(typeof error?.mutationPossible === 'boolean' ? { mutationPossible: error.mutationPossible } : {}),
    })
  } finally {
    setActivity(false)
    if (!busy) refreshStatus()
  }
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
  enterRow(button)
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
    ...displayImageField(result),
  })
}

function openImage(src) {
  els.imageModalImg.src = src
  els.imageModal.classList.remove('hidden')
}

function closeImage() {
  const hadFocus = els.imageModal.contains(document.activeElement)
  els.imageModal.classList.add('hidden')
  els.imageModalImg.removeAttribute('src')
  if (hadFocus) els.input.focus({ preventScroll: true })
}

/* ------------------------------------------------------------------ */
/* composer / controls                                                 */
/* ------------------------------------------------------------------ */

const interactiveAura = createInteractiveAuraState()
let interactiveAuraRaf = 0
let interactiveAuraLastTime = 0

function isComposerAuraActive() {
  return !els.app?.classList.contains('chat-open') || dictation !== null
}

function resetInteractiveAura() {
  if (interactiveAuraRaf) {
    cancelAnimationFrame(interactiveAuraRaf)
    interactiveAuraRaf = 0
  }
  interactiveAuraLastTime = 0
  interactiveAura.x = 50
  interactiveAura.y = 50
  interactiveAura.vx = 0
  interactiveAura.vy = 0
  interactiveAura.hoverEnergy = 0
  interactiveAura.wake = 0
  interactiveAura.typeEnergy = 0
  if (!els.composer) return
  els.composer.classList.remove('fluid-active')
  els.composer.style.removeProperty('--fluid-x')
  els.composer.style.removeProperty('--fluid-y')
  els.composer.style.removeProperty('--fluid-energy')
  els.composer.style.removeProperty('--fluid-type')
  els.composer.style.removeProperty('--fluid-stretch')
  els.composer.style.removeProperty('--fluid-dx')
  els.composer.style.removeProperty('--fluid-dy')
  els.composer.style.removeProperty('--fluid-angle')
}

function applyInteractiveAuraFrame(frame) {
  if (!els.composer) return
  els.composer.classList.add('fluid-active')
  els.composer.style.setProperty('--fluid-x', `${frame.x.toFixed(1)}%`)
  els.composer.style.setProperty('--fluid-y', `${frame.y.toFixed(1)}%`)
  els.composer.style.setProperty('--fluid-energy', frame.hoverEnergy.toFixed(3))
  els.composer.style.setProperty('--fluid-type', frame.typeEnergy.toFixed(3))
  els.composer.style.setProperty('--fluid-stretch', frame.stretch.toFixed(3))
  els.composer.style.setProperty('--fluid-dx', frame.dx.toFixed(3))
  els.composer.style.setProperty('--fluid-dy', frame.dy.toFixed(3))
  els.composer.style.setProperty('--fluid-angle', `${frame.angle.toFixed(1)}deg`)
}

function startInteractiveAuraLoop() {
  if (!isComposerAuraActive()) {
    resetInteractiveAura()
    return
  }
  if (interactiveAuraRaf) return
  interactiveAuraLastTime = performance.now()
  const tick = frameTime => {
    interactiveAuraRaf = 0
    if (!isComposerAuraActive()) {
      resetInteractiveAura()
      return
    }
    const dtMs = frameTime - interactiveAuraLastTime
    interactiveAuraLastTime = frameTime
    const frame = stepInteractiveAura(interactiveAura, {
      dtMs,
      reducedMotion: reducedMotion.matches,
    })
    if (!frame.active) {
      resetInteractiveAura()
      return
    }
    applyInteractiveAuraFrame(frame)
    interactiveAuraRaf = requestAnimationFrame(tick)
  }
  interactiveAuraRaf = requestAnimationFrame(tick)
}

function handleComposerAuraPointer(event) {
  const shell = els.composerShell
  if (!shell) return
  const rect = shell.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const nextX = Math.max(4, Math.min(96, ((event.clientX - rect.left) / rect.width) * 100))
  const nextY = Math.max(4, Math.min(96, ((event.clientY - rect.top) / rect.height) * 100))
  const dist = Math.hypot(nextX - interactiveAura.targetX, nextY - interactiveAura.targetY)
  const wakeBoost = event.type === 'pointerenter' ? 0.45 : Math.min(0.65, dist / 24)
  interactiveAura.wake = Math.min(1, interactiveAura.wake + wakeBoost)
  interactiveAura.hovering = true
  interactiveAura.targetX = nextX
  interactiveAura.targetY = nextY
  if (isComposerAuraActive()) startInteractiveAuraLoop()
}

function pulseInteractiveTyping(boost = 0.45) {
  if (!els.input) return
  const caret = els.input.selectionEnd ?? els.input.value.length
  interactiveAura.typeX = estimateCaretFocusX(els.input.value, caret)
  interactiveAura.typeEnergy = Math.min(1, Math.max(interactiveAura.typeEnergy + boost * 0.65, boost))
  if (isComposerAuraActive()) startInteractiveAuraLoop()
}

function resetComposerSpeechAura() {
  if (!els.composer) return
  els.composer.classList.remove('speaking')
  els.composer.style.removeProperty('--speech-level')
  els.composer.style.removeProperty('--speech-peak')
  els.composer.style.removeProperty('--speech-focus-x')
  els.composer.style.removeProperty('--speech-angle')
}

function cleanupDictationSession(session) {
  if (session?.rafId) {
    cancelAnimationFrame(session.rafId)
    session.rafId = 0
  }
  if (session?.mediaStream) {
    for (const track of session.mediaStream.getTracks()) track.stop()
    session.mediaStream = null
  }
  if (session?.audioContext) {
    void session.audioContext.close().catch(() => {})
    session.audioContext = null
  }
  if (session) {
    session.analyser = null
    session.timeData = null
    session.freqData = null
  }
  if (dictation === null) {
    els.composer?.classList.remove('dictating')
    resetComposerSpeechAura()
  }
}

async function startAudioMeter(session) {
  if (!session || session.audioStarted || dictation !== session) return
  session.audioStarted = true
  const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
  const AudioCtx = window.AudioContext || window.webkitAudioContext
  if (!getUserMedia || !AudioCtx) return
  let stream
  try {
    stream = await getUserMedia({ audio: true })
  } catch {
    return
  }
  if (dictation !== session) {
    for (const track of stream.getTracks()) track.stop()
    return
  }
  try {
    const audioContext = new AudioCtx()
    if (audioContext.state === 'suspended') {
      await audioContext.resume().catch(() => {})
    }
    if (dictation !== session) {
      for (const track of stream.getTracks()) track.stop()
      void audioContext.close().catch(() => {})
      return
    }
    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.45
    source.connect(analyser)
    session.mediaStream = stream
    session.audioContext = audioContext
    session.analyser = analyser
    session.timeData = new Uint8Array(analyser.fftSize)
    session.freqData = new Uint8Array(analyser.frequencyBinCount)
  } catch {
    for (const track of stream.getTracks()) track.stop()
  }
}

function startDictationAuraLoop(session) {
  let lastTime = performance.now()
  const tick = frameTime => {
    if (dictation !== session) return
    const dtMs = frameTime - lastTime
    lastTime = frameTime
    let micLevel = 0
    let micBalance = 0
    if (session.analyser && session.timeData && session.freqData) {
      session.analyser.getByteTimeDomainData(session.timeData)
      session.analyser.getByteFrequencyData(session.freqData)
      const measured = measureAudioFrame(session.timeData, session.freqData, session.aura.noiseFloor)
      session.aura.noiseFloor = measured.noiseFloor
      micLevel = measured.level
      micBalance = measured.balance
    }
    const frame = stepSpeechAura(session.aura, {
      now: frameTime,
      dtMs,
      micLevel,
      micBalance,
      hasMicStream: Boolean(session.analyser),
      reducedMotion: reducedMotion.matches,
    })
    if (els.composer) {
      els.composer.style.setProperty('--speech-level', frame.level.toFixed(3))
      els.composer.style.setProperty('--speech-peak', frame.peak.toFixed(3))
      els.composer.style.setProperty('--speech-focus-x', `${frame.focusX.toFixed(1)}%`)
      els.composer.style.setProperty('--speech-angle', `${frame.angle.toFixed(1)}deg`)
      els.composer.classList.toggle('speaking', frame.speaking)
    }
    session.rafId = requestAnimationFrame(tick)
  }
  session.rafId = requestAnimationFrame(tick)
}

function updateMicButton() {
  const supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  const active = dictation !== null
  const label = active ? 'Stop dictation' : supported ? 'Start dictation' : 'Dictation is not supported in this browser'
  els.mic.disabled = !supported
  els.mic.classList.toggle('recording', active)
  els.mic.title = label
  els.mic.setAttribute('aria-label', label)
  els.mic.setAttribute('aria-pressed', String(active))
  els.composer?.classList.toggle('dictating', active)
  if (!active) resetComposerSpeechAura()
  else if (interactiveAura.hovering || interactiveAura.hoverEnergy > 0.004 || interactiveAura.typeEnergy > 0.004) {
    startInteractiveAuraLoop()
  }
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
  cleanupDictationSession(session)
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
  const session = {
    recognition,
    before,
    after,
    aura: createSpeechAuraState(),
    rafId: 0,
    audioStarted: false,
    mediaStream: null,
    audioContext: null,
    analyser: null,
    timeData: null,
    freqData: null,
  }
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = navigator.language || 'en-US'
  recognition.onaudiostart = () => {
    if (dictation !== session) return
    void startAudioMeter(session)
  }
  recognition.onsoundstart = () => {
    if (dictation !== session) return
    session.aura.speechActive = true
    session.aura.pulse = Math.max(session.aura.pulse, 0.48)
  }
  recognition.onspeechstart = () => {
    if (dictation !== session) return
    session.aura.speechActive = true
    session.aura.pulse = Math.max(session.aura.pulse, 0.82)
  }
  recognition.onspeechend = () => {
    if (dictation !== session) return
    session.aura.speechActive = false
  }
  recognition.onsoundend = () => {
    if (dictation !== session) return
    session.aura.speechActive = false
  }
  recognition.onresult = event => {
    if (dictation !== session) return
    let transcript = ''
    for (let index = 0; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript
    }
    session.aura.pulse = Math.max(session.aura.pulse, transcriptImpulse(session.aura.lastTranscriptLen, transcript.length))
    session.aura.lastTranscriptLen = transcript.length
    session.aura.speechHoldUntil = performance.now() + 380
    els.input.value = `${session.before}${transcript}${session.after}`
    const caret = session.before.length + transcript.length
    els.input.setSelectionRange(caret, caret)
    resizeInput()
  }
  recognition.onerror = event => {
    if (dictation !== session) return
    dictation = null
    cleanupDictationSession(session)
    updateMicButton()
    logger.log('speech.error', { code: event.error }, 'warn')
    toast(dictationError(event.error))
  }
  recognition.onend = () => {
    if (dictation !== session) return
    dictation = null
    cleanupDictationSession(session)
    updateMicButton()
    logger.log('speech.end', {}, 'info')
  }
  try {
    recognition.start()
    dictation = session
    updateMicButton()
    startDictationAuraLoop(session)
    void navigator.permissions?.query({ name: 'microphone' })
      .then(status => {
        if (dictation === session && status.state === 'granted') void startAudioMeter(session)
      })
      .catch(() => {})
    els.input.focus()
    logger.log('speech.start', { language: recognition.lang }, 'info')
  } catch (error) {
    dictation = null
    cleanupDictationSession(session)
    updateMicButton()
    toast(`Could not start dictation: ${errorMessage(error)}`)
  }
}

function updateComposerDraftState() {
  const hasDraft = els.input.value.trim().length > 0 || attachedImages.length > 0
  els.composer?.classList.toggle('has-draft', hasDraft)
}

function resizeInput() {
  els.input.style.height = 'auto'
  els.input.style.height = `${Math.min(els.input.scrollHeight, 132)}px`
  updateComposerDraftState()
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
  closeSlashMenu()
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
  const isConfirm = item.confirm === 'approve' || item.confirm === 'deny'
  const prompt = isConfirm ? '' : (item.text || 'Review the attached image(s).')
  const images = item.images.map(image => ({ name: image.name, mimeType: image.mimeType, data: image.data }))
  const frame = {
    v: PROTOCOL_VERSION,
    type: 'chat.send',
    text: prompt,
    autoCapture: settings.autoCapture !== false,
    ...isConfirm ? { confirm: item.confirm } : {},
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
    marathon: marathonState.enabled,
    ...(isConfirm ? { confirm: item.confirm } : {}),
    images: item.images.map(image => ({ name: image.name, size: image.size, mimeType: image.mimeType })),
    preview: truncate(item.text, 300),
  }, 'info')
  lastDispatchedItem = { text: item.text, images: item.images, ...(isConfirm ? { confirm: item.confirm, confirmAction: item.confirmAction } : {}) }
  const echoText = isConfirm
    ? `${item.confirm === 'approve' ? 'Approved' : 'Denied'}: ${item.confirmAction ?? ''}`
    : item.text
  beginUserTurn(echoText, item.images, { marathon: marathonState.enabled })
  // Any prompt answers or abandons an open confirmation.
  hideConfirmCard()
  applyDiarySuggestions([])
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
  // Sending an exact `/command` runs it even when the palette was dismissed,
  // so the Send button and Enter agree with the visible command menu.
  const slashCommand = resolveSlashCommand(els.input.value)
  if (slashCommand) {
    executeSlashCommand(slashCommand)
    return
  }
  const text = els.input.value.trim()
  const images = attachedImages
  if (text.length === 0 && images.length === 0) {
    // Enter (or Send) on a blank composer sends the first queued message:
    // immediately when idle, or as a steer while a turn is running — the same
    // action as the first queue row's arrow button. An empty queue stays a no-op.
    if (queuedMessages.length > 0) steerQueuedMessage(queuedMessages[0].id)
    return
  }
  if (newChatDraft) {
    toast('Wait for the running session to finish')
    return
  }
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
      marathon: marathonState.enabled,
      images: item.images.map(image => ({ name: image.name, size: image.size, mimeType: image.mimeType })),
      queued: queuedMessages.length,
    }, 'info')
    return
  }
  if (dispatchMessage({ id: '', text, images })) {
    clearComposerDraft()
  }
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
  conversationStopped = true
  updateStopButton()
  setStatus('busy', 'Stopping…')
  setActivityPhase('Stopping…', 'busy')
  logger.log('chat.stop.request', { sessionId }, 'info')
  archiveCurrentConversation({ immediate: true })
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
  if (busy && !stopAvailable) {
    toast('Wait for the current operation to finish')
    return false
  }
  if (busy) {
    archiveCurrentConversation()
    setNewChatDraft(true)
    return true
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
  // Keep unsent composer content (text and pasted images) across the reset. The
  // /new draft view lets the user prepare the next message while the old turn
  // finishes, so retiring it must not silently drop the attachments they added.
  sessionId = ''
  updateFooter()
  renderRecentSessions()
  if (connected) setStatus('online', 'Connected')
  return true
}

function clearChat() {
  newChatDraft = false
  conversationStopped = false
  // The marathon chip is companion-owned: it clears when marathon.state off
  // arrives after chat.new, never optimistically here. The local watch-alert
  // mirror and pinned card clear with the transcript (rows removed by clearActivity).
  syncWatchAlert(null)
  diarySuggestions = []
  diarySuggestEditingId = null
  diarySuggestPendingIds.clear()
  renderDiarySuggestCard()
  els.app.classList.remove('new-chat-draft')
  clearTimeout(queueDispatchTimer)
  queueDispatchTimer = null
  queuedMessages = []
  steeringMessageId = null
  renderQueuedMessages()
  stopAllWaitCountdowns()
  toolRows.clear()
  streamToolEntries.clear()
  browserRows.clear()
  lastAssistantText = ''
  lastAnswerText = ''
  turnNumber = 0
  currentTurn = null
  lastAgentTurn = null
  planTerminalPhase = null
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
      currentActiveTabUrl = tab.url || ''
      const signature = `${tab.id ?? ''}|${tab.url ?? ''}|${tab.title ?? ''}`
      if (signature !== lastTabSignature) {
        lastTabSignature = signature
        logger.log('tab.active', { id: tab.id, title: tab.title, url: tab.url, status: tab.status }, 'debug')
      }
      els.activeTab.textContent = truncate(tab.title || tab.url || 'Untitled tab', 60)
      els.activeTab.title = tab.url || ''
    } else {
      currentActiveTabUrl = ''
      els.activeTab.textContent = 'No active tab'
      els.activeTab.title = ''
    }
  } catch {
    currentActiveTabUrl = ''
    els.activeTab.textContent = 'No active tab'
  }
  if (els.diaryUseCurrentTab) {
    els.diaryUseCurrentTab.disabled = !diaryCanMutate() || siteFromTabUrl(currentActiveTabUrl) === null
  }
}

function scheduleTabRefresh() {
  clearTimeout(tabRefreshTimer)
  tabRefreshTimer = setTimeout(() => { void refreshActiveTab() }, 120)
}

/* ------------------------------------------------------------------ */
/* diary modal, applied rows, and post-run suggestion cards            */
/* ------------------------------------------------------------------ */

function renderTurnDiaryPill(turn) {
  const pillEl = turn?.diaryPillEl
  if (!pillEl) return
  const state = formatDiaryHeaderPill(turn.diaryApplied)
  if (!state.visible || turn.done) {
    pillEl.classList.add('hidden')
    pillEl.replaceChildren()
    pillEl.removeAttribute('title')
    return
  }
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('class', 'icon turn-diary-icon')
  icon.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', '#icon-diary')
  icon.appendChild(use)

  const title = document.createElement('span')
  title.className = 'turn-diary-title'
  title.textContent = `Diary · ${state.latest}`

  pillEl.replaceChildren(icon, title)
  if (state.overflow > 0) {
    const more = document.createElement('span')
    more.className = 'turn-diary-more'
    more.textContent = `+${state.overflow}`
    pillEl.append(' ', more)
  }
  pillEl.title = state.tooltip
  pillEl.classList.remove('hidden')
}

function pushDiaryAppliedRow(frame) {
  if (!newChatDraft) els.activityEmpty?.classList.add('hidden')
  if (!currentTurn) return
  currentTurn.diaryApplied = mergeDiaryAppliedEntries(currentTurn.diaryApplied, frame)
  renderTurnDiaryPill(currentTurn)
}

function diaryUnsupportedByCompanion() {
  return connected && companionHelloReceived && !diarySupported
}

function diaryCanMutate() {
  return connected && (!companionHelloReceived || diarySupported)
}

function setDiaryBusy(nextBusy) {
  if (diaryBusyTimer !== null) {
    clearTimeout(diaryBusyTimer)
    diaryBusyTimer = null
  }
  diaryBusy = nextBusy === true
  if (!diaryBusy) return
  diaryBusyTimer = setTimeout(() => {
    diaryBusyTimer = null
    const wasAwaitingEditor = diaryEditorAwaitingSave
    diaryBusy = false
    diaryEditorAwaitingSave = false
    diarySuggestPendingIds.clear()
    const message = 'The companion did not respond. Restart the companion if it is running an older version.'
    if (wasAwaitingEditor && !els.diaryModal.classList.contains('hidden') && diaryEditorOpen) {
      showDiaryEditorError(message)
    } else {
      toast('The companion did not respond to the Diary request. Try restarting the companion.')
    }
    if (!els.diaryModal.classList.contains('hidden')) renderDiaryModal()
    renderDiarySuggestCard()
  }, DIARY_REQUEST_TIMEOUT_MS)
}

function applyDiarySnapshot(value) {
  diaryState = normalizeDiarySnapshot(value)
  if (!els.diaryModal.classList.contains('hidden')) renderDiaryModal()
}

function applyDiarySuggestions(value) {
  diarySuggestions = normalizeDiarySuggestions(value)
  for (const id of [...diarySuggestPendingIds]) {
    if (!diarySuggestions.some(item => item.id === id)) diarySuggestPendingIds.delete(id)
  }
  if (diarySuggestPendingIds.size === 0 && !diaryEditorAwaitingSave && diaryBusy) {
    setDiaryBusy(false)
  }
  if (diarySuggestEditingId !== null && !diarySuggestions.some(item => item.id === diarySuggestEditingId)) {
    diarySuggestEditingId = null
  }
  renderDiarySuggestCard()
}

function handleDiaryStateFrame(frame) {
  diarySupported = true
  setDiaryBusy(false)
  if (els.diaryEditorSave) els.diaryEditorSave.disabled = !diaryCanMutate()
  const hadPendingSuggestion = diarySuggestPendingIds.size > 0
  diarySuggestPendingIds.clear()
  if (frame.diary) diaryState = normalizeDiarySnapshot(frame.diary)
  if (frame.ok === false) {
    const message = typeof frame.error === 'string' && frame.error.length > 0 ? frame.error : 'Diary request failed'
    if (diaryEditorAwaitingSave && !els.diaryModal.classList.contains('hidden') && diaryEditorOpen) {
      diaryEditorAwaitingSave = false
      showDiaryEditorError(message)
    } else {
      diaryEditorAwaitingSave = false
      toast(message)
    }
    if (!els.diaryModal.classList.contains('hidden')) renderDiaryModal()
    renderDiarySuggestCard()
    return
  }
  if (diaryEditorAwaitingSave) {
    diaryEditorAwaitingSave = false
    closeDiaryEditor()
    toast('Saved to Diary')
  } else if (hadPendingSuggestion && frame.entry) {
    toast('Saved to Diary')
  }
  if (!els.diaryModal.classList.contains('hidden')) renderDiaryModal()
  renderDiarySuggestCard()
}

function setDiaryEditorScope(scope) {
  diaryEditorScope = scope === 'site' ? 'site' : 'global'
  const isSite = diaryEditorScope === 'site'
  els.diaryScopeGlobal.classList.toggle('active', !isSite)
  els.diaryScopeGlobal.setAttribute('aria-pressed', String(!isSite))
  els.diaryScopeSite.classList.toggle('active', isSite)
  els.diaryScopeSite.setAttribute('aria-pressed', String(isSite))
  els.diarySitesField.classList.toggle('hidden', !isSite)
  els.diaryUseCurrentTab.disabled = !diaryCanMutate() || siteFromTabUrl(currentActiveTabUrl) === null
}

function updateDiaryContentCount() {
  const len = els.diaryFieldContent.value.length
  els.diaryContentCount.textContent = `${len} / ${DIARY_CONTENT_MAX_CHARS}`
}

function showDiaryEditorError(message) {
  if (!message) {
    els.diaryEditorError.textContent = ''
    els.diaryEditorError.classList.add('hidden')
    return
  }
  els.diaryEditorError.textContent = message
  els.diaryEditorError.classList.remove('hidden')
}

function openDiaryEditor(entry = null) {
  diaryEditorOpen = true
  diaryEditingId = entry ? entry.id : null
  diaryEditingEnabled = entry ? entry.enabled !== false : true
  diaryDeleteConfirmId = null
  showDiaryEditorError('')
  setDiaryEditorScope(entry?.scope === 'site' ? 'site' : 'global')
  els.diaryFieldSites.value = entry?.scope === 'site' ? (entry.sites ?? []).join(', ') : ''
  els.diaryFieldTitle.value = entry?.title ?? ''
  els.diaryFieldContent.value = entry?.content ?? ''
  updateDiaryContentCount()
  els.diaryEditorSave.textContent = entry ? 'Save changes' : 'Save'
  els.diaryEditorSave.disabled = !diaryCanMutate() || diaryBusy
  els.diaryEditor.classList.remove('hidden')
  els.diaryEditor.scrollIntoView({ block: 'nearest' })
  setTimeout(() => {
    if (diaryEditorScope === 'site' && els.diaryFieldSites.value.trim().length === 0) {
      els.diaryFieldSites.focus()
    } else {
      els.diaryFieldTitle.focus()
    }
  }, 10)
}

function closeDiaryEditor() {
  diaryEditorOpen = false
  diaryEditingId = null
  diaryEditingEnabled = true
  if (diaryEditorAwaitingSave) {
    diaryEditorAwaitingSave = false
    setDiaryBusy(false)
  }
  showDiaryEditorError('')
  els.diaryEditor.classList.add('hidden')
}

function openDiary() {
  setUtilitiesOpen(false)
  closeModelMenu()
  closeSlashMenu()
  diaryDeleteConfirmId = null
  renderDiaryModal()
  els.diaryModal.classList.remove('hidden')
  logger.log('diary.modal.open', { count: diaryState.entries.length }, 'debug')
  if (connected && diaryCanMutate()) {
    sendFrame({ v: PROTOCOL_VERSION, type: 'diary.list' })
  }
  setTimeout(() => els.diarySearch.focus({ preventScroll: true }), 10)
}

function closeDiary() {
  const hadFocus = els.diaryModal.contains(document.activeElement)
  closeDiaryEditor()
  diaryDeleteConfirmId = null
  els.diaryModal.classList.add('hidden')
  if (hadFocus) els.input.focus({ preventScroll: true })
}

function renderDiaryModal() {
  if (!connected) {
    els.diaryOfflineNote.textContent = 'Connect to the companion to save, edit, or delete entries.'
    els.diaryOfflineNote.classList.remove('hidden')
  } else if (diaryUnsupportedByCompanion()) {
    els.diaryOfflineNote.textContent = 'Restart the companion to use Diary (the running companion predates Diary support).'
    els.diaryOfflineNote.classList.remove('hidden')
  } else {
    els.diaryOfflineNote.classList.add('hidden')
  }
  const canMutate = diaryCanMutate()
  els.diaryAdd.disabled = !canMutate
  els.diaryEditorSave.disabled = !canMutate || diaryBusy
  els.diaryUseCurrentTab.disabled = !canMutate || siteFromTabUrl(currentActiveTabUrl) === null

  for (const button of els.diaryFilters) {
    const active = button.dataset.diaryFilter === diaryFilter
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  }

  const filtered = filterDiaryEntries(diaryState.entries, {
    query: els.diarySearch.value,
    scope: diaryFilter,
  })

  els.diaryList.replaceChildren()
  if (filtered.length === 0) {
    els.diaryEmpty.textContent = diaryState.entries.length > 0
      ? 'No matching diary entries.'
      : 'No diary entries yet. Add your email preferences, site workflows, or standing rules here.'
    els.diaryEmpty.classList.remove('hidden')
  } else {
    els.diaryEmpty.classList.add('hidden')
  }

  for (const entry of filtered) {
    const card = document.createElement('article')
    card.className = `diary-entry${entry.enabled === false ? ' paused' : ''}`
    card.dataset.diaryId = entry.id

    const head = document.createElement('div')
    head.className = 'diary-entry-head'

    const badges = document.createElement('div')
    badges.className = 'diary-entry-badges'

    const scopeBadge = document.createElement('span')
    scopeBadge.className = entry.scope === 'site' ? 'diary-badge diary-badge-site' : 'diary-badge diary-badge-global'
    scopeBadge.textContent = entry.scope === 'site' ? entry.sites.join(', ') : 'Global'
    badges.appendChild(scopeBadge)

    if (entry.source === 'suggested') {
      const sourceTag = document.createElement('span')
      sourceTag.className = 'diary-tag'
      sourceTag.textContent = 'Suggested'
      badges.appendChild(sourceTag)
    }
    if (entry.enabled === false) {
      const pausedTag = document.createElement('span')
      pausedTag.className = 'diary-tag diary-tag-paused'
      pausedTag.textContent = 'Paused'
      badges.appendChild(pausedTag)
    }

    const titleEl = document.createElement('h3')
    titleEl.className = 'diary-entry-title'
    titleEl.textContent = entry.title

    head.append(badges, titleEl)

    const contentEl = document.createElement('p')
    contentEl.className = 'diary-entry-content'
    contentEl.textContent = entry.content

    const actions = document.createElement('div')
    actions.className = 'diary-entry-actions'

    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'diary-action-btn'
    editBtn.textContent = 'Edit'
    editBtn.disabled = !canMutate || diaryBusy
    editBtn.addEventListener('click', () => {
      openDiaryEditor(entry)
    })

    const toggleBtn = document.createElement('button')
    toggleBtn.type = 'button'
    toggleBtn.className = 'diary-action-btn'
    toggleBtn.textContent = entry.enabled === false ? 'Enable' : 'Pause'
    toggleBtn.disabled = !canMutate || diaryBusy
    toggleBtn.addEventListener('click', () => {
      if (!canMutate) return
      setDiaryBusy(true)
      renderDiaryModal()
      if (!sendFrame({
        v: PROTOCOL_VERSION,
        type: 'diary.update',
        id: entry.id,
        enabled: entry.enabled === false,
      })) {
        setDiaryBusy(false)
        renderDiaryModal()
        toast('Could not send to the companion')
      }
    })

    actions.append(editBtn, toggleBtn)

    if (diaryDeleteConfirmId === entry.id) {
      const confirmBtn = document.createElement('button')
      confirmBtn.type = 'button'
      confirmBtn.className = 'diary-action-btn danger'
      confirmBtn.textContent = 'Confirm delete'
      confirmBtn.disabled = !canMutate || diaryBusy
      confirmBtn.addEventListener('click', () => {
        if (!canMutate) return
        diaryDeleteConfirmId = null
        setDiaryBusy(true)
        renderDiaryModal()
        if (!sendFrame({ v: PROTOCOL_VERSION, type: 'diary.delete', id: entry.id })) {
          setDiaryBusy(false)
          renderDiaryModal()
          toast('Could not send to the companion')
        }
      })

      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'diary-action-btn'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.addEventListener('click', () => {
        diaryDeleteConfirmId = null
        renderDiaryModal()
      })
      actions.append(confirmBtn, cancelBtn)
    } else {
      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'diary-action-btn danger-text'
      deleteBtn.textContent = 'Delete'
      deleteBtn.disabled = !canMutate || diaryBusy
      deleteBtn.addEventListener('click', () => {
        diaryDeleteConfirmId = entry.id
        renderDiaryModal()
      })
      actions.appendChild(deleteBtn)
    }

    card.append(head, contentEl, actions)
    els.diaryList.appendChild(card)
  }

  els.diaryClearSuppressed.classList.toggle('hidden', diaryState.suppressedCount === 0)
  els.diaryClearSuppressed.disabled = !canMutate || diaryBusy
}

function renderDiarySuggestCard() {
  const card = els.diarySuggestCard
  if (!card) return
  if (diarySuggestions.length === 0 || confirmRequest !== null) {
    card.replaceChildren()
    card.classList.add('hidden')
    return
  }

  card.replaceChildren()
  const head = document.createElement('div')
  head.className = 'diary-suggest-head'

  const heading = document.createElement('span')
  heading.className = 'diary-suggest-badge'
  heading.textContent = diarySuggestions.length === 1
    ? 'Diary suggestion'
    : `Diary suggestions (${diarySuggestions.length})`

  const dismissAll = document.createElement('button')
  dismissAll.type = 'button'
  dismissAll.className = 'diary-suggest-close'
  dismissAll.textContent = '×'
  dismissAll.title = 'Dismiss all diary suggestions'
  dismissAll.setAttribute('aria-label', 'Dismiss all diary suggestions')
  dismissAll.addEventListener('click', () => {
    if (!connected) {
      toast('Not connected to the companion')
      return
    }
    if (diaryUnsupportedByCompanion()) {
      toast('Restart the companion to use Diary (the running companion predates Diary support).')
      return
    }
    diarySuggestEditingId = null
    diarySuggestPendingIds.clear()
    if (!sendFrame({ v: PROTOCOL_VERSION, type: 'diary.suggestion.dismiss', all: true })) {
      toast('Could not send to the companion')
    }
  })

  head.append(heading, dismissAll)
  card.appendChild(head)

  const canMutate = diaryCanMutate()

  for (const sug of diarySuggestions) {
    const pending = diarySuggestPendingIds.has(sug.id)
    const row = document.createElement('div')
    row.className = 'diary-suggest-item'
    row.dataset.suggestionId = sug.id

    if (diarySuggestEditingId === sug.id) {
      let editScope = sug.scope === 'site' ? 'site' : 'global'
      const form = document.createElement('div')
      form.className = 'diary-suggest-edit'

      const scopeRow = document.createElement('div')
      scopeRow.className = 'diary-scope-toggle'
      const globalBtn = document.createElement('button')
      globalBtn.type = 'button'
      globalBtn.textContent = 'Global'
      const siteBtn = document.createElement('button')
      siteBtn.type = 'button'
      siteBtn.textContent = 'Specific site(s)'

      const sitesInput = document.createElement('input')
      sitesInput.type = 'text'
      sitesInput.className = 'diary-suggest-input'
      sitesInput.placeholder = 'kimi.ai, chat.kimi.ai'
      sitesInput.value = (sug.sites ?? []).join(', ')
      sitesInput.setAttribute('aria-label', 'Suggestion websites')

      const syncScope = nextScope => {
        editScope = nextScope
        globalBtn.classList.toggle('active', nextScope === 'global')
        siteBtn.classList.toggle('active', nextScope === 'site')
        sitesInput.classList.toggle('hidden', nextScope !== 'site')
      }
      globalBtn.addEventListener('click', () => syncScope('global'))
      siteBtn.addEventListener('click', () => syncScope('site'))
      scopeRow.append(globalBtn, siteBtn)

      const titleInput = document.createElement('input')
      titleInput.type = 'text'
      titleInput.className = 'diary-suggest-input'
      titleInput.maxLength = 80
      titleInput.value = sug.title
      titleInput.placeholder = 'Title'
      titleInput.setAttribute('aria-label', 'Suggestion title')

      const contentInput = document.createElement('textarea')
      contentInput.className = 'diary-suggest-textarea'
      contentInput.rows = 2
      contentInput.maxLength = DIARY_CONTENT_MAX_CHARS
      contentInput.value = sug.content
      contentInput.placeholder = 'Instructions or note'
      contentInput.setAttribute('aria-label', 'Suggestion note')

      const errEl = document.createElement('p')
      errEl.className = 'diary-editor-error hidden'

      const actions = document.createElement('div')
      actions.className = 'diary-suggest-actions'

      const saveBtn = document.createElement('button')
      saveBtn.type = 'button'
      saveBtn.className = 'primary diary-suggest-btn'
      saveBtn.textContent = 'Save'
      saveBtn.disabled = !canMutate || pending

      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'secondary diary-suggest-btn'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.disabled = pending
      cancelBtn.addEventListener('click', () => {
        diarySuggestEditingId = null
        renderDiarySuggestCard()
      })

      saveBtn.addEventListener('click', () => {
        if (!connected) {
          toast('Not connected to the companion')
          return
        }
        if (diaryUnsupportedByCompanion()) {
          errEl.textContent = 'Restart the companion to use Diary (the running companion predates Diary support).'
          errEl.classList.remove('hidden')
          return
        }
        let sites = []
        if (editScope === 'site') {
          const parsed = parseSitesInput(sitesInput.value)
          if (parsed.invalid.length > 0) {
            errEl.textContent = `Invalid website: ${parsed.invalid.slice(0, 3).join(', ')}`
            errEl.classList.remove('hidden')
            return
          }
          if (parsed.tooMany || parsed.sites.length === 0) {
            errEl.textContent = parsed.tooMany ? 'At most 5 websites allowed.' : 'Enter at least one valid website domain.'
            errEl.classList.remove('hidden')
            return
          }
          sites = parsed.sites
        }
        const title = titleInput.value.trim()
        const content = contentInput.value.trim()
        if (!title || !content) {
          errEl.textContent = 'Title and note text are required.'
          errEl.classList.remove('hidden')
          return
        }
        errEl.classList.add('hidden')
        diarySuggestPendingIds.add(sug.id)
        const prevEditingId = diarySuggestEditingId
        diarySuggestEditingId = null
        setDiaryBusy(true)
        renderDiarySuggestCard()
        if (!sendFrame({
          v: PROTOCOL_VERSION,
          type: 'diary.suggestion.accept',
          id: sug.id,
          scope: editScope,
          sites,
          title,
          content,
        })) {
          diarySuggestPendingIds.delete(sug.id)
          diarySuggestEditingId = prevEditingId
          setDiaryBusy(false)
          renderDiarySuggestCard()
          toast('Could not send to the companion')
        }
      })

      syncScope(editScope)
      actions.append(cancelBtn, saveBtn)
      form.append(scopeRow, sitesInput, titleInput, contentInput, errEl, actions)
      row.appendChild(form)
      card.appendChild(row)
      continue
    }

    const meta = document.createElement('div')
    meta.className = 'diary-suggest-meta'
    const scopeBadge = document.createElement('span')
    scopeBadge.className = sug.scope === 'site' ? 'diary-badge diary-badge-site' : 'diary-badge diary-badge-global'
    scopeBadge.textContent = sug.scope === 'site' ? sug.sites.join(', ') : 'Global'
    meta.appendChild(scopeBadge)
    if (sug.action === 'update') {
      const updateBadge = document.createElement('span')
      updateBadge.className = 'diary-tag diary-tag-update'
      updateBadge.textContent = 'Update'
      meta.appendChild(updateBadge)
    }

    const questionEl = document.createElement('p')
    questionEl.className = 'diary-suggest-question'
    questionEl.textContent = sug.question

    const preview = document.createElement('div')
    preview.className = 'diary-suggest-preview'
    const titleEl = document.createElement('strong')
    titleEl.className = 'diary-suggest-title'
    titleEl.textContent = sug.title
    const contentEl = document.createElement('p')
    contentEl.className = 'diary-suggest-content'
    contentEl.textContent = sug.content
    preview.append(titleEl, contentEl)

    row.append(meta, questionEl, preview)

    if (sug.action === 'update' && sug.previousEntry) {
      const prevEl = document.createElement('p')
      prevEl.className = 'diary-suggest-prev'
      prevEl.textContent = `Replaces: ${sug.previousEntry.title} — ${sug.previousEntry.content}`
      row.appendChild(prevEl)
    }

    const actions = document.createElement('div')
    actions.className = 'diary-suggest-actions'

    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'primary diary-suggest-btn'
    saveBtn.textContent = sug.action === 'update' ? 'Update' : 'Save'
    saveBtn.disabled = !canMutate || pending
    saveBtn.addEventListener('click', () => {
      if (!connected) {
        toast('Not connected to the companion')
        return
      }
      if (diaryUnsupportedByCompanion()) {
        toast('Restart the companion to use Diary (the running companion predates Diary support).')
        return
      }
      diarySuggestPendingIds.add(sug.id)
      setDiaryBusy(true)
      renderDiarySuggestCard()
      if (!sendFrame({ v: PROTOCOL_VERSION, type: 'diary.suggestion.accept', id: sug.id })) {
        diarySuggestPendingIds.delete(sug.id)
        setDiaryBusy(false)
        renderDiarySuggestCard()
        toast('Could not send to the companion')
      }
    })

    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'secondary diary-suggest-btn'
    editBtn.textContent = 'Edit'
    editBtn.disabled = pending
    editBtn.addEventListener('click', () => {
      diarySuggestEditingId = sug.id
      renderDiarySuggestCard()
    })

    const dismissBtn = document.createElement('button')
    dismissBtn.type = 'button'
    dismissBtn.className = 'secondary diary-suggest-btn'
    dismissBtn.textContent = 'Dismiss'
    dismissBtn.disabled = !canMutate || pending
    dismissBtn.addEventListener('click', () => {
      if (!connected) {
        toast('Not connected to the companion')
        return
      }
      if (diaryUnsupportedByCompanion()) {
        toast('Restart the companion to use Diary (the running companion predates Diary support).')
        return
      }
      diarySuggestPendingIds.add(sug.id)
      setDiaryBusy(true)
      renderDiarySuggestCard()
      if (!sendFrame({ v: PROTOCOL_VERSION, type: 'diary.suggestion.dismiss', id: sug.id })) {
        diarySuggestPendingIds.delete(sug.id)
        setDiaryBusy(false)
        renderDiarySuggestCard()
        toast('Could not send to the companion')
      }
    })

    actions.append(dismissBtn, editBtn, saveBtn)
    row.appendChild(actions)
    card.appendChild(row)
  }

  card.classList.remove('hidden')
}

/* ------------------------------------------------------------------ */
/* debug log stats and export (inside Settings)                        */
/* ------------------------------------------------------------------ */

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

function flashSettingsStatus(text) {
  if (!els.settingsStatus) return
  els.settingsStatus.textContent = text
  clearTimeout(settingsStatusTimer)
  settingsStatusTimer = setTimeout(() => {
    if (els.settingsStatus) els.settingsStatus.textContent = ''
    settingsStatusTimer = null
  }, 1_800)
}

function syncCompanionToggle(key, value) {
  if (connected) {
    sentCompanionSettings[key] = value
    sendFrame({ v: PROTOCOL_VERSION, type: 'settings.update', [key]: value })
    flashSettingsStatus('Saved')
  } else {
    flashSettingsStatus('Connect to save')
  }
}

els.settingConfirmIrreversible.addEventListener('change', () => {
  syncCompanionToggle('confirmIrreversible', els.settingConfirmIrreversible.checked)
})
els.settingWatchAutoSteer?.addEventListener('change', () => {
  syncCompanionToggle('watchAutoSteer', els.settingWatchAutoSteer.checked)
})
els.settingDiaryAutoSuggest?.addEventListener('change', () => {
  syncCompanionToggle('diaryAutoSuggest', els.settingDiaryAutoSuggest.checked)
})
els.settingAutoCapture.addEventListener('change', () => {
  settings = { ...settings, autoCapture: els.settingAutoCapture.checked }
  void saveSettings()
  flashSettingsStatus('Saved')
})
els.settingVerboseActivity?.addEventListener('change', () => {
  settings = { ...settings, verboseActivity: els.settingVerboseActivity.checked }
  applyVerboseActivityMode()
  void saveSettings()
  flashSettingsStatus('Saved')
})

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
    if (els.settingsAdvanced) els.settingsAdvanced.open = true
    toast('Bridge URL must start with ws:// or wss://')
    return
  }
  if (token.length === 0) {
    if (els.settingsAdvanced) els.settingsAdvanced.open = true
    toast('Paste the pairing token printed by npm run dev')
    return
  }
  if (!/^https?:\/\//u.test(baseUrl)) {
    if (els.settingsAdvanced) els.settingsAdvanced.open = true
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
    if (els.settingsAdvanced) els.settingsAdvanced.open = true
    toast('Capture width must be between 640 and 2048')
    return
  }
  if (!Number.isFinite(quality) || quality < 40 || quality > 90) {
    if (els.settingsAdvanced) els.settingsAdvanced.open = true
    toast('JPEG quality must be between 40 and 90')
    return
  }
  const reconnectNeeded = settings.bridgeUrl !== url || settings.token !== token
  const modelChanged = model !== (llmState.model?.id ?? '') || baseUrl !== (llmState.baseUrl ?? settings.modelBaseUrl)
  const effortChanged = reasoningEffort !== (llmState.reasoningEffort ?? 'auto')
  const llmUpdate = (modelChanged || effortChanged || apiKey.length > 0)
    ? { baseUrl, model, remember, reasoningEffort, ...(apiKey.length > 0 ? { apiKey } : {}) }
    : null
  // Reconfiguring the provider mid-turn flips the panel into a non-stoppable
  // "Configuring…" state and then reports idle when llm.configured lands, while
  // the turn keeps streaming. Keep the live turn in charge instead.
  if (busy && (llmUpdate !== null || reconnectNeeded)) {
    toast('Wait for the current turn to finish before changing the connection, model, or key')
    return
  }

  settings = {
    ...settings,
    bridgeUrl: url,
    token,
    captureWidth: Math.round(width),
    quality: Math.round(quality),
    autoCapture: els.settingAutoCapture.checked,
    verboseActivity: els.settingVerboseActivity ? els.settingVerboseActivity.checked : isVerboseActivity(),
    modelBaseUrl: baseUrl,
    modelId: model,
  }
  applyVerboseActivityMode()
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
  // Behavior settings live in the companion, not in local storage.
  const confirmChanged = els.settingConfirmIrreversible.checked !== (sentCompanionSettings.confirmIrreversible ?? companionSettings.confirmIrreversible)
  const watchAutoSteerChecked = els.settingWatchAutoSteer ? els.settingWatchAutoSteer.checked : companionSettings.watchAutoSteer
  const watchSteerChanged = watchAutoSteerChecked !== (sentCompanionSettings.watchAutoSteer ?? companionSettings.watchAutoSteer)
  const diaryAutoSuggestChecked = els.settingDiaryAutoSuggest ? els.settingDiaryAutoSuggest.checked : companionSettings.diaryAutoSuggest
  const diaryAutoSuggestChanged = diaryAutoSuggestChecked !== (sentCompanionSettings.diaryAutoSuggest ?? companionSettings.diaryAutoSuggest)
  if (confirmChanged || watchSteerChanged || diaryAutoSuggestChanged) {
    if (connected) {
      sendFrame({
        v: PROTOCOL_VERSION,
        type: 'settings.update',
        ...(confirmChanged ? { confirmIrreversible: els.settingConfirmIrreversible.checked } : {}),
        ...(watchSteerChanged ? { watchAutoSteer: watchAutoSteerChecked } : {}),
        ...(diaryAutoSuggestChanged ? { diaryAutoSuggest: diaryAutoSuggestChecked } : {}),
      })
    } else {
      toast('Connect to the companion to change behavior settings')
    }
  }
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
    const src = imageDataUrl(cleanImageFor(result.image) ?? result.image)
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
els.confirmApprove.addEventListener('click', () => sendConfirmation('approve'))
els.confirmDeny.addEventListener('click', () => sendConfirmation('deny'))
els.settingsClose.addEventListener('click', closeSettings)
els.settingsDebugLog?.addEventListener('toggle', () => {
  if (!els.settingsDebugLog.open) return
  logger.log('log.section.open', {}, 'debug')
  if (!connected) {
    els.logStats.textContent = 'Companion offline. Start it with npm run dev, then reconnect to export logs.'
    els.logSignals.replaceChildren()
    return
  }
  els.logStats.textContent = 'Requesting log stats…'
  els.logSignals.replaceChildren()
  sendFrame({ v: PROTOCOL_VERSION, type: 'log.stats' })
})
els.diary.addEventListener('click', openDiary)
els.diaryClose.addEventListener('click', closeDiary)
els.diaryModal.addEventListener('click', event => {
  if (event.target === els.diaryModal) closeDiary()
})
els.diarySearch.addEventListener('input', () => renderDiaryModal())
for (const button of els.diaryFilters) {
  button.addEventListener('click', () => {
    diaryFilter = button.dataset.diaryFilter ?? 'all'
    renderDiaryModal()
  })
}
els.diaryAdd.addEventListener('click', () => openDiaryEditor(null))
els.diaryScopeGlobal.addEventListener('click', () => setDiaryEditorScope('global'))
els.diaryScopeSite.addEventListener('click', () => setDiaryEditorScope('site'))
els.diaryUseCurrentTab.addEventListener('click', () => {
  const host = siteFromTabUrl(currentActiveTabUrl)
  if (host === null) return
  const existing = parseSitesInput(els.diaryFieldSites.value).sites
  if (existing.includes(host)) return
  els.diaryFieldSites.value = existing.length > 0 ? `${existing.join(', ')}, ${host}` : host
  showDiaryEditorError('')
})
els.diaryFieldContent.addEventListener('input', updateDiaryContentCount)
els.diaryEditorCancel.addEventListener('click', closeDiaryEditor)
els.diaryEditor.addEventListener('submit', event => {
  event.preventDefault()
  if (!connected) {
    showDiaryEditorError('Connect to the companion before saving.')
    return
  }
  if (diaryUnsupportedByCompanion()) {
    showDiaryEditorError('Restart the companion to use Diary (the running companion predates Diary support).')
    return
  }
  if (diaryBusy) return
  let sites = []
  if (diaryEditorScope === 'site') {
    const parsedSites = parseSitesInput(els.diaryFieldSites.value)
    if (parsedSites.invalid.length > 0) {
      showDiaryEditorError(`Invalid website domain${parsedSites.invalid.length === 1 ? '' : 's'}: ${parsedSites.invalid.slice(0, 3).join(', ')}.`)
      return
    }
    if (parsedSites.tooMany) {
      showDiaryEditorError('At most 5 websites are allowed per diary entry.')
      return
    }
    if (parsedSites.sites.length === 0) {
      showDiaryEditorError('Enter at least one valid website domain (for example, kimi.ai).')
      return
    }
    sites = parsedSites.sites
  }
  const title = els.diaryFieldTitle.value.trim()
  if (title.length === 0) {
    showDiaryEditorError('Title is required.')
    return
  }
  const content = els.diaryFieldContent.value.trim()
  if (content.length === 0) {
    showDiaryEditorError('Note text is required.')
    return
  }
  showDiaryEditorError('')
  setDiaryBusy(true)
  diaryEditorAwaitingSave = true
  els.diaryEditorSave.disabled = true
  const frame = diaryEditingId !== null
    ? {
      v: PROTOCOL_VERSION,
      type: 'diary.update',
      id: diaryEditingId,
      scope: diaryEditorScope,
      sites,
      title,
      content,
      enabled: diaryEditingEnabled,
    }
    : {
      v: PROTOCOL_VERSION,
      type: 'diary.create',
      scope: diaryEditorScope,
      sites,
      title,
      content,
    }
  if (!sendFrame(frame)) {
    setDiaryBusy(false)
    diaryEditorAwaitingSave = false
    els.diaryEditorSave.disabled = !diaryCanMutate()
    showDiaryEditorError('Could not send to the companion. Check that the companion is running.')
  }
})
els.diaryClearSuppressed.addEventListener('click', () => {
  if (!diaryCanMutate() || diaryBusy) return
  setDiaryBusy(true)
  renderDiaryModal()
  if (!sendFrame({ v: PROTOCOL_VERSION, type: 'diary.suppressed.clear' })) {
    setDiaryBusy(false)
    renderDiaryModal()
    toast('Could not send to the companion')
    return
  }
  toast('Cleared dismissed suggestion history')
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
els.recentSessionsAll.addEventListener('click', openHistory)
els.historyClose.addEventListener('click', closeHistory)
els.historyCurrent.addEventListener('click', closeHistory)
els.historySearch.addEventListener('input', renderHistory)
els.historyModal.addEventListener('click', event => {
  if (event.target === els.historyModal) closeHistory()
})
els.composerModel.addEventListener('click', () => {
  if (els.modelMenu.classList.contains('hidden')) openModelMenu()
  else closeModelMenu()
})
els.modelSearch.addEventListener('input', renderModelMenu)
els.modelSearch.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault()
    els.modelMenuList.querySelector('.model-menu-item')?.click()
  }
})
els.mic.addEventListener('click', toggleDictation)
els.marathonModeCancel.addEventListener('click', () => {
  if (!marathonState.enabled) return
  if (!connected) {
    toast('Not connected to the companion')
    return
  }
  if (sendFrame({ v: PROTOCOL_VERSION, type: 'marathon.set', enabled: false })) {
    logger.log('ui.marathon.cancel', {}, 'info')
  }
  els.input.focus({ preventScroll: true })
})
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
els.utilitiesToggle?.addEventListener('click', () => {
  if (!els.app.classList.contains('chat-open')) return
  setUtilitiesOpen(!els.app.classList.contains('utilities-open'))
})
document.addEventListener('click', event => {
  if (els.app.classList.contains('utilities-open') && !els.topbar?.contains(event.target)) {
    setUtilitiesOpen(false)
  }
  // A click that runs a slash command may open the model picker, so the
  // palette itself must not count as an outside click. Dismissing the picker
  // from outside hands focus back to the composer instead of dropping it.
  const outsideModelMenu = !els.modelMenu.contains(event.target)
    && !els.composerModel.contains(event.target)
    && !els.slashMenu.contains(event.target)
  if (outsideModelMenu && !els.modelMenu.classList.contains('hidden')) {
    closeModelMenu({ focusComposer: true })
  }
  if (!event.target.closest('.model-field')) els.modelOptions.classList.add('hidden')
  if (slashMenuOpen && !els.slashMenu.contains(event.target) && event.target !== els.input) closeSlashMenu()
})
els.imageClose.addEventListener('click', closeImage)
els.imageModal.addEventListener('click', event => {
  if (event.target === els.imageModal) closeImage()
})
els.disclaimerDismiss.addEventListener('click', dismissDisclaimer)
els.disclaimer.addEventListener('cancel', event => {
  // Escape while the disclaimer is open should only close the disclaimer.
  event.preventDefault()
  dismissDisclaimer()
})
els.settingsModal.addEventListener('click', event => {
  if (event.target === els.settingsModal) closeSettings()
})

els.bannerAction.addEventListener('click', () => {
  const action = bannerAction
  hideBanner()
  action()
})
els.updateNoticeDismiss.addEventListener('click', () => {
  const key = els.updateNotice.dataset.noticeKey
  if (key) {
    updateNoticePrefs.dismissed = key
    saveUpdateNoticePrefs()
  }
  els.updateNotice.classList.add('hidden')
})

els.newChat.addEventListener('click', () => {
  if (newChat()) pulseNewChat()
})
els.backHome.addEventListener('click', newChat)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (connected) newChat()
  else newChatOnNextConnect = true
})
els.stop.addEventListener('click', () => {
  steeringMessageId = null
  stopTurn()
})

els.composerShell?.addEventListener('pointerenter', handleComposerAuraPointer)
els.composerShell?.addEventListener('pointermove', handleComposerAuraPointer)
els.composerShell?.addEventListener('pointerleave', () => {
  interactiveAura.hovering = false
})

els.input.addEventListener('input', event => {
  resizeInput()
  renderSlashMenu()
  pulseInteractiveTyping(0.56)
  if (event.isTrusted) stopDictation()
})
els.input.addEventListener('blur', () => closeSlashMenu())
els.input.addEventListener('keydown', event => {
  // Enter during IME composition confirms the candidate, not the draft.
  if (event.isComposing) return
  if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete')) {
    pulseInteractiveTyping(0.36)
  }
  if (slashMenuOpen) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSlashSelection(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault()
      executeSlashCommand(slashMenuMatches[slashMenuIndex])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeSlashMenu()
      return
    }
  }
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
    if (els.disclaimer.open) {
      event.preventDefault()
      dismissDisclaimer()
    } else if (slashMenuOpen) closeSlashMenu()
    else if (!els.modelMenu.classList.contains('hidden')) closeModelMenu({ focusComposer: true })
    else if (!els.modelOptions.classList.contains('hidden')) els.modelOptions.classList.add('hidden')
    else if (!els.imageModal.classList.contains('hidden')) closeImage()
    else if (!els.historyModal.classList.contains('hidden')) closeHistory()
    else if (!els.diaryModal.classList.contains('hidden')) {
      if (diaryEditorOpen) closeDiaryEditor()
      else closeDiary()
    }
    else if (!els.settingsModal.classList.contains('hidden')) closeSettings()
    else if (els.app.classList.contains('utilities-open')) {
      setUtilitiesOpen(false)
      if (els.topbar?.contains(document.activeElement)) els.utilitiesToggle?.blur()
    }
  }
})

window.addEventListener('beforeunload', () => {
  if (stopping || conversationStopped) archiveCurrentConversation({ immediate: true })
  else if (historySaveTimer !== null) persistHistory(true)
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
  await showDisclaimerIfPending()
  await loadSettings()
  await loadHistory()
  populateSettings()
  setEffortSelection(settings.reasoningEffort ?? 'auto')
  renderComposerModel()
  renderImageChips()
  updateComposerDraftState()
  syncUtilitiesAria()
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
  await claimExecutor()
  connect()
  logger.log('app.boot.ready', {}, 'info')
}

void boot()