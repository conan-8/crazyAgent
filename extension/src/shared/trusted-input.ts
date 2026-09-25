// Trusted input — the pure half (the CDP driver lives in
// background/tools/trusted-input.ts).
//
// Why this exists: canvas document editors (Google Docs' kix, Slides, Office on
// the web) keep their document model in JavaScript and paint it into a
// <canvas>. The hidden editable element they route typing through is a scratch
// buffer for the browser's editing/IME machinery — it is NOT the document. So
// synthesising events from a content script does not edit the document: a
// dispatched `InputEvent` arrives `isTrusted: false` and is ignored, and even
// `execCommand("insertText")` (which arrives trusted) fires `input` with no
// `keydown`/`beforeinput`, which is not what an editing pipeline listens to.
//
// What does work is sending keystrokes through the browser's own input
// pipeline — CDP `Input.insertText` / `Input.dispatchKeyEvent` — which was
// measured to arrive as `isTrusted: true` inside a focused sink frame, and to
// make the browser emit the editing events a real editor needs:
//
//   Input.insertText            → beforeinput(insertText, trusted) + input
//   dispatchKeyEvent Ctrl+B     → keydown(mod=ctrl) + beforeinput(formatBold)
//   dispatchKeyEvent Enter      → keydown + keypress + beforeinput(insertParagraph)
//   dispatchKeyEvent Backspace  → keydown + beforeinput(deleteContentBackward)
//   dispatchMouseEvent at x,y   → trusted mousedown/mouseup/click on the canvas
//
// Everything here is pure so the key table, the typing plan and the "is this a
// canvas editor sink?" decision are unit-tested without a browser
// (tests/trusted-input.test.ts).

import { failureTag } from "./tool-failure";

// ---------------------------------------------------------------------------
// Key combos
// ---------------------------------------------------------------------------

/** CDP modifier bitmask (Input.dispatchKeyEvent `modifiers`). */
export const MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
} as const;

export type ModifierName = keyof typeof MODIFIER_BITS;

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  alt: "alt",
  option: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  shift: "shift",
};

interface KeyDef {
  key: string;
  code: string;
  vk: number;
  /** Character this key inserts with no modifier held. */
  text?: string;
  /** Character it inserts with Shift held (US layout). */
  shifted?: string;
}

/** Named keys plus US-layout punctuation. Letters and digits are computed. */
const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  del: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  spacebar: { key: " ", code: "Space", vk: 32, text: " " },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  minus: { key: "-", code: "Minus", vk: 189, text: "-", shifted: "_" },
  equal: { key: "=", code: "Equal", vk: 187, text: "=", shifted: "+" },
  bracketleft: { key: "[", code: "BracketLeft", vk: 219, text: "[", shifted: "{" },
  bracketright: { key: "]", code: "BracketRight", vk: 221, text: "]", shifted: "}" },
  backslash: { key: "\\", code: "Backslash", vk: 220, text: "\\", shifted: "|" },
  semicolon: { key: ";", code: "Semicolon", vk: 186, text: ";", shifted: ":" },
  quote: { key: "'", code: "Quote", vk: 222, text: "'", shifted: '"' },
  comma: { key: ",", code: "Comma", vk: 188, text: ",", shifted: "<" },
  period: { key: ".", code: "Period", vk: 190, text: ".", shifted: ">" },
  slash: { key: "/", code: "Slash", vk: 191, text: "/", shifted: "?" },
  backquote: { key: "`", code: "Backquote", vk: 192, text: "`", shifted: "~" },
};

const SHIFTED_DIGITS: Record<string, string> = {
  "0": ")", "1": "!", "2": "@", "3": "#", "4": "$",
  "5": "%", "6": "^", "7": "&", "8": "*", "9": "(",
};

/** Punctuation reachable both by name ("semicolon") and by symbol (";"). */
const BY_SYMBOL: Record<string, KeyDef> = (() => {
  const out: Record<string, KeyDef> = {};
  for (const def of Object.values(NAMED_KEYS)) {
    if (def.text && def.text.length === 1) out[def.text] = def;
    // The shifted symbol is its own key value ("+" not "="), per UI Events.
    if (def.shifted) {
      out[def.shifted] = { ...def, key: def.shifted, text: def.shifted, shifted: undefined };
    }
  }
  return out;
})();

export interface ParsedKey {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** CDP modifier bitmask. */
  modifiers: number;
  /** Present when the key inserts a character (CDP needs it to emit text). */
  text?: string;
  unmodifiedText?: string;
}

export type KeyComboParse =
  | { ok: true; parsed: ParsedKey }
  | { ok: false; error: string };

function letterDef(ch: string, shift: boolean): KeyDef {
  const lower = ch.toLowerCase();
  return {
    key: shift ? lower.toUpperCase() : lower,
    code: `Key${lower.toUpperCase()}`,
    vk: lower.charCodeAt(0) - 32, // 'a' → 65
    text: shift ? lower.toUpperCase() : lower,
  };
}

function digitDef(ch: string, shift: boolean): KeyDef {
  const shifted = SHIFTED_DIGITS[ch];
  return {
    key: shift && shifted ? shifted : ch,
    code: `Digit${ch}`,
    vk: ch.charCodeAt(0), // '0' → 48
    text: shift && shifted ? shifted : ch,
  };
}

/**
 * Parse a combo string as the `key` tool spells it ("Enter", "Control+a",
 * "Shift+Tab", "Control+Alt+1") into CDP key-event parameters.
 *
 * Keys this table does not cover (accented letters, emoji, CJK) are reported as
 * a failure with the character to insert instead — the driver then falls back to
 * `Input.insertText`, which is the correct primitive for them anyway.
 */
export function parseKeyCombo(combo: string): KeyComboParse {
  const raw = String(combo ?? "").trim();
  if (!raw) return { ok: false, error: "empty key combo" };

  // "+" is both the separator and a key ("Control++", a bare "+"), so it is
  // decided by shape, not by splitting alone.
  const segments = raw.split("+").filter((s) => s.length > 0);
  const plusIsKey = raw === "+" || raw.includes("++") || raw.endsWith("+");
  const modParts = (plusIsKey ? segments : segments.slice(0, -1)).map((p) =>
    p.trim().toLowerCase(),
  );
  const keyPart = (plusIsKey ? "+" : (segments[segments.length - 1] ?? "")).trim();

  let modifiers = 0;
  for (const mod of modParts) {
    const name = MODIFIER_ALIASES[mod];
    if (!name) return { ok: false, error: `unknown modifier: ${mod}` };
    modifiers |= MODIFIER_BITS[name];
  }
  const shift = (modifiers & MODIFIER_BITS.shift) !== 0;
  if (!keyPart) return { ok: false, error: `combo has no key: ${raw}` };

  const def: KeyDef | undefined =
    (keyPart.length === 1 && /[a-z]/i.test(keyPart)
      ? letterDef(keyPart, shift)
      : undefined) ??
    (keyPart.length === 1 && /[0-9]/.test(keyPart)
      ? digitDef(keyPart, shift)
      : undefined) ??
    (/^f\d{1,2}$/i.test(keyPart)
      ? {
          key: keyPart.toUpperCase(),
          code: keyPart.toUpperCase(),
          vk: 111 + Number(keyPart.slice(1)),
        }
      : undefined) ??
    NAMED_KEYS[keyPart.toLowerCase()] ??
    (keyPart.length === 1 ? BY_SYMBOL[keyPart] : undefined);

  if (!def) {
    return {
      ok: false,
      error: `no key mapping for "${keyPart}" — insert it with type instead`,
    };
  }
  const shiftedHeld = shift && def.shifted !== undefined;
  const text = shiftedHeld ? def.shifted : def.text;
  return {
    ok: true,
    parsed: {
      // With Shift held the key VALUE is the shifted symbol ("Shift+1" → "!"),
      // while `code` stays the physical key.
      key: shiftedHeld ? (def.shifted as string) : def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      modifiers,
      ...(text !== undefined ? { text, unmodifiedText: def.text ?? text } : {}),
    },
  };
}

/** CDP `Input.dispatchKeyEvent` params for one phase of a parsed key. */
export function keyEventParams(
  parsed: ParsedKey,
  phase: "down" | "up",
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: phase === "down" ? "keyDown" : "keyUp",
    key: parsed.key,
    code: parsed.code,
    windowsVirtualKeyCode: parsed.windowsVirtualKeyCode,
    nativeVirtualKeyCode: parsed.windowsVirtualKeyCode,
  };
  if (parsed.modifiers) base.modifiers = parsed.modifiers;
  // `text` on keyDown is what makes the browser insert the character (and fire
  // keypress + beforeinput). Never send it on keyUp.
  if (phase === "down" && parsed.text !== undefined) {
    base.text = parsed.text;
    if (parsed.unmodifiedText !== undefined) base.unmodifiedText = parsed.unmodifiedText;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Typing plan
// ---------------------------------------------------------------------------

export type TypingStep =
  | { kind: "insertText"; text: string }
  | { kind: "key"; key: string };

/**
 * Split text into the fewest browser-level steps that reproduce it.
 *
 * Plain runs go as ONE `Input.insertText` (the IME path — fast, and what an
 * editor expects for pasted/composed text). Newlines go as a real Enter key so
 * the editor sees `beforeinput(insertParagraph)` and starts a new paragraph:
 * measured, `insertText` with an embedded "\n" splits a <div> but never emits
 * insertParagraph, so paragraph structure would be wrong.
 */
export function planTyping(text: string, opts: { submit?: boolean } = {}): TypingStep[] {
  const steps: TypingStep[] = [];
  const segments = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  segments.forEach((segment, i) => {
    if (i > 0) steps.push({ kind: "key", key: "Enter" });
    if (segment) steps.push({ kind: "insertText", text: segment });
  });
  if (opts.submit) steps.push({ kind: "key", key: "Enter" });
  // An empty string with submit still means "press Enter".
  return steps;
}

// ---------------------------------------------------------------------------
// Where trusted input is required
// ---------------------------------------------------------------------------

/**
 * Class/src/URL signatures of known canvas-editor typing sinks. Docs names its
 * sink iframe `docs-texteventtarget-iframe` and its editor internals `kix-*`;
 * Office on the web serves the editor from `officeapps`. Deliberately narrow: a
 * false positive here would reroute typing on an ordinary field (inserting at
 * the caret instead of replacing the value), so anything less certain is left to
 * the shape heuristics below.
 */
export const SINK_SIGNATURE_RE = /docs-texteventtarget|texteventtarget|kix-|officeapps/i;

/** Editor URLs whose body is a canvas: typing must be trusted keystrokes. */
const CANVAS_EDITOR_URL_RES = [
  /^https:\/\/docs\.google\.com\/(?:document|presentation|drawing|spreadsheets)\//i,
  /^https:\/\/[\w-]+\.docs\.google\.com\/(?:document|presentation|drawing|spreadsheets)\//i,
  /^https:\/\/officeapps\.live\.com\//i,
  /^https:\/\/[\w-]+\.officeapps\.live\.com\//i,
  /^https:\/\/www\.office\.com\//i,
];

export function isCanvasEditorUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return CANVAS_EDITOR_URL_RES.some((re) => re.test(url));
}

/** What the content script can observe about a typing target, in its frame. */
export interface InputHints {
  /** The model asked for it (`trusted: true`) or vetoed it (`trusted: false`). */
  explicit?: boolean;
  /** Frame URL, and the top URL when same-origin policy lets us read it. */
  frameUrl?: string;
  topUrl?: string;
  editable?: boolean;
  /** The focused node is an iframe — the real target is inside it. */
  activeIsFrame?: boolean;
  inIframe?: boolean;
  /** ~1px / zero-area / invisible — a scratch buffer, not a real field. */
  boxHidden?: boolean;
  colorTransparent?: boolean;
  frameCanvases?: number;
  frameTextChars?: number;
  /** Canvas count in the top document, when the frame can reach it. */
  topCanvases?: number;
  sinkSignature?: boolean;
}

export interface TrustedInputDecision {
  use: boolean;
  /** Why — surfaced in the tool result so a run log explains the route. */
  reason: string;
}

/**
 * Decide whether `type`/`key` must go through the browser's input pipeline.
 *
 * Deliberately narrow: the default stays the content-script path, which is
 * better for ordinary pages (it replaces an input's value and keeps React's
 * value tracker happy). Trusted input is required only for canvas-editor sinks,
 * where the content-script path provably cannot work — or when the model asks.
 */
export function shouldUseTrustedInput(hints: InputHints): TrustedInputDecision {
  if (hints.explicit === true) return { use: true, reason: "requested (trusted: true)" };
  if (hints.explicit === false) return { use: false, reason: "content-script path (trusted: false)" };
  // `key` with no ref acts on whatever is focused. When that is an iframe of a
  // canvas editor, the keystrokes have to be real ones to reach inside it.
  if (
    hints.activeIsFrame &&
    (isCanvasEditorUrl(hints.topUrl ?? hints.frameUrl) || (hints.frameCanvases ?? 0) > 0)
  ) {
    return { use: true, reason: "focus is inside an embedded canvas editor frame" };
  }
  if (!hints.editable) {
    return { use: false, reason: "target is not an editable host" };
  }
  if (hints.sinkSignature) {
    return { use: true, reason: "canvas editor's text-event sink (signature match)" };
  }
  if (isCanvasEditorUrl(hints.topUrl) || isCanvasEditorUrl(hints.frameUrl)) {
    return { use: true, reason: "canvas document editor URL" };
  }
  const topCanvases = hints.topCanvases ?? 0;
  if (hints.inIframe && hints.boxHidden && topCanvases > 0) {
    return {
      use: true,
      reason: `hidden editable sink in a frame of a canvas page (${topCanvases} canvas)`,
    };
  }
  if ((hints.frameCanvases ?? 0) > 0 && (hints.frameTextChars ?? 0) < 200) {
    return { use: true, reason: "editable target inside a canvas-drawn frame with no DOM text" };
  }
  if (hints.boxHidden && hints.colorTransparent && hints.inIframe) {
    return { use: true, reason: "invisible editable sink in a frame" };
  }
  return { use: false, reason: "ordinary editable element" };
}

/**
 * Failure message for input the browser could not deliver (tab not active, sink
 * lost focus). Pre-tagged so `describeToolFailure` passes it through verbatim
 * instead of reclassifying it as UNKNOWN — the model needs THIS advice, not the
 * generic transport blurb.
 */
export function trustedInputFailure(detail: string, advice: string): string {
  return `${failureTag("transport")}: ${detail} — ${advice}`;
}
