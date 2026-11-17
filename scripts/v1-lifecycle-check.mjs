#!/usr/bin/env node
/**
 * V1 alert-lifecycle integration check (MARATHON-V2-PLAN.md §3.2 / §5 V1).
 * No model: the real fake companion (real SessionController + RemoteHub +
 * RemoteServer + deterministic watcher on a 60x clock) is driven through the
 * remote API, and GET /state is checked after EACH turn boundary. Proves:
 *   - a mid-turn alert open at turn end is closed ('Turn ended.'), /state clear;
 *   - ended-incomplete supersedes and is the one open notice;
 *   - "It's fine" on ended-incomplete returns 200 and clears /state;
 *   - the next turn start closes an open ended-incomplete ('A new turn started.')
 *     before its first frame, /state clear;
 *   - marathon off clears everything.
 * Stale alerts must be 0 on /state after every boundary.
 *
 *   node scripts/v1-lifecycle-check.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeCompanion } from './fake-remote-companion.mjs'
import { http, sleep } from '../companion/test/remote-fixtures.mjs'

const tokenFile = join(mkdtempSync(join(tmpdir(), 'v1-lifecycle-')), 'remote-token')
const fake = await startFakeCompanion({ port: 0, tokenFile, watchSpeed: 60, hangMs: 6_500, stepMs: 300, log: () => {} })
const port = fake.server.port
const token = fake.token
const call = (method, path, body) => http(port, { method, path: `/remote/v1${path}`, token, body })
const state = async () => (await call('GET', '/state')).body
const watchOpen = async () => (await state()).marathon.watch.open
const turnStatus = async () => (await state()).turn.status
async function waitFor(fn, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await sleep(100)
  }
}
const closedFrames = () => fake.hub.journal.filter(e => e.type === 'remote.watch' && e.body.state === 'closed').map(e => e.body)
const results = []
const ok = (name, detail) => { results.push({ name, ...detail }); console.log(`PASS ${name}`, JSON.stringify(detail)) }

try {
  await call('POST', '/marathon', { clientCommandId: 'v1-on-0001', enabled: true })

  // Path A: a mid-turn alert open at turn end is closed ('Turn ended.').
  await call('POST', '/messages', { clientMessageId: 'v1-a-0001', text: 'marathon-stuck' })
  await waitFor(async () => (await watchOpen())?.kind === 'TOOL_HANG', 'mid-turn TOOL_HANG alert')
  const alertId = (await watchOpen()).id
  await call('POST', '/stop', { clientCommandId: 'v1-stop-0001' })
  await waitFor(async () => (await turnStatus()) === 'idle', 'turn stopped')
  assert.equal(await watchOpen(), null, 'no stale alert after stop')
  assert.ok(closedFrames().some(f => f.id === alertId && f.reason === 'Turn ended.'), 'mid-turn alert closed with own id')
  ok('mid-turn alert closed at turn end', { alertId, watchOpen: null })

  // Path B: ended-incomplete supersedes; ack 200; next turn closes it.
  await call('POST', '/messages', { clientMessageId: 'v1-b1-0001', text: 'marathon-stuck' })
  await waitFor(async () => (await turnStatus()) === 'idle' && (await watchOpen())?.kind === 'ended-incomplete', 'ended-incomplete open')
  const endedId = (await watchOpen()).id
  ok('ended-incomplete is the one open notice', { endedId })
  const ack = await call('POST', '/marathon/watch/ack', { clientCommandId: 'v1-ack-0001', id: endedId })
  assert.equal(ack.status, 200)
  assert.equal(ack.body.acknowledged, true)
  assert.equal(await watchOpen(), null, 'ack cleared /state')
  ok('It\'s fine on ended-incomplete returns 200', { status: ack.status, watchOpen: null })

  // Another ended-incomplete, then a healthy next turn closes it before its first frame.
  await call('POST', '/messages', { clientMessageId: 'v1-b2-0001', text: 'marathon-stuck' })
  await waitFor(async () => (await turnStatus()) === 'idle' && (await watchOpen())?.kind === 'ended-incomplete', 'second ended-incomplete')
  const endedId2 = (await watchOpen()).id
  const before = fake.hub.journal.length
  await call('POST', '/messages', { clientMessageId: 'v1-b3-0001', text: 'hello' })
  await waitFor(async () => (await turnStatus()) === 'idle', 'healthy turn done')
  assert.equal(await watchOpen(), null, 'no stale ended-incomplete into the new turn')
  const newClosed = fake.hub.journal.slice(before).filter(e => e.type === 'remote.watch' && e.body.state === 'closed').map(e => e.body)
  assert.ok(newClosed.some(f => f.id === endedId2 && f.reason === 'A new turn started.'), 'ended-incomplete closed at next turn start')
  ok('next turn closes ended-incomplete before first frame', { endedId2, watchOpen: null })

  // Marathon off clears everything.
  await call('POST', '/messages', { clientMessageId: 'v1-c-0001', text: 'marathon-stuck' })
  await waitFor(async () => (await turnStatus()) === 'idle' && (await watchOpen())?.kind === 'ended-incomplete', 'third ended-incomplete')
  await call('POST', '/marathon', { clientCommandId: 'v1-off-0001', enabled: false })
  assert.equal(await watchOpen(), null, 'marathon off clears the notice')
  ok('marathon off clears everything', { watchOpen: null })

  console.log(`\nV1 lifecycle check PASS — stale alerts 0 on /state after every boundary (${results.length} checks)`)
} finally {
  await fake.stop()
}