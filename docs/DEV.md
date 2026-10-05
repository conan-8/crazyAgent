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

## Run speed: what the logs priced, and what answers it

The run-log archive is the measurement instrument for this. Export it (**Run
logs → Export JSONL**) and every claim below is checkable per run: each turn
carries its wall-clock duration, each tool call its `durationMs`, and the final
stats line carries input/output tokens, context, `prefixTokens` and — when the
endpoint reports one — `cachedInputTokens`.

`node scripts/runlog-stats.mjs [export.jsonl …]` does that arithmetic for you
(no argument = the newest export in `~/Downloads`). Give it two exports and it
prints a before/after table — that is the check for anything here: export,
change one thing, export again, compare. On the whole 54-run archive it reports
78% of wall time in LLM round trips, 22% in tools, 1.01 tools per turn, and a
fitted 8.9s of fixed cost per round trip.

Fitting 442 turns from the archived post-fix runs gives

```
llm_ms ≈ 7,500 + 7.5 × output_tokens
```

i.e. **~7.5 s of fixed cost per LLM round trip** plus ~133 tok/s of generation.
78% of turns emitted under 500 tokens yet still cost a median 6.1 s, and the
runs averaged **1.04 tool calls per turn** — the fixed cost, not the work, was
the bill. Latency correlated with reasoning volume (r = 0.77) and *not* with
step index (r = −0.16), which is how we know prefill was not the problem.

Five changes answer that, in the order they were made:

1. **Cache telemetry** (`llm.ts`, `RunStats.cachedInputTokens`). `message_start`
   is now read on the Anthropic wire (the old code read only `message_delta`,
   which reports output only — so `inputTokens` was being zeroed on every real
   Anthropic stream) and `prompt_tokens_details.cached_tokens` /
   `prompt_cache_hit_tokens` on the OpenAI wire. Absent stays `undefined`:
   "the provider did not report a cache" must never render as "the cache
   missed". Run records also carry `provider`/`model`, because an exported log
   was previously unattributable.
2. **Batch-aware observation** (`sw.ts`). `LoopDeps.execute` now receives an
   `ExecuteBatch {index, count}`; the settle+snapshot observation runs only
   after the LAST call of a step instead of after every action in it.
   `OBSERVATION_MAX_CHARS` dropped 12k → 6k — that text is re-sent on every
   later step, so its size is not a one-off cost.
3. **Redundant-observation guard** (`sw.ts`). A `snapshot`/`read_page` whose
   result matches the last observation the model received collapses to one
   line. The snapshot is still taken (so nothing can be stale), and a truncated
   digest is never collapsed — two pages agreeing on their first N characters
   are not the same page.
4. **Fast steps** (`AgentSettings.batchActions`, Settings → Speed, default on).
   Swaps the prompt's step-shaping rules for a batch variant: one logical unit
   per step, and no separate verification step for an action whose result
   already ended with a fresh snapshot. This is a genuine tradeoff (less
   mid-sequence adaptation), which is why it is a switch — and it changes
   *only* the step-shaping rules, which `tests/prompts.test.ts` asserts by
   diffing the two prompts line by line. Every safety rule, gate and policy is
   identical in both modes.
5. **Quantized compaction** (`truncateHistory`). See below.

### Why compaction is quantized

A provider prefix cache matches on the longest byte-identical prefix of the
previous request, so what matters is where the FIRST difference sits. The old
sweep collapsed the single oldest message each time the budget was crossed —
advancing the rewrite point by a message on nearly every step, keeping the
first difference early and re-prefilling the bulk of the conversation every
step. `truncateHistory` now returns the history **completely untouched** while
it is under budget, and when it does compact it snaps the rewrite point to a
multiple of `HISTORY_COMPACT_QUANTUM` so it holds still and then jumps. Each
jump re-prefills only from that point onward, which is always near the end.

Measured over 60 simulated steps, mean byte-identical prefix fraction:

| observation | budget | old | new |
|---|---|---|---|
| 5 KB | 120 K | 0.640 | **0.929** |
| 2 KB | 80 K | 0.725 | **0.945** |

Budget adherence is unchanged — the compacted view lands within ~2% of the old
one — so this is cache stability bought without spending context.
`tests/loop.test.ts` asserts the property directly (mean cached fraction and
rewrite count), with the old numbers recorded in the test so a regression that
reintroduces creeping fails loudly.

### What is NOT a harness problem

Analysing all 155 `evaluate_js` calls from the archive: 89 were `await fetch(…)`
(347 s — real network round trips for document exports) and 46 were hand-written
DOM sweeps (310 s, one of them 40 s) scanning selectors like `span,div` across
Google Docs' DOM. `sendEnabled` already caches domain enables per tab, so there
is no per-call harness overhead to remove; the cost is the expression. That is
answered with a prompt rule against hand-rolled DOM sweeps and a stale
`navigate` description ("Follow with wait_for_settle") that contradicted the
auto-observe design and invited a wasted round trip after every navigation.

### The 2026-10-02 run: thinking was 52% of the wall clock

`crazyagent-logs-2026-10-02T04-18-28.jsonl` — one run, 317 turns, 349 tool
calls, **4,090 s wall**. `runlog-stats.mjs` prices it at 91% LLM round trips /
9% tools, a fitted **5.0 s fixed + 93 tok/s**, and 9,442,308 in / 226,077 out
(all estimated: the endpoint reported no `usage`, so the record is flagged
`tokensEstimated`). Prefix re-send accounts for 2.9 M of the input; the rest is
conversation.

The headline is on the output side. **196,918 of its 226,077 output tokens (87%)
were reasoning**, and the run had asked for `thinking: low` — a 1,024-token
budget. That is a **192× overrun**, and it is not the model misbehaving: the
OpenAI-compatible wire sent `reasoning_effort: "low"` and *no budget at all*,
and the big endpoints ignore `reasoning_effort`. `THINKING_LEVELS[].budget` was
only ever wired to Anthropic. Reasoning volume is what the wall clock tracked —
the 62 turns that thought for over 4,000 characters were **51% of the run's
wall**, two turns ran 98 s each on ~9,000 tokens of thinking, and the fast
episodes (5.5 s/turn) are precisely the ones with little reasoning.

Four changes answer it:

1. **The budget travels** (`llm.ts` → `buildOpenAiBody`). Non-strict endpoints
   now get `thinking_budget` both top-level and inside `chat_template_kwargs`
   (vLLM/SGLang/Qwen honour it; servers that don't, ignore it). **Off is now
   said, not omitted**: the old `if (level !== "off")` guard sent nothing at all
   for Off, and a reasoner left alone emits `reasoning_content` unprompted, so
   Off never actually turned thinking off on this wire. Both directions now emit
   `enable_thinking`.
2. **The loop enforces what the wire cannot** (`reasoningCapChars`,
   `completeWithRetry`). Reasoning deltas are counted as they stream; past
   `budget × 4 chars × REASONING_OVERRUN_FACTOR` (3) the connection is cut and
   the SAME step is re-asked with thinking off — reasoning streams before the
   answer on every wire we speak, so nothing but the thinking is lost. The cut
   is not a transient failure and burns no retry, but its tokens ARE added to
   `outputTokens`/`reasoningChars`, because they were generated and paid for and
   a capped run must not look cheaper than it was. Three overruns in a row flip
   thinking off for the rest of the run (`MAX_REASONING_OVERRUNS`): each cap
   costs a second round trip, so a model overrunning every step is paying double
   for a habit that is not paying for itself. The factor is deliberately loose —
   a tail-cutter for runaways, not a trimmer of ordinary thought, and a provider
   that honours its budget (Anthropic) can never reach it.
3. **`MAX_LIVE_IMAGES` 4 → 2**. Images were **1.87 M of 9.44 M input tokens
   (21%)** at a mean of 3.94 live per step — the slot was effectively always
   full, so every step re-sent four captures to answer a question about the
   newest one. Successive screenshots of the same page supersede each other, and
   the stale ones are exactly the "a screenshot showed a different page than the
   snapshot" conflict `BASE_RULES` has to warn about. A shorter window is also
   kinder to the prefix cache: retiring a capture rewrites the message that
   carried it and everything after re-prefills, so with fewer live images the
   retired capture is a more *recent* one and the rewrite point sits later.
4. **Three prompt rules the archive paid for.** `ONE CALL PER PAGE, NOT ONE PER
   VALUE` — 288 of 317 steps carried exactly one call and 157 of those were a
   lone `evaluate_js` fetching a single value (191 in total), each paying a full
   round trip; several facts from one document are one call returning an object.
   The no-pixel-reconstruction rule already existed and the run reasoned
   straight past it, because it wanted a *number* rather than a picture: turns
   303–316 spent **448 s (11% of the wall)** and 122 k reasoning characters
   digitizing one velocity–time graph, and the answer moved by less than the
   precision being chased. Reading a value off a chart is now explicitly
   sanctioned — once, at eye precision, then commit. Finally, when the TASK
   names another source as the authority ("send it to X and use the reply"),
   that answer is the deliverable: this run had it in 6 steps and spent 20 more
   re-solving the problem to second-guess it.

Prefix-cache reuse was *not* the problem here: replaying the run through
`truncateHistory` gives a mean byte-identical prefix of **86%** against the
previous request (~2,100 re-prefilled tokens per step), so the quantized
compaction is doing its job even though compaction fired on 266 of 317 steps.
The bill was the number of round trips and what each one generated.

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
- **Auto effort routing** (`AgentSettings.autoThinking`) — two tiers under one
  setting. At run start one choice question grades task complexity
  (`JEV_COMPLEXITY_CRITERIA`) and may LOWER `thinking` (simple→low,
  moderate→medium), clamped to never exceed the user's level; failure keeps it.
  **Per step**, the risk gate's existing POST carries two extra choice
  questions (`JEV_GATE_QUESTIONS` = risk four + `effort_next` + `progress`) —
  zero extra round trips. `effort_next` (`JEV_EFFORT_CRITERIA`: routine /
  careful / deep) grades how much deliberation the NEXT decision needs;
  `thinkingForEffort` maps a confident "routine" to thinking-off and a
  confident "deep" back UP to the user's ceiling (the one sanctioned raise —
  a "simple"-graded run can hit a hard step), everything else stays at the
  run baseline. The hint is one-shot (consumed by the very next step) and
  dropped on any surprise — failure, navigation, empty reply, overrun, user
  steering — so a wrong "routine" costs at most one cheap step. Gate state
  carries a tiny recent-call history (`buildRiskState`: 3 one-liners + this
  signature's repeat/fail counts) so verdicts are outcome-aware, not
  intent-guesses. `progress` (advancing / treading_water / stuck, floor 0.7)
  arms a one-shot coaching line that rides the next tool result via
  `StuckGuard.coach` — the semantic-loop catcher the string-equality repeat
  guard can't see (same intent, varied coordinates). The effective level per
  step lands on `turn_timing.thinking` (run-log `_timing:` lines) and
  applied/raised/dropped counters land in run stats — the rig that proves the
  payoff and exposes a gateway that ignores the knob.

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

## Image shelf & paste_image (screenshots into other pages)

The task shape that exposed the gap: "screenshot the question, send it to the
chat app in the other tab, come back and enter the answer." A real run
(archived in the log export) burned ~40 turns on it: `screenshot
save_to_disk:true` wrote a JPEG into Downloads, the model guessed
`/root/Downloads/q2_physics.jpg` (the real directory belongs to the browser's
OS user, and the sanitiser had renamed `.png` → `.jpg`), and
`DOM.setFileInputFiles` **reported success** with the path it never read —
`input.files` stayed empty on the page, three identical "attached 1 file(s)"
results in a row. Two structural facts drive the design that answers it:

- Image bytes can never round-trip through the MODEL (a base64 JPEG as a tool
  argument is ~500k tokens), so `upload files:[{base64}]` was never realistic
  for "send the screenshot you just took".
- Disk paths are guesswork the browser cannot verify for the model, and CDP's
  attach does not fail on a path it cannot read.

So the bytes travel **tool → tool inside the background**, and disk is out of
the loop:

- **The shelf** (`background/shelf.ts`) — every `screenshot` / `view_image`
  capture stages itself as `shot_N` (monotonic within the session, ring of 8,
  > ~9 MB skipped) and the tool result names the id. Pure core
  (`shelfStage`/`shelfFind`/`shelfSummaries`, `tests/shelf.test.ts`) + a
  `chrome.storage.session` mirror (`baShelf`) so worker teardown does not drop
  it; like the checkpoint, screenshot bytes never reach persistent storage.
- **`paste_image`** (`background/tools/paste.ts`, `sensitive`, gated under the
  existing `upload` rule so always-allow carries over; in `MUTATING_TOOLS`)
  resolves a shelf id (default: latest) and delivers:
  - `via:'file'` → the content-script DataTransfer upload (any frame, hidden
    inputs like Kimi's `0x0 .hidden-input` included) with real input/change
    events;
  - `via:'paste'` / `auto` → new `pasteFiles` content action: a synthetic
    `ClipboardEvent('paste')` carrying the image `File` (the constructor's
    `clipboardData` is probed, with a `defineProperty` fallback — a
    constructor that silently drops the payload would hand the page an empty
    paste), plus a `DragEvent('drop')` fallback for dropzone-only widgets.
    `defaultPrevented` is the honest acceptance signal and rides back as
    `handled`; when nothing consumed the event the result tells the model to
    retry ONCE with `via:'clipboard'` — never to re-capture or re-send
    blindly. A file-input target auto-delegates to the upload route.
  - `via:'clipboard'` → OS clipboard + **trusted Ctrl+V**. The MV3 worker has
    no document/focus, so the write runs in a transient **offscreen document**
    (manifest permission `offscreen`, reason `CLIPBOARD`,
    `src/offscreen/clipboard.{html,ts}`; `background/clipboard.ts` owns the
    create → message → close lifecycle, retrying the listener-registration
    race). It converts JPEG → PNG (`ClipboardItem`'s one reliable format) and
    tries `navigator.clipboard.write` first; measured on headless Linux, that
    refuses with "Document is not focused" (and can HANG — every primitive
    there carries its own deadline), so it falls back to the classic
    extension route: a selected `<img>` in a hidden contenteditable +
    `execCommand('copy')`, which `clipboardWrite` permits without a gesture.
    The Ctrl+V leg reuses the trusted-input pipeline (`ensureTabActive` +
    `Input.dispatchKeyEvent`), so the paste arrives `isTrusted: true`.
- **`upload paths` fails loudly now** — after `DOM.setFileInputFiles`, the new
  `filesOf` content action reads the input back; a count mismatch OR a 0-byte
  entry (what Chrome reports for a path it could not stat) returns
  `INPUT-FAILED` naming the read-back evidence and pointing at `paste_image`.
  The silent no-op that anchored the failed run cannot recur.
- **`screenshot save_to_disk` reports the absolute path** — it polls
  `chrome.downloads.search` until the item settles and returns
  `saved.path`, so "where did my file go" is answered by the tool, not
  guessed by the model.

Known limits: the synthetic paste is `isTrusted: false` — apps that reject
untrusted events need the clipboard route; whether a CDP-dispatched Ctrl+V
actually pulls the OS clipboard is environment-dependent (headless Linux has
no clipboard service — `scripts/paste-smoke.mjs` P8 SKIPs with the reason
instead of failing); the clipboard route reaches only the active tab's
focused frame, while `file`/`paste` run in the frame that owns the ref.

Tests: `tests/shelf.test.ts` (pure ring/lookup/summaries), `pasteFiles` /
`filesOf` in `tests/actions.test.ts` (jsdom needs a DataTransfer stub and a
files-setter stub — real-browser behavior is the smoke's job), policy/modes
additions, and `scripts/paste-smoke.mjs` (in `npm run verify`) against
`e2e/fixture/paste-target.html` — a chat-app shape: document-level paste
consumer (preventDefault = handled), a Kimi-style hidden file input, and a
dropzone that ignores paste (stopPropagation) so the drop fallback is
exercised. P1–P9 cover staging, all three routes, the gate (denial delivers
nothing), the unreadable-path failure, the absolute download path, and the
unknown-id error; P8 is best-effort by design.

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
  same reason. `upload` needs a real `<input type="file">` ref; a
  drop-zone-only widget goes through `paste_image` instead (its synthetic
  paste/drop route targets any element, and `via:'clipboard'` covers apps
  that reject untrusted events — environment permitting). Console/network
  capture covers only what arrived
  since the run started, and out-of-process iframe traffic may be missing in
  Standard mode.
- Lessons are per browser profile (`chrome.storage.local`, never synced) and
  capped at 300; one review covers one run (max 6 lessons), so a long broken
  thread is learned one turn at a time. Reviews are serialized and best-effort:
  a service-worker teardown mid-review loses that review, not the run or the
  lessons already stored.
