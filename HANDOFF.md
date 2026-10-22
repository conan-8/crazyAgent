# CrazyAgent — continuation handoff

Last updated: 2026-10-22 (late). Repo is working, companion running, 16 tools, 149 tests. A 2026-10-22 hardening pass fixed the compaction treadmill, reasoning misclassification, click/key edge cases, and added run-time guardrails; a second pass added clipboard copy/paste, a Stop button (runtime interrupt + session resume), and a full-height streaming pane.

This file is the complete context transfer for a new conversation. Read it, then
`README.md`, then the latest debug run if you need ground truth.

> **In a hurry?** `HANDOFF-QUICK.md` is the 2-minute version: current build facts,
> how to resume, what just shipped, known issues, and the next work order.

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
reloaded after extension changes. Current build: the 2026-10-22 clipboard+stop
pass on main, 16 browser tools, 149 tests. The model is OpenRouter deepseek/deepseek-v4.1-flash-1017 with
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
│    - provider plugin: 16 browser tools, guidance, reasoning policy          │
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
| Companion | running, PID in `logs/companion.pid` (restarted after the 2026-10-22 hardening pass) |
| Bridge | `ws://127.0.0.1:17871/bridge` |
| Health | `{"ok":true,"ui":false,"tools":true,"port":17871}` |
| Token | read `.dsh-home/browser-agent/token` (do not commit it) |
| Model | OpenRouter `deepseek/deepseek-v4.1-flash-1017` |
| Base URL | `https://openrouter.ai/api/v1` |
| Reasoning | `auto` (per-turn policy, with mid-turn escalation after 3 no-progress results) |
| API key | stored, 73 bytes, `.dsh-home/browser-agent/api-key` (0600) |
| Extension | unpacked from `extension/`; ID `kmipadgipilkdidennbhcgmoolfedgph` (path hash); **reload after this pass** (new `clipboardRead`/`clipboardWrite` permissions) |
| Permissions | sidePanel, tabs, scripting, storage, **debugger**, **webNavigation**, **clipboardRead**, **clipboardWrite**, host `<all_urls>` |
| Latest run log | `.dsh-home/browser-agent/logs/run-2026-10-22T06-08-35-217Z-a4c366` (clean restart after the hardening pass; one real email/HTML turn, 320 s, 48 calls, 0 errors); the 11-turn real-user run analysed for the fixes is `run-2026-10-21T23-36-12-600Z-8f5493` |
| Tests | 149/149 passing (companion 42, extension 32, provider 75) |
| Git | `main` has the original rounds plus the 2026-10-22 hardening and clipboard/stop commits; tree clean |

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
   **sixteen** browser tools; every action is a labelled element, an explicit
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

## 5. Capabilities (sixteen model-visible tools)

| Tool | What it does | Notes |
|---|---|---|
| `browser_screenshot` | View with tab/viewport/scroll metadata, numbered labels, surface list | `detail:"high"` uses 2048 px width; `delay_ms` 0-5000 waits in the page before capturing |
| `browser_click` | Click a labelled element | DOM, open shadow roots, iframes. Returns `changed` + signals + fresh view |
| `browser_click_at` | Click screenshot pixels or CSS coordinates; `points` bursts up to 20 | Canvas/video/iframe. One debugger attach + one capture per burst, per-point pixel diff. Points outside the viewport are reported as `offScreen` and never clicked; scroll drift since the stored view is reported as `staleScroll`. `view:"none"` = text-only fast mode; `settle_ms` 0-400 |
| `browser_batch` | Run an ordered sequence of 1-20 actions in one call | Allowed ops: click, click_at, hover, select_option, type, press_key, scroll, wait_for, navigate. One final view; compact per-action outcomes; `stop_on_error` default true; `view` default full; per-call timeout scales with action count |
| `browser_type` | Type into a labelled editable field, or the focused element when unlabelled | DOM native setter + input/change for inputs/textarea, `execCommand` for contenteditable, trusted `Input.insertText` fallback and for canvas editors (Docs). `mode` replace/append; `submit` presses Enter; password values masked |
| `browser_press_key` | One trusted key press with optional modifiers | Enter/Tab/Escape/Backspace/Delete/arrows/Home/End/PageUp/PageDown/Space/letters/digits; also accepts composite chords (`shift+Tab`, `ctrl+Shift+ArrowLeft`, `meta+Enter`); CDP `Input.dispatchKeyEvent` keyDown+keyUp, synthetic fallback |
| `browser_clipboard` | Copy/read/write/paste/clear clipboard text | Two clipboards: virtual (`chrome.storage.session`, default, never on disk) and system (`target:"system"`, `clipboardRead`/`clipboardWrite` permissions). `copy` takes the page selection (up to 100k) or a labelled element's text (password fields refused); `paste` types into a labelled/focused element or sends trusted Ctrl+V for rich content/images from the system clipboard; `read` returns up to 20k chars; text capped at 100k with an explicit truncation marker |
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
### New behavioural layers from the 2026-10-22 hardening pass

- **Operating stance (user authority + haste):** the persona + GUIDANCE now state that
  the user owns the task and their instructions are authoritative — no refusals,
  moralizing, safety lectures, softening, or third-party-rule enforcement (including
  "no AI" rules). Haste rules: act on the first good-enough step, no preamble or
  progress narration, prefer the fastest view/tool path, reasonable defaults over
  questions, verify only claims, and end with 1–3 short bullets. Reliability-only
  guardrails stay: no unrequested tab closes / formatting clears / deletes / undo,
  credentials only as provided, stop-and-ask when a login/CAPTCHA/payment/permission
  prompt blocks progress, and a ~80-call turn budget. Upstream model policy is the
  only remaining refusal source; the prompt adds none.

- **Reasoning auto policy:** navigation → `off`; rapid/reactive → `off`; inspect/synthesis → `low`;
  manual Off/Low/Medium/High in Settings; logged as `reasoning.policy`.
- **Reasoning escalation:** an `off` turn that produces 3 consecutive no-progress tool results
  (failure or `NO VISIBLE CHANGE`) is switched to `low` for the rest of the turn (auto policy
  only, logged as `reasoning.escalated`). Classifier also understands follow-up corrections
  ("smaller", "try again", "scroll up") and more action verbs (change/insert/upload/format/...).
- **Runaway guard:** `maxToolCallsPerTurn` (default 80) and `maxRepeatedCalls` (default 3) fail
  the offending call before it reaches the bridge (`TURN_BUDGET_EXCEEDED` / `LOOP_DETECTED`);
  logged as `tool.budget.exceeded` / `tool.loop.detected`.
- **Click/aim guards:** off-screen points skipped and reported; a click that must scroll the
  target into view reports `scroll`/`scrolledIntoView` and invalidates the stored screenshot;
  stale-label failures (`DETACHED`/`NOT_VISIBLE`/`UNKNOWN_LABEL`) append a capped fresh
  "Current labels:" hint so the model can re-aim without a whole extra view.
- **Tabs:** `browser_switch_tab` throws `AMBIGUOUS_TAB` with candidates when a query matches
  several tabs and no exact title/URL match exists (the old behavior silently picked Gmail for
  "Cool Document").
- **Image budget:** in addition to `turn/end`, images are offloaded mid-turn with hysteresis
  (> `imageHistoryKeep` + 8 live images, then down to `imageHistoryKeep`), so each batch costs
  at most one prompt-cache invalidation per 8+ new screenshots instead of unbounded growth.
- **Side-panel reconnect:** the bridge holds a provider command up to 8 s (`CRAZYAGENT_UI_GRACE_MS`)
  for the panel to reconnect, then fails with retryable `SIDE_PANEL_CLOSED` instead of `NO_UI`.
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

`npm test` = 149 tests:

- `companion/test/`: bridge + reconnect grace (18), DSH runner stop/resume (5),
  prompt (9), log store (3), credentials (2), openrouter (5).
- `extension/test/`: helpers (3), logger (4), tab match (5), resilience
  (off-screen click_at, stale scroll, scroll policy, tab ambiguity, composite
  keys, stale-label hint, 13), clipboard validation/caps (7).
- `packages/dsh-browser-extension/test/`: tools (54), reasoning (14),
  image budget (7).

E2E suites (not in `npm test`): `edge-click-e2e.mjs` (9 behaviours),
`edge-canvas-e2e.mjs` (surfaces, trusted click, image mapping, pixel diff,
wheel, no-op, 5-point burst, view:none, delay_ms, single-point compatibility),
`edge-work-e2e.mjs` (typing, keys, navigation, waiting on `form.html`),
`edge-advanced-e2e.mjs` (shadow DOM, same/cross-origin iframes, select, hover —
its hover step is a pre-existing stale script: it expects a labels array from a
compact `view:"auto"` hover; treat failures there as historical, verify hover
live with `view:"full"`).

---

## 8. Known gaps / next steps, in suggested order

1. **Typing, navigation and selection — DONE** (2026-10-21). `browser_type`,
   `browser_press_key`, `browser_navigate`, `browser_wait_for` and
   `browser_select` are in the fifteen-tool roster. Remaining input gaps: IME
   composition strings, file inputs, and drag/drop (mouse-button drag of
   elements, as opposed to text selection).
2. **Fast/batch canvas clicking — DONE.** `browser_click_at` accepts `points`
   (1-20 since 2026-10-22) and clicks a whole burst with one debugger attach and
   one capture; `view:"none"` skips the screenshot for text-only fast bursts;
   the fixed 160 ms settle became an adaptive paint wait. Off-screen points are
   now reported and skipped instead of being clamped to the viewport edge.
   Verified by the extended canvas e2e and an e2e 19-point burst.
3. **Drag/drop, sliders, map panning** — trusted `Input.dispatchMouseEvent`
   with `mousePressed` → `mouseMoved` (buttons=1) → `mouseReleased`. Also
   right-click/context menu.
4. **File upload** — `DOM.setFileInputFiles` via debugger, or a picker-free
   pathless `DataTransfer` assignment for `<input type=file>`; no local paths
   from the page/model, user-attached files only. Still the top capability gap.
5. **Native dialogs** — `alert`/`confirm`/`prompt`/print block the tab; handle
   with `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog` while
   attached.
6. **Downloads / new-window popups** — synthetic clicks cannot open them; with
   CDP, `Page.windowOpen` / `Target.createTarget` handling is possible.
7. **Mid-turn image pruning — DONE (2026-10-22).** The provider appends batched
   `image/offload` decisions on `tool/result` with hysteresis (> keep + 8 live
   images, then down to keep), plus the existing `turn/end` pass; logged as
   `image.budget.midturn`. One cache invalidation per 8+ new screenshots.
8. **Step/tool-call cap — DONE (2026-10-22).** Provider-level
   `maxToolCallsPerTurn` (80) and `maxRepeatedCalls` (3) with
   `TURN_BUDGET_EXCEEDED` / `LOOP_DETECTED` tool errors. DSH still has no
   cancel through the SDK, so this is a soft guard (the model is told to stop).
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
14. **Name/role targeting and reveal-boundary batches** — the biggest remaining
    round-trip cost on Docs-style apps: menus cost one model call per level and a
    batch cannot cross a reveal boundary. Add a bounded name→label resolver
    (fail-closed on ambiguity) and/or an auto-snapshot boundary inside a batch.
15. **A skill/recipe layer** — named procedures (`docs_insert_image_from_url`,
    `docs_fix_comment`, `docs_format_line`, `chimp_burst`, `form_fill_submit`)
    expanded into `browser_batch` calls, recorded from successful sequences.
    This is what "skills" means here: the agent has primitives but re-derives
    every procedure each turn (T2 re-opened the same menu six times).
16. **Verify-before-claim discipline** — the 2026-10-22 run contained false
    claims ("all 30 targets", "level 19 / 19 passes", "I set zoom back to 100%")
    and one misdiagnosis ("the board froze"). Require claims to cite the latest
    read-back/screenshot, especially after destructive edits.
17. **Observation primitives for animation** — reaction-time and
    sequence-memory games cannot be played through a 0.9–1.5 s screenshot loop.
    Add a page-side "wait for pixel/region change then click" primitive, burst
    frame capture, or declare those games out of scope.
18. **Context cost observability** — auto-write a per-run `summary.md`
    (model/browser/compaction attribution, cache hit, duplicate calls, error
    table) and alert on budgets; the 2026-10-22 analysis was all derived from
    `events.jsonl` by hand.
19. **Clipboard copy/paste — DONE (2026-10-22).** `browser_clipboard` with a
    virtual clipboard (`chrome.storage.session`, default) and optional system
    clipboard (`clipboardRead`/`clipboardWrite`); copy selection/label, read,
    write, clear, paste (typed or trusted Ctrl+V for rich content).
20. **Stop button — DONE (2026-10-22).** UI `■` sends `chat.stop`; the companion
    interrupts the DSH runtime (no SDK cancel exists) and resumes the same
    session on the next message. Aborted turns log `TURN_STOPPED` (not
    `TURN_FAILED`). Remaining risk: resume of an interrupted real-DSH session is
    unit-tested only; if resume fails the next turn starts a fresh session.
21. **Full-height streaming pane — DONE (2026-10-22).** The live-activity pane
    fills the top of the sidebar (no 190px cap), splits with the chat, and has
    an expand-to-full-height toggle.

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
- **Never prune *compaction* history mid-turn.** A compaction rewrite changes the
  request prefix and invalidates the prompt cache. The image budget is the
  exception: batched `image/offload` on `tool/result` with hysteresis (keep + 8)
  costs at most one cache miss per batch and is worth it, because screenshots are
  the part of the prompt that grows monotonically.
- **Native text selection needs trusted input.** Untrusted synthetic
  `mousemove` events do not extend a selection; `browser_select` must use CDP
  `Input.dispatchMouseEvent` with `buttons:1` between press and release.
- **Compaction thresholds must be sized against *billed* tokens, not metered
  ones.** Measured 2026-10-22: the OpenRouter/pi-ai route has no
  `imageRequestPricing`, so the token meter priced each screenshot at ~53 tokens
  while the provider billed 674–990. A 6%/2% trigger on a 1M window (~63 K) then
  compacted 79 times in 11 turns: the "20.8 K retained tail" held 58–89 images
  (~50 K real), each pass freed ~1–2.8 K, 15 passes failed the shrink check
  *after* paying for a summary, and post-compaction requests had a 10.5% cache
  hit vs 96.4% normally (27% of run wall, 60% of one turn). Fix: trigger at 55%
  of the window (~577 K), `retainTokens: 20000`, `maxTokens: 8192`, and keep
  prompts small with the image budget instead. If you change the model route,
  check whether its adapter declares `imageRequestPricing` before lowering the
  threshold again.
- **Clamped coordinates are silent wrong clicks.** `click_at` used to clamp
  every point into the viewport; a stale aim then clicked the viewport edge and
  reported only "no visible change" (a chimp board looked "frozen" when it was
  merely scrolled). Now off-screen points are reported and skipped, and
  `staleScroll`/`scrolledIntoView` tell the model when its image coordinates no
  longer map. Never silently clamp a coordinate again.
- **A labelled click may scroll the page.** `scrollIntoView` was unconditional;
  clicking Continue in a game moved the page 111 px and invalidated the model's
  aim for the rest of the turn. Scroll only when the target is not fully visible,
  report the delta, and invalidate the stored screenshot when it moves.
- **Guard loops before they burn tokens.** The 11-turn run had 74 identical
  tool calls (21%) and no cap of any kind; one turn used 104 calls / 6.06 M
  prompt tokens. A per-turn call budget and repeated-call breaker are cheap and
  fail the call before the browser is touched.
- **Compaction and image offload are not free abstractions.** Both are model-
  visible durable rewrites; instrument them (`reasoning.escalated`,
  `tool.budget.exceeded`, `tool.loop.detected`, `image.budget.midturn`,
  `bridge.ui.wait`) or their cost is invisible in the log.
- **DSH has no turn-cancel RPC.** `@deepseek-ai/dsh-sdk-client` exposes only
  session/prompt, session/resume, working-directory and shutdown. A Stop button
  must tear down the harness (which rejects the pending `session.run`) and then
  resume the persisted session on the next start; handle resume failure with a
  logged fallback to a fresh session. Log user aborts as `TURN_STOPPED`, never
  `TURN_FAILED`. The interrupted turn persists as a partial/aborted turn —
  unit-tested with a fake harness, not yet exercised against a live DSH runtime.
- **`chrome.storage.session` is the right home for an internal clipboard.**
  Clipboard text must not be written to `chrome.storage.local` or disk; the
  virtual clipboard is session-scoped by design. System clipboard access needs
  `clipboardRead`/`clipboardWrite`, a focused side panel, and fails with
  `CLIPBOARD_DENIED` otherwise. `ctrl+v` pastes whatever the *user* last copied
  (once it pasted a screenshot of the chat UI) — prefer the typed virtual path
  for text and say when a trusted paste is used.
- **Never `pkill` by browser executable path.** An isolated-E2E cleanup once
  matched a normally-running Edge with `pkill -f msedge` and closed it. Only
  kill PIDs/PGIDs you started, and prefer `--user-data-dir`-scoped targeting.

---

## 10. Configuration reference

System prompt: two pieces only — `personaPrefix` in `config/browser.patch.yml`
(role + stance) and the provider `GUIDANCE` constant in
`packages/dsh-browser-extension/lib/index.js` (operating rules + tool guidance).
DSH's harness identity and runtime-context sections are disabled; tool JSON
schemas are sent separately. Stance: user authority, haste, no invented
refusals; reliability-only guardrails. To change the prompt, edit those two
places and restart the companion (no extension reload needed for prompt-only
changes). Run `npm run system-prompt` (or `npm run system-prompt -- --json`)
to print the exact composed prompt and its char counts.

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
| `CRAZYAGENT_UI_GRACE_MS` | side-panel reconnect grace window before browser commands fail with `SIDE_PANEL_CLOSED` (default 8000; 0 = immediate old behavior) |
| `DSH_BROWSER_BRIDGE_URL`, `DSH_BROWSER_BRIDGE_TOKEN` | injected into DSH for the provider plugin |

Provider plugin config (keyed under the `browser-extension` insert in
`config/browser.patch.yml`): `bridgeUrl`, `bridgeToken`, `requestTimeoutMs`,
`reasoningPolicy`, `imageHistoryKeep` (newest live images kept at turn end and
mid-turn; default 2), `maxToolCallsPerTurn` (default 80), `maxRepeatedCalls`
(default 3). Mid-turn image offload hysteresis is fixed at keep + 8 live images.

Compaction policy (`compaction-basic` overlay): `thresholdRatio: 0.55`,
`headroomTokens: 131072`, `retainTokens: 20000`, `maxTokens: 8192`, plus a
`modelPolicies` entry for `openrouter/deepseek/deepseek-v4.1-flash-1017`.
Effective trigger on the 1,048,576 window: **576,716 tokens**.

Clipboard (`browser_clipboard`): virtual clipboard lives in
`chrome.storage.session` key `crazyagent.clipboard` (session-scoped, never on
disk; text capped at 100k) and is the default target. The system clipboard is
opt-in with `target:"system"` and needs the `clipboardRead`/`clipboardWrite`
extension permissions plus a focused side panel. Copy selection uses a dedicated
100k-capped page read; typed paste is capped by the `browser_type` limit (20k);
system-rich paste dispatches a trusted Ctrl+V and does not read the clipboard.

Stop button: the side panel sends `chat.stop`; the companion has no SDK cancel
(0.2.1-rc.2 exposes none), so it closes the DSH harness, which rejects the
in-flight run, then resumes the persisted session on the next message. Frames:
`chat.stopping` → `chat.stopped`; user aborts are recorded as `turn.end`
`{aborted:true, reason:'user'}` and the `TURN_STOPPED` signal (not
`TURN_FAILED`). Resume failure falls back to a fresh session and is logged.

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
In `auto` mode, an `off` turn that accumulates 3 consecutive no-progress tool
results (failure or `NO VISIBLE CHANGE`) is escalated to `low` for the rest of
that turn and logged as `reasoning.escalated`; a manual policy is never
overridden.

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
3. `npm test` — expect 149 passing.
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
- “Copy that paragraph, switch to the notes tab, and paste it into the notes field.” (`browser_clipboard` copy → switch_tab → paste; virtual clipboard)
- “Read what's on my clipboard.” (`browser_clipboard` read target:"system" — only on explicit request)
- “Stop this turn.” / press the ■ button during a long turn (chat.stop → chat.stopped; next message continues the session)

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

### Round 5 — 2026-10-22 hardening pass (from the 11-turn real-user run)
- Input: the first real session on the post-`145ca2b` build — Docs comment fixes,
  a Google-Docs image insert, and four Human Benchmark games
  (`run-2026-10-21T23-36-12-600Z-8f5493`, 11 turns, 364 steps, 354 tool calls,
  1,911.7 s of turn wall).
- Measured: **model round trips 60.0% of wall, compaction 27.0%, browser 12.7%**.
  79 compactions freed ~2.8 K median each and re-fired (T11: 2 per step for 24
  steps, 59.6% of that turn). Root cause: the pi-ai route under-prices images to
  the token meter (53 metered vs 674–990 billed), so the 6%/2% threshold could
  never converge. The hardest task ("add an image") ran `act/off` with 0
  reasoning chars and 104 calls; 4 action turns were misclassified as
  `inspect/low` and burned 165 K reasoning chars; 74 identical calls (21%) with
  no cap; a mid-run side-panel reload killed a 446 s turn; a clipped viewport
  made the chimp board look "frozen".
- Fixes (this pass): compaction policy 0.55/0.20 K/8 K; screenshot image budget
  mid-turn with hysteresis; classify more action verbs + follow-up corrections +
  dynamic `off→low` escalation after 3 no-progress results; composite key
  chords; click_at 8→20 points with off-screen/stale-scroll reporting; click no
  longer force-scrolls; tab ambiguity error; stale-label hint in errors;
  per-turn call budget + repeated-call breaker; side-panel reconnect grace +
  `SIDE_PANEL_CLOSED`; GUIDANCE updates (no ctrl+W, prefer `browser_select`,
  file-picker limitation). 129 tests (+41), click/canvas/work e2e green.
- Not yet done: **real-session validation of this pass** (the extension must be
  reloaded in `chrome://extensions` and the panel reopened), file upload,
  dialogs, drag/slider/right-click, clipboard/IME, downloads/popups, and a
  skill/recipe layer (see §8).

### Round 6 — 2026-10-22 clipboard, stop, and streaming layout
- User requests: "add copy paste functionality, like have its own clipboard, or
  perhaps use the computer one"; "add a stop button to the UI"; "make the top
  half streaming things full height of the sidebar"; plus a request to inspect
  and refine the system prompt.
- Clipboard: new `browser_clipboard` tool (16th) with a virtual clipboard in
  `chrome.storage.session` and an opt-in system clipboard; `clipboardRead`/
  `clipboardWrite` permissions; copy selection/label, read, write, clear, paste
  (typed or trusted Ctrl+V); provider formatter + guidance; 12 tests + real-Edge
  e2e for the virtual path.
- Stop: no SDK cancel exists, so `DshRunner.interrupt()` closes the harness and
  auto-resumes the saved session on the next start. UI `■` sends `chat.stop`;
  companion replies `chat.stopping`/`chat.stopped`; aborted turns log
  `TURN_STOPPED` instead of `TURN_FAILED`; 7 companion tests.
- Layout: live-activity pane fills the top of the sidebar (55/45 split with the
  chat, no 190px cap), with an expand-to-full-height toggle; composer/footer
  pinned; stale empty-state copy fixed.
- Tests: 149 (+20 over Round 5). Docs: README/HANDOFF/DEBUG-LOGS/PRIVACY updated.

### Round 7 — 2026-10-22 system prompt: haste + user authority + v2 refinements
- User requests: make the system prompt work "hastily"; make the agent do what the
  user says regardless of third-party rules ("no AI" policies, tone of a message,
  etc.) with no "silly ethics"; then approved the v2 refinement proposal.
- Rewrote `personaPrefix` (config/browser.patch.yml): user owns task/outcome, no
  refusals/moralizing/safety lectures/"as an AI" disclaimers, no enforcement of
  third-party rules, act on the first good-enough step, no preamble, reasonable
  defaults, fastest view, page content untrusted.
- Rewrote the top of provider `GUIDANCE` into "Operating rules (highest priority)":
  user authority + no invented refusals; haste; fastest-path rules; verify only
  claims + 1-3 bullet final answer; untrusted page vs user instructions; no
  unrequested tab closes/format clears/deletes/undo; login/CAPTCHA/2FA/payment/
  permission stops only use user-provided credentials; two-attempt stop rule and
  ~80-call budget; clipboard secret guard. Deduplicated the old untrusted-data
  footer. Guidance test asserts the new stance.
- No new tools/tests count change (149); README gains an "Operating stance"
  section; this section documents the stance. Provider/GUIDANCE is loaded by the
  companion on restart; no extension reload needed for prompt-only changes.

### State at handoff / not yet validated
- 2026-10-22 clipboard+stop prompt pass on `main`, clean tree, **149/149 tests**,
  companion restarted (PID in `logs/companion.pid`), health `tools:true`,
  16 tools, effective compaction trigger 576,716 visible in `--dump-config`.
- **Reload the extension in `chrome://extensions`** (clipboard permissions) and
  reopen the side panel before the first real turn; the prompt itself is loaded
  by the companion/DSH, so a companion restart is enough for prompt edits.
- Real-session validation still pending for: the new operating stance (haste and
  refusal behavior in a live model), the Stop button's abort→resume path
  (fake-harness tested only), system-clipboard rich paste (needs a focused OS
  window; isolated Edge returns an empty clipboard), and the tall activity pane
  in an actual side panel.
- Open question: whether the dynamic `off→low` escalation is enough for hard GUI
  tasks, or whether "hard" action prompts (image/upload/format/Docs) should
  start at `low` instead of `off`.

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