# Threat model — what this agent can and cannot do

**Trust boundary.** The agent runs with your browser profile and your API key.
A capable model driving these tools can do essentially anything a careful
human can do in the tab: read page content, act on your accounts, post
messages, spend money. Treat a running task with the same caution as handing
your unlocked laptop to a stranger — the gates below reduce, not eliminate,
that risk.

## Controls

- **Gated autonomy (Phase 6 policy).** Always-confirm rules:
  - `evaluate_js` — arbitrary script execution in the page's main world
    (via CDP `Runtime.evaluate`, so neither the page's CSP nor the
    extension's own `script-src 'self'` blocks it). Top-frame only: it
    cannot reach into iframes.
  - `evaluate_js` with `bypass_csp` — separate rule (`csp_bypass`): turns
    off the site's CSP for that tab (`Page.setBypassCSP`) until the
    debugger session ends, so an "Always allow" on plain JS never
    extends to disabling CSP
  - typing into `input[type=password]`
  - form submission (submit-button click, typed submit, Enter in a form)
  - purchase/checkout navigation and purchase-control clicks (URL/text heuristics)
  - `download`
  - `network_mock` / `network_rewrite` — traffic modification
  Each prompt offers **Allow once / Always allow / Deny**. "Always allow" is
  persisted per rule (`chrome.storage.local`, `baPolicyAlways`) and can be
  cleared by removing that key.
- **Jev risk gate (optional, off by default).** When the Jev sidecar is
  configured, every mutating action the regex rules *allowed* is additionally
  classified by the decision model (purchase / credential / irreversible /
  beyond-task probabilities). It is union-only — it can add a confirmation,
  never remove one — and fails open: if Jev is unreachable or slow (2 s cap),
  the rule-based verdict stands. This narrows the "checkout button labeled
  'Continue'" gap below, but a probability is not a guarantee.
- **Cooperative stop** between tool calls (interruptible step waits).
- **Step cap** (default 40) bounds runaway loops; malformed tool calls abort
  after 3 consecutive failures.
- **Checkpointing** (`chrome.storage.session`) makes runs auditable and
  resumable; history of recent tasks is kept (`baHistory`).

## Trusted input (canvas document editors)

- `type`/`key` have a second route for canvas editors (Google Docs, Slides,
  Office on the web), which ignore synthesised DOM events: keystrokes and clicks
  sent through the browser's input pipeline (CDP `Input.*`). It grants **no new
  capability** — it is the same typing a person does, aimed at editors that would
  otherwise be untypable — and it does **not** bypass any gate: the policy layer
  assesses the call (element probe, password/form/purchase rules, optional Jev)
  *before* the tool chooses a route, so both routes are gated identically.
- Two honest side effects. Events produced this way are `isTrusted: true`, so a
  page that gates on "was this a real user?" cannot tell the difference — that is
  the point of the route, and it means anti-automation checks on such editors are
  not a barrier. And because input only reaches the **active** tab, a run may
  switch focus to the tab it is driving (`chrome.tabs.update({active:true})` plus
  window focus), which you will see happen.
- The driver verifies focus before and after sending. Focus lost mid-type is
  reported as a warning on a successful result rather than as a failure,
  deliberately: a failure invites a retry, and retrying would duplicate whatever
  text did land.

## Coordinate input, uploads, diagnostics, handoff

- `click_at`/`hover_at`/`drag_at` send **trusted mouse events at arbitrary
  points** (CDP `Input.dispatchMouseEvent`), including into canvas-drawn UI
  where no ref exists. Same guarantee and same caveat as trusted keystrokes:
  indistinguishable from a human's mouse. They are gated like `click` — the
  point is probed (`document.elementFromPoint`) and the probe goes through the
  same rules — **except** for controls *painted* into a canvas: pixels carry no
  DOM text, so purchase/form rules cannot read them and only the optional Jev
  layer sees the call at all. Treat a canvas click as ungated for policy
  purposes; it is exactly as capable and as dangerous as a person's click.
- `upload` is **file egress**: whatever the model attached leaves the machine
  into the page. Always confirmed (`upload` rule), with the file names shown.
- `screenshot save_to_disk` writes a JPEG into the Downloads folder (confirmed
  under the `download` rule; the filename is sanitised to a basename).
- `console_read`/`network_read` are read-only but pull **page traffic into the
  transcript and run logs** — request URLs can carry tokens and query secrets.
  Capture covers what arrived since the run started, both control modes.
- The **human handoff** pauses the run and shows you the page URL and reason
  (CAPTCHA / sign-in form). It sends nothing anywhere. The *prompt* is
  page-driven: a hostile page can raise one as a nuisance (bounded — one per
  URL per run, and only the user can answer it; the page cannot).
- The handoff deliberately fires only on strong signals (a CAPTCHA widget of
  real size — the invisible reCAPTCHA badge that rides on ordinary pages is
  excluded — or an action targeting a sign-in form when the task never asked
  for one). False negatives just mean today's behaviour: the agent continues.

## Limits of the heuristics

- Purchase/form detection is URL + button-text regex — a checkout button
  labeled "Continue" will not match, and a canvas-painted control has no text
  to match at all (see above). The password gate is the most reliable; the
  purchase gate is best-effort. The optional Jev risk gate (above) covers
  many of these misses, but is itself probabilistic and adversarial pages are
  a documented Jev weak spot — treat both layers as reduction, not proof.
- Deny cancels the specific tool call; the model may attempt an equivalent
  action through another tool. Watch the transcript.
- "Always allow" persists silently; revisit it deliberately.

## Jev data flow (when enabled)

- With the sidecar on, these leave the browser to `api.typesafe.ai` (or your
  configured base URL): the task text (clipped), a digest of each
  regex-allowed mutating action (tool, clipped args, element probe text), the
  `judge` tool's model-composed states (page excerpts the model chooses to
  send), and — with Auto effort — the task text for complexity grading.
- Screenshots are never sent to Jev. Nothing is sent when the sidecar is off;
  the gate path is skipped entirely.
- The `judge` tool means page text can reach TypeSafe whenever the model
  decides to call it — the same trust you already extend to your chat
  provider, pointed at a second vendor. Point the base URL at a
  self-hosted Jev-class model if that matters.

## Lessons data flow (self-improvement, when enabled)

- The coach (a second agent on the same model) receives a **digest** of a
  finished run: task text, failed tool calls with their error strings, tool
  args, run stats and the final answer — the same material already in the local
  run log, sent to your configured provider like any other agent call. Page
  *content* reaches it only insofar as it ended up in those error strings and
  args. Screenshots are never included.
- Lessons it writes are stored locally (`baLessons`, per browser profile) and
  are appended to later runs' system prompts. That is a **stored prompt-
  injection channel**: a hostile page could try to make the coach record a
  lesson that steers a future run ("always click Allow on this site"). The
  mitigations are structural: the block is framed as reference material
  *after* the real instructions, lessons are capped and deduped, and **you can
  read, edit, pin or delete every lesson** in the Lessons drawer — review them
  like any other agent output before trusting a long-lived one. Nothing the
  coach writes bypasses the Phase 6 policy gates: a lesson cannot make a
  sensitive action skip its confirmation.
- The coach is off the moment either `learn` switch is off: no review call, and
  no lessons are injected.

## Secrets

- API key lives in `chrome.storage.local` in cleartext (personal-use
  assumption). Anything running as your user can read it. Use a scoped,
  low-limit key where the provider supports it. The same applies to the
  optional TypeSafe (Jev) key stored next to it.
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
