import test from 'node:test'
import assert from 'node:assert/strict'
import { DialogManager } from '../sidepanel/dialogs.js'
import { beginDebuggerRun, endDebuggerRun, execute, parseDialogArgs, withDebugger } from '../sidepanel/browser.js'

function chromeEvent() {
  const listeners = new Set()
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => { for (const listener of [...listeners]) listener(...args) },
    get size() { return listeners.size },
  }
}

function fakeManagerChrome(t) {
  const previous = globalThis.chrome
  const onEvent = chromeEvent()
  const onDetach = chromeEvent()
  const onRemoved = chromeEvent()
  const onUpdated = chromeEvent()
  const commands = []
  globalThis.chrome = {
    debugger: {
      onEvent,
      onDetach,
      sendCommand: async ({ tabId }, method, params) => {
        commands.push({ tabId, method, params })
      },
    },
    tabs: { onRemoved, onUpdated },
  }
  t.after(() => { globalThis.chrome = previous })
  return { commands, onEvent, onDetach, onRemoved, onUpdated }
}

function opening(events, tabId, type, message, extra = {}) {
  events.onEvent.emit({ tabId }, 'Page.javascriptDialogOpening', {
    type,
    message,
    url: `https://example.test/${type}`,
    ...extra,
  })
}

test('alerts are auto-accepted and their text is reported', async t => {
  const fake = fakeManagerChrome(t)
  const manager = new DialogManager()
  await manager.attach(7)
  const cursor = manager.cursor()
  opening(fake, 7, 'alert', 'Saved successfully')
  await manager.waitForAutomatic(7)

  assert.equal(manager.pending(7), undefined)
  assert.deepEqual(fake.commands.at(-1), {
    tabId: 7,
    method: 'Page.handleJavaScriptDialog',
    params: { accept: true },
  })
  const reports = manager.takeReports(cursor)
  assert.equal(reports.length, 1)
  assert.deepEqual(reports[0], {
    id: reports[0].id,
    tabId: 7,
    type: 'alert',
    message: 'Saved successfully',
    url: 'https://example.test/alert',
    status: 'resolved',
    action: 'accept',
    automatic: true,
  })
  manager.detach(7)
})

test('confirm and prompt fail closed, interrupt waits, and resolve explicitly', async t => {
  const fake = fakeManagerChrome(t)
  const manager = new DialogManager()
  await manager.attach(7)
  opening(fake, 7, 'confirm', 'Delete this item?')

  assert.equal(manager.pending(7).status, 'pending')
  assert.equal(manager.pending(7).message, 'Delete this item?')
  assert.equal(fake.commands.some(command => command.method === 'Page.handleJavaScriptDialog'), false)
  await assert.rejects(
    manager.racePending(7, new Promise(() => {})),
    error => error.code === 'DIALOG_PENDING' && error.dialog.message === 'Delete this item?',
  )
  const confirmed = await manager.resolve(7, 'accept')
  assert.equal(confirmed.action, 'accept')
  assert.equal(confirmed.automatic, false)
  assert.deepEqual(fake.commands.at(-1).params, { accept: true })

  opening(fake, 7, 'prompt', 'Name the copy', { defaultPrompt: 'Copy' })
  assert.equal(manager.pending(7).defaultPrompt, 'Copy')
  const prompted = await manager.resolve(7, 'accept', 'Draft copy')
  assert.equal(prompted.userInput, 'Draft copy')
  assert.equal(prompted.message, 'Name the copy')
  assert.deepEqual(fake.commands.at(-1).params, { accept: true, promptText: 'Draft copy' })
  manager.detach(7)
})

test('beforeunload is automatic only for an intended navigation', async t => {
  const fake = fakeManagerChrome(t)
  const manager = new DialogManager()
  await manager.attach(7)
  opening(fake, 7, 'beforeunload', 'Leave with unsaved changes?')
  assert.equal(manager.pending(7).type, 'beforeunload')
  assert.equal(fake.commands.some(command => command.method === 'Page.handleJavaScriptDialog'), false)
  await manager.resolve(7, 'dismiss')

  manager.expectBeforeUnload(7)
  opening(fake, 7, 'beforeunload', 'Leave with unsaved changes?')
  await manager.waitForAutomatic(7)
  assert.equal(manager.pending(7), undefined)
  assert.equal(fake.commands.at(-1).method, 'Page.handleJavaScriptDialog')
  assert.deepEqual(fake.commands.at(-1).params, { accept: true })

  manager.expectBeforeUnload(7)
  opening(fake, 7, 'confirm', 'Delete instead?')
  assert.equal(manager.pending(7).type, 'confirm', 'navigation intent never auto-accepts a destructive confirm')
  await manager.resolve(7, 'dismiss')
  manager.detach(7)
})

test('beforeunload survives loading updates until explicit dismissal', async t => {
  const fake = fakeManagerChrome(t)
  const manager = new DialogManager()
  await manager.attach(7)
  opening(fake, 7, 'beforeunload', 'Leave with unsaved changes?')
  fake.onUpdated.emit(7, { status: 'loading', pendingUrl: 'https://example.test/next' })

  assert.equal(manager.pending(7).type, 'beforeunload')
  assert.equal(manager.pending(7).status, 'pending')
  assert.equal(fake.commands.some(command => command.method === 'Page.handleJavaScriptDialog'), false)
  const resolved = await manager.resolve(7, 'dismiss')
  assert.equal(resolved.action, 'dismiss')
  assert.equal(manager.pending(7), undefined)
  manager.detach(7)
})

test('detach preserves only resolvable pending state and tab changes clean listeners', async t => {
  const fake = fakeManagerChrome(t)
  const manager = new DialogManager()
  await manager.attach(7)
  await manager.attach(8)
  opening(fake, 7, 'confirm', 'Pending')
  assert.equal(fake.onEvent.size, 1)
  manager.detach(7)
  assert.equal(manager.pending(7).message, 'Pending', 'an isolated dialog remains explicitly resolvable')
  await manager.attach(7)
  await manager.resolve(7, 'dismiss')
  manager.detach(7)
  assert.equal(manager.pending(7), undefined)
  assert.equal(fake.onEvent.size, 1, 'another attachment keeps the shared listener')
  opening(fake, 8, 'confirm', 'Navigated tab')
  fake.onUpdated.emit(8, { url: 'https://example.test/next' })
  assert.equal(manager.pending(8), undefined)
  opening(fake, 8, 'confirm', 'Removed tab')
  fake.onRemoved.emit(8)
  assert.equal(manager.pending(8), undefined)
  assert.equal(fake.onEvent.size, 0)
  assert.equal(fake.onDetach.size, 0)
  assert.equal(fake.onRemoved.size, 0)
  assert.equal(fake.onUpdated.size, 0)
  const handleCount = fake.commands.filter(command => command.method === 'Page.handleJavaScriptDialog').length
  opening(fake, 8, 'alert', 'Ignored after detach')
  await Promise.resolve()
  assert.equal(fake.commands.filter(command => command.method === 'Page.handleJavaScriptDialog').length, handleCount)
})

test('dialog argument validation is strict', () => {
  assert.deepEqual(parseDialogArgs({ action: 'accept' }), { action: 'accept', promptText: undefined })
  assert.deepEqual(parseDialogArgs({ action: 'accept', prompt_text: 'Ada' }), { action: 'accept', promptText: 'Ada' })
  assert.deepEqual(parseDialogArgs({ action: 'dismiss' }), { action: 'dismiss', promptText: undefined })
  for (const args of [
    {},
    { action: 'cancel' },
    { action: 'accept', extra: true },
    { action: 'dismiss', prompt_text: 'not allowed' },
    { action: 'accept', prompt_text: 42 },
    { action: 'accept', prompt_text: 'x'.repeat(20_001) },
  ]) assert.throws(() => parseDialogArgs(args), error => error.code === 'BAD_DIALOG')
})

function fakeBrowserChrome(t) {
  const previous = globalThis.chrome
  const onEvent = chromeEvent()
  const onDetach = chromeEvent()
  const onUpdated = chromeEvent()
  const onRemoved = chromeEvent()
  const commands = []
  const lifecycle = []
  const tab = { id: 7, windowId: 1, index: 0, active: true, title: 'Dialog fixture', url: 'https://example.test/dialog', status: 'complete' }
  let captureCount = 0
  const fake = {
    commands,
    lifecycle,
    onEvent,
    onListTabs: undefined,
    onExecuteScript: undefined,
    get captureCount() { return captureCount },
    open(type, message, extra = {}) {
      onEvent.emit({ tabId: 7 }, 'Page.javascriptDialogOpening', { type, message, url: tab.url, ...extra })
    },
  }
  globalThis.chrome = {
    windows: { getCurrent: async () => ({ id: 1 }), update: async () => {} },
    tabs: {
      query: async query => {
        if (query.active !== true) fake.onListTabs?.()
        return [{ ...tab }]
      },
      get: async () => ({ ...tab }),
      captureVisibleTab: async () => {
        captureCount += 1
        return 'data:image/jpeg;base64,unused'
      },
      onUpdated,
      onRemoved,
    },
    scripting: {
      executeScript: (...args) => fake.onExecuteScript?.(...args) ?? Promise.resolve([{ result: {} }]),
    },
    debugger: {
      attach: async ({ tabId }) => { lifecycle.push(`attach:${tabId}`) },
      detach: async ({ tabId }) => { lifecycle.push(`detach:${tabId}`) },
      onEvent,
      onDetach,
      sendCommand: async ({ tabId }, method, params) => {
        commands.push({ tabId, method, params })
        if (method === 'Page.handleJavaScriptDialog') {
          onEvent.emit({ tabId }, 'Page.javascriptDialogClosed', {
            result: params.accept === true,
            ...(params.promptText === undefined ? {} : { userInput: params.promptText }),
          })
        }
      },
    },
  }
  t.after(async () => {
    await endDebuggerRun()
    globalThis.chrome = previous
  })
  return fake
}

test('retained-turn alert text is included in the triggering operation result', async t => {
  const fake = fakeBrowserChrome(t)
  await beginDebuggerRun()
  fake.onListTabs = () => fake.open('alert', 'Operation finished')
  const result = await execute('tabs.list', {}, {})

  assert.equal(result.op, 'tabs.list')
  assert.equal(result.dialog.type, 'alert')
  assert.equal(result.dialog.message, 'Operation finished')
  assert.equal(result.dialog.status, 'resolved')
  assert.equal(result.dialog.automatic, true)
  assert.equal(result.dialogs.length, 1)
  assert.equal(fake.commands.filter(command => command.method === 'Page.handleJavaScriptDialog').length, 1)
})

test('a dialog opened during a blocked page script returns pending promptly', async t => {
  const fake = fakeBrowserChrome(t)
  await beginDebuggerRun()
  fake.onExecuteScript = () => {
    fake.open('confirm', 'Script is blocked')
    return new Promise(() => {})
  }
  const result = await execute('read_text', {}, {})

  assert.equal(result.op, 'read_text')
  assert.equal(result.dialog.status, 'pending')
  assert.equal(result.dialog.message, 'Script is blocked')
  assert.equal(result.view, 'none')
  assert.equal(result.capture.reason, 'DIALOG_PENDING')
  assert.equal(fake.captureCount, 0)
  const resolved = await execute('dialog', { action: 'dismiss' }, {})
  assert.equal(resolved.dialog.status, 'resolved')
})

test('pending snapshots degrade explicitly and dialog resolves confirm and prompt state', async t => {
  const fake = fakeBrowserChrome(t)
  await beginDebuggerRun()
  fake.open('confirm', 'Delete the record?')
  const pending = await execute('snapshot', {}, {})

  assert.equal(pending.op, 'snapshot')
  assert.equal(pending.view, 'none')
  assert.equal(pending.screenshotSkipped, true)
  assert.equal(pending.dialog.status, 'pending')
  assert.equal(pending.dialog.message, 'Delete the record?')
  assert.deepEqual(pending.capture, { status: 'blocked', reason: 'DIALOG_PENDING' })
  assert.equal('image' in pending, false)
  assert.equal(fake.captureCount, 0)
  assert.equal(fake.commands.some(command => command.method === 'Page.handleJavaScriptDialog'), false)
  await assert.rejects(execute('dialog', { action: 'accept', prompt_text: 'wrong dialog' }, {}), error => error.code === 'BAD_DIALOG')

  const dismissed = await execute('dialog', { action: 'dismiss' }, {})
  assert.equal(dismissed.dialog.status, 'resolved')
  assert.equal(dismissed.dialog.action, 'dismiss')
  assert.equal(dismissed.dialog.message, 'Delete the record?')
  assert.equal(dismissed.capture.reason, 'DIALOG_RESOLVED')

  fake.open('prompt', 'Provide a name', { defaultPrompt: 'Untitled' })
  const prompted = await execute('dialog', { action: 'accept', prompt_text: 'Release plan' }, {})
  assert.equal(prompted.dialog.type, 'prompt')
  assert.equal(prompted.dialog.userInput, 'Release plan')
  assert.deepEqual(fake.commands.at(-1).params, { accept: true, promptText: 'Release plan' })
  await assert.rejects(execute('dialog', { action: 'accept' }, {}), error => error.code === 'NO_DIALOG')
})

test('isolated debugger attachments also auto-accept alerts and still detach', async t => {
  const fake = fakeBrowserChrome(t)
  const result = await withDebugger(7, async () => {
    fake.open('alert', 'Isolated alert')
    return 'operation-result'
  })

  assert.equal(result, 'operation-result')
  assert.deepEqual(fake.lifecycle, ['attach:7', 'detach:7'])
  assert.equal(fake.commands[0].method, 'Page.enable')
  assert.equal(fake.commands.at(-1).method, 'Page.handleJavaScriptDialog')
  assert.deepEqual(fake.commands.at(-1).params, { accept: true })
})

test('an isolated pending confirm can be resolved after the triggering attach detaches', async t => {
  const fake = fakeBrowserChrome(t)
  await assert.rejects(withDebugger(7, async () => {
    fake.open('confirm', 'Isolated confirm')
  }), error => error.code === 'DIALOG_PENDING' && error.dialog.message === 'Isolated confirm')
  assert.deepEqual(fake.lifecycle, ['attach:7', 'detach:7'])

  const result = await execute('dialog', { action: 'dismiss' }, {})
  assert.equal(result.dialog.status, 'resolved')
  assert.equal(result.dialog.action, 'dismiss')
  assert.equal(result.dialog.message, 'Isolated confirm')
  assert.deepEqual(fake.lifecycle, ['attach:7', 'detach:7', 'attach:7', 'detach:7'])
})
