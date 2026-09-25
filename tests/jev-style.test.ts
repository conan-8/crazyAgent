// The Jev pink highlight is a UI contract: a Jev-assisted step must be
// visually unmistakable, and it must never be signalled by colour alone.
//
// The stylesheet's *own* assertions live in the browser smoke
// (scripts/jev-smoke.mjs J4c/J4d/J5c), which reads the real, loaded
// stylesheet and its computed custom properties — Vite's CSS transform makes a
// `styles.css?raw` import empty, so asserting the CSS text here would be
// asserting against "".
//
// What this file covers is the panel source: that the highlight is wired to a
// real marker, and that each pink surface is paired with a text label.
import { describe, expect, it } from "vitest";
import panel from "../extension/src/sidepanel/main.tsx?raw";

describe("Jev highlight wiring", () => {
  it("keys the tool card styling off card.jev", () => {
    expect(panel).toContain("card.jev === true");
    expect(panel).toContain("card-jev");
  });

  it("keys the confirm card styling off confirm.jev", () => {
    expect(panel).toContain("is-jev");
    expect(panel).toContain("block.confirm.jev");
  });

  it("never encodes Jev state in colour alone (a text label exists)", () => {
    // The pink is always paired with the word "Jev", so the meaning survives
    // for colour-blind users and in greyscale screenshots.
    expect(panel).toContain("Jev · ");
    expect(panel).toContain("Jev flagged this");
  });

  it("keeps the judge tool rendered by name", () => {
    // The pink is driven by the tool name, not by a model-supplied field.
    expect(panel).toContain("TOOL_META");
  });
});