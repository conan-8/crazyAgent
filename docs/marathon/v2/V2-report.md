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

## Final gate — FULL corpus (157 windows, rebalanced stratified split; k=3, holdout ONCE)

Corpus: 6 collection batches ingested (epic/captcha/spinner/bounce/stall-loop/stop-then-continue ×5), pin de5f69c, 30 runs (27/30 PASS, 1 true-positive alert). Scenario-stratified rebalance (lead ruling): old 24 runs frozen (0 flips), new 6 stratified ~1/3 holdout (epic→holdout for the unbiased binding healthy-long-fine test; bounce-r1 missed-stuck→tune for V5 caught iteration). gatedFine 52 / gatedStuck 8 / legacyManual 70; fine>4min 7; distinctStuckRuns 7. Mean-rate metric = average of per-window mean fractions (§5 V5), worst = share flagged worst-case.

| Binding hard gate | Tune V0→V2 | Holdout V0→V2 | Result |
|---|---|---|---|
| gated-fine FA WORST-case 0 | 0 → 0 | 0 → 0 (incl. epic-120 healthy) | **PASS** both |
| caught MEAN ≥V0 | 0.556 → 0.778 | 0.867 → 0.867 | **PASS** both |
| false recoveries 0 | 3 → 0 | 4 → **1** | tune PASS; **holdout 1 residual** |

Diagnostics: caught WORST tune 0→0.667, holdout 0.600; stability tune 0.900→0.967, holdout 0.933; stale tune 0, holdout 1→0 (V1 fix). gated-fine suspect-tick share tune 0.074→0.111, holdout 0.240→0.360 (D1 deviation). Legacy fine FA worst tune 0→0.032 (the 458428-t3 label disagreement, D2), holdout 0.

**Residual holdout false recovery (`04-36-10-612Z-805c49-t4`, gated stall-loop) — RECORDED V2 GAP (lead ruling OPTION A, accepted):** alert stuck@140s (source both); recovered@240s via completed-count-up (0→1) + 11 effectful acts + signals absent. Recovery@240 == turn end == stuckEnd boundary (where V1's close supersedes anyway). The agent marks a plan item completed + clicks effectfully client-side, but the independent server label says stuck (stall-loop, 0 POSTs, no server progress). **Root cause — fundamental perspective mismatch:** V2 recovery is **deterministic client-side** (effectful client acts + model-reported plan completion); the independent label uses **server progress**. The watcher cannot see server progress, so perfect agreement is impossible when client actions never reach the server. Boundary case, holdout-specific (tune falseRec 0). **No code change after viewing holdout (holdout-once discipline); tune has 0 falseRec, so no principled tune-driven fix exists.** V2 substantially improved falseRec (tune 3→0, holdout 4→1); the false-recovery done-when is met on TUNE. **Honest limitation:** V4/V5 may sharpen plan-completion trust, but recovery is deterministic client-side — this client/server perspective gap is NOT claimed to be fixed by V4/V5. The **LIVE gate** (falseRec 0 on live stall-loop/epic) is the next actionable test (live evidence is not holdout-protected; if live shows false recoveries, fix from that). Lead flags this gap to the user in the morning report.

**Targets vs honest distribution:** ≥15 stuck / ≥10 runs **SHORT** (8 gated stuck from 7 runs; only 2 live past-patience stuck windows — bounce-r1 missed, stall-r2 caught — because impossible scenarios mostly end honestly <120s). fine>4min 7 (≥15 SHORT). Gate on what exists (plan §8); thresholds never bent. The corpus/replay carries the gated stuck set; live stuck material is sparse by honest design.

**Next:** lead reviews diff + npm test and merges V2 (core does not self-merge); then V3 implement go (`v2/v3-pagekey`).

## V2 LIVE gate — ALL FOUR done-when criteria MET (pin 7d0fd8e; eval V2-live.md 2dc251d)

Live stall-loop ×5 + marathon-epic ×5 (10 runs, isolated profile, 1017@medium, watch poller):
| Done-when | Live result |
|---|---|
| false recoveries 0 | **0 across all 10 runs** ✓ (V2 evidence-based recovery refuses no-effect clicks; the holdout residual boundary case does NOT reproduce live — validates OPTION A) |
| false alerts 0 on healthy | **0** ✓ (epic poller 2137 samples 0 open; 0 alerts / 0 recovered) |
| caught mean ≥V0 (past-patience stuck) | **1/1 live** past-patience alerted (stall-r4 @109s source both, persisted to honest end) vs V0 live 1/2 ✓ |
| suspect-on-healthy ≤V0 | **epic 86.0% (92/107) ≤ V0 90.4%** ✓ IMPROVED despite NO_EFFECT — observe/control/act classes exclude read-only no-progress |

The live suspect-on-healthy gate resolves the replay suspect-share deviation (D1) favorably: on real healthy epic work the suspect rate DROPPED (86.0% vs 90.4%), because NO_EFFECT counts only act results and the tool classes exclude read-only no-progress. The cumulative re-eval after V4 still applies (V3 removes multi-page REVISIT suspects; epic REPEAT_LOOP station-form suspects remain — V3 known residual).

Live census: epic walls 675.5/434.1/436/255.8/339.1s (all >4min), judge 19 calls (16 progressing + 3 unknown@0) 154,453/3,788 tokens separate; stall-loop walls 116.8/18.9/52.8/239.5/83.0s honest BLOCKED, judge 3 calls. V2 totals: 10 runs, **2 alerts both true positives**, 0 false alerts/recoveries, judge 22 calls 171,942/4,335 tokens. V1 lifecycle verified live (stall-r4 alert closed 'Turn ended.' + ended-incomplete superseded).

**Completion honesty (scenario-level, watcher clean throughout):** epic 2/5 full PASS + 3 partials — r1 genuine station-skip + redo + false DONE claim caught by the server-record checker (judge read progressing/unknown during redo; progressing≠correct known limit); r2/r3 120/120 server-complete but frozen final-state contract / model reload reset the fixture view. All planOutcome reported-complete → ended-incomplete absent on checker partials (v1 label semantics observation, not a watcher fault). Cosmetic follow-up: checkEpic reason string still 'station 36'.

**V2 merge-ready:** replay hard gates (1) gated-fine FA worst 0 both + (2) caught mean ≥V0 PASS; falseRec holdout residual accepted (OPTION A); LIVE all four green. Lead reviews + merges.

## Invariants preserved
Watcher report-only (never steers/stops/captures/retries/mutates outcomes); hard signals model-independent; judge can never veto a hard signal; untrusted input schema-validated/plain-text; cost separate; one runner/one turn slot; marathon switch companion-owned; 34 standing tools; prompt ceiling; remote API limits; auto-updater untouched.