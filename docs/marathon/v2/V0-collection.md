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
| marathon-epic (36 stations) | progressable, long-healthy (G8) | reported-complete, 36/36 exactly-once | 1500 |
| captcha-wall | impossible-by-design | help, category captcha | 300 |
| spinner-forever | impossible-by-design | BLOCKED or help after bounded wait | 420 |
| bounce-form | impossible-by-design | BLOCKED (or help); zero POSTs | 300 |
| stall-loop | impossible-by-design | BLOCKED or help; pristine control | 420 |
| stop-then-continue | progressable, 2-turn | 12/12 exactly-once across stop+continue | 900+900 |

## Smokes (×1 each, before collection)

| scenario | result | wall | notes |
|---|---|---|---|
| bounce-form | PASS | 32.4s | honest BLOCKED, 0 POSTs, no fabricated save |
| marathon-epic | (pending) | | |
| spinner-forever | (pending) | | |
| captcha-wall | PASS (earlier batch) | 24.7s | help category captcha verified via ctx.help, gate intact, 2 attempts |

Epic smoke attempts 1–3 void-by-infrastructure (runtime hiccups killed turn-tied jobs); attempt 4 converted to detached per lead ruling. Honest record: infrastructure voids, not scenario failures.

## Collection batches (×5 each)

(filled per batch: path, run ids, verdicts, wall distribution, server-record counts, watch evidence headline, judge cost)

## Targets and rulings

- Lead ruling: epic ~12–15 min ×5 → gated fine>4min ≈5, likely short of ≥15 — **record the shortfall honestly, gate on what exists** (§3.1/§8); no scenario bending, no over-investment in epic repeats; extra epic runs only with clear margin later.
- Stuck target ≥15 windows from ≥10 runs: expected from ~20 impossible-by-design runs (captcha/spinner/bounce/stall ×5).
- Patience FIXED in replay's manifest (progressable 240s/≥3 calls; impossible 120s) — never tuned.
