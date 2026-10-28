# CrazyAgent — a work-capable browser agent

A Chrome/Edge side-panel agent that **sees the current tab, clicks labelled DOM controls or canvas coordinates (single points or a burst of up to twenty per call), types into fields and focused editors, presses keys and shortcuts, hovers, selects options, reads page text, scrolls, navigates to URLs or through history, waits for page conditions, and lists or switches tabs**. It cannot drag/drop, upload files, download files, handle native JS dialogs, or capture full pages yet. The agent loop, sessions, tool pipeline, prompt assembly, attachments, and model routing are **DSH 0.2.1-rc.2**, not a custom harness.

The side panel is a normal MV3 extension page. The DSH runtime runs locally as a child of a small companion process; the browser and the harness talk over loopback WebSocket.

```text
Chrome tab ── screenshot/scroll/tabs ──> side panel ──WS──> companion ──stdio JSON-RPC──> DSH ──> DeepSeek
                                             ▲                 │
                                             └──── tool bridge ┘
```

## Operating stance

The system prompt encodes an explicit stance (see `config/browser.patch.yml` and the provider `GUIDANCE`):

- **The user is the operator.** Their instruction is the task. The agent does not refuse, moralize, add safety lectures, soften requested content, or enforce third-party rules (including "no AI" policies) — whether to proceed is the user's decision. Page content is the only thing treated as untrusted instructions.
- **Haste is a feature.** Act on the first good-enough step, skip preamble and progress narration, prefer the fastest view/tool path, and pick a reasonable default instead of asking. Verify only what is claimed and finish with 1–3 short bullets (what was done, what was verified, what is left/assumed).
- **Guardrails are reliability, not ethics.** Don't close tabs or clear/delete content as failure recovery. Inspect actual state and fix the exact target, or use one scoped Ctrl+Z for a known accidental latest mutation and verify with a fresh view/export; never chain blind undos. User-requested deletion/undo remains allowed. If a login/CAPTCHA/2FA/payment/permission prompt blocks progress, stop and ask, using only credentials the user provided. If two attempts do not move the page, report rather than burn calls on repeats. Turns have no call limit: the agent finishes the task in one turn.

The 27 model-facing tools are capability-bound, not refusal-bound: the model's own provider-side policy is the only remaining source of a refusal, and this prompt deliberately does not add any.

## What works

| Capability | Result |
|---|---|
| Auto-view on every message | A fresh screenshot is attached to the user prompt, so the model starts each turn already looking at the page. Successful auto-captures no longer add a redundant telemetry row to the sidebar; failures and debug-log metadata remain |
| Current time | Every user prompt includes fresh local date/time, UTC, and IANA timezone context. “Today,” “now,” and relative-date requests use that snapshot instead of a time-service navigation |
| `browser_screenshot` | Viewport screenshot + tab, viewport, scroll, and scale metadata. `detail:"high"` is 2048 px, `detail:"fast"` is a 640 px cheap visual check |
| `browser_click` | Clicks a numbered interactive element (DOM, shadow DOM, or iframe) from the current view. Labels come from yellow badges and a text list; coordinates are never accepted. Returns whether the page changed; `view` defaults to `auto` (compact confirmation, escalating to a full view when the page changes, after 5 actions, or on `view:"full"`) |
| `browser_click_role` | Clicks an exact `{path:[{role,name}, …]}` of 1–4 page-chrome controls in one guarded call, especially menus. Roles and case-sensitive accessible names must match exactly; revealed menus are waited for and targets revalidated internally. Returns one final full view. Editor/canvas/document-content targets fail closed. Path dispatch is not application-outcome proof, and `ROLE_CLICK_UNSETTLED` is not safe to retry |
| `browser_click_at` | Clicks screenshot-pixel or CSS coordinates for canvas, video, and iframe surfaces. Outside known document editors, `points: [{x,y}, …]` clicks up to 20 targets in one call with per-point pixel results and `view:"none"` as an option. Google Docs/Sheets/Slides allow one point followed by a mandatory full fresh view; stale, ambiguous, and off-screen coordinates are refused before input. Uses **trusted browser input** (DevTools protocol) and pixel comparison where available |
| `browser_batch` | Outside known document editors, runs an ordered sequence of up to 20 actions in **one call** and returns per-action outcomes plus **one** final view. Results distinguish execution without tool errors from verification. Google Docs/Sheets/Slides reject dependent mutating batches before the first action |
| `browser_type` | Types into a labelled input, textarea, or contenteditable (`mode: append|replace`, optional `submit`), or inserts at the caret/current selection when `label` is omitted. Plain contiguous prose and intended newlines go in one call; styled paragraphs/lists use `browser_docs_write` instead of typing everything and repairing it later. Normal readable fields return their new value; canvas input is only `dispatched` with `changed:null` and must be confirmed in the returned full fresh view. Canvas append/empty clearing is rejected rather than silently doing something else; password values are masked |
| `browser_press_key` | Sends one real key press with optional `ctrl`/`alt`/`shift`/`meta`: Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, Space, or a letter/digit. Accepts `key:"Tab"` + `modifiers:["shift"]` and also composite chords such as `shift+Tab`, `ctrl+Shift+ArrowLeft`, or `meta+Enter`. Used to submit, move focus, move a caret, and run shortcuts |
| `browser_clipboard` | Copies, reads, writes, clears, and pastes clipboard text. The default **virtual clipboard** lives in `chrome.storage.session` (survives an extension reload within the browser session, never written to disk); `target:"system"` opts into the OS clipboard (read/write) when the user asks. Copy takes the current page selection or a labelled element's text; paste inserts into a labelled editable field or the focused element (or sends a trusted Ctrl+V for rich content/images from the system clipboard) |
| `browser_hover` | Hovers a labelled element and returns a fresh view, so hover-only menus and tooltips become clickable |
| `browser_select_option` | Chooses an option on a native `<select>` by label id and option text (a synthetic click cannot open the OS dropdown) |
| `browser_read_text` | Rendered page text (or just the viewport) as text, with `offset`/`max_chars` pagination. No screenshot; typically a few milliseconds and far fewer tokens |
| `browser_scroll` | Scrolls the document or the largest visible nested scroller; falls back to a **trusted wheel event** for canvas apps; returns a fresh screenshot |
| `browser_select` | Drag-selects between two points with trusted input outside Google Docs. Ordinary readable pages return selected text; other canvas editors return `selected.verified:false` and require visual confirmation before formatting or deletion. Google Docs rejects the drag before input because it can move text; use exact Find or guarded replacement tools there |
| `browser_docs_rename` | Renames a document in one guarded call: focuses the Rename textbox, verifies its exact value and focus before Enter, then verifies the committed document title and returns one final view |
| `browser_docs_replace_text` | Deletes or replaces one exact unique text match in one model call: native Find and Replace, one Replace click, match-counter verification, and one final view; an empty replacement deletes. Missing text is reported rather than substituting another target |
| `browser_docs_replace_many` | Applies up to 200 ordered `{text,replacement}` edits in one call and one dialog session, rechecking uniqueness and counters after earlier edits, then returning one final view. Ambiguity stops the batch and reports applied, failed, and unattempted edits explicitly |
| `browser_docs_format` | Formats one exact unique text match through `op:"docs", action:"format"`. Requires exact `text` plus at least one of `font` (exact visible name, max 100 chars), integer `font_size` 1–400, boolean `bold`/`italic`/`underline` (desired final states; `false` removes emphasis), or `paragraph_style` (`Normal text`, `Title`, `Subtitle`, `Heading 1`–`Heading 6`, applied to the containing paragraph). Guidance makes it the first call for supported exact-range formatting; it uses one Find selection and returns one final view |
| `browser_docs_select_text` | Selects exact text with optional `occurrence:"first"|"last"` or a positive one-based integer; omission requires a unique match. `scope:"text"` selects the match and `scope:"paragraph"` its containing paragraph. Returns text-only Find-counter evidence with no screenshot. There is no `all` or persistent multi-select mode |
| `browser_docs_format_many` | Formats 1–50 ordered exact ranges with the same occurrence semantics and any of eight attributes: `paragraph_style`, `font_size`, `bold`, `italic`, `underline`, `font`, `color`, and `highlight`. Baseline/final exports verify each edit and collateral, including structured link destinations and list metadata. Returns per-edit results and one final view, stops at the first failure, and uses 600 s executor/660 s provider budgets. Overlapping edits, paragraph style on list items, and opaque structures such as tables fail closed |
| `browser_docs_page_setup` | Sets Letter paper, portrait/landscape orientation, and any subset of inch margins in one guarded call. Changes only mismatched controls and verifies every requested value before OK; returns one final view |
| `browser_docs_write` | Appends up to 50 formatted blocks/20,000 chars at document end, including fresh documents. Blocks are single-line paragraphs, mixed inline `runs` (up to 100 per paragraph), flat numbered/bulleted/checklist groups of 1–100 items, `{blank:true}`, or `{page_break:true}`. Checklist items may be strings or `{text,checked}` objects. Font, size, emphasis, six-digit hex text color, and highlight (`none` allowed) are set before each run is inserted. Lists exit with Enter twice. Export convergence uses bounded increasing delays within 8 seconds and no retyping; exact runs, list type/order, checked states, page breaks, and the preserved prefix are verified. No existing-list conversion, nesting, arbitrary caret insertion, or blind retries |
| `browser_docs_read` | Reads the current document through authenticated export without navigation, page JavaScript, debugger, or a screenshot: `outline` (default), `text`, or bounded `html`, with explicit truncation. Export calls have bounded timeouts and at most two 429/503 retries. Read-only and parallel-safe with `browser_tabs` and `browser_read_text` |
| `browser_docs` | Remains font-only. With `action:"set_font"`, performs a guarded font change: exact unique-text find, exact role/name menu targeting, direct or More fonts add→close→reopen→apply, then toolbar verification and one final view. Missing fonts can leave text unchanged or delete only the matched text (`remove_if_missing:true`), never claiming the paragraph break was removed. Duplicate or missing text is left untouched |
| `browser_navigate` | Opens an absolute **http(s) URL** in the active tab or a new tab (`new_tab`), or goes history `back`/`forward`/`reload`; waits up to 15 s for load and reports `timedOut` |
| `browser_wait_for` | Waits for rendered **text**, a non-empty **url** substring, DOM **idle**, and/or an integer **ms** (0–30000), bounded by `timeout_ms`. An explicit timeout shorter than `ms` is rejected before sleeping; an omitted timeout expands to cover the fixed wait. Returns a fresh view and `found`/`timedOut` |
| `browser_tabs` | Lists the current window's tabs with ids, titles, URLs, and state |
| `browser_switch_tab` | Activates a tab by `tab_id` or by a case-insensitive title/URL `query`; returns a fresh screenshot |
| Vision model | Image-capable OpenRouter model through DSH's pi-ai adapter |
| Live activity | The side panel is a single full-height activity feed (there is no separate chat pane). It streams reasoning/thinking deltas, assistant text, partial and committed tool calls, results, browser commands, token usage, finish reasons, and errors as they happen. Events are grouped into **steps**; the running step is expanded with a live clock, every finished step **collapses to a one-line header** (outcome summary, model time, step total), the turn's final answer is pinned below the steps, and the footer keeps a per-step breakdown instead of only the turn total |
| Message queue | Sending during a turn stacks messages above the composer and dispatches them in order after each turn. A queued message's yellow arrow stops and redirects the current turn to that message; its × restores the text and attachments to the composer for editing |
| Composer input | Paste up to four PNG/JPEG/WebP/GIF images or screenshots with removable thumbnail chips; queued messages preserve them. The model selector includes live name/id search. Browser speech recognition inserts final and interim transcripts in real time, with a yellow microphone while active. Stop sits directly above Send, leaving more room for the model name. Text-file upload is no longer offered |
| Reasoning effort | **Auto** by default: requests `low` for every classification from the first model step, so thinking can stream while navigating, acting, reading, or synthesizing. The classification still appears in activity/logs. Manual `off`/`low`/`medium`/`high` override in Settings |
| Image history | The newest live screenshots are kept in the request and older ones are durably offloaded to placeholder text. Pruning runs at turn end and, mid-turn, in batched passes (one fingerprint/cache invalidation per 8+ new screenshots) instead of letting context grow without bound |
| Context control | DSH compaction is a safety net only: it triggers near **55% of the 1M window (~577 K prompt tokens)** and keeps a 20 K verbatim tail. The old 6%/2% policy was measured thrashing (79 passes, 27% of run wall) because provider-billed screenshot tokens were under-priced by the token meter; prompt size is now controlled by the image budget instead |
| Runaway guard | There is **no per-turn call limit**. Identical consecutive mutating repeats are refused: `maxRepeatedCalls` (default 3), `maxObservationRepeats` (default 30) for read-only tools, and `maxNavigationRepeats` (default 10) for unmodified navigation keys. State resets by session/user-message turn, and a different successful mutation starts a new repeat series. Three consecutive Docs replacement failures trip `DOCS_FAILURE_CIRCUIT`; a success or new turn resets it. A side-panel reconnect grace window (8 s) keeps a reload from killing a turn |
| Persistence | DSH session log and screenshot attachments under `.dsh-home` |
| UI | Single-pane side panel: full-height activity feed with step-grouped events and per-step timers, auto-collapsing finished steps (click a step to expand it again), a highlighted final-answer block, clickable empty-state prompts, **Stop above Send** during a turn, pause, settings, new chat |

**Not yet supported: drag/drop, file upload, downloads, native JavaScript dialogs, arbitrary JS, and full-page capture. DOM actions are limited to labelled, visible, hit-testable elements; canvas actions use explicit coordinates; typing goes only into labelled editable elements or the focused element; navigation is http(s) only. Clipboard is text-first; rich/system paste relies on the page's own Ctrl+V handling and the OS clipboard.**

### Canvas, video, and iframe surfaces

Canvas apps (Docs-style editors, maps, Figma-style tools, dashboards, games, video players) paint some or all of their content outside the DOM. The agent handles them in six ways:

1. **Surface metadata.** Every view lists visible `canvas`, `video`, and `iframe` regions with size and position, so the model knows when to switch from labels to coordinates.
2. **Coordinate clicks with trusted input.** `browser_click_at` maps screenshot pixels through the selected view's own scale, then dispatches via `chrome.debugger`. Stale/ambiguous bases are rejected before input. If the debugger cannot attach, it falls back to synthetic events and reports `trusted:false`.
3. **Pixel-diff verification where meaningful.** The side panel compares the before/after images around a click. Pixel changes can verify a visual response, but they do not prove which document text or font changed.
4. **Burst clicking outside known document editors.** Games and ordinary canvas pages can click up to twenty points with one debugger attach, adaptive settle, and capture. `view:"none"` remains available there for rapid bursts; off-screen points are not clamped and clicked.
5. **Honest typing and selection.** Unlabelled `browser_type` inserts at the caret/current selection through trusted `Input.insertText`. Canvas typing is `dispatched` with `changed:null`, and canvas drag selection is `verified:false`; aggregate DOM text/mutations never become fake delivery or character-count evidence. The returned full view is the confirmation. Unsupported canvas append/empty clearing and off-screen selection endpoints are refused.
6. **Strict Docs primitives plus guarded semantic actions.** Primitive Google Docs/Sheets/Slides actions keep the full-fresh-view rule, no dependent batches/bursts, and newest-view coordinate guards. `browser_docs_replace_text` performs exact unique deletion/replacement with one native Replace click and match-counter verification; `browser_docs_replace_many` applies ordered batches under the same per-edit checks; `browser_docs` with `action:"set_font"` remains the guarded font-only operation; `browser_docs_format` handles supported compound exact-range formatting. Each returns only one model-facing view. Duplicate text and ambiguous font names fail closed.

`browser_docs_format` protects one exact unique Find selection with a per-tab lock and stale-tab checks. It applies attributes in the fixed order paragraph style → size → bold → italic → underline → font, rereads state after dependencies, skips already-correct values, and verifies every requested attribute. Font-size commit requires verified field focus and value before Enter. Missing or duplicate text fails before formatting. A missing font never deletes text; if earlier attributes changed, the result is `partial` with per-attribute results and failure details. Other failures stop immediately and name verified earlier changes plus the current unverified attribute. There is no generic Docs batch unlocking or replacement+format combination. Real-Docs acceptance is still pending.

`browser_click_role` handles exact 1–4-step role/name paths through page chrome, including menus that appear between steps. It normalizes whitespace but matches accessible names case-sensitively, waits for targets, revalidates identity/geometry before trusted input, and rejects editor, canvas, and document-content targets. Its final full view and `roleClick` result describe the path taken, not whether the application produced the intended outcome. `ROLE_CLICK_UNSETTLED` means delayed input may still be pending and is not safe to retry.

`browser_docs_select_text` selects an exact unique match or an explicit first/last/positive-integer occurrence. Text scope selects only the match; paragraph scope maps the anchor to one exported containing paragraph and fails closed when that mapping is ambiguous or opaque. Its structured text-only result carries Find-counter evidence, not an empty screenshot. It does not provide an `all` mode or persistent multi-selection. Use `browser_docs_format` or `browser_docs_format_many` instead for formatting they support.

`browser_docs_format_many` plans 1–50 non-overlapping edits from a baseline export, rechecks each native Find occurrence, and stops at the first failure with per-edit/per-attribute applied, failed, and unattempted results. Final export verification compares every requested attribute and collateral text, block/list metadata, run marks, and structured `href` destinations. Paragraph-style verification permits only explainable uniform inherited font/size/bold changes in the styled paragraph. Paragraph style on an `LI`, overlapping targets, and opaque structures such as tables fail closed. It returns one final view and has a 600-second executor budget plus a 660-second provider budget. This is a bounded semantic formatter, not generic Docs mutation batching. `DOCS_UNSETTLED` is not safe to retry: an in-flight mutation may remain, so issue no further mutations and inspect with `browser_docs_read` after the tab stabilizes. **No live Google Docs acceptance has been performed for `browser_click_role`, `browser_docs_select_text`, or `browser_docs_format_many`; reload the normal unpacked extension before running the checklist scenarios.**

`browser_docs_write` handles rich append-at-end creation without model calls between blocks or post-typing format repairs. It establishes an export baseline and document-end color state, so default black text does not open a custom-color dialog unnecessarily. Frame-aware editor focus plus an export position check runs before any formatting; a missing end paragraph or moved prefix stops with `DOCS_WRITE_POSITION` before collateral edits. List shortcuts read `aria-pressed` on exact controls even when overflow-hidden, without clicking them. The writer sets font/size/emphasis/color/highlight ahead of every text run, inserts numbered/bulleted groups and checked checklist items, supports page breaks, and exits lists with two Enters. Font-menu handling filters unusable rows and deduplicates only equivalent exact-name rows in the same active menu; conflicting menus still fail. A bounded increasing-delay eight-second export-convergence loop rechecks appended content without retyping or extra screenshots. Final verification compares the preserved prefix and every run's exact text, font/size, emphasis, color, highlight, list type/order, checked state, and page break. `browser_docs_read` exposes the same independent export as compact outline, plain text, or bounded HTML. Empty list items, collateral prefix edits, and persistent divergence are partial/failed, never success. Live Feature Document acceptance remains pending.

Canvas apps also keep their own scroll state, so `browser_scroll` first tries the DOM; if nothing moved, it dispatches a trusted wheel event at the viewport center and reports `wheel:true`. Compact/skipped views invalidate stored images after scroll, resize, layout, or structural control changes. Every Chrome capture has a 5 s watchdog. The first timeout focuses the owning window and permits one bounded retry; only a persistent second timeout opens the 30 s fail-fast capture circuit. Normal captures do not change OS focus.

### Batching and view modes

Measured on real work sessions, the loop was dominated by two costs: **one model round trip per action** (the model averaged 0.96 tool calls per step, so a 62-action Docs turn was 62 requests) and **a full view returned by every action** (a 1280 px JPEG plus up to 60 label lines, which grew the prompt to 134 K tokens per step on average and 245 K at worst). Three mechanisms fix that at the root:

- **Known-call composition** puts all already-known calls for one logical unit in one assistant response instead of spending a thinking step after every action. Browser mutations remain exclusive and execute in model order; only `browser_tabs`, `browser_read_text`, and `browser_docs_read` may overlap. The runtime cap is four, not a license for concurrent document writes. Split only when later arguments depend on newly revealed state, and do not add a screenshot just to recheck evidence already returned.
- **`browser_batch`** executes an ordered action list inside the extension with one final view on ordinary pages. It stops at the first failure by default; `stop_on_error:false` is only for independent, non-canvas edits. Results say how many actions executed without tool errors and separately count UNVERIFIED outcomes; earlier actions are not rolled back. Google Docs/Sheets/Slides reject dependent mutating batches.
- **View modes** on ordinary DOM actions: `auto` (default) returns a compact confirmation with no screenshot plus a label delta, escalating to a full view on page identity changes, after 5 compact actions, or on demand. `view:"none"` omits even the delta. Known document editors override these shortcuts and always return a full view after an action.

A compact DOM action costs **18–35 ms** on a heavy page (no capture, no re-encode) instead of 360–1266 ms. Label ids stay cumulative per tab, so an id from an earlier view still resolves to the same element or fails stale. Compact/skipped views invalidate the stored screenshot after scrolling, resizing, layout shifts, or structural control changes so image-space `browser_click_at` fails safely instead of clicking the wrong pixel.

### Speed levers

Beyond batching and compact views, four controls keep work sessions fast:

- **Reasoning effort.** Older measurements compared `off` at **0.87–1.94 s/step** with `low` at **3.16–6.96 s/step**. Auto now deliberately requests `low` for every classification from the first model step so thinking is visible during generation; the classification is for activity/logging, not for disabling reasoning. Choose manual **Off** for the old latency tradeoff, or Low/Medium/High to force a level.
- **Context control.** Compaction is now a safety net near 55% of the 1M window (~577 K prompt tokens), with an explicit 20 K retained tail. The previous 6% policy (63 K) was measured thrashing: 79 compaction passes in 11 turns, 27% of total turn wall, because provider-billed screenshot tokens were under-priced by the harness token meter (53 metered vs 674–990 billed), so every pass freed only ~2.8 K and immediately re-fired. Prompt size is controlled by the image budget instead: mid-turn offload keeps the newest live screenshots and batches the rest, so the cache is invalidated once per 8+ new screenshots rather than every step.
- **Fast screenshots.** `browser_screenshot` with `detail:"fast"` returns a 640 px view (~195 image tokens instead of ~780) for quick visual checks.
- **Loop guards.** There is no per-turn call cap. Read-only observations get 30 identical repeats, unmodified navigation keys get 10, and mutating calls plus every modified chord (including Shift-selection) get 3. A side-panel reload gets an 8 s reconnect grace window and a retryable `SIDE_PANEL_CLOSED` error instead of instantly killing the turn.

Shadow DOM and iframes are handled for DOM clicking:

- Open shadow roots are traversed recursively, so web-component controls are labelled and clickable.
- Every accessible frame is labelled; child-frame labels get globally unique ids (`frameId * 100000 + localId`) and the click is dispatched into the owning frame. Same-origin and cross-origin frames both work because the extension has `<all_urls>` host access.
- Hover-only menus: `browser_hover` reveals the menu and returns a fresh labelled view; then click the new label.
- Native selects: clicking cannot open the OS dropdown, so `browser_select_option` sets the value and fires `input`/`change`.

**Permissions and warnings:** trusted input requires the `debugger` permission, plus `webNavigation` for the frame list; clipboard support adds `clipboardRead`/`clipboardWrite` (Chrome shows a "Read data you copy and paste" prompt). Chrome shows a "started debugging this browser" banner while a trusted click or wheel is being dispatched (attach → dispatch → detach, roughly 100 ms). If DevTools is open on that tab, the debugger cannot attach; DOM clicks still work, and `click_at` reports the conflict.

### How clicking stays accurate

Every full view (auto-capture, screenshot, scroll, tab switch, navigate, and any action that refreshes the view) labels the interactive elements in the viewport; compact results carry only a delta of that list:

- Candidates are links, buttons, inputs, selects, textareas, summaries, labels, ARIA button/link/tab/menuitem/checkbox/switch/radio/option/combobox roles, `[onclick]`, and focusable elements.
- An element is labelled only if it has a real box, is visible, is not `pointer-events: none`/`aria-hidden`/`inert`/disabled, and is the element a real click would hit at its centre. Covered controls behind a modal or cookie banner are therefore not offered.
- Each label is a yellow numbered badge plus a thin outline drawn in an overlay; the same list is sent as text, capped at 60 entries with a count of the rest.
- Label ids are **persistent per element** for the page lifetime (`WeakMap`). A stale id either resolves to the same element or fails as `UNKNOWN_LABEL`/`DETACHED`; it never silently lands on a different element.
- A click dispatches the pointer/mouse sequence a real click produces (`pointerover`, `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`) at the element centre, after scrolling it into view and re-checking the hit test.
- The result reports `changed` with signals: `url-change`, `title-change`, `scroll-change`, `text-change`, `dialog-change`, DOM mutation count, `checked`, `aria-expanded`, `aria-selected`. A no-op click returns **NO VISIBLE CHANGE** and explicitly tells the model not to repeat it.
- Disabled controls are labelled but refused with `DISABLED`; obscured, detached, and unknown labels also fail closed.

Clicking is label-only: the model never supplies coordinates, so viewport scaling and DPR cannot cause a miss.

## Requirements

- Chrome/Chromium/Edge **116+** with the Side Panel API.
- **Node 22.19+** (tested on Node 26.8.1).
- An **OpenRouter API key** and an **image-capable, tool-capable model**. The side-panel model selector loads OpenRouter's public catalog, filters to models that accept images and support tool calls, and defaults the base URL to `https://openrouter.ai/api/v1`. The recommended model is `deepseek/deepseek-v4.1-flash-1017` if your account can use it.
- A normal website tab. Chrome blocks screenshots/scripts on `chrome://`, extension, Web Store, and similar pages.

## Quick start

```sh
npm install
npm run setup     # initializes .dsh-home/profiles/sdk-minimal and links the plugin
npm run dev       # starts the loopback companion; DSH starts after you configure the model
```

`npm run dev` prints a bridge URL and a pairing token. Then:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** → **Load unpacked** → select the `extension/` directory.
3. Click the CrazyAgent toolbar icon; the side panel opens.
4. **Settings:** paste the pairing token; enter your OpenRouter API key; keep the prefilled base URL; click **Refresh models**; select an image-capable model; leave **Remember the API key** checked if you want it stored on this machine; click **Save**.
5. Wait for **Connected** and the model status to show the selected model. Visit a normal page and ask:

   - “What is on this page?”
   - “Scroll down and tell me what’s visible.”
   - “List my tabs, then switch to the tab titled …”

Keep the side panel open while the agent runs; it is the browser bridge.

### What `npm run setup` does

The npm-distributed `dsh` CLI rejects plugin-management commands, so setup performs the equivalent local linking:

- initializes the `sdk-minimal` profile under `.dsh-home/profiles/sdk-minimal`;
- links `dsh-browser-use`, `dsh-llm-pi-ai`, and `dsh-credentials-local` into the profile from the root install;
- links `packages/dsh-browser-extension` as `dsh-browser-extension`;
- checks that the provider imports and that `config/browser.patch.yml` composes with `--dump-config`.

The plugin is a normal DSH provider package. Once you save a model, the companion writes `.dsh-home/browser-agent/llm.patch.yml` and launches:

```sh
dsh --profile sdk-minimal --patch config/browser.patch.yml --patch .dsh-home/browser-agent/llm.patch.yml
```

## How the pieces fit

### 1. Side panel (`extension/`)

- Vanilla ES modules, no bundler.
- Owns the bridge WebSocket and all `chrome.*` calls; no persistent content script.
- `snapshot` runs page metrics and `chrome.tabs.captureVisibleTab` in parallel, downsizes to 1280 px (2048 px for `detail: "high"`), encodes JPEG, and returns metadata plus base64.
- `scroll` injects a self-contained page function that picks the document or the largest visible scrollable container, scrolls it, waits for two frames plus a short settle, then captures.
- `tabs.list` queries the current window; `tabs.activate` updates the active tab, waits for activation, and captures.
- Captures are throttled to Chrome's 2/second quota and retried once on a quota error.
- A pause toggle rejects browser commands; the toolbar badge shows activity.
- Settings store bridge URL, token, capture width, JPEG quality, and per-message auto-view.

### 2. Companion (`companion/`)

- Binds `127.0.0.1` only, serves `GET /health` and a WebSocket at `/bridge`.
- Requires a random pairing token (`.dsh-home/browser-agent/token`, mode 0600) on the `hello` frame.
- Accepts one `ui` role (side panel) and one `tools` role (the DSH provider); stale connections are replaced.
- Warms one `DeepSeekHarness` at startup, then routes chat turns and browser commands.
- On a user message, asks the side panel for a snapshot and sends it as an image block in the prompt (unless auto-capture is off); then streams relevant DSH session events into the activity feed as step rows, tool results, and status.
- Writes a detailed per-run debug log under `.dsh-home/browser-agent/logs/<runId>/`: every bridge frame, extension/plugin event, raw DSH notification, tool call, screenshot, and timing. Inline image bytes and secrets are redacted; screenshots are separate files. The side panel exports the whole run as a ZIP.
- No mid-turn cancel in Phase 1 (the SDK protocol has no cancel method). Pause disables browser access; closing the companion ends the runtime.

### 3. DSH provider (`packages/dsh-browser-extension/`)

- A first-class `browser-use` provider named `extension-current-window`.
- Registers exactly nine tools through DSH's MCP adapter, which provides durable image admission, route image-capability checks, and PTC-compatible values.
- Each tool sends one `browser.command` to the companion, awaits the matching result, and returns MCP content: a compact text envelope and, for snapshots, an image block.
- Registers a short, stable system-prompt section at `TOOL_COMPUTER_USE` order. Logs go to stderr; DSH stdout stays reserved for JSON-RPC.

### 4. DSH composition (`config/browser.patch.yml`)

Starts from `sdk-minimal` and:

- adds `credentials-local`, a dormant pi-ai adapter (filled by the generated OpenRouter overlay), the browser-use registry, and the provider;
- disables `tool-fs`, `tool-working-directory`, the persistent shells, and the stock DeepSeek adapter;
- sets a browser-agent persona, disables harness identity/runtime context, keeps browser mutations exclusive in model order, and allows up to four parallel calls only for declared read-only tools (`maxParallelToolCalls: 4`);
- leaves attachments, compaction, image offload, and JSONL persistence in place.

The composed result is 27 model-facing tools, distinct from the nine MCP adapter registrations above, and a small, stable request prefix. The side panel also has a **Stop** button while a turn is running (it interrupts the DSH runtime through a companion `chat.stop` request and resumes the same session on the next message) and a single full-height live-activity pane.

## Configuration

### Model, base URL, and route

Configure all three in the side panel **Settings**:

- **OpenRouter API key** — paste a key; it is sent over the loopback bridge, passed to DSH as `CRAZYAGENT_API_KEY`, and never written to `chrome.storage.local`.
- **Model base URL** — prefilled with `https://openrouter.ai/api/v1`; editable for an OpenRouter-compatible gateway.
- **Model** — click **Refresh** to fetch the public OpenRouter catalog. The list is filtered to chat models that accept images and support tool calls. The input is searchable via the browser datalist; type to filter. The recommended default is `deepseek/deepseek-v4.1-flash-1017` when available.
- **Reasoning effort** — Auto (default), Off, Low, Medium, High. Auto is described below.

Saving writes a non-secret `.dsh-home/browser-agent/llm.json` and a generated `.dsh-home/browser-agent/llm.patch.yml`; restarting the companion reuses them. Changing the model or base URL restarts DSH and tries to resume the current session. The base patch (`config/browser.patch.yml`) intentionally leaves the pi-ai route dormant so the generated overlay can supply the selected OpenRouter route.

CLI equivalents (optional):

```sh
npm run dev -- --base-url https://openrouter.ai/api/v1 --model deepseek/deepseek-v4.1-flash-1017 --reasoning-effort auto --max-tokens 8192
```

Reasoning effort defaults to **Auto**. For models whose OpenRouter metadata advertises reasoning support, the generated route declares `off`/`minimal`/`low`/`medium`/`high` and sends OpenRouter's `reasoning: { effort }`; `off` is sent as `effort: "none"`.

Auto classifies the user prompt once per turn for activity/logging, then requests `low` for every class from the first model step:

| Turn class | Examples | Auto effort |
|---|---|---|
| Navigation | “scroll down”, “list my tabs”, “go to my emails” | `low` |
| Rapid | “play the canvas game”, “click the targets” | `low` |
| Act | “format this line”, “fill in the form”, “delete the extra paragraph” | `low` |
| Inspect | “what is on this page?”, “go to Docs and tell me what’s there” | `low` |
| Synthesis | “summarize this”, “compare the tabs”, “why…”, long or multi-question prompts | `low` |

Every decision is logged as `reasoning.policy` with the classification, effort, and prompt size. Choose **Off** in Settings to suppress model reasoning, or `low`/`medium`/`high` to force a level. Models without reasoning support send no effort, and providers that expose only a reasoning summary rather than full deltas can only show that summary.

The live activity feed shows a `policy` entry per turn and streams reasoning deltas when the provider exposes them. Every turn is grouped into numbered steps; the running step is expanded with a live clock, each finished step collapses to its header (outcome summary, model latency, step total) and can be expanded again by clicking it, the final answer is shown as a pinned block, and the footer keeps the per-step list plus the turn total.

### API key sources

The side panel is the primary path. Resolution order on companion start:

1. `CRAZYAGENT_API_KEY` in the companion environment;
2. `.dsh-home/browser-agent/api-key` (written only when **Remember** is checked; mode `0600`);
3. `OPENROUTER_API_KEY` in the environment;
4. `refs.OPENROUTER_API_KEY` in the DSH credential store (`~/.dsh/.credentials.yaml` or `CRAZYAGENT_CREDENTIALS_PATH`).

The side-panel value is validated against `GET {baseUrl}/key` when entered; a 401/403 is reported without restarting DSH. The key is redacted from debug logs and never appears in the generated patch or `llm.json`. If no key or model is configured, the companion keeps the bridge running and the side panel opens Settings instead of starting DSH.

### Harness home

Everything generated lives under `.dsh-home/` (ignored by git): profile, sessions, attachments, token, and debug logs. The user's `~/.dsh` directory is only read for the credential store.

```sh
npm run clean -- --yes   # removes .dsh-home; run npm run setup again afterwards
```

## Performance (measured on this machine)

| Measurement | Result |
|---|---|
| Bridge round-trip, no Chrome/model (`npm run bench`) | p50 **0.05 ms**, p95 **0.1 ms** |
| `browser_read_text`, 372-char fixture page | **4 ms** (no screenshot) |
| `browser_switch_tab` by query (match + activate + screenshot) | **1.08 s**, of which 140 ms is the tab-activation settle and ~90 ms capture |
| Interactive labelling (9–120 elements) | **7–21 ms** per view |
| Click dispatch + settle + fresh view | **~250–370 ms** with no capture-quota hit; Chrome's 2-per-second capture quota can add ~650 ms when three captures land in one second |
| Label a page with two child frames | **14–21 ms** (one round trip per frame) |
| Trusted canvas click (attach → dispatch → detach) + adaptive pixel-diff view | **~200–300 ms** including the fresh view; the fixed 160 ms settle is now an adaptive two-frame paint wait |
| Canvas burst, 5 points in one call | **one model round trip instead of five**; extra points cost a few ms each, and `view: "none"` drops a 5-point burst to **~50 ms** on the fixture |
| Compact DOM action, no capture (`click`/`type`/`press_key`) | **18–35 ms** on a heavy page vs **360–1266 ms** when the action returns a full view |
| `detail:"fast"` screenshot | **~80–90 ms** capture/encode, 640 px, ~195 image tokens (vs ~780 for `normal`) |
| `browser_batch`, 4 known-label actions | **~85 ms** of actions plus **~160 ms** for the single final view — one round trip instead of four |
| Live snapshot: capture + encode + metadata | **95 ms** total (capture 31–35 ms, encode 35–58 ms) |
| Auto-view observed in the real UI | **58–73 ms** |
| Real screenshot | 1018×768 CSS at DPR 2 → 1280×966 JPEG, ~96 KB |
| First model step input tokens (auto-view + prefix) | **1,934** |
| Per-turn user prompt text (view + question), fake check | **351 bytes** |
| “Describe + scroll 700 px” turn | **6.4 s**, 1 tool |
| “List tabs + switch tab” turn | **10.0 s**, 2 tools |

The turn timings below were measured on the earlier Alibaba route with the same DeepSeek model; OpenRouter route latency will differ by model. Capture/tool overhead is provider-independent. Detailed methodology and caveats are in [`docs/PHASE1-BENCH.md`](docs/PHASE1-BENCH.md).

## Debug logs

Every companion run writes a detailed log under:

```text
.dsh-home/browser-agent/logs/<runId>/
├── events.jsonl          every bridge frame, client event, DSH notification, tool call, and timing
├── screenshots/          real JPEG captures (one file per captured view)
├── summary.md            written on export: timeline, signals, tool calls, assistant text
├── summary.json          written on export: machine-readable turn model
├── environment.json      written on export
├── manifest.json         written on export
└── exports/              generated ZIP bundles
```

Click the **▤** button in the side panel to open **Debug log**. It shows the run id, log path, event/screenshot counts, warnings/errors, recent signals, and offers:

- **Download bundle** — a ZIP containing `summary.md`, `summary.json`, `events.jsonl`, `environment.json`, `manifest.json`, optional screenshots, and the optional raw DSH session log.
- **Copy summary** — the Markdown timeline, convenient for pasting into a chat.
- **Copy logs path** — the local directory, useful when a bundle is too large to send inline.

The bundle is written locally even when it is too large to send over the bridge. Inline exports are limited to ~12 MiB; larger bundles return the path instead.

**Redaction:** pairing tokens, API-key-shaped strings, authorization headers, secret-named fields, sensitive URL query parameters, and inline base64 image data are removed from JSONL. Screenshots are separate files and can contain page content; the export dialog lets you exclude them. The raw DSH session log includes the model conversation and tool metadata; it can also be excluded. Read [`PRIVACY.md`](PRIVACY.md) before sharing.

Full schema, event types, `jq` recipes, and sharing instructions are in [`docs/DEBUG-LOGS.md`](docs/DEBUG-LOGS.md).

## Privacy and safety

- The extension requests `<all_urls>` so it can capture and scroll arbitrary websites. It does not inject a persistent content script; page code runs only during a tool call.
- Screenshots are sent to your configured model provider through DSH. They are also stored as DSH attachments and session logs under `.dsh-home`.
- The bridge is loopback-only and token-authenticated. The token is stored in `chrome.storage.local` and in `.dsh-home/browser-agent/token`.
- Auto-view can be turned off per side-panel settings; **Pause** disables browser commands without ending the chat.
- Page content is treated as untrusted data in the prompt. Clicking and typing can submit forms or trigger actions a page chooses; actions are limited to visible labelled controls, explicit coordinates, explicit text/keys, and http(s) URLs, and every action reports whether the page changed.
- The label overlay is injected into the page for the duration of each view and is not persisted after the tab navigates.
- Read [`PRIVACY.md`](PRIVACY.md) before using this on pages with sensitive information.

## Development and tests

```sh
npm test          # unit/integration checks: bridge/reconnect/stop, live activity, reasoning policies, image budgets, browser tools, guarded Docs font/format/replacement flows, canvas honesty, capture/view/wait guards, tab matching, log redaction, and prompt composition
npm run system-prompt  # print the exact composed system prompt (--json for counts)
npm run bench     # local bridge latency
npm run setup     # idempotent profile/plugin verification
```

The current verified full suite passes **428/428**, including exact role-path, Docs selection, multi-range formatting, per-turn time context, recovery guidance, hidden-dialog disambiguation, Page setup resume/orientation/close recovery, overflow list controls, standalone write-block schemas, checklist/page-break writing, export serialization/cooldown/convergence, and mixed inline writer/parser/provider coverage. `npm run setup` and system-prompt composition pass, and the isolated Edge click/advanced/canvas suites pass after role hardening. **No live Google Docs acceptance has been performed for the three new semantic tools.** Unit/fake-driver and isolated-fixture coverage is not real-Docs acceptance; reload the normal unpacked extension before the checklist runs.

Additional dev-only checks (not part of `npm test`):

- `node scripts/fake-ui.mjs` — a fake sidebar that answers browser commands with a local JPEG; exercises the companion + DSH provider + model without Chrome.
- `scripts/edge-probe.mjs`, `edge-e2e.mjs`, `edge-tabs-e2e.mjs` — drive the real extension executor/UI in Edge over CDP. They require Edge launched with `--load-extension=extension` and a remote-debugging port. These produced the live measurements above.
- `scripts/log-probe.mjs` — connects as a fake side panel and requests `log.stats`, `log.summary`, and a ZIP export without starting a model turn.
- `scripts/edge-log-e2e.mjs` — drives the real Debug log modal and verifies that the ZIP download starts.
- `scripts/edge-click-e2e.mjs` — drives the real extension against `e2e/fixtures/click.html`: label coverage, covered/hidden exclusion, click by label, no-op detection, disabled/stale refusals, checkbox, and navigation. Requires Edge with `--load-extension=extension` on port 9228.
- `scripts/edge-canvas-e2e.mjs` — real-extension canvas checks on port 9230: surfaces, trusted coordinate focus/click, image-pixel mapping, pixel diffs, wheel scrolling, empty-area no-op, 5-point burst, `view:"none"`, `delay_ms`, single-point compatibility, and a canvas-rendered text editor proving exactly-once insertion while the result remains explicitly UNVERIFIED. The fixture reload bypasses cache so repeated runs exercise the files on disk.
- `scripts/edge-work-e2e.mjs` — work-foundation checks on port 9233 against `e2e/fixtures/form.html`: labelled typing (replace/append), compact typing with label deltas, auto-view escalation, contenteditable typing, password masking, `submit`, Tab/Enter, modifier shortcuts, label-less trusted typing into a focused editor, navigate URL/history, `wait_for` found/timeout, batch sequences (success, stop-on-error, continue, `BAD_BATCH`), punctuation keys, label persistence across views, drag selection (range + collapsed), `batch [select, ArrowRight]`, `detail:"fast"` 640 px snapshots, focus-fallback typing into a non-editable card, and named punctuation keys.
- `scripts/edge-advanced-e2e.mjs` — shadow DOM, same- and cross-origin iframes, native select, and hover menus on port 9231.
- `scripts/ui-preview.mjs` — **UI development harness**: opens the side-panel page in an isolated Edge with a mocked bridge socket, injects a scripted conversation, and screenshots the `empty`, `turn`, `live`, `states`, `tools`, and `modals` states into `--out` (no companion or model tokens needed). The single-pane reference frames live in [`docs/ui/`](docs/ui/).

The fake-UI and Edge end-to-end scripts assume the companion is already configured with an OpenRouter key/model and that the model supports tools. Configure once from the side panel first. The model-latency figures were collected on the earlier direct Alibaba route; capture, bridge, tool, and logging measurements are provider-independent.

The CDP checks open the side-panel page as a normal extension tab because automating the docked side panel is awkward; the same UI code and `chrome.*` executor path are exercised. Use the manual checklist for the docked surface.

Manual side-panel checklist: [`e2e/checklist.md`](e2e/checklist.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| “Companion offline” | Run `npm run dev`; click Reconnect. The bridge must be running before the side panel connects. |
| “Invalid pairing token” | Copy the token printed by `npm run dev` (or `.dsh-home/browser-agent/token`) into Settings. |
| “No OpenRouter model selected” / “No API key” | Open Settings, paste an OpenRouter key, click Refresh, select a model, and Save. |
| OpenRouter rejected the API key (401/403) | Check the key at openrouter.ai; paste it again and Save. |
| Model list fails to load | Check the base URL (`https://openrouter.ai/api/v1`), network access, and click Refresh again. |
| DSH fails after model selection | The selected model may not accept images/tools or your account may not have access; pick another model and Save. |
| Saved key is forgotten after restart | Leave **Remember the API key** checked, or export `CRAZYAGENT_API_KEY` / `OPENROUTER_API_KEY`. |
| “Browser bridge is not connected” on a tool call | The side panel was closed or paused; open it and keep it open. |
| “Chrome blocks screenshots/scripts on this page” | Switch to a normal website tab; `chrome://` and extension pages are protected. |
| Tool returns a text-only image refusal | The selected model route does not declare image input; switch routes. |
| Plugin changes do not apply | Restart the companion (DSH imports the provider once); reload the extension for side-panel changes. |
| Extension changed but UI stale | `chrome://extensions` → reload the extension, then reopen the side panel. |

## Phase 2 (not implemented)

Typing and key presses, drag/drop and sliders, file upload, native dialogs (`alert`/`confirm`/print), downloads and new-window popups, browser-chrome interactions, multi-window and tab groups, closed shadow roots, sandboxed/isolated frames the extension cannot inject, the built-in PDF viewer, captchas, token streaming, mid-turn cancel, native-messaging auto-start, packaging/signing, Firefox.

The screenshot metadata records viewport CSS size, image pixels, DPR, scroll position, and `cssPerImagePixel`; clicking uses stable element labels rather than image coordinates, so precision does not depend on the model estimating pixels.

## Repository map

```text
config/browser.patch.yml              DSH profile overlay
packages/dsh-browser-extension/       browser-use provider + 27 model-facing tools
companion/                            bridge, DSH SDK lifecycle, prompt, debug log store
extension/                            MV3 side panel + browser executor
scripts/setup.mjs                     profile init and local linking
scripts/dev.mjs                       start the companion
scripts/fake-ui.mjs                   headless bridge/model check
scripts/edge-*.mjs                    live Edge CDP checks
e2e/fixtures/                         deterministic test pages
docs/PHASE1-BENCH.md                  performance measurements
e2e/checklist.md                      manual acceptance checklist
```

## Attribution and versioning

- DSH is pinned to `0.2.1-rc.2` (the same tag as the local `/home/conan/Downloads/deepseek-harness` checkout, used as reference). No DSH core source was modified for Phase 1; the provider/plugin composition is the modification surface.
- If a measured core bottleneck appears (for example, live token streaming or mid-turn cancel), vendor and patch only the affected DSH package rather than forking the whole monorepo.