/**
 * Pure audio-energy and speech-reactivity engine for the composer's yellow aura.
 *
 * Converts Web Audio time/frequency frames plus Web Speech API lifecycle/result
 * events into smooth level, peak, angular spin, and horizontal focus values.
 */

const MIN_NOISE_FLOOR = 0.004
const MAX_NOISE_FLOOR = 0.06
const DEFAULT_NOISE_FLOOR = 0.014

/** Create mutable state for one dictation session's aura animation loop. */
export function createSpeechAuraState() {
  return {
    noiseFloor: DEFAULT_NOISE_FLOOR,
    level: 0,
    peak: 0,
    angle: 0,
    focusX: 50,
    swayPhase: 0,
    pulse: 0,
    speechActive: false,
    speechHoldUntil: 0,
    lastTranscriptLen: 0,
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Measure normalized speech loudness and spectral tilt from AnalyserNode byte buffers.
 * @param {ArrayLike<number> | null | undefined} timeData
 * @param {ArrayLike<number> | null | undefined} freqData
 * @param {number} [noiseFloor]
 */
export function measureAudioFrame(timeData, freqData, noiseFloor = DEFAULT_NOISE_FLOOR) {
  const prevFloor = clamp(Number.isFinite(noiseFloor) ? noiseFloor : DEFAULT_NOISE_FLOOR, MIN_NOISE_FLOOR, MAX_NOISE_FLOOR)
  let rms = 0
  if (timeData && timeData.length > 0) {
    let sumSq = 0
    for (let i = 0; i < timeData.length; i += 1) {
      const sample = (timeData[i] - 128) / 128
      sumSq += sample * sample
    }
    rms = Math.sqrt(sumSq / timeData.length)
  }

  let nextFloor = prevFloor
  if (rms < prevFloor) {
    nextFloor = prevFloor * 0.92 + rms * 0.08
  } else if (rms < prevFloor * 1.6) {
    nextFloor = prevFloor * 0.992 + rms * 0.008
  }
  nextFloor = clamp(nextFloor, MIN_NOISE_FLOOR, MAX_NOISE_FLOOR)

  const above = Math.max(0, rms - nextFloor * 1.3)
  const level = above > 0 ? clamp01(Math.pow(above / 0.095, 0.6)) : 0

  let balance = 0
  if (freqData && freqData.length >= 2) {
    const split = Math.max(1, Math.floor(freqData.length / 2))
    let lowSum = 0
    let highSum = 0
    for (let i = 0; i < split; i += 1) lowSum += freqData[i]
    for (let i = split; i < freqData.length; i += 1) highSum += freqData[i]
    const lowAvg = lowSum / split
    const highAvg = highSum / (freqData.length - split)
    const total = lowAvg + highAvg
    if (total > 0) {
      balance = clamp((highAvg - lowAvg) / total, -1, 1)
    }
  }

  return { rms, noiseFloor: nextFloor, level, balance }
}

/**
 * Compute an energetic visual impulse whenever dictated transcript length changes.
 * @param {number} prevLen
 * @param {number} nextLen
 */
export function transcriptImpulse(prevLen, nextLen) {
  const delta = Math.max(1, Math.abs((Number(nextLen) || 0) - (Number(prevLen) || 0)))
  return clamp01(0.62 + delta * 0.055)
}

/**
 * Advance the speech-reactive aura state by one animation step.
 * @param {ReturnType<createSpeechAuraState>} state
 * @param {{now: number, dtMs: number, micLevel?: number, micBalance?: number, hasMicStream?: boolean, reducedMotion?: boolean}} input
 */
export function stepSpeechAura(state, {
  now = 0,
  dtMs = 16.67,
  micLevel = 0,
  micBalance = 0,
  hasMicStream = false,
  reducedMotion = false,
} = {}) {
  const dt = clamp(Number.isFinite(dtMs) ? dtMs : 16.67, 1, 80)
  const frameScale = dt / 16.67
  const dtSec = dt / 1000

  state.pulse *= Math.pow(0.88, frameScale)
  if (state.pulse < 0.001) state.pulse = 0

  const holdingSpeech = state.speechActive || now < state.speechHoldUntil
  const wave = holdingSpeech ? 0.42 + 0.18 * Math.sin(now * 0.015) : 0
  const eventLevel = Math.max(state.pulse, wave)
  const safeMicLevel = clamp01(Number.isFinite(micLevel) ? micLevel : 0)
  const target = hasMicStream
    ? Math.max(safeMicLevel, state.pulse * 0.72)
    : Math.max(safeMicLevel, eventLevel)

  const levelRate = 1 - Math.pow(1 - (target > state.level ? 0.44 : 0.11), frameScale)
  state.level = clamp01(state.level + (target - state.level) * levelRate)

  const peakTarget = clamp01(target * 1.15)
  const peakRate = 1 - Math.pow(1 - (peakTarget > state.peak ? 0.68 : 0.17), frameScale)
  state.peak = clamp01(state.peak + (peakTarget - state.peak) * peakRate)

  if (state.level < 0.001 && target === 0) state.level = 0
  if (state.peak < 0.001 && peakTarget === 0) state.peak = 0

  if (reducedMotion) {
    state.focusX = 50
  } else {
    state.angle = (state.angle + (42 + state.level * 240 + state.peak * 110) * dtSec) % 360
    state.swayPhase += dtSec * (1.8 + state.level * 5.2)
    const safeBalance = clamp(Number.isFinite(micBalance) ? micBalance : 0, -1, 1)
    const sway = Math.sin(state.swayPhase) * (0.18 + state.level * 0.42)
    const targetFocusX = 50 + clamp(safeBalance * 0.65 + sway, -1, 1) * 30
    const focusRate = 1 - Math.pow(1 - 0.24, frameScale)
    state.focusX = clamp(state.focusX + (targetFocusX - state.focusX) * focusRate, 20, 80)
  }

  return {
    level: state.level,
    peak: state.peak,
    angle: state.angle,
    focusX: state.focusX,
    speaking: state.level > 0.14 || state.peak > 0.2,
  }
}

/** Create spring/energy state for cursor-hover and typing aura reactivity. */
export function createInteractiveAuraState() {
  return {
    x: 50,
    y: 50,
    vx: 0,
    vy: 0,
    targetX: 50,
    targetY: 50,
    hoverEnergy: 0,
    wake: 0,
    typeEnergy: 0,
    typeX: 50,
    typeY: 26,
    lastInputSource: 'caret',
    hovering: false,
    angle: 0,
  }
}

/**
 * Estimate horizontal aura focus (14..86%) from the caret's column on its line,
 * softly folding every 44 characters so long single lines glide across the box.
 * @param {string} value
 * @param {number} [caretPos]
 */
export function estimateCaretFocusX(value, caretPos) {
  const text = String(value ?? '')
  const end = clamp(Number.isFinite(caretPos) ? Math.floor(caretPos) : text.length, 0, text.length)
  const lineStart = text.lastIndexOf('\n', end - 1) + 1
  const col = Math.max(0, end - lineStart)
  const cycle = col % 88
  const folded = cycle <= 44 ? cycle : 88 - cycle
  return 14 + (folded / 44) * 72
}

/**
 * Advance the 2D fluid spring and hover/typing energies by one animation frame.
 * @param {ReturnType<createInteractiveAuraState>} state
 * @param {{dtMs?: number, reducedMotion?: boolean}} [options]
 */
export function stepInteractiveAura(state, { dtMs = 16.67, reducedMotion = false } = {}) {
  const dt = clamp(Number.isFinite(dtMs) ? dtMs : 16.67, 1, 50)
  const frameScale = dt / 16.67
  const dtSec = dt / 1000

  state.typeEnergy *= Math.pow(0.92, frameScale)
  if (state.typeEnergy < 0.001) state.typeEnergy = 0

  if (reducedMotion) {
    state.x = 50
    state.y = 50
    state.vx = 0
    state.vy = 0
    state.wake = 0
    const target = state.hovering ? 0.5 : 0
    const rate = 1 - Math.pow(1 - (target > state.hoverEnergy ? 0.18 : 0.08), frameScale)
    state.hoverEnergy = clamp01(state.hoverEnergy + (target - state.hoverEnergy) * rate)
    if (!state.hovering && state.hoverEnergy < 0.001) state.hoverEnergy = 0
    const active = state.hovering || state.hoverEnergy > 0.004 || state.typeEnergy > 0.004
    return {
      x: 50,
      y: 50,
      hoverEnergy: state.hoverEnergy,
      typeEnergy: state.typeEnergy,
      stretch: 1,
      dx: 0,
      dy: 0,
      angle: state.angle,
      active,
    }
  }

  let goalX = 50
  let goalY = 50
  const typing = state.typeEnergy > 0.05
  const isCaretGoal = typing && (state.lastInputSource !== 'pointer' || !state.hovering)
  if (isCaretGoal) {
    goalX = state.typeX
    goalY = Number.isFinite(state.typeY) ? state.typeY : 26
  } else if (state.hovering && typing) {
    goalX = state.targetX * 0.7 + state.typeX * 0.3
    goalY = state.targetY * 0.7 + (Number.isFinite(state.typeY) ? state.typeY : 26) * 0.3
  } else if (state.hovering) {
    goalX = state.targetX
    goalY = state.targetY
  }

  const stiffness = isCaretGoal ? 210 : 95
  const damping = isCaretGoal ? 24 : 13.5
  const ax = (goalX - state.x) * stiffness - state.vx * damping
  const ay = (goalY - state.y) * stiffness - state.vy * damping
  state.vx += ax * dtSec
  state.vy += ay * dtSec
  state.x = clamp(state.x + state.vx * dtSec, 4, 96)
  state.y = clamp(state.y + state.vy * dtSec, 4, 96)

  state.wake *= Math.pow(0.86, frameScale)
  if (state.wake < 0.001) state.wake = 0

  const hoverTarget = state.hovering ? Math.min(1, 0.74 + state.wake * 0.42) : 0
  const hoverRate = 1 - Math.pow(1 - (hoverTarget > state.hoverEnergy ? 0.18 : 0.08), frameScale)
  state.hoverEnergy = clamp01(state.hoverEnergy + (hoverTarget - state.hoverEnergy) * hoverRate)
  if (!state.hovering && state.hoverEnergy < 0.001) state.hoverEnergy = 0

  const speed = Math.hypot(state.vx, state.vy)
  const stretch = 1 + Math.min(0.28, speed / 420)

  if (Math.hypot(state.x - 50, state.y - 50) > 1) {
    const targetAngle = (Math.atan2(state.y - 50, state.x - 50) * 180) / Math.PI + 90
    const delta = ((targetAngle - state.angle + 540) % 360) - 180
    const angleRate = 1 - Math.pow(1 - 0.22, frameScale)
    state.angle = (state.angle + delta * angleRate + 360) % 360
  }

  const moving = speed > 0.25 || Math.hypot(goalX - state.x, goalY - state.y) > 0.25
  const active = state.hovering || state.hoverEnergy > 0.004 || state.typeEnergy > 0.004 || state.wake > 0.004 || moving
  if (!active) {
    state.x = 50
    state.y = 50
    state.vx = 0
    state.vy = 0
    state.hoverEnergy = 0
    state.typeEnergy = 0
    state.wake = 0
  }

  return {
    x: state.x,
    y: state.y,
    hoverEnergy: state.hoverEnergy,
    typeEnergy: state.typeEnergy,
    stretch,
    dx: (state.x - 50) / 50,
    dy: (state.y - 50) / 50,
    angle: state.angle,
    active,
  }
}
