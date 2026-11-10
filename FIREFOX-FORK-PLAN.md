# crazyAgent → Firefox: fork & port plan

**Status:** plan only — no product code has been changed for the port. Date 2026-11-04.
**Baselines:** Firefox **159.0.1** (ESR 153.6.0, Beta 160.0b4, Nightly 161.0a1), Chrome **157** (148 is only where Chrome gained the `browser.*` alias), DSH 0.2.1-rc.2, repo at commit `3f02fc8` + uncommitted pre-port work.
**Evidence base:** `research/firefox-trusted-input.md`, `research/firefox-feature-matrix.md`, `research/firefox-port-inventory.md`, `firefox-port-audit.md` (superseded), `HANDOFF.md`, `AGENTS.md`, direct code inspection.

---

## 0. Executive summary

**Yes — feasible, and the port is much smaller than the 29k-line extension suggests.** The agent's DOM layer (`browser.scripting`), tab/places/downloads layer, and all bridge/DSH plumbing are already portable: BCD confirms Firefox has `scripting.executeScript` (102+, MAIN world 128+), `webNavigation.getAllFrames` (47+), `tabs.captureVisibleTab` (47+), `downloads`, `history`, `bookmarks`, `topSites` (52+), `storage.session` (115+). Labelled DOM clicks, hover, select-option, scroll and text extraction are **synthetic DOM paths today**, so they carry over unchanged.

Of **126 lexical `chrome.*` occurrences**, only **103 are runtime call sites** and only **40 are Chrome-only APIs** (39 `chrome.debugger.*` + 1 `chrome.sidePanel.*`). The port is concentrated in **five seams**:

| Seam | What it is | Size |
|---|---|---|
| **1. Trusted transport** | `chrome.debugger` does not exist in Firefox. 32 `sendCommand` sites across **12 distinct CDP commands** must be served by a **companion-owned WebDriver BiDi session** against Firefox started with `--remote-debugging-port`; the extension keeps its CDP vocabulary and a translation shim implements it. | New companion module set + mechanical call-site swap (~1.2–1.8k new LOC, ~60 changed lines) |
| **2. Namespace/promise adapter** | 60 of the 103 runtime call sites `await chrome.*` (or `.then`), but Firefox's `chrome.*` namespace is callback-style; only `browser.*` returns promises. 22 listener registrations are compatible; `runtime.onMessage`'s `sendResponse`/`return true` pattern needs a small wrapper. | ~30-line adapter + mechanical import, preserves the existing test `globalThis.chrome` stub |
| **3. UI shell** | `sidePanel` → `sidebar_action`; MV3 service worker → event page; `minimum_chrome_version` → `browser_specific_settings.gecko`. | ~500 LOC touched |
| **4. Launch/ownership story** | Firefox's Remote Agent starts **only** from a command-line flag, admits **one** BiDi session, and a profile cannot be open twice. This is a product decision, not a protocol detail. | Launcher + docs + install flow |
| **5. Two hard gaps** | `Input.insertText` has **no BiDi equivalent** (Docs bulk typing), and full-page/region screenshot semantics differ; Firefox's `captureScreenshot origin:"document"` and `input.setFiles` actually *remove* three CDP hacks. | Resolved by spike S1, not by design |

**Delivery shape.** Fork the repo as its own repository (`crazyAgent-firefox`, `upstream` remote kept), keep one cross-platform codebase internally (Firefox is the default build, Chrome stays buildable), port platform-neutrally, then add the Firefox-only capabilities that Chromium cannot match (containers, point-at-element targeting, native find, network evidence, per-tab durable memory).

**Effort.** Two go/no-go spikes (~3 days) → parity **M1–M5 ≈ 19–27 agent-days** single-track (≈3 weeks with 2–3 parallel agents); Firefox-only capabilities **M6** another ~2–3 weeks; packaging **M7** ~2–3 days.

**Non-goals.** Do not fork DSH core (`AGENTS.md` safety rule). Do not build OS-level input injection. Do not maintain Chrome feature parity beyond "still builds and tests green". No Firefox Android.

---

## 1. Why the port is tractable — verified dependency inventory

### 1.1 Chrome APIs used by production code, and their Firefox status

`research/firefox-port-inventory.md` §0.1 counts **126 lexical `chrome.*` occurrences → 103 runtime call sites**, of which **40 are Chrome-only** (39 `chrome.debugger.*`, 1 `chrome.sidePanel.*`), **60 are promise-style** and **22 are listener registrations**. The per-API counts below are lexical occurrences from `grep`. Firefox version = BCD `version_added` (fetched 2026-11-04).

| Chrome API | Uses | Firefox | Action |
|---|---|---|---|
| `chrome.scripting.executeScript` | 58 | 102+ (`world` 102, `ExecutionWorld.MAIN` 128, `allFrames` supported) | unchanged; alias namespace |
| `chrome.tabs.update` | 34 | ✅ 45+ (promises via `browser.*`) | unchanged |
| `chrome.debugger.*` | **39 refs / 32 `sendCommand` sites / 12 commands** | ❌ none | **Seam 1** |
| `chrome.tabs.query/get/create/remove/reload/goBack/goForward/onUpdated/onActivated/onRemoved` | ~75 | ✅ all present | unchanged |
| `chrome.storage.local/session` | 16 | ✅ `local` 45+, `session` 115+ (trusted contexts only — sufficient) | unchanged; check `setAccessLevel` use |
| `chrome.windows.getCurrent/getLastFocused/onFocusChanged/update` | 6 | ✅ 45+ | unchanged |
| `chrome.downloads.download/search/cancel/onCreated/onChanged` | 6 | ✅ 47+ | unchanged API; **Firefox's download dir may differ from `~/Downloads`** — set `CRAZYAGENT_DOWNLOADS_DIR` to `browser.download.dir`; `DownloadItem.finalUrl` absent |
| `chrome.webNavigation.getAllFrames` | 2 | ✅ 47+ (`errorOccurred` caveat) | unchanged |
| `chrome.bookmarks.*`, `chrome.history.*`, `chrome.topSites` | 3 | ✅ 47+/49+/52+ | unchanged; `history.typedCount` absent (already guarded); `bookmarks.search` semantics differ |
| `chrome.tabs.captureVisibleTab` | 1 | ✅ 47+ (`<all_urls>` or `activeTab` from 126) | keep as viewport path; verify JPEG `quality` handling |
| `chrome.sidePanel.setPanelBehavior` | 1 | ❌ (different API) | **Seam 3** → `sidebar_action` |
| `chrome.action.setBadge*` | 2 | ✅ | unchanged |
| `chrome.runtime.*` (onMessage/onInstalled/getManifest/sendMessage) | ~6 | ✅ but **callback-vs-promise + `sendResponse`/`return true` differ** | **Seam 2** (small wrapper) |
| `navigator.clipboard` (panel) | ~6 | ✅ but focus/gesture rules differ in a sidebar | verify in M4, fallbacks planned |
| `background.service_worker` | manifest | ❌ MV3 uses event page (`background.scripts`) | **Seam 3** |

> The test suite stubs `globalThis.chrome`, so the namespace adapter (`globalThis.browser ?? globalThis.chrome`) must be a lazy lookup to keep all 27 existing extension test files green without edits.

### 1.2 The exact `chrome.debugger` surface (what Seam 1 must serve)

Inventory §1.4: **32 `sendCommand` sites / 12 distinct commands** plus **7 session sites** (`attach` 1, `detach` 1, `onDetach` 3, `onEvent` 2); `withDebugger` has **14 callers**.

| CDP command | Sites | Powers | BiDi replacement | Parity |
|---|---|---|---|---|
| `Input.dispatchMouseEvent` | 14 | click/click_at/role click/hover-move/drag | `input.performActions` pointer actions | good |
| `Input.dispatchKeyEvent` | 2 (+ synthetic fallback) | Enter/Tab/Escape/arrows/chords/Docs keys | `input.performActions` key actions | good |
| `Input.insertText` | 6 | **bulk text into fields/contenteditable/Docs canvas** | **none** | **gap** |
| `Page.captureScreenshot` (+`clip`, beyond-viewport) | 1 | full-page & region captures | `browsingContext.captureScreenshot` with `origin:"document"` / `clip` | better for full page |
| `Page.getLayoutMetrics` | 1 | full-page size | `script.evaluate` (or drop) | convenience loss |
| `Emulation.setDeviceMetricsOverride`/`clear` | 2 | tall viewport for full-page capture | `browsingContext.setViewport` (or drop, use `origin:"document"`) | removable |
| `Page.handleJavaScriptDialog` | 2 | dialog accept/dismiss/prompt | `browsingContext.handleUserPrompt` | good |
| `Page.enable` + `Page.javascriptDialogOpening/Closed` | 4 (1 enable + 2 event + 1 watch) | dialog state machine | `userPromptOpened`/`userPromptClosed` + `session.subscribe` | good (+ no per-tab attach) |
| `DOM.enable` + `DOM.getDocument` (depth -1, pierce) | 2 | find tokenised file input | `script.evaluate` shadow-root walker → `sharedId` | redesign (small) |
| `DOM.setFileInputFiles` | 1 | file upload | `input.setFiles` (path resolved by Firefox process) | good; `input`/`change` events `isTrusted:false` |

**Design consequence:** keep the **CDP method vocabulary as the extension's internal contract**, and implement CDP→BiDi translation **once**, in the companion. Then 30 of the 32 call sites are mechanical renames (`chrome.debugger.sendCommand({tabId}, 'X', p)` → `trusted.command(tabId,'X',p)`), `browser.js`'s ~10k lines of labels/coordinates/guards/Docs choreography stay intact, and the Chrome backend remains a drop-in fallback (`trusted-cdp.js`). The two non-mechanical paths are the upload finder and the dialog event wiring.

### 1.3 Tool-by-tool portability (32 model-facing tools)

Classification per `research/firefox-port-inventory.md` §5 (counts: **PORTABLE 15 · NEEDS-TRUSTED-INPUT 14 · NEEDS-REDESIGN 3 · UNSUPPORTED 0**):

| Class | Tools | What it means / notes |
|---|---|---|
| **PORTABLE (15)** | `browser_scroll`, `browser_click`, `browser_select_option`, `browser_hover`, `browser_read_text`, `browser_find`, `browser_tabs`, `browser_places`, `browser_switch_tab`, `browser_downloads`, `browser_download`, `browser_navigate`, `browser_wait_for`, `browser_batch`, `browser_docs_read` | Labelled clicks/hover/select/scroll are already synthetic in-page; docs_read is scripting + extension fetch. `browser_navigate` loses only the `beforeunload` guard (moves to the dialog redesign). |
| **NEEDS-TRUSTED-INPUT (14)** | `browser_click_at`, `browser_click_role`, `browser_select`, `browser_press_key`, `browser_type` (unlabelled/canvas path), `browser_table` (writes), `browser_clipboard` (paste/rich-paste), 7 Docs writers (`rename`, `replace`, `page_setup`, `write`, `table`, `select_text`, `format`) | All have DOM/synthetic fallbacks that are **not acceptance-grade** for canvas/Docs; they gate on Seam 1 and fail closed without it. |
| **NEEDS-REDESIGN (3)** | `browser_screenshot` (full-page/region), `browser_upload`, `browser_dialog` | New mechanism + new acceptance tests; viewport screenshot stays portable via `captureVisibleTab`. |
| **UNSUPPORTED (0)** | — | Nothing in the current tool set is unreachable **with** the BiDi companion; without it, the 14 trusted tools and the 3 redesigns degrade to documented blockers. |

---

## 2. Target architecture

```
┌──────────────────────────── Firefox 159 ──────────────────────────────────┐
│  sidebar_action panel (extension/sidepanel, same app.js UI)                │
│    DOM observation / labels / views   →  browser.scripting                │
│    tab/window/downloads/places        →  browser.tabs/downloads/history…   │
│    trusted.* commands                 →  bridge frames (existing WS)      │
└───────────────────────────────▲───────────────────────────────────────────┘
                                │ loopback WS bridge (companion/bridge.mjs)
┌───────────────────────────────┴────────────────── companion (Node) ───────┐
│  Bridge (ui/tools roles, unchanged)                                       │
│  FirefoxLauncher   launch profile + --remote-debugging-port=0, discover    │
│  BidiClient        ONE session: session.new, subscribe, command routing   │
│  TabMap            tabId/frameId ↔ browsingContext id (token handshake)   │
│  DialogHub         userPromptOpened/Closed → Page.javascriptDialog* shape │
│  TrustedExec       CDP-name → BiDi translation table (12 commands)       │
└───────────────────────────────▲───────────────────────────────────────────┘
                                │ WebDriver BiDi (W3C) ws://127.0.0.1:<port>/session
                ┌───────────────┴────────────────┐
                │ Firefox Remote Agent           │  flag-only start, loopback,
                │ (all release channels)         │  no auth, one session
                └────────────────────────────────┘
```

### 2.1 The seam in the extension (minimal-diff rule)

Two small modules carry the platform seam:

* `extension/sidepanel/platform/runtime.js` — lazy `globalThis.browser ?? globalThis.chrome` adapter for the 60 promise-style call sites, plus an `onMessage` wrapper that normalises Firefox's promise-returning listener and Chrome's `sendResponse`/`return true` pattern. Lazy lookup keeps the existing `globalThis.chrome` test stub working unchanged.
* `extension/sidepanel/trusted.js` (≈250 LOC) — the CDP-shaped trusted-transport contract:

```js
// Same CDP-shaped contract used everywhere today.
export async function command(tabId, method, params) // → backend
export async function capture(tabId, params)        // → Page.captureScreenshot
export async function captureVisible(tabId, opts)   // → tabs.captureVisibleTab | BiDi
export async function setFiles(tabId, token, path)  // → CDP DOM | BiDi setFiles
export function onEvent(handler)                    // → Page.* dialog events
export function setBackend(backend)                 // wired by app.js after bridge connect
export function unavailable()                       // typed TRUSTED_UNAVAILABLE
```

* Backends: `trusted-cdp.js` (Chrome — today's `chrome.debugger` behaviour, kept for the Chrome build and for tests) and `trusted-bridge.js` (Firefox — sends/receives frames over the existing bridge).
* Mechanical edit: every `chrome.debugger.sendCommand({tabId}, 'X', p)` → `trusted.command(tabId, 'X', p)` (32 sites, 2 files), `withDebugger`/`beginDebuggerRun`/`endDebuggerRun` → `trusted.withTurn`/`beginTurn`/`endTurn` (same lease/cleanup semantics; BiDi has no attach banner, so begin/end become "start/stop accepting trusted ops for this turn").
* `DialogManager` keeps its exact state machine: `trusted.onEvent` re-emits CDP-shaped `(source, 'Page.javascriptDialogOpening', params)` frames from the companion.
* `capturePageImage` stays byte-for-byte: the shim implements `Page.getLayoutMetrics` via `script.evaluate` and makes `Emulation.setDeviceMetricsOverride/Clear` no-ops, while `Page.captureScreenshot` maps to `browsingContext.captureScreenshot` (`origin:"document"` for full page, `clip` for region). The existing scroll-restore code then runs harmlessly.
* `setFileInputByToken` is rewritten to `trusted.setFiles(tabId, token, path)`; the companion resolves the tokenised element by walking open shadow roots via `script.evaluate` in the tab's candidate contexts, then calls `input.setFiles`.

### 2.2 Companion↔panel frames (additive; bump `PROTOCOL_VERSION`)

| Frame | Direction | Purpose |
|---|---|---|
| `trusted.command` / `trusted.result` | panel → companion → panel | one CDP-shaped trusted op (`method`, `params`, correlated id) |
| `trusted.setFiles` | panel → companion | token + absolute path (Downloads-confined) |
| `trusted.begin` / `trusted.end` | panel → companion | turn lease; enables/clears the trusted session scope |
| `tab.tag` | panel → companion | MAIN-world token handshake for TabMap |
| `event: dialog.opened / dialog.closed` | companion → panel | native dialog state |
| `event: trusted.unavailable` | companion → panel | no BiDi session → extension must **fail closed** for mutations, never synthesize |

### 2.3 Tab / frame correlation (no URL matching for mutations)

1. Panel tags the tab: `scripting.executeScript({target:{tabId}, world:'MAIN'}, setToken, [nonce])` → `document.documentElement.dataset.__crazyagentTab = nonce`.
2. Companion walks `browsingContext.getTree` candidates and `script.evaluate`s a read of that dataset attribute; exactly one match → cache `tabId → contextId` (plus frame contexts discovered through `getTree` children, keyed by the panel's `frameId` where possible).
3. Invalidate on `contextDestroyed` / `navigationCommitted`; refresh lazily on cache miss. Never fall back to URL/title matching for writes (display-only).
4. Before pointer input on a non-active tab: `browsingContext.activate` (mirrors today's tab activation; background-tab delivery is unverified on 159).

### 2.4 Failure semantics (preserved from the invariants)

* Trusted unavailable ⇒ typed `TRUSTED_UNAVAILABLE` (retryable guidance), mutations fail **before** any side effect, never a silent synthetic fallback (the repo already treats synthetic clicks as UI hints only — that rule is now architectural).
* Single-session contention (another tool holds the one BiDi session) ⇒ explicit blocker surfaced to the model, not a retry loop.
* Dialog races keep the existing `DIALOG_PENDING` + 2s auto-accept timeout contract.
* Stale view / ambiguity / wrong-target guards are untouched — they live above the transport.

---

## 3. Fork mechanics

### 3.1 Freeze and fork

1. `npm test` on the current tree; record the baseline (recorded: 572/572; re-run and record actual).
2. Commit the uncommitted pre-port work on `main` (16 modified + 10 untracked files, incl. this plan and `research/`); tag `pre-firefox-baseline`.
3. Create the fork repo **`crazyAgent-firefox`** (GitHub `conan-8/crazyAgent-firefox` if available; otherwise local `../crazyAgent-firefox` clone), then:
   ```sh
   git remote rename origin upstream      # keep cherry-picks from Chrome
   git remote add origin <firefox repo>
   git checkout -b firefox-main           # product branch
   ```
4. Keep `upstream/main` as a read-only mirror; `docs/UPSTREAM.md` records the divergence policy below.

### 3.2 File ownership policy (keeps upstream merges cheap)

| Class | Files | Rule |
|---|---|---|
| **Shared** | `extension/sidepanel/browser.js`, `docs-*.js`, `find.js`, `table.js`, `files.js`, `capture.js`, `role-click.js`, `app.js`, `companion/bridge.mjs`, `companion/index.mjs`, `packages/dsh-browser-extension/lib/*`, `extension/test/*`, `packages/*/test/*` | Only **additive/mechanical** edits; mark each with `// [ff]`. Executor semantics, guards, and tests must stay identical, so upstream fixes cherry-pick cleanly. |
| **Fork-owned** | `extension/manifest.firefox.json`, `extension/background.js`, new `extension/sidepanel/trusted*.js`, `extension/sidepanel/platform/*`, `companion/firefox/*`, `scripts/firefox-*`, `config/*` (persona), docs | Free to diverge. |
| **Generated** | `dist/firefox/`, `dist/chrome/` | Build output, git-ignored. |

Merge ritual: quarterly `git fetch upstream && git merge upstream/main`; conflicts should be limited to `[ff]` hunks; run `npm test` + Firefox fixture suites afterwards.

### 3.3 Build targets and manifest

* `scripts/build.mjs --target firefox|chrome` assembles `dist/<target>/`: copies `extension/`, injects the target manifest (`.firefox.json` / existing Chrome one), optionally stamps version.
* Firefox manifest essentials: `manifest_version: 3`; `background: {scripts:["background.js"], type:"module"}` **plus** `service_worker` for the Chrome build; `sidebar_action` (`default_panel: "sidepanel/index.html"`, icon, title); permissions: drop `sidePanel`/`debugger`, add `sessions`, later `contextualIdentities`/`cookies`/`find`/`webRequest*`/`menus`/`tabHide`/`search`/`browserSettings` as features land; `browser_specific_settings.gecko: {id:"crazyagent@conan-8.github.io", strict_min_version:"141.0"}`; host `<all_urls>`.
* Firefox MV3 specifics: `persistent` is invalid; event page only; sidebar owns the WebSocket (so no keepalive problem — this architecture already keeps the WS in the panel document).
* Distribution path: dev/alpha = temporary install via BiDi `webExtension.install({extensionData:{type:"path", path}})` on every launch; beta = signed **unlisted AMO** XPI + `moz:permanent` install; AMO requires `browser_specific_settings.gecko.data_collection_permissions` (FF 140+) because page text/screenshots/prompts go to a remote model — this must be declared truthfully, not deferred.

### 3.4 Docs to update in the same change (contract rule)

`AGENTS.md` (platform section, invariant 4 becomes transport-neutral, new acceptance gates), `HANDOFF.md` (architecture, file map, run/verify), `HANDOFF-QUICK.md`, `README.md` (requirements/quick start), `PRIVACY.md` (Firefox Remote Agent, local debug port, dedicated profile), `e2e/checklist.md` (Firefox scenario list), plus new `docs/FIREFOX.md` (launch/install/troubleshooting).

---

## 4. Milestones

Every milestone has an **exit gate** (independent check, not a tool's own success claim, per `AGENTS.md`). Effort in agent-days.

### M0 — Freeze, fork, and two go/no-go spikes (2–3 d) 🚦

* **M0.1** Baseline: `npm test`, prompt composition, commit, tag.
* **M0.2** Fork repo + branch + `docs/UPSTREAM.md`.
* **M0.3 Spike S1 — BiDi trusted input (the port's go/no-go).** Disposable profile; Firefox `--remote-debugging-port=0 --profile /tmp/ca-ff --new-instance`; prototype client + fixture page. Probe and record: `isTrusted` for click/key/dblclick/drag/beforeinput; background-tab input; `captureScreenshot` viewport/`origin:"document"`/`clip`; `userPromptOpened`/`handleUserPrompt` incl. `beforeunload`; `input.setFiles` on hidden/visible/shadow/frame inputs; typing 200 chars by (a) per-key actions, (b) multi-char `text`, (c) clipboard+trusted Ctrl+V; **Docs caret typing on a disposable doc** with each method.
  **GO** if: click/key/drag are trusted and delivered, screenshot + dialog + setFiles work, and Docs caret typing works by at least one method with acceptable latency. **NO-GO/reshape** if Docs typing cannot be made reliable (then the fork ships as "general browsing agent; Docs unsupported").
* **M0.4 Spike S2 — Firefox-only wins:** containers round-trip on a clean profile, `sessions.setTabValue` survive close→restore, native `find` counts/rects, `tabs.captureTab` on a background tab, viewport screenshot inside a sidebar document.
* **Exit:** `docs/firefox-bidi-baseline.json` (version-pinned probe results), GO memo, fork repo with green baseline.

### M1 — Platform seam + Firefox shell (3–4 d)

`platform/runtime.js` namespace/promise adapter for the **60 promise-style call sites**, `onMessage` wrapper, Firefox manifest, background event page + sidebar toggle/badge, sidebar layout fixes, build script, and the entire `npm test` suite still green against the existing chrome mock (target: zero test-file edits).
**Exit:** Firefox loads the extension, opens the sidebar, connects to the companion (`/health` `ui:true`), and read-only ops (`browser_tabs`, `browser_read_text`, `browser_navigate`) pass in the Firefox fixture harness.

### M2 — Observation parity (2–3 d)

Views/labels/read_text/find/table/places/downloads-list + viewport screenshots + image pipeline on Firefox; Firefox fixture observe suite; visual verdict from the user on one real page.
**Exit:** observe fixture suite passes with independent page-state checks; no trusted op required.

### M3 — Trusted transport (5–7 d, critical path)

Companion: `firefox/launch.mjs`, `bidi.mjs` (session.new/status/subscribe/reconnect, one owner), `tab-map.mjs`, `dialog-hub.mjs`, `cdp-shim.mjs` (**12 commands + 2 DOM replacements**), new bridge frames + protocol version bump. Extension: `trusted.js` + two backends, **32-site swap (30 mechanical + upload/dialog wiring)**, `withTurn` lease.
**Exit:** Firefox fixture trusted suites pass with independent inspection — click_at, select/drag, press_key, type (caret + field), scroll fallback, dialog accept/dismiss/prompt/beforeunload, upload assign + File readback, full-page/region screenshots; translation unit tests run against a fake BiDi server with golden frames; `trusted.unavailable` fails closed.

### M4 — Files, clipboard, downloads (3–4 d)

Downloads parity (`browser_download` direct/link/dynamic + collision-safe naming; Firefox download-dir/`conflictAction`/`filename` nuances — `CRAZYAGENT_DOWNLOADS_DIR` must match `browser.download.dir`), upload end-to-end using BiDi `input.setFiles` as the primary path (path resolved by the Firefox process; hidden/visible/shadow/frame inputs, exact alternatives on failure) with a tier-2 fallback of companion-streamed file bytes → in-page `DataTransfer` assignment when paths are not mutually visible, clipboard text/image read/write with sidebar focus rules and trusted Ctrl+V paste, system-clipboard fallbacks.
**Exit:** a Firefox port of `scripts/edge-files-e2e.mjs`: direct/link/dynamic downloads, ambiguity refusal, hidden/visible/shadow/frame attachment, independent multipart **received bytes** check; clipboard fixture with image and text round-trips.

### M5 — Docs parity (4–6 d, hardest acceptance)

Authenticated isolated profile; Docs export fetch verified under Firefox cookie partitioning (fallback: fetch via content script inside the Docs tab, same-origin); 8 Docs tools re-accepted on live Docs with export verification, collateral checks, counters, stale-tab guards; typed-text strategy per S1 (per-key default; clipboard-paste mode for canvas when measured better); Find flows through trusted keys.
**Exit:** port of `edge-docs-table-e2e.mjs` passes (create/format/structure/delete + independent export + reload persistence), then the fresh-document medium-effort real-sidebar scenarios from `e2e/checklist.md` with independent inspection. Record steps/calls/retries/wrong targets even when repaired.

### M6 — Firefox-only capabilities (2–3 weeks, after parity)

Phased, each independently gated; parity remains the ship bar.
1. Per-tab durable memory (`sessions.*TabValue`, S) — resume hints after close/restore.
2. Native `find` fast path + highlight evidence (`find` API, S/M).
3. **Point-at-element** targeting (`menus.getTargetElement`/`onShown`/`overrideContext`, M) — right-click → exact anchor for `browser_click`.
4. **Containers** (`contextualIdentities`+`cookieStoreId`, L) — multi-account isolation and agent sandboxing; new `browser_containers`, container-aware tabs.
5. **Network evidence + deterministic mocks** (blocking `webRequest` + `filterResponseData`, L) — new `browser_network`; the first real answer to "readback is not server-persistence evidence".
6. Reader-mode text scope (M); batch of cheap wins (`tabs.warmup`, `Tab.attention`, `sessions.forgetClosedTab`, `captureTab` background views, `captureVisibleTab` confirmations); `trial.ml` local summarization (M, optional, Nightly/Beta-gated so feature-detected).
**Exit per feature:** new tool/scope + guidance + tests + a documented acceptance check; no weakening of existing guards.

### M7 — Packaging and operations (2–3 d)

Signed unlisted XPI + `moz:permanent` install; launcher for Linux/macOS/Windows (`Agent Firefox` desktop entry) with port discovery/health; settings for profile mode; troubleshooting (Firefox already running, port in use, single-session contention, extension reload); privacy docs; versioning (`0.2.0-firefox`).

**Parallelization:** M1 can start while S1 runs (different files); M2 splits into independent packages (views/find/table/places/capture); M3 is one owner; M4 depends on M3; M5 depends on M3+M4; M6 work packages are independent once M5 lands.

---

## 5. Test & acceptance strategy

1. **Unit/integration (no browser):** `npm test` must stay green throughout. Add: shim tests, CDP→BiDi translation golden tests (fake BiDi WS server), protocol frame tests, `trusted.unavailable` fail-closed tests. No live model in unit tests.
2. **Firefox fixture harness** `scripts/firefox-harness.mjs`: disposable profile + `--remote-debugging-port=0`, install the extension via BiDi `webExtension.install`, open `moz-extension://<uuid>/sidepanel/index.html` **as a tab** (sidebar documents are not addressable BiDi contexts), drive it with `script.evaluate` — the Firefox equivalent of today's `edge-*.mjs` CDP harness. Fixture server stays on `127.0.0.1:17872`.
3. **Capability probe** `scripts/firefox-bidi-probe.mjs`: records trusted-input/screenshot/dialog/upload/typing results on the pinned Firefox version into `docs/firefox-bidi-baseline.json`; re-run on Firefox upgrades. This is the regression gate for "BCD says supported ≠ runtime works".
4. **Real-sidebar acceptance:** Firefox variants of `e2e/checklist.md`; fixed model + medium effort; independent final-state inspection (document/DOM/file bytes), not tool status or `turn.ok`; record wall time, model steps, tool calls, failures, retries, wrong targets, collateral.
5. **Docs acceptance:** authenticated **isolated** profile only; export-verified; never promote fixture/unit results to live acceptance.
6. **Process hygiene:** only PIDs/PGIDs started by the harness; never kill browsers by executable path; isolated profiles for every model-spending run.

---

## 6. Risk register (with kill criteria)

| # | Risk | L | I | Mitigation / decision point |
|---|---|---|---|---|
| R1 | `insertText` gap makes Docs canvas typing unreliable → 8 tools + the product's flagship Docs story fail | H | H | S1 measures 3 strategies incl. clipboard-paste; **kill criterion**: if Docs caret typing cannot pass a 20-edit scenario reproducibly, descope Docs for the Firefox fork v1 (document as unsupported) rather than ship a flaky editor |
| R2 | Only one BiDi session; another tool/panel reload/companion restart steals it | M | H | companion is sole owner for Firefox's lifetime; reconnect + explicit blocker; harness never opens a second session |
| R3 | Launch/ownership friction (flag-only, single instance, profile conflict) kills UX | H | H | decision D2; launcher + "restart Firefox in agent mode" flow; dedicated profile option; track Nightly dynamic-start+prompt as the future no-restart path |
| R4 | Runtime `isTrusted`/activation semantics differ from CDP in edge cases | M | H | S1 probe matrix (click/key/dblclick/beforeinput/selection/upload/dialog); gate M3 exit on results |
| R5 | Background-tab pointer input unreliable | M | M | `browsingContext.activate` before pointer ops (same as today's tab activation) |
| R6 | Dialog races differ (beforeunload partial) | M | M | port `DialogManager` unchanged on BiDi events; explicit pending-dialog errors |
| R7 | Screenshot diffs (tall pages, DPR, scrollbar, JPEG) | M | M | `origin:"document"` + existing size guards; compare fixture baselines; keep `captureVisibleTab` for viewport |
| R8 | Clipboard write from an unfocused sidebar | M | M | test early in M4; `clipboard.setImageData` for images; trusted Ctrl+V for paste; document required user gesture if unavoidable |
| R9 | Docs export fetch breaks under Firefox cookie partitioning | M | H | content-script same-origin fetch fallback inside the Docs tab; acceptance with authenticated isolated profile |
| R10 | Local debug port unauthenticated | M | H | loopback-only, never `--remote-allow-origins/hosts`, no `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS`, dedicated-profile option, document; adopt connection-prompt when it ships |
| R11 | AMO review friction (`<all_urls>`, `webRequestBlocking`, `trialML`, data-collection declaration) | M | M | unlisted signing for beta; truthful `data_collection_permissions`; feature-gated sensitive permissions |
| R12 | Upstream drift on shared executor files | M | M | shared-file policy + `[ff]` markers + quarterly merge + green suite as merge gate |
| R13 | Firefox event-page suspend while sidebar closed | L | M | WS lives in the sidebar; background only shell/badge; MV2 persistent is a Firefox-only fallback if ever needed |
| R14 | Prompt/guidance still says "Chrome"; capabilities differ | H | L | config persona + `GUIDANCE` rewrite in M1; add Firefox-only tool docs as they land |

---

## 7. Firefox-only vs Chromium-only — plan-level answer

Full detail in `research/firefox-feature-matrix.md` (15 Firefox-only rows, 12 Chromium rows, 21 parity corrections). Summary:

**Firefox-only wins (build after parity, in this order):** containers/multi-account isolation → point-at-element targeting (`menus.getTargetElement`) → native `find` + highlight evidence → blocking `webRequest`/`filterResponseData` network evidence & deterministic mocks → per-tab durable memory → reader mode → `tabs.captureTab`/`tabs.warmup`/`clipboard.setImageData`/`search`/`proxy` and friends.

**Chromium-only losses and how the plan absorbs them:** `chrome.debugger`/CDP → BiDi sidecar (largest work item; no `insertText`, so docs typing is the spike); `sidePanel` per-tab/`getLayout`/`onOpened` → per-window sidebar, gesture-only open; `tabCapture` live MediaStream → still-frame sampling only; Chrome Gemini Nano → `trial.ml` gated/absent on release (feature-detect, never depend); `pageCapture` MHTML → dialog-bound `saveAsPDF`; `identity.getAuthToken`/`tts`/`desktopCapture`/full DNR extras → not used today, documented as UNSUPPORTED.

**Parity corrections that make the port cheaper:** Firefox has `tabs.captureVisibleTab` (47+), `webNavigation.getAllFrames` (47+), `topSites` (52+), `scripting` (102+, MAIN 128+), tab groups (138/139); Chrome 148+ has the `browser.*` alias, so the codebase can be `browser`-first on both engines; MV2 is alive only on Firefox; `userScripts`/`publicSuffix`/`documentId` are parity, not differentiators.

---

## 8. Decisions needed before implementation

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Fork shape: separate repo vs branch | **Separate repo `crazyAgent-firefox`** with `upstream` remote, single cross-platform codebase, Firefox default build (user asked for a fork; upstream stays cherry-pickable). |
| **D2** | Which Firefox/profile does the agent drive? | **Daily profile by default** (product promise: your real logins), launched with `--remote-debugging-port` and a one-click "quit & relaunch" flow; `--isolated` mode for CI/acceptance. Revisit when dynamic-start + connection prompt reaches release. |
| **D3** | `insertText` replacement default | **Per-key actions as the default** (no clipboard mutation, full fidelity); clipboard-paste mode for Docs-class editors only if S1 measures it materially better. |
| **D4** | Scope order | **Parity first (M0–M5)**, Firefox-only features after (M6). Alternative: ship read-only/DOM Firefox agent earlier (M1–M2) as a preview while trusted transport matures. |
| **D5** | Where the fork lives / push access | Confirm GitHub org/repo name and push credentials; otherwise local-only fork + bundle path. |

---

## 9. Immediate next steps (on approval)

1. Approve D1–D5 (D2/D3 can be provisional, finalized by S1).
2. Commit + tag the current tree; create the fork repo and `firefox-main`.
3. Run **Spike S1** (trusted input + Docs typing) and **S2** (Firefox-only wins); publish the baseline JSON and GO/NO-GO memo.
4. Start **M1** in parallel with S1 (manifest/sidebar/shim have no dependency on the spike outcome).
5. Re-run `npm test` after each work package; record acceptance metrics per `AGENTS.md`.