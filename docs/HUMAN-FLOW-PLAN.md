# Never misclick + human flow — design plan

Three asks, one coherent design:
1. **Click the right spot every time** — make misclicks structurally impossible
   where they can be, and *detected + auto-corrected in the same turn* where
   they can't.
2. **Do it like a human** — no mobilebasic/preview detours, no export-fetch
   rituals, no "extra stuff". Click here, do that, looks good, MOVE ON, next
   step already known.
3. **Never try the same failing thing 100 times** — a hard escalation ladder,
   and Claude-in-Chrome-style progress output: long action sequences, one
   concise `Progress: … Next: …` note between them.

Cross-references: C* ids from `CORRECTNESS-BRAINSTORM.md`, J*/R* from
`SPEED-BRAINSTORM.md`. Error evidence (E1–E6) is in the correctness doc.

## 1. The grounding pipeline (never misclick)

Today the model does arithmetic: it reads a screenshot, remembers a
coordinate, and the harness faithfully clicks it — at a point that may be
stale (the menu shifted: C t11), in the wrong space (viewport mismatch:
A t36/t136), or ~20px off (B t47). The fix is to invert responsibility:
**the model names the target; the harness resolves, verifies, presses, and
verifies again — at press time, against the live page.**

### Stage 0 — semantic targets instead of raw coordinates

Every clicking tool accepts a target descriptor, in order of preference:

```
{ref: 42}                              // DOM element — always exact
{text: "Page setup"}                   // DOM by visible text/aria-label
{text: "Totals", occurrence: 2}        // canvas body text (OCR/find-anchored)
{shot: "shot_12", text: "Section Three"}  // anchored to the image the model saw
{x, y, space: "screenshot", expect_under: "comment checkmark"}  // LAST RESORT
```

Raw coordinates become a guarded last resort, never the primary interface.

### Stage 1 — resolve at press time (never from memory)

- **DOM targets** (menus, dialogs, toolbars, comment cards, buttons — i.e.
  everything except the document body): match by text/aria/role in the live
  snapshot → `scrollIntoViewIfNeeded` → element center via the rects
  `probeElement` already returns. Exact by construction. This one change
  deletes the entire "menu shifted / hit the card body / off by 20px on a
  menu row" class (E1-on-DOM).
- **Canvas body text** (place caret "under Section Three", select "the
  monospace phrase", click a table cell): two anchoring routes, both using
  the app's own ground truth instead of the model's pixel arithmetic:
  1. **Find-bar jump** (`docs_locate`): Ctrl+F → type phrase → Docs scrolls
     to and highlights the match (find bar even reports "x of y" — existence
     and count for free) → screenshot diff against the pre-find shot locates
     the highlight box → click it → Esc. The app's own text engine did the
     localization.
  2. **OCR index of the staged shot**: an offscreen document (the clipboard
     offscreen pattern already exists) runs text detection — native
     `TextDetector` where available, Tesseract.js WASM otherwise — ONCE per
     staged screenshot, cached by `shot_N` id on the shelf. Words → boxes.
     `{shot:"shot_12", text:"Totals"}` resolves to a box center;
     double-click selects the word, shift+click extends (and the selection is
     verifiable: Ctrl+C the selection and compare the echoed text — see §2).
- **Coordinate magnet**: when the model does pass x/y, snap to the nearest
  OCR box / DOM element rect within ~24px if its center is a better match for
  `expect_under`. A 20px miss self-corrects silently.

### Stage 2 — pre-press validation

- **Freshness epoch**: every staged shot gets an epoch stamp (mutation count,
  scroll position, open-menu state). A coordinate click referencing
  `shot_N` is REJECTED when the page has materially changed since — with the
  fresh observation attached: `[shot_12 is stale — the File menu has closed;
  here is the current page; "Page setup" is now ref 17]`. This kills
  clicking-into-a-remembered-layout, the root of "the menu shifted".
- **element_at probe** (already built): for any point with DOM underneath,
  confirm the hit matches `expect_under`; mismatch → don't press, return the
  correction ("at (980,412): comment card body; the checkmark is ref 44").
- **Viewport containment**: outside the viewport → auto-scroll into view and
  proceed (A t36/t136 each burned a turn on this error).
- **Ref promotion**: if a ref-bearing element covers the point, execute
  `click(ref)` instead of the coordinate, and say so in the result.

### Stage 3 — press

Trusted CDP click at the resolved center, existing glowing-ring overlay at
the *actual* press point (keep — it's the model's visual confirmation).

### Stage 4 — post-press effect verification (same turn)

- DOM effects: did the expected dialog/menu open, row highlight, toolbar
  value change? (`docs_state` reads, §2.)
- Canvas effects: pixel-diff of the auto-attached before/after shots (both
  already captured!) → `[⚠ no visible effect — the click may have missed]`;
  caret placement: the landing ring + OCR of the caret line.
- Mismatch ⇒ **one auto-corrected retry via a DIFFERENT resolution path**
  (text-anchor → find-bar → coordinate), never a blind repeat. Second
  failure ⇒ the ladder in §4.

**The honest promise**: "never misclick" = never an *undetected* misclick,
and never the *same* misclick twice. DOM targets become exact by
construction; canvas targets get anchored, verified, and auto-corrected
within the same turn.

## 2. Human perception — kill the mobilebasic/export rituals

The skill's current `read` section (navigate to `/preview` or
`/mobilebasic`) and `verify` section (`evaluate_js fetch(.../export?format=
html)`) are the "stupid extra stuff": they leave the page, depend on the
flaky debugger transport (8 TRANSPORT-FAILED turns in C), and read like a
workaround — because they are one. Replace with the human stack, in place:

- **LOOK**: the auto-attached screenshot (already on every canvas action),
  OCR-indexed on stage (§1) so the harness can answer "where is X" without a
  model turn.
- **FIND**: Ctrl+F find-bar for existence/count/jump (`docs_locate`) — what
  a human does to check whether a phrase is in the document.
- **READ** (`docs_read`): select-all (or select region) → Ctrl+C → the doc's
  own HTML lands on the clipboard with formatting; read it back and restore
  the caret. Clipboard-read reliability in MV3 is the open question — two
  fallbacks that need no tab navigation: (a) the export fetch performed from
  the SERVICE WORKER with host permissions (same data the skill's
  evaluate_js fetch wanted, but immune to the page debugger transport that
  kept failing, and invisible — one tool call, no URL change); (b) only if
  both fail, say so — never silently navigate to mobilebasic.
- **STATE** (`docs_state`, C3): applied style/font/size, bold/italic, save
  indicator, comments, share setting, version names — all plain DOM chrome
  already present in every snapshot; parse it into fields so verification is
  a text comparison, not a vision ritual. B t19's "toolbar still shows
  Normal text" check becomes automatic post-action telemetry.
- **Prompt rule + skill rewrite**: "Never leave the document URL to read or
  verify. No preview/mobilebasic/export tabs, no export fetches from page
  context." Delete the `read` section; rewrite `verify` around
  docs_state + pixel-diff + docs_read.

The flow per action then looks human: **click (grounded) → do (verified) →
glance (pixel-diff/toolbar in the same result) → MOVE ON.**

## 3. Human execution loop — sequences, notes, and knowing the next step

The Claude-in-Chrome output the user cited — "Used Claude in Chrome
(41 actions) · 1 note / Progress: title, subtitle and intro paragraph are in
… Next are the monospace phrase, the links, the page break …" — is exactly
R3/J15 from the speed doc. Concretely:

### `run_program` — plan once, execute many

At each checklist-item boundary the model emits ONE program: a list of
semantic steps (docs_op / menu_path / grounded clicks / type / docs_locate)
each with an optional checkpoint (`expect: {dialog:"Page setup"}` /
`{text_landed:"…"}` / `{pixel_changed:true}` / `{style:"Title"}`), plus a
closing `note` field. The executor:

1. runs steps sequentially, verifying each checkpoint (§1 Stage 4, C6);
2. STOPS at the first failed checkpoint and calls the model with the
   divergence (screenshot + what was expected vs found) — the model is
   consulted at *exceptions*, not at every action;
3. on success, emits the progress note and the todo flip, then the next
   item's program is already known (see below).

Forty actions between model turns becomes normal; 351 turns for 32 items
becomes ~32 programs + a handful of exception turns.

### "It should already know the next step"

The task IS a numbered checklist, and the interface IS knowable:
- run start: compile the task into todos (already prompted) AND match each
  item to a canonical procedure — the `docs_op` macro (C1), the knowledge
  file's playbook entry (C4), or a trace-compiled macro from a previous
  successful run (C5/R1);
- the model's per-item job shrinks to: pick the macro, fill args from the
  task text, attach the note. Deliberation happens once per item, not once
  per action;
- with Jev configured, routine programs can even be drafted without the big
  model (J15), the model reviewing at item boundaries.

### Progress output (panel + runlog)

- New `progress_note` event: the note text + the action count it covers.
  Panel renders it as a distinct bubble; the sequence's tool cards collapse
  under it ("41 actions · 1 note" — the runlog/panel grouping primitives
  exist per turn; extend to sequences).
- Harness-composed fallback when the model omits the note: derive from todo
  diffs ("Progress: items 4–6 complete. Next: item 7 (insert table).").
- Narration between actions disappears: the note IS the narration. This also
  cuts decode time (the speed doc's D-class): no per-action prose turns.

## 4. The failure ladder — never try it 100 times

Policy lives in the HARNESS (prompts advise; harnesses enforce — A t33/t46
retried a failing paste "one more time" twice because advice is ignorable):

1. **First failure** → the harness retries ONCE itself, via a *different
   resolution path* (ref → text anchor → find-bar → coordinate; or the quirk
   table's alternative: paste-image failed → Insert ▸ Image ▸ Upload from
   computer). The model never sees a bare failure; it sees
   `[failed → auto-retried via upload route → landed]` or a divergence report.
2. **Second failure** → forced strategy switch: the harness injects the
   concrete alternative (quirk table first; Jev J7/J8 verdict when
   configured) as an instruction riding the result — not a suggestion.
3. **Third failure** → item marked **blocked**: one-line note, todo flipped
   to blocked, MOVE ON to the next checklist item. The final summary reports
   blocked items. Never a fourth attempt.
4. **Identical-call ban** (upgrade of the existing stuck guard, which
   currently only *advises* at 3 repeats): an exact call that failed twice
   is REFUSED on the third try — not executed, returned with the
   corrections. `RETRY WARNING`/`STUCK` notes become enforcement.
5. **Per-item turn budget** (e.g. 8 model turns): crossing it forces a
   verdict call — complete / blocked / skip (Jev J5 answers it free when
   configured) — so no item can sink 15+ turns like C's worst stretches.
6. **Two blocked items in a row** → pause and ask the user (existing confirm
   card machinery) instead of thrashing the rest of the checklist.

Expected effect on the logged runs: C's 8 transport-failure turns → 1
auto-recovery (C13); A's double paste-retry → auto-switch to the upload
route at first failure; B t222's end-of-run confusion → item blocked +
noted three items earlier.

## 5. What gets DELETED

- The `read` skill section (mobilebasic/preview navigation) — replaced by
  docs_read/find-bar/OCR (§2).
- The export-fetch-from-page-context verify ritual — replaced by docs_state +
  pixel-diff + SW-side read (§2).
- Free-form coordinate clicking as the primary canvas interface — demoted to
  guarded last resort (§1 Stage 0/2).
- Per-action narration turns — replaced by sequence notes (§3).
- The advisory-only stuck guard — replaced by the enforced ladder (§4).

## 6. Build order (each step ships value alone)

1. **Ladder + identical-call ban** (§4.4 first — smallest diff: stuck guard
   in `loop.ts` from advisory to enforcing; per-item budget). Immediately
   kills the retry-loops the user is angry about.
2. **Coordinate sanitizers** (§1 Stage 2: stale-shot rejection with fresh
   observation, ref promotion, viewport auto-fix, magnet snap to
   probeElement rects — all data the harness already has). Kills E1-on-DOM
   and the viewport errors.
3. **Skill rewrite + prompt rule** (§2's deletions — text-only change).
   Stops the mobilebasic/export detours the same day.
4. **`menu_path` + first `docs_op` five** (page_setup, apply_style,
   insert_table, page_numbers, insert_image — the checklist's heavy hitters;
   menus are DOM, so these are label walks + verification, no OCR needed).
5. **OCR offscreen indexer + `docs_locate` + text-anchored clicks**
   (§1 canvas routes; offscreen document pattern and shot ids already exist).
6. **`docs_read`/`docs_state`** (§2; SW-side export fallback first — it's
   ten lines and immune to the debugger flakiness — clipboard route after).
7. **`run_program` + progress notes + panel sequence grouping** (§3 — the
   biggest panel-visible change; last because it consumes everything above).

Measurement (extends C16): misclick rate (post-press verify mismatches),
auto-corrections, identical-call refusals, turns per checklist item (target:
≤3 with programs vs ~11 today), items correct first-pass, notes per run.
The 32-item task is the standing benchmark for all of it.

---

## 7. Shipped status (implementation pass 1)

Build-order items 1–7, what actually landed and where:

1. **Failure ladder + identical-call ban — SHIPPED.** `loop.ts`
   `createStuckGuard` gained `blocked()`: an exact call that failed twice is
   REFUSED on the third attempt (never executed), the second failure's note
   announces the ban, and a refusal is `ok:false, invalid:false` (it resets
   adaptive thinking but cannot abort the run). Wait tools are
   banned identically — a longer `timeout_ms` is a different call and stays
   allowed. Tests: `tests/loop.test.ts` ("bans an exact call…", "refuses the
   third identical failing call WITHOUT executing it").
2. **Coordinate sanitizers — SHIPPED.** `shared/coords.ts` gained the pure
   decisions (`snapOrPromote`, `looksLikeShotPixels`, `compensateShotScroll`,
   `rectDistance`, caps/constants); `content/actions.ts #probeAt` now returns
   the hit's `rect`/`editable` plus a ring-probe `snap` candidate
   (`#snapNear`, two radii × 8 directions); `tools/coords.ts resolveTarget`
   applies, for click-ish calls only (`magnet` opt — never type_at/drag_at):
   screenshot-space reinterpretation of out-of-viewport image pixels, scroll
   compensation against the capture-time scroll (now recorded on
   `ViewportShotInfo`), centre-promotion of points on small ref'd controls,
   and the ~24px magnet snap. Every correction is reported in the result's
   `[brackets]`, and `probeElementAt` MIRRORS the magnet (new `tool` param,
   wired in sw.ts) so the risk gate assesses the element the corrected click
   actually lands on. Tests: `tests/coords.test.ts` (three new describes).
3. **Quirk guards — SHIPPED.** `tools/misc.ts`: `isTrustedTypesBlocked` +
   `TRUSTED_TYPES_ADVICE` rewrite any Trusted-Types TypeError post-hoc, and
   `trustedTypesRefusal` pre-screens assignment/parse sinks on
   docs/sheets/slides.google.com before spending the debugger round trip
   (reads of `.innerHTML` are NOT screened — they're legal). `sw.ts`:
   `withTransportRecovery` — a TRANSPORT-FAILED result triggers reload-tab +
   settle + ONE retry of the same call, budgeted at 2/run
   (`transportRecoveries`), announced via an info event, excluded for
   `docs_read` (its transport is the SW's network, and a reload would
   destroy editor state). Tests: `tests/evaluate.test.ts` ("Trusted Types
   guard").
4. **`docs_read` + ritual deletion — SHIPPED.** `tools/docs.ts` registers
   `docs_read` (text/html export fetched SW-side with session cookies —
   `fetchWorkspaceExport`, shared with docs_op verification; PARALLEL_SAFE).
   The skill's `read` section (mobilebasic/preview) and `verify` section
   (export-fetch ritual) are rewritten around docs_read/find-bar/docs_state;
   `fallback` teaches the harness auto-recovery; BASE_RULES_TAIL gained the
   global "NEVER leave the working URL just to read or verify" rule. Tests:
   `tests/docs-read.test.ts`, updated pins in `tests/prompts.test.ts`.
5. **`menu_path` + `docs_op` — SHIPPED (4 ops).** `shared/docs-ops.ts` is
   the pure planner (unit-tested in `tests/docs-ops.test.ts`): `apply_style`
   (Heading 1–6 → trusted Ctrl+Alt+N; Title/Subtitle/Normal → Format ▸
   Paragraph styles walk), `page_numbers` (Insert ▸ Page numbers ▸
   Bottom/Top of page — with label alternates), `page_setup` (dialog walk:
   File ▸ Page setup, fill Paper size select / orientation radio / four
   margin fields BY LABEL, confirm OK), `insert_table` (Insert ▸ Table +
   trusted ArrowRight/ArrowDown/Enter into the grid picker). Execution in
   `tools/docs-op.ts`: `clickLabelStep` polls `clickByText` (~2.4s budget,
   disabled fails fast), `walkMenu` reports every click and stops at the
   first miss, `verifyPlan` runs the op's effect check (export-HTML needle,
   toolbar style box, dialog-closed) and the result says `verified:` /
   `NOT VERIFIED:` honestly. Content-side primitives (`clickByText`,
   `fillField`, `queryText` + the `findByText`/`findField` label matcher:
   exact-beats-prefix, innermost-wins, aria-label/placeholder/<label>
   support, jsdom-tolerant visibility) are unit-tested in
   `tests/actions.test.ts`. Both tools are MUTATING (Jev-gated),
   AUTO_OBSERVE (settle budget 2.5s), registered in sw.ts. `insert_image`
   deferred (needs trigger-less file-chooser interception).
6. **`docs_state` + `docs_locate` — SHIPPED (find-bar variant).**
   `docs_state`: one call reads title / paragraph style / font / size /
   bold-italic-underline (aria-pressed via the extended `queryText`) /
   editing mode / open dialog, honestly listing unreadable fields;
   PARALLEL_SAFE, never mutating. `docs_locate {phrase, occurrence, close}`:
   trusted Ctrl+F → insertText phrase → Enter×(k−1) → best-effort counter
   read → SCREENSHOT of the highlighted match (recorded as the latest
   capture, so space:'screenshot' resolves against it) → Escape. The OCR
   offscreen indexer and text-anchored `click_target` remain follow-ups.
   Trusted-key helpers (`sendTrustedKey`/`sendTrustedText`) live in
   `tools/trusted-input.ts`.
7. **Progress notes — SHIPPED (note slice).** `progress_note {text}` tool
   (todo.ts, pure narration, PARALLEL_SAFE, ≤400 chars,
   `normalizeProgressNote` tested), new `progress_note` StepEvent
   (protocol.ts), folded as a `progress:true` note block in chat.ts and into
   runlog `notes` (rendered `📣 **Progress**` in markdown), rendered as a
   green bubble with a `Progress` pill in the panel (`.info-line.is-progress`
   / `.progress-pill`), and taught in BASE_RULES ("batch the work first,
   then report; never two notes in a row"). Tests in todo/chat/logging
   suites. The full `run_program` executor (open-loop multi-op programs with
   per-step checkpoints) remains the next structural piece — docs_op,
   menu_path and input_sequence already provide most of its "execute many"
   body.

Not in this pass (tracked follow-ups): `run_program` + panel sequence
grouping, the OCR indexer / text-anchored canvas clicks, `docs_op
insert_image` + `set_font`, auto-undo on failed verification (C8),
per-item turn budgets + two-blocked-items pause (§4.5/4.6), and the C16
graded benchmark.
