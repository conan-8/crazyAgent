/**
 * V0-a long-healthy scenario (MARATHON-V2-PLAN.md §3.1/§5 V0, gap G8): the
 * marathon-long contract at 72 stations, so efficient healthy turns reliably
 * run ~4–8 minutes and actually reach the judge's 4-minute first-call
 * threshold (lead ruling 2026-11-17: 36 stations gave 136s — too short).
 * Honest by construction — every station is completable; nothing is built to
 * force a stall (§8). Progress events are the server-accepted station POSTs
 * (/marathon/step), recorded with server timestamps in the batch JSON for
 * the corpus labeler.
 *
 * Checker semantics mirror the frozen M0 marathon-long checker (redo ->
 * partial); the corpus scores redo windows separately from server records.
 */
import {
  EPIC_PROMPT,
  START_RECEIPT,
  TOTAL,
  STATIONS,
  receiptFor,
  checkEpic,
  driveStation,
  postStepRecord,
} from './_epic-check.mjs'

export const name = 'marathon-epic'
export const fixture = 'epic-01.html'
export const prompt = EPIC_PROMPT
export const maxTurnSeconds = 1500

export async function check(ctx) {
  return checkEpic(ctx, { redo: 'partial' })
}

/** Harness-made correct end state: drive all 72 real forms with the receipt chain. */
export async function solve(ctx) {
  let receipt = START_RECEIPT
  for (let step = 1; step <= TOTAL; step += 1) {
    receipt = await driveStation(ctx, step, receipt)
  }
}

/**
 * Plausible-but-wrong: the completion view is genuine, but the server record
 * has station 30's word wrong and station 20 recorded twice (a redo).
 */
export async function tamper(ctx) {
  for (let step = 1; step <= TOTAL - 1; step += 1) {
    const word = step === 30 ? 'permit-stamps' : STATIONS[step - 1].word
    const receipt = step === 1 ? START_RECEIPT : receiptFor(step - 1)
    await postStepRecord(ctx, step, word, receipt)
  }
  await postStepRecord(ctx, 20, STATIONS[19].word, receiptFor(19))
  await driveStation(ctx, TOTAL, receiptFor(TOTAL - 1))
}
