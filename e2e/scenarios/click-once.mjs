/**
 * A1 seed scenario: a single labelled-button click must happen exactly once.
 *
 * Independent check: the fixture's own DOM counter and the neighbouring
 * counters (read over the harness's CDP connection). The tool result and the
 * model's answer are never consulted.
 */
export const name = 'click-once'
export const fixture = 'click.html'
export const prompt = 'Click the Increment button on this page exactly once, then tell me what the count is.'
export const maxTurnSeconds = 90

async function snapshot(ctx) {
  return ctx.evaluate(`(() => {
    const text = id => document.getElementById(id)?.textContent ?? null
    return {
      count: text('count'),
      roleCount: text('role-count'),
      semanticCount: text('semantic-count'),
      checkState: text('check-state'),
    }
  })()`)
}

export async function check(ctx) {
  const state = await snapshot(ctx)
  const count = Number(state.count)
  const otherCountersClean = state.roleCount === '0' && state.semanticCount === '0'
  if (count === 1 && otherCountersClean) {
    return { status: 'pass', reasons: ['count is exactly 1 and no other counter changed'], evidence: state }
  }
  if (count === 1) {
    return { status: 'partial', reasons: ['count reached 1 but another control was also activated'], evidence: state }
  }
  return { status: 'fail', reasons: [`count is ${state.count ?? 'missing'}, expected exactly 1`], evidence: state }
}

/** Plausible-but-wrong: the model double-clicks. */
export async function tamper(ctx) {
  await ctx.evaluate(`(() => {
    const button = document.getElementById('counter')
    button.click()
    button.click()
    return true
  })()`)
}