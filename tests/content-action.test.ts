import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureContentBridge,
  probeContentBridge,
  runContentAction,
} from "../extension/src/background/tools/content-action";

interface ScriptingCall {
  target: { tabId: number; frameIds?: number[]; allFrames?: boolean };
  func?: unknown;
  files?: string[];
  args?: unknown[];
}

/**
 * A chrome.scripting stub that models the state the 2026-10-06 field test hit:
 * `bridged` is whether `globalThis.__baActions` exists in the frame. Injecting
 * the bundle (a `files:` call) sets it when the page allows injection.
 */
function stubChrome(opts: { bridged?: boolean; bridgeAfterInject?: boolean; injectable?: boolean }) {
  let bridged = opts.bridged ?? false;
  const calls: ScriptingCall[] = [];
  const executeScript = vi.fn(async (call: ScriptingCall) => {
    calls.push(call);
    if (call.files) {
      if (opts.injectable === false) throw new Error("Cannot access contents of the page");
      bridged = opts.bridgeAfterInject ?? true;
      return [{ result: undefined }];
    }
    if (call.args) {
      return [
        {
          result: bridged
            ? { ok: true, data: { clicked: "<div role=menuitem> \"Insert\"" } }
            : { ok: false, error: "actions-not-loaded" },
        },
      ];
    }
    return [{ result: bridged }];
  });
  (globalThis as unknown as { chrome: unknown }).chrome = { scripting: { executeScript } };
  return { calls, executeScript, isBridged: () => bridged };
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("runContentAction bridge self-heal", () => {
  it("injects the bundle and retries once when the bridge is missing", async () => {
    const stub = stubChrome({ bridged: false, bridgeAfterInject: true });
    const res = await runContentAction(7, { action: "clickByText", labels: ["Insert"] });
    expect(res.ok).toBe(true);
    expect(res.repaired).toBe(true);
    // action (miss) → inject → probe → action (hit)
    const kinds = stub.calls.map((c) => (c.files ? "inject" : c.args ? "action" : "probe"));
    expect(kinds).toEqual(["action", "inject", "probe", "action"]);
    expect(stub.calls[1]!.files).toEqual(["content/main.js"]);
    expect(stub.calls[1]!.target).toEqual({ tabId: 7, frameIds: [0] });
    expect(stub.isBridged()).toBe(true);
  });

  it("keeps the original error tag when the page cannot be injected", async () => {
    const stub = stubChrome({ bridged: false, injectable: false });
    const res = await runContentAction(7, { action: "clickByText", labels: ["Insert"] });
    expect(res.ok).toBe(false);
    // The tag must survive: tool-failure.ts classifies on "actions-not-loaded".
    expect(res.error).toContain("actions-not-loaded");
    expect(res.error).toContain("could not be repaired");
    expect(stub.calls.filter((c) => c.args)).toHaveLength(1);
  });

  it("does not inject or retry when the bridge is healthy", async () => {
    const stub = stubChrome({ bridged: true });
    const res = await runContentAction(7, { action: "click", ref: "3#12" });
    expect(res.ok).toBe(true);
    expect(res.repaired).toBeUndefined();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.target).toEqual({ tabId: 7, frameIds: [3] });
  });

  it("reports the still-broken call with the tools that do work", async () => {
    // Injection runs but the bundle never defines the bridge (e.g. a page
    // whose isolated world cannot be reached).
    const stub = stubChrome({ bridged: false, bridgeAfterInject: false });
    const res = await runContentAction(7, { action: "key", key: "Escape" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("actions-not-loaded");
    expect(res.error).toContain("could not be repaired");
    expect(res.error).toContain("click_at");
    expect(stub.calls.filter((c) => c.args)).toHaveLength(1);
  });
});

describe("bridge probes", () => {
  it("probeContentBridge is false without a scripting API and never throws", async () => {
    await expect(probeContentBridge(1)).resolves.toBe(false);
    await expect(ensureContentBridge(1)).resolves.toBe(false);
  });

  it("ensureContentBridge reports the post-injection state", async () => {
    stubChrome({ bridged: false, bridgeAfterInject: true });
    await expect(ensureContentBridge(4, 2)).resolves.toBe(true);
  });
});