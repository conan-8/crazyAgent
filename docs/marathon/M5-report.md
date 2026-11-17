# M5 report — Android phone: marathon chip, watch card, checklist, WATCH push

**Date:** 2026-11-16 · **Task:** shared task-6 · **Plan:** `MARATHON-PLAN.md` §5 M5 + §3.4/§3.6
**Scope:** the phone client for the landed M1–M3 protocol (and M4 judge alert shapes): `/marathon` rename, companion-owned chip, watch card with Stop / Steer… / It's fine, the first phone checklist, `WATCH` push type, and the push dedupe-key fix. **No on-device work, no re-pairing, no push delivery, no version bumps (M6).**
**Status:** all code gates green, including the opt-in live JVM client against the real Node fake companion. The on-device look and push delivery remain **still unrun** (below).

## Commits

- **`2abb065` — push change, committed separately at core's request** (`companion/remote-push.mjs` + `companion/test/remote-push.test.mjs` only). Verified green in isolation (fresh worktree at the pin, symlinked `node_modules`): `npm test` **1201/1201**, exit 0 — [`m5-evidence/npm-test-push-pin-2abb065.txt`](m5-evidence/npm-test-push-pin-2abb065.txt). This is the M2-steer-plan + M3 acceptance pin lead/core asked for; core's C1 integration test (`controller → observer → pushTypeForTurn === 'watch'`) consumes exactly this contract.
- **The M5 phone commit** (this report's change): `android/**`, `scripts/fake-remote-companion.mjs`, `scripts/remote-protocol-fixtures.mjs`, the new fixture, and this report. Scoped explicit paths; no other teammate's files.

## What changed

### Companion (`companion/remote-push.mjs` — the one companion file M5 owns)
- `PUSH_TYPES` gains **`watch`**, sent at **high priority** like help/confirm. The payload stays **exactly** `{type, turnId, instanceId, sequence}` (all strings); an old APK drops the unknown type by design.
- **Dedupe key becomes `turnId:type:ordinal`** (was per-turn, which would let a mid-turn watch push swallow the turn-end push). `ordinal` defaults to 0, must be a non-negative safe integer, and separates the ≤3 watch alerts of one turn while a retried identical push stays deduped. Skip reason relabeled `duplicate-push`; the bounded 200-entry eviction is unchanged.
- **`pushTypeForTurn` returns `watch` for an ended-incomplete marathon turn**: the authoritative `endedIncomplete` flag from the turn-end info wins; otherwise the watcher's own pure `decideEndedIncomplete` rule decides (shared import from `watcher.mjs`, acyclic — core's read-only review confirmed). Help/confirm waits still win; a user stop announces nothing; non-marathon behavior is byte-identical. Core's C3 wiring (`3f02e2e`) supplies the flag and the watcher push hook in `index.mjs`/`session-controller.mjs` (their scope).

### Android — protocol and state
- **`SlashCommands.kt`:** `marathon` replaces `plan` ("Plan every turn with a live checklist", panel wording); `SLASH_ALIASES {'/plan' → 'marathon'}` resolves the exact legacy token unlisted — no prefix filter ever shows it. **`SlashPalette.kt`:** `PlanModeRow` replaced by **`MarathonChip`** (`.marathon-mode` parity: uppercase badge, copy line, ×; solid-yellow alert variant).
- **`RemoteApi.kt`:** `setMarathon(enabled, clientCommandId)` → `POST /marathon`; `ackWatch(id, clientCommandId)` → `POST /marathon/watch/ack`; **`sendMessage` drops its `planMode` parameter**.
- **`RemoteController.kt`:** `toggleMarathon()` (idempotent command ID kept on an uncertain answer, **no optimistic flip** — the chip changes only on `remote.marathon`; allowed mid-turn), `ackWatch()` (404 `WATCH_NOT_FOUND` tolerated — the stream reconciles), `steerFromWatch()` (the panel's steer toast wording). `UiState.planMode` is gone; a hidden `legacyPlanMode` carries a **pre-M5 stored pending's** flag through Edit/Send again. Delivery maps it to `setMarathon(true, "<messageId>-marathon")` before the plain send (shared `deliverLocked` with the reconcile retry, same IDs), so **old queued items keep working**; a failed arming never blocks the message. `Stores.kt`/`AndroidStores.kt` unchanged: `StoredPending.planMode` is still read from (and written to) the encrypted store in its old shape.
- **`ChatState.kt`/`ChatReducer.kt`:** `marathon: MarathonState {enabled, since, plan, watch {open, lastVerdict, lastCheckAt, checks}}` mirrors the projection fail-closed (off is the default; non-boolean enabled → off). `remote.marathon` updates switch/plan/watcher counters and **preserves the open alert** (hub parity); off clears everything. `remote.watch` sets the open alert for any open non-info/non-recovered kind — hard signals, **M4 judge `stuck`/`blocked`**, `ended-incomplete`, or a future kind — and clears it on recovered/dismissed/info. `watchNotice` drives the card (open actionable vs collapsed summary). `chat.session` resets both; `chat.user` keeps the open alert but drops a collapsed summary. Carried-plan validation mirrors `normalizeMarathonPlan` exactly (non-negative integral revision, string markers, 1–40 items, non-blank unique content, the four provider statuses; anything malformed → null, never a partial plan).
- **Resync parity fix (latent bug the new fixture exposed):** `fromProjection` now re-applies the projection's **phase** after the committed-messages loop, like it already did for turn — `chat.user` clears the phase, so a mid-turn resync previously lost "Using browser_click…" and fell back to "Thinking…". All six pre-existing fixtures stay byte-identical and green.

### Android — UI (new-UI theme, parked work `c296601`)
- **`MarathonChip`** above the composer: visible and tappable **while busy**; copy mirrors the panel (`Every turn uses a live checklist` / `Watching this turn` / `Checked 3m ago` / `May be stuck — review the alert`, amber while an alert is open). `/marathon` in the palette and as an exact send both toggle; `/plan` resolves to the same command.
- **`WatchCard`** modeled on the help card (`RequestCard`): kind badge (panel `WATCH_KIND_LABELS` parity incl. Stuck/Blocked), title ("The agent may be stuck" / "The turn ended incomplete"), the reason as selectable plain text, and **Stop** (the ordinary stop, red like `.watch-row-stop`; disabled when the turn is over), **Steer…** (focuses the composer via `FocusRequester` + the panel's steer hint), **It's fine** (primary; ack/snooze). Recovered/dismissed notices collapse to a quiet dot + summary line.
- **`PlanChecklistCard`**: collapsible (chevron, manual state kept across updates and process death), header "Marathon plan · Revision N · X open of Y", per-item status dots (completed green / in_progress yellow / pending dim / blocked red). The plan arrives with `remote.marathon` at turn end and on resync — the phone's first checklist.
- Composer hint follows the switch; Settings notification hint now mentions "may be stuck".

### Android — push
- **`PushMessage.Type.WATCH`**: title **"crazyAgent may be stuck"**, text **"Open to see what it is doing."** — generic wording only; the reason is fetched over the authenticated API after the tap. Same exact-shape parse (extra keys still dropped). **`Notifier`**: watch is urgent → the existing **`agent_help`** high-importance channel, high priority, one notification per turn (a later push for the same turn replaces it).

### Scripts / fixtures
- **`scripts/remote-protocol-fixtures.mjs`:** new `marathon-watch` scenario recorded from the **real `RemoteHub`** through the script's existing in-process pattern (deterministic clock; fully isolated — no ports, never the live companion at 17871/17873). It covers: switch on (remote origin), an armed turn, watcher counters, a hard `TOOL_HANG` alert, **judge `stuck` (source watcher) and `blocked` (source both) alerts**, recovery collapse, the carried plan (rev 2, 3 items, 2 open), `chat.done` with both mode flags + `planOutcome` + the additive `watch {checks, alerts, usage}` summary, `ended-incomplete`, an "It's fine" dismissal, and the new-chat reset. Four hub checkpoints (`afterAlert`, `afterJudge`, `afterBlocked`, `afterEnded`) plus the final projection. **The six existing fixtures are byte-identical**; `--check` green.
- **`scripts/fake-remote-companion.mjs`:** keyword **`marathon-stuck`** — with the switch on, the turn hangs a `browser_wait_for` call until the **real deterministic watcher** alerts (the fake runs it on an accelerated clock: 60×, 250 ms ticks, so the 240 s hard threshold lands in ~4 real seconds), recovers with three successful results including a mutation, advances the plan to rev 2, and ends `PARTIAL` with `planOutcome: unfinished` → carried checklist + ended-incomplete. Plan/turn-outcome activities go through `controller.noteActivity` like the provider's; watch push requests are recorded on `watchPushes` (the fake sends no FCM). Healthy scripted turns (incl. `slow`) never cross a hard threshold. `stop()` disposes the watcher.

### Docs (truthful now; the AGENTS.md/STATUS.md final pass is M6)
- `android/README.md`: status line (M5 verified from JVM tests, not on a phone; push still never delivered; in-app alerts only while connected until `conan-evo-x3` push is proven), the composer/marathon/watch/checklist behavior, the `marathon-stuck` keyword, and the test inventory.

## Gate results (cheapest first)

| Gate | Result | Evidence |
|---|---|---|
| `npm test` (push + fixture staleness + everything else) | **1201/1201 pass, 0 fail, 0 skip** (includes the 17,100-char prompt ceiling and the Android fixture-staleness gate; the count includes core/judge's concurrent M4 tests landed in the tree) | [`m5-evidence/npm-test.txt`](m5-evidence/npm-test.txt) |
| `npm test` at the isolated push pin `2abb065` | **1201/1201 pass**, exit 0 (fresh worktree, symlinked `node_modules`; worktree removed after) | [`m5-evidence/npm-test-push-pin-2abb065.txt`](m5-evidence/npm-test-push-pin-2abb065.txt) |
| Fixture staleness | `node scripts/remote-protocol-fixtures.mjs --check` green; existing six fixtures byte-identical, `marathon-watch.json` additive | run output in this report's commit; fixture at `android/app/src/test/resources/remote-protocol/marathon-watch.json` |
| `./gradlew testDebugUnitTest lintDebug` (toolchain `~/Android`) | **BUILD SUCCESSFUL — 125 tests, 0 failures, 0 skipped; lint 0 issues.** The 2 opt-in `LiveFakeCompanionTest` tests **ran** (not skipped) against the real Node fake companion on `127.0.0.1:17893` with an isolated `/tmp` token — including the new `marathonStuckShowsChipWatchCardAndChecklist` | [`m5-evidence/android-testDebugUnitTest-lintDebug.txt`](m5-evidence/android-testDebugUnitTest-lintDebug.txt) |
| Fake-companion `marathon-stuck` run (independent surface) | **ALL DEMO ASSERTIONS PASS** — a Node driver over real HTTP + `/events` against an isolated `startFakeCompanion` (port 0, own token), inspecting `GET /state`, never client claims | [`m5-evidence/marathon-stuck-demo.json`](m5-evidence/marathon-stuck-demo.json) |

### The marathon-stuck demo transcript (independent check)

1. Initial `GET /state`: `marathon.enabled:false`.
2. `POST /marathon {enabled:true}` → 200; `/state` on (what the chip does).
3. `POST /messages {text:"marathon-stuck demo"}` → 202; the turn runs.
4. `remote.watch` **TOOL_HANG open** arrives mid-turn; `GET /state marathon.watch.open.kind === 'TOOL_HANG'` while `turn.status === 'running'` — the watcher only reported, never stopped the turn.
5. `POST /marathon/watch/ack {id}` → **200 acknowledged**; the dismissed notice arrives; `/state` open alert null.
6. `chat.done` carries `marathon:true, planMode:true, label:'partial', planOutcome:'unfinished'` and the additive `watch {checks:33, alerts:1, usage:0}`.
7. `remote.marathon` carries the plan **rev 2 × 3 items (2 open)**; `remote.watch` **ended-incomplete open**; `/state` shows both.
8. `POST /new` → `/state` marathon off, plan null, watch open null.
9. `fake.watchPushes` recorded one `{type:'watch', kind:'TOOL_HANG'}` request — the watcher asked for a push; **no FCM was sent** (delivery is still unrun).

The JVM live test asserts the same story through the **real phone client**: chip flips only on `remote.marathon`, stays tappable while busy, the alert card is actionable, the ack goes through the real route, the checklist renders rev 2 with statuses completed/in_progress/pending, and a new chat resets everything.

## Reducer/test coverage added

- `MarathonReducerTest` (14 tests): switch mirroring + fail-closed off; plan validation fail-closed (11 malformed shapes); hard alert open; **judge stuck/blocked actionable**; recovery collapse; dismissal/info; ended-incomplete; watcher counters preserve the open alert; session reset; new-turn keeps open / drops collapsed; **resync parity** (envelope-built state == `fromProjection`, including the deliberate collapsed-notice loss); dedupe/gap/instance resync; chip copy, checked-ago, plan summary.
- `ReducerFixtureTest.marathonWatchMatchesHubProjection`: full replay == hub final projection, four hub checkpoints reached live, duplicate replay a no-op, judge kinds actionable, dual flags + watch summary on `chat.done`, checklist contents, dismissal, new-chat reset.
- `RemoteControllerTest` (+8/−1): companion-owned toggle (no optimistic flip, mid-turn, new-chat reset), uncertain toggle same-ID retry, watch ack 200 + stream dismissal, 404 tolerated, **open alert survives a full resync**, recovery collapse, **old stored `planMode:true` pending → marathon-on call + plain send**, Edit/Send again keeps the legacy mapping.
- `SlashCommandsTest`, `PushMessageTest` extended (alias unlisted/resolvable; WATCH exact-shape parse, generic wording, per-turn notification ID).
- `remote-push.test.mjs`: dedupe contract updated to per-push; watch priority/payload/ordinal coverage; ended-incomplete decision table (explicit flag, label/planOutcome/deadTurn/error derivation, help/confirm precedence, stopped silence, non-marathon unchanged).

## Design decisions / known notes

- **The card shows kind + reason only.** `blocker`, `signals`, and `source` ride the wire but are not in the `/state` `watch.open` projection, so they cannot survive resync parity; the reason carries the judge's plain text (≤240 chars). The panel keeps them in its transcript row.
- **Collapsed notices are transient.** After a full resync only the open alert is reconstructed (the projection carries no collapsed history) — deliberate, companion-authoritative.
- **Ended-incomplete + "It's fine":** the landed M3 watcher clears its `openAlert` at turn end, so acking an ended-incomplete notice returns 404 `WATCH_NOT_FOUND` (the hub mirror keeps showing it until the next watch event, marathon off, or a session change). The phone tolerates the 404 without a banner; the card behaves exactly like the panel's row. Mid-turn alerts ack normally (200 + snooze).
- **The open alert persists across turns** until cleared — hub parity (`turnStarted` does not clear the mirror). The chip/card follow the companion, never local assumption.
- **Push ordinal contract:** turn-end pushes use ordinal 0; the watcher hook (core's C3 wiring) supplies per-turn ordinals for the ≤3 watch alerts. `pushTypeForTurn` needs the `marathon`/`endedIncomplete` fields core's C3 now adds to the turn-end observer info — without them it falls back to the shared pure rule.
- The fake's accelerated watch clock is demo-only behavior of the fake; the real companion keeps the 20 s tick and real thresholds.
- The user's live companion at `127.0.0.1:17871`/`17873` was never touched; every run used isolated ports/tokens/homes. The phone was not touched at all (no adb, no re-pairing).

## Still unrun — needs the user (M6 puts these in `docs/STATUS.md`)

- **Installing the APK** built from this change (no on-device work was done in M5).
- **The on-device look** of the marathon chip, watch card (incl. stuck/blocked judge alerts), and collapsible checklist — JVM/live-fake state verification is not a phone screen.
- **Push delivery via `conan-evo-x3`** — no push has ever been delivered. That computer still needs the same service-account key and a companion restart before the app can register; the phone stays paired with it (2026-11-16 decision, do not re-pair). Until push is proven, watcher alerts reach the phone **only while the app is connected**.
- Real-companion phone verification of the M5 screens (the live gate used the fake companion's real remote API, not the user's companion).

## Next

- M6 (task-7): `AGENTS.md`/`docs/STATUS.md`/`HANDOFF*`/`REMOTE-ACCESS.md` final pass, version 2.4.0, the still-unrun list above, reload extension then restart companion.
- M4 judge acceptance (core/judge + eval) continues in parallel; the phone already renders its alert shapes.
