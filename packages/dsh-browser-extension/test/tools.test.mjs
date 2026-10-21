import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'

const IMAGE = { data: 'AAAA', mimeType: 'image/jpeg', width: 1, height: 1, bytes: 3 }
const SCROLL = {
  op: 'scroll',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 612, maxY: 2400, container: 'document', atTop: false, atBottom: false },
  moved: { dx: 0, dy: 612 },
  image: IMAGE,
}
const SNAPSHOT = {
  op: 'snapshot',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 2400, container: 'document', atTop: true, atBottom: false },
  labels: [
    { id: 3, tag: 'button', role: 'button', text: 'Sign in', disabled: false, x: 10, y: 20, w: 80, h: 32 },
    { id: 9, tag: 'a', role: 'link', text: 'Forgot password?', disabled: false, x: 10, y: 60, w: 120, h: 24 },
  ],
  labelCount: 2,
  surfaces: [{ kind: 'canvas', x: 20, y: 100, w: 800, h: 420 }],
  image: IMAGE,
}
const CLICK = {
  op: 'click',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 2400, container: 'document', atTop: true, atBottom: false },
  clicked: { label: 3, tag: 'button', role: 'button', text: 'Sign in' },
  changed: true,
  signals: ['dom-mutations:2'],
  navigated: false,
  clickMs: 210,
  labels: [
    { id: 3, tag: 'button', role: 'button', text: 'Sign in', disabled: false, x: 10, y: 20, w: 80, h: 32 },
    { id: 9, tag: 'a', role: 'link', text: 'Forgot password?', disabled: false, x: 10, y: 60, w: 120, h: 24 },
  ],
  labelCount: 2,
  image: IMAGE,
}
const CLICK_AT = {
  op: 'click_at',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  point: { space: 'image', x: 100, y: 200, cssX: 80, cssY: 160 },
  points: [{ space: 'image', x: 100, y: 200, cssX: 80, cssY: 160, changed: true, pixelsChanged: 1.4, pixelMean: 3 }],
  trusted: true,
  changed: true,
  changedCount: 1,
  pixelsChanged: 1.4,
  clickMs: 210,
  labels: [],
  surfaces: [{ kind: 'canvas', x: 20, y: 100, w: 800, h: 420 }],
  image: IMAGE,
}
const CLICK_AT_MULTI = {
  op: 'click_at',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  points: [
    { space: 'image', x: 100, y: 200, cssX: 80, cssY: 160, changed: true, pixelsChanged: 1.4, pixelMean: 3 },
    { space: 'image', x: 300, y: 400, cssX: 240, cssY: 320, changed: false, pixelsChanged: 0, pixelMean: 0 },
    { space: 'image', x: 500, y: 500, cssX: 400, cssY: 400, changed: true, pixelsChanged: 0.5, pixelMean: 2 },
  ],
  trusted: true,
  changedCount: 2,
  clickMs: 210,
  labels: [],
  surfaces: [{ kind: 'canvas', x: 20, y: 100, w: 800, h: 420 }],
  image: IMAGE,
}
const CLICK_AT_NONE = {
  op: 'click_at',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  view: 'none',
  screenshotSkipped: true,
  points: [
    { space: 'image', x: 100, y: 200, cssX: 80, cssY: 160, changed: null, pixelsChanged: null, pixelMean: null },
    { space: 'image', x: 300, y: 400, cssX: 240, cssY: 320, changed: null, pixelsChanged: null, pixelMean: null },
  ],
  trusted: true,
  changed: null,
  changedCount: null,
  pixelsChanged: null,
  clickMs: 180,
}
const SELECT = {
  op: 'select_option',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  selected: { value: 'ca', text: 'Canada' },
  selectedIndex: 1,
  labels: [],
  image: IMAGE,
}
const HOVER = {
  op: 'hover',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  hovered: { label: 5, tag: 'button', role: 'button', text: 'Menu' },
  labels: [{ id: 6, tag: 'button', role: 'button', text: 'Menu item', disabled: false, x: 10, y: 40, w: 90, h: 30 }],
  image: IMAGE,
}
const READ_TEXT = {
  op: 'read_text',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  scope: 'page',
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 2400, container: 'document', atTop: true, atBottom: false },
  text: 'ALPHA-MARKER\nBETA-MARKER',
  totalChars: 24,
  offset: 0,
  maxChars: 12000,
  truncated: true,
  nextOffset: 24,
  totalMs: 7,
}
const TABS = {
  op: 'tabs.list',
  tabs: [
    { id: 7, title: 'Fixture', url: 'https://example.test/fixture', active: true, pinned: false, status: 'complete' },
    { id: 8, title: 'Second Tab', url: 'https://example.test/two', active: false, pinned: false, status: 'complete' },
  ],
}
const TYPE = {
  op: 'type',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  typed: {
    label: 7,
    chars: 12,
    mode: 'replace',
    submitted: false,
    method: 'dom',
    beforeChars: 0,
    afterChars: 12,
    valuePreview: 'jane@example.com',
  },
  changed: true,
  signals: ['dom-mutations:2'],
  labels: [{ id: 7, tag: 'input', role: 'textbox', text: 'Email', disabled: false, x: 10, y: 20, w: 200, h: 32 }],
  labelCount: 1,
  image: IMAGE,
}
const TYPE_FOCUSED = {
  ...TYPE,
  typed: {
    chars: 5,
    mode: 'append',
    submitted: true,
    method: 'trusted',
    beforeChars: 0,
    afterChars: 5,
    valuePreview: 'hello',
  },
  labels: [],
  labelCount: 0,
}
const TYPE_PASSWORD = {
  ...TYPE,
  typed: {
    label: 8,
    chars: 12,
    mode: 'replace',
    submitted: false,
    method: 'trusted',
    beforeChars: 0,
    afterChars: 12,
    valuePreview: '[password 12 chars]',
  },
  labels: [{ id: 8, tag: 'input', role: 'textbox', text: 'Password', disabled: false, x: 10, y: 60, w: 200, h: 32 }],
}
const TYPE_UNCHANGED = {
  ...TYPE,
  typed: {
    label: 7,
    chars: 3,
    mode: 'replace',
    submitted: false,
    method: 'dom',
    beforeChars: 0,
    afterChars: 0,
    valuePreview: '',
  },
  changed: false,
  signals: [],
}
const PRESS_KEY = {
  op: 'press_key',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  pressed: { key: 'KeyA', modifiers: ['ctrl'], trusted: true },
  changed: true,
  signals: ['dom-mutations:1'],
  labels: [],
  image: IMAGE,
}
const PRESS_KEY_SYNTHETIC = {
  ...PRESS_KEY,
  pressed: { key: 'Enter', modifiers: [], trusted: false },
  changed: false,
  signals: [],
}
const NAVIGATE = {
  op: 'navigate',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  navigated: {
    requestedUrl: 'https://example.test/docs',
    fromUrl: 'https://example.test/start',
    toUrl: 'https://example.test/docs',
    tabId: 7,
    newTab: false,
    status: 'complete',
    timedOut: false,
    waitMs: 812,
  },
  changed: true,
  signals: ['navigated'],
  labels: [],
  image: IMAGE,
}
const NAVIGATE_NEW_TAB = {
  ...NAVIGATE,
  tab: { id: 8, title: 'Fixture Docs', url: 'https://example.test/docs' },
  navigated: { ...NAVIGATE.navigated, newTab: true, tabId: 8 },
}
const NAVIGATE_HISTORY = {
  ...NAVIGATE,
  navigated: {
    fromUrl: 'https://example.test/b',
    toUrl: 'https://example.test/a',
    tabId: 7,
    newTab: false,
    history: 'back',
    status: 'complete',
    timedOut: false,
    waitMs: 120,
  },
}
const NAVIGATE_TIMEOUT = {
  ...NAVIGATE,
  navigated: {
    requestedUrl: 'https://example.test/slow',
    fromUrl: 'https://example.test/docs',
    toUrl: 'https://example.test/slow',
    tabId: 7,
    newTab: false,
    status: 'loading',
    timedOut: true,
    waitMs: 10000,
  },
  changed: false,
  signals: [],
}
const WAIT_FOR = {
  op: 'wait_for',
  tab: { id: 7, title: 'Fixture', url: 'https://example.test/fixture' },
  viewport: { width: 1280, height: 720, dpr: 1 },
  scroll: { x: 0, y: 0, maxY: 0, container: 'document', atTop: true, atBottom: true },
  waited: { conditions: { text: 'READY' }, found: true, timedOut: false, elapsedMs: 812 },
  changed: true,
  labels: [],
  image: IMAGE,
}
const WAIT_FOR_TIMEOUT = {
  ...WAIT_FOR,
  waited: { conditions: { text: 'NEVER' }, found: false, timedOut: true, elapsedMs: 10000 },
  changed: false,
  signals: [],
}

async function startFakeBridge() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const port = server.address().port
  const activities = []
  const commands = []
  server.on('connection', ws => {
    ws.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') {
        ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
        return
      }
      if (message.type === 'activity') {
        activities.push(message.activity)
        return
      }
      if (message.type === 'browser.command') {
        const op = message.command?.op
        const args = message.command?.args ?? {}
        commands.push({ op, args })
        const send = result => ws.send(JSON.stringify({ v: 1, type: 'browser.result', id: message.id, ok: true, result }))
        if (op === 'click_at') {
          send(args.view === 'none' ? CLICK_AT_NONE
            : Array.isArray(args.points) ? CLICK_AT_MULTI
              : CLICK_AT)
          return
        }
        if (op === 'type') {
          send(args.text === 'NOCHANGE' ? TYPE_UNCHANGED
            : args.label === 8 ? TYPE_PASSWORD
              : args.label === undefined ? TYPE_FOCUSED
                : TYPE)
          return
        }
        if (op === 'press_key') {
          send(Array.isArray(args.modifiers) && args.modifiers.length > 0 ? PRESS_KEY : PRESS_KEY_SYNTHETIC)
          return
        }
        if (op === 'navigate') {
          send(args.history === 'back' ? NAVIGATE_HISTORY
            : args.new_tab === true ? NAVIGATE_NEW_TAB
              : typeof args.url === 'string' && args.url.includes('slow') ? NAVIGATE_TIMEOUT
                : NAVIGATE)
          return
        }
        if (op === 'wait_for') {
          send(args.text === 'NEVER' ? WAIT_FOR_TIMEOUT : WAIT_FOR)
          return
        }
        const result = op === 'scroll' ? SCROLL
          : op === 'tabs.list' ? TABS
            : op === 'read_text' ? READ_TEXT
              : op === 'click' ? CLICK
                : op === 'select_option' ? SELECT
                  : op === 'hover' ? HOVER
                    : SNAPSHOT
        send(result)
      }
    })
  })
  return { server, url: `ws://127.0.0.1:${port}/bridge`, activities, commands }
}

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

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for condition')
}

test('registers the provider, guidance, and the thirteen browser tools', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  assert.equal(String(fake.getProvider()), 'extension-current-window')
  assert.deepEqual([...fake.tools.keys()].sort(), [
    'browser_click',
    'browser_click_at',
    'browser_hover',
    'browser_navigate',
    'browser_press_key',
    'browser_read_text',
    'browser_screenshot',
    'browser_scroll',
    'browser_select_option',
    'browser_switch_tab',
    'browser_tabs',
    'browser_type',
    'browser_wait_for',
  ])
  assert.equal(fake.sections.length, 1)
  const guidance = fake.sections[0].text
  assert.match(guidance, /untrusted data/)
  assert.match(guidance, /points:\[\{x,y\}, \.\.\.\]/)
  assert.match(guidance, /view:"none"/)
  assert.match(guidance, /delay_ms/)
  for (const tool of ['browser_type', 'browser_press_key', 'browser_navigate', 'browser_wait_for']) {
    assert.match(guidance, new RegExp(tool), tool)
  }
  assert.doesNotMatch(guidance, /cannot click or type in Phase 1/)
  assert.doesNotMatch(guidance, /cannot type/i)
  assert.doesNotMatch(guidance, /cannot navigate/i)
})

test('scroll tool returns metadata and an image block', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const definition = fake.tools.get('browser_scroll')
  const value = await definition.execute({ direction: 'down' }, { callId: 'call-1', signal: new AbortController().signal })
  assert.equal(value.content.length, 2)
  assert.equal(value.content[0].type, 'text')
  assert.match(value.content[0].text, /tab 7 "Fixture"/)
  assert.match(value.content[0].text, /scroll document y=612\/2400/)
  assert.equal(value.content[1].type, 'image')
  assert.equal(value.content[1].mimeType, 'image/jpeg')
  assert.equal(value.content[1].data, 'AAAA')
})

test('tabs tool returns a readable list without an image', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  const definition = fake.tools.get('browser_tabs')
  const value = await definition.execute({}, { callId: 'call-2', signal: new AbortController().signal })
  assert.equal(value.content.length, 1)
  assert.match(value.content[0].text, /\[7\] "Fixture"/)
  assert.match(value.content[0].text, /\[8\] "Second Tab"/)
})

test('forwards DSH assistant-stream frames as live activity', async t => {
  const { server, url, activities } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  await waitFor(() => server.clients.size > 0)
  await new Promise(resolve => setTimeout(resolve, 75))
  const handler = fake.listeners.get('agent/assistant-stream')
  assert.equal(typeof handler, 'function')
  handler({ frame: { type: 'start', turn: 1, step: 1, attemptId: 'attempt-1' } })
  handler({ frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'checking the page' } } })
  handler({ frame: { type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'I can see it.' } } })
  handler({ frame: { type: 'chunk', chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'browser_scroll', argumentsDelta: '{"direction":"down"}' } } })
  handler({ frame: { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 12 } } } })
  handler({ frame: { type: 'chunk', chunk: { type: 'finish', reason: 'stop' } } })
  handler({ frame: { type: 'end', outcome: { kind: 'committed' } } })

  await waitFor(() => activities.length >= 7)
  assert.deepEqual(activities.map(item => item.kind), [
    'model-start',
    'reasoning',
    'text',
    'tool-call-delta',
    'usage',
    'finish',
    'model-end',
  ])
  assert.equal(activities[1].text, 'checking the page')
  assert.equal(activities[2].text, 'I can see it.')
  assert.equal(activities[3].name, 'browser_scroll')
  assert.equal(activities[4].usage.inputTokens, 12)
})


test('read_text returns text without an image block', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_read_text')
  const result = await definition.execute({ scope: 'page' }, { callId: 'c1', signal: new AbortController().signal })
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')
  assert.match(result.content[0].text, /ALPHA-MARKER/)
  assert.match(result.content[0].text, /next_offset 24/)
})

test('switch_tab accepts a query and rejects an empty target', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const tool = fake.tools.get('browser_switch_tab')
  const exec = { callId: 'c2', signal: new AbortController().signal }
  await assert.rejects(() => tool.execute({}, exec), /requires tab_id or query/)
  const result = await tool.execute({ query: 'fixture' }, { callId: 'c3', signal: new AbortController().signal })
  assert.ok(result.content.some(block => block.type === 'image'))
})


test('screenshot content lists labels for clicking', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_screenshot')
  const value = await definition.execute({}, { callId: 'c-shot', signal: new AbortController().signal })
  assert.match(value.content[0].text, /labels \(click by number\): 2/)
  assert.match(value.content[0].text, /\[3\] button "Sign in"/)
  assert.match(value.content[0].text, /\[9\] link "Forgot password\?"/)
})

test('screenshot forwards delay_ms to the bridge', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_screenshot')
  assert.match(definition.description, /delay_ms/)
  await definition.execute({ delay_ms: 350 }, { callId: 'c-delay', signal: new AbortController().signal })
  assert.deepEqual(commands.at(-1), { op: 'snapshot', args: { detail: 'normal', delay_ms: 350 } })
  await definition.execute({ detail: 'high' }, { callId: 'c-nodelay', signal: new AbortController().signal })
  assert.deepEqual(commands.at(-1), { op: 'snapshot', args: { detail: 'high' } })
})

test('click tool reports the target and the resulting view', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click')
  const value = await definition.execute({ label: 3 }, { callId: 'c-click', signal: new AbortController().signal })
  assert.equal(value.content[0].type, 'text')
  assert.match(value.content[0].text, /clicked label 3: button "Sign in"/)
  assert.match(value.content[0].text, /result: changed \(dom-mutations:2\)/)
  assert.match(value.content[0].text, /labels \(click by number\): 2/)
  assert.equal(value.content[1].type, 'image')
  await assert.rejects(
    () => definition.execute({ label: 0 }, { callId: 'c-bad', signal: new AbortController().signal }),
    /positive integer label/,
  )
})


test('screenshot content reports canvas surfaces', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_screenshot')
  const value = await definition.execute({}, { callId: 'c-surface', signal: new AbortController().signal })
  assert.match(value.content[0].text, /surfaces \(no DOM labels; use browser_click_at\): canvas 800x420 @20,100/)
})

test('click_at reports trusted input and pixel change', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click_at')
  const value = await definition.execute({ x: 100, y: 200 }, { callId: 'c-at', signal: new AbortController().signal })
  assert.match(value.content[0].text, /clicked at \(100, 200\) image px → css \(80, 160\) · trusted input/)
  assert.match(value.content[0].text, /result: changed \(pixels-changed 1\.4%\)/)
  assert.equal(value.content[1].type, 'image')
  await assert.rejects(
    () => definition.execute({ x: 'a', y: 2 }, { callId: 'c-bad-at', signal: new AbortController().signal }),
    /finite x and y/,
  )
})

test('click_at multi-point content lists every point and the changed count', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click_at')
  const value = await definition.execute({
    points: [{ x: 100, y: 200 }, { x: 300, y: 400 }, { x: 500, y: 500 }],
  }, { callId: 'c-multi', signal: new AbortController().signal })
  const text = value.content[0].text
  assert.match(text, /clicked 3 points with trusted input in 210ms/)
  assert.match(text, /  \[1\] \(100, 200\) image → css \(80, 160\) · changed 1\.4%/)
  assert.match(text, /  \[2\] \(300, 400\) image → css \(240, 320\) · no visible change/)
  assert.match(text, /  \[3\] \(500, 500\) image → css \(400, 400\) · changed 0\.5%/)
  assert.match(text, /2\/3 points changed pixels/)
  assert.equal(value.content[1].type, 'image')
  assert.deepEqual(commands.at(-1), { op: 'click_at', args: { points: [{ x: 100, y: 200 }, { x: 300, y: 400 }, { x: 500, y: 500 }] } })
})

test('click_at with view:none returns text only and explains the skipped screenshot', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click_at')
  const value = await definition.execute({
    points: [{ x: 100, y: 200 }, { x: 300, y: 400 }],
    view: 'none',
    settle_ms: 80,
  }, { callId: 'c-none', signal: new AbortController().signal })
  assert.equal(value.content.length, 1)
  assert.equal(value.content[0].type, 'text')
  const text = value.content[0].text
  assert.match(text, /clicked 2 points with trusted input in 180ms/)
  assert.match(text, /change unknown \(no previous view\)/)
  assert.match(text, /screenshot skipped \(view "none"\)/)
  assert.match(text, /image coordinates still map to the previous view/)
  assert.doesNotMatch(text, /points changed pixels/)
  assert.doesNotMatch(text, /labels \(click by number\)/)
  assert.deepEqual(commands.at(-1), {
    op: 'click_at',
    args: { points: [{ x: 100, y: 200 }, { x: 300, y: 400 }], view: 'none', settle_ms: 80 },
  })
})

test('click_at rejects ambiguous, empty, and oversized point sets', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_click_at')
  const exec = { callId: 'c-invalid', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({}, exec), /requires x and y, or a non-empty points array/)
  await assert.rejects(() => definition.execute({ y: 2 }, exec), /requires both x and y/)
  await assert.rejects(
    () => definition.execute({ x: 1, y: 2, points: [{ x: 3, y: 4 }] }, exec),
    /either x\/y or points, not both/,
  )
  await assert.rejects(() => definition.execute({ points: [] }, exec), /non-empty array/)
  await assert.rejects(
    () => definition.execute({ points: Array.from({ length: 9 }, (_, index) => ({ x: index, y: index })) }, exec),
    /at most 8 points/,
  )
  await assert.rejects(() => definition.execute({ points: [{ x: 'a', y: 1 }] }, exec), /finite x and y/)
})

test('select and hover tools report their outcome', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const select = await fake.tools.get('browser_select_option').execute(
    { label: 4, option: 'Canada' },
    { callId: 'c-select', signal: new AbortController().signal },
  )
  assert.match(select.content[0].text, /selected "Canada" \(value "ca"\)/)

  const hover = await fake.tools.get('browser_hover').execute(
    { label: 5 },
    { callId: 'c-hover', signal: new AbortController().signal },
  )
  assert.match(hover.content[0].text, /hovered label 5: button "Menu"/)
  assert.match(hover.content[0].text, /\[6\] button "Menu item"/)
})

test('type tool types into a labelled field and reports the new value', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_type')
  const value = await definition.execute(
    { text: 'jane@example.com', label: 7 },
    { callId: 'c-type', signal: new AbortController().signal },
  )
  assert.equal(value.content[0].type, 'text')
  assert.match(value.content[0].text, /typed into \[7\] textbox "Email" · replace · 12 chars · dom/)
  assert.match(value.content[0].text, /value now "jane@example\.com"/)
  assert.equal(value.content[1].type, 'image')
  assert.deepEqual(commands.at(-1), { op: 'type', args: { text: 'jane@example.com', label: 7 } })
})

test('type tool supports focused append/submit and password previews', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_type')
  const exec = { callId: 'c-type-2', signal: new AbortController().signal }
  const focused = await definition.execute({ text: 'hello', mode: 'append', submit: true }, exec)
  assert.match(focused.content[0].text, /typed 5 chars into the focused element · append · trusted · submitted/)
  assert.match(focused.content[0].text, /value now "hello"/)
  assert.deepEqual(commands.at(-1), { op: 'type', args: { text: 'hello', mode: 'append', submit: true } })

  const password = await definition.execute({ text: 'supersecret', label: 8 }, exec)
  assert.match(password.content[0].text, /typed into \[8\] textbox "Password" · replace · 12 chars · trusted/)
  assert.match(password.content[0].text, /value now "\[password 12 chars\]"/)
  assert.doesNotMatch(password.content[0].text, /supersecret/)

  const unchanged = await definition.execute({ text: 'NOCHANGE', label: 7 }, exec)
  assert.match(unchanged.content[0].text, /result: NO VISIBLE CHANGE/)
})

test('type validation rejects non-string text and bad options', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_type')
  const exec = { callId: 'c-type-bad', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({ text: 5 }, exec), /requires a string text/)
  await assert.rejects(() => definition.execute({ text: 'x', label: 0 }, exec), /label must be a positive integer/)
  await assert.rejects(() => definition.execute({ text: 'x', mode: 'fill' }, exec), /replace" or "append"/)
  const cleared = await definition.execute({ text: '', label: 7 }, exec)
  assert.match(cleared.content[0].text, /typed into \[7\]/)
})

test('press_key reports the chord and rejects unknown modifiers', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_press_key')
  const exec = { callId: 'c-key', signal: new AbortController().signal }
  const trusted = await definition.execute({ key: 'KeyA', modifiers: ['ctrl'] }, exec)
  assert.match(trusted.content[0].text, /pressed ctrl\+KeyA · trusted/)
  assert.deepEqual(commands.at(-1), { op: 'press_key', args: { key: 'KeyA', modifiers: ['ctrl'] } })

  const synthetic = await definition.execute({ key: 'Enter' }, exec)
  assert.match(synthetic.content[0].text, /pressed Enter · synthetic/)
  assert.deepEqual(commands.at(-1), { op: 'press_key', args: { key: 'Enter' } })

  await assert.rejects(
    () => definition.execute({ key: 'KeyA', modifiers: ['hyper'] }, exec),
    /not one of ctrl, alt, shift, meta/,
  )
  await assert.rejects(() => definition.execute({ key: '' }, exec), /non-empty key name/)
  await assert.rejects(() => definition.execute({ key: 'KeyA', modifiers: 'ctrl' }, exec), /modifiers must be an array/)
})

test('navigate reports the destination, history moves, and timeouts', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_navigate')
  const exec = { callId: 'c-nav', signal: new AbortController().signal }
  const direct = await definition.execute({ url: 'https://example.test/docs' }, exec)
  assert.match(direct.content[0].text, /navigated to https:\/\/example\.test\/docs · loaded in 812ms/)
  assert.equal(direct.content[1].type, 'image')
  assert.deepEqual(commands.at(-1), { op: 'navigate', args: { url: 'https://example.test/docs' } })

  const newTab = await definition.execute({ url: 'https://example.test/docs', new_tab: true }, exec)
  assert.match(newTab.content[0].text, /new tab · loaded in 812ms/)
  assert.deepEqual(commands.at(-1), { op: 'navigate', args: { url: 'https://example.test/docs', new_tab: true } })

  const back = await definition.execute({ history: 'back' }, exec)
  assert.match(back.content[0].text, /navigated back to https:\/\/example\.test\/a · loaded in 120ms/)
  assert.deepEqual(commands.at(-1), { op: 'navigate', args: { history: 'back' } })

  const slow = await definition.execute({ url: 'https://example.test/slow' }, exec)
  assert.match(slow.content[0].text, /load timed out after 10000ms/)
  assert.match(slow.content[0].text, /use browser_wait_for/)
})

test('navigate validation rejects bad targets and combinations', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_navigate')
  const exec = { callId: 'c-nav-bad', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({}, exec), /requires url or history/)
  await assert.rejects(
    () => definition.execute({ url: 'https://example.test', history: 'back' }, exec),
    /either url or history/,
  )
  await assert.rejects(() => definition.execute({ history: 'sideways' }, exec), /history must be/)
  await assert.rejects(() => definition.execute({ url: 'ftp://example.test/x' }, exec), /only http and https/)
  await assert.rejects(() => definition.execute({ url: 'not a url' }, exec), /absolute http\(s\) URL/)
  await assert.rejects(() => definition.execute({ history: 'reload', new_tab: true }, exec), /new_tab is only valid with url/)
})

test('wait_for reports found and timed-out conditions', async t => {
  const { server, url, commands } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_wait_for')
  const exec = { callId: 'c-wait', signal: new AbortController().signal }
  const found = await definition.execute({ text: 'READY' }, exec)
  assert.match(found.content[0].text, /waited for text "READY" · found after 812ms/)
  assert.equal(found.content[1].type, 'image')
  assert.deepEqual(commands.at(-1), { op: 'wait_for', args: { text: 'READY' } })

  const timeout = await definition.execute({ text: 'NEVER' }, exec)
  assert.match(timeout.content[0].text, /timed out after 10000ms \(text "NEVER" not found\)/)

  await definition.execute({ text: 'READY', timeout_ms: 15000 }, exec)
  assert.deepEqual(commands.at(-1), { op: 'wait_for', args: { text: 'READY', timeout_ms: 15000 } })
})

test('wait_for validation requires a condition and bounded values', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  const definition = fake.tools.get('browser_wait_for')
  const exec = { callId: 'c-wait-bad', signal: new AbortController().signal }
  await assert.rejects(() => definition.execute({}, exec), /at least one condition/)
  await assert.rejects(() => definition.execute({ text: '' }, exec), /non-empty string/)
  await assert.rejects(() => definition.execute({ idle: false }, exec), /at least one condition/)
  await assert.rejects(() => definition.execute({ idle: 'yes' }, exec), /idle must be true or false/)
  await assert.rejects(() => definition.execute({ ms: -1 }, exec), /between 0 and 30000/)
  await assert.rejects(() => definition.execute({ ms: 40000 }, exec), /between 0 and 30000/)
  await assert.rejects(
    () => definition.execute({ text: 'x', timeout_ms: 500 }, exec),
    /timeout_ms must be an integer between 1000 and 30000/,
  )
})
