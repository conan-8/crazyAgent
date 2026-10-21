// Side panel behavior and activity badge. The side panel owns the bridge
// WebSocket; this worker only makes the panel easy to open and shows when the
// agent is actively looking at the page.

async function enablePanelOnAction() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  } catch (error) {
    // Older Chrome versions still allow opening the panel from the toolbar menu.
    console.warn('sidePanel.setPanelBehavior failed', error)
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void enablePanelOnAction()
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