# M2 report — plan carry-over and marathon limits

**Date:** 2026-11-16 · **Task:** shared task-3 · **Plan:** `MARATHON-PLAN.md` §5 M2 + §3.2
**Scope:** seed frame + `seedPlanState`, state v2 lifetime counters + per-stretch refill, seeded-but-untouched rule, `<marathon_mode>` guidance with carried list, MALFORMED rerun re-seed, `noteActivity` plan snapshots carried at turn end, panel carried-plan rendering, new `c1-acceptance` row. **No new tools; standing count stays 34.**
**Status:** implementation + unit gates + independent check complete. **Real-model acceptance is eval's and is held until task-8 (M1 ×5 comparison) is green — lead confirms.** This report does not claim real-model acceptance.

## What changed

### Provider (`packages/dsh-browser-extension/lib/`)
- **`plan.js`:** `STATE_VERSION` 1 → 2; two lifetime counters (`completionNudgesLifetime`, `staleRemindersLifetime`) added to `STATE_KEYS` and validated (0–12, and each ≥ its per-stretch counter). `PLAN_LIMITS` gains `maxCompletionNudgesLifetime: 12` and `maxStaleRemindersLifetime: 12`; the per-stretch caps (`maxCompletionNudges: 2`, `maxStaleReminders: 2`), `staleAfterActivities: 6`, and `maxItems: 40` are unchanged. New **`seedPlanState(seed)`**: validates a non-negative safe-integer revision and a non-empty item list through the existing `normalizeItems`; counters start at zero; anything invalid returns `null` (caller falls back to `createPlanState()` and logs `plan.seed.rejected` — fail closed, the model's first call then sees revision 0 and recovers via `PLAN_REVISION_CONFLICT`). **Refill rule:** an accepted `replacePlan` resets `completionNudges` and `staleReminderCount` to 0 (new stretch) while the lifetime counters keep counting; `PLAN_UNCHANGED` still prevents refilling by resubmitting the same list. `recordPlanActivity` and `decidePlanFinalAnswer` also stop at the lifetime caps; nudge/reminder text now reads "… N of 2 this stretch; M of 12 this turn." `decidePlanFinalAnswer` decisions carry the lifetime fields additively.
- **`plan-runtime.js`:** `setMode` remembers `pendingSeed` alongside `pendingTurnId`; `claim` builds state via `seedPlanState` (logging `plan.seed.rejected` on fallback) and tracks `seeded`, `planCalls`, `nonPlanResults`. **Seeded-but-untouched rule** in `stopping()`: when the plan was seeded, the model made no `browser_plan` call, and the turn had zero non-plan tool results (and it was not aborted/waiting), the decision is `allow` with outcome `not-assessed` (reason `seeded-untouched`) — no nudge about the old plan. Any tool activity restores the ordinary nudge path. `plan.mode.started` logs `revision` + `seeded`. The `PLAN_MODE_INACTIVE` message now names `/marathon` (legacy `/plan`).
- **`index.js`:** unchanged wiring — `plan.mode` frames (now carrying `seed`) reach `planRuntime.setMode`; the seed flows through the existing `onPlanMode` path. No new model-facing tools.

### Companion
- **`bridge.mjs`:** `setTurnId(turnId, {planMode, confirmMode, confirmGuard, planSeed})`; `plan.mode` now carries `seed: {revision, items} | null` (null when unarmed/no carry). A non-record seed is dropped (the provider validates strictly).
- **`session-controller.mjs`:** `noteActivity` consumes `kind:'plan'` frames into `planTurnSnapshot` (validated via `normalizePlanSeed`; malformed/stale-turn frames ignored). `#begin` resets the snapshot and seeds the turn from the carried marathon plan (`#carriedPlanSeed`). At turn end (in `finally`, before the pending steer starts) the snapshot is stored into `marathon.state.plan` **iff open items remain** and the switch is on; a completed/blocked-only plan is dropped; a turn that never touched the plan leaves the carried snapshot untouched. The store publishes `marathon.state` so clients see the carried plan. The **`MALFORMED_RESPONSE` rerun re-arms with the CURRENT snapshot** (`#currentPlanSeed` = latest observed, else carried), not the turn-start one. `turnStart` logs `marathon` + `planSeedRevision`.
- **`marathon.mjs`:** `storePlan(snapshot)` (only while enabled; open-items-only; fail-closed via the new `normalizeMarathonPlan`); `normalizeMarathonPlan` validates the full `{revision, items, updatedAt, turnId}` shape (unique content, known statuses, ≤40 items).
- **`prompt.mjs`:** `PLAN_MODE_GUIDANCE` → **`MARATHON_MODE_GUIDANCE`** (`<marathon_mode>` block, reworded for the sticky switch). `buildPromptBlocks` accepts `{marathon:{seed}}`; with a valid seed it appends the carried list inside the block (`formatCarriedPlan`): "Carried plan, revision N (K open). … use expected_revision:N. If it is a different task, replace the plan with acknowledge_open_removal:true and a reason." plus up to `PLAN_LIMITS.openSummaryItems` (8) open-item lines and an "…and X more" note. `normalizePlanSeed` fails closed (invalid seed → fixed block only). Fixed part is **1,233 chars ≤ the 1,500 test ceiling**; the block is per-turn text outside the 17,100 core+Docs ceiling.
- **`remote-hub.mjs`:** `#onMarathonState` forwards the validated carried `plan` (was forced null in M1); off clears it; the projection and `remote.marathon` envelope deep-copy items.

### Panel (`extension/sidepanel/app.js`)
- `startTurn` renders the carried plan at turn start: when a marathon turn begins and `marathonState.plan.items` exists, the plan model is seeded from it before the first render, so the checklist shows the carried list immediately; live `plan` activities then update it as usual.

### Scripts / tests
- **`scripts/ui-preview.mjs`:** the `marathon` scenario's M1 carried-plan *placeholder* is replaced with real assertions — the carried list renders at turn start (heading "Marathon plan", 0/2 done, both items) before any live activity, then a live revision updates it.
- **`scripts/c1-acceptance.mjs`:** new **`steer-plan`** row ("steer mid-marathon keeps the plan") with a pure, mutation-checked `checkSteerPlanEvidence` (12 self-test cases) and `runSteerPlanCheck` (arms via `POST /marathon`, waits for a plan + moving counter, steers, then checks the steered prompt carried turn 1's final revision and the plan survived; counter is ground truth for no duplicate clicks). Log readers `planRevisionFromLog` / `carriedRevisionFromLog` added. **The real-model run of this row is eval's, held until task-8 is green.**
- **`scripts/marathon-independent-check.mjs`:** tags updated to `<marathon_mode>`; new **check G** injects a plan activity through the provider's `noteActivity` path and verifies the carry-over end-to-end (next turn's prompt carries revision 2; the real panel renders the carried list at turn start).
- **Tests (+20):** `plan.test` (seedPlanState validation, v2 state, refill + lifetime caps for nudges and reminders), `plan-runtime.test` (seeded claim, rejected-seed fallback, seeded-untouched allow, tool-activity/plan-call restore, aborted bypass, runtime refill), `prompt.test` (marathon block, carried list cap + fail-closed seeds, 1,500 ceiling), `session-controller.test` (carry-over, completed-drop, off-never-carries, MALFORMED re-seed, steer inheritance, new-chat drop), `marathon.test` (storePlan, normalizeMarathonPlan), `remote-hub.test` (carried plan journaled/projected/fail-closed). Existing budget tests rewritten for the refill semantics; `<plan_mode>`→`<marathon_mode>` and `plan.mode` seed-shape assertions updated.

## Gate results (cheapest first)

| Gate | Result | Evidence |
|---|---|---|
| `npm test` | **1105/1105 pass** (1085 after M1; +20). Includes the 17,100 prompt-ceiling test and the Android reducer-fixture staleness gate (fixtures unchanged — the default projection shape is identical). | [`m2-evidence/npm-test.txt`](m2-evidence/npm-test.txt) |
| Standing prompt composition | **unchanged: 12,402 non-Docs / 18,092 Docs** (core 11,408 + docs 5,688 = 17,096 ≤ 17,100). `<marathon_mode>` fixed part 1,233 ≤ 1,500. | [`m2-evidence/prompt-composition.txt`](m2-evidence/prompt-composition.txt) |
| `c1-acceptance --self-test` | **PASS** — every checker accepts good evidence and rejects every mutation, incl. the 12 new `steer-plan` cases. | [`m2-evidence/c1-self-test.txt`](m2-evidence/c1-self-test.txt) |
| `ui-preview --scenario marathon` + `plan` | **PASS**, screenshots inspected: carried plan renders at turn start; chip/mid-turn/narrow behavior intact. | [`m2-evidence/ui/`](m2-evidence/ui/) (`marathon-carried-plan.png`, `plan-live.png`), logs `ui/marathon.txt` / `ui/plan.txt` |
| Independent check (M1 A–F + M2 G) | **PASS** all seven checks. G: injected plan activity → carried revision 2 in the next prompt AND rendered by the real panel ("Marathon plan", 0/2 done, both items). | [`m2-evidence/independent-check/`](m2-evidence/independent-check/) (`06-carried-plan.png`, `transcript.json`), [`m2-evidence/independent-check.txt`](m2-evidence/independent-check.txt) |

## Independent check transcript (check G, real panel ↔ real remote API)

Full transcript: [`m2-evidence/independent-check/transcript.json`](m2-evidence/independent-check/transcript.json). Checks A–F (M1) re-passed unchanged. Check G:
1. `POST /marathon {enabled:true}`; chip lit.
2. `POST /messages` "slow marathon task that plans" → `202`; once active, the harness injects `controller.noteActivity({kind:'plan', revision:2, items:[Fill the shipping form (in_progress), Verify the confirmation page (pending)]})` — the exact path the provider uses.
3. Turn ends → `GET /state` `marathon.plan.revision === 2`, items match (open items kept).
4. The next turn starts **from the panel** (composer submit over the real bridge): its prompt contains `Carried plan, revision 2 (2 open)` and `use expected_revision:2`; the panel DOM renders the carried checklist at turn start (`Marathon plan`, `0/2 done`, both item contents) — `06-carried-plan.png`.

## Deliberate non-goals / held work

- **No real-model acceptance claimed.** Per the standing rule (all real-model acceptance runs from pinned worktrees) and lead's hold, the M2 real-model scenarios — `marathon-long` ×5 vs M0, stop-then-"continue" ×5, unrelated-question ×5, and `c1-acceptance --check steer-plan` — are eval's and run only after task-8 (M1 comparison) is green. The seeded-but-untouched rule is **unit-tested only** and is not trusted until its real-model check passes (plan §3.2).
- No watcher (M3/M4), no phone UI (M5). The phone still sends legacy `planMode:true`; it now also receives the carried plan in `remote.marathon`/`/state` but does not render a checklist until M5.
- The user's live companion at `127.0.0.1:17871` was never touched; all runs used isolated profiles/ports/homes. Extension changes require a reload in the user's profile (M6 release step).

## Next

- eval task-8 (M1 ×5) → then M2 real-model acceptance from a pinned M2 worktree.
- M3 (task-4) is blocked by task-3; not started.

---

## Real-model acceptance — PRE-TUNING (eval, task-9, pin 1a248fa)

**Status on this pin: NOT GREEN.** Suite 1 (marathon-long) 5/5 and suite 3 (seeded-untouched) 5/5, but suite 2 (stop-then-continue, the core M2 gate) is **4/5 — one continuation re-done a recorded station**. Lead decision 2026-11-16: no accept-with-caveat, no lucky rerun; the r5 finding below triggered **task-10** (core strengthens the carried-plan continuation guidance in `prompt.mjs` only). Full re-acceptance of ALL suites on the tuning pin follows; this section is the before-tuning evidence picture. steer-plan is held for the tuning pin.

### Setup and provenance (standing rule)

- Worktree `/tmp/crazyagent-m2-accept` pinned at **`1a248fa84904ee0ae8db440517289561ec7b30e3`**; overlays: multi-turn `scripts/model-eval.mjs` (additive, lead-pre-approved: `followUp` + 250 ms `stopWhen` poll → `POST /stop` + `verifyBetweenTurns` on `GET /state` + void+retry ≤3 with recorded reasons + per-turn plan telemetry), `e2e/scenarios/{_marathon-check,marathon-long,stop-then-continue,unrelated-question}.mjs` + README. Fresh isolated home `/tmp/crazyagent-m2-eval/dsh-home`; 1017 @ medium; `--marathon` new-switch arming (per-run OFF-verified → enable → ON-verified → bare prompt); `commitUnderTest` + `armingPath` in every JSON.
- Gates before spend: `npm test` **1105/1105** on the pin; `c1-acceptance --self-test` green; scenario `--self-test` green for all five (marathon-long semantics frozen: untouched fail / tampered partial / solved pass; stop-then-continue tamper = redo → **fail**; unrelated-question tamper = resumed work → fail).
- Smokes ×1 each: click-once PASS 6.1 s (single-turn regression after the harness refactor); stop-then-continue PASS (t1 stopped 16.5 s after step 4, t2 35.6 s, 12/12 exactly-once); unrelated-question PASS (t2 1.3 s, 51, 0 calls, not-assessed). Batch: `e2e/baselines/2026-11-17T02-00-10-799Z-m2-smokes.json`.

### Suite 1 — marathon-long ×5 in /marathon vs clean M0

| metric | clean M0 /plan (c2966018) | M2 /marathon (1a248fa) |
|---|---|---|
| pass/partial/fail | 5/0/0 | **5/0/0** |
| redos | 0 | **0** |
| wall s min–max (med) | 57.5–65.5 (61.9) | 66.0–297.1 (83.9) |
| steps min–max (med) | 41–55 (51) | 42–65 (46) |
| calls min–max (med) | 40–54 (50) | 41–64 (45) |
| failed Σ / retries / dead | 5 / 0 / 0 | 2 / 0 / 0 |
| non-cached input Σ | 135,398 | 193,356 |
| output Σ | 22,391 | 52,469 |
| cacheRead Σ | 8,819,584 | 7,450,069 |

Per run: r1 83.9 s/49/48/0 · r2 110.2 s/65/64/1 · r3 66.0 s/46/45/0 · r4 78.5 s/42/41/1 · r5 297.1 s/42/41/0 (output 34,651 — a long-generation tail with zero failed calls; the output Σ increase is almost entirely this one run). Completion/reliability identical to M0; steps/calls distributions overlap with lower medians; wall has one heavy tail. All runs plan-armed via the switch, `planOutcome=reported-complete`, rev 2–4. No regression signal; distributions + fresh/cache split recorded per the task-8 lesson.

### Suite 2 — stop-then-continue ×5 (core M2 gate): 4/5, one redo

Mechanics were clean in **all five runs, zero voided attempts**: turn 1 stopped deterministically right after the server recorded step 4 (t1 walls 11.0–107.4 s; `stepsAtStop=4` every run), between-turn `/state` verified stopped + marathon on + carried plan with open items (rev 1–2), turn 2 bare `continue` seeded (`planSeeded=true`, no `plan.seed.rejected` anywhere).

| run | verdict | t1 wall/steps/calls | t2 wall/steps/calls | valid | redos | seed rev | t2 outcome |
|---|---|---|---|---|---|---|---|
| 1 | pass | 19.0/8/8 | 36.9/19/18 | 12/12 | 0 | 1 | reported-complete rev 3 |
| 2 | pass | 16.6/8/8 | 47.4/21/20 | 12/12 | 0 | 1 | reported-complete rev 3 |
| 3 | pass | 11.0/8/8 | 28.1/20/19 | 12/12 | 0 | 1 | reported-complete rev 3 |
| 4 | pass | 36.6/22/22 | 73.2/45/44 | 12/12 | 0 | 2 | reported-complete rev 4 |
| 5 | **fail** | 107.4/22/21 | 293.1/47/46 | 11/12 | **1 (station 9 ×2)** | 2 | reported-complete rev 3 |

**The r5 finding (triggered task-10):** the continuation re-submitted station 9. Server record: `perStep` station 9 = 2 POSTs, every other station exactly 1; `stepsAtStop=4` proves both station-9 POSTs happened in turn 2. Archived events show turn 2 issued the **identical** `browser_batch` (type `R8-L6P`, type `summit-window`, click submit) twice — `02:23:38.247Z` and `02:24:08.573Z`, 30 s apart; turn 1 contains zero station-9 calls. The turn wandered (12 navigations incl. revisits, 18 read_text, 38.8k output tokens, 1 recovered `UNKNOWN_LABEL`), and its finalText **falsely claimed** "Completed stations 1–12 in order without resubmitting any accepted station" — the independent server record caught what the model's answer denied. Two identical mutating repeats stay under the executor's 3-repeat guard, so only the server-side step record exposes this. Seed mechanics worked (carried revision used, completion reported); the failure is continuation fidelity — the guidance did not keep the model from re-acting on an already-completed item after a revisit. Diagnostic pattern across ALL five continuations: 0 completion nudges, exactly 2 stale reminders per continuation turn (per-stretch cap), worth watching during tuning.

### Suite 3 — unrelated-question ×5 (seeded-untouched gate): 5/5

Every run: same clean stop-after-step-4 setup (0 voids); turn 2 answered **"51"** in 1.5–2.5 s with **1 model step, 0 tool calls, 0 browser_plan calls**, `planOutcome=not-assessed` (reason `seeded-untouched`), **0 nudges / 0 stale reminders**, and the carried plan (rev 1) still present in `/state` afterwards. The carried plan did not hijack a single unrelated question.

### steer-plan (c1-acceptance row)

**Held for the tuning pin** per lead decision (the prompt change affects every seeded turn; full re-acceptance there).

### Evidence (pre-tuning)

- `e2e/baselines/2026-11-17T02-02-36-891Z-m2-marathon-long-marathon.json` · archive `m0-archive/run-2026-11-17T02-02-36-976Z-849181/` (5.2 MiB)
- `e2e/baselines/2026-11-17T02-14-11-909Z-m2-stop-then-continue.json` · archive `m0-archive/run-2026-11-17T02-14-11-994Z-c82d46/` (5.6 MiB; r5's duplicate station-9 batches timestamped in turn 2)
- `e2e/baselines/2026-11-17T02-26-39-703Z-m2-unrelated-question.json` · archive `m0-archive/run-2026-11-17T02-26-39-794Z-739f46/` (1.5 MiB)
- smokes: `e2e/baselines/2026-11-17T02-00-10-799Z-m2-smokes.json` · archive `m0-archive/run-2026-11-17T02-00-10-884Z-401b96/`
- All archives under `.dsh-home/browser-agent/logs/m0-archive/` (gitignored, prune-safe); every JSON carries `commitUnderTest`, `armingPath`, per-run `marathonArm`, per-turn `planEvidence`, void records, and the between/after `/state` seed chain.

## M2 tuning — continuation-fidelity guidance (task-10, core)

**Trigger:** suite 2 r5 above — a wandering 293 s / 47-step continuation re-submitted station 9 (two identical `browser_batch` POSTs in turn 2), and the model's finalText falsely denied it. The server-side step record caught the redo.

**Root cause (lead's read, confirmed by the code):** continuation-fidelity drift on a long turn, **not** a seeding bug. The seed mechanics worked in all five runs (`planSeeded=true`, carried revision used, no `plan.seed.rejected`). The carried-plan header told the model to "keep going" but never said that completed work is final, that it should resume from the first open item, or that it should verify current page state before re-acting after a revisit. Two identical mutating repeats stay under the executor's 3-repeat guard, so only the independent server record exposes this — the guidance is the right lever.

**The one change (`companion/prompt.mjs`, `formatCarriedPlan` carried-plan header only):** general wording, no fixture knowledge, no limit/counter changes, no new tools.

Old header line:
```
Carried plan, revision N (K open). If this message continues that work, keep going and use expected_revision:N.
```
New header line:
```
Carried plan, revision N (K open). If this message continues that work, use expected_revision:N. Completed items are final: never repeat their actions or re-submit anything already accepted. Resume from the first open item below. When unsure what is already done, read the current page state before acting rather than redoing work.
```
The three required clauses are present verbatim: completed items final / never repeat; resume from the first open item; read current page state before acting when unsure. The "different task → acknowledge_open_removal" line and the 8-line open-item cap are unchanged. The fixed `MARATHON_MODE_GUIDANCE` block is **untouched**.

**Budget numbers:**
- Fixed `MARATHON_MODE_GUIDANCE`: **1233 chars** (unchanged; ceiling 1500, 267 headroom preserved).
- Carried header line: 135 → **331 chars** (per-turn carried text, outside the fixed-part ceiling).
- Full `<marathon_mode>` block: 1518 → **1738 chars** with a 2-item seed; **1852 chars** with a 12-item seed (8 listed). All per-turn conditional text, outside the 17,100 core+Docs ceiling (unchanged: 12,402 non-Docs / 18,092 Docs; core+docs 17,096).
- Carried item list still capped at `PLAN_LIMITS.openSummaryItems` = 8 lines.

**Gates (all green):**
- `prompt.test` + `plan.test` + `plan-runtime.test`: 59/59 (the carried-plan test now asserts the three fidelity clauses; the old "keep going" assertion replaced).
- Full `npm test`: **1152/1152** (`m2-evidence/tuning/npm-test.txt`).
- `ui-preview --scenario marathon`: PASS, carried plan still renders at turn start (`m2-evidence/tuning/ui-marathon.txt`, `marathon-carried-plan.png`).
- Independent check G (carried plan through the real panel + remote API): PASS — `Carried plan, revision 2 (2 open)` and `use expected_revision:2` still in the prompt; DOM renders the carried checklist (`m2-evidence/tuning/independent-check.txt`, `independent-06-carried-plan.png`).

**Held:** eval re-runs ALL M2 suites (marathon-long ×5, stop-then-continue ×5, unrelated-question ×5, steer-plan) on the tuning pin for final M2 acceptance. The 2 stale reminders per continuation turn remain diagnostic only — no counter change this iteration (one change at a time). M3 was paused for this tuning and resumes after the commit.

---

## Real-model acceptance — FINAL (eval, task-9; suites on tuning pin a31f7f9, steer-plan rerun + acceptance pin 2abb065)

**Verdict: the M2 gates are GREEN — task-9 complete.** Continuation (the core gate): **5/5 PASS, ZERO redos, ZERO voids**, with the tuning clause provably delivered in every continuation prompt. Seeded-untouched: **5/5** (10/10 across both M2 pins). marathon-long: 4/5 PASS + 1 partial — **accepted by lead as within-noise** with the proof below (the changed line cannot reach unseeded prompts). steer-plan: first live run exposed a row evidence-logic bug (diagnosis below); core fixed the row + self-test fixtures (`9b856df`); **rerun on acceptance pin `2abb065e9f923bba35b2f4d67ae83acceb71d55f`: PASS**. Acceptance-pin continuity: `companion/prompt.mjs`, `plan.js`, `plan-runtime.js` are byte-identical between `a31f7f9` and `2abb065` (empty diff), so the suites 1–3 verdicts carry to the acceptance pin; gates there: npm test **1201/1201**, c1 + scenario self-tests green.

### Provenance and gates

- Worktree `/tmp/crazyagent-m2t-accept` pinned at **`a31f7f93bea4b8861959631762bee47e058898a0`** (descends from eval's `11ba028`, so the multi-turn harness + scenarios are committed at the pin — no overlays needed). Fresh isolated home `/tmp/crazyagent-m2t-eval/dsh-home`; 1017 @ medium; `--marathon` new-switch arming (per-run OFF-verified → enable → ON-verified → bare prompt); `commitUnderTest` + `armingPath` in every JSON; same stop-after-step-4 mechanics and void+retry rules as pre-tuning.
- Gates before spend: `npm test` **1105/1105** measured on the pin (the tuning commit message's 1152 was the working tree with uncommitted M3 tests — lead-confirmed, both 0 fail); `c1-acceptance --self-test` green; scenario `--self-test` green for all five.
- Smokes ×1: click-once PASS 4.6 s; stop-then-continue PASS — a **311.8 s / 188-step continuation with ZERO redos** (the tuned fidelity held through a long wander, 4 stale reminders across refilled stretches, 0 completion nudges); unrelated-question PASS 2.7 s. Batch: `e2e/baselines/2026-11-17T02-38-11-136Z-m2t-smokes.json`.

### Suite 1 — marathon-long ×5: three-way comparison

| metric | clean M0 /plan (c2966018) | pre-tuning M2 (1a248fa) | tuned M2 (a31f7f9) |
|---|---|---|---|
| pass/partial/fail | 5/0/0 | 5/0/0 | 4/1/0 |
| redo stations | 0 | 0 | 2 (both in r3) |
| wall s min–max (med) | 57.5–65.5 (61.9) | 66.0–297.1 (83.9) | 42.1–641.8 (56.6) |
| steps min–max (med) | 41–55 (51) | 42–65 (46) | 27–80 (43) |
| calls min–max (med) | 40–54 (50) | 41–64 (45) | 28–79 (42) |
| failed Σ / retries / dead | 5 / 0 / 0 | 2 / 0 / 0 | 5 / 0 / 0 |
| non-cached input Σ | 135,398 | 193,356 | 273,753 |
| output Σ | 22,391 | 52,469 | 97,818 |
| cacheRead Σ | 8,819,584 | 7,450,069 | 8,018,915 |

**The r3 partial (641.8 s, 80 steps, 84.5k output):** stations 4 and 5 each recorded twice within the single turn (23 navigations — a wandering turn), finalText falsely claiming "All 12 stations submitted in order". **Proof it is not a tuning effect:** r3 `planSeeded=false`; its `prompt.build` contains NO carried-plan header and NO tuning clause (verified from archived events; true of every suite-1 run — unseeded turns receive only the fixed guidance, unchanged at 1233 chars). The one changed line cannot reach these prompts; the model-facing surface is byte-identical to pre-tuning M2. Lead ruling 2026-11-16: **accepted as within-noise**, r3 recorded as a sample of the pre-existing single-turn wander/redo mode (cross-pin rates below), no fishing rerun. The token Σ increases are dominated by r3's wander (84.5k output) — excluding r3, output Σ is 13.4k vs M0's 22.4k.

### Suite 2 — stop-then-continue ×5 (core M2 gate): 5/5, ZERO redos

| metric | pre-tuning (1a248fa) | tuned (a31f7f9) |
|---|---|---|
| pass/partial/fail | 4/0/1 | **5/0/0** |
| redo stations Σ | 1 (r5 station 9 ×2) | **0** |
| voided attempts Σ | 0 | 0 |
| t1 wall s (stop after step 4) | 11.0–107.4 (med 19.0) | 12.3–33.6 (med 19.1) |
| t2 wall s | 28.1–293.1 (med 47.4) | 35.5–87.3 (med 43.5) |
| t2 steps / calls (med) | 21 / 20 | 21 / 20 |
| t2 failed Σ (all recovered) | 3 | 8 |
| t2 non-cached input Σ | 198,432 | 665,455 (r4 cache-miss pattern 536k; ex-r4 129k) |
| t2 output Σ | 47,092 | **11,211** |
| t2 stale reminders per run | 2,2,2,2,2 | 1,2,2,1,3 |
| t2 completion nudges Σ | 0 | 0 |

Every run: stop landed right after the server recorded step 4 (`stepsAtStop=4`), between-turn `/state` verified (stopped + marathon on + carried plan with open items, rev 1–2), turn 2 `continue` seeded (`planSeeded=true`, no `plan.seed.rejected`), 12/12 exactly-once, genuine completion view, `planOutcome=reported-complete`. **Change-delivery control: all five turn-2 `prompt.build` events contain the carried header AND the three tuning clauses** (verified from archived events). The pre-tuning 293 s wander tail is gone; t2 output dropped 76%; fidelity held through r4's cache-miss input pattern and r5's six recovered failed calls. Stale reminders 1–3 with 0 completion nudges — the per-stretch refill works as designed (diagnostic, no counter change).

### Suite 3 — unrelated-question ×5 (seeded-untouched): 5/5

Every run: clean stop setup (0 voids), turn 2 answered **"51"** in 1.2–2.0 s with 1 model step, **0 tool calls, 0 browser_plan calls**, `planOutcome=not-assessed` (reason `seeded-untouched`), **0 nudges / 0 stale**, carried plan (rev 1–2) still in `/state` afterwards. Combined with pre-tuning: **10/10** — the carried plan never hijacked an unrelated question.

### Suite 4 — c1 steer-plan row: behavior verified, row-evidence bug pending fix

Live run (dedicated home `/tmp/crazyagent-m2t-c1`): turn 1 created plan rev 1 (`browser_plan`×1, `plan.updated` rev 1), clicked to count 5, steer landed mid-turn (`turn1Aborted=true`). Turn 2: armed, **prompt carried revision 1** (`turn2CarriedRevision=1`), plan still in `/state` after (`carriedPlanRevisionAfter=1`), `turn2Ok=true`, answered "Current count: 5" with zero tool calls, counter frozen at 5 (no duplicate action), `planOutcome=not-assessed`. **Every behavioral requirement of "steer mid-marathon keeps the plan" is independently demonstrated.**

The row nonetheless reported FAIL "no plan created before the steer (revision=null)": `checkSteerPlanEvidence` required `turn.end.planRevision ≥ 1`, but a steer-aborted turn's `turn.end` structurally lacks plan annotation (`{ok:false, aborted:true, planOutcome:null, planRevision:null}` — the runtime is interrupted before `endTurn` annotates; the same gap appears on all stopped turn-1s in suite 2, where carry-over works via `plan.updated` activities → companion snapshot). The row's mutation self-test fixture set `turn1PlanRevision` to a value live steered turns never produce, so the self-test could not catch it; the first live run exposed it.

**Fix and rerun (core `9b856df`, acceptance pin `2abb065`):** the row now accepts `revisionAtSteer` / `turn2CarriedRevision` as authoritative for aborted turns (annotated `turn.end` stays authoritative when present), and the self-test fixtures use the real aborted `turn.end` shape. Rerun on `2abb065` (fresh home `/tmp/crazyagent-accept-c1`): **PASS, clean** — turn 1 `browser_plan`×1 + 3 single clicks (count 3 at steer, `revisionAtSteer=1`, aborted); turn 2 armed, **prompt carried revision 1**, `/state` plan rev 1 after, `turn2Ok=true`, zero tool calls, counter frozen at 3, `planOutcome=not-assessed`. 7.3 s, 0 failed calls. Evidence: `e2e/baselines/2026-11-17T03-34-07-789Z-m2-final-steer-plan.json`, archive `m0-archive/run-2026-11-17T03-34-07-881Z-2f6fb2/`. The pending-fix diagnostic run is retained: `e2e/baselines/2026-11-17T03-09-45-387Z-m2t-c1-steer-plan.json`, archive `m0-archive/run-2026-11-17T03-09-45-475Z-a9444a/`.

### Cross-pin mode rates (lead-requested; M6 follow-up candidate)

Population: 25 single-turn marathon-long runs across 5 pins (M0-contaminated diagnostic, M0-clean, M1, M2-pre, M2-tuned) + 12 continuation turn-2s (pre/tuned suites + smokes). Wander = wall > 200 s OR ≥15 navigations OR ≥70 steps; redo = duplicate server step records.

- **Single-turn:** wander **4/25 (16%)** (one per pin except M0-clean), redo **1/25 (4%)** (tuned suite-1 r3), false-completion-claim-with-redo **1/1**.
- **Continuation:** redo **1/12** — the single redo is pre-tuning (pre 1/6 incl. smoke → tuned **0/6** incl. the 312 s/188-step smoke wander that stayed faithful); wander 2/12.
- **M6 follow-up flag for `docs/STATUS.md`:** "single-turn wander/redo with false completion claim" — a base-agent reliability mode present across pins (the model revisits accepted work and denies re-submitting it; only the independent server record exposes it). Outside M2's scope; the M2 tuning specifically eliminated continuation redos. Candidate levers: general post-action verification guidance or server-state awareness — not addressed here (one change at a time).

### Tuning effect, isolated

One line changed (carried-plan header); unseeded surface byte-identical (proved via `prompt.build`). Continuation redo rate 1/6 → 0/6; the 293 s wander tail eliminated; t2 output Σ −76%; seeded-untouched unchanged 10/10; completion nudges 0 throughout; stale-reminder refill diagnostic unchanged in kind. The suite-1 r3 partial is a sample of the pre-existing single-turn mode, not a tuning effect (lead-accepted within-noise).

### Evidence (final acceptance)

- `e2e/baselines/2026-11-17T02-38-11-136Z-m2t-smokes.json` · archive `m0-archive/run-2026-11-17T02-38-11-221Z-458428/`
- `e2e/baselines/2026-11-17T02-44-33-961Z-m2t-marathon-long-marathon.json` · archive `m0-archive/run-2026-11-17T02-44-34-045Z-b5a71b/` (6.4 MiB)
- `e2e/baselines/2026-11-17T03-00-02-687Z-m2t-stop-then-continue.json` · archive `m0-archive/run-2026-11-17T03-00-02-778Z-c3dddb/` (3.7 MiB)
- `e2e/baselines/2026-11-17T03-07-12-434Z-m2t-unrelated-question.json` · archive `m0-archive/run-2026-11-17T03-07-12-520Z-2c78d2/` (1.9 MiB)
- `e2e/baselines/2026-11-17T03-09-45-387Z-m2t-c1-steer-plan.json` · archive `m0-archive/run-2026-11-17T03-09-45-475Z-a9444a/` (pending-fix diagnostic)
- `e2e/baselines/2026-11-17T03-34-07-789Z-m2-final-steer-plan.json` · archive `m0-archive/run-2026-11-17T03-34-07-881Z-2f6fb2/` (**PASS** on acceptance pin 2abb065)
- Pre-tuning reference: the `m2-*` JSONs + section above (commit `11ba028`); clean M0: `docs/marathon/M0-baseline.md`.
- All archives under `.dsh-home/browser-agent/logs/m0-archive/` (gitignored, prune-safe); every JSON carries `commitUnderTest`, `armingPath`, per-run `marathonArm`, per-turn `planEvidence`, seed chain, void records.

