// Side panel behavior and activity badge. The side panel owns the bridge
// WebSocket; this worker only makes the panel easy to open, shows when the
// agent is actively looking at the page, and flags the one-time disclaimer
// that the panel shows after the extension is installed or reloaded.

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