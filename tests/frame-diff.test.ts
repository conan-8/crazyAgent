import { describe, expect, it } from "vitest";
import {
  BROAD_CHANGE_RATIO,
  CELL_DELTA,
  DIFF_COLS,
  DIFF_ROWS,
  describeChangeRegion,
  describeFrameDiff,
  diffFrames,
  digestEffect,
  effectLine,
  effectVerdict,
  signatureFromLuminance,
  STRONG_CELL_DELTA,
} from "../extension/src/shared/frame-diff";

/** A uniform grid of one luminance value. */
function flat(value: number, cols = DIFF_COLS, rows = DIFF_ROWS) {
  return { cols, rows, cells: new Array(cols * rows).fill(value) as number[] };
}

describe("signatureFromLuminance", () => {
  it("clamps, rounds the shape and pads a short sample", () => {
    const sig = signatureFromLuminance([300, -20, Number.NaN], 2, 2);
    expect(sig.cols).toBe(2);
    expect(sig.rows).toBe(2);
    expect(sig.cells).toEqual([255, 0, 0, 0]);
  });
});

describe("diffFrames", () => {
  it("reports no change for two identical frames, with no box", () => {
    const diff = diffFrames(flat(200), flat(200))!;
    expect(diff.changed).toBe(false);
    expect(diff.changedRatio).toBe(0);
    expect(diff.box).toBeNull();
  });

  it("sees ONE strongly-changed cell — a toolbar pill, below any ratio floor", () => {
    // This is why the verdict is two-tier: a 30px toggle in a 1280px frame is
    // 1 cell out of 640 (0.16%), far below BROAD_CHANGE_RATIO, and the E2
    // failures ("bold never applied") look exactly like this.
    const a = flat(240);
    const b = flat(240);
    b.cells[100] = 240 - STRONG_CELL_DELTA;
    const diff = diffFrames(a, b)!;
    expect(diff.changed).toBe(true);
    expect(diff.strongCells).toBe(1);
    expect(diff.changedRatio).toBeLessThan(BROAD_CHANGE_RATIO);
    expect(diff.box).toEqual({ x0: 100 % DIFF_COLS, y0: Math.floor(100 / DIFF_COLS), x1: 100 % DIFF_COLS, y1: Math.floor(100 / DIFF_COLS) });
  });

  it("sees a SINGLE cell just past the noise floor — the common real change", () => {
    // Measured on the canvas fixture: appending six characters to a document
    // line moves exactly one cell by ~14. A verdict of "unchanged" here would
    // be wrong about the most ordinary action there is.
    const a = flat(240);
    const b = flat(240);
    b.cells[321] = 240 - CELL_DELTA;
    const diff = diffFrames(a, b)!;
    expect(diff.changed).toBe(true);
    expect(diff.changedRatio).toBeCloseTo(1 / (DIFF_COLS * DIFF_ROWS), 5);
  });

  it("ignores noise below CELL_DELTA (JPEG grain, a blinking caret)", () => {
    const a = flat(240);
    const b = flat(240);
    for (let i = 0; i < 40; i++) b.cells[i] = 240 - (CELL_DELTA - 1);
    const diff = diffFrames(a, b)!;
    expect(diff.changed).toBe(false);
    expect(diff.changedRatio).toBe(0);
  });

  it("sees a broad low-contrast change (re-layout, scroll)", () => {
    const a = flat(240);
    const b = flat(240);
    const n = Math.ceil(DIFF_COLS * DIFF_ROWS * BROAD_CHANGE_RATIO) + 2;
    for (let i = 0; i < n; i++) b.cells[i] = 240 - CELL_DELTA;
    const diff = diffFrames(a, b)!;
    expect(diff.changed).toBe(true);
    expect(diff.strongCells).toBe(0);
    expect(diff.changedRatio).toBeGreaterThanOrEqual(BROAD_CHANGE_RATIO);
  });

  it("refuses to compare different grid shapes instead of guessing", () => {
    expect(diffFrames(flat(10), flat(10, 16, 10))).toBeNull();
    expect(diffFrames(flat(10), { cols: DIFF_COLS, rows: DIFF_ROWS, cells: [] })).toBeNull();
  });
});

describe("describing a change", () => {
  it("names the band a change sits in", () => {
    // Explicit 32x20 here: the region wording is grid-relative, and these
    // boxes are written for the coarse grid the field fixtures used.
    expect(describeChangeRegion({ x0: 0, y0: 0, x1: 3, y1: 3 }, 32, 20)).toContain("top-left");
    expect(describeChangeRegion({ x0: 28, y0: 17, x1: 31, y1: 19 }, 32, 20)).toContain("bottom-right");
    expect(describeChangeRegion({ x0: 14, y0: 8, x1: 18, y1: 12 }, 32, 20)).toContain("centre");
    // A box spanning the width is described by the band it crosses, not as a
    // corner it does not sit in.
    expect(describeChangeRegion({ x0: 0, y0: 8, x1: 31, y1: 12 }, 32, 20)).toBe(
      "across the middle of the frame (32\u00d75 cells)",
    );
    expect(describeChangeRegion({ x0: 0, y0: 0, x1: 31, y1: 1 }, 32, 20)).toContain("across the top of the frame");
    expect(describeChangeRegion({ x0: 0, y0: 0, x1: 31, y1: 19 }, 32, 20)).toContain("across the whole frame");
    expect(describeChangeRegion(null)).toBe("");
  });

  it("summarizes a diff with a percentage and a place", () => {
    const a = flat(240);
    const b = flat(240);
    // A small block in the top-left corner.
    for (const i of [0, 1, 2, DIFF_COLS, DIFF_COLS + 1, DIFF_COLS + 2]) b.cells[i] = 100;
    const text = describeFrameDiff(diffFrames(a, b)!);
    expect(text).toContain("the frame changed");
    expect(text).toContain("%");
    expect(text).toContain("top-left");
  });
});

describe("effectVerdict", () => {
  it("turns a changed frame into a 'changed' verdict with the diff line", () => {
    const v = effectVerdict(diffFrames(flat(10), flat(200))!, "frame");
    expect(v.verdict).toBe("changed");
    expect(v.detail).toContain("effect: the frame changed");
    expect(effectLine(v).startsWith("\n[")).toBe(true);
  });

  it("turns an unchanged frame into the actionable no-op note", () => {
    const v = effectVerdict(diffFrames(flat(10), flat(10))!, "frame");
    expect(v.verdict).toBe("unchanged");
    expect(v.detail).toContain("NO VISIBLE CHANGE");
    expect(v.detail).toContain("change route");
  });

  it("is honest about a comparison it could not make", () => {
    const v = effectVerdict(null, "frame");
    expect(v.verdict).toBe("unknown");
    expect(effectLine(v)).toBe("");
  });

  it("uses digest wording for the text-snapshot half", () => {
    expect(digestEffect(true).verdict).toBe("changed");
    expect(digestEffect(false).detail).toContain("page digest is identical");
  });
});