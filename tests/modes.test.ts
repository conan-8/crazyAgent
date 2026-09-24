import { describe, expect, it } from "vitest";
import {
  AGENT_MODES,
  EFFORTS,
  effortBudget,
  estimateTokens,
  formatElapsed,
  formatTokens,
  isMutating,
  MUTATING_TOOLS,
} from "../extension/src/shared/modes";

describe("modes & effort", () => {
  it("maps effort presets to budgets", () => {
    expect(effortBudget("quick")).toEqual({ stepCap: 15, maxTokens: 1_024 });
    expect(effortBudget("balanced")).toEqual({ stepCap: 40, maxTokens: 4_096 });
    expect(effortBudget("deep")).toEqual({ stepCap: 80, maxTokens: 8_192 });
  });

  it("classifies mutating tools for plan mode", () => {
    for (const t of ["click", "type", "key", "download", "evaluate_js", "network_mock"]) {
      expect(isMutating(t)).toBe(true);
    }
    for (const t of ["snapshot", "screenshot", "read_page", "navigate", "wait_for_settle", "tabs_list"]) {
      expect(isMutating(t)).toBe(false);
    }
    expect(MUTATING_TOOLS.has("select")).toBe(true);
  });

  it("exposes mode and effort labels", () => {
    expect(AGENT_MODES.plan.label).toBe("Plan");
    expect(AGENT_MODES.plan.hint.toLowerCase()).toContain("read-only");
    expect(EFFORTS.balanced.label).toBe("Balanced");
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
