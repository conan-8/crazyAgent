import { describe, expect, it, vi } from "vitest";
import { shapeEvalResult } from "../extension/src/background/tools/misc";
import { toolRegistry, type ToolContext } from "../extension/src/background/tools/types";

describe("shapeEvalResult", () => {
  it("JSON-stringifies by-value results", () => {
    expect(shapeEvalResult({ result: { type: "object", value: { a: 1 } } })).toEqual({
      ok: true,
      value: '{"a":1}',
    });
    expect(shapeEvalResult({ result: { type: "undefined" } })).toEqual({ ok: true, value: "null" });
  });

  it("passes through unserializable numbers and describes functions", () => {
    expect(
      shapeEvalResult({ result: { type: "number", unserializableValue: "NaN" } }),
    ).toEqual({ ok: true, value: "NaN" });
    expect(
      shapeEvalResult({ result: { type: "function", description: "function f() {}" } }),
    ).toEqual({ ok: true, value: '"function f() {}"' });
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
});

describe("evaluate_js", () => {
  function ctxWith(send: ToolContext["adapter"]["send"]): ToolContext {
    return {
      tabId: 7,
      adapter: { send, screenshot: vi.fn() },
      emit: vi.fn(),
    };
  }

  it("evaluates over CDP without touching CSP by default", async () => {
    const send = vi.fn().mockResolvedValue({ result: { type: "number", value: 2 } });
    const out = await toolRegistry.get("evaluate_js")!.run({ expression: "1+1" }, ctxWith(send));
    expect(out).toEqual({ ok: true, value: "2" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      7,
      "Runtime.evaluate",
      expect.objectContaining({ expression: "1+1", awaitPromise: true, returnByValue: true }),
    );
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
    expect(out).toMatchObject({ ok: true, value: '"ok"', cspBypass: expect.any(String) });
  });
});
