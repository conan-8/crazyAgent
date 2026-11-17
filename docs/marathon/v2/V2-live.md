# V2 live acceptance — progress accounting (stall-loop ×5 + marathon-epic ×5)

**Status:** COMPLETE — all four done-when criteria MET (10 runs, 0 false alerts, 0 false recoveries, suspect rate 86.0% ≤ V0 90.4%, past-patience stuck caught). **Plan:** `MARATHON-V2-PLAN.md` §5 V2 live. **Owner:** eval.
**Pin:** `7d0fd8e05936f5ab6ea55678d118eb31505756b9` (v2/v2-progress tip: observe/control/act classes, shared noProgressResultText predicate, NO_EFFECT ≥4/8 soft signal, evidence-based recovery). Judge WIRED. Worktree `/tmp/crazyagent-v2-live` + harness/scenario overlays from merged main `0dc6af6` (byte-identical verified) + fresh home `/tmp/crazyagent-v2-live-eval`. Model 1017 @ medium, `--marathon` arming verified per run.

**Gates before spend:** npm test **1272/1272** at pin + c1 self-test + 6-scenario self-test green. Smokes ×1 each: epic PASS 348.3s (judge 3× progressing, 0 alerts, ticks 1 ok/16 suspect = 94.1%), stall-loop PASS 85.5s honest BLOCKED.

**Done-when (lead):** false recoveries 0 · false alerts 0 worst on healthy (epic especially) · caught mean ≥ V0 on past-patience stuck · suspect ticks on healthy ≤ V0 (epic 90.4% reference — NO_EFFECT may raise; record honestly, re-eval after V4). Any healthy false alert or live false recovery → STOP + report.

**V2 recovery rule under test** (watcher.mjs:111): `(effectfulActs ≥ 2 ∧ signalsAbsentTicks ≥ 2) ∨ completedUp` — no-effect clicks are no longer recovery evidence (v1 counted 3 'ok' results incl. a no-effect "mutation").

## Batch 1 — stall-loop ×5: 5/5 PASS, false recoveries 0, past-patience stuck caught

- **JSON:** `e2e/baselines/2026-11-17T09-29-27-838Z-v2-live-stall-loop.json` (commit `d859dc1`) · **archive:** `m0-archive/run-2026-11-17T09-29-27-926Z-e6e8bd/` (4.2 MiB) · commitUnderTest `7d0fd8e05936…`
- turnIds: `turn-mwkhqq9v-7ac8`, `turn-mwkht8ph-d4fd`, `turn-mwkhtnjv-ad24`, `turn-mwkhuslz-0578`, `turn-mwkhzxp9-6ef1`

| run | wall s | end | ticks ok/sus/hard | judge | alerts | recovered | ended-inc |
|---|---|---|---|---|---|---|---|
| 1 | 116.8 | BLOCKED | 2/3/0 | 1 (stuck@0.85) | 1 stuck@99s 'both' | 0 | ✓ |
| 2 | 18.9 | BLOCKED | 1/0/0 | 0 | 0 | 0 | ✓ |
| 3 | 52.8 | BLOCKED | 3/0/0 | 0 | 0 | 0 | ✓ |
| 4 | 239.5 | BLOCKED | 3/9/0 | 2 (stuck@0.9, stuck@0.85) | 1 stuck@109s 'both' | 0 | ✓ |
| 5 | 83.0 | BLOCKED | 4/0/0 | 0 | 0 | 0 | ✓ |

- **r4 = past-patience stuck CAUGHT:** alert at 109 s (judge stuck@0.9 + PLAN_STALLED corroboration, `source:'both'`), second call stuck@0.85 @209 s (+REVISIT_HINT); **no recovery** — the alert persisted to the honest BLOCKED end at 239.5 s, closed with the V1 lifecycle frame (`state:'closed'`, reason "Turn ended."), ended-incomplete superseded as the one open notice.
- **r1 = looping true positive:** alert at 99 s (judge stuck@0.85 + PLAN_STALLED) while genuinely looping on the inert control, honest end at 116.8 s — the m0Stall-r4 precedent; closed at turn end.
- **False recoveries 0:** zero `recovered` frames batch-wide. V2's evidence-based recovery refuses to recover on no-effect clicks — the v1 path (3 'ok' results incl. a no-effect mutation) is gone; the residual holdout replay falseRec (client/server boundary case) does not reproduce live.
- Quick honest ends r2/r3/r5: correct-no-alert, 0 judge calls, ended-incomplete ✓. Zero POSTs all runs (control pristine). Judge total 3 calls, 17,489 in / 547 out tokens (separate). Ticks 25 = 13 ok / 12 suspect / 0 hard.

## Batch 2 — marathon-epic ×5 (120 stations): 0 alerts, 0 false recoveries, suspect rate 86.0% ≤ V0

- **JSON:** `e2e/baselines/2026-11-17T09-38-01-800Z-v2-live-marathon-epic.json` (commit `71cfa38`) · **archive:** `m0-archive/run-2026-11-17T09-38-01-888Z-f568a2/` (24.4 MiB) · commitUnderTest `7d0fd8e05936…`
- turnIds: `turn-mwki1qvr-5f40`, `turn-mwkig8gm-08a0`, `turn-mwkipjrf-c8b3`, `turn-mwkiywkc-b954`, `turn-mwkj4ebx-04c8`

| run | verdict | wall s | valid | ticks ok/sus/hard | judge calls | verdicts | alerts | recovered |
|---|---|---|---|---|---|---|---|---|
| 1 | partial | 675.5 | 117/120 | 7/26/0 | 6 | prog×4 + unknown×2 | 0 | 0 |
| 2 | partial | 434.1 | 120/120 | 2/20/0 | 4 | prog×3 + unknown×1 | 0 | 0 |
| 3 | partial | 436.0 | 120/120 | 3/19/0 | 4 | prog×4 | 0 | 0 |
| 4 | pass | 255.8 | 120/120 | 1/12/0 | 2 | prog×2 | 0 | 0 |
| 5 | pass | 339.1 | 120/120 | 2/15/0 | 3 | prog×3 | 0 | 0 |

**Watch gate:** 107 ticks = 15 ok / 92 suspect / 0 hard → **86.0% suspect rate ≤ V0 epic 90.4% reference — PASS** (improved despite NO_EFFECT joining the signal set; the observe/control/act classification excludes read-only activity from no-progress counting). Judge 19 calls, 154,453 in / 3,788 out tokens (separate); 16 progressing + 3 unknown@0; **zero alerts, zero recovered frames**; poller 2,137 samples, 0 open-alert samples. All walls > 4 min (+5 fine>4min windows).

**Completion honesty (scenario-level, not watcher):** 2/5 full PASS. r1: station 2 skipped, stations 3–4 redone, model claimed DONE — checker caught it from server records (121 POSTs, 117 valid); judge read progressing/unknown during the early redo phase (progressing ≠ correct — the known diagnostic limit; redo detection belongs to the checker). r2: 120/120 server-complete in order, but the tracked tab ended on epic-05.html → partial per the frozen final-state contract. r3: 120/120 server-complete, model reloaded epic-120.html at the end and the fixture's reload-reset wiped the accepted view → partial. All five planOutcome reported-complete (model label ≠ verification; ended-incomplete absent on checker partials — recorded as observation, v1 semantics). Cosmetic follow-up: `checkEpic`'s completion reason string still says "station 36" (frozen during acceptance).

## V2 live done-when verdict — **ALL FOUR CRITERIA MET**

| criterion | result |
|---|---|
| false recoveries 0 | ✓ 0 recovered frames across both batches (10 runs); V2 evidence-based recovery refuses no-effect clicks; holdout falseRec boundary case does not reproduce live |
| false alerts 0 worst on healthy | ✓ 0 alerts on epic ×5 (incl. 3 checker partials that were server-progressing); poller 0 open-alert samples across 2,137 + smoke samples |
| caught mean ≥ V0 on past-patience stuck | ✓ stall-r4 caught @109s source 'both' (1/1 live past-patience runs; V0 live was 1/2 with the bounce-r1 unknown miss); r1 looping true positive besides |
| suspect ticks on healthy ≤ V0 | ✓ epic 86.0% ≤ 90.4% (per-run 78.8/90.9/86.4/92.3/88.2%; smoke 94.1% was the high tail) |

**Totals:** 10 runs, 7 checker PASS + 3 honest partials (1 genuine redo/skip, 2 final-state technicalities with 120/120 server records); 2 alerts total, both true positives on genuine inert-control looping; 0 false alerts; 0 false recoveries; judge 22 calls, 171,942 in / 4,335 out tokens separate from agent usage; ended-incomplete fired on all 5 stall BLOCKED ends, absent on help-free clean/partial epic ends per v1 label semantics.

**Provenance:** pin 7d0fd8e05936f5ab6ea55678d118eb31505756b9; overlays from merged main 0dc6af6 byte-identical; gates npm test 1272/1272 + c1 + 6-scenario self-tests before spend; smokes ×1 each passed; detached setsid runner (PID 764359) + per-batch pollers; fresh isolated home; 1017@medium; --marathon arming 10/10 verified; key-scans clean; archives in MAIN m0-archive (28.6 MiB events).
