// Set-of-Mark planning: which interactive elements get a numbered box on a
// screenshot, and where each label goes. Labels ARE snapshot refs, so a mark
// the model sees is directly actionable with click / click_at {ref} — the
// model names a target instead of regressing its pixels.

export interface MarkCandidate {
  ref: string;
  name: string;
  tag: string;
  role?: string;
  /** Top-viewport CSS px (frame offsets already applied). */
  box: { x: number; y: number; w: number; h: number };
}

export interface Mark extends MarkCandidate {
  /** Label anchor (top-left of the label chip), viewport CSS px. */
  label: { x: number; y: number; w: number; h: number };
}

export const MAX_MARKS = 120;
const MIN_SIDE_PX = 4;
const LABEL_H = 14;
const CHAR_W = 7;

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Keep elements that are visibly inside the viewport and big enough to aim
 * at, smallest-first when over the cap (small controls are the ones pixel
 * aiming misses), then place each label at the box's top-left — nudged to
 * the other corners when it would cover an earlier label.
 */
export function planMarks(
  candidates: MarkCandidate[],
  viewport: { width: number; height: number },
  max = MAX_MARKS,
): Mark[] {
  const visible = candidates.filter(
    (c) =>
      c.box.w >= MIN_SIDE_PX &&
      c.box.h >= MIN_SIDE_PX &&
      c.box.x + c.box.w > 0 &&
      c.box.y + c.box.h > 0 &&
      c.box.x < viewport.width &&
      c.box.y < viewport.height &&
      // Page-sized wrappers (a contenteditable body, a full-screen link)
      // would only bury every other label.
      c.box.w * c.box.h < viewport.width * viewport.height * 0.5,
  );
  const kept =
    visible.length > max
      ? [...visible].sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h).slice(0, max)
      : visible;
  const placed: Mark[] = [];
  for (const c of kept) {
    const w = c.ref.length * CHAR_W + 6;
    const x0 = Math.max(0, Math.min(c.box.x, viewport.width - w));
    const corners = [
      { x: x0, y: c.box.y - LABEL_H },
      { x: x0, y: c.box.y },
      { x: Math.max(0, c.box.x + c.box.w - w), y: c.box.y + c.box.h - LABEL_H },
      { x: Math.max(0, c.box.x + c.box.w - w), y: c.box.y + c.box.h },
    ].map((p) => ({ x: p.x, y: Math.max(0, Math.min(p.y, viewport.height - LABEL_H)), w, h: LABEL_H }));
    const label = corners.find((l) => !placed.some((m) => overlaps(m.label, l))) ?? corners[0]!;
    placed.push({ ...c, label });
  }
  return placed;
}

/** The text legend that rides with the marked image (ref → what it is). */
export function marksLegend(marks: Mark[], maxChars = 4_000): string {
  let out = "";
  for (const m of marks) {
    const kind = m.role ?? m.tag;
    const name = m.name.replace(/\s+/g, " ").trim().slice(0, 48);
    const row = `[${m.ref}] ${kind}${name ? ` "${name}"` : ""}\n`;
    if (out.length + row.length > maxChars) {
      out += `… (${marks.length} marks total)\n`;
      break;
    }
    out += row;
  }
  return out;
}
