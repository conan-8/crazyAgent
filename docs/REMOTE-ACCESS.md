# Controlling crazyAgent from an Android phone

**Status (2026-11-10):**
- **Milestone 1** (the companion remote API with replay) is implemented behind opt-in `--remote`, and all three gates pass: unit/integration + isolated HTTP/WS checks, real-model remote navigation with independent fixture evidence, and tailnet-only Tailscale Serve of `17873` (§13.3).
- **Milestone 2** (the native APK) is implemented in `android/`. A physical Android phone passed the scripted-companion scenarios and real-companion/model prompts over both USB `adb reverse` and Tailscale HTTPS, including a Wi-Fi → cellular transition (§13.4).
- **Milestone 3** (screenshots) is implemented: the mirror of agent captures and on-demand `POST /snapshots` (§4.6, §13.5). A real idle capture through the real side panel passed. Nothing has been seen on a phone.
- **Milestone 4** (help) is implemented: `agent_request_help`, the `waiting_for_user` state, the help capture, and the reply path (§4.7, §13.6). After one real failure and a fix, three real-model runs passed with independent evidence. The app's help card and the panel's notice are unseen.
- **Milestone 5** (push) is implemented in code on both sides and tested against fakes only. **There is no Firebase project, so no message has ever been sent or received** (§4.9, §13.7).
- **Milestone 6** (the acceptance matrix) is mostly unrun; see §13.8 for which rows have evidence.
- **Milestone 7**: the user service runs the companion (no reboot test), and a locally signed release APK builds and verifies but has not been installed (§13.9).
- Still not done:
  - a Firebase project with `android/firebase.properties` and a service-account key on the computer, then every push check;
  - installing the new APK and looking at the live view, capture, help card, continue, steer, and notification settings on the phone;
  - RustDesk and a separate least-privilege Tailscale ACL review;
  - repeated real-companion Stop/New/token-rotation scenarios and independent visual inspection of the live docked panel;
  - Compose/instrumented UI coverage and the untried photo-picker/needs-review/accessibility interactions;
  - real-sidebar/model `/plan` and authenticated Docs outcome acceptance (the frozen-event transport and regression tests are fixed; live acceptance is separate).
- Port note: the remote API defaults to **`17873`**, not `17872` as first proposed; `17872` is the e2e fixture server used by the `scripts/edge-*-e2e.mjs` suites and `e2e/checklist.md`.
**Chosen deliverable:** a sideloadable native Kotlin APK that prompts the browser agent, streams its answer and tool activity, stops/starts chats, shows screenshots, reports explicit help requests, and receives reliable push notifications away from home.

> **Verified vs. proposed vs. needs a test:** facts marked **[verified]** were inspected on this machine, in the repo, or in the installed DSH packages on 2026-11-06. **[Proposed]** describes the selected design, not an existing feature or acceptance result. **[Needs test]** marks expected behavior that still requires an end-to-end run. Do not treat this document as acceptance evidence.

---

## TL;DR — decision and alternatives

| You want… | Choice | Status | Code needed |
|---|---|---|---|
| See and operate the real browser, including CAPTCHA/2FA takeover | **A. RustDesk + Tailscale** | available now; phone run still needed | none |
| Chat with the general DSH/Kimi agent, not the crazyAgent browser session | **B. Expose the DSH web GUI over Tailscale** | available after setup | none |
| Prompt/stream/stop the *browser* agent from a real Android APK, with screenshots and push | **C. Native Kotlin APK + scoped companion remote API** | **selected; proposed** | yes, companion + Android |
| Use Telegram instead of a dedicated app | **D. Telegram bot adapter** | optional alternative after C's server foundation | yes |
| Only "tell me when it needs help" | **E. ntfy/Pushover watcher or UnifiedPush alternative** | optional; not the selected push path | small |
| Full DSH chat UI driving the browser agent | **F. `dsh web` + companion `--no-dsh`** | not recommended; compatibility work | setup + verification |
| Ops: restart companion, read logs, rotate tokens | **G. Tailscale SSH + tmux** | complement | none |
| Public URL without Tailscale on the phone | **H. Cloudflare Tunnel + Access** | unnecessary for the chosen setup | optional |

**Decision:** build **C as a native Android application**, not a PWA, TWA, WebView wrapper, Telegram bot, or second side-panel `ui`. Use **A** as the immediate and permanent takeover/recovery path. Use **B only** if remote access to the separate general DSH/Kimi chat is also wanted; B does not control the crazyAgent side-panel session.

The selected phone stack is Kotlin + Jetpack Compose, HTTPS/WSS through tailnet-only Tailscale Serve, and Firebase Cloud Messaging (FCM) for screen-off notifications. Push payloads contain metadata only; the APK fetches responses and screenshots through authenticated Tailscale HTTPS.

### Immediate setup and build prerequisites

- **Today:** configure RustDesk unattended access and Tailscale on the phone, then test from cellular before leaving home. This is the CAPTCHA/password/2FA and side-panel recovery path.
- **Android toolchain [installed 2026-11-06]:** nothing is installed system-wide; the tools are under `~/Android`.
  - Temurin JDK 21.0.13 in `jdk/current`.
  - The command-line SDK in `Sdk/`, with `platform-tools` 37.0.1 (`adb`), `platforms;android-36` and `android-37.0`, and `build-tools;36.1.0`.
  - The SDK licenses were accepted with the user's approval.
  - Both downloads were checked against their published SHA-256 sums.
  - `android/` commits a checksum-pinned Gradle 9.9.0 wrapper, so no global Gradle is needed. Build instructions are in `android/README.md`.
  - No emulator or system image is installed; a physical Samsung phone is connected over USB and Tailscale instead.
- **Remote API [implemented, Milestone 1]:** do not expose the existing `17871/bridge`. `npm run dev -- --remote` adds a separate loopback listener on `17873`; proxy only that listener through tailnet-only Tailscale Serve. The Serve route is configured and verified tailnet-only at `https://conan-expertbook.tail11f47e.ts.net`.
- **Push:** FCM requires a Firebase project, an Android app registration matching the APK application ID, and locally stored Google service credentials. These secrets and signing material stay outside Git.
- **Implementation:** follow the architecture in §4 and the independently verifiable milestones in §13. The Milestone 1 server contract and Milestone 2 native app now exist (see §13.3–§13.4 for evidence); screenshots, help, and push remain proposed contracts.

---

## 1. Why this is not just "open a port"

What runs at home today **[verified]**:

```text
Active tab  ↔  side panel (browser executor, chrome.debugger)
                    ↕  WebSocket, pairing token, 127.0.0.1:17871
               companion (Node, loopback HTTP + WS bridge)
                    ↕
               DSH runtime (agent loop, sessions, model calls)
                    ↓
               OpenRouter / model provider
```

Three consequences matter for remote access:

1. **The extension owns browser execution.** An open side panel is the preferred executor and owns `chrome.debugger`, tabs, capture, and downloads. When no panel is open, the extension's background service worker runs the same executor; when neither is connected, browser tools fail. See §12 for lifecycle and system-clipboard limits.
2. **The bridge has exactly two singleton roles: `ui` and `tools`.** `ui` is the side panel; `tools` is the DSH browser-use provider. Both are single-slot: a newer client replaces the old one (`companion/bridge.mjs` `#claimUi` / `#claimTools`). The panel auto-reconnects every 2.5 s on anything except an auth failure, so a phone client that connected as `ui` would fight the panel and tear down the executor mid-turn. The selected design therefore uses a **separate remote HTTP/WSS API and RemoteHub**, not a second `ui` or a third privileged role on this bridge.
3. **The companion is loopback-only and token-authenticated with no TLS.** Good default. Remote access keeps both Node listeners on loopback and puts tailnet-only Tailscale Serve in front of the separate remote API only — never a raw public port or the privileged bridge.

What already exists on this machine **[verified 2026-11-06]**:

- **Tailscale is installed and running.** Host `conan-expertbook` = `100.96.64.4`, tailnet `tail11f47e.ts.net`; there is an Android device on the tailnet (offline 72 days), plus a macOS laptop and a Windows PC. No `tailscale serve`/`funnel` config yet.
- **RustDesk 1.4.9 is installed**, `rustdesk.service` enabled and running for ~3 months.
- **DSH web GUI** is running as `dsh web` on `127.0.0.1:3080`, spawned by the Kimi Code app. Note: the global CLI is DSH **0.2.1-rc.5**; crazyAgent's repo bundles **0.2.1-rc.2** — relevant only for option F.
- **The crazyAgent companion** runs from `scripts/dev.mjs` under the Kimi Code process tree, logging to `logs/companion.log`. That parentage matters for keep-alive (§12).
- Ubuntu 26.04 GNOME on Wayland; on AC the machine does not suspend (`sleep-inactive-ac-type='nothing'`).

---

## 2. Option A — Remote desktop (works today, zero code)

**What:** control the actual desktop from the phone, including the Edge window and the crazyAgent side panel. You see exactly what the agent sees, type prompts with the phone keyboard, and can take over for login/CAPTCHA/2FA/payment blockers.

**RustDesk (already installed)** **[verified installed + service active; needs test from phone]**

1. RustDesk on the desktop → **Settings → Security → permanent password** (unattended access), note the **ID**. Defaults are `approve-mode=password-click`, `verification-method=use-both-passwords`.
2. Install the RustDesk phone app (Android/iOS), connect to the ID + password.
3. Prefer the Tailscale path: both devices on the tailnet, connect to the desktop's tailnet IP; the default public relay is RustDesk's infrastructure, so self-host `hbbs`/`hbbr` if you care about rendezvous metadata. Keep the relay only as fallback.
4. In the phone session: open Edge → puzzle icon → **crazyAgent** side panel, then type prompts in the panel composer and read the activity feed and screenshots.

**Caveats:**
- **Wayland:** 1.4.9 captures the logged-in GNOME session through PipeWire + `xdg-desktop-portal`. Expect a portal consent prompt the first time; some GNOME builds re-prompt or drop the share. Test one session before relying on it. **[needs test]**
- **Lock screen:** the standard 1.4.9 build **cannot drive the GNOME lock screen/greeter** on Wayland. There is a RustDesk preview build with unattended + login-screen access, but treat it as preview. Practical choice: disable auto-lock while away (security trade-off) or accept that, if the desktop locks, you cannot take over the GUI.
- Phone UX for typing long prompts is mediocre; best for **takeover and unblocking**, not long chats.
- The agent keeps running while the screen is locked (it uses page-level CDP captures), so remote *chat* channels (B/C/D) work while locked; remote *desktop* may not.
- A controller that can see the desktop also sees every logged-in tab. Use a strong RustDesk password (not the OS password), enable connection 2FA, and prefer tailnet-only connections.

**Alternatives:** Chrome Remote Desktop (not installed; its Linux host historically wants X11/Xvfb, so Wayland means a detached virtual desktop); VNC/wayvnc/noVNC behind Tailscale (weak auth, latency); Sunshine+Moonlight (low latency, awkward for desktop text); Parsec (no Linux host). RustDesk is the right choice because it is already installed.

---

## 3. Option B — Put the DSH web GUI on your phone (works today for this agent)

The GUI you are using right now is a normal web app with real auth. Exposing it to the tailnet gives you **the same chat experience on the phone**: streaming text/reasoning, tool call/result tree, session history, images, approvals, and user questions. **[verified — image tool-result galleries and approval/ask-user UI are shipped in the web profile]**

**Auth model [verified in installed rc.5 source]:** each `dsh web` process mints a launch token in memory and prints a URL containing `?token=` **once** at startup. Opening `GET /?token=…` sets an authority-bound HMAC-signed cookie (`HttpOnly`, `SameSite=Strict`, 30-day default) and redirects to `./`. All `/api` and WebSocket traffic requires that cookie. Host/Origin are fenced: `Host` must be loopback, the literal bind IP, or a configured `--trusted-host`; cross-site `Origin` and `sec-fetch-site: cross-site` are refused. `--host 0.0.0.0` is deliberately unsupported. The signing secret is durable in `$DSH_HOME/.credentials.yaml`, so the **cookie survives server restarts** on the same host:port — but the launch URL itself cannot be recovered from a running process.

**The catch:** the current server (PID 318816) was started by Kimi Code with no remote flags, and its token URL went to a socket, not a file. You need to **restart `dsh web` once with remote flags** (do it when no desktop task is mid-turn; sessions persist and can be resumed), or start a second instance — but a second instance is *not* equivalent:

- Sessions are `flock`-protected across processes, so instance 2 cannot attach to a session live in instance 1; the phone would see cold history, not the live turn.
- Shared-home JSON projections have no cross-process lock (last writer wins), and both HMR watchers react to profile edits.
- **Prefer one server for both devices.**

### B1. Minimal: bind the tailnet IP (plain HTTP inside WireGuard)

```sh
dsh web --no-open --host 100.96.64.4 --trusted-host 100.96.64.4
```

Phone (Tailscale app connected): open the printed `http://100.96.64.4:3080/?token=…` URL once. **[needs test]**

- Works on cellular (Tailscale tunnel), no port forwarding, no public exposure.
- The listener is plain HTTP, but Tailscale (WireGuard) encrypts the path; the cookie will not be `Secure`. Acceptable on a private tailnet, not for public exposure.

### B2. Optional: HTTPS for the separate DSH web GUI via Tailscale Serve

1. Tailscale admin → DNS: enable MagicDNS and **HTTPS certificates**.
2. `tailscale serve --bg 3080` → `https://conan-expertbook.tail11f47e.ts.net/` proxies to `http://127.0.0.1:3080/`.
3. Restart the GUI so the proxied authority is trusted:
   ```sh
   dsh web --no-open \
     --public-url https://conan-expertbook.tail11f47e.ts.net \
     --trusted-host conan-expertbook.tail11f47e.ts.net
   ```
4. Phone: open `https://conan-expertbook.tail11f47e.ts.net/?token=…` once, then `https://conan-expertbook.tail11f47e.ts.net/`.

Caveats: Tailscale Serve proxies WebSockets but an open issue reports spurious `1001` closes on some hosts — the DSH client reconnects, but expect the odd blip. Tailscale **Funnel** is public with no auth layer: never Funnel a controller. A lost/expired phone node key is the usual failure; re-auth in the app. **[needs test on this host]**

**What this does and does not give you:**
- ✅ Prompt/stream/answer this DSH agent from the phone, read tool activity and images, approve/answer prompts, switch sessions/models. Two clients can use **one live session**: busy sends become Queue/Steer, and either client can settle an approval/user question. **[verified]**
- ❌ It does **not** drive the crazyAgent side-panel browser session. It is a chat UI for DSH sessions. For the browser agent, see C or F.
- ❌ No service worker, no Notification API, no PWA push. There is a web manifest (installable home-screen shortcut), a viewport meta, and the sidebar collapses below 1024 px — but there are no phone-width breakpoints, so at ~400 px it is cramped but usable. **[verified]**

---

## 4. Option C — Native Android APK for the browser agent (selected build)

This makes the **browser agent** remote-first without requiring the phone to render the desktop UI. It does not remove the host-side requirement for a running companion, Edge, and a connected side panel.

### 4.1 Decisions that are not open in this plan

- **[Proposed]** Build a native Kotlin APK using Jetpack Compose. Do not substitute a PWA, TWA, WebView wrapper, or Telegram client.
- **[Proposed]** Support Android 8.0/API 26 or newer, targeting the SDK selected when the project is scaffolded. A debug APK is sufficient for initial acceptance; produce a signed release APK only after acceptance.
- **[Proposed]** Use HTTPS and WSS through tailnet-only Tailscale Serve. Keep both Node listeners on loopback and never enable Funnel for this controller.
- **[Proposed]** Add a separate phone-facing listener on `127.0.0.1:17873`; do not add a phone as another `ui` and do not proxy the privileged `17871/bridge` to the tailnet.
- **[Proposed]** Use a separate remote credential so phone revocation does not re-pair or interrupt the desktop side panel/provider.
- **[Proposed]** Use Firebase Cloud Messaging for reliable screen-off delivery. A foreground-service WebSocket is not the push design.
- **[Proposed]** "Needs help" is a structured state, initially triggered by a dedicated model-facing control. Do not scrape arbitrary final prose or pretend the current runtime supports interactive approvals.
- **[Proposed]** A help request ends the current turn normally. The phone's reply starts the next turn in the same DSH session. Mid-turn pause/resume and approval buttons are out of scope.
- **[Proposed]** RustDesk remains the live visual takeover path for CAPTCHA, passwords, 2FA, and reopening the side panel.

### 4.2 Process and trust boundaries

```text
Native Android APK
  Kotlin + Jetpack Compose
  OkHttp HTTPS/WebSocket client
  Android Keystore-protected app settings
  Firebase Cloud Messaging receiver
               │
               │ HTTPS/WSS; normal platform certificate validation
               │ Tailscale Serve; tailnet only, never Funnel
               ▼
Remote HTTP/WS listener [new]
  127.0.0.1:17873
  remote-token authentication, request limits, Host validation
  state/commands/events/screenshots/push registration
               │
               ▼
Companion session controller + RemoteHub [new]
  canonical chat events, sequence/replay, idempotency
  turn/help state, screenshot IDs, FCM device registry
               │
               ├──────────────► FCM HTTPS API [metadata only]
               │
               ▼
Existing private WebSocket bridge
  127.0.0.1:17871/bridge
  ui = Edge side panel; tools = DSH browser-use provider
               │
               ▼
Edge side-panel browser executor
```

The APK never receives permission to claim `ui` or `tools`, submit `browser.command`/`browser.result`, configure the LLM, export debug logs, or read arbitrary host files. Tailscale network access is an additional boundary, not a replacement for application authentication.

### 4.3 Companion changes

1. **Extract transport-independent session operations.** `companion/index.mjs` currently accepts chat/new/stop through UI socket callbacks. Extract a small session controller used by both the existing UI transport and the remote API. Preserve one active turn, existing stop/interrupt semantics, and the current DSH session; do not create a second runner for Android.
2. **Add an explicit chat broadcaster.** Introduce a chat/event publication path for allowlisted UI events. Do **not** blindly change `Bridge.sendToUi` into a broadcast: it also sends `browser.command`, which must remain UI-only. The side panel continues to receive the same frames, while RemoteHub receives a normalized copy.
3. **Add `companion/remote-server.mjs`.** Own the separate loopback HTTP server and WSS upgrade handling, bearer authentication, Host checks, body/payload limits, structured errors, route validation, and graceful shutdown. Native clients send `Authorization: Bearer …`; there is no browser cookie or CORS dependency.
4. **Add `companion/remote-hub.mjs`.** Own the bounded event journal, current remote projection, accepted-command IDs, replay handoff, screenshot metadata/cache, push device registrations, and subscriber lifecycle. Do not scrape the side panel's rendered HTML history (`chrome.storage.local`) or debug-log JSONL to reconstruct chat.
5. **Add `companion/remote-push.mjs`.** Define a fakeable push-provider interface, an FCM HTTP v1 implementation, registration pruning, coalescing, and notification observability without message-content logging. Use a supported Google authentication library with Node's HTTPS/fetch stack; do not hand-roll service-account JWT handling.
6. **Extend screenshot ownership narrowly.** Reuse known LogStore/executor artifacts where practical, or write a bounded remote cache with mode `0600`. Map opaque screenshot IDs to known files in server memory/state. Never turn a client-provided path into a file read.
7. **Generate, pair, and rotate the remote token.** Store it under `.dsh-home/browser-agent/` with mode `0600`; add an explicit `--pair-remote` operation that prints the pairing secret only on deliberate request and `--new-remote-token` to rotate/revoke existing phones. Do not print it in ordinary startup output or remote/debug logs. Initial pairing is by manual paste into the APK; QR pairing is a later convenience, not a dependency.

### 4.4 Versioned remote API

Routes below are versioned under `/remote/v1`. Every route below is **implemented**; exact behavior is in §4.5.1. All routes require the remote credential. JSON errors use `{error:{code,message,retryable}}`; clients must not infer success from HTTP 200 alone when an operation is asynchronous.

| Method/route | Request | Result and rules |
|---|---|---|
| `GET /state` | optional `after=sequence` and `instance=instanceId` | Current protocol/server version, per-process `instanceId`, session ID, turn status, model identity/context metrics, `uiConnected`, `toolsConnected`, latest sequence, active-turn projection, recent canonical events, and latest screenshot ID. |
| `GET /sessions` | empty | Return up to 12 saved-chat summaries with title, update time, current/running state, count, and truncation marker. This is separate from the live projection. |
| `GET /sessions/{id}` | opaque session ID only | Return one bounded canonical transcript for read-only display. Unknown/expired IDs return `404`; malformed IDs return `400`; no filesystem path is accepted. |
| `POST /messages` | `{clientMessageId,text,images?,autoCapture?,planMode?}` | Atomically reserve the one turn slot before returning `202` with accepted turn/client ID; concurrent requests cannot both pass the busy check. Return `409` when busy or validation/setup errors. Reuse existing attachment limits. `planMode:true` explicitly arms the existing one-turn plan workflow for this remote prompt; it is included in idempotency fingerprints. The same client ID returns the original outcome without another turn. |
| `POST /stop` | `{clientCommandId}` | Idempotently request the existing stop path. Return stopping or idle; never claim a turn stopped before the actual stopped event. |
| `POST /new` | `{clientCommandId}` | Start a new DSH session only when no turn is running/stopping. Clear remote help state and broadcast the new session. |
| `POST /snapshots` | `{detail:"fast"}` and client command ID | Capture a fresh viewport only when idle/waiting and safe. While browser work is active, return `409 TURN_BUSY` plus the latest existing screenshot ID rather than injecting a capture. |
| `GET /screenshots/{id}` | opaque ID only | Authenticated binary JPEG with correct length/MIME, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Unknown/expired IDs return `404`; paths and traversal syntax are never resolved. |
| `PUT /push/devices/{deviceId}` | `{fcmToken,platform,appVersion}` | Register or replace this Android device's FCM token. The remote pairing credential authorizes registration; the FCM token is not a controller credential. |
| `DELETE /push/devices/{deviceId}` | empty | Unregister notifications for this device without rotating other phone/desktop credentials. |
| `WSS /events?after={sequence}&instance={instanceId}` | bearer header during upgrade | Detect companion instance changes. Send missed events in order, or one full resync if the instance/sequence is unknown or expired; then continue live. Queue live frames during replay so reconnect cannot reorder events. |

Health is part of authenticated `/state`; do not expose an unauthenticated internet/tailnet health mirror containing model/session details. `uiConnected:false` must be visible in the APK and means browser actions will fail even if the companion itself is healthy. `health.contextWindow` is the selected model's advertised window and `health.contextTokens` is the latest provider-reported session total, matching the side panel's ring; a new session resets the used count.

Saved history is companion-owned canonical data, not side-panel HTML or debug-log scraping. `RemoteHistoryStore` keeps at most 12 sessions, 300 messages and 1 MB per session, atomically writes `.dsh-home/browser-agent/remote-history.json` with mode `0600`, deduplicates events, and marks trimmed transcripts. It never creates or switches a DSH runner. Opening an archived chat on Android is read-only; durable live-session restoration and uncertain-send recovery remain separate concerns.

### 4.5 Event, replay, and submission semantics

Use a common envelope `{v:1,instanceId,seq,type,sessionId,turnId?,occurredAt,body}` with a random per-process instance ID and a monotonically increasing sequence within that instance.

Canonical events include:

- `remote.state` / `remote.resync` — full authoritative projection when replay is impossible;
- `chat.user`, `chat.assistant`, `chat.tool_call`, `chat.tool_result` — committed conversation state;
- `chat.draft` — ephemeral streamed text/tool deltas, identified by `streamId` and monotonically increasing offset;
- `chat.status`, `chat.done`, `chat.stopping`, `chat.stopped`, `chat.error`, `chat.session` — lifecycle;
- `remote.screenshot` — metadata and opaque ID, never inline base64;
- `remote.help` — structured reason/category and optional screenshot ID;
- `remote.health` — UI/tools/model reachability changes.

The bounded in-memory journal includes enough of the active turn to replay streamed deltas and committed events. On reconnect:

1. Authenticate and read `instance` plus `after`.
2. A different instance ID requires full resync and marks pre-restart command outcomes unknown; never interpret a reset sequence as continuity.
3. For the same instance, replay retained events after the supplied sequence in exact order while buffering newer live events.
4. If the sequence is expired/unknown, send a full `remote.resync` containing canonical messages and the current aggregated draft, then live events.
5. The Android reducer deduplicates by instance/sequence and replaces a draft with its committed assistant message, mirroring the side panel's stream/commit distinction.

Every mutating HTTP command has a client-generated UUID. Cache accepted IDs and outcomes for a bounded period and never auto-start the same prompt twice after an Android retry. In the first version, replay guarantees cover Android/network/process reconnects while the companion remains alive. A companion restart marks the old projection stale; the APK must surface an uncertain submission for user review rather than blindly executing it again. Durable cross-restart chat restoration is a separate milestone.

#### 4.5.1 As implemented in Milestone 1 [verified by tests and an isolated smoke run; not yet via Serve or a phone]

Code: `companion/remote-server.mjs` (listener, auth, routes), `companion/remote-hub.mjs` (journal, projection, idempotency), `companion/remote-token.mjs` (credential), and `companion/session-controller.mjs` (chat/new/stop extracted from `companion/index.mjs`; the side panel and remote API share it). `index.mjs` publishes allowlisted chat frames through one broadcaster (`publish` → `bridge.sendToUi` + `RemoteHub.ingest`); browser commands stay on `bridge.sendToUi` only. `Bridge` gained an `onActivity` observer so provider `chat.activity` frames reach the hub.

**CLI.** `--remote` enables the listener (off by default; without it nothing listens on `17873`). `--remote-port <n>` (default `17873`, env `CRAZYAGENT_REMOTE_PORT`), `--remote-public-host <host>` (env `CRAZYAGENT_REMOTE_PUBLIC_HOST`; the accepted Serve authority). `--pair-remote` prints the server URL and token, then exits. `--new-remote-token` rotates the token, then exits; combine both to rotate and print. Neither one-shot operation starts the companion or binds a port. The bind host is always `127.0.0.1`; the constructor refuses anything else.

**Credential.** `.dsh-home/browser-agent/remote-token`, 64 hex characters, mode `0600`, written via temp file + rename, independent of the bridge token. It is never printed at startup or written to logs. A running companion re-reads the file (mtime/size/inode) at most every 2 s: after rotation the old token gets `401` within ~2 s, and open event streams close with code `4401` at the next heartbeat (≤25 s). A missing or invalid file fails closed. The remote token is rejected as a bridge `hello` (`4001`).

**Request rules.** `Authorization: Bearer <token>` with constant-time comparison. `Host` must be `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, or the configured public host (optionally `:443`); anything else is `421 HOST_NOT_ALLOWED`. Failed authentications share one 20/min window, because Serve makes every peer look like loopback; past that limit they get `429 AUTH_THROTTLED`. A valid token is never throttled. Other limits: 600 requests/min, 30 prompts/min, 16 KiB command bodies, 18 MiB message bodies, and 100,000 prompt characters. Image limits are the existing four images (5 MB each, 12 MB total). POST bodies must be `application/json` JSON objects. Encoded slashes and `..` are refused. Every response carries `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, and `x-request-id`. The debug log records method, route, status, code, and duration only, never tokens or prompt text.

| Route | Implemented result |
|---|---|
| `GET /state` | `200` projection: `protocol`, `server`, `instanceId`, `sessionId`, `latestSequence`, `oldestSequence`, `turn{status,turnId,origin,clientMessageId,startedAt,endedAt,outcome,error}`, `phase{status,tool}`, `health{uiConnected,toolsConnected,dsh,dshMessage,provider,model,contextWindow,contextTokens,autoCapture}`, up to 300 committed `messages`, the aggregated `draft`, `latestScreenshotId` plus its `latestScreenshot` metadata (both `null` until the agent captures a view in this session), and `help` (`null`, or `{turnId,category,reason,screenshotId,captureError,requestedAt}` while the turn status is `waiting_for_user`). `health` also carries `pushConfigured`. Cursor parameters are ignored; use `/events`. |
| `GET /sessions` | `200 {sessions}` with up to 12 summaries. Each has `sessionId,title,updatedAt,messageCount,truncated,current,running`. History is fetched separately from live state and refreshed after turn/session changes or when the phone opens history/home. |
| `GET /sessions/{id}` | `200 {sessionId,title,createdAt,updatedAt,droppedMessages,messages}` containing only canonical committed events. `404 SESSION_NOT_FOUND` for unknown/expired IDs, `400 INVALID_SESSION_ID` for malformed IDs, and `405` for writes. |
| `POST /messages` | `202 {accepted,clientMessageId,turnId,instanceId,sessionId,sequence}` once the slot is reserved. `409` for `TURN_BUSY`, `TURN_STOPPING`, `SESSION_CHANGING`, or `IDEMPOTENCY_CONFLICT` (same ID, different payload). `422` for invalid fields, `INVALID_ATTACHMENT`, or `EMPTY_PROMPT`. `503 RUNTIME_NOT_READY`. `413` when too large. `429 RATE_LIMITED`. Every outcome, including a rejection, is cached for 15 minutes (up to 1,000 IDs), so a retry with the same ID returns it with `replayed:true` and never starts a second turn. A deliberate resend after a busy rejection needs a new ID. |
| `POST /stop` | `200 {state:"idle"}` or `202 {state:"stopping",turnId}`. The actual end arrives as `chat.stopped` plus `chat.turn{outcome:"stopped"}`. Idempotent per ID. |
| `POST /new` | `200 {sessionId}`. `409` while running, stopping, or switching sessions; `503` when not ready. A concurrent duplicate ID awaits the same outcome, creating one session. The hub then clears its committed projection and emits `chat.session`. |
| `POST /snapshots` | `{clientCommandId}`. `201 {clientCommandId,screenshotId,latestScreenshotId,screenshot,instanceId}` after one fresh `snapshot` (detail `normal`, 15 s limit) through the side panel; the image is published as `remote.screenshot{source:"manual"}` and the capture's labels are cleared from the page afterwards. `409 TURN_BUSY`/`TURN_STOPPING` with `latestScreenshotId` while a turn runs, and no browser command is sent. `409 SNAPSHOT_BUSY` while another capture is in flight, `409 SESSION_CHANGING`, `503 UI_DISCONNECTED` when no panel is connected (no reconnect wait), `502 SNAPSHOT_FAILED` when the capture fails, returns no image, or cannot be kept. 20 per minute. Idempotent per client ID, including failures. A turn that starts during a capture waits for it. |
| `PUT /push/devices/{id}` | `{fcmToken,platform:"android",appVersion?}`. `200 {deviceId,registered:true,created,instanceId}`. The same device ID replaces its token; the same token under a new ID moves; at most 8 devices. `503 PUSH_NOT_CONFIGURED` when the computer has no FCM service-account key. `422 INVALID_PUSH_TOKEN`/`INVALID_PUSH_PLATFORM`/`INVALID_PUSH_REGISTRATION`, `400 INVALID_DEVICE_ID`, 30 per minute. Registrations are kept in `.dsh-home/browser-agent/push-devices.json` (`0600`); tokens are never logged. |
| `DELETE /push/devices/{id}` | `200 {deviceId,registered:false,removed}`. Idempotent; works whether or not push is configured. |
| `POST /sessions/{id}/resume` | `{clientCommandId}`. Continues a saved chat: only an ID present in the bounded history is accepted (`404 SESSION_NOT_FOUND` otherwise). The controller switches the DSH session through `runner.resume` and the hub rebuilds its committed projection from the saved transcript, then publishes `chat.session{sessionId,resumed:true,restoredMessages}`. `200 {clientCommandId,sessionId,instanceId}`; `409 TURN_BUSY`/`TURN_STOPPING`/`SESSION_CHANGING` while a turn runs or another switch is in flight; `409 SESSION_NOT_RESUMABLE` when DSH can no longer restore that session (the current session is kept). Idempotent per client ID. |
| `GET /screenshots/{id}` | `200` with the image bytes, its real `content-type` (`image/jpeg`, `image/png`, or `image/webp`), `content-length`, and the standard security headers for an ID the hub still holds. `404 SCREENSHOT_NOT_FOUND` for an unknown or evicted ID, `400` for a malformed one. The ID is a key into the hub's in-memory mirror and is never resolved as a path. |
| `GET /events` without upgrade | `426 UPGRADE_REQUIRED`. |
| `WS /events?instance=&after=` | Bearer, Host, and path are checked before the upgrade; otherwise a plain HTTP `401`/`421`/`404` is returned. The server replays retained events after `after`, or sends one unsequenced `remote.resync` frame (`seq` = the latest sequence; `body{reason,state}`; reasons `no-instance`, `instance-changed`, `unknown-sequence`, `expired-sequence`), then streams live. Replay and subscription happen in one synchronous block, so live events cannot interleave. The stream is server → client only, and client frames are ignored. Limits: 8 streams, a ping every 25 s with dead peers terminated, `1013` when a slow reader exceeds 8 MiB buffered, `4401` on token revocation, and `1001` on shutdown. |

**Events as implemented.** The journal is bounded to 2,000 envelopes or 4 MB.
- `chat.user{text,origin,clientMessageId,imageCount}` is emitted by the hub at turn start, for both panel and phone prompts.
- `chat.draft{streamId,channel:"text"|"reasoning"|"tool",offset,delta,toolCallId?,name?}`.
- `chat.assistant`, `chat.tool_call`, `chat.done`, and `chat.error` carry `replacesStreamId` when they supersede a draft.
- `chat.status{status,tool,turnStatus}`: during a turn it is deduplicated activity phases; outside a turn it is derived from runtime health, because panel status frames only flow while a panel is connected.
- `chat.turn{...turn}` is new: the authoritative end-of-turn projection with `outcome` `done`, `stopped`, or `error`.
- `remote.health` is emitted only when health changes.
- `chat.session{sessionId}` starts an empty chat. With `resumed:true,restoredMessages:n` a saved chat became live again; its earlier messages are only in the projection, so a client resyncs when `n > 0`.
- Steering: `POST /messages` accepts `steer:true` (part of the idempotency fingerprint). When a turn is running, the companion stops it exactly as Stop does and starts this message as the next turn in the resumed session, in the same tick the stopped turn releases the slot. The reply is `202` with `steered:true` and the new turn's ID; the `chat.user` event follows `chat.stopped`. Only one message may wait (`409 STEER_PENDING`). When idle, `steer:true` is an ordinary send. If the runtime is gone when the slot frees, a `chat.error` reports that the steering message was not sent.
- `remote.screenshot{screenshotId,callId,capturedAt,width,height,mimeType,bytes,source:"auto"|"tool"|"manual"|"help"}` is emitted for every image the side panel returns to the companion: an auto view, a tool result, a capture a phone asked for, or the capture taken for a help request. It carries metadata only; it is not part of the committed transcript or saved history.
- `chat.stopped{reason:"idle"}` replies and panel-only busy errors are not journaled.
- `remote.state` is not used; `remote.resync` plays that role.
- The turn states in use are `starting`, `idle`, `running`, `stopping`, `waiting_for_user`, and `error`. An error state persists until the next turn.
- `remote.help{turnId,category,reason,screenshotId,captureError,requestedAt}` is published when a finished turn carried a help request, immediately before that turn's `chat.turn{status:"waiting_for_user",outcome:"done"}`. `chat.done` for that turn carries `help{category,reason}`. `chat.user` (any origin) and `chat.session` clear the request; `chat.session` also returns a waiting status to `idle` without a separate `chat.turn`.

**Side panel and phone turns [verified with the UI preview harness and unit tests; not yet in a live docked panel].**
- For turns the panel did not start, the companion also sends the panel `chat.user{turnId,origin,text,imageCount}`. Image bytes are not echoed, and panel-originated turns are not echoed back.
- The panel renders the turn like its own, with a "From phone" chip and name-only image placeholders. It goes busy, so desktop input queues and Stop applies to the shared turn.
- Rejections sent to the panel now carry `code` (for example `TURN_BUSY`).
- If the panel's own send loses the race to the phone, the panel receives `chat.user` first and then the coded refusal. Its message is marked "Not sent · queued until the other turn finishes", put back at the front of the queue, and sent when the phone turn ends; nothing runs twice. Real failures without a busy code still show as errors.
- Logic lives in `extension/sidepanel/remote-turn.js` (unit-tested) and `app.js`. `node scripts/ui-preview.mjs --scenario remote` asserts the rendering, queueing, lost-race requeue, and error paths against the real panel page.

**Known gaps after Milestone 1.**
- A panel that (re)connects in the middle of a phone turn never saw its `chat.user`. A desktop send then gets a busy refusal, is queued, and is sent after the turn ends, but the running phone turn's prompt is not shown.
- There is no cross-restart durability, as designed.

### 4.6 Screenshot behavior

**Implemented (mirror and on-demand capture).** The bridge reports each successful image-bearing `browser.result` to `RemoteHub.addScreenshot` as a read-only copy; the provider and side panel still get the untouched result. The hub accepts JPEG/PNG/WebP up to 8 MiB, reads the pixel size from the image header, keeps the bytes in memory only (24 images or 48 MiB, oldest evicted first, cleared on a new session and lost on restart), and publishes `remote.screenshot`. Nothing is written to disk. `POST /snapshots` adds the `manual` source and the help flow adds `help` (§4.5.1, §4.7); `turn_end` was not built. The cache stays at 24 images or 48 MiB in memory, not the 50 images/100 MB/24 h first proposed. The Android app shows the newest image as a full-width live view above the chat with its source and age, a capture button, and an explicit state when the newest image is gone (§13.4). `scripts/fake-remote-companion.mjs` publishes synthetic screenshots every turn (`tall` and `square` in the prompt change their shape).

The original design follows.

`auto_view` is DOM-first and usually has no image. Real images arrive through `snapshot`/`browser_screenshot`; `chat.tool_result.text` is insufficient because image blocks become the literal `"[image]"`.

RemoteHub therefore consumes the actual image-bearing `browser.result` before base64 is discarded/redacted from ordinary chat projections. It decodes once, validates MIME/size, stores the binary through the bounded screenshot owner, and publishes `{screenshotId,turnId,callId,capturedAt,width,height,mimeType,bytes,source}`.

Screenshot sources are:

- `tool` — an image the agent already captured; mirror it without new browser work;
- `manual` — an idle `snapshot` requested by the APK with a 15 s upper bound and serialized against other companion captures;
- `help` — one best-effort capture after the model run has quiesced and before the waiting-for-user projection is published;
- `turn_end` — optional/configurable, not the default for every turn.

Do not stream video or continuous screenshots. During an active turn, Show screen displays the latest existing image; a fresh capture request fails closed with `TURN_BUSY`. A help-notification screenshot is fetched only after the phone opens the authenticated Tailscale session. FCM never carries image bytes.

The initial remote-cache policy is configurable and bounded (proposed defaults: 50 images, 100 MB, and 24 h, whichever limit is reached first). Eviction emits no false "new screenshot" event. Existing debug-log retention is a separate policy and must not be silently changed.

### 4.7 Explicit help protocol and turn state

**Implemented.** The tool is `agent_request_help` in `packages/dsh-browser-extension/lib/help.js`, a 34th standing tool named once in the guidance. Differences from the design below:

- **Transport.** The request does not ride the session's `turn/end` event. DSH deep-freezes committed session events, so a `session/event` listener that assigns to `event.data` throws, and the provider's catch hides it. The first real run showed exactly that: the model called the tool and the turn ended `idle`. The tool now sends `{kind:"help-request",category,reason}` as a provider activity over its bridge connection; the bridge stamps the companion's current turn ID and `SessionController.noteActivity` accepts it only for the running turn. If the frame cannot be sent, the tool fails with `HELP_NOT_DELIVERED` and tells the model to say what it needs in its final message. Docs verification and plan outcomes use the same transport: the provider collects them in a mutable object, retires plan state, and emits `{kind:"turn-outcome",sessionId,turn,...outcome}`. The controller validates the active companion turn and session before applying the metadata, and RemoteHub preserves it in `chat.done`. Frozen-event provider tests and companion wrong-turn/malformed-input regressions cover this path; real-sidebar/model plan and Docs acceptance remains separate.
- **Validation.** `reason` is trimmed, 1–500 characters; `category` is one of the six values; unknown fields are refused. The companion re-checks the shape and ignores anything else. The last request in a turn wins; a request for another turn, or with no turn running, is ignored.
- **Capture.** After `runner.run` resolves, the companion takes one `snapshot` with source `help` and clears its labels. A closed panel, a timeout, or an image-less page becomes `help.screenshotId:null` with `captureError`; the chat still waits.
- **Stop.** Stop pressed during that capture ends the turn as `stopped` with no waiting state. An idle Stop while waiting changes nothing.
- **Logs.** The debug log records the category and the reason's length from the provider and controller. The reason itself appears where assistant text already does: the bridge frame log and the chat transcript.
- **Clients.** The app shows a help card (title from the category, the reason, Reply via the ordinary composer, Show screen when the help capture is the image on screen) and no Approve/Deny. The side panel sets a "Waiting for you" phase and a toast from `chat.done.help` (`helpNotice` in `remote-turn.js`).

The original design follows.

Add a small provider-registered `agent_request_help` control with strict arguments:

```json
{
  "reason": "What is blocking progress and what the user should do",
  "category": "login | captcha | permission | ambiguous | error | other"
}
```

The control emits a structured companion signal tied to the active turn and instructs the model to end its turn after the request. It does not inject a screenshot while another provider browser command is in flight. If the model continues working, notification waits for normal turn completion; there is no hidden pause/resume mechanism.

The remote turn states are `starting`, `idle`, `running`, `stopping`, `waiting_for_user`, and `error`; executor/model connection health is reported separately. On a help request:

1. Record reason/category in the active-turn journal; never put them into FCM.
2. Let the current model run finish normally.
3. Capture one best-effort help screenshot. A capture failure is reported as missing evidence, not as a failed task or a fabricated image.
4. Commit `chat.done` with help metadata, enter `waiting_for_user`, and notify subscribed devices.
5. On the next Android/desktop prompt, clear the help marker and run the same DSH session. Stop/new clear waiting state according to their actual lifecycle outcomes.

The APK may offer Reply, Show screen, Stop, and New chat. It must not show generic Approve/Deny buttons until the runtime has a real correlated approval request and continuation protocol.

### 4.8 Native Android application structure

Create `android/` as a standalone Gradle project with an `app` module, committed wrapper, versioned dependency catalog, and reproducible debug build. Suggested internal boundaries:

- `data/` — authenticated HTTP/WSS client, request IDs, retry/backoff, replay/resync, FCM registration;
- `state/` — immutable chat/turn reducer and stream/commit deduplication;
- `ui/` — Compose pairing/settings, chat, tool activity, connection health, screenshot viewer;
- `notifications/` — FCM receiver, local notification creation, deep-link handling;
- `diagnostics/` — redacted local diagnostics and connection failure details, without bearer/FCM/service-account secrets.

Use Android Lifecycle/ViewModel and Kotlin coroutines/serialization, OkHttp for HTTP/WebSocket, DataStore for small app settings, Android Keystore protection for the remote credential, and Firebase Messaging for push. Use normal Android trust managers and hostname verification; no trust-all certificate mode, cleartext traffic, or disabled certificate checks.

The first UI is deliberately small:

- pairing/server settings and token rotation;
- one shared chat with text/image composer, streamed answer, compact tool activity, and final/error state;
- Stop and New chat with server-confirmed state;
- companion/model/executor/Tailscale connectivity indicators;
- screenshot thumbnails plus full-screen pan/zoom;
- waiting-for-user banner and ordinary reply composer.

Plain text with preserved newlines is acceptable initially; a Markdown renderer, multiple session management, QR pairing, and rich reasoning/debug viewers are not prerequisites for acceptance.

The WebSocket is lifecycle-aware and reconnects while the app is usable. Android process death is handled through saved identifiers plus server replay/resync. Do not add a permanent foreground service to compensate for missing replay or push.

### 4.9 FCM notification design

**Implemented, never run against Firebase.** `companion/remote-push.mjs` and `android/.../notifications/` follow the design below. The payload is exactly the four keys shown, as strings. The Android side does not use `google-services.json`: it initializes Firebase from four values in an untracked `android/firebase.properties` (`projectId`, `applicationId`, `apiKey`, `senderId`), so a build without them still works with push off. The app validates that a message has exactly those keys before showing anything, uses generic notification text, shows nothing while the chat is on screen, and asks for the notification permission only from Settings. No Firebase project exists yet, so FCM delivery, the notification itself, the tap, token refresh, and screen-off behavior are all unverified.

Use FCM data messages through HTTP v1:

```json
{
  "type": "help | done | error",
  "turnId": "turn-…",
  "instanceId": "companion-run-…",
  "sequence": 123
}
```

Do not include prompt text, assistant text, help reason, page titles/URLs, screenshot bytes/URLs with credentials, bridge/remote tokens, API keys, or service-account data. `help` may use high priority; routine completion uses normal priority and is coalesced per turn/device. Invalid/unregistered FCM tokens are pruned without deleting chat state.

The Android `FirebaseMessagingService` validates the expected data shape and creates a local notification. Tapping it opens the chat with the referenced turn/sequence, performs an authenticated resync, and then fetches any screenshot. If Tailscale or the companion is unavailable, show that state explicitly; a delivered notification is not proof that the host is currently reachable.

Firebase configuration, Google service credentials, application signing keys, and release keystores remain local and ignored. The server push implementation is behind an interface so unit tests use a fake and a future UnifiedPush provider does not change chat/session logic.

### 4.10 Security and privacy requirements

- Keep `17871` and `17873` loopback-bound; expose only `17873` through tailnet-only Serve. Use ACL grants so only the phone/user can reach the host on TCP 443.
- Use a random remote token independent of the bridge token, constant-time comparison, bounded authentication failures, bounded request bodies, and strict route/method validation.
- Validate the expected Tailscale Host. Preserve normal TLS certificate and hostname validation on Android.
- Store remote tokens, push registrations, service credentials, and screenshot caches with least-privilege filesystem/app storage. Never commit them or include them in debug bundles.
- Treat screenshots, prompts, model responses, and FCM registration data as sensitive. Notifications are metadata-only by default.
- Rate-limit pairing failures, prompt submission, snapshot requests, and push registration. Bound queues, journals, image sizes/counts, and reconnect attempts.
- Remote commands share the existing exclusive turn/browser lifecycle. The remote API adds no second mutation path to the side panel and no weakening of stale-view/ambiguity/verification guards.
- Revoke a lost phone in Tailscale, rotate the remote token, delete its push registration, and rotate the FCM/service credentials if their exposure is suspected. The desktop bridge token need not rotate for an ordinary phone revocation.

---

## 5. Option D — Telegram adapter (optional alternative, not selected)

Telegram has convenient push, photo delivery, and inline buttons, and long polling works without inbound ports or Tailscale on the phone. Those advantages do not make it the chosen client: prompts, responses, and screenshots pass through Telegram's cloud.

If added after the native remote API exists, a small relay would authenticate to the same scoped `/remote/v1` API and use Telegram `getUpdates` long polling. It would map prompts to `POST /messages`, consume `/events`, fetch screenshot IDs through the authenticated binary route, and map explicit buttons to `/stop`, `/new`, or `/snapshots`. It would not connect as `ui`/`tools`, use a privileged bridge role, or invent Approve/Deny buttons without a real runtime approval protocol.

BotFather token rotation, a hard-coded numeric chat-ID allowlist, no groups, `0600` bot-token storage, bounded 1–2 s stream edits, and Telegram's 24 h update-retention limit remain necessary. Run the relay under the companion keep-alive regime (§12). Never send passwords/2FA through Telegram; use RustDesk. This adapter is deferred and has no acceptance evidence.

**Alternatives:** Discord (same architecture; note self-bots violate ToS), Signal via `signal-cli` (private but unofficial/ban risk), Matrix/Element (self-hostable, E2EE adds friction), WhatsApp Cloud API (business account + dedicated number + public HTTPS webhook + 24 h messaging window — highest effort).

---

## 6. Option E — ntfy/Pushover/Gotify or UnifiedPush (optional)

These are alternatives to FCM, not part of the selected initial build. A metadata-only watcher or companion hook can notify on committed turn completion/error and open a configured control surface. A log watcher alone cannot reliably infer the new structured `waiting_for_user` state, so it must not claim explicit help support by scraping arbitrary assistant text.

For the native APK, the cleaner non-Firebase alternative is a **UnifiedPush provider** behind `remote-push.mjs`, using a distributor such as ntfy where supported. Keep the same metadata-only payload, authenticated state/screenshot fetch, coalescing, and registration lifecycle as FCM. Do not replace this with a permanent background WebSocket.

Self-host ntfy/Gotify or use authenticated topics/services. Treat any prompt, response, page URL, or screenshot attachment as sensitive third-party content; the selected design sends none of them in push. Action buttons and deep links require explicit Android intent/app-link handling and a reachable Tailscale route, and are deferred until that provider is actually implemented.

---

## 7. Option F — Reuse the DSH web GUI for the browser agent (no extension code)

Idea: let DSH's web GUI be the remote chat UI while the side panel stays the executor.

```text
side panel (executor) ↔ companion --no-dsh (bridge only)
                            ↑ tools role
                  DSH web profile + browser-use + dsh-browser-extension
                            ↑
                     phone browser (Option B transport)
```

- The companion already supports **`--no-dsh`** ("bridge-only test mode") and still forwards `browser.command` frames from the `tools` role to the side panel. **[verified]**
- The browser-use provider gets its bridge URL/token from `DSH_BROWSER_BRIDGE_URL` / `DSH_BROWSER_BRIDGE_TOKEN` (env) via the profile patch. **[verified]**
- Composing `dsh --profile web --patch config/browser.patch.yml --dump-config` succeeds. **[verified]**
- **But it is not runnable as-is** **[verified by dsh-scout]**: the `web` profile's `node_modules` lacks `dsh-browser-extension` and `@deepseek-ai/dsh-browser-use` (and the global install lacks them too; only the repo has rc.2 versions). The patch was authored for `sdk-minimal`: it re-inserts `credentials-local` although the web base already mounts `credentials`, `sdk-jsonrpc-server` doesn't exist there, and `agent-loop agents: []` / `system-prompt` assume a host-plane agent while the web surface moves tools behind presets. You would need a **web-specific patch overlay**, profile-local plugin installs (`dsh plugin --profile web add …`), and a check that rc.2 provider tools register into rc.5 web preset scopes. Only one `tools` slot exists, so the companion must run `--no-dsh`; the embedded runner and the web server would otherwise flap every ~1 s.
- **Verdict:** ~1 day of careful, isolated prototyping (use an isolated `DSH_HOME`, not the live one). No new extension code, but a mode switch ("which DSH owns the browser") and a dense desktop layout on a phone. C/D produce a purpose-built phone UX; F is worth trying only if you specifically want full DSH sessions driving the browser.

---

## 8. Option G — SSH + tmux ops from the phone (complement)

Tailscale SSH (or regular SSH over the tailnet) with Termius / Blink Shell / Tailscale's own clients:

```sh
curl -s http://127.0.0.1:17871/health   # ok / ui / tools state
tail -f logs/companion.log              # what the agent is doing
npm run dev -- --new-token              # rotate pairing token
```

Useful for restarts, log reading, token rotation, and checking whether Edge/the panel is alive. It cannot see the side panel or push screenshots; pair it with A/B/C.

---

## 9. Option H — Public URL without a VPN: Cloudflare Tunnel + Access

If you do not want Tailscale on the phone (work phone, borrowed device):

1. `cloudflared tunnel login` → `cloudflared tunnel create dsh` → `cloudflared tunnel route dns dsh dsh.example.com`.
2. Ingress `hostname: dsh.example.com` → `service: http://127.0.0.1:3080`; `cloudflared service install` (outbound-only, no inbound ports, WebSockets supported, free tunnel).
3. Cloudflare Zero Trust → Access → self-hosted app on that hostname with an **Allow policy by email/IdP**; enable "Protect with Access" so the origin validates the JWT.
4. Start `dsh web` with `--trusted-host dsh.example.com --public-url https://dsh.example.com` so the proxied authority passes the fence.

**Rules:** never expose raw `17871` (the WS bridge token over plaintext is a full browser takeover); put TLS + identity auth in front of anything public; quick tunnels (`cloudflared tunnel --url …`) are for tests (random hostname, no uptime, no SSE). ngrok free is 1 GB/3 endpoints with a browser interstitial. Basic auth alone is single-factor — use it only as an extra layer.

---

## 10. Comparison

| Path | Available now | Prompt / stream | Screenshots | CAPTCHA/2FA takeover | Push notify | Cellular away | Security/privacy posture |
|---|---|---|---|---|---|---|---|
| A. RustDesk + Tailscale | Yes, phone test pending | Desktop typing | Live screen | Best | RustDesk app | Yes | Tailnet; Wayland lock-screen limits |
| B. DSH web over Tailscale | After restart/setup | General DSH chat only | Tool-result images | No | No | Yes | Tailnet, token + cookie |
| **C. Native APK + remote API** | **No; selected build** | **Native, shared browser-agent session** | **Existing/on-demand/help** | **Use A** | **FCM metadata** | **Yes via tailnet** | **Scoped token, binary fetch, no chat content in push** |
| D. Telegram adapter | No | Chat bot | Cloud photos | No | Yes | Yes without VPN | Numeric-chat allowlist; Telegram cloud content |
| E. ntfy/Pushover watcher | No | No | Attachment | No | Yes | Yes | Depends on topic/auth and attachment privacy |
| F. DSH web + browser profile | No | Full DSH sessions after compatibility work | Likely | No | No | Yes | Tailnet; provider/version complexity |
| G. SSH ops | Yes | No | Logs only | No | No | Yes | Strong; operations only |
| H. Cloudflare + Access | After setup | Same as B/C | Same as B/C | Same | Same | Yes without VPN | Good only with enforced Access/TLS |

---

## 11. Security checklist

- **The control surface can act as you in every logged-in site.** Treat phone access like full browser access: biometric/strong phone lock, short auto-lock, no shared devices.
- **Tailscale:** enable account 2FA; use ACL grants (for example, tag the host `tag:agent-host` and allow only the phone/user on `tcp:443`); approve devices and watch key expiry. Keep Node services loopback-bound, Serve only the remote listener, and never Funnel a controller.
- **Private bridge:** never expose `ws://…/bridge` or raw `17871` publicly or through the phone-facing Serve route. Its token is a bearer credential for privileged browser execution; there is no TLS, Origin enforcement, or rate limiting.
- **Remote API:** use the separate random remote token, constant-time comparison, Host validation, bounded bodies/messages, authentication throttling, and explicit route capabilities. The remote credential must never work as a `ui` or `tools` hello.
- **Android:** protect the remote credential with app-private/Keystore-backed storage, use normal certificate/hostname validation, disallow cleartext traffic, redact diagnostics, and require a device lock. Do not embed the credential in source/resources or log it.
- **FCM:** keep Google service credentials and signing keys outside Git with least-privilege access. Send metadata only, validate incoming message shapes on Android, and prune stale registrations. FCM delivery is not controller authentication.
- **DSH web token URLs:** bearer credentials; don't paste them into chats, screenshots, or issue trackers. The cookie is host/port-bound; restarting the server rotates the launch token (the cookie survives on the same host:port). Use `--trusted-host` only for the authority actually served.
- **Cloudflare:** only if H is deliberately added; enforce Access on the hostname and validate the JWT at the origin. Basic auth alone is not a substitute.
- **RustDesk:** strong dedicated password (not the OS password), connection 2FA, tailnet/self-hosted relay preferred; the standard Wayland build cannot take over the lock screen.
- **Telegram:** optional only; allowlist the numeric chat ID, don't add the bot to groups, protect the bot token (`0600`), and never send passwords/2FA through it.
- **ntfy/Pushover:** optional only; self-host or use authenticated topics and assume any included page content/attachment leaves the host.
- **Screenshots/logs:** `.dsh-home/browser-agent/logs` has redactions but still contains page content and paths. The remote screenshot cache and debug ZIPs are sensitive; use bounded retention and never expose path-based file reads.
- **Rotation:** `--new-token` rotates the existing companion/provider/panel pairing token. The proposed `--new-remote-token` rotates only Android remote access. Revoke a lost phone in Tailscale and delete its FCM registration as separate, explicit operations.

---

## 12. Keep-it-alive checklist (the part that actually breaks)

Remote control only works if all three stay alive: **machine awake → Edge running → companion running.** The side panel no longer has to be open: with none open, the extension's service worker is the executor (`extension/background-executor.js`).

1. **Companion: run it as a user service, not as a child of a terminal/app.** Today it is spawned under Kimi Code (`scripts/dev.mjs … >> logs/companion.log`); if that app closes, the companion dies. Suggested `~/.config/systemd/user/crazyagent.service` with `Restart=always` and `loginctl enable-linger conan` so it survives logout/reboot. Add this only after the remote configuration is stable, and never restart the service during a live task.
2. **Edge:** keep Edge running. An open panel is the preferred executor; otherwise the service worker connects on browser start, stays alive with a 20 s ping, and returns within about 30 s through an alarm if Chrome stops it. If neither is connected, browser tools error with `SIDE_PANEL_CLOSED` after the grace window. The worker works in the last-focused normal window, and system-clipboard operations (including Docs rich and table paste) need an open panel.
3. **Do not suspend:** on AC this machine already uses `sleep-inactive-ac-type='nothing'` **[verified]**. Check the battery policy and, for a laptop, lid-close behavior; closing the lid may suspend everything until reopened.
4. **Screen lock:** the agent can keep receiving page-level views while locked; remote desktop may not. The native remote API works while locked as long as the companion/executor remain alive **[needs test]**.
5. **Phone health:** `/health` remains loopback-only. The proposed authenticated `/remote/v1/state` includes UI/tools/model status. Surface `uiConnected:false` prominently; a healthy companion does not imply browser actions can run.
6. **Tailscale/FCM are different paths:** FCM may deliver a metadata notification while Tailscale is disconnected, but chat/screenshot retrieval then fails until Tailscale reconnects. Test Android VPN battery behavior rather than disabling security or adding a permanent foreground WebSocket.
7. **Network loss at home** means no remote control; no app can fix that. Keep RustDesk/SSH as alternatives only when the underlying network is available.
8. **Token rotation:** existing `--new-token` requires re-pairing the panel/provider. The proposed remote-token rotation requires re-pairing Android clients only. FCM token refresh is automatic through device registration and must not rotate controller credentials.

---

## 13. Detailed implementation plan

### 13.1 Delivery rules

- Land one observable milestone at a time. Do not start Android polish, screenshots, help, and push before the core protocol has a passing fake-server contract.
- Before each milestone, record the relevant existing behavior and cheapest regression gate. Afterward, rerun the same scenario from the same initial state.
- Unit/integration tests never spend model tokens. Use fake DSH notifications, fake UI/tools sockets, a fake push provider, and an Android fake remote server.
- Direct protocol/executor tests are not real-model acceptance. Final real-agent comparisons use medium effort and independently inspect browser state, including failed calls and recovered mistakes.
- Keep remote access opt-in. Existing `npm run dev` behavior remains unchanged unless remote flags/configuration are supplied.
- Update this document's status and evidence per milestone. Do not write "verified" from a successful tool result, notification delivery, APK launch, or assistant claim alone.

### 13.2 Milestone 0 — reproducible Android/toolchain and external prerequisites

**Status (2026-11-06): host/toolchain items 1–4 done; Tailscale Serve connectivity works; least-privilege ACL review, Firebase, and RustDesk remain pending.**
- The toolchain is installed under `~/Android` (see "Immediate setup").
- `android/` is scaffolded with a committed wrapper and a version catalog, and its `.gitignore` covers outputs, `local.properties`, keystores, and `google-services.json`.
- The `npm test` baseline before Milestone 2 was 858/858.
- The gate's `./gradlew assembleDebug testDebugUnitTest lintDebug` passes.
- The debug APK is installed on the physical phone, and Tailscale HTTPS/cellular control is verified. A dedicated ACL grant and the Firebase/RustDesk setup are not complete.

**Host/toolchain work**

1. Install Android Studio/SDK with its bundled JDK, platform tools, emulator/platform packages as needed, and `adb`. No system-wide Gradle is required.
2. Scaffold `android/` with an `app` module, Kotlin, Jetpack Compose, API 26 minimum, a committed Gradle wrapper, and locked/versioned dependencies. Select AGP/Kotlin/SDK versions supported by the installed Android Studio rather than copying unverified latest versions.
3. Add local Android outputs/configuration to `.gitignore`: `.gradle/`, `local.properties`, module `build/`, signing keystores, local Firebase configuration, and IDE state as appropriate. Do not ignore the Gradle wrapper or its verification metadata.
4. Record `npm test` and current companion `/health` as the pre-change baseline. Do not infer a connected panel from an old document snapshot.

**External setup**

5. Confirm Tailscale MagicDNS and HTTPS certificates for `conan-expertbook.tail11f47e.ts.net`; inspect existing Serve configuration and configure the future ACL grant. Reserve the remote HTTPS authority/port (normally 443, or an explicit alternative such as 8443 if the optional DSH GUI already occupies 443). Do not overwrite an existing GUI route, expose `17871`, or start a Serve route to a nonexistent/unauthenticated `17873` listener.
6. Create a Firebase project and register the Android application ID. Keep `google-services.json` local. Create least-privilege service credentials for FCM later; never paste private keys into chat, source, issues, or screenshots.
7. Configure RustDesk unattended access and test the physical phone on cellular. Record Wayland lock-screen behavior before relying on takeover.

**Gate**

- `./gradlew assembleDebug` produces the starter APK and `./gradlew testDebugUnitTest lintDebug` runs successfully.
- A physical phone installs/launches it through `adb`; this verifies distribution only, not agent control.
- Tailscale certificate/ACL prerequisites are confirmed without exposing `17871` or a placeholder controller.

### 13.3 Milestone 1 — authenticated companion remote API and replay

**Status (2026-11-06): implemented; gates 1–3 met.** Behavior is documented in §4.5.1.

- Baseline before the change: `npm test` 807/807, and live `/health` `{ok:true,ui:false,tools:true}`. The live companion was not restarted.
- After the change: `npm test` **852/852**. The 45 new tests are in `companion/test/remote-hub.test.mjs`, `remote-token.test.mjs`, `remote-server.test.mjs`, and `session-controller.test.mjs`, with shared fakes in `remote-fixtures.mjs`. The integration tests use the real `Bridge`, a fake panel and provider socket, two remote clients, and a fake DSH runner. No model, network, or FCM is involved.
- Isolated smoke run (`--no-dsh --port 17881 --remote --remote-port 17882` with a scratch `--dsh-home`, real Node `fetch`/`ws` client):
  - Without `--remote`, the remote port was closed.
  - With it, both listeners bound to `127.0.0.1` only.
  - `/state` returned `401` without a token and `200` with it.
  - `/bridge` on the remote port returned `404`.
  - A message returned an honest `503 RUNTIME_NOT_READY`, and an idle stop returned `200 idle`.
  - `/events` replayed `1:remote.health, 2:chat.status`.
  - Running `--new-remote-token` from a second process made the old token `401` and the new one `200` within 2.5 s, and closed the open stream with `4401`.
  - The token appeared in neither startup output nor the debug logs.
- Panel follow-up (phone prompts shown in the panel): `npm test` **858/858**. `scripts/ui-preview.mjs --scenario remote` passes in an isolated Edge profile with the real extension page and a mock bridge, and the `queue`, `slash`, and `turn` scenarios still pass.
- Real runtime/model and Serve acceptance:
  - A medium-effort remote-API prompt opened `/acceptance-local-7f3c` on a local fixture in a new tab. The fixture independently logged the actual `GET` and the completed turn reported the matching title. This was a real DSH/model/browser run, not a scripted reply.
  - `tailscale serve status` shows `https://conan-expertbook.tail11f47e.ts.net` as **tailnet only**, proxying `/` to `http://127.0.0.1:17873`. Unauthenticated `/state` returns `401`, authenticated HTTPS state reports `uiConnected:true`, `toolsConnected:true`, and `dsh:"ready"`, and `/bridge` through the same authority returns `404`.
  - The real APK submitted `/acceptance-usb-9a4b` through the phone UI over a temporary `adb reverse` diagnostic route. The fixture logged one `GET`; the phone recovered the completed projection after force-close/relaunch without another prompt.
  - For `/acceptance-cellular-6e8f`, the APK paired through the Tailscale hostname and Wi-Fi was disabled during the real turn. Android reported mobile NR as the active default network with the Tailscale VPN using it as the underlying network. The phone showed the final result, `/state` contained exactly one `chat.user` for the turn, and the fixture logged exactly one matching `GET`. Wi-Fi was restored afterward.
- Remaining limits: these were focused successful scenarios, not repeated reliability runs. The live docked panel stayed connected but its rendering was not independently inspected. A separate least-privilege ACL review, real-companion Stop/New/token-rotation runs, and screenshots/help/push remain pending.

**Companion implementation**

1. Add opt-in CLI/configuration: `--remote` (enable), `--remote-port` (default `17873`), `--remote-public-host` (expected Tailscale authority), `--pair-remote` (explicit once-only pairing output), and `--new-remote-token` (rotate/revoke). Bind remains `127.0.0.1`; there is no `0.0.0.0` mode.
2. Implement remote-token generation/storage with `0600`, redaction, and a pairing flow that does not print it during every startup. Ensure `.dsh-home` and logs never serialize it.
3. Extract chat/new/stop into a shared session controller without changing DSH runner count, existing stop behavior, or UI browser-command routing.
4. Add the explicit allowlisted chat broadcaster and RemoteHub journal/projection. Existing side-panel frames retain their behavior; no browser command is copied to remote subscribers.
5. Implement `/state`, `/messages`, `/stop`, `/new`, and `/events` from §4.4, including structured errors, request IDs, body limits, and graceful shutdown.
6. Implement per-process instance IDs, sequence/replay/resync, live-event buffering during replay, bounded idempotency results, atomic turn reservation, busy `409` behavior, and explicit unknown/stale state after companion restart.
7. Expose UI/tools/model health through authenticated state. A remote turn with no connected panel follows existing failure semantics; the API does not hide it behind a generic ready status.
8. Add remote shutdown cleanup: close sockets, reject/complete pending requests deterministically, remove subscriptions, and leave UI/tools/browser state owned by their existing paths.

**Tests**

- `companion/test/remote-server.test.mjs`: valid/invalid/missing bearer tokens, Host/method/route validation, payload limits, malformed JSON, CORS-independent native requests, unknown screenshot/push routes, and listener shutdown.
- `companion/test/remote-hub.test.mjs`: instance changes, event ordering, bounded replay, expired-sequence resync, aggregated drafts, committed-message replacement, duplicate command IDs, concurrent/atomic busy conflicts, help/status placeholders, and subscriber cleanup.
- Existing bridge tests: prove a second `ui` is still the only replacement path, remote clients never receive/send browser commands, tools results still correlate to the correct caller, and side-panel reconnect grace is unchanged.
- Integration with fake runner/UI/tools: two remote clients plus the panel see one accepted turn even with simultaneous submissions; dropped response followed by the same client message ID starts zero additional turns; stop/new follow real lifecycle events.

**Gate**

- `npm test` passes, including all pre-existing contracts.
- An isolated companion with remote enabled passes real HTTP/WSS calls from a Node client; with remote disabled, `17873` is closed and existing startup is unchanged.
- Tailscale Serve proxies only `17873`; unauthenticated/incorrect-token requests fail, and `17871/bridge` is not reachable through that Serve authority.

### 13.4 Milestone 2 — native APK pairing, chat, stop/new, and reconnect

**Status (2026-11-06): implemented; the Gradle gate passes; physical-phone scenarios passed against both the scripted companion and the real companion/model over USB and Tailscale HTTPS, including a Wi-Fi → cellular transition.** Code and instructions are in `android/` (`android/README.md`).

What exists:
- **App:** `dev.crazyagent.remote`, Kotlin with Compose Material 3, `minSdk` 26, `targetSdk` 36, `compileSdk` 37, AGP 9.5.1, Kotlin 2.4.21, OkHttp 5.5.1.
- **Pairing:** pairing checks the HTTPS address and the 64-hex token against an authenticated `/state` before saving.
  - The token is encrypted with an Android Keystore AES-GCM key in DataStore and excluded from backups.
  - "Pairing and token…" replaces the token; "Forget pairing" deletes it.
  - Release builds are HTTPS only. Debug builds also allow cleartext to the phone's own loopback, for `adb reverse` to a fake companion.
  - The activity window is excluded from autofill (`IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS` on the decor view), so password managers such as Samsung Pass do not offer to save the token.
- **Client:** `RemoteApi` sends bearer HTTP. The `/events` WebSocket resumes with `instance`/`after`. A gap, a draft-offset gap, or a different instance forces a full resync. Reconnects use bounded exponential backoff with jitter (0.25–30 s), and a network change triggers an immediate retry.
  - Close `4401` or HTTP `401` means the token was revoked or rejected. The app then stops reconnecting until the user re-pairs.
  - HTTP `421` or `404` shows an address problem, including the `--remote-public-host` hint.
  - Events stream only while the app is visible (`repeatOnLifecycle(STARTED)`). There is no foreground service.
- **Reducer:** `ChatReducer` is pure and immutable. It applies each sequence exactly once, ignores duplicates and repeated draft deltas, and replaces a draft with the commit that names it in `replacesStreamId`. `chat.turn` is authoritative for the end of a turn, `chat.session` clears the chat, and malformed frames are counted, not applied.
- **Sending:** sends use client UUIDs.
  - If the request provably never left the phone (DNS failure, refused connection, or TLS failure), the prompt goes back into the composer. A `409` refusal also puts it back, with the server's message.
  - If the result is uncertain, the app first checks the live events and `/state` for `chat.user.clientMessageId`. It then retries with the **same** ID, at most 3 times. After that, or after a companion restart, the prompt needs user review: Retry (same ID), Send again (a new ID, user-initiated only), Edit, or Discard.
  - The pending prompt's ID, text, image count, and instance are kept encrypted across process death. Image bytes are not, so a pending prompt with images needs review after a process restart.
- **Chat UI:**
  - a shared transcript (prompts from the phone and the desktop panel, the streamed draft, tool rows that expand, and done, stop, and error notes);
  - an activity line;
  - up to four images from the photo picker, re-encoded to JPEG at ≤2048 px when over 5 MB or in an unsupported format;
  - Stop, and a New chat with confirmation;
  - indicators for the companion link, the model runtime, the browser panel (`uiConnected`), and the browser tools;
  - a native version of the side panel's fixed dark/yellow visual style, compact utility bar, activity feed, and rounded composer, with full-screen Settings and Diagnostics panels;
  - a context ring driven by the real `contextTokens / contextWindow` ratio, with exact values on tap;
  - recent-session cards, searchable history, and read-only canonical transcripts from authenticated `/sessions` routes;
  - native Markdown rendering for assistant responses and drafts, including emphasis, safe links, lists, headings, quotes, code blocks, and tables;
  - a blank empty view (apart from recent sessions) and `/new`, `/model`, `/plan` composer commands with single-token filtering and guarded execution. `/model` opens read-only model details; `/plan` explicitly arms one remote turn and survives pending/retry delivery;
  - the extension's yellow cursor with safe margins in adaptive and legacy launcher icons. Model administration, live DSH session switching, screenshots, and log export are not invented where the scoped remote API has no corresponding capability.

Evidence:
- **Gradle gate:** `./gradlew testDebugUnitTest lintDebug assembleDebug` passes with **45 JVM tests passed, one opt-in live-server test skipped, and 0 lint findings**. The history controller test loads a saved transcript without changing live chat, and Markdown tests cover block parsing, inline styles, native links, and unmatched markers.
  - **Contract fixtures:** `ReducerFixtureTest` replays frames recorded from the real `RemoteHub` (`scripts/remote-protocol-fixtures.mjs`), covering a streamed turn, a mid-draft resync, and stop, error, health, and new session. It must reach the hub's own final projection, also after a duplicate replay. `companion/test/remote-protocol-fixtures.test.mjs` makes `npm test` fail when those fixtures are stale.
  - **Controller tests:** `RemoteControllerTest` runs against `FakeCompanion` (MockWebServer). It covers auth headers and JSON bodies, a busy refusal putting the prompt back, a lost acceptance resolved through events or `/state` without a resend, a lost request retried only with its original ID, an uncertain send across a companion restart (left for review and never resent), and reconnecting mid-turn with the right `instance`/`after`. It also covers a forced resync after a sequence gap, a revoked token (`4401`) with no further reconnects, `401` on upgrade, backoff after `503`, stop and new following real lifecycle events, process recreation, and read-only saved history.
- **Real-server check:** `LiveFakeCompanionTest` ran the Kotlin `RemoteController` against the real Node `RemoteServer`, `RemoteHub`, and `SessionController` through `scripts/fake-remote-companion.mjs`. It paired, sent, streamed drafts, received a tool call/result and done, stopped a slow turn mid-stream, and started a new chat. It is opt-in and needs `CRAZYAGENT_FAKE_URL` and `CRAZYAGENT_FAKE_TOKEN_FILE`.
- **Node tests:** `npm test` is **867/867**, including context metrics, saved-history persistence/API behavior, protocol fixtures, and the fake companion.
- **Latest phone limitation:** the context/history/Markdown/service-update pass did not use ADB or install the new APK on a phone. Earlier phone evidence below remains valid for the prior UI; the newest screens still need visual/interaction acceptance when phone debugging is available.
- **Physical phone (2026-11-06):** a Samsung SM-S937W on Android 17 (API 37) ran the debug APK against `scripts/fake-remote-companion.mjs` through `adb reverse tcp:17883`. The phone was driven over `adb` and checked with screenshots and `uiautomator` dumps; the fake's own `/state` was the independent check.
  - **Pairing:** pairing passed. The token field is masked.
  - **Send and stream:** the phone rendered the "You · phone" bubble, the streaming draft, the tool row, the committed reply, and "Done · fake/scripted". The server recorded exactly one `chat.user` and turn outcome `done`.
  - **Stop:** Stop during a slow turn showed "Stopped by user."; the server recorded outcome `stopped`.
  - **Force-close mid-turn:** after `am force-stop` mid-turn and a relaunch, the draft resynced (step 9 of 30) and streaming continued with Stop available. The turn then finished `done` with exactly one `chat.user` on the server.
  - **Companion outage and restart:** when the companion went away, the app showed "Companion reconnecting" with a Retry banner and disabled the composer. After a restart (new instance) it reconnected by itself through its own backoff and showed the "companion restarted" notice.
  - **New chat:** New chat asked for confirmation; the server moved to `fake-session-2` and the phone's chat cleared.
  - **Token rotation:** after `--rotate`, the stream closed with `4401` at the next heartbeat. The phone showed "Token rejected" with "Pair again" and opened no further connections. Re-pairing with the new token worked, with the address prefilled.
  - **Fixed during the run:**
    - Samsung Pass offered to save the token as a password; the window is now excluded from autofill, and a re-pair produced no prompt.
    - The re-pair address showed a trailing `/`; it is now trimmed.
    - "slow" fake turns took ~13 s instead of the documented ~40 s; they now take ~40 s.
    - **Connection loop sometimes never started.** About 2 launches in 15 sat on "Companion paused" and never connected. The network callback's `onAvailable` ran on `ConnectivityThread` and read the lazy `by viewModels()` property while the main thread first touched it. That created a second `MainViewModel`, and its store replacement cancelled the first one's startup. The run-loop collector was left on the cleared instance at `Loading`, while the UI showed the other instance's never-run controller. Diagnostic logs showed the second constructor on `ConnectivityThread`. The fix creates the ViewModel in `onCreate` and registers the callback with a main-looper `Handler`. Afterwards, every launch that reached the front connected (18/18 install-and-launch cycles); launches that Play Protect's scan prompt or the launcher covered were not counted.

Real companion/model acceptance (medium effort, local independent fixture):
- A phone-UI prompt over `adb reverse` opened `/acceptance-usb-9a4b`; the fixture logged the actual `GET`. Force-close/relaunch restored the completed projection with one prompt and no duplicate submission. The real in-flight draft resync was already covered by the scripted run above, not re-proven here.
- HTTPS pairing to `https://conan-expertbook.tail11f47e.ts.net` succeeded after Serve was enabled. The USB reverse route was removed, and a second phone-UI prompt requested `/acceptance-cellular-6e8f`.
- Wi-Fi was disabled during that turn. Android's active default network became mobile NR, with `VPN:com.tailscale.ipn` using that mobile network as its underlying transport. The app showed the final response, `/state` had exactly one `chat.user` for the turn, and the fixture logged exactly one matching `GET`. Wi-Fi was then restored.
- The sidebar-style debug APK was installed over the existing pairing on the same phone. Independent screenshots/UI dumps covered the chat, expanded tool details, Settings, Diagnostics, New chat cancellation, pairing cancellation, and the yellow-cursor launcher icon. A real no-tool phone prompt returned the exact committed response `SIDEBAR_UI_OK`; cancelling re-pairing preserved the connection and transcript. This was a focused visual/interaction check, not Compose instrumentation or repeated reliability acceptance.

Not yet evidenced:
- Repeated real-companion reliability scenarios, real-companion Stop/New/token rotation, and independent visual inspection of the live docked panel.
- Compose or instrumented tests. Images from the photo picker, the needs-review card, and accessibility labels were not exercised on the phone.
- Screenshots, help, push, signed release, and persistent companion service operation.

**Android implementation**

1. Implement pairing/settings with Tailscale HTTPS URL, remote token, validation, token replacement, and explicit forget/unpair. Protect stored credentials and never include them in logs or screen-share diagnostics.
2. Implement the authenticated HTTP/WSS client, protocol versioning, timeouts, bounded exponential reconnect with jitter, and resync on app resume/process recreation.
3. Implement the immutable reducer for `state`, canonical events, streamed drafts, committed assistant replacement, lifecycle, errors, and health. Reducer tests use only sequence/fixture inputs, not Android rendering screenshots as an oracle.
4. Implement the Compose chat: text plus up to four valid images, response/tool activity, busy/disabled states, Stop, New chat, and clear model/executor/Tailscale errors.
5. Generate client UUIDs locally. On an uncertain HTTP result, query state/retry with the same ID; never generate a new ID automatically. After companion restart/stale state, require user review rather than auto-submitting.
6. Implement WSS lifecycle independently from FCM. Backgrounding does not claim continuous streaming; reopening performs replay/resync.

**Tests and inspection**

- JVM tests: reducer ordering, gaps/resync, delta/commit dedupe, duplicate command handling, malformed frames, authentication failure, and status transitions.
- Fake-server HTTP/WSS tests: request headers/bodies, timeout/backoff, lost acceptance response, reconnect during a turn, token revocation, and process-recreated identifiers.
- Compose/instrumented checks where supported: pairing validation, busy controls, error presentation, attachment removal, and accessibility labels. No test connects to OpenRouter.

**Gate**

```sh
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Install `app/build/outputs/apk/debug/app-debug.apk` on the physical phone. Against the fake companion, pair, send/stream, stop, start a new chat, rotate the remote token, force-close/reopen mid-turn, and switch Wi-Fi/cellular. The phone and desktop projection must agree without a duplicate prompt.

### 13.5 Milestone 3 — mirrored and on-demand screenshots

**Status (2026-11-10): implemented.** Items 1–3 and 5–6 exist (item 3 uses detail `normal`, not `fast`, so the image stays readable when zoomed on a phone). Gate: the Node and JVM tests cover authorization, binary integrity, cache bounds, busy refusal with no browser command, a disconnected panel, an image-less page, an unsupported image type, rate limiting, and eviction. A real idle capture through the real side panel returned a 1280×897 JPEG of the active tab in 1.1 s and replayed for the same client ID. Not done: comparing executor bytes with what the APK displays, `edge-capture-e2e.mjs`, and any look at the phone.

**Server work**

1. Observe actual image-bearing `browser.result` frames and emit screenshot metadata through RemoteHub. Preserve provider result correlation and LogStore redaction; do not forward base64 through ordinary chat events.
2. Implement bounded binary storage and authenticated `/screenshots/{id}` reads. Test eviction, missing files, stale IDs, MIME/size mismatches, and restart cleanup.
3. Implement `/snapshots` with `bridge.requestUi({op:'snapshot',args:{detail:'fast'}}, 'auto', 15000)`, serialization, no UI when disconnected, and `TURN_BUSY` plus latest image during active work.
4. Add no automatic per-turn screenshot unless a later explicit setting enables it. Help capture remains Milestone 4.

**Android work**

5. Render metadata thumbnails without holding every full image in memory; fetch binaries on demand, decode with bounds, and provide full-screen pan/zoom and content descriptions.
6. Show capture age/source and stale/evicted states. A thumbnail or successful HTTP response is not evidence that the requested browser task succeeded.

**Gate**

- `npm test` and Android tests cover authorization, binary integrity, cache bounds, busy capture refusal, disconnected UI, malformed images, and eviction.
- In an isolated real-extension fixture, independently compare executor capture bytes/metadata with the APK-displayed image and verify no additional browser command occurs during busy refusal.
- Run the relevant capture regression (`scripts/edge-capture-e2e.mjs` when its isolated profile prerequisites are available) without changing focus/minimize behavior.

### 13.6 Milestone 4 — explicit waiting-for-user help and reply

**Status (2026-11-10): implemented; one real scenario passed three times after a real failure.** Fake-runner tests cover each transition, missing captures, stop during capture, duplicate and malformed signals, a signal for another turn, new-chat behavior, and reply idempotency. The provider test drives the registered tool over a real WebSocket and checks that it sends no browser command. Real runs: see the AGENTS.md snapshot (run 1 failed on the frozen `turn/end` event; runs 2–4 passed with fixture-log and screenshot evidence, the reply continued the same session, and new-while-waiting cleared the request). Not done: the app's help card on a phone, the side panel's notice (needs an extension reload), and a blocker the model must discover without being told credentials are missing.

**Provider/companion work**

1. Register the strict `agent_request_help` control described in §4.7 and update model guidance/tool documentation. Validate category, nonempty bounded reason, and active-turn association.
2. Carry the structured request through the provider/companion rather than final-text regexes. Avoid secret-like reason content in logs/notifications where possible; redact diagnostics as ordinary sensitive assistant content.
3. At normal run completion, perform one serialized best-effort help snapshot, commit help metadata, publish `waiting_for_user`, and retain the same DSH session.
4. Define all transitions: normal done → idle; help done → waiting; next prompt → running with help cleared; stop → actual stopping/stopped state; new while running/stopping → conflict; new while waiting → fresh session; screenshot failure → waiting with `screenshotId:null` and capture error metadata.
5. Ensure the desktop panel and APK both receive the waiting/help projection. No UI invents an approval request from this state.

**Android work**

6. Show the waiting banner, reason/category, optional screenshot, and ordinary reply composer. Replies use the same idempotent `/messages` path and session; there is no separate unauthenticated "continue" endpoint.

**Gate**

- Fake-runner tests cover every transition, missing screenshots, stop during capture, duplicate help signals, disconnected UI, new-session behavior, and reply idempotency.
- A direct executor/provider fixture proves the wire shape and zero browser commands after turn quiescence. This is not yet model acceptance.
- Run one fresh medium-effort real-sidebar help scenario and independently inspect the browser/page state, reason, capture, and same-session reply before marking the behavior live-verified.

### 13.7 Milestone 5 — FCM registration, screen-off push, and deep links

**Status (2026-11-10): implemented against fakes only.** Server items 1–4 and Android items 5–7 exist. Unit/integration tests with a fake provider verify the exact payload keys, the absence of prompt/answer/reason/token text, one push per turn and device, retry classification and bounds, pruning, registration bounds, and the refused states; JVM tests verify payload validation, registration states, and the notification-tap resync. **Nothing in the physical-device gate has been run, and item 8's conditions are untested, because there is no Firebase project.** To enable: create the Firebase project and Android app (`dev.crazyagent.remote`), put its four values in `android/firebase.properties`, save a service-account key as `.dsh-home/browser-agent/fcm-service-account.json` (`0600`), rebuild the APK, and restart the companion.

**Server work**

1. Implement device PUT/DELETE registration, app/device metadata bounds, token replacement, authenticated revocation, and a least-privilege local credential path.
2. Implement the fakeable push interface and FCM HTTP v1 provider with supported Google authentication, bounded retries/timeouts, invalid-token pruning, and per-turn/device coalescing.
3. Publish help/done/error metadata only after the corresponding canonical state is committed. Do not push transient tool calls, every text delta, or a state the phone cannot subsequently retrieve.
4. Record delivery status/error category without logging FCM tokens, prompts, help reasons, page content, or service credentials. A push success response proves delivery to FCM only, not Android display or host reachability.

**Android work**

5. Integrate Firebase Messaging, handle token refresh, register/unregister through the authenticated API, and validate received data types/lengths/turn references.
6. Create notification channels: high-importance help and ordinary completion/error. Do not bypass user notification settings.
7. On tap, open the target chat/turn, resync through Tailscale, and fetch the screenshot by opaque ID. If content is stale/evicted or Tailscale is down, show the actual condition rather than an empty success view.
8. Test notification permission denied, FCM unavailable, token refresh, revoked remote token, logged-out/unpaired app, battery saver, app force-stop, and Tailscale disconnected. Do not claim reliable delivery under conditions Android/FCM explicitly does not support, such as after a user force-stops the app until it is reopened.

**Gate**

- Unit/integration tests with fake FCM verify exact payload keys, absence of sensitive content, coalescing, retry classification, pruning, and deep-link validation.
- On the physical device over cellular, verify help with screen off and app swiped away (not force-stopped), normal completion, notification tap, state resync, screenshot fetch, and reply.
- Repeat help notifications enough to identify duplicate/coalescing bugs; inspect Android notification state and fetched content independently of companion logs.

### 13.8 Milestone 6 — full physical-phone and real-agent acceptance

Use a fresh isolated browser profile, the real unpacked extension/provider/executor, a configured test model at **medium effort**, and the real APK on the physical Android device. Keep test credentials/user data isolated. Do not run these cases in unit tests.

| Scenario | Actions | Independent acceptance evidence |
|---|---|---|
| Remote prompt/result *(single runs passed, §13.4)* | Start from the same known fixture; submit one phone prompt that changes a specific page value/target. | Inspect resulting page/application state outside the tool result and assistant response; record wrong targets, retries, collateral edits, wall time, steps, and tool calls. |
| Desktop + phone sharing | Watch the same turn from side panel and APK; submit from alternating clients only while idle. | Same canonical session/turn/messages on both; executor stays connected; no second DSH runner or duplicated prompt. |
| Stream/reconnect | During a streamed turn, switch networks, background/force-close/reopen the app, and resume after a short offline period. | Ordered replay or explicit resync, one committed answer, no gap falsely presented as complete, no duplicate submission. Repeat important runs. |
| Lost command response | Inject/test a lost HTTP acceptance response in the fake integration suite, then perform the corresponding real reconnect scenario. | Fake suite proves one execution for one UUID; real client surfaces authoritative state and never silently repeats uncertain work after companion restart. |
| Stop and new | Stop a real running turn, wait for actual stopped state, then send and create a new chat. | Runner/session lifecycle and UI state agree; no late old-turn events overwrite the new projection. |
| Screenshot paths *(API-level only: a real idle capture passed; busy/evicted paths are fake-tested; nothing on the phone)* | Mirror an agent capture, request an idle screenshot, request one during active work, and open an evicted/unknown ID. | Correct independent image/state; busy request adds no executor command; missing/evicted content is explicit. |
| Help → push → reply *(help → reply passed 3 real runs through the API without a phone; push unrun)* | Trigger a genuine blocked task with screen off/app swiped away; open notification, inspect reason/screenshot, and reply. | Real waiting state, metadata-only FCM payload, correct current host content, and same-session continuation. Independently inspect final browser outcome. |
| Executor unavailable | Close/disconnect the side panel and attempt a browser task/screenshot. | APK reports `uiConnected:false` and actual failure; no success notification based only on model text. Reopen through the panel/RustDesk. |
| Locked/minimized host | Run a view-dependent task with host locked or browser minimized. | Page-level captures continue where supported, no focus theft, and remote state matches independently inspected images/state. |
| Revocation/lost phone | Delete push registration, rotate remote token, and revoke the Tailscale device as separate tests. | Old phone cannot reconnect/register/fetch screenshots; desktop panel/provider continue after remote-only rotation. |

Repeat important prompt/help/reconnect scenarios at least three times from identical initial state before calling them reliable. A single lucky run is not reliability evidence. Preserve records of partial completion and repaired errors.

### 13.9 Milestone 7 — release packaging, service setup, and documentation

1. **Done locally (2026-11-10):** `android/keystore.properties` and `android/release.jks` (both git-ignored, `0600`) hold a locally generated RSA 4096 key; `./gradlew assembleRelease` produces `app/build/outputs/apk/release/app-release.apk` (version 0.4.0, code 3), and `apksigner verify` accepts its v2 signature (signer certificate SHA-256 `dae7cf347a740b7b56acf3c15191cad806a5691c7584c1b422dc610bbd88870a`). Losing that key means a future release cannot update an installed one. Configure release signing locally before producing the release artifact; never commit the keystore/passwords. Then run `npm test`, relevant isolated extension/executor regressions, and:

   ```sh
   cd android
   ./gradlew clean testDebugUnitTest lintDebug assembleDebug
   ./gradlew assembleRelease
   ```

   Add `connectedDebugAndroidTest` when a real emulator/device target is configured; do not claim instrumentation coverage from JVM tests.

2. The signed release APK is `dev.crazyagent.remote` version 0.4.0, code 3, protocol 1, SHA-256 `f08eadce79b61adeaadb5aad20f6d50a0cfb23875808ccdf59115fbcb082b3ed`; `apksigner verify` accepts it. Verify signing and install the exact release APK, not only the debug build, on the physical phone. **Not installed yet:** the phone has the debug-signed build, so the release APK needs an uninstall first, which deletes the pairing. The APK's own hash changes with every build; the certificate digest above is the stable identity.
3. **Persistent service implemented on this host:** `config/crazyagent.service` and `~/.config/systemd/user/crazyagent.service` run the companion with `--remote`, restart it on failure, and use the saved model configuration. The unit is enabled, `Linger=yes`, and the idle companion was gracefully moved into the service. Local `/health` returned `ok:true`, and local/Tailscale remote state returned the expected unauthenticated `401` through the unchanged tailnet-only Serve rule. AC suspend is disabled; battery suspend remains enabled. A real reboot was not performed. After login/restart, Edge and the side panel must still be opened for browser execution; the service cannot open the panel itself.
4. Update `README.md`, this document, `HANDOFF-QUICK.md`, and the applicable `AGENTS.md` behavior snapshot in the same changes that add behavior. Document actual test evidence and remaining limitations; do not leave proposed commands described as existing.
5. Remove temporary test users/devices/registrations and generated artifacts not required for delivery. Keep release output and signing material out of Git unless the user explicitly chooses another distribution mechanism.

### 13.10 Explicitly deferred

- Durable cross-restart live-chat restoration and automatic recovery of uncertain pre-restart submissions (bounded read-only transcript history is implemented separately);
- interactive mid-turn questions, correlated approve/deny, and pause/resume;
- multiple concurrent turns, multiple DSH runners, live switching between DSH sessions, or remote model/API-key administration;
- remote arbitrary browser commands, remote debug-log export, and arbitrary filesystem access;
- continuous screen streaming or a custom remote mouse/keyboard implementation (use RustDesk);
- rich reasoning viewers and QR pairing;
- UnifiedPush, Telegram, ntfy, Cloudflare Access, iOS, and Play Store distribution;
- changing existing Docs/browser safety guards or acceptance priorities to accommodate remote access.

### 13.11 Assumptions and required user/external inputs

- The target is a physical Android 8.0/API 26+ phone and a native sideloaded APK; there is no iOS deliverable.
- Tailscale is installed and normally connected on the phone. Tailscale Serve remains tailnet-only.
- Firebase is acceptable for metadata-only push. Firebase project/app registration and Google service credentials require account-level setup outside this repository.
- A command-line Android SDK and JDK are installed under `~/Android` **[verified 2026-11-06]**. There is no emulator or system image; acceptance used a physical Samsung phone connected over `adb` and Tailscale.
- The host stays awake, Edge and the panel stay connected, and the companion becomes a user service for dependable away-from-home use.
- CAPTCHA/password/2FA and panel recovery use RustDesk. Lock-screen takeover on this Wayland host remains **[needs test]**.
- If Firebase is rejected later, implement a UnifiedPush provider behind the same interface; do not weaken delivery claims or replace push with an always-on background socket.

---

## Appendix A — current wire/storage reference from the repo

These are existing implementation facts, not the proposed remote API:

- **Chat frames companion → UI** (`companion/index.mjs`): `chat.hello`, `chat.status`, `chat.assistant`, `chat.activity`, `chat.tool_call`, `chat.tool_result`, `chat.done`, `chat.stopped`, `chat.stopping`, `chat.error`, `chat.session`, `llm.configured`, `llm.models.result`, `log.*`. `chat.tool_result.text` turns image blocks into the literal `"[image]"`, so screenshots require actual `browser.result` images or a snapshot.
- **Assistant streaming:** the provider maps `agent/assistant-stream` chunks to `activity` frames (`text`, `reasoning`, `tool-call-delta`, and lifecycle kinds). The bridge forwards these as `chat.activity`; committed assistant text arrives separately as `chat.assistant`. The remote reducer must preserve this draft/commit distinction.
- **UI → companion** (`companion/bridge.mjs`): `hello{role:'ui',token}`, `chat.send{text,images,autoCapture}`, `chat.new`, `chat.stop`, `log.*`/`llm.*` control requests, and `browser.result`.
- **Browser commands companion ↔ side panel:** `browser.command{id,command}` / `browser.result{id,ok,result|error}`. `sendToUi` is also used for these commands, which is why it must not become an indiscriminate remote broadcast.
- **Current history:** the side panel archives rendered activity HTML in `chrome.storage.local`; it is not a companion-owned normalized event journal and cannot provide Android replay.
- **Current stop:** DSH rc.2 has no turn-cancel RPC in this integration; the companion interrupts/restarts the runtime and resumes the session. Remote Stop must call this path rather than claiming a lightweight cancel.
- **`auto_view`:** used for auto-capture with a 5 s timeout and callId `auto`; DOM-first, normally `{view:'compact',screenshotSkipped:true,capture:{status:'skipped',reason:'DOM_FIRST_AUTO_VIEW'},...}` with no image. Canvas/editor pages may fall back to capture.
- **`snapshot` / `browser_screenshot`:** returns `image:{data:<base64 JPEG, no data: prefix>,mimeType:'image/jpeg',width,height,bytes,reencoded,cssPerImagePixel}`. Width caps: 1280 normal / 640 fast / 2048 high; quality 72 default; viewport × devicePixelRatio source then downscaled. Typical 38–175 KB decoded, rare 520–561 KiB; base64 adds about 33%.
- **Limits:** `MAX_PAYLOAD_BYTES = 32 MB`, `UI_COMMAND_TIMEOUT_MS = 5000`, side-panel grace `8 s` (`CRAZYAGENT_UI_GRACE_MS`), up to four pasted images per prompt, and a 32-random-byte/64-hex bridge token in a `0600` file.

## Appendix B — existing and proposed file map

**Existing files to change carefully:**

- `companion/bridge.mjs` — singleton roles, `requestUi`, `/health`, token auth, frame routing, browser-result observation; preserve UI/tools behavior.
- `companion/index.mjs` — extract shared session operations, chat broadcast, help state, remote lifecycle, and opt-in CLI configuration.
- `companion/dsh.mjs` — existing DSH subprocess/session ownership and interrupt/resume semantics; avoid a second runner.
- `companion/log-store.mjs` — existing screenshot artifacts/redaction; expose only a narrow safe reuse/read path if selected.
- `companion/protocol.mjs` — existing private wire constants; proposed remote protocol constants should remain separate.
- `packages/dsh-browser-extension/lib/index.js` — provider registration/guidance for the proposed strict help control.
- `extension/sidepanel/app.js` — existing rendering/reconnect/history and waiting/help projection if needed; do not use its HTML archive as Android protocol state.
- `extension/sidepanel/browser.js` — executor and capture behavior; no remote-only weakening of guards.
- `scripts/dev.mjs` — forwards companion arguments; keep remote opt-in and restart after companion changes.
- `package.json` / lockfile — deliberate supported Google-auth/FCM server dependency if selected, with no undeclared framework assumptions.

**Added in Milestone 1:**

- `companion/remote-server.mjs`, `remote-hub.mjs`, `remote-token.mjs`, `session-controller.mjs` — listener/auth/routes, journal/projection/idempotency, credential, and the shared chat/new/stop controller.
- `companion/test/remote-server.test.mjs`, `remote-hub.test.mjs`, `remote-token.test.mjs`, `session-controller.test.mjs`, `remote-fixtures.mjs` — no live model or real FCM.

**Added in Milestone 2:**

- `android/`: a standalone Gradle 9.9.0 wrapper and version catalog, plus the `app/` module (`data/`, `state/`, `app/`, `ui/`). Its JVM tests use `FakeCompanion` and the RemoteHub fixtures in `app/src/test/resources/remote-protocol/`. There are no instrumented tests yet. See `android/README.md`.
- `scripts/remote-protocol-fixtures.mjs`: records the RemoteHub frames and final projections the Android reducer must match. `--check` reports stale fixtures.
- `scripts/fake-remote-companion.mjs`: the real remote API in front of a scripted runner (no model, DSH, or browser), on `127.0.0.1:17883` with its own git-ignored token in `.dsh-home/fake-remote/`. It is for phone checks through `adb reverse` or Serve.
- `companion/test/remote-protocol-fixtures.test.mjs` and `fake-remote-companion.test.mjs`.

**Added in Milestones 3–5 and 7:**

- `companion/remote-push.mjs` (registry, service, FCM HTTP v1 provider) and its tests; `packages/dsh-browser-extension/lib/help.js` and `test/help.test.mjs`.
- `android/.../notifications/` (`PushMessage`, `Notifier`, `PushSetup`, `AgentMessagingService`), `RemoteApp`, and the `help-request.json` reducer fixture.
- The screenshot mirror lives in `RemoteHub` (in memory); no separate screenshot owner was built.

**Local-only, never committed:**

- `.dsh-home/browser-agent/fcm-service-account.json` and `push-devices.json`; `android/firebase.properties`, `android/keystore.properties`, and `android/release.jks`.
- Local-only configuration/secrets under `.dsh-home/browser-agent/` or an explicit credential path; Android `local.properties`, Firebase config, and signing files remain ignored.

**Other existing references:**

- `config/browser.patch.yml` — browser profile/tool composition; update guidance only with the actual help-control milestone.
- `extension/background.js` — side-panel open behavior; no programmatic open without a user gesture.
- DSH `dsh-web-app`, `dsh-client-connection`, `dsh-client-ui-approval`, and `dsh-client-ui-attachment` READMEs under the installed global DSH packages — relevant only to alternatives B/F and any future real approval protocol.

## Appendix C — external references

- Tailscale Serve / certificates / ACL grants: [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve), [grants](https://tailscale.com/docs/features/access-control/grants)
- Android build/JDK and Compose: [Android build JDKs](https://developer.android.com/build/jdks), [Jetpack Compose](https://developer.android.com/compose)
- Android credential storage: [Android Keystore](https://developer.android.com/identity/data/androidkeystore)
- OkHttp HTTP/WebSocket client: [OkHttp](https://square.github.io/okhttp/)
- Firebase Cloud Messaging: [Android client setup/token handling](https://firebase.google.com/docs/cloud-messaging/android/client), [server send messages/HTTP v1](https://firebase.google.com/docs/cloud-messaging/send-message)
- UnifiedPush alternative: [UnifiedPush](https://unifiedpush.org/)
- RustDesk unattended + Wayland preview: [unattended setup](https://rustdesk.com/blog/rustdesk-unattended-access-setup/), [Wayland unattended preview](https://rustdesk.com/blog/unattended-remote-access-wayland/)
- Telegram Bot API alternative: [Bot API](https://core.telegram.org/bots/api)
- ntfy publish/actions/attachments alternative: [ntfy publishing](https://docs.ntfy.sh/publish/)
- Cloudflare Tunnel + Access alternative: [quick tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [self-hosted Access apps](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
