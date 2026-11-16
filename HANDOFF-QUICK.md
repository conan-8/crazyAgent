# crazyAgent — quick handoff

Current snapshot: **2026-11-16**. This file is the short **resume state**. Read `HANDOFF.md` for architecture and invariants, `docs/STATUS.md` for current behavior + latest verified numbers + the still-unrun list, and `e2e/checklist.md` for live acceptance. Release notes live in `RELEASE-NOTES.md`; retired working documents and older changelogs are archived verbatim in `docs/HISTORY.md`; turn history is in the debug logs.

## Resume

```sh
cd /home/conan/Documents/GitHub/crazyAgent
curl -s http://127.0.0.1:17871/health   # expect ok:true and tools:true when configured
npm test
npm run system-prompt                 # add -- --json for counts
```

Restart the companion after companion/provider/config changes. After `extension/` changes, reload the unpacked extension and reopen the side panel. Do not assume a recorded PID, connection, or model configuration is still current; check health and Settings.

## Current build

| Item | State |
|---|---|
| Release | **[v2.3.0 released](https://github.com/conan-8/crazyAgent/releases/tag/v2.3.0)** (tag `v2.3.0`, GitHub release published 2026-11-16; manifest/package/companion `2.3.0`; signed Android `0.6.0 (5)` APK published as `app-release.apk`, SHA-256 `3149a0f2…ed9784`, same signing certificate as before) |
| Tools | **34 standing model-facing:** 25 general + 8 guarded Docs tools + `agent_request_help`; conditional `browser_plan` only during exact-`/plan` turns and conditional `agent_request_confirmation` only while the companion's opt-in `confirmIrreversible` setting is on (both can coexist) |
| Default model | **OpenRouter `deepseek/deepseek-v4.1-flash-1017`** (pinned 1017 snapshot, switched 2026-11-16). Every live default/config/instruction references it; the un-pinned alias remains only in dated run records. Smoke on the pinned ID: `form-submit` ×1 **PASS** (`e2e/baselines/2026-11-16T23-41-31-295Z-model-1017-smoke.json`); full reliability batches on 1017 are still unrun |
| Reasoning default | **Medium (recommended)** for new configurations; saved choices are preserved and Auto starts low when selected |
| Last recorded tests | **1055/1055 Node** (2026-11-16; incl. Q2 page-scoped `text_landed` + the scoped batch-sequence relaxation, the Q3 visible-notice retry, the task-16 in-process resume, the D1 pure-move splits, the dead-turn panel guard + `deadturn` preview + additive `dead-turn` reducer fixture, and the hardened Android pending-store timing assertions); Android `testDebugUnitTest lintDebug` **BUILD SUCCESSFUL — 97 JVM tests, 0 failures, 1 opt-in skip, lint "No issues found"** (the timing hardening turned the hosted Android CI job green). Prompt: **non-Docs 12,402 / Docs turn 18,092** (core 11,408 + conditional Docs 5,688; ceiling 17,100). Clean `npm ci`/`npm run setup`, `npm audit` **0 vulnerabilities** (DSH pinned `0.2.2-rc.1`). The Q5 gate runner (`scripts/run-e2e-gates.mjs`) runs **12 headless suites green / 7 excluded**. Mock-bridge `ui-preview` scenarios pass with inspected screenshots. See `docs/STATUS.md` for full numbers and `e2e/baselines/` for the real-model batches. These are not real-model/phone acceptance |
| Latest live evidence | `scripts/edge-drag-e2e.mjs` used the real provider/executor bridge in a fresh isolated Edge profile to verify pointer before/after reorder, accepted/refused HTML5 drops, static-source clone effects, native/custom sliders, long-press success/early no-op, intentional no-op, detached-rerender unknown, and stale/ambiguous/off-screen/Docs guards. It independently checked DOM order, values, parents, drop receipts, and collateral application state; refused/no-op cases retained all semantic state. `scripts/edge-expect-e2e.mjs` and `scripts/edge-click-e2e.mjs` retained full regression passes. These are direct executor checks, not real-model acceptance. |
| Pending acceptance | **Done 2026-11-16 (isolated harness / direct-executor):** C1 real-runtime 5/5 (plan/resume-both-paths/steer/cycles/minimized), C2 signed-in Docs table suite double-pass (0 failed, reload persistence). **Still waiting on the user:** real-sidebar/model `/plan`, drag, expectation, download→upload workflows; `e2e/checklist.md` §3 A–D model-driven Docs + the live Docs-TURN model path (incl. under the D2 diet); authenticated Docs export/toolbar expectations, Pivot, HTML-table selection, docked-panel Docs; live docked-panel + physical-phone visual acceptance (extension reload + APK install); push delivery via `conan-evo-x3`; release-APK install; reboot test; Tailscale admin-console ACL grant. See `docs/STATUS.md` "Still unrun" and `e2e/checklist.md` §5 |
| Model used for find acceptance | OpenRouter `deepseek/deepseek-v4.1-flash`, fixed medium effort (dated record of that acceptance; the current default is the pinned 1017 ID above) |
| Prompt at last composition | **Non-Docs 12,402 chars / Docs turn 18,092** (D2 conditional Docs guidance; core 11,408, ceiling 17,100); size only, not a latency claim |
| Parallelism | Maximum 4; only `browser_tabs`, `browser_places`, `browser_read_text`, `browser_docs_read`, and `browser_downloads` overlap |
| Repeat guards | 3 consecutive mutating repeats, 30 observations, 10 unmodified navigation keys; no per-turn call cap |
| Extension | Unpacked `extension/`; reload required after changes |
| Secrets | `.dsh-home/browser-agent/token` and optional `api-key`; never commit or print them |

These are recorded results, not a substitute for rerunning checks after new changes.

## What changed most recently

Historical changelogs were moved out of this resume file during the 2026-11-16 D3 cleanup (nothing lost):
- **History / past milestones:** `docs/HISTORY.md` — the dated "Archived docs/STATUS.md snapshot", "Archived HANDOFF-QUICK.md changelog", and "Archived plan-temporary.md" sections preserve the previous narratives verbatim (moved out of `RELEASE-NOTES.md` for v2.3.0). Per-release notes are in `RELEASE-NOTES.md`.
- **Architecture and invariants:** `HANDOFF.md` (§2 Architecture, §3 Invariants) and `AGENTS.md`.
- **Current behavior, latest verified numbers, and still-unrun list:** `docs/STATUS.md`.

## Key files

- `packages/dsh-browser-extension/lib/index.js` — tool registration, routing, provider guards, final evidence (~4,409 lines after D1). Extracted modules: `lib/guidance.js` (core + conditional Docs guidance, D2), `lib/validate.js` (tool-argument validation), `lib/repeat-guards.js` (repeat/loop guards + Docs failure circuit).
- `packages/dsh-browser-extension/lib/downloads.js` — Downloads-folder real-path and regular-file confinement.
- `extension/sidepanel/browser.js` — browser executor, batches, Docs orchestration (~11,105 lines after D1). Extracted modules: `sidepanel/views.js` (coordinate-basis + layout-drift checks), `sidepanel/labels.js` (label inspection + signature-recovery policy), `sidepanel/docs-ops.js` (pure Docs helpers). The mutable view/label registries and the bulk Docs orchestration remain (future accessor/shared-module refactor).
- `extension/sidepanel/leaked-markup.js` — panel live-stream DSML guard (mirrors the companion `isLeakedToolCallText`; strips leaked reply rows from feed + saved history).
- `extension/sidepanel/drag.js` and `scripts/edge-drag-e2e.mjs` — trusted pointer/HTML5 drag, scoped evidence, and isolated real provider/executor acceptance.
- `packages/dsh-browser-extension/lib/action-expect.js` and mirrored `extension/sidepanel/action-expect.js` — strict five-key validation, scoped evaluation, and model-facing expectation formatting.
- `extension/sidepanel/action-evidence.js`, `expect-executor.js` — observed-change derivation, semantic deltas, executor capabilities, probes, and result finalization.
- `extension/sidepanel/files.js` — download/upload validation, target discovery, and readback.
- `extension/sidepanel/docs-table.js` — table validation, Find/structure planning, public readback, and collateral verification.
- `extension/sidepanel/find.js`, `table.js`, `dialogs.js`, `capture.js` — focused executor helpers.
- `companion/` — loopback bridge, DSH lifecycle, prompt construction, model configuration, logs; `session-controller.mjs` (shared chat/new/stop/resume) and `remote-*.mjs` (opt-in phone API).
- `config/browser.patch.yml` — DSH composition; generated model overlays are not hand-edited.
- `scripts/model-eval.mjs`, `e2e/scenarios/`, `e2e/baselines/` — real-model scenario harness, independent checkers (11 seeds + 3 confirmation gates), `--self-test` mutation gate; baselines include the 2026-11-16 Q2/Q3/Q4/Q7/D2/C1/C2 batches. Coverage/contract: `e2e/scenarios/README.md`.
- `scripts/c1-acceptance.mjs` — real-runtime C1 acceptance (plan/resume/steer/cycles/minimized) on the same isolation, self-test 34/34.
- `scripts/run-e2e-gates.mjs` — one-command headless real-extension gate runner (12 suites green / 7 excluded, per-suite mode column, own PIDs/free ports).
- `scripts/analyze-failures.mjs` — reproducible failure report over `.dsh-home/browser-agent/logs` (per-tool rates, codes/messages, repeats, stops, percentiles, tokens, sites, dead turns/retries/recovered).
- `scripts/prune-logs.mjs` — log retention (`npm run logs:prune [-- --apply]`; keep newest 40 + anything <14 days).

Historical note (resolved): the pre-existing trusted fallback for `mode:"replace"` through a non-editable `<label>` used to append instead of replacing its associated input. **B7 fixed it** — `focusTypingTarget` resolves a `<label>` to its own `control` before the replace path selects content, and a field whose text cannot be selected fails `REPLACE_UNSUPPORTED` before typing (regression in `edge-work-e2e.mjs`).

## Next work

The 2026-11-16 overnight session completed the `plan-temporary.md` queue (Q1–Q10) and Tracks C/D as far as an agent can; that file is deleted (archived in `docs/HISTORY.md`), its permanent acceptance items migrated to `e2e/checklist.md` §5 and its results to `docs/STATUS.md` + `e2e/baselines/`. Remaining work:

1. **Finish local v2.3.0 activation.** The tag and GitHub release are published, with the signed `app-release.apk` asset whose SHA-256 is pinned in the README. The companion was restarted during release packaging and `/health` returned `ok/ui/tools:true` after the real executor reconnected. The unpacked extension still needs a manual reload and panel reopen to guarantee its `2.3.0` code is active (there is no version handshake). `confirmIrreversible` is **ON** and the companion stamps `confirm_guard` on click/type/batch commands of guarded turns, which a pre-2026-11-16 extension build rejects as an unknown argument — if clicks fail, reload the extension and reopen the panel. Then run the live docked-panel visual checks (turn-meta display, confirmation cards + settings toggle, help notice) and the physical-phone screens against the real companion.
2. **Model-driven Docs acceptance:** `e2e/checklist.md` §3 A–D and the live Docs-TURN model path (including under the D2 conditional-guidance diet) through the user's docked panel + signed-in account; authenticated Docs export/toolbar expectations, Pivot, HTML-table selection, docked-panel Docs checklist. The direct-executor Docs table suite already passes twice (C2).
3. **Real-sidebar workflows:** drag, expectation, download→upload, `/plan` through the docked panel (the isolated C1 harness passes plan/resume/steer/cycles/minimized); a docked-panel turn that keeps receiving views after switching apps/minimizing.
4. **Push delivery:** via the designated sender `conan-evo-x3` (copy this computer's FCM key there `0600`, restart its companion, let the app register, then done/help/error/confirm delivery + tap + token-refresh + screen-off checks). Do not re-pair the phone here.
5. **Host/release:** signed release-APK install (uninstall debug + re-pair first), a deliberate reboot acceptance, and the Tailscale admin-console ACL grant (device tags + phone-only tcp:443; review note at `docs/TAILSCALE-REVIEW-2026-11-16.md`).
6. **Follow-up candidates (recorded in `docs/STATUS.md`):** the duplicate-text no-find-reveal reporting class; the non-markup fragment residual (~1/30); the `runInFrame` null-vs-undefined audit; the D1 structural remainder (mutable registries + Docs orchestration accessor/shared-module refactor).
7. **Capability gaps (after acceptance):** structural editing beyond exact two-cell horizontal merge, drag batching and child-frame drags, popups, generic reveal-boundary batches, reusable task recipes.

## Do not

- Do not claim live acceptance from unit tests, fixture suites, a tool’s success status, or a recovered final document.
- Do not weaken stale-view, ambiguity, wrong-target, or verification guards for speed.
- Do not run model-spending tests against the user’s normal profile.
- Do not use broad `pkill`; stop only test processes you started.
