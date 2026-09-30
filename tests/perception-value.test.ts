// Snapshot-rendering regression tests. A live run stared at
// value="…Read &amp;" — a silent 40-char cut of a longer input value — and
// could not tell a truncated DISPLAY from a literal "&amp;" in the field. It
// burned ~20 minutes re-typing a document title. Truncated values must now SAY
// they were truncated and how long the real value is.
import { describe, expect, it } from "vitest";
import { clipValue, formatSnapshot } from "../extension/src/background/tools/perception";
import type { AggregatedSnapshot } from "../extension/src/shared/frames";

describe("clipValue", () => {
  it("passes a short value through untouched", () => {
    expect(clipValue("hello")).toBe("hello");
    expect(clipValue("x".repeat(40))).toBe("x".repeat(40));
  });

  it("marks a truncated value and reports the true length", () => {
    const v = "Labour Day Exercise – Task 3: Read & Respond"; // 44 chars
    const out = clipValue(v);
    expect(out).toContain("…");
    expect(out).toContain("value truncated");
    expect(out).toContain("44 chars total");
    // The visible prefix is still there for the model to read.
    expect(out.startsWith(v.slice(0, 40))).toBe(true);
  });

  it("honours a custom max", () => {
    expect(clipValue("abcdef", 3)).toContain("6 chars total");
  });
});

function snapWith(value: string): AggregatedSnapshot {
  return {
    frames: [{ frameId: 0, href: "http://x", title: "t", text: "body" }],
    elements: [
      {
        ref: "0#1",
        frameId: 0,
        tag: "input",
        type: "text",
        name: "Rename",
        value,
        editable: true,
        box: null,
        selector: "input",
      },
    ],
    text: "body",
  };
}

describe("formatSnapshot value rendering", () => {
  it("renders a short value plainly", () => {
    const out = formatSnapshot(snapWith("Read & Respond"));
    expect(out).toContain('value="Read & Respond"');
    expect(out).not.toContain("value truncated");
  });

  it("flags a long value as truncated instead of silently cutting it", () => {
    const out = formatSnapshot(snapWith("Labour Day Exercise – Task 3: Read & Respond"));
    expect(out).toContain("value truncated");
    expect(out).toContain("44 chars total");
    // The exact ambiguity that cost the run: a bare &amp; at a 40-char
    // boundary must never look like the whole value.
    expect(out).not.toMatch(/value="[^"]*&amp;"\s*$/m);
  });
});
