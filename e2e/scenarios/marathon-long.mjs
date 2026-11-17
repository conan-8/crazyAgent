/**
 * M0 marathon baseline (MARATHON-PLAN.md §5 M0): a 12-station multi-page
 * workflow with a server-side record of every completed step.
 *
 * Each station page shows its dispatch word and seal. A submit is accepted
 * only with that word plus the receipt the previous station revealed after
 * its own accepted submit (station 1 uses a printed start receipt), so the
 * steps are information-dependent: station k cannot be completed before
 * station k-1. Only an accepted submit POSTs {step, word, receipt} to
 * /marathon/step; the fixture server's request log is therefore the
 * independent record of completed steps. The checker verifies every step was
 * recorded exactly once, with the right values, in station order, and that
 * the tracked page ends on station 12's completion view. A re-submitted
 * station appears as a duplicate POST — the same log lets the M2
 * stop-then-continue check detect re-done steps across turns.
 *
 * The model's answer and tool results are never consulted.
 */
export const name = 'marathon-long'
export const fixture = 'marathon-01.html'
export const prompt = 'Work through the expedition permit workflow on the site I have open, from station 1 to station 12. Each station page shows its dispatch word and seal. At every station, enter the dispatch word shown on that page plus the receipt from the previous station (station 1 shows a start receipt), submit the station form, and carry the new receipt to the next station via the link. Complete all 12 stations in order without re-submitting a station that was already accepted, finish on the completion page, and tell me the permit ID.'
export const maxTurnSeconds = 1200

const STATIONS = [
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
const START_RECEIPT = 'START-7Q4'
const PERMIT_ID = 'EXP-917Q'
const STEP_PATH = '/marathon/step'
const TOTAL = STATIONS.length
const receiptFor = step => `R${step}-${STATIONS[step - 1].seal}`
const expectedReceiptFor = step => (step === 1 ? START_RECEIPT : receiptFor(step - 1))
const stationFile = step => `marathon-${String(step).padStart(2, '0')}.html`

async function waitUntil(predicate, what, timeoutMs = 8_000) {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

export async function check(ctx) {
  let requests = null
  try { requests = await ctx.requests() } catch { requests = null }
  if (!Array.isArray(requests)) {
    return { status: 'fail', reasons: ['the fixture request log is unavailable, so completed steps cannot be verified'], evidence: null }
  }
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
 * Harness-made correct end state: drive every station's own form with the
 * right word and the receipt actually revealed by the previous station, so
 * both the server-side record and the final completion view are genuine.
 */
export async function solve(ctx) {
  let receipt = START_RECEIPT
  for (let step = 1; step <= TOTAL; step += 1) {
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
    receipt = await ctx.evaluate(`document.getElementById('receipt-code').textContent`)
  }
}

/**
 * Plausible-but-wrong: the completion view is genuine, but the server-side
 * record has station 7's word wrong and station 3 recorded twice (a redo).
 * Steps 1..11 are posted directly; station 12 is driven through its own form
 * so the final page looks exactly like a finished run.
 */
export async function tamper(ctx) {
  await ctx.evaluate(`(async () => {
    const stations = ${JSON.stringify(STATIONS)}
    const start = ${JSON.stringify(START_RECEIPT)}
    const receiptFor = step => 'R' + step + '-' + stations[step - 1].seal
    for (let step = 1; step <= 11; step += 1) {
      const body = {
        step,
        word: step === 7 ? 'altitude-checks' : stations[step - 1].word,
        receipt: step === 1 ? start : receiptFor(step - 1),
      }
      await fetch('/marathon/step', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }
    await fetch('/marathon/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 3, word: stations[2].word, receipt: receiptFor(2) }),
    })
    return true
  })()`)
  await ctx.navigateFixture(stationFile(TOTAL))
  await ctx.evaluate(`(() => {
    document.getElementById('receipt').value = ${JSON.stringify(receiptFor(TOTAL - 1))}
    document.getElementById('word').value = ${JSON.stringify(STATIONS[TOTAL - 1].word)}
    document.getElementById('station-form').requestSubmit()
    return true
  })()`)
  await waitUntil(
    () => ctx.evaluate(`document.getElementById('station-accepted').hidden === false`),
    'station 12 acceptance',
  )
}
