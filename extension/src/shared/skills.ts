// Skills ("playbooks"): curated, in-git PROCEDURES the agent can load on
// demand — the procedural counterpart to lessons (which are automatic,
// per-profile one-liners drafted by the coach).
//
// The load path is cache-safe by construction: the system prompt carries only
// a one-line-per-skill CATALOG (frozen at run start, riding the uncached
// appendix next to the lessons block), and a full body reaches the model only
// as a `use_skill` TOOL RESULT — appended to history, never mutating the
// byte-stable cached prefix mid-run.
//
// SECTION SPLIT. A procedure often has moments ("calibrate once" -> "derive
// the map" -> "batch the drags" -> "verify") where the agent needs only ONE.
// Loading all 6,000 chars to get one step is the same waste as re-sending the
// whole doc-editor rules on a chat task. So a skill may be split into SECTIONS:
// `use_skill name:x` returns the OUTLINE (titles + useWhen, one line each);
// `use_skill name:x section:y` returns just that section's body. A single-
// section skill still returns its body in one call — the outline is a net win
// only when the body is actually split.
//
// HOST PIN. "Know when to load it" used to depend on the model guessing. The
// catalog now names the sections AND the run's URL is matched against the
// skill's `hosts`: the matching skill is pinned to the top of the catalog with
// a "you are on <host> — load this" line. The catalog is built ONCE at run
// start (byte-stable for the whole run — no mid-run prefix mutation).
//
// This file is the pure core (types, bundled seeds, ranking, catalog
// formatting, merge). Storage lives in background/skills.ts, the tool in
// background/tools/skills.ts, the drawer in sidepanel/main.tsx.

/** chrome.storage.local key holding the per-profile skill store. */
export const SKILLS_KEY = "baSkills";

/** One skill body is a procedure, not a manual. */
export const SKILL_BODY_MAX_CHARS = 6_000;
export const SKILL_WHEN_MAX_CHARS = 160;
export const SKILL_SECTION_MAX_CHARS = 2_000;
export const SKILL_SECTION_MAX = 12;
/** Catalog budget: lines in the prompt appendix, not tokens in the prefix. */
export const CATALOG_MAX_ITEMS = 10;

export type SkillSource = "bundled" | "user";

/** One loadable step of a procedure. */
export interface SkillSection {
  id: string;
  /** Short title, e.g. "Calibrate once". */
  title: string;
  /** When this section applies (one line). Optional. */
  useWhen?: string;
  body: string;
}

/** The catalog-facing view of a section — what `use_skill` returns for the outline. */
export interface SkillSectionLite {
  id: string;
  title: string;
  useWhen?: string;
}

export interface Skill {
  id: string;
  /** kebab-case identifier `use_skill` takes. */
  name: string;
  /** One line: when this procedure applies (shown in the catalog). */
  whenToUse: string;
  /** Hostnames whose pages this procedure targets (ranking + host-pin signal). */
  hosts?: string[];
  /** Task-text keywords (ranking signal). */
  keywords?: string[];
  /**
   * The full procedure. Ignored for loading when `sections` is present (the
   * body is the joined sections — kept so single-section skills and older
   * storage keep working).
   */
  body: string;
  /** When present, the skill is loaded section-by-section. */
  sections?: SkillSection[];
  source: SkillSource;
  /** Pinned skills always make the catalog. */
  pinned?: boolean;
  at: number;
  lastUsedAt?: number;
}

/** Validate/normalize a skill name to kebab-case. */
export function normalizeSkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeSectionId(id: string): string {
  return normalizeSkillName(id);
}

/** The catalog-facing view of a skill's sections (titles + useWhen). */
export function skillOutline(s: Skill): SkillSectionLite[] {
  return (s.sections ?? []).map((sec) => ({
    id: sec.id,
    title: sec.title,
    useWhen: sec.useWhen,
  }));
}

export type SkillBodyResult =
  | { body: string; sections: SkillSectionLite[] }
  | { error: string };

/**
 * Resolve what one `use_skill` call should return:
 *  - single-section skill (or no `section` given on one): the body, with an
 *    empty section list — one call, no extra round trip;
 *  - multi-section skill with no `section`: an ERROR naming the outline, so
 *    the model asks for the section it actually needs (this is the whole
 *    point of the split — the alternative silently loads 6k chars);
 *  - `section` given: that section's body, plus the outline so the model can
 *    see what else is available without a second lookup.
 */
export function skillBodyOf(s: Skill, sectionId?: string): SkillBodyResult {
  const outline = skillOutline(s);
  const sections = s.sections ?? [];
  // Single-section (or unsectioned) skills: no indirection.
  if (sections.length <= 1) {
    return { body: sections[0]?.body ?? s.body, sections: outline };
  }
  if (sectionId === undefined || sectionId === "") {
    return {
      error:
        `skill '${s.name}' is split into ${sections.length} sections — ask for one: ` +
        outline.map((o) => `${o.id} (${o.title})`).join(", "),
    };
  }
  const wanted = normalizeSectionId(sectionId);
  const found = sections.find((sec) => normalizeSectionId(sec.id) === wanted);
  if (!found) {
    return {
      error: `no section '${sectionId}' in '${s.name}' — sections: ` +
        outline.map((o) => `${o.id} (${o.title})`).join(", "),
    };
  }
  return { body: found.body, sections: outline };
}

/** Rank skills for a task (and optionally the page URL). Mirrors the lessons
 *  scoring shape: pinned beats host match beats keyword overlap. */
export function rankSkillsForTask(
  skills: Skill[],
  task: string,
  opts: { url?: string; maxItems?: number } = {},
): Skill[] {
  const maxItems = opts.maxItems ?? CATALOG_MAX_ITEMS;
  const haystack = ` ${task.toLowerCase()} `;
  const url = (opts.url ?? "").toLowerCase();
  const scored = skills.map((skill, index) => {
    let score = 0;
    if (skill.pinned) score += 6;
    for (const host of skill.hosts ?? []) {
      const h = host.toLowerCase();
      if (url.includes(h) || haystack.includes(h)) score += 4;
    }
    for (const kw of skill.keywords ?? []) {
      if (haystack.includes(kw.toLowerCase())) score += 2;
    }
    return { skill, score, index };
  });
  scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
  return scored.slice(0, maxItems).map((s) => s.skill);
}

/** Does this skill target the given URL? Host-matching only — no network. */
export function skillMatchesUrl(s: Skill, url: string): boolean {
  const u = (url ?? "").toLowerCase();
  return (s.hosts ?? []).some((h) => u.includes(h.toLowerCase()));
}

function clipLine(text: string, max = SKILL_WHEN_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The catalog block: one line per skill, frozen at run start. Host-matching
 * skills are PINNED TO THE TOP with a "you are on <host>" note so the model
 * does not have to guess when to load them. Empty string when there is
 * nothing to list (the appendix then carries lessons only).
 */
export function formatSkillsCatalog(
  ranked: Skill[],
  opts: { url?: string } = {},
): string {
  if (!ranked.length) return "";
  const url = opts.url ?? "";
  const matched = ranked.filter((s) => skillMatchesUrl(s, url));
  const rest = ranked.filter((s) => !skillMatchesUrl(s, url));
  const ordered = [...matched, ...rest];
  const lines = ordered.map((s) => {
    const sections = skillOutline(s);
    const shape = sections.length
      ? ` · sections: ${sections.map((o) => o.id).join(", ")}`
      : "";
    return `- ${s.name} — ${clipLine(s.whenToUse)}${shape}`;
  });
  const sectionNote =
    "A multi-section skill returns its outline when asked for the whole thing; ask for one `section` to get just that step.";
  const header = matched.length
    ? `On-demand procedures (skills): you are on ${hostOf(url) ?? "a page these match"} — the matching skill${matched.length > 1 ? "s" : ""} ${matched.map((s) => s.name).join(", ")} ${matched.length > 1 ? "are" : "is"} listed first and worth loading NOW. ${sectionNote}`
    : `On-demand procedures (skills): the appendix lists them; load one with ONE \`use_skill\` call (its body arrives as the tool result) BEFORE working the surface it describes, then follow it. ${sectionNote}`;
  return [header, ...lines].join("\n");
}

/** Merge stored skills with the bundled defaults: a bundled skill is added
 *  when absent and UPDATED when the stored copy is still the unedited bundled
 *  version; a user-edited override (source "user", same id) always wins.
 *  Returns the merged list plus whether storage needs a write. */
export function mergeSkills(
  stored: Skill[],
  bundled: Skill[] = BUNDLED_SKILLS,
): { skills: Skill[]; changed: boolean } {
  const byId = new Map(stored.map((s) => [s.id, s]));
  let changed = false;
  for (const b of bundled) {
    const existing = byId.get(b.id);
    if (!existing) {
      byId.set(b.id, b);
      changed = true;
      continue;
    }
    // A stored bundled copy that drifted (older default) refreshes; a user
    // override is the user's and is never touched.
    if (existing.source === "bundled" && existing.body !== b.body) {
      byId.set(b.id, { ...b, lastUsedAt: existing.lastUsedAt });
      changed = true;
    }
  }
  return { skills: [...byId.values()], changed };
}

// ---------------------------------------------------------------------------
// Bundled skills. Every body is a procedure paid for by a real run — the
// evidence lives in the git history and run logs, the steps live here.
// Split into sections where the procedure has natural moments.
// ---------------------------------------------------------------------------

const CANVAS_DOC_EDITORS_SECTIONS: SkillSection[] = [
  {
    id: "build",
    title: "Build bit by bit: format first, then the block",
    useWhen: "creating a document or adding any formatted content — read this FIRST",
    body: [
      "BUILD BIT BY BIT — the format goes on BEFORE the text, never typed first and fixed afterwards. One block at a time (one heading, one paragraph, one list group):",
      "1. Caret at the end (an empty body needs nothing; otherwise docs_locate {phrase, caret:'after'} on the last text, key End).",
      "2. Set the format AHEAD of the caret: paragraph style (Control+Alt+1..6 headings, Control+Alt+0 normal text, or docs_op apply_style), font / size / colour from the toolbar, list type (section lists).",
      "3. Type the block in ONE call. Inline marks are toggles inside the same sequence: key Control+b, type 'word', key Control+b.",
      "4. Enter, then reset what the next block must not inherit (Control+Alt+0, toggles off, list exited).",
      "5. ONE docs_read (format:'outline') checks the block, then todo_write ticks its item.",
      "Batch 2-4 into ONE input_sequence: steps [{key:'Control+Alt+2'}, {type:'Methods\\n'}, {key:'Control+Alt+0'}, {type:'Body text with '}, {key:'Control+b'}, {type:'bold'}, {key:'Control+b'}, {type:' words.\\n'}].",
      "- Selecting earlier text is for REPAIRING one mistake, never the plan: every select-then-format round trip costs several calls and can misfire, while a format set ahead lands first time.",
      "- Menu rows are clicked by LABEL with menu_path, never by click_at pixels — a row a few px off is another row.",
    ].join("\n"),
  },
  {
    id: "lists",
    title: "Bulleted, numbered and checklist groups",
    useWhen: "any list in a document",
    body: [
      "LISTS ARE BUILT STYLE-FIRST, one group at a time:",
      "1. On an empty line, set the list type: Control+Shift+8 bulleted, Control+Shift+7 numbered, Control+Shift+9 checklist.",
      "2. Type the items in ONE call, separated by '\\n' (each newline is a new item).",
      "3. Leave the list: Enter twice (the second Enter on an empty item exits). Only then type the next paragraph or start the next group with its own shortcut.",
      "- NEVER convert items that already exist with a list shortcut: groups can share one list identity in Docs, and a shortcut pressed inside one group has rewritten EVERY group at once.",
      "- To REPAIR one group: docs_locate {phrase:'first item', through:'last item'} selects it, then menu_path ['Format','Bullets & numbering', 'Bulleted list'|'Numbered list'|'Checklist'].",
      "- Tick a checklist item by clicking its box (screenshot {marks:true} gives it a ref), not by retyping.",
      "- Verify each group with docs_read format:'outline' before starting the next.",
    ].join("\n"),
  },
  {
    id: "write",
    title: "Write the document body (no pixel aiming)",
    useWhen: "adding or changing document text",
    body: [
      "- ROUTE ORDER: (1) `docs_locate {phrase, caret:'after'|'before'|'select'}` puts the caret at a phrase BY KEYBOARD, then no-ref `type` — no click. A span: {phrase, through:'end phrase'} selects start→end in one call. (2) Table cells: `docs_table` (below). (3) `type_at` at screenshot pixels, only with no text anchor.",
      "- An EMPTY document needs no anchor: click the body once (or no-ref `type` straight away — the tool finds the editor's typing sink) and build block by block (section build).",
      "- The document BODY is painted into a <canvas>: no ref exists for it and no tool reads the pixels back — read it with docs_read (format:'outline' = styles, marks, tables as grids).",
      "- `type_at` (fallback): x/y in space:'screenshot' + text — click + type in ONE trusted sequence. click_count:2 = word, 3 = paragraph; select_to:{x,y} = shift-click range; select:'all' replaces the body; keys_after:['Control+b'] formats it. Use the LATEST image's coordinates only.",
      "- NEVER navigate by Home/arrows/Shift+Down line counting: the canvas does not confirm caret positions. Anchor on text (docs_locate) or on a cell address (docs_table) instead.",
      "- One BLOCK is ONE `type` call ('\\n' between its lines). NEVER type character-by-character, never one call per line — and never the whole document in one call to format afterwards.",
      "- STYLE AHEAD OF THE CARET for every block: set the heading with Control+Alt+1..6 (or docs_op apply_style), type the line, Enter, Control+Alt+0 back to normal text. Re-styling existing text is REPAIR only: docs_locate caret:'select' on it, then the shortcut.",
      "- To REPLACE a phrase: docs_locate caret:'select', then type — the typing replaces the selection. Do NOT key Backspace first: on a whole word Docs' smart delete also eats a space.",
      "- `key` (no ref) drives shortcuts at the sink: Control+b/i/u, Control+Enter page break, Control+K link, Control+z.",
      "- 'Nothing editable took focus' = you hit chrome: Escape, docs_locate with caret (or click the body once), retry.",
    ].join("\n"),
  },
  {
    id: "verify",
    title: "Verify each block (one docs_read, not three checks)",
    useWhen: "after any write — the cheap way to see it",
    body: [
      "VERIFY ONCE PER BLOCK, CHEAPLY: `docs_read` returns the document's content WITHOUT leaving the page or running any in-page JS — format:'html' shows structure AND formatting (font-family, font-weight:700 = bold, color, background-color = highlight, <ol>/<ul>, <table>, <img>, <hr>, <a href>); format:'text' for plain content. Formatting checks MUST use html — text strips exactly the things a task grades. One docs_read per block; do NOT stack screenshots, reads and preview tabs.",
      "NEVER verify with `evaluate_js` `fetch('<doc-url>/export?format=…')` — Trusted Types blocks the in-page parse and the debugger transport flaps; `docs_read` fetches the SAME export from the harness. And NEVER navigate to /preview or /mobilebasic to check your work.",
      "`docs_state` reads the toolbar chrome as fields in ONE call — applied style, font, size, bold/italic/underline, editing mode, open dialogs.",
      "To reach a phrase deep in the document use `docs_locate {phrase, caret:'before'|'after'|'select'}`: the find bar jumps to it and the caret lands there by keyboard — the next `type`/`key` acts there. Never scroll-hunt, count lines, or aim pixels at text.",
      "Toolbar icons, menu rows and dialog buttons are DOM: `screenshot {marks:true}` labels each with its ref — click {ref} hits it exactly. Never estimate pixels for a control that has a ref.",
      "Screenshots verify VISUAL state (layout, page breaks, image size, what is selected) and you DO see them — one per checkpoint, not one per keystroke; on canvas editors every action result already carries one.",
      "- Click results self-report aim corrections in [brackets]: a near-miss point snapped to a control's centre, image pixels re-read as space:'screenshot', or scroll since the capture compensated. If the reported 'hit' is not your target, LOOK again; don't re-click the same point.",
      "- If a `type`/`type_at` result warns that focus was lost, part of the text may not have landed: verify with docs_read BEFORE retyping — retyping blind duplicates whatever did arrive.",
    ].join("\n"),
  },
  {
    id: "read",
    title: "Read the document (one call, stay on the page)",
    useWhen: "when the task needs the document's CONTENT, not its pixels",
    body: [
      "To READ a document's content, call `docs_read` — it fetches the exported text/HTML from the harness: no navigation, no page JS, no debugger. Sheets read as CSV the same way. Slides decks have no text export: screenshot the deck (its outline and speaker-notes panes are ordinary DOM when open).",
      "To CHECK whether a phrase exists or JUMP to it, use the find bar: Ctrl+F, type the phrase — it reports 'x of y' matches and scrolls to each; Escape closes. A human move that never leaves the page.",
      "- NEVER navigate to /preview or /mobilebasic to read a doc you are editing: the detour costs two navigations, loses the editor's live state (caret, open menus, scroll) and export URLs often download instead of rendering. `docs_read` replaced that route.",
      "- When a frame reports 'content is drawn into a <canvas>', that is a statement of fact, not a transient error: do NOT retry read_page / snapshot / evaluate_js hoping for different output. Use docs_read for content, screenshot for pixels, and the toolbar/menu refs for actions.",
    ].join("\n"),
  },
  {
    id: "ui-routes",
    title: "Menus, tables, images (verified routes)",
    useWhen: "structure beyond text: page setup, tables, images, TOC, bookmarks, equations",
    body: [
      "- Structure lives in MENUS, and menus are DOM: walk them with `menu_path ['Insert','Break','Page break']` — every row is clicked BY LABEL at execution time, no coordinates. Page break is also Ctrl+Enter; horizontal line is Insert ▸ Horizontal line.",
      "- IMAGE: DEVICE file → Insert ▸ Image ▸ Upload from computer is a chooser BUTTON — `upload {trigger_ref, paths:[…]}` intercepts the OS dialog (hidden file inputs have refs; direct `upload {ref, paths}` works too). A web image → `view_image url:…` stages bytes (shot_N); caret in body, panels CLOSED (they steal the paste), `paste_image via:'clipboard'`. If a paste vanishes, the ACCOUNT blocks uploads — use Insert ▸ Image ▸ By URL instead. Image options sidebar: size/rotation, wrap text, alt text.",
      "- TABLES by address, never pixels — `docs_table` (row/col 1-based, tables numbered as the outline prints them): fill {table, rows:[[…]]} writes the whole grid in ONE call (adds rows) and verifies; goto {table, cell} = caret in a cell; select {table, from, to, keys_after:['Control+b']} drags across cells; merge {table, from, to}. Header color: select the row, Format ▸ Table ▸ Table options.",
      "- Bookmark: caret on the heading, Insert ▸ Bookmark; then select the phrase, Ctrl+K (the dialog lists headings and bookmarks). TOC and headers: Insert ▸ Page elements (TOC after the headings exist).",
      "- Equation: Insert ▸ Symbols ▸ Equation, then type E = mc².",
      "- Fonts not in the menu: font dropdown ▸ More fonts — a REAL search dialog; check each font, Done, apply. Never type into the font-name box on the toolbar (it is a div, not an input).",
      "- `docs_op` (self-verifying): apply_style {style:'Title'|'Heading 1'…} — set it BEFORE typing the block; page_numbers {position:'footer'|'header'}; insert_table {rows, cols} — it refuses unless the size grid reports the size asked for; confirm in docs_read outline before docs_table fill. page_setup is NOT reliable yet: use menu_path, rows BY LABEL. Two misses → blocked; never re-aim pixels.",
    ].join("\n"),
  },
  {
    id: "collaboration",
    title: "Suggesting, comments, sharing, versions",
    useWhen: "suggestion edits, comments/@mentions/resolves, sharing, named versions",
    body: [
      "- Suggesting: mode dropdown (pencil, top right) ▸ Suggesting — make the 2-3 edits (each shows a green suggestion card in the margin) — then switch BACK to Editing before continuing.",
      "- Comments: select the anchor (text or a table cell), Ctrl+Alt+M, type the comment; an @email autocompletes — pick the chip (Docs warns it will email; expected); Ctrl+Enter or the Comment button posts. Resolve = the ✓ on the thread card; the Reply field is inside the thread. Comment cards sit in the right margin — click one to open it.",
      "- Find and replace: Ctrl+H — real inputs; Replace all, and read the dialog's '0 of 0' remaining as the confirmation.",
      "- Share: the Share button ▸ General access ▸ Anyone with the link ▸ role dropdown ▸ Commenter — the 'Access updated' toast confirms. The link itself is the readonly input at the top of that dialog (evaluate_js .value reads it to hand back).",
      "- Named version: File ▸ Version history ▸ Name current version ▸ type ▸ Save — the 'Named in version history' toast confirms. Do it LAST, after every other edit.",
      "- Mistakes are cheap when you LOOK: wrong menu item → Escape, reopen, retry; stray text → docs_locate caret:'select' on it, key Backspace. ONE corrective action each — never a retry loop of the same call.",
    ].join("\n"),
  },
  {
    id: "rebuild",
    title: "Rebuild mode (when the body tangles)",
    useWhen: "styles on wrong lines, duplicated fragments, mis-converted lists",
    body: [
      "WHEN THE BODY TANGLES, do not patch — REBUILD. `type`/`type_at` with select:'all' and the full replacement text is ONE atomic select-all + insert: the selection cannot be lost between calls (a separate Ctrl+A call followed by a separate type call is exactly how a document got duplicated).",
      "- Rebuild top-to-bottom: each block lands via type_at at its caret position with styles set AHEAD of the caret, then ONE docs_read verifies the block. Never re-select earlier text to fix it — re-type the block.",
      "- For one tangled section only: docs_locate {phrase, through} selects its span, then type the corrected block over it, styles set ahead as you go.",
      "- A rebuild is one atomic replace plus N verified type_at calls — three undo-patch cycles cost more than one rebuild.",
    ].join("\n"),
  },
  {
    id: "fallback",
    title: "Debugger-down / DOM-only fallback",
    useWhen: "when typing or a tool fails with a transport error",
    body: [
      "- When typing, `screenshot`, `type_at` or `evaluate_js` fails with a TRANSPORT error, the harness has ALREADY run the sanctioned recovery itself (reload the tab + retry the call once) — the result says so. If the retry also failed, the debugger channel is down for this session: check `page_health` ONCE, then STOP retrying debugger-dependent tools — ref `click` and `type trusted:false` over the content script still work, and they are enough to edit the document. `docs_read` never touches the debugger and keeps working throughout.",
      "- Trusted-Types refusals (innerHTML / DOMParser / insertAdjacentHTML 'requires TrustedHTML') are a page SECURITY POLICY, not a coding mistake: no variant of the assignment will ever run there. Read with `docs_read`, or textContent / querySelector for one element — never retry the parser.",
      "- On a canvas-editor URL, `type`/`key` default to real keystrokes even in ordinary dialogs and menus. So with the debugger down, pass `trusted:false` explicitly to fill any real input (Find and replace fields, rename boxes, side panels) through the content script.",
      "- DOM-only fallback that still edits the document (needs an existing anchor string): Edit ▸ Find and replace (click the menu refs; its fields are ordinary inputs). Pick an anchor the document already contains exactly once (the dialog counts matches, e.g. '1 of 1'), set Find = anchor and Replace with = '<new text> <anchor>', click Replace. Nothing is deleted. In a blank document there is no anchor — use the one-call `type` route above instead.",
    ].join("\n"),
  },
];

const CHAT_RELAY_SECTIONS: SkillSection[] = [
  {
    id: "cycle",
    title: "The full relay cycle (screenshot -> ask -> wait -> deliver)",
    useWhen: "the task says to use another assistant's answer",
    body: [
      "Relay a question through a chat assistant (or any remote answer source) and use its reply — the whole cycle is ~4 steps, not 15:",
      "1. CAPTURE the question: `screenshot` of the source page (the result stages it on the shelf). If the composer supports it, batch the next calls in the same step.",
      "2. DELIVER it: `tabs_switch` to the chat tab, then `paste_image` (no ref = the composer; it pipes the staged shot straight in) and `type` the question text if it needs one — batched in ONE step. `key Enter` (or the send ref) ends the step.",
      "3. WAIT WITH ONE CALL: `wait_for` with `stable_for_ms:2000` and a generous `timeout_ms` (60_000+; a long answer legitimately takes 60-120s to stream). The result carries the reply text — no polling loops of wait_for_settle/snapshot (a streamed reply pauses longer than settle's quiet window and looks 'settled' while still growing).",
      "4. RELAY: extract the answer from the wait_for result (or one read_page), `tabs_switch` back, enter the answer, submit — batched where refs allow.",
      "The source's answer IS the deliverable: relay it and move on. Do not re-derive it independently and adjudicate — if you truly believe it is wrong, say so ONCE in the final summary and still deliver it. If the reply is slow, ONE wait_for with a longer timeout beats three re-reads.",
    ].join("\n"),
  },
];

const GRAPH_DRAG_SECTIONS: SkillSection[] = [
  {
    id: "calibrate",
    title: "Calibrate once",
    useWhen: "before any drag on an unfamiliar graph",
    body: [
      "SEE IT: `screenshot` (the graph is pixels; text tools cannot read it). Identify the axes, the target curve/points and the drag handles.",
      "CALIBRATE ONCE: ONE `evaluate_js` IN THE WIDGET'S FRAME returning a JSON object with every handle's getBoundingClientRect() AND the plot area's rect (plus the iframe's rect if you must do the math — but prefer letting the tools do it). `element_at` on a probe point also reports what sits there.",
    ].join("\n"),
  },
  {
    id: "derive",
    title: "Derive the pixel-to-value map in one pass",
    useWhen: "converting between graph values and screen points",
    body: [
      "DERIVE the linear pixel-to-value map in ONE pass: two axis ticks are enough (value = a + (px - px0) * slope). Do the arithmetic once, in one place — write the formula down and reuse it. Never re-derive between drags.",
    ].join("\n"),
  },
  {
    id: "batch-drag",
    title: "Send all drags as one call",
    useWhen: "plotting or moving more than one point",
    body: [
      "SEND ALL DRAGS AS ONE `drag_at` CALL with a `drags` list (up to 32): each entry {x, y, to_x, to_y} in frame-local coordinates with `frame`, or {ref}/{to_ref} when handles have refs — the tool translates frame offsets for you. NEVER re-derive coordinates between drags, and never drag point-by-point across turns. Each result line reports where it landed.",
    ].join("\n"),
  },
  {
    id: "verify",
    title: "Verify with one screenshot",
    useWhen: "after the drags",
    body: [
      "VERIFY with ONE screenshot (or the widget's own value readout via evaluate_js). If a drag landed off its handle, fix the MAP, not the individual point — the error is systematic (offset), not random.",
      "A +/-50px iframe offset confusion cost a real run 22 minutes and 81 drag calls; the procedure above is what it reverse-engineered the hard way.",
    ].join("\n"),
  },
];

const MULTI_STEP_FORMS_SECTIONS: SkillSection[] = [
  {
    id: "cycle",
    title: "Answer and advance in batched steps",
    useWhen: "quizzes, wizards and multi-page forms",
    body: [
      "Multi-step forms, quizzes and wizards (one question per page, Next/Submit between):",
      "- Read the CURRENT step from the auto-observation each action returns; do not re-snapshot to check what you already see.",
      "- Answer + advance in ONE step: `type`/`click` the answer and `click` Next together (refs from the observation you already have). Split only when the next control's ref depends on this step's result.",
      "`type submit:true` submits the enclosing form — on SPA quiz pages the inputs often sit outside any <form>, so prefer clicking the page's own Next/Submit ref when one exists.",
      "- For many similar fields, batch all the types in one step (call order is preserved).",
      "- If an answer must come from elsewhere (a source page, a chat tab), switch -> get it -> switch back -> enter it; do not keep both pages 'live' with interleaved reads.",
      "- Radio/checkbox sets: click the option ref directly; never open the dropdown menu AND click the option in separate steps when both refs are already known.",
    ].join("\n"),
  },
];

function joinSections(sections: SkillSection[]): string {
  return sections.map((s) => `### ${s.title}\n${s.body}`).join("\n\n");
}

/** The curated defaults shipped in git. */
export const BUNDLED_SKILLS: Skill[] = [
  {
    id: "canvas-doc-editors",
    name: "canvas-doc-editors",
    whenToUse:
      "Google Docs/Slides, Office on the web, any canvas-painted document editor — typing, formatting and reading them",
    hosts: ["docs.google.com", "drive.google.com", "office.com", "office365.com", "onedrive.live.com"],
    keywords: ["doc", "document", "slides", "slide deck", "presentation", "essay", "write"],
    body: joinSections(CANVAS_DOC_EDITORS_SECTIONS),
    sections: CANVAS_DOC_EDITORS_SECTIONS,
    source: "bundled",
    pinned: true,
    at: 0,
  },
  {
    id: "chat-relay",
    name: "chat-relay",
    whenToUse:
      "Sending questions/screenshots to a chat assistant and relaying its answer back — the full wait-for-streamed-reply cycle",
    hosts: ["kimi.ai", "chatgpt.com", "claude.ai", "gemini.google.com", "poe.com"],
    keywords: ["relay", "ask", "send it to", "kimi", "chat", "assistant", "answer back"],
    body: joinSections(CHAT_RELAY_SECTIONS),
    sections: CHAT_RELAY_SECTIONS,
    source: "bundled",
    pinned: true,
    at: 0,
  },
  {
    id: "graph-drag-widgets",
    name: "graph-drag-widgets",
    whenToUse:
      "Plotting points or dragging handles on SVG/canvas graphs — calibrate once, then one batched drags call",
    hosts: [],
    keywords: ["graph", "plot", "drag", "curve", "axis", "velocity", "draw"],
    body: joinSections(GRAPH_DRAG_SECTIONS),
    sections: GRAPH_DRAG_SECTIONS,
    source: "bundled",
    at: 0,
  },
  {
    id: "multi-step-forms",
    name: "multi-step-forms",
    whenToUse: "Quizzes, wizards and multi-page forms — answering and advancing in batched steps",
    hosts: [],
    keywords: ["form", "quiz", "question", "assignment", "wizard", "submit", "next"],
    body: joinSections(MULTI_STEP_FORMS_SECTIONS),
    sections: MULTI_STEP_FORMS_SECTIONS,
    source: "bundled",
    at: 0,
  },
];
