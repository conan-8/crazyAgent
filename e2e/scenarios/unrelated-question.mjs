/**
 * M2 seeded-untouched gate (MARATHON-PLAN.md §5 M2 / §3.2, lead suite spec):
 * the same stop-after-step-4 setup as stop-then-continue (carried plan with
 * open items, verified via GET /state), but turn 2 is an UNRELATED one-line
 * question: "What is 17 * 3? Reply with just the number."
 *
 * PASS = the answer is 51, turn 2 made ZERO browser_plan calls and ZERO tool
 * calls (hence zero tool results), no completion nudges or stale reminders
 * fired (planOutcome not-assessed via the seeded-untouched rule), and the
 * carried plan is STILL present in GET /state afterwards. If the model
 * instead resumes the old plan (any tool activity or new step records), that
 * is a FAIL of the seeded-untouched rule — recorded and reported; the planned
 * fallback belongs to core, not to this checker.
 *
 * Ground truth: turn-2 telemetry from the companion run log (answer text,
 * tool counts, plan events), the fixture server's step record (no new work
 * after the stop), and the after-turn /state projection. The page itself is
 * not touched by a correct turn 2.
 *
 * Like stall-loop/sign-in-wall, no solve(): the correct end is a behavior
 * (a telemetry state), which --self-test cannot synthesize.
 */
import {
  MARATHON_PROMPT,
  stepRecords,
  verifyCarriedPlan,
  stopAfterStep4,
  postStepRecord,
  receiptFor,
  STATIONS,
  driveStation,
  START_RECEIPT,
} from './_marathon-check.mjs'

export const name = 'unrelated-question'
export const fixture = 'marathon-01.html'
export const prompt = MARATHON_PROMPT
export const maxTurnSeconds = 1200
export const followUp = { text: 'What is 17 * 3? Reply with just the number.', maxTurnSeconds: 120 }

export const stopWhen = stopAfterStep4
export const verifyBetweenTurns = verifyCarriedPlan

export async function check(ctx) {
  const fu = ctx.followUp ?? null
  const t2 = fu?.turn ?? null
  const { requests, stepPosts } = await stepRecords(ctx)
  const atStop = fu?.verification?.evidence?.stepRecordsAtStop ?? null
  const noNewWork = atStop === null ? null : stepPosts.length === atStop
  const answerText = typeof t2?.finalText === 'string' ? t2.finalText : null
  const answerOk = answerText !== null && /^\s*51\s*$/.test(answerText)
  const zeroPlanCalls = t2 !== null && (t2.toolCounts?.browser_plan ?? 0) === 0
  const zeroToolCalls = t2 !== null && t2.toolCalls === 0
  const notAssessed = t2?.planOutcome === 'not-assessed'
  const zeroNudges = t2 !== null && (t2.planNudges ?? 0) === 0 && (t2.planStaleReminders ?? 0) === 0
  const afterMarathon = fu?.afterState?.marathon ?? null
  const planCarried = afterMarathon?.plan != null
  const switchStillOn = afterMarathon?.enabled === true

  const evidence = {
    followUpText: fu?.text ?? null,
    turn2Status: t2?.status ?? null,
    answerText: answerText === null ? null : answerText.slice(0, 200),
    answerOk,
    turn2ToolCalls: t2?.toolCalls ?? null,
    turn2ToolCounts: t2?.toolCounts ?? null,
    zeroPlanCalls,
    zeroToolCalls,
    turn2PlanOutcome: t2?.planOutcome ?? null,
    turn2PlanFinalReason: t2?.planFinalReason ?? null,
    turn2PlanSeeded: t2?.planSeeded ?? null,
    turn2PlanNudges: t2?.planNudges ?? null,
    turn2PlanStaleReminders: t2?.planStaleReminders ?? null,
    notAssessed,
    zeroNudges,
    stepRecordsAtStop: atStop,
    stepRecordsNow: stepPosts.length,
    noNewWork,
    planCarriedAfter: planCarried,
    carriedPlanRevision: afterMarathon?.plan?.revision ?? null,
    switchStillOn,
    turn1WallMs: ctx.turn?.wallMs ?? null,
    turn2WallMs: t2?.wallMs ?? null,
  }

  if (requests === null) return { status: 'fail', reasons: ['the fixture request log is unavailable'], evidence }
  if (t2 === null) return { status: 'fail', reasons: ['no follow-up turn was recorded, so the unrelated question was never answered'], evidence }
  // The seeded-untouched rule: any tool activity or resumed workflow work in
  // turn 2 is the failure mode M2 must prevent — a fail, not a partial.
  if (!zeroToolCalls || !zeroPlanCalls || noNewWork === false) {
    return { status: 'fail', reasons: ['seeded-untouched rule violated: turn 2 resumed the carried plan (tool calls, browser_plan, or new step records)'], evidence }
  }
  if (!answerOk) return { status: 'fail', reasons: [`turn 2 did not answer 51 (got ${JSON.stringify(answerText === null ? null : answerText.slice(0, 80))})`], evidence }
  if (!notAssessed || !zeroNudges) {
    return { status: 'partial', reasons: [`answered 51 without tools, but the turn was not seeded-untouched (planOutcome=${JSON.stringify(t2.planOutcome)}, nudges=${t2.planNudges}, stale=${t2.planStaleReminders})`], evidence }
  }
  if (!planCarried || !switchStillOn) {
    return { status: 'partial', reasons: ['answered 51 untouched, but the carried plan or the marathon switch was lost after turn 2'], evidence }
  }
  return { status: 'pass', reasons: ['answered 51 with zero plan calls, zero tool results, no nudges (not-assessed), and the carried plan still present'], evidence }
}

/**
 * Plausible-but-wrong: the stopped state is genuine (steps 1..4 driven
 * through the real forms), but the follow-up turn resumed the workflow and
 * recorded station 5 — the seeded-untouched violation. With no follow-up
 * telemetry in --self-test the checker still fails (no answer recorded).
 */
export async function tamper(ctx) {
  let receipt = START_RECEIPT
  for (let step = 1; step <= 4; step += 1) {
    receipt = await driveStation(ctx, step, receipt)
  }
  await postStepRecord(ctx, 5, STATIONS[4].word, receiptFor(4))
}
