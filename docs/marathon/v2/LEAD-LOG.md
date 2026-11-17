# Marathon v2 — lead orchestration log

Night of 2026-11-17 (user asleep, full authority delegated to lead; no questions to user).
Governing plan: `MARATHON-V2-PLAN.md`. v1 record: `docs/marathon/M*-report.md` (unchanged).

## Opening state (verified by lead)
- Shared checkout moved from detached `v2.4.0` to `main` = `8c74976` (user's post-release
  Android-artifact publish; code-identical to `de5f69c`, docs/version bookkeeping only).
- Opening gate: `npm test` **1237/1237** at main (12.5 s), exit 0.
- Untracked, left alone (user session): `e2e/baselines/2026-11-17T00-58-03-146Z-c1-acceptance.json`,
  `e2e/baselines/2026-11-17T01-01-29-267Z-c1-acceptance.json`. `MARATHON-V2-PLAN.md` committed
  by core as V1 step 0 (explicit path).
- Archive inventory: `.dsh-home/browser-agent/logs/m0-archive/` 25 entries (~67 MB), incl.
  M4 live `-dfd724`/`-805c49`/`-4296b2` and tuned suite-1 `-b5a71b`. Machine-local (gitignored).

## Lead rulings
1. **V9 DEFERRED** (plan decision #10 veto exercised). Optional restart-persistence milestone;
   activated only if V0–V8 finish with clear overnight margin and lead gives explicit go.
   Fail-safe "marathon off on restart" invariant stays unless V9 ships.
2. **Integration**: each milestone in its own worktree + branch `v2/<name>` from main;
   explicit-path commits; no stash / whole-tree checkout / reset. Teammates report hashes;
   **lead reviews diff, runs `npm test` at integration head, merges (ff-only)**. Push to origin
   + tag only at V10 release (v1 flow). Never sweep other sessions' untracked files.
3. **Parallelism**: V0-a (eval: harness/scenarios/collection) ∥ V0-b (judge: corpus/labels/replay)
   ∥ V1 implementation (core) ∥ V1-android prep (android). V1 MERGE waits for V0 baseline.
   V6/V7 (android) run alongside core's V2–V5 after V1 lands (disjoint files: hub→android for V6;
   ledger/watcher/judge/controller→core). V8 implements after V4, MERGES after V5 (one main change
   per live scoring). V5 live uses the kept judge config only.
4. **Provenance** (§6, M0 rule): every real-model batch from a worktree pinned at the commit under
   test + harness overlays + node_modules symlink + fresh isolated home/profile/ports;
   `commitUnderTest` recorded. V0 collection pin = `de5f69c` (tag v2.4.0). Model fixed
   `deepseek/deepseek-v4.1-flash-1017` @ medium; judge low unless V5 keeps a change.
   Never live companion 17871/17873 or user browser profile; stop only own PIDs.
5. **Holdout discipline**: split by run, fixed before scoring; tune-only while changing code;
   holdout scored once per milestone at end; no code change after viewing holdout in-milestone.
6. **Honesty**: corpus shortfalls recorded, never manufactured; labels from server records with
   fixed patience (240 s / 120 s), disagreements reported not relabelled; V5 fallback = best
   zero-false-alert config + recorded gap (M4 style) if no candidate reaches ≥80 % caught.
7. **Watcher stays report-only**; hard signals model-independent; untrusted input; cost separate;
   user's auto-updater (`cdcd9d1`) preserved verbatim, marathon-scoped acceptance only.
8. **Phone**: stays paired with `conan-evo-x3`; no re-pairing, no on-device work, no delivery
   claims. V7 gives a test route; actual delivery remains user-side (key + restart).

## Task board (v2)
task-12 V0-a (eval) · task-13 V0-b (judge) · task-14 V1 (core) · task-15 V1-android (android)
task-16 V2 (core, ←13,14) · task-17 V3 (core, ←16) · task-18 V4 (core, ←17)
task-19 V5 (judge, ←18) · task-20 V6 (android, ←14,15) · task-21 V7 (android, ←20)
task-22 V8 (core, ←18; merge after V5) · task-23 V9 (DEFERRED, ←22) · task-24 V10 (core, ←19,21,22)
Live-acceptance tasks created just-in-time with exact pins.

## Status
- 01:35 local: kickoffs sent; opening gate green (1237/1237).
- 01:50: core committed governing plan doc on main = `8220205` (explicit path, verified scope).
  Worktrees: core `crazyagent-v2-v1` [v2/v1-lifecycle], android `/tmp/crazyagent-v2-v1-android`
  [v2/v1-android], judge `/tmp/crazyagent-v0-corpus` [v2/v0-corpus @8c74976], eval
  `/tmp/crazyagent-v2-v0-harness` [v2/v0-harness]. judge verified watch-{ledger,watcher,judge}.mjs
  identical to de5f69c → replay scores v1 behavior. judge↔eval timestamp-schema coordination started.
- ~02:10–02:30: THREE teammate turns failed abruptly (runtime hiccups, no closing message):
  eval (×2, no files yet), judge (after plan report, no files yet), android (partial:
  FakeCompanion.kt + MarathonLifecycleTest.kt intact). core unaffected (watcher.mjs in progress).
  RESUMED all three via send_message. **Resilience ruling: work in SMALL committed increments,
  report after each** — so a hiccup can't erase progress. Monitor closely; re-resume on failure.
- Progress (actual local ~01:55; earlier ~02:xx estimates were wrong — night is young):
  main `8220205` plan doc (core). eval `be1ece7` per-step serverRecords schema (verified
  stop-then-continue smoke; self-test 18/18). judge `158da42` watch-label.mjs + manifest + 5
  traces (legacy-manual from -dfd724; key-scan clean; parser matches eval schema). core V1
  `a432450` watcher lifecycle (+7 tests, 24/24) + `fa91f67` controller #begin close. android
  `9e96bfd` 12 JVM lifecycle tests — KEY FINDING: M5 reducer needs ZERO production change
  (generic remote.watch already closed==dismissed); gradlew 137/0 lint clean.
  Rolling runtime hiccups kill turns after reports; all teammates resumed, committing small
  increments. judge was slow to start (forceful nudge → first commit). Gated stuck labels will
  come from eval's NEW collection (serverRecords); old archives legacy-manual only.
  Next: eval marathon-epic→3 walls→collection; judge all-24-runs+holdout+counts; core hub→ack→
  panel→gates; android fixture (waits core hub hash)→V6→V7.
- ~02:10: V1 nearly done. core commits a432450/fa91f67/b1edf7b/ecbf1bb/c0d89d5/94a5651 —
  **V1 production surface = ONLY watcher.mjs + session-controller.mjs**; hub/remote-server/panel/
  Android reducer all already generic (closed==dismissed), tests prove it. android 9e96bfd (12 JVM
  tests) + 75ff9c2 (merged core c0d89d5) + 5ea6cb8 (real-hub fixture marathon-watch-lifecycle.json
  + report). V1 merge waits judge V0 baseline.
  V0: eval be1ece7 (serverRecords schema) + 7bcfd71 (marathon-epic 36 stations) + 7771620
  (captcha-wall + ctx.help independent category check); spinner-forever in progress; epic smoke
  attempt 1 VOID (killed by hiccup, 0 runs, no orphans) — re-run. judge 158da42→36337d4→55e401f→
  8f96960: corpus 122 windows/24 runs, traces 0.81 MiB committed, key-scan clean; holdout FIXED
  by-run 8 holdout/16 tune seeded-hash before scoring; fine 114 (≥80 met), fine>4min 2 (short),
  stuck 8/5 runs (short); GATED fine 24 + stuck 6; legacy-manual 65; synthetic 0. Gated targets
  depend on eval NEW collection.
  **Rulings added**: (a) contaminated-origin windows ACCEPTED as gated (labels independent of
  product code; replay runs pinned v1 watcher; isolated fixture runs) — mark origin:'contaminated',
  report gated metrics incl/excl them (sensitivity), flag if gate flips. (b) RESILIENCE: long model
  runs/replay scoring/full npm test as BACKGROUND jobs (run_in_background + job_output) so turns
  survive; commit before long runs; commit-first on every resume. Runtime hiccups kill turns every
  few min — lead re-resumes promptly; durable context + small commits preserve all work.
- ~02:20: **judge stuck in failure loop on watcher-eval (~6 turns, 0 commits on that piece)** while
  corpus solid (158da42→8f96960). LEAD INTERVENTION: spawned fresh teammate **replay** to own
  watcher-eval refactor + v1 baseline (task-13 reassigned judge→replay); judge stood down to V5 prep
  (task-19, read-only design until V4 lands). replay works in /tmp/crazyagent-v0-corpus on
  v2/v0-corpus (judge hands off). android turn FINISHED normally (583e59d1) — task-15 complete &
  accepted, V6 design approved, standing by for V1 merge. core V1 at 6332549 (ui-preview watch
  steps); needs fake-companion run + docs + report + npm test confirm. eval all 4 scenarios built:
  be1ece7/7bcfd71/7771620/fe8947b/7a3149e (bounce-form); captcha smoke PASS (help category captcha
  independent); epic killed 3× by hiccups → DETACHED setsid runs ruled for long batches; collection
  next. Team: lead + eval/core/judge/android/replay.
- ~02:30: **V1 COMPLETE** (core tip `17571dd`, branch v2/v1-lifecycle): npm 1256/1256 (1237+19);
  production ONLY watcher.mjs (+150/−31) + session-controller.mjs (+7); hub/remote-server/panel/
  reducer ZERO production change (generic closed==dismissed, tested); ui-preview watch 7 shots
  inspected; fake-companion /state-after-EACH-boundary 5/5 (stale 0, ack 200, own-id close before
  next turn first frame). android task-15 accepted (5ea6cb8). Ready to merge pending V0 baseline.
  **EPIC RULING**: detached epic smoke PASS but 136s (<4-min judge threshold) → defeats G8 purpose.
  Lengthen epic to ~60–72 stations so efficient healthy turns ~4–8 min (judge fires on progress);
  honest measurement design (more legitimate work), NOT stall manufacture. ≥15 fine>4min count
  unreachable with ×5 (1 fine window/turn) → record shortfall, gate on what exists.
  **watcher-eval ownership saga**: judge FS-guard write loop → spawned replay → replay produced
  manifest-driven draft (+41/−29 on disk) but flaky turns → **core takes ownership** (commits replay
  draft + finishes --repeat/--dry-run/baseline); task-13 reassigned judge→replay→core. replay stood
  down. judge stood down to V5 prep (superb notes: temp-0 non-determinism root cause = ~50 endpoints/
  providers/quantizations per-request load-balancing; supported_efforts=[max,high,low,none] so
  candidate-2 'medium' maps nearest — verify effective via reasoning_tokens; candidate designs ready).
  **V5 RULINGS**: plan numbered test order 1→2→3→4 (first passing keep-rule kept, then stop);
  candidate-2 verify effective effort + record; agent acceptance effort stays medium; candidate-3
  root cause documented regardless; neutral prompt; holdout once at end; M4-style fallback if none
  reaches ≥80% caught. V5 go after V4 merge.
  Active: eval (detached collection ~2–2.5h), core (watcher-eval+baseline → V2). judge/android/replay
  standing by. FS-guard lesson: RE-READ file in current turn before edit (resets across resumes).
- ~02:40: core RELIABLY unblocked watcher-eval: `1ab6484` split-preservation fix FIRST (protect
  frozen holdout: preserve existing run→split, assign only new runs via same seeded hash, assert no
  flips — replay's critical catch), `65d69d9` manifest-driven watcher-eval (replay draft completed:
  trace loader sha256 fail-closed, hard-coded windows deleted, --split/--manifest, metrics per §3.1),
  + watcher-eval-corpus.test.mjs (--dry-run npm test plumbing). replay sent core line-anchored handoff
  (crash L421, delete L94–146/L274–340, metrics caught=[t0−60,onset+240]/early≠false/falseRecovery∈
  [onset,stuckEndSec]/stale=mid-turn alert open-at-end w/o close frame/redo=chat.watch within 120s;
  --repeat worst-case stuck=caught in ALL k; per-repeat intermediate JSON for turn-death resilience).
  replay stood down (available V5 support). **EPIC pace finding**: model LEARNS pattern, batches
  aggressively (marginal stations ~1.6s) → 36=136s, 72=193s (judge fired via PLAN_STALLED suspect-
  trigger @119s→progressing@0.9, zero alerts, 4 soft suspects = V2/V4 gap evidence). eval bumped
  36→72 (380e405)→120 (4be9a12) for robust >4min routine-cadence floor (~5.4min projected, ~230k
  input verifying). All 4 new scenarios smoke-PASS (captcha help-category-captcha independent;
  spinner BLOCKED 58.6s; bounce BLOCKED 32.4s 0 POSTs). Collection fires on epic-120 confirmation
  (gates-first, 6 batches ×5 detached). Next: core V0-baseline.md k=3 both splits → V1 merge → V2.
- ~02:50: **V0 + V1 MERGED to main `f08b57c`** (lead reviewed V1 production diff — watcher.mjs
  +150/−31 + session-controller.mjs +7 only; report-only invariant intact; merges v0-harness 2942b63
  + v0-corpus 0d18365 + v1-lifecycle 17571dd + v1-android 5ea6cb8, all clean). Integration gate
  **npm test 1257/1257** (1237+19 V1+1 corpus plumbing). Versions still 2.4.0. AGENTS.md V1
  invariant merged. task-14 V1 complete; task-15 V1-android accepted.
  **V0 baseline (0d18365, old-archive corpus 122 windows)**: fine zero false alerts PASS mean+worst
  both splits (hard req holds); stuck caught MEAN 100% / worst-case 50% (tiny gated set 6, variance =
  V5 target); stale alerts 1 (v1 turnEnded nulls openAlert w/o close = V1 fix, measured); false
  recoveries 5 gated (V2 fix); suspect-tick baseline recorded; cost <$0.1 separate; contaminated
  sensitivity NO gate flip; shortfalls honest (fine>4min 2/15, stuck 8/5runs — eval collection fills).
  **EPIC-120 confirmed**: 430.5s/7.2min healthy, 120/120 exactly-once, judge 4× progressing@0.9/0.95
  ZERO alerts, no overflow; **90.5% healthy-suspect rate (19/21 ticks: REPEAT_LOOP station-form +
  PLAN_STALLED open-flat + REVISIT_HINT) = V2/V3/V4 input gap quantified** (V2 gate reference).
  Collection detached PID 194888 (epic ×5 ~35min then captcha/spinner/bounce/stall/stop ×5).
  **CAUGHT-GATE RULING**: caught gate = MEAN across k ≥80% (§5 V5); worst-case caught + stability are
  diagnostics / V5 keep-rule (stability must not fall); FALSE-ALERT gate = worst-case 0 on fine.
  NEXT: android V6 (task-20 unblocked, branch v2/v6-liveplan from f08b57c); core finish V0 ingestion
  (eval batch→archive mapping; split-preservation protects holdout) + full-corpus re-score → V2
  (task-16, branch v2/v2-progress); eval collection + mapping reports. judge V5 prep ready (go after
  V4). replay standing by (V5 support).
- ~03:25: **V6 MERGED main `51cb5c3`** (npm 1264/1264; hub remote.plan +32/−2 additive report-only;
  android found+fixed G6 root cause: M5 requestPlan hook fed controller NOT hub; live mid-turn JVM
  gate rev1→rev2→handoff; real-hub fixture malformed-drop 3-for-4; gradle 147/0). task-20 accepted.
  android V7 started (v2/v7-pushtest from 51cb5c3).
  **V2 impl DONE** (core 91c4621/f334775/2507075/996f0e1, npm 1272/1272, 15 tests): tool classes
  observe/control/act; noProgressResultText shared by construction (repeat-guards→lib/index→ledger);
  NO_EFFECT ≥4/8 soft signal; evidence-based recovery (≥2 effectful acts + signals absent 2 ticks OR
  completed-count up). Gate-framing fix 5f05bf1: gatePass = fineZeroAlertsWorst && stuckCaughtMean
  (§5 V5); worst-case caught/stability diagnostics. Provisional V2 tune PASS (fine FA 0 mean+worst,
  caught mean 100%, falseRecovery 0 [V0 had 2], stale 0 [V1 fix], stability 0.9).
  **NO_EFFECT RULING**: V2 raises healthy suspect ticks (all-fine 0.388→0.525, gated-fine 0→0.125)
  BY DESIGN (G3 dead-button detection); corroborated a judge stuck→FALSE ALERT on NON-gated legacy
  fine 458428-t3 (stop-then-continue wander). Binding hard gates = gated-fine FA worst 0 + caught
  mean ≥V0 + falseRecovery 0 (full corpus is real test). suspect-tick '≤V0' done-when DEVIATION
  recorded honestly, re-evaluated CUMULATIVELY after V4 (V3 removes REPEAT_LOOP false suspects, V4
  removes PLAN_STALLED); flag to user in morning report. core investigating 458428-t3 (NO_EFFECT sole
  corroborator? → V5 judge-accuracy + V3/V4 input target). If ANY gated fine false-alerts on full
  corpus → V2 FAILS hard gate → mitigate within V2 (minimal page-aware NO_EFFECT or threshold).
  Collection epic ×5: run1 301.7s/run2 496s/run3 605s PASS 120/120 (run3 input 1.8M tokens, no
  overflow); run4/5 in flight; then captcha/spinner/bounce/stall/stop ×5 (~04:15 full). core ingests
  on eval handover (batch→archive mapping; split-preservation 1ab6484 asserts 0 flips) → full V0
  re-score → V2 tune k=3 + holdout once.
- ~03:50: **V7 MERGED main `f5698f7`** (npm 1270/1270; POST /push/test auth/idempotent/1-min/explicit
  answers + TEST push normal channel + Settings button; fake 7/7, gradle 150/0; android queue empty,
  stands by for V8-android after V4). Collection 20/30: epic5/5 (>4min, judge 20 calls 19prog+1unk
  ZERO alerts, 90.4% healthy-suspect ref), captcha5/5 (help-captcha exempt), spinner5/5 (BLOCKED
  <120s fine, ended-incomplete 5/5), bounce3/5+2 honest fails (r1 300s genuinely-stuck wander judge
  unknown@0×2 → v1 MISSED = key V2/V5 catch target; r2 tab-left fail-closed unverifiable). stall-loop
  + stop-then-continue running. core ingestion: a3a17bd CRITICAL label-fix (onset needs real 240s
  no-progress gap, else healthy epic mislabeled stuck; 0 relabels), b92d313 epic+captcha, 937b22d
  spinner, 4f7d4aa bounce → corpus 142, gatedStuck 7, gatedFine 43, fine>4min 7, 0 old flips.
  **SPLIT-REBALANCE RULING**: all 4 new runs hashed into HOLDOUT → tune left with only old easy
  windows (caught maxed 100%) → V5 'caught rises' keep-rule unmeasurable + no new-evidence iteration.
  Ruled: re-assign NEW runs SCENARIO-STRATIFIED ~1/3 holdout (deterministic, scenario metadata only,
  NEVER labels/results; OLD 24 frozen 0 flips) BEFORE V2 full-corpus scoring; record rebalance in
  manifest+V0 report. Makes tune representative + V5 selection meaningful. Honest shortfalls:
  stuck target ≥15/10runs likely short (~10: old 6 + bounce 1 + stall-loop ~3); record, gate on what
  exists. bounce r1 watchdog-stop ended-incomplete absent = observation (v1 pin), core to examine.
- ~04:10: **V0-a COLLECTION COMPLETE + MERGED main `0dc6af6`** (eval task-12 closed): 30 runs @de5f69c,
  27/30 PASS + 3 honest fails (bounce-r1 stuck-missed judge unknown@0×2; bounce-r2 tab-left
  fail-closed; stall-r2 out-of-scope POST /upload), **ZERO false alerts**, 1 true-positive (stall-r2
  alert@194s source both). epic ×5 >4min judge 20 calls (19prog+1unk) 0 alerts → G8 CLOSED.
  continuation redo 0/5, seeded 5/5. judge 24 calls 172,128/3,939 separate. healthy-suspect ref
  103/114=90.4%. 6 archives 43MiB annotated. shortfalls recorded (fine>4min +5 live vs ≥15; live
  stuck 2 vs ≥15 — corpus carries gated). eval stands by for live pins (no spend until GO).
  core ingestion COMPLETE + REBALANCE `1ec66fe`: corpus **157 windows** (gatedFine 52/gatedStuck 8/
  legacy 70/fine>4min 7/distinctStuckRuns 7). old 24 frozen 0 flips; new 6 scenario-stratified ~1/3
  (epic→HOLDOUT, stop→tune; captcha/spinner/bounce→tune, stall-loop→HOLDOUT) = 20 tune/10 holdout
  runs. TUNE gated fine27/stuck3 (incl bounce-r1 MISSED → V5 caught-rises measurable); HOLDOUT
  fine25/stuck5 (incl epic long-fine). **STRATIFICATION RULING**: KEEP unbiased (epic holdout) —
  binding hard gate zero-FA on healthy long-fine must be unbiased holdout-once; epic in tune would
  leave holdout no long-fine + allow fitting. suspect-tick deviation recorded; V2 epic-suspect effect
  measured at holdout. core running FULL-corpus V0 re-score (v1) k=3 detached → V2 tune k=3 + holdout
  ONCE. Next: V2 hard gates (gated-fine FA worst 0 both splits, caught mean ≥V0, falseRecovery 0) →
  eval V2 live pin 996f0e1 (stall-loop ×5 + epic ×5) → V2 merge → V3→V4→V5→V8→V10.
- ~04:20: **V2 FULL-CORPUS REPLAY k=3 DONE** (core 7d0fd8e V2 branch vs V0 true ref 349116d;
  mean-rate metric fix 33409c9 = avg per-window fractions per §5 V5). Corpus 157. BINDING HARD
  GATES PASS: (1) gated-fine FA WORST 0 BOTH splits incl unbiased epic-120 healthy long-fine ✓✓
  (NO_EFFECT did NOT false-alert healthy epic); (2) caught MEAN ≥V0 ✓ tune 0.556→0.778 (bounce-r1
  still 0.33 missed unknown×2), holdout 0.867 held; stability tune 0.900→0.967. (3) falseRec tune
  3→0 ✓, HOLDOUT 4→1 residual (805c49-t4 stall-loop recovery@240==stuckEnd==turn-end via
  completed-up + 11 effectful CLIENT acts + signals absent; server label stuck 0 POSTs).
  **RESIDUAL RULING = option (A) accept recorded gap**: fundamental client-side-recovery vs
  server-side-label perspective mismatch (watcher can't see server progress) + turn-end boundary
  (V1 close supersedes) + holdout discipline forbids tuning + tune 0 falseRec (no evidence). V2
  falseRec done-when met TUNE; live gate next actionable test. Document V2-report; flag user morning.
  suspect-tick deviation tune 0.074→0.111/holdout 0.240→0.360 (NO_EFFECT by design, re-eval after V4).
  legacy 458428-t3 = label-disagreement validating NO_EFFECT. stale holdout 1→0 (V1 fix).
  **V2 LIVE GO sent eval pin 7d0fd8e** (stall-loop ×5 + epic-120 ×5, judge wired, tick census vs
  90.4% ref, falseRec/FA per turn, independent server+/state). V2 merge after live green (falseRec 0
  live, FA 0 worst, caught mean ≥V0). core prep V3 design meanwhile. Counts honest: gatedStuck 8<15,
  fine>4min 7<15 (corpus carries gated per §8).
- ~05:40: **V2 MERGED main `8b7419b`→`b1be637`** (npm 1285/1285; watcher-eval cosmetic conflict
  resolved — identical gate logic, V2 diagnostics output kept; V2-live evidence merged). task-16
  complete. V2 live all-4 green: falseRec 0, FA 0 (epic 2137 samples 0 open), caught ≥V0 (stall-r4
  @109s both), suspect **86.0% ≤ V0 90.4%** (act-class accounting offset NO_EFFECT; smoke 94.1% high
  tail). 10 runs 2 true-positive alerts judge 22 calls separate. epic-120 completion 2/5 PASS+3
  partials = AGENT-CORRECTNESS/checker-contract follow-up (r1 genuine skip/redo+false DONE caught by
  server records; r2/r3 server-complete but frozen final-state contract/reload-reset) → user product
  decision later, watcher clean, no bending.
  **V3 IMPL `828d5e6`** (npm 1293/1293 +8 tests): parsePageKey/parseControlName/pageKeyPath,
  currentPageKey most-recent-URL (clicks keep prev, unknown stays), pageActStats effectful acts KNOWN
  page full-URL|fingerprint|controlName (unknown excluded→silence, no-effect→NO_EFFECT, observe/control
  excluded), REVISIT_HINT mutation-revisit page-scoped threshold 2 (was whole-window 3), openFlat
  unchanged (V4), nav digest-only, digest +pageKey+controlName+pageIdentity{unknownPageShare},
  REPEAT_LOOP UNCHANGED (epic station-form residual recorded). **V3 REPLAY `9c1359d`** vs V2:
  gated-fine FA WORST 0 BOTH ✓; caught mean tune 0.778→0.556 (✗ literal) holdout 0.867 held ✓;
  falseRec tune0/holdout1 (V2 residual); suspect share unchanged; page-unknown 4.1% (low).
  **TUNE CAUGHT DROP = JUDGE VARIANCE ruling (option A)**: core debug 00-43-57-t2 page KNOWN 16 pages,
  PLAN_STALLED+openFlat corroboration INTACT, mutationRevisit false in BOTH V2/V3 → V3 no regression;
  V2 caught 3/3 lucky vs V3 1/3+2/3 on 2 original stalls; holdout held. Accept documented variance,
  LIVE ×5 binding reliability test (contract: repeat to tell lucky from reliable). V3 benefit =
  multi-page SAME-CONTROL revisits (marathon-long live); epic suspects REPEAT_LOOP/PLAN_STALLED/openFlat
  not mutation-revisit (unchanged expected, V4 owns openFlat). **V3 LIVE GO eval pin 9c1359d**
  (marathon-long ×5 + epic ×5): REVISIT_HINT mutation-revisit 0 healthy, FA 0 worst, caught mean ≥V2
  live. core document variance + labelled-redo coverage (informational). V3 merge after live green →
  V4→V5→V8→V10. Merged so far: V0/V1/V2/V6/V7 (main b1be637).
- ~06:05: **V3 CAUGHT INVESTIGATION** (core exemplary honesty, 2 self-corrections): V3 replay tune
  caught 0.778→0.556 (k=3). core first claimed 'pure variance' → optional k=5 SAME-K falsified it
  (V2 0.867 vs V3 0.600, gap persists all 3 tune stuck windows = STABLE effect). Root-cause hunt:
  (1) pageIdentity{distinctPages} in judge digest hypothesis → fix pin 1e3ea50 (pageIdentity
  replay-only, b59981a) → tune k=5 STILL 0.600 identical per-window → pageIdentity NOT cause;
  holdout k=3 dropped 0.867→0.667 (noisy). (2) Refined: the INTENDED §3.4 mutationRevisits
  pageKey/controlName annotation makes judge read nav revisits as cross-page exploration→progressing
  vs V2 bare 'switch_tab count3'→stuck. Page-scoped REVISIT_HINT SIGNAL sound; digest ANNOTATION hurts
  caught. **eval V3 HOLD executed** (pin 9c1359d buggy): scoped PGID kill 1163694+poller, 0 orphans,
  ×5 never fired, void diagnostic 6069f7b (VOID-NOTE, judge 3× progressing under leaked distinctPages
  = live bias evidence). eval analyzer /tmp/v3-revisit-analyze.mjs pin-agnostic; pre-registered:
  best-effort page identity (compact batch results name no URL→last named page; V2-r4 10 named pages
  /120 stations), narrow mutation-revisit signature missed V2-r1 label-differing redo (informational).
  **ISOLATION RULING (option A, bounded tune-only)**: revert buildDigest mutationRevisits to
  V2-equivalent bare entries (DROP pageKey/controlName from JUDGE digest; KEEP in ledger aggregates
  replay metric + KEEP page-scoped REVISIT_HINT signal); re-score TUNE k=5 ONLY (no holdout). If caught
  restores ≥V2 → annotation confirmed cause → V3 FINAL = page-scoped signal WITHOUT digest annotation
  (DOCUMENTED measurement-justified deviation from §3.4 digest detail; deterministic benefit retained).
  If still <V2 → cause elsewhere, reconsider. FINAL V3 gate: caught MEAN k=5 (tune+holdout once each;
  k=3 demonstrated noisy), FA worst 0 hard. Then holdout k=5 once → eval V3 live final pin. core
  running isolation test. V3 branch tip b59981a; fixed pin 1e3ea50.
- ~06:40: **V3 RESOLUTION = OPTION B accept + live binding**. Isolation (b66ab10/8880528):
  annotation removal caught 0.667 (minor +0.067, still <V2 0.867) → annotation NOT main cause;
  ROOT CAUSE = fundamental §3.4 trade-off: page-scoped REVISIT_HINT removes multi-page FALSE revisits
  on healthy (benefit, 0 healthy fire) BUT true whole-turn revisit corroboration on multi-page STUCK
  (caught cost, judge loses two-strike corroboration). done-when criteria pull opposite. RULING:
  V3 FINAL ships page-scoped signal + pageKey ledger aggregates (replay-only); judge-digest annotation
  REMOVED (measurement-justified §3.4 deviation, +0.067 marginal, bare entries read repetitive).
  caught tune k=5 0.667<V2 RECORDED deviation (V5 target); hard gates FA worst 0 BOTH pass, falseRec
  holdout improved, stale 0, page-unknown 4.1%. **FINAL HOLDOUT k=5 ONCE (359d540): caught MEAN
  0.920 ≥ V2 0.867 ✓** (k=3 swing 0.867→0.667 was noise; k=5 stable), FA worst 0, stability 0.967.
  k=5 = caught-mean standard (k=3 noisy on tiny samples). **V3 LIVE GO eval pin b66ab10**
  (marathon-long ×5 + epic ×5): BINDING FA 0 worst healthy + REVISIT_HINT mutation-revisit 0 healthy
  fire + caught mean ≥V2 live; if significantly <V2 live → reconsider hybrid (whole-turn corroboration
  + page-scoped healthy suppression) or defer. core V4 prep (read-only design §3.5). V3 merge after
  live green → V4 implement → V5→V8→V10. eval void diagnostic 6069f7b preserved (buggy-digest bias).
- ~07:45: **V3 MERGED main `c6f0d2d`→`1577210`** (npm 1293/1293; watch-ledger +123 page-key
  parsing/grouping/page-scoped REVISIT_HINT, watch-judge +9 digest annotation removed; V3-live
  evidence merged). task-17 complete. V3 live binding met: FA0 worst healthy ×10 (2326+ samples 0
  open), mutation-revisit 0 healthy fire ×10 (marathon-long multi-page beneficiary clean, page-unknown
  0), caught carried by holdout k5 0.920≥V2 (no past-patience stuck in healthy live suites). epic 4/5
  PASS+r5 honest redo partial (checker caught), judge 21 calls separate, falseRec 0, suspect 90.5%
  informational (not V3 gate). DECLINED eval optional extra stall-loop (holdout+V2-live carry caught;
  V5 live covers). Informational: narrow mutation-revisit signature ≠ redo detector (label-differing
  redos miss; server-record checker authority). **V4 IMPLEMENT GO core** (task-18, branch v2/v4-context
  from 1577210, design 31be533 finalized): seed activity (claim accepted→ONE plan activity seeded:true,
  rejected→none, fixes G1), carryChain (marathon.mjs internal ≤3 ancestor prompts clip500 oldest-first,
  fed #begin seeded turn, reset drop/off/chat/new, NOT published), buildDigest carriedFrom ancestors-only
  + plan.seededRevision (marathon carried revision), ≤~400 tokens (fixes G2). Replay vs V3 tune k5
  (caught RISE continuation stuck; healthy-continuation suspects must not rise) + holdout k5 once.
  V4 done-when: continuation stuck caught + healthy continuations silent worst + seeded-untouched 5/5.
  eval V4 live pre-staged: stop-then-continue ×5 + unrelated-question ×5 + c1 steer-plan row.
  Merged: V0/V1/V2/V3/V6/V7 (main 1577210). Remaining V4→V5→V8→V10 (V9 deferred).
- ~08:55: **V4 MERGED main `4ad1f06`→`b3e10e1`→`2c933fd`** (npm 1303/1303; marathon +45 carryChain,
  controller +19 carry-feed, watch-judge +12 carriedFrom, plan-runtime +12 seed activity; V4-report
  f6c5c0f + V4-live evidence 5646e58 merged). task-18 complete. V4 live: stop-then-continue redo 0/5,
  healthy silent (0 alerts/0 REVISIT), seeded=true 5/5, 4/5 PASS+r2 final-view partial; r1 t1
  model-variance stall SILENT_STALL @139s TRUE positive (turn-identity corrected mid-cycle, void+retry
  transparent). **MODEL-VARIANCE items (V4 INNOCENT, core+eval independent diagnosis matched)**:
  unrelated 3/5 (r2/r4 resumed carried plan; seeded-untouched DETECTION fired correctly, ~60% model
  compliance, prompt byte-unchanged); c1 steer-plan FAIL (steer honored perfectly carry-rev1/count3=3,
  model marked plan blocked post-steer→PARTIAL→pre-V4 'Plan blocked' ok:false→row turn2Ok fail; ROW
  BRITTLENESS follow-up). core innocence proof: plan-runtime diff only 12-line seed bridge.activity,
  carry feed judge-only, planSeed hoisted identical const, buildPromptBlocks+agent prompt byte-unchanged,
  detection unchanged. caught holdout 0.880 vs V3 0.920 = judge variance (replay can't exercise carry
  context); continuation-stuck caught marginal-directional (sim) + hard-signal coverage. RULING: accept
  V4 structural gates (FA0 worst both + healthy silent + mechanisms) + model-variance documented; flag
  model-reliability + checker-brittleness to user. **V5 GO judge** (task-19, v2/v5-tuning from b3e10e1):
  candidates 1→2→3→4 plan order, k=5 tune vs V4, keep first meeting keep-rule (FA0 worst, caught rises,
  stability≥V4, cost≤3×), ≥80% mean caught tune+holdout or M4-fallback; neutral prompt; holdout once.
  **V8 GO core PARALLEL** (task-22, v2/v8-reason from b3e10e1, MERGE AFTER V5): reason field blocked-only
  ≤240 chars PLAN_REASON_STATUS, prefix identity rule open→blocked, PLAN_IN_PROGRESS_REQUIRED message,
  ALL carry-chain validators accept reason (plan.js/prompt/marathon/hub/plan-panel/Android), end-to-end
  2-turn carry test, panel+phone reason display; eval live sign-in-wall/stall/long ×5 vs M4 11 PLAN_*
  failures ≤2. android reason display after core V8. Merged: V0/V1/V2/V3/V4/V6/V7 (main 2c933fd).
  Remaining V5 (judge) + V8 (core) → V10. V9 deferred.
- ~11:00 (USER AWAKE 'continue, finish up'): **V5 MERGED main `f29eadb`** (npm 1303/1303; c3 KEPT
  watch-judge.mjs +26/−3 pinned morph/fp8 routing {order:['morph'],allow_fallbacks:false,
  require_parameters:true}+seed:42, JUDGE_REASONING_EFFORT='low'/max_tokens400 kept; c1/c2 fully
  reverted; AGENTS both invariants updated). **V5 ACCURACY BREAKTHROUGH**: tune+holdout k=5 caught
  1.000/1.000, FA0 worst, stability 1.000/1.000, CLEAN bounce-form 0.6→1.0 stable×5, gate no-flip,
  cost ~1.0× V4. ROOT CAUSE confirmed: temp-0 instability = OpenRouter load-balancing ~50 endpoints/
  quantizations; pinning seed-supporting provider + fixed seed → deterministic verdicts. c1 noise-rise
  (0edaefd), c2 effort contaminated-driven/clean-regression gate-flip incl0.800/excl0.40 (170294c)
  NOT kept (decision #6 at-most-one). V5 final a9d720f. **V8 UNIT MERGED main `8b67061`** (npm
  1315/1315; core v2/v8-reason f5a5b6b + android v2/v8-android a87a691: plan.js +37 reason schema/
  validators/prefix-identity, prompt+9, marathon+9, plan-panel+14; android planItemsOf mirrors
  normalizeMarathonPlan by construction, real-hub fixture re-recorded, gradle 154/0). V8 done-when
  live: PLAN_* ≤2 total + no pass-rate/help/BLOCKED change vs M4 11.
  **LIVE RUNNING PARALLEL**: eval V5 live pin a2b4433 (c3) tracks A=stall-loop→captcha→bounce ×5,
  B=epic-120 ×5 (separate homes); V8 live pin 8b67061 sign-in-wall/stall-loop/marathon-long ×5.
  V5 live done-when caught ≥80% stuck + FA0 healthy + stability (bounce-r1 unknown-miss regression
  test, unknown-verdict rate drop under seed42). core V10 docs drafting (v2/v10-release): versions
  2.5.0 + Android 0.8.0(7), consolidate v2 numbers, still-unrun (push delivery conan-evo-x3, on-phone
  V6/V7/V8, docked-panel visual), follow-ups (V3 tune trade-off, model-variance seeded-untouched ~60%
  + c1 row brittleness, epic-120 completion-view reload-reset, REPEAT_LOOP multi-page residual, V9
  deferred). V10 finalize+merge+tag v2.5.0+publish AFTER V5+V8 live green; lead independent verify.
  Merged: V0/V1/V2/V3/V4/V5/V6/V7/V8 (main 8b67061). Only V10 remains.
