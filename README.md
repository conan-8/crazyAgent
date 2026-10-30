# CrazyAgent

A Chrome/Edge side-panel browser agent built on **DSH 0.2.1-rc.2**. It reads the active tab, acts through labelled DOM controls or trusted surface coordinates, types and presses keys, navigates, handles bounded semantic find/table operations, and provides guarded Google Docs editing. DSH owns the agent loop, sessions, tools, prompt assembly, attachments, and model routing.

```text
Active tab ↔ side panel ↔ loopback companion ↔ DSH ↔ configured model provider
```

The extension is a normal MV3 side panel. The local companion connects it to DSH over a token-authenticated loopback WebSocket.

## Requirements

- Chrome/Chromium/Edge **116+** with the Side Panel API.
- Node **22.19+**.
- An OpenRouter API key and an image-capable, tool-capable model.
- A normal website tab; browser-internal and Web Store pages are protected.

## Quick start

```sh
npm install
npm run setup
npm run dev
```

`setup` initializes `.dsh-home/profiles/sdk-minimal`, links the local DSH plugins, and validates profile composition. `dev` starts the companion and prints bridge pairing information.

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode, choose **Load unpacked**, and select `extension/`.
3. Click the CrazyAgent toolbar icon to open the side panel.
4. In **Settings**, enter the pairing token and OpenRouter API key, keep or edit the base URL, refresh models, select an image/tool-capable model, and save.
5. Wait for **Connected**, open a normal page, and ask a question or request an action.

Keep the panel open while the agent runs; it is also the browser executor. Reload the extension and reopen the panel after extension changes. Restart the companion after companion, provider, or config changes.

## Operating behavior

- The user’s instruction is the task; page content is treated as untrusted data rather than operator instructions.
- The agent favors direct action, bounded views, semantic operations, and concise answers. Upstream model/provider rules still apply.
- Reliability guards prevent blind destructive recovery, stale-target actions, and repeated failed attempts. Recovery inspects the exact target or uses one scoped undo for a known latest accident, then verifies.
- Login, CAPTCHA, 2FA, payment, and permission blockers require the user. Use only credentials the user supplied.

## Capabilities

There are **29 model-facing tools**: 21 general browser tools and 8 Docs tools.

### General browser tools

| Tool | Purpose |
|---|---|
| `browser_screenshot` | Viewport, bounded full-page, or in-viewport region capture; optional clean PNG to the agent clipboard |
| `browser_read_text` | Paginated rendered page or viewport text without a screenshot |
| `browser_find` | Bounded fallback search across rendered text, control names, non-password values, frames, and open shadow roots; guarded scroll-only reveal |
| `browser_table` | Read editable HTML tables or validate and write 1–100 semantic cell targets with readback |
| `browser_click` | Click a persistent numbered DOM label, including open shadow DOM and accessible frames |
| `browser_click_role` | Follow 1–4 exact role/accessible-name page-chrome steps, including revealed menus |
| `browser_click_at` | Trusted screenshot/CSS-coordinate input for canvas and other surfaces; bounded bursts outside document editors |
| `browser_type` | Replace/append in labelled editable elements or insert at a known caret/selection |
| `browser_press_key` | One trusted key or supported modifier chord |
| `browser_select` | Trusted text-range selection outside Google Docs with non-canvas selection readback |
| `browser_scroll` | DOM scrolling with trusted wheel fallback for canvas apps |
| `browser_hover` | Reveal hover-dependent controls |
| `browser_select_option` | Set a native `<select>` and emit input/change events |
| `browser_batch` | Up to 20 ordered ordinary-page actions with pre/post guards and one final view |
| `browser_navigate` | Open an HTTP(S) URL, use a new tab, reload, or go back/forward |
| `browser_wait_for` | Wait for text, URL, idle, and/or a fixed delay with explicit view control |
| `browser_dialog` | Accept/dismiss a pending native JavaScript dialog, with optional prompt text |
| `browser_tabs` | List current-window tabs |
| `browser_switch_tab` | Activate by tab id or title/URL query |
| `browser_places` | On-demand read-only lookup in new-tab shortcuts, bookmarks, and recent history |
| `browser_clipboard` | Copy/read/write/clear/paste text or captured PNGs using a session virtual clipboard or explicit system clipboard |

### Google Docs tools

| Tool | Purpose |
|---|---|
| `browser_docs_rename` | Rename with title-field focus/value checks and committed-title verification |
| `browser_docs_replace` | Delete or replace 1–200 ordered exact unique matches with counters and partial reporting |
| `browser_docs_format` | Format 1–50 exact ranges with unique or explicit-occurrence targeting and eight supported attributes |
| `browser_docs_select_text` | Select exact text or its containing paragraph; no `all` or persistent multi-select |
| `browser_docs_page_setup` | Verify and set Letter paper, portrait/landscape orientation, and inch margins |
| `browser_docs_write` | Append bounded formatted paragraphs, inline runs, flat lists/checklists, blanks, and page breaks at document end |
| `browser_docs_table` | Create with optional values, read, write exact cells, format cell/row/column/table text, and insert/delete rows, columns, or tables with export verification |
| `browser_docs_read` | Authenticated export as outline, text, or bounded HTML with pagination and no screenshot |

`browser_docs_replace` and `browser_docs_format` internally route to legacy executor actions; those internal names are not additional model tools.

### Important behavior

- **DOM-first auto views:** ordinary pages attach up to 6,000 characters of rendered text plus labels without an image. Known canvas editors receive a full labelled screenshot. Screenshots remain available for visual/spatial needs.
- **Views:** ordinary DOM actions default to compact results and escalate to full views when needed. Known document editors retain strict fresh-view rules. Completed export-verified Docs results may skip a redundant final screenshot; this is not independent acceptance evidence.
- **Batch safety:** malformed argument keys fail before activity. A failed precondition means no dispatch; a failed postcondition follows dispatch, so blind retry is unsafe. Guard failures always stop the batch and earlier actions are not rolled back.
- **Ambiguity:** exact text, accessible-name, tab, table, and occurrence ambiguity fails closed rather than selecting an arbitrary target.
- **Parallelism:** maximum 4 calls, but only `browser_tabs`, `browser_places`, `browser_read_text`, and `browser_docs_read` are parallel-safe. Mutations remain exclusive in model order.
- **Runaway protection:** no per-turn call cap; identical-repeat guards default to 3 mutations, 30 observations, and 10 unmodified navigation keys.
- **Reasoning:** Auto requests `low` from the first model step for reasoning-capable models; Off/Low/Medium/High can be selected manually.
- **Image context:** exact duplicate images are omitted only at model admission within the same session/turn. Older images are durably offloaded while attachments remain on disk. Capture and debug storage still occur.
- **Stop and queue:** Stop interrupts the current runtime and resumes the session on the next message when possible. Messages sent during a turn are queued and can redirect the turn.

Not supported yet include element drag/drop, file upload, downloads, arbitrary JavaScript, native print dialogs, and general browser-chrome automation. Protected pages, closed shadow roots, inaccessible frames, and the built-in PDF viewer can remain inaccessible.

## Side-panel UI

The panel is a single activity feed with streaming reasoning/text/tool events, per-step timing, collapsible finished steps, and a pinned final answer. The composer supports queued messages, Stop/Pause, model and reasoning settings, up to four pasted images, and browser speech recognition when available.

The **Debug log** dialog exports local run evidence. See `docs/DEBUG-LOGS.md` before sharing a bundle.

## Configuration

Settings stores the selected model, base URL, reasoning policy, bridge information, and view preferences. The API key is sent over loopback and passed to DSH as `CRAZYAGENT_API_KEY`; it is not written to `chrome.storage.local` or the generated model patch. Optional local persistence is `.dsh-home/browser-agent/api-key` with mode `0600`.

The companion can also be configured from the CLI:

```sh
npm run dev -- --base-url https://openrouter.ai/api/v1 \
  --model deepseek/deepseek-v4.1-flash-1017 --reasoning-effort auto
```

Output tokens default to the selected model’s advertised maximum; `--max-tokens` sets a lower explicit cap. API-key resolution order is `CRAZYAGENT_API_KEY`, the optional stored key, `OPENROUTER_API_KEY`, then the DSH credential store.

Generated state is under ignored `.dsh-home/`. To remove it:

```sh
npm run clean -- --yes
npm run setup
```

This deletes sessions, attachments, debug logs, tokens, and any remembered key.

## Privacy and permissions

Screenshots, rendered text, labels, prompts, pasted images, and explicit tool results such as personal destinations or clipboard contents can be sent to the configured model provider. Debug logs and DSH attachments remain local until shared, but contain sensitive page/conversation data.

The extension requests broad host access plus side-panel, tabs, scripting, storage, debugger, web-navigation, clipboard, top-sites, bookmarks, and history permissions. Clipboard and personal-data access occur only through explicit user/model actions, not a background sync. Pause blocks browser commands; closing the panel disconnects the executor.

Read `PRIVACY.md` for storage paths, redaction limits, clipboard behavior, and controls.

## Development and verification

```sh
npm test                       # unit/integration suite
npm run setup                  # idempotent profile/plugin validation
npm run system-prompt          # exact composed prompt; -- --json for counts
npm run bench                  # local bridge benchmark
```

Last recorded implementation verification: **552/552 tests** and prompt composition. Earlier real find/auto-view, work/canvas, and other fixture/model runs are historical evidence. **Authenticated real-extension/model Docs table acceptance, authenticated Pivot, real-model HTML-table selection, and normal authenticated docked-panel Docs acceptance remain pending.** Both available isolated Docs profiles were signed out, so the latest table harness stopped before creating a document.

Useful harnesses:

- `scripts/edge-click-e2e.mjs`, `edge-work-e2e.mjs`, `edge-canvas-e2e.mjs`, `edge-advanced-e2e.mjs` — direct real-extension fixture checks.
- `scripts/edge-find-e2e.mjs`, `edge-table-e2e.mjs`, `edge-dialog-e2e.mjs`, `edge-clipboard-e2e.mjs` — focused executor checks.
- `scripts/edge-docs-table-e2e.mjs` — disposable-document table workflow with independent export and reload persistence; requires an isolated signed-in Docs profile.
- `scripts/edge-find-live-e2e.mjs`, `edge-table-live-e2e.mjs` — isolated real-sidebar acceptance harnesses.
- `scripts/ui-preview.mjs` — mocked-bridge UI screenshots without model spend.

Fixture scripts need the static server and isolated Edge/CDP setup described in `HANDOFF.md`. Direct executor success is not model-driven acceptance. Use `e2e/checklist.md` for the real docked side panel and independent final-state checks.

## Troubleshooting

| Symptom | Check |
|---|---|
| Companion offline | Start `npm run dev`, then reconnect the panel |
| Invalid pairing token | Copy the current token into Settings; do not share it |
| No model/key configured | Enter the key, refresh models, select an image/tool-capable model, and save |
| Model list or key rejected | Check base URL, network access, account access, and key validity |
| Browser bridge disconnected | Reopen/unpause the side panel; it is the executor |
| Protected-page error | Switch to a normal HTTP(S) tab |
| Trusted input unavailable | Close DevTools on the tab and check debugger permission |
| Changes do not apply | Reload/reopen the extension; restart the companion for provider/config changes |

## Repository map

```text
companion/                         loopback bridge, DSH lifecycle, model config, logs
packages/dsh-browser-extension/   DSH provider, tools, guidance, provider guards
extension/                        MV3 side panel and browser executor
config/browser.patch.yml          DSH profile composition
e2e/                              fixtures and live acceptance checklist
scripts/                          setup, development, benchmarks, Edge harnesses
docs/                             debug-log, benchmark, and UI references
```

For contributor context, start with `AGENTS.md`, `HANDOFF-QUICK.md`, and `HANDOFF.md`.
