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
import { runContentAction } from "./content-action";
import { captureBlindShot, truncateWithNote } from "./perception";
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
    "Read the CURRENT Google Doc's (or Sheet's) content in ONE call — without navigating away, without in-page JavaScript and without the debugger, so it works even when evaluate_js/export fetches fail. format:'text' (default) returns the plain content; format:'html' returns the exported HTML, which is the formatting evidence (font-family, font-weight:700 = bold, <table>, <ol>/<ul>, <img>, <a href>) — use html when a task grades formatting. The tab must be on docs.google.com; pass max_chars to cap long documents (truncation is noted). For Slides decks there is no text export — screenshot the deck instead. NEVER navigate to /preview or /mobilebasic to read a doc; this call replaces that.",
  parameters: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["text", "html"],
        description: "'text' = plain content (default); 'html' = formatting evidence",
      },
      max_chars: {
        type: "number",
        description: `Cap on returned characters (default ${DEFAULT_MAX_CHARS})`,
      },
    },
  },
  async run(args, ctx) {
    const format = args.format === "html" ? "html" : "text";
    const maxChars =
      typeof args.max_chars === "number" && args.max_chars > 0
        ? Math.min(args.max_chars, 100_000)
        : DEFAULT_MAX_CHARS;
    const fetched = await fetchWorkspaceExport(ctx.tabId, format);
    if (!fetched.ok) return { ok: false, error: fetched.error };
    const content = truncateWithNote(fetched.body, maxChars, "docs_read");
    return {
      format,
      kind: fetched.doc.kind,
      chars: fetched.body.length,
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

registerTool({
  name: "docs_locate",
  description:
    "Jump to a phrase inside a Google Doc/Sheet/Slide using the app's OWN find bar — the human move for deep-document navigation, and the reliable way to get eyes on canvas text: opens Ctrl+F, types the phrase (the app highlights every match and reports 'x of y'), presses Enter to reach the requested occurrence, and ATTACHES A SCREENSHOT of the highlighted match in view. The capture becomes the latest screenshot, so space:'screenshot' coordinates resolve against it: click/type_at the highlighted text you see to place the caret exactly. Use this instead of scrolling-and-hunting or counting lines. occurrence:2 = the second match. The find bar closes afterwards (close:false keeps it open); scroll position stays at the match either way.",
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
    },
    required: ["phrase"],
  },
  async run(args, ctx) {
    const phrase = String(args.phrase ?? "").trim();
    if (!phrase) {
      return { ok: false, error: `${failureTag("input")}: docs_locate needs a non-empty phrase` };
    }
    const occurrence =
      typeof args.occurrence === "number" && args.occurrence >= 1
        ? Math.min(Math.floor(args.occurrence), 200)
        : 1;
    const keepOpen = args.close === false;
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
      await ensureTabActive(ctx.tabId, ctx.adapter);
      await sendTrustedKey(ctx.tabId, ctx.adapter, "Control+f");
      await sendTrustedText(ctx.tabId, ctx.adapter, phrase);
      for (let i = 1; i < occurrence; i++) {
        await sendTrustedKey(ctx.tabId, ctx.adapter, "Enter");
      }
      // Let the app scroll to the match and paint the highlight.
      await new Promise((r) => setTimeout(r, 400));
      // The counter is version-drifty DOM — best effort; the screenshot shows
      // it either way, and the model reads it visually.
      const counter = await readField(ctx, [
        '[class*="findbar"] [class*="counter"]',
        ".docs-findbar-counter",
      ]);
      const image = await captureBlindShot(ctx.adapter, ctx.tabId);
      if (!keepOpen) await sendTrustedKey(ctx.tabId, ctx.adapter, "Escape");
      return {
        phrase,
        occurrence,
        ...(counter?.text ? { matches: counter.text } : {}),
        findBarClosed: !keepOpen,
        ...(image ? { image } : {}),
        note: image
          ? "the attached screenshot shows the match highlighted and in view — it is now the LATEST capture, so type_at/click_at with space:'screenshot' resolve against it"
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
    };
    const matches = p.matches ? ` — find bar reports ${p.matches}` : "";
    return {
      text: `located "${p.phrase ?? ""}" (occurrence ${p.occurrence ?? 1})${matches}. ${p.note ?? ""}`,
      ...(p.image ? { image: p.image } : {}),
    };
  },
});
