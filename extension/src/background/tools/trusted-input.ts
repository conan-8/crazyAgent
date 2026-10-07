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
//   - The tab is activated INSIDE its own window and the WINDOW is never
//     focused: a run works in the agent's window while the user works in
//     theirs (see background/window-scope.ts), so stealing focus on every
//     stroke would make the browser unusable next to a running agent. The
//     renderer's focus state instead comes from CDP focus emulation
//     (Emulation.setFocusEmulationEnabled) — see emulateFocus.
import type { ActionResult } from "../../content/actions";
import {
  keyEventParams,
  parseKeyCombo,
  planTyping,
  trustedInputFailure,
  type InputHints,
} from "../../shared/trusted-input";
import type { BrowserAdapter } from "../adapters/types";
import { ensureWindowForInput } from "../window-scope";
import { runContentAction } from "./content-action";
import { cursorPing } from "./cursor-overlay";

/** Let the renderer own the tab before sending input to it. */
const ACTIVATE_SETTLE_MS = 120;
/** Editors process input asynchronously; a beat between steps keeps order. */
const BETWEEN_STEPS_MS = 16;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The tab we last verified as front, and when. Trusted input pays a settle
 * after every activation change (the renderer needs a beat to own the tab),
 * but paying it on EVERY stroke of a sequence is a flat 120ms tax on work
 * that changed nothing — so while the same tab stays front, the check is a
 * cache hit and the call is free.
 */
let frontTab: { tabId: number; windowId: number; at: number } | null = null;
const FRONT_CACHE_MS = 2_000;

/**
 * Tabs already told to emulate focus. One command per tab, best effort: the
 * flag then lives for the target's lifetime.
 */
const focusEmulated = new Set<number>();

/**
 * Make the renderer believe its page is focused WITHOUT raising the window.
 *
 * A run works in its own window while the user works in another, so the agent
 * window is usually not the frontmost one. Chromium still delivers CDP input
 * to a tab that is active in its own (background) window, but the RENDERER's
 * own focus state is what editors, `beforeinput` consumers and anything
 * calling `document.hasFocus()` consult — and that state follows the OS
 * window. Focus emulation is DevTools' own answer to exactly this: the page
 * behaves as focused while the real window keeps whatever focus the user gave
 * it. Best-effort by design: a transport that refuses it still gets the
 * strokes, and the caller reports the real outcome.
 */
export async function emulateFocus(
  tabId: number,
  adapter: BrowserAdapter,
): Promise<void> {
  if (focusEmulated.has(tabId)) return;
  try {
    await adapter.send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    focusEmulated.add(tabId);
  } catch {
    // No emulation on this transport/page: the strokes below still run.
  }
}

/** Test seam: forget the activation + focus-emulation caches. */
export function resetInputCachesForTests(): void {
  frontTab = null;
  focusEmulated.clear();
}

/**
 * Make this tab the one the browser will deliver input to — WITHOUT touching
 * the user's focus.
 *
 * Input only reaches the ACTIVE tab's render widget, so the tab is activated
 * inside its own window (activating a tab does not raise the window). What is
 * deliberately NOT done anymore: `chrome.windows.update(…, {focused:true})`.
 * That call is what made a run unusable next to the user — every stroke
 * yanked focus back to the agent's window — and window isolation removed the
 * reason for it: the agent's tab lives in the agent's own window, where
 * activation plus focus emulation is what the renderer needs.
 */
export async function ensureTabActive(
  tabId: number,
  adapter: BrowserAdapter,
): Promise<void> {
  if (
    frontTab &&
    frontTab.tabId === tabId &&
    Date.now() - frontTab.at < FRONT_CACHE_MS
  ) {
    return;
  }
  let changed = false;
  let windowId = -1;
  try {
    const tab = await chrome.tabs.get(tabId);
    windowId = typeof tab.windowId === "number" ? tab.windowId : -1;
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      changed = true;
    }
    frontTab = { tabId, windowId, at: Date.now() };
  } catch {
    // tab closed or the API is unavailable — the next call will say so
    frontTab = null;
  }
  await emulateFocus(tabId, adapter);
  // Quiet focus (the default) stops here — the window is never raised. When
  // the user turned it off, raise the agent's own window: a site that refuses
  // input while its window is in the background gets what it wants, and the
  // user's window is still never touched.
  if (windowId >= 0) await ensureWindowForInput(windowId);
  // The settle exists for ownership CHANGES; a tab that was already front
  // needs no beat before input.
  if (changed) await sleep(ACTIVATE_SETTLE_MS);
}

/**
 * Send ONE real (CDP) key combo to the tab — the shared primitive behind the
 * keyboard-driven Docs tools (docs_op's shortcuts and grid-picker arrows,
 * docs_locate's Ctrl+F). The caller owns activation/focus (ensureTabActive);
 * events arrive in the page as isTrusted, which is what app-level key
 * handlers (and the browser's own editing engine) require.
 */
export async function sendTrustedKey(
  tabId: number,
  adapter: BrowserAdapter,
  combo: string,
): Promise<void> {
  const parsed = parseKeyCombo(combo);
  if (!parsed.ok) throw new Error(parsed.error);
  await adapter.send(tabId, "Input.dispatchKeyEvent", keyEventParams(parsed.parsed, "down"));
  await adapter.send(tabId, "Input.dispatchKeyEvent", keyEventParams(parsed.parsed, "up"));
  await sleep(BETWEEN_STEPS_MS);
}

/**
 * Send text through the IME path (`Input.insertText`) — one trusted chunk,
 * not per-key strokes. What a focused find bar or plain input receives as
 * typed text; callers that need per-key effects (shortcuts, Enter) use
 * sendTrustedKey instead.
 */
export async function sendTrustedText(
  tabId: number,
  adapter: BrowserAdapter,
  text: string,
): Promise<void> {
  await adapter.send(tabId, "Input.insertText", { text });
  await sleep(BETWEEN_STEPS_MS);
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
  cursorPing(tabId, adapter, point.x, point.y, "move");
  await adapter.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  cursorPing(tabId, adapter, point.x, point.y, "press");
  await adapter.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
  cursorPing(tabId, adapter, point.x, point.y, "release");
}

/**
 * The hidden typing sink of a canvas document editor (Docs' text-event-target
 * shape): a contenteditable / role=textbox scratch buffer inside its own iframe.
 * Real Google Docs never exposes it as a ref — the iframe carries no content
 * script — so ref-less typing finds it through the browser instead. Deliberately
 * frame-scoped: it never reaches into an ordinary page's inputs, so typing with
 * no ref cannot steal focus from a dialog field.
 */
function sinkJs(focus: boolean): string {
  return `(() => {
  const pick = (d) => d ? (d.querySelector('[role="textbox"][contenteditable="true"], [role="textbox"], [contenteditable="true"]') || null) : null;
  const sinkFrames = document.querySelectorAll('iframe.docs-texteventtarget-iframe, .docs-texteventtarget-iframe');
  const list = [...sinkFrames].concat([...document.querySelectorAll('iframe')]);
  let target = null;
  for (const f of list) {
    let d = null;
    try { d = f.contentDocument; } catch { d = null; }
    target = pick(d);
    if (target) break;
  }
  if (!target) return false;
  const activeOf = () => (target.ownerDocument || document).activeElement;
  const has = () => { const a = activeOf(); return a === target || !!(a && target.contains(a)); };
  ${focus ? "if (!has()) { try { target.focus(); } catch { return false; } }" : ""}
  return has();
})()`;
}

/** Run the sink expression in the page; false whenever anything throws. */
async function editorSink(
  tabId: number,
  adapter: BrowserAdapter,
  focus: boolean,
): Promise<boolean> {
  const params = { expression: sinkJs(focus), returnByValue: true };
  try {
    const res = (await (adapter.sendEnabled
      ? adapter.sendEnabled(tabId, "Runtime", "Runtime.evaluate", params)
      : adapter.send(tabId, "Runtime.evaluate", params))) as { result?: { value?: unknown } };
    return res?.result?.value === true;
  } catch {
    return false;
  }
}

/**
 * Where ref-less input should land: leave a real editable alone, otherwise
 * claim a canvas editor's sink if the page has one, otherwise accept the
 * browser's current focus (often the sink iframe itself). Exported for
 * type_at, which must verify focus AFTER its click and before its text —
 * the one-place-where-focus-is-known rule that keeps click→type atomic.
 */
export async function resolveNoRefFocus(
  tabId: number,
  adapter: BrowserAdapter,
): Promise<"focused" | "sink" | "none"> {
  const st = await focusTarget(tabId, "").catch(() => null);
  const hints = st && !("error" in st) ? st.hints : {};
  // A real editable (a dialog field, an input) already has focus — never steal
  // it on behalf of an editor sink the user is not typing into.
  if (hints.editable && !hints.sinkSignature && !hints.boxHidden) return "focused";
  if (await editorSink(tabId, adapter, true)) return "sink";
  if (hints.editable || hints.activeIsFrame) return "focused";
  return "none";
}

export interface TrustedInputRequest {
  tabId: number;
  adapter: BrowserAdapter;
  /** Frame-scoped ref of the typing target; omitted = whatever is focused. */
  ref?: string;
  text?: string;
  key?: string;
  submit?: boolean;
  /**
   * Select-all (Ctrl+A) inside THIS trusted sequence, immediately before the
   * text/key — atomic on purpose: a separate select call lets focus shift
   * between the two, which is exactly how a run ended up with the document
   * duplicated instead of replaced.
   */
  selectAll?: boolean;
  /** Why the trusted route was chosen — echoed into the result for run logs. */
  reason: string;
}

/** Everything one trusted-input result reports, for the note builder. */
export interface TrustedInputReport {
  reason: string;
  inserted: number;
  keysSent: number;
  primed: boolean;
  noRefFocus: "focused" | "sink" | "none" | null;
  focusHeld: boolean;
}

/**
 * The model-facing note for one trusted input (pure, so the wording that
 * steers the next step is pinned by tests). Two things it must never do:
 * imply a ref-less type reached a field it did not, and teach verification by
 * an `evaluate_js` export fetch — the ritual that died with TRANSPORT-FAILED
 * in run F and is forbidden by the canvas-editor skill.
 */
export function trustedInputNote(r: TrustedInputReport): string {
  return [
    `sent as real keystrokes via the browser input pipeline (${r.reason})`,
    r.inserted ? `${r.inserted} char(s) of text` : null,
    r.keysSent ? `${r.keysSent} key press(es)` : null,
    r.primed ? "the document surface was clicked once first to take focus" : null,
    // Where the text actually LANDED: a ref-less type is aimed at the focused
    // target, and when nothing editable is focused the harness wakes the
    // editor's own sink. Right for document text, wrong for a dialog/iframe
    // field the model believed was focused (run E typed an image-search query
    // into the document body twice this way, then had to undo it), so the
    // destination is stated rather than implied.
    r.noRefFocus === "sink"
      ? "no text field was focused, so the harness woke the DOCUMENT's own typing sink and the text landed in the document body at the caret — a dialog or iframe field (an image picker's search box, a find bar) is NOT reached this way: snapshot, then type with that field's ref"
      : null,
    r.noRefFocus === "none"
      ? "WARNING: nothing editable was focused — the keystrokes may have gone nowhere"
      : null,
    r.focusHeld
      ? null
      : "WARNING: the target lost focus while typing — some text may not have landed; verify before retyping and do NOT retype blindly",
    "a canvas editor paints its document into pixels, so this cannot be read back cheaply: verify ONCE with docs_read (text or html) or docs_state — never with an evaluate_js fetch, which the editor's CSP and this session's transport both punish",
  ]
    .filter(Boolean)
    .join("; ");
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
  let noRefFocus: "focused" | "sink" | "none" | null = null;
  if (!req.ref) {
    // Ref-less input (the canvas-editor route): make sure the keystrokes have
    // somewhere real to land before sending them — a silent no-op is exactly
    // the failure that sends a run into a retry loop.
    noRefFocus = await resolveNoRefFocus(tabId, adapter);
    if (noRefFocus === "none" && req.text !== undefined) {
      return {
        ok: false,
        error: trustedInputFailure(
          "nothing editable is focused and the page exposes no editor sink to type into",
          "nothing was typed. Click the target once (`click_at`) or focus it with `evaluate_js`, then retry — or pass a ref.",
        ),
      };
    }
  }
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
          "nothing was typed. On a canvas editor the typing sink has NO ref — call `type` with the text and no ref (it finds and focuses the sink itself); for anything else, take a fresh snapshot and pick a real editable ref, or navigate to the document first if it is still loading.",
        ),
      };
    }
  }

  const base =
    req.key !== undefined
      ? [{ kind: "key" as const, key: req.key }]
      : planTyping(req.text ?? "", { submit: req.submit });
  // select:"all" rides the SAME trusted sequence as the text — the selection
  // and the insert cannot be separated by a focus shift between calls.
  const steps: { kind: "key"; key: string }[] | ReturnType<typeof planTyping> = req.selectAll
    ? [{ kind: "key" as const, key: "Control+a" }, ...base]
    : base;

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
  } else if (noRefFocus === "sink") {
    focusHeld = await editorSink(tabId, adapter, false);
  }

  const note = trustedInputNote({
    reason: req.reason,
    inserted,
    keysSent,
    primed,
    noRefFocus,
    focusHeld,
  });

  return {
    ok: true,
    data: {
      mode: "trusted",
      reason: req.reason,
      insertedChars: inserted,
      keysSent,
      primed,
      focusHeld,
      note,
    },
  };
}
