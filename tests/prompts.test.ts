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
});