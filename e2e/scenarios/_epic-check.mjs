/**
 * Shared helpers for marathon-epic (V0-a, MARATHON-V2-PLAN.md §3.1/§5 V0):
 * the marathon-long contract at 120 stations — the missing long-healthy set
 * (G8). Mirrors _marathon-check.mjs semantics exactly (the M0 checker stays
 * frozen at 12 stations); only the station table, fixture family, start
 * receipt, and permit ID differ. POST path stays /marathon/step so the
 * corpus labeler has ONE progress-event parser for long/epic/continue.
 * Lead ruling 2026-11-17: 36 stations produced 136s and 72 produced 193.4s
 * (model pace improved to 2.69s/station) — both below the judge's 4-min
 * first call, defeating G8's intent. 120 stations so efficient healthy turns
 * reliably last ~4-8 min and exercise the judge on progressing work (honest
 * measurement design, not a forced stall — §8).
 * Not a scenario (leading underscore).
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
  { word: 'glacier-route', seal: 'P3M' },
  { word: 'oxygen-check', seal: 'V8T' },
  { word: 'ridge-camp', seal: 'N5W' },
  { word: 'storm-shelter', seal: 'J2K' },
  { word: 'icefall-crossing', seal: 'F7R' },
  { word: 'fixed-ropes', seal: 'C4X' },
  { word: 'high-camp', seal: 'S9B' },
  { word: 'summit-push', seal: 'U6H' },
  { word: 'weather-window', seal: 'E3L' },
  { word: 'photo-summit', seal: 'A8N' },
  { word: 'descent-check', seal: 'W2Q' },
  { word: 'camp-three', seal: 'D5V' },
  { word: 'glacier-exit', seal: 'R7J' },
  { word: 'basecamp-return', seal: 'T3F' },
  { word: 'gear-audit', seal: 'M8C' },
  { word: 'medical-check', seal: 'K4Y' },
  { word: 'debrief-log', seal: 'G6P' },
  { word: 'permit-stamp', seal: 'B9S' },
  { word: 'archive-file', seal: 'H2D' },
  { word: 'team-signoff', seal: 'L5G' },
  { word: 'office-review', seal: 'Q8Z' },
  { word: 'fee-settle', seal: 'X3E' },
  { word: 'record-close', seal: 'Y7A' },
  { word: 'epic-permit', seal: 'Z4U' },
  { word: 'trailhead-review', seal: 'T6R' },
  { word: 'map-archive', seal: 'V2K' },
  { word: 'compass-calibration', seal: 'W9M' },
  { word: 'beacon-test', seal: 'X5P' },
  { word: 'radio-check', seal: 'Y8T' },
  { word: 'satellite-link', seal: 'Z3N' },
  { word: 'weather-brief', seal: 'A6W' },
  { word: 'avalanche-scan', seal: 'B2J' },
  { word: 'snow-pit', seal: 'C7K' },
  { word: 'cornice-check', seal: 'D4M' },
  { word: 'serac-inspect', seal: 'E9R' },
  { word: 'crevasse-map', seal: 'F5T' },
  { word: 'ladder-count', seal: 'G2W' },
  { word: 'anchor-test', seal: 'H8N' },
  { word: 'rope-inspect', seal: 'J3P' },
  { word: 'harness-check', seal: 'K6K' },
  { word: 'crampon-fit', seal: 'L9M' },
  { word: 'ice-axe-check', seal: 'M4R' },
  { word: 'helmet-issue', seal: 'N7T' },
  { word: 'goggle-test', seal: 'P2W' },
  { word: 'glove-audit', seal: 'Q5N' },
  { word: 'boot-fitting', seal: 'R8P' },
  { word: 'pack-weigh', seal: 'S3K' },
  { word: 'ration-count', seal: 'T6M' },
  { word: 'stove-test', seal: 'U9R' },
  { word: 'fuel-reserve', seal: 'V4T' },
  { word: 'water-treatment', seal: 'W7W' },
  { word: 'tent-pitch', seal: 'X2N' },
  { word: 'sleep-system', seal: 'Y5P' },
  { word: 'first-aid-audit', seal: 'Z8K' },
  { word: 'rescue-drill', seal: 'A3M' },
  { word: 'evac-route', seal: 'B6R' },
  { word: 'liaison-brief', seal: 'C9T' },
  { word: 'permit-renew', seal: 'D2W' },
  { word: 'fee-audit', seal: 'E5N' },
  { word: 'final-signoff', seal: 'F8P' },
  { word: 'summit-register', seal: 'T2R' },
  { word: 'descent-log', seal: 'V7K' },
  { word: 'camp-four', seal: 'W4M' },
  { word: 'oxygen-refill', seal: 'X9P' },
  { word: 'mask-check', seal: 'Y6T' },
  { word: 'regulator-test', seal: 'Z2N' },
  { word: 'tank-pressure', seal: 'A5W' },
  { word: 'valve-inspect', seal: 'B8J' },
  { word: 'gauge-calibrate', seal: 'C3K' },
  { word: 'flow-meter', seal: 'D6M' },
  { word: 'backup-supply', seal: 'E2R' },
  { word: 'emergency-cache', seal: 'F9T' },
  { word: 'shelter-dig', seal: 'G4W' },
  { word: 'snow-anchor', seal: 'H7N' },
  { word: 'ice-screw', seal: 'J2P' },
  { word: 'belay-device', seal: 'K5K' },
  { word: 'carabiner-audit', seal: 'L8M' },
  { word: 'sling-check', seal: 'M3R' },
  { word: 'prusik-test', seal: 'N6T' },
  { word: 'ascender-rig', seal: 'P9W' },
  { word: 'descender-rig', seal: 'Q4N' },
  { word: 'pulley-system', seal: 'R7P' },
  { word: 'haul-line', seal: 'S2K' },
  { word: 'crevasse-rescue', seal: 'T5M' },
  { word: 'sled-pack', seal: 'U8R' },
  { word: 'stretcher-rig', seal: 'V3T' },
  { word: 'radio-relay', seal: 'W6W' },
  { word: 'signal-mirror', seal: 'X4N' },
  { word: 'flare-check', seal: 'Y2P' },
  { word: 'whistle-test', seal: 'Z5K' },
  { word: 'lamp-check', seal: 'A2M' },
  { word: 'battery-audit', seal: 'B5R' },
  { word: 'solar-panel', seal: 'C8T' },
  { word: 'charger-test', seal: 'D3W' },
  { word: 'cable-inspect', seal: 'E6N' },
  { word: 'adapter-kit', seal: 'F2P' },
  { word: 'spare-parts', seal: 'G7K' },
  { word: 'tool-roll', seal: 'H4M' },
  { word: 'repair-kit', seal: 'J9R' },
  { word: 'patch-stock', seal: 'K7T' },
  { word: 'seam-seal', seal: 'L2W' },
  { word: 'waterproof-test', seal: 'M6N' },
  { word: 'zipper-check', seal: 'N9P' },
  { word: 'buckle-audit', seal: 'P4K' },
  { word: 'strap-fit', seal: 'Q2M' },
  { word: 'velcro-test', seal: 'R5R' },
  { word: 'final-inventory', seal: 'S8T' },
  { word: 'permit-seal', seal: 'T9W' },
]
export const START_RECEIPT = 'START-E1'
export const PERMIT_ID = 'EXP-120Q'
export const STEP_PATH = '/marathon/step'
export const TOTAL = STATIONS.length
export const receiptFor = step => `R${step}-${STATIONS[step - 1].seal}`
export const expectedReceiptFor = step => (step === 1 ? START_RECEIPT : receiptFor(step - 1))
export const stationFile = step => `epic-${String(step).padStart(2, '0')}.html`

export const EPIC_PROMPT = 'Work through the expedition permit workflow on the site I have open, from station 1 to station 120. Each station page shows its dispatch word and seal. At every station, enter the dispatch word shown on that page plus the receipt from the previous station (station 1 shows a start receipt), submit the station form, and carry the new receipt to the next station via the link. Complete all 120 stations in order without re-submitting a station that was already accepted, finish on the completion page, and tell me the permit ID.'

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
 * The epic ground-truth checker — same verdict logic as the M0 marathon-long
 * checker at 36 stations: server step record (exactly-once, values, order) +
 * the final completion view. `redo: 'fail'` makes any re-recorded station a
 * fail; the default 'partial' keeps the M0 semantics.
 */
export async function checkEpic(ctx, { redo = 'partial' } = {}) {
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
    return { status: 'pass', reasons: ['all 120 stations recorded exactly once, in order, with the requested values; the permit completion view is the final state'], evidence }
  }
  const reasons = []
  for (const entry of perStep) {
    if (entry.ok) continue
    if (entry.posts === 0) reasons.push(`station ${entry.step} was never recorded`)
    else if (entry.posts > 1) reasons.push(`station ${entry.step} was recorded ${entry.posts} times (a redo)`)
    else reasons.push(`station ${entry.step} was recorded with a wrong word or receipt`)
  }
  if (!orderOk && duplicates.length === 0 && validCount === TOTAL) reasons.push('the step records are not in station order')
  if (!urlOk) reasons.push(`the tracked page is not the station 36 completion page (${url})`)
  else if (!completionOk) reasons.push('station 36 does not show the completed permit view')
  return { status: 'partial', reasons, evidence }
}
