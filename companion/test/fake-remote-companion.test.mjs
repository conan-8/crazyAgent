import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeCompanion } from '../../scripts/fake-remote-companion.mjs'
import { http, openEvents } from './remote-fixtures.mjs'

async function withFake(run) {
  const dir = mkdtempSync(join(tmpdir(), 'crazyagent-fake-remote-'))
  const fake = await startFakeCompanion({ port: 0, tokenFile: join(dir, 'remote-token'), stepMs: 15 })
  try {
    await run(fake)
  } finally {
    await fake.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the fake companion streams a scripted turn through the real remote API', async () => {
  await withFake(async fake => {
    const port = fake.server.port
    const state = await http(port, { path: '/remote/v1/state', token: fake.token })
    assert.equal(state.status, 200)
    assert.equal(state.body.health.dsh, 'ready')
    assert.equal(state.body.health.model, 'fake/scripted')

    const events = openEvents(port, { token: fake.token })
    await events.opened
    const accepted = await http(port, { method: 'POST', path: '/remote/v1/messages', token: fake.token, body: { clientMessageId: 'client-fake-1', text: 'hello fake' } })
    assert.equal(accepted.status, 202)
    const turn = await events.next(frame => frame.type === 'chat.turn', 5_000)
    assert.equal(turn.body.outcome, 'done')
    const types = new Set(events.frames.map(frame => frame.type))
    for (const type of ['chat.user', 'chat.draft', 'chat.assistant', 'chat.tool_call', 'chat.tool_result', 'chat.done']) assert.ok(types.has(type), type)
    const user = events.frames.find(frame => frame.type === 'chat.user')
    assert.equal(user.body.text, 'hello fake')
    assert.match(events.frames.find(frame => frame.type === 'chat.assistant').body.text, /You said: "hello fake"/u)
    await events.close()
  })
})

test('stop interrupts a slow scripted turn with the real lifecycle', async () => {
  await withFake(async fake => {
    const port = fake.server.port
    const events = openEvents(port, { token: fake.token })
    await events.opened
    await http(port, { method: 'POST', path: '/remote/v1/messages', token: fake.token, body: { clientMessageId: 'client-slow-1', text: 'slow please' } })
    await events.next(frame => frame.type === 'chat.draft')
    const stop = await http(port, { method: 'POST', path: '/remote/v1/stop', token: fake.token, body: { clientCommandId: 'stop-0001' } })
    assert.equal(stop.status, 202)
    const turn = await events.next(frame => frame.type === 'chat.turn', 5_000)
    assert.equal(turn.body.outcome, 'stopped')
    assert.ok(events.frames.some(frame => frame.type === 'chat.stopped'))
    await events.close()
  })
})

test('a scripted blocker ends in waiting_for_user with a help capture, and a capture can be requested', async () => {
  await withFake(async fake => {
    const port = fake.server.port
    const events = openEvents(port, { token: fake.token })
    await events.opened
    await http(port, { method: 'POST', path: '/remote/v1/messages', token: fake.token, body: { clientMessageId: 'client-help-1', text: 'you will hit a captcha' } })
    const turn = await events.next(frame => frame.type === 'chat.turn', 5_000)
    assert.equal(turn.body.status, 'waiting_for_user')
    const help = events.frames.find(frame => frame.type === 'remote.help')
    assert.equal(help.body.category, 'captcha')
    assert.ok(help.body.screenshotId)
    const shot = await http(port, { path: `/remote/v1/screenshots/${help.body.screenshotId}`, token: fake.token })
    assert.equal(shot.status, 200)
    const snap = await http(port, { method: 'POST', path: '/remote/v1/snapshots', token: fake.token, body: { clientCommandId: 'snap-fake-1' } })
    assert.equal(snap.status, 201)
    assert.equal(snap.body.screenshot.source, 'manual')
    await events.close()
  })
})
