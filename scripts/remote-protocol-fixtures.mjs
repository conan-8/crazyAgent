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

/**
 * M5: the marathon switch, the carried plan checklist, and watch notices —
 * a hard deterministic alert, M4 judge stuck/blocked verdicts (same envelope,
 * source watcher/both), recovery collapse, an ended-incomplete turn end with
 * its additive watch summary, an "It's fine" dismissal, and the new-chat reset.
 * Every frame is recorded from the real RemoteHub exactly as a phone receives it.
 */
function marathonWatch() {
  const s = scenario('companion-fixture-g')
  s.connect()
  const since = '2026-11-06T12:00:01.000Z'
  const marathonState = (plan, watcher) => ({
    type: 'marathon.state',
    enabled: true,
    sessionId: 'session-1',
    since,
    origin: 'remote',
    plan,
    watcher,
  })
  const watch = (id, kind, state, extra = {}) => ({
    type: 'chat.watch',
    id,
    turnId: 'turn-14',
    kind,
    state,
    blocker: null,
    reason: '',
    signals: [],
    source: 'heuristic',
    at: '2026-11-06T12:01:20.000Z',
    ...extra,
  })
  // The phone's chip turned the shared switch on.
  s.hub.ingest(marathonState(null, { active: false, checks: 0, lastCheckAt: null, lastVerdict: null }))
  startTurn(s, 'turn-14', 'Fill in the shipping form and place the order', { marathon: true })
  s.modelStart()
  s.text('Working through the checkout.')
  s.hub.ingest(marathonState(null, { active: true, checks: 3, lastCheckAt: '2026-11-06T12:01:00.000Z', lastVerdict: null }))
  // A hard deterministic alert: one tool call has not returned.
  s.hub.ingest(watch('watch-fixture-1', 'TOOL_HANG', 'open', {
    blocker: 'TOOL_HANG',
    reason: 'A browser call has not returned for several minutes.',
    signals: [{ kind: 'TOOL_HANG', level: 'hard', detail: 'browser_wait_for unanswered for 250s' }],
  }))
  const afterAlert = s.hub.projection()
  // M4 judge verdicts ride the same envelope: kind is the verdict state.
  s.hub.ingest(watch('watch-fixture-2', 'stuck', 'open', {
    blocker: 'loop',
    reason: 'The same click repeats and the page does not change.',
    signals: [{ kind: 'REPEAT_LOOP', level: 'suspect', detail: 'browser_click 4 of the last 8 calls' }],
    source: 'watcher',
    at: '2026-11-06T12:02:00.000Z',
  }))
  const afterJudge = s.hub.projection()
  s.hub.ingest(watch('watch-fixture-3', 'blocked', 'open', {
    blocker: 'login',
    reason: 'A sign-in wall is blocking the task while the agent keeps acting.',
    source: 'both',
    at: '2026-11-06T12:03:00.000Z',
  }))
  const afterBlocked = s.hub.projection()
  // Recovery collapses the notice; no push rides a recovery.
  s.hub.ingest(watch('watch-fixture-3', 'recovered', 'recovered', {
    reason: 'The agent is making progress again.',
    at: '2026-11-06T12:04:00.000Z',
  }))
  // The turn ends with open items: the plan carries into marathon.state —
  // the phone's first checklist — and chat.done carries both mode flags plus
  // the additive watch summary.
  const carriedPlan = {
    revision: 2,
    items: [
      { content: 'Fill the shipping form', status: 'completed' },
      { content: 'Place the order', status: 'in_progress' },
      { content: 'Verify the confirmation page', status: 'pending' },
    ],
    updatedAt: '2026-11-06T12:04:30.000Z',
    turnId: 'turn-14',
  }
  s.hub.ingest(marathonState(carriedPlan, { active: false, checks: 6, lastCheckAt: '2026-11-06T12:04:40.000Z', lastVerdict: null }))
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'PARTIAL — the shipping form is filled but the order was not placed.',
    label: 'partial',
    model: 'fixture/model',
    planMode: true,
    marathon: true,
    planOutcome: 'unfinished',
    planRevision: 2,
    watch: { checks: 6, alerts: 3, usage: 0 },
    timings: { totalMs: 280_000, toolCalls: 14, failedCalls: 2 },
    usage: { inputTokens: 40_000, outputTokens: 900, totalTokens: 40_900 },
  })
  s.hub.ingest(watch('watch-fixture-4', 'ended-incomplete', 'open', {
    blocker: 'ended-incomplete',
    reason: 'The turn ended with work still open or blocked.',
    at: '2026-11-06T12:04:41.000Z',
  }))
  s.hub.turnEnded({
    turnId: 'turn-14',
    outcome: 'done',
    sessionId: 'session-1',
    label: 'partial',
    usage: { inputTokens: 40_000, outputTokens: 900, totalTokens: 40_900 },
    timings: { totalMs: 280_000, toolCalls: 14, failedCalls: 2 },
  })
  const afterEnded = s.hub.projection()
  // "It's fine": the ack dismisses the open alert and snoozes its kind.
  s.hub.ingest(watch('watch-fixture-4', 'info', 'dismissed', {
    reason: 'Dismissed; this alert kind is snoozed for 15 minutes.',
    at: '2026-11-06T12:05:00.000Z',
  }))
  // A new chat resets the switch, the plan, and every watch state.
  s.hub.setSession('session-2')
  const fixture = s.done('marathon-watch')
  return { ...fixture, checkpoints: { afterAlert, afterJudge, afterBlocked, afterEnded } }
}

/**
 * V1 (task-15): the alert lifecycle — every open notice gets an explicit
 * close. A mid-turn alert is closed at a turn end that fires ended-incomplete
 * (superseded in the same step); the ended-incomplete is closed at the next
 * turn start BEFORE its first frame; a second ended-incomplete is dismissed
 * through the ack path; a new chat resets everything. Recorded from the real
 * RemoteHub with core's V1 lifecycle code merged (c0d89d5); the hub's
 * production handling of closed==dismissed is unchanged since M3.
 */
function marathonWatchLifecycle() {
  const s = scenario('companion-fixture-h')
  s.connect()
  const since = '2026-11-17T12:00:01.000Z'
  const marathonState = watcher => ({
    type: 'marathon.state',
    enabled: true,
    sessionId: 'session-1',
    since,
    origin: 'remote',
    plan: null,
    watcher,
  })
  const watch = (id, kind, state, extra = {}) => ({
    type: 'chat.watch',
    id,
    turnId: 'turn-15',
    kind,
    state,
    blocker: null,
    reason: '',
    signals: [],
    source: 'heuristic',
    at: '2026-11-17T12:04:00.000Z',
    ...extra,
  })
  const closed = (id, reason, turnId) => watch(id, 'info', 'closed', { reason, turnId, at: '2026-11-17T12:05:00.000Z' })
  s.hub.ingest(marathonState({ active: false, checks: 0, lastCheckAt: null, lastVerdict: null }))
  startTurn(s, 'turn-15', 'Place the order and verify it', { marathon: true })
  s.modelStart()
  s.text('Working through the checkout.')
  s.hub.ingest(marathonState({ active: true, checks: 3, lastCheckAt: '2026-11-17T12:03:00.000Z', lastVerdict: null }))
  // A hard alert opens mid-turn.
  s.hub.ingest(watch('watch-life-1', 'TOOL_HANG', 'open', {
    blocker: 'TOOL_HANG',
    reason: 'A browser call has not returned for several minutes.',
    signals: [{ kind: 'TOOL_HANG', level: 'hard', detail: 'browser_wait_for unanswered for 250s' }],
  }))
  const afterAlert = s.hub.projection()
  // Turn end fires ended-incomplete: the alert is closed under its own id in
  // the SAME step, and ended-incomplete becomes the one open notice.
  s.hub.ingest(closed('watch-life-1', 'Turn ended.', 'turn-15'))
  s.hub.ingest(watch('watch-life-2', 'ended-incomplete', 'open', {
    blocker: 'ended-incomplete',
    reason: 'The turn ended with work still open or blocked.',
    at: '2026-11-17T12:05:01.000Z',
  }))
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'PARTIAL — the order was not placed.',
    label: 'partial',
    model: 'fixture/model',
    planMode: true,
    marathon: true,
    planOutcome: 'unfinished',
    watch: { checks: 6, alerts: 1, usage: 0 },
    timings: { totalMs: 300_000, toolCalls: 12, failedCalls: 1 },
    usage: { inputTokens: 30_000, outputTokens: 700, totalTokens: 30_700 },
  })
  s.hub.turnEnded({
    turnId: 'turn-15',
    outcome: 'done',
    sessionId: 'session-1',
    label: 'partial',
    usage: { inputTokens: 30_000, outputTokens: 700, totalTokens: 30_700 },
    timings: { totalMs: 300_000, toolCalls: 12, failedCalls: 1 },
  })
  const afterSupersede = s.hub.projection()
  // The next turn start closes the ended-incomplete BEFORE the first frame.
  s.hub.ingest(closed('watch-life-2', 'A new turn started.', 'turn-16'))
  startTurn(s, 'turn-16', 'continue', { marathon: true })
  const afterNextTurnStart = s.hub.projection()
  s.modelStart()
  s.text('Trying the order again.')
  // The second turn also ends incomplete; this time the user acks it.
  s.hub.ingest({
    type: 'chat.done',
    sessionId: 'session-1',
    text: 'PARTIAL — still blocked on the confirmation page.',
    label: 'partial',
    model: 'fixture/model',
    planMode: true,
    marathon: true,
    planOutcome: 'unfinished',
    watch: { checks: 2, alerts: 0, usage: 0 },
    timings: { totalMs: 40_000, toolCalls: 3, failedCalls: 0 },
    usage: { inputTokens: 8_000, outputTokens: 200, totalTokens: 8_200 },
  })
  s.hub.ingest(watch('watch-life-3', 'ended-incomplete', 'open', {
    blocker: 'ended-incomplete',
    reason: 'The turn ended with work still open or blocked.',
    turnId: 'turn-16',
    at: '2026-11-17T12:06:01.000Z',
  }))
  s.hub.turnEnded({
    turnId: 'turn-16',
    outcome: 'done',
    sessionId: 'session-1',
    label: 'partial',
    usage: { inputTokens: 8_000, outputTokens: 200, totalTokens: 8_200 },
    timings: { totalMs: 40_000, toolCalls: 3, failedCalls: 0 },
  })
  const afterSecondEnded = s.hub.projection()
  // "It's fine": the V1 ack path closes it with a dismissed frame (200, no snooze).
  s.hub.ingest(watch('watch-life-3', 'info', 'dismissed', {
    turnId: 'turn-16',
    reason: 'Dismissed.',
    at: '2026-11-17T12:07:00.000Z',
  }))
  // A new chat resets the switch and every watch state.
  s.hub.setSession('session-2')
  const fixture = s.done('marathon-watch-lifecycle')
  return { ...fixture, checkpoints: { afterAlert, afterSupersede, afterNextTurnStart, afterSecondEnded } }
}

export function buildFixtures() {
  return [turnStream(), midTurnResync(), lifecycle(), helpRequest(), confirmRequest(), deadTurn(), marathonWatch(), marathonWatchLifecycle()]
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
