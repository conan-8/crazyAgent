# Developer guide

## Architecture (the two contracts)

Everything hangs off two type files in `extension/src/shared/`:

- `protocol.ts` — panel ↔ service worker bus (`PortRequest`/`SwToPanel`,
  `Checkpoint`, `StepEvent`). Long-lived port with a 20s ping while tasks run
  (keeps the MV3 worker alive); `checkpoint.ts` persists `{task, messages,
  stepIndex}` to `chrome.storage.session` after every step so worker teardown
  mid-task resumes instead of losing the run (`maybeResume`).
- `llm.ts` — provider-neutral messages/tool specs. `background/agent/llm.ts`
  translates to Anthropic Messages or OpenAI-compatible `/chat/completions`
  (both streamed SSE with tool calls; request shaping is pure and unit-tested).

The **tool registry** (`background/tools/`) is the agent's capability surface;
the agent loop (`background/agent/loop.ts`) and the panel's dev channel
(`run_tool`) both execute through `executeTool` in `sw.ts`, which selects the
transport by mode:

- `adapters/debugger.ts` — Standard mode (`chrome.debugger`).
- `adapters/cdp.ts` — Unlimited mode (native-messaging RPC to `helper/daemon.mjs`,
  full CDP over WebSocket; remote vs transport errors distinguished so daemon
  crashes respawn cleanly).

Perception and actions live in **content scripts** (`content/registry.ts`,
`content/actions.ts`) — one instance per frame including cross-origin
iframes — reached via `chrome.scripting.executeScript` in the shared isolated
world. Refs are snapshot-scoped (`frameId#n`); `registry.resolve` recovers
stale refs across SPA re-renders (CSS-path, then tag+text fallback) or fails
with an explicit "take a fresh snapshot" error.

Actions have **two routes**. The default synthesises framework-friendly DOM
events inside the frame that owns the ref. Canvas document editors ignore those,
so `type`/`key` can instead send real keystrokes and clicks over the adapter's
CDP session (`background/tools/trusted-input.ts`, with the pure key table and
routing decision in `shared/trusted-input.ts`) — see "Canvas document editors"
below for what was measured and why the split exists.

The **policy** (`background/policy.ts`) wraps agent tool calls: pure `assess()`
(classifies risk, optionally via a side-effect-free element probe) +
`ConfirmGate` (need_confirm round-trip over the bus, allowlist persistence).
When the Jev sidecar is configured, `assessWithJev()` merges Jev's risk
probabilities into the verdict — union-only: it can add a confirm the regex
rules missed, never remove one (see "Jev decision layer" below). A confirm Jev
raised is marked `jev: true` so the panel can highlight it pink.

**Chat & history** hang off `shared/chat.ts` — one pure event-folder
(`foldEvent`) consumed twice: the panel folds StepEvents into the visible
thread for live display, and the worker folds the same events into a persisted
`Conversation` (`background/conversations.ts`, `baConversations`, capped at
50). A conversation also stores the raw `LlmMessage[]` transcript, so typing
into an open thread continues with real multi-turn context (`run` carries
`conversationId`; the worker seeds the checkpoint messages from the stored
transcript). Deletion cancels any pending flush so threads can't resurrect.

**Run logs** (`shared/logging.ts` + `background/runlog.ts`) are the archival
counterpart: a second pure folder (`foldLogEvent`) turns the same StepEvent
stream into a timestamped record of the run rather than a display view. Where a
`Conversation` keeps only the folded blocks, a `LogTurnRecord` keeps, per turn:
`startedAt`/`endedAt`/`durationMs`, streamed reasoning, every tool call with its
raw args, result (truncated at 8 KB), per-call duration and ok/fail, madman
exclamations, confirmation prompts, errors and the final `RunStats`. Records
live in `chrome.storage.local` under `baRunLogs` (ring of 200, separate from
`baConversations`), so they survive worker teardown and browser restarts.
`emit()` folds + flushes on every non-token event; token deltas coalesce behind
a 1 s timer. A worker resume reattaches to the still-`running` record for the
same conversation instead of splitting one task across two entries. The panel's
**Run logs** drawer lists runs, opens a per-turn timeline (`logs.get`) and
exports a selection or the whole archive as JSONL or Markdown (`logs.export` →
Blob download into the browser's Downloads folder). Demo/echo runs are excluded.

## Workflow

- `npm run watch` rebuilds `dist/` on change; reload the extension at
  `chrome://extensions` (service worker + content scripts re-inject on next
  navigation; the panel needs a reopen).
- Every build stamps the built manifest's `version_name` with the git sha
  (`build/build.mjs` → `git rev-parse`, `-dirty` when the tree has uncommitted
  changes, `unknown` without git). The Settings drawer renders it
  (`shared/version.ts`), chrome://extensions shows it beside the version, and
  `capability-smoke`'s V1 check proves the loaded build names its own commit —
  so "did my reload actually pick up the new code?" is verifiable, not faith.
- `npm test` — vitest unit suites (protocol-adjacent logic is pure by design).
- `npm run verify` — the real-browser acceptance suite. Each
  `scripts/phase*-smoke.mjs` boots Edge headless with `--load-extension`
  (its own profile + CDP port), serves `e2e/fixture/` on :8790/:8791, runs a
  scripted **mock LLM** (`scripts/mock-llm-server.mjs` — real HTTP/SSE in both
  wire formats, one scripted turn per completed tool result) and asserts the
  phase's acceptance criteria. The panel page is driven over CDP via its
  `window.__ba` test hooks (same hooks the suite uses everywhere).

We deliberately use these CDP-driven suites instead of Playwright: they
exercise the real extension in a real browser, cover MV3-specific behavior
(worker teardown, native messaging, per-frame content scripts) that Playwright
wraps away, and need no extra browser download.

## Adding a tool

1. Register it in `background/tools/` with JSON-Schema `parameters` and an
   optional `present()` (compact text/image for the LLM).
2. Mark `sensitive: true` and extend `assess()` if it needs gating.
3. Add a unit test in `tests/` and, if it touches the page, a scripted turn in
   a phase smoke.

## Adding a provider

Implement `LlmClient` in `background/agent/llm.ts` (or reuse the
OpenAI-compatible client with a custom base URL), add request/response shaping
as pure functions and extend `tests/llm.test.ts`. Register the provider in
`settings.ts` + the panel's Settings drawer.

## Madman mode

A voice setting, not a behavior one. The toggle lives in `AgentSettings.madman`
and reaches the loop as `LoopDeps.madman`; everything else is in
`shared/madman.ts` (pure, unit-tested in `tests/madman.test.ts`). It works in
two halves: `madmanPrompt()` is appended to the system prompt so the model
writes in character, and `madmanLabel()`/`madmanExclamation()` decorate tool
cards deterministically, so "every tool call carries a cuss word" holds even
when the model forgets. `madman-smoke.mjs` proves all of it against a real
browser and a scripted mock LLM. Turning it off must leave the prompt
byte-identical to the pre-Madman prompt (`tests/prompts.test.ts` asserts this).

## The model's clock

`buildSystemPrompt()` ends with `timeLine(now)` — a local-time stamp
(`2026-09-24T18:34:22`, weekday, UTC offset, IANA zone) plus instructions to
resolve relative dates against it and to distrust stale page timestamps. It is
the model's ONLY time source: nothing else in the tool surface or history
carries a clock, so without it "next Tuesday", "expires in 3 days" and
staleness checks are unanswerable.

Two properties are load-bearing and tested:

- **Read per step, not per run.** `loop.ts` calls `buildSystemPrompt(…, now)`
  with a fresh `new Date()` inside the step loop, so a long run — or one
  resumed from a checkpoint hours later — sees the real time rather than the
  time the task started. This is why `now` is an injected parameter rather
  than `new Date()` buried in `prompts.ts`: the clock must be injectable for
  tests and variable per step.
- **Appended last.** The clock changes every call, so anything rendered below
  it would defeat the byte-stable prefix that provider prompt caching depends
  on. Only `Current task:` follows it. `tests/prompts.test.ts` asserts both the
  ordering and that the prefix above the clock is identical across steps.

`madman-smoke.mjs` (M6/M6b) proves the stamped line reaches the provider wire
in a real browser run, parseable and within minutes of now.

## Jev decision layer (System-One sidecar)

[Jev](https://docs.typesafe.ai/api) (TypeSafe's "System One" decision model)
runs **alongside** the selected chat model — it never replaces it. Jev
generates no text and calls no tools: one POST sends a `state` plus a map of
typed questions and gets back typed answers (`noul` = P(yes), `choice` = pick +
distribution + confidence, `score` = position on a rubric); all questions in a
request evaluate in parallel, so batching is latency-free. Off by default;
enabled with a key in Settings → **Fast decisions (Jev)**
(`AgentSettings.jev`, deliberately not an `ApiKeyEntry` connection).

**Two transports** (`JevSettings.transport`), chosen in Settings and resolved by
`createJevClient` (blank baseUrl/model fall back to the transport's defaults):

| Transport | Wire | Notes |
|---|---|---|
| `typesafe` (default) | `POST {baseUrl}/systemone` | Jev proper: calibrated, millisecond answers. Legacy stored blocks carry no transport and resolve here. |
| `openai` | `POST {baseUrl}/chat/completions` | Any OpenAI-compatible gateway, e.g. OpenRouter with an OpenRouter key. Questions are flattened into a prompt and answers are pinned by a strict JSON Schema generated per call (`JEV_OPENAI_SCHEMA_NAME = "jev_answers"`, `enum`-of-one instead of `const`, choice options enumerated so the model cannot invent one). The client rebuilds score legends from the rubric it sent and infers a missing `type` from the question, then parses with the same `JevAnswer` shapes. |

Why the second transport exists: OpenRouter lists TypeSafe as a provider but
routes no Jev model and implements no `/systemone`, so an OpenRouter key can
only drive the sidecar over chat completions. That path costs one model
round-trip per decision, so `JevClient` applies `JEV_CHAT_MIN_TIMEOUT_MS` (6 s)
as a floor under the callers' shorter time-boxes (the risk gate allows 2 s);
probabilities are model-estimated, not calibrated. Everything else — features,
gating, fail-open — is transport-independent.

Layers, all fail-open (a Jev outage degrades to the pre-Jev behavior):

- `shared/jev.ts` — pure wire types, request/response shaping for BOTH
  transports (bodies, answer schema, tolerant chat-completion parsing), state/
  question caps, `thinkingForComplexity` clamp. Unit-tested in
  `tests/jev.test.ts`; the client wiring over a stubbed fetch in
  `tests/jev-transport-wire.test.ts`.
- `background/agent/jev.ts` — `JevClient` (fetch + timeout; `decideWithRetry`
  for latency-tolerant callers), `createJevClient` (null = off), the run-scoped
  active-client holder (`setActiveJevClient`/`getActiveJevClient`, avoiding a
  tools→sw import cycle), and `routeThinkingByJev`.
- **Risk gating** — `executeToolGated` in `sw.ts`: mutating actions the regex
  rules *allowed* get one batched, 2 s-capped call with the four
  `JEV_RISK_QUESTIONS` (purchase / credential / irreversible / beyond_task)
  over a small literal state (`buildRiskState`: clipped task, digested args,
  probe summary — never screenshots). `assessWithJev` merges union-only at the
  `JEV_RISK_THRESHOLDS`; reuses the `purchase`/`password` rule ids so
  always-allow entries carry over. One `info` event per run on fallback.
- **`judge` tool** (`background/tools/jev.ts`) — the model's window onto Jev
  for bulk per-item decisions (relevance filters, best-of picks, rubric
  scores), collapsing N slow LLM steps into one near-free call. Only offered
  when Jev is configured (run's frozen `toolSpecs` filter in `runFrom`);
  `prompts.ts` adds the usage rule only when the tool is present, keeping the
  prompt byte-stable per run (provider prompt caching). In `PARALLEL_SAFE`.
  Per jaggedness guidance the description forbids arithmetic/counting/dates.
- **Auto effort routing** (`AgentSettings.autoThinking`) — at run start one
  choice question grades task complexity (`JEV_COMPLEXITY_CRITERIA`) and may
  LOWER `thinking` (simple→low, moderate→medium), clamped to never exceed the
  user's level; failure keeps it.

`scripts/jev-smoke.mjs` (in `npm run verify`) proves all paths against headless
Edge: the mock server also speaks `/systemone` and the chat-completions
transport (the latter recognised by the `jev_answers` schema marker, so it never
collides with the agent's own streaming calls; both scripted via `setJevScript`,
defaults noul→0.05). Known Jev weak spots (numbers, dates,
counting, adversarial content — the vendor's "jaggedness" doc) are designed
around: questions stay literal, math stays in code, and `beyond_task` carries
the highest threshold (0.85).

### Pink highlight (seeing when Jev was used)

Jev is invisible by construction — it returns no text and calls no tools — so
the UI marks every step it actually influenced. Two surfaces:

- **The `judge` card.** `loop.ts` sets `jev: true` on that `tool_call` event
  *from the tool name*, never from a model-supplied field, so the highlight
  can't be spoofed or forgotten. It flows through `StepEvent` →
  `chat.ts` `ToolCard.jev` → the `.card-jev` class and a `Jev · judge` chip.
- **A confirmation Jev raised.** `assessWithJev` stamps `jev: true` on the
  `Risk` it returns (only its own four branches, not the pass-through regex
  verdict), `ConfirmGate.request` forwards it onto `need_confirm`, and the card
  renders `.confirm-card.is-jev` with a "Jev flagged this" eyebrow instead of
  the neutral amber "Needs your approval".

Styling lives in one place: the `--jev*` token pair in `styles.css`, defined
for **both** the dark root and the `color-scheme: light` block, so the pink
never washes out in light mode. The highlight is always paired with the word
"Jev" — colour alone never carries the meaning (colour-blind users, greyscale
screenshots). `scripts/jev-smoke.mjs` asserts the flag on the wire, the classes
in the DOM, and that the token resolves to real pink in the live document
(J4b–J4d, J5b–J5c); `tests/jev-style.test.ts` covers the panel wiring, and
`tests/chat.test.ts` / `tests/policy.test.ts` pin that non-Jev cards stay
unflagged (`undefined`, not `false`).

## evaluate_js and page CSP (why it runs over CDP)

`evaluate_js` deliberately does **not** use `chrome.scripting.executeScript` +
`eval()` in the content script's isolated world — its original implementation.
An isolated world inherits the *extension's* CSP (`script-src 'self'`), which
forbids `eval` outright, and a page whose own policy omits `unsafe-eval`
(Google Docs, Schoology, most school portals) adds a second refusal. A real user
run showed the cost: **7 of 7** `evaluate_js` calls failed with
`EvalError: … violates the following Content Security Policy directive because
'unsafe-eval' is not an allowed source of script`, and the agent burned turns
retrying it on Google Docs while concluding the page was unreadable by script.

The tool therefore evaluates in the page's **main world over CDP**
(`Runtime.evaluate` + `allowUnsafeEvalBlockedByCSP`, `awaitPromise`,
`returnByValue`), which is not subject to that gate — the same mechanism a
DevTools console uses. Two supporting details:

- `BrowserAdapter.sendEnabled(tabId, domain, method, params)` (optional on the
  interface, implemented by both adapters) enables `Runtime` once per tab first
  and re-enables after a detach. `Runtime.evaluate`'s CSP handling is specified
  to apply while the domain is reporting execution contexts; enabling is
  idempotent and best-effort, so a domain that refuses to enable never fails
  the evaluation that follows.
- A CSP refusal is still possible (an older or managed browser that ignores the
  flag). When it happens the tool no longer hands the model a bare CDP string:
  `describeEvalFailure` prefixes it with `CSP-BLOCKED` and spells out the way
  out — retry once with `bypass_csp:true`, or switch to `read_page` /
  `snapshot` / ref-based actions, which never touch CSP — because the original
  wording is exactly what caused the retry loop. Real JS errors are *not*
  labelled this way, so an ordinary `TypeError` never triggers a CSP retry.

Known limits: `evaluate_js` is **top-frame only** (no `contextId` / `sessionId`
plumbing, so it cannot reach into an iframe — use the frame-scoped refs `3#12`
with the action tools for that), and `bypass_csp` still only lifts the policy
for documents loaded after the call.

`scripts/evaluate-csp-smoke.mjs` (in `npm run verify`) pins all of this against
headless Edge across four page shapes (the Google Docs directive, a nonce-only
`strict-dynamic` policy, a `<meta>`-declared policy, and no CSP) and — crucially
— still runs the OLD implementation side by side to prove it is refused, so the
fixture cannot silently stop reproducing the bug the tool was fixed for.

## Lessons / self-improvement (the coach)

The agent fails a lot, so it keeps a per-profile log of what it learned. A
**second agent on the same selected model** (`background/agent/coach.ts`, built
from the same `createLlmClient(settings)`) reads a finished run and writes
lessons that later runs read back. Nothing here can affect the run it reviews:
the coach has no page access, emits **no StepEvents** (so it never lands in the
chat thread or the run archive), and every failure path is fail-open.

Layers:

- `shared/lessons.ts` — pure core, unit-tested in `tests/lessons.test.ts`.
  `Lesson`/`LessonDraft` types and caps; `mergeLessons` (dedupe by normalized
  wording — bump `hits`, keep the stored text so a user edit is never
  clobbered — plus the 300 ring); `buildRunDigest` (task, outcome, every failed
  call with its error, repeats collapsed as `repeated N×`, confirmations,
  errors, a bounded step timeline and the final answer); `shouldAutoReview`
  (see below); `parseLessonDrafts` (the `record_lessons` tool call, or strict
  JSON in the reply text — fenced or embedded — with per-entry validation, a
  per-review cap and no fabrication: junk yields zero lessons plus a note);
  `rankLessonsForTask` + `formatLessonsBlock` (pinned first, then host-matched
  against the task text, then recency, capped by items AND characters);
  `lessonsToJsonl`/`lessonsToMarkdown` for export.
- `background/lessons.ts` — `chrome.storage.local` store under `baLessons`
  (per browser profile, like every other store): list/add/update/delete/clear
  and `markLessonsUsed` (stamps `lastUsedAt` on the lessons a run actually
  carried). Unit-tested in `tests/lessons-store.test.ts`.
- `background/agent/coach.ts` — `reviewRun` sends ONE turn: the coach system
  prompt, the digest as the user message, a single `record_lessons` tool, and
  `thinking: "low"`. `learnFromRun` orchestrates review → `newLesson` per draft
  → `mergeLessons` → injected `save`, and returns
  `added|empty|error` instead of throwing (storage is injected, so it is
  testable without chrome — `tests/coach.test.ts`).
- Wiring in `sw.ts` — `queueReview` **serializes** reviews (they
  read-modify-write one key) and `runFrom`'s `finally` calls `afterRun(record)`
  only after the record is closed and the checkpoint cleared. `maybeAutoReview`
  fires only when `shouldAutoReview` says the run went wrong — status `error`,
  a stopped run (detected from the loop's `stopped…` summary, since a stopped
  run is stored as `done`), any failed tool call, or a repeat of the same
  failing call — and only when the user's key and both `learn` switches allow
  it. Auto reviews are silent; manual ones (`lessons.review`, optionally with a
  `logId` from the Run logs drawer) broadcast `started` so the panel can spin.
- **Feedback into the prompt** — at run start `runFrom` ranks the stored
  lessons for the task and passes `formatLessonsBlock(ranked)` as
  `LoopDeps.lessonsBlock`, which the loop forwards as
  `LlmRequest.systemSuffix`. On the Anthropic wire that becomes a SECOND system
  block **without** a cache breakpoint, so the expensive cached prefix (base
  system + tools) stays byte-stable across runs while the appendix changes
  freely; OpenAI-compatible wires concatenate it onto the single system message
  (`tests/llm.test.ts` asserts both shapes and that the suffix is absent —
  byte-identical — when unused). The block is framed as reference material
  appended after the real instructions, so a stale or wrong lesson can never
  outrank the task or the agent's rules.
- Settings (`AgentSettings.learn`, `normalizeLearn`): `enabled` is the master
  switch (apply lessons AND write them), `auto` additionally reviews failed
  runs. Both ship ON — only an explicit `false` disables them, so profiles
  stored before the feature existed get it too.

`scripts/lessons-smoke.mjs` (in `npm run verify`) drives it against headless
Edge: a scripted failing run must produce exactly one review whose digest
carries the failure and the loop; the review must not consume the agent's
scripted turns or appear in the run archive/chat history; the next run's system
prompt must carry the lesson with the base prompt intact; a clean run must stay
unreviewed until asked; the drawer must render/edit/pin/export/delete; and each
switch must do what it says. The mock server recognises coach calls
structurally (by the `record_lessons` tool, which the main agent never has),
answers them from `coachScript` and logs them separately — so a review firing
after a failed run can never consume a scripted agent turn or perturb the
`requests()`/`lastRequest()` assertions the other smokes rely on.

## Frames and iframes (perception + evaluation)

A page's content is frequently **not** in the top document: Google Docs keeps it
in a kix frame, school portals embed Docs/Slides in iframes. Until this change
the snapshot computed every frame's text and then kept only the main frame's
(`text` was assigned only when `frameId === 0`), so the model could click a
button inside an iframe but could not read a word of it — the failure behind a
real run that stalled for dozens of turns on Schoology and Docs.

- `shared/frames.ts` (pure, `tests/frames.test.ts`) — `orderFrames` (main first),
  `buildFrameText` (main text, then every other frame's, each labelled
  `--- frame N (url) ---`, with a per-frame cap of 1.2 KB and a 4 KB total so one
  huge frame or a page full of ad frames cannot crowd out the document),
  `formatFrameMap` (id → host, so a ref like `9#12` is interpretable),
  `detectOpaqueSurface` (see below).
- The content script's `collect()`/`read()` also report `canvases` and
  `textChars` per frame, which is what lets the worker distinguish "empty frame"
  from "frame that paints into a canvas".
- **Canvas content is unreadable — and now says so.** The Google Docs editor and
  the Slides surface are `<canvas>`: there is no DOM text to extract, and every
  tool including `evaluate_js` returns nothing useful. Rather than coming back
  with a plausible-looking empty page (which invites retries), `snapshot` and
  `read_page` emit an explicit note that the content is canvas-drawn and no tool
  can read it.
- **`frames` tool** — lists every frame with its id, URL, title and whether it is
  readable, and records the id mapping below.
- **Two frame id spaces, joined by URL.** `chrome.scripting` reports frames as
  small integers that are NOT sequential (the cross-origin fixture comes back as
  `9`, not `1`) and refs are built from those; CDP identifies frames by 32-hex
  ids, and only CDP's execution contexts carry the form `Runtime.evaluate` needs.
  Neither can be derived from the other, so `collectFramePairs` gathers both
  (`chrome.scripting` + `Page.getFrameTree`) and pairs them on URL —
  `DebuggerAdapter.mapFrames` stores the result and `contextIdForFrame` maps a
  scripting frameId to a live execution context (re-resolving after navigation,
  and forgetting everything on detach).
- **`evaluate_js frame:N`** runs the expression inside that frame by passing
  `contextId`. An unresolvable frame fails with an explicit message instead of
  silently evaluating in the top document. `read_page` refreshes the pairing, so
  frame evaluation works right after the read the model just did.
- Unlimited mode needed one daemon change: `helper/daemon.mjs` now forwards
  `Runtime.executionContext*` events (`event: "cdp"` pushes on id 0), which is
  the only way contexts reach the extension over the native-messaging bridge.

Known limits: a frame the content script never reached
(`about:blank`/`srcdoc`/`data:` — the manifest has no `match_about_blank`) cannot
be read or evaluated; `read_page` now reports those as
`[no content script in this frame]` rather than as empty, and the frames tool
marks them `not readable`. Cross-origin frames are fine — what matters is that
the content script ran there.

`scripts/frames-smoke.mjs` (in `npm run verify`) proves all of it against the
real cross-origin fixture: iframe text reaches the snapshot, frames are listed
with URLs, `read_page` labels and flags them, `evaluate_js frame:N` really runs
inside the frame (verified against `location.port` and by proving the top
document cannot see the frame's element), an unknown frame fails loudly, canvas
content is signalled, and a plain single-frame page is unchanged.
`scripts/phase2-smoke.mjs` also asserts the fixture iframe's text now appears in
the snapshot digest.

## Canvas document editors (Docs / Slides) and tool-failure reporting

Two problems came out of the same real run ("type something into this Google
Doc"), and both are fixed and pinned by `scripts/docs-smoke.mjs`.

**1. Failures did not say which layer failed.** The model was shown the bare
string `fetch failed` — a thrown `TypeError`'s message — so it could not tell a
dead tab from a bad ref from a CSP refusal, and retried the same call until it
gave up. `shared/tool-failure.ts` (pure, `tests/tool-failure.test.ts`) now
classifies every failure into a layer and appends the next move:
`TRANSPORT-FAILED` (debugger/daemon link — reload the tab, do not hammer it),
`INJECTION-FAILED` (no content script: chrome://, PDF viewer, still loading),
`CSP-FAILED`, `FRAME-FAILED` (stale/unaddressable ref or frame), `INPUT-FAILED`
(bad arguments), `TOOL-FAILED`. `describeToolFailure` wraps every exit from
`executeTool` — including the validation and no-active-tab early returns that
used to bypass it — and never re-wraps a message that already carries guidance
(`evaluate_js` tags its own CSP refusals with `CSP_BLOCKED_MARKER`, shared with
the classifier so the two cannot drift). Advice is only appended when the
original message does not already give it, so Chrome's "take a fresh snapshot"
is not repeated twice.

**2. There was no procedure for a canvas editor.** The document body in Docs,
Slides and Office-on-the-web is painted into a `<canvas>`: there is no DOM text
and no expression can extract it. But typing *does* work — into a **separate
hidden editable element** (Docs' `docs-texteventtarget-iframe`) that appears in
the snapshot as an editable frame-scoped ref. `buildSystemPrompt` now carries
that procedure as `DOCUMENT_EDITOR_RULES`: the body is unreadable and must not
be retried; type into the sink ref, do not click the canvas; format via toolbar
refs or the editor's own shortcuts; and to *read* a document change the URL
first (`/document/d/<id>/preview`, `/mobilebasic`,
`/presentation/d/<id>/preview`).

**3. Synthesised DOM events cannot edit a canvas document.** The sink is a
scratch buffer for the browser's editing/IME machinery — the document model is
JavaScript, driven by real key events. So the content-script synthesizer
(`execCommand("insertText")`, or `dispatchEvent(new InputEvent(...))`) reaches the
sink but not the document: a dispatched event arrives `isTrusted: false` and is
ignored, and `execCommand` produces a trusted `input` with **no** `keydown` and
**no** `beforeinput`, which is not what an editing pipeline listens to.

What does work is the browser's own input pipeline — CDP `Input.*` — measured on
a real browser with both of this extension's transports:

| primitive | what the page receives |
|---|---|
| `Input.insertText` | `beforeinput(insertText)` + `input`, `isTrusted: true` |
| `Input.dispatchKeyEvent` Ctrl+B | `keydown(mod=ctrl)` + `beforeinput(formatBold)` |
| `Input.dispatchKeyEvent` Enter | `keydown` + `keypress` + `beforeinput(insertParagraph)` |
| `Input.dispatchKeyEvent` Backspace | `keydown` + `beforeinput(deleteContentBackward)` |
| `Input.dispatchMouseEvent` at x,y | trusted `mousedown`/`mouseup`/`click` on the canvas |

Two consequences worth remembering:

- **Standard mode is enough.** `chrome.debugger` permits the whole `Input`
  domain (`insertText`, `dispatchKeyEvent`, `dispatchMouseEvent`,
  `setIgnoreInputEvents`, `dispatchDragEvent`, `synthesizeTapGesture` all
  accepted). The helper daemon / Unlimited mode buys network interception and no
  banner — not the ability to type into Docs.
- **Input only reaches the ACTIVE tab's render widget, and a miss is silent.**
  On a background tab `Input.insertText` resolves successfully and nothing
  happens. That is exactly the shape of failure that sends a run into a retry
  loop, so the driver activates the tab (`chrome.tabs.update({active:true})` +
  `Page.bringToFront`), focuses the sink, *verifies* focus took, sends, then
  verifies focus survived. A target that would not take focus is retried once the
  way a person would — one trusted click on the document surface, which is how
  editors move focus into their own sink — and only then fails, pre-tagged
  `TRANSPORT-FAILED` with the next move. Losing focus *mid-type* is reported as a
  warning on an otherwise successful result, never as a failure, because a blind
  retry would duplicate whatever did land.

The split is `shared/trusted-input.ts` (pure: the key table and combo parser, the
typing plan, and `shouldUseTrustedInput`, unit-tested in
`tests/trusted-input.test.ts`) and `background/tools/trusted-input.ts` (the CDP
driver). `type` and `key` decide per call: one `focus` content action returns both
the focus the DOM path needs anyway and the frame's shape — hidden 1px editable,
inside a frame, canvas in the top document, `docs-texteventtarget` signature — and
the decision comes from those hints. Ordinary pages keep the DOM path, which
*replaces* an input's value and keeps React's value tracker happy; trusted
keystrokes *insert at the caret*, which is right for a document and wrong for a
form field. `trusted: true/false` on either tool forces the route. Newlines are
sent as real Enter keys, not as `\n` inside `insertText`: measured, the latter
splits a `<div>` but never emits `insertParagraph`, so paragraph structure would
be wrong. Keys with no CDP mapping (accented letters, emoji, CJK) fall back to
`insertText`, which is the correct primitive for them.

The fixture pair `e2e/fixture/canvas-editor.html` + `canvas-sink.html`
reproduces the shape locally (pixels on a canvas, keystrokes routed through a
hidden contenteditable in another frame), and the sink is **strict**: its
document model lives in the parent frame, is painted only into the canvas, and
accepts only trusted `beforeinput`/`keydown` — untrusted events are counted as
rejections, the sink's own DOM is emptied after every accepted event so nothing
can be read back from it, and `execCommand` is ignored exactly as an editor that
keeps its own model ignores it. The first version of this fixture accepted
synthetic events, which let a broken implementation pass; that is the regression
D3a–D3f now pin. `scripts/docs-smoke.mjs` proves: the canvas is declared
unreadable; the sink is exposed as an editable `N#1` ref; `type` into it lands in
the document *as trusted keystrokes with focus verified* (confirmed by the page's
own counter *and* by the top frame being blind to the sink, so it cannot have
gone the easy way); a newline starts a real paragraph; `Control+b` reaches the
model as a format command; synthetic DOM events are rejected and counted;
toolbar refs work with no DOM body; `page_health` reports each layer; bad
refs/arguments/unaddressable frames all come back classified; and typing into an
ordinary input on an ordinary page still takes the DOM path (D9 — the trusted
route must not hijack normal form filling).

**`page_health`** is the escape hatch for "several tools just failed": it
reports tab access, content-script injection and the debugger channel
separately, and says explicitly whether the page is unreachable or the failure
was tool-specific — so the model stops retrying and reports.

## Capability tools (coordinate input, upload, netlog, handoff)

The functional gaps where Claude in Chrome was ahead — coordinate clicks, file
upload, console/network reading, screenshot-to-disk, cheap perception on long
pages, and pausing for a human on login/CAPTCHA walls. Layout:

- **Coordinates** — `shared/coords.ts` is the pure half (arg shaping, the
  viewport↔page conversion, bounds checks, mouse-stroke plans; all pinned by
  `tests/coords.test.ts`); `background/tools/coords.ts` is the CDP half
  (`Input.dispatchMouseEvent` strokes, reusing `ensureTabActive` — input only
  reaches the active tab). Points are viewport CSS px, i.e. exactly the frame
  `screenshot` captures, so the model points at what it saw; `space:"page"`
  converts using the scroll offsets read in the frame that owns them. A
  point outside the viewport fails `INPUT-FAILED` **with the bounds**, never a
  silent miss.
- **Policy parity** — the content action `probeAt` reports what sits under a
  point (`elementFromPoint` + nearest interactive ancestor + its snapshot ref),
  and `probeElementAt` feeds that to the same `assess()` a ref-based `click`
  gets. The gate in `sw.ts` probes `click_at`/`drag_at` by point. The one
  honest gap (documented in THREAT-MODEL.md): a control *painted* into a canvas
  has no DOM text, so the purchase/form rules cannot read it.
- **Upload** — `upload` has two routes. Paths go through CDP
  (`DOM.setFileInputFiles`), reached by tagging the input with a token the
  content script can see and `DOM.querySelector` can find (refs only exist in
  the content script; this bridge is `uploadMark`). Inline `files` (text or
  base64) are built into a `DataTransfer` inside the frame that owns the ref,
  which also covers model-generated content and iframe inputs. New `upload`
  policy rule — always confirmed, names shown.
- **Console/network** — `background/netlog.ts` keeps per-tab ring buffers (500)
  fed through the adapters' `onTabEvent`; capture starts at run start and on
  the first read tool. `helper/daemon.mjs` forwards a **closed list** of
  Runtime/Log/Network events (a daemon change applies on the next native
  connection). Reads are honest about the limit: what arrived before capture
  started is simply not retrievable, and the tools say so instead of returning
  an empty-looking "clean" log.
- **Screenshot to disk** — `screenshot save_to_disk:true` writes via
  `chrome.downloads` with a sanitised basename (`shared/filenames.ts`), gated
  under the existing `download` rule.
- **Perception tuning** — `formatSnapshot` takes `filter`/`maxChars`/`frame`
  and `truncateWithNote` caps output; `read_page` takes `ref`/`depth`
  (depth-limited subtree walk) /`max_chars`. Every clipped render ends with a
  truncation note — a silent clip is indistinguishable from a short page.
- **Human handoff** — `shared/handoff.ts` decides (pure; `tests/handoff.test.ts`):
  a CAPTCHA widget of real size (the invisible reCAPTCHA badge on ordinary
  pages is deliberately excluded by a size filter) or an action targeting a
  sign-in form when the task never mentioned logging in. `background/handoff.ts`
  gates it (`HumanGate`, one prompt per URL per run, timeout → continue), the
  protocol grows `need_human` / `human.resolve`, and the panel renders a teal
  "Your turn" card. The gated executor returns `handoffMessage(...)` **in place
  of running the tool** — the model is told what happened and re-looks, instead
  of retrying a wall. Run logs record the pause (`handoffs`).

Tests: `tests/coords|handoff|netlog|filenames.test.ts` + policy additions, and
`scripts/capability-smoke.mjs` (22 checks C/U/N/P/S/H) against the fixtures
`e2e/fixture/canvas-click.html` (painted buttons that record where trusted
clicks land), `upload.html`, `console-net.html` (logs + fetch + the tiny badge
that must NOT count) and `captcha.html`. The smoke drives the **gated** path
through the `run_tool` port's `gated: true` flag (hook: `__ba.toolGated`), so
policy and handoff are exercised without standing up a mock LLM.

## Helper daemon (Unlimited mode)

`helper/daemon.mjs` — native-messaging host (4-byte LE framing) bridging RPC
to CDP WebSockets; ops: `ping/attach/launch/targets/cdp/intercept/quit`.
`helper/browser-agent-host` is the stable manifest entry (resolves `node`
explicitly — Chrome spawns hosts with a minimal PATH). `helper/install.sh`
writes `NativeMessagingHosts/*.json` for Chrome/Chromium/Edge/Brave;
`helper/profile-setup.sh` clones the default profile (Chrome 136+ refuses
`--remote-debugging-port` on the default user-data-dir).

## Known v1 limits

- CdpAdapter tab→target matching is by URL (same-URL tabs may alias).
- Intercept state is per page target: a cross-process navigation can drop
  mocks (same-origin navigations keep them).
- Packaging the daemon as a single binary (bun/pkg) is optional; node + the
  wrapper is the shipped form.
- `evaluate_js` cannot read content drawn into a `<canvas>` (Google Docs'
  editor, Slides' surface) — no tool can; the snapshot says so rather than
  looking empty. Frames whose content script never ran (`about:blank`,
  `srcdoc`, `data:`) can be neither read nor evaluated, and from the next
  navigation onward the /preview view of a Doc is the readable route.
- `click_at` places the caret on canvas editors and clicks painted UI, but the
  reading half is unchanged: canvas content has no DOM text (screenshot is the
  only read), and a canvas-painted button cannot be policy-classified for the
  same reason. Upload needs a real `<input type="file">` ref — drop-zone-only
  widgets are not supported. Console/network capture covers only what arrived
  since the run started, and out-of-process iframe traffic may be missing in
  Standard mode.
- Lessons are per browser profile (`chrome.storage.local`, never synced) and
  capped at 300; one review covers one run (max 6 lessons), so a long broken
  thread is learned one turn at a time. Reviews are serialized and best-effort:
  a service-worker teardown mid-review loses that review, not the run or the
  lessons already stored.
