# Google Docs editing & the "real cursor" plan — research notes

Source evidence: run `log_mukko4vj_1_lh0jml` (2026-09-28, standard mode,
`deepseek-v4.1-flash` via openai-compatible): **"type hello into the google
doc, then make it bolded" took 61 turns, 17m11s, 2.38M tokens.** The
Claude-in-Chrome trace the user pasted (table + image + comment) did the
equivalent in ~19 physical actions. This document is the gap analysis and the
implementation plan.

## 1. What actually went wrong (run-log evidence)

Five independent failures stacked up. Any one of them alone would have been
survivable; together they produced the 61-turn run.

### 1a. The content script was dead in frame 0 — and diagnostics lied about it

Turns 1–20 (~2.5 min) were pure flailing: `snapshot` returned completely
empty (not even a URL), `element_at`/`click_at` returned INJECTION-FAILED.
Only a manual `reload` (Turn 20) brought the page to life.

- Root cause: content scripts inject at page load only. The Doc tab predated
  the extension (re)load, so `__baRegistry`/`__baActions` never existed in
  frame 0. `runContentAction` (`tools/content-action.ts`) has **no
  inject-on-demand**: it executeScripts a lookup of `__baActions` and gets
  `"actions-not-loaded"`, surfacing as INJECTION-FAILED.
- `page_health` made it worse: it reported `content-script injection: ok (8
  frame(s))` and "All layers respond". Its probe is
  `executeScript(() => location.href)` (`tools/perception.ts:483`) — that runs
  fine in frames with **no** extension content script, because executeScript
  injects its own function. The `frames` tool (which checks `__baRegistry`)
  was telling the truth ("not readable"); `page_health` was not.

### 1b. `click_at` hard-gates on the content-script probe

Turn 18: `click_at (500,250)` → INJECTION-FAILED, even though
`page_health` showed the debugger channel (CDP) up, and the actual mouse
stroke (`Input.dispatchMouseEvent`) needs no content script at all.

In `tools/coords.ts`, `resolveTarget()` treats a failed probe as fatal. The
probe exists for (a) the policy gate (password/purchase/submit detection) and
(b) the "what did I hit" report. Neither justifies refusing the click: the
policy layer already accepts a null probe (`policy.ts:38`, rules only fire on
probe hits). On exactly the pages where coordinate clicking matters (canvas
editors), a dead content script currently makes the cursor unusable.

### 1c. The model typed per-character because it didn't know about no-ref `type`

Turn 36: `type ref:0#3 text:"ello"` → TRANSPORT-FAILED with a message that
literally says *"call `type` with the text and no ref (it finds and focuses
the sink itself)"*. The model then spent Turns 35–52 sending `key h`, `key e`,
`key l`, `key o` one turn at a time — dropping one `l` along the way
("helo"), then retyping all five.

The one-call machinery already exists: `type` with **no ref** →
`runTrustedInput` → `resolveNoRefFocus` → `editorSink` finds
`.docs-texteventtarget-iframe`'s contenteditable → `Input.insertText` of the
whole string (`tools/trusted-input.ts`). The `type` description says so, the
`canvas-doc-editors` skill says so ("WRITE WITH ONE `type` CALL AND NO REF") —
and the model never loaded the skill: **zero `use_skill` calls in the entire
run**, despite the host-pin catalog line for docs.google.com. Cheap models
ignore "load the skill when you see this host" hints.

### 1d. The model was blind: `deepseek-v4.1-flash` is text-only

Turns 12/14/57: "I can't see images." Screenshots were captured and forwarded
(`agent/llm.ts:249` forwards them in a trailing user message), but the model
could not perceive them. Meanwhile the system prompt claims *"every
`screenshot` call attaches the image to your context and you SEE it"*
(`agent/prompts.ts:20`) — false for this provider, and it cost several turns
of the model reasoning about pixels it never examined, plus ~2k tokens per
invisible screenshot per step.

The Claude-in-Chrome loop (screenshot → click coordinates → screenshot to
verify) is fundamentally a **vision** loop. Without a vision model, the
equivalent loop must be built from DOM signals (export fetch, aria-pressed,
`element_at` before/after hit reports) — which the tools mostly already
return.

### 1e. One LLM round trip per physical key

Even after the keystrokes worked, "hello" cost 5 turns and the re-bold
sequence ~10. Claude in Chrome's `Typed`/`Pressed Tab`×24 is one continuous
input stream; crazyAgent pays an ~11s median LLM round trip for each
`key`/`click_at` call. Verification then spiralled (Turns 43–61): export txt,
export html, `c0`/`c1` class archaeology, aria-pressed, screenshots it can't
see.

## 2. What Claude in Chrome does differently

From the user's pasted trace: `Clicked` / `Hovered` / `Typed` / `Pressed
ctrl+b` / `Captured page` after nearly every action. Three properties:

1. **It sees.** Every action ends with a screenshot the model actually
   perceives; menus, hover grids (table insert), and image pickers are all
   operable because they're visible.
2. **It acts at the input level.** Real mouse/keyboard on whatever is
   focused — no element refs, no DOM dependency for the stroke itself.
3. **Actions stream.** click → type → Tab → type … is one continuous
   sequence, not a round trip per keystroke.

crazyAgent already has #2's primitives (trusted `Input.*` pipeline). What's
missing is robustness when the content script is down (#1a/#1b), batched
sequencing (#3), vision honesty (#1d), and model knowledge of the Doc
playbook (#1c).

## 3. The plan

Ordered by leverage-per-effort. Items 1–3 are small, surgical, and would have
cut the 61-turn run to ~10 turns on their own.

### 3.1 Inject-on-demand in `runContentAction` (removes the reload dance)

When the lookup returns `"actions-not-loaded"`, inject the content-script
bundle programmatically into that frame
(`chrome.scripting.executeScript({ files: [content bundle], target: {tabId,
frameIds:[frame]} })`) and retry once. `content/main.ts` is already idempotent
(`__baContentLoaded` guard) and shares the isolated world with programmatic
injection by design (see its header comment). Fixes #1a at the source.

### 3.2 Best-effort probe in the coordinate tools (real cursor without refs)

In `tools/coords.ts` `resolveTarget()`: if the probe fails but the debugger
channel is up, proceed with the stroke and report
`hit: "unknown (no content script at this point)"` instead of failing. The
policy gate keeps working exactly as it does today for a null probe (risk
rules only fire on positive probe hits; `probeElementAt` already returns null
in this case). Fixes #1b. Same change for the `drags` list and `element_at`
(which should report "unprobeable" rather than refuse).

### 3.3 Fix `page_health` to measure the real layer

Probe `__baRegistry` presence per frame (what the `frames` tool does) instead
of `() => location.href`. Report "content script MISSING in N frame(s) —
re-injecting now" (and just trigger 3.1), instead of the false "All layers
respond".

### 3.4 `input_sequence` tool — batched physical actions

One tool, one ordered list, one observation at the end:

```json
{ "steps": [
  { "click_at": { "x": 500, "y": 260 } },
  { "key": { "key": "Control+a" } },
  { "type": { "text": "hello" } },
  { "key": { "key": "Control+a" } },
  { "key": { "key": "Control+b" } },
  { "wait_ms": 500 }
] }
```

Each step reuses the existing trusted-input/coords executors (tab activated
once, 12–16ms between strokes). This is the Claude-in-Chrome trace shape —
its 19 actions become 2–3 calls. Kills the per-key round trip (#1e) and makes
menu keyboarding (Alt+/ menu search, arrows, Enter) practical.

### 3.5 Vision-capability honesty

- Add a vision flag to provider settings (default: heuristic by provider —
  Anthropic yes, DeepSeek official API no — overridable).
- Text-only model ⇒ don't attach screenshot bytes (saves ~2k tokens/step on
  openai-compatible wires that forward images) and swap the prompt's "you
  SEE it" block for the DOM-verification equivalents (export fetch,
  aria-pressed, element_at after-hit). Also surface a one-time settings hint:
  "screenshot-based tasks want a vision model".

### 3.6 Make the skill actually get loaded (delivery, not content)

The `canvas-doc-editors` skill content is already right. The failure was
delivery. Two cheap mechanisms, both cache-safe (they ride tool results, not
the frozen prefix):

1. **Failure-triggered injection**: when a tool fails on a host-matched page
   and the skill was never loaded this run, append the matching section's
   body to the failure result once per run ("you are on docs.google.com —
   the canvas-doc-editors 'write' procedure: …"). Turn 36's TRANSPORT-FAILED
   would have carried the playbook with it.
2. **Host-match auto-outline**: at run start (or first observation on a
   matched host), put the section outline + the single most relevant section
   ("write") into the appendix when the host matches, rather than relying on
   the model to call `use_skill`.

Skill content updates from this run's evidence:

- "Snapshot COMPLETELY empty (no URL) on a Docs page ⇒ content script dead;
  reload once" (moot after 3.1, keep as fallback).
- "`type` with NO ref is the FIRST move on a canvas editor, not the
  fallback. Never per-key."
- Comment: `key Control+Alt+m` (no ref) then `type` the comment text.
- Table insert: menu search `Alt+/` → "table" → Enter, then arrows size the
  grid, Enter confirms (verify on a live doc; the hover-grid path via
  `hover_at` + `click_at` is the alternative).

### 3.7 `gdoc` tool (the dedicated Google Docs tool the user asked for)

Built by composing existing primitives; each op is ONE call and returns the
export read-back so verification is free (closes the 15-turn verify spiral):

| op | implementation | returns |
|---|---|---|
| `read` | `evaluate_js` fetch `/export?format=txt` (`format=html` for formatting) | doc text/html |
| `write {text, mode: append\|replace_all\|at_caret}` | `editorSink` focus + optional Ctrl+A + `Input.insertText` | export txt after write |
| `format {bold\|italic\|underline\|strike\|heading1..6, scope: selection\|all}` | trusted key combos (Ctrl+A / Ctrl+B / Ctrl+Alt+1…) | aria-pressed state + export html snippet |
| `insert_table {rows, cols}` | Alt+/ menu search → "table" → Enter → arrow-size grid → Enter (trusted keys) | export html table check |
| `insert_comment {text}` | Ctrl+Alt+M → insertText | ok + comment thread presence |
| `insert_image {url}` | clipboard-write image bytes → trusted Ctrl+V at caret (paste pipeline already exists: `paste.ts`) | ok |

`insert_image by web search` (what Claude in Chrome did) is a multi-page
flow — keep it as a **skill section** (open images.google.com → search →
first result → copy image → switch back → Ctrl+V) rather than baking a
brittle cross-page automation into the tool.

Policy: `write`/`format`/`insert_*` reuse the same sensitivity rules as
`type`/`key` (no new gate surface); `read` is read-only.

### 3.8 Expected shape of the failing task afterwards

"type hello into the google doc, then make it bolded":

1. `gdoc write {text:"hello", mode:"append"}` → returns `"hello"` (export)
2. `gdoc format {bold:true, scope:"all"}` → returns `aria-pressed=true` +
   `font-weight:700` in export html

**2 calls, ~15 seconds** — versus 61 turns / 17m11s / 2.38M tokens.

The user's bigger task (make a table, insert robot image, add "cool"
comment): ~5–8 calls — `read`, `write`/`insert_table`, image-search skill
flow, `insert_comment`.

## 4. Open questions to settle during implementation

- Does `Input.insertText` with a multi-KB string keep up with Docs' async
  processing, or does it need chunking? (`planTyping` already splits Enter
  into key events; measure one long insert.)
- Table-insert key path (Alt+/ menu search) on current Docs — needs a live
  test; the hover-grid fallback is `hover_at`/`click_at` once 3.2 lands.
- Does the openai-compatible gateway *reject* `image_url` parts for
  text-only models (400) or silently drop them? Determines whether 3.5 is
  optional or mandatory for DeepSeek endpoints.
- Null-probe clicks: confirm no confirmation-card regression on sensitive
  surfaces (policy rules key off probe text; null probe = no card, same as
  today's `probeElementAt` null path).

## 5. Non-goals

- Not replacing the ref-based path: refs remain the default everywhere they
  exist (safer, self-verifying). The cursor is for surfaces with no refs.
- Not a Docs-API integration: everything stays in the browser session the
  user already has (no OAuth, no API keys); the export-fetch read path is
  same-origin via `evaluate_js`.
