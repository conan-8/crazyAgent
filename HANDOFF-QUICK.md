# CrazyAgent — quick handoff

**2026-10-22 evening.** Working, committed, tested. Long-form history: `HANDOFF.md`
(§4 invariants, §15 session log). This file is the 2-minute version.

## 60-second resume

```sh
cd /home/conan/Documents/GitHub/crazyAgent
curl -s http://127.0.0.1:17871/health   # expect {"ok":true,"tools":true,...}
npm test                                 # expect 149/149
npm run system-prompt                    # exact current prompt (9,992 chars)
```

Then read `HANDOFF.md` §4 (invariants) before changing anything. The companion is
already running; the extension is loaded unpacked and needs a reload only if
`extension/` changed since the last reload (the clipboard pass added
`clipboardRead`/`clipboardWrite` — reload once for that).

## Current build

| Item | Value |
|---|---|
| Commit | `de4271d` (tree clean) |
| Tests | **149/149** (companion 42, extension 32, provider 75) |
| Tools | **16** (15 + `browser_clipboard`) |
| Companion | running, PID in `logs/companion.pid`, health `tools:true` |
| Extension | unpacked `extension/`, ID `kmipadgipilkdidennbhcgmoolfedgph`; reload after extension changes |
| Model | OpenRouter `deepseek/deepseek-v4.1-flash-1017`, reasoning `auto` |
| Prompt | persona (`config/browser.patch.yml`) + provider `GUIDANCE`; 9,992 chars ≈ 2.5K tokens |
| Compaction | `thresholdRatio 0.55`, `headroomTokens 131072`, `retainTokens 20000`, `maxTokens 8192` → fires ~577K |
| Limits | 80 tool calls/turn, 3 repeated calls max, 8 s side-panel reconnect grace, image keep 2 + mid-turn batch at +8 |
| Latest run | `.dsh-home/browser-agent/logs/run-2026-10-22T15-21-12-940Z-4fcc93` |
| Token / key | `.dsh-home/browser-agent/token`, `.dsh-home/browser-agent/api-key` (0600; never commit) |
| Ports | bridge 17871, fixtures 17872, Edge e2e 9228 click / 9230 canvas / 9231 advanced / 9233 work |

## What shipped most recently (2026-10-22)

- **Hardening:** compaction trigger 6%→55%, reasoning classifier + mid-turn escalation,
  loop/step guardrails, mid-turn image cap, off-screen/stale-scroll reporting,
  no force-scroll clicks, `AMBIGUOUS_TAB`, composite key chords, stale-label hints,
  side-panel reconnect grace, `SIDE_PANEL_CLOSED`.
- **Clipboard:** `browser_clipboard` copy/read/write/clear/paste; virtual clipboard in
  `chrome.storage.session` (default) + opt-in system clipboard; permissions added; e2e.
- **Stop button:** `■` sends `chat.stop`; companion interrupts the DSH runtime (no SDK
  cancel exists) and resumes the same session on the next message. **Live-validated**
  in the latest run: turn interrupted, `TURN_STOPPED` logged, session resumed ~20 s later.
- **UI:** live-activity pane fills the top of the sidebar (55/45 split) + expand-to-full-height.
- **System prompt v3:** user authority (no refusals/moralizing/third-party-rule enforcement,
  including "no AI" rules), haste rules (act first, no preamble, fastest views, verify only
  claims, 1–3 bullet answers), v2 refinements (destructive-action guard, blocked-by-user,
  two-attempt stop, clipboard secret guard, final-answer contract). Reliability-only guardrails
  remain. `npm run system-prompt` prints the exact text.

## Latest real-run signal (post-change smoke test)

10 turns, **400.9 s** total, 75 tool calls, 17 tool errors — much faster per turn than the
pre-hardening 32 min/11 turns. Fired correctly: `TURN_STOPPED` + resume, `LOOP_DETECTED`,
stale-label hints, 3 mid-turn image offloads, 1 reasoning escalation.
Observed issues to fix next: **6× `browser_click_at requires x and y, or a non-empty points
array`** (model sends empty click_at args, likely malformed batch/arg shape), 2 side-panel
disconnects (>8 s), expected `PROTECTED_PAGE` on a Chrome-blocked tab, 1 page-label failure.

## Risks / not fully validated

- System-clipboard **rich Ctrl+V** needs a focused OS window; virtual clipboard is verified.
- Stop resume works live, but if a resume ever fails it falls back to a fresh session (logged).
- Prompt stance removes the agent's own refusals; **upstream model/provider policy can still
  refuse** — switch model/provider if that happens.
- System prompt is ~2.5K tokens; keep an eye on total prompt size.

## Suggested next work order

1. **Fix `click_at` empty-args failures** (6 in the latest run): require exactly one of
   `x/y` or `points` at the schema level/serializer, normalize/repair in batch, clearer error,
   add a test. Cheap, high frequency.
2. **File upload** (pathless `DataTransfer` for `<input type=file>` + user-attached companion
   picker) — still the biggest capability gap ("add an image" class of tasks).
3. Name/role targeting + batches that can cross a reveal boundary (Docs menus); native dialogs;
   drag/slider/right-click; downloads/popups.
4. Skill/recipe layer + durable task scratchpad; animation observation primitives
   (pixel-change watcher / frame bursts) for reaction-style tasks.
5. Auto per-run `summary.md` cost/latency attribution and budget alerts.

## Don't

- Don't fork DSH core; don't hand-edit `.dsh-home/browser-agent/llm.patch.yml` (generated).
- Don't `pkill` by browser executable path — kill only PIDs/PGIDs you started (an
  isolated-E2E cleanup once closed a normally-running Edge).
- Don't run the live agent (API key spend) in tests; use the fake-bridge/node tests or an
  isolated Edge profile + fixture server.
- Extension changes need a `chrome://extensions` reload + panel reopen; provider/companion/config
  changes need a companion restart; run `npm run setup` to validate profile composition.