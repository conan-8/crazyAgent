// Trusted input — the CDP half. Sends keystrokes and clicks through the
// browser's own input pipeline (`Input.insertText`, `Input.dispatchKeyEvent`,
// `Input.dispatchMouseEvent`) instead of synthesising DOM events from a content
// script. See shared/trusted-input.ts for why (canvas editors ignore everything
// that is not a real key event) and for the pure key/plan/detection helpers.
//
// Measured on a real browser with both transports this extension supports:
//   - `chrome.debugger` (Standard mode) permits the whole Input domain —
//     insertText, dispatchKeyEvent, dispatchMouseEvent all accepted; the helper
//     daemon (Unlimited mode) is NOT required to type into Google Docs.
//   - Events arrive in the page as `isTrusted: true`, including inside a focused
//     same-origin iframe sink (Docs' text-event-target shape).
//   - Ctrl+B arrives as `keydown(mod=ctrl)` plus `beforeinput(formatBold)`: the
//     browser's editing engine handles the shortcut, which is what a rich editor
//     listens for. Enter arrives as `beforeinput(insertParagraph)`.
//   - Input only reaches the ACTIVE tab's render widget. On a background tab the
//     command resolves successfully and does NOTHING — so the tab is activated
//     first and focus is verified, because a silent no-op is exactly the kind of
//     failure that sends a run into a retry loop.
import type { ActionResult } from "../../content/actions";
import {
  keyEventParams,
  parseKeyCombo,
  planTyping,
  trustedInputFailure,
  type InputHints,
} from "../../shared/trusted-input";
import type { BrowserAdapter } from "../adapters/types";
import { runContentAction } from "./content-action";

/** Let the renderer own the tab before sending input to it. */
const ACTIVATE_SETTLE_MS = 120;
/** Editors process input asynchronously; a beat between steps keeps order. */
const BETWEEN_STEPS_MS = 16;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make this tab the one the browser will deliver input to. Best effort: a tab
 * that is already active costs nothing, and a failure here is reported by the
 * Input call that follows rather than guessed at.
 */
export async function ensureTabActive(
  tabId: number,
  adapter: BrowserAdapter,
): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    }
  } catch {
    // tab closed or the API is unavailable — the next call will say so
  }
  // bringToFront is the full-CDP equivalent; harmless when already frontmost.
  try {
    await adapter.send(tabId, "Page.bringToFront", {});
  } catch {
    // Page may be unavailable on this transport; Input still works without it
  }
  await sleep(ACTIVATE_SETTLE_MS);
}

export interface FocusState {
  focused: boolean;
  hints: InputHints;
}

/** Focus a ref in its own frame and report what that frame looks like. */
export async function focusTarget(
  tabId: number,
  ref: string,
): Promise<FocusState | { error: string }> {
  const res = await runContentAction(tabId, { action: "focus", ref });
  if (!res.ok) return { error: String(res.error ?? "could not focus the target") };
  const data = (res.data ?? {}) as Partial<FocusState>;
  return { focused: data.focused === true, hints: data.hints ?? {} };
}

/** The centre of the top document's first canvas, in viewport coordinates. */
async function canvasPoint(
  tabId: number,
): Promise<{ x: number; y: number } | null> {
  const res = await runContentAction(tabId, { action: "canvasPoint" });
  if (!res.ok || !res.data) return null;
  const p = res.data as { x?: number; y?: number };
  return typeof p.x === "number" && typeof p.y === "number" ? { x: p.x, y: p.y } : null;
}

async function clickPoint(
  tabId: number,
  adapter: BrowserAdapter,
  point: { x: number; y: number },
): Promise<void> {
  const common = { x: point.x, y: point.y, button: "left" as const, clickCount: 1 };
  await adapter.send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await adapter.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  await adapter.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
}

export interface TrustedInputRequest {
  tabId: number;
  adapter: BrowserAdapter;
  /** Frame-scoped ref of the typing target; omitted = whatever is focused. */
  ref?: string;
  text?: string;
  key?: string;
  submit?: boolean;
  /** Why the trusted route was chosen — echoed into the result for run logs. */
  reason: string;
}

/**
 * Type text or press a key as the browser would. The caller has already decided
 * this route is needed (`shouldUseTrustedInput`); this owns the sequence:
 * activate the tab → focus the sink → send → verify focus survived.
 */
export async function runTrustedInput(
  req: TrustedInputRequest,
): Promise<ActionResult> {
  const { tabId, adapter } = req;
  await ensureTabActive(tabId, adapter);

  let focusState: FocusState | null = null;
  let primed = false;
  if (req.ref) {
    const first = await focusTarget(tabId, req.ref);
    if ("error" in first) return { ok: false, error: first.error };
    focusState = first;

    // Recovery, not the normal path: if the sink would not take focus, do what
    // a person does — click the document once. Editors move focus into their own
    // sink in response, which is the only reliable way to wake some of them.
    if (!focusState.focused) {
      const point = await canvasPoint(tabId);
      if (point) {
        try {
          await clickPoint(tabId, adapter, point);
          primed = true;
          await sleep(ACTIVATE_SETTLE_MS);
        } catch {
          // a failed prime is not fatal; the focus check below decides
        }
      }
      const again = await focusTarget(tabId, req.ref);
      if ("error" in again) return { ok: false, error: again.error };
      focusState = again;
    }
    if (!focusState.focused) {
      return {
        ok: false,
        error: trustedInputFailure(
          `the typing target (${req.ref}) would not take focus${primed ? ", even after a trusted click on the document surface" : ""}`,
          "nothing was typed. Take a fresh snapshot and target the editor's hidden text sink (the editable ref in its own frame, often N#1), or navigate to the document first if it is still loading.",
        ),
      };
    }
  }

  const steps = req.key !== undefined
    ? [{ kind: "key" as const, key: req.key }]
    : planTyping(req.text ?? "", { submit: req.submit });

  let inserted = 0;
  let keysSent = 0;
  for (const step of steps) {
    if (step.kind === "insertText") {
      await adapter.send(tabId, "Input.insertText", { text: step.text });
      inserted += step.text.length;
    } else {
      const parsed = parseKeyCombo(step.key);
      if (!parsed.ok) {
        // A character with no key mapping (accented, emoji, CJK) is text: the
        // IME path is the correct primitive for it anyway.
        if (step.key.length === 1) {
          await adapter.send(tabId, "Input.insertText", { text: step.key });
          inserted += 1;
          continue;
        }
        return {
          ok: false,
          error: trustedInputFailure(
            parsed.error,
            "use `type` to insert that character, or a combo from the key table (Enter, Escape, Tab, Backspace, Delete, arrows, Home/End, PageUp/PageDown, F1-F12, letters, digits, punctuation, with Control/Shift/Alt/Meta).",
          ),
        };
      }
      await adapter.send(tabId, "Input.dispatchKeyEvent", keyEventParams(parsed.parsed, "down"));
      await adapter.send(tabId, "Input.dispatchKeyEvent", keyEventParams(parsed.parsed, "up"));
      keysSent += 1;
    }
    await sleep(BETWEEN_STEPS_MS);
  }

  // Did focus survive? Losing it mid-type means part of the text may have gone
  // elsewhere — reported as a warning, NOT as a failure, because a retry would
  // duplicate whatever did land.
  let focusHeld = true;
  if (req.ref) {
    const after = await focusTarget(tabId, req.ref);
    focusHeld = "error" in after ? false : after.focused;
  }

  const parts = [
    `sent as real keystrokes via the browser input pipeline (${req.reason})`,
    inserted ? `${inserted} char(s) of text` : null,
    keysSent ? `${keysSent} key press(es)` : null,
    primed ? "the document surface was clicked once first to take focus" : null,
    focusHeld
      ? null
      : "WARNING: the target lost focus while typing — some text may not have landed; verify with screenshot and do NOT retype blindly",
    "a canvas editor paints its document into pixels, so this cannot be read back: verify with screenshot, or read the document at its /preview URL",
  ].filter(Boolean);

  return {
    ok: true,
    data: {
      mode: "trusted",
      reason: req.reason,
      insertedChars: inserted,
      keysSent,
      primed,
      focusHeld,
      note: parts.join("; "),
    },
  };
}
