// The debugger adapter's domain-enabling path. `Runtime.evaluate` only honours
// `allowUnsafeEvalBlockedByCSP` while `Runtime` is enabled — the missing piece
// behind the "CSP blocked my JS on Google Docs" failure — so these tests pin the
// enable-once-per-tab behaviour and the fact that enabling never breaks a call.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DebuggerAdapter } from "../extension/src/background/adapters/debugger";

type Call = [unknown, string, unknown];

let sendCommand: ReturnType<typeof vi.fn>;
let detachListeners: ((source: unknown, reason: string) => void)[];
let eventListeners: ((source: unknown, method: string, params: unknown) => void)[];

beforeEach(() => {
  sendCommand = vi.fn().mockResolvedValue({ ok: true });
  detachListeners = [];
  eventListeners = [];
  (globalThis as { chrome?: unknown }).chrome = {
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand,
      onDetach: {
        addListener: (fn: (source: unknown, reason: string) => void) => detachListeners.push(fn),
      },
      onEvent: {
        addListener: (fn: (source: unknown, method: string, params: unknown) => void) =>
          eventListeners.push(fn),
      },
    },
  };
});

/** Simulate the browser announcing a frame's default execution context. */
function announceContext(tabId: number, contextId: number, frameId: string): void {
  eventListeners.forEach((fn) =>
    fn({ tabId }, "Runtime.executionContextCreated", {
      context: { id: contextId, auxData: { frameId, isDefault: true } },
    }),
  );
}

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
describe("DebuggerAdapter execution contexts (frame addressing)", () => {
  /** Teach the adapter how the two frame-id spaces line up (by URL). */
  function pair(adapter: DebuggerAdapter, tabId: number): void {
    adapter.mapFrames(tabId, [
      { url: "https://a.test/", scriptingFrameId: 0, cdpFrameId: "AAAA" },
      { url: "https://embed.test/doc", scriptingFrameId: 9, cdpFrameId: "BBBB" },
    ]);
  }

  it("resolves a scripting frameId to that frame's execution context", async () => {
    const adapter = new DebuggerAdapter();
    pair(adapter, 7);
    announceContext(7, 42, "AAAA");
    announceContext(7, 43, "BBBB");
    expect(await adapter.contextIdForFrame(7, 9)).toBe(43);
  });

  it("returns null for the main frame — it evaluates in the default context", async () => {
    const adapter = new DebuggerAdapter();
    pair(adapter, 7);
    announceContext(7, 42, "AAAA");
    expect(await adapter.contextIdForFrame(7, 0)).toBeNull();
  });

  it("returns null when the frame has no known CDP counterpart", async () => {
    const adapter = new DebuggerAdapter();
    pair(adapter, 7);
    expect(await adapter.contextIdForFrame(7, 99)).toBeNull();
  });

  it("returns null when the context has not been announced yet", async () => {
    const adapter = new DebuggerAdapter();
    pair(adapter, 7);
    announceContext(7, 42, "AAAA");
    expect(await adapter.contextIdForFrame(7, 9)).toBeNull(); // BBBB unseen
  });

  it("ignores non-default contexts (isolated worlds, extensions)", async () => {
    const adapter = new DebuggerAdapter();
    pair(adapter, 7);
    eventListeners.forEach((fn) =>
      fn({ tabId: 7 }, "Runtime.executionContextCreated", {
        context: { id: 5, auxData: { frameId: "BBBB", isDefault: false } },
      }),
    );
    expect(await adapter.contextIdForFrame(7, 9)).toBeNull();
  });

  it("keeps the newest context when a frame navigates and is re-created", async () => {
    const adapter = new DebuggerAdapter();
    pair(adapter, 7);
    announceContext(7, 42, "BBBB");
    announceContext(7, 77, "BBBB"); // reloaded iframe: new context, same frame
    expect(await adapter.contextIdForFrame(7, 9)).toBe(77);
  });

  it("drops every context when the browser clears them", async () => {
    const adapter = new DebuggerAdapter();
    pair(adapter, 7);
    announceContext(7, 42, "BBBB");
    eventListeners.forEach((fn) => fn({ tabId: 7 }, "Runtime.executionContextsCleared", {}));
    expect(await adapter.contextIdForFrame(7, 9)).toBeNull();
  });

  it("scopes frames and contexts per tab, and forgets them on detach", async () => {
    const adapter = new DebuggerAdapter();
    // A real session exists before detach can be reported for it.
    await adapter.attach(7);
    await adapter.attach(8);
    pair(adapter, 7);
    pair(adapter, 8);
    announceContext(7, 42, "BBBB");
    announceContext(8, 99, "BBBB");
    expect(await adapter.contextIdForFrame(7, 9)).toBe(42);
    expect(await adapter.contextIdForFrame(8, 9)).toBe(99);

    detachListeners.forEach((fn) => fn({ tabId: 7 }, "target_closed"));
    expect(await adapter.contextIdForFrame(7, 9)).toBeNull();
    expect(await adapter.contextIdForFrame(8, 9)).toBe(99); // other tab untouched
  });

  it("falls back to the DOM-stamp join when URL pairing cannot resolve", async () => {
    // The real-world failure this guards: the two id spaces disagree about the
    // frame's URL (navigation, hash/query drift), so URL pairing misses — the
    // stamp written into each frame's DOM still identifies the frame exactly.
    const adapter = new DebuggerAdapter();
    announceContext(7, 42, "AAAA");
    announceContext(7, 43, "BBBB");
    (globalThis as { chrome: Record<string, unknown> }).chrome.scripting = {
      executeScript: vi.fn().mockResolvedValue([
        { frameId: 0, result: "stamp-top" },
        { frameId: 9, result: "stamp-embed" },
      ]),
    };
    sendCommand.mockImplementation(
      (_src: unknown, method: string, params: { contextId?: number }) => {
        if (method === "Runtime.evaluate") {
          return Promise.resolve({
            result: {
              type: "string",
              value: params.contextId === 43 ? "stamp-embed" : "stamp-top",
            },
          });
        }
        return Promise.resolve({ ok: true });
      },
    );
    expect(await adapter.contextIdForFrame(7, 9)).toBe(43);
    expect(await adapter.contextIdForFrame(7, 0)).toBeNull(); // main frame = default context
  });
});
