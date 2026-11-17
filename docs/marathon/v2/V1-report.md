# V1 report — alert lifecycle (explicit close frames, dismissable ended-incomplete)

**Date:** 2026-11-17 · **Task:** shared task-14 (core) · **Plan:** `MARATHON-V2-PLAN.md` §3.2 + §5 V1 + G5
**Branch:** `v2/v1-lifecycle` (worktree from main `8220205`, the v2 governing-doc commit). **Merge waits on the V0 replay baseline** (lead reviews + merges).
**Scope:** fix G5 — alerts outliving their turn and `ended-incomplete` not dismissable. **Production change is just `companion/watcher.mjs` + `companion/session-controller.mjs`**; the hub, remote-server, panel, and Android reducer already handle a non-`open` state generically, so `closed` is treated like `dismissed` with no production change on those surfaces. The watcher stays **report-only**.

## What changed

### `companion/watcher.mjs`
- New `openEndedIncomplete` state: the open `ended-incomplete` notice remembered after a turn ends, until the next turn start or an ack. **One open notice invariant** — a mid-turn alert (`openAlert`) and an ended-incomplete notice are never open at once.
- `turnEnded`: an open mid-turn alert is closed with an explicit `chat.watch` frame `{kind:'info', state:'closed', reason:'Turn ended.'}` carrying the alert's **own id** (the way `recovered`/`dismissed` already do), so every client collapses the row it shows. If `ended-incomplete` fires it **supersedes** the alert: the alert closes in the same step (close frame precedes the ended-incomplete open frame) and ended-incomplete becomes the one open notice.
- `ack(id)`: on the remembered ended-incomplete notice returns `{ok:true}` and closes it (`state:'dismissed'`, reason "Dismissed.", **no snooze** — there is no next tick to suppress). Mid-turn alert ack still snoozes the kind 15 min (unchanged).
- `closeEndedIncomplete(reason)`: publishes the close frame for the controller's `#begin` (own id, stored turnId).
- `clearNotices()`: clears both notices without a frame (marathon off / `/new` / chat switch — the off frame already tells clients to clear).
- `watchProjection().open` reflects the one open notice (mid-turn alert OR ended-incomplete), so `/state marathon.watch.open` is correct after a turn ends.

### `companion/session-controller.mjs`
- `#begin` calls `watcher.closeEndedIncomplete('A new turn started.')` **before** the new turn's first frame, so the amber state never carries into a turn.
- `setMarathon(off)` and `#resetMarathon` (new chat / real chat switch) call `watcher.clearNotices()`.
- `watchAck` delegates to `watcher.ack` (now 200 for ended-incomplete).

### No production change needed (verified generic)
- **Hub** `#onWatch`: clears `marathon.watch.open` for any non-`open` state and journals `remote.watch` — `closed` already behaves like `dismissed`.
- **Remote-server** `#postWatchAck`: delegates to `controller.watchAck` → `watcher.ack` (200 for ended-incomplete).
- **Panel** `watch-row.js` `watchIsActionable` requires `state==='open'` (closed/dismissed/recovered all collapse, no buttons); `app.js handleWatch` sets `watchAlert = watchIsActionable(notice) ? notice : null` (amber chip clears on closed). Buttons unchanged for open actionable alerts.
- **Android** (task-15, android): `WatchNotice.actionable` gates on `state=='open'` + actionable kinds, so closed/dismissed/recovered collapse; old APKs safe. No reducer production change.

## Gates (cheapest first)

| Gate | Result |
|---|---|
| `npm test` (full) | **1256/1256** (v2.4.0 baseline 1237 + 19 V1 tests). `v1-evidence/npm-test.txt`. |
| watcher tests | **24/24** (+7 V1: turn-end close own-id; supersede ordering; ack ended-incomplete 200 no snooze; closeEndedIncomplete; clean end no close frame; clearNotices; mid-turn ack still snoozes). |
| controller tests | **57/57** (+5 V1: turn-end close; ended-incomplete ack 200; #begin close before first frame; marathon off clears; newChat clears). |
| hub tests | **37/37** (+3 V1: closed clears watch.open + journals remote.watch; ended-incomplete open→close one-open-notice; closed remote.watch replays). |
| remote-server tests | **49/49** (+2 V1: ack on ended-incomplete 200 + /state clears + re-ack 404; next turn closes before first frame, /state clear). |
| panel watch-row tests | **8/8** (+2 V1: closed collapses row no buttons; ended-incomplete actionable open then collapses closed/dismissed). |
| `ui-preview --scenario watch` | **PASS**, 7 screenshots inspected (`v1-evidence/ui/`): alert, dismissed, recovered, ended-incomplete (actionable + amber), **closed-new-turn** (row collapsed "A new turn started.", chip "Watching this turn"), **closed-turn-end** (row collapsed "Turn ended.", chip clear), narrow. |
| fake-companion `/state` after each boundary | **PASS** (`scripts/v1-lifecycle-check.mjs`, real controller+hub+remote-server+watcher 60x clock, `v1-evidence/fake-companion-lifecycle.txt`): mid-turn alert closed at turn end ('Turn ended.', own id), /state clear; ended-incomplete one open notice; 'It's fine' → 200 + /state clear; next turn closes ended-incomplete ('A new turn started.') before first frame, /state clear; marathon off clears. **Stale alerts 0 on /state after every boundary.** |
| Android (task-15, android `5ea6cb8`) | fixture `marathon-watch-lifecycle.json` recorded from the **real hub** (merged core `c0d89d5`); **138 JVM tests / 0 fail** + live JVM 2/2 vs V1 fake; fake-companion lifecycle **8/8** (close own-id seq-ordered before chat.user, ack 200 'Dismissed.'); pre-V1 baseline reproduced G5. |

**Done-when met:** stale alerts 0 on every surface in fixture + fake-companion; "It's fine" on ended-incomplete returns 200. The replay stale-alert gate on the corpus runs once the V0 infra lands (replay owns watcher-eval; coordinate with replay). Live lifecycle evidence doubles from the V2 stall-loop batch later.

## Commit chain (v2/v1-lifecycle)
- `a432450` step 1 watcher lifecycle (+7 tests).
- `fa91f67` step 2 controller wiring.
- `b1edf7b` step 2 controller tests (+5).
- `ecbf1bb` step 3 hub tests (+3, no production change).
- `c0d89d5` step 3 remote-server tests (+2, no production change). ← android merged this for the fixture.
- `94a5651` step 4 panel watch-row tests (+2, no production change).
- `6332549` step 4 ui-preview watch closed-lifecycle steps.
- `d860063` step 5 fake-companion check + evidence.
- (this report + AGENTS.md/STATUS.md V1 lifecycle wording).

## Invariants preserved
Watcher report-only (never steers/stops/captures/retries/mutates outcomes); hard signals model-independent; untrusted input; cost separate; one runner/one turn slot; marathon switch companion-owned; 34 standing tools; prompt ceiling; remote API limits. The maintainer's auto-updater (`cdcd9d1`) untouched.

## Coordination
- android task-15 complete/accepted (`5ea6cb8`); frame shape matched exactly; V6 hub will ingest `chat.activity` kind `plan` → `remote.plan`, and V4's seeded activity `{seeded:true, awaitingUser:false}` flows through the same path (noted for V4).
- Merge waits on the V0 replay baseline (replay took over watcher-eval; judge stood down to V5 prep).
