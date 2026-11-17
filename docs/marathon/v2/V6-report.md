# V6 report — live checklist on the phone

**Date:** 2026-11-17 · **Task:** shared task-20 · **Plan:** `MARATHON-V2-PLAN.md` §3.7 + §5 V6 + §6 (G6)
**Branch:** `v2/v6-liveplan` (worktree `/tmp/crazyagent-v2-v6-liveplan`), base main `f08b57c` (V1 merged).
**Scope:** the hub's live-plan forwarding (`remote.plan` + `/state.turn.plan`), the Android reducer/card, the `marathon-live-plan.json` fixture from the real hub, and the JVM proofs incl. the opt-in live mid-turn test. The hub is android's for V6; core keeps ledger/watcher/judge/controller (disjoint). Panel unchanged (already live).
**Status:** all gates green. **Still needs the user: the on-phone appearance** (below). No on-device work, no re-pairing, no push claims.

## What changed (three increments)

### `c63124b` — increment 1: the hub
- **`#onActivity` kind `plan`** (active turn only): validation **reuses `normalizeMarathonPlan` by construction** — the activity's `revision`/`items` go through the exact carried-plan rules (placeholder `updatedAt`/`turnId` markers discarded; read-only probe verified every malformed shape fails closed to null). Malformed frames are **dropped**, never a partial plan.
- **Dedupe:** an identical consecutive plan (same revision, items, awaitingUser) publishes nothing — a V4 seed re-emit of the same list is a no-op, matching the panel's same-revision behavior.
- **`remote.plan`** envelope `{turnId, revision, items, awaitingUser}` — journaled and replayed like `remote.marathon`/`remote.watch`, **not** a committed message (projection-authoritative on resync). `awaitingUser` passes through (`frame.awaitingUser === true`).
- **`/state.turn.plan`**: `this.turn.plan` rides `turnProjection()` (and therefore `chat.turn` at boundaries). `turnProjection` **deep-copies** the plan like the carried plan — a copy-safety test caught and fixed a shallow-copy aliasing bug (a projected item mutated by a client would have touched the hub mirror).
- **Boundaries:** `plan: null` at turn start, turn end (**`remote.marathon` carry-over unchanged**), and session reset.
- **Tests (+7):** ingest/projection/copy-safety, the malformed matrix (11 shapes), dedupe + awaitingUser/revision changes, active-turn guard, boundary clears + carry-over handoff, journal/replay/resync, `chat.turn` boundary shape.
- **Fixtures regenerated additive-only:** `"plan": null` on every turn object (8 files; the diff is `plan:null` + trailing commas). The M5 reducer ignores the additive field — old APKs keep today's behavior.

### `e40d8a3` — increment 2: Android + fixture
- **`ChatState`:** `TurnPlan {revision, items, awaitingUser}` (+`openCount`); `TurnInfo.plan` (null at every boundary).
- **`ChatReducer`:** `remote.plan` case — fail-closed (a malformed envelope keeps the last good plan); `turnOf` parses the projection's `turn.plan`; `chat.session` clears it; `chat.user`/`chat.turn` already reset the turn. Shared `planItemsOf` rules for live and carried plans (1–40 items, non-blank unique content, the four statuses).
- **`ChatScreen`:** the collapsible checklist card renders the **live plan during the turn** (`turn.plan`) and the **carried plan between turns** (`marathon.plan`), header **"Revision N · X open of Y"**; a quiet "Waiting for your reply" line when `awaitingUser`. The card takes `(revision, items)` — no synthetic markers; collapse choice preserved.
- **`marathon-live-plan.json`** recorded from the **real RemoteHub**: rev1 mid-turn → malformed activity dropped (3 envelopes for 4 activities) → rev2 → `awaitingUser:true` → turn end (`chat.done` → `chat.turn` plan:null → carried `remote.marathon` rev2, the controller's emission order) → new-chat reset. Four checkpoints (`livePlan1`, `livePlan2`, `awaiting`, `afterTurnEnd`); the eight existing fixtures byte-identical; staleness gate green.
- **Tests:** `MarathonLivePlanTest` (7: mirror, fail-closed matrix, boundaries, `chat.turn` authority, resync parity, carry-over unchanged, summary text) + `ReducerFixtureTest.marathonLivePlanMatchesHubProjection` (full replay == hub projection, every checkpoint reached live, envelope count proves the malformed drop).

### Increment 3 (this commit) — live gate + docs
- **`scripts/fake-remote-companion.mjs`:** the `requestPlan` hook now feeds **both** the controller (carry-over snapshot) **and** the hub (live `remote.plan`) — exactly the real companion's `onActivity` routing. The M5 hook only fed the controller, which is precisely why the phone never saw live plans (G6); the first live run exposed it (timeout), the fix is one hook.
- **`LiveFakeCompanionTest.marathonLiveChecklistUpdatesMidTurn`** (opt-in): the real phone client against the real Node fake — rev1 renders **live while the turn runs** (3 items, 3 open, carried plan still null), rev2 advances, turn end clears `turn.plan` and hands off to the carried rev2 (completed/in_progress/pending). Ends with a new-chat reset so the live tests are order-independent (the first run also caught a shared-state leak between the two marathon live tests).
- **`android/README.md`:** live-checklist behavior + test inventory.

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| Baseline `npm test` at base (f08b57c) | **1257/1257** (lead's integration number reproduced) | worktree run |
| `npm test` final (hub tests + staleness incl. new fixture) | **1264/1264 pass, 0 fail** | [`v6-evidence/npm-test.txt`](v6-evidence/npm-test.txt) |
| `./gradlew testDebugUnitTest lintDebug` | **BUILD SUCCESSFUL — 147 tests, 0 failures, 3 opt-in skips; lint clean** (138 prior + 7 live-plan + 1 fixture parity + 1 live test) | [`v6-evidence/android-testDebugUnitTest-lintDebug.txt`](v6-evidence/android-testDebugUnitTest-lintDebug.txt) |
| Opt-in `LiveFakeCompanionTest` vs the V6 fake (isolated 17895, own token; stopped by PID after) | **3/3 ran, 0 failures** — incl. `marathonLiveChecklistUpdatesMidTurn` (live rev1 mid-turn → rev2 → handoff) | [`v6-evidence/android-livefake-V6.txt`](v6-evidence/android-livefake-V6.txt) |

## Independent check (what proves the live update)

The opt-in JVM test drives the **real client** (`RemoteController` + reducer) against the **real Node remote API** (RemoteServer + RemoteHub + SessionController + scripted runner) and asserts on the client's state derived from the wire: `turn.plan.revision == 1` **while `turn.isActive`** and `marathon.plan == null` (the carried list is not published mid-turn), then the rev2 advance, then `turn.plan == null` + `marathon.plan.revision == 2` at rest. The fixture independently pins the hub's exact envelope/journal/projection output, and the hub tests pin validation/dedupe/replay. The malformed-drop is proven twice: hub test (no envelope, last good plan survives) and fixture frame count (3 `remote.plan` for 4 activities).

## Old-APK compatibility (additive by design)

- `remote.plan` is an unknown envelope to an M5 APK → ignored (existing else branch); the turn-end carried checklist keeps working.
- `turn.plan` is an additive projection/body field → absent in old parses, null default.
- The regenerated fixtures' only delta is `plan: null` on turn objects; the M5 reducer replayed them green before the Android change landed (increment 1's gradle gate).

## Coordination notes

- **V4 (core):** the seeded plan activity `{kind:'plan', revision, items, awaitingUser:false, seeded:true}` flows through the same ingest; the dedupe makes a same-list seed re-emit a no-op. No shape change needed; core pinged.
- **V2–V5 (core/judge):** disjoint files (ledger/watcher/judge/controller untouched here). The hub's plan ingest does not feed the ledger — that routing is core's `noteActivity`/publish path, unchanged.
- The fake's `requestPlan` routing fix mirrors `index.mjs` `onActivity`; no companion production file outside `remote-hub.mjs` was touched.

## Still unrun (user; V10 → docs/STATUS.md)

- The on-phone appearance of the live checklist (mid-turn updates, collapse behavior, the awaiting-user line).
- Push delivery via `conan-evo-x3` (unchanged by V6).

## Next

- task-21 (V7 test notification) after V6 merges; branch `v2/v7-pushtest` from the merged main.