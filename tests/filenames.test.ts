import { describe, expect, it } from "vitest";
import {
  safeBasename,
  safeFilename,
  screenshotFilename,
} from "../extension/src/shared/filenames";

describe("filename hygiene", () => {
  it("reduces a path to a basename", () => {
    expect(safeBasename("../../etc/passwd", "shot")).toBe("passwd");
    expect(safeBasename("C:\\temp\\evil.exe", "shot")).toBe("evil.exe");
  });

  it("falls back to a timestamped name when nothing usable is given", () => {
    for (const bad of [undefined, "", "   ", 42]) {
      expect(safeBasename(bad, "screenshot")).toMatch(/^screenshot-/);
    }
  });

  it("keeps a name with the right extension and adds one otherwise", () => {
    expect(safeFilename("report.md", "md", "log")).toBe("report.md");
    expect(safeFilename("report", "md", "log")).toBe("report.md");
  });

  it("always makes screenshots .jpg without doubling extensions", () => {
    expect(screenshotFilename("shot")).toBe("shot.jpg");
    expect(screenshotFilename("shot.png")).toBe("shot.jpg");
    expect(screenshotFilename("a/b/shot.jpeg")).toBe("shot.jpg");
    expect(screenshotFilename(undefined)).toMatch(/^screenshot-.*\.jpg$/);
  });
});
