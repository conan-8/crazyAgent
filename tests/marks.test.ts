import { describe, expect, it } from "vitest";
import { marksLegend, planMarks, type MarkCandidate } from "../extension/src/shared/marks";

const vp = { width: 1000, height: 800 };
const el = (ref: string, x: number, y: number, w = 40, h = 20, name = ref): MarkCandidate => ({
  ref,
  name,
  tag: "button",
  box: { x, y, w, h },
});

describe("planMarks", () => {
  it("drops off-screen, tiny and page-sized elements", () => {
    const marks = planMarks(
      [
        el("1", 10, 30),
        el("2", -100, 30),
        el("3", 10, 900),
        el("4", 10, 30, 2, 2),
        el("5", 0, 0, 1000, 800),
      ],
      vp,
    );
    expect(marks.map((m) => m.ref)).toEqual(["1"]);
  });

  it("keeps the smallest targets when over the cap", () => {
    const marks = planMarks([el("big", 0, 100, 300, 200), el("small", 400, 100, 10, 10)], vp, 1);
    expect(marks.map((m) => m.ref)).toEqual(["small"]);
  });

  it("moves a label off an earlier one", () => {
    const [a, b] = planMarks([el("1", 100, 100), el("2", 100, 100)], vp);
    const overlap =
      a!.label.x < b!.label.x + b!.label.w &&
      b!.label.x < a!.label.x + a!.label.w &&
      a!.label.y < b!.label.y + b!.label.h &&
      b!.label.y < a!.label.y + a!.label.h;
    expect(overlap).toBe(false);
  });

  it("keeps labels inside the viewport", () => {
    const [m] = planMarks([el("12#345", 990, 0, 10, 10)], vp);
    expect(m!.label.x + m!.label.w).toBeLessThanOrEqual(vp.width);
    expect(m!.label.y).toBeGreaterThanOrEqual(0);
  });
});

describe("marksLegend", () => {
  it("lists ref, kind and name", () => {
    const text = marksLegend(planMarks([el("7", 10, 30, 40, 20, "Share")], vp));
    expect(text).toBe('[7] button "Share"\n');
  });
});
