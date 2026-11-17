# V4 live acceptance — continuation context (stop-then-continue ×5 + unrelated-question ×5 + c1 steer-plan)

**Status:** IN PROGRESS. **Plan:** `MARATHON-V2-PLAN.md` §5 V4 live. **Owner:** eval.
**Pin:** `42f2104aa4420098a8bcb6ffe6ac928303e75e24` (chain: 0c993b1 seed-visible G1 → ab8ad0c carry-chain G2 → 42f2104 replay k=5 no regression). Worktree `/tmp/crazyagent-v4-live`, overlays from merged main `1577210` byte-identical, fresh homes `/tmp/crazyagent-v4-live-eval` + `/tmp/crazyagent-v4-c1-eval` (c1 row own home). Model 1017 @ medium, `--marathon` arming, judge wired.

**Verified at pin before spend:** accepted claim → ONE seeded plan activity `{kind:'plan', revision, items, awaitingUser:false, seeded:true}` (plan-runtime:194), rejected → `plan.seed.rejected` + no activity; carryChain INTERNAL (`CARRY_CHAIN_LIMITS {maxTurns:3, promptChars:500}`, control-char clip, oldest-first slice(-3), push after turn end with plan persisting, clear on drop/off/chat-change, explicitly NOT in `snapshot()` — never published, **judge-digest-only, NOT in the agent prompt**); controller feeds ledger via `noteActivity` + `buildDigest` context `carriedFrom` (ancestors only) + `plan.seededRevision`; ledger `#noteActivity kind:'plan'` sets plan snapshot + open-item trajectory from turn start → openFlat can fire on continuation wander (G1 mechanism).

**Gates:** npm test **1303/1303** + 4-scenario self-tests + c1 --self-test. Smokes: stop-then-continue PASS (t1 20.3s stopped → t2 36.7s, 12/12 exactly-once, seeded=true, nudges 0); unrelated-question PASS (t2 answered 51 in 1.5s, zero browser_plan + zero tool results, not-assessed reason seeded-untouched, seeded=true).

**Binding done-when (lead):** healthy continuations silent worst case (zero alerts) · zero redos 5/5 · seeded-untouched not-assessed 5/5 · c1 steer-plan pass. Any healthy false alert or redo → STOP + report. Continuation-stuck caught is evidence (core's replay-extension simulation measures it in parallel).

**Measurement method:** archive planEvidence/watchEvidence per turn + extended analyzer (`/tmp/v3-revisit-analyze.mjs`): replays DSH tool events through the pin's WatchLedger+assess, feeds `plan.updated` events as ledger plan frames and reconstructs the live-only seeded activity at turn start (plan.mode.started{seeded:true} + prior turn's final plan — faithful to seedPlanState); classifies REVISIT_HINT fires into mutation-revisit / openFlat / other. Validated on V2 continuation turn (seed reconstructed, 0 fires). Redo ground truth: fixture-server records (duplicate step detection), not transcript.

## Live event — run 1 continuation SILENT_STALL (TRUE positive, model variance)

stop-then-continue run 1, continuation turn `turn-mwkpo68u-1c0f`: the model went silent after one early browser command — **0 tool.call / 0 tool.result in the raw log** (cross-checked against ledger events:0 — no ingestion bug; V4 seed-visible did not break the event feed), only assistant planning text. Watcher fired the HARD signal: **SILENT_STALL → alert stuck @139s `source:'both'`** (judge stuck@0.7 then @0.85 corroborating; hard signals alert without the model), reason "No tool calls or page events after 139s; only a planning statement". Lead-confirmed TRUE positive — a **CAUGHT continuation-stuck window** (V4 done-when evidence). Per lead clarification: V4 carryChain/carriedFrom are judge-digest-only and cannot affect the agent prompt — the stall is **MODEL VARIANCE** (pre-existing continuation silence behavior), NOT a V4 regression. Run 1 headed for the 900s t2 watchdog → honest fail/partial record (agent didn't complete; watcher alerted correctly). Recurrence monitored across the ×5.

## Batch 1 — stop-then-continue ×5

(pending)

## Batch 2 — unrelated-question ×5

(pending)

## c1 steer-plan row

(pending)
