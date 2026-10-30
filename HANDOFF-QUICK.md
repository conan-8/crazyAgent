# CrazyAgent — quick handoff

Current snapshot: **2026-10-30**. Read `HANDOFF.md` for architecture and invariants; use `e2e/checklist.md` for live acceptance.

## Resume

```sh
cd /home/conan/Documents/GitHub/crazyAgent
curl -s http://127.0.0.1:17871/health   # expect ok:true and tools:true when configured
npm test
npm run system-prompt                 # add -- --json for counts
```

Restart the companion after companion/provider/config changes. After `extension/` changes, reload the unpacked extension and reopen the side panel. Do not assume a recorded PID, connection, or model configuration is still current; check health and Settings.

## Current build

| Item | State |
|---|---|
| Tools | **29 model-facing:** 21 general + 8 guarded Docs tools |
| Last recorded tests | **552/552** and prompt composition; earlier real fixture/model runs are historical evidence |
| Latest live evidence | Both available isolated Docs profiles were signed out; the table acceptance harness refused before document creation |
| Pending acceptance | Authenticated real-extension/model Docs tables, authenticated Pivot, real-model HTML-table selection, and normal authenticated docked-panel Docs |
| Model used for find acceptance | OpenRouter `deepseek/deepseek-v4.1-flash`, fixed medium effort |
| Prompt at last composition | **16,475 chars total / 15,481 guidance**; size only, not a latency claim |
| Parallelism | Maximum 4; only `browser_tabs`, `browser_places`, `browser_read_text`, and `browser_docs_read` overlap |
| Repeat guards | 3 consecutive mutating repeats, 30 observations, 10 unmodified navigation keys; no per-turn call cap |
| Extension | Unpacked `extension/`; reload required after changes |
| Secrets | `.dsh-home/browser-agent/token` and optional `api-key`; never commit or print them |

These are recorded results, not a substitute for rerunning checks after new changes.

## What changed most recently

- `browser_docs_table` creates native tables with optional initial values, reads bounded grids, writes exact cells, formats cell/row/column/table text, and inserts/deletes rows, columns, or tables. Planning and verification use authenticated exports; merged writes/structural edits and unanchored empty tables fail closed.
- `browser_docs_format` now verifies exact ranges inside table-cell paragraphs, including color/highlight and collateral runs.
- `scripts/edge-docs-table-e2e.mjs` covers direct real-extension creation, formatting, structure edits, deletion, independent export, and reload persistence when an isolated Docs profile is signed in. It currently stops with `AUTH_REQUIRED` before mutation.
- `browser_find` searches bounded rendered text, accessible names, and non-password values across frames/open shadow roots. Reveal requires a unique or explicit occurrence, scrolls without editing, invalidates old coordinates, and returns a fresh full view.
- `browser_table` reads editable HTML tables and writes validated semantic cell targets with readback verification. Server persistence still needs independent inspection.
- `browser_docs_replace` and `browser_docs_format` are the only model-facing replacement/formatting tools. Internal `replace_text`, `replace_many`, `format`, `format_many`, and `set_font` names are not separate tools.
- Completed export-verified Docs results may skip the redundant final screenshot. Partial/failed/counter/toolbar-only results retain views; independent final-state inspection remains required.

## Key files

- `packages/dsh-browser-extension/lib/index.js` — tool registration, guidance, routing, provider guards, final evidence.
- `extension/sidepanel/browser.js` — browser executor, views, batches, Docs orchestration.
- `extension/sidepanel/docs-table.js` — table validation, Find/structure planning, public readback, and collateral verification.
- `extension/sidepanel/find.js`, `table.js`, `dialogs.js`, `capture.js` — focused executor helpers.
- `companion/` — loopback bridge, DSH lifecycle, prompt construction, model configuration, logs.
- `config/browser.patch.yml` — DSH composition; generated model overlays are not hand-edited.

## Next work

1. Sign in an isolated Docs profile, reload the unpacked extension, and run `scripts/edge-docs-table-e2e.mjs`. Then run the fresh-document medium-effort sidebar scenario and independently inspect export/persistence.
2. Complete authenticated Pivot and real-model HTML-table selection, then the remaining normal authenticated docked-panel Docs checklist. Record failures, retries, wrong targets, and recovery edits even when repaired.
3. After acceptance gaps, the main capability gaps are merged-cell structural editing, file upload, element drag/drop and sliders, downloads/popups, generic reveal-boundary batches, and reusable task recipes.

## Do not

- Do not claim live acceptance from unit tests, fixture suites, a tool’s success status, or a recovered final document.
- Do not weaken stale-view, ambiguity, wrong-target, or verification guards for speed.
- Do not run model-spending tests against the user’s normal profile.
- Do not use broad `pkill`; stop only test processes you started.
