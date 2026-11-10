/**
 * A1 seed scenario: scroll a unique, off-screen sentence fully into view.
 *
 * Independent check: the destination element's bounding box against the
 * viewport plus the fixture's own preserved user state (field values,
 * selection, click counter, destination state) read from the DOM. The tool
 * result and the model's answer are never consulted.
 */
export const name = 'find-reveal'
export const fixture = 'find.html'
export const prompt = 'Scroll to the text "UNIQUE-FIND-MARKER" on this page and bring it fully into view. Don\'t click or edit anything.'
export const maxTurnSeconds = 90

const FIELD_VALUE = 'preserve this value'
const CONTROL_VALUE = 'CONTROL-VALUE-NEEDLE'
const PASSWORD_VALUE = 'PASSWORD-FIND-SECRET'
const SELECTION_PARAGRAPH = 'Preserve this exact selection during semantic find.'

async function snapshot(ctx) {
  return ctx.evaluate(`(() => {
    const marker = [...document.querySelectorAll('p')].find(paragraph => String(paragraph.textContent ?? '').includes('UNIQUE-FIND-MARKER'))
    const rect = marker ? marker.getBoundingClientRect() : null
    const selection = window.getSelection()
    const hiddenParagraph = document.querySelector('p[hidden]')
    const ariaHiddenParagraph = document.querySelector('p[aria-hidden="true"]')
    return {
      markerFound: Boolean(marker),
      markerText: marker ? String(marker.textContent) : null,
      markerRect: rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null,
      markerFullyVisible: Boolean(rect)
        && rect.width > 0 && rect.height > 0
        && rect.top >= 0 && rect.bottom <= window.innerHeight
        && rect.left >= 0 && rect.right <= window.innerWidth,
      markerIntersectsViewport: Boolean(rect)
        && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      selectionText: String(selection ?? ''),
      focusValue: document.getElementById('focus-field')?.value ?? null,
      controlValue: document.getElementById('control-input')?.value ?? null,
      passwordValue: document.getElementById('password-input')?.value ?? null,
      passwordType: document.getElementById('password-input')?.type ?? null,
      clickCount: document.getElementById('click-count')?.textContent ?? null,
      destinationState: document.getElementById('destination-state')?.textContent ?? null,
      destinationButton: document.getElementById('destination-button')?.textContent ?? null,
      selectionParagraph: document.getElementById('selection')?.textContent ?? null,
      hiddenParagraphHidden: hiddenParagraph ? hiddenParagraph.hidden === true : false,
      ariaHiddenValue: ariaHiddenParagraph?.getAttribute('aria-hidden') ?? null
    }
  })()`)
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

  const fieldsClean = state.focusValue === FIELD_VALUE
    && state.controlValue === CONTROL_VALUE
    && state.passwordValue === PASSWORD_VALUE
    && state.passwordType === 'password'
  const selectionClean = state.selectionText === '' && state.selectionParagraph === SELECTION_PARAGRAPH
  const clicksClean = state.clickCount === 'clicks 0'
  const destinationClean = state.destinationState === 'destination idle' && state.destinationButton === 'Destination action'
  const hiddenClean = state.hiddenParagraphHidden === true && state.ariaHiddenValue === 'true'
  const pageClean = fieldsClean && selectionClean && clicksClean && destinationClean && hiddenClean
  const evidence = {
    url,
    markerFound: state.markerFound,
    markerFullyVisible: state.markerFullyVisible,
    markerIntersectsViewport: state.markerIntersectsViewport,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    viewport: state.viewport,
    markerRect: state.markerRect,
    fieldsClean,
    selectionClean,
    clicksClean,
    destinationClean,
    hiddenClean,
    focusValue: state.focusValue,
    controlValue: state.controlValue,
    passwordValue: state.passwordValue,
    clickCount: state.clickCount,
    destinationState: state.destinationState,
    selectionText: state.selectionText
  }

  if (!urlOk) return { status: 'fail', reasons: [`the tracked page is not find.html (${url})`], evidence }
  if (!state.markerFound) return { status: 'fail', reasons: ['the unique destination text is missing from the page'], evidence }
  if (!pageClean) return { status: 'fail', reasons: ['the page was edited or its preserved field/selection/click state changed'], evidence }
  if (state.markerFullyVisible) {
    return { status: 'pass', reasons: ['the unique text is fully inside the viewport and no other page state changed'], evidence }
  }
  if (state.markerIntersectsViewport || state.scrollY > 0) {
    return { status: 'partial', reasons: ['the page moved but the unique text is not fully in view'], evidence }
  }
  return { status: 'fail', reasons: ['the page did not scroll to the unique text'], evidence }
}

/** Plausible-but-wrong: the marker is scrolled into view while the preserved field and selection are modified. */
export async function tamper(ctx) {
  await ctx.evaluate(`(() => {
    const marker = [...document.querySelectorAll('p')].find(paragraph => String(paragraph.textContent ?? '').includes('UNIQUE-FIND-MARKER'))
    if (marker) marker.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    document.getElementById('focus-field').value = 'tampered value'
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('selection'))
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  })()`)
}