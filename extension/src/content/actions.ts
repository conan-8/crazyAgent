// Action synthesizer (content-script side): performs interactions by ref
// with framework-friendly event sequences (React/Vue handlers see a complete
// trusted-style stream). Runs in the isolated world shared with code injected
// via chrome.scripting.executeScript; reached through globalThis.__baActions.

import type { ElementRegistry } from "./registry";
import { isEditableHost, nearestInteractive } from "./registry";
import { SINK_SIGNATURE_RE, type InputHints } from "../shared/trusted-input";
import type { HitInfo, ViewportInfo, CoordSpace, Point } from "../shared/coords";
import { toViewportPoint } from "../shared/coords";
import type { AuthSignals } from "../shared/handoff";

/** One file an `upload` attaches: inline text or base64 bytes. */
export interface UploadFileSpec {
  name: string;
  mime?: string;
  text?: string;
  base64?: string;
}

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
  | { action: "probe"; ref: string }
  | { action: "probeAt"; x: number; y: number; space?: CoordSpace }
  | {
      action: "resolvePoint";
      /** Element to act on (its center, plus dx/dy). */
      ref?: string;
      /** Frame-local point instead of a ref. */
      x?: number;
      y?: number;
      space?: CoordSpace;
      dx?: number;
      dy?: number;
    }
  | { action: "upload"; ref: string; files: UploadFileSpec[] }
  | { action: "uploadMark"; ref: string; token: string }
  | {
      action: "pasteFiles";
      ref?: string;
      files: UploadFileSpec[];
      mode?: "auto" | "paste" | "drop";
    }
  | { action: "filesOf"; ref: string }
  | { action: "readEl"; ref: string; depth?: number }
  | { action: "authSignals" };

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
        return { ok: true, data: probeOf(el) };
      }
      case "probeAt":
        return this.#probeAt(req.x, req.y, req.space);
      case "resolvePoint":
        return this.#resolvePoint(req);
      case "authSignals":
        return { ok: true, data: authSignalsOf() };
      case "readEl": {
        const el = this.#resolve(req.ref);
        return {
          ok: true,
          data: {
            text: scopedText(el, typeof req.depth === "number" ? req.depth : undefined),
          },
        };
      }
      case "upload":
        return this.#upload(this.#resolve(req.ref), req.files ?? []);
      case "pasteFiles":
        return this.#pasteFiles(
          req.ref ? this.#resolve(req.ref) : null,
          req.files ?? [],
          req.mode ?? "auto",
        );
      case "filesOf": {
        // Read back what a file input actually holds — the verification half of
        // the CDP `DOM.setFileInputFiles` route, which reports success even for
        // paths the browser could not read (a real run "attached" a nonexistent
        // file three times while input.files stayed empty).
        const el = this.#resolve(req.ref);
        const input = el as HTMLInputElement;
        const files =
          el instanceof HTMLInputElement && input.files
            ? Array.from(input.files).map((f) => ({
                name: f.name,
                size: f.size,
                type: f.type,
              }))
            : [];
        return { ok: true, data: { count: files.length, files } };
      }
      case "uploadMark": {
        // Tag the input so the background can find it in CDP's DOM world
        // (`DOM.setFileInputFiles` needs a node, and refs only exist here).
        const el = this.#resolve(req.ref);
        if (req.token) {
          el.setAttribute("data-ba-upload", req.token);
        } else {
          el.removeAttribute("data-ba-upload");
        }
        return { ok: true, data: { token: req.token } };
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

  /**
   * What sits under a point — the policy probe for coordinate input. Prefers
   * the nearest interactive ancestor (the control a click would really act on)
   * and reports canvas/iframe hits honestly: a canvas has no DOM to act on, and
   * an iframe means the real target is out of this frame's reach. Page-space
   * points are converted here (this is the frame that owns the scroll).
   */
  #probeAt(x: number, y: number, space?: CoordSpace): ActionResult {
    const point = toViewportPoint(
      { x, y },
      space === "page" ? "page" : "viewport",
      { scrollX: window.scrollX, scrollY: window.scrollY },
    );
    let raw: Element | null = null;
    try {
      raw = document.elementFromPoint(point.x, point.y);
    } catch {
      return { ok: false, error: `document.elementFromPoint(${point.x}, ${point.y}) failed` };
    }
    const target = nearestInteractive(raw);
    const el = target ?? raw;
    const probe = el ? probeOf(el) : null;
    const hit: HitInfo | null =
      el && probe
        ? {
            ...probe,
            ref: this.registry.refFor(el) ?? undefined,
            canvas: raw?.tagName === "CANVAS",
            overIframe: raw?.tagName === "IFRAME" || raw?.tagName === "FRAME",
          }
        : null;
    const viewport: ViewportInfo = {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
    return { ok: true, data: { hit, viewport, point } };
  }

  /**
   * Resolve a ref (element center + dx/dy) or a frame-local point into TOP-
   * VIEWPORT coordinates — the space CDP Input and `screenshot` use — plus
   * the element's own box and hit description.
   *
   * Why this exists: a real run spent 22 minutes hand-deriving an SVG→viewport
   * affine map in reasoning because nothing translated frame-local element
   * boxes into the coordinates the drag tools want. The walk up frameElement
   * gives the exact offset chain; each level contributes its iframe box as the
   * parent sees it. Cross-origin boundaries without host permissions return
   * null frameElement — reported as an error, never a guessed offset.
   */
  #resolvePoint(req: {
    ref?: string;
    x?: number;
    y?: number;
    space?: CoordSpace;
    dx?: number;
    dy?: number;
  }): ActionResult {
    const dx = Number.isFinite(req.dx) ? (req.dx as number) : 0;
    const dy = Number.isFinite(req.dy) ? (req.dy as number) : 0;
    let local: Point;
    let rect: { x: number; y: number; w: number; h: number } | undefined;
    let hit: HitInfo | null = null;
    if (req.ref !== undefined) {
      const el = this.#resolve(req.ref);
      const r = el.getBoundingClientRect();
      rect = { x: r.x, y: r.y, w: r.width, h: r.height };
      local = { x: r.x + r.width / 2 + dx, y: r.y + r.height / 2 + dy };
      hit = { ...probeOf(el), ref: this.registry.refFor(el) ?? undefined, canvas: false, overIframe: false };
    } else {
      if (typeof req.x !== "number" || typeof req.y !== "number") {
        return { ok: false, error: "resolvePoint needs a ref or frame-local x/y" };
      }
      local = toViewportPoint(
        { x: req.x, y: req.y },
        req.space === "page" ? "page" : "viewport",
        { scrollX: window.scrollX, scrollY: window.scrollY },
      );
      local = { x: local.x + dx, y: local.y + dy };
    }
    // Offset chain: this frame's viewport → top viewport.
    let offsetX = 0;
    let offsetY = 0;
    let win: Window = window;
    let depth = 0;
    while (win !== win.parent && depth < 8) {
      const fe = (() => {
        try {
          return win.frameElement as HTMLElement | null;
        } catch {
          return null;
        }
      })();
      if (!fe) {
        return {
          ok: false,
          error:
            "cannot translate frame-local coordinates to viewport coordinates at this frame boundary (cross-origin without host permission) — use the ref of an element inside the frame, or top-viewport coordinates from the screenshot",
        };
      }
      const r = fe.getBoundingClientRect();
      offsetX += r.x;
      offsetY += r.y;
      win = win.parent;
      depth++;
    }
    return {
      ok: true,
      data: {
        point: { x: local.x + offsetX, y: local.y + offsetY },
        localPoint: local,
        frameOffset: { x: offsetX, y: offsetY },
        rect,
        hit,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
      },
    };
  }

  /**
   * Attach files to a file input. The in-memory route (a DataTransfer) works
   * for content the model produced; the CDP `DOM.setFileInputFiles` route in
   * the tool layer covers paths the browser can read directly.
   */
  #upload(el: HTMLElement, files: UploadFileSpec[]): ActionResult {
    const input = el as HTMLInputElement;
    if (!(el instanceof HTMLInputElement) || String(input.type).toLowerCase() !== "file") {
      return {
        ok: false,
        error: `ref is a ${el.tagName.toLowerCase()}, not a file input — pass the ref of an <input type="file"> from a fresh snapshot`,
      };
    }
    if (!files.length) {
      return { ok: false, error: "no files given — pass at least one entry in `files`" };
    }
    const made = files.map((f) => {
      const part: BlobPart = f.base64 ? base64ToArrayBuffer(f.base64) : (f.text ?? "");
      return new File([part], f.name, { type: f.mime || "application/octet-stream" });
    });
    const dt = new DataTransfer();
    for (const f of made) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      ok: true,
      data: {
        attached: made.map((f) => ({ name: f.name, size: f.size, type: f.type })),
        events: ["input", "change"],
      },
    };
  }

  /**
   * Deliver files into a page the way a user's paste/drop would: a synthetic
   * `paste` ClipboardEvent (what chat composers — Kimi, ChatGPT, Slack — listen
   * for when you paste a screenshot) with a `drop` DragEvent fallback for
   * dropzone-only widgets. A file-input target delegates to `#upload`, so one
   * route covers every shape of "attach this image here".
   *
   * These events are `isTrusted: false` — apps that reject synthetic events
   * need the OS-clipboard route in the tool layer (offscreen write + trusted
   * Ctrl+V). `defaultPrevented` is the honest signal: a handler that consumed
   * the paste calls preventDefault, and the tool reports it either way.
   */
  #pasteFiles(
    target: HTMLElement | null,
    files: UploadFileSpec[],
    mode: "auto" | "paste" | "drop",
  ): ActionResult {
    const el =
      target ?? ((document.activeElement as HTMLElement | null) || document.body);
    if (!files.length) {
      return { ok: false, error: "no files given — pass at least one entry in `files`" };
    }
    if (el instanceof HTMLInputElement && String(el.type).toLowerCase() === "file") {
      const res = this.#upload(el, files);
      return res.ok ? { ...res, data: { ...(res.data as object), route: "file" } } : res;
    }
    const made = files.map((f) => {
      const part: BlobPart = f.base64 ? base64ToArrayBuffer(f.base64) : (f.text ?? "");
      return new File([part], f.name, { type: f.mime || "application/octet-stream" });
    });
    const dt = new DataTransfer();
    for (const f of made) dt.items.add(f);

    const events: string[] = [];
    let handled = false;
    let route = "paste";
    if (mode !== "drop") {
      const pasteEv = makeClipboardEvent("paste", dt);
      el.dispatchEvent(pasteEv);
      events.push("paste");
      handled = pasteEv.defaultPrevented;
    }
    if (!handled && mode !== "paste") {
      const dropEv = makeDragEvent("drop", dt);
      el.dispatchEvent(dropEv);
      events.push("drop");
      if (dropEv.defaultPrevented) {
        handled = true;
        route = "drop";
      }
    }
    if (mode === "drop") route = "drop";
    return {
      ok: true,
      data: {
        route,
        events,
        handled,
        targetTag: el.tagName.toLowerCase(),
        files: made.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      },
    };
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
    let submitNote: string | undefined;
    if (submit) {
      const outcome = this.#submitFrom(el);
      // A silent no-op here cost a real run a whole round trip: submit:true on
      // an SPA assessment form whose inputs live outside any <form> looked
      // successful and submitted nothing. Say what happened.
      if (outcome === "no-form") {
        submitNote =
          "submit requested but the element is not inside a <form> — nothing was submitted; find the page's submit control in the snapshot and click it by ref";
      }
    }
    return {
      ok: true,
      data: submitNote
        ? { value: readValue(el), note: submitNote }
        : { value: readValue(el) },
    };
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

  /**
   * Submit the form enclosing `el`. Prefers CLICKING the form's own submit
   * button (pages that bind handlers on the button itself — very common on
   * quiz/assessment SPAs — never see a bare form.submit()), then falls back
   * to requestSubmit()/a synthetic submit event. Returns "no-form" when
   * nothing encloses the element, so the caller can report it instead of
   * silently doing nothing.
   */
  #submitFrom(el: HTMLElement): "submitted" | "no-form" {
    const form = el.closest("form") as HTMLFormElement | null;
    if (!form) return "no-form";
    const btn = form.querySelector<HTMLButtonElement | HTMLInputElement>(
      'button[type="submit"], input[type="submit"], button:not([type])',
    );
    if (btn && !(btn instanceof HTMLInputElement && btn.disabled) && !(btn instanceof HTMLButtonElement && btn.disabled)) {
      btn.click();
      return "submitted";
    }
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return "submitted";
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
 * Depth-limited text of a subtree: `depth: 0` reads only the root's own text
 * nodes, `depth: 1` adds its children's, and no depth means the whole subtree
 * — which is what a scoped `read_page` wants.
 */
function scopedText(el: Element, depth?: number): string {
  const walk = (node: Element, d: number): string => {
    const own = Array.from(node.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join(" ");
    if (depth !== undefined && d >= depth) return own;
    return [own, ...Array.from(node.children).map((c) => walk(c, d + 1))].join(" ");
  };
  return walk(el, 0).replace(/\s+/g, " ").trim();
}

/** CAPTCHA / bot-check widgets — their presence is always a human's job. */
const CAPTCHA_SELECTOR = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[title*="captcha" i]',
  ".g-recaptcha",
  ".h-captcha",
  '[class*="turnstile"]',
  "#challenge-form",
  "[data-sitekey]",
].join(", ");

/**
 * What the page looks like from an auth standpoint. Read-only and cheap — the
 * handoff detector (shared/handoff.ts) decides with it; this only reports.
 */
function authSignalsOf(): AuthSignals {
  let captcha = false;
  try {
    captcha = Array.from(document.querySelectorAll(CAPTCHA_SELECTOR)).some((el) => {
      if (el.id === "challenge-form") return true;
      const r = el.getBoundingClientRect();
      // Size filter: the invisible reCAPTCHA badge rides on many ordinary
      // pages and is tiny — a real widget (checkbox, Turnstile, challenge) is
      // a box of this order.
      return r.width >= 200 && r.height >= 50;
    });
  } catch {
    // an exotic selector implementation — treat as "no widget seen"
  }
  return {
    url: location.href,
    title: document.title,
    captcha,
    passwordField: Boolean(document.querySelector('input[type="password"]')),
  };
}

/** The policy probe of one element — shared by `probe` and `probeAt`. */
function probeOf(el: Element): {
  tag: string;
  type?: string;
  role?: string;
  text: string;
  inForm: boolean;
} {
  const input = el as HTMLInputElement;
  const ht = el as HTMLElement;
  return {
    tag: el.tagName.toLowerCase(),
    type: input.type,
    role: el.getAttribute("role") ?? undefined,
    text: (ht.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    inForm: Boolean(el.closest("form")),
  };
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new ArrayBuffer(bin.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A paste event carrying a real DataTransfer. Chrome accepts `clipboardData`
 * in the ClipboardEvent constructor; where it does not (older engines, jsdom),
 * fall back to a plain Event with the property defined — same probe pattern as
 * SUPPORTS_VIEW, because a constructor that silently DROPS the payload would
 * hand the page an empty paste.
 */
function makeClipboardEvent(type: string, dt: DataTransfer): Event {
  try {
    const ev = new ClipboardEvent(type, {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    if (ev.clipboardData) return ev;
  } catch {
    // constructor unsupported — fall through
  }
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: dt });
  return ev;
}

/** Same shape for DragEvent('drop') — the dropzone-only fallback. */
function makeDragEvent(type: string, dt: DataTransfer): Event {
  try {
    const ev = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    });
    if (ev.dataTransfer) return ev;
  } catch {
    // constructor unsupported — fall through
  }
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  return ev;
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
