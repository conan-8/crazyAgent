import { describe, expect, it } from "vitest";
import {
  DOCS_OPS,
  normalizeStyleName,
  planDocsOp,
  shapeMargins,
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

  it("plans page_numbers as Insert ▸ Page numbers ▸ position row (with alternates)", () => {
    const out = planDocsOp("page_numbers", { position: "footer" });
    expect(out.ok).toBe(true);
    if (out.ok && out.plan.kind === "menu") {
      expect(out.plan.labels[0]).toBe("Insert");
      expect(out.plan.labels[1]).toBe("Page numbers");
      expect(out.plan.labels[2]).toEqual(["Bottom of page", "Footer"]);
    } else {
      throw new Error("expected a menu plan");
    }
    const top = planDocsOp("page_numbers", { position: "header" });
    expect(top.ok && top.plan.kind === "menu" && top.plan.labels[2]).toEqual(["Top of page", "Header"]);
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

  it("plans insert_table as Insert ▸ Table plus arrow keys into the grid", () => {
    const out = planDocsOp("insert_table", { rows: 4, cols: 3 });
    expect(out.ok).toBe(true);
    if (out.ok && out.plan.kind === "menuThenKeys") {
      expect(out.plan.labels).toEqual(["Insert", "Table"]);
      // 2 rights (cols-1), 3 downs (rows-1), Enter.
      expect(out.plan.combos).toEqual([
        "ArrowRight",
        "ArrowRight",
        "ArrowDown",
        "ArrowDown",
        "ArrowDown",
        "Enter",
      ]);
      expect(out.plan.verify).toMatchObject({ check: "exportHtmlContains", needle: "<table" });
    } else {
      throw new Error("expected a menuThenKeys plan");
    }
    // A 1×1 table is just Enter.
    const one = planDocsOp("insert_table", { rows: 1, cols: 1 });
    expect(one.ok && one.plan.kind === "menuThenKeys" && one.plan.combos).toEqual(["Enter"]);
  });

  it("rejects insert_table dimensions outside the picker grid", () => {
    for (const args of [{ rows: 0, cols: 3 }, { rows: 4, cols: 21 }, { rows: "4", cols: 3 }, {}]) {
      expect(planDocsOp("insert_table", args).ok).toBe(false);
    }
  });
});
