# V2 live acceptance — progress accounting (stall-loop ×5 + marathon-epic ×5)

**Status:** IN PROGRESS. **Plan:** `MARATHON-V2-PLAN.md` §5 V2 live. **Owner:** eval.
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

## Batch 2 — marathon-epic ×5 (120 stations)

(pending — suspect-rate gate vs V0 epic 90.4% reference; smoke 94.1% with NO_EFFECT in the signal set)
