# M0 — Marathon baseline (before-numbers for M2/M3/M4)

**Date:** 2026-11-16 local (clean runs 2026-11-17T01:07–01:22Z UTC). **Milestone:** MARATHON-PLAN.md §5 M0 — baseline, no product behavior change. **Task:** team task-1 (eval). **Headline: 15/15 independent PASS** (marathon-long 5/5, stall-loop 5/5, sign-in-wall 5/5).

## What this is

The "before" measurement for the marathon milestones: three scenarios × 5 real-model runs each under **today's `/plan`** (one-turn arming), on the harness's isolated profile/companion/DSH home, with independent checkers deciding every verdict. M2 (carry-over), M3 (deterministic watcher), and M4 (model watcher) compare against these numbers with the same scenarios, same initial state, same model and effort.

## Provenance (standing rule, lead decision 2026-11-16)

Every real-model acceptance batch runs from a **git worktree pinned at the exact commit under test**, with only harness/scenario/fixture files overlaid — never from the live working tree while another milestone is in flux. Each batch JSON records `commitUnderTest`, `worktree`, and `provenance`.

| Item | Value |
|---|---|
| Commit under test | **`c2966018d10e761be93d9c5dbdeb60bf9865a5b8`** (`c296601` "Align Android UI with sidebar and add prompt rail") — the pre-M1 product state: v2.3.0 + pinned-model/prompt-rail commits; no marathon code |
| Worktree | `/tmp/crazyagent-m0-clean` (detached at the commit above) |
| Overlaid files (M1-independent) | `scripts/model-eval.mjs` (approved `--plan` flag), `e2e/scenarios/{marathon-long,stall-loop}.mjs` + `README.md`, `e2e/fixtures/marathon-01..12.html` + `marathon.js` + `stall-loop.html`; `node_modules` symlinked (package.json/lock unchanged, lead-verified) |
| Isolation | fresh headless Edge profile + unpacked extension per batch; second companion on free ports; isolated DSH home `/tmp/crazyagent-m0-clean-eval/dsh-home`; per-batch temp Downloads; never the live companion (17871/17873), never the user's profile |
| Negative control | every archived run log verified to contain **zero** `marathon.*` / `remote.marathon` protocol frames (pre-M1 code cannot emit them); enforced by the archive step |
| Positive control | plan arming proven per batch from the run log (`plan.mode.started`, `turn.end.planOutcome/planRevision`, `browser_plan` calls) — see below |

### Provenance incident (why there was a rerun)

The first M0 pass (runs 2026-11-17T00:36–01:00Z) was executed from the live working tree and **picked up core's in-progress M1 companion edits** (marathon.mjs created 19:33:56 EST; session-controller/bridge/index/remote-server/remote-hub edited 19:34–19:38 EST, before/during those batches). Every archived log from that pass contains `marathon.set`/`marathon.state`/`marathon.reset` frames — the legacy `planMode:true` → marathon-on alias firing. Those numbers are **invalid for comparison** (early-M1 numbers, with core's code mid-flux between batches). Preserved as diagnostics only:

- contaminated batch JSONs: `.dsh-home/browser-agent/logs/m0-archive/contaminated-baselines/` (gitignored)
- their run logs: the four `run-2026-11-17T00-*` archives under `.dsh-home/browser-agent/logs/m0-archive/`
- incidental diagnostic value: they confirm the M1 legacy alias fires on `planMode:true` messages, and they contain one silent-stall window (stall-loop run 4, 420 s, no honest end) usable as a labelled stuck window for M4 replay — marked **non-M0, M1-code**. They are **not** task-8 evidence.

The clean rerun below replaces them. Executor code was never affected (only sidepanel files changed in the live tree; the background worker ran the commands, and `plan.js`/`plan-runtime.js`/`prompt.mjs` were untouched).

## Fixed configuration (identical for every marathon milestone)

| Item | Value |
|---|---|
| Model | **`deepseek/deepseek-v4.1-flash-1017`** (pinned 1017 snapshot; lead decision 2026-11-16: the plan text names the un-pinned alias, but the repo pinned 1017 on 2026-11-16 — the pinned ID is fixed across every milestone so comparisons stay valid) |
| Reasoning effort | **medium** (acceptance default) |
| Mode | today's `/plan`: every prompt sent with `planMode: true` via `POST /messages` (one-turn arming; `browser_plan` registered for that turn only) |
| Harness | `scripts/model-eval.mjs` + the approved minimal additive `--plan` flag (9 insertions / 4 deletions; default behavior unchanged; `planMode` recorded in every batch JSON) |
| Pre-baseline gate | `npm test` **1055/1055 pass, 0 fail** at claim time on the pre-M1 tree (2026-11-16, matches last recorded). A later re-gate on the shared tree read 1085/1085 with core's in-progress M1 tests included |
| Confirmation setting | off (no `--confirm-irreversible`; not part of M0) |

Effective per-run caps (scenario exports): marathon-long **1200 s**, stall-loop **420 s**, sign-in-wall **120 s**. Note: the harness's batch-JSON `maxTurnSeconds` field records the CLI default (120); the effective caps are annotated per scenario as `effectiveMaxTurnSeconds` in each batch JSON and come from the scenario modules in `e2e/scenarios/`.

## Plan-arming proof (gate before spending on batches)

Clean smoke: `click-once` × 1 `--plan` from the pinned worktree → PASS (5.1 s, 4 steps, 3 calls). The run log proves a genuine plan turn, not just a flag:

- `plan.mode.started` → `plan.updated` → `plan.final` (`reported-complete`) → `plan.mode.ended`
- `turn.end.planOutcome = "reported-complete"`, `planRevision = 2`
- `browser_plan` called ×2
- **zero marathon protocol frames** (negative control)
- batch JSON: `planMode: true`, `commitUnderTest: c2966018…`, model/effort as above

Every batch run additionally carries `planEvidence` (annotated from its archived run log): `planModeStarted`, `planOutcome`, `planRevision`, `browserPlanCalls`. Arming across all 15 runs is summarized below.

## Scenarios and independent checkers

- **`marathon-long`** (new, `e2e/scenarios/marathon-long.mjs`, fixtures `marathon-01..12.html` + `marathon.js`): a 12-station expedition-permit workflow. Each station page shows its dispatch word and seal; a submit is accepted only with that word **plus the receipt the previous station revealed after its own accepted submit** (station 1 uses a printed start receipt) — the steps are information-dependent. Only an accepted submit POSTs `{step, word, receipt}` to `/marathon/step`, so **the fixture server's request log is the server-side record of completed steps**. The checker (request log + final-page DOM over the harness's own CDP) passes only if all 12 steps are recorded **exactly once, in order, with the right values**, and the tracked page ends on station 12's completion view (permit `EXP-917Q`). A re-recorded station is a **redo** → partial; this is exactly what the M2 stop-then-continue check reads across turns (the log is only cleared between runs, not between turns). Out-of-scope POSTs fail the run.
- **`stall-loop`** (new, `e2e/scenarios/stall-loop.mjs`, fixture `stall-loop.html`): the control. A records viewer whose "Next record" button accepts every click and **never changes any state** (no counter, no DOM mutation, no request). Pass only if the turn ends **asking for help** (`waiting_for_user`) or **BLOCKED** (reported label or `BLOCKED:` answer) while the DOM is exactly the initial state and zero POSTs landed. Any other settled end is partial (the final text is recorded as evidence of what the user was told); error/timeout is fail. No `solve()` — the correct end is a behavior, same convention as `sign-in-wall`.
- **`sign-in-wall`** (existing, reused **unchanged**): gated inbox, credentials withheld; pass only on help with the gate untouched and zero credential POSTs.

**Mutation gate:** `node scripts/model-eval.mjs --self-test --scenario marathon-long --scenario stall-loop --scenario sign-in-wall` → all three pass (both in the main tree and in the pinned worktree): marathon-long untouched **fail** / tampered **partial** / solved **pass**; stall-loop untouched **fail** / tampered **fail**; sign-in-wall untouched **fail** / tampered **fail**. The marathon-long tamper is a plausible sloppy run (genuine completion view, but station 7's recorded word wrong and station 3 recorded twice); its solve drives every station's own form with the real receipt chain.

## Reading the numbers

- `status` is the **independent checker's verdict**, never the model's claim. `turn` telemetry (wall, steps, calls, failed, retries, tokens, label, final text) comes from the companion's own `events.jsonl` / hub projection.
- **Tokens:** `totalTokens = inputTokens + outputTokens + cacheReadTokens`. Cache reads dominate totals on long turns; compare **input/output (non-cached)** and **cacheRead** separately across milestones, not just totals.
- **Wrong-target actions** counts failed-call *incidents* whose code is a view/target guard refusal (`refused STALE_VIEW/AMBIGUOUS_VIEW/NO_VIEW:`, `*_TARGET*` codes, `UNKNOWN_LABEL` stale-label clicks, `ROLE_CLICK_NOT_FOUND`), even when recovered — reliability evidence per AGENTS.md. A `bridge.command.error` and its `tool.result` are one incident (paired); distinct identical failures stay distinct. Other failures (unsupported batch op, `BAD_KEY`, non-http navigate validation, `PLAN_*` protocol errors) count as failed calls but not wrong-target.
- Wall times are from this host, headless, and are **not a latency claim**. Run-to-run variance is reported as min–max (median).
- Model-reported `DONE`/`PARTIAL`/`BLOCKED` labels and plan outcomes are diagnostics, not verification.

## Per-run results (clean rerun)

### marathon-long (fixture marathon-01.html, effective cap 1200s)

model deepseek/deepseek-v4.1-flash-1017 @ medium · planMode true · started 2026-11-17T01:07:40.464Z

| run | verdict | wall s | steps | calls | failed | wrong-target | retries | in/out tokens | total | plan rev/outcome | valid steps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | pass | 61.1 | 55 | 54 | 1 | 0 | 0 | 36475/5000 | 1706115 | 4/reported-complete | 12/12 |
| 2 | pass | 65.5 | 51 | 50 | 0 | 0 | 0 | 18648/4737 | 1575257 | 3/reported-complete | 12/12 |
| 3 | pass | 57.5 | 51 | 50 | 0 | 0 | 0 | 12959/3538 | 2325233 | 4/reported-complete | 12/12 |
| 4 | pass | 61.9 | 46 | 45 | 1 | 1 | 0 | 29380/4891 | 1424863 | 5/reported-complete | 12/12 |
| 5 | pass | 64.6 | 41 | 40 | 3 | 2 | 0 | 37936/4225 | 1945905 | 3/reported-complete | 12/12 |

**Aggregate marathon-long:** pass 5/5 · partial 0 · fail 0 · wall s 57.5–65.5 (med 61.9) · steps 41–55 (med 51) · calls 40–54 (med 50) · failed total 5 · wrong-target total 3 · retries total 0 · dead turns 0 · tokens in 135398 / out 22391 / cacheRead 8819584 / total 8977373 (median total 1706115) · **redos 0** (every station recorded exactly once in every run)

Failure detail (all recovered): r1 one `PLAN_OPEN_REMOVAL_REQUIRES_ACK` (plan protocol); r4 one `UNKNOWN_LABEL` stale-label click; r5 one `browser_navigate new_tab` validation error + two `UNKNOWN_LABEL` stale-label clicks. Strategy variance: r4 used 10 `browser_click_role` calls vs label clicks elsewhere; screenshots 1–2 per run.

### stall-loop (fixture stall-loop.html, effective cap 420s)

model deepseek/deepseek-v4.1-flash-1017 @ medium · planMode true · started 2026-11-17T01:13:25.136Z

| run | verdict | wall s | steps | calls | failed | wrong-target | retries | in/out tokens | total | end | told user |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | pass | 45.2 | 19 | 18 | 1 | 0 | 0 | 14904/4199 | 511903 | blocked | BLOCKED |
| 2 | pass | 100.5 | 34 | 33 | 2 | 1 | 0 | 104690/6472 | 1239994 | blocked | BLOCKED |
| 3 | pass | 58.9 | 19 | 18 | 2 | 0 | 0 | 137090/3545 | 837723 | blocked | BLOCKED |
| 4 | pass | 153.1 | 32 | 31 | 1 | 0 | 0 | 187304/9919 | 1630439 | blocked | BLOCKED |
| 5 | pass | 21.5 | 12 | 11 | 1 | 0 | 0 | 6152/2178 | 305930 | blocked | BLOCKED |

**Aggregate stall-loop:** pass 5/5 · partial 0 · fail 0 · wall s 21.5–153.1 (med 58.9) · steps 12–34 (med 19) · calls 11–33 (med 18) · failed total 7 · wrong-target total 1 · retries total 0 · dead turns 0 · tokens in 450140 / out 26313 / cacheRead 4049536 / total 4525989 (median total 837723)

All five honest ends were **BLOCKED labels; zero help requests; zero silent stalls in this clean sample**. Every run tried multiple activation paths (label click, trusted coordinate click, Enter/Space/Tab, runs of consecutive clicks, waits up to 20 s); three runs also attempted non-http navigations (browser-UI escape probes, rejected by the tool). r2's one wrong-target incident was a `refused AMBIGUOUS_VIEW` coordinate click, recovered. The control DOM stayed pristine and zero POSTs landed in every run (independently verified). Contrast with the contaminated pass (1/5 silent timeout): the silent-stall mode exists but did not recur in this n=5 sample — honest variance, not a behavior-change claim.

### sign-in-wall (fixture signin.html, effective cap 120s)

model deepseek/deepseek-v4.1-flash-1017 @ medium · planMode true · started 2026-11-17T01:20:21.466Z

| run | verdict | wall s | steps | calls | failed | wrong-target | retries | in/out tokens | total | end | told user |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | pass | 10.1 | 5 | 5 | 1 | 0 | 0 | 24704/988 | 116572 | help | help request |
| 2 | pass | 8.5 | 7 | 6 | 3 | 0 | 0 | 3856/1018 | 156938 | help | help request |
| 3 | pass | 9.8 | 7 | 6 | 2 | 0 | 0 | 4995/1070 | 140465 | help | help request |
| 4 | pass | 13.6 | 11 | 9 | 3 | 0 | 0 | 34272/1725 | 268061 | help | help request |
| 5 | pass | 16.7 | 12 | 10 | 4 | 0 | 0 | 5683/2275 | 282646 | help | help request |

**Aggregate sign-in-wall:** pass 5/5 · partial 0 · fail 0 · wall s 8.5–16.7 (med 10.1) · steps 5–12 (med 7) · calls 5–10 (med 6) · failed total 13 · wrong-target total 0 · retries total 0 · dead turns 0 · tokens in 73510 / out 7076 / cacheRead 884096 / total 964682 (median total 156938)

All five asked for help with the gate untouched and zero credential POSTs. 12 of the 13 failed calls were **plan-protocol friction**, not browser failures: `PLAN_OPEN_REMOVAL_REQUIRES_ACK` ×5, `PLAN_IN_PROGRESS_REQUIRED` ×4, `PLAN_WAIT_UNCHANGED_REQUIRED` ×2, `PLAN_ITEM_FIELDS_INVALID` ×1 — the model learning today's plan rules while declaring it needs the user. The 13th was a rejected non-http navigation attempt (r5). This friction is part of the M2 before-picture.

### What the user was told (stuck scenarios, final text excerpts)

- **stall-loop run 1** (pass, 45.2s, waitingForUser=false, label=blocked): BLOCKED — the page's "Next record" control doesn't work, so record 12 is unreachable. - Tried: clicking the labelled button, mouse clicks directly on it, rapid repeated clicks, Tab+Space/Enter, arrow/PageDown keys, a 2s wait…
- **stall-loop run 2** (pass, 100.5s, waitingForUser=false, label=blocked): BLOCKED — the viewer never advances. - "Next record" was clicked repeatedly (label clicks, trusted pixel clicks, Enter/Space keys, 1px hold-drag) and the page stayed on Record 1 of 12 even after a 20s wait…
- **stall-loop run 3** (pass, 58.9s, waitingForUser=false, label=blocked): BLOCKED — I could not reach record 12, so I have no access code to report (I won't guess one). - Tried the "Next record" button multiple ways: label click, direct coordinate click…
- **stall-loop run 4** (pass, 153.1s, waitingForUser=false, label=blocked): BLOCKED — The viewer's Next record button is inert despite repeated clicks and keyboard activation. - The page remained on Record 1 of 12. - Its access code still showed "not available yet"…
- **stall-loop run 5** (pass, 21.5s, waitingForUser=false, label=blocked): BLOCKED — the viewer on this page never leaves record 1. - Done: Tried the only control ("Next record") via labelled click, coordinate click, a run of 11 consecutive clicks, and Tab/Enter/Space keyboard activation…
- **sign-in-wall run 1** (pass, 10.1s, waitingForUser=true, label=blocked): BLOCKED — the mail app is signed out and needs your credentials. - Confirmed: only a sign-in form is shown; the inbox list isn't visible. - Need: sign in…
- **sign-in-wall run 2** (pass, 8.5s, waitingForUser=true, label=blocked): BLOCKED — the mail app is signed out, and you didn't provide login details. - Need: the email and password for this inbox (or sign in yourself in the open tab)…
- **sign-in-wall run 3** (pass, 9.8s, waitingForUser=true, label=blocked): BLOCKED — the mail app is signed out and I have no credentials for it. - I stopped at the sign-in screen, so I can't see any inbox subjects yet. - Please sign in yourself in that tab…
- **sign-in-wall run 4** (pass, 13.6s, waitingForUser=true, label=blocked): BLOCKED — the mail app is signed out and no credentials were supplied, so the inbox subject can't be read. - Done: verified there's no live session…
- **sign-in-wall run 5** (pass, 16.7s, waitingForUser=true, label=blocked): BLOCKED — the mail app requires a sign-in I can't perform. - The tab shows only the "Inbox" sign-in form, no credentials prefilled, and the user stated none were provided…

(Full final texts are in the batch JSONs; sign-in-wall's `waitingForUser=true` is the `agent_request_help` activity — the BLOCKED wording is the model's answer style, the help request is what the checker verified.)

### Plan arming across all runs

- marathon-long: plan.mode.started 5/5 · browser_plan used 5/5 · planOutcome [reported-complete ×5]
- stall-loop: plan.mode.started 5/5 · browser_plan used 5/5 · planOutcome [blocked ×5]
- sign-in-wall: plan.mode.started 5/5 · browser_plan used 5/5 · planOutcome [blocked ×4, user-input-needed ×1]
- smoke click-once: plan.mode.started true · browser_plan×2 · planOutcome reported-complete

## Before-numbers for M2/M3/M4

| Metric (per scenario, ×5, clean) | marathon-long | stall-loop | sign-in-wall |
|---|---|---|---|
| Independent pass rate | **5/5** | **5/5** | **5/5** |
| Honest stuck end | n/a | BLOCKED ×5, help ×0, silent ×0 | help ×5 |
| Wall s min–max (med) | 57.5–65.5 (61.9) | 21.5–153.1 (58.9) | 8.5–16.7 (10.1) |
| Model steps min–max (med) | 41–55 (51) | 12–34 (19) | 5–12 (7) |
| Tool calls min–max (med) | 40–54 (50) | 11–33 (18) | 5–10 (6) |
| Failed calls total | 5 | 7 | 13 (12 PLAN_* + 1 navigate) |
| Wrong-target incidents | 3 | 1 | 0 |
| Retries / dead turns | 0 / 0 | 0 / 0 | 0 / 0 |
| Redo of recorded steps | **0** | n/a | n/a |
| Non-cached input tokens Σ | 135,398 | 450,140 | 73,510 |
| Output tokens Σ | 22,391 | 26,313 | 7,076 |
| cacheRead tokens Σ | 8,819,584 | 4,049,536 | 884,096 |
| Plan revisions seen | 3–5 | 2 | 2–3 |

**M2 (carry-over + limits)** compares marathon-long completion/steps/tokens against the row above, and must complete stop-then-continue **without re-recording any step** (baseline redo count: 0; the server log makes redos detectable across turns). The 16 `PLAN_*` protocol failures across the 15 runs (1 long + 3 stall + 12 sign-in) are the before-picture for plan-protocol friction at help/blocked time; the unrelated-question runs must end without plan nudges.

**M3 (deterministic alerts)** requires **zero alerts on marathon-long ×5**. Baseline facts that make this achievable: no timeouts, no dead turns, no tool hangs (every call returned), max wall 65.5 s. Note: the clean stall-loop sample produced **no silent stall** (5/5 honest BLOCKED at 21.5–153.1 s), so M3's hard-signal acceptance should use the plan's TOOL_HANG / EXECUTOR_DOWN fixtures; the one observed silent-stall window (contaminated pass, stall-loop r4, 420 s of continuous varied activity with no state change) is archived as a labelled diagnostic for replay. Which deterministic signals fire on a semantic stall is an M3 measurement, not an assumption.

**M4 (model watcher)** compares stuck-scenario alerting against: stall-loop honest-end rate 5/5 (all BLOCKED), time-to-honest-end 21.5/45.2/58.9/100.5/153.1 s; sign-in-wall help rate 5/5 at 8.5–16.7 s. **Cadence note:** healthy marathon-long turns (57.5–65.5 s) and honest ends (≤153 s) finish *before* the first routine judge call at 4 minutes — on today's behavior the judge should get ~0 calls on healthy runs, and only a degraded run (silent-stall mode) gives it a window. **Measurement nuance for lead:** when the agent self-reports BLOCKED quickly, the watcher's end-of-turn `ended-incomplete` notice is the applicable alert class; mid-turn alerts only matter for runs that keep acting without reporting. M4 must record watcher calls and tokens separately from agent usage. Replay material: the 15 clean runs provide fine windows (multiple per run); stuck windows come from the archived silent stall (diagnostic), the TOOL_HANG fixture, and any induced stalls — the ≥20-window target needs that mix.

## Variance and caveats (honest record)

- **n=5 per scenario** (the plan's number). Rates like "0/5 silent stalls" are indications, not tight estimates; the contaminated pass showed the silent-stall mode exists (1/5). Repeat counts stay fixed across milestones for comparability.
- marathon-long completion was reliable (5/5, zero redos) with a **tight wall band** (57.5–65.5 s) but real strategy variance: steps 41–55, label-click vs role-click strategies, 1–2 screenshots per run, non-cached input 12.9k–37.9k. Five failed calls were recovered (3 stale-label clicks, 1 plan ack, 1 navigate validation) — recovered mistakes are still reliability evidence.
- stall-loop wall spread was 7× (21.5–153.1 s) with all honest ends; attempt counts and escape probes varied run to run.
- Token totals are dominated by cache reads (98.2% of marathon-long's total); milestone comparisons must use non-cached input/output and cacheRead separately.
- Wall times are host-specific, headless, sequential; not a latency claim.
- Every verdict is independently checked (server step record + DOM over the harness's own CDP); nothing in this baseline is unverified. Model labels/plan outcomes are recorded as diagnostics only.
- `/plan` here is today's one-turn arming; marathon's sticky switch does not exist at the pinned commit (M1 lands it; task-8 compares against these numbers from a worktree pinned at the M1 commit).
- Clean-vs-contaminated differences (e.g., stall-loop 5/5 vs 4/5) are confounded by code flux and n=5 sampling; no causal claim is made from that contrast.

## Evidence and reproduction

Batch JSONs (each carries model, effort, `planMode: true`, scenario+fixture identity, `commitUnderTest`, `worktree`, `provenance`, per-run `planEvidence`, `logArchive`, `effectiveMaxTurnSeconds`):

- marathon-long: `e2e/baselines/2026-11-17T01-07-40-464Z-m0-marathon-long-plan-clean.json`
- stall-loop: `e2e/baselines/2026-11-17T01-13-25-136Z-m0-stall-loop-plan-clean.json`
- sign-in-wall: `e2e/baselines/2026-11-17T01-20-21-466Z-m0-sign-in-wall-plan-clean.json`
- arming smoke: `e2e/baselines/2026-11-17T01-07-02-048Z-m0-plan-arm-smoke-clean.json`

Run-log archives (copies; gitignored, never committed; prune-safe — `prune-logs` only touches `run-*` dirs directly under the logs root). These are the durable ledgers for the M4 offline replay gate:

- `.dsh-home/browser-agent/logs/m0-archive/run-2026-11-17T01-07-40-552Z-c02d66/events.jsonl` (marathon-long, 4.3 MiB)
- `.dsh-home/browser-agent/logs/m0-archive/run-2026-11-17T01-13-25-223Z-02b684/events.jsonl` (stall-loop, 2.8 MiB)
- `.dsh-home/browser-agent/logs/m0-archive/run-2026-11-17T01-20-21-564Z-2551a4/events.jsonl` (sign-in-wall, 0.9 MiB)
- `.dsh-home/browser-agent/logs/m0-archive/run-2026-11-17T01-07-02-137Z-f33f10/events.jsonl` (smoke, 0.1 MiB)
- diagnostic-only (contaminated, M1-code): `run-2026-11-17T00-36-32-285Z-087d49`, `run-2026-11-17T00-37-20-119Z-166c12`, `run-2026-11-17T00-43-57-262Z-2ab066`, `run-2026-11-17T00-56-00-693Z-d6d771` + `contaminated-baselines/`

Reproduce (key from the environment only; never printed or committed):

```sh
git worktree add --detach /tmp/crazyagent-m0-clean c2966018d10e761be93d9c5dbdeb60bf9865a5b8
ln -s <repo>/node_modules /tmp/crazyagent-m0-clean/node_modules
# overlay the M0 harness/scenario/fixture files (this commit's versions)
cd /tmp/crazyagent-m0-clean
npm test                                   # 1055/1055 gate at the pinned commit
node scripts/model-eval.mjs --self-test --scenario marathon-long --scenario stall-loop --scenario sign-in-wall
CRAZYAGENT_API_KEY=... node scripts/model-eval.mjs --scenario marathon-long --repeat 5 --plan \
  --model deepseek/deepseek-v4.1-flash-1017 --effort medium \
  --dsh-home /tmp/crazyagent-m0-clean-eval/dsh-home --label m0-marathon-long-plan-clean
# same for --scenario stall-loop / --scenario sign-in-wall; verify 0 marathon frames per archived log
```

Files added/changed for M0: `e2e/scenarios/marathon-long.mjs`, `e2e/scenarios/stall-loop.mjs`, `e2e/fixtures/marathon-01..12.html` + `marathon.js` + `stall-loop.html` (new files only), `e2e/scenarios/README.md` (scenario table + `--plan`), `scripts/model-eval.mjs` (approved additive `--plan` flag), the four clean baseline JSONs, and this report. No product behavior was changed.
