# Marathon v2: a watcher you can trust

**Status:** plan only. No product code has changed. Date 2026-11-17.
**Baseline:** v2.4.0 (`de5f69c`, tag `v2.4.0`), `npm test` 1237/1237. Acceptance model `deepseek/deepseek-v4.1-flash-1017` at medium effort; judge on the same model at low effort.
**Evidence base:** `docs/marathon/M0-baseline.md` through `M6-report.md`, `docs/marathon/m4-evidence/replay-canonical.json`, the archived run logs under `.dsh-home/browser-agent/logs/m0-archive/`, and direct reading of `companion/watch-ledger.mjs`, `watcher.mjs`, `watch-judge.mjs`, `session-controller.mjs`, `remote-hub.mjs`, `packages/dsh-browser-extension/lib/plan.js`, `plan-runtime.js`, `repeat-guards.js`, `extension/sidepanel/app.js`, and the Android state files. Section 1 says where each fact comes from. Nothing in this plan has been run.

The v1 plan (`MARATHON-PLAN.md`) and its reports stay the record of what shipped. This document only covers what changes next.

---

## 0. Summary

v1 works where it was measured: hard stalls alert without the model, zero false alerts were seen on healthy runs, the plan carries across turns, and the judge costs about a cent per 28 calls. But two things undercut it:

- **The watcher's notion of progress is wrong in several places.** A click that changes nothing counts as progress. So does a plan update. Alerts left open at turn end go stale on both clients and can't be dismissed. On continuation turns the judge can't see the plan or the task.
- **The evidence for its accuracy is thin.** The stuck set is 9 windows, 3 of them synthetic and 2 correlated slices. Labels were judgment calls, one of which was reversed mid-milestone. Each window was scored once even though the judge's answers vary between runs. And only 3 of the 53 healthy windows got a judge call at all.

v2 therefore fixes the inputs before tuning the judge, and builds a measurement that can tell the difference. Order:

1. **V0: measurement first.** Freeze a committed replay corpus. Label it from server-side progress records instead of judgment, score each window three times, and add long healthy runs and new honest-stall scenarios. Then re-score v1 on it. No product change.
2. **V1–V4: correct the watcher's inputs**, one at a time, each re-scored on the corpus:
   - V1: alert lifecycle.
   - V2: what counts as progress.
   - V3: page identity for repeated work.
   - V4: continuation context, which is the "top v2 follow-up" from M4.
3. **V5: tune the judge.** Only now, and only one change kept, chosen by measurement.
4. **V6–V8: reach and polish.**
   - V6: live checklist on the phone.
   - V7: a test notification so push delivery can be proven.
   - V8: less plan-tool friction when the agent is blocked.
5. **V9 (optional): marathon survives a companion restart.**
6. **V10: release v2.5.0.**

The watcher stays report-only. It still never steers, stops, captures, or changes an outcome.

---

## 1. Where v1 stands

### 1.1 What holds

| Fact | Source |
|---|---|
| Hard signals (SILENT_STALL, TOOL_HANG, EXECUTOR_DOWN) alert without the model, proven through `GET /state` on real-extension fixtures | M3 report |
| Zero false alerts on healthy runs: 0/53 replay windows; live marathon-long ×5, stall-loop quick ends, sign-in-wall ×5 | M4 report |
| Carry-over works: continuation redo 1/6 before the prompt tuning, 0/6 after; seeded-but-untouched 10/10 | M2 report |
| Judge cost is negligible: 28 calls, 134,467 input + 8,289 output tokens, about $0.01; about 4.8k input tokens per check | M4 report |
| Live stall-loop: 3 of 3 runs that looped past the thresholds alerted, first alert at 101–161 s | M4 report, live suite 2 |

### 1.2 Gaps

**G1 — The seeded plan never reaches the ledger.** `plan-runtime.claim()` seeds the carried plan but emits no `plan` activity. The ledger has no plan until the model's first `browser_plan` call. So PLAN_STALLED and the open-items part of REVISIT_HINT can't fire on a continuation that wanders. This was the main cause of the one genuine M4 miss (suite2-r10). Source: M4 report, "Adapter fidelity finding".

**G2 — On a continuation, the judge's "task" is just "continue".** The ledger records the turn's own shown prompt (`ledger.startTurn({prompt: shownText})`), and `buildDigest` sends it as `task`. A continuation turn's prompt is "continue", so the judge doesn't know what the work is. Source: `session-controller.mjs` `#begin`, `watch-judge.mjs` `buildDigest`.

**G3 — Recovery fires while the agent is still stuck.** Two causes:
- Recovery is "3 ok results including one mutation, or any plan revision" (`watcher.mjs` `#recoverySince`). A click that returns ok but says `NO VISIBLE CHANGE` counts as a mutation.
- `browser_plan`, `agent_request_help` and `agent_request_confirmation` are missing from `READ_ONLY_TOOLS`, so they count as page mutations too, for recovery and for every mutation counter.

In live stall-loop, 4 "recovered" notices went out while the button stayed inert. The checker confirmed the DOM never changed and no requests landed. Run r1 alerted, recovered, alerted, recovered. In those logs, 26 of the clicks returned ok with `NO VISIBLE CHANGE`. Sources: M4 live table, `run-…04-36-10-612Z-805c49`, `watch-ledger.mjs` lines 15–18 and 248–252.

**G4 — The repeated-work signal can't fire on multi-page work.** REVISIT_HINT groups calls across the whole turn by tool and arguments only, then requires the same result. In multi-page workflows the same arguments recur on every page with a different result. In the tuned suite-1 r3 log, `browser_click {label:6}` produced 15 different results across stations. Such a group never has "the same outcome", so the signal can't fire even on a genuine redo. Source: `watch-ledger.mjs` `#aggregates`, archive `run-…02-44-34-045Z-b5a71b`.

**G5 — Alerts outlive their turn, and some can't be dismissed.**
- At turn end the watcher clears its open alert without sending anything (`watcher.mjs` `turnEnded`).
- The hub keeps `marathon.watch.open` until the next watch notice (`remote-hub.mjs` `#onWatch`).
- The panel and the phone keep the amber "May be stuck" state the same way (`app.js` `watchAlert`, `ChatState.kt` actionable kinds).
- `ended-incomplete` is "open" and actionable on both clients, but "It's fine" on it returns `WATCH_NOT_FOUND`, because the watcher no longer holds it.

So after a BLOCKED end, the whole next turn can show "May be stuck" with no way to clear it. Source: M5 report "Design decisions", code above.

**G6 — The phone's checklist updates only at turn end.** The hub forwards plan items only inside `remote.marathon`, which is published when the carried plan is stored at turn end. During a running turn the phone shows the previous turn's list, or nothing. Source: M5 report, `remote-hub.mjs`.

**G7 — The plan tool contradicts itself when the agent is blocked.** Its description says a blocked item's content "should say why". But changing an open item's content is a rewrite, which requires `acknowledge_open_removal`. In M4 live, 11 of the failed calls across 15 runs were plan protocol errors:
- 9 × `PLAN_OPEN_REMOVAL_REQUIRES_ACK`, all from appending " — blocked: …" to items;
- 1 × `PLAN_IN_PROGRESS_REQUIRED`;
- 1 × `PLAN_WAIT_UNCHANGED_REQUIRED`.

In sign-in-wall, 5 of 19 tool results failed, all on the plan. M0 showed the same pattern: 16 `PLAN_*` failures, 12 of them in sign-in-wall. Sources: `plan.js` `BROWSER_PLAN_TOOL` and `replacePlan`, archives `run-…04-29-11-272Z-dfd724`, `-805c49`, `-4296b2`.

**G8 — The accuracy evidence is thin.**
- The stuck set: 9 windows, 7 distinct runs, 3 synthetic, 2 correlated late slices.
- Labels were assigned by judgment, and one was reversed mid-milestone (m0Stall-r4).
- Windows were scored once, although the judge's verdicts varied between runs (stuck score 6/9 to 7/9 across re-runs).
- Only 3 of 53 healthy windows got any judge call (5 calls in total), and only 1 healthy window ran past 4 minutes. "Zero false alerts" says little about the judge on long healthy turns.
- The archives are gitignored and exist only on this computer.

Sources: `replay-canonical.json`, `scripts/watcher-eval.mjs`.

**G9 — No push has ever been delivered, and there is no way to test delivery** short of a real stall. Source: `docs/STATUS.md` "Still unrun".

**G10 — A companion restart turns marathon off and drops the carried plan**, by design (fail-safe). A crash or reboot in the middle of a long task loses the checklist. Source: `AGENTS.md`, `marathon.mjs`.

**Not a watcher gap, recorded for completeness:** single-turn wander with a redo and a false "done" claim (4/25 runs) is an agent correctness failure. Only the server-side record catches it. Fingerprints can't separate it from normal work: the station submit is the same label on every page. V3 gives the watcher a page-scoped view of it, but preventing it on the agent's side is out of scope (section 9).

---

## 2. What you will notice

- **Alerts end when the turn ends.** An alert still open when the turn finishes is closed ("Turn ended"). An "ended incomplete" notice can be dismissed, and it clears when the next turn starts. The amber chip never carries into a new turn.
- **"Recovered" means the page actually moved.** No more alert / recovered / alert flapping while the agent clicks a dead button.
- **The phone shows the checklist live** while the turn runs, not just when it ends.
- **Phone Settings gets a "Send test notification" button**, so you can prove push works before you rely on it.
- **Fewer failed calls when the agent is stuck.** A blocked item can carry its reason without tripping a plan error.
- **Better catches on long and continued tasks**, measured, not assumed. Section 6 has the targets.
- **Optional (V9):** after a companion restart, continuing the same chat brings marathon and its checklist back.

Nothing changes when marathon is off.

---

## 3. Design

### 3.1 Measurement (V0)

**Corpus.** A new folder `e2e/watch-corpus/`:
- **`manifest.json`** lists every window: id, source run, scenario, label, label rule, onset time, and `split` (`tune` or `holdout`).
- **`traces/*.jsonl.gz`** holds the frames the replay adapter needs: tool calls and results, activities, turn start and end. They are cut from the archived run logs.

Traces are committed. They come only from isolated fixture runs, so they contain fixture pages and harness prompts, no user data. They pass the existing key scan. If the total size passes 10 MiB, traces stay machine-local and the manifest records their SHA-256 instead.

**Labels come from independent state.** A new script, `scripts/watch-label.mjs`, labels windows from the fixture server's own records, never from the model or the watcher. The patience values are fixed in the manifest before any scoring and are never tuned on results:

| Scenario class | Progress event | Stuck onset t0 |
|---|---|---|
| Progressable (marathon-long, marathon-epic, stop-then-continue) | a new station accepted by the server | 240 s since the last progress event (or turn start), with at least 3 tool calls in that span and the turn still running |
| Impossible by design (stall-loop, sign-in-wall, captcha-wall, spinner-forever, bounce-form) | none | 120 s of acting with no help request, confirmation request, or final answer |
| Redo (progressable scenarios) | — | the time of a duplicate server record; scored separately, no gate |

- A turn with no stuck onset is a **fine** window.
- A stuck window runs from t0 − 60 s to the earlier of turn end and t0 + 10 min.
- v1's hand labels are kept for comparison only, marked `legacy-manual`.
- Where an old archive lacks per-step timestamps, its window stays `legacy-manual` and is reported but not gated.
- `scripts/model-eval.mjs` starts recording per-step server timestamps in every batch JSON. This is a harness change only.

**Scoring.**
- `scripts/watcher-eval.mjs` reads the manifest instead of hard-coded windows and gets `--repeat k` (default 3).
- Every run reports:
  - per-window and mean results;
  - the worst case across the k repeats;
  - stability: the share of windows where all k repeats agree on flagged or not.
- `--dry-run` with the fake judge joins `npm test` as a plumbing check. It spends nothing.

**Metrics.** Defined once, used by every milestone:

| Metric | Definition |
|---|---|
| False alert | Any open mid-turn alert in a fine window. `ended-incomplete` is scored separately against the end-class rule. |
| Caught | A stuck window with an alert opened between t0 − 60 s and t0 + 4 min. An earlier alert is reported as "early", not false. |
| False recovery | A `recovered` notice while the label rule still says stuck. |
| Stale alert | An open alert on any surface (`/state`, panel, phone reducer) after its turn has ended without a closing notice. |
| Redo caught | Informational: a duplicate server record with any watch signal within 2 min. |
| Cost | Judge calls and input, output and reasoning tokens per window and per watched hour, kept apart from agent usage. |

**New scenarios.** All are honest; none is built to force a stall. Each gets a checker that passes `--self-test`.

- **`marathon-epic`:** the marathon-long fixture generator at 36 stations, so healthy turns last about 4–10 minutes and the judge actually runs on progressing work. This is the missing healthy-and-long set from G8.
- **`captcha-wall`:** a "verify you are human" check that never passes. The honest end is a help request with category `captcha`.
- **`spinner-forever`:** results that never finish loading. The honest end is BLOCKED or help after a bounded wait.
- **`bounce-form`:** a form whose submit always shows a generic "Something went wrong" message and records nothing on the server. The honest end is BLOCKED.

**Collection.** Each new scenario runs ×5 on the v2.4.0 pin. stall-loop and stop-then-continue run ×5 more. All runs use a pinned worktree and an isolated profile, port and DSH home, per the M0 provenance rule. The M4 live archives (`-dfd724`, `-805c49`, `-4296b2`) join the corpus too.

The corpus target is at least 80 fine windows, at least 15 of them longer than 4 minutes, and at least 15 stuck windows from at least 10 distinct runs, with synthetic windows reported apart.

If honest runs don't reach the stuck target, the shortfall is recorded and later milestones gate on what exists. Thresholds and scenarios are never bent to manufacture stalls.

**Holdout.** About a third of the windows, split by run so no run appears on both sides, are marked `holdout`. V2–V5 may look only at `tune` while changing code. The holdout is scored once per milestone, at the end, to check that nothing was fitted to the tuning windows.

### 3.2 Alert lifecycle (V1)

Every open notice gets an explicit close, sent as a frame:

- At turn end, an open mid-turn alert is closed with a `chat.watch` frame (`kind: 'info'`, `state: 'closed'`, reason "Turn ended."). The frame carries the alert's own id, the way `recovered` and `dismissed` already do, so each client collapses the row it already shows. If `ended-incomplete` fires, it supersedes the mid-turn alert: the alert is closed in the same step and `ended-incomplete` becomes the one open notice.
- The watcher remembers the last `ended-incomplete` id until the next turn starts. "It's fine" on it returns 200 and closes it. No snooze is needed, because there is no next tick to suppress.
- At the next turn start, `#begin` closes any open `ended-incomplete` (`state: 'closed'`, reason "A new turn started.") before the new turn's first frame.
- The hub, the panel and the Android reducer treat `closed` like `dismissed`. Old clients already treat any state other than `open` as not actionable (`watchIsActionable`, `ChatState.isActionable`), so an old APK collapses the card correctly.
- `/new`, a chat switch, and marathon off still clear everything, as today.

The panel keeps its Stop / Steer… / It's fine buttons. Only the lifecycle changes.

### 3.3 What counts as progress (V2)

**Three tool classes in the ledger**, replacing the single read-only list:

| Class | Tools | Counts as |
|---|---|---|
| observe | today's `READ_ONLY_TOOLS` | observation |
| control | `browser_plan`, `agent_request_help`, `agent_request_confirmation` | none of the counters below; plan calls still feed the plan snapshot through their activity |
| act | everything else | page actions |

- Control results are left out of FAIL_STREAK, SAME_ERROR, REPEAT_LOOP, OBSERVE_ONLY, the mutation counters, and recovery. A `PLAN_*` error is plan friction, not a stuck browser (V8 reduces it).
- **Effect of an action.** An ok act result whose text matches the provider's own no-progress marker (`NO VISIBLE CHANGE`, the same test `toolResultNoProgress` uses for reasoning escalation) is **no-effect**. The predicate is exported from the provider package and imported by the ledger, so both sides agree by construction.
- **New soft signal `NO_EFFECT`:** at least 4 of the last 8 act results were no-effect. Like every soft signal, it never alerts on its own. It brings the judge call forward and counts as deterministic corroboration under the two-strike rule.
- **Recovery needs evidence of progress.** The open alert clears only when:
  - at least 2 effectful act results arrived since the alert (ok, not no-effect, not control), **and** the alert's own signals have been absent for 2 consecutive ticks;
  - **or** the plan's completed count went up since the alert.
  
  A plan revision on its own no longer counts. Neither does marking items blocked: that is the agent saying it is stuck, and the turn end will announce it.

### 3.4 Page identity for repeated work (V3)

- The ledger tracks a best-effort **page key**: the URL from the most recent result that names one (the `tab <id> "<title>" <url>` line), a `browser_navigate` target, or a tab-switch result. Unknown stays unknown.
- Repeated-work stats group act results by **(page key, tool, arguments, the acted control's name)**. The name is parsed from `clicked label N: <role> "<name>"` and similar result heads.
- An effectful act repeated on the same page against the same control, with the same outcome, counts as a revisit. Two or more feed REVISIT_HINT, still soft.
- When the page key is unknown, the call is left out of revisit counting, so the signal fails toward silence, not toward false alerts.
- Navigation revisits stay digest information only, as in v1.
- The digest's `mutationRevisits` entries gain the page key (the URL path only, at most 60 characters).

### 3.5 Continuation context (V4)

**The seed becomes visible.** When `plan-runtime.claim()` accepts a seed, it emits one `bridge.activity({kind: 'plan', revision, items, awaitingUser: false, seeded: true})` immediately.

I chose the provider over having the companion feed its own snapshot, because the activity then reflects what the provider actually armed. A rejected seed (`plan.seed.rejected`) produces no activity, so the ledger and the model see the same empty plan.

Downstream:
- `noteActivity` already routes plan activities to the ledger and to `planTurnSnapshot`. A seeded-but-untouched turn stores back the same list, so nothing changes in carry-over.
- The panel already renders the carried plan at turn start; a plan update with the same revision is a no-op there.

**The judge learns the task.**
- Marathon state keeps a short internal **carry chain**: the prompts of up to the last 3 turns in the current carried-plan chain, each clipped to 500 characters, oldest first. It is reset whenever the carried plan is dropped, marathon is turned off, or the chat changes. It is not published to clients.
- `buildDigest` adds `carriedFrom: [{prompt}, …]` when the turn was seeded, and `plan.seededRevision`.
- Digest size grows by at most about 400 tokens.

Why this comes after V2 and V3: a visible seed makes PLAN_STALLED and REVISIT_HINT fire on continuation turns. With v1's progress accounting they would also fire on healthy continuations, where plan calls count as page actions and repeated same-label submits look like revisits. Fixing the inputs first keeps this change measurable.

### 3.6 Judge tuning (V5)

The candidates below are tried one at a time, each scored k=3 on the `tune` split against the V4 result. Only the first one that meets the rule is kept, then V5 stops:

1. **Plan progress history in the digest:** completed-count samples with ages, alongside the existing open-count trajectory.
2. **Medium reasoning effort for the judge**, with `max_tokens` raised to 1,200, since reasoning tokens count against it.
3. **Pinned provider routing for stability:** OpenRouter `provider: {order: [...], allow_fallbacks: false}`, plus `seed` if the model supports it. Check both against the current OpenRouter docs and the model's `supported_parameters` before relying on them.
4. **Last resort, only if 1–3 all fail:** the most recent screenshot that was already captured, taken from the hub's mirror. The watcher still never captures. This keeps the "no new recipient" property, because the provider already receives these images.

**Keep rule:**
- worst-case false alerts across k stay at 0 on fine windows;
- mean caught rate rises;
- stability doesn't fall;
- cost per watched hour stays at most 3× V4's.

If no candidate qualifies, nothing ships and the result is recorded. The prompt stays neutral; the M4 lesson was that cautious wording suppressed desired alerts.

### 3.7 Live checklist on the phone (V6)

- The hub ingests `chat.activity` of kind `plan` for the active turn. Each one is validated by the same rules as `normalizeMarathonPlan`. Malformed frames are dropped.
- It publishes a journaled `remote.plan` envelope `{turnId, revision, items, awaitingUser}` and projects `/state.turn.plan`.
- At turn end, `remote.marathon` takes over as today: the carried list, or none.
- The panel is unchanged; it already updates live.
- Android:
  - the reducer handles `remote.plan`;
  - the collapsible checklist card renders the live list during a turn, labelled "Revision N · X open of Y";
  - an unknown envelope type is already ignored, so an old APK simply keeps today's behavior.
- A new fixture, `marathon-live-plan.json`, is recorded from the real `RemoteHub`. It sits under the existing staleness gate.

### 3.8 Test notification (V7)

- **`POST /push/test {clientCommandId}`** on the remote API. It is authenticated like every route, idempotent per command id, and rate-limited to 1 per minute. It sends a `test` push to the registered devices.
- The payload stays exactly `{type, turnId, instanceId, sequence}`; `turnId` is a fresh `test-…` id.
- The route reports `{sent, failed, pruned, skipped}` back, so a missing FCM key or zero registered devices is explicit.
- `PushMessage.Type.TEST`: title "crazyAgent test notification", text "Push notifications reach this phone." It uses the normal-priority channel.
- Phone Settings gets a "Send test notification" button next to the push status, showing the route's answer.
- Old APKs drop the unknown type by design.

This does not make delivery happen. It gives you a one-tap way to prove it once `conan-evo-x3` has the service-account key and its companion has restarted (STATUS "Push delivery").

### 3.9 Less plan friction when blocked (V8)

- **Schema:** items gain an optional `reason` (single line, at most 240 characters). It is allowed only on `blocked` items; on any other status it is refused with `PLAN_REASON_STATUS`.
- **Description:** "For blocked items, put why in `reason` and keep `content` unchanged."
- **Identity rule:** an open item moving to `blocked` may also change its content without acknowledgement, if the new content starts with the old content. That covers the observed " — blocked: …" suffix. Anything else is still a rewrite.
- **`PLAN_IN_PROGRESS_REQUIRED` stays.** Its message gains one sentence: "If the remaining items cannot proceed because of a blocked item, mark them blocked too, or ask the user with `user_input_needed: true`."
- **Every validator in the carry chain must accept and keep `reason`:**
  - `plan.js` `normalizeItems` and `seedPlanState`;
  - `prompt.mjs` `normalizePlanSeed` and `formatCarriedPlan`;
  - `marathon.mjs` `normalizeMarathonPlan`;
  - the hub, `plan-panel.js`, and the Android reducer.
  
  Today `normalizeItems` refuses unknown item keys, so a carried seed with a `reason` would be rejected, and the turn would silently start with an empty plan. An end-to-end test carries a blocked item with a reason through two turns.
- The panel and the phone show the reason under a blocked item.

This changes the model-facing tool, so it needs a real-model gate (section 5).

### 3.10 Marathon survives a restart (V9, optional)

- Persist `{enabled, sessionId, since, origin, plan, chain}` to `.dsh-home/browser-agent/marathon-state.json` (mode `0600`, atomic write) on every change.
- Clear the file on off, `/new`, and a real chat switch.
- On startup, load it but keep marathon **off**. It is applied only when the same DSH `sessionId` is resumed (`resumeChat` or the post-restart resume path). Any other session discards it.
- It never starts a turn.
- The updater is unaffected: it already refuses to run while marathon is on.

This replaces the "resets to off on companion restart" invariant with "restores only for the same session". Section 10 offers it as a decision to veto.

---

## 4. Invariants

**Kept:**
- one runner and one turn slot;
- the marathon switch is companion-owned and never optimistically flipped;
- mutations in model order;
- fail-closed refusals;
- evidence separate from outcome;
- DSH events never annotated;
- 34 standing tools;
- the prompt ceiling;
- remote API limits;
- the watcher never steers, stops, captures, retries, or changes an outcome;
- hard stalls never depend on the model;
- watcher input is untrusted;
- watcher cost is reported apart from the agent's.

**Changed:**
- *Alerts:* "One open alert; recovery = 3 ok results incl. one mutation, or a plan revision" becomes "One open notice. Every notice is closed by an explicit frame. Recovery needs effectful actions or a higher completed count."
- *Restart (V9 only):* "Marathon resets to off on companion restart" becomes "it restores only when the same session resumes".

**New:**
- **Labels come from independent state.** Watcher accuracy is gated on windows labelled from server-side records by a fixed rule, scored k=3, with a holdout split. Judgment labels are diagnostics only.
- **A plan update is not progress.** Only an effectful page action or a higher completed count clears an alert.
- **Control tools are not page actions.** `browser_plan`, `agent_request_help` and `agent_request_confirmation` never count as observations or mutations.
- **Repeated work is page-scoped.** Without a known page, nothing counts as a repeat.

---

## 5. Milestones

The common rules for every milestone are in section 6. Each one lists the cheapest gate first.

### V0 — Measurement (no product change)

- **Work:** the corpus folder, `watch-label.mjs`, the manifest-driven `watcher-eval.mjs` with `--repeat`, `--dry-run` in `npm test`, per-step timestamps in `model-eval.mjs`, the four new scenarios with self-tests, and the collection batches.
- **Then:** score v1 (v2.4.0) on the corpus, k=3, both splits. This is the baseline every later milestone compares to.
- **Done when:**
  - the corpus meets its targets, or the shortfall is recorded;
  - every checker passes `--self-test`;
  - the baseline is in `docs/marathon/v2/V0-baseline.md`, with mean, worst case, stability, false recoveries, stale alerts, and cost.

### V1 — Alert lifecycle

- **Gates:**
  - `npm test`: watcher, controller, hub, remote-server ack, panel `watch-row`;
  - a new fixture, `marathon-watch-lifecycle.json`, plus the Android reducer and JVM tests;
  - `ui-preview --scenario watch` with screenshots inspected;
  - a fake-companion run that checks `/state` after each turn boundary.
- **Live:** the V2 stall-loop batch doubles as live lifecycle evidence.
- **Done when:** stale alerts are 0 on every surface in the fixture and replay, and "It's fine" on `ended-incomplete` returns 200.

### V2 — What counts as progress

- **Gates:**
  - `npm test`: tool classes, the no-effect predicate shared with the provider, NO_EFFECT edges, recovery edges;
  - replay k=3 on `tune`, then once on `holdout`.
- **Live:** stall-loop ×5 and marathon-epic ×5, judge wired.
- **Done when:**
  - false recoveries are 0 on both replay and live;
  - false alerts are 0 at worst case;
  - the caught rate is not below V0's;
  - suspect ticks on healthy runs are no higher than V0's, since fewer spurious triggers is the expected effect.

### V3 — Page identity

- **Gates:** `npm test` (page-key parsing, unknown page excluded, grouping), then replay k=3.
- **Live:** marathon-long ×5 and marathon-epic ×5.
- **Done when:**
  - REVISIT_HINT fires on no healthy run;
  - it fires on every labelled redo in the corpus (informational);
  - false alerts are 0 at worst case;
  - the caught rate is not below V2's.

### V4 — Continuation context

- **Gates:**
  - `npm test`: seeded activity emitted only for an accepted seed; rejected seed means no activity; seeded-untouched unchanged; carry chain bounds and resets; digest size;
  - replay k=3.
- **Live:**
  - stop-then-continue ×5 (zero redos, zero alerts on healthy continuations);
  - unrelated-question ×5 (still `not-assessed`, still answered in one step);
  - the c1 `steer-plan` row.
- **Done when:**
  - the continuation stuck windows (suite2-r10 and any new ones) are caught;
  - healthy continuations stay silent at worst case;
  - seeded-untouched stays 5/5.

### V5 — Judge tuning

- **Gates:** replay k=3 per candidate on `tune`; the kept one once on `holdout`.
- **Live:** with the kept configuration, stall-loop, captcha-wall, bounce-form and marathon-epic ×5 each.
- **Done when:**
  - the caught rate reaches **at least 80%** of stuck windows (mean, k=3, `tune` and `holdout` each);
  - false alerts are 0 at worst case;
  - stability is at least V4's;
  - cost is within the limit.
  
  If no candidate gets there, the best configuration that keeps zero false alerts ships, and the gap is recorded in `docs/STATUS.md`, as M4 did.

### V6 — Live checklist on the phone

Can run alongside V2–V5: it touches the hub, Android and fixtures; they touch the ledger, watcher and judge.

- **Gates:** `npm test` (hub ingest, validation, journal/replay, projection, fixture staleness), `./gradlew testDebugUnitTest lintDebug`, and the JVM live fake-companion test (the checklist updates mid-turn).
- **Still needs you:** how it looks on the phone.

### V7 — Test notification

Can run alongside V2–V5.

- **Gates:** `npm test` (route auth, idempotency, rate limit, payload shape, the not-configured and no-devices answers), Android `PushMessageTest` and the Settings button test, and a fake-companion run.
- **Still needs you:** a delivered test push through `conan-evo-x3`, which is STATUS's push acceptance.

### V8 — Plan friction

Starts after V4, since both touch `plan-runtime.js`.

- **Gates:**
  - `npm test`: `reason` validation, prefix identity rule, the new message, `reason` carried end to end, prompt composition;
  - `c1-acceptance --self-test`.
- **Live:** sign-in-wall ×5, stall-loop ×5 and marathon-long ×5, compared with M4 live: 11 `PLAN_*` failures and the same pass rates.
- **Done when:** `PLAN_*` failures are at most 2 in total, with no change in independent pass rates or help/BLOCKED ends.

### V9 — Restart (optional)

- **Gates:** `npm test` (persist, restore for the same session only, discard for others, file mode, off/new/switch clear) and a scripted restart in the isolated harness: stop the companion mid-chat, restart it, resume the same session, then check `/state`.
- **Done when:** the same session gets marathon and its plan back, any other session gets neither, and no turn starts by itself.

### V10 — Documents and release

- **Docs:** `AGENTS.md` (the changed and new invariants), `docs/STATUS.md` (behavior, numbers, still-unrun), `HANDOFF*`, `docs/REMOTE-ACCESS.md` (`remote.plan`, `closed` state, `/push/test`, `test` type), `e2e/checklist.md` §6, `README.md`, `RELEASE-NOTES.md`.
- **Versions:** 2.5.0; Android 0.8.0 (7).
- **Activation stays yours:** reload the extension first, then restart the companion.

---

## 6. Rules for every milestone

- **One main change**, re-scored on the same corpus with the same model and effort. Agent: `deepseek/deepseek-v4.1-flash-1017` at medium. Judge: low effort, unless V5 changes it.
- **Real-model batches run from a worktree pinned at the commit under test**, with an isolated profile, ports and DSH home. Every batch JSON records `commitUnderTest`. Never the live companion (17871/17873) or your browser profile.
- **Independent checks decide.** The fixture server's records and the DOM through the harness's own CDP decide pass/fail. `GET /state` decides watch state. The transcript, the model's label, and the watcher's own verdicts are diagnostics.
- **Holdout discipline:** no code change after looking at `holdout` results within the same milestone.
- **The shared working tree:** other sessions edit this checkout, so each milestone works in its own worktree and branch and commits explicit paths only. No stash, no whole-tree checkout or reset.
- **Docs in the same change:** each milestone updates `AGENTS.md`/`docs/STATUS.md` where behavior changes, and writes its report to `docs/marathon/v2/`.

---

## 7. Files

**New:**
- `e2e/watch-corpus/manifest.json` and `traces/`
- `scripts/watch-label.mjs`
- `e2e/scenarios/{marathon-epic,captcha-wall,spinner-forever,bounce-form}.mjs` and fixtures
- `android/.../remote-protocol/{marathon-watch-lifecycle,marathon-live-plan}.json`
- `docs/marathon/v2/`

**Changed, companion:** `watch-ledger.mjs`, `watcher.mjs`, `watch-judge.mjs`, `session-controller.mjs`, `marathon.mjs`, `prompt.mjs`, `remote-hub.mjs`, `remote-server.mjs`, `remote-push.mjs`, `index.mjs` (V9 load).

**Changed, provider:** `lib/plan.js`, `lib/plan-runtime.js`, `lib/index.js` (export the no-progress predicate).

**Changed, panel:** `app.js`, `watch-row.js`, `plan-panel.js`.

**Changed, Android:** `ChatState.kt`, `ChatReducer.kt`, `DisplayRows.kt`, `RemoteApi.kt`, `RemoteController.kt`, `PushMessage.kt`, `Notifier.kt`, the Settings screen, `ChatScreen.kt`, and their tests.

**Changed, scripts:** `watcher-eval.mjs`, `model-eval.mjs`, `remote-protocol-fixtures.mjs`, `fake-remote-companion.mjs`, `ui-preview.mjs`, `c1-acceptance.mjs` (V9 restart row).

---

## 8. Risks

| Risk | Handling |
|---|---|
| Honest runs produce too few stuck windows. | Record the shortfall and gate on what exists. Never sabotage scenarios. The holdout keeps small-sample fitting visible. |
| The label rule disagrees with intuition, as with the "faithful wander" cases. | Patience values are fixed before scoring and are generous for progressable work (240 s). Disagreements are reported, not relabelled. |
| The judge varies between runs. | k=3 with worst-case gating; V5 candidate 3 targets it directly. |
| Page-key parsing misses pages (compact views carry no URL). | An unknown page is left out of revisit counting, so it fails toward silence. Replay reports how often the page was unknown. |
| A visible seed creates suspects on healthy continuations. | Sequenced after V2/V3, and V4's live gate requires zero alerts on healthy continuations. |
| `reason` breaks the carry chain at one validator. | The end-to-end carry test, plus fail-closed behavior everywhere: a rejected seed logs `plan.seed.rejected`, never a partial plan. |
| More judge cost from long healthy runs and k=3 replays. | V0 measures it. v1 averaged about $0.0004 per call. |
| An old APK meets new frames. | Every addition is additive: an unknown envelope or push type is ignored, and an unknown state is not actionable. Checked with the fake companion in V1, V6 and V7. |
| Restart restore surprises you. | Opt-in by veto; it restores only for the same session and never starts a turn. |

---

## 9. Out of scope

- **The watcher acting:** nudging, steering or stopping the agent. Revisit only if V5's live data shows alerts arrive and are reliable, and only as a separate plan.
- **Agent-side redo prevention.** Fingerprints can't separate a redo from normal multi-page work, and the fix would touch general browser tools. It belongs to the single-turn reliability track in STATUS's follow-up candidates.
- **Watching non-marathon turns.** The ledger already records them; alerting on them would need its own switch.
- **A separate watcher model or any watcher setting on the phone.**
- **A dedicated "repeated work" alert kind.** Repeated work stays a soft signal that informs the judge.
- **A reminder push while the chat waits for you.**

---

## 10. Decisions you can veto

| # | Decision | Alternative |
|---|---|---|
| 1 | Measurement (V0) before any product change | Start with the seed fix (V4) and measure on v1's 62 windows |
| 2 | Labels from server-side progress records with fixed patience (240 s / 120 s) | Keep hand labels |
| 3 | Recovery needs effectful actions or a higher completed count | Keep v1's rule and just exclude no-effect clicks |
| 4 | The provider emits the seeded plan activity | The companion feeds its own snapshot into the ledger |
| 5 | Judge gets up to 3 prior prompts of the carry chain, internal only | Only the first prompt of the chain |
| 6 | V5 keeps at most one judge change, chosen by measurement; screenshots only as a last resort | Allow combining changes, or never use screenshots |
| 7 | Live checklist as a separate `remote.plan` envelope | Republish `remote.marathon` on every plan revision |
| 8 | `POST /push/test` and a phone button | No test route; prove push only with a real alert |
| 9 | Optional `reason` field for blocked items plus the prefix rule | Only fix the tool description |
| 10 | V9 restores marathon after a restart for the same session | Keep the fail-safe reset to off |
| 11 | Watcher stays report-only | Allow one watcher nudge per turn (not planned here) |
