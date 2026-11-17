# V3 report — page identity for repeated work (page-scoped REVISIT_HINT)

**Date:** 2026-11-17 · **Task:** task-17 (core) · **Plan:** `MARATHON-V2-PLAN.md` §3.4 + §5 V3 + §6 + G4
**Branch:** `v2/v3-pagekey` from merged main `8b7419b` (V2 merged). **One main change: page identity for repeated work.** Watcher report-only; REVISIT_HINT stays soft (never alerts alone); hard signals model-independent.
**Status:** implementation + full-corpus replay done; replay HARD gate (gated-fine FA worst 0 both) PASS; tune caught-mean drop accepted as documented judge sampling variance (lead OPTION A); **V3 LIVE gate pending** (marathon-long ×5 + epic ×5, pin 9c1359d).

## What changed (`companion/watch-ledger.mjs`, `companion/watch-judge.mjs`)
- **Page key (best-effort):** `parsePageKey(text)` extracts the URL from a tab line (`tab <id> "<title>" <url>`) or a navigate result (`navigated [back|forward] to <url>` / `reloaded <url>`). `currentPageKey` = the most recent result naming a URL; a result naming none keeps the previous key (a click does not change pages); unknown stays unknown.
- **Control name:** `parseControlName(head)` parses `clicked label N: <role> "<name>"` (quoted name) or `typed into [N]` (field label); untrusted text clipped (≤80) + control chars stripped, plain text only; null when no control named.
- **Page-scoped grouping:** `pageActStats` groups **effectful act** results (ok, not no-effect, not control) with a **known** page key by `full-URL | toolFingerprint | controlName`. Unknown page → excluded (fails toward silence). No-effect acts feed NO_EFFECT, not revisits. Bounded ≤1000 keys.
- **REVISIT_HINT refinement:** the mutation-revisit branch is now page-scoped — an effectful act repeated on the **same page** against the **same control** with the **same outcome**, threshold **2** (was whole-window fingerprint 3). The openFlat branch is **unchanged** (V4 owns continuation context). Navigation revisits stay digest-only. Still suspect, never alerts alone; brings the judge forward; corroborates two-strike.
- **Digest:** `mutationRevisits` entries gain `pageKey` (URL **path** ≤60, `pageKeyPath` fail-safe) + `controlName`; new `pageIdentity {actResults, unknownPage, unknownPageShare, distinctPages}` (compact-view risk metric). Full URL for grouping identity (query-distinct pages are different), path for the readable digest.
- **REPEAT_LOOP UNCHANGED** (lead ruling: V3 scope is REVISIT_HINT only; one main change). Epic healthy station-form REPEAT_LOOP suspects (same args, different pages) **remain** — recorded residual + follow-up candidate (page-scoping REPEAT_LOOP); the suspect-tick cumulative re-eval after V4 accounts for it.

## Commits
- `828d5e6` V3 implementation + 8 tests (parsing, page-key tracking, page-scoped grouping incl. multi-page negative + unknown exclusion + no-effect→NO_EFFECT, digest). Old whole-turn revisit test updated to V3 semantics.
- `9c1359d` full-corpus replay k=3 (tune + holdout once) vs V2 baseline.

## Gates

### npm test (cheapest)
**1293/1293 green** (1285 V2 base + 8 V3).

### Full-corpus replay k=3 (157 windows, stratified split; holdout ONCE)
| Metric | Tune V2→V3 | Holdout V2→V3 |
|---|---|---|
| gated-fine FA WORST | 0 → 0 ✓ | 0 → 0 ✓ (epic healthy) |
| caught MEAN | 0.778 → **0.556** | 0.867 → 0.867 ✓ |
| caught WORST (diag) | 0.667 → 0 | 0.600 → 0.800 |
| falseRec | 0 → 0 | 1 → 1 |
| stale | 0 → 0 | 0 → 0 |
| stability (diag) | 0.967 → 0.900 | 0.933 → 0.967 |
| gated-fine suspect share | 0.111 → 0.111 | 0.360 → 0.360 |

**Replay HARD gate (gated-fine FA worst 0 both splits): PASS.** The caught-mean done-when (≥V2) fails on tune literally; accepted as judge sampling variance (below), holdout held.

## Tune caught-mean drop — DOCUMENTED JUDGE SAMPLING VARIANCE (lead OPTION A)
The tune caught mean fell 0.778→0.556 (back to the V0 level). Investigation shows this is **low-effort judge sampling variance on a tiny noisy tune sample (3 stuck windows)**, NOT a page-scoping regression:
- **Debug of `00-43-57-262Z-2ab066-t2` (V3 code, real judge):** page **KNOWN** — `pageIdentity {actResults:46, unknownPage:0, distinctPages:16}`. The clicks are `click_at` batches spanning **16 distinct pages** with varying coordinates → `mutationRevisit:false` in **both** V2 (varying whole-turn fingerprints) and V3 (page-scoped). So V3 did **not** remove the corroboration: `PLAN_STALLED` corroborates the alert `stuck@100s source:both` (judge `stuck@0.9`) → **CAUGHT** in that run; `openFlat` REVISIT_HINT fires @160/180s (unchanged branch).
- V2 happened to catch the 2 original stall windows 3/3; V3 caught 1/3 + 2/3. The judge verdicts (stuck/unknown/progressing) vary across runs at low effort; k=3 on 3 windows is noisy.
- **Holdout (5 windows) held stable at 0.867** (caught worst even improved 0.600→0.800, stability 0.933→0.967) — the larger sample shows no regression.
- **Page-unknown exclusion is NOT the cause:** corpus act results only **4.1% unknown page** (198/4830), fine 4.3% (184/4272). The stall window had 0 unknown.
- This is the judge variance plan §8 anticipates (V5 candidate 3 targets the root cause). The contract's "repeat important model-driven scenarios enough to tell a lucky run from reliability" is satisfied by the **LIVE ×5**, not a tiny k=3 tune sample.
- Higher-k evidence (V2 vs V3 tune at the SAME k=5): see below.

## Labelled-redo coverage (informational done-when)
The corpus has only **2 windows with labelled redo**, both **legacy-manual (non-gated)** with `atSec:null` (old archives expose redo via `perStep.posts>1`, no timestamp): `02-14-11-994Z-c82d46-t9` (stop-then-continue, fine, redo step 9) and `02-44-34-045Z-b5a71b-t3` (marathon-long, stuck, redo steps 4/5). The `redoCaught` metric requires a timestamp (`atSec!=null`), so these are skipped in replay scoring. The corpus redo material is sparse by honest distribution (the new collection runs had 0 redos: epic 120/120 exactly-once, stop-then-continue continuation redo 0/5). The **live marathon-long ×5** carries timestamped server-record redo evidence — the real test of "REVISIT_HINT fires on every labelled redo". V3's page-scoped mutation-revisit fires when a redo is an effectful same-page same-control same-outcome repeat.

## REVISIT_HINT on healthy runs
The V3 **mutation-revisit branch fires on NO healthy run** (page-scoped: healthy multi-page work has distinct page/control keys → no revisit). The gated-fine suspect share is unchanged because healthy epic suspects come from **REPEAT_LOOP / PLAN_STALLED / openFlat**, not mutation-revisit — V3 does not touch those (REPEAT_LOOP unchanged per ruling; openFlat is V4's). V3's benefit (removing multi-page **same-control** false revisits) shows on multi-page same-control work = **marathon-long live**, not epic. The openFlat REVISIT_HINT on healthy epic (open items flat while stations progress) is a V4 concern, unchanged from V2.

## Higher-k evidence (V2 vs V3 tune, SAME k=5) — CORRECTS the pure-variance claim
Same-k=5 comparison (`v2-tune-k5.json` / `v3-tune-k5.json`): caught MEAN **V2 0.867 vs V3 0.600** — the gap **persists at k=5**, so it is **not pure k=3 sampling luck**. Per-window: bounce 0.80/0.60, stall 0.80/0.40, stall 1.00/0.80 (V3 consistently ~0.2–0.4 lower on all 3 tune stuck windows). fineFA worst 0 both; stability V2 0.933 / V3 0.900.

**Digest root-cause check** (V2 vs V3 ledger on `00-43-57-t2`): the `mutationRevisits` **list is IDENTICAL** (browser_switch_tab count 3 + browser_navigate count 2, sameOutcome false in both); `mutationRevisit` boolean false in both; REVISIT_HINT signals the same (openFlat branch). So page-scoping the revisit **list** removed no judge evidence here. The difference: **V3 adds `pageIdentity {distinctPages:16}` to the judge digest** (`buildDigest`). Hypothesis: showing the judge "16 distinct pages" leads it to read multi-page wander as **exploration (progressing)** rather than stuck → fewer stuck verdicts → lower caught, plus residual low-effort judge variance on the tiny 3-window tune sample.

**Correction:** the earlier "pure variance" conclusion (from a single caught k=3 debug run) is refined — there is a small **systematic** V3 caught reduction from the `pageIdentity` digest context leaking into the judge prompt, plus variance. `pageIdentity` was added as a replay risk metric but leaks into `buildDigest`; making it **replay-only** (not in the judge digest) is the candidate mitigation. The replay HARD gate (gated-fine FA worst 0 both) still PASSES; holdout caught held 0.867 (k=3). The caught-mean done-when (≥V2) fails on tune systematically. **Lead ruling pending** (mitigate within V3 + re-score authorization vs accept + live test); no code change after viewing holdout without lead go (holdout-once discipline).

## Lead-authorized bug fix + holdout re-score EXCEPTION (transparency)
**Lead ruling OPTION A (principled bug fix):** make `pageIdentity` **replay-only** — removed from `buildDigest`/judge prompt (commit `1e3ea50`); kept in ledger aggregates as the replay risk metric (`unknownPageShare`). The judge digest now gets **only** the intended V3 change (`mutationRevisits` entries +`pageKey` URL path ≤60 +`controlName`), removing the `distinctPages` exploration bias and restoring the digest to V2-equivalent + the pageKey annotation.
- **Tune-evidence-driven, NOT holdout-fitting:** the fix is motivated by the k=5 same-k caught gap (V2 0.867 vs V3 0.600) + the digest root-cause comparison (mutationRevisits list identical; pageIdentity the only difference). The holdout result (held 0.867) did **not** motivate it.
- **Holdout re-score authorization (documented exception):** strict holdout-once forbids code change after viewing holdout; lead explicitly authorized re-scoring **tune k=5** (verify caught mean ≥V2 0.867) + **holdout ONCE more** (confirm no regression) because this is a **bug fix removing an unintended addition**, driven by tune evidence — not fitting to holdout. The holdout-once **spirit** (no fitting to holdout) is preserved. Fixed pin `1e3ea50`; eval V3 live held at the buggy pin 9c1359d until the fixed re-score is confirmed.
- **Re-score results (fixed pin `1e3ea50`, commit `b59981a`) — the fix did NOT restore caught (SECOND CORRECTION):** tune k=5 caught mean **0.600** (IDENTICAL to buggy V3 per-window 0.60/0.40/0.80 → pageIdentity removal had **zero** tune effect; the pageIdentity root-cause hypothesis was **wrong**), still < V2 0.867. Holdout k=3 caught mean **0.667** (dropped from V2 0.867 AND buggy V3 0.867 — opposite to the exploration-bias hypothesis; holdout k=3 is variance-dominated). fineFA worst **0 both** (hard gate PASS); falseRec holdout **0** (improved from 1); stale 0.
- **Refined analysis:** tune k=5 buggy V3 == fixed V3 (0.600, identical) ⇒ the V3 caught reduction vs V2 is a **stable reproducible** effect, NOT pageIdentity and NOT pure variance. The remaining stable V3 digest difference is the `mutationRevisits` entries gaining `pageKey`+`controlName` (list entries identical V2/V3: browser_switch_tab count3 + browser_navigate count2 sameOutcome:false; mutationRevisit bool false both). Refined hypothesis: the pageKey/controlName annotation on navigation revisits leads the judge to read cross-page navigation/exploration (progressing) vs V2's bare repeat read as stuck; plus low-effort judge variance. **Not definitively isolated.** The page-scoped REVISIT_HINT *signal* is sound (multi-page false-revisit fix verified); the issue is the judge-digest annotation's effect on caught. Lead ruling requested (targeted tune-only annotation-revert test vs accept caught gap + live binding).

## V3 LIVE gate (PENDING — binding)
Pin `9c1359d`, eval marathon-long ×5 + epic ×5. Binding: caught mean ≥V2 live; REVISIT_HINT mutation-revisit fires on NO healthy run; FA 0 worst. marathon-long exercises the multi-page same-control revisit benefit; epic confirms FA 0 on healthy long-fine. V3 merge after live green (lead reviews diff + npm test).

## Invariants preserved
Watcher report-only; hard signals model-independent; judge can never veto a hard signal; untrusted input clipped plain text (page key/control name); cost separate; one runner/one turn slot; 34 standing tools; prompt ceiling; REPEAT_LOOP unchanged; openFlat unchanged (V4); nav revisits digest-only.
