# M1 report — `/marathon` rename and the shared companion-owned switch

**Date:** 2026-11-16 · **Task:** shared task-2 · **Plan:** `MARATHON-PLAN.md` §5 M1 + §3.1/§3.4/§3.5
**Scope:** rename + shared switch ONLY. No watcher, no limit changes, no plan carry-over (M2+).
**Status:** code gates + independent check complete. The `marathon-long` ×5 vs M0 real-model comparison is eval's task-8 and is **not** part of this report.

## Step 0 — park commit

The pre-existing Android/new-UI preview work was already committed when this task started: HEAD `c296601` ("Align Android UI with sidebar and add prompt rail", pushed to `origin/main`) contains exactly the 23 listed park paths, and `git status` was clean. Lead verified and accepted: no pushed history was rewritten; the park-before-edits intent was satisfied.

## What changed

### Companion
- **`companion/marathon.mjs` (new):** pure state holder per §3.1 — `{enabled, sessionId, since, origin, plan}`; `plan` stays `null` in M1. `MarathonState.set` is idempotent (re-enabling keeps the original `since`/`origin`), fail-closed on non-boolean `enabled` (`INVALID_MARATHON`), normalizes unknown origins to `ui`; off clears every marker including the plan. `reset()` for chat switches. `MARATHON_WATCHER_IDLE` + `marathonFrameBody()` define the frame shape with idle watcher fields until M3.
- **`companion/session-controller.mjs`:** owns the single `MarathonState` instance (a fresh controller — companion restart — starts off, fail-safe). `setMarathon({enabled, origin})` accepted in any turn state, publishes `marathon.state` only on change, logs `marathon.set`/`marathon.reset`; `marathonState()` accessor. `#begin` arms from `marathon.enabled || input.planMode === true`; a legacy `planMode:true` first turns the switch on with the sender's origin (also for a queued steer, when the steered turn begins). `newChat()` and a real `resumeChat()` reset off (the `already:true` same-session path keeps the state). `chat.done` carries `marathon` beside `planMode` (both emitted this release); armed foreign `chat.user` carries `marathon:true`; `turnStarted` observer info gains `marathon`.
- **`companion/bridge.mjs`:** `marathon.set` from the `ui` role routes to a new `onMarathonSet` callback (never treated as a prompt; the `tools` role has no such path). Handler failures are logged and never break the bridge.
- **`companion/index.mjs`:** `handleMarathonSet` validates through the controller and answers rejections as `chat.error`; `chat.hello` carries `marathon: marathonFrameBody(controller.marathonState())` so a reconnect resyncs the chip.
- **`companion/remote-server.mjs`:** `POST /marathon {enabled, clientCommandId}` → `200 {clientCommandId, enabled, sessionId, sequence, instanceId}` with `rememberCommand` idempotency (fingerprint `{enabled}`; conflict on a changed payload). `POST /marathon/watch/ack` validates then returns `404 WATCH_NOT_FOUND` until M3. Same token/Host/origin rules; **no limit changes** — toggles are chat-level state, not prompts (not message-limited). The remote API still cannot claim `ui`/`tools`, send browser commands, configure the LLM, or read files.
- **`companion/remote-hub.mjs`:** ingests `marathon.state`, journals/replays `remote.marathon` like `remote.help` (deduplicated on identical state), resets the mirror to off on `chat.session`; `/state` projection gains `marathon {enabled, since, plan, watch{open,lastVerdict,lastCheckAt,checks}}` (plan `null`, watch empty until M2/M3); `chat.done` normalization carries `marathon` beside `planMode`; armed `chat.user` carries `marathon:true`. Non-boolean enabled / unknown origin / non-null plan fail closed.

### Provider
- **Unchanged.** `plan.mode {turnId, enabled}` keeps its exact shape; `browser_plan` registration, `PLAN_LIMITS` (2 nudges / 2 reminders), and the per-turn empty plan are untouched. Standing tool count stays 34; prompt guidance unchanged (17,100 ceiling unaffected).

### Sidebar (`extension/sidepanel/`)
- **`slash.js`:** `/marathon` replaces `/plan` in `SLASH_COMMANDS`; `SLASH_ALIASES {'/plan':'marathon'}` resolves the exact legacy token unlisted (no prefix filter ever shows it).
- **`app.js`:** `planModeArmed` and the per-item queued `planMode` flag are gone. The chip renders ONLY from `marathon.state` / `chat.hello` (`applyMarathonState`, fail-closed to off on malformed frames) — no optimistic flip on toggle, ×, or `/new`. `/marathon` and the chip × send `marathon.set`; toggling is accepted mid-turn. Turns render a `Marathon` badge and the checklist panel when armed (local sends from the mirrored switch; foreign turns from `chat.user.marathon`, falling back to the mirror).
- **`remote-turn.js`:** `foreignPrompt` passes `marathon` through only as an explicit boolean (`null` otherwise).
- **`plan-panel.js`:** heading "Marathon plan"; model unchanged.
- **`index.html` / `style.css`:** chip renamed `marathon-mode` (badge "Marathon", copy "Every turn uses a live checklist", × turns off); per-item queue Plan badge styles removed; reduced-motion/transparency selectors updated.

### Scripts / fixtures / tests
- **`scripts/ui-preview.mjs`:** `plan` scenario rewritten for the sticky switch (arm via `/marathon` + `marathon.state`, no-optimistic-flip assertions both ways, queue without per-item flag, `/new` chip clear only on the state frame); new `marathon` scenario (remote-origin toggle, slash both ways, carried-plan rendering placeholder, mid-turn off, hello resync, narrow layout); `slash` scenario updated (`/marathon` listed, `/plan` unlisted but executable).
- **`scripts/marathon-independent-check.mjs` (new):** the §5 M1 independent check — real Bridge + real SessionController/RemoteHub/RemoteServer + scripted runner + the REAL unpacked panel in an isolated Edge profile (no mock WebSocket).
- **Android fixtures regenerated** (`node scripts/remote-protocol-fixtures.mjs`): purely additive (`marathon` projection block + `chat.done.marathon`). The Kotlin reducer ignores unknown projection/body fields, so no Android code change was needed; `testDebugUnitTest` stays green.
- **Tests:** new `companion/test/marathon.test.mjs` (7); extended controller (+7: both directions/any turn state, sticky arming + dual flags, legacy alias both origins, legacy steer, mid-turn no re-arm, resets, restart fail-safe), bridge (+2), remote-server (+6: routes, idempotency/conflict, validation/auth/mid-turn, watch-ack 404, not-message-limited + `/new` reset, legacy remote message), hub (+5), slash (alias suite), plan-panel (heading), remote-turn (marathon passthrough).

### Docs (truthful now; full pass is M6)
- `AGENTS.md` Tools + one-runner invariants reworded for the landed M1 switch with M2–M6 marked in progress.
- `docs/STATUS.md`: behavior bullet, M1 verified numbers, and a "Still unrun" marathon entry (task-8 comparison, M2–M6, phone UI).
- `docs/REMOTE-ACCESS.md`: route tables + event list document `POST /marathon`, `POST /marathon/watch/ack`, `remote.marathon`, the `/state` marathon projection, and the dual `chat.done` flags.

## Gate results (cheapest first)

| Gate | Result | Evidence |
|---|---|---|
| `npm test` | **1085/1085 pass** (1055 pre-M1; +30). Includes the 17,100-char prompt-ceiling test and the Android reducer-fixture staleness gate. | [`m1-evidence/npm-test.txt`](m1-evidence/npm-test.txt) |
| Android `./gradlew testDebugUnitTest` (regenerated fixtures) | **BUILD SUCCESSFUL — 99 tests, 0 failures, 1 opt-in skip** | [`m1-evidence/android-testDebugUnitTest.txt`](m1-evidence/android-testDebugUnitTest.txt) |
| `ui-preview --scenario marathon` (new) | **PASS**, screenshots inspected: chip from remote origin; `toggle-pending` pixel-identical to `remote-on` (no optimistic flip); carried-plan placeholder (dock empty, chip lit); mid-turn off keeps the running checklist; narrow fits | [`m1-evidence/ui/`](m1-evidence/ui/) (`marathon-*.png`), [`m1-evidence/m1-ui-marathon.txt`](m1-evidence/m1-ui-marathon.txt) |
| `ui-preview --scenario plan` (rewritten) + `slash` | **PASS**, inspected: "Marathon plan" heading, Marathon badge, sticky chip during the turn, palette `/new /model /marathon` | [`m1-evidence/ui/plan-live.png`](m1-evidence/ui/plan-live.png), [`slash-commands.png`](m1-evidence/ui/slash-commands.png), logs `m1-ui-plan.txt` / `m1-ui-slash.txt` |
| `c1-acceptance --self-test` | **PASS** — checkers unchanged (every good evidence passes, every mutation rejected) | run output in [`m1-evidence/c1-plan-attempt2-pass.txt`](m1-evidence/c1-plan-attempt2-pass.txt) header context |
| `c1-acceptance --check plan` (isolated harness, real model, pinned 1017 @ medium) | **PASS on attempt 2** — clean, 14.1 s, 8 steps, 7 calls, 0 failed, 0 retries. Attempt 1 ended on a model `MALFORMED_RESPONSE` (broken `browser_batch` JSON at step 2 after one successful `browser_plan` call) — the pre-existing dead-step error path, not an M1 regression: the run log shows `marathon.set {enabled:true, origin:remote}`, `planMode:true` prompt, and `plan.updated` all correct. | [`m1-evidence/c1-plan-attempt2-pass.txt`](m1-evidence/c1-plan-attempt2-pass.txt) + [`c1-plan-attempt2-batch.json`](m1-evidence/c1-plan-attempt2-batch.json); attempt 1: [`c1-plan-attempt1-malformed-model-reply.txt`](m1-evidence/c1-plan-attempt1-malformed-model-reply.txt) + [`c1-plan-attempt1-batch.json`](m1-evidence/c1-plan-attempt1-batch.json) |
| Independent check (below) | **PASS** all six checks | [`m1-evidence/independent-check/`](m1-evidence/independent-check/) + [`m1-evidence/independent-check.txt`](m1-evidence/independent-check.txt) |

The c1 batch JSONs also exist under `e2e/baselines/` (the harness writes there); those copies belong to eval's directory and are **not** part of the M1 commit.

## Independent check transcript (real panel ↔ real remote API)

`node scripts/marathon-independent-check.mjs` — real Bridge (free port, own token), real SessionController + RemoteHub + RemoteServer, scripted runner (no model), and the real unpacked side panel in a throwaway Edge profile connected over a real WebSocket. State was inspected in the DOM and in `GET /state`, never inferred from tool results. Full transcript: [`m1-evidence/independent-check/transcript.json`](m1-evidence/independent-check/transcript.json).

1. **Initial:** `/state.marathon.enabled:false`; DOM chip hidden. (`00-initial-off.png`)
2. **A — remote → panel:** `POST /marathon {enabled:true}` → `200 {enabled:true, sequence:6}`; DOM chip became visible (badge "Marathon", marathon placeholder); `GET /state` `enabled:true` with matching `since`. (`01-remote-on.png`)
3. **B — panel → remote:** clicked the chip ×; `GET /state` polled to `enabled:false`; DOM chip hidden. (`02-panel-off.png`)
4. **C — slash both ways:** `/marathon` Enter → `/state` on + chip lit; `/marathon` again → chip hidden + `/state` off.
5. **D — legacy alias:** `POST /messages {planMode:true}` → `202`; the prompt sent to the runner contained `<plan_mode>`; `chat.done` `planMode:true, marathon:true`; `/state.marathon.enabled:true`; the panel rendered the foreign turn with the **Marathon** badge. (`03-legacy-plan-turn.png`)
6. **E — sticky + reset:** the next ordinary message also carried `<plan_mode>`; `POST /new` → chip hidden and `/state` off. (`04-after-new-off.png`)
7. **F — mid-turn off:** marathon on, `slow` turn running; `POST /marathon {enabled:false}` → `200`, chip hidden while `turn.status:running`; the finished turn's `chat.done` still `planMode:true, marathon:true`; the following turn's prompt had no `<plan_mode>`. (`05-mid-turn-off.png`)
8. **Journal:** 8 `remote.marathon` envelopes with the correct origins (`remote`/`ui`), contiguous sequences.

**Both directions agree; an old-shape `planMode:true` message still produces a plan turn.**

## Known notes / deliberate non-goals

- The installed v0.6.0 APK keeps working: its `/plan` sends `planMode:true`, which now turns the shared switch on (plan §9 decision 7) and arms the turn. The phone's own chip/UI rename is M5.
- A mid-turn toggle does not re-sync `plan.mode` for the running turn (verified: no second `plan.mode` frame); watcher start/stop on toggle is M3.
- Carried-plan rendering is a placeholder in the `marathon` preview scenario; `marathon.state.plan` is mirrored but not rendered until M2.
- Old saved panel history HTML may contain the previous `plan-turn-badge` class; it renders unstyled (cosmetic only).
- The user's live companion at `127.0.0.1:17871` was never touched; every run used isolated profiles/ports/homes. The extension changes require a reload in the user's profile to take effect there (M6 release step).

## Next

- eval task-8: `marathon-long` ×5 in `/marathon` vs the M0 baseline (held by eval; M2 real-model acceptance waits on it).
- M2 (task-3): plan carry-over + marathon limits per §3.2 — started after task-2 completion per lead's conditional go.

---

## task-8 acceptance (eval, 2026-11-16): marathon-long ×5 in /marathon vs clean M0 — **GREEN**

**Verdict: the M1 "done when" regression gate passes.** Completion and reliability are identical to the clean M0 baseline; the model-facing surface is byte-identical between the two pins; cost-metric differences are sampling variance with two honestly-recorded heavy-tail runs (analysis below). M2 real-model acceptance is unblocked.

### Setup and provenance (standing rule)

- Worktree `/tmp/crazyagent-m1-accept` pinned at **`d878cc8e61861ddea43b1e3a34a96a4f65396d36`** (this M1 commit); only harness/scenario/fixture files overlaid (`scripts/model-eval.mjs` with the approved additive `--marathon` flag, `e2e/scenarios/{marathon-long,stall-loop}.mjs` + README, `e2e/fixtures/marathon-*` + `stall-loop.html`); `node_modules` symlinked; fresh isolated home `/tmp/crazyagent-m1-eval/dsh-home`; never the live tree/companion/profile. `commitUnderTest` recorded in every batch JSON.
- Arming path (lead-preferred NEW switch path): per run, assert `/state.marathon.enabled === false` after `POST /new` (known initial state), `POST /marathon {enabled:true}`, assert response + projection enabled, then send a **bare prompt** (no `planMode`). Per-run `marathonArm {initialOffVerified, enabledVerified, sequence}` and batch `armingPath` recorded. `--plan`/`--marathon` mutually exclusive.
- Model/effort fixed: `deepseek/deepseek-v4.1-flash-1017` @ medium (same as clean M0).
- Controls: **negative** — `--marathon` against the pre-M1 worktree (`c2966018`) aborts exit 1 before any model send ("expected /state.marathon.enabled === false after /new, got null … refusing to run"), zero tokens spent, no silent fallback. **positive** — smoke `click-once` ×1 `--marathon` PASS (7.1 s): `marathon.set {enabled:true, origin:remote}` → `plan.mode.started` → `browser_plan`×2 → `turn.end.planOutcome=reported-complete` rev 2; batch `planMode:false, marathonMode:true`. **batch** — 5 `marathon.set` enables for 5 runs (archive-enforced); all runs `plan.mode.started`, `browser_plan` ×2–3, `planOutcome=reported-complete`. `npm test` on the M1 worktree: 1085/1085.

### Results (×5, independent checker)

| metric | M0 /plan (clean, c2966018) | M1 /marathon (d878cc8) |
|---|---|---|
| pass/partial/fail | 5/0/0 | **5/0/0** |
| valid steps per run | 12×5 | **12×5** |
| redos (duplicate step records) | 0 | **0** |
| dead turns / retries | 0 / 0 | **0 / 0** |
| wall s min–max (med) | 57.5–65.5 (61.9) | 40.2–113.8 (79.7) |
| model steps min–max (med) | 41–55 (51) | 27–75 (38) |
| tool calls min–max (med) | 40–54 (50) | 26–74 (37) |
| failed calls Σ | 5 | 12 |
| wrong-target incidents Σ | 3 | 11 |
| non-cached input Σ | 135,398 | 913,209 |
| output Σ | 22,391 | 21,650 (−3.3%) |
| cacheRead Σ | 8,819,584 | 7,061,760 (−19.9%) |

Per run: r1 98.3 s/68 steps/67 calls/10 failed · r2 52.2 s/38/37/1 · r3 79.7 s/75/74/1 · r4 40.2 s/27/26/0 · r5 113.8 s/29/28/0. All five: exactly-once 12/12 server-side step records, completion view genuine, `marathonArm` verified.

### Why GREEN despite the cost deltas

1. **Hard gates identical:** 5/5 pass, 12/12 exactly-once, 0 redos, 0 dead, 0 retries — the behaviors M1 must preserve are preserved.
2. **Model-facing surface byte-identical:** the M1 diff touches no prompt construction (`companion/prompt.mjs`), no provider/guard/executor code (`packages/dsh-browser-extension/lib/*`, `extension/sidepanel/browser.js`/`labels.js`/`views.js`/capture etc.), no `plan.js`/`plan-runtime.js` (limits and per-turn empty plan unchanged — core's report §Provider confirms). The eval path uses the background executor + remote API; the changed panel UI is not even opened. The distribution the model sees cannot have shifted systematically; observed deltas are sampling.
3. **The tails are known pre-M1 modes, both directions:** r1 hit the same `UNKNOWN_LABEL` stale-label trap M0 hit (M0: 3 incidents across 2 runs; r1: 10 before recovering — click-heavy strategy, 21 clicks + 21 batches). r5's 541k non-cached input is a **cache-miss pattern** (cacheRead only 300k, inverted from the usual cache-dominated mix) with normal output (5.6k) and few calls (28) — provider-side cache dynamics, not extra model work; the contaminated M0 pass already showed input up to 233k and steps up to 74. M1's r2/r4 were *faster* than every M0 run (52.2 s, 40.2 s) — the spread widened both ways. Output Σ is flat (−3.3%). One new-to-this-batch code, `LABEL_FAILED` (r2, frame race), is executor-side and recovered; executor code is unchanged by M1.
4. **Honest caveat:** the M1 median wall (79.7 s) sits outside the clean M0's narrow 57.5–65.5 s band; at n=5 the clean M0 band was a tight sample, not a tolerance limit. The heavy-tail runs are recorded per-run above and in the batch JSON; future milestones should keep comparing distributions and the fresh/cache token split, not medians alone. No threshold was weakened and no scenario was altered to obtain this result.

### Evidence

- M1 batch: `e2e/baselines/2026-11-17T01-32-38-512Z-m1-marathon-long-marathon.json` (commitUnderTest, armingPath, per-run marathonArm + planEvidence + logArchive)
- M1 smoke: `e2e/baselines/2026-11-17T01-31-31-194Z-m1-marathon-arm-smoke.json`
- Clean M0 reference: `e2e/baselines/2026-11-17T01-07-40-464Z-m0-marathon-long-plan-clean.json` + `docs/marathon/M0-baseline.md`
- Archived logs (gitignored, prune-safe): `.dsh-home/browser-agent/logs/m0-archive/run-2026-11-17T01-32-38-591Z-f80ac2/events.jsonl` (M1 batch, 4.3 MiB), `run-2026-11-17T01-31-31-289Z-b1e4b2/events.jsonl` (smoke)
- Harness: `scripts/model-eval.mjs` `--marathon` flag (additive; default behavior unchanged; loud pre-M1 failure; initial-state verification per run)
