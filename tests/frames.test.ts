// Frame-aware perception: how every frame's text is assembled for the model,
// which frames are listed, and how an unreadable canvas surface is signalled.
import { describe, expect, it } from "vitest";
import {
  FRAME_MAP_MAX,
  FRAME_TEXT_MIN_CHARS,
  FRAME_TEXT_TOTAL_CHARS,
  buildFrameText,
  collapseWhitespace,
  detectOpaqueSurface,
  formatFrameMap,
  orderFrames,
  type FrameSnapshotLike,
} from "../extension/src/shared/frames";

function frame(
  frameId: number,
  text: string,
  href = `https://f${frameId}.test/`,
  extra: Partial<FrameSnapshotLike> = {},
): FrameSnapshotLike {
  return { frameId, href, title: `Title ${frameId}`, text, ...extra };
}

/** A page whose real content lives inside a cross-origin iframe. */
function docsLike(): FrameSnapshotLike[] {
  return [
    // Result order from the browser is not guaranteed — main frame LAST here.
    frame(9, "Personal Essay Portfolio Assignment — write 800 words", "https://docs.google.com/document/d/x"),
    frame(0, "Schoology", "https://school.example.com/materials"),
  ];
}

describe("orderFrames", () => {
  it("puts the main frame first, then sorts by frame id", () => {
    const ordered = orderFrames([frame(17, "c"), frame(0, "main"), frame(4, "a")]);
    expect(ordered.map((f) => f.frameId)).toEqual([0, 4, 17]);
  });
});

describe("buildFrameText", () => {
  it("keeps EVERY frame's text, not just the main frame's", () => {
    const text = buildFrameText({ frames: docsLike(), elements: [], text: "" });
    expect(text).toContain("Schoology"); // main frame
    expect(text).toContain("Personal Essay Portfolio Assignment"); // iframe
  });

  it("labels each non-main frame with its id and URL", () => {
    const text = buildFrameText({ frames: docsLike(), elements: [], text: "" });
    expect(text).toContain("--- frame 9 (https://docs.google.com/document/d/x) ---");
  });

  it("puts the main frame's text first even when it arrives last", () => {
    const text = buildFrameText({ frames: docsLike(), elements: [], text: "" });
    expect(text.indexOf("Schoology")).toBeLessThan(text.indexOf("Personal Essay"));
    expect(text.startsWith("--- frame")).toBe(false); // main text is unlabelled
  });

  it("skips frames too short to be worth the tokens", () => {
    const text = buildFrameText({
      frames: [frame(0, "main page content"), frame(3, "hi"), frame(4, "   ")],
      elements: [],
      text: "",
    });
    expect(text).toContain("main page content");
    expect(text).not.toContain("frame 3");
    expect(FRAME_TEXT_MIN_CHARS).toBeGreaterThan("hi".length);
  });

  it("caps each frame so one huge frame cannot crowd out the rest", () => {
    const text = buildFrameText({
      frames: [
        frame(0, "main"),
        frame(2, "X".repeat(5_000), "https://a.test/"),
        frame(3, "the second frame's content", "https://b.test/"),
      ],
      elements: [],
      text: "",
    });
    expect(text).toContain("the second frame's content");
    // 1_200 char cap + the ellipsis marker.
    expect(text.length).toBeLessThan(3_000);
  });

  it("stops spending budget once the total is reached, and says so", () => {
    const big = (id: number) => frame(id, "Y".repeat(1_500), `https://f${id}.test/`);
    const text = buildFrameText({
      frames: [frame(0, "main"), big(1), big(2), big(3), big(4), big(5)],
      elements: [],
      text: "",
    });
    expect(text).toContain("[text omitted: snapshot budget reached]");
    // Total budget plus labels/headers, nowhere near 6 × 1_500.
    expect(text.length).toBeLessThan(FRAME_TEXT_TOTAL_CHARS + 2_000);
  });

  it("returns just the main text for a single-frame page", () => {
    const text = buildFrameText({ frames: [frame(0, "only the top document")], elements: [], text: "" });
    expect(text).toBe("only the top document");
  });

  it("collapses whitespace and survives a frame with no text at all", () => {
    const text = buildFrameText({
      frames: [frame(0, "  spaced\n\n  out  "), frame(2, "", "https://empty.test/")],
      elements: [],
      text: "",
    });
    expect(text).toBe("spaced out");
    expect(collapseWhitespace("\n a \t b \n")).toBe("a b");
  });
});

describe("formatFrameMap", () => {
  it("maps each frame id to its host so refs like 9#12 make sense", () => {
    const map = formatFrameMap({ frames: docsLike(), elements: [], text: "" });
    expect(map).toContain("Frames:");
    expect(map).toContain("frame 9: docs.google.com");
    expect(map).toContain('refs look like "9#n"');
  });

  it("is empty when the page has no iframes", () => {
    expect(formatFrameMap({ frames: [frame(0, "solo")], elements: [], text: "" })).toBe("");
  });

  it("caps a page with a silly number of frames", () => {
    const many = [frame(0, "main"), ...Array.from({ length: 40 }, (_, i) => frame(i + 1, "x", `https://a${i}.test/`))];
    const map = formatFrameMap({ frames: many, elements: [], text: "" });
    expect(map).toContain(`…${40 - FRAME_MAP_MAX} more frame(s)`);
  });
});

describe("detectOpaqueSurface", () => {
  it("explains a canvas-rendered page with no DOM text", () => {
    const note = detectOpaqueSurface({ canvases: 2, domTextChars: 12, frames: 1 });
    expect(note).toContain("<canvas>");
    expect(note).toContain("cannot be read by any tool");
    expect(note).toContain("screenshot");
    // It must discourage retrying, which is what wasted turns in practice.
    expect(note).toContain("report that instead of retrying");
  });

  it("stays silent on a normal page that happens to contain a canvas", () => {
    expect(detectOpaqueSurface({ canvases: 1, domTextChars: 4_000, frames: 1 })).toBeNull();
  });

  it("stays silent when there is no canvas", () => {
    expect(detectOpaqueSurface({ canvases: 0, domTextChars: 0, frames: 1 })).toBeNull();
  });
});