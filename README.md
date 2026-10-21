# CrazyAgent — a work-capable browser agent

A Chrome/Edge side-panel agent that **sees the current tab, clicks labelled DOM controls or canvas coordinates (single points or a burst of up to eight per call), types into fields and focused editors, presses keys and shortcuts, hovers, selects options, reads page text, scrolls, navigates to URLs or through history, waits for page conditions, and lists or switches tabs**. It cannot drag/drop, upload files, download files, handle native JS dialogs, or capture full pages yet. The agent loop, sessions, tool pipeline, prompt assembly, attachments, and model routing are **DSH 0.2.1-rc.2**, not a custom harness. The agent loop, sessions, tool pipeline, prompt assembly, attachments, and model routing are **DSH 0.2.1-rc.2**, not a custom harness.

The side panel is a normal MV3 extension page. The DSH runtime runs locally as a child of a small companion process; the browser and the harness talk over loopback WebSocket.

```text
Chrome tab ── screenshot/scroll/tabs ──> side panel ──WS──> companion ──stdio JSON-RPC──> DSH ──> DeepSeek
                                             ▲                 │
                                             └──── tool bridge ┘
```

## What works

| Capability | Result |
|---|---|
| Auto-view on every message | A fresh screenshot is attached to the user prompt, so the model starts each turn already looking at the page |
| `browser_screenshot` | Viewport screenshot + tab, viewport, scroll, and scale metadata |
| `browser_click` | Clicks a numbered interactive element (DOM, shadow DOM, or iframe) from the current view. Labels come from yellow badges and a text list; coordinates are never accepted. Returns whether the page changed and a fresh view |
| `browser_click_at` | Clicks screenshot-pixel or CSS coordinates for canvas, video, and iframe surfaces. `points: [{x,y}, …]` clicks up to 8 targets in one call (one debugger attach, one settle, one fresh view, per-point `changed`); `view: "none"` skips the screenshot for rapid repeated bursts; `settle_ms` tunes the post-click paint wait. Uses **trusted browser input** (DevTools protocol) and verifies with a **pixel diff**, which works where no DOM event fires |
| `browser_type` | Types into a labelled input, textarea, or contenteditable (`mode: append|replace`, optional `submit`), or into the focused element when `label` is omitted — click a canvas editor caret first, then type through trusted `Input.insertText`. Returns a fresh view, the new value, and `changed`; password values are masked |
| `browser_press_key` | Sends one real key press with optional `ctrl`/`alt`/`shift`/`meta`: Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, Space, or a letter/digit. Used to submit, move focus, move a caret, and run shortcuts |
| `browser_hover` | Hovers a labelled element and returns a fresh view, so hover-only menus and tooltips become clickable |
| `browser_select_option` | Chooses an option on a native `<select>` by label id and option text (a synthetic click cannot open the OS dropdown) |
| `browser_read_text` | Rendered page text (or just the viewport) as text, with `offset`/`max_chars` pagination. No screenshot; typically a few milliseconds and far fewer tokens |
| `browser_scroll` | Scrolls the document or the largest visible nested scroller; falls back to a **trusted wheel event** for canvas apps; returns a fresh screenshot |
| `browser_navigate` | Opens an absolute **http(s) URL** in the active tab or a new tab (`new_tab`), or goes history `back`/`forward`/`reload`; waits up to 15 s for load and reports `timedOut` |
| `browser_wait_for` | Waits for rendered **text**, a **url** substring, DOM **idle**, and/or a fixed **ms**, bounded by `timeout_ms` (default 10 s); returns a fresh view and `found`/`timedOut` — use it instead of repeated screenshots |
| `browser_tabs` | Lists the current window's tabs with ids, titles, URLs, and state |
| `browser_switch_tab` | Activates a tab by `tab_id` or by a case-insensitive title/URL `query`; returns a fresh screenshot |
| Vision model | Image-capable OpenRouter model through DSH's pi-ai adapter |
| Live activity | Expanded side-panel feed streams reasoning/thinking deltas, assistant text, partial and committed tool calls, results, browser commands, token usage, finish reasons, and errors as they happen |
| Reasoning effort | **Auto** by default: `off` for navigation-only turns and **rapid game bursts**, `low` for reading/describing/synthesis. Manual `off`/`low`/`medium`/`high` override in Settings |
| Image history | After each turn, the newest two screenshots stay in the request; older ones are durably offloaded to placeholder text while attachments remain on disk |
| Persistence | DSH session log and screenshot attachments under `.dsh-home` |
| UI | Side-panel chat, live activity feed, tool cards with text previews and screenshot thumbnails, pause, settings, new chat |

**Not yet supported: drag/drop, file upload, downloads, native JavaScript dialogs, arbitrary JS, and full-page capture. DOM actions are limited to labelled, visible, hit-testable elements; canvas actions use explicit coordinates; typing goes only into labelled editable elements or the focused element; navigation is http(s) only.**

### Canvas, video, and iframe surfaces

Canvas apps (Docs-style editors, maps, Figma-style tools, dashboards, games, video players) have no DOM controls to label, and their clicks never produce DOM mutations. The agent handles that in five ways:

1. **Surface metadata.** Every view lists visible `canvas`, `video`, and `iframe` regions with size and position, so the model knows when to switch from labels to coordinates.
2. **Coordinate clicks with trusted input.** `browser_click_at` maps screenshot pixels to CSS viewport pixels, then dispatches via `chrome.debugger` (`Input.dispatchMouseEvent`), so the page receives trusted mouse events that canvas handlers accept. If the debugger cannot attach (DevTools is open), it falls back to synthetic events and reports `trusted: false`.
3. **Pixel-diff verification.** The side panel keeps the previous view image and samples a 240×240 CSS region around the click before and after. `pixels_changed` is the share of sampled pixels that changed, and it is the only reliable success signal for canvas. A click on an unchanged region returns **NO VISIBLE CHANGE**.
4. **Burst clicking and hasty mode.** Several canvas targets are usually visible at once -- a reaction game can show ten. `browser_click_at` accepts up to eight `points` per call: they share one `chrome.debugger` attach, one adaptive paint settle, and one capture, and the result reports `changed` per point. `view: "none"` skips the capture entirely, the fastest path for rapid repeated bursts (at the cost of not seeing the result until the next screenshot). `settle_ms` (0-400) overrides the adaptive paint wait when a surface repaints slowly.
5. **Typing into canvas editors.** `browser_click_at` sets the caret, then `browser_type` without a `label` sends trusted `Input.insertText` to the focused element, and `browser_press_key` moves the caret with arrows/Home/End or runs shortcuts. This is the Google Docs path: click where the text should go, then type.

Canvas apps also keep their own scroll state, so `browser_scroll` first tries the DOM; if nothing moved, it dispatches a trusted wheel event at the viewport center and reports `wheel: true`.

Shadow DOM and iframes are handled for DOM clicking:

- Open shadow roots are traversed recursively, so web-component controls are labelled and clickable.
- Every accessible frame is labelled; child-frame labels get globally unique ids (`frameId * 100000 + localId`) and the click is dispatched into the owning frame. Same-origin and cross-origin frames both work because the extension has `<all_urls>` host access.
- Hover-only menus: `browser_hover` reveals the menu and returns a fresh labelled view; then click the new label.
- Native selects: clicking cannot open the OS dropdown, so `browser_select_option` sets the value and fires `input`/`change`.

**Permissions and warnings:** trusted input requires the `debugger` permission, plus `webNavigation` for the frame list. Chrome shows a "started debugging this browser" banner while a trusted click or wheel is being dispatched (attach → dispatch → detach, roughly 100 ms). If DevTools is open on that tab, the debugger cannot attach; DOM clicks still work, and `click_at` reports the conflict.

### How clicking stays accurate

Every view (auto-capture, screenshot, scroll, tab switch, and click result) labels the interactive elements in the viewport:

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
- On a user message, asks the side panel for a snapshot and sends it as an image block in the prompt (unless auto-capture is off); then streams relevant DSH session events as chat text, tool cards, and status.
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
- sets a browser-agent persona, disables harness identity/runtime context, and serializes tool calls (`maxParallelToolCalls: 1`);
- leaves attachments, compaction, image offload, and JSONL persistence in place.

The result is thirteen model-visible tools and a small, stable request prefix.

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

Auto classifies the user prompt once per turn, locally and deterministically, then holds that effort for every step of the turn:

| Turn class | Examples | Effort |
|---|---|---|
| Navigation | “scroll down”, “list my tabs”, “go to my emails” | `off` |
| Inspect | “what is on this page?”, “go to Docs and tell me what’s there” | `low` |
| Synthesis | “summarize this”, “compare the tabs”, “why…”, long or multi-question prompts | `low` |

The rule is intentionally conservative: only turns with no user-facing synthesis get `off`, because tool steps already produce little reasoning. Every decision is logged as `reasoning.policy` with the classification, effort, and prompt size, so it can be tuned from real logs. Choose **Off** in Settings for maximum speed everywhere, or `low`/`medium`/`high` to force a level. Models without reasoning support send no effort.

The live activity feed shows a `policy` entry per turn and streams reasoning deltas when the provider exposes them.

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
npm test          # 71 unit/integration checks: bridge, live activity, reasoning policy (incl. rapid), image budget, labels, click/burst/type/press_key/navigate/wait_for tools, surfaces, prompt, log store, OpenRouter config, key resolution, tab matching, tool content, scroll math, URL guards
npm run bench     # local bridge latency
npm run setup     # idempotent profile/plugin verification
```

Additional dev-only checks (not part of `npm test`):

- `node scripts/fake-ui.mjs` — a fake sidebar that answers browser commands with a local JPEG; exercises the companion + DSH provider + model without Chrome.
- `scripts/edge-probe.mjs`, `edge-e2e.mjs`, `edge-tabs-e2e.mjs` — drive the real extension executor/UI in Edge over CDP. They require Edge launched with `--load-extension=extension` and a remote-debugging port. These produced the live measurements above.
- `scripts/log-probe.mjs` — connects as a fake side panel and requests `log.stats`, `log.summary`, and a ZIP export without starting a model turn.
- `scripts/edge-log-e2e.mjs` — drives the real Debug log modal and verifies that the ZIP download starts.
- `scripts/edge-click-e2e.mjs` — drives the real extension against `e2e/fixtures/click.html`: label coverage, covered/hidden exclusion, click by label, no-op detection, disabled/stale refusals, checkbox, and navigation. Requires Edge with `--load-extension=extension` on port 9228.
- `scripts/edge-canvas-e2e.mjs` — canvas checks on port 9230: surface metadata, trusted coordinate click, image-pixel mapping, pixel-diff detection, wheel scrolling, empty-area no-op, 5-point burst (one attach, +5 trusted clicks), `view:"none"` text-only burst, `delay_ms`, and single-point compatibility.
- `scripts/edge-work-e2e.mjs` — work-foundation checks on port 9233 against `e2e/fixtures/form.html`: labelled typing (replace/append), contenteditable typing, password masking, `submit`, Tab/Enter, modifier shortcuts, label-less trusted typing into a focused editor, navigate URL/history, and `wait_for` found/timeout.
- `scripts/edge-advanced-e2e.mjs` — shadow DOM, same- and cross-origin iframes, native select, and hover menus on port 9231.

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
packages/dsh-browser-extension/       browser-use provider + 4 tools
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