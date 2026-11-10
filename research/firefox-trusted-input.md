# Firefox trusted input & automation transport — research verdict (2026-11-04)

Scope: how a Firefox port of crazyAgent injects **trusted** input, captures screenshots and handles dialogs, given that `chrome.debugger` (CDP) does not exist in Firefox. Plan-only: no browsers were launched, no product code touched, no live-model runs. Every claim carries a URL and a **VERIFIED** (read from a primary source on 2026-11-04) or **UNVERIFIED** (not runtime-tested here / inferred) label.

Baseline check of `firefox-port-audit.md` (line 3): its version numbers are correct, but it stops at “`chrome.debugger` is lost”. It does not evaluate WebDriver BiDi, which is the replacement transport. That gap is this document.

---

## 0. Verdict (TL;DR)

1. **There is exactly one supported trusted-input transport on Firefox 159: WebDriver BiDi (W3C), spoken over a loopback WebSocket from the companion.** Firefox CDP was default-off in 129 and **completely removed in 141** — ESR 140 was the transitional release ([fxdx](https://fxdx.dev/cdp-retirement-in-firefox/), [MDN 141 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141)). **VERIFIED**
2. **Architecture: keep the extension for DOM/labels only; move every operation that needs `isTrusted` to the companion, which owns one BiDi session** and exposes a small `trusted.*` command family over the existing loopback bridge. Do **not** try to connect the side panel to BiDi itself: Firefox rejects WebSocket handshakes that carry an `Origin` header unless explicitly allow-listed, and an extension page always sends one. **VERIFIED** (source: [WebSocketHandshake.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/server/WebSocketHandshake.sys.mjs))
3. **Parity is high for 8 of the 10 CDP methods.** Two real gaps: **`Input.insertText` has no BiDi equivalent** (must be emulated with per-key actions or clipboard-paste), and **`Page.getLayoutMetrics`/`DOM.getDocument` have no protocol command** (both are replaceable with `script.evaluate`, and `captureScreenshot` `origin:"document"` makes the layout-metrics hack unnecessary). **VERIFIED** (BCD/MDN/spec; see §4)
4. **The biggest product blocker is not the protocol — it is process/profile ownership.** The Remote Agent only starts from a command-line flag (`--remote-debugging-port`), there is no runtime opt-in on stable 159, and only **one** BiDi session may exist. Firefox must therefore be launched *by or for* the agent, and the user's daily profile cannot be opened twice. **VERIFIED** (source: [RemoteAgent.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/components/RemoteAgent.sys.mjs), [WebDriverBiDi.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/WebDriverBiDi.sys.mjs), [Security doc](https://firefox-source-docs.mozilla.org/remote/Security.html))
5. **OS-level injection (xdotool/ydotool/CGEvent/SendInput) is feasible only as an unsupported tier-3 fallback** — trusted by definition, but focus-dependent, platform-specific, Wayland-hostile, and unusable in headless/background cases. **VERIFIED** docs; recommendation is our own (**UNVERIFIED** judgement).

---

## 1. Version baseline (2026-11-04)

Source: `https://product-details.mozilla.org/1.0/firefox_versions.json` fetched 2026-11-04. **VERIFIED**

| Channel | Version | Note |
|---|---|---|
| Release | **159.0.1** (released 2026-10-27) | target baseline |
| ESR | **153.6.0esr** | current ESR; 140 ESR (last with CDP) is superseded |
| Beta / DevEdition | **160.0b4** | |
| Nightly | **161.0a1** | next merge 2026-11-05, next release 2026-11-06 |
| MDN BCD | `main` branch fetched 2026-11-04 | used for all `version_added` values below; filenames under [`webdriver/bidi/`](https://github.com/mdn/browser-compat-data/tree/main/webdriver/bidi) |

---

## 2. CDP status (Q5) — gone, not deprecated

| Fact | Evidence | Label |
|---|---|---|
| CDP turned **off by default in Firefox 129**; re-enablable only via `remote.active-protocols` | [fxdx deprecation post](https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/), [MDN 129 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/129) | VERIFIED |
| CDP **removed in Firefox 141**; `remote.active-protocols` pref removed with it | [MDN 141 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141) (bug 1882096), [fxdx](https://fxdx.dev/cdp-retirement-in-firefox/), [Prefs doc](https://firefox-source-docs.mozilla.org/remote/Prefs.html) | VERIFIED |
| Firefox 159 has **no CDP at all**, and no flag/pref brings it back | same sources; remote docs list only Marionette + WebDriver BiDi ([Remote Protocols index](https://firefox-source-docs.mozilla.org/remote/index.html)) | VERIFIED |
| `chrome.debugger` WebExtension API does not exist in Firefox | no `debugger` API in BCD webextensions tree; Firefox WebExtensions API index has no debugger namespace ([BCD webextensions](https://github.com/mdn/browser-compat-data/tree/main/webextensions/api)) | VERIFIED |
| `browser.*` namespace now exists in Chrome too, so namespace is not the porting issue | audit line 52; not re-checked this round | UNVERIFIED (out of scope) |

**Consequence:** the port is not “CDP → whatever”; it is “CDP surface → BiDi surface + extension DOM scripting”. ESR 140 is not an escape hatch (old ESR, not 159).

---

## 3. Enabling BiDi and transport facts (Q2)

| Question | Answer | Evidence | Label |
|---|---|---|---|
| How to start | `firefox --remote-debugging-port [port]`; default 9222; `0` = OS-assigned free port | [MDN Create a BiDi connection](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection); [RemoteAgent.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/components/RemoteAgent.sys.mjs) (`DEFAULT_PORT = 9222`, `port === 0` → atomic bind) | VERIFIED |
| Command-line only? | Yes. “There is no other mechanism for enabling the Remote Agent than by passing a command-line flag.” There is no `remote.enabled` pref that starts it (only unrelated `permissions.manager.remote.enabled`); the task brief’s `remote.enabled` is a **myth** (it appears only in Puppeteer’s vendored prefs list, not in Firefox startup code) | [Security doc](https://firefox-source-docs.mozilla.org/remote/Security.html); Searchfox `remote.enabled` | VERIFIED |
| Restart needed? | Yes, on stable 159: the flag is parsed at `command-line-startup`. A **dynamic runtime start exists but is Nightly-UI only** — see §9 | [RemoteAgent.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/components/RemoteAgent.sys.mjs) (`startAtRuntime`, pref `remote.experimental.dynamicstart.enabled`); [all.js comment](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/all.js) | VERIFIED |
| Works with daily profile? | Yes technically, **but** (a) the same profile cannot be opened by two Firefox instances, and (b) a CLI start applies Firefox’s automation prefs (see next row). Current Firefox also **ignores `-no-remote`** (stripped as unsupported) and offers `--new-instance` | [nsAppRunner.cpp](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/xre/nsAppRunner.cpp) (`--new-instance`, “Strip the now unsupported no-remote”); Puppeteer launches Firefox with `--profile <tmp>` + `--remote-debugging-port=0` ([FirefoxLauncher.ts](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/node/FirefoxLauncher.ts)) | VERIFIED (flags) / UNVERIFIED (exact already-running hand-off behaviour) |
| Side effects on the profile | CLI start ⇒ `isBrowserAutomationRunning=true` ⇒ `RecommendedPreferences.applyPreferences()` runs: auto-update/telemetry/extensions-update disabled, **Safe Browsing off**, **tracking protection off**, `focusmanager.testmode=true`, download panel suppressed, etc. Prefs are set on the **default branch, never written to `prefs.js`**, and effective until shutdown; opt-out is `remote.prefs.recommended=false` | [RecommendedPreferences.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/shared/RecommendedPreferences.sys.mjs) (comments + `COMMON_PREFERENCES`), [Prefs doc](https://firefox-source-docs.mozilla.org/remote/Prefs.html), [WebDriverBiDi.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/WebDriverBiDi.sys.mjs) | VERIFIED (no persistence; weakened protections while the agent browser runs) |
| WS endpoint | `ws://127.0.0.1:PORT/session`; connect, then send `session.new` | [MDN Create a BiDi connection](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection) | VERIFIED |
| Port discovery when `0` | (a) parse stderr line `WebDriver BiDi listening on ws://127.0.0.1:<port>`; (b) read `<profile>/WebDriverBiDiServer.json` = `{"ws_host","ws_port"}` written on start | source: [WebDriverBiDi.sys.mjs `start()`](https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/WebDriverBiDi.sys.mjs); MDN how-to | VERIFIED (file existence) / UNVERIFIED (stale-file cleanup on crash) |
| Auth / crypto | None. Loopback only; clients must present **no `Origin` header** (or an allow-listed one) and a loopback `Host`; `--remote-allow-hosts` / `--remote-allow-origins` widen it (strongly discouraged) | [Security doc](https://firefox-source-docs.mozilla.org/remote/Security.html); [WebSocketHandshake.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/server/WebSocketHandshake.sys.mjs) | VERIFIED |
| Multiple clients/sessions | **One session total.** Second `session.new` → `SessionNotCreatedError("Maximum number of active sessions")`; `session.status` reports `ready:false, "Session already started"` (Bug 1720707) | [WebDriverBiDi.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/WebDriverBiDi.sys.mjs) | VERIFIED |
| Normal browsing coexists | Yes — BiDi is out-of-band from the browser UI; the user keeps using the same window. Input acts on whatever tab the user has open (that is the point) | inference from transport design + [Security doc](https://firefox-source-docs.mozilla.org/remote/Security.html) | UNVERIFIED (needs the smoke test) |
| System access | Not needed for content operations; `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` unlocks Gecko/chrome scope (do not ship this) | [Security doc](https://firefox-source-docs.mozilla.org/remote/Security.html) | VERIFIED |
| Experimental commands | `remote.experimental.enabled` defaults **true on Nightly, false elsewhere**; it gates experimental commands/events. Every command in §4 is stable/BCD-listed and no longer gated (the `assertExperimental…` helper has no call sites in current `main`) | [all.js](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/all.js); [Module.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/shared/messagehandler/Module.sys.mjs); Searchfox | VERIFIED (default) / UNVERIFIED (future re-gating risk) |

---

## 4. Command parity for our exact CDP surface (Q3)

Version column = Firefox `version_added` in BCD (implementation availability; BiDi is the only remote protocol since 141, and default-on for the agent since 129 per [fxdx](https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/)). All of these are present in 159.

| # | CDP method (current use) | BiDi equivalent | isTrusted | Version | Notes / ranking |
|---|---|---|---|---|---|
| 1 | `Input.dispatchMouseEvent` (click, drag, hover) | `input.performActions` pointer source (`pointerMove`/`pointerDown`/`pointerUp`; `pointerType:"mouse"`, `origin:"viewport"`) — [MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/input/performActions) | **Yes** — WebDriver requires trusted events; Firefox uses the same `Actions`/`EventUtils` engine as WebDriver classic ([spec §Ticks](https://w3c.github.io/webdriver/#dfn-ticks): “the dispatched events will have the `isTrusted` attribute set to true”; [Event.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/shared/webdriver/Event.sys.mjs)) | [BCD ff=113](https://github.com/mdn/browser-compat-data/blob/main/webdriver/bidi/input.json) | **Good parity.** clickCount is derived by Firefox from the click tracker, so successive clicks produce dblclick ([Actions.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/shared/webdriver/Actions.sys.mjs)). Runtime isTrusted semantics: **UNVERIFIED** (no browser run) but spec+source are explicit. |
| 2 | `Input.dispatchKeyEvent` (keyDown with `text`, rawKeyDown, keyUp, modifiers) | `input.performActions` key source (`keyDown`/`keyUp`, `value` = key, optional `"Control"+…` actions in parallel) — [MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/input/performActions) | Yes (same as #1) | ff=113 | **Good parity** for named keys and printable chars; Firefox maps text/code from its key-data table and defaults unknown single chars to `printable:true` ([KeyData.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/shared/webdriver/KeyData.sys.mjs)). CJK/emoji + IME behaviour: **UNVERIFIED**. |
| 3 | `Input.insertText` (bulk text into Docs canvas/cells) | **No BiDi command.** `input` module has only `performActions`, `releaseActions`, `setFiles` (+ `fileDialogOpened` event) | n/a | n/a | **Hard gap.** Workarounds: (a) per-character key actions (correct but chatty; UNVERIFIED for Docs); (b) clipboard-paste: extension writes `navigator.clipboard.writeText` (with `clipboardWrite` permission no transient activation needed — [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Interact_with_the_clipboard)) then BiDi sends trusted `Ctrl+V`. Both replacement behaviours: **UNVERIFIED**. |
| 4 | `Page.captureScreenshot` (`clip`, `captureBeyondViewport`) | `browsingContext.captureScreenshot` with `origin:"document"` (full scrollable page), `clip` (`box`/`element`), `format` | n/a (capture) | ff=110; clip ff=117; origin ff=121; format ff=135 — [BCD](https://github.com/mdn/browser-compat-data/blob/main/webdriver/bidi/browsingContext.json), [MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browsingContext/captureScreenshot) | **Better than CDP for full-page:** no `setDeviceMetricsOverride` + scroll-restore dance needed. Background/occluded tabs: default capture is Firefox’s software `drawSnapshot` path, not on-screen readback ([Prefs doc `remote.screenshot.use_readback`](https://firefox-source-docs.mozilla.org/remote/Prefs.html)) → expected to work for hidden tabs; **UNVERIFIED at runtime**. Very tall pages: **UNVERIFIED**. |
| 5 | `Page.handleJavaScriptDialog` | `browsingContext.handleUserPrompt {context, accept, userText}` — [MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browsingContext/handleUserPrompt) | n/a | ff=118, full ff=129 | **Good parity**, incl. `beforeunload` (fixed FF129 — [MDN 129](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/129); BCD marks beforeunload `partial` at 129). |
| 6 | `Page.javascriptDialogOpening` / `…Closed` events + `Page.enable` | `browsingContext.userPromptOpened` / `userPromptClosed` via `session.subscribe`; **no enable step** (subscription-based) | n/a | opened ff=118, closed ff=119; `handler` field ff=129 | **Parity plus** (no per-tab attach). Event ordering vs. “page is blocked now” races: **UNVERIFIED**; expect to port the existing `dialogs.js` state machine with timeouts. |
| 7 | `Page.getLayoutMetrics` (full-page size) | **No command.** Replace with `script.evaluate` returning `document.documentElement.scrollWidth/scrollHeight`, `innerWidth/innerHeight`, `devicePixelRatio`, `scrollX/scrollY`; or drop it entirely by using `captureScreenshot origin:"document"` | n/a | script.evaluate ff=106 | Not needed for viewport/region screenshots: repo already computes viewport metrics in-page via `runInTab(tab.id, pageMetrics)` ([browser.js:1199](extension/sidepanel/browser.js)); only the full-page branch at ~2932 uses CDP. **Comfortable port.** |
| 8 | `Emulation.setDeviceMetricsOverride` / `clearDeviceMetricsOverride` (tall viewport for full-page capture) | `browsingContext.setViewport {context, viewport{width,height}, devicePixelRatio}` / `viewport:null` to reset — [MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browsingContext/setViewport) | n/a | ff=117; DPR ff=127; userContexts ff=138 | **Parity** but top-level only. **Recommendation: delete this path**; `origin:"document"` removes the need. Known Firefox bug with `setViewport` racing navigations: [Bug 1919275](https://bugzilla.mozilla.org/show_bug.cgi?id=1919275) (RESOLVED FIXED) — a reason to avoid it. |
| 9 | `DOM.setFileInputFiles` (+ `DOM.enable`/`DOM.getDocument depth:-1 pierce`) | `input.setFiles {context, element:{sharedId}, files:[abs paths]}` — [MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/input/setFiles) | Upload itself is real (`File` objects set via `mozSetFileArray`); the `input`/`change` events it fires are script-dispatched → **`isTrusted:false`** ([windowglobal/input.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/modules/windowglobal/input.sys.mjs), [Event.sys.mjs `sendEvent`](https://github.com/mozilla-firefox/firefox/blob/main/remote/shared/webdriver/Event.sys.mjs)) | ff=125 | **Element discovery replaces DOM.getDocument:** walk open shadow roots with `script.evaluate` and return the element as a `sharedId` (MDN lists `script.evaluate` as a source of sharedIds). Paths are resolved by the **Firefox process**, so companion/Firefox must share a filesystem. Strict `isTrusted`-checking upload widgets: **UNVERIFIED** (most frameworks don’t check). Optional new tool: `input.fileDialogOpened` event (ff=147, BCD) if we ever want picker-driven uploads. |
| 10 | `DOM.enable` / `DOM.getDocument` (generic DOM access) | **No DOM domain.** Use `script.evaluate` / `script.callFunction` / `browsingContext.locateNodes` (ff=123) with remote references | n/a | script ff=106, locateNodes ff=123 | **Parity via scripting** (and the extension already does most DOM observation with `scripting`). No accessibility-tree domain in Firefox’s BiDi (BCD `webdriver/bidi/` has no `accessibility.json`) — the port must keep using DOM/label extraction, which the repo already does. |

**Parity summary:** 8/10 workable with direct or near-direct mapping, 1 hard gap (`insertText`), 1 convenience loss (`getLayoutMetrics`), plus the DOM-node-handle mechanism changes from CDP nodeIds to BiDi `sharedId`s.

---

## 5. Tab id ↔ browsingContext id correlation (Q4)

BiDi context ids are UUID strings; there is **no direct link** to WebExtension `tabId`. Candidates:

| Option | Mechanism | Verdict |
|---|---|---|
| URL/title match | `browsingContext.getTree` returns `url`; compare with `tabs.Tab.url` | Ambiguous with duplicate tabs; racy under navigation. **Display-only fallback.** |
| `moz:name` | Firefox serialises `browsingContext.name` as `moz:name` for top-level contexts ([browsingContext.sys.mjs:3183-3200](https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/modules/root/browsingContext.sys.mjs)); extension can set `window.name` in MAIN world | One `getTree` correlates all tabs, but mutates page-visible `window.name` which **persists across navigations** and is used by some sites as storage. Second choice. |
| `clientWindow` | `getTree` returns `clientWindow` (ff=138/140 in BCD) | Opaque id; no mapping to `tabs.windowId`. Not usable. |
| `contextCreated` ordering vs `tabs.onCreated` | Correlate event order | Racy on startup/restore. Reject. |
| **Token handshake (recommended)** | Panel runs `scripting.executeScript({target:{tabId}, world:"MAIN", func: set token})`; companion reads the token from each candidate context with BiDi `script.evaluate` and caches `tabId → context`. Invalidate on `contextDestroyed`/navigation and re-run lazily (a navigation destroys the MAIN-world token). | Deterministic, no persistent page mutation (`window.name` untouched), O(tabs) only on cache miss. Assumes BiDi `script.evaluate` targets the page realm by default (isolated realm is opt-in via `sandbox`); **UNVERIFIED at runtime**. |
| `visibilityState` tie-break | `document.visibilityState==="visible"` identifies a window’s active tab | Cross-window ambiguity; use only to disambiguate URL collisions. |

**Recommendation:** token handshake in `world:"MAIN"` + cache + event-driven invalidation; URL/title and `visibilityState` only for fast-path/UI display; do not use `window.name` unless the handshake proves too chatty.

---

## 6. Extension-only fallback (Q6) — what breaks

| Capability | Firefox extension mechanism | Reality | Label |
|---|---|---|---|
| DOM read/write, labels, scrolling | `scripting.executeScript` (ISOLATED; `world:"MAIN"` since **FF128** — [BCD scripting](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/scripting.json)) | Works; this is already the repo’s DOM layer | VERIFIED |
| Synthetic pointer/key events | `element.click()`, `dispatchEvent(new MouseEvent(...))`, `execCommand('insertText')` | **`isTrusted:false`** always; `HTMLElement.click()` events are untrusted by spec ([MDN isTrusted](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted)). User-activation-gated APIs (clipboard, popups, file pickers) are **not** unlocked; canvas editors and `isTrusted`-checking frameworks (Google Docs class of apps) are the known failure mode. The repo already ships such a degraded fallback (`syntheticClickBurst`) — keep it only as “best effort UI hint”, never as acceptance evidence. Docs-specific success: **UNVERIFIED**. | VERIFIED (isTrusted) / UNVERIFIED (site-specific) |
| Screenshot | `tabs.captureTab(tabId, options)` — full-tab image, requires `<all_urls>` ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureTab)); Firefox-only (ff=59) | No clip/region, no element capture, no full-page control. Background-tab capture not stated by docs — **UNVERIFIED**. Not a substitute for the agent’s view/region pipeline. | VERIFIED (API/limits) |
| `devtools.inspectedWindow.eval` | Only inside a devtools panel/page context (ff=54) | Useless for a sidebar agent; not a transport. | VERIFIED (BCD devtools) |
| Native JS dialogs (`alert/confirm/prompt/beforeunload`) | no API | **Cannot observe or handle.** A blocked page stalls scripted work; fail closed and ask the user. | VERIFIED (no dialog API in Firefox webextensions) |
| File input | set `input.files` via `DataTransfer` in MAIN world | Fires untrusted events; many upload UIs accept, strict ones reject; cannot open the native picker programmatically. | UNVERIFIED (site-specific) |

**Tier-2 scope:** navigation/tab management, DOM reads, label extraction, simple value setting, screenshots for UI display, downloads. **Not** trusted click/type/drag/canvas editing, not dialogs, not uploads as primary path.

---

## 7. OS-level injection fallback (Q7)

| Platform | Tool/API | Trusted? | Constraints | Evidence |
|---|---|---|---|---|
| Linux/X11 | `xdotool` (XTEST) | Yes (real input path) | X11 only; README: on Wayland “this software will not work correctly… typing, window searching, and many other functions do not work” | [xdotool README](https://github.com/jordansissel/xdotool) — VERIFIED |
| Linux/Wayland | `ydotool` (uinput) | Yes | Requires `ydotoold` daemon with access to `/dev/uinput` — “usually requires root permissions”; persistent virtual device; may interact with the whole desktop | [ydotool README](https://github.com/ReimuNotMoe/ydotool) — VERIFIED |
| Windows | `SendInput` | Yes | “subject to UIPI… permitted to inject input only into applications that are at an equal or lesser integrity level”; host app must hook/forward; no background-window targeting | [Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) — VERIFIED |
| macOS | `CGEventPost` (Quartz) | Yes | Requires Accessibility trust for the injecting process (`AXIsProcessTrustedWithOptions`); cannot target a background window reliably | [Quartz Event Services](https://developer.apple.com/documentation/coregraphics/quartz_event_services), [AXIsProcessTrustedWithOptions](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions) — VERIFIED (docs) |
| Any | — | — | WebDriver spec’s own comparison: OS-specific messages risk “the browser being automated may not be properly isolated from a user accidentally modifying an input source”; OS accessibility APIs require “the browser’s window must be focused, and as a result, multiple WebDriver instances cannot run in parallel” | [WebDriver spec §Ticks](https://w3c.github.io/webdriver/#dfn-ticks) — VERIFIED |

**Feasibility as tier-2:** technically yes, operationally no. It needs window focus (steals from the user), coordinate math with DPI/zoom/window chrome, per-platform code (4 platforms), Wayland/root caveats, and it is blind and dangerous (clicks land wherever the user moved the window). Use only as an explicitly unsupported “tier 3” for the active window on X11/Windows, behind a flag, never in headless/CI. Recommendation: **do not build it in the port’s first milestone**.

---

## 8. BiDi extras that reduce port work (Q8)

| Feature | Command/event | Version | Use in the port | Evidence |
|---|---|---|---|---|
| Session-less / direct WS | connect `ws://127.0.0.1:PORT/session`, send `session.new` | — | companion connects without any HTTP client | [MDN Create a BiDi connection](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection) — VERIFIED |
| Tab activation | `browsingContext.activate` | ff=118 | make target tab foreground before pointer input (do this instead of assuming background input) | [MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browsingContext/activate) — VERIFIED |
| New tab / close | `browsingContext.create` (ff=101), `.close` (ff=100) | | replace `tabs.create/remove` when the operation belongs to BiDi | BCD — VERIFIED |
| Subscriptions | `session.subscribe` / `unsubscribe` | ff=93 | dialogs, navigation, log, network — one subscription, no per-tab attach | BCD — VERIFIED |
| Network | `network.beforeRequestSent`/`responseCompleted`, intercepts (`network.addIntercept` ff=118, `continueRequest` ff=124, `provideResponse` ff=124) | ff=110+ | replaces the CDP Network domain the audit lists as lost; enough for a port of request observation/interception | BCD — VERIFIED |
| Downloads | `browsingContext.downloadWillBegin` (ff=144 partial), `downloadEnd` (ff=145), `browser.setDownloadBehavior` (ff=149) | | replaces CDP Browser.setDownloadBehavior; the repo can also keep `browser.downloads` | BCD — VERIFIED |
| Containers / user contexts | `browser.createUserContext` / `removeUserContext` / `getUserContexts` (ff=124); hidden pref `remote.experimental.dynamicstart.container-isolation-enabled` can **restrict a session to one user context** | | strong isolation option: run the agent in a disposable container while the user’s normal cookies stay elsewhere (but cross-container login story differs) | BCD; [RootBiDiModule.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/modules/RootBiDiModule.sys.mjs) — VERIFIED |
| Extension install/uninstall | `webExtension.install` / `uninstall` (ff=137); `extensionData` = `path` \| `archivePath` \| `base64`; `moz:permanent` requires a **signed** extension (unsigned permanent install errors — improved message in FF141) | | companion can sideload the ported extension at connect time; unsigned builds stay temporary (gone on restart) | [webExtension.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/modules/root/webExtension.sys.mjs), [MDN 141](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141), BCD — VERIFIED |
| Script user activation | `script.evaluate` / `callFunction` `userActivation` param | ff=121 | escape hatch for activation-gated page APIs without misusing synthetic events | BCD — VERIFIED |
| Client windows | `browser.getClientWindows` (ff=134) | | window-level layout info for multi-window UX | BCD — VERIFIED |

---

## 9. Security / UX verdict (Q9)

**What the user must do**

| Once | Every launch | Only on Nightly/future |
|---|---|---|
| Install the signed extension (AMO or `webExtension.install` with `moz:permanent`); or keep sideloading it temporarily each start (unsigned, `moz:permanent` fails) | Start Firefox through the agent shortcut / companion-owned launch (`--remote-debugging-port=0`, own `--profile`, `--new-instance`), or leave the agent-started Firefox running for the day and let the companion reconnect | On Nightly, flip `remote.experimental.dynamicstart.enabled`, use the Remote Control toolbar panel, and accept Firefox’s **Allow/Deny connection prompt** — no restart needed; on stable 159 “there is no user facing entry point” |

Evidence for the Nightly/dynamic path: [all.js pref comment + defaults](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/all.js) (`remote.experimental.dynamicstart.enabled=false`, `…prompt.enabled=true`), [RemoteControlPanel.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/browser/components/remotecontrol/RemoteControlPanel.sys.mjs) (Nightly-only widget), [RemoteControlServers.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/browser/components/remotecontrol/RemoteControlServers.sys.mjs) (`startAtRuntime({isBrowserAutomation:false})`, port file under `~/.firefox-devtools-mcp/instances/`), [ConnectionPrompt.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/main/remote/shared/webdriver/ConnectionPrompt.sys.mjs). This is Mozilla’s own pattern for AI tooling (`firefox-devtools-mcp`), currently preview-only. **VERIFIED** (source), **UNVERIFIED** (behaviour on 159 release).

**Risks of the local debug port**

* No authentication and no encryption: **any local process of the same user can drive the browser** (and “the HTTPD is not spun up without the flag”, and it is loopback-only) — [Security doc](https://firefox-source-docs.mozilla.org/remote/Security.html). **VERIFIED**
* Requests with an `Origin` header are rejected unless allow-listed; keep it that way (never pass `--remote-allow-origins`, which would let any browsing page attempt a connection subject to host checks). **VERIFIED** (source).
* Single session: if another tool (Playwright/Cypress/DevTools tooling) creates the one session, the agent is locked out until it ends. **VERIFIED** (source).
* CLI start weakens in-session protections (Safe Browsing, tracking protection, telemetry/updates disabled) via recommended prefs — acceptable in a dedicated agent profile, notable in a daily profile; it does **not** persist to `prefs.js`. **VERIFIED** (source).
* `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS` must stay unset. **VERIFIED** (docs).

**Recommended tier structure**

* **Tier 1 (ship): companion-owned BiDi session.** Firefox launched by/for the companion with `--remote-debugging-port=0`; companion parses stderr or `WebDriverBiDiServer.json`; one session; extension keeps DOM/labels; all trusted ops routed through `trusted.*` frames.
* **Tier 1b (fast-follow, no protocol change): drop the two hacky paths** (full-page = `origin:"document"`; file upload = `script.evaluate` walker + `input.setFiles`), and add clipboard-paste as the `insertText` replacement.
* **Tier 2 (degraded): extension-only** for read-only/DOM/navigation/screenshot, with explicit “trusted input unavailable” errors — never silently fall back.
* **Tier 3 (unsupported/last resort): OS-level injection** for the focused window on X11/Windows only, behind a flag, not in acceptance paths.

---

## 10. Recommended architecture + companion↔panel frame sketch

```
┌──────────────────────────── Firefox 159 ────────────────────────────┐
│  side panel (sidebarAction, extension)          content script(s)    │
│    DOM view/labels via browser.scripting   ◄──► DOM observation      │
│    tab id / window id / tab lifecycle                                │
└───────────────▲──────────────────────────────────────────────────────┘
                │ existing loopback WS bridge (companion/bridge.mjs, ws)
┌───────────────┴────────────── companion (Node) ───────────┐
│  Bridge (ui role)  ←→  DSH browser-use provider (tools role)│
│  BiDiClient: one WS to ws://127.0.0.1:<port>/session        │
│  TabMap: tabId → contextId (token handshake, invalidated)   │
│  DialogHub: userPromptOpened/Closed subscriptions           │
│  TrustedExec: CDP-name → BiDi translation table             │
└──────────────────────────▲──────────────────────────────────┘
                           │ WebDriver BiDi (W3C)
              ┌────────────┴────────────┐
              │ Firefox Remote Agent    │  started by:
              │  --remote-debugging-port│  companion launch, or
              │  =0 → ws://127.0.0.1:…  │  user shortcut, or Nightly panel
              └─────────────────────────┘
```

**Protocol changes (additive, keep `PROTOCOL_VERSION` bump):**

```jsonc
// panel → companion: tagged tab so the tabId→context map can be built/refreshed
{"v":1,"type":"browser.command","id":"c1","command":{"action":"tag_tab","tabId":42,"token":"9f3a…"}}
{"v":1,"type":"browser.result","id":"c1","ok":true,"result":{"tagged":true}}

// panel → companion: trusted ops (only these leave the extension)
{"v":1,"type":"browser.command","id":"c2","command":{"action":"trusted.click","tabId":42,"x":640,"y":318,"button":"left","clickCount":1}}
{"v":1,"type":"browser.result","id":"c2","ok":true,"result":{"trusted":true}}

{"v":1,"type":"browser.command","id":"c3","command":{"action":"trusted.key","tabId":42,"key":"Enter","modifiers":["ctrl"]}}
{"v":1,"type":"browser.command","id":"c4","command":{"action":"trusted.type","tabId":42,"text":"Hello world"}}   // → per-char key actions, or clipboard-paste mode
{"v":1,"type":"browser.command","id":"c5","command":{"action":"trusted.drag","tabId":42,"from":[x1,y1],"to":[x2,y2]}}
{"v":1,"type":"browser.command","id":"c6","command":{"action":"trusted.screenshot","tabId":42,"scope":"viewport|full_page|region","region":{…},"viewId":7}}
{"v":1,"type":"browser.command","id":"c7","command":{"action":"trusted.setFiles","tabId":42,"token":"upload-…","files":["/abs/path.pdf"]}}

// companion → panel: dialog + focus notifications (pushed, not requested)
{"v":1,"type":"event","event":"dialog.opened","dialog":{"tabId":42,"type":"confirm","message":"…","defaultPrompt":null}}
{"v":1,"type":"event","event":"dialog.closed","dialog":{"tabId":42,"accepted":true}}
{"v":1,"type":"event","event":"trusted.unavailable","reason":"no-bidi-session"}   // → panel must fail closed, not synthesize
```

**Companion responsibilities** (mirrors today’s `withDebugger`/`dialogs.js` semantics):
1. launch/attach: discover port → connect → `session.new` → `session.subscribe` (dialogs, navigation, log, network as needed); single owner, reconnect with backoff; never a second session.
2. `TabMap`: token handshake, cache, invalidate on `contextDestroyed`/`navigationCommitted`; map failures return a typed error (no silent URL matching for writes).
3. translate: mouse→`input.performActions` pointer; key→key source; drag→pointer sequence with intermediate moves; clickCount via successive clicks; hover = lone `pointerMove`.
4. dialogs: port `DialogManager` state machine; auto-accept `alert`/expected `beforeunload`; surface `confirm/prompt` as `dialog.opened` event and implement `trusted.dialog {accept,userText}`.
5. screenshots: viewport→default; full_page→`origin:"document"`; region→map through `metrics` already provided by the panel; return base64 data URL + cssSize.
6. typing: `trusted.type` = per-char key actions (default) with clipboard-paste mode behind a setting for Docs-class editors; never use `execCommand` for acceptance paths.
7. uploads: `script.evaluate` shadow-root walk for the tokenised input → `sharedId` → `input.setFiles`; verify file name/size in-page afterwards.
8. enforce injection hygiene: fixed loopback host, **no** `Origin` header on the BiDi WS (Node `ws` default), no allow-hosts/origins, no `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS`, no `/tmp` symlink tricks for uploads.

---

## 11. Risk table (port plan)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `Input.insertText` gap breaks Docs canvas/table typing (the repo’s hardest acceptance area) | High | High | Milestone 0 spike: clipboard-paste vs per-char keys on a disposable Docs doc; keep `trusted.type` pluggable per site; acceptance run before committing to port scope |
| R2 | Only one BiDi session exists; panel reloads / companion restart / another tool steals it | Medium | High | companion owns the session for the whole Firefox lifetime; reconnect logic; explicit `trusted.unavailable` error; never spawn Playwright-style clients |
| R3 | Daily-profile constraint: agent-launched Firefox and user’s running Firefox conflict; logins differ in a dedicated profile | High | High | product decision up front (see Q2); ship a dedicated “Agent Firefox” launcher + profile; document that the user browses in that window, or add a one-click “restart my Firefox in agent mode” |
| R4 | Runtime isTrusted/user-activation semantics differ from CDP in edge cases (background tabs, iframes, activation-gated APIs) | Medium | High | 1-day spike with WPT-style probes in a throwaway profile: click/document, keydown, drag, dblclick, beforeinput, selection, file upload, dialog accept; gate the port on results |
| R5 | Background-tab pointer input unreliable (no activate) | Medium | Medium | call `browsingContext.activate` before pointer ops (matches user expectation); related unresolved focus issue: [Bug 1943448](https://bugzilla.mozilla.org/show_bug.cgi?id=1943448) |
| R6 | Dialog event ordering/races vs CDP attach model; `beforeunload` partial at 129 | Medium | Medium | port state machine with the existing 2s auto-accept timeout; subscribe globally; explicit pending-dialog error surfaced to the model |
| R7 | Screenshot differences: very tall pages, JPEG/scale semantics, hidden-tab drawSnapshot | Medium | Medium | use `origin:"document"`; add size guard identical to today’s `checkedFullPageSize`; compare view images against Chromium baselines in CI fixture |
| R8 | Upload file paths: Firefox process sandbox/permissions vs companion path | Low | Medium | paths from Downloads only (existing rule), realpath check, verify via in-page File name/size after `setFiles` |
| R9 | Local debug port has no auth; any local process can drive the browser | Medium | High | loopback-only default; never widen hosts/origins; dedicated agent profile; document; optionally require the Nightly-style connection prompt when it ships |
| R10 | Extension distribution: unsigned/permanent install fails; temporary install lost on restart | High | Medium | sign the ported extension (unlisted AMO) once, or automate `webExtension.install` with `moz:permanent` after signing; fallback = user sideloads each start |
| R11 | BCD `version_added` ≠ runtime availability (BiDi history, experimental re-gating) | Low | Medium | pin minimum Firefox version ≥141 (CDP removal) and probe `session.status`/capabilities at connect; refuse unsupported versions |
| R12 | JS-dialog handling regressions (the audit’s dialog safeguards) | Low | Medium | keep the same fail-closed contract (`DIALOG_PENDING`, settle-race errors) with BiDi events |

---

### Verification log (what was and was not done)

* **Read primary sources on 2026-11-04:** `product-details.mozilla.org/1.0/firefox_versions.json`; MDN (Firefox 129/141 release notes, BiDi reference pages: input module/performActions/setFiles, browsingContext captureScreenshot/setViewport/handleUserPrompt/activate, Create a BiDi connection, `isTrusted`, `tabs.captureTab`, clipboard); MDN browser-compat-data `main` (`webdriver/bidi/*.json`, `webextensions/api/*.json`); W3C WebDriver + WebDriver BiDi specs; Firefox source on `main` (RemoteAgent, WebDriverBiDi server/connection, RecommendedPreferences, WebSocketHandshake, input root/windowglobal modules, Actions/Event/KeyData, browsingContext/webExtension modules, RootBiDiModule, remotecontrol server/panel/banner, ConnectionPrompt, all.js, nsAppRunner); fxdx.dev CDP retirement/deprecation posts; xdotool/ydotool READMEs; Microsoft SendInput; Apple Quartz Event Services / AXISProcessTrusted docs; Bugzilla 1919275, 1943448 (Bugs 1720707 and 1882096 referenced from source/release notes without opening).
* **Not done (per rules):** no browser launched, no live-model test, no touching the user’s profiles. Therefore every statement about *runtime behaviour* (isTrusted observed in DevTools, Docs reactions, background-tab delivery, hidden-page screenshots, dialog timing, upload acceptance) is labelled **UNVERIFIED** and must be settled by the spike in open question 1.

---

## 12. Five open questions that most affect the plan

1. **Does trusted BiDi input actually reproduce today’s CDP behaviour on the hard pages** (Google Docs canvas typing/selection, shadow-DOM file inputs, background tabs)? This is the go/no-go spike; it cannot be answered from docs (requires a disposable profile, WPT-style probes). `insertText` has no BiDi equivalent, so Docs typing quality is the single largest unknown.
2. **Which profile strategy is the product?** (a) user’s daily profile, agent-launched Firefox with `--remote-debugging-port`, single instance, logins preserved; (b) dedicated agent profile with separate logins/isolation, or (c) container-restricted session (`browser.createUserContext` + hidden container-isolation pref). This decision changes UX, auth story, and installation flow more than any protocol detail.
3. **Is clipboard-paste an acceptable `Input.insertText` replacement?** It needs `clipboardWrite`, mutates the user’s clipboard, is rejected by some editors, and must be measured for reliability/latency versus per-character key actions before choosing a default.
4. **How does the companion survive lifecycle churn as the sole BiDi client** — Firefox restart, panel reload, companion restart, another tool taking the single session — without the model ever acting through a stale tab↔context mapping or a synthetic fallback?
5. **Distribution and future no-restart path:** do we ship a signed extension + “Agent Firefox” launcher now, and plan for Firefox’s Nightly-only dynamic-start + connection-prompt flow later (Mozilla’s own `firefox-devtools-mcp` pattern), or gate the port on that API reaching release?
