#!/usr/bin/env node
/**
 * watcher-eval.mjs — the M4 offline replay gate (MARATHON-PLAN.md §5 M4).
 *
 * CHEAPEST GATE FIRST: rebuilds watch ledgers from archived events.jsonl turn
 * logs (no browser, no DSH runner), cuts labelled windows (fine / stuck), and
 * scores the REAL judge (configured agent model at low reasoning effort,
 * ≤400 output tokens per call) running inside the real Watcher under a fake
 * clock. The events.jsonl→ledger adapter lives here; the ledger is NOT weakened
 * to fit the logs.
 *
 * Gate: zero alerts on fine windows; ≥80% of stuck windows flagged within two
 * judge checks. With zero observed false alerts in N fine windows the true rate
 * is only bounded near 3/N — that caveat is recorded with the result.
 *
 * The API key is loaded from the environment (CRAZYAGENT_API_KEY) or the
 * companion's .dsh-home/browser-agent/api-key file at launch, passed to the
 * judge through an injected getter, and NEVER printed or written to results.
 *
 * Usage:
 *   node scripts/watcher-eval.mjs --dry-run          # fake judge, no spend
 *   node scripts/watcher-eval.mjs                    # real judge calls
 *   node scripts/watcher-eval.mjs --only m0-stall-r4 # one window
 *   node scripts/watcher-eval.mjs --out path.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WatchLedger } from '../companion/watch-ledger.mjs'
import { Watcher, WATCH_JUDGE_LIMITS } from '../companion/watcher.mjs'
import { createWatchJudge } from '../companion/watch-judge.mjs'
import { DEFAULT_BASE_URL, RECOMMENDED_MODEL_ID } from '../companion/openrouter.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ARCHIVE_ROOT = join(ROOT, '.dsh-home/browser-agent/logs/m0-archive')
const TICK_MS = 20_000

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { dryRun: false, only: null, out: null, archive: ARCHIVE_ROOT, tickMs: TICK_MS }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--only') args.only = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--archive') args.archive = argv[++i]
    else if (a === '--tick-ms') args.tickMs = Number(argv[++i])
  }
  return args
}

/** Load the key into the environment at launch; never print or persist it. */
function loadKey() {
  if (process.env.CRAZYAGENT_API_KEY && process.env.CRAZYAGENT_API_KEY.trim().length > 0) return process.env.CRAZYAGENT_API_KEY.trim()
  const keyFile = join(ROOT, '.dsh-home/browser-agent/api-key')
  if (existsSync(keyFile)) {
    const key = readFileSync(keyFile, 'utf8').trim()
    if (key.length > 0) { process.env.CRAZYAGENT_API_KEY = key; return key }
  }
  return null
}

function loadConfig() {
  const llmPath = join(ROOT, '.dsh-home/browser-agent/llm.json')
  if (existsSync(llmPath)) {
    try {
      const parsed = JSON.parse(readFileSync(llmPath, 'utf8'))
      if (parsed?.model?.id) return { baseUrl: parsed.baseUrl ?? DEFAULT_BASE_URL, model: parsed.model }
    } catch { /* fall through */ }
  }
  return { baseUrl: DEFAULT_BASE_URL, model: { id: RECOMMENDED_MODEL_ID, reasoning: true } }
}

/* ------------------------------------------------------------------ */
/* events.jsonl → ledger adapter                                       */
/* ------------------------------------------------------------------ */

function parseArchive(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/**
 * Rebuild one turn's ledger frames from its archived events. Faithful to the
 * live feed: tool.call/tool.result → chat.tool_call/chat.tool_result;
 * assistant.text → chat.assistant; plan.updated → chat.activity{plan};
 * step/start → model-start; assistant/message reasoning blocks → reasoning.
 * Timestamps are wall-clock offsets from turn.start (the ledger's monotonic
 * clock is injected as elapsed ms).
 */
function extractTurns(events) {
  const starts = events.filter(e => e.type === 'turn.start')
  const turns = []
  for (const start of starts) {
    const turnId = start.turnId
    const startMs = Date.parse(start.time)
    const end = events.find(e => e.type === 'turn.end' && e.turnId === turnId)
    const endMs = end ? Date.parse(end.time) : startMs + 420_000
    const spanMs = endMs - startMs
    const frames = []
    for (const e of events) {
      if (e.turnId !== turnId) continue
      const at = Date.parse(e.time) - startMs
      if (at < 0 || at > spanMs) continue
      if (e.type === 'tool.call') frames.push({ at, frame: { type: 'chat.tool_call', callId: e.data.callId, name: e.data.name, args: e.data.args } })
      else if (e.type === 'tool.result') frames.push({ at, frame: { type: 'chat.tool_result', callId: e.data.callId, ok: e.data.ok !== false, text: e.data.text ?? '' } })
      else if (e.type === 'assistant.text') frames.push({ at, frame: { type: 'chat.assistant', text: e.data.text ?? '' } })
      else if (e.type === 'plan.updated') frames.push({ at, frame: { type: 'chat.activity', kind: 'plan', revision: e.data.revision, items: e.data.items ?? [] } })
      else if (e.type === 'notification' && e.data?.params?.event?.type === 'step/start') frames.push({ at, frame: { type: 'chat.activity', kind: 'model-start' } })
      else if (e.type === 'notification' && e.data?.params?.event?.type === 'assistant/message') {
        const blocks = e.data.params.event.data?.message?.content ?? []
        const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text ?? '').join('')
        if (reasoning.length > 0) frames.push({ at, frame: { type: 'chat.activity', kind: 'reasoning', text: reasoning } })
      }
    }
    frames.sort((a, b) => a.at - b.at)
    const aborted = end?.data?.aborted === true
    const label = end?.data?.label ?? null
    const planOutcome = end?.data?.planOutcome ?? null
    const hasHelp = events.some(e => e.turnId === turnId && e.type === 'help.request')
    const hasConfirm = events.some(e => e.turnId === turnId && e.type === 'confirm.request')
    const outcome = aborted ? 'stopped' : (label || planOutcome ? 'done' : (end?.data?.ok ? 'done' : 'error'))
    const endInfo = {
      outcome, label, planOutcome, deadTurn: false,
      ...(hasHelp ? { help: { category: 'other', reason: 'help requested' } } : {}),
      ...(hasConfirm ? { confirm: { action: 'confirm', target: 'target' } } : {}),
    }
    turns.push({ turnId, startMs, durationSec: Math.round(spanMs / 1000), prompt: start.data.userText ?? '', frames, endInfo, hasHelp, label, planOutcome, aborted })
  }
  return turns
}

/** Synthetic hard-signal fixtures (TOOL_HANG/EXECUTOR_DOWN fixture logs were not
 * archived — M3 used a stub logStore). Clearly labelled; they exercise the
 * judge-interaction path, not the alert mechanism (proven in M3 via GET /state). */
function syntheticTurn(kind) {
  const base = { turnId: `synthetic-${kind}`, startMs: Date.parse('2026-11-17T00:00:00Z'), prompt: 'synthetic hard-signal fixture (not a real run)', synthetic: kind }
  if (kind === 'TOOL_HANG') {
    return { ...base, durationSec: 300, frames: [{ at: 5000, frame: { type: 'chat.tool_call', callId: 'hang', name: 'browser_wait_for', args: { ms: 600000 } } }], endInfo: { outcome: 'stopped', label: null, planOutcome: null, deadTurn: false } }
  }
  if (kind === 'EXECUTOR_DOWN') {
    return {
      ...base, durationSec: 300, connectivityDropAt: 10_000,
      frames: [
        { at: 5000, frame: { type: 'chat.tool_call', callId: 'c1', name: 'browser_click', args: { label: 'Go' } } },
        { at: 6000, frame: { type: 'chat.tool_result', callId: 'c1', ok: true, text: 'clicked' } },
      ],
      endInfo: { outcome: 'stopped', label: null, planOutcome: null, deadTurn: false },
    }
  }
  // SILENT_STALL
  return {
    ...base, durationSec: 360,
    frames: [
      { at: 5000, frame: { type: 'chat.tool_call', callId: 'c1', name: 'browser_click', args: { label: 'Go' } } },
      { at: 6000, frame: { type: 'chat.tool_result', callId: 'c1', ok: true, text: 'clicked' } },
    ],
    endInfo: { outcome: 'stopped', label: null, planOutcome: null, deadTurn: false },
  }
}

/* ------------------------------------------------------------------ */
/* Replay one turn under a fake clock with the real judge              */
/* ------------------------------------------------------------------ */

async function replayTurn(turn, { judge, random, judgeLimits, tickMs }) {
  let now = 0
  let tickFn = null
  const ledger = new WatchLedger({ now: () => now })
  const watchFrames = []
  const alerts = []
  const recoveries = []
  const callLog = []
  let endedIncomplete = false
  let connectivityDropped = false

  // Wrap the judge to record per-call usage/verdict at the simulated call time.
  const wrappedJudge = {
    check: async input => {
      const result = await judge.check(input)
      callLog.push({ atSec: now / 1000, status: result.status, state: result.verdict.state, confidence: result.verdict.confidence, blocker: result.verdict.blocker, reason: result.verdict.reason, usage: result.usage, durationMs: result.durationMs })
      return result
    },
    abort: turnId => judge.abort(turnId),
    get inFlight() { return judge.inFlight },
  }

  const watcher = new Watcher({
    ledger,
    marathonEnabled: () => true,
    publish: frame => {
      watchFrames.push(frame)
      if (frame.type !== 'chat.watch') return
      if (frame.state === 'open' && frame.kind !== 'ended-incomplete' && frame.kind !== 'info') {
        alerts.push({ atSec: now / 1000, kind: frame.kind, source: frame.source, blocker: frame.blocker, reason: frame.reason, judgeChecks: watcher.judgeCalls })
      }
      if (frame.kind === 'recovered') recoveries.push({ atSec: now / 1000 })
      if (frame.kind === 'ended-incomplete') endedIncomplete = true
    },
    judge: wrappedJudge,
    now: () => now,
    wallNow: () => turn.startMs + now,
    setTimer: fn => { tickFn = fn; return 1 },
    clearTimer: () => { tickFn = null },
    push: () => {},
    log: () => {},
    random: random ?? (() => 0.5),
    judgeLimits,
  })
  watcher.start()
  ledger.startTurn({ turnId: turn.turnId, prompt: turn.prompt, marathon: true })
  watcher.turnStarted({ marathon: true })

  // Merge frames and ticks into one timeline so each frame is stamped at its
  // TRUE recorded offset (not quantized to a tick boundary), matching the live
  // ledger's arrival-time stamps. Ticks fire every tickMs; a triggered judge
  // call is awaited at its tick time (simulated clock frozen during the HTTP).
  const endMs = turn.durationSec * 1000
  const timeline = []
  for (const f of turn.frames) timeline.push({ at: f.at, kind: 'frame', frame: f.frame })
  for (let t = tickMs; t <= endMs; t += tickMs) timeline.push({ at: t, kind: 'tick' })
  if (turn.connectivityDropAt !== undefined) timeline.push({ at: turn.connectivityDropAt, kind: 'connectivity' })
  const order = { frame: 0, connectivity: 1, tick: 2 }
  timeline.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind])
  for (const item of timeline) {
    now = item.at
    if (item.kind === 'frame') ledger.noteFrame(item.frame)
    else if (item.kind === 'connectivity') { if (!connectivityDropped) { ledger.setConnectivity({ uiConnected: false, toolsConnected: true }); connectivityDropped = true } }
    else { watcher.tick(); await watcher.settleJudge() }
  }
  now = endMs
  const summary = watcher.turnEnded(turn.endInfo)
  watcher.stop()

  return {
    turnId: turn.turnId,
    durationSec: turn.durationSec,
    synthetic: turn.synthetic ?? null,
    callLog,
    alerts,
    recoveries,
    endedIncomplete,
    summary,
    usage: {
      calls: watcher.judgeCalls,
      skipped: watcher.judgeSkipped,
      inputTokens: watcher.judgeInputTokens,
      outputTokens: watcher.judgeOutputTokens,
      reasoningTokens: watcher.judgeReasoningTokens,
      cacheReadTokens: watcher.judgeCacheReadTokens,
    },
  }
}

/* ------------------------------------------------------------------ */
/* Window manifest                                                     */
/* ------------------------------------------------------------------ */

const ARCHIVES = {
  m0Smoke: 'run-2026-11-17T01-07-02-137Z-f33f10',
  m0Long: 'run-2026-11-17T01-07-40-552Z-c02d66',
  m0Stall: 'run-2026-11-17T01-13-25-223Z-02b684',
  m0Signin: 'run-2026-11-17T01-20-21-564Z-2551a4',
  m1Long: 'run-2026-11-17T01-32-38-591Z-f80ac2',
  m2Long: 'run-2026-11-17T02-02-36-976Z-849181',
  m2tSuite1: 'run-2026-11-17T02-44-34-045Z-b5a71b',
  m2Suite2: 'run-2026-11-17T02-14-11-994Z-c82d46',
  m2Unrelated: 'run-2026-11-17T02-26-39-794Z-739f46',
  m3Long: 'run-2026-11-17T03-37-05-493Z-6d9d73',
  contaminatedStall: 'run-2026-11-17T00-43-57-262Z-2ab066',
}

/** Build the labelled window manifest. Each window references a replayed turn
 * and a scoring interval [startSec, endSec]. Fine windows are full turns; the
 * two long stuck runs also contribute a late slice (correlated — noted). */
function buildWindows(turnsByArchive) {
  const windows = []
  const full = (archive, idx, label, scenario, note, expectEnded) => {
    const turn = turnsByArchive[archive]?.[idx]
    if (!turn) return
    windows.push({ id: `${archive}-r${idx + 1}`, archive, turnIndex: idx, turnId: turn.turnId, label, scenario, note, startSec: 0, endSec: turn.durationSec, expectEndedIncomplete: expectEnded, synthetic: false })
  }
  // Clean M0 (pre-marathon code; replay arms marathon=true to exercise the watcher).
  full('m0Smoke', 0, 'fine', 'click-once smoke', 'clean M0 smoke', false)
  for (let i = 0; i < 5; i += 1) full('m0Long', i, 'fine', 'marathon-long', 'clean M0 complete', false)
  // Clean M0 stall-loop: r1/r2/r3/r5 end honestly BELOW thresholds (no judge
  // call, no alert) → fine. r4 loops ~30× on the inert button past PLAN_STALLED
  // (@140s) before self-reporting BLOCKED (@153s): lead ruling 2026-11-16 labels
  // it STUCK — at 140s it is stuck/looping and has NOT said so yet (plan §0
  // remit; §5 M4 expects stall-loop alerts). The alert is a plan-consistent TRUE
  // POSITIVE, not a false alert. The hard requirement is zero false alerts on
  // HEALTHY/PROGRESSING runs (no stall behavior), not on runs that genuinely stall.
  for (const i of [0, 1, 2, 4]) full('m0Stall', i, 'fine', 'stall-loop', 'clean M0 quick honest BLOCKED end below thresholds (no stall detected)', true)
  full('m0Stall', 3, 'stuck', 'stall-loop', 'clean M0 r4: loops past PLAN_STALLED @140s, honest BLOCKED @153s — TRUE-POSITIVE stuck alert (lead label correction; plan §0/§5 M4)', true)
  for (let i = 0; i < 5; i += 1) full('m0Signin', i, 'fine', 'sign-in-wall', 'clean M0 honest help end (no ended-incomplete)', false)
  // M1 / M2 acceptance batches (fine).
  for (let i = 0; i < 5; i += 1) full('m1Long', i, 'fine', 'marathon-long', 'M1 acceptance complete', false)
  for (let i = 0; i < 5; i += 1) full('m2Long', i, 'fine', 'marathon-long', 'M2 acceptance complete', false)
  // Tuning-pin suite 1: r3 is the 642s wander (stuck), r1/r2/r4/r5 fine.
  for (const i of [0, 1, 3, 4]) full('m2tSuite1', i, 'fine', 'marathon-long', 'tuning-pin suite1 clean pass', false)
  full('m2tSuite1', 2, 'stuck', 'marathon-long', 'tuning-pin suite1 r3: 642s wander, stations 4+5 re-recorded, false complete claim (semantic stall, varied activity)', false)
  // Suite 2 stop-then-continue: turns 1-9 fine, turn 10 (r5 continuation) stuck redo.
  for (let i = 0; i < 9; i += 1) full('m2Suite2', i, 'fine', 'stop-then-continue', 'suite2 stop/continue (no redo)', false)
  full('m2Suite2', 9, 'stuck', 'stop-then-continue', 'pre-tuning suite2 r5 continuation: 293s wander, station 9 re-recorded (semantic stall)', false)
  // Unrelated-question batch (fine).
  for (let i = 0; i < 10; i += 1) full('m2Unrelated', i, 'fine', 'unrelated-question', 'M2 unrelated/continue (no hijack)', false)
  // M3 acceptance batch (fine): 5 healthy marathon-long incl. the 221s FAITHFUL
  // wander (r3) — completed, 0 redos. Must stay silent with the judge wired.
  for (let i = 0; i < 5; i += 1) full('m3Long', i, 'fine', 'marathon-long', i === 2 ? 'M3 acceptance r3: 221s FAITHFUL wander, completed, 0 redos (must stay silent)' : 'M3 acceptance healthy complete', false)
  // Contaminated stall-loop r4: the 420s silent timeout (non-M0, M1-code diagnostic).
  full('contaminatedStall', 3, 'stuck', 'stall-loop', 'contaminated r4: 420s silent timeout, varied activity, no honest end (NON-M0, M1-code)', false)
  // Late slices of the two long stuck runs (correlated with their full windows).
  const late = (archive, idx, startSec, id, note) => {
    const turn = turnsByArchive[archive]?.[idx]
    if (!turn) return
    windows.push({ id, archive, turnIndex: idx, turnId: turn.turnId, label: 'stuck', scenario: 'stall-loop', note, startSec, endSec: turn.durationSec, expectEndedIncomplete: false, synthetic: false, slice: true })
  }
  late('contaminatedStall', 3, 240, 'contaminatedStall-r4-late', 'late slice [240s,420s] of the 420s silent stall (correlated with full window)')
  late('m2tSuite1', 2, 300, 'm2tSuite1-r3-late', 'late slice [300s,642s] of the 642s wander (correlated with full window)')
  // Synthetic hard-signal fixtures.
  for (const kind of ['TOOL_HANG', 'EXECUTOR_DOWN', 'SILENT_STALL']) {
    windows.push({ id: `synthetic-${kind}`, archive: null, turnIndex: null, turnId: `synthetic-${kind}`, label: 'stuck', scenario: kind, note: `SYNTHETIC hard-signal fixture (judge-interaction path; alert mechanism proven in M3)`, startSec: 0, endSec: syntheticTurn(kind).durationSec, expectEndedIncomplete: false, synthetic: true })
  }
  return windows
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

function scoreWindow(win, replay) {
  const { startSec, endSec } = win
  // Alerts relevant to the window: raised inside it, or already open at start
  // (raised before start and not recovered before start).
  const relevant = replay.alerts.filter(a => {
    if (a.atSec > endSec) return false
    if (a.atSec >= startSec) return true
    const recoveredBeforeStart = replay.recoveries.some(r => r.atSec > a.atSec && r.atSec <= startSec)
    return !recoveredBeforeStart
  })
  const callsInWindow = replay.callLog.filter(c => c.atSec >= startSec && c.atSec <= endSec)
  const usage = callsInWindow.reduce((acc, c) => ({
    inputTokens: acc.inputTokens + (c.usage?.inputTokens ?? 0),
    outputTokens: acc.outputTokens + (c.usage?.outputTokens ?? 0),
    reasoningTokens: acc.reasoningTokens + (c.usage?.reasoningTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 })

  if (win.label === 'fine') {
    return {
      id: win.id, label: 'fine', scenario: win.scenario, synthetic: win.synthetic, slice: win.slice ?? false,
      durationSec: endSec - startSec,
      falseAlert: relevant.length > 0,
      alerts: relevant.map(a => ({ kind: a.kind, source: a.source, atSec: a.atSec, reason: a.reason })),
      judgeCalls: callsInWindow.length,
      usage,
      endedIncomplete: replay.endedIncomplete,
      expectEndedIncomplete: win.expectEndedIncomplete,
      endedIncompleteCorrect: replay.endedIncomplete === win.expectEndedIncomplete,
      verdicts: replay.callLog.map(c => ({ atSec: c.atSec, state: c.state, confidence: c.confidence, status: c.status })),
    }
  }
  // stuck
  let flagged = false
  let checksAtAlert = null
  let firstAlert = null
  if (relevant.length > 0) {
    firstAlert = relevant.reduce((min, a) => (a.atSec < min.atSec ? a : min), relevant[0])
    flagged = true
    checksAtAlert = firstAlert.atSec < startSec ? 0 : replay.callLog.filter(c => c.atSec >= startSec && c.atSec <= firstAlert.atSec).length
  }
  return {
    id: win.id, label: 'stuck', scenario: win.scenario, synthetic: win.synthetic, slice: win.slice ?? false,
    durationSec: endSec - startSec,
    flagged,
    checksAtAlert,
    flaggedWithinTwo: flagged && checksAtAlert !== null && checksAtAlert <= 2,
    alertKind: firstAlert?.kind ?? null,
    alertSource: firstAlert?.source ?? null,
    alertReason: firstAlert?.reason ?? null,
    judgeCalls: callsInWindow.length,
    usage,
    verdicts: replay.callLog.map(c => ({ atSec: c.atSec, state: c.state, confidence: c.confidence, status: c.status })),
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const key = args.dryRun ? 'dry-run' : loadKey()
  if (!args.dryRun && !key) {
    console.error('No API key found (CRAZYAGENT_API_KEY or .dsh-home/browser-agent/api-key). Use --dry-run for a no-spend plumbing check.')
    process.exit(1)
  }

  const judge = args.dryRun
    ? { check: async () => ({ status: 'ok', verdict: { state: 'progressing', confidence: 0.9, blocker: null, reason: 'dry-run', evidence: [] }, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, totalTokens: 0 }, durationMs: 0, httpStatus: 200, finishReason: 'stop' }), abort: () => {}, get inFlight() { return false } }
    : createWatchJudge({ getApiKey: () => key, getBaseUrl: () => config.baseUrl, getModel: () => config.model })

  // Load archives and extract turns.
  const turnsByArchive = {}
  for (const [name, dir] of Object.entries(ARCHIVES)) {
    const file = join(args.archive, dir, 'events.jsonl')
    if (!existsSync(file)) { console.error(`WARN missing archive ${name}: ${file}`); continue }
    turnsByArchive[name] = extractTurns(parseArchive(file))
  }
  const windows = buildWindows(turnsByArchive).filter(w => args.only === null || w.id === args.only)
  if (windows.length === 0) { console.error('No windows matched.'); process.exit(1) }

  // Replay each unique turn once (synthetic turns generated on demand).
  const replays = new Map()
  const synthTurns = new Map()
  for (const win of windows) {
    const keyId = win.synthetic ? win.turnId : `${win.archive}/${win.turnIndex}`
    if (replays.has(keyId)) continue
    const turn = win.synthetic ? syntheticTurn(win.scenario) : turnsByArchive[win.archive][win.turnIndex]
    if (win.synthetic) synthTurns.set(win.turnId, turn)
    process.stderr.write(`replay ${keyId} (${turn.durationSec}s, ${turn.frames.length} frames)${args.dryRun ? ' [dry-run]' : ''}\n`)
    const replay = await replayTurn(turn, { judge, random: () => 0.5, judgeLimits: WATCH_JUDGE_LIMITS, tickMs: args.tickMs })
    replays.set(keyId, replay)
  }

  // Score windows.
  const results = windows.map(win => {
    const keyId = win.synthetic ? win.turnId : `${win.archive}/${win.turnIndex}`
    return scoreWindow(win, replays.get(keyId))
  })

  const fine = results.filter(r => r.label === 'fine')
  const stuck = results.filter(r => r.label === 'stuck')
  const stuckSemantic = stuck.filter(r => !r.synthetic)
  const falseAlerts = fine.filter(r => r.falseAlert)
  const flaggedWithinTwo = stuck.filter(r => r.flaggedWithinTwo)
  const endedCorrect = fine.filter(r => r.endedIncompleteCorrect).length
  const totalCalls = results.reduce((n, r) => n + r.judgeCalls, 0)
  const totalInput = results.reduce((n, r) => n + r.usage.inputTokens, 0)
  const totalOutput = results.reduce((n, r) => n + r.usage.outputTokens, 0)
  const totalReasoning = results.reduce((n, r) => n + r.usage.reasoningTokens, 0)

  const summary = {
    gate: {
      fineWindows: fine.length,
      fineFalseAlerts: falseAlerts.length,
      fineZeroAlertsPass: falseAlerts.length === 0,
      stuckWindows: stuck.length,
      stuckSemanticWindows: stuckSemantic.length,
      stuckFlaggedWithinTwo: flaggedWithinTwo.length,
      stuckFlaggedRate: stuck.length ? flaggedWithinTwo.length / stuck.length : 0,
      stuckSemanticFlaggedWithinTwo: stuckSemantic.filter(r => r.flaggedWithinTwo).length,
      stuckPass: stuck.length ? flaggedWithinTwo.length / stuck.length >= 0.8 : false,
      endedIncompleteCorrect: `${endedCorrect}/${fine.length}`,
      falseAlertCaveat: `0 observed false alerts in ${fine.length} fine windows bounds the true rate near 3/${fine.length} (~${(3 / Math.max(1, fine.length)).toFixed(3)}); small-sample, correlated slices noted.`,
    },
    cost: { judgeCalls: totalCalls, inputTokens: totalInput, outputTokens: totalOutput, reasoningTokens: totalReasoning, model: config.model.id, effort: 'low', maxTokensPerCall: 400 },
    dryRun: args.dryRun,
    generatedAt: new Date().toISOString(),
    windows: results,
  }

  // Console summary.
  console.log('\n=== M4 offline replay gate ===')
  console.log(`mode: ${args.dryRun ? 'DRY-RUN (fake judge)' : 'REAL judge'} · model ${config.model.id} @ low effort`)
  console.log(`fine windows: ${fine.length} · false alerts: ${falseAlerts.length} · ${summary.gate.fineZeroAlertsPass ? 'PASS' : 'FAIL'}`)
  console.log(`stuck windows: ${stuck.length} (semantic ${stuckSemantic.length}, synthetic ${stuck.length - stuckSemantic.length}) · flagged within 2 checks: ${flaggedWithinTwo.length} (${(summary.gate.stuckFlaggedRate * 100).toFixed(0)}%) · ${summary.gate.stuckPass ? 'PASS' : 'FAIL'}`)
  console.log(`ended-incomplete correct: ${summary.gate.endedIncompleteCorrect}`)
  console.log(`judge cost: ${totalCalls} calls · ${totalInput} input / ${totalOutput} output / ${totalReasoning} reasoning tokens`)
  console.log(`caveat: ${summary.gate.falseAlertCaveat}`)
  if (falseAlerts.length > 0) {
    console.log('\nFALSE ALERTS (fine windows):')
    for (const r of falseAlerts) console.log(`  ${r.id} [${r.scenario}] alerts=${JSON.stringify(r.alerts)} verdicts=${JSON.stringify(r.verdicts)}`)
  }
  console.log('\nstuck window detail:')
  for (const r of stuck) console.log(`  ${r.id} [${r.scenario}]${r.slice ? ' (slice)' : ''}${r.synthetic ? ' (synthetic)' : ''}: flagged=${r.flagged} checksAtAlert=${r.checksAtAlert} kind=${r.alertKind} src=${r.alertSource} calls=${r.judgeCalls} verdicts=${r.verdicts.map(v => `${v.state}@${v.atSec}s`).join(',') || 'none'}`)
  const fineWithCalls = fine.filter(r => r.judgeCalls > 0)
  console.log(`\nfine windows that exercised the judge (${fineWithCalls.length}):`)
  for (const r of fineWithCalls) console.log(`  ${r.id} [${r.scenario}]: calls=${r.judgeCalls} falseAlert=${r.falseAlert} ended=${r.endedIncomplete} verdicts=${r.verdicts.map(v => `${v.state}@${v.atSec}s`).join(',')}`)

  // Write results (never the key).
  const out = args.out ?? join(ROOT, 'docs/marathon/m4-evidence', `replay-${args.dryRun ? 'dryrun-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(summary, null, 2) + '\n')
  console.log(`\nresults written: ${out}`)

  const pass = summary.gate.fineZeroAlertsPass && summary.gate.stuckPass
  console.log(`\nGATE: ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 2)
}

main().catch(error => { console.error('replay failed:', error?.stack ?? error); process.exit(1) })
