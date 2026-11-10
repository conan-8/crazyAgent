#!/usr/bin/env node
/**
 * Reproducible failure report for crazyAgent run logs (plan-temporary.md §A2).
 *
 * Reads the `events.jsonl` file inside every `run-<id>` folder under the logs
 * directory, streaming one JSON object per line, and prints the aggregate
 * failure picture: per-tool failure rates, the top
 * failure messages, repeated-failure runs inside a turn, stopped turns, turn
 * duration/call-count percentiles, tokens per turn, and the busiest sites by
 * tab activation. A monthly table reproduces plan section 0.
 *
 * Usage:
 *   node scripts/analyze-failures.mjs [--logs DIR] [--since DATE] [--runs N] [--json]
 *
 * Definitions (the log facts the plan calls out):
 *   - tool.call carries data.name; tool.result carries only callId/ok/text/
 *     durationMs, so failures are joined back to tool names on callId.
 *   - a failed tool call is a tool.result with ok:false; each one also emits a
 *     `signal` with code TOOL_FAILED whose message is
 *     `<tool> failed: Error: <text>`.
 *   - bridge.command.error carries data.op and data.code; only this event is
 *     parsed, because the browser side logs a duplicate browser.command.error
 *     for the same failed call.
 *   - turn.end carries ok, timings{totalMs,toolCalls,...} and token usage.
 *     turns "completed" are turn.end with ok:true (plan percentiles use those).
 *   - signal TURN_STOPPED marks user stops.
 *   - frame.in lines are ~86% of a busy log and duplicate other events; they
 *     are skipped before JSON.parse for speed.
 *
 * Privacy: run logs contain the user's page content. This script only emits
 * aggregate counts, tool names, error codes, hostnames, and digit-normalized
 * short failure text. Free text from a failure message is additionally
 * scrubbed of URLs, quoted page content, e-mail addresses, file names and
 * hashes, then truncated (default 160 characters). It never prints prompts,
 * page text, screenshots, full URLs or message bodies.
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

export const DEFAULT_LOGS_DIR = path.resolve('.dsh-home/browser-agent/logs')
export const DEFAULT_MESSAGE_LIMIT = 160
const MAX_LISTED_MESSAGES = 20
const MAX_LISTED_REPEATS = 10
const MAX_LISTED_SITES = 15
const MAX_LISTED_CODES = 15
const SHOW_TOOL_LIMIT = 200

// Tools called out explicitly in plan section 0; they get their own monthly row.
export const KEY_TOOLS = Object.freeze([
  'browser_click_at',
  'browser_click',
  'browser_screenshot',
  'browser_upload',
  'browser_drag',
])

const FRAME_LINE = /"type":"frame\.(?:in|out)"/
const TOOL_FAILED_PREFIX = /^[a-z_.]+ failed: Error: /
const SITES = Object.freeze([
  [/^docs\.google\.com$/, 'Docs'],
  [/^drive\.google\.com$/, 'Drive'],
  [/^mail\.google\.com$/, 'Gmail'],
  [/^classroom\.google\.com$/, 'Classroom'],
  [/^google\.[a-z.]+$/, 'Google'],
  [/^youtube\.com$/, 'YouTube'],
  [/schoology\.com$/, 'Schoology'],
  [/^gimkit\.com$/, 'Gimkit'],
  [/^instagram\.com$/, 'Instagram'],
  [/pivotinteractives\.com$/, 'Pivot'],
  [/onshape\.com$/, 'Onshape'],
  [/^(?:127\.0\.0\.1|localhost)$/, 'Local fixture'],
  [/^newtab$/, 'New tab'],
  [/^extensions$/, 'Extensions'],
])

const int = (value) => (Number.isFinite(value) ? value : 0)
const addCount = (map, key, field = 'count', by = 1) => {
  const entry = map.get(key) ?? {}
  entry[field] = int(entry[field]) + by
  map.set(key, entry)
}
const getEntry = (map, key, create) => {
  if (!map.has(key)) map.set(key, create())
  return map.get(key)
}

/**
 * Normalize a raw failure message for aggregation and printing.
 *
 * Keeps the diagnostic template, removes dynamic/user-specific content:
 * URLs, quoted page content, e-mail addresses, file names, long hashes, and
 * digits (so "within 5000ms" and "within 4000ms" aggregate together). The
 * result is capped at `maxLen` characters.
 */
export function sanitizeFailureText(text, maxLen = DEFAULT_MESSAGE_LIMIT) {
  let out = String(text ?? '')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/file:\/\/\S+/gi, '<file-url>')
    .replace(/Downloads:\s*[^;]*/gi, 'Downloads: <redacted>')
    .replace(/("|'|“|”|‘|’)[^"'“”‘’]{0,200}\1/g, '<quoted>')
    .replace(/\S+@\S+/g, '<email>')
    .replace(/\b[^\s"']+\.(?:docx?|pdf|xlsx?|pptx?|zip|png|jpe?g|gif|webp|txt|csv|json|mov|mp4)\b/gi, '<file>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
  if (maxLen != null && out.length > maxLen) out = out.slice(0, maxLen)
  return out
}

/** The model-reported completion labels recorded by A3 on `turn.end`. */
export const REPORTED_LABELS = Object.freeze(['done', 'partial', 'blocked'])

/**
 * Normalize a `turn.end` `label` field to one of done/partial/blocked/none.
 * Older logs have no label and the companion emits null when the final text
 * did not start with a reported label, so anything missing/unknown is `none`.
 */
export function normalizeReportedLabel(value) {
  if (typeof value !== 'string') return 'none'
  const label = value.trim().toLowerCase()
  return REPORTED_LABELS.includes(label) ? label : 'none'
}

/** Nearest-rank percentile (index `ceil(p*n)-1`), the definition plan §0 used. */
export function percentile(values, p) {
  if (!values || values.length === 0 || !(p >= 0 && p <= 1)) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(p * sorted.length))
  return sorted[Math.min(sorted.length - 1, rank - 1)]
}

/** Aggregate a numeric sample into {count,min,p50,p90,p99,max,sum}. */
export function summarizeValues(values) {
  if (!values || values.length === 0) return { count: 0, min: null, p50: null, p90: null, p99: null, max: null, sum: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    sum: sorted.reduce((a, b) => a + b, 0),
  }
}

/** Map a tab URL to an aggregate site label without exposing the full URL. */
export function siteLabelForUrl(url) {
  if (typeof url !== 'string' || url === '') return 'Unknown'
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'Unknown'
  }
  if (parsed.protocol === 'file:') return 'Local file'
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
  if (!host) return 'Unknown' // about:blank, browser-internal pages without a host
  for (const [pattern, label] of SITES) {
    if (pattern.test(host)) return label
  }
  return host
}

/** Parse the run start time out of `run-YYYY-MM-DDTHH-MM-SS-mmmZ-xxxxxx`. */
export function runStartTime(name) {
  const match = /^run-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name)
  if (!match) return null
  const [, year, month, day, hour, minute, second, milli] = match
  return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, +milli)
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7)
}

function createBucket() {
  return {
    runs: 0,
    turns: 0,
    completedTurns: 0,
    notOkTurns: 0,
    stoppedTurns: 0,
    labels: { completed: 0, done: 0, partial: 0, blocked: 0, none: 0 },
    stoppedDurations: [],
    stoppedFailedCalls: [],
    toolCalls: 0,
    failedToolCalls: 0,
    tools: new Map(),
    messages: new Map(),
    codes: new Map(),
    classes: {
      screenshotsPaused: 0,
      captureTimeouts: 0,
      staleCoordinates: 0,
      loopDetected: 0,
      sidePanelClosed: 0,
      dragNoEffect: 0,
    },
    sidePanelCallKeys: new Set(),
    sites: new Map(),
    unknownTabActivations: 0,
    durations: [],
    completedDurations: [],
    callCounts: [],
    completedCallCounts: [],
    tokens: {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      total: 0,
      inputValues: [],
      outputValues: [],
      totalValues: [],
    },
    repeats: {
      occurrences: 0,
      turnsWithRepeats: 0,
      patterns: new Map(), // `${tool}\u0000${message}` -> {tool,message,count,maxStreak}
    },
    malformedLines: 0,
    missingEventFiles: 0,
  }
}

function createRunAggregate() {
  return {
    ...createBucket(),
    turnFailures: new Map(),
    failedCallIds: new Set(),
  }
}

async function scanRun(runDir, runName) {
  const agg = createRunAggregate()
  const eventsFile = path.join(runDir, 'events.jsonl')
  if (!fs.existsSync(eventsFile)) {
    agg.missingEventFiles = 1
    return agg
  }

  const toolNamesByCall = new Map()
  const stream = fs.createReadStream(eventsFile, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line || !line.includes('"type":"')) continue
      // ~86% of a busy log: skip before JSON.parse.
      if (FRAME_LINE.test(line)) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        agg.malformedLines++
        continue
      }
      const data = event.data ?? {}
      switch (event.type) {
        case 'tool.call': {
          agg.toolCalls++
          const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : '(unknown)'
          addCount(agg.tools, name, 'calls')
          const callId = data.callId ?? event.callId
          if (typeof callId === 'string') toolNamesByCall.set(callId, name)
          break
        }
        case 'tool.result': {
          const callId = data.callId ?? event.callId
          const name = toolNamesByCall.get(callId) ?? '(unknown)'
          if (data.ok === false) {
            agg.failedToolCalls++
            addCount(agg.tools, name, 'failed')
            if (typeof callId === 'string') agg.failedCallIds.add(callId)
          }
          if (name === 'browser_drag' && String(data.text ?? '').includes('DRAG_NO_EFFECT')) {
            agg.classes.dragNoEffect++
          }
          const durationMs = Number(data.durationMs)
          if (Number.isFinite(durationMs) && durationMs >= 0) {
            const entry = getEntry(agg.tools, name, () => ({ calls: 0, failed: 0, durationMs: 0, durationCount: 0 }))
            entry.durationMs = int(entry.durationMs) + durationMs
            entry.durationCount = int(entry.durationCount) + 1
          }
          break
        }
        case 'bridge.command.error': {
          // The browser side emits a duplicate browser.command.error for the
          // same failed call; parsing only the bridge event avoids double counts.
          const op = typeof data.op === 'string' && data.op ? data.op : '(unknown)'
          const code = typeof data.code === 'string' && data.code ? data.code : '(none)'
          const key = `${op} / ${code}`
          const entry = getEntry(agg.codes, key, () => ({ events: 0, calls: new Set() }))
          entry.events++
          const callKey = `${event.runId ?? runName}|${event.turnId ?? ''}|${data.callId ?? event.callId ?? ''}`
          entry.calls.add(callKey)
          if (code === 'SIDE_PANEL_CLOSED') agg.sidePanelCallKeys.add(callKey)
          break
        }
        case 'tool.loop.detected':
          agg.classes.loopDetected++
          break
        case 'tab.active': {
          const site = siteLabelForUrl(data.url)
          if (site === 'Unknown') agg.unknownTabActivations++
          else addCount(agg.sites, site, 'count')
          break
        }
        case 'signal': {
          if (data.code === 'TURN_STOPPED') {
            agg.stoppedTurns++
          } else if (data.code === 'TOOL_FAILED') {
            const callId = event.callId ?? data.callId
            const tool = toolNamesByCall.get(callId) ?? '(unknown)'
            const rawText = String(data.message ?? '')
            const text = rawText.replace(TOOL_FAILED_PREFIX, '')
            const message = sanitizeFailureText(text)
            addCount(agg.messages, message, 'count')
            if (/Screenshots? are paused/i.test(text)) agg.classes.screenshotsPaused++
            if (/did not return a screenshot/i.test(text)) agg.classes.captureTimeouts++
            if (/(?:changed|scrolled) since the canvas view was captured/i.test(text)) {
              agg.classes.staleCoordinates++
            }
            const turnId = event.turnId ?? ''
            const failures = getEntry(agg.turnFailures, turnId, () => [])
            failures.push({ tool, message })
          }
          break
        }
        case 'turn.end': {
          agg.turns++
          const ok = data.ok !== false
          if (ok) agg.completedTurns++
          else agg.notOkTurns++
          if (ok) {
            agg.labels.completed++
            agg.labels[normalizeReportedLabel(data.label)]++
          }
          if (data.aborted === true) {
            // A3: stopped turns carry timings (and, going forward, failedCalls).
            // Turns without a field are excluded from that stat, never counted as 0.
            const stoppedMs = Number(data.timings?.totalMs)
            if (Number.isFinite(stoppedMs) && stoppedMs >= 0) agg.stoppedDurations.push(stoppedMs)
            const stoppedFailedCalls = Number(data.timings?.failedCalls)
            if (Number.isFinite(stoppedFailedCalls) && stoppedFailedCalls >= 0) {
              agg.stoppedFailedCalls.push(stoppedFailedCalls)
            }
          }
          const totalMs = Number(data.timings?.totalMs)
          if (Number.isFinite(totalMs) && totalMs >= 0) {
            agg.durations.push(totalMs)
            if (ok) agg.completedDurations.push(totalMs)
          }
          const toolCalls = Number(data.timings?.toolCalls)
          if (Number.isFinite(toolCalls) && toolCalls >= 0) {
            agg.callCounts.push(toolCalls)
            if (ok) agg.completedCallCounts.push(toolCalls)
          }
          const usage = data.usage
          if (usage && typeof usage === 'object') {
            const input = Number(usage.inputTokens)
            const output = Number(usage.outputTokens)
            const cacheRead = Number(usage.cacheReadTokens)
            const total = Number(usage.totalTokens)
            agg.tokens.turns++
            if (Number.isFinite(input)) {
              agg.tokens.input += input
              agg.tokens.inputValues.push(input)
            }
            if (Number.isFinite(output)) {
              agg.tokens.output += output
              agg.tokens.outputValues.push(output)
            }
            if (Number.isFinite(cacheRead)) agg.tokens.cacheRead += cacheRead
            if (Number.isFinite(total)) {
              agg.tokens.total += total
              agg.tokens.totalValues.push(total)
            }
          }
          break
        }
        default:
          break
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }

  // Runs of the same failure repeated back to back inside one turn (the
  // failure list is in log order; successes between failures are ignored).
  for (const failures of agg.turnFailures.values()) {
    let turnRepeats = 0
    let index = 0
    while (index < failures.length) {
      let end = index + 1
      while (
        end < failures.length &&
        failures[end].tool === failures[index].tool &&
        failures[end].message === failures[index].message
      ) {
        end++
      }
      const runLength = end - index
      if (runLength > 1) {
        agg.repeats.occurrences += runLength - 1
        turnRepeats++
        const patternKey = `${failures[index].tool}\u0000${failures[index].message}`
        const pattern = getEntry(agg.repeats.patterns, patternKey, () => ({
          tool: failures[index].tool,
          message: failures[index].message,
          count: 0,
          maxStreak: 0,
        }))
        pattern.count += runLength - 1
        pattern.maxStreak = Math.max(pattern.maxStreak, runLength)
      }
      index = end
    }
    if (turnRepeats > 0) agg.repeats.turnsWithRepeats++
  }

  return agg
}

function mergeRun(bucket, run) {
  bucket.runs++
  bucket.turns += run.turns
  bucket.completedTurns += run.completedTurns
  bucket.notOkTurns += run.notOkTurns
  bucket.stoppedTurns += run.stoppedTurns
  bucket.labels.completed += run.labels.completed
  bucket.labels.done += run.labels.done
  bucket.labels.partial += run.labels.partial
  bucket.labels.blocked += run.labels.blocked
  bucket.labels.none += run.labels.none
  bucket.stoppedDurations.push(...run.stoppedDurations)
  bucket.stoppedFailedCalls.push(...run.stoppedFailedCalls)
  bucket.toolCalls += run.toolCalls
  bucket.failedToolCalls += run.failedToolCalls
  bucket.malformedLines += run.malformedLines
  bucket.missingEventFiles += run.missingEventFiles
  bucket.unknownTabActivations += run.unknownTabActivations
  for (const [name, stats] of run.tools) {
    const entry = getEntry(bucket.tools, name, () => ({ calls: 0, failed: 0, durationMs: 0, durationCount: 0 }))
    entry.calls += int(stats.calls)
    entry.failed += int(stats.failed)
    entry.durationMs += int(stats.durationMs)
    entry.durationCount += int(stats.durationCount)
  }
  for (const [message, entry] of run.messages) addCount(bucket.messages, message, 'count', int(entry.count))
  for (const [key, entry] of run.codes) {
    const target = getEntry(bucket.codes, key, () => ({ events: 0, calls: new Set() }))
    target.events += entry.events
    for (const call of entry.calls) target.calls.add(call)
  }
  bucket.classes.screenshotsPaused += run.classes.screenshotsPaused
  bucket.classes.captureTimeouts += run.classes.captureTimeouts
  bucket.classes.staleCoordinates += run.classes.staleCoordinates
  bucket.classes.loopDetected += run.classes.loopDetected
  bucket.classes.sidePanelClosed += run.classes.sidePanelClosed
  bucket.classes.dragNoEffect += run.classes.dragNoEffect
  for (const key of run.sidePanelCallKeys) bucket.sidePanelCallKeys.add(key)
  for (const [site, entry] of run.sites) addCount(bucket.sites, site, 'count', int(entry.count))
  bucket.durations.push(...run.durations)
  bucket.completedDurations.push(...run.completedDurations)
  bucket.callCounts.push(...run.callCounts)
  bucket.completedCallCounts.push(...run.completedCallCounts)
  bucket.tokens.turns += run.tokens.turns
  bucket.tokens.input += run.tokens.input
  bucket.tokens.output += run.tokens.output
  bucket.tokens.cacheRead += run.tokens.cacheRead
  bucket.tokens.total += run.tokens.total
  bucket.tokens.inputValues.push(...run.tokens.inputValues)
  bucket.tokens.outputValues.push(...run.tokens.outputValues)
  bucket.tokens.totalValues.push(...run.tokens.totalValues)
  bucket.repeats.occurrences += run.repeats.occurrences
  bucket.repeats.turnsWithRepeats += run.repeats.turnsWithRepeats
  for (const [key, pattern] of run.repeats.patterns) {
    const target = getEntry(bucket.repeats.patterns, key, () => ({
      tool: pattern.tool,
      message: pattern.message,
      count: 0,
      maxStreak: 0,
    }))
    target.count += pattern.count
    target.maxStreak = Math.max(target.maxStreak, pattern.maxStreak)
  }
}

function rate(part, whole) {
  return whole > 0 ? part / whole : 0
}

function round(value) {
  return Math.round(value * 10000) / 10000
}

function toolRates(bucket) {
  const tools = []
  for (const [tool, stats] of bucket.tools) {
    const calls = int(stats.calls)
    const failed = int(stats.failed)
    tools.push({
      tool,
      calls,
      failed,
      failureRate: round(rate(failed, calls)),
      avgDurationMs: stats.durationCount ? Math.round((int(stats.durationMs) / stats.durationCount) * 10) / 10 : null,
    })
  }
  return tools.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
}

function codes(bucket) {
  return [...bucket.codes.entries()]
    .map(([key, entry]) => ({ code: key, events: entry.events, failedCalls: entry.calls.size }))
    .sort((a, b) => b.events - a.events || a.code.localeCompare(b.code))
}

function messages(bucket) {
  return [...bucket.messages.entries()]
    .map(([message, entry]) => ({ message, count: int(entry.count) }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
}

function repeatPatterns(bucket) {
  return [...bucket.repeats.patterns.values()].sort(
    (a, b) => b.count - a.count || b.maxStreak - a.maxStreak || a.tool.localeCompare(b.tool) || a.message.localeCompare(b.message)
  )
}

function sites(bucket) {
  return [...bucket.sites.entries()]
    .map(([site, entry]) => ({ site, activations: int(entry.count) }))
    .sort((a, b) => b.activations - a.activations || a.site.localeCompare(b.site))
}

function tokenSummary(values, bucket) {
  const summary = summarizeValues(values)
  return {
    total: summary.sum,
    p50: summary.p50,
    p90: summary.p90,
    max: summary.max,
  }
}

function bucketSummary(bucket) {
  return {
    runs: bucket.runs,
    turns: bucket.turns,
    completedTurns: bucket.completedTurns,
    notOkTurns: bucket.notOkTurns,
    notOkRate: round(rate(bucket.notOkTurns, bucket.turns)),
    stoppedTurns: bucket.stoppedTurns,
    stoppedRate: round(rate(bucket.stoppedTurns, bucket.turns)),
    toolCalls: bucket.toolCalls,
    failedToolCalls: bucket.failedToolCalls,
    failureRate: round(rate(bucket.failedToolCalls, bucket.toolCalls)),
    classes: { ...bucket.classes, sidePanelClosed: bucket.sidePanelCallKeys.size || bucket.classes.sidePanelClosed },
  }
}

function labelSummary(labels) {
  const completedTurns = labels.completed
  const counts = { done: labels.done, partial: labels.partial, blocked: labels.blocked, none: labels.none }
  const shares = {}
  for (const label of [...REPORTED_LABELS, 'none']) shares[label] = round(rate(counts[label], completedTurns))
  return { completedTurns, counts, shares }
}

function createReport(months, overall, scope) {
  const monthReports = [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, bucket]) => {
      const summary = bucketSummary(bucket)
      return {
        month,
        ...summary,
        labels: labelSummary(bucket.labels),
        tools: toolRates(bucket),
      }
    })
  return {
    scope,
    totals: bucketSummary(overall),
    labels: labelSummary(overall.labels),
    months: monthReports,
    tools: toolRates(overall),
    failureMessages: messages(overall),
    failureCodes: codes(overall),
    repeatedFailures: {
      turnsWithRepeats: overall.repeats.turnsWithRepeats,
      occurrences: overall.repeats.occurrences,
      patterns: repeatPatterns(overall),
    },
    stoppedTurnStats: {
      durationMs: summarizeValues(overall.stoppedDurations),
      failedCalls: summarizeValues(overall.stoppedFailedCalls),
    },
    percentiles: {
      completed: {
        turns: overall.completedTurns,
        toolCalls: summarizeValues(overall.completedCallCounts),
        durationMs: summarizeValues(overall.completedDurations),
      },
      all: {
        turns: overall.turns,
        toolCalls: summarizeValues(overall.callCounts),
        durationMs: summarizeValues(overall.durations),
      },
    },
    tokens: {
      turnsWithUsage: overall.tokens.turns,
      input: tokenSummary(overall.tokens.inputValues),
      output: tokenSummary(overall.tokens.outputValues),
      cacheRead: overall.tokens.cacheRead,
      total: tokenSummary(overall.tokens.totalValues),
    },
    sites: sites(overall),
  }
}

async function listRunDirectories(logsDir) {
  if (!fs.existsSync(logsDir) || !fs.statSync(logsDir).isDirectory()) {
    throw new Error(`logs directory not found: ${logsDir}`)
  }
  const runs = []
  for (const name of fs.readdirSync(logsDir)) {
    if (!name.startsWith('run-')) continue
    const fullPath = path.join(logsDir, name)
    let stat
    try {
      stat = fs.statSync(fullPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const start = runStartTime(name)
    if (start == null) continue
    runs.push({ name, start, dir: fullPath })
  }
  runs.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name))
  return runs
}

/**
 * Analyze run logs and return an aggregate report object.
 *
 * @param {object} [options]
 * @param {string} [options.logsDir] directory containing `run-*` folders
 * @param {string|Date} [options.since] include runs that started at/after this date
 * @param {number} [options.runs] keep only the latest N runs (after `since`)
 * @returns {Promise<object>} aggregate report (no page content)
 */
export async function analyzeLogs({ logsDir = DEFAULT_LOGS_DIR, since = null, runs = null } = {}) {
  if (typeof logsDir !== 'string' || logsDir.length === 0) throw new Error('logsDir must be a non-empty string')
  let sinceTime = null
  if (since != null) {
    const parsed = since instanceof Date ? since.getTime() : Date.parse(String(since))
    if (!Number.isFinite(parsed)) throw new Error(`--since is not a valid date: ${since}`)
    sinceTime = parsed
  }
  if (runs != null) {
    if (!Number.isInteger(runs) || runs <= 0) throw new Error(`--runs must be a positive integer: ${runs}`)
  }

  const discovered = await listRunDirectories(logsDir)
  const afterSince = sinceTime == null ? discovered : discovered.filter((run) => run.start >= sinceTime)
  const selected = runs == null ? afterSince : afterSince.slice(-runs)

  const months = new Map()
  const overall = createBucket()
  const missingEventFiles = []
  for (const run of selected) {
    const runAggregate = await scanRun(run.dir, run.name)
    if (runAggregate.missingEventFiles) missingEventFiles.push(run.name)
    const month = monthKey(run.start)
    if (!months.has(month)) months.set(month, createBucket())
    mergeRun(months.get(month), runAggregate)
    mergeRun(overall, runAggregate)
  }

  const scope = {
    logsDir,
    discoveredRuns: discovered.length,
    includedRuns: selected.length,
    since: sinceTime == null ? null : new Date(sinceTime).toISOString(),
    runsRequested: runs,
    from: selected.length ? new Date(selected[0].start).toISOString() : null,
    to: selected.length ? new Date(selected[selected.length - 1].start).toISOString() : null,
    excludedBySince: discovered.length - afterSince.length,
    excludedByRuns: afterSince.length - selected.length,
    runsWithoutEvents: missingEventFiles,
    malformedLines: overall.malformedLines,
    unknownTabActivations: overall.unknownTabActivations,
  }
  return createReport(months, overall, scope)
}

function fmtInt(value) {
  if (value == null) return '-'
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtPct(fraction) {
  return `${(fraction * 100).toFixed(1)}%`
}

function fmtMs(ms) {
  if (ms == null) return '-'
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtDurationStat(stat, formatter = fmtMs) {
  if (!stat || stat.count === 0) return 'n/a'
  return `p50 ${formatter(stat.p50)} | p90 ${formatter(stat.p90)} | p99 ${formatter(stat.p99)} | max ${formatter(stat.max)}`
}

function fmtCallStat(stat) {
  if (!stat || stat.count === 0) return 'n/a'
  return `p50 ${fmtInt(stat.p50)} | p90 ${fmtInt(stat.p90)} | p99 ${fmtInt(stat.p99)} | max ${fmtInt(stat.max)}`
}

function fmtTokenStat(stat) {
  if (!stat || stat.p50 == null) return 'n/a'
  return `total ${fmtInt(stat.total)} | p50 ${fmtInt(stat.p50)} | p90 ${fmtInt(stat.p90)} | max ${fmtInt(stat.max)}`
}

function table(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[index] ?? '').length))
  )
  const line = (cells) =>
    cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ')
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)]
}

function toolRateCell(bucket, tool) {
  if (!bucket) return '-'
  const stats = bucket.tools.get(tool) ?? { calls: 0, failed: 0 }
  const calls = int(stats.calls)
  const failed = int(stats.failed)
  return `${fmtInt(failed)} / ${fmtInt(calls)} (${fmtPct(rate(failed, calls))})`
}

/**
 * Render a human-readable report (the same data `--json` returns).
 * @param {object} report result of analyzeLogs
 * @returns {string}
 */
export function formatReport(report) {
  const lines = []
  const { scope, totals } = report
  lines.push('crazyAgent failure report')
  lines.push(`logs dir: ${scope.logsDir}`)
  const range =
    scope.from && scope.to
      ? `${scope.from.slice(0, 10)} -> ${scope.to.slice(0, 10)}`
      : 'no runs selected'
  lines.push(
    `runs: ${scope.includedRuns} of ${scope.discoveredRuns} (${range})` +
      (scope.since ? ` [since ${scope.since.slice(0, 10)}]` : '') +
      (scope.runsRequested ? ` [latest ${scope.runsRequested}]` : '')
  )
  lines.push(
    `turns: ${fmtInt(totals.turns)} | tool calls: ${fmtInt(totals.toolCalls)} | failed tool calls: ` +
      `${fmtInt(totals.failedToolCalls)} (${fmtPct(totals.failureRate)}) | stopped turns: ` +
      `${fmtInt(totals.stoppedTurns)} (${fmtPct(totals.stoppedRate)})`
  )
  if (scope.runsWithoutEvents.length) {
    lines.push(
      `note: ${scope.runsWithoutEvents.length} included run(s) have no events.jsonl; ` +
        `malformed lines skipped: ${scope.malformedLines}; tab activations without a usable URL: ` +
        `${scope.unknownTabActivations}`
    )
  }

  // --- Monthly measures (plan section 0 reproduction) -----------------------
  lines.push('')
  lines.push('== Monthly measures (reproduces plan-temporary.md section 0) ==')
  const monthRows = [
    ['runs', (month) => fmtInt(month.runs)],
    ['turns', (month) => fmtInt(month.turns)],
    ['turns completed (ok)', (month) => fmtInt(month.completedTurns)],
    ['turns not ok', (month) => fmtInt(month.notOkTurns)],
    ['turns stopped', (month) => `${fmtInt(month.stoppedTurns)} (${fmtPct(month.stoppedRate)})`],
    ['tool calls', (month) => fmtInt(month.toolCalls)],
    ['failed tool calls', (month) => `${fmtInt(month.failedToolCalls)} (${fmtPct(month.failureRate)})`],
    ...KEY_TOOLS.map((tool) => [
      `${tool} failures`,
      (month) => {
        const stats = month.tools.find((entry) => entry.tool === tool) ?? { calls: 0, failed: 0 }
        return `${fmtInt(stats.failed)} / ${fmtInt(stats.calls)} (${fmtPct(rate(int(stats.failed), int(stats.calls)))})`
      },
    ]),
    ['screenshots paused', (month) => fmtInt(month.classes.screenshotsPaused)],
    ['capture timeouts', (month) => fmtInt(month.classes.captureTimeouts)],
    ['stale-coordinate refusals', (month) => fmtInt(month.classes.staleCoordinates)],
    ['loop detected', (month) => fmtInt(month.classes.loopDetected)],
    ['side panel closed', (month) => fmtInt(month.classes.sidePanelClosed)],
    ['drag no-effect outcomes', (month) => fmtInt(month.classes.dragNoEffect)],
  ]
  const monthTableRows = monthRows.map(([label, cell]) => [label, ...report.months.map((month) => cell(month))])
  lines.push(...table(['measure', ...report.months.map((month) => month.month)], monthTableRows))
  lines.push(`all runs: ${fmtInt(totals.runs)} | turns ${fmtInt(totals.turns)} | tool calls ${fmtInt(totals.toolCalls)} | failed ${fmtInt(totals.failedToolCalls)} (${fmtPct(totals.failureRate)})`)

  // --- Per-tool calls and failure rate -------------------------------------
  lines.push('')
  lines.push('== Calls and failure rate per tool ==')
  const toolRows = report.tools
    .slice(0, SHOW_TOOL_LIMIT)
    .map((tool) => [tool.tool, fmtInt(tool.calls), fmtInt(tool.failed), fmtPct(tool.failureRate), tool.avgDurationMs == null ? '-' : fmtMs(tool.avgDurationMs)])
  lines.push(...table(['tool', 'calls', 'failed', 'rate', 'avg'], toolRows))

  // --- Failure codes -------------------------------------------------------
  lines.push('')
  lines.push('== Error codes (distinct failed calls, bridge.command.error) ==')
  const codeRows = report.failureCodes
    .slice(0, MAX_LISTED_CODES)
    .map((code) => [code.code, fmtInt(code.events), fmtInt(code.failedCalls)])
  lines.push(...table(['op / code', 'events', 'failed calls'], codeRows))

  // --- Top failure messages ------------------------------------------------
  lines.push('')
  lines.push('== Top failure messages (digits normalized, page content redacted, capped at 160 chars) ==')
  for (const entry of report.failureMessages.slice(0, MAX_LISTED_MESSAGES)) {
    lines.push(`  ${String(entry.count).padStart(4)}  ${entry.message}`)
  }
  if (report.failureMessages.length > MAX_LISTED_MESSAGES) {
    lines.push(`  ... ${report.failureMessages.length - MAX_LISTED_MESSAGES} more distinct messages`)
  }

  // --- Back-to-back repeated failures --------------------------------------
  lines.push('')
  lines.push('== Back-to-back repeated failures within one turn ==')
  lines.push(
    `turns with a repeated failure: ${fmtInt(report.repeatedFailures.turnsWithRepeats)} of ${fmtInt(
      totals.turns
    )} (${fmtPct(rate(report.repeatedFailures.turnsWithRepeats, totals.turns))}); ` +
      `extra repeat occurrences: ${fmtInt(report.repeatedFailures.occurrences)}`
  )
  const repeatRows = report.repeatedFailures.patterns
    .slice(0, MAX_LISTED_REPEATS)
    .map((pattern) => [fmtInt(pattern.count), fmtInt(pattern.maxStreak), pattern.tool, displayMessage(pattern.message)])
  if (repeatRows.length) lines.push(...table(['repeats', 'max streak', 'tool', 'message'], repeatRows))

  // --- Reported completion labels (A3) ------------------------------------
  lines.push('')
  lines.push('== Reported completion labels (model-reported, not verification) ==')
  lines.push('completed turns are the denominator; a missing label (older logs) counts as none.')
  const labelCol = (summary, label) => `${fmtInt(summary.counts[label])} (${fmtPct(summary.shares[label])})`
  const labelRows = [
    ['completed turns', fmtInt(report.labels.completedTurns), ...report.months.map((month) => fmtInt(month.labels.completedTurns))],
    ...['done', 'partial', 'blocked', 'none'].map((label) => [
      label,
      labelCol(report.labels, label),
      ...report.months.map((month) => labelCol(month.labels, label)),
    ]),
  ]
  lines.push(...table(['label', 'overall', ...report.months.map((month) => month.month)], labelRows))

  // --- Stopped turns -------------------------------------------------------
  lines.push('')
  lines.push('== Stopped turns ==')
  lines.push(`stopped: ${fmtInt(totals.stoppedTurns)} of ${fmtInt(totals.turns)} turns (${fmtPct(totals.stoppedRate)})`)
  lines.push(
    'by month: ' +
      report.months
        .map((month) => `${month.month}: ${fmtInt(month.stoppedTurns)}/${fmtInt(month.turns)} (${fmtPct(month.stoppedRate)})`)
        .join(' | ')
  )
  const stoppedDuration = report.stoppedTurnStats.durationMs
  const stoppedFailedCalls = report.stoppedTurnStats.failedCalls
  lines.push(
    `elapsed duration: median ${stoppedDuration.p50 == null ? 'n/a' : fmtMs(stoppedDuration.p50)} (n=${fmtInt(stoppedDuration.count)})` +
      ` | failed calls: median ${stoppedFailedCalls.p50 == null ? 'n/a' : fmtInt(stoppedFailedCalls.p50)} (n=${fmtInt(stoppedFailedCalls.count)})`
  )
  lines.push('turns without the timing fields are excluded from a stat, not counted as 0.')

  // --- Percentiles ---------------------------------------------------------
  lines.push('')
  lines.push('== Turn duration and tool-call percentiles ==')
  const completed = report.percentiles.completed
  const all = report.percentiles.all
  lines.push(`completed turns (turn.end ok:true): ${fmtInt(completed.turns)}`)
  lines.push(`  tool calls:  ${fmtCallStat(completed.toolCalls)}`)
  lines.push(`  duration:    ${fmtDurationStat(completed.durationMs)}`)
  lines.push(`all ended turns: ${fmtInt(all.turns)}`)
  lines.push(`  tool calls:  ${fmtCallStat(all.toolCalls)}`)
  lines.push(`  duration:    ${fmtDurationStat(all.durationMs)}`)

  // --- Tokens --------------------------------------------------------------
  lines.push('')
  lines.push('== Tokens per turn ==')
  lines.push(`turns with token usage: ${fmtInt(report.tokens.turnsWithUsage)}`)
  lines.push(`  input      ${fmtTokenStat(report.tokens.input)}`)
  lines.push(`  output     ${fmtTokenStat(report.tokens.output)}`)
  lines.push(`  total      ${fmtTokenStat(report.tokens.total)}`)
  lines.push(`  cache read total ${fmtInt(report.tokens.cacheRead)}`)

  // --- Sites ---------------------------------------------------------------
  lines.push('')
  lines.push('== Top sites by tab activation ==')
  const siteRows = report.sites.slice(0, MAX_LISTED_SITES).map((site) => [site.site, fmtInt(site.activations)])
  lines.push(...table(['site', 'activations'], siteRows))
  if (scope.unknownTabActivations) {
    lines.push(`note: ${fmtInt(scope.unknownTabActivations)} tab activation(s) had no usable URL and are excluded`)
  }

  return lines.join('\n')
}

function displayMessage(message) {
  return message.length <= DEFAULT_MESSAGE_LIMIT ? message : message.slice(0, DEFAULT_MESSAGE_LIMIT)
}

const USAGE = `Usage: node scripts/analyze-failures.mjs [--logs DIR] [--since DATE] [--runs N] [--json]

  --logs DIR    run-log directory (default: ${DEFAULT_LOGS_DIR})
  --since DATE  only runs that started at/after DATE (e.g. 2026-11-03)
  --runs N      only the latest N runs (applied after --since)
  --json        print the aggregate report as JSON`

async function main(argv) {
  const options = { logsDir: DEFAULT_LOGS_DIR, since: null, runs: null }
  let asJson = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') {
      asJson = true
    } else if (arg === '--logs' || arg === '--since' || arg === '--runs') {
      const value = argv[index + 1]
      if (value == null || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      index++
      if (arg === '--logs') options.logsDir = path.resolve(value)
      else if (arg === '--since') options.since = value
      else options.runs = Number(value)
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      return
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (options.runs != null && (!Number.isInteger(options.runs) || options.runs <= 0)) {
    throw new Error(`--runs must be a positive integer: ${options.runs}`)
  }
  const report = await analyzeLogs(options)
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(formatReport(report))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`analyze-failures: ${error.message}`)
    process.exitCode = 1
  })
}