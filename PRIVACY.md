# Privacy

CrazyAgent Phase 1 is a local developer tool. It reads the page you are looking at and sends screenshots to a model provider. This page explains exactly what moves where.

## What is captured

When a turn runs, the side panel can capture:

- a JPEG screenshot of the **active tab's viewport**;
- that tab's title, URL, and id;
- viewport CSS size, device pixel ratio, scroll position, page height, and the screenshot's scale factor.

It does **not** capture other windows, background tabs, the side panel itself, or a full-page image in Phase 1. There is no persistent content script and no background screenshot loop: a capture happens only for a user message or a model tool call.

## Where it goes

```text
Chrome tab
  → side panel (extension memory)
  → local companion (127.0.0.1)
  → local DSH runtime
  → your configured model provider (HTTPS)
```

- **Model provider:** screenshots, interactive-element labels (tag, role, visible text, and position), rendered page text read with `browser_read_text`, tab titles/URLs, your prompts, and the conversation are sent to **OpenRouter** (or the base URL you configure) and the selected model's upstream provider. If the model exposes reasoning, its thinking deltas are returned and shown in the side panel. Those providers' data policies apply. Do not use this on pages whose content you are not willing to send to them.
- **Local bridge:** the companion listens only on `127.0.0.1`. It is not reachable from your network. The WebSocket requires a random token.
- **Extension network access:** Phase 1 makes no direct network requests other than the loopback WebSocket. The model calls originate from DSH.

## What is stored locally

Under `.dsh-home/` (ignored by git):

| Path | Contents |
|---|---|
| `sessions/` | DSH JSONL session logs, including prompts, model text, tool calls, and image attachment references |
| `attachments/v1/` | Screenshot bytes and other image attachments (never auto-deleted) |
| `browser-agent/token` | Pairing token, mode 0600 |
| `browser-agent/api-key` | OpenRouter API key only when **Remember the API key on this machine** is checked, mode 0600 |
| `browser-agent/llm.json` / `llm.patch.yml` | Non-secret selected model, base URL, and generated DSH route |
| `browser-agent/logs/<runId>/` | Detailed debug logs: `events.jsonl` (bridge frames, extension/plugin events, DSH notifications, tool calls), `screenshots/`, and exported ZIPs; `summary.md`, `summary.json`, `environment.json`, and `manifest.json` are written on export |
| `profiles/sdk-minimal/` | Generated DSH profile and local package links |

The extension also stores bridge URL, token, capture width, JPEG quality, and the auto-view preference in `chrome.storage.local`. This is scoped to the extension and this browser profile.

The OpenRouter API key is entered in the side panel. It is sent over the loopback WebSocket, held in companion memory, and passed to DSH as `CRAZYAGENT_API_KEY`. It is **not** stored in `chrome.storage.local`. If you check **Remember the API key on this machine**, it is written to `.dsh-home/browser-agent/api-key` with mode `0600`; otherwise it disappears when the companion stops. A key can also come from `CRAZYAGENT_API_KEY`, `OPENROUTER_API_KEY`, or `refs.OPENROUTER_API_KEY` in your DSH credential store. The key is redacted from debug logs and never written into `llm.json` or the generated patch.

## Debug logs and sharing

The debug log is intentionally detailed for development. `events.jsonl` can contain tab titles/URLs, user prompts, assistant text, tool inputs/results, viewport/scroll metadata, image dimensions, and raw DSH session events. Screenshots are stored as JPEG files, and the optional raw DSH session log contains the model conversation and tool metadata.

The live activity feed is local UI state; it shows model reasoning/text deltas, tool arguments/results, browser actions, and errors as they arrive. Reasoning and assistant text can include page content. After each turn, the companion records a durable `image/offload` decision that keeps the newest two screenshots in model requests and replaces older image occurrences with placeholder text. The JPEG files and DSH attachments remain on disk; only later requests omit them.

Before writing JSONL, the companion redacts pairing tokens, OpenRouter keys and API-key-shaped strings, authorization headers, secret-named fields, sensitive URL query parameters, and inline base64 image data. The `llm.configure` control frame is logged with its `apiKey` field redacted. It does **not** redact page content from reasoning/thinking, assistant text, tool results, or screenshots. Treat a debug bundle as sensitive page data.

The side-panel **Debug log** dialog can exclude screenshots and the raw DSH session from a bundle. Bundles are written under `browser-agent/logs/<runId>/exports/` even when they are also downloaded. Sharing a bundle shares whatever page content and conversation it contains. Logs are not uploaded anywhere by this project; they stay local until you share them.

## Permissions

The extension requests:

- `sidePanel` — open the agent as a side panel;
- `tabs` — list the current window's tabs and read titles/URLs;
- `scripting` — run the scroll/metrics function on the active tab;
- `storage` — persist local settings;
- host permission `<all_urls>` — capture and script arbitrary websites.

`<all_urls>` is broad because the agent must work on any site the user visits. It does not mean the extension reads every page continuously. Chrome extension reviews and enterprise policy may still restrict this.

## Controls

- **Pause** (side-panel toolbar) rejects browser commands without ending the chat.
- **Settings → Attach a fresh view to every message** turns auto-capture off; the model can still call `browser_screenshot` explicitly.
- Closing the side panel disconnects the browser bridge; tools fail until it is reopened.
- Uninstalling the extension clears `chrome.storage.local` for this extension.
- `npm run clean -- --yes` removes `.dsh-home` (sessions, screenshots, debug logs, profile, token), but DSH attachments are not otherwise garbage-collected. Run `npm run setup` afterwards to rebuild the profile.

## Safety

- Phase 1 cannot click, type, navigate, download, or run arbitrary page JavaScript. It can see, scroll, and switch tabs.
- Page content is treated as untrusted data in the system prompt. A page can still try prompt injection by displaying instructions; the lack of mutating actions limits the impact, but do not rely on that for hostile pages.
- Protected pages (`chrome://`, extension pages, Web Store, PDF viewer) are refused with an error.
- The companion and provider are separate processes; a crash of either is reported in the side panel and does not grant extra page access.

## Incognito and file URLs

Incognito access is off by default; enable it explicitly in `chrome://extensions` if needed. `file://` capture/scripting requires “Allow access to file URLs” for the extension, and Chrome may still refuse capture on some local surfaces.

## Questions

If you change the model route, review the new provider's retention policy. If you only need to inspect local pages and do not want pixels leaving the machine, do not configure a remote model provider; Phase 1 has no local vision fallback.