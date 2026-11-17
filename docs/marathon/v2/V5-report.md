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