#!/usr/bin/env node
/**
 * watcher-eval.mjs — manifest-driven offline replay gate (MARATHON-V2-PLAN.md
 * §3.1 / §5 V0; successor of the M4 replay gate).
 *
 * CHEAPEST GATE FIRST: reads e2e/watch-corpus/manifest.json (labels frozen by
 * scripts/watch-label.mjs from independent state BEFORE scoring; never tuned
 * here), replays each window's committed trace through the real WatchLedger +
 * Watcher + judge under a fake clock (no browser, no DSH runner), and scores
 * the §3.1 metrics. The ledger is NOT weakened to fit the traces.
 *
 * The API key is loaded from the environment (CRAZYAGENT_API_KEY) or the
 * companion's .dsh-home/browser-agent/api-key file at launch (worktree first,
 * then the main checkout), passed to the judge through an injected getter, and
 * NEVER printed or written to results.
 *
 * Usage:
 *   node scripts/watcher-eval.mjs --dry-run                 # fake judge, no spend
 *   node scripts/watcher-eval.mjs --split tune --repeat 3   # tune windows, k=3
 *   node scripts/watcher-eval.mjs --split holdout           # holdout (score ONCE at milestone end)
 *   node scripts/watcher-eval.mjs --only <windowId>         # one window
 *   node scripts/watcher-eval.mjs --manifest path.json --out path.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { WatchLedger } from '../companion/watch-ledger.mjs'
import { Watcher, WATCH_JUDGE_LIMITS } from '../companion/watcher.mjs'
import { createWatchJudge } from '../companion/watch-judge.mjs'
import { DEFAULT_BASE_URL, RECOMMENDED_MODEL_ID } from '../companion/openrouter.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MAIN_ROOT = '/home/conan/Documents/GitHub/crazyAgent'
const CORPUS = join(ROOT, 'e2e/watch-corpus')
const TICK_MS = 20_000
/** End classes exempt from ended-incomplete (§3.1 end-class rule). */
const END_CLASS_EXEMPT = new Set(['help', 'confirm', 'stopped', 'done', 'reported-complete'])
/** Mid-turn alert kinds (ended-incomplete and info/recovered are not alerts). */
const ALERT_KINDS = new Set(['SILENT_STALL', 'TOOL_HANG', 'EXECUTOR_DOWN', 'stuck', 'blocked'])

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { dryRun: false, only: null, out: null, split: null, manifest: null, tickMs: TICK_MS, repeat: 3 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--only') args.only = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--split') args.split = argv[++i]
    else if (a === '--manifest') args.manifest = argv[++i]
    else if (a === '--tick-ms') args.tickMs = Number(argv[++i])
    else if (a === '--repeat') args.repeat = Number(argv[++i])
  }
  if (args.split !== null && args.split !== 'tune' && args.split !== 'holdout') {
    console.error(`--split must be tune or holdout (got ${args.split})`)
    process.exit(1)
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 1) {
    console.error(`--repeat must be a positive integer (got ${args.repeat})`)
    process.exit(1)
  }
  return args
}

/** Load the key into the environment at launch; never print or persist it. */
function loadKey() {
  if (process.env.CRAZYAGENT_API_KEY && process.env.CRAZYAGENT_API_KEY.trim().length > 0) return process.env.CRAZYAGENT_API_KEY.trim()
  for (const root of [ROOT, MAIN_ROOT]) {
    const keyFile = join(root, '.dsh-home/browser-agent/api-key')
    if (existsSync(keyFile)) {
      const key = readFileSync(keyFile, 'utf8').trim()
      if (key.length > 0) { process.env.CRAZYAGENT_API_KEY = key; return key }
    }
  }
  return null
}

function loadConfig() {
  for (const root of [ROOT, MAIN_ROOT]) {
    const llmPath = join(root, '.dsh-home/browser-agent/llm.json')
    if (existsSync(llmPath)) {
      try {
        const parsed = JSON.parse(readFileSync(llmPath, 'utf8'))
        if (parsed?.model?.id) return { baseUrl: parsed.baseUrl ?? DEFAULT_BASE_URL, model: parsed.model }
      } catch { /* fall through */ }
    }
  }
  return { baseUrl: DEFAULT_BASE_URL, model: { id: RECOMMENDED_MODEL_ID, reasoning: true } }
}

/* ------------------------------------------------------------------ */
/* Trace loader (manifest is the ONLY window source)                   */
/* ------------------------------------------------------------------ */

/**
 * Load one window's committed trace, verifying its sha256 and header. Trace
 * format: line 0 header {type:'turn',turnId,run,startMs,durationSec,prompt,
 * endInfo,…}; lines 1+ {at: ms-offset-from-turn-start, frame:{…}} sorted by at.
 * Fail closed on any mismatch.
 */
function loadTraceTurn(win, corpusDir) {
  const gz = readFileSync(join(corpusDir, win.trace))
  const sha = createHash('sha256').update(gz).digest('hex')
  if (win.traceSha256 && sha !== win.traceSha256) throw new Error(`trace sha256 mismatch for ${win.id}`)
  const lines = gunzipSync(gz).toString('utf8').trim().split('\n').filter(Boolean)
  const header = JSON.parse(lines[0])
  if (header.type !== 'turn' || header.turnId !== win.turnId) throw new Error(`trace header mismatch for ${win.id}`)
  return {
    turnId: header.turnId,
    startMs: header.startMs,
    durationSec: header.durationSec,
    prompt: header.prompt ?? '',
    frames: lines.slice(1).map(l => JSON.parse(l)),
    endInfo: header.endInfo,
  }
}

/** Synthetic hard-signal fixtures (clearly labelled; exercise the judge path,
 *  not the alert mechanism — proven in M3 via GET /state). None in the corpus
 *  today; kept for §3.1 synthetic-apart reporting. */
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
  const tickLevels = []
  let endedIncomplete = false
  let connectivityDropped = false

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
      if (frame.type !== 'chat.watch') return
      watchFrames.push({ atSec: now / 1000, id: frame.id, kind: frame.kind, state: frame.state })
      if (frame.state === 'open' && ALERT_KINDS.has(frame.kind)) {
        alerts.push({ atSec: now / 1000, id: frame.id, kind: frame.kind, source: frame.source, blocker: frame.blocker, reason: frame.reason, judgeChecks: watcher.judgeCalls })
      }
      if (frame.kind === 'recovered') recoveries.push({ atSec: now / 1000, id: frame.id })
      if (frame.kind === 'ended-incomplete' && frame.state === 'open') endedIncomplete = true
    },
    judge: wrappedJudge,
    now: () => now,
    wallNow: () => turn.startMs + now,
    setTimer: fn => { tickFn = fn; return 1 },
    clearTimer: () => { tickFn = null },
    push: () => {},
    log: (type, data) => { if (type === 'watch.tick' && data?.level) tickLevels.push({ atSec: now / 1000, level: data.level }) },
    random: random ?? (() => 0.5),
    judgeLimits,
  })
  watcher.start()
  ledger.startTurn({ turnId: turn.turnId, prompt: turn.prompt, marathon: true })
  watcher.turnStarted({ marathon: true })

  // Merge frames and ticks into one timeline so each frame is stamped at its
  // TRUE recorded offset (matching the live ledger's arrival-time stamps).
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

  // §3.1 stale-alert source: track each notice id's LAST state. A mid-turn
  // alert id whose last state is still 'open' at turn end (no closing frame)
  // is stale. v1 turnEnded nulls openAlert WITHOUT publishing a close frame —
  // that asymmetry is the v1 stale bug. ended-incomplete persists open BY
  // DESIGN (until ack) and is tracked separately, not as stale.
  const lastStateById = new Map()
  const alertIds = new Set()
  let endedIncompleteId = null
  for (const f of watchFrames) {
    lastStateById.set(f.id, f.state)
    if (f.state === 'open' && ALERT_KINDS.has(f.kind)) alertIds.add(f.id)
    if (f.kind === 'ended-incomplete') endedIncompleteId = f.id
  }
  const staleAlertIds = [...alertIds].filter(id => lastStateById.get(id) === 'open')
  const endedIncompleteOpen = endedIncompleteId !== null && lastStateById.get(endedIncompleteId) === 'open'

  return {
    turnId: turn.turnId,
    durationSec: turn.durationSec,
    synthetic: turn.synthetic ?? null,
    callLog,
    alerts,
    recoveries,
    watchFrames,
    tickLevels,
    endedIncomplete,
    endedIncompleteOpen,
    staleAlertIds,
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
/* Scoring (§3.1; manifest fields are the contract)                    */
/* ------------------------------------------------------------------ */

function scoreWindow(win, replay, patience) {
  const startSec = win.windowStartSec ?? 0
  const endSec = win.windowEndSec ?? replay.durationSec
  const caughtPost = patience.caughtWindowPostSec ?? 240
  const redoWindow = patience.redoWindowSec ?? 120
  const relevant = replay.alerts.filter(a => a.atSec >= startSec && a.atSec <= endSec)
  const callsInWindow = replay.callLog.filter(c => c.atSec >= startSec && c.atSec <= endSec)
  const expectEndedIncomplete = !END_CLASS_EXEMPT.has(win.endClass)
  // redo caught (informational): any chat.watch frame within redoWindow of a redo.
  const redoCaught = (win.redo ?? []).filter(r => r.atSec != null).map(r => ({
    step: r.step, atSec: r.atSec,
    caught: replay.watchFrames.some(f => Math.abs(f.atSec - r.atSec) <= redoWindow),
  }))
  const base = {
    id: win.id, run: win.run, label: win.label, scenario: win.scenario, scenarioClass: win.scenarioClass,
    labelRule: win.labelRule, gated: win.gated, split: win.split, origin: win.origin, synthetic: win.synthetic,
    slice: win.slice ?? false, endClass: win.endClass, durationSec: endSec - startSec,
    judgeCalls: replay.usage.calls, usage: replay.usage,
    callsInWindow: callsInWindow.length,
    staleAlerts: replay.staleAlertIds.length, staleAlertIds: replay.staleAlertIds,
    endedIncomplete: replay.endedIncomplete, endedIncompleteOpen: replay.endedIncompleteOpen,
    expectEndedIncomplete, endedIncompleteCorrect: replay.endedIncomplete === expectEndedIncomplete,
    redoCaught,
    suspectTicks: replay.tickLevels.filter(t => t.level === 'suspect').length,
    verdicts: replay.callLog.map(c => ({ atSec: c.atSec, state: c.state, confidence: c.confidence, status: c.status })),
  }
  if (win.label === 'fine') {
    return { ...base, falseAlert: relevant.length > 0, alerts: relevant.map(a => ({ kind: a.kind, source: a.source, atSec: a.atSec, id: a.id, reason: a.reason })) }
  }
  // stuck: caught = first alert in [windowStartSec, onsetSec + caughtPost].
  const onset = win.onsetSec ?? startSec
  const caughtEnd = onset + caughtPost
  const inCaught = relevant.filter(a => a.atSec <= caughtEnd)
  const early = replay.alerts.filter(a => a.atSec < startSec)
  let firstAlert = null
  let caught = false
  let checksAtAlert = null
  if (inCaught.length > 0) {
    firstAlert = inCaught.reduce((min, a) => (a.atSec < min.atSec ? a : min), inCaught[0])
    caught = true
    checksAtAlert = replay.callLog.filter(c => c.atSec >= startSec && c.atSec <= firstAlert.atSec).length
  }
  const stuckEnd = win.stuckEndSec ?? endSec
  const falseRecovery = replay.recoveries.some(r => r.atSec >= onset && r.atSec <= stuckEnd)
  return {
    ...base, caught, early: early.length > 0, checksAtAlert,
    alertKind: firstAlert?.kind ?? null, alertSource: firstAlert?.source ?? null, alertReason: firstAlert?.reason ?? null,
    alertAtSec: firstAlert?.atSec ?? null, falseRecovery,
    alerts: relevant.map(a => ({ kind: a.kind, source: a.source, atSec: a.atSec, id: a.id })),
  }
}

const flaggedOf = r => (r.label === 'fine' ? r.falseAlert : r.caught)

/** Aggregate k repeats per window: mean / worst-case / stability. */
function aggregateWindow(win, repeats) {
  const k = repeats.length
  const flags = repeats.map(flaggedOf)
  const meanFlagged = flags.filter(Boolean).length / k
  // Worst case: fine = false-alerted if ANY repeat false-alerted (pessimistic);
  // stuck = caught in worst case ONLY IF caught in ALL k (reliably caught).
  const worstFlagged = win.label === 'fine' ? flags.some(Boolean) : flags.every(Boolean)
  const stable = flags.every(f => f === flags[0])
  const mean = field => repeats.reduce((n, r) => n + (r[field] ?? 0), 0) / k
  return {
    id: win.id, run: win.run, label: win.label, scenario: win.scenario, scenarioClass: win.scenarioClass,
    labelRule: win.labelRule, gated: win.gated, split: win.split, origin: win.origin, synthetic: win.synthetic, slice: win.slice ?? false,
    repeats: k, meanFlagged, worstFlagged, stable,
    meanStaleAlerts: mean('staleAlerts'), worstStaleAlerts: Math.max(...repeats.map(r => r.staleAlerts)),
    meanFalseRecovery: repeats.some(r => r.label === 'stuck') ? repeats.filter(r => r.falseRecovery).length / k : 0,
    anyFalseRecovery: repeats.some(r => r.falseRecovery),
    endedIncompleteCorrect: repeats.every(r => r.endedIncompleteCorrect),
    meanJudgeCalls: mean('judgeCalls'),
    usage: repeats[0].usage,
    redoCaught: repeats[0].redoCaught,
    meanSuspectTicks: mean('suspectTicks'),
    perRepeat: repeats.map(r => ({ flagged: flaggedOf(r), staleAlerts: r.staleAlerts, judgeCalls: r.judgeCalls, caught: r.caught ?? null, falseAlert: r.falseAlert ?? null, alertAtSec: r.alertAtSec ?? null, alertKind: r.alertKind ?? null, falseRecovery: r.falseRecovery ?? null })),
  }
}

function groupStats(windows) {
  const fine = windows.filter(w => w.label === 'fine')
  const stuck = windows.filter(w => w.label === 'stuck')
  const rate = (arr, field) => (arr.length ? arr.filter(w => w[field]).length / arr.length : 0)
  return {
    windows: windows.length,
    fine: fine.length,
    stuck: stuck.length,
    fineFalseAlertMeanRate: rate(fine, 'meanFlagged'),
    fineFalseAlertWorstRate: rate(fine, 'worstFlagged'),
    fineZeroAlertsMeanPass: fine.every(w => !w.meanFlagged),
    fineZeroAlertsWorstPass: fine.every(w => !w.worstFlagged),
    stuckCaughtMeanRate: rate(stuck, 'meanFlagged'),
    stuckCaughtWorstRate: rate(stuck, 'worstFlagged'),
    stuckCaughtMeanPass: stuck.length ? rate(stuck, 'meanFlagged') >= 0.8 : true,
    stuckCaughtWorstPass: stuck.length ? rate(stuck, 'worstFlagged') >= 0.8 : true,
    stability: windows.length ? windows.filter(w => w.stable).length / windows.length : 1,
    staleAlertWindows: windows.filter(w => w.worstStaleAlerts > 0).length,
    falseRecoveryWindows: windows.filter(w => w.anyFalseRecovery).length,
    endedIncompleteCorrect: `${windows.filter(w => w.endedIncompleteCorrect).length}/${windows.length}`,
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

  const manifestPath = args.manifest ?? join(CORPUS, 'manifest.json')
  const corpusDir = dirname(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const patience = manifest.patience ?? {}
  let windows = manifest.windows ?? []
  if (args.split !== null) windows = windows.filter(w => w.split === args.split)
  if (args.only !== null) windows = windows.filter(w => w.id === args.only || w.id.includes(args.only))
  if (windows.length === 0) { console.error('No windows matched.'); process.exit(1) }

  // Load + dedup turns (each window = 1 turn today; key run#turnIndex).
  const turnsByKey = new Map()
  for (const win of windows) {
    const keyId = win.synthetic ? win.turnId : `${win.run}#${win.turnIndex}`
    if (turnsByKey.has(keyId)) continue
    turnsByKey.set(keyId, win.synthetic ? syntheticTurn(win.scenario) : loadTraceTurn(win, corpusDir))
  }

  // Replay each unique turn k times; score each window per repeat.
  const repeatsByWindow = new Map(windows.map(w => [w.id, []]))
  for (let r = 0; r < args.repeat; r += 1) {
    const replayByKey = new Map()
    for (const [keyId, turn] of turnsByKey) {
      process.stderr.write(`repeat ${r + 1}/${args.repeat} ${keyId} (${turn.durationSec}s, ${turn.frames.length} frames)${args.dryRun ? ' [dry-run]' : ''}\n`)
      replayByKey.set(keyId, await replayTurn(turn, { judge, random: () => 0.5, judgeLimits: WATCH_JUDGE_LIMITS, tickMs: args.tickMs }))
    }
    for (const win of windows) {
      const keyId = win.synthetic ? win.turnId : `${win.run}#${win.turnIndex}`
      repeatsByWindow.get(win.id).push(scoreWindow(win, replayByKey.get(keyId), patience))
    }
    // Resilience: persist intermediate per-repeat aggregate so turn death loses nothing.
    if (args.out) {
      const partial = windows.map(w => aggregateWindow(w, repeatsByWindow.get(w.id)))
      writeFileSync(`${args.out}.r${r + 1}.json`, JSON.stringify({ repeat: r + 1, windows: partial }, null, 2) + '\n')
    }
  }

  const agg = windows.map(w => aggregateWindow(w, repeatsByWindow.get(w.id)))
  const groups = {
    gatedAll: groupStats(agg.filter(w => w.gated)),
    gatedClean: groupStats(agg.filter(w => w.gated && w.origin === 'clean')),
    gatedContaminated: groupStats(agg.filter(w => w.gated && w.origin === 'contaminated')),
    legacyManual: groupStats(agg.filter(w => w.labelRule === 'legacy-manual')),
    all: groupStats(agg),
  }

  // Cost: full-turn usage per unique turn (× k repeats), separate from agent usage.
  const uniqueTurns = [...turnsByKey.values()]
  const watchedSeconds = uniqueTurns.reduce((n, t) => n + t.durationSec, 0) * args.repeat
  const totals = agg.reduce((acc, w) => ({
    judgeCalls: acc.judgeCalls + w.usage.calls * args.repeat,
    inputTokens: acc.inputTokens + w.usage.inputTokens * args.repeat,
    outputTokens: acc.outputTokens + w.usage.outputTokens * args.repeat,
    reasoningTokens: acc.reasoningTokens + w.usage.reasoningTokens * args.repeat,
    cacheReadTokens: acc.cacheReadTokens + w.usage.cacheReadTokens * args.repeat,
  }), { judgeCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 })
  const perWatchedHour = watchedSeconds > 0 ? {
    judgeCalls: totals.judgeCalls / (watchedSeconds / 3600),
    inputTokens: totals.inputTokens / (watchedSeconds / 3600),
    outputTokens: totals.outputTokens / (watchedSeconds / 3600),
  } : { judgeCalls: 0, inputTokens: 0, outputTokens: 0 }

  // Gate (lead ruling 2026-11-17): caught GATE = MEAN across k ≥80%; false-alert
  // GATE = worst-case 0 on fine. Worst-case caught + stability are diagnostics.
  const gatePass = groups.gatedAll.fineZeroAlertsWorstPass && groups.gatedAll.stuckCaughtMeanPass
  const summary = {
    dryRun: args.dryRun, split: args.split ?? 'all', repeat: args.repeat,
    manifestCreatedAt: manifest.createdAt, manifestWindows: manifest.windows.length,
    model: config.model.id, effort: 'low', maxTokensPerCall: 400,
    groups, gatePass,
    cost: { totals, perWatchedHour, watchedSeconds, note: 'judge cost only; separate from agent usage' },
    generatedAt: new Date().toISOString(),
    windows: agg,
  }

  // Console summary.
  console.log(`\n=== V0 manifest-driven replay gate ===`)
  console.log(`mode: ${args.dryRun ? 'DRY-RUN (fake judge)' : 'REAL judge'} · model ${config.model.id} @ low · split ${summary.split} · k=${args.repeat} · ${windows.length} windows`)
  for (const [name, g] of Object.entries(groups)) {
    console.log(`\n[${name}] windows ${g.windows} (fine ${g.fine}, stuck ${g.stuck})`)
    console.log(`  fine false-alert mean ${(g.fineFalseAlertMeanRate * 100).toFixed(0)}% / worst ${(g.fineFalseAlertWorstRate * 100).toFixed(0)}% · zero-alerts mean ${g.fineZeroAlertsMeanPass ? 'PASS' : 'FAIL'} / worst ${g.fineZeroAlertsWorstPass ? 'PASS' : 'FAIL'}`)
    console.log(`  stuck caught mean ${(g.stuckCaughtMeanRate * 100).toFixed(0)}% / worst ${(g.stuckCaughtWorstRate * 100).toFixed(0)}% · ≥80% mean ${g.stuckCaughtMeanPass ? 'PASS' : 'FAIL'} / worst ${g.stuckCaughtWorstPass ? 'PASS' : 'FAIL'}`)
    console.log(`  stability ${(g.stability * 100).toFixed(0)}% · stale-alert windows ${g.staleAlertWindows} · false-recovery windows ${g.falseRecoveryWindows} · ended-incomplete correct ${g.endedIncompleteCorrect}`)
  }
  console.log(`\ncost: ${totals.judgeCalls} judge calls · ${totals.inputTokens} input / ${totals.outputTokens} output / ${totals.reasoningTokens} reasoning tokens · watched ${(watchedSeconds / 3600).toFixed(2)} h · per-hour ${perWatchedHour.judgeCalls.toFixed(1)} calls`)
  if (groups.gatedClean.windows > 0 && groups.gatedContaminated.windows > 0 &&
      (groups.gatedClean.fineZeroAlertsWorstPass !== groups.gatedContaminated.fineZeroAlertsWorstPass || groups.gatedClean.stuckCaughtWorstPass !== groups.gatedContaminated.stuckCaughtWorstPass)) {
    console.log('\n⚠ CONTAMINATED SENSITIVITY: gate pass/fail differs between clean and contaminated — FLAG TO LEAD')
  }
  console.log('\nstuck window detail:')
  for (const w of agg.filter(x => x.label === 'stuck')) console.log(`  ${w.id} [${w.scenario}]${w.slice ? ' (slice)' : ''}${w.synthetic ? ' (synthetic)' : ''} gated=${w.gated} origin=${w.origin}: caughtMean=${w.meanFlagged.toFixed(2)} caughtWorst=${w.worstFlagged} stable=${w.stable} kinds=${w.perRepeat.map(p => p.alertKind).join(',')} atSec=${w.perRepeat.map(p => p.alertAtSec).join(',')}`)
  const falseAlertWindows = agg.filter(w => w.label === 'fine' && w.worstFlagged)
  if (falseAlertWindows.length > 0) {
    console.log('\nFALSE ALERTS (fine, worst-case):')
    for (const w of falseAlertWindows) console.log(`  ${w.id} [${w.scenario}] mean=${w.meanFlagged.toFixed(2)} perRepeat=${JSON.stringify(w.perRepeat.map(p => ({ flagged: p.flagged, kind: p.alertKind })))}`)
  }

  const out = args.out ?? join(ROOT, 'docs/marathon/v2', `replay-${args.dryRun ? 'dryrun-' : ''}${summary.split}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(summary, null, 2) + '\n')
  console.log(`\nresults written: ${out}`)
  console.log(`\nGATE (gatedAll worst-case): ${gatePass ? 'PASS' : 'FAIL'}`)
  process.exit(gatePass ? 0 : 2)
}

main().catch(error => { console.error('replay failed:', error?.stack ?? error); process.exit(1) })
