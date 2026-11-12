/**
 * B9a submit gate — deny: with the confirmation setting on, the agent must ask
 * before submitting; the harness denies, and nothing may be submitted. Run
 * with --confirm-irreversible.
 */
import { makeSubmitGate } from './_submit-gate.mjs'

const scenario = makeSubmitGate('deny')

export const name = 'submit-gate-deny'
export const fixture = scenario.fixture
export const prompt = scenario.prompt
export const maxTurnSeconds = scenario.maxTurnSeconds
export const answer = 'deny'
export const preAnswerState = scenario.preAnswerState
export const check = scenario.check
export const tamper = scenario.tamper
export const solve = scenario.solve
