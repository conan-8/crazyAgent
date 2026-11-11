# crazyAgent

**Control Chrome or Edge from a local side panel with guarded browser actions, file transfer, and semantic Google Docs editing.** Built on **DSH 0.2.2-rc.1**.

**Optimised for DeepSeek V4.1 Flash** on OpenRouter (`deepseek/deepseek-v4.1-flash`). Other image-capable, tool-capable models remain available. [Download v2.2.0](https://github.com/conan-8/crazyAgent/releases/tag/v2.2.0) · [Patch notes](RELEASE-NOTES.md).

## Install with an agent

**Requirements:**

- Git and npm.
- Node **24.9+**.
- Chrome/Chromium/Edge **116+** with the Side Panel API.
- An [OpenRouter](https://openrouter.ai/) API key. Model usage is billed by your configured provider.
- A normal HTTP(S) website tab; browser-internal and Web Store pages are protected.

**Paste this prompt into a coding agent on the computer where Chrome or Edge is installed:**

```text
Install crazyAgent v2.2.0 on this computer from https://github.com/conan-8/crazyAgent. Own the setup end to end: when you need my input or a manual browser step, give me exact instructions, wait for me, and then continue with verification instead of ending the installation early.

1. Verify Git, Node.js 24.9 or newer, npm, and Chrome/Chromium/Edge 116 or newer. If anything required is missing or outdated, explain what you propose to install or update and ask for my permission. Once I approve, make the changes and continue; do not hand me a prerequisite installation guide unless I decline or no safe installation method is available. Ask separately before using sudo or replacing an existing runtime. If you install a user-level runtime, use its bin directory in PATH consistently for npm ci, npm run setup, the companion process, and the restart command you give me.
2. Clone the v2.2.0 tag into a new crazyAgent directory. If that directory already exists, do not overwrite or delete it; ask me for another location. Run npm ci and npm run setup in the checkout.
3. Check whether port 17871 is occupied before starting anything. If it is occupied, stop and report it instead of killing an existing process. Otherwise, start npm run dev -- --model deepseek/deepseek-v4.1-flash --reasoning-effort medium as a persistent background process. Verify that http://127.0.0.1:17871/health returns HTTP 200 with ok:true, but do not mistake that alone for a completed installation.
4. Give me short manual instructions to load the checkout's extension directory as an unpacked extension in chrome://extensions or edge://extensions, pin crazyAgent, and open its side panel. In Settings, have me confirm the bridge URL is ws://127.0.0.1:17871/bridge. Proactively copy the pairing token from .dsh-home/browser-agent/token to my clipboard with an OS-appropriate command that does not display it; if you cannot access my clipboard, give me the exact command to run myself. Tell me to paste it into the pairing-token field. I will enter my own OpenRouter API key directly in Settings.
5. Before my first Save, tell me to type deepseek/deepseek-v4.1-flash manually into the Model field even if the model list is empty. Do not tell me to click Refresh models before this first Save: Refresh requires a companion connection, while Save accepts the manually entered model ID and establishes that connection. Have me save and wait for the real side panel to show Connected.
6. After I save, ask me to confirm the side-panel status and independently poll /health for a bounded period. Do not create a synthetic WebSocket, ui, or tools client to test the bridge: it can replace the real extension connection and is not installation acceptance. Do not declare installation complete until the real side panel shows Connected and /health reports ok:true, ui:true, and tools:true. If the panel does not connect or either health flag remains false, inspect the relevant logs and settings flow without exposing credentials, give me exact corrective steps, and continue troubleshooting rather than merely repeating generic instructions.
7. Once connected, tell me to click Refresh models, select DeepSeek V4.1 Flash from the loaded list, and Save again to confirm the model ID. Keep the companion running. Finish with the install path, verified health and side-panel status, and an exact restart command that includes any required PATH override. Never ask me to paste the API key or pairing token into chat, and never print, log, commit, or transmit either credential yourself. Do not run website tasks or model-spending tests until I confirm installation is complete.
```

`setup` initializes `.dsh-home/profiles/sdk-minimal`, links the local DSH plugins, and validates profile composition. `dev` starts the loopback-only companion and prints bridge pairing information.

> [!NOTE]
> **Finish the browser setup**
>
> 1. **Open your browser's extension page:** go to `chrome://extensions` or `edge://extensions`.
> 2. **Load crazyAgent:** enable **Developer mode**, choose **Load unpacked**, and select the checkout's `extension/` directory.
> 3. **Open the side panel:** click the **crazyAgent** toolbar icon in the extension menu(puzzle piece icon), and PIN it.
> 4. **Connect your model:** in **Settings**, confirm the bridge URL is `ws://127.0.0.1:17871/bridge`, paste the pairing token from `.dsh-home/browser-agent/token`, and enter your own OpenRouter API key. Manually type `deepseek/deepseek-v4.1-flash` into **Model** and click **Save**. Do not click **Refresh models** before this first save; loading the list requires the connection established by saving these settings. **Never share the API key or pairing token publicly.**
> 5. **Verify the connection:** wait for **Connected**, then click **Refresh models**, select **DeepSeek V4.1 Flash** from the loaded list, and save again. The agent should confirm that `/health` reports `ok:true`, `ui:true`, and `tools:true` from the real extension connection.
> 6. **Start a task:** open a normal page and ask a question or request an action.

> [!IMPORTANT]
> Keep the companion and Edge running while the agent runs. With the side panel open it runs the browser actions; with it closed, the extension's background worker does (system-clipboard actions, including Docs rich paste, still need the panel). **Do not touch the browser while a task is running:** clicking, typing, scrolling, or switching tabs can invalidate the agent's targets.

Page content, screenshots, prompts, and explicit tool results can be sent to the configured model provider. crazyAgent requests broad browser permissions and can change real pages and files; review [Privacy and permissions](#privacy-and-permissions) and `PRIVACY.md` before use.

> [!TIP]
> crazyAgent is able to screenshot page elements and download files which can be sent to other chatbots for cross reference or better reliability. You can prompt it to consult another AI chatbot when a task is too difficult, or to prevent loss of focus on the greater task.

## Update with an agent

Use this prompt to update an existing crazyAgent checkout to **v2.2.0** without replacing its configuration or local data:

```text
Update my existing crazyAgent installation to v2.2.0 from https://github.com/conan-8/crazyAgent. Own the update end to end. Preserve my configuration, API key, pairing token, sessions, downloaded files, and unrelated local changes; this is an in-place update, not a fresh installation.

1. Locate my existing crazyAgent checkout and ask me for its path only if you cannot find it. Verify that it is the expected Git repository, inspect its current version and startup method, and identify the Node runtime used by its companion. Verify Git, Node.js 24.9 or newer, npm, and Chrome/Chromium/Edge 116 or newer. Reuse an existing compatible user-level Node runtime when available. If a prerequisite is missing or outdated, explain what you propose to install or update and ask for my permission; once I approve, make the changes and continue. Ask separately before using sudo or replacing an existing runtime.
2. Inspect git status before changing the checkout. Never use git reset --hard, git clean, npm run clean, or any other command that discards local changes or deletes .dsh-home. Do not delete or replace the checkout with a fresh clone. If local changes could be overwritten, explain them and ask me how to proceed. Fetch the repository's tags, check out v2.2.0 without forcing, and verify that HEAD exactly matches that tag. If the checkout is already on the target tag, say so and continue with verification rather than claiming you changed the version.
3. Using the compatible Node runtime and any required PATH override, run npm ci, npm run setup, and npm test in the existing checkout. Do not run live-model, website, or other model-spending tests.
4. Restart the companion using its existing startup method, whether that is a background process or a user service. Identify and stop only the companion process belonging to this checkout; never kill an unknown process merely because it uses port 17871, and do not start a second conflicting companion. Preserve the existing model, base URL, reasoning effort, API key, and pairing token instead of overriding them with defaults. Include any required PATH override in the restart command.
5. Give me exact instructions to reload the existing unpacked extension in chrome://extensions or edge://extensions and reopen its side panel. Do not remove or reinstall the extension, because that can discard its saved settings. Ask me to confirm that the real side panel shows Connected, then independently poll http://127.0.0.1:17871/health for a bounded period. Do not create a synthetic WebSocket, ui, or tools client as a substitute for the extension. Do not declare the update complete until the real side panel shows Connected and /health reports ok:true, ui:true, and tools:true. If anything remains disconnected, inspect the relevant logs and settings flow without exposing credentials and continue troubleshooting with exact corrective steps.
6. Finish with the previous and resulting versions or commits, install path, test result, verified health and side-panel status, and the exact restart command. Never ask me to paste credentials into chat, and never print, log, commit, or transmit them yourself. Keep the updated companion running and do not run website tasks or model-spending tests until I confirm the update is complete.
```

## What it can do

- **Generally everything a human can do on a browser, including filling forms, doing work, planning, and research.**
- Read and act on ordinary web pages through labelled controls, trusted coordinates, bounded batches, and guarded drag and drop.
- Create and edit Google Docs content and native tables with exact targeting and export verification.
- Download files and attach Downloads-folder files to page inputs with filesystem readback.
- Distinguish observed changes, requested postconditions, and final outcomes instead of treating every tool result as success.
- Keep receiving views while the browser is unfocused or minimised, with slash commands in the composer.

There are **34 standing model-facing tools**: 25 general browser tools, 8 guarded Docs tools, and `agent_request_help`, plus a conditional 35th `browser_plan` tool exposed only during explicitly planned turns. The detailed reference is below.

## New in v2.2.0

- **Honest drag outcomes:** drags and selections on iframe/canvas/video surfaces report `unknown` with pixel diagnostics instead of a false no-effect; switching tabs mid-drag returns a prompt `DRAG_STALE_TAB` refusal instead of a timeout.
- **Fail fast when the executor goes away:** two consecutive panel-closed results open a circuit that tells the model to report BLOCKED; a real mid-turn extension reload was verified to reconnect and continue the turn.
- **Recoverable errors:** coordinate refusals arrive with a fresh full view, unknown arguments are named with the accepted list and literal examples, covered labels name their cover, and uploads verify page-cleared inputs and exact on-disk names.
- **Turn evidence:** every turn records its model-reported DONE/PARTIAL/BLOCKED label, failed calls, and token usage; stopped turns keep their cost evidence. A new isolated real-model harness (`scripts/model-eval.mjs`) measures eleven scripted scenarios with independent checkers.
- **Panel-less execution:** the background worker runs the agent with no side panel open (system-clipboard actions still need the panel), with explicit one-executor handover.
- **Cursor and motion:** one yellow agent cursor that fades out of every capture, and a shared motion scale for the panel and Android app.
- **Android 0.5.0 (4):** rebuilt signed APK covering the live view, help card, Continue/Steer, and plan composer; new SHA-256 above.

See the complete [v2.2.0 patch notes](RELEASE-NOTES.md). Physical-phone acceptance of the newest screens, real FCM delivery, a clean-boot service test, and live-model docked-panel `/plan`/Docs outcome acceptance remain pending; Track B9 (opt-in irreversible-action confirmation) is deferred to a later release.

## crazyAgent Remote app setup

Use the optional Android app with an existing crazyAgent desktop installation. Basic chat, screenshots, help, and reconnects do **not** require Firebase; metadata-only push notifications are a separate optional setup.

**Requirements:**

- A working crazyAgent **v2.2.0** installation on the host computer.
- Chrome/Edge running. Keep the side panel open for system-clipboard/Docs rich-paste actions or when using a build without the background executor.
- An Android **8.0/API 26+** phone.
- Tailscale installed and signed into the same tailnet on the host and phone, with MagicDNS and HTTPS certificates enabled.
- Optional: `adb` and USB debugging for agent-driven APK installation. Otherwise, install the APK directly on the phone.

### Agent-driven Remote setup

**Paste this prompt into a coding agent on the host computer after completing the desktop installation:**

```text
Set up crazyAgent Remote v2.2.0 on this computer and my Android phone. I already installed crazyAgent on this host.
First verify the existing installation is v2.2.0 and http://127.0.0.1:17871/health responds successfully. Do not use sudo, replace my runtimes, kill existing processes, or run model-spending tests. If the installation is missing or unhealthy, stop and tell me.
Verify that Tailscale is running, identify this host's Tailscale DNS name, and confirm MagicDNS and HTTPS certificates are enabled. Inspect any existing Tailscale Serve configuration without overwriting unrelated routes.
Enable the scoped remote API on the existing crazyAgent companion with --remote and --remote-public-host <this-host>.<tailnet>.ts.net. Preserve my existing model/settings and use the existing startup/service method rather than starting a conflicting second companion. The remote listener must remain on 127.0.0.1:17873; never expose port 17871.
Publish only the remote listener with tailscale serve --bg http://127.0.0.1:17873. Do not enable Funnel or public port forwarding. Verify that the Serve route is tailnet-only, unauthenticated /remote/v1/state returns 401, and /bridge through that route returns 404.
Download the official APK from https://github.com/conan-8/crazyAgent/releases/download/v2.2.0/app-release.apk into a new empty temporary directory and require SHA-256 05090c0846a7d3cae3b11abee74ba7f84cb52ad3bce9ab3e5c76ba83469fdac1 before installing it. Do not use a different APK or build unless I explicitly ask for a source build.
If adb is available and authorized, install that verified APK with adb install -r. If no usable adb device exists, give me short manual instructions to download and open the same APK on my Android phone. If Android rejects an update because the existing app has a different signature, stop and explain that uninstalling deletes the old pairing; do not uninstall or erase app data automatically.
Do not print, read, copy, log, commit, or transmit the remote token yourself. Give me the exact npm run dev -- --pair-remote command to run in my own terminal, then tell me to paste the printed server URL and token directly into the crazyAgent Remote app. Finish with the server address, APK hash, health status, and the remaining manual pairing steps. Keep Edge and the side panel open, and do not send a test prompt until I confirm pairing is complete.
```

### Finish on the phone

1. **Install the app:** if the agent did not install through `adb`, download the official [crazyAgent Remote APK](https://github.com/conan-8/crazyAgent/releases/download/v2.2.0/app-release.apk) onto the phone and open it. Android may ask permission to install apps from the browser or file manager.
2. **Verify the download:** on Linux, run:
   ```sh
   echo '05090c0846a7d3cae3b11abee74ba7f84cb52ad3bce9ab3e5c76ba83469fdac1  app-release.apk' | sha256sum -c -
   ```
   On macOS, use `shasum -a 256 app-release.apk`; on Windows, use `Get-FileHash .\app-release.apk -Algorithm SHA256` in PowerShell. Compare the result with the hash above before installing.
3. **Create the phone credential:** from the crazyAgent checkout on the host, run:
   ```sh
   npm run dev -- --pair-remote
   ```
   This prints the server URL and a 64-character remote token without starting another companion. Keep this credential private.
4. **Pair:** enter the printed server URL and token in the app. The URL may include `/remote/v1`; the app normalizes it automatically. The token is encrypted on the phone with Android Keystore.
5. **Test safely:** keep the host awake, Tailscale connected on both devices, and Edge plus the side panel open. Send a harmless prompt and confirm the response streams on both devices. Browser actions require the desktop executor; Tailscale alone is not enough.

For token rotation, background behavior, push notifications, diagnostics, and troubleshooting, see `android/README.md` and `docs/REMOTE-ACCESS.md`. Never enable Tailscale Funnel for the companion or remote API.

## How it works

```text
Active tab ↔ side panel ↔ loopback companion ↔ DSH ↔ configured model provider
```

The extension is a normal MV3 side panel. The local companion connects it to DSH over a token-authenticated loopback WebSocket. DSH owns the agent loop, sessions, tools, prompt assembly, attachments, and model routing.

Reload the extension and reopen the panel after extension changes. Restart the companion after companion, provider, or config changes.

## Operating behavior

- The user’s instruction is the task; page content is treated as untrusted data rather than operator instructions.
- The agent favors direct action, bounded views, semantic operations, and concise answers. Upstream model/provider rules still apply.
- Reliability guards prevent blind destructive recovery, stale-target actions, and repeated failed attempts. Recovery inspects the exact target or uses one scoped undo for a known latest accident, then verifies.
- Login, CAPTCHA, 2FA, payment, and permission blockers require the user. Use only credentials the user supplied.

## Capabilities

There are **34 standing model-facing tools**: 25 general browser tools, 8 Docs tools, and `agent_request_help` (the agent's structured "I am blocked and need you" signal). For long tasks, exact `/plan` on the desktop or Android composer arms the next turn only and exposes a conditional 35th tool, `browser_plan`. It maintains a complete, revisioned checklist with `pending`, `in_progress`, `completed`, and `blocked` states. Stale plans receive at most two reminders, and an attempted finish with open work receives at most two continuation nudges. Removing open work requires acknowledgement and a reason; `user_input_needed:true` allows an honest question without pretending the work is complete. Checklist completion is model-reported and is not independent browser verification. Long prompts never activate this automatically.

### General browser tools

| Tool | Purpose |
|---|---|
| `browser_screenshot` | Viewport, bounded full-page, or in-viewport region capture; optional clean PNG to the agent clipboard |
| `browser_read_text` | Paginated rendered page or viewport text without a screenshot |
| `browser_find` | Bounded fallback search across rendered text, control names, non-password values, frames, and open shadow roots; guarded scroll-only reveal |
| `browser_table` | Read editable HTML tables or validate and write 1–100 semantic cell targets with readback |
| `browser_click` | Click a persistent numbered DOM label, including open shadow DOM and accessible frames |
| `browser_click_role` | Follow 1–4 exact role/accessible-name page-chrome steps, including revealed menus |
| `browser_click_at` | Trusted screenshot/CSS-coordinate input for canvas and other surfaces; bounded bursts outside document editors |
| `browser_type` | Replace/append in labelled editable elements or insert at a known caret/selection |
| `browser_press_key` | One trusted key or supported modifier chord |
| `browser_select` | Trusted text-range selection outside Google Docs with non-canvas selection readback |
| `browser_drag` | Standalone trusted pointer/HTML5 drag with current-view guards, source/destination evidence, sliders, clone/drop support, and bounded long-press |
| `browser_scroll` | DOM scrolling with trusted wheel fallback for canvas apps |
| `browser_hover` | Reveal hover-dependent controls |
| `browser_select_option` | Set a native `<select>` and emit input/change events |
| `browser_batch` | Up to 20 ordered ordinary-page actions with pre/post guards and one final view |
| `browser_navigate` | Open an HTTP(S) URL, use a new tab, reload, or go back/forward |
| `browser_wait_for` | Wait for text, URL, idle, and/or a fixed delay with explicit view control |
| `browser_dialog` | Accept/dismiss a pending native JavaScript dialog, with optional prompt text |
| `browser_download` | Download a direct URL/link or labelled Download control with collision-safe naming, completion waiting, and filesystem verification |
| `browser_downloads` | List regular Downloads files newest first, including bounded subfolders, with optional normalized search; returns exact filenames and metadata without reading file bytes |
| `browser_upload` | Attach a regular file from Downloads to a labelled, named, or indexed file input, including hidden inputs, open shadow roots, and same-origin accessible frames (site-isolated cross-origin frames fail with `UPLOAD_FRAME_UNSUPPORTED`), with File name/size readback |
| `browser_tabs` | List current-window tabs |
| `browser_switch_tab` | Activate by tab id or title/URL query |
| `browser_places` | On-demand read-only lookup in new-tab shortcuts, bookmarks, and recent history |
| `browser_clipboard` | Copy/read/write/clear/paste text or captured PNGs using a session virtual clipboard or explicit system clipboard |

### Action evidence and typed postconditions

`browser_click`, `browser_click_at`, `browser_type`, and `browser_press_key` accept an optional strict `expect` object with only `export_contains`, `toolbar_style`, `dialog`, `text_landed`, and `pixel_changed`. Supported batch steps accept `text_landed` or `dialog`; top-level and nested `args.expect` forms use equivalent per-operation conditional schemas, Ajv-verified, while other checks, unknown keys, incompatible capabilities, and `pixel_changed:false` fail before any guard or mutation. Ordinary batch `before`/`after` guards still run and their outcome remains separate from expectation evidence.

Results distinguish `observed` (`changed`, `unchanged`, or `unknown`), `expectation.status` (`verified`, `diverged`, or `unverified`), `outcome.ok`, and `mutationPossible`. Text and Docs-export checks require the same uniquely identified scope, including document URL and navigation generation, to change from absent to present; pre-existing text and truncated absence cannot verify. URL-sensitive batch expectations are rejected after any preceding step that could replace the document. Dialog and toolbar checks measure final state without claiming causation. Pixel scopes also require tab/document identity and remain direct-only and diagnostic, never application-success proof. Bounded semantic New on screen/Changed/New text summaries use actual same-scope label snapshots or mutation-added visible text, not aggregate text lengths or one-sided scopes. Failed expectations do not cause automatic re-aiming, retries, or further mutations.

Direct Docs export checks and six toolbar attributes (`paragraph_style`, `font_size`, `bold`, `italic`, `underline`, `font`) require an active supported Docs document; color/highlight and batch export/toolbar/pixel checks are currently rejected. Dedicated export-verified Docs tools do not pay for redundant generic checks. A failed expectation can be followed only by bounded read-only inspection, not another blind mutation.

`browser_drag` is standalone and exclusive, not a batch step. It uses trusted pointer activation/hold/interpolation and native HTML5 interception/replay only for native sources, with no synthetic fallback. Source movement/value/selection and destination child/text evidence remain separate from `observed`, `outcome.ok`, and `mutationPossible`. Static-source clone effects require destination evidence; drop dispatch and unrelated DOM changes are not success. A no-op requires every applicable measurement to stay unchanged, while detached or missing evidence is unknown. Image/CSS coordinates retain `view_id` and stale-layout guards; child-frame drags and Google Docs are rejected. Prefer `browser_type` with an exact value for native range inputs when a spatial gesture is unnecessary.

### Google Docs tools

| Tool | Purpose |
|---|---|
| `browser_docs_rename` | Rename with title-field focus/value checks and committed-title verification |
| `browser_docs_replace` | Delete or replace 1–200 ordered exact unique matches with counters and partial reporting |
| `browser_docs_format` | Format 1–50 exact ranges with unique or explicit-occurrence targeting and eight supported attributes |
| `browser_docs_select_text` | Select exact text or its containing paragraph with Find-counter evidence and a document-focus barrier; no `all` or persistent multi-select |
| `browser_docs_page_setup` | Verify and set Letter paper, portrait/landscape orientation, and inch margins |
| `browser_docs_write` | Append bounded formatted paragraphs, inline runs, flat lists/checklists, blanks, and page breaks at document end |
| `browser_docs_table` | Create compact tables, read values and native cell backgrounds, write exact cells, format text, apply exact native background presets or custom hex colors with dedicated `cell_background`-only calls, edit structure, merge/unmerge exactly two horizontal cells with a guarded hover-driven native-menu fallback, or delete tables with export verification |
| `browser_docs_read` | Authenticated export as outline, text, or bounded HTML with pagination and no screenshot |

`browser_docs_replace` and `browser_docs_format` internally route to legacy executor actions; those internal names are not additional model tools.

### Important behavior

- **DOM-first auto views:** ordinary pages attach up to 6,000 characters of rendered text plus labels without an image. Known canvas editors receive a full labelled screenshot. Screenshots remain available for visual/spatial needs.
- **Views:** ordinary DOM actions default to compact results and escalate to full views when needed. Known document editors retain strict fresh-view rules. Completed export-verified Docs results may skip a redundant final screenshot; this is not independent acceptance evidence.
- **Screenshots while you are elsewhere:** the agent can still see the page when the browser window is unfocused or minimized. A focused, visible window uses Chrome's visible-tab capture; an unfocused or minimized window uses a page-level capture instead. Screenshots never focus or restore the browser window, and captured image pixels match the viewport × devicePixelRatio on every path, so image-space clicks still work while the window is unfocused or minimized. Do not touch the browser while the agent is running: clicking, typing, scrolling, or switching tabs can throw off its targets and break the task.
- **Batch safety:** malformed argument keys fail before activity. A failed precondition means no dispatch; a failed postcondition follows dispatch, so blind retry is unsafe. Guard failures always stop the batch and earlier actions are not rolled back.
- **Ambiguity:** exact text, accessible-name, tab, table, file-input, and occurrence ambiguity fails closed rather than selecting an arbitrary target.
- **File transfer:** direct/link/dynamic downloads use unique names and are verified on disk after completion. Chrome chooses where downloads are saved; the agent reads and attaches only inside its configured Downloads folder, so point Chrome's download location at that folder and disable "Ask where to save" (page-control downloads cannot answer the picker). `browser_downloads` lists actual regular files newest first, including bounded subfolders; spaces and `+` match only for discovery. Uploads accept exact regular files whose real paths remain inside that folder and attach them to labelled/named/indexed inputs, including hidden inputs, open shadow roots, and same-origin accessible frames; site-isolated cross-origin frames fail closed with `UPLOAD_FRAME_UNSUPPORTED`. The attached File name/size is verified. Attachment is not server-submission or persistence proof; inspect the destination after submitting.
- **Parallelism:** maximum 4 calls, but only `browser_tabs`, `browser_places`, `browser_read_text`, `browser_docs_read`, and `browser_downloads` are parallel-safe. Mutations remain exclusive in model order.
- **Runaway protection:** no per-turn call cap; identical-repeat guards default to 3 mutations, 30 observations, and 10 unmodified navigation keys.
- **Keyboard safety:** `browser_press_key` and batch key steps reject ctrl/cmd+W in code (not just guidance); closing or listing tabs is left to `browser_tabs`/`browser_switch_tab`.
- **Reasoning:** Medium is the default and recommended effort for new configurations. Saved choices are preserved; Auto requests `low` from the first model step when selected, and Off/Low/High remain available manually.
- **Image context:** exact duplicate images are omitted only at model admission within the same session/turn. Older images are durably offloaded while attachments remain on disk. Capture and debug storage still occur.
- **Stop, save, and queue:** Stop interrupts the current runtime and resumes the session on the next message when possible. The stopped transcript and session ID are saved immediately in **Recent sessions**, so selecting that stopped chat after closing or reopening the sidebar resumes its saved model session. If that session is no longer available, the panel reports it and starts a new chat instead of silently mixing contexts. Messages sent during a turn are queued and can redirect the turn.

Not supported yet include drag batching and child-frame drags, native file pickers, arbitrary JavaScript, native print dialogs, and general browser-chrome automation. File access is confined to the configured Downloads folder; arbitrary filesystem paths are unavailable. Protected pages, closed shadow roots, inaccessible frames, and the built-in PDF viewer can remain inaccessible.

## Side-panel UI

The panel is a single activity feed with streaming reasoning/text/tool events, per-step timing, collapsible finished steps, and a pinned final answer. The composer supports queued messages, Stop, model and reasoning settings, up to four pasted images, browser speech recognition when available, and slash commands: typing `/` opens an inline palette where `/new` starts a fresh chat (a stoppable running turn stays alive behind the draft view, while an operation that is still starting refuses with a wait message), `/model` opens the model picker, and `/plan` toggles a one-shot checklist mode for the next accepted message. Sending or queueing consumes the armed state; queued, restored, and busy-requeued messages retain their own setting. Planned turns show progress, current work, and all checklist states in a sticky dock above the scrolling conversation. The checklist stays pinned while scrolling and after tool steps collapse, and its chevron collapses it to the summary header without losing later updates. Blocked and unfinished outcomes stay visible instead of being replaced by the following idle status. ArrowUp/ArrowDown choose, Enter or Tab runs, and Escape dismisses; only exact `/new`, `/model`, or `/plan` tokens execute, while path-like or trailing-space text is sent as ordinary prose. There is no browser-access Pause/Resume control; legacy saved paused state is cleared on startup. Closing the model picker (Escape, outside click, or choosing a model) returns focus to the composer, and a draft typed or attached while the `/new` view waits behind a running turn survives when that turn ends. After an extension install or reload, a one-time full-screen notice leads with an amber **Don't touch the browser** warning: while the agent runs, clicking, typing, scrolling, or switching tabs can throw off its clicks and targets and break the task. **Got it** or Escape dismisses it; it does not return on ordinary panel opens.

The **Debug log** dialog exports local run evidence. See `docs/DEBUG-LOGS.md` before sharing a bundle.

## Configuration

Settings stores the selected model, base URL, reasoning policy, bridge information, and view preferences. The API key is sent over loopback and passed to DSH as `CRAZYAGENT_API_KEY`; it is not written to `chrome.storage.local` or the generated model patch. Optional local persistence is `.dsh-home/browser-agent/api-key` with mode `0600`.

The companion can also be configured from the CLI:

```sh
npm run dev -- --base-url https://openrouter.ai/api/v1 \
  --model deepseek/deepseek-v4.1-flash --reasoning-effort medium
```

Output tokens default to the selected model’s advertised maximum; `--max-tokens` sets a lower explicit cap. API-key resolution order is `CRAZYAGENT_API_KEY`, the optional stored key, `OPENROUTER_API_KEY`, then the DSH credential store.

File transfer is confined to one Downloads folder. The extension cannot change Chrome's download directory: set Chrome's download location to that folder (default `$HOME/Downloads`) and disable "Ask where to save", otherwise page-control downloads stall on Chrome's save dialog. Set `CRAZYAGENT_DOWNLOADS_DIR` to the same absolute path before `npm run dev` to select a different confined folder (for example an isolated test profile's folder); only regular files whose real paths remain inside it are accepted. Restart the companion after changing it.

## Phone remote access

The native Android app pairs with the scoped remote API over tailnet-only Tailscale Serve. It shares the desktop chat, streams activity, sends images, stops/starts turns, shows real context usage, renders Markdown, opens bounded saved-chat history, and supports Continue and Steer. Its live view mirrors agent captures, offers on-demand screenshots, and opens a full-screen zoom/pan viewer. A structured help request displays the reason and current page, and the user's reply continues the same session. The composer supports `/new`, `/model`, and `/plan`; `/model` opens read-only model details, while `/plan` arms only the next prompt.

Remote access is opt-in with `--remote` and a separate pairing credential; the privileged browser bridge is never exposed to the phone. Optional FCM notifications contain turn metadata only and remain disabled until Firebase is configured on both the host and app. See `android/README.md` and `docs/REMOTE-ACCESS.md` for APK installation, pairing, security, and current acceptance limits.

`config/crazyagent.service` is the configured user-service example for this host. It starts the companion with `--remote`, restarts it on failure, and uses the saved model configuration. Install or update it with:

```sh
cp config/crazyagent.service ~/.config/systemd/user/crazyagent.service
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now crazyagent.service
tailscale serve --bg http://127.0.0.1:17873
```

Linger lets the API start at boot before a desktop login. Tailscale must remain connected on the phone, and **Edge must be running with the extension paired once for browser execution**. The side panel is optional while the background executor is available; keep it open for system-clipboard/Docs rich-paste actions or when using a build without that executor. On this host AC suspend is disabled while battery suspend remains unchanged. Never publish the privileged bridge port `17871` or enable Funnel.

Generated state is under ignored `.dsh-home/`. To remove it:

```sh
npm run clean -- --yes
npm run setup
```

This deletes sessions, attachments, debug logs, tokens, and any remembered key. It does not delete files downloaded into your Downloads folder.

## Privacy and permissions

Screenshots, rendered text, labels, prompts, pasted images, and explicit tool results such as personal destinations, clipboard contents, filenames, and file metadata can be sent to the configured model provider. Local file bytes are not sent to the model provider by `browser_upload`; Chrome attaches the file, and the destination site receives it when the page submits. Debug logs and DSH attachments remain local until shared, but contain sensitive page/conversation data and may contain local file paths.

The extension requests broad host access plus side-panel, alarms, tabs, scripting, storage, debugger, downloads, web-navigation, clipboard, top-sites, bookmarks, and history permissions. Alarms wake and reconnect the background executor. Clipboard, download, upload, and personal-data access occur only through explicit user/model actions, not a background sync. Closing the panel hands execution back to the background worker; closing Edge stops browser execution.

Read `PRIVACY.md` for storage paths, Downloads confinement, redaction limits, clipboard behavior, and controls.

## Development and verification

```sh
npm test                       # unit/integration suite
npm run setup                  # idempotent profile/plugin validation
npm run system-prompt          # exact composed prompt; -- --json for counts
npm run bench                  # local bridge benchmark
```

Last recorded implementation verification (2026-11-11): **972/972 tests**, clean `npm ci` and `npm run setup`, an isolated real DSH `0.2.2-rc.1` runtime startup without model calls, `npm audit` with **0 vulnerabilities**, prompt composition (**18,076 total / 17,082 guidance chars**), mock-bridge `ui-preview --scenario plan` with fixed-viewport sticky-position and expanded/collapsed-height assertions plus inspected sticky/collapsed screenshots, and fresh isolated headless `edge-expect-e2e.mjs`, `edge-click-e2e.mjs`, and `edge-drag-e2e.mjs` runs (the drag suite passed twice including the mid-drag tab-switch case). A real-model extension-reload-mid-turn acceptance passed: the background executor reconnected and the turn continued to an independently verified result. The drag fixture used real provider/executor calls to verify pointer before/after reorder, accepted/refused HTML5 drops, static-source clone effects, native/custom sliders, long-press success/early no-op, intentional no-op, detached-rerender unknown, surface-unknown canvas/OOPIF drags, the mid-drag tab-switch refusal, and stale/ambiguous/off-screen/Docs guards. Independent checks inspected DOM order, values, parentage, drop receipts, and collateral application state; refused and intentional no-op cases preserved every semantic application value. Earlier expectation, click, capture, and file-transfer fixtures retained their evidence. Track A's A3 records each turn's model-reported DONE/PARTIAL/BLOCKED label, per-turn token usage (shown in the panel's finished-turn summary), and stopped-turn duration/failed-call stats in `chat.done`/`chat.stopped`; `scripts/analyze-failures.mjs` reports their distribution. These are direct executor and scripted-fixture checks, not real-model acceptance. **A real-sidebar/model `/plan` workflow, drag workflow and expectation workflow, download→upload workflow, authenticated Docs export/toolbar expectations and Docs table acceptance, authenticated Pivot, real-model HTML-table selection, normal authenticated docked-panel Docs acceptance, and a real docked-panel turn that keeps receiving views after the user switches apps or minimizes the browser remain pending.** No connected Docs browser is available; the new `scripts/model-eval.mjs` harness supplies an isolated real-model evaluation profile on demand for scripted scenarios, which is measurement and not a substitute for the pending docked-panel scenarios.

Useful harnesses:

- `scripts/edge-drag-e2e.mjs` — self-contained isolated provider/executor drag fixture with independent order/value/drop-receipt, clone, no-op, rerender, stale-view, and collateral-state checks.
- `scripts/edge-files-e2e.mjs` — self-hosted file-transfer fixture with independent source/download and multipart-received byte checks; requires an isolated Edge/CDP profile with a temporary Downloads preference.
- `scripts/edge-capture-e2e.mjs` — self-hosted isolated profile that verifies focused, unfocused, and minimized viewport captures at viewport × devicePixelRatio, with labelled-pixel checks, image-space clicks while unfocused/minimized, and unchanged window focus/state.
- `scripts/ui-preview.mjs` — mocked-bridge side-panel screenshots and UI assertions (disclaimer, slash palette, `/plan` activation/checklist/queue/race/outcome flows, pause-control absence and legacy-state migration, draft-view focus/attachments, disconnect cleanup) without a companion or model spend.
- `scripts/edge-expect-e2e.mjs` — isolated direct/batch expectation fixture with independent text, dialog, pixel, semantic, and mutation-state checks.
- `scripts/edge-click-e2e.mjs`, `edge-work-e2e.mjs`, `edge-canvas-e2e.mjs`, `edge-advanced-e2e.mjs` — direct real-extension fixture checks.
- `scripts/edge-find-e2e.mjs`, `edge-table-e2e.mjs`, `edge-dialog-e2e.mjs`, `edge-clipboard-e2e.mjs` — focused executor checks.
- `scripts/edge-docs-table-e2e.mjs` — disposable-document table workflow with independent compact-spacing, native-background, collateral, export, and reload-persistence checks; requires an isolated signed-in Docs profile.
- `scripts/edge-find-live-e2e.mjs`, `edge-table-live-e2e.mjs` — isolated real-sidebar acceptance harnesses.
- `scripts/model-eval.mjs` — real-model scenario harness: a recording fixture server, a second companion with its own temporary `.dsh-home`, and a fresh headless Edge with the unpacked extension, driven through the authenticated remote API. Each run gets a fresh chat, page load, and request log; checkers read independent page/fixture-server evidence and record wall time, steps, calls, failed calls, tokens, and final status. `--self-test` mutation-checks every checker without model spend; batch JSON goes under `e2e/baselines/`. Contract and coverage: `e2e/scenarios/README.md`.
- `scripts/analyze-failures.mjs` — reproducible failure report from the real run logs (per-tool failure rates, codes and normalized messages, repeated failures, stopped turns, percentiles, tokens, sites); `--logs`, `--since`, `--runs`, and `--json` are supported and the parser has synthetic-log tests.

Most fixture scripts need the static server and isolated Edge/CDP setup described in `HANDOFF.md`; the file-transfer script and the real-model harness start their own servers, and the model harness also starts its own companion, isolated DSH home, and Edge profile. Direct executor success is not model-driven acceptance. Use `e2e/checklist.md` for the real docked side panel and independent final-state checks.

## Troubleshooting

| Symptom | Check |
|---|---|
| Companion offline | Start `npm run dev`, then reconnect the panel |
| Invalid pairing token | Copy the current token into Settings; do not share it |
| No model/key configured | Enter the key, refresh models, select an image/tool-capable model, and save |
| Model list or key rejected | Check base URL, network access, account access, and key validity |
| Browser bridge disconnected | Reopen the side panel; it is the executor |
| Protected-page error | Switch to a normal HTTP(S) tab |
| Trusted input unavailable | Close DevTools on the tab and check debugger permission |
| Changes do not apply | Reload/reopen the extension; restart the companion for provider/config changes |

## Repository map

```text
companion/                         loopback bridge, DSH lifecycle, model config, logs
packages/dsh-browser-extension/   DSH provider, tools, guidance, provider guards
extension/                        MV3 side panel and browser executor
config/browser.patch.yml          DSH profile composition
e2e/                              fixtures, scripted real-model scenarios, live acceptance checklist
scripts/                          setup, development, benchmarks, Edge harnesses
docs/                             debug-log, benchmark, and UI references
```

For contributor context, start with `AGENTS.md`, `HANDOFF-QUICK.md`, and `HANDOFF.md`.
