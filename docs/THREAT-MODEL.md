# Threat model — what this agent can and cannot do

**Trust boundary.** The agent runs with your browser profile and your API key.
A capable model driving these tools can do essentially anything a careful
human can do in the tab: read page content, act on your accounts, post
messages, spend money. Treat a running task with the same caution as handing
your unlocked laptop to a stranger — the gates below reduce, not eliminate,
that risk.

## Controls

- **Gated autonomy (Phase 6 policy).** Always-confirm rules:
  - `evaluate_js` — arbitrary script execution
  - typing into `input[type=password]`
  - form submission (submit-button click, typed submit, Enter in a form)
  - purchase/checkout navigation and purchase-control clicks (URL/text heuristics)
  - `download`
  - `network_mock` / `network_rewrite` — traffic modification
  Each prompt offers **Allow once / Always allow / Deny**. "Always allow" is
  persisted per rule (`chrome.storage.local`, `baPolicyAlways`) and can be
  cleared by removing that key.
- **Cooperative stop** between tool calls (interruptible step waits).
- **Step cap** (default 40) bounds runaway loops; malformed tool calls abort
  after 3 consecutive failures.
- **Checkpointing** (`chrome.storage.session`) makes runs auditable and
  resumable; history of recent tasks is kept (`baHistory`).

## Limits of the heuristics

- Purchase/form detection is URL + button-text regex — a checkout button
  labeled "Continue" will not match. The password gate is the most reliable;
  the purchase gate is best-effort.
- Deny cancels the specific tool call; the model may attempt an equivalent
  action through another tool. Watch the transcript.
- "Always allow" persists silently; revisit it deliberately.

## Secrets

- API key lives in `chrome.storage.local` in cleartext (personal-use
  assumption). Anything running as your user can read it. Use a scoped,
  low-limit key where the provider supports it.
- The helper daemon (`helper/`) runs as your user with stdio framed JSON from
  the extension only (`allowed_origins` pins it to the extension id). It can
  drive the browser it attaches to and nothing else.

## Unlimited mode specifics

- Full CDP means the tool layer is the only gate — there is no platform
  enforcement below it (that is the point). `network_mock`/`network_rewrite`
  are therefore gated tools.
- Unlimited mode operates on the dedicated profile (`helper/profile-setup.sh`).
  Keep high-value logins out of it if you want a smaller blast radius; use
  Standard mode for logged-in browsing.

## Out of scope

- Multi-user isolation, enterprise policy compliance (Chrome 155+ managed
  browsers may reject `chrome.debugger.attach` outright — handled gracefully),
  anti-stealth/anti-bot bypassing, sandboxing the LLM from the page.
