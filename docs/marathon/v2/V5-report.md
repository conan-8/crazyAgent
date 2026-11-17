# V5 report — judge tuning: one kept change chosen by measurement

**Date:** 2026-11-17 · **Task:** shared task-19 · **Plan:** `MARATHON-V2-PLAN.md` §3.6 + §5 V5 + §6
**Base pin:** V4 merge `4ad1f06` (branch `v2/v5-tuning`). **Kept change: candidate 3 — pinned provider routing + fixed seed** (commit `a2b4433`).
**Status:** COMPLETE — target met on both splits, no fallback needed. Neutral prompt unchanged; at most one judge change kept (decision #6).

## Summary

The v1 judge's verdicts were **non-deterministic at temperature 0**: OpenRouter load-balances each request across ~50 endpoints/quantizations (Wafer mxfp4, Sail Research fp4, Morph fp8, DeepInfra fp8/flex, Particle AI, PrimeIntellect, …), so the same digest yielded different verdicts across repeats. This instability — not reasoning effort — was the dominant blocker for clean stuck detection. **Pinning the provider (`morph/fp8`) + a fixed `seed` + `require_parameters:true` + `allow_fallbacks:false` made verdicts deterministic and lifted gated stuck caught to 1.000 mean on BOTH tune and holdout (k=5), with zero false alerts and stability 1.000.**

| Metric (gated, k=5) | V4 tune | V5 c3 tune | V4 holdout | V5 c3 holdout |
|---|---|---|---|---|
| stuck caught mean | 0.600 | **1.000** | 0.880 | **1.000** |
| stuck caught worst | 0.000 | **1.000** | 0.600 | **1.000** |
| fine false alerts (worst) | 0 | **0** | 0 | **0** |
| stability (all-k-agree) | 0.900 | **1.000** | 0.933 | **1.000** |
| cost / watched hour (calls) | 12.67 | 12.67 | 21.14 | 21.14 |
| cost / watched hour (input tok) | 66167 | 67037 | 136968 | 137297 |
| cost / watched hour (output tok) | 3639 | 3116 | 4104 | 3306 |

Target (≥80% mean caught, tune AND holdout; FA 0 worst; stability ≥V4; cost ≤3×V4): **MET on both splits.** Cost is essentially unchanged (input +1.3% tune / +0.2% holdout; output lower). Judge effort stays **low**, `max_tokens` **400**.

## Candidates tested (each ALONE vs V4, plan order 1→2→3→4)

### Candidate 1 — plan-progress history digest (commit `0edaefd`, NOT kept)
Added `planCompletedSamples` ring (≤40) + `completedTrajectory [{ageSec,completed}]` to the judge digest (pure evidence, no new signal). +7 unit tests; npm 1310.
- Tune k=5 gatedAll: caughtMean **0.667** (V4 0.600), FA 0, stability 0.90, cost ok.
- **Noise-rise (lead ruling):** all 3 stuck windows `stable=false`; the entire +0.067 came from contaminated stall t4 (0.6→0.8); the **clean bounce-form target was UNCHANGED (0.6, noisy)**. A marginal fluctuation, not a reliable rise → does not qualify. Plan-history alone is insufficient; instability is the blocker.

### Candidate 2 — raise judge effort + max_tokens 1200 (commit `170294c`, NOT kept)
`JUDGE_REASONING_EFFORT='medium'` (REQUESTED) + `JUDGE_MAX_TOKENS` 400→1200. The model's `supported_efforts=[max,high,low,none]` has no `medium`, so OpenRouter maps to the nearest supported level. **Effective effort verified empirically:** reasoning_tokens 42225 vs V4-low 26120 (**+62%**), output 51415 vs 33035 (+56%) → effective effort clearly raised (consistent with mapping toward high). Agent acceptance effort stayed medium (plan §6); only the judge effort was a candidate.
- Tune k=5 gatedAll: caughtMean **0.800** incl contaminated, FA 0, stability 0.967, cost ≤3× (output 1.56×).
- **Contaminated-driven / clean regression (lead ruling):** the 2 contaminated stalls went stable 1.0×5 (effort helps obvious stalls), but the **clean bounce-form REGRESSED 0.6→0.4** (still unstable). Sensitivity: incl contaminated 0.800 (≥80% ✓) but **excl contaminated = clean 0.40 (<80% ✗) — the gate FLIPS**. The genuine accuracy goal is clean stuck detection; c2 worsens it → not acceptable as the kept config despite the literal aggregate qualify.

### Candidate 3 — pinned provider routing + fixed seed (commit `a2b4433`, KEPT)
`body.provider={order:['morph'],allow_fallbacks:false,require_parameters:true}` + `seed:42`. `morph/fp8` supports `seed` (verified via `/models/{id}/endpoints`; PrimeIntellect lacks seed and is avoided); `require_parameters:true` guarantees the provider supports seed + reasoning. Effort/max_tokens unchanged from V4 (low/400). Smoke call verified: HTTP 200, `provider:Morph`, valid verdict, reasoning_tokens 76. `JUDGE_REASONING_EFFORT='low'` exposed as a constant; `watcher-eval` metadata now reads the actual judge constants (was hardcoded low/400).
- Tune k=5: gatedAll caughtMean **1.000**, caughtWorst 1.000, FA 0/0, stability **1.000**, falseRecov 0, stale 0. **gatedClean 1.000 / gatedContaminated 1.000** (gate does not flip). Per stuck window: clean bounce-form **1.0 [T×5] stable** (V4 0.6 unstable); contaminated t2/t4 1.0 stable.
- **Reliably meets the keep-rule AND improves the clean window** (bounce-form 0.6→1.0 stable), aggregate ≥80% without regressing the clean target, stability up, cost ≤V4 → KEEP (first reliable qualifier; c1/c2 not kept).

Candidate 4 (hub-mirror screenshot, last resort) was **not needed** — c3 closed the gap.

## Root cause (documented per lead, regardless of kept candidate)

Temperature 0 does not guarantee determinism on OpenRouter: the router picks a provider per request by effective price/throughput/latency, load-balancing across ~50 endpoints with different quantizations (mxfp4/fp4/fp8/unknown). Each provider/quantization gives slightly different logits, so the same digest flips verdicts across repeats. This is why v1's stuck windows were unstable and why effort alone (c2) could not reliably lift the clean varied-activity window. **Pinning one seed-supporting provider + a fixed seed removes the routing variance** → deterministic verdicts (stability 1.000 across k=5) and reliable clean detection. Sources: OpenRouter provider-routing docs (`provider.order/allow_fallbacks/require_parameters`), `/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints`, `/api/v1/providers`.

## Holdout (scored ONCE on the kept config, k=5; no code change after)

`v5-c3-holdout-k5.json`: gatePass TRUE. gatedAll caughtMean **1.000**, caughtWorst 1.000, FA 0/0, stability **1.000**, stale 0, endedIncompleteCorrect 21/30. **All 5 holdout stuck windows are clean** (gatedContaminated n=0); each c3 mean 1.0 stable [T×5] (V4: 0.8/1.0/0.6/1.0/1.0 → the 0.8 and 0.6 lifted to 1.0 stable). No fine false alerts. Cost/hr 21.14 calls / 137297 in / 3306 out (V4 21.14/136968/4104). **falseRecovery = 1** (a recovered notice while the label rule still says stuck) — unchanged from V4 holdout (1); informational, not a keep-rule gate metric, noted for follow-up.

## Keep-rule evaluation (kept c3)

| Condition | Result |
|---|---|
| worst-case false alerts across k stay 0 on fine | ✓ 0 (tune + holdout) |
| mean caught rises **reliably** beyond noise | ✓ 0.600→1.000 tune, 0.880→1.000 holdout; all stuck windows stable |
| improves CLEAN-window caught (not contaminated-driven) | ✓ clean bounce-form 0.6→1.0 stable; gatedClean 1.000 both splits |
| stability doesn't fall | ✓ 0.90→1.000 tune, 0.933→1.000 holdout |
| cost / watched hour ≤3× V4 | ✓ ~1.0× (input +1.3%/+0.2%, output lower) |
| ≥80% mean caught, tune AND holdout | ✓ 1.000 / 1.000 |

No fallback required. Neutral prompt unchanged (M4 lesson: cautious wording suppressed desired alerts).

## Changes / invariant

- `companion/watch-judge.mjs`: `JUDGE_PROVIDER_ORDER=['morph']`, `JUDGE_PROVIDER_ALLOW_FALLBACKS=false`, `JUDGE_PROVIDER_REQUIRE_PARAMETERS=true`, `JUDGE_SEED=42`, `JUDGE_REASONING_EFFORT='low'` (constant); request body adds `provider` + `seed`. Read-only invariant intact (still one tool-less HTTP call; key only in Authorization header, never logged; watcher never captures/steers/stops).
- `scripts/watcher-eval.mjs`: metadata `effort`/`maxTokensPerCall` read the actual judge constants.
- `AGENTS.md`: watcher invariant updated (V5 routing/seed mechanism + V5 closed the instability gap; c1/c2 not kept).
- Tests: `watch-judge.test.mjs` asserts provider routing + seed + effort constant. npm test **1303/1303**.

## Commits / evidence

- `0edaefd` — candidate 1 (tested, not kept).
- `170294c` — candidate 2 (tested, not kept).
- `a2b4433` — candidate 3 (KEPT) + watcher-eval metadata fix.
- (this commit) — AGENTS.md invariant + V5-report + evidence JSONs.
- Evidence: `docs/marathon/v2/v5-c1-tune-k5.json`, `v5-c2-tune-k5.json`, `v5-c3-tune-k5.json`, `v5-c3-holdout-k5.json` (+ per-repeat `.rN.json`); V4 baselines `v4-tune-k5.json`, `v4-holdout-k5.json`.

## Next

- **eval live** with the kept config (c3): stall-loop, captcha-wall, bounce-form, marathon-epic ×5 each (lead sends pin). Judge model/effort unchanged (low/400); routing/seed is the kept change.
- Follow-up (not gated): the 1 holdout false-recovery (recovered notice while still stuck) — V2 recovery evidence rule already tightened; monitor live.

## Notes for V10 STATUS consolidation (core owns authoritative STATUS.md)

Per lead doc-ownership ruling, V5 does NOT edit `docs/STATUS.md` (core's V10 draft on `v2/v10-release` consolidates it). The following V5 notes are recorded here for core to fold into the authoritative V10 STATUS.md:

- **Known limitations — watcher entry, V5 resolution:** V5 RESOLVED the M4 caught gap + temp-0 non-determinism (kept change c3). The instability was OpenRouter load-balancing across ~50 endpoints/quantizations, NOT effort — pinning provider routing (`order:['morph'],allow_fallbacks:false,require_parameters:true`) + fixed `seed:42` (effort still low, `max_tokens` 400) made verdicts deterministic (stability 1.000 across k=5) and lifted gated stuck caught to **1.000 mean on BOTH tune and holdout** (clean bounce-form 0.6→1.0 stable), FA 0 worst, cost ~1× V4 — the ≥80% target is met, no fallback. The M4 "6/9 (67%) FALLBACK A" deviation and the "3/53 ≈ 0.057 false-alert partly-luck" caveat are superseded by V5 (FA 0 worst across k=5 on both splits; live track A 15/15 FA 0). Candidate 1 (plan-history) noise-rise and candidate 2 (effort raise) contaminated-driven/clean-regression were tested and NOT kept (decision #6 at-most-one judge change).
- **Known limitations — NEW bounded risk (V5.1):** on LONG live turns with large digests (~20–24k chars), low-effort reasoning can consume the full `max_tokens=400` → empty content → defensive `unknown` (fr:LENGTH; live epic r3 6/11 calls). Unknowns never alert and hard stalls (SILENT_STALL/TOOL_HANG/EXECUTOR_DOWN) still alert unconditionally, but a genuinely-stuck large-digest varied-activity wander could evade JUDGE corroboration via length-cutoff unknowns. Schema-deviation unknowns (epic r3 1/11) are correct defensive behavior; monitor rate.
- **Follow-up candidates — V5.1 (task-25, owner judge, post-release):** raise judge `max_tokens` 400→1200 ONLY, keeping low effort + c3 routing/seed. Isolates the token-budget fix from c2's EFFORT raise (medium→high mapping) that regressed the clean bounce-form window. Gate: alone vs V5 corpus k=5 tune+holdout (FA0 worst, caught ≥V5, no clean regression, stability ≥V5, cost ≤3×) + live epic large-digest turns (fr:LENGTH unknowns eliminated, FA-worst healthy 0). NOT bundled into v2.5.0.
- **Follow-up candidates — continuation-plan-snapshot gap RESOLVED by V4:** the "TOP v2" provider-emits-no-plan-activity-for-M2-seed gap is fixed by V4 (seed-visible plan activity + internal carry chain + judge `carriedFrom`, `docs/marathon/v2/V4-report.md`); mark that entry resolved.

## Live confirmation (eval, pin `a2b4433` = c3; real-model acceptance)

Replay is the offline gate; this is the real-model acceptance with independent server-side checkers. **V5 live COMPLETE — DONE-WHEN met:** caught **4/4** live stuck/loop windows (100% ≥80%), **FA 0 worst on healthy runs**, falseRec 0, stability ≥V4 (replay 1.000 + live routing consistency). Grand total **20 runs: 18/20 PASS, 4 alerts ALL server-verified true positives (FA 0), judge 44 calls / 314,649 in / 11,408 out (Morph), 12 unknown** (all the long-turn length-cutoff class below).

### Track A — 15/15 PASS, FA 0, unknown 0
- **stall-loop ×5:** 5/5 honest BLOCKED; past-patience caught **1/1** (r4 192.6s → single decisive `stuck@0.9` call, `PLAN_STALLED` trigger ~155s, source `both`, no recovery, closed at end + ended-incomplete). Quick ends r1/r2/r3/r5: 0 judge calls / 0 alerts (correct-no-alert). Judge 1 call / 5,650 in / 197 out.
- **captcha-wall ×5:** 5/5 help-category captcha; judge 0, alerts 0, ended-incomplete absent ✓ (help ends exempt).
- **bounce-form ×5:** 5/5 honest BLOCKED, all <120s patience → judge 0 calls / 0 alerts / **0 unknown**. The V0 bounce-r1 timeout-wander class did not recur in the live sample (model ended honestly quick every time); replay's caught-1.0-stable carries that window, recorded honestly. The unknown class manifests on LONG turns, not bounce.

### Track B — marathon-epic ×5 (3/5 full + 2 true-positive wander catches)
Batch `2026-11-17T16-24-00-757Z-v5-live-marathon-epic.json` (eval commit `86fa65b`); archive `m0-archive/run-2026-11-17T16-24-00-891Z-6c3fd6/` (31.7 MiB, full traces incl. `watch.judge` events with finishReason); eval report `docs/marathon/v2/V5-live.md` (`a60e034`).

| run | turnId | result | steps | duration | judge calls | in / out / reasoning tok | alerts | unknowns |
|---|---|---|---|---|---|---|---|---|
| r1 | turn-mwkwjum0-e53b | PASS | 120/120 | 733.9s | 6 | 48,093 / 837 / 262 | 0 | 0 |
| r2 | turn-mwkwzl67-3fc0 | PASS | 120/120 | 846.5s | 8 | 62,826 / 1,360 / 696 | 0 | 0 |
| r3 | turn-mwkxhqu2-5feb | PARTIAL | 45/120 | 1500s cap | 15 | 99,702 / 4,733 / 3,948 | 1 (TP) | 7 (6 length + 1 schema) |
| r4 | turn-mwkydx67-25f4 | PASS | 120/120 | 419.7s | 3 | 23,533 / 526 / 195 | 0 | 0 |
| r5 | turn-mwkymxhn-655d | PARTIAL | 19/120 | 1187.6s | 11 | 74,845 / 3,755 / 3,228 | 2 (TP) | 5 |

- **Healthy r1/r2/r4: FA-worst 0** — 17 judge calls ALL `progressing` fr:stop, zero alerts. Cadence behaves as designed (first 4 min, then 6 min ±15%, 10 min after 2×progressing): healthy long marathons need only 3–8 calls.
- **r3 alert (TRUE POSITIVE, server-verified):** `stuck@17:12:00` source `both` blocker `loop` — re-submitting station 25 with guessed dispatch words (glacier-route/camp-three/high-camp), bouncing 24/25, no advance; zero accepted POSTs 17:09–17:13, 8 duplicate steps. c3 corroborates deterministically (pre-V5 temp-0 would flip-flop).
- **r5 alerts (TRUE POSITIVES, server-verified):** `stuck@17:25:41` + re-alert `@17:40:21` source `both` blocker `loop` — station-3 ×3 resubmission violating no-resubmit + stations 15–18 loop; recovery `@17:34:18` evidence-valid (falseRec 0); ended-incomplete fired (MALFORMED_RESPONSE error end after 142 actions).
- **Epic totals:** judge **43 calls / 308,999 in / 11,211 out / 8,329 reasoning** (Morph); verdicts 22 progressing + 1 slow + 2 stuck + 12 unknown.
- **Judge cost at length:** healthy runs are cheap (3–8 calls, ~24–63k input); the partial wander runs cost more (11–15 calls, ~75–100k input) but stay well under the 40-call / 150k-input per-turn budget (budgetExhausted false on all). Cost is reported separately from agent usage.

### Length-cutoff mechanism + bounded risk (V5.1 follow-up)
The 12 unknowns are ALL the long-turn length-cutoff class: on large digests (~20–24k chars) low-effort reasoning consumes the full `max_tokens=400` → `reasoning_tokens=400`, empty content → defensive `unknown` (fr:LENGTH; r3 6, r5 5), plus 1 schema-deviation unknown (r3, fr:STOP, content failed `validateVerdict` → defensive unknown, correct). httpStatus 200 throughout, 2–4s durations — **Morph routing healthy, NOT 429/timeout**; c3 seed stabilizes routing but cannot prevent token-budget cutoffs (digest-content-dependent), which are outside c3's scope. **Watcher behavior correct:** unknowns never alert; r3/r5 were server-progressing-then-looping and the deterministic signals + judge `stuck` verdicts (source `both`) fired the true-positive alerts. **Bounded risk:** a genuinely-stuck large-digest varied-activity wander could length-cutoff into unknowns and evade JUDGE corroboration; hard stalls (SILENT_STALL/TOOL_HANG/EXECUTOR_DOWN) still alert unconditionally. **Fix = V5.1 (task-25):** raise `max_tokens` 400→1200 keeping low effort + c3 routing/seed (isolates the token fix from c2's effort raise that regressed the clean window). Schema-deviation rate (1/43 epic calls) is correct defensive behavior; monitor.

### Live vs replay
No divergence on the gate metrics: replay caught 1.000 / FA 0 / stability 1.000 (both splits) ↔ live caught 4/4 stuck windows / FA 0 worst healthy / routing-consistent verdicts. The only live-only phenomenon is the large-digest length-cutoff unknown class (replay corpus digests are smaller), recorded honestly as the V5.1 follow-up — not a c3 regression and not a gate failure. Extraction note (eval): `chat.stopped`/`chat.error` end-frame pairing corrected r3/r5 watch summaries (checks 75/59, alerts 1/2, usage 104,435/78,600).