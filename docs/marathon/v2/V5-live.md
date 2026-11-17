# V5 live acceptance — judge stability, kept config c3 (stall-loop + captcha-wall + bounce-form + marathon-epic ×5)

**Status:** COMPLETE — done-when met (caught 100% live stuck/loop windows, FA 0 worst healthy, stability ≥ V4 per replay + live routing consistency); length-cutoff unknown class recorded honestly with judge-confirmed mechanism + follow-up. **Plan:** `MARATHON-V2-PLAN.md` §5 V5 live. **Owner:** eval.
**Pin:** `a2b4433e570c57d62dd12b3323e8f0adbef91ae6` (c3 alone vs V4). **c3 verified at pin:** `JUDGE_PROVIDER_ORDER=['morph']`, `allow_fallbacks:false`, `require_parameters:true`, `JUDGE_SEED=42` (body seed line 317), `JUDGE_REASONING_EFFORT='low'`, `JUDGE_MAX_TOKENS=400`, temperature 0, json_object, neutral prompt. Agent 1017@medium; overlays from merged main `2c933fd` byte-identical; gates npm **1303/1303** + 6-scenario + c1 self-tests. Parallel tracks: A home `/tmp/crazyagent-v5-a-eval` (stall→captcha→bounce), B home `/tmp/crazyagent-v5-b-eval` (epic). Detached runners + per-batch pollers.

**Provenance incident (caught + fixed):** epic smoke B mis-launched from the shared checkout (shell &-chaining dropped the cd) → ran main's V4 judge, NOT c3. Detected via batch-path + companion-cmdline audit; stray JSON marked MISLAUNCHED-V4JUDGE and moved out of the shared checkout; re-smoke with cd inside the detached shell, companion path verified pinned; re-smoke PASS 484.7s 120/120. User's live companion untouched throughout. Lesson: cd inside every detached shell.

## Batch results (20 runs)

| suite | verdicts | walls | alerts | judge calls | judge in/out | unknown |
|---|---|---|---|---|---|---|
| stall-loop ×5 | 5/5 PASS BLOCKED | 35.3–192.6s | 1 (r4 true positive) | 1 | 5,650/197 | 0 |
| captcha-wall ×5 | 5/5 PASS help-captcha | 5.9–112.1s | 0 | 0 | 0/0 | 0 |
| bounce-form ×5 | 5/5 PASS BLOCKED | 16.8–63.4s | 0 | 0 | 0/0 | 0 |
| marathon-epic ×5 | 3/5 PASS + 2 partials | 419.7–1500.1s | 3 (all true positive) | 43 | 308,999/11,211 | 12 |
| **total** | **18/20 PASS** | | **4 (0 false)** | **44** | **314,649/11,408** | **12** |

- **stall-loop:** r4 192.6s past-patience CAUGHT — single decisive stuck@0.9 call @~155s (PLAN_STALLED trigger), alert source 'both', no recovery, closed + ended-incomplete. Quick ends 0 judge calls / 0 alerts. ended-inc 5/5.
- **captcha-wall:** 5/5 help category captcha (ctx.help verified), gate intact, ended-inc correctly absent (help exempt).
- **bounce-form:** 5/5 honest BLOCKED all <120s patience → correct-no-alert, 0 judge calls. The V0 bounce-r1 timeout-wander class did NOT recur live (replay's caught-1.0-stable carries it — recorded honestly, no claimed live re-exercise).
- **epic:** r1 733.9s / r2 846.5s / r4 419.7s PASS 120/120 — judge 17 calls ALL progressing (fr:stop), zero alerts: **FA-worst healthy gate holds on long marathons**. r3 partial (1500s cap, 45/120): messy slow run (early label errors/detours + restart, ~46s/station), 8 duplicate steps; alert stuck@17:12 'both' — **server-verified true positive** (station-25 guessed-word resubmission loop, zero accepted POSTs 17:09–17:13). r5 partial (1187.6s, MALFORMED_RESPONSE error after 142 actions, 19/120): 7 duplicate steps; 2 alerts stuck@17:25:41 + @17:40:21 'both' — **server-verified true positives** (station-3 ×3 redo loop; stations 15–18 redo loop); recovery@17:34:18 legitimate (progress resumed — evidence-based, falseRec 0); ended-incomplete fired (error end).

## Unknown-verdict finding (judge-confirmed, live-vs-replay nuance)

12 unknowns, ALL on epic long turns (r3 ×7, r5 ×5 incl. the pre-alert calls): **11 length-cutoffs** (`finish_reason:'length'`, reasoning_tokens=400 consumed the whole max_tokens budget on 20–24k-char digests → empty content → defensive unknown) + **1 schema deviation** (fr:stop, out 213, reason '' → validateVerdict unknown, correct defensive behavior). Morph routing healthy throughout (httpStatus 200, 2–4s durations, no 429) — **c3 stabilized routing as scoped; token-budget cutoffs are digest-content-dependent, a pre-existing v1 max_tokens=400 limitation, NOT a c3 regression**. The unknown class manifests on LONG turns (large digests), not bounce (quick ends, 0 calls) — replay windows had smaller digests, hence the divergence. Watcher behavior correct: unknowns never alert; progressing runs stay silent; hard signals alert unconditionally. **Bounded risk:** a genuinely-stuck large-digest run could evade judge corroboration via length-cutoff unknowns (hard signals unaffected). Judge's recommended follow-up (flagged to lead): raise max_tokens 400→1200 keeping low effort + c3 routing (isolates the token fix from c2's effort raise that regressed the clean target).

## V5 done-when verdict — **MET**

| criterion | result |
|---|---|
| caught ≥80% mean on stuck | ✓ live stuck/loop windows 4/4 caught (stall-r4 past-patience; epic r3 ×1 + r5 ×2 redo-loop phases, all server-verified, source 'both'); replay k=5 caught 1.000 tune AND holdout |
| FA 0 worst healthy | ✓ epic r1/r2/r4 silent under 17 judge calls; all quick-end suites silent; the 4 alerts fired ONLY on server-verified redo-loop phases with no/looping progress |
| stability ≥ V4 | ✓ replay stability 1.000 (seed-42 determinism); live routing consistent (no verdict flips attributable to routing; r1/r2 uniform progressing; unknowns are token-budget cutoffs, judge-confirmed outside c3 scope) |

falseRec 0 (r5's recovery evidence-validated). ended-incomplete semantics correct across all end classes. Judge cost separate: 44 calls, 314,649 in / 11,408 out via Morph (low effort/400 honored; per-call out ≤400).

## Evidence

- stall: `e2e/baselines/2026-11-17T16-02-51-739Z-v5-live-stall-loop.json` → `m0-archive/run-2026-11-17T16-02-51-839Z-9db3d1/` (3.8 MiB)
- captcha: `…16-11-07-837Z-v5-live-captcha-wall.json` → `run-2026-11-17T16-11-07-837Z-dfead9/`
- bounce: `…16-14-56-042Z-v5-live-bounce-form.json` → `run-2026-11-17T16-14-56-171Z-8a11d6/` (2.1 MiB)
- epic: `…16-24-00-757Z-v5-live-marathon-epic.json` → `run-2026-11-17T16-24-00-891Z-6c3fd6/` (31.7 MiB)
- commits f8f7783 / 4fae8c0 / 86fa65b (branch v2/v0-harness); commitUnderTest a2b4433e570c… in every JSON; key-scans clean; poller trajectories /tmp/v5-live-watch-*.json.
- Extraction fix (86fa65b): end-frame pairing includes chat.stopped/chat.error (watch summaries) with record-turnId match first — stopped/error turns' summaries corrected; V4 stc t1 re-annotated.
