// The debugger adapter's domain-enabling path. `Runtime.evaluate` only honours
// `allowUnsafeEvalBlockedByCSP` while `Runtime` is enabled — the missing piece
// behind the "CSP blocked my JS on Google Docs" failure — so these tests pin the
// enable-once-per-tab behaviour and the fact that enabling never breaks a call.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DebuggerAdapter } from "../extension/src/background/adapters/debugger";

type Call = [unknown, string, unknown];

let sendCommand: ReturnType<typeof vi.fn>;
let detachListeners: ((source: unknown, reason: string) => void)[];

beforeEach(() => {
  sendCommand = vi.fn().mockResolvedValue({ ok: true });
  detachListeners = [];
  (globalThis as { chrome?: unknown }).chrome = {
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand,
      onDetach: {
        addListener: (fn: (source: unknown, reason: string) => void) => detachListeners.push(fn),
      },
    },
  };
});

const calls = (): Call[] => sendCommand.mock.calls as Call[];
const methods = (): string[] => calls().map((c) => c[1]);

describe("DebuggerAdapter.sendEnabled", () => {
  it("enables the domain once, then sends the command each time", async () => {
    const adapter = new DebuggerAdapter();
    await adapter.sendEnabled(7, "Runtime", "Runtime.evaluate", { expression: "1+1" });
    await adapter.sendEnabled(7, "Runtime", "Runtime.evaluate", { expression: "2+2" });

    expect(methods()).toEqual([
      "Runtime.enable",
      "Runtime.evaluate",
      "Runtime.evaluate", // not enabled twice
    ]);
    expect(calls()[1]).toEqual([{ tabId: 7 }, "Runtime.evaluate", { expression: "1+1" }]);
  });

  it("enables per tab, not globally", async () => {
    const adapter = new DebuggerAdapter();
    await adapter.sendEnabled(7, "Runtime", "Runtime.evaluate", {});
    await adapter.sendEnabled(8, "Runtime", "Runtime.evaluate", {});
    expect(methods()).toEqual([
      "Runtime.enable",
      "Runtime.evaluate",
      "Runtime.enable",
      "Runtime.evaluate",
    ]);
  });

  it("sends the command even when the domain cannot be enabled", async () => {
    sendCommand
      .mockRejectedValueOnce(new Error("'Runtime.enable' wasn't found"))
      .mockResolvedValueOnce({ result: { type: "number", value: 2 } });
    const adapter = new DebuggerAdapter();
    const out = await adapter.sendEnabled(7, "Runtime", "Runtime.evaluate", { expression: "1+1" });
    expect(out).toEqual({ result: { type: "number", value: 2 } });
    expect(methods()).toEqual(["Runtime.enable", "Runtime.evaluate"]);
  });

  it("retries the enable after a failure instead of giving up on the tab", async () => {
    sendCommand
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValue({});
    const adapter = new DebuggerAdapter();
    await adapter.sendEnabled(7, "Runtime", "Runtime.evaluate", {});
    await adapter.sendEnabled(7, "Runtime", "Runtime.evaluate", {});
    expect(methods()).toEqual([
      "Runtime.enable",
      "Runtime.evaluate",
      "Runtime.enable",
      "Runtime.evaluate",
    ]);
  });

  it("re-enables after a detach — a new session needs Runtime on again", async () => {
    const adapter = new DebuggerAdapter();
    await adapter.sendEnabled(7, "Runtime", "Runtime.evaluate", {});
    detachListeners.forEach((fn) => fn({ tabId: 7 }, "target_closed"));
    await adapter.sendEnabled(7, "Runtime", "Runtime.evaluate", {});
    expect(methods()).toEqual([
      "Runtime.enable",
      "Runtime.evaluate",
      "Runtime.enable",
      "Runtime.evaluate",
    ]);
  });

  it("keeps plain send untouched (no implicit enable)", async () => {
    const adapter = new DebuggerAdapter();
    await adapter.send(7, "Page.captureScreenshot", { format: "jpeg" });
    expect(methods()).toEqual(["Page.captureScreenshot"]);
  });
});