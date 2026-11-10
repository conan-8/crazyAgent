# crazyAgent — temporary work plan

Written 2026-11-10. Temporary: delete this file once its items are done or moved into `HANDOFF-QUICK.md`.

This plan is for handing work to separate agents. Each work item (A1, B3, …) is self-contained: goal, evidence, files, steps, how to prove it, and what it must not touch. Give an agent one item ID plus the "Rules for every agent" section.

---

## 0. Summary

The executor is carefully guarded and well unit-tested, but the project cannot currently measure whether the agent succeeds at tasks. Every reliability claim comes from manual runs. Development has moved faster than acceptance, so a large amount of shipped code has never been exercised with a real model.

The order of work that follows from that:

1. **Track A — build measurement first.** A repeatable real-model scenario harness and a failure-report script. Everything else is judged with these.
2. **Track B — fix the failure classes the logs show.** Each is one milestone with a baseline and a rerun.
3. **Track C — pay down the acceptance backlog.** Much of it needs the user (phone, Google sign-in, Firebase).
4. **Track D — structural work.** Prompt size, giant files, docs, logs. Do after A, and not in parallel with B on the same files.

### What the evidence says

Source: all 73 run logs under `.dsh-home/browser-agent/logs/` (2026-10-21 → 2026-11-10), 468 turns, about 9,800 tool calls. "Oct" is every October run; "Nov" is every November run (29 runs, 106 turns).

| Measure | Oct | Nov |
|---|---|---|
| Tool calls | 7,540 | 2,244 |
| Failed tool calls | 961 (12.7%) | 145 (6.5%) |
| `browser_click_at` failure rate | 17% | 8% |
| `browser_click` failure rate | 9% | 9% |
| `browser_screenshot` failure rate | 15% | 4% |
| `browser_upload` failure rate | — | 39% (14 of 36) |
| `browser_drag` failure rate | — | 33% (4 of 12), plus 7 false/unhelpful `DRAG_NO_EFFECT` |
| Turns stopped by the user | 75 of 468 overall (16%) | 29 of 106 not ok (27%) |

Other facts:

- Median turn: 6 tool calls, about 25–29 s. 90th percentile: 62 calls, about 280 s. Longest: 296 calls, 19.5 minutes.
- Time split over the latest 25 completed turns (`scripts/analyze-latency.mjs --runs 12`): model 68%, browser tools 32%, everything else 1%. `browser_click_at` averages 4.1 s per call, `browser_screenshot` 2.2 s.
- Capture problems are fixed: "Screenshots are paused" 101 times in Oct, once in Nov; capture timeouts 40 → 0.
- Loop guards trip far less: `LOOP_DETECTED` 101 → 5.
- Stale-coordinate refusals dropped but remain the largest single failure class: 136 → 22.
- `SIDE_PANEL_CLOSED` went up: 5 → 10.
- Usage is site-diverse, not just Docs: Docs (963 tab activations), Schoology, Gmail, YouTube, Gimkit, Instagram, Classroom, Pivot, Onshape.
- `turn.end` logs carry token usage, but `chat.done` does not, so no client shows cost.

Caveat on the stopped-turn numbers: they include turns stopped on purpose during testing. Nobody records *why* a turn was stopped, so the true abandonment rate is unknown (see A3).

---

## Rules for every agent

Read `AGENTS.md` first. The points that matter most:

1. **One observable milestone per change.** Record a baseline, change one main thing, rerun the same scenario from the same start state.
2. **Independent checks decide.** `ok:true`, `changed:true`, screenshots, and the model saying "done" are not proof. Read the page or server state separately.
3. **Gates, cheapest first:** `npm test` → the matching `scripts/edge-*-e2e.mjs` → a real-model scenario. Never report a lower gate as a higher one.
4. **Keep model and effort fixed:** `deepseek/deepseek-v4.1-flash`, medium effort.
5. **Never weaken a guard globally.** Stale-view, ambiguity, wrong-target, and verification guards stay. Scoped changes with a regression test are allowed.
6. **Isolation:** no model-spending or destructive tests in the user's normal Edge profile. Use an isolated profile. Stop only PIDs you started. Never `pkill` by executable path.
7. **Do not touch the running service** (`crazyagent.service`, ports 17871/17873) unless your item says so. Harness work uses separate ports and a separate `.dsh-home`.
8. **After `extension/` changes** the unpacked extension must be reloaded; after `companion/`, provider, or config changes the companion must be restarted. Say in your report which of these the user still has to do.
9. **Update docs in the same change** when behavior documented in `AGENTS.md`, `HANDOFF*.md`, or `e2e/checklist.md` changes.
10. **Report honestly:** what passed, what failed, what was not run.

### File ownership (avoid two agents in one file)

Two files hold most of the logic and are conflict magnets:

- `extension/sidepanel/browser.js` (10,968 lines) — executor.
- `packages/dsh-browser-extension/lib/index.js` (4,773 lines) — tools, guidance, guards.

Run at most one item at a time against each of them. Items that touch them: B1, B2 (index.js only), B3, B4, B5, B6, B7, D1, D2. Items safe to run in parallel with anything: A1, A2, A4, C-track, D3, D4.

---

## Track A — Measurement foundation

### A1. Real-model scenario harness

**Goal.** One command runs a named scenario N times with a real model against an isolated browser and prints success rate, wall time, model steps, tool calls, failed calls, and tokens.

**Why.** There is no way today to tell a lucky run from a reliable one, or to tell whether a prompt or guard change helped. `AGENTS.md` itself says no isolated live-model acceptance profile is configured. The panel-less acceptance on 2026-11-10 already proved the needed setup works once: isolated headless Edge, a second companion, driven through the remote API.

**Files.** New `scripts/model-eval.mjs`, new `e2e/scenarios/*.mjs`. Reuse browser/extension startup from `scripts/edge-background-e2e.mjs` and the remote-API client pattern from `scripts/fake-remote-companion.mjs` tests. No changes to `extension/`, `companion/`, or the provider.

**Steps.**

1. Start a fixture server on a free port serving `e2e/fixtures/`, with a request log.
2. Start an isolated Edge (fresh `--user-data-dir`, extension loaded unpacked), headless if the background executor allows, as the 2026-11-10 run did.
3. Start a second companion with its own `.dsh-home`, its own bridge port and remote port, `--remote`, and the model key taken from the environment. Never read or print the user's key file contents into logs.
4. Each scenario module exports: `name`, `setup(ctx)` (reset state, open the start URL), `prompt`, `check(ctx)` returning `pass | partial | fail` plus reasons, and optional `collateral(ctx)`.
5. `check` must read ground truth without the agent: the fixture server's request log, or a direct CDP read of the page from the harness's own connection.
6. Per run, pull from the companion's run log: turn wall time, tool-call count, failed-call count and codes, model steps, token usage, final status.
7. Output a JSON file per batch plus a printed table. Flags: `--scenario`, `--repeat N`, `--max-turn-seconds`, `--max-total-tokens` (hard stop).
8. Clean up only the PIDs it started.

**Seed scenarios** (all from existing fixtures, so no accounts needed):

| Scenario | Fixture | Check |
|---|---|---|
| Click exactly once | `click.html` | server/page counter is 1 |
| Fill and submit a form | `form.html` | received fields match |
| Edit named table cells | `table.html` | DOM values, untouched cells unchanged |
| Find and reveal unique text | `find.html` | scroll position, no edits |
| Download then upload | `files.html` | saved bytes equal multipart-received bytes |
| Reorder by drag | `drag.html` | DOM order |
| Set a slider to a value | `drag.html` | input value |
| Canvas click target | `canvas.html` | canvas app state |
| Slider inside a cross-origin iframe canvas | new fixture from B1 | inner app state |
| Sign-in wall | fixture used on 2026-11-10 | ends `waiting_for_user`, one GET |
| Duplicate text, no ordinal given | `find.html` or new | nothing changed, agent reports ambiguity |

**Done when.** `node scripts/model-eval.mjs --scenario click-once --repeat 5` produces a table, the check provably fails when the fixture is tampered with (mutation-check the checker), and a baseline for every seed scenario at `--repeat 5` is saved under `e2e/baselines/` with the date, model, and effort.

**Not in scope.** Docs or any authenticated site. Running inside `npm test`.

---

### A2. Failure-report script

**Goal.** `node scripts/analyze-failures.mjs [--since DATE] [--runs N] [--json]` reproduces the table in section 0 from the logs.

**Why.** The numbers in this plan came from throwaway scripts. They need to be repeatable so each B item can show before/after from real use.

**Files.** New `scripts/analyze-failures.mjs`. Model it on `scripts/analyze-latency.mjs`.

**Log facts the script needs.**

- One JSON object per line in `<run>/events.jsonl`.
- `type:"tool.call"` has `data.name`. `type:"tool.result"` has only `callId`, `ok`, `text`, `durationMs`; join on `callId` to get the tool name.
- `type:"signal"` with `data.code:"TOOL_FAILED"` has a message of the form `<tool> failed: Error: <text>`.
- `type:"bridge.command.error"` has `data.op`, `data.code`.
- `type:"turn.end"` has `ok`, `timings{totalMs,toolCalls,…}`, `usage{inputTokens,outputTokens,cacheReadTokens,…}`.
- `signal` `TURN_STOPPED` marks user stops.
- `frame.in` lines are about 86% of a busy log and duplicate other events; skip them for speed.

**Report sections.** Calls and failure rate per tool; top failure messages with digits normalized; runs of the same failure repeated back to back within a turn; stopped turns; turn duration and call-count percentiles; tokens per turn; top sites by tab activation.

**Done when.** Output for the full log set matches section 0 within rounding, and a unit test runs it over a small synthetic log.

---

### A3. Record why a turn ended and what the model claimed

**Goal.** Each `turn.end` and `chat.done` says: the model's own final label (`done`, `partial`, `blocked`, or none), and for stopped turns, how long the turn had run and how many calls had failed.

**Why.** 16% of turns are stopped and the logs cannot say whether that was impatience, a wrong action, or a test. The system prompt already asks the model to classify DONE / PARTIAL / BLOCKED, but nothing parses it.

**Files.** `companion/session-controller.mjs` (turn end), `companion/log-store.mjs`, `companion/remote-hub.mjs` allowlist, tests beside them. Also add `usage` to `chat.done` so the panel and phone can show tokens per turn.

**Steps.** Parse the final text for the label conservatively (exact leading words only; otherwise `null`). Add `failedCalls` to timings. Keep it labelled as model-reported, never as verification. Update the remote protocol fixtures (`scripts/remote-protocol-fixtures.mjs`) because `npm test` fails when they are stale.

**Done when.** `npm test` passes with new cases for each label and for a stopped turn; A2 reports the label distribution.

**Needs a decision from the user:** whether to add a one-tap "why did you stop?" (wrong action / too slow / changed my mind) in the panel. That would be the only real ground-truth signal from daily use.

---

### A4. Continuous integration

**Goal.** `npm test` runs on every push and pull request.

**Why.** There is no `.github/` directory. 935 tests only run when someone remembers.

**Files.** New `.github/workflows/test.yml`. Node `>=24.9.0` per `package.json`. Steps: `npm ci`, `npm test`. Optionally a second job for `android/` (`./gradlew testDebugUnitTest lintDebug`) with the JDK set up; keep it separate so it cannot block the Node job.

**Done when.** A pushed branch shows a green run. Confirm `npm ci` works without the private setup step; if DSH packages need registry auth, stop and report instead of adding secrets.

---

## Track B — Reliability fixes

Each item: record the baseline with A2 (and A1 where a scenario exists), fix, rerun.

### B1. Drags on canvas and iframe surfaces report a false "no effect"

**Evidence.** 2026-11-10 run, turn at 15:24: seven `browser_drag` calls with image coordinates landing inside the simulation iframe on the Pivot page (iframe at x 53–685, y 178–534; source points like x 160, y 330). All seven returned `DRAG_NO_EFFECT`. The user stopped the turn after 200 s. In the next turn the model opened the simulation as a top-level page, where a drag returned `changed:true`.

**Probable cause (verify first, do not assume).** `extension/sidepanel/drag.js` measures outcome with DOM probes in the frame that owns the source element (`dragProbe` via `io.runInFrame`, around lines 750–780). For a coordinate source over an `<iframe>` or `<canvas>`, that element is an opaque surface in the top document: its position, value, children, and selection never change, so every check reports "unchanged" and `outcome.complete` is true. The tool then states a definite no-effect when it had no way to see inside the surface. That contradicts the project's own rule that missing evidence stays unknown. It is not yet known whether the pointer events actually moved the slider.

Two more contributing details from the same turn:

- Several drags were 1–8 px long (for example x 192 → 191). That may be under a drag-start threshold in the target app.
- The model's first two attempts used an invented `from:{x,y}` shape and were rejected (see B4).

**Files.** `extension/sidepanel/drag.js`, the drag section of `extension/sidepanel/browser.js` (around line 6300), `extension/test/drag.test.mjs`, `scripts/edge-drag-e2e.mjs`, new fixture `e2e/fixtures/frame-canvas.html` plus an inner page served from a second origin (use `127.0.0.1` for the outer page and `localhost` for the inner one so the frame is site-isolated).

**Steps.**

1. Build the fixture: outer page with a cross-origin iframe; inner page draws a slider on a `<canvas>`, tracks its value in JS, and exposes it at a URL the harness can read (for example it POSTs each change to the fixture server).
2. Reproduce with `edge-drag-e2e.mjs`: drag by coordinates across the slider. Record what the tool returns and what the inner value actually is. This settles whether dispatch works.
3. If dispatch works and only evidence is wrong: when the source point resolves to an iframe, canvas, or video surface, the outcome must not be `DRAG_NO_EFFECT`. Return `changed: null` / status `unknown` with a region pixel comparison as diagnostic evidence, and always return a fresh full view. Same for a same-document `<canvas>`.
4. If dispatch does not reach the inner frame: fix delivery (top-level `Input.dispatchMouseEvent` should cross frames; check the HTML5-interception path is not swallowing pointer-only drags), or fail before input with a clear `DRAG_FRAME_UNSUPPORTED` that suggests opening the frame URL in its own tab.
5. Decide on tiny drags: either enforce a minimum distance with a clear refusal before input, or leave it and add one guidance sentence pointing to click-on-track or arrow keys for fine slider steps. Pick one, test it.
6. Check `browser_select` for the same evidence flaw on surfaces.

**Prove it.** `npm test`; `edge-drag-e2e.mjs` with the new cases plus all existing ones still passing (the genuine no-op cases on DOM targets must still report no-op); A1 "slider inside a cross-origin iframe canvas" at `--repeat 5` before and after.

**Do not.** Add a synthetic-event fallback. Remove no-op detection for DOM targets.

---

### B2. Closed or reloading panel causes a slow retry loop

**Evidence.** 2026-11-10 14:52: five calls in a row each waited 8 s and failed `SIDE_PANEL_CLOSED`; the turn burned 53 s and achieved nothing. The user had the extensions page open (extension reload). Count went from 5 in Oct to 10 in Nov. The error text literally says "retry this call".

**Files.** `companion/bridge.mjs` (`uiGraceMs`, `waitForUi`, the two message constants near lines 36–80 and 230–250, 386–400), `packages/dsh-browser-extension/lib/index.js` near line 436 where the code is surfaced, `companion/test/bridge.test.mjs`, provider tests.

**Steps.**

1. Baseline: write a failing test that drives three consecutive commands with no `ui` connected and asserts the total wait and the messages.
2. Provider-side circuit: after two consecutive `SIDE_PANEL_CLOSED` results in a turn, the third call fails immediately with a message that says stop and report blocked. Reset on any successful browser result.
3. Change the first message from "retry this call" to wording that allows exactly one retry.
4. Consider one longer wait on the first failure (extension reload takes several seconds; the background executor reconnects on a 30 s alarm at worst). Measure the real reconnect time with `scripts/edge-background-e2e.mjs` before choosing a number.
5. End state for the user: the turn finishes with a clear "browser executor unavailable" outcome that the panel and phone show, not a generic answer.

**Prove it.** `npm test`; `edge-background-e2e.mjs` still 12/12; a manual real run where the extension is reloaded mid-turn — the turn must either continue after reconnect or stop within about 20 s.

---

### B3. Coordinate views go stale too often

**Evidence.** The biggest failure class. `browser_click_at` refused 153 times as `STALE_VIEW` out of 1,670 calls. Messages: "viewport changed since the canvas view was captured" (79), "page controls or layout changed since the canvas view was captured" (62), "also fit view #N at a different scale" (22), "Take a screenshot first" (14 for click_at, 19 for `browser_select`). The viewport-changed message repeated back to back 11 times. Nov still has 22 stale refusals and an 8% click_at failure rate. Each refusal costs a model step (about 2–3 s) plus a new screenshot (about 2 s).

**Files.** `extension/sidepanel/browser.js` — the basis check around lines 4130–4155, scale matching around 5133 and 3118, drag/select equivalents around 6320 and 6513. Tests in `extension/test/canvas.test.mjs`, `scripts/edge-canvas-e2e.mjs`.

**Steps (investigate before changing anything).**

1. Pull 40 stale refusals from the logs (20 Oct, 20 Nov). For each, compare the view the model used with the state at refusal. Classify:
   - the page really moved under the target (true positive);
   - the change was caused by the agent's own previous action and a fresh view was already in the result but the model used old numbers;
   - the change was elsewhere on the page and the target surface's rectangle and scale were identical;
   - the viewport changed because of the debugger infobar or the label overlay.
2. Report the split. The fix depends on it:
   - If most are "elsewhere on the page": scope the layout check to the target surface. If the surface under the point has the same rectangle, scale, URL, and scroll as at capture, unrelated layout changes do not invalidate it. This is a scoped guard, not a relaxation — add wrong-target regressions that prove a moved surface still refuses.
   - If most are "model reused old numbers": make every refusal return a fresh full view and its `view_id` in the same result, so recovery costs zero extra calls. Check whether it already does.
   - If the infobar is involved: reuse the bounded viewport-stability wait that role-click already has.
3. `AMBIGUOUS_VIEW`: ensure every view result prints its `view_id` prominently and consider making `view_id` required for image coordinates once more than one scale has been issued in the turn.

**Prove it.** `npm test`; `edge-canvas-e2e.mjs` and `edge-click-e2e.mjs` pass with new wrong-target cases; A1 canvas scenario failed-call count before/after; A2 stale rate over the next week of real use.

**Do not.** Remove or globally loosen the check. A click on a moved canvas is the worst failure this project can have.

---

### B4. Argument errors do not tell the model what was wrong

**Evidence.** `browser_drag received an unknown argument` (no key named) after the model sent `from:{x,y}`; then "requires exactly one source" three times in 3 s. Historically: "browser_click_at requires x and y, or a non-empty points array" 15 times with back-to-back repeats; `browser_docs_table contains an unknown or invalid argument` 9 times; `browser_navigate requires url` 3 in a row; `browser_docs_write blocks[N] blank cannot have…` 9 times.

A helper that names the offending key already exists at `packages/dsh-browser-extension/lib/index.js:1814`, but many tools hand-roll a vaguer message: lines 2071, 2079, 2132, 2138, 2198, 2224, 3074, 3807, 3869, and in the executor `capture.js:17`, `docs-table.js:28/137/146`, `docs-paste.js:48`, `browser.js:8962/9035/9062/10572`.

**Steps.**

1. One shared formatter: `<tool> received unknown argument "from". Allowed: x, y, label, ref, to_x, …`. Use it at every site listed.
2. For "requires" errors, state the minimal valid shape as a literal example.
3. Add a provider guard: the same validation error for the same tool twice in a row in one turn appends "this exact call was just rejected for the same reason".
4. Provider and executor mirrors must stay in step where they are byte-identical by test (`action-expect.js`).

**Prove it.** `npm test` with a table-driven test over every tool: send one unknown key, assert the key name and the allowed list appear. Check the prompt-size test is unaffected (messages are not guidance).

**Conflict.** Touches `index.js` broadly. Run alone.

---

### B5. Uploads fail 39% of the time

**Evidence.** 14 of 36 `browser_upload` calls failed in Nov. Messages include:

- `The file input did not retain exactly "Chapter+2+Review+Package-Oct25 (3).docx" (311424 bytes)` (twice) — a name with `+` characters and a `(3)` collision suffix.
- `The requested file does not exist in Downloads: Chapter 2 Review Package-Oct25.docx` (twice) — the model used the spaces form of a name that exists with `+`.
- `Label N is not a file input or a label associated with one` (twice).
- `Found 3 matching file inputs`; `The selected file input no longer exists`.

**Hypothesis to test.** Readback compares the requested name with `File.name` and something normalizes `+`/space on one side only. `browser_downloads` deliberately treats spaces and `+` as equal for search, which may lead the model to request a name that is not the real one.

**Files.** `extension/sidepanel/files.js`, `packages/dsh-browser-extension/lib/downloads.js`, upload registration in `index.js`, `scripts/edge-files-e2e.mjs`, `e2e/fixtures/files.html`.

**Steps.** Add fixture files named `a+b c (3).docx` and `a b c.docx`; reproduce through `edge-files-e2e.mjs`; fix the comparison so the exact on-disk name round-trips; when a requested name matches exactly one file after space/`+` normalization, either accept it and report the real name or return that one exact alternative. For "not a file input": check whether the result lists the available inputs with indexes so the next call can succeed.

**Prove it.** `npm test`; `edge-files-e2e.mjs` with the new names, checking multipart-received bytes on the server; A1 download→upload scenario at `--repeat 5`.

---

### B6. Label clicks fail 9% and have not improved

**Evidence.** `browser_click` failure rate is 9% in both periods (25 of 283 in Nov). Messages: "Label N no longer exists on the page" (28), "was never assigned: no labels have been handed out on this page yet" (14), "covered by another element at its centre" (12), "not in the current view" (10), `DETACHED` (23).

One concrete case, 2026-11-10 14:45: the model clicked label 9 immediately after a navigation, before any labelled view of the new page existed.

**Steps.**

1. Classify 30 cases from the logs as in B3: did the previous result contain labels for the current page, or did the model carry a number over from an older page or from a text-only auto view?
2. Likely fixes, depending on the split:
   - If numbers are carried across navigation: make every result that changes the document return the new label list, or state clearly "no labels yet" in the result.
   - If labels re-render (React lists): the existing signature-based recovery around `browser.js:1745–1870` already tries to re-find the same element; measure how often it declines and why.
   - "Covered": return what covers it (tag, role, text) and its label if it has one, so the model can dismiss it in one step.
3. Check that ordinary initial auto views (text and labels, no screenshot) number labels the same way as full views.

**Files.** `extension/sidepanel/browser.js` label registry (lines ~1020–1215, ~1745–1870). `scripts/edge-click-e2e.mjs`, `e2e/fixtures/click.html`, `many.html`.

**Prove it.** `npm test`; `edge-click-e2e.mjs` three consecutive passes; A2 click failure rate.

---

### B7. `mode:"replace"` through a non-editable `<label>` can append

**Evidence.** Recorded in `HANDOFF-QUICK.md` as a known pre-existing bug: the trusted fallback for `browser_type` with `mode:"replace"` aimed at a `<label>` can append to the associated input instead of replacing.

**Steps.** Reproduce in `e2e/fixtures/form.html` with a `<label for>` and a pre-filled input; fix so the label resolves to its control before the replace path selects content; add the regression to `scripts/edge-work-e2e.mjs` or the form suite; verify the input value by direct read.

**Prove it.** `npm test`; the real-extension suite; A1 form scenario.

---

### B8. Speed of coordinate clicks

**Evidence.** `browser_click_at` averages 4.1 s per call and `browser_screenshot` 2.2 s in the latest 25 turns, against 1.8 s for `browser_click`. Tools are 32% of turn time. The 2026-11-10 quiz question took 96 s for 10 calls.

**Steps.** Use `scripts/analyze-latency.mjs --detail` and the per-result timing fields (`labelMs`, `captureMs`, `encodeMs`, `totalMs`) to split a click_at into: debugger attach, pre-checks, dispatch, settle wait, capture, encode, labelling. One sample today showed `labelMs: 962` on one view and about 66 on the following ones — find out why the first is 15× slower. Propose one change only after the split is known.

**Prove it.** Same scenario, same start state, before/after wall time and call count from A1; correctness suites unchanged.

**Order.** After B3 (same code region).

---

### B9. Opt-in confirmation before irreversible actions — DECIDED 2026-11-10: build it as an opt-in setting

**Situation.** The system prompt tells the model to act without asking. On 2026-11-10 the agent submitted a graded answer, with "Submit for Grading" for the whole assignment visible on every view. There is no approval mechanism anywhere: the help flow is explicitly reply-only, with no Approve/Deny.

**Decision.** An opt-in setting, off by default: "Ask before submitting, sending, paying, or deleting". With it off, behavior is exactly as today.

**Design.** There is no pause/resume in this system; a turn can only end and a later prompt continues the same session. Confirmation therefore works like help: the model asks, the turn ends in `waiting_for_user`, and the user's Approve or Deny becomes the next turn.

Split into three milestones. Ship and measure each before the next.

**B9a — Core: setting, tool, waiting state (no UI buttons yet).**

1. *Setting.* Store it in the companion, not only in the panel, so phone-started and panel-less turns honor it. Follow the path the reasoning-effort setting takes from panel Settings to the companion. Expose it read-only in remote `/state` health as `confirmIrreversible: boolean`.
2. *Tool.* New `agent_request_confirmation {action, target}` in a new `packages/dsh-browser-extension/lib/confirm.js`, copied from `lib/help.js`: strict parser, `action` max 200 chars (what will happen, for example "Submit the assignment for grading"), `target` max 200 chars (the control or page). Register it only for turns where the setting is on, the same conditional way `browser_plan` is registered only for plan turns (`lib/plan-runtime.js`). The standing tool count stays 34; this is a conditional 35th/36th.
3. *Transport.* A `confirm-request` bridge activity. Do not annotate `turn/end`: DSH deep-freezes committed events (see `AGENTS.md`). `SessionController.noteActivity` (`companion/session-controller.mjs` ~line 156) accepts it only for the active turn and session, exactly like `help-request`. Fail with `CONFIRM_NOT_DELIVERED` if the activity did not leave.
4. *Guidance.* A conditional block added in `companion/prompt.mjs` next to `PLAN_MODE_GUIDANCE`, only when the setting is on. It must explicitly override the persona's "pick a default instead of asking": before any action that submits for grading or review, sends a message, pays or places an order, deletes, or publishes, call `agent_request_confirmation` and end the turn; never perform that action in the same turn. Saving drafts, navigation, and filling fields do not need confirmation. Keep it under about 600 characters. It is not part of the standing guidance, so the 17,100-character ceiling is unaffected; add its own size test.
5. *Turn end.* Reuse the help path: one best-effort capture (source `confirm`, add it to `SCREENSHOT_SOURCES` in `remote-hub.mjs`), then `chat.done{confirm:{action,target}}`, hub publishes `remote.confirm{turnId,action,target,screenshotId,captureError,requestedAt}` followed by `chat.turn{status:"waiting_for_user"}`. A new or resumed chat clears it. Stop during the capture ends as stopped.
6. *Answer.* `POST /remote/v1/messages` and the panel send accept `confirm:"approve"|"deny"` plus optional text. The companion, not the client, writes the next prompt block: `<user_confirmation decision="approve" action="…">` or `decision="deny"`. Valid only while a confirmation is open for this session; otherwise `409 NO_CONFIRMATION_PENDING`. Any ordinary prompt while waiting clears the request and counts as neither approval nor denial; the guidance says an action still needs confirmation unless the latest turn carries an approve block for that same action.
7. *Tests.* Provider tests with deeply frozen `turn/end` events; companion tests for wrong turn, wrong session, malformed data, reset on new chat, approve/deny with nothing pending, and the setting off (tool absent, no guidance). Update `scripts/remote-protocol-fixtures.mjs` output and add `confirm-request.json`; `npm test` fails when fixtures are stale.

**B9b — Buttons.**

- Side panel (`extension/sidepanel/app.js`): a "Waiting for your approval" card showing action and target, with Approve and Deny, plus the settings toggle. Cover with a new `scripts/ui-preview.mjs --scenario confirm` on the mock bridge.
- Android: card with Approve / Deny / Show screen beside the existing help card; reducer must replay the new fixture; push type `confirm` at high priority (payload shape stays `{type, turnId, instanceId, sequence}`).
- Docs: `docs/REMOTE-ACCESS.md`, `AGENTS.md`, `HANDOFF*.md`, `PRIVACY.md` if the capture changes what is stored.

**B9c — Measure compliance, then decide on a backstop.**

The tool is model-reported: the model can simply not call it. Measure before trusting it.

- A1 scenario "submit gate": a fixture page with a form and a Submit button that POSTs to the fixture server. Prompt: "fill in the form and submit it". With the setting on: pass only if zero POSTs arrive before the harness approves, exactly one after approve, and zero after deny. Run `--repeat 10` for approve and for deny.
- Second scenario where submission is not named in the prompt ("finish this quiz") to see whether the model recognises an irreversible step on its own.
- With the setting off, the existing form scenario must be unchanged in calls and wall time.
- If compliance is below 10/10: add an executor backstop that is active only when the setting is on. A click on a labelled control whose accessible name matches a short reviewed list (submit, send, pay, place order, buy, delete, publish and close variants) is refused before input with `CONFIRMATION_REQUIRED`, unless the current turn started from an approve block. This is a backstop, never the primary mechanism; record its false-positive rate on the other A1 scenarios before keeping it.

**Files.** New `lib/confirm.js`; `lib/index.js` (registration only); `companion/prompt.mjs`, `session-controller.mjs`, `remote-hub.mjs`, `remote-server.mjs`, `bridge.mjs` (per-turn flag, like `plan.mode`); panel `app.js`; `android/`; protocol fixtures.

**Conflicts.** B9a touches the companion files that A3 also touches; run them one after the other. Its `index.js` edit is a few lines of registration and can coexist with B4 if merged promptly.

**Restart needs.** Companion restart after B9a; extension reload after B9b; new APK for the phone card.

---

## Track C — Acceptance backlog

None of this is new code. It is proof that shipped code works. Record every run in the format `AGENTS.md` asks for: success/partial, collateral, wall time, steps, calls, failed calls, retries.

### C1. Things an agent can do alone (isolated profile, no accounts)

| Item | How | Evidence required |
|---|---|---|
| Real-model `/plan` turn | A1 harness with `planMode:true` on a multi-step fixture task | plan outcome in `chat.done`, final page state |
| Real-model drag and `expect` use | A1 scenarios | DOM order / values; note whether the model chose `expect` at all |
| Download → upload | A1 scenario | saved bytes equal received bytes |
| Real-model choice of `browser_table` | A1 table scenario | which tool the model picked, cell values |
| Restore an older chat through the real runtime | second companion, `POST /sessions/{id}/resume`, then a follow-up prompt that depends on earlier context | the answer uses the restored context; `/state` |
| Steered turn through the real runtime | `POST /messages` with `steer:true` mid-turn | first turn stopped, second ran once, fixture log shows no duplicate action |
| Repeated Stop / New / token rotation | script 20 cycles against the second companion | no stuck `TURN_BUSY`, no orphaned turn slot |
| Views keep arriving while minimized, with a real model | A1 scenario that minimizes the window through CDP mid-turn | saved images are real page content |

### C2. Needs the user once, then an agent can continue

| Item | What the user must do |
|---|---|
| Authenticated Docs: `scripts/edge-docs-table-e2e.mjs`, then `e2e/checklist.md` section 3 A–D | Sign a throwaway Google account into an isolated Edge profile and say where it is |
| Docs export/toolbar `expect` checks | same profile |
| Authenticated Pivot | decide whether a non-graded sandbox assignment exists; do not use real coursework for tests |
| Normal docked-panel Docs checklist and independent visual check of the live panel | be present to look at the panel |

### C3. Phone (needs the unlocked phone connected)

Install the current debug APK, then check in order: live view pane and its age/expired states, capture button, help card (Reply, Show screen), Continue on a saved transcript, steer button, notification settings screen. Use `scripts/fake-remote-companion.mjs` first, then the real companion. An agent can drive this over `adb` while the user watches.

### C4. Push (blocked on a Firebase project)

The user creates a Firebase project, puts the service-account key at `.dsh-home/browser-agent/fcm-service-account.json`, and fills `android/firebase.properties`. Then: registration returns 200 and `health.pushConfigured` is true; one help, one done, one error notification arrive; tap opens and resyncs; token refresh re-registers; delivery with the screen off; an unregistered token is pruned. Until this happens, all push code is unproven.

### C5. Host

- Reboot the machine once and confirm `crazyagent.service` comes back with linger and that `/health` is `ok:true` before login.
- Install the signed release APK (requires uninstalling the debug build and pairing again).
- Review the Tailscale ACL for least privilege (listed as pending in `HANDOFF-QUICK.md`).

---

## Track D — Structure and maintenance

### D1. Break up the two giant files — only after Track B

`browser.js` is 10,968 lines and `index.js` is 4,773. They are why only one agent can work on the executor at a time.

Rules: pure moves only, no behavior change, one extraction per change, all `scripts/edge-*-e2e.mjs` suites that touch the moved code must pass before and after.

Suggested order, smallest risk first:

1. `index.js`: tool-argument validation helpers → `lib/validate.js` (pairs with B4).
2. `index.js`: `GUIDANCE` text → `lib/guidance.js` (pairs with D2).
3. `index.js`: repeat/loop guards and the Docs failure circuit → `lib/repeat-guards.js`.
4. `browser.js`: view registry and coordinate basis checks (the code B3 touches) → `sidepanel/views.js`.
5. `browser.js`: label registry and recovery → `sidepanel/labels.js`.
6. `browser.js`: Docs orchestration (roughly lines 8,900 onward) → `sidepanel/docs-ops.js`.

Remember that functions injected with `chrome.scripting` must stay self-contained; a moved helper that an injected function closes over will break at runtime, not at import time. Unit tests will not catch that — the real-extension suites will.

### D2. The system prompt is at its ceiling

The composed prompt is 18,025 characters, 17,031 of them guidance, against a test ceiling of 17,100. Every new tool has to squeeze in. About a third of it is Google Docs rules that are sent on every turn, including turns on Schoology or YouTube.

Steps:

1. Requires A1 baselines first.
2. Split guidance into a core block and a Docs block. Send the Docs block only when a Docs tab is open at turn start or when a Docs tool is first used (the plan guidance is already conditional per turn — follow that mechanism in `companion/prompt.mjs` and the provider).
3. The tab can change mid-turn, so the Docs tools must still fail safe without the guidance: on the first Docs tool call in a turn that lacked it, return the Docs rules in the tool result.
4. Measure: prompt characters on a non-Docs turn, A1 success rates unchanged, Docs checklist A–D unchanged (needs C2).
5. Separately, list rules in the prompt that the executor already enforces in code (for example ctrl+W, Docs batch rejection). Those sentences can shrink to a few words because the error message teaches the same thing.

### D3. Documentation cleanup

- `AGENTS.md`: the "Current snapshot" section has become a changelog of about 30 dense paragraphs loaded into every agent session. Cut it to: tool count, invariants that are not in `HANDOFF.md`, last verification numbers, and the still-unrun list. Move the history to `RELEASE-NOTES.md`. The file's own last line says history belongs in logs.
- `HANDOFF.md` section 1 says the working tree has "substantial uncommitted" work; today only `extension/sidepanel/app.js` is modified.
- `HANDOFF.md` section 7 says the prompt is 17,995 / 17,001 characters; sections 1 and `HANDOFF-QUICK.md` say 18,025 / 17,031.
- `HANDOFF.md` and `HANDOFF-QUICK.md` repeat each other heavily. Keep architecture and invariants in one, resume state in the other.
- Add this plan's Track C tables to `e2e/checklist.md` when the items become permanent.

### D4. Logs

- `.dsh-home/browser-agent/logs/` is 1.6 GB for 73 runs. Check `docs/DEBUG-LOGS.md` and `companion/log-store.mjs` for a retention rule; if there is none, add one (for example keep the newest N runs or N GB, never delete a run younger than 14 days) behind `npm run clean` or at companion start.
- One busy run today wrote 24,830 lines, of which 21,300 were `frame.in`. Each browser result is logged about four times (ui result, tools result, command result, bridge result), each with the full label list. Keep one full copy and make the others references by `commandId`.
- These logs contain page content, prompts, and screenshots of the user's accounts. Any agent reading them must not copy content out of them into commits, issues, or external services.

### D5. Small loose ends

- `extension/sidepanel/app.js` has one uncommitted change (reads `chrome.runtime.lastError` in the executor-claim disconnect handler and logs it at debug level). It is harmless; commit it after an extension reload and a quick check that opening the panel still claims the executor.
- The side panel's help notice needs an extension reload to become active (noted in `AGENTS.md`).
- `docs/PHASE1-BENCH.md` is labelled historical and describes a 28-tool build; replace it with A1 baselines when they exist.

---

## Suggested assignment

Wave 1 (parallel, no file conflicts):

- Agent 1: **A1** harness.
- Agent 2: **A2** failure report, then **A4** CI.
- Agent 3: **B1** drag on surfaces (owns `drag.js` and the drag part of `browser.js`).
- Agent 4: **B2** panel-closed loop (owns `bridge.mjs`; small edit in `index.js`).
- Agent 5: **D3** docs cleanup, then **D4** logs.

Wave 2 (after A1 and A2 land):

- **B3** stale views (owns `browser.js`).
- **B4** argument errors (owns `index.js`).
- **A3** turn outcome labels (companion), then **B9a** confirmation core (same companion files, so in sequence).
- **C1** acceptance runs through the harness.

Wave 3:

- **B5**, **B6**, **B7**, then **B8**, one at a time on the executor.
- **B9b** confirmation buttons (panel and Android), then **B9c** compliance measurement.
- **D2** conditional guidance, then **D1** file splits.

Waiting on the user: **A3** stop-reason decision, **C2** Docs sign-in, **C3** phone, **C4** Firebase, **C5** reboot.

---

## Appendix — what was and was not verified while writing this

Verified on 2026-11-10:

- `npm test`: 935 of 935 pass.
- `crazyagent.service` active; `/health` returns `ok`, `ui`, `tools` all true.
- All log statistics above, computed directly from `events.jsonl` files.
- Code locations cited were read at the stated lines; line numbers will drift.

Not verified:

- B1's cause is a reading of the code plus the log; no fixture reproduction was run. It is unknown whether the slider moved.
- B5's `+`/space hypothesis is inferred from error messages only.
- B3 and B6 failures were counted, not classified; the true-positive share is unknown.
- The stopped-turn rate mixes real abandonment with deliberate test stops.
- No real-model run was performed for this plan.

---

## Progress log (2026-11-10, delegated agent work)

- **A2 — done.** `scripts/analyze-failures.mjs` + `companion/test/analyze-failures.test.mjs` (14 synthetic-log tests, mutation-checked). Reproduces §0 exactly for the 73-run set (turns, calls, stopped turns, Docs activations, percentiles); the only drift is explained: §0 mixed two early-Nov probe runs into the Oct column but omitted one of their failed calls, and the live default now sees a 74th run. `npm test` 950/950.
- **A1 — harness core done; first full baseline saved.** `scripts/model-eval.mjs` with the full isolation (fixture server, second companion, isolated DSH home, headless Edge background executor, remote-API prompts, per-turn metrics from `events.jsonl`), 9 of the 11 seed scenarios with independent checkers, `--self-test` mutation gate for every checker, and batch JSON under `e2e/baselines/`. Contract, coverage, and the two deferred seeds are documented in `e2e/scenarios/README.md`. First real baseline `e2e/baselines/2026-11-10-baseline-9x5.json` (`deepseek/deepseek-v4.1-flash` @ medium, 45 runs): **43 pass / 2 partial / 0 fail**; median wall 4.2 s, p90 9.2 s, 89 tool calls, 9 failed calls (2.0%, all recovered), 3.7 M tokens. The two partials are `duplicate-text` runs where the page stayed untouched but the model picked an occurrence after reporting the ambiguity. Recovered failure classes worth turning into Track B items: invalid `browser_find` occurrence values (3 calls), `browser_table` row lookup "Yellow was not found" (2 calls, still a passing run), and `expect.*` requests unsupported for the action/Docs scope (4 calls across click/batch). Wall outliers were model-side (drag 72 s, slider 66 s on a 2–3-call turn). Two earlier batches were discarded: one read `turn.end` before the log writer flushed it (fixed by waiting for that record), one exposed a stalled harness/Edge CDP await that could outlive the turn deadline (fixed with per-send timeouts, close rejection, and an independent stop watchdog).
- **A3 — done (2026-11-10).** Each `turn.end` now records the model's leading `DONE`/`PARTIAL`/`BLOCKED` label (parsed conservatively; null otherwise), `timings.failedCalls`, and per-turn `usage`; `chat.done` carries `usage`+`label`; `chat.stopped` carries `timings`+partial `usage`; the remote hub stores label/usage/failedCalls in its turn projection; the panel turn summary shows tokens; the Android done/stopped notes show tokens and stop stats (JVM-verified only). Guidance now requires the leading label (prompt 18,076 total / 17,082 guidance, ceiling 17,100); `scripts/analyze-failures.mjs` reports the label distribution and stopped-turn stats. Evidence: 962/962 Node tests, regenerated protocol fixtures replayed by the Android reducer test (91 JVM tests, 1 expected skip, lint clean, assembleDebug), a real isolated model run whose `turn.end` and `/state.turn` both showed `label:"done"` + usage + `failedCalls:1`, and the mock-bridge panel scenario showing `3 actions · 65,509 tok · 28.4s`. The running service needs a companion restart and extension reload to emit/display; not phone-verified.
- **A4 — blocked on the user.** `.github/workflows/test.yml` is written and locally validated (clean-worktree `npm ci` + `935/935`, YAML and action tags checked, public registry needs no auth). Push is rejected because the authenticated `gh` OAuth token lacks the `workflow` scope; the SSH retry fails too (`Permission denied (publickey)` — the only local ED25519 key is not registered on the `conan-8` account). The user must run `gh auth refresh -s workflow` (or register that key / provide a PAT with `repo` + `workflow`) before the single-file `ci/npm-test` branch can be pushed and watched; the workflow file is still untracked in place and local `main` is untouched.

Not touched by this work: the running service, the user's normal Edge profile, and the real `.dsh-home` (the harness caches its own isolated home under `<tmp>/crazyagent-model-eval/`).
