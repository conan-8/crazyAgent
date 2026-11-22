import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createInteractiveAuraState,
  createSpeechAuraState,
  estimateCaretFocusX,
  measureAudioFrame,
  stepInteractiveAura,
  stepSpeechAura,
  transcriptImpulse,
} from '../sidepanel/speech-aura.js'

function sineTimeData(amplitude, length = 256, cycles = 4) {
  const buf = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    const v = 128 + Math.round(Math.sin((i / length) * Math.PI * 2 * cycles) * amplitude * 127)
    buf[i] = Math.max(0, Math.min(255, v))
  }
  return buf
}

test('measureAudioFrame keeps silence at zero and drives loud levels for normal voice RMS', () => {
  const silentTime = new Uint8Array(256).fill(128)
  const flatFreq = new Uint8Array(128).fill(0)
  const silence = measureAudioFrame(silentTime, flatFreq, 0.014)
  assert.equal(silence.rms, 0)
  assert.equal(silence.level, 0)
  assert.equal(silence.balance, 0)
  assert.ok(silence.noiseFloor < 0.014)

  // Low ambient hum slightly above floor slowly nudges floor upward without spiking level
  const humTime = sineTimeData(0.025)
  const hum = measureAudioFrame(humTime, flatFreq, 0.014)
  assert.ok(hum.noiseFloor >= 0.014)
  assert.ok(hum.level < 0.25)

  // Normal speech sine wave (RMS ~0.085) produces a punchy visual level >= 0.55
  const voiceTime = sineTimeData(0.12)
  const voice = measureAudioFrame(voiceTime, flatFreq, 0.014)
  assert.ok(voice.rms > 0.07)
  assert.ok(voice.level >= 0.55, `expected voice level >= 0.55, got ${voice.level}`)
})

test('measureAudioFrame tracks spectral low-vs-high balance across bins', () => {
  const time = sineTimeData(0.1)
  const lowHeavy = new Uint8Array(64)
  lowHeavy.fill(180, 0, 32)
  lowHeavy.fill(20, 32, 64)
  const lowResult = measureAudioFrame(time, lowHeavy)
  assert.ok(lowResult.balance < -0.6, `expected negative balance for low frequencies, got ${lowResult.balance}`)

  const highHeavy = new Uint8Array(64)
  highHeavy.fill(20, 0, 32)
  highHeavy.fill(180, 32, 64)
  const highResult = measureAudioFrame(time, highHeavy)
  assert.ok(highResult.balance > 0.6, `expected positive balance for high frequencies, got ${highResult.balance}`)
})

test('stepSpeechAura reacts fast on speech, decays smoothly on silence, and accelerates rotation when loud', () => {
  const quiet = createSpeechAuraState()
  const loud = createSpeechAuraState()

  for (let i = 0; i < 4; i += 1) {
    stepSpeechAura(quiet, { now: i * 16.67, dtMs: 16.67, micLevel: 0, hasMicStream: true })
    stepSpeechAura(loud, { now: i * 16.67, dtMs: 16.67, micLevel: 0.9, micBalance: 0.8, hasMicStream: true })
  }

  assert.equal(quiet.level, 0)
  assert.ok(loud.level > 0.75, `fast attack expected level > 0.75, got ${loud.level}`)
  assert.ok(loud.peak > loud.level, `peak should exceed or match level (${loud.peak} vs ${loud.level})`)
  assert.ok(loud.angle > quiet.angle + 10, `loud speech must spin faster (${loud.angle} vs ${quiet.angle})`)
  assert.ok(loud.focusX > 52, `positive spectral balance shifts focus right (${loud.focusX})`)

  let frame = { speaking: true }
  for (let i = 0; i < 45; i += 1) {
    frame = stepSpeechAura(loud, { now: 100 + i * 16.67, dtMs: 16.67, micLevel: 0, hasMicStream: true })
  }
  assert.equal(frame.speaking, false, 'aura settles back to calm speaking:false after silence')
  assert.ok(frame.level < 0.05)
})

test('stepSpeechAura fallback reacts to transcriptImpulse and speechActive without mic stream, and honors reducedMotion', () => {
  const state = createSpeechAuraState()
  state.speechActive = true
  state.pulse = transcriptImpulse(0, 12)
  state.speechHoldUntil = 400

  const active = stepSpeechAura(state, { now: 100, dtMs: 16.67, hasMicStream: false })
  assert.equal(active.speaking, true)
  assert.ok(active.level > 0.35, `expected strong fallback reactivity, got ${active.level}`)

  const reduced = createSpeechAuraState()
  reduced.speechActive = true
  reduced.pulse = 0.85
  const rFrame = stepSpeechAura(reduced, { now: 120, dtMs: 50, micBalance: 0.9, hasMicStream: false, reducedMotion: true })
  assert.equal(rFrame.angle, 0, 'reducedMotion does not spin gradient angle')
  assert.equal(rFrame.focusX, 50, 'reducedMotion keeps horizontal focus centered')
  assert.ok(rFrame.level > 0.4, 'reducedMotion still scales glow brightness cleanly')
})

test('estimateCaretFocusX maps line column and wraps softly on long lines', () => {
  assert.equal(estimateCaretFocusX('', 0), 14)
  assert.equal(Math.round(estimateCaretFocusX('a'.repeat(22), 22)), 50)
  assert.equal(estimateCaretFocusX('a'.repeat(44), 44), 86)
  assert.equal(estimateCaretFocusX('first line long\nabc', 19), estimateCaretFocusX('abc', 3))
  const at56 = estimateCaretFocusX('a'.repeat(56), 56)
  assert.ok(at56 >= 14 && at56 < 86, `long lines wrap smoothly (${at56})`)
})

test('stepInteractiveAura tracks hover cursor with fluid spring stretch, tracks typing, and settles at rest', () => {
  const hover = createInteractiveAuraState()
  hover.hovering = true
  hover.targetX = 88
  hover.targetY = 24
  hover.wake = 0.85

  let maxStretch = 1
  let frame
  for (let i = 0; i < 40; i += 1) {
    frame = stepInteractiveAura(hover, { dtMs: 16.67 })
    maxStretch = Math.max(maxStretch, frame.stretch)
  }
  assert.ok(maxStretch > 1.05, `moving cursor should stretch gradient fluidly (${maxStretch})`)
  assert.ok(frame.x > 78 && frame.y < 34, `spring converges toward target (${frame.x}, ${frame.y})`)
  assert.ok(frame.hoverEnergy > 0.7, `hover builds warm aura energy (${frame.hoverEnergy})`)
  assert.equal(frame.active, true)

  // Leaving hover settles back to inactive rest at center
  hover.hovering = false
  for (let i = 0; i < 180; i += 1) {
    frame = stepInteractiveAura(hover, { dtMs: 16.67 })
  }
  assert.equal(frame.active, false)
  assert.equal(frame.x, 50)
  assert.equal(frame.y, 50)

  // Typing drifts toward caret horizontal focus and builds typeEnergy
  const typing = createInteractiveAuraState()
  typing.typeEnergy = 0.9
  typing.typeX = estimateCaretFocusX('a'.repeat(40), 40)
  for (let i = 0; i < 20; i += 1) {
    frame = stepInteractiveAura(typing, { dtMs: 16.67 })
  }
  assert.ok(frame.x > 64 && frame.y < 42, `typing pulls glow toward caret (${frame.x}, ${frame.y})`)
  assert.ok(frame.typeEnergy > 0.15)

  // Typing pulls toward caret left/right even if cursor previously hovered opposite edge
  const caretDominates = createInteractiveAuraState()
  caretDominates.hovering = true
  caretDominates.targetX = 12
  caretDominates.targetY = 80
  caretDominates.typeEnergy = 0.9
  caretDominates.typeX = 88
  caretDominates.typeY = 30
  caretDominates.lastInputSource = 'caret'
  for (let i = 0; i < 25; i += 1) {
    frame = stepInteractiveAura(caretDominates, { dtMs: 16.67 })
  }
  assert.ok(frame.x > 74, `caret source must follow typed side instead of stationary hover (${frame.x})`)

  // reducedMotion keeps center fixed without spatial movement
  const rm = createInteractiveAuraState()
  rm.hovering = true
  rm.targetX = 90
  rm.typeEnergy = 0.8
  const rmFrame = stepInteractiveAura(rm, { dtMs: 32, reducedMotion: true })
  assert.equal(rmFrame.x, 50)
  assert.equal(rmFrame.y, 50)
  assert.equal(rmFrame.stretch, 1)
})
