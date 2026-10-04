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
  screenshotToViewportPoint,
  shapeCoordArgs,
  shapeDragList,
  shapeModifiers,
  shapeSequenceSteps,
  COORD_SPACE_PROP,
  type HitInfo,
  type Point,
  type StrokeStep,
  type ViewportInfo,
} from "../../shared/coords";
import { failureTag } from "../../shared/tool-failure";
import { trustedInputFailure, keyEventParams, parseKeyCombo, planTyping } from "../../shared/trusted-input";
import type { ElementProbe } from "../policy";
import { runContentAction } from "./content-action";
import { cursorPing } from "./cursor-overlay";
import { layoutViewportCss, viewportShotInfo, viewportShotMapping } from "./perception";
import { ensureTabActive, resolveNoRefFocus } from "./trusted-input";
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
  | { ok: true; source: "ref" | "frame" | "coords"; from: Point; hit: HitInfo | null; viewport: ViewportInfo | null; probed: boolean; resolved?: ResolvedPoint }
  | { ok: false; error: string };

/** Distinguishes an ACTING resolve (click/drag/hover — allowed to scroll a
 *  ref into view) from a LOOKING one (element_at, the policy probe — no
 *  page-state changes). */
interface ResolveOpts {
  scrollRef?: boolean;
}

/**
 * Convert a `space:"screenshot"` point to viewport CSS pixels using the
 * LATEST capture's mapping — full shots (viewport rect 0,0) and zoom/region
 * crops (their own absolute rect) alike. No content script needed.
 */
async function fromScreenshotSpace(
  ctx: ToolContext,
  point: Point,
): Promise<{ ok: true; point: Point } | { ok: false; error: string }> {
  if (!viewportShotInfo(ctx.tabId)) {
    return {
      ok: false,
      error: `${failureTag("input")}: space:'screenshot' needs a screenshot of THIS tab first (none captured this session) — take one with \`screenshot\` (zoom:2-4 when precision matters), then point at the image`,
    };
  }
  const mapping = await viewportShotMapping(ctx.tabId, ctx.adapter);
  if (!mapping) {
    return {
      ok: false,
      error: `${failureTag("input")}: could not determine the viewport's CSS size to convert screenshot pixels — retake the screenshot, or use space:'viewport'`,
    };
  }
  return { ok: true, point: screenshotToViewportPoint(point, mapping) };
}

/**
 * Resolve WHERE to act, in top-viewport coordinates, from any of the four
 * input modes: a snapshot `ref` (element centre + dx/dy, optionally scrolled
 * into view first), a `frame`-local point, screenshot-image pixels, or raw
 * viewport/page coordinates. `to` fields are resolved by resolveEnd for drags.
 *
 * The content-script probe is BEST-EFFORT: it feeds the hit report and the
 * bounds check, but the stroke itself (CDP Input) does not need it. A page
 * the registry never reached still gets clicked — the result just says what
 * could not be verified instead of refusing the action.
 */
async function resolveTarget(
  ctx: ToolContext,
  args: Record<string, unknown>,
  opts: ResolveOpts = {},
): Promise<ResolveOutcome> {
  const dx = typeof args.dx === "number" ? args.dx : 0;
  const dy = typeof args.dy === "number" ? args.dy : 0;
  if (typeof args.ref === "string") {
    const res = await runContentAction(ctx.tabId, {
      action: "resolvePoint",
      ref: args.ref,
      dx,
      dy,
      ...(opts.scrollRef ? { scroll: true } : {}),
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
      probed: true,
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
      probed: true,
      resolved: data,
    };
  }
  const shaped = shapeCoordArgs(args);
  if (!shaped.ok) return { ok: false, error: shaped.error };
  let from = shaped.from;
  if (shaped.space === "screenshot") {
    const converted = await fromScreenshotSpace(ctx, from);
    if (!converted.ok) return { ok: false, error: converted.error };
    from = converted.point;
  }
  const probed = await probePoint(ctx.tabId, from.x, from.y, "viewport");
  if (!probed) {
    // No content script at the point — the stroke still works. Bounds-check
    // against CDP layout metrics when available; the hit is just "unknown".
    const viewport = await layoutViewportCss(ctx.tabId, ctx.adapter).catch(() => undefined);
    if (viewport) {
      const outOfBounds = boundsError(from, viewport);
      if (outOfBounds) return { ok: false, error: `${failureTag("input")}: ${outOfBounds}` };
    }
    return { ok: true, source: "coords", from, hit: null, viewport: viewport ?? null, probed: false };
  }
  const outOfBounds = boundsError(probed.point, probed.viewport);
  if (outOfBounds) return { ok: false, error: `${failureTag("input")}: ${outOfBounds}` };
  return { ok: true, source: "coords", from: probed.point, hit: probed.hit, viewport: probed.viewport, probed: true };
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
    if (shaped.space === "screenshot") {
      const converted = await fromScreenshotSpace(ctx, shaped.to);
      if (!converted.ok) return { ok: false, error: converted.error };
      return { ok: true, to: converted.point };
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
  // A drags list is probed at its first start point; an input_sequence at
  // its first CLICK step (clicks carry the risk, waits/keys do not).
  const seqClick = Array.isArray(args.steps)
    ? (args.steps.find(
        (s) =>
          typeof s === "object" && s !== null && typeof (s as Record<string, unknown>).click === "object",
      ) as Record<string, unknown> | undefined)
    : undefined;
  const first = Array.isArray(args.drags)
    ? ((args.drags[0] ?? {}) as Record<string, unknown>)
    : seqClick
      ? ((seqClick.click as Record<string, unknown>) ?? {})
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
  if (probeArgs.space === "screenshot") {
    // The policy probe has no adapter context: convert with the stored
    // capture mapping (crops carry their own absolute rect), or skip the
    // probe entirely (the gate tolerates null).
    const shot = viewportShotInfo(tabId);
    if (!shot) return null;
    const mapping = shot.crop
      ? {
          imageW: shot.imageW,
          imageH: shot.imageH,
          rectX: shot.crop.x,
          rectY: shot.crop.y,
          rectW: shot.crop.w,
          rectH: shot.crop.h,
        }
      : typeof shot.viewportCssW === "number" && typeof shot.viewportCssH === "number"
        ? {
            imageW: shot.imageW,
            imageH: shot.imageH,
            rectX: 0,
            rectY: 0,
            rectW: shot.viewportCssW,
            rectH: shot.viewportCssH,
          }
        : null;
    if (!mapping) return null;
    const p = screenshotToViewportPoint({ x, y }, mapping);
    const probedShot = await probePoint(tabId, p.x, p.y, "viewport").catch(() => null);
    const shotHit = probedShot?.hit;
    if (!shotHit) return null;
    return elementProbeOf(shotHit);
  }
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

/** CDP modifier bitfield values (Alt=1, Ctrl=2, Meta=4). */
const SHIFT_MODIFIER = 8;

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
      ...(step.modifiers ? { modifiers: step.modifiers } : {}),
    };
  }
  return {
    type: step.type,
    x: step.x,
    y: step.y,
    button: step.button ?? "left",
    buttons: step.type === "mousePressed" ? buttonMask(step.button ?? "left") : 0,
    clickCount: step.clickCount ?? 1,
    ...(step.modifiers ? { modifiers: step.modifiers } : {}),
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
    // The visible cursor rides the same points the strokes hit. Fire-and-
    // forget: decoration never adds latency or failure modes to input.
    cursorPing(
      ctx.tabId,
      ctx.adapter,
      step.x,
      step.y,
      step.type === "mousePressed" ? "press" : step.type === "mouseReleased" ? "release" : "move",
    );
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
    "Click at screen coordinates instead of an element ref. Use ONLY when the target is drawn into a <canvas> or otherwise has no ref in the snapshot (canvas editors, maps, drawing boards, sliders) — a ref-based `click` is always safer. Accepts: x/y (CSS px from the visible viewport's top-left; space:'page' for document coordinates; space:'screenshot' for pixels of the latest screenshot image — point at exactly what you see and the tool converts), OR ref + dx/dy (element centre, scrolled into view first and translated through iframes), OR frame + frame-local x/y. The point is probed before clicking (best-effort: the click still lands when the probe cannot run, the result just says so) and the result reports what the point hit before AND after the click. The same safety rules apply as for `click`.",
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
    const resolved = await resolveTarget(ctx, args, { scrollRef: true });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const mods = shapeModifiers(args);
    if (!mods.ok) return { ok: false, error: mods.error };
    const { from, hit, viewport, source, probed } = resolved;
    await sendStrokes(ctx, planClick(from, mods.button, mods.clickCount));
    const after = probed ? await afterHit(ctx, from) : null;
    return {
      clicked: { x: from.x, y: from.y, button: mods.button, clickCount: mods.clickCount },
      hit: probed ? describeHit(hit) : "unknown (no content script at that point — the click still landed; verify the effect)",
      after,
      source,
      viewport: viewport ? { width: viewport.width, height: viewport.height } : undefined,
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
  name: "type_at",
  description:
    "Click a point to place the caret (or make a selection), then type — ONE call, the primary move on canvas editors (Google Docs/Slides, Figma, any drawn surface): LOOK (screenshot — zoom:2..4 when the target is a text line), then type_at where the caret should go. Coordinate modes like click_at: x/y with space:'screenshot' (image px of the latest capture, full or crop), 'viewport' CSS px, or 'page', or ref+dx/dy, or frame-local. click_count:2 double-clicks (selects the word), 3 triple-clicks (selects the paragraph). select_to:{x,y} (same space) clicks the start then shift-clicks the end — one visual selection in the same call. select:'all' sends Ctrl+A first (atomic replace). keys_after:['Control+b',…] applies shortcut(s) after the text lands. Click, selection and typing run in ONE trusted sequence — focus cannot shift between them (the two-call version is how a run duplicated its document).",
  parameters: {
    type: "object",
    properties: {
      ...POINT_PROPS,
      ...REF_PROP,
      ...FRAME_PROP,
      dx: { type: "number", description: "Offset from the ref's centre (viewport CSS px)" },
      dy: { type: "number", description: "Offset from the ref's centre (viewport CSS px)" },
      click_count: {
        type: "number",
        description: "1 (default) places the caret; 2 selects the word; 3 selects the paragraph",
      },
      select_to: {
        type: "object",
        description:
          "Selection end {x, y} in the SAME space as x/y: click the start, shift-click the end",
        properties: { x: { type: "number" }, y: { type: "number" } },
      },
      select: {
        type: "string",
        description: "'all' = Ctrl+A immediately before the text (atomic replace)",
        enum: ["all"],
      },
      text: {
        type: "string",
        description: "Text to insert at the caret/selection (newlines become paragraph breaks)",
      },
      keys_after: {
        type: "array",
        description: "Shortcut(s) applied after the text lands, e.g. ['Control+b']",
        items: { type: "string" },
      },
    },
    required: ["text"],
  },
  async run(args, ctx) {
    const mods = shapeModifiers(args);
    if (!mods.ok) return { ok: false, error: mods.error };
    const resolved = await resolveTarget(ctx, args, { scrollRef: true });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const from = resolved.from;
    // Optional selection end, resolved in the same coordinate space.
    let selectTo: Point | undefined;
    const st = args.select_to as { x?: unknown; y?: unknown } | undefined;
    if (st && typeof st === "object") {
      if (typeof args.ref === "string" || typeof args.frame === "number") {
        return {
          ok: false,
          error: `${failureTag("input")}: select_to belongs to coordinate mode (x/y + space) — ref/frame modes already target an element`,
        };
      }
      if (typeof st.x !== "number" || typeof st.y !== "number") {
        return {
          ok: false,
          error: `${failureTag("input")}: select_to needs numeric x and y in the same space as x/y`,
        };
      }
      const end = await resolveTarget(ctx, { x: st.x, y: st.y, space: args.space });
      if (!end.ok) return { ok: false, error: `select_to: ${end.error}` };
      selectTo = end.from;
    }
    const adapter = ctx.adapter;
    try {
      // ONE trusted sequence: click (×count) → optional shift-click →
      // verified focus → optional Ctrl+A → text → keys_after. The glowing
      // cursor rides every stroke via sendStrokes.
      await sendStrokes(ctx, planClick(from, mods.button, mods.clickCount));
      if (selectTo) {
        await sleep(60);
        await sendStrokes(ctx, planClick(selectTo, mods.button, 1, SHIFT_MODIFIER));
      }
      // Verify the click actually focused something typable — BEFORE typing.
      const where = await resolveNoRefFocus(ctx.tabId, adapter);
      if (where === "none") {
        return {
          ok: false,
          error: trustedInputFailure(
            `clicked (${from.x}, ${from.y}) but nothing editable took focus — nothing was typed`,
            "look at the screenshot: click on the editor's document surface (or a real input), not its toolbar or the page chrome, then retry",
          ),
        };
      }
      // A beat: editors register the click/selection asynchronously.
      await sleep(80);
      let inserted = 0;
      let keysSent = 0;
      const sendCombo = async (combo: string) => {
        const parsed = parseKeyCombo(combo);
        if (!parsed.ok) throw new Error(parsed.error);
        await adapter.send(
          ctx.tabId,
          "Input.dispatchKeyEvent",
          keyEventParams(parsed.parsed, "down"),
        );
        await adapter.send(
          ctx.tabId,
          "Input.dispatchKeyEvent",
          keyEventParams(parsed.parsed, "up"),
        );
        keysSent += 1;
        await sleep(BETWEEN_STEPS_MS);
      };
      if (args.select === "all") await sendCombo("Control+a");
      for (const step of planTyping(String(args.text ?? ""))) {
        if (step.kind === "insertText") {
          await adapter.send(ctx.tabId, "Input.insertText", { text: step.text });
          inserted += step.text.length;
        } else {
          await sendCombo(step.key);
        }
      }
      const keysAfter = Array.isArray(args.keys_after)
        ? (args.keys_after as unknown[]).map(String)
        : [];
      for (const combo of keysAfter) await sendCombo(combo);
      const after = resolved.probed ? await afterHit(ctx, from) : null;
      return {
        typed: {
          at: from,
          ...(selectTo ? { selectedTo: selectTo } : {}),
          chars: inserted,
          keys: keysSent,
        },
        focus: where,
        hit: resolved.probed
          ? describeHit(resolved.hit)
          : "unknown (no content script at that point)",
        after,
      };
    } catch (err) {
      return {
        ok: false,
        error: trustedInputFailure(
          String((err as Error)?.message ?? err),
          "the browser rejected part of the click→type sequence — check page_health, then retry once",
        ),
      };
    }
  },
  present(payload) {
    const d = (payload ?? {}) as {
      typed?: { at: Point; selectedTo?: Point; chars: number; keys: number };
      focus?: string;
      hit?: string;
    };
    const t = d.typed;
    if (!t) return { text: "nothing typed" };
    const sel = t.selectedTo ? ` → selected to (${t.selectedTo.x},${t.selectedTo.y})` : "";
    const keys = t.keys ? ` · ${t.keys} key(s)` : "";
    return {
      text: `typed ${t.chars} char(s) at (${t.at.x},${t.at.y})${sel}${keys} — ${d.hit ?? ""} (focus: ${d.focus ?? "?"})`,
    };
  },
});

registerTool({
  name: "input_sequence",
  description:
    "Chain mouse/keyboard steps into ONE call — the menu-path and fill primitive: [{click:{x,y,space}}, {hover:{x,y}}, {wait_ms:300}, {type:{text, select?}}, {key:'Return'}]. Each click/hover takes click_at's full arg shape (x/y with space:'screenshot'|'viewport'|'page', or ref+dx/dy, or frame-local) resolved AT EXECUTION TIME; key takes any combo ('Control+a'); type inserts at the focused target (optionally select:'all' first); wait_ms lets menus/animations open. Up to 24 steps. Execution stops at the first failure and reports the completed steps, so the next call can resume from there. The glowing cursor rides every click — one screenshot afterwards shows the end state.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description:
          "Ordered steps: {click:{...click_at args}} | {hover:{...}} | {key:'combo'} | {type:'text'} | {type:{text, select:'all'}} | {wait_ms:250}",
        items: { type: "object" },
      },
    },
    required: ["steps"],
  },
  async run(args, ctx) {
    const shaped = shapeSequenceSteps(args);
    if (!shaped.ok) return { ok: false, error: shaped.error };
    await ensureTabActive(ctx.tabId, ctx.adapter);
    const done: { i: number; what: string }[] = [];
    let focusChecked = false;
    let lastClickPoint: Point | null = null;
    let lastProbed = false;
    const sendCombo = async (combo: string) => {
      const parsed = parseKeyCombo(combo);
      if (!parsed.ok) throw new Error(parsed.error);
      await ctx.adapter.send(
        ctx.tabId,
        "Input.dispatchKeyEvent",
        keyEventParams(parsed.parsed, "down"),
      );
      await ctx.adapter.send(
        ctx.tabId,
        "Input.dispatchKeyEvent",
        keyEventParams(parsed.parsed, "up"),
      );
      await sleep(BETWEEN_STEPS_MS);
    };
    for (const [i, step] of shaped.steps.entries()) {
      try {
        if (step.kind === "wait") {
          await sleep(step.waitMs ?? 0);
          done.push({ i, what: `waited ${step.waitMs}ms` });
          continue;
        }
        if (step.kind === "click" || step.kind === "hover") {
          const payload = step.point ?? {};
          const mods = shapeModifiers(payload);
          if (!mods.ok) {
            return { ok: false, error: `steps[${i}]: ${mods.error}`, completed: done, failedAt: i };
          }
          const resolved = await resolveTarget(ctx, payload, { scrollRef: true });
          if (!resolved.ok) {
            return { ok: false, error: `steps[${i}]: ${resolved.error}`, completed: done, failedAt: i };
          }
          await sendStrokes(
            ctx,
            step.kind === "click"
              ? planClick(resolved.from, mods.button, mods.clickCount)
              : planHover(resolved.from),
          );
          if (step.kind === "click") {
            lastClickPoint = resolved.from;
            lastProbed = resolved.probed;
          }
          done.push({
            i,
            what:
              step.kind === "hover"
                ? `hovered (${resolved.from.x},${resolved.from.y})`
                : `clicked (${resolved.from.x},${resolved.from.y}) — ${resolved.probed ? describeHit(resolved.hit) : "unknown hit"}`,
          });
          continue;
        }
        if (step.kind === "key") {
          await sendCombo(step.key!);
          done.push({ i, what: `key ${step.key}` });
          continue;
        }
        // type
        if (!focusChecked) {
          const where = await resolveNoRefFocus(ctx.tabId, ctx.adapter);
          if (where === "none") {
            return {
              ok: false,
              error: trustedInputFailure(
                `steps[${i}]: nothing editable is focused for the type step — nothing was typed`,
                "put a click step before the type step (the click establishes focus), then retry from there",
              ),
              completed: done,
              failedAt: i,
            };
          }
          focusChecked = true;
        }
        if (step.select === "all") await sendCombo("Control+a");
        for (const s of planTyping(step.text ?? "")) {
          if (s.kind === "insertText") {
            await ctx.adapter.send(ctx.tabId, "Input.insertText", { text: s.text });
          } else {
            await sendCombo(s.key);
          }
        }
        done.push({ i, what: `typed ${step.text?.length ?? 0} char(s)${step.select === "all" ? " (select-all first)" : ""}` });
      } catch (err) {
        return {
          ok: false,
          error: trustedInputFailure(
            `steps[${i}] (${step.kind}) failed: ${String((err as Error)?.message ?? err)}`,
            "check page_health, then resume from the failed step — the completed steps are listed",
          ),
          completed: done,
          failedAt: i,
        };
      }
    }
    const after = lastClickPoint && lastProbed ? await afterHit(ctx, lastClickPoint) : null;
    return { sent: done.length, steps: done, ...(after ? { after } : {}) };
  },
  present(payload) {
    const p = (payload ?? {}) as {
      sent?: number;
      steps?: { i: number; what: string }[];
      after?: string | null;
    };
    const lines = (p.steps ?? []).map((s) => `${s.i + 1}. ${s.what}`);
    const tail = p.after ? `\nafter: ${p.after}` : "";
    return {
      text: `${p.sent ?? 0} step(s) executed:\n${lines.join("\n")}${tail}`,
    };
  },
});

registerTool({
  name: "hover_at",
  description:
    "Move the mouse to screen coordinates without clicking (tooltips, hover menus on canvas surfaces). Same coordinate modes as click_at (x/y, space:'screenshot' for image pixels, ref+dx/dy, or frame-local).",
  parameters: {
    type: "object",
    properties: { ...POINT_PROPS, ...REF_PROP, ...FRAME_PROP, dx: { type: "number" }, dy: { type: "number" } },
  },
  async run(args, ctx) {
    const resolved = await resolveTarget(ctx, args, { scrollRef: true });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { from, hit, probed } = resolved;
    await sendStrokes(ctx, planHover(from));
    return { movedTo: from, hit: probed ? describeHit(hit) : "unknown (no content script at that point)" };
  },
});

registerTool({
  name: "drag_at",
  description:
    "Press at a point, drag to another, and release — for canvas editors' selections and carets, sliders, drawing tools, drag-and-drop surfaces and GRAPH PLOTTING. Same coordinate modes as click_at: x/y→to_x/to_y (space:'screenshot' points at the latest screenshot image), or ref→to_ref (element centres, scrolled into view and translated through iframes), or ref + to_dx/to_dy (relative), or frame + frame-local coords. For MANY drags on one surface (plotting points on a graph), pass a `drags` LIST (up to 32) — calibrate once, send them all in ONE call; the result reports each drag's from/to and what it hit. Strokes stop at the first failure and report what completed.",
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
      type Item = { from: Point; to: Point; hit: string; probed: boolean };
      const items: Item[] = [];
      const rawList = args.drags as Record<string, unknown>[];
      for (const [i, raw] of rawList.entries()) {
        // Resolve this item's start and end through the same three modes.
        const startRes = await resolveTarget(ctx, { ...raw, frame }, { scrollRef: true });
        if (!startRes.ok) {
          return { ok: false, error: `drags[${i}]: ${startRes.error}`, completed: items };
        }
        const endRes = await resolveEnd(ctx, raw, startRes.from, startRes.source);
        if (!endRes.ok) {
          return { ok: false, error: `drags[${i}]: ${endRes.error}`, completed: items };
        }
        const outOfBounds = startRes.viewport ? boundsError(endRes.to, startRes.viewport) : null;
        if (outOfBounds) {
          return { ok: false, error: `drags[${i}]: ${failureTag("input")}: ${outOfBounds}`, completed: items };
        }
        items.push({ from: startRes.from, to: endRes.to, hit: describeHit(startRes.hit), probed: startRes.probed });
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
        results.push({ ...item, after: item.probed ? await afterHit(ctx, item.to) : null });
      }
      return { drags: results, sent: results.length };
    }

    // ---- single form --------------------------------------------------
    const resolved = await resolveTarget(ctx, args, { scrollRef: true });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const endRes = await resolveEnd(ctx, args, resolved.from, resolved.source);
    if (!endRes.ok) return { ok: false, error: endRes.error };
    const to = endRes.to;
    const outOfBounds = resolved.viewport ? boundsError(to, resolved.viewport) : null;
    if (outOfBounds) return { ok: false, error: `${failureTag("input")}: ${outOfBounds}` };
    await sendStrokes(ctx, planDrag(resolved.from, to));
    const after = resolved.probed ? await afterHit(ctx, to) : null;
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
    const { from, hit, viewport, source, probed, resolved: res } = resolved;
    return {
      at: from,
      hit,
      described: probed ? describeHit(hit) : "unknown (no content script at that point)",
      source,
      ...(res?.rect ? { targetRect: res.rect } : {}),
      ...(res ? { localPoint: res.localPoint, frameOffset: res.frameOffset } : {}),
      ...(viewport ? { viewport: { width: viewport.width, height: viewport.height } } : {}),
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
