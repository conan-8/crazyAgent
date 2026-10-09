// `docs_table` — Google Docs tables by ADDRESS, not by pixel. The table body
// is canvas, so every cell move used to be a screenshot estimate; here the
// export says what the table is (shared/docs-structure.ts), the find bar plus
// Tab walks the caret into the cell, and the only pointer moves (cell-range
// selection) run between caret positions the editor itself reports.
import { failureTag } from "../../shared/tool-failure";
import {
  cellAt,
  cellOrdinal,
  docTables,
  parseDocStructure,
  planCaretRoute,
  type CellAddress,
  type DocBlock,
  type TableBlock,
} from "../../shared/docs-structure";
import {
  caretPoint,
  fetchWorkspaceExport,
  findBarCaret,
  parseWorkspaceUrl,
  readCaret,
  selectFromCaretTo,
  type CaretBox,
} from "./docs";
import { walkMenu } from "./docs-op";
import { captureBlindShot } from "./perception";
import { ensureTabActive, sendTrustedKey, sendTrustedText } from "./trusted-input";
import { registerTool, type ToolContext } from "./types";

const EXPORT_SETTLE_MS = 900;
const MAX_FILL_CELLS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const inputError = (msg: string) => ({ ok: false as const, error: `${failureTag("input")}: ${msg}` });

function address(raw: unknown, fallback?: CellAddress): CellAddress | null {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const row = Number(o.row);
    const col = Number(o.col);
    if (Number.isInteger(row) && Number.isInteger(col) && row >= 1 && col >= 1) return { row, col };
    return null;
  }
  return fallback ?? null;
}

async function readBlocks(ctx: ToolContext): Promise<{ ok: true; blocks: DocBlock[] } | { ok: false; error: string }> {
  const out = await fetchWorkspaceExport(ctx.tabId, "html");
  if (!out.ok) return out;
  if (out.doc.kind !== "document") return inputError("docs_table works on Google Docs documents");
  return { ok: true, blocks: parseDocStructure(out.body) };
}

async function press(ctx: ToolContext, combo: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await sendTrustedKey(ctx.tabId, ctx.adapter, combo);
}

/** Walk the caret into a cell by keyboard; `at` collapses it to the cell text's start or end. */
async function gotoCell(
  ctx: ToolContext,
  blocks: DocBlock[],
  table: number,
  cell: CellAddress,
  at: "start" | "end",
): Promise<{ ok: true; route: string } | { ok: false; error: string }> {
  const planned = planCaretRoute(blocks, table, cell);
  if (!planned.ok) return inputError(planned.error);
  const r = planned.route;
  await ensureTabActive(ctx.tabId, ctx.adapter);
  let route: string;
  if (r.via === "cell" || r.via === "before-table") {
    // The phrase came from a fresh export, so a second export read to count it is waste.
    // A cell anchor stays SELECTED and Home collapses it inside the cell: an
    // arrow key at a cell boundary can step out of the table (a probe saw a
    // whole fill land in the paragraph above).
    const found = await findBarCaret(ctx, r.phrase, r.occurrence, r.via === "cell" ? "select" : "after", {
      exportCount: false,
    });
    if (found.missing) return { ok: false, error: `${failureTag("tool")}: the caret route failed — ${found.missing}` };
    if (r.via === "cell") await press(ctx, "Home");
    if (r.via === "before-table") await press(ctx, "ArrowRight", r.rights);
    route =
      r.via === "cell"
        ? `found "${r.phrase}" (r${r.anchor.row}c${r.anchor.col})`
        : `found "${r.phrase}" before the table, ${r.rights}× →`;
  } else {
    await press(ctx, "Control+Home");
    await press(ctx, "ArrowRight", r.rights);
    route = "document start";
  }
  const tabs = r.tabs;
  if (tabs > 0) await press(ctx, "Tab", tabs);
  if (tabs < 0) await press(ctx, "Shift+Tab", -tabs);
  if (tabs) route += `, ${Math.abs(tabs)}× ${tabs > 0 ? "Tab" : "Shift+Tab"}`;
  await press(ctx, at === "start" ? "Home" : "End");
  return { ok: true, route };
}

function tableOf(blocks: DocBlock[], index: number): TableBlock | null {
  return docTables(blocks).find((t) => t.index === index) ?? null;
}

async function typeText(ctx: ToolContext, text: string): Promise<void> {
  await sendTrustedText(ctx.tabId, ctx.adapter, text);
}

/** Re-read the export (it trails the editor by a beat) until `check` passes or tries run out. */
async function verifyTable(
  ctx: ToolContext,
  index: number,
  check: (t: TableBlock) => string | null,
): Promise<string> {
  let last = "the table could not be read back";
  for (let i = 0; i < 2; i++) {
    await sleep(EXPORT_SETTLE_MS);
    const read = await readBlocks(ctx);
    if (!read.ok) return `unverified (${read.error})`;
    const t = tableOf(read.blocks, index);
    if (!t) {
      last = `table ${index} is not in the export`;
      continue;
    }
    const problem = check(t);
    if (!problem) return "verified";
    last = problem;
  }
  return `NOT VERIFIED: ${last}`;
}

/** Measured caret boxes for two cells: end cell first (so the view ends at the start cell). */
async function measureRange(
  ctx: ToolContext,
  blocks: DocBlock[],
  table: number,
  from: CellAddress,
  to: CellAddress,
): Promise<{ ok: true; end: CaretBox } | { ok: false; error: string }> {
  const toEnd = await gotoCell(ctx, blocks, table, to, "end");
  if (!toEnd.ok) return toEnd;
  const end = await readCaret(ctx);
  const fromStart = await gotoCell(ctx, blocks, table, from, "start");
  if (!fromStart.ok) return fromStart;
  if (!end) {
    return {
      ok: false,
      error: `${failureTag("tool")}: the editor exposes no caret position, so the cell range cannot be measured — the caret is in r${from.row}c${from.col}; drag_at from it to r${to.row}c${to.col} on a fresh screenshot`,
    };
  }
  return { ok: true, end };
}

registerTool({
  name: "docs_table",
  description:
    "Work a Google Docs table BY ADDRESS — no pixel aiming. Tables and cells are numbered as docs_read format:'outline' prints them (table 1 = first table; row/col 1-based; a merged cell counts once). The caret reaches a cell by keyboard (find bar on a cell's text + Tab), and cell ranges are selected by a drag between caret positions the editor reports. Ops: goto {table, cell:{row,col}, at:'start'|'end'} puts the caret in a cell — then type/key; fill {table, from:{row,col} (default 1,1), rows:[['A','B'],['1','2']]} writes a whole grid in ONE call (replacing single-line cell text; rows past the end are added by Tab) and reads it back; select {table, from, to, keys_after?:['Control+b']} selects a cell range (header row = from r1c1 to r1cN) and optionally formats it; merge {table, from, to} selects the range and runs Format ▸ Table ▸ Merge cells, verified from the export. Insert the table first with docs_op insert_table.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["goto", "fill", "select", "merge"] },
      table: { type: "number", description: "Which table, 1-based in document order (default 1)" },
      cell: {
        type: "object",
        description: "goto: the target cell {row, col}",
        properties: { row: { type: "number" }, col: { type: "number" } },
      },
      at: { type: "string", enum: ["start", "end"], description: "goto: caret at the start or end of the cell text (default end)" },
      from: {
        type: "object",
        description: "fill/select/merge: first cell {row, col}",
        properties: { row: { type: "number" }, col: { type: "number" } },
      },
      to: {
        type: "object",
        description: "select/merge: last cell {row, col} (inclusive)",
        properties: { row: { type: "number" }, col: { type: "number" } },
      },
      rows: {
        type: "array",
        description: "fill: row-major cell texts, e.g. [['Name','Score'],['Ada','9']] ('\\n' = new line inside a cell)",
        items: { type: "array", items: { type: "string" } },
      },
      keys_after: {
        type: "array",
        description: "select: shortcuts to press on the selection, e.g. ['Control+b']",
        items: { type: "string" },
      },
    },
    required: ["op"],
  },
  async run(args, ctx) {
    let url = "";
    try {
      url = (await chrome.tabs.get(ctx.tabId)).url ?? "";
    } catch {
      url = "";
    }
    if (parseWorkspaceUrl(url)?.kind !== "document") {
      return inputError(`docs_table works on a Google Docs document tab — this tab is ${url || "unknown"}`);
    }
    const op = String(args.op ?? "");
    const table = Number.isInteger(args.table) && (args.table as number) >= 1 ? (args.table as number) : 1;
    let read = await readBlocks(ctx);
    if (!read.ok) return { ok: false, error: read.error };
    if (!tableOf(read.blocks, table)) {
      // A table inserted a moment ago is often not in the export yet.
      await sleep(EXPORT_SETTLE_MS);
      read = await readBlocks(ctx);
      if (!read.ok) return { ok: false, error: read.error };
    }
    const blocks = read.blocks;
    const t = tableOf(blocks, table);
    if (!t) {
      const n = docTables(blocks).length;
      return inputError(
        n
          ? `the document has ${n} table(s); there is no table ${table}`
          : "the document has no table yet (or the export has not caught up) — insert one with docs_op insert_table, then retry",
      );
    }
    const shape = t.rows.map((r) => r.length).join("/");
    try {
      switch (op) {
        case "goto": {
          const cell = address(args.cell);
          if (!cell) return inputError("goto needs cell:{row, col} (1-based)");
          const at = args.at === "start" ? "start" : "end";
          const moved = await gotoCell(ctx, blocks, table, cell, at);
          if (!moved.ok) return moved;
          const box = await readCaret(ctx);
          return {
            op,
            table,
            cell,
            route: moved.route,
            ...(box ? { caretAt: caretPoint(box) } : {}),
            note: `the caret is at the ${at} of table ${table} r${cell.row}c${cell.col} ("${(cellAt(t, cell)?.text ?? "").slice(0, 40)}") — type / key now, no click.`,
          };
        }
        case "fill": {
          const from = address(args.from, { row: 1, col: 1 });
          if (!from) return inputError("fill needs from:{row, col} (1-based) or nothing (r1c1)");
          if (!Array.isArray(args.rows) || !args.rows.length || !args.rows.every((r) => Array.isArray(r))) {
            return inputError("fill needs rows: an array of rows, each an array of cell strings");
          }
          const rows = (args.rows as unknown[][]).map((r) => r.map((v) => String(v ?? "")));
          const total = rows.reduce((s, r) => s + r.length, 0);
          if (total > MAX_FILL_CELLS) return inputError(`fill takes at most ${MAX_FILL_CELLS} cells per call`);
          const lastCols = t.rows.at(-1)?.length ?? 1;
          const existingCells = t.rows.reduce((s, r) => s + r.length, 0);
          // Ordinal in the Tab walk, including rows that Tab will append.
          const ordinal = (a: CellAddress): number | null => {
            if (a.row <= t.rows.length) return cellOrdinal(t, a);
            if (a.col > lastCols) return null;
            return existingCells + (a.row - t.rows.length - 1) * lastCols + (a.col - 1);
          };
          const targets: { addr: CellAddress; ord: number; text: string }[] = [];
          for (const [i, r] of rows.entries()) {
            for (const [j, text] of r.entries()) {
              const addr = { row: from.row + i, col: from.col + j };
              const ord = ordinal(addr);
              if (ord === null) {
                return inputError(
                  `cell r${addr.row}c${addr.col} is outside table ${table} (cells per row: ${shape}) — fill adds rows, never columns`,
                );
              }
              targets.push({ addr, ord, text });
            }
          }
          const moved = await gotoCell(ctx, blocks, table, from, "end");
          if (!moved.ok) return moved;
          let cur = targets[0]!.ord;
          let typed = 0;
          for (const target of targets) {
            if (target.ord > cur) await press(ctx, "Tab", target.ord - cur);
            cur = target.ord;
            const existing = target.addr.row <= t.rows.length ? (cellAt(t, target.addr)?.text ?? "") : "";
            if (existing) {
              // Collapse whatever Tab selected to the line end, then select
              // back to its start: the typed value replaces the cell's line.
              await press(ctx, "End");
              await press(ctx, "Shift+Home");
              if (!target.text) await press(ctx, "Delete");
            }
            if (target.text) {
              await typeText(ctx, target.text);
              typed++;
            }
          }
          const multiLine = targets.filter(
            (x) => x.addr.row <= t.rows.length && (cellAt(t, x.addr)?.text ?? "").includes("\n"),
          );
          const verdict = await verifyTable(ctx, table, (now) => {
            const wrong = targets.filter((x) => {
              const got = (cellAt(now, x.addr)?.text ?? "").trim();
              return got !== x.text.trim();
            });
            if (!wrong.length) return null;
            const w = wrong[0]!;
            return `${wrong.length} cell(s) differ — first r${w.addr.row}c${w.addr.col}: expected "${w.text.slice(0, 30)}", reads "${(cellAt(now, w.addr)?.text ?? "∅").slice(0, 30)}"`;
          });
          // No export to check against: the screen is the only evidence of where the text went.
          const image = verdict.startsWith("unverified") ? await captureBlindShot(ctx.adapter, ctx.tabId) : undefined;
          return {
            op,
            table,
            from,
            cells: targets.length,
            typed,
            route: moved.route,
            verdict,
            ...(image ? { image } : {}),
            ...(multiLine.length
              ? { warning: `${multiLine.length} target cell(s) held multi-line text; only their last line was replaced` }
              : {}),
          };
        }
        case "select":
        case "merge": {
          const from = address(args.from);
          const to = address(args.to);
          if (!from || !to) return inputError(`${op} needs from:{row,col} and to:{row,col}`);
          if (cellOrdinal(t, from) === null || cellOrdinal(t, to) === null) {
            return inputError(`table ${table} has no such cell (cells per row: ${shape})`);
          }
          const measured = await measureRange(ctx, blocks, table, from, to);
          if (!measured.ok) return measured;
          const sel = await selectFromCaretTo(ctx, measured.end, "drag");
          if (!sel.ok) return { ok: false, error: `${failureTag("tool")}: ${sel.error}` };
          if (op === "select") {
            const keys = Array.isArray(args.keys_after) ? args.keys_after.map(String).slice(0, 6) : [];
            for (const k of keys) await press(ctx, k);
            const image = await captureBlindShot(ctx.adapter, ctx.tabId);
            return {
              op,
              table,
              from,
              to,
              dragged: { from: sel.from, to: sel.to },
              ...(keys.length ? { keys } : {}),
              ...(image ? { image } : {}),
              note: `cells r${from.row}c${from.col}…r${to.row}c${to.col} are selected${keys.length ? ` and ${keys.join(", ")} applied` : ""}${image ? " — the attached screenshot shows the selection" : ""}; verify formatting with docs_read format:'outline'.`,
            };
          }
          const walked = await walkMenu(ctx, ["Format", "Table", ["Merge cells", "Merge"]]);
          if (!walked.ok) {
            return {
              ok: false,
              error: `${failureTag("tool")}: the range is selected but Format ▸ Table ▸ Merge cells failed (${walked.error}) — right-click the selection (click_at button:'right' at ${sel.to.x},${sel.to.y}) ▸ Merge cells`,
            };
          }
          const rowsSpan = Math.abs(to.row - from.row) + 1;
          const colsSpan = Math.abs(to.col - from.col) + 1;
          const verdict = await verifyTable(ctx, table, (now) => {
            const c = cellAt(now, { row: Math.min(from.row, to.row), col: Math.min(from.col, to.col) });
            if (!c) return "the merged cell is missing";
            return c.colspan >= colsSpan && c.rowspan >= rowsSpan
              ? null
              : `the top-left cell spans ${c.rowspan}×${c.colspan}, expected ${rowsSpan}×${colsSpan}`;
          });
          return { op, table, from, to, menu: walked.steps, verdict };
        }
        default:
          return inputError(`docs_table op must be goto, fill, select or merge (got '${op}')`);
      }
    } catch (err) {
      return {
        ok: false,
        error: `${failureTag("transport")}: docs_table could not drive the editor (${String((err as Error)?.message ?? err)}) — check page_health, then retry once`,
      };
    }
  },
  present(payload) {
    const p = (payload ?? {}) as Record<string, unknown>;
    const cell = (a: unknown): string => {
      const c = a as CellAddress | undefined;
      return c ? `r${c.row}c${c.col}` : "?";
    };
    switch (p.op) {
      case "goto": {
        const at = p.caretAt as { x: number; y: number } | undefined;
        return { text: `caret in table ${p.table} ${cell(p.cell)}${at ? ` at (${at.x},${at.y})` : ""} via ${p.route}. ${p.note ?? ""}` };
      }
      case "fill":
        return {
          text: `filled ${p.cells} cell(s) of table ${p.table} from ${cell(p.from)} (${p.typed} typed) — ${p.verdict}${p.warning ? ` · ${p.warning}` : ""}${typeof p.image === "string" ? " — the attached screenshot shows the table now; check every value sits in its cell" : ""}`,
          ...(typeof p.image === "string" ? { image: p.image } : {}),
        };
      case "select":
        return { text: String(p.note ?? "selected"), ...(typeof p.image === "string" ? { image: p.image } : {}) };
      case "merge":
        return { text: `merged table ${p.table} ${cell(p.from)}…${cell(p.to)} via ${(p.menu as string[] | undefined)?.join(" ▸ ") ?? "menu"} — ${p.verdict}` };
      default:
        return { text: JSON.stringify(p) };
    }
  },
});
