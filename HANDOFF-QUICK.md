# crazyAgent — quick handoff

Current snapshot: **2026-11-16**. This file is the short **resume state**. Read `HANDOFF.md` for architecture and invariants, `docs/STATUS.md` for current behavior + latest verified numbers + the still-unrun list, and `e2e/checklist.md` for live acceptance. Historical changelogs live in `RELEASE-NOTES.md` and the debug logs.

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
| Release | **v2.2.0 released** (tag `v2.2.0` at `4c6a658`; GitHub release published 2026-11-12; manifest/package/companion `2.2.0`; signed Android `0.5.0 (4)` APK, SHA-256 `05090c08…fdac1`). Previous: [v2.1.0-beta GitHub prerelease](https://github.com/conan-8/crazyAgent/releases/tag/v2.1.0-beta) |
| Tools | **34 standing model-facing:** 25 general + 8 guarded Docs tools + `agent_request_help`; conditional `browser_plan` only during exact-`/plan` turns and conditional `agent_request_confirmation` only while the companion's opt-in `confirmIrreversible` setting is on (both can coexist) |
| Reasoning default | **Medium (recommended)** for new configurations; saved choices are preserved and Auto starts low when selected |
| Last recorded tests | **1029/1029 Node** (2026-11-16; includes the dead-turn panel guard, the `deadturn` preview scenario, and the additive `dead-turn` reducer fixture); Android `testDebugUnitTest lintDebug` **BUILD SUCCESSFUL — 97 JVM tests, 0 failures, 1 opt-in skip, lint "No issues found"**; prompt composition (**18,076 total / 17,082 guidance**, ceiling 17,100). Clean `npm ci`/`npm run setup`, isolated real DSH `0.2.2-rc.1` reached `tools:true` without model calls, `npm audit` **0 vulnerabilities** (DSH pinned `0.2.2-rc.1`). Mock-bridge `ui-preview` scenarios (incl. `deadturn`, `confirm`, `plan`, `remote`, `slash`, `waiting`) pass with inspected screenshots; the Q5 one-command gate runner (`scripts/run-e2e-gates.mjs`) runs 12 headless suites green. See `docs/STATUS.md` for the full latest numbers and `plan-temporary.md`/`e2e/baselines/` for tonight's real-model batches. These are not real-model/phone acceptance |
| Latest live evidence | `scripts/edge-drag-e2e.mjs` used the real provider/executor bridge in a fresh isolated Edge profile to verify pointer before/after reorder, accepted/refused HTML5 drops, static-source clone effects, native/custom sliders, long-press success/early no-op, intentional no-op, detached-rerender unknown, and stale/ambiguous/off-screen/Docs guards. It independently checked DOM order, values, parents, drop receipts, and collateral application state; refused/no-op cases retained all semantic state. `scripts/edge-expect-e2e.mjs` and `scripts/edge-click-e2e.mjs` retained full regression passes. These are direct executor checks, not real-model acceptance. |
| Pending acceptance | Real-sidebar/model `/plan`, drag, and expectation workflows, download→upload, authenticated Docs export/toolbar expectations and Docs tables, authenticated Pivot, real-model HTML-table selection, normal authenticated docked-panel Docs, and a real docked-panel turn that keeps receiving views after the user switches to another app or minimizes the browser |
| Model used for find acceptance | OpenRouter `deepseek/deepseek-v4.1-flash`, fixed medium effort |
| Prompt at last composition | **18,076 chars total / 17,082 guidance**; size only, not a latency claim |
| Parallelism | Maximum 4; only `browser_tabs`, `browser_places`, `browser_read_text`, `browser_docs_read`, and `browser_downloads` overlap |
| Repeat guards | 3 consecutive mutating repeats, 30 observations, 10 unmodified navigation keys; no per-turn call cap |
| Extension | Unpacked `extension/`; reload required after changes |
| Secrets | `.dsh-home/browser-agent/token` and optional `api-key`; never commit or print them |

These are recorded results, not a substitute for rerunning checks after new changes.

## What changed most recently

Historical changelogs were moved out of this resume file during the 2026-11-16 D3 cleanup (nothing lost):
- **History / past milestones:** `RELEASE-NOTES.md` — the dated "Archived docs/STATUS.md snapshot" and "Archived HANDOFF-QUICK.md changelog" sections preserve the previous narratives verbatim.
- **Architecture and invariants:** `HANDOFF.md` (§2 Architecture, §3 Invariants) and `AGENTS.md`.
- **Current behavior, latest verified numbers, and still-unrun list:** `docs/STATUS.md`.

## Key files

- `packages/dsh-browser-extension/lib/index.js` — tool registration, guidance, routing, provider guards, final evidence.
- `packages/dsh-browser-extension/lib/downloads.js` — Downloads-folder real-path and regular-file confinement.
- `extension/sidepanel/browser.js` — browser executor, views, batches, Docs orchestration.
- `extension/sidepanel/drag.js` and `scripts/edge-drag-e2e.mjs` — trusted pointer/HTML5 drag, scoped evidence, and isolated real provider/executor acceptance.
- `packages/dsh-browser-extension/lib/action-expect.js` and mirrored `extension/sidepanel/action-expect.js` — strict five-key validation, scoped evaluation, and model-facing expectation formatting.
- `extension/sidepanel/action-evidence.js`, `expect-executor.js` — observed-change derivation, semantic deltas, executor capabilities, probes, and result finalization.
- `extension/sidepanel/files.js` — download/upload validation, target discovery, and readback.
- `extension/sidepanel/docs-table.js` — table validation, Find/structure planning, public readback, and collateral verification.
- `extension/sidepanel/find.js`, `table.js`, `dialogs.js`, `capture.js` — focused executor helpers.
- `companion/` — loopback bridge, DSH lifecycle, prompt construction, model configuration, logs; `session-controller.mjs` (shared chat/new/stop/resume) and `remote-*.mjs` (opt-in phone API).
- `config/browser.patch.yml` — DSH composition; generated model overlays are not hand-edited.
- `scripts/model-eval.mjs`, `e2e/scenarios/`, `e2e/baselines/` — real-model scenario harness, independent checkers (all 11 plan seeds), the saved 9×5 baseline, and the 2×5 `a1-new-seeds` baseline for `download-upload` and `frame-canvas-slider`; `--self-test` mutation-checks checkers without model spend. Coverage/contract: `e2e/scenarios/README.md`.
- `scripts/analyze-failures.mjs` — reproducible failure report over `.dsh-home/browser-agent/logs` (per-tool rates, codes/messages, repeats, stops, percentiles, tokens, sites).

Known separate limitation found during acceptance: the pre-existing trusted fallback for `mode:"replace"` through a non-editable `<label>` can append instead of replacing its associated input. The milestone did not change that behavior; direct associated-label evidence was accepted, while batch replace acceptance used the native input. Do not hide this distinction in future typing fixes.

## Next work

1. **Confirmation follow-ups.** B9c is measured (2026-11-15, `plan-temporary.md` progress log): with the setting on, 30 real-model runs had zero submissions before an answer and every answered run honored it, but 8 of 30 turns died at step one because the model wrote its first `browser_batch` call as literal `<｜DSML｜…>` text (the same happened in 2 of 10 setting-off control runs). Open: the user's backstop decision (recommended: none on this evidence), the dead-turn investigation, and the live docked-panel + real-companion phone confirmation check, which needs the user to reload the extension and switch the setting on. Also open (2026-11-15 late, details in `plan-temporary.md`): Docs highlight/colour selection commits red instead of the requested hex in the signed-in table suite; push delivery goes through `conan-evo-x3` (decided 2026-11-16: the phone's existing pairing is the designated sender — copy this computer's FCM key there, restart its companion, then registration and delivery checks; do not re-pair the phone here).
2. Run real-sidebar drag and expectation scenarios with medium effort and independently inspect targets, final state, and any failed calls/retries. Then run the real-sidebar download→upload scenario in `e2e/checklist.md` and independently inspect both saved and received bytes.
3. Sign in an isolated Docs profile, reload the unpacked extension, and run `scripts/edge-docs-table-e2e.mjs`. Then run the fresh-document medium-effort sidebar scenario and independently inspect export/persistence.
4. Complete authenticated Pivot and real-model HTML-table selection, then the remaining normal authenticated docked-panel Docs checklist. Record failures, retries, wrong targets, and recovery edits even when repaired.
5. In the real docked panel, start a medium-effort turn that needs views, then switch to another app and minimize the browser. Confirm views keep arriving without a “Screenshots are paused” error and without Chrome stealing focus back; inspect the actual images, not the status line.
6. After acceptance gaps, the main capability gaps are structural editing beyond exact two-cell horizontal merge, drag batching and child-frame drags, popups, generic reveal-boundary batches, and reusable task recipes.

## Do not

- Do not claim live acceptance from unit tests, fixture suites, a tool’s success status, or a recovered final document.
- Do not weaken stale-view, ambiguity, wrong-target, or verification guards for speed.
- Do not run model-spending tests against the user’s normal profile.
- Do not use broad `pkill`; stop only test processes you started.
