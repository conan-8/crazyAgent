import { describe, expect, it } from "vitest";
import {
  exportUrl,
  parseWorkspaceUrl,
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
