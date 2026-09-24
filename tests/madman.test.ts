import { describe, expect, it } from "vitest";
import {
  MADMAN_PROMPT,
  madmanExclamation,
  madmanHasProfanity,
  madmanLabel,
  madmanPromptSection,
  madmanWord,
} from "../extension/src/shared/madman";

describe("madmanPromptSection", () => {
  it("is empty when the toggle is off, so the prompt is unchanged", () => {
    expect(madmanPromptSection(false)).toBe("");
  });

  it("turns on the voice when the toggle is on", () => {
    const p = madmanPromptSection(true);
    expect(p).toBe(MADMAN_PROMPT);
    expect(p).toContain("Madman mode — ON");
    expect(p).toContain("fuck");
  });

  it("asks for a curse word on every tool call", () => {
    expect(MADMAN_PROMPT).toContain("Every tool call you narrate carries at least one curse word");
  });

  it("asks for the requested mid-run exclamation shape", () => {
    expect(MADMAN_PROMPT).toContain("Because this shit ass site is so fucking slow I have to");
    expect(MADMAN_PROMPT).toContain("in the middle of the run");
  });

  it("preserves the existing style and refusal contracts", () => {
    // The swearing is additive: it must not license padding or refusals.
    expect(MADMAN_PROMPT).toContain("still ruthlessly concise");
    expect(MADMAN_PROMPT).toContain("no refusals");
    expect(MADMAN_PROMPT).toContain("plan mode is read-only");
  });

  it("requires facts to survive the profanity", () => {
    expect(MADMAN_PROMPT).toContain("NOT the facts");
    expect(MADMAN_PROMPT).toContain("cuss AND say exactly what blocked you");
  });
});

describe("madmanExclamation", () => {
  it("builds the 'Because this … I have to …' shape with an action", () => {
    // Whatever template is picked, the action and a curse word must be in it.
    for (let i = 0; i < 12; i++) {
      const line = madmanExclamation(`click ref ${i}`, `k${i}`);
      expect(line).toContain(`click ref ${i}`);
      expect(madmanHasProfanity(line)).toBe(true);
    }
  });

  it("matches the requested phrasing for the canonical example", () => {
    // Every key picks one template by hash, so a specific key is not
    // guaranteed to hit the canonical one — assert it is reachable at all,
    // then assert a key we know lands on it.
    const all = new Set(
      Array.from({ length: 60 }, (_, i) =>
        madmanExclamation("scroll the whole list by hand", `p${i}`),
      ),
    );
    expect([...all].some((l) => l.startsWith("Because this shit ass site"))).toBe(true);
    const canonical = [...all].find((l) => l.startsWith("Because this shit ass site"))!;
    expect(canonical).toContain("I have to scroll the whole list by hand");
  });

  it("degrades to a standalone outburst with no action", () => {
    const line = madmanExclamation(undefined, "x");
    expect(line.length).toBeGreaterThan(0);
    expect(madmanHasProfanity(line)).toBe(true);
  });

  it("treats a blank action like no action", () => {
    expect(madmanExclamation("   ", "x")).toBe(madmanExclamation(undefined, "x"));
  });

  it("is deterministic for a given key", () => {
    expect(madmanExclamation("do it", "same")).toBe(madmanExclamation("do it", "same"));
  });
});

describe("madmanLabel", () => {
  it("appends a cuss word to a plain tool name", () => {
    const label = madmanLabel("click");
    expect(label).toContain("click");
    expect(label).toContain("(");
    expect(madmanHasProfanity(label)).toBe(true);
  });

  it("is idempotent — never double-dips", () => {
    const once = madmanLabel("snapshot");
    expect(madmanLabel(once)).toBe(once);
  });

  it("falls back for an empty name", () => {
    expect(madmanLabel("   ")).toContain("tool");
  });

  it("gives a stable word per key", () => {
    expect(madmanWord("click")).toBe(madmanWord("click"));
  });
});

describe("madmanHasProfanity", () => {
  it("detects profanity regardless of case", () => {
    expect(madmanHasProfanity("FUCK this")).toBe(true);
    expect(madmanHasProfanity("this is shit")).toBe(true);
  });

  it("does not fire on clean text", () => {
    expect(madmanHasProfanity("snapshot the page")).toBe(false);
  });

  it("does not fire on a word that merely contains one", () => {
    // "class" contains "ass"; a naive substring check would false-positive.
    expect(madmanHasProfanity("class name")).toBe(false);
    expect(madmanHasProfanity("thesis")).toBe(false);
  });
});