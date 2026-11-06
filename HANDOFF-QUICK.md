# crazyAgent — quick handoff

Current snapshot: **2026-11-06**. Read `HANDOFF.md` for architecture and invariants; use `e2e/checklist.md` for live acceptance.

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
| Release | **v2.0.0-beta** GitHub prerelease; Chrome manifest `version_name` is `2.0.0-beta` |
| Tools | **33 model-facing:** 25 general + 8 guarded Docs tools |
| Reasoning default | **Medium (recommended)** for new configurations; saved choices are preserved and Auto starts low when selected |
| Last recorded tests | **767/767**, prompt composition, direct expectation/provider wire and schema-parity regressions, and fresh isolated `edge-expect-e2e.mjs`, `edge-click-e2e.mjs`, and `edge-drag-e2e.mjs` runs |
| Latest live evidence | `scripts/edge-drag-e2e.mjs` used the real provider/executor bridge in a fresh isolated Edge profile to verify pointer before/after reorder, accepted/refused HTML5 drops, static-source clone effects, native/custom sliders, long-press success/early no-op, intentional no-op, detached-rerender unknown, and stale/ambiguous/off-screen/Docs guards. It independently checked DOM order, values, parents, drop receipts, and collateral application state; refused/no-op cases retained all semantic state. `scripts/edge-expect-e2e.mjs` and `scripts/edge-click-e2e.mjs` retained full regression passes. These are direct executor checks, not real-model acceptance. |
| Pending acceptance | Real-sidebar/model drag and expectation workflows, download→upload, authenticated Docs export/toolbar expectations and Docs tables, authenticated Pivot, real-model HTML-table selection, normal authenticated docked-panel Docs, and a real docked-panel turn that keeps receiving views after the user switches to another app or minimizes the browser |
| Model used for find acceptance | OpenRouter `deepseek/deepseek-v4.1-flash`, fixed medium effort |
| Prompt at last composition | **17,995 chars total / 17,001 guidance**; size only, not a latency claim |
| Parallelism | Maximum 4; only `browser_tabs`, `browser_places`, `browser_read_text`, `browser_docs_read`, and `browser_downloads` overlap |
| Repeat guards | 3 consecutive mutating repeats, 30 observations, 10 unmodified navigation keys; no per-turn call cap |
| Extension | Unpacked `extension/`; reload required after changes |
| Secrets | `.dsh-home/browser-agent/token` and optional `api-key`; never commit or print them |

These are recorded results, not a substitute for rerunning checks after new changes.

## What changed most recently

- `browser_drag` adds a standalone exclusive trusted drag path for labels/refs, current-view coordinates, destinations, CSS deltas, drop positions, and bounded holds. Pointer-only drags skip HTML5 interception; actual native sources use CDP drag interception/replay. Source and destination are revalidated before press and drop. Results keep source movement/value/selection separate from destination child/text effects, observed change, outcome, and mutation possibility. Static-source clone effects count only from destination evidence; unrelated DOM/drop events do not prove success. No-op requires every applicable measurement to stay unchanged; detached or missing evidence remains unknown. There is no synthetic fallback, drag batching, child-frame support, or real-sidebar/model acceptance yet. `scripts/edge-drag-e2e.mjs` passes in a fresh isolated Edge profile with independent application-state and collateral checks.

- Strict optional `expect` evidence is wired through provider and executor for `browser_click`, `browser_click_at`, `browser_type`, and `browser_press_key`, with per-action `text_landed`/`dialog` support in ordinary batches. All five reviewed keys and public operation schemas share the same capability definitions, with byte-identical provider/executor mirrors and automated parity plus Ajv tests for top-level and nested `args.expect`. Acceptance scripts mark debugger startup as attempted before awaiting it, so `finally` always attempts cleanup after partial startup. Pending native dialogs never swallow `ActionExpectError`; pending attempted/ok/mutationPossible remain null. Field and pixel scopes require document identity; URL-sensitive batch expectations after a potentially document-changing step fail before any side effect. One-sided semantic scopes mismatch in both directions. Results distinguish `observed`, `expectation.status`, `outcome.ok`, and `mutationPossible`, preserving explicit nulls. Text/export checks require same-scope absent-to-present evidence, final dialog/toolbar checks do not claim causation, pixels are diagnostic-only, and failed expectations never trigger automatic repair. The hardened `edge-expect-e2e.mjs` and `edge-click-e2e.mjs` fixtures pass on fresh isolated profiles with independent page-state and dispatch assertions. Direct Docs export and six toolbar attributes are supported only when explicitly requested; color/highlight and batch export/toolbar/pixel checks remain rejected. Authenticated Docs expectation acceptance and real-sidebar/model expectation selection remain unrun.

- The side-panel UI patch closes the reviewed gaps. A **Pause/Resume** toggle in the composer rejects page commands (`PAUSED`) without ending the chat, persists with the other settings, and updates the activity phase/status. Closing the model picker (Escape, outside click, or choosing a model) returns focus to the composer; settings/history/debug-log/image overlays do the same. Attachments and text prepared while the `/new` draft view waits behind a running turn survive when the turn ends. A dropped bridge now finishes the live turn, stops its clock, and clears a stale draft view, so a later send cannot claim "Wait for the running session". `scripts/ui-preview.mjs --scenario slash` asserts all four behaviours (Pause persistence/`PAUSED` gating, focus return, draft attachment survival, and mocked bridge-drop cleanup) and `--scenario disclaimer` covers the one-time notice.

- The composer has slash commands. A single leading slash token (`/`, `/n`, `/new`, `/MODEL`) opens an inline palette listing `/new` (fresh chat; a stoppable running turn stays alive behind the draft view, while an operation that is still starting refuses with a wait message) and `/model` (opens the existing composer model picker). ArrowUp/ArrowDown move the selection with wrapping, Enter or Tab runs the highlighted row, Escape dismisses without rewriting the draft, and a click runs that row. The Send button executes only an exact `/new` or `/model`; `/usr/local/bin`, `/new chat`, and trailing-space variants are sent as ordinary prose. `extension/sidepanel/slash.js` holds the trigger/filter rules and `extension/test/slash.test.mjs` covers them. `scripts/ui-preview.mjs --scenario slash` asserts the real accessibility tree (combobox role + `expanded` through `Accessibility.getPartialAXTree`), `aria-activedescendant` cleanup, arrow/Tab/Enter/Escape wrapping, Shift+Enter newline, outside-click dismissal, Send-button agreement, busy `/model` refusal, busy-state `/new` keeping the session alive, prose fallback, and 280 px fit; its row-click and Enter steps use trusted CDP key/mouse input, so the `preventDefault` focus/newline guards are regression-covered (mutation-checked). New UI frame: `docs/ui/sidebar-slash-commands.jpeg`.

- Viewport screenshots no longer pause when the user is in another app or browser window. `snapshot` (and therefore every view, `browser_screenshot`, scroll, click, and `auto_view` fallback) chooses the capture path from `chrome.windows.get(windowId)`: a focused, visible window keeps `tabs.captureVisibleTab`; an unfocused but visible window tries page-level CDP `Page.captureScreenshot` first and falls back to the visible-tab API once; a minimized window uses only the page path, where `captureVisibleTab` hangs until the watchdog fires. A capture never focuses or restores the window, and the old focus-stealing retry on `CAPTURE_TIMEOUT` is gone. `scripts/edge-capture-e2e.mjs` is a self-contained isolated-profile check: focused, unfocused, and minimized windows all returned real labelled viewport images while the window state and focus stayed unchanged; it recorded `captureVisibleTab` not settling within 2s while minimized while the executor capture succeeded in ~106–119ms (≈1.1s including labels).

- The side panel shows a short, full-screen disclaimer after the extension is installed or reloaded — never on ordinary panel opens. It is now led by a raised amber warning, **“Don't touch the browser” / “While the agent is running”**, explaining that clicking, typing, scrolling, or switching tabs can throw off the agent's clicks and targets and break the task; quieter supporting copy notes the agent can click/type/scroll, actions may look unexpected, and Stop is available. `background.js` sets `crazyagent.disclaimerPending` from `runtime.onInstalled` (install/update only), the panel consumes it when it renders the native `<dialog>`, and Escape or **Got it** dismisses it. `scripts/ui-preview.mjs --scenario disclaimer` now asserts the warning wording, DOM/screen order, and visual dominance (larger/heavier/warmer type on a bordered fill) plus full-panel coverage, one-time consumption, Escape dismissal, and no repeat after a panel reopen; install → dev reload → reopen was also checked in an isolated real-extension Edge profile.

- `browser_download` saves direct URLs/links and labelled Download controls with completion/filesystem verification. `browser_downloads` lists actual regular files newest first (including bounded subfolders) and normalizes spaces/+ for search only. `browser_upload` confines real paths to regular files inside Downloads, verifies CDP attachment by File name/size, and returns exact alternatives after a missing name. Hidden inputs, open shadow roots, and same-origin accessible frames are covered; cross-origin site-isolated frames fail closed with `UPLOAD_FRAME_UNSUPPORTED`, and Chrome owns the download directory (the confined folder must match Chrome's download location, with "Ask where to save" off). Arbitrary filesystem access remains unsupported.
- `scripts/edge-files-e2e.mjs` independently checks direct/link/dynamic downloads, ambiguity refusal, hidden/visible/shadow/frame inputs, picker-click guards, and actual multipart receipt. It and the existing click fixture pass; a real-sidebar/model workflow is still pending.
- `browser_docs_table` creates compact native tables, accepts the preserved empty paragraph during fresh-document verification, reads bounded grids and native backgrounds, writes exact cells, formats cell/row/column/table text, applies native backgrounds through dedicated `cell_background`-only calls using an exact unique visible preset or the custom-color dialog, inserts/deletes rows and columns, merges/unmerges exactly two horizontal cells with a guarded hover-driven native-menu fallback, or deletes tables. Unavailable colors fail explicitly without substitution. Provider-envelope normalization, custom-color OK commits, exact presets, stale-toolbar selection, and add/create intent are covered by regressions. Export retries use five bounded exponential-backoff attempts.
- `browser_docs_format` verifies exact ranges inside table-cell paragraphs, including color/highlight and collateral runs. Find-driven selection waits for document focus and an 80 ms toolbar-settling interval before desired-state decisions. Custom colors require exact hex readback and a scoped OK-button commit. Final unverified Docs turns carry metadata through `turn/end` and `chat.done`, and the panel reports verification incomplete instead of plain Ready.
- `scripts/edge-docs-table-e2e.mjs` covers direct real-extension creation, compact paragraph CSS, text and native cell formatting, structure edits, deletion, independent export, and reload persistence when an isolated Docs profile is signed in. No connected Docs browser or isolated Docs profile is currently available for the post-fix rerun.
- `browser_find` searches bounded rendered text, accessible names, and non-password values across frames/open shadow roots. Reveal requires a unique or explicit occurrence, scrolls without editing, invalidates old coordinates, and returns a fresh full view.
- `browser_table` reads editable HTML tables and writes validated semantic cell targets with readback verification. Server persistence still needs independent inspection.
- `browser_docs_replace` and `browser_docs_format` are the only model-facing replacement/formatting tools. Internal `replace_text`, `replace_many`, `format`, `format_many`, and `set_font` names are not separate tools.
- Completed export-verified Docs results may skip the redundant final screenshot. Partial/failed/counter/toolbar-only results retain views; independent final-state inspection remains required.

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
- `companion/` — loopback bridge, DSH lifecycle, prompt construction, model configuration, logs.
- `config/browser.patch.yml` — DSH composition; generated model overlays are not hand-edited.

Known separate limitation found during acceptance: the pre-existing trusted fallback for `mode:"replace"` through a non-editable `<label>` can append instead of replacing its associated input. The milestone did not change that behavior; direct associated-label evidence was accepted, while batch replace acceptance used the native input. Do not hide this distinction in future typing fixes.

## Next work

1. Run real-sidebar drag and expectation scenarios with medium effort and independently inspect targets, final state, and any failed calls/retries. Then run the real-sidebar download→upload scenario in `e2e/checklist.md` and independently inspect both saved and received bytes.
2. Sign in an isolated Docs profile, reload the unpacked extension, and run `scripts/edge-docs-table-e2e.mjs`. Then run the fresh-document medium-effort sidebar scenario and independently inspect export/persistence.
3. Complete authenticated Pivot and real-model HTML-table selection, then the remaining normal authenticated docked-panel Docs checklist. Record failures, retries, wrong targets, and recovery edits even when repaired.
4. In the real docked panel, start a medium-effort turn that needs views, then switch to another app and minimize the browser. Confirm views keep arriving without a “Screenshots are paused” error and without Chrome stealing focus back; inspect the actual images, not the status line.
5. After acceptance gaps, the main capability gaps are structural editing beyond exact two-cell horizontal merge, drag batching and child-frame drags, popups, generic reveal-boundary batches, and reusable task recipes.

## Do not

- Do not claim live acceptance from unit tests, fixture suites, a tool’s success status, or a recovered final document.
- Do not weaken stale-view, ambiguity, wrong-target, or verification guards for speed.
- Do not run model-spending tests against the user’s normal profile.
- Do not use broad `pkill`; stop only test processes you started.
