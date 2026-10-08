import { describe, expect, it } from "vitest";
import {
  cellOrdinal,
  decodeEntities,
  docTables,
  formatOutline,
  parseClassMarks,
  parseDocStructure,
  planCaretRoute,
  type DocBlock,
  type TableBlock,
} from "../extension/src/shared/docs-structure";

const STYLE = "<style>.c7{font-weight:700}.c8{font-style:italic}.c9{text-decoration:underline}.c1{color:#000}</style>";
const doc = (body: string): string => `<html><head>${STYLE}</head><body class="c3">${body}</body></html>`;

describe("parseClassMarks", () => {
  it("maps export classes to bold/italic/underline only", () => {
    const m = parseClassMarks(doc(""));
    expect(m.get("c7")).toEqual({ bold: true });
    expect(m.get("c8")).toEqual({ italic: true });
    expect(m.get("c9")).toEqual({ underline: true });
    expect(m.has("c1")).toBe(false);
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities, nbsp to a space", () => {
    expect(decodeEntities("a&amp;b &lt;x&gt; &#39;q&#39; &#x41;&nbsp;z")).toBe("a&b <x> 'q' A z");
  });
});

describe("parseDocStructure", () => {
  it("reads title, headings, marks and links", () => {
    const blocks = parseDocStructure(
      doc(
        '<p class="c4 title"><span>Report</span></p>' +
          '<h1 class="c2"><span>Intro</span></h1>' +
          '<p class="c2"><span class="c1">Plain </span><span class="c7">bold</span><span> and </span><span class="c8 c7">both</span></p>' +
          '<p><span><a href="https://www.google.com/url?q=https://ex.com/a&amp;sa=D">site</a></span></p>',
      ),
    );
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ kind: "para", style: "TITLE", text: "Report" });
    expect(blocks[1]).toMatchObject({ style: "H1", text: "Intro" });
    expect(blocks[2]).toMatchObject({ text: "Plain bold and both", marked: "Plain **bold** and ***both***" });
    expect(blocks[3]).toMatchObject({ marked: "[site](https://ex.com/a)" });
  });

  it("reads list items with level and ordering", () => {
    const blocks = parseDocStructure(
      doc(
        '<ul class="lst-kix_a-0"><li class="c2 li-bullet-0 lst-kix_a-0"><span>one</span></li></ul>' +
          '<ul class="lst-kix_a-1"><li class="lst-kix_a-1"><span>nested</span></li></ul>' +
          '<ol class="lst-kix_b-0"><li class="lst-kix_b-0"><span>first</span></li></ol>',
      ),
    );
    expect(blocks).toMatchObject([
      { style: "LI", text: "one", listLevel: 0, ordered: false },
      { style: "LI", text: "nested", listLevel: 1 },
      { style: "LI", text: "first", ordered: true },
    ]);
  });

  it("reads tables with merged cells and multi-paragraph cells", () => {
    const blocks = parseDocStructure(
      doc(
        "<p><span>Before</span></p>" +
          '<table><tr><td colspan="2" rowspan="1"><p><span>Head</span></p></td></tr>' +
          "<tr><td><p><span>a</span></p><p><span>a2</span></p></td><td><p><span></span></p></td></tr></table>" +
          "<p><span>After</span></p>",
      ),
    );
    const [t] = docTables(blocks);
    expect(t!.index).toBe(1);
    expect(t!.rows).toEqual([
      [{ text: "Head", colspan: 2, rowspan: 1 }],
      [
        { text: "a\na2", colspan: 1, rowspan: 1 },
        { text: "", colspan: 1, rowspan: 1 },
      ],
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["para", "table", "para"]);
  });

  it("separates page breaks from horizontal lines", () => {
    const blocks = parseDocStructure(doc('<hr style="page-break-before:always;display:none;"><hr>'));
    expect(blocks).toEqual([{ kind: "pagebreak" }, { kind: "hr" }]);
  });
});

describe("formatOutline", () => {
  it("prints styles, marks, tables as grids, and collapses empty lines", () => {
    const out = formatOutline(
      parseDocStructure(
        doc(
          '<h2><span class="c7">Results</span></h2><p></p><p></p>' +
            '<table><tr><td colspan="2"><p><span>H</span></p></td></tr><tr><td><p><span>1</span></p></td><td></td></tr></table>',
        ),
      ),
    );
    expect(out).toBe(
      [
        "H2: **Results**",
        "(empty line ×2)",
        "TABLE 1 (2 rows × 2 cols):",
        "  r1: H ⟨merged 1×2⟩",
        "  r2: 1 | ·",
      ].join("\n"),
    );
  });
});

const grid = (rows: string[][], index = 1): TableBlock => ({
  kind: "table",
  index,
  rows: rows.map((r) => r.map((text) => ({ text, colspan: 1, rowspan: 1 }))),
});
const p = (text: string): DocBlock => ({ kind: "para", style: "P", text, marked: text });

describe("cellOrdinal", () => {
  it("is the row-major Tab index, merged cells counting once", () => {
    const t: TableBlock = {
      kind: "table",
      index: 1,
      rows: [[{ text: "m", colspan: 2, rowspan: 1 }], grid([["a", "b"]]).rows[0]!],
    };
    expect(cellOrdinal(t, { row: 1, col: 1 })).toBe(0);
    expect(cellOrdinal(t, { row: 2, col: 2 })).toBe(2);
    expect(cellOrdinal(t, { row: 1, col: 2 })).toBeNull();
    expect(cellOrdinal(t, { row: 3, col: 1 })).toBeNull();
  });
});

describe("planCaretRoute", () => {
  it("anchors on the nearest non-empty cell and tabs from it", () => {
    const blocks = [p("Intro"), grid([["Name", "Score"], ["", ""], ["", "42"]])];
    const r = planCaretRoute(blocks, 1, { row: 2, col: 2 });
    // r2c2 is two Tabs from both "Score" and "42": the tie keeps the earlier anchor.
    expect(r).toEqual({
      ok: true,
      route: { via: "cell", phrase: "Score", occurrence: 1, anchor: { row: 1, col: 2 }, tabs: 2 },
    });
    const back = planCaretRoute(blocks, 1, { row: 3, col: 1 });
    expect(back).toMatchObject({ ok: true, route: { phrase: "42", tabs: -1 } });
  });

  it("counts earlier matches of the anchor phrase, case-insensitively", () => {
    const blocks = [p("the name game"), grid([["x"]]), grid([["Name"]], 2)];
    const r = planCaretRoute(blocks, 2, { row: 1, col: 1 });
    expect(r).toMatchObject({ ok: true, route: { via: "cell", phrase: "Name", occurrence: 2, tabs: 0 } });
  });

  it("anchors an empty table on the paragraph before it", () => {
    const blocks = [p("Scores below"), p(""), grid([["", ""], ["", ""]])];
    const r = planCaretRoute(blocks, 1, { row: 2, col: 1 });
    expect(r).toEqual({
      ok: true,
      route: { via: "before-table", phrase: "Scores below", occurrence: 1, rights: 2, tabs: 2 },
    });
  });

  it("uses the document start when an empty table opens the document", () => {
    const r = planCaretRoute([p(""), grid([["", ""]])], 1, { row: 1, col: 2 });
    expect(r).toEqual({ ok: true, route: { via: "doc-start", rights: 1, tabs: 1 } });
  });

  it("rejects missing tables and cells", () => {
    expect(planCaretRoute([grid([["a"]])], 2, { row: 1, col: 1 })).toMatchObject({ ok: false });
    const bad = planCaretRoute([grid([["a", "b"]])], 1, { row: 1, col: 3 });
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.error).toContain("cells per row: 2");
  });
});
