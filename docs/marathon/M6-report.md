# M6 report — documents and the v2.4.0 release

**Date:** 2026-11-17 · **Task:** shared task-7 · **Plan:** `MARATHON-PLAN.md` §5 M6 + §4
**Scope:** the final documentation pass + version bumps + tag/release. Marathon work only; the maintainer's auto-updater (`cdcd9d1`) is preserved verbatim and correctly attributed. **No product behavior changed in M6** — docs + versions only.

## What changed

### Version bumps (isolated hunks, located by content)
- `package.json` `version` 2.3.0 → **2.4.0**.
- `extension/manifest.json` `version` + `version_name` 2.3.0 → **2.4.0**.
- `companion/index.mjs` `const VERSION` 2.3.0 → **2.4.0** (flows to `RemoteHub.serverVersion` → `/state server.version` and `/health`). Only the VERSION line changed; the maintainer's committed updater code in the same file was untouched.
- `android/app/build.gradle.kts` `versionCode` 5 → **6**, `versionName` 0.6.0 → **0.7.0** (lead-approved).

### Documentation (read post-`cdcd9d1` state first; reconciled, never overwrote the maintainer's updater content)
- **AGENTS.md:** preserved the maintainer's "Automatic updates fail closed" invariant **verbatim**. Reworded the Tools bullet milestone status (M1–M5 landed; M6 ships with v2.4.0) and the seeded-but-untouched rule (now real-model verified, M2 unrelated suite 5/5). Reworded the watcher bullet to M4-landed (judge wired, read-only, two-strike literal, hard signals model-independent, help/confirm exempt from ended-incomplete). Added the four missing marathon invariants: verdict-is-diagnostic (with the FALLBACK-A deviation + continuation-plan-snapshot top-v2 gap), hard-stalls-model-independent, untrusted-input (schema-validated/plain-text), cost-separate.
- **docs/STATUS.md:** marathon behavior bullet now M1–M5 landed + M4 judge + M5 phone; per-commit verified numbers (1055 pre-M1 / 1085 M1 / 1105 M2+tuning / 1152 M3 / 1214 M4 / 1237 release head); M1/M2/M3 real-model acceptance marked GREEN; **corrected the M2-tuning count** (the a31f7f9 commit message quoted 1152 — a working-tree measurement with M3 uncommitted; the tuning pin is 1105); added M4 + M5 verified-numbers entries; rewrote the still-unrun marathon entry (on-device phone marathon screens, WATCH push via conan-evo-x3, signed 0.7.0(6) APK install, real-companion phone verification); added the M4 FALLBACK-A deviation to Known limitations (label correction + lead over-strict-framing ack, gate = stuck WINDOWS 6/9=67% vs distinct 6/7=86% nuance, temp-0 non-determinism, 3/53≈0.057 caveat, intermittent-wander limitation #3/#4); added the continuation-plan-snapshot gap (TOP v2) + single-turn wander/redo flag to Follow-up candidates. Preserved the maintainer's updater verified-numbers + still-unrun entries verbatim.
- **HANDOFF.md / HANDOFF-QUICK.md:** marathon architecture + resume state (sticky switch, carry-over, watcher/judge, phone), `/plan`→`/marathon` renames, test counts → 1237 release head, marathon key files, invariant 14 (marathon state companion-owned + watcher read-only), v2.4.0 activation as pending-for-user, marathon follow-ups, "do not restart the user's live companion / reload the user's extension" + "leave the maintainer's updater untouched" notes.
- **docs/REMOTE-ACCESS.md:** verified the marathon routes (`POST /marathon`, `POST /marathon/watch/ack`), `remote.marathon`/`remote.watch` envelopes (added M4 `stuck`/`blocked` kinds + judge-driven `lastVerdict`/`lastCheckAt`), `/state marathon.watch` projection, and added the **WATCH push type + `turnId:type:ordinal` dedupe** documentation.
- **e2e/checklist.md:** `/plan`→`/marathon` roster rename; added **§6 Marathon mode** (M-A switch/chip, M-B carry-over, M-C watch alerts, M-D phone — each with the isolated/real-model DONE evidence and the live/on-device WAITING-ON-USER items); added WATCH push to C4.
- **README.md:** added "New in v2.4.0" (marathon + watcher + maintainer-attributed automatic updates + Android 0.7.0(6) APK pending); `/marathon` rename + marathon behavior in the tool reference, panel, and Android sections; bumped the headline + desktop install/update tag references to v2.4.0; **preserved the maintainer's "Automatic updates" section verbatim**; added a v2.4.0-phone-APK-pending note to the Remote setup (the published v2.3.0 APK links + SHA-256 stay intact and valid).
- **RELEASE-NOTES.md:** converted "Unreleased (post-v2.3.0)" → **# crazyAgent v2.4.0** with a marathon main body (M1–M5, verified, evidence pointers, per-commit counts) + a clearly-attributed **"Automatic updates (maintainer feature, cdcd9d1)"** subsection that preserves the maintainer's note verbatim and explicitly states the marathon acceptance evidence is marathon-scoped and the updater was NOT marathon-team-accepted. The model-pin/composer-polish note and the v2.3.0 section are preserved.

## Gate results

Verified on the working tree at the release content; **re-verified at a clean checkout of the release commit** (temp worktree + node_modules symlink) — see the verification note below.

| Gate | Result |
|---|---|
| `npm test` | **1237/1237 pass** (1214 marathon M4 head + 17 updater + 6 self-reload; the version bump did not stale the reducer fixtures — they do not record `server.version`). |
| Prompt ceiling | non-Docs **12,402** / Docs turn **18,092**; core+docs **17,096 ≤ 17,100**. Green. |
| Android reducer-fixture staleness | Green (fixtures unchanged; additive marathon fixtures already landed in M3/M5). |
| `c1-acceptance --self-test` | **PASS** (every checker accepts good evidence and rejects every mutation, incl. the real aborted-shape steer-plan fixtures). |
| Android `./gradlew testDebugUnitTest lintDebug` | **BUILD SUCCESSFUL** — 125 JVM tests / 0 failures / 2 opt-in skips, lint clean (versionCode 6 / versionName 0.7.0). First run hit the documented rare (~1/50) `RemoteControllerTest` upstream `UiState`-await timing flake (`companionRestartLeavesAnUncertainConfirmAnswerForReview`, `TimeoutCancellationException`); a forced `--rerun-tasks` passed clean — test-infra flake, not a version-bump regression (see `docs/STATUS.md` Known limitations). Evidence `m6-evidence/gradle-testDebugUnitTest-lintDebug.txt`. |

**Clean-checkout verification (DONE):** the release content was checked out into a fresh detached worktree (`f730021`) with `node_modules` symlinked and the gates re-run there (NOT the dirty main tree): `npm test` **1237/1237 exit 0**, `c1-acceptance --self-test` **PASS**, prompt **12,402 / 18,092** (core+docs 17,096 ≤ 17,100), `gradlew testDebugUnitTest lintDebug` **BUILD SUCCESSFUL** (ANDROID_HOME set explicitly; `local.properties` is gitignored). Recorded in `docs/marathon/m6-evidence/clean-checkout-verification.txt` + `gradle-clean-checkout.txt`. The maintainer's committed updater code + tests are part of the release head and run in these gates (committed product code).

## Release

- **Release commit:** the commit tagged `v2.4.0` (explicit paths/hunks; secret-scanned; staged diff reviewed — marathon docs + version bumps only, no updater code/doc modification). The release content was gate-verified at clean checkout `f730021`; the tagged commit differs only by this report's release-metadata fill-in.
- **Tag:** `v2.4.0`.
- **GitHub release:** published via `gh` (authenticated as `conan-8`, matching the established v2.3.0 flow).
- **Signed Android release-APK asset (`0.7.0 (6)`):** **PUBLISHED 2026-11-17** by the maintainer from the tagged source. SHA-256 `863fb04cd028f02cd574e68cd8e8c82a0c7af8a273796892d9f5776edb2f9592`; `apksigner verify` accepted its v2 signature with the existing release certificate. The README/install flow and GitHub release reference this exact APK.

## Activation — PENDING FOR USER (manual)

The marathon team did **not** restart the user's live companion (`127.0.0.1:17871`) or reload the user's browser extension — both affect the user's live environment and are manual user steps (standing safety rule). To activate v2.4.0:
1. Reload the unpacked extension in `chrome://extensions` / `edge://extensions` and reopen the side panel **first**.
2. Restart the companion via its existing startup method (scoped process management; preserve model/key/pairing).
3. Verify `/health` `ok/ui/tools:true` and `/state server.version` = `2.4.0`.

From the release after v2.3.0, the maintainer's auto-updater keeps standard supervised installations current (README "Automatic updates"); v2.3.0 and older need one manual update. Isolated-profile acceptance already verified the extension code; the live docked-panel + on-device phone marathon acceptance remains the user's (see `docs/STATUS.md` Still unrun + `e2e/checklist.md` §6).

## Maintainer auto-updater — attribution and exclusion

The maintainer's auto-updater (`companion/updater.mjs`, `extension/self-update.js`, + index/bridge/dev/service/background edits, and README/PRIVACY/RELEASE-NOTES/AGENTS/STATUS doc updates) was committed by the maintainer at `cdcd9d1`. The marathon team left it **100% untouched** (no revert/commit/stash) and excluded it from every marathon commit. It is committed product code in the v2.4.0 release head, verified by its own tests (17 updater + 6 self-reload) + the maintainer's real scratch-clone update — **not independently accepted by the marathon team**. The marathon acceptance evidence (M0–M5) is marathon-scoped. The AGENTS.md "Automatic updates fail closed" invariant and the maintainer's README/RELEASE-NOTES updater content are preserved verbatim.

## Marathon deviation carried into the release docs (M4 FALLBACK A)

Per lead ruling, recorded in AGENTS.md / STATUS.md / RELEASE-NOTES.md / M4-report: the v1 judge (low-effort #3, text-only #4, cadence-sampled) catches sustained obvious stalls + every hard signal with **zero false alerts on healthy runs** (0/53 replay fine; live 15/15), but intermittent varied-activity wander can read as progressing/unknown. Gate = stuck **WINDOWS** 6/9 (67%) vs ≥80% target (distinct-run 6/7 = 86% nuance). Label correction: `m0Stall-r4` is a STUCK true positive (lead's earlier "zero alerts on honest runs" framing was over-strict, acknowledged). Temp-0 judge non-determinism (earlier 0-fine partly luck); 3/53≈0.057 caveat. **Top v2 follow-up:** the continuation-plan-snapshot product gap (provider emits no plan activity for the M2 seed → ledger has no plan until the first `browser_plan` call → open-flat can't fire on continuation wander); fix = surface the seed plan to the ledger at turn start. Plus the single-turn wander/redo fidelity flag (eval mode-rate analysis).

## Pending after M6
- Activation (extension reload + companion restart) — manual user step.
- Live docked-panel marathon visual acceptance; on-device phone marathon screens; WATCH push delivery via `conan-evo-x3`; real-companion phone verification.
- v2 follow-ups: continuation-plan-snapshot gap (top), single-turn wander/redo, M4 stuck-window improvement.
