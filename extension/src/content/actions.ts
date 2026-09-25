// Action synthesizer (content-script side): performs interactions by ref
// with framework-friendly event sequences (React/Vue handlers see a complete
// trusted-style stream). Runs in the isolated world shared with code injected
// via chrome.scripting.executeScript; reached through globalThis.__baActions.

import type { ElementRegistry } from "./registry";
import { isEditableHost } from "./registry";
import { SINK_SIGNATURE_RE, type InputHints } from "../shared/trusted-input";

export type ActionRequest =
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string; submit?: boolean }
  | { action: "select"; ref: string; value: string }
  | { action: "key"; ref?: string; key: string }
  | { action: "hover"; ref: string }
  | { action: "scroll"; ref?: string; dx?: number; dy?: number }
  | { action: "history"; dir: number }
  | { action: "focus"; ref?: string }
  | { action: "canvasPoint" }
  | { action: "probe"; ref: string };

export interface ActionResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

const PointerCtor: typeof MouseEvent =
  typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;

// Real browsers accept `view: window` and some handlers want it; jsdom's
// webidl realm check rejects it, so probe once and omit where unsupported.
const SUPPORTS_VIEW: boolean = (() => {
  try {
    new MouseEvent("probe", { view: window });
    return true;
  } catch {
    return false;
  }
})();

const viewInit = (): { view?: Window } => (SUPPORTS_VIEW ? { view: window } : {});

export class Actions {
  constructor(private registry: ElementRegistry) {}

  run(req: ActionRequest): ActionResult {
    try {
      return this.#dispatch(req);
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  }

  #dispatch(req: ActionRequest): ActionResult {
    switch (req.action) {
      case "click":
        return this.#click(this.#resolve(req.ref));
      case "type":
        return this.#type(this.#resolve(req.ref), req.text, req.submit ?? false);
      case "select":
        return this.#select(this.#resolve(req.ref), req.value);
      case "key":
        return this.#key(req.ref ? this.#resolve(req.ref) : null, req.key);
      case "hover":
        this.#mouse(this.#resolve(req.ref), HOVER_SEQUENCE);
        return { ok: true };
      case "scroll": {
        if (req.ref) {
          this.#resolve(req.ref).scrollIntoView?.({
            block: "center",
            inline: "center",
          });
        } else {
          window.scrollBy(req.dx ?? 0, req.dy ?? 0);
        }
        return { ok: true };
      }
      case "history": {
        history.go(req.dir);
        return { ok: true };
      }
      case "focus": {
        const el = req.ref
          ? this.#resolve(req.ref)
          : (document.activeElement as HTMLElement | null);
        if (!el || el === document.body) {
          return {
            ok: false,
            error: "nothing is focused in this frame — pass a ref to focus one",
          };
        }
        return this.#focus(el);
      }
      case "canvasPoint":
        return canvasPointOf();
      case "probe": {
        const el = this.#resolve(req.ref);
        const input = el as HTMLInputElement;
        return {
          ok: true,
          data: {
            tag: el.tagName.toLowerCase(),
            type: input.type,
            role: el.getAttribute("role") ?? undefined,
            text: (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
            inForm: Boolean(el.closest("form")),
          },
        };
      }
    }
  }

  #resolve(ref: string): HTMLElement {
    const el = this.registry.resolve(ref);
    if (!el) {
      throw new Error(`stale or unknown ref: ${ref} — take a fresh snapshot`);
    }
    return el as HTMLElement;
  }

  #mouse(el: HTMLElement, types: string[]): void {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    for (const type of types) {
      const pressed = type.endsWith("down") || type === "pointermove" || type === "mousemove";
      el.dispatchEvent(
        new PointerCtor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          ...viewInit(),
          clientX: x,
          clientY: y,
          button: 0,
          buttons: pressed ? 1 : 0,
        }),
      );
    }
  }

  #click(el: HTMLElement): ActionResult {
    el.scrollIntoView?.({ block: "center", inline: "center" });
    el.focus?.();
    this.#mouse(el, DOWN_SEQUENCE);
    this.#mouse(el, UP_SEQUENCE);
    el.click(); // the single real "click" event handlers act on
    return { ok: true };
  }

  #type(el: HTMLElement, text: string, submit: boolean): ActionResult {
    el.focus?.();
    // contenteditable (incl. IG's DM composer) and any non-form-control node:
    // never touch `.value` — assigning it on a div throws and the native
    // setter lookup is worse. Insert through the selection/Range API so rich
    // editors (Draft.js/Lexical/ProseMirror) observe a real DOM mutation.
    const isFormControl =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

    if (!isFormControl) {
      if (!isEditableHost(el)) {
        return {
          ok: false,
          error: `element is not typable: <${el.tagName.toLowerCase()}> is neither a form control nor contenteditable`,
        };
      }
      this.#insertIntoEditable(el, text);
    } else {
      // Native prototype setter so React's value tracker sees the change.
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text);
      else el.setAttribute("value", text);
      const data = { bubbles: true, cancelable: true, inputType: "insertText", data: text };
      el.dispatchEvent(new InputEvent("beforeinput", data));
      el.dispatchEvent(new InputEvent("input", data));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit) this.#submitFrom(el);
    return { ok: true, data: { value: readValue(el) } };
  }

  /**
   * Insert text into a contenteditable host the way a real user would: place a
   * collapsed Range at the end (or replace the current selection), then use
   * execCommand("insertText") which fires the beforeinput/input events rich
   * editors listen for. Falls back to direct DOM insertion where execCommand
   * is unavailable (e.g. jsdom).
   */
  #insertIntoEditable(el: HTMLElement, text: string): void {
    const doc = el.ownerDocument;
    const sel = doc.getSelection?.();
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // caret at end of existing content
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }

    const exec = doc.execCommand?.bind(doc);
    let inserted = false;
    if (exec) {
      try {
        inserted = exec("insertText", false, text);
      } catch {
        inserted = false;
      }
    }
    if (!inserted) {
      range.deleteContents();
      const node = doc.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: "insertText",
          data: text,
        }),
      );
    }
  }

  /**
   * Focus an element and report what its frame looks like from the inside.
   *
   * Both halves matter. Trusted keystrokes (CDP `Input.*`) go to whatever the
   * renderer currently has focused, so focus has to be established BEFORE they
   * are sent — and a canvas editor's sink lives in its own frame, where a click
   * on the canvas cannot reach it. The hints are how the worker tells that sink
   * apart from an ordinary input without guessing from the page URL alone.
   */
  #focus(el: HTMLElement): ActionResult {
    try {
      el.focus?.();
    } catch {
      // focus() can throw on odd nodes; the check below reports the real state.
    }
    const doc = el.ownerDocument;
    const active = doc.activeElement;
    return {
      ok: true,
      data: {
        focused: active === el || (active !== null && el.contains(active)),
        hints: collectInputHints(el),
      },
    };
  }

  #select(el: HTMLElement, value: string): ActionResult {
    const select = el as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  #key(target: HTMLElement | null, combo: string): ActionResult {
    const el = target ?? (document.activeElement as HTMLElement | null) ?? document.body;
    const parts = combo.split("+");
    const key = parts[parts.length - 1] ?? "";
    const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
    const init: KeyboardEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...viewInit(),
      key,
      ctrlKey: mods.has("control") || mods.has("ctrl"),
      shiftKey: mods.has("shift"),
      altKey: mods.has("alt"),
      metaKey: mods.has("meta") || mods.has("cmd"),
    };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    // Implicit submission like real browsers: Enter in a form field submits.
    if (key === "Enter") {
      const form = el.closest("form");
      if (form && (el as HTMLInputElement).type !== "textarea") {
        this.#submitFrom(el);
      }
    }
    return { ok: true };
  }

  #submitFrom(el: HTMLElement): void {
    const form = el.closest("form") as HTMLFormElement | null;
    if (!form) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
}

/** Read back what a node now contains, without assuming it has `.value`. */
function readValue(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  return (el.innerText ?? el.textContent ?? "").trim();
}

function safeCount(fn: () => number): number {
  try {
    return fn();
  } catch {
    return 0;
  }
}

/**
 * Everything the worker needs to decide HOW to type into this element, gathered
 * inside the frame that owns it (the only place that can see it).
 *
 * The distinguishing shape of a canvas editor's typing sink: an editable
 * element that is visually nothing — 1px, transparent, opacity 0 — inside a
 * frame of a page whose content is a <canvas>. Docs' is literally named
 * `docs-texteventtarget-iframe`, which is checked too since a name match beats
 * any heuristic.
 */
function collectInputHints(el: HTMLElement): InputHints {
  const win = el.ownerDocument.defaultView;
  const doc = el.ownerDocument;
  const style = win?.getComputedStyle?.(el);
  const rect = safeRect(el);
  const opacity = style ? Number.parseFloat(style.opacity) : 1;
  const boxHidden =
    rect === null ||
    rect.width <= 4 ||
    rect.height <= 4 ||
    style?.visibility === "hidden" ||
    style?.display === "none" ||
    (Number.isFinite(opacity) && opacity <= 0.05);
  const colorTransparent = /transparent|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(
    style?.color ?? "",
  );

  let inIframe = false;
  try {
    inIframe = win ? win.top !== win.self : false;
  } catch {
    inIframe = true; // reading `top` threw → we are framed by another origin
  }
  let topCanvases: number | undefined;
  let topUrl: string | undefined;
  try {
    const topDoc = win?.top?.document;
    if (topDoc) {
      topCanvases = topDoc.querySelectorAll("canvas").length;
      topUrl = topDoc.location.href;
    }
  } catch {
    // cross-origin: the top document is not readable, and that is fine —
    // the frame's own signals plus the signature still decide it.
  }
  let frameMarker = "";
  try {
    const frameElement = win?.frameElement;
    if (frameElement) {
      frameMarker = [
        (frameElement as HTMLElement).className ?? "",
        frameElement.id ?? "",
        frameElement.getAttribute("src") ?? "",
      ].join(" ");
    }
  } catch {
    // cross-origin frameElement access throws
  }
  const sinkSignature = SINK_SIGNATURE_RE.test(
    [
      (el as HTMLElement).className ?? "",
      el.id ?? "",
      frameMarker,
      location.href,
      doc.documentElement?.getAttribute("class") ?? "",
    ].join(" "),
  );

  return {
    frameUrl: location.href,
    topUrl,
    editable: isEditableHost(el),
    // A `key` call with no ref lands on whatever is focused; when that is an
    // iframe, the real target is inside it and keystrokes must be trusted to
    // reach it at all.
    activeIsFrame: el.tagName === "IFRAME",
    inIframe,
    boxHidden,
    colorTransparent,
    frameCanvases: safeCount(() => doc.querySelectorAll("canvas").length),
    frameTextChars: safeCount(
      () => (doc.body?.innerText ?? doc.body?.textContent ?? "").replace(/\s+/g, " ").trim().length,
    ),
    topCanvases,
    sinkSignature,
  };
}

function safeRect(el: HTMLElement): { width: number; height: number } | null {
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && el.getClientRects().length === 0) return null;
    return { width: rect.width, height: rect.height };
  } catch {
    return null;
  }
}

/**
 * Centre of this document's first <canvas>, in viewport coordinates — where a
 * trusted click lands when an editor's hidden sink will not take focus on its
 * own (clicking the document surface is how a person wakes it up).
 */
function canvasPointOf(): ActionResult {
  const canvas = document.querySelector("canvas") as HTMLElement | null;
  if (!canvas) return { ok: true, data: null };
  canvas.scrollIntoView?.({ block: "center", inline: "center" });
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { ok: true, data: null };
  return {
    ok: true,
    data: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  };
}

const DOWN_SEQUENCE = [
  "pointerover",
  "mouseover",
  "pointermove",
  "mousemove",
  "pointerdown",
  "mousedown",
];
const UP_SEQUENCE = ["pointerup", "mouseup"];
const HOVER_SEQUENCE = ["pointerover", "mouseover", "pointermove", "mousemove"];
