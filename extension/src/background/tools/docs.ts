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
import { runContentAction } from "./content-action";
import { sendStrokes } from "./coords";
import { captureBlindShot, layoutViewportCss, truncateWithNote } from "./perception";
import { ensureTabActive, sendTrustedKey, sendTrustedText } from "./trusted-input";
import { registerTool, type ToolContext } from "./types";

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
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? "the signed-in account cannot export this document (permission or sign-in state) — check the account chip; do not retry"
        : res.status === 404
          ? "no such document (wrong id, moved or deleted)"
          : `export endpoint returned ${res.status}`;
    return { ok: false, error: `${failureTag("tool")}: ${hint}` };
  }
  return { ok: true, body: await res.text(), doc };
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
 */
export async function readCaret(ctx: ToolContext): Promise<CaretBox | null> {
  for (let i = 0; i < 4; i++) {
    const res = await runContentAction(ctx.tabId, { action: "caretRect" }).catch(() => null);
    const box = res?.ok ? (res.data as CaretBox | null) : null;
    if (box && box.height > 0) return box;
    await sleep(120);
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

/**
 * The find-bar move: Ctrl+F, type the phrase, Enter to the occurrence, then
 * (with a caret mode) Escape — which hands focus back to the document with
 * the match selected — and collapse it by arrow key. Returns the counter text
 * when readable. Throws on a dead debugger channel.
 */
export async function findBarCaret(
  ctx: ToolContext,
  phrase: string,
  occurrence: number,
  caret: "before" | "after" | "select" | undefined,
  opts: { keepOpen?: boolean; shot?: boolean } = {},
): Promise<{ matches?: string; image?: string }> {
  await ensureTabActive(ctx.tabId, ctx.adapter);
  await sendTrustedKey(ctx.tabId, ctx.adapter, "Control+f");
  await sendTrustedText(ctx.tabId, ctx.adapter, phrase);
  for (let i = 1; i < occurrence; i++) {
    await sendTrustedKey(ctx.tabId, ctx.adapter, "Enter");
  }
  // Let the app scroll to the match and paint the highlight.
  await sleep(opts.shot ? 400 : 250);
  const counter = await readField(ctx, ['[class*="findbar"] [class*="counter"]', ".docs-findbar-counter"]);
  const image = opts.shot ? await captureBlindShot(ctx.adapter, ctx.tabId) : undefined;
  if (caret || !opts.keepOpen) await sendTrustedKey(ctx.tabId, ctx.adapter, "Escape");
  if (caret === "before" || caret === "after") {
    await sleep(80);
    await sendTrustedKey(ctx.tabId, ctx.adapter, caret === "before" ? "ArrowLeft" : "ArrowRight");
  }
  return { ...(counter?.text ? { matches: counter.text } : {}), ...(image ? { image } : {}) };
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
    "Jump to a phrase inside a Google Doc/Sheet/Slide using the app's OWN find bar — the human move for deep-document navigation: opens Ctrl+F, types the phrase (the app highlights every match), presses Enter to reach the requested occurrence, and ATTACHES A SCREENSHOT of the match in view. TO EDIT AT A PHRASE, pass caret:'before'|'after'|'select': closing the find bar leaves the match selected and the tool collapses it by arrow key — the caret lands exactly at the text with NO pixel aiming; type right away (insert after a heading = caret:'after' then key Enter + type; replace a phrase = caret:'select' then type; format a phrase = caret:'select' then key Control+b). TO SELECT A SPAN (a sentence, a paragraph, several paragraphs) pass through:'<last words of the span>': the selection runs from the START of phrase to the END of through, measured from the editor's own caret — then type to replace it or press a format shortcut. The result reports caretAt (viewport px) when the editor exposes its caret. occurrence:2 = the second match. Use this instead of scrolling-and-hunting, counting lines, or clicking on canvas text.",
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
          "Place the caret by KEYBOARD at the match: 'before' / 'after' collapse to its start / end, 'select' leaves the match selected (type to replace it, or format it). Then type immediately — no click.",
      },
      through: {
        type: "string",
        description:
          "Select from the start of `phrase` to the END of this later phrase (spans lines and paragraphs). Implies a selection; type replaces it, shortcuts format it.",
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
    try {
      if (through) {
        // End first: record where the span ends, then put the caret at its
        // start (the view scrolls there) and extend with a measured
        // shift+click — the end point is re-scrolled into view if needed.
        await findBarCaret(ctx, through, nth(args.through_occurrence), "after");
        const end = await readCaret(ctx);
        await findBarCaret(ctx, phrase, occurrence, "before");
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
      const at = caret ? await readCaret(ctx) : null;
      return {
        phrase,
        occurrence,
        ...(found.matches ? { matches: found.matches } : {}),
        findBarClosed: Boolean(caret) || !keepOpen,
        ...(caret ? { caret } : {}),
        ...(at ? { caretAt: caretPoint(at) } : {}),
        ...(found.image ? { image: found.image } : {}),
        note: caret
          ? caret === "select"
            ? `the match is SELECTED in the document — typing replaces it; a formatting call (bold, docs_op apply_style) applies to it. No click needed.`
            : `the caret is now ${caret === "before" ? "immediately BEFORE" : "immediately AFTER"} the match — type (type / key) right away; do NOT click first, a click would move it. Verify the text landed with docs_read.`
          : found.image
            ? "the attached screenshot shows the match highlighted and in view — it is now the LATEST capture (prefer caret:'before'|'after'|'select': no pixel aim needed)"
            : "the screenshot could not be captured — take one with `screenshot` before pointing at the match",
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
