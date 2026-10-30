# Phase 1 measurements (historical)

These are measurements from the original vertical slice, not a controlled benchmark or a description of the current 28-tool prompt. They are useful only as local reference points. Model timings came from the earlier direct Alibaba route with reasoning off; the current OpenRouter/Auto configuration differs. Bridge, capture, executor, and logging overhead is less provider-dependent.

## Environment

- Microsoft Edge 151 / Chromium on Linux, DPR 2, 1018×768 CSS viewport.
- Node 26.8.1; DSH `0.2.1-rc.2` with `sdk-minimal` and `config/browser.patch.yml`.
- Earlier route: `alibaba-token-plan`, `deepseek-v4.1-flash-1017`, reasoning off, `maxTokens:8192`.
- Loopback bridge; side panel opened as an extension page in the same window.

## Recorded results

| Measurement | Result | Source |
|---|---|---|
| Bridge round trip, 200 commands without Chrome/model | p50 **0.05 ms**, p95 **0.10 ms**, p99 **0.46 ms** | `npm run bench` |
| Labelling, 9 controls | **7–21 ms** | `edge-click-e2e.mjs` |
| Labelling, 800 controls capped at 120 labels | **15 ms** | `many.html` |
| Click dispatch + settle + fresh view | **~250–370 ms** without capture-quota delay | `edge-click-e2e.mjs` |
| Labelling with two child frames | **14–21 ms** | `edge-advanced-e2e.mjs` |
| Trusted canvas click + pixel diff + fresh view | **~200–400 ms** | `edge-canvas-e2e.mjs` |
| Snapshot capture / encode / total | **31–35 / 35–58 / 95 ms** | `edge-probe.mjs` |
| Auto-view in the real UI | **58–73 ms** | side-panel footer |
| Screenshot example | 1018×768 CSS at DPR 2 → **1280×966 JPEG, ~96 KB** | live capture |
| First model-step input tokens, including auto-view | **1,934** | DSH session |
| “Describe + scroll 700 px” | **6.4 s**, 1 tool | `edge-e2e.mjs` |
| “List tabs + switch tab” | **10.0 s**, 2 tools | `edge-tabs-e2e.mjs` |
| One-turn debug stream / ZIP | **87 events, 38.9 KiB / 84.4 KiB** | log harnesses |

Turn timings include model prefill/decode, auto-view, tools, and UI rendering. They are not local-overhead measurements and must not be compared directly with later routes, reasoning levels, tool rosters, or scenarios.

## Reproduce local checks

```sh
npm run bench
```

With the fixture server, unpacked extension, and isolated Edge/CDP configured:

```sh
node scripts/edge-probe.mjs
node scripts/edge-e2e.mjs
node scripts/edge-tabs-e2e.mjs
node scripts/log-probe.mjs
node scripts/edge-log-e2e.mjs
```

`scripts/fake-ui.mjs` exercises the companion/provider without Chrome but requires a configured model. Debug runs are under `.dsh-home/browser-agent/logs/<runId>/`.

## Caveats

- One machine, one gateway, one model, and small scenarios.
- `captureVisibleTab` is quota-limited; back-to-back captures can dominate a probe.
- Token accounting in these old runs under-priced screenshots relative to provider billing.
- Synthetic fake-UI timings are not real Chrome capture timings.
- Current full-page/region capture, DOM-first auto views, semantic tools, image dedupe, and Docs operations were not part of this baseline.

For a new comparison, keep model and medium reasoning effort fixed, use the same fresh initial state, and record success, collateral edits, wall time, model steps, calls, failures, retries, wrong targets, recovery edits, and token usage. Prompt-size reductions and exact image dedupe are not themselves latency evidence.
