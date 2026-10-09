# The plateau — why log-driven patching stopped paying, and every idea worth trying next

Written 2026-10-08 after reading the full commit history (61 commits, 2026-09-23 → 2026-10-08),
the seven existing plan docs in `docs/`, and the 90-run master log export
(`crazyagent-logs-2026-10-09T00-46-18-x90.md`, 13 MB, 5,079 turns, ~5,600 tool calls).

---

## 0. TL;DR

- **Two weeks of log → patch → rerun has not moved the headline number.** Across ~16 attempts at the
  32-item "Feature Test Document" benchmark, **none finished**. The best runs reached ~7 of 21 plan
  items; the latest (glm-5.3-flash) ran 87 min / 388 turns, was stopped by hand at ~14/32, and was
  still logged as `status: done`.
- Every individual fix was real and correct for the symptom it targeted. But the failure *distribution*
  just shifts: misclicks → silent no-ops → schema misuse → duplicated text → BLOCKED loops → ...
  The fixes are local; the problem is structural.
- **The codebase grew ~14:1 additive since Oct 1** (+25,528 / −1,840 lines). Prompt, skills, guard text
  and tool count all went up. On *flash-tier* models, more instructions and more tools is not free.
- **The logs can't answer "did this change help?"** There is no ground-truth grader, runs are N=1,
  the model changed three times mid-benchmark (deepseek → mimo → glm), status and plan checkboxes are
  self-reported, 2,117 screenshots aren't embedded, 3,437 results are truncated, and 35 runs have only
  estimated token counts.
- **The model lacks the senses the task needs.** 21 of 32 items are about formatting the model
  *cannot read through any text tool* (font family, size, color, highlight, wrap, merge, caret,
  selection). So it writes its own perception: `evaluate_js` is the **#1 tool (950 calls)**, mostly
  `querySelectorAll` + `innerText` scraping, and 34% of all turns only observe.
- **The model edits blind to caret/focus**, so text goes into the wrong place → duplicates → a tangled
  doc → "rebuild". "duplicat" appears 381× in reasoning; `Escape` (159) and `Ctrl+Z` (52) are the
  two most-pressed keys.

The ideas in §5 split into: *measure properly first*, *give the model senses*, *change the unit of
editing*, *shrink the interface*, and some genuinely crazy ones.

---

## 1. What has been tried (the commit history, grouped)

| Era | Dates | What it attacked | Representative commits |
|---|---|---|---|
| Foundation | 09-23 → 09-25 | tools, CSP-safe `evaluate_js`, frames, trusted typing into canvas editors, Jev sidecar, lessons coach | `b22787c`, `03c8abb`, `49130f8`, `0b973fc`, `eb71dc6`, `4753428` |
| Speed I | 09-29 → 10-02 | round trips, prompt-cache prefix, thinking budget, image re-sends, wait_for, skills | `2682a6e`, `4ff7faf`, `b8a07ea`, `863c586` |
| Input accuracy | 10-03 → 10-04 | click accuracy, `type_at`, zoom, `input_sequence`, screenshot-space coords, menus by ref | `7bc0a2e`, `5466da7`, `c748634`, `e761624`, `3e8caaf` |
| Docs knowledge as code | 10-05 → 10-06 | own agent window, live plan, human-flow layer, enforced failure ladder, `docs_op` | `d3e4eee`, `0edf4da`, `79e7bba`, `8861fa5` |
| Verification & programs | 10-06 → 10-07 | effect verification (`expect`), `run_program` (plan once, execute many) | `5ec2306`, `ddb31dc` |
| Efficiency & Docs tools | 10-06 → 10-08 | panel throttle, bounded runlog, `docs_table`, marks, docs-structure | `2fa2a59`, `063192d`, `1de7b97` |

Plan docs written along the way: `SPEED-BRAINSTORM`, `CORRECTNESS-BRAINSTORM`, `HUMAN-FLOW-PLAN`,
`LOOP-PLAN`, `input-layer-plan`, `gdocs-cursor-plan`, plus the long run-analysis sections in `DEV.md`.
**LOOP-PLAN §4's acceptance metrics (≤120 turns, ≥28/32 first pass, ≤15 min) have not been approached.**
LOOP-PLAN Phase D (plan-level state machine) and the `--bench` grader (C16) were never built.

Also solved along the way and worth not re-litigating: prompt caching works (≈89% cached on the
upgraded key, TTFT p50 ~1.3 s); the 370 s scroll anomaly is gone.

---

## 2. What the 90-run log actually says

### 2.1 Outcomes

| Run (line in export) | Model | Turns | Wall | Plan items done |
|---|---|---|---|---|
| L1 (latest) | glm-5.3-flash | 388 | 87m | 0 ✓ / 1 ~ / 20 open (user stopped; ~14/32 actually present) |
| L11541 | glm-5.3-flash | 203 | still "running" | 0 / 1 / 11 |
| L20038 | glm-5.3-flash | 147 | 17m | 3 / 1 / 11 |
| L24132 + 3× continue | deepseek-v4.1-flash | 150+94+30 | ~38m | 2 / 1 / 12 |
| L43780 | mimo-v2.6-flash | 39 | 21m | 0 / 1 / 30 |
| L51188 + 2× continue | deepseek-v4.1-flash | 233+107+341 | >66m | 3 / 1 / 15 |
| L90635 + continue | deepseek-v4.1-flash | 250+201 | >31m | 7 / 1 / 15 → 7 / 1 / 4 |
| L112345 | deepseek-v4.1-flash | 223 | 29m | 5 / 1 / 8 |

The plan checkboxes are self-reported and often stale (the latest run's plan says 0 done while the doc had
~14 items), so even this table is an impression rather than a measurement. That is itself finding #1.

### 2.2 Tool usage across all 90 runs

| Tool | Calls | Failed | Note |
|---|---|---|---|
| **evaluate_js** | **950** | 54 | #1 tool. 507× `querySelectorAll`, 428× `innerText` → the model is building its own perception |
| click_at | 706 | **117** | 62 failures = **x/y missing from the call** (61 of them glm-5.3-flash) |
| key | 489 | 11 | top keys: Escape 159, Ctrl+Z 52, Enter 48, Backspace 37, Ctrl+A 33 |
| input_sequence | 484 | 21 | |
| screenshot | 448 | 1 | plus auto-attached: 2,738 screenshots total in the log |
| click | 346 | 9 | |
| docs_locate | 293 | 0 | "never fails", yet select→type duplicated text in the latest run: success ≠ effect |
| type | 254 | 13 | |
| menu_path | 95 | **27** | disabled rows, rows not found (TOC, Table, Page elements) |
| docs_op | 55 | **26** | ~47% failure |
| docs_table | 52 | **27** | ~52% failure |
| **run_program** | 33 | **29** | **88% failure** ("program STOPPED at step N", "steps is limited to N") |
| type_at | 41 | 16 | |

### 2.3 Turn classification (5,079 turns)

- **56%** acted (≥1 successful non-observation call)
- **34%** only observed/planned (screenshot, snapshot, docs_read, evaluate_js reads, todo_write, skills)
- **8%** had a failed call
- Guard firings: 77 `BLOCKED — NOT EXECUTED`, 37 `RETRY WARNING`, plus `STUCK` warnings. In the latest run
  the guard blocked `{"op":"apply_style","cols":0}` **five turns in a row**, while the model's own reasoning
  each turn said "use style:'Title'". The model *intended* the right call; the emitted args were wrong.

### 2.4 Error classes

| Class | Count | Dominant cause |
|---|---|---|
| UNKNOWN-FAILED | 108 | 62× "parameter x/y must be a finite number"; 9× steps limit; 6× bad step shape; 7× not typable |
| INPUT-FAILED | 63 | schema misuse (e.g. `apply_style` without `style`) |
| TOOL-FAILED | 53 | `run_program` stopped (15), page setup field not found (9), menu rows missing/disabled |
| INJECTION-FAILED | 23 | content script not running at the point |
| TRANSPORT-FAILED | 14 | CDP `Failed to fetch` (8), focus refusal |

### 2.5 Rework language in reasoning (3,725 reasoning blocks)

"didn't" 936 · "duplicat" 381 · "wrong" 454 · "undo" 546 · "let me check" 1,548 · "verify" 2,214.
The canonical failure chain, seen many times:

> type lands in the wrong place (focus in find bar / title box / comment box, or the selection wasn't what
> `docs_locate` claimed) → duplicated runs ("This document is a hands-on tour of" ×4) → repair attempts
> make it worse → "The document is a catastrophic tangle" → rebuild → the clock runs out.

---

## 3. Why log-driven patching plateaued

1. **Symptom-level fixes on a shifting distribution.** Each run surfaces its top 3 failures; each patch removes
   them; the next run surfaces the *next* 3. With ~32 item types × several routes × several models, the tail
   is long. Progress per patch is real but small, and run-to-run variance is bigger than the effect.
2. **No instrument that measures the goal.** There is no automated per-item grader. "Better" is judged by reading
   a 13 MB log. N=1 per change, three different models, different prompts across runs. You cannot tell a 10%
   improvement from noise this way, so you can't tell which of the last 20 changes helped, did nothing, or hurt.
3. **Additive-only growth.** +25.5k / −1.8k lines in a week. 52 tools; `loop.ts` 74 KB, `skills.ts` 29 KB,
   `prompts.ts` 25 KB; first-turn context 13–20k tokens before any page content. Each guard adds prose
   the model must read ("[BLOCKED — NOT EXECUTED: …]" is ~90 words). Flash models degrade with instruction
   load and tool count. Some fixes probably cancel others out, and nothing has been removed to check.
4. **The model is missing senses, not knowledge.** The skills say *how* to set a font; nothing lets the model
   *read* the font. `docs_read` returns style + bold/italic/link; `docs_state` reports `unreadable: fontSize`
   and nothing about color, highlight, caret position, selection extent, or which input has focus.
   So "did it work?" needs screenshots + hand-written JS, which explains the 34% observe-only turns.
5. **Editing is stateful, but the model sees state only through snapshots.** Docs editing is a caret/selection/focus
   state machine. The model guesses that state from stale screenshots, so `type` lands somewhere unexpected.
   Every duplicate-text tangle starts here.
6. **The JSON tool-call interface is lossy on these models.** Large tools with many optional props
   (`click_at`: x/y OR ref+dx/dy OR frame; `docs_op`: one tool, many ops, many optional fields) let the
   model emit a valid-looking call with the essential field missing. Whether that's the model, the
   provider's tool-call parser, or schema conversion is **unknown, because the raw wire response isn't logged**.
7. **The guards punish instead of repair.** The stuck guard correctly refuses a third identical bad call,
   but it hands the model a paragraph of advice instead of the fix ("your call is missing `style`; you
   said Title in your reasoning — did you mean `{op:'apply_style', style:'Title'}`?"). The result is 35+ wasted turns.
8. **One unit of work per turn.** Even with `input_sequence`/`run_program`, the model mostly does
   one action → look → one action. `run_program` was the structural answer and it fails 88% of the time,
   so it's effectively off.
9. **Model tier.** Every benchmark run used a flash-tier model. We have never measured the harness's
   ceiling with a frontier model, so we don't know whether we're fighting the harness or the model.

---

## 4. Are the logs good enough? No. Here is what's missing

| Gap | Evidence | Why it matters |
|---|---|---|
| Screenshots not embedded | 2,117 `[screenshot attached, …base64]` placeholders | You can't see what the model saw when it decided |
| Results truncated in export | 3,437 `…[truncated]` | The deciding detail is often past the cut |
| No raw wire request/response | — | Can't tell if missing `x`/`style` is model, provider parser, or our schema |
| No ground-truth doc state per turn | — | "What changed in the doc this turn?" is unanswerable after the fact |
| No caret / selection / focused element per turn | — | The root cause of the duplicate tangle is invisible |
| Status lies | latest run `status: done` after a manual stop at ~14/32 | Dashboards built on it mislead |
| Plan checkboxes self-reported | 0 ✓ shown, ~14 items actually present | Progress can't be read from the log |
| Tokens estimated | 35 runs "provider reported no usage" | Cost/caching numbers unreliable; runlog-stats misreports cache |
| No prompt/tool-schema hash per run | — | Can't diff "what changed between run A and run B" |
| No per-item ledger | — | Can't say "tables cost 60 turns, comments cost 8" |
| No failure labels | — | Rework vs verify vs progress has to be inferred by grep (as done above) |
| Continues are separate runs | "continue" ×12 | One attempt is spread across 2–4 log entries |

---

## 5. Ideas

Legend: **[C]** conventional · **[X]** crazy · ⚠ needs config/consent (check against the zero-config rule) ·
★ highest expected value per effort.

### 5.1 Measure before changing anything else

1. ★ **[C] Automated 32-item grader.** After a run, fetch `/document/d/<id>/export?format=html` (and `?format=docx`)
   from inside the tab using the user's session (no OAuth) and assert each item: title style + font,
   Letter/1", fonts per run, bold/italic/underline/color/highlight, H1×3, list types, page break, 3×4 table +
   header bg + merge, image + wrap + alt, hr, link, TOC, header/footer, equation, bookmark + link, comments
   (via the export or the comments panel DOM), suggestions, sharing, named version. Output: a 32-bit score.
2. ★ **[C] Micro-benchmarks.** Split the 32 items into 32 independent tasks, each starting from a fixture doc
   (copy a template doc per run). Measure success rate and cost *per item*, N=5 each. A change helps if it
   moves the per-item matrix, not if one long run "felt better".
3. ★ **[C] Ceiling test.** Run the benchmark once each with a frontier model (Claude / GPT / Gemini class) on the
   same harness. If it gets 30/32, the harness is fine and the problem is model tier, so invest in routing.
   If it also stalls, the harness is the problem. This is the single most informative experiment not yet run.
4. **[C] Floor test.** Hand-write the ideal tool-call script for all 32 items and replay it with no model.
   That's the harness-only time and reliability. Any item the replay can't do is a *capability* gap, not a model gap.
5. **[C] Fix the model per comparison.** Pin one model + one prompt hash per A/B; N≥3; report median + spread.
6. **[C] Regression bank.** Every observed failure becomes a fixture + expected outcome, replayed in CI against
   the mock LLM (`scripts/mock-llm-server.mjs`) with recorded model outputs.
7. **[C] Cost-per-item ledger** in runlog-stats: turns, wall, tokens, rework turns per checklist item.
8. **[X] Nightly autopilot benchmark.** Cron the benchmark on a fresh doc, grade it, and post a single line:
   `score 19/32 · 142 turns · 24m · build abc123`. Watch a trend instead of reading logs.

### 5.2 Make the logs answer questions

9. ★ **[C] Raw wire capture.** Log the exact streamed tool-call deltas and the final pre-parse JSON per call.
   This resolves the missing-`x` / missing-`style` mystery in one run.
10. **[C] Embed screenshots** as thumbnails in an HTML export (or write them as files next to the `.md`),
    with a click-to-zoom timeline. Keep the base64 out of the markdown.
11. **[C] Untruncated export mode** (JSONL + blob directory) for analysis; keep the truncated `.md` for skimming.
12. ★ **[C] Per-turn doc diff.** After each mutating call, cheaply snapshot the doc text+styles (export or
    `docs_read`) and log the diff: `+ "Section Two" (H1)`, `~ run 3 font Arial→Roboto`. Rework becomes obvious.
13. **[C] Per-turn editor state line:** caret location (paragraph index + nearby text), selection extent,
    focused element (body / title / find bar / comment box / dialog), open menus/dialogs.
14. **[C] Honest status:** `completed | stopped-by-user | budget-exhausted | crashed | still-running`, plus the grader score.
15. **[C] Stitch continues** into one logical attempt with a cumulative timeline.
16. **[C] Prompt + tool-schema hash** and enabled-feature flags stamped on every run.
17. **[C] Auto-label every turn** (progress / verify / rework / blocked / malformed) by rules, and emit the shares.
18. **[X] Video replay.** Record the agent window (tabCapture → webm) with tool-call subtitles burned in.
    Ten minutes of watching may beat hours of grep.
19. **[X] LLM post-mortem.** Feed the stitched log to a strong model offline: "list the 5 decisions that cost the
    most turns, with turn numbers and the counterfactual move". Use it to rank work, not as truth.

### 5.3 Give the model senses (perception)

20. ★ **[C] Rich `docs_read`.** Per-run formatting in the outline: `[font=Roboto 11 color=#1155cc hl=yellow]text[/]`,
    plus tables (cells, merges, bg), images (size, wrap, alt), page breaks, headers/footers. Source: the HTML export
    parsed in the harness (one fetch, cached, invalidated on mutation). Most of the 950 `evaluate_js` scrapes go away.
21. ★ **[C] Caret & selection in every action result.** `caret: end of P3 "...one place.|" · selection: none ·
    focus: document body`. Make it impossible to type without knowing where.
22. **[C] Full `docs_state` coverage:** font size, text color, highlight, line spacing, list type, alignment, link at caret.
    Today fontSize is "unreadable".
23. **[C] Before/after screenshot diff image:** highlight changed pixels in red, so "did it work?" is one glance.
24. **[C] Auto-crop around the action point** at 2× zoom attached to coordinate actions (the toolbar font box,
    the style dropdown) instead of the full 1280×720 frame.
25. **[C] Set-of-marks by default** (marks shipped in `1de7b97`): every screenshot carries numbered boxes tied to refs.
26. **[C] Per-model vision flag.** There's no capability flag; confirm each endpoint actually consumes images. If one
    doesn't, 2,738 screenshots are dead weight there.
27. **[C] Docs screen-reader / braille mode.** Turning on Tools ▸ Accessibility ▸ Screen reader support makes Docs
    keep an accessible text mirror and announce formatting changes. Read that instead of the canvas.
28. **[C] CDP accessibility tree** (`Accessibility.getFullAXTree`) as a perception source on canvas apps once a11y mode is on.
29. **[X] Read the editor's own model.** Docs keeps the document model in page JS; a stable read hook via
    `evaluate_js` would give exact runs/styles. Fragile across Docs releases; worth a spike, not a dependency.
30. **[X] Separate vision verifier.** A small VLM answers yes/no questions ("is the title Playfair Display?",
    "is row 1 shaded?") from a crop. The main model never parses pixels.

### 5.4 Change the unit of editing (biggest structural lever)

31. ★★ **[X→C] Paste the document as rich HTML.** Build the whole body as HTML (Title/Subtitle/H1, Playfair/Roboto/
    Merriweather/Roboto Mono via inline `font-family`, sizes, bold/italic/underline, `color`, `background-color`
    highlight, numbered/bulleted lists, the 3×4 table with header bg and `colspan` merge, `<hr>`, `<a href>`,
    page break via `page-break-before`) and paste it through the offscreen clipboard (`text/html`).
    Docs preserves most of it. That's ~15–18 of 32 items in **one call**, built correctly by construction.
    Do the rest (TOC, header/footer, equation, bookmark, checklist, image wrap, comments, suggesting, sharing,
    version) through the UI. Zero-config. Spike this first: one afternoon tells you which items survive the paste.
32. **[C] Edit ▸ Paste from Markdown / Markdown autodetect** as a lighter variant for structure (headings, lists, links).
33. **[X] Upload-and-convert.** Generate a `.docx` locally (headers/footers, page numbers, TOC field, bookmarks, merged
    cells, wrapped image, page size/margins), drop it into Drive, open as Google Docs. Most of the document in one
    shot. Open question: does "create a new doc" accept a converted upload? If yes, it's the fastest route.
34. ★ **[C] Format-then-type `docs_write`** (the user's "build bit by bit" rule): input is a block spec
    `[{style:'Title', font:'Playfair Display', size:28, text:'Feature Test Document'}, {style:'Subtitle', text:'October 8, 2026'}, …]`;
    the harness sets style/font/size *before* typing each block, verifies each block, and returns the diff.
    The model plans the document as data, so no select-and-reformat and no duplicate tangles. Also fix the
    `shared/skills.ts` "write" section, which currently says "whole block in ONE call" (type everything, then format).
35. **[C] Recipes for all 32 items, tested in isolation.** `docs_op` already holds some knowledge as code; push it to
    full coverage and give each recipe a micro-benchmark success rate (5.1 #2). Delete recipes below 90%.
36. **[C] Per-item checkpoint + revert.** Before each item, note the revision; if the item fails, revert (undo stack /
    version history) instead of repairing a tangle.
37. **[C] Rebuild-from-spec as a first-class op:** if the body diverges from the spec, select-all-delete and re-emit
    from the spec (or re-paste the HTML) in one call. Today the model hand-repairs duplicates.
38. **[C] Focus guard on `type`:** refuse no-ref typing when focus is in a find bar / title box / dialog the call
    didn't intend, and say where focus is.
39. **[X] Record once, replay forever.** Record a human doing each of the 32 features once (CDP input events + DOM
    targets), compile each to a parameterised program, and have the model only pick which program to run with which text.
40. **[⚠ X] Apps Script route.** Extensions ▸ Apps Script → a bound script can set fonts, tables, headers, bookmarks
    deterministically. It needs an in-browser OAuth consent click (the agent can click it; no GCP project). Quantify
    the speed win before considering it, per the zero-config rule.

### 5.5 Shrink and harden the interface

41. ★ **[C] Split ambiguous tools so required fields are actually required.** `click_xy {x,y}` vs `click_ref {ref}`;
    `docs_style {style}`, `docs_font {font,size}`, `docs_color {color}` instead of one `docs_op` with every field optional.
    Required-in-schema beats required-in-prose.
42. ★ **[C] Repair, don't block.** On a malformed call, try to repair it from the model's own reasoning (Jev or regex:
    reasoning says "style:'Title'", args lack style, so fill it and execute, noting the repair). If not repairable, return a
    one-line corrected example, not a paragraph.
43. **[C] Re-ask in the same turn.** On schema-invalid args, re-prompt for just the tool call (tiny context, no screenshot)
    instead of burning a full turn.
44. ★ **[C] Tool diet.** 52 tools → ~15 for the Docs profile. Hide network_*, bookmarks, topsites, handoff, etc. per task.
    Measure with the micro-benchmarks whether accuracy rises.
45. ★ **[C] Prompt diet / subtraction sprint.** A/B the current prompt+skills against a stripped version (no guard prose,
    no long playbooks). Delete any rule that doesn't move the per-item matrix. The goal is fewer lines.
46. **[C] Fix or delete `run_program`.** 4/33 success. Either make steps forgiving (aliases, auto-split >N steps, verify per
    step and continue on soft failure) or remove it so the model stops paying to try it.
47. **[C] Fix or delete `docs_table` and `menu_path` failure modes:** ~50% and ~28% failure. Disabled-row errors mean the
    caret is in the wrong place, so precondition-check ("caret must be inside a table") and auto-fix the precondition.
48. **[C] Disable click PROMOTE/snap on known pickers** (Docs table grid, split toolbar buttons). It's wrecking them (latest run).
49. **[X] Code-as-action (CodeAct).** Let the model write a short JS program against a typed `docs.*` / `page.*` API that runs
    in the harness, instead of JSON tool calls. Models are often better at code than at large JSON schemas, and one
    program = many actions with real control flow (`if (!docs.state().bold) docs.key('Ctrl+B')`).
50. **[X] Grammar-constrained decoding** where the provider supports it (JSON schema strict mode), so a call missing
    `x` cannot be emitted at all.

### 5.6 Loop and planning

51. ★ **[C] Item-level state machine (LOOP-PLAN Phase D, unbuilt).** The harness owns the checklist; each item is
    pending → doing → verified-by-grader → done. The model never self-marks done; the grader does.
52. **[C] Per-item budget:** N turns / M seconds per item, then mark blocked and move on. Come back at the end.
53. ★ **[C] Fresh context per item.** Each item runs with a short context: system + doc summary (from rich `docs_read`)
    + the item + its recipe. Long 388-turn contexts on flash models degrade; this also keeps the cache prefix stable.
54. **[C] Planner / executor split.** One call to a strong model writes the full per-item plan (and the HTML of 5.4 #31);
    the flash model just executes and recovers. Cheap: one big call, not 388.
55. **[C] Order items by dependency and risk:** body content first (paste), then structure (TOC, header/footer,
    bookmark), then collaboration (suggesting, comments, sharing, version) last, since those can't tangle the body.
56. **[C] Few-shot trajectories.** Put 3–5 short successful item traces in the cached prefix ("here is how H1 + font
    + verify looked when it worked"). Flash models imitate better than they follow rules.
57. **[C] Temperature 0 / deterministic sampling** for executor turns, which reduces run-to-run variance and makes A/Bs readable.
58. **[C] Stop auto-continuing on "continue".** Resume from the item state machine, not a fresh conversation that re-reads everything.

### 5.7 Model strategy

59. **[C] Route by step type.** Frontier model for planning, recovery after 2 failures, and verification judgments;
    flash for routine execution. Price the mix against the wall-clock win.
60. **[C] Per-model quirk table.** glm drops numeric args, deepseek ignores the thinking-off knob, mimo is a third case.
    Encode per-model adapters (schema style, reasoning cap, retry policy) instead of one prompt for all.
61. **[C] Always cap reasoning client-side**, regardless of thinking level (the cap is 0 = unlimited when thinking is
    "off", per the 2026-10-08 analysis), plus a per-attempt wall-clock abort.
62. **[X] Distil our own executor.** Successful traces from the micro-benchmarks → LoRA a small open model on
    "screenshot + state → next tool call" for Docs. Heavy, but it's the end state of "knowledge as code".

### 5.8 Genuinely crazy

63. **[X] Parallel speculative tabs.** The agent has its own window, so try three strategies for a hard item in
    three copies of the doc at once, grade each, and keep the winner's route (or copy its result).
64. **[X] Self-play curriculum.** Overnight, generate random Docs micro-tasks, run them, grade them, and mine
    successful traces into skills/lessons automatically. The lessons coach already exists; feed it graded data instead of failures.
65. **[X] Two-agent watch-and-correct.** An actor acts; a critic watches only the before/after diff and vetoes or
    corrects in parallel, off the critical path.
66. **[X] Docs voice-typing commands.** Docs voice typing understands "apply heading 1", "select paragraph", "bold".
    Feed it synthesized speech as a fake mic. Absurd, but deterministic and coordinate-free.
67. **[X] Make the task smaller than the UI.** For each item, ask "is there a URL / keyboard shortcut / paste that does
    this with zero clicks?" (e.g. sharing via the share dialog's link field, named version via File ▸ Version history
    shortcut, find/replace via Ctrl+H). Build a shortcut table and bias the model to it.
68. **[X] Invert the loop: the harness drives, the model advises.** A deterministic Docs script runs the 32 recipes;
    the model is called only when a recipe's post-check fails, with a tiny context ("recipe X failed, here's the
    crop, pick a fix"). Model calls drop from ~390 to perhaps ~20.
69. **[X] Delete half the codebase on a branch** and benchmark it against main with the grader. If the smaller
    harness scores the same, it's the better base.

---

## 6. If only five things, in order

1. **Build the grader + micro-benchmarks** (5.1 #1–2). Without it, nothing below can be shown to work.
2. **Run the ceiling test** (5.1 #3). It tells you whether to fix the harness or route around the model.
3. **Capture raw wire tool calls + per-turn caret/focus/doc-diff** (5.2 #9, #12, #13). That turns the two biggest
   mysteries (dropped args, duplicate tangles) into facts.
4. **Spike the rich-HTML paste** (5.4 #31). If ~15 items land in one call, the benchmark changes shape overnight.
5. **Subtraction sprint** (5.5 #41, #44, #45, #46): split ambiguous tools, cut the tool list for the Docs profile,
   strip guard prose, fix-or-delete `run_program`, all measured on the micro-benchmarks.
