# M6 draft — documents and release prep (DRAFT, not the final pass)

**Status:** standby prep by core, 2026-11-16. Read-only analysis + this one draft file. **No version bumps and no final doc edits until lead gives M6 go.** Every number that awaits a pending gate is marked **PENDING**. M2 is fully accepted (steer-plan PASS on pin `2abb065`, prompt/plan diff-empty proof carrying suites 1–3). M3 real-model (task-11), M4 (task-5), and M5 (task-6) acceptance are still running.

Plan reference: `MARATHON-PLAN.md` §4 (invariants), §5 M6 (docs + version 2.4.0 + release flow).

## 0. Commit chain and per-commit test counts (quote these exactly in M6)

| pin | commit | `npm test` | note |
|---|---|---|---|
| pre-M1 | `c296601` | **1055/1055** | RELEASE-NOTES "Unreleased" records 1055 |
| M1 | `d878cc8` | **1085/1085** | rename + shared switch |
| M2 | `1a248fa` | **1105/1105** | carry-over + refill limits |
| M2 tuning | `a31f7f9` | **1105/1105** | continuation-fidelity guidance. **CORRECTION:** the a31f7f9 commit message and the M2-report tuning section originally quoted "1152/1152" — that was a working-tree measurement with M3 uncommitted. The tuning pin itself contains **1105** tests. M6 must fix the M2-report tuning section count and quote 1105 here. |
| M3 | `d266ada` | **1152/1152** | watch ledger + deterministic alerts (+47) |
| M4 watcher head | `cbe50ee` | **PENDING** (judge M4 unit tests; verify count) | judge + cadence/budget/two-strike, judge===null keeps M3 identical |
| fix chain C1 | `3f02e2e` | (combined tree 1201) | live activity ledger feed + authoritative push wiring |
| fix chain C2 | `1e3c2dc` | (combined tree 1201) | null-safe judge pass-through + watch-row stuck/blocked |
| fix chain C3 | `9b856df` | (combined tree 1201) | c1 steer-plan real aborted-shape evidence fix |
| **M3 acceptance pin** | `2abb065` | **1201/1201** (independently verified at clean checkout + c1 --self-test PASS) | android push (watch type + dedupe) on top of C3; deterministic-only (no index.mjs judge wiring yet) |
| M4 live wiring | `6a20c39` | **1201/1201** (judge-reported; re-verify at clean checkout at M6 go) | judge live wiring (injected getters) + log hardening (dropped raw error.message → errorName only, per core review) |
| M5 full / release head | **PENDING** | **PENDING** | android M5 full + final release head; re-run npm test + gradle at M6 go |

**M6 rule:** quote the count that belongs to each pin; never quote a working-tree count as a pin count. The final release-head count is **PENDING** until M4/M5 land and is re-verified at a clean checkout.

## 1. AGENTS.md — reconcile incremental edits into a clean final pass (§4)

Already landed incrementally (M1/M2/M3): the Tools bullet marathon phrase, the "One runner, one turn slot" marathon-switch sentences, and the "The watcher only reports (M3 landed; M4 judge pending)" bullet. M6 reconciles these against plan §4:

**§4 "Reworded" — Tools (LANDED, verify wording):**
- Current: "`/marathon` (unlisted legacy alias `/plan`) adds `browser_plan` for every turn that starts while the companion-owned marathon switch is on … A legacy one-shot `planMode:true` message still works …". Matches §4 intent ("every turn that starts while marathon mode is on", was one armed turn). **Keep.** Update the milestone-status sentence to "M1–M5 landed; M6 release docs in progress" once M4/M5 acceptance is green (**PENDING**).

**§4 "New" invariants — gap analysis vs current AGENTS.md:**
1. *Marathon state is the companion's* — **LANDED** in the One-runner bullet (one switch via `SessionController.setMarathon`, off after `/new`/chat switch/restart, clients render never assume). Keep.
2. *The watcher is read-only* — **LANDED** (M3 bullet: never steers/stops/sends bridge command/captures/changes ok/label/plan/docsVerification/retry). **M6 update:** the bullet currently ends "The model-based judge (M4) is not wired yet." → replace with the M4-landed wording: the judge is ONE stateless tool-less chat-completions call via injected getters (no bridge, no runner, no tools); it cannot act. Keep the read-only list.
3. *A watcher verdict is a diagnostic, not verification* — **MISSING.** Add: "'Progressing' does not mean the work is correct; 'stuck' does not mean it failed. Acceptance still uses independent checkers." (mirrors the existing evidence-separate-from-outcome invariant).
4. *Hard stalls do not depend on the model* — **PARTIAL** (M3 bullet says hard signals alert "without the model"). **M6 strengthen:** silence/hung-tool/lost-executor alert deterministically **including when the judge is unavailable or over budget** (budget exhausted → deterministic-only + one notice).
5. *Watcher input is untrusted* — **MISSING.** Add: digest content can never widen what the watcher does (it can do nothing); output is schema-validated (`validateVerdict` → `unknown` on any deviation) and the reason is rendered as plain text.
6. *Watcher cost is reported separately* — **MISSING.** Add: the per-turn `watch {checks, alerts, usage}` summary reports watcher/judge tokens separately from agent usage; judge calls/tokens are recorded apart.

**§4 "Kept unchanged" — confirm still intact in AGENTS.md:** one runner/one turn slot; mutations in model order; fail-closed refusals; dead-step `agent.steer` same-turn retries; evidence separate from outcome; DSH events never annotated; confirmation flow; remote API limits; no hitboxes; prompt ceiling (17,100). All present — no change needed beyond the watcher additions above.

## 2. docs/STATUS.md — update plan

**Behavior bullets to add/update (the marathon bullet already covers M1–M3; extend for M4/M5):**
- M4 judge: one stateless tool-less call per check, configured model at low reasoning effort when supported, max_tokens 400 / temp 0 / JSON mode, 45 s timeout aborted at turn end, one in flight, stale-turn results discarded, strict fail-closed verdict; cadence (first 4 min, then 6 min ±15% jitter, 10 min after 2×progressing, back to 4 otherwise; suspect triggers a call if ≥90 s since last); budget 40 calls / 150k input tokens per turn then deterministic-only + one notice; 429/timeout skip + double interval once; two-strike alert rule. Verdicts `progressing/slow/stuck/blocked/unknown`; judge alerts use kind `stuck`/`blocked` (source `watcher`/`both`). **M4 live acceptance numbers PENDING.**
- M5 phone: `/marathon` slash (legacy `/plan` alias), marathon chip (visible+tappable while busy), watch card (Stop/Steer/It's fine), collapsible plan checklist, WATCH push type. **On-device + push delivery still unrun (see below).**
- Watcher cost reported separately (`watch.usage` = judge tokens; `checks` = deterministic ticks).

**Where each milestone's verified numbers go (per-commit, from §0):**
- M1: 1085/1085 (`d878cc8`); real-model marathon-long ×5 GREEN vs M0 (task-8, `1e68172`).
- M2+tuning: 1105/1105 (`1a248fa`/`a31f7f9`); real-model suites 1–3 + steer-plan accepted on `2abb065` (suite-1 4/5+1 partial accepted as pre-existing single-turn wander variance; suite-2 continuation 5/5 after tuning; suite-3 unrelated 5/5; steer-plan PASS). **Fix the M2-report tuning section's 1152→1105.**
- M3: 1152/1152 (`d266ada`); real-extension TOOL_HANG/EXECUTOR_DOWN fixtures via GET /state; **marathon-long ×5 zero-alert real-model PENDING (task-11, pin `2abb065`).**
- M4: unit/replay counts **PENDING** (`cbe50ee`/`6a20c39`); offline replay gate (≥20 labelled windows, zero false alerts on fine windows, ≥80% stuck flagged within two checks) **PENDING**; live stall-loop/sign-in-wall/zero-alert **PENDING**.
- M5: npm test + gradle testDebugUnitTest/lintDebug + fake-companion marathon-stuck **PENDING** (android verifying); fixture staleness green at `2abb065`.
- Release head: final npm test + gradle counts **PENDING** (re-verify at clean checkout at M6 go).

**New "Still unrun" items to add:**
- **Push delivery via `conan-evo-x3`** (the designated push sender; needs the same service-account key + companion restart there; phone stays paired, do NOT re-pair). WATCH push delivery on a real device — **unrun**.
- **On-device phone checks**: marathon chip/watch card/checklist against the real companion; release-APK install; reboot test. **unrun** (M5 is code+fixture only).
- **M4 live phase** (stall-loop ×5 / sign-in-wall ×5 / marathon-long ×5 zero false alerts) if still pending at M6 go — **PENDING**.
- **Single-turn wander/redo follow-up flag** from eval's mode-rate analysis: suite-1's 4/5+1 partial is the pre-existing single-turn wander mode (byte-identical unseeded prompt surface), accepted as variance for M2 but worth a flagged follow-up investigation (not a marathon regression). Record as a known follow-up, not a blocker.
- Existing still-unrun (real-sidebar `/marathon` through the docked panel, drag/expectation/download→upload, Docs §3 model-driven, live docked-panel visual, phone feature matrix, Tailscale ACL grant) — carry forward, rename `/plan`→`/marathon` where relevant.

## 3. docs/REMOTE-ACCESS.md — inventory from LANDED code (verify against code at M6 go)

Already updated incrementally for M1–M3; M6 verifies completeness and adds M4/M5:
- **Routes:** `POST /remote/v1/marathon {enabled, clientCommandId}` (idempotent per clientCommandId; 200/409; not message-limited). `POST /remote/v1/marathon/watch/ack {id, clientCommandId}` → 200 `{acknowledged:true,id,instanceId}` dismisses + snoozes kind 15 min; 404 WATCH_NOT_FOUND when no open alert; 422 INVALID_WATCH_ID/INVALID_CLIENT_ID; 409 IDEMPOTENCY_CONFLICT. Remote API limits unchanged; still cannot claim ui/tools, send browser commands, configure LLM, or read files.
- **Envelopes:** `remote.marathon {enabled, sessionId, since, origin, plan, watcher{active,checks,lastCheckAt,lastVerdict}}` (journaled/replayed, deduped, reset off by chat.session; plan = carried snapshot or null). `remote.watch {id, turnId, kind, state, blocker, reason, signals, source, at}` (kind SILENT_STALL/TOOL_HANG/EXECUTOR_DOWN/ended-incomplete/stuck/blocked/recovered/info; state open/recovered/dismissed; source heuristic/watcher/both). `chat.done`/`chat.stopped` carry additive `watch {checks, alerts, usage}`.
- **/state marathon projection:** `marathon {enabled, since, plan, watch{open, lastVerdict, lastCheckAt, checks}}`; `watch.open` = null or `{id, kind, at, reason}`; `lastVerdict`/`lastCheckAt` judge-driven (null until first judge call); `checks` = deterministic ticks.
- **WATCH push (M5):** `PushMessage.Type.WATCH` added to `PUSH_TYPES` (`['help','confirm','done','error','watch']`); payload exactly `{type, turnId, instanceId, sequence}` (all strings); high priority; generic wording "crazyAgent may be stuck" / "Open to see what it is doing.", agent_help channel. **Dedupe key `turnId:type:ordinal`** (per-type slot so a mid-turn watch push doesn't swallow the turn-end push; ordinal separates up-to-3 watch alerts; retried identical push deduped). `pushTypeForTurn` returns `watch` for an ended-incomplete marathon turn (authoritative `endedIncomplete` flag first, shared `decideEndedIncomplete` fallback); help/confirm waits win. Old APK drops the unknown type by design.

## 4. HANDOFF.md / HANDOFF-QUICK.md / README.md / RELEASE-NOTES.md / e2e/checklist.md — change lists

**HANDOFF-QUICK.md:**
- "Current build" table: Release row → v2.4.0 (**PENDING** tag/release); Tools row → "`/marathon` sticky companion-owned switch adds `browser_plan` every turn while on (legacy `/plan` alias + one-shot `planMode:true` still work); watcher (deterministic + judge) reports only"; add a Watcher row.
- "Pending acceptance" row → marathon M1–M3 accepted numbers; M4/M5 **PENDING**; push delivery via conan-evo-x3 + on-device still unrun.
- "What changed most recently" → marathon mode (M1–M5) summary + fix chain.
- "Key files" → add `companion/marathon.mjs`, `watch-ledger.mjs`, `watcher.mjs`, `watch-judge.mjs`, `extension/sidepanel/watch-row.js`, `scripts/watch-fixtures-e2e.mjs`, `scripts/watcher-eval.mjs`.
- "Next work" → replace v2.3.0 activation notes with v2.4.0 activation (reload extension → restart companion order); real-sidebar `/marathon`; M4/M5 acceptance follow-ups.
- "Do not" → keep; add "watcher never steers/stops/mutates; verdict is diagnostic not verification".

**HANDOFF.md:**
- §1 Current state → marathon mode landed (M1–M5), version 2.4.0 (**PENDING** release).
- §3 Invariants → mirror the AGENTS.md §4 additions (marathon state companion-owned; watcher read-only; verdict diagnostic; hard stalls model-independent; untrusted input; cost separate).
- §4 Capability summary → note conditional `browser_plan` via sticky `/marathon`; watcher alerts.
- §6 File map → add the new companion/extension/scripts files.
- §8 Next work → marathon acceptance follow-ups + single-turn wander flag.

**README.md:**
- "New in v2.3.0" → add "New in v2.4.0" section: marathon mode (sticky switch, plan carry-over, deterministic + model watcher, phone chip/watch card/checklist, WATCH push). Version references 2.3.0→2.4.0; Android 0.6.0(5)→**PENDING** (0.7.0(6) pattern, lead decision).
- "Operating behavior" / "Important behavior" → marathon switch + watcher read-only note.
- Install/Update instructions → version 2.4.0; reload-extension-then-restart-companion order.

**RELEASE-NOTES.md:**
- Convert "# Unreleased (post-v2.3.0)" into "# crazyAgent v2.4.0" (changes since v2.3.0): marathon mode M1–M5, the fix chain, per-commit test counts (§0), accepted real-model results (M1/M2; M3/M4/M5 **PENDING**), still-unrun (push delivery/on-device/M4 live). Extension numeric version 2.4.0; Android **PENDING**. Keep the dated model-pin/composer-polish entries under the release.
- Preserve the v2.3.0 and earlier sections verbatim.

**e2e/checklist.md:**
- Add a "## Marathon mode" section: turn on/off via `/marathon` (and legacy `/plan`), chip renders from companion state, mid-turn toggle semantics, plan carry-over after stop→continue (no redoing recorded steps), unrelated question after a stopped marathon (no nudges), watch alert row (Stop/Steer/It's fine) + recovery collapse + ended-incomplete, phone marathon chip/watch card/checklist + WATCH push (on-device, **unrun**), watcher never alters the turn outcome. Reference the isolated harnesses (`marathon-independent-check.mjs`, `watch-fixtures-e2e.mjs`, `watcher-eval.mjs`, c1 `steer-plan` row) and the real-model batches.
- Rename existing `/plan` references to `/marathon` (alias noted).

## 5. Version-bump file inventory + release flow (NO bumps until M6 go)

**Exact locations (current → target):**
- `package.json:3` `"version": "2.3.0"` → **2.4.0**.
- `extension/manifest.json:4` `"version": "2.3.0"` → **2.4.0** (numeric update version).
- `companion/index.mjs:50` `const VERSION = '2.3.0'` → **2.4.0** (flows to `RemoteHub.serverVersion` → `/state server.version` and `/health`).
- `android/app/build.gradle.kts:27` `versionCode = 5` → **6** and `:28` `versionName = "0.6.0"` → **0.7.0** (**PENDING lead decision** — the v2.3.0 release used 0.6.0(5); follow the same minor-bump pattern unless lead specifies otherwise).
- Docs that hard-code versions: README.md, RELEASE-NOTES.md, HANDOFF-QUICK.md "Current build", docs/STATUS.md — update to 2.4.0 / Android target.
- Check for any other `2.3.0` literal (grep at M6 go) — e.g. config/service files, android/README.md.

**Release flow (plan §5 M6 + v2.3.0 precedent):**
1. Land M4/M5 acceptance; final doc pass (this draft → real edits); version bumps above.
2. Full gates at the release head: `npm test` + `c1-acceptance --self-test` + `./gradlew testDebugUnitTest lintDebug` + ui-preview scenarios; verify at a clean checkout. **PENDING** counts.
3. **Reload the unpacked extension and reopen its panel FIRST, then restart the companion, in that order** (plan §5 M6). Rationale from v2.3.0: a new companion can send arguments an old extension rejects (e.g. `confirm_guard`); reloading the extension first avoids the mismatch. There is no version handshake.
4. Verify `/health` returns ok/ui/tools:true after the real executor reconnects; verify `/state server.version` = 2.4.0.
5. Build/sign the Android release APK (versionName/versionCode bumped); pin its SHA-256 in README; **on-device install + push delivery remain user-gated/unrun**.
6. Tag `v2.4.0`; `gh release` **condition:** only after the final gates are green and the extension/companion are verified active (follow the v2.3.0 published-release pattern). Do NOT tag/release while M4/M5 acceptance is pending.
7. Update HANDOFF-QUICK "Current build" Release row with the tag/release URL + APK SHA-256.

## Open items to resolve at M6 go
- Final release-head npm test + gradle counts (re-verify clean checkout) — **PENDING**.
- M3 zero-alert (task-11), M4 replay+live (task-5), M5 gradle/lint/fake-companion (task-6) acceptance results — **PENDING**.
- Android versionName/versionCode target (lead decision) — **PENDING**.
- M2-report tuning section count correction (1152→1105) — do in M6 final pass.
- Whether judge's `error.message` log hardening (optional note from review) landed in `6a20c39` — **RESOLVED:** judge dropped raw error.message (errorName only) for zero key-leak risk; reflect the key-never-logged guarantee in REMOTE-ACCESS/STATUS.
