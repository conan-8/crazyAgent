// Deterministic Google Docs operations — interface knowledge as executable
// code. A real 351-turn run kept re-deriving the same menu walks by pixel
// ("the menu shifted", "page numbers landed in the header again", "the crop
// missed the font box"); every one of those is a procedure a human does the
// same way every time. This module PLANS those procedures (pure, unit-tested);
// background/tools/docs-op.ts executes them with label-based content actions
// and trusted keystrokes — never coordinates.
//
// Plan shapes mirror the human route exactly:
//   keys         — a keyboard shortcut (Ctrl+Alt+1 for Heading 1)
//   menu         — walk menu rows by visible label (Insert ▸ Page numbers ▸ …)
//   dialog       — open a dialog by menu, fill its fields by label, confirm
//   menuThenKeys — open a picker by menu, drive it with arrows (table grid)
import { failureTag } from "./tool-failure";

export const DOCS_OPS = [
  "apply_style",
  "page_setup",
  "page_numbers",
  "insert_table",
] as const;
export type DocsOp = (typeof DOCS_OPS)[number];

/** One menu step: a label, or candidate labels to try in order. */
export type MenuLabel = string | string[];

/** One dialog field to fill, located by its label (aria-label/placeholder/
 *  associated <label>), never by position. */
export interface DialogFill {
  labels: MenuLabel;
  value?: string;
  kind: "text" | "select" | "radio";
}

/** How the executor proves the op landed — cheap, deterministic checks. */
export type VerifyPlan =
  | { check: "exportHtmlContains"; needle: string; describe: string }
  | { check: "toolbarStylesShows"; needle: string; describe: string }
  | { check: "dialogClosed"; name: string; describe: string };

export type DocsOpPlan =
  | { kind: "keys"; combos: string[]; describe: string; verify?: VerifyPlan }
  | { kind: "menu"; labels: MenuLabel[]; describe: string; verify?: VerifyPlan }
  | {
      kind: "dialog";
      open: MenuLabel[];
      fill: DialogFill[];
      confirm: MenuLabel;
      describe: string;
      verify?: VerifyPlan;
    }
  | {
      kind: "menuThenKeys";
      labels: MenuLabel[];
      combos: string[];
      describe: string;
      verify?: VerifyPlan;
    };

export type DocsOpPlanResult =
  | { ok: true; op: DocsOp; plan: DocsOpPlan }
  | { ok: false; error: string };

const inputError = (msg: string): DocsOpPlanResult => ({
  ok: false,
  error: `${failureTag("input")}: ${msg}`,
});

// ---------------- apply_style ----------------

/** Canonical paragraph-style names, from the aliases models actually write. */
const STYLE_ALIASES: Record<string, string> = {
  title: "Title",
  subtitle: "Subtitle",
  "normal text": "Normal text",
  normal: "Normal text",
  "body text": "Normal text",
  "heading 1": "Heading 1",
  "heading 2": "Heading 2",
  "heading 3": "Heading 3",
  "heading 4": "Heading 4",
  "heading 5": "Heading 5",
  "heading 6": "Heading 6",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  h4: "Heading 4",
  h5: "Heading 5",
  h6: "Heading 6",
};

export const STYLE_NAMES = [
  "Title",
  "Subtitle",
  "Normal text",
  "Heading 1",
  "Heading 2",
  "Heading 3",
  "Heading 4",
  "Heading 5",
  "Heading 6",
];

export function normalizeStyleName(raw: unknown): string | null {
  const s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return STYLE_ALIASES[s] ?? null;
}

/** Heading 1–6 have trusted shortcuts; Title/Subtitle/Normal go via the menu. */
export function styleShortcut(style: string): string | null {
  const m = /^Heading ([1-6])$/.exec(style);
  return m ? `Control+Alt+${m[1]}` : null;
}

// ---------------- page_setup margins ----------------

export interface Margins {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

/**
 * Margins arrive as one number/string (all four sides, inches — the value the
 * task almost always names: "1-inch margins") or as a per-side object. Strings
 * pass through verbatim ("0.5", "1"), so a locale's decimal comma survives.
 */
export function shapeMargins(raw: unknown): Margins | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const one = (v: unknown): string | null => {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v.trim()))) return v.trim();
    return null;
  };
  if (typeof raw === "number" || typeof raw === "string") {
    const v = one(raw);
    return v === null ? null : { top: v, right: v, bottom: v, left: v };
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const top = one(o.top);
    const right = one(o.right);
    const bottom = one(o.bottom);
    const left = one(o.left);
    if (top === null || right === null || bottom === null || left === null) return null;
    if (top === undefined || right === undefined || bottom === undefined || left === undefined) {
      return null;
    }
    return { top, right, bottom, left };
  }
  return null;
}

// ---------------- the planner ----------------

export function planDocsOp(opRaw: unknown, args: Record<string, unknown>): DocsOpPlanResult {
  const op = String(opRaw ?? "") as DocsOp;
  if (!(DOCS_OPS as readonly string[]).includes(op)) {
    return inputError(
      `docs_op needs op to be one of ${DOCS_OPS.join(", ")} (got '${String(opRaw ?? "")}')`,
    );
  }
  switch (op) {
    case "apply_style": {
      const style = normalizeStyleName(args.style);
      if (!style) {
        return inputError(
          `apply_style needs style to be one of: ${STYLE_NAMES.join(", ")} (aliases like 'h1' or 'normal' work)`,
        );
      }
      const shortcut = styleShortcut(style);
      if (shortcut) {
        const n = style.slice(-1);
        return {
          ok: true,
          op,
          plan: {
            kind: "keys",
            combos: [shortcut],
            describe: `apply ${style} at the caret (${shortcut})`,
            verify: {
              check: "exportHtmlContains",
              needle: `<h${n}`,
              describe: `the exported HTML shows an <h${n}>`,
            },
          },
        };
      }
      const htmlNeedle =
        style === "Title" ? 'class="title"' : style === "Subtitle" ? 'class="subtitle"' : null;
      return {
        ok: true,
        op,
        plan: {
          kind: "menu",
          labels: ["Format", "Paragraph styles", style],
          describe: `apply ${style} via Format ▸ Paragraph styles`,
          verify: htmlNeedle
            ? { check: "exportHtmlContains", needle: htmlNeedle, describe: `the exported HTML marks the paragraph as ${style.toLowerCase()}` }
            : { check: "toolbarStylesShows", needle: style, describe: `the toolbar's style box reads "${style}"` },
        },
      };
    }
    case "page_numbers": {
      const rawPos = String(args.position ?? "").toLowerCase();
      const footer = rawPos === "footer" || rawPos === "bottom";
      const header = rawPos === "header" || rawPos === "top";
      if (!footer && !header) {
        return inputError(`page_numbers needs position: 'footer' (bottom of page) or 'header' (top of page)`);
      }
      return {
        ok: true,
        op,
        plan: {
          kind: "menu",
          labels: [
            "Insert",
            "Page numbers",
            // The submenu rows are icon buttons; their accessible names carry
            // the position. Candidates hedge the exact wording.
            footer ? ["Bottom of page", "Footer"] : ["Top of page", "Header"],
          ],
          describe: `insert page numbers at the ${footer ? "bottom (footer)" : "top (header)"} via Insert ▸ Page numbers`,
        },
      };
    }
    case "page_setup": {
      const fill: DialogFill[] = [];
      const parts: string[] = [];
      if (args.size !== undefined && args.size !== null && args.size !== "") {
        if (typeof args.size !== "string") return inputError("page_setup size must be a string like 'Letter' or 'A4'");
        fill.push({ labels: ["Paper size", "Page size"], value: args.size, kind: "select" });
        parts.push(`size ${args.size}`);
      }
      if (args.orientation !== undefined && args.orientation !== null && args.orientation !== "") {
        const o = String(args.orientation).toLowerCase();
        if (o !== "portrait" && o !== "landscape") {
          return inputError(`page_setup orientation must be 'portrait' or 'landscape' (got '${String(args.orientation)}')`);
        }
        fill.push({ labels: [o === "portrait" ? "Portrait" : "Landscape"], kind: "radio" });
        parts.push(o);
      }
      const margins = shapeMargins(args.margins);
      if (margins === null) {
        return inputError(
          "page_setup margins must be a number of inches (applied to all four sides, e.g. 1) or an object {top, right, bottom, left}",
        );
      }
      if (margins) {
        fill.push(
          { labels: ["Top margin", "Top"], value: margins.top, kind: "text" },
          { labels: ["Bottom margin", "Bottom"], value: margins.bottom, kind: "text" },
          { labels: ["Left margin", "Left"], value: margins.left, kind: "text" },
          { labels: ["Right margin", "Right"], value: margins.right, kind: "text" },
        );
        parts.push(
          margins.top === margins.right && margins.top === margins.bottom && margins.top === margins.left
            ? `${margins.top}" margins`
            : `margins T${margins.top} R${margins.right} B${margins.bottom} L${margins.left}`,
        );
      }
      if (!fill.length) {
        return inputError("page_setup needs at least one of size, margins, orientation");
      }
      return {
        ok: true,
        op,
        plan: {
          kind: "dialog",
          open: ["File", "Page setup"],
          fill,
          confirm: ["OK", "Save"],
          describe: `set page setup (${parts.join(", ")}) via File ▸ Page setup`,
          verify: { check: "dialogClosed", name: "Page setup", describe: "the Page setup dialog closed on OK" },
        },
      };
    }
    case "insert_table": {
      const rows = args.rows;
      const cols = args.cols;
      const okDim = (v: unknown): v is number =>
        typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 20;
      if (!okDim(rows) || !okDim(cols)) {
        return inputError(
          `insert_table needs integer rows and cols in 1..20 (got rows=${String(rows)}, cols=${String(cols)})`,
        );
      }
      // The Insert ▸ Table grid picker is keyboard-drivable: arrows move the
      // highlighted size, Enter inserts. No pixel hunting for grid cells.
      const combos: string[] = [
        ...Array.from({ length: cols - 1 }, () => "ArrowRight"),
        ...Array.from({ length: rows - 1 }, () => "ArrowDown"),
        "Enter",
      ];
      return {
        ok: true,
        op,
        plan: {
          kind: "menuThenKeys",
          labels: ["Insert", "Table"],
          combos,
          describe: `insert a ${rows}×${cols} table via Insert ▸ Table + ${cols - 1} right / ${rows - 1} down + Enter`,
          verify: {
            check: "exportHtmlContains",
            needle: "<table",
            describe: "the exported HTML contains a <table>",
          },
        },
      };
    }
  }
}
