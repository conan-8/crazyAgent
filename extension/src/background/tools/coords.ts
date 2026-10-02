// Coordinate tools — click / hover / drag at an x,y point, plus `element_at`
// to see what is under one. The pure half (arg shaping, coordinate conversion,
// stroke plans) is shared/coords.ts; this file is the CDP half.
//
// Why these exist: a canvas-drawn surface (Figma/Miro boards, maps, sliders,
// a canvas document editor's page body) has NO DOM element to hold a ref, so
// ref-based clicking cannot reach it. The strokes go through
// Input.dispatchMouseEvent — the browser's own input pipeline, so the page
// sees real `isTrusted: true` mouse events, exactly like the trusted typing in
// trusted-input.ts. Three measured properties shape the design:
//   - Coordinates are CSS pixels from the visible viewport's top-left, i.e.
//     exactly the frame `screenshot` captures; `space: "page"` accepts
//     document coordinates instead (what element boxes report).
//   - Input only reaches the ACTIVE tab's render widget (a background tab
//     accepts the command and does nothing), so the tab is activated first.
//   - A ref or a FRAME-LOCAL point is accepted too, and translated to
//     viewport coordinates through the frameElement chain (content/actions.ts
//     #resolvePoint). A real run burned 22 minutes hand-deriving a 50px iframe
//     offset in reasoning because nothing did that translation for it.
//
// Policy parity: before a stroke is sent, the point is probed with
// `document.elementFromPoint` (or the element itself, for ref mode) and the
// nearest interactive ancestor is handed to the same assess() a ref-based
// `click` gets — so clicking "Buy now" by coordinate raises the same
// confirmation card as clicking it by ref.
import {
  boundsError,
  describeHit,
  planClick,
  planDrag,
  planHover,
  shapeCoordArgs,
  shapeDragList,
  shapeModifiers,
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

/** What #resolvePoint returns for a resolved ref or frame-local point. */
interface ResolvedPoint {
  point: Point;
  localPoint: Point;
  frameOffset: Point;
  rect?: { x: number; y: number; w: number; h: number };
  hit: HitInfo | null;
  viewport: ViewportInfo;
}

type ResolveOutcome =
  | { ok: true; source: "ref" | "frame" | "coords"; from: Point; hit: HitInfo | null; viewport: ViewportInfo; resolved?: ResolvedPoint }
  | { ok: false; error: string };

/**
 * Resolve WHERE to act, in top-viewport coordinates, from any of the three
 * input modes: a snapshot `ref` (element centre + dx/dy), a `frame`-local
 * point, or raw viewport/page coordinates. `to` fields are resolved by
 * resolveEnd for drags.
 */
async function resolveTarget(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ResolveOutcome> {
  const dx = typeof args.dx === "number" ? args.dx : 0;
  const dy = typeof args.dy === "number" ? args.dy : 0;
  if (typeof args.ref === "string") {
    const res = await runContentAction(ctx.tabId, {
      action: "resolvePoint",
      ref: args.ref,
      dx,
      dy,
    });
    if (!res.ok || !res.data) {
      return {
        ok: false,
        error: `${failureTag("input")}: could not resolve ref '${args.ref}' — ${res.error ?? "the frame is not reachable"}`,
      };
    }
    const data = res.data as ResolvedPoint;
    return {
      ok: true,
      source: "ref",
      from: data.point,
      hit: data.hit,
      viewport: data.viewport,
      resolved: data,
    };
  }
  if (typeof args.frame === "number" && Number.isFinite(args.frame)) {
    if (typeof args.x !== "number" || typeof args.y !== "number") {
      return {
        ok: false,
        error: `${failureTag("input")}: frame mode needs frame-local x and y (the frame's own viewport coordinates, e.g. the element boxes an evaluate_js in that frame reports)`,
      };
    }
    const res = await runContentAction(
      ctx.tabId,
      {
        action: "resolvePoint",
        x: args.x,
        y: args.y,
        dx,
        dy,
      },
      args.frame,
    );
    if (!res.ok || !res.data) {
      return {
        ok: false,
        error: `${failureTag("injection")}: could not resolve the point in frame ${args.frame} — ${res.error ?? "the frame is not reachable (see the snapshot's Frames: list)"}`,
      };
    }
    const data = res.data as ResolvedPoint;
    return {
      ok: true,
      source: "frame",
      from: data.point,
      hit: data.hit,
      viewport: data.viewport,
      resolved: data,
    };
  }
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
  return { ok: true, source: "coords", from: probed.point, hit: probed.hit, viewport: probed.viewport };
}

/**
 * Resolve a drag's end point: `to_x/to_y` in the input's own space (raw or
 * frame-local), or `to_ref` (element centre), or `to_dx/to_dy` relative to
 * the resolved start (viewport space).
 */
async function resolveEnd(
  ctx: ToolContext,
  args: Record<string, unknown>,
  start: Point,
  startSource: "ref" | "frame" | "coords",
): Promise<{ ok: true; to: Point } | { ok: false; error: string }> {
  if (typeof args.to_ref === "string") {
    const res = await runContentAction(ctx.tabId, { action: "resolvePoint", ref: args.to_ref });
    if (!res.ok || !res.data) {
      return {
        ok: false,
        error: `${failureTag("input")}: could not resolve to_ref '${args.to_ref}' — ${res.error ?? "the frame is not reachable"}`,
      };
    }
    return { ok: true, to: (res.data as ResolvedPoint).point };
  }
  if (args.to_dx !== undefined || args.to_dy !== undefined) {
    const tdx = typeof args.to_dx === "number" ? args.to_dx : 0;
    const tdy = typeof args.to_dy === "number" ? args.to_dy : 0;
    return { ok: true, to: { x: start.x + tdx, y: start.y + tdy } };
  }
  if (args.to_x !== undefined || args.to_y !== undefined) {
    if (startSource === "frame" && typeof args.frame === "number") {
      if (typeof args.to_x !== "number" || typeof args.to_y !== "number") {
        return { ok: false, error: `${failureTag("input")}: frame mode needs both to_x and to_y in the frame's local coordinates` };
      }
      const res = await runContentAction(
        ctx.tabId,
        { action: "resolvePoint", x: args.to_x, y: args.to_y },
        args.frame,
      );
      if (!res.ok || !res.data) {
        return {
          ok: false,
          error: `${failureTag("injection")}: could not resolve the end point in frame ${args.frame} — ${res.error ?? "unreachable"}`,
        };
      }
      return { ok: true, to: (res.data as ResolvedPoint).point };
    }
    const shaped = shapeCoordArgs(args);
    if (!shaped.ok || !shaped.to) {
      return { ok: false, error: shaped.ok ? `${failureTag("input")}: drag_at needs to_x and to_y (or to_ref / to_dx+to_dy)` : shaped.error };
    }
    if (shaped.space === "page") {
      // Convert document-space ends through the page (it owns the scroll).
      const probed = await probePoint(ctx.tabId, shaped.to.x, shaped.to.y, "page");
      if (!probed) {
        return { ok: false, error: `${failureTag("injection")}: could not read the page at the end point — content script not running there` };
      }
      return { ok: true, to: probed.point };
    }
    return { ok: true, to: shaped.to };
  }
  return {
    ok: false,
    error: `${failureTag("input")}: drag_at needs an end point — to_x/to_y, to_ref, or to_dx/to_dy`,
  };
}

/**
 * The policy probe for a coordinate call: what a click at these coordinates
 * would act on. Used by the service worker's gate exactly like `probeElement`.
 * Understands all three input modes plus the batched drags list (probed at
 * its first start point — the list is one unit of work on one surface).
 */
export async function probeElementAt(
  tabId: number,
  args: Record<string, unknown>,
): Promise<ElementProbe | null> {
  const first = Array.isArray(args.drags)
    ? ((args.drags[0] ?? {}) as Record<string, unknown>)
    : {};
  const probeArgs: Record<string, unknown> = { ...args, ...first };
  if (typeof probeArgs.ref === "string") {
    const res = await runContentAction(tabId, {
      action: "resolvePoint",
      ref: probeArgs.ref,
    }).catch(() => null);
    const hit = res?.ok ? ((res.data as ResolvedPoint | null)?.hit ?? null) : null;
    return hit ? elementProbeOf(hit) : null;
  }
  const frame = typeof probeArgs.frame === "number" ? probeArgs.frame : undefined;
  if (frame !== undefined && typeof probeArgs.x === "number" && typeof probeArgs.y === "number") {
    const res = await runContentAction(
      tabId,
      { action: "resolvePoint", x: probeArgs.x, y: probeArgs.y },
      frame,
    ).catch(() => null);
    const hit = res?.ok ? ((res.data as ResolvedPoint | null)?.hit ?? null) : null;
    return hit ? elementProbeOf(hit) : null;
  }
  const x = typeof probeArgs.x === "number" ? probeArgs.x : undefined;
  const y = typeof probeArgs.y === "number" ? probeArgs.y : undefined;
  if (x === undefined || y === undefined) return null;
  const space = probeArgs.space === "page" ? "page" : "viewport";
  const probed = await probePoint(tabId, x, y, space).catch(() => null);
  const hit = probed?.hit;
  if (!hit) return null;
  return elementProbeOf(hit);
}

function elementProbeOf(hit: HitInfo): ElementProbe {
  return {
    tag: hit.tag,
    type: hit.type,
    role: hit.role,
    text: hit.text,
    inForm: hit.inForm,
  };
}

/** `buttons` bitfield CDP wants (left=1, right=2, middle=4). */
function buttonMask(button: string | undefined): number {
  return button === "right" ? 2 : button === "middle" ? 4 : button === "left" ? 1 : 0;
}

const POINT_PROPS = {
  x: { type: "number", description: "X in CSS px (see `space`; frame-local with `frame`)" },
  y: { type: "number", description: "Y in CSS px (see `space`; frame-local with `frame`)" },
  ...COORD_SPACE_PROP,
};

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

/**
 * Re-probe the point after the strokes: the hit BEFORE and AFTER in one
 * result lets the model verify its own action without a follow-up call.
 */
async function afterHit(ctx: ToolContext, point: Point): Promise<string | null> {
  const probed = await probePoint(ctx.tabId, point.x, point.y, "viewport").catch(() => null);
  return probed ? describeHit(probed.hit) : null;
}

const REF_PROP = {
  ref: {
    type: "string",
    description:
      "Snapshot ref of the element to act on (its centre, plus dx/dy) — the tool translates it to viewport coordinates, including through iframes. Preferred over raw coordinates whenever a ref exists.",
  },
};

const FRAME_PROP = {
  frame: {
    type: "number",
    description:
      "Frame id from the snapshot's Frames: list — x/y (and to_x/to_y) are then interpreted in THAT frame's own viewport coordinates and translated for you",
  },
};

registerTool({
  name: "click_at",
  description:
    "Click at screen coordinates instead of an element ref. Use ONLY when the target is drawn into a <canvas> or otherwise has no ref in the snapshot (canvas editors, maps, drawing boards, sliders) — a ref-based `click` is always safer. Accepts: x/y (CSS px from the visible viewport's top-left, exactly the screenshot's frame; space:'page' for document coordinates), OR ref + dx/dy (element centre, translated through iframes), OR frame + frame-local x/y. The result reports what the point hit before AND after the click. The point is probed before clicking and the same safety rules apply as for `click`.",
  parameters: {
    type: "object",
    properties: {
      ...POINT_PROPS,
      ...REF_PROP,
      ...FRAME_PROP,
      dx: { type: "number", description: "Offset from the ref's centre (viewport CSS px)" },
      dy: { type: "number", description: "Offset from the ref's centre (viewport CSS px)" },
      button: {
        type: "string",
        description: "left (default), right, or middle",
      },
      click_count: {
        type: "number",
        description: "1 (default), 2 = double-click, 3 = triple-click",
      },
    },
  },
  async run(args, ctx) {
    const resolved = await resolveTarget(ctx, args);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const mods = shapeModifiers(args);
    if (!mods.ok) return { ok: false, error: mods.error };
    const { from, hit, viewport, source } = resolved;
    await sendStrokes(ctx, planClick(from, mods.button, mods.clickCount));
    const after = await afterHit(ctx, from);
    return {
      clicked: { x: from.x, y: from.y, button: mods.button, clickCount: mods.clickCount },
      hit: describeHit(hit),
      after,
      source,
      viewport: { width: viewport.width, height: viewport.height },
    };
  },
  present(payload) {
    const d = (payload ?? {}) as {
      clicked?: Point;
      hit?: string;
      after?: string | null;
    };
    const change = d.after && d.after !== d.hit ? ` → now: ${d.after}` : "";
    return {
      text: `clicked (${d.clicked?.x}, ${d.clicked?.y}) — ${d.hit ?? ""}${change}`,
    };
  },
});

registerTool({
  name: "hover_at",
  description:
    "Move the mouse to screen coordinates without clicking (tooltips, hover menus on canvas surfaces). Same coordinate modes as click_at (x/y, ref+dx/dy, or frame-local).",
  parameters: {
    type: "object",
    properties: { ...POINT_PROPS, ...REF_PROP, ...FRAME_PROP, dx: { type: "number" }, dy: { type: "number" } },
  },
  async run(args, ctx) {
    const resolved = await resolveTarget(ctx, args);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { from, hit } = resolved;
    await sendStrokes(ctx, planHover(from));
    return { movedTo: from, hit: describeHit(hit) };
  },
});

registerTool({
  name: "drag_at",
  description:
    "Press at a point, drag to another, and release — for canvas editors' selections and carets, sliders, drawing tools, drag-and-drop surfaces and GRAPH PLOTTING. Same coordinate modes as click_at: x/y→to_x/to_y, or ref→to_ref (element centres, translated through iframes), or ref + to_dx/to_dy (relative), or frame + frame-local coords. For MANY drags on one surface (plotting points on a graph), pass a `drags` LIST (up to 32) — calibrate once, send them all in ONE call; the result reports each drag's from/to and what it hit. Strokes stop at the first failure and report what completed.",
  parameters: {
    type: "object",
    properties: {
      ...POINT_PROPS,
      ...REF_PROP,
      ...FRAME_PROP,
      dx: { type: "number", description: "Offset from the ref's centre (start point)" },
      dy: { type: "number", description: "Offset from the ref's centre (start point)" },
      to_x: { type: "number", description: "End X (same space as x; frame-local in frame mode)" },
      to_y: { type: "number", description: "End Y (same space as y; frame-local in frame mode)" },
      to_ref: { type: "string", description: "Snapshot ref of the end point (its centre)" },
      to_dx: { type: "number", description: "End offset relative to the start point (viewport CSS px)" },
      to_dy: { type: "number", description: "End offset relative to the start point (viewport CSS px)" },
      drags: {
        type: "array",
        description:
          "Batched form: [{x,y,to_x,to_y} | {ref,to_ref} | {ref,to_dx,to_dy}, …] up to 32 entries — one call, one observation",
        items: { type: "object" },
      },
    },
  },
  async run(args, ctx) {
    // ---- batched form -------------------------------------------------
    if (args.drags !== undefined) {
      const list = shapeDragList(args);
      if (!list.ok) return { ok: false, error: list.error };
      const frame = typeof args.frame === "number" ? args.frame : undefined;
      type Item = { from: Point; to: Point; hit: string };
      const items: Item[] = [];
      const rawList = args.drags as Record<string, unknown>[];
      for (const [i, raw] of rawList.entries()) {
        // Resolve this item's start and end through the same three modes.
        const startRes = await resolveTarget(ctx, { ...raw, frame });
        if (!startRes.ok) {
          return { ok: false, error: `drags[${i}]: ${startRes.error}`, completed: items };
        }
        const endRes = await resolveEnd(ctx, raw, startRes.from, startRes.source);
        if (!endRes.ok) {
          return { ok: false, error: `drags[${i}]: ${endRes.error}`, completed: items };
        }
        const outOfBounds = boundsError(endRes.to, startRes.viewport);
        if (outOfBounds) {
          return { ok: false, error: `drags[${i}]: ${failureTag("input")}: ${outOfBounds}`, completed: items };
        }
        items.push({ from: startRes.from, to: endRes.to, hit: describeHit(startRes.hit) });
      }
      // All points resolved and bounds-checked before ANY stroke is sent.
      const results: { from: Point; to: Point; hit: string; after: string | null }[] = [];
      for (const item of items) {
        try {
          await sendStrokes(ctx, planDrag(item.from, item.to));
        } catch (err) {
          return {
            ok: false,
            error: String((err as Error)?.message ?? err),
            completed: results,
            stoppedAt: results.length,
          };
        }
        results.push({ ...item, after: await afterHit(ctx, item.to) });
      }
      return { drags: results, sent: results.length };
    }

    // ---- single form --------------------------------------------------
    const resolved = await resolveTarget(ctx, args);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const endRes = await resolveEnd(ctx, args, resolved.from, resolved.source);
    if (!endRes.ok) return { ok: false, error: endRes.error };
    const to = endRes.to;
    const outOfBounds = boundsError(to, resolved.viewport);
    if (outOfBounds) return { ok: false, error: `${failureTag("input")}: ${outOfBounds}` };
    await sendStrokes(ctx, planDrag(resolved.from, to));
    const after = await afterHit(ctx, to);
    return {
      dragged: { from: resolved.from, to },
      hit: describeHit(resolved.hit),
      after,
      source: resolved.source,
    };
  },
  present(payload) {
    const p = (payload ?? {}) as {
      dragged?: { from: Point; to: Point };
      hit?: string;
      after?: string | null;
      drags?: { from: Point; to: Point; hit: string; after: string | null }[];
      sent?: number;
      completed?: unknown[];
    };
    if (p.drags?.length) {
      const lines = p.drags.map(
        (d, i) =>
          `${i + 1}. (${d.from.x},${d.from.y}) → (${d.to.x},${d.to.y}) — ${d.hit}${d.after && d.after !== d.hit ? ` → now: ${d.after}` : ""}`,
      );
      return { text: `${p.sent ?? p.drags.length} drags sent:\n${lines.join("\n")}` };
    }
    const d = p.dragged;
    const change = p.after && p.after !== p.hit ? ` → now: ${p.after}` : "";
    return {
      text: d ? `dragged (${d.from.x},${d.from.y}) → (${d.to.x},${d.to.y}) — ${p.hit ?? ""}${change}` : "no drag",
    };
  },
});

registerTool({
  name: "element_at",
  description:
    "Read what is under a screen coordinate without clicking: the element (or canvas/iframe) at that point, its snapshot ref when it has one, and the viewport size. Same coordinate modes as click_at (x/y, ref+dx/dy, frame-local). Use to plan click_at on an unfamiliar canvas surface.",
  parameters: {
    type: "object",
    properties: { ...POINT_PROPS, ...REF_PROP, ...FRAME_PROP, dx: { type: "number" }, dy: { type: "number" } },
  },
  async run(args, ctx) {
    const resolved = await resolveTarget(ctx, args);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { from, hit, viewport, source, resolved: res } = resolved;
    return {
      at: from,
      hit,
      described: describeHit(hit),
      source,
      ...(res?.rect ? { targetRect: res.rect } : {}),
      ...(res ? { localPoint: res.localPoint, frameOffset: res.frameOffset } : {}),
      viewport: { width: viewport.width, height: viewport.height },
    };
  },
  present(payload) {
    const d = (payload ?? {}) as {
      described?: string;
      viewport?: { width: number; height: number };
      localPoint?: Point;
    };
    const local = d.localPoint ? ` (frame-local ${d.localPoint.x},${d.localPoint.y})` : "";
    return {
      text: `${d.described ?? "nothing"} (viewport ${d.viewport?.width}x${d.viewport?.height})${local}`,
    };
  },
});
