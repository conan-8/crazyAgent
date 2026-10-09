import { describe, expect, it } from "vitest";
import {
  crossedCell,
  exportRetryDelayMs,
  exportUrl,
  parseWorkspaceUrl,
  sameLine,
  type CaretBox,
} from "../extension/src/background/tools/docs";

describe("parseWorkspaceUrl", () => {
  it("parses the editor, preview and bare forms of a Doc URL", () => {
    for (const url of [
      "https://docs.google.com/document/d/1aBcD-eF_123/edit",
      "https://docs.google.com/document/d/1aBcD-eF_123/edit?tab=t.0#toolbar=0",
      "https://docs.google.com/document/d/1aBcD-eF_123/preview",
      "https://docs.google.com/document/d/1aBcD-eF_123",
    ]) {
      const doc = parseWorkspaceUrl(url);
      expect(doc?.kind, url).toBe("document");
      expect(doc?.id, url).toBe("1aBcD-eF_123");
    }
  });

  it("parses Sheets and Slides", () => {
    expect(parseWorkspaceUrl("https://docs.google.com/spreadsheets/d/xyz9/edit#gid=0")).toMatchObject({
      kind: "spreadsheet",
      id: "xyz9",
    });
    expect(parseWorkspaceUrl("https://docs.google.com/presentation/d/prs1/edit")).toMatchObject({
      kind: "presentation",
      id: "prs1",
    });
  });

  it("rejects everything that is not a Workspace document", () => {
    for (const url of [
      "https://drive.google.com/drive/folders/abc",
      "https://docs.google.com/forms/d/abc/edit",
      "https://example.com/document/d/abc/edit",
      "chrome://newtab",
      "",
    ]) {
      expect(parseWorkspaceUrl(url), url).toBeNull();
    }
  });
});

describe("exportUrl", () => {
  const doc = parseWorkspaceUrl("https://docs.google.com/document/d/DOC1/edit")!;
  const sheet = parseWorkspaceUrl("https://docs.google.com/spreadsheets/d/SHT1/edit")!;
  const slides = parseWorkspaceUrl("https://docs.google.com/presentation/d/PRS1/edit")!;

  it("builds the text and html export endpoints for a Doc", () => {
    expect(exportUrl(doc, "text")).toBe("https://docs.google.com/document/d/DOC1/export?format=txt");
    expect(exportUrl(doc, "html")).toBe("https://docs.google.com/document/d/DOC1/export?format=html");
  });

  it("builds the CSV export for a Sheet", () => {
    expect(exportUrl(sheet, "text")).toBe(
      "https://docs.google.com/spreadsheets/d/SHT1/export?format=csv",
    );
  });

  it("has no text export for Slides — and says so with null", () => {
    expect(exportUrl(slides, "text")).toBeNull();
    expect(exportUrl(slides, "html")).toBeNull();
  });

  it("rejects unknown formats", () => {
    expect(exportUrl(doc, "docx")).toBeNull();
  });
});

describe("exportRetryDelayMs", () => {
  it("honours Retry-After seconds, capped so a turn never stalls for long", () => {
    expect(exportRetryDelayMs("2", 0)).toBe(2000);
    expect(exportRetryDelayMs("0", 0)).toBe(250);
    expect(exportRetryDelayMs("120", 1)).toBe(5000);
  });

  it("backs off by attempt when the header is absent or a date", () => {
    expect(exportRetryDelayMs(null, 0)).toBe(1200);
    expect(exportRetryDelayMs(null, 1)).toBe(2400);
    expect(exportRetryDelayMs("Wed, 21 Oct 2026 07:28:00 GMT", 0)).toBe(1200);
  });
});

// The y values are measured off a live Doc: a caret in the paragraph above a
// table sat at y=257, the table's first row at y=282, its second at y=314,
// every caret 17px tall. Telling those lines apart is what stops a collapsed
// find-bar match from leaving the caret outside the cell it aimed at.
describe("sameLine", () => {
  const box = (y: number, scrollTop = 0, height = 17): CaretBox => ({
    x: 540,
    y,
    width: 2,
    height,
    scrollTop,
    source: "kix-cursor-caret",
  });

  it("separates a paragraph from the table rows below it", () => {
    expect(sameLine(box(257), box(282))).toBe(false);
    expect(sameLine(box(282), box(314))).toBe(false);
  });

  it("reads two carets on one line as one line, however far apart they are", () => {
    expect(sameLine(box(282), box(282))).toBe(true);
    expect(sameLine(box(282, 0, 20), box(284, 0, 20))).toBe(true);
  });

  it("compares in document space, so a scroll between reads cannot fake a move", () => {
    expect(sameLine(box(282, 100), box(182, 200))).toBe(true);
    expect(sameLine(box(282, 100), box(282, 130))).toBe(false);
  });
});

// Measured live: stepping out of a second-column cell moved the caret from
// x=566 to the next cell's start ~134px away, on the SAME line — the escape a
// line comparison cannot see. An ordinary character step is single-digit px.
describe("crossedCell", () => {
  const box = (x: number, height = 17): CaretBox => ({
    x,
    y: 323,
    width: 2,
    height,
    scrollTop: 0,
    source: "kix-cursor-caret",
  });

  it("reads a jump across a cell boundary as a crossing", () => {
    expect(crossedCell(box(566), box(700))).toBe(true);
    expect(crossedCell(box(700), box(566))).toBe(true);
  });

  it("reads an ordinary character step as no crossing, wide characters included", () => {
    expect(crossedCell(box(566), box(574))).toBe(false);
    expect(crossedCell(box(566), box(581))).toBe(false);
  });

  it("scales with the caret height, so a large heading is not a false crossing", () => {
    expect(crossedCell(box(566, 40), box(606, 40))).toBe(false);
    expect(crossedCell(box(566, 40), box(666, 40))).toBe(true);
  });
});
