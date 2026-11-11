/**
 * A1 seed scenario (plan item B1's surface): set a canvas-drawn slider that
 * lives inside a cross-origin (site-isolated) iframe. The thumb moves only by a
 * trusted press-and-drag; pressing the track does nothing.
 *
 * Independent check: the inner frame's own state, read over the harness's own
 * CDP connection to the OOPIF target (the agent cannot write it).
 */
export const name = 'frame-canvas-slider'
export const fixture = 'frame-canvas.html'
export const prompt = 'In the embedded pendulum lab on this page, set the Length slider to 70.'
export const maxTurnSeconds = 150

const INNER = 'frame-canvas-inner.html'
const READ = `(() => {
  const lab = window.__lab
  if (!lab?.ready) return null
  return {
    length: lab.length,
    mass: lab.mass,
    drags: lab.drags,
    trustedPresses: lab.trustedPresses,
    missedPresses: lab.missedPresses,
    synthetic: lab.synthetic,
    history: lab.history.slice(-20),
  }
})()`

export async function setup(ctx) {
  // The frame loads after the outer page; wait until its state exists.
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      if (await ctx.evaluateFrame(INNER, '!!window.__lab?.ready')) return
    } catch { /* target not up yet */ }
    if (Date.now() > deadline) throw new Error('the embedded lab frame did not become ready')
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

export async function check(ctx) {
  const state = await ctx.evaluateFrame(INNER, READ)
  if (state === null) return { status: 'fail', reasons: ['embedded lab state is unavailable'], evidence: null }
  if (state.length === 70 && state.mass === 50 && state.synthetic === 0) {
    return { status: 'pass', reasons: ['Length is 70 by trusted drag; Mass untouched'], evidence: state }
  }
  if (state.length === 70) {
    return { status: 'partial', reasons: [`Length is 70 but mass=${state.mass} synthetic=${state.synthetic}`], evidence: state }
  }
  return {
    status: 'fail',
    reasons: [`Length is ${state.length}, expected 70 (mass=${state.mass}, drags=${state.drags}, presses=${state.trustedPresses}, missed=${state.missedPresses})`],
    evidence: state,
  }
}

/** Trusted top-level CDP mouse drag across the frame boundary, in page CSS pixels. */
async function dragThumb(ctx, key, fromValue, toValue) {
  const frame = await ctx.evaluate(`(() => {
    const element = document.getElementById('sim')
    const rect = element.getBoundingClientRect()
    return { left: rect.left + element.clientLeft, top: rect.top + element.clientTop }
  })()`)
  const geometry = await ctx.evaluateFrame(INNER, `(() => ({
    from: window.__lab.thumbX(${fromValue}),
    to: window.__lab.thumbX(${toValue}),
    y: window.__lab.geometry.rows[${JSON.stringify(key)}],
  }))()`)
  const y = frame.top + geometry.y
  const fromX = frame.left + geometry.from
  const toX = frame.left + geometry.to
  await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y, buttons: 0 })
  await ctx.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y, button: 'left', buttons: 1, clickCount: 1 })
  const steps = 12
  for (let step = 1; step <= steps; step += 1) {
    const x = fromX + (toX - fromX) * step / steps
    await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
  }
  await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0, clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 150))
}

/** Plausible-but-wrong: the wrong slider (Mass) is dragged to 70. */
export async function tamper(ctx) {
  await dragThumb(ctx, 'mass', 50, 70)
}

/** Positive control: a trusted drag of the Length thumb from 20 to 70. */
export async function solve(ctx) {
  await dragThumb(ctx, 'length', 20, 70)
}
