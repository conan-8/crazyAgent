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

The **policy** (`background/policy.ts`) wraps agent tool calls: pure `assess()`
(classifies risk, optionally via a side-effect-free element probe) +
`ConfirmGate` (need_confirm round-trip over the bus, allowlist persistence).
When the Jev sidecar is configured, `assessWithJev()` merges Jev's risk
probabilities into the verdict — union-only: it can add a confirm the regex
rules missed, never remove one (see "Jev decision layer" below).

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

## Jev decision layer (System-One sidecar)

[Jev](https://docs.typesafe.ai/api) (TypeSafe's "System One" decision model)
runs **alongside** the selected chat model — it never replaces it. Jev
generates no text and calls no tools: one POST to `{baseUrl}/systemone` sends a
`state` plus a map of typed questions and gets back calibrated answers
(`noul` = P(yes), `choice` = pick + distribution + confidence, `score` =
position on a rubric); all questions in a request evaluate in parallel, so
batching is latency-free. Off by default; enabled with a TypeSafe key in
Settings → **Fast decisions (Jev)** (`AgentSettings.jev`, deliberately not an
`ApiKeyEntry` connection).

Layers, all fail-open (a Jev outage degrades to the pre-Jev behavior):

- `shared/jev.ts` — pure wire types, request/response shaping, state/question
  caps, `thinkingForComplexity` clamp. Unit-tested in `tests/jev.test.ts`.
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

`scripts/jev-smoke.mjs` (in `npm run verify`) proves all four paths against
headless Edge: the mock server also speaks `/systemone` (scripted via
`setJevScript`, defaults noul→0.05). Known Jev weak spots (numbers, dates,
counting, adversarial content — the vendor's "jaggedness" doc) are designed
around: questions stay literal, math stays in code, and `beyond_task` carries
the highest threshold (0.85).

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
- `evaluate_js` runs in the isolated world (not the page's main world).
- Packaging the daemon as a single binary (bun/pkg) is optional; node + the
  wrapper is the shipped form.
