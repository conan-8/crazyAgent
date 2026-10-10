// Action synthesizer (content-script side): performs interactions by ref
// with framework-friendly event sequences (React/Vue handlers see a complete
// trusted-style stream). Runs in the isolated world shared with code injected
// via chrome.scripting.executeScript; reached through globalThis.__baActions.

import type { ElementRegistry } from "./registry";
import { isEditableHost, nearestInteractive } from "./registry";
import { SINK_SIGNATURE_RE, type InputHints } from "../shared/trusted-input";
import type {
  ElementRect,
  HitInfo,
  SnapCandidate,
  ViewportInfo,
  CoordSpace,
  Point,
} from "../shared/coords";
import { rectDistance, SNAP_RADIUS_PX, toViewportPoint } from "../shared/coords";
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
  | { action: "caretRect" }
  | { action: "probe"; ref: string }
  | { action: "probeAt"; x: number; y: number; space?: CoordSpace; radius?: number }
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
      /** Acting resolves (click/drag/hover) pass this: scroll the ref into
       *  view first so an off-screen element still resolves to a clickable
       *  point. Looking resolves (element_at, the policy probe) omit it. */
      scroll?: boolean;
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
  | { action: "authSignals" }
  /** Click the visible element whose text/aria-label matches — candidates in
   *  preference order. The label-walk primitive behind menu_path/docs_op. */
  | { action: "clickByText"; labels: string[] }
  /** Fill a form field located by its label (aria-label/placeholder/<label>). */
  | {
      action: "fillField";
      labels: string[];
      value?: string;
      kind?: "auto" | "text" | "select" | "radio";
    }
  /** Read an element's current text/value — by label candidates or CSS selector. */
  | { action: "queryText"; labels?: string[]; selector?: string }
  /** Short visible leaf texts inside find-bar-like containers (the match counter lives there). */
  | { action: "findTexts" }
  /** Is the app's menu bar actually on screen? Docs' full-screen mode hides it. */
  | { action: "menuBarState" }
  /** The first VISIBLE match of each selector: its viewport rect and text. For
   *  app-internal widgets no ref points at (a grid picker's mousecatcher). */
  | { action: "boxes"; selectors: string[] };

export interface ActionResult {
  ok: boolean;
  error?: string;
  data?: unknown;
  /** Set when the harness had to re-inject the content script before this ran. */
  repaired?: boolean;
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
      case "caretRect":
        return { ok: true, data: caretRectOf() };
      case "probe": {
        const el = this.#resolve(req.ref);
        return { ok: true, data: probeOf(el) };
      }
      case "probeAt":
        return this.#probeAt(req.x, req.y, req.space, req.radius);
      case "resolvePoint":
        return this.#resolvePoint(req);
      case "clickByText":
        return this.#clickByText(req.labels ?? []);
      case "fillField":
        return this.#fillField(req.labels ?? [], req.value, req.kind ?? "auto");
      case "queryText":
        return this.#queryText(req.labels, req.selector);
      case "findTexts":
        return { ok: true, data: { texts: findBarTexts() } };
      case "boxes":
        return { ok: true, data: { boxes: boxesOf(req.selectors ?? []) } };
      case "menuBarState":
        return { ok: true, data: menuBarState() };
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
   *
   * Also carries the click magnet's inputs (shared/coords.ts snapOrPromote):
   * the hit element's rect + editable flag, and — when the point did NOT land
   * on a ref'd control — the nearest interactive element within a small ring
   * around it, so a click 3px off a menu row's edge can be re-aimed at the
   * row instead of silently hitting the menu's padding and closing it.
   */
  #probeAt(x: number, y: number, space?: CoordSpace, radius?: number): ActionResult {
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
            editable: isEditableHost(el) || undefined,
            interactive: Boolean(target),
            rect: rectOf(el),
          }
        : null;
    // The ring search only matters when the point is NOT already on a
    // control — ref'd or not. A control with no ref yet is still the target:
    // ringing past it is how a click snapped 17px onto a neighbouring button.
    const snap = hit?.ref || hit?.interactive ? null : this.#snapNear(point, el, radius);
    const viewport: ViewportInfo = {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
    return { ok: true, data: { hit, viewport, point, snap } };
  }

  /**
   * Ring-probe around a point for the nearest interactive element — the
   * magnet's candidate when the point itself missed every control. Rings at
   * 6, 12, 24… px (doubling up to `radius`) × 8 directions of
   * `document.elementFromPoint` (each O(1) hit-testing), deduped. The
   * runner-up is tracked so a point in the gap between two controls reads as
   * a tie, not a near miss of whichever was probed first. Overlays and popups
   * are found wherever they live in the tree (no ancestor walk), which is
   * exactly the floating-menu case the logged near-misses came from.
   */
  #snapNear(point: Point, exclude: Element | null, radius = SNAP_RADIUS_PX): SnapCandidate | null {
    const reach = Math.max(1, Math.min(Math.round(radius), 200));
    const rings: number[] = [];
    for (let r = 6; r < reach; r *= 2) rings.push(r);
    rings.push(reach);
    type Found = { el: Element; rect: SnapCandidate["rect"]; distance: number };
    const found: Found[] = [];
    const seen = new Set<Element>();
    if (exclude) seen.add(exclude);
    for (const r of rings) {
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8;
        const px = point.x + Math.round(r * Math.cos(a));
        const py = point.y + Math.round(r * Math.sin(a));
        let cand: Element | null = null;
        try {
          cand = document.elementFromPoint(px, py);
        } catch {
          return null; // hit-testing unavailable — no magnet, honest miss
        }
        if (!cand) continue;
        const inter = nearestInteractive(cand);
        if (!inter || seen.has(inter)) continue;
        seen.add(inter);
        const rect = rectOf(inter);
        if (rect.w <= 0 || rect.h <= 0) continue;
        const distance = rectDistance(point, rect);
        if (distance > reach) continue;
        found.push({ el: inter, rect, distance });
      }
    }
    if (!found.length) return null;
    found.sort((a, b) => a.distance - b.distance);
    const [best, second] = found;
    const p = probeOf(best!.el);
    const candidate: SnapCandidate = {
      ref: this.registry.refFor(best!.el) ?? undefined,
      tag: p.tag,
      role: p.role,
      text: p.text,
      editable: isEditableHost(best!.el) || undefined,
      rect: best!.rect,
      distance: best!.distance,
    };
    if (second) {
      const q = probeOf(second.el);
      candidate.runnerUp = {
        tag: q.tag,
        text: q.text,
        ref: this.registry.refFor(second.el) ?? undefined,
        distance: second.distance,
      };
    }
    return candidate;
  }

  /**
   * Click the visible element whose text/aria-label matches one of `labels`
   * (candidates in preference order). The label-walk primitive behind
   * `menu_path` and `docs_op`: menus, dialogs and toolbars are DOM, so a
   * control is found by what it SAYS — never by a coordinate that can drift.
   * Reports exactly what was clicked so the caller (and the run log) can see
   * the route taken.
   */
  #clickByText(labels: string[]): ActionResult {
    if (!labels.length) return { ok: false, error: "clickByText needs at least one label" };
    const found = findByText(labels);
    if (!found) {
      // Teach with the rows of the menu that is OPEN — the ones the caller can
      // actually choose from. Page-wide labels are the fallback, and they are
      // labelled as such so a closed menu is not mistaken for an empty one.
      const open = openMenuRows(12);
      const hint = open.length
        ? missHint(open, "rows in the OPEN menu")
        : (() => {
            const pageRows = visibleLabels(allMenuRows(), labelOf, 12);
            return pageRows.length
              ? ` — no menu is open right now, so its rows are not on screen (open it first)${missHint(pageRows, "clickable labels on the page")}`
              : // Measured live: the bar can be in the DOM with a 0×0 box and
                // every one of its rows invisible, while the toolbar renders
                // normally. "Open it first" is a dead end there — the caller
                // cannot open a bar that is not on screen.
                " — and the MENU BAR IS NOT ON SCREEN at all (not one menu row is visible). Docs hides it in full-screen mode: Ctrl+Shift+F brings the menus back (menu_path tries that itself before giving up). Failing that, take a screenshot and reach this command by keyboard shortcut or a toolbar control.";
          })();
      return {
        ok: false,
        error: `no visible clickable element matches ${JSON.stringify(labels)}${hint}`,
      };
    }
    if (isDisabledEl(found.el)) {
      return {
        ok: false,
        error: `"${found.matched}" was found but is DISABLED (greyed out / aria-disabled) — it cannot be clicked in the current state`,
      };
    }
    const res = this.#click(found.el);
    if (!res.ok) return res;
    return { ok: true, data: { clicked: describeFound(found), matched: found.matched } };
  }

  /**
   * Fill a form field located by its label — aria-label, placeholder, an
   * associated/wrapping <label>, or title. `kind` selects the strategy
   * (auto-detect by default): text via the framework-friendly #type path,
   * select by OPTION TEXT (not internal value), radio/checkbox by click.
   */
  #fillField(
    labels: string[],
    value: string | undefined,
    kind: "auto" | "text" | "select" | "radio",
  ): ActionResult {
    if (!labels.length) return { ok: false, error: "fillField needs at least one label" };
    const found = findField(labels);
    if (!found) {
      const fields = visibleLabels(
        Array.from(document.querySelectorAll<HTMLElement>(FIELD_CANDIDATES)),
        fieldLabelOf,
        10,
      );
      return {
        ok: false,
        error: `no visible form field matches ${JSON.stringify(labels)}${missHint(fields, "fields")}`,
      };
    }
    const el = found.el;
    const effective =
      kind === "auto"
        ? el instanceof HTMLSelectElement
          ? "select"
          : el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")
            ? "radio"
            : "text"
        : kind;
    if (effective === "select") {
      if (!(el instanceof HTMLSelectElement)) {
        return { ok: false, error: `"${found.matched}" is not a <select> — cannot pick an option` };
      }
      const want = collapse(value ?? "").toLowerCase();
      const opt = Array.from(el.options).find(
        (o) =>
          collapse(o.textContent).toLowerCase() === want ||
          collapse(o.textContent).toLowerCase().startsWith(want) ||
          o.value === value,
      );
      if (!opt) {
        const have = Array.from(el.options)
          .map((o) => collapse(o.textContent))
          .filter(Boolean)
          .join(" | ")
          .slice(0, 300);
        return {
          ok: false,
          error: `select "${found.matched}" has no option "${value}" — its options are: ${have || "(none)"}`,
        };
      }
      const res = this.#select(el, opt.value);
      return res.ok
        ? { ok: true, data: { filled: describeFound(found), option: collapse(opt.textContent) } }
        : res;
    }
    if (effective === "radio") {
      const res = this.#click(el);
      if (!res.ok) return res;
      return {
        ok: true,
        data: {
          filled: describeFound(found),
          checked: el instanceof HTMLInputElement ? el.checked : undefined,
        },
      };
    }
    const res = this.#type(el, String(value ?? ""), false);
    if (!res.ok) return res;
    return { ok: true, data: { filled: describeFound(found), value: readValue(el) } };
  }

  /**
   * Read the current text/value of an element — by label candidates or CSS
   * selector. The verification read for docs_op (toolbar style box, dialog
   * fields) and any "what does this control say now" question, without a
   * snapshot round trip.
   */
  #queryText(labels: string[] | undefined, selector: string | undefined): ActionResult {
    let el: Element | null = null;
    let matched = "";
    if (labels?.length) {
      const found = findByText(labels);
      el = found?.el ?? null;
      matched = found?.matched ?? "";
    }
    if (!el && selector) {
      try {
        el = document.querySelector(selector);
      } catch {
        return { ok: false, error: `invalid selector: ${selector}` };
      }
      matched = selector;
    }
    if (!el) {
      return { ok: false, error: "queryText found no matching element" };
    }
    return {
      ok: true,
      data: {
        matched,
        text: collapse((el as HTMLElement).innerText ?? el.textContent ?? "").slice(0, 500),
        value: readValue(el as HTMLElement),
        // Toolbar toggles (bold/italic/…) announce state via aria-pressed or
        // aria-checked — docs_state reads them instead of guessing from pixels.
        pressed: el.getAttribute("aria-pressed") ?? el.getAttribute("aria-checked") ?? undefined,
        tag: el.tagName.toLowerCase(),
      },
    };
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
    scroll?: boolean;
  }): ActionResult {
    const dx = Number.isFinite(req.dx) ? (req.dx as number) : 0;
    const dy = Number.isFinite(req.dy) ? (req.dy as number) : 0;
    let local: Point;
    let rect: { x: number; y: number; w: number; h: number } | undefined;
    let hit: HitInfo | null = null;
    if (req.ref !== undefined) {
      const el = this.#resolve(req.ref);
      if (req.scroll) {
        // Acting resolve: an off-screen ref would resolve to an out-of-
        // viewport point and fail the bounds check. Bring it into view
        // (instant — never honour smooth-scroll CSS, the rect is read right
        // after) and only then measure.
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      }
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
    // The visible agent cursor rides the same point the events hit.
    cursorPing(
      x,
      y,
      types === DOWN_SEQUENCE ? "press" : types === UP_SEQUENCE ? "release" : "move",
    );
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
    // Clicking a file input opens the OS file picker — a modal no tool can
    // drive, left sitting over the page. The `upload` tool (paths/files, or
    // trigger_ref for chooser buttons) is the only sane route; refuse with
    // the redirect instead of trapping the run behind a native dialog.
    if (el instanceof HTMLInputElement && el.type === "file") {
      return {
        ok: false,
        error:
          "INPUT-FAILED: this is a file input — clicking it opens the OS file picker, which no tool can drive. Use `upload` with this ref (paths or files), or upload's trigger_ref on the button that opens the chooser.",
      };
    }
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
    inPopup: popupOpen(el),
  };
}

const POPUP_ROLES = '[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"]';

/** Focus is in, or the page shows, an open menu/dialog — keys belong to it, not the editor. */
function popupOpen(el: HTMLElement): boolean {
  if (el.closest(POPUP_ROLES)) return true;
  const docs: Document[] = [el.ownerDocument];
  try {
    const top = el.ownerDocument.defaultView?.top?.document;
    if (top && top !== docs[0]) docs.push(top);
  } catch {
    // cross-origin top: the frame's own document is all we can see
  }
  for (const d of docs) {
    for (const p of d.querySelectorAll<HTMLElement>(POPUP_ROLES)) {
      if (!onScreenPopup(p)) continue;
      return true;
    }
  }
  return false;
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

/** An element's viewport box, rounded — the magnet/promotion input. */
function rectOf(el: Element): ElementRect {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

// ---------------------------------------------------------------------------
// Label matching — the "menus are DOM" primitives behind clickByText /
// fillField / queryText. A control is found by what it SAYS (aria-label,
// visible text, placeholder, associated <label>), never by a coordinate, so
// a menu walk cannot drift when the layout shifts.
// ---------------------------------------------------------------------------

/** Whitespace-collapsed text for label comparisons. */
function collapse(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** The document lays elements out (real browser) vs every box is zero (jsdom). */
function documentHasLayout(): boolean {
  const b = document.body?.getBoundingClientRect();
  return Boolean(b && (b.height > 0 || b.width > 0));
}

/**
 * Visibility for label matching. Style/hidden checks always apply; a zero box
 * only counts as invisible when the document actually has layout — in jsdom
 * every box is zero and requiring a non-zero rect would hide the world.
 */
function isVisibleLoose(el: Element): boolean {
  const ht = el as HTMLElement;
  if (ht.hidden) return false;
  try {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
  } catch {
    // no computed style available — fall through to the box check
  }
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return !documentHasLayout();
  return true;
}

function isDisabledEl(el: Element): boolean {
  if (el.getAttribute("aria-disabled") === "true") return true;
  return (el as HTMLButtonElement).disabled === true;
}

/** What the label scan considers for clicking. */
const CLICKABLE_CANDIDATES = [
  "button",
  "a[href]",
  "label",
  "summary",
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  "[aria-label]",
  ".goog-menuitem",
].join(", ");

/** What the label scan considers for filling. */
const FIELD_CANDIDATES =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"], [role="radio"], [role="checkbox"]';

interface FoundByLabel {
  el: HTMLElement;
  /** What the element shows/announces — the click report's identity. */
  matched: string;
  score: number;
}

/**
 * Menu rows carry decoration that is never part of the row's NAME: a submenu
 * arrow ("Table of contents►"), Google's accelerator suffix ("CommentCtrl+Alt+M",
 * "Tab(F11)Shift+F11"), and status badges ("Page elementsUpdated►",
 * "eSignaturePremium(1)"). The old matcher accepted only an exact label or
 * "label + space", so every decorated row was invisible to clickByText: a real
 * run was told "Table of contents" and "Page elements" did not exist while both
 * were on screen (D t148/t12), then abandoned label walks for raw DOM clicks.
 *
 * The arrow is stripped outright; a remaining tail is accepted only when EVERY
 * word in it is a known accelerator or badge — so "Insert" still never matches
 * "Insert table", and a wrong path stays a miss instead of clicking a neighbour.
 */
const SUBMENU_ARROW = /[\u25b6\u25ba\u25b8\u2192\u203a\u00bb]+\s*$/;
/** One accelerator chunk: "(Z)", "(F11)", "Ctrl+K", "Shift+F11", "F11". */
const SHORTCUT_CHUNK =
  "(?:\\([a-z]\\)|\\(f\\d{1,2}\\)|f\\d{1,2}|(?:ctrl|cmd|meta|alt|option|shift|fn|\u2318)(?:\\+(?:[\\w\u2318]+))*)";
/** A row can carry several: "Tab(F11)Shift+F11", "Ctrl+Alt+O Ctrl+Alt+H". */
const SHORTCUT_TOKEN = new RegExp(`^(?:${SHORTCUT_CHUNK})+$`, "i");
const BADGE_TOKEN = /^(?:new|updated|beta|premium|try it|early access)(?:\(\d+\))?$|^\(\d+\)$/i;

function stripMenuDecorations(text: string): string {
  return collapse(text.replace(SUBMENU_ARROW, ""));
}

/** True when `rest` (what follows a matched label) is pure row decoration. */
function tailIsDecoration(rest: string): boolean {
  const cleaned = stripMenuDecorations(rest).replace(/^[\s:\u2013\u2014-]+/, "");
  if (!cleaned) return true;
  return cleaned.split(/\s+/).every((t) => SHORTCUT_TOKEN.test(t) || BADGE_TOKEN.test(t));
}

/** Prefix match that tolerates row decoration (see tailIsDecoration). */
function prefixMatches(text: string, want: string): boolean {
  return text.startsWith(want) && tailIsDecoration(text.slice(want.length));
}

/** 0 = exact label match, 1 = label + decoration (accelerator/badge/arrow) or
 *  "Styles: Normal text", 2 = loose prefix (legacy fallback), null = no match. */
function matchScoreOf(el: Element, want: string): number | null {
  const aria = collapse(el.getAttribute("aria-label")).toLowerCase();
  const title = collapse(el.getAttribute("title")).toLowerCase();
  const txt = collapse((el as HTMLElement).innerText ?? el.textContent ?? "").toLowerCase();
  const ph =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? collapse(el.placeholder).toLowerCase()
      : "";
  if (aria === want || title === want || txt === want || ph === want) return 0;
  if (stripMenuDecorations(txt) === want) return 0;
  if (
    prefixMatches(aria, want) ||
    prefixMatches(title, want) ||
    prefixMatches(ph, want) ||
    prefixMatches(txt, want)
  ) {
    return 1;
  }
  // Legacy leniency, ranked below every decorated match: an aria-label like
  // "Styles: Normal text" still answers a "Styles" ask, and "Insert table"
  // still answers "Insert" — but only when nothing cleaner is on screen.
  if (aria.startsWith(want) || title.startsWith(want) || ph.startsWith(want) || txt.startsWith(want)) {
    return 2;
  }
  return null;
}

function labelOf(el: Element): string {
  return (
    collapse(el.getAttribute("aria-label")) ||
    collapse(el.getAttribute("title")) ||
    collapse((el as HTMLElement).innerText ?? el.textContent ?? "")
  ).slice(0, 60);
}

function escapeForSelector(id: string): string {
  try {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
  } catch {
    return id.replace(/"/g, '\\"');
  }
}

/**
 * Find the best clickable element for the first label that matches anything
 * (labels are preference-ordered candidates). Within one label: exact beats
 * prefix; shortest own text wins ties — the innermost control, not its
 * wrapper.
 */
function findByText(labels: string[]): FoundByLabel | null {
  const wants = labels.map((l) => collapse(l).toLowerCase()).filter(Boolean);
  if (!wants.length) return null;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(CLICKABLE_CANDIDATES));
  for (const want of wants) {
    let best: (FoundByLabel & { len: number }) | null = null;
    for (const el of nodes) {
      if (!isVisibleLoose(el)) continue;
      const score = matchScoreOf(el, want);
      if (score === null) continue;
      const len = collapse(el.innerText ?? el.textContent ?? "").length;
      if (!best || score < best.score || (score === best.score && len < best.len)) {
        best = { el, matched: labelOf(el) || want, score, len };
        if (score === 0 && len <= want.length + 2) break; // cannot do better
      }
    }
    if (best) return best;
  }
  return null;
}

/** Like findByText, over form fields, also honouring associated <label>s. */
function findField(labels: string[]): FoundByLabel | null {
  const wants = labels.map((l) => collapse(l).toLowerCase()).filter(Boolean);
  if (!wants.length) return null;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(FIELD_CANDIDATES));
  for (const want of wants) {
    let best: (FoundByLabel & { len: number }) | null = null;
    for (const el of nodes) {
      if (!isVisibleLoose(el)) continue;
      let score = matchScoreOf(el, want);
      if (score === null) {
        // Associated <label>: label[for=id] or a wrapping <label>.
        const lab = el.id
          ? document.querySelector(`label[for="${escapeForSelector(el.id)}"]`)
          : null;
        const wrap = el.closest("label");
        const labText = collapse(lab?.textContent ?? wrap?.textContent ?? "").toLowerCase();
        if (labText === want) score = 0;
        else if (labText && labText.startsWith(want)) score = 1;
      }
      if (score === null) continue;
      const len = collapse(el.innerText ?? el.textContent ?? "").length;
      if (!best || score < best.score || (score === best.score && len < best.len)) {
        best = { el, matched: labelOf(el) || want, score, len };
        if (score === 0) break;
      }
    }
    if (best) return best;
  }
  return null;
}

function describeFound(f: FoundByLabel): string {
  const role = f.el.getAttribute("role");
  const txt = collapse(f.el.innerText ?? f.el.textContent ?? "").slice(0, 60);
  return `<${f.el.tagName.toLowerCase()}${role ? ` role=${role}` : ""}> "${txt || f.matched}"`;
}

/** Menu-ish rows — the siblings a failed menu walk should be taught. */
const MENU_ROW_CANDIDATES =
  '.goog-menuitem, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/** Every menu row in the page, whether its menu is open or not. */
function allMenuRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(MENU_ROW_CANDIDATES));
}

/** What the label walker needs to know before it blames a missing row. */
export interface MenuBarState {
  /** The bar itself is rendered. */
  visible: boolean;
  /** A bar exists in the DOM but is not rendered — the full-screen signature. */
  hiddenBar: boolean;
}

const MENU_BAR_SELECTORS = '.docs-menubar, [role="menubar"]';

/**
 * Is the menu bar on screen? Google Docs' full-screen mode (Ctrl+Shift+F) sets
 * the bar's WRAPPER to display:none and leaves the bar itself in the DOM with
 * every label intact — measured: `.docs-menubars` display:none, `.docs-menubar`
 * inline-block/visible/opacity 1 with a 0×0 box, 0 of 387 rows visible, toolbar
 * fine. Every label walk then misses at step 1 on File/Edit/Format alike, which
 * reads exactly like a renamed menu.
 */
function menuBarState(): MenuBarState {
  const bars = [...document.querySelectorAll<HTMLElement>(MENU_BAR_SELECTORS)];
  // Judged by the BAR, never by the rows: with the bar hidden, a walk's first
  // step can prefix-match a toolbar control ("Insert" → "Insert image") and open
  // a popup whose rows would otherwise look like a working menu bar.
  const visible = bars.some(isVisibleLoose);
  return { visible, hiddenBar: bars.length > 0 && !visible };
}

/**
 * The rows of the menu that is actually OPEN. Page-wide enumeration is worse
 * than useless here: in Google Docs it returns the menu bar and the sidebar's
 * heading list, so a run that missed "Color" inside Format ▸ Text was told the
 * visible rows were "File, Edit, View, Insert, …" and retried blind five times.
 * A submenu is appended after its parent, so the last open popup holding rows
 * is the one waiting for a choice.
 */
function openMenuRows(limit: number): string[] {
  const popups = [...document.querySelectorAll<HTMLElement>(POPUP_ROLES)].filter(onScreenPopup);
  for (let i = popups.length - 1; i >= 0; i--) {
    const rows = visibleLabels(
      Array.from(popups[i]!.querySelectorAll<HTMLElement>(MENU_ROW_CANDIDATES)),
      labelOf,
      limit,
    );
    if (rows.length) return rows;
  }
  return [];
}

/**
 * A popup the user can actually see. `isVisibleLoose` alone is not enough:
 * parked menus sit off-screen with a real width and height, and treating one
 * as open would make every page look like it has a dialog up.
 */
function onScreenPopup(el: HTMLElement): boolean {
  if (!isVisibleLoose(el)) return false;
  if (!documentHasLayout()) return true; // no layout to judge by (jsdom)
  const r = el.getBoundingClientRect();
  const vw = document.defaultView?.innerWidth ?? 0;
  const vh = document.defaultView?.innerHeight ?? 0;
  if (!vw || !vh) return true;
  return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
}

/** Visible, de-duplicated labels from `nodes`, capped for one result line. */
function visibleLabels(
  nodes: HTMLElement[],
  label: (el: HTMLElement) => string,
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const el of nodes) {
    if (!isVisibleLoose(el)) continue;
    const text = collapse(label(el)).slice(0, 28);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * What a MISS teaches: the labels actually on screen. A real run burned ~40
 * turns retrying paths against a menu whose rows it could not name; one line
 * ("visible menu rows: … Header, Footer, Watermark") turns that into a
 * one-turn correction — and names the real row when upstream renamed one
 * ("Table options", not "Table properties").
 */
function missHint(items: string[], what: string): string {
  return items.length ? ` — visible ${what}: ${items.join(", ")}` : "";
}

function fieldLabelOf(el: HTMLElement): string {
  const aria = collapse(el.getAttribute("aria-label"));
  if (aria) return aria;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const ph = collapse(el.placeholder);
    if (ph) return ph;
  }
  const lab = el.id ? document.querySelector(`label[for="${escapeForSelector(el.id)}"]`) : null;
  const wrap = el.closest("label");
  return collapse(
    lab?.textContent ?? wrap?.textContent ?? el.getAttribute("title") ?? el.getAttribute("name") ?? "",
  );
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
/**
 * Where the text caret is, in top-viewport CSS px. Canvas editors paint the
 * text but keep the caret a DOM element (Docs: .kix-cursor-caret); other
 * editors expose it through the selection. The editor's scroll offset rides
 * along so a caller can carry an earlier caret point across a scroll.
 * Collaborators' carets carry a visible name flag — the user's own does not.
 */
/**
 * Short visible leaf texts inside any element whose class or id mentions
 * "find" — matched by shape, not by an exact class, because the find bar's
 * class names are app-internal and have already drifted once.
 */
function findBarTexts(): string[] {
  const out: string[] = [];
  const seen = new Set<Element>();
  for (const box of document.querySelectorAll('[class*="find" i], [id*="find" i]')) {
    for (const el of [box, ...box.querySelectorAll("*")]) {
      if (seen.has(el) || el.childElementCount > 0) continue;
      seen.add(el);
      const text = collapse(el.textContent ?? "");
      if (!text || text.length > 24) continue;
      if ((el as HTMLElement).getClientRects?.().length === 0) continue;
      out.push(text);
      if (out.length >= 40) return out;
    }
  }
  return out;
}

/** One selector's first visible match, as a viewport rect plus its text. */
export interface SelectorBox {
  selector: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
}

const MAX_BOX_SELECTORS = 8;

function boxesOf(selectors: string[]): SelectorBox[] {
  const out: SelectorBox[] = [];
  for (const selector of selectors.slice(0, MAX_BOX_SELECTORS)) {
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(selector);
    } catch {
      continue; // an invalid selector skips itself rather than failing the read
    }
    for (const el of matches) {
      const node = el as HTMLElement;
      const r = node.getBoundingClientRect?.();
      // Hidden-but-present is the normal state of a closed menu: only a laid-out
      // box with an area is something a stroke could land on.
      if (!r || r.width <= 0 || r.height <= 0 || node.getClientRects?.().length === 0) continue;
      const text = collapse(node.textContent ?? "").slice(0, 60);
      out.push({ selector, x: r.x, y: r.y, w: r.width, h: r.height, ...(text ? { text } : {}) });
      break;
    }
  }
  return out;
}

function caretRectOf(): { x: number; y: number; width: number; height: number; scrollTop: number; source: string } | null {
  const scroller = document.querySelector(".kix-appview-editor") as HTMLElement | null;
  const scrollTop = scroller?.scrollTop ?? document.scrollingElement?.scrollTop ?? 0;
  const carets = [...document.querySelectorAll(".kix-cursor-caret")] as HTMLElement[];
  const own = carets
    .map((el) => {
      const cursor = el.closest(".kix-cursor");
      const flag = cursor?.querySelector(".kix-cursor-name") as HTMLElement | null;
      const named = Boolean(flag && collapse(flag.textContent).length && flag.getBoundingClientRect().width > 0);
      return { el, named, rect: el.getBoundingClientRect() };
    })
    .filter((c) => c.rect.height > 0)
    .sort((a, b) => Number(a.named) - Number(b.named));
  if (own[0]) {
    const r = own[0].rect;
    return { x: r.left, y: r.top, width: r.width, height: r.height, scrollTop, source: "kix-caret" };
  }
  const sel = window.getSelection?.();
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(false);
    const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (r && r.height > 0) {
      return { x: r.left, y: r.top, width: r.width, height: r.height, scrollTop, source: "selection" };
    }
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// The visible agent cursor (content-script half of background's
// cursor-overlay.ts): a glowing arrow that glides to the action point and a
// ripple ring where clicks land, so a human watching the browser sees what
// the agent does. Pure decoration — try/catch wrapped, never awaited.
// ---------------------------------------------------------------------------

let cursorFadeTimer: number | undefined;

function cursorPing(x: number, y: number, kind: "move" | "press" | "release"): void {
  try {
    const root = document.documentElement;
    if (!root) return;
    let cur = document.getElementById("__baCursor") as HTMLDivElement | null;
    if (!cur) {
      cur = document.createElement("div");
      cur.id = "__baCursor";
      cur.innerHTML =
        "<svg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
        "<path d='M5.6 3.1 19.7 12l-6.9 1.7L9.5 20.1z' fill='rgba(14,165,233,.92)' " +
        "stroke='white' stroke-width='1.6' stroke-linejoin='round'/></svg>";
      cur.style.cssText =
        "position:fixed;left:-40px;top:-40px;pointer-events:none;z-index:2147483647;opacity:0;" +
        "transition:left 90ms ease-out,top 90ms ease-out,opacity 240ms ease;" +
        "filter:drop-shadow(0 0 5px rgba(56,189,248,.95)) drop-shadow(0 0 16px rgba(56,189,248,.55));" +
        "will-change:left,top";
      root.appendChild(cur);
    }
    cur.style.left = `${Math.round(x) - 4}px`;
    cur.style.top = `${Math.round(y) - 2}px`;
    cur.style.opacity = "1";
    window.clearTimeout(cursorFadeTimer);
    cursorFadeTimer = window.setTimeout(() => {
      if (cur?.isConnected) cur.style.opacity = "0";
    }, 2600);
    if (kind === "move") return;
    const size = kind === "press" ? 16 : 26;
    const ring = document.createElement("div");
    ring.style.cssText =
      `position:fixed;left:${Math.round(x) - size / 2}px;top:${Math.round(y) - size / 2}px;` +
      `width:${size}px;height:${size}px;border-radius:50%;pointer-events:none;` +
      "z-index:2147483647;border:2px solid rgba(56,189,248,.95);background:rgba(56,189,248,.16);" +
      "box-shadow:0 0 18px 5px rgba(56,189,248,.75),inset 0 0 12px rgba(56,189,248,.5)";
    root.appendChild(ring);
    const anim = ring.animate(
      [
        { transform: "scale(.4)", opacity: 1 },
        { transform: "scale(2.1)", opacity: 0 },
      ],
      { duration: 640, easing: "cubic-bezier(.2,.7,.3,1)" },
    );
    anim.onfinish = () => ring.remove();
  } catch {
    /* decoration only — an action never fails over its own cursor */
  }
}
