# M3 report — watch ledger and deterministic alerts

**Date:** 2026-11-16 · **Task:** shared task-4 · **Plan:** `MARATHON-PLAN.md` §5 M3 + §3.3.1/§3.3.2/§3.3.4 + §3.4/§3.5
**Scope:** the deterministic watcher — pure ledger + `assess()`, scheduler WITHOUT the judge (M4 wires it), alert policy, recovery/snooze, `ended-incomplete`, per-turn watch summary, `chat.watch`/`remote.watch`, the panel watch row + amber chip. **No new tools; standing count stays 34. The watcher only reports.**
**Status:** implementation + unit gates + real-extension fixtures complete. **Real-model acceptance (marathon-long ×5 with ZERO false alerts) is eval's and held until task-9 M2 acceptance is green.** This report does not claim real-model acceptance.

## What changed

### Companion (new)
- **`companion/watch-ledger.mjs` (pure):** `WatchLedger` records EVERY turn (marathon or not) so a mid-turn toggle already has history. Fed from `publish(frame)` / `onActivity` / `onConnectionChange`. Monotonic injected `now`. Tracks turn/event/model-delta/tool-call/tool-result/ok-mutation/plan-revision timestamps, in-flight calls, the last 40 tool events (`{n, at, name, argsDigest≤200, fingerprint, ok, code, head≤300, durationMs, readOnly}`), assistant/reasoning tails (≤600), the plan snapshot, executor connectivity, and the prompt (≤1500). `assess(state, now)` (pure) applies the full §3.3.2 table and returns `{level: ok|suspect|hard, signals, hints}`:
  - SILENT_STALL 120 s suspect / 300 s hard (no event, no call in flight); TOOL_HANG 90 s / 240 s (oldest unanswered call); EXECUTOR_DOWN 30 s / 120 s (socket gone mid-turn OR ≥2 SIDE_PANEL_CLOSED); FAIL_STREAK 5; REPEAT_LOOP (≥3 of last 8, or ≤2 distinct in last 10); SAME_ERROR (≥4 of last 10); OBSERVE_ONLY (last 12 all read-only); PLAN_STALLED (open items + 25 non-plan results or 10 min); WALL_HINT (hint only, never alerts). Hard outranks suspect; soft signals never alert alone.
- **`companion/watcher.mjs` (scheduler, no judge):** 20 s tick while a marathon turn runs. Pure `decideWatch` (hard signal alerts immediately; one open alert; kind-change or 15-min re-alert; ≤3 alerts and ≤3 pushes per turn; snoozed kind suppressed; recovery = 3 successful results incl. one mutation OR a plan revision → recovered notice) and pure `decideEndedIncomplete` (marathon turn ending error, or done with no help/confirm and unfinished/blocked plan, partial/blocked label, or dead-turn text). `ack(id)` dismisses + snoozes the kind 15 min (`WATCH_NOT_FOUND` for an unknown id). `turnEnded` emits the additive `{checks, alerts, usage:0}` summary. Timers injected for tests, `.unref()`'d in production. **It never steers, stops, sends a bridge command, captures, changes ok/label/plan/docsVerification, or triggers a retry.**

### Companion (wiring)
- **`session-controller.mjs`:** owns the ledger + watcher; `publish` feeds the ledger every frame; `#begin` starts the ledger/watcher for the turn; the terminal frames (`chat.done`/`chat.stopped`/`chat.error`) carry the additive `watch` summary and trigger `ended-incomplete` via `#finishWatch`; `setConnectivity`, `watchAck`, `watchState`, `watcherPanelState`, `dispose`. The watch summary also rides `logStore.turnEnd`.
- **`bridge.mjs`:** `marathon.watch.ack` routes to `onMarathonWatchAck` (ui role only; never a prompt).
- **`index.mjs`:** `onConnectionChange` feeds `controller.setConnectivity`; `chat.hello` carries the live `watcher` projection; `handleMarathonWatchAck`; shutdown disposes the watcher.
- **`remote-server.mjs`:** `POST /marathon/watch/ack` now implements the ack (200 / 404 WATCH_NOT_FOUND, idempotent per clientCommandId, 409 on changed payload). Remote API limits unchanged; still no ui/tools claim, browser commands, LLM config, or file reads.
- **`remote-hub.mjs`:** ingests `chat.watch` → journals/replays `remote.watch` and mirrors `marathon.watch.open`; `marathon.state.watcher` feeds `checks`/`lastCheckAt`; off/session-change clears the open alert; `chat.done`/`chat.stopped` carry the normalized `watch` summary.

### Panel (`extension/sidepanel/`)
- **`watch-row.js` (new, pure):** `watchNotice` normalization (fail-closed), `watchIsActionable`, `renderWatchRow` — open actionable alerts show the badge/reason/signals + Stop / Steer… / It's fine buttons; recovered/dismissed collapse to a summary line. Ordinary transcript DOM, so history saves it.
- **`app.js`:** `handleWatch` renders/updates a row keyed by id; Stop → `stopTurn()`, Steer… → focus composer, It's fine → `marathon.watch.ack`; the chip ambers ("May be stuck — review the alert") while an alert is open, else "Watching this turn" / "Checked Xm ago". `clearChat` clears the local alert mirror.
- **`style.css`:** watch-row + amber chip styles.

### Scripts / tests
- **`scripts/ui-preview.mjs`:** new `--scenario watch` (alert row + buttons, dismissal, recovery collapse, ended-incomplete, amber chip, narrow fit).
- **`scripts/watch-fixtures-e2e.mjs` (new):** real-extension TOOL_HANG + EXECUTOR_DOWN fixtures (no model; real panel + real Bridge/Hub/RemoteServer; accelerated injected watch clock; independent surface `GET /state marathon.watch.open`).
- **Tests (+47):** `watch-ledger.test` (every signal + threshold edge with a fake clock), `watcher.test` (decideWatch/decideEndedIncomplete policy + scheduler with injected clock/timers), controller hanging-runner integration (TOOL_HANG/EXECUTOR_DOWN alert + watch summary + ended-incomplete + ack), `watch-row.test` (normalization + render), hub `remote.watch` journal/replay/projection, remote-server watch/ack 200/404/idempotency, bridge watch.ack routing.

## Gate results (cheapest first)

| Gate | Result | Evidence |
|---|---|---|
| `npm test` | **1152/1152 pass** (1105 after M2; +47). Prompt-ceiling + Android fixture-staleness gates green (fixtures regenerated additive-only: `watch` on chat.done/stopped + `marathon.watch.open`). | [`m3-evidence/npm-test.txt`](m3-evidence/npm-test.txt) |
| Android `./gradlew testDebugUnitTest` | **BUILD SUCCESSFUL** vs regenerated fixtures (reducer ignores the additive watch fields). | [`m3-evidence/android-testDebugUnitTest.txt`](m3-evidence/android-testDebugUnitTest.txt) |
| `c1-acceptance --self-test` | **PASS** (checkers unchanged). | [`m3-evidence/c1-self-test.txt`](m3-evidence/c1-self-test.txt) |
| `ui-preview --scenario watch` | **PASS**, screenshots inspected: alert row (Stop/Steer…/It's fine), dismissal, recovery collapse, ended-incomplete, amber chip, narrow fit. | [`m3-evidence/ui/`](m3-evidence/ui/) (`watch-*.png`), [`ui/watch.txt`](m3-evidence/ui/watch.txt) |
| Real-extension fixtures | **PASS** both: TOOL_HANG (never-returning call) alerts via `GET /state marathon.watch.open` AND the real panel renders the row; EXECUTOR_DOWN (panel socket dropped mid-turn) alerts via `/state`; the watcher never stopped the running turn. | [`m3-evidence/fixtures/`](m3-evidence/fixtures/) (`tool-hang.png`, `transcript.json`, `fixtures.txt`) |

## Independent check (real panel ↔ real remote API, GET /state surface)

`scripts/watch-fixtures-e2e.mjs` — real Bridge + SessionController + RemoteHub + RemoteServer, a scripted runner holding a turn open with an unanswered `browser_wait_for` call, and the REAL unpacked panel in an isolated Edge profile. The watch clock is injected and accelerated (unit tests prove the exact thresholds; the fixture proves the real wiring). Transcript: [`m3-evidence/fixtures/transcript.json`](m3-evidence/fixtures/transcript.json).
1. **TOOL_HANG:** marathon on; turn running with an unanswered call; advance past 240 s + one tick → `GET /state marathon.watch.open.kind === 'TOOL_HANG'`; the real panel DOM shows `.watch-row[data-watch-kind=TOOL_HANG]` state `open` with buttons `['Stop','Steer…',"It's fine"]` (`tool-hang.png`).
2. **EXECUTOR_DOWN:** new marathon turn running; navigate the panel page away (its bridge socket drops, `hasUi()===false`); advance past 120 s + one tick → `GET /state marathon.watch.open.kind === 'EXECUTOR_DOWN'`; `turn.status` still `running` — the watcher only reported, never stopped the turn.

## Deliberate non-goals / held work

- **No model judge (M4).** Soft signals are recorded/diagnostic only; they do not alert and do not yet bring a judge call forward. `watch.lastVerdict` stays null; `usage` stays 0.
- **No real-model acceptance claimed.** The `marathon-long` ×5 zero-false-alert batch is eval's, held until task-9 M2 acceptance is green. The deterministic thresholds are starting points (plan §3.3.2); eval's batch may tune them.
- **WATCH push delivery is M5.** The watcher enforces the ≤3-push budget and calls an injected push hook; the phone FCM WATCH type + rendering land in M5 (`remote-push.mjs` unchanged here).
- The user's live companion at `127.0.0.1:17871` was never touched; all runs used isolated profiles/ports/homes. Extension changes require a reload in the user's profile (M6).

## Next

- eval task-9 (M2 re-acceptance on tuning pin `a31f7f9`) → then M3 real-model zero-alert batch from a pinned M3 worktree.
- M4 (task-5) is blocked by task-4; not started.
