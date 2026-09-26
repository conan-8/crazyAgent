// Element registry (content-script side): collects interactive elements —
// including open shadow roots — assigns snapshot-scoped refs, and resolves
// refs back to live elements later, including after SPA re-renders (via
// CSS-path + text fallbacks).

export interface ElementInfo {
  ref: string;
  tag: string;
  role?: string;
  type?: string;
  name: string;
  value?: string;
  /** True when this element accepts typed text (form control or contenteditable). */
  editable?: boolean;
  disabled?: boolean;
  checked?: boolean;
  href?: string;
  box: { x: number; y: number; w: number; h: number } | null;
  selector: string;
}

export interface FrameSnapshot {
  href: string;
  title: string;
  text: string;
  elements: ElementInfo[];
  timestamp: number;
  /**
   * How many <canvas> elements this frame paints into, and how much DOM text
   * it produced. Together they let the worker tell "this frame is empty" apart
   * from "this frame draws its content into a canvas, which no tool can read".
   */
  canvases: number;
  textChars: number;
}

const INTERACTIVE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
  "[contenteditable]:not([contenteditable=\"false\"])",
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="switch"]',
  "[onclick]",
].join(", ");

/**
 * Is this node a contenteditable text host? `isContentEditable` is the fast
 * path but is not implemented everywhere (jsdom returns undefined), so fall
 * back to the attribute itself — including the bare `contenteditable` form
 * Instagram's DM composer uses. An explicit "false" always wins.
 */
export function isEditableHost(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return true;
  }
  const attr = el.getAttribute("contenteditable");
  if (attr !== null) return attr.toLowerCase() !== "false";
  return (el as HTMLElement).isContentEditable === true;
}

interface Registration {
  el: WeakRef<Element>;
  tag: string;
  selector: string;
  text: string;
}

function escapeIdent(s: string): string {
  const esc = (globalThis as { CSS?: { escape?(v: string): string } }).CSS
    ?.escape;
  return esc ? esc(s) : s.replace(/([^\w-])/g, "\\$1");
}

/** Short CSS path, used as the stale-ref fallback. */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 5) {
    if (cur.id) {
      parts.unshift(`${cur.tagName.toLowerCase()}#${escapeIdent(cur.id)}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      parts.unshift(cur.tagName.toLowerCase());
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === cur!.tagName,
    );
    const nth =
      siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(cur) + 1})` : "";
    parts.unshift(cur.tagName.toLowerCase() + nth);
    cur = parent;
  }
  return parts.join(" > ");
}

/** True when the element matches the interactive set the registry collects. */
export function isInteractive(el: Element): boolean {
  try {
    return el.matches(INTERACTIVE);
  } catch {
    return false;
  }
}

/**
 * The nearest interactive element at or above `el` — what a click at a point
 * would really be acting on. Coordinate input feeds this to the policy layer
 * so `click_at` is gated exactly like a ref-based `click`.
 */
export function nearestInteractive(el: Element | null): Element | null {
  let cur: Element | null = el;
  while (cur) {
    if (isInteractive(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function isVisible(el: Element): boolean {
  if ((el as HTMLElement).hidden) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function textOf(el: Element): string {
  const ht = el as HTMLElement;
  return (ht.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Best human description of an interactive element. */
function describe(el: Element): { name: string; text: string } {
  const input = el as HTMLInputElement;
  // For selects, the meaningful text is the selected option, not "AllTitles".
  const text =
    el instanceof HTMLSelectElement
      ? (el.selectedOptions[0]?.textContent ?? "").replace(/\s+/g, " ").trim()
      : textOf(el);
  const labelText =
    input.labels?.[0]?.textContent?.replace(/\s+/g, " ").trim() ??
    el.closest("label")?.textContent?.replace(/\s+/g, " ").trim();
  const name =
    el.getAttribute("aria-label") ??
    labelText ??
    el.getAttribute("placeholder") ??
    el.getAttribute("title") ??
    el.getAttribute("alt") ??
    (text || undefined) ??
    input.value ??
    "";
  return { name: name.trim(), text };
}

function collectCandidates(root: Document | ShadowRoot): Element[] {
  const out: Element[] = [];
  const visit = (node: Document | ShadowRoot | Element): void => {
    for (const el of node.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.matches(INTERACTIVE)) out.push(el);
    }
  };
  visit(root);
  return out;
}

function textDigest(): string {
  return (document.body?.innerText ?? document.body?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

/** The frame's full body-text length, before the 2 KB digest cap. */
function rawTextLength(): number {
  return (document.body?.innerText ?? document.body?.textContent ?? "").replace(/\s+/g, " ").trim()
    .length;
}

/** How many canvases this frame paints into (a known unreadable surface). */
function safeCanvasCount(): number {
  try {
    return document.querySelectorAll("canvas").length;
  } catch {
    return 0;
  }
}

export class ElementRegistry {
  #registrations = new Map<string, Registration>();

  collect(): FrameSnapshot {
    this.#registrations.clear();
    const elements: ElementInfo[] = [];
    let n = 0;
    for (const el of collectCandidates(document)) {
      if (!isVisible(el)) continue;
      n++;
      const ref = String(n);
      const selector = cssPath(el);
      const { name, text } = describe(el);
      const rect = el.getBoundingClientRect();
      const box =
        rect.width === 0 &&
        rect.height === 0 &&
        el.getClientRects().length === 0
          ? null
          : { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      const input = el as HTMLInputElement;
      const isFormControl =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLButtonElement ||
        el instanceof HTMLSelectElement;
      const contentEditable = isEditableHost(el);
      // Only inputs/textarea/contenteditable accept typed text — a <button>
      // or <select> is a form control but has no text to type into.
      const isTextHost =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        contentEditable;
      elements.push({
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? undefined,
        type: isFormControl ? input.type : undefined,
        name,
        value: isFormControl
          ? String(input.value ?? "")
          : contentEditable
            ? (el.textContent ?? "")
            : undefined,
        // Surface typability so the model knows it can `type` here; rich-text
        // composers (contenteditable divs) are otherwise indistinguishable
        // from a plain clickable div.
        editable: isTextHost,
        disabled: isFormControl ? Boolean(input.disabled) : undefined,
        checked: isFormControl ? Boolean(input.checked) : undefined,
        href: el.getAttribute("href") ?? undefined,
        box,
        selector,
      });
      this.#registrations.set(ref, {
        el: new WeakRef(el),
        tag: el.tagName.toLowerCase(),
        selector,
        text,
      });
    }
    return {
      href: location.href,
      title: document.title,
      text: textDigest(),
      elements,
      timestamp: Date.now(),
      canvases: safeCanvasCount(),
      textChars: rawTextLength(),
    };
  }

  /** Lightweight page read that does NOT renumber refs (unlike collect). */
  read(): {
    href: string;
    title: string;
    text: string;
    canvases: number;
    textChars: number;
  } {
    return {
      href: location.href,
      title: document.title,
      text: textDigest(),
      canvases: safeCanvasCount(),
      textChars: rawTextLength(),
    };
  }

  /** Reverse lookup: the snapshot ref of a live element, if the registry has one. */
  refFor(el: Element): string | null {
    for (const [ref, reg] of this.#registrations) {
      if (reg.el.deref() === el) return ref;
    }
    return null;
  }

  /** Resolve a ref to a live element, recovering from SPA re-renders. */
  resolve(ref: string): Element | null {
    const reg = this.#registrations.get(ref);
    const el = reg?.el.deref();
    if (el?.isConnected) return el;
    if (reg) {
      const match = (candidates: Iterable<Element>): Element | null => {
        for (const candidate of candidates) {
          if (
            candidate.isConnected &&
            (!reg.text || describe(candidate).text === reg.text)
          ) {
            return candidate;
          }
        }
        return null;
      };
      // Tier 1: exact CSS path (+ text). Tier 2: same tag + same text —
      // covers re-renders that also change ids/classes.
      const found =
        match(document.querySelectorAll(reg.selector)) ??
        (reg.text ? match(document.querySelectorAll(reg.tag)) : null);
      if (found) {
        this.#registrations.set(ref, {
          el: new WeakRef(found),
          tag: reg.tag,
          selector: cssPath(found),
          text: reg.text,
        });
        return found;
      }
    }
    return null;
  }
}

export function textDigestOfPage(): string {
  return textDigest();
}
