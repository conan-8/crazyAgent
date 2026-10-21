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
  trusted: true,
  changed: true,
  pixelsChanged: 1.4,
  clickMs: 210,
  labels: [],
  surfaces: [{ kind: 'canvas', x: 20, y: 100, w: 800, h: 420 }],
  image: IMAGE,
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

async function startFakeBridge() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const port = server.address().port
  const activities = []
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
        const result = op === 'scroll' ? SCROLL
          : op === 'tabs.list' ? TABS
            : op === 'read_text' ? READ_TEXT
              : op === 'click' ? CLICK
                : op === 'click_at' ? CLICK_AT
                  : op === 'select_option' ? SELECT
                    : op === 'hover' ? HOVER
                      : SNAPSHOT
        ws.send(JSON.stringify({ v: 1, type: 'browser.result', id: message.id, ok: true, result }))
      }
    })
  })
  return { server, url: `ws://127.0.0.1:${port}/bridge`, activities }
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

test('registers the provider, guidance, and the nine browser tools', async t => {
  const { server, url } = await startFakeBridge()
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const fake = makeContext()
  apply(fake.ctx, { bridgeUrl: url, bridgeToken: 'test', requestTimeoutMs: 2_000 })
  t.after(() => fake.dispose())

  assert.equal(String(fake.getProvider()), 'extension-current-window')
  assert.deepEqual([...fake.tools.keys()].sort(), ['browser_click', 'browser_click_at', 'browser_hover', 'browser_read_text', 'browser_screenshot', 'browser_scroll', 'browser_select_option', 'browser_switch_tab', 'browser_tabs'])
  assert.equal(fake.sections.length, 1)
  assert.match(fake.sections[0].text, /untrusted data/)
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
