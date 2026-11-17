# V8 report — less plan friction when blocked (reason field + prefix identity)

**Date:** 2026-11-17 · **Task:** task-22 (core) · **Plan:** `MARATHON-V2-PLAN.md` §3.9 + §5 V8 + §6 + G7
**Branch:** `v2/v8-reason` from merged main `b3e10e1` (V4 merged). **One main change: plan friction.** **MERGE AFTER V5** (so V5 live scoring sees one main change). Model-facing tool change → real-model gate LATER.
**Status:** code + tests READY (npm 1315/1315, c1 self-test passed). Android reducer slice coordinated (android). Awaiting V5 merge → V8 merge → eval V8 live.

## What changed
- **SCHEMA (`plan.js`):** items gain an optional `reason` (single line, ≤240 chars) allowed **ONLY on `blocked` items**; any other status → `PLAN_REASON_STATUS`. `normalizeItems` accepts + keeps reason; `cloneItems`/`sameItems` factor reason (adding a reason is a real change, not `PLAN_UNCHANGED`). Item schema gains the `reason` property. Tool description: "For blocked items, put why in `reason` and keep `content` unchanged."
- **IDENTITY RULE (`plan.js`):** an open item moving to `blocked` may also change its content **without** `acknowledge_open_removal` if the new content **STARTS WITH** the old content (covers the observed " — blocked: …" suffix). Anything else is still a rewrite requiring ack (`removedOpenItems` prefix-block exception).
- **`PLAN_IN_PROGRESS_REQUIRED` stays;** message gains: "If the remaining items cannot proceed because of a blocked item, mark them blocked too, or ask the user with `user_input_needed: true`."
- **EVERY carry-chain validator accepts + keeps reason** (fixes the silent empty-plan rejection — today `normalizeItems` refused unknown keys, so a carried seed with reason would be rejected and the turn would silently start empty):
  - `plan.js` `normalizeItems` + `seedPlanState` (via `cloneItems`);
  - `prompt.mjs` `normalizePlanSeed` (blocked-only, single line ≤240, fail closed);
  - `marathon.mjs` `normalizeMarathonPlan` (the hub `remote-hub.mjs` uses this → covered);
  - `plan-panel.js` `normalizeItems` + `sameItems` + render reason under blocked item + `style.css` `.plan-panel-item-reason` (grid-column 2, muted italic);
  - **Android reducer = android slice** (coordinated: accept+keep reason on blocked items, display under blocked item, update RemoteHub frame fixtures; npm test fails on reducer/frame mismatch).
- `formatCarriedPlan` lists only open items (unchanged) — blocked items (with reason) are not listed in the carried prompt; the reason is preserved in the seed for the plan state + panel/phone display.

## Commits
- `d21b877` V8 core (schema + validators + identity rule + message + panel/CSS).
- `6f3ad48` V8 tests (+12).

## Gates (cheapest first)
- **npm test: 1315/1315 green** (1303 V4 base + 12 V8): reason validation (accepted-on-blocked/kept, `PLAN_REASON_STATUS` on other statuses, single-line + 240 cap), prefix identity (open→blocked prefix content change without ack, `removedOpenItems` 0; non-prefix still `PLAN_OPEN_REMOVAL_REQUIRES_ACK`), new `PLAN_IN_PROGRESS_REQUIRED` sentence, adding-reason-is-real-change, **end-to-end blocked-item reason survives `seedPlanState` into turn 2 + continuation**, `normalizeMarathonPlan`/`normalizePlanSeed` keep reason (reject non-blocked/over-long), panel reason kept + rendered under blocked item (non-blocked dropped), prompt composition accepts carried seed.
- **c1-acceptance --self-test: passed** (every checker accepts good evidence, rejects every mutation).
- **Prompt ceiling 17,100 untouched; 34 standing tools** (npm green).

## Real-model gate (LATER — after V5 merge + V8 merge)
Model-facing tool change → eval live **sign-in-wall ×5 + stall-loop ×5 + marathon-long ×5** vs M4 live (11 `PLAN_*` failures, same pass rates). **Done-when: `PLAN_*` failures ≤2 total, no change in independent pass rates or help/BLOCKED ends.** The reason field + prefix rule should reduce the `PLAN_OPEN_REMOVAL_REQUIRES_ACK`/`PLAN_REWRITE_REASON_REQUIRED` friction observed when the model marks items blocked with a " — blocked: …" suffix. Lead sends the V8 live pin after merge.

## Invariants preserved
Fail closed (reason on non-blocked refused; over-long/multiline refused; carry-chain validators fail closed); one runner/one turn slot; plan revision identity (prefix rule only relaxes open→blocked content suffix, still requires ack for genuine rewrites); `PLAN_IN_PROGRESS_REQUIRED` keeps exactly-one-in_progress; prompt ceiling; 34 standing tools; watcher report-only (unchanged); Android reducer matches real RemoteHub frames.
