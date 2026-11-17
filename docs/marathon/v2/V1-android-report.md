# V1-android report — alert lifecycle on the phone

**Date:** 2026-11-17 · **Task:** shared task-15 · **Plan:** `MARATHON-V2-PLAN.md` §3.2 + §5 V1 + §6
**Branch:** `v2/v1-android` (worktree `/tmp/crazyagent-v2-v1-android`), base main `8220205`.
**Scope:** the Android slice of V1 — lifecycle reducer semantics, the `marathon-watch-lifecycle.json` fixture recorded from the real RemoteHub, JVM proofs, and the fake-companion lifecycle run. Core owns the companion/panel/hub side (task-14).
**Status:** all gates green. **No on-device work, no re-pairing, no push delivery claims.**

## Headline finding: zero production reducer change

The M5 reducer already implements the V1 semantics, exactly as §3.2 anticipates ("old clients already treat any state other than `open` as not actionable"):

- `remote.watch` handling is state-generic: any non-`open` state clears `marathon.watch.open` and collapses the card. `state:'closed'` is therefore treated **exactly like `dismissed`** — not actionable, amber cleared (`WatchNotice.actionable` gates on `state == "open"` plus the actionable kinds; this is the member lead's note called `ChatState.isActionable`).
- `ended-incomplete` stays actionable while open; the ack's dismissed frame (now **200**, core's V1 watcher remembers the id) closes it. The M5 404-tolerant path remains for old companions.
- `chat.user` keeps an open alert (hub parity) but drops a collapsed summary — with V1's close frame arriving **before** the new turn's first frame, the amber chip never carries into a new turn.
- `/new`, a chat switch, and marathon off clear everything (unchanged).

The deliverable is therefore the proofs + the recorded fixture + the lifecycle run, not a behavior patch. Old-APK compatibility is inherent: an M5 APK receiving `closed` collapses the card through the same generic path (tested explicitly for `closed`, `dismissed`, `recovered`, and unknown future states).

## Provenance / merge

- Core's V1 lifecycle branch `v2/v1-lifecycle` at **`c0d89d5`** (watcher `a432450`, controller `fa91f67`, hub tests `ecbf1bb`, remote-server ack `c0d89d5`) was merged into `v2/v1-android` (merge commit `75ff9c2`) for the fixture recording and the fake-companion gate, as core instructed.
- **The hub's production code is unchanged by V1** — `#onWatch` has journaled `remote.watch` and cleared `watch.open` for any non-open state since M3 (core's `ecbf1bb` adds tests only; `git diff main..c0d89d5 -- companion/remote-hub.mjs` is empty). The fixture is recorded from that real hub, driven by the V1 frame sequence.

## What changed (this branch, explicit paths)

### Increment 1 — `9e96bfd` (JVM proofs, no production change)
- **`MarathonLifecycleTest.kt` (new, 9 tests):** closed-at-turn-end ≡ dismissed; supersede (alert closed under its own id + ended-incomplete as the ONE open notice); closed before the new turn's first frame; open alert holds across `chat.user` until its close frame (old-companion parity); ended-incomplete actionable until dismissed/closed; one-open-notice invariant; `/new` + marathon off clear; old-APK compatibility (every non-open state not actionable, unknown envelope ignored); resync parity after close and with an open ended-incomplete.
- **`FakeCompanion.closeWatchAlert`** scenario control emitting the exact agreed frame (`kind:'info'`, `state:'closed'`, own id, `blocker:null`, `signals:[]`, `source:'heuristic'`).
- **`RemoteControllerTest` (+3):** closed collapses through the real client; ended-incomplete dismissable with ack 200; amber never carries into a new turn.

### Increment 2 — this commit (fixture + docs + evidence)
- **`scripts/remote-protocol-fixtures.mjs`:** new `marathonWatchLifecycle` scenario — alert open → supersede (closed `Turn ended.` + ended-incomplete open) → closed `A new turn started.` **before** `chat.user` → second ended-incomplete → ack `Dismissed.` → new-chat reset. Four hub checkpoints (`afterAlert`, `afterSupersede`, `afterNextTurnStart`, `afterSecondEnded`).
- **`android/.../remote-protocol/marathon-watch-lifecycle.json` (new):** recorded from the real RemoteHub in the merged tree; the seven existing fixtures are **byte-identical**; staleness gate green.
- **`ReducerFixtureTest.marathonWatchLifecycleMatchesHubProjection`:** full replay == hub final projection; every checkpoint reached live; close-frame ordering asserted by index; dismissal and reset verified. Added to `resyncFramesAreOnlyEverFirst`.
- **`android/README.md`:** the V1 lifecycle paragraph (explicit closes, dismissable ended-incomplete, amber never carries, old-APK behavior).
- **Evidence + reproducible driver:** `v1-android-evidence/drive.mjs` (portable; `--expect-v1` asserts, default records a baseline), the pre-V1 baseline transcript, the post-V1 transcript, npm/gradle logs.

## The lifecycle run (independent surface: GET /state + /events)

`drive.mjs` against the real fake companion (real RemoteServer + RemoteHub + SessionController + V1 watcher; isolated port 0 + own token; never the live companion):

- **A — alert open at a user stop:** mid-turn `TOOL_HANG` alert, then `POST /stop`.
- **B — ended-incomplete left open into the next turn:** `marathon-stuck` ends PARTIAL → ended-incomplete open → next message sent without acking.
- **C — ended-incomplete acked:** another `marathon-stuck` → ended-incomplete open → `POST /marathon/watch/ack`.

**Pre-V1 baseline (G5 reproduced, `baseline-pre-v1.json`):** A left `marathon.watch.open = TOOL_HANG` after the stop with **0** close frames; B's ended-incomplete stayed open **during the next turn** (amber carried); C's ack returned **404 WATCH_NOT_FOUND** and the notice stayed open.

**Post-V1 (`fake-companion-lifecycle-post-v1.json`): ALL 8 CHECKS PASS** —
1. A: close frame for the alert's own id, reason `Turn ended.`; `/state` open null.
2. B: close frame for the ended-incomplete id, reason `A new turn started.`, **seq 75 < chat.user seq 76**; `/state` open null during the new turn.
3. C: ack **200 acknowledged**; dismissed frame (`Dismissed.`) on the stream; `/state` open null.

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| Baseline `npm test` at base (main 8220205) | **1237/1237** | worktree run (lead's opening gate reproduced) |
| `npm test` post-merge + fixture (staleness incl.) | **1254/1254 pass, 0 fail** (1237 + core's 17 V1 tests; fixture gate covers the new JSON) | [`v1-android-evidence/npm-test.txt`](v1-android-evidence/npm-test.txt) |
| `./gradlew testDebugUnitTest lintDebug` | **BUILD SUCCESSFUL — 138 tests, 0 failures, 2 opt-in skips; lint clean** (125 prior + 13 new JVM tests) | [`v1-android-evidence/android-testDebugUnitTest-lintDebug.txt`](v1-android-evidence/android-testDebugUnitTest-lintDebug.txt) |
| Opt-in `LiveFakeCompanionTest` vs the V1 fake (17894, isolated token) | **2/2 ran, 0 failures** (real JVM client incl. the M5 marathon-stuck scenario under V1 lifecycle) | [`v1-android-evidence/android-livefake-V1.txt`](v1-android-evidence/android-livefake-V1.txt) |
| Fake-companion lifecycle run (`--expect-v1`) | **ALL 8 CHECKS PASS**; pre-V1 baseline reproduces G5 | [`v1-android-evidence/fake-companion-lifecycle-post-v1.json`](v1-android-evidence/fake-companion-lifecycle-post-v1.json), [`baseline-pre-v1.json`](v1-android-evidence/baseline-pre-v1.json) |

## Deliberate notes

- The collapsed `closed` summary is transient above the composer (dropped at the next `chat.user`, not reconstructible from the projection) — same rule as M5's dismissed/recovered collapse; the fixture checkpoints only at open-or-null states.
- The ack reason for ended-incomplete is `Dismissed.` (no snooze — there is no next tick to suppress, per §3.2); mid-turn alert acks keep the 15-minute snooze wording. The reducer is reason-agnostic.
- The fixture's turn-end ordering (closed alert → ended-incomplete → `chat.done` → `chat.turn`) mirrors the V1 watcher/controller emission order core confirmed.
- No push behavior changes in V1; delivery remains never-proven (below).

## Still unrun (user; V10 → docs/STATUS.md)

- The on-phone appearance of the lifecycle (card collapse at turn end, dismissable ended-incomplete, chip never amber into a new turn).
- Push delivery via `conan-evo-x3` (unchanged by V1; needs the service-account key + companion restart there; the phone stays paired with it).

## Next

- task-20 (V6 live checklist) once V1 merges; then task-21 (V7 test notification).