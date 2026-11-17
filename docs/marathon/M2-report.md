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
