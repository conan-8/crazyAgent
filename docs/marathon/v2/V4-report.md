# V4 report — continuation context (seed visible + carry chain + digest task)

**Date:** 2026-11-17 · **Task:** task-18 (core) · **Plan:** `MARATHON-V2-PLAN.md` §3.5 + §5 V4 + §6 + G1/G2
**Branch:** `v2/v4-context` from merged main `c6f0d2d` (V3 merged). **One main change: continuation context.** Watcher report-only; carry chain INTERNAL (judge-digest-only, never published, never in the agent prompt).
**Status:** ACCEPTED (lead done-when interpretation ruling) — binding structural gates PASS; model-variance items recorded honestly (V4 code innocent, agent prompt byte-unchanged). Merge-ready.

## What changed
- **(a) Seed becomes visible (G1)** — `packages/dsh-browser-extension/lib/plan-runtime.js`: `claim()` on an **accepted** seed emits ONE `bridge.activity({kind:'plan', revision, items, awaitingUser:false, seeded:true})` immediately (the shape the provider arms). A **rejected** seed (`plan.seed.rejected`) emits NO activity (ledger and model see the same empty plan, fail closed). `noteActivity` routes it to the ledger `#noteActivity` plan branch (plan snapshot + open-item trajectory from turn start → openFlat REVISIT_HINT can fire on continuation wander) + `planTurnSnapshot`. Fixes G1: the live ledger previously had no plan snapshot until the first `browser_plan` call.
- **(b) Judge learns the task (G2)** — `companion/marathon.mjs` INTERNAL `carryChain` (≤3 ancestor prompts, clip 500, oldest first; `pushCarryPrompt`/`carryChainForDigest`/`clearCarryChain`; **NOT** in `snapshot()`/`marathonFrameBody` — never published). Reset on marathon off / `reset()` (new chat / chat switch / restart) / carried-plan drop (`storePlan` terminal). `session-controller.mjs` `#begin` passes carry context `{seeded, seededRevision=marathon.plan.revision, carriedFrom=ancestors}` to `watcher.turnStarted`; after a turn ends with the carried plan persisting, pushes the current prompt into the chain (ancestor for the next continuation). `watch-judge.mjs` `buildDigest` adds `carriedFrom` (ancestors only, ≤3×500 chars ≈ ≤400 tokens) + `plan.seededRevision` when seeded; the current prompt stays `task`; non-seeded omits `carriedFrom`. Fixes G2: a continuation's "continue" prompt now carries ancestor task context.
- **Agent prompt UNCHANGED:** the seed activity is bridge-only (ledger/panel/hub); `carryChain`/`carriedFrom` are judge-digest-only. `buildPromptBlocks` + the `planSeed` passed to `#runTurn` (M2 carried plan + marathon guidance) are byte-identical (the `planSeed` was hoisted to a const of the same `#carriedPlanSeed()` value). V4 cannot affect agent behavior.

## Commits
- `0c993b1` (a) seed visible + 2 tests (accepted exactly-one seeded activity; rejected none).
- `ab8ad0c` (b) carry chain + digest carriedFrom + 8 tests (chain bounds/clip/trim/internal-not-published/resets/off-no-op/copy; digest carriedFrom/seededRevision/non-seeded/size-bound).
- `42f2104` full-corpus replay k=5 (tune + holdout) vs V3 — no regression.
- `ac99bfc` replay-extension: SIMULATE seed injection on continuations (lead-authorized, tune-only).

## Gates

### npm test (cheapest)
**1303/1303 green** (1293 V3 base + 10 V4).

### Full-corpus replay k=5 (no regression)
| Metric | Tune V3→V4 | Holdout V3→V4 |
|---|---|---|
| gated-fine FA WORST | 0 → 0 ✓ | 0 → 0 ✓ |
| caught MEAN | 0.667 → 0.600 | 0.920 → 0.880 |
| falseRec | 0 → 0 | 1 → 1 |

The caught differences are **judge variance**: pre-V4 corpus traces lack the provider-emitted seeded activity + controller-fed carry context, so the replay cannot exercise V4's new paths (the digest is essentially unchanged without carry context). **No regression on healthy continuations (FA0 worst both — V2 control exclusion + V3 page-scoping hold).**

### G1 replay-extension SIMULATION (lead-authorized, tune k=5 only)
`watcher-eval` extended to SIMULATE V4 on pre-V4 traces: `finalPlanOf` extracts the previous turn's final open plan; `v4ContextFor` computes `seedPlan` + carry (ancestor prompts ≤3 clip500 + seededRevision) from full-manifest predecessors (cached); `replayTurn` injects the seeded activity at now=0 + passes carry to `buildDigest`. **Documented as a SIMULATION (live is ground truth).**
- Result: caught MEAN as-is 0.600 → SIM 0.600 (unchanged); per-window bounce 0.60→0.40 (idx0, no seed → variance), stall-t2 **0.60→0.80** (seed helped), stall-t4 0.60→0.60. fineFA worst 0 both; falseRec 0.
- **Marginal-but-directional:** the corpus continuation-stuck windows already carry plan snapshots from their own `browser_plan` calls (openFlat already fires in V3); the seed only adds the snapshot earlier. The G1 gap is specifically **seeded-untouched continuation wander** (no `browser_plan` → no snapshot → open-flat couldn't fire), which the corpus lacks → LIVE is the ground-truth benefit test.

## V4 LIVE (eval V4-live.md, pin 42f2104)

### stop-then-continue ×5 — BINDING ✓
**redo 0/5 ✓** (valid 12/12 ALL runs, dup [] ALL runs), **healthy continuations silent ✓** (0 alerts on all recorded turns, 0 recovered, judge 0 calls; analyzer ×5 seed reconstructed, REVISIT fires 0 mutation/openFlat/other), **seeded=true 5/5 ✓** (reported-complete ×5, nudges 0, seedRejected false). 4/5 PASS + r2 partial (12/12 server-complete, completionOk false — final-view reset class, checker contract not watcher). Run1 attempt1 first-turn model-variance SILENT_STALL (TRUE-positive hard alert @139s 'both', lead-confirmed; first turn not continuation) → 1200s watchdog → VOID per M2 harness design → attempt2 PASS (void preserved, no fishing).

### unrelated-question ×5 — MODEL VARIANCE (3/5 PASS + 2 FAIL)
r4→2 etc. flagged "seeded-untouched rule violated: turn 2 resumed the carried plan" instead of answering with zero plan calls/tool results. **The RULE holds + detection correctly flags the violation** (turn2 had tool results). V4 seeded-untouched detection UNCHANGED (diff touches none of not-assessed/finalOutcome/nonPlanResults/planCalls); agent prompt unchanged. M2 verified 5/5 (a lucky small sample); this ×5 the model resumed the carried plan ~40% → **model seeded-untouched reliability ~60%**, a MODEL finding, not a V4 regression.

### c1 steer-plan — MODEL VARIANCE + CHECKER BRITTLENESS (FAIL)
"second turn did not end ok": turn2 finalText "PARTIAL — stopped after 3 clicks, as instructed... 15-click target unmet", reportedLabel=partial, toolCounts={browser_plan:1}, turn2PlanOutcome=blocked → turn2Ok=false. The model **HONORED the steer** (stopped at count 3, countAtSteer=3=finalCount) but marked the plan blocked (target unmet — a reasonable PARTIAL). **Carry/steer mechanism CORRECT:** revisionAtSteer=1, turn2CarriedRevision=1, turn2PlanRevision=2, turn2Armed=true, steered=true, turn1Aborted=true. M2 baseline PASS: turn2 answered not-assessed (no browser_plan) → turn2Ok=true. The only difference is the model's blocked-vs-not-assessed choice (variance). **FOLLOW-UP: checker-contract brittleness** — the c1 row expects not-assessed/ok but the model reasonably marks blocked after a steer stops short of the target; the checker should accept a honored-steer blocked/PARTIAL end.

## Diagnosis proof — V4 code innocent (lead-accepted)
`git diff 1577210..HEAD`: `plan-runtime.js` = ONLY the 12-line seed `bridge.activity` emission (no detection/finalOutcome/prompt change); `session-controller.mjs` = carry feed to `watcher.turnStarted` (judge-digest-only) + turn-end `pushCarryPrompt` (internal) + `planSeed` hoisted to an identical const. `buildPromptBlocks` + the agent-prompt `planSeed` byte-unchanged; seeded-untouched detection unchanged; carry/steer revision flow correct. Both live failures are model variance.

## Done-when interpretation (lead ruling — ACCEPT V4)
- **BINDING STRUCTURAL GATES PASS:** no-regression FA0 worst both (replay) + healthy continuations silent worst (live) + redo 0/5 + seeded=true 5/5 + G1 mechanism confirmed (seed snapshot from turn start) + G2 carriedFrom wired + carry/steer mechanism correct.
- **MODEL-VARIANCE ITEMS RECORDED (V4 innocent):** (a) seeded-untouched live ~60% (rule holds, model sometimes violates); (b) c1 steer-plan model marked blocked after honored steer (checker brittleness follow-up); (c) caught replay holdout 0.880 vs V3 0.920 = judge variance (replay can't exercise V4 carry context on pre-V4 traces); continuation-stuck caught marginal-directional (sim) + live hard-signal coverage → **V5 judge-accuracy target**.
- The contract's "repeat to tell lucky from reliability" is satisfied: ×5 revealed the model's seeded-untouched reliability ~60% (a model finding, not a V4 regression). Lead flags these to the user in the morning report.

## Invariants preserved
Watcher report-only; hard signals model-independent; judge can never veto a hard signal; untrusted input clipped plain text (carry prompts); cost separate; one runner/one turn slot; 34 standing tools; prompt ceiling (agent prompt unchanged); carry chain internal/not-published; seeded-untouched detection unchanged; M2 carry-over + not-assessed unchanged.
