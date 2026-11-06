# CrazyAgent — continuation handoff

Last updated: **2026-11-06**. This is the architecture and current-state handoff. `HANDOFF-QUICK.md` is the short resume; `README.md` is the setup/user guide. Older run narratives were removed intentionally—use the debug logs for ground truth.

## 1. Current state

The build exposes **33 model-facing tools**: 25 general browser tools and 8 guarded Docs tools. The latest milestone adds standalone, exclusive `browser_drag` with trusted pointer/HTML5 paths and independently scoped source/destination evidence. Pointer-only drags skip HTML5 interception; actual native sources use `Input.setInterceptDrags` and `Input.dispatchDragEvent`. Source and destination identity/placement are revalidated before press and drop, while image/CSS guards reject stale scales, clipping, ambiguity, unsupported child frames, and Docs. Source movement/value/selection and destination child/text outcomes remain separate from observed page change, outcome, and mutation possibility. A static source with an independently measured clone/drop effect is not a no-op; unrelated changes and drop dispatch are not success. No-op requires all applicable measurements to run unchanged, while detached or missing evidence stays unknown. Exact `browser_type` values are preferred for native range inputs when a spatial gesture is unnecessary. Drag is not a batch operation and has no synthetic fallback. Earlier milestones added strict optional `expect` evidence and typed postconditions to `browser_click`, `browser_click_at`, `browser_type`, and `browser_press_key`, with per-action `text_landed`/`dialog` support in ordinary batches. Results still separate `observed`, `expectation.status`, `outcome.ok`, and `mutationPossible`; failed expectations never trigger automatic repair.

The build also includes composer slash commands plus Pause/Resume, draft-view preservation, overlay focus restoration, and dropped-bridge cleanup. The last recorded implementation verification was **767/767 tests**, prompt composition, and fresh isolated `edge-expect-e2e.mjs`, `edge-click-e2e.mjs`, and `edge-drag-e2e.mjs` runs. The drag fixture used real provider/executor calls to verify pointer before/after reorder, accepted/refused HTML5 drops, static-source clone effects, native/custom sliders, long-press success/early no-op, intentional no-op, detached-rerender unknown, and stale/ambiguous/off-screen/Docs guards. Independent checks inspected DOM order, values, parents, drop receipts, and collateral application state rather than trusting tool status or screenshots; refused and intentional no-op cases preserved every semantic application value. Earlier expectation, click, capture, and file-transfer checks retained their evidence. These are direct executor checks, not real-model acceptance.

Viewport screenshots keep working while the user is in another app or browser window. `snapshot` chooses the capture path from `chrome.windows.get(windowId)`: a focused, visible window keeps `tabs.captureVisibleTab`; an unfocused but visible window uses page-level CDP `Page.captureScreenshot` first and falls back once to the visible-tab API; a minimized window uses only the page path because `captureVisibleTab` can stay pending there until the watchdog fires. Captures never focus or restore the window. `scripts/edge-capture-e2e.mjs` is a self-contained isolated-profile fixture that verifies focused, unfocused, and minimized captures, the painted label overlays, unchanged window focus/state, and no capture cooldown; it also asserts the image is viewport × devicePixelRatio on every path and that an image-space click still activates the labelled control while the window is unfocused and minimized. Its minimized probe showed `captureVisibleTab` not settling within 2s while the executor capture succeeded. Role-click resolves its target inside the debugger lease after a bounded viewport-stability wait: Chrome's debugging-infobar resize no longer causes a false `ROLE_CLICK_STALE_TARGET`, while a target that genuinely reflows after hover is still refused with zero presses. Click change detection ignores the injected ripple/overlay nodes, so a no-op click reports no visible change; `edge-click-e2e.mjs` passed 3 consecutive runs after these fixes.

The one-time help disclaimer now leads with a raised amber **“Don't touch the browser / While the agent is running”** warning explaining that clicking, typing, scrolling, or switching tabs can throw off the agent's clicks and targets and break the task; supporting copy is quieter. Escape/**Got it**, the one-time pending flag, and the install/reload-only trigger are unchanged.

`browser_download` handles direct URLs/links and labelled Download controls with collision-safe names. `browser_downloads` lists actual regular files newest first, including bounded subfolders, and normalizes spaces/+ for search only. `browser_upload` resolves only regular files whose real paths stay inside Downloads, uses CDP assignment, verifies the destination File name/size, and returns exact alternatives after a missing name. Hidden inputs, open shadow roots, and same-origin accessible frames are covered by the fixture; site-isolated cross-origin frames fail closed with `UPLOAD_FRAME_UNSUPPORTED`. Input readback does not prove server persistence. Chrome owns the download directory: the extension cannot set it, so the configured folder must match Chrome's download location and "Ask where to save" must be off for page-control downloads; an empty or invalid `CRAZYAGENT_DOWNLOADS_DIR` falls back to the default folder with a warning instead of unregistering the tools. `browser_press_key` (and batch key normalization) reject ctrl/cmd+W in code with a `browser_tabs` hint.

The Docs table executor uses authenticated exports for planning and verification, exact document-wide Find occurrences for non-empty anchors, guarded empty-cell navigation, native Docs menu commands, and rich HTML table creation with clipboard preservation/restoration. Find-driven selection waits for document focus and an 80 ms toolbar-settling interval before formatting decisions. Native backgrounds use an exact unique visible hex preset or the custom-color dialog when available; unsupported values fail with `DOCS_TABLE_COLOR_UNAVAILABLE` rather than substituting a color. The native Format → Table fallback uses trusted hover to reveal the submenu. Merge/unmerge supports exactly two horizontal (colspan-2) cells and verifies combined text and spans; vertical merges, colspan>2, other merged-cell writes/structural edits, and unanchored empty tables fail closed before mutation.

**Acceptance still pending:** a real-sidebar/model download→upload workflow, authenticated real-extension and real-model Docs table runs, authenticated Pivot, real-model selection of `browser_table`, and the normal authenticated docked-panel Docs scenarios. No connected Docs browser is currently available for a post-fix rerun. Do not promote unit, fake-driver, fixture, or recovered-document results into live acceptance.

The working tree contains substantial uncommitted implementation and documentation work. Inspect `git status` rather than relying on an old commit hash or assuming the companion/extension is running the latest files.

## 2. Architecture

CrazyAgent uses **DSH 0.2.1-rc.2** for the agent loop, sessions, tool pipeline, prompt assembly, attachments, compaction, and model routing.

```text
Chrome/Edge tab
  ↔ MV3 side panel (extension/, browser executor, UI)
  ↔ token-authenticated loopback WebSocket (companion/)
  ↔ DSH SDK runtime
  ↔ provider plugin (packages/dsh-browser-extension/)
  ↔ configured OpenRouter-compatible model
```

The side panel connects as the `ui` role and the provider as `tools`. Browser commands become `browser.command` frames and return `browser.result`. The companion binds to loopback, manages DSH and model configuration, and writes debug logs.

Modification surfaces are the provider plugin, profile/model overlays, companion, and extension. Do not fork DSH core.

## 3. Invariants

1. **Fixed capability boundary.** The model gets the registered tools, not arbitrary page JavaScript or selector automation. Inputs are labelled controls, explicit surface coordinates, text/keys, URLs, or bounded semantic operations.
2. **Execution stays in the side panel.** There is no persistent content script. Functions injected with `chrome.scripting` must be self-contained because outer module constants and helpers are unavailable in the page.
3. **DOM clicks use labels.** Persistent ids must resolve to the same element or fail; never silently retarget a lookalike. Coordinates are for canvas/video/iframe and other surface interactions, not guessed DOM targets.
4. **Trusted surface input uses `chrome.debugger`.** Keep attachments stable during a turn and clean them up on completion, stop, error, or disconnect. Never silently clamp off-screen coordinates.
5. **Correctness beats speed.** Stale views, ambiguous targets, and wrong-target risks fail before input. Batch preconditions prevent dispatch; postcondition failure means mutation is possible and blind retry is unsafe. Malformed batch argument keys fail before guards, mutation, or capture.
6. **Docs operations stay guarded.** Exact matching, occurrence rules, per-tab/stale-tab checks, counters or export verification, partial reporting, and scoped recovery remain in force. Docs drag selection and dependent generic mutation batches are blocked. `DOCS_UNSETTLED` is not safe to retry.
7. **Views are evidence, not proof.** Compact/skipped views and export-verified screenshot suppression do not replace independent final-state inspection. Exact image dedupe changes model admission only, not capture or debug storage.
8. **DSH requests are frozen.** Use durable `image/offload` for image pruning, not `llm/stream` history rewriting. Compaction is a safety net; image budgets control routine prompt growth.
9. **Reasoning is per turn.** Auto currently requests `low` from the first model step; manual policy wins. Wire value `off` is `"none"`, not `null`.
10. **Secrets stay out of logs and generated config.** API keys travel over loopback and enter DSH through environment variables. Redaction does not remove page content, prompts, reasoning, or screenshot pixels.
11. **File access stays confined.** The companion resolves only regular files whose real paths remain inside Downloads. Chrome downloads use unique names; uploads use exact targets and File readback. Paths outside the folder and ambiguous inputs fail before assignment, and readback is not server-persistence evidence.
12. **Capture never takes focus.** Viewport screenshots must not depend on the user keeping the browser focused, and must never focus or restore the window themselves. A focused visible window keeps `tabs.captureVisibleTab`; unfocused/minimized windows use the page-level CDP capture, with one bounded fallback to the other path. `CAPTURE_TIMEOUT` opens the visible-tab cooldown but is not retried by stealing focus.
13. **Expectation evidence stays separate from outcome.** Provider and executor validate `expect` before dispatch using shared capability/schema definitions and byte-identical mirrors, including per-operation conditional schemas for nested `args.expect` verified with Ajv. Pending native dialogs never replace `ActionExpectError`, and pending outcome fields remain null. `observed`, `expectation.status`, `outcome.ok`, and `mutationPossible` are independent contracts and preserve explicit nulls. Text/export verification requires a same-scope absent-to-present transition, document identity, and complete absence evidence; URL-sensitive batch expectations after a potentially document-changing step fail before side effects. Final dialog/toolbar state does not prove causation; pixels require tab/document identity and remain diagnostic-only. One-sided semantic scopes mismatch, and failed expectations never cause re-aiming, retries, or re-mutation.

## 4. Capability summary

### General browser tools

- **Observation:** `browser_screenshot`, `browser_read_text`, `browser_find`, `browser_table` reads, `browser_tabs`, `browser_places`, `browser_downloads`.
- **DOM interaction:** `browser_click`, `browser_click_role`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_select_option`.
- **Surface interaction:** `browser_click_at`, `browser_select`, `browser_scroll`.
- **Composition and navigation:** `browser_batch`, `browser_navigate`, `browser_wait_for`, `browser_switch_tab`, `browser_dialog`.
- **Data transfer:** `browser_clipboard` for text/captured PNGs; `browser_download` for direct/link/dynamic downloads and `browser_upload` for Downloads-confined files with completion and readback checks.

Ordinary initial auto views use bounded rendered DOM text and labels without a screenshot. Known canvas editors retain full labelled screenshots. Viewport captures choose the focused-window API or a page-level CDP capture from the window's focus/state, so an agent turn keeps seeing real labelled views after the user switches apps or minimizes the browser; the capture never moves focus. Find and table operations are semantic fallbacks, not permission to bypass ambiguity or mutation guards.

Only `browser_tabs`, `browser_places`, `browser_read_text`, `browser_docs_read`, and `browser_downloads` are parallel-safe. All mutations, find/reveal, screenshots, and other calls remain exclusive in model order; the runtime maximum is four calls.

### Docs tools

- `browser_docs_rename` — guarded title editing with committed-title verification.
- `browser_docs_replace` — 1–200 ordered exact unique replacements/deletions, with counter verification and partial reporting.
- `browser_docs_format` — 1–50 exact-range edits across eight attributes, with unique or explicit-occurrence targeting and internal simple/multi/font routes.
- `browser_docs_select_text` — exact text or containing-paragraph selection with Find-counter evidence, frame-aware document-focus restoration, and no `all` mode.
- `browser_docs_page_setup` — Letter paper, orientation, and inch margins verified before OK.
- `browser_docs_write` — bounded append-at-end paragraphs, inline runs, flat lists/checklists, blanks, and page breaks with export verification.
- `browser_docs_table` — create compact tables with optional values, read values and native cell backgrounds, write exact cells, format text in cell/row/column/table regions, apply exact native background presets or custom hex colors through dedicated `cell_background`-only format calls, insert/delete rows and columns, merge/unmerge exactly two horizontal (colspan-2) cells with a guarded hover-driven native-menu fallback, or delete a table. Fresh-document verification accepts the preserved empty paragraph. Unavailable colors fail explicitly without substitution; other merged-cell writes, vertical/wide merges, and unanchored empty tables fail closed. The executor passes the original `action:"table"`/`tableAction` provider envelope directly to the table parser rather than rewriting fields before validation.
- `browser_docs_read` — authenticated export as outline, text, or bounded HTML with pagination.

Completed `status:"completed"` results with `verifiedBy:"export"` may return `view:"none"` and skip the redundant final screenshot. Other Docs outcomes retain final views. Turn-level final evidence permits at most one read-and-reconcile nudge after an unverified Docs mutation, explicitly requesting untruncated HTML with `offset:0` and `max_chars:100000`. Failed/partial/truncated evidence remains unverified and is propagated through `turn/end`, companion logs, and `chat.done`; the panel reports verification incomplete.

## 5. Run and verify

```sh
cd /home/conan/Documents/GitHub/crazyAgent
npm install
npm run setup
npm run dev
curl -s http://127.0.0.1:17871/health
npm test
npm run system-prompt -- --json
node scripts/edge-capture-e2e.mjs                 # self-contained isolated profile
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario disclaimer --out /tmp/ui
```

For live use, load `extension/` unpacked, enter the pairing token and model credentials in Settings, and keep the panel open. Reload the extension and reopen the panel after extension changes. Restart the companion after companion, provider, or config changes.

Fixture server:

```sh
python3 -m http.server 17872 --bind 127.0.0.1 --directory e2e/fixtures
```

Real-extension scripts include `edge-files-e2e.mjs`, `edge-click-e2e.mjs`, `edge-work-e2e.mjs`, `edge-find-e2e.mjs`, `edge-table-e2e.mjs`, `edge-canvas-e2e.mjs`, `edge-advanced-e2e.mjs`, `edge-dialog-e2e.mjs`, `edge-clipboard-e2e.mjs`, and `edge-docs-table-e2e.mjs`. They require isolated Edge/CDP setup and do not evaluate model decisions. Two harnesses are self-contained (each starts its own isolated Edge profile, and `edge-capture-e2e.mjs` also starts its own fixture page): `edge-capture-e2e.mjs` checks focused/unfocused/minimized viewport captures, and `ui-preview.mjs` captures the mocked-bridge side-panel UI (including the disclaimer, slash palette, Pause/Resume, and the mocked bridge-drop cleanup; it starts an HTTP fixture server only for its `tools` scenario). The file-transfer harness starts its own server and needs a temporary Downloads preference; the Docs table harness additionally requires an authenticated isolated Docs profile. Use `e2e/checklist.md` for real-sidebar acceptance.

Do not run model-spending or destructive checks against the user’s normal profile. Stop only browser/companion processes you started; never use broad executable-path `pkill`.

## 6. File map

| Area | Responsibility |
|---|---|
| `companion/` | Bridge, DSH lifecycle, prompt blocks, OpenRouter configuration, credentials, log store |
| `packages/dsh-browser-extension/lib/index.js` | Tool registration, guidance, routing, deadlines, guards, activity, final evidence |
| `packages/dsh-browser-extension/lib/downloads.js` | Downloads-root resolution, path confinement, and regular-file verification |
| `packages/dsh-browser-extension/lib/image-dedupe.js` | Exact same-session/turn image admission |
| `extension/sidepanel/browser.js` | Views, labels, trusted input, batches, navigation, executor wiring, Docs orchestration |
| `packages/dsh-browser-extension/lib/action-expect.js`, mirrored `extension/sidepanel/action-expect.js` | Strict expectation validation, scoped evaluation, and model-facing formatting at both runtime boundaries |
| `extension/sidepanel/action-evidence.js`, `expect-executor.js` | Observation derivation, semantic deltas, executor capability checks, probes, and result finalization |
| `extension/sidepanel/files.js` | Download/upload contracts, link/input discovery, and File readback |
| `extension/sidepanel/find.js`, `table.js` | Semantic find/reveal and editable-table operations |
| `extension/sidepanel/capture.js`, `clipboard.js`, `system-clipboard.js` | Screenshot scopes and virtual/system clipboard paths |
| `extension/sidepanel/dialogs.js`, `role-click.js` | Native dialogs and exact page-chrome role paths |
| `extension/sidepanel/docs-*.js` | Export, structure parsing, formatting, selection, and verification helpers |
| `extension/sidepanel/app.js` | Activity feed, composer, queue, settings, Stop and Pause/Resume, debug export |
| `config/browser.patch.yml` | DSH profile composition and parallel-call policy |
| `e2e/` | Fixtures and manual acceptance checklist |
| `scripts/edge-*.mjs` | Real-extension/model CDP harnesses |

Generated state lives under ignored `.dsh-home/`; local companion output is under `logs/`.

## 7. Configuration notes

- System prompt sources are `personaPrefix` in `config/browser.patch.yml` and provider `GUIDANCE` in `lib/index.js`. Print the composed result with `npm run system-prompt`.
- Last recorded composition: **17,995 characters total / 17,001 guidance**. This is not latency evidence.
- Downloads default to `$HOME/Downloads`; `CRAZYAGENT_DOWNLOADS_DIR` selects the absolute confined folder the agent reads/attaches from and must match Chrome's configured download location (the extension cannot change it). An empty value is treated as unset and an invalid value falls back to the default folder with a warning, so the tools still register. Downloaded files are not removed by `npm run clean`.
- The model route is generated from side-panel Settings. Do not hand-edit `.dsh-home/browser-agent/llm.patch.yml`.
- Compaction uses `thresholdRatio:0.55`, `headroomTokens:131072`, `retainTokens:20000`, and `maxTokens:8192`. Newest images are retained while older ones are offloaded at turn end and in batched mid-turn passes.
- There is no per-turn call cap. Repeat guards default to 3 mutations, 30 observations, and 10 unmodified navigation keys. Side-panel reconnect grace defaults to 8 seconds.
- Bridge defaults: `127.0.0.1:17871`, `/bridge`, `/health`; fixture server `17872`.

## 8. Next work

1. Run real-sidebar drag and expectation scenarios with medium effort and independently inspect targets, final state, and every failed call/retry. Then run the real-sidebar download→upload scenario and independently inspect saved and multipart-received bytes.
2. Sign in an isolated Docs profile, reload the unpacked extension, and run `edge-docs-table-e2e.mjs`, then the fresh-document medium-effort sidebar scenario with independent export/persistence checks. Add authenticated Docs export/toolbar expectation checks at the same time.
3. Complete authenticated Pivot and real-model HTML-table selection, then the remaining normal docked-panel Docs checklist. Record wall time, steps, calls, failures, retries, wrong targets, collateral, and recovery edits.
4. In the real docked panel, run a medium-effort turn that needs views and switch to another app / minimize the browser mid-turn. Verify views keep arriving with real labelled content, no “Screenshots are paused” result, and no focus theft; independent image inspection, not the status line, is the evidence. The direct fixture already passes but does not evaluate model decisions or the docked panel.
5. Keep capability work separate from acceptance work: structural editing beyond exact two-cell horizontal merge, drag batching and child-frame drags, popups, generic reveal-boundary batches, reusable recipes, animation observation, and automated cost attribution remain open. Expectation color/highlight is currently rejected, and the separately discovered pre-existing trusted fallback that can append during `mode:"replace"` through a non-editable `<label>` still needs its own focused fix and regression.

For privacy and log handling, read `PRIVACY.md` and `docs/DEBUG-LOGS.md`. Review bundles before sharing; they contain sensitive page and conversation data even after secret redaction.
