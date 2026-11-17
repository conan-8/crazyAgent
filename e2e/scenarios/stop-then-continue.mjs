/**
 * M2 carry-over gate (MARATHON-PLAN.md §5 M2, lead suite spec): stop the
 * marathon-long workflow mid-turn right after the fixture server records
 * step 4, verify the carried plan via GET /state, then send a bare
 * "continue" in the SAME chat. The seeded turn must complete the remaining
 * stations WITHOUT re-recording any already-recorded step.
 *
 * PASS = all 12 steps recorded EXACTLY ONCE across both turns (the fixture
 * request log spans both turns; it is only cleared between runs) + the
 * genuine station-12 completion view. Any redo of a recorded step is a FAIL
 * (redo: 'fail') — that is the exact behavior M2 must prevent. Turn-2 seed
 * evidence (carried revision, open items, step count at stop) is recorded as
 * diagnostics by the harness (followUp.betweenState / verification) and the
 * plan telemetry on both turns.
 *
 * Void+retry (harness, up to 3 attempts): turn 1 finishes before the stop
 * lands, or the between-turn /state lacks a stopped turn / enabled marathon /
 * carried plan with open items — the run must actually exercise the seed.
 */
import {
  MARATHON_PROMPT,
  START_RECEIPT,
  TOTAL,
  checkMarathon,
  driveStation,
  postStepRecord,
  receiptFor,
  STATIONS,
  verifyCarriedPlan,
  stopAfterStep4,
} from './_marathon-check.mjs'

export const name = 'stop-then-continue'
export const fixture = 'marathon-01.html'
export const prompt = MARATHON_PROMPT
export const maxTurnSeconds = 1200
export const followUp = { text: 'continue', maxTurnSeconds: 900 }

export const stopWhen = stopAfterStep4
export const verifyBetweenTurns = verifyCarriedPlan

export async function check(ctx) {
  return checkMarathon(ctx, { redo: 'fail' })
}

/** Harness-made correct end state: the full genuine chain, exactly once. */
export async function solve(ctx) {
  let receipt = START_RECEIPT
  for (let step = 1; step <= TOTAL; step += 1) {
    receipt = await driveStation(ctx, step, receipt)
  }
}

/**
 * Plausible-but-wrong continuation: steps 1..4 recorded, then the continued
 * turn RE-RECORDS station 2 (the redo M2 must prevent) before completing
 * 5..12 with a genuine completion view. The surface looks finished; the
 * server-side record proves the redo.
 */
export async function tamper(ctx) {
  let receipt = START_RECEIPT
  for (let step = 1; step <= 4; step += 1) {
    receipt = await driveStation(ctx, step, receipt)
  }
  await postStepRecord(ctx, 2, STATIONS[1].word, receiptFor(1))
  for (let step = 5; step <= TOTAL; step += 1) {
    receipt = await driveStation(ctx, step, receipt)
  }
}
