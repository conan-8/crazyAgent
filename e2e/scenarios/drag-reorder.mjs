/**
 * A1 seed scenario: reorder a pointer-sortable list by dragging Alpha after
 * Gamma. Independent check: child order and untouched widget values read from
 * the fixture's DOM, not from the drag tool's result.
 */
export const name = 'drag-reorder'
export const fixture = 'drag.html'
export const prompt = 'In the Pointer sortable list on this page, drag Alpha so the order becomes Beta, Gamma, Alpha.'
export const maxTurnSeconds = 120

const INITIAL = 'Alpha,Beta,Gamma'
const TARGET = 'Beta,Gamma,Alpha'

async function snapshot(ctx) {
  return ctx.evaluate(`(() => ({
    order: [...(document.getElementById('pointer-list')?.children ?? [])].map(element => element.dataset.pointerItem),
    rangeValue: document.getElementById('range')?.value ?? null,
    customValue: document.getElementById('custom-thumb')?.getAttribute('aria-valuenow') ?? null,
    html5Parent: document.getElementById('html5-source')?.parentElement?.id ?? null,
    selection: String(getSelection()),
  }))()`)
}

export async function check(ctx) {
  const state = await snapshot(ctx)
  const order = state.order.join(',')
  const collateralClean = state.rangeValue === '20' && state.customValue === '20'
    && state.html5Parent === 'html5-origin' && state.selection === ''
  if (order === TARGET && collateralClean) {
    return { status: 'pass', reasons: ['pointer order is Beta, Gamma, Alpha with no other widget change'], evidence: state }
  }
  if (order === TARGET) {
    return { status: 'partial', reasons: ['order is correct but another widget changed'], evidence: state }
  }
  if (order !== INITIAL) {
    return { status: 'partial', reasons: [`order is ${order}, not ${TARGET}`], evidence: state }
  }
  return { status: 'fail', reasons: [`order stayed ${order}`], evidence: state }
}

/** Plausible-but-wrong: the fixture's order attribute is rewritten but the DOM never reorders. */
export async function tamper(ctx) {
  await ctx.evaluate(`(() => {
    const list = document.getElementById('pointer-list')
    list.dataset.order = 'Beta,Gamma,Alpha'
    document.getElementById('pointer-state').textContent = 'order: Beta,Gamma,Alpha'
    return true
  })()`)
}