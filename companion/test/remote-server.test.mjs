import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import WebSocket from 'ws'
import { Bridge } from '../bridge.mjs'
import { RemoteHub } from '../remote-hub.mjs'
import { MAX_COMMAND_BODY_BYTES, RemoteServer } from '../remote-server.mjs'
import { PushRegistry, PushService, pushTypeForTurn } from '../remote-push.mjs'
import { SessionController, uiRejectionFrame } from '../session-controller.mjs'
import { FakeRunner, fakeBridge, fakeLogStore, http, openEvents, sleep } from './remote-fixtures.mjs'

const TOKEN = 'b'.repeat(64)
const PUBLIC_HOST = 'host.tailnet.ts.net'

/**
 * Real RemoteServer + RemoteHub + SessionController over a fake runner.
 * `bridge` may be a real Bridge for side-panel integration tests.
 */
async function setup(t, options = {}) {
  let token = options.token ?? TOKEN
  let runner = options.runner === null ? undefined : (options.runner ?? new FakeRunner())
  const bridge = options.bridge ?? fakeBridge()
  const health = { uiConnected: false, toolsConnected: false, dsh: 'ready', model: 'model-x' }
  const hub = new RemoteHub({ instanceId: 'inst-test', serverVersion: 'test', getHealth: () => ({ ...health }), ...options.hub })
  const uiFrames = []
  const controller = new SessionController({
    bridge,
    getRunner: () => runner,
    logStore: fakeLogStore(),
    autoCapture: options.autoCapture ?? false,
    provider: 'openrouter',
    getModelId: () => 'model-x',
    publish: frame => {
      uiFrames.push(frame)
      bridge.sendToUi?.(frame)
      hub.ingest(frame)
    },
    observers: [{ turnStarted: info => hub.turnStarted(info), turnEnded: info => hub.turnEnded(info) }],
  })
  hub.updateHealth()
  const audits = []
  const server = new RemoteServer({
    port: 0,
    getToken: () => token,
    publicHost: PUBLIC_HOST,
    hub,
    controller,
    audit: (event, data) => audits.push({ event, ...data }),
    push: options.push,
    heartbeatMs: options.heartbeatMs ?? 60_000,
    limits: options.limits,
  })
  await server.start()
  t.after(() => server.stop())
  return {
    server,
    hub,
    controller,
    uiFrames,
    audits,
    health,
    get runner() { return runner },
    setRunner(next) { runner = next },
    setToken(next) { token = next },
    port: server.port,
    call: (opts) => http(server.port, { token: TOKEN, ...opts }),
  }
}

test('authentication: missing, wrong, and non-Bearer credentials are refused with the error envelope', async t => {
  const ctx = await setup(t)
  for (const headers of [{}, { authorization: `Bearer ${'c'.repeat(64)}` }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN} extra` }]) {
    const res = await http(ctx.port, { path: '/remote/v1/state', headers })
    assert.equal(res.status, 401)
    assert.deepEqual(res.body, { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid remote token.', retryable: false } })
    assert.equal(res.headers['www-authenticate'], 'Bearer')
  }
  const ok = await ctx.call({ path: '/remote/v1/state' })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['cache-control'], 'no-store')
  assert.equal(ok.headers['x-content-type-options'], 'nosniff')
  assert.ok(ok.headers['x-request-id'])
})

test('a removed remote token fails closed', async t => {
  const ctx = await setup(t)
  ctx.setToken(undefined)
  assert.equal((await ctx.call({ path: '/remote/v1/state' })).status, 401)
})

test('authentication failures are throttled but a valid token still works', async t => {
  const ctx = await setup(t, { limits: { authFailuresPerMinute: 2 } })
  const bad = { path: '/remote/v1/state', headers: { authorization: 'Bearer nope' } }
  assert.equal((await http(ctx.port, bad)).status, 401)
  assert.equal((await http(ctx.port, bad)).status, 401)
  const throttled = await http(ctx.port, bad)
  assert.equal(throttled.status, 429)
  assert.equal(throttled.body.error.code, 'AUTH_THROTTLED')
  assert.equal((await ctx.call({ path: '/remote/v1/state' })).status, 200)
})

test('Host validation accepts loopback and the configured Serve authority only', async t => {
  const ctx = await setup(t)
  for (const host of [PUBLIC_HOST, `${PUBLIC_HOST}:443`, `localhost:${ctx.port}`, `${PUBLIC_HOST.toUpperCase()}`]) {
    assert.equal((await ctx.call({ path: '/remote/v1/state', headers: { host } })).status, 200, host)
  }
  for (const host of ['evil.example', `${PUBLIC_HOST}:8443`, `127.0.0.1:${ctx.port + 1}`, '100.96.64.4']) {
    const res = await ctx.call({ path: '/remote/v1/state', headers: { host } })
    assert.equal(res.status, 421, host)
    assert.equal(res.body.error.code, 'HOST_NOT_ALLOWED')
  }
})

test('routes, methods, content types, malformed JSON, and body limits fail with structured errors', async t => {
  const ctx = await setup(t)
  const cases = [
    [{ path: '/remote/v1/messages' }, 405, 'METHOD_NOT_ALLOWED'],
    [{ method: 'DELETE', path: '/remote/v1/state' }, 405, 'METHOD_NOT_ALLOWED'],
    [{ path: '/remote/v1/nope' }, 404, 'NOT_FOUND'],
    [{ path: '/remote/v2/state' }, 404, 'NOT_FOUND'],
    [{ path: '/bridge' }, 404, 'NOT_FOUND'],
    [{ path: '/health' }, 404, 'NOT_FOUND'],
    [{ path: '/remote/v1/screenshots/..%2f..%2ftoken' }, 404, 'NOT_FOUND'],
    [{ path: '/remote/v1/../v1/state' }, 404, 'NOT_FOUND'],
    [{ path: '/remote/v1/screenshots/shot-123' }, 404, 'SCREENSHOT_NOT_FOUND'],
    [{ path: '/remote/v1/screenshots/a.b' }, 400, 'INVALID_SCREENSHOT_ID'],
    [{ method: 'GET', path: '/remote/v1/snapshots' }, 405, 'METHOD_NOT_ALLOWED'],
    [{ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'short' } }, 422, 'INVALID_CLIENT_ID'],
    [{ method: 'PUT', path: '/remote/v1/push/devices/phone-1', body: { fcmToken: 'x', platform: 'android' } }, 503, 'PUSH_NOT_CONFIGURED'],
    [{ method: 'PUT', path: '/remote/v1/push/devices/phone.1', body: {} }, 400, 'INVALID_DEVICE_ID'],
    [{ method: 'GET', path: '/remote/v1/push/devices/phone-1' }, 405, 'METHOD_NOT_ALLOWED'],
    [{ path: '/remote/v1/events' }, 426, 'UPGRADE_REQUIRED'],
    [{ method: 'POST', path: '/remote/v1/stop', rawBody: '{', headers: { 'content-type': 'application/json' } }, 400, 'MALFORMED_JSON'],
    [{ method: 'POST', path: '/remote/v1/stop', rawBody: '[]', headers: { 'content-type': 'application/json' } }, 400, 'MALFORMED_JSON'],
    [{ method: 'POST', path: '/remote/v1/stop', rawBody: '{}', headers: { 'content-type': 'text/plain' } }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ method: 'POST', path: '/remote/v1/stop', body: { clientCommandId: 'x'.repeat(MAX_COMMAND_BODY_BYTES) } }, 413, 'PAYLOAD_TOO_LARGE'],
    [{ method: 'POST', path: '/remote/v1/stop', body: { clientCommandId: 'short' } }, 422, 'INVALID_CLIENT_ID'],
    [{ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 5 } }, 422, 'INVALID_TEXT'],
    [{ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'x', images: {} } }, 422, 'INVALID_ATTACHMENT'],
  ]
  for (const [opts, status, code] of cases) {
    const res = await ctx.call(opts)
    assert.equal(res.status, status, `${opts.method ?? 'GET'} ${opts.path}`)
    assert.equal(res.body.error.code, code, `${opts.method ?? 'GET'} ${opts.path}`)
    assert.equal(typeof res.body.error.message, 'string')
    assert.equal(typeof res.body.error.retryable, 'boolean')
  }
  assert.equal(ctx.runner.runs.length, 0)
  const methodNotAllowed = await ctx.call({ path: '/remote/v1/messages' })
  assert.equal(methodNotAllowed.headers.allow, 'POST')
})

test('the audit trail records route/status only, never tokens or prompt text', async t => {
  const ctx = await setup(t)
  await http(ctx.port, { path: '/remote/v1/state', headers: { authorization: 'Bearer wrong-secret' } })
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'secret prompt' } })
  const serialized = JSON.stringify(ctx.audits)
  assert.ok(!serialized.includes(TOKEN))
  assert.ok(!serialized.includes('wrong-secret'))
  assert.ok(!serialized.includes('secret prompt'))
  assert.ok(ctx.audits.some(entry => entry.event === 'request' && entry.route === '/remote/v1/messages' && entry.status === 202))
})

test('POST /messages accepts one turn, and a retried client ID returns the original outcome without another turn', async t => {
  const ctx = await setup(t)
  const body = { clientMessageId: 'a1b2c3d4-0000-4000-8000-000000000001', text: 'do the thing' }
  const first = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body })
  assert.equal(first.status, 202)
  assert.equal(first.body.accepted, true)
  assert.equal(first.body.instanceId, 'inst-test')
  assert.match(first.body.turnId, /^turn-/u)

  const retry = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body })
  assert.equal(retry.status, 202)
  assert.equal(retry.body.turnId, first.body.turnId)
  assert.equal(retry.body.replayed, true)
  assert.equal(ctx.runner.runs.length, 1)

  const conflict = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { ...body, text: 'different' } })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT')

  // Lost acceptance response: the turn finishes, then the client retries the same ID.
  ctx.runner.current.resolve('ok')
  await sleep(10)
  const late = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body })
  assert.equal(late.body.turnId, first.body.turnId)
  assert.equal(ctx.runner.runs.length, 1, 'a retried ID never starts the prompt twice')

  const state = (await ctx.call({ path: '/remote/v1/state' })).body
  assert.equal(state.turn.status, 'idle')
  assert.equal(state.turn.outcome, 'done')
  const user = state.messages.find(message => message.type === 'chat.user')
  assert.equal(user.body.text, 'do the thing')
  assert.equal(user.body.origin, 'remote')
  assert.equal(user.body.clientMessageId, body.clientMessageId)
  assert.ok(state.messages.some(message => message.type === 'chat.done'))
})

test('POST /messages carries explicit plan mode with validation and idempotency', async t => {
  const ctx = await setup(t)
  const body = { clientMessageId: 'client-plan-0001', text: 'plan this task', planMode: true }
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/messages', body })).status, 202)
  assert.match(ctx.runner.runs[0][0].text, /<plan_mode>/u)
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body })
  assert.equal(ctx.runner.runs.length, 1)
  const changed = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { ...body, planMode: false } })
  assert.equal(changed.status, 409)
  assert.equal(changed.body.error.code, 'IDEMPOTENCY_CONFLICT')
  const invalid = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-plan-0002', text: 'x', planMode: 'yes' } })
  assert.equal(invalid.status, 422)
  assert.equal(invalid.body.error.code, 'INVALID_PLAN_MODE')
  ctx.runner.current.resolve()
  await sleep(10)
})

test('simultaneous submissions from different clients start exactly one turn', async t => {
  const ctx = await setup(t)
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => ctx.call({
    method: 'POST',
    path: '/remote/v1/messages',
    body: { clientMessageId: `client-${String(i).padStart(4, '0')}`, text: `prompt ${i}` },
  })))
  const accepted = results.filter(res => res.status === 202)
  const busy = results.filter(res => res.status === 409)
  assert.equal(accepted.length, 1)
  assert.equal(busy.length, 5)
  assert.ok(busy.every(res => res.body.error.code === 'TURN_BUSY' && res.body.error.retryable === true))
  assert.equal(ctx.runner.runs.length, 1)
})

test('an unready runtime returns 503 and starts nothing', async t => {
  const ctx = await setup(t, { runner: null })
  const res = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'x' } })
  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'RUNTIME_NOT_READY')
})

test('prompt submissions are rate limited', async t => {
  const ctx = await setup(t, { limits: { messagesPerMinute: 1 } })
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'x' } })
  const limited = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0002', text: 'y' } })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.error.code, 'RATE_LIMITED')
})

test('POST /stop follows the real lifecycle and is idempotent', async t => {
  const ctx = await setup(t)
  const idle = await ctx.call({ method: 'POST', path: '/remote/v1/stop', body: { clientCommandId: 'stop-0000' } })
  assert.equal(idle.status, 200)
  assert.equal(idle.body.state, 'idle')

  const events = openEvents(ctx.port, { token: TOKEN })
  await events.opened
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'long task' } })
  const stop = await ctx.call({ method: 'POST', path: '/remote/v1/stop', body: { clientCommandId: 'stop-0001' } })
  assert.equal(stop.status, 202)
  assert.equal(stop.body.state, 'stopping')
  const again = await ctx.call({ method: 'POST', path: '/remote/v1/stop', body: { clientCommandId: 'stop-0001' } })
  assert.equal(again.body.replayed, true)
  const stopped = await events.next(frame => frame.type === 'chat.stopped')
  assert.equal(stopped.body.reason, 'user')
  await events.next(frame => frame.type === 'chat.turn' && frame.body.outcome === 'stopped')
  assert.equal(ctx.runner.interrupts, 1)
  assert.equal((await ctx.call({ path: '/remote/v1/state' })).body.turn.status, 'idle')
  await events.close()
})

test('POST /new refuses while running and starts a fresh session when idle', async t => {
  const ctx = await setup(t)
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'x' } })
  const busy = await ctx.call({ method: 'POST', path: '/remote/v1/new', body: { clientCommandId: 'new-00001' } })
  assert.equal(busy.status, 409)
  assert.equal(busy.body.error.code, 'TURN_BUSY')
  ctx.runner.current.resolve()
  await sleep(10)
  const [a, b] = await Promise.all([
    ctx.call({ method: 'POST', path: '/remote/v1/new', body: { clientCommandId: 'new-00002' } }),
    ctx.call({ method: 'POST', path: '/remote/v1/new', body: { clientCommandId: 'new-00002' } }),
  ])
  assert.equal(a.status, 200)
  assert.equal(b.body.sessionId, a.body.sessionId, 'a concurrent duplicate shares one outcome')
  assert.equal(ctx.runner.sessions, 2, 'only one new session was created')
  const state = (await ctx.call({ path: '/remote/v1/state' })).body
  assert.equal(state.sessionId, a.body.sessionId)
  assert.deepEqual(state.messages, [])
})

test('GET /sessions lists saved chats and returns only their bounded transcripts', async t => {
  const ctx = await setup(t)
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'history title' } })
  ctx.runner.assistant('saved answer')
  ctx.runner.current.resolve('done')
  await sleep(10)

  const list = await ctx.call({ path: '/remote/v1/sessions' })
  assert.equal(list.status, 200)
  assert.equal(list.body.sessions[0].title, 'history title')
  assert.equal(list.body.sessions[0].current, true)
  assert.equal(list.body.sessions[0].running, false)
  assert.equal(list.body.sessions[0].messageCount, 3)
  const transcript = await ctx.call({ path: '/remote/v1/sessions/session-1' })
  assert.equal(transcript.status, 200)
  assert.equal(transcript.body.title, 'history title')
  assert.ok(transcript.body.messages.some(message => message.type === 'chat.assistant' && message.body.text === 'saved answer'))
  assert.equal((await ctx.call({ path: '/remote/v1/sessions/missing' })).status, 404)
  assert.equal((await ctx.call({ path: '/remote/v1/sessions/a.b' })).status, 400)
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/sessions/session-1' })).status, 405)
  assert.ok(!JSON.stringify(transcript.body).includes('browser.command'))
})

test('/events: resync without a cursor, ordered replay with one, and live events after', async t => {
  const ctx = await setup(t)
  const first = openEvents(ctx.port, { token: TOKEN })
  await first.opened
  const resync = await first.next()
  assert.equal(resync.type, 'remote.resync')
  assert.equal(resync.body.reason, 'no-instance')
  assert.equal(resync.body.state.instanceId, 'inst-test')
  await first.close()

  const cursor = ctx.hub.seq
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'stream' } })
  ctx.runner.assistant('partial answer')

  const resumed = openEvents(ctx.port, { token: TOKEN, query: `instance=inst-test&after=${cursor}` })
  await resumed.opened
  await resumed.next(frame => frame.type === 'chat.assistant')
  ctx.runner.current.resolve('final')
  await resumed.next(frame => frame.type === 'chat.turn')
  const seqs = resumed.frames.map(frame => frame.seq)
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'events arrive in sequence order')
  assert.equal(seqs[0], cursor + 1, 'replay starts right after the cursor')
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicates across the replay/live handoff')
  assert.ok(resumed.frames.every(frame => frame.instanceId === 'inst-test'))
  assert.ok(resumed.frames.some(frame => frame.type === 'chat.user'))
  await resumed.close()

  const other = openEvents(ctx.port, { token: TOKEN, query: `instance=old-instance&after=3` })
  await other.opened
  assert.equal((await other.next()).body.reason, 'instance-changed')
  await other.close()
})

test('/events resyncs when the cursor is older than the bounded journal', async t => {
  const ctx = await setup(t, { hub: { journalLimit: 3 } })
  for (let i = 0; i < 10; i += 1) ctx.hub.publish('chat.status', { i }, { turnId: null })
  const events = openEvents(ctx.port, { token: TOKEN, query: 'instance=inst-test&after=1' })
  await events.opened
  const frame = await events.next()
  assert.equal(frame.type, 'remote.resync')
  assert.equal(frame.body.reason, 'expired-sequence')
  await events.close()
})

test('/events upgrade requires auth, a valid Host, and the events path', async t => {
  const ctx = await setup(t)
  await assert.rejects(openEvents(ctx.port, {}).opened, error => error.status === 401)
  await assert.rejects(openEvents(ctx.port, { token: 'b'.repeat(63) }).opened, error => error.status === 401)
  await assert.rejects(openEvents(ctx.port, { token: TOKEN, headers: { host: 'evil.example' } }).opened, error => error.status === 421)
  const wrongPath = new WebSocket(`ws://127.0.0.1:${ctx.port}/bridge`, { headers: { authorization: `Bearer ${TOKEN}` } })
  const status = await new Promise(resolve => {
    wrongPath.once('unexpected-response', (_req, res) => resolve(res.statusCode))
    wrongPath.once('open', () => resolve('open'))
  })
  assert.equal(status, 404)
  // A bridge hello on the remote port is never a ui/tools role.
  const events = openEvents(ctx.port, { token: TOKEN })
  await events.opened
  events.ws.send(JSON.stringify({ type: 'hello', role: 'ui', token: TOKEN }))
  events.ws.send(JSON.stringify({ type: 'chat.send', text: 'injected' }))
  await sleep(30)
  assert.equal(ctx.runner.runs.length, 0)
  assert.ok(!events.frames.some(frame => frame.type === 'hello.ok'))
  await events.close()
})

test('rotating the remote token revokes open event streams', async t => {
  const ctx = await setup(t, { heartbeatMs: 30 })
  const events = openEvents(ctx.port, { token: TOKEN })
  await events.opened
  ctx.setToken('d'.repeat(64))
  const closed = await events.closed
  assert.equal(closed.code, 4401)
  assert.equal((await ctx.call({ path: '/remote/v1/state' })).status, 401)
})

test('stop() closes streams and releases the port', async t => {
  const ctx = await setup(t)
  const events = openEvents(ctx.port, { token: TOKEN })
  await events.opened
  await ctx.server.stop()
  assert.equal((await events.closed).code, 1001)
  const refused = await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: ctx.port })
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(true))
  })
  assert.equal(refused, true)
})

test('constructor refuses a non-loopback bind', () => {
  assert.throws(() => new RemoteServer({ host: '0.0.0.0', getToken: () => TOKEN, hub: new RemoteHub(), controller: {} }), /loopback only/u)
})

// --- Integration with the real private bridge and a fake side panel ---------

async function connectRole(url, role, token) {
  const ws = new WebSocket(url)
  const frames = []
  ws.on('message', data => frames.push(JSON.parse(data.toString())))
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(JSON.stringify({ v: 1, type: 'hello', role, token, version: 1 }))
  for (let i = 0; i < 100 && !frames.some(frame => frame.type === 'hello.ok'); i += 1) await sleep(5)
  return { ws, frames }
}

test('a remote turn uses the panel executor, the panel sees the lifecycle, and remote clients never see browser commands', async t => {
  const bridgeToken = 'bridge-token'
  const bridge = new Bridge({
    host: '127.0.0.1',
    port: 0,
    token: bridgeToken,
    log: () => {},
    // Same wiring as companion/index.mjs: the panel shares the controller.
    onChat: (text, _ws, message) => {
      const result = ref.ctx.controller.submit({ text, images: message.images, autoCapture: message.autoCapture, origin: 'ui' })
      if (!result.ok) bridge.sendToUi(uiRejectionFrame(result))
    },
    onNewChat: () => {},
    uiGraceMs: 0,
    onActivity: frame => ref.ctx?.hub.ingest(frame),
  })
  const ref = {}
  await bridge.start()
  t.after(() => bridge.stop())
  const ctx = await setup(t, { bridge, autoCapture: true })
  ref.ctx = ctx
  const bridgeUrl = `ws://127.0.0.1:${bridge.port}/bridge`
  const ui = await connectRole(bridgeUrl, 'ui', bridgeToken)
  // The panel answers the companion's auto-capture command.
  ui.ws.on('message', data => {
    const frame = JSON.parse(data.toString())
    if (frame.type === 'browser.command') {
      ui.ws.send(JSON.stringify({ v: 1, type: 'browser.result', id: frame.id, ok: true, result: { view: 'compact', screenshotSkipped: true, text: 'page' } }))
    }
  })
  const tools = await connectRole(bridgeUrl, 'tools', bridgeToken)

  const phoneA = openEvents(ctx.port, { token: TOKEN })
  const phoneB = openEvents(ctx.port, { token: TOKEN })
  await Promise.all([phoneA.opened, phoneB.opened])

  const accepted = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'from phone' } })
  assert.equal(accepted.status, 202)
  // Desktop panel tries to send at the same time: refused as busy, panel only.
  ui.ws.send(JSON.stringify({ v: 1, type: 'chat.send', text: 'from desktop' }))
  await ctx.runner.started()
  // Provider streams activity through the bridge → hub draft.
  tools.ws.send(JSON.stringify({ v: 1, type: 'activity', activity: { kind: 'text', text: 'Work' } }))
  await phoneA.next(frame => frame.type === 'chat.draft')
  ctx.runner.assistant('Working')
  ctx.runner.current.resolve('All done')
  await Promise.all([
    phoneA.next(frame => frame.type === 'chat.turn'),
    phoneB.next(frame => frame.type === 'chat.turn'),
  ])
  for (let i = 0; i < 100 && !ui.frames.some(frame => frame.type === 'chat.done'); i += 1) await sleep(5)

  assert.equal(ctx.runner.runs.length, 1, 'one DSH run for one accepted prompt')
  assert.ok(ui.frames.some(frame => frame.type === 'browser.command' && frame.command.op === 'auto_view'), 'the panel executed auto-capture')
  assert.ok(ui.frames.some(frame => frame.type === 'chat.done' && frame.text === 'All done'), 'the panel received the lifecycle')
  assert.ok(ui.frames.some(frame => frame.type === 'chat.activity' && frame.text === 'Work'))
  for (const phone of [phoneA, phoneB]) {
    const serialized = JSON.stringify(phone.frames)
    assert.ok(!phone.frames.some(frame => /^browser\./u.test(frame.type)), 'no browser frames reach remote clients')
    assert.ok(!serialized.includes('auto_view'))
    assert.ok(!serialized.includes(bridgeToken))
    assert.ok(phone.frames.some(frame => frame.type === 'chat.done' && frame.body.text === 'All done'))
  }
  assert.deepEqual(phoneA.frames.map(frame => frame.seq), phoneB.frames.map(frame => frame.seq), 'both phones see the same canonical stream')
  assert.ok(!phoneA.frames.some(frame => frame.type === 'chat.user' && frame.body.text === 'from desktop'), 'the refused desktop send started no turn')
  assert.ok(ui.frames.some(frame => frame.type === 'chat.error' && frame.code === 'TURN_BUSY'), 'the panel was told the turn slot is busy')
  const userIndex = ui.frames.findIndex(frame => frame.type === 'chat.user' && frame.origin === 'remote' && frame.text === 'from phone')
  assert.ok(userIndex >= 0, 'the panel received the phone prompt')
  assert.ok(userIndex < ui.frames.findIndex(frame => frame.type === 'chat.error' && frame.code === 'TURN_BUSY'), 'the phone prompt precedes the busy refusal')
  assert.ok(!phoneA.frames.some(frame => frame.type === 'chat.error'), 'the panel-only busy reply is not broadcast')
  await Promise.all([phoneA.close(), phoneB.close()])
  ui.ws.close()
  tools.ws.close()
})

test('the remote token never authenticates a bridge role', async t => {
  const bridge = new Bridge({ host: '127.0.0.1', port: 0, token: 'bridge-token', log: () => {}, onChat: () => {}, onNewChat: () => {}, uiGraceMs: 0 })
  await bridge.start()
  t.after(() => bridge.stop())
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`)
  await new Promise(resolve => ws.once('open', resolve))
  ws.send(JSON.stringify({ v: 1, type: 'hello', role: 'ui', token: TOKEN, version: 1 }))
  const closed = await new Promise(resolve => ws.once('close', code => resolve(code)))
  assert.equal(closed, 4001)
  assert.equal(bridge.hasUi(), false)
})

test('a mirrored screenshot is served as authenticated binary by opaque ID', async t => {
  const ctx = await setup(t)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const meta = ctx.hub.addScreenshot({ data: png.toString('base64'), mimeType: 'image/png', source: 'tool' })
  const state = await ctx.call({ path: '/remote/v1/state' })
  assert.equal(state.body.latestScreenshotId, meta.screenshotId)
  assert.equal(state.body.latestScreenshot.bytes, png.length)

  const res = await ctx.call({ path: `/remote/v1/screenshots/${meta.screenshotId}` })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(Number(res.headers['content-length']), png.length)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.ok(res.raw.equals(png))

  const unauthenticated = await http(ctx.port, { path: `/remote/v1/screenshots/${meta.screenshotId}` })
  assert.equal(unauthenticated.status, 401)
  assert.equal((await ctx.call({ method: 'POST', path: `/remote/v1/screenshots/${meta.screenshotId}`, body: {} })).status, 405)
  assert.equal((await ctx.call({ path: '/remote/v1/screenshots/shot-000000000000000000000000' })).status, 404)
  assert.ok(ctx.audits.some(entry => entry.route === '/remote/v1/screenshots/:id' && entry.status === 200))
})

test('a saved chat is resumed by ID, idempotently, and only when idle', async t => {
  const ctx = await setup(t)
  const first = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'old chat' } })
  assert.equal(first.status, 202)
  await ctx.runner.started()
  ctx.runner.current.resolve('old answer')
  await sleep(20)
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/new', body: { clientCommandId: 'command-0001' } })).status, 200)
  assert.equal((await ctx.call({ path: '/remote/v1/state' })).body.messages.length, 0)

  const phone = openEvents(ctx.port, { token: TOKEN })
  await phone.opened
  const resumed = await ctx.call({ method: 'POST', path: '/remote/v1/sessions/session-1/resume', body: { clientCommandId: 'command-0002' } })
  assert.equal(resumed.status, 200)
  assert.equal(resumed.body.sessionId, 'session-1')
  const replay = await ctx.call({ method: 'POST', path: '/remote/v1/sessions/session-1/resume', body: { clientCommandId: 'command-0002' } })
  assert.equal(replay.body.replayed, true)
  const event = await phone.next(frame => frame.type === 'chat.session' && frame.body.resumed === true)
  assert.equal(event.body.restoredMessages, 2)
  phone.close()
  const state = (await ctx.call({ path: '/remote/v1/state' })).body
  assert.equal(state.sessionId, 'session-1')
  assert.deepEqual(state.messages.map(message => message.type), ['chat.user', 'chat.done'])
  assert.equal(ctx.runner.sessionId, 'session-1')

  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/sessions/session-404/resume', body: { clientCommandId: 'command-0003' } })).body.error.code, 'SESSION_NOT_FOUND')
  assert.equal((await ctx.call({ path: '/remote/v1/sessions/session-1/resume' })).status, 405)
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/sessions/session-1/resume', body: {} })).status, 422)

  ctx.runner.unresumable = new Set(['session-2'])
  const gone = await ctx.call({ method: 'POST', path: '/remote/v1/sessions/session-2/resume', body: { clientCommandId: 'command-0004' } })
  // session-2 never committed a message, so it is not in the saved history at all.
  assert.equal(gone.status, 404)

  const busy = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0005', text: 'continue it' } })
  assert.equal(busy.status, 202)
  await ctx.runner.started()
  const refused = await ctx.call({ method: 'POST', path: '/remote/v1/sessions/session-1/resume', body: { clientCommandId: 'command-0006' } })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'TURN_BUSY')
  ctx.runner.current.resolve()
  await sleep(20)
  assert.ok(ctx.audits.some(entry => entry.route === '/remote/v1/sessions/:id/resume'))
})

test('a steering message stops the running turn and becomes the next one exactly once', async t => {
  const ctx = await setup(t)
  const phone = openEvents(ctx.port, { token: TOKEN })
  await phone.opened
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'long task' } })).status, 202)
  await ctx.runner.started()
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0002', text: 'plain' } })).body.error.code, 'TURN_BUSY')
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0003', text: 'x', steer: 'yes' } })).body.error.code, 'INVALID_STEER')

  const body = { clientMessageId: 'client-0004', text: 'go left instead', steer: true }
  const steer = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body })
  assert.equal(steer.status, 202)
  assert.equal(steer.body.steered, true)
  const again = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body })
  assert.equal(again.body.replayed, true)
  assert.equal(again.body.turnId, steer.body.turnId)
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { ...body, steer: false } })).body.error.code, 'IDEMPOTENCY_CONFLICT')

  const user = await phone.next(frame => frame.type === 'chat.user' && frame.body.clientMessageId === 'client-0004')
  assert.equal(user.turnId, steer.body.turnId)
  await ctx.runner.started()
  ctx.runner.current.resolve('went left')
  await phone.next(frame => frame.type === 'chat.turn' && frame.turnId === steer.body.turnId)
  phone.close()
  const state = (await ctx.call({ path: '/remote/v1/state' })).body
  assert.deepEqual(state.messages.map(message => message.type), ['chat.user', 'chat.stopped', 'chat.user', 'chat.done'])
  assert.equal(ctx.runner.runs.length, 2)
  assert.equal(ctx.runner.interrupts, 1)
})

/** Bridge stand-in whose panel answers a snapshot with an image, as the real observer would report it. */
function snapshotBridge(getHub, options = {}) {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000002800000019008020000000000000000', 'hex')
  const bridge = fakeBridge()
  bridge.connected = options.connected ?? true
  bridge.hasUi = () => bridge.connected
  bridge.gate = undefined
  bridge.requestUi = async (command, callId, timeoutMs, extra = {}) => {
    bridge.requests.push({ ...command, callId, timeoutMs, source: extra.source, wait: extra.wait })
    if (bridge.gate !== undefined) await bridge.gate
    if (command.op === 'labels.clear') return { op: 'labels.clear' }
    if (command.op !== 'snapshot') return { view: 'compact', screenshotSkipped: true }
    if (options.fail) throw new Error('side panel did not answer snapshot within 15000ms')
    if (options.noImage) return { op: 'snapshot', dialog: { type: 'alert' } }
    const image = { data: png.toString('base64'), mimeType: options.mimeType ?? 'image/png' }
    getHub().addScreenshot({ ...image, source: extra.source ?? 'auto' })
    return { op: 'snapshot', image }
  }
  return bridge
}

test('POST /snapshots captures one fresh view while idle and is idempotent', async t => {
  let hub
  const bridge = snapshotBridge(() => hub)
  const ctx = await setup(t, { bridge })
  hub = ctx.hub
  const events = await openEvents(ctx.port, { token: TOKEN })
  t.after(() => events.close())
  await events.next(frame => frame.type === 'remote.resync')

  const res = await ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0001' } })
  assert.equal(res.status, 201)
  assert.equal(res.body.screenshot.source, 'manual')
  assert.equal(res.body.screenshot.width, 640)
  assert.equal(res.body.screenshot.height, 400)
  assert.equal(res.body.screenshotId, res.body.latestScreenshotId)
  assert.deepEqual(bridge.requests, [
    { op: 'snapshot', args: { detail: 'normal' }, callId: 'auto', timeoutMs: 15_000, source: 'manual', wait: false },
    // The capture's numbered labels are removed from the page again.
    { op: 'labels.clear', args: {}, callId: 'auto', timeoutMs: 3_000, source: undefined, wait: false },
  ])
  const event = await events.next(frame => frame.type === 'remote.screenshot')
  assert.equal(event.body.screenshotId, res.body.screenshotId)
  assert.equal(event.body.source, 'manual')
  const bytes = await ctx.call({ path: `/remote/v1/screenshots/${res.body.screenshotId}`, raw: true })
  assert.equal(bytes.status, 200)
  assert.equal(bytes.headers['content-type'], 'image/png')

  const again = await ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0001' } })
  assert.equal(again.status, 201)
  assert.equal(again.body.replayed, true)
  assert.equal(again.body.screenshotId, res.body.screenshotId)
  assert.equal(bridge.requests.filter(r => r.op === 'snapshot').length, 1, 'a retried ID must not capture twice')
  assert.equal((await ctx.call({ path: '/remote/v1/state' })).body.turn.status, 'idle')
})

test('POST /snapshots during a turn adds no browser command and names the latest image', async t => {
  let hub
  const bridge = snapshotBridge(() => hub)
  const ctx = await setup(t, { bridge })
  hub = ctx.hub
  const first = await ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0001' } })
  assert.equal(first.status, 201)
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'work' } })
  await ctx.runner.started()
  const before = bridge.requests.length
  const busy = await ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0002' } })
  assert.equal(busy.status, 409)
  assert.equal(busy.body.error.code, 'TURN_BUSY')
  assert.equal(busy.body.latestScreenshotId, first.body.screenshotId)
  assert.equal(bridge.requests.length, before, 'no capture may be injected into a running turn')
  ctx.runner.current.resolve('ok')
})

test('POST /snapshots reports a disconnected panel, a failed capture, and an image-less page', async t => {
  let hub
  const offline = snapshotBridge(() => hub, { connected: false })
  const ctx = await setup(t, { bridge: offline })
  hub = ctx.hub
  const down = await ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0001' } })
  assert.equal(down.status, 503)
  assert.equal(down.body.error.code, 'UI_DISCONNECTED')
  assert.equal(offline.requests.length, 0)

  for (const [options, id] of [[{ fail: true }, 'snap-0002'], [{ noImage: true }, 'snap-0003'], [{ mimeType: 'image/gif' }, 'snap-0004']]) {
    let hub2
    const ctx2 = await setup(t, { bridge: snapshotBridge(() => hub2, options) })
    hub2 = ctx2.hub
    const res = await ctx2.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: id } })
    assert.equal(res.status, 502, JSON.stringify(options))
    assert.equal(res.body.error.code, 'SNAPSHOT_FAILED')
    assert.equal(res.body.latestScreenshotId, null)
    assert.equal(ctx2.controller.snapshotInFlight, undefined)
  }
})

test('one capture at a time, and a turn that starts meanwhile waits for it', async t => {
  let hub
  const bridge = snapshotBridge(() => hub)
  const ctx = await setup(t, { bridge, autoCapture: true })
  hub = ctx.hub
  let release = () => {}
  bridge.gate = new Promise(resolve => { release = resolve })
  const first = ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0001' } })
  await sleep(30)
  const second = await ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0002' } })
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'SNAPSHOT_BUSY')
  const sent = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'go' } })
  assert.equal(sent.status, 202)
  await sleep(30)
  assert.deepEqual(bridge.requests.map(r => r.op), ['snapshot'], 'the turn has not touched the browser yet')
  bridge.gate = undefined
  release()
  assert.equal((await first).status, 201)
  await ctx.runner.started()
  assert.deepEqual(bridge.requests.map(r => r.op), ['snapshot', 'labels.clear', 'auto_view'])
  ctx.runner.current.resolve('ok')
})

test('snapshot requests are rate limited', async t => {
  let hub
  const ctx = await setup(t, { bridge: snapshotBridge(() => hub), limits: { snapshotsPerMinute: 1 } })
  hub = ctx.hub
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0001' } })).status, 201)
  const limited = await ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0002' } })
  assert.equal(limited.status, 429)
})

/** The provider's `help-request` activity for the running turn, as the bridge forwards it. */
function helpSignal(ctx, request, turnId = ctx.controller.turnId) {
  ctx.controller.noteActivity({ v: 1, type: 'chat.activity', kind: 'help-request', turnId, ...(request !== null && typeof request === 'object' ? request : { reason: request }) })
}

test('a help request ends the turn in waiting_for_user with one capture, and the reply continues the same session', async t => {
  let hub
  const bridge = snapshotBridge(() => hub)
  const ctx = await setup(t, { bridge })
  hub = ctx.hub
  const events = openEvents(ctx.port, { token: TOKEN })
  t.after(() => events.close())
  await events.next(frame => frame.type === 'remote.resync')

  const sent = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'check my inbox' } })
  await ctx.runner.started()
  const sessionId = ctx.runner.sessionId
  helpSignal(ctx, { category: 'login', reason: '  Sign in to the mail site, then tell me to continue.  ' })
  assert.equal(bridge.requests.length, 0, 'nothing is captured while the model run is still in flight')
  ctx.runner.current.resolve('I need you to sign in.')

  const help = await events.next(frame => frame.type === 'remote.help')
  const turn = await events.next(frame => frame.type === 'chat.turn')
  assert.ok(help.seq < turn.seq, 'help is committed before the waiting state is announced')
  assert.equal(help.turnId, sent.body.turnId)
  assert.equal(help.body.category, 'login')
  assert.equal(help.body.reason, 'Sign in to the mail site, then tell me to continue.')
  assert.equal(help.body.captureError, null)
  assert.equal(turn.body.status, 'waiting_for_user')
  assert.deepEqual(bridge.requests.map(r => [r.op, r.source]), [['snapshot', 'help'], ['labels.clear', undefined]], 'exactly one help capture, after the run')

  const shot = events.frames.find(frame => frame.type === 'remote.screenshot')
  assert.equal(shot.body.source, 'help')
  assert.equal(help.body.screenshotId, shot.body.screenshotId)
  const done = events.frames.find(frame => frame.type === 'chat.done')
  assert.deepEqual(done.body.help, { category: 'login', reason: 'Sign in to the mail site, then tell me to continue.' })

  const state = (await ctx.call({ path: '/remote/v1/state' })).body
  assert.equal(state.turn.status, 'waiting_for_user')
  assert.equal(state.help.screenshotId, shot.body.screenshotId)
  assert.equal(state.help.turnId, sent.body.turnId)
  // Health changes must not knock the chat out of the waiting state.
  ctx.health.uiConnected = true
  ctx.hub.updateHealth()
  assert.equal(ctx.hub.turn.status, 'waiting_for_user')

  // An idle Stop changes nothing; a fresh capture is still allowed while waiting.
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/stop', body: { clientCommandId: 'stop-0001' } })).body.state, 'idle')
  assert.equal(ctx.hub.turn.status, 'waiting_for_user')
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/snapshots', body: { clientCommandId: 'snap-0001' } })).status, 201)
  assert.equal(ctx.hub.help.screenshotId, shot.body.screenshotId, 'a later manual capture does not replace the help evidence')

  // The reply is an ordinary idempotent message in the same session.
  const reply = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0002', text: 'signed in, continue' } })
  assert.equal(reply.status, 202)
  await ctx.runner.started()
  assert.equal(ctx.runner.sessionId, sessionId)
  assert.equal(ctx.runner.sessions, 1)
  const running = (await ctx.call({ path: '/remote/v1/state' })).body
  assert.equal(running.turn.status, 'running')
  assert.equal(running.help, null)
  const again = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0002', text: 'signed in, continue' } })
  assert.equal(again.body.replayed, true)
  assert.equal(ctx.runner.runs.length, 2)
  ctx.runner.current.resolve('done')
  await events.next(frame => frame.type === 'chat.turn' && frame.seq > turn.seq)
  assert.equal(ctx.hub.turn.status, 'idle', 'a normal completion returns to idle')
})

test('a help request without a usable capture still waits and reports the missing evidence', async t => {
  for (const options of [{ connected: false }, { fail: true }, { noImage: true }]) {
    let hub
    const bridge = snapshotBridge(() => hub, options)
    const ctx = await setup(t, { bridge })
    hub = ctx.hub
    await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'go' } })
    await ctx.runner.started()
    helpSignal(ctx, { category: 'captcha', reason: 'Solve the CAPTCHA.' })
    ctx.runner.current.resolve('blocked')
    await sleep(30)
    const state = (await ctx.call({ path: '/remote/v1/state' })).body
    assert.equal(state.turn.status, 'waiting_for_user', JSON.stringify(options))
    assert.equal(state.turn.outcome, 'done')
    assert.equal(state.help.screenshotId, null)
    assert.equal(typeof state.help.captureError, 'string')
    assert.ok(state.help.captureError.length > 0)
  }
})

test('malformed, duplicate, and absent help signals', async t => {
  const ctx = await setup(t)
  // Malformed requests are ignored: the turn ends idle.
  for (const bad of [{ category: 'bribe', reason: 'x' }, { category: 'login', reason: '   ' }, { category: 'login' }, 'help me', null]) {
    await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: `client-bad-${ctx.runner.runs.length}`, text: 'go' } })
    await ctx.runner.started()
    helpSignal(ctx, bad)
    ctx.runner.current.resolve('ok')
    await sleep(15)
    assert.equal(ctx.hub.turn.status, 'idle', JSON.stringify(bad))
    assert.equal(ctx.hub.help, null)
  }
  // Two signals in one run: the last one wins, and there is one help event.
  const events = openEvents(ctx.port, { token: TOKEN })
  t.after(() => events.close())
  await events.next(frame => frame.type === 'remote.resync')
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-dupe', text: 'go' } })
  await ctx.runner.started()
  helpSignal(ctx, { category: 'login', reason: 'first' })
  helpSignal(ctx, { category: 'permission', reason: 'second' })
  ctx.runner.current.resolve('ok')
  await events.next(frame => frame.type === 'chat.turn')
  assert.equal(events.frames.filter(frame => frame.type === 'remote.help').length, 1)
  assert.equal(ctx.hub.help.reason, 'second')
  // A signal for another turn, or one that arrives when nothing runs, is ignored.
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-other', text: 'go on' } })
  await ctx.runner.started()
  helpSignal(ctx, { category: 'login', reason: 'late signal from the previous turn' }, 'turn-something-else')
  ctx.runner.current.resolve('ok')
  await sleep(15)
  assert.equal(ctx.hub.turn.status, 'idle')
  helpSignal(ctx, { category: 'login', reason: 'nothing is running' }, undefined)
  assert.equal(ctx.controller.helpTurnRequest, undefined)
  // A help request from an earlier turn never leaks into the next one.
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-next', text: 'go on' } })
  await ctx.runner.started()
  ctx.runner.current.resolve('ok')
  await sleep(15)
  assert.equal(ctx.hub.turn.status, 'idle')
})

test('stop during the help capture ends as stopped; an error or stopped turn never waits', async t => {
  let hub
  const bridge = snapshotBridge(() => hub)
  const ctx = await setup(t, { bridge })
  hub = ctx.hub
  let release = () => {}
  bridge.gate = new Promise(resolve => { release = resolve })
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'go' } })
  await ctx.runner.started()
  helpSignal(ctx, { category: 'error', reason: 'The site is down.' })
  ctx.runner.current.resolve('blocked')
  await sleep(20)
  assert.equal(ctx.hub.turn.status, 'running', 'still running while the help capture is in flight')
  const stop = await ctx.call({ method: 'POST', path: '/remote/v1/stop', body: { clientCommandId: 'stop-0001' } })
  assert.equal(stop.body.state, 'stopping')
  bridge.gate = undefined
  release()
  await sleep(30)
  assert.equal(ctx.hub.turn.status, 'idle')
  assert.equal(ctx.hub.turn.outcome, 'stopped')
  assert.equal(ctx.hub.help, null)

  // A run that fails after asking for help is an error, not a waiting state.
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0002', text: 'go' } })
  await ctx.runner.started()
  helpSignal(ctx, { category: 'error', reason: 'The site is down.' })
  ctx.runner.current.reject(new Error('provider exploded'))
  await sleep(20)
  assert.equal(ctx.hub.turn.status, 'error')
  assert.equal(ctx.hub.help, null)
})

test('new chat while waiting starts a fresh session and clears the help request; new while running is refused', async t => {
  let hub
  const bridge = snapshotBridge(() => hub)
  const ctx = await setup(t, { bridge })
  hub = ctx.hub
  await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'go' } })
  await ctx.runner.started()
  assert.equal((await ctx.call({ method: 'POST', path: '/remote/v1/new', body: { clientCommandId: 'new-00001' } })).status, 409)
  helpSignal(ctx, { category: 'ambiguous', reason: 'Which account?' })
  ctx.runner.current.resolve('which one?')
  await sleep(30)
  assert.equal(ctx.hub.turn.status, 'waiting_for_user')
  const fresh = await ctx.call({ method: 'POST', path: '/remote/v1/new', body: { clientCommandId: 'new-00002' } })
  assert.equal(fresh.status, 200)
  const state = (await ctx.call({ path: '/remote/v1/state' })).body
  assert.equal(state.sessionId, fresh.body.sessionId)
  assert.equal(state.help, null)
  assert.equal(state.turn.status, 'idle')
  assert.equal(state.latestScreenshotId, null)
})

test('push devices register, replace, and unregister over the authenticated API', async t => {
  const sends = []
  const push = new PushService({ registry: new PushRegistry(), provider: { name: 'fake', send: async (token, data, options) => { sends.push({ token, data, options }); return { ok: true } } } })
  const ctx = await setup(t, { push, limits: { pushRegistrationsPerMinute: 4 } })
  const fcmToken = `fcm-token-A:${'a'.repeat(120)}`
  const path = '/remote/v1/push/devices/phone-1'

  assert.equal((await http(ctx.port, { method: 'PUT', path, body: { fcmToken, platform: 'android' } })).status, 401)
  const bad = await ctx.call({ method: 'PUT', path, body: { fcmToken: 'short', platform: 'android' } })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.error.code, 'INVALID_PUSH_TOKEN')
  const first = await ctx.call({ method: 'PUT', path, body: { fcmToken, platform: 'android', appVersion: '0.4.0' } })
  assert.equal(first.status, 200)
  assert.deepEqual([first.body.registered, first.body.created], [true, true])
  const replaced = await ctx.call({ method: 'PUT', path, body: { fcmToken: `fcm-token-B:${'b'.repeat(120)}`, platform: 'android' } })
  assert.equal(replaced.body.created, false)
  assert.equal(push.registry.size, 1)
  assert.equal((await ctx.call({ method: 'PUT', path, body: { fcmToken, platform: 'android' } })).status, 200)
  assert.equal((await ctx.call({ method: 'PUT', path, body: { fcmToken, platform: 'android' } })).status, 429)
  // The audit trail never holds a registration token.
  assert.ok(!JSON.stringify(ctx.audits).includes('fcm-token'))

  // A finished turn is announced after its state is committed, metadata only.
  ctx.controller.addObserver({
    turnEnded: info => {
      const type = pushTypeForTurn(info)
      if (type !== null) void push.notify({ type, turnId: info.turnId, instanceId: ctx.hub.instanceId, sequence: ctx.hub.seq })
    },
  })
  const sent = await ctx.call({ method: 'POST', path: '/remote/v1/messages', body: { clientMessageId: 'client-0001', text: 'my secret prompt' } })
  await ctx.runner.started()
  helpSignal(ctx, { category: 'login', reason: 'Sign in with the password hunter2.' })
  ctx.runner.current.resolve('private answer')
  await sleep(40)
  assert.equal(sends.length, 1)
  assert.deepEqual(Object.keys(sends[0].data).sort(), ['instanceId', 'sequence', 'turnId', 'type'])
  assert.equal(sends[0].data.type, 'help')
  assert.equal(sends[0].data.turnId, sent.body.turnId)
  assert.equal(sends[0].options.priority, 'high')
  const wire = JSON.stringify(sends)
  for (const secret of ['secret prompt', 'hunter2', 'private answer', TOKEN]) assert.ok(!wire.includes(secret), secret)
  // What the push points at is already retrievable.
  const state = (await ctx.call({ path: '/remote/v1/state' })).body
  assert.equal(state.help.turnId, sends[0].data.turnId)
  assert.ok(Number(sends[0].data.sequence) <= state.latestSequence)

  const removed = await ctx.call({ method: 'DELETE', path })
  assert.deepEqual([removed.status, removed.body.registered, removed.body.removed], [200, false, true])
  assert.equal((await ctx.call({ method: 'DELETE', path })).body.removed, false)
  assert.equal(push.registry.size, 0)
})

test('without a push provider registration is refused but unregistering still answers', async t => {
  const ctx = await setup(t, { push: new PushService({ registry: new PushRegistry() }) })
  const put = await ctx.call({ method: 'PUT', path: '/remote/v1/push/devices/phone-1', body: { fcmToken: `fcm-token-A:${'a'.repeat(120)}`, platform: 'android' } })
  assert.equal(put.status, 503)
  assert.equal(put.body.error.code, 'PUSH_NOT_CONFIGURED')
  assert.equal((await ctx.call({ method: 'DELETE', path: '/remote/v1/push/devices/phone-1' })).status, 200)
})
