import test from 'node:test'
import assert from 'node:assert/strict'
import { Watcher, decideWatch, WATCH_JUDGE_LIMITS, WATCH_TICK_MS } from '../watcher.mjs'
import { WatchLedger, WATCH_THRESHOLDS } from '../watch-ledger.mjs'

/* A fake judge: returns queued results (or a function of the call index). */
function okResult(state, confidence = 0.9, over = {}) {
  return {
    status: 'ok',
    verdict: { state, confidence, blocker: null, reason: 'because', evidence: [1] },
    usage: { inputTokens: 1000, outputTokens: 50, reasoningTokens: 10, cacheReadTokens: 0, totalTokens: 1050 },
    durationMs: 5, httpStatus: 200, finishReason: 'stop',
    ...over,
  }
}

function fakeJudge(responses) {
  const calls = []
  let i = 0
  let aborted = null
  return {
    calls,
    get aborted() { return aborted },
    check: async ({ turnId, digest }) => {
      const idx = i++
      calls.push({ turnId, digest, idx })
      const r = typeof responses === 'function' ? responses(digest, idx) : responses[idx]
      return r ?? okResult('progressing')
    },
    abort: turnId => { aborted = turnId },
    get inFlight() { return false },
  }
}

function harness({ judge = null, marathon = true, judgeLimits } = {}) {
  let now = 0
  const frames = []
  const pushes = []
  const logs = []
  let enabled = marathon
  const ledger = new WatchLedger({ now: () => now })
  let tickFn = null
  const watcher = new Watcher({
    ledger,
    marathonEnabled: () => enabled,
    publish: frame => frames.push(frame),
    judge,
    now: () => now,
    wallNow: () => 1_700_000_000_000 + now,
    setTimer: fn => { tickFn = fn; return 1 },
    clearTimer: () => { tickFn = null },
    push: meta => pushes.push(meta),
    log: (type, data, severity) => logs.push({ type, data, severity }),
    random: () => 0.5, // no jitter
    judgeLimits,
  })
  watcher.start()
  ledger.startTurn({ turnId: 'turn-1', prompt: 'long task', marathon })
  watcher.turnStarted({ marathon })
  let callSeq = 0
  return {
    watcher, ledger, frames, pushes, logs,
    advance: ms => { now += ms },
    now: () => now,
    tick: () => tickFn(),
    setMarathon: value => { enabled = value },
    call: (callId, name = 'browser_click', args = { label: callId }) => ledger.noteFrame({ type: 'chat.tool_call', callId, name, args }),
    result: (callId, ok = true, text = 'clicked') => ledger.noteFrame({ type: 'chat.tool_result', callId, ok, text }),
    // A fresh successful mutation keeps lastEventAt recent without creating signals.
    fresh: () => { callSeq += 1; const id = `ok${callSeq}`; ledger.noteFrame({ type: 'chat.tool_call', callId: id, name: 'browser_click', args: { label: id } }); ledger.noteFrame({ type: 'chat.tool_result', callId: id, ok: true, text: 'done' }) },
    plan: (revision, items) => ledger.noteFrame({ type: 'chat.activity', kind: 'plan', revision, items }),
    alerts: () => frames.filter(f => f.type === 'chat.watch' && f.state === 'open' && f.kind !== 'ended-incomplete' && f.kind !== 'info'),
    settle: () => watcher.settleJudge(),
  }
}

const L = WATCH_JUDGE_LIMITS

/* ------------------------------------------------------------------ */
/* Cadence                                                             */
/* ------------------------------------------------------------------ */

test('first routine judge call is at 4 minutes, not before', async () => {
  const judge = fakeJudge([okResult('progressing')])
  const h = harness({ judge })
  h.advance(L.firstCallMs - 1000); h.fresh(); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 0)
  h.advance(1000); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 1)
  assert.equal(h.logs.find(l => l.type === 'watch.judge.start').data.trigger, 'routine')
})

test('after one progressing verdict the next routine call is 6 minutes later', async () => {
  const judge = fakeJudge([okResult('progressing'), okResult('progressing')])
  const h = harness({ judge })
  h.advance(L.firstCallMs); h.fresh(); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 1)
  h.advance(L.routineMs - 1000); h.fresh(); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 1)
  h.advance(1000); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 2)
})

test('two consecutive progressing verdicts grow the interval to 10 minutes', async () => {
  const judge = fakeJudge([okResult('progressing'), okResult('progressing'), okResult('progressing')])
  const h = harness({ judge })
  h.advance(L.firstCallMs); h.fresh(); h.tick(); await h.settle() // streak 1 → 6min
  h.advance(L.routineMs); h.fresh(); h.tick(); await h.settle() // streak 2 → 10min
  assert.equal(h.watcher.judgeIntervalMs, L.calmMs)
  h.advance(L.calmMs - 1000); h.fresh(); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 2)
  h.advance(1000); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 3)
})

test('any non-progressing verdict returns the interval to 4 minutes', async () => {
  const judge = fakeJudge([okResult('progressing'), okResult('slow'), okResult('progressing')])
  const h = harness({ judge })
  h.advance(L.firstCallMs); h.fresh(); h.tick(); await h.settle()
  h.advance(L.routineMs); h.fresh(); h.tick(); await h.settle() // slow → 4min, streak 0
  assert.equal(h.watcher.judgeIntervalMs, L.alertMs)
  assert.equal(h.watcher.progressingStreak, 0)
  h.advance(L.alertMs); h.fresh(); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 3)
})

test('a suspect assessment triggers a call once ≥90s since the last, not before', async () => {
  const judge = fakeJudge([okResult('progressing')])
  const h = harness({ judge })
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangSuspectMs - 1000) // 89s: suspect but < 90s floor
  h.tick(); await h.settle()
  assert.equal(judge.calls.length, 0)
  h.advance(2000) // 91s
  h.tick(); await h.settle()
  assert.equal(judge.calls.length, 1)
  assert.equal(h.logs.find(l => l.type === 'watch.judge.start').data.trigger, 'trigger')
})

test('jitter stays within ±15% of the interval', async () => {
  const judge = fakeJudge([okResult('progressing'), okResult('progressing')])
  let now = 0
  const ledger = new WatchLedger({ now: () => now })
  const watcher = new Watcher({
    ledger, marathonEnabled: () => true, publish: () => {}, judge,
    now: () => now, wallNow: () => now, setTimer: () => 1, clearTimer: () => {},
    random: () => 0, // factor 1 - 0.15
  })
  ledger.startTurn({ turnId: 't', prompt: 'x', marathon: true })
  watcher.turnStarted({ marathon: true })
  now = L.firstCallMs; ledger.noteFrame({ type: 'chat.tool_call', callId: 'a', name: 'browser_click', args: {} }); ledger.noteFrame({ type: 'chat.tool_result', callId: 'a', ok: true, text: 'ok' })
  watcher.tick(); await watcher.settleJudge()
  assert.equal(watcher.nextJudgeAt, L.firstCallMs + Math.round(L.routineMs * 0.85))
})

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

// A persistent REPEAT_LOOP (suspect-only, never hard) drives repeated trigger
// calls without a deterministic hard alert interfering.
function repeatLoop(h) {
  for (let i = 0; i < 3; i += 1) { h.call('same', 'browser_click', { label: 'Next' }); h.result('same') }
}
function keepLooping(h) { h.call('same', 'browser_click', { label: 'Next' }); h.result('same') }

test('the call budget falls back to deterministic-only with one notice', async () => {
  const judge = fakeJudge(() => okResult('progressing'))
  const h = harness({ judge, judgeLimits: { ...L, maxCallsPerTurn: 3 } })
  repeatLoop(h)
  for (let i = 0; i < 6; i += 1) { h.advance(100_000); keepLooping(h); h.tick(); await h.settle() }
  assert.equal(judge.calls.length, 3)
  const notices = h.frames.filter(f => f.type === 'chat.watch' && f.kind === 'info' && /budget/u.test(f.reason))
  assert.equal(notices.length, 1)
})

test('the input-token budget falls back to deterministic-only with one notice', async () => {
  const judge = fakeJudge(() => okResult('progressing')) // 1000 input each
  const h = harness({ judge, judgeLimits: { ...L, maxInputTokensPerTurn: 2500 } })
  repeatLoop(h)
  for (let i = 0; i < 6; i += 1) { h.advance(100_000); keepLooping(h); h.tick(); await h.settle() }
  assert.equal(judge.calls.length, 3) // 3000 ≥ 2500 stops the 4th
  assert.equal(h.frames.filter(f => f.kind === 'info' && /budget/u.test(f.reason)).length, 1)
})

/* ------------------------------------------------------------------ */
/* Backoff                                                             */
/* ------------------------------------------------------------------ */

test('HTTP 429 skips the check and doubles the next interval once', async () => {
  const judge = fakeJudge([{ ...okResult('progressing'), status: 'rate-limited' }, okResult('progressing')])
  const h = harness({ judge })
  h.advance(L.firstCallMs); h.fresh(); h.tick(); await h.settle()
  assert.equal(h.watcher.judgeSkipped, 1)
  assert.equal(h.watcher.lastVerdict, null)
  assert.equal(h.watcher.backoffUntil, L.firstCallMs + 2 * L.routineMs)
  // A suspect trigger during backoff must not fire.
  h.call('hang', 'browser_wait_for')
  h.advance(L.firstCallMs + 100_000); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 1)
  // After the doubled interval, normal cadence resumes.
  h.advance(2 * L.routineMs); h.tick(); await h.settle()
  assert.equal(judge.calls.length, 2)
})

test('a timeout skips the check and doubles the next interval once', async () => {
  const judge = fakeJudge([{ ...okResult('progressing'), status: 'timeout' }, okResult('progressing')])
  const h = harness({ judge })
  h.advance(L.firstCallMs); h.fresh(); h.tick(); await h.settle()
  assert.equal(h.watcher.judgeSkipped, 1)
  assert.equal(h.watcher.backoffUntil, L.firstCallMs + 2 * L.routineMs)
})

/* ------------------------------------------------------------------ */
/* Two-strike alert rule                                               */
/* ------------------------------------------------------------------ */

test('stuck ≥0.6 with a deterministic signal alerts (source both)', async () => {
  const judge = fakeJudge([okResult('stuck', 0.9, { verdict: { state: 'stuck', confidence: 0.9, blocker: 'loop', reason: 'same clicks', evidence: [1] } })])
  const h = harness({ judge })
  h.call('hang', 'browser_wait_for')
  h.advance(100_000); h.tick(); await h.settle()
  const alerts = h.alerts()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'stuck')
  assert.equal(alerts[0].source, 'both')
  assert.equal(alerts[0].blocker, 'loop')
  assert.equal(alerts[0].reason, 'same clicks')
})

test('a single unsupported stuck verdict never alerts', async () => {
  const judge = fakeJudge([okResult('stuck', 0.95)])
  const h = harness({ judge })
  h.advance(L.firstCallMs); h.fresh(); h.tick(); await h.settle()
  assert.equal(h.alerts().length, 0)
  assert.equal(h.logs.some(l => l.type === 'watch.judge.suppressed'), true)
})

test('stuck ≥0.6 with a previous non-progressing verdict alerts (source watcher)', async () => {
  const judge = fakeJudge([okResult('slow', 0.5), okResult('stuck', 0.9)])
  const h = harness({ judge })
  h.advance(L.firstCallMs); h.fresh(); h.tick(); await h.settle() // slow, no signal → suppressed
  assert.equal(h.alerts().length, 0)
  h.advance(L.alertMs); h.fresh(); h.tick(); await h.settle() // stuck, previous slow → alert
  const alerts = h.alerts()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].source, 'watcher')
})

test('stuck below 0.6 confidence never alerts even with a signal', async () => {
  const judge = fakeJudge([okResult('stuck', 0.5)])
  const h = harness({ judge })
  h.call('hang', 'browser_wait_for')
  h.advance(100_000); h.tick(); await h.settle()
  assert.equal(h.alerts().length, 0)
})

test('progressing, slow, and unknown verdicts never alert', async () => {
  for (const state of ['progressing', 'slow', 'unknown']) {
    const judge = fakeJudge([okResult(state, 1)])
    const h = harness({ judge })
    h.call('hang', 'browser_wait_for')
    h.advance(100_000); h.tick(); await h.settle()
    assert.equal(h.alerts().length, 0, state)
  }
})

test('a blocked verdict with a signal alerts with kind blocked', async () => {
  const judge = fakeJudge([{ ...okResult('blocked', 0.8), verdict: { state: 'blocked', confidence: 0.8, blocker: 'login', reason: 'sign-in wall', evidence: [] } }])
  const h = harness({ judge })
  h.call('hang', 'browser_wait_for')
  h.advance(100_000); h.tick(); await h.settle()
  assert.equal(h.alerts()[0].kind, 'blocked')
  assert.equal(h.alerts()[0].blocker, 'login')
})

test('a hard signal alerts even when the judge says progressing (no veto)', async () => {
  const judge = fakeJudge([okResult('progressing', 1)])
  const h = harness({ judge })
  h.call('hang', 'browser_wait_for')
  h.advance(WATCH_THRESHOLDS.toolHangHardMs); h.tick(); await h.settle()
  const alerts = h.alerts()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'TOOL_HANG')
  assert.equal(alerts[0].source, 'heuristic')
})

/* ------------------------------------------------------------------ */
/* Turn lifecycle, read-only, usage                                    */
/* ------------------------------------------------------------------ */

test('a result for an ended turn is discarded', async () => {
  let resolveCall
  const judge = {
    calls: [],
    check: ({ turnId, digest }) => { judge.calls.push({ turnId, digest }); return new Promise(r => { resolveCall = r }) },
    abort: () => {},
    get inFlight() { return false },
  }
  const h = harness({ judge })
  h.call('hang', 'browser_wait_for')
  h.advance(100_000); h.tick()
  assert.equal(judge.calls.length, 1)
  // Turn ends before the judge replies.
  h.watcher.turnEnded({ outcome: 'done', label: 'done', planOutcome: 'reported-complete' })
  resolveCall(okResult('stuck', 0.95))
  await h.settle()
  assert.equal(h.alerts().length, 0)
  assert.equal(h.logs.some(l => l.type === 'watch.judge.discard'), true)
})

test('turnEnded aborts the in-flight judge call and reports judge usage separately', async () => {
  const judge = fakeJudge([okResult('progressing')])
  const h = harness({ judge })
  h.advance(L.firstCallMs); h.fresh(); h.tick(); await h.settle()
  const summary = h.watcher.turnEnded({ outcome: 'done', label: 'done', planOutcome: 'reported-complete' })
  assert.equal(judge.aborted, 'turn-1')
  assert.equal(summary.usage, 1050) // judge input+output, not agent usage
  assert.equal(summary.checks, 1)
  assert.equal(summary.alerts, 0)
  const js = h.logs.find(l => l.type === 'watch.judge.summary')
  assert.equal(js.data.calls, 1)
  assert.equal(js.data.inputTokens, 1000)
  assert.equal(js.data.outputTokens, 50)
})

test('the watcher only ever publishes chat.watch frames (read-only)', async () => {
  const judge = fakeJudge([okResult('stuck', 0.9)])
  const h = harness({ judge })
  h.call('hang', 'browser_wait_for')
  h.advance(100_000); h.tick(); await h.settle()
  h.advance(L.alertMs); h.tick(); await h.settle()
  h.watcher.turnEnded({ outcome: 'done', label: 'blocked', planOutcome: 'blocked' })
  assert.equal(h.frames.every(f => f.type === 'chat.watch'), true)
})

test('projection lastVerdict/lastCheckAt are judge-driven; idle shape unchanged', async () => {
  const judge = fakeJudge([okResult('slow', 0.4)])
  const h = harness({ judge })
  assert.deepEqual(h.watcher.watchProjection(), { open: null, lastVerdict: null, lastCheckAt: null, checks: 0 })
  h.advance(L.firstCallMs); h.fresh(); h.tick(); await h.settle()
  const projection = h.watcher.watchProjection()
  assert.equal(projection.lastVerdict, 'slow')
  assert.equal(typeof projection.lastCheckAt, 'string')
})

test('decideWatch with judgeKind respects snooze, budgets, and one-open-alert', () => {
  const base = {
    hardKind: null, judgeKind: 'stuck', judgeReason: 'r', judgeBlocker: 'loop', judgeSource: 'both',
    signals: [{ kind: 'REPEAT_LOOP', level: 'suspect', detail: '' }],
    openAlert: null, recovery: { okResults: 0, okMutation: false, planRevision: false },
    snoozedUntil: {}, now: 1000, alertsThisTurn: 0, pushesThisTurn: 0,
  }
  assert.equal(decideWatch(base).emit.kind, 'stuck')
  assert.equal(decideWatch({ ...base, snoozedUntil: { stuck: 2000 } }).emit, null)
  assert.equal(decideWatch({ ...base, alertsThisTurn: 3 }).emit, null)
  assert.equal(decideWatch({ ...base, openAlert: { kind: 'stuck', at: 0, planRevision: 0 } }).emit, null)
  assert.equal(decideWatch({ ...base, openAlert: { kind: 'stuck', at: 0, planRevision: 0 }, now: 15 * 60_000 }).emit.type, 'alert')
  // hardKind wins over judgeKind
  assert.equal(decideWatch({ ...base, hardKind: 'TOOL_HANG' }).emit.kind, 'TOOL_HANG')
})
