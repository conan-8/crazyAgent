/**
 * M0 marathon baseline (MARATHON-PLAN.md §5 M0): a 12-station multi-page
 * workflow with a server-side record of every completed step.
 *
 * Each station page shows its dispatch word and seal; a submit is accepted
 * only with that word plus the receipt the previous station revealed after
 * its own accepted submit (station 1 uses a printed start receipt), so the
 * steps are information-dependent. Only an accepted submit POSTs
 * {step, word, receipt} to /marathon/step, so the fixture server's request
 * log is the independent record of completed steps. The checker verifies
 * every step happened exactly once, with the right values, in order, and
 * that the tracked page ends on station 12's completion view. A re-recorded
 * station is a redo (partial here; the M2 continuation scenarios make it a
 * fail). The model's answer and tool results are never consulted.
 *
 * The station table, checker, and form-driving helpers are shared with the
 * M2 carry-over scenarios via _marathon-check.mjs; this module's verdict
 * semantics are the frozen M0 baseline (redo -> partial).
 */
import {
  MARATHON_PROMPT,
  START_RECEIPT,
  TOTAL,
  STATIONS,
  receiptFor,
  checkMarathon,
  driveStation,
  postStepRecord,
} from './_marathon-check.mjs'

export const name = 'marathon-long'
export const fixture = 'marathon-01.html'
export const prompt = MARATHON_PROMPT
export const maxTurnSeconds = 1200

export async function check(ctx) {
  return checkMarathon(ctx, { redo: 'partial' })
}

/**
 * Harness-made correct end state: drive every station's own form with the
 * right word and the receipt actually revealed by the previous station, so
 * both the server-side record and the final completion view are genuine.
 */
export async function solve(ctx) {
  let receipt = START_RECEIPT
  for (let step = 1; step <= TOTAL; step += 1) {
    receipt = await driveStation(ctx, step, receipt)
  }
}

/**
 * Plausible-but-wrong: the completion view is genuine, but the server-side
 * record has station 7's word wrong and station 3 recorded twice (a redo).
 * Steps 1..11 are posted directly; station 12 is driven through its own form
 * so the final page looks exactly like a finished run.
 */
export async function tamper(ctx) {
  for (let step = 1; step <= 11; step += 1) {
    const word = step === 7 ? 'altitude-checks' : STATIONS[step - 1].word
    const receipt = step === 1 ? START_RECEIPT : receiptFor(step - 1)
    await postStepRecord(ctx, step, word, receipt)
  }
  await postStepRecord(ctx, 3, STATIONS[2].word, receiptFor(2))
  await driveStation(ctx, TOTAL, receiptFor(TOTAL - 1))
}
