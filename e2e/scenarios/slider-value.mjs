/**
 * A1 seed scenario: set a native range input to an exact value.
 * Independent check: the input's own value and the fixture's rendered output.
 */
export const name = 'slider-value'
export const fixture = 'drag.html'
export const prompt = 'Set the Native range slider on this page to exactly 75.'
export const maxTurnSeconds = 90

async function snapshot(ctx) {
  return ctx.evaluate(`(() => ({
    value: document.getElementById('range')?.value ?? null,
    output: document.getElementById('range-value')?.textContent ?? null,
    custom: document.getElementById('custom-thumb')?.getAttribute('aria-valuenow') ?? null,
    order: [...(document.getElementById('pointer-list')?.children ?? [])].map(element => element.dataset.pointerItem),
  }))()`)
}

export async function check(ctx) {
  const state = await snapshot(ctx)
  const collateralClean = state.custom === '20' && state.order.join(',') === 'Alpha,Beta,Gamma'
  if (state.value === '75' && state.output === '75' && collateralClean) {
    return { status: 'pass', reasons: ['native range is exactly 75 and nothing else changed'], evidence: state }
  }
  if (state.value === '75') {
    return { status: 'partial', reasons: ['range is 75 but the fixture output or another widget disagrees'], evidence: state }
  }
  return { status: 'fail', reasons: [`range value is ${state.value ?? 'missing'}, expected 75`], evidence: state }
}

/** Plausible-but-wrong: the rendered output is rewritten while the input stays 20. */
export async function tamper(ctx) {
  await ctx.evaluate(`(() => {
    document.getElementById('range-value').textContent = '75'
    return true
  })()`)
}