# CrazyAgent development contract

## Optimize one observable milestone at a time

Do not treat "make the agent better" or "make Docs faster" as one change. Break work into the smallest user-visible behavior that can be checked independently. Establish a real-run baseline, change one main thing, then rerun the same scenario from the same initial state.

For each milestone, compare:

- Task success, including partial completion and collateral edits.
- Wall time, model steps, and tool calls.
- Failed calls, retries, and wrong-target actions, even when later repaired.
- Token usage when relevant.

A recovered mistake is still evidence about reliability; do not hide it behind a successful final response. Keep the model and reasoning effort fixed when comparing changes. The current real-agent benchmark setting is **medium effort**. Do not compare its timings directly with older off/low runs.

## Logs explain; independent checks decide

Debug events, screenshots, and model reasoning are diagnostic evidence, not proof of task success. `turn.ok:true` means the runtime finished normally. `changed:true`, trusted input, DOM mutations, and pixel differences do not prove the intended target changed. The agent saying "done" is not an oracle.

Verify the resulting browser or document state independently of the tool result and final answer. When an independent checker is not yet available, ask the user for a focused visual acceptance result: correct, partial, wrong, or blocked.

Use targeted console probes only to answer a specific diagnostic question or inspect ground truth. Do not make manual probes or the entire manual checklist a routine development step.

## Regression gates

Use the cheapest gate that can detect the change, then the next level:

1. `npm test` after implementation changes for contracts, validation, serialization, and state handling.
2. Real-extension fixture suites for executor changes. Scripts such as `scripts/edge-click-e2e.mjs`, `scripts/edge-work-e2e.mjs`, `scripts/edge-canvas-e2e.mjs`, and `scripts/edge-advanced-e2e.mjs` call the executor directly and inspect page state; they do not evaluate model decisions.
3. A complete real-agent scenario for behavior changes, driving the actual sidebar from a known state and checking the final outcome independently.

Do not claim the real-agent scenario passed merely because unit tests or direct-executor suites passed. Repeat important model-driven scenarios enough to distinguish a lucky run from a reliable improvement.

## Current focus: Google Docs

Use Docs as a stress test for transferable primitives: exact text targeting, selection, canvas input, layout changes, menus, and verification. Avoid overfitting to one document, font, layout, or recorded click sequence. Prefer stable semantic operations for repeated dependent workflows, while keeping the general browser tools honest and capable.

Do not buy speed by weakening stale-view, ambiguity, wrong-target, or verification safeguards. If expected UI transitions invalidate coordinates, avoid coordinate dependence or maintain explicit operation state rather than globally relaxing the guard.

Work in this order:

1. Exact text deletion/replacement with no collateral edits and formatting preserved.
2. Formatting an exact unique text range: font, size, paragraph style, then other attributes.
3. Compound document creation and formatting from a fresh disposable document.

Handle duplicate text explicitly: an ordinal request may select that occurrence; an ambiguous request must not silently alter an arbitrary occurrence.

### Feature-document reliability (2026-10-27)

The roster is **27 model-facing tools**. `browser_docs_page_setup` verifies Letter paper, portrait/landscape orientation, and requested inch margins before OK. `browser_docs_write` now supports `{page_break:true}` and flat checklists whose items may be strings or `{text,checked}` objects; exported HTML must prove checklist identity and every checked state, not merely bullet-shaped text.

Two fresh Feature Test Document attempts exposed the same cascade: **459.401 seconds/87 calls/17 failures** and **716.410 seconds/149 calls/41 failures**. Both began with valid compound writes that failed at highlight formatting, followed by manual recovery. Root fixes are: ignore hidden stale custom-color dialogs while still rejecting multiple usable Hex fields; key repeat state by session/user-message turn and reset an identical-mutation series after a different successful mutation; and use bounded increasing export-convergence delays (six verification reads in the worst divergence case rather than about 32). Consecutive identical mutations and the Docs replacement circuit remain guarded. A first capture timeout now causes one window-focus retry; only a persistent second timeout opens the 30-second capture circuit.

The later Brag Sheets run exposed two more distinct failures: list shortcuts worked while their controls were unrendered behind More, so the executor now reveals and reads exact pressed state before insertion; and `write-position` failed with HTTP 429 after 7.986/4.120 seconds of retry backoff before any mutation. Export calls are now serialized per document/format with a 250 ms successive-request gap and a shared 429/503 cooldown, including after final failure. The existing request timeout/retry limits are unchanged.

The newest Feature Test attempts (`turn-mvqo4wyf-221a`, `turn-mvqo7v9m-a896`, `turn-mvqog7qb-287b`) went through 22/96/90 calls and ended in raw DSML output. Screenshots showed Portrait visibly selected while its label-linked radio was reported unselected, causing Page setup to remain open and hide the toolbar. Page setup now resumes an existing dialog and follows label-linked inputs; list verification now searches the visible overflow popup outside the main toolbar. These were executor state bugs, not evidence that the model initiated the cascade correctly.

The next comparison (`turn-mvqpck4n-b0ae` versus `turn-mvqpoaw0-00e0`) separated recovery luck from model errors. The completed run used 103 calls/10 failures and manual repairs; the aborted run used 60 calls/29 failures, including 21 failed writes dominated by `blank:false`, blank blocks mixed with formatting, and missing list types. The writer schema now uses `const:true` for standalone `blank`/`page_break`, guidance forbids those combinations and requires `items` with `list`, and Page setup makes one fresh bounded OK retry after a close timeout. The good run was a recovered success, not a clean acceptance baseline.

The full suite passes **428/428** and profile composition passes. The target live acceptance is the original Feature Test Document in three semantic mutations—rename, page setup, one compound write—with no primitive fallback or recovery edits, plus at most one independent export read. Fresh medium-effort real runs and independent final-state inspection are still required; do not treat unit/fake-driver success or a recovered final document as live acceptance.

### Exact role paths and semantic range formatting (2026-10-27)

Exactly three tools are new in the **27-tool** roster:

- `browser_click_role` accepts only `{path:[{role,name}, ...]}` with 1–4 steps. Roles and accessible names must match exactly; names are case-sensitive after whitespace normalization. It waits for revealed menus internally, revalidates each target before trusted input, and returns one final full view. It is for page chrome, not editor/canvas/document content. A completed path proves dispatch and observed transitions, not the requested application outcome. `ROLE_CLICK_UNSETTLED` can leave delayed input in flight and is not safe to retry.
- `browser_docs_select_text` requires exact `text`; optional `occurrence` is `"first"`, `"last"`, or a positive one-based integer, while omission remains unique-only. `scope:"text"` selects the match and `scope:"paragraph"` its containing paragraph. The text-only result reports Find-counter selection evidence without an empty screenshot. There is no `"all"` or persistent multi-select mode.
- `browser_docs_format_many` accepts 1–50 ordered edits with the same occurrence semantics and at least one of all eight attributes: `paragraph_style`, `font_size`, `bold`, `italic`, `underline`, `font`, `color`, and `highlight`. It uses baseline and final exports for per-edit and collateral verification, including structured `href` preservation and list/paragraph metadata. Paragraph-style verification accounts for uniform inherited font/size/bold changes only in the styled paragraph. It returns one final view and per-edit results, stops on the first failure, and leaves later edits explicitly unattempted. Executor/provider budgets are 600/660 seconds.

Overlapping edits and conflicting paragraph-style edits are rejected before mutation. `paragraph_style` on an `LI` target and opaque structures such as tables fail closed; there is no generic Docs mutation batch. `DOCS_UNSETTLED` means an in-flight mutation may still be running: do not retry or issue further mutations; after the tab is stable, inspect with `browser_docs_read`. These tools do not weaken replacement, repeat, stale-tab, or one-action/full-view safeguards.

Current verification is `npm test` **428/428**, successful `npm run setup` and system-prompt composition, and passing isolated Edge click/advanced/canvas suites after role hardening. **No live Google Docs acceptance has been performed for these three tools.** Reload the normal unpacked extension and reopen its panel before running the fresh medium-effort scenarios in `e2e/checklist.md`; independently inspect exports and record retries and collateral even when repaired.

### Active acceptance task: exact deletion

Setup in a disposable document, with the first line bold and 28 pt:

```text
Benchmarks: yea
This paragraph must remain exactly unchanged.
```

At medium effort in a fresh chat, instruct:

> Delete only the word “yea” after “Benchmarks:”. Preserve the colon and the first line’s bold 28 pt formatting. Do not change any other text.

Expected final text, with the first line still bold and 28 pt:

```text
Benchmarks:
This paragraph must remain exactly unchanged.
```

Give the instruction once, without guidance or a continuation. Independently inspect the final state and record accidental edits even if repaired. The comparable pre-milestone real run took **88 seconds and 22 tool calls** and briefly damaged neighboring text before repairing it. That is a baseline to improve, not a passing correctness result.

Later medium-effort exact edits used the native Find and Replace dialog manually in **5–6 model calls over 26–33 seconds**. On 2026-10-25, guarded Docs replacement was added with unique-match checks, one Replace click per edit, old/new counter verification, and one final view. The model-facing contract is now the actual `browser_docs_replace_text` and `browser_docs_replace_many` tools; `browser_docs` is font-only. Their schemas require the right fields, singleton batch and single replacement share semantic loop fingerprints, and guidance makes exact edits the first tool call. Control discovery walks upward from Replace with to the unique structural container holding Replace, Replace all, and Close. A real Docs probe also exposed controls that could be rendered while CSS reported `visibility:hidden`; opening is now proven by usable fields and live counters rather than that CSS flag alone. Replacement-state waits are 8 seconds and timeout errors include the last observed counter. The pre-formatter full suite passes **278 tests** and profile composition passed. One real correctness run removed only `unchanged` with no malformed retries but took **21.7 seconds** after two preliminary observations; a later single edit used one call in **9.08 seconds**, and a model-driven batch used one call in **9.18 seconds** with the correct final text. Other acceptance attempts hit tab-focus churn, capture timeouts, and the CSS-probe failure. These are mixed results, not a reliable repeated acceptance baseline; do not call the work fully accepted until fresh normal-browser runs repeatedly show the requested target, one valid call, and no recovery edits. Later work added `browser_docs_rename` with title-focus verification, `DOCS_FAILURE_CIRCUIT` after three consecutive replacement failures, a hard block on Docs drag-selection, replacement counter baselines with simple-Find verification, an Edit-menu opening fallback, and a 30-second close budget. Direct duplicate-replacement and menu-fallback acceptance is still not reliably passing; the OAuth Docs API executor has not been started.

### Guarded compound formatter status (2026-10-26)

`browser_docs_format` brings the roster to **21 model-facing tools** and is the first tool call for supported exact-range formatting. It forwards `op:'docs', action:'format'`. The schema requires exact `text` plus at least one of `font` (exact visible name, maximum 100 characters), integer `font_size` 1–400, boolean `bold`/`italic`/`underline`, or `paragraph_style` (`Normal text`, `Title`, `Subtitle`, `Heading 1`–`Heading 6`). Booleans are desired final states, so `false` removes emphasis; paragraph style affects the containing paragraph. Existing `browser_docs` remains font-only, and replacement behavior is unchanged.

The executor uses one exact unique Find selection, a per-tab lock and stale-tab checks, and the fixed order paragraph style → size → bold → italic → underline → font. It rereads state after dependencies, skips already-correct states, verifies every requested attribute, and returns one final view. Font size requires verified field focus and value before Enter. Missing or duplicate text fails before formatting. A missing font never deletes text: if earlier attributes changed, the result is `partial` with per-attribute `results` and `failure`; other failures stop immediately and name verified earlier changes plus the current unverified attribute. This change does not unlock generic Docs batches or add a replacement+format combination.

Guidance also puts contiguous prose and intended newlines in one `browser_type` call once the caret is known. The formatter change adds ten executor cases and provider contract coverage. The full suite passes **289/289**, composed-prompt validation includes the new tool, and the real-extension canvas suite passes; real-Docs acceptance has not been performed. Recent pre-change real-log baselines—43 model steps/111.7 seconds for a Title/Subtitle compound task and 5 steps/13.2 seconds for one font-size task—are motivation, not evidence of improvement. Do not claim either the active exact-deletion milestone or this formatter is repeatedly accepted; run the focused real scenarios in `e2e/checklist.md` and independently inspect final text, formatting, and collateral edits.

### Safe composition, export reading, and compound writing (2026-10-26)

The roster is now **27 model-facing tools**. `maxParallelToolCalls` is **4**, but only `browser_tabs`, `browser_read_text`, and `browser_docs_read` declare `isConcurrencySafe`; all mutations, screenshots, waits, and other calls remain exclusive and execute in model order. Guidance asks the model to emit already-known calls for one logical unit in one assistant response instead of thinking between every action, and to split only when later arguments depend on newly revealed state. `browser_docs_read` is also an observation tool for repeat-guard purposes. Provider registration derives its logged tool list from actual registrations.

Every user turn now includes fresh local date/time, UTC, and IANA timezone in `current_time`; “today,” “now,” and relative dates do not require a time-service navigation. Recovery must inspect and fix the exact target or use one scoped Ctrl+Z for a known accidental latest mutation, followed by fresh view/export verification. No select-all/delete, clearing, repeated Backspace, or blind undo chains. Initial calls and retries must preserve every explicitly requested attribute.

`browser_docs_read` uses a strict current-document export URL with authenticated extension-side fetch, no navigation/page evaluation/debugger, bounded timeouts, and at most two 429/503 retries. It returns `outline` (default), `text`, or bounded `html`; the structure parser preserves paragraph styles, empty lines, list type/order/level, emphasis, links, font/size, color, and highlight evidence. Explicit normal formatting overrides inherited emphasis; page backgrounds are not treated as text highlights. It is not a preliminary requirement for exact edits and does not take a redundant screenshot.

`browser_docs_write` appends at document end (including fresh documents), not arbitrary caret/top insertion. It accepts 1–50 blocks/20,000 characters: single-line formatted paragraphs, mixed inline `runs` (1–100 per paragraph), flat `numbered`/`bulleted`/`checklist` groups of 1–100 items, `{blank:true}`, or `{page_break:true}`. Checklist items may be strings or `{text,checked}` objects. Every block/run/item is validated before tab access. Baseline color state comes from the document-end run, avoiding unnecessary default color dialogs. Editor focus is discovered across frames, then an export position check runs before any formatting: missing end paragraphs or moved prefixes fail `DOCS_WRITE_POSITION` before collateral edits. The writer resets inherited formatting and sets font, size, emphasis, six-digit hex color, and highlight before each text run. Numbered (`Ctrl+Shift+7`), bulleted (`Ctrl+Shift+8`), and checklist (`Ctrl+Shift+9`) modes read exact pressed state even when overflow-hidden; checked items use `Ctrl+Shift+Enter` on the intended new item. Two Enters exit each group and list mode must be off. It does not create nested lists or convert existing lists.

Success requires export verification of the untouched prefix and every appended block/run, including exact run text, styles, list order/type, emphasis, font/size, color, and highlight. A bounded eight-second export-convergence loop re-reads divergent appended content without retyping or extra screenshots; persistent divergence, empty list items, and collateral prefix changes produce explicit partial/failed results. Font menus filter unusable rows and deduplicate only equivalent exact-name rows in the same active menu; conflicting menus still fail and toolbar verification remains mandatory. Input is never blindly retried, and recovery must not drop requested attributes or clear content. The returned outline covers appended content; use `browser_docs_read` before any recovery retry. Generic Docs mutation batches and drag selection remain blocked.

The full suite passes **326/326**, profile composition passes, and focused writer/read/export/provider tests cover the new contracts. The first real compound-writer run used `deepseek/deepseek-v4.1-flash` at medium effort and produced a **correct final document but did not pass acceptance**: **81.545 seconds, 23 model steps, 22 tool calls**, three failed calls (duplicate Playfair menu rows plus two malformed writes), one partial rewrite, and manual font/size recovery. Independent post-run HTML export checks passed **9/9** for the Title formatting, one blank Normal paragraph, numbering 1–3, bullets, clean list exits, Roboto 11 closing text, and unchanged sentinel text/formatting; no collateral edits were detected. This is one recovered run, not one-call acceptance or a reliable speedup. The pre-change real compound-document run took **19.5 minutes/230 steps with 137 key presses**, a baseline rather than proof of improvement. Repeat the fresh-disposable-document scenario in `e2e/checklist.md` and independently inspect every result.

Follow-up attempts also remained unaccepted: `turn-mvpt4xjj-48c1` took **146.149 seconds/43 steps/42 calls** and hit default-color and list failures; `turn-mvptd4bw-6062` took **100.566 seconds/37 steps/36 calls** and hit overflow-hidden list controls; `turn-mvptzvus-61a8` took **211.834 seconds/28 steps/27 calls** and merged the sentinel with `Release heading`, later repaired. These runs motivated baseline color initialization, overflow-aware pressed-state reads, frame-aware focus, and the pre-mutation position check. A later setup (`turn-mvpuldri-6329`, **167.951 seconds/58 steps/65 calls**) hit focus and capture failures with an empty document. The newest build has **not** received a clean acceptance run: the CrazyAgent pane is connected but collapsed to 0 px, blocking both the five-block and mixed-inline scenarios. Do not treat unit/canvas results as live acceptance.
