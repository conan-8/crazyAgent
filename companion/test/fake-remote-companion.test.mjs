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

test('a scripted confirmation waits for the answer, and approve/deny each produce their own answer turn', async () => {
  await withFake(async fake => {
    const port = fake.server.port
    const events = openEvents(port, { token: fake.token })
    await events.opened
    for (const decision of ['approve', 'deny']) {
      const seen = events.frames.length
      await http(port, { method: 'POST', path: '/remote/v1/messages', token: fake.token, body: { clientMessageId: `client-confirm-ask-${decision}`, text: 'please confirm the order' } })
      const waiting = await events.next(frame => frame.type === 'chat.turn' && frame.body.status === 'waiting_for_user' && events.frames.indexOf(frame) >= seen, 5_000)
      const confirm = events.frames.slice(seen).find(frame => frame.type === 'remote.confirm')
      assert.equal(confirm.body.turnId, waiting.body.turnId)
      assert.equal(confirm.body.action, 'Place the fake order for 3 items')
      assert.ok(confirm.body.screenshotId)
      const answered = await http(port, { method: 'POST', path: '/remote/v1/messages', token: fake.token, body: { clientMessageId: `client-confirm-answer-${decision}`, text: '', confirm: decision } })
      assert.equal(answered.status, 202)
      const done = await events.next(frame => frame.type === 'chat.turn' && frame.body.turnId === answered.body.turnId && frame.body.status !== 'running', 5_000)
      assert.notEqual(done.body.status, 'waiting_for_user')
      const reply = events.frames.filter(frame => frame.type === 'chat.message' || frame.type === 'chat.assistant').map(frame => JSON.stringify(frame.body)).join('\n')
      assert.match(reply, decision === 'approve' ? /approval received/u : /denied; nothing was placed/u)
    }
    const stray = await http(port, { method: 'POST', path: '/remote/v1/messages', token: fake.token, body: { clientMessageId: 'client-confirm-stray', text: '', confirm: 'approve' } })
    assert.equal(stray.status, 409)
    assert.equal(stray.body.code ?? stray.body.error?.code, 'NO_CONFIRMATION_PENDING')
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
