import { describe, expect, it } from "vitest";
import { buildSystemPrompt, timeLine } from "../extension/src/background/agent/prompts";

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

describe("the model's clock", () => {
  it("always carries the wall clock", () => {
    const p = buildSystemPrompt("t", "auto");
    expect(p).toContain("Current date and time:");
    // The model must be told how to USE the clock, not just what it reads.
    expect(p).toContain("resolve every relative date");
    expect(p).toContain("A resumed task may have paused");
  });

  it("renders a local-time clock with weekday and offset", () => {
    // Local-time constructor: asserts the rendering, not the host timezone.
    const line = timeLine(new Date(2024, 0, 9, 14, 5, 3)); // Tue 9 Jan 2024
    expect(line).toContain("2024-01-09T14:05:03");
    expect(line).toContain("Tuesday");
    expect(line).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  it("zero-pads every field", () => {
    const line = timeLine(new Date(2024, 10, 3, 4, 6, 7));
    expect(line).toContain("2024-11-03T04:06:07");
    expect(line).toContain("Sunday");
  });

  it("carries the clock in every mode, madman state and judge config", () => {
    for (const mode of ["auto", "plan", "build"]) {
      for (const madman of [false, true]) {
        for (const judge of [false, true]) {
          expect(buildSystemPrompt("t", mode, madman, judge)).toContain(
            "Current date and time:",
          );
        }
      }
    }
  });

  it("puts the clock at the end so the stable prefix survives caching", () => {
    const p = buildSystemPrompt("t", "auto", false, false, new Date(2024, 0, 9, 14, 5, 3));
    const at = p.indexOf("Current date and time:");
    expect(at).toBeGreaterThan(p.indexOf("Never invent refs"));
    // Task stays last; only the clock line separates them.
    expect(p.indexOf("Current task:")).toBeGreaterThan(at);
  });

  it("keeps the prefix above the clock byte-stable across steps", () => {
    const a = buildSystemPrompt("same", "auto", false, false, new Date(2024, 0, 9, 14, 5, 3));
    const b = buildSystemPrompt("same", "auto", false, false, new Date(2024, 0, 9, 15, 47, 31));
    const cut = (s: string) => s.slice(0, s.indexOf("Current date and time:"));
    expect(cut(a)).toBe(cut(b));
    // But the clock itself really does move.
    expect(a).not.toBe(b);
  });
});
