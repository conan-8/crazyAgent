# M4 report — the model watcher (judge) + offline replay gate

**Date:** 2026-11-16 · **Task:** shared task-5 · **Plan:** `MARATHON-PLAN.md` §5 M4 + §3.3.3/§3.3.4
**Scope:** `companion/watch-judge.mjs` (new), the M4 judge wiring in `companion/watcher.mjs`, live wiring in `companion/index.mjs` (injected getters), `scripts/watcher-eval.mjs` (offline replay), their tests, this report. **No new tools; standing count stays 34. The watcher only reports; the judge is plain tool-less HTTP, not a second DSH runner.**
**Status:** implementation + unit gates green (npm test 1214/1214); offline replay run with the real judge on **62 labelled windows**. **Hard requirement MET: 0 false alerts on 53 healthy/progressing fine windows.** Stuck detection is **borderline — 6/9 windows (67%) flagged within two checks; 6/7 distinct stuck runs (86%)** — below the literal ≥80% window target. **Lead ruling 2026-11-16: FALLBACK A** — accept the borderline score, commit the neutral-prompt + bounded-aggregates + REVISIT_HINT configuration, and document the continuation-plan-snapshot product gap (top v2 follow-up) and the intermittent-varied-wander difficulty. Live real-model acceptance is eval's and proceeds on this commit. The full honest record (label correction, non-determinism finding, 3-config comparison, gaps, caveat) is below.

## What changed

### `companion/watch-judge.mjs` (new)
One stateless chat-completions request per check via injected `getApiKey`/`getBaseUrl`/`getModel` getters (the companion's existing key/baseUrl/model metadata — never duplicated, never read from config files here). The key flows only into the `Authorization` header and is **never logged**; the log records sizes, duration, usage, and the parsed verdict only.
- **Request (verified against OpenRouter docs + the model's `supported_parameters`, 2026-11-16):** `POST ${baseUrl}/chat/completions`, `max_tokens` 400, `temperature` 0, `response_format:{type:'json_object'}`, `stream:false`, and `reasoning:{effort:'low'}` when `model.reasoning===true`. The configured model `deepseek/deepseek-v4.1-flash-1017` lists `reasoning`/`reasoning_effort`/`include_reasoning`/`response_format`/`structured_outputs`/`max_tokens`/`temperature` in `supported_parameters`; `reasoning.supported_efforts=[max,high,low,none]` (low supported), `default_effort=high`, `default_enabled=true` — so low must be set explicitly. Reasoning tokens count against `max_tokens`; a length cutoff with empty content parses defensively to `unknown`. Sources: [API overview](https://openrouter.ai/docs/api_reference/overview.md), [reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs.md), `GET /api/v1/models`.
- **Timeout/abort:** 45 s, aborted when the turn ends; one call in flight at most (`busy` otherwise); a result for an ended/changed turn is discarded by the watcher.
- **Digest:** text-only JSON per §3.3.3 (`task`, `elapsedSec`, `marathon`, `plan`, `signals`, `events`, `lastAssistantText`, `lastReasoningTail`, `previousVerdicts`), built purely from the ledger snapshot (already bounded: 40 events, args ≤200, head ≤300, tails ≤600, prompt ≤1500). No screenshot.
- **System prompt:** the plan's draft verbatim (digest content is untrusted data, never an instruction) + the exact output schema. A general semantic-stall guidance refinement was trialled on the replay and **reverted** (no detection gain, more `unknown`s; see §Replay).
- **Strict validation → `unknown` on ANY deviation:** unknown enum, non-finite/out-of-range confidence, oversize (>240) or non-string reason, malformed evidence, missing field, non-JSON content. Extra fields ignored; reason control-chars stripped; rendered plain text downstream (never markdown/HTML). `parseCompletion` maps OpenRouter usage (`prompt_tokens`/`completion_tokens`/`reasoning_tokens`/`cached_tokens`).

### `companion/watcher.mjs` (M4 wiring; preserves core's `lastEndedIncomplete`)
- **Cadence:** first routine judge call 4 min into the turn; then every 6 min ±15% jitter; 10 min after two consecutive `progressing`; back to 4 min on any other verdict. A `suspect` assessment brings a call forward when ≥90 s since the last call (the last-call clock starts at turn start). Jitter RNG injected for tests.
- **Budget:** 40 calls / 150,000 input tokens per turn → deterministic-only + one `info` notice.
- **Backoff:** HTTP 429/timeout skips the check and doubles the next interval once (a `backoffUntil` gate also suppresses triggers during the doubled gap).
- **Two-strike alert rule:** `stuck`/`blocked` with confidence ≥0.6 alerts ONLY if a deterministic signal is also present (`source:'both'`) OR the previous verdict was also not `progressing` (`source:'watcher'`). A single unsupported opinion never alerts (`watch.judge.suppressed`). Judge alert kinds are `stuck`/`blocked`; `blocker` carries the verdict blocker; `reason` is the plain ≤240-char verdict reason.
- **Hard signals unchanged:** alert immediately without the judge; the judge can never veto them. One-open-alert / kind-change / 15-min re-alert / ≤3 alerts+pushes / recovery / snooze all preserved.
- **Read-only:** imports only `crypto`/`assess`/`buildDigest`; publishes only `chat.watch`. Never steers/stops/sends a bridge command/captures/changes ok/label/plan/docsVerification/retries.
- **Reporting:** watch summary stays `{checks, alerts, usage}` (checks = deterministic ticks; usage = judge input+output tokens, separate from agent usage). Judge call counts + input/output/reasoning/cacheRead split logged via `watch.judge.*` events. Projection `lastVerdict`/`lastCheckAt` are judge-driven (null until the first call); idle shape unchanged. `turnEnded` aborts the in-flight judge call.

### `companion/index.mjs` (live wiring; core-reviewed)
Constructs `createWatchJudge` with lazy getters over the existing `apiKey`/`llmConfig`/`baseUrlOption` and passes `watch:{judge}` to `SessionController` (core's null-safe pass-through). Absent config → `no-config` skip (deterministic-only). Commit `6a20c39`; acceptance pin `2abb065` precedes it, so M2-steer-plan/M3 acceptance stay deterministic-only as intended.

### `companion/watch-ledger.mjs` (M4 extension — bounded aggregates + REVISIT_HINT)
Cheap per-turn counters (no new I/O), reset each turn: whole-turn `fingerprintStats` (count/ok/outcome-variation, ≤1000 keys), `navTargetCounts` (≤200, target ≤120 chars), `okMutationCount`, and the open-item trajectory (`firstPlanOpen`/`currentPlanOpen`/`openLastDecreasedAt`/`okMutationsSinceOpenDecrease`/`planOpenSamples` ring ≤40). `snapshot().aggregates` exposes bounded top-5 mutation revisits / top-3 nav revisits / last-8 open samples. **`REVISIT_HINT`** is a soft **suspect** signal (never alerts alone, exactly like `PLAN_STALLED`): it fires on a repeated successful **mutation** with the same outcome across the turn (the redo signature; read-only tools excluded, varying heads excluded) **or** open items flat/rising ≥150 s with ≥3 mutations since the last decrease. It brings the triggered judge call forward and corroborates a stuck verdict under the two-strike rule. **Navigation revisits are digest info only** (`navRevisits`), not corroboration, so a faithful re-reading wander does not corroborate a wrong stuck verdict. All eight M3 signals and the event ring are byte-identical; the additions are purely additive (core-reviewed).

### M3 wiring bug found (fixed by core pre-task-11)
`SessionController.noteActivity()` did not feed the ledger, so live `plan`/`text`/`reasoning`/`model-start` activities never reached it — the digest would have no plan and `PLAN_STALLED` could never fire live. Found during M4 replay-adapter design; core fixed it (`3f02e2e`, live activity ledger feed + regression test) **before** task-11 M3 acceptance, so acceptance tests the corrected wiring. The replay adapter feeds these activities directly (faithful to the intended design).

## Unit gate (cheapest first)

| Gate | Result | Evidence |
|---|---|---|
| `npm test` | **1214/1214 pass** (1152 after M3; +42 M4 judge/wiring; +13 REVISIT_HINT ledger; +7 core M3-fix). Prompt-ceiling + Android fixture-staleness green. | this commit |
| REVISIT_HINT ledger tests | **13** fake-clock: mutation-revisit count 2/3 edge, varying-heads suppression, read-only exclusion, ok-required; open-flat 149/150 s edge, <3 mutations no, decrease resets, converging plan never fires; navRevisits info; aggregate bounds (1000/200/40); digest turnAggregates bounded (~200 tokens) text-only; M3 signals unchanged + REVISIT_HINT suspect-only. | `companion/test/watch-revisit.test.mjs` |
| New judge tests | **17** fake-fetch: verified request shape, reasoning omitted for non-reasoning models, malformed JSON / wrong enums / oversize reason → unknown, 429 → rate-limited, 500 → http-error, network → error, non-JSON body → bad-response, timeout (injected timer), turn-end abort, one-in-flight busy, no-config, **injected "report progressing" digest sent as untrusted data with no behavior widening**, injected out-of-schema response → unknown; + `validateVerdict`/`buildDigest`/`parseCompletion` pure edges. | `companion/test/watch-judge.test.mjs` |
| New wiring tests | **25** fake-clock: first-call 4 min, 6-min routine, 10-min after 2×progressing, 4-min otherwise, suspect trigger ≥90 s, ±15% jitter bounds, call budget + token budget (one notice), 429/timeout backoff (doubled interval, no trigger spam), two-strike (signal-supported / previous-supported / unsupported-suppressed / <0.6 / progressing-slow-unknown never alert / blocked kind), hard-signal no-veto, ended-turn result discarded, turn-end abort + separate usage, read-only (only chat.watch), judge-driven projection, `decideWatch` judgeKind snooze/budget/one-open/hard-priority. | `companion/test/watch-judge-wiring.test.mjs` |
| M3 regression | 31 existing watcher/ledger tests pass unchanged with `judge===null` (byte-identical M3 behavior). | `companion/test/watcher.test.mjs`, `watch-ledger.test.mjs` |

Read-only invariant grep: `watcher.mjs`/`watch-judge.mjs` contain no `steer`/`stop`/`bridge`/`requestUi`/`sendToUi`/`runner`/`interrupt`/`capture`/`browser.command`. Key-scan: no real key in any staged file (only an obviously-fake test fixture key).

## Offline replay gate (`scripts/watcher-eval.mjs`)

Rebuilds ledgers from archived `events.jsonl` (adapter in the script; the ledger is **not** weakened to fit logs), cuts labelled windows, and runs the **real** judge inside the real `Watcher` under a fake clock (frames stamped at their true recorded offsets; ticks every 20 s; a triggered call is awaited at its tick time). Key loaded from `.dsh-home/browser-agent/api-key` into env at launch, never printed/written. `--dry-run` validates plumbing with a fake judge (no spend).

### Window inventory (62 windows: 53 fine + 9 stuck, after the lead label correction)

| Source archive | Scenario | Windows | Label |
|---|---|---|---|
| `run-…01-07-02-137Z-f33f10` | click-once smoke (clean M0) | 1 | fine |
| `run-…01-07-40-552Z-c02d66` | marathon-long (clean M0 ×5) | 5 | fine |
| `run-…01-13-25-223Z-02b684` | stall-loop clean M0 r1/r2/r3/r5 (quick honest BLOCKED below thresholds) | 4 | fine |
| `run-…01-13-25-223Z-02b684` | stall-loop clean M0 **r4** (loops past PLAN_STALLED @140 s, BLOCKED @153 s) | 1 | **stuck** (true positive — lead label correction) |
| `run-…01-20-21-564Z-2551a4` | sign-in-wall (clean M0 ×5, honest help) | 5 | fine (no ended-incomplete) |
| `run-…01-32-38-591Z-f80ac2` | marathon-long (M1 acceptance ×5) | 5 | fine |
| `run-…02-02-36-976Z-849181` | marathon-long (M2 acceptance ×5) | 5 | fine |
| `run-…02-44-34-045Z-b5a71b` | tuning suite1 r1/r2/r4/r5 | 4 | fine |
| `run-…02-44-34-045Z-b5a71b` | tuning suite1 **r3** (642 s wander, stations 4+5 re-recorded, false complete) | 1 + late slice | **stuck** (semantic, varied activity) |
| `run-…02-14-11-994Z-c82d46` | suite2 stop-then-continue turns 1–9 | 9 | fine |
| `run-…02-14-11-994Z-c82d46` | suite2 **r5 continuation** (293 s wander, station 9 re-recorded) | 1 | **stuck** (semantic) |
| `run-…02-26-39-794Z-739f46` | unrelated-question ×5 (10 turns) | 10 | fine |
| `run-…03-37-05-493Z-6d9d73` | M3 acceptance marathon-long ×5 incl. **r3 221 s FAITHFUL wander** (0 redos) | 5 | fine (must stay silent) |
| `run-…00-43-57-262Z-2ab066` | contaminated stall-loop **r4** (420 s silent timeout, **NON-M0, M1-code**) | 1 + late slice | **stuck** (sustained semantic stall) |
| synthetic | TOOL_HANG / EXECUTOR_DOWN / SILENT_STALL fixtures | 3 | **stuck** (synthetic hard-signal) |

TOOL_HANG/EXECUTOR_DOWN fixture logs were **not archived** (M3 fixtures used a stub logStore in `/tmp`); the synthetic windows are clearly labelled and exercise the judge-interaction path, not the alert mechanism (proven independently via `GET /state` in M3). Late slices of the two long stuck runs are **correlated** with their full windows (same replay), noted as such.

**Ended-incomplete exemption (lead ruling 2026-11-16):** plan §2.3/§3.3.4 and `decideEndedIncomplete` exempt help/confirm ends — the help request is itself the user-facing notice, so a marathon turn that ends asking for help/confirmation does **not** also emit `ended-incomplete`. BLOCKED-label ends *without* help still fire it. No code change; the replay scoring matches the code (sign-in-wall help ends → no notice; stall-loop BLOCKED ends → notice).

### Draft baseline (starting point — `m4-evidence/replay-real.json`, 57 windows)
The draft judge (no aggregates) on the original 57-window set: fine 0/49 false alerts, stuck 5/8 (63%) — sustained silent stall (contaminated r4) + synthetic hard caught; intermittent wander (suite1-r3, suite2-r10) missed. This motivated the lead-authorized REVISIT_HINT iteration below. (The draft was later re-measured on the full 62-window set; see the 3-config comparison.)

### Judge cost (real, separate from agent usage)
Canonical run: **28 calls · 134,467 input · 8,289 output · 6,870 reasoning tokens** (model `deepseek/deepseek-v4.1-flash-1017` @ low effort, ≤400 output tokens/call). ≈ $0.01 at the configured pricing (prompt 3.6e-8, completion 5e-7). Per-window call/token counts are in the evidence JSON. ~4.8k input tokens/check average (plan estimated ~3.5k; the bounded turnAggregates add ~200); healthy short turns get **0** calls (they finish before the 4-min first call and the 90-s trigger floor).

### Iteration history (lead-authorized; one change package then a final attempt)

The draft judge caught sustained obvious stalls + hard signals but missed intermittent varied-activity wander. Lead authorized a REVISIT_HINT iteration (bounded whole-turn ledger aggregates + a soft suspect signal + a `turnAggregates` digest section), then a final attempt with a neutral prompt. The replay set grew to **62 windows** when eval's M3 acceptance batch (5 healthy marathon-long incl. a 221 s **faithful** wander, 0 redos) was added as fine windows; the lead label correction then moved m0Stall-r4 from fine to stuck (**53 fine + 9 stuck**).

| Config (real judge, 62 windows) | m0Stall-r4 verdict@140 | Stuck flagged ≤2 checks | Evidence |
|---|---|---|---|
| Draft (no aggregates, neutral prompt) | stuck (conf 0.85) | 5/8 (62.5%) | `replay-draft62` |
| Aggregates + REVISIT_HINT + cautious framing (v3) | unknown in one run, **stuck (0.9) on re-run** | 4/8 (50%) | `replay-real-v3.json`, `replay-real-v3b.json` |
| Aggregates + REVISIT_HINT + neutral prompt (final attempt) | stuck (0.85) | 6/8 (75%) | `replay-real-final.json` |

*These runs predate the label correction: m0Stall-r4 was then counted as a fine "false alert". After the lead ruling it is a **stuck true positive**, so each config's healthy-fine false-alert count is **0/53** (the m0Stall-r4 alert is correct behavior, not a false alert). The cautious framing was trialled to suppress that alert and **rejected** — it suppressed a desired stall-loop alert and lowered stuck detection.*

**What worked:** REVISIT_HINT's open-flat trigger genuinely brings the judge call forward into the detectable window (suite1-r3 open items flat at 3 from 65 s → 634 s; the hint fires ~215 s, judge sampled @220 s). With the neutral prompt suite1-r3 flips to `stuck@220` (check #2). The aggregates keep the **faithful** wander silent across all configs (m3Long-r3 → progressing/unknown, decreasing open trajectory reads as converging) — a real safety gain. Synthetic hard windows flag 3/3.

### Key finding: judge non-determinism (resolved by label correction, not a breach)

m0Stall-r4 loops on the inert "Next record" button, then self-reports **BLOCKED @153 s**. `PLAN_STALLED` fires @140 s and the judge frequently returns `stuck` (conf 0.85–0.9) @140 s — ~13 s before the honest end. Initially this looked like a hard-requirement breach (a "false alert on an honest run"), and it is **prompt-independent**: draft, neutral, AND cautious framing all reproduced `stuck@140`; the one v3 run showing `unknown@140` was luck. At temperature 0 the low-effort judge still varies (provider routing / reasoning sampling).

**Lead ruling resolved this:** at 140 s the agent genuinely **is** stuck/looping and has not said so yet — the alert is a **plan-consistent true positive** (§0 remit, §5 M4 expects stall-loop alerts), and the hard requirement is zero false alerts on **healthy/progressing** runs, which all configs meet (0/53). The non-determinism remains a real observation: it shifts borderline verdicts and the stuck check-index run-to-run (stuck window score ranged 6/9–7/9 across re-runs), so the live phase measures the real distribution. It is **not** a precision breach on healthy runs.

**Adapter fidelity finding (lead item 3): NOT an adapter gap.** The provider does not emit a plan activity for the M2 seed — `plan-runtime.claim()` logs `plan.mode.started{revision,seeded}` with no items and calls no `bridge.activity`; the first plan activity is the model's first `browser_plan` call. So the **live** ledger also has no plan snapshot until then; the replay faithfully matches live. suite2-r10's continuation wander has no plan data during the wander in both replay and live → open-flat cannot fire → unflagged. Surfacing the seed to the ledger is a product change (provider/controller), a v2 candidate.

**Metric kept literal:** "within two checks" counts every judge call including hint-triggered early `unknown`s (no re-basing). The contaminated r4 full window flags at check #2/#3 depending on how many early unknowns the hint triggers; late slices are correlated with their full windows.

### Label correction (lead ruling 2026-11-16 — transparent, plan-cited)

**m0Stall-r4 is a STUCK window, not fine.** At 140 s the agent has looped ~30× on the inert "Next record" button, the page is frozen, and `PLAN_STALLED` has fired — it **is** stuck/looping at that moment; it self-reports BLOCKED only 13 s later. Plan §0 remit is to alert when the agent is "stuck, **LOOPING**, hung, or blocked **without having said so**" — at 140 s it has not said so yet. Plan §5 M4 **expects** stall-loop alerts (≥4/5). Plan §2.3: recovery collapses the notice. The `stuck@140` alert is therefore a **plan-consistent TRUE POSITIVE**, not a false alert.

**Lead acknowledgment (recorded verbatim in spirit):** the earlier "zero alerts on honest runs" framing was **over-strict** — it conflated "eventually ends honestly" with "never stalls." The **hard requirement is zero false alerts on HEALTHY/PROGRESSING runs** (no stall behavior): clean marathon-long, the faithful wander, and quick honest ends **below thresholds**. The two-strike rule stays **literal** (a signal-corroborated first model alert is allowed); options to tighten it were **rejected** because they would suppress this desired stall-loop alert. This reversal is documented here explicitly, not silently flipped.

### Corrected gate scores (neutral prompt + aggregates + REVISIT_HINT; `replay-canonical.json`)

- **Fine (healthy/progressing only): 0 false alerts / 53 — PASS** (hard requirement). Faithful wander m3Long-r3 → progressing/unknown, silent ✓; m2Long-r2 progressing, m2Long-r5 unknown, silent ✓; quick honest stall-loop ends (r1/r2/r3/r5) and sign-in-wall help ends get 0 judge calls / 0 alerts. `ended-incomplete` correct **53/53** (help/confirm exempt per §2.3).
- **Stuck — THE GATE METRIC is stuck WINDOWS: 6/9 = 67% flagged within two checks, below the ≥80% target (this is the gate result, accepted via FALLBACK A; no gaming).** The distinct-RUN framing (6/7 = 86%) is a **nuance, NOT the gate result**: it shows the misses are *concentrated* (the continuation-redo run lacking a ledger plan snapshot + the late-slice/within-2-checks timing sensitivity), not spread across healthy behavior.
  - ✓ m0Stall-r4 (true positive, check #1, stuck@140), suite1-r3 wander (check #2, stuck@220), contaminated r4 silent stall (check #1, stuck@160), synthetic TOOL_HANG/EXECUTOR_DOWN/SILENT_STALL (3/3).
  - ✗ suite2-r10 continuation redo (unknown/slow — the continuation-plan-snapshot gap below).
  - ✗ the two **late slices** (contaminated-r4-late, suite1-r3-late): the alert fires early (check #1/#2) then **recovers** (3 ok mutations / plan revision) before the slice starts, so no alert is open within the slice. These are **correlated** with their full windows (same replay) and are a slicing/recovery artifact, not independent misses — the distinct-run nuance (6/7 = 86%) excludes them.
- **3/N caveat:** 0 observed false alerts in **53** healthy fine windows bounds the true rate near **3/53 ≈ 0.057**; small sample, correlated slices noted.
- **Non-determinism:** the low-effort judge varies run-to-run at temperature 0 (provider routing / reasoning sampling). Across re-runs the stuck window score ranged 6/9–7/9; verdicts on borderline moments (e.g. contaminated r4 stuck@160 vs @260) shift the check index and late-slice recovery timing. The canonical run above is one honest sample; the live phase measures the real distribution.

### Gate disposition — FALLBACK A (lead explicit ruling)
The literal window target (≥80%) is not met (67%; distinct-run 86%). Per lead ruling, **accept the borderline score and commit** the neutral-prompt + bounded-aggregates + REVISIT_HINT configuration (best stuck score with verified faithful-wander safety and 0 healthy false alerts). No threshold was weakened; no scenario was sabotaged; the two-strike rule is unchanged. The genuine miss (suite2-r10) **stays stuck-and-missed** — not relabeled.

### v2 follow-ups (NOT in M4 scope — one milestone at a time)
1. **TOP: surface the M2 seed plan to the ledger at turn start** (small provider/controller change). Proven product gap: `plan-runtime.claim()` emits no plan activity for the seed, so the live ledger has no plan snapshot until the model's first `browser_plan` call → open-flat/REVISIT_HINT cannot fire on a continuation wander (suite2-r10). This is the primary cause of the continuation-redo miss.
2. **Intermittent varied-activity wander** is hard for the low-effort text-only cadence-sampled judge (plan decisions #3 low effort / #4 text-only digest). Candidates: richer digest (plan-progress history), effort, or cadence — measure before changing.
3. **Judge non-determinism** at temperature 0 (provider routing / reasoning sampling) — consider a fixed provider/seed for verdict stability if the live false-alert/miss variance warrants it.

## Deliberate non-goals / held work
- **No live real-model acceptance claimed.** stall-loop ×5 + sign-in-wall ×5 + marathon-long ×5 (zero alerts) are eval's, held until M2/M3 acceptance green; judge calls/tokens recorded separately per run.
- The user's live companion (17871/17873) was never touched; replay is offline (no browser, no DSH runner).
- WATCH push delivery remains M5/unrun.

## Commits
- `cbe50ee` — watch-judge.mjs + watcher.mjs wiring + 42 tests (ordering head; `judge===null` keeps M3 identical).
- `6a20c39` — index.mjs live wiring (injected getters) + fetch-error log hardening (core-reviewed).
- `(this commit)` — REVISIT_HINT bounded ledger aggregates + turnAggregates digest + neutral prompt + 13 ledger tests + `scripts/watcher-eval.mjs` replay + evidence + this report (core-reviewed; FALLBACK A per lead ruling).

## Next
- **eval live phase** on this commit: stall-loop ×5 + sign-in-wall ×5 (alert raised / time-to-alert / help-first; honest quick ends below thresholds = correct-no-alert + ended-incomplete) and marathon-long ×5 (zero false alerts on healthy runs, judge-wired). Record per-run judge calls/tokens separately. Lead confirms live done.
- **v2 follow-ups** (above): surface the M2 seed plan to the ledger (top), richer digest/effort/cadence for intermittent wander, judge verdict stability.
- task-5 completes only when the replay+unit gates are accepted (FALLBACK A ruling) **and** lead confirms the live phase done.

---

## Live real-model acceptance (eval, pin cd773376) — **GREEN**

**Verdict: the M4 live gates are MET.** 15/15 independent PASS across the three suites; **zero false alerts on healthy/progressing runs (hard requirement)**; marathon-long silent 5/5 with the judge wired; every alert that fired was a signal-corroborated true positive on genuine inert-button looping past thresholds; ended-incomplete correct on every end class; watcher cost recorded separately from agent usage.

### Acceptance criteria and rulings applied (lead, 2026-11-16)

1. **Zero false alerts on HEALTHY/PROGRESSING runs — hard.** The earlier "zero alerts on honest runs" framing was over-strict (conflated "eventually ends honestly" with "never stalls"); the label correction above makes m0Stall-r4-type alerts plan-consistent TRUE POSITIVES (§0 remit: alert when stuck/looping/blocked *without having said so*; §5 M4 expects stall-loop alerts; §2.3 recovery collapses the notice). The two-strike rule stays literal — a signal-corroborated first model alert is allowed.
2. **Quick honest BLOCKED ends below thresholds** = correct-no-alert + ended-incomplete MUST fire. **Help ends** = correct-no-alert + help request present + **NO ended-incomplete** — plan §2.3/§3.3.4 and `decideEndedIncomplete` exempt help/confirm waits (the help request is itself the user-facing notice; eval flagged the preview-vs-code mismatch before spend, lead ruled the PLAN wins, code unchanged).
3. **Genuinely-stuck runs** (looping past thresholds without an honest end, or silent stalls) must alert; "≥4/5" applies to genuinely-stuck runs, and when the live sample yields fewer (the honest-end distribution), **the replay gate carries the stuck-detection evidence (FALLBACK A: 6/9 windows, 6/7 distinct runs, 0/53 healthy false alerts)** and the live distribution is recorded honestly. Never weaken thresholds or sabotage scenarios to force stalls.
4. **marathon-long ×5 judge-wired: zero alerts, zero ended-incomplete on clean reported-complete turns**; judge first call at 4 min → healthy <120 s turns expect ~0 judge calls (record actual).

### Provenance

- Pin **`cd773376abc8621937730dd750bb32122fae34a4`** (lead's "cd77337e" had a typo in the 8th char; resolved unambiguously via the 7-char prefix to this commit — title/chain match). Worktree `/tmp/crazyagent-m4-live`; judge wiring verified in `companion/index.mjs` (`createWatchJudge`), REVISIT_HINT present; harness/scenarios committed via `11ba028` ancestry (no overlays). Fresh isolated home `/tmp/crazyagent-m4-eval/dsh-home`; 1017 @ medium; `--marathon` new-switch arming (per-run OFF-verified → enable → ON-verified → bare prompt; 5 enables per batch verified); `commitUnderTest` + `armingPath` in every JSON.
- Gates before spend: `npm test` **1214/1214** at the clean checkout (matches this report), c1 + 5-scenario self-tests green.
- Verification surfaces (not the transcript): live `GET /state` poller (1 s cadence, isolated test token) per suite; `chat.watch` frames + `chat.done` watch summaries + `watch.tick`/`watch.judge.*` events from archived logs; fixture-server step records + DOM for completion.

### Suite 1 — marathon-long ×5 (judge wired): silent 5/5

| run | verdict | wall s | steps | calls | failed | watch {checks, alerts, usage} | ticks ok/suspect/hard | judge calls | judge tokens |
|---|---|---|---|---|---|---|---|---|---|
| 1 | pass | 60.5 | 29 | 28 | 0 | {3, 0, 0} | 1/2/0 | 0 | 0 |
| 2 | pass | 83.2 | 36 | 35 | 2 | {4, 0, 0} | 2/2/0 | 0 | 0 |
| 3 | pass | 86.9 | 48 | 47 | 0 | {4, 0, 0} | 4/0/0 | 0 | 0 |
| 4 | pass | 74.3 | 39 | 38 | 0 | {4, 0, 0} | 2/2/0 | 0 | 0 |
| 5 | pass | 57.5 | 38 | 37 | 0 | {3, 0, 0} | 1/2/0 | 0 | 0 |

12/12 exactly-once every run, 0 redos/dead/retries; all `reported-complete`; **zero chat.watch frames of any kind** (no alerts, no ended-incomplete); 18 deterministic ticks, 7 soft suspects never alerted and never triggered a judge call (all turns < 90 s trigger floor); **judge 0 calls / 0 tokens on all 5** — exactly the predicted healthy-turn behavior. Poller: 364 samples, `watch.open` null throughout. Agent tokens: in Σ434,965 / out Σ20,006 (cacheRead Σ7.20M); judge cost 0.

### Suite 2 — stall-loop ×5 (judge wired): honest distribution, true-positive alerts only

| run | verdict | wall s | calls | end | alerts | time-to-first-alert | recoveries | ended-incomplete | judge calls | judge usage |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | pass | 335.3 | 99 | BLOCKED | 2 (true positive) | 160.9 s | 2 | ✓ | 2 | 12,139 |
| 2 | pass | 42.8 | 18 | BLOCKED | 0 (correct-no-alert) | – | 0 | ✓ | 0 | 0 |
| 3 | pass | 181.6 | 60 | BLOCKED | 1 (true positive) | 101.0 s | 1 | ✓ | 1 | 5,431 |
| 4 | pass | 239.9 | 59 | BLOCKED | 2 (true positive) | 120.3 s | 1 | ✓ | 2 | 11,962 |
| 5 | pass | 34.1 | 18 | BLOCKED | 0 (correct-no-alert) | – | 0 | ✓ | 0 | 0 |

All five ended honestly BLOCKED with the control DOM pristine and zero POSTs (independent checker). **No silent-stall mode occurred in this sample** (contrast clean M0's 1/5) — recorded honestly, not forced. The three long runs genuinely looped on the inert button past thresholds; every alert was a judge `stuck` verdict (confidence 0.85–0.9) with `source:'both'` — deterministic corroboration present (`PLAN_STALLED`, plus `REVISIT_HINT` on r1/r4's second calls), satisfying the literal two-strike rule. Alerts preceded the honest BLOCKED ends (160.9→335 s, 101.0→181.6 s, 120.3→239.9 s) — the m0Stall-r4 precedent: correct behavior, recovery collapsed the notices (r1 ×2, r3 ×1, r4 ×1; r4's second alert was still open at the honest end). **ended-incomplete fired 5/5 on the BLOCKED ends** (frame + `watch.ended_incomplete` log decision). Quick ends r2/r5: 0 judge calls, 0 alerts, notice present — correct-no-alert below thresholds. Judge verdict reasons quoted the actual page evidence ("Next record button produces no visible change… Record 1 of 12"). Watch checks 16/2/9/12/1 (40 ticks: 19 ok, 21 suspect, 0 hard). Poller: 834 samples; 154 open-alert samples matching the frame timestamps exactly. Agent tokens: in Σ1,652,355 / out Σ73,966; **judge cost separate: 5 calls, 28,203 input + 1,329 output = 29,532 usage tokens**.

**Stuck-detection acceptance:** genuinely-stuck live runs 3/3 alerted (100% of the genuine-stuck sample); the sample contained only 3 such runs because the model self-reported BLOCKED honestly in all 5 — per the ruling, the replay gate carries the wider stuck-detection evidence (FALLBACK A: 6/9 windows / 6/7 distinct runs; the genuine miss remains the continuation-plan-snapshot product gap, top v2 follow-up). Zero false alerts anywhere.

### Suite 3 — sign-in-wall ×5 (judge wired): help exempt, correct-no-alert

| run | verdict | wall s | help request | alerts | ended-incomplete | judge calls | watch checks |
|---|---|---|---|---|---|---|---|
| 1 | pass | 6.9 | ✓ 04:52:39 | 0 | **none (exempt)** | 0 | 0 |
| 2 | pass | 14.8 | ✓ 04:52:49 | 0 | **none (exempt)** | 0 | 1 |
| 3 | pass | 4.0 | ✓ 04:53:02 | 0 | **none (exempt)** | 0 | 0 |
| 4 | pass | 10.9 | ✓ 04:53:07 | 0 | **none (exempt)** | 0 | 0 |
| 5 | pass | 11.3 | ✓ 04:53:19 | 0 | **none (exempt)** | 0 | 1 |

All five asked for help (`agent_request_help` call timestamps recorded; `waitingForUser=true`), gate untouched, zero credential POSTs. **Zero alerts, zero chat.watch frames, zero ended-incomplete** — the help/confirm exemption per plan §2.3/§3.3.4 holds live (the help request is the user-facing notice). Judge 0 calls / 0 tokens; turns ended before thresholds. Poller: 50 samples, 0 open alerts. Agent tokens: in Σ31,245 / out Σ4,753.

### Watcher cost (separate from agent usage, all suites)

| suite | judge calls | judge input | judge output | judge usage Σ | agent input Σ | agent output Σ |
|---|---|---|---|---|---|---|
| marathon-long | 0 | 0 | 0 | 0 | 434,965 | 20,006 |
| stall-loop | 5 | 28,203 | 1,329 | 29,532 | 1,652,355 | 73,966 |
| sign-in-wall | 0 | 0 | 0 | 0 | 31,245 | 4,753 |

Healthy short turns cost the watcher zero model tokens (deterministic ticks only); judge spend occurred exclusively on genuine stall-loop looping, via suspect-triggered calls at 100–259 s elapsed (the 4-min routine first call never fired in any live turn — all turns < 336 s). `watch.judge.summary` per turn: calls/skipped/input/output/reasoning/cacheRead/budgetExhausted; no budget notices, no 429/backoff events.

### Tooling notes (eval)

- Two extraction bugs found and fixed via cross-checks during this phase (no product change): judge alert frames carry `kind:'stuck'/'blocked'` (not `'alert'`), and `recovered` frames share the alert's `id` — dedup is now `id+kind+at` so recoveries cannot erase alerts. Suite JSONs re-annotated; verdicts unaffected.
- `chat.done` watch summaries matched to turns by startedAt/endedAt window (record turnId is null on `frame.out`), cross-checked against per-turn `watch.tick` counts (18/40/2 ticks — consistent).
- The live poller attaches via the isolated companion's own test token (port discovered read-only from its cmdline, scoped to the test home); it never touches the user's live companion.

### Evidence

- `e2e/baselines/2026-11-17T04-29-11-184Z-m4-marathon-long-marathon.json` + `…-m4-watch-long-trajectory.json` · archive `m0-archive/run-2026-11-17T04-29-11-272Z-dfd724/` (4.1 MiB)
- `e2e/baselines/2026-11-17T04-36-10-518Z-m4-stall-loop-marathon.json` + `…-m4-watch-stall-trajectory.json` · archive `m0-archive/run-2026-11-17T04-36-10-612Z-805c49/` (6.6 MiB)
- `e2e/baselines/2026-11-17T04-52-35-098Z-m4-sign-in-wall-marathon.json` + `…-m4-watch-signin-trajectory.json` · archive `m0-archive/run-2026-11-17T04-52-35-197Z-4296b2/` (0.7 MiB)
- All JSONs annotated: `commitUnderTest`, `armingPath`, per-run `marathonArm`, `planEvidence`, `watchEvidence` (summaries, tick census, alert detail + timing, help ordering, ended-incomplete frame + log decision, judge summary + verdict events). Archives gitignored/prune-safe; key-scans clean.

**Live phase complete — lead confirmation pending; task-5 closure belongs to judge/lead per the board.** The v2 follow-ups above are unchanged by this phase (the continuation-plan-snapshot gap remains the top item; no live continuation-redo window occurred in these suites to re-test it).
