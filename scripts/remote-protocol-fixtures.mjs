#!/usr/bin/env node
/**
 * Remote-protocol contract fixtures for the Android client.
 *
 * Each fixture drives the real `RemoteHub` through a deterministic scenario
 * and records exactly what a phone would receive on `/events` (a resync frame
 * followed by sequenced envelopes) plus the hub's final `/state` projection.
 * The Android reducer tests replay these frames and must reach the same
 * projection, so the Kotlin client cannot silently drift from the server.
 *
 *   node scripts/remote-protocol-fixtures.mjs          # rewrite the fixtures
 *   node scripts/remote-protocol-fixtures.mjs --check  # exit 1 if stale
 *
 * `npm test` runs the check (companion/test/remote-protocol-fixtures.test.mjs).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RemoteHub } from '../companion/remote-hub.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE_DIR = join(root, 'android/app/src/test/resources/remote-protocol')

const READY = Object.freeze({
  uiConnected: true,
  toolsConnected: true,
  dsh: 'ready',
  dshMessage: null,
  provider: 'openrouter',
  model: 'fixture/model',
  autoCapture: true,
})

/** A 1x1 PNG; the fixture records only its metadata, with a deterministic ID. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function scenario(instanceId) {
  let clock = Date.UTC(2026, 10, 6, 12, 0, 0)
  let health = { ...READY }
  let shots = 0
  const hub = new RemoteHub({ instanceId, serverVersion: 'fixture', now: () => (clock += 1_000), getHealth: () => health, newScreenshotId: () => `shot-fixture-${(shots += 1)}` })
  hub.setSession('session-1')
  hub.updateHealth()
  const frames = []
  return {
    hub,
    frames,
    setHealth(next) {
      health = { ...health, ...next }
      hub.updateHealth()
    },
    /** Connect a phone now: resync first, then live events in order. */
    connect(reason = 'no-instance') {
      frames.push(hub.resyncFrame(reason))
      hub.subscribe(envelope => frames.push(structuredClone(envelope)))
    },
    text(chunk) { hub.ingest({ type: 'chat.activity', kind: 'text', text: chunk }) },
    reasoning(chunk) { hub.ingest({ type: 'chat.activity', kind: 'reasoning', text: chunk }) },
    toolDelta(id, name, argumentsDelta) { hub.ingest({ type: 'chat.activity', kind: 'tool-call-delta', id, name, argumentsDelta }) },
    modelStart() { hub.ingest({ type: 'chat.activity', kind: 'model-start' }) },
    done(name) {
      return { name, frames, final: hub.projection() }
    },
  }
}

function startTurn(s, turnId, text, extra = {}) {
  s.hub.turnStarted({ turnId, origin: 'remote', clientMessageId: `client-${turnId}`, text, imageCount: 0, sessionId: 'session-1', ...extra })
  s.hub.ingest({ type: 'chat.status', status: 'thinking' })
}

/** A full streamed turn: drafts, commit replacement, a tool call/result, and done. */
function turnStream() {
  const s = scenario('companion-fixture-a')
  s.connect()
  startTurn(s, 'turn-1', 'Open the cart', { imageCount: 1 })
  s.modelStart()
  s.reasoning('The user wants the cart.')
  s.text("I'll open")
  s.text(' the cart.')
  s.toolDelta('call-1', 'browser_click', '{"lab')
  s.toolDelta('call-1', null, 'el":3}')
  s.hub.ingest({ type: 'chat.assistant', text: "I'll open the cart." })
  s.hub.ingest({ type: 'chat.tool_call', callId: 'call-1', name: 'browser_click', args: { label: 3 } })
  s.hub.ingest({ type: 'chat.status', status: 'tool', tool: 'browser_click' })
  s.hub.ingest({ type: 'chat.tool_result', callId: 'call-1', ok: true, text: 'clicked "Cart"' })
  s.hub.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png', turnId: 'turn-1', callId: 'call-1', source: 'tool' })
  s.modelStart()
  s.text('The cart has 2 items.')
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'DONE — the cart has 2 items.',
    label: 'done',
    model: 'fixture/model',
    timings: { totalMs: 1234, toolCalls: 1, failedCalls: 0 },
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadTokens: 40 },
  })
  s.hub.turnEnded({
    turnId: 'turn-1',
    outcome: 'done',
    sessionId: 'session-1',
    label: 'done',
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadTokens: 40 },
    timings: { totalMs: 1234, toolCalls: 1, failedCalls: 0 },
  })
  return s.done('turn-stream')
}

/** The phone connects mid-draft (expired cursor) and receives the aggregated draft. */
function midTurnResync() {
  const s = scenario('companion-fixture-b')
  startTurn(s, 'turn-2', 'Summarize the page')
  s.modelStart()
  s.text('The page ')
  s.text('lists ')
  s.toolDelta('call-9', 'browser_read_text', '{"max')
  s.connect('expired-sequence')
  s.text('three products.')
  s.toolDelta('call-9', null, '_chars":4000}')
  s.hub.ingest({ type: 'chat.assistant', text: 'The page lists three products.' })
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'The page lists three products.',
    label: null,
    model: 'fixture/model',
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  })
  s.hub.turnEnded({
    turnId: 'turn-2',
    outcome: 'done',
    sessionId: 'session-1',
    label: null,
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    timings: { totalMs: 900, toolCalls: 1, failedCalls: 0 },
  })
  return s.done('mid-turn-resync')
}

/** Stop, an error turn, health changes, then a new session clearing the chat. */
function lifecycle() {
  const s = scenario('companion-fixture-c')
  s.connect()
  startTurn(s, 'turn-3', 'Long task')
  s.modelStart()
  s.text('Working')
  s.hub.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png', turnId: 'turn-3', source: 'auto' })
  s.hub.ingest({ type: 'chat.stopping', message: 'Stopping…' })
  s.hub.ingest({
    type: 'chat.stopped',
    reason: 'user',
    message: 'Stopped.',
    timings: { totalMs: 4321, toolCalls: 2, failedCalls: 2 },
    usage: { inputTokens: 15, outputTokens: 3, totalTokens: 18 },
  })
  s.hub.turnEnded({
    turnId: 'turn-3',
    outcome: 'stopped',
    sessionId: 'session-1',
    label: null,
    usage: { inputTokens: 15, outputTokens: 3, totalTokens: 18 },
    timings: { totalMs: 4321, toolCalls: 2, failedCalls: 2 },
  })
  s.setHealth({ uiConnected: false })
  startTurn(s, 'turn-4', 'Click buy')
  s.hub.ingest({ type: 'chat.error', message: 'The side panel is not connected.', recoverable: true })
  s.hub.turnEnded({
    turnId: 'turn-4',
    outcome: 'error',
    error: 'The side panel is not connected.',
    label: null,
    usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
    timings: { totalMs: 300, toolCalls: 1, failedCalls: 1 },
  })
  s.setHealth({ uiConnected: true })
  const afterError = s.hub.projection()
  s.hub.setSession('session-2')
  const fixture = s.done('lifecycle')
  return { ...fixture, checkpoints: { afterError } }
}

/**
 * The agent asks for the user: one help capture, the waiting state, a manual
 * capture while waiting, the reply that continues the chat, then a second
 * request (no capture this time) cleared by a new session.
 */
function helpRequest() {
  const s = scenario('companion-fixture-d')
  s.connect()
  startTurn(s, 'turn-5', 'Check my inbox')
  s.hub.ingest({ type: 'chat.assistant', text: 'I need you to sign in.' })
  s.hub.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png', turnId: 'turn-5', callId: 'auto', source: 'help' })
  const help = { category: 'login', reason: 'Sign in to the mail site, then tell me to continue.' }
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'I need you to sign in.',
    label: null,
    model: 'fixture/model',
    usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 },
    help,
  })
  s.hub.turnEnded({ turnId: 'turn-5', outcome: 'done', sessionId: 'session-1', label: null, usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 }, timings: { totalMs: 800, failedCalls: 0 }, help: { ...help, captureError: null } })
  const waiting = s.hub.projection()
  s.hub.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png', callId: 'auto', source: 'manual' })
  const waitingAfterCapture = s.hub.projection()
  startTurn(s, 'turn-6', 'Signed in, continue')
  s.hub.ingest({ type: 'chat.assistant', text: 'You have 3 new messages.' })
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'DONE — you have 3 new messages.',
    label: 'done',
    model: 'fixture/model',
    usage: { inputTokens: 25, outputTokens: 7, totalTokens: 32 },
  })
  s.hub.turnEnded({ turnId: 'turn-6', outcome: 'done', sessionId: 'session-1', label: 'done', usage: { inputTokens: 25, outputTokens: 7, totalTokens: 32 }, timings: { totalMs: 700, failedCalls: 0 } })
  const afterReply = s.hub.projection()
  startTurn(s, 'turn-7', 'Open the attachment')
  const blocked = { category: 'captcha', reason: 'Solve the CAPTCHA on the download page.' }
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'BLOCKED — a CAPTCHA is in the way.',
    label: 'blocked',
    model: 'fixture/model',
    usage: { inputTokens: 18, outputTokens: 4, totalTokens: 22 },
    help: blocked,
  })
  s.hub.turnEnded({
    turnId: 'turn-7',
    outcome: 'done',
    sessionId: 'session-1',
    label: 'blocked',
    usage: { inputTokens: 18, outputTokens: 4, totalTokens: 22 },
    timings: { totalMs: 600, failedCalls: 1 },
    help: { ...blocked, captureError: 'The browser side panel is not connected, so the screen cannot be captured.' },
  })
  const waitingNoCapture = s.hub.projection()
  s.hub.setSession('session-2')
  const fixture = s.done('help-request')
  return { ...fixture, checkpoints: { waiting, waitingAfterCapture, afterReply, waitingNoCapture } }
}

/**
 * B9a: the agent asks to perform an irreversible action. One confirm capture,
 * the waiting state, a manual capture while waiting, the companion-written
 * approve block that continues the chat, then a second request (no capture
 * this time) cleared by a new session.
 */
function confirmRequest() {
  const s = scenario('companion-fixture-e')
  s.connect()
  s.setHealth({ confirmIrreversible: true })
  startTurn(s, 'turn-8', 'Fill in the form and submit it')
  s.hub.ingest({ type: 'chat.assistant', text: 'I need your approval to submit.' })
  s.hub.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png', turnId: 'turn-8', callId: 'auto', source: 'confirm' })
  const confirm = { action: 'Submit the assignment for grading', target: 'Submit for Grading button' }
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'BLOCKED — waiting for your approval to submit.',
    label: 'blocked',
    model: 'fixture/model',
    usage: { inputTokens: 32, outputTokens: 7, totalTokens: 39 },
    confirm,
  })
  s.hub.turnEnded({ turnId: 'turn-8', outcome: 'done', sessionId: 'session-1', label: 'blocked', usage: { inputTokens: 32, outputTokens: 7, totalTokens: 39 }, timings: { totalMs: 900, failedCalls: 0 }, confirm: { ...confirm, captureError: null } })
  const waiting = s.hub.projection()
  s.hub.addScreenshot({ data: PIXEL_PNG, mimeType: 'image/png', callId: 'auto', source: 'manual' })
  const waitingAfterCapture = s.hub.projection()
  startTurn(s, 'turn-9', 'Approved: Submit the assignment for grading')
  s.hub.ingest({ type: 'chat.assistant', text: 'Submitted.' })
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'DONE — the assignment was submitted.',
    label: 'done',
    model: 'fixture/model',
    usage: { inputTokens: 26, outputTokens: 6, totalTokens: 32 },
  })
  s.hub.turnEnded({ turnId: 'turn-9', outcome: 'done', sessionId: 'session-1', label: 'done', usage: { inputTokens: 26, outputTokens: 6, totalTokens: 32 }, timings: { totalMs: 700, failedCalls: 0 } })
  const afterApprove = s.hub.projection()
  startTurn(s, 'turn-10', 'Now delete the draft')
  const blocked = { action: 'Delete the draft', target: 'Delete button' }
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'BLOCKED — waiting for your approval to delete.',
    label: 'blocked',
    model: 'fixture/model',
    usage: { inputTokens: 19, outputTokens: 5, totalTokens: 24 },
    confirm: blocked,
  })
  s.hub.turnEnded({
    turnId: 'turn-10',
    outcome: 'done',
    sessionId: 'session-1',
    label: 'blocked',
    usage: { inputTokens: 19, outputTokens: 5, totalTokens: 24 },
    timings: { totalMs: 650, failedCalls: 0 },
    confirm: { ...blocked, captureError: 'The browser side panel is not connected, so the screen cannot be captured.' },
  })
  const waitingNoCapture = s.hub.projection()
  s.hub.setSession('session-2')
  const fixture = s.done('confirm-request')
  return { ...fixture, checkpoints: { waiting, waitingAfterCapture, afterApprove, waitingNoCapture } }
}

/**
 * Q10: both malformed-reply endings, recorded from the real hub exactly as the
 * companion emits them. A MALFORMED_RESPONSE turn streams a broken-JSON tool
 * delta plus the call's DSML tail as text, is retried once, then ends as
 * `chat.error`; a turn whose final reply is leaked markup dead-steps through two
 * steers and ends as `chat.done` with the BLOCKED text and label `blocked`. The
 * markup rides only the transient draft, which each ending drops — no committed
 * item ever carries it. A clean follow-up turn shows the slot recovering.
 */
function deadTurn() {
  const s = scenario('companion-fixture-f')
  s.connect()
  const ERROR_TEXT = "The model's reply could not be used (MALFORMED_RESPONSE), so nothing was done. Send the request again."
  const BLOCKED_TEXT = 'BLOCKED: the model sent an empty or malformed reply, so nothing was done on the page. Send the request again.'
  const BROKEN_ARGS = '{"actions":[{"op":"click","label":7},{"op":"type","label":9,"text":"hello","mode":"replace"}]'
  const DSML_TAIL = '\n<｜DSML｜ parameter name="view":"full</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>'
  const LEAKED_CALL = '\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="browser_batch">\n<｜DSML｜ parameter name="actions">[{"op":"click","label":7}]</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>'

  // Ending 1: malformed twice -> chat.error (the retry is a new model run).
  startTurn(s, 'turn-11', 'Fill in the form and submit it')
  s.modelStart()
  s.reasoning('Looking at the form.')
  s.toolDelta('call-a', 'browser_batch', BROKEN_ARGS)
  s.text(DSML_TAIL)
  s.modelStart()
  s.text(DSML_TAIL)
  s.hub.ingest({ type: 'chat.error', message: ERROR_TEXT, recoverable: true })
  s.hub.turnEnded({
    turnId: 'turn-11',
    outcome: 'error',
    error: ERROR_TEXT,
    sessionId: 'session-1',
    label: null,
    usage: { inputTokens: 21963, outputTokens: 205, totalTokens: 22168 },
    timings: { totalMs: 1100, toolCalls: 0, failedCalls: 0 },
  })
  const afterError = s.hub.projection()

  // Ending 2: leaked markup final -> chat.done BLOCKED, label blocked.
  startTurn(s, 'turn-12', 'Try again after the error.')
  s.modelStart()
  s.reasoning('Trying the form again.')
  s.text(LEAKED_CALL)
  s.modelStart()
  s.text('\n<｜DSM')
  s.text('L｜ calls>\n<｜DSML｜ invoke name="browser_batch">\n</｜DSML｜ invoke>\n</｜DSML｜ calls>')
  s.modelStart()
  s.text(LEAKED_CALL)
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: BLOCKED_TEXT,
    label: 'blocked',
    model: 'fixture/model',
    timings: { totalMs: 12300, toolCalls: 0, failedCalls: 0 },
    usage: { inputTokens: 22168, outputTokens: 205, totalTokens: 22373, cacheReadTokens: 12000 },
  })
  s.hub.turnEnded({
    turnId: 'turn-12',
    outcome: 'done',
    sessionId: 'session-1',
    label: 'blocked',
    usage: { inputTokens: 22168, outputTokens: 205, totalTokens: 22373, cacheReadTokens: 12000 },
    timings: { totalMs: 12300, toolCalls: 0, failedCalls: 0 },
  })
  const afterBlocked = s.hub.projection()

  // Recovery: an ordinary turn runs and finishes after both dead endings.
  startTurn(s, 'turn-13', 'One more try.')
  s.hub.ingest({ type: 'chat.assistant', text: 'DONE: all set.' })
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'DONE: all set.',
    label: 'done',
    model: 'fixture/model',
    usage: { inputTokens: 22373, outputTokens: 12, totalTokens: 22385 },
  })
  s.hub.turnEnded({
    turnId: 'turn-13',
    outcome: 'done',
    sessionId: 'session-1',
    label: 'done',
    usage: { inputTokens: 22373, outputTokens: 12, totalTokens: 22385 },
    timings: { totalMs: 700, toolCalls: 0, failedCalls: 0 },
  })
  const afterRecovery = s.hub.projection()
  const fixture = s.done('dead-turn')
  return { ...fixture, checkpoints: { afterError, afterBlocked, afterRecovery } }
}

export function buildFixtures() {
  return [turnStream(), midTurnResync(), lifecycle(), helpRequest(), confirmRequest(), deadTurn()]
}

export function fixtureFiles() {
  return buildFixtures().map(fixture => ({ path: join(FIXTURE_DIR, `${fixture.name}.json`), text: `${JSON.stringify(fixture, null, 2)}\n` }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check')
  let stale = 0
  for (const file of fixtureFiles()) {
    if (check) {
      let current = ''
      try {
        current = readFileSync(file.path, 'utf8')
      } catch {
        // Missing counts as stale.
      }
      if (current !== file.text) {
        stale += 1
        process.stderr.write(`stale: ${file.path}\n`)
      }
    } else {
      mkdirSync(dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.text)
      process.stdout.write(`wrote ${file.path}\n`)
    }
  }
  if (stale > 0) {
    process.stderr.write('Run: node scripts/remote-protocol-fixtures.mjs\n')
    process.exit(1)
  }
}
