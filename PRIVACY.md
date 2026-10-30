# Privacy

CrazyAgent is a local developer tool with a remote model provider. It sends page content and user-supplied content to the configured provider when needed for a turn. This document describes what is captured, stored, and shared.

## Data flow

```text
Active tab / composer
  → side panel (extension memory)
  → local companion (127.0.0.1)
  → local DSH runtime
  → configured model provider (HTTPS)
```

The configured OpenRouter-compatible provider and the selected model’s upstream provider can receive:

- prompts, conversation history, assistant/tool data, and available reasoning;
- viewport, full-page, or region screenshots and images pasted into the composer;
- rendered text, interactive-element labels, tab titles/URLs, and viewport/scroll metadata;
- explicit tool results, including find matches, table contents, personal destinations, and clipboard contents.

Provider retention and training policies apply. Do not use the agent on content you are not willing to send to those providers.

## Capture behavior

With auto-view enabled, ordinary pages attach bounded rendered text and labels without a screenshot. Known canvas editors attach a viewport screenshot. Explicit screenshot tools can capture the viewport, a bounded full page, or an in-viewport region; full-page capture temporarily changes viewport metrics and then restores them.

CrazyAgent does not continuously capture background tabs, other windows, or the side panel. Capture and page inspection happen for a user message or model tool call. Browser-internal pages and other protected surfaces may be inaccessible.

Pasted composer images are read after your paste gesture and sent only when their message is dispatched. Browser speech recognition starts only after you click the microphone; audio is handled by the browser/vendor speech service, not the CrazyAgent companion. Recognized text is sent only if you send the draft.

## Clipboard

- **Virtual clipboard (default):** text or one captured PNG in `chrome.storage.session`, never `chrome.storage.local` or disk. It is session-scoped and size-bounded.
- **System clipboard (explicit):** `target:"system"` reads/writes the OS clipboard only for the requested operation. Rich paste may use trusted Ctrl+V.
- **Virtual image paste:** the extension may temporarily stage the PNG on the OS clipboard. It first attempts to preserve previous formats in memory and restore them afterward. If staging is denied, it can deliver a PNG `File` through synthetic paste/drop without changing the OS clipboard.
- **Docs table creation:** the extension temporarily stages generated HTML and plain-text table data on the OS clipboard for one trusted paste. Previous clipboard formats are preserved in memory and restored afterward; restoration status is reported. This preservation buffer is not model-facing.

Clipboard contents returned to the model are provider-bound like other tool results. Preservation buffers are not returned to the model or written to logs. Treat system clipboard data as sensitive; it may contain secrets unrelated to the page.

## Shortcuts, bookmarks, and history

`browser_places` reads new-tab shortcuts, bookmarks, and recent history only when explicitly called. It returns bounded HTTP(S) results and has no write/delete operation. There is no startup sync, automatic history attachment, background read, or separate persistent copy. Returned titles, URLs, and visit metadata enter the model conversation and local debug logs.

## Local storage

Generated state is under ignored `.dsh-home/`:

| Path | Contents |
|---|---|
| `sessions/` | DSH JSONL conversations, tool calls, and attachment references |
| `attachments/v1/` | Screenshot and pasted-image bytes; not automatically garbage-collected |
| `browser-agent/token` | Loopback pairing token, mode `0600` |
| `browser-agent/api-key` | Optional remembered API key, mode `0600` |
| `browser-agent/llm.json`, `llm.patch.yml` | Non-secret model/base-URL/reasoning configuration |
| `browser-agent/logs/<runId>/` | Events, screenshots, summaries, and exported debug bundles |
| `profiles/sdk-minimal/` | Generated DSH profile and package links |

The extension stores bridge settings, pairing token, capture preferences, and auto-view preference in `chrome.storage.local`. The virtual clipboard uses `chrome.storage.session`.

The API key travels over the loopback WebSocket, remains in companion memory, and enters DSH through `CRAZYAGENT_API_KEY`. It is not written to extension storage or generated model configuration. It may instead come from `CRAZYAGENT_API_KEY`, `OPENROUTER_API_KEY`, or the configured DSH credential store.

## Debug logs and sharing

Debug logs can contain prompts, assistant text and reasoning, tool arguments/results, page text, tab and personal-destination URLs, and screenshot metadata. Screenshots are separate JPEG files. Raw DSH sessions can contain the full model conversation.

Before writing JSONL, the companion redacts pairing tokens, API-key-shaped strings, authorization headers, secret-named fields, sensitive URL query parameters, and inline base64 image data. **It does not redact page content, prompts, reasoning, assistant text, tool results, or screenshot pixels.** Image offload and exact model-side dedupe do not delete local attachments or captured debug images.

The side-panel export dialog can omit screenshots and the raw DSH session. Bundles are still written locally under `browser-agent/logs/<runId>/exports/`. Review every bundle before sharing.

## Permissions

- `sidePanel`, `tabs`, `scripting`, `storage` — panel UI, active-tab operations, and local settings.
- `debugger`, `webNavigation` — trusted surface input, coordinate mapping, and frame ownership.
- `clipboardRead`, `clipboardWrite` — explicit system clipboard operations and temporary virtual-image staging/restoration.
- `topSites`, `bookmarks`, `history` — explicit read-only `browser_places` lookups.
- `<all_urls>` — capture and script sites visited by the user; this does not imply continuous reading of every page.

## Controls

- **Pause** rejects browser commands without ending the chat.
- Disable **Attach a fresh view to every message** to turn off auto-view; explicit screenshot tools remain available.
- Closing the side panel disconnects browser execution.
- Uninstalling the extension clears its extension storage.
- `npm run clean -- --yes` deletes `.dsh-home`, including sessions, attachments, logs, token, and remembered key; run `npm run setup` afterward.
- Incognito and `file://` access require explicit browser permission and may still be restricted.

Clicking, typing, navigation, semantic table edits, and Docs operations can change real pages and documents. Page text is treated as untrusted instructions, but that does not make hostile pages safe. Protected-page errors and process isolation limit access; they do not replace careful use.
