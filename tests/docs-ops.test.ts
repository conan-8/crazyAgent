import { describe, expect, it } from "vitest";
import {
  countPhrase,
  DOCS_OPS,
  gridCellPoint,
  gridCellPx,
  normalizeStyleName,
  parseFindCounter,
  parseGridStatus,
  planDocsOp,
  shapeMargins,
  shouldRetryWalk,
  styleShortcut,
} from "../extension/src/shared/docs-ops";

describe("normalizeStyleName", () => {
  it("canonicalizes the aliases models actually write", () => {
    expect(normalizeStyleName("title")).toBe("Title");
    expect(normalizeStyleName("  Heading   3 ")).toBe("Heading 3");
    expect(normalizeStyleName("h2")).toBe("Heading 2");
    expect(normalizeStyleName("normal")).toBe("Normal text");
    expect(normalizeStyleName("Body Text")).toBe("Normal text");
    expect(normalizeStyleName("Heading 9")).toBeNull();
    expect(normalizeStyleName(undefined)).toBeNull();
  });

  it("maps headings 1-6 to their trusted shortcuts and nothing else", () => {
    expect(styleShortcut("Heading 1")).toBe("Control+Alt+1");
    expect(styleShortcut("Heading 6")).toBe("Control+Alt+6");
    expect(styleShortcut("Title")).toBeNull();
    expect(styleShortcut("Normal text")).toBeNull();
  });
});

describe("shapeMargins", () => {
  it("spreads one number over all four sides", () => {
    expect(shapeMargins(1)).toEqual({ top: "1", right: "1", bottom: "1", left: "1" });
    expect(shapeMargins("0.5")).toEqual({ top: "0.5", right: "0.5", bottom: "0.5", left: "0.5" });
  });

  it("accepts a per-side object and rejects partial or non-numeric ones", () => {
    expect(shapeMargins({ top: 1, right: 1, bottom: 2, left: 1 })).toEqual({
      top: "1",
      right: "1",
      bottom: "2",
      left: "1",
    });
    expect(shapeMargins({ top: 1, right: 1, bottom: 1 })).toBeNull();
    expect(shapeMargins("wide")).toBeNull();
    expect(shapeMargins(undefined)).toBeUndefined();
  });
});

describe("planDocsOp", () => {
  it("rejects unknown ops with the menu of real ones", () => {
    const out = planDocsOp("make_coffee", {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain(DOCS_OPS.join(", "));
  });

  it("routes Heading styles through the trusted shortcut, verified by export", () => {
    const out = planDocsOp("apply_style", { style: "Heading 2" });
    expect(out.ok).toBe(true);
    if (out.ok && out.plan.kind === "keys") {
      expect(out.plan.combos).toEqual(["Control+Alt+2"]);
      expect(out.plan.verify).toMatchObject({ check: "exportHtmlContains", needle: "<h2" });
    } else {
      throw new Error("expected a keys plan");
    }
  });

  it("routes Title/Subtitle through Format ▸ Paragraph styles", () => {
    const out = planDocsOp("apply_style", { style: "title" });
    expect(out.ok).toBe(true);
    if (out.ok && out.plan.kind === "menu") {
      expect(out.plan.labels).toEqual(["Format", "Paragraph styles", "Title"]);
      expect(out.plan.verify).toMatchObject({ check: "exportHtmlContains", needle: 'class="title"' });
    } else {
      throw new Error("expected a menu plan");
    }
    // Normal text verifies via the toolbar style box (no export marker).
    const normal = planDocsOp("apply_style", { style: "normal" });
    expect(normal.ok && normal.plan.kind === "menu" && normal.plan.verify).toMatchObject({
      check: "toolbarStylesShows",
      needle: "Normal text",
    });
  });

  it("rejects apply_style without a usable style name", () => {
    const out = planDocsOp("apply_style", { style: "Fancy" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("Title");
  });

  it("plans page_numbers through Insert ▸ Page elements ▸ Page numbers (live 2026 menu)", () => {
    const out = planDocsOp("page_numbers", { position: "footer" });
    expect(out.ok).toBe(true);
    if (out.ok && out.plan.kind === "menu") {
      expect(out.plan.labels[0]).toBe("Insert");
      // The top-level "Page numbers" row does not exist on the live menu —
      // D burned four walks on it; it lives under Page elements.
      expect(out.plan.labels[1]).toBe("Page elements");
      expect(out.plan.labels[2]).toBe("Page numbers");
      expect(out.plan.labels[3]).toEqual(["Bottom of page", "Footer"]);
      expect(out.plan.describe).toContain("Page elements");
    } else {
      throw new Error("expected a menu plan");
    }
    const top = planDocsOp("page_numbers", { position: "header" });
    expect(top.ok && top.plan.kind === "menu" && top.plan.labels[3]).toEqual(["Top of page", "Header"]);
    expect(planDocsOp("page_numbers", {}).ok).toBe(false);
  });

  it("plans page_setup as a dialog walk: open, fill by label, confirm", () => {
    const out = planDocsOp("page_setup", {
      size: "Letter",
      margins: 1,
      orientation: "portrait",
    });
    expect(out.ok).toBe(true);
    if (out.ok && out.plan.kind === "dialog") {
      expect(out.plan.open).toEqual(["File", "Page setup"]);
      expect(out.plan.confirm).toEqual(["OK", "Save"]);
      expect(out.plan.verify).toMatchObject({ check: "dialogClosed" });
      const kinds = out.plan.fill.map((f) => f.kind);
      expect(kinds).toEqual(["select", "radio", "text", "text", "text", "text"]);
      expect(out.plan.fill[0]).toMatchObject({ value: "Letter", kind: "select" });
      expect(out.plan.fill[1]!.labels).toEqual(["Portrait"]);
      expect(out.plan.fill[2]).toMatchObject({ value: "1", kind: "text" });
      expect(out.plan.describe).toContain('1" margins');
    } else {
      throw new Error("expected a dialog plan");
    }
  });

  it("rejects page_setup with nothing to set, or a bad orientation", () => {
    expect(planDocsOp("page_setup", {}).ok).toBe(false);
    const bad = planDocsOp("page_setup", { orientation: "diagonal" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("portrait");
  });

  it("plans insert_table as Insert ▸ Table plus a size-grid pick", () => {
    const out = planDocsOp("insert_table", { rows: 4, cols: 3 });
    expect(out.ok).toBe(true);
    if (out.ok && out.plan.kind === "menuThenGridPick") {
      expect(out.plan.labels).toEqual(["Insert", "Table"]);
      expect(out.plan.rows).toBe(4);
      expect(out.plan.cols).toBe(3);
      expect(out.plan.verify).toMatchObject({ check: "exportHtmlContains", needle: "<table" });
    } else {
      throw new Error("expected a menuThenGridPick plan");
    }
    // A 1×1 table is still a pick, not a bare Enter: the grid is the only
    // thing that can confirm what is about to be inserted.
    const one = planDocsOp("insert_table", { rows: 1, cols: 1 });
    expect(one.ok && one.plan.kind === "menuThenGridPick" && one.plan.rows).toBe(1);
  });

  it("rejects insert_table dimensions outside the picker grid", () => {
    for (const args of [{ rows: 0, cols: 3 }, { rows: 4, cols: 21 }, { rows: "4", cols: 3 }, {}]) {
      expect(planDocsOp("insert_table", args).ok).toBe(false);
    }
  });

  it("runs page_break as the Ctrl+Enter shortcut — no menu to miss", () => {
    const out = planDocsOp("page_break", {});
    expect(out.ok).toBe(true);
    if (out.ok && out.plan.kind === "keys") {
      expect(out.plan.combos).toEqual(["Control+Enter"]);
    } else {
      throw new Error("expected a keys plan");
    }
  });

  it("plans table_of_contents via Insert ▸ Table of contents, style-tagged", () => {
    const linked = planDocsOp("table_of_contents", {});
    expect(linked.ok).toBe(true);
    if (linked.ok && linked.plan.kind === "menu") {
      expect(linked.plan.labels[0]).toBe("Insert");
      expect(linked.plan.labels[1]).toBe("Table of contents");
      expect(linked.plan.labels[2]).toEqual(["Linked contents", "Linked", "Table of contents"]);
      expect(linked.plan.describe).toContain("linked");
    } else {
      throw new Error("expected a menu plan");
    }
    const plain = planDocsOp("table_of_contents", { style: "plain" });
    expect(plain.ok && plain.plan.kind === "menu" && plain.plan.labels[2]).toEqual(["Plain text"]);
    const dotted = planDocsOp("table_of_contents", { style: "dotted" });
    expect(dotted.ok && dotted.plan.kind === "menu" && dotted.plan.labels[2]).toEqual([
      "Dotted lines",
      "Dotted",
    ]);
  });

  it("plans equation through Insert ▸ Symbols ▸ Equation and types the text", () => {
    const out = planDocsOp("equation", { text: " E = mc^2 " });
    expect(out.ok).toBe(true);
    if (out.ok && out.plan.kind === "menuThenType") {
      // Equation is a ROW INSIDE Symbols on the live menu; D and E both tried
      // Insert ▸ Equation and lost turns to it.
      expect(out.plan.labels).toEqual(["Insert", "Symbols", "Equation"]);
      expect(out.plan.text).toBe("E = mc^2");
    } else {
      throw new Error("expected a menuThenType plan");
    }
    const empty = planDocsOp("equation", {});
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("text");
  });

  it("retries a menu walk only for a post-first-step miss that is not DISABLED", () => {
    expect(shouldRetryWalk(1, 'no visible clickable element matches ["Page elements"]')).toBe(true);
    expect(shouldRetryWalk(2, "no visible clickable element matches [\"Table of contents\"]")).toBe(true);
    // Step 1 missing = wrong page/path: a retry only burns the budget.
    expect(shouldRetryWalk(0, "no visible clickable element matches [\"Insert\"]")).toBe(false);
    // Disabled is a state problem; re-walking cannot enable the row.
    expect(shouldRetryWalk(2, '"Delete column" was found but is DISABLED')).toBe(false);
  });
});

describe("parseFindCounter", () => {
  it("reads the counter shapes find bars print", () => {
    expect(parseFindCounter(["Find in document", "2 of 5"])).toEqual({ current: 2, total: 5 });
    expect(parseFindCounter(["0 of 0"])).toEqual({ current: 0, total: 0 });
    expect(parseFindCounter([" 1/3 "])).toEqual({ current: 1, total: 3 });
    expect(parseFindCounter(["3 von 7"])).toEqual({ current: 3, total: 7 });
  });

  it("does not mistake a lone number or prose for a counter", () => {
    expect(parseFindCounter(["12", "Match case", "page 1 of the doc"])).toBeNull();
    expect(parseFindCounter(["5 of 2"])).toBeNull();
    expect(parseFindCounter([])).toBeNull();
  });
});

describe("countPhrase", () => {
  it("counts like the find bar: literal, case-insensitive, whitespace-tolerant", () => {
    expect(countPhrase("Alpha beta ALPHA\nalpha", "alpha")).toBe(3);
    expect(countPhrase("one  two\nthree", "two three")).toBe(1);
    expect(countPhrase("alpha beta gamma", "zzqqzz")).toBe(0);
    expect(countPhrase("aaaa", "aa")).toBe(2);
    expect(countPhrase("anything", "  ")).toBe(0);
  });
});

// Every number here was measured off a live Docs picker (mousecatcher origin
// 502,155; hovering 565,182 made it read "4 x 2" with a 72×36 highlight).
describe("the table size grid", () => {
  const ORIGIN = { x: 502, y: 155 };

  it("reads the size label through Google's bidi padding", () => {
    expect(parseGridStatus("\u202a1 x 1\u202c")).toEqual({ cols: 1, rows: 1 });
    expect(parseGridStatus("\u202a4 x 2\u202c")).toEqual({ cols: 4, rows: 2 });
    expect(parseGridStatus("6 × 5")).toEqual({ cols: 6, rows: 5 });
    expect(parseGridStatus("")).toBeNull();
    expect(parseGridStatus("Table")).toBeNull();
    expect(parseGridStatus("0 x 3")).toBeNull();
  });

  it("measures the cell from the block the grid has highlighted", () => {
    expect(gridCellPx(72, 4)).toBe(18);
    expect(gridCellPx(108, 6)).toBe(18);
    expect(gridCellPx(0, 4)).toBeNull();
    expect(gridCellPx(18, 0)).toBeNull();
  });

  it("aims at a cell's centre, matching where a real hover landed", () => {
    expect(gridCellPoint(ORIGIN, 18, 4, 2)).toEqual({ x: 565, y: 182 });
    expect(gridCellPoint(ORIGIN, 18, 6, 5)).toEqual({ x: 601, y: 236 });
    // The centre of the first cell is inside it, not on the grid's top edge.
    expect(gridCellPoint(ORIGIN, 18, 1, 1)).toEqual({ x: 511, y: 164 });
  });
});
