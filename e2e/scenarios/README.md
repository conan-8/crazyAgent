# Real-model evaluation scenarios (plan-temporary.md Track A / A1)

`scripts/model-eval.mjs` runs these scenarios N times with a real model against
an isolated browser, an isolated companion, and an isolated DSH home, then
decides pass/partial/fail from independent evidence.

```sh
node scripts/model-eval.mjs --list
node scripts/model-eval.mjs --self-test              # no model, no companion
CRAZYAGENT_API_KEY=... node scripts/model-eval.mjs --scenario click-once --repeat 5
CRAZYAGENT_API_KEY=... node scripts/model-eval.mjs --scenario all --repeat 5 --label baseline-YYYY-MM-DD
```

`--self-test` starts the fixture server and an isolated headless Edge, then
runs every `check()` against the untouched fixture and against an optional
`tamper()` state. Both must be non-pass; this mutation-checks the checker
without spending model tokens or touching the agent. A scenario may also
export `solve()`, a harness-made correct end state that must pass, so a checker
cannot look safe merely by rejecting everything.

## What the harness owns

- A fixture server on a free loopback port serving `e2e/fixtures/`; it records
  every request (method, path, origin, body) so a checker can read ground truth
  the agent cannot forge. It answers on `127.0.0.1` and on `localhost` (also
  `::1`), so a fixture on one can embed a frame from the other; that frame is
  cross-site and Edge isolates it into its own OOPIF target.
- A per-batch Downloads folder in the run's temp directory. Edge downloads go
  there (`Browser.setDownloadBehavior`) and the companion's file tools are
  confined to it (`CRAZYAGENT_DOWNLOADS_DIR`); it is emptied before every run.
  The user's `~/Downloads` is never used.
- An isolated DSH home (default `<tmp>/crazyagent-model-eval/dsh-home`) built
  by `scripts/setup.mjs`, plus a second companion process on free ports with
  `--remote`. The key comes only from `CRAZYAGENT_API_KEY`; the harness never
  reads `.dsh-home/browser-agent/api-key` and never prints a key.
- A fresh headless Edge profile with the unpacked extension. The extension's
  background executor is pointed at the isolated companion by writing
  `crazyagent.settings`, exactly as `scripts/edge-background-e2e.mjs` does.
- Prompts go through the authenticated remote API (`POST /messages`, `GET
  /state` polling, `POST /stop` on timeout). Each repeat gets a fresh chat
  (`POST /new`), a fresh page load, and a cleared fixture request log.
- Per-run metrics are read from the companion's own `events.jsonl`: wall time,
  model steps (`step/start`), tool calls and per-tool counts, failed calls and
  their codes (joined `tool.call`/`tool.result`, plus `bridge.command.error`),
  token usage, final status, and the model's final text.
- Batch JSON is written after every run (also on failure) under
  `e2e/baselines/` unless `--json <path>` is given.

It never touches the running service companion (ports 17871/17873), the user's
normal Edge profile, or the user's real `.dsh-home`.

## Scenario module contract

```js
export const name = 'click-once'       // --scenario id
export const fixture = 'click.html'    // loaded before every repeat
export const prompt = '…'              // exact user-style prompt (no tool hints)
export const maxTurnSeconds = 90       // optional per-run cap
export async function setup(ctx) {}    // optional page reset
export async function check(ctx) {     // required, read-only
  return { status: 'pass' | 'partial' | 'fail', reasons: [...], evidence: {...} }
}
export async function tamper(ctx) {}   // optional plausible-but-wrong state for --self-test
export async function solve(ctx) {}    // optional correct end state for --self-test
```

`ctx` exposes `fixtureUrl(path)`, `crossOriginUrl(path)`, `currentUrl()`,
`evaluate(expression)`, `evaluateFrame(urlPart, expression)` (runs in an OOPIF
frame target over the harness's own CDP connection), `navigateFixture(path)`,
`requests()`, `resetRequests()`, `downloadsDir`, `downloads()` (name, size,
bytes of each saved file), `cdp(method, params)` (raw page CDP for
`solve()`/`tamper()` hooks only, never `check()`), and `turn`
(`status`, `waitingForUser`, `wallMs`, `steps`, `toolCalls`, `failedCalls`,
`failed`, `toolCounts`, `inputTokens`, `outputTokens`, `finalText`).

`check()` must use independent ground truth: the fixture DOM read over the
harness's own CDP connection, or the fixture server's request log. It never
sees tool results and must not trust `turn.ok` or the model's answer as proof.
A checker that can pass on the untouched page is rejected by `--self-test`.

## Current scenarios (all 11 plan seeds)

| Scenario | Fixture | Passes only if |
|---|---|---|
| `click-once` | click.html | Increment count is exactly 1; other counters untouched |
| `form-submit` | form.html | submitted exactly once with the requested field values; unrelated fields untouched |
| `table-cells` | table.html | both named cells hold the requested committed value; no other cell/header changed |
| `find-reveal` | find.html | unique marker fully in the viewport; no field/selection/counter change |
| `duplicate-text` | find.html | page fully untouched **and** ambiguity reported; picking an arbitrary occurrence is partial |
| `sign-in-wall` | signin.html | turn ends waiting for the user, no sign-in POST/attempt, gate unchanged |
| `drag-reorder` | drag.html | pointer order becomes Beta, Gamma, Alpha; other slider/selection state untouched |
| `slider-value` | drag.html | native range value and rendered output both 75; custom slider/order untouched |
| `canvas-click` | canvas.html | exactly one trusted canvas pointerdown (synthetic input does not count) |
| `download-upload` | files.html | a Downloads file, the Visible input, and exactly one multipart upload all hold the payload bytes; other inputs empty |
| `frame-canvas-slider` | frame-canvas.html | inside the cross-site frame, the canvas Length slider is 70 by trusted drag; Mass untouched |

`frame-canvas-slider` is the plan's B1 surface: the slider is drawn on a
canvas in a `localhost` frame under a `127.0.0.1` page, and only a trusted
press-and-drag on its thumb moves it (pressing the track does nothing). Its
`solve()` drives a top-level CDP mouse drag, which proves raw trusted input
does reach the inner canvas; whether the agent's own `browser_drag` does is
what the model runs measure.

## Reading a batch

`status` in the batch JSON is the independent checker's verdict. The `turn`
object next to it is telemetry from the companion log: a `done` turn is not a
pass, and a pass with failed calls still means the model recovered from a real
failure. Keep model and reasoning effort fixed when comparing batches; the
harness records both. Baseline wall times are from this host and are not a
latency claim.