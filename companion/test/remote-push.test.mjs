import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FcmHttpV1Provider,
  PushRegistry,
  PushService,
  classifyFcmFailure,
  createFcmProvider,
  parsePushRegistration,
  pushTypeForTurn,
} from '../remote-push.mjs'

const TOKEN_A = `fcm-token-A:${'a'.repeat(120)}`
const TOKEN_B = `fcm-token-B:${'b'.repeat(120)}`
const reg = fcmToken => ({ fcmToken, platform: 'android', appVersion: '0.4.0' })

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crazyagent-push-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Provider double: records sends and answers from a script per token. */
function fakeProvider(script = {}) {
  const sends = []
  return {
    name: 'fake',
    sends,
    async send(fcmToken, data, options) {
      sends.push({ fcmToken, data, options })
      const next = script[fcmToken]
      const result = Array.isArray(next) ? next.shift() : next
      if (result instanceof Error) throw result
      return result ?? { ok: true }
    },
  }
}

test('registration bodies are validated strictly', () => {
  assert.deepEqual(parsePushRegistration(reg(TOKEN_A)), { ok: true, registration: reg(TOKEN_A) })
  assert.equal(parsePushRegistration({ fcmToken: TOKEN_A, platform: 'android' }).registration.appVersion, null)
  for (const [body, code] of [
    [null, 'INVALID_PUSH_REGISTRATION'],
    [{ platform: 'android' }, 'INVALID_PUSH_TOKEN'],
    [{ fcmToken: 'short', platform: 'android' }, 'INVALID_PUSH_TOKEN'],
    [{ fcmToken: `${TOKEN_A} with spaces`, platform: 'android' }, 'INVALID_PUSH_TOKEN'],
    [{ fcmToken: 'x'.repeat(5_000), platform: 'android' }, 'INVALID_PUSH_TOKEN'],
    [{ fcmToken: TOKEN_A, platform: 'ios' }, 'INVALID_PUSH_PLATFORM'],
    [{ fcmToken: TOKEN_A, platform: 'android', appVersion: 'x'.repeat(41) }, 'INVALID_PUSH_REGISTRATION'],
    [{ fcmToken: TOKEN_A, platform: 'android', appVersion: 7 }, 'INVALID_PUSH_REGISTRATION'],
  ]) {
    const result = parsePushRegistration(body)
    assert.equal(result.ok, false)
    assert.equal(result.code, code, JSON.stringify(body)?.slice(0, 50))
  }
})

test('the registry replaces tokens, moves a token between device IDs, stays bounded, and persists 0600', t => {
  const file = join(tempDir(t), 'push-devices.json')
  const registry = new PushRegistry({ file, limit: 3 })
  assert.deepEqual(registry.put('phone-1', reg(TOKEN_A)), { created: true })
  assert.deepEqual(registry.put('phone-1', reg(TOKEN_B)), { created: false })
  assert.deepEqual(registry.list(), [{ deviceId: 'phone-1', fcmToken: TOKEN_B }])
  // The same token under a new ID (app data cleared) must not be notified twice.
  registry.put('phone-1b', reg(TOKEN_B))
  assert.deepEqual(registry.list(), [{ deviceId: 'phone-1b', fcmToken: TOKEN_B }])
  assert.equal(statSync(file).mode & 0o777, 0o600)

  for (const n of [2, 3, 4]) registry.put(`phone-${n}`, reg(`fcm-token-${n}:${'c'.repeat(120)}`))
  assert.equal(registry.size, 3)
  assert.equal(registry.has('phone-1b'), false, 'the oldest registration is evicted')

  const reloaded = new PushRegistry({ file, limit: 3 })
  assert.deepEqual(reloaded.list(), registry.list())
  assert.equal(reloaded.delete('phone-2'), true)
  assert.equal(reloaded.delete('phone-2'), false)
  assert.equal(new PushRegistry({ file }).has('phone-2'), false)

  // A damaged or hostile file is ignored rather than trusted.
  writeFileSync(file, '{"devices":{"../x":{"fcmToken":"y"},"ok-1":{"fcmToken":"bad","platform":"android"}}}')
  assert.equal(new PushRegistry({ file }).size, 0)
  writeFileSync(file, '{not json')
  assert.equal(new PushRegistry({ file }).size, 0)
})

test('a push carries exactly the metadata keys, as strings, with help at high priority', async () => {
  const provider = fakeProvider()
  const registry = new PushRegistry()
  registry.put('phone-1', reg(TOKEN_A))
  registry.put('phone-2', reg(TOKEN_B))
  const audits = []
  const service = new PushService({ registry, provider, audit: (event, data) => audits.push({ event, ...data }) })
  const result = await service.notify({ type: 'help', turnId: 'turn-9', instanceId: 'inst-1', sequence: 42 })
  assert.deepEqual(result, { sent: 2, failed: 0, pruned: 0 })
  assert.equal(provider.sends.length, 2)
  for (const send of provider.sends) {
    assert.deepEqual(send.data, { type: 'help', turnId: 'turn-9', instanceId: 'inst-1', sequence: '42' })
    assert.deepEqual(send.options, { priority: 'high' })
  }
  await service.notify({ type: 'done', turnId: 'turn-10', instanceId: 'inst-1', sequence: 50 })
  assert.deepEqual(provider.sends.at(-1).options, { priority: 'normal' })
  // The audit trail names devices and outcomes, never tokens.
  const trail = JSON.stringify(audits)
  assert.ok(!trail.includes(TOKEN_A) && !trail.includes(TOKEN_B))
  assert.equal(audits.filter(entry => entry.event === 'push.delivery').length, 4)
})

test('one turn is announced once per device, and nothing is sent without a provider, devices, or a valid event', async () => {
  const provider = fakeProvider()
  const registry = new PushRegistry()
  const service = new PushService({ registry, provider })
  assert.equal((await service.notify({ type: 'done', turnId: 'turn-0', instanceId: 'i', sequence: 1 })).skipped, 'no-devices')
  registry.put('phone-1', reg(TOKEN_A))
  assert.equal((await service.notify({ type: 'done', turnId: 'turn-1', instanceId: 'i', sequence: 2 })).sent, 1)
  assert.equal((await service.notify({ type: 'done', turnId: 'turn-1', instanceId: 'i', sequence: 3 })).skipped, 'duplicate-turn')
  assert.equal((await service.notify({ type: 'help', turnId: 'turn-1', instanceId: 'i', sequence: 3 })).skipped, 'duplicate-turn')
  assert.equal((await service.notify({ type: 'tool_call', turnId: 'turn-2', instanceId: 'i', sequence: 4 })).skipped, 'invalid-event')
  assert.equal((await service.notify({ type: 'done', turnId: '', instanceId: 'i', sequence: 4 })).skipped, 'invalid-event')
  assert.equal(provider.sends.length, 1)

  const off = new PushService({ registry })
  assert.equal(off.configured, false)
  assert.equal((await off.notify({ type: 'help', turnId: 'turn-3', instanceId: 'i', sequence: 5 })).skipped, 'not-configured')
})

test('retries are bounded and classified; a dead token is pruned without touching other devices', async () => {
  const sleeps = []
  const provider = fakeProvider({
    [TOKEN_A]: [{ ok: false, kind: 'retryable' }, new Error('socket hang up'), { ok: true }],
    [TOKEN_B]: [{ ok: false, kind: 'invalid-token' }],
  })
  const registry = new PushRegistry()
  registry.put('phone-1', reg(TOKEN_A))
  registry.put('phone-2', reg(TOKEN_B))
  const service = new PushService({ registry, provider, maxAttempts: 3, retryDelayMs: 100, sleep: async ms => { sleeps.push(ms) } })
  const result = await service.notify({ type: 'done', turnId: 'turn-1', instanceId: 'i', sequence: 1 })
  assert.deepEqual(result, { sent: 1, failed: 1, pruned: 1 })
  assert.deepEqual(sleeps, [100, 200], 'exponential, and only for the retried device')
  assert.equal(provider.sends.filter(send => send.fcmToken === TOKEN_A).length, 3)
  assert.equal(provider.sends.filter(send => send.fcmToken === TOKEN_B).length, 1, 'an invalid token is not retried')
  assert.deepEqual(registry.list(), [{ deviceId: 'phone-1', fcmToken: TOKEN_A }])

  // A persistent outage stops after maxAttempts; a fatal error is not retried and nothing is pruned.
  const down = fakeProvider({ [TOKEN_A]: { ok: false, kind: 'retryable' } })
  const outage = new PushService({ registry, provider: down, maxAttempts: 3, sleep: async () => {} })
  assert.deepEqual(await outage.notify({ type: 'done', turnId: 'turn-2', instanceId: 'i', sequence: 2 }), { sent: 0, failed: 1, pruned: 0 })
  assert.equal(down.sends.length, 3)
  const fatal = fakeProvider({ [TOKEN_A]: { ok: false, kind: 'fatal' } })
  await new PushService({ registry, provider: fatal, sleep: async () => {} }).notify({ type: 'done', turnId: 'turn-3', instanceId: 'i', sequence: 3 })
  assert.equal(fatal.sends.length, 1)
  assert.equal(registry.size, 1)
})

test('FCM failures are classified from status and error code', () => {
  assert.equal(classifyFcmFailure(404, 'UNREGISTERED'), 'invalid-token')
  assert.equal(classifyFcmFailure(404, ''), 'invalid-token')
  assert.equal(classifyFcmFailure(400, 'INVALID_ARGUMENT'), 'fatal', 'our own bad request must not delete a registration')
  assert.equal(classifyFcmFailure(403, 'SENDER_ID_MISMATCH'), 'fatal')
  assert.equal(classifyFcmFailure(401, 'UNAUTHENTICATED'), 'fatal')
  for (const [status, code] of [[429, 'QUOTA_EXCEEDED'], [500, 'INTERNAL'], [503, 'UNAVAILABLE']]) assert.equal(classifyFcmFailure(status, code), 'retryable')
})

test('the FCM HTTP v1 provider sends a data-only message with bearer auth and maps replies', async () => {
  const calls = []
  let reply = { ok: true, status: 200, json: async () => ({ name: 'projects/p/messages/1' }) }
  const provider = new FcmHttpV1Provider({
    projectId: 'crazyagent-test',
    getAccessToken: async () => 'ya29.access',
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (reply instanceof Error) throw reply
      return reply
    },
  })
  const data = { type: 'help', turnId: 'turn-1', instanceId: 'i', sequence: '7' }
  assert.deepEqual(await provider.send(TOKEN_A, data, { priority: 'high' }), { ok: true })
  assert.equal(calls[0].url, 'https://fcm.googleapis.com/v1/projects/crazyagent-test/messages:send')
  assert.equal(calls[0].init.headers.authorization, 'Bearer ya29.access')
  const sent = JSON.parse(calls[0].init.body)
  assert.deepEqual(sent, { message: { token: TOKEN_A, data, android: { priority: 'HIGH' } } })
  assert.equal(sent.message.notification, undefined, 'data-only: the app builds the notification')

  reply = { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }) }
  assert.equal((await provider.send(TOKEN_A, data, { priority: 'normal' })).kind, 'invalid-token')
  assert.equal(JSON.parse(calls[1].init.body).message.android.priority, 'NORMAL')
  reply = { ok: false, status: 503, json: async () => { throw new Error('not json') } }
  assert.equal((await provider.send(TOKEN_A, data, { priority: 'normal' })).kind, 'retryable')
  reply = new Error('network down')
  assert.equal((await provider.send(TOKEN_A, data, { priority: 'normal' })).kind, 'retryable')

  const noAuth = new FcmHttpV1Provider({ projectId: 'crazyagent-test', getAccessToken: async () => { throw new Error('invalid_grant') }, fetch: async () => { throw new Error('must not be called') } })
  assert.equal((await noAuth.send(TOKEN_A, data, { priority: 'high' })).kind, 'fatal')
  assert.throws(() => new FcmHttpV1Provider({ projectId: '../evil', getAccessToken: async () => 'x' }))
})

test('the provider factory is off without a key file and rejects a file that is not a service-account key', async t => {
  assert.equal(await createFcmProvider({}), undefined)
  assert.equal(await createFcmProvider({ credentialsFile: '  ' }), undefined)
  const dir = tempDir(t)
  const wrong = join(dir, 'wrong.json')
  writeFileSync(wrong, JSON.stringify({ type: 'authorized_user', client_id: 'x' }))
  await assert.rejects(createFcmProvider({ credentialsFile: wrong }), /service-account/u)
  await assert.rejects(createFcmProvider({ credentialsFile: join(dir, 'missing.json') }))
  assert.equal(readFileSync(wrong, 'utf8').includes('authorized_user'), true)
})

test('only finished and failed turns are announced', () => {
  assert.equal(pushTypeForTurn({ outcome: 'done' }), 'done')
  assert.equal(pushTypeForTurn({ outcome: 'done', help: { category: 'login', reason: 'x' } }), 'help')
  assert.equal(pushTypeForTurn({ outcome: 'error', error: 'x' }), 'error')
  assert.equal(pushTypeForTurn({ outcome: 'stopped' }), null)
  assert.equal(pushTypeForTurn({ outcome: 'stopped', help: { category: 'login', reason: 'x' } }), null)
})
