import { describe, expect, it } from "vitest";
import {
  compileWaitText,
  evalWaitCondition,
  parseWaitArgs,
  type WaitCondition,
  WAIT_MAX_TIMEOUT_MS,
} from "../extension/src/shared/wait";

/** Parse-or-throw helper so each assertion works on a plain condition. */
function condOf(args: Record<string, unknown>): WaitCondition {
  const spec = parseWaitArgs(args);
  if ("error" in spec) throw new Error(spec.error);
  return spec.cond;
}

describe("compileWaitText", () => {
  it("keeps plain substrings literal", () => {
    expect(compileWaitText("Answer: 42")).toEqual({ literal: "Answer: 42" });
  });

  it("compiles /regex/ forms with flags", () => {
    const out = compileWaitText("/final answer/i");
    const regex = "regex" in out ? out.regex : undefined;
    expect(regex).toBeInstanceOf(RegExp);
    expect(regex!.test("Here is the FINAL ANSWER.")).toBe(true);
  });

  it("rejects a malformed regex explicitly", () => {
    expect("error" in compileWaitText("/([unclosed/")).toBe(true);
  });
});

describe("parseWaitArgs", () => {
  it("shapes a full condition and caps the timeout", () => {
    const spec = parseWaitArgs({
      text: "/done|complete/i",
      selector_gone: ".spinner",
      stable_for_ms: 1500,
      timeout_ms: 9_999_999,
      frame: 3,
    });
    if ("error" in spec) throw new Error(spec.error);
    expect(spec.cond.textRegex).toEqual({ source: "done|complete", flags: "i" });
    expect(spec.cond.selectorGone).toBe(".spinner");
    expect(spec.cond.stableForMs).toBe(1500);
    expect(spec.cond.timeoutMs).toBe(WAIT_MAX_TIMEOUT_MS);
    expect(spec.cond.frame).toBe(3);
  });

  it("requires at least one condition", () => {
    const spec = parseWaitArgs({ timeout_ms: 1000 });
    expect("error" in spec).toBe(true);
  });

  it("validates types", () => {
    expect("error" in parseWaitArgs({ text: 42 })).toBe(true);
    expect("error" in parseWaitArgs({ stable_for_ms: "soon" })).toBe(true);
    expect("error" in parseWaitArgs({ text: "" })).toBe(true);
  });
});

describe("evalWaitCondition", () => {
  const obs = (text: string, selectorPresent: boolean | null = null) => ({ text, selectorPresent });

  it("matches a literal substring and returns an excerpt around it", () => {
    const cond = condOf({ text: "velocity" });
    const res = evalWaitCondition(
      cond,
      obs("The velocity of the particle is 12 m/s along the x axis."),
    );
    expect(res.ok).toBe(true);
    expect(res.excerpt).toContain("velocity");
  });

  it("reports unmet predicates instead of throwing", () => {
    const cond = condOf({ text: "yes", text_gone: "loading", selector: ".done" });
    const res = evalWaitCondition(cond, obs("loading…", false));
    expect(res.ok).toBe(false);
    expect(res.unmet).toEqual(["text", "text_gone", "selector"]);
  });

  it("treats an unevaluable selector as gone for selector_gone", () => {
    const cond = condOf({ selector_gone: ".spinner" });
    expect(evalWaitCondition(cond, obs("x", null)).ok).toBe(true);
    expect(evalWaitCondition(cond, obs("x", true)).ok).toBe(false);
  });

  it("honours stable_for_ms against the observed stability window", () => {
    const cond = condOf({ stable_for_ms: 2000 });
    expect(evalWaitCondition(cond, obs("still typing"), 500).ok).toBe(false);
    expect(evalWaitCondition(cond, obs("done growing"), 2500).ok).toBe(true);
  });

  it("requires every provided predicate (AND semantics)", () => {
    const cond = condOf({ text: "answer", stable_for_ms: 1000 });
    expect(evalWaitCondition(cond, obs("the answer is 4"), 50).ok).toBe(false);
    expect(evalWaitCondition(cond, obs("the answer is 4"), 1200).ok).toBe(true);
  });
});
