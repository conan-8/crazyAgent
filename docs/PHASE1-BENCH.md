# Phase 1 measurements

These are the numbers from the working vertical slice, not a controlled benchmark. They are useful for detecting regressions, not for comparing providers. **The model latencies were measured on the earlier direct Alibaba route; this build now routes through OpenRouter, so model-dependent turn times will differ by model. The capture, bridge, tool, and logging metrics are provider-independent.**

## Environment

- Microsoft Edge 151.0.4129.107 (Chromium), Linux, DPR 2, 1018×768 CSS viewport
- Node 26.8.1
- DSH `0.2.1-rc.2`, `sdk-minimal` + `config/browser.patch.yml`
- Earlier measurement route: provider `alibaba-token-plan`, model `deepseek-v4.1-flash-1017` (now selectable through OpenRouter)
- Earlier measurements used reasoning effort `off`; the current OpenRouter default is `low` for reasoning-capable models, so reasoning/thinking tokens and turn times will differ
- Earlier reasoning effort `off` (current build defaults to `low`), `maxTokens: 8192`
- Local bridge on `127.0.0.1`, side panel as an extension page in the same window

## Results

| Measurement | Result | Source |
|---|---|---|
| Local bridge round-trip (200 commands, no Chrome/model) | p50 **0.05 ms**, p95 **0.10 ms**, p99 **0.46 ms** | `npm run bench` |
| Interactive labelling, 9 controls | **7–21 ms** | `scripts/edge-click-e2e.mjs` |
| Interactive labelling, 800 controls (capped at 120 labels) | **15 ms** | `e2e/fixtures/many.html` |
| Click dispatch + settle + fresh labelled view | **~250–370 ms** without a capture-quota hit | `scripts/edge-click-e2e.mjs` |
| Labelling with two child frames | **14–21 ms** | `scripts/edge-advanced-e2e.mjs` |
| Trusted canvas click + pixel diff + fresh view | **~200–400 ms** | `scripts/edge-canvas-e2e.mjs` |
| Snapshot: capture | **31–35 ms** | `edge-probe.mjs` |
| Snapshot: decode/downscale/JPEG encode | **35–58 ms** | `edge-probe.mjs` |
| Snapshot: total executor time | **95 ms** | `edge-probe.mjs` |
| Auto-view observed in the real UI | **58–73 ms** | side-panel footer |
| Live screenshot | 1018×768 CSS at DPR 2 → **1280×966 JPEG, ~96 KB** | `/tmp/crazyagent-live-shot.jpg` |
| First model step input tokens (auto-view + prefix) | **1,934** | DSH session `session-d52f...` |
| Later step input tokens (with 1,024 cache read) | **1,055** | same session |
| Tabs-turn step input tokens | **2,096** | same session |
| Per-turn user prompt text (view + question), fake check | **351 bytes** | `fake-ui.mjs` |
| “Describe + scroll 700 px” turn | **6.4 s**, 1 tool, 2 thumbnails | `edge-e2e.mjs` |
| “List tabs + switch tab” turn | **10.0 s**, 2 tools, 2 thumbnails | `edge-tabs-e2e.mjs` |
| Debug event stream, one real turn | **87 events, 38.9 KiB** (with 1 screenshot) | Debug log dialog / `events.jsonl` |
| Debug ZIP bundle, one real turn | **84.4 KiB** (summary, events, DSH session, 1 screenshot) | `edge-log-e2e.mjs` |

The two turn timings include model prefill/decode, the auto-view, one or two browser tools, and UI rendering. They are not local-overhead measurements.

## What the model saw

Auto-view prompt text (fake test, image omitted):

```text
<current_view>
tab 1 "Fake Test Page" https://example.test/page
viewport 1280x720 css; image 600x400 px; css/imagePx 2.133
scroll document y=0/2400; at_top=true at_bottom=false
</current_view>

[user message]
```

Scroll tool result text (after the plugin/bridge fix in this build):

```text
tab 1 "Fake Test Page" https://example.test/page
viewport 1280x720 css; image 600x400 px; css/imagePx 2.133
scroll document y=612/2400; at_top=false at_bottom=false
moved dx=0 dy=612
```

The image rides next to that text as a DSH image block. The model's answers correctly identified `ALPHA-MARKER`, `BETA-MARKER`, and `SECOND-MARKER` from the live screenshots.

## Why this is fast enough for Phase 1

- The fixed prefix is four short tool schemas plus a short persona and guidance section; there is no file/shell/web/skill/subagent tooling and no runtime date/cwd context.
- Auto-view removes one model round trip from the common “look at this page” request.
- Scroll and tab switch return a fresh screenshot in the same tool call, so observing after an action costs no extra turn.
- The bridge is in-process local WebSocket; its measured overhead is negligible relative to capture and model time.
- Screenshots are limited to the viewport and downscaled to 1280 px (2048 px only on demand), keeping image tokens and upload size bounded.
- Reasoning is off by default. The prior custom harness reported ~9.7k fixed prefix tokens and ~11 s median LLM round trips; this Phase 1 measures ~1.9k first-step input tokens including the image, and 6–10 s turns for the small acceptance tasks. The tasks differ, so this is a directional comparison, not a like-for-like benchmark.

## Caveats

- One machine, one gateway, one model. Provider latency and image tokenization vary.
- The 6.4 s/10.0 s turns include network/model time; rerun on your machine before drawing conclusions.
- `captureVisibleTab` is throttled to 2/s. Back-to-back probes can wait up to ~550 ms; real turns usually have model thinking time between captures. The `scroll` probe's 661 ms total in one run was mostly this throttle, not encode time.
- The first model step's input token count includes the auto-view image. The fixed text prefix is much smaller than the total.
- The 2 ms auto-capture time in the fake-UI test is synthetic; the real auto-view was 58–73 ms.

## Reproducing

```sh
npm run bench
```

With Edge running with the extension and CDP on port 9223:

```sh
node scripts/edge-probe.mjs       # snapshot/scroll/tabs executor
node scripts/edge-e2e.mjs         # real UI: describe + scroll
node scripts/edge-tabs-e2e.mjs    # real UI: tabs + switch
```

The fake-UI check (no Chrome) requires a configured OpenRouter key/model:

```sh
node scripts/fake-ui.mjs
```

Debug logs are in `.dsh-home/browser-agent/logs/<runId>/`; the side panel's **Debug log** button exports a ZIP. DSH session logs are in `.dsh-home/sessions/` and screenshot attachments in `.dsh-home/attachments/`.

Export checks:

```sh
node scripts/log-probe.mjs          # stats + summary + ZIP from the running companion
node scripts/edge-log-e2e.mjs       # real Debug log modal and download (CDP required)
```

Logging is local and asynchronous; it does not add a model round trip. A one-turn log was 38.9 KiB of JSONL and 84.4 KiB as a ZIP including one screenshot and the raw DSH session; secrets and inline base64 are redacted.

## Next measurements

- reasoning `off` vs `high` on the same five pages;
- long sessions: cache hit rate and image-offload behaviour;
- nested-scroller and infinite-scroll pages;
- capture latency on a 4K/DPR 2 display;
- the effect of `requestImagePixelBudget` / JPEG quality on model accuracy.