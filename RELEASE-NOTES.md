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
