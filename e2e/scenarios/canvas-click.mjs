/**
 * A1 seed scenario: click a canvas surface by coordinate.
 * Independent check: the fixture counts only trusted pointerdown events and
 * paints the counters into its state line; we parse that DOM text.
 */
export const name = 'canvas-click'
export const fixture = 'canvas.html'
export const prompt = 'Click once in the middle of the drawing canvas at the top of this page, then tell me what its state line says.'
export const maxTurnSeconds = 90

const PATTERN = /trusted (\d+) · synthetic (\d+) · offset (-?\d+)/u

async function snapshot(ctx) {
  return ctx.evaluate(`(() => ({
    state: document.getElementById('state')?.textContent ?? null,
    domButtonClicks: null,
  }))()`)
}

export async function check(ctx) {
  const raw = await snapshot(ctx)
  const match = PATTERN.exec(String(raw.state ?? ''))
  if (match === null) return { status: 'fail', reasons: ['state line is missing or unreadable'], evidence: raw }
  const trusted = Number(match[1])
  const synthetic = Number(match[2])
  const offset = Number(match[3])
  const state = { ...raw, trusted, synthetic, offset }
  if (trusted === 1 && synthetic === 0 && offset === 0) {
    return { status: 'pass', reasons: ['exactly one trusted canvas pointerdown and no other page action'], evidence: state }
  }
  if (trusted >= 1 && synthetic === 0) {
    return { status: 'partial', reasons: [`trusted=${trusted} synthetic=${synthetic} offset=${offset}`], evidence: state }
  }
  return { status: 'fail', reasons: [`trusted=${trusted} synthetic=${synthetic} offset=${offset}; expected trusted 1, synthetic 0, offset 0`], evidence: state }
}

/** Plausible-but-wrong: a synthetic click lands on the canvas (not trusted input). */
export async function tamper(ctx) {
  await ctx.evaluate(`(() => {
    const canvas = document.getElementById('board')
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }))
    return true
  })()`)
}