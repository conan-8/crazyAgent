// Pure structure model of a Google Doc, built from its HTML export (the same
// export docs_read fetches). Service workers have no DOMParser, so this is a
// small tokenizer tuned to the export's regular shape:
//   <style>.c7{font-weight:700}</style> … <p class="c1 title"><span class="c7">…</span></p>
//   <h1>…</h1> <ul class="lst-kix_x-0"><li>…</li></ul>
//   <table><tr><td colspan="2" rowspan="1"><p>…</p></td></tr></table>
// It powers three things: the compact `outline` read (what the document IS,
// with formatting marks), table addressing by row/col, and the keyboard plan
// that puts the caret in a given cell without aiming a single pixel.

export interface TextMarks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface ParaBlock {
  kind: "para";
  /** TITLE | SUBTITLE | H1..H6 | P | LI */
  style: string;
  /** Plain text exactly as the find bar sees it. */
  text: string;
  /** Text with **bold**, *italic*, __underline__ and [link](href) marks. */
  marked: string;
  listLevel?: number;
  ordered?: boolean;
}

export interface TableCell {
  text: string;
  colspan: number;
  rowspan: number;
}

export interface TableBlock {
  kind: "table";
  /** 1-based, document order (top-level tables only). */
  index: number;
  rows: TableCell[][];
}

export type DocBlock =
  | ParaBlock
  | TableBlock
  | { kind: "hr" }
  | { kind: "pagebreak" }
  | { kind: "image" };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code)) return m;
      return code === 160 ? " " : String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

/** `.c7{font-weight:700}` → c7 → {bold}. Only the marks a task grades. */
export function parseClassMarks(html: string): Map<string, TextMarks> {
  const out = new Map<string, TextMarks>();
  const style = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(html)?.[1] ?? "";
  for (const m of style.matchAll(/\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g)) {
    const [, cls, body] = m as unknown as [string, string, string];
    const marks: TextMarks = {};
    if (/font-weight\s*:\s*(700|bold)/i.test(body)) marks.bold = true;
    if (/font-style\s*:\s*italic/i.test(body)) marks.italic = true;
    if (/text-decoration[^;]*underline/i.test(body)) marks.underline = true;
    if (marks.bold || marks.italic || marks.underline) out.set(cls, marks);
  }
  return out;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : undefined;
}

function marksOf(attrs: string, classMarks: Map<string, TextMarks>): TextMarks {
  const merged: TextMarks = {};
  for (const cls of (attr(attrs, "class") ?? "").split(/\s+/)) {
    const m = classMarks.get(cls);
    if (m?.bold) merged.bold = true;
    if (m?.italic) merged.italic = true;
    if (m?.underline) merged.underline = true;
  }
  const inline = attr(attrs, "style") ?? "";
  if (/font-weight\s*:\s*(700|bold)/i.test(inline)) merged.bold = true;
  if (/font-style\s*:\s*italic/i.test(inline)) merged.italic = true;
  if (/text-decoration[^;]*underline/i.test(inline)) merged.underline = true;
  return merged;
}

function wrap(text: string, m: TextMarks, href?: string): string {
  if (!text.trim()) return text;
  const lead = /^\s*/.exec(text)![0];
  const trail = /\s*$/.exec(text)![0];
  let core = text.trim();
  // A link's own underline is the link styling, not a task's formatting.
  if (m.underline && !href) core = `__${core}__`;
  if (m.italic) core = `*${core}*`;
  if (m.bold) core = `**${core}**`;
  if (href) core = `[${core}](${href})`;
  return lead + core + trail;
}

interface OpenPara {
  style: string;
  text: string;
  marked: string;
  listLevel?: number;
  ordered?: boolean;
}

interface OpenTable {
  rows: TableCell[][];
  cell?: { text: string[]; colspan: number; rowspan: number };
}

/** Tokenize the export into document-order blocks. */
export function parseDocStructure(html: string): DocBlock[] {
  const classMarks = parseClassMarks(html);
  const bodyStart = html.search(/<body[^>]*>/i);
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const blocks: DocBlock[] = [];
  const tables: OpenTable[] = [];
  const lists: { ordered: boolean }[] = [];
  const spanMarks: TextMarks[] = [];
  let para: OpenPara | null = null;
  let href: string | undefined;
  let tableCount = 0;

  const currentMarks = (): TextMarks => {
    const m: TextMarks = {};
    for (const s of spanMarks) {
      if (s.bold) m.bold = true;
      if (s.italic) m.italic = true;
      if (s.underline) m.underline = true;
    }
    return m;
  };
  const append = (raw: string): void => {
    if (!para) para = { style: "P", text: "", marked: "" };
    para.text += raw;
    para.marked += wrap(raw, currentMarks(), href);
  };
  const closePara = (): void => {
    if (!para) return;
    const p: OpenPara = para;
    para = null;
    const cell = tables.at(-1)?.cell;
    if (cell) {
      cell.text.push(p.text);
      return;
    }
    blocks.push({ kind: "para", ...p });
  };

  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  for (const m of body.matchAll(re)) {
    const [, slash, tagRaw, attrs = "", text] = m as unknown as [string, string, string, string, string];
    if (text !== undefined) {
      const decoded = decodeEntities(text.replace(/\s*\n\s*/g, " "));
      if (decoded && (para || decoded.trim())) append(decoded);
      continue;
    }
    const tag = tagRaw.toLowerCase();
    const closing = slash === "/";
    switch (tag) {
      case "p":
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
      case "li": {
        if (closing) {
          closePara();
          break;
        }
        closePara();
        const cls = attr(attrs, "class") ?? "";
        let style = tag === "p" ? "P" : tag === "li" ? "LI" : tag.toUpperCase();
        if (/\btitle\b/.test(cls)) style = "TITLE";
        else if (/\bsubtitle\b/.test(cls)) style = "SUBTITLE";
        const open: OpenPara = { style, text: "", marked: "" };
        if (tag === "li") {
          open.listLevel = Number(/lst-[^\s"]*-(\d+)/.exec(cls)?.[1] ?? Math.max(0, lists.length - 1));
          open.ordered = lists.at(-1)?.ordered ?? false;
        }
        para = open;
        break;
      }
      case "ul":
      case "ol":
        if (closing) lists.pop();
        else lists.push({ ordered: tag === "ol" });
        break;
      case "span":
        if (closing) spanMarks.pop();
        else spanMarks.push(marksOf(attrs, classMarks));
        break;
      case "b":
      case "strong":
        if (closing) spanMarks.pop();
        else spanMarks.push({ bold: true });
        break;
      case "a":
        if (closing) href = undefined;
        else {
          const h = attr(attrs, "href");
          // Docs wraps outbound links in a google.com/url?q= redirect.
          const q = h && /[?&]q=([^&]+)/.exec(h)?.[1];
          href = q ? decodeURIComponent(q) : h;
        }
        break;
      case "br":
        if (!closing) append("\n");
        break;
      case "img":
        if (closing) break;
        if (para || tables.at(-1)?.cell) append("[image]");
        else blocks.push({ kind: "image" });
        break;
      case "hr":
        if (closing) break;
        closePara();
        if (!tables.length) {
          blocks.push(/page-break/i.test(attrs) ? { kind: "pagebreak" } : { kind: "hr" });
        }
        break;
      case "table":
        closePara();
        if (closing) {
          const t = tables.pop();
          if (t && !tables.length) blocks.push({ kind: "table", index: ++tableCount, rows: t.rows });
          else if (t && tables.at(-1)?.cell) {
            // A nested table folds into its parent cell as text.
            tables.at(-1)!.cell!.text.push(t.rows.map((r) => r.map((c) => c.text).join(" | ")).join(" / "));
          }
        } else {
          tables.push({ rows: [] });
        }
        break;
      case "tr":
        if (!closing) tables.at(-1)?.rows.push([]);
        break;
      case "td":
      case "th": {
        const t = tables.at(-1);
        if (!t) break;
        if (closing) {
          closePara();
          if (t.cell) {
            t.rows.at(-1)?.push({
              text: t.cell.text.join("\n").replace(/\n+$/, ""),
              colspan: t.cell.colspan,
              rowspan: t.cell.rowspan,
            });
            t.cell = undefined;
          }
        } else {
          if (!t.rows.length) t.rows.push([]);
          t.cell = {
            text: [],
            colspan: Math.max(1, Number(attr(attrs, "colspan") ?? 1) || 1),
            rowspan: Math.max(1, Number(attr(attrs, "rowspan") ?? 1) || 1),
          };
        }
        break;
      }
      default:
        break;
    }
  }
  closePara();
  return blocks;
}

export function docTables(blocks: DocBlock[]): TableBlock[] {
  return blocks.filter((b): b is TableBlock => b.kind === "table");
}

/** Compact, line-per-block view: what the document says AND how it is styled. */
export function formatOutline(blocks: DocBlock[]): string {
  const lines: string[] = [];
  let empties = 0;
  const flushEmpties = (): void => {
    if (empties) lines.push(empties === 1 ? "(empty line)" : `(empty line ×${empties})`);
    empties = 0;
  };
  for (const b of blocks) {
    if (b.kind === "para" && !b.text.trim()) {
      empties++;
      continue;
    }
    flushEmpties();
    switch (b.kind) {
      case "para": {
        if (b.style === "LI") {
          const indent = "  ".repeat(b.listLevel ?? 0);
          lines.push(`${indent}${b.ordered ? "1." : "•"} ${b.marked.trim()}`);
        } else {
          lines.push(`${b.style}: ${b.marked.trim()}`);
        }
        break;
      }
      case "table": {
        const cols = Math.max(0, ...b.rows.map((r) => r.reduce((s, c) => s + c.colspan, 0)));
        lines.push(`TABLE ${b.index} (${b.rows.length} rows × ${cols} cols):`);
        b.rows.forEach((r, i) => {
          const cells = r.map((c) => {
            const span =
              c.colspan > 1 || c.rowspan > 1
                ? ` ⟨merged ${c.rowspan}×${c.colspan}⟩`
                : "";
            return `${c.text.replace(/\n/g, " ⏎ ") || "·"}${span}`;
          });
          lines.push(`  r${i + 1}: ${cells.join(" | ")}`);
        });
        break;
      }
      case "hr":
        lines.push("— horizontal line —");
        break;
      case "pagebreak":
        lines.push("═══ page break ═══");
        break;
      case "image":
        lines.push("[image]");
        break;
    }
  }
  flushEmpties();
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Table addressing — the keyboard route into a cell.
// ---------------------------------------------------------------------------

export interface CellAddress {
  /** 1-based row, as the outline prints it. */
  row: number;
  /** 1-based cell within that row (merged cells count once). */
  col: number;
}

/** Tab walks cells in row-major order; this is a cell's position in that walk. */
export function cellOrdinal(table: TableBlock, addr: CellAddress): number | null {
  const r = table.rows[addr.row - 1];
  if (!r || addr.col < 1 || addr.col > r.length) return null;
  let n = 0;
  for (let i = 0; i < addr.row - 1; i++) n += table.rows[i]!.length;
  return n + addr.col - 1;
}

export function cellAt(table: TableBlock, addr: CellAddress): TableCell | null {
  return table.rows[addr.row - 1]?.[addr.col - 1] ?? null;
}

function countMatches(hay: string, needle: string): number {
  if (!needle) return 0;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) count++;
  return count;
}

/** Every find-bar-searchable text segment, in document order. */
function segments(blocks: DocBlock[]): { text: string; table?: number; cell?: number }[] {
  const out: { text: string; table?: number; cell?: number }[] = [];
  for (const b of blocks) {
    if (b.kind === "para") out.push({ text: b.text });
    else if (b.kind === "table") {
      let n = 0;
      for (const r of b.rows) for (const c of r) out.push({ text: c.text, table: b.index, cell: n++ });
    }
  }
  return out;
}

/** The anchor phrase for a cell: the start of its first line, short enough to type fast. */
function anchorPhrase(text: string): string {
  const first = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (first.length <= 48) return first;
  const cut = first.slice(0, 48);
  const space = cut.lastIndexOf(" ");
  return space > 16 ? cut.slice(0, space) : cut;
}

export type CaretRoute =
  | {
      /** Find the phrase (occurrence N), caret BEFORE it, then Tab/Shift+Tab `tabs` times. */
      via: "cell";
      phrase: string;
      occurrence: number;
      anchor: CellAddress;
      tabs: number;
    }
  | {
      /** Find the phrase, caret AFTER it, ArrowRight `rights` times into cell 1, then Tab. */
      via: "before-table";
      phrase: string;
      occurrence: number;
      rights: number;
      tabs: number;
    }
  | {
      /** The table opens the document: Control+Home, ArrowRight past `rights` empty lines, then Tab. */
      via: "doc-start";
      rights: number;
      tabs: number;
    };

/**
 * Plan the keyboard route into `target`: anchor on the nearest cell whose
 * text the find bar can reach (fewest Tab presses), else on the paragraph
 * just before the table, else on the document start. Never a pixel.
 */
export function planCaretRoute(
  blocks: DocBlock[],
  tableIndex: number,
  target: CellAddress,
): { ok: true; route: CaretRoute } | { ok: false; error: string } {
  const table = docTables(blocks).find((t) => t.index === tableIndex);
  if (!table) {
    const n = docTables(blocks).length;
    return { ok: false, error: `the document has ${n} table(s); table ${tableIndex} does not exist` };
  }
  const goal = cellOrdinal(table, target);
  if (goal === null) {
    const shape = table.rows.map((r) => r.length).join("/");
    return {
      ok: false,
      error: `table ${tableIndex} has no cell r${target.row}c${target.col} (cells per row: ${shape})`,
    };
  }
  const segs = segments(blocks);
  let best: { phrase: string; occurrence: number; ordinal: number; anchor: CellAddress } | null = null;
  let ordinal = 0;
  table.rows.forEach((r, ri) =>
    r.forEach((c, ci) => {
      const phrase = anchorPhrase(c.text);
      const here = ordinal++;
      if (phrase.length < 2) return;
      const segIndex = segs.findIndex((s) => s.table === tableIndex && s.cell === here);
      const before = segs.slice(0, segIndex).reduce((s, x) => s + countMatches(x.text, phrase), 0);
      // The phrase is the start of the cell's first non-empty line, so the
      // first match inside the cell is the anchor itself.
      const cand = { phrase, occurrence: before + 1, ordinal: here, anchor: { row: ri + 1, col: ci + 1 } };
      if (!best || Math.abs(here - goal) < Math.abs(best.ordinal - goal)) best = cand;
    }),
  );
  if (best) {
    const b = best as { phrase: string; occurrence: number; ordinal: number; anchor: CellAddress };
    return {
      ok: true,
      route: { via: "cell", phrase: b.phrase, occurrence: b.occurrence, anchor: b.anchor, tabs: goal - b.ordinal },
    };
  }
  // An empty table: anchor on the last non-empty paragraph before it.
  const at = blocks.indexOf(table);
  let empties = 0;
  for (let i = at - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "para" && !b.text.trim()) {
      empties++;
      continue;
    }
    if (b.kind !== "para") break;
    const phrase = (() => {
      const line = b.text.split("\n").filter((l) => l.trim()).at(-1)!.trim();
      if (line.length <= 48) return line;
      const tail = line.slice(-48);
      const space = tail.indexOf(" ");
      return space >= 0 && space < 24 ? tail.slice(space + 1) : tail;
    })();
    // Occurrence of the phrase up to and including this paragraph's LAST
    // match (the phrase is the paragraph's tail).
    let occ = 0;
    for (const x of blocks.slice(0, i + 1)) {
      if (x.kind === "para") occ += countMatches(x.text, phrase);
      else if (x.kind === "table") for (const r of x.rows) for (const c of r) occ += countMatches(c.text, phrase);
    }
    return {
      ok: true,
      route: { via: "before-table", phrase, occurrence: Math.max(1, occ), rights: 1 + empties, tabs: goal },
    };
  }
  if (at === 0 || blocks.slice(0, at).every((b) => b.kind === "para" && !b.text.trim())) {
    return { ok: true, route: { via: "doc-start", rights: at, tabs: goal } };
  }
  return {
    ok: false,
    error: `table ${tableIndex} is empty and has no text paragraph before it to anchor on — type a word into one cell (click it once), then retry`,
  };
}
