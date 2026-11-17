#!/usr/bin/env node
/**
 * watch-label.mjs — Marathon v2 V0-b corpus builder + server-record labeller.
 *
 * Labels windows from INDEPENDENT state only (fixture-server progress records
 * and the run log's actual tool/help/confirm/end events), never from the model's
 * claims or the watcher's verdicts. Patience values are FIXED here and frozen
 * into the manifest before any scoring; they are never tuned on results.
 *
 * Label rules (MARATHON-V2-PLAN.md §3.1):
 *  - progressable (marathon-long, marathon-epic, stop-then-continue):
 *    t0 = 240 s since the last server-accepted station (or turn start), with
 *    >=3 tool calls in that span and the turn still running.
 *  - impossible-by-design (stall-loop, sign-in-wall, captcha-wall,
 *    spinner-forever, bounce-form): t0 = 120 s of acting with no help request,
 *    confirmation request, or final answer.
 *  - redo (progressable): the time of a duplicate server record; scored
 *    separately, no gate.
 *  - No onset -> fine. Stuck window = t0-60 s .. min(turn end, t0+600 s).
 *
 * Label sources, recorded per window:
 *  - server-progress-240s: batch JSON `serverRecords[].acceptedAt` (fixture
 *    server clock) — gated.
 *  - impossible-120s: the run log's acting/help/confirm/end events (independent
 *    state) for an impossible-by-design scenario — gated.
 *  - legacy-manual: an old progressable archive without per-step server
 *    timestamps; v1 hand label kept for comparison only — NOT gated.
 *
 * Usage:
 *   node scripts/watch-label.mjs --build [--only <runDir>] [--archive-root <p>]
 *   node scripts/watch-label.mjs --ingest <batch.json>   (add eval's new batches)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MAIN_ROOT = '/home/conan/Documents/GitHub/crazyAgent'
const CORPUS = join(ROOT, 'e2e/watch-corpus')
const TRACES = join(CORPUS, 'traces')

/** FIXED patience — frozen into the manifest before scoring; never tuned. */
export const PATIENCE = Object.freeze({
  progressableSec: 240,
  progressableMinCalls: 3,
  impossibleSec: 120,
  impossibleMinCalls: 1,
  stuckWindowPreSec: 60,
  stuckWindowPostSec: 600,
  caughtWindowPostSec: 240,
  redoWindowSec: 120,
})

export const SCENARIO_CLASS = Object.freeze({
  'marathon-long': 'progressable',
  'marathon-epic': 'progressable',
  'stop-then-continue': 'progressable',
  'stall-loop': 'impossible',
  'sign-in-wall': 'impossible',
  'captcha-wall': 'impossible',
  'spinner-forever': 'impossible',
  'bounce-form': 'impossible',
  'click-once': 'other',
  'unrelated-question': 'other',
})

/** Infer the scenario from the harness prompt for archives without a baseline
 * (e.g. the contaminated M1-code diagnostics). Fixture prompts only. */
export function scenarioFromPrompt(prompt) {
  const p = String(prompt ?? '')
  if (/records viewer|record 12|access code/iu.test(p)) return 'stall-loop'
  if (/expedition permit|station/iu.test(p)) return 'marathon-long'
  if (/newest subject|inbox|mail app/iu.test(p)) return 'sign-in-wall'
  if (/verify you are human|captcha/iu.test(p)) return 'captcha-wall'
  if (/never finish loading|spinner/iu.test(p)) return 'spinner-forever'
  if (/something went wrong|bounce/iu.test(p)) return 'bounce-form'
  if (/17 \* 3|just the number/iu.test(p)) return 'unrelated-question'
  if (/Increment button/iu.test(p)) return 'click-once'
  if (/^continue$/iu.test(p.trim())) return 'stop-then-continue'
  return 'unknown'
}

/** Holdout split: by RUN, deterministic, fixed before scoring (~1/3 holdout).
 * Runs are ranked by a seeded hash and the bottom third assigned to holdout, so
 * the fraction is exact for any run count and no run appears on both sides. */
export const SPLIT = Object.freeze({ seed: 'marathon-v2-v0', holdoutFraction: 1 / 3 })

function runHash(runId) {
  return createHash('sha256').update(`${SPLIT.seed}:${runId}`).digest('hex')
}

function assignSplits(dirs) {
  const ranked = [...dirs].sort((a, b) => runHash(a) < runHash(b) ? -1 : runHash(a) > runHash(b) ? 1 : 0)
  const holdoutCount = Math.max(1, Math.round(ranked.length * SPLIT.holdoutFraction))
  const holdout = new Set(ranked.slice(0, holdoutCount))
  const map = new Map()
  for (const d of dirs) map.set(d, holdout.has(d) ? 'holdout' : 'tune')
  return map
}

function parseArgs(argv) {
  const a = { build: false, ingest: null, only: null, archiveRoot: join(MAIN_ROOT, '.dsh-home/browser-agent/logs/m0-archive') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--build') a.build = true
    else if (argv[i] === '--ingest') a.ingest = argv[++i]
    else if (argv[i] === '--only') a.only = argv[++i]
    else if (argv[i] === '--archive-root') a.archiveRoot = argv[++i]
  }
  return a
}

function readEvents(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

/** Discover archive run dirs -> {scenario, batch, runs} from the baseline JSONs. */
function discoverArchives(archiveRoot) {
  const byDir = new Map()
  const baselines = join(ROOT, 'e2e/baselines')
  if (existsSync(baselines)) {
    for (const f of readdirSync(baselines).filter(x => x.endsWith('.json'))) {
      let j
      try { j = JSON.parse(readFileSync(join(baselines, f), 'utf8')) } catch { continue }
      if (!j.scenarios || !j.logArchiveRunDir) continue
      const dir = String(j.logArchiveRunDir).split('/').filter(Boolean).pop()
      for (const s of j.scenarios) {
        const prev = byDir.get(dir)
        // A run dir may host several scenarios (smokes); keep the primary watch
        // scenario (progressable/impossible) over 'other'.
        const cls = SCENARIO_CLASS[s.name] ?? 'other'
        if (!prev || (prev.cls === 'other' && cls !== 'other')) {
          byDir.set(dir, { dir, scenario: s.name, cls, batch: f, runs: s.runs ?? [], commitUnderTest: j.commitUnderTest ?? null })
        }
      }
    }
  }
  // Include archive dirs without a baseline (e.g. contaminated diagnostics).
  if (existsSync(archiveRoot)) {
    for (const dir of readdirSync(archiveRoot).filter(x => x.startsWith('run-'))) {
      if (!byDir.has(dir)) byDir.set(dir, { dir, scenario: 'unknown', cls: 'other', batch: null, runs: [], commitUnderTest: null })
    }
  }
  return byDir
}

/** Extract per-turn data + normalized replay frames from one archive. */
export function turnsFromEvents(events) {
  const starts = events.filter(e => e.type === 'turn.start')
  const turns = []
  for (const start of starts) {
    const turnId = start.turnId
    const startMs = Date.parse(start.time)
    const end = events.find(e => e.type === 'turn.end' && e.turnId === turnId)
    const endMs = end ? Date.parse(end.time) : startMs + 420_000
    const span = endMs - startMs
    const frames = []
    const toolCallTimes = []
    const helpTimes = []
    const confirmTimes = []
    for (const e of events) {
      if (e.turnId !== turnId) continue
      const at = Date.parse(e.time) - startMs
      if (at < 0 || at > span) continue
      if (e.type === 'tool.call') {
        toolCallTimes.push(at)
        frames.push({ at, frame: { type: 'chat.tool_call', callId: e.data.callId, name: e.data.name, args: e.data.args } })
      } else if (e.type === 'tool.result') {
        frames.push({ at, frame: { type: 'chat.tool_result', callId: e.data.callId, ok: e.data.ok !== false, text: e.data.text ?? '' } })
      } else if (e.type === 'assistant.text') {
        frames.push({ at, frame: { type: 'chat.assistant', text: e.data.text ?? '' } })
      } else if (e.type === 'plan.updated') {
        frames.push({ at, frame: { type: 'chat.activity', kind: 'plan', revision: e.data.revision, items: e.data.items ?? [] } })
      } else if (e.type === 'help.request') {
        helpTimes.push(at)
        frames.push({ at, frame: { type: 'chat.activity', kind: 'help-request', category: e.data.category, reason: e.data.reason } })
      } else if (e.type === 'confirm.request') {
        confirmTimes.push(at)
        frames.push({ at, frame: { type: 'chat.activity', kind: 'confirm-request', action: e.data.action, target: e.data.target } })
      } else if (e.type === 'notification' && e.data?.params?.event?.type === 'step/start') {
        frames.push({ at, frame: { type: 'chat.activity', kind: 'model-start' } })
      } else if (e.type === 'notification' && e.data?.params?.event?.type === 'assistant/message') {
        const blocks = e.data.params.event.data?.message?.content ?? []
        const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text ?? '').join('')
        if (reasoning) frames.push({ at, frame: { type: 'chat.activity', kind: 'reasoning', text: reasoning } })
      }
    }
    frames.sort((a, b) => a.at - b.at)
    const aborted = end?.data?.aborted === true
    const label = end?.data?.label ?? null
    const planOutcome = end?.data?.planOutcome ?? null
    const outcome = aborted ? 'stopped' : (label || planOutcome ? 'done' : (end?.data?.ok ? 'done' : 'error'))
    const endInfo = {
      outcome, label, planOutcome, deadTurn: false,
      help: helpTimes.length > 0, confirm: confirmTimes.length > 0,
    }
    turns.push({
      turnId, startMs, endMs, durationSec: Math.round(span / 1000), prompt: start.data.userText ?? '',
      frames, toolCallTimes, helpTimes, confirmTimes, endInfo,
    })
  }
  return turns
}

/** Server progress records for a turn (fixture-server accepted stations). */
function serverProgressForTurn(batchRun, turnId) {
  const recs = batchRun?.serverRecords
  if (!Array.isArray(recs)) return null
  const mine = recs.filter(r => r && r.method === 'POST' && r.path === '/marathon/step' && Number.isInteger(r.step) && (r.turnId === turnId || r.turnId == null))
  if (mine.length === 0) return null
  return mine.map(r => ({ step: r.step, atMs: Date.parse(r.acceptedAt) })).sort((a, b) => a.atMs - b.atMs)
}

/** Redo records: duplicate step within the run (across turns), at 2nd accept. */
function redoForRun(batchRun) {
  const recs = batchRun?.serverRecords
  if (!Array.isArray(recs)) {
    // Old archives: perStep.posts>1 reveals a redo exists but not its time.
    const per = batchRun?.evidence?.perStep
    if (Array.isArray(per)) return per.filter(p => p.posts > 1).map(p => ({ step: p.step, atSec: null, source: 'perStep.posts (no timestamp)' }))
    return []
  }
  const seen = new Map()
  const redos = []
  for (const r of recs.filter(x => x && x.method === 'POST' && x.path === '/marathon/step' && Number.isInteger(x.step)).sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt))) {
    if (seen.has(r.step)) redos.push({ step: r.step, atSec: null, atMs: Date.parse(r.acceptedAt), source: 'serverRecords duplicate' })
    else seen.set(r.step, true)
  }
  return redos
}

/**
 * Label one turn from independent state. Returns {label, labelRule, labelSource,
 * gated, onsetSec, windowStartSec, windowEndSec}.
 */
export function labelTurn(turn, scenario, batchRun, legacyLabel = null) {
  const cls = SCENARIO_CLASS[scenario] ?? 'other'
  const dur = turn.durationSec
  const fine = { label: 'fine', labelRule: null, labelSource: null, gated: false, onsetSec: null, windowStartSec: 0, windowEndSec: dur }
  const stuck = (t0, rule, source) => ({
    label: 'stuck', labelRule: rule, labelSource: source, gated: true, onsetSec: t0,
    windowStartSec: Math.max(0, t0 - PATIENCE.stuckWindowPreSec),
    windowEndSec: Math.min(dur, t0 + PATIENCE.stuckWindowPostSec),
  })

  if (cls === 'impossible') {
    // 120 s of acting with no help/confirm/final answer (independent log state).
    const t0 = PATIENCE.impossibleSec
    const callsInSpan = turn.toolCallTimes.filter(at => at <= t0 * 1000).length
    const helpBefore = turn.helpTimes.some(at => at < t0 * 1000)
    const confirmBefore = turn.confirmTimes.some(at => at < t0 * 1000)
    const endedBefore = dur <= t0
    if (!endedBefore && !helpBefore && !confirmBefore && callsInSpan >= PATIENCE.impossibleMinCalls) {
      return stuck(t0, 'impossible-120s', 'events.jsonl acting/help/confirm/end (independent state); impossible-by-design scenario, zero server progress')
    }
    return { ...fine, labelRule: 'impossible-120s', labelSource: 'events.jsonl acting/help/confirm/end (independent state)', gated: true }
  }

  if (cls === 'progressable') {
    const progress = serverProgressForTurn(batchRun, turn.turnId)
    if (progress !== null) {
      // 240 s since last server-accepted station (or turn start), >=3 calls, running.
      const progressRel = progress.map(p => Math.round((p.atMs - turn.startMs) / 1000)).filter(s => s >= 0 && s <= dur)
      let onset = null
      // candidate onset points: turn start (0) and each progress event
      const anchors = [0, ...progressRel]
      for (const a of anchors) {
        const t0 = a + PATIENCE.progressableSec
        if (t0 > dur) continue // turn ended before patience elapsed
        const callsInSpan = turn.toolCallTimes.filter(at => at >= a * 1000 && at <= t0 * 1000).length
        const helpBefore = turn.helpTimes.some(at => at < t0 * 1000)
        const confirmBefore = turn.confirmTimes.some(at => at < t0 * 1000)
        if (callsInSpan >= PATIENCE.progressableMinCalls && !helpBefore && !confirmBefore) { onset = t0; break }
      }
      if (onset !== null) return stuck(onset, 'server-progress-240s', 'batch serverRecords[].acceptedAt (fixture server clock)')
      return { ...fine, labelRule: 'server-progress-240s', labelSource: 'batch serverRecords[].acceptedAt (fixture server clock)', gated: true }
    }
    // Old archive without per-step server timestamps -> legacy-manual, not gated.
    return { ...fine, label: legacyLabel ?? 'fine', labelRule: 'legacy-manual', labelSource: 'v1 hand label (no per-step server timestamps in archive)', gated: false }
  }

  // other (click-once / unrelated-question): healthy short turns -> fine.
  return { ...fine, labelRule: 'healthy-short', labelSource: 'short healthy turn (no stall scenario)', gated: false }
}

/** v1 hand labels keyed by `${runDir}#${turnIndex}` from the M4 canonical replay. */
function legacyLabelMap() {
  const map = new Map()
  const archives = {
    m0Smoke: 'run-2026-11-17T01-07-02-137Z-f33f10', m0Long: 'run-2026-11-17T01-07-40-552Z-c02d66',
    m0Stall: 'run-2026-11-17T01-13-25-223Z-02b684', m0Signin: 'run-2026-11-17T01-20-21-564Z-2551a4',
    m1Long: 'run-2026-11-17T01-32-38-591Z-f80ac2', m2Long: 'run-2026-11-17T02-02-36-976Z-849181',
    m2tSuite1: 'run-2026-11-17T02-44-34-045Z-b5a71b', m2Suite2: 'run-2026-11-17T02-14-11-994Z-c82d46',
    m2Unrelated: 'run-2026-11-17T02-26-39-794Z-739f46', m3Long: 'run-2026-11-17T03-37-05-493Z-6d9d73',
    contaminatedStall: 'run-2026-11-17T00-43-57-262Z-2ab066',
  }
  const canonical = join(ROOT, 'docs/marathon/m4-evidence/replay-canonical.json')
  if (!existsSync(canonical)) return map
  const j = JSON.parse(readFileSync(canonical, 'utf8'))
  for (const w of j.windows) {
    if (w.synthetic || w.slice) continue
    const m = /^(.+)-r(\d+)$/.exec(w.id)
    if (!m) continue
    const dir = archives[m[1]]
    if (dir) map.set(`${dir}#${Number(m[2]) - 1}`, w.label)
  }
  return map
}

function writeTrace(turn, runDir, idx) {
  const runShort = runDir.replace('run-2026-11-17T', '').replace('run-2026-11-16T', '').replace('run-', '')
  const name = `${runShort}-t${idx + 1}.jsonl.gz`
  const header = {
    type: 'turn', turnId: turn.turnId, run: runDir, turnIndex: idx, prompt: turn.prompt,
    startMs: turn.startMs, endMs: turn.endMs, durationSec: turn.durationSec, endInfo: turn.endInfo, marathon: true,
  }
  const lines = [JSON.stringify(header), ...turn.frames.map(f => JSON.stringify(f))]
  const gz = gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
  mkdirSync(TRACES, { recursive: true })
  writeFileSync(join(TRACES, name), gz)
  return { file: `traces/${name}`, sha256: createHash('sha256').update(gz).digest('hex'), bytes: gz.length }
}

function build(args) {
  const byDir = discoverArchives(args.archiveRoot)
  const legacy = legacyLabelMap()
  const windows = []
  let traceBytes = 0
  const dirs = [...byDir.keys()].filter(d => args.only === null || d === args.only || d.includes(args.only))
  const splitMap = assignSplits(dirs)
  for (const dir of dirs) {
    const meta = byDir.get(dir)
    const file = join(args.archiveRoot, dir, 'events.jsonl')
    if (!existsSync(file)) { console.error(`skip ${dir}: no events.jsonl`); continue }
    const events = readEvents(file)
    const turns = turnsFromEvents(events)
    const split = splitMap.get(dir)
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i]
      // match batch run by turnId (or index)
      const batchRun = meta.runs.find(r => r.turnId === turn.turnId) ?? meta.runs[i] ?? null
      const scenario = meta.scenario !== 'unknown' ? meta.scenario : scenarioFromPrompt(turn.prompt)
      const lab = labelTurn(turn, scenario, batchRun, legacy.get(`${dir}#${i}`) ?? null)
      const trace = writeTrace(turn, dir, i)
      traceBytes += trace.bytes
      const redo = redoForRun(batchRun).map(r => ({ step: r.step, atSec: r.atMs != null ? Math.round((r.atMs - turn.startMs) / 1000) : null, source: r.source }))
      windows.push({
        id: `${dir.replace('run-2026-11-17T', '').replace('run-', '')}-t${i + 1}`,
        run: dir, turnId: turn.turnId, turnIndex: i, scenario, scenarioClass: SCENARIO_CLASS[scenario] ?? 'other',
        trace: trace.file, traceSha256: trace.sha256,
        label: lab.label, labelRule: lab.labelRule, labelSource: lab.labelSource, gated: lab.gated,
        onsetSec: lab.onsetSec, windowStartSec: lab.windowStartSec, windowEndSec: lab.windowEndSec,
        durationSec: turn.durationSec, split, redo: redo.length ? redo : null,
        legacyLabel: legacy.get(`${dir}#${i}`) ?? null,
        endClass: turn.endInfo.help ? 'help' : turn.endInfo.confirm ? 'confirm' : turn.endInfo.outcome === 'stopped' ? 'stopped' : (turn.endInfo.label ?? turn.endInfo.outcome),
        synthetic: false, commitUnderTest: meta.commitUnderTest,
      })
    }
  }
  const manifest = {
    version: 1, createdAt: new Date().toISOString(), patience: PATIENCE, split: SPLIT,
    scenarioClass: SCENARIO_CLASS,
    traceStorage: traceBytes <= 10 * 1024 * 1024 ? 'committed' : 'machine-local',
    traceBytes,
    counts: {
      windows: windows.length,
      fine: windows.filter(w => w.label === 'fine').length,
      stuck: windows.filter(w => w.label === 'stuck').length,
      gatedFine: windows.filter(w => w.label === 'fine' && w.gated).length,
      gatedStuck: windows.filter(w => w.label === 'stuck' && w.gated).length,
      legacyManual: windows.filter(w => w.labelRule === 'legacy-manual').length,
      distinctStuckRuns: new Set(windows.filter(w => w.label === 'stuck').map(w => w.run)).size,
      fineOver4min: windows.filter(w => w.label === 'fine' && w.durationSec > 240).length,
      holdoutRuns: new Set(windows.filter(w => w.split === 'holdout').map(w => w.run)).size,
      tuneRuns: new Set(windows.filter(w => w.split === 'tune').map(w => w.run)).size,
    },
    windows,
  }
  mkdirSync(CORPUS, { recursive: true })
  writeFileSync(join(CORPUS, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`manifest: ${windows.length} windows · fine ${manifest.counts.fine} · stuck ${manifest.counts.stuck} · gatedFine ${manifest.counts.gatedFine} · gatedStuck ${manifest.counts.gatedStuck} · legacyManual ${manifest.counts.legacyManual}`)
  console.log(`distinct stuck runs ${manifest.counts.distinctStuckRuns} · fine>4min ${manifest.counts.fineOver4min} · tuneRuns ${manifest.counts.tuneRuns} · holdoutRuns ${manifest.counts.holdoutRuns}`)
  console.log(`traces ${(traceBytes / 1024 / 1024).toFixed(2)} MiB -> ${manifest.traceStorage}`)
  return manifest
}

const args = parseArgs(process.argv.slice(2))
if (args.build) build(args)
else if (args.ingest) { console.error('--ingest implemented in step 4 (eval batches)'); process.exit(1) }
else { console.error('usage: watch-label.mjs --build [--only <runDir>] [--archive-root <p>]'); process.exit(1) }
