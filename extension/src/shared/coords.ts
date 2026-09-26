// Coordinate input — pure helpers (arg shaping, coordinate conversion, stroke
// plans) shared by the click_at / hover_at / drag_at tools and their unit
// tests. The CDP half lives in background/tools/coords.ts.
//
// Why coordinates exist at all: a canvas-drawn surface (a Figma/Miro board, a
// map, a slider, a canvas document editor's page body) has no DOM element to
// hold a ref, so ref-based clicking cannot reach it. Claude in Chrome solves
// this with coordinate clicks over Input.dispatchMouseEvent; so does this now.
//
// Coordinate space: CSS pixels relative to the visible VIEWPORT's top-left —
// the same frame `screenshot` captures, so the model can point at exactly what
// it sees. `space: "page"` accepts document coordinates (what element boxes
// report) and is converted using the scroll offsets.

export type CoordSpace = "viewport" | "page";
export type MouseButton = "left" | "right" | "middle";

export interface Point {
  x: number;
  y: number;
}

export interface ViewportInfo {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

/** What sits under a point, as far as the DOM can tell. */
export interface HitInfo {
  tag: string;
  type?: string;
  role?: string;
  text: string;
  inForm: boolean;
  /** Snapshot ref of the hit element, when the registry knows it. */
  ref?: string;
  /** The hit is a <canvas> (or inside one) — pixels, no DOM to act on. */
  canvas: boolean;
  /** The point is over an iframe; the real target is inside it. */
  overIframe: boolean;
}

const BUTTONS: MouseButton[] = ["left", "right", "middle"];

export type ShapeResult =
  | {
      ok: true;
      space: CoordSpace;
      from: Point;
      to?: Point;
      button: MouseButton;
      clickCount: number;
    }
  | { ok: false; error: string };

function shapePoint(
  prefix: string,
  args: Record<string, unknown>,
): Point | { error: string } {
  const x = args[`${prefix ? prefix + "_" : ""}x`];
  const y = args[`${prefix ? prefix + "_" : ""}y`];
  if (typeof x !== "number" || !Number.isFinite(x)) {
    return { error: `ERROR: parameter ${prefix ? prefix + "_" : ""}x must be a finite number` };
  }
  if (typeof y !== "number" || !Number.isFinite(y)) {
    return { error: `ERROR: parameter ${prefix ? prefix + "_" : ""}y must be a finite number` };
  }
  return { x, y };
}

/**
 * Validate and normalise the coordinate tools' arguments. Returns tool-error
 * text (prefixed `ERROR:` like validateToolArgs) instead of throwing, so the
 * caller can hand it straight to the model.
 */
export function shapeCoordArgs(args: Record<string, unknown>): ShapeResult {
  const space: CoordSpace = args.space === "page" ? "page" : "viewport";
  const from = shapePoint("", args);
  if ("error" in from) return { ok: false, error: from.error };
  const result: Extract<ShapeResult, { ok: true }> = {
    ok: true,
    space,
    from,
    button: "left",
    clickCount: 1,
  };
  if (args.to_x !== undefined || args.to_y !== undefined) {
    const to = shapePoint("to", args);
    if ("error" in to) return { ok: false, error: to.error };
    result.to = to;
  }
  if (args.button !== undefined) {
    const button = String(args.button);
    if (!BUTTONS.includes(button as MouseButton)) {
      return { ok: false, error: `ERROR: parameter button must be one of ${BUTTONS.join(", ")}` };
    }
    result.button = button as MouseButton;
  }
  if (args.click_count !== undefined) {
    const n = args.click_count;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 3) {
      return { ok: false, error: "ERROR: parameter click_count must be an integer 1..3" };
    }
    result.clickCount = n;
  }
  return result;
}

/** Convert a document-space point to viewport space (viewport space is a no-op). */
export function toViewportPoint(
  point: Point,
  space: CoordSpace,
  scroll: Pick<ViewportInfo, "scrollX" | "scrollY">,
): Point {
  return space === "viewport"
    ? point
    : { x: point.x - scroll.scrollX, y: point.y - scroll.scrollY };
}

/**
 * Bounds check in viewport space. A miss must say what the bounds ARE — a bare
 * "out of bounds" sends the model into guessing new coordinates.
 */
export function boundsError(point: Point, viewport: ViewportInfo): string | null {
  if (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x <= viewport.width &&
    point.y <= viewport.height
  ) {
    return null;
  }
  return (
    `point (${point.x}, ${point.y}) is outside the visible viewport ` +
    `(${viewport.width}x${viewport.height} at scroll ${viewport.scrollX},${viewport.scrollY}) — ` +
    `scroll first (the scroll tool) or use a point inside the viewport`
  );
}

export type StrokeStep = {
  type: "mouseMoved" | "mousePressed" | "mouseReleased";
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
};

const move = (p: Point): StrokeStep => ({ type: "mouseMoved", x: p.x, y: p.y });
const down = (p: Point, b: MouseButton, n: number): StrokeStep => ({
  type: "mousePressed",
  x: p.x,
  y: p.y,
  button: b,
  clickCount: n,
});
const up = (p: Point, b: MouseButton, n: number): StrokeStep => ({
  type: "mouseReleased",
  x: p.x,
  y: p.y,
  button: b,
  clickCount: n,
});

/** A click stroke. Multi-clicks expand to the real event sequence. */
export function planClick(
  point: Point,
  button: MouseButton = "left",
  clickCount = 1,
): StrokeStep[] {
  const steps: StrokeStep[] = [move(point)];
  for (let n = 1; n <= clickCount; n++) {
    steps.push(down(point, button, n), up(point, button, n));
  }
  return steps;
}

export function planHover(point: Point): StrokeStep[] {
  return [move(point)];
}

/**
 * A drag stroke: press at `from`, move through interpolated points (so
 * drag-listeners see a real path, not two lonely events), release at `to`.
 */
export function planDrag(
  from: Point,
  to: Point,
  steps = 12,
  button: MouseButton = "left",
): StrokeStep[] {
  const out: StrokeStep[] = [move(from), down(from, button, 1)];
  const n = Math.max(1, Math.floor(steps));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push(
      move({ x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) }),
    );
  }
  out.push(up(to, button, 1));
  return out;
}

/** One-line description of what is under a point, for the tool result. */
export function describeHit(hit: HitInfo | null): string {
  if (!hit) return "nothing at that point (the page has no element there)";
  const ref = hit.ref ? ` ref ${hit.ref}` : "";
  const name = hit.text ? ` "${hit.text.slice(0, 60)}"` : "";
  const kind = hit.canvas ? "canvas pixel surface" : `<${hit.tag}${hit.type ? ` type=${hit.type}` : ""}>`;
  const frame = hit.overIframe ? " — over an iframe; the real target is inside it" : "";
  return `${kind}${name}${ref}${frame}`;
}

/**
 * The parameters block shared by click_at / hover_at / drag_at (pure data, so
 * tool registration and tests cannot drift apart).
 */
export const COORD_SPACE_PROP = {
  space: {
    type: "string",
    description:
      "Coordinate space: 'viewport' (default) = CSS px from the visible viewport's top-left, matching the screenshot; 'page' = document coordinates (as element boxes report).",
  },
};
