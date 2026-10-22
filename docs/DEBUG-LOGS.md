# Debug logs

The debug log is the development feedback loop for CrazyAgent. It records what the side panel, companion, provider plugin, and DSH runtime did in one run, saves the screenshots, and packages everything into a shareable ZIP.

## Export in one click

1. Keep the companion and side panel connected.
2. Click **▤** in the side-panel topbar.
3. Review the run id, log path, event/screenshot/turn counts, warnings/errors, and recent signals.
4. Choose whether to include screenshots and the raw DSH session log.
5. Click **Download bundle** (`crazyagent-log-<runId>.zip`).

The bundle is always written to:

```text
.dsh-home/browser-agent/logs/<runId>/exports/crazyagent-log-<runId>.zip
```

If it exceeds ~12 MiB it is not sent inline; the side panel shows the local path instead. **Copy summary** copies `summary.md` to the clipboard without building the ZIP. **Copy logs path** copies the run directory.

The run directory contains `events.jsonl` and `screenshots/` as soon as events happen. Exporting also writes `summary.md`, `summary.json`, `environment.json`, and `manifest.json` beside them, and the ZIP into `exports/`.

## Bundle contents

| File | Contents |
|---|---|
| `summary.md` | Human-readable run timeline: environment, signals, each turn's user prompt, browser actions, screenshots, model tool calls, assistant text, timings, token usage |
| `summary.json` | Machine-readable turn model: turns, browser actions, tools, images, timings, usage |
| `events.jsonl` | Every recorded event, one JSON object per line |
| `environment.json` | Provider/model/effort, DSH version, Node/platform, paths, extension context, redaction note |
| `manifest.json` | Bundle format/version, run id, generation time, file sizes, stats |
| `screenshots/*.jpg` | Captured viewport images (optional) |
| `dsh-session.jsonl` | Raw DSH session log with model stream chunks and request metadata (optional; capped at 50 MiB) |
| `README.txt` | Short guide to the bundle |

## Event schema

Each line in `events.jsonl` is one event:

```json
{
  "v": 1,
  "seq": 42,
  "time": "2026-10-20T23:50:12.345Z",
  "runId": "run-2026-10-20T23-50-05-218Z-7a97e8",
  "sessionId": "session-62ab4d2f2a1446f6a493ee41cac5afbe",
  "turnId": "turn-mvhc4eo8-7794",
  "callId": "call_088a7776b3594050b18ec388",
  "commandId": "6bfd1e99-6e4d-4fc1-b04e-e8475fc3b894",
  "source": "plugin",
  "type": "bridge.command.result",
  "severity": "info",
  "clientTime": 1792537212345,
  "data": { "op": "scroll", "durationMs": 47, "result": { "..." : "..." } }
}
```

Fields:

- **runId** — one companion process/run; the log directory name.
- **sessionId** — DSH conversation session. A new chat creates a new one.
- **turnId** — one user prompt through agent idle. Correlates every bridge frame, browser action, tool call, screenshot, and timing in that turn.
- **callId** — DSH model tool-call id, shared with the browser command.
- **commandId** — the bridge-level browser-command id (auto-capture ids start with `auto-`).
- **source** — `companion`, `extension`, `plugin`, `bridge`, or `dsh`.
- **type** — event name (see below).
- **severity** — `debug`, `info`, `warn`, or `error`; warnings/errors become signals.
- **clientTime** — the client's `Date.now()` when the event originated (extension/plugin events).
- **data** — sanitized payload.

### Sources and common types

| Source | Examples |
|---|---|
| `companion` | `run.start`, `turn.start`, `autoCapture.start/end`, `prompt.build`, `tool.call`, `tool.result`, `turn.end`, `dsh.session`, `log.export`, `signal`, `terminal`, `run.stop` |
| `plugin` | also `reasoning.policy` (classification, chosen effort, prompt size), `reasoning.escalated` (`off`→`low` after 3 no-progress results), `image.budget` / `image.budget.midturn` / `image.budget.error` (live images, offloaded count, keep budget, hysteresis threshold), `tool.budget.exceeded` and `tool.loop.detected` (per-turn call cap / repeated-call breaker) |
| `bridge` | `frame.in`, `frame.out`, `frame.event`, `browser.command.in/out`, `browser.result`, `bridge.ui.wait` (side-panel reconnect grace: command, waitedMs, connected); inbound live `activity` frames from the provider plugin |
| `extension` | `app.boot`, `app.context`, `settings.loaded`, `settings.save`, `settings.pause`, `bridge.connect.start`, `bridge.open`, `bridge.connected`, `bridge.closed`, `chat.send`, `browser.command.start/result/error` (command id, call id, op, `durationMs`, `captureMs`/`encodeMs`, image metadata, tab and scroll state), `tab.active`, `testCapture.*`, `llm.models.request/result`, `llm.configure.request`, `llm.configured`, `log.modal.open`, `log.export.request/result` |
| `plugin` | `provider.registered`, `bridge.connected`, `bridge.disconnect`, `bridge.command.send`, `bridge.command.result/error` |
| `dsh` | `startup`, `ready`, `notification`, `assistant.text`, `session.resumed`, `session.resume.error` |

The `dsh.notification` events carry the raw SDK `session.event`/`session.status` payloads: durable assistant messages, usage, replay metadata, turn/step events, tool calls/results, and request headers. That is why the event file is detailed even before the raw DSH session is included.

Action outcomes appear in the matching `tool.result` text. Structured fields on `browser.command.result` now include `typed`, `pressed`, `navigated`, `waited`, `selected`, `view`, `labelsDelta` and `batch`; click pixel outcomes (`changed`, `signals`, `pixelsChanged`, `points`) remain text-only; parse the tool result when you need them. Compact and `view:"none"` results legitimately carry no image, and `detail:"fast"` snapshots are 640 px.

Reasoning policy decisions are logged once per turn as `reasoning.policy` from the provider plugin, with `policy`, `classification`, `effort`, and `promptChars`. The chosen effort is applied to every step of that turn; when an `auto` `off` turn hits three consecutive no-progress tool results, `reasoning.escalated` records the switch to `low` for the rest of the turn. Image-history trimming is logged as `image.budget` (turn end) and `image.budget.midturn` (batched mid-turn hysteresis) with `live`/`before`, `offloaded`, `after`, `keep`, and `targets`; failures appear as `image.budget.error`. Tool-call guard events are `tool.budget.exceeded` (per-turn `maxToolCallsPerTurn`) and `tool.loop.detected` (identical call repeated past `maxRepeatedCalls`).

Live model activity is separate from the durable DSH notifications. The provider plugin taps `agent/assistant-stream` and sends transient `activity` frames over the bridge. The bridge logs each inbound frame (with the current `turnId`) and forwards a `chat.activity` frame to the side panel. These frames carry reasoning/thinking deltas, visible text deltas, partial tool calls, usage, finish reasons, and attempt boundaries. The committed reasoning fallback is derived from the already-logged `assistant/message`; it is not logged a second time.

## Signals

Warnings and errors become **signals** shown in the Debug log dialog and in `summary.md`. Detection includes:

- severity `warn`/`error` on any event;
- browser command failures (`PROTECTED_PAGE`, `CAPTURE_QUOTA`, `PAUSED`, `SIDE_PANEL_CLOSED`, script/capture errors);
- tool failures (`TOOL_FAILED`);
- failed turns (`TURN_FAILED`);
- slow captures (>500 ms), slow tools (>5 s), slow turns (>15 s), slow first DSH event (>5 s);
- large screenshots (>500 KiB);
- bridge disconnects, timeouts, and auth failures;
- DSH warm-start failures, uncaught errors, unhandled rejections.

The dialog shows the last 12; the full list stays in `events.jsonl` and the summary shows up to 60.

## Screenshots

The bridge saves each actual side-panel capture as a separate JPEG:

```text
screenshots/turn-<id>-<seq>-<op>-<sha256prefix>.jpg
```

The JSONL event for that capture keeps `mimeType`, width, height, byte size, scale, tab/viewport/scroll metadata, and a `screenshot` path; the base64 bytes are removed. The same result forwarded to the provider does **not** create a second copy. If the same view is captured twice, both files are kept (useful when investigating stale frames).

## Redaction

Before writing JSONL, the companion:

- replaces the pairing token wherever it appears;
- redacts values for keys like `token`, `apiKey`, `authorization`, `secret`, `password`, `cookie`, `credential` (including the `llm.configure` frame from the side panel);
- redacts OpenRouter/API-key-shaped strings and `Bearer …` values;
- redacts values of sensitive URL query parameters (`token`, `key`, `auth`, `code`, `sig`, …);
- replaces inline image/base64 payloads with metadata;
- truncates very long strings and arrays (the raw DSH session keeps more detail).

It does **not** redact page text, tab titles/URLs, assistant/user messages, tool-result text, or screenshot pixels. A bundle is page-level development data; review it before sharing.

## Inspecting a bundle

```sh
unzip -l crazyagent-log-run-....zip
unzip -p crazyagent-log-run-....zip summary.md | less
```

With the run directory:

```sh
cd .dsh-home/browser-agent/logs/<runId>

# Event volume by source/type
jq -r '.source + ":" + .type' events.jsonl | sort | uniq -c | sort -rn

# All warnings/errors
jq -c 'select(.severity=="error" or .severity=="warn") | {seq,time,source,type,severity,data}' events.jsonl

# One turn, in order
jq -c 'select(.turnId=="turn-...") | {seq,time,source,type,severity,data}' events.jsonl

# Browser captures without base64
jq -c 'select(.source=="bridge" and .type=="browser.result") | {seq,turnId,callId,op:.data.result.op,image:.data.result.image}' events.jsonl

# Model tool calls/results from raw DSH notifications
jq -r 'select(.source=="dsh" and .type=="notification") | .data.params.event.type' events.jsonl | sort | uniq -c

# Plugin timing
jq -c 'select(.source=="plugin") | {type,seq,data}' events.jsonl

# Confirm the token did not leak
grep -c "$(cat ../../../browser-agent/token)" events.jsonl   # expect 0
```

Screenshots are ordinary JPEGs; open them from the extracted bundle.

## Sharing with the agent

When a run looks interesting:

- Attach `crazyagent-log-<runId>.zip` to the chat (the agent can unzip it with bash), or
- paste `summary.md` and the relevant `events.jsonl` lines, or
- point at the local path if the agent has filesystem access.

Useful context to include: what you asked, what you expected, what happened, the run id, and whether the screenshots are safe to share. If the page has private content, uncheck screenshots or crop/redact the images before sharing.

## Sizes and retention

- Model selection emits `llm.models.request/result` (the full catalog response is not logged; the count is) and `llm.configure.request`, whose `apiKey` is redacted before it reaches `events.jsonl`.
- One real turn with one screenshot: ~87 events / 39 KiB JSONL; ~84 KiB ZIP with the DSH session and one 48 KiB screenshot. These measurements were taken on the earlier Alibaba route; OpenRouter model latency differs.
- A bundle includes the raw DSH session (capped at 50 MiB) and all screenshots from the run unless disabled.
- Logs are per companion run and never auto-deleted. `npm run clean -- --yes` removes `.dsh-home` including logs.
- Logging is local and asynchronous; it does not add a model round trip. Each event is buffered and flushed every ~60 ms; exports flush first.

## Extending the log

Companion:

```js
logStore.record('companion', 'my.event', { ... }, { turnId, callId, severity: 'debug' })
logStore.signal('MY_SIGNAL', 'message', 'warn', { turnId })
```

Extension:

```js
logger.log('my.event', { ... }, 'info', { callId })
```

Plugin:

```js
bridge.logEvent('my.event', { ... }, 'debug', { callId })
```

Do not put image data in log payloads. The bridge saves `browser.result` images and redacts inline data; everything else should stay metadata-sized.

## Privacy

See [`PRIVACY.md`](../PRIVACY.md). Debug logs are local until you export or share them. The export dialog's screenshot and DSH-session toggles are the main controls.