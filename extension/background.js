// Side panel behavior, activity badge, and the panel-less executor. An open
// side panel owns the bridge WebSocket; when none is open this worker runs the
// browser commands itself (background-executor.js) so a phone can use the
// agent. It also flags the one-time disclaimer shown after an install/reload.

import { BackgroundExecutor, EXECUTOR_ALARM, PANEL_PORT_NAME, SETTINGS_KEY } from './background-executor.js'
import { DEFAULT_SETTINGS, beginDebuggerRun, displayImageField, endDebuggerRun, execute } from './sidepanel/browser.js'

const DISCLAIMER_PENDING_KEY = 'crazyagent.disclaimerPending'

async function enablePanelOnAction() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  } catch (error) {
    // Older Chrome versions still allow opening the panel from the toolbar menu.
    console.warn('sidePanel.setPanelBehavior failed', error)
  }
}

// A fresh install or an unpacked-extension reload counts as a new load, so the
// next panel open should show the disclaimer once. Browser restarts, Chrome
// updates, and ordinary panel opens must not bring it back.
async function flagDisclaimerPending(reason) {
  if (reason !== 'install' && reason !== 'update') return
  try {
    await chrome.storage.local.set({ [DISCLAIMER_PENDING_KEY]: true })
  } catch (error) {
    console.warn('could not flag the one-time disclaimer', error)
  }
}

function setBadge(active) {
  void chrome.action.setBadgeBackgroundColor({ color: '#e8590c' })
  void chrome.action.setBadgeText({ text: active ? 'ON' : '' })
}

const executor = new BackgroundExecutor({
  loadSettings: async () => {
    const stored = await chrome.storage.local.get(SETTINGS_KEY)
    return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}), paused: false }
  },
  isPanelOpen: async () => {
    const contexts = await chrome.runtime.getContexts({})
    return contexts.some(context => context.documentUrl?.includes('/sidepanel/index.html'))
  },
  execute,
  displayImageField,
  beginRun: beginDebuggerRun,
  endRun: endDebuggerRun,
  setBadge,
})

// Registered synchronously: these are what wake a stopped worker.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== PANEL_PORT_NAME) return
  executor.panelConnected(port)
  port.onDisconnect.addListener(() => executor.panelDisconnected(port))
})
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === EXECUTOR_ALARM) void executor.tick()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) void executor.tick()
})

// Wakes the worker after Chrome stops it, and notices a companion that started later.
void chrome.alarms.create(EXECUTOR_ALARM, { periodInMinutes: 0.5 })
void executor.tick()

chrome.runtime.onInstalled.addListener(details => {
  void enablePanelOnAction()
  void flagDisclaimerPending(details?.reason)
})
chrome.runtime.onStartup.addListener(() => {
  void enablePanelOnAction()
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'activity') {
    const active = message.active === true
    chrome.action.setBadgeBackgroundColor({ color: '#e8590c' })
    chrome.action.setBadgeText({ text: active ? 'ON' : '' })
    sendResponse({ ok: true })
    return true
  }
  if (message?.type === 'open-settings') {
    sendResponse({ ok: true })
    return true
  }
  return false
})