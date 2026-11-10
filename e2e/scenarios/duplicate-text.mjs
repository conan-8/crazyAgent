/**
 * A1 seed scenario: a reveal request names text that occurs twice and gives no
 * ordinal. Correct behavior is to leave the page untouched, reveal neither
 * occurrence arbitrarily, and report the ambiguity (or ask which one).
 *
 * Independent check: the page DOM is the hard gate — both paragraphs, field
 * values, selection, click counter and destination state must be unchanged.
 * The turn's final text and failed tool calls are used only as secondary
 * evidence for pass vs partial; they can never upgrade a changed page.
 */
export const name = 'duplicate-text'
export const fixture = 'find.html'
export const prompt = 'Scroll to the paragraph that starts with "Duplicate needle" on this page and tell me what it says.'
export const maxTurnSeconds = 90

const DUPLICATE_PARAGRAPHS = ['Duplicate needle first', 'Duplicate needle second']
const FIELD_VALUE = 'preserve this value'
const CONTROL_VALUE = 'CONTROL-VALUE-NEEDLE'
const PASSWORD_VALUE = 'PASSWORD-FIND-SECRET'
const SELECTION_PARAGRAPH = 'Preserve this exact selection during semantic find.'

const AMBIGUITY_REPORT = /\b(?:ambigu\w*|occurrence|ordinal|which one|which of the two|which occurrence|which paragraph|twice|two (?:matches|paragraphs|lines|occurrences|places)|both (?:paragraphs|lines|matches|of them|say|read)|more than one (?:match|paragraph|line)|multiple matches|one (?:says|reads)[\s\S]{0,200}the other)\b/iu
const ACTION_CLAIM = /\b(?:I (?:have )?(?:scrolled|revealed|selected|clicked|picked|chose|jumped|navigated|highlighted)|I've (?:scrolled|revealed|selected|clicked|picked|chosen)|(?:scrolled|revealed|jumped|navigated) to the (?:first|second|last)|using the (?:first|second|last) occurrence)\b/iu
const ORDINAL_CHOICE = /\b(?:the )?(?:first|second|last) (?:occurrence|paragraph|match|line|one)\b/iu
const AMBIGUITY_FAILURE = /FIND_AMBIGUOUS|ambiguous|pass occurrence|multiple match|matches for/iu

async function snapshot(ctx) {
  return ctx.evaluate(`(() => {
    const selection = window.getSelection()
    return {
      duplicates: [...document.querySelectorAll('p.duplicate')].map(paragraph => String(paragraph.textContent ?? '')),
      selectionText: String(selection ?? ''),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      focusValue: document.getElementById('focus-field')?.value ?? null,
      controlValue: document.getElementById('control-input')?.value ?? null,
      passwordValue: document.getElementById('password-input')?.value ?? null,
      clickCount: document.getElementById('click-count')?.textContent ?? null,
      destinationState: document.getElementById('destination-state')?.textContent ?? null,
      destinationButton: document.getElementById('destination-button')?.textContent ?? null,
      selectionParagraph: document.getElementById('selection')?.textContent ?? null,
      hiddenParagraphHidden: document.querySelector('p[hidden]') ? document.querySelector('p[hidden]').hidden === true : false
    }
  })()`)
}

function failureSummary(failed) {
  return (Array.isArray(failed) ? failed : [])
    .map(item => [item?.code, item?.tool, item?.message].filter(Boolean).join(' '))
    .join(' | ')
}

export async function check(ctx) {
  let state
  try {
    state = await snapshot(ctx)
  } catch (error) {
    return { status: 'fail', reasons: [`could not read the page state: ${error.message}`], evidence: null }
  }
  let url = null
  try { url = await ctx.currentUrl() } catch { /* ignore */ }
  const urlOk = typeof url !== 'string' || url.length === 0 || url.includes('/find.html')

  const turn = ctx.turn ?? {}
  const finalText = typeof turn.finalText === 'string' ? turn.finalText : ''
  const waitingForUser = turn.waitingForUser === true
  const failureText = failureSummary(turn.failed)
  const ambiguityFailure = AMBIGUITY_FAILURE.test(failureText)
  const reportsAmbiguity = waitingForUser || AMBIGUITY_REPORT.test(finalText)
  const actionClaim = ACTION_CLAIM.test(finalText)
  const ordinalChoice = ORDINAL_CHOICE.test(finalText)

  const duplicatesClean = state.duplicates.length === DUPLICATE_PARAGRAPHS.length
    && state.duplicates.every((text, index) => text === DUPLICATE_PARAGRAPHS[index])
  const fieldsClean = state.focusValue === FIELD_VALUE
    && state.controlValue === CONTROL_VALUE
    && state.passwordValue === PASSWORD_VALUE
  const selectionClean = state.selectionText === '' && state.selectionParagraph === SELECTION_PARAGRAPH
  const clicksClean = state.clickCount === 'clicks 0'
  const destinationClean = state.destinationState === 'destination idle'
  const pageClean = duplicatesClean && fieldsClean && selectionClean && clicksClean && destinationClean && state.hiddenParagraphHidden === true
  const scrollClean = state.scrollX === 0 && state.scrollY === 0

  const evidence = {
    url,
    pageClean,
    scrollClean,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    duplicates: state.duplicates,
    selectionText: state.selectionText,
    clickCount: state.clickCount,
    destinationState: state.destinationState,
    waitingForUser,
    turnStatus: turn.status ?? null,
    reportsAmbiguity,
    ambiguityFailure,
    actionClaim,
    ordinalChoice,
    finalText: finalText.slice(0, 400),
    failed: failureText.slice(0, 400)
  }

  if (!urlOk) return { status: 'fail', reasons: [`the tracked page is not find.html (${url})`], evidence }
  if (!pageClean) return { status: 'fail', reasons: ['the page was edited, or its selection/field/click state changed'], evidence }
  if (reportsAmbiguity && !actionClaim && scrollClean) {
    return { status: 'pass', reasons: ['the duplicated text was reported as ambiguous and neither occurrence was revealed or altered'], evidence }
  }
  if (reportsAmbiguity || ambiguityFailure || actionClaim || ordinalChoice || !scrollClean) {
    return { status: 'partial', reasons: ['the ambiguity was detected but the agent reported or hinted at an arbitrary occurrence'], evidence }
  }
  return { status: 'fail', reasons: ['no ambiguity was reported and no correct reveal happened'], evidence }
}

/** Plausible-but-wrong: one duplicate is scrolled to and selected, as if it were the requested occurrence. */
export async function tamper(ctx) {
  await ctx.evaluate(`(() => {
    const duplicates = [...document.querySelectorAll('p.duplicate')]
    const target = duplicates[1] ?? duplicates[0]
    if (target) target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    window.scrollTo(0, Math.max(0, window.scrollY + 320))
    const selection = window.getSelection()
    if (duplicates[0]) {
      const range = document.createRange()
      range.selectNodeContents(duplicates[0])
      selection.removeAllRanges()
      selection.addRange(range)
    }
    return true
  })()`)
}