import { describe, expect, it } from "vitest";
import {
  boundsError,
  compensateShotScroll,
  countRefDrags,
  describeHit,
  looksLikeShotPixels,
  MAX_BATCH_DRAGS,
  MAX_SEQUENCE_STEPS,
  planClick,
  planDrag,
  planHover,
  rectDistance,
  screenshotToViewportPoint,
  shapeCoordArgs,
  shapeDragList,
  shapeModifiers,
  shapeSequenceSteps,
  snapOrPromote,
  toViewportPoint,
  type HitInfo,
  type SnapCandidate,
} from "../extension/src/shared/coords";

describe("shapeCoordArgs", () => {
  it("accepts a viewport-space point", () => {
    const out = shapeCoordArgs({ x: 10, y: 20 });
    expect(out).toMatchObject({ ok: true, space: "viewport", from: { x: 10, y: 20 } });
  });

  it("rejects non-numeric or non-finite coordinates with tool-error text", () => {
    for (const bad of [{}, { x: 1 }, { y: 1 }, { x: "5", y: 1 }, { x: NaN, y: 1 }]) {
      const out = shapeCoordArgs(bad);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.startsWith("ERROR:")).toBe(true);
    }
  });

  it("keeps drag endpoints and validates button/click_count", () => {
    const out = shapeCoordArgs({ x: 0, y: 0, to_x: 40, to_y: 40, button: "right", click_count: 2 });
    expect(out).toMatchObject({
      ok: true,
      to: { x: 40, y: 40 },
      button: "right",
      clickCount: 2,
    });
    expect(shapeCoordArgs({ x: 0, y: 0, button: "thumb" }).ok).toBe(false);
    expect(shapeCoordArgs({ x: 0, y: 0, click_count: 9 }).ok).toBe(false);
  });

  it("treats space:'page' as document coordinates", () => {
    const out = shapeCoordArgs({ x: 5, y: 5, space: "page" });
    expect(out.ok && out.space).toBe("page");
  });

  it("treats space:'screenshot' as image pixels (conversion happens at resolve time)", () => {
    const out = shapeCoordArgs({ x: 640, y: 360, space: "screenshot" });
    expect(out).toMatchObject({ ok: true, space: "screenshot", from: { x: 640, y: 360 } });
  });
});

describe("screenshot-space conversion", () => {
  it("scales image pixels to viewport CSS px (downscaled device-pixel capture)", () => {
    // A 1254×1028 CSS viewport captured at DPR 2 and downscaled to 1280 wide:
    // the model points at image pixels, the tool maps them back.
    const m = { imageW: 1280, imageH: 1049, rectX: 0, rectY: 0, rectW: 1254, rectH: 1028 };
    expect(screenshotToViewportPoint({ x: 640, y: 525 }, m)).toEqual({
      x: Math.round((640 * 1254) / 1280),
      y: Math.round((525 * 1028) / 1049),
    });
  });

  it("is identity when the image already matches the viewport", () => {
    const m = { imageW: 1000, imageH: 800, rectX: 0, rectY: 0, rectW: 1000, rectH: 800 };
    expect(screenshotToViewportPoint({ x: 123, y: 456 }, m)).toEqual({ x: 123, y: 456 });
  });

  it("maps the corners to the corners", () => {
    const m = { imageW: 1280, imageH: 720, rectX: 0, rectY: 0, rectW: 1920, rectH: 1080 };
    expect(screenshotToViewportPoint({ x: 0, y: 0 }, m)).toEqual({ x: 0, y: 0 });
    expect(screenshotToViewportPoint({ x: 1280, y: 720 }, m)).toEqual({ x: 1920, y: 1080 });
  });

  it("resolves points inside a REGION (zoom) capture against the crop's own rect", () => {
    // A zoom:2 crop of a 1200×800 viewport: 600×400 CSS centered at (300,200).
    // The crop image is 1200×800 px (native DPR-2), covering rect (300,200,600,400).
    const m = { imageW: 1200, imageH: 800, rectX: 300, rectY: 200, rectW: 600, rectH: 400 };
    expect(screenshotToViewportPoint({ x: 0, y: 0 }, m)).toEqual({ x: 300, y: 200 });
    expect(screenshotToViewportPoint({ x: 1200, y: 800 }, m)).toEqual({ x: 900, y: 600 });
    // The crop's centre maps to the rect's centre.
    expect(screenshotToViewportPoint({ x: 600, y: 400 }, m)).toEqual({ x: 600, y: 400 });
  });
});

describe("coordinate space conversion", () => {
  it("subtracts scroll for page-space points and leaves viewport points alone", () => {
    const scroll = { scrollX: 100, scrollY: 250 };
    expect(toViewportPoint({ x: 120, y: 350 }, "page", scroll)).toEqual({ x: 20, y: 100 });
    expect(toViewportPoint({ x: 20, y: 100 }, "viewport", scroll)).toEqual({ x: 20, y: 100 });
  });

  it("bounds-checks against the live viewport and names the bounds on a miss", () => {
    const vp = { width: 800, height: 600, scrollX: 0, scrollY: 0 };
    expect(boundsError({ x: 0, y: 0 }, vp)).toBeNull();
    expect(boundsError({ x: 800, y: 600 }, vp)).toBeNull();
    const err = boundsError({ x: -5, y: 10 }, vp);
    expect(err).toContain("outside the visible viewport");
    expect(err).toContain("800x600");
  });
});

describe("stroke plans", () => {
  it("plans a click as move → press → release", () => {
    const steps = planClick({ x: 5, y: 5 });
    expect(steps.map((s) => s.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(steps[1]).toMatchObject({ x: 5, y: 5, button: "left", clickCount: 1 });
  });

  it("expands multi-clicks into the real event sequence", () => {
    const steps = planClick({ x: 1, y: 1 }, "left", 2);
    expect(steps.map((s) => `${s.type}:${s.clickCount ?? 0}`)).toEqual([
      "mouseMoved:0",
      "mousePressed:1",
      "mouseReleased:1",
      "mousePressed:2",
      "mouseReleased:2",
    ]);
  });

  it("drags press at the start, move through a path, release at the end", () => {
    const steps = planDrag({ x: 0, y: 0 }, { x: 100, y: 50 }, 4);
    expect(steps[0]).toMatchObject({ type: "mouseMoved", x: 0, y: 0 });
    expect(steps[1]).toMatchObject({ type: "mousePressed", x: 0, y: 0 });
    expect(steps.at(-1)).toMatchObject({ type: "mouseReleased", x: 100, y: 50 });
    // Interpolated middle points, so drag-listeners see a path.
    const moves = steps.filter((s) => s.type === "mouseMoved").map((s) => s.x);
    expect(moves).toEqual([0, 25, 50, 75, 100]);
  });

  it("hover is a single move", () => {
    expect(planHover({ x: 3, y: 4 })).toEqual([{ type: "mouseMoved", x: 3, y: 4 }]);
  });
});

describe("describeHit", () => {
  const canvasHit: HitInfo = {
    tag: "canvas",
    text: "",
    inForm: false,
    canvas: true,
    overIframe: false,
  };

  it("names canvases as pixel surfaces and calls out iframes", () => {
    expect(describeHit(canvasHit)).toContain("canvas pixel surface");
    expect(describeHit({ ...canvasHit, canvas: false, tag: "iframe", overIframe: true })).toContain(
      "the real target is inside it",
    );
    expect(describeHit(null)).toContain("nothing at that point");
  });

  it("includes the ref and text so the model knows what it hit", () => {
    const hit: HitInfo = {
      tag: "button",
      type: "submit",
      text: "Buy now",
      inForm: true,
      ref: "7",
      canvas: false,
      overIframe: false,
    };
    const out = describeHit(hit);
    expect(out).toContain("Buy now");
    expect(out).toContain("ref 7");
    expect(out).toContain("type=submit");
  });
});

describe("shapeDragList (batched drags)", () => {
  it("accepts a list of numeric drag pairs", () => {
    const out = shapeDragList({
      drags: [
        { x: 10, y: 10, to_x: 20, to_y: 30 },
        { x: 40, y: 50, to_x: 60, to_y: 70 },
      ],
    });
    expect(out).toMatchObject({
      ok: true,
      drags: [
        { from: { x: 10, y: 10 }, to: { x: 20, y: 30 } },
        { from: { x: 40, y: 50 }, to: { x: 60, y: 70 } },
      ],
    });
  });

  it("caps the list at the batch ceiling", () => {
    const drags = Array.from({ length: MAX_BATCH_DRAGS + 1 }, (_, i) => ({
      x: i,
      y: i,
      to_x: i + 1,
      to_y: i + 1,
    }));
    const out = shapeDragList({ drags });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain(`${MAX_BATCH_DRAGS}`);
  });

  it("rejects malformed entries with their index", () => {
    const out = shapeDragList({ drags: [{ x: 1, y: 1, to_x: 2 }] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("drags[0]");
    expect(shapeDragList({ drags: [] }).ok).toBe(false);
    expect(shapeDragList({}).ok).toBe(false);
  });

  it("passes ref-based entries through for page-side resolution", () => {
    const out = shapeDragList({
      drags: [{ ref: "3#12", to_ref: "3#14" }, { x: 1, y: 2, to_x: 3, to_y: 4 }],
    });
    expect(out.ok).toBe(true);
    // Pure validation only sees the numeric one; refs are counted separately.
    expect(out.ok && out.drags).toHaveLength(1);
    expect(countRefDrags({ drags: [{ ref: "3#12", to_ref: "3#14" }, { x: 1, y: 2, to_x: 3, to_y: 4 }] })).toBe(1);
  });
});

describe("shapeModifiers (ref/frame modes)", () => {
  it("defaults button and click_count without requiring x/y", () => {
    expect(shapeModifiers({ ref: "3#12" })).toEqual({
      ok: true,
      button: "left",
      clickCount: 1,
    });
    expect(shapeModifiers({ button: "right", click_count: 3 })).toEqual({
      ok: true,
      button: "right",
      clickCount: 3,
    });
    expect(shapeModifiers({ button: "thumb" }).ok).toBe(false);
    expect(shapeModifiers({ click_count: 0 }).ok).toBe(false);
  });
});

describe("shapeSequenceSteps (input_sequence)", () => {
  it("shapes a full menu-path sequence", () => {
    const out = shapeSequenceSteps({
      steps: [
        { click: { x: 120, y: 40, space: "screenshot" } },
        { wait_ms: 300 },
        { click: { x: 220, y: 210 } },
        { type: "Playfair Display" },
        { key: "Return" },
        { type: { text: "replaced body", select: "all" } },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.steps.map((s) => s.kind)).toEqual([
        "click",
        "wait",
        "click",
        "type",
        "key",
        "type",
      ]);
      expect(out.steps[0]!.point).toMatchObject({ x: 120, y: 40, space: "screenshot" });
      expect(out.steps[3]!.text).toBe("Playfair Display");
      expect(out.steps[5]!.select).toBe("all");
      expect(out.steps[1]!.waitMs).toBe(300);
    }
  });

  it("clamps wait steps and rejects junk with indexed tool-error text", () => {
    expect(shapeSequenceSteps({ steps: [{ wait_ms: 99_999 }] })).toMatchObject({
      ok: true,
      steps: [{ kind: "wait", waitMs: 5_000 }],
    });
    for (const bad of [
      { steps: [] },
      { steps: "nope" },
      { steps: [{}] },
      { steps: [{ click: "not-an-object" }] },
      { steps: [{ key: 7 }] },
      { steps: [{ type: { select: "all" } }] },
      { steps: [{ wait_ms: -5 }] },
    ]) {
      const out = shapeSequenceSteps(bad);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.startsWith("ERROR:")).toBe(true);
    }
  });

  it("caps the step count like the drags list", () => {
    const many = Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, () => ({ key: "Tab" }));
    expect(shapeSequenceSteps({ steps: many }).ok).toBe(false);
    const ok = Array.from({ length: MAX_SEQUENCE_STEPS }, () => ({ key: "Tab" }));
    expect(shapeSequenceSteps({ steps: ok }).ok).toBe(true);
  });

  it("accepts the tool-name aliases the model actually writes", () => {
    // A real run called input_sequence with click_at steps and bare keys —
    // these must shape, not error.
    const out = shapeSequenceSteps({
      steps: [
        { click_at: { x: 330, y: 375, space: "screenshot", click_count: 2 } },
        { wait_ms: 200 },
        { click_at: { space: "screenshot", x: 470, y: 81 } },
        { type_at: { x: 100, y: 50, text: "hello", select: "all", keys_after: ["Control+b"] } },
        { press: "Return" },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.steps.map((s) => s.kind)).toEqual([
        "click",
        "wait",
        "click",
        "click",
        "type",
        "key",
        "key",
      ]);
      expect(out.steps[0]!.point).toMatchObject({ click_count: 2, x: 330 });
      // type_at expanded: click first, then the text, then its keys_after.
      expect(out.steps[3]!.point).toMatchObject({ x: 100, y: 50 });
      expect(out.steps[4]).toMatchObject({ kind: "type", text: "hello", select: "all" });
      expect(out.steps[5]!.key).toBe("Control+b");
      expect(out.steps[6]!.key).toBe("Return");
    }
    // select_to inside a sequence is rejected with guidance, not silently dropped.
    expect(
      shapeSequenceSteps({ steps: [{ type_at: { x: 1, y: 2, text: "t", select_to: { x: 3, y: 4 } } }] }).ok,
    ).toBe(false);
  });

  it("finds the steps list under any array-valued key", () => {
    const out = shapeSequenceSteps({ actions: [{ key: "Return" }] });
    expect(out.ok && out.steps[0]!.kind).toBe("key");
    expect(shapeSequenceSteps({ nope: 1 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The click sanitizers ("never misclick" pipeline — see HUMAN-FLOW-PLAN.md).
// ---------------------------------------------------------------------------

const menuRowHit = (over: Partial<HitInfo> = {}): HitInfo => ({
  tag: "div",
  role: "menuitem",
  text: "Page setup",
  inForm: false,
  ref: "17",
  canvas: false,
  overIframe: false,
  rect: { x: 480, y: 300, w: 260, h: 32 },
  ...over,
});

describe("snapOrPromote — the click magnet", () => {
  it("promotes a point on a small control to the control's CENTRE", () => {
    const d = snapOrPromote({ x: 482, y: 302 }, menuRowHit(), null);
    expect(d.kind).toBe("promote");
    if (d.kind === "promote") {
      expect(d.point).toEqual({ x: 610, y: 316 });
      expect(d.label).toContain("Page setup");
      expect(d.label).toContain("ref 17");
    }
  });

  it("keeps a point that is already the centre (no churn)", () => {
    expect(snapOrPromote({ x: 610, y: 316 }, menuRowHit(), null).kind).toBe("keep");
  });

  it("never re-aims canvas pixels, iframes, editable hosts or ref-less hits", () => {
    expect(snapOrPromote({ x: 5, y: 5 }, menuRowHit({ canvas: true }), null).kind).toBe("keep");
    expect(snapOrPromote({ x: 5, y: 5 }, menuRowHit({ overIframe: true }), null).kind).toBe("keep");
    expect(snapOrPromote({ x: 5, y: 5 }, menuRowHit({ editable: true }), null).kind).toBe("keep");
    expect(snapOrPromote({ x: 5, y: 5 }, menuRowHit({ ref: undefined }), null).kind).toBe("keep");
    expect(snapOrPromote({ x: 5, y: 5 }, null, null).kind).toBe("keep");
  });

  it("respects exact points inside BIG wrappers (several aim points inside)", () => {
    const big = menuRowHit({ rect: { x: 0, y: 0, w: 1000, h: 400 } });
    expect(snapOrPromote({ x: 500, y: 200 }, big, null).kind).toBe("keep");
    const tall = menuRowHit({ rect: { x: 0, y: 0, w: 100, h: 900 } });
    expect(snapOrPromote({ x: 50, y: 450 }, tall, null).kind).toBe("keep");
  });

  it("snaps a near miss to the nearby control and says so", () => {
    const snap: SnapCandidate = {
      ref: "22",
      tag: "div",
      role: "button",
      text: "Comment",
      rect: { x: 970, y: 380, w: 28, h: 28 },
      distance: 14,
    };
    // The point hit nothing interactive (a card body / padding).
    const plain: HitInfo = { tag: "div", text: "", inForm: false, canvas: false, overIframe: false };
    const d = snapOrPromote({ x: 980, y: 412 }, plain, snap);
    expect(d.kind).toBe("snap");
    if (d.kind === "snap") {
      expect(d.point).toEqual({ x: 984, y: 394 });
      expect(d.label).toContain("snapped 14px");
      expect(d.label).toContain("Comment");
    }
  });

  it("never snaps to editable neighbours or out-of-radius candidates", () => {
    const plain: HitInfo = { tag: "div", text: "", inForm: false, canvas: false, overIframe: false };
    const editable: SnapCandidate = {
      tag: "input",
      text: "",
      editable: true,
      rect: { x: 100, y: 100, w: 80, h: 24 },
      distance: 5,
    };
    expect(snapOrPromote({ x: 105, y: 130 }, plain, editable).kind).toBe("keep");
    const far: SnapCandidate = { ...editable, editable: false, distance: 40 };
    expect(snapOrPromote({ x: 105, y: 130 }, plain, far).kind).toBe("keep");
  });

  it("prefers promotion (the hit itself) over a snap candidate", () => {
    const snap: SnapCandidate = {
      tag: "button",
      text: "Other",
      rect: { x: 0, y: 0, w: 10, h: 10 },
      distance: 3,
    };
    expect(snapOrPromote({ x: 482, y: 302 }, menuRowHit(), snap).kind).toBe("promote");
  });
});

describe("rectDistance", () => {
  it("is 0 inside the rect and grows outside", () => {
    const r = { x: 100, y: 100, w: 50, h: 20 };
    expect(rectDistance({ x: 120, y: 110 }, r)).toBe(0);
    expect(rectDistance({ x: 153, y: 104 }, r)).toBe(3); // 3px right of the edge
    expect(rectDistance({ x: 153, y: 124 }, r)).toBe(5); // corner: 3-4-5
  });
});

describe("looksLikeShotPixels — the forgotten space:'screenshot'", () => {
  const vp = { width: 1046, height: 693 };
  const shot = { imageW: 1280, imageH: 848 };

  it("flags an out-of-viewport point that fits the image", () => {
    expect(looksLikeShotPixels({ x: 1164, y: 83 }, vp, shot)).toBe(true);
  });

  it("leaves in-bounds points alone", () => {
    expect(looksLikeShotPixels({ x: 500, y: 300 }, vp, shot)).toBe(false);
  });

  it("leaves points beyond the image alone (a genuine misclick, not a space mixup)", () => {
    expect(looksLikeShotPixels({ x: 3000, y: 83 }, vp, shot)).toBe(false);
  });

  it("says nothing without a capture, or when image == viewport dims", () => {
    expect(looksLikeShotPixels({ x: 1164, y: 83 }, vp, undefined)).toBe(false);
    expect(looksLikeShotPixels({ x: 1164, y: 83 }, vp, { imageW: 1046, imageH: 693 })).toBe(false);
  });
});

describe("compensateShotScroll", () => {
  it("shifts the point to follow content the page scrolled away", () => {
    // Captured at scrollY 100; the page has since scrolled down to 300:
    // content moved UP 200px, so the point must move up with it.
    const out = compensateShotScroll({ x: 50, y: 400 }, { scrollX: 0, scrollY: 100 }, { scrollX: 0, scrollY: 300 });
    expect(out.point).toEqual({ x: 50, y: 200 });
    expect(out.dy).toBe(-200);
  });

  it("is a no-op when nothing moved or the capture's scroll is unknown", () => {
    const still = compensateShotScroll({ x: 5, y: 5 }, { scrollX: 0, scrollY: 0 }, { scrollX: 0, scrollY: 0 });
    expect(still.point).toEqual({ x: 5, y: 5 });
    expect(still.dy).toBe(0);
    const unknown = compensateShotScroll({ x: 5, y: 5 }, undefined, { scrollX: 0, scrollY: 900 });
    expect(unknown.point).toEqual({ x: 5, y: 5 });
  });
});
