// Tab-targeting regression tests. A live run lost ~10 minutes to screenshots
// of a tab it had already left: `tabs_switch` activated the tab but never
// focused its WINDOW, and with several windows open perception (screenshots,
// snapshots) followed the user's focus, not the agent's target. These tests
// pin the fix: switching focuses the tab's window, and new tabs open in the
// window the agent is already working in.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal chrome stub — tabs.ts touches chrome.tabs / chrome.windows only.
const chromeMock = {
  tabs: {
    get: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    query: vi.fn(),
  },
  windows: {
    update: vi.fn(),
    WINDOW_ID_NONE: -1,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as { chrome?: unknown }).chrome = chromeMock;
  chromeMock.windows.WINDOW_ID_NONE = -1;
});

// Import AFTER the chrome stub exists (registerTool runs at import time).
async function tool(name: string) {
  await import("../extension/src/background/tools/tabs");
  const { toolRegistry } = await import("../extension/src/background/tools/types");
  const t = toolRegistry.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const ctx = (tabId: number) =>
  ({ tabId, adapter: { send: vi.fn(), screenshot: vi.fn() }, emit: vi.fn() }) as never;

describe("tabs_switch", () => {
  it("activates the tab AND focuses its window", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: 7 });
    chromeMock.tabs.update.mockResolvedValue({});
    chromeMock.windows.update.mockResolvedValue({});
    const switchTool = await tool("tabs_switch");
    const out = (await switchTool.run({ tabId: 42 }, ctx(1))) as Record<string, unknown>;
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chromeMock.windows.update).toHaveBeenCalledWith(7, { focused: true });
    expect(out).toMatchObject({ ok: true, tabId: 42, windowId: 7 });
  });

  it("survives a window-focus failure (still switches the tab)", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: 7 });
    chromeMock.tabs.update.mockResolvedValue({});
    chromeMock.windows.update.mockRejectedValue(new Error("no such window"));
    const switchTool = await tool("tabs_switch");
    const out = (await switchTool.run({ tabId: 42 }, ctx(1))) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true });
  });
});

describe("tabs_create", () => {
  it("opens the new tab in the SAME window as the agent's current tab", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 1, windowId: 9 });
    chromeMock.tabs.create.mockResolvedValue({ id: 100 });
    const createTool = await tool("tabs_create");
    const out = (await createTool.run({ url: "http://x" }, ctx(1))) as Record<string, unknown>;
    expect(chromeMock.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://x", active: true, windowId: 9 }),
    );
    expect(out).toEqual({ tabId: 100 });
  });

  it("falls back to a default window when the current tab cannot be read", async () => {
    chromeMock.tabs.get.mockRejectedValue(new Error("gone"));
    chromeMock.tabs.create.mockResolvedValue({ id: 101 });
    const createTool = await tool("tabs_create");
    await createTool.run({ url: "http://x" }, ctx(1));
    const arg = chromeMock.tabs.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.windowId).toBeUndefined();
  });
});
