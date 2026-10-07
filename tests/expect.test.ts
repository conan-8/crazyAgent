import { describe, expect, it } from "vitest";
import {
  describeExpectLine,
  expectCheckCount,
  expectNeedsWorkspaceExport,
  parseExpect,
} from "../extension/src/shared/expect";
import { checkStepExpect, expectFailed } from "../extension/src/background/tools/expect";
import type { EffectVerdict } from "../extension/src/shared/frame-diff";

describe("parseExpect", () => {
  it("accepts every documented key", () => {
    const out = parseExpect({
      export_contains: "<table",
      toolbar_style: "Heading 1",
      dialog: "closed",
      text_landed: "Feature Test Document",
      pixel_changed: true,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(expectCheckCount(out.expect)).toBe(5);
      expect(expectNeedsWorkspaceExport(out.expect)).toBe(true);
      expect(describeExpectLine(out.expect!)).toContain('the exported HTML contains "<table"');
      expect(describeExpectLine(out.expect!)).toContain('the dialog is closed');
    }
  });

  it("treats undefined/null/empty as no promise at all", () => {
    for (const raw of [undefined, null, {}]) {
      const out = parseExpect(raw);
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.expect).toBeUndefined();
    }
  });

  it("rejects an unknown key with the real vocabulary (a typo must not vanish)", () => {
    const out = parseExpect({ exported_contains: "<table" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("unknown expect key");
      expect(out.error).toContain("export_contains");
    }
  });

  it("rejects wrong types and bad enum values", () => {
    expect(parseExpect({ text_landed: 5 }).ok).toBe(false);
    expect(parseExpect({ pixel_changed: "yes" }).ok).toBe(false);
    expect(parseExpect({ dialog: "maybe" }).ok).toBe(false);
    expect(parseExpect("export_contains:<table").ok).toBe(false);
  });

  it("drops blank string values rather than promising an empty needle", () => {
    const out = parseExpect({ text_landed: "  ", pixel_changed: false });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.expect).toEqual({ pixel_changed: false });
  });

  it("knows the checks that need the Workspace export", () => {
    expect(expectNeedsWorkspaceExport({ toolbar_style: "Title" })).toBe(true);
    expect(expectNeedsWorkspaceExport({ text_landed: "x" })).toBe(false);
  });
});

describe("checkStepExpect", () => {
  const ctx = (over: Partial<Parameters<typeof checkStepExpect>[0]>) =>
    ({
      tabId: 1,
      adapter: {} as never,
      expect: {},
      observationText: null,
      verdict: null,
      ...over,
    }) as Parameters<typeof checkStepExpect>[0];

  it("verifies pixel_changed:true when the frame changed", async () => {
    const verdict: EffectVerdict = { verdict: "changed", detail: "" };
    const line = await checkStepExpect(ctx({ expect: { pixel_changed: true }, verdict }));
    expect(line).toContain("verified");
    expect(expectFailed(line)).toBe(false);
  });

  it("fails pixel_changed:true on a no-op and says what that means", async () => {
    const verdict: EffectVerdict = { verdict: "unchanged", detail: "" };
    const line = await checkStepExpect(ctx({ expect: { pixel_changed: true }, verdict }));
    expect(expectFailed(line)).toBe(true);
    expect(line).toContain("the frame did NOT change");
    expect(line).toContain("you promised a visible effect");
  });

  it("fails pixel_changed:false when the page did move", async () => {
    const verdict: EffectVerdict = { verdict: "changed", detail: "" };
    const line = await checkStepExpect(ctx({ expect: { pixel_changed: false }, verdict }));
    expect(expectFailed(line)).toBe(true);
    expect(line).toContain("you promised it would not");
  });

  it("is honest when the frame comparison was not possible", async () => {
    const verdict: EffectVerdict = { verdict: "unknown", detail: "" };
    const line = await checkStepExpect(ctx({ expect: { pixel_changed: true }, verdict }));
    expect(line).toContain("unverified");
    expect(expectFailed(line)).toBe(false);
  });

  it("checks text_landed against the digest, case-insensitively", async () => {
    const ok = await checkStepExpect(
      ctx({ expect: { text_landed: "feature test" }, observationText: "Visible text: Feature Test Document" }),
    );
    expect(ok).toContain("verified");
    const bad = await checkStepExpect(
      ctx({ expect: { text_landed: "Feature Test Document" }, observationText: "Visible text: Untitled document" }),
    );
    expect(expectFailed(bad)).toBe(true);
    expect(bad).toContain("does NOT contain");
  });

  it("reports a mix: what held and what did not", async () => {
    const verdict: EffectVerdict = { verdict: "changed", detail: "" };
    const line = await checkStepExpect(
      ctx({
        expect: { pixel_changed: true, text_landed: "Nope" },
        verdict,
        observationText: "Visible text: something else",
      }),
    );
    expect(expectFailed(line)).toBe(true);
    expect(line).toContain("held: the frame visibly changed");
  });

  it("returns nothing to check for an empty expectation", async () => {
    expect(await checkStepExpect(ctx({ expect: {} }))).toBeUndefined();
  });
});