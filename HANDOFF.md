# CrazyAgent — continuation handoff

Last updated: 2026-10-22. Repo is working, companion running, 15 tools, 88 tests.

This file is the complete context transfer for a new conversation. Read it, then
`README.md`, then the latest debug run if you need ground truth.

---

## 0. Paste this into the new conversation

```text
We are continuing CrazyAgent at /home/conan/Documents/GitHub/crazyAgent.
Read HANDOFF.md (especially §15, the high-level log of the conversation that
produced the current state) and README.md, then run:
  curl -s http://127.0.0.1:17871/health
  npm test
Do not re-derive the architecture invariants in HANDOFF.md §4.
The companion is running (logs/companion.pid); restart it after companion or
provider changes. The extension is loaded unpacked from extension/ and MUST be
reloaded after extension changes. Current build: commit 145ca2b, 15 browser
tools, 88 tests. The model is OpenRouter deepseek/deepseek-v4.1-flash-1017 with
reasoning effort "auto" (per-turn policy); the API key is stored in
.dsh-home/browser-agent/api-key.
Next task: <fill in>. If none is given, validate the current build in a real
session first (reload the extension, run a Docs/email work turn), then take the
top item from §8.
```

---

## 1. What this project is

A Chrome/Edge **side-panel browser agent** built on **DSH (DeepSeek Harness)
0.2.1-rc.2**, not on a custom harness. DSH owns the agent loop, sessions, tool
pipeline, prompt assembly, attachments, compaction, and model routing. The only
modifications are:

- a DSH provider plugin (`packages/dsh-browser-extension`),
- a profile overlay (`config/browser.patch.yml`) plus a generated model overlay
  (`.dsh-home/browser-agent/llm.patch.yml`),
- a local **companion** process (Node) that bridges the DSH SDK to the Chrome
  extension over a loopback WebSocket,
- a Chrome MV3 side panel that executes browser actions.

```text
┌──────────────────────────── Chrome/Edge window ────────────────────────────┐
│  Side panel (extension/sidepanel)                                          │
│    - chat UI, live activity, settings, debug-log export                    │
│    - executes browser ops with chrome.tabs / chrome.scripting /            │
│      chrome.debugger / chrome.webNavigation                                │
│    - WS role "ui"                                                          │
└───────────────▲───────────────────────────────────────────┬────────────────┘
                │ ws://127.0.0.1:17871/bridge (token auth)   │
┌───────────────┴───────────────────────────────────────────▼────────────────┐
│  Companion (companion/*.mjs)                                               │
│    - token, protocol, log store, OpenRouter model config                   │
│    - spawns DSH via @deepseek-ai/dsh-sdk-client                            │
└───────────────▲───────────────────────────────────────────┬────────────────┘
                │ DSH SDK stdio                              │
┌───────────────┴───────────────────────────────────────────▼────────────────┐
│  DSH runtime (sdk-minimal + patches)                                       │
│    - agent loop, sessions, compaction, image offload                       │
│    - provider plugin: 9 browser tools, guidance, reasoning policy          │
│    - WS role "tools"  ◄──── tool calls become browser commands ────────────┤
└────────────────────────────────────────────────────────────────────────────┘
```

The side panel is the browser executor. The provider plugin connects to the
same bridge as the `tools` role and sends `browser.command` frames; the panel
answers with `browser.result`.

---

## 2. Current state (at handoff)

| Item | Value |
|---|---|
| Repo | `/home/conan/Documents/GitHub/crazyAgent` |
| Node | 26.8.1 (needs 22.19+) |
| DSH | `0.2.1-rc.2` (`@deepseek-ai/dsh`) |
| Companion | running, PID in `logs/companion.pid` (2171634 after the A+B+C+D restart) |
| Bridge | `ws://127.0.0.1:17871/bridge` |
| Health | `{"ok":true,"ui":false,"tools":true,"port":17871}` |
| Token | read `.dsh-home/browser-agent/token` (do not commit it) |
| Model | OpenRouter `deepseek/deepseek-v4.1-flash-1017` |
| Base URL | `https://openrouter.ai/api/v1` |
| Reasoning | `auto` (per-turn policy) |
| API key | stored, 73 bytes, `.dsh-home/browser-agent/api-key` (0600) |
| Extension | unpacked from `extension/`; ID `kmipadgipilkdidennbhcgmoolfedgph` (path hash) |
| Permissions | sidePanel, tabs, scripting, storage, **debugger**, **webNavigation**, host `<all_urls>` |
| Latest run log | `.dsh-home/browser-agent/logs/run-2026-10-21T23-36-12-600Z-8f5493` (post-restart); the post-batch work run is `run-2026-10-21T21-30-54-909Z-ac82d4` |
| Tests | 88/88 passing |
| Git | `main` has baseline, burst-click, work-foundation, B+C+E and A+B+C+D commits; tree clean |

Historical validation (first real run, before the optimization rounds):

- A canvas whack-a-dot game (`mouseaccuracy.com/game`): 5 turns, 88 tool calls,
  **46 `browser_click_at` calls, zero errors, every one reported a pixel change**
  (e.g. `trusted input · pixels-changed 3.1% · click 439ms`).
- A Google Docs document: `browser_click_at` into the canvas, then label-based
  `browser_click` / `browser_hover` through the menus.
- Turn times 41–53 s for 11–24 tool calls; model-latency bound.
- One `PROTECTED_PAGE` error when the active tab was a browser-internal page.

2026-10-21 latency work (full attribution in
`.dsh-home/browser-agent/analysis/canvas-latency.md`, gitignored): per-click wall
was **80% model round trip, 13.6% browser, 5% image commit**; the fixed 160 ms
settle was 41% of the browser action. Added burst `points` (1-8, one attach and
one capture per burst), `view:"none"` text-only fast mode, an adaptive paint
settle, `delay_ms` screenshot waits, a `rapid` reasoning class (`off`), and
corrected the stale "you cannot click" prompt text that made the first turn
deliberate.

2026-10-21 work foundation (the end goal is doing real work, not playing games):
four new tools — `browser_type` (labelled inputs/textarea/contenteditable, trusted
label-less typing into a focused canvas editor, replace/append, optional Submit,
password masking), `browser_press_key` (trusted CDP key events with
ctrl/alt/shift/meta), `browser_navigate` (http(s) url, new tab, back/forward/
reload, 15 s load budget), `browser_wait_for` (text/url/idle/ms conditions with
timeout). Roster became **thirteen** tools at that point; persona and GUIDANCE
were updated in the same change so the model never again deliberates about a
capability it has.

2026-10-21 B+C+E (root-cause fix after 19 work turns / 220 steps): the loop was
fully serialized (**0 steps in the whole run had more than one tool call**) and
every action returned a full view, so prompts averaged **134 K tokens/step**
(245 K max) with TTFT 2-4 s/step and 204 screenshots re-sent per run. Fixes:
`browser_batch` (1-20 ordered actions per call, one final view, per-action
outcomes, per-call bridge timeout), **view modes** (`auto`/`full`/`compact`/`none`
with label deltas, compact DOM actions 18-35 ms instead of 360-1266 ms), cumulative
per-tab label registry, printable-ASCII keys, and capture readback retries.
Roster became **fourteen** tools at that point.

2026-10-21 A+B+C+D (root-cause fix after the next 5 work turns): reasoning
tokens, not browser actions, dominated action turns. Turns at effort `off` ran
0.87-1.94 s/step with 54-75 output tokens; comparable work at `low` ran
3.16-6.96 s/step with 211-420 output tokens, of which 63-93% were hidden
reasoning. The Docs comment turn also used 123 actions over 106 steps with 15
Escapes and 3 disabled Comment menu items because there was no selection
primitive. Fixes: `act` reasoning class (short imperative work prompts ->
`off`), `browser_select` (trusted drag + selected-text readback,
batch-compatible), `detail:"fast"` 640 px screenshots, `NOT_EDITABLE`
focus-fallback typing, named punctuation keys, and a `compaction-basic` overlay
(thresholdRatio 0.06 / retainRatio 0.02, ~63 K-token trigger) for cross-turn
context. Roster is now **fifteen** tools.

Latest measured work session (pre-A+B+C+D, `run-2026-10-21T21-30-54-909Z-ac82d4`,
5 turns, 764 s): email reply 25.6 s; add-comments 255 s / 123 actions / 106 steps;
delete-all 217 s; "add comments, be faster" 92 s with 38 actions batched in 5
calls but 6.96 s/step from reasoning; fix-comments 174 s with 72 actions batched
in 11 calls. Prompts grew 45 K -> 140 K tokens/step; 14.6 M prompt tokens total.
That run is the baseline the A+B+C+D change targets.

---

## 3. Run, restart, test

```sh
cd /home/conan/Documents/GitHub/crazyAgent

# Health
curl -s http://127.0.0.1:17871/health

# Restart the companion (picks up companion/ and provider changes)
kill $(cat logs/companion.pid)
nohup node companion/index.mjs > logs/companion.log 2>&1 &
echo $! > logs/companion.pid

# Or foreground (prints token + config)
npm run dev

# Full test suite (57 tests)
npm test

# Setup/verify profile + plugin links (idempotent)
npm run setup

# Remove generated state (DESTRUCTIVE: token, key, sessions, logs)
npm run clean -- --yes
```

Extension:

1. `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
2. **Reload the extension after every extension change.** New permissions
   (`debugger`, `webNavigation`) require a reload; accept the warning.
3. Open the side panel, paste the token from
   `.dsh-home/browser-agent/token` into Settings (bridge URL default).

Fixtures / manual testing:

```sh
python3 -m http.server 17872 --bind 127.0.0.1 --directory e2e/fixtures
# click.html, canvas.html, advanced.html, article.html, second.html, many.html
```

Edge end-to-end suites (real extension over CDP):

```sh
# click suite
setsid microsoft-edge --user-data-dir=/tmp/ca-click --load-extension=$PWD/extension \
  --remote-debugging-port=9228 --no-first-run --no-default-browser-check \
  http://127.0.0.1:17872/click.html &
node scripts/edge-click-e2e.mjs

# canvas suite
setsid microsoft-edge --user-data-dir=/tmp/ca-canvas --load-extension=$PWD/extension \
  --remote-debugging-port=9230 --no-first-run --no-default-browser-check \
  http://127.0.0.1:17872/canvas.html &
node scripts/edge-canvas-e2e.mjs

# shadow DOM / iframes / select / hover suite
setsid microsoft-edge --user-data-dir=/tmp/ca-advanced --load-extension=$PWD/extension \
  --remote-debugging-port=9231 --no-first-run --no-default-browser-check \
  http://127.0.0.1:17872/advanced.html &
node scripts/edge-advanced-e2e.mjs
```

The scripts default to those ports; override with `CDP_URL=...`.

Legacy scripts from the vision-only phase (`edge-e2e.mjs`, `edge-tabs-e2e.mjs`,
`edge-probe.mjs`, `edge-log-e2e.mjs`, `fake-ui.mjs`, `log-probe.mjs`) still exist
but assume the older four-tool behavior. Treat them as historical unless you
update them.

---

## 4. Architecture invariants — do not break these

1. **Do not fork DSH core.** Modify only the provider plugin, profile overlay,
   generated model overlay, companion, and extension. DSH is pinned to
   `0.2.1-rc.2`.
2. **The model never gets arbitrary DOM automation.** It has a fixed roster of
   **fifteen** browser tools; every action is a labelled element, an explicit
   coordinate, explicit text/keys, an explicit drag range, or an explicit
   http(s) URL. No JS evaluation, selector guessing, or unlabelled DOM
   manipulation.
3. **All browser execution lives in the side panel page.** No content script is
   installed; page code runs only for the duration of one `chrome.scripting`
   call in the `ISOLATED` world.
4. **Injected page functions must be self-contained.** `chrome.scripting`
   serializes the function source only. Module constants and outer helper
   functions are not available in the page. This already caused two bugs
   (`LABEL_SELECTOR` and `labelPageInner` were not defined in the page).
5. **DOM clicks are label-only.** Never let the model pass guessed coordinates
   for DOM controls. Persistent label ids (`WeakMap` element → id, `Map` id →
   element) mean a stale id either resolves to the same element or fails. It
   never silently lands on a different element.
6. **Coordinates are only for surfaces.** `browser_click_at` is for
   canvas/video/iframe regions and unlabelled targets. It uses trusted CDP input
   and verifies with a pixel diff.
7. **Trusted input is `chrome.debugger`.** Attach per action
   (`Input.dispatchMouseEvent`), detach immediately. If attach fails (DevTools
   open), DOM clicks still work; `click_at` falls back to synthetic or reports
   the conflict. Do not assume `isTrusted` from `dispatchEvent`.
8. **DSH freezes requests.** `GenerateOptions` and every message are deep-frozen,
   so you cannot rewrite history at `llm/stream`. Old images are dropped through
   the durable **`image/offload`** projection instead (registered by the
   `image-offload` row that sdk-minimal already includes).
9. **Reasoning effort is per turn.** The plugin classifies the claimed user
   prompt once and holds the effort for the turn via the `agent/request`
   waterfall. `off` must map to the wire value `"none"`; `off: null` means
   “omit the field”, which leaves provider reasoning on.
10. **The API key never touches `chrome.storage`.** It goes over loopback as a
    `llm.configure` frame, is passed to DSH as `CRAZYAGENT_API_KEY`, and is
    redacted from logs. The generated patch and `llm.json` contain no secret.
11. **Speed rule:** never pay a model round trip per action, and never pay
    reasoning tokens for acting. `browser_batch` runs an ordered sequence in one
    call with one final view. DOM actions default to a compact confirmation (no
    screenshot, label delta only) and auto-escalate to a full labelled view when
    the page changes, when there is no previous view, after 5 compact actions,
    or on `view:"full"`. Reasoning effort is per turn: navigation, rapid bursts
    and short imperative work prompts run `off`; only reading/describing/
    synthesizing keeps `low`. Context is compacted near 6% of the window (~63 K
    tokens) so long sessions do not grow to 140 K+ prompts; images are offloaded
    at turn boundaries, never mid-turn (that invalidates the prompt cache).
12. **Log redaction:** pairing token, API keys, `Bearer`, secret-named fields,
    sensitive query params, inline base64. Page text, screenshots, and reasoning
    are **not** redacted. Review bundles before sharing.

---

## 5. Capabilities (fifteen model-visible tools)

| Tool | What it does | Notes |
|---|---|---|
| `browser_screenshot` | View with tab/viewport/scroll metadata, numbered labels, surface list | `detail:"high"` uses 2048 px width; `delay_ms` 0-5000 waits in the page before capturing |
| `browser_click` | Click a labelled element | DOM, open shadow roots, iframes. Returns `changed` + signals + fresh view |
| `browser_click_at` | Click screenshot pixels or CSS coordinates; `points` bursts up to 8 | Canvas/video/iframe. One debugger attach + one capture per burst, per-point pixel diff. `view:"none"` = text-only fast mode; `settle_ms` 0-400 |
| `browser_batch` | Run an ordered sequence of 1-20 actions in one call | Allowed ops: click, click_at, hover, select_option, type, press_key, scroll, wait_for, navigate. One final view; compact per-action outcomes; `stop_on_error` default true; `view` default full; per-call timeout scales with action count |
| `browser_type` | Type into a labelled editable field, or the focused element when unlabelled | DOM native setter + input/change for inputs/textarea, `execCommand` for contenteditable, trusted `Input.insertText` fallback and for canvas editors (Docs). `mode` replace/append; `submit` presses Enter; password values masked |
| `browser_press_key` | One trusted key press with optional modifiers | Enter/Tab/Escape/Backspace/Delete/arrows/Home/End/PageUp/PageDown/Space/letters/digits; CDP `Input.dispatchKeyEvent` keyDown+keyUp, synthetic fallback |
| `browser_hover` | Hover a labelled element | Reveals hover-only menus/tooltips |
| `browser_select_option` | Choose a native `<select>` option | Sets value, fires `input`/`change` |
| `browser_read_text` | Rendered text | `page`/`viewport`, `offset`, `max_chars`; ~4 ms on fixtures |
| `browser_scroll` | Scroll + fresh view | DOM scroll first, trusted wheel fallback (`wheel:true`), optional `at_x`/`at_y` |
| `browser_select` | Drag-select a text range between two points | Trusted CDP drag (mouseMoved → mousePressed → interpolated moves → mouseReleased); returns `selected:{chars,textPreview,collapsed,from,to}`; `space` image/css; `view` auto/full/compact/none; usable inside `browser_batch` (the Docs recipe: select → Ctrl+Alt+M → label-less type → submit) |
| `browser_navigate` | Open an http(s) URL or move through history | Active or new tab, `back`/`forward`/`reload`, waits up to 15 s for load, reports `timedOut` |
| `browser_wait_for` | Wait for page conditions, then return a fresh view | `text` substring, `url` substring, DOM `idle`, fixed `ms`; all supplied conditions must hold; `timeout_ms` default 10 s |
| `browser_tabs` | List current-window tabs | id, title, URL, flags |
| `browser_switch_tab` | Activate by `tab_id` or `query` | Query is case-insensitive title/URL substring |

Behavioural layers:

- **Labels:** yellow numbered badges + outlines drawn into the screenshot, plus a
  text list (60 entries max, count of the rest), capped 120 labels in the top frame and 40 per child frame. Covered,
  hidden, disabled, `aria-hidden`, `inert`, and `pointer-events:none` targets are
  excluded or refused. Persistent ids across views.
- **Frames:** every accessible frame labelled; child labels get
  `frameId * 100000 + localId` and clicks dispatch into the owning frame
  (`runInFrame`). Same- and cross-origin frames verified.
- **Surfaces:** visible `canvas`, `video`, `iframe` rects are listed in every
  view as `surfaces (no DOM labels; use browser_click_at): ...`.
- **Pixel diff:** 240×240 CSS region sampled at 64×64; `pixelsChanged` percent;
  threshold 0.4 %. This is the canvas success signal.
- **Typing:** label path tries the DOM (`value` native setter + `input`/`change`
  for inputs and textarea, `document.execCommand('insertText')` for
  contenteditable) and verifies by read-back; on mismatch it focuses the element
  and falls back to trusted `Input.insertText`. Label-less typing is always
  trusted into the focused element (canvas editors).
- **Keys:** named keys and single characters map to CDP keyCode/code/modifiers
  (alt=1, ctrl=2, meta=4, shift=8); `KeyA`/`Digit1` physical names are accepted.
- **Navigation:** http(s) only; `chrome.tabs.create/update` plus `goBack`,
  `goForward`, `reload`, with a navigation-start pre-wait so the load wait cannot
  resolve against the old document.
- **Waiting:** page-side poll + MutationObserver inside the tab; conditions are
  combined (text AND url AND idle), `ms` delays first and counts toward the
  timeout.
- **View modes:** DOM actions (`click`, `hover`, `select_option`, `type`,
  `press_key`) default to `auto`: a compact confirmation with no capture, no
  image, no label list, plus `labelsDelta` (added/removed/unchanged counts and
  up to 20 new labels). Auto escalates to a full labelled view when there is no
  stored view, on URL/title change, after 5 compact actions, or on demand.
  `view:"none"` drops even the delta. `click_at` defaults to `full` so canvas
  re-aiming stays stable. A compact action that scrolls >40 px invalidates the
  stored image, so image-space `click_at` fails `NO_VIEW` instead of using a
  stale screenshot.
- **Batch:** inner actions run with `batchDepth > 0`, so they skip their own
  view/label work; the batch builds exactly one view at the end and records
  per-action outcomes (`{index, op, ok, changed/signals, clicked/typed/pressed/
  points/waited/navigated}` or `error{code,message}`). A reveal boundary (menu,
  dialog, new page) cannot be crossed inside one batch: the next action cannot
  know a label that only appears after the previous action.
- **Label registry:** labels are merged cumulatively per tab keyed by URL, so an
  id from an earlier view still resolves to the same element (or fails
  `DETACHED`); a URL change clears the tab's registry. LRU keeps 20 tabs.
- **Selection:** `browser_select` drives one trusted drag (mouseMoved →
  mousePressed with buttons:1 → 4 interpolated moves → mouseReleased) and reads
  `window.getSelection()` in the top frame (4 000-char cap, collapsed flag, range
  rect). Untrusted synthetic mousemove cannot extend a native selection, so the
  synthetic fallback may honestly report `collapsed`.
- **Reasoning classes:** `navigate`, `rapid` (games) and `act` (short imperative
  work prompts: add/delete/fill/click/reply/fix/select/...) map to `off`;
  `inspect` and `synthesize` map to `low`. `act` is skipped when the prompt also
  asks to report/summarize, so those stay `low`.
- **Fast screenshots:** `detail:"fast"` captures at 640 px / JPEG 50 with labels
  drawn (~195 image tokens) for quick visual checks; `normal` 1280 and `high`
  2048 are unchanged.
- **Context compaction:** the profile patches `compaction-basic` to
  `thresholdRatio: 0.06`, `retainRatio: 0.02` (~63 K trigger, ~21 K retained) so
  long sessions stop growing. Never prune history mid-turn: it would invalidate
  the prompt cache on every subsequent request.
- **Change signals for DOM clicks:** `url-change`, `title-change`,
  `scroll-change`, `text-change`, `dialog-change`, `dom-mutations:N`, `checked`,
  `aria-expanded`, `aria-selected`. A no-op returns **NO VISIBLE CHANGE**.
- **Reasoning auto policy:** navigation → `off`; rapid game/reactive bursts →
  `off`; inspect/synthesis → `low`.
  Manual Off/Low/Medium/High in Settings. Logged as `reasoning.policy`.
- **Image budget:** after each `turn/end`, newest 2 images stay in the request;
  older ones become placeholders via `image/offload` (attachments remain on
  disk). Logged as `image.budget`.
- **Live activity:** provider taps `agent/assistant-stream` and streams
  reasoning/text/tool deltas to the panel (`chat.activity`), displayed with
  phase, latest line, and collapsible log.
- **Model configuration:** OpenRouter catalog fetched from the public API,
  filtered to image + tool models; base URL prefilled; key entered in the panel;
  generated `llm.json` + `llm.patch.yml`; DSH restarts and resumes the session on
  model/key changes.
- **Debug logs:** per-run `events.jsonl`, screenshots, `summary.md/json`,
  environment, manifest, optional DSH session, ZIP export from the panel.

---

## 6. File map

### Companion (`companion/`)

| File | Responsibility |
|---|---|
| `index.mjs` | CLI, token, LogStore, model config, chat turns, auto-capture, turn forwarding, `log.*`/`llm.*` controls, startup/shutdown. Key functions: `handleChat` (~459), `configureLlm` (~376), `handleControl` (~713), `effortPolicy` (~251), `makeRunner` (~305) |
| `dsh.mjs` | `DshRunner` (~24): resolves the DSH bin, builds env (bridge URL/token, `CRAZYAGENT_API_KEY`, `CRAZYAGENT_REASONING_POLICY`, credentials path), starts `DeepSeekHarness`, session/run/newSession/resume/close |
| `bridge.mjs` | Loopback WS bridge, roles `ui`/`tools`, token auth, command routing, activity forwarding, turn-id enrichment |
| `prompt.mjs` | `formatViewText` (labels, surfaces), `buildPromptBlocks`, `promptStats` |
| `log-store.mjs` | JSONL events, screenshots, redaction, signals, turns, summaries, ZIP export |
| `credentials.mjs` | API-key resolution precedence: `CRAZYAGENT_API_KEY` → stored file → `OPENROUTER_API_KEY` → DSH credential store |
| `openrouter.mjs` | Catalog fetch/filter, model mapping, `buildLlmConfig`, `buildLlmPatch`, reasoning policy normalization |
| `protocol.mjs` | Protocol version, path, port, payload limit, helpers |

### DSH provider (`packages/dsh-browser-extension/`)

| File | Responsibility |
|---|---|
| `lib/index.js` (~1826 lines) | Plugin: bridge client (`tools` role, now with a per-request timeout for batches), `registerTools` (~1101), guidance, `apply` (~1647), activity frames (`activityFromFrame` ~343), `formatView` (~443), shared view helpers (`actionContent` ~589, `selectContent` ~609, `typeMethod` ~735), coordinate/type/press/navigate/wait content formatters (`clickAtContent` ~647 and siblings), `batchContent` (~1021), select/type/press/navigate/wait/select_option content, reasoning policy + image budget hooks, `llm/stream` is intentionally **not** used |
| `lib/reasoning.js` | `classifyPrompt`, `autoEffort`, `effortFor` (navigate/inspect/synthesize/**rapid**) |
| `lib/image-budget.js` | `planImageOffload` pure planner |
| `test/*.test.mjs` | 15 tools, view modes/label deltas, batch, select, label prompts, activity forwarding, reasoning, image budget |

### Extension (`extension/`)

| File | Responsibility |
|---|---|
| `manifest.json` | MV3, side panel, permissions above, `<all_urls>` |
| `sidepanel/browser.js` (~3609 lines) | Browser executor. Key functions: `waitForPaint` (~192), `settleAfterInput` (~213), `withDebugger` (~231), `syntheticClickBurst` (~275), `diffRegion` (~336), `runInFrame` (~366), `labelAllFrames` (~406), `labelRegistryFor` (~517), `labelPage` (~560), `readSelection` (~1327), `snapshot` (~1692, incl. `detail:"fast"` 640 px), `autoEscalate` (~1778), `labelOnly` (~1790), `compactPayload` (~1804), `buildActionView` (~1863), `buildBatchView` (~1921), `clickAt` (~2478), `typeText` (~2871, incl. `trusted-focus` fallback), `pressKey` (~3033), `navigate` (~3127), `waitFor` (~3230), `trustedDrag` (~3286), `selectRange` (~3315), `batch` (~3438), `execute` (~3536) |
| `sidepanel/app.js` | Chat UI, settings (key/base URL/model/effort), bridge lifecycle, live activity feed, tool cards, debug-log modal |
| `sidepanel/index.html`, `style.css` | UI markup/styles |
| `sidepanel/logger.js`, `protocol.js` | Client log batching, formatting helpers |
| `background.js` | Opens the side panel on action click |

### Config (`config/browser.patch.yml`)

- Inserts `credentials-local`, a **dormant** `llm-pi-ai` (providers `{}`; the
  generated overlay fills the OpenRouter route), `browser-use`, and
  `browser-extension` (bridge URL/token from env, 10 s timeout).
- Overrides `agent-loop` (`maxParallelToolCalls: 1`) and `system-prompt`
  (no harness identity/runtime context, browser persona).
- Disables filesystem, working-directory, shell, and DeepSeek adapters.

### Generated state (`.dsh-home/browser-agent/`, gitignored)

```
token           pairing token (0600)
api-key         OpenRouter key when “Remember” is checked (0600)
llm.json        selected model + base URL + reasoning policy (no secret)
llm.patch.yml   generated DSH model route (no secret)
logs/<runId>/   events.jsonl, screenshots/, exports/, summary files
```

### Docs / fixtures

- `README.md` — setup, capabilities, clicking, canvas, reasoning, privacy,
  troubleshooting, performance.
- `PRIVACY.md` — what leaves the machine, key handling, debug logs, trusted input.
- `docs/DEBUG-LOGS.md` — event schema, signals, export.
- `docs/PHASE1-BENCH.md` — measured latencies.
- `e2e/checklist.md` — manual acceptance checks (click, canvas, shadow, iframes,
  select, hover, reasoning policy).
- `e2e/fixtures/` — `click.html`, `canvas.html`, `advanced.html`, `form.html`
  (typing/keys/navigation/waiting), `frame-inner.html`, `article.html`,
  `second.html`, `many.html`.

---

## 7. Test inventory

`npm test` = 88 tests:

- `companion/test/`: bridge (7), prompt (9), log store (2), credentials (2),
  openrouter (5).
- `extension/test/`: helpers (3), logger (4), tab match (5).
- `packages/dsh-browser-extension/test/`: tools (38), reasoning (9),
  image budget (4).

E2E suites (not in `npm test`): `edge-click-e2e.mjs` (9 behaviours),
`edge-canvas-e2e.mjs` (surfaces, trusted click, image mapping, pixel diff,
wheel, no-op, 5-point burst, view:none, delay_ms, single-point compatibility),
`edge-work-e2e.mjs` (typing, keys, navigation, waiting on `form.html`),
`edge-advanced-e2e.mjs` (shadow DOM, same/cross-origin iframes, select, hover).

---

## 8. Known gaps / next steps, in suggested order

1. **Typing, navigation and selection — DONE** (2026-10-21). `browser_type`,
   `browser_press_key`, `browser_navigate`, `browser_wait_for` and
   `browser_select` are in the fifteen-tool roster. Remaining input gaps: IME
   composition strings, file inputs, and drag/drop (mouse-button drag of
   elements, as opposed to text selection).
2. **Fast/batch canvas clicking — DONE.** `browser_click_at` accepts `points`
   (1-8) and clicks a whole burst with one debugger attach and one capture;
   `view:"none"` skips the screenshot for text-only fast bursts; the fixed
   160 ms settle became an adaptive paint wait. Verified by the extended canvas
   e2e (5 points, +5 trusted clicks, one view).
3. **Drag/drop, sliders, map panning** — trusted `Input.dispatchMouseEvent`
   with `mousePressed` → `mouseMoved` (buttons=1) → `mouseReleased`. Also
   right-click/context menu.
4. **File upload** — `DOM.setFileInputFiles` via debugger, or a picker-free
   assignment for `<input type=file>`.
5. **Native dialogs** — `alert`/`confirm`/`prompt`/print block the tab; handle
   with `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog` while
   attached.
6. **Downloads / new-window popups** — synthetic clicks cannot open them; with
   CDP, `Page.windowOpen` / `Target.createTarget` handling is possible.
7. **Mid-turn image pruning** — image budget currently runs only at
   `turn/end`; a 24-tool turn accumulates screenshots and token growth (one run
   hit ~844 K total tokens). Prune after each `tool/result` (with care around
   request building) and/or add a step cap.
8. **Step/tool-call cap** — no hard cap exists. A scripted mock once ran ~150
   scroll steps. Real models rarely do this, but a per-turn guard is prudent;
   DSH exposes no cancel through the SDK, so this needs an agent-level guard.
9. **Click outcome logging** — the four new ops are structured in
   `browser.command.result` (`typed`, `pressed`, `navigated`, `waited`), but
   `changed`/`pixelsChanged`/`clicked`/`points` are still only in `tool.result`
   text. Add them to the extension's logger call.
10. **Closed shadow roots / sandboxed frames / built-in PDF viewer** — not
    injectable. PDF.js pages (canvas) do work via `click_at`.
11. **Reliability polish** — debugger banner flashes per trusted action;
    DevTools open blocks trusted input. Consider a persistent attach during a
    turn (banner stays) or a settings toggle.
12. **Commit the repo — DONE.** Baseline, burst-click, and work-foundation
    changes are committed on `main`; keep future work as small reviewed commits.
13. **Form-fill batching — DONE.** `browser_batch` covers multi-field forms,
    table cells (type + Tab), shortcut sequences and multi-click sequences with
    one final view.

---

## 9. Gotchas and lessons already learned

- **`chrome.scripting` serializes functions.** Module constants/helpers are not
  available in the page. Inline everything (`LABEL_SELECTOR`, role/text
  helpers). Two bugs came from this.
- **`WeakMap` keys must be objects.** A numeric key silently threw and Chrome
  returned `null` from the injected script. The label function now self-wraps
  and returns `{__labelError, __stack}` so failures surface.
- **Hidden extension pages throttle timers to ~1 s.** The side panel opened as a
  background tab made `await sleep(60)` take 794 ms. Use `chrome.tabs`
  events (`onActivated`, `onUpdated`), page-side timers in the active tab, or a
  timeout race instead of fixed sleeps.
- **`requestAnimationFrame` may never fire in a hidden page.** Always race it
  with a `setTimeout` fallback.
- **`captureVisibleTab` quota is 2/second.** The pre-emptive 550 ms gate was
  removed; the capture retries (650 ms, 900 ms) only when Chrome refuses.
- **DSH freezes requests.** `llm/stream` cannot rewrite messages; use the
  durable `image/offload` projection. Requests changing reasoning effort
  mid-turn also churn the request header, so effort is per turn.
- **`reasoningEfforts.off` must be `'none'`, not `null`.** Null omits the field
  and leaves provider reasoning enabled.
- **OpenRouter model metadata matters.** The catalog filter requires image input
  and tool support; reasoning support controls whether efforts are declared.
- **Extension reload is mandatory** after extension changes, and the panel must
  be reopened.
- **DevTools blocks `chrome.debugger`.** Close DevTools on the tab under test
  for trusted clicks/wheels.
- **The debugger permission shows a banner.** Attach → dispatch → detach is
  ~100 ms; that is expected.
- **Do not run e2e tests against the user's real profile/settings.** A mock-key
  test once overwrote the stored OpenRouter key because the real Settings dialog
  had “Remember” checked. Use isolated `user-data-dir` and a separate
  `--dsh-home`/credentials path for destructive tests.
- **Never use broad `pkill` for Edge/Chrome.** Target processes by their
  `--user-data-dir` value.
- **`pnpm` is not installed; the repo uses npm workspaces.** Do not reintroduce
  `pnpm-workspace.yaml`.
- **The model route is generated, not hand-edited.** `config/browser.patch.yml`
  leaves `llm-pi-ai` dormant; `companion/openrouter.mjs` writes
  `llm.patch.yml` from `llm.json`.
- **Mock-model e2e is brittle.** It is easy to make it loop tool calls; use a
  stateful script that answers with text after one action. The old mock scripts
  were removed after use.
- **Stale capability text is a latency bug.** The persona and GUIDANCE still
  said "you cannot click" after the click tools shipped; the model spent its
  whole first turn reasoning about the contradiction (558 reasoning chars per
  step vs 110 after it resolved). Keep capability prose in sync with the tools.
- **One debugger attach per burst.** Attach/detach is ~100 ms, so a 5-point
  burst in one attach costs about the same as a single click; a `view:"none"`
  5-point burst skips the capture entirely (~50 ms on the fixture).
- **Native value setters + input events beat key-by-key typing** for DOM
  fields, and survive React-style controlled inputs. Keep trusted
  `Input.insertText` for the focused-element/canvas-editor path, where there is
  no DOM value to set.
- **The side-panel page caches `browser.js` as an ES module.** After editing the
  executor, reload the side-panel page (or restart the isolated Edge) before an
  e2e run, or the suite silently tests stale code.
- **Serialization is the real latency cost, not the browser.** Across 19 work
  turns the model averaged 0.96 tool calls per step (0 of 220 steps had more
  than one), so a 62-action turn was 62 model requests; each action also
  appended a full view, pushing prompts to 134 K tokens/step and 245 K at worst.
  Fix round trips (batch) and per-action payload (compact views) before tuning
  browser timings.
- **A batch cannot cross a reveal boundary.** A menu/dialog/page that appears
  only after an action cannot be targeted by a later action in the same batch,
  because its label id does not exist until a view is taken. Guidance tells the
  model to stop the batch and take a view.
- **Reasoning tokens dominate action turns.** Post-batch measurement: turns at
  effort `off` ran **0.87–1.94 s/step** with 54–75 output tokens; the same kind
  of work at `low` ran **3.16–6.96 s/step** with 211–420 output tokens, of which
  63–93% were hidden reasoning (a 686-token step carried only 312 chars of tool
  arguments). Action prompts therefore classify as `act` → `off`.
- **Never prune history mid-turn.** `image/offload` changes the request prefix,
  so pruning during a turn would invalidate the prompt cache on every later
  step. Prune at turn boundaries and configure `compaction-basic` for the
  cross-turn growth instead.
- **Native text selection needs trusted input.** Untrusted synthetic
  `mousemove` events do not extend a selection; `browser_select` must use CDP
  `Input.dispatchMouseEvent` with `buttons:1` between press and release.

---

## 10. Configuration reference

Companion flags (`node companion/index.mjs --help`):

```
--port <n>             bridge port (default 17871)
--token <token>        fixed pairing token
--new-token            rotate token
--base-url <url>       OpenRouter-compatible base URL
--model <id>           initial model (otherwise choose in the panel)
--reasoning-effort <l> auto|off|low|medium|high (default auto)
--max-tokens <n>       output cap (default 8192)
--dsh-home <path>      default .dsh-home
--patch <path>         default config/browser.patch.yml
--credentials <path>   fallback DSH credential file
--no-dsh               bridge-only test mode
--no-auto-capture      no screenshot attached to each user turn
```

Environment variables:

| Variable | Use |
|---|---|
| `CRAZYAGENT_API_KEY` | OpenRouter key override (highest precedence) |
| `CRAZYAGENT_REASONING_POLICY` | `auto`/`off`/`low`/`medium`/`high` passed to the plugin |
| `CRAZYAGENT_CREDENTIALS_PATH` | DSH credential store path |
| `CRAZYAGENT_PORT`, `CRAZYAGENT_DSH_HOME`, `CRAZYAGENT_PATCH`, `CRAZYAGENT_MAX_TOKENS`, `CRAZYAGENT_MODEL`, `CRAZYAGENT_BASE_URL`, `CRAZYAGENT_REASONING_EFFORT` | companion defaults |
| `DSH_BROWSER_BRIDGE_URL`, `DSH_BROWSER_BRIDGE_TOKEN` | injected into DSH for the provider plugin |

Reasoning auto policy (per turn, from the claimed prompt):

| Class | Examples | Effort |
|---|---|---|
| navigate | “scroll down”, “list my tabs”, “go to my emails” | `off` |
| inspect | “what is on this page?”, “go to Docs and tell me what’s there” | `low` |
| synthesize | “summarize”, “compare”, “why…”, long/multi-question prompts | `low` |
| rapid | “play the game”, “click the dots as they appear”, “as fast as you can” | `off` |
| act | “delete it all”, “add some comments”, “fill the form and submit” | `off` |

Reasoning is held for all steps of a turn; decisions appear as
`reasoning.policy` in `events.jsonl` and as `policy` entries in the live feed.

Generated model route (from `companion/openrouter.mjs`):

```yaml
- id: llm-pi-ai
  config:
    providers:
      openrouter:
        apiKeyEnv: CRAZYAGENT_API_KEY
        api: openai-completions
        baseURL: <base>
        compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: <true if model reasoning>, thinkingFormat: openrouter }
        models: [ { id, name, contextWindow, maxTokens, input: [text, image], reasoningEfforts: { off: 'none', minimal, low, medium, high } } ]
        requestImagePixelBudget / requestImageMaxBytes / maxRequestImageBytes
```

Image budget: `imageHistoryKeep` defaults to 2 (provider config, currently not
exposed in Settings).

---

## 11. Ports, paths, and state

| Thing | Value |
|---|---|
| Bridge | 127.0.0.1:17871, path `/bridge`, health `/health` |
| Fixture server | 127.0.0.1:17872 (manual; not started by the companion) |
| Edge e2e CDP | 9228 click, 9230 canvas, 9231 advanced, 9233 work |
| Extension ID (current path) | `kmipadgipilkdidennbhcgmoolfedgph` |
| Debug runs | `.dsh-home/browser-agent/logs/<runId>/` |
| Screenshots | `<run>/screenshots/*.jpg` |
| ZIP exports | `<run>/exports/crazyagent-log-<runId>.zip` |
| DSH sessions | `.dsh-home/sessions/.../session.v4.jsonl` |
| Companion log | `logs/companion.log` |

The extension ID is derived from the absolute extension path; moving the repo
changes it. Recompute with the hash mapping (digits `0-9a-f` → letters `a-p`) or
read it from `chrome://extensions`.

---

## 12. Security / privacy summary

- Bridge is loopback-only, token-authenticated (constant-time compare), max
  32 MiB frames.
- The API key is entered in the panel, sent over loopback, held in companion
  memory, passed to DSH as an env var, and (optionally) stored at
  `.dsh-home/browser-agent/api-key` mode 0600. It is **never** written to
  `chrome.storage` or the generated patch.
- `debugger` and `webNavigation` permissions are powerful: they allow trusted
  input and frame enumeration. The debugger is attached only for the duration of
  a coordinate click or wheel.
- Screenshots, page text, reasoning, and clicks are sent to the configured
  OpenRouter model and its upstream provider. Do not use it on sensitive pages
  without accepting that.
- Clicking and typing can submit forms or trigger page actions. Actions are
  limited to visible labelled controls, explicit coordinates, explicit
  text/keys, and http(s) URLs; every action reports whether the page changed.
- Debug bundles contain page content and screenshots; redaction covers tokens,
  keys, and secret-shaped values only.
- `logs/`, `.dsh-home/`, `.env*`, `node_modules/`, `dist/`, `release/` are
  gitignored.

---

## 13. Suggested resume sequence

1. `cd /home/conan/Documents/GitHub/crazyAgent`
2. `curl -s http://127.0.0.1:17871/health` — expect `tools:true`.
3. `npm test` — expect 88 passing.
4. Read the latest run under `.dsh-home/browser-agent/logs/` if investigating a
   specific behaviour (`events.jsonl`, `summary.md`).
5. Reload the extension if `extension/` changed since the last load.
6. Pick the next task from §8; start with **typing** unless the user asks
   otherwise.
7. Before shipping any change: `npm test`, at least the relevant Edge e2e suite,
   reload the extension, restart the companion if `companion/` or the provider
   changed, and verify health.

### Quick sanity prompts for the agent

- “What is on this page?” (vision + auto-capture)
- “Click Increment.” (`click.html`, label path)
- “Click the middle of the canvas.” (`canvas.html`, trusted coordinate path)
- “Click Shadow action.” / “Click Frame action in both frames.” (`advanced.html`)
- “Set Country to Canada.”
- “Hover Menu, then click Menu item.”
- “Switch to the Second Fixture Page tab.”
- “Read this page and give me the markers.”
- “Scroll down 700 pixels.”
- “Fill the name and notes fields and submit” — should become one `browser_batch` call with one final view.
- “Type ‘hello’ into the search box and press Enter.” (`form.html`)
- “Click into the editor and type ‘draft text’.” (canvas-editor path)
- “Go to 127.0.0.1:17872/second.html and tell me the marker.” (`navigate`)
- “Wait for the page to show READY, then tell me what it says.” (`wait_for`)
- “Select the first paragraph and make it bold.” (`browser_select` + Ctrl+B)
- “Add a comment on this sentence.” (select → Ctrl+Alt+M → type → submit)
- “Take a quick look at the page.” (`browser_screenshot` detail:"fast")

---

## 14. Open questions for the user

- Which breadth item comes first: file upload, native dialogs, downloads, or
  drag/drop?
- After real-session validation: is effort `off` good enough for complex action
  turns, or should `act` map to `minimal`?
- Is the debugger banner acceptable, or should trusted input be opt-in per tab?
- Is the built-in PDF viewer / browser-internal pages worth supporting through a
  separate path, or explicitly out of scope?

---

## 15. Session log — 2026-10-21/22 conversation (high level)

The repo began this session as a working phase-1 "vision + click" agent with no
commits. Five rounds turned it into a work-capable, batching, low-reasoning agent.
Each round used the same method: read a real debug run, attribute wall time to
root causes, fix the architecture, verify with tests + Edge e2e, commit.

### Round 1 — canvas game latency (commit `0f581fe`)
- The canvas game worked but was only fast "after it learned".
- Measured (`run-...T14-23-34-035Z-6c0408`): per click **2,122 ms model round
  trip (~80%)**, 390 ms browser (13.6%), 120 ms image commit (5%). Per-click wall
  fell 6,279 ms -> 2,474 ms because reasoning/output dropped (689 -> 154
  reasoning chars/click) and setup round trips shrank — the click itself never
  got faster. Slow first turn root cause: persona/GUIDANCE still said "you
  cannot click or type in Phase 1", so the model debated its own capabilities.
- Fixes: burst `click_at` points 1-8 (one attach, one capture, per-point diff),
  adaptive paint settle replacing the fixed 160 ms pause, `view:"none"`, screenshot
  `delay_ms`, `rapid` reasoning class (games -> off), corrected capability prose.
- Result: game score 107 -> **612**, accuracy 94% -> **100%**, ~5.3 points/call,
  46 -> 233 clicks across four 40 s turns.

### Round 2 — work foundation (commit `afb3059`)
- Goal clarified: real browser work, not games. Missing primitives: typing, keys,
  URL navigation, deterministic waiting.
- Added `browser_type`, `browser_press_key`, `browser_navigate`, `browser_wait_for`
  (13 tools), with persona/GUIDANCE updated in the same change, a `form.html`
  fixture and the `edge-work-e2e` suite. 71 tests.

### Round 3 — serialization and context growth (commit `3b6224e`)
- Work turns still took 90-420 s.
- Measured (`run-...T19-11-58-370Z-0ea2f0`, 19 turns / 220 steps): **0 of 220
  steps had more than one tool call** (0.96 average), and every action returned a
  full view, so prompts averaged **134 K tokens/step** (245 K max) with 204
  images re-sent per run; 7 calls were wasted on stale labels/keys/captures.
- Fixes: `browser_batch` (1-20 ordered actions, one final view, per-action
  outcomes), view modes `auto/full/compact/none` with label deltas (compact DOM
  action 18-35 ms vs 360-1266 ms), cumulative per-tab label registry,
  printable-ASCII keys, capture retries. 14 tools, 81 tests.

### Round 4 — reasoning tokens and selection (commit `145ca2b`)
- Question: "is it the tools? missing capabilities? make it fast".
- Measured (`run-...T21-30-54-909Z-ac82d4`, 5 work turns): effort `off` turns ran
  **0.87-1.94 s/step** with 54-75 output tokens; `low` turns ran **3.16-6.96
  s/step** with 211-420 output tokens, **63-93% of them hidden reasoning**. Batch
  adoption was good where possible. The Docs comment turn (123 actions / 106
  steps, 15 Escapes, 8 Ctrl+Alt+M, 3 disabled Comment items, 2 NOT_EDITABLE)
  proved text selection was missing. Prompts climbed 45 K -> 140 K tokens/step.
- Fixes: `act` reasoning class (short imperative work prompts -> off; questions/
  synthesis stay low), `browser_select` (trusted drag + selected-text readback,
  batch-compatible, Docs comment recipe), `compaction-basic` thresholds
  0.06/0.02 (~63 K trigger vs 80%), `detail:"fast"` 640 px screenshots,
  NOT_EDITABLE focus-fallback typing, named punctuation keys. 15 tools, 88 tests.

### State at handoff / not yet validated
- Commit `145ca2b`, clean tree, **88/88 tests**, companion running (PID in
  `logs/companion.pid`), health `tools:true`, 15 tools registered, compaction
  visible in `--dump-config`.
- **The 145ca2b extension has not been exercised in a real user session yet.**
  Reload the extension in `chrome://extensions` and reopen the side panel first
  (the companion is already restarted). The latest real measurement is the
  pre-145ca2b run cited above.
- Expected but unverified: action turns drop toward the off-turn rate (~2-4x),
  Docs comment workflows collapse to a few actions per comment, later-turn
  prompts stop near the 63 K compaction trigger.
- If effort `off` degrades complex planning, route `act` to `minimal` instead.

### Measurement recipes
- Per-step model time / prompt tokens / cache: `notification` -> `session.event`
  `assistant/message` usage; TTFT from `frame.in` activity `model-start` to the
  first text/reasoning delta.
- Per-action browser time: `browser.command.result` `durationMs`; attribution =
  model gaps (`tool.result` -> next `tool.call`) vs browser vs commit.
- Reasoning volume: activity `kind:"reasoning"` deltas, or
  `outputTokens - (visible text + tool args)/4`.
- Images: `image.budget` events (`live`/`offloaded`) + image blocks in tool
  results; ~780 input tokens per 1280 px screenshot, ~195 for `detail:"fast"`.
- The first deep attribution lives in
  `.dsh-home/browser-agent/analysis/canvas-latency.md` (gitignored).