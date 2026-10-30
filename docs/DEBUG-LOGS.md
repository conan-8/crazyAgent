# Debug logs

Each companion run records side-panel, bridge, provider, and DSH activity under `.dsh-home/browser-agent/logs/<runId>/`. Logs explain behavior; independent browser/document inspection decides acceptance.

## Export

1. Keep the companion and side panel connected.
2. Click **▤** in the side panel.
3. Review the run id, path, counts, warnings/errors, and recent signals.
4. Choose whether to include screenshots and the raw DSH session.
5. Click **Download bundle**.

The bundle is written to:

```text
.dsh-home/browser-agent/logs/<runId>/exports/crazyagent-log-<runId>.zip
```

Bundles over roughly 12 MiB return the local path instead of an inline download. **Copy summary** copies `summary.md`; **Copy logs path** copies the run directory.

## Files

| File | Contents |
|---|---|
| `events.jsonl` | Sanitized events, one JSON object per line |
| `summary.md` | Human-readable turns, tools, browser actions, timings, usage, signals, and assistant text |
| `summary.json` | Machine-readable turn model |
| `environment.json` | Model/provider, DSH, Node/platform, paths, and extension context |
| `manifest.json` | Bundle version, run id, generation time, file sizes, and stats |
| `screenshots/*.jpg` | Actual captures, optionally included in exports |
| `dsh-session.jsonl` | Optional raw DSH session, capped at 50 MiB |
| `README.txt` | Bundle guide |

`events.jsonl` and `screenshots/` are written during the run. Summaries, environment, manifest, and ZIP are produced on export. Logs are local and are not automatically deleted.

## Event schema

```json
{
  "v": 1,
  "seq": 42,
  "time": "2026-10-20T23:50:12.345Z",
  "runId": "run-...",
  "sessionId": "session-...",
  "turnId": "turn-...",
  "callId": "call_...",
  "commandId": "...",
  "source": "plugin",
  "type": "bridge.command.result",
  "severity": "info",
  "clientTime": 1792537212345,
  "data": { "op": "scroll", "durationMs": 47 }
}
```

Use `runId` for a companion process, `sessionId` for a conversation, `turnId` for one user prompt through idle, `callId` for a model tool call, and `commandId` for a bridge browser command. `source` is `companion`, `extension`, `plugin`, `bridge`, or `dsh`; `data` is the sanitized payload.

## Common events

| Area | Events and useful fields |
|---|---|
| Turn lifecycle | `run.start/stop`, `turn.start/end`, `dsh.session`, `session.resumed`, `turn.stop.*`, `TURN_STOPPED`, `TURN_FAILED` |
| Prompt/model | `autoCapture.start/end`, `prompt.build` (including current-time context), `reasoning.policy`, `model.max_tokens.continued` |
| Bridge/tools | `frame.in/out`, `browser.command.*`, `browser.result`, `tool.call/result`, `bridge.command.*`, `bridge.ui.wait` |
| Browser execution | `browser.command.start/result/error` with op, duration, capture/encode timing, tab/scroll/image metadata |
| Prompt growth | `image.budget`, `image.budget.midturn`, `image.budget.error` |
| Loop protection | `tool.loop.detected`, `docs.failure.circuit`; there is no per-turn call-budget event |
| Docs evidence | `docs` result payloads, `docs.final.check`, and export-verified capture-skip metadata |
| Live activity | Provider `activity` frames forwarded as `chat.activity`; committed DSH messages remain separate |
| Settings/export | `settings.*`, `llm.models.*`, `llm.configure.*`, `log.export.*` |

Raw `dsh.notification` events contain SDK session/status payloads such as durable assistant messages, usage, replay metadata, and tool calls/results.

## Interpreting results

- `changed`, trusted input, DOM mutations, and pixel differences do not prove the intended target changed.
- Canvas typing reports dispatch, not guaranteed delivery. Non-Docs canvas selection remains unverified until independently inspected; Docs drag selection is refused.
- Batch precondition failure reports no dispatch and no mutation possibility. Postcondition failure follows dispatch and makes blind retry unsafe. Guard failures always stop; earlier actions are not rolled back.
- Malformed batch argument keys are rejected before provider bridge traffic or executor guards/mutations/captures. String values are not inspected for markup-shaped content.
- Unified Docs tools appear in debug commands under internal actions such as `replace_text`, `replace_many`, `format`, `format_many`, and `set_font`. These are not separate model-facing tools.
- Docs `partial`/`failed` results identify only confirmed work. `DOCS_UNSETTLED` can leave mutation in flight and is not safe to retry.
- `docs.final.check` records final-evidence decisions. Export-verified mutations or a later full untruncated read satisfy the gate; failed/partial/truncated evidence remains unverified and gets no retry loop.
- Completed export-verified Docs results can report `view:"none"`, `screenshotSkipped:true`, and `capture.reason:"DOCS_EXPORT_VERIFIED"`. No final-capture JPEG exists in that case; the export evidence remains.
- Native pending dialogs use `view:"none"` and `capture.reason:"DIALOG_PENDING"`, not a stale screenshot.

Provider exact image dedupe occurs **after** capture and debug storage. A duplicate model-facing image block can be omitted while both JPEGs and all capture metadata remain in the run. `turn/end` resets the per-session comparison basis.

## Signals and redaction

Warnings/errors become signals in the dialog and summary. Signals include browser/tool failures, stopped/failed turns, slow captures/tools/turns, large screenshots, disconnects, timeouts, auth failures, and runtime errors.

Before JSONL is written, the companion redacts tokens, API-key-shaped strings, authorization headers, secret-named fields, sensitive URL query parameters, and inline image/base64 data. Long payloads may be truncated. It does **not** redact page text, URLs, prompts, reasoning, assistant text, tool results, or screenshot pixels. Treat every bundle as sensitive development data.

## Inspect a run

```sh
cd .dsh-home/browser-agent/logs/<runId>

# Event volume
jq -r '.source + ":" + .type' events.jsonl | sort | uniq -c | sort -rn

# Warnings and errors
jq -c 'select(.severity=="error" or .severity=="warn") | {seq,time,source,type,data}' events.jsonl

# One turn in order
jq -c 'select(.turnId=="turn-...") | {seq,time,source,type,data}' events.jsonl

# Tool calls and results
jq -c 'select(.type=="tool.call" or .type=="tool.result") | {seq,turnId,type,data}' events.jsonl

# Bundle contents
unzip -l exports/crazyagent-log-<runId>.zip
```

Screenshots are ordinary JPEGs. When sharing, attach the ZIP, paste the relevant summary/events, or provide the local path. Include the user instruction, expected outcome, observed outcome, and run id. Exclude or redact private screenshots and session data.

## Add log events

```js
// Companion
logStore.record('companion', 'my.event', { ... }, { turnId, callId })
logStore.signal('MY_SIGNAL', 'message', 'warn', { turnId })

// Extension
logger.log('my.event', { ... }, 'info', { callId })

// Provider
bridge.logEvent('my.event', { ... }, 'debug', { callId })
```

Keep payloads metadata-sized and never add raw image data or secrets. See `PRIVACY.md` for storage and sharing controls.
