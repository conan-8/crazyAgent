# crazyAgent development contract

## Change one observable milestone at a time

Define the smallest user-visible behavior that can be checked independently, take a real-run baseline, change one main thing, then rerun the same scenario from the same initial state. Compare success, partial completion, and collateral edits; wall time, model steps, and tool calls; failed calls, retries, and wrong-target actions (even if repaired); and tokens when relevant.

Keep the model and reasoning effort fixed for comparisons. Acceptance uses **medium effort**, which is also the default; do not compare with older off/low runs. A recovered mistake is still reliability evidence.

## Independent checks decide

Logs, screenshots, model reasoning, `turn.ok:true`, `changed:true`, DOM mutations, trusted input, pixel differences, and the agent saying "done" are diagnostics, not proof. Inspect the resulting browser or document state independently of the tool result and final answer. With no checker, ask the user for a verdict: correct, partial, wrong, or blocked. Use console probes only for a specific diagnostic or ground-truth question.

## Regression gates

Use the cheapest gate that can detect the change, then the next:

1. `npm test` for contracts, validation, serialization, and state handling.
2. Real-extension fixture suites for executor changes (`scripts/edge-*-e2e.mjs`). They inspect page state directly but do not evaluate model decisions.
3. A complete real-sidebar scenario for behavior changes, from a known initial state with independent final-state inspection. `scripts/model-eval.mjs` runs scripted real-model scenarios on an isolated profile with independent checkers.

Panel UI changes also run `scripts/ui-preview.mjs --scenario <name>` (mock bridge). Never present unit tests, mock-bridge previews, or direct-executor suites as real-model acceptance. Repeat important model-driven scenarios enough to tell a lucky run from reliability.

## Current focus: Google Docs and semantic editing

Use Docs as a stress test for transferable primitives: exact text targeting, selection, canvas input, layout, menus, and verification. Prefer stable semantic operations for repeated dependent workflows without weakening the general browser tools. Keep stale-view, ambiguity, wrong-target, scoped-recovery, native-dialog, and verification safeguards; if a UI transition invalidates coordinates, avoid coordinates or keep explicit operation state rather than relaxing guards.

Priorities: (1) exact deletion/replacement preserving formatting and neighbors; (2) formatting an exact unique or explicitly ordinal range; (3) compound document creation and formatting in a fresh disposable document; (4) authenticated semantic-table acceptance with collateral-cell and persistence checks. Duplicate text needs an explicit ordinal; never alter an arbitrary occurrence.

## Invariants to keep

- **Tools:** 34 standing model-facing tools (25 general, 8 guarded Docs, `agent_request_help`); `/plan` adds `browser_plan` for one armed turn only, and the companion's opt-in `confirmIrreversible` setting adds `agent_request_confirmation` for its turns only (both conditionals can coexist). Mutations run exclusively in model order; only `browser_tabs`, `browser_places`, `browser_read_text`, `browser_docs_read`, and `browser_downloads` are parallel-safe.
- **Fail closed:** ambiguity, stale or drifted views, unsupported frames, paths outside Downloads, and unavailable colors fail with a code instead of guessing or substituting. ctrl/cmd+W is rejected in code.
- **Refusals stay refusals:** a pre-input `STALE_VIEW`/`AMBIGUOUS_VIEW`/`NO_VIEW` refusal of `click_at`/`select`/`drag` returns `attempted:false` with a fresh full view (text starts `refused <CODE>:`, counted as a failed call), and the same coordinates stay refused until re-measured on a newer view. A drag or selection on an iframe/canvas/video surface reports `unknown`, never a measured no-op. After two consecutive `SIDE_PANEL_CLOSED` results, browser calls fail at once until one succeeds or a new turn starts.
- **Evidence is separate from outcome:** results keep `observed`, `expectation`, `outcome`, and `mutationPossible` apart. A failed expectation never triggers re-aiming, retry, or re-mutation. DOM readback is not server persistence. Model-reported `DONE`/`PARTIAL`/`BLOCKED` labels, completed plan items, and `docsVerification` are not verification.
- **DSH deep-freezes committed session events:** never annotate `turn/end`. Help, confirmation requests, plan outcomes, and Docs verification travel as bridge activities (`help-request`, `confirm-request`, `turn-outcome`) accepted only for the active turn and session.
- **Confirmation is opt-in and model-reported:** with `confirmIrreversible` off, behavior is exactly as before. With it on, the model is told to ask before irreversible actions and the chat waits for an Approve/Deny that the companion writes as the next turn's `<user_confirmation>` block; nothing in the executor enforces the gate yet (B9c measures compliance before deciding on a backstop). A confirmation wait is not verification that the action was safe.
- **One runner, one turn slot:** chat, new, stop, resume, steer, and snapshots go through `companion/session-controller.mjs`, shared by the panel and the remote API.
- **Remote API** (`--remote`, `127.0.0.1:17873`, tailnet-only Serve, its own `0600` token) can never claim `ui`/`tools`, send browser commands, configure the LLM, or read arbitrary files. Port `17872` is the e2e fixture server.
- **One executor at a time:** the side panel or the background service worker, handed over explicitly. System-clipboard work needs the panel.
- **What people see:** no hitboxes on the page (they are drawn only into the model's copy of a capture; people get the clean `displayImage`), and one yellow agent cursor that fades out for every capture.
- **Android:** the reducer must match frames recorded from the real `RemoteHub` (`npm test` fails when stale). Toolchain under `~/Android`. No Firebase project exists, so push has never been sent.
- **Prompt budget:** model guidance stays under the test-enforced 17,100-character ceiling.

## Status and evidence

[`docs/STATUS.md`](docs/STATUS.md) holds the detailed behavior snapshot, the latest verification numbers, and the long list of real-model, phone, and Docs acceptance that is **still unrun**. Read it before claiming anything works end to end. `HANDOFF-QUICK.md` has resume state, `HANDOFF.md` architecture, and `e2e/checklist.md` acceptance scenarios. Turn-by-turn history belongs in `.dsh-home/browser-agent/logs/`.

## Repository safety

- Do not fork DSH core or hand-edit generated `.dsh-home/browser-agent/llm.patch.yml`.
- Do not run live-model acceptance in unit tests; use fake bridges or isolated browser profiles. Keep test credentials and user data isolated.
- Never kill browsers by executable path. Stop only PIDs/PGIDs you started, scoped to the test profile.
- Reload the unpacked extension and reopen its panel after `extension/` changes. Restart the companion after companion, provider, or config changes.
- When changing documented behavior, update this file, `docs/STATUS.md`, or the relevant project doc in the same change.
