// Frame differencing — the cheap, deterministic answer to "did that action
// actually change anything?".
//
// Priced from the 2026-10-06 field runs: the E2 class of failure was a silent
// no-op discovered turns later ("Title style didn't apply (toolbar still shows
// Normal text)", "paste didn't land", "image insertion didn't land", "fill
// didn't apply"). Every mutating action already pays for a before/after look —
// the screenshot attached to canvas results and the snapshot digest on
// ordinary pages — and both were thrown away after being shown to the model.
// This module turns those two frames into a verdict the HARNESS can act on, so
// a no-op is reported in the same result instead of five turns later.
//
// Pure: the caller supplies luminance grids (the decode lives in
// background/tools/perception.ts, where OffscreenCanvas already runs for
// screenshot downscaling). Thresholds are named and explained because they are
// the tuning knobs the next field test will move.
/** A coarse luminance grid of one frame — the unit of comparison. */
export interface FrameSignature {
  cols: number;
  rows: number;
  /** Mean luminance per cell (0-255), row-major, length cols*rows. */
  cells: number[];
}

/**
 * Grid resolution, MEASURED on the canvas fixture (2026-10-07): at 32x20 a
 * six-character insertion into a document line moved its best cell by ONE
 * luminance unit — invisible — while the same pair of captures at 96x60
 * showed eleven cells past the noise floor (max delta 235). Two back-to-back
 * captures of an unchanged page differ by exactly zero at 96x60, so the finer
 * grid costs nothing but a few KB.
 */
export const DIFF_COLS = 96;
export const DIFF_ROWS = 60;

/**
 * A single cell is "strongly" changed at this luminance delta. A 40x35 CSS px
 * cell that becomes highlighted (a toolbar toggle, a selected row) moves far
 * more than this; a text caret inside one cell moves it ~12.
 */
export const STRONG_CELL_DELTA = 40;
/**
 * A cell counts as changed at all at this delta. This is the whole detection
 * floor: the field-test fixture showed a six-character insertion moving ONE
 * cell by ~14, and calling that "no visible change" would cry wolf on the most
 * common action there is. Measured noise stays under it (a blinking caret
 * moves a cell by ~6, JPEG re-encode grain by 1-3), so the bias is deliberate:
 * a false "changed" costs nothing, a false "unchanged" misleads the model and
 * can trigger a repair.
 */
export const CELL_DELTA = 12;
/** Share of cells that marks a change as BROAD (used to word the report). */
export const BROAD_CHANGE_RATIO = 0.005;
/** Cap on how many cells are examined — the grid is fixed, so this is a guard
 *  against a caller passing a mismatched pair rather than a real limit. */
const MAX_CELLS = DIFF_COLS * DIFF_ROWS * 4;

export interface FrameDiff {
  /** Share of cells whose luminance moved past CELL_DELTA (0..1). */
  changedRatio: number;
  /** Cells that moved past STRONG_CELL_DELTA. */
  strongCells: number;
  /** Bounding box of every changed cell, in CELL coordinates (null = none). */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  changed: boolean;
}

/** Build a signature from a luminance sample (0-255 per cell, row-major). */
export function signatureFromLuminance(values: number[], cols: number, rows: number): FrameSignature {
  const want = cols * rows;
  const cells = values.slice(0, want).map((v) => (Number.isFinite(v) ? Math.max(0, Math.min(255, v)) : 0));
  while (cells.length < want) cells.push(0);
  return { cols, rows, cells };
}

/**
 * Compare two frames. Returns null when the grids do not describe the same
 * shape (a resized window, a rotated device, a crop) — an honest "cannot
 * compare", never a guess.
 */
export function diffFrames(a: FrameSignature, b: FrameSignature): FrameDiff | null {
  if (a.cols !== b.cols || a.rows !== b.rows) return null;
  const n = a.cols * a.rows;
  if (n <= 0 || n > MAX_CELLS || a.cells.length < n || b.cells.length < n) return null;
  let changedCells = 0;
  let strongCells = 0;
  let x0 = a.cols;
  let y0 = a.rows;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < n; i++) {
    const delta = Math.abs(a.cells[i]! - b.cells[i]!);
    if (delta < CELL_DELTA) continue;
    changedCells += 1;
    if (delta >= STRONG_CELL_DELTA) strongCells += 1;
    const x = i % a.cols;
    const y = Math.floor(i / a.cols);
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const changedRatio = changedCells / n;
  return {
    changedRatio,
    strongCells,
    box: changedCells ? { x0, y0, x1, y1 } : null,
    // One cell past the noise floor is a change: a toolbar pill lighting up, a
    // glyph appearing, a row collapsing. `strongCells`/`changedRatio` survive
    // only to describe HOW BIG the change was, not to gate the verdict.
    changed: changedCells >= 1,
  };
}

/** Where a change sits, in words a model can act on ("the top-left area"). */
export function describeChangeRegion(
  box: { x0: number; y0: number; x1: number; y1: number } | null,
  cols = DIFF_COLS,
  rows = DIFF_ROWS,
): string {
  if (!box) return "";
  // One band per axis, from the box CENTRE: a wide box that touches both edges
  // is better described as spanning the frame than as sitting in one corner.
  const axis = (lo: number, hi: number, size: number): "start" | "middle" | "end" => {
    const mid = (lo + hi + 1) / 2 / size;
    return mid < 0.34 ? "start" : mid > 0.66 ? "end" : "middle";
  };
  const v = axis(box.y0, box.y1, rows);
  const h = axis(box.x0, box.x1, cols);
  const vName = v === "start" ? "top" : v === "end" ? "bottom" : "middle";
  const hName = h === "start" ? "left" : h === "end" ? "right" : "centre";
  const cells = `${box.x1 - box.x0 + 1}\u00d7${box.y1 - box.y0 + 1} cells`;
  const fullX = (box.x1 - box.x0 + 1) / cols >= 0.8;
  const fullY = (box.y1 - box.y0 + 1) / rows >= 0.8;
  if (fullX && fullY) return `across the whole frame (${cells})`;
  if (fullX) {
    return vName === "middle"
      ? `across the middle of the frame (${cells})`
      : `across the ${vName} of the frame (${cells})`;
  }
  if (fullY) {
    return hName === "centre"
      ? `down the centre of the frame (${cells})`
      : `down the ${hName} side (${cells})`;
  }
  const position =
    vName === "middle" && hName === "centre"
      ? "the centre"
      : vName === "middle"
        ? `the ${hName} side`
        : hName === "centre"
          ? `the ${vName} of the frame`
          : `the ${vName}-${hName}`;
  return `${position} (${cells})`;
}

/** The model-facing one-liner for a diff (rides the action's result). */
export function describeFrameDiff(diff: FrameDiff): string {
  const pct = Math.max(1, Math.round(diff.changedRatio * 100));
  const where = describeChangeRegion(diff.box);
  return `the frame changed (~${pct}% of the grid${where ? `, ${where}` : ""})`;
}

/** A changed/unchanged/n-a verdict with the evidence that produced it. */
export interface EffectVerdict {
  verdict: "changed" | "unchanged" | "unknown";
  /** One line for the result text; empty for "unknown". */
  detail: string;
}

/**
 * The verdict for a finished mutating action. `source` says what was compared,
 * because "unchanged" from two identical screenshots means something different
 * from "unchanged" in the text snapshot (a canvas page can repaint without the
 * digest moving at all).
 */
export function effectVerdict(
  diff: FrameDiff | null,
  source: "frame" | "digest",
): EffectVerdict {
  if (!diff) return { verdict: "unknown", detail: "" };
  if (diff.changed) {
    return {
      verdict: "changed",
      detail:
        source === "frame"
          ? `effect: ${describeFrameDiff(diff)}`
          : `effect: the page digest changed (the action had a visible result)`,
    };
  }
  return {
    verdict: "unchanged",
    detail:
      source === "frame"
        ? `effect: NO VISIBLE CHANGE — this capture is the same picture as the previous one (a change subtler than the pixel floor would also read this way). If you expected the page to change, the action was a no-op or missed: re-read the page, then change route (ref instead of coordinates, keyboard instead of the menu) rather than repeating the same call`
        : "effect: NO VISIBLE CHANGE — the page digest is identical to the previous one. If you expected the page to change, the action was a no-op or missed: re-read the page, then change route rather than repeating the same call",
  };
}

/**
 * The verdict for an ordinary page, from the snapshot digest comparison the
 * observation pipeline already performs. Weaker evidence than pixels — the
 * digest is text, so a canvas repaint would not move it (hence the caller only
 * uses this when no capture was taken) — but it still catches the common
 * no-op: a click that changed nothing in the DOM.
 */
export function digestEffect(changed: boolean): EffectVerdict {
  return changed
    ? { verdict: "changed", detail: "effect: the page digest changed (the action had a visible result)" }
    : {
        verdict: "unchanged",
        detail:
          "effect: NO VISIBLE CHANGE — the page digest is identical to the previous one. If you expected the page to change, the action was a no-op or missed: re-read the page, then change route (ref instead of coordinates, keyboard instead of the menu) rather than repeating the same call",
      };
}

/** Compose the bracket that rides an action's result text. */
export function effectLine(v: EffectVerdict): string {
  return v.detail ? `\n[${v.detail}]` : "";
}
