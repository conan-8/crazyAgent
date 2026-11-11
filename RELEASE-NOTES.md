# crazyAgent v2.2.0

Changes since **v2.1.0-beta**. This release is a reliability and evidence pass: drags and selections on opaque surfaces stop lying, a closed or reloaded executor fails fast instead of hanging, argument and refusal errors teach the model how to recover, and every turn now carries its own cost/failure evidence. It also ships the panel-less background executor, the agent cursor and shared UI motion, and a rebuilt Android app.

The extension uses numeric update version `2.2.0`. The Android app is version `0.5.0` with version code `4`.

## Highlights

### Reliability pass (Track B)

- Drags and selections whose source or destination is an iframe, canvas, video, object, or embed report `unknown` with a full view and a diagnostic pixel comparison instead of a false `DRAG_NO_EFFECT`. DOM no-ops still report no-op.
- Switching the active tab mid-drag no longer times out: the gesture finishes on the original tab and the result is refused as `DRAG_STALE_TAB` with `mutationPossible:true` and no other-tab view. Hidden-tab pacing (throttle-proof waits plus one discarded forced frame per slow input ack) keeps the refusal inside the command timeout.
- Two consecutive `SIDE_PANEL_CLOSED` results open a provider circuit: later browser calls fail at once with a "report BLOCKED" message until one succeeds, a new turn starts, or a bounded probe window passes.
- Pre-input `STALE_VIEW`/`AMBIGUOUS_VIEW`/`NO_VIEW` refusals of `click_at`/`select`/`drag` return a refused result with a fresh full view, and the same coordinates stay refused until re-measured on a newer view.
- Every tool names an unknown argument and lists the accepted ones; common "requires" errors carry a literal example; a repeated identical argument rejection says so.
- Uploads verify inputs the page empties after taking the file, name the exact on-disk file for a `+`/space near miss, and list real file inputs when a label is not one. `mode:"replace"` through a `<label>` replaces its own control.
- A covered label names what covers it (tag, role, text, and its label when it has one).

### Measurement and turn evidence (Track A)

- `scripts/model-eval.mjs` runs eleven scripted real-model scenarios on an isolated headless Edge profile, a second companion, and the authenticated remote API, with independent page/request-log checkers and a `--self-test` mutation gate for every checker. Batch baselines live under `e2e/baselines/`.
- Each turn records the model's leading `DONE`/`PARTIAL`/`BLOCKED` label (model-reported, never verification), failed-call count, and per-turn token usage; stopped turns keep elapsed time and partial usage. The panel and Android summaries show them.
- `scripts/analyze-failures.mjs` reproduces the failure statistics from real run logs, including reported-label distribution and stopped-turn stats.

### Panel-less execution, cursor, and motion

- A phone can drive the agent with no side panel open: the background service worker runs the same executor when no panel exists, with explicit one-executor handover when a panel opens or closes. System-clipboard work still needs a panel.
- One yellow agent cursor follows the active tab, breathes while idle, and fades out of every capture; people never see hitboxes, only the clean `displayImage`.
- The side panel and Android app share one motion scale: growing feed rows, gliding streamed text, a shimmering waiting row, countdown waits, and answer-pinned scrolling.

## Improvements and fixes

- Updated DSH to `0.2.2-rc.1` with compatible security overrides; `npm audit` reports 0 vulnerabilities.
- Node test discovery is version-independent; CI runs Node and Android checks on every push and pull request.
- Agent-driven Remote setup guide and revised README APK verification/pairing steps.
- Refined Android launcher cursor placement.
- Fixed the mid-drag tab-switch timeout (root cause: hidden tabs produce no compositor frames, so each coalesced move waited ~5 s for its ack; a 13-move drag outlived the 30 s command timeout).

## Requirements

- Git and npm
- Node 24.9+
- Chrome/Chromium/Edge 116+
- An OpenRouter API key; provider usage charges apply
- Android 8.0/API 26+ for the optional native app
- Tailscale on the host and phone for normal remote access

See the tagged `README.md`, `android/README.md`, `docs/REMOTE-ACCESS.md`, and `PRIVACY.md` for installation and security details. GitHub source archives contain the complete extension and companion; no extension-only ZIP is required.

## Verification

For this release candidate:

- **972/972 Node unit/integration tests**; `npm audit`: **0 vulnerabilities**
- Prompt composition: **18,076 total / 17,082 guidance characters** (ceiling 17,100)
- Real-extension suites on isolated headless Edge with independent page-state checks: `edge-drag-e2e.mjs` (all cases including the mid-drag tab switch, passed twice), `edge-click-e2e.mjs`, `edge-expect-e2e.mjs`, `edge-files-e2e.mjs` 13/13, `edge-work-e2e.mjs` 27/27, `edge-canvas-e2e.mjs`, `edge-find-e2e.mjs`, `edge-background-e2e.mjs` 12/12
- Scripted real-model baseline (`deepseek/deepseek-v4.1-flash`, medium): 11 scenarios × 5 = **54 pass / 1 partial / 0 fail**; the partial left the page untouched but still hinted at an occurrence after detecting duplicate-text ambiguity
- Extension-reload-mid-turn real-model acceptance: a genuine `chrome.runtime.reload()` mid-turn reconnected the background executor and the turn continued to a correct, independently verified result (PASS-CONTINUE)
- Signed Android release APK `0.5.0 (4)`, SHA-256 `05090c0846a7d3cae3b11abee74ba7f84cb52ad3bce9ab3e5c76ba83469fdac1`, `apksigner verify` accepted (same local sideload key as before)

Unit, integration, mock-bridge, and scripted-companion checks are not real-model acceptance.

## Known limitations and release boundaries

- Track B9 (opt-in confirmation for irreversible actions) is intentionally deferred to a later release; it is not part of v2.2.0.
- Real docked-panel `/plan`, drag, expectation, download→upload, and minimized/unfocused workflows remain unrun; authenticated Docs/Pivot acceptance remains pending (no connected Docs browser).
- Firebase is not configured; no real FCM delivery has been tested.
- The newest Android live view, help card, Continue, Steer, and notification UI still require physical-phone acceptance; the signed release APK has not been installed over the debug build (different signing key — uninstall first, then pair again).
- A real service reboot acceptance and repeated real-companion Stop/New/token-rotation scenarios remain unrun.
- Remote browser execution requires an awake host, running companion, and running Edge (the side panel need not be open).
- Never expose the privileged bridge or remote controller through Tailscale Funnel or an unauthenticated public listener.

---

# crazyAgent v2.1.0-beta

Changes since **v2.0.0-beta**. This prerelease adds native Android remote control, one-turn planning, structured help, and live screenshots while preserving the existing guarded browser executor.

The extension uses numeric update version `2.1.0` and displays `2.1.0-beta`. The Android app is version `0.4.0` with version code `3`.

## Highlights

### Native Android remote control

- Pair through tailnet-only Tailscale Serve with a separate remote credential encrypted by Android Keystore.
- Send prompts and up to four images, stream responses and tool activity, stop turns, and start new chats.
- Reconnect with ordered event replay or full resynchronization. Idempotent client IDs prevent automatic duplicate submissions.
- Use Markdown responses, context-usage display, searchable saved-chat history, and native dark/yellow styling.
- Continue saved conversations and steer running turns.
- Use `/new`, `/model`, and `/plan` composer commands on Android as well as the desktop panel.

### Scoped remote API and shared sessions

- Opt-in companion listener on `127.0.0.1:17873`, intended only for tailnet-only Tailscale Serve.
- One DSH session and one active turn shared by desktop and phone clients.
- Phone-started turns appear in the desktop panel; conflicting desktop prompts are requeued rather than lost.
- Separate token generation and rotation, Host validation, authentication throttling, bounded requests, and bounded canonical history.
- No remote access to privileged bridge roles, arbitrary browser commands, model administration, arbitrary logs, or arbitrary host files.

### Screenshots and structured help

- Mirror agent captures to the Android live view and request fresh screenshots while the agent is idle.
- Open captures in a full-screen viewer with zoom and pan.
- Use the new `agent_request_help` tool to report a structured blocker, capture the current page, enter `waiting_for_user`, and resume the same session after a reply.
- 34 standing model-facing tools, plus the conditional `browser_plan` tool during explicitly planned turns.

### One-turn planning

- Exact `/plan` arms one accepted turn on desktop or Android; ordinary long prompts do not opt in automatically.
- Revisioned checklists support pending, active, completed, and blocked states.
- Stale-plan reminders and bounded completion nudges keep work moving without treating model-reported completion as independent verification.
- A sticky, collapsible desktop checklist preserves its state through scrolling, tool-step collapse, and terminal warnings.
- Queued and requeued prompts retain their planning setting.

### Notifications and operations

- Optional metadata-only Firebase Cloud Messaging integration and Android notification handling.
- Persistent `systemd --user` companion service example with automatic restart and linger support.
- Remote API, pairing, security, and privacy documentation.

## Improvements and fixes

- Fixed DSH frozen `turn/end` handling for plan outcomes and Docs verification. The provider now collects a mutable outcome, retires plan state, and sends a validated `turn-outcome` activity to the companion and remote clients.
- Added frozen-event, wrong-turn/session, malformed-input, reset, and remote-metadata regressions.
- New configurations default to medium reasoning effort; saved choices remain unchanged.
- Updated the recommended model to `deepseek/deepseek-v4.1-flash`.
- Standardized crazyAgent branding.
- Removed the browser-access Pause/Resume control and clear legacy paused state on startup. Stop remains available.
- Added compatible security overrides for MCP client/core, fflate, undici, and zod while keeping DSH pinned to `0.2.1-rc.2`.
- Added Firefox port research and a fork plan; Firefox itself is not supported by this release.

## Requirements

- Git and npm
- Node 22.19+
- Chrome/Chromium/Edge 116+
- An OpenRouter API key; provider usage charges apply
- Android 8.0/API 26+ for the optional native app
- Tailscale on the host and phone for normal remote access

See the tagged `README.md`, `android/README.md`, `docs/REMOTE-ACCESS.md`, and `PRIVACY.md` for installation and security details. GitHub source archives contain the complete extension and companion; no extension-only ZIP is required.

## Verification

For this release candidate:

- Clean `npm ci` and `npm run setup`
- **922/922 Node unit/integration tests**
- `npm audit`: **0 vulnerabilities**
- Prompt composition: **18,025 total / 17,031 guidance characters**
- Frozen `turn/end` provider tests and active-turn companion validation regressions
- Android clean test/lint/debug/signed-release build: **79 JVM tests passed, 0 lint findings**
- The opt-in Kotlin client integration test passed against the real Node remote API
- Mock-bridge `plan`, `remote`, and `slash` UI scenarios passed with inspected screenshots
- Signed Android release APK `0.4.0 (3)`, SHA-256 `f08eadce79b61adeaadb5aad20f6d50a0cfb23875808ccdf59115fbcb082b3ed`

Unit, integration, mock-bridge, and scripted-companion checks are not real-model acceptance.

## Known limitations and prerelease boundaries

- Real-sidebar/model `/plan` and authenticated Docs outcome acceptance remains pending.
- Firebase is not configured; no real FCM delivery has been tested.
- The newest Android live view, help card, Continue, Steer, and notification UI still require physical-phone acceptance.
- The signed Android release APK has been built and signature-verified locally but has not been installed over the debug build.
- Persistent service operation has not been tested across a real reboot.
- Remote browser execution requires an awake host, running companion, and open connected Edge side panel.
- Never expose the privileged bridge or remote controller through Tailscale Funnel or an unauthenticated public listener.
