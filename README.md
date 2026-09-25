# crazyAgent — an AI browser agent as a Chromium sidebar

A Chromium (Manifest V3) extension whose **side panel** hosts an AI agent that
operates your real browser to complete web tasks ("find the cheapest X and add
it to cart", "fill this form", "summarize my open tabs"). It runs in two
control modes behind one adapter interface:

| Mode | Transport | Powers | Cost |
|---|---|---|---|
| **Standard** | `chrome.debugger` (CDP) | click/type/navigate by element refs, screenshots, cross-origin frames, SPA-safe refs | yellow "extension is debugging this browser" banner (unhideable per [crbug 41302695](https://issues.chromium.org/issues/41302695)) |
| **Unlimited** | native-messaging helper daemon ↔ full CDP | everything above **plus** network mock/rewrite/observe, all targets, no banner | requires `helper/install.sh` and a dedicated (cloned) profile — see below |

Both modes drive the same tool surface (`snapshot`, `click`, `type`,
`screenshot`, `navigate`, `network_mock`, …) and the same streaming tool-call
agent loop, with per-step checkpointing (a killed service worker resumes the
task) and gated autonomy (one-click confirmation for sensitive actions).

## Install (personal use, unpacked)

```sh
npm install && npm run build        # produces dist/
```

1. Open `chrome://extensions` (or Edge/Brave equivalent), enable Developer
   mode, **Load unpacked → `dist/`**. Note the extension id.
2. (Unlimited mode only) `sh helper/install.sh <extension-id>` then restart
   the browser.
3. (Unlimited mode only) `sh helper/profile-setup.sh` once to clone your
   default profile (cookies/logins) into the dedicated automation profile.
4. Click the toolbar icon → the side panel opens. In **⚙ Settings** choose a
   provider (Anthropic or any OpenAI-compatible endpoint: OpenAI, OpenRouter,
   DeepSeek, local Ollama/vLLM…), model and API key, plus the control mode.
   Optionally add a key under **Fast decisions (Jev)** — a
   [TypeSafe key](https://console.typesafe.ai/keys) or your OpenRouter key —
   see below.

> Why a cloned profile for Unlimited mode: since Chrome 136,
> `--remote-debugging-port` is ignored on the default user-data-dir (Google's
> anti-cookie-theft hardening, [announcement](https://developer.chrome.com/blog/remote-debugging-port)).
> Unlimited mode therefore runs a non-default profile; `profile-setup.sh`
> clones the login-bearing parts (works on Linux; elsewhere you may sign in
> once inside the automation profile).

## Use

The panel is a **chat**: type a task and hit **Run** (or Enter). Your message
appears as a bubble; the agent's streamed reply lands in its own bubble with
collapsible **tool cards** (expand for args/results, click thumbnails to zoom).
Sensitive actions (typing passwords, form submission, purchases/checkout,
downloads, `evaluate_js`, network modification) pause with **Allow once /
Always allow / Deny** cards; denies return a cancellation the model works
around. **Stop** aborts between steps.

**Madman mode** (Settings → Madman mode) makes the agent swear. Every tool
call is labelled with a cuss word, and the agent narrates setbacks in the
middle of a run in character — "Because this shit ass site is so fucking slow
I have to scroll the whole goddamn list by hand." Off by default; the toggle
only changes the voice, never the facts or the safety gates.

**Fast decisions (Jev)** (Settings → Fast decisions) pairs your selected model
with [Jev](https://typesafe.ai/), TypeSafe's "System One" decision model — a
calibrated classifier that answers typed yes/no, choice and score questions in
milliseconds instead of a full LLM round-trip. It never replaces your chat
model; it works alongside it in three places: risky actions the keyword rules
missed get a confirmation card ("Jev flags this as likely completing a purchase
(95%)"), the agent gains a `judge` tool that settles bulk per-item decisions
(relevance filters, best-of picks) in one near-free call, and optional **Auto
effort** lets Jev grade each task and lower reasoning effort on trivial ones.
Everything fails open: if Jev is slow, down or unconfigured, runs proceed on
the rule-based policy exactly as before. Off by default; needs a key.

**Two Jev endpoints** (Settings → **Jev endpoint**). **TypeSafe** is Jev proper:
calibrated probabilities, answers in milliseconds ($0.042/M input tokens, output
free — [key](https://console.typesafe.ai/keys)). **OpenRouter /
OpenAI-compatible** sends the same typed questions to any `/chat/completions`
endpoint, so an OpenRouter key drives the whole sidecar too. Note OpenRouter
routes **no** Jev model and does not implement `/systemone`, so this transport is
a full model round-trip per decision: slower than TypeSafe, and its
probabilities are model-estimated rather than calibrated. Pick a model that
supports structured outputs (the default, `openai/gpt-oss-20b`, does). The three
features, the gating rules and the fail-open behaviour are identical on both
transports.

**Chat history**: every task is a thread. **History** lists past threads
(title, time, turn count) — click one to reopen its transcript, **✕** to
delete, **New chat** to start fresh. Typing into an open thread continues it
with full prior context (the follow-up really sees the earlier turns).

**Run logs**: the **Run logs** button (next to History) archives every task
locally in `chrome.storage.local` — one timestamped record per run, split into
turns, each turn carrying its start time, duration and token stats, and each
tool call its raw args, result and how long it took. Records survive worker
teardown and browser restarts. Open one for a per-turn timeline, or **Export
JSONL / Export MD** to write the whole archive (or a single run) into your
Downloads folder for keeping alongside the project. Demo runs aren't logged.

**Lessons (self-improvement)**: this agent fails a lot, so it keeps notes on
itself. When a run ends badly — it errored, you stopped it, or it looped on a
tool call that kept failing — a **second agent on the same model** reads that
run's record and writes down what went wrong and what to do instead. Lessons
live in `chrome.storage.local` **per browser profile** (key `baLessons`, ring
of 300, deduped by wording) and the relevant ones are appended to the system
prompt of later runs, so a failure you already paid for is not repeated
blindly. Clean runs are not reviewed automatically: the **Lessons** drawer
reviews the latest run on demand, and **Learn from this run** in the Run logs
detail reviews any archived run. There you can read, edit, pin, delete and
export what it remembers — the user owns what the agent is allowed to learn.
Settings → **Self-improvement** has two switches: *Learn from my runs* (master:
lessons are applied AND new ones are written) and *Review failed runs
automatically* (off = manual reviews only; lessons still apply). Lessons are
framed as reference material appended after the real instructions, never as
rules that could outrank your task, and a review can never touch the page, your
chat thread or the run archive.

## Development

```sh
npm run watch        # rebuild on change (then reload the extension)
npm test             # unit tests (vitest)
npm run typecheck
npm run verify       # full suite: unit + every phase's real-browser smoke
```

`npm run verify` boots a real Edge/Chrome with the built extension and drives
it over CDP against a local fixture site and a scripted mock LLM (real
HTTP/SSE in both wire protocols). See `docs/DEV.md` for architecture,
workflow and how to add tools/providers; `docs/THREAT-MODEL.md` for what the
agent can and cannot do to you.

## Layout

```
extension/src/shared/      protocol + LLM wire types, run-log and lesson folders
extension/src/background/  service worker, agent loop, tools, adapters, policy, coach
extension/src/content/     per-frame element registry, actions, settle detector
extension/src/sidepanel/   panel UI (chat, tool cards, confirm cards, settings)
helper/                    native-messaging daemon (Unlimited mode) + installers
e2e/fixture/               test site (forms, SPA, cross-origin iframe, API page)
scripts/                   phase smoke drivers + verify orchestrator
```

## Status

Verified end-to-end by phase-level acceptance smokes (see `docs/DEV.md`):
lifecycle/checkpointing survives a 10-minute task and worker teardown;
perception handles cross-origin frames and shadow DOM; actions recover from
SPA re-renders or fail cleanly; the agent loop streams and tools correctly on
both provider wire formats; the UI and policy gates behave as specified; the
helper daemon serves full CDP including network interception and crash
recovery; the Jev sidecar gates, judges, routes effort and fails open on both transports
(`scripts/jev-smoke.mjs`, mock `/systemone` + `/chat/completions` endpoints);
the coach reviews a failed run, stores the lesson, feeds it into the next run's
prompt and stays out of the chat/run record, with both switches honoured
(`scripts/lessons-smoke.mjs`); `evaluate_js` evaluates over CDP in the page's
main world, so it keeps working on strict-CSP sites like Google Docs and
Schoology that refuse isolated-world `eval`, and reports a CSP refusal with the
retry that actually helps (`scripts/evaluate-csp-smoke.mjs`). A
live-LLM run ("search Hacker News for X and summarize") needs your API key in
Settings — the machinery is covered by the mock-LLM suite.
