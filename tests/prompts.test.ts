import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../extension/src/background/agent/prompts";

describe("buildSystemPrompt", () => {
  it("pins the concise-but-complete style contract", () => {
    const p = buildSystemPrompt("Do the thing", 40, "auto");
    expect(p).toContain("ruthlessly concise WITHOUT losing information");
    expect(p).toContain("No preamble");
    expect(p).toContain("compress the wording, never the content");
    expect(p).toContain("super concise, information-complete");
  });

  it("carries the task and budget", () => {
    const p = buildSystemPrompt("Summarize page X", 12, "auto");
    expect(p).toContain("Summarize page X");
    expect(p).toContain("at most 12 steps");
  });

  it("is mode-aware", () => {
    expect(buildSystemPrompt("t", 5, "plan")).toContain("STRICTLY READ-ONLY");
    expect(buildSystemPrompt("t", 5, "build")).toContain("to completion");
    expect(buildSystemPrompt("t", 5, "auto")).toContain("decide per step");
    expect(buildSystemPrompt("t", 5, "bogus")).toContain("decide per step"); // falls back
  });
});
