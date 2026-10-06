# Correctness brainstorm — why the agent does the wrong thing, and how to prevent it

Companion to `SPEED-BRAINSTORM.md` (idea ids J*/R*/T*/… referenced here).
Evidence base: the three 2026-10-06 runs (A/B/C, same 32-item Google Docs
"Feature Test Document" task). This doc: (1) the measured error taxonomy,
(2) root causes, (3) a four-layer prevention plan with stable ids (C*),
(4) quick wins.

## 1. What actually goes wrong (from the logs)

Rework share: ~11 % of C's 351 turns are *demonstrably* rework (failed call,
retry/stuck warning, or correction language in thinking). The real number is
higher — silent no-ops discovered several turns later don't show up as
corrections at the moment they happen.

**E1. Pixel-level misses on the canvas.**
- C t11: "I hit the wrong item (the menu shifted). Reopening File menu."
- C t123: "Menu click missed."
- C t330: "The click missed (hit the card body). Clicking the checkmark icon precisely."
- C t216: "Page numbers landed in the header again. Undoing and retrying with the footer layout."
- B t47: "Coordinates were off by ~20px."
- A t69: "The crop missed the font box."
- A t36/t136: `point (1164,83) is outside the visible viewport (1046x693)` — screenshot-space vs viewport-space mismatch, twice.

**E2. Silent no-ops, discovered late.** The action "succeeds" (the click
landed somewhere), but the intended effect didn't happen, and nothing checks
until the model volunteers to look:
- B t19: "Title style didn't apply (toolbar still shows Normal text)."
- B t211/t215: "The image insertion didn't land… the fill didn't apply."
- A t33/t46: "Clipboard paste didn't land. Retrying… this time waiting for Google to fetch the image."
- B t92: table cell "text didn't land".

**E3. Repeated tool-schema misuse — the same error several times per run.**
- B hit `steps[N] needs one of click / hover / key / type / wait_ms` **four
  separate times** (t33, t59, t94, t142) — the model never internalized the
  step shape within the run.
- B t74: `steps is limited to 24 (got 36)`.
- B t83: passed a whole sentence to a `key` step (`no key mapping for "Normal paragraph text…"`).
- B t128/t174, A t134: `type` on a `<div>` ("not typable") — the Docs comment
  composer / canvas sink confusion, 3×.
- B t165: `upload` with a div ref instead of the file input.
- C t166: stale ref.

**E4. Environment-quirk dead ends.**
- C: `TRANSPORT-FAILED: TypeError: Failed to fetch` on evaluate_js at
  t61, 103, 129, 132, 134, 136, 141, 161 — the CDP debugger flapped **all
  run long**, and each failure cost model turns to diagnose ("The debugger
  link dropped. Reloading the tab…" t62). A and B hit it too (2× each).
- C t52/53/88/89: `TrustedHTML` violations — Docs' CSP forbids
  `innerHTML`/`DOMParser`; the model tried variations 4× before giving up.
  Nothing in the harness knows this quirk; the skill mentions transport
  recovery but not Trusted Types.

**E5. Unintuitive routes (the user's "it does it in an unintuitive way").**
- Verifying state by exporting the doc (`fetch …/export?format=html`) when
  the toolbar (style dropdown = "Normal text" vs "Title", font box, save
  indicator) is plain DOM already in every snapshot — the export is slower,
  breaks whenever the debugger flaps (E4), and B t222 ends the run mid-
  confusion between "export" and "live editor" approaches.
- Image insertion via clipboard paste (flaky, account-dependent — A t33/t46,
  B t211/t215 all failed with it) instead of Insert ▸ Image ▸ Upload from
  computer, which the harness can do deterministically (`upload` intercepts
  the OS picker — already built!).
- Coordinate-clicking menu rows that have refs (the skill says "menus are
  DOM — click rows BY REF" and the model still misses: E1).
- Hunting the font in the toolbar box / crops (A t69) instead of the
  More-fonts search dialog.
- Page numbers via header double-click guessing (C t216) instead of
  Insert ▸ Page numbers ▸ Bottom of page.

**E6. Verification churn.** The unchanged-page collapse fired A 15×, B 22×,
C 33× — the model re-reads the page constantly because it isn't sure its
actions landed (E2 with no same-turn feedback).

## 2. Root causes

1. **Open-loop actions.** An action executes, an observation returns, but
   nothing compares *intended effect* vs *actual effect*. Errors surface only
   when the model happens to look — turns later, after wrong state compounded.
2. **Knowledge is prose.** The `canvas-doc-editors` skill is genuinely good,
   but every run the model must re-translate prose → pixel sequences under
   time pressure. Translation is where E1/E5 happen. The knowledge exists;
   the *execution* is re-derived from scratch 350 times.
3. **Coordinate-first habits on a mostly-DOM UI.** Menus, toolbars, dialogs,
   sidebars, comment cards are DOM with refs; only the document body is
   canvas. Pixels are used where refs would be deterministic.
4. **Schemas learned through runtime errors.** E3's repeated failures are
   each a full round trip; the error text teaches the model, but the lesson
   doesn't stick within a run (B: same error 4×).
5. **Quirks surface as raw errors, not handled behavior.** E4: the harness
   knows how to reload a tab and re-attach; it makes the model spend turns
   deciding to do that.

## 3. The prevention plan — four layers

### Layer 1 — Deterministic Docs ops: knowledge as CODE ("know everything about the Docs interface")

**C1. `docs_op` — a semantic macro tool.** ~20 named operations covering the
families the benchmark (and real usage) needs, each implemented as: menu-DOM
walk by label path + keyboard shortcut + built-in effect verification + one
retry. The model supplies intent and arguments — never pixels:

```
docs_op {op:"page_setup", size:"Letter", margins:"1", orientation:"portrait"}
docs_op {op:"apply_style", style:"Title"}            // caret/selection-aware
docs_op {op:"insert_table", rows:4, cols:4, header:true, header_bg:"#efefef", merge:"A5:D5"}
docs_op {op:"page_numbers", position:"footer"}
docs_op {op:"insert_image", source:"shelf:shot_3" | url | paths}
docs_op {op:"comment", anchor:"selection", text:"…", mention:"a@b.com", resolve:true}
docs_op {op:"name_version", name:"v1 — complete"}
docs_op {op:"share_link", access:"anyone", role:"commenter", return_link:true}
docs_op {op:"find_replace", find:"…", replace:"…"}
docs_op {op:"set_font", family:"Playfair Display"}   // More-fonts dialog + search box
docs_op {op:"heading"|"list"|"page_break"|"toc"|"equation"|"suggesting_mode"|"header_footer_edit" …}
```

Each op kills an entire observed error class: page_setup (C t216 header/footer
confusion), set_font (A t69 crop-missed font box), insert_image (E2/E5 paste
failures), apply_style (B t19 "toolbar still shows Normal text" — the op READS
the toolbar after acting and reports `verified: style=Title`). This is also a
speed win: one call replaces a 3–8 turn menu walk (see R4, J15 in the speed
doc). Ops are where "everything about the Docs interface" lives — as executed
code, not remembered prose.

**C2. `menu_path` — the generic walker for everything not in the op library.**
`menu_path {path:["Format","Table","Table options"]}` → opens each level by
label, resolves rows BY REF from the live DOM, returns the opened dialog's
snapshot. Enforces "menus are DOM" mechanically instead of by prompt rule.
Works on any web app, not just Docs. Optional final `{click:"OK"}`.

**C3. `docs_state` — the ground-truth reader.** One cheap call returning:
doc title, save indicator, caret/selection text (a11y layer), applied
paragraph style + font + size + bold/italic (toolbar DOM), list state, table
dims, comment threads + resolved state, share setting, named versions,
header/footer contents, page count. Sources: DOM chrome + accessibility tree
+ (only as fallback) export fetch. This replaces both the export-verify habit
(E5) and most vision verification (E2/E6): verification becomes a text diff
against expectations. The snapshot already contains toolbar text ("Normal
text Arial Editing" — visible in every observation); `docs_state` parses it
into fields so nothing has to be eyeballed.

**C4. Structured interface knowledge as data.** Ship a `docs-knowledge.json`:
full menu tree (every menu → every row → dialog flows), every keyboard
shortcut, quirks table (Trusted Types blocks innerHTML/DOMParser; debugger
transport flaps — reload once; font list is virtualized — use More-fonts
search; comment = Ctrl+Alt+M, mention chip, Ctrl+Enter; page numbers live
under Insert ▸ Page numbers, NOT header double-click; paste-insert is
account-blocked → use Upload from computer). Consumed by C1/C2/C3 at runtime;
the skill body shrinks to a pointer + the human playbook (C14). Bonus: the
menu tree is *discoverable* — a maintenance script can crawl the live DOM
(open each menu, record rows) and diff against the shipped file when Google
redesigns.

**C5. Trace compiler → op macros.** B and C contain successful segments for
every checklist family. Extend the coach (or a sibling compiler pass, cf. R1)
to lift verified segments into new `docs_op` macros / skill sections with
postconditions. Failed segments feed the quirks table (C4) as host-scoped
lessons pinned at the top of Docs runs (the lessons + host-pin machinery
already exists).

### Layer 2 — Effect verification: catch wrong actions IN THE SAME TURN

**C6. Declared effects + automatic checks on every mutating action.**
The harness knows each action class's expected footprint:
- typing → text appears (a11y/export/pixel-region changed),
- menu click → a menu/dialog is now open (DOM check),
- style/format → toolbar value changed (DOM read),
- any canvas action → *something* changed (before/after pixel diff of the
  auto-attached screenshot — the shots are already being taken!).
Append one verdict line to the result: `[effect verified: dialog "Page setup"
open]` or `[⚠ no visible effect — the click may have missed]`. This converts
E2 ("didn't land", discovered 5 turns later) into same-turn feedback and
should cut the E6 re-reading churn substantially.

**C7. `expect` parameter on coordinate actions.** `click_at {x,y,
expect:"Comment checkmark"}` → harness compares element_at/DOM/pixel-region
at the point BEFORE clicking; mismatch → don't click, return what IS there
plus the nearest match: `[at (980,412): comment card body; "Comment"
checkmark is 14px above at (980,398) / ref 44 — click that instead]`. C t330
("hit the card body") becomes a corrected click with zero wasted turns. Same
for `type_at` (expect the caret to land in an editable region) and per-step
inside `input_sequence` (checkpoint: sequence STOPS at the first failed
expectation instead of blindly running all 24 steps and leaving the doc
half-broken — cf. R3's checkpoints).

**C8. Auto-undo path.** When C6's verdict says "wrong effect" (something
changed, but not what was asked), offer/execute Ctrl+Z + report
`[reverted; the click landed on X]`, so bad state never compounds. C t216
built page numbers into the header and worked several turns before undoing.

**C9. Jev verification rides the existing gate POST** (millisecond cost):
pre-action "is this the right target for the intent?" (J6), post-action
"did the effect happen / is the item done?" (J5/J9/J10 in the speed doc).
Semantic backstop for everything C6's deterministic checks can't express
(e.g. "is this the RIGHT table style").

### Layer 3 — Harness-enforced grounding: make the intuitive route the only route

**C10. Coordinate→ref promotion.** If the click point is covered by a DOM
element with a ref (menus, dialogs, toolbars, comment cards), `click_at`
executes as `click(ref)` — deterministic hit — and says so in the result
(the hit report `clicked (103,22) — <input> ref 2` already exists; promotion
makes the ref the *execution path*, not just a footnote). Coordinates remain
free-form only where nothing has a ref: the canvas body. E1-on-DOM becomes
impossible.

**C11. Viewport auto-fix.** Point outside the viewport (A t36/t136): scroll
it into view and proceed (or remap screenshot-space coords against the
current scroll) instead of burning a turn on an error.

**C12. `input_sequence` auto-repair.** Accept the common wrong shapes and
normalize: `{click:{x,y}}` object form, text-in-`key` routed to `type`,
unknown verbs mapped by synonym; auto-split >24 steps across sequential
calls instead of erroring. B's four identical schema errors (E3) become zero.
Also: put the exact per-step JSON example in the tool spec (the current
description explains the constraint in prose the model misreads under load).

**C13. Quirk guards, harness-side.**
- Trusted Types: on docs.google.com, pre-screen `evaluate_js` for
  innerHTML/DOMParser/outerHTML writes → return instantly with the working
  alternative (`textContent`, export fetch) — no 4-turn discovery (C E4).
- Debugger transport: after 2 TRANSPORT-FAILED in a run, the harness itself
  runs page_health → reload once → retries the call once, and injects the
  skill's `fallback` section into the result. The model spends zero turns on
  recovery (C lost ~8 turns to this, spread across the whole run).
- Error-class → skill-section injection generally: map known error tags to
  the skill section that handles them, auto-attached to the result.

### Layer 4 — Canonical playbook + feedback loops

**C14. "How a human would" playbook per task family** (thin skill sections,
fixing what the logs exposed): preference order **shortcuts ▸ menu-by-ref ▸
toolbar ▸ coordinates-of-last-resort**; page numbers = Insert ▸ Page numbers
▸ Bottom of page; fonts = More fonts search dialog; device images = Upload
from computer via `upload {trigger_ref, paths}` (NEVER clipboard paste for
device files — it's the flakiest route in the logs); comment = select ▸
Ctrl+Alt+M ▸ type ▸ click mention chip ▸ Ctrl+Enter; named version LAST;
share = Share button ▸ General access ▸ role ▸ toast confirmation, link read
from the dialog input. Never export-fetch to read what the toolbar shows.

**C15. Per-host quirk lessons, pinned.** Coach output already stores lessons;
tag them by host and pin Docs-tagged lessons to the TOP of the appendix on
docs.google.com runs, so the five recurring classes (E1–E5) lead the context
instead of arriving as turn-40 discoveries.

**C16. Correctness benchmark + KPIs.** Grade the 32-item task with
deterministic per-item assertions on the exported HTML (the task text
already reads like an acceptance-test list — styles, margins, table dims,
comment count, share role, version name). Track per run: **items correct
first-pass**, rework-turn % (C today: ~11 % demonstrable), schema-error
count, transport-recovery turns. Every idea above is measured against this;
`runlog-stats --bench` (M5) reports both speed AND correctness deltas.

## 4. Quick wins (days, not weeks)

1. **C12** — input_sequence auto-repair + example in spec (pure harness, no
   model cooperation needed; deletes E3).
2. **C13** — Trusted Types pre-screen + debugger-transport auto-recovery
   (deletes E4's turn cost).
3. **C6-lite** — before/after pixel-diff flag on canvas actions
   ("[⚠ no visible effect]") using the screenshots already captured;
   DOM-effect checks for menu/dialog actions.
4. **C10/C11** — coordinate→ref promotion + viewport auto-fix (deletes E1-on-DOM).
5. **C2** — `menu_path` walker (small tool, immediately removes menu-miss class).

Then the structural layer: **C1 + C3 + C4** (the docs_op suite — this is the
real answer to "it should know everything about the Google Docs interface":
knowledge that *executes*, verifies itself, and never guesses a pixel),
**C7/C8** (expect + auto-undo), **C5/C16** (trace compiler + benchmark so
correctness keeps improving from every run).

## 5. How this interacts with the speed work

Correctness and speed are the same fight here: every E-class error costs
3–10 turns (~20 s each in A/C). C1's ops collapse 3–8-turn menu walks into
one verified call; C6's same-turn verdicts kill the late-discovery rework
(11 %+ of turns) and the E6 re-reading churn (15–33 collapses/run); C13 stops
transport flaps from eating ~8 turns. Doing the quick wins first also
de-risks J1/R1/R3 from the speed doc — a Jev-driven or replayed step is only
safe when the harness verifies effects, which is Layer 2.
