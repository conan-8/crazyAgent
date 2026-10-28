# CrazyAgent manual acceptance checklist

Use a **normal website tab** and the real side panel (not the extension page opened as a tab). Keep the companion running in a terminal.

## Preconditions

```sh
npm install
npm run setup
npm run dev
# second terminal, optional fixture pages:
python3 -m http.server 17872 --bind 127.0.0.1 --directory e2e/fixtures
```

- Chrome/Edge 116+; extension loaded unpacked from `extension/`.
- **Before live Google Docs acceptance, reload the normal unpacked extension at `chrome://extensions` or `edge://extensions` and reopen the side panel.** Do not run these scenarios against a stale cached executor or the extension page opened as a tab.
- Side panel token pasted in Settings; OpenRouter API key entered; **Refresh models** used and an image-capable model selected; Save clicked; status says **Connected**.
- Every view shows yellow numbered badges on visible controls.
- A normal tab is active. `chrome://` and extension pages are expected to fail.
- The new `browser_click_role`, `browser_docs_select_text`, and `browser_docs_format_many` scenarios below have **no live Google Docs acceptance yet**. Unit/profile results and isolated Edge click/advanced/canvas suites do not check them off.

## Checks

### 1. Open the side panel and configure the model

- Click the toolbar icon.
- If prompted, open Settings: paste the pairing token; paste the OpenRouter API key; keep the base URL `https://openrouter.ai/api/v1`; click **Refresh models**; pick an image-capable model (e.g. `deepseek/deepseek-v4.1-flash-1017`); leave **Remember** checked; Save.
- The side panel shows the brand, active tab title, and a green status dot.
- The active tab line updates when you switch tabs manually.
- **Pass:** no error banner; Settings shows the key as configured and the model status names the selected model and **effort low** when the model supports reasoning; the model list shows hundreds of image-capable models.

### 1c. Reasoning policy

- With **Auto** effort, ask **“scroll down”**: the activity feed should show `policy: reasoning low (navigate, auto)` and stream thinking from the first model step.
- Ask **“what is on this page?”**: the next `policy` line should also show `reasoning low (inspect, auto)`.
- Switch to **Off** in Settings and save; every later turn should show `reasoning off` and no model reasoning content (provider-supplied summaries may still appear).
- **Pass:** one `policy` line per turn; Auto always requests low, while manual Off is respected.

### 1b. Live activity and per-step timing (single full-height pane)

- Ask a question on a normal page and keep the side panel visible.
- The side panel is one **full-height activity feed** — there is no separate chat pane. Expect the feed to update while the turn runs: numbered **Step** blocks, each with a **thinking** row with reasoning/thinking deltas (when the provider exposes them), **assistant** text, tool rows with their own duration, browser actions, and token usage.
- While a step runs it stays expanded and its header clock ticks; the activity header shows `step N · X.Xs`; the footer shows the completed steps so far plus the live one.
- **As soon as the next step starts, the finished step collapses to a single header line** (`Step 1 clicked #12 Increment · changed … model 1.7s 2.8s`). Click a collapsed header to expand it again; click it once more to collapse.
- After the turn, every step is collapsed, the turn's final answer is pinned below the steps as an `ANSWER` block, and the footer shows every step's own time plus the turn total (`⏱ s1 1.4s · s2 2.1s · total 5.6s`); hover it for the full breakdown. Expand the step to read its reasoning and tool rows.
- Successful auto-captures must not append the redundant title/dimensions/KiB/scroll/labels/capture/encode row. Tool-driven screenshots still show their thumbnail and errors stay visible; all metadata remains in the debug log.
- **Pass:** each step's own time is visible during the run, not only the total after it finishes; finished steps collapse automatically; the final answer stays visible; activity appears before the turn completes; the reasoning text is available for reasoning-capable models; no UI errors.

### 2. See the page

- On the fixture page (`/article.html`), ask: **“What is on this page?”**
- Expect a “current view” card with a thumbnail, then an assistant answer mentioning **Section Alpha** / **ALPHA-MARKER**.
- **Pass:** the screenshot matches the visible viewport; text is readable; no screenshot tool call is needed (auto-view).
- Open the thumbnail; it enlarges and closes with Escape/✕.

### 2b. Read text

- On the fixture page, ask: **“Read this page and tell me the three markers.”**
- Expect a `read text` card with a text preview and a character count, no screenshot, then an answer naming **ALPHA-MARKER**, **BETA-MARKER**, and **GAMMA-MARKER**.
- **Pass:** no screenshot is captured for that call; the card shows the extracted text; latency is a few milliseconds.

### 2c. Click

Use `e2e/fixtures/click.html`.

- Ask: **“Click Increment and tell me the count.”**
- Expect a `click` card with `clicked #<id> Increment`, `changed`, a fresh screenshot with yellow badges, and an answer saying **count: 1**.
- Ask: **“Click Increment twice more.”** The count should be **3**, and the label id for Increment should stay the same across views.
- Ask: **“Click Does nothing.”** The result must say **NO VISIBLE CHANGE**, and the model must not repeat it blindly.
- Ask: **“Click Disabled action.”** Expect a `DISABLED` error, not a click.
- Ask: **“Click the Toggle me checkbox.”** Expect `checked: true`, a visible tick, and a change signal.
- Ask: **“Click Go to second page.”** Expect `navigated: true`, a screenshot of `second.html`, and new labels.
- **Pass:** no click lands on a covered or hidden control; each click reports the exact element it hit; a no-op is reported honestly.

### 2d. Canvas and surfaces

Use `e2e/fixtures/canvas.html`.

- Ask: **“Click the middle of the canvas.”** Expect a `click_at` card with `trusted input`, a pixel-change percentage, and a red dot drawn on the canvas.
- Ask: **“Scroll down on the canvas.”** Expect `wheel: true` and the canvas offset to change.
- **Pass:** the canvas reports `trusted 1 · synthetic 0`; no DOM event is relied on.

### 2e. Shadow DOM, iframes, select, hover

Use `e2e/fixtures/advanced.html`.

- Ask: **“Click Shadow action.”** The shadow-DOM counter becomes 1.
- Ask: **“Click Frame action in both frames.”** Both iframe counters become 1, and labels show `(iframe)`.
- Ask: **“Set Country to Canada.”** The select shows `ca`.
- Ask: **“Hover Menu, then click Menu item.”** The menu item appears after hover and its counter becomes 1.
- **Pass:** no missed controls and no cross-frame confusion.

### 3. Scroll

- Ask: **“Scroll down by about 700 pixels and tell me which marker is visible.”**
- Expect a `scroll` card with a fresh screenshot and `y=700/…`, then an answer mentioning **BETA-MARKER**.
- Ask again to reach the bottom; expect `bottom` in the card metadata and the model to say it cannot scroll further.
- **Pass:** the page actually moves; the card reports the same scroll position; the model does not repeat a no-op scroll indefinitely.
- Try a second page with a nested scroll container (e.g., a social feed). The card should name the container (`div…`) rather than `document`.

### 4. Tabs

- Open a second tab at `/second.html` and return to `/article.html`.
- Ask: **“Switch to the Second Fixture Page tab and tell me which marker is on it.”**
- Expect a `switch tab` card with a fresh screenshot and an answer mentioning **SECOND-MARKER**; the model should switch by title/URL query without listing tabs first.
- Then ask: **“List the tabs in this window.”** and expect a `tabs` card with rows (id, title, active marker).
- The active-tab line at the top changes to “Second Fixture Page”.
- **Pass:** the tab actually changes; the screenshot is from the new tab; no clicks are attempted.

### 5. Stop / pause

- Click **Pause** in the side panel.
- Ask the agent to scroll. Expect a clear “browser access is paused” error or a text-only response; the page must not move.
- Click **Pause** again to resume; scroll should work.

### 6. Auto-view off

- Settings → uncheck **Attach a fresh view to every message** → save.
- Ask: “What is on this page?”
- Expect the model to call `browser_screenshot` explicitly (or ask for a view), rather than starting with a current-view card.
- Re-enable auto-view afterwards.

### 7. Protected page

- Switch to `chrome://settings` (or any `chrome://` page).
- Ask what is on the page.
- **Pass:** a clear “Chrome blocks screenshots/scripts on this page” error; no blank screenshot; the side panel remains usable.

### 8. Missing bridge

- Close the side panel; send another prompt after reopening? (The panel is the bridge.)
- Stop the companion (`Ctrl+C`). The banner should show “Companion offline”; no crash.
- Start `npm run dev` again; click Reconnect; the token should still work (it is persisted).

### 9. Typing, keys, navigation, waiting

Use `e2e/fixtures/form.html`.

- Ask: **“Type ‘Jane Doe’ into the Full name field.”** Expect a `type` card with `replace`, the character count, `value now "Jane Doe"`, and the input event count in `#events` increasing.
- Ask: **“Append ‘ — test’ to the same field.”** The value keeps the old text and gains the suffix (`mode: append`).
- Ask: **“Type a message in the Notes box and click Submit”** (or use `submit`): the form records the values in `#result`.
- Ask: **“Press Tab, then press Enter.”** Focus moves to the next field and Enter submits.
- Ask: **“Press Ctrl+K.”** The fixture records the shortcut as a trusted keydown.
- Ask: **“Click into the editor and type ‘hello’.”** The focused editor receives trusted `Input.insertText`.
- Ask: **“Go to 127.0.0.1:17872/second.html.”** Expect a `navigate` card, the URL changes, and a fresh view of the second page; then **“Go back.”**
- Ask: **“Wait for READY on the page, then tell me what it says.”** Expect a `wait_for` card with `found` and a non-zero elapsed time.
- Ask: **“Type into the password field.”** The card must show `value now "[password N chars]"`, never the secret.
- **Pass:** no typing lands in the wrong element; navigation is http(s) only; waits report `found`/`timedOut` honestly.

### 9d. Selection, fast views, reasoning speed

Use `e2e/fixtures/form.html` and a disposable Google Doc.

- Ask: **“Select the paragraph that says SELECT-ME-ALPHA and tell me what is selected.”** Expect a `select` card with the character count and a text preview; the page selection is highlighted.
- Ask a select with identical start/end (or “click without selecting”): expect `selection collapsed (nothing selected)`.
- On Google Docs, attempt `browser_select`: expect `DOCS_CANVAS_SELECT_UNSUPPORTED` before any drag or document change. Use exact Find or guarded replacement tools instead; drag selection must never be used for Docs editing.
- On Google Docs, create `Benchmarks: yea` and a second unchanged paragraph. Ask: **“Delete only the word yea after Benchmarks:. Do not change anything else.”** Expect one `browser_docs_replace_text` call with `removed_text` and `verifiedBy:"find-counter"`, one final view, no manual Find and Replace calls, and no collateral edits. Repeat with a non-empty whole-title replacement and expect `replaced_text`. With duplicate target text, expect `DOCS_MATCH_NOT_UNIQUE` before mutation.
- Rename a disposable document and expect one `browser_docs_rename` call with `renamed` and `verifiedBy:"document-title"`; title-field focus must be verified before Enter. Simulate focus failure and confirm Enter is never sent.
- Replace `This Benchmarks…` with `Benchmarks…` when the heading already contains `Benchmarks`: expect successful replacement with `matchCount:2`, not a verification timeout. After three consecutive replacement failures, expect `DOCS_FAILURE_CIRCUIT` and no further speculative or canvas edits.
- On a line that is not already Playfair Display, ask: **“Set only this line to Playfair Display.”** Expect one `browser_docs` call with `action:"set_font"`, `applied`, and `verifiedBy:"toolbar"`, plus one final view—not a model-driven sequence of menu actions.
- Set a unique line to an initially unadded font such as Syne. Expect More fonts add → Done closed → ordinary menu reopened → apply, not success merely because the font was added. A request for exact `Syne` must never select `Syne Mono`.
- Repeat the already-correct font: expect `already_applied` and no menu mutation. Try duplicate target text and `1 of 2`: expect no formatting change. Try a nonexistent font: expect `font_missing`; with removal explicitly requested, expect only `removed_text`, not a claim that the paragraph break vanished.
- **Compound formatter:** in a fresh disposable document, create a unique `Release heading` paragraph and a sentinel paragraph with different text and formatting. Ask: **“Format only the exact text Release heading as Title, 28 pt, bold, Playfair Display. Do not change anything else.”** The first tool call must be one `browser_docs_format` with `paragraph_style:"Title"`, `font_size:28`, `bold:true`, and `font:"Playfair Display"`. Expect `completed`, four verified per-attribute results, one Find selection, and one final view, with no preliminary Find/menu calls, generic Docs batch, or replacement+format sequence. Confirm that size-field focus and value were verified before Enter. Independently inspect the containing paragraph's Title style, exact size/bold/font, and confirm that the sentinel and every other character and format are unchanged.
- **Toggle off:** on another unique range that starts bold, italic, and underlined, ask to remove only bold. Expect `browser_docs_format` with `bold:false` (a desired final state, not a blind toggle), final bold off, and italic/underline unchanged.
- **No-op:** repeat the original compound request after all four attributes are already correct. Expect `already_applied`, `appliedCount:0`, `alreadyAppliedCount:4`, no formatting mutation, and one final view.
- **Duplicate refusal:** put the exact target text in two paragraphs and request formatting without an ordinal. Expect `DOCS_MATCH_NOT_UNIQUE` before formatting; independently confirm that neither occurrence nor any neighboring content changed.
- **Missing-font partial:** on fresh unique non-bold text, request bold plus a definitely unavailable font. Expect `partial`, `appliedCount:1`, an applied bold result, and `failure.attribute:"font"` / `failure.code:"DOCS_FONT_MISSING"`. The font request must not delete text, and the model must not claim full success. Independently confirm that only bold changed and all document text is intact.
- **Compound writer:** in a fresh disposable document with a differently formatted sentinel paragraph, give one medium-effort instruction: **“Append a Title ‘Release heading’ in Playfair Display, 28 pt, bold, then an intentional blank Normal paragraph, a numbered list of 3 items (Alpha, Beta, Gamma), a bulleted list of 3 items (Red, Green, Blue), and a closing paragraph in Roboto, 11 pt. Leave everything else unchanged.”** Expect one `browser_docs_write` call with five blocks and no preliminary click/type/Find/menu calls. Expect `completed`, `verifiedCount:5/5`, `attemptedCount:5`, `verifiedBy:"export"`, and the appended outline. Independently inspect the Title/font/size/bold, exactly one blank Normal paragraph, numbering 1–3, three bullets, Roboto 11 closing text, clean list exits with no empty list item, and unchanged sentinel text and formatting. The model must not spend one thinking step per block.
- **Inline writer and time context:** in another fresh disposable document with a differently formatted sentinel, give one medium-effort instruction: **“Append one single-line paragraph that starts with today’s date, then ‘ — Welcome ’. Use Roboto 11 throughout except ‘quick’ in Merriweather and ‘Ctrl+Shift+7’ in Roboto Mono. Make ‘bold’ bold, ‘italic’ italic, ‘underlined’ underlined, and ‘blue’ #0000FF with a #FFFF00 highlight. Include those exact words after Welcome in that order. Leave everything else unchanged.”** Expect one `browser_docs_write` call using `runs`, no time-service navigation, no preliminary typing, and no post-typing Find or formatting recovery. Independently verify the current local date, exact run text/order, font/size/emphasis/color/highlight on each run, and unchanged sentinel.
- **Feature-document composition:** from a fresh empty disposable Doc at medium effort, give the original Feature Test Document instruction once: rename to `Feature Test Document`; Letter/portrait/1-inch margins; Playfair Display enlarged Title plus Subtitle with today's date; a 2–3-sentence Roboto 11 intro containing a Merriweather sentence and bold/italic/underlined/blue/yellow-highlight words plus a Roboto Mono phrase; a page break; Heading 1 Section One/Two/Three; and under Section One three numbered items, three bullets, and two checklist items with exactly one checked. Target exactly three semantic mutations—`browser_docs_rename`, `browser_docs_page_setup`, and one `browser_docs_write`—with no primitive menus/coordinates/manual checklist or page-break recovery and zero failed calls. At most one independent `browser_docs_read` is allowed. Independently inspect Page setup and exported HTML for every run/format, the page-break position, all list types, exactly one checked item, and no collateral or extra content. Repeat from the same fresh state and record wall time, steps, calls, failures, retries, and recovery edits; a recovered final document is not acceptance.
- **Writer recovery:** repeat with a definitely unavailable font. Expect a clear failure or explicit partial result, no claim of full success, no duplicate input or blind retry, and no dropped requested attributes. Recovery must inspect and fix the exact target or use one scoped Ctrl+Z for a known accidental latest mutation, followed by fresh view/export verification; no select-all/delete, content clearing, repeated Backspace, or blind undo chains. Use `browser_docs_read` with `format:"outline"` to inspect actual structure without navigating; then report the correct/partial/wrong/blocked state independently.
- **General composition:** when several calls are already known for one logical unit, expect them in one assistant response, with mutations executed exclusively in model order. Only `browser_tabs`, `browser_read_text`, and `browser_docs_read` may overlap; no concurrent document writes. Do not add a screenshot solely to recheck evidence already present in a result.
- Ask: **“Take a quick look at the page.”** Expect `browser_screenshot` with `detail:"fast"`; card metadata shows a 640 px image.
- With **Auto** effort, ask **“delete the extra paragraph”** or **“add a comment here”** — the policy line should say `reasoning low (act, auto)` and thinking should stream from the first step. Ask **“what does this page say?”** — `reasoning low (inspect, auto)`.
- **Pass:** selection and typing outcomes are honest, only the intended Docs range/paragraph changes, each semantic font/format operation returns one final view, and no dependent Docs actions are batched. Tool statuses and the agent's final answer are diagnostic only: independently inspect final text and formatting after every scenario, and record collateral or recovery edits even when repaired.

### 9e. Semantic role paths and exact Docs ranges (live acceptance pending)

Run these scenarios at **medium effort** in fresh chats, each from a newly created disposable document in the stated initial state. Reload the normal unpacked extension and reopen the panel before starting. None of the three new tools has live Google Docs acceptance yet; a green unit/fake-driver or isolated-fixture suite is not a pass here.

#### A. Ordinal selection and one harmless primitive

- Start with three separate paragraphs containing exactly `Duplicate target`, followed by a differently formatted `Sentinel: unchanged` paragraph. Give one instruction: **“Select only the second occurrence of the exact text ‘Duplicate target’ and make just that selected text bold with one keyboard formatting action. Do not change anything else.”**
- Expect `browser_docs_select_text` with `occurrence:2`, `scope:"text"`, then exactly one `browser_press_key` Ctrl+B primitive with a full fresh view. Selection must return `status:"selected"`, `matchCount:3`, `current:2`, `occurrence:2`, and `verifiedBy:"find-counter"` as a text-only result with no screenshot. No manual Find, drag selection, generic Docs batch, or formatting before the verified selection.
- Independently inspect an HTML export: only the second exact duplicate is bold; the first, third, sentinel, all text, links, and other formatting are unchanged. The selection result and final answer are not acceptance evidence.
- Repeat separately from the same fresh three-duplicate state for `occurrence:"first"` and `occurrence:"last"`, applying the same single bold primitive and independently proving that only the requested occurrence changed.
- Separately test wrapped containing-paragraph selection in a fresh document with a unique paragraph such as `Prefix anchor suffix` and sentinels. Request the exact anchor with `scope:"paragraph"`, then apply one harmless bold primitive. Expect the result to identify the full selected paragraph, `anchorText:"anchor"`, and its `paragraphIndex`; export must prove the whole intended paragraph—not merely the anchor or another paragraph—changed, with no collateral edits.
- On duplicate text, omitting `occurrence` must fail rather than silently choosing first. There is no `occurrence:"all"` or persistent multi-select mode.

#### B. One multi-range format call, then an exact second-edit failure

- Fresh setup: a Normal-text `Release heading`; three separate `Duplicate target` paragraphs; a bulleted `List sentinel`; a `Link sentinel` pointing to `https://example.com/keep`; and a differently formatted `Plain sentinel`. Give one medium-effort instruction: **“Make ‘Release heading’ Heading 1, Playfair Display, 28 pt, bold, #0000FF with a #FFFF00 highlight. Make only the second ‘Duplicate target’ Roboto, 12 pt, italic, and underlined. Leave every other character, format, list, and link unchanged.”**
- The first formatting call must be one `browser_docs_format_many` containing two ordered edits, with `occurrence:2` on the duplicate. Across the edits this exercises all eight attributes: paragraph style, font, size, bold, italic, underline, color, and highlight. Expect `completed`, `editCount:2`, `attemptedCount:2`, `verifiedCount:2`, `appliedCount:2`, `remainingCount:0`, `verifiedBy:"export"`, per-edit results, and one final view—no preliminary selection/menu calls or generic Docs mutation batch.
- Independently inspect exported HTML for every requested run and paragraph property, only the second duplicate changed, and unchanged sentinels, list type/metadata, link text, and a structured link destination that still resolves to `https://example.com/keep` (including when Docs exports a redirecting `href`). Account for legitimate paragraph-style inheritance only inside the styled paragraph; any unrequested font/size/bold change elsewhere is collateral.
- **Second-edit failure:** restore the same fresh initial state and add unique `First range`, `Second range`, and `Third range` paragraphs. Request one `browser_docs_format_many` with three ordered edits: bold `First range`; bold `Second range` and set a definitely unavailable font on that same second edit; italicize `Third range`. Expect the operation to stop at edit index 1. Exact result: overall `partial`, `editCount:3`, `attemptedCount:2`, `verifiedCount:1`, `appliedCount:1`, `remainingCount:1`; result 0 `completed` and export-verified, result 1 `partial` with bold applied and font failed, result 2 `unattempted` with its attributes unattempted; `failure.index:1`, `failure.attribute:"font"`, and `failure.code:"DOCS_FONT_MISSING"`. Do not retry the whole call or claim the third edit ran. Independently export-check the first two ranges' exact partial state, an unchanged third range, and no collateral edits.
- Separate negative checks must fail before mutation: overlapping ranges (`DOCS_FORMAT_OVERLAPPING_EDITS`), conflicting paragraph-style edits, `paragraph_style` on an `LI`, and opaque structures such as tables (`DOCS_FORMAT_UNSUPPORTED_STRUCTURE`). Generic Docs mutation batches remain blocked.

#### C. Combined exact selection, menu path, and multi-range formatting

- Fresh setup: three separate `Menu target` paragraphs, unique `Batch heading` and `Batch accent` paragraphs, and differently formatted text/list/link sentinels. In a fresh chat at medium effort, give this instruction **once, with no guidance or continuation**: **“Make only the second ‘Menu target’ strikethrough using the Format → Text menu. Then make ‘Batch heading’ Heading 2 and 18 pt, and make ‘Batch accent’ bold and #008000. Leave all other text, formatting, lists, and links unchanged.”**
- Target one `browser_docs_select_text` for ordinal 2, one `browser_click_role` for the exact role/name Format → Text → Strikethrough page-chrome menu path, then one `browser_docs_format_many` with the two supported edits, all executed exclusively in order. Menu reveal/wait/revalidation belongs inside `click_role`; do not use editor-content role clicks, guessed coordinates, manual Find, or a generic Docs mutation batch.
- `roleClick.status:"completed"` proves path dispatch, not strikethrough or the requested document outcome. `ROLE_CLICK_UNSETTLED` and `DOCS_UNSETTLED` are not safe to retry; after `DOCS_UNSETTLED`, issue no further mutation and inspect only after the tab is stable.
- Allow **at most one independent `browser_docs_read` with `format:"html"`** after the final mutation. Verify strikethrough only on the second duplicate, both multi-range edits, unchanged sentinels and structured link destinations, and no extra content or collateral formatting.
- For every scenario and repetition, record wall time, model steps, tool calls, failed calls, retries, wrong-target actions, recovery edits, and collateral edits even if repaired. Repeat from the same fresh initial state to distinguish a lucky run from reliability. A recovered final document is not acceptance; **do not mark live Docs acceptance done until these normal-unpacked-extension runs pass independently.**

### 9c. Batching and view modes

Use `e2e/fixtures/form.html`.

- Ask: **“Fill in the name and notes and submit.”** Expect a single `batch` card listing several actions, a header like `batch: N actions · S executed without tool errors · Xms`, and **one** final view; the form records the values. Any `changed:null` action is separately counted as UNVERIFIED, not called successful.
- Ask for a sequence with a deliberately wrong label (or use a batch with one bad action) and check the card shows `FAILED at [i]` and, with `stop_on_error:false`, continues after the failure.
- Do several actions in a row on the same page: after the first (full) view, later cards should say **compact** and carry no screenshot thumbnail, only a label delta like `labels +1/-1, 39 unchanged`.
- Ask **“show me the page”**: the next action should return a full view (a thumbnail) because the model asked for `view:"full"`.
- Take a view, do a compact action, then ask the agent to click an element whose label was only shown in the earlier view. It must resolve (cumulative label registry), not fail `UNKNOWN_LABEL`.
- Ask the agent to press the `/` key: it must be accepted (no `BAD_KEY`).
- **Pass:** batches run as one call, compact results never contain a stale screenshot, and label ids from earlier views still resolve.

### 9b. Canvas editor typing

- Open a Google Doc, click a caret position with `browser_click_at`, then ask the agent to type a short sentence; it must use label-less `browser_type` and `browser_press_key` for caret movement.
- Once the caret is known, ask for several lines of contiguous prose with intentional blank lines. Expect one `browser_type` call containing the prose and newlines, not one call per line, followed by visual confirmation in the full fresh view. Unverified canvas input must not be blindly retyped.
- **Pass:** text appears at the caret with the intended line breaks; the agent does not claim it cannot type.

### 10. Debug log export

- Click the **▤** button in the topbar.
- The **Debug log** dialog shows the run id, log path, event count, screenshots, turns, warnings/errors, size, model, and extension context.
- Leave **Include screenshots** and **Include raw DSH session log** checked.
- Click **Download bundle**.
- **Pass:** a `crazyagent-log-<runId>.zip` download starts; a toast names the bundle and size; no UI errors.
- Open the ZIP: `summary.md` contains the user prompt, browser actions, tool calls, assistant text, screenshots, timings, and signals; `events.jsonl` contains detailed events; `screenshots/` contains the captures; `dsh-session.jsonl` is present.
- Check that the pairing token and base64 image blobs do **not** appear in `events.jsonl`.
- Click **Copy summary** and paste into a text editor; it should be readable.
- Click **Copy logs path**; the path should exist on disk.
- Uncheck screenshots, export again, and confirm the new ZIP has no `screenshots/` entries.

### 11. Privacy controls

- Confirm the toolbar badge shows **ON** only while a browser command is running.
- Confirm `npm run dev` logs no page text or image bytes (only bridge status/errors).
- Check `.dsh-home/attachments/` contains the screenshots you expect and `.dsh-home/browser-agent/logs/<runId>/` contains `events.jsonl`, a `screenshots/` directory, and a summary.
- Inspect `events.jsonl`: it should contain extension/plugin/bridge/DSH events, but no pairing token and no inline base64 image data.


## Performance observations

Record from the side-panel footer and `docs/PHASE1-BENCH.md`:

- simple “what is this page” turn: _____ s;
- scroll-and-describe turn: _____ s;
- tabs + switch turn: _____ s;
- type-into-field turn: _____ s;
- navigate + wait turn: _____ s;
- look time: _____ ms;
- screenshot size/dimensions (from the card or `.dsh-home`): _____.

Local reference (Edge 151, DPR 2): snapshot **95 ms**, auto-view **58–73 ms**, 1280×966 JPEG ~96 KB, 6.4 s and 10.0 s turns.

## Sharing a debug bundle

When something looks interesting, attach `crazyagent-log-<runId>.zip` to the chat, or paste `summary.md` plus the relevant `events.jsonl` lines. Treat the bundle as sensitive page data; exclude screenshots when the page shows private content.

## Cleanup

```sh
npm run clean -- --yes   # removes .dsh-home and logs
npm run setup            # required before the next run
```

Remove the unpacked extension from `chrome://extensions` if you are done. The test fixture server can be stopped with Ctrl+C.