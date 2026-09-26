// Coordinate tools — click / hover / drag at an x,y point, plus `element_at`
// to see what is under one. The pure half (arg shaping, coordinate conversion,
// stroke plans) is shared/coords.ts; this file is the CDP half.
//
// Why these exist: a canvas-drawn surface (Figma/Miro boards, maps, sliders,
// a canvas document editor's page body) has NO DOM element to hold a ref, so
// ref-based clicking cannot reach it. The strokes go through
// Input.dispatchMouseEvent — the browser's own input pipeline, so the page
// sees real `isTrusted: true` mouse events, exactly like the trusted typing in
// trusted-input.ts. Two measured properties shape the design:
//   - Coordinates are CSS pixels from the visible viewport's top-left, i.e.
//     exactly the frame `screenshot` captures; `space: "page"` accepts
//     document coordinates instead (what element boxes report).
//   - Input only reaches the ACTIVE tab's render widget (a background tab
//     accepts the command and does nothing), so the tab is activated first.
//
// Policy parity: before a stroke is sent, the point is probed with
// `document.elementFromPoint` and the nearest interactive ancestor is handed
// to the same assess() a ref-based `click` gets — so clicking "Buy now" by
// coordinate raises the same confirmation card as clicking it by ref.
import {
  boundsError,
  describeHit,
  planClick,
  planDrag,
  planHover,
  shapeCoordArgs,
  COORD_SPACE_PROP,
  type HitInfo,
  type Point,
  type StrokeStep,
  type ViewportInfo,
} from "../../shared/coords";
import { failureTag } from "../../shared/tool-failure";
import { trustedInputFailure } from "../../shared/trusted-input";
import type { ElementProbe } from "../policy";
import { runContentAction } from "./content-action";
import { ensureTabActive } from "./trusted-input";
import { registerTool, type ToolContext } from "./types";

/** Keystroke/mouse steps are separate CDP calls; a beat keeps them ordered. */
const BETWEEN_STEPS_MS = 12;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PointProbe {
  hit: HitInfo | null;
  viewport: ViewportInfo;
  point: Point;
}

async function probePoint(
  tabId: number,
  x: number,
  y: number,
  space: "viewport" | "page",
): Promise<PointProbe | null> {
  const res = await runContentAction(tabId, { action: "probeAt", x, y, space });
  if (!res.ok || !res.data) return null;
  return res.data as PointProbe;
}

/**
 * The policy probe for a coordinate call: what a click at these coordinates
 * would act on. Used by the service worker's gate exactly like `probeElement`.
 */
export async function probeElementAt(
  tabId: number,
  args: Record<string, unknown>,
): Promise<ElementProbe | null> {
  const x = typeof args.x === "number" ? args.x : undefined;
  const y = typeof args.y === "number" ? args.y : undefined;
  if (x === undefined || y === undefined) return null;
  const space = args.space === "page" ? "page" : "viewport";
  const probed = await probePoint(tabId, x, y, space).catch(() => null);
  const hit = probed?.hit;
  if (!hit) return null;
  return {
    tag: hit.tag,
    type: hit.type,
    role: hit.role,
    text: hit.text,
    inForm: hit.inForm,
  };
}

/** The `buttons` bitfield CDP wants (left=1, right=2, middle=4). */
function buttonMask(button: string | undefined): number {
  return button === "right" ? 2 : button === "middle" ? 4 : button === "left" ? 1 : 0;
}

function strokeParams(step: StrokeStep, pressed: string | null): Record<string, unknown> {
  if (step.type === "mouseMoved") {
    return {
      type: step.type,
      x: step.x,
      y: step.y,
      button: "none",
      buttons: buttonMask(pressed ?? undefined),
    };
  }
  return {
    type: step.type,
    x: step.x,
    y: step.y,
    button: step.button ?? "left",
    buttons: step.type === "mousePressed" ? buttonMask(step.button ?? "left") : 0,
    clickCount: step.clickCount ?? 1,
  };
}

async function sendStrokes(
  ctx: ToolContext,
  steps: StrokeStep[],
): Promise<void> {
  await ensureTabActive(ctx.tabId, ctx.adapter);
  let pressed: string | null = null;
  for (const step of steps) {
    try {
      await ctx.adapter.send(ctx.tabId, "Input.dispatchMouseEvent", strokeParams(step, pressed));
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      throw new Error(
        trustedInputFailure(
          `could not deliver the mouse stroke at (${step.x}, ${step.y}): ${detail}`,
          "the browser rejected Input.dispatchMouseEvent — check that the tab still exists (page_health), then retry once",
        ),
      );
    }
    if (step.type === "mousePressed") pressed = step.button ?? "left";
    if (step.type === "mouseReleased") pressed = null;
    await sleep(BETWEEN_STEPS_MS);
  }
}

type ResolveOutcome =
  | { ok: true; probed: PointProbe }
  | { ok: false; error: string };

/** Probe the point and bounds-check it against the live viewport. */
async function resolvePoint(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ResolveOutcome> {
  const shaped = shapeCoordArgs(args);
  if (!shaped.ok) return { ok: false, error: shaped.error };
  const probed = await probePoint(ctx.tabId, shaped.from.x, shaped.from.y, shaped.space);
  if (!probed) {
    return {
      ok: false,
      error: `${failureTag("injection")}: could not read the page at (${shaped.from.x}, ${shaped.from.y}) — the content script is not running there (page_health reports which layer is down)`,
    };
  }
  const outOfBounds = boundsError(probed.point, probed.viewport);
  if (outOfBounds) return { ok: false, error: `${failureTag("input")}: ${outOfBounds}` };
  return { ok: true, probed };
}

const POINT_PROPS = {
  x: { type: "number", description: "X in CSS px (see `space`)" },
  y: { type: "number", description: "Y in CSS px (see `space`)" },
  ...COORD_SPACE_PROP,
};

registerTool({
  name: "click_at",
  description:
    "Click at screen coordinates instead of an element ref. Use ONLY when the target is drawn into a <canvas> or otherwise has no ref in the snapshot (canvas editors, maps, drawing boards, sliders) — a ref-based `click` is always safer. Coordinates are CSS px from the visible viewport's top-left, i.e. exactly the frame a screenshot shows; pass space:'page' for document coordinates. Clicking a document surface first is how you place the caret in a canvas editor: click_at at the target position, then `type` into the editor's sink ref. The point is probed before clicking and the same safety rules apply as for `click`.",
  parameters: {
    type: "object",
    properties: {
      ...POINT_PROPS,
      button: {
        type: "string",
        description: "left (default), right, or middle",
      },
      click_count: {
        type: "number",
        description: "1 (default), 2 = double-click, 3 = triple-click",
      },
    },
    required: ["x", "y"],
  },
  async run(args, ctx) {
    const resolved = await resolvePoint(ctx, args);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const shaped = shapeCoordArgs(args);
    if (!shaped.ok) return { ok: false, error: shaped.error };
    const { point, viewport, hit } = resolved.probed;
    await sendStrokes(ctx, planClick(point, shaped.button, shaped.clickCount));
    return {
      clicked: { x: point.x, y: point.y, button: shaped.button, clickCount: shaped.clickCount },
      hit: describeHit(hit),
      viewport: { width: viewport.width, height: viewport.height },
    };
  },
  present(payload) {
    const d = (payload ?? {}) as { clicked?: Point; hit?: string };
    return {
      text: `clicked (${d.clicked?.x}, ${d.clicked?.y}) — ${d.hit ?? ""}`,
    };
  },
});

registerTool({
  name: "hover_at",
  description:
    "Move the mouse to screen coordinates without clicking (tooltips, hover menus on canvas surfaces). Same coordinate space as click_at.",
  parameters: { type: "object", properties: POINT_PROPS, required: ["x", "y"] },
  async run(args, ctx) {
    const resolved = await resolvePoint(ctx, args);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { point, hit } = resolved.probed;
    await sendStrokes(ctx, planHover(point));
    return { movedTo: point, hit: describeHit(hit) };
  },
});

registerTool({
  name: "drag_at",
  description:
    "Press at (x,y), drag to (to_x,to_y) along an interpolated path, and release — for canvas editors' selections and carets, sliders, drawing tools and drag-and-drop surfaces. Same coordinate space as click_at.",
  parameters: {
    type: "object",
    properties: {
      ...POINT_PROPS,
      to_x: { type: "number", description: "End X in CSS px" },
      to_y: { type: "number", description: "End Y in CSS px" },
    },
    required: ["x", "y", "to_x", "to_y"],
  },
  async run(args, ctx) {
    const shaped = shapeCoordArgs(args);
    if (!shaped.ok) return { ok: false, error: shaped.error };
    const to = shaped.to;
    if (!to) {
      return { ok: false, error: `${failureTag("input")}: drag_at needs to_x and to_y` };
    }
    const resolved = await resolvePoint(ctx, args);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { point, viewport, hit } = resolved.probed;
    // End point too: a drag that releases outside the viewport is a miss, not
    // a mysterious half-drag.
    const outOfBounds = boundsError(to, viewport);
    if (outOfBounds) return { ok: false, error: `${failureTag("input")}: ${outOfBounds}` };
    await sendStrokes(ctx, planDrag(point, to));
    return { dragged: { from: point, to }, hit: describeHit(hit) };
  },
});

registerTool({
  name: "element_at",
  description:
    "Read what is under a screen coordinate without clicking: the element (or canvas/iframe) at that point, its snapshot ref when it has one, and the viewport size. Use to plan click_at on an unfamiliar canvas surface.",
  parameters: { type: "object", properties: POINT_PROPS, required: ["x", "y"] },
  async run(args, ctx) {
    const resolved = await resolvePoint(ctx, args);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { hit, viewport, point } = resolved.probed;
    return {
      at: point,
      hit,
      described: describeHit(hit),
      viewport: { width: viewport.width, height: viewport.height },
    };
  },
  present(payload) {
    const d = (payload ?? {}) as { described?: string; viewport?: { width: number; height: number } };
    return {
      text: `${d.described ?? "nothing"} (viewport ${d.viewport?.width}x${d.viewport?.height})`,
    };
  },
});
