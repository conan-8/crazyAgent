import { describe, expect, it, vi } from "vitest";
import {
  describeEvalFailure,
  isCspBlocked,
  isTrustedTypesBlocked,
  shapeEvalResult,
  trustedTypesRefusal,
} from "../extension/src/background/tools/misc";
import { toolRegistry, type ToolContext } from "../extension/src/background/tools/types";

/** The exact EvalError a strict-CSP site (Google Docs, Schoology) raises. */
const CSP_EVAL_ERROR =
  "EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:* chrome-extension://919a3b0f-d9f1-4d03-96ec-4b6e205dccc7/\".";

describe("shapeEvalResult", () => {
  it("JSON-stringifies by-value results", () => {
    expect(shapeEvalResult({ result: { type: "object", value: { a: 1 } } })).toEqual({
      ok: true,
      value: '{"a":1}',
    });
    expect(shapeEvalResult({ result: { type: "undefined" } })).toEqual({ ok: true, value: "null" });
  });

  it("passes string results through verbatim — never double-encoded", () => {
    // Expressions commonly return JSON.stringify(…); re-stringifying that
    // produced "\"{\\\"a\\\":1}\" soup and made "&" vs "&amp;" ambiguous.
    expect(shapeEvalResult({ result: { type: "string", value: '{"a":1}' } })).toEqual({
      ok: true,
      value: '{"a":1}',
    });
    expect(shapeEvalResult({ result: { type: "string", value: "Read & Respond" } })).toEqual({
      ok: true,
      value: "Read & Respond",
    });
    // Long strings still clip.
    const long = shapeEvalResult({ result: { type: "string", value: "x".repeat(5_000) } });
    expect((long as { value: string }).value.length).toBe(4_000);
  });

  it("passes through unserializable numbers and describes functions", () => {
    expect(
      shapeEvalResult({ result: { type: "number", unserializableValue: "NaN" } }),
    ).toEqual({ ok: true, value: "NaN" });
    expect(
      shapeEvalResult({ result: { type: "function", description: "function f() {}" } }),
    ).toEqual({ ok: true, value: "function f() {}" });
  });

  it("reports exceptions", () => {
    expect(
      shapeEvalResult({
        result: { type: "object" },
        exceptionDetails: {
          text: "Uncaught",
          exception: { type: "object", description: "ReferenceError: x is not defined" },
        },
      }),
    ).toEqual({ ok: false, error: "ReferenceError: x is not defined" });
  });

  it("turns a CSP refusal into an actionable error, keeping the original", () => {
    const out = shapeEvalResult({
      result: { type: "object" },
      exceptionDetails: { text: "Uncaught", exception: { type: "object", description: CSP_EVAL_ERROR } },
    });
    expect(out.ok).toBe(false);
    const error = (out as { error: string }).error;
    expect(error).toContain("CSP-BLOCKED");
    expect(error).toContain(CSP_EVAL_ERROR); // evidence is never swallowed
    expect(error).toContain("bypass_csp:true");
    expect(error).toContain("Do NOT retry the same expression");
  });
});

describe("isCspBlocked / describeEvalFailure", () => {
  it("detects the page-CSP refusal", () => {
    expect(isCspBlocked(CSP_EVAL_ERROR)).toBe(true);
    expect(isCspBlocked("EvalError: refused to evaluate")).toBe(true);
  });

  it("leaves ordinary JS errors untouched", () => {
    const plain = "TypeError: Cannot read properties of undefined (reading 'query')";
    expect(isCspBlocked(plain)).toBe(false);
    expect(describeEvalFailure(plain)).toBe(plain);
  });

  it("names the ref-based tools as the CSP-proof route", () => {
    const hint = describeEvalFailure(CSP_EVAL_ERROR);
    expect(hint).toContain("read_page");
    expect(hint).toContain("snapshot");
    expect(hint).toContain("unaffected by CSP");
  });
});

describe("Trusted Types guard", () => {
  /** The exact TypeErrors the 2026-10-06 Docs run hit four times. */
  const TT_INNERHTML =
    "TypeError: Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.";
  const TT_PARSER =
    "TypeError: Failed to execute 'parseFromString' on 'DOMParser': This document requires 'TrustedHTML' assignment.";

  it("detects Trusted-Types refusals and rewrites them with the working routes", () => {
    expect(isTrustedTypesBlocked(TT_INNERHTML)).toBe(true);
    expect(isTrustedTypesBlocked(TT_PARSER)).toBe(true);
    const hint = describeEvalFailure(TT_PARSER);
    expect(hint).toContain("TRUSTED-TYPES-BLOCKED");
    expect(hint).toContain(TT_PARSER); // evidence is never swallowed
    expect(hint).toContain("docs_read");
    expect(hint).toContain("Do NOT retry");
    // A plain TypeError is untouched.
    const plain = "TypeError: x is not a function";
    expect(isTrustedTypesBlocked(plain)).toBe(false);
    expect(describeEvalFailure(plain)).toBe(plain);
  });

  it("pre-screens blocked sinks on Workspace hosts — and only ASSIGNMENTS", async () => {
    const tabGet = vi.fn().mockResolvedValue({ url: "https://docs.google.com/document/d/1/edit" });
    vi.stubGlobal("chrome", { tabs: { get: tabGet } });
    try {
      const refuse = await trustedTypesRefusal(7, "el.innerHTML = '<b>x</b>'");
      expect(refuse).toContain("Trusted Types");
      expect(refuse).toContain("docs_read");
      expect(await trustedTypesRefusal(7, "new DOMParser().parseFromString(html, 'text/html')")).toBeTruthy();
      expect(await trustedTypesRefusal(7, "d.insertAdjacentHTML('beforeend', row)")).toBeTruthy();
      // READS of innerHTML are legal on Trusted-Types pages — never screened.
      expect(await trustedTypesRefusal(7, "JSON.stringify(el.innerHTML.slice(0,99))")).toBeNull();
      expect(await trustedTypesRefusal(7, "el.textContent")).toBeNull();
      // A non-Workspace host runs the expression (post-hoc rewrite is the net).
      tabGet.mockResolvedValue({ url: "https://example.com/app" });
      expect(await trustedTypesRefusal(7, "el.innerHTML = '<b>x</b>'")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails safe when chrome.tabs is unavailable", async () => {
    vi.stubGlobal("chrome", undefined);
    try {
      expect(await trustedTypesRefusal(7, "el.innerHTML = 'x'")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("evaluate_js", () => {
  function ctxWith(send: ToolContext["adapter"]["send"]): ToolContext {
    return {
      tabId: 7,
      adapter: { send, screenshot: vi.fn() },
      emit: vi.fn(),
    };
  }

  it("enables Runtime before evaluating — that is what makes CSP-proofing work", async () => {
    const sendEnabled = vi.fn().mockResolvedValue({ result: { type: "number", value: 2 } });
    const ctx: ToolContext = {
      tabId: 7,
      adapter: { send: vi.fn(), sendEnabled, screenshot: vi.fn() },
      emit: vi.fn(),
    };
    const out = await toolRegistry.get("evaluate_js")!.run({ expression: "1+1" }, ctx);
    expect(out).toEqual({ ok: true, value: "2" });
    expect(sendEnabled).toHaveBeenCalledWith(
      7,
      "Runtime",
      "Runtime.evaluate",
      expect.objectContaining({ expression: "1+1", allowUnsafeEvalBlockedByCSP: true }),
    );
  });

  it("falls back to a plain send when the adapter cannot enable domains", async () => {
    const send = vi.fn().mockResolvedValue({ result: { type: "number", value: 2 } });
    const out = await toolRegistry.get("evaluate_js")!.run({ expression: "1+1" }, ctxWith(send));
    expect(out).toEqual({ ok: true, value: "2" });
    expect(send).toHaveBeenCalledWith(7, "Runtime.evaluate", expect.anything());
  });

  it("enables Page.setBypassCSP before evaluating when asked", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ result: { type: "string", value: "ok" } });
    const out = await toolRegistry
      .get("evaluate_js")!
      .run({ expression: "'ok'", bypass_csp: true }, ctxWith(send));
    expect(send.mock.calls[0]).toEqual([7, "Page.setBypassCSP", { enabled: true }]);
    expect(send.mock.calls[1]?.[1]).toBe("Runtime.evaluate");
    // String results pass through verbatim (no double-encoding).
    expect(out).toMatchObject({ ok: true, value: "ok", cspBypass: expect.any(String) });
  });
});
