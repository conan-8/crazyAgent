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
    // Named so a capture can clear it: the ring removes itself on animation
    // finish, and a BACKGROUND tab (the agent's own window usually is one)
    // throttles animations — a "transient" ripple then sits on the page for
    // ever and every later frame comparison sees it as a page change.
    ring.className = "__baRipple";
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

/**
 * Hide the overlay for the duration of one capture, then put it back.
 *
 * The frame differencer reads the pixels to decide whether an action changed
 * anything — and the agent's OWN cursor arrow is painted into the page at the
 * stroke point, so a no-op click measured a "changed" cell that was really our
 * decoration (found on the canvas fixture: the arrow's 24x24 px plus its glow).
 * Suppressing it for the ~200 ms of a capture is invisible to the human
 * watching (the arrow is a slow-fade decoration), and it keeps the verdict
 * about the PAGE. Fail-open: a page that refuses the evaluation just keeps its
 * arrow and the verdict stays slightly conservative.
 */
export async function withCursorHidden<T>(
  tabId: number,
  adapter: BrowserAdapter,
  fn: () => Promise<T>,
): Promise<T> {
  const HIDE = `(() => {
    document.querySelectorAll(".__baRipple").forEach((r) => r.remove());
    const c = document.getElementById("__baCursor");
    if (!c) return "";
    const prev = c.style.opacity;
    // The arrow's own CSS transition (opacity 240ms) would still be ~96%
    // visible when the capture fires a few ms later — the first attempt at
    // this fix measured exactly that (a 3x3 cell "change" at the arrow).
    // Kill the transition for the hide and put it back on restore.
    c.style.transition = "none";
    c.style.opacity = "0";
    clearTimeout(c.__baFadeT);
    return prev;
  })()`;
  const SHOW = `(() => {
    const c = document.getElementById("__baCursor");
    if (!c) return;
    c.style.transition = "left 90ms ease-out,top 90ms ease-out,opacity 240ms ease";
    c.style.opacity = "1";
    clearTimeout(c.__baFadeT);
    c.__baFadeT = setTimeout(() => { if (c.isConnected) c.style.opacity = "0"; }, 2600);
  })()`;
  let prev: string | undefined;
  try {
    const res = await adapter.send<{ result?: { value?: string } }>(tabId, "Runtime.evaluate", {
      expression: HIDE,
      returnByValue: true,
    });
    prev = res?.result?.value;
  } catch {
    // no overlay / no evaluation context — capture as-is
  }
  try {
    // One beat for the compositor: the capture must not race the style change.
    // Only when there WAS a visible change — HIDE returns "" with no overlay and
    // "0" for an arrow that already faded, and in both cases the pixels are
    // identical whether or not we wait. The arrow fades 2.6s after a click, so
    // most captures in a run are of an already-hidden one; this was a flat 90ms
    // on every single shot (173 of them in one benchmark = ~15s).
    const changedSomething = prev !== undefined && prev !== "" && prev !== "0";
    if (changedSomething) await new Promise((resolve) => setTimeout(resolve, 90));
    return await fn();
  } finally {
    // Only restore an arrow that was actually visible: a hidden one (already
    // faded) must stay hidden, or the next capture inherits our own glow.
    if (prev === "1") {
      await adapter
        .send(tabId, "Runtime.evaluate", { expression: SHOW, returnByValue: true })
        .catch(() => undefined);
    }
  }
}
