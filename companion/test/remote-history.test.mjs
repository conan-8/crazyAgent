import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteHistoryStore } from '../remote-history.mjs'

function envelope(type, seq, options = {}) {
  return {
    v: 1,
    instanceId: options.instanceId ?? 'inst-a',
    seq,
    type,
    sessionId: options.sessionId ?? 'session-1',
    turnId: 'turn-1',
    occurredAt: new Date(Date.UTC(2026, 10, 7, 0, 0, seq)).toISOString(),
    body: options.body ?? {},
  }
}

test('saved chats use the first prompt as the title and dedupe canonical events', () => {
  const store = new RemoteHistoryStore()
  const user = envelope('chat.user', 1, { body: { text: '  Find the   Increment button\nand click it  ' } })
  assert.equal(store.ingest(user), true)
  assert.equal(store.ingest(user), false)
  store.ingest(envelope('chat.assistant', 2, { body: { text: 'Done.' } }))
  store.ingest(envelope('remote.health', 3, { body: { contextTokens: 50 } }))
  assert.deepEqual(store.summaries(), [{
    sessionId: 'session-1',
    title: 'Find the Increment button and click it',
    updatedAt: '2026-11-07T00:00:02.000Z',
    messageCount: 2,
    truncated: false,
  }])
  assert.equal(store.transcript('session-1').messages.length, 2)
  assert.equal(store.transcript('missing'), undefined)
})

test('history is bounded and marks transcripts whose oldest messages were evicted', () => {
  const store = new RemoteHistoryStore({ limit: 2, messageLimit: 2 })
  for (const sessionId of ['session-1', 'session-2', 'session-3']) {
    store.ingest(envelope('chat.user', 1, { sessionId, body: { text: sessionId } }))
  }
  assert.deepEqual(store.summaries().map(item => item.sessionId), ['session-3', 'session-2'])
  store.ingest(envelope('chat.assistant', 2, { sessionId: 'session-3', body: { text: 'two' } }))
  store.ingest(envelope('chat.assistant', 3, { sessionId: 'session-3', body: { text: 'three' } }))
  const transcript = store.transcript('session-3')
  assert.deepEqual(transcript.messages.map(item => item.seq), [2, 3])
  assert.equal(transcript.droppedMessages, 1)
  assert.equal(store.summaries()[0].truncated, true)
})

test('history survives reload with 0600 permissions and rejects malformed records', t => {
  const dir = mkdtempSync(join(tmpdir(), 'crazyagent-history-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'history.json')
  const store = new RemoteHistoryStore({ file })
  store.ingest(envelope('chat.user', 1, { body: { text: 'persist me' } }))
  store.close()
  assert.equal(statSync(file).mode & 0o777, 0o600)

  const loaded = new RemoteHistoryStore({ file })
  assert.equal(loaded.summaries()[0].title, 'persist me')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.sessions.push({ sessionId: '../../secret', messages: [] }, { sessionId: 'empty', messages: [] })
  raw.sessions[0].messages.push({ type: 'browser.command', sessionId: 'session-1' })
  const reloaded = new RemoteHistoryStore({ file })
  assert.equal(reloaded.summaries().length, 1)
  assert.equal(reloaded.transcript('session-1').messages.length, 1)
  reloaded.close()
  loaded.close()
})
