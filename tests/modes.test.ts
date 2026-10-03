import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  formatElapsed,
  formatTokens,
  isMutating,
  MUTATING_TOOLS,
} from "../extension/src/shared/modes";

describe("modes", () => {
  it("classifies mutating tools for the Jev risk gate", () => {
    for (const t of ["click", "type", "key", "download", "evaluate_js", "network_mock"]) {
      expect(isMutating(t)).toBe(true);
    }
    for (const t of ["snapshot", "screenshot", "read_page", "navigate", "wait_for_settle", "tabs_list"]) {
      expect(isMutating(t)).toBe(false);
    }
    expect(MUTATING_TOOLS.has("select")).toBe(true);
    expect(isMutating("paste_image")).toBe(true);
    expect(isMutating("upload")).toBe(true);
  });

  it("estimates and formats tokens", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(0);
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(2_500_000)).toBe("2.5m");
    expect(formatElapsed(83_000)).toBe("1:23");
    expect(formatElapsed(5_000)).toBe("0:05");
  });
});
