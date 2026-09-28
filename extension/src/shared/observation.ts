// Post-action observations: every page action returns a fresh snapshot, and on
// pages whose chrome never changes (canvas document editors are the extreme —
// the whole menu-ref list repeats for every keystroke) identical dumps are pure
// context cost. A run spent millions of tokens re-receiving the same Google
// Docs snapshot per key press. The fix is a cheap equality check: an unchanged
// page is reported in one line instead of thousands of tokens.
//
// Pure helpers so the comparison is unit-tested without a browser.

/**
 * Strip the volatile bits of a snapshot digest before comparing: Docs' UI
 * carries relative times ("Last edit was 4 minutes ago") and save state
 * ("Saving…" / "Saved to Drive") that flap between otherwise identical
 * snapshots. Comparison-only — never shown to the model.
 */
export function normalizeObservation(text: string): string {
  return text
    .replace(/\b\d+\s*(second|minute|hour|day)s?\s*ago\b/gi, "<time>")
    .replace(/\b(saving|saved)(\s+to\s+drive)?(\s*…|\.\.\.)?/gi, "<save>")
    .trim();
}

/**
 * True when two observations describe the same page state. Exact matches are
 * the common case; normalization catches the time/save-state flap on top.
 */
export function sameObservation(prev: string, next: string): boolean {
  return normalizeObservation(prev) === normalizeObservation(next);
}
