# V4 design notes — continuation context (§3.5, read-only design)

**Status:** DESIGN ONLY (lead: implement after V3 merge, branch `v2/v4-context`). Two coupled changes: (a) the seed becomes visible to the ledger/model; (b) the judge learns the task via a carry chain. Why after V2/V3: a visible seed makes PLAN_STALLED/REVISIT_HINT fire on continuation turns; V2's progress accounting (control tools excluded) + V3's page-scoping keep those from firing on healthy continuations, so this change is measurable. Watcher report-only; carry chain is internal (never published to clients).

## (a) The seed becomes visible (`packages/dsh-browser-extension/lib/plan-runtime.js`)
- In `claim()`, after the seed is **accepted** (`state = seededState; seeded = true`, ~L186), emit **one** activity immediately:
  `bridge.activity({ kind: 'plan', revision: state.revision, items: state.items.map(i => ({ ...i })), awaitingUser: false, seeded: true })`.
  Same shape as the existing `replace()` activities (L139/157) plus `seeded: true`.
- **Rejected seed** (`seedPlanState(seed) === null` → `plan.seed.rejected`, L183): emit **NO** activity → ledger and model see the same empty plan (fail closed, unchanged).
- Provider chosen over companion-fed snapshot (plan decision): the activity reflects what the provider actually armed.
- **Downstream (already wired, verify):**
  - `noteActivity` routes `chat.activity {kind:'plan'}` to `ledger.noteFrame` (the `#noteActivity` plan branch updates revision/items/open-trajectory) and to `planTurnSnapshot`. The `seeded` flag passes through; the ledger gains the seed snapshot at turn start (fixes G1: live ledger had no plan snapshot until the first `browser_plan` call → open-flat could not fire on continuation wander).
  - **Seeded-but-untouched** turn stores back the same list (M2 carry-over unchanged; `not-assessed` without nudges preserved).
  - **Panel**: a plan update with the same revision is a no-op (already renders the carried plan at turn start).
  - **V6 hub** already ingests plan activities → `remote.plan`; the seeded activity flows through the same path. **Dedupe identical consecutive** (the seeded activity equals the carried plan snapshot → hub dedupes; verify the dedupe key covers revision+items so the seed isn't double-journalized).

## (b) The judge learns the task — carry chain (`companion/marathon.mjs` + `watch-judge.mjs`)
- **Carry-chain storage (marathon.mjs, INTERNAL):** `MarathonState` gains `carryChain: Array<{prompt: string, turnId: string}>` — the prompts of up to the **last 3 turns** in the current carried-plan chain, each clipped to **500 chars**, **oldest first**.
  - **Fed by the controller** at turn start when the turn is seeded (carried plan present): append the new turn's shown prompt; trim to 3 (drop oldest). The controller already knows `shownText` + the marathon carry state.
  - **Reset triggers** (clear `carryChain` to `[]`):
    1. carried plan **dropped** (`marathon.plan` becomes null — e.g. plan completed/cleared),
    2. marathon turned **off** (`set({enabled:false})` / `reset()`),
    3. **chat changes** (`sessionId` differs from the chain's session).
  - **NOT published to clients:** `carryChain` is internal — exclude it from the published `marathon.state` snapshot (the panel/remote `marathon.state` frame must not carry it). Keep a separate internal getter (e.g. `carryChainForDigest()`) the controller passes to the judge context; `snapshot()` (published) omits it.
- **buildDigest (`watch-judge.mjs`):** when the turn was **seeded**, add `carriedFrom: [{prompt}, …]` (oldest first, from the carry chain) + `plan.seededRevision` (the revision of the seeded plan). The digest `task` stays the current turn prompt; `carriedFrom` gives the judge the originating task context (fixes G2: a continuation's prompt is just "continue").
- **Digest size bound:** ≤3 prompts × 500 chars ≈ 1500 chars ≈ **≤~400 tokens** growth. Clip each prompt to 500 (control chars stripped, plain text — untrusted). Bound the array to 3. Add a test asserting the digest growth ≤~400 tokens (char proxy: carriedFrom total ≤1500 chars + overhead).

## Tests (npm test, cheapest first)
- **Seeded activity:** accepted seed → exactly ONE `bridge.activity {kind:'plan', seeded:true, awaitingUser:false, revision, items}`; rejected seed → NO activity (ledger empty plan); activity items match the armed seed.
- **noteActivity routing:** seeded activity updates ledger plan snapshot (revision/items/open-trajectory) at turn start; `seeded` flag preserved.
- **Seeded-untouched:** carry-over stores back the same list; `not-assessed` without nudges (M2 regression).
- **Panel same-revision no-op** (existing; verify).
- **Carry chain:** append on seeded turn start; trim to 3 (oldest dropped); clip 500; reset on plan-drop / marathon-off / chat-change; NOT in published snapshot.
- **buildDigest:** seeded turn → `carriedFrom` (oldest first) + `plan.seededRevision`; non-seeded → no `carriedFrom`; digest growth ≤~400 tokens (≤1500 chars carriedFrom).
- **V6 hub dedupe:** seeded activity identical to carried snapshot → deduped (no double remote.plan).
- **Replay gate (after implement):** V4 vs V3 baseline tune k=5 (caught mean should RISE on continuation stuck windows — open-flat/REVISIT now fire with the seed snapshot; suspect ticks on healthy continuations must not rise — V2 control exclusion + V3 page-scoping hold); holdout once k=5 at milestone end.

## Lead rulings (design approved, finalized for implement go after V3 merge)
1. **Carry-chain feed hook:** at `#begin` when `planMode && marathon.plan` exists (seeded turn). `carryChain` holds **ANCESTOR** prompts (previous turns in the carried-plan chain); `carriedFrom` = chain (oldest first, ≤3, clip 500). The CURRENT turn prompt stays the digest `task`. **After a turn ends with the carried plan persisting, push the current prompt into the chain** (becomes an ancestor for the next turn). Reset chain on carried-plan drop / marathon off / real chat switch / `/new`.
2. **`plan.seededRevision` source:** the **MARATHON carried-plan revision** (`marathon.plan.revision`, companion-owned authoritative), passed to `buildDigest` when the turn was seeded. NOT the ledger's (ledger reflects activities; the seed revision is the marathon carried revision).
3. **`carriedFrom` ANCESTORS-ONLY: CONFIRMED** — `task` = current prompt; `carriedFrom` = up to 3 prior prompts oldest first (fixes G2).
4. **Token-bound char proxy:** clip 500 chars/prompt × ≤3 = ≤1500 chars ≈ ~400 tokens (chars/4 proxy); **test-enforce the char bound + digest growth ≤~400 tokens**. Acceptable proxy.
- **Seed activity:** exactly ONE `bridge.activity {kind:'plan', revision, items, awaitingUser:false, seeded:true}` on accepted `claim()`; rejected seed → NO activity (fail closed). **Verify V6 hub `remote.plan` dedupe key covers revision+items+awaitingUser** (seeded re-emit = no-op). Seeded-untouched stores back same list (M2 not-assessed unchanged).
- **Replay vs V3 tune k=5:** caught should RISE on continuation stuck (G1 seed snapshot enables open-flat); healthy-continuation suspects must NOT rise (V2 control exclusion + V3 page-scoping hold). **V4 done-when:** continuation stuck windows caught + healthy continuations silent worst case + seeded-untouched 5/5. Implement after V3 merge (branch `v2/v4-context` from merged main).
