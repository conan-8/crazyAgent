# Unreleased (post-v2.5.0)

- **The watcher's judge works with any model again.** v2.5.0 pinned every judge call to one OpenRouter provider (Morph). Morph serves only part of OpenRouter's catalog, so with most other models every judge call failed and the watcher quietly ran on its deterministic signals alone. The pin, and the fixed seed sent with it, now apply only to the configuration they were measured on: `deepseek/deepseek-v4.1-flash-1017` on OpenRouter. Other models and base URLs send the unpinned request, as v2.4.0 did. The judge log now records which routing a call used.
- **The "judge budget spent" notice no longer hides an open alert.** When the judge's per-turn budget ran out while an alert was open, the notice replaced the alert: the panel chip went off, the phone card changed, and `/state` showed no open alert. The notice now waits until no alert is open, and the turn's judge summary reports when the budget ran out.

Unit-tested (`npm test` 1320/1320); no real-model or phone run yet.

# crazyAgent v2.5.0

Changes since **v2.4.0**. This release ships **marathon v2 (V1–V8)** — watcher reliability and plan-friction improvements on top of the v2.4.0 marathon mode. The acceptance evidence below is **marathon-scoped** (isolated harness, `deepseek/deepseek-v4.1-flash-1017` @ medium, independent checkers). The maintainer's **automatic-updater** feature (`cdcd9d1`) is **preserved verbatim** from v2.4.0 (see below) — it was landed and verified by the maintainer, **not** independently accepted by the marathon team.

The extension uses numeric update version `2.5.0`. The Android app is version `0.8.0` with version code `7`. The **signed** `0.8.0 (7)` release APK is a **user action** (the maintainer signing keystore is user-side, as for the v2.4.0 artifact `8c74976`). The unsigned release APK (`assembleRelease`, BUILD SUCCESSFUL) has SHA-256 `1de9dfea10800bada737d64336a8307dadaade917927ad9d61682896871e9200` (not installable); signing + publishing the signed APK with the existing release certificate remains still-unrun until the user signs it. **Activation stays the user's:** reload the unpacked extension first, then restart the companion.

## Marathon v2 (V1–V8)

- **V1 — alert lifecycle:** every open watch notice is closed by an explicit `chat.watch {state:'closed'}` frame (its own id); a mid-turn alert open at turn end closes ("Turn ended."), `ended-incomplete` supersedes it as the one open notice (dismissable, "It's fine" → 200 no snooze), and the next turn start closes it ("A new turn started.") before the first frame — the amber state never carries into a new turn. Stale alerts **0** on every surface (`/state`, panel, phone reducer). (`docs/marathon/v2/V1-report.md`.)
- **V2 — progress accounting:** the ledger classifies tools observe/control/act; control tools (`browser_plan`/`agent_request_help`/`agent_request_confirmation`) are excluded from the stuck signals and recovery (a `PLAN_*` error is plan friction, not a stuck browser); an ok act matching the provider's `NO VISIBLE CHANGE` marker is no-effect (shared predicate), feeding the soft `NO_EFFECT` signal (never alerts alone). **Recovery needs evidence** (≥2 effectful acts + signals absent 2 ticks, or completed-count up). Live all-4 done-when green: falseRec 0, FA 0 healthy, caught 1/1 past-patience, healthy epic suspect **86.0% ≤ V0 90.4% (improved)**. (`V2-report.md`/`V2-live.md`.)
- **V3 — page-scoped repeated work:** `REVISIT_HINT` mutation-revisit is now page-scoped (same page + same control + same outcome, threshold 2; unknown page excluded), removing multi-page false revisits on healthy work. Live FA **0 ×10 runs** + mutation-revisit fires **0 on healthy** (marathon-long ×5 + epic ×5); replay holdout caught 0.920 ≥ V2. Recorded trade-off: page-scoping also removes multi-page stuck corroboration (tune caught dip) — restored by V5's deterministic judge. (`V3-report.md`/`V3-live.md`.)
- **V4 — continuation context:** an accepted plan seed emits one seeded plan activity at turn start (the ledger has the plan snapshot immediately); an internal carry chain (≤3 ancestor prompts, never published, never in the agent prompt) lets the judge learn the task behind a "continue" prompt. Live stop-then-continue ×5 **redo 0/5 + healthy continuations silent + seeded 5/5**. Model-variance items recorded honestly (seeded-untouched reliability ~60%, c1 steer-plan row brittleness) — the V4 agent prompt is byte-unchanged. (`V4-report.md`/`V4-live.md`.)
- **V5 — judge stability (ACCURACY BREAKTHROUGH):** the v1 judge's temp-0 verdicts were non-deterministic because OpenRouter load-balances each request across ~50 endpoints/quantizations. Pinning provider routing (`morph/fp8`, `allow_fallbacks:false`, `require_parameters:true`) + a fixed `seed:42` made verdicts deterministic: gated stuck caught **1.000 mean / stability 1.000 on BOTH tune and holdout (k=5)**, FA 0 worst, clean improved, cost ~1× V4. Judge effort stays low / max_tokens 400. **The v1 FALLBACK A stuck-window gap (6/9) is closed.** (`V5-report.md`.)
- **V6 — live checklist on the phone:** the hub forwards the live plan mid-turn (`remote.plan` + `/state.turn.plan`, validation reuses the carried-plan rules, identical-consecutive dedupe); the phone renders the updating checklist. Code + JVM + real-hub fixture verified; **on-phone appearance still unrun**. (`V6-report.md`.)
- **V7 — one-tap push test:** `POST /push/test` (idempotent, 1/min) + a `test` push type + a phone Settings button give one-tap proof of the push route. **This does not make delivery happen** — delivery still needs the user's `conan-evo-x3` service-account key + a companion restart there. (`V7-report.md`.)
- **V8 — less plan friction when blocked:** `browser_plan` items gain an optional blocked-only `reason` (≤240 chars; `PLAN_REASON_STATUS` on any other status); an open item moving to blocked may append a " — blocked: …" suffix to its content without acknowledgement (prefix identity rule); `PLAN_IN_PROGRESS_REQUIRED` guidance adds "mark them blocked too, or ask the user". Every carry-chain validator keeps the reason; the panel and phone show it under a blocked item. Real-model gate: `PLAN_*` failures ≤2 total vs M4's 11, no pass-rate/help/BLOCKED change. (`V8-report.md`.)

Marathon v2 per-commit `npm test`: 1237 v2.4.0 head → 1285 V2 → 1293 V3 → 1303 V4 → 1315 V8 (V5 adds judge-routing tests; final count re-verified at the release head). Evidence: `docs/marathon/v2/V0-baseline.md` … `V8-report.md` + `e2e/baselines/`. **Still unrun:** WATCH/test push delivery via `conan-evo-x3`, the on-phone V6/V7/V8 appearance, and the live docked-panel visual (see `docs/STATUS.md`). **V9 (marathon survives a restart) is deferred** (decision #10).

---

# crazyAgent v2.4.0

Changes since **v2.3.0**. This release adds **marathon mode** — a sticky, companion-owned planning switch with plan carry-over and a read-only watcher (deterministic alerts plus an optional model judge) — and the maintainer's **automatic updates** feature. Marathon M1–M5 real-model acceptance is green on the isolated harness; the acceptance evidence below is **marathon-scoped**. The automatic-updater feature was landed and verified by the maintainer (its own tests + a real scratch-clone update), **not** independently accepted by the marathon team.

The extension uses numeric update version `2.4.0`. The Android app is version `0.7.0` with version code `6`. The signed release APK has SHA-256 `863fb04cd028f02cd574e68cd8e8c82a0c7af8a273796892d9f5776edb2f9592`; `apksigner verify` accepted it with the same signing certificate as the previous release.

## Marathon mode (M1–M5)

- **Sticky switch (`/marathon`, unlisted legacy alias `/plan`):** one companion-owned state shared by the side panel and the phone API; clients render it and never optimistically flip it; off on `/new`, a chat switch, or companion restart. A legacy one-shot `planMode:true` message still arms a single turn. A mid-turn toggle never re-arms the running turn. (M1; `docs/marathon/M1-report.md`, independent check `scripts/marathon-independent-check.mjs`.)
- **Plan carry-over + refill limits:** a turn ending with open checklist items carries the list into the next turn (fail-closed seed validation); stop a long task and "continue" resumes from the first open item without redoing completed work; an unrelated question after a stopped marathon is answered without plan nudges. Completion nudges/stale reminders refill per accepted revision under a per-turn lifetime cap. (M2 + task-10 continuation-fidelity tuning; `docs/marathon/M2-report.md`. Real-model: stop-then-continue ×5 **5/5** zero redos, unrelated ×5 **5/5**, marathon-long ×5 within M0 noise, steer-plan PASS — pin `2abb065`.)
- **Deterministic watcher:** a pure per-turn ledger alerts on hard stalls — silence (300 s), a hung tool (240 s), a lost executor (120 s) — without the model; one open alert, kind-change/15-min re-alert, ≤3 alerts+pushes per turn, recovery collapse, "It's fine" snooze, and an `ended-incomplete` notice on unfinished/blocked/dead/error endings. The panel shows a watch row (Stop / Steer… / It's fine) + amber chip; the phone gets a watch card. The watcher **only reports** — it never steers, stops, or changes the turn. (M3; `docs/marathon/M3-report.md`, real-extension fixtures `scripts/watch-fixtures-e2e.mjs`. Real-model marathon-long ×5 **ZERO alerts** on healthy runs.)
- **Model judge (M4, FALLBACK A):** one stateless tool-less chat-completions check per cadence window (key never logged), two-strike alert rule, budget 40 calls / 150k input tokens per turn, strict schema validation → `unknown` on any deviation, bounded per-turn aggregates + a `REVISIT_HINT` soft signal. A verdict is a diagnostic, not verification; hard signals alert without it and it can never veto them. **Recorded deviation:** stuck-window detection 6/9 (67%) against the ≥80% target (distinct-run 6/7 = 86% is nuance, not the gate); **zero false alerts on healthy runs is met** (0/53 replay fine windows; live 15/15 zero healthy false alerts with 5 true-positive alerts on genuine looping). The v1 judge is low-effort/text-only/cadence-sampled and intermittent varied-activity wander can read as progressing; the top v2 follow-up is the continuation-plan-snapshot gap. See `docs/STATUS.md` Known limitations + `docs/marathon/M4-report.md` (offline replay `scripts/watcher-eval.mjs`).
- **Phone (M5):** marathon chip (visible+tappable while busy), watch card, collapsible plan checklist, and a `WATCH` push type (dedupe `turnId:type:ordinal`). Code + JVM + fake-companion verified; **on-device phone marathon screens + WATCH push delivery are still unrun** (see `docs/STATUS.md`). `docs/marathon/M5-report.md`.
- **Watcher cost is reported separately** from agent usage (`watch {checks, alerts, usage}` per turn; judge tokens logged apart).

Marathon per-commit test counts: 1055 pre-M1 / 1085 M1 / 1105 M2+tuning / 1152 M3 / 1214 M4 / 1237 release head (with the maintainer's updater tests). Evidence: `docs/marathon/M0-baseline.md` … `M6-report.md` + `e2e/baselines/`.

## Automatic updates (maintainer feature, `cdcd9d1`)

*Landed and verified by the maintainer — not independently accepted by the marathon team. The marathon acceptance evidence above is marathon-scoped. Preserved verbatim from the maintainer's release note:*

## 2026-11-16 — automatic updates

- **Installations update themselves from this release on.** The companion checks GitHub's latest published release about every six hours, fetches a newer tag, and — once no turn has run for about ten minutes and marathon is off — stops its servers, checks the tag out, runs `npm ci` and setup, and exits with code 75 so `npm run dev` or the service restarts it on the new version (`companion/updater.mjs`). The unpacked extension then reloads itself when its on-disk manifest is newer than the loaded one (`extension/self-update.js`); the side panel must be reopened after that reload.
- **Fail closed.** Only a checkout of the official repository that sits exactly on the running version's release tag with no modified tracked files is touched; a branch, fork, or edited installation is reported as `ineligible` with a reason. No forced checkout, reset, or clean. A failed install restores the previous tag and dependencies and is not retried for a day. Without a supervisor (`CRAZYAGENT_SUPERVISED=1`, set by `npm run dev` and `config/crazyagent.service`) an update is only announced. `--no-auto-update` / `CRAZYAGENT_AUTO_UPDATE=0` turns it off; `--no-dsh` test mode never updates.
- `/health` gains `version` and `update {state, reason, current, latest, lastCheckAt}`.
- **Not covered:** v2.3.0 and older installations (they need one manual update), and the Android app.
- Verification: `npm test` **1237/1237** (17 updater tests on real temporary Git repositories, 6 extension self-reload tests). Real run on a scratch clone of v2.2.0 from GitHub: the updater found v2.3.0, fetched the tag, checked it out, ran real `npm ci` and setup, and asked for a restart; tag, versions, and a clean `git status` were read back independently. `scripts/edge-selfupdate-e2e.mjs` (isolated headless Edge, copied extension): the extension reloaded itself onto a newer on-disk version after 60 s and did not loop; `edge-background-e2e.mjs` 12/12 after the change. The dev-supervisor restart and the real companion's `ineligible` report on this development checkout were also exercised. **Unrun:** a complete update of a live installation from one published release to the next (no newer release exists yet), the Windows `npm ci` path, and an extension reload with the side panel open.

## 2026-11-16 — model pin and composer polish

- **Default model pinned to `deepseek/deepseek-v4.1-flash-1017`** (OpenRouter "DeepSeek V4.1 Flash 1017"). Every live default now references the pinned snapshot: the panel's recommended model, the companion's `RECOMMENDED_MODEL_ID`, the saved `llm.json`, `config/browser.patch.yml`'s compaction `modelPolicies`, `config/crazyagent.service` (and the installed unit), the `model-eval`/`reload-midturn-accept` defaults, the UI-preview mock, and the README install instructions. Dated run records (baselines and history sections) keep the un-pinned alias they actually requested. The running service was restarted onto the pinned ID and independently verified (`/health`, startup log, regenerated `llm.patch.yml`). Real-model smoke on the pinned ID: `form-submit` ×1 **PASS** (6.4 s, 2 calls, 0 failed, exactly one correct submission; `e2e/baselines/2026-11-16T23-41-31-295Z-model-1017-smoke.json`). Full reliability batches on 1017 are still unrun.
- **Enter on a blank composer sends the first queued message** — immediately when idle, or as a steer (stop the running turn, then send) while busy, the same action as the queue row's arrow button. An empty queue stays a no-op. Gated by the mock-bridge `queue` preview scenario; the new assertion failed on the pre-change build first.
- **Wait steps wear a stopwatch icon** (`icon-step-wait`) instead of the generic tool wrench. Gated by the `wait` preview scenario (icon href asserted, baseline failed first).
- **The composer's reasoning label abbreviates `medium` as `med`** so more of the model name fits on the line; the tooltip still says "Reasoning effort: Medium". Gated by the `tools` preview scenario (baseline failed first).
- `npm test` **1055/1055** after the changes; `ui-preview` `queue`, `wait`, and `tools` (1017 model display) scenarios pass.

## Release artifact and activation

- Signed Android release APK `0.7.0 (6)`: [`app-release.apk`](https://github.com/conan-8/crazyAgent/releases/download/v2.4.0/app-release.apk), SHA-256 `863fb04cd028f02cd574e68cd8e8c82a0c7af8a273796892d9f5776edb2f9592`, signature-verified with the existing release certificate.
- Reload the unpacked extension and reopen the side panel, then restart the companion to activate v2.4.0. The signed Android APK still needs separate on-device installation and acceptance.

---

# crazyAgent v2.3.0

Changes since **v2.2.0**. This release adds an opt-in confirmation step before irreversible actions, makes dead model steps recover inside the same turn instead of ending it, and records the first end-to-end pass of the signed-in Google Docs table suite. It also adds click `text_landed` postconditions, cuts the non-Docs prompt by 31%, fixes phone Continue for chats the running companion still owns, and ships a one-command gate runner.

The extension uses numeric update version `2.3.0`. The Android app is version `0.6.0` with version code `5`.

## Highlights

### Confirmation before irreversible actions (opt-in)

- A new setting, "Ask before submitting, sending, paying, or deleting" (`confirmIrreversible`, also `--confirm-irreversible`), is **off by default**; with it off, behavior is exactly as in v2.2.0.
- With it on, the model asks through the conditional `agent_request_confirmation` tool and the chat waits for an Approve/Deny. The side panel and the Android app both show the approval card, and the answer reads `Approved: …` or `Denied: …` in the chat. A `confirm` push type exists for the phone.
- An executor backstop covers a turn that skips the request: in a turn that did not start from the user's Approve, the executor refuses, before input, a `click`/`click_role`/`batch`/`type` on a control whose name matches the reviewed submit/send/pay/delete list, a native submit control of a POST form, or `submit:true`, with `CONFIRMATION_REQUIRED`.
- Enter-key submits and coordinate clicks are **not** covered. The gate is model-reported first, and a confirmation wait is not verification that the action was safe.

### Dead model steps recover in the same turn

- A step whose tool call arrives as DSML text, or an empty step before any tool call, gets at most two in-turn `agent.steer` notices; an output-token cutoff is continued the same way. The turn's conditional tools (`browser_plan`, `agent_request_confirmation`) stay armed.
- Root cause fixed: internal notices were sent with the `runtime-context` source kind, which the DSH loop replaces with its own context snapshot, so the model never saw them. They now use visible kinds (`agent-notice`, `token-limit-continuation`) and no longer reset the turn's repeat guard, executor circuit, or no-progress count.
- A reply the runtime rejects as `MALFORMED_RESPONSE` before any action is rerun once with the turn's modes re-armed. A turn that still did nothing ends as an error or a `BLOCKED:` answer, never as a blank success or raw markup.
- The side panel suppresses leaked DSML in the live reply stream and strips it from saved history; the panel and the Android app render both dead-turn endings.

### Google Docs tables

- The signed-in `scripts/edge-docs-table-e2e.mjs` suite passed end to end twice (13 executor calls, 0 failed, every step export-verified, values, bold, highlight, and native cell backgrounds verified after reload).
- Seven fixes at steps the suite had never reached: prove the Find match is the document selection before multi-edit formatting; scroll a below-fold native menu command into view; wait for a settled cell-background palette before a preset click; prove the anchor selection before positional structure commands; delete the proven selection before a cell write; settle the find counter before resolving an occurrence; collapse the cell selection before extending for a merge.
- The Docs custom-colour commit is fixed, and find, table, and expectation refusals are more specific.

### Evidence and prompt

- `text_landed` is available for clicks as a page-scoped absent-to-present check. It is allowed after a potentially document-changing batch step and reports unknown on a scope mismatch; it never produces a false verdict and never re-mutates. `export_contains` and `toolbar_style` are still rejected there before side effects.
- Docs guidance is conditional: it is added when the turn starts on a Docs tab, or returned with the first Docs call. The non-Docs prompt drops from 18,076 to 12,402 characters.
- `browser_drag` accepts `from`/`to` point aliases with strict normalization (conflicts fail closed), and the ambiguous-find refusal tells the model to stop rather than pick an occurrence.

### Remote and Android

- Phone Continue on a saved chat now works while the same companion process still owns it (direct resume first; an owned chat is restored through a runtime restart and resume from disk). A failed restore keeps the current chat and returns `SESSION_NOT_RESUMABLE`.
- Android `0.6.0 (5)`: approval cards, dead-turn rendering, and an optional `-PappIdSuffix` debug variant that installs beside the paired app for checks against the fake companion.

## Improvements and fixes

- `scripts/run-e2e-gates.mjs` runs the headless-capable real-extension suites in one command on its own fixture server, free ports, and a throwaway Edge profile.
- `scripts/c1-acceptance.mjs` exercises `/plan`, resume, steer, Stop/New cycles with token rotation, and minimized-window views through the real runtime on the same isolation as `scripts/model-eval.mjs`.
- `scripts/model-eval.mjs` and `scripts/analyze-failures.mjs` count dead turns, retries, and recovered turns; three confirmation gate scenarios were added.
- A null click result from a frame destroyed mid-injection fails closed as `CLICK_FAILED` instead of crashing.
- Test harnesses restore download isolation on Edge 157, which no longer honors the CDP download override for `chrome.downloads` downloads; the find suite pins its viewport.
- `npm run logs:prune` applies log retention, and run logs no longer store each browser result several times.
- Pure-move module splits: `guidance.js`, `validate.js`, and `repeat-guards.js` out of the provider's `index.js`; `views.js`, `labels.js`, and `docs-ops.js` out of the executor's `browser.js`. No behavior change.
- Android `RemoteControllerTest` timing assertions were hardened (test-only) after intermittent failures on hosted CI.
- `docs/STATUS.md` is now a current-behavior snapshot; retired working documents and older changelogs are archived verbatim in `docs/HISTORY.md`.

## Requirements

- Git and npm
- Node 24.9+
- Chrome/Chromium/Edge 116+
- An OpenRouter API key; provider usage charges apply
- Android 8.0/API 26+ for the optional native app
- Tailscale on the host and phone for normal remote access

See the tagged `README.md`, `android/README.md`, `docs/REMOTE-ACCESS.md`, and `PRIVACY.md` for installation and security details. GitHub source archives contain the complete extension and companion; no extension-only ZIP is required. After updating, reload the unpacked extension and restart the companion together: a v2.3.0 companion with confirmation switched on sends a `confirm_guard` argument that a v2.2.0 extension rejects.

## Verification

For this release:

- **1055/1055 Node unit/integration tests**; Android `testDebugUnitTest lintDebug`: **97 JVM tests, 0 failures, 1 opt-in skip, lint clean**
- Prompt composition: **12,402 characters** on a non-Docs turn, **18,092** on a Docs turn (core plus Docs guidance 17,096, ceiling 17,100)
- Real-extension gate runner on isolated headless Edge with independent page-state checks: `scripts/run-e2e-gates.mjs` **12 suites passed, 0 failed, 7 excluded** — find 7, expect 15, table 3, work 29, dialog 6, files 13, canvas 11, advanced 9, clipboard 11 (system-clipboard paths skipped without a real panel), background 12, drag, cursor 11. Excluded: click and capture (need a visible window), tabs and log (drive the running service), and the three live Google Docs suites (need the signed-in profile)
- Signed-in Docs table suite: two consecutive end-to-end passes, 0 failed calls, reload persistence verified (direct-executor; it does not evaluate model decisions)
- Scripted real-model batches (`deepseek/deepseek-v4.1-flash`, medium, baselines under `e2e/baselines/`): confirmation gates ×10 **30/30** with 3/3 leaked-markup retries recovered in-turn; form-submit ×30 **30/30, 0 dead turns**; form-submit ×10 with click `text_landed` allowed **10/10**; the 11-scenario set ×5 after the prompt split **50 pass / 5 partial / 0 fail**
- Real-runtime acceptance on the isolated harness: **5/5** (plan, resume on both paths, steer, 20 Stop/New cycles with 4 token rotations, minimized-window views)
- Signed Android release APK `0.6.0 (5)`, SHA-256 `3149a0f2c5654f30f420c9bfa4c32cec160bf91dc2bbdf6477bb96295aed9784`, `apksigner verify` accepted (same signing certificate as the previous release)

The real-model batches, the Docs suite passes, and the real-runtime acceptance were recorded during development on 2026-11-16 and were not repeated during final release packaging. Unit, integration, mock-bridge, and scripted-companion checks are not real-model acceptance.

## Known limitations and release boundaries

- The confirmation flow has not been accepted through a live docked panel or a physical phone against the real companion. The backstop does not cover Enter-key submits or coordinate clicks, and a small bypass rate is not excluded (one model, two fixtures).
- Model-driven Google Docs acceptance (`e2e/checklist.md` §3 A–D) and the live Docs-turn path under conditional guidance remain unrun; authenticated Docs export/toolbar expectations and Pivot remain pending.
- Real docked-panel `/plan`, drag, expectation, and download→upload workflows remain unrun; the isolated harness variants pass.
- No push notification has been delivered to a phone. Companion-side Firebase configuration has only passed a validate-only send.
- The signed release APK has not been installed over a debug build (different signing key: uninstall first, then pair again). A real service reboot acceptance remains unrun.
- A garbage non-markup fragment reply (about 1 in 30 in one batch) is not detected as a dead step and can end a turn as a blank-looking answer.
- A DSML tag split across stream deltas can flash briefly in the live feed before the guard removes it; the committed answer and saved history are clean.
- The Android timing fix has a single green hosted-CI run behind it; a rare test-only await timeout was still observed once locally.
- Remote browser execution requires an awake host, running companion, and running Edge (the side panel need not be open). System-clipboard work needs the panel.
- Never expose the privileged bridge or remote controller through Tailscale Funnel or an unauthenticated public listener.

---

# crazyAgent v2.2.0

Changes since **v2.1.0-beta**. This release is a reliability and evidence pass: drags and selections on opaque surfaces stop lying, a closed or reloaded executor fails fast instead of hanging, argument and refusal errors teach the model how to recover, and every turn now carries its own cost/failure evidence. It also ships the panel-less background executor, the agent cursor and shared UI motion, and a rebuilt Android app.

The extension uses numeric update version `2.2.0`. The Android app is version `0.5.0` with version code `4`.

## Highlights

### Reliability pass (Track B)

- Drags and selections whose source or destination is an iframe, canvas, video, object, or embed report `unknown` with a full view and a diagnostic pixel comparison instead of a false `DRAG_NO_EFFECT`. DOM no-ops still report no-op.
- Switching the active tab mid-drag no longer times out: the gesture finishes on the original tab and the result is refused as `DRAG_STALE_TAB` with `mutationPossible:true` and no other-tab view. Hidden-tab pacing (throttle-proof waits plus one discarded forced frame per slow input ack) keeps the refusal inside the command timeout.
- Two consecutive `SIDE_PANEL_CLOSED` results open a provider circuit: later browser calls fail at once with a "report BLOCKED" message until one succeeds, a new turn starts, or a bounded probe window passes.
- Pre-input `STALE_VIEW`/`AMBIGUOUS_VIEW`/`NO_VIEW` refusals of `click_at`/`select`/`drag` return a refused result with a fresh full view, and the same coordinates stay refused until re-measured on a newer view.
- Every tool names an unknown argument and lists the accepted ones; common "requires" errors carry a literal example; a repeated identical argument rejection says so.
- Uploads verify inputs the page empties after taking the file, name the exact on-disk file for a `+`/space near miss, and list real file inputs when a label is not one. `mode:"replace"` through a `<label>` replaces its own control.
- A covered label names what covers it (tag, role, text, and its label when it has one).

### Measurement and turn evidence (Track A)

- `scripts/model-eval.mjs` runs eleven scripted real-model scenarios on an isolated headless Edge profile, a second companion, and the authenticated remote API, with independent page/request-log checkers and a `--self-test` mutation gate for every checker. Batch baselines live under `e2e/baselines/`.
- Each turn records the model's leading `DONE`/`PARTIAL`/`BLOCKED` label (model-reported, never verification), failed-call count, and per-turn token usage; stopped turns keep elapsed time and partial usage. The panel and Android summaries show them.
- `scripts/analyze-failures.mjs` reproduces the failure statistics from real run logs, including reported-label distribution and stopped-turn stats.

### Panel-less execution, cursor, and motion

- A phone can drive the agent with no side panel open: the background service worker runs the same executor when no panel exists, with explicit one-executor handover when a panel opens or closes. System-clipboard work still needs a panel.
- One yellow agent cursor follows the active tab, breathes while idle, and fades out of every capture; people never see hitboxes, only the clean `displayImage`.
- The side panel and Android app share one motion scale: growing feed rows, gliding streamed text, a shimmering waiting row, countdown waits, and answer-pinned scrolling.

## Improvements and fixes

- Updated DSH to `0.2.2-rc.1` with compatible security overrides; `npm audit` reports 0 vulnerabilities.
- Node test discovery is version-independent; CI runs Node and Android checks on every push and pull request.
- Agent-driven Remote setup guide and revised README APK verification/pairing steps.
- Refined Android launcher cursor placement.
- Fixed the mid-drag tab-switch timeout (root cause: hidden tabs produce no compositor frames, so each coalesced move waited ~5 s for its ack; a 13-move drag outlived the 30 s command timeout).

## Requirements

- Git and npm
- Node 24.9+
- Chrome/Chromium/Edge 116+
- An OpenRouter API key; provider usage charges apply
- Android 8.0/API 26+ for the optional native app
- Tailscale on the host and phone for normal remote access

See the tagged `README.md`, `android/README.md`, `docs/REMOTE-ACCESS.md`, and `PRIVACY.md` for installation and security details. GitHub source archives contain the complete extension and companion; no extension-only ZIP is required.

## Verification

For this release candidate:

- **972/972 Node unit/integration tests**; `npm audit`: **0 vulnerabilities**
- Prompt composition: **18,076 total / 17,082 guidance characters** (ceiling 17,100)
- Real-extension suites on isolated headless Edge with independent page-state checks: `edge-drag-e2e.mjs` (all cases including the mid-drag tab switch, passed twice), `edge-click-e2e.mjs`, `edge-expect-e2e.mjs`, `edge-files-e2e.mjs` 13/13, `edge-work-e2e.mjs` 27/27, `edge-canvas-e2e.mjs`, `edge-find-e2e.mjs`, `edge-background-e2e.mjs` 12/12
- Scripted real-model baseline (`deepseek/deepseek-v4.1-flash`, medium): 11 scenarios × 5 = **54 pass / 1 partial / 0 fail**; the partial left the page untouched but still hinted at an occurrence after detecting duplicate-text ambiguity
- Extension-reload-mid-turn real-model acceptance: a genuine `chrome.runtime.reload()` mid-turn reconnected the background executor and the turn continued to a correct, independently verified result (PASS-CONTINUE)
- Signed Android release APK `0.5.0 (4)`, SHA-256 `05090c0846a7d3cae3b11abee74ba7f84cb52ad3bce9ab3e5c76ba83469fdac1`, `apksigner verify` accepted (same local sideload key as before)

Unit, integration, mock-bridge, and scripted-companion checks are not real-model acceptance.

## Known limitations and release boundaries

- Track B9 (opt-in confirmation for irreversible actions) is intentionally deferred to a later release; it is not part of v2.2.0.
- Real docked-panel `/plan`, drag, expectation, download→upload, and minimized/unfocused workflows remain unrun; authenticated Docs/Pivot acceptance remains pending (no connected Docs browser).
- Firebase is not configured; no real FCM delivery has been tested.
- The newest Android live view, help card, Continue, Steer, and notification UI still require physical-phone acceptance; the signed release APK has not been installed over the debug build (different signing key — uninstall first, then pair again).
- A real service reboot acceptance and repeated real-companion Stop/New/token-rotation scenarios remain unrun.
- Remote browser execution requires an awake host, running companion, and running Edge (the side panel need not be open).
- Never expose the privileged bridge or remote controller through Tailscale Funnel or an unauthenticated public listener.

---

# crazyAgent v2.1.0-beta

Changes since **v2.0.0-beta**. This prerelease adds native Android remote control, one-turn planning, structured help, and live screenshots while preserving the existing guarded browser executor.

The extension uses numeric update version `2.1.0` and displays `2.1.0-beta`. The Android app is version `0.4.0` with version code `3`.

## Highlights

### Native Android remote control

- Pair through tailnet-only Tailscale Serve with a separate remote credential encrypted by Android Keystore.
- Send prompts and up to four images, stream responses and tool activity, stop turns, and start new chats.
- Reconnect with ordered event replay or full resynchronization. Idempotent client IDs prevent automatic duplicate submissions.
- Use Markdown responses, context-usage display, searchable saved-chat history, and native dark/yellow styling.
- Continue saved conversations and steer running turns.
- Use `/new`, `/model`, and `/plan` composer commands on Android as well as the desktop panel.

### Scoped remote API and shared sessions

- Opt-in companion listener on `127.0.0.1:17873`, intended only for tailnet-only Tailscale Serve.
- One DSH session and one active turn shared by desktop and phone clients.
- Phone-started turns appear in the desktop panel; conflicting desktop prompts are requeued rather than lost.
- Separate token generation and rotation, Host validation, authentication throttling, bounded requests, and bounded canonical history.
- No remote access to privileged bridge roles, arbitrary browser commands, model administration, arbitrary logs, or arbitrary host files.

### Screenshots and structured help

- Mirror agent captures to the Android live view and request fresh screenshots while the agent is idle.
- Open captures in a full-screen viewer with zoom and pan.
- Use the new `agent_request_help` tool to report a structured blocker, capture the current page, enter `waiting_for_user`, and resume the same session after a reply.
- 34 standing model-facing tools, plus the conditional `browser_plan` tool during explicitly planned turns.

### One-turn planning

- Exact `/plan` arms one accepted turn on desktop or Android; ordinary long prompts do not opt in automatically.
- Revisioned checklists support pending, active, completed, and blocked states.
- Stale-plan reminders and bounded completion nudges keep work moving without treating model-reported completion as independent verification.
- A sticky, collapsible desktop checklist preserves its state through scrolling, tool-step collapse, and terminal warnings.
- Queued and requeued prompts retain their planning setting.

### Notifications and operations

- Optional metadata-only Firebase Cloud Messaging integration and Android notification handling.
- Persistent `systemd --user` companion service example with automatic restart and linger support.
- Remote API, pairing, security, and privacy documentation.

## Improvements and fixes

- Fixed DSH frozen `turn/end` handling for plan outcomes and Docs verification. The provider now collects a mutable outcome, retires plan state, and sends a validated `turn-outcome` activity to the companion and remote clients.
- Added frozen-event, wrong-turn/session, malformed-input, reset, and remote-metadata regressions.
- New configurations default to medium reasoning effort; saved choices remain unchanged.
- Updated the recommended model to `deepseek/deepseek-v4.1-flash`.
- Standardized crazyAgent branding.
- Removed the browser-access Pause/Resume control and clear legacy paused state on startup. Stop remains available.
- Added compatible security overrides for MCP client/core, fflate, undici, and zod while keeping DSH pinned to `0.2.1-rc.2`.
- Added Firefox port research and a fork plan; Firefox itself is not supported by this release.

## Requirements

- Git and npm
- Node 22.19+
- Chrome/Chromium/Edge 116+
- An OpenRouter API key; provider usage charges apply
- Android 8.0/API 26+ for the optional native app
- Tailscale on the host and phone for normal remote access

See the tagged `README.md`, `android/README.md`, `docs/REMOTE-ACCESS.md`, and `PRIVACY.md` for installation and security details. GitHub source archives contain the complete extension and companion; no extension-only ZIP is required.

## Verification

For this release candidate:

- Clean `npm ci` and `npm run setup`
- **922/922 Node unit/integration tests**
- `npm audit`: **0 vulnerabilities**
- Prompt composition: **18,025 total / 17,031 guidance characters**
- Frozen `turn/end` provider tests and active-turn companion validation regressions
- Android clean test/lint/debug/signed-release build: **79 JVM tests passed, 0 lint findings**
- The opt-in Kotlin client integration test passed against the real Node remote API
- Mock-bridge `plan`, `remote`, and `slash` UI scenarios passed with inspected screenshots
- Signed Android release APK `0.4.0 (3)`, SHA-256 `f08eadce79b61adeaadb5aad20f6d50a0cfb23875808ccdf59115fbcb082b3ed`

Unit, integration, mock-bridge, and scripted-companion checks are not real-model acceptance.

## Known limitations and prerelease boundaries

- Real-sidebar/model `/plan` and authenticated Docs outcome acceptance remains pending.
- Firebase is not configured; no real FCM delivery has been tested.
- The newest Android live view, help card, Continue, Steer, and notification UI still require physical-phone acceptance.
- The signed Android release APK has been built and signature-verified locally but has not been installed over the debug build.
- Persistent service operation has not been tested across a real reboot.
- Remote browser execution requires an awake host, running companion, and open connected Edge side panel.
- Never expose the privileged bridge or remote controller through Tailscale Funnel or an unauthenticated public listener.
