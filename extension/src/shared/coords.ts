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

export type CoordSpace = "viewport" | "page" | "screenshot";
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

/** An element's box in viewport CSS px (what getBoundingClientRect reports). */
export interface ElementRect {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** The hit accepts text input (input/textarea/contenteditable) — clicking
   *  it is caret placement, so the magnet must never re-aim it. */
  editable?: boolean;
  /** The hit element's box, for the centre-promotion decision. */
  rect?: ElementRect;
}

/**
 * A NEARBY interactive element the content probe found around a point that
 * did not land on one — the magnet's candidate. A click 3px off a menu row's
 * edge hits the menu's padding and closes it silently; this is how the harness
 * knows what the model actually meant.
 */
export interface SnapCandidate {
  ref?: string;
  tag: string;
  role?: string;
  text: string;
  editable?: boolean;
  rect: ElementRect;
  /** CSS-px distance from the requested point to the element's box. */
  distance: number;
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
  const space: CoordSpace =
    args.space === "page" ? "page" : args.space === "screenshot" ? "screenshot" : "viewport";
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
  return space === "viewport" || space === "screenshot"
    ? point
    : { x: point.x - scroll.scrollX, y: point.y - scroll.scrollY };
}

/**
 * How a captured image maps onto the viewport: the image's pixel dims plus
 * the viewport CSS rect it covers. A FULL capture covers (0,0,vpW,vpH); a
 * REGION capture (zoom/crop) covers just its rectangle — the model points at
 * pixels of whichever image it is looking at, and the math holds for both.
 */
export interface ShotMapping {
  imageW: number;
  imageH: number;
  rectX: number;
  rectY: number;
  rectW: number;
  rectH: number;
}

/**
 * Convert a point in SCREENSHOT-image pixels to viewport CSS px — full or
 * region capture alike: `css = rect.origin + img_px × rect_size / image_size`.
 * The image the model sees is a device-pixel capture, usually downscaled, so
 * neither its dimensions nor its scale match the viewport; this owns the
 * math. Pure, so the conversion and its rounding are unit-testable without
 * a browser.
 */
export function screenshotToViewportPoint(point: Point, m: ShotMapping): Point {
  return {
    x: Math.round(m.rectX + (point.x * m.rectW) / m.imageW),
    y: Math.round(m.rectY + (point.y * m.rectH) / m.imageH),
  };
}

/**
 * Validate only the stroke modifiers (button, click_count) — used by the
 * ref/frame input modes where x/y are absent by design.
 */
export function shapeModifiers(
  args: Record<string, unknown>,
): { ok: true; button: MouseButton; clickCount: number } | { ok: false; error: string } {
  let button: MouseButton = "left";
  let clickCount = 1;
  if (args.button !== undefined) {
    const b = String(args.button);
    if (!BUTTONS.includes(b as MouseButton)) {
      return { ok: false, error: `ERROR: parameter button must be one of ${BUTTONS.join(", ")}` };
    }
    button = b as MouseButton;
  }
  if (args.click_count !== undefined) {
    const n = args.click_count;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 3) {
      return { ok: false, error: "ERROR: parameter click_count must be an integer 1..3" };
    }
    clickCount = n;
  }
  return { ok: true, button, clickCount };
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

// ---------------------------------------------------------------------------
// Click sanitizers — the "never misclick" pipeline's pure decisions. Measured
// failure modes these kill (2026-10-06 run logs):
//   - a click 3px off a menu row's edge hits padding and silently closes the
//     menu ("the menu shifted", "off by ~20px")        → snap/promote below;
//   - screenshot image pixels passed without space:'screenshot' land outside
//     the viewport and burn a turn on a bounds error    → reinterpret;
//   - the page scrolled between capture and click, so image-derived points
//     land on whatever moved into place                 → scroll compensation.
// All three are decisions over data the probes already return, so they are
// unit-testable here without a browser.
// ---------------------------------------------------------------------------

/** How far from the requested point the magnet looks for a control. */
export const SNAP_RADIUS_PX = 24;
/** Centre-promotion size caps: menu rows, buttons, icons — not page-wrappers.
 *  A control bigger than this may hold several distinct aim points (a card
 *  with its own buttons), so the model's exact point is respected. */
export const PROMOTE_MAX_W = 600;
export const PROMOTE_MAX_H = 140;

export function rectCenter(r: ElementRect): Point {
  return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
}

/** CSS-px distance from a point to a rect (0 when inside). */
export function rectDistance(point: Point, r: ElementRect): number {
  const dx = Math.max(r.x - point.x, point.x - (r.x + r.w), 0);
  const dy = Math.max(r.y - point.y, point.y - (r.y + r.h), 0);
  return Math.round(Math.hypot(dx, dy));
}

export type SnapDecision =
  | { kind: "keep" }
  | { kind: "promote"; point: Point; label: string }
  | { kind: "snap"; point: Point; label: string };

function controlLabel(tag: string, text: string, ref?: string): string {
  const name = text ? ` "${text.slice(0, 40)}"` : "";
  return `<${tag}>${name}${ref ? ` ref ${ref}` : ""}`;
}

/**
 * The magnet decision for a CLICK-ish call (never type_at/drag_at — caret and
 * plot positions are exact by intent):
 *
 *   PROMOTE — the point already lands on a small interactive control (a menu
 *   row, a button): click its CENTRE instead. An edge pixel and a centre pixel
 *   fire the same control, but the centre cannot slip off a rounded corner,
 *   a 2px border or an anti-aliased edge — and the hit report names what was
 *   really clicked. Text inputs are exempt (a click there is caret placement)
 *   and so are canvas/iframe surfaces (no DOM to centre on).
 *
 *   SNAP — the point missed every control but one sits within SNAP_RADIUS_PX
 *   (probed on a ring around it): the near-miss case the logs kept showing.
 *   Re-aim at that control's centre and SAY SO in the result, so the model
 *   sees the correction instead of a silently closed menu.
 *
 *   KEEP — canvas pixels, editable hosts, big wrappers, empty space: the
 *   model's exact point is respected.
 */
export function snapOrPromote(
  point: Point,
  hit: HitInfo | null,
  snap?: SnapCandidate | null,
): SnapDecision {
  if (hit && !hit.canvas && !hit.overIframe && !hit.editable && hit.ref && hit.rect) {
    const r = hit.rect;
    if (r.w > 0 && r.h > 0 && r.w <= PROMOTE_MAX_W && r.h <= PROMOTE_MAX_H) {
      const c = rectCenter(r);
      if (c.x !== point.x || c.y !== point.y) {
        return {
          kind: "promote",
          point: c,
          label: `aimed at the centre of ${controlLabel(hit.tag, hit.text, hit.ref)} — the control under the point (was ${point.x},${point.y})`,
        };
      }
      return { kind: "keep" };
    }
  }
  if (
    snap &&
    !snap.editable &&
    snap.distance <= SNAP_RADIUS_PX &&
    snap.rect.w > 0 &&
    snap.rect.h > 0 &&
    snap.rect.w <= PROMOTE_MAX_W &&
    snap.rect.h <= PROMOTE_MAX_H
  ) {
    const c = rectCenter(snap.rect);
    return {
      kind: "snap",
      point: c,
      label: `snapped ${snap.distance}px to the nearest control ${controlLabel(snap.tag, snap.text, snap.ref)} — the point (${point.x},${point.y}) was not on one`,
    };
  }
  return { kind: "keep" };
}

/**
 * An out-of-viewport point that fits inside the latest screenshot's IMAGE
 * dimensions is almost certainly image pixels passed without
 * space:'screenshot' (the exact mistake that burned two turns in one run:
 * "(1164, 83) outside the visible viewport (1046x693)" — 1164 is inside the
 * 1280-wide downscaled capture). True ⇒ the caller re-runs the point through
 * the screenshot mapping instead of returning a bounds error. Deliberately
 * conservative: the image must differ in size from the viewport (a 1:1
 * capture proves nothing) and the point must fit the image.
 */
export function looksLikeShotPixels(
  point: Point,
  viewport: { width: number; height: number },
  shot: { imageW: number; imageH: number } | undefined,
): boolean {
  if (!shot) return false;
  const outside =
    point.x < 0 ||
    point.y < 0 ||
    point.x > viewport.width ||
    point.y > viewport.height;
  if (!outside) return false;
  if (point.x > shot.imageW || point.y > shot.imageH) return false;
  return shot.imageW !== viewport.width || shot.imageH !== viewport.height;
}

/**
 * Scroll compensation for `space:'screenshot'` points: the mapping converts
 * image pixels to where the content sat AT CAPTURE TIME. If the page scrolled
 * since, every point must shift by (scrollAtCapture − scrollNow) to follow the
 * content — positive when the page scrolled up since the shot, negative when
 * it scrolled down. No-op when the capture's scroll is unknown (older shot
 * records) or unchanged.
 */
export function compensateShotScroll(
  point: Point,
  atCapture: { scrollX?: number; scrollY?: number } | undefined,
  now: { scrollX: number; scrollY: number },
): { point: Point; dx: number; dy: number } {
  const dx = atCapture?.scrollX !== undefined ? atCapture.scrollX - now.scrollX : 0;
  const dy = atCapture?.scrollY !== undefined ? atCapture.scrollY - now.scrollY : 0;
  if (!dx && !dy) return { point, dx: 0, dy: 0 };
  return { point: { x: point.x + dx, y: point.y + dy }, dx, dy };
}

export type StrokeStep = {
  type: "mouseMoved" | "mousePressed" | "mouseReleased";
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
  /** CDP modifier bitfield for the stroke: Alt=1, Ctrl=2, Meta=4, Shift=8. */
  modifiers?: number;
};

const move = (p: Point, modifiers?: number): StrokeStep => ({ type: "mouseMoved", x: p.x, y: p.y, modifiers });
const down = (p: Point, b: MouseButton, n: number, modifiers?: number): StrokeStep => ({
  type: "mousePressed",
  x: p.x,
  y: p.y,
  button: b,
  clickCount: n,
  modifiers,
});
const up = (p: Point, b: MouseButton, n: number, modifiers?: number): StrokeStep => ({
  type: "mouseReleased",
  x: p.x,
  y: p.y,
  button: b,
  clickCount: n,
  modifiers,
});

/** A click stroke. Multi-clicks expand to the real event sequence.
 *  `modifiers` (CDP bitfield: Alt=1, Ctrl=2, Meta=4, Shift=8) rides every
 *  event — Shift+click extends a selection, exactly like a user's. */
export function planClick(
  point: Point,
  button: MouseButton = "left",
  clickCount = 1,
  modifiers?: number,
): StrokeStep[] {
  const steps: StrokeStep[] = [move(point)];
  for (let n = 1; n <= clickCount; n++) {
    steps.push(down(point, button, n, modifiers), up(point, button, n, modifiers));
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
      "Coordinate space: 'viewport' (default) = CSS px from the visible viewport's top-left; 'screenshot' = pixels of the latest screenshot image (what you are looking at — the tool converts for you); 'page' = document coordinates (as element boxes report).",
  },
};

/**
 * Ceiling on one batched drags list. The graph task that motivated batching
 * needed ~30 points; a runaway list would spend minutes in strokes with no
 * checkpoint between them.
 */
export const MAX_BATCH_DRAGS = 32;

/** One validated drag of a batch: start and end in viewport space. */
export interface DragItem {
  from: Point;
  to: Point;
}

export type DragListResult =
  | { ok: true; drags: DragItem[] }
  | { ok: false; error: string };

/**
 * Validate a `drags: [{x, y, to_x, to_y}, …]` list for the batched form of
 * `drag_at`. Ref-based entries ({ref, to_ref?…}) are validated structurally
 * (strings) and resolved against the page later — this pure half only checks
 * what it can see.
 */
export function shapeDragList(args: Record<string, unknown>): DragListResult {
  const raw = args.drags;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "ERROR: parameter drags must be a non-empty array of {x, y, to_x, to_y}" };
  }
  if (raw.length > MAX_BATCH_DRAGS) {
    return { ok: false, error: `ERROR: drags is limited to ${MAX_BATCH_DRAGS} entries (got ${raw.length}) — split across calls` };
  }
  const drags: DragItem[] = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: `ERROR: drags[${i}] must be an object` };
    }
    const o = item as Record<string, unknown>;
    // Ref-shaped entries pass through for page-side resolution.
    if (typeof o.ref === "string" || typeof o.to_ref === "string") {
      if (typeof o.ref !== "string" && (o.x === undefined || o.y === undefined)) {
        return { ok: false, error: `ERROR: drags[${i}] needs either ref or x/y for its start point` };
      }
      if (typeof o.to_ref !== "string" && (o.to_x === undefined || o.to_y === undefined)) {
        return { ok: false, error: `ERROR: drags[${i}] needs either to_ref or to_x/to_y for its end point` };
      }
      // Numeric coords present alongside refs are validated when used.
      continue;
    }
    const p = shapePoint("", o);
    if ("error" in p) return { ok: false, error: `ERROR: drags[${i}].${p.error.slice("ERROR: parameter ".length)}` };
    const t = shapePoint("to", o);
    if ("error" in t) return { ok: false, error: `ERROR: drags[${i}].${t.error.slice("ERROR: parameter ".length)}` };
    drags.push({ from: p, to: t });
  }
  // Ref entries are resolved later; keep their count in the result so the
  // caller knows how many page round trips remain.
  return { ok: true, drags };
}

/** Count ref-based entries in a raw drags list (they bypass pure validation). */
export function countRefDrags(args: Record<string, unknown>): number {
  const raw = args.drags;
  if (!Array.isArray(raw)) return 0;
  return raw.filter(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (typeof (item as Record<string, unknown>).ref === "string" ||
        typeof (item as Record<string, unknown>).to_ref === "string"),
  ).length;
}

// ---------------------------------------------------------------------------
// input_sequence — chained mouse/keyboard steps in one call. A menu path
// (open menu → click item → type → Return) or a table fill (type/Tab × N) is
// one LLM round trip this way, not 8. Pure shaping here; the CDP half lives
// with the coordinate tools.
// ---------------------------------------------------------------------------

/** Ceiling on one sequence: enough for a long menu path or a table fill,
 *  small enough that a runaway list cannot spend minutes unattended. */
export const MAX_SEQUENCE_STEPS = 24;
/** One wait step is clamped — waits exist for menus/animations, not naps. */
export const SEQUENCE_MAX_WAIT_MS = 5_000;

export interface SequenceStep {
  kind: "click" | "hover" | "key" | "type" | "wait";
  /** click/hover payload: the full arg shape of click_at/hover_at (x/y +
   * space, or ref + dx/dy, or frame-local), resolved at EXECUTION time. */
  point?: Record<string, unknown>;
  key?: string;
  text?: string;
  select?: "all";
  waitMs?: number;
}

export type SequenceResult =
  | { ok: true; steps: SequenceStep[] }
  | { ok: false; error: string };

/**
 * Find the steps list in whatever shape the model produced it: `steps` as
 * documented, a common alias (`sequence`/`actions`/`calls`), or the single
 * array-valued key of the arguments. The model called this tool with
 * `{"click_at": …}` steps and bare arrays in real runs — an error naming
 * accepted shapes beats "missing required parameter" that helps nobody.
 */
function findStepsList(args: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(args.steps)) return args.steps;
  for (const [k, v] of Object.entries(args)) {
    if (Array.isArray(v)) return v;
    void k;
  }
  return null;
}

/** Step-key → kind, with the tool-name aliases the model reaches for. */
const STEP_ALIASES: Record<string, "click" | "hover" | "key" | "type" | "wait" | "type_at"> = {
  click: "click",
  click_at: "click",
  hover: "hover",
  hover_at: "hover",
  key: "key",
  press: "key",
  type: "type",
  type_at: "type_at",
  wait_ms: "wait",
  wait: "wait",
  sleep: "wait",
};

/**
 * Validate an `input_sequence` steps list. Accepts each step as
 * {click:{...}} | {hover:{...}} | {key:"Control+a"} | {type:"text"} |
 * {type:{text, select:"all"}} | {wait_ms:250}, plus the natural aliases the
 * model writes ({click_at:{…}}, {type_at:{…, text}} → click + type).
 */
export function shapeSequenceSteps(args: Record<string, unknown>): SequenceResult {
  const raw = findStepsList(args);
  if (!raw || raw.length === 0) {
    return {
      ok: false,
      error:
        "ERROR: input_sequence needs a `steps` array — [{click:{x,y,space:'screenshot'}}, {type:'text'}, {key:'Return'}, {wait_ms:250}]; click_at/type_at/hover_at are accepted as step keys too",
    };
  }
  if (raw.length > MAX_SEQUENCE_STEPS) {
    return {
      ok: false,
      error: `ERROR: steps is limited to ${MAX_SEQUENCE_STEPS} (got ${raw.length}) — split across calls`,
    };
  }
  const steps: SequenceStep[] = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: `ERROR: steps[${i}] must be an object` };
    }
    const o = item as Record<string, unknown>;
    const kindKey = Object.keys(o).find((k) => STEP_ALIASES[k.toLowerCase()]);
    if (!kindKey) {
      return {
        ok: false,
        error: `ERROR: steps[${i}] needs one of click / hover / key / type / wait_ms (click_at, type_at, hover_at, press, sleep also accepted)`,
      };
    }
    const kind = STEP_ALIASES[kindKey.toLowerCase()]!;
    const val = o[kindKey];
    if (kind === "click" || kind === "hover") {
      if (typeof val !== "object" || val === null) {
        return { ok: false, error: `ERROR: steps[${i}].${kindKey} must be an object (click_at's arg shape)` };
      }
      steps.push({ kind, point: val as Record<string, unknown> });
      continue;
    }
    if (kind === "key") {
      const key = typeof val === "string" ? val : (val as { key?: unknown } | null)?.key;
      if (typeof key !== "string" || !key.trim()) {
        return { ok: false, error: `ERROR: steps[${i}].key must be a non-empty key combo string` };
      }
      steps.push({ kind: "key", key });
      continue;
    }
    if (kind === "type") {
      if (typeof val === "string") {
        steps.push({ kind: "type", text: val });
        continue;
      }
      if (typeof val === "object" && val !== null && typeof (val as Record<string, unknown>).text === "string") {
        const t = val as Record<string, unknown>;
        steps.push({
          kind: "type",
          text: t.text as string,
          select: t.select === "all" ? "all" : undefined,
        });
        continue;
      }
      return { ok: false, error: `ERROR: steps[${i}].type must be a string or {text, select:'all'}` };
    }
    if (kind === "type_at") {
      // The model writes {type_at:{x, y, text}} — expand to click + type.
      if (typeof val !== "object" || val === null) {
        return { ok: false, error: `ERROR: steps[${i}].type_at must be an object (click_at's shape + text)` };
      }
      const t = val as Record<string, unknown>;
      if (typeof t.text !== "string") {
        return { ok: false, error: `ERROR: steps[${i}].type_at needs a text string` };
      }
      if (t.select_to !== undefined) {
        return {
          ok: false,
          error: `ERROR: steps[${i}].type_at with select_to is not supported inside a sequence — use the type_at tool directly for click+shift-click selections`,
        };
      }
      const point: Record<string, unknown> = { ...t };
      delete point.text;
      delete point.select;
      delete point.keys_after;
      steps.push({ kind: "click", point });
      steps.push({
        kind: "type",
        text: t.text as string,
        select: t.select === "all" ? "all" : undefined,
      });
      if (Array.isArray(t.keys_after)) {
        for (const k of t.keys_after as unknown[]) steps.push({ kind: "key", key: String(k) });
      }
      continue;
    }
    // wait
    const w = typeof val === "number" ? val : (val as { wait_ms?: unknown } | null)?.wait_ms;
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0) {
      return { ok: false, error: `ERROR: steps[${i}].wait_ms must be a non-negative number of milliseconds` };
    }
    steps.push({ kind: "wait", waitMs: Math.min(w, SEQUENCE_MAX_WAIT_MS) });
  }
  return { ok: true, steps };
};
