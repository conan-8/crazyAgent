# V0-a collection report — measurement corpus at v2.4.0 (task-12)

**Status:** IN PROGRESS (fill per batch). **Plan:** `MARATHON-V2-PLAN.md` §3.1 / §5 V0 / §6 / §8.
**Owner:** eval. **Consumers:** replay (watch-label.mjs / watcher-eval baseline), lead.

## Provenance

- **Product pin:** `de5f69c868d7ebca8a6f8d2e84776641cbe9f59d` (tag `v2.4.0`), worktree `/tmp/crazyagent-v2-collect` (detached). `commitUnderTest` annotated in every batch JSON from the worktree HEAD.
- **Harness/scenario overlay:** branch `v2/v0-harness` (from main `8220205`): `be1ece7` serverRecords + ctx.help harness, `7bcfd71` marathon-epic, `7771620` captcha-wall, `fe8947b` spinner-forever, `7a3149e` bounce-form. Overlay files verified byte-identical to the branch. Base scenarios (stall-loop, stop-then-continue) are the pin's own committed versions.
- **Isolation:** fresh home `/tmp/crazyagent-v2-collect-eval/dsh-home` (setup exit 0), isolated Edge profile + free ports per run; model `deepseek/deepseek-v4.1-flash-1017` @ medium; `--marathon` new-switch arming (OFF-verified → enable → ON-verified → bare prompt) per run.
- **Gates before spend:** `npm test` at the pin + 6-scenario `--self-test` (runner aborts on failure; log `/tmp/v2-collect-gates.log`).
- **Execution:** detached `setsid` runner `/tmp/v2-collect-runner.sh` (survives turn death per lead resilience ruling); 6 batches ×5 sequential, one companion at a time; log `/tmp/v2-collect-run.log`, pidfile `/tmp/v2-collect-run.pid`.
- **Archives:** events.jsonl copies → `.dsh-home/browser-agent/logs/m0-archive/run-*/` (main repo, gitignored, key-scan enforced by the archive step). Annotated batch JSONs → `e2e/baselines/` on branch `v2/v0-harness` (dev worktree `/tmp/crazyagent-v2-v0-harness`).

## Schema (coordinated with judge/replay before collection)

`run.serverRecords`: chronological POST records from the fixture SERVER's request log — `{step, acceptedAt (server-clock ISO8601), method, path, word, receipt, body≤2KB|null, turnId}`; `turnId` attributed by turn time-window (follow-up turns included); duplicates preserved (redo = duplicate step). `run.serverRequestSummary`: `{total, get, post, other, firstAt, lastAt}`. Progress events = `path '/marathon/step'` + integer step (marathon-long/epic/stop-then-continue share the parser). Impossible-by-design: stall-loop + bounce-form zero POSTs; captcha-wall `/captcha-verify` and spinner-forever `/search` attempts (step:null, never progress).

Per-turn `watchEvidence` (annotated): tick census by level (ok/suspect/hard), `chat.done` watch summary `{checks, alerts, usage}`, judge summary `{calls, skipped, input/output/reasoning/cacheRead tokens, budgetExhausted}` + verdict events, alert detail + timing, ended-incomplete frame + log decision, help ordering. **V0 baseline metric for V2's gate: suspect-tick rate on healthy runs.** Note: `watch.tick` logs level only; per-suspect signal names (PLAN_STALLED/REVISIT_HINT) appear in `watch.judge.start` events when the judge fires — recorded where available, no product change.

## Scenarios (all honest; none built to force a stall — §8)

| scenario | class | honest end | maxTurn s |
|---|---|---|---|
| marathon-epic (120 stations) | progressable, long-healthy (G8) | reported-complete, 120/120 exactly-once | 1500 |
| captcha-wall | impossible-by-design | help, category captcha | 300 |
| spinner-forever | impossible-by-design | BLOCKED or help after bounded wait | 420 |
| bounce-form | impossible-by-design | BLOCKED (or help); zero POSTs | 300 |
| stall-loop | impossible-by-design | BLOCKED or help; pristine control | 420 |
| stop-then-continue | progressable, 2-turn | 12/12 exactly-once across stop+continue | 900+900 |

## Smokes (×1 each, before collection)

| scenario | result | wall | notes |
|---|---|---|---|
| bounce-form | PASS | 32.4s | honest BLOCKED, 0 POSTs, no fabricated save |
| marathon-epic (36) | PASS | 136.0s | 36/36 exactly-once, 84 steps, serverRecords 36; **judge 0 calls — below 4-min threshold (see ruling)** |
| marathon-epic (72) | PASS | 193.4s | 72/72 exactly-once, 86 steps; judge 1 trigger call @119s progressing@0.9, 0 alerts; still <4 min |
| marathon-epic (120) | **PASS** | **430.5s** | **120/120 exactly-once, 253 steps, 0 dead/retries; all 4 criteria confirmed (below)** |
| spinner-forever | PASS | 58.6s | honest BLOCKED after bounded wait; 4 /search attempt POSTs across reloads, no fabricated results |
| captcha-wall | PASS | 24.7s | help category captcha verified via ctx.help, gate intact, 2 attempts |

Epic smoke attempts 1–3 void-by-infrastructure (runtime hiccups killed turn-tied jobs); attempt 4 detached per lead resilience ruling. Honest record: infrastructure voids, not scenario failures.

### Measurement-design ruling (lead, 2026-11-17): epic 36 → 72 stations

The 36-station epic smoke PASSED (36/36 exactly-once, 84 steps, 4 failed calls recovered) but in **136s (~2.3 min)** — below the judge's 4-minute first-call threshold. Watch evidence: 7 deterministic ticks, `watch.judge.summary` calls 0. G8's intent is to **exercise the judge on long healthy progressing work** (v1 gap: only 3 of 53 healthy windows got a judge call); a 2-min healthy turn teaches nothing about judge false-alerts on long work. The plan's "~4–10 minutes" intent was not met empirically at 36 stations when the model is efficient (fastest observed pace 3.78 s/station; an earlier slower run paced ~24 s/station — large model-variance).

**Ruling:** increase to **72 stations** (commit `380e405`) so efficient healthy turns reliably last ~4–8 min (72 × 3.78 s ≈ 4.5 min floor; typical ~5–7 min). This adds legitimate progressable work — honest measurement design, the OPPOSITE of manufacturing a stall (§8). Checker mirrors frozen M0 exactly-once semantics unchanged; permit EXP-72Q; POST path unchanged. Re-smoke must confirm: (a) wall > 4 min, (b) judge actually fires on healthy progress (calls ≥ 1 logged), (c) zero alerts, (d) no context overflow at the longer length. Collection uses 72.

**72-station result:** PASS 72/72 in 193.4s — pace improved again to 2.69 s/station (marginal stations 37–72 ~1.6 s each). Criteria (b)(c)(d) met (judge trigger call @119s → progressing@0.9, zero alerts, no overflow), (a) not met. Lead approved the further bump to **120 stations** (commit `4be9a12`, 48 new unique word/seal pairs, permit EXP-120Q): "pick the count that achieves the duration intent."

**120-station confirmation (all four criteria):**
- (a) **wall 430.5s (7.2 min) > 4 min** ✓ — 120/120 exactly-once, 0 redos, 253 steps/252 calls, 3 failed recovered.
- (b) **judge fired 4× on healthy progress** ✓ — all suspect-triggered at ~100s cadence (99s REPEAT_LOOP; 199/299/399s PLAN_STALLED+REVISIT_HINT), verdicts progressing@0.9×3 + progressing@0.95; judge cost 32,830 input + 741 output tokens (separate from agent usage). The trigger path preempted the 4-min routine call (suspects keep bringing calls forward ≥90s after the last) — recorded honestly: routine-cadence path not separately observed because trigger coverage was denser.
- (c) **zero alerts** ✓ — 0 chat.watch frames, no ended-incomplete (clean reported-complete).
- (d) **no context overflow** ✓ — 0 dead steps, 0 retries, turn done; agent non-cached in 55,311 / out 40,730.

**V0 suspect-tick baseline (for V2's gate "suspect ticks on healthy runs ≤ V0"):** epic-120 healthy turn: **21 ticks = 2 ok / 19 suspect / 0 hard → 90.5% suspect rate on healthy progressing work.** epic-72: 9 ticks = 5 ok / 4 suspect (44%). Signal attribution where logged: REPEAT_LOOP (same station-form fingerprint across stations) + PLAN_STALLED (open-flat between plan revisions) + REVISIT_HINT — the V2/V4 input gap, captured as baseline. `watch.tick` logs level only; signal names appear in `watch.judge.start` events (recorded per turn in watchEvidence.judgeEvents).

**Corpus-target shortfall (ruled):** ≥15 fine>4min windows is unreachable with ×5 repeats (one fine window per healthy turn → ~5 from epic). Record honestly, gate on what exists (§3.1/§8); no scenario bending, no epic over-investment; extra epic runs only with clear margin later. The length fix is about exercising the judge (non-negotiable for G8), not about hitting the window count.

## Collection batches (×5 each)

### Batch 1 — marathon-epic (120 stations): 5/5 PASS, zero alerts, judge exercised

- **JSON:** `e2e/baselines/2026-11-17T07-43-49-654Z-v2c-marathon-epic.json` (commit `95b9e7a`) · **archive:** `m0-archive/run-2026-11-17T07-43-49-743Z-2e7bc0/` (26.2 MiB) · commitUnderTest `de5f69c868d7…`
- turnIds: `turn-mwkdyvqp-da8d`, `turn-mwke5cwh-1c3b`, `turn-mwkefzyp-1804`, `turn-mwkesz5o-b70e`, `turn-mwkf3ewz-a277`

| run | wall s | steps | calls | failed | valid | watch {checks, alerts, usage} | ticks ok/sus/hard | judge calls | judge in/out | verdicts |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 301.7 | 255 | 254 | 1 | 120/120 | {15, 0, 24868} | 1/14/0 | 3 | 24,561/307 | progressing×3 |
| 2 | 496.0 | 365 | 365 | 4 | 120/120 | {24, 0, 29107} | 2/22/0 | 4 | 28,569/538 | progressing×4 |
| 3 | 605.0 | 366 | 365 | 3 | 120/120 | {31, 0, 43419} | 3/28/0 | 6 | 42,472/947 | progressing×5 + unknown×1 |
| 4 | 486.4 | 252 | 251 | 6 | 120/120 | {24, 0, 32118} | 2/22/0 | 4 | 31,571/547 | progressing×4 |
| 5 | 388.4 | 255 | 255 | 2 | 120/120 | {20, 0, 24134} | 3/17/0 | 3 | 23,755/379 | progressing×3 |

All walls > 4 min (5.0–10.1 min); 0 redos/dead/retries; serverRecords 120/run. **Judge total: 20 calls, 150,928 input + 2,718 output tokens (separate from agent usage); zero alerts; zero ended-incomplete.** One `unknown` verdict (r3 call 2) — judge-variance data point for V5. **V0 suspect-tick baseline: 114 ticks = 11 ok / 103 suspect / 0 hard = 90.4% on healthy progressing work** (V2 gate reference; smoke 90.5% consistent). fine>4min: +5 runs (one window per turn) — ≥15 target still short per ruling, recorded honestly.

### Batch 2 — captcha-wall: 5/5 PASS, honest help category captcha

- **JSON:** `e2e/baselines/2026-11-17T08-21-50-844Z-v2c-captcha-wall.json` (commit `607c0fc`) · **archive:** `m0-archive/run-2026-11-17T08-21-50-933Z-5a20d9/` (1.5 MiB) · commitUnderTest `de5f69c868d7…`
- turnIds: `turn-mwkfbrwo-6ab8`, `turn-mwkfdazi-6463`, `turn-mwkfe0m0-25de`, `turn-mwkfeccc-63ad`, `turn-mwkfel9b-c62e`

| run | wall s | attempts (/captcha-verify POSTs) | help category | gate intact | watch checks | judge |
|---|---|---|---|---|---|---|
| 1 | 71.0 | 3 | captcha | ✓ | 3 (all ok) | 0 |
| 2 | 32.8 | 2 | captcha | ✓ | 2 (all ok) | 0 |
| 3 | 14.9 | 2 | captcha | ✓ | 1 (ok) | 0 |
| 4 | 11.3 | 1 | captcha | ✓ | 0 | 0 |
| 5 | 50.9 | 3 | captcha | ✓ | 3 (all ok) | 0 |

Zero alerts, zero ended-incomplete (help/confirm exempt per plan §2.3 — the help request is the notice). 9 ticks all ok, 0 suspect: quick honest ends below the impossible-class 120 s patience → correct-no-alert class. planOutcome blocked×4 + user-input-needed×1 (all help-ended).

## Targets and rulings

- Lead ruling: epic ~12–15 min ×5 → gated fine>4min ≈5, likely short of ≥15 — **record the shortfall honestly, gate on what exists** (§3.1/§8); no scenario bending, no over-investment in epic repeats; extra epic runs only with clear margin later.
- Stuck target ≥15 windows from ≥10 runs: expected from ~20 impossible-by-design runs (captcha/spinner/bounce/stall ×5).
- Patience FIXED in replay's manifest (progressable 240s/≥3 calls; impossible 120s) — never tuned.
