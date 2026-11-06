# Side-panel UI reference frames

Screenshots of the CrazyAgent side panel captured from the mocked-bridge preview
harness (`scripts/ui-preview.mjs`). The dark activity frame was refreshed for
v2.0.0 Beta on 2026-11-06; the other activity frames date from 2026-10-22, the
disclaimer frame from 2026-11-04, and the slash-command frame from 2026-11-04
(refreshed 2026-11-05 to include the composer Pause/Resume control). No companion,
extension permissions, or model tokens are involved: the harness opens the real
`extension/sidepanel/index.html` page in an isolated Edge instance, replaces the
bridge WebSocket with an in-page mock, and plays scripted frames through the real
UI code.

The side panel is a **single full-height activity feed**: there is no separate
chat pane. Finished steps collapse to one line, the running step stays expanded,
and the turn's final answer is shown as a highlighted block. The new-chat view
shows up to three recent sessions; opening it during a turn keeps that session
running behind the view and marks its row with a yellow spinner. An open chat
has a round back button that returns to this new-chat view.

After the extension is installed or reloaded, the first panel use shows a
**one-time full-screen notice** (`<dialog>`). Its highlight is a raised, warm
amber callout: **Don't touch the browser** while the agent is running, because
clicking, typing, scrolling, or switching tabs can throw off the agent's clicks
and targets and break the task. The quieter supporting copy notes that the agent
can click, type, and scroll in your tabs, that some actions may look unexpected,
and that a turn can be stopped at any time. The notice is dismissed with **Got
it** or Escape, clears its stored `crazyagent.disclaimerPending` flag when shown,
and does not appear again until the next install/reload — ordinary panel opens
stay quiet.

The composer supports slash commands. A single leading slash token (`/`, `/n`,
`/new`, `/MODEL`) opens an inline palette listing `/new` (start a new chat) and
`/model` (open the model picker); ArrowUp/ArrowDown move the selection with
wrapping, Enter or Tab runs it, and Escape dismisses the palette without
rewriting the draft. Clicking a row runs it too. Only an exact `/new` or `/model`
executes on send — other slash-leading text such as `/usr/local/bin`, `/new chat`,
or a command with trailing whitespace is sent to the model as ordinary prose.
The palette is keyboard-navigable and keeps focus in the textarea.

The composer also has a **Pause/Resume** control next to dictation. Paused
browser commands are rejected with `PAUSED` without ending the chat turn; the
state persists with the other panel settings and is reflected in the activity
header and status. Closing the model picker with Escape, an outside click, or by
choosing a model returns focus to the composer rather than dropping it to the
page body.

| Frame | State |
|---|---|
| `sidebar-activity-dark.jpeg` | Finished v2 turn: user request, compact action summary, formatted final answer, and the current DeepSeek V4.1 Flash composer |
| `sidebar-activity-light.jpeg` | Same turn in light mode |
| `sidebar-live-dark.jpeg` | Mid-turn: finished step collapsed, running step expanded with live clock, `step 2 · 2.7s` header pill, live footer step |
| `sidebar-step-expanded.jpeg` | A finished step expanded by clicking its header |
| `sidebar-narrow.jpeg` | 320 px side panel |
| `sidebar-empty-dark.jpeg` | Legacy idle frame captured 2026-10-22, when the home view still had a hero and prompt chips; the current home shows up to three recent sessions (or a blank field) above the composer |
| `disclaimer-full-screen.jpeg` | One-time full-screen notice after an extension install/reload, led by the amber "Don't touch the browser while the agent is running" warning |
| `sidebar-slash-commands.jpeg` | Slash-command palette above the composer: `/new` and `/model`, the first row selected, with the ↑↓/Enter/Esc hint line |

## Regenerate

```sh
# one scenario at a time; SHOT_FORMAT=jpeg matches the files here
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario turn  --out /tmp/ui
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario live  --out /tmp/ui
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario empty --out /tmp/ui
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario states --out /tmp/ui
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario disclaimer --out /tmp/ui
SHOT_FORMAT=jpeg node scripts/ui-preview.mjs --scenario slash --out /tmp/ui
# copy the interesting frames into docs/ui with the names above
```

The `disclaimer` scenario also asserts that the hands-off warning carries the
hands-off wording, comes first in the DOM and on screen, and visually dominates
the supporting copy (larger, heavier, warmer type on a bordered fill), plus
full-panel coverage, flag consumption, Escape dismissal, and no repeat after a
panel reopen.

The `slash` scenario asserts the palette trigger rules, filtering, ARIA
(`aria-expanded`, `aria-activedescendant`, `role=option`/`aria-selected`, and the
listbox role on the rows container), ArrowUp/ArrowDown wrapping, Shift+Enter
inserting a newline instead of running the highlight, Tab/Enter/click execution,
Escape dismissal without rewriting the draft or leaving `aria-activedescendant`
behind, outside-click dismissal, Send-button agreement, busy `/model` refusal,
prose fallback, palette fit at the 280 px minimum panel width, and that `/new`
during a turn keeps the session alive in the draft view instead of retiring it
early. It also asserts that Escape, outside clicks, and row selection return
focus to the composer; that images pasted while the `/new` draft view waits
survive the draft retirement; that Pause persists its setting, updates the
status/phase, and rejects a `browser.command` with `PAUSED` until resumed; and
that a dropped mock bridge finishes the live turn, clears the draft view, and
reconnects without a stranded clock or a false "Wait for the running session"
state. Several steps use trusted CDP key and mouse events (not synthetic DOM
dispatch), so the `preventDefault` newline/focus guards are genuinely covered,
and `Accessibility.getPartialAXTree` confirms the textarea exposes the combobox
role with `expanded` true while the palette is open and false after Escape.

The harness needs Node >= 22 (global `WebSocket`), `microsoft-edge` on `PATH`
(override with `EDGE_BIN`), and an unused CDP port. It picks a per-process port
by default (`10000 + pid % 20000`); set `CDP_PORT` to force one.
