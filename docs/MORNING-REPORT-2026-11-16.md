# Morning report — 2026-11-16 overnight session

Good morning. You asked me to finish everything in `plan-temporary.md` while you slept, commit in chunks, use subagents, and keep going on beneficial work. **Done.** The queue (Q1–Q10) and Tracks C/D are complete as far as an agent can go; `plan-temporary.md` is archived verbatim into `RELEASE-NOTES.md` and deleted, its permanent acceptance items migrated to `e2e/checklist.md` §5 and its results to `docs/STATUS.md` + `e2e/baselines/`. Everything is committed in verified chunks and pushed; CI is green; `npm test` **1055/1055**, Android **97 JVM / 0 fail / lint clean**.

I led a team of five teammates (docs-fixer, provider-fixer, harness-builder, clients-fixer, d1-splitter) with disjoint file scopes and a shared task board; I reviewed every commit, ran the gates, and pushed. ~28M tokens of real-model measurement, each batch under a 6M hard cap, model/effort fixed (`deepseek/deepseek-v4.1-flash` @ medium).

## ⚠️ Do this first — activation order matters

`confirmIrreversible` is **ON**. The new companion stamps `confirm_guard` on click/type/batch commands; your **old** unpacked extension doesn't strip it and would reject it, **breaking clicks**. So:

1. **Reload the unpacked extension** in your Edge and reopen the panel (I can't — no debug port).
2. **Then** `systemctl --user restart crazyagent.service` (or do both together).

I deliberately left the service on the previous code overnight to keep a consistent companion+extension pair (`/health` is `ok/ui/tools:true`). Do **not** restart the companion alone first.

## The crown deliverable — C2 Docs acceptance (never had it before)

`scripts/edge-docs-table-e2e.mjs` passed **end to end twice**, signed-in headless, **EXIT 0, 13 executor calls / 0 failed** each, all eleven steps export-verified, **reload persistence verified** (values + bold + highlight + native backgrounds, no collateral). Getting there exposed and fixed **seven pre-existing bugs** at newly-reached steps, each with a positive-signal wait + fail-closed timeout + export backstop + mutation-checked test: selection proof before multi-edit formatting, below-fold menu scroll, palette settle, structure-flow selection proof, write Delete-before-insert, find-counter settle, merge cell-collapse. Learned Docs facts (now in STATUS): `insertText` doesn't replace the selection; the find bar retains its query and the counter lags; Shift+Arrow traverses characters not cells; the colour picker parses hex on key events. Baselines: `…c2-docs-table-pass{1,2}…`.

## Reliability core

- **Q3 — the root-cause find:** internal steer notices sent as `runtime-context` **never reached the model** (the DSH loop swaps them for its context snapshot) — prior "recoveries" were blind re-sampling. Fixed with visible `agent-notice` kinds + no mid-turn guard resets; max-token continuation now steers in-turn (keeps conditional tools). Gates ×10 **30/30**, 3/3 leak-retries recovered, notice text independently verified in the model's request. Backstop **kept** (zero false positives, zero bypasses).
- **Q2 — `text_landed` for clicks:** page-scoped absent-to-present (unknown on navigation, no re-mutation), mirrors byte-identical, plus a lead-approved **scoped** batch-sequence relaxation (Docs scopes stay strict). text_landed failures **6/30 → 4/10 → 0/10**.
- **Q4 — dead-turn metrics + rate:** form-submit ×30 **30/30, 0 dead turns**.
- **task-16 — phone Continue gap:** in-process resume failed (SDK "already owned"); fixed via direct-first resume + teardown-on-owned. C1 resume now **PASS both paths**.
- **D2 — prompt diet:** non-Docs **18,076 → 12,402 chars (−31%)**, ~5.7K ceiling headroom; conditional `<docs_mode>` + once-per-turn rules-in-result fail-safe. Full-set 50/5/0 + gates 15/15 accepted as variance with isolation proof.

## Measurement foundation + structure

- **Q5:** one-command gate runner `scripts/run-e2e-gates.mjs` — **12 headless suites green / 7 excluded**. Found **Edge 157 silently broke CDP download isolation** (files leaked to `~/Downloads`); fixed in both harnesses. The find "flake" was root-caused as deterministic headless window-size dependence (fixed test-only).
- **Q6/C1:** real-runtime acceptance **5/5** (plan, resume both paths, steer, 20 Stop/New cycles + 4 token rotations, minimized-window views with model-independent signature pixels).
- **D1:** pure-move splits — `index.js` 5060→4409 (`guidance/validate/repeat-guards.js`), `browser.js` 11522→11105 (`views/labels/docs-ops.js`); every block machine-checked byte-identical, gates unchanged. The entangled registries/orchestration are honestly recorded as future accessor/shared-module work, not forced.
- **D3/D4:** STATUS cut to a snapshot (history archived losslessly); log dedup **8.42× fewer lines** (metrics byte-identical) + prune freed **1.30 GiB**.
- **Clients:** panel live-stream DSML guard (split tags caught, history stripped), `deadturn` rendering on panel + phone (additive reducer fixture, existing five byte-identical), and the Android timing-flake hardening that **turned the hosted CI Android job green**.
- **C5:** Tailscale least-privilege review done (`docs/TAILSCALE-REVIEW-2026-11-16.md`) — local exposure matches the design; the admin-console ACL grant needs you.

## Still waiting on you (recorded in STATUS "Still unrun" + checklist §5)

- Extension reload + service restart (paired, ordered — above), then live docked-panel + physical-phone visual acceptance (phone wasn't connected overnight).
- Model-driven Docs `e2e/checklist.md` §3 A–D and the **live Docs-TURN model path** (incl. under the D2 diet) through your docked panel; authenticated Docs export/toolbar expectations, Pivot, HTML-table selection.
- Real-sidebar drag/expectation/download→upload/`/plan` workflows (the isolated harness passes; docked-panel variants remain).
- Push delivery via `conan-evo-x3` (copy the FCM key there, restart its companion, register, then delivery checks). Do not re-pair the phone here.
- Release-APK install (uninstall debug + re-pair), a deliberate reboot test, and the Tailscale admin-console ACL grant (device tags + phone-only tcp:443).

## Follow-up candidates (recorded, not blocking)

Duplicate-text no-find-reveal reporting class (dominant partial); the non-markup fragment residual (~1/30, no heuristic on one sample); a scoped `runInFrame` null-vs-undefined audit; the D1 structural remainder. Details in `docs/STATUS.md`.

## Notes

- The isolated Docs test profile's `extensions.ui.developer_mode` was persisted true (Edge resets it off on restart, disabling the unpacked extension); backup at `/tmp/docs-prefs-backup.json`. Test profile only.
- All run documents were trashed (toast-verified); no stray test processes; the running service and your normal Edge profile were never touched; secrets never printed.
- Full detail: `docs/STATUS.md`, `e2e/checklist.md` §5, `e2e/baselines/`, and the archived plan in `RELEASE-NOTES.md`.

— lead