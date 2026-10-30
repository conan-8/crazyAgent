# CrazyAgent development contract

## Change one observable milestone at a time

Do not treat “make the agent better” or “make Docs faster” as one change. Define the smallest user-visible behavior that can be checked independently, establish a real-run baseline, change one main thing, then rerun the same scenario from the same initial state.

Compare:

- task success, partial completion, and collateral edits;
- wall time, model steps, and tool calls;
- failed calls, retries, and wrong-target actions, even if repaired;
- token usage when relevant.

Keep the model and reasoning effort fixed for comparisons. Current real-agent acceptance uses **medium effort**; do not compare it directly with older off/low runs. A recovered mistake is still reliability evidence.

## Independent checks decide

Logs, screenshots, model reasoning, `turn.ok:true`, `changed:true`, DOM mutations, trusted input, and pixel differences are diagnostic evidence—not proof that the requested outcome occurred. The agent saying “done” is not an oracle.

Inspect the resulting browser or document state independently of the tool result and final answer. If no checker exists, ask the user for a focused visual verdict: correct, partial, wrong, or blocked. Use console probes only for a specific diagnostic question or ground-truth inspection, not as a routine substitute for acceptance.

## Regression gates

Use the cheapest gate that can detect the change, then the next level:

1. `npm test` for contracts, validation, serialization, and state handling.
2. Real-extension fixture suites for executor changes, such as `scripts/edge-click-e2e.mjs`, `scripts/edge-work-e2e.mjs`, `scripts/edge-canvas-e2e.mjs`, and `scripts/edge-advanced-e2e.mjs`. These inspect page state directly but do not evaluate model decisions.
3. A complete real-sidebar scenario for behavior changes, from a known initial state with independent final-state inspection.

Never present unit tests or direct-executor suites as real-model acceptance. Repeat important model-driven scenarios enough to distinguish a lucky run from reliability.

## Current focus: Google Docs and semantic editing

Use Docs as a stress test for transferable primitives: exact text targeting, selection, canvas input, layout, menus, and verification. Prefer stable semantic operations for repeated dependent workflows without weakening the general browser tools.

Preserve stale-view, ambiguity, wrong-target, scoped-recovery, native-dialog, and verification safeguards. If a UI transition invalidates coordinates, avoid coordinate dependence or maintain explicit operation state; do not globally relax guards.

Priorities:

1. Exact deletion/replacement with formatting and neighboring content preserved.
2. Formatting an exact unique or explicitly ordinal range.
3. Compound document creation and formatting from a fresh disposable document.
4. Authenticated semantic-table acceptance, including collateral-cell and persistence checks.

Duplicate text requires an explicit ordinal; an ambiguous request must not silently alter an arbitrary occurrence.

## Current snapshot (2026-10-30)

- **29 model-facing tools:** 21 general browser tools plus 8 guarded Docs tools.
- `browser_docs_table` creates, reads, populates, formats, and structurally edits Google Docs tables by semantic table/row/column addresses, with export verification and collateral checks. Merged-cell writes/structural edits and unanchored empty tables fail closed; merged tables remain readable and support text formatting.
- `browser_docs_format` now plans and verifies exact text ranges inside table-cell paragraphs, including color/highlight and non-target run collateral.
- `browser_table` resolves actual HTML table controls rather than coordinates and verifies writes by DOM readback. DOM readback alone does not prove server persistence.
- Unified `browser_docs_replace` and `browser_docs_format` route to internal executor actions. Legacy replacement/format tool names remain internal only.
- Mutations are exclusive in model order. Only `browser_tabs`, `browser_places`, `browser_read_text`, and `browser_docs_read` are parallel-safe.
- Last recorded verification: **552/552 unit/integration tests** and prompt composition. Earlier real find/auto-view, work/canvas, and other fixture suites are historical evidence, not acceptance of this change.
- **Still unrun:** authenticated real-extension and real-model Docs table acceptance, authenticated Pivot, real-model HTML-table-tool selection, and the normal authenticated docked-panel Docs checklist. Both available isolated Docs profiles were signed out; the acceptance harness refused before document creation.

See `HANDOFF-QUICK.md` for resume state, `HANDOFF.md` for architecture invariants, and `e2e/checklist.md` for acceptance scenarios. Historical turn-by-turn logs belong in `.dsh-home/browser-agent/logs/`, not in this contract.

## Repository safety

- Do not fork DSH core or hand-edit generated `.dsh-home/browser-agent/llm.patch.yml`.
- Do not run live-model acceptance in unit tests; use fake bridges or isolated browser profiles. Keep test credentials and user data isolated.
- Never kill browsers by executable path. Stop only PIDs/PGIDs you started, scoped to the test profile.
- Reload the unpacked extension and reopen its panel after `extension/` changes. Restart the companion after companion, provider, or config changes.
- When changing behavior documented here or in another project doc, update that doc in the same change.
