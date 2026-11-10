# Firefox port inventory — module-by-module, every Chrome call site, and the 32-tool portability map

**Status:** research deliverable, read-only. No product code was modified. Only this file was written.
**Date:** 2026-11-04.
**Scope:** port the surface-panel agent in `/home/conan/Documents/GitHub/crazyAgent` to Firefox. Inventory covers `extension/background.js`, `extension/sidepanel/*.js`, `extension/manifest.json`, `companion/*.mjs`, `packages/dsh-browser-extension/lib/*.js`.
**Baseline (VERIFIED):** Firefox stable **159.0.1**, ESR **153.6.0esr**, Beta **160.0b4**, Nightly **161.0a1** — [product-details JSON](https://product-details.mozilla.org/1.0/firefox_versions.json), fetched 2026-11-04.
**Method:** every `chrome.*` occurrence in production JS was extracted with line numbers by script (not by eye). Every Chrome→Firefox compatibility claim below was checked against MDN's compat data, whose source of truth is browser-compat-data (BCD); MDN pages render the same tables client-side, so the BCD JSON files were fetched from the `mdn/browser-compat-data` `main` branch on 2026-11-04 and are cited alongside the corresponding MDN page. A parse of the repo's `chrome` tokens is reproducible: 126 lexical `chrome.*` occurrences = 103 runtime call sites + 21 JSDoc/type-only references + 2 occurrences inside error-message strings.

**Labels used below**
- **VERIFIED** — confirmed against an official MDN/BCD or Firefox source fetched on 2026-11-04; URL given.
- **PARTIAL** — confirmed at API level, but a version nuance or runtime behaviour detail is unresolved.
- **UNVERIFIED** — plausible but not confirmed; do not make it a milestone without a spike.

**Naming convention:** bare `browser.js:NNN` = `extension/sidepanel/browser.js`; `app.js:` = `extension/sidepanel/app.js`; `dialogs.js:`/`files.js:`/`table.js:`/`find.js:`/`role-click.js:`/`docs-export.js:`/`capture.js:`/`clipboard.js:`/`system-clipboard.js:` = same directory; `background.js:` = `extension/background.js`; `manifest.json:` = `extension/manifest.json`; `provider:` = `packages/dsh-browser-extension/lib/index.js`; `bridge.mjs:` = `companion/bridge.mjs`.

---

## 0. What counts as a "Chrome-only construct" here

Three separate questions, kept separate throughout:

1. **API availability.** Does the namespace exist in Firefox at all? `chrome.debugger` does not ([MDN Chrome incompatibilities — Debugger API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#debugger_api), **VERIFIED**); `chrome.sidePanel` has no Firefox analogue (the analogue is `sidebarAction`, **VERIFIED**).
2. **Call style.** Firefox supports the `chrome.*` namespace "primarily to assist with porting", but its promised/promise-returning API is `browser.*` ([MDN — Build a cross-browser extension §API namespace](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension#api_namespace), **VERIFIED**). The repo calls `await chrome.*` / `.then()` on `chrome.*` in **60** places — those are call-style breakages even where the underlying API exists.
3. **Semantics.** Same API, different options/fields/events (e.g. `Tab.pendingUrl` absent, `history` `typedCount` absent, download `filename` is an absolute path). Detailed in §3.

### 0.1 Headline counts

| Metric | Count | Definition |
|---|---|---|
| Lexical `chrome.*` occurrences (prod JS) | **126** | background.js 6, browser.js 93, dialogs.js 11, app.js 12, clipboard.js 3 (doc-only), role-click.js 1 (doc-only) |
| Runtime `chrome.*` call sites | **103** | excludes JSDoc `{chrome.tabs.Tab}` types and error strings |
| — promise-dependent (`await`, `.then`, `.catch`) | **60** | 57 `await chrome.*` + 2 `.catch()` + 1 `.then()` |
| — event listener registration/removal | **22** | `addListener`/`removeListener` (incl. optional-chained `chrome.tabs?.onRemoved?.addListener`), callback-style, Firefox-compatible |
| — property access / capability guards / references | **21** | e.g. `chrome.tabs.get` passed as a callback, `chrome.storage?.session`, `typeof chrome.downloads.download` |
| Chrome-only API call sites (no Firefox equivalent) | **40** | 39 × `chrome.debugger.*` + 1 × `chrome.sidePanel.*` |
| CDP command sends (`chrome.debugger.sendCommand`) | **32** | 12 distinct protocol commands, all in browser.js + dialogs.js |
| CDP session sites (attach/detach/events) | **7** | attach 1, detach 1, `onDetach` 3, `onEvent` 2 |
| Distinct CDP commands | **12** | + 2 CDP events consumed (`Page.javascriptDialogOpening`/`Closed`) |
| `chrome.tabs.captureVisibleTab` sites | **1** | browser.js:2692 — **Firefox does support this API**, so it is not Chrome-only (VERIFIED) |
| Model-facing tools | **32** | 24 general + 8 Docs (`provider:` 2659–4017) |

---

## 1. Exact Chrome-specific construct inventory

### 1.1 Per-file distribution of runtime `chrome.*` references

| File | LOC | runtime refs | of which promise-style (`await`+`.then`/`.catch`) | listener regs | Chrome-only |
|---|---:|---:|---:|---:|---:|
| `extension/background.js` | 34 | 6 | 1 (`await chrome.sidePanel…`) | 3 (`runtime.onInstalled/onStartup/onMessage`) | 1 (`sidePanel`) |
| `extension/sidepanel/browser.js` | 10,170 | 74 | 50 (49 await + 1 `.then`) | 7 | 32 (all `debugger`) |
| `extension/sidepanel/dialogs.js` | 265 | 11 | 2 | 8 | 7 (all `debugger`) |
| `extension/sidepanel/app.js` | 3,350 | 12 | 7 (5 await + 2 `.catch`) | 4 | 0 |
| `extension/sidepanel/clipboard.js`, `role-click.js` | 170 / 893 | 0 | 0 | 0 | 0 (comment references only) |
| `companion/*.mjs` | 3,472 | 0 | 0 | 0 | 0 (one comment at `bridge.mjs:5`) |
| `packages/dsh-browser-extension/lib/*.js` | 4,901 | 0 | 0 | 0 | 0 |
| **Total** | | **103** | **60** | **22** | **40** |

Note: browser.js contains 19 `chrome.*` refs that are comments/type annotations only (17 JSDoc + 2 error strings); database totals above exclude them. The full grouped table follows.

### 1.2 Complete runtime call-site table (file:line)

Grouped by API and call style; line lists are exhaustive for production code. `await` means the call's return value is awaited — this is the list that must be converted to a Firefox promise API (§3.1).

| API | style | n | call sites |
|---|---|---:|---|
| `chrome.debugger.attach` | await | 1 | browser.js:454 |
| `chrome.debugger.detach` | await | 1 | browser.js:472 |
| `chrome.debugger.onDetach` | listener | 3 | browser.js:481, dialogs.js:62, dialogs.js:70 |
| `chrome.debugger.onEvent` | listener | 2 | dialogs.js:61, dialogs.js:69 |
| `chrome.debugger.sendCommand` | await | 24 | browser.js:634, 635, 636, 642, 643, 644, 654, 658, 676, 2932, 2948, 2975, 5480, 5481, 5845, 5848, 5857, 5867, 9920, 9921, 9938, 9984, dialogs.js:82, 255 |
| `chrome.debugger.sendCommand` | other (arrow body inside `withDebugger`/`Promise.race`) | 8 | browser.js:650, 2880, 5165, 5195, 5221, 5993, 7206, dialogs.js:156 |
| `chrome.tabs.query` | await | 3 | browser.js:275 (`{windowId, active:true}`), browser.js:4336 (`{windowId}`), app.js:2840 (`{windowId: win.id, active:true}`) |
| `chrome.tabs.get` | await | 10 | browser.js:1784, 4372, 4398, 4918, 4957, 4966, 5568, 5633, 9812, 10154 |
| `chrome.tabs.get` | promise (`.then`) | 1 | browser.js:301 |
| `chrome.tabs.get` | reference passed as callback | 2 | browser.js:981 (`getTab: tabId => chrome.tabs.get(tabId)`), browser.js:7201 |
| `chrome.tabs.create` | await | 1 | browser.js:5597 |
| `chrome.tabs.update` | await | 2 | browser.js:4407 (`{active:true}`), browser.js:5612 (`{url}`) |
| `chrome.tabs.goBack` | await | 1 | browser.js:5618 |
| `chrome.tabs.goForward` | await | 1 | browser.js:5619 |
| `chrome.tabs.reload` | await | 1 | browser.js:5620 |
| `chrome.tabs.captureVisibleTab` | promise (`.then`) | 1 | browser.js:2692 — **Firefox-supported API**, see §3.12 |
| `chrome.tabs.onUpdated` | listener | 3 | browser.js:292 (remove), browser.js:300 (add), app.js:3315 (add) |
| `chrome.tabs.onActivated` | listener | 3 | browser.js:4415 (remove), browser.js:4423 (add), app.js:3314 (add) |
| `chrome.tabs.onRemoved` | listener | 1 | app.js:3318 |
| `chrome.webNavigation.getAllFrames` | await | 1 | browser.js:810 |
| `chrome.scripting.executeScript` | other (promise inside `Promise.race`) | 3 | browser.js:318, browser.js:355, browser.js:788 |
| `chrome.storage.local` | await | 3 | app.js:214, app.js:226, app.js:441 |
| `chrome.storage.local` | promise (`.catch`) | 1 | app.js:453 |
| `chrome.storage?.session` | property access + guard | 1 | browser.js:6075 (used by 6085/6092/6101) |
| `chrome.downloads.download` | await | 1 | browser.js:9864 |
| `chrome.downloads.download` | typeof guard | 1 | browser.js:9861 |
| `chrome.downloads.search` | await | 1 | browser.js:9834 |
| `chrome.downloads.search` | capability guard | 1 | browser.js:9824 |
| `chrome.downloads.cancel` | await | 1 | browser.js:9852 |
| `chrome.downloads.onCreated` | listener | 2 | browser.js:9892 (add), browser.js:9912 (remove) |
| `chrome.downloads.onCreated` | capability guard | 1 | browser.js:9878 |
| `chrome.windows.getCurrent` | await | 2 | browser.js:260, app.js:2839 |
| `chrome.windows.getLastFocused` | await | 1 | browser.js:265 |
| `chrome.windows?.update?.` | await | 1 | browser.js:2731 (`{focused:true}` retry after capture timeout) |
| `chrome.windows.onFocusChanged` | listener | 1 | app.js:3319 |
| `chrome.runtime.sendMessage` | promise (`.catch`) | 1 | app.js:948 (activity badge ping) |
| `chrome.runtime.getManifest` | other | 1 | app.js:1091 (`.version` only) |
| `chrome.runtime.onInstalled` | listener | 1 | background.js:14 |
| `chrome.runtime.onStartup` | listener | 1 | background.js:17 |
| `chrome.runtime.onMessage` | listener | 1 | background.js:21 |
| `chrome.action.setBadgeBackgroundColor` | other | 1 | background.js:24 |
| `chrome.action.setBadgeText` | other | 1 | background.js:25 |
| `chrome.sidePanel.setPanelBehavior` | await | 1 | background.js:7 |

### 1.3 Non-API Chrome-specific constructs in product code

| Construct | Location | Firefox impact |
|---|---|---|
| Protected-URL prefix list: `chrome://`, `edge://`, `about:`, `chrome-extension://`, `devtools://`, `view-source:`, `https://chrome.google.com/webstore`, `https://chromewebstore.google.com` | browser.js:239–250 | Must add `moz-extension://` and `https://addons.mozilla.org` (Firefox restricts extension injection there); `chrome://`/`edge://`/webstore branches become dead but harmless. **PARTIAL** — Firefox's restricted-page set is documented per-API on MDN; exact AMO injection restriction is **VERIFIED** only by MDN's general content-script guidance ([MDN content scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)). |
| Error/UX copy that names Chrome surfaces: `chrome://extensions` hint (browser.js:6039), "Chrome did not report a window" (browser.js:266), "Chrome could not run in this tab" (browser.js:331), "Chrome cannot start direct downloads…" (browser.js:9861), "Chrome downloads access…" (browser.js:9825) | grep `Chrome ` in browser.js | Cosmetic, but the `chrome://extensions` hint must become `about:addons`. **VERIFIED** (Firefox add-on manager URL is `about:addons`, [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities) — no functional change). |
| Chrome-specific capture-error regexes: `/quota\|MAX_CAPTURE_VISIBLE_TAB/i` and `/image readback failed\|failed to capture tab/i` | browser.js:2742–2743 | Firefox throws different errors; the quota-retry path would be inert. **VERIFIED** structural claim only (regex is Chrome-documented error text; Firefox error strings are not documented → replacement strings **UNVERIFIED**). |
| Extension identity assumptions: `chrome-extension://<id>` in dev harness (`scripts/edge-e2e.mjs:44–52`); unpacked-id derivation from sha256 of the extension path (`scripts/edge-e2e.mjs:13–18`) | dev scripts, not product | Firefox uses `moz-extension://<random-UUID>` unless `browser_specific_settings.gecko.id` is pinned ([MDN — manifest key](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#manifest_key_property), **VERIFIED**). |
| `navigator.userAgent` collected and sent to the companion | app.js:1097, app.js:3326 | Logged only — no branch found in the repo (grep for `userAgent` in companion/provider returns nothing). Portable. |
| `chrome` naming in comments/types (`@param {chrome.tabs.Tab}` etc.) | 21 occurrences | JSDoc only; a rename to `browser.*` types is optional. |

### 1.4 The CDP layer: every command, every caller

There is exactly one transport helper (`withDebugger`, browser.js:572), one raw sender (`chrome.debugger.sendCommand`) and one session manager (`dialogManager`, dialogs.js:25). All Chrome-only execution capability flows through them.

**Distinct CDP commands (12) and where they are used**

| CDP command | sends | primary call sites | purpose / consumer |
|---|---:|---|---|
| `Input.dispatchMouseEvent` | 14 | browser.js:634–636 (`trustedClick`), 642–644 (`docsTrustedClick`), 650/654/658 (`roleTrustedClick`), 676 (`trustedWheel`), 5845–5867 (`trustedDrag`) | trusted ordinary clicks, Docs clicks, role-click clicks, wheel scroll, selection drag |
| `Input.insertText` | 6 | browser.js:5165 (`trustedTypeIntoLabel`), 5195 (`trustedTypeIntoFocus`), 5221 (label-less typing), 5993 (`trustedTypeIntoFallbackTarget`), 7206 (Docs driver default), 9984 (`tableDriver.editCell`) | trusted text entry everywhere; Docs insert; table cell writes |
| `Input.dispatchKeyEvent` | 2 | browser.js:5480, 5481 (`dispatchTrustedKey`) | every key press; Docs menu/keystroke primitives; table Enter/Tab/Ctrl+A/Backspace; `pressEnter` (browser.js:5256) |
| `Page.handleJavaScriptDialog` | 2 | dialogs.js:156 (auto-accept alert/beforeunload), dialogs.js:255 (`browser_dialog` resolve) | native dialog control |
| `Page.captureScreenshot` | 1 | browser.js:2880 (`pageScreenshotCommand`) | full-page and region captures (`capturePageImage`, browser.js:2925) |
| `Page.getLayoutMetrics` | 1 | browser.js:2932 | full-page size |
| `Emulation.setDeviceMetricsOverride` | 1 | browser.js:2948 | full-page viewport resize |
| `Emulation.clearDeviceMetricsOverride` | 1 | browser.js:2975 | restore after full-page capture |
| `DOM.enable` | 1 | browser.js:9920 | upload discovery preamble |
| `DOM.getDocument` (pierce) | 1 | browser.js:9921 | find marked file input incl. shadow roots/frames |
| `DOM.setFileInputFiles` | 1 | browser.js:9938 | assign file to input (`browser_upload`) |
| `Page.enable` | 1 | dialogs.js:82 | enable dialog events on attach |

**CDP events consumed (2):** `Page.javascriptDialogOpening`, `Page.javascriptDialogClosed` — handled in `DialogManager.onDebuggerEvent` (dialogs.js:173–198).

**Helper call graph (callers of the helpers)**

| Helper | def | direct callers (n) |
|---|---|---|
| `withDebugger` | browser.js:572 | 14 call sites: 2927 (`capturePageImage`), 3765 (`scroll` wheel), 4763 (`clickAt`), 5165/5195/5221 (typing), 5256 (`pressEnter`), 5499 (`pressKey`), 5607 (`navigate`), 5930 (`selectRange`), 5993 (`trustedTypeIntoFallbackTarget`), 7204 (Docs driver), 9811 (`resolveDialog`), 9917 (`setFileInputByToken`), 9973 (`tableDriver.editCell`) |
| `trustedClick` | browser.js:631 | 1 (browser.js:4764, inside `clickAt`) |
| `trustedWheel` | browser.js:675 | 1 (browser.js:3765, `scroll` fallback) |
| `trustedDrag` | browser.js:5844 | 1 (browser.js:5930, `selectRange`) |
| `dispatchTrustedKey` | browser.js:5469 | 6 (browser.js:5256, 5499, 9978, 9982, 9983, 9985; plus Docs via driver at 7205/7268) |
| `docsTrustedClick` | browser.js:640 | Docs driver default (browser.js:7207); used by `docsClick` (browser.js:7307) |
| `roleTrustedClick` | browser.js:648 | role-click driver (browser.js:985); passed to `clickRole` (role-click.js:880) |
| `insertTrustedText` | browser.js:7206 | Docs flows via `context.driver.insertTrustedText` (browser.js:7278 and callers) |
| `DialogManager` | dialogs.js:25 | instantiated browser.js:436; methods called throughout browser.js (attach 463, detach 474, pending 439, racePending 305/317/354/2774/5625, resolve 9811) |

**Tools → CDP dependency map (summary; details in §5)**

| CDP capability | Tools that cannot be at parity without it |
|---|---|
| trusted mouse (`Input.dispatchMouseEvent` press/release/move) | `browser_click_at`, `browser_select`, `browser_click_role`, all canvas/Docs coordinate actions |
| trusted text (`Input.insertText`) | `browser_type` (label-less/canvas; labelled fallback), `browser_table` write, all 8 Docs mutation tools, `browser_clipboard` paste/rich paste, `browser_press_key` via `pressEnter` |
| trusted keys (`Input.dispatchKeyEvent`) | `browser_press_key`, `browser_type` submit, `browser_table` cell edit, all Docs tools |
| `Page.handleJavaScriptDialog` + dialog events | `browser_dialog`; auto-accept of `alert()`; beforeunload handling inside `navigate` |
| `Page.captureScreenshot` + layout/Emulation | `browser_screenshot` full-page and region scopes |
| `DOM.*` file input | `browser_upload` |

---

## 2. Manifest conversion

### 2.1 Current manifest, annotated (manifest.json:1–46)

| # | Key | Value | Firefox MV3 verdict |
|---:|---|---|---|
| 2 | `manifest_version` | `3` | Supported (MV3 exists in Firefox; event-page background is the norm). **VERIFIED** ([MDN manifest.json](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json)). |
| 6 | `minimum_chrome_version` | `116` | Chrome-only key; Firefox ignores unknown top-level keys with a warning and drops it. Remove; use `browser_specific_settings.gecko.strict_min_version`. **VERIFIED** that Chrome-only keys are dropped by `runtime.getManifest` (BCD: getManifest note "removes unsupported keys", [BCD runtime.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/runtime.json)). |
| 7–20 | `permissions` | sidePanel, tabs, scripting, storage, clipboardRead, clipboardWrite, debugger, downloads, webNavigation, topSites, bookmarks, history | Two are Chrome-only (`sidePanel`, and `debugger`'s API is unimplemented); see mapping table §2.2. |
| 21–23 | `host_permissions` | `<all_urls>` | Supported in MV3 Firefox. **VERIFIED** ([MDN permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions): "Manifest V3 or higher: install time request with the `host_permissions` manifest key"). |
| 24–27 | `background` | `{service_worker: "background.js", type: "module"}` | **`service_worker` is unsupported in Firefox** (`firefox: false` in BCD). Use `background.scripts` (+ `page` alternative). `type: "module"` is supported from Firefox **112**; `background.js` has no `import`/`export`, so the module flag can simply be dropped. **VERIFIED** ([BCD manifest/background.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/background.json): `service_worker` firefox false; `scripts` firefox 48; `type` firefox 112). |
| 28–33 | `icons` | 16/32/48/128 PNG | Supported. **VERIFIED** ([MDN manifest icons](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/icons)). |
| 34–42 | `action` | default_title + default_icon | Supported in MV3 Firefox from **109**. **VERIFIED** ([BCD action.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/action.json): `action` firefox 109). |
| 43–45 | `side_panel` | `{default_path: "sidepanel/index.html"}` | **No Firefox support**; replace with `sidebar_action: {default_panel, default_title, default_icon}` (Firefox **54+**). **VERIFIED** ([BCD manifest/sidebar_action.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/sidebar_action.json); [MDN Chrome incompatibilities §Sidebar API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#sidebar_api)). |

### 2.2 Permissions mapping table

| manifest permission | Firefox MV3 | Notes / action | Verification |
|---|---|---|---|
| `sidePanel` | **not a permission** | Delete. Panel is declared by `sidebar_action`; no permission string exists. Programmatic open uses `sidebarAction.open()` but only inside a user-action handler. | **VERIFIED** ([MDN sidebarAction.open](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open): "You can only call this function from inside the handler for a user action"); manifest key has no permission. |
| `debugger` | **API not implemented** | Delete. Requesting an unknown permission is not useful; the `chrome.debugger` API object does not exist in Firefox. | **VERIFIED** ([MDN Chrome incompatibilities — Debugger API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#debugger_api): "Chrome's debugger API is not implemented"). |
| `tabs` | keep | Grants `Tab.url/title/favIconUrl` without host permission; repo also has `<all_urls>`. | **VERIFIED** ([MDN permissions §API permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions)). |
| `scripting` | keep | Required for `scripting.executeScript`; Firefox 102+ (MV2 too from 102). | **VERIFIED** ([BCD scripting.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/scripting.json): firefox 102). |
| `storage` | keep | Includes `storage.session` only from Firefox **115**. | **VERIFIED** ([BCD storage.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/storage.json): `session` firefox 115). |
| `clipboardRead` | keep | Enables `navigator.clipboard.read/readText` in extension contexts without a transient user gesture in Firefox. | **VERIFIED** ([MDN Interact with the clipboard §Reading](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Interact_with_the_clipboard#reading_from_the_clipboard): clipboardRead enables reading "without user confirmation or transient activation" in Firefox). |
| `clipboardWrite` | keep | Enables `navigator.clipboard.write/writeText` outside a short-lived user handler. | **VERIFIED** (same page §Writing). |
| `downloads` | keep | `downloads.download/search/cancel/onCreated` all Firefox 47/48+. | **VERIFIED** ([BCD downloads.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/downloads.json)). |
| `webNavigation` | keep | Only `getAllFrames` used, Firefox 47+. | **VERIFIED** ([BCD webNavigation.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/webNavigation.json)). |
| `topSites` | keep | `topSites.get()` Firefox **52+** (not 45). | **VERIFIED** ([BCD topSites.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/topSites.json)). |
| `bookmarks` | keep | `getTree` 45+, `search` 47+. | **VERIFIED** ([BCD bookmarks.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/bookmarks.json)). |
| `history` | keep | `history.search` Firefox **49+**. | **VERIFIED** ([BCD history.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/history.json)). |
| `<all_urls>` host permission | keep | Needed for `scripting.executeScript` and `tabs.captureVisibleTab` on arbitrary pages. | **VERIFIED** ([MDN scripting.executeScript](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript): host permission or activeTab required). |

Additional manifest keys Firefox needs: `browser_specific_settings.gecko.id` (stable `moz-extension://` UUID for e2e/storage continuity) and `browser_specific_settings.gecko.strict_min_version`. **VERIFIED** requirement/behaviour: Firefox extensions can fix their ID through `browser_specific_settings.gecko.id` ([MDN Chrome incompatibilities §Manifest "key" property](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#manifest_key_property)).

### 2.3 Background model: service worker → MV3 event page

- Firefox MV3 never runs a service worker: `background.service_worker` is unsupported; `background.scripts` or `background.page` is required. **VERIFIED** (BCD background.json: `service_worker` firefox false; `scripts` firefox 48). `"type": "module"` works from Firefox 112 **VERIFIED** (same file), and `background.js` is import-free (`background.js:1–33`), so the port can use plain `{"scripts": ["background.js"]}`.
- MV3 event pages are non-persistent and can be suspended; **`persistent: true` is MV2-only** and errors in MV3. **VERIFIED** (BCD background.json `persistent`: "Available for use in Manifest V2 only", Firefox 48+; MDN background page notes non-persistent event pages).
- The current architecture is unusually friendly here: the bridge WebSocket lives in the **panel document**, not the background (`app.js:958 connect()`, `app.js:985 new WebSocket(settings.bridgeUrl)`; background.js only sets badge/panel behaviour). So event-page suspension does **not** disconnect the agent while the sidebar is open. The risk is only the action-badge path and any future background state. **VERIFIED by code reading**; Firefox event-page idle-suspend timing is **UNVERIFIED** (no doc number in this inventory).
- Replacement for `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})` (background.js:7): there is no equivalent. In Firefox, clicking the toolbar `action` does not open the sidebar by default; add an `action.onClicked` handler that calls `sidebarAction.open()` (requires the click to be a user action — **VERIFIED**, sidebarAction/open page), or rely on the built-in sidebar button the user pins manually. `sidebar_action.open_at_install` (Firefox 62) can open it once at install. **VERIFIED** ([BCD manifest/sidebar_action.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/sidebar_action.json)).
- `runtime.onInstalled` (background.js:14) and `runtime.onStartup` (background.js:17) exist in Firefox 52 **VERIFIED** (BCD runtime.json); they can keep firing the badge/panel setup.

### 2.4 MV2 persistent-background alternative and tradeoffs

MV2 is still supported by Firefox (no announced end-of-life in this repo's prior research; **UNVERIFIED** independently — treat as "supported today, no guarantee"). MV2 would give a **persistent background page** (`persistent: true`) where a WebSocket/state can live indefinitely, which removes the event-page suspension question. Tradeoffs:

| | MV3 (`background.scripts` event page) | MV2 (`background.scripts`, `persistent: true`) |
|---|---|---|
| Panel | `sidebar_action` (same) | `sidebar_action` (same) |
| Toolbar | `action` | `browser_action` (API rename in background/UI code) |
| Host permissions | `host_permissions` | inside `permissions` (repo must fork the manifest anyway) |
| Background lifetime | non-persistent; suspended when idle; wakes on events | persistent while browser runs |
| WebSocket keepalive | not needed today (WS in sidebar doc) | trivially works if moved to background |
| AMO/distribution | accepted | accepted today, **UNVERIFIED** long-term |
| Code impact | smallest: `background.js` 1-line behaviour change + manifest key swap | larger: `action`→`browser_action` in `background.js:24–25`, host perms move, MV2/MV3 API branching |
| Recommended | **yes** — no background state to preserve; MV3 is the forward path | only if a future milestone needs a persistent socket/state outside the sidebar |

---

## 3. API semantics deltas that will bite

### 3.1 `chrome.*` callback style vs `browser.*` promise style — 60 call sites

Firefox supports `chrome.*` "primarily to assist with porting", but **`browser.*` is the promise API**; Firefox supports promises on all asynchronous APIs. **VERIFIED** ([MDN Build a cross-browser extension §API namespace and §API asynchronous event handling](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension#api_namespace), which states: "Firefox also supports the chrome.* namespace for APIs that are compatible with Chrome, primarily to assist with porting… In addition to being the proposed standard, browser.* uses promises" and "Firefox and Safari support promises on all asynchronous APIs."). The same page notes **Chrome 148 added the `browser` namespace** (Chrome 152 for extensions with a devtools page), so a single `browser.*` codebase is now dual-compatible for a modern Chrome baseline.

Consequence: the **60 promise-style call sites** in §1.2 would receive `undefined`/callback-only behaviour under Firefox's `chrome` namespace. The three worst are the ones that attach `.catch`/`.then` to a value that would not be a promise:

- `app.js:453` — `void chrome.storage.local.set(...).catch(...)` → `TypeError` at the `void` boundary (history persistence silently dies).
- `app.js:948` — `chrome.runtime.sendMessage(...).catch(...)` inside a `try` (badge ping dies silently).
- `browser.js:301` — `chrome.tabs.get(tabId).then(...)` in `waitForTabComplete` (load-wait never observes completion; falls back to timeout).

Recommended porting form (small, testable, keeps Chrome 116 working): a single lazy resolver and mechanical rename:

```js
// extension/sidepanel/browser-api.js  (new, ~20 LOC)
export const api = () => globalThis.browser ?? globalThis.chrome
export const can = () => ({
  debugger: Boolean(api().debugger?.sendCommand),
  captureVisibleTab: typeof api().tabs?.captureVisibleTab === 'function',
  session: Boolean(api().storage?.session),
})
```

Resolving **at call time** is essential: unit tests install `globalThis.chrome` after import (see §6.1), so a module-level `const api = …` captured at import would defeat the existing mock seam. Alternatives: bundle Mozilla's `webextension-polyfill` (works with `chrome.*`; **VERIFIED** recommendation, same MDN page) — heavier (~10 KB) and unnecessary when `browser.*` exists in both targets.

### 3.2 `runtime.onMessage` / `sendResponse` / `return true`

`background.js:21–35` uses `return true` after `sendResponse(...)`. Firefox supports this Chrome-style synchronous/async `sendResponse` pattern (all browsers support callbacks), and additionally supports returning a **Promise** from the listener (Firefox ≤62, Chrome not yet per BCD). **VERIFIED** ([BCD runtime.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/runtime.json) `onMessage.return_promise`: firefox "≤62", chrome false; [MDN Build a cross-browser extension §asynchronous event handling](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension#api_asynchronous_event_handling): "A Promise as the return value from an event handler is supported in Firefox and Safari, but not yet in Chrome"). No change required; the `activity`/`open-settings` messages (background.js:21–35) port as-is.

### 3.3 `storage.session` (virtual clipboard)

`browser.js:6073–6102` uses `chrome.storage.session` as the only backing store for the virtual clipboard (read/write/remove; fallback `set({key: undefined})` when `remove` is missing). Firefox: `storage.session` exists from **115**, is memory-only, defaults to 10 MB, is **not exposed to content scripts by default**, and is cleared when the browser stops or the extension is disabled/uninstalled. **VERIFIED** ([BCD storage.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/storage.json) `session` firefox 115; [MDN storage.session](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session): "stored in memory", "10 MB", "not exposed to content scripts", "cleared when the browser stops… extension is disabled or uninstalled"). `storage.session.setAccessLevel()` is **not supported in Firefox** (`firefox: false`, BCD storage.json) — the repo never calls it, so no change; do not add it for content-script access. The virtual clipboard's 6 MB image cap (`clipboard.js:21`) fits the 10 MB quota.

### 3.4 `tabs` API details

| API used | Firefox | Notes |
|---|---|---|
| `tabs.query({windowId, active})` / `tabs.query({windowId})` | API Firefox 45; `queryInfo.active` 45 **VERIFIED** (BCD tabs.json, jsDelivr snapshot); `queryInfo.windowId` documented by MDN but its minimum version was **not extracted** (the tabs.json fetch truncated before that key) → **UNVERIFIED version, VERIFIED availability** in current Firefox ([MDN tabs.query](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/query)). | Used to resolve the "current window" tab (`browser.js:275`, `:4336`, `app.js:2840`). On Firefox this is correct from a sidebar document; behaviour detail **UNVERIFIED**. |
| `tabs.get` | 45 **VERIFIED** (BCD tabs.json). | 13 sites. Error shape on missing tab differs (Firefox rejects with a message); code only `.catch`es, fine. |
| `tabs.update({url}/{active})` | Exists; promise style supported in Firefox **VERIFIED** ([MDN Build a cross-browser extension](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension#api_asynchronous_event_handling): promises on all async APIs). Minimum version not re-extracted → **PARTIAL**. | `browser.js:4407`, `:5612`. |
| `tabs.create` | Exists; same promise note. **PARTIAL** | `browser.js:5597`. Firefox requires absolute URLs? In-tree schema historically required absolute URL for `tabs.create`; the repo passes absolute http(s) only (`browser.js:5550–5553`), so fine. |
| `tabs.reload` / `goBack` / `goForward` | `goBack`/`goForward` Firefox **77** **VERIFIED** (BCD tabs.json); `reload` exists, version not extracted → **PARTIAL**. | `browser.js:5618–5620`. |
| `tabs.captureVisibleTab` | **Firefox 47+**; from Firefox 126 available with `<all_urls>` **or** `activeTab` (repo has `<all_urls>`) **VERIFIED** (BCD tabs.json; [MDN tabs.captureVisibleTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab)). | `browser.js:2692`. Firefox's `ImageDetails` supports `format`/`quality` (default PNG, Chrome's default JPEG) and adds Firefox-only `rect`/`scale` (FF 82) **VERIFIED** ([MDN extensionTypes.ImageDetails](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/extensionTypes/ImageDetails)). |
| `Tab.pendingUrl` | **Not supported in Firefox** (`firefox: false`, bug 1620774) **VERIFIED** (BCD tabs.json). | Read at `browser.js:5571` in `waitForNavigationStart`; on Firefox it is always `undefined`, so navigation-start detection degrades to status/URL heuristics (still works, slower edge cases). |
| `Tab.discarded`, `Tab.audible`, `Tab.status`, `Tab.pinned`, `Tab.title`, `Tab.url` | Firefox 57 / 45 / 45 / 45 / 53 / 45 **VERIFIED** (BCD tabs.json). | `listTabs` (browser.js:4335–4353) reads all of these. |

### 3.5 `webNavigation.getAllFrames`

Used once (`browser.js:810`, `listFrames`), for frame targeting in `runInFrame`/`listRoleClickFrames`. Firefox **47+**, with a documented caveat: returned objects do **not** include `errorOccurred`. **VERIFIED** ([BCD webNavigation.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/webNavigation.json) `getAllFrames`: firefox 47, note "do not include the errorOccurred property"). The repo reads only `frameId`, `parentFrameId`, `url` (see `listFrames`, browser.js:807–829), so behaviour is intact. `frameType`/`documentLifecycle` (Chrome 106) are absent in Firefox — not used.

### 3.6 `downloads` API

Used only by `browser_download`/`browser_downloads` (the latter is provider-side filesystem listing, no browser API — `provider:` 3371–3400, `packages/dsh-browser-extension/lib/downloads.js:97`).

| Call | Firefox | Verification |
|---|---|---|
| `downloads.download({url, saveAs:false, conflictAction:'uniquify', filename})` (browser.js:9864–9869) | API Firefox 47; `filename` Firefox 47 (relative to Downloads; absolute paths/invalid components error); `saveAs` Firefox 52 (omitted = browser `browser.download.useDownloadDir` pref); `conflictAction` Firefox 47. **VERIFIED** ([MDN downloads.download](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download); [BCD downloads.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/downloads.json)). | Repo passes explicit `saveAs:false` and a relative `filename`; compatible. `FilenameConflictAction.prompt` is not supported in Firefox, but repo uses `uniquify` (supported) **VERIFIED**. |
| `downloads.search({id})` (browser.js:9834) | `downloads.search` Firefox 47; `DownloadQuery.id` Firefox 47 **VERIFIED** (BCD downloads.json). | Returned `DownloadItem.filename` is the **absolute local path** in both browsers **VERIFIED** ([MDN DownloadItem](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/DownloadItem)), so `pathInsideRoot`/`verifyDownload` (`packages/dsh-browser-extension/lib/downloads.js:86–96`, `files.js:27`) keep working — provided the configured `downloadsDir` matches Firefox's actual download directory (Firefox pref `browser.download.dir` may differ from `~/Downloads`; provider default is `homedir()/Downloads`, `downloads.js:63`) → **config risk**, not API risk. |
| `downloads.cancel` (browser.js:9852) | Firefox **48** **VERIFIED** (BCD downloads.json). | |
| `downloads.onCreated` (browser.js:9892/9912) | Firefox **48** **VERIFIED** (BCD downloads.json). | Same "all browser downloads" scope as Chrome; the included ambiguity detection (multiple ids) handles page-triggered extras. |
| `DownloadItem.fileSize`, `mime`, `state`, `error`, `url` (browser.js:9840–9850) | Firefox 47 **VERIFIED** (BCD downloads.json). | |
| `DownloadItem.finalUrl` (browser.js:9846) | **No Firefox support** (no BCD key; Chrome-only) → `item.finalUrl` is `undefined`; code falls back to `item.url ?? request.url`. **PARTIAL** (fallback present; exact Firefox field set from MDN DownloadItem page, which does not list `finalUrl`). | |
| Firefox `DownloadItem.danger` always `'safe'`; `endTime` absent | not used by repo. |

`browser_downloads` itself needs **no browser API** (Node `fs`/`os`/`path` in `packages/dsh-browser-extension/lib/downloads.js:1–3,62–63`) → fully portable; `browser_download` is portable except for the label-click branch's synthetic click, which is page-JS (`browser.js:9894`).

### 3.7 `bookmarks` / `history` / `topSites` (browser_places)

`searchPlaces` (browser.js:4294–4330) calls `api.topSites.get()` (4301), `api.bookmarks.search/getTree` (4307–4308), `api.history.search({text, maxResults})` (4310).

| API | Firefox | Verification |
|---|---|---|
| `topSites.get()` | **Firefox 52+** (not 45). Since Firefox 78, if the user disabled Top Sites the call returns most-visited regardless of `newtab` param; repo passes no options, so it gets the default most-visited list. **VERIFIED** ([BCD topSites.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/topSites.json)). |
| `bookmarks.getTree()` | Firefox **45** **VERIFIED** (BCD bookmarks.json). |
| `bookmarks.search(query)` | Firefox **47** **VERIFIED** (BCD bookmarks.json). Search semantics differ slightly between browsers (Chrome matches more fields); the repo normalizes/filters by URL + title (`boolean` filters at browser.js:4302–4304) → behaviour may return fewer/more personal results. **PARTIAL**. |
| `history.search({text, maxResults})` | Firefox **49+** **VERIFIED** (BCD history.json). |
| `HistoryItem.typedCount` (normalized at browser.js:4282) | **Not supported in Firefox** (`firefox: false`, BCD history.json) → field omitted; guarded by `Number.isFinite` so harmless. **VERIFIED**. |
| `HistoryItem.visitCount`, `lastVisitTime` | Supported (no `firefox:false` entry in BCD history.json). **VERIFIED** by absence + MDN HistoryItem page. |

### 3.8 `runtime.getManifest()`

`app.js:1091` reads `.version`. Firefox **45+**, with a caveat: "Returns null for missing values, and removes unsupported keys." **VERIFIED** ([BCD runtime.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/runtime.json) `getManifest`). Safe as used.

### 3.9 `action.setBadgeText` / `setBadgeBackgroundColor`

`background.js:24–25`. Firefox `action` namespace **109+**, both methods **109**; string colour accepted (`setBadgeBackgroundColor.string` firefox 109). **VERIFIED** ([BCD action.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/action.json)). Firefox additionally supports an optional per-window `windowId` details parameter (Firefox 109; not used by this repo, which sets one global badge). Chrome 152's 100-byte badge-text limit is irrelevant (text is "ON").

### 3.10 `windows.getCurrent/getLastFocused/update/onFocusChanged`

`browser.js:260`, `:265`, `:2731`, `app.js:2839`, `app.js:3319`. All Firefox **45+** **VERIFIED** ([BCD windows.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/windows.json)). Two deltas:

- Firefox `windows.onFocusChanged` **triggers multiple times per focus change** **VERIFIED** ([MDN Chrome incompatibilities §Windows API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#windows_api)). `app.js:3319` calls `scheduleTabRefresh()`; refresh is debounced (`app.js:2859`), so only extra log noise.
- `windows.update(windowId, {focused:true})` (browser.js:2731) is the capture-timeout "focus the window then retry" path; Firefox supports the method/option, but whether a sidebar-initiated focus is honoured is **UNVERIFIED**.

### 3.11 `alarms`

Not used anywhere in the repo today (grep `alarms` = 0 hits in production JS; only mentioned in docs). If the WS/state ever moves into the MV3 event page, `browser.alarms` is the supported keepalive/reconnect mechanism and is listed as an API permission in MDN's permissions list. **PARTIAL** — API availability/permission documented ([MDN permissions §API permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions) lists `alarms`), minimum version not re-extracted here.

### 3.12 Viewport capture is portable; full-page/region capture is not

`captureChromeWithWatchdog` (browser.js:2687–2706) calls `chrome.tabs.captureVisibleTab(windowId, {format:'jpeg', quality})` — **Firefox 47+** **VERIFIED** ([MDN tabs.captureVisibleTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab); BCD tabs.json). So the **viewport screenshot path is portable** (with the caveat that Firefox's default format is PNG and Firefox may ignore/accept `format`/`quality` per `ImageDetails` — **VERIFIED** that `format`/`quality` are part of ImageDetails and that "In Firefox, the default is `png` while Chrome's default is `jpeg`" — [MDN extensionTypes.ImageDetails](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/extensionTypes/ImageDetails)).

What is **not** portable (`capturePageImage`, browser.js:2925–2990):
- `Page.getLayoutMetrics` (2932) for full-page size,
- `Emulation.setDeviceMetricsOverride` / `clearDeviceMetricsOverride` (2948/2975) to grow the viewport,
- `Page.captureScreenshot` with `captureBeyondViewport` + `clip` (2880, 2957–2962).

No WebExtension API in Firefox exposes page-metrics emulation or beyond-viewport capture. The Firefox-only alternatives are `tabs.captureTab` (`captureTab` **Firefox 59**, `chrome: false` **VERIFIED** BCD tabs.json — *not currently in the repo*) which captures the visible tab area, and `ImageDetails.rect` (Firefox 82) to crop a rect; full-page needs scroll-and-stitch (semantics/verification change) or a companion/BiDi screenshot. **VERIFIED** that no in-extension replacement exists: neither `pageCapture` nor `captureTab`/`captureVisibleTab` documents beyond-viewport capture; MDN `captureVisibleTab` describes "an area of the active tab" only.

### 3.13 `sidePanel` → `sidebarAction` behavioural deltas

| Chrome `sidePanel` | Firefox `sidebarAction` | Verification |
|---|---|---|
| `setPanelBehavior({openPanelOnActionClick:true})` (background.js:7) | no equivalent; `sidebar_action` is opened by the browser's sidebar UI or by `sidebarAction.open()` **from a user-action handler** | **VERIFIED** ([MDN sidebarAction.open](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open)) |
| per-tab panels (Chrome 141+), `getLayout`/`onOpened` | per-**window** panels via `setPanel({windowId})`/`getPanel` (FF 61); no layout/opened events | **VERIFIED** ([BCD sidebarAction.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/sidebarAction.json): `getPanel`/`setPanel` firefox 54/61; no `onOpened`/`getLayout` keys) |
| `close()` Chrome 141 | `sidebarAction.close()` Firefox 57; `toggle()` Firefox 73 | **VERIFIED** (BCD sidebarAction.json) |
| panel is a Chrome side-panel document; `chrome.windows.getCurrent()`/`tabs.query` work | sidebar is an extension document; `browser.windows.getCurrent()` etc. work | API **VERIFIED** (windows.json), sidebar-context behaviour **UNVERIFIED** |
| panel stays loaded while open; closing panel kills it | sidebar document stays loaded while open; closing it kills the panel and the bridge WS | behaviour **UNVERIFIED** by doc; follows from "sidebar is a document" |
| badge/focus methods on `sidebarAction` unimplemented | use `action.setBadge*` instead | **VERIFIED** (BCD sidebarAction: badge methods firefox false) |

### 3.14 `chrome.debugger` absence — no in-extension replacement

`chrome.debugger` is not implemented in Firefox **VERIFIED** ([MDN Chrome incompatibilities — Debugger API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#debugger_api)). No WebExtension namespace in MDN's API index exposes CDP attach or trusted native input. Therefore every capability in §1.4 loses its implementation. The two credible replacement channels are:

1. **WebDriver BiDi from the companion** (Firefox's remote automation protocol): `input.performActions` gives trusted-ish input actions, `browsingContext.captureScreenshot` gives clipped/full screenshots, `script.evaluate` gives page-script execution. Firefox's own source tree documents a BiDi Extensions module for installing/using extensions over BiDi (`remote/doc/webdriver-bidi/Extensions.md` in mozilla-firefox/firefox) — **VERIFIED existence of the doc**, but the version/availability of `webExtension.install` and whether BiDi can attach to an already-running user Firefox without a separate automation profile are **UNVERIFIED**. This is the architectural fork the port must resolve in a spike (see WP3/WP7).
2. **Synthetic events from `scripting.executeScript`** — already present as fallbacks (`syntheticClickBurst` browser.js:693, `syntheticWheelAtPoint` browser.js:709, `syntheticKeyPage` browser.js:2334, `syntheticDrag` browser.js:2501, `typeLabelled` DOM path browser.js:2083). These work for ordinary DOM pages but are rejected by canvas editors/Docs, which is precisely where the current design relies on trusted input (`CANVAS_EDITOR_PATTERNS`, browser.js:3821–3825; `actionViewForTab`, browser.js:3848).

---

## 4. `scripting.executeScript` compatibility

Only **3** invocation sites exist (all in browser.js). All use `func` + `args`, never `files`, never `world: "MAIN"`, never `injectImmediately`.

| # | Site | Invocation shape | Firefox support |
|---:|---|---|---|
| 1 | browser.js:318–323 (`runInTab`) | `{target:{tabId}, world:'ISOLATED', func, args}` | **VERIFIED**: `executeScript` Firefox 102; `world` ISOLATED 102; `func`/`args` are base API. [MDN scripting.executeScript](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript); [BCD scripting.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/scripting.json). |
| 2 | browser.js:355–360 (`runInAllFrames`) | `{target:{tabId, allFrames:true}, world:'ISOLATED', func, args}` | **VERIFIED**: `InjectionTarget` Firefox 102 (BCD `scripting.InjectionTarget`), and `allFrames` is a documented member of `InjectionTarget`; MDN's example uses `target:{tabId, allFrames:true}` and states it "is executed in subframes and the main document" ([MDN page](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript)). |
| 3 | browser.js:788–789 (`runInFrame`) | `{target:{tabId, frameIds:[frameId]}, world:'ISOLATED', func, args}` | **VERIFIED**: `frameIds` is a documented `InjectionTarget` member (same pages); per-frame result `frameId` Firefox 102 (BCD `executeScript.InjectionResult.frameId`). |

Not used but relevant if the port adds features: `world:"MAIN"` is **Firefox 128+** **VERIFIED** (BCD `ExecutionWorld.MAIN` firefox 128, and `executeScript.world.MAIN` firefox 128); `injectImmediately` **Firefox 102** (BCD); `files` is base API (**VERIFIED**, MDN page). Also `registerContentScripts` Firefox 102, `world` 128 (BCD scripting.json) — this is the route for a document_start MAIN-world dialog/`window.alert` shim (§5, `browser_dialog`).

**Firefox-specific differences that affect these three sites** (**VERIFIED**, MDN executeScript page):
- Errors after injection started are returned in `InjectionResult.error` in Firefox (Chrome does not support `error`). The repo ignores `error`: `runInTab` reads `results?.[0]?.result` (browser.js:333) and `runInAllFrames` filters `result !== undefined` (browser.js:375–377). A page function that throws in Firefox becomes `SCRIPT_EMPTY` ("returned no result") instead of a specific failure — must be fixed to inspect `error` for a faithful port.
- Partial host permissions can yield partial results in Firefox (Chrome fails atomically). With `<all_urls>` this is not an issue today.
- Return values must be structured-cloneable in Firefox vs JSON-serializable in Chrome (`Item`/`URL`/`PerformanceEntry` caveat). All injected functions return plain objects/primitives; no change.
- Cannot inject into extension pages (`moz-extension://`) — none attempted.

---

## 5. 32-tool portability map

All 32 model-facing tools are registered in `provider:` (24 general at 2659–3567 + `browser_wait_for` 3998 + `browser_batch` 4017; 8 Docs at 3595–3916). Each sends a bridge request (`bridge.request({op, args}, …)`) to the side-panel executor; the executor dispatch is `executeOperation` (browser.js:10016–10114) → `execute` (browser.js:10137). Classes:

- **PORTABLE** — needs only extension-platform changes (namespace/promise adapter, small guards); page JS/API support exists in Firefox.
- **NEEDS-TRUSTED-INPUT** — at parity only with a trusted-input channel (current CDP `Input.*`; BiDi replacement required). Synthetic fallbacks exist but do not meet acceptance for canvas/Docs.
- **NEEDS-REDESIGN** — the browser capability is absent or semantically different; the tool's contract must be redesigned (capture stitching, file-byte channel, dialog interception).
- **UNSUPPORTED** — no path in Firefox.

| # | Tool (provider name line) | bridge op (provider line) | executor (file:line) | Chrome dependency | class | why |
|---:|---|---|---|---|---|---|
| 1 | `browser_screenshot` (2659) | `snapshot` (2721) | `snapshot` browser.js:3050; `captureVisibleTab` 2714; `capturePageImage` 2925 | `captureVisibleTab` (portable, FF47+), **CDP** `Page.captureScreenshot`/`getLayoutMetrics`/`Emulation.*` for full_page+region | **NEEDS-REDESIGN** | Viewport portable; full-page/region rely on CDP (browser.js:2880/2932/2948/2975) — no Firefox API; needs scroll-stitch or companion screenshot |
| 2 | `browser_scroll` (2727) | `scroll` (2743) | `scroll` browser.js:3738 | page-JS scroll first (3747); CDP wheel only when page didn't move (3765) with synthetic fallback (3769) | **PORTABLE** | Normal scrolling is page JS; canvas wheel degrades to synthetic (already coded) |
| 3 | `browser_click` (2758) | `click` (2774) | `click` 4896 → page fn `clickLabelled` 1873 | none (synthetic DOM dispatch 2002–2009; page reads otherwise) | **PORTABLE** | Pure page-script click; no CDP |
| 4 | `browser_click_role` (2783) | `click_role` (2822) | `clickRole` role-click.js:880 → `roleClickDriver` 977, `roleTrustedClick` 648 | page probe + **CDP trusted mouse press/release** (648–671) | **NEEDS-TRUSTED-INPUT** | Exact role target is validated in-page but the click is trusted CDP |
| 5 | `browser_click_at` (2828) | `click_at` (2903) | `clickAt` 4701 | **CDP** `Input.dispatchMouseEvent` ×3 per point (634–636); synthetic fallback 4769 | **NEEDS-TRUSTED-INPUT** | Coordinate/canvas clicks are the primary use; synthetic events are ignored by canvas apps (comment 3752–3753) |
| 6 | `browser_select` (2909) | `select` (2957) | `selectRange` 5877 → `trustedDrag` 5844 | **CDP** drag press/moves/release (5845–5869); synthetic fallback 5934 | **NEEDS-TRUSTED-INPUT** | Real drag selection; synthetic drag cannot produce native selection in canvas, and is a weaker fallback elsewhere |
| 7 | `browser_select_option` (2963) | `select_option` (2978) | `selectOptionOp` 5086 → page fn `selectOption` 1573 | none | **PORTABLE** | Sets `select.value` + input/change events (1596–1598) in-page |
| 8 | `browser_hover` (2987) | `hover` (3001) | `hover` 5023 → page fn `hoverLabelled` 1613 | none | **PORTABLE** | Synthetic pointerover/enter/mouseover/mousemove (1628–1631) |
| 9 | `browser_table` (3010) | `table` (3058) | `executeTable` table.js:160; driver browser.js:9964 | page probe/read JS; **CDP** key + `Input.insertText` in `editCell` (9973–9985) | **NEEDS-TRUSTED-INPUT** | Reads portable; writes need trusted keyboard/insertText |
| 10 | `browser_read_text` (3064) | `read_text` (3079) | `readText` 4096 → page fn `readPageText` 3945 | none | **PORTABLE** | Page-JS text extraction |
| 11 | `browser_find` (3092) | `find` (3116) | `executeFind` find.js:84; driver 9997 | none | **PORTABLE** | Page-JS search across frames/shadow roots |
| 12 | `browser_tabs` (3129) | `tabs.list` (3135) | `listTabs` 4335 | `tabs.query` (portable, FF45) | **PORTABLE** | No CDP |
| 13 | `browser_places` (3141) | `places.search` (3179) | `searchPlaces` 4294 | `topSites` 52+, `bookmarks` 45/47, `history` 49+ (all portable) | **PORTABLE** | `typedCount` absent in FF (guarded); `bookmarks.search` semantics slightly differ |
| 14 | `browser_switch_tab` (3185) | `tabs.activate` (3201) | `activateTab` 4361 | `tabs.get/query/update/onActivated` (portable) | **PORTABLE** | No CDP |
| 15 | `browser_type` (3213) | `type` (3245) | `typeText` 5272 | labelled DOM path first (`typeLabelled` 2083) with **CDP** `Input.insertText` fallback (5165); label-less path always **CDP** (5195); canvas typing **CDP** (5194–5196) | **NEEDS-TRUSTED-INPUT** | Ordinary labelled fields can be DOM-driven, but unlabelled/canvas typing (the Docs case) requires trusted text |
| 16 | `browser_press_key` (3251) | `press_key` (3275) | `pressKey` 5489 → `dispatchTrustedKey` 5469 | **CDP** keyDown/keyUp (5480–5481); synthetic fallback 5503 | **NEEDS-TRUSTED-INPUT** | Default actions (submit, menu navigation, Tab order) need native keys; `browser_type submit:true` uses `pressEnter`→trusted (5253–5262) |
| 17 | `browser_clipboard` (3281) | `clipboard` (3365) | `clipboardOp` 6607; `clipboardCopy/Read/Write/Paste/Clear` 6227–6445 | virtual: `storage.session` (portable); system: `navigator.clipboard` (portable with permissions); paste/rich paste: **CDP** Ctrl+V (6490–6501) and trusted typing | **NEEDS-TRUSTED-INPUT** | Copy/read/write/clear portable; paste + rich paste paths need trusted input |
| 18 | `browser_downloads` (3371) | *none* (provider filesystem, `downloads.js:97`) | provider-side `createDownloadsFolder(...).list` (3371–3398; provider:4162) | none | **PORTABLE** | Pure Node filesystem; no browser API at all |
| 19 | `browser_download` (3400) | `download` (3438) | `executeDownload` files.js:302; browser.js `downloadToFolder` 9859 / `downloadByClick` 9876 | `downloads.download/search/cancel/onCreated` (portable FF47/48); labelled control click uses the portable synthetic `click` (9894) | **PORTABLE** | Download dir must be configured to Firefox's actual download dir (`browser.download.dir`), not `~/Downloads` |
| 20 | `browser_upload` (3451) | `upload` (3501) | `executeUpload` files.js:345; `setFileInputByToken` browser.js:9916 | **CDP** `DOM.enable`/`DOM.getDocument`/`DOM.setFileInputFiles` (9920–9938) | **NEEDS-REDESIGN** | No Firefox API sets an input's files by path; replacement needs file bytes from the companion + in-page `DataTransfer` assignment (new bridge frame), with closed-shadow-root/iframe limitations |
| 21 | `browser_navigate` (3518) | `navigate` (3561) | `navigate` 5586 | `tabs.create/update/goBack/goForward/reload` (portable); **CDP** wrapper for beforeunload dialog handling (`withDebugger` 5607, `dialogManager.expectBeforeUnload` 5608) | **PORTABLE** (beforeunload guard loses parity) | Navigation itself is portable; the dialog guard degrades to the dialog redesign |
| 22 | `browser_dialog` (3567) | `dialog` (3586) | `resolveDialog` 9802; `DialogManager` dialogs.js:25 | **CDP** `Page.javascriptDialogOpening/Closed` + `Page.handleJavaScriptDialog` (dialogs.js:82/156/255) | **NEEDS-REDESIGN** | Firefox exposes no WebExtension API to observe/resolve page dialogs; only a document_start MAIN-world `window.alert/confirm/prompt` shim (partial; beforeunload cannot be resolved) — closest to UNSUPPORTED |
| 23 | `browser_docs_rename` (3595) | `docs` `{action:'rename'}` (3610) | `docsRename` 9490 | **CDP** keys/clicks/insertText via docs driver (7196–7214) | **NEEDS-TRUSTED-INPUT** | Canvas editor; requires trusted input |
| 24 | `browser_docs_replace` (3616) | `docs action:'replace_text'/'replace_many'` (3662) | `docsReplaceText` 9311 / `docsReplaceMany` 9415 | same | **NEEDS-TRUSTED-INPUT** | Canvas editor; requires trusted input |
| 25 | `browser_docs_page_setup` (3668) | `docs action:'page_setup'` (3716) | `docsPageSetup` 9598 | same | **NEEDS-TRUSTED-INPUT** | Canvas editor; requires trusted input |
| 26 | `browser_docs_write` (3722) | `docs action:'write'` (3803) | `docsWrite` 8799 | same | **NEEDS-TRUSTED-INPUT** | Canvas editor; requires trusted input |
| 27 | `browser_docs_table` (3809) | `docs action:'table'` (3849) | `docsTable` 9162 | same | **NEEDS-TRUSTED-INPUT** | Canvas editor; requires trusted input |
| 28 | `browser_docs_read` (3855) | `docs action:'read'` (3881) | `docsRead` 8302; export path `docsFetchExport` docs-export.js:76 | page probes (`docsPageProbe` 6678) + extension-page `fetch(credentials:'include')` (docs-export.js:18–96) | **PORTABLE** | Read-only: scripting + extension fetch only |
| 29 | `browser_docs_select_text` (3887) | `docs action:'select_text'` (3910) | `docsSelectText` 7595 | **CDP** keys/clicks | **NEEDS-TRUSTED-INPUT** | Canvas editor; requires trusted input |
| 30 | `browser_docs_format` (3916) | `docs action:'format'/'format_many'` (3992) | `docsFormat` 7889 / `docsFormatMany` 8211 | **CDP** keys/clicks | **NEEDS-TRUSTED-INPUT** | Canvas editor; requires trusted input |
| 31 | `browser_wait_for` (3998) | `wait_for` (4011) | `waitFor` 5784 → `waitForTabConditions` 5734 | page JS + `tabs.get` | **PORTABLE** | No CDP |
| 32 | `browser_batch` (4017) | `batch` (4096) | `batch` 9671 | orchestrates other ops (no direct chrome API) | **PORTABLE** | Inherits child ops' requirements; no own Chrome surface |

**Class counts: PORTABLE 15 · NEEDS-TRUSTED-INPUT 14 · NEEDS-REDESIGN 3 · UNSUPPORTED 0.**
Internal (non-model-facing) ops that also appear in the dispatch: `auto_view` (companion auto-capture, `companion/index.mjs:513`; portable), `labels.clear` (app.js:2106/3121; portable), `snapshot` (also used by `auto_view`).

---

## 6. Test and fixture impact

### 6.1 Unit tests and the chrome mock seam

`npm test` = `node --test companion/test extension/test packages/dsh-browser-extension/test` (package.json:16); 40 `*.test.mjs` files total.

The extension tests are Node tests that import the real side-panel modules and replace the **global** `chrome` object for the duration of the test. There is no chrome module import in product code: browser.js resolves the ambient `chrome` identifier at call time (e.g. `chrome.tabs.get` in `getActiveTab` 274–279, `chrome.debugger.sendCommand` 634). That global-property seam is what makes the executor testable without a browser.

Files that install a fake `globalThis.chrome` (mock seam sites): `extension/test/batch.test.mjs:16,43,83`; `capture-executor.test.mjs:13,39,88`; `debugger-run.test.mjs:6,9,29`; `dialog.test.mjs:17,23,33,186,206,242`; `resilience.test.mjs:365,369,379,395,399,409,442,444,454`; `select.test.mjs:14,30,74`.

The fake shape covers **the whole Chrome-only surface** (`capture-executor.test.mjs:39–86`): `windows.getCurrent/update`, `tabs.query/get/captureVisibleTab/onUpdated/onRemoved`, `webNavigation.getAllFrames`, `scripting.executeScript` (dispatches by `func.name`), `debugger.attach/detach/onEvent/onDetach/sendCommand` (records methods, answers `Page.getLayoutMetrics`/`Page.captureScreenshot`), `storage.session`. `dialogs.js` additionally reads `globalThis.chrome?.debugger?.sendCommand` (dialogs.js:59) and bare `chrome.debugger.onEvent` (dialogs.js:61) at call time.

**Platform-adapter requirements to keep these tests platform-neutral:**
1. Do **not** bake the namespace at module load. Expose `api()` / capability probes that resolve `globalThis.browser ?? globalThis.chrome` per call; then the existing `globalThis.chrome` stubs keep working unchanged on Node.
2. Route all Chrome-only capabilities through one module boundary (suggested `trusted-input.js` / `capture-backend.js`) that exposes `{ available, trustedClick, insertText, dispatchKey, capturePage, setFileInput, dialogWatch }`. Firefox returns `available:false`; the executor falls back to the synthetic page-JS paths that already exist (e.g. browser.js:4769, 5503, 5934) and marks `trusted:false` in results.
3. Keep the `execute(op,args,settings)` signature and pure exports (`browser.js:10137` plus pure helpers like `scaleDimensions` 215, `computeScrollPixels` 230, `isProtectedUrl` 239, `matchTabQuery` 4174, `parsePlacesArgs` 4231, `searchPlaces(args, api = chrome)` 4294 — note `searchPlaces` already takes an injectable `api` argument, the one existing platform seam).
4. Add a capability-injection hook for tests: e.g. `execute(op, args, settings, {platform})` defaulting to the ambient adapter, so Firefox-only branches can be unit-tested without a Firefox.
5. Do not let the adapter swallow test-visible failures: Firefox CDP absence must produce a typed error (`UNSUPPORTED`) that tests can assert, not a silent no-op.

### 6.2 Real-extension harness assumptions (`scripts/edge-*.mjs`)

| Assumption | Evidence | Firefox impact |
|---|---|---|
| A browser is launched externally with `--user-data-dir=/tmp/ca-* --load-extension=$PWD/extension --remote-debugging-port=922x` | header comments e.g. `scripts/edge-click-e2e.mjs:5–8`, `edge-clipboard-e2e.mjs:5–8`, `edge-dialog-e2e.mjs:5–7` | Firefox has no `--load-extension`; needs a dedicated profile + geckodriver/BiDi or `web-ext run` |
| Operational CDP HTTP endpoint: `GET /json`, `/json/version`, target `webSocketDebuggerUrl`; ports 9223/9228/9230/9231/9233/9236/9238/9248 via `CDP_URL` | `scripts/edge-e2e.mjs:10,17,55`, `edge-click-e2e.mjs:15,20`, etc. | Firefox exposes no `/json` CDP endpoint; replace with WebDriver BiDi session (`webSocketUrl`) and `session.new`/`browsingContext.getTree` |
| Side-panel target is a page whose URL contains `/sidepanel/index.html`; if absent, create `chrome-extension://<id>/sidepanel/index.html` with `Target.createTarget` | `scripts/edge-e2e.mjs:42–56` | URL scheme becomes `moz-extension://<uuid>/sidepanel/index.html`; no `Target.createTarget` — open the sidebar (user action) or navigate a tab to the sidebar page then verify |
| Extension id = sha256 of the absolute extension dir mapped a–z (Chrome unpacked-id derivation) | `scripts/edge-e2e.mjs:13–18` | Firefox uses random UUID unless pinned with `browser_specific_settings.gecko.id`; e2e should read the pinned id/UUID (`extensions.webextensions.uuids` pref) |
| Seed settings via `Runtime.evaluate` on the panel: `chrome.storage.local.set({'crazyagent.settings': …}).then(() => location.reload())` | `scripts/edge-e2e.mjs:59`; also `edge-log-e2e.mjs:48` | Replace with BiDi `script.evaluate` on the sidebar realm; `chrome.storage.local` call inside the page becomes `browser.storage.local` |
| Fixture server `python3 -m http.server 17872 --bind 127.0.0.1 --directory e2e/fixtures` | `scripts/edge-click-e2e.mjs:5`, `edge-clipboard-e2e.mjs:5`, etc. | Unchanged |
| Companion bridge at `ws://127.0.0.1:17871/bridge` with token from `.dsh-home/browser-agent/token` | `scripts/edge-e2e.mjs:7,59`; `protocol.js:3` | Unchanged (companion is platform-neutral) |
| Independent verification uses CDP domains: `Runtime.enable/evaluate` (22/21 uses across scripts), `Target.createTarget` (18), `Target.activateTarget` (4), `Page.reload/enable/navigate/bringToFront/captureScreenshot/addScriptToEvaluateOnNewDocument`, `Emulation.setFocusEmulationEnabled/setDeviceMetricsOverride/setEmulatedMedia`, `Input.dispatchMouseEvent`, `Browser.setDownloadBehavior`, `Browser.close` | grep of `scripts/*.mjs` CDP methods | BiDi equivalents: `script.evaluate`, `browsingContext.create/activate/reload/navigate`, `browsingContext.captureScreenshot`, `emulation.setGeolocationOverride`/`setTimezoneOverride` (no direct focus/media emulation), `input.performActions`, `browsingContext.setDownloadBehavior` (newer BiDi) — several fixtures would need redesign; **UNVERIFIED** field-by-field parity |

### 6.3 What a Firefox harness needs (proposal, spikes required)

1. **Launch:** Firefox with a dedicated profile copy (`-profile /tmp/ca-firefox`, never the user's profile) + `--remote-debugging-port` for WebDriver BiDi, or geckodriver with `webSocketUrl: true`. **UNVERIFIED** whether BiDi attaches to a Firefox that also has the user's normal session (likely a separate automation profile is mandatory).
2. **Install the extension:** options are (a) WebDriver BiDi Extensions module (`remote/doc/webdriver-bidi/Extensions.md` in mozilla-firefox/firefox — **VERIFIED doc exists**, version/availability **UNVERIFIED**), (b) `web-ext run --firefox-profile` for a manual/headed run, (c) pack + `xpinstall.signatures.required=false` in a temporary profile (**UNVERIFIED**, release Firefox blocks unsigned installs; Developer Edition/Nightly may allow with pref).
3. **Panel discovery:** sidebar document is `moz-extension://<uuid>/sidepanel/index.html`; the suite must open the sidebar (user-action requirement) or load that URL in a tab for testing (the panel is a normal extension page, so the UI can be exercised as a page; bridge/executor behaviour is identical).
4. **UI driving/evaluation:** BiDi `script.evaluate` in the panel realm; state checks via `browser.storage.local`; page-state checks via BiDi `script.evaluate` and `browsingContext.captureScreenshot`.
5. **Trusted-input fixtures:** the current fixtures assert trusted clicks/typing effect; on Firefox either the harness must drive `input.performActions` through BiDi (new channel, **UNVERIFIED** for this setup) or the acceptance bar must change to synthetic-input evidence — a product decision, not a test detail (see §7 WP3/WP7).
6. **Downloads:** substitute `browser.downloads` events/paths; `Browser.setDownloadBehavior` equivalent is BiDi `browsingContext.setDownloadBehavior` (recent spec) — **UNVERIFIED** in Firefox 159.
7. **Keep the companion contract unchanged**: the bridge protocol and provider are platform-neutral; only the browser side changes (`companion/bridge.mjs` has one Chrome comment at line 5, zero API calls).

---

## 7. Dependency-ordered work breakdown (one agent per package)

Estimated LOC are "lines touched/added" in the repo, excluding generated noise; they are planning numbers (grep-derived where possible).

| WP | Name | Files / areas | Depends on | Est. LOC | Deliverable / exit check |
|---:|---|---|---|---:|---|
| **WP0** | **Feasibility spike (timeboxed)** | throwaway profile; no product edits | — | 0 product | Decision record: (a) does BiDi attach to a normal user Firefox or only an automation profile? (b) is `webExtension.install` usable? (c) does `input.performActions` produce trusted input in Firefox content? (d) does BiDi screenshot cover full-page? Exit: pick "BiDi companion channel" vs "synthetic-only degradation". **Do not start WP3/WP7 before WP0 since the architecture forks here.** |
| **WP1** | **Platform adapter + promise namespace** | new `extension/sidepanel/browser-api.js` (~60 LOC); mechanical rename 103 refs in browser.js (74), app.js (12), dialogs.js (11), background.js (6) | WP0 (decision may not matter) | ~350–500 | `api()` lazy resolver + `can()` capabilities; every `await chrome.*`/`.then` converted; **unit tests still pass unchanged** (they stub `globalThis.chrome`); `node --test extension/test` green |
| **WP2** | **Manifest + background + sidebar shell** | new `extension/manifest.firefox.json` (fork of manifest.json:1–46, ~55 lines); `background.js` (34 LOC: replace `sidePanel.setPanelBehavior` with `action.onClicked`→`sidebarAction.open()`, keep badge handler, keep onInstalled/onStartup) | WP1 (needs api()) | ~120 | Extension loads in Firefox 159 via temporary install; sidebar opens from toolbar/`about:addons`; badge "ON" toggles; `browser.runtime.getManifest().version` works |
| **WP3** | **Trusted-input boundary + capability gating (the big one)** | new `extension/sidepanel/trusted-input.js` (~250 LOC interface + synthetic implementations); browser.js CDP helpers 433–718, 5165–5524, 5844–5870, 5993, 9916–9947, 9964–9995 (replace with adapter calls); dialogs.js 265 (only if dialog work is folded here — else WP6) | WP0, WP1 | ~900–1,400 | Every call site of `withDebugger`/`trustedClick`/`trustedWheel`/`trustedDrag`/`dispatchTrustedKey`/`insertTrustedText`/`setFileInput` goes through one capability interface; Firefox path returns typed `UNSUPPORTED` and falls back to existing synthetic paths with `trusted:false`; Chrome path unchanged (regression: capture-executor/select/debugger-run tests green) |
| **WP4** | **Capture backend (viewport portable, full/region redesign)** | browser.js 2687–3060 (`captureChromeWithWatchdog`/`captureVisibleTab`/`capturePageImage`/`snapshot`); capture.js 95 (validators); app.js screenshot chip path (3134–3155); new stitching or companion-screenshot module (~200–350) | WP1, WP3 (backend interface) | ~380–700 | Viewport screenshots work on Firefox via `tabs.captureVisibleTab`; `full_page`/`region` return a documented Firefox outcome (`CAPTURE_UNSUPPORTED` or stitched result with explicit `stitched:true` and no coordinate basis) — never silently mislabeled |
| **WP5** | **File transfer: downloads dir + upload redesign** | browser.js 9823–9947; files.js 413 (mostly portable — validators only); **new bridge frame** for file bytes: `companion/bridge.mjs` + `companion/index.mjs` (~60), `provider:` upload tool (~80), `extension/sidepanel/app.js` command path (~30); new in-page `DataTransfer` injection | WP1, WP3 | ~350–550 | Direct-URL download verified in Firefox; local `filename` relative to Firefox download dir (config: `downloadsDir` must match `browser.download.dir`); upload works for visible/hidden inputs and open shadow roots via byte channel, fails closed on closed roots/cross-origin frames; no native picker |
| **WP6** | **Native dialogs (redesign or drop)** | dialogs.js 265 (replace `DialogManager` with MAIN-world shim registration); browser.js `throwPendingDialog` 438, `finishDebuggerOperation` 446, `resolveDialog` 9802, `navigate` 5607–5629; `scripting.registerContentScripts` registration at startup; app.js dialog activity rendering (~2,330–2,430) | WP1, WP3, WP2 | ~250–400 | `browser_dialog` returns a typed `DIALOG_UNSUPPORTED` on Firefox **or** the shim reports intercepted `alert/confirm/prompt`; beforeunload cannot be resolved → `navigate` must not hang and must report the native prompt as blocked; guidance text updated |
| **WP7** | **Test suite + Firefox harness** | 6 mock-using test files (adapt only if adapter signature changes, ~150); new `scripts/firefox-*.mjs` harness (~400–600); docs for running it; keep `npm test` platform-neutral (stub `globalThis.browser` in new Firefox-branch tests) | WP1 (unit), WP2+WP3 (e2e) | ~550–800 | `npm test` green on the shared codebase; new fixture suite loads the Firefox build in a dedicated profile and asserts viewport capture, synthetic click/type/scroll/read/find/places/tabs/downloads paths; trusted-input fixtures either use BiDi (`input.performActions`) or are explicitly marked degraded |
| **WP8** | **Guidance/UI copy + docs** | `provider:` GUIDANCE (64–121: "current Chrome window", browser_dialog/upload/capture wording), tool descriptions for changed semantics (3400–3450 upload/download), app.js settings copy (6039 `chrome://extensions`), README/HANDOFF port note | WP1–WP6 | ~100 | No tool description promises a capability the Firefox build lacks; store/README lists platform differences |

**Critical path:** WP0 → WP1 → WP2 → WP3 → (WP5, WP6) ; WP4 branches after WP3; WP7 last. WP3 is the schedule risk (its size depends on WP0's BiDi answer: with BiDi it is an implementation package ~1.4k LOC; without it, it is *only* capability gating and 14 tools become formally degraded).

### 7.1 Top 10 riskiest deltas

| # | Risk | Evidence | Blast radius | Mitigation |
|---:|---|---|---|---|
| 1 | **Loss of `chrome.debugger`/CDP** | 40 Chrome-only call sites (39 `debugger` + 1 `sidePanel`); MDN: debugger API not implemented | All trusted input, dialogs, full-page capture, upload; 17 of 32 tools not at parity (14 trusted-input + 3 redesign) | WP0 spike for a BiDi channel; keep synthetic fallbacks and make `trusted:false` explicit |
| 2 | **Promise style vs callback namespace** | 60 promise-style sites across 4 files; MDN: `chrome` is compatibility namespace, `browser` is the promise API | Extension fails at first `await` (panel dead) unless converted | WP1 adapter with lazy `browser ?? chrome`; mechanical rename; unit tests keep the `globalThis.chrome` seam |
| 3 | **Canvas/Docs tools need trusted input** | 14 of 32 tools depend on `Input.*` (7 general + 7 of 8 Docs); synthetic events are ignored by canvas apps (`CANVAS_EDITOR_PATTERNS` browser.js:3821; comment 3752–3753) | Canvas/Docs acceptance, click_at/click_role/select/type/press_key/table writes | WP0 BiDi decision; if no BiDi, formally degrade Docs/canvas acceptance and rewrite guidance |
| 4 | **Full-page/region capture has no in-extension replacement** | CDP `Page.captureScreenshot` + `Emulation.*` (browser.js:2925–2990); only viewport `captureVisibleTab`/`captureTab` exist | `browser_screenshot` full/region + any verification relying on full-page pixel diff | WP4: stitch (scroll + captureVisibleTab) with explicit metadata, or BiDi screenshot; update tool contract |
| 5 | **Upload has no `DOM.setFileInputFiles` equivalent** | browser.js:9916–9947 | `browser_upload` entirely; download→upload workflow | WP5: companion byte channel + `DataTransfer` injection; fail closed on closed shadow roots/iframes |
| 6 | **Dialog interception absent** | dialogs.js:25–265; no WebExtension dialog API in Firefox | `browser_dialog`, auto-accept `alert`, `beforeunload` handling in `navigate` | WP6: MAIN-world shim at document_start (registerContentScripts, world MAIN FF128+) with honest limitations; never hang |
| 7 | **Sidebar vs side panel UX/API** | `sidePanel.setPanelBehavior` (background.js:7) has no analogue; `sidebarAction.open()` needs a user action | Panel discovery, e2e harness, first-run UX | WP2: `action.onClicked` + `open_at_install`; document sidebar width/per-window behaviour |
| 8 | **MV3 event-page background** | service_worker unsupported; `persistent` MV2-only | Low today (WS in panel document); high if state moves to background | WP2: keep background stateless; if needed, use `alarms` + reconnect or MV2 persistent (documented tradeoff §2.4) |
| 9 | **Download-directory assumption** | provider defaults to `homedir()/Downloads` (downloads.js:63) while Firefox honors `browser.download.dir`; `DownloadItem.filename` absolute (verified) | `browser_download`/`browser_upload`/`browser_downloads` verification | WP5: make `downloadsDir` mandatory/derived from Firefox pref; fail closed with a precise error |
| 10 | **Navigation-start detection + focus events degrade** | `Tab.pendingUrl` not in Firefox (BCD verified) read at browser.js:5571; `windows.onFocusChanged` fires multiple times (MDN verified) | `browser_navigate` timeout heuristics; extra panel refreshes | WP1/WP2: rely on `status`/`url` transitions; keep refresh debounce (app.js:2859); add a `pnAfterNavigate` fallback if needed |

### 7.2 Unverified items to spike before committing dates

1. BiDi attachment to a user-visible Firefox and trustedness of `input.performActions` (blocks WP0/WP3).
2. BiDi extension install method/version (blocks WP7 harness).
3. `queryInfo.windowId` minimum version (not needed for 159, needed for `strict_min_version` selection).
4. `tabs.update`/`tabs.reload`/`tabs.create`/`tabs.query` minimum versions (BCD `tabs.json` fetch truncated before those keys; promises are guaranteed by MDN but versions are not).
5. Firefox event-page idle-suspend timing and whether a sidebar document keeps the extension process alive (no doc found).
6. Firefox download-dir pref interaction with `downloads.download({saveAs:false, filename})`.
7. Whether Firefox sidebars allow `tabs.captureVisibleTab` reliably while the sidebar has focus.
8. Exact Firefox error strings for `captureVisibleTab` (the retry regexes at browser.js:2742–2743 are Chrome-specific).

---

## Appendix A — Sources fetched/checked on 2026-11-04

MDN pages (prose/compat claims):
- [Chrome incompatibilities](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities) — debugger unsupported, sidebar API split, windows.onFocusChanged multiplicity, data-cloning, manifest `key`/gecko.id, browser.* history (Chrome 148).
- [Build a cross-browser extension](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension) — browser vs chrome namespace, promises on all async APIs in Firefox, onMessage Promise responses.
- [scripting.executeScript](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript) — shapes, InjectionResult.error, structured clone, host-permission partial results.
- [tabs.captureVisibleTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab) — Firefox support/permission notes.
- [extensionTypes.ImageDetails](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/extensionTypes/ImageDetails) — format/quality, Firefox default PNG, rect/scale FF82.
- [downloads.download](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download) and [downloads.DownloadItem](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/DownloadItem) — filename semantics, saveAs, absolute filename.
- [storage.session](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session) — memory-only, 10 MB, cleared on stop/disable, content-script access.
- [sidebarAction.open](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open) — user-action requirement.
- [manifest.json/permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions) — API permission list (including clipboardRead/Write, alarms, debugger), host_permissions MV3 split.
- [Interact with the clipboard](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Interact_with_the_clipboard) — Firefox clipboardRead/Write behaviour.

BCD JSON (the data behind MDN compat tables), all fetched from `https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/`:
`api/scripting.json`, `api/tabs.json` (truncated in transport after `query.queryInfo.muted`; `queryInfo.windowId`, `reload`, `update`, `remove` not observed), `api/storage.json`, `api/downloads.json`, `api/webNavigation.json`, `api/action.json`, `api/runtime.json`, `api/windows.json`, `api/sidebarAction.json`, `api/topSites.json`, `api/bookmarks.json`, `api/history.json`, `api/extensionTypes.json`, `manifest/background.json`, `manifest/sidebar_action.json`.

Repo evidence is cited inline by file:line. Counts were generated by scripts over `extension/background.js` and `extension/sidepanel/*.js`; e2e assumptions grepped from `scripts/edge-*.mjs`; tests counted with `find … -name '*.test.mjs' | wc -l` (40).

## Appendix B — Method limitations

- MDN renders compatibility tables client-side, so the HTML pages do not contain version data; BCD JSON is the authoritative source and is cited with the MDN page it backs. One file (`api/tabs.json`) exceeded the fetch response budget and lost its tail (query.windowId, reload, update, remove) — those versions are marked UNVERIFIED rather than guessed.
- No browser was launched, no model was run, no profile was mutated. Behavioural claims about sidebar focus/capture/per-window semantics are labelled UNVERIFIED where no doc settles them.
- Production source was read-only throughout; the only file written is this one.