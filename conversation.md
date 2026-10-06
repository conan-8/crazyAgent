# conversation.md — complete handoff of the 2026-10-06 → 10-07 session

Purpose: let this work continue in a fresh session (or with another agent) with
zero context loss. Written 2026-10-07 ~01:30 local, repo
`/home/conan/Documents/GitHub/crazyAgent`, on top of commit `6573f2c` ("Fix all
pre-existing smoke failures and dev-channel tab tracking"). **All changes from
this session are UNCOMMITTED working-tree state** (see §9).

Read-first order for a resuming agent:
1. This file (state + evidence + what to do next).
2. `docs/HUMAN-FLOW-PLAN.md` — the design that was executed (§7 = shipped status).
3. `docs/DEV.md` → section "The human-flow layer" — the developer-facing doc of everything that landed.
4. `docs/SPEED-BRAINSTORM.md` and `docs/CORRECTNESS-BRAINSTORM.md` — the idea catalogs (mostly NOT yet implemented; they are the backlog).

---

## 1. Project + environment

- **crazyAgent** ("browser-agent" in package.json): an AI browser agent as a
  Chromium **sidebar extension** (MV3 service worker + side panel (Preact) +
  content scripts + offscreen doc + optional CDP helper daemon for "Unlimited"
  mode). Full browser control: trusted CDP input, screenshots, snapshots with
  numbered refs, tabs/windows, skills, lessons/coach, Jev sidecar, run logs.
- Stack: TypeScript, esbuild (`npm run build` → `dist/`), vitest (`npm test`),
  `npm run typecheck`, and `npm run verify` = 20 headless-Chrome smoke suites
  (`scripts/verify.mjs`). Docs culture: dense "why" comments citing measured
  runs; plan docs in `docs/`; every behavior pinned by a unit test and often a
  smoke script.
- The user drives the agent from the side panel against a real Chrome profile;
  runs export as `crazyagent-logs-*.jsonl` (usually to `~/Downloads`;
  `scripts/runlog-stats.mjs` reads the newest one and does side-by-side
  comparison).
- **User's benchmark task**: a 32-item Google Docs "Feature Test Document"
  checklist (Letter/1-inch/portrait page setup; title; headings; monospace
  phrase; links; page break; lists; horizontal line; 4-col table with header
  colour + merged cells; image with size/wrap/alt-text; bookmark; TOC;
  equation; find/replace; two comments — one resolved — one with an @mention;
  sharing "Anyone with the link can comment"; named version "v1 — complete").
  The user re-runs this same task to measure the agent.
- Agent LLM in the logged runs: `deepseek-v4.1-flash` over an
  **openai-compatible** gateway; Jev sidecar configured (typesafe transport,
  2s gate budget); `autoThinking` on; run-level thinking routed to `low`;
  `batchActions` (Fast-steps) on; mode `standard`; build `6573f2c`.

## 2. The user — observed preferences (important for tone/direction)

- Casual register; wants **plain-English explanations** (asked explicitly for
  "simple terms" after the implementation summary).
- Cares about: **speed** (wall-clock per run), **correctness** ("a lot of
  times it will do things incorrect"), **intuitive human-like behavior**
  ("First click here, do that. Looks good, MOVE ON. Then it should already
  know the next step"), **no grind** ("If something doesn't work, don't try it
  100 times more expecting a different outcome"), and **Claude-in-Chrome-style
  progress output** (pasted an example: "Used Claude in Chrome (41 actions) ·
  1 note — Progress: title, subtitle and the intro paragraph are in… Next are
  the monospace phrase, the links…").
- Explicitly called the `/mobilebasic` + export-fetch reading rituals "stupid
  mobilebasic stuff and the extra stuff" → those routes are now **forbidden**
  in prompt + skill and replaced by `docs_read`/`docs_state`/`docs_locate`.
- Said the agent "should know everything about the Google Docs interface" →
  answered with knowledge-as-code: `menu_path`, `docs_op`, structured plans in
  `shared/docs-ops.ts` (see §7).
- Approved the plan with "alr sounds good. execute" → the build order in
  `docs/HUMAN-FLOW-PLAN.md` §6 was executed in full (steps 1–7; step 7 shipped
  as the progress-note slice, full `run_program` deferred).
- **The user is now field-testing the build** ("ill try it and get back to
  you"). When they return, expect new run logs — see §11 for the analysis
  playbook.

## 3. Conversation chronology

1. **User** provided three run-log exports (2026-10-06; paths+hashes in §4) and
   asked: still too slow in places; "Can we use jev in places to optimise
   things? any more creative ideas? give a big list of ideas, brainstorm deep."
   → I mined the logs turn-by-turn, read the codebase (loop/llm/jev/prompts/
   sw/perception/coords/skills), and wrote **`docs/SPEED-BRAINSTORM.md`**
   (~50 numbered ideas: J1–J15 Jev placements, R1–R8 round-trip killers,
   T1–T8 TTFT/token, D1–D6 decode, O1–O6 overlap/speculation, P1–P6 pipeline,
   M1–M5 measurement + a "If only five things" shortlist).
2. **User**: "a lot of times it will do things incorrect… doing it in an
   unintuitive way. It also should know everything about the google docs
   interface." → I mined the same logs for failure evidence (taxonomy E1–E6,
   §5) and wrote **`docs/CORRECTNESS-BRAINSTORM.md`** (four-layer plan, C1–C16
   ids: deterministic Docs ops, same-turn effect verification, harness-
   enforced grounding, playbook+measurement).
3. **User**: never-misclick precision + kill the mobilebasic/export rituals +
   human flow ("Looks good, MOVE ON… should already know the next step") +
   no-100-retries + Claude-in-Chrome progress output → I wrote
   **`docs/HUMAN-FLOW-PLAN.md`** (grounding pipeline §1, human perception §2,
   sequences/notes §3, enforced failure ladder §4, deletions §5, build order §6).
4. **User**: "alr sounds good. execute" → I implemented build-order steps 1–7
   (§7 below) with tests at every step; final state: **839 unit tests green,
   typecheck clean, build clean, `npm run verify` ALL 20 SUITES GREEN.**
   Created a session goal (completed) and updated HUMAN-FLOW-PLAN §7 +
   DEV.md (new "The human-flow layer" section; fixed the stale
   mobilebasic sentence in the canvas-editors section).
5. **User**: asked for a simple-terms explanation → delivered (problems:
   clicking from memory, ignored warnings/retry loops, reading detours,
   re-derived procedures, per-action narration; fixes: smart aim, enforced
   ladder + auto-recovery, read-in-place tools, knowledge-as-code ops with
   self-verification, progress bubbles).
6. **User (current)**: will field-test; asked for this file.

## 4. The evidence base — the three runs (all build 6573f2c, deepseek-v4.1-flash, same task family)

Read-only attachment copies (may persist under `~/.dsh/attachments`):
- **Run A** = `crazyagent-logs-2026-10-06T02-32-45.jsonl` (994,666 B, sha256 `2fdd5b29…`) → `/home/conan/.dsh/attachments/v1/files/2f/2fdd5b29e875b949694ef2af10430c0de7945d67d7e69126ee4a4c4c2668058b/crazyagent-logs-2026-10-06T02-32-45.jsonl`
- **Run B** = `…02-32-55.jsonl` (597,537 B, sha256 `7880471e…`) → `/home/conan/.dsh/attachments/v1/files/78/7880471ec9958d6d658105afd36d9a99333447385f89c3bbe706326cb41e8cf2/crazyagent-logs-2026-10-06T02-32-55.jsonl`
- **Run C** = `…02-32-22.jsonl` (1,728,262 B, sha256 `4897f707…`) → `/home/conan/.dsh/attachments/v1/files/48/4897f7072044418d3a7fc21ddf0661786e06e6a8b596fed0356643248de30b7d/crazyagent-logs-2026-10-06T02-32-22.jsonl`

Each file is ONE JSON record: `{build, conversationId, durationMs, heartbeats[],
id, mode, model, provider, runId, startedAt, status, task, todos, tokensEstimated,
toolCalls, totalTokens, turns[], updatedAt}`. Per turn: `{index, generation,
startedAt, endedAt, durationMs, ttftMs, decodeMs, thinking (EFFECTIVE LEVEL:
'off'|'low'|…), reasoning, text, usage{inputTokens(cumulative), outputTokens
(cumulative), contextTokens(per-turn), contextWindow}, tools[{name,args,at,
durationMs,finishedAt,ok,result(clipped 400),image?,imageBytes?,truncated}],
notes, jevNotes, errors, exclamations, confirmations}`.

| metric | A (…45) | B (…55) | C (…22) |
|---|---|---|---|
| started | 19:17 (overlapped by C) | **18:10, solo** | 19:23 (overlapped A) |
| outcome | **SW died silently mid-turn 200** (status stuck `running`; last hb 20:34; final turn's `click_at` never completed; raw historyChars 1.83M) | done | done |
| wall / turns | 76 min / 201 | **29 min / 223** | 134 min / 351 |
| step wall p50 | 20.3 s | **5.7 s** | 19.6 s |
| TTFT p50 | 7.2 s (quarters 5.9→10.0) | **3.1–3.3 s** | 8.2 s (quarters 4.5→7.2→10.9→8.1) |
| decode p50 | 6.0 s (thinking=low) | **0.6 s (off) / 2.4 s (low)** | 4.9 s (low) |
| thinking mix | 199 low / 2 off | **156 off / 67 low** | 348 low / 3 off |
| decode speed | ~88 tok/s | ~153 tok/s | ~87 tok/s |
| reasoning >11k chars (cap-hits ⇒ abort+re-ask double round trip) | 12 | 10 | **34** |
| failed tool calls | 6/218 | 13/230 | 19/388 |
| multi-tool ("batched") turns | 17/201 | 8/223 | 37/351 |
| "unchanged since" observation collapses | 15 | 22 | 33 |
| tool results carrying a screenshot | 164/218 (p50 89 KB) | 175/230 (58 KB) | 277/388 (78 KB) |
| context tokens/turn | 45–54 k | 15–48 k | 14.9–47.5 k |
| cachedInputTokens reported | **0 turns** | **0** | **0** (gateway never reports cache) |
| demonstrable rework turns | — | — | **37/351 ≈ 11 %** |

Key diagnostics: A+C ran **concurrently on the same gateway/key** → TTFT ~2.5×,
decode ~half speed, and Jev's 2 s gate budget started timing out (A logged
"Jev unavailable (Jev call timed out after 2000ms)") → effort routing never
landed → thinking stuck at `low`. There is an **adaptive-thinking catch-22**
in `loop.ts isRoutineStep`: a routine streak requires `reasoningChars < 300`,
but at `low` the model emits ~2 k chars, so the streak can never start (B only
escaped because Jev's first `off` hint landed; then it self-sustained). Tool
phase ≈ 6–20 % of wall; `input_sequence` p50 ≈ 2.5 s (the canvas settle floor —
Docs never reaches the 500 ms mutation-quiet window); per-mutating-call Jev
gate POST is serial (and `evaluate_js` counts as mutating: C paid ~313 gate
POSTs). Turn economics: at B's per-turn profile C's 351 turns ≈ 45 min, not 134.

## 5. Error taxonomy from the logs (quotes are real, turns cited)

- **E1 pixel misses**: C t11 "hit the wrong item (the menu shifted)"; C t123
  "Menu click missed"; C t330 "click missed (hit the card body)"; C t216 "Page
  numbers landed in the header again"; B t47 "off by ~20px"; A t69 "crop missed
  the font box"; A t36/t136 point-outside-viewport (1164,83 vs 1046×693).
- **E2 silent no-ops found late**: B t19 "Title style didn't apply (toolbar
  still shows Normal text)"; A t33/t46 + B t211/t215 "paste didn't land",
  "image insertion didn't land", "fill didn't apply"; B t92 table text didn't land.
- **E3 repeated schema misuse**: B hit the identical `input_sequence`
  "steps[N] needs one of click/hover/key/type/wait_ms" error at t33/t59/t94/t142;
  t74 "steps is limited to 24 (got 36)"; t83 sentence passed to `key`;
  `type` on non-typable `<div>` ×3 (B t128/t174, A t134); B t165 upload ref = div.
- **E4 environment quirks**: C `TRANSPORT-FAILED: Failed to fetch` on
  evaluate_js at t61,103,129,132,134,136,141,161 (debugger flapped all run);
  TrustedHTML refusals ×4 (C t52/53/88/89: innerHTML + DOMParser.parseFromString).
- **E5 unintuitive routes**: verify-by-export-fetch (the skill taught it!) that
  dies with the transport; mobilebasic/preview navigation; clipboard-paste
  image insertion (flakiest route; A/B failures above) instead of Upload from
  computer; coordinate-clicking menu rows that have refs; header double-click
  guessing for page numbers.
- **E6 verification churn**: 15/22/33 "page unchanged" collapses per run.

## 6. The three planning docs (idea backlogs — mostly NOT implemented)

- `docs/SPEED-BRAINSTORM.md` — J1 Jev-as-actor for routine steps (moonshot),
  J2 one gate POST per batch, J3 gate resilience/telemetry, J4 Jev-seeded
  streaks (fixes the catch-22), J5 completion checks ride the gate POST, J6
  batch pre-validator, J7 failure-recovery arbiter, J8 named-alternative
  stuck-breaker, J9 screenshot triage, J10 observation Q&A, J11 model cascade,
  J12 parallelizability, J13 compaction judge, J14 bounded auto-approve
  (parked), J15 checklist micro-step mode; R1 trace replay/skill compiler
  (5–10× on repeat tasks), R2 mid-sequence captures in input_sequence, R3
  plan-then-execute chunks, R4 compound tools, R5 keyboard-first Docs, R6
  batching few-shot+nudge, R7 item-scoped context resets, R8 auto-resume
  watchdog (A died silently!); T1 **verify prefix caching (zero cache fields
  reported — biggest unknown)**, T2 shrink ~12–15 k fixed prefix, T3 history
  diet (120 k→72 k chars), T4 image diet (1024/q0.6/WebP/crop), T5 diff
  observations, T6 hedged requests at ~8 s TTFT, T7 concurrency governance,
  T8 body telemetry; D1 overrun factor 3→1.5 + eager level drop, D2 knob-honor
  stat, D3 route simple→off, D4 decode-stall watchdog, D5 shadow re-ask, D6
  cheap final turn; O1 execute tool calls as they stream, O2 speculative gate
  pre-fire, O3 parallel observation assembly, O4 skip quiet-wait on canvas
  (partially done for menu_path/docs_op only), O5 preconnect, O6 (parked);
  P1 Input.insertText bulk typing (type_at already uses insertText;
  input_sequence per-key path could), P2 don't gate read-only evaluate_js, P3
  persist compacted checkpoints (A re-serialized 1.83 M chars/step), P4 probe
  cache, P5 800px failure shots, P6 memoize hot-path awaits; M1–M5 telemetry
  (per-turn waterfall, Jev latency, batching rate, cache/body stats, --bench).
  "If only five": (1) make `off` the common case (J3+J4+D1+D3), (2) prove/fix
  cache + hedge tail (T1+T6), (3) concurrency governance (T7), (4) tool phase
  off the critical path (O1+O2+O4+J2), (5) trace replay (R1+R2/R3).
- `docs/CORRECTNESS-BRAINSTORM.md` — C1 docs_op suite ✅(4 ops shipped), C2
  menu_path ✅, C3 docs_state ✅, C4 docs-knowledge.json (NOT done — knowledge
  currently lives in `shared/docs-ops.ts` + skill prose), C5 trace compiler
  (NOT done), C6 effect verification on EVERY mutating action (partial: only
  docs_op verifies; generic pixel-diff "⚠ no visible effect" NOT done), C7
  `expect` param on coordinate calls (NOT done), C8 auto-undo (NOT done), C9
  Jev verification on gate POST (NOT done), C10 ref promotion ✅(via magnet),
  C11 viewport auto-fix ✅(reinterpret/compensation; raw scroll-into-view for
  page-space points NOT done), C12 input_sequence auto-repair (NOT done — the
  E3 schema errors still rely on the ban+notes; shapeSequenceSteps already
  accepts aliases/type_at expansion but not object-form clicks or auto-split
  >24), C13 quirk guards ✅(Trusted Types + transport), C14 canonical playbook
  ✅(skill rewritten), C15 host-pinned quirk lessons (NOT done), C16 graded
  benchmark (NOT done).
- `docs/HUMAN-FLOW-PLAN.md` — the executed plan; §7 records exactly what
  shipped per build-order item and the follow-up list.

## 7. What was implemented this session (all green; details in DEV.md "The human-flow layer")

**Step 1 — enforced failure ladder** (`extension/src/background/agent/loop.ts`):
`StuckGuard.blocked(name,args)`; `IDENTICAL_FAIL_BAN = 2`; per-exact-call
`fails` map keyed by `callKey` (`name:JSON(args)`). Third identical attempt is
REFUSED in `runOne` before validation/execution — returns `ok:false`,
`invalid:false` (never feeds the 3-invalid abort), message starts
`[BLOCKED — NOT EXECUTED: …]` and ends with the "mark its todo item blocked…
MOVE ON" move. Second identical failure's RETRY WARNING/STUCK note appends a
ban announcement ("a THIRD identical attempt will NOT be executed"). Wait
tools included in the ban (longer `timeout_ms` = different call = allowed).
`coach()` unchanged. Tests: `tests/loop.test.ts` (2 new its incl. integration
proof the executor sees 2 calls not 3).

**Step 2 — coordinate sanitizers**:
- `extension/src/shared/coords.ts` (pure): `ElementRect`; `HitInfo` +=
  `rect?`, `editable?`; `SnapCandidate`; `SNAP_RADIUS_PX=24`,
  `PROMOTE_MAX_W=600`, `PROMOTE_MAX_H=140`; `rectCenter`, `rectDistance`,
  `snapOrPromote(point,hit,snap)` → keep|promote(centre of small ref'd
  control)|snap(nearest control ≤24px); `looksLikeShotPixels(point,viewport,shot)`;
  `compensateShotScroll(point,atCapture,now)`.
- `extension/src/content/actions.ts`: `#probeAt` now returns `rect`+`editable`
  on the hit and a `snap` candidate from `#snapNear` (rings r=12,24 × 8 dirs of
  `elementFromPoint`, dedup, `nearestInteractive`, bounded by SNAP_RADIUS_PX) —
  computed only when the point is NOT on a ref'd control; `rectOf` helper.
- `extension/src/background/tools/perception.ts`: `ViewportShotInfo` +=
  `scrollX?/scrollY?`; `recordViewportShot` stores them from the layout
  metrics it already reads.
- `extension/src/background/tools/coords.ts`: `ResolveOpts.magnet`;
  `ResolveOutcome` += `correction?`, `snap?`; `resolveTarget` coords-mode:
  screenshot-space conversion → scroll compensation; **reinterpretation** of
  out-of-viewport `space:'viewport'` points that fit the latest shot image
  (deliberately NOT for explicit `space:'page'`); `shotHint` on bounds errors;
  magnet (snapOrPromote + re-probe at corrected point) for click-ish calls
  only — `click_at`/`hover_at`/`input_sequence` click+hover steps pass
  `magnet:true`; **`type_at`/`drag_at`/`element_at` never re-aim**. Corrections
  ride results as `[brackets]` in `present()` text; `element_at` reports
  `nearbyControl`. **`probeElementAt(tabId,args,tool?)` mirrors the magnet**
  (`magnetHit`) for `click_at` + `input_sequence` first click step so the Jev
  gate assesses the element the corrected click lands on; `sw.ts` passes the
  tool `name`. Tests: `tests/coords.test.ts` (4 new describes).

**Step 3a — quirk guards**:
- `extension/src/background/tools/misc.ts`: `isTrustedTypesBlocked`,
  `TRUSTED_TYPES_ADVICE`, `describeEvalFailure` Trusted-Types branch
  (`TRUSTED-TYPES-BLOCKED:` prefix, keeps original), `TRUSTED_TYPES_SINK_RE`
  (assignments/parsers only — `.innerHTML` READS pass), `TRUSTED_TYPES_HOST_RE`
  (docs|sheets|slides.google.com), `trustedTypesRefusal(tabId,expression)`
  pre-screen wired at top of `evaluate_js.run` (fails safe without chrome.tabs).
- `extension/src/background/sw.ts`: `transportRecoveries` (reset per run),
  `TRANSPORT_RECOVERY_MAX=2`, `withTransportRecovery(name,args,res,tabId)` —
  on `TRANSPORT-FAILED`: info event, `chrome.tabs.reload`, `settleTab(…,10s,8)`,
  one `executeTool` retry; success annotated "[…harness reloaded the tab and
  retried once…]"; second failure annotated "switch to read_page/snapshot/ref
  tools". **`docs_read` exempt** (SW-network transport; reload would destroy
  editor state). Wired into `executeToolGated` after the first `executeTool`
  (before jevGate stamping / gate history / failure shot). Tests:
  `tests/evaluate.test.ts` ("Trusted Types guard" describe, chrome stubbed).

**Step 3b — docs_read + ritual deletion**:
- NEW `extension/src/background/tools/docs.ts`: `parseWorkspaceUrl`
  (document/spreadsheets/presentation; edit/preview/bare forms), `exportUrl`
  (doc→txt/html/rtf; sheet→csv/html/tsv; slides→none), `fetchWorkspaceExport`
  (SW-side `fetch(…, credentials:'include')` — host_permissions `<all_urls>`
  attach cookies; 401/403/404-specific advice), `docs_read` tool
  (`format:'text'|'html'`, `max_chars` default 16 000 cap 100 000,
  `truncateWithNote`; present() renders `--- document content ---`).
  Registered in sw.ts; `PARALLEL_SAFE` += docs_read.
- `extension/src/shared/skills.ts` canvas-doc-editors sections rewritten:
  `verify` → docs_read(html)/docs_state/toolbar + "NEVER verify with
  evaluate_js fetch" + correction-report explainer; `read` → "one call, stay
  on the page" (docs_read, find bar; "NEVER navigate to /preview or
  /mobilebasic"; Sheets=CSV; Slides=no text export); `fallback` → harness
  ALREADY auto-recovers transport (page_health ONCE, then ref tools; docs_read
  keeps working) + Trusted-Types never-retry rule; `rebuild` → "ONE docs_read
  verifies the block". Section budget 2000 chars enforced by tests — verify
  section had to be trimmed twice.
- `extension/src/background/agent/prompts.ts` `BASE_RULES_TAIL` += global
  rule: "NEVER leave the working URL just to read or verify its content…"
  (docs_read named). `tests/prompts.test.ts` pins updated (docs_read present,
  mobilebasic forbidden, auto-recovery wording).

**Step 4 — menu_path + docs_op**:
- NEW `extension/src/shared/docs-ops.ts` (pure planner; `tests/docs-ops.test.ts`
  13 tests): `DOCS_OPS=[apply_style,page_setup,page_numbers,insert_table]`;
  plan kinds `keys | menu | dialog | menuThenKeys`; `STYLE_ALIASES/STYLE_NAMES/
  normalizeStyleName/styleShortcut` (Heading N→Control+Alt+N; Title/Subtitle/
  Normal→Format ▸ Paragraph styles walk); `shapeMargins` (scalar→4 sides, or
  {top,right,bottom,left}, strings pass through); page_setup dialog plan
  (open File▸Page setup; fills: select "Paper size"/"Page size", radio
  Portrait/Landscape, 4 margin text fields "Top margin"/"Top" etc.; confirm
  ["OK","Save"]); page_numbers menu plan with ALTERNATES (["Bottom of page",
  "Footer"] / ["Top of page","Header"]); insert_table menuThenKeys (Insert▸Table
  + ArrowRight×(cols−1) + ArrowDown×(rows−1) + Enter; dims 1..20); VerifyPlans
  (`exportHtmlContains` needles `<hN`, `class="title"`, `<table`;
  `toolbarStylesShows`; `dialogClosed`).
- `extension/src/content/actions.ts` new actions + helpers: `clickByText
  {labels[]}`, `fillField {labels[],value?,kind?}` (text via framework-friendly
  #type; select by OPTION TEXT with "options are: …" error; radio via #click;
  associated `<label for>`/wrapping label), `queryText {labels?,selector?}`
  (returns text/value/**pressed** (aria-pressed ?? aria-checked)/tag);
  label matcher `findByText/findField` over `CLICKABLE_CANDIDATES`/
  `FIELD_CANDIDATES` (aria-label/title/innerText/placeholder; exact(0) beats
  prefix(1); shortest-text innermost wins; candidate labels preference-ordered;
  `isVisibleLoose` jsdom-tolerant via `documentHasLayout()`; `isDisabledEl`
  (aria-disabled/disabled) → clickByText refuses disabled; `#click`'s
  file-input refusal prevents OS-picker traps). Tests: `tests/actions.test.ts`
  (+12 its, jsdom).
- NEW `extension/src/background/tools/docs-op.ts`: constants `STEP_BUDGET_MS
  =2400`, `POLL_MS=150`, `BETWEEN_STEPS_MS=120`, `EXPORT_SETTLE_MS=900`;
  `clickLabelStep` (polls clickByText; disabled fails fast), `fillFieldStep`
  ("has no option"/"not a <select>" fail fast), `walkMenu` (stops at first
  miss, reports steps + which step/label failed), `verifyPlan` (export needle
  via `fetchWorkspaceExport`; toolbar selectors `['[aria-label^="Styles"]',
  '.kix-paragraphstyles-combobox','[role="combobox"][aria-label]']`;
  dialogClosed via `[role="dialog"]`) → result says `verified:` /
  `NOT VERIFIED:` / `unverified (…)`. Tools: **`menu_path {path:2..6 labels}`**
  and **`docs_op {op,…}`** (descriptions teach usage; results carry
  `did/steps/verified`). Trusted keys via `sendTrustedKey` after
  `ensureTabActive`.
- `extension/src/background/tools/trusted-input.ts`: exported `sendTrustedKey`
  (parseKeyCombo → Input.dispatchKeyEvent down/up) + `sendTrustedText`
  (Input.insertText). docs-op refactored onto them.
- Wiring: `shared/modes.ts` MUTATING_TOOLS += menu_path, docs_op (Jev-gated);
  sw.ts AUTO_OBSERVE_TOOLS += both, new `docsTool` branch gives them the
  **2.5 s settle** (canvas never quiets; 10 s would be dead time), import
  `./tools/docs-op`.

**Steps 5+6 — docs_state + docs_locate** (`tools/docs.ts`): `readField(ctx,
selectors)` helper; **`docs_state`** (title via `input[aria-label="Document
title"]` value; paragraphStyle/font/fontSize via aria-label + legacy kix-class
candidates; bold/italic/underline via `pressed`→on/off; editingMode;
dialogOpen; returns `{read, unreadable[]}` honestly; PARALLEL_SAFE, non-
mutating); **`docs_locate {phrase, occurrence=1, close=true}`** (Workspace-URL
guard; ensureTabActive → trusted Control+f → insertText phrase → Enter×
(occurrence−1) → 400 ms → best-effort counter read (`[class*="findbar"]
[class*="counter"]`, `.docs-findbar-counter`) → `captureBlindShot` (records
the shot as LATEST so `space:'screenshot'` resolves against it) → Escape
unless close:false; transport-tagged error on CDP failure; present() attaches
the image + the "latest capture" note). `loop.ts` PARALLEL_SAFE += docs_state.

**Step 7 (slice) — progress notes**: `shared/protocol.ts` StepEvent +=
`{kind:"progress_note"; text}`; `tools/todo.ts` += `PROGRESS_NOTE_MAX_CHARS
=400`, `normalizeProgressNote`, **`progress_note`** tool (emits the event;
present() = "progress noted" — text rides the event, not history; PARALLEL_SAFE);
`shared/chat.ts` note block += `progress?:true` + fold case; `shared/logging.ts`
turn `notes` entries += `progress?` + fold case + markdown `📣 **Progress**`;
`sidepanel/main.tsx` note render += `.is-progress` + `<span class="progress-pill">
Progress</span>`; `styles.css` `.info-line.is-progress` (soft-green bubble,
`--ok` tokens, left rail) + `.progress-pill`; `prompts.ts` BASE_RULES +=
"Progress reports (`progress_note`)" contract (batch work first, then report;
never two notes in a row). Full **`run_program` executor deferred** (documented
follow-up). Tests across todo/chat/logging/prompts suites.

## 8. Verification status (end of session)

- `npx vitest run` → **46 files / 839 tests, all pass** (≈45 added this session;
  baseline was 796 after steps 1–2).
- `npm run typecheck` → clean. `npm run build` → `dist/` "build 6573f2c-dirty".
- `npm run verify` → **ALL SUITES GREEN** (20): unit tests; phases 1–7
  (lifecycle, perception, actions, agent loop both providers, UI & policy,
  unlimited mode); chat & history; run logs; madman; evaluate_js vs CSP;
  iframes; **canvas editors (Docs playbook)**; capability parity
  (coords/upload/netlog/handoff); window isolation; image shelf & paste_image;
  **jev fast decisions**; coach lessons; **skills**; **live plan (todo_write)**.
- Smoke scripts pin nothing that was broken: only `scripts/skills-smoke.mjs:240`
  checks the SYSTEM PROMPT lacks "/export?format=txt" (still true).

## 9. Git state — UNCOMMITTED

25 modified: `docs/DEV.md`; `extension/src/background/agent/{loop,prompts}.ts`;
`extension/src/background/sw.ts`; `extension/src/background/tools/{coords,misc,
perception,todo,trusted-input}.ts`; `extension/src/content/actions.ts`;
`extension/src/shared/{chat,coords,logging,modes,protocol,skills}.ts`;
`extension/src/sidepanel/{main.tsx,styles.css}`; `tests/{actions,chat,coords,
evaluate,loop,prompts,todo}.test.ts`.
Untracked: `docs/{CORRECTNESS-BRAINSTORM,HUMAN-FLOW-PLAN,SPEED-BRAINSTORM}.md`,
`extension/src/background/tools/{docs,docs-op}.ts`, `tests/{docs-read,docs-ops}.test.ts`,
`conversation.md` (this file). ~1,900 insertions / ~85 deletions.
**Nothing was committed** — the user did not ask. If they want a commit, the
natural split: one commit for the whole human-flow pass (message style: see
`git log` — imperative, evidence-citing), or per-step commits.

## 10. Untested assumptions to watch in the field test (be ready to fix these)

The smoke suites use fixtures/mock LLM; **the new Docs tools have not run
against live docs.google.com**. Best-effort guesses that the field test will
confirm or break (all fail honestly with actionable errors):
1. `docs_op page_setup` field labels: "Paper size"/"Page size" select,
   "Top/Bottom/Left/Right margin" text fields, "Portrait"/"Landscape" radios,
   confirm ["OK","Save"]. If a label misses, the error names the label and the
   dialog stays open — fix = add candidates in `shared/docs-ops.ts` plans.
2. `page_numbers` submenu row labels: alternates ["Bottom of page","Footer"] /
   ["Top of page","Header"] (icon buttons; accessible names assumed).
3. `insert_table` grid picker: ArrowRight/ArrowDown/Enter keyboard drive
   (accessible route) + focus lands on the picker after the synthetic
   "Table" click. Verify check: export HTML contains `<table`.
4. `apply_style` verification needles: `<hN` for headings (solid);
   `class="title"` / `class="subtitle"` in export HTML (assumed Google export
   markup); toolbar style-box selectors for Normal text.
5. `docs_state` selectors (`[aria-label^="Styles"]`, `.kix-*-combobox`,
   `[aria-label^="Bold"]`/`[data-tooltip="Bold"]`, `[aria-label^="Mode"]`) —
   version-drifty; unreadable fields are reported, never guessed.
6. `docs_locate`: Docs intercepts trusted Ctrl+F (it should — same key path as
   Ctrl+B which is measured working); counter selectors best-effort (the
   screenshot shows the counter regardless).
7. `menu_path` synthetic content-script clicks on Google menus (same primitive
   as ref-based `click`, which works on Docs rows per the old skill).
8. Magnet on live pages: promotion only for ref'd controls ≤600×140 that are
   not editable/canvas/iframe; watch for any wrong-centre clicks on composite
   controls (report ⇒ tighten caps or exclusions).
9. Transport auto-recovery reloads the tab — Docs autosaves so content is
   safe, but any open dialog/menu state is lost by design (budget 2/run).
10. Whether the model actually adopts `progress_note` + batching per the new
    prompt rules (adoption is a prompt-tuning loop; M3 batching-rate stat is
    not built yet — count multi-tool turns from the log meanwhile).

## 11. When the user returns with new logs — analysis playbook

Ask for / locate the export (`~/Downloads/crazyagent-logs-*.jsonl` or the
attachment path they give). Then per run compute (python one-liners over the
single-line JSON record; §4 has the schema):
1. Headline: status, wall, turns, step-wall p50/p90, TTFT p50 by quarter,
   decode p50 split by `turn.thinking` level, thinking mix (off vs low),
   decode tok/s, cap-hits (reasoning>11k), failed calls by error tag,
   multi-tool-turn rate, "unchanged since" count, rework% (failed ∪
   correction-language ∪ guard tags), context p50/max, cachedInputTokens.
2. **New telemetry to grep for** (proves the shipped features fire):
   - `"BLOCKED — NOT EXECUTED"` (identical-call refusals — count; each ≈ a
     saved ~20 s grind turn), `"will NOT be executed"` (ban warnings).
   - `"snapped "` / `"aimed at the centre of"` (magnet corrections),
     `"treated as space:'screenshot'"` (reinterpret saves), `"the page scrolled
     since"` (compensation saves).
   - `docs_op`/`menu_path`/`docs_read`/`docs_locate`/`docs_state` call counts,
     failure steps, and `"verified:"` vs `"NOT VERIFIED:"` vs `"unverified"`
     lines → which label guesses (§10) need fixing.
   - `"auto-recovering (reload + one retry"` info events and whether the
     retry succeeded; `"TRUSTED-TYPES-BLOCKED"` / pre-screen refusals
     (`"assigns/parses HTML on a Trusted-Types page"`).
   - `progress_note` events (📣 in markdown export; `kind:"progress_note"` in
     JSONL) — count and cadence vs tool calls ("41 actions · 1 note" is the
     target shape).
3. Compare against baselines: B = 223 turns/29 min/5.7 s-turn (good case),
   C = 351/134 min/19.6 s (bad case), rework 11 % (C). Also check E1–E6
   classes: are the quoted failure sentences gone?
4. Remind/verify: run SOLO (concurrency doubled TTFT and broke Jev routing —
   T7 governance not built). Check `turn.thinking` mix — if it's stuck at
   `low` again, the J3/J4/D1/D3 speed fixes are the next work item.
5. `scripts/runlog-stats.mjs` does fixed-cost/tok-per-sec fits and multi-file
   side-by-side out of the box.

## 12. Open backlog, prioritized (my recommendation for next session)

**A. React to the field test first** (§10/§11): fix any docs_op/docs_state
label mismatches (candidates live in `shared/docs-ops.ts` +
`tools/docs.ts readField` selector lists); tune the magnet if it ever
mis-centres.
**B. Speed top-5 (untouched, measured 3× stakes)** — from SPEED-BRAINSTORM
"If only five": (1) thinking-off cascade: J3 gate resilience + J4 Jev-seeded
streaks (break the `reasoningChars<300` catch-22 in `isRoutineStep`) + D1
overrun factor 3→~1.5 with eager level-drop + D3 simple→off routing; (2) T1
prefix-cache verification (zero cache fields in 675 turns — try DeepSeek
native API / infer from TTFT-vs-context slope) + T6 TTFT hedging; (3) T7
concurrency governance (queue or second connection for run #2); (4) O1
execute-tool-calls-as-they-stream + O2 speculative gate pre-fire + O4 canvas
settle skip (generalize the 2.5 s docsTool branch: detect canvas once per tab
and skip the quiet-wait entirely) + J2 one Jev POST per batch; (5) R1 trace
replay/skill compiler (+R2 mid-sequence captures in input_sequence — the
prompt still forbids chaining clicks on not-yet-visible targets; a `capture`
step type would collapse menu walks further).
**C. Correctness follow-ups**: C6 generic effect verification (pixel-diff the
before/after shots every mutating action already produces → "⚠ no visible
effect" flags), C7 `expect_under`/`expect` param + pre-press check, C8
auto-undo (Ctrl+Z) on wrong-effect, C12 input_sequence auto-repair (object
step shapes, text-in-key → type, auto-split >24 — E3 still possible!), C15
host-pinned quirk lessons, C16 graded 32-item benchmark (assert per item on
exported HTML; track items-correct-first-pass), R8 auto-resume watchdog
(A died silently; alarm-based liveness + resume from checkpoint).
**D. Bigger builds**: run_program executor + panel sequence grouping
(HUMAN-FLOW §3), OCR offscreen indexer (Tesseract.js/native TextDetector in
the existing offscreen pattern) + text-anchored canvas clicks (§1 Stage 1),
docs_op `insert_image` (needs trigger-less file-chooser interception — the
upload tool's trigger_ref flow is the closest machinery) + `set_font`
(More-fonts dialog walk), Jev placements J5/J7/J9/J10 (completion checks,
failure arbiter, screenshot triage, observation Q&A — all ride the existing
gate POST), P3 persist compacted checkpoints (A's 1.83 M-char re-serialization
per step; also the OOM-death suspect).

## 13. Repo conventions a continuing agent MUST honor

- **Prefix-cache discipline**: `prompts.ts` system prompt is byte-stable per
  run; volatile clock rides `systemVolatile` at the END; per-run appendix
  (lessons + skills catalog) is a separate uncached block; skill BODIES reach
  the model only as `use_skill` tool results. Never put per-step-varying text
  in the prefix. Prefix is ~12–15 k tokens — adding prompt rules costs every
  turn of every run (T2 wants it smaller, so add sparingly).
- **Skill section budget**: `SKILL_SECTION_MAX_CHARS = 2000`, ≤12 sections,
  enforced by `tests/skills.test.ts` — trim when adding (bit me twice).
- **Tool checklist when adding one**: register in its module + `import
  "./tools/x"` in sw.ts; decide MUTATING_TOOLS (Jev gate), PARALLEL_SAFE
  (loop.ts), AUTO_OBSERVE_TOOLS + settle budget branch (sw.ts); `present()`
  for compact model-facing text (results clip at 400 chars in events,
  MAX_RESULT_CHARS 24 k in history); failure text via `failureTag`/
  `describeToolFailure` layers; unit tests for pure halves; smoke coverage if
  user-visible.
- Comment style: dense "why", cite the measured run that motivated it.
- Test conventions: vitest, pure shared modules tested directly; content
  actions under jsdom (`tests/actions.test.ts` pattern, `Actions` +
  `ElementRegistry`); loop via FakeLlm harness (`tests/loop.test.ts`);
  registry tools invoked via `toolRegistry.get(name).run(args, stubCtx)`.
- Loop invariants: refusals/notes ride tool-result text (in-band), never
  mutate the prompt prefix; Jev is fail-open everywhere; `invalid:true` is
  reserved for schema violations (3 in a row aborts a run).
- Verify before claiming done: `npm run typecheck && npx vitest run && npm run
  build` always; `npm run verify` (headless Chrome, several minutes) before
  handing back — it caught nothing this time but pins the smoke behaviors.

## 14. Quick file map (this session's surface area)

- Agent loop: `extension/src/background/agent/loop.ts` (guard, PARALLEL_SAFE,
  truncateHistory, reasoning cap, adaptive thinking, effort routing).
- LLM wires: `extension/src/background/agent/llm.ts` (body builders, thinking
  knobs, usage/cache parsing, SSE aggregators).
- Jev: `extension/src/shared/jev.ts` (wire+criteria+mappings),
  `extension/src/background/agent/jev.ts` (client, routeThinkingByJev),
  `extension/src/background/tools/jev.ts` (judge tool),
  `extension/src/background/policy.ts` (JEV_RISK/GATE_QUESTIONS, assess/assessWithJev).
- Gate/executor: `extension/src/background/sw.ts` (`executeToolGated` ~L1050+,
  `withTransportRecovery`, `withFailureShot`, AUTO_OBSERVE + settle budgets,
  run-start state resets ~L705–760, observeAfterAction/collapseRepeatObservation).
- Coordinates: `extension/src/shared/coords.ts` (pure), 
  `extension/src/background/tools/coords.ts` (CDP half + probeElementAt),
  `extension/src/content/actions.ts` (probeAt/snapNear/clickByText/fillField/
  queryText/label matcher), `extension/src/content/registry.ts` (INTERACTIVE,
  isEditableHost, refs).
- Perception: `extension/src/background/tools/perception.ts` (snapshot,
  settleTab, shot record/mapping, downscale, captureBlindShot, crop/zoom).
- Docs layer: `extension/src/background/tools/docs.ts` (docs_read/docs_state/
  docs_locate/fetchWorkspaceExport/parseWorkspaceUrl/exportUrl),
  `extension/src/background/tools/docs-op.ts` (menu_path/docs_op executor),
  `extension/src/shared/docs-ops.ts` (planner).
- Trusted input: `extension/src/background/tools/trusted-input.ts`
  (ensureTabActive, sendTrustedKey/Text, runTrustedInput),
  `extension/src/shared/trusted-input.ts` (parseKeyCombo, keyEventParams, planTyping).
- Plan/notes: `extension/src/background/tools/todo.ts` (todo_write,
  progress_note), `extension/src/shared/protocol.ts` (StepEvent),
  `extension/src/shared/chat.ts` + `extension/src/sidepanel/main.tsx` +
  `styles.css` (folds/rendering), `extension/src/shared/logging.ts` (runlog).
- Skills/lessons/prompts: `extension/src/shared/skills.ts`
  (CANVAS_DOC_EDITORS_SECTIONS), `extension/src/shared/lessons.ts`,
  `extension/src/background/agent/coach.ts`,
  `extension/src/background/agent/prompts.ts`.
- Failures: `extension/src/shared/tool-failure.ts`, `tools/misc.ts`
  (evaluate_js + Trusted Types + CSP).
- Analysis: `scripts/runlog-stats.mjs`; docs in `docs/`.

## 15. Suggested resume prompt (paste into the new session)

> Read `conversation.md` in the crazyAgent repo root, then `docs/HUMAN-FLOW-PLAN.md` §7.
> I field-tested the build; here are the new run logs: [attach]. Analyze them
> per §11 of conversation.md (compare against the 2026-10-06 baselines, grep
> the new telemetry: BLOCKED refusals, magnet corrections, docs_op verified/
> NOT VERIFIED lines, transport auto-recoveries, progress notes), tell me what
> improved and what broke, fix the label/selector mismatches from §10, then we
> pick from the §12 backlog.
