# Side-panel UI reference frames

Screenshots of the CrazyAgent side panel captured from the mocked-bridge preview
harness (`scripts/ui-preview.mjs`) on 2026-10-22. No companion, extension
permissions, or model tokens are involved: the harness opens the real
`extension/sidepanel/index.html` page in an isolated Edge instance, replaces the
bridge WebSocket with an in-page mock, and plays scripted frames through the
real UI code.

The side panel is a **single full-height activity feed**: there is no separate
chat pane. Finished steps collapse to one line, the running step stays expanded,
and the turn's final answer is shown as a highlighted block.

| Frame | State |
|---|---|
| `sidebar-activity-dark.jpeg` | Finished turn: collapsed step headers with model time + step total, pinned answer, per-step footer |
| `sidebar-activity-light.jpeg` | Same turn in light mode |
| `sidebar-live-dark.jpeg` | Mid-turn: finished step collapsed, running step expanded with live clock, `step 2 · 2.7s` header pill, live footer step |
| `sidebar-step-expanded.jpeg` | A finished step expanded by clicking its header |
| `sidebar-narrow.jpeg` | 320 px side panel |
| `sidebar-empty-dark.jpeg` | Idle state: full-height empty hero with prompt chips |

## Regenerate

```sh
# one scenario at a time; SHOT_FORMAT=jpeg matches the files here
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario turn  --out /tmp/ui
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario live  --out /tmp/ui
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario empty --out /tmp/ui
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario states --out /tmp/ui
# copy the interesting frames into docs/ui with the names above
```

The harness needs Node >= 22 (global `WebSocket`), `microsoft-edge` on `PATH`
(override with `EDGE_BIN`), and an unused CDP port (default 9240, override with
`CDP_PORT`).
