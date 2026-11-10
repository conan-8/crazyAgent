import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteHub, fingerprint } from '../remote-hub.mjs'

function hub(options = {}) {
  let health = { uiConnected: true, toolsConnected: true, dsh: 'ready', model: 'm' }
  const h = new RemoteHub({ instanceId: 'inst-a', getHealth: () => health, ...options })
  h.setHealthForTest = next => { health = next }
  return h
}

function startTurn(h, turnId = 'turn-1', text = 'hello') {
  h.turnStarted({ turnId, origin: 'remote', clientMessageId: 'client-0001', text, imageCount: 0, sessionId: 'session-1' })
}

test('envelopes carry instance, increasing sequence, session, and turn', () => {
  const h = hub()
  startTurn(h)
  h.ingest({ type: 'chat.assistant', text: 'answer' })
  const [user, assistant] = h.journal
  assert.equal(user.type, 'chat.user')
  assert.equal(user.instanceId, 'inst-a')
  assert.equal(user.seq, 1)
  assert.equal(user.turnId, 'turn-1')
  assert.equal(user.sessionId, 'session-1')
  assert.equal(user.body.origin, 'remote')
  assert.equal(assistant.seq, 2)
  assert.equal(assistant.type, 'chat.assistant')
  assert.equal(h.turn.status, 'running')
})

test('ignores non-allowlisted frames including browser commands and control replies', () => {
  const h = hub()
  for (const type of ['browser.command', 'browser.result', 'llm.configured', 'log.export.result', 'chat.hello', 'hello.ok']) {
    h.ingest({ type, command: { op: 'click' }, token: 'secret' })
  }
  assert.equal(h.seq, 0)
  assert.equal(h.journal.length, 0)
})

test('streamed drafts aggregate with offsets and are replaced by the committed message', () => {
  const h = hub()
  startTurn(h)
  h.ingest({ type: 'chat.activity', kind: 'model-start' })
  h.ingest({ type: 'chat.activity', kind: 'text', text: 'Hel' })
  h.ingest({ type: 'chat.activity', kind: 'text', text: 'lo' })
  h.ingest({ type: 'chat.activity', kind: 'reasoning', text: 'think' })
  h.ingest({ type: 'chat.activity', kind: 'usage', usage: {} })
  const drafts = h.journal.filter(e => e.type === 'chat.draft')
  assert.deepEqual(drafts.map(d => [d.body.channel, d.body.offset, d.body.delta]), [['text', 0, 'Hel'], ['text', 3, 'lo'], ['reasoning', 0, 'think']])
  const streamId = drafts[0].body.streamId
  assert.ok(drafts.every(d => d.body.streamId === streamId))
  assert.equal(h.projection().draft.text, 'Hello')
  assert.equal(h.projection().draft.reasoning, 'think')

  h.ingest({ type: 'chat.assistant', text: 'Hello' })
  const committed = h.journal.at(-1)
  assert.equal(committed.body.replacesStreamId, streamId)
  assert.equal(h.projection().draft, null)

  // The next step gets a distinct stream.
  h.ingest({ type: 'chat.activity', kind: 'text', text: 'x' })
  assert.notEqual(h.journal.at(-1).body.streamId, streamId)
})

test('tool-call deltas draft per call and the committed tool call replaces them', () => {
  const h = hub()
  startTurn(h)
  h.ingest({ type: 'chat.activity', kind: 'tool-call-delta', id: 'c1', name: 'browser_click', argumentsDelta: '{"a"' })
  h.ingest({ type: 'chat.activity', kind: 'tool-call-delta', id: 'c1', argumentsDelta: ':1}' })
  assert.deepEqual(h.projection().draft.tools, [{ id: 'c1', name: 'browser_click', args: '{"a":1}' }])
  h.ingest({ type: 'chat.tool_call', callId: 'c1', name: 'browser_click', args: '{"a":1}' })
  assert.equal(h.projection().draft, null)
  assert.ok(h.journal.at(-1).body.replacesStreamId)
})

test('activity outside a turn is ignored', () => {
  const h = hub()
  h.ingest({ type: 'chat.activity', kind: 'text', text: 'stray' })
  assert.equal(h.journal.length, 0)
})

test('turn lifecycle: running → stopping → idle, and error persists until the next turn', () => {
  const h = hub()
  h.updateHealth()
  assert.equal(h.turn.status, 'idle')
  startTurn(h)
  h.ingest({ type: 'chat.stopping', message: 'Stopping…' })
  assert.equal(h.turn.status, 'stopping')
  h.ingest({ type: 'chat.stopped', reason: 'user', message: 'Stopped by user.' })
  h.turnEnded({ turnId: 'turn-1', outcome: 'stopped' })
  assert.equal(h.turn.status, 'idle')
  assert.equal(h.turn.outcome, 'stopped')

  startTurn(h, 'turn-2')
  h.ingest({ type: 'chat.error', message: 'boom', recoverable: true })
  h.turnEnded({ turnId: 'turn-2', outcome: 'error', error: 'boom' })
  assert.equal(h.turn.status, 'error')
  h.ingest({ type: 'chat.status', status: 'idle' })
  h.updateHealth()
  assert.equal(h.turn.status, 'error')

  startTurn(h, 'turn-3')
  assert.equal(h.turn.status, 'running')
  // A late end for an older turn never overwrites the current projection.
  h.turnEnded({ turnId: 'turn-2', outcome: 'done' })
  assert.equal(h.turn.status, 'running')
  assert.equal(h.turn.turnId, 'turn-3')
})

test('idle-time status follows runtime health, not panel status frames', () => {
  const h = hub()
  h.setHealthForTest({ uiConnected: false, toolsConnected: false, dsh: 'starting' })
  h.updateHealth()
  assert.equal(h.turn.status, 'starting')
  h.ingest({ type: 'chat.status', status: 'ready' })
  assert.equal(h.turn.status, 'starting')
  h.setHealthForTest({ uiConnected: false, toolsConnected: true, dsh: 'ready' })
  assert.equal(h.updateHealth(), true)
  assert.equal(h.turn.status, 'idle')
  assert.equal(h.updateHealth(), false, 'unchanged health publishes nothing')
  const health = h.journal.filter(e => e.type === 'remote.health').at(-1)
  assert.equal(health.body.uiConnected, false)
  assert.equal(h.projection().health.uiConnected, false)
})

test('an idle stop reply is not journaled as a lifecycle event', () => {
  const h = hub()
  h.ingest({ type: 'chat.stopped', reason: 'idle', message: 'No turn is running.' })
  assert.equal(h.journal.length, 0)
})

test('a new session clears the committed projection', () => {
  const h = hub()
  startTurn(h)
  h.ingest({ type: 'chat.done', text: 'ok', sessionId: 'session-1' })
  h.turnEnded({ turnId: 'turn-1', outcome: 'done' })
  assert.ok(h.projection().messages.length >= 2)
  h.ingest({ type: 'chat.session', sessionId: 'session-2' })
  const state = h.projection()
  assert.equal(state.sessionId, 'session-2')
  assert.deepEqual(state.messages, [])
  assert.equal(h.journal.at(-1).type, 'chat.session')
})

test('chat.done preserves Docs and plan outcome metadata for remote clients', () => {
  const h = hub()
  startTurn(h)
  h.ingest({
    type: 'chat.done',
    text: 'Open work remains',
    sessionId: 'session-1',
    docsVerification: 'unverified',
    docsVerificationReason: 'read-error',
    planMode: true,
    planOutcome: 'unfinished',
    planRevision: 2,
  })
  const done = h.projection().messages.at(-1)
  assert.equal(done.type, 'chat.done')
  assert.equal(done.body.docsVerification, 'unverified')
  assert.equal(done.body.docsVerificationReason, 'read-error')
  assert.equal(done.body.planMode, true)
  assert.equal(done.body.planOutcome, 'unfinished')
  assert.equal(done.body.planRevision, 2)
})

test('chat.done carries per-turn usage and the model-reported label', () => {
  const h = hub()
  startTurn(h)
  h.ingest({
    type: 'chat.done',
    text: 'DONE — clicked once',
    sessionId: 'session-1',
    timings: { totalMs: 1_234, failedCalls: 2 },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 3 },
    label: 'done',
  })
  const done = h.projection().messages.at(-1)
  assert.equal(done.type, 'chat.done')
  assert.equal(done.body.label, 'done')
  assert.deepEqual(done.body.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 3 })
  assert.equal(done.body.timings.failedCalls, 2)

  // Foreign values are dropped rather than forwarded or guessed.
  h.ingest({ type: 'chat.done', text: 'x', label: 'success', usage: { inputTokens: -1, outputTokens: 'nope' } })
  const invalid = h.projection().messages.at(-1)
  assert.equal(invalid.body.label, null)
  assert.equal(invalid.body.usage, null)
})

test('turnEnded stores label, usage, and failed calls in the turn projection', () => {
  const h = hub()
  startTurn(h)
  h.ingest({ type: 'chat.done', text: 'PARTIAL — one cell left', sessionId: 'session-1' })
  h.turnEnded({
    turnId: 'turn-1',
    outcome: 'done',
    sessionId: 'session-1',
    label: 'partial',
    usage: { inputTokens: 40, outputTokens: 9, totalTokens: 49 },
    timings: { totalMs: 2_000, failedCalls: 3 },
  })
  const turn = h.projection().turn
  assert.equal(turn.status, 'idle')
  assert.equal(turn.outcome, 'done')
  assert.equal(turn.label, 'partial')
  assert.deepEqual(turn.usage, { inputTokens: 40, outputTokens: 9, totalTokens: 49 })
  assert.equal(turn.failedCalls, 3)

  // A new turn never inherits the previous turn's stats, and only the three
  // known labels are accepted.
  startTurn(h, 'turn-2', 'again')
  assert.equal(h.turn.label, null)
  assert.equal(h.turn.usage, null)
  assert.equal(h.turn.failedCalls, null)
  h.turnEnded({ turnId: 'turn-2', outcome: 'stopped', label: 'success', usage: { inputTokens: -2 }, timings: {} })
  assert.equal(h.turn.label, null)
  assert.equal(h.turn.usage, null)
  assert.equal(h.turn.failedCalls, null)
})

test('chat.stopped carries stop duration, failed calls, and partial usage', () => {
  const h = hub()
  startTurn(h)
  h.ingest({
    type: 'chat.stopped',
    reason: 'user',
    message: 'Stopped by user.',
    timings: { totalMs: 5_000, failedCalls: 3, toolCalls: 4 },
    usage: { inputTokens: 9, outputTokens: 1, totalTokens: 10 },
  })
  const stopped = h.projection().messages.at(-1)
  assert.equal(stopped.type, 'chat.stopped')
  assert.equal(stopped.body.timings.failedCalls, 3)
  assert.equal(stopped.body.timings.totalMs, 5_000)
  assert.deepEqual(stopped.body.usage, { inputTokens: 9, outputTokens: 1, totalTokens: 10 })
})

test('catchUp replays in order, and resyncs on instance change, unknown, or expired sequence', () => {
  const h = hub({ journalLimit: 5 })
  for (let i = 0; i < 3; i += 1) h.publish('chat.status', { i }, { turnId: null })
  let plan = h.catchUp({ instance: 'inst-a', after: '1' })
  assert.equal(plan.mode, 'replay')
  assert.deepEqual(plan.events.map(e => e.seq), [2, 3])
  assert.deepEqual(h.catchUp({ instance: 'inst-a', after: 3 }), { mode: 'replay', events: [] })
  assert.deepEqual(h.catchUp({ instance: 'inst-b', after: 1 }), { mode: 'resync', reason: 'instance-changed' })
  assert.deepEqual(h.catchUp({ after: 1 }), { mode: 'resync', reason: 'no-instance' })
  assert.deepEqual(h.catchUp({ instance: 'inst-a', after: 99 }), { mode: 'resync', reason: 'unknown-sequence' })
  assert.deepEqual(h.catchUp({ instance: 'inst-a', after: 'x' }), { mode: 'resync', reason: 'unknown-sequence' })

  for (let i = 0; i < 10; i += 1) h.publish('chat.status', { i }, { turnId: null })
  assert.equal(h.journal.length, 5)
  assert.equal(h.journal[0].seq, 9)
  assert.deepEqual(h.catchUp({ instance: 'inst-a', after: 3 }), { mode: 'resync', reason: 'expired-sequence' })
  // Exactly the event before the oldest retained one is still continuous.
  assert.deepEqual(h.catchUp({ instance: 'inst-a', after: 8 }).events.map(e => e.seq), [9, 10, 11, 12, 13])

  const frame = h.resyncFrame('expired-sequence')
  assert.equal(frame.type, 'remote.resync')
  assert.equal(frame.seq, 13)
  assert.equal(frame.body.state.latestSequence, 13)
  assert.equal(frame.body.state.oldestSequence, 9)
})

test('journal byte budget evicts the oldest events', () => {
  const h = hub({ journalByteLimit: 2_000 })
  for (let i = 0; i < 20; i += 1) h.publish('chat.tool_result', { text: 'x'.repeat(300) }, { turnId: null })
  assert.ok(h.journalBytes <= 2_000)
  assert.ok(h.journal.length < 20)
  assert.equal(h.journal.at(-1).seq, 20)
})

test('subscribers receive live envelopes and a throwing subscriber is isolated', () => {
  const h = hub()
  const seen = []
  h.subscribe(() => { throw new Error('bad') })
  const unsubscribe = h.subscribe(e => seen.push(e.seq))
  h.publish('chat.status', {}, { turnId: null })
  unsubscribe()
  h.publish('chat.status', {}, { turnId: null })
  assert.deepEqual(seen, [1])
})

test('command idempotency returns the original outcome, detects conflicts, and expires', () => {
  let now = 1_000
  const h = hub({ now: () => now, commandTtlMs: 1_000 })
  const print = fingerprint({ text: 'a' })
  h.rememberCommand('message', 'client-0001', print, { status: 202, body: { turnId: 't' } })
  assert.deepEqual(h.lookupCommand('message', 'client-0001', print), { conflict: false, outcome: { status: 202, body: { turnId: 't' } } })
  assert.deepEqual(h.lookupCommand('message', 'client-0001', fingerprint({ text: 'b' })), { conflict: true })
  assert.deepEqual(h.lookupCommand('stop', 'client-0001', print), { conflict: true })
  now += 2_000
  assert.equal(h.lookupCommand('message', 'client-0001', print), undefined)
})

test('command cache is bounded', () => {
  const h = hub({ commandLimit: 3 })
  for (let i = 0; i < 10; i += 1) h.rememberCommand('stop', `client-${String(i).padStart(4, '0')}`, '', { status: 200, body: {} })
  assert.equal(h.commands.size, 3)
  assert.equal(h.lookupCommand('stop', 'client-0000', ''), undefined)
  assert.ok(h.lookupCommand('stop', 'client-0009', ''))
})

test('usage activity reports the latest session context and a new session resets it', () => {
  const h = hub()
  h.setHealthForTest({ uiConnected: true, toolsConnected: true, dsh: 'ready', model: 'm', contextWindow: 128_000 })
  startTurn(h)
  h.ingest({ type: 'chat.activity', kind: 'usage', usage: { inputTokens: 12_000, outputTokens: 345, totalTokens: 12_345 } })
  assert.equal(h.projection().health.contextTokens, 12_345)
  assert.equal(h.projection().health.contextWindow, 128_000)
  assert.equal(h.journal.at(-1).type, 'remote.health')
  assert.equal(h.journal.at(-1).body.contextTokens, 12_345)

  h.ingest({ type: 'chat.activity', kind: 'usage', usage: { inputTokens: 13_000 } })
  assert.equal(h.projection().health.contextTokens, 13_000)
  h.ingest({ type: 'chat.activity', kind: 'usage', usage: {} })
  assert.equal(h.projection().health.contextTokens, 13_000, 'invalid usage cannot erase the last real value')
  h.setSession('session-2')
  assert.equal(h.projection().health.contextTokens, null)
  assert.equal(h.projection().health.contextWindow, 128_000)
})

const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('screenshots publish metadata only and are served by opaque ID', () => {
  const h = hub()
  startTurn(h)
  const meta = h.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png', width: 999, height: 999, callId: 'call-1', source: 'tool' })
  assert.match(meta.screenshotId, /^shot-[0-9a-f]{24}$/u)
  // The header's real pixel size wins over the caller's claim.
  assert.equal(meta.width, 1)
  assert.equal(meta.height, 1)
  const event = h.journal.at(-1)
  assert.equal(event.type, 'remote.screenshot')
  assert.equal(event.turnId, 'turn-1')
  assert.deepEqual(event.body, meta)
  assert.ok(!JSON.stringify(event).includes(PIXEL_PNG))
  assert.equal(h.projection().latestScreenshotId, meta.screenshotId)
  assert.deepEqual(h.projection().latestScreenshot, meta)
  assert.ok(!JSON.stringify(h.projection()).includes(PIXEL_PNG))
  const stored = h.screenshot(meta.screenshotId)
  assert.equal(stored.mimeType, 'image/png')
  assert.equal(stored.data.toString('base64'), PIXEL_PNG)
  assert.equal(h.screenshot('shot-unknown'), undefined)
  assert.equal(h.screenshot('../remote-token'), undefined)
})

test('screenshots reject unusable input without publishing', () => {
  const h = hub({ screenshotMaxBytes: 64 })
  const before = h.seq
  assert.equal(h.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/svg+xml' }), null)
  assert.equal(h.addScreenshot({ data: 'not base64!', mimeType: 'image/png' }), null)
  assert.equal(h.addScreenshot({ data: '', mimeType: 'image/png' }), null)
  assert.equal(h.addScreenshot({ data: Buffer.alloc(65).toString('base64'), mimeType: 'image/png' }), null)
  assert.equal(h.addScreenshot({ mimeType: 'image/png' }), null)
  assert.equal(h.seq, before)
  assert.equal(h.projection().latestScreenshot, null)
})

test('the screenshot mirror is bounded and cleared by a new session', () => {
  const h = hub({ screenshotLimit: 2 })
  const ids = [1, 2, 3].map(() => h.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png' }).screenshotId)
  assert.equal(h.screenshot(ids[0]), undefined)
  assert.ok(h.screenshot(ids[1]))
  assert.ok(h.screenshot(ids[2]))
  assert.equal(h.screenshotBytes, 140)
  const bytes = hub({ screenshotByteLimit: 100 })
  const first = bytes.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png' }).screenshotId
  const second = bytes.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png' }).screenshotId
  assert.equal(bytes.screenshot(first), undefined)
  assert.ok(bytes.screenshot(second))
  h.setSession('session-2')
  assert.equal(h.screenshot(ids[2]), undefined)
  assert.equal(h.screenshotBytes, 0)
  assert.equal(h.projection().latestScreenshotId, null)
})

test('a resumed session restores its saved transcript into the projection', () => {
  const h = hub()
  startTurn(h, 'turn-1', 'first chat')
  h.ingest({ type: 'chat.assistant', text: 'first answer' })
  h.turnEnded({ turnId: 'turn-1', outcome: 'done', sessionId: 'session-1' })
  h.ingest({ type: 'chat.session', sessionId: 'session-2' })
  assert.equal(h.projection().messages.length, 0)
  h.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png' })

  h.ingest({ type: 'chat.session', sessionId: 'session-1', resumed: true })
  const event = h.journal.at(-1)
  assert.equal(event.type, 'chat.session')
  assert.deepEqual(event.body, { sessionId: 'session-1', resumed: true, restoredMessages: 2 })
  const projection = h.projection()
  assert.equal(projection.sessionId, 'session-1')
  assert.deepEqual(projection.messages.map(message => [message.type, message.body.text]), [['chat.user', 'first chat'], ['chat.assistant', 'first answer']])
  assert.equal(projection.latestScreenshot, null)

  // The continued chat keeps growing the same saved transcript.
  h.turnStarted({ turnId: 'turn-2', origin: 'remote', clientMessageId: 'client-0002', text: 'and then?', imageCount: 0 })
  assert.equal(h.projection().messages.length, 3)
  assert.equal(h.transcript('session-1').messages.length, 3)
  assert.equal(h.sessionSummaries().find(summary => summary.sessionId === 'session-1').current, true)
})
