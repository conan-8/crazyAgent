# CrazyAgent — continuation handoff

Last updated: **2026-10-30**. This is the architecture and current-state handoff. `HANDOFF-QUICK.md` is the short resume; `README.md` is the setup/user guide. Older run narratives were removed intentionally—use the debug logs for ground truth.

## 1. Current state

The build exposes **29 model-facing tools**: 21 general browser tools and 8 guarded Docs tools. The latest milestone adds semantic Google Docs table creation, reads, cell writes, text formatting, and row/column/table structural operations, plus table-aware exact-range formatting. The last recorded implementation verification was **552/552 tests** and successful prompt composition.

The Docs table executor uses authenticated exports for planning and verification, exact document-wide Find occurrences for non-empty anchors, guarded empty-cell navigation, native Docs menu commands, and rich HTML table creation with clipboard preservation/restoration. Merged-cell writes/structural edits and unanchored empty tables fail closed.

**Acceptance still pending:** authenticated real-extension and real-model Docs table runs, authenticated Pivot, real-model selection of `browser_table`, and the normal authenticated docked-panel Docs scenarios. Both available isolated Docs profiles were signed out, so no live table document was created. Do not promote unit, fake-driver, fixture, or recovered-document results into live acceptance.

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

## 4. Capability summary

### General browser tools

- **Observation:** `browser_screenshot`, `browser_read_text`, `browser_find`, `browser_table` reads, `browser_tabs`, `browser_places`.
- **DOM interaction:** `browser_click`, `browser_click_role`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_select_option`.
- **Surface interaction:** `browser_click_at`, `browser_select`, `browser_scroll`.
- **Composition and navigation:** `browser_batch`, `browser_navigate`, `browser_wait_for`, `browser_switch_tab`, `browser_dialog`.
- **Data transfer:** `browser_clipboard`, including text and captured PNG images.

Ordinary initial auto views use bounded rendered DOM text and labels without a screenshot. Known canvas editors retain full labelled screenshots. Find and table operations are semantic fallbacks, not permission to bypass ambiguity or mutation guards.

Only `browser_tabs`, `browser_places`, `browser_read_text`, and `browser_docs_read` are parallel-safe. All mutations, find/reveal, screenshots, and other calls remain exclusive in model order; the runtime maximum is four calls.

### Docs tools

- `browser_docs_rename` — guarded title editing with committed-title verification.
- `browser_docs_replace` — 1–200 ordered exact unique replacements/deletions, with counter verification and partial reporting.
- `browser_docs_format` — 1–50 exact-range edits across eight attributes, with unique or explicit-occurrence targeting and internal simple/multi/font routes.
- `browser_docs_select_text` — exact text or containing-paragraph selection with Find-counter evidence and no `all` mode.
- `browser_docs_page_setup` — Letter paper, orientation, and inch margins verified before OK.
- `browser_docs_write` — bounded append-at-end paragraphs, inline runs, flat lists/checklists, blanks, and page breaks with export verification.
- `browser_docs_table` — create with optional values, read, write exact cells, format text in cell/row/column/table regions, insert/delete rows and columns, or delete a table; export-verified with collateral checks and explicit merged/empty-table safeguards.
- `browser_docs_read` — authenticated export as outline, text, or bounded HTML with pagination.

Completed `status:"completed"` results with `verifiedBy:"export"` may return `view:"none"` and skip the redundant final screenshot. Other Docs outcomes retain final views. Turn-level final evidence permits at most one read-and-reconcile nudge after an unverified Docs mutation; failed/partial/truncated evidence must remain honestly unverified.

## 5. Run and verify

```sh
cd /home/conan/Documents/GitHub/crazyAgent
npm install
npm run setup
npm run dev
curl -s http://127.0.0.1:17871/health
npm test
npm run system-prompt -- --json
```

For live use, load `extension/` unpacked, enter the pairing token and model credentials in Settings, and keep the panel open. Reload the extension and reopen the panel after extension changes. Restart the companion after companion, provider, or config changes.

Fixture server:

```sh
python3 -m http.server 17872 --bind 127.0.0.1 --directory e2e/fixtures
```

Real-extension scripts include `edge-click-e2e.mjs`, `edge-work-e2e.mjs`, `edge-find-e2e.mjs`, `edge-table-e2e.mjs`, `edge-canvas-e2e.mjs`, `edge-advanced-e2e.mjs`, `edge-dialog-e2e.mjs`, `edge-clipboard-e2e.mjs`, and `edge-docs-table-e2e.mjs`. They require isolated Edge/CDP setup and do not evaluate model decisions; the Docs table harness additionally requires an authenticated isolated Docs profile. Use `e2e/checklist.md` for real-sidebar acceptance.

Do not run model-spending or destructive checks against the user’s normal profile. Stop only browser/companion processes you started; never use broad executable-path `pkill`.

## 6. File map

| Area | Responsibility |
|---|---|
| `companion/` | Bridge, DSH lifecycle, prompt blocks, OpenRouter configuration, credentials, log store |
| `packages/dsh-browser-extension/lib/index.js` | Tool registration, guidance, routing, deadlines, guards, activity, final evidence |
| `packages/dsh-browser-extension/lib/image-dedupe.js` | Exact same-session/turn image admission |
| `extension/sidepanel/browser.js` | Views, labels, trusted input, batches, navigation, executor wiring, Docs orchestration |
| `extension/sidepanel/find.js`, `table.js` | Semantic find/reveal and editable-table operations |
| `extension/sidepanel/capture.js`, `clipboard.js`, `system-clipboard.js` | Screenshot scopes and virtual/system clipboard paths |
| `extension/sidepanel/dialogs.js`, `role-click.js` | Native dialogs and exact page-chrome role paths |
| `extension/sidepanel/docs-*.js` | Export, structure parsing, formatting, selection, and verification helpers |
| `extension/sidepanel/app.js` | Activity feed, composer, queue, settings, stop/pause, debug export |
| `config/browser.patch.yml` | DSH profile composition and parallel-call policy |
| `e2e/` | Fixtures and manual acceptance checklist |
| `scripts/edge-*.mjs` | Real-extension/model CDP harnesses |

Generated state lives under ignored `.dsh-home/`; local companion output is under `logs/`.

## 7. Configuration notes

- System prompt sources are `personaPrefix` in `config/browser.patch.yml` and provider `GUIDANCE` in `lib/index.js`. Print the composed result with `npm run system-prompt`.
- Last recorded composition: **16,475 characters total / 15,481 guidance**. This is not latency evidence.
- The model route is generated from side-panel Settings. Do not hand-edit `.dsh-home/browser-agent/llm.patch.yml`.
- Compaction uses `thresholdRatio:0.55`, `headroomTokens:131072`, `retainTokens:20000`, and `maxTokens:8192`. Newest images are retained while older ones are offloaded at turn end and in batched mid-turn passes.
- There is no per-turn call cap. Repeat guards default to 3 mutations, 30 observations, and 10 unmodified navigation keys. Side-panel reconnect grace defaults to 8 seconds.
- Bridge defaults: `127.0.0.1:17871`, `/bridge`, `/health`; fixture server `17872`.

## 8. Next work

1. Sign in an isolated Docs profile, reload the unpacked extension, and run `edge-docs-table-e2e.mjs`, then the fresh-document medium-effort sidebar scenario with independent export/persistence checks.
2. Complete authenticated Pivot and real-model HTML-table selection, then the remaining normal docked-panel Docs checklist. Record wall time, steps, calls, failures, retries, wrong targets, collateral, and recovery edits.
3. Keep capability work separate from acceptance work: merged-cell structural editing, file upload, element drag/drop/sliders, downloads/popups, generic reveal-boundary batches, reusable recipes, animation observation, and automated cost attribution remain open.

For privacy and log handling, read `PRIVACY.md` and `docs/DEBUG-LOGS.md`. Review bundles before sharing; they contain sensitive page and conversation data even after secret redaction.
