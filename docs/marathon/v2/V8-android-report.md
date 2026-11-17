# V8-android report — blocked-item reason on the phone

**Date:** 2026-11-17 · **Task:** the android slice of shared task-22 (core owns V8) · **Plan:** `MARATHON-V2-PLAN.md` §3.9 + §5 V8 + §6 (G7)
**Branch:** `v2/v8-android` (worktree `/tmp/crazyagent-v2-v8-android`), base main `2c933fd` (descends from `b3e10e1`), with core's V8 merged: `d21b877` (production) + `f5a5b6b` (tests/report). **V8 merges as a unit AFTER V5** (lead timing); this branch carries core's V8 + the android slice.
**Scope:** the phone reducer accepts and keeps the optional blocked-item `reason`; the checklist card renders it under the blocked item; the real-hub fixture carries it live and through the carry-over. The model-facing tool change and its real-model gate are core's/eval's (sign-in-wall/stall-loop/marathon-long ×5, PLAN_* failures ≤2 — later).
**Status:** slice gates green. No on-device work, no re-pairing, no delivery claims.

## What changed

### `c3601bf` — reducer + card + fixture + tests
- **`MarathonPlanItem.reason: String?`** (default null — old frames and old APKs unaffected).
- **`planItemsOf` mirrors `normalizeMarathonPlan` by construction** (one shared path for live `remote.plan` and carried `marathon.plan`):
  - reason allowed **only on `blocked`** items;
  - single line — any control char (`≤0x1f`, `0x7f`, so no newline/tab) rejects;
  - non-blank after trim, **raw length ≤240**; kept **trimmed**;
  - a **present-but-invalid** reason (including JSON `null` or a non-string) rejects the **whole plan** fail-closed, exactly like the hub validator: a malformed `remote.plan` keeps the last good live plan; `chat.turn`/projection/carried plans go null (switch state intact).
  - Absent reason → null field; the hub never emits reason on non-blocked items (upstream `PLAN_REASON_STATUS`), and the reducer would reject such a frame anyway.
- **Checklist card:** the reason renders **under the blocked item** — muted italic 11sp, line-height 1.4, aligned to the content column (panel `.plan-panel-item-reason` parity), as **plain text** (model-reported, untrusted — never markdown/HTML).
- **`marathon-live-plan.json` re-recorded from the real RemoteHub** with core's V8 validators: rev2's third item is `blocked` with reason "The confirmation page never loads.", live (`remote.plan`) and through the turn-end carry-over (`remote.marathon`); a reason on a non-blocked item is ingested and **dropped** (3 `remote.plan` envelopes for 5 activities). The other eight fixtures are byte-identical; staleness gate green.
- **Tests (+4 JVM):** reason kept live + carried (non-blocked items null); trimmed storage + the exact 240 bound; a 10-shape invalid-reason matrix (non-blocked ×3, null, non-string, blank, 241 chars, newline, tab, control char) with keep-last-good live and null turn/carried; resync parity with reason. The fixture test asserts the reason at every checkpoint (livePlan2, awaiting, afterTurnEnd) plus the updated open counts (blocked is not open).

### Commit 2 — docs
- `android/README.md`: the V8 paragraph (rules, display, carry-over, old-APK additive).

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| Baseline `npm test` at base + core V8 merge | **1303/1303** (before core's test commit), **1315/1315** after `f5a5b6b` | worktree runs |
| `npm test` final (fixture staleness incl.) | **1315/1315 pass, 0 fail** | [`v8-android-evidence/npm-test.txt`](v8-android-evidence/npm-test.txt) |
| `./gradlew testDebugUnitTest lintDebug` | **BUILD SUCCESSFUL — 154 tests, 0 failures, 3 opt-in skips; lint clean** (150 prior + 4 reason tests) | [`v8-android-evidence/android-testDebugUnitTest-lintDebug.txt`](v8-android-evidence/android-testDebugUnitTest-lintDebug.txt) |

The fixture is the independent check: frames recorded from the **real hub running core's V8 validators**, replayed by the phone reducer to the hub's own projections at four checkpoints — reason present exactly where the hub puts it, nowhere else.

## Old-APK compatibility

`reason` is an additive item field. An M5–V7 APK's item parse keeps `content`/`status` and ignores the unknown key (it never rejected unknown item keys — only the upstream provider did, which is why core's carry-chain fix mattered). Nothing else on the wire moved.

## Coordination / merge timing

- Core's V8 production (`d21b877`) + tests/report (`f5a5b6b`) are merged into this branch so the fixture recording and gates run against the real V8 validators. **Lead merges V8 as a unit (core JS + this android slice) after V5**; then eval runs the V8 live gate.
- The fake companion's scripted plans carry no blocked-with-reason item, so the opt-in live JVM tests are unchanged (they still pass under the merged tree — the 3 skips are the usual opt-in ones). The reason path is proven by the reducer tests + the real-hub fixture; the on-phone appearance remains still-unrun.

## Still unrun (user / eval; V10 → docs/STATUS.md)

- The on-phone appearance of the reason under a blocked item.
- The V8 real-model gate (eval: sign-in-wall/stall-loop/marathon-long ×5 vs M4 live; PLAN_* failures ≤2, pass rates unchanged) — after the unit merge.