// Cursor overlay — a glowing "agent cursor" painted into the page at every
// trusted mouse stroke, so a human watching the browser can see where the
// agent points, presses and releases.
//
// Injected via Runtime.evaluate on purpose: coordinate strokes exist for
// surfaces whose content script is often dead, so the overlay must not
// depend on it either. Calls are FIRE-AND-FORGET (never awaited) — the
// overlay adds zero latency to the stroke itself, and a page that rejects
// the evaluation just shows nothing.
import type { BrowserAdapter } from "../adapters/types";

export type CursorPingKind = "move" | "press" | "release";

/**
 * The page-side overlay, as a function source string (invoked with x/y/kind
 * by cursorPing). Kept dependency-free and try/catch-wrapped: it runs in the
 * page's main world, where a CSP quirk or a missing documentElement must
 * never surface as a tool failure.
 *
 * Two visuals:
 *  - a persistent arrow cursor (#__baCursor) that glides to the latest
 *    stroke point (CSS transition) and fades after a few idle seconds;
 *  - a glowing ripple ring on press/release — the "where it clicked" pulse.
 */
const CURSOR_FN_SRC = `(x, y, kind) => {
  try {
    const root = document.documentElement;
    if (!root) return;
    let cur = document.getElementById("__baCursor");
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
    cur.style.left = x - 4 + "px";
    cur.style.top = y - 2 + "px";
    cur.style.opacity = "1";
    clearTimeout(cur.__baFadeT);
    cur.__baFadeT = setTimeout(() => {
      if (cur.isConnected) cur.style.opacity = "0";
    }, 2600);
    if (kind === "move") return;
    const size = kind === "press" ? 16 : 26;
    const ring = document.createElement("div");
    ring.style.cssText =
      "position:fixed;left:" + (x - size / 2) + "px;top:" + (y - size / 2) + "px;" +
      "width:" + size + "px;height:" + size + "px;border-radius:50%;pointer-events:none;" +
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
  } catch (e) {
    /* the overlay is decoration — never break a stroke over it */
  }
}`;

/**
 * Paint the cursor at (x, y) in top-viewport coordinates. Fire-and-forget:
 * the promise is dropped on purpose so the stroke pipeline never waits on
 * (or fails over) a visual.
 */
export function cursorPing(
  tabId: number,
  adapter: BrowserAdapter,
  x: number,
  y: number,
  kind: CursorPingKind,
): void {
  const expression = `(${CURSOR_FN_SRC})(${Math.round(x)}, ${Math.round(y)}, ${JSON.stringify(kind)})`;
  void adapter.send(tabId, "Runtime.evaluate", { expression }).catch(() => undefined);
}
