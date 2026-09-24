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