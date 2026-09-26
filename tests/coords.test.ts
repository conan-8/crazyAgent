import { describe, expect, it } from "vitest";
import {
  boundsError,
  describeHit,
  planClick,
  planDrag,
  planHover,
  shapeCoordArgs,
  toViewportPoint,
  type HitInfo,
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
