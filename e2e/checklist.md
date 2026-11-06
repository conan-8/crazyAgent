# CrazyAgent manual acceptance checklist

Use the **real docked side panel**, not the extension page opened as a tab. Unit tests and direct executor suites do not check off these model-driven scenarios.

## Setup and evidence rules

```sh
npm install
npm run setup
npm run dev
# optional second terminal:
python3 -m http.server 17872 --bind 127.0.0.1 --directory e2e/fixtures
```

- Load `extension/` unpacked in Chrome/Edge 116+. Before testing, reload it and reopen the panel; accept the current permissions.
- Configure the pairing token and an image/tool-capable OpenRouter model. Status must be **Connected**.
- Use a normal HTTP(S) tab and fresh chats. Use **medium effort** for comparable real-agent acceptance.
- Current roster: **33 model-facing tools**. Only the unified Docs replacement/format tools are model-facing; internal legacy action names may appear in logs.
- Last recorded implementation result was **767/767 tests**, prompt composition, and fresh isolated `edge-expect-e2e.mjs`, `edge-click-e2e.mjs`, and `edge-drag-e2e.mjs` runs. The drag fixture used real provider/executor calls in a fresh isolated Edge profile and independently checked pointer before/after reorder, accepted/refused HTML5 drops, static-source clone effects, native/custom sliders, long-press success/early no-op, intentional no-op, detached-rerender unknown, and stale/ambiguous/off-screen/Docs guards with collateral application-state checks. The expectation and click fixtures retained full regression passes. These are not live model acceptance; no connected Docs browser or isolated live-model acceptance profile is configured.

For every scenario, independently inspect final page/document state. Tool status, screenshots, `changed`, export verification, and the agent’s answer are diagnostic evidence. Record wall time, model steps, calls, failures, retries, wrong targets, collateral edits, and recovery edits—even when repaired. A recovered final state is not a clean pass.

## 1. Sidebar smoke checks

### Connection, activity, and reasoning

- Reload the unpacked extension and reopen the panel: the one-time full-screen notice appears, led by the amber **Don't touch the browser / While the agent is running** warning. **Got it** or Escape dismisses it; closing and reopening the panel must not show it again until the next extension reload. Dismissing the notice must leave focus in the composer.
- Open a fixture and ask “What is on this page?” Confirm the active-tab line, connected status, streamed activity, step timing, collapsed finished steps, and pinned final answer.
- With Auto effort, confirm one `reasoning low` policy entry per turn and streamed thinking when the provider exposes it. Switch to Off and confirm later turns respect it.
- Send a message during a turn and verify queue ordering and redirect/edit behavior. Use Stop and confirm the turn stops; send another message and check session resume or a logged fresh-session fallback.

### Composer slash commands

The cheap gate is `node scripts/ui-preview.mjs --scenario slash` (mocked bridge, isolated Edge); it does not replace the docked-panel checks below.

- Type `/` in an empty composer: an inline palette above the composer lists `/new` and `/model`, with the first row highlighted and an `↑↓ navigate · Enter run · Esc dismiss` hint. It must stay inside the panel at the narrowest supported width.
- In DevTools' Accessibility pane the composer exposes the **combobox** role with `expanded` true while the palette is open and false after Escape, and `aria-activedescendant` follows the highlighted row and is removed on close. Screen-reader checks are welcome but the AX tree is the minimum independent check.
- ArrowUp/ArrowDown move and wrap the highlight without changing the draft, and focus stays in the textarea. Escape closes the palette and leaves the draft intact. Shift+Enter inserts a newline and must not run the highlighted command.
- Enter or Tab on `/new` starts a new chat like the **+** button (fresh view, one `chat.new` in the debug log, previous conversation preserved in History); unlike **+**, it consumes the composer draft. Run it while a stoppable turn is streaming: the draft view opens, the running session stays alive, and it retires when the turn finishes. While an operation is still starting (not yet stoppable), `/new` must refuse with a wait message instead of retiring the session.
- Enter or Tab on `/model` opens the composer model picker with search focused; choosing a model sends `llm.configure` and the composer label updates. Escape, an outside click, or choosing a row must return keyboard focus to the composer. While a turn is running, `/model` must refuse with a clear wait message rather than changing models under the active session.
- Clicking a palette row runs that command. The Send button with an exact `/new` or `/model` runs the command too; neither path may emit a `chat.send` frame.
- Type `/usr/local/bin`, `/new chat`, or `/new ` (trailing space) and press Enter: the palette stays closed and the text is sent to the model as an ordinary prompt.
- While the `/new` draft view waits on a running turn, type a draft and paste an image. When the turn ends, the draft view retires but the composer text and image must remain; nothing may be silently cleared.
- The palette is not model acceptance; inspect the resulting chat state independently (debug-log frames, History, composer label, draft view).
- Pause and request scrolling: click the composer **Pause/Resume** toggle; the status/activity phase must show Paused, the page must not move, and each page command must return `PAUSED` instead of executing. Press Resume and retry; the page must then scroll. Close the panel or stop the companion and confirm a clear disconnected/offline state without a stranded "Working…" clock or a stuck draft view.

### Observation and basic interaction

Use `article.html`, `click.html`, `canvas.html`, and `advanced.html`.

- Ordinary auto-view should supply rendered text and labels without requiring a screenshot. A known canvas editor should use a full labelled screenshot. Read-text/find-only calls should not add an image.
- Ask for the three article markers and verify the answer against the page.
- Click Increment twice and verify the actual count is 2 and the label identity remains stable. Check Does nothing, Disabled action, the checkbox, and navigation; no hidden/covered/wrong control may be activated. A no-op click must report no visible change, and role-click must keep refusing a target that moves after hover (zero presses) while tolerating the debugger-infobar viewport resize.
- Click the canvas center and scroll it. Verify trusted input and actual canvas state, not just a pixel-change message.
- Exercise Shadow action, both frame actions, Country = Canada, and hover → Menu item. Verify all target counters/values independently.
- Scroll an article by about 700 pixels and switch between two tabs by name. Check actual scroll position and active tab.

### Forms, navigation, and waiting

Use `form.html`.

- Replace and append text, fill Notes and submit, use Tab/Enter and a modifier chord, and type into the focused editor. Verify field values, event counts, and submitted result.
- Confirm password output is masked. Navigate to `second.html`, go back, and wait for READY; verify URL and page text.
- Select a known text range and a collapsed range on an ordinary page. Verify the highlighted selection/readback. Google Docs drag selection must be refused before input.

### Trusted drag direct gate

Run `node scripts/edge-drag-e2e.mjs` for the self-contained isolated provider/executor fixture. This is a direct gate, not a model-driven checklist substitute.

- Pointer sortable: verify after/bottom and before/top reorder against actual DOM order and untouched HTML5/range/clone state.
- HTML5: verify an accepted move by source parent, payload, and drop receipt; verify a refused drop returns `DRAG_NO_EFFECT` with no application-state mutation, despite native event receipts.
- Clone: keep the original source parent/static and independently count one destination clone; source `changed:false` plus destination child evidence must not become a no-op.
- Sliders: verify native range value readback and custom `aria-valuenow`; verify exact `browser_type` replacement on the native range and its input/change events.
- Long-press: hold at least 300ms and verify destination parent/held time; an early gesture returns `DRAG_NO_EFFECT` with no destination move.
- Intentional no-op: event counters may prove input, but all semantic application state must remain unchanged. A detached rerender must return `observed:"unknown"` and `outcome.ok:null`, not moved or unchanged.
- Ambiguous sources, off-screen coordinates, stale views, scale ambiguity, and Google Docs must fail before dispatch with no application-state mutation. Child-frame drags are unsupported in this milestone.
- A real-sidebar/model drag workflow remains unrun; do not treat this direct fixture as model acceptance.

## 2. Semantic tools and orchestration

### Find and personal destinations

Use `find.html` and a uniquely named disposable HTTP(S) bookmark.

- Ask for an off-screen target without naming a tool. The model should use bounded semantic find as a fallback; reveal must scroll only, preserve focus/selection/content, invalidate old coordinates, and return a fresh full view.
- Duplicate matches without an explicit occurrence must not choose arbitrarily. Explicit first/last/integer occurrence should reveal only that match. Known canvas editors must fail closed.
- In a fresh chat, ask to open the disposable personal destination by name without giving its URL. Expect `browser_places` before search/guessing, then navigation to the exact returned URL. Verify the tab and remove the bookmark.

### Tables

Use `table.html`, then the configured isolated live-table harness, and finally authenticated Pivot when available.

- Read a table and independently compare headers, row labels, values, and read-only cells. Reads must not mutate anything.
- Request a multi-cell update using a mix of indexes and exact unique header/row names. Expect actual cell-control targeting, validation before input, no coordinate typing, already-correct skipping, and per-cell readback.
- Verify every target and every collateral cell independently. Include computed cells and preserved names. A failure must stop later edits and report them unattempted.
- On Pivot, separately verify server persistence after reload. DOM readback alone is not persistence proof. Record whether the model actually selected `browser_table`; direct fixture calls do not establish that.

### Google Docs tables

Use a fresh disposable document in the authenticated docked panel. The direct real-extension harness is `scripts/edge-docs-table-e2e.mjs`; it requires an isolated signed-in Docs profile and refuses to create anything when signed out.

- Give one instruction to create a filled 4-row × 3-column table with `Name / Value / Notes` headers, a bold header with native `#d9d9d9` cell backgrounds, and the first two cells of the last row merged. Expect only four `browser_docs_table` mutations: create, text format, `cell_background` format, and merge; no coordinates, manual Tab/type/menu calls, repeated identical failures, or Ctrl+B repair edits. Export-check every value, all three bold/background header cells, the merged span, and unchanged body cells.
- Give one instruction to create a 3×4 table with twelve distinct words, bold and yellow-highlight the header, and add two rows. Expect only `browser_docs_table` mutations: create with values, format, and insert_rows; no coordinates, TSV paste, manual Tab/type/menu calls, or repair edits.
- Independently export-check all twelve values, header bold/highlight, unchanged data rows, and the 5×4 shape. Repeat with duplicate cell values and an empty-cell write to confirm exact occurrence/navigation planning.
- Exercise insert/delete row and column operations, exact two-horizontal-cell merge/unmerge, and explicit delete_table. Validate every target, combined text, span, collateral cell, and operation count. Only colspan-2 horizontal merges/unmerges are supported: vertical merges and colspan>2 must fail closed before mutation, as must other merged-cell writes/structural edits and unanchored empty tables; none may fall back to primitives.
- Reload and export again for server persistence. Tool statuses and the agent’s answer are not acceptance evidence. Record wall time, calls, failures, retries, wrong targets, and recovery edits.
- The latest post-fix run is still pending because no connected Docs browser is available. Unit/fake-driver results do not check off this subsection.

### Batches and views

Use `form.html` or `click.html`.

- Fill several known fields and submit in one batch. Expect ordered per-action results, no intermediate screenshots, and one final view; verify form state.
- Test an ordinary bad action with stop-on-error enabled/disabled. Then test a false precondition: no dispatch and no mutation. Test a false postcondition: dispatch occurred, later actions stopped, and blind retry is unsafe.
- Confirm malformed nested argument keys fail before provider bridge traffic or executor guards/mutations/captures. Markup-shaped string **values** must remain valid data.
- Check compact/none/full wait views and cumulative labels. Known canvas editors must still return full views where required.

### Action evidence and typed postconditions

Use `expect.html`; the direct isolated-profile gate is `scripts/edge-expect-e2e.mjs`, which passed with independent field, dialog, counter, and DOM-state inspection. It does not evaluate model tool selection.

- Direct `text_landed` must verify only an absent-to-present transition in the actual editable target, including a `<label>` and its associated input. Pre-existing text stays unverified even when append changes the value; verify the exact final field contents independently.
- Direct `pixel_changed:true` must force a fresh full-view comparison with tab/document identity and remain diagnostic-only. Check New on screen/Changed/New text against actual added/renamed controls and visible status text, requiring the exact addition set and rejecting pre-existing page chrome or one-sided scopes. An all-off-screen burst stays unknown at root and per-check with `attempted:false`, `mutationPossible:false`, and no trusted/synthetic dispatch or collateral counter change.
- Exercise direct `press_key` text evidence, an on-screen `click_at` pixel check with an independent dispatch count, and `dialog:"closed"` through Escape. A diverged expectation must not trigger a second input or repair action.
- Pending native dialogs must rethrow invalid expectations; valid pending results retain the expectation with null attempted/ok/mutationPossible. URL/navigation-generation mismatches and URL-sensitive expectations after potentially document-changing batch steps must fail before input.
- Direct `dialog:"open"` and Docs `export_contains`/six-attribute `toolbar_style` checks require explicit scopes. Final dialog/toolbar state is not causation proof; export and toolbar checks are rejected outside a supported Docs document and color/highlight is currently unsupported.
- In batches, combine `text_landed`/`dialog` expectations with ordinary before/after guards. A false precondition prevents dispatch and leaves the expectation unverified; a false postcondition preserves the typed evidence but returns `outcome.ok:false`, `attempted:true`, and `mutationPossible:true`.
- Unknown keys, incompatible checks, and `pixel_changed:false` must fail before input. Top-level and nested `args.expect` forms have equivalent per-operation conditional schemas, with valid/invalid Ajv regressions. An invalid later batch action must prevent every earlier mutation. Never re-aim, retry, or re-mutate after a failed expectation; only bounded read-only reobservation is allowed. Acceptance scripts mark debugger startup attempted before awaiting it so `finally` always attempts cleanup after partial startup.
- The real-sidebar/model scenario remains unrun: ask the model to declare applicable expectations and verify its tool choices and final page state independently. Authenticated Docs export/toolbar expectation acceptance is also pending a signed-in isolated Docs profile.

### Capture, clipboard, and dialogs

- Capture viewport, full-page, and region views. Independently check dimensions and the full-page tail, viewport/scroll restoration, and that full/region images do not become coordinate bases.
- With a turn running that asks for views, switch focus to another app (and separately to another browser window) and minimize the browser. Fresh views must keep arriving with the real labelled page, no “Screenshots are paused” error, and Chrome must not bring itself forward or restore the window. Independently inspect the actual images for page content and label badges; a success status alone is not evidence. `scripts/edge-capture-e2e.mjs` covers the direct-executor focused/unfocused/minimized path without a model, including viewport × devicePixelRatio image size and image-space clicks that activate the labelled control while unfocused and minimized.
- Copy/read/write/clear/paste virtual text and capture a PNG to the virtual clipboard. Paste into a real contenteditable and inspect actual insertion. Check whether the OS clipboard was preserved, restored, overwritten, or bypassed; handler consumption alone is not attachment proof.
- In one turn, capture the same bytes twice and inspect both model results and debug files: only the duplicate model image block is omitted; fresh metadata and both stored captures remain. A later turn must re-admit the image.
- Use `dialog.html`: alert auto-accepts; confirm/prompt waits for explicit resolution; accepted prompt text reaches the page. Unintended beforeunload remains pending without a stale view; intended navigation resolves only its own beforeunload.

### Downloads and uploads

Use an isolated browser profile whose Chrome download location is pointed at a temporary Downloads folder (Chrome's download directory is a user setting; the extension cannot set it, and "Ask where to save" must be off so page-control downloads complete). Set `CRAZYAGENT_DOWNLOADS_DIR` to that same absolute folder before starting the companion. `scripts/edge-files-e2e.mjs` starts its own fixture/upload server and covers the direct-executor path; it passed, but that does not check model tool selection.

- In a fresh docked-panel chat, ask for `payload.txt` by its direct fixture URL and then ask to attach the downloaded file to `Chat attachment` and send it. Expect `browser_download` followed by `browser_upload`; no native file picker or arbitrary filesystem tool.
- Independently compare the saved file with `e2e/fixtures/payload.txt`, then inspect the receiving server's multipart filename and exact bytes. Attachment readback alone is not submission proof.
- Repeat from the same initial state with the labelled **Download payload** link and a forced filename collision. The original file must remain unchanged and Chrome must return a unique second name.
- Use **Download viewer payload** to verify dynamic-button capture and the exact `Viewer+Payload.txt` result. Then exercise a Schoology-style `+`-encoded filename: `browser_downloads` must find it with a spaced query, a spaced upload attempt must return exact alternatives, and the actual `+` filename must upload successfully. Move one file into a Downloads subfolder and confirm `browser_downloads` still lists/finds it (bounded recursion).
- Check hidden/visible inputs, open shadow DOM, and a same-origin iframe. A site-isolated cross-origin iframe must fail closed with `UPLOAD_FRAME_UNSUPPORTED` before assignment. Multiple inputs without a selector must fail closed; exact name or a returned input index must revalidate the intended input. Ordinary clicks on file inputs must return `FILE_INPUT`, not open a picker.
- Attempt an absolute path, `../` traversal, and a symlink escaping Downloads. All must fail before file assignment. Record any failed call, retry, wrong target, or uncertain assignment even when repaired.

## 3. Google Docs acceptance

Reload the normal unpacked extension and reopen the docked panel before this section. Use fresh disposable documents, fresh chats, medium effort, and one instruction without guidance or continuation. Inspect exported HTML and final UI state independently.

### A. Exact replacement and simple formatting

Create a bold 28 pt first line and an unchanged sentinel:

```text
Benchmarks: yea
This paragraph must remain exactly unchanged.
```

Ask:

> Delete only the word “yea” after “Benchmarks:”. Preserve the colon and the first line’s bold 28 pt formatting. Do not change any other text.

Expect one `browser_docs_replace` edit, counter verification, and a final full view. Final text must be `Benchmarks:` plus the unchanged sentinel, with bold 28 pt preserved. Repeat with a non-empty replacement and duplicate target text; ambiguity must fail before mutation.

On another unique line, request Title, 28 pt, bold, and Playfair Display in one `browser_docs_format` edit. Expect no preliminary Find/menu calls, per-attribute verification, and one final full view. Check the containing paragraph and sentinel independently. Also check desired-state `bold:false`, an already-correct no-op, missing-font partial behavior, and duplicate refusal. Missing font must not delete text unless the explicit unique font-only `remove_if_missing:true` route was requested.

Rename a disposable document and verify both the Rename-field safeguards and committed document title.

### B. Ordinal selection and multi-range formatting

Create three separate `Duplicate target` paragraphs and differently formatted text/list/link sentinels.

- Select only the second occurrence with `browser_docs_select_text`, apply one Ctrl+B primitive, and export-check that only occurrence 2 changed. Repeat first/last and containing-paragraph selection from fresh states. Omitted occurrence on duplicates must fail; there is no `all` mode.
- In one `browser_docs_format` call, format a unique heading across paragraph style/font/size/bold/color/highlight and only the second duplicate across font/size/italic/underline. Expect internal `format_many`, per-edit export verification, and no generic Docs batch. Check all eight attributes, occurrence targeting, sentinels, list metadata, and structured link destination.
- Completed export-verified multi-route formatting may return `view:"none"` with `DOCS_EXPORT_VERIFIED`; partial/failed results must retain a final view. Skipped capture is not acceptance evidence.
- Restore fresh state and make the second of three edits fail with an unavailable font. Expect the first verified, the second explicitly partial, and the third unattempted. Do not retry the whole call. Independently inspect exact partial state and collateral.

For a menu-path scenario, select ordinal 2, use one exact `browser_click_role` path for Format → Text → Strikethrough, then one semantic multi-range format call. Role-path completion proves dispatch, not the document outcome; verify strikethrough and all collateral by export. `ROLE_CLICK_UNSETTLED` and `DOCS_UNSETTLED` are not safe to retry.

### C. Compound writing and page setup

From a fresh empty disposable document, give one instruction that:

- renames it `Feature Test Document`;
- sets Letter, portrait, 1-inch margins;
- writes a formatted Title and dated Subtitle, a mixed-inline introduction, a page break, three headings, numbered/bulleted lists, and two checklist items with exactly one checked.

Target exactly three semantic mutations: `browser_docs_rename`, `browser_docs_page_setup`, and one `browser_docs_write`. No primitive menu/coordinate/manual list/page-break recovery and zero failed calls. Allow at most one independent `browser_docs_read`.

Export-check every run’s text/font/size/emphasis/color/highlight, paragraph styles, page-break position, list type/order, exact checked state, clean list exits, and absence of extra content. Repeat from the same fresh state and record all reliability metrics. A correct document after repairs is recovered, not accepted.

Repeat a writer scenario with a definitely unavailable font. Expect an honest failure/partial result with final view retained, no duplicate/blind input, and no dropped attributes. Recovery must inspect the exact target or use one scoped undo for a known latest accident, never select-all/delete, clearing, repeated Backspace, or blind undo chains.

### D. Turn-level final evidence

- After a counter-verified replacement, expect at most one `docs.final.check` nudge followed by one full offset-zero untruncated `browser_docs_read` and reconciliation.
- Completed export-verified writes/formatting must not trigger a redundant read. Later mutations invalidate earlier evidence.
- Generic Docs typing/key/click content mutations also require final evidence; read-only operations do not.
- Partial/failed mutations and failed/partial/truncated reads remain unverified, get no repeated nudge loop, and must not be presented as completed.

## 4. Debug export and cleanup

- Export a debug bundle with screenshots/raw session enabled. Verify `events.jsonl`, summaries, actual captures, and the DSH session. Export-verified skipped Docs captures should have no final JPEG; exact image dedupe should not remove stored captures.
- Confirm tokens, API keys, authorization headers, and inline base64 are redacted. Page content, prompts, reasoning, and screenshots remain sensitive.
- Export without screenshots and verify they are absent. Review bundles before sharing.

Cleanup:

```sh
npm run clean -- --yes   # deletes .dsh-home, including sessions/logs/remembered secrets
npm run setup
```

Remove disposable bookmarks/documents and stop only the fixture/browser/companion processes you started.
