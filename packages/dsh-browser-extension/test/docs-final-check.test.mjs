import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'

function makeContext() {
  const tools = new Map()
  const sections = []
  const disposers = []
  const listeners = new Map()
  let provider
  const ctx = {
    logger: { info: () => {} },
    browserUse: {
      register: name => {
        provider = name
        return () => {}
      },
    },
    tools: {
      register: definition => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      getSectionOrder: () => 3000,
      section: section => {
        sections.push(section)
        return () => {}
      },
    },
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect: fn => {
      const iterator = fn()
      let step = iterator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = iterator.next()
      }
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    },
  }
  return {
    ctx,
    tools,
    sections,
    listeners,
    getProvider: () => provider,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

function docsResult(action, status, verifiedBy, extra = {}) {
  return { op: 'docs', docs: { action, status, verifiedBy, ...extra } }
}

function readResult(args = {}, extra = {}) {
  const content = extra.content ?? 'Draft'
  return docsResult('read', 'completed', 'export', {
    format: args.format ?? 'outline',
    chars: content.length,
    returned: content.length,
    offset: args.offset ?? 0,
    nextOffset: null,
    truncated: false,
    content,
    ...extra,
  })
}

const DOCS_URL = 'https://docs.google.com/document/d/fixture/edit'

function genericResult(op, extra = {}) {
  return {
    op,
    tab: { id: 7, title: 'Fixture Docs', url: DOCS_URL },
    labels: [],
    ...extra,
  }
}

function defaultResult(command) {
  if (command.op === 'tabs.list') return { op: 'tabs.list', tabs: [] }
  if (command.op === 'docs' && command.args?.action === 'read') return readResult(command.args)
  throw new Error(`No fake result for ${command.op}/${command.args?.action ?? ''}`)
}

async function setup(t, respond = () => undefined) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const port = server.address().port
  const commands = []
  const logEvents = []
  server.on('connection', ws => {
    ws.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') {
        ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
        return
      }
      if (message.type === 'log.event') {
        logEvents.push(message.event)
        return
      }
      if (message.type !== 'browser.command') return
      const command = message.command
      commands.push(command)
      let response
      try {
        response = respond(command) ?? defaultResult(command)
      } catch (error) {
        response = { failure: { message: error instanceof Error ? error.message : String(error) } }
      }
      const payload = response?.failure
        ? {
            v: 1,
            type: 'browser.result',
            id: message.id,
            ok: false,
            error: {
              message: response.failure.message,
              ...response.failure.code === undefined ? {} : { code: response.failure.code },
            },
          }
        : { v: 1, type: 'browser.result', id: message.id, ok: true, result: response }
      if (ws.readyState === 1) ws.send(JSON.stringify(payload))
    })
  })

  const fake = makeContext()
  apply(fake.ctx, {
    bridgeUrl: `ws://127.0.0.1:${port}/bridge`,
    bridgeToken: 'test',
    requestTimeoutMs: 500,
  })
  const session = { id: 'session-1', surface: { nodes: [] }, append: () => {} }
  const steered = []
  const fixture = { fake, session, steered, commands, logEvents }
  t.after(async () => {
    fake.dispose()
    for (const client of server.clients) client.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  return fixture
}

async function runTool(fixture, { tool, args, turn = 1, callId }) {
  let result
  let error
  try {
    result = await fixture.fake.tools.get(tool).execute(args, {
      callId,
      agent: { session: fixture.session },
      signal: new AbortController().signal,
    })
  } catch (caught) {
    error = caught
  }
  fixture.fake.listeners.get('session/event')(fixture.session, {
    type: 'tool/result',
    data: {
      turn,
      message: {
        toolCallId: callId,
        content: result?.content ?? [{ type: 'text', text: error?.message ?? 'tool failed' }],
        ...error === undefined ? {} : { isError: true },
      },
      ...error === undefined ? {} : { error: { message: error.message } },
    },
  })
  return { result, error }
}

async function stop(fixture, { turn = 1, session = fixture.session, aborted = false } = {}) {
  const controller = new AbortController()
  if (aborted) controller.abort()
  const agent = {
    session,
    steer: message => fixture.steered.push(message),
  }
  await fixture.fake.listeners.get('agent/turn-stopping')({
    agent,
    turn,
    signal: controller.signal,
  })
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

function finalLogs(fixture) {
  return fixture.logEvents.filter(event => event.type === 'docs.final.check')
}

async function dirtyReplace(fixture, turn = 1, callId = `replace-${turn}`) {
  const { error } = await runTool(fixture, {
    tool: 'browser_docs_replace',
    args: { edits: [{ text: 'yea', replacement: '' }] },
    turn,
    callId,
  })
  assert.equal(error, undefined)
}

test('dirty Docs mutation steers one final read and reconciliation', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'docs' && command.args?.action === 'replace_text') {
      return docsResult('replace_text', 'removed_text', 'find-counter', { matchCount: 0, removedText: 'yea' })
    }
  })

  await dirtyReplace(fixture)
  await stop(fixture)

  assert.equal(fixture.steered.length, 1)
  const message = fixture.steered[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'runtime-context')
  const text = message.content[0].text
  assert.match(text, /browser_docs_read exactly once/)
  assert.match(text, /offset:0/)
  assert.match(text, /Reconcile the requested document changes/)
  assert.match(text, /Do not make recovery edits/)
  assert.match(text, /unverified or partial/)
  await waitFor(() => finalLogs(fixture).length === 1)
  assert.equal(finalLogs(fixture)[0].data.outcome, 'nudged')
  assert.equal(finalLogs(fixture)[0].data.reason, 'mutation-not-completed')
})

test('completed export-verified mutation does not request a redundant read', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'docs' && command.args?.action === 'write') {
      return docsResult('write', 'completed', 'export', {
        blockCount: 1,
        attemptedCount: 1,
        verifiedCount: 1,
        outline: 'Draft',
      })
    }
  })

  const { error } = await runTool(fixture, {
    tool: 'browser_docs_write',
    args: { blocks: [{ text: 'Draft' }] },
    callId: 'write-export',
  })
  assert.equal(error, undefined)
  await stop(fixture)

  assert.equal(fixture.steered.length, 0)
  await waitFor(() => finalLogs(fixture).length === 1)
  assert.equal(finalLogs(fixture)[0].data.outcome, 'satisfied')
  assert.equal(finalLogs(fixture)[0].data.reason, 'mutation-export')
})

test('only completed export-verified view:none Docs results suppress images', async t => {
  const fixture = await setup(t, command => {
    if (command.op !== 'docs' || command.args?.action !== 'write') return undefined
    const text = command.args.blocks[0].text
    const status = text === 'partial' ? 'partial' : text === 'failed' ? 'failed' : 'completed'
    const verifiedBy = text === 'toolbar' ? 'toolbar' : 'export'
    return {
      ...docsResult('write', status, verifiedBy, {
        blockCount: 1,
        attemptedCount: 1,
        verifiedCount: status === 'completed' ? 1 : 0,
      }),
      view: 'none',
      image: { data: text, mimeType: 'image/jpeg' },
    }
  })

  for (const text of ['done', 'partial', 'failed', 'toolbar']) {
    const { result, error } = await runTool(fixture, {
      tool: 'browser_docs_write',
      args: { blocks: [{ text }] },
      callId: `write-image-${text}`,
    })
    assert.equal(error, undefined)
    const images = result.content.filter(block => block.type === 'image')
    assert.equal(images.length, text === 'done' ? 0 : 1, text)
    if (text === 'done') assert.match(result.content[0].text, /view: skipped.*verified by document export/)
  }
})

test('a subsequent full offset-zero Docs read clears dirty evidence', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'docs' && command.args?.action === 'replace_text') {
      return docsResult('replace_text', 'removed_text', 'find-counter')
    }
  })

  await dirtyReplace(fixture)
  const { error } = await runTool(fixture, {
    tool: 'browser_docs_read',
    args: { offset: 0, max_chars: 100000 },
    callId: 'read-full',
  })
  assert.equal(error, undefined)
  await stop(fixture)

  assert.equal(fixture.steered.length, 0)
  await waitFor(() => finalLogs(fixture).length === 1)
  assert.equal(finalLogs(fixture)[0].data.outcome, 'satisfied')
  assert.equal(finalLogs(fixture)[0].data.reason, 'full-read')
})

test('partial mutations and truncated or nonzero-offset reads stay dirty', async t => {
  const fixture = await setup(t, command => {
    if (command.op !== 'docs') return undefined
    if (command.args?.action === 'write') {
      return docsResult('write', 'partial', 'export', {
        blockCount: 1,
        attemptedCount: 1,
        verifiedCount: 0,
      })
    }
    if (command.args?.action === 'read' && command.args.offset === 0) {
      return readResult(command.args, { truncated: true, nextOffset: 5 })
    }
    if (command.args?.action === 'read') return readResult(command.args)
  })

  const write = await runTool(fixture, {
    tool: 'browser_docs_write',
    args: { blocks: [{ text: 'Draft' }] },
    callId: 'write-partial',
  })
  assert.equal(write.error, undefined)
  await runTool(fixture, {
    tool: 'browser_docs_read',
    args: { offset: 0, max_chars: 100 },
    callId: 'read-truncated',
  })
  await runTool(fixture, {
    tool: 'browser_docs_read',
    args: { offset: 5, max_chars: 100 },
    callId: 'read-offset',
  })
  await stop(fixture)

  assert.equal(fixture.steered.length, 1)
  await waitFor(() => finalLogs(fixture).length === 1)
  assert.equal(finalLogs(fixture)[0].data.outcome, 'nudged')
  assert.equal(finalLogs(fixture)[0].data.lastRead, 'read-offset')
})

test('a failed final read allows stopping after the single nudge', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'docs' && command.args?.action === 'replace_text') {
      return docsResult('replace_text', 'removed_text', 'find-counter')
    }
    if (command.op === 'docs' && command.args?.action === 'read') {
      return { failure: { code: 'DOCS_EXPORT_FAILED', message: 'export failed' } }
    }
  })

  await dirtyReplace(fixture)
  await stop(fixture)
  assert.equal(fixture.steered.length, 1)
  const read = await runTool(fixture, {
    tool: 'browser_docs_read',
    args: { offset: 0 },
    callId: 'read-failed',
  })
  assert.match(read.error.message, /export failed/)
  await stop(fixture)

  assert.equal(fixture.steered.length, 1)
  assert.equal(fixture.commands.filter(command => command.args?.action === 'read').length, 1)
  await waitFor(() => finalLogs(fixture).length === 2)
  assert.equal(finalLogs(fixture)[1].data.outcome, 'allowed-unverified')
  assert.equal(finalLogs(fixture)[1].data.reason, 'read-error')
})

test('non-Docs, selection, and read-only turns are not gated', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'docs' && command.args?.action === 'select_text') {
      return docsResult('select_text', 'selected', 'find-counter', {
        matchCount: 1,
        selectedText: 'Heading',
        findFocused: true,
      })
    }
  })

  await runTool(fixture, { tool: 'browser_tabs', args: {}, turn: 1, callId: 'tabs-only' })
  await stop(fixture, { turn: 1 })
  await runTool(fixture, {
    tool: 'browser_docs_select_text',
    args: { text: 'Heading' },
    turn: 2,
    callId: 'select-only',
  })
  await runTool(fixture, {
    tool: 'browser_docs_read',
    args: { offset: 0 },
    turn: 2,
    callId: 'read-only',
  })
  await stop(fixture, { turn: 2 })

  assert.equal(fixture.steered.length, 0)
  assert.equal(finalLogs(fixture).length, 0)
})

test('aborted dirty turns are not gated', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'docs' && command.args?.action === 'replace_text') {
      return docsResult('replace_text', 'removed_text', 'find-counter')
    }
  })

  await dirtyReplace(fixture)
  await stop(fixture, { aborted: true })

  assert.equal(fixture.steered.length, 0)
  await waitFor(() => finalLogs(fixture).length === 1)
  assert.equal(finalLogs(fixture)[0].data.outcome, 'aborted')
})

test('a later dirty mutation makes earlier full-read evidence stale', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'docs' && command.args?.action === 'replace_text') {
      return docsResult('replace_text', 'removed_text', 'find-counter')
    }
  })

  await dirtyReplace(fixture, 1, 'replace-before-read')
  await runTool(fixture, {
    tool: 'browser_docs_read',
    args: { offset: 0 },
    callId: 'read-before-later-mutation',
  })
  await dirtyReplace(fixture, 1, 'replace-after-read')
  await stop(fixture)

  assert.equal(fixture.steered.length, 1)
  await waitFor(() => finalLogs(fixture).length === 1)
  assert.equal(finalLogs(fixture)[0].data.outcome, 'nudged')
})

test('final-check state is isolated by session and user-message turn', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'docs' && command.args?.action === 'replace_text') {
      return docsResult('replace_text', 'removed_text', 'find-counter')
    }
  })

  await dirtyReplace(fixture, 1, 'replace-original-turn')
  await stop(fixture, { turn: 2 })
  await stop(fixture, { turn: 1, session: { id: 'session-2' } })
  assert.equal(fixture.steered.length, 0)
  await stop(fixture, { turn: 1 })

  assert.equal(fixture.steered.length, 1)
})

test('generic Docs type and editing keys require final evidence', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'type') {
      return genericResult('type', {
        changed: null,
        signals: [],
        typed: { chars: 5, mode: 'replace', submitted: false, method: 'trusted', afterChars: 5, valuePreview: 'Draft' },
      })
    }
    if (command.op === 'press_key') {
      return genericResult('press_key', {
        changed: command.args.key === 'Backspace' ? null : command.args.key === 'b',
        pressed: { key: command.args.key, modifiers: command.args.modifiers ?? [], trusted: true },
      })
    }
  })

  await runTool(fixture, {
    tool: 'browser_type', args: { text: 'Draft' }, turn: 1, callId: 'generic-type',
  })
  await stop(fixture, { turn: 1 })
  assert.equal(fixture.steered.length, 1)
  await runTool(fixture, {
    tool: 'browser_press_key', args: { key: 'Backspace' }, turn: 2, callId: 'generic-backspace',
  })
  await stop(fixture, { turn: 2 })
  assert.equal(fixture.steered.length, 2)
  await runTool(fixture, {
    tool: 'browser_press_key', args: { key: 'ctrl+b' }, turn: 3, callId: 'generic-bold',
  })
  await stop(fixture, { turn: 3 })
  assert.equal(fixture.steered.length, 3)

  await waitFor(() => finalLogs(fixture).length === 3)
  assert.deepEqual(finalLogs(fixture).map(event => event.data.lastMutation), [
    'generic:type', 'generic:press_key', 'generic:press_key',
  ])
})

test('changed generic Docs clicks, batches, and clipboard pastes require final evidence', async t => {
  const fixture = await setup(t, command => {
    if (command.op === 'click') {
      return genericResult('click', { changed: true, clicked: { label: command.args.label, role: 'button' } })
    }
    if (command.op === 'click_at') {
      return genericResult('click_at', {
        changed: true,
        changedCount: 1,
        trusted: true,
        points: [{ x: 100, y: 200, changed: true, pixelsChanged: 4 }],
      })
    }
    if (command.op === 'click_role') {
      return genericResult('click_role', {
        changed: true,
        roleClick: { status: 'completed', completed: 1, path: command.args.path },
      })
    }
    if (command.op === 'batch') {
      return genericResult('batch', {
        batch: { total: 1, executed: 1, succeeded: 1, ok: true, stoppedEarly: false },
        actions: [{ index: 1, op: 'type', ok: true, changed: null, typed: { chars: 5, valuePreview: 'Draft' } }],
      })
    }
    if (command.op === 'clipboard') {
      return genericResult('clipboard', {
        action: 'paste',
        changed: null,
        clipboard: { target: 'virtual', system: false, chars: 5 },
        pasted: { chars: 5, mode: 'replace', submitted: false, via: 'system' },
        typed: { valuePreview: 'Draft' },
      })
    }
  })
  const cases = [
    { tool: 'browser_click', args: { label: 3 }, callId: 'generic-click' },
    { tool: 'browser_click_at', args: { x: 100, y: 200, space: 'css' }, callId: 'generic-click-at' },
    { tool: 'browser_click_role', args: { path: [{ role: 'button', name: 'Bold' }] }, callId: 'generic-click-role' },
    { tool: 'browser_batch', args: { actions: [{ op: 'type', text: 'Draft' }] }, callId: 'generic-batch' },
    { tool: 'browser_clipboard', args: { action: 'paste' }, callId: 'generic-paste' },
  ]

  for (const [index, entry] of cases.entries()) {
    const { error } = await runTool(fixture, { ...entry, turn: index + 1 })
    assert.equal(error, undefined)
    await stop(fixture, { turn: index + 1 })
    assert.equal(fixture.steered.length, index + 1)
  }

  await waitFor(() => finalLogs(fixture).length === cases.length)
  assert.deepEqual(finalLogs(fixture).map(event => event.data.lastMutation), [
    'generic:click', 'generic:click_at', 'generic:click_role', 'generic:batch', 'generic:clipboard_paste',
  ])
})

test('read-only Docs operations and read-only keys do not trigger final evidence', async t => {
  const fixture = await setup(t, command => genericResult(command.op, {
    changed: true,
    signals: ['dom-mutations:1'],
    viewport: { width: 1280, height: 720, dpr: 1 },
    scroll: { x: 0, y: 100, maxY: 500, container: 'document', atTop: false, atBottom: false },
    moved: { dx: 0, dy: 100 },
    waited: { conditions: { ms: 0 }, found: true, timedOut: false, elapsedMs: 0 },
    navigated: {
      requestedUrl: DOCS_URL, fromUrl: DOCS_URL, toUrl: DOCS_URL,
      status: 'complete', timedOut: false, waitMs: 1,
    },
    pressed: { key: command.args?.key, modifiers: command.args?.modifiers ?? [], trusted: true },
    batch: { total: 2, executed: 2, succeeded: 2, ok: true, stoppedEarly: false },
    actions: [
      { index: 1, op: 'scroll', ok: true, changed: true },
      { index: 2, op: 'wait_for', ok: true, changed: true },
    ],
  }))
  const operations = [
    { tool: 'browser_screenshot', args: {}, callId: 'docs-screenshot' },
    { tool: 'browser_scroll', args: { direction: 'down' }, callId: 'docs-scroll' },
    { tool: 'browser_wait_for', args: { ms: 0 }, callId: 'docs-wait' },
    { tool: 'browser_switch_tab', args: { tab_id: 7 }, callId: 'docs-tab-switch' },
    { tool: 'browser_navigate', args: { history: 'reload' }, callId: 'docs-navigation' },
    { tool: 'browser_press_key', args: { key: 'ArrowDown' }, callId: 'docs-arrow' },
    { tool: 'browser_press_key', args: { key: 'ctrl+c' }, callId: 'docs-copy' },
    {
      tool: 'browser_batch',
      args: { actions: [{ op: 'scroll', direction: 'down' }, { op: 'wait_for', ms: 0 }] },
      callId: 'docs-read-only-batch',
    },
  ]

  for (const operation of operations) {
    const { error } = await runTool(fixture, operation)
    assert.equal(error, undefined)
  }
  await stop(fixture)

  assert.equal(fixture.steered.length, 0)
  assert.equal(finalLogs(fixture).length, 0)
})

test('explicit no-ops and non-Docs or URL-less generic results do not trigger final evidence', async t => {
  const fixture = await setup(t, command => {
    const ordinary = command.args?.text === 'ordinary' || command.args?.label === 99
    const urlLess = command.args?.text === 'url-less'
    const result = genericResult(command.op, {
      changed: ordinary || urlLess,
      signals: [],
      clicked: { label: command.args?.label, role: 'button' },
      changedCount: 0,
      points: [{ x: 100, y: 200, changed: false, pixelsChanged: 0 }],
      typed: { chars: 5, mode: 'replace', submitted: false, method: 'dom', afterChars: 5, valuePreview: 'Draft' },
      action: command.args?.action,
      clipboard: { target: 'virtual', system: false, chars: 5 },
      pasted: { chars: 5, mode: 'replace', submitted: false, via: 'system' },
    })
    if (ordinary) result.tab = { id: 8, title: 'Ordinary', url: 'https://example.test/editor' }
    if (urlLess) result.tab = { id: 9, title: 'URL unavailable' }
    return result
  })
  const operations = [
    { tool: 'browser_click', args: { label: 3 }, callId: 'docs-click-noop' },
    { tool: 'browser_click_at', args: { x: 100, y: 200, space: 'css' }, callId: 'docs-click-at-noop' },
    { tool: 'browser_type', args: { text: 'Draft' }, callId: 'docs-type-noop' },
    { tool: 'browser_clipboard', args: { action: 'paste' }, callId: 'docs-paste-noop' },
    { tool: 'browser_type', args: { text: 'ordinary' }, callId: 'ordinary-type' },
    { tool: 'browser_click', args: { label: 99 }, callId: 'ordinary-click' },
    { tool: 'browser_type', args: { text: 'url-less' }, callId: 'url-less-type' },
  ]

  for (const operation of operations) {
    const { error } = await runTool(fixture, operation)
    assert.equal(error, undefined)
  }
  await stop(fixture)

  assert.equal(fixture.steered.length, 0)
  assert.equal(finalLogs(fixture).length, 0)
})
