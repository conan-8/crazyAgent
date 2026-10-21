# CrazyAgent — continuation handoff

Last updated: 2026-10-21. Repo is working and the companion is running.

This file is the complete context transfer for a new conversation. Read it, then
`README.md`, then the latest debug run if you need ground truth.

---

## 0. Paste this into the new conversation

```text
We are continuing CrazyAgent at /home/conan/Documents/GitHub/crazyAgent.
Read HANDOFF.md and README.md first, then run:
  curl -s http://127.0.0.1:17871/health
  npm test
Do not re-derive the architecture invariants in HANDOFF.md §4.
The companion is probably already running (logs/companion.pid). The extension is
loaded unpacked from extension/ and must be reloaded after extension changes.
The model is OpenRouter deepseek/deepseek-v4.1-flash-1017 with reasoning effort
"auto"; the API key is stored in .dsh-home/browser-agent/api-key.
Next task: <fill in>.
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
| Companion | running, PID in `logs/companion.pid` (was 507473) |
| Bridge | `ws://127.0.0.1:17871/bridge` |
| Health | `{"ok":true,"ui":false,"tools":true,"port":17871}` |
| Token | read `.dsh-home/browser-agent/token` (do not commit it) |
| Model | OpenRouter `deepseek/deepseek-v4.1-flash-1017` |
| Base URL | `https://openrouter.ai/api/v1` |
| Reasoning | `auto` (per-turn policy) |
| API key | stored, 73 bytes, `.dsh-home/browser-agent/api-key` (0600) |
| Extension | unpacked from `extension/`; ID `kmipadgipilkdidennbhcgmoolfedgph` (path hash) |
| Permissions | sidePanel, tabs, scripting, storage, **debugger**, **webNavigation**, host `<all_urls>` |
| Latest run log | `.dsh-home/browser-agent/logs/run-2026-10-21T14-23-34-035Z-6c0408` |
| Tests | 57/57 passing |
| Git | repo initialized, **no commits**; everything is untracked |

Latest real-world validation (from that run):

- A canvas whack-a-dot game (`mouseaccuracy.com/game`): 5 turns, 88 tool calls,
  **46 `browser_click_at` calls, zero errors, every one reported a pixel change**
  (e.g. `trusted input · pixels-changed 3.1% · click 439ms`).
- A Google Docs document: `browser_click_at` into the canvas, then label-based
  `browser_click` / `browser_hover` through the menus.
- Turn times 41–53 s for 11–24 tool calls; model-latency bound.
- One `PROTECTED_PAGE` error when the active tab was a browser-internal page.

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
2. **The model never gets arbitrary DOM automation.** It has exactly nine
   browser tools; every action is a labelled element or an explicit coordinate.
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
11. **Speed rule:** every browser action returns a fresh labeled view, so the
    model never needs a separate screenshot round trip. Avoid extra model
    steps; each one costs ~1.5–3 s.
12. **Log redaction:** pairing token, API keys, `Bearer`, secret-named fields,
    sensitive query params, inline base64. Page text, screenshots, and reasoning
    are **not** redacted. Review bundles before sharing.

---

## 5. Capabilities (nine model-visible tools)

| Tool | What it does | Notes |
|---|---|---|
| `browser_screenshot` | View with tab/viewport/scroll metadata, numbered labels, surface list | `detail:"high"` uses 2048 px width |
| `browser_click` | Click a labelled element | DOM, open shadow roots, iframes. Returns `changed` + signals + fresh view |
| `browser_click_at` | Click screenshot pixels or CSS coordinates | Canvas/video/iframe. Trusted input + pixel diff |
| `browser_hover` | Hover a labelled element | Reveals hover-only menus/tooltips |
| `browser_select_option` | Choose a native `<select>` option | Sets value, fires `input`/`change` |
| `browser_read_text` | Rendered text | `page`/`viewport`, `offset`, `max_chars`; ~4 ms on fixtures |
| `browser_scroll` | Scroll + fresh view | DOM scroll first, trusted wheel fallback (`wheel:true`), optional `at_x`/`at_y` |
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
- **Change signals for DOM clicks:** `url-change`, `title-change`,
  `scroll-change`, `text-change`, `dialog-change`, `dom-mutations:N`, `checked`,
  `aria-expanded`, `aria-selected`. A no-op returns **NO VISIBLE CHANGE**.
- **Reasoning auto policy:** navigation → `off`; inspect/synthesis → `low`.
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
| `lib/index.js` (~979 lines) | Plugin: bridge client (`tools` role), `registerTools` (~595), guidance, `apply` (~800), activity frames (`activityFromFrame` ~343), `formatView` (~437), click/click_at/select/hover content, reasoning policy + image budget hooks, `llm/stream` is intentionally **not** used |
| `lib/reasoning.js` | `classifyPrompt`, `autoEffort`, `effortFor` (navigation/inspect/synthesize) |
| `lib/image-budget.js` | `planImageOffload` pure planner |
| `test/*.test.mjs` | 9 tools, label prompts, activity forwarding, reasoning, image budget |

### Extension (`extension/`)

| File | Responsibility |
|---|---|
| `manifest.json` | MV3, side panel, permissions above, `<all_urls>` |
| `sidepanel/browser.js` (~1700 lines) | Browser executor. Key functions: `withDebugger` (~192), `diffRegion` (~288), `runInFrame` (~318), `labelAllFrames` (~358), `labelPage` (~436), `selectOption` (~671), `hoverLabelled` (~709), `clickLabelled` (~743), `scrollPage` (~897), `snapshot` (~1143), `scroll` (~1217), `clickAt` (~1542), `click` (~1599), `execute` (~1682) |
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
- `e2e/fixtures/` — `click.html`, `canvas.html`, `advanced.html`,
  `frame-inner.html`, `article.html`, `second.html`, `many.html`.

---

## 7. Test inventory

`npm test` = 57 tests:

- `companion/test/`: bridge (7), prompt (9), log store (2), credentials (2),
  openrouter (5).
- `extension/test/`: helpers (3), logger (4), tab match (5).
- `packages/dsh-browser-extension/test/`: tools (11), reasoning (5),
  image budget (4).

E2E suites (not in `npm test`): `edge-click-e2e.mjs` (9 behaviours),
`edge-canvas-e2e.mjs` (surfaces, trusted click, image mapping, pixel diff,
wheel, no-op), `edge-advanced-e2e.mjs` (shadow DOM, same/cross-origin iframes,
select, hover).

---

## 8. Known gaps / next steps, in suggested order

1. **Typing and keys** — biggest missing capability. Canvas editors (Google
   Docs), search boxes, forms. Suggested: `browser_type({label?, text})` for
   inputs/contenteditable via DOM value + `input` events, plus trusted
   `Input.insertText` / `Input.dispatchKeyEvent` via the existing debugger path
   for canvas editors; `browser_press_key({key, modifiers})`.
2. **Fast/batch canvas clicking** — a game turn used 46 `click_at` calls at
   ~439 ms each. Options: accept multiple points in one call, or a
   `skip_view`/`fast` flag that returns only the diff, cutting a model round
   trip out of rapid sequences.
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
9. **Click outcome logging** — `browser.command.result` in `events.jsonl` lacks
   `changed`/`pixelsChanged`/`clicked`; those are visible in `tool.result` text
   but not structured. Add them to the extension's logger call.
10. **Closed shadow roots / sandboxed frames / built-in PDF viewer** — not
    injectable. PDF.js pages (canvas) do work via `click_at`.
11. **Reliability polish** — debugger banner flashes per trusted action;
    DevTools open blocks trusted input. Consider a persistent attach during a
    turn (banner stays) or a settings toggle.
12. **Commit the repo** — it has no commits. Make an initial commit before
    further work so changes are reviewable.

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
| Edge e2e CDP | 9228 click, 9230 canvas, 9231 advanced |
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
- Clicking can submit forms or trigger page actions. Only visible/labelled or
  explicit coordinates are clickable; there is no typing yet.
- Debug bundles contain page content and screenshots; redaction covers tokens,
  keys, and secret-shaped values only.
- `logs/`, `.dsh-home/`, `.env*`, `node_modules/`, `dist/`, `release/` are
  gitignored.

---

## 13. Suggested resume sequence

1. `cd /home/conan/Documents/GitHub/crazyAgent`
2. `curl -s http://127.0.0.1:17871/health` — expect `tools:true`.
3. `npm test` — expect 57 passing.
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

---

## 14. Open questions for the user

- Which comes first: typing/keyboard, drag, or file upload?
- Is the debugger banner acceptable, or should trusted input be opt-in per tab?
- Should reasoning `auto` be tuned (e.g. `off` for short inspect prompts) using
  real `reasoning.policy` data?
- Is the built-in PDF viewer / browser-internal pages worth supporting through a
  separate path, or explicitly out of scope?