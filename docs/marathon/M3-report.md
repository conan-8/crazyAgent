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

---

## Real-model acceptance — zero false alerts (eval, task-11, pin 2abb065)

**Verdict: GREEN.** `marathon-long` ×5 in `/marathon`: **5/5 PASS, 12/12 exactly-once every run, 0 redos, 0 dead turns, 0 retries — and ZERO watcher alerts across all five runs**, verified from the authoritative surfaces (live `GET /state marathon.watch`, `chat.watch` frames, `chat.done` watch summaries, archived `watch.tick`/`watch.judge.summary` events — not the transcript). `ended-incomplete` did NOT fire on any clean `reported-complete` turn. The watcher genuinely ran (21 deterministic checks total); the judge was unwired at this pin (0 calls, 0 tokens — deterministic-only as specified).

### Provenance

- Lead acceptance pin **`2abb065e9f923bba35b2f4d67ae83acceb71d55f`** (chain: M4 judge head `cbe50ee` → **M3 fixes `3f02e2e`** (live ledger activity feed so PLAN_STALLED can fire live; authoritative ended-incomplete in turnEnded info) → M4 prep `1e3c2dc` → steer-plan row fix `9b856df` → WATCH push `2abb065`). The board text's original pin `d266ada` was moved by lead to this corrected-wiring pin; the judge's `index.mjs` wiring lands AFTER it, so this batch tests the deterministic-only watcher.
- Worktree `/tmp/crazyagent-accept-2abb065` (harness/scenarios committed at the pin via `11ba028` ancestry — no overlays); fresh isolated home `/tmp/crazyagent-m3-eval/dsh-home`; 1017 @ medium; `--marathon` new-switch arming (per-run OFF-verified → enable → ON-verified → bare prompt; 5 `marathon.set` enables verified); `commitUnderTest` + `armingPath` in the batch JSON.
- Gates before spend: `npm test` **1201/1201** on the pin (matches Android's isolation evidence), c1 + scenario self-tests green. Same pin as the M2 steer-plan rerun (task-9 closed GREEN first).

### Per-run results and watch telemetry

| run | verdict | wall s | steps | calls | failed | watch {checks, alerts, usage} | tick levels (ok/suspect/hard) | judge calls | planOutcome |
|---|---|---|---|---|---|---|---|---|---|
| 1 | pass | 44.7 | 28 | 27 | 0 | {2, 0, 0} | 0/2/0 | 0 | reported-complete |
| 2 | pass | 43.2 | 43 | 44 | 6 | {2, 0, 0} | 2/0/0 | 0 | reported-complete |
| 3 | pass | 221.3 | 71 | 70 | 2 | {11, 0, 0} | 3/8/0 | 0 | reported-complete |
| 4 | pass | 66.4 | 60 | 59 | 0 | {3, 0, 0} | 3/0/0 | 0 | reported-complete |
| 5 | pass | 59.5 | 27 | 36 | 0 | {3, 0, 0} | 2/1/0 | 0 | reported-complete |

All 12 stations recorded exactly once in every run (server-side step record); all failed calls recovered; `chat.done` label `done`, `planOutcome=reported-complete` ×5; **zero `chat.watch` frames of any kind** (no alert, no recovered, no ended-incomplete, no info).

### Verification sources (independent of the transcript)

1. **Live `GET /state` poller** (1 s cadence, isolated companion's own test token, port discovered read-only from its cmdline): **436 samples across all 5 turns; `marathon.watch.open` null in every sample**; `watch.checks` rose to 11; `lastVerdict` null throughout (no judge). Trajectory: `e2e/baselines/2026-11-17T03-37-05-390Z-m3-watch-trajectory.json`.
2. **`chat.done` frame.watch** (authoritative per-turn summary, extracted from archived `frame.out` records by turn time-window): alerts 0 / usage 0 / checks 2,2,11,3,3 — consistent with the per-turn `watch.tick` counts.
3. **Archived `watch.tick` events**: 21 total (10 ok, 11 suspect, **0 hard**); `open:null` on every tick. **`watch.judge.summary`**: calls 0, skipped 0, all token fields 0, budgetExhausted false ×5.
4. **Negative space**: zero `chat.watch` frames in the whole run log; zero `ended-incomplete`.

### Observations for M4 (recorded, not gates)

- **Soft suspects on healthy runs are real and frequent**: 11 of 21 ticks were `suspect` (r1 ×2, r3 ×8, r5 ×1) — correctly never alerted (soft signals alone never alert; judge unwired). When M4 wires the judge, suspects will bring judge calls forward on healthy runs; the two-strike rule + deterministic-corroboration requirement must keep false alerts at zero. r3's 8 suspects came from the known 221 s single-turn wander mode (M2 report cross-pin rates: wander 16%, redo 4%); it still completed faithfully with 0 redos.
- Healthy-turn checks scale with wall (2–3 checks for 43–66 s turns, 11 for the 221 s wander) — the 20 s cadence behaves as designed; deterministic-only cost is zero model tokens.

### Comparison vs clean M0

Completion/reliability identical: 5/5, 0 redos, 0 dead, 0 retries. Wall 43.2–221.3 s (med 59.5) vs M0 57.5–65.5 (med 61.9) — the median matches; the upper tail is the documented wander mode (r3: 601k non-cached input from a cache-miss pattern, output 5.8k normal). Failed Σ8 (all recovered) vs M0 Σ5 — same failure classes (stale labels/validation), within the documented variance. No regression signal from the watcher's presence; the watcher never steered, stopped, or mutated anything (read-only invariant held — turns completed normally with it ticking).

### Evidence

- Batch: `e2e/baselines/2026-11-17T03-37-05-390Z-m3-marathon-long-marathon.json` (annotated: `commitUnderTest`, `armingPath`, per-run `marathonArm`, `planEvidence`, `watchEvidence` {summary, tick levels, judge summary, chat.watch kinds}).
- Live trajectory: `e2e/baselines/2026-11-17T03-37-05-390Z-m3-watch-trajectory.json` (436 samples + summary).
- Archived log: `.dsh-home/browser-agent/logs/m0-archive/run-2026-11-17T03-37-05-493Z-6d9d73/events.jsonl` (4.7 MiB, gitignored, key-scan clean).

