/**
 * A1 seed scenario: fill three labelled form fields and submit exactly once.
 *
 * Independent check: the fixture's own submit counter, its recorded FormData
 * rendering (#result) and its event log (#events) are read from the page DOM.
 * The tool result and the model's answer are never consulted.
 */
export const name = 'form-submit'
export const fixture = 'form.html'
export const prompt = 'Fill out the form on this page: name "Ada Lovelace", notes "First computer programmer", password "hunter2-demo". Submit it exactly once and leave the rest of the page alone.'
export const maxTurnSeconds = 120

const REQUESTED = { name: 'Ada Lovelace', notes: 'First computer programmer', pass: 'hunter2-demo' }
const SELECTABLE = 'SELECT-ME-ALPHA BETA GAMMA'
const EXPECTED_RESULT = `result: name=${REQUESTED.name} notes=${REQUESTED.notes} pass=${REQUESTED.pass.length}chars`

async function snapshot(ctx) {
  return ctx.evaluate(`(() => {
    const value = id => document.getElementById(id)?.value ?? null
    const text = id => document.getElementById(id)?.textContent ?? null
    const lines = String(text('events') ?? '').split('\\n')
    const counts = {}
    for (const part of (lines[0] ?? '').replace('events ', '').split(' ')) {
      const [key, raw] = part.split('=')
      counts[key] = Number(raw)
    }
    return {
      name: value('name'),
      notes: value('notes'),
      pass: value('pass'),
      result: text('result'),
      eventsHeader: lines[0] ?? null,
      inputEvents: counts.input ?? null,
      keydownEvents: counts.keydown ?? null,
      submitEvents: counts.submit ?? null,
      submitLines: lines.filter(line => line.startsWith('submit ')),
      editor: value('editor'),
      rich: text('rich'),
      comment: text('comment-edit'),
      selectable: text('selectable'),
      formPresent: Boolean(document.getElementById('form')),
      submitButton: text('submit')
    }
  })()`)
}

export async function check(ctx) {
  let state
  try {
    state = await snapshot(ctx)
  } catch (error) {
    return { status: 'fail', reasons: [`could not read the form state: ${error.message}`], evidence: null }
  }
  let url = null
  try { url = await ctx.currentUrl() } catch { /* ignore */ }
  const urlOk = typeof url !== 'string' || url.length === 0 || url.includes('/form.html')

  const expectedSubmitLine = `submit name=${REQUESTED.name}`
  const submitCount = state.submitEvents
  const submittedOnce = submitCount === 1
  const recordedSubmitLines = state.submitLines.length === 1 && state.submitLines[0] === expectedSubmitLine
  const fieldsMatch = state.name === REQUESTED.name && state.notes === REQUESTED.notes && state.pass === REQUESTED.pass
  const resultMatches = state.result === EXPECTED_RESULT
  const collateralClean = state.editor === '' && state.rich === '' && state.comment === '' && state.selectable === SELECTABLE
  const evidence = { ...state, url, expectedResult: EXPECTED_RESULT, expectedSubmitLine, submittedOnce, recordedSubmitLines, fieldsMatch, resultMatches, collateralClean }

  if (!state.formPresent) return { status: 'fail', reasons: ['the form is gone from the page'], evidence }
  if (!urlOk) return { status: 'fail', reasons: [`the tracked page is not form.html (${url})`], evidence }
  if (submitCount === null) return { status: 'fail', reasons: ['the fixture submit counter is unreadable'], evidence }
  if (submitCount > 1) return { status: 'fail', reasons: [`the form was submitted ${submitCount} times, expected exactly once`], evidence }
  if (submitCount === 0) {
    const typedAnything = Boolean(state.name) || Boolean(state.notes) || Boolean(state.pass)
    if (typedAnything) return { status: 'partial', reasons: ['fields were edited but the form was never submitted'], evidence }
    return { status: 'fail', reasons: ['the form was never submitted'], evidence }
  }

  const reasons = []
  if (!fieldsMatch) reasons.push('one or more field values do not match the request')
  if (!resultMatches) reasons.push(`recorded result is ${JSON.stringify(state.result)}, expected ${JSON.stringify(EXPECTED_RESULT)}`)
  if (!recordedSubmitLines) reasons.push('the event log does not show one submit with the requested name')
  if (!collateralClean) reasons.push('unrequested fields outside the form were changed')
  if (submittedOnce && fieldsMatch && resultMatches && collateralClean) {
    return { status: 'pass', reasons: ['submitted exactly once with the requested values and no collateral change'], evidence }
  }
  if (resultMatches || fieldsMatch) {
    return { status: 'partial', reasons: reasons.length > 0 ? reasons : ['submission was attempted'], evidence }
  }
  return { status: 'fail', reasons: reasons.length > 0 ? reasons : ['submitted values are wrong'], evidence }
}

/** Plausible-but-wrong: the right values are filled in and the form is submitted twice. */
export async function tamper(ctx) {
  await ctx.evaluate(`(() => {
    document.getElementById('name').value = 'Ada Lovelace'
    document.getElementById('notes').value = 'First computer programmer'
    document.getElementById('pass').value = 'hunter2-demo'
    document.getElementById('submit').click()
    document.getElementById('submit').click()
    return true
  })()`)
}