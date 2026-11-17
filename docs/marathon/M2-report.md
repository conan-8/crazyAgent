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
