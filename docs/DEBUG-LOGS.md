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
| `companion` | `run.start`, `turn.start`, `autoCapture.start/end`, `prompt.build` (fresh local/UTC/timezone `current_time` context), `tool.call`, `tool.result`, `turn.end`, `turn.stop.request/duplicate/idle/duringCapture/interrupted/done/error`, `chat.stop` frames, `dsh.session`, `log.export`, `signal`, `terminal`, `run.stop` |
| `plugin` | also `reasoning.policy` (classification, chosen effort, prompt size), `image.budget` / `image.budget.midturn` / `image.budget.error` (live images, offloaded count, keep budget, hysteresis threshold), and `tool.loop.detected` (identical-call breaker; `observation`/`navigation` distinguish read-only and unmodified-key repeats from mutating ones) |
| `bridge` | `frame.in`, `frame.out`, `frame.event`, `browser.command.in/out`, `browser.result`, `bridge.ui.wait` (side-panel reconnect grace: command, waitedMs, connected); chat control frames (`chat.send`, `chat.stop`, `chat.stopping`, `chat.stopped`); inbound live `activity` frames from the provider plugin |
| `extension` | `app.boot`, `app.context`, `settings.loaded`, `settings.save`, `settings.pause`, `bridge.connect.start`, `bridge.open`, `bridge.connected`, `bridge.closed`, `chat.send`, `browser.command.start/result/error` (command id, call id, op, `durationMs`, `captureMs`/`encodeMs`, image metadata, tab and scroll state), `tab.active`, `testCapture.*`, `llm.models.request/result`, `llm.configure.request`, `llm.configured`, `log.modal.open`, `log.export.request/result` |
| `plugin` | `provider.registered`, `bridge.connected`, `bridge.disconnect`, `bridge.command.send`, `bridge.command.result/error` |
| `dsh` | `startup`, `ready`, `notification`, `assistant.text`, `session.resumed`, `session.resume.error` |

The `dsh.notification` events carry the raw SDK `session.event`/`session.status` payloads: durable assistant messages, usage, replay metadata, turn/step events, tool calls/results, and request headers. That is why the event file is detailed even before the raw DSH session is included.

Action outcomes appear in the matching `tool.result` text. Canvas-app work uses structured fields: `viewId` on every full view and `basisViewId` on compact/skipped ones, `basis` on coordinate results, and `layoutChanged`/`layoutShift` on state-changing actions whose view was skipped. Stale, ambiguous, and off-screen canvas coordinates are refused before input. Typing includes `typed.canvasEditor`/`charsAdded`/`measured`/`dispatched`/`verified`/`pageChanged`: canvas input is dispatched with `changed:null` and verification left to the returned full view, never claimed as delivered from DOM mutations. Other canvas drag selection reports `selected.verified:false`; Google Docs rejects it before input with `DOCS_CANVAS_SELECT_UNSUPPORTED` because it can move text. Known canvas editors reject mutating multi-action batches and multi-point bursts before the first side effect. `browser_docs` with `action:"set_font"` returns one final view and `docs.action/status/matchCount/fontAdded/verifiedBy`; statuses include `applied`, `already_applied`, `font_missing`, and `removed_text` (matched text only, not the paragraph break). `browser_docs_rename` reports `renamed`, `title`, and `verifiedBy:"document-title"`, with title focus checked before Enter. `browser_docs_replace_text` returns one final view and `docs.action/status/matchCount/verifiedBy`; statuses are `replaced_text` and `removed_text`, with `removedText` naming the deleted match. `browser_docs_replace_many` reports `status`, `editCount`, `appliedCount`, `remainingCount`, per-edit results, and any zero-based failure. Both replacement tools click Replace only after a unique match and verify old/new counter baselines rather than trusting the click or assuming the replacement is unique. Read-text results for Google Docs/Sheets/Slides use `textUnreliable`/`canvasApp`/`domText`. Structured fields on `browser.command.result` include `typed`, `pressed`, `navigated`, `waited`, `selected`, `view`, `labelsDelta`, `batch`, and `docs`; click pixel outcomes (`changed`, `signals`, `pixelsChanged`, `points`) remain text-only. Compact and `view:"none"` results legitimately carry no image, and `detail:"fast"` snapshots are 640 px. Capture calls have a 5 s watchdog. The first `CAPTURE_TIMEOUT` focuses the owning window and permits one bounded retry; a persistent second timeout opens a 30 s circuit during which queued/new captures fail fast with `CAPTURE_COOLDOWN`. Normal captures do not change OS focus. Successful auto-captures no longer add a sidebar telemetry row, but their log events and metadata are unchanged. Explicit `wait_for timeout_ms < ms` is rejected before sleeping; omitted timeouts expand to cover the fixed wait.

`browser_docs_format` uses the same `op:"docs"` logging path with `args.action:"format"`. Its returned structured `docs` payload includes `action`, `status`, `matchCount`, `attributeCount`, `appliedCount`, `alreadyAppliedCount`, `fontAdded`, `verifiedBy`, and per-attribute `results` (`attribute`, `value`, `status`, `verifiedBy`). Successful outcomes are `completed` and `already_applied`. A missing font produces `font_missing` when nothing changed or `partial` when earlier attributes were applied, plus `failure.attribute:"font"` and `failure.code:"DOCS_FONT_MISSING"`; it never deletes text. Other thrown failures stop at the current attribute, and the error message lists earlier verified results and names the current attribute as unverified. These fields describe internal verification, not independent real-Docs acceptance.

`browser_click_role` logs `op:"click_role"` with the exact `path` and a structured `roleClick` result (`status`, `completed`, completed `path`, and optional `failure` with step index/role/name and dispatch evidence). Intermediate menu/target transitions are waited for and revalidated inside the operation; the result normally includes one final full view, or explicit `view:"unavailable"`/`viewUnavailable` evidence if capture fails. Path completion is not proof of the intended application outcome. `ROLE_CLICK_UNSETTLED` means trusted input may still be pending and must not be retried blindly.

`browser_docs_select_text` logs `op:"docs"`, `args.action:"select_text"`, and a text-only `docs` result with `action`, `status:"selected"`, `scope`, selected `text`, `occurrence`, `current`, `matchCount`, `verifiedBy:"find-counter"`, and `findFocused`; paragraph scope can add `anchorText` and `paragraphIndex`. There is no screenshot and no `all`/persistent multi-select mode. `browser_docs_format_many` logs `args.action:"format_many"` with `docs.action/status/editCount/appliedCount/attemptedCount/verifiedCount/remainingCount/verifiedBy`, per-edit and per-attribute `results`, and optional `failure`. Baseline/final export evidence checks exact targets and collateral text, structure, list/paragraph metadata, run marks, and structured `href` values; paragraph-style verification handles uniform inherited font/size/bold changes in the styled paragraph. Later edits remain `unattempted` after the first failure. The executor/provider budgets are 600/660 seconds. `DOCS_UNSETTLED` means an in-flight mutation may still be running: do not retry or issue more mutations; after the tab stabilizes, inspect with `browser_docs_read`. These result fields are diagnostic evidence, not independent live-Docs acceptance.

`browser_docs_write` logs `args.action:"write"` with `docs.action/status/blockCount/attemptedCount/verifiedCount/verifiedBy`, per-block `results`, appended `outline`, and optional `failure` (`index`, `code`, `message`, and expected/actual snippets when available). Success is `completed` only after export verification of the preserved prefix and every appended block and inline run, including exact run text, font/size, emphasis, color, highlight, list type/order, checklist checked state, and page breaks. Checked items appear as `☑` and unchecked items as `☐` in outlines. Appended-content divergence triggers bounded increasing export delays within eight seconds (six reads in the tested worst case), with no retyping or extra screenshots; the last mismatch is reported if it persists. `partial`/`failed` identifies only confirmed blocks and must not be presented as full completion. `DOCS_WRITE_COLLATERAL` means the prefix or unexpected trailing content changed; `DOCS_WRITE_EMPTY_LIST_ITEM` means list exit left an empty item; `DOCS_WRITE_VERIFY_FAILED` is a content/formatting divergence. Input is not blindly retried. `browser_docs_page_setup` logs `args.action:"page_setup"` with verified paper size, orientation, margins, and `verifiedBy:"page-setup-dialog"`; every requested value must match before OK. Orientation state follows label-linked radios, an already-open dialog is resumed instead of reopened, and one fresh bounded OK retry follows a close timeout. List-state verification accepts exact controls in the overflow popup outside the main toolbar. Writer schemas use `const:true` for standalone `blank`/`page_break`; blank/formatting combinations and `blank:false` are rejected before browser access, and every `items` array must pair with `list`. `browser_docs_read` logs `args.action:"read"` with `docs.format/chars/returned/truncated/content/verifiedBy:"export"`, returning text without an image. Export fetch errors include permission/not-found/rate-limit/timeout codes, with at most two 429/503 retries. Requests are serialized per document/format with a 250 ms successive-request gap and a shared cooldown after every 429/503, including the final failed attempt, so concurrent reads and retries cannot amplify rate limiting. `maxParallelToolCalls` is 4, but only `browser_tabs`, `browser_read_text`, and `browser_docs_read` are declared parallel-safe; mutations remain exclusive in model order. `provider.registered` logs the actual registered tool list. `browser_docs_read` also belongs to the observation-tool repeat category.

Reasoning policy decisions are logged once per turn as `reasoning.policy` from the provider plugin, with `policy`, `classification`, `effort`, and `promptChars`. Auto requests `low` for every classification from the first model step, so reasoning can stream throughout generation; manual `off`/`low`/`medium`/`high` remains authoritative. Image-history trimming is logged as `image.budget` (turn end) and `image.budget.midturn` (batched mid-turn hysteresis) with `live`/`before`, `offloaded`, `after`, `keep`, and `targets`; failures appear as `image.budget.error`. There is NO per-turn call limit: `tool.budget.*` events are gone and no event refuses a call for count. A turn may use as many calls as the task needs, because cutting a turn discarded working state and forced the user to say "continue" (2026-10-23: five continuations, each restarting from a merely-described state, which corrupted a document). The remaining loop safeguards are `tool.loop.detected` and `docs.failure.circuit`. `tool.loop.detected` fires for an *identical* call repeated past `maxRepeatedCalls` (default 3) for a mutating tool, past `maxObservationRepeats` (default 30) for a read-only tool (`browser_screenshot`, `browser_read_text`, `browser_docs_read`, `browser_tabs`, `browser_wait_for`), or past `maxNavigationRepeats` (default 10) for an unmodified navigation key (`Escape`, `Tab`, arrows, `Home`/`End`). Shift-selection and all modified chords use the strict mutating limit. Fingerprints reset by session/user-message turn, and a different successful mutation starts a new repeat series; parallel observations do not reset mutation state. The event data carries `tool`, `repeats`, `max`, `observation`, `navigation`, and truncated `args`. Observing the same thing repeatedly is how the agent watches async page state, so observation gets the larger allowance; a consecutive repeated mutating call is a real bug (double click, re-typed paragraph). `docs.failure.circuit` records three consecutive Docs replacement failures and rejects the next attempt until a success or new turn, preventing speculative cascades without limiting useful work.

Live model activity is separate from the durable DSH notifications. The provider plugin taps `agent/assistant-stream` and sends transient `activity` frames over the bridge. The bridge logs each inbound frame (with the current `turnId`) and forwards a `chat.activity` frame to the side panel. These frames carry reasoning/thinking deltas, visible text deltas, partial tool calls, usage, finish reasons, and attempt boundaries. The committed reasoning fallback is derived from the already-logged `assistant/message`; it is not logged a second time.

A user **Stop** is a lifecycle frame, not a prompt: the panel sends `chat.stop`, the companion replies `chat.stopping` immediately and `chat.stopped` when the runtime is interrupted, and the aborted turn ends with `turn.end {ok:false, aborted:true, reason:'user'}` plus the informational `TURN_STOPPED` signal. The companion closes the DSH harness (no SDK cancel exists) and resumes the same session on the next message; `turn.stop.*` events record the request, interruption and session id.

## Signals

Warnings and errors become **signals** shown in the Debug log dialog and in `summary.md`. Detection includes:

- severity `warn`/`error` on any event;
- browser command failures (`PROTECTED_PAGE`, `CAPTURE_QUOTA`, `PAUSED`, `SIDE_PANEL_CLOSED`, script/capture errors);
- tool failures (`TOOL_FAILED`);
- user-stopped turns (`TURN_STOPPED`, informational; an aborted turn is not a failure);
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