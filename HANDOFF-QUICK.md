# CrazyAgent — quick handoff

**2026-10-27 semantic role paths and Docs range tools.** Long-form history: `HANDOFF.md`
(§4 invariants, §15 session log). This file is the 2-minute version.

## 60-second resume

```sh
cd /home/conan/Documents/GitHub/crazyAgent
curl -s http://127.0.0.1:17871/health   # expect {"ok":true,"tools":true,...}
npm test                                 # expect 428/428
npm run system-prompt                    # exact current prompt
```

Then read `HANDOFF.md` §4 (invariants) before changing anything. The companion is
running; restart it after provider/config changes. The unpacked extension MUST be
reloaded and the panel reopened after `extension/` changes.

## Current build

| Item | Value |
|---|---|
| Commit | `7b29950` plus the current uncommitted semantic-tool work |
| Tests | **428/428**; setup/system-prompt composition and isolated Edge click/advanced/canvas suites pass; live Docs acceptance of the new tools is still pending |
| Tools | **27 model-facing** (17 general + guarded `browser_docs`, `browser_docs_format`, `browser_docs_format_many`, `browser_docs_page_setup`, `browser_docs_read`, `browser_docs_rename`, `browser_docs_replace_text`, `browser_docs_replace_many`, `browser_docs_select_text`, `browser_docs_write`) |
| Companion | running, PID in `logs/companion.pid`, health `tools:true` |
| Extension | unpacked `extension/`, ID `kmipadgipilkdidennbhcgmoolfedgph`; reload required |
| Model | OpenRouter `deepseek/deepseek-v4.1-flash-1017`, reasoning `auto` = low from step 1 |
| Prompt | persona (`config/browser.patch.yml`) + provider `GUIDANCE`; print the current text with `npm run system-prompt` |
| Compaction | `thresholdRatio 0.55`, `headroomTokens 131072`, `retainTokens 20000`, `maxTokens 8192` → fires ~577K |
| Limits | no per-turn cap; 3 consecutive mutating repeats, 30 observation, 10 unmodified navigation; session/user-message reset; 8 s reconnect grace |
| Analysed runs | `turn-mvq5svlp-9082` (459.401 s/87 calls/17 failures), `turn-mvq767wv-db2f` (716.410 s/149 calls/41 failures) |
| Token / key | `.dsh-home/browser-agent/token`, `.dsh-home/browser-agent/api-key` (0600; never commit) |
| Ports | bridge 17871, fixtures 17872, Edge e2e 9228 click / 9230 canvas / 9231 advanced / 9233 work |

## Semantic role paths and Docs ranges (2026-10-27)

- `browser_click_role` takes `{path:[{role,name}]}` with 1–4 exact, case-sensitive role/accessible-name steps. It waits for menus and revalidates targets internally, then returns one final full view. It targets page chrome only, never editor content. Dispatch/path completion is not application-outcome proof; `ROLE_CLICK_UNSETTLED` is not safe to retry.
- `browser_docs_select_text` takes exact `text`, optional `occurrence:"first"|"last"` or a positive integer, and `scope:"text"|"paragraph"`. Omitted occurrence requires uniqueness; there is no `all` or persistent multi-select. Its text-only result carries Find-counter evidence and no screenshot.
- `browser_docs_format_many` takes 1–50 ordered edits, the same occurrence semantics, and eight attributes (`paragraph_style`, `font_size`, `bold`, `italic`, `underline`, `font`, `color`, `highlight`). Baseline/final exports verify targets and collateral, including `href` and list metadata, with paragraph-style inheritance handling. It returns per-edit results and one final view, stops at the first failure, and has 600 s executor/660 s provider budgets.
- Overlapping edits, `paragraph_style` on `LI`, and opaque structures such as tables fail closed. No generic Docs mutation batches are unlocked. `DOCS_UNSETTLED` is not safe to retry: allow the tab to stabilize, then inspect by export before any further mutation.
- Verified: **428/428**, `npm run setup`, composed system prompt, and isolated Edge click/advanced/canvas suites after role hardening. **No live Google Docs acceptance yet for these tools.** Reload the normal unpacked extension, reopen the panel, and run `e2e/checklist.md` from fresh disposable documents at medium effort.

## Feature-document root fixes (2026-10-27)

- Both analysed runs failed valid initial writes at the second color operation because hidden stale custom-color dialogs were counted as active Hex fields. The probe now selects one usable visible field and still rejects genuine ambiguity.
- Repeat fingerprints leaked across same-numbered turns in separate chats and across unrelated successful actions. They now reset by session/user message and after a different successful mutation; consecutive repeats remain blocked.
- Export divergence polling uses bounded increasing delays and at most six verification reads in the tested worst case, rather than about 32 in eight seconds. Per-document/format exports are serialized with a 250 ms successive-request gap and shared 429/503 cooldown, including after final failure.
- The Brag Sheets run also proved collapsed More controls can be absent even when list shortcuts work. The executor now reveals and reads exact pressed state before list insertion, including controls in the overflow popup outside the main toolbar.
- The newest Feature Test attempts hit Page setup orientation verification and left the dialog open. It now detects label-linked radio inputs, resumes an existing dialog, and makes one fresh bounded OK retry after a close timeout.
- A later bad run also produced many malformed write blocks. The schema now uses `const:true` for standalone `blank`/`page_break`, forbids blank/formatting combinations, and requires every `items` array to pair with `list` and vice versa.
- `browser_docs_write` adds verified page breaks and checked checklists. New `browser_docs_page_setup` verifies paper, orientation, and margins before OK. The target live path is rename + page setup + one write, not manual recovery.
- First capture timeout focuses the window once and retries; only a second timeout opens the 30-second circuit. Full tests are **428/428** and profile composition passes. Real acceptance remains unclaimed until fresh independent runs.

## Guarded compound Docs formatter (2026-10-26)

- **`browser_docs_format`:** first call for supported exact-range formatting; forwards
  `op:'docs', action:'format'`. Requires exact unique `text` plus at least one of
  `paragraph_style` (Normal text, Title, Subtitle, Heading 1–6), integer `font_size`
  1–400, desired-state `bold`/`italic`/`underline` (`false` removes emphasis), or exact
  visible `font` (maximum 100 chars). Paragraph style affects the containing paragraph.
- **Execution:** one Find selection, per-tab lock and stale-tab checks, fixed order
  paragraph style → size → bold → italic → underline → font, dependency rereads,
  no-op skipping, per-attribute verification, and one final view. Font-size Enter
  requires verified field focus/value. Missing/duplicate text fails before formatting.
  Missing font never deletes; earlier changes produce `partial` with `results`/`failure`.
  Other failures stop and name earlier verified changes and the current unverified attribute.
- **Scope:** `browser_docs` remains font-only; replacements are unchanged. No generic
  Docs batch unlocking or replacement+format combo. Guidance also uses one `browser_type`
  for contiguous prose/newlines once the caret is known.
- **Verification:** full `npm test` passes **289/289**, composed-prompt validation
  includes the new tool, and the real-extension canvas suite passes. Real-Docs acceptance
  is still pending. Pre-change real-log baselines (Title/Subtitle compound: 43 model
  steps/111.7 s; one font size: 5 steps/13.2 s) motivate the tool but do not prove improvement.

## Compound Docs writing and safe composition (2026-10-26)

- **Model steps:** `maxParallelToolCalls:4`, but only `browser_tabs`, `browser_read_text`,
  and `browser_docs_read` are parallel-safe. All mutations remain exclusive in model order.
  Guidance emits already-known calls for one logical unit in one assistant response and
  does not re-check evidence already returned. Registration logs derive the actual tool list.
- **`browser_docs_write`:** appends at document end (fresh docs included), never arbitrary
  caret/top insertion. Accepts up to 50 blocks/20,000 chars: formatted single-line
  paragraphs, mixed inline `runs` (1–100 per paragraph), flat numbered/bulleted groups
  of 1–100 items, or `{blank:true}`. Validates every block/run first, resets inherited
  formatting, and sets font, size, emphasis, six-digit hex color, and highlight before
  each text run. Numbered/Ctrl+Shift+7, bulleted/Ctrl+Shift+8, and checklist/Ctrl+Shift+9
  modes verify exact pressed state; two Enters exit and list mode must be off. Checklist
  items support `{text,checked}`, with Ctrl+Shift+Enter on the intended new item.
  `{page_break:true}` inserts a verified page break. No nesting, existing-list conversion,
  or blind retry.
- **Verification:** baseline color state comes from the document-end run, avoiding
  unnecessary default color dialogs. List shortcuts verify `aria-pressed` even for
  overflow-hidden controls, without clicking them. Frame-aware editor focus plus an export
  position check runs before any formatting; `DOCS_WRITE_POSITION` stops before collateral
  edits. Baseline + bounded increasing-delay export convergence then checks the preserved
  prefix and every appended block/run (exact text, styles, list order/type, checked state,
  page breaks, emphasis, font/size, color, highlight). Divergent appended content gets up
  to 8 seconds of read-only export retries (six reads in the tested worst case); persistent
  divergence, empty list items, and collateral prefix changes are partial/failed.
  Font menus deduplicate only usable equivalent same-menu rows; conflicting menus still fail.
  Returned outline covers appended content. Full `npm test` is **428/428** and profile
  composition passes.
  The first live writer run reached a **correct final document but was not accepted**:
  **81.545 s/23 model steps/22 tool calls**, three failed calls (duplicate Playfair rows
  and two malformed writes), one partial rewrite, and manual font/size recovery. A
  post-run HTML export passed **9/9** independent checks, including the unchanged sentinel;
  no collateral edits were detected. Run `run-2026-10-26T15-27-12-284Z-8e546f`, turn
  `turn-mvpg78n0-97ba`, medium effort, `deepseek/deepseek-v4.1-flash`. The pre-change run
  was **19.5 min/230 steps/137 key presses**; one recovered run is not repeated proof of
  one-call reliability or speedup. Follow-ups also remained unaccepted:
  `turn-mvpt4xjj-48c1` **146.149 s/43 steps/42 calls** hit default-color and list failures;
  `turn-mvptd4bw-6062` **100.566 s/37 steps/36 calls** hit overflow-hidden list controls;
  `turn-mvptzvus-61a8` **211.834 s/28 steps/27 calls** merged the sentinel with Release
  heading, later repaired. Those motivated baseline color init, overflow-aware pressed state,
  frame-aware focus, and the pre-mutation position check. A later setup
  (`turn-mvpuldri-6329`, **167.951 s/58 steps/65 calls**) hit focus/capture failures with
  an empty doc. The newest build has no clean acceptance: the panel is connected but stuck
  at 0 px, blocking both five-block and mixed-inline runs. Unit/canvas green is not proof.
- **`browser_docs_read`:** authenticated export without navigation/page JS/debugger or a
  screenshot; `outline` (default), `text`, or bounded `html`. Strict current-doc URLs,
  bounded timeout, at most two 429/503 retries, explicit truncation. It is read-only,
  parallel-safe, and in the observation-tool repeat category.

## Speed and reliability pass

- **`browser_docs.set_font`:** unique find + exact role/name controls + direct or
  More fonts add→close→reopen→apply + toolbar verification, all inside the
  extension. One model call and one final view per line, not blind batching.
- **Capture circuit:** 5 s watchdog on every Chrome capture; the first timeout
  focuses the owning window and retries once. A persistent second timeout opens
  the 30 s fail-fast cooldown; normal captures do not change OS focus.
- **Wait rule:** explicit `timeout_ms < ms` rejected before sleep; omitted
  timeout expands to cover `ms` and the bridge adds 10 s.
- **Quiet UI:** successful auto-captures no longer append the verbose telemetry
  row. Tool screenshots, thumbnails, errors, and debug metadata remain.

## Earlier repair (2026-10-23)

- **Google Docs/Sheets/Slides:** one action + full fresh view; no dependent mutating
  batches or coordinate bursts; newest-view/pre-dispatch coordinate guards; labelled
  ARIA font menus; no lookalike stale-label click/type retry; `press_key.repeat` removed.
- **Honest canvas outcomes:** typing is dispatched, not delivered; selection is
  unverified until seen. Aggregate DOM text/mutations cannot invent success or chars.
- **Sidebar thinking:** Auto requests low for every classification from the first step;
  manual Off remains available. Later-step committed-reasoning fallback is fixed.
- **Verified:** 252/252 unit tests, profile composition, tools + live + states UI
  previews (including hidden auto-capture telemetry), and real Edge canvas/form suites.
  Real Google Docs still needs the user's manual acceptance test.

## Earlier work (2026-10-22)

- **Hardening:** compaction trigger 6%→55%, reasoning classifier + mid-turn escalation,
  loop/step guardrails, mid-turn image cap, off-screen/stale-scroll reporting,
  no force-scroll clicks, `AMBIGUOUS_TAB`, composite key chords, stale-label hints,
  side-panel reconnect grace, `SIDE_PANEL_CLOSED`.
- **Clipboard:** `browser_clipboard` copy/read/write/clear/paste; virtual clipboard in
  `chrome.storage.session` (default) + opt-in system clipboard; permissions added; e2e.
- **Stop button:** `■` sends `chat.stop`; companion interrupts the DSH runtime (no SDK
  cancel exists) and resumes the same session on the next message. **Live-validated**
  in the latest run: turn interrupted, `TURN_STOPPED` logged, session resumed ~20 s later.
- **UI:** live-activity pane fills the top of the sidebar (55/45 split) + expand-to-full-height.
- **System prompt v3:** user authority (no refusals/moralizing/third-party-rule enforcement,
  including "no AI" rules), haste rules (act first, no preamble, fastest views, verify only
  claims, 1–3 bullet answers), v2 refinements (destructive-action guard, blocked-by-user,
  two-attempt stop, clipboard secret guard, final-answer contract). Reliability-only guardrails
  remain. `npm run system-prompt` prints the exact text.

## Latest real-run signal (post-change smoke test)

10 turns, **400.9 s** total, 75 tool calls, 17 tool errors — much faster per turn than the
pre-hardening 32 min/11 turns. Fired correctly: `TURN_STOPPED` + resume, `LOOP_DETECTED`,
stale-label hints, 3 mid-turn image offloads, 1 reasoning escalation.
Observed issues to fix next: **6× `browser_click_at requires x and y, or a non-empty points
array`** (model sends empty click_at args, likely malformed batch/arg shape), 2 side-panel
disconnects (>8 s), expected `PROTECTED_PAGE` on a Chrome-blocked tab, 1 page-label failure.

## Risks / not fully validated

- System-clipboard **rich Ctrl+V** needs a focused OS window; virtual clipboard is verified.
- Stop resume works live, but if a resume ever fails it falls back to a fresh session (logged).
- Prompt stance removes the agent's own refusals; **upstream model/provider policy can still
  refuse** — switch model/provider if that happens.
- System prompt is ~2.5K tokens; keep an eye on total prompt size.

## Suggested next work order

Before further formatter optimization, reload the normal unpacked extension and repeat the focused real-Docs scenarios in `e2e/checklist.md`, including ordinal selection, multi-range formatting, and the combined role-path scenario; neither unit/fake-driver tests, the real-extension canvas suite, nor the pre-change baselines establish live Docs acceptance.

1. **Fix `click_at` empty-args failures** (6 in the latest run): require exactly one of
   `x/y` or `points` at the schema level/serializer, normalize/repair in batch, clearer error,
   add a test. Cheap, high frequency.
2. **File upload** (pathless `DataTransfer` for `<input type=file>` + user-attached companion
   picker) — still the biggest capability gap ("add an image" class of tasks).
3. Exact role/name menu paths are implemented in `browser_click_role`; generic batches that
   cross other reveal boundaries remain open, alongside native dialogs, drag/slider/right-click,
   and downloads/popups.
4. Skill/recipe layer + durable task scratchpad; animation observation primitives
   (pixel-change watcher / frame bursts) for reaction-style tasks.
5. Auto per-run `summary.md` cost/latency attribution and budget alerts.

## Don't

- Don't fork DSH core; don't hand-edit `.dsh-home/browser-agent/llm.patch.yml` (generated).
- Don't `pkill` by browser executable path — kill only PIDs/PGIDs you started (an
  isolated-E2E cleanup once closed a normally-running Edge).
- Don't run the live agent (API key spend) in tests; use the fake-bridge/node tests or an
  isolated Edge profile + fixture server.
- Extension changes need a `chrome://extensions` reload + panel reopen; provider/companion/config
  changes need a companion restart; run `npm run setup` to validate profile composition.