# V3 live acceptance — page identity for repeated work (marathon-long ×5 + marathon-epic ×5)

**Status:** COMPLETE — binding criteria met (FA 0 worst healthy ×10 runs, mutation-revisit fires 0 healthy ×10, caught gate on what exists: no live stuck windows, 0 misses; holdout 0.920 ≥ V2 carries the comparison). **Plan:** `MARATHON-V2-PLAN.md` §5 V3 live. **Owner:** eval.
**Final pin:** `b66ab1052830df7dff08f2fe54f3da32b7d2380c` (chain: 8880528 digest-annotation isolation → b66ab10 isolation result). Worktree `/tmp/crazyagent-v3-live` (moved from the VOID 9c1359d pin), overlays from merged main `b1be637` byte-identical, FRESH home `/tmp/crazyagent-v3-final-eval` (VOID home kept separate). Model 1017 @ medium, `--marathon` arming verified per run, judge wired.

**Verified at pin before spend:** page-scoped REVISIT_HINT signal (ledger:509 `mutationRevisit = pageStats.some(count≥2 ∧ ok≥1 ∧ sameOutcome)`, :652 push; unknown-page acts excluded, fail-toward-silence); `buildDigest` mutationRevisits **bare** (watch-judge.mjs:153 maps only tool/args/count/ok/sameOutcome — the lead-authorized isolation deviation, documented in code); **pageIdentity absent from watch-judge.mjs entirely** (replay-only ledger metric); pageKey/controlName remain in ledger aggregates (ledger:514); REPEAT_LOOP unchanged.

**Gates:** npm test **1293/1293** + c1 + 4-scenario self-tests at pin. Smokes: marathon-long PASS 68.1s 12/12; epic-120 partial 583.7s 119/120 (station-7 redo, checker caught; watcher clean, 0 chat.watch frames; analyzer: mutationRevisit false, 0 fires, pageIdentity 132 acts/0 unknown/116 pages).

**VOID pre-history (diagnostic only, commit 6069f7b):** pin 9c1359d leaked pageIdentity.distinctPages into the judge digest (bias: exploration→progressing; replay caught same-k V2 0.867 vs V3 0.600). Lead HOLD killed the smoke mid-run (scoped PGID, no orphans); ×5 never fired; interrupted turn archived `m0-archive/run-2026-11-17T10-47-19-218Z-46bc3c/` with VOID-NOTE. Final holdout k=5 caught 0.920 ≥ V2 0.867 (unbiased); tune k=5 0.667 < V2 is the documented multi-page-stuck corroboration trade-off (V5 target).

**Binding done-when (lead):** FA 0 worst on healthy · REVISIT_HINT mutation-revisit fires on NO healthy run · caught mean ≥ V2 LIVE (V2 live: stall-r4 caught @109s, epic healthy silent). Live caught significantly < V2 live → STOP + report.

**Measurement method:** aggregates are judge-digest-only (not logged), so per-turn V3 metrics come from `/tmp/v3-revisit-analyze.mjs` — replays each turn's DSH tool events through the PIN's OWN `WatchLedger` + `assess()` with exact adapter semantics (raw arguments-string fingerprints, isError→ok, extractToolResultText join). Plan activities are not fed, so openFlat REVISIT cannot fire in replay (V4 owns it); REVISIT_HINT fires measured here are exactly the mutation-revisit branch. Validated on V2 archives (healthy r4: false/0 unknown; known-redo r1: the narrow signature missed the label-differing redo — informational: the hint is not a redo detector, the checker remains the redo authority). Pre-registered: page identity is best-effort (compact batch results name no URL → acts attribute to the last named page; unknownPageShare counts only pre-first-URL acts).

## Batch 1 — marathon-long ×5: 5/5 PASS, 0 mutation-revisit fires (key beneficiary clean)

- **JSON:** `e2e/baselines/2026-11-17T11-53-49-422Z-v3-live-marathon-long.json` (commit `6500fcf`) · **archive:** `m0-archive/run-2026-11-17T11-53-49-509Z-9c36bb/` (4.0 MiB) · commitUnderTest `b66ab1052830…`
- turnIds: `turn-mwkmwdme-2938`, `turn-mwkmxx53-ffe1`, `turn-mwkmzv0o-718e`, `turn-mwkn0r9z-292f`, `turn-mwkn1mm2-2ec4`

| run | wall s | valid | ticks ok/sus/hard | judge | alerts | mutation-revisit fires | pageIdentity acts/unknown/pages |
|---|---|---|---|---|---|---|---|
| 1 | 71.6 | 12/12 | 2/1/0 | 0 | 0 | 0 | 34/0/11 |
| 2 | 90.1 | 12/12 | 1/4/0 | 0 | 0 | 0 | 45/0/11 |
| 3 | 41.5 | 12/12 | 0/2/0 | 0 | 0 | 0 | 26/0/12 |
| 4 | 40.3 | 12/12 | 0/2/0 | 0 | 0 | 0 | 27/0/12 |
| 5 | 53.9 | 12/12 | 0/2/0 | 0 | 0 | 0 | 23/0/11 |

12-station multi-page same-control workflow: mutationRevisit FALSE ×5, REVISIT_HINT mutation-revisit tick fires 0 ×5, unknown-page share 0 ×5. 0 redos, 0 recovered, 0 ended-incomplete (clean completes). Judge 0 calls (turns ≤ 90 s, below the trigger floor). V3's page-scoping eliminates the false revisits that whole-turn grouping would create across pages.

## Batch 2 — marathon-epic ×5 (120 stations): 0 alerts, 0 mutation-revisit fires, 4/5 PASS + 1 honest redo partial

- **JSON:** `e2e/baselines/2026-11-17T11-58-49-721Z-v3-live-marathon-epic.json` (commit `28847c1`) · **archive:** `m0-archive/run-2026-11-17T11-58-49-806Z-81226a/` (23.8 MiB) · commitUnderTest `b66ab1052830…`
- turnIds: `turn-mwkn2tc7-44c3`, `turn-mwknej1g-e90c`, `turn-mwknnfxb-463c`, `turn-mwknzjv5-610e`, `turn-mwko7gvn-b17a`

| run | verdict | wall s | valid | ticks ok/sus/hard | judge | verdicts | alerts | mut-revisit fires | pageIdentity acts/unknown/pages |
|---|---|---|---|---|---|---|---|---|---|
| 1 | pass | 546.1 | 120/120 | 3/24/0 | 5 | prog×4 + unk×1 | 0 | 0 | 128/0/120 |
| 2 | pass | 415.5 | 120/120 | 2/19/0 | 4 | prog×4 | 0 | 0 | 139/1/18 |
| 3 | pass | 564.5 | 120/120 | 2/26/0 | 5 | prog×5 | 0 | 0 | 141/0/18 |
| 4 | pass | 368.9 | 120/120 | 2/16/0 | 3 | prog×3 | 0 | 0 | 123/0/3 |
| 5 | partial | 435.4 | 118/120 | 2/20/0 | 4 | prog×4 | 0 | 0 | 129/1/5 |

All walls > 4 min (+5 fine>4min windows). Judge 21 calls, 166,386 in / 3,120 out tokens (separate); 20 progressing + 1 unknown@0; **zero alerts, zero recovered frames (falseRec 0)**; poller 2,326 samples, 0 open-alert samples. Ticks 116 = 11 ok / 105 suspect / 0 hard = **90.5%** (V0 ref 90.4%, V2 live 86.0% — honest record; suspect-rate is not a V3 binding gate). ended-incomplete absent on all (model labels reported-complete, incl. r5's checker partial — known label≠verification semantics).

**r5 partial (honest):** stations 4 and 8 recorded twice (redos), order broken; completion view genuine; checker caught it from server records. **Informational — "fires on labelled redo":** the narrow mutation-revisit signature (identical args-fingerprint incl. view labels + same page + same control + same outcome) did NOT fire on r5's redos, nor on the V2-r1 redo, nor on the smoke's station-7 redo. The hint is a high-precision corroboration signal, not a redo detector; the checker remains the redo authority. No false fires on any healthy run (the binding requirement).

**pageIdentity (pre-registered best-effort behavior confirmed):** unknownPageShare 0–0.78% (only pre-first-URL acts count as unknown); distinctPages 120/18/18/3/5 — batch-internal navigation names no URL, so acts attribute to the last named page; r1's explicit-navigation style named all 120. Replay-only metric; absent from the judge digest (verified).

## V3 live binding verdict — **CRITERIA MET (caught gate on what exists)**

| criterion | result |
|---|---|
| FA 0 worst on healthy | ✓ 0 alerts across all 10 runs (long ×5 + epic ×5); pollers 0 open-alert samples (2,326 epic + long samples) |
| REVISIT_HINT mutation-revisit fires on NO healthy run | ✓ 0 fires ×10 (pin-ledger replay, per-turn); marathon-long multi-page same-control beneficiary clean |
| caught mean ≥ V2 live | No past-patience stuck windows occurred in the V3 live sample (all runs progressed to honest ends; r5's early redos did not stall the run) → 0 stuck windows, 0 misses — gate evaluated on what exists. The replay holdout k=5 caught 0.920 ≥ V2 0.867 (unbiased, final pin) carries the stuck-detection comparison per lead context; tune k=5 0.667 < V2 remains the documented multi-page-stuck corroboration trade-off (V5 target). A live stuck comparison (stall-loop ×5 at this pin) was not in the ordered suites — available on request. |

**Totals:** 10 runs, 9 checker PASS + 1 honest redo partial; 0 alerts; 0 false recoveries; 0 mutation-revisit fires on healthy; judge 21 calls, 166,386 in / 3,120 out tokens separate; 0 redos on marathon-long, 2 redo stations on epic-r5 (checker-caught).

**Provenance:** final pin b66ab1052830df7dff08f2fe54f3da32b7d2380c; overlays from merged main b1be637 byte-identical; fresh home; gates npm test 1293/1293 + c1 + 4-scenario self-tests before spend; smokes ×1 each (watcher clean); detached setsid runner (PID 1504170) + per-batch pollers; 1017@medium; --marathon arming 10/10 verified; key-scans clean; archives in MAIN m0-archive (27.8 MiB events). VOID 9c1359d pre-history preserved separately (6069f7b), no acceptance credit.
