# crazyAgent Remote (Android)

A native Kotlin + Jetpack Compose app for controlling the crazyAgent browser agent from an Android phone. It talks only to the companion's opt-in remote API (`npm run dev -- --remote`, `docs/REMOTE-ACCESS.md` §4.4–§4.5.1), and normally reaches it through tailnet-only Tailscale Serve.

Status: the app implements Milestones 2–5 of `docs/REMOTE-ACCESS.md`: pairing, the shared chat, stop/new, reconnect with replay, the live screenshot view with on-demand capture, continue and steer, the help card for a waiting agent, and push registration with notifications. **Verified on a phone:** only the Milestone 2 scope (pairing, send/stream, stop, new, reconnect, a Wi-Fi → cellular switch). **Not verified on a phone:** the live view, capture, continue, steer, the help card, and notification settings; these have JVM coverage and a JVM run against the real Node remote API only. **Never run at all:** anything that needs Firebase, because no Firebase project exists.

## Toolchain

Nothing is installed system-wide. On the development host the tools live under `~/Android`:

- `~/Android/jdk/current` — Eclipse Temurin JDK 21;
- `~/Android/Sdk` — the command-line tools, `platform-tools` (`adb`), `platforms;android-37.0`, and `build-tools;36.1.0`.

The Gradle wrapper (9.9.0, checksum-pinned) is committed. Pinned versions are in `gradle/libs.versions.toml`: AGP 9.5.1 with built-in Kotlin 2.4.21, Compose BOM 2026.09.00, OkHttp 5.5.1. The build uses `compileSdk` 37, `targetSdk` 36, and `minSdk` 26 (Android 8.0).

```sh
cd android
echo "sdk.dir=$HOME/Android/Sdk" > local.properties   # git-ignored
export JAVA_HOME=~/Android/jdk/current
./gradlew testDebugUnitTest lintDebug assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

### Optional local files (never committed)

`firebase.properties` turns push on for this build. Without it the app builds and runs with push off and says so in Settings. The values come from the Firebase console for an Android app with package `dev.crazyagent.remote`:

```properties
projectId=your-project-id
applicationId=1:1234567890:android:abcdef0123456789
apiKey=AIza...
senderId=1234567890
```

The computer needs the matching service-account key at `.dsh-home/browser-agent/fcm-service-account.json` (or `--fcm-credentials <path>`); until then the app shows "Not set up on the computer". A push carries only `type`, `turnId`, `instanceId`, and `sequence`.

`keystore.properties` signs the release build (`./gradlew assembleRelease` → `app/build/outputs/apk/release/app-release.apk`). Without it the release APK is unsigned and cannot be installed.

```properties
storeFile=release.jks
storePassword=...
keyAlias=crazyagent-remote
keyPassword=...
```

A release APK is signed with a different key than the debug APK, so Android will not install one over the other: uninstall first, then pair again. Keep the keystore; a release signed with a new key cannot update an installed one.

## Layout

| Path | Role |
|---|---|
| `data/` | `RemoteApi` (authenticated HTTP), `EventStream` (`/events` WebSocket as a Flow), `ServerInput` (address/token validation), and `Backoff` (bounded exponential backoff with jitter). |
| `state/` | `ChatReducer`, a pure, immutable reducer for `/state`, `remote.resync`, and sequenced events: dedupe, gap and instance detection, and draft/commit replacement. It also holds `displayRows`. |
| `app/` | `RemoteController` (connection loop, send/stop/new, reconciling uncertain sends), Keystore/DataStore stores, `ImagePreparer`, and `MainViewModel`. |
| `ui/` | The Compose pairing and chat screens, sidebar-style components, and icons. |

## UI

The app mirrors the desktop side panel's fixed dark palette, yellow accents, utility controls, activity feed, expandable tool rows, and rounded composer. The empty chat view stays blank apart from available recent sessions. Settings contains pairing and model information; Diagnostics contains the companion, runtime, browser-panel, browser-tools, and session state. The context ring shows the latest provider-reported token count divided by the model's context window, with exact values on tap. History offers recent-session cards, search, and read-only saved transcripts from the companion. Assistant responses render native Markdown for headings, emphasis, links, lists, quotes, code, and tables.

The top of the chat screen is a live view: every screenshot the agent captures (auto views and tool results) is mirrored by the companion and shown edge to edge at the full width of the phone, between the top icons and the chat. A normal browser viewport gets its exact height. A tall or square capture is capped at half the window (and always leaves 300 dp for the chat and composer) and letterboxed. The pane hides when there is no room, for example on a small phone with the keyboard open. A clearly wide window (landscape) puts the live view beside the chat instead. The previous image stays up while a newer one downloads; only the newest is fetched. Tapping the pane opens a full-screen viewer with pinch-to-zoom around the fingers (up to 8×), drag to pan, and double tap to zoom in or reset; it keeps following new screenshots. Nothing is shown until the agent has captured a view in the current session. Images are held in memory only.

A saved chat opened from History or the recent cards has a **Continue this chat** button. It switches the companion (and therefore the desktop panel's next turn) to that conversation and reloads its messages into the chat view; it is refused while a turn is running, and a chat whose model session DSH can no longer restore reports that and leaves the current chat in place. While a turn is running, typing a message shows a yellow send button next to Stop: sending **steers** the agent — the companion stops the turn and runs the message next in the same conversation. The message shows as "Steering…" until the stopped turn ends.

The live view sits directly below the top icons. Its chevron collapses it to a slim "Live view hidden · Show" bar, and tapping the bar opens it again.

The composer supports `/new`, `/model`, and `/plan` with the same single-token matching rules as the sidebar. `/new` opens the guarded new-chat confirmation, `/model` opens model details, and `/plan` toggles plan mode for the next prompt only. Other slash-leading text is sent as prose. The plan flag survives pending-message encryption, reconciliation, and deliberate resend.

Model administration, live DSH session switching outside the explicit Continue action, and debug-log export are not exposed by the remote API, so the app does not offer nonfunctional controls for them. The image picker replaces the desktop microphone button. The launcher uses the extension's yellow cursor with a safe margin inside adaptive and density-specific legacy icons. Both light and dark Android system themes use the sidebar's dark color scheme.

## Rules the client follows

- The token is encrypted with a non-exportable Android Keystore AES-GCM key and kept in DataStore. It is excluded from backups and never logged or put in a URL. `ServerConfig.toString()` redacts it. The window is excluded from autofill, so password managers such as Samsung Pass don't offer to save it.
- Release builds are HTTPS only, using platform trust anchors. Debug builds also allow cleartext to the phone's own `127.0.0.1`/`localhost`, so a fake companion can be reached through `adb reverse`. No other host may use cleartext.
- Every send has a client-generated ID.
  - If the result is uncertain (the request was sent but no reply came), the app checks `/state` and retries only with the **same** ID, at most 3 times.
  - If the companion restarted, or the app restarted and lost the images, the prompt waits for the user to review it.
  - "Send again" is the only path that creates a new ID, and only the user can trigger it.
- A rejected or revoked token (HTTP 401, WebSocket close `4401`) stops reconnecting until the user pairs again.
- The app streams events only while it is visible. Reopening it replays from the last sequence or performs a full resync. There is no foreground service.

## Tests

- **Unit tests:** `./gradlew testDebugUnitTest`. These are JVM-only, with no device, model, or network.
  - `ReducerFixtureTest` replays frames recorded from the real Node `RemoteHub` (`app/src/test/resources/remote-protocol/`, regenerated by `node scripts/remote-protocol-fixtures.mjs`). It requires the reducer to reach the hub's own final projection. `npm test` fails when the fixtures are stale.
  - `RemoteControllerTest` runs against `FakeCompanion`, a MockWebServer dispatcher. It covers headers and bodies, busy refusal, lost acceptance and lost requests with same-ID retry, reconnect during a turn, gap resync, token revocation, backoff, stop/new, and process recreation.
  - `LiveFakeCompanionTest` is opt-in and runs the real client against the real Node API:

    ```sh
    node scripts/fake-remote-companion.mjs --port 17893 --token-file /tmp/fake-token &
    CRAZYAGENT_FAKE_URL=http://127.0.0.1:17893 CRAZYAGENT_FAKE_TOKEN_FILE=/tmp/fake-token \
      ./gradlew testDebugUnitTest --tests '*LiveFakeCompanionTest*'
    ```

## Trying it on a phone without the real agent

```sh
node scripts/fake-remote-companion.mjs          # scripted replies on 127.0.0.1:17883; prints a fake-only token
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:17883 tcp:17883
```

Then, in the app:

1. Pair with `http://127.0.0.1:17883` and the printed token.
2. Every turn publishes synthetic screenshots for the live view; `tall` or `square` in the prompt changes their shape. A prompt containing `slow` runs for about 40 seconds, which is long enough for Stop and force-close/reopen. Wi-Fi/cellular switches only mean something through Tailscale Serve, because `adb reverse` traffic goes over USB. A prompt containing `fail` ends with an error.
3. `node scripts/fake-remote-companion.mjs --rotate` revokes the token. Ctrl+C and a restart give the fake a new instance ID.

Through Tailscale Serve, run the fake with `--public-host <host>.ts.net` and pair with the HTTPS address.

## Pairing with the real companion

```sh
npm run dev -- --remote --remote-public-host <host>.ts.net
npm run dev -- --pair-remote      # prints the address and token once
```

Publish only `127.0.0.1:17873` with tailnet-only Tailscale Serve, never Funnel, and never `17871`.

## Persistent companion on this host

The companion is configured as an enabled `systemd --user` service with linger, automatic restart, and the existing tailnet-only Serve rule. The unit is stored at `../config/crazyagent.service` and `~/.config/systemd/user/crazyagent.service`.

```sh
cp ../config/crazyagent.service ~/.config/systemd/user/crazyagent.service
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now crazyagent.service
tailscale serve --bg http://127.0.0.1:17873
```

Check it with `systemctl --user status crazyagent.service` and `tailscale serve status`. The service starts the loopback API at boot, but browser actions still require Edge and the crazyAgent side panel to be opened after login. Keep Tailscale connected on the phone. AC suspend is disabled on this host; battery suspend remains enabled.
