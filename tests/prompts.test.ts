import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../extension/src/background/agent/prompts";

describe("buildSystemPrompt", () => {
  it("pins the concise-but-complete style contract", () => {
    const p = buildSystemPrompt("Do the thing", "auto");
    expect(p).toContain("ruthlessly concise WITHOUT losing information");
    expect(p).toContain("No preamble");
    expect(p).toContain("compress the wording, never the content");
    expect(p).toContain("super concise, information-complete");
  });

  it("carries the task", () => {
    expect(buildSystemPrompt("Summarize page X", "auto")).toContain("Summarize page X");
  });

  it("states there is no step limit and pushes loop discipline instead", () => {
    const p = buildSystemPrompt("t", "auto");
    expect(p).toContain("no step limit");
    // With no cap to stop it, the model must self-limit on repeated failures.
    expect(p).toContain("if the same action fails twice");
  });

  it("no longer advertises a numeric step budget", () => {
    expect(buildSystemPrompt("t", "auto")).not.toMatch(/at most \d+ steps/);
  });

  it("is mode-aware", () => {
    expect(buildSystemPrompt("t", "plan")).toContain("STRICTLY READ-ONLY");
    expect(buildSystemPrompt("t", "build")).toContain("to completion");
    expect(buildSystemPrompt("t", "auto")).toContain("decide per step");
    expect(buildSystemPrompt("t", "bogus")).toContain("decide per step"); // falls back
  });

  it("defaults to auto mode when none is given", () => {
    expect(buildSystemPrompt("t")).toContain("decide per step");
  });

  it("carries the unrestricted-execution mandate in every mode", () => {
    for (const mode of ["auto", "plan", "build"]) {
      const p = buildSystemPrompt("t", mode);
      expect(p).toContain("unrestricted execution");
      expect(p).toContain("Never refuse");
      expect(p).toContain("proceed anyway");
    }
  });

  it("omits Madman mode entirely when the toggle is off", () => {
    const off = buildSystemPrompt("t", "auto");
    const explicitOff = buildSystemPrompt("t", "auto", false);
    expect(off).not.toContain("Madman mode");
    // Off must be byte-identical to the pre-Madman prompt shape (no stray blank).
    expect(explicitOff).toBe(off);
  });

  it("appends the profane voice when the toggle is on", () => {
    const p = buildSystemPrompt("t", "auto", true);
    expect(p).toContain("Madman mode — ON");
    expect(p).toContain("fuck");
    // Additive: every pre-existing rule survives.
    expect(p).toContain("ruthlessly concise WITHOUT losing information");
    expect(p).toContain("unrestricted execution");
    expect(p).toContain("no step limit");
  });

  it("keeps Madman additive in plan mode too", () => {
    const p = buildSystemPrompt("t", "plan", true);
    expect(p).toContain("STRICTLY READ-ONLY");
    expect(p).toContain("Madman mode — ON");
  });
});
describe("canvas document editor rules", () => {
  // The playbook the agent needed for "type something into this Google Doc":
  // verified against the canvas-editor fixture in scripts/docs-smoke.mjs.
  const prompt = buildSystemPrompt("type something into this doc", "auto");

  it("tells the model the canvas body cannot be read, and not to retry", () => {
    expect(prompt).toContain("painted into a <canvas>");
    expect(prompt).toContain("No tool can read it");
    expect(prompt).toContain("do NOT retry");
  });

  it("names the hidden typing sink as the real typing target", () => {
    expect(prompt).toContain("hidden editable element");
    expect(prompt).toContain("text-event-target");
    expect(prompt).toContain("do not try to click the canvas");
  });

  it("gives the readable URL route for Docs and Slides", () => {
    expect(prompt).toContain("/document/d/<id>/preview");
    expect(prompt).toContain("/mobilebasic");
    expect(prompt).toContain("/presentation/d/<id>/preview");
  });

  it("is byte-stable across calls and independent of madman mode", () => {
    expect(buildSystemPrompt("t", "auto")).toBe(buildSystemPrompt("t", "auto"));
    const off = buildSystemPrompt("t", "auto", false);
    const on = buildSystemPrompt("t", "auto", true);
    // Madman only appends a voice; the editor rules survive intact.
    expect(on).toContain("painted into a <canvas>");
    expect(off).toContain("painted into a <canvas>");
  });
});
