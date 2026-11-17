# V0 baseline — v1 watcher replay (manifest-driven, k=3, both splits)

**Date:** 2026-11-17 · **Task:** task-13 (core, took over from judge/replay) · **Plan:** `MARATHON-V2-PLAN.md` §3.1 / §5 V0 / §6 / G8
**Pin under test:** v1 watch files (`companion/watch-{ledger,watcher,judge}.mjs`) identical to `de5f69c` (v2.4.0). **V0 makes NO product change.**
**Branch:** `v2/v0-corpus` · **Corpus:** `e2e/watch-corpus/manifest.json` (122 windows, labels frozen by `scripts/watch-label.mjs` from independent fixture-server state BEFORE scoring; patience frozen; never tuned here).
**Method:** `scripts/watcher-eval.mjs --split <tune|holdout> --repeat 3` — each window's committed trace (sha256-verified) replayed through the **real** WatchLedger + Watcher + judge under a fake clock (fixed jitter `()=>0.5`; real-judge sampling variance is what k=3 measures). Judge: `deepseek/deepseek-v4.1-flash-1017` @ openrouter, **low effort, ≤400 output tokens** (M4 contract). Key from `MAIN_ROOT/.dsh-home/browser-agent/api-key`, never printed/committed. Detached runs (`setsid nohup`), results `v1-tune-k3.json` / `v1-holdout-k3.json`.

**Holdout discipline:** split BY RUN, seeded `marathon-v2-v0`, bottom-third holdout, **fixed before scoring** (8 holdout runs / 16 tune runs, no run on both sides). `watch-label.mjs` now PRESERVES frozen run→split on rebuild (commit `1ab6484`) so ingesting eval's new batches cannot flip the holdout. While changing code (V2–V5) only **tune** is consulted; holdout is scored once per milestone end. This V0 baseline scores both splits (V0 is the no-change baseline); **no product code change follows viewing holdout within V0**.

## Headline gates (gated windows only; legacy-manual reported, never gated)

**Gate definitions (lead ruling 2026-11-17):** the **caught GATE is MEAN across k ≥80%** (plan §5 V5: "mean, k=3, tune and holdout each"). **Worst-case caught and stability are DIAGNOSTICS** / V5 keep-rule conditions (stability must not fall), NOT the caught gate. The **false-alert GATE is worst-case 0** on fine windows. V2 done-when "caught not below V0" compares the MEAN.

| Gate | Tune | Holdout | Target |
|---|---|---|---|
| Fine: zero false alerts (worst-case) | **PASS** (0/8) | **PASS** (0/16) | 0 |
| Stuck: caught MEAN ≥80% | **PASS** (2/2 = 100%) | **PASS** (4/4 = 100%) | ≥80% |

**Diagnostics (not the caught gate):** worst-case stuck-caught (caught in ALL k) is 50% in both splits (tune 1/2, holdout 2/4); stability 90% gated. The v1 judge's sampling variance shows here — a window reliably caught must survive every repeat. **Caveat:** the mean gate passes on a TINY sample (6 easy gated stall-loop windows, all caught in ≥1 repeat); the full corpus (harder stall-loop/wander cases from eval's collection) gives the real number and is the reference for V2–V5. This reproduces the M4 FALLBACK-A nuance (distinct-run detection below target on harder cases). **Zero false alerts on healthy gated turns is met in both splits, mean and worst.**

## Per-group metrics (k=3)

### Tune (84 windows)
| Group | windows | fine | stuck | fine false-alert mean/worst | stuck caught mean/worst | stability | stale windows | false-recovery windows | ended-incomplete correct |
|---|---|---|---|---|---|---|---|---|---|
| gatedAll | 10 | 8 | 2 | 0% / 0% | 100% / 50% | 90% | 0 | 2 | 5/10 |
| gatedClean | 0 | 0 | 0 | — | — | — | 0 | 0 | — |
| gatedContaminated | 10 | 8 | 2 | 0% / 0% | 100% / 50% | 90% | 0 | 2 | 5/10 |
| legacyManual | 60 | 58 | 2 | 0% / 0% | 50% / 0% | 98.3% | 0 | 1 | 60/60 |
| all | 84 | 80 | 4 | 0% / 0% | 75% / 25% | 97.6% | 0 | 3 | 79/84 |

All gated tune windows are `origin:'contaminated'` (M1-code mid-flux diagnostics, lead-accepted as gated; labels from independent state, replay runs the pinned v1 watcher). `gatedClean` is empty in tune.

### Holdout (38 windows)
| Group | windows | fine | stuck | fine false-alert mean/worst | stuck caught mean/worst | stability | stale windows | false-recovery windows | ended-incomplete correct |
|---|---|---|---|---|---|---|---|---|---|
| gatedAll | 20 | 16 | 4 | 0% / 0% | 100% / 50% | 90% | 1 | 3 | 11/20 |
| gatedClean | 20 | 16 | 4 | 0% / 0% | 100% / 50% | 90% | 1 | 3 | 11/20 |
| gatedContaminated | 0 | 0 | 0 | — | — | — | 0 | 0 | — |
| legacyManual | 5 | 5 | 0 | 0% / 0% | — | 100% | 0 | 0 | 5/5 |
| all | 38 | 34 | 4 | 0% / 0% | 100% / 50% | 94.7% | 1 | 3 | 29/38 |

All gated holdout windows are `origin:'clean'`; `gatedContaminated` is empty in holdout.

### Contaminated-origin sensitivity (lead ruling: report incl AND excl)
Because the contaminated runs all fell in tune and the clean gated runs in holdout (by-run split), each split has only one populated gated subgroup. **Including vs excluding contaminated does not flip any gate:** fine zero-false-alerts PASS everywhere; stuck worst-case ≥80% FAIL in both populated gated groups (tune-contaminated 50%, holdout-clean 50%). No gate pass/fail flip to flag. (The combined gated-stuck picture: 6 windows, mean caught 6/6 = 100%, worst-case caught 3/6 = 50%.)

## Stuck-window detail (gated)
| Window | Scenario | Split | Origin | caught mean | caught worst | stable | alert kinds / atSec (per repeat) |
|---|---|---|---|---|---|---|---|
| 00-43-57-262Z-2ab066-t2 | stall-loop | tune | contaminated | 0.67 | false | false | –/stuck/stuck @ –/100/100 |
| 00-43-57-262Z-2ab066-t4 | stall-loop | tune | contaminated | 1.00 | true | true | stuck/stuck/stuck @ 360/160/360 |
| 01-13-25-223Z-02b684-t4 | stall-loop | holdout | clean | 0.67 | false | false | stuck/stuck/– @ 140/140/– |
| 04-36-10-612Z-805c49-t1 | stall-loop | holdout | clean | 0.67 | false | false | stuck/stuck/– @ 140/140/– |
| 04-36-10-612Z-805c49-t3 | stall-loop | holdout | clean | 1.00 | true | true | stuck/stuck/stuck @ 100/100/100 |
| 04-36-10-612Z-805c49-t4 | stall-loop | holdout | clean | 1.00 | true | true | stuck/stuck/stuck @ 120/120/220 |

All gated stuck alerts are judge `stuck` verdicts (two-strike corroborated). The misses are repeat-variance (a verdict sampled `progressing`/`unknown` in one repeat), not a mechanism failure. Legacy-manual stuck (non-gated): `02-14-11-994Z-c82d46-t10` (stop-then-continue, never caught — a quick honest end before onset) and `02-44-34-045Z-b5a71b-t3` (marathon-long, caught 1/3 @220s).

## Stale alerts (the V1 fix target, measured on v1)
**1 stale-alert window** (holdout `01-13-25-223Z-02b684-t4`): a mid-turn alert id whose last state is still `open` at turn end with no closing frame. v1 `watcher.turnEnded` nulls `openAlert` WITHOUT publishing a close frame, so the panel/phone reducer keep the row open while `/state` clears — the asymmetry V1 fixes. Tune shows 0 stale because its gated stuck alerts recovered before turn end (see false recoveries). `ended-incomplete` persists open by design (until ack) and is tracked **separately**, not counted as stale.

## False recoveries (recovered notice while label still stuck)
- Tune gated: `00-43-57-262Z-2ab066-t2`, `-t4` (2). Legacy: `02-44-34-045Z-b5a71b-t3` (1).
- Holdout gated: `04-36-10-612Z-805c49-t1`, `-t3`, `-t4` (3).
A recovery fired during the stuck span (3 successful results incl. a mutation, or a plan revision) even though the independent label says the turn was still stuck — the v1 recovery heuristic can be satisfied by activity that does not constitute real progress. V2's progress accounting addresses this.

## Ended-incomplete vs end-class rule
Correct on 5/10 gated tune, 11/20 gated holdout. Fine windows with `endClass:'blocked'` (quick honest BLOCKED under thresholds) EXPECT `ended-incomplete=true`; mismatches are v1 `decideEndedIncomplete` behavior vs the §3.1 end-class rule, recorded as a baseline observation (not a V0 gate). Legacy-manual windows are 100% correct (60/60 tune, 5/5 holdout).

## Suspect-tick rate on healthy turns (V0 baseline for V2's gate)
Healthy fine windows DO produce deterministic `suspect` ticks (soft signals; never alert alone). Tune examples (mean suspect ticks/repeat): `02-02-36-976Z-849181-t5`=12, `03-37-05-493Z-6d9d73-t3`=7, `01-32-38-591Z-f80ac2-t3`=4, `02-02-36-976Z-849181-t1/t2`=4; 31 tune fine windows have ≥1 suspect tick. Holdout: `04-29-11-272Z-dfd724-t1/t2/t4`=2, `-t5`=1, `03-07-12-520Z-2c78d2-t5`=1. **Zero of these healthy windows false-alerted** — the suspect tick is diagnostic, and the two-strike + hard-signal gating keeps false alerts at 0. V2 must preserve this while improving stuck catch. (Replay-side `watch.tick` level capture; eval's live `watchEvidence` will complement this once batches are ingested.)

## Cost (judge only; SEPARATE from agent usage)
| Split | judge calls | input tok | output tok | reasoning tok | cacheRead tok | watched hours | calls/hour | input tok/hour |
|---|---|---|---|---|---|---|---|---|
| Tune (k=3) | 54 | 296,493 | 14,352 | 11,016 | 23,808 | 4.40 | 12.3 | 67,385 |
| Holdout (k=3) | 18 | 91,029 | 4,077 | 2,424 | 0 | 1.52 | 11.9 | 59,986 |

Per-window cost is the full-turn replay usage (each window = 1 turn; dedup `run#turnIndex`), in the JSON `windows[].usage`. Only 6 windows exceed 240 s (judge first call at 240 s, then ~360 s cadence) → ~1–3 calls each per repeat. Total well under $0.1 at v1's ~$0.0004/call. The epic batch (4–10 min healthy turns) is what finally exercises the judge on PROGRESSING work.

## Corpus shortfalls (recorded honestly; thresholds/scenarios NEVER bent)
| Target | Status |
|---|---|
| ≥80 fine windows | **MET** — 114 fine (80 tune + 34 holdout) |
| ≥15 fine windows >4 min | **SHORT** — 2 (eval's lengthened epic ~60–72 stations will add more) |
| ≥15 stuck windows from ≥10 distinct runs | **SHORT** — 8 stuck from 5 distinct runs (6 gated; eval's ~20 impossible runs will add more) |
| Synthetic windows reported apart | 0 synthetic in corpus (mechanism proven via dry-run + M3 GET /state) |

## Legacy-manual comparison (reported, NOT gated)
65 windows lack per-step server timestamps (archives stay legacy-manual). Tune 60 (58 fine/2 stuck), holdout 5 (fine). Zero false alerts on legacy fine; legacy stuck catch is lower (tune 50% mean / 0% worst) — these are reported for comparison only and never gate. Disagreements with v1 hand labels are recorded, never relabelled.

## Plumbing + commits
- `1ab6484` watch-label split-preservation (frozen holdout protected before ingestion).
- `65d69d9` manifest-driven watcher-eval (replay draft completed by core): trace loader sha256+header verify; hard-coded windows removed; §3.1 metrics; --repeat k mean/worst/stability + .rN.json resilience; groups incl/excl contaminated; --dry-run fake judge.
- `e896700` npm test plumbing (`watcher-eval-corpus.test.mjs`, dry-run tune k=2). **Full npm test 1238/1238 green.**
- Results: `docs/marathon/v2/v1-tune-k3.json`, `v1-holdout-k3.json` (+ `.rN.json` intermediates).

## Next (ingestion)
Eval's new V0 batches (serverRecords schema `be1ece7`, pin `de5f69c`) are landing at `/tmp/crazyagent-v2-v0-harness/e2e/baselines/`; archives in `MAIN_ROOT/.dsh-home/browser-agent/logs/m0-archive/`. Ingest via `watch-label.mjs --build` (split-preservation keeps the holdout fixed), key-scan traces + batch JSONs before commit, re-score **tune** (code unchanged); holdout re-scored once at the final milestone end. The new batches currently lack `logArchiveRunDir`/`commitUnderTest` top-level fields — coordinate the batch→archive mapping with eval before ingestion.

---

## FULL-CORPUS UPDATE (2026-11-17, ingestion complete — TRUE reference)

All 6 collection batches ingested (epic/captcha/spinner/bounce/stall-loop/stop-then-continue ×5; pin de5f69c; 30 runs, 27/30 PASS, 1 true-positive alert, 0 false). The real batches carry `logArchiveRunDir`/`commitUnderTest`/`serverRecords`/`watchEvidence` (the dev smokes lacked them). Corpus **122 → 157 windows**: gatedFine 52, gatedStuck 8, legacyManual 70, fine>4min 7, distinctStuckRuns 7.

**Label-rule bug fix (`a3a17bd`):** the progressable onset loop fired at t0=240 on ANY >240s turn with ≥3 calls without checking for a real no-progress gap — mislabeling healthy continuous-progress epic as stuck. Fixed to require NO station accepted in (a, a+240] per §3.1 (patience unchanged; 0 existing relabels). Without it the gated healthy-fine corpus would be wrong.

**Scenario-stratified rebalance (`1ec66fe`, lead ruling):** the initial global hash put ALL 6 new runs in holdout (tune had no new evidence; V5 keep-rule unmeasurable). Re-assigned NEW collection runs ~1/3 holdout within each scenarioClass by seeded hash (scenario metadata ONLY, never labels/results); OLD 24 runs FROZEN (0 flips). Result: epic→holdout (unbiased binding healthy-long-fine test), bounce-r1 missed-stuck→tune (V5 caught iteration); 20 tune / 10 holdout runs. `splitRule` recorded in manifest meta. Lead ruled KEEP the unbiased stratification (do not move epic to tune).

**Mean-rate metric fix (`349116d`):** groupStats mean rate corrected to the AVERAGE of per-window mean fractions (mean over k repeats, §5 V5), not the share of windows flagged in ≥1 repeat; worst rate (share flagged worst-case) unchanged.

### TRUE V0 reference (v1 watch files == de5f69c, k=3, full corpus)
| Split | gated fine/stuck | fine FA worst | caught MEAN | caught WORST (diag) | falseRec | stale | stability | gated-fine suspect share |
|---|---|---|---|---|---|---|---|---|
| Tune | 27 / 3 | 0 | **0.556** | 0.000 | 3 | 0 | 0.900 | 0.074 |
| Holdout | 25 / 5 | 0 | **0.867** | 0.600 | 4 | 1 | 0.933 | 0.240 |

Fine zero-false-alerts worst-case PASS both splits. Caught mean tune 55.6% (<80% on hard cases: bounce-r1 missed unknown×2 + stall variance), holdout 86.7% (≥80%). The 6 gated stuck: tune bounce-r1 (mean 0.33 missed) + 2 original stall (0.67); holdout 4 original stall + stall-r2 (caught). Live past-patience stuck only 2 (bounce-r1 missed, stall-r2 caught) — impossible scenarios mostly end honestly <120s. **Targets honest:** ≥15 stuck/10 runs SHORT (8/7), fine>4min SHORT (7/15); gate on what exists (§8), thresholds never bent. Healthy-suspect live reference: epic-120 103/114 = 90.4% (REPEAT_LOOP+PLAN_STALLED+REVISIT_HINT), judge 20 calls 19 progressing+1 unknown, 0 alerts.

Results: `v0-fullcorpus-tune-k3.json`, `v0-fullcorpus-holdout-k3.json` (+ `.rN.json`). This is the reference for V2–V5 (V2 done-when caught mean ≥ these). V2 full-corpus comparison in `docs/marathon/v2/V2-report.md` (V2 branch): hard gates gated-fine FA worst 0 both + caught mean ≥V0 PASS; falseRec tune 3→0 / holdout 4→1 (residual accepted gap, lead OPTION A).
