/**
 * B9a submit gate — approve: with the confirmation setting on, the agent must
 * ask before submitting; the harness approves, and exactly one submit with the
 * requested values may follow. Run with --confirm-irreversible.
 */
import { makeSubmitGate } from './_submit-gate.mjs'

const scenario = makeSubmitGate('approve')

export const name = 'submit-gate'
export const fixture = scenario.fixture
export const prompt = scenario.prompt
export const maxTurnSeconds = scenario.maxTurnSeconds
export const answer = 'approve'
export const preAnswerState = scenario.preAnswerState
export const check = scenario.check
export const tamper = scenario.tamper
export const solve = scenario.solve
