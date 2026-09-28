import { describe, expect, it } from "vitest";
import { normalizeObservation, sameObservation } from "../extension/src/shared/observation";

// The collapse that keeps long canvas-editor runs affordable: an unchanged
// page must cost one line, not another full snapshot. A live run typing
// "hello" into a Google Doc burned 2.38M tokens, most of it byte-identical
// chrome snapshots repeated per keystroke.

const DOCS_SNAPSHOT = `URL: https://docs.google.com/document/d/x/edit
Visible text: Conan Doc Title Ask Gemini File Edit View Conquering challenges Last edit was 4 minutes ago Saved to Drive
Interactive elements (ref tag "name"):
0#1 button "Bold"
0#2 button "Undo"`;

describe("sameObservation", () => {
  it("collapses a byte-identical observation", () => {
    expect(sameObservation(DOCS_SNAPSHOT, DOCS_SNAPSHOT)).toBe(true);
  });

  it("survives the relative-time and save-state flap of an unchanged page", () => {
    const later = DOCS_SNAPSHOT.replace("4 minutes ago", "12 minutes ago").replace(
      "Saved to Drive",
      "Saving…",
    );
    expect(sameObservation(DOCS_SNAPSHOT, later)).toBe(true);
  });

  it("never collapses a real page change", () => {
    const changed = DOCS_SNAPSHOT.replace('0#2 button "Undo"', '0#2 button "Undo"\n0#3 button "Redo"');
    expect(sameObservation(DOCS_SNAPSHOT, changed)).toBe(false);
  });

  it("catches a text change even when only one word moved", () => {
    const changed = DOCS_SNAPSHOT.replace("Conquering challenges", "Conquering dragons");
    expect(sameObservation(DOCS_SNAPSHOT, changed)).toBe(false);
  });
});

describe("normalizeObservation", () => {
  it("normalizes only volatile phrases, leaving content intact", () => {
    const out = normalizeObservation("Last edit was 2 days ago · Saving… · hello world");
    expect(out).toBe("Last edit was <time> · <save> · hello world");
  });

  it("is idempotent", () => {
    const once = normalizeObservation(DOCS_SNAPSHOT);
    expect(normalizeObservation(once)).toBe(once);
  });
});
