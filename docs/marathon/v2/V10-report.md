# V10 report — documents and v2.5.0 release

**Date:** 2026-11-17 · **Task:** task-24 (core) · **Plan:** `MARATHON-V2-PLAN.md` §5 V10 + §6
**Branch:** `v2/v10-release` rebased onto final merged main `5bc4f6a` (V0–V8 + V5-live/V8-live evidence; npm 1315). **Status:** FINAL — V5 live + V8 live done-when MET (lead FINAL GO); lead reviews + merges + tags `v2.5.0` + publishes. Activation stays the user's.
**Acceptance is marathon-scoped.** The maintainer's auto-updater (`cdcd9d1`) is preserved verbatim — NOT marathon-accepted. Activation stays the user's: reload the unpacked extension first, then restart the companion.

## Versions (explicit hunks, never sweep the updater)
- `package.json` + `package-lock.json` (root + workspace `dsh-browser-extension`): **2.5.0**.
- `extension/manifest.json`: `version` + `version_name` **2.5.0**.
- `companion/index.mjs`: `const VERSION = '2.5.0'` (located BY CONTENT, explicit hunk).
- `android/app/build.gradle.kts`: `versionCode 7`, `versionName "0.8.0"`.
- Dependency versions (`tslib ^2.4.0`, `@modelcontextprotocol/* 2.4.0`) and the updater's comment/test fixtures (`cdcd9d1`) preserved verbatim.

## Documents updated (draft)
- **AGENTS.md:** v2 invariants — V3 page-scoped REVISIT_HINT (same page+control+outcome, threshold 2, unknown excluded; REPEAT_LOOP unchanged; digest annotation removed measurement-justified, pageKey replay-only); V4 seed-visible activity + internal carry chain (≤3 ancestors clip500, never published/never in agent prompt) + buildDigest carriedFrom/seededRevision; V8 blocked-only reason + prefix identity + PLAN_IN_PROGRESS_REQUIRED guidance + all carry-chain validators keep reason. V5 invariant (pinned morph/fp8 + seed, effort low/max_tokens 400) already landed by judge. Watcher report-only kept.
- **docs/STATUS.md:** marathon behavior bullet v2 (V1–V8) summary + V5 breakthrough; consolidated v2 numbers section (V0 corpus 157/collection 30 zero FA; V1 stale 0; V2 live suspect 86.0%≤90.4%; V3 holdout 0.920 + trade-off; V4 redo 0/5 silent seeded 5/5 + model-variance; V5 caught 1.000/stability 1.000 both splits cost ~1×; V6/V7/V8); Known limitations V5 closed the temp-0 instability (historical 6/9+3/53 kept as pre-V5 record); Follow-ups TOP v2 continuation-snapshot RESOLVED by V4 + new v2 follow-ups; Still unrun V6/V7/V8 on-phone + 0.8.0(7) APK.
- **RELEASE-NOTES.md:** new v2.5.0 top section (marathon v2 V1–V8, marathon-scoped acceptance, activation user's, still-unrun, V9 deferred); v2.4.0 notes preserved below INCLUDING the auto-updater verbatim.
- **HANDOFF-QUICK.md:** current build table → v2.5.0 draft (Android 0.8.0(7)); watcher row v2 + V5 closed FALLBACK A; tests row 1315 + v2 chain.
- **HANDOFF.md:** marathon architecture v2 (V1–V8); version 1315 v2.5.0 draft; acceptance pending v2 on-phone + 0.8.0(7) + docked-panel visual.
- **docs/REMOTE-ACCESS.md:** `POST /push/test` route (V7, idempotent/1-min/test type); `remote.watch` state gains `closed` + V1 close-frame lifecycle; new `remote.plan` live-plan bullet (V6 hub forwarding, normalizeMarathonPlan validation, dedupe, /state.turn.plan, V8 blocked reason) distinct from remote.marathon.plan carried snapshot.
- **e2e/checklist.md §6:** intro M1–M5 + v2 green; M-C FALLBACK A → closed by V5; new M-E v2 subsection (done + WAITING ON USER on-phone V6/V7/V8 + recorded follow-ups).
- **README.md:** download link v2.5.0; new "New in v2.5.0" section; install/update instruction prompts v2.4.0→v2.5.0; v2.4.0 historical section + updater preserved.

## Consolidated v2 numbers (from V*-reports)
| Milestone | Key result |
|---|---|
| V0 | corpus 157 windows (52 fine/8 stuck gated/70 legacy); collection 30 runs 27/30 PASS, 1 true-positive, 0 false |
| V1 | explicit close-frames; stale alerts 0 every surface |
| V2 | npm 1285; live all-4 green; healthy epic suspect 86.0% ≤ V0 90.4% |
| V3 | npm 1293; holdout k5 caught 0.920≥V2; live FA0 ×10 + 0 healthy mutation-revisits; tune trade-off documented |
| V4 | npm 1303; replay no-regression FA0; live redo 0/5 + silent + seeded 5/5; model-variance seeded-untouched ~60% + c1 row brittleness |
| V5 | pinned morph/fp8 + seed:42; caught 1.000/stability 1.000 BOTH splits k5; FA0; cost ~1×; FALLBACK A closed |
| V6 | hub remote.plan + /state.turn.plan; real-hub fixture; JVM proofs; on-phone unrun |
| V7 | POST /push/test + test type + Settings button; delivery needs conan-evo-x3 key+restart |
| V8 | npm 1315; blocked-only reason + prefix identity; c1 self-test; gradle 154/0; live PLAN_* ≤2 gate running |

## Gates (draft)
- npm test + prompt ceiling: re-verified at the draft head (see commit log; final re-verify at the release head after V5+V8 live green).
- Secrets scan: staged diffs explicit-path only; no secrets.
- Updater isolation: `cdcd9d1` comment/fixtures preserved verbatim; only the four version files + workspace package bumped.

## Still unrun / follow-ups (recorded)
- **Still unrun:** WATCH/test push delivery via `conan-evo-x3` (key + restart, user action); on-phone V6/V7/V8 appearance; live docked-panel visual; V8 real-model PLAN_* gate outcome; 1017 full reliability batches; signed 0.8.0(7) APK install.
- **Follow-ups:** V3 tune caught trade-off (multi-page stuck corroboration; restored by V5); model-variance seeded-untouched ~60% + c1 steer-plan row brittleness; epic-120 completion-view reload-reset tolerance; REPEAT_LOOP multi-page residual; **V9 restart persistence DEFERRED (decision #10)**; **V5.1 judge token budget (task-25, judge post-release)** — V5-live bounded risk: long-turn ~20–24k-char digests consume v1 `max_tokens:400` by low-effort reasoning → `finish_reason:LENGTH` defensive `unknown`s (c3 stabilizes routing not token budget; hard stalls alert unconditionally, so only large-digest varied-activity wander can evade judge corroboration); fix = `max_tokens` 400→1200 keeping low effort + c3 routing/seed, isolated from c2's effort raise; monitor schema-deviation `unknown` rate.

## Finalize checklist (V5+V8 live green — lead FINAL GO)
1. ✅ Rebased `v2/v10-release` onto final merged main `5bc4f6a` (V0–V8 + V5-live/V8-live evidence; npm 1315).
2. ✅ Re-verified full npm test **1315/1315** + prompt ceiling at a clean checkout (non-Docs **12,402** / Docs turn **18,092**; core+docs 17,096 ≤ 17,100).
3. ✅ V8 live PLAN_* **2 ≤ 2** + pass-rates/end-distributions unchanged vs M4 (9 OPEN_REMOVAL_ACK eliminated); V5 live caught **4/4 = 100%**, FA0 worst healthy, falseRec 0, 4 true-positive alerts server-verified (epic r3/r5 wander loops), 12 length-cutoff unknowns documented (V5.1).
4. ✅ Versions **2.5.0** (package.json/lock root+workspace, manifest version+version_name, companion/index.mjs VERSION by content) + Android **0.8.0 (7)**. Build/unsigned release APK SHA-256 recorded below; the **signed** APK is a user-keystore action (still-unrun, as v2.4.0 artifact `8c74976`) — not claimed signed.
5. ✅ Updater `cdcd9d1` preserved verbatim (comment + test fixtures); marathon-scoped acceptance only.
6. ✅ Lead reviewed, merged, tagged `v2.5.0` (`b2ef9eb`), and published the GitHub release (2026-11-17T20:04:26Z, Latest, no assets attached). Activation stays the user's (reload extension then restart companion).

## Post-release review (2026-11-17)
An independent review of the release found two bugs, fixed on `main` after the tag (see `RELEASE-NOTES.md` "Unreleased" and `docs/STATUS.md`): the judge's Morph routing pin was sent for every model and base URL, which made judge calls fail for models Morph does not serve; and the judge-budget notice replaced an open alert on every surface. It also found that the per-turn judge budget runs out about 35–45 minutes into a turn (STATUS follow-up 8). V9 was deferred by the lead under delegated authority (`LEAD-LOG.md` ruling 1), not by the user.

## Build artifact
- Unsigned release APK (`assembleRelease`, no `keystore.properties`, BUILD SUCCESSFUL): `app/build/outputs/apk/release/app-release-unsigned.apk`, SHA-256 **`1de9dfea10800bada737d64336a8307dadaade917927ad9d61682896871e9200`**. Signing with the maintainer keystore + publishing the signed `0.8.0 (7)` APK is the user's action (still-unrun, as the v2.4.0 artifact `8c74976`); the unsigned APK is not installable.
