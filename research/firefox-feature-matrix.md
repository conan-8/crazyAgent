# Firefox-only vs Chromium-only capability matrix — for THIS agent

**Status:** research deliverable, read-only (no product code changed).
**Date:** 2026-11-04. **Supersedes:** the unverified claims in `../firefox-port-audit.md` (2026-11-03); corrections are listed in §5.
**Scope:** the product in this repo — a 32-tool, model-facing Chrome side-panel agent (`extension/sidepanel/`, `packages/dsh-browser-extension/lib/index.js`, Node companion `companion/`). The question is not "which APIs exist" but **which Firefox APIs let this agent do something it cannot do on Chromium, and which Chromium APIs this agent depends on that Firefox cannot replace**.

**Verification labels:** `VERIFIED` = confirmed against an official source fetched on 2026-11-04 (URL given). `PARTIAL` = partly confirmed / version nuance unresolved. `UNVERIFIED` = plausible but not confirmed; do not build a milestone on it without a spike.

---

## 0. Baselines, method, and what "verified" means here

| Item | Value on 2026-11-04 | Source |
|---|---|---|
| Firefox stable | **159.0.1** (release 2026-10-27) | [product-details JSON](https://product-details.mozilla.org/1.0/firefox_versions.json) — VERIFIED |
| Firefox ESR / Beta / Nightly | **153.6.0esr** / **160.0b4** / **161.0a1** | same JSON — VERIFIED |
| Chrome stable | **157.0.8103.38** | [Chrome for Testing last-known-good JSON](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json) — VERIFIED |
| MDN browser-compat-data | **8.1.8** | [npm registry `@mdn/browser-compat-data/latest`](https://registry.npmjs.org/@mdn/browser-compat-data/latest) — VERIFIED |
| Repo tool count / architecture | 32 model-facing tools; executor + bridge WebSocket live in the **side panel document**, not the background worker | `HANDOFF.md` §1–3; `extension/sidepanel/app.js:958` (`connect()`), `extension/background.js` — VERIFIED by reading the repo |

**Correction to the task brief and the old audit:** "Chrome 148+" is **not** the Chrome baseline. Chrome stable is **157**; **148 is the version where Chrome added the standardized `browser.*` namespace alias** ([Chrome docs availability banner](https://developer.chrome.com/docs/extensions/reference/api/pageCapture), [transition guide](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace)). Both statements can be true at once; the audit conflated them.

**Method note (important for anyone re-checking):** BCD's `webextensions/api/` tree only contains APIs that MDN documents for Firefox. Chrome-only APIs (`debugger`, `tabCapture`, `offscreen`, `pageCapture`, `tts`, `desktopCapture`, `declarativeContent`, `gcm`, `instanceID`) have **no BCD file at all** — absence is expected, not evidence. Table B therefore cites Chrome's own reference. Conversely, `browser.trial.ml` is absent from both BCD 8.1.8 and MDN; its only documentation is Firefox Source Docs.

The agent's current Chromium dependencies, read from the repo:

- Trusted input: `chrome.debugger` → `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent` (`extension/sidepanel/browser.js:452` attach, `:572` `withDebugger`, `:5469` `dispatchTrustedKey`).
- Native dialogs: `chrome.debugger` → `Page.javascriptDialogOpening` / `Page.handleJavaScriptDialog` (`extension/sidepanel/dialogs.js`).
- Full-page + region screenshots: `Page.captureScreenshot` with `captureBeyondViewport`, `Page.getLayoutMetrics`, `Emulation.setDeviceMetricsOverride` (`browser.js:2925` `capturePageImage`); viewport: `tabs.captureVisibleTab` with CDP fallback (`browser.js:2714`).
- File upload: `DOM.getDocument` + `DOM.setFileInputFiles` (`browser.js:9916` `setFileInputByToken`).
- DOM reads/injection: `chrome.scripting.executeScript` (`browser.js:314` `runInTab`, `:351` `runInAllFrames`, `:1284` `labelPage`, `:10137` `execute` dispatcher).
- Downloads/places: `chrome.downloads`, `topSites`, `bookmarks`, `history` (`browser.js:4294` `searchPlaces`), virtual clipboard in `chrome.storage.session` (`browser.js:6073`).
- Panel: `chrome.sidePanel.setPanelBehavior` (`extension/background.js:7`).

---

## 1. Table A — genuinely Firefox-only (or Firefox-specific) capabilities

### Table A at a glance

All versions below are from BCD 8.1.8 queried 2026-11-04; `CH=false` = no Chrome support in BCD. Effort/value/risk are estimates for this repo; details and caveats follow each row.

| # | Capability | BCD key(s) / version | Effort | Value | Risk | Label |
|---|---|---|---|---|---|---|
| A1 | Containers / per-tab cookie jars | `contextualIdentities` FF53; `Tab.cookieStoreId` FF52; `cookies` store scoping; `windows.create.cookieStoreId` FF64; `downloads.*.cookieStoreId` FF92; `tabs.query({cookieStoreId})` no BCD key | L | 5/5 | 3/5 | VERIFIED (FF141 claim UNVERIFIED) |
| A2 | Durable per-tab/window agent memory | `sessions.setTabValue/getTabValue/removeTabValue` (+window) FF57; CH=false | S | 4/5 | 1/5 | VERIFIED |
| A3 | Point-at-element targeting | `menus.getTargetElement` FF63; `onShown/onHidden/refresh` FF60; `OnClickData.targetElementId` FF63; CH=false | M | 5/5 | 2/5 | VERIFIED |
| A4 | Replace/agent context menu | `menus.overrideContext` FF64; CH=false | S/M | 3/5 | 1/5 | VERIFIED |
| A5 | Native cross-frame find + highlight | `find.find/highlightResults/removeHighlighting` FF57; `find` perm FF57; CH=false | S/M | 4/5 | 2/5 | VERIFIED |
| A6 | Blocking webRequest in MV3 + response-body filtering | `webRequestBlocking` FF48 (CH: policy-only in MV3); `filterResponseData` FF57; `webRequestFilterResponse` perm FF110; `handlerBehaviorChanged` functional FF138 | L | 5/5 | 4/5 | VERIFIED (MV3 edges PARTIAL) |
| A7 | Per-request proxy | `proxy.onRequest` FF60; `ProxyInfo`; `proxyAuthorizationHeader`; `masqueTemplate` FF146; CH=false | M | 2/5 | 3/5 | VERIFIED |
| A8 | Global rendering/behavior controls | `browserSettings` FF56; `verticalTabs` FF142; `zoom*` FF75; `overrideContentColorScheme` FF95; `tlsVersionRestrictionConfig` FF72; CH=false | S | 3/5 | 2/5 | VERIFIED |
| A9 | Reader mode | `tabs.toggleReaderMode` FF58; `Tab.isArticle/isInReaderMode` FF58; CH=false | M | 3/5 | 2/5 | VERIFIED |
| A10 | Non-active-tab still capture | `tabs.captureTab` FF59; CH=false (`captureVisibleTab` is parity: FF47+) | S | 3/5 | 1/5 | VERIFIED (background-tab pixels UNVERIFIED) |
| A11 | PDF artifacts | `tabs.saveAsPDF` FF81; `tabs.PageSettings` FF56; CH=false | S | 1/5 | 1/5 | VERIFIED (dialog-bound) |
| A12 | Search-engine selection | `search.get`/`search.search` FF63; CH=false (`search.query` CH87/FF111) | S | 2/5 | 1/5 | VERIFIED |
| A13 | Sidebar UI | `sidebarAction` FF54; `open/close` FF57; `toggle` FF73; per-window methods FF61; CH=false (sidePanel incompatible) | M | required for port | 3/5 | VERIFIED |
| A14 | On-device inference (`trial.ml`) | not in BCD/MDN; trial API FF134+; `trialML` optional permission; Nightly-default, pref-gated on Beta/Release | M | 3/5 | 3/5 | VERIFIED (Source Docs only) |
| A15 | Other Firefox-only surface | `tabs.warmup` FF79; `tabs.hide/show` FF61/59 + `tabHide` FF61; `clipboard.setImageData` FF57; `dns.resolve` FF60 (CH Dev-only); `captivePortal` FF68; `pkcs11` FF58; `cookies.firstPartyDomain` FF59; `privacy.network.httpsOnlyMode` FF84 / `globalPrivacyControl` FF95; `sessions.forgetClosed*` FF55; `Tab.attention` FF63; `runtime.getFrameId` FF96 / `getDocumentId` FF153; enriched `webRequest` details; MV2 persistent background | S each | 1–3/5 | 1–2/5 | VERIFIED |

### A1. Containers: `contextualIdentities` + `cookieStoreId` + container-scoped cookies/tabs

- **BCD:** `contextualIdentities` FF 53, CH false; `Tab.cookieStoreId` FF 52, CH false; `cookies` with container stores (FF 52+, `getAll.tabIds` fix); `windows.create.createData.cookieStoreId` FF 64; `downloads.*.cookieStoreId` FF 92; `webRequest` details `cookieStoreId` FF 68; `contextualIdentities.move` FF 123; `getSupportedColors/getSupportedIcons` FF 153; `tabs.query({cookieStoreId})` is documented on MDN but **has no BCD key** — the audit's "since FF 141" is **UNVERIFIED**.
- **Caveats:** permission pair `contextualIdentities` + `cookies`; MDN still calls containers "an experimental feature … only enabled by default in Firefox Nightly", but also states that **from Firefox 57 installing an extension that uses the API enables the feature automatically**, and users can still disable it with `privacy.userContext.enabled` (MDN contradictions resolved only to that extent — the old audit's "release pref defaults true" is **UNVERIFIED**). Not available in private windows; Firefox for Android has no container UI. Chrome has no extension-visible per-tab cookie jar (profiles/incognito only).
- **Agent feature:** `browser_containers` tool + execution scoping — list/create/assign containers, open a tab in a container, and record `cookieStoreId` in every tab summary. This is the only way to give the agent **multi-account isolation** (e.g. two different Gmail accounts) without switching browser profiles. It also protects the user's main session from agent cookie mutations.
- **Effort:** L. **Value:** very high. **Risk:** medium (MFA/login prompts, user-visible container prompt, `tabs.query` scoping bugs if a container id leaks into the wrong tab).
- **Sources:** [MDN contextualIdentities](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/contextualIdentities), [MDN tabs.query](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/query), BCD (queried). **VERIFIED** (versions/caveats; FF141 version claim UNVERIFIED).

### A2. Durable per-tab/per-window agent memory: `sessions.setTabValue` family

- **BCD:** `sessions.setTabValue/getTabValue/removeTabValue` and window variants FF 57, CH false. Chrome's `sessions` has only `getRecentlyClosed`/`restore`/`onChanged`.
- **Caveats:** values are per-extension, JSON-stringified (functions stored as `null`); error on invalid tab id. MDN: values are restored if the tab/window is **closed and subsequently restored**; session-store semantics otherwise. Not a substitute for `storage.local` for cross-session state.
- **Agent feature:** durable, tab-scoped task memory — store `{taskId, lastViewId, pageFingerprint, docsAnchors, notes}` per tab. It survives close→reopen (Ctrl+Shift+T) and browser session restore, so a user can resume an in-flight task after an accidental close. Inject a compact "resume hint" into the next view instead of re-deriving state from screenshots.
- **Effort:** S (one bridge op + opt-in injection in `viewContent`/GUIDANCE; no new permission). **Value:** high. **Risk:** low (bounded JSON size; history clearing removes it — must fail open).
- **Sources:** [MDN sessions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sessions), [setTabValue](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sessions/setTabValue), BCD. **VERIFIED**.

### A3. Point-at-element targeting: `menus.getTargetElement` + `onShown`/`onHidden`/`refresh` + `targetElementId`

- **BCD:** `menus.getTargetElement` FF 63, CH false; `onShown`/`onHidden`/`refresh` FF 60, CH false; `OnClickData.targetElementId` FF 63, CH false. Audit was correct.
- **Caveats:** `getTargetElement()` only resolves in the document that contains the element (content script / that frame); the id **expires when the user opens another context menu**; needs `menus` permission. Chrome `contextMenus` has no element handle and no show/hide events.
- **Agent feature ("point at it"):** user right-clicks any element → agent menu item → content script calls `getTargetElement`, computes exact role/name/text/bounding box/frame and a **one-shot signed anchor**. The model then calls e.g. `browser_click` with that anchor instead of guessing a label or coordinate. This is a genuinely new interaction model for this product and removes the screenshot→label loop for hard-to-label DOM.
- **Effort:** M. **Value:** high. **Risk:** low-medium (menu clutter; anchor staleness must fail closed).
- **Sources:** [MDN getTargetElement](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/getTargetElement), BCD. **VERIFIED**.

### A4. `menus.overrideContext` — replace the page context menu with agent UI

- **BCD:** FF 64, CH false (missed entirely by the old audit).
- **Caveats:** only for menus with `contexts: ["all"]`; keeps browser items if desired; only one menu may override at a time.
- **Agent feature:** a right-click "Ask crazyAgent" menu (Summarize selection / Explain element / Add to task) without competing with the browser menu. Pairs naturally with A3.
- **Effort:** S/M. **Value:** medium. **Risk:** low.
- **Source:** [MDN overrideContext](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/overrideContext), BCD. **VERIFIED**.

### A5. Native find API: `find.find` / `highlightResults` / `removeHighlighting`

- **BCD:** namespace + all three methods FF 57, CH false; `find` permission FF 57 (also in `optional_permissions`).
- **Caveats (verified against MDN, correcting the audit's brevity):** searches **all frames** of a tab, returning `count` plus optional `rangeData` (text-node positions, `framePos`) and `rectData` (client rects + matched text); it searches **normal HTTP(S) web pages** (not extension pages; extension injection into `moz-extension://` documents was removed in Firefox 152); results are stored per extension and **replaced by the next `find()`**; highlight persists until `removeHighlighting()`. It searches rendered document text — not ARIA names/placeholders — so it complements, not replaces, the repo's JS `findProbe`.
- **Agent feature:** (a) a cheap, native, cross-frame **count + rect** path for `browser_find` on text-heavy pages, avoiding the current all-frame JS walk (`extension/sidepanel/find.js:171`); (b) **persistent highlight as visual evidence** — highlight matches, screenshot, remove highlighting — which gives the model pixel proof of "where" without overlays.
- **Effort:** S/M. **Value:** medium-high. **Risk:** low-medium (browser Find state conflicts; must always remove highlighting; non-web pages unsupported).
- **Sources:** [MDN find](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/find), [find.find](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/find/find), BCD. **VERIFIED**.

### A6. Network evidence and deterministic mocks: blocking `webRequest` in MV3 + `filterResponseData`

- **BCD:** `manifest.permissions.webRequestBlocking` FF 48, no MV3 caveat; Chrome 17 **with the explicit note** that in MV3 it is unavailable except for **policy-installed** extensions. `webRequest.filterResponseData` FF 57, CH false; `webRequestFilterResponse` permission FF 110 (MV3 requirement); `webRequestFilterResponse.serviceWorkerScript` FF 95; `webRequest.handlerBehaviorChanged` now functional FF 138 (was "exposed but non-functional" 45–137).
- **Caveats:** needs `webRequest` + `webRequestBlocking` + host permissions; `filterResponseData` must `close()`/`disconnect()` or the request hangs; Firefox's script byte-cache means filters for scripts must be created in `onBeforeRequest`; response-body filtering is in-memory and per-request.
- **Agent feature:** the single biggest **new sensing channel** available to this agent on Firefox. Implement `browser_network`: (a) record JSON/XHR responses for a tab as compact "network evidence" the model can read instead of scraping DOM; (b) session-scoped mock rules for deterministic replays of slow/flaky APIs; (c) header rewriting for test fixtures. On Chrome this is impossible from an ordinary extension: `declarativeNetRequest` cannot read response bodies, and blocking webRequest is policy-only.
- **Effort:** L. **Value:** high (reliability + test harness). **Risk:** high — privacy (page data + auth headers in memory), performance, AMO review scrutiny for `webRequestBlocking`.
- **Sources:** [MDN filterResponseData](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData), BCD (`webRequest`, `manifest.permissions`), [Mozilla MV3 post](https://blog.mozilla.org/en/firefox/firefox-manifest-v3-adblockers/) — **VERIFIED**; exact MV3 blocking behavior for *this* extension should still be smoke-tested on 159. **PARTIAL** on MV3 edge cases.

### A7. Per-request proxy: `proxy.onRequest` + `proxy.ProxyInfo` (+ credentials, `proxyDNS`)

- **BCD:** `proxy.onRequest` FF 60, CH false; `ProxyInfo` FF 60; `ProxyInfo.proxyAuthorizationHeader`; `RequestDetails` FF 60 (tabId/windowId filters from FF 78); `masqueTemplate` FF 146. Chrome's `chrome.proxy` is settings-only (`direct`/`auto_detect`/`pac_script`/`fixed_servers`) and incompatible ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#proxy_api)).
- **Caveats:** `proxy` permission (optional-capable); host permission for intercepted URLs; errors are global (`proxy.onError`), so a broken PAC callback affects browsing — must fail open.
- **Agent feature:** route agent-visible traffic through a user/test proxy by tab or by domain (geo testing, deterministic fixtures, corporate egress) without changing global browser settings.
- **Effort:** M. **Value:** niche-medium (dev/test and enterprise). **Risk:** medium-high (a bad callback can break all browsing).
- **Sources:** [MDN proxy](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy), [Chrome incompatibilities](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities), BCD. **VERIFIED**.

### A8. `browserSettings` namespace — global rendering/behavior controls

- **BCD:** namespace FF 56, CH false. Relevant keys: `cacheEnabled` FF 56; `imageAnimationBehavior` FF 57; `overrideDocumentColors` FF 61; `useDocumentFonts` FF 61; `zoomFullPage`/`zoomSiteSpecific` FF 75; `tlsVersionRestrictionConfig` FF 72; `overrideContentColorScheme` FF 95; `webNotificationsDisabled` FF 58; `verticalTabs` FF 142 (also `newTabPosition`, `openBookmarksInNewTabs`, `openSearchResultsInNewTabs`, `newTabPageOverride` — irrelevant here). Chrome's nearest equivalent, `chrome.privacy`, covers network/services/websites, not document rendering or zoom.
- **Caveats:** these are **global user preferences**, not per-tab agent state. Changing them for an agent run changes the user's browser and must be restored/opt-in.
- **Agent feature:** an opt-in "agent determinism profile" for test/acceptance runs: disable cache, disable image animation, force color scheme, zoom page for tiny text. Not for normal user sessions without consent.
- **Effort:** S. **Value:** medium (test reliability). **Risk:** medium (global side effects).
- **Source:** [MDN browserSettings](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/browserSettings), BCD. **VERIFIED**.

### A9. Reader mode: `tabs.toggleReaderMode` + `Tab.isArticle` / `isInReaderMode`

- **BCD:** `toggleReaderMode` FF 58, CH false; `Tab.isArticle`/`isInReaderMode` FF 58, CH false.
- **Caveats:** toggling **changes the page the user sees** and can be disorienting; the reader DOM is not the original DOM, so stale labels/coordinates must be invalidated; not every page is an article. Chrome has nothing equivalent (no reader-mode API).
- **Agent feature:** a `browser_read_text` scope `reader` for article-like pages — drastically cleaner text than the current rendered-text heuristic (`browser.js:4096` `readText`), with an automatic restore. Best used as an opt-in scope that reports `isArticle:false` rather than toggling non-articles.
- **Effort:** M. **Value:** medium (token + accuracy on articles, which are common agent tasks). **Risk:** medium (page mutation; restore verification).
- **Sources:** [MDN toggleReaderMode](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/toggleReaderMode), BCD. **VERIFIED**.

### A10. Screenshots of non-active tabs: `tabs.captureTab` (and the correction that `captureVisibleTab` is NOT Chrome-only)

- **BCD:** `tabs.captureTab` FF 59, CH false (requires `<all_urls>` per MDN; accepts a `tabId`, defaults to the active tab). **Correction:** `tabs.captureVisibleTab` exists in Firefox 47+ (Chrome 5); from Firefox 126 it needs `<all_urls>` **or** `activeTab` — the old audit wrongly implied it was Chrome-only.
- **Caveats:** `captureTab` returns a data URL "of an area of the given tab"; whether a fully background/unpainted tab returns reliable pixels is **UNVERIFIED** — smoke-test before relying on it. No MediaStream (that is `tabCapture`, Chromium-only).
- **Agent feature:** observe a background tab without switching (parallel watching), or capture the active tab on a different window; gives a Firefox path for some multi-tab observation. Does not replace CDP full-page capture.
- **Effort:** S. **Value:** medium. **Risk:** low (still image only; stale background pixels).
- **Sources:** [MDN captureTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureTab), BCD. **VERIFIED version/limits; background-tab reliability UNVERIFIED.**

### A11. PDF artifacts: `tabs.saveAsPDF` + `tabs.PageSettings`

- **BCD:** `saveAsPDF` FF 81 (FF 56 partial, removed/replaced in 81; BCD notes the old one "does not work on macOS"); `PageSettings` FF 56+ with `fileName` FF 75. CH false.
- **Caveats:** MDN is explicit — it **opens an OS save dialog** and resolves with `"saved" | "replaced" | "canceled" | "not_saved" | "not_replaced"` **after the dialog closes**. It is therefore **not a silent artifact path** for an agent; the old audit's "opens OS save dialog" was right, but "labelled non-working on macOS" must be scoped to versions 56–80.
- **Agent feature:** user-gated "save this page as PDF" button; cannot be an unattended tool. Chromium has no PDF-save API from extensions either — but see B9 (`pageCapture` MHTML) for the Chromium asymmetry.
- **Effort:** S (UI-only) / not model-facing. **Value:** low for the agent. **Risk:** low.
- **Sources:** [MDN saveAsPDF](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/saveAsPDF), BCD. **VERIFIED**.

### A12. Search engine selection: `search.get` / `search.search`

- **BCD:** `search.get` FF 63, CH false; `search.search` FF 63, CH false; `search` permission FF 63. `search.query` is cross-browser (Chrome 87, Firefox 111).
- **Caveats:** `search.search` opens results in a tab (`tabId` targetable); engine ids come from `search.get`; the human-visible engine list can change. Chrome extensions cannot enumerate or choose a non-default engine.
- **Agent feature:** `browser_search` tool — pick a specific engine (e.g. a documentation engine, a regional engine) instead of hard-coding `google.com/search?q=`. Also lets the agent use the user's configured engines, not a guess.
- **Effort:** S. **Value:** medium-low. **Risk:** low.
- **Sources:** [MDN search](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/search), BCD. **VERIFIED**.

### A13. Sidebar UI: `sidebarAction` + `sidebar_action` manifest key

- **BCD:** namespace FF 54, CH false; `open` FF 57, `close` 57, `toggle` 73, `isOpen` 59, per-window `setPanel/getPanel/setIcon/setTitle` FF 61, `open_at_install` FF 62. Chrome's `sidePanel` is a **different, incompatible** API (MDN).
- **Caveats:** `sidebarAction.open()` **may only be called from a user-action handler** (MDN, verified). Firefox has not implemented badge/focus methods. Firefox sidebar is **per-window**; Chrome side panels can be **per-tab** and can be opened programmatically from a gesture with `open({tabId|windowId})`.
- **Agent feature:** the real porting target — a Firefox sidebar document that hosts the same chat UI and the same bridge WebSocket. This is how the port keeps the repo's invariant "execution stays in the panel document" (and avoids the background-event-page lifetime problem entirely).
- **Effort:** M (UI + open flow; executor mostly unchanged). **Value:** required for a Firefox port; not a "win" by itself. **Risk:** medium (open gesture, per-window state, sidebar close kills the WS like closing the Chrome panel).
- **Sources:** [MDN sidebarAction](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction), [MDN open](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open), BCD. **VERIFIED**.

### A14. On-device inference: `browser.trial.ml` (optional permission `trialML`)

- **BCD/MDN:** **absent** from BCD 8.1.8 and MDN — verified by querying the full BCD `webextensions/api/` listing. Only [Firefox Source Docs — WebExtensions AI API](https://firefox-source-docs.mozilla.org/toolkit/components/ml/extensions.html) documents it. Introduced as trial API in **Firefox 134**; `trialML` is **optional-only**; **enabled by default only in Nightly**; on Beta/Release it requires `browser.ml.enable` **and** `extensions.ml.enabled` toggled in `about:config` (Firefox Source Docs, fetched 2026-11-04).
- **Caveats:** one engine at a time, no streaming API, model must come from Mozilla/Xenova HF orgs (or the `mozilla` hub), first `createEngine` downloads to OPFS (slow), engine can be evicted under memory pressure; tasks include summarization/translation/text-generation/image-to-text but audio/video/large-data tasks are impractical. AMO review of `trialML` is heavier than ordinary permissions.
- **Agent feature:** local pre-summarization of `browser_read_text` output before it enters the model context (token/latency savings on long pages), local translation, and local page-type classification. Must always fall back to raw text when the API or prefs are absent.
- **Effort:** M. **Value:** medium (and channel-dependent — not shippable to Release users without a pref toggle, so treat as Nightly/Beta enhancement, or as a "power user" opt-in). **Risk:** medium-high (trial API instability, downloads, review).
- **Sources:** Firefox Source Docs (above) — **VERIFIED** on availability model; not in BCD/MDN as of 8.1.8.

### A15. Other Firefox-only APIs worth knowing

| Capability | BCD / version (CH status) | Agent relevance | Label |
|---|---|---|---|
| `tabs.warmup(tabId)` | FF 79, CH false | Preload the next tab the agent is about to use (latency win for multi-tab tasks). Parity not available in Chrome. | VERIFIED ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/warmup)) |
| `tabs.hide()` / `show()` / `Tab.hidden` / `tabHide` | FF 61 / 59 / permission 61, CH false | "Focus mode": hide agent scratch tabs from the strip. Caveats: first use shows a browser notice with an option to disable the extension; cannot hide pinned / active / screen-sharing / closing tabs; ineligible tabs are skipped but **invalid ids fail the whole call**. | VERIFIED ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/hide)) |
| `clipboard.setImageData` | FF 57, CH false | Write a PNG to the system clipboard without OS-preservation games used by `system-clipboard.js`; still needs `clipboardWrite`. | VERIFIED (BCD) |
| `dns.resolve` | FF 60, CH `preview` only (Chrome Dev-only permission) | Diagnose DNS failures vs page errors; avoid pointless retries. | VERIFIED (BCD + MDN) |
| `captivePortal` (`getState`, `onStateChanged`, `canonicalURL`) | FF 68, CH false | Detect captive-portal/offline state before blaming the page; report a precise blocker. | VERIFIED (BCD) |
| `pkcs11` | FF 58, CH false | Client-cert/smartcard auth in enterprise flows (niche). | VERIFIED (BCD) |
| `cookies` `firstPartyDomain` | FF 59, CH false | Read/write First-Party-Isolated cookies (dFPI); needed if agent must inspect partitioned login state. | VERIFIED (BCD) |
| `privacy.network.httpsOnlyMode` / `globalPrivacyControl` | FF 84 / 95, CH false | Explain HTTPS-only/page privacy failures; don't misdiagnose blocked navigations. | VERIFIED (BCD) |
| `privacy.websites.cookieConfig`, `firstPartyIsolate`, `resistFingerprinting`, `trackingProtectionMode` | FF-only | Per-site diagnostic context for "why is this page different". | VERIFIED (BCD) |
| `sessions.forgetClosedTab/Window` | FF 55, CH false | Privacy hygiene: remove agent-opened pages from the Recently Closed list. | VERIFIED (BCD) |
| `tabs.Tab.attention` | FF 63, CH false | Mark a tab the user should look at (human handoff). | VERIFIED (BCD) |
| `tabs.print` / `printPreview` | FF 56, CH false | Opens print UI; user-gated, low agent value. | VERIFIED (BCD) |
| `runtime.getFrameId` / `runtime.getDocumentId` | FF 96 / 153, CH false | Precise frame/document addressing for cross-frame operations and `documentId` staleness guards. | VERIFIED (BCD) |
| `webRequest` details: `documentUrl`, `originUrl`, `cookieStoreId`, `thirdParty`, `urlClassification`, `proxyInfo` | FF-only fields (72–74) | Richer network evidence + container-aware record/replay. | VERIFIED (BCD) |
| `downloads` `cookieStoreId` / `allowHttpErrors` / `incognito` | FF 71/92/57, CH partial | Container-scoped downloads; tolerate deliberate 4xx downloads. | VERIFIED (BCD) |
| MV2 with a persistent background page | Firefox still accepts MV2 (MDN background docs; AMO documents MV2). Chrome: MV2 disabled everywhere in Chrome 138, removed in 139, remaining CWS MV2 removed 2026-08-31. | If the port wants a persistent bridge/event worker, Firefox MV2 is the only surviving option; the repo should still prefer the sidebar document. | Firefox status PARTIAL (no 2026 EOL statement found); [Chrome timeline VERIFIED](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline) |
| `menus.onShown`-driven dynamic menus | see A3 | Menu labels can reflect live page/element state (e.g. "Ask agent about this button"). | VERIFIED (BCD) |

---

## 2. Table B — Chromium-only or Chromium-advantaged capabilities

### Table B at a glance

| # | Chromium capability | Firefox status | What this agent loses | Mitigation | Severity | Label |
|---|---|---|---|---|---|---|
| B1 | `chrome.debugger` (CDP) | not implemented (bug 1316741) | trusted input, native dialogs, full-page/region CDP screenshots, CDP file-input assignment | **WebDriver BiDi to a Firefox launched with `--remote-debugging-port`**: `input.performActions` (FF 113), `browsingContext.captureScreenshot` with `clip`/`origin:"document"` (FF 110/117/121), `input.setFiles` (FF 125); companion owns the single BiDi session. **No `Input.insertText` equivalent** — Docs bulk typing needs per-key actions or clipboard-paste (UNVERIFIED; transport analysis in `research/firefox-trusted-input.md`) | **Critical** | VERIFIED |
| B2 | `chrome.tabCapture` | no equivalent | live tab audio/video streams | still-frame sampling (`captureTab`/BiDi screenshots); document the downgrade | Medium (future) | VERIFIED |
| B3 | `chrome.offscreen` | unnecessary (Firefox event page has DOM) | nothing | none needed | None | VERIFIED |
| B4 | `chrome.sidePanel` per-tab/open/close/layout/events | `sidebarAction` per-window, gesture-open only, no events | per-tab panels, programmatic open, layout/open signals | one per-window sidebar; open from toolbar action/menu; per-tab conversation state in `sessions`/storage | Medium | VERIFIED |
| B5 | full DNR (`responseHeaders`, `getMatchedRules`, quotas) | DNR 113 lacks those fields | body-level network control — which Chrome DNR never had either | Firefox blocking `webRequest` + `filterResponseData` covers and exceeds it (A6) | Low | VERIFIED |
| B6 | Chrome SW keepalives (WS 116, debugger 118, alarms 30 s 120) | event page instead of SW | nothing for the current panel-owned architecture | keep WS + executor in the sidebar document; dual `scripts`+`service_worker` block for the tiny worker | Low | VERIFIED |
| B7 | Chrome built-in AI (Gemini Nano; Prompt API in extensions Chrome 138+) | `trial.ml` trial API, pref-gated outside Nightly | stable local inference for token savings | feature-detect `trial.ml`; fall back to raw text; optional companion-side summarization | Medium | VERIFIED |
| B8 | `identity.getAuthToken` | only `launchWebAuthFlow` | silent Google auth | `launchWebAuthFlow` works in both browsers for interactive OAuth | Low (Medium if Google integration planned) | VERIFIED |
| B9 | `pageCapture.saveAsMHTML` (+ `printing`) | no MHTML API; `saveAsPDF` dialog-bound | silent page/report archival | user-gated `saveAsPDF` dialog; BiDi/CDP screenshots for images | Low | VERIFIED |
| B10 | `tts`, `desktopCapture`, `declarativeContent`, `gcm`/`instanceID`, devtools resource content, system APIs | absent | future features only | accept documented downgrade; offscreen is unneeded | Low | VERIFIED (existence; behavior not audited) |
| B11 | `tabs.onReplaced`, `Tab.pendingUrl`, `tabs.setZoomSettings`, `TabGroup.shared`, `storage.setAccessLevel`, `windows.onBoundsChanged` | absent | minor navigation-race/zoom/group helpers | accept; use BiDi navigation events where a race check matters | Low | VERIFIED |
| B12 | enterprise policies can block `debugger.attach` (host restrictions, `DisableScreenshots`, DLP) | no equivalent gate on the BiDi path | Chrome already carries this operational risk | keep the `DEBUGGER_BUSY`/policy error contract; a BiDi port removes this specific gate but adds the Remote Agent trust boundary | Medium | VERIFIED |

Columns in detail below: **what the repo uses it for today**, **what the Firefox port loses**, **mitigation**, **severity**.

### B1. `chrome.debugger` (CDP) — CRITICAL

- **What it powers here (all read from the repo):** trusted mouse (`Input.dispatchMouseEvent`), trusted keyboard (`Input.dispatchKeyEvent`), caret text insertion (`Input.insertText`), native-dialog observation and handling (`Page.javascriptDialogOpening` / `Page.handleJavaScriptDialog` in `dialogs.js`), full-page and region screenshots (`Page.captureScreenshot` + `Page.getLayoutMetrics` + `Emulation.setDeviceMetricsOverride`, `browser.js:2925`), file uploads (`DOM.getDocument` + `DOM.setFileInputFiles`, `browser.js:9916`), and DevTools-busy detection/choreography (`beginDebuggerRun`, `browser.js:502`).
- **What Firefox loses:** **all of it.** Chrome's `debugger` API is explicitly not implemented in Firefox ([MDN Chrome incompatibilities](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities); [bug 1316741](https://bugzil.la/1316741)). Firefox's `devtools.inspectedWindow.eval` runs only inside a devtools panel and is not a CDP transport. The repo's canvas/Docs strategy ("trusted input + one action + fresh view" — `GUIDANCE` lines 90–100) depends on it; untrusted `element.click()` cannot drive Google Docs reliably, and the repo explicitly rejects synthetic click paths for canvas editors.
- **Mitigation that actually works:** **WebDriver BiDi to the Firefox Remote Agent.** Firefox's Remote Agent implements **WebDriver BiDi only** (CDP support ended; `remote.active-protocols` was removed in Firefox 141) and is available on **all release channels**, but **can only be started by passing `--remote-debugging-port`**; it listens on loopback only and has no authentication ([Firefox Source Docs — Security aspects of the Remote Agent](https://firefox-source-docs.mozilla.org/remote/Security.html); [Remote protocol preferences](https://firefox-source-docs.mozilla.org/remote/Prefs.html)). What BCD confirms for Firefox 159: `input.performActions` FF 113, `input.releaseActions` FF 113, `input.setFiles` FF 125, `browsingContext.activate` FF 118, `browsingContext.captureScreenshot` FF 110 with `clip` FF 117 and `origin` FF 121 (BCD `webdriver/bidi/*`). There is **no `Input.insertText` command** in the BiDi input module (BCD lists only performActions/releaseActions/setFiles) — the repo's bulk caret insertion (`browser.js:5165` etc.) must be re-implemented as per-key actions or clipboard-paste; this is the single largest Docs-typing risk. Firefox's implementation also exposes `webExtension.install` and `moz:debugging` extension commands ([Firefox BiDi extensions doc](https://firefox-source-docs.mozilla.org/remote/webdriver-bidi/Extensions.html)). **Consequences:** (a) the companion must launch (or connect to) a Firefox started with the flag — an extension-only install cannot do trusted input, and the user's already-running profile cannot gain the flag without a restart; (b) only **one** BiDi session exists, so the companion must own it, not the panel; (c) tab↔context correlation needs a deterministic handshake. Transport-level detail and risks are analysed in `research/firefox-trusted-input.md`.
- **Severity:** **Critical** — without a BiDi path, the Docs tools (8 of 32) and all coordinate/trusted-input tools degrade to untrusted DOM events; with the flag, most semantics are recoverable but the transport is a different protocol and window/tab scoping must be re-mapped. **Label:** VERIFIED (Chrome docs + Firefox Remote Agent docs); per-command Firefox conformance (especially `input.setFiles`, screenshot clip) **UNVERIFIED** — requires a spike with geckodriver/Remote Agent on 159.

### B2. `chrome.tabCapture` — live MediaStream of a tab

- Chrome-only (`tabCapture` permission; capture requires the extension to be **invoked**; `getMediaStreamId()` Chrome 71/116; audio capture stops page audio unless re-routed) ([Chrome tabCapture docs](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)). Firefox has no equivalent (`tabs.captureTab` = still image). Not currently used by this repo.
- **Loses:** future live-video/audio observation (animation observation is listed as open work in `HANDOFF.md` §8.4).
- **Mitigation:** still-frame sampling with `tabs.captureTab`/BiDi screenshots, or accept the downgrade.
- **Severity:** Medium (future capability), none today. **VERIFIED.**

### B3. `chrome.offscreen` documents — Chrome-only but unnecessary

- Chrome 109+; one document; `runtime` is the only extension API inside; needs a reason string ([Chrome offscreen docs](https://developer.chrome.com/docs/extensions/reference/api/offscreen)). Firefox has no equivalent **but does not need one**: a Firefox MV3 background is an **event page — a real document with DOM** ([MDN background](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background); [MDN background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)).
- **Severity:** None/Info. **VERIFIED.**

### B4. `chrome.sidePanel` specifics — per-tab panels and programmatic open/close

- Chrome 114+ namespace; `open()` 116 (**user action required**); `getLayout()` 140; `close()` 141; `onOpened` 141; `onClosed` 142; per-**tab** `setOptions({tabId})`; close behavior changed in Chrome 145 (tab-specific close rejects if only the global panel is open) ([Chrome sidePanel docs](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), fetched 2026-11-04).
- Firefox `sidebarAction`: per-**window**, `open()` only from a user-action handler, no layout/open events, no per-tab instance (see A13).
- **Loses:** tab-specific agent panels (e.g. a different conversation per tab), programmatic open from background logic, and layout/open signals the UI could use. The repo's single-panel architecture already assumes one panel, so this is a UX/architecture downgrade, not a blocker.
- **Severity:** Medium. **Mitigation:** one sidebar per window; open on action click (`sidebar_action.open_at_install`) or menu/command; keep per-tab conversation state in `sessions`/`storage` instead of separate panel instances.

### B5. Full `declarativeNetRequest` rule set — Chrome advantage, but not for this agent

- Chrome-only extras: `RuleCondition.responseHeaders`/`excludedResponseHeaders` (Chrome 128), `getMatchedRules`/`onRuleMatchedDebug` + quotas (Chrome 84; needs `declarativeNetRequestFeedback` for unpacked/activeTab), `MAX_NUMBER_OF_UNSAFE_*` (120), `topDomains` (145), webbundle/webtransport types ([Chrome DNR docs](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest); BCD rows CH 128/145, FF false). Firefox DNR exists since 113 but lacks those fields (BCD).
- **What is actually lost for this agent:** very little — DNR cannot read response bodies even on Chrome, which is exactly the capability A6 gives on Firefox. For header-blocking tests, Firefox's blocking `webRequest` covers the same ground.
- **Severity:** Low. **VERIFIED** (BCD + Chrome DNR docs).

### B6. Chrome service-worker lifetime keepalives — mostly moot for this repo

- Chrome: SW terminated after **30 s idle**; single request >5 min; fetch >30 s. Keepalives: WebSocket send/receive resets idle timer (Chrome 116), active `debugger` session keeps SW alive (118), `alarms` min period 30 s (120), long-lived messaging (114), native-messaging port (105) ([Chrome SW lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), fetched).
- **Why it is moot here:** both the bridge WebSocket and the executor live in the **side panel document** (`app.js:958`), not the service worker. `extension/background.js` only sets panel behavior and badge text. A Firefox sidebar port can keep this architecture; only the tiny background event page changes lifetime rules.
- **If the port moves the WS into the background event page instead:** MDN states a non-persistent background page "does not unload until all visible views and message ports are closed", and opening a view prevents it from closing ([MDN background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)). That contradicts the old audit's "message ports do not prevent shutdown" — treat the audit line as wrong/outdated. Still: keep the WS in the sidebar, not the event page.
- **Severity:** Low (architecture-specific). **VERIFIED** (both docs).

### B7. Chrome built-in AI (Gemini Nano) vs Firefox `trial.ml`

- **Chrome status (stronger than the old audit implied):** the Prompt API is available to **Chrome extensions since Chrome 138** and to the web since **Chrome 148**; Summarizer/Writer/Rewriter/Proofreader and desktop Language Detector/Translator APIs exist; model = Gemini Nano, downloaded on first use; hardware gates (Windows 10/11, macOS 13+, Linux, ChromeOS Plus; ≥22 GB free disk; >4 GB VRAM or ≥16 GB RAM and ≥4 cores; unmetered network) ([Chrome Prompt API docs](https://developer.chrome.com/docs/ai/prompt-api), fetched 2026-11-04). This is a **stable, documented, no-pref-toggle** local inference surface — unlike Firefox's `trial.ml` (A14), which is pref-gated on Beta/Release.
- **What Firefox loses:** a reliable local pre-summarization/classification path for token savings; Firefox only offers it to Nightly or users who flip prefs.
- **Mitigation:** feature-detect `browser.trial.ml` and fall back to none; keep token savings out of the critical path; alternatively do summarization in the companion (already possible with the remote model, but costs tokens/latency).
- **Severity:** Medium. **VERIFIED.**

### B8. `identity.getAuthToken` — silent Google auth

- Chrome-only (`identity` permission; token from the Chrome profile's Sync account or first Google account; requires `oauth2` client id in manifest) ([Chrome identity docs](https://developer.chrome.com/docs/extensions/reference/api/identity)). Firefox supports only `launchWebAuthFlow` (both browsers; BCD CH 29 / FF 53).
- **Loses:** any future "sign in to Google services for the user without a browser flow" feature. Not used today (the agent logs in via the page UI).
- **Severity:** Low now, Medium if a Google-integration feature is planned. **VERIFIED.**

### B9. Chrome artifact APIs: `pageCapture.saveAsMHTML` (and `printing`)

- `chrome.pageCapture.saveAsMHTML({tabId})` returns a **Blob** (Promise form Chrome 116+), permission `pageCapture`; Chrome-only ([Chrome pageCapture docs](https://developer.chrome.com/docs/extensions/reference/api/pageCapture), fetched). Firefox has no MHTML-save API; `tabs.saveAsPDF` needs an OS dialog (A11).
- **Loses:** silent full-page archival artifacts. For this agent this is a packaging/handoff feature, not a core capability.
- **Severity:** Low. **VERIFIED.**

### B10. Chrome-only APIs with no current repo use

`chrome.tts`, `chrome.desktopCapture`, `chrome.declarativeContent` (explicitly not implemented in Firefox, [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities)), `chrome.gcm`/`instanceID`, `chrome.printing`/`printingMetrics`, `devtools.inspectedWindow.Resource.getContent/setContent` (Chrome 18; BCD CH-only), `chrome.dom`, `chrome.processes`, `chrome.system.*`, `chrome.webAuthenticationProxy`, `chrome.offscreen` (B3).

- **Loses:** desktop capture / TTS / push messaging / printing if the product later expands; `devtools` resource content is only available from a devtools panel anyway.
- **Parity note:** **native messaging is not Chrome-only** — `runtime.connectNative`/`sendNativeMessage` exist in both (BCD Chrome 29, Firefox 50). The repo's loopback WebSocket bridge is the better fit today, but a Firefox build could use native messaging to reach the companion if WebSocket policy ever becomes a problem.
- **Severity:** Low. **VERIFIED existence via Chrome API index + BCD/MDN; behavior not assessed.**

### B11. Smaller Chromium-only tab surface

- `tabs.onReplaced` (Chrome 26, FF false) — detect prerender/instant-page tab replacement.
- `Tab.pendingUrl` (Chrome 79, FF false) — observe pre-commit navigation URL.
- `tabs.setZoomSettings` (Chrome 42, FF false) — per-tab zoom mode; Firefox has global `browserSettings.zoomFullPage` instead.
- `tabGroups.TabGroup.shared` (Chrome 89, FF false) — shared tab groups UI.
- `storage.StorageArea.setAccessLevel` (Chrome 96 / session 102, FF false) — restrict storage to trusted contexts; not used here.
- `windows.onBoundsChanged` (Chrome 86), `windows.Window.sessionId` (Chrome 31) — minor.
- **Loses:** minor navigation-race detection and zoom control. **Severity:** Low. **VERIFIED** (BCD).

### B12. Enterprise risk that also exists on Chromium (do not forget)

- Chrome's `debugger.attach` can be blocked by enterprise policies: blocked hosts (`ExtensionSettings.runtime_blocked_hosts`), `DisableScreenshots`, or DLP rules fail attach with policy errors ([Chrome debugger docs](https://developer.chrome.com/docs/extensions/reference/api/debugger)). So the current trusted-input design is already fragile in managed Chrome; a Firefox BiDi path would **not** have this specific policy gate (though Remote Agent is its own security surface).
- **Label:** VERIFIED. **Severity:** Medium operational risk today, independent of the port.

---

## 3. Parity corrections — things people assume are Chrome-only but are not (and vice versa)

These are the audit lines that needed fixing. Each is labeled.

1. **`tabs.captureVisibleTab` is not Chrome-only.** Firefox has it since 47; from Firefox 126 it accepts `<all_urls>` **or** `activeTab` (BCD note). The old audit's phrasing "Chrome has only captureVisibleTab (viewport)" is **wrong** and is corrected here. Firefox additionally has `captureTab(tabId)`; Chrome does not. → VERIFIED ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab), BCD).
2. **`tabs.saveAsPDF` is user-dialog-bound, not a silent export.** It resolves with a status string after the OS dialog closes; the "does not work on macOS" note applies to the old 56–80 partial implementation (BCD), not to 81+. → VERIFIED.
3. **`find` is richer but narrower than the audit said.** It covers all frames, returns `count`/`rangeData`/`rectData`, and requires `normal HTTP(S)` pages; results are replaced by the next `find()`; highlighting persists until removed. → VERIFIED (MDN find/find.find).
4. **`tabs.query({cookieStoreId})` is documented but not in BCD 8.1.8**, so the audit's "since FF 141" cannot be verified from BCD and was not found in the sources checked. Treat as "supported per MDN parameter docs; exact version UNVERIFIED".
5. **Containers default state:** MDN says "experimental, only enabled by default in Nightly", **and** "from FF 57, installing an extension that uses the API enables the feature automatically; the user can disable `privacy.userContext.enabled`". The audit's in-tree-pref claim is **UNVERIFIED**; product behavior should rely on the auto-enable path and handle the disabled-error path.
6. **`userScripts` is not a Firefox-only feature.** New API: Chrome 120, Firefox 136 (MV3 only); `userScripts.execute()`: Chrome 135, Firefox 153. Permission models differ: Firefox = **optional-only** permission in `optional_permissions`; Chrome = **install-time** permission plus a user toggle in `chrome://extensions` ([MDN userScripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts); BCD). The task brief listed it as Firefox-only; it is parity with different plumbing.
7. **`publicSuffix` is parity, not Firefox-only.** Both Chrome and Firefox added it in **153** (BCD `webextensions.api.publicSuffix` CH=153, FF=153). The old audit got this right; the task brief's assumption is corrected here.
8. **`scripting` `world: "MAIN"` is Firefox 128 — confirmed via BCD's `scripting.ExecutionWorld.MAIN` (CH 102, FF 128).** The audit's version was correct; the BCD key to cite is `ExecutionWorld.MAIN`, not `executeScript.world` (property exists since FF 102).
9. **`documentId` is parity-ish, not a Firefox-specific advantage.** Firefox 153 broadly added `documentId` across webNavigation/webRequest/scripting/messaging plus `runtime.getDocumentId()` ([Firefox 153 add-ons blog](https://blog.mozilla.org/addons/2026/07/23/firefox-153-webextensions-api-updates/)); Chrome has `documentId`/`documentLifecycle` in the same areas since ~106 (BCD webNavigation/MessageSender rows). Firefox 153's contribution is breadth and the `runtime.getDocumentId()` convenience, not novelty.
10. **Tab groups parity confirmed:** `tabs.group/ungroup/groupId` Chrome 88 / Firefox 138; full `tabGroups` namespace Chrome 89 / Firefox 139; Chrome-only `TabGroup.shared` (BCD). The old audit was right.
11. **`browser` namespace is no longer a porting argument:** Chrome supports the standardized `browser.*` alias **since Chrome 148** ([Chrome pageCapture banner + transition guide](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace)), and MDN's Chrome-incompatibilities page now states namespace/promises "are no longer a source of incompatibility". The old audit's line was correct but should be read as "Chrome 148+ alias", not "Chrome baseline 148".
12. **`webRequest.handlerBehaviorChanged` is functional in Firefox 138+** (BCD: FF 138, previously "exposed but non-functional" 45–137). Relevant if the port relies on cache-policy invalidation.
13. **MV2 situation is inverted, not symmetric:** Chrome disabled MV2 everywhere in Chrome 138 and removed it in Chrome 139; remaining MV2 extensions were removed from the Chrome Web Store on **2026-08-31** ([Chrome MV2 timeline](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline)). Firefox still documents and accepts MV2/MV3 ([MDN background](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background); AMO distribution docs). No 2026 Firefox MV2 end-of-life statement was found — absence of an announcement is not a guarantee; **PARTIAL**.
14. **Event-page lifetime claim in the audit is unsupported by MDN.** MDN says a non-persistent background page does not unload until visible views and message ports are closed; the audit claimed "message ports do not prevent shutdown". Use MDN, and keep the WS in the sidebar regardless.
15. **`file://` access became an explicit opt-in permission in Firefox 153**, off by default for every extension including already-installed ones; `extension.isAllowedFileSchemeAccess()` now reflects it; `devtools.inspectedWindow.eval()` on file URLs is affected too ([Firefox 153 add-ons blog](https://blog.mozilla.org/addons/2026/07/23/firefox-153-webextensions-api-updates/)). The repo's file transfer is safe (companion resolves real paths under Downloads; it does not read `file://` pages), but any "agent opens a local HTML file" scenario now requires a user grant.
16. **Injection into `moz-extension://` documents was removed in Firefox 152** ([Firefox 149–152 add-ons blog](https://blog.mozilla.org/addons/2026/04/23/webextensions-api-changes-firefox-149-152/)); don't design around scripting into extension pages.
17. **`menus.overrideContext` was missing from the audit** and is a real Firefox-only interaction API (FF 64) — see A4.
18. **`tabs.warmup`, `tabs.print/printPreview`, `Tab.attention`, `sessions.forgetClosedTab/Window`, `clipboard.setImageData`, `runtime.getFrameId/getDocumentId`, `dns.resolve`, `captivePortal`, `pkcs11`, and the enriched `webRequest` detail fields were all missing from the audit's Table 1** — added in A15.
19. **`cookies.partitionKey` is parity, with different semantics** — Firefox 94, Chrome 119 (BCD). Do not treat it as a Firefox-only container primitive; Firefox's `cookieStoreId`/`firstPartyDomain` are the Firefox-specific parts (see Non-equivalences).
20. **`tabs.hide` remains Chrome-absent.** BCD reports `chrome=false`; Chrome's `tabs` reference has no hide method, and no shipped/intended signal was found (the old audit's "not verified" note stands). This is a real Firefox-only capability, not a parity item.
21. **`identity` is partially shared:** `launchWebAuthFlow` exists in both (Chrome 29 / Firefox 53); only `getAuthToken` is Chrome-only (see B8). Do not describe the whole namespace as Chrome-only.

**Non-equivalences that must not be hand-waved:**

- **Containers ≠ CHIPS.** Firefox `cookieStoreId` is a per-tab cookie jar selected by the user; Chrome's `partitionKey`/CHIPS is a partitioned-cookie *isolation mechanism* for embedded contexts, plus profiles/incognito for account separation. Firefox 94 and Chrome 119 both have `cookies.partitionKey`, but semantics differ; Firefox also has `firstPartyDomain` (dFPI) which Chrome lacks.
- **`sidebarAction` ≠ `sidePanel`.** Different manifest keys, different APIs, per-window vs per-tab, different open semantics (verified above). Source compatibility is zero; only the UX concept transfers.
- **MV3 background models differ.** Firefox: event page (a document; `background.service_worker` unsupported, bug 1573659; `persistent: true` errors in MV3). Chrome: service worker only; `background.scripts` ignored from Chrome 121 in MV3. The cross-browser pattern is to specify **both** `scripts` and `service_worker` (MDN), which this repo would need.
- **MV2 is alive on Firefox, dead on Chrome** (see 13). Any MV2 fallback is Firefox-only.
- **`find` (native) ≠ `browser_find` (JS probe).** Native find sees rendered document text across frames with rects; the repo's probe additionally matches control names/ARIA/values (see `find.js:171`). Keep both under one tool with explicit precedence.
- **Local AI: Chrome Gemini Nano (stable, hardware-gated) ≠ Firefox `trial.ml` (trial API, pref-gated outside Nightly).** Do not assume feature parity in either direction.

---

## 4. Agent product opportunities — ranked, with hooks into this repo

Ranking = (value to the model-facing contract) × (probability the Firefox-only API actually removes a current failure mode) ÷ effort. Each entry names the files/functions to touch and an independent acceptance check (per `AGENTS.md`, a real sidebar/model run is needed for final acceptance; the checks below are the *capability* gates).

### 4.1 Containers: multi-account sessions and agent sandboxing — **L, value 5/5, risk 3/5**

- **Design:** `browser_containers` tool (`list`, `create`, `assign_tab`, `open`), plus `cookieStoreId` on `browser_tabs` rows and on every view's `tab` summary. A per-session "task container" policy in the extension: when the user asks for an isolated task, create a container, open the target URL in it, and run the whole task there. The companion/DSH session stores the container id as task metadata.
- **Hooks:** new bridge ops in `extension/sidepanel/browser.js` (`execute` dispatcher at `:10137`), tab listing at `:4335` (`listTabs`) and `:4294` (`searchPlaces`) to include `cookieStoreId`; `getActiveTab`/`getWindowId` (`:258`, `:274`) to accept a container scope; tab creation in `navigate` op; new `browser_containers` tool in `packages/dsh-browser-extension/lib/index.js` (`registerTools` at `:2608`, schema validated like the other tools); guidance paragraph in `GUIDANCE` (`:61`); permissions in `extension/manifest.json` (`contextualIdentities`, `cookies`).
- **Acceptance check:** in an isolated Firefox profile, log into the same site in two containers; verify via `browser_read_text` that each shows a different account name and via `cookies.getAll({storeId})` that cookie sets differ; verify a tab created without a container id does not inherit another container's cookies; verify private-window failure is reported as a clear blocker, not a silent fallback.
- **Risk:** container auto-enable prompt, MFA flows, users disabling containers; the agent must never move a half-finished login between containers.

### 4.2 Per-tab durable agent memory — **S, value 4/5, risk 1/5**

- **Design:** bridge ops `memory.tab.get/set/remove` wrapping `sessions.*TabValue`; the executor writes a small JSON record (`{taskId, lastViewId, pageUrl, anchorHints, notes}`) after each successful mutation/view, and the provider injects a bounded "resume hint" into the next turn's tool result or system-prompt section when the tab was restored. One key namespace, hard size cap (e.g. 8 KB) and fail-open behavior.
- **Hooks:** executor ops in `browser.js` (`execute` dispatcher); provider-side injection in `lib/index.js` near the `viewContent`/GUIDANCE assembly (`GUIDANCE` at `:61`, tool results around the `define()` helper at `:2608`); permission `sessions` in `extension/manifest.json`.
- **Acceptance check:** set a value on a tab, close it, restore it (Ctrl+Shift+T) → exact payload returns; restart the browser with session restore → payload returns; object round-trip preserves JSON; invalid tab id rejects; clearing history removes it and the agent resumes from a cold state without crashing.
- **Risk:** tiny; mainly session-store write amplification (cap writes to mutations only).

### 4.3 "Point at it" — user-selected element targeting via `menus` — **M, value 5/5, risk 2/5**

- **Design:** a messageable "target mode": user right-clicks an element and chooses *Ask agent about this element* (or the agent UI enters "waiting for a point" mode). The menu `onShown` handler validates the target; a content script resolves `menus.getTargetElement(info.targetElementId)` and returns a normalized anchor `{role, name, text, tag, frame, rect, signature}`. The agent then performs one action against that anchor with the existing stale-target guards (compare signature before click, fail closed on re-render).
- **Hooks:** `extension/background.js` gets menu creation and `menus.onClicked`; new content-script probe function in `extension/sidepanel/browser.js` (must be self-contained per invariant 2, like `findProbe`); executor op `point.target`; provider tool `browser_point` or optional `target` parameter on `browser_click`/`browser_type` in `lib/index.js`; `GUIDANCE` rules for when to request a point instead of guessing.
- **Acceptance check:** a labelled-button page and a shadow-DOM button; user points at each; agent receives the exact role/name and clicks it in one call with no screenshot; after a re-render before the click, the action fails closed with a stale-anchor error instead of clicking a lookalike.
- **Risk:** low; menu clutter and the "targetElementId expired" window must be handled.

### 4.4 Native `find` as the semantic-find fast path + highlight evidence — **S/M, value 4/5, risk 2/5**

- **Design:** in `browser_find` execution, first call `find.find(query, {includeRangeData:true, includeRectData:true})` for a native cross-frame count + rects. If the page is not a normal HTTP(S) page, or the native count is 0 while the JS probe finds matches, fall back to the existing `findProbe`. Add `reveal` via rect→scroll (with the existing revalidation/stale-tab gates) and an optional `highlight` result mode: `highlightResults()`, one fresh screenshot, `removeHighlighting()`.
- **Hooks:** `extension/sidepanel/find.js` (`executeFind` `:84`, `findProbe` `:171` — keep probe as fallback); `browser.js` `findDriver` and `execute` dispatcher; permission `find` in `extension/manifest.json`; tool description in `lib/index.js` (`browser_find` at `:3092`).
- **Acceptance check:** fixture with 3 frames and 5 known occurrences → native count=5 and rects map to the right frames; reveal scrolls to the explicit occurrence; highlight screenshot shows highlights; after `removeHighlighting` a diff shows no residual styling; canvas/Docs pages still report `FIND_CANVAS_UNSUPPORTED`.
- **Risk:** native find state is global-ish per extension (next `find()` replaces results) and browser Ctrl+F may interact; always re-search before highlight.

### 4.5 Network evidence + deterministic mocks via blocking `webRequest`/`filterResponseData` — **L, value 5/5, risk 4/5**

- **Design:** new `browser_network` tool with two modes. **Observe:** record a bounded ring buffer of JSON/XML responses (method, URL, status, content-type, ~64 KB body cap) for the active tab and expose `list`/`read`; the model can read an API response instead of scraping a rendered table. **Mock:** session-scoped rules `{urlPattern, method?, responseBody, status?}` applied through `onBeforeRequest` + `filterResponseData`; mock rules are cleared at turn end and shown in the activity feed. Header rewrite is a third mode for auth/test scenarios.
- **Hooks:** extension background or sidebar `webRequest` listeners (must survive the panel being open; sidebar document is a normal extension context, so this belongs in `browser.js` executor modules); new ops in `browser.js` (`execute` dispatcher); new tool + schema in `lib/index.js`; permissions `webRequest`, `webRequestBlocking`, `webRequestFilterResponse`, host permissions in `extension/manifest.json`; activity/log plumbing in `app.js`.
- **Acceptance check:** fixture page calls `/api/items` and renders a table; agent reads the JSON via `browser_network` and gets the same items without a DOM scrape; a mocked `/api/slow` returns in <50 ms with the requested body; the mock is removed at turn end and the next real navigation gets the network response; no request hangs (assert every filter is closed/disconnected).
- **Risk:** privacy (bodies may contain tokens/PII — must be redacted by default and never logged), AMO review of `webRequestBlocking`, page breakage if a filter throws.

### 4.6 Local pre-summarization / translation with `trial.ml` — **M, value 3/5, risk 3/5**

- **Design:** feature-detected `browser.trial.ml` path in `browser_read_text` (and Docs export): if `summarization` is available and the text exceeds a threshold, summarize locally to the requested token budget; tag the result `summarizedLocally:true` and keep the raw text retrievable by offset so the model can verify. On Chrome this could later use `LanguageModel` (B7) behind the same interface.
- **Hooks:** `extension/sidepanel/browser.js:4096` (`readText`) + a new module; `lib/index.js` `browser_read_text` tool at `:3064` and content formatting; `optional_permissions: ["trialML"]` in `extension/manifest.json`; provider detection/fallback.
- **Acceptance check:** a 25 K-char page with known facts → summary ≤ 2 K chars preserving all facts; with the API unavailable the tool returns raw text and `summarizedLocally:false`; no crash/blocking when the model download fails.
- **Risk:** Nightly/Beta prefs, first-use download, quality regressions on tables/numbers.

### 4.7 Reader-mode extraction scope — **M, value 3/5, risk 2/5**

- **Design:** `browser_read_text scope:"reader"`: if `Tab.isArticle`, call `tabs.toggleReaderMode`, wait for the reader DOM signature, read text, toggle back, verify the original URL/DOM state; else return `isArticle:false` without toggling.
- **Hooks:** `readText` (`browser.js:4096`), `snapshot`/label invalidation on toggle, `lib/index.js` `browser_read_text` schema (`:3064`).
- **Acceptance check:** article page yields body text without nav/footer; non-article reports false and leaves the page byte-identical in a DOM fingerprint; restore verified; stale labels/coordinates invalidated after toggle.
- **Risk:** reader mode changes the user's view mid-task; only run on explicit request or when the alternative is a failed read.

### 4.8 Per-domain / per-tab proxy routing — **M, value 2/5, risk 3/5**

- **Design:** `browser_proxy` tool: set a session proxy for a tab/domain (SOCKS/HTTP, optional auth, `proxyDNS`) using `proxy.onRequest` + filters; fail-open on callback errors; clear on turn end.
- **Hooks:** `browser.js` network module; `lib/index.js` tool; `proxy` permission; companion settings for the proxy endpoint.
- **Acceptance check:** fixture request observed through a local test proxy; other tabs unaffected; callback error leaves direct networking intact.
- **Risk:** one bad callback breaks all browsing; auth header handling.

### 4.9 Determinism profile via `browserSettings` — **S, value 3/5, risk 2/5**

- **Design:** opt-in "agent test mode" toggles `cacheEnabled=false`, `imageAnimationBehavior="none"`, `overrideContentColorScheme` fixed, `zoomFullPage` fixed; restore on exit. Never enabled implicitly in normal user sessions.
- **Hooks:** a settings module + chrome.sidePanel? No: `browser.js` op `settings.apply/restore`; `app.js` UI toggle; `browserSettings` permission; `lib/index.js` doesn't need a model-facing tool if it is a user/debug setting.
- **Acceptance check:** two screenshots of an animated fixture are pixel-identical with the profile and differ without; uninstall/crash recovery restores user settings.
- **Risk:** global prefs mutated; must snapshot and restore on stop/crash.

### 4.10 Focus mode via `tabs.hide`/`show` — **S/M, value 2/5, risk 3/5**

- **Design:** hide agent scratch/automation tabs so the user's strip stays clean; `browser_tabs` reports `hidden`; a "show agent tabs" user action.
- **Hooks:** `browser.js` tab module (`listTabs` `:4335`), a new op; `lib/index.js` `browser_tabs` (`:3129`); `tabHide` permission.
- **Acceptance check:** hide two tabs, verify they keep running (JS timer keeps incrementing), appear with `hidden:true`, cannot hide the active tab, restore works.
- **Risk:** first-use browser notice offering to disable the extension; users may lose track of hidden tabs.

### 4.11 Screenshot/PDF/MHTML artifact parity — **S, value 2/5, risk 1/5**

- **Design:** add a Firefox path to `browser_screenshot` for non-active tabs (`tabs.captureTab`) and a user-gated "save page as PDF" action (`saveAsPDF` with `PageSettings.fileName`). Do not promise unattended PDF; on Chrome only, `pageCapture.saveAsMHTML` could become an archival exporter.
- **Hooks:** `captureVisibleTab`/`snapshot` (`browser.js:2714`, `:3050`); `files.js`/downloads for artifact naming; `lib/index.js` `browser_screenshot` (`:2659`).
- **Acceptance check:** capture a background tab and compare against a foreground capture of the same tab; PDF save returns `saved` and the file appears in Downloads; cancellation returns `canceled` and no stale state.
- **Risk:** OS dialog UX; background-tab capture reliability (UNVERIFIED).

### 4.12 Search-engine selection — **S, value 2/5, risk 1/5**

- **Design:** `browser_search({engine?, query})` using `search.get`/`search.search` when available; fall back to URL construction (current behavior) on Chrome. Return the resulting tab id/URL and a fresh view.
- **Hooks:** `lib/index.js` new tool; `browser.js` op; `search` permission.
- **Acceptance check:** choose a non-default engine, verify the opened results URL belongs to that engine; unknown engine id → precise error listing available engines.
- **Risk:** low.

### 4.13 Sidebar port: per-window panel — **M, value required-for-port, risk 3/5**

- **Design:** move `extension/sidepanel/index.html` + `app.js` into a `sidebar_action` panel; `sidebarAction.open()` from the toolbar action and menus; per-window UI state keyed by `windowId` (`sessions.setWindowValue` is a natural fit). Keep the WebSocket in the sidebar document.
- **Hooks:** new `manifest.json` (`sidebar_action`, remove `side_panel`, `background.scripts` + `service_worker` dual block), `app.js` bootstrap (`:958` `connect()`), `background.js` action click, CSS sizing for sidebar width.
- **Acceptance check:** two windows, one sidebar each; independent conversations; close/reopen panel reconnects and resumes the same DSH session; no duplicate bridge clients.
- **Risk:** sidebar close kills the WS (same as Chrome panel); cannot open without a gesture.

### 4.14 Cheap wins worth batching — **S each**

`tabs.warmup` before `browser_switch_tab`; `Tab.attention` for human handoff; `sessions.forgetClosedTab` after agent-driven navigation; `menus.overrideContext` for a right-click agent menu; `captivePortal.getState`/`onStateChanged` and `dns.resolve` as a pre-flight "why is this page not loading" diagnostic; `clipboard.setImageData` to replace part of the OS-clipboard dance in `system-clipboard.js:54`; `runtime.getFrameId/getDocumentId` to strengthen cross-frame stale-target checks.

---

## 5. Corrections to `firefox-port-audit.md`, explicitly

| # | Old audit claim | Correction | Label |
|---|---|---|---|
| 1 | "Chrome 148+" as version baseline | Chrome stable is **157**; 148 is the `browser.*` alias version | VERIFIED |
| 2 | Implied `captureVisibleTab` is Chrome-only while Firefox has only `captureTab` | Firefox has `captureVisibleTab` 47+ (`activeTab` suffices from 126) **and** `captureTab` 59+ | VERIFIED |
| 3 | `saveAsPDF` "labelled non-working on macOS" | Applies to the 56–80 partial implementation only; 81+ works via OS dialog | VERIFIED |
| 4 | `tabs.query({cookieStoreId})` "since FF 141" | Documented on MDN, **not in BCD 8.1.8**; version unverified | UNVERIFIED |
| 5 | Containers release pref defaults true in `firefox.js` | Not verifiable from docs; MDN says Nightly-default + auto-enable on install-with-permission | UNVERIFIED |
| 6 | "Chrome's sessions has only getRecentlyClosed/restore/onChanged" | Correct, and worth keeping: only the tab/window **values** are Firefox-only | VERIFIED |
| 7 | "message ports do not prevent shutdown" | MDN states the opposite for non-persistent background pages (views + ports keep it alive) | VERIFIED (MDN) |
| 8 | `handlerBehaviorChanged` implied parity | Firefox only became functional in 138 (before: exposed but non-functional) | VERIFIED |
| 9 | Table 1 missed `menus.overrideContext`, `tabs.warmup`, `tabs.print`, `Tab.attention`, `sessions.forgetClosedTab/Window`, `clipboard.setImageData`, `runtime.getFrameId/getDocumentId`, `dns/captivePortal/pkcs11`, enriched `webRequest` detail fields | Added as A15 | VERIFIED |
| 10 | MV2 framed as neutral | Chrome MV2 is gone (Chrome 139; CWS purge 2026-08-31); Firefox MV2 remains documented | Chrome side VERIFIED; Firefox "no EOL" PARTIAL |
| 11 | Chrome AI mentioned without versions | Prompt API in **extensions since Chrome 138**, web 148, hardware-gated | VERIFIED |
| 12 | `userScripts` treated as a Firefox capability (task brief, not audit) | Parity: Chrome 120 / Firefox 136; `execute` Chrome 135 / Firefox 153; different permission models | VERIFIED |
| 13 | `publicSuffix` assumed Firefox-only (brief) | Both 153 | VERIFIED |
| 14 | Panel-window behavior ("all non-normal types create popup") | Not re-verifiable from docs fetched; BCD says the `panel` enum value exists in Firefox since 45 | UNVERIFIED |
| 15 | `find` caveats thin | Adds: HTTP(S)-only pages, all frames, stored/replace-per-find semantics, highlight lifecycle | VERIFIED |

### 5.1 Disposition of the old audit's "uncertain / changed recently" list

| Old uncertain item | Disposition | Label |
|---|---|---|
| `trial.ml` on Release is unverified | Resolved: it is a **trial API**, Nightly-default, and requires `browser.ml.enable` + `extensions.ml.enabled` on Beta/Release; also absent from BCD/MDN | VERIFIED (Firefox Source Docs) |
| Containers default state | Partially resolved: MDN says Nightly-default **and** auto-enable on install-with-permission; the release-pref claim remains unverified | PARTIAL |
| Panel windows (`windows.create({type:"panel"})`) | Still unverified; BCD only confirms the enum value exists (FF 45). Do not build an agent feature on panel windows | UNVERIFIED |
| MV2 end date | No Firefox end-of-life announcement found; Chrome's MV2 is gone (Chrome 139 / CWS purge 2026-08-31), so the asymmetry is real but the Firefox side is an absence-of-evidence claim | PARTIAL |
| Changed 2025–2026 list | Verified individually: tab groups (BCD: `tabs.group` FF138, `tabGroups` FF139), `browserSettings.verticalTabs` FF142, `action.openPopup()` without gesture FF149 and `splitViewId` FF149/150 and WebAuthn RP ID FF150 ([149–152 blog](https://blog.mozilla.org/addons/2026/04/23/webextensions-api-changes-firefox-149-152/)), moz-extension injection removed FF152, file:// opt-in + `documentId` + `userScripts.execute()` + `publicSuffix` FF153 ([153 blog](https://blog.mozilla.org/addons/2026/07/23/firefox-153-webextensions-api-updates/)) | VERIFIED |
| Chrome 148+ `browser.*` namespace | Resolved: VERIFIED (Chrome docs banner + transition guide) | VERIFIED |
| Is there a Chrome `tabs.hide`? | Still no signal; BCD `chrome=false`; Chrome's tabs reference has no hide method. Firefox-only | VERIFIED-absent |

**Residual unknowns (do not build on them):** exact `tabs.query({cookieStoreId})` version; containers pref default in release builds; background-tab reliability of `tabs.captureTab`; Firefox BiDi conformance for `input.setFiles` / screenshot `clip` / `origin: "document"` (needs a spike); Firefox MV2 long-term support beyond "no announced EOL"; whether `menus.onShown`-driven anchors stay valid long enough for a model round-trip (likely requires the one-shot token design above).

---

## 6. Distribution, review, and privacy constraints (Firefox-specific)

1. **AMO data-collection consent is now a manifest obligation.** `browser_specific_settings.gecko.data_collection_permissions` exists since **Firefox 140** (BCD). This agent sends page text, screenshots, and user prompts to a remote model — a Firefox submission must declare that and design the consent flow ([Extension Workshop — Firefox built-in consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)). This is a product-level requirement, not a checkbox.
2. **`trialML` is an optional permission with a trial API**; AMO review will ask what leaves the device (nothing, if implemented as local summarization) and which models are downloaded. Pref-gating on Release means shipping it as an enhancement, never as a dependency (Firefox Source Docs).
3. **`webRequestBlocking` + `contextualIdentities` + `menus` + `tabs` + `host_permissions: <all_urls>`** is a very loud permission set; the AMO listing will show "Access your data for all websites" plus others. The `tabs.hide` first-use notice can offer users a way to disable the extension — expect support burden.
4. **MV2 vs MV3:** AMO accepts both today; MV2 would allow a persistent background page but costs future-proofing. Recommend MV3 with `background.scripts` **and** `service_worker` (cross-browser MDN pattern) and keep the WS in the sidebar.
5. **Chrome side:** the existing `debugger` permission already triggers a strong warning and enterprise policy can block attach (B12); Chrome MV3 is mandatory. Any Firefox port should not assume Chrome's `debugger` UX is acceptable to users long-term.

---

## 7. Verdict — one page

### Top 5 Firefox-only wins to build first

1. **Containers (A1 / 4.1).** The only extension-level multi-account isolation available to a browser agent on either engine. Directly increases task success on authenticated workflows and protects the user's main cookies. Effort L, value highest.
2. **Per-tab durable memory via `sessions` (A2 / 4.2).** Smallest possible change with immediate reliability payoff: resumed tasks after tab close/restore, no re-derivation from screenshots. Effort S.
3. **Point-at-element via `menus.getTargetElement` (A3 / 4.3).** A new, model-facing way to target hard-to-label elements and canvas-adjacent UI; also gives the user a concrete way to steer the agent. Effort M.
4. **Native `find` + highlight evidence (A5 / 4.4).** Cheaper cross-frame search, rects, and visual proof of "where", with the existing JS probe as fallback. Effort S/M.
5. **Blocking `webRequest` + `filterResponseData` network evidence/mocks (A6 / 4.5).** The largest new sensing channel this agent can get on any engine: read JSON instead of scraping, and deterministic fixtures without CDP. Effort L, risk highest.

### Top 5 parity gaps that actually threaten the product

1. **`chrome.debugger` has no Firefox equivalent (B1).** Trusted input, native-dialog control, full-page screenshots, and CDP file-input assignment all disappear. Canvas/Docs automation — 8 of 32 tools plus the whole surface-input strategy — depends on trusted input. The only mitigation is WebDriver BiDi to a Firefox started with `--remote-debugging-port`, owned by the companion (single session); it restores pointer/key input, dialogs, screenshots and `setFiles`, but **`Input.insertText` has no BiDi equivalent**, so Docs bulk typing is the go/no-go unknown. **Severity: critical; the port is not viable without this decision plus a Docs typing spike.**
2. **Side-panel UX: per-tab panels and programmatic open/close (B4).** Firefox sidebars are per-window and gesture-opened; Chrome can open/close per tab and observe layout/open events. Single-panel architecture survives, but per-tab conversations and auto-open flows need redesign. **Severity: medium.**
3. **Local AI surface (B7 vs A14).** Chrome has a stable Gemini Nano Prompt API for extensions (138+) with documented hardware gates; Firefox's `trial.ml` is pref-gated outside Nightly. Any token-saving feature must have a no-AI fallback and cannot be promised to Firefox Release users. **Severity: medium.**
4. **Artifact asymmetry (A11 vs B9).** Firefox `saveAsPDF` is user-dialog-bound; Chrome has `pageCapture.saveAsMHTML` returning a Blob. If "save the page/report" becomes a product feature, Firefox needs a different artifact pipeline. **Severity: low-medium.**
5. **Distribution/privacy friction (B12/§6).** AMO's `data_collection_permissions` (FF 140+) and review of `webRequestBlocking`/`trialML` add release overhead; Chrome's `debugger` permission is already a hard review/hardware-policy friction. Neither is a technical blocker, but both are product commitments. **Severity: medium.**

### UNSUPPORTED on Firefox (extension-only)

- `chrome.debugger` / CDP attach, `chrome.tabCapture` MediaStream, `chrome.offscreen` documents, `chrome.sidePanel`, `chrome.identity.getAuthToken`, `chrome.tts`, `chrome.desktopCapture`, `chrome.declarativeContent`, `chrome.gcm`/`instanceID`, `chrome.pageCapture` MHTML, `chrome.printing`, `chrome.devtools.*` resource content, `tabs.onReplaced`, `Tab.pendingUrl`, `tabs.setZoomSettings`, `tabGroups.TabGroup.shared`, `storage.session.setAccessLevel`, `background.service_worker`.
- Trusted synthetic input, native JS-dialog interception, beyond-viewport CDP screenshots, and CDP file-input assignment are **not reachable from an installed Firefox extension** (and even on the BiDi path, `Input.insertText` has no equivalent). They are reachable only with a companion-managed WebDriver BiDi session against a Firefox launched with `--remote-debugging-port` (Remote Agent: loopback-only, no auth, BiDi-only protocol, all release channels) — a deployment decision, not an API detail.

### UNSUPPORTED on Chrome (for symmetry)

- Blocking `webRequest` (except policy-installed), `filterResponseData`, containers/`cookieStoreId`, `sessions` tab/window values, `menus` element targeting/overrideContext, native `find`, `browserSettings`, `search.get/search`, `proxy.onRequest`, `tabs.captureTab`, `tabs.warmup`, `tabs.toggleReaderMode`, `cookies.firstPartyDomain`, MV2 persistent backgrounds.

### Recommended next step (not part of the deliverable)

Run two spikes before committing to a Firefox port: (1) **BiDi trusted-input spike** — launch Firefox 159 with `--remote-debugging-port`, attach WebDriver BiDi from the companion, and verify `input.performActions`, `browsingContext.captureScreenshot` (clip/origin), and `input.setFiles` against a CDP-equivalent fixture; (2) **containers + sessions spike** — prove account isolation and tab-value restore round-trips on a clean profile. Both are days, not weeks, and they decide the port's architecture.
