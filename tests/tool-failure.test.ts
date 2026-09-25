// Tool-failure classification. A real run reported failures as the bare string
// "fetch failed", leaving the model unable to tell a dead tab from a CSP refusal
// from a bad argument — so it retried the same call 20 times.
import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  describeToolFailure,
  failureTag,
  isClassified,
} from "../extension/src/shared/tool-failure";

describe("classifyFailure", () => {
  it("names the transport layer for a bare 'fetch failed'", () => {
    const f = classifyFailure(new TypeError("fetch failed"));
    expect(f.layer).toBe("transport");
    expect(f.detail).toBe("fetch failed");
    expect(f.message).toContain(failureTag("transport"));
    // It must actively discourage the retry loop that actually happened.
    expect(f.message).toContain("Do NOT retry the same call repeatedly");
  });

  it("strips the Error prefix rather than printing 'Error: …'", () => {
    expect(classifyFailure(new Error("boom")).detail).toBe("boom");
    expect(classifyFailure("plain string").detail).toBe("plain string");
  });

  it("recognises a debugger already attached to the tab", () => {
    const f = classifyFailure(new Error("Another debugger is already attached to the tab with id: 7"));
    expect(f.layer).toBe("transport");
    expect(f.message).toContain("transport problem, not a problem with the page");
  });

  it("recognises a missing content script", () => {
    const f = classifyFailure(
      new Error("Could not establish connection. Receiving end does not exist."),
    );
    expect(f.layer).toBe("injection");
    expect(f.message).toContain("chrome:// page");
  });

  it("recognises a CSP refusal", () => {
    const f = classifyFailure(
      "EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive",
    );
    expect(f.layer).toBe("csp");
    expect(f.message).toContain("bypass_csp");
  });

  it("recognises an unaddressable frame or stale ref", () => {
    expect(classifyFailure(new Error("no execution context for frame 9999")).layer).toBe("frame");
    const stale = classifyFailure(new Error("stale or unknown ref: 12 — take a fresh snapshot"));
    expect(stale.layer).toBe("frame");
    expect(stale.message).toContain("fresh snapshot");
  });

  it("recognises bad arguments", () => {
    const f = classifyFailure("ERROR: missing required parameter: ref");
    expect(f.layer).toBe("input");
    expect(f.message).toContain("fix the arguments");
  });

  it("survives a non-Error, non-string throw", () => {
    expect(classifyFailure(undefined).layer).toBe("unknown");
    expect(classifyFailure(null).detail).toBe("unknown error");
    expect(classifyFailure({ message: "structured" }).detail).toBe("structured");
    expect(classifyFailure({ reason: "from reason" }).detail).toBe("from reason");
    expect(classifyFailure({ odd: true }).layer).toBe("unknown");
  });

  it("always preserves the original text", () => {
    for (const input of ["fetch failed", new Error("x"), 42 as unknown]) {
      expect(classifyFailure(input).detail.length).toBeGreaterThan(0);
    }
  });
});

describe("describeToolFailure", () => {
  it("passes an already-classified message through untouched", () => {
    // evaluate_js tags its own CSP refusals; that specific guidance must win.
    const own =
      "CSP-BLOCKED: this page's Content-Security-Policy forbids evaluating JavaScript … retry once with bypass_csp:true";
    expect(describeToolFailure(own)).toBe(own);
  });

  it("classifies an unclassified message", () => {
    const out = describeToolFailure(new TypeError("fetch failed"));
    expect(out).toContain("TRANSPORT-FAILED");
  });

  it("does not double-tag a classified message", () => {
    const once = describeToolFailure(new Error("Receiving end does not exist"));
    expect(isClassified(once)).toBe(true);
    expect(describeToolFailure(once)).toBe(once);
    expect(once.match(/INJECTION-FAILED/g)).toHaveLength(1);
  });
});