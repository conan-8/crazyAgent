# V2 report — what counts as progress (tool classes, NO_EFFECT, evidence-based recovery)

**Date:** 2026-11-17 · **Task:** task-16 (core) · **Plan:** `MARATHON-V2-PLAN.md` §3.3 + §5 V2 + §6 + G3
**Branch:** `v2/v2-progress` from merged main `f08b57c` (V1 merged). **One main change: progress accounting.** Watcher stays **report-only**; hard signals model-independent; no product change to the judge model/cadence.
**Status:** implementation complete + lead-accepted; provisional tune replay PASS on the real gates; **FINAL gate on the FULL corpus pending eval's collection ingestion** (epic-120 ×5 + impossible stalls).

## What changed

### Three ledger tool classes (`companion/watch-ledger.mjs`) — replaces the single read-only list
- `toolClass(name)` → **observe** (today's `READ_ONLY_TOOLS`), **control** (`browser_plan`, `agent_request_help`, `agent_request_confirmation`), **act** (everything else).
- Control results are excluded from the event window (so `FAIL_STREAK`/`SAME_ERROR`/`REPEAT_LOOP`/`OBSERVE_ONLY` skip them), the mutation counters (only an ok **act** is a mutation), `nonPlanResultsSinceRevision`, and `fingerprintStats`. A `PLAN_*` error is **plan friction** (V8), not a stuck browser. Control still updates `lastToolResultAt`/`inFlight`/connectivity streak; plan calls still feed the plan snapshot via `chat.activity`. `events` gain a `toolClass` field (`readOnly` kept for compat).

### Shared no-effect predicate (agree by construction)
- `noProgressResultText(text)` = `/NO VISIBLE CHANGE/iu` exported from `packages/dsh-browser-extension/lib/repeat-guards.js`, **re-exported from `lib/index.js`**; the provider's `toolResultNoProgress` refactored to call it; the ledger **imports the same function**. An ok act result matching the marker is **no-effect** (a failed act is a failure, not no-effect; observe/control never).
- New ledger counters: `okEffectfulActCount` (ok act, not no-effect, not control) and `planCompletedCount` (rises only on completion — a revision alone or marking blocked never raises it).

### `NO_EFFECT` soft signal
- ≥4 of the last 8 **act** results no-effect → `suspect`. Like every soft signal it **never alerts alone**; it brings the judge call forward (suspect level → trigger) and counts as deterministic corroboration under two-strike (`assessment.signals.length > 0` → `source:'both'`) — all via the existing watcher mechanisms, no new alert path.

### Evidence-based recovery (`companion/watcher.mjs`)
- The open alert clears only when **≥2 effectful act results** arrived since the alert (ok, not no-effect, not control) **AND** the alert's own signals have been **absent for 2 consecutive ticks**; **OR** the plan's **completed count rose** since the alert. A plan revision alone no longer counts; marking items blocked never counts.
- `openAlert` records `effectfulActCountAtAlert`/`completedCountAtAlert`/`signalKinds`/`absentTicks` at alert time; `tick()` tracks consecutive absence of the alert's signal kinds; `#recoverySince` derives `effectfulActs`/`completedUp`/`signalsAbsentTicks`; `decideWatch` rule replaced (`recoveryEffectfulActs:2`, `recoveryAbsentTicks:2`). The judge path uses the same recovery.

## Commits
- `91c4621` inc1 tool classes + control exclusion (+7 tests).
- `f334775` inc2+3 shared predicate + NO_EFFECT + effectful/completed counters (+6 tests).
- `2507075` inc4 evidence-based recovery (tests updated +2).
- `996f0e1` inc5 AGENTS.md/STATUS.md invariants (§3.3/§4: a plan update is not progress; control tools are not page actions).
- `9fa92f1` provisional tune k=3 replay evidence.
- `5f05bf1` gate verdict uses mean caught per §5 V5 (worst-case caught/stability diagnostics).

## Gates

### npm test (cheapest)
**1272/1272 green** (1257 merged base + 15 V2). Tool classes, shared predicate, NO_EFFECT edges (threshold/window/dilution/observe-control exclusion), recovery edges (no-effect acts don't recover; completed item does; revision/blocked don't), control exclusion from FAIL_STREAK/SAME_ERROR/OBSERVE_ONLY. Watcher report-only preserved.

### Provisional tune replay k=3 (OLD corpus, 2 easy gated stalls — diagnostics, NOT the final gate)
Real gates (lead ruling §5 V5): **PASS**.
| Metric | V0 tune | V2 tune |
|---|---|---|
| Gated fine false alerts (worst-case) | 0 | **0** ✓ |
| Gated stuck caught MEAN | 100% | **100%** (≥V0) ✓ |
| Gated false-recovery windows | 2 | **0** ✓ (V2 goal achieved) |
| Stale-alert windows | 0 | **0** ✓ |
| Stability (diagnostic) | 0.9 | 0.9 |
| Gated stuck caught worst-case (diagnostic) | 50% | 50% |

The two V0 gated stall-loop false recoveries (`00-43-57-262Z-2ab066-t2/-t4`) are eliminated: their "recovery" was satisfied by ok results that V2 now requires to be effectful + signals-absent.

## Documented deviations (lead ruling 2026-11-17 — NOT hidden; flagged to user)

### D1 — NO_EFFECT raises suspect ticks on healthy runs (by design)
Replay all-fine suspect-tick share **0.388 → 0.525**; gated-fine **0 → 0.125**. NO_EFFECT fires on healthy windows with ≥4/8 no-effect acts (e.g. clicking already-set fields, reading), bringing the judge forward. This is **intentional** to catch G3 dead-button loops. Per lead ruling the `suspect ticks ≤V0` done-when is evaluated on the **FULL corpus** and **re-evaluated cumulatively after V4** (V3 page-scoping removes REPEAT_LOOP false suspects on multi-page work; V4 continuation context removes PLAN_STALLED false suspects on continuations). If still >V0 after V4, a recorded gap requiring mitigation before release. **Binding hard gates unaffected** (gated-fine FA worst 0; suspect ticks never alert alone).

### D2 — legacy fine `02-38-11-221Z-458428-t3`: LABEL DISAGREEMENT that VALIDATES NO_EFFECT (non-gated)
Real-judge investigation: NO_EFFECT was the **sole deterministic corroborator** (`source:'both'`, signals=[NO_EFFECT]) of a judge `stuck` verdict (confidence 0.82/0.90/0.95 @100/200/300s). The judge reason is **substantively correct**: "Task already complete (permit EXP-917Q verified, all 12 stations accepted), but the agent fires repeated blind `click_at` calls at arbitrary coordinates (640,540→640,618), most returning NO VISIBLE CHANGE with no page progress." This is genuine **post-completion wander** — exactly the G3 pattern NO_EFFECT targets. The legacy hand-label marks it `fine` by **end-outcome** (turn ended done); under the **v2 server-record rule** (progressable t0 = 240s since the last accepted station with ≥3 calls, turn still running) this post-completion wander would likely label **STUCK**, not fine. So this is a **label disagreement** (plan §8: reported, never relabelled), **not a healthy-turn false alert** — it **validates NO_EFFECT**. **Non-gated (legacy-manual)** → does NOT fail the binding gated-fine hard gate. The suspect-tick increase on legacy `fine` windows (D1) partly reflects **correct wander detections the old end-outcome labels missed**. Sharpening: V3 page-scoping + V4 continuation context (input gap) and V5 judge-accuracy. The binding test is the FULL-corpus **gated-fine** (server-record-labeled healthy) FA worst-case — live epic-120 healthy: 19 suspects / ZERO alerts (encouraging).

## Final gate (PENDING full corpus)
Binding V2 hard gates on the FULL corpus (epic-120 gated healthy + impossible stalls): **gated-fine false alerts WORST-case 0** + **caught MEAN ≥V0** + **false recoveries 0**. If ANY gated fine window false-alerts (e.g. epic-120 healthy), V2 FAILS and must be mitigated within V2 (e.g. NO_EFFECT counts only same-page/no-effect repetition — minimal page-awareness pulled forward — or a higher threshold), re-scored, reported. Procedure: ingest eval's real batches (split-preservation assert 0 holdout flips) → re-score FULL-corpus V0 (v1 code, true reference) → V2 tune k=3 → holdout ONCE (no code change after viewing holdout). Then lead sends eval the V2 live pin (`996f0e1`) for stall-loop ×5 + epic ×5; V2 merge after replay+live green.

## Invariants preserved
Watcher report-only (never steers/stops/captures/retries/mutates outcomes); hard signals model-independent; judge can never veto a hard signal; untrusted input schema-validated/plain-text; cost separate; one runner/one turn slot; marathon switch companion-owned; 34 standing tools; prompt ceiling; remote API limits; auto-updater untouched.