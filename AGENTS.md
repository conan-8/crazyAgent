# CrazyAgent development contract

## Change one observable milestone at a time

Do not treat “make the agent better” or “make Docs faster” as one change. Define the smallest user-visible behavior that can be checked independently, establish a real-run baseline, change one main thing, then rerun the same scenario from the same initial state.

Compare:

- task success, partial completion, and collateral edits;
- wall time, model steps, and tool calls;
- failed calls, retries, and wrong-target actions, even if repaired;
- token usage when relevant.

Keep the model and reasoning effort fixed for comparisons. Current real-agent acceptance uses **medium effort**; do not compare it directly with older off/low runs. A recovered mistake is still reliability evidence.

## Independent checks decide

Logs, screenshots, model reasoning, `turn.ok:true`, `changed:true`, DOM mutations, trusted input, and pixel differences are diagnostic evidence—not proof that the requested outcome occurred. The agent saying “done” is not an oracle.

Inspect the resulting browser or document state independently of the tool result and final answer. If no checker exists, ask the user for a focused visual verdict: correct, partial, wrong, or blocked. Use console probes only for a specific diagnostic question or ground-truth inspection, not as a routine substitute for acceptance.

## Regression gates

Use the cheapest gate that can detect the change, then the next level:

1. `npm test` for contracts, validation, serialization, and state handling.
2. Real-extension fixture suites for executor changes, such as `scripts/edge-files-e2e.mjs`, `scripts/edge-click-e2e.mjs`, `scripts/edge-work-e2e.mjs`, `scripts/edge-canvas-e2e.mjs`, and `scripts/edge-advanced-e2e.mjs`. These inspect page state directly but do not evaluate model decisions.
3. A complete real-sidebar scenario for behavior changes, from a known initial state with independent final-state inspection.

Never present unit tests or direct-executor suites as real-model acceptance. Repeat important model-driven scenarios enough to distinguish a lucky run from reliability.

## Current focus: Google Docs and semantic editing

Use Docs as a stress test for transferable primitives: exact text targeting, selection, canvas input, layout, menus, and verification. Prefer stable semantic operations for repeated dependent workflows without weakening the general browser tools.

Preserve stale-view, ambiguity, wrong-target, scoped-recovery, native-dialog, and verification safeguards. If a UI transition invalidates coordinates, avoid coordinate dependence or maintain explicit operation state; do not globally relax guards.

Priorities:

1. Exact deletion/replacement with formatting and neighboring content preserved.
2. Formatting an exact unique or explicitly ordinal range.
3. Compound document creation and formatting from a fresh disposable document.
4. Authenticated semantic-table acceptance, including collateral-cell and persistence checks.

Duplicate text requires an explicit ordinal; an ambiguous request must not silently alter an arbitrary occurrence.

## Current snapshot (2026-11-05)

- **33 model-facing tools:** 25 general browser tools plus 8 guarded Docs tools.
- `browser_drag` is a standalone, exclusive trusted pointer/HTML5 drag tool for labelled/ref or current-view coordinate sources, labelled/ref/point destinations, CSS deltas, drop positions, and bounded holds. Image/CSS guards reject stale scales, URL/viewport/scroll/layout drift, clipping, ambiguity, unsupported child frames, and Docs before input; source and destination identity/placement are revalidated inside the debugger lease before press and drop. Pointer-only drags do not enable HTML5 interception; actual native sources use `Input.setInterceptDrags` and `Input.dispatchDragEvent`. Results separate source movement/value/selection evidence, destination child/text evidence, observed page change, outcome, and mutation possibility. Clone effects can succeed from destination evidence while a static source is not moved; unrelated DOM changes and drop dispatch are not success. No-op requires all applicable checks to run unchanged; detached/missing evidence stays unknown. Prefer exact `browser_type` values for native range inputs when a spatial gesture is unnecessary.
- `browser_download` saves direct URLs/links and labelled Download controls with completion/filesystem verification. `browser_downloads` lists actual regular files newest first, including bounded subfolders, and normalizes spaces/+ for search only. `browser_upload` accepts only regular files whose real paths remain inside Downloads, assigns them through CDP to labelled/named/indexed file inputs, verifies File name/size, and returns exact alternatives for missing names. Hidden inputs, open shadow roots, and same-origin accessible frames are supported; site-isolated cross-origin frames fail closed with `UPLOAD_FRAME_UNSUPPORTED`. Chrome owns the download directory, so the confined folder must match Chrome's configured download location and "Ask where to save" must be off for page-control downloads; an empty or invalid `CRAZYAGENT_DOWNLOADS_DIR` falls back to the default Downloads folder with a warning instead of unregistering the tools. Ambiguity and paths outside Downloads fail closed. Attachment is not server-submission proof.
- `browser_docs_table` creates compact native tables, reads values and native cell backgrounds, populates cells, formats text, and structurally edits Google Docs tables by semantic addresses, with export verification and collateral checks. Fresh-document verification accepts the preserved empty paragraph before a pasted table. Dedicated format calls with only `cell_background` edits apply native shading per target cell. Merge/unmerge supports exactly two horizontal (colspan-2) cells; vertical merges, colspan>2, other merged-cell writes/structural edits, and unanchored empty tables fail closed. When Alt+/ menu search fails to open, exact native Format → Table controls provide a guarded fallback.
- The 22:13 run exposed a second provider-envelope bug: the executor rewrote `action` but retained `tableAction`, so strict validation rejected every table call before execution. The executor now passes the untouched envelope to the table parser; a regression drives that wire shape through native-table creation and export verification. Custom text colors and highlights require exact hex readback followed by a scoped OK-button commit rather than an implicit Enter. Export retries use five bounded attempts with exponential delays capped at 15 seconds and shared cooldowns.
- `browser_docs_format` plans and verifies exact text ranges inside table-cell paragraphs, including color/highlight and non-target run collateral. Add/create table guidance requires a new table even when an identical one exists. Final unverified Docs turns carry `docsVerification:"unverified"` and a reason through `turn/end`, companion logs, and `chat.done`; the panel shows a verification-incomplete warning. The single final-check nudge requests one untruncated HTML read with `offset:0` and `max_chars:100000`.
- `browser_table` resolves actual HTML table controls rather than coordinates and verifies writes by DOM readback. DOM readback alone does not prove server persistence.
- `browser_click`, `browser_click_at`, `browser_type`, and `browser_press_key` accept strict optional `expect` evidence with only `export_contains`, `toolbar_style`, `dialog`, `text_landed`, and `pixel_changed`. Direct capabilities and public schemas, including conditional nested `args.expect`, are generated from the same definitions and Ajv-checked; batch steps accept only `text_landed`/`dialog`, and unknown or incompatible checks (including `pixel_changed:false`) fail before any guard or dispatch. Pending native dialogs never replace `ActionExpectError`, and pending outcome fields remain null. Field/pixel scopes require document URL and navigation generation where available and fail closed without it; URL-sensitive batch expectations after any potentially document-changing step are rejected before side effects. Results separate `observed`, `expectation`, `outcome`, and `mutationPossible`, preserving explicit nulls. Text/export checks require same-scope absent-to-present evidence; final dialog/toolbar state is not causation proof; pixels are diagnostic-only. Bounded semantic deltas use real label snapshots or mutation-added visible text, never aggregate text lengths or one-sided scopes. No failed expectation triggers re-aiming, retry, or re-mutation.
- Unified `browser_docs_replace` and `browser_docs_format` route to internal executor actions. Legacy replacement/format tool names remain internal only.
- Mutations are exclusive in model order. Only `browser_tabs`, `browser_places`, `browser_read_text`, `browser_docs_read`, and `browser_downloads` are parallel-safe.
- Viewport views keep working when the browser window is unfocused or minimized: the executor keeps `tabs.captureVisibleTab` for a focused visible window and uses a page-level CDP capture otherwise, without ever focusing or restoring the window. A capture timeout opens only the visible-tab cooldown and is not retried by stealing focus; captured image pixels stay viewport × devicePixelRatio on every capture path, and image-space clicks still activate the labelled control while the window is unfocused or minimized. Role-click resolves its target inside the same debugger lease as the press and waits (bounded) for viewport stability after a fresh debugger attach, so Chrome's debugging-infobar resize no longer produces a false `ROLE_CLICK_STALE_TARGET`; a target that genuinely reflows after hover is still refused with zero presses. Click change detection ignores the injected ripple/overlay nodes, so a no-op click reliably reports no visible change. The one-time disclaimer leads with a “Don't touch the browser while the agent is running” warning.
- The composer supports slash commands and Pause/Resume. A leading `/` token opens an inline palette: `/new` starts a fresh chat (a stoppable running turn stays alive behind the draft view; while an operation is still starting, `/new` refuses with a wait message) and `/model` opens the composer model picker. ArrowUp/ArrowDown select with wrapping, Enter or Tab runs the highlighted row, Escape dismisses without rewriting the draft, and a click runs that row. The Send button executes only an exact `/new` or `/model`; other slash-leading text is ordinary prose. `extension/sidepanel/slash.js` holds the pure trigger/filter rules. The Pause/Resume toggle rejects page commands with `PAUSED` without ending the chat, persists with the other panel settings, and updates the activity phase/status. Composer text and pasted images prepared in the `/new` draft view survive its retirement; closing the model picker (Escape, outside click, or row selection) and the settings/history/log/image overlays returns focus to the composer; a dropped bridge finishes the live turn, stops its clock, and clears a stale draft view instead of stranding "Wait for the running session".
- `browser_press_key` and batch key normalization reject ctrl/cmd+W in code (both standalone and composite chords) with a message pointing at `browser_tabs`; guidance alone is not the safeguard. `browser_scroll` is guidance-covered alongside the other general tools.
- Last recorded verification: **800/800 unit/integration tests**, prompt composition (**17,987 total / 16,993 guidance chars**), and fresh isolated `edge-expect-e2e.mjs`, `edge-click-e2e.mjs`, and `edge-drag-e2e.mjs` runs. The drag fixture used the real provider/executor bridge and independently verified pointer before/after reorder, accepted/refused HTML5 drops, static-source clone effects, native/custom sliders, long-press success/early no-op, intentional no-op, detached-rerender unknown, and stale/ambiguous/off-screen/Docs guards. It checked actual DOM order, values, parentage, drop receipts, and collateral application state; refused and intentional no-op cases preserved every semantic application value. Expectation and click fixtures retained full regression passes. These remain direct executor checks, not real-model acceptance.
- **Still unrun:** a real-sidebar/model drag workflow and expectation workflow, download→upload, authenticated Docs export/toolbar expectations and Docs table acceptance, authenticated Pivot, real-model HTML-table-tool selection, the normal authenticated docked-panel Docs checklist, and a real docked-panel turn that keeps receiving views after the user switches apps or minimizes the browser. No connected Docs browser or isolated live-model acceptance profile is currently configured.

See `HANDOFF-QUICK.md` for resume state, `HANDOFF.md` for architecture invariants, and `e2e/checklist.md` for acceptance scenarios. Historical turn-by-turn logs belong in `.dsh-home/browser-agent/logs/`, not in this contract.

## Repository safety

- Do not fork DSH core or hand-edit generated `.dsh-home/browser-agent/llm.patch.yml`.
- Do not run live-model acceptance in unit tests; use fake bridges or isolated browser profiles. Keep test credentials and user data isolated.
- Never kill browsers by executable path. Stop only PIDs/PGIDs you started, scoped to the test profile.
- Reload the unpacked extension and reopen its panel after `extension/` changes. Restart the companion after companion, provider, or config changes.
- When changing behavior documented here or in another project doc, update that doc in the same change.
