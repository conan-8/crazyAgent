// Frame-aware perception helpers — pure, so the budgeting and ordering rules
// are testable without a browser.
//
// Why this exists: a page's interesting content is frequently NOT in the top
// document. Google Docs keeps the document in a kix frame, school portals embed
// Docs/Slides in iframes, and the previous implementation computed every
// frame's text and then threw all but the main frame's away (it assigned
// `text` only when `frameId === 0`). The model could click a button inside an
// iframe but could not read a word of it — which is what made long runs flail
// on Schoology and Docs.
import type { ElementInfo } from "../content/registry";

export interface FrameSnapshotLike {
  frameId: number;
  href: string;
  title: string;
  text: string;
  /** Present on real snapshots; optional so tests can build minimal frames. */
  canvases?: number;
  textChars?: number;
}

/** Per-frame text cap in the rendered snapshot (each frame's own budget). */
export const FRAME_TEXT_MAX_CHARS = 1_200;
/** Total text budget across all non-main frames. */
export const FRAME_TEXT_TOTAL_CHARS = 4_000;
/** A frame this short adds nothing — skip it instead of spending budget. */
export const FRAME_TEXT_MIN_CHARS = 20;
/** Extra frames listed (by href) beyond those whose text is shown. */
export const FRAME_MAP_MAX = 20;

export interface AggregatedSnapshot {
  frames: FrameSnapshotLike[];
  elements: (ElementInfo & { ref: string; frameId: number })[];
  text: string;
}

export function collapseWhitespace(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Frames worth rendering, main frame first, then by frameId for stability. */
export function orderFrames(frames: FrameSnapshotLike[]): FrameSnapshotLike[] {
  return [...frames].sort((a, b) => {
    if (a.frameId === 0) return -1;
    if (b.frameId === 0) return 1;
    return a.frameId - b.frameId;
  });
}

/**
 * The `text` field of a snapshot: the main frame's digest, then every OTHER
 * frame's, each labelled with its frame id and URL so the model can both read
 * the content and know which `frameId#n` refs belong to it.
 *
 * Budgets are per frame and in total, so one enormous frame (or a page with
 * dozens of ad frames) cannot crowd out the main document.
 */
export function buildFrameText(snap: AggregatedSnapshot): string {
  const ordered = orderFrames(snap.frames);
  const main = ordered.find((f) => f.frameId === 0);
  const parts: string[] = [];
  if (main) {
    const text = collapseWhitespace(main.text);
    if (text) parts.push(clip(text, FRAME_TEXT_MAX_CHARS * 2));
  }
  const others = ordered.filter((f) => f.frameId !== 0);
  let spent = 0;
  for (const frame of others) {
    const text = collapseWhitespace(frame.text);
    if (text.length < FRAME_TEXT_MIN_CHARS) continue;
    const budget = Math.min(FRAME_TEXT_MAX_CHARS, FRAME_TEXT_TOTAL_CHARS - spent);
    if (budget < FRAME_TEXT_MIN_CHARS) {
      parts.push(`--- frame ${frame.frameId} (${frame.href}) --- [text omitted: snapshot budget reached]`);
      continue;
    }
    const clipped = clip(text, budget);
    spent += clipped.length;
    parts.push(`--- frame ${frame.frameId} (${frame.href}) ---\n${clipped}`);
  }
  return parts.join("\n\n");
}

/**
 * A compact map of every frame the agent can address, including ones whose text
 * was skipped or empty. Without this the model sees refs like `9#12` with no
 * way to learn what frame 9 is, and has no reason to try `read_page`.
 */
export function formatFrameMap(snap: AggregatedSnapshot): string {
  const others = orderFrames(snap.frames).filter((f) => f.frameId !== 0);
  if (!others.length) return "";
  const lines = others
    .slice(0, FRAME_MAP_MAX)
    .map((f) => {
      const title = collapseWhitespace(f.title);
      const host = hostOf(f.href);
      const label = [host, title].filter(Boolean).join(" — ");
      return `- frame ${f.frameId}: ${label || f.href || "(no url)"} · refs look like "${f.frameId}#n"`;
    });
  if (others.length > FRAME_MAP_MAX) {
    lines.push(`- …${others.length - FRAME_MAP_MAX} more frame(s)`);
  }
  return ["Frames:", ...lines].join("\n");
}

function hostOf(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

/**
 * Page-level note for a blind spot no tool can fix: a page whose main content
 * is drawn into a <canvas> (Google Docs' editor, Slides' slide surface) has no
 * text in the DOM at all. Saying so beats letting the model conclude the page
 * is empty and retry — the failure mode that wasted dozens of turns.
 */
export function detectOpaqueSurface(counts: {
  canvases: number;
  domTextChars: number;
  frames: number;
}): string | null {
  if (counts.canvases <= 0) return null;
  if (counts.domTextChars >= 200) return null;
  return (
    `Note: this page renders its content into a <canvas> (${counts.canvases} found) and exposes almost no DOM text ` +
    `(${counts.domTextChars} chars). Canvas content cannot be read by any tool — not read_page, not snapshot, not ` +
    `evaluate_js. Use the screenshot tool if you need to see it, and if the content you need is not reachable another ` +
    `way, report that instead of retrying.`
  );
}