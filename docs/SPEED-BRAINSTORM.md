# Speed brainstorm — what the 2026-10-06 logs say, and every idea worth trying

Three runs, same build (`6573f2c`), same gateway (`openai-compatible`,
`deepseek-v4.1-flash`), same 32-item Google Docs "Feature Test Document" task
family. This doc is the deep brainstorm: first the evidence, then every idea,
grouped, with expected payoff and cost. Numbering is stable (J*/R*/T*/D*/O*/P*/M*)
so ideas can be referenced from commits and follow-up docs.

## 0. What the logs actually show

| Run | Started | Wall | Turns | p50 wall/turn | TTFT p50 | decode p50 | thinking level mix | Outcome |
|---|---|---|---|---|---|---|---|---|
| B (…32-55) | 18:10, **solo** | 29 min | 223 | **5.7 s** | **3.1 s** | **0.6–2.4 s** | 70 % `off` | done |
| A (…32-45) | 19:17, overlapped by C | 76 min | 201 | 20.3 s | 7.2 s | 6.0 s | 99 % `low` | **SW died silently mid-turn 200** (status stuck `running`) |
| C (…32-22) | 19:23, overlapped A | 134 min | 351 | 19.6 s | 8.2 s | 4.9 s | 99 % `low` | done |

Anatomy of a 20 s turn in A/C: **TTFT 7–8 s + decode 5–6 s + tool phase 1.5–3 s**
(action + Jev gate + settle + snapshot + screenshot encode). LLM latency is
~80 % of wall clock; the tool side is 6–20 %.

Findings that matter:

1. **Concurrency doubled TTFT and halved decode speed.** A and C ran against the
   same gateway at the same time; B (solo) saw 3.1 s TTFT, A/C saw 7–8 s, and
   decode throughput dropped from ~150 tok/s to ~87 tok/s. A's own TTFT rose
   quarter-over-quarter (5.9 → 10.0 s) as C ramped.
2. **Thinking got stuck at `low` in A/C — the routing never engaged.**
   B ran 156/223 turns at `off` (decode p50 0.6 s). A ran 199/201 at `low`,
   C 348/351 (decode p50 ~5–6 s). Two culprits:
   - Jev gate fragility: A logged `Jev unavailable (timed out after 2000ms)` —
     under load the 2 s-budget gate POSTs miss, no `effort_next` verdict lands,
     and the run level (`low`) persists.
   - **Adaptive-thinking catch-22** (`loop.ts isRoutineStep`): a routine streak
     requires `reasoningChars < 300`, but at `low` the model emits ~2 k chars
     every step — so the streak can never *start*. B only escaped because Jev's
     first `off` hint landed; once off, reasoning ≈ 0 and the streak self-sustains.
3. **Reasoning-cap double round trips.** Cap-hits (>11 k reasoning chars):
   A 12, C **34**. Each pays abort + a full re-ask at thinking-off: a second
   TTFT plus all the discarded reasoning. C wasted ~5 min this way alone.
4. **Batching almost never happens.** Multi-tool turns: A 17/201, B 8/223,
   C 37/351 — despite `parallel_tool_calls: true` and `STEP_RULES_BATCHED`.
   ~350 turns for a checklist task means ~350 full round trips.
5. **Prompt caching is unverifiable — possibly not happening.** The gateway
   reported a cache field on **zero** turns in all three runs
   (`cachedInputTokens` n=0; `parseOpenAiUsage` reads
   `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` and got
   neither). Context is 36–54 k tokens/turn, including a ~12–15 k fixed prefix
   and up to 2 live JPEGs (~90–235 KB base64 re-uploaded every turn). If the
   cache is silently missing, every turn re-prefills ~50 k tokens — that alone
   would explain a 7–8 s TTFT at 87 tok/s-class serving.
6. **The Jev risk gate is one serial POST per mutating call** — and
   `evaluate_js` is classified mutating (`shared/modes.ts MUTATING_TOOLS`), so
   C paid ~313 gate POSTs (2 s budget each, ahead of execution). A batch of K
   mutating calls pays K serial gates.
7. **Canvas settle tax.** Google Docs never reaches the 500 ms mutation-quiet
   window, so coordinate actions always burn their full 2.5 s settle budget
   (`input_sequence` p50 2.56 s ≈ the settle itself; 76 calls in C ≈ 3.5 min),
   and ~75 % of all tool results carried an auto-attached screenshot
   (A: 164/218) because the page is canvas.
8. **Raw checkpoint grew to 1.83 M chars (A) and is re-serialized to storage
   every step.** A's silent death mid-turn-200 is exactly the failure mode the
   heartbeat trace was built to diagnose. Long runs are also *slow* runs: a
   dead run costs 100 % of its wall clock.
9. **Repeat-task signal:** B and C are the *same* 32-item task. C needed 351
   turns where B needed 223 — and a replay path would need ~0 model turns for
   the segments it has seen before.

The prize, quantified: at B's per-turn profile, C's 351 turns would have taken
~45 min instead of 134 (3×). At a successful replay of the previous run's
trace, minutes.

---

## 1. Jev placements (the sidecar doing more, everywhere it's cheap)

Jev answers typed questions in milliseconds on the typesafe wire and already
rides the risk-gate POST for free (`JEV_GATE_QUESTIONS` = risk four +
`effort_next` + `progress`). Every idea below keeps the fail-open rule: Jev
down ⇒ today's behavior.

**J1. Jev as first-responder actor ("System-1 steps").** *The moonshot.*
When the freshest effort verdict is `routine` with high confidence, skip the
chat model for that step entirely: build 3–6 candidate next-actions from the
fresh snapshot (interactive refs / task-relevant targets), ask Jev ONE `choice`
question ("which action advances the task? — or `escalate`"), and execute the
winner through the normal risk gate. ~100–300 ms per step instead of 8–20 s.
Guardrails: any failure, low confidence, `escalate`, confirm-level risk, or N
consecutive Jev steps ⇒ hand back to the big model with the Jev trail in
context. In C, roughly 70 % of turns were single-action routine steps — this
is the only idea that removes the round trip instead of shortening it.

**J2. One Jev POST per batch, not per call.** `executeToolGated` fires per tool
call; Jev's own pitch is "up to 20 typed questions in one call". Assess all K
calls of a step, send ONE request carrying per-call risk questions (+ effort +
progress), then execute. Same information, ~1/K the serial gate latency, and
it makes batching (R2/R3) actually cheaper per action.

**J3. Jev gate resilience + telemetry.** A's single logged timeout coincided
with effort routing never landing. Add: per-call `jevGateMs` + timeout counter
in the runlog (M2); adaptive timeout (rolling p95 instead of fixed 2 s);
circuit-breaker that pauses gate calls after repeated timeouts and re-probes
periodically (today every mutating action keeps paying the full 2 s budget
against a dead endpoint); and degrade effort routing to the local streak
(J4/T1) rather than the run level while Jev is down.

**J4. Fix the thinking-off catch-22 with Jev-seeded streaks.** Let a confident
Jev `routine` verdict *extend* the adaptive streak even when the step's
reasoning chars were high, and let the streak start from page-state signals
(last two observations near-identical, no failures) instead of only
`reasoningChars < 300`. B is the existence proof: once `off` lands, 70 % of
turns stay off and decode drops 10×.

**J5. Completion checks ride the gate POST.** Add `item_done` / `task_done`
noul questions judged from todo state + recent history + observation digest.
Payoff: (a) kills "let me verify…" turns — C spent dozens re-checking finished
items; (b) when the last todo flips done with confidence, the harness composes
the final turn as "summarize, thinking off, ≤200 tokens" (D6) instead of a
full-thinking round trip; (c) an early `task_done` verdict mid-checklist is a
cheap stuck/over-run signal.

**J6. Batch pre-validator.** Before executing a K-call batch, one `choice`/
`noul` per call: "given this snapshot, does this action land on the intended
target?" Catches a wrong-ref click *before* paying action + settle +
observation + a model turn to discover it. This is the safety net that
justifies aggressive batching.

**J7. Failure-recovery arbiter.** On a failed tool call, Jev chooses
`retry_as_is / re_snapshot_first / change_strategy / report_blocker` from the
error text + recent history (one call, ms). The harness executes the obvious
branches itself (e.g. stale-ref ⇒ auto re-snapshot and hand the model fresh
refs in the SAME turn's result) and only spends a model turn when Jev is
unsure. Today every failure costs a full model turn to decide what to do.

**J8. Stuck-breaker with a concrete move.** The `progress` verdict currently
arms a generic coaching line. Upgrade: on `stuck`, a follow-up `choice` over
enumerated strategies (switch to keyboard shortcuts, use ref-click instead of
coordinates, reopen the menu, navigate direct URL, skip item and revisit) and
the coaching line NAMES the chosen move.

**J9. Screenshot triage.** Canvas pages attach a ~90 KB shot to ~75 % of tool
results. Ask Jev (noul, from snapshot digest + action, riding the gate POST):
"did this action change document CONTENT vs just chrome/menus?" Attach the
shot only on content-change or uncertainty; otherwise the text observation
plus `[content unchanged — say 'screenshot' if you need eyes]`. Halves image
upload bytes and vision prefill on Docs-class runs (T4's sibling).

**J10. Observation Q&A instead of 6 k-char dumps.** For routine steps, replace
part of the auto-observation with 3–6 targeted Jev answers computed in the
same POST (`dialog_open? field_filled? error_visible? caret_moved?`); the
result carries `[verified: Page setup dialog open]` + a snapshot DIFF (T5).
Less context per turn ⇒ smaller TTFT, later compaction.

**J11. Model cascade router.** Extend effort routing from thinking level to
*model*: `routine` ⇒ the cheapest fast model on the same wire, `careful/deep`
⇒ the configured model. Same history, same request shape; per-step TTFT and
decode both drop on routine steps even where J1 doesn't apply. (Needs a
second connection configured; fall back to J-effort-only when absent.)

**J12. Parallelizability verdict.** For a batch: one question — "are these
calls independent?" A confident yes extends `PARALLEL_SAFE` beyond read-only
for that batch (type in field A while clicking unrelated checkbox B).

**J13. Compaction relevance judge.** When `truncateHistory` is about to
collapse history segments, one `choice` over segment one-liners: which are
still load-bearing for the remaining task? Keep those, collapse the rest into
a rolling summary. Smarter than age-based omission; prevents the "model
re-checks something compaction ate" turns.

**J14. Confidence-bounded auto-approve (opt-in, careful).** For confirms the
regex rules raise on low-risk categories (a click inside docs.google.com mid
task), a high-confidence Jev "in-task and reversible" verdict auto-approves
with a pink "Jev approved" card + audit line. NEVER for purchase/credential/
irreversible categories; setting-gated; unattended runs only. This is the only
idea here that trades a safety margin for speed — park it unless confirm waits
show up as a real cost.

**J15. Checklist micro-step mode.** This task IS 32 numbered items. When a
todo item matches a procedural pattern (set page setup, insert table, name a
version…), run the item as a tight Jev loop (J1 + J5 + J7): snapshot → Jev
action → execute → Jev verify, with the big model consulted at item
boundaries or on escalation. Item cost drops from ~10 model turns to 0–2.

## 2. Killing round trips (turn count is the multiplier on everything)

**R1. Trace replay / skill compiler — the 5–10× idea for repeated tasks.**
B and C ran the same 32-item task. The coach already digests finished runs;
extend it (or add a sibling "compiler" pass) to emit *executable* skills:
action sequences anchored on labels/roles/URLs/shortcuts (never refs or
coordinates), each step with a postcondition. A replay engine runs them with
per-step verification (observation diff or Jev check, J5/J6); any mismatch
falls back to the model with the divergence in context. Second runs of the
same task become minutes of model time instead of 29–134.

**R2. Mid-sequence captures in `input_sequence`.** The prompt today forbids
chaining a click on a target that only appears inside the sequence — so every
menu path costs ≥2 turns (open menu → look → click row). Add a `capture` step:
the sequence screenshots mid-flight; later steps resolve `space:'capture'`
coordinates against it (the machinery for screenshot-space coords already
exists — it just needs the image taken *inside* the executor). Menu paths
collapse to one call; the capture rides the result so the model still sees it.

**R3. Plan-then-execute chunks.** On routine/careful verdicts, prompt the
model to emit the next 3–8 actions as one program (`input_sequence` already
takes 24 steps; `drag_at` already batches 32) with explicit checkpoints
("after step 4 the dialog must be open"). The executor runs open-loop,
checking each checkpoint via observation-diff/Jev; on mismatch it stops and
calls the model with the divergence. ÷3–5 turns on predictable segments.

**R4. Compound tools: `menu_path`, `form_fill`.** `menu_path ["File","Page
setup"]` with built-in waits and by-label lookup; `form_fill [{ref,value}…]`.
One call each, no model-side sequence authoring. C's 87 `click_at` + 13
`hover_at` were mostly menu chrome walks.

**R5. Keyboard-first Docs strategy.** Verify the `canvas-doc-editors` skill
front-loads the shortcut table (Ctrl+Alt+1…6 headings, Ctrl+Shift+7/8/9 lists,
Ctrl+K link, Ctrl+Alt+M comment, Ctrl+Enter page break…) and the prompt prefers
one `key` call over a 3-turn menu walk. A `key` call settles in ~1 s; a menu
walk costs 2–3 turns (~40 s in A/C).

**R6. Make batching fire.** It's prompted but lands 8–17 %. Add: a worked
few-shot example of a 3-call batch in `STEP_RULES_BATCHED`; a harness nudge
appended to any result when the step carried exactly one read-only call
("[batch this with the action it implies]"); and batching rate as a first-class
run stat (M3) so regressions show.

**R7. Item-scoped context resets.** After each completed todo item, hard-
compact: keep task + loaded skills + a rolling summary + the last observation;
drop the item's transcript. Context falls from 45–54 k to ~20 k steady-state
⇒ smaller TTFT, less compaction churn, fewer cap-hit blast radii. The summary
is composed at the boundary by the coach model (cheap, thinking-low) or by
Jev Q&A (J10). Wire bytes stay cache-friendly if the reset is quantized like
today's compaction.

**R8. Auto-resume watchdog.** A died silently mid-turn and stayed `running`
forever. A chrome.alarms liveness check (active run + no heartbeat >2 min ⇒
resume from checkpoint, note in log) converts a catastrophic loss into a
30 s hiccup. Speed is meaningless if the run doesn't finish.

## 3. Cheaper turns: TTFT and tokens

**T1. Verify the prefix cache is actually hitting. Biggest single unknown.**
Zero cache fields reported in 675 turns across three runs. Steps: (a) infer
cache behavior from the TTFT-vs-context slope per run (`runlog-stats` already
fits latency; add a cache-miss signature: TTFT growing ~linearly with
context); (b) run the same task once against DeepSeek's native API
(`prompt_cache_hit_tokens`) or a gateway that passes through
`prompt_tokens_details`; (c) if the current gateway is dropping/never hitting
cache, every turn re-prefills ~50 k tokens + 2 JPEGs — fixing that dwarfs
everything else in this section.

**T2. Shrink the fixed prefix (~12–15 k tokens/turn).** BASE_RULES carries
several multi-hundred-char war stories; compress to one-liners with the detail
moved to skills. Split tool specs by run phase where the freeze-at-run-start
rule allows (a typing-heavy Docs run doesn't need bookmarks/topsites specs).
Target ≤8 k prefix. Every k shaved is re-sent ~350 times per run.

**T3. History diet.** `HISTORY_BUDGET_CHARS` 120 k ≈ 30 k tokens dominates the
40–55 k context. Drop to ~72 k with: older observations collapsed to one-line
outcomes ("clicked File → menu opened") instead of `[older tool result
omitted]` (keeps information, kills bulk); ONE live image on canvas pages
unless the model asked for shots; byte-identical screenshot dedupe ("same as
previous shot" — the collapse exists for text via `sameObservation`, not for
images).

**T4. Image diet.** 1280 px/q0.7 → 1024 px/q0.6 (or WebP where the gateway
accepts it): ~40–50 % fewer bytes per shot. Request bodies currently carry
~120–300 KB of base64 per turn — on a residential uplink that's 0.3–2 s of
TTFT *before the gateway even starts*. For canvas docs, default to a zoom-crop
around the last action (the crop machinery exists) with full-viewport on
request.

**T5. Diff observations.** Extend the identical-page collapse to *near*-
identical: line-diff against `lastObservations` and send `[chrome unchanged;
doc text +2 lines: …]`. Canvas-editor chrome is ~90 % of the 6 k-char dump and
is byte-stable between actions.

**T6. Hedged requests on the TTFT tail.** No first token by ~8 s (measured
p90 was 18 s under contention) ⇒ fire an identical second request (stateless;
same body keeps cache warm) to the same endpoint or a fallback connection;
take whichever streams first, cancel the other. Converts 18–25 s tail turns
into ~8 s; extra cost only on tail turns. Variant D5 hedges the reasoning-cap
re-ask the same way.

**T7. Concurrency governance.** A+C on one key doubled TTFT, halved decode
speed, AND broke Jev routing (the 2 s gate budget misses under load). Options,
cheapest first: (a) log a warning when two runs share an endpoint; (b) queue
runs by default with an explicit "run in parallel" toggle; (c) auto-route the
second concurrent run to a different configured connection/model.

**T8. Request-body telemetry.** Log bytes sent per turn split text vs images,
plus send-duration vs server-duration split of TTFT. You cannot shave what you
cannot see; this also validates T4/T1.

## 4. Faster turns: decode and thinking

**D1. Tighter overrun policy.** `REASONING_OVERRUN_FACTOR` 3 lets a `low` step
burn 12 k chars before the cut; C paid 34 abort+re-ask double round trips.
Drop to ~1.5, and make level-drops eager: first cap-hit ⇒ one level down
immediately (not after 3 consecutive), second ⇒ `off` for the run.

**D2. Knob-honor stat.** Count turns sent at `off` that still streamed
reasoning chars (the code comments document gateways ignoring
`reasoning_effort`; `enable_thinking:false` compliance on THIS gateway is
unverified). If the gateway ignores off, client-side cut (D1) is the only
lever — and the stat proves it.

**D3. Route-level default: off, not low.** `thinkingForComplexity` maps
simple→`low`. B shows `off` is worth ~5 s/turn on routine-heavy work; map
simple→`off`, moderate→`low`, and let Jev raise on `deep` (the raise path
already exists).

**D4. Decode-stall watchdog.** Mirror of the TTFT stall guard: no delta for
~6 s mid-stream ⇒ abort + retry. A's max turn was 92 s, C's 101 s — some of
that tail is mid-stream stalls nobody watches.

**D5. Shadow re-ask at imminent cap.** When streamed reasoning passes ~75 % of
the cap, fire the thinking-off re-ask concurrently instead of serial
abort→rebuild→TTFT. Hedge cost is bounded to turns already flagged runaway.

**D6. Cheap final-answer turn.** With J5's completion verdict, compose the
last turn as "final summary, thinking off, ≤200 tokens" — today the summary
turn is a full-thinking round trip at max context.

## 5. Overlap and speculation (structural, biggest engineering lift)

**O1. Execute tool calls as they stream.** `openAiAggregator` already
accumulates `tool_calls` deltas per index; the moment call *i*'s args JSON is
complete, start probe → gate → execute while the stream is still emitting
later calls or trailing text. Keep `record()` ordering; hold results until
stream end for checkpointing. Overlaps the decode tail + gate + settle with
generation — realistically 1–3 s/turn on batched steps, more with O2.

**O2. Speculative gate pre-fire.** With O1, fire the Jev gate POST (J2's
batched form) as soon as args parse — by stream end the verdict is already
back. Discard on stream invalidation. The gate leaves the critical path
entirely.

**O3. Parallel observation assembly.** Post-action today: settle → snapshot →
(canvas?) capture → downscale → encode, all serial. Snapshot text collection
and screenshot capture/encode are independent — run them concurrently; run
Jev's post-action questions (J9/J10) concurrently with both.

**O4. Skip the quiet-wait on canvas.** Canvas pages never reach the 500 ms
mutation-quiet window, so coordinate actions always pay the FULL settle budget
(2.5 s; 10 s for enter-ish). Detect canvas once per tab (`frames.canvases>0`
is already in the snapshot) ⇒ replace quiet-wait with a fixed 300–500 ms +
capture. ~2 s × ~150 actions ≈ 5 min saved per Docs run, with the screenshot
still taken after real paint.

**O5. Preconnect.** On run start, warm DNS/TCP/TLS to the LLM and Jev
endpoints (a 0-byte OPTIONS/HEAD fetch). Cheap; measure with T8 first.

**O6. Speculative observation reuse.** When the last streamed call is a
routine action, pre-capture shot+snapshot at stream end *while* the action
executes… only sound for idempotent-observation cases; O1–O4 dominate. Park.

## 6. Tool/observation pipeline

**P1. `Input.insertText` for bulk typing.** `input_sequence` types per-key
through CDP with sleeps; 76 calls × ~2.8 s in C. After focus is established
(one real click), bulk text can go through `Input.insertText` (still a trusted
IME-path event) — near-instant for paragraph pastes. Keep per-key dispatch for
Enter/Tab/shortcuts and for fields that need keystroke events.

**P2. Gate classification for `evaluate_js`.** It sits in `MUTATING_TOOLS`, so
every diagnostic call pays a Jev gate POST (59 in C). Pre-screen the
expression: pure reads (`JSON.stringify({...})`, no assignment/`.click()`/
mutating fetch) skip Jev; ambiguous expressions still gate. Measure the cost
first with J3 telemetry if paranoia says so.

**P3. Persist the compacted checkpoint.** A's raw history hit 1.83 M chars,
re-serialized into storage every step (save latency + the OOM/silent-death
risk that actually killed A). Persist the same bytes the wire sees (the
compacted view — cache semantics unchanged), keep the full-fidelity record in
the runlog only.

**P4. Probe cache.** `probeElement`/`probeElementAt` runs before every gated
action; cache ref→metadata keyed by the last observation hash, invalidate on
any mutation. 50–200 ms/action.

**P5. Cheaper failure shots.** `withFailureShot` captures + downscales at full
1280/0.7 before the error can return; 800 px is plenty for diagnosis.

**P6. Memoize hot-path awaits.** `tabIdentity`, `adapterForMode`,
`resolveAgentWindow` are awaited per call; memoize per run/tab.

## 7. Measurement (so the next log dump answers these questions directly)

**M1. Per-turn waterfall.** `sendMs → firstTokenMs → firstArgsCompleteMs →
streamEndMs → gateMs → execMs → settleMs → snapMs → shotMs → nextSendMs`,
one record per turn; `runlog-stats` prints the p50/p90 waterfall. Today
`durationMs - ttft - decode` lumps gate+settle+exec together.

**M2. Jev telemetry.** Per-call latency, timeout rate, verdict distribution,
hints applied/raised/dropped (the run-level counters exist — make them
per-turn and put gate latency in the tool record).

**M3. Batching rate.** Multi-call turns / single-call turns / calls-per-turn,
per run — the stat Fast-steps was built on; keep it visible.

**M4. Cache + body stats (T1/T8).** Cached-token count when reported, inferred
cache slope when not, request bytes split text/images.

**M5. `--bench` mode.** Pin this 32-item Docs task as the standing benchmark;
`runlog-stats.mjs` already does side-by-side — add automatic flags for >10 %
regressions/improvements in wall, turns, TTFT p50, decode p50, batching rate.

---

## If only five things

1. **Make `off` the common case again** — J3 + J4 + D1 + D3. A/C evidence:
   ~5 s/turn of avoidable decode + 34 double round trips; B evidence: 3× wall
   difference. Smallest change, largest measured delta.
2. **Prove/fix the prefix cache, hedge the tail** — T1 + T6. TTFT is 35–45 %
   of A/C wall and its cache status is currently unknowable from the logs.
3. **Stop concurrent runs cannibalizing each other** — T7 (+ M4 to confirm).
4. **Take the tool phase off the critical path** — O1 + O2 + O4 + J2.
   ~3–6 s/turn on every action step.
5. **Trace replay for repeated tasks** — R1 (+ R2/R3 as the enabling
   primitives). The only 5–10× idea on the list; this exact task was run
   twice in one evening.

Honorable mentions: R8 (watchdog — A's silent death), J1 (Jev-as-actor, the
structural moonshot that subsumes much of the above for routine steps), P3
(checkpoint diet — also an OOM/relability fix).
