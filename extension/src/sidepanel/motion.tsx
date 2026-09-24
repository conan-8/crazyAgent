// Motion primitives for the side panel. Everything animates with CSS; these
// hooks only manage the DOM lifetime that CSS alone cannot (exit animations,
// height-to-auto, scroll pinning).
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

/**
 * Keep an element mounted long enough to play its exit animation.
 * Render while `mounted`; drive CSS from `state` via `data-state`.
 */
export function usePresence(open: boolean, exitMs = 260) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);
  return { mounted: open || mounted, state: open ? "open" : "closed" } as const;
}

/**
 * Height-animated disclosure (grid-rows 0fr → 1fr). Children mount on first
 * open and stay mounted so collapsing animates instead of snapping.
 */
export function Collapse({
  open,
  children,
}: {
  open: boolean;
  children: ComponentChildren;
}) {
  const [seen, setSeen] = useState(open);
  useEffect(() => {
    if (open) setSeen(true);
  }, [open]);
  return (
    <div class={`collapse${open ? " is-open" : ""}`} aria-hidden={!open}>
      <div class="collapse-inner">{seen || open ? children : null}</div>
    </div>
  );
}

/**
 * Pin a scroll container to its bottom while content is streaming in and the
 * user is there; let go as soon as they scroll up to read. Watches content
 * size so animated growth keeps the view pinned. When `follow` is off (idle),
 * growth such as expanding a card is left where the user put it.
 */
export function useStickToBottom<
  S extends HTMLElement = HTMLElement,
  C extends HTMLElement = HTMLElement,
>(follow: boolean) {
  const scrollRef = useRef<S | null>(null);
  const contentRef = useRef<C | null>(null);
  const pinned = useRef(true);
  const following = useRef(follow);
  following.current = follow;
  const [atBottom, setAtBottom] = useState(true);

  const pin = () => {
    const el = scrollRef.current;
    if (el && pinned.current && following.current) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      pinned.current = near;
      setAtBottom(near);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(pin);
    ro.observe(content);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  useLayoutEffect(pin);

  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  return { scrollRef, contentRef, atBottom, scrollToBottom };
}

/**
 * Grow a textarea with its content, up to `max` pixels. Re-measures when the
 * panel is resized, since wrapping (placeholder included) depends on width.
 */
export function useAutosize(value: string, max = 180) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  };
  useLayoutEffect(fit, [value, max]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [max]);
  return ref;
}
