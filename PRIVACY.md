# Privacy policy

**crazyAgent collects nothing.** There is no server, no account, no telemetry,
no analytics and no crash reporting — the extension never contacts anything
operated by its author. Everything it knows stays in your browser profile on
your machine, and the only place your data leaves is the AI provider *you*
configure, which is inherent to what the extension does.

Effective 2026-10-12 · applies to crazyAgent 0.1.0 and later.

## What is stored, and where

All of it is in `chrome.storage.local` — files inside your Chrome profile,
readable only by this extension. Nothing is uploaded, and nothing is written to
`chrome.storage.sync`, so none of it follows you to other devices.

| Key | Contents | Cap |
|---|---|---|
| `baConv:<id>` + `baConvIndex` | Conversations: your task text, the agent's replies, tool calls and results | 50 newest |
| `baLog:<id>` + `baLogIndex` | Run logs for debugging: steps, tool text, model reasoning, truncated results | 200 runs; 8,000 chars per field |
| `baLessons` | Short notes the agent writes to itself about sites it has driven, each carrying the task it came from | 300 lessons; 400 chars note, 300 evidence, 200 task |
| `baSkills` | Reusable procedures the agent has learned | 6,000 chars per skill, 12 sections |
| `baHistory` | Task + one-line summary of recent runs, for autocomplete | 20 |
| `baSettings` | Provider, base URL, model, and **your API key in plaintext** | — |
| `baPolicyAlways` | Which sensitive actions you clicked "Always allow" on | — |

Caps are enforced oldest-first: writing the 51st conversation evicts the
oldest one. This is a size guard, not a privacy promise, but it does mean the
store cannot grow without bound.

## Screenshots

The agent takes screenshots to see the page. They are held **in memory only**
(`chrome.storage.session`, which is RAM and dies with the browser) and sent to
your model during the run. Before a conversation or log is ever written to
disk, every image payload is stripped from it — a stored thread keeps the tool
cards and their text results, minus the bytes. Close the browser and the
captures are gone; no screenshot is ever persisted.

## Where your data goes

Three destinations for your data, all of them yours:

1. **Your AI provider.** The task, the page text the agent reads, the
   screenshots, and your API key go to the base URL you typed in Settings.
   There is no author-side proxy or relay — the request goes from your browser
   straight to that endpoint. Whatever that provider's own policy says about
   the traffic you send it applies here. Point it at a local model and the data
   never leaves your machine.
2. **The websites you drive.** The agent navigates, reads and acts as you, so
   those sites see requests from your browser exactly as they would if you were
   clicking yourself. That includes any document export the agent fetches (for
   example from `docs.google.com` when summarizing a Google Doc).
3. **The optional Jev risk gate** — off by default. If you turn it on and give
   it a key, a description of each pending sensitive action goes to that
   provider (TypeSafe or OpenRouter) for a second opinion before the agent
   acts.

Nothing else leaves the extension. There is no update check, no ping and no
beacon in the extension itself. The one exception is deliberate and
user-initiated: clicking **Privacy** in Settings opens this document at
`github.com` in a new tab, and GitHub then sees an ordinary page request from
your browser. The separate `update.sh` shipped in the release zip — which you
run by hand, and which the extension never invokes — makes a plain HTTPS GET to
GitHub to fetch the newest zip. Neither sends anything about you beyond what any
HTTP request carries.

## Your API key

It is stored **in plaintext** in `chrome.storage.local`, because an extension
has no secure keystore to put it in. It is only ever sent to the base URL you
configured. Anyone with access to your machine or your Chrome profile can read
it, so treat that profile accordingly. Delete it from Settings, or remove the
`baSettings` key, to revoke it locally — you still need to rotate it at the
provider.

## Keeping, deleting, uninstalling

Every category above has a control in the panel: delete a conversation, clear
or delete run logs, clear or delete lessons. Deleting removes the keys from
storage immediately; there is no trash and no copy elsewhere, because there is
nowhere else. **Uninstalling the extension deletes everything it wrote** —
Chrome discards the extension's storage with it.

## Permissions

The extension asks for a lot, because driving a browser is a lot. What each one
is actually used for:

| Permission | Used for |
|---|---|
| `debugger` | Chrome DevTools Protocol: clicking, typing, navigating and capturing screenshots |
| `scripting`, `activeTab`, `tabs`, `<all_urls>` | Reading page structure to build element refs, and acting in the tabs the agent drives |
| `sidePanel` | The panel UI itself |
| `storage`, `unlimitedStorage` | The local store described above |
| `alarms` | Keeping the service worker alive mid-task, so a long run is not killed |
| `bookmarks`, `topSites` | The `bookmarks_search` / `topsites_list` tools — finding where your sites live |
| `downloads` | The `download` tool, and reading back files the agent is asked to fetch |
| `offscreen`, `clipboardWrite` | An offscreen document, the only way to write to the clipboard from a worker |
| `nativeMessaging` | Talking to the optional local helper daemon for Unlimited mode |

**Declared but unused:** `cookies`, `webNavigation`,
`declarativeNetRequest` and `declarativeNetRequestFeedback` appear in the
manifest but nothing in the source calls them. They are leftovers from earlier
designs rather than hidden behaviour: no code path reads a cookie or inspects a
navigation. The network mocking and rewriting Unlimited mode offers is not
`declarativeNetRequest` either — it goes over CDP (`Fetch.*`) through the local
helper daemon you install yourself, on a profile you dedicated to it.

Note that `host_permissions: ["<all_urls>"]` is what lets the agent work on any
site you ask it to. It is broad by design; the agent operates one window, and
sensitive actions are gated behind a confirmation prompt. See
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) for what it can and cannot do.

## Children

The extension collects nothing and has no server, so there is no data about
anyone — including children — for it to hold or share. It does give an AI model
control of a browser, which is a supervision question rather than a privacy
one.

## Changes

This file is the policy. It lives in the repository, so changes are visible in
the commit history; there is no notification channel. If the behaviour it
describes ever changes, this changes with it.

## Contact

Open an issue at <https://github.com/conan-8/crazyAgent/issues>. Questions
about this policy are welcome there.
