#!/usr/bin/env node
/**
 * C1 acceptance through the real runtime (plan-temporary.md Q6 / Track C1).
 * No accounts: every check runs against the local fixtures with a real model
 * on an isolated companion, isolated DSH home, and isolated Edge — the same
 * pattern as scripts/model-eval.mjs, whose helpers this script reuses.
 *
 *   node scripts/c1-acceptance.mjs --self-test        # mutation-check checkers, no model
 *   CRAZYAGENT_API_KEY=... node scripts/c1-acceptance.mjs
 *   CRAZYAGENT_API_KEY=... node scripts/c1-acceptance.mjs --check plan --check steer
 *
 * Checks (each C1 row):
 *   plan       /plan turn (planMode:true) on a multi-step form task. Evidence:
 *              chat.done planOutcome + independent page state (result text,
 *              submit counter, collateral fields).
 *   resume     an older chat resumed through POST /sessions/{id}/resume after
 *              an intervening different chat; the follow-up answer must use a
 *              harness-generated code that exists only in the earlier turn.
 *              BOTH paths are exercised unconditionally (task-16 proof gate):
 *              in-process resume (since 6276261 an owned target is restored
 *              via an internal runtime restart) and the post-restart restore.
 *              Pass requires both; one path alone is partial. A failed
 *              in-process follow-up doubles as the negative control: the code
 *              must NOT appear without a successful restore.
 *   steer      steer:true mid-turn; first turn stopped, second ran once, the
 *              fixture counter shows no duplicate action (ground truth is the
 *              counter, not tool results).
 *   cycles     20 Stop/New cycles with 4 live remote-token rotations
 *              (--new-remote-token one-shot; the running companion re-reads the
 *              file). No stuck TURN_BUSY, no orphaned turn slot, old token
 *              revoked, new token works.
 *   minimized  a real-model turn on a HEADED Edge whose window is minimized
 *              through CDP mid-turn; the screenshots the companion saved after
 *              the minimize are decoded through the harness's own page and
 *              must contain the fixture's real pixels (the red #e11d48 dot the
 *              model's trusted canvas click creates), not a blank frame.
 *              Headed because headless has no real window to minimize — a
 *              headless "minimized" test would be vacuous.
 *
 * Isolation: own dsh-home (default /tmp/crazyagent-c1/dsh-home — concurrent
 * companions must NOT share a home: token files and run-dir resolution race),
 * free ports only (never 9233/17871/17873), throwaway Edge profiles, downloads
 * confined to the run temp dir (profile preference + CDP override, Edge 157).
 * The API key comes only from CRAZYAGENT_API_KEY; never printed.
 *
 * Checkers are pure functions over collected evidence; --self-test mutation-
 * checks each one (good evidence must pass, every bad variant must not).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  PageController,
  freePort,
  injectExtensionSettings,
  listTargets,
  nowIso,
  prepareDshHome,
  readTurnMetrics,
  resolveRunEvents,
  routeDownloads,
  sleep,
  startCompanion,
  startEdge,
  startFixtureServer,
  until,
  waitForRemoteReady,
  waitForTurn,
  waitForTurnEndInLog,
} from './model-eval.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINES_DIR = join(ROOT, 'e2e', 'baselines')
const COMPANION_ENTRY = join(ROOT, 'companion', 'index.mjs')
const DEFAULT_C1_HOME = join(tmpdir(), 'crazyagent-c1', 'dsh-home')
const CHECK_NAMES = ['plan', 'resume', 'steer', 'cycles', 'minimized']

// ---------------------------------------------------------------------------
// Pure checkers (evidence in, verdict out). Mutation-checked by --self-test.
// ---------------------------------------------------------------------------

/** C1(a): plan outcome travels in chat.done; page state is the proof. */
export function checkPlanEvidence({ page, chatDone, turnEnd }) {
  const reasons = []
  if (!page) return { status: 'fail', reasons: ['no page state read'] }
  const pageOk = page.result === page.expectedResult
    && page.submitEvents === 1
    && page.name === page.requested.name
    && page.notes === page.requested.notes
    && page.editor === '' && page.rich === '' && page.comment === ''
    && page.selectable === 'SELECT-ME-ALPHA BETA GAMMA'
  if (!pageOk) {
    reasons.push(`page state wrong: result=${JSON.stringify(page.result)} submits=${page.submitEvents} collateral=${JSON.stringify({ editor: page.editor, rich: page.rich, comment: page.comment, selectable: page.selectable })}`)
  }
  if (!chatDone) return { status: 'fail', reasons: [...reasons, 'no chat.done frame for the turn'] }
  if (chatDone.planMode !== true) reasons.push('chat.done.planMode is not true')
  const outcome = chatDone.planOutcome
  if (outcome !== 'reported-complete') reasons.push(`planOutcome=${JSON.stringify(outcome)} (expected reported-complete)`)
  if (!Number.isSafeInteger(chatDone.planRevision) || chatDone.planRevision < 1) reasons.push(`planRevision=${JSON.stringify(chatDone.planRevision)} (expected >=1)`)
  if (turnEnd && turnEnd.ok !== true) reasons.push('turn.end not ok')
  if (!pageOk) return { status: 'fail', reasons }
  if (reasons.length > 0) return { status: 'partial', reasons }
  return { status: 'pass', reasons: [] }
}

/**
 * C1(b): the answer must carry the restored-context code; session must match.
 * BOTH runtime paths are exercised unconditionally (task-16 proof gate):
 * in-process resume of an earlier chat of the same companion process, and
 * the post-restart restore. Pass requires both; one path alone is partial.
 * When in-process resume fails, its follow-up answer is a NEGATIVE CONTROL:
 * it must NOT contain the code (context cannot leak without a restore).
 */
export function checkResumeEvidence({ inProcess, restart, stateSessionId, restartStateSessionId, expectedSessionId, answerText, restartAnswerText, code, interveningAnswer }) {
  const reasons = []
  const inProcessOk = inProcess?.ok === true
  const restartOk = restart?.performed === true && restart?.ok === true
  if (!inProcessOk && !restartOk) {
    return { status: 'fail', reasons: [`resume did not succeed on either path (in-process: ${inProcess?.code ?? inProcess?.status ?? 'not attempted'}; restart: ${restart?.performed ? (restart.code ?? restart.status) : 'not performed'})`] }
  }
  const hasCode = text => Boolean(code) && String(text ?? '').toLowerCase().includes(String(code).toLowerCase())
  if (stateSessionId !== expectedSessionId) reasons.push(`/state.sessionId=${stateSessionId} != resumed ${expectedSessionId}`)
  if (inProcessOk) {
    if (!hasCode(answerText)) reasons.push(`in-process follow-up does not contain the restored code ${code}: ${JSON.stringify(String(answerText ?? '').slice(0, 120))}`)
  } else if (hasCode(answerText)) {
    reasons.push(`negative control violated: code appeared without a successful in-process resume: ${JSON.stringify(String(answerText).slice(0, 120))}`)
  }
  if (restart?.performed === true) {
    if (restartStateSessionId !== expectedSessionId) reasons.push(`post-restart /state.sessionId=${restartStateSessionId} != resumed ${expectedSessionId}`)
    if (restartOk && !hasCode(restartAnswerText)) reasons.push(`post-restart follow-up does not contain the restored code ${code}: ${JSON.stringify(String(restartAnswerText ?? '').slice(0, 120))}`)
  }
  if (interveningAnswer !== null && !String(interveningAnswer).includes('4')) {
    reasons.push(`intervening chat answer unexpected: ${JSON.stringify(String(interveningAnswer).slice(0, 80))}`)
  }
  if (reasons.length > 0) return { status: 'fail', reasons }
  if (!inProcessOk) return { status: 'partial', reasons: [`post-restart restore verified only; in-process resume refused (${inProcess?.code ?? 'unknown'})`] }
  if (!restartOk) return { status: 'partial', reasons: [`in-process resume verified only; post-restart path ${restart?.performed ? `refused (${restart.code ?? restart.status})` : 'not exercised'}`] }
  return { status: 'pass', reasons: [] }
}

/**
 * C1(c): first turn stopped, second ran once, no duplicate action. The counter
 * is ground truth; one in-flight click completing after the steer is not a
 * duplicate (delta <= 1), anything more is.
 */
export function checkSteerEvidence({ steered, turn1Aborted, turn2Ok, countAtSteer, finalCount, target }) {
  const reasons = []
  if (steered !== true) return { status: 'fail', reasons: ['steer was not accepted (steered!==true)'] }
  if (turn1Aborted !== true) reasons.push('first turn did not end stopped/aborted')
  if (turn2Ok !== true) reasons.push('second turn did not end ok')
  if (!Number.isFinite(countAtSteer) || !Number.isFinite(finalCount)) {
    reasons.push(`counter unreadable: atSteer=${countAtSteer} final=${finalCount}`)
  } else {
    if (finalCount < countAtSteer) reasons.push(`counter went backwards: ${countAtSteer} -> ${finalCount}`)
    if (finalCount > countAtSteer + 1) reasons.push(`duplicate/extra actions after steer: counter ${countAtSteer} -> ${finalCount}`)
    if (finalCount > target) reasons.push(`counter exceeded the original target ${target}: ${finalCount}`)
  }
  if (reasons.length > 0) return { status: 'fail', reasons }
  return { status: 'pass', reasons: [] }
}

/** C1(d): every cycle settled, no TURN_BUSY, every rotation revoked the old token. */
export function checkCyclesEvidence({ cycles, rotations, finalProbe }) {
  const reasons = []
  if (!Array.isArray(cycles) || cycles.length !== 20) return { status: 'fail', reasons: [`expected 20 cycles, got ${cycles?.length}`] }
  const busy = cycles.filter(cycle => cycle.busy === true)
  const stuck = cycles.filter(cycle => cycle.settled !== true)
  const orphaned = cycles.filter(cycle => cycle.nextAccepted !== true)
  if (busy.length > 0) reasons.push(`TURN_BUSY on ${busy.length} cycle(s): ${busy.map(c => c.index + 1).join(',')}`)
  if (stuck.length > 0) reasons.push(`turn did not settle on ${stuck.length} cycle(s): ${stuck.map(c => c.index + 1).join(',')}`)
  if (orphaned.length > 0) reasons.push(`next prompt not accepted (orphaned slot?) on cycle(s): ${orphaned.map(c => c.index + 1).join(',')}`)
  if (!Array.isArray(rotations) || rotations.length !== 4) reasons.push(`expected 4 token rotations, got ${rotations?.length}`)
  else {
    const bad = rotations.filter(rotation => rotation.oldRevoked !== true || rotation.newWorks !== true)
    if (bad.length > 0) reasons.push(`rotation failed at cycle(s): ${bad.map(r => r.afterCycle + 1).join(',')} (oldRevoked/newWorks)`)
  }
  if (finalProbe?.accepted !== true) reasons.push(`final post-stop probe not accepted: ${finalProbe?.error ?? 'missing'}`)
  if (reasons.length > 0) return { status: 'fail', reasons }
  return { status: 'pass', reasons: [] }
}

/**
 * C1(e): saved post-minimize images must be real page content. Pixel stats are
 * decoded through the harness's own page, never taken from a tool result.
 */
export function checkMinimizedEvidence({ minimizeOk, minimizeError, turnDone, images }) {
  if (minimizeOk !== true) return { status: 'blocked', reasons: [`could not minimize the window through CDP: ${minimizeError ?? 'unknown'}`] }
  const reasons = []
  if (turnDone !== true) reasons.push('turn did not complete while minimized')
  if (!Array.isArray(images) || images.length === 0) {
    reasons.push('no companion-saved screenshot after the minimize (model did not capture while minimized)')
    return { status: 'fail', reasons }
  }
  const real = images.filter(image => image.width >= 200 && image.height >= 100
    && image.redPixels >= 30 && image.nonWhiteFraction >= 0.005)
  if (real.length === 0) {
    reasons.push(`saved images are not real page content: ${JSON.stringify(images.map(({ width, height, redPixels, nonWhiteFraction }) => ({ width, height, redPixels, nonWhiteFraction: Math.round(nonWhiteFraction * 1000) / 1000 })))}`)
  }
  if (reasons.length > 0) return { status: 'fail', reasons }
  return { status: 'pass', reasons: [] }
}

// ---------------------------------------------------------------------------
// Self-test: mutation-check every checker without a model or a browser.
// ---------------------------------------------------------------------------

function selfTest() {
  const failures = []
  const expect = (label, verdict, want) => {
    const ok = verdict.status === want
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${verdict.status}${ok ? '' : ` (wanted ${want})`}\n`)
    if (!ok) failures.push(`${label}: got ${verdict.status}, wanted ${want}`)
  }
  const requested = { name: 'Grace Hopper', notes: 'Compiler pioneer' }
  const goodPage = {
    requested, expectedResult: 'result: name=Grace Hopper notes=Compiler pioneer pass=10chars',
    result: 'result: name=Grace Hopper notes=Compiler pioneer pass=10chars',
    name: 'Grace Hopper', notes: 'Compiler pioneer', submitEvents: 1,
    editor: '', rich: '', comment: '', selectable: 'SELECT-ME-ALPHA BETA GAMMA',
  }
  const goodDone = { planMode: true, planOutcome: 'reported-complete', planRevision: 2 }
  expect('plan good', checkPlanEvidence({ page: goodPage, chatDone: goodDone, turnEnd: { ok: true } }), 'pass')
  expect('plan wrong page', checkPlanEvidence({ page: { ...goodPage, submitEvents: 2 }, chatDone: goodDone, turnEnd: { ok: true } }), 'fail')
  expect('plan collateral edit', checkPlanEvidence({ page: { ...goodPage, editor: 'x' }, chatDone: goodDone, turnEnd: { ok: true } }), 'fail')
  expect('plan unfinished', checkPlanEvidence({ page: goodPage, chatDone: { ...goodDone, planOutcome: 'unfinished' }, turnEnd: { ok: true } }), 'partial')
  expect('plan no chat.done', checkPlanEvidence({ page: goodPage, chatDone: null, turnEnd: { ok: true } }), 'fail')
  expect('plan not armed', checkPlanEvidence({ page: goodPage, chatDone: { ...goodDone, planMode: false }, turnEnd: { ok: true } }), 'partial')

  const code = 'CX-4511-QZTR'
  const goodResume = {
    inProcess: { ok: true }, restart: { performed: true, ok: true },
    stateSessionId: 'session-a', restartStateSessionId: 'session-a', expectedSessionId: 'session-a',
    answerText: `The code is ${code}.`, restartAnswerText: code, code, interveningAnswer: '4',
  }
  expect('resume both paths', checkResumeEvidence(goodResume), 'pass')
  expect('resume in-process only', checkResumeEvidence({ ...goodResume, restart: { performed: false } }), 'partial')
  expect('resume restart-only', checkResumeEvidence({ ...goodResume, inProcess: { ok: false, code: 'SESSION_NOT_RESUMABLE' }, answerText: 'No code was given.' }), 'partial')
  expect('resume no code', checkResumeEvidence({ ...goodResume, answerText: 'I do not remember any code.' }), 'fail')
  expect('resume restart answer no code', checkResumeEvidence({ ...goodResume, restartAnswerText: 'I do not remember.' }), 'fail')
  expect('resume wrong session', checkResumeEvidence({ ...goodResume, stateSessionId: 'session-b' }), 'fail')
  expect('resume restart wrong session', checkResumeEvidence({ ...goodResume, restartStateSessionId: 'session-b' }), 'fail')
  expect('resume both refused', checkResumeEvidence({ ...goodResume, inProcess: { ok: false, code: 'SESSION_NOT_RESUMABLE' }, answerText: 'No code.', restart: { performed: true, ok: false, code: 'SESSION_NOT_RESUMABLE' } }), 'fail')
  expect('resume negative control leak', checkResumeEvidence({ ...goodResume, inProcess: { ok: false, code: 'SESSION_NOT_RESUMABLE' }, answerText: `The code is ${code}.` }), 'fail')
  expect('resume intervening wrong', checkResumeEvidence({ ...goodResume, interveningAnswer: '5' }), 'fail')

  const goodSteer = { steered: true, turn1Aborted: true, turn2Ok: true, countAtSteer: 4, finalCount: 4, target: 15 }
  expect('steer good', checkSteerEvidence(goodSteer), 'pass')
  expect('steer in-flight click', checkSteerEvidence({ ...goodSteer, finalCount: 5 }), 'pass')
  expect('steer duplicate actions', checkSteerEvidence({ ...goodSteer, finalCount: 7 }), 'fail')
  expect('steer first not stopped', checkSteerEvidence({ ...goodSteer, turn1Aborted: false }), 'fail')
  expect('steer second failed', checkSteerEvidence({ ...goodSteer, turn2Ok: false }), 'fail')
  expect('steer not accepted', checkSteerEvidence({ ...goodSteer, steered: false }), 'fail')

  const goodCycles = {
    cycles: Array.from({ length: 20 }, (_, index) => ({ index, busy: false, settled: true, nextAccepted: true })),
    rotations: [4, 9, 14, 19].map(afterCycle => ({ afterCycle, oldRevoked: true, newWorks: true })),
    finalProbe: { accepted: true },
  }
  expect('cycles good', checkCyclesEvidence(goodCycles), 'pass')
  expect('cycles busy', checkCyclesEvidence({ ...goodCycles, cycles: goodCycles.cycles.map((c, i) => i === 7 ? { ...c, busy: true } : c) }), 'fail')
  expect('cycles stuck', checkCyclesEvidence({ ...goodCycles, cycles: goodCycles.cycles.map((c, i) => i === 3 ? { ...c, settled: false } : c) }), 'fail')
  expect('cycles orphaned', checkCyclesEvidence({ ...goodCycles, cycles: goodCycles.cycles.map((c, i) => i === 11 ? { ...c, nextAccepted: false } : c) }), 'fail')
  expect('cycles rotation leak', checkCyclesEvidence({ ...goodCycles, rotations: goodCycles.rotations.map((r, i) => i === 2 ? { ...r, oldRevoked: false } : r) }), 'fail')
  expect('cycles final orphan', checkCyclesEvidence({ ...goodCycles, finalProbe: { accepted: false, error: 'TURN_BUSY' } }), 'fail')

  const goodImage = { name: 'x.jpg', width: 1280, height: 720, redPixels: 4200, nonWhiteFraction: 0.08 }
  const goodMin = { minimizeOk: true, turnDone: true, images: [goodImage] }
  expect('minimized good', checkMinimizedEvidence(goodMin), 'pass')
  expect('minimized blank', checkMinimizedEvidence({ ...goodMin, images: [{ ...goodImage, redPixels: 0, nonWhiteFraction: 0.0001 }] }), 'fail')
  expect('minimized white frame', checkMinimizedEvidence({ ...goodMin, images: [{ ...goodImage, redPixels: 2, nonWhiteFraction: 0.02 }] }), 'fail')
  expect('minimized no images', checkMinimizedEvidence({ ...goodMin, images: [] }), 'fail')
  expect('minimized turn failed', checkMinimizedEvidence({ ...goodMin, turnDone: false }), 'fail')
  expect('minimized blocked', checkMinimizedEvidence({ minimizeOk: false, minimizeError: 'windowState not supported', turnDone: true, images: [] }), 'blocked')

  if (failures.length > 0) {
    process.stdout.write(`\nself-test FAILED (${failures.length}):\n${failures.map(f => `  - ${f}`).join('\n')}\n`)
    return 1
  }
  process.stdout.write('\nself-test passed: every checker accepts its good evidence and rejects every mutation.\n')
  return 0
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

async function rawApi(remoteUrl, token, method, path, body) {
  const response = await fetch(`${remoteUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: response.status, ok: response.ok, json }
}

function lastChatDone(state, turnId) {
  const messages = Array.isArray(state?.messages) ? state.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === 'chat.done' && (turnId === undefined || message.turnId === turnId)) return message.body ?? null
  }
  return null
}

/** turn.end extras readTurnMetrics does not carry (plan outcome, aborted). */
function turnEndExtras(eventsPath, turnId) {
  const extras = { ok: null, aborted: null, planOutcome: null, planRevision: null }
  if (!existsSync(eventsPath)) return extras
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.includes(turnId) || !line.includes('"type":"turn.end"')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.turnId !== turnId || event.type !== 'turn.end') continue
    extras.ok = event.data?.ok ?? null
    extras.aborted = event.data?.aborted === true
    extras.planOutcome = typeof event.data?.planOutcome === 'string' ? event.data.planOutcome : null
    extras.planRevision = Number.isSafeInteger(event.data?.planRevision) ? event.data.planRevision : null
  }
  return extras
}

function metricsOf(eventsPath, turnId) {
  const metrics = readTurnMetrics(eventsPath, turnId)
  return {
    turnId,
    wallMs: metrics.logWallMs,
    steps: metrics.steps,
    toolCalls: metrics.toolCalls,
    failedCalls: metrics.failedCalls,
    retries: metrics.deadRetried + metrics.turnRetries,
    deadSteps: metrics.deadSteps,
    deadTurn: metrics.deadTurn,
    totalTokens: Number(metrics.usage?.totalTokens) || (Number(metrics.usage?.inputTokens) || 0) + (Number(metrics.usage?.outputTokens) || 0),
    finalText: metrics.finalText,
    reportedLabel: metrics.reportedLabel,
    toolCounts: metrics.toolCounts,
  }
}

async function waitSettled(remote, deadlineMs = 30_000) {
  return until('the turn slot to settle', async () => {
    const state = await remote.state()
    const status = String(state.turn?.status ?? '')
    return ['running', 'stopping', 'starting'].includes(status) ? null : state
  }, deadlineMs, 400)
}

async function newChatSettled(remote) {
  await waitSettled(remote, 60_000)
  try {
    await remote.newChat()
  } catch (error) {
    if (error.status !== 409) throw error
    await sleep(500)
    await remote.newChat()
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const PLAN_REQUESTED = { name: 'Grace Hopper', notes: 'Compiler pioneer', pass: 'cobol-demo' }
const PLAN_EXPECTED_RESULT = `result: name=${PLAN_REQUESTED.name} notes=${PLAN_REQUESTED.notes} pass=${PLAN_REQUESTED.pass.length}chars`

async function readFormState(page) {
  return page.evaluate(`(() => {
    const value = id => document.getElementById(id)?.value ?? null
    const text = id => document.getElementById(id)?.textContent ?? null
    const lines = String(text('events') ?? '').split('\\n')
    const counts = {}
    for (const part of (lines[0] ?? '').replace('events ', '').split(' ')) {
      const [key, raw] = part.split('=')
      counts[key] = Number(raw)
    }
    return {
      name: value('name'), notes: value('notes'), result: text('result'),
      submitEvents: counts.submit ?? null,
      editor: value('editor'), rich: text('rich'), comment: text('comment-edit'),
      selectable: text('selectable'),
    }
  })()`)
}

async function runPlanCheck(runtime) {
  const { remote, page, eventsPath, budget } = runtime
  await newChatSettled(remote)
  await page.reset('form.html')
  const prompt = 'Plan this task first, then carry it out: fill the form on this page — name "Grace Hopper", notes "Compiler pioneer", password "cobol-demo" — and submit it exactly once. Leave every other field and control on the page alone.'
  const accepted = await runtime.sendPaced(prompt, { planMode: true })
  const state = await waitForTurn({ remote, turnId: accepted.turnId, deadline: Date.now() + 150_000 })
  await waitForTurnEndInLog(eventsPath, accepted.turnId)
  const chatDone = lastChatDone(state, accepted.turnId)
  const turnEnd = turnEndExtras(eventsPath, accepted.turnId)
  const form = await readFormState(page)
  const evidence = {
    page: { ...form, requested: PLAN_REQUESTED, expectedResult: PLAN_EXPECTED_RESULT },
    chatDone: chatDone === null ? null : { planMode: chatDone.planMode, planOutcome: chatDone.planOutcome, planRevision: chatDone.planRevision, label: chatDone.label },
    turnEnd,
  }
  const verdict = checkPlanEvidence(evidence)
  const metrics = [metricsOf(eventsPath, accepted.turnId)]
  budget.spend(metrics)
  return { verdict, evidence, metrics, attempts: 1 }
}

async function runResumeCheck(runtime) {
  const { page, budget, remoteUrl } = runtime
  const code = `CX-${Math.floor(1000 + Math.random() * 9000)}-${Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`
  await newChatSettled(runtime.remote)
  await page.reset('click.html')
  // Chat A: store the code in conversation context only (never on the page).
  const a = await runtime.sendPaced(`Remember this verification code: ${code}. Reply with OK only.`)
  const stateA = await waitForTurn({ remote: runtime.remote, turnId: a.turnId, deadline: Date.now() + 90_000 })
  await waitForTurnEndInLog(runtime.eventsPath, a.turnId)
  const sessionIdA = stateA.sessionId
  const metricsA = metricsOf(runtime.eventsPath, a.turnId)
  // Chat B: an unrelated turn proves the next answer is not just the live chat.
  await newChatSettled(runtime.remote)
  const b = await runtime.sendPaced('What is 2+2? Reply with the number only.')
  const stateB = await waitForTurn({ remote: runtime.remote, turnId: b.turnId, deadline: Date.now() + 90_000 })
  await waitForTurnEndInLog(runtime.eventsPath, b.turnId)
  const interveningAnswer = lastChatDone(stateB, b.turnId)?.text ?? null
  const metricsB = metricsOf(runtime.eventsPath, b.turnId)
  // Path 1: in-process resume through the same endpoint a phone uses. The hub
  // projection can settle a moment before the controller's running/
  // sessionChanging flags clear, so a retryable 409 is waited out like a real
  // client does. Since task-16 (6276261) an owned target is restored via an
  // internal runtime restart (~1-3 s warm boot) inside the resume call; the
  // 30 s request timeout tolerates it.
  const attemptResume = async () => {
    let response = null
    let attempts = 0
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await waitSettled(runtime.remote, 30_000)
      attempts += 1
      response = await rawApi(remoteUrl, runtime.token(), 'POST', `/sessions/${sessionIdA}/resume`, { clientCommandId: randomUUID() })
      // Success body is {clientCommandId, sessionId, instanceId} — verify the
      // resumed session id, not an ok flag the endpoint does not send.
      if (response.ok && response.json?.sessionId === sessionIdA) break
      const code409 = response.json?.error?.code ?? ''
      if (response.status !== 409 || !['TURN_BUSY', 'TURN_STOPPING', 'SESSION_CHANGING', 'RUNTIME_NOT_READY'].includes(code409)) break
      await sleep(600)
    }
    return { ok: response.ok && response.json?.sessionId === sessionIdA, status: response.status, code: response.json?.error?.code ?? null, attempts, resumedSessionId: response.json?.sessionId ?? null }
  }
  const followUp = async () => {
    await sleep(700)
    const stateResumed = await runtime.remote.state()
    const turn = await runtime.sendPaced('What verification code did I ask you to remember? Reply with the code only.')
    const stateDone = await waitForTurn({ remote: runtime.remote, turnId: turn.turnId, deadline: Date.now() + 90_000 })
    await waitForTurnEndInLog(runtime.eventsPath, turn.turnId)
    return {
      stateSessionId: stateResumed.sessionId,
      finalSessionId: stateDone.sessionId,
      answerText: lastChatDone(stateDone, turn.turnId)?.text ?? null,
      metrics: metricsOf(runtime.eventsPath, turn.turnId),
    }
  }
  const inProcess = await attemptResume()
  // If in-process resume failed, this follow-up runs in the WRONG chat and is
  // the negative control: the code must not appear without a restore.
  const first = await followUp()
  // Path 2: the post-restart restore, exercised UNCONDITIONALLY (task-16
  // proof gate: both paths must pass). Restart ONLY the isolated companion
  // (same home, same ports); the SDK loads chat A from persistence.
  await runtime.restartCompanion()
  const second = await attemptResume()
  const restart = { performed: true, ok: second.ok, status: second.status, code: second.code, attempts: second.attempts, resumedSessionId: second.resumedSessionId }
  const afterRestart = await followUp()
  const evidence = {
    code,
    inProcess,
    restart,
    expectedSessionId: sessionIdA,
    stateSessionId: first.stateSessionId,
    finalSessionId: first.finalSessionId,
    restartStateSessionId: afterRestart.stateSessionId,
    restartFinalSessionId: afterRestart.finalSessionId,
    interveningAnswer,
    answerText: first.answerText,
    restartAnswerText: afterRestart.answerText,
  }
  const verdict = checkResumeEvidence(evidence)
  const metrics = [metricsA, metricsB, first.metrics, afterRestart.metrics]
  budget.spend(metrics)
  return { verdict, evidence, metrics, attempts: 1 }
}

const STEER_TARGET = 15

async function runSteerCheck(runtime) {
  const { remote, page, eventsPath, budget } = runtime
  const readCount = () => page.evaluate(`Number(document.getElementById('count')?.textContent ?? NaN)`)
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await newChatSettled(remote)
    await page.reset('click.html')
    const first = await runtime.sendPaced(`Click the Increment button on this page ${STEER_TARGET} times, one click per step, then tell me the final count.`)
    // Steer once the turn is visibly acting (counter >= 3) but still running.
    let countAtSteer = null
    let steerResponse = null
    let tooLate = false
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const state = await remote.state()
      const active = state.turn?.turnId === first.turnId && ['running', 'starting'].includes(String(state.turn?.status))
      const count = await readCount().catch(() => NaN)
      if (active && Number.isFinite(count) && count >= 3) {
        countAtSteer = count
        steerResponse = await runtime.sendPaced('Stop clicking now. Do not click anything else. Tell me the current count shown on the page.', { steer: true })
        break
      }
      if (!active && state.turn?.turnId === first.turnId && !['running', 'stopping', 'starting'].includes(String(state.turn?.status))) {
        tooLate = true
        break
      }
      await sleep(400)
    }
    if (tooLate || steerResponse === null) {
      // The turn finished before a steer could land (e.g. batched clicks).
      await waitForTurn({ remote, turnId: first.turnId, deadline: Date.now() + 60_000 }).catch(() => null)
      await waitForTurnEndInLog(eventsPath, first.turnId)
      budget.spend([metricsOf(eventsPath, first.turnId)])
      if (attempt === 1) continue
      return {
        verdict: { status: 'blocked', reasons: ['turn completed before a mid-turn steer could land (2 attempts)'] },
        evidence: { tooLate: true, attempts: attempt }, metrics: [], attempts: attempt,
      }
    }
    // Wait for the first turn to tear down and the steering turn to run once.
    const secondTurnId = steerResponse.turnId
    await until('the steering turn to become the active turn', async () => {
      const state = await remote.state()
      return state.turn?.turnId === secondTurnId ? state : null
    }, 60_000, 200)
    const secondState = await waitForTurn({ remote, turnId: secondTurnId, deadline: Date.now() + 120_000 })
    await waitForTurnEndInLog(eventsPath, first.turnId)
    await waitForTurnEndInLog(eventsPath, secondTurnId)
    const finalCount = await readCount().catch(() => NaN)
    const firstEnd = turnEndExtras(eventsPath, first.turnId)
    const secondEnd = turnEndExtras(eventsPath, secondTurnId)
    const secondMetrics = metricsOf(eventsPath, secondTurnId)
    const evidence = {
      steered: steerResponse.steered === true,
      firstTurnId: first.turnId,
      secondTurnId,
      turn1Aborted: firstEnd.aborted === true,
      turn1Ok: firstEnd.ok,
      turn2Ok: secondEnd.ok === true,
      countAtSteer,
      finalCount,
      target: STEER_TARGET,
      secondTurnClickCalls: secondMetrics.toolCounts?.browser_click ?? 0,
      secondTurnBatchCalls: secondMetrics.toolCounts?.browser_batch ?? 0,
      secondAnswer: secondMetrics.finalText,
      secondStateOutcome: secondState.turn?.outcome ?? null,
    }
    const verdict = checkSteerEvidence(evidence)
    const metrics = [metricsOf(eventsPath, first.turnId), secondMetrics]
    budget.spend(metrics)
    return { verdict, evidence, metrics, attempts: attempt }
  }
  return { verdict: { status: 'blocked', reasons: ['steer check exhausted attempts'] }, evidence: {}, metrics: [], attempts: 2 }
}

async function runCyclesCheck(runtime) {
  const { page, eventsPath, budget, dshHome } = runtime
  let remote = runtime.remote
  const cycles = []
  const rotations = []
  const readToken = () => readFileSync(join(dshHome, 'browser-agent', 'remote-token'), 'utf8').trim()
  for (let index = 0; index < 20; index += 1) {
    await page.reset('click.html').catch(() => {})
    // One prompt per cycle: this cycle's clean newChat+send IS the proof that
    // the previous cycle's stop left no orphaned slot. Sends are paced under
    // the remote API's 30-prompts/minute WindowLimiter (sendPaced).
    const cycle = { index, busy: false, settled: false, nextAccepted: false, settleMs: null }
    try {
      await waitSettled(remote, 30_000)
      await remote.newChat()
      const accepted = await runtime.sendPaced('Click the Increment button on this page 10 times, one click per step, then tell me the count.')
      cycle.nextAccepted = true
      await sleep(1_200)
      const stopAt = Date.now()
      await remote.stop()
      const settledState = await waitSettled(remote, 20_000)
      cycle.settleMs = Date.now() - stopAt
      cycle.settled = true
      cycle.stoppedStatus = settledState.turn?.status ?? null
      cycle.stoppedOutcome = settledState.turn?.outcome ?? null
      await waitForTurnEndInLog(eventsPath, accepted.turnId).catch(() => {})
      budget.spend([metricsOf(eventsPath, accepted.turnId)])
    } catch (error) {
      const code = String(error.body?.error?.code ?? '')
      cycle.error = `${code || error.message}`.slice(0, 200)
      cycle.busy = code.includes('TURN_BUSY') || code.includes('TURN_STOPPING')
    }
    cycles.push(cycle)
    process.stdout.write(`  cycle ${index + 1}/20: accepted=${cycle.nextAccepted} settled=${cycle.settled}${cycle.busy ? ' BUSY' : ''}${cycle.error ? ` error=${cycle.error}` : ''}\n`)
    // Live token rotation after every 5th cycle: the one-shot CLI writes a new
    // credential; the running companion re-reads the file within ~2 s.
    if ((index + 1) % 5 === 0) {
      const oldToken = runtime.token()
      const rotation = { afterCycle: index, oldRevoked: false, newWorks: false }
      const oneShot = spawn(process.execPath, [COMPANION_ENTRY, '--dsh-home', dshHome, '--new-remote-token'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      oneShot.stderr.on('data', chunk => { stderr += chunk })
      const exitCode = await new Promise(resolveExit => { oneShot.once('exit', code => resolveExit(code)); oneShot.once('error', () => resolveExit(1)) })
      rotation.oneShotExit = exitCode
      if (exitCode === 0) {
        const newToken = readToken()
        rotation.tokenChanged = newToken !== oldToken
        // Old token must be revoked (poll past the 2 s re-read interval).
        const revoked = await until('the old token to be revoked', async () => {
          const response = await rawApi(runtime.remoteUrl, oldToken, 'GET', '/state')
          return response.status === 401 ? true : null
        }, 8_000, 400).catch(() => false)
        rotation.oldRevoked = revoked === true
        const fresh = await rawApi(runtime.remoteUrl, newToken, 'GET', '/state')
        rotation.newWorks = fresh.ok
        runtime.setToken(newToken)
        remote = runtime.rebuildRemote()
      } else {
        rotation.error = stderr.slice(0, 200)
      }
      rotations.push(rotation)
      process.stdout.write(`  rotation after cycle ${index + 1}: oldRevoked=${rotation.oldRevoked} newWorks=${rotation.newWorks}\n`)
    }
  }
  // Final orphan probe: after the last stop (and rotation), a fresh chat and
  // prompt must still be accepted and run — no slot left behind by 20 cycles.
  const finalProbe = { accepted: false }
  try {
    await waitSettled(remote, 30_000)
    await remote.newChat()
    const probe = await runtime.sendPaced('Reply with OK only.')
    finalProbe.accepted = true
    const probeState = await waitForTurn({ remote, turnId: probe.turnId, deadline: Date.now() + 60_000 })
    finalProbe.outcome = probeState.turn?.outcome ?? null
    await waitForTurnEndInLog(eventsPath, probe.turnId).catch(() => {})
    budget.spend([metricsOf(eventsPath, probe.turnId)])
  } catch (error) {
    finalProbe.error = String(error.body?.error?.code ?? error.message).slice(0, 200)
  }
  process.stdout.write(`  final probe: accepted=${finalProbe.accepted}${finalProbe.error ? ` error=${finalProbe.error}` : ''}\n`)
  const verdict = checkCyclesEvidence({ cycles, rotations, finalProbe })
  return { verdict, evidence: { cycles, rotations, finalProbe, rateLimitRetries: runtime.rateLimitRetries() }, metrics: [], attempts: 1 }
}

/** Decode a saved image through the harness's own page (independent pixels). */
async function decodeImageInPage(page, bytes, mimeType) {
  const base64 = bytes.toString('base64')
  return page.evaluate(`(async () => {
    const img = new Image();
    await new Promise((resolveLoad, rejectLoad) => { img.onload = resolveLoad; img.onerror = () => rejectLoad(new Error('image decode failed')); img.src = 'data:${mimeType};base64,${base64}'; });
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0, nonWhite = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      n += 1;
      if (r > 180 && g < 90 && b < 110) red += 1;
      if (r < 245 || g < 245 || b < 245) nonWhite += 1;
    }
    return { width: img.width, height: img.height, redPixels: red, nonWhiteFraction: nonWhite / n, sampled: n };
  })()`)
}

async function runMinimizedCheck(runtime) {
  const { page, eventsPath, budget, edge, downloadsDir } = runtime
  // This check needs the HEADED Edge the runtime swapped in before calling it.
  await newChatSettled(runtime.remote)
  await page.reset('canvas.html')
  // Create the ground-truth signature with the harness's OWN trusted CDP
  // click (the canvas draws red #e11d48 dots only after a trusted click).
  // The model then only has to capture: any saved post-minimize image must
  // show this dot — real page content, independent of what the model does.
  const connection = await page.ensure()
  const center = await page.evaluate(`(() => {
    const rect = document.getElementById('board').getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 })
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1 })
  await sleep(300)
  const setupState = await page.evaluate(`document.getElementById('state')?.textContent ?? ''`)
  if (!String(setupState).includes('trusted 1')) {
    return {
      verdict: { status: 'blocked', reasons: [`harness setup click did not register on the canvas: ${JSON.stringify(setupState)}`] },
      evidence: { setupState, headed: true }, metrics: [], attempts: 1,
    }
  }
  const accepted = await runtime.sendPaced('Take a screenshot of this page and describe the colors and shapes you see in it.')
  await sleep(1_500)
  let minimizeOk = false
  let minimizeError = null
  let windowId = null
  const minimizeAt = Date.now()
  try {
    await page.ensure()
    const targets = await listTargets(edge.cdpHttp)
    const current = targets.find(item => item.type === 'page' && item.id === page.targetId)
    if (!current) throw new Error('fixture page target not found')
    const window = await edge.browser.send('Browser.getWindowForTarget', { targetId: current.id })
    windowId = window.windowId
    await edge.browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    minimizeOk = true
  } catch (error) {
    minimizeError = String(error.message).slice(0, 200)
  }
  let state = null
  try {
    state = await waitForTurn({ remote: runtime.remote, turnId: accepted.turnId, deadline: Date.now() + 150_000 })
  } finally {
    if (windowId !== null) {
      await edge.browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
    }
  }
  await waitForTurnEndInLog(eventsPath, accepted.turnId)
  const turnDone = state?.turn?.outcome === 'done'
  // Companion-saved screenshots for THIS turn, written after the minimize.
  const screenshotsDir = join(dirname(eventsPath), 'screenshots')
  const images = []
  if (minimizeOk && existsSync(screenshotsDir)) {
    const candidates = readdirSync(screenshotsDir)
      .filter(name => name.startsWith(accepted.turnId))
      .map(name => ({ name, mtimeMs: statSync(join(screenshotsDir, name)).mtimeMs }))
      .filter(entry => entry.mtimeMs >= minimizeAt - 500)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, 3)
    for (const entry of candidates) {
      const bytes = readFileSync(join(screenshotsDir, entry.name))
      const mimeType = entry.name.endsWith('.png') ? 'image/png' : 'image/jpeg'
      try {
        const stats = await decodeImageInPage(page, bytes, mimeType)
        images.push({ name: entry.name, bytes: bytes.length, ...stats })
      } catch (error) {
        images.push({ name: entry.name, bytes: bytes.length, decodeError: String(error.message).slice(0, 120), width: 0, height: 0, redPixels: 0, nonWhiteFraction: 0 })
      }
    }
  }
  const evidence = { minimizeOk, minimizeError, minimizeAt: new Date(minimizeAt).toISOString(), turnDone, images, setupState, headed: true }
  const verdict = checkMinimizedEvidence(evidence)
  const metrics = [metricsOf(eventsPath, accepted.turnId)]
  budget.spend(metrics)
  return { verdict, evidence, metrics, attempts: 1 }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const options = { checks: [], selfTest: false, dshHome: null, maxTotalTokens: 6_000_000, json: null, label: null, keep: false, verbose: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${token} needs a value`)
      return next
    }
    if (token === '--check') options.checks.push(value())
    else if (token === '--self-test') options.selfTest = true
    else if (token === '--dsh-home') options.dshHome = value()
    else if (token === '--max-total-tokens') options.maxTotalTokens = Number(value())
    else if (token === '--json') options.json = value()
    else if (token === '--label') options.label = value()
    else if (token === '--keep') options.keep = true
    else if (token === '--verbose') options.verbose = true
    else if (token === '--help' || token === '-h') options.help = true
    else throw new Error(`unknown flag ${token}`)
  }
  const requested = options.checks.length === 0 || options.checks.includes('all') ? CHECK_NAMES : options.checks
  for (const name of requested) {
    if (!CHECK_NAMES.includes(name)) throw new Error(`unknown check: ${name} (available: ${CHECK_NAMES.join(', ')})`)
  }
  options.checks = requested
  if (!Number.isFinite(options.maxTotalTokens) || options.maxTotalTokens < 0) throw new Error('--max-total-tokens must be >= 0')
  return options
}

function printHelp() {
  process.stdout.write(`crazyAgent C1 acceptance (Q6) — real runtime, no accounts

  node scripts/c1-acceptance.mjs --self-test
  CRAZYAGENT_API_KEY=... node scripts/c1-acceptance.mjs [--check <name>]...

Checks: ${CHECK_NAMES.join(', ')} (default all; minimized runs last on a HEADED Edge)
  --dsh-home <path>        isolated home (default ${DEFAULT_C1_HOME})
  --max-total-tokens <n>   hard stop (default 6000000)
  --json <path>            batch JSON (default e2e/baselines/<ts>-c1-acceptance.json)
  --label <name>           filename label
  --keep                   keep the scratch dir
  --verbose                companion/Edge diagnostics
Model fixed: ${DEFAULT_MODEL} @ ${DEFAULT_EFFORT}. Key only from CRAZYAGENT_API_KEY.
`)
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return 0
  }
  if (options.selfTest) return selfTest()
  const apiKey = (process.env.CRAZYAGENT_API_KEY ?? '').trim()
  if (apiKey.length === 0) throw new Error('CRAZYAGENT_API_KEY is not set. Export the model key in the environment (the harness never reads the key file).')

  const dshHome = resolve(options.dshHome ?? DEFAULT_C1_HOME)
  await prepareDshHome(dshHome, false)
  const runRoot = mkdtempSync(join(tmpdir(), 'ca-c1-'))
  const downloadsDir = join(runRoot, 'Downloads')
  mkdirSync(downloadsDir, { recursive: true })
  const startedAt = nowIso()
  const results = []
  let totalTokens = 0
  let stopReason = null
  const outputPath = options.json ?? join(BASELINES_DIR, `${new Date().toISOString().replace(/[:.]/gu, '-')}${options.label ? `-${options.label}` : '-c1-acceptance'}.json`)
  const buildBatch = () => ({
    startedAt,
    finishedAt: nowIso(),
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    dshHome,
    maxTotalTokens: options.maxTotalTokens,
    totalTokens,
    stopReason,
    checks: results,
  })
  const writeBatch = () => {
    try {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, `${JSON.stringify(buildBatch(), null, 2)}\n`)
    } catch (error) {
      process.stderr.write(`c1-acceptance: could not write ${outputPath}: ${error.message}\n`)
    }
  }
  const budget = {
    spend(metrics) {
      for (const metric of metrics) totalTokens += metric.totalTokens ?? 0
      if (options.maxTotalTokens > 0 && totalTokens >= options.maxTotalTokens) {
        stopReason = `stopped by --max-total-tokens (${totalTokens} >= ${options.maxTotalTokens})`
      }
    },
  }

  let fixtureServer = null
  let companion = null
  let edge = null
  let edgeHeaded = false
  let page = null
  let remote = null
  let currentToken = null
  const logsRoot = join(dshHome, 'browser-agent', 'logs')
  let eventsPath = null
  const runtime = {
    dshHome,
    downloadsDir,
    get remote() { return remote },
    get page() { return page },
    get edge() { return edge },
    eventsPath: null,
    remoteUrl: null,
    token: () => currentToken,
    setToken: token => { currentToken = token },
    rebuildRemote: () => {
      remote = makeRemoteLocal(runtime.remoteUrl, currentToken)
      return remote
    },
    budget,
  }
  // Local authenticated client (makeRemote's token is fixed at construction;
  // the cycles check rotates it live).
  function makeRemoteLocal(remoteUrl, token) {
    const request = async (method, path, body) => {
      const response = await rawApi(remoteUrl, token, method, path, body)
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.json?.error?.message ?? response.json?.error?.code ?? JSON.stringify(response.json ?? {}).slice(0, 200)}`)
        error.status = response.status
        error.body = response.json
        throw error
      }
      return response.json
    }
    return {
      state: () => request('GET', '/state'),
      newChat: () => request('POST', '/new', { clientCommandId: randomUUID() }),
      send: (text, extra = {}) => request('POST', '/messages', { clientMessageId: randomUUID(), text, ...extra }),
      stop: () => request('POST', '/stop', { clientCommandId: randomUUID() }),
    }
  }

  // The remote API limits prompts to 30 per fixed 60 s window
  // (WindowLimiter). Pace every send >= 2.2 s apart and back off on 429 so
  // the acceptance measures turn-slot integrity, not the rate limiter.
  let lastSendAt = 0
  let rateLimitRetries = 0
  async function sendPaced(text, extra = {}) {
    const wait = lastSendAt + 2_200 - Date.now()
    if (wait > 0) await sleep(wait)
    for (let attempt = 0; ; attempt += 1) {
      lastSendAt = Date.now()
      try {
        return await remote.send(text, extra)
      } catch (error) {
        if (error.status === 429 && attempt < 3) {
          rateLimitRetries += 1
          process.stdout.write(`  rate-limited (429); waiting 20s before retry ${attempt + 1}\n`)
          await sleep(20_000)
          continue
        }
        throw error
      }
    }
  }
  runtime.sendPaced = sendPaced
  runtime.rateLimitRetries = () => rateLimitRetries

  const startIsolatedEdge = async headed => {
    const profileDir = join(runRoot, headed ? 'edge-profile-headed' : 'edge-profile')
    mkdirSync(join(profileDir, 'Default'), { recursive: true })
    // Edge 157: the profile preference, not the CDP override, confines
    // chrome.downloads API downloads (see model-eval / run-e2e-gates).
    writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({
      download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true },
      savefile: { default_directory: downloadsDir },
    }))
    const started = await startEdge({
      profileDir,
      cdpPort: await freePort(),
      initialUrl: `${fixtureServer.baseUrl}/click.html`,
      headed,
      loadExtension: true,
      verbose: options.verbose,
    })
    await routeDownloads(started, downloadsDir)
    await injectExtensionSettings({ edge: started, bridgeUrl: companion.bridgeUrl, token: companion.bridgeToken, verbose: options.verbose })
    return started
  }

  try {
    fixtureServer = await startFixtureServer()
    const bridgePort = await freePort()
    const remotePort = await freePort()
    companion = await startCompanion({
      dshHome, bridgePort, remotePort,
      model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, apiKey,
      logPath: join(runRoot, 'companion.log'),
      downloadsDir,
      confirmIrreversible: false,
    })
    currentToken = companion.token
    runtime.remoteUrl = companion.remoteUrl
    remote = makeRemoteLocal(companion.remoteUrl, currentToken)
    edge = await startIsolatedEdge(false)
    await waitForRemoteReady({ remote, bridgePort, companion })
    await until('the companion run log', () => {
      const candidate = resolveRunEvents(logsRoot, null)
      return candidate !== null && existsSync(candidate) ? candidate : null
    }, 20_000)
    eventsPath = resolveRunEvents(logsRoot, null)
    runtime.eventsPath = eventsPath
    page = new PageController({ edge, fixtureBaseUrl: fixtureServer.baseUrl })
    await page.ensure()
    // The resume check's second path: restart ONLY this isolated companion on
    // the same ports/home so the SDK loads the saved session from persistence
    // instead of owning it live. The Edge worker reconnects to the unchanged
    // bridge URL/token; the new companion writes a new run dir, so eventsPath
    // is re-resolved for post-restart telemetry.
    runtime.restartCompanion = async () => {
      await companion.stop()
      companion = await startCompanion({
        dshHome, bridgePort, remotePort,
        model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, apiKey,
        logPath: join(runRoot, 'companion-restart.log'),
        downloadsDir,
        confirmIrreversible: false,
      })
      currentToken = companion.token
      runtime.remoteUrl = companion.remoteUrl
      remote = makeRemoteLocal(companion.remoteUrl, currentToken)
      await waitForRemoteReady({ remote, bridgePort, companion })
      eventsPath = resolveRunEvents(logsRoot, null)
      runtime.eventsPath = eventsPath
      process.stdout.write('  isolated companion restarted for the post-restart resume path\n')
    }
    process.stdout.write(`c1-acceptance: ${DEFAULT_MODEL} @ ${DEFAULT_EFFORT} · checks: ${options.checks.join(', ')}\nisolated home: ${dshHome}\nscratch: ${runRoot}\n\n`)

    for (const name of options.checks) {
      if (stopReason !== null) {
        results.push({ name, status: 'blocked', reasons: [stopReason], evidence: null, metrics: [], attempts: 0 })
        continue
      }
      if (name === 'minimized' && !edgeHeaded) {
        // Swap to a headed Edge: only one executor may be connected at a time.
        process.stdout.write('swapping to a HEADED isolated Edge for the minimized check\n')
        page.close()
        await edge.stop()
        edge = await startIsolatedEdge(true)
        edgeHeaded = true
        await waitForRemoteReady({ remote, bridgePort, companion })
        page = new PageController({ edge, fixtureBaseUrl: fixtureServer.baseUrl })
        await page.ensure()
      }
      process.stdout.write(`CHECK ${name}\n`)
      const started = Date.now()
      let outcome
      try {
        const runner = { plan: runPlanCheck, resume: runResumeCheck, steer: runSteerCheck, cycles: runCyclesCheck, minimized: runMinimizedCheck }[name]
        outcome = await runner(runtime)
      } catch (error) {
        outcome = { verdict: { status: 'fail', reasons: [`check threw: ${error.message}`] }, evidence: { error: String(error.stack ?? error.message).slice(0, 600) }, metrics: [], attempts: 1 }
      }
      const record = {
        name,
        status: outcome.verdict.status,
        reasons: outcome.verdict.reasons,
        evidence: outcome.evidence,
        metrics: outcome.metrics,
        attempts: outcome.attempts,
        wallMs: Date.now() - started,
        finishedAt: nowIso(),
      }
      results.push(record)
      const totals = outcome.metrics.reduce((sum, metric) => ({
        steps: sum.steps + (metric.steps ?? 0),
        calls: sum.calls + (metric.toolCalls ?? 0),
        failed: sum.failed + (metric.failedCalls ?? 0),
        retries: sum.retries + (metric.retries ?? 0),
        tokens: sum.tokens + (metric.totalTokens ?? 0),
      }), { steps: 0, calls: 0, failed: 0, retries: 0, tokens: 0 })
      process.stdout.write(`${record.status.toUpperCase()} ${name}: ${record.reasons.join('; ') || 'clean'} · ${(record.wallMs / 1000).toFixed(1)}s · steps ${totals.steps} · calls ${totals.calls} · failed ${totals.failed} · retries ${totals.retries} · tokens ${totals.tokens}\n\n`)
      writeBatch()
    }
  } finally {
    writeBatch()
    page?.close()
    await edge?.stop().catch(() => {})
    await companion?.stop().catch(() => {})
    await fixtureServer?.close().catch(() => {})
    if (!options.keep) {
      const resolved = resolve(runRoot)
      if (resolved.startsWith(`${resolve(tmpdir())}${sep}`)) rmSync(resolved, { recursive: true, force: true })
    } else {
      process.stdout.write(`kept scratch: ${runRoot}\n`)
    }
  }

  process.stdout.write('== C1 acceptance summary ==\n')
  for (const record of results) {
    process.stdout.write(`${record.name.padEnd(12)} ${record.status.toUpperCase().padEnd(8)} ${record.reasons.join('; ').slice(0, 110)}\n`)
  }
  process.stdout.write(`\ntotal tokens: ${totalTokens}\nbatch JSON: ${outputPath}\n`)
  const failed = results.filter(record => record.status === 'fail').length
  return failed > 0 ? 1 : 0
}

main()
  .then(code => { process.exitCode = code })
  .catch(error => {
    process.stderr.write(`c1-acceptance: ${error.message}\n`)
    if (error.stack && process.env.C1_DEBUG === '1') process.stderr.write(`${error.stack}\n`)
    process.exitCode = 1
  })
