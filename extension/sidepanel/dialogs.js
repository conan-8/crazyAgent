const DIALOG_REPORT_LIMIT = 40
const AUTO_ACCEPT_TIMEOUT_MS = 2_000

function dialogError(code, message, dialog) {
  const error = new Error(message)
  error.code = code
  if (dialog !== undefined) error.dialog = dialog
  return error
}

function dialogDetails(record, status) {
  return {
    id: record.id,
    tabId: record.tabId,
    type: record.type,
    message: record.message,
    url: record.url,
    ...(record.defaultPrompt === undefined ? {} : { defaultPrompt: record.defaultPrompt }),
    status,
    ...(record.autoError === undefined ? {} : { handleError: record.autoError }),
  }
}

/** Tracks native JavaScript dialogs for tabs with an active CDP attachment. */
export class DialogManager {
  constructor(options = {}) {
    this.onBlockingDialog = options.onBlockingDialog ?? (() => {})
    this.autoAcceptTimeoutMs = options.autoAcceptTimeoutMs ?? AUTO_ACCEPT_TIMEOUT_MS
    this.reportLimit = options.reportLimit ?? DIALOG_REPORT_LIMIT
    this.attachments = new Set()
    this.states = new Map()
    this.navigationIntent = new Set()
    this.waiters = new Map()
    this.reports = []
    this.sequence = 0
    this.nextId = 1
    this.watching = false
    this.eventListener = (source, method, params) => this.onDebuggerEvent(source, method, params)
    this.detachListener = source => {
      if (source?.tabId !== undefined && this.attachments.has(source.tabId)) this.detach(source.tabId)
    }
    this.removeListener = tabId => {
      this.states.delete(tabId)
      this.detach(tabId)
    }
    this.updateListener = (tabId, changeInfo) => {
      if (changeInfo?.url === undefined) return
      this.states.delete(tabId)
      this.navigationIntent.delete(tabId)
      this.unwatch()
    }
  }

  cursor() {
    return this.sequence
  }

  watch() {
    if (this.watching || typeof globalThis.chrome?.debugger?.sendCommand !== 'function' || !globalThis.chrome?.debugger?.onEvent) return
    this.watching = true
    chrome.debugger.onEvent.addListener(this.eventListener)
    chrome.debugger.onDetach?.addListener(this.detachListener)
    chrome.tabs?.onRemoved?.addListener(this.removeListener)
    chrome.tabs?.onUpdated?.addListener(this.updateListener)
  }

  unwatch() {
    if (!this.watching || this.attachments.size > 0 || this.states.size > 0) return
    chrome.debugger.onEvent.removeListener(this.eventListener)
    chrome.debugger.onDetach?.removeListener(this.detachListener)
    chrome.tabs?.onRemoved?.removeListener(this.removeListener)
    chrome.tabs?.onUpdated?.removeListener(this.updateListener)
    this.watching = false
  }

  async attach(tabId) {
    if (this.attachments.has(tabId)) return
    this.watch()
    if (!this.watching) return
    this.attachments.add(tabId)
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable')
    } catch (error) {
      this.attachments.delete(tabId)
      this.unwatch()
      throw error
    }
  }

  detach(tabId) {
    this.attachments.delete(tabId)
    this.navigationIntent.delete(tabId)
    const active = this.states.get(tabId)?.active
    if (!active || active.resolved || active.automatic) this.states.delete(tabId)
    this.rejectWaiters(tabId, dialogError('DIALOG_DETACHED', 'The debugger detached while waiting for a JavaScript dialog'))
    this.unwatch()
  }

  pending(tabId) {
    const record = this.states.get(tabId)?.active
    if (!record || record.resolved || (record.automatic && record.autoError === undefined)) return undefined
    return dialogDetails(record, 'pending')
  }

  expectBeforeUnload(tabId) {
    this.navigationIntent.add(tabId)
  }

  clearBeforeUnloadIntent(tabId) {
    this.navigationIntent.delete(tabId)
  }

  takeReports(cursor) {
    const taken = this.reports.filter(report => report.sequence > cursor)
    if (taken.length > 0) this.reports = this.reports.filter(report => report.sequence <= cursor)
    return taken.map(report => ({ ...report.dialog }))
  }

  recordReport(record, result) {
    this.reports.push({ sequence: record.sequence, tabId: record.tabId, dialog: result })
    if (this.reports.length > this.reportLimit) this.reports.splice(0, this.reports.length - this.reportLimit)
  }

  complete(record, close = {}) {
    if (record.result !== undefined) return record.result
    const accepted = close.result === undefined ? record.requestedAction !== 'dismiss' : close.result === true
    const action = accepted ? 'accept' : 'dismiss'
    const userInput = close.userInput ?? (accepted ? record.promptText : undefined)
    const result = {
      ...dialogDetails(record, 'resolved'),
      action,
      automatic: record.automatic === true,
      ...(userInput === undefined ? {} : { userInput }),
    }
    record.resolved = true
    record.result = result
    if (this.states.get(record.tabId)?.active === record) this.states.delete(record.tabId)
    this.recordReport(record, result)
    return result
  }

  notifyPending(record) {
    const pending = dialogDetails(record, 'pending')
    this.onBlockingDialog(record.tabId, pending)
    this.rejectWaiters(record.tabId, dialogError(
      'DIALOG_PENDING',
      `A JavaScript ${record.type} dialog is pending: ${record.message}`,
      pending,
    ))
  }

  async handleAutomatic(record) {
    let timer
    try {
      await Promise.race([
        chrome.debugger.sendCommand({ tabId: record.tabId }, 'Page.handleJavaScriptDialog', { accept: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out while auto-accepting the dialog')), this.autoAcceptTimeoutMs)
        }),
      ])
      this.complete(record, { result: true })
    } catch (error) {
      record.automatic = false
      record.autoError = error instanceof Error ? error.message : String(error)
      if (!this.attachments.has(record.tabId)) return
      this.states.set(record.tabId, { active: record })
      this.notifyPending(record)
    } finally {
      clearTimeout(timer)
    }
  }

  onDebuggerEvent(source, method, params) {
    const tabId = source?.tabId
    if (tabId === undefined || !this.attachments.has(tabId)) return
    if (method === 'Page.javascriptDialogClosed') {
      const record = this.states.get(tabId)?.active
      if (record) this.complete(record, params ?? {})
      return
    }
    if (method !== 'Page.javascriptDialogOpening') return
    const type = typeof params?.type === 'string' ? params.type : 'unknown'
    const automatic = type === 'alert' || (type === 'beforeunload' && this.navigationIntent.delete(tabId))
    const record = {
      id: this.nextId++,
      sequence: ++this.sequence,
      tabId,
      type,
      message: typeof params?.message === 'string' ? params.message : '',
      url: typeof params?.url === 'string' ? params.url : '',
      ...(typeof params?.defaultPrompt === 'string' ? { defaultPrompt: params.defaultPrompt } : {}),
      automatic,
      resolved: false,
    }
    this.states.set(tabId, { active: record })
    if (automatic) record.handling = this.handleAutomatic(record)
    else this.notifyPending(record)
  }

  async waitForAutomatic(tabId) {
    const records = [...this.states.values()]
      .map(state => state.active)
      .filter(record => record && (tabId === undefined || record.tabId === tabId) && record.automatic && record.handling)
    if (records.length > 0) await Promise.allSettled(records.map(record => record.handling))
  }

  waitForPending(tabId) {
    const current = this.pending(tabId)
    if (current) {
      return {
        promise: Promise.reject(dialogError('DIALOG_PENDING', `A JavaScript ${current.type} dialog is pending: ${current.message}`, current)),
        cancel: () => {},
      }
    }
    let entry
    const promise = new Promise((_, reject) => {
      entry = { reject }
      const entries = this.waiters.get(tabId) ?? new Set()
      entries.add(entry)
      this.waiters.set(tabId, entries)
    })
    return {
      promise,
      cancel: () => {
        const entries = this.waiters.get(tabId)
        entries?.delete(entry)
        if (entries?.size === 0) this.waiters.delete(tabId)
      },
    }
  }

  rejectWaiters(tabId, error) {
    const entries = this.waiters.get(tabId)
    if (!entries) return
    this.waiters.delete(tabId)
    for (const entry of entries) entry.reject(error)
  }

  async racePending(tabId, promise) {
    const waiter = this.waitForPending(tabId)
    try {
      return await Promise.race([promise, waiter.promise])
    } finally {
      waiter.cancel()
    }
  }

  async resolve(tabId, action, promptText) {
    const record = this.states.get(tabId)?.active
    const pending = this.pending(tabId)
    if (!record || !pending) throw dialogError('NO_DIALOG', 'There is no pending JavaScript dialog in the active tab')
    record.requestedAction = action
    if (action === 'accept' && promptText !== undefined) record.promptText = promptText
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
        accept: action === 'accept',
        ...(action === 'accept' && promptText !== undefined ? { promptText } : {}),
      })
    } catch (error) {
      if (record.result !== undefined) return record.result
      throw dialogError('DIALOG_HANDLE_FAILED', `Chrome could not resolve the JavaScript dialog: ${error instanceof Error ? error.message : String(error)}`, pending)
    }
    return this.complete(record, { result: action === 'accept', ...(promptText === undefined ? {} : { userInput: promptText }) })
  }
}
