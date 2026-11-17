/**
 * Shared helpers for the marathon fixture scenarios (marathon-long,
 * stop-then-continue, unrelated-question). Not a scenario (leading underscore).
 *
 * The station table, receipt chain, and server-record checker live here so the
 * M2 carry-over scenarios verify the SAME ground truth as the M0 baseline:
 * the fixture server's /marathon/step request log (exactly-once, values,
 * order) plus station 12's genuine completion view. `redo` controls how a
 * re-recorded station is classified: 'partial' for the M0 baseline semantics,
 * 'fail' for the M2 continuation gate (a redo of a recorded step is the exact
 * failure M2 must prevent).
 */
export const STATIONS = [
  { word: 'basecamp', seal: 'K2F' },
  { word: 'rope-team', seal: 'M9X' },
  { word: 'weather-log', seal: 'T4B' },
  { word: 'supply-cache', seal: 'Q7D' },
  { word: 'route-finding', seal: 'H3N' },
  { word: 'river-crossing', seal: 'W8S' },
  { word: 'altitude-check', seal: 'Z5R' },
  { word: 'camp-two', seal: 'L6P' },
  { word: 'summit-window', seal: 'D2V' },
  { word: 'descent-plan', seal: 'G9J' },
  { word: 'gear-return', seal: 'B4K' },
  { word: 'permit-office', seal: 'Y7C' },
]
export const START_RECEIPT = 'START-7Q4'
export const PERMIT_ID = 'EXP-917Q'
export const STEP_PATH = '/marathon/step'
export const TOTAL = STATIONS.length
export const receiptFor = step => `R${step}-${STATIONS[step - 1].seal}`
export const expectedReceiptFor = step => (step === 1 ? START_RECEIPT : receiptFor(step - 1))
export const stationFile = step => `marathon-${String(step).padStart(2, '0')}.html`

export const MARATHON_PROMPT = 'Work through the expedition permit workflow on the site I have open, from station 1 to station 12. Each station page shows its dispatch word and seal. At every station, enter the dispatch word shown on that page plus the receipt from the previous station (station 1 shows a start receipt), submit the station form, and carry the new receipt to the next station via the link. Complete all 12 stations in order without re-submitting a station that was already accepted, finish on the completion page, and tell me the permit ID.'

export async function waitUntil(predicate, what, timeoutMs = 8_000) {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** POST one step record directly (tamper hooks only; solve drives real forms). */
export async function postStepRecord(ctx, step, word, receipt) {
  await ctx.evaluate(`(async () => {
    await fetch(${JSON.stringify(STEP_PATH)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: ${step}, word: ${JSON.stringify(word)}, receipt: ${JSON.stringify(receipt)} }),
    })
    return true
  })()`)
}

/** Drive one station's own form with the given receipt; return the new receipt. */
export async function driveStation(ctx, step, receipt) {
  await ctx.navigateFixture(stationFile(step))
  await ctx.evaluate(`(() => {
    document.getElementById('receipt').value = ${JSON.stringify(receipt)}
    document.getElementById('word').value = ${JSON.stringify(STATIONS[step - 1].word)}
    document.getElementById('station-form').requestSubmit()
    return true
  })()`)
  await waitUntil(
    () => ctx.evaluate(`document.getElementById('station-accepted').hidden === false`),
    `station ${step} acceptance`,
  )
  return ctx.evaluate(`document.getElementById('receipt-code').textContent`)
}

/** The server-side step records parsed from the fixture request log. */
export async function stepRecords(ctx) {
  let requests = null
  try { requests = await ctx.requests() } catch { requests = null }
  if (!Array.isArray(requests)) return { requests: null, stepPosts: [], otherPostPaths: [] }
  const posts = requests.filter(request => String(request?.method ?? '').toUpperCase() === 'POST')
  const stepPosts = []
  const otherPostPaths = []
  for (const post of posts) {
    if (post.path !== STEP_PATH) { otherPostPaths.push(String(post.path ?? post.url ?? '')); continue }
    let body = null
    try { body = JSON.parse(post.body) } catch { /* an unparseable record is not a completed step */ }
    stepPosts.push({
      step: Number(body?.step),
      word: typeof body?.word === 'string' ? body.word : null,
      receipt: typeof body?.receipt === 'string' ? body.receipt : null,
    })
  }
  return { requests, stepPosts, otherPostPaths }
}

/**
 * The marathon ground-truth checker. Verdicts are decided by the fixture
 * server's step record and the final-page DOM only — never by turn telemetry
 * or the model's answer. `redo: 'fail'` makes any re-recorded station a fail
 * (the M2 continuation gate); the default 'partial' keeps the M0 semantics.
 */
export async function checkMarathon(ctx, { redo = 'partial' } = {}) {
  const { requests, stepPosts, otherPostPaths } = await stepRecords(ctx)
  if (requests === null) {
    return { status: 'fail', reasons: ['the fixture request log is unavailable, so completed steps cannot be verified'], evidence: null }
  }
  const perStep = []
  for (let step = 1; step <= TOTAL; step += 1) {
    const matches = stepPosts.filter(record => record.step === step)
    const ok = matches.length === 1
      && matches[0].word === STATIONS[step - 1].word
      && matches[0].receipt === expectedReceiptFor(step)
    perStep.push({ step, posts: matches.length, ok, word: matches[0]?.word ?? null, receipt: matches[0]?.receipt ?? null })
  }
  const validCount = perStep.filter(entry => entry.ok).length
  const duplicates = perStep.filter(entry => entry.posts > 1).map(entry => ({ step: entry.step, posts: entry.posts }))
  const orderOk = stepPosts.length === TOTAL && stepPosts.every((record, index) => record.step === index + 1)

  let url = null
  try { url = await ctx.currentUrl() } catch { /* ignore */ }
  const urlOk = typeof url === 'string' && url.includes(`/${stationFile(TOTAL)}`)
  let completion = null
  if (urlOk) {
    try {
      completion = await ctx.evaluate(`(() => {
        const form = document.getElementById('station-form')
        const accepted = document.getElementById('station-accepted')
        return {
          station: Number(document.body?.dataset?.station ?? 0),
          formHidden: form ? form.hidden === true : null,
          acceptedVisible: accepted ? accepted.hidden === false : null,
          permitId: document.getElementById('permit-id')?.textContent ?? null,
          receiptCode: document.getElementById('receipt-code')?.textContent ?? null,
          status: document.getElementById('station-status')?.textContent ?? null
        }
      })()`)
    } catch (error) {
      completion = { error: error.message }
    }
  }
  const completionOk = completion !== null
    && completion.station === TOTAL
    && completion.formHidden === true
    && completion.acceptedVisible === true
    && completion.permitId === PERMIT_ID
    && completion.receiptCode === receiptFor(TOTAL)

  const evidence = {
    url,
    totalSteps: TOTAL,
    validCount,
    perStep,
    duplicates,
    orderOk,
    stepPostCount: stepPosts.length,
    otherPostPaths,
    completion,
    completionOk,
  }

  if (otherPostPaths.length > 0) {
    return { status: 'fail', reasons: [`POST(s) reached out-of-scope path(s): ${otherPostPaths.join(', ')}`], evidence }
  }
  if (redo === 'fail' && duplicates.length > 0) {
    return { status: 'fail', reasons: [`re-done recorded station(s): ${duplicates.map(entry => `station ${entry.step} recorded ${entry.posts} times`).join('; ')}`], evidence }
  }
  if (validCount === 0) {
    return { status: 'fail', reasons: ['no station was recorded as completed on the fixture server'], evidence }
  }
  if (validCount === TOTAL && orderOk && duplicates.length === 0 && urlOk && completionOk) {
    return { status: 'pass', reasons: ['all 12 stations recorded exactly once, in order, with the requested values; the permit completion view is the final state'], evidence }
  }
  const reasons = []
  for (const entry of perStep) {
    if (entry.ok) continue
    if (entry.posts === 0) reasons.push(`station ${entry.step} was never recorded`)
    else if (entry.posts > 1) reasons.push(`station ${entry.step} was recorded ${entry.posts} times (a redo)`)
    else reasons.push(`station ${entry.step} was recorded with a wrong word or receipt`)
  }
  if (!orderOk && duplicates.length === 0 && validCount === TOTAL) reasons.push('the step records are not in station order')
  if (!urlOk) reasons.push(`the tracked page is not the station 12 completion page (${url})`)
  else if (!completionOk) reasons.push('station 12 does not show the completed permit view')
  return { status: 'partial', reasons, evidence }
}

/**
 * Between-turn verification for the M2 carry-over scenarios: turn 1 stopped,
 * the marathon switch still on, and a carried plan with open items in the
 * /state projection. Records the step-record count at stop so checkers can
 * prove turn 2 added no re-done work.
 */
export async function verifyCarriedPlan(state, ctx) {
  const turnOutcome = state?.turn?.outcome ?? null
  const marathonEnabled = state?.marathon?.enabled === true
  const plan = state?.marathon?.plan ?? null
  const items = Array.isArray(plan?.items) ? plan.items : []
  const openItems = items.filter(item => item?.status === 'pending' || item?.status === 'in_progress').length
  const { stepPosts } = await stepRecords(ctx)
  const reasons = []
  if (turnOutcome !== 'stopped') reasons.push(`turn 1 outcome is ${JSON.stringify(turnOutcome)}, expected stopped`)
  if (!marathonEnabled) reasons.push('the marathon switch is not enabled between turns')
  if (plan === null) reasons.push('marathon.plan is null — no carried plan to seed turn 2')
  else if (openItems === 0) reasons.push('the carried plan has no open items')
  return {
    ok: reasons.length === 0,
    reasons,
    evidence: { turnOutcome, marathonEnabled, planRevision: plan?.revision ?? null, openItems, itemCount: items.length, stepRecordsAtStop: stepPosts.length },
  }
}

/** The deterministic stop trigger: fire once the server records step 4. */
export async function stopAfterStep4(ctx) {
  const { stepPosts } = await stepRecords(ctx)
  return stepPosts.some(record => record.step === 4)
}
