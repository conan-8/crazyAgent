# The program loop — plan-as-data, verified steps, plan-level state

Status: **plan, not yet built.** Written 2026-10-07 on top of `79e7bba`
(the human-flow layer), from the three field-test runs D/E/F of the 32-item
Google Docs benchmark.

Companion docs:
- `HUMAN-FLOW-PLAN.md` §3 designed `run_program`; **this file is that design
  finished**, now justified by measurement and sequenced as a build order.
- `SPEED-BRAINSTORM.md` — R1/R2/R3 (trace replay, mid-sequence captures,
  plan-then-execute), O1/O2/O4, D1/D3, T7.
- `CORRECTNESS-BRAINSTORM.md` — C5 (trace compiler), C6 (effect verification
  on every mutating action), C7 (`expect` params), C8 (auto-undo), C16
  (graded benchmark).

---

## 0. Verdict — yes, the loop's *unit of work* is wrong

Not the mechanics (the ladder, the magnet, the settle, `docs_op`'s
self-verification all worked in the field test), but the granularity:

> **One model round trip per UI action.**

The runs, measured (D `…22-10-10`, E `…22-10-17`, F `…22-10-22`; all solo,
same build, same task):

| | D | E | F |
|---|---|---|---|
| wall / turns | 31.3 min / 250 | 84.9 min / 341 | 25.1 min / 107 |
| **model time (TTFT+decode)** | **20.4 min (65 %)** | **62.8 min (74 %)** | **16.9 min (67 %)** |
| tool-call time | 6.7 min (21 %) | 13.6 min (16 %) | 3.9 min (16 %) |
| observe/settle/attach | 4.2 min (13 %) | 8.5 min (10 %) | 4.2 min (17 %) |
| **read-only/verify-only turns** | **61 (24 %)** | **104 (30 %)** | **52 (49 %)** |
| document progress | 12/32 items | ~8 open at death | 4 open at death |

Sixty-five to seventy-four percent of the wall clock is the model deciding
**single actions**, and a quarter to a half of all turns produce **zero
document progress**. At ~4–11 s of model time per action (E averaged 11.1 s:
4.3 s TTFT + 3.6 s decode at `low`, plus cap re-asks), 32 checklist items
cannot fit in a sane wall clock no matter how many misfires we remove —
~20 turns per completed item is a structural cost, not an accident.

The task is a numbered checklist of knowable UI procedures. The model should
deliberate **once per item** and the harness should drive the actions.

**What is *not* wrong** (do not rewrite): the deterministic primitives are
the right substrate — `docs_op` + `menu_path` + the magnet + trusted input +
per-action observation. The fix is to move the model **up a level** and let a
program executor consume those primitives.

---

## 1. Why the current loop cannot get there by tuning

Three structural gaps, each with field evidence:

1. **Granularity.** Every micro-decision is a full round trip over a 40–70 k
   prefix: `click_at 54/87/13`, `key 45/34/10`, `input_sequence 34/41/17` in
   D/E/F. Batching nudges (`STEP_RULES_BATCHED`, multi-tool turns) measured
   3.6 % / 9 % / 12 % — a model can't batch steps whose arguments depend on
   the previous step's result. Prompting has hit its ceiling here.
2. **Verification.** On a canvas editor the auto-observation shows chrome,
   not content, so the harness's "[page unchanged]" signal is blind exactly
   where the document lives. It already pays for before/after screenshots
   (164/175/277 of them) and throws the comparison away, so the model
   re-reads the document instead: 61/104/52 verify-only turns, plus 19/32/0
   "unchanged since" collapses it does not trust.
3. **Plan state.** `todo_write` is advisory text the loop never reads. D
   announced "12 of 32 verified, I need to stop" and the run ended `done`
   with 19 items open — the user had to type "continue then. why are you
   stopping if you can do it". There is no per-item status machine, no
   `blocked`, no retry budget per item, and no "park it and move on".

Everything else in the field test was a *knowledge or robustness* defect on
top of these (see §3 Phase A), and each one costs 5–20× more turns than it
should **because** of gap 1: a wrong menu label costs a full round trip to
discover, a failed menu walk leaves a menu open and costs the next walk too,
and a missing content-script bridge sends the model off to raw
`evaluate_js` DOM clicking (35 calls in F) instead of one deterministic step.

---

## 2. Target shape

```
task ──compile──▶ todos (the plan)          ← model, once per item
                     │
                     ├── program (plan-as-data: typed steps + expect each)
                     │      │
                     │      └── executor drives the primitives (no model calls)
                     │             each step: run → settle → VERIFY → repair once → next
                     │
                     └── model consulted only on exceptions (divergence + screenshot)
```

- **Forty actions between model turns is normal**; ~32 programs + a handful
  of exception turns replaces 250–351 turns (this is `HUMAN-FLOW-PLAN` §3).
- The model's per-item job shrinks to: pick the macro (docs_op op / menu
  walk / shortcut), fill args from the task text, attach the note.
- The harness owns retries, alternates and parking — "if something doesn't
  work, don't try it 100 times" becomes enforced, not requested.

Estimated effect on the same benchmark (from the measured waterfall):
model turns drop ~3–5×, verify-only turns collapse into verified steps, and
the wall clock floor becomes deterministic tool time (~8 steps × ~1.5 s per
item) instead of 20 model round trips per item.

---

## 3. Build order

Five phases. Every phase is independently shippable and measured; A is
prerequisite for C only because the executor must not be built on a menu
model we know is stale.

### Phase A — make the primitives trustworthy (the field-test patches) — **SHIPPED 2026-10-07**

Status: all seven items landed on top of `79e7bba` (working tree), 864 unit
tests green, `npm run verify` all suites green. Implementation notes and the
per-patch evidence live in `docs/DEV.md` → "Field-test pass (2026-10-07)".
Two smoke expectations moved on purpose: the docs D3g note regex (the
ref-less typing note now names the landing point) — nothing else was
weakened.

Small, all evidence-backed, no architecture change. Do first: they pay off
immediately, and C's executor cannot work on a menu map that is wrong.

| # | Fix | Evidence | Files |
|---|---|---|---|
| A1 | **Docs menu map refresh** from the live dump: `Insert ▸ Symbols ▸ Equation`; top-level `Header`/`Footer` (no "Headers and footers"); `Page numbers` under `Insert ▸ Page elements`; `Table options` (was "Table properties"); `Table of contents` top-level; merge-cells needs a 2+ cell selection. New `docs_op` ops so the model stops improvising paths. | 9/16 menu walks failed in D, 3/22 in E; model burned ~40 turns guessing | `extension/src/shared/docs-ops.ts`, `tools/docs-op.ts`, `tests/docs-ops.test.ts` |
| A2 | **`menu_path`/`docs_op` misses teach**: the failure text lists the sibling labels actually seen ("Insert shows: Image, Table, … Header, Footer, Watermark"), presses Escape before walking, and retries the walk once after a miss. | items that exist reported missing (D t11→t12/t14, t148→t152: a failed walk leaves the menu open, the next walk's first click closes it) | `tools/docs-op.ts` |
| A3 | **Content-script self-heal + honest health check**: on `actions-not-loaded`, inject `content/main.js` into that frame and retry once; `page_health` probes the real `__baActions` bridge instead of generic injection. | F: ~40 turns of `scroll`/`key`/`menu_path` failing while CDP tools worked; `page_health` said "injection: ok (16 frames)", the model believed it, retried, hit the ban warning, abandoned `menu_path` for raw DOM clicking | `tools/content-action.ts`, `tools/perception.ts` |
| A4 | **Bound the checkpoint**: prune `cp.messages` in place when it exceeds ~3–4× the history budget (reuse the pairing-safe `truncateHistory` trim). | silent service-worker deaths: A 1.83 M chars, E 2.54 M, F 2.74 M — three of the last six runs | `agent/loop.ts` |
| A5 | **Thinking must actually drop**: trip the overrun breaker on 3 overruns **total** (not 3 consecutive), keep the downgrade sticky, and fix the routine threshold (300 chars of reasoning is unreachable at `low` — the adaptive cascade never engaged in any of the six runs). | E: 14 cap cuts, F: 11, none tripped the breaker → ~20 wasted minutes in E; adaptive-thinking note count: 0/0/0 | `agent/loop.ts` |
| A6 | **Completion gate + `blocked`**: a final answer with open todos gets ≤2 nudges naming the open items; `todo_write` gains `blocked` (the ladder already tells the model to mark items blocked, but the status does not exist). | D quit at 12/32 and was accepted as `done` | `agent/loop.ts`, `tools/todo.ts`, `sidepanel/*`, `shared/chat.ts` |
| A7 | **`type` without a ref warns on canvas editors** (keystrokes are going to the document body, not the dialog/iframe the model thinks it focused). | E t113/t149 "the query leaked into the body again" ×2 in F too | `tools/actions.ts` |

### Phase B — deterministic effect verification (the executor's substrate) — **SHIPPED 2026-10-07**

Status: the verdict, the expectation vocabulary and the one safe repair landed
(890 unit tests green, docs smoke D10–D12 pin the three behaviours end to end).
`docs/DEV.md` → "Effect verification" has the measurements, including the two
bugs the fixtures caught: the 32×20 grid was blind to thin document text
(best cell delta 1 vs 11 cells at 96×60) and the agent's own cursor overlay was
being counted as a page change. Deferred to Phase C: expects inside
`input_sequence` steps and the `run_program` executor itself.

The executor can only auto-advance if a step can be judged **without asking
the model**. Build one verdict for every mutating call:

- `effect: changed | unchanged | n/a` — from a content-aware before/after
  comparison: pixel-diff of the two screenshots we already capture (region
  bounded), plus the export-HTML needle when a step declares one.
- Step-level `expect`: reuse `docs_op`'s `VerifyPlans` vocabulary
  (`export_contains`, `toolbar_style`, `dialog_open/closed`, `text_landed`)
  and expose it to every step type (C7).
- On `unchanged`: the harness itself tries **one** alternate route (ref
  instead of coordinate, keyboard instead of menu, Escape + reopen) and
  reports both attempts in one line. Only a second failure reaches the model.
- Keep `n/a` honest: css-only/animation-only changes must not claim success.

Files: `background/sw.ts` (`observeAfterAction`/`collapseRepeatObservation`
become verdict producers), `tools/perception.ts` (diff helper),
`shared/tool-failure.ts`, `shared/docs-ops.ts` (expect vocabulary), tests +
one smoke suite.

### Phase C — `run_program` (plan-as-data) — **SHIPPED 2026-10-07**

Status: the tool, the pure vocabulary/caps/validation, the executor on the gated
path, the prompt contract and the progress-note wiring all landed (905 unit
tests green; docs smoke D13–D14 pin a verifying program and a diverging one).
`docs/DEV.md` → "`run_program`" has the detail, including the three bugs the
fixture caught (expectations unchecked on non-observed tools, the collapsed
digest starving `text_landed`, and a run-start-only runner wiring). Not in this
pass: per-step expects inside `input_sequence` steps and the panel's sequence
grouping (the model already sees one card per program, which is the shape that
matters).

- New tool: `run_program({ steps: [...], note })`, steps from a small fixed
  vocabulary — `docs_op`, `menu_path`, `key`, `type`, `click` (by ref),
  `docs_locate`, `wait`, `assert` — each with an optional `expect`.
- Executor: sequential, per-step settle + Phase-B verdict, repair-once,
  **stop at the first unresolved divergence** and return: one compact line
  per step + the failing step's screenshot + what was expected vs found.
- Program cap (≤12 steps) with an `expect` required at least every 3 steps,
  so a bad program has a bounded blast radius.
- The closing `note` rides the existing `progress_note` event; the panel
  groups the program's cards as one sequence ("41 actions · 1 note").
- Prompt contract: "at each checklist-item boundary emit ONE program; you
  are consulted at exceptions, not per action."
- Expand the `docs_op` vocabulary for the benchmark's remaining hard items
  (cell background colour, font family/size, wrap + alt text, comments,
  sharing, named version) so a program is 1–3 steps, not 12.

Files: new `shared/program.ts` (pure schema + validation), new
`background/tools/program.ts`, `sw.ts` wiring, `agent/prompts.ts`, panel/log
grouping, `tests/program.test.ts`, smoke coverage.

### Phase D — plan-level state machine

- Todos become the run's **plan object**: exactly one `in_progress`, honest
  `blocked` with a one-line reason, and a per-item attempt budget.
- Loop rules: an item that fails N programs is **parked with its blocker**
  and the next item starts (no 100-retry grind); a final answer with open
  items is refused (§A6) unless the items are explicitly blocked.
- Jev moves to program boundaries only: grade the program's risk, pick
  effort for the whole program, verify the closing note (J5/J7) — one POST
  per program instead of one per action.
- Resume: persist the compacted checkpoint + plan, add an alarm-based
  liveness watchdog so a dead worker is visible in the panel and can resume
  (R8/P3) instead of the user discovering it and typing "continue".

Files: `agent/loop.ts`, `tools/todo.ts`, `background/policy.ts`,
`agent/jev.ts`, `background/sw.ts` (alarms + run state), panel.

### Phase E — the remaining field-test blockers

- **Image upload via CDP file-chooser interception**: enable
  `Page.setInterceptFileChooserDialog` (already used), but take the
  `backendNodeId` from the `Page.fileChooserOpened` event and call
  `DOM.setFileInputFiles` with it — works for inputs in **any** frame, which
  the current top-document `querySelectorAll` cannot see. Then a
  `docs_op insert_image` (upload → verify `<img` → size/wrap/alt text via
  the Image options sidebar). E spent ~65 turns (19 % of the run) here:
  By-URL is server-blocked in this environment, and paste is not consumed by
  the Docs canvas.
- **Harvest Docs' own shortcuts**: Google prints them in the menu rows
  ("CommentCtrl+Alt+M", "LinkCtrl+K", "HeaderCtrl+Alt+O Ctrl+Alt+H") — read
  them once per menu and prefer a single trusted `key` over a 3-step walk
  (R5). Also bake the style shortcuts (Ctrl+Alt+1…6, Ctrl+Alt+0).

### Phase F (optional, after measurement) — trace replay

Record the exact steps of a successful program as a named macro and replay
it for the next similar item (3 headings, 4 list types, 2 comments) with
Phase-B verification on every replayed step. Highest ceiling on repeat
tasks, highest risk if verification is weak — hence last.

---

## 4. Acceptance metrics (same 32-item benchmark, run solo)

| Metric | Now (D/E/F) | Target |
|---|---|---|
| turns for the full document | 250–351, incomplete | ≤ 120 |
| steps per completed item | ~20 | ≤ 6 |
| verify-only turns | 24 % / 30 % / 49 % | < 10 % |
| model-time share of wall | 65 % / 74 % / 67 % | < 40 % |
| wall clock, complete doc | 31 min (12/32) / 85 min (incomplete) | ≤ 15 min |
| items done first pass, no "continue" | 12/32 | ≥ 28/32 |
| silent worker deaths per 3 runs | 2 (E, F) | 0 |
| rework (undo/re-do/correction turns) | ~11 % (C baseline) | < 2 % |

Measurement rig: `scripts/runlog-stats.mjs` plus a `--bench` mode over the
32-item checklist that asserts each item against the exported HTML (C16), so
"items correct first pass" becomes a number instead of an impression.

## 5. Risks and non-goals

- **Stale knowledge → wholesale program failure.** Mitigated by A1 (verified
  map), per-step `expect`, stop-at-first-divergence, and the ≤12-step cap.
- **The executor hides recoverable failures.** Mitigated by repair-once in
  Phase B and always returning the failing step's screenshot + expectation.
- **Prompt-prefix growth.** `run_program`'s spec costs cached prefix tokens
  on every turn; weigh against turning 20 turns into 1. Keep the step
  vocabulary small and document it in the tool description, not the prefix.
- **Non-goals:** replacing the loop; a general planner DSL; parallel tool
  execution inside a program (actions are sequential and stateful); vision
  models for verification (pixel-diff + export needles are cheap and
  deterministic).
- Every phase lands with unit tests + `npm run typecheck` + `npm run build`,
  and the batch is handed back only after `npm run verify` is green.