// Google Workspace document tools — reading a Doc/Sheet WITHOUT leaving the
// page.
//
// Why this exists: a canvas editor's body is unreadable to every DOM tool, so
// the skill's old route was to navigate the tab to /mobilebasic or /preview,
// or to fetch the export URL from page context via evaluate_js. All three are
// turn-sinks and fragile: navigation abandons the editor's live state (and
// the run has to find its way back), the in-page fetch dies with the debugger
// transport (a real run logged eight TRANSPORT-FAILED turns), and Google's
// Trusted Types policy blocks the DOMParser the fetched HTML needs (four more
// wasted turns). The service worker can fetch the SAME export endpoint
// directly — host permissions attach the session cookies — with no page
// context, no debugger and no navigation involved. One call, plain result.
//
// This file is the read path; deterministic Docs operations (menu walks,
// verified effects) land here too as they are built.
import { failureTag } from "../../shared/tool-failure";
import { planClick, planDrag } from "../../shared/coords";
import { docTables, formatOutline, parseDocStructure } from "../../shared/docs-structure";
import { countPhrase, parseFindCounter } from "../../shared/docs-ops";
import { runContentAction } from "./content-action";
import { sendStrokes } from "./coords";
import { captureBlindShot, layoutViewportCss, truncateWithNote } from "./perception";
import { ensureTabActive, sendTrustedKey, sendTrustedText } from "./trusted-input";
import { registerTool, type ToolContext } from "./types";
import type { SelectorBox } from "../../content/actions";

/** What the current tab's URL says about the document, when it is one. */
interface WorkspaceDoc {
  kind: "document" | "spreadsheet" | "presentation";
  id: string;
  /** Export formats that produce TEXT the model can read. */
  formats: Record<string, string>;
}

const DEFAULT_MAX_CHARS = 16_000;

/**
 * Parse a Google Workspace editor URL into the document's export identity.
 * Accepts the /edit, /preview and bare /d/<id> forms; ignores query/hash.
 * Slides parse but carry no text export — the tool says so with the routes
 * that DO work on a deck (screenshot; the speaker-notes pane is DOM).
 */
export function parseWorkspaceUrl(url: string): WorkspaceDoc | null {
  const m = /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/.exec(
    url,
  );
  if (!m) return null;
  const [, kindWord, id] = m as unknown as [string, string, string];
  switch (kindWord) {
    case "document":
      return {
        kind: "document",
        id,
        formats: { text: "txt", html: "html", rtf: "rtf" },
      };
    case "spreadsheets":
      return {
        kind: "spreadsheet",
        id,
        formats: { text: "csv", html: "html", tsv: "tsv" },
      };
    case "presentation":
      return { kind: "presentation", id, formats: {} };
  }
  return null;
}

/** The export endpoint for one format of one doc. */
export function exportUrl(doc: WorkspaceDoc, formatKey: string): string | null {
  const fmt = doc.formats[formatKey];
  if (!fmt) return null;
  const word =
    doc.kind === "document"
      ? "document"
      : doc.kind === "spreadsheet"
        ? "spreadsheets"
        : "presentation";
  return `https://docs.google.com/${word}/d/${doc.id}/export?format=${fmt}`;
}

/**
 * Fetch one text export of the CURRENT tab's document from the service
 * worker. Shared by `docs_read` (the model-facing tool) and `docs_op`'s
 * verification checks — one authenticated route, immune to the page's
 * Trusted Types policy and to the debugger transport that the old
 * page-context export fetch kept dying on.
 */
export async function fetchWorkspaceExport(
  tabId: number,
  format: "text" | "html",
): Promise<{ ok: true; body: string; doc: WorkspaceDoc } | { ok: false; error: string }> {
  let url = "";
  try {
    url = (await chrome.tabs.get(tabId)).url ?? "";
  } catch {
    return { ok: false, error: `${failureTag("input")}: could not read the tab's URL` };
  }
  const doc = parseWorkspaceUrl(url);
  if (!doc) {
    return {
      ok: false,
      error: `${failureTag("input")}: docs_read works on a Google Docs/Sheets/Slides tab — this tab is ${url || "unknown"}. For ordinary pages use read_page / snapshot; never navigate away from a document just to read it.`,
    };
  }
  if (doc.kind === "presentation") {
    return {
      ok: false,
      error: `${failureTag("input")}: Slides decks have no text export — read a deck visually (screenshot, optionally zoom crops); its outline/speaker-notes panes are ordinary DOM (snapshot/read_page) when open.`,
    };
  }
  const target = exportUrl(doc, format);
  if (!target) {
    return { ok: false, error: `${failureTag("input")}: no ${format} export for this document type` };
  }
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      // SW-side fetch: host permissions attach the session cookies, so this
      // is the SAME authenticated export the page-context fetch attempted —
      // without the page context (Trusted Types) or the debugger (transport).
      res = await fetch(target, { credentials: "include", redirect: "follow" });
    } catch (err) {
      return {
        ok: false,
        error: `${failureTag("transport")}: the export fetch failed (${String((err as Error)?.message ?? err)}) — the network or the session refused it; retry once, then fall back to reading visually (screenshot)`,
      };
    }
    // Measured: about ten export reads a minute draw a 429. A short wait
    // clears it, so the harness waits instead of handing the model a failure
    // it would only retry immediately.
    if ((res.status !== 429 && res.status !== 503) || attempt >= EXPORT_RETRIES) break;
    await sleep(exportRetryDelayMs(res.headers.get("retry-after"), attempt));
  }
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? "the signed-in account cannot export this document (permission or sign-in state) — check the account chip; do not retry"
        : res.status === 404
          ? "no such document (wrong id, moved or deleted)"
          : res.status === 429 || res.status === 503
            ? `Google is rate-limiting document exports (${res.status}, still refused after ${EXPORT_RETRIES} waits) — do NOT re-read now: keep working and read once at the end of the block, or check the screen with a screenshot`
            : `export endpoint returned ${res.status}`;
    return { ok: false, error: `${failureTag("tool")}: ${hint}` };
  }
  return { ok: true, body: await res.text(), doc };
}

const EXPORT_RETRIES = 2;

/** How long to wait before re-asking a rate-limited export: Retry-After (capped), else a growing backoff. */
export function exportRetryDelayMs(retryAfter: string | null, attempt: number): number {
  const secs = retryAfter !== null && /^\s*\d+(\.\d+)?\s*$/.test(retryAfter) ? Number(retryAfter) : NaN;
  if (Number.isFinite(secs)) return Math.min(5_000, Math.max(250, Math.round(secs * 1000)));
  return 1_200 * (attempt + 1);
}

registerTool({
  name: "docs_read",
  description:
    "Read the CURRENT Google Doc's (or Sheet's) content in ONE call — without navigating away, without in-page JavaScript and without the debugger, so it works even when evaluate_js/export fetches fail. format:'text' (default) returns the plain content; format:'outline' (the best default for editing work) returns ONE LINE PER BLOCK with its style and formatting marks — TITLE:/H1:/P:, • list items, **bold** *italic* __underline__ [link](url), page breaks, and every TABLE as an addressable grid (r1: a | b, merged cells flagged) — compact, and exactly what docs_table row/col refer to; format:'html' returns the raw exported HTML (fonts, colors, sizes) when a task grades something the outline does not show. The tab must be on docs.google.com; pass max_chars to cap long documents (truncation is noted). For Slides decks there is no text export — screenshot the deck instead. NEVER navigate to /preview or /mobilebasic to read a doc; this call replaces that.",
  parameters: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["text", "outline", "html"],
        description: "'text' = plain content (default); 'outline' = styled blocks + table grids; 'html' = raw formatting evidence",
      },
      max_chars: {
        type: "number",
        description: `Cap on returned characters (default ${DEFAULT_MAX_CHARS})`,
      },
    },
  },
  async run(args, ctx) {
    const format = args.format === "html" || args.format === "outline" ? args.format : "text";
    const maxChars =
      typeof args.max_chars === "number" && args.max_chars > 0
        ? Math.min(args.max_chars, 100_000)
        : DEFAULT_MAX_CHARS;
    const fetched = await fetchWorkspaceExport(ctx.tabId, format === "text" ? "text" : "html");
    if (!fetched.ok) return { ok: false, error: fetched.error };
    let body = fetched.body;
    if (format === "outline") {
      if (fetched.doc.kind !== "document") {
        return { ok: false, error: `${failureTag("input")}: outline reads Google Docs documents; use format:'text' for a Sheet` };
      }
      const blocks = parseDocStructure(fetched.body);
      const tables = docTables(blocks).length;
      body = `${formatOutline(blocks)}${tables ? `\n(${tables} table(s) — docs_table addresses cells as table/row/col from this grid)` : ""}`;
    }
    const content = truncateWithNote(body, maxChars, "docs_read");
    return {
      format,
      kind: fetched.doc.kind,
      chars: body.length,
      returned: content.length,
      content,
    };
  },
  present(payload) {
    const p = (payload ?? {}) as { format?: string; chars?: number; content?: string };
    return {
      text: `--- document content (${p.format}, ${p.chars} chars total) ---\n${p.content ?? ""}`,
    };
  },
});

/**
 * One best-effort DOM read: try selector candidates in order, return the
 * first that resolves. Version drift changes Google's class names, so every
 * field carries several hooks (aria-label first — those are the accessibility
 * contract Google keeps stable — legacy kix classes as fallback).
 */
async function readField(
  ctx: ToolContext,
  selectors: string[],
): Promise<{ text?: string; value?: string; pressed?: string } | null> {
  for (const selector of selectors) {
    const res = await runContentAction(ctx.tabId, { action: "queryText", selector }).catch(
      () => null,
    );
    if (res?.ok && res.data) {
      const d = res.data as { text?: string; value?: string; pressed?: string };
      if (d.text || d.value || d.pressed) return d;
    }
  }
  return null;
}

registerTool({
  name: "docs_state",
  description:
    "Read the Google Docs editor's CURRENT state in one call, from the DOM chrome around the canvas: document title, applied paragraph style, font, size, bold/italic/underline toggle states, editing mode, and whether a dialog is open. This is the ground truth a screenshot can only imply — use it to VERIFY formatting actions (style applied? bold on?) instead of re-looking, and to check state before acting. Fields the DOM does not expose come back listed as unreadable, honestly. Read-only and cheap; never navigates, never touches the debugger.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    const read: Record<string, string> = {};
    const unreadable: string[] = [];
    const put = (name: string, got: string | undefined | null): void => {
      if (got === undefined || got === null || got === "") unreadable.push(name);
      else read[name] = got;
    };
    const title = await readField(ctx, ['input[aria-label="Document title"]']);
    put("title", title?.value || title?.text);
    const style = await readField(ctx, ['[aria-label^="Styles"]', ".kix-paragraphstyles-combobox"]);
    put("paragraphStyle", style?.text);
    const font = await readField(ctx, [
      '[aria-label="Font"]',
      '[aria-label^="Font family"]',
      ".kix-fontfamily-combobox",
    ]);
    put("font", font?.text);
    const size = await readField(ctx, ['[aria-label^="Font size"]', ".kix-fontsize-combobox"]);
    put("fontSize", size?.text);
    for (const toggle of ["Bold", "Italic", "Underline"]) {
      const got = await readField(ctx, [`[aria-label^="${toggle}"]`, `[data-tooltip="${toggle}"]`]);
      put(
        toggle.toLowerCase(),
        got?.pressed === undefined || got?.pressed === null
          ? undefined
          : got.pressed === "true"
            ? "on"
            : "off",
      );
    }
    const mode = await readField(ctx, ['[aria-label^="Mode"]']);
    put("editingMode", mode?.text);
    const dialog = await readField(ctx, ['[role="dialog"]']);
    read.dialogOpen = dialog ? `yes ("${(dialog.text ?? "").slice(0, 60)}")` : "no";
    return { read, ...(unreadable.length ? { unreadable } : {}) };
  },
  present(payload) {
    const p = (payload ?? {}) as { read?: Record<string, string>; unreadable?: string[] };
    const parts = Object.entries(p.read ?? {}).map(([k, v]) => `${k}: ${v}`);
    const miss = p.unreadable?.length ? ` (unreadable: ${p.unreadable.join(", ")})` : "";
    return { text: `docs state — ${parts.join(" · ")}${miss}` };
  },
});

/** The text caret's box (top-viewport CSS px) plus the editor's scroll offset. */
export interface CaretBox {
  x: number;
  y: number;
  width: number;
  height: number;
  scrollTop: number;
  source: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read where the caret is. The caret blinks and re-layouts after a move, so
 * a few short polls; null when the editor exposes no caret element at all
 * (the keyboard routes still work — only the measured-pointer moves need it).
 * Pass `tries: 1` where a missing caret just means "cannot verify" and the
 * four-poll wait would be pure cost.
 */
export async function readCaret(ctx: ToolContext, tries = 4): Promise<CaretBox | null> {
  for (let i = 0; i < tries; i++) {
    const res = await runContentAction(ctx.tabId, { action: "caretRect" }).catch(() => null);
    const box = res?.ok ? (res.data as CaretBox | null) : null;
    if (box && box.height > 0) return box;
    if (i + 1 < tries) await sleep(120);
  }
  return null;
}

/** A caret box as the point a click should hit to land on that exact boundary. */
export function caretPoint(box: CaretBox, scrollNow = box.scrollTop): { x: number; y: number } {
  return {
    x: Math.round(box.x + Math.max(1, box.width) / 2),
    y: Math.round(box.y + box.height / 2 + (box.scrollTop - scrollNow)),
  };
}

export interface FindBarResult {
  /** The counter as the find bar shows it ("2 of 5"), when readable. */
  matches?: string;
  /** Total matches, and where that number came from; absent = unknown. */
  total?: number;
  countSource?: "find bar" | "export";
  image?: string;
  /** Set when the requested occurrence does not exist — nothing was selected. */
  missing?: string;
  /** Set when the caret had to be placed by Home/End because the match sits on
   *  a cell or line edge, where an arrow key would have left it. */
  repaired?: boolean;
  /** Set when Control+f never produced a find bar, so nothing was typed. */
  barNeverOpened?: boolean;
}

/**
 * The find bar's own search field.
 *
 * Measured by probe v10 S2 on a live Doc: while the bar is open, focus is on
 * `input[aria-label="Find in document"]` inside `[class*="FindbarFindInputContainer"]`;
 * once it closes, no find-classed element is laid out at all and focus returns
 * to the offscreen typing sink. The element IDS in that dump (`c9`, `elptr_8`,
 * `avWBGd-12`) are generated per session and must never be used.
 */
const FIND_INPUT_SELECTORS = [
  'input[aria-label="Find in document"]',
  '[class*="FindbarFindInputContainer"] input',
  '[class*="FindBarContainer"] input',
];

/** Is the find bar's search field on screen right now? */
async function findBarIsOpen(ctx: ToolContext): Promise<boolean> {
  const res = await runContentAction(ctx.tabId, {
    action: "boxes",
    selectors: FIND_INPUT_SELECTORS,
  }).catch(() => null);
  const boxes = res?.ok ? ((res.data as { boxes?: SelectorBox[] } | undefined)?.boxes ?? []) : [];
  return boxes.length > 0;
}

/**
 * Open the find bar and PROVE it opened before anything is typed into it.
 *
 * `sendTrustedText` sends real keystrokes to whatever holds focus. On a canvas
 * editor with a live selection that REPLACES the selection — so if Control+f is
 * swallowed (a menu, dialog or toolbar dropdown holding focus, a page still
 * loading) the search phrase is typed straight into the document. A 2026-10-10
 * run lost a paragraph exactly that way: it came back as the very phrase
 * `docs_locate` had been asked to find, and an undo made it strictly worse,
 * which is what proves the phrase had been inserted rather than the text merely
 * hidden. Typing nothing and reporting the miss is always the cheaper outcome.
 */
async function openFindBar(ctx: ToolContext): Promise<boolean> {
  await sendTrustedKey(ctx.tabId, ctx.adapter, "Control+f");
  for (let i = 0; i < 10; i++) {
    if (await findBarIsOpen(ctx)) return true;
    await sleep(150);
  }
  // Leave no half-open popup behind before handing the failure back.
  await sendTrustedKey(ctx.tabId, ctx.adapter, "Escape");
  return false;
}

/** What to tell the model when the bar never appeared. */
const FIND_BAR_MISSING =
  `${failureTag("tool")}: the find bar did not open, so NOTHING was typed and the document is unchanged — ` +
  `Control+f was swallowed, which means a menu, dialog or toolbar dropdown is holding focus (or the page is still loading). ` +
  `Press Escape or click into the document body, then retry.`;

/** Total matches for `phrase`: the find bar's counter, else a count over the text export. */
async function findTotal(
  ctx: ToolContext,
  phrase: string,
  exportCount: boolean,
): Promise<{ total: number; source: "find bar" | "export"; text?: string } | null> {
  const res = await runContentAction(ctx.tabId, { action: "findTexts" }).catch(() => null);
  const texts = res?.ok ? ((res.data as { texts?: string[] } | undefined)?.texts ?? []) : [];
  const counted = parseFindCounter(texts);
  if (counted) {
    const text = texts.find((t) => parseFindCounter([t]));
    return { total: counted.total, source: "find bar", ...(text ? { text } : {}) };
  }
  if (!exportCount) return null;
  const out = await fetchWorkspaceExport(ctx.tabId, "text");
  return out.ok ? { total: countPhrase(out.body, phrase), source: "export" } : null;
}

/**
 * Two carets on the same text line? Compared in document space (viewport y plus
 * the editor's scroll), so a scroll between the two reads cannot fake a move.
 */
export function sameLine(a: CaretBox, b: CaretBox): boolean {
  return Math.abs(a.y + a.scrollTop - (b.y + b.scrollTop)) <= Math.max(2, Math.min(a.height, b.height) / 2);
}

/**
 * Did ONE arrow key move the caret further than a character? Only a cell edge
 * does that on a single step, so this is the sideways escape `sameLine` cannot
 * see. The threshold rides the caret height (a font-size proxy) rather than a
 * fixed px: measured, stepping out of a second-column cell jumped 134px with a
 * 17px caret, while the widest ordinary character is well under 1.5× its size.
 */
export function crossedCell(a: CaretBox, b: CaretBox): boolean {
  return Math.abs(a.x - b.x) > Math.max(12, 1.5 * Math.min(a.height, b.height));
}

/** Re-open the find bar on `phrase` and leave the match selected. False if the
 *  bar never opened — in which case nothing was typed anywhere. */
async function selectMatch(ctx: ToolContext, phrase: string, occurrence: number): Promise<boolean> {
  const { tabId, adapter } = ctx;
  if (!(await openFindBar(ctx))) return false;
  await sendTrustedText(tabId, adapter, phrase);
  for (let i = 1; i < occurrence; i++) {
    await sendTrustedKey(tabId, adapter, "Enter");
  }
  await sleep(250);
  await sendTrustedKey(tabId, adapter, "Escape");
  return true;
}

/**
 * Collapse the find bar's selection to the match's start (`before`) or end
 * (`after`) without letting the caret leave a table cell.
 *
 * An arrow key at a cell's edge steps OUT of the cell: with the match at the
 * start of a first-column cell, Escape+ArrowLeft was measured to put the caret
 * in the paragraph above the table, and at the start of a second-column cell it
 * put the caret at the end of the cell to its left — the next `type` wrote
 * there either time. Stepping BACK always undoes that (it returns the caret to
 * the match edge it fell off), so the collapse is one arrow, one step back, and
 * a comparison of the two caret reads:
 *
 *   same line, one character apart — no edge was crossed: step toward again.
 *   same line, a jump wider than a character — a sideways cell escape: the
 *     step back is already the match edge, so stop there.
 *   a different line — either a vertical cell escape (the step back is right)
 *     or a match that begins at a wrapped line's end (stepping toward was
 *     right). Home/End cannot leave a cell, so re-select and press one: its
 *     line says which of the two it was.
 *
 * The common case pays one extra arrow and two caret reads.
 *
 * KNOWN GAP: a sideways step into a NEARLY FULL neighbouring cell can be
 * shorter than a wide character, so it stays invisible — which is why the tool
 * description steers table edits towards docs_table, whose cell route never
 * collapses with an arrow at all.
 */
export async function collapseToMatch(
  ctx: ToolContext,
  phrase: string,
  occurrence: number,
  side: "before" | "after",
): Promise<boolean> {
  const { tabId, adapter } = ctx;
  const toward = side === "before" ? "ArrowLeft" : "ArrowRight";
  const away = side === "before" ? "ArrowRight" : "ArrowLeft";
  await sleep(80);
  await sendTrustedKey(tabId, adapter, toward);
  // One read, not the polling one: an editor that exposes no caret gets exactly
  // the old behaviour (a single arrow) instead of paying for polls twice.
  const at = await readCaret(ctx, 1);
  if (!at) return false;
  // One step back: if that crosses a line boundary, `toward` had landed on a
  // cell/line edge — the only places an arrow can leave the match's own line.
  await sendTrustedKey(tabId, adapter, away);
  const stepped = await readCaret(ctx, 1);
  if (!stepped) {
    await sendTrustedKey(tabId, adapter, toward);
    return false;
  }
  if (sameLine(at, stepped)) {
    // A sideways cell escape: the step back already returned the caret to the
    // match edge, and stepping toward again would push it out of the cell once
    // more. Otherwise the two reads are one character apart, so the step toward
    // is what lands the caret on the edge that was asked for — without it every
    // caret mode ends up one character inside the match.
    if (crossedCell(at, stepped)) return true;
    await sendTrustedKey(tabId, adapter, toward);
    return false;
  }
  if (!(await selectMatch(ctx, phrase, occurrence))) return false;
  // Cell-safe: Home/End stay inside the cell, and at a cell edge they ARE the
  // match's edge — which is the case that made the arrow leave the table.
  await sendTrustedKey(tabId, adapter, side === "before" ? "Home" : "End");
  if (side === "after") return true;
  const edge = await readCaret(ctx, 1);
  if (edge && sameLine(edge, stepped)) return true;
  // The match begins at a wrapped line's end: Home overshot to that line's
  // start, so walk back to its last character.
  await sendTrustedKey(tabId, adapter, "End");
  await sleep(60);
  await sendTrustedKey(tabId, adapter, "ArrowLeft");
  return true;
}

/**
 * The find-bar move: Ctrl+F, type the phrase, Enter to the occurrence, then
 * (with a caret mode) Escape — which hands focus back to the document with
 * the match selected — and collapse it by arrow key. A phrase that is not
 * there is reported as `missing` with NOTHING selected: closing a find bar
 * with no match leaves the old caret in place, and the caller's next
 * keystroke would land there (a probe saw Backspace eat the document's last
 * letter after a no-match "select"). Throws on a dead debugger channel.
 */
export async function findBarCaret(
  ctx: ToolContext,
  phrase: string,
  occurrence: number,
  caret: "before" | "after" | "select" | undefined,
  opts: { keepOpen?: boolean; shot?: boolean; exportCount?: boolean } = {},
): Promise<FindBarResult> {
  await ensureTabActive(ctx.tabId, ctx.adapter);
  if (!(await openFindBar(ctx))) return { missing: FIND_BAR_MISSING, barNeverOpened: true };
  await sendTrustedText(ctx.tabId, ctx.adapter, phrase);
  for (let i = 1; i < occurrence; i++) {
    await sendTrustedKey(ctx.tabId, ctx.adapter, "Enter");
  }
  // Let the app scroll to the match and paint the highlight.
  await sleep(opts.shot ? 400 : 250);
  const found = await findTotal(ctx, phrase, opts.exportCount !== false);
  const counted = found
    ? { total: found.total, countSource: found.source, ...(found.text ? { matches: found.text } : {}) }
    : {};
  if (found && occurrence > found.total) {
    await sendTrustedKey(ctx.tabId, ctx.adapter, "Escape");
    if (found.total > 0) {
      // The bar wrapped onto an earlier match, which Escape just selected —
      // collapse it so the next keystroke cannot replace the wrong text.
      await sleep(80);
      await sendTrustedKey(ctx.tabId, ctx.adapter, "ArrowLeft");
    }
    return {
      ...counted,
      missing:
        found.total === 0
          ? `"${phrase}" is not in the document (${found.source === "find bar" ? "the find bar counts 0 matches" : "0 matches in the text export, which can trail typing from the last second or two"}) — NOTHING was selected and the caret did not move`
          : `"${phrase}" has only ${found.total} match(es), so occurrence ${occurrence} does not exist — nothing is selected (the caret is now just BEFORE an earlier match)`,
    };
  }
  const image = opts.shot ? await captureBlindShot(ctx.adapter, ctx.tabId) : undefined;
  if (caret || !opts.keepOpen) await sendTrustedKey(ctx.tabId, ctx.adapter, "Escape");
  const repaired =
    caret === "before" || caret === "after"
      ? await collapseToMatch(ctx, phrase, occurrence, caret)
      : false;
  return { ...counted, ...(repaired ? { repaired } : {}), ...(image ? { image } : {}) };
}

/** Bring a recorded point into view by wheel-scrolling the editor; returns the point now. */
export async function bringIntoView(
  ctx: ToolContext,
  target: CaretBox,
): Promise<{ x: number; y: number } | null> {
  const vp = await layoutViewportCss(ctx.tabId, ctx.adapter);
  const height = vp?.height ?? 800;
  for (let i = 0; i < 3; i++) {
    const now = await readCaret(ctx);
    const scrollNow = now?.scrollTop ?? target.scrollTop;
    const p = caretPoint(target, scrollNow);
    if (p.y > 40 && p.y < height - 20) return p;
    const at = { x: Math.round((vp?.width ?? 1000) / 2), y: Math.round(height / 2) };
    await ctx.adapter.send(ctx.tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: at.x,
      y: at.y,
      deltaX: 0,
      deltaY: Math.round(p.y - height / 2),
    });
    await sleep(250);
  }
  return null;
}

/**
 * Extend the selection from the caret to a recorded caret box — the measured
 * pointer move: a drag from the caret's own point (cell ranges) or a
 * shift+click (text spans). No pixel is ever estimated from an image.
 */
export async function selectFromCaretTo(
  ctx: ToolContext,
  target: CaretBox,
  mode: "drag" | "shift",
): Promise<{ ok: true; from?: { x: number; y: number }; to: { x: number; y: number } } | { ok: false; error: string }> {
  const to = await bringIntoView(ctx, target);
  if (!to) return { ok: false, error: "the end point could not be scrolled into view" };
  if (mode === "shift") {
    await sendStrokes(ctx, planClick(to, "left", 1, 8));
    return { ok: true, to };
  }
  const here = await readCaret(ctx);
  if (!here) return { ok: false, error: "the caret position became unreadable before the drag" };
  const from = caretPoint(here);
  await sendStrokes(ctx, planDrag(from, to, 10));
  return { ok: true, from, to };
}

registerTool({
  name: "docs_locate",
  description:
    "Jump to a phrase inside a Google Doc/Sheet/Slide using the app's OWN find bar — the human move for deep-document navigation: opens Ctrl+F, types the phrase (the app highlights every match), presses Enter to reach the requested occurrence, and ATTACHES A SCREENSHOT of the match in view. TO EDIT AT A PHRASE, pass caret:'before'|'after'|'select': closing the find bar leaves the match selected and the tool collapses it by arrow key — the caret lands exactly at the text with NO pixel aiming (inside a TABLE use docs_table instead — 'before'/'after' collapse with an arrow key, which at a cell's edge steps OUT of the table, and the text lands in the paragraph above it); type right away (insert after a heading = caret:'after' then key Enter + type; replace a phrase = caret:'select', then type — the typing replaces the selection; format a phrase = caret:'select' then key Control+b). TO SELECT A SPAN (a sentence, a paragraph, several paragraphs) pass through:'<last words of the span>': the selection runs from the START of phrase to the END of through, measured from the editor's own caret — then type to replace it, or press a format shortcut. A phrase that is not in the document FAILS with nothing selected. The result reports caretAt (viewport px) when the editor exposes its caret. occurrence:2 = the second match. Use this instead of scrolling-and-hunting, counting lines, or clicking on canvas text.",
  parameters: {
    type: "object",
    properties: {
      phrase: {
        type: "string",
        description: "Exact text to find (the app matches literally, case-insensitive)",
      },
      occurrence: {
        type: "number",
        description: "Which match to jump to, 1-based (default 1)",
      },
      close: {
        type: "boolean",
        description: "Close the find bar afterwards (default true; scroll stays at the match)",
      },
      caret: {
        type: "string",
        enum: ["before", "after", "select"],
        description:
          "Place the caret by KEYBOARD at the match: 'before' / 'after' collapse to its start / end, 'select' leaves the match selected (type to replace it, or press a format shortcut). Then act immediately — no click.",
      },
      through: {
        type: "string",
        description:
          "Select from the start of `phrase` to the END of this later phrase (spans lines and paragraphs). Implies a selection; typing replaces it, shortcuts format it.",
      },
      through_occurrence: {
        type: "number",
        description: "Which match of `through` ends the span, 1-based (default 1)",
      },
    },
    required: ["phrase"],
  },
  async run(args, ctx) {
    const phrase = String(args.phrase ?? "").trim();
    if (!phrase) {
      return { ok: false, error: `${failureTag("input")}: docs_locate needs a non-empty phrase` };
    }
    const nth = (v: unknown): number =>
      typeof v === "number" && v >= 1 ? Math.min(Math.floor(v), 200) : 1;
    const occurrence = nth(args.occurrence);
    const keepOpen = args.close === false;
    const through = typeof args.through === "string" ? args.through.trim() : "";
    const caret =
      args.caret === "before" || args.caret === "after" || args.caret === "select"
        ? args.caret
        : undefined;
    let url = "";
    try {
      url = (await chrome.tabs.get(ctx.tabId)).url ?? "";
    } catch {
      url = "";
    }
    if (!parseWorkspaceUrl(url)) {
      return {
        ok: false,
        error: `${failureTag("input")}: docs_locate drives Google's in-page find bar — this tab (${url || "unknown"}) is not a Google Doc/Sheet/Slide. On ordinary pages, find text with read_page / snapshot instead.`,
      };
    }
    const notFound = (missing: string) => ({
      ok: false as const,
      error: `${failureTag("input")}: ${missing}. Check the exact wording with docs_read (text) — the find bar matches literally, ignoring case — then retry with words that are really there.`,
    });
    // A bar that never opened is a TOOL failure, not a wrong phrase: notFound's
    // "check your wording" advice would send the model hunting a phrase that is
    // definitely there, and it types nothing so there is no partial state.
    const barFailure = (r: FindBarResult) =>
      r.barNeverOpened ? { ok: false as const, error: r.missing ?? FIND_BAR_MISSING } : null;
    try {
      if (through) {
        // End first: record where the span ends, then put the caret at its
        // start (the view scrolls there) and extend with a measured
        // shift+click — the end point is re-scrolled into view if needed.
        const tail = await findBarCaret(ctx, through, nth(args.through_occurrence), "after");
        const tailBar = barFailure(tail);
        if (tailBar) return tailBar;
        if (tail.missing) return notFound(tail.missing);
        const end = await readCaret(ctx);
        const head = await findBarCaret(ctx, phrase, occurrence, "before");
        const headBar = barFailure(head);
        if (headBar) return headBar;
        if (head.missing) return notFound(head.missing);
        if (!end) {
          return {
            ok: false,
            error: `${failureTag("tool")}: the editor exposes no caret position, so the span end cannot be measured — the caret is now BEFORE "${phrase}"; select with caret:'select' on one phrase, or key Shift+Down / Shift+End from here`,
          };
        }
        const sel = await selectFromCaretTo(ctx, end, "shift");
        if (!sel.ok) {
          return {
            ok: false,
            error: `${failureTag("tool")}: ${sel.error} — the caret is BEFORE "${phrase}"; extend with Shift+Down / Shift+End keys instead`,
          };
        }
        await sleep(150);
        const image = await captureBlindShot(ctx.adapter, ctx.tabId);
        return {
          phrase,
          occurrence,
          through,
          caret: "select",
          findBarClosed: true,
          ...(image ? { image } : {}),
          note: `the span from "${phrase}" through "${through}" is SELECTED (shift+click at the measured end, ${sel.to.x},${sel.to.y}) — type to replace it, or press a format shortcut (Control+b, Control+Alt+1, …). Check the attached screenshot shows the whole span highlighted.`,
        };
      }
      const found = await findBarCaret(ctx, phrase, occurrence, caret, { keepOpen, shot: true });
      const bar = barFailure(found);
      if (bar) return bar;
      if (found.missing) return notFound(found.missing);
      const at = caret ? await readCaret(ctx) : null;
      const unverified =
        found.total === undefined
          ? " The match count is UNVERIFIED (neither the find bar's counter nor the export could be read) — confirm on the attached screenshot that the phrase is highlighted before typing."
          : "";
      const repaired = found.repaired
        ? " The phrase sits at a cell or line edge, where a lone arrow key steps OUT of the cell — the caret was corrected back onto the match edge; check the first read-back."
        : "";
      return {
        phrase,
        occurrence,
        ...(found.matches ? { matches: found.matches } : {}),
        ...(found.total !== undefined ? { total: found.total } : {}),
        findBarClosed: Boolean(caret) || !keepOpen,
        ...(caret ? { caret } : {}),
        ...(at ? { caretAt: caretPoint(at) } : {}),
        ...(found.image ? { image: found.image } : {}),
        note:
          (caret
            ? caret === "select"
              ? `the match is SELECTED in the document — type to replace it, or apply formatting (bold, docs_op apply_style) to it. No click needed.`
              : `the caret is now ${caret === "before" ? "immediately BEFORE" : "immediately AFTER"} the match — type (type / key) right away; do NOT click first, a click would move it. Verify the text landed with docs_read.`
            : found.image
              ? "the attached screenshot shows the match highlighted and in view — it is now the LATEST capture (prefer caret:'before'|'after'|'select': no pixel aim needed)"
              : "the screenshot could not be captured — take one with `screenshot` before pointing at the match") + repaired + unverified,
      };
    } catch (err) {
      return {
        ok: false,
        error: `${failureTag("transport")}: docs_locate could not drive the find bar (${String((err as Error)?.message ?? err)}) — the debugger channel is down; reload once, or locate visually via screenshots`,
      };
    }
  },
  present(payload) {
    const p = (payload ?? {}) as {
      phrase?: string;
      occurrence?: number;
      matches?: string;
      image?: string;
      note?: string;
      caret?: string;
      through?: string;
      caretAt?: { x: number; y: number };
    };
    const matches = p.matches ? ` — find bar reports ${p.matches}` : "";
    const span = p.through ? ` through "${p.through}"` : "";
    const at = p.caretAt ? ` at (${p.caretAt.x},${p.caretAt.y})` : "";
    return {
      text: `located "${p.phrase ?? ""}"${span} (occurrence ${p.occurrence ?? 1})${matches}${p.caret ? ` · caret: ${p.caret}${at}` : ""}. ${p.note ?? ""}`,
      ...(p.image ? { image: p.image } : {}),
    };
  },
});
