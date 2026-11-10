// Synthetic-log coverage for scripts/analyze-failures.mjs (plan-temporary.md §A2,
// extended for A3: reported completion labels + stopped-turn cost/failure stats).
//
// The log tree below is fabricated: it has known counts for every report section,
// including A3's `turn.end.label` / `timings.failedCalls` / partial stopped-turn
// usage. Real run logs contain the user's page content and are never used here.

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeLogs,
  formatReport,
  normalizeReportedLabel,
  percentile,
  runStartTime,
  sanitizeFailureText,
  siteLabelForUrl,
} from '../../scripts/analyze-failures.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'analyze-failures.mjs')

let logsRoot

const call = (turnId, callId, name) => ({ type: 'tool.call', turnId, data: { callId, name } })
const result = (turnId, callId, ok, extra = {}) => ({
  type: 'tool.result',
  turnId,
  data: { callId, ok, text: ok ? 'ok' : 'failed', ...extra },
})
const failed = (turnId, callId, message) => ({
  type: 'signal',
  turnId,
  callId,
  data: { code: 'TOOL_FAILED', message },
})
const bridgeError = (turnId, callId, op, code) => ({
  type: 'bridge.command.error',
  turnId,
  data: { op, code, callId },
})
const turnEnd = (turnId, data) => ({ type: 'turn.end', turnId, data })
const tab = (url) => ({ type: 'tab.active', data: { url } })

function writeRun(root, name, lines) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const body = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')
  writeFileSync(join(dir, 'events.jsonl'), `${body}\n`)
}

before(() => {
  logsRoot = mkdtempSync(join(tmpdir(), 'crazyagent-analyze-failures-'))

  // October run: 4 turns — done, partial, label-less (old-style), and stopped.
  writeRun(logsRoot, 'run-2026-10-01T10-00-00-000Z-alpha', [
    { type: 'frame.in', data: { ignored: 'x'.repeat(500) } },
    '{"type":"tool.call","data":', // malformed but looks like an event
    { type: 'turn.start', turnId: 't1', data: {} },
    call('t1', 'c1', 'browser_click_at'),
    result('t1', 'c1', true, { durationMs: 100 }),
    call('t1', 'c2', 'browser_click'),
    result('t1', 'c2', false, { durationMs: 200 }),
    failed('t1', 'c2', 'browser_click failed: Error: No visible button named "Submit" appeared within 5000ms'),
    bridgeError('t1', 'c2', 'click', 'UNKNOWN_LABEL'),
    call('t1', 'c3', 'browser_click'),
    result('t1', 'c3', false, { durationMs: 300 }),
    failed('t1', 'c3', 'browser_click failed: Error: No visible button named "Submit" appeared within 4000ms'),
    bridgeError('t1', 'c3', 'click', 'UNKNOWN_LABEL'),
    call('t1', 'c4', 'browser_screenshot'),
    result('t1', 'c4', false),
    failed('t1', 'c4', 'browser_screenshot failed: Error: Screenshots are paused for 30s after a Chrome capture timeout'),
    call('t1', 'c5', 'browser_screenshot'),
    result('t1', 'c5', false),
    failed(
      't1',
      'c5',
      'browser_screenshot failed: Error: Chrome did not return a screenshot within 30000ms; captures are paused for 30s'
    ),
    call('t1', 'c6', 'browser_click_at'),
    result('t1', 'c6', false),
    failed(
      't1',
      'c6',
      'browser_click_at failed: Error: The viewport changed since the canvas view was captured. Take a full fresh view and measure the coordinates again.'
    ),
    bridgeError('t1', 'c6', 'click_at', 'STALE_VIEW'),
    { type: 'tool.loop.detected', turnId: 't1', data: { tool: 'browser_click' } },
    { type: 'tool.loop.detected', turnId: 't1', data: { tool: 'browser_click' } },
    tab('https://docs.google.com/document/d/abc123/edit?gid=9'),
    tab('https://docs.google.com/document/d/other/edit'),
    tab('https://example.com/private?token=secret'),
    tab('file:///home/someone/private-resume.docx'),
    tab(''),
    tab(''),
    tab(''),
    tab(''),
    turnEnd('t1', {
      ok: true,
      label: 'done',
      timings: { totalMs: 1000, toolCalls: 6, failedCalls: 5 },
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 50 },
    }),
    { type: 'turn.start', turnId: 't2', data: {} },
    turnEnd('t2', {
      ok: true,
      label: 'partial',
      timings: { totalMs: 1500, toolCalls: 0, failedCalls: 0 },
    }),
    // Older logs have no label and no timings.failedCalls; both are tolerated.
    { type: 'turn.start', turnId: 't3', data: {} },
    turnEnd('t3', { ok: true, timings: { totalMs: 1200, toolCalls: 0 } }),
    { type: 'turn.start', turnId: 't4', data: {} },
    call('t4', 'c7', 'browser_click'),
    result('t4', 'c7', false),
    failed(
      't4',
      'c7',
      'browser_click failed: Error: The crazyAgent side panel is disconnected or reloading; retry this call'
    ),
    bridgeError('t4', 'c7', 'click', 'SIDE_PANEL_CLOSED'),
    // browser.command.error duplicates bridge.command.error for the same call;
    // the report must count the bridge event only.
    {
      type: 'browser.command.error',
      turnId: 't4',
      data: { op: 'click', callId: 'c7', error: { code: 'SIDE_PANEL_CLOSED', message: 'duplicate' } },
    },
    { type: 'signal', turnId: 't4', data: { code: 'TURN_STOPPED' } },
    turnEnd('t4', {
      ok: false,
      aborted: true,
      reason: 'user',
      label: null,
      timings: { totalMs: 2000, toolCalls: 1, failedCalls: 1 },
      usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, cacheReadTokens: 0 },
    }),
  ])

  // November run: one blocked completed turn and one old-style stopped turn
  // without timings.failedCalls/usage (excluded from those stats, not counted 0).
  writeRun(logsRoot, 'run-2026-11-02T10-00-00-000Z-bravo', [
    { type: 'turn.start', turnId: 't5', data: {} },
    call('t5', 'c0', 'browser_drag'),
    result('t5', 'c0', true, { text: 'Drag reported DRAG_NO_EFFECT' }),
    call('t5', 'c1', 'browser_upload'),
    result('t5', 'c1', false),
    failed(
      't5',
      'c1',
      'browser_upload failed: Error: The requested file does not exist in Downloads: Chapter 5 Review Package-Oct5.docx'
    ),
    bridgeError('t5', 'c1', 'upload', 'UPLOAD_READBACK_FAILED'),
    call('t5', 'c2', 'browser_drag'),
    result('t5', 'c2', false),
    failed(
      't5',
      'c2',
      `browser_drag failed: Error: The page scrolled since the canvas view was captured. Take a full fresh view and measure the coordinates again. ${'diagnostic '.repeat(30)}`
    ),
    tab('https://docs.google.com/document/d/xyz/edit'),
    tab('https://crescentschool.schoology.com/assignment/123'),
    { type: 'tool.loop.detected', turnId: 't5', data: { tool: 'browser_drag' } },
    turnEnd('t5', {
      ok: true,
      label: 'blocked',
      timings: { totalMs: 2500, toolCalls: 3, failedCalls: 2 },
      usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220, cacheReadTokens: 0 },
    }),
    { type: 'turn.start', turnId: 't6', data: {} },
    { type: 'signal', turnId: 't6', data: { code: 'TURN_STOPPED' } },
    turnEnd('t6', { ok: false, aborted: true, reason: 'user', timings: { totalMs: 3000, toolCalls: 0 } }),
  ])

  // A run directory without events.jsonl is still counted as a run.
  mkdirSync(join(logsRoot, 'run-2026-11-05T10-00-00-000Z-charlie'), { recursive: true })
  mkdirSync(join(logsRoot, 'not-a-run'), { recursive: true })
})

after(() => {
  if (logsRoot) rmSync(logsRoot, { recursive: true, force: true })
})

test('sanitizeFailureText normalizes digits and redacts page content', () => {
  assert.equal(
    sanitizeFailureText('No visible button named "Submit" appeared within 5000ms'),
    'No visible button named <quoted> appeared within Nms'
  )
  assert.equal(
    sanitizeFailureText('The requested file does not exist in Downloads: Chapter 5 Review Package-Oct5.docx'),
    'The requested file does not exist in Downloads: <redacted>'
  )
  assert.equal(
    sanitizeFailureText('Fetch https://docs.google.com/document/d/1/edit before retrying'),
    'Fetch <url> before retrying'
  )
  assert.equal(sanitizeFailureText('id deadbeefdeadbeefdeadbeef failed'), 'id <id> failed')
  assert.equal(sanitizeFailureText('x'.repeat(300)).length, 160)
  assert.equal(sanitizeFailureText(null), '')
})

test('normalizeReportedLabel accepts only the three reported labels', () => {
  assert.equal(normalizeReportedLabel('done'), 'done')
  assert.equal(normalizeReportedLabel('DONE'), 'done')
  assert.equal(normalizeReportedLabel(' partial '), 'partial')
  assert.equal(normalizeReportedLabel('blocked'), 'blocked')
  assert.equal(normalizeReportedLabel(null), 'none')
  assert.equal(normalizeReportedLabel(undefined), 'none')
  assert.equal(normalizeReportedLabel('finished'), 'none')
  assert.equal(normalizeReportedLabel(42), 'none')
})

test('percentile uses nearest rank and rejects empty/invalid input', () => {
  assert.equal(percentile([1, 2, 3], 0.5), 2)
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2)
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1)
  assert.equal(percentile(hundred, 0.5), 50)
  assert.equal(percentile(hundred, 0.9), 90)
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([1], 2), null)
})

test('run timestamps and site labels are derived without exposing URLs', () => {
  assert.equal(runStartTime('run-2026-10-01T10-00-00-000Z-alpha'), Date.UTC(2026, 9, 1, 10, 0, 0, 0))
  assert.equal(runStartTime('not-a-run'), null)
  assert.equal(siteLabelForUrl('https://docs.google.com/document/d/1/edit?x=2'), 'Docs')
  assert.equal(siteLabelForUrl('https://mail.google.com/mail/u/0/'), 'Gmail')
  assert.equal(siteLabelForUrl('https://crescentschool.schoology.com/x'), 'Schoology')
  assert.equal(siteLabelForUrl('https://example.com/private?token=secret'), 'example.com')
  assert.equal(siteLabelForUrl('file:///home/someone/private.docx'), 'Local file')
  assert.equal(siteLabelForUrl('about:blank'), 'Unknown')
  assert.equal(siteLabelForUrl(''), 'Unknown')
})

test('analyzeLogs reproduces known totals from the synthetic tree', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })

  assert.equal(report.scope.discoveredRuns, 3)
  assert.equal(report.scope.includedRuns, 3)
  assert.equal(report.scope.from, '2026-10-01T10:00:00.000Z')
  assert.equal(report.scope.to, '2026-11-05T10:00:00.000Z')
  assert.equal(report.scope.runsWithoutEvents.length, 1)
  assert.equal(report.scope.malformedLines, 1)
  assert.equal(report.scope.unknownTabActivations, 4)

  assert.equal(report.totals.runs, 3)
  assert.equal(report.totals.turns, 6)
  assert.equal(report.totals.completedTurns, 4)
  assert.equal(report.totals.notOkTurns, 2)
  assert.equal(report.totals.stoppedTurns, 2)
  assert.equal(report.totals.toolCalls, 10)
  assert.equal(report.totals.failedToolCalls, 8)
  assert.equal(report.totals.failureRate, 0.8)

  // Monthly measures (the plan section-0 table).
  const october = report.months.find((month) => month.month === '2026-10')
  const november = report.months.find((month) => month.month === '2026-11')
  assert.ok(october && november)
  assert.equal(october.runs, 1)
  assert.equal(october.turns, 4)
  assert.equal(october.completedTurns, 3)
  assert.equal(october.toolCalls, 7)
  assert.equal(october.failedToolCalls, 6)
  assert.deepEqual(october.classes, {
    screenshotsPaused: 1,
    captureTimeouts: 1,
    staleCoordinates: 1,
    loopDetected: 2,
    sidePanelClosed: 1,
    dragNoEffect: 0,
  })
  assert.equal(november.runs, 2)
  assert.equal(november.turns, 2)
  assert.equal(november.completedTurns, 1)
  assert.equal(november.toolCalls, 3)
  assert.equal(november.failedToolCalls, 2)
  assert.equal(november.classes.staleCoordinates, 1)
  assert.equal(november.classes.loopDetected, 1)
  assert.equal(november.classes.sidePanelClosed, 0)
  assert.equal(november.classes.dragNoEffect, 1)
})

test('per-tool calls, failures and average durations are joined on callId', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })
  const byTool = new Map(report.tools.map((tool) => [tool.tool, tool]))

  assert.deepEqual(byTool.get('browser_click'), {
    tool: 'browser_click',
    calls: 3,
    failed: 3,
    failureRate: 1,
    avgDurationMs: 250,
  })
  assert.deepEqual(byTool.get('browser_click_at'), {
    tool: 'browser_click_at',
    calls: 2,
    failed: 1,
    failureRate: 0.5,
    avgDurationMs: 100,
  })
  assert.equal(byTool.get('browser_screenshot').calls, 2)
  assert.equal(byTool.get('browser_screenshot').failed, 2)
  assert.equal(byTool.get('browser_screenshot').avgDurationMs, null)
  assert.equal(byTool.get('browser_upload').failed, 1)
  assert.equal(byTool.get('browser_drag').calls, 2)
  assert.equal(byTool.get('browser_drag').failed, 1)
  assert.equal(report.tools.length, 5)
})

test('top failure messages are normalized, redacted and capped', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })

  assert.equal(report.failureMessages[0].count, 2)
  assert.equal(report.failureMessages[0].message, 'No visible button named <quoted> appeared within Nms')
  const texts = report.failureMessages.map((entry) => entry.message)
  assert.ok(texts.includes('Screenshots are paused for Ns after a Chrome capture timeout'))
  assert.ok(texts.includes('Chrome did not return a screenshot within Nms; captures are paused for Ns'))
  const redactedDownloads = texts.find((text) => text.includes('Downloads:'))
  assert.equal(redactedDownloads, 'The requested file does not exist in Downloads: <redacted>')
  const longStale = texts.find((text) => text.startsWith('The page scrolled since the canvas view was captured.'))
  assert.equal(longStale.length, 160)
  assert.ok(texts.every((text) => text.length <= 160))
  assert.ok(texts.every((text) => !text.includes('Submit')))
  assert.ok(texts.every((text) => !text.includes('Chapter')))
})

test('error codes count distinct failed calls from bridge.command.error only', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })
  const byCode = new Map(report.failureCodes.map((code) => [code.code, code]))
  assert.equal(report.failureCodes.length, 4)
  assert.deepEqual(byCode.get('click / UNKNOWN_LABEL'), {
    code: 'click / UNKNOWN_LABEL',
    events: 2,
    failedCalls: 2,
  })
  assert.equal(byCode.get('click / SIDE_PANEL_CLOSED').events, 1)
  assert.equal(byCode.get('click_at / STALE_VIEW').failedCalls, 1)
  assert.equal(byCode.get('upload / UPLOAD_READBACK_FAILED').events, 1)
})

test('back-to-back repeated failures are counted once per turn', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })
  assert.equal(report.repeatedFailures.turnsWithRepeats, 1)
  assert.equal(report.repeatedFailures.occurrences, 1)
  assert.equal(report.repeatedFailures.patterns.length, 1)
  assert.deepEqual(report.repeatedFailures.patterns[0], {
    tool: 'browser_click',
    message: 'No visible button named <quoted> appeared within Nms',
    count: 1,
    maxStreak: 2,
  })
})

test('reported completion labels are counted per completed turn (missing = none)', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })

  // t1 done, t2 partial, t3 old-style without a label (none), t5 blocked.
  assert.deepEqual(report.labels, {
    completedTurns: 4,
    counts: { done: 1, partial: 1, blocked: 1, none: 1 },
    shares: { done: 0.25, partial: 0.25, blocked: 0.25, none: 0.25 },
  })

  const october = report.months.find((month) => month.month === '2026-10')
  const november = report.months.find((month) => month.month === '2026-11')
  assert.deepEqual(october.labels, {
    completedTurns: 3,
    counts: { done: 1, partial: 1, blocked: 0, none: 1 },
    shares: { done: 0.3333, partial: 0.3333, blocked: 0, none: 0.3333 },
  })
  assert.deepEqual(november.labels, {
    completedTurns: 1,
    counts: { done: 0, partial: 0, blocked: 1, none: 0 },
    shares: { done: 0, partial: 0, blocked: 1, none: 0 },
  })
})

test('stopped turns report elapsed duration and failed calls with their n', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })

  // t4 (2000ms, failedCalls 1) and t6 (3000ms, old-style: no failedCalls).
  assert.deepEqual(report.stoppedTurnStats.durationMs, {
    count: 2,
    min: 2000,
    p50: 2000,
    p90: 3000,
    p99: 3000,
    max: 3000,
    sum: 5000,
  })
  // t6 has no timings.failedCalls, so it is excluded instead of counted as 0.
  assert.deepEqual(report.stoppedTurnStats.failedCalls, {
    count: 1,
    min: 1,
    p50: 1,
    p90: 1,
    p99: 1,
    max: 1,
    sum: 1,
  })
})

test('stopped turns, percentiles and token usage have known values', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })

  assert.equal(report.totals.stoppedTurns, 2)
  assert.equal(report.totals.stoppedRate, 0.3333)
  assert.equal(report.percentiles.completed.turns, 4)
  assert.equal(report.percentiles.completed.toolCalls.p50, 0)
  assert.equal(report.percentiles.completed.toolCalls.p90, 6)
  assert.equal(report.percentiles.completed.durationMs.p50, 1200)
  assert.equal(report.percentiles.completed.durationMs.p90, 2500)
  assert.equal(report.percentiles.all.turns, 6)
  assert.equal(report.percentiles.all.toolCalls.p50, 0)
  assert.equal(report.percentiles.all.toolCalls.p90, 6)
  assert.equal(report.percentiles.all.toolCalls.max, 6)
  assert.equal(report.percentiles.all.durationMs.p50, 1500)
  assert.equal(report.percentiles.all.durationMs.max, 3000)

  assert.equal(report.tokens.turnsWithUsage, 3)
  assert.deepEqual(report.tokens.input, { total: 350, p50: 100, p90: 200, max: 200 })
  assert.deepEqual(report.tokens.output, { total: 35, p50: 10, p90: 20, max: 20 })
  assert.equal(report.tokens.cacheRead, 50)
  assert.deepEqual(report.tokens.total, { total: 385, p50: 110, p90: 220, max: 220 })
})

test('top sites aggregate tab activations without carrying URLs', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })
  const bySite = new Map(report.sites.map((site) => [site.site, site.activations]))
  assert.equal(bySite.get('Docs'), 3)
  assert.equal(bySite.get('Schoology'), 1)
  assert.equal(bySite.get('example.com'), 1)
  assert.equal(bySite.get('Local file'), 1)
  assert.equal(bySite.has('Unknown'), false)
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes('/document/'))
  assert.ok(!serialized.includes('secret'))
  assert.ok(!serialized.includes('private-resume'))
})

test('--since and --runs select a subset of runs', async () => {
  const november = await analyzeLogs({ logsDir: logsRoot, since: '2026-11-01' })
  assert.equal(november.scope.includedRuns, 2)
  assert.equal(november.scope.excludedBySince, 1)
  assert.equal(november.totals.turns, 2)
  assert.equal(november.totals.toolCalls, 3)

  const latest = await analyzeLogs({ logsDir: logsRoot, runs: 1 })
  assert.equal(latest.scope.includedRuns, 1)
  assert.equal(latest.totals.turns, 0)
  assert.equal(latest.scope.runsWithoutEvents.length, 1)

  const latestTwo = await analyzeLogs({ logsDir: logsRoot, runs: 2 })
  assert.equal(latestTwo.scope.includedRuns, 2)
  assert.equal(latestTwo.totals.toolCalls, 3)
  assert.equal(latestTwo.scope.excludedByRuns, 1)

  const sinceThenRuns = await analyzeLogs({ logsDir: logsRoot, since: '2026-11-04', runs: 5 })
  assert.equal(sinceThenRuns.scope.includedRuns, 1)
})

test('invalid options are rejected', async () => {
  await assert.rejects(analyzeLogs({ logsDir: join(logsRoot, 'missing') }), /logs directory not found/)
  await assert.rejects(analyzeLogs({ logsDir: logsRoot, since: 'not-a-date' }), /not a valid date/)
  await assert.rejects(analyzeLogs({ logsDir: logsRoot, runs: 0 }), /positive integer/)
})

test('formatReport prints every section and still redacts page content', async () => {
  const report = await analyzeLogs({ logsDir: logsRoot })
  const text = formatReport(report)
  for (const heading of [
    'crazyAgent failure report',
    '== Monthly measures',
    '== Calls and failure rate per tool',
    '== Error codes',
    '== Top failure messages',
    '== Back-to-back repeated failures within one turn',
    '== Reported completion labels (model-reported, not verification)',
    '== Stopped turns',
    '== Turn duration and tool-call percentiles',
    '== Tokens per turn',
    '== Top sites by tab activation',
  ]) {
    assert.ok(text.includes(heading), `missing section: ${heading}`)
  }
  // Label section: overall denominator + each label's count/share, per month too.
  assert.ok(text.includes('completed turns'))
  assert.ok(text.includes('done'))
  assert.ok(text.includes('1 (25.0%)'))
  assert.ok(text.includes('0 (0.0%)'))
  // Stopped section: medians and their n.
  assert.ok(text.includes('elapsed duration: median 2.0s (n=2)'))
  assert.ok(text.includes('failed calls: median 1 (n=1)'))
  assert.ok(text.includes('not counted as 0'))
  assert.ok(!text.includes('Submit'))
  assert.ok(!text.includes('Chapter'))
  assert.ok(!text.includes('/home/someone'))
  assert.ok(!text.includes('?"token=secret"'))
})

test('CLI --json and human output run against --logs', async () => {
  const json = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--logs', logsRoot, '--json'], { encoding: 'utf8' }))
  assert.equal(json.totals.toolCalls, 10)
  assert.equal(json.totals.failedToolCalls, 8)
  assert.equal(json.months.length, 2)
  assert.equal(json.labels.counts.none, 1)
  assert.equal(json.stoppedTurnStats.failedCalls.count, 1)

  const human = execFileSync(process.execPath, [SCRIPT, '--logs', logsRoot], { encoding: 'utf8' })
  assert.ok(human.includes('crazyAgent failure report'))
  assert.ok(human.includes('tool calls: 10'))
  assert.ok(human.includes('== Reported completion labels (model-reported, not verification) =='))

  const sinceJson = JSON.parse(
    execFileSync(process.execPath, [SCRIPT, '--logs', logsRoot, '--since', '2026-11-01', '--json'], {
      encoding: 'utf8',
    })
  )
  assert.equal(sinceJson.scope.includedRuns, 2)
  assert.equal(sinceJson.totals.toolCalls, 3)

  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--bogus'], { stdio: 'pipe' }))
})