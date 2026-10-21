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
- Side panel token pasted in Settings; OpenRouter API key entered; **Refresh models** used and an image-capable model selected; Save clicked; status says **Connected**.
- Every view shows yellow numbered badges on visible controls.
- A normal tab is active. `chrome://` and extension pages are expected to fail.

## Checks

### 1. Open the side panel and configure the model

- Click the toolbar icon.
- If prompted, open Settings: paste the pairing token; paste the OpenRouter API key; keep the base URL `https://openrouter.ai/api/v1`; click **Refresh models**; pick an image-capable model (e.g. `deepseek/deepseek-v4.1-flash-1017`); leave **Remember** checked; Save.
- The side panel shows the brand, active tab title, and a green status dot.
- The active tab line updates when you switch tabs manually.
- **Pass:** no error banner; Settings shows the key as configured and the model status names the selected model and **effort low** when the model supports reasoning; the model list shows hundreds of image-capable models.

### 1c. Reasoning policy

- With **Auto** effort, ask **“scroll down”**: the activity feed should show `policy: reasoning off (navigate, auto)`.
- Ask **“what is on this page?”**: the next `policy` line should show `reasoning low (inspect, auto)`.
- Switch to **Off** in Settings and save; every later turn should show `reasoning off`.
- **Pass:** one `policy` line per turn, matching the table in the README.

### 1b. Live activity

- Ask a question on a normal page and keep the side panel visible.
- Expect the **Live activity** feed to update while the turn runs: a **thinking** entry with reasoning/thinking deltas (when the provider exposes them), **assistant** text, `tool` partial/committed calls, browser actions, token usage, finish reason, and a final `done` entry.
- Click the activity chevron to collapse/expand; the header keeps the current phase and latest line.
- **Pass:** activity appears before the turn completes, not only after the final answer; the reasoning text is visible for reasoning-capable models; no UI errors.

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

Use `e2e/fixtures/form.html` and a Google Doc.

- Ask: **“Select the paragraph that says SELECT-ME-ALPHA and tell me what is selected.”** Expect a `select` card with the character count and a text preview; the page selection is highlighted.
- Ask a select with identical start/end (or “click without selecting”): expect `selection collapsed (nothing selected)`.
- On Google Docs: **“Comment on the second sentence.”** The agent should select the sentence with `browser_select`, press Ctrl+Alt+M, type the comment into the focused box (label-less `browser_type`, possibly `trusted-focus`), and submit — not fight the menu with dozens of Escapes.
- Ask: **“Select this paragraph and make it bold.”** Expect select + Ctrl+B.
- Ask: **“Take a quick look at the page.”** Expect `browser_screenshot` with `detail:"fast"`; card metadata shows a 640 px image.
- Reasoning speed: with **Auto** effort, ask **“delete the extra paragraph”** or **“add a comment here”** — the policy line should say `reasoning off (act, auto)`. Ask **“what does this page say?”** — `reasoning low (inspect, auto)`.
- **Pass:** selection text is reported honestly, the Docs comment flow completes in a handful of actions, and action prompts run with reasoning off.

### 9c. Batching and view modes

Use `e2e/fixtures/form.html`.

- Ask: **“Fill in the name and notes and submit.”** Expect a single `batch` card listing several actions, a header like `batch: N actions · S succeeded · Xms`, and **one** final view; the form records the values.
- Ask for a sequence with a deliberately wrong label (or use a batch with one bad action) and check the card shows `FAILED at [i]` and, with `stop_on_error:false`, continues after the failure.
- Do several actions in a row on the same page: after the first (full) view, later cards should say **compact** and carry no screenshot thumbnail, only a label delta like `labels +1/-1, 39 unchanged`.
- Ask **“show me the page”**: the next action should return a full view (a thumbnail) because the model asked for `view:"full"`.
- Take a view, do a compact action, then ask the agent to click an element whose label was only shown in the earlier view. It must resolve (cumulative label registry), not fail `UNKNOWN_LABEL`.
- Ask the agent to press the `/` key: it must be accepted (no `BAD_KEY`).
- **Pass:** batches run as one call, compact results never contain a stale screenshot, and label ids from earlier views still resolve.

### 9b. Canvas editor typing

- Open a Google Doc, click a caret position with `browser_click_at`, then ask the agent to type a short sentence; it must use label-less `browser_type` and `browser_press_key` for caret movement.
- **Pass:** text appears at the caret; the agent does not claim it cannot type.

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