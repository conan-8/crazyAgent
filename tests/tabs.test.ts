// Tab-targeting + window-isolation regression tests.
//
// History, in order:
//  1. A live run lost ~10 minutes to screenshots of a tab it had already left:
//     `tabs_switch` did not make the tab the one perception followed.
//  2. The fix for (1) focused the tab's WINDOW, which made a run unusable next
//     to the user — every stroke yanked focus back to the agent's window.
//  3. Window isolation replaced both: the agent works inside ONE window (its
//     own — window-scope.ts), `tabs_list` shows only that window, and tabs
//     outside it are refused rather than switched to.
//
// These tests pin (3): the wall, the forced window on create, and the absence
// of any window focus write.
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_WINDOW = 7;
const USER_WINDOW = 9;

// Minimal chrome stub — tabs.ts + window-scope.ts only touch these.
const chromeMock = {
  tabs: {
    get: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    query: vi.fn(),
  },
  windows: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    WINDOW_ID_NONE: -1,
  },
  storage: {
    session: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
  },
};

/** Bind the agent's window for this test (storage.session holds the binding). */
function bindWindow(windowId = AGENT_WINDOW) {
  chromeMock.storage.session.get.mockResolvedValue({
    agentWindow: { windowId, kind: "created", at: 1 },
  });
  chromeMock.windows.get.mockImplementation(async (id: number) =>
    id === windowId ? { id } : Promise.reject(new Error("no such window")),
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  (globalThis as { chrome?: unknown }).chrome = chromeMock;
  chromeMock.windows.WINDOW_ID_NONE = -1;
  chromeMock.tabs.update.mockResolvedValue({});
  chromeMock.tabs.remove.mockResolvedValue(undefined);
  chromeMock.storage.session.set.mockResolvedValue(undefined);
  chromeMock.storage.session.remove.mockResolvedValue(undefined);
  chromeMock.tabs.query.mockResolvedValue([]);
  bindWindow();
  // window-scope caches the binding in memory across calls: forget it.
  const { resetWindowScopeForTests } = await import(
    "../extension/src/background/window-scope"
  );
  resetWindowScopeForTests();
});

// Import AFTER the chrome stub exists (registerTool runs at import time).
async function tool(name: string) {
  await import("../extension/src/background/tools/tabs");
  const { toolRegistry } = await import("../extension/src/background/tools/types");
  const t = toolRegistry.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const ctx = (tabId: number, scope?: { allowOutside?: boolean }) =>
  ({
    tabId,
    adapter: { send: vi.fn(), screenshot: vi.fn() },
    emit: vi.fn(),
    scope: scope ? { agentWindowId: AGENT_WINDOW, ...scope } : undefined,
  }) as never;

describe("tabs_switch", () => {
  it("activates one of the agent's tabs WITHOUT focusing any window", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: AGENT_WINDOW });
    const switchTool = await tool("tabs_switch");
    const out = (await switchTool.run({ tabId: 42 }, ctx(1))) as Record<string, unknown>;
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { active: true });
    // The whole point of the quiet default: the user's window keeps focus.
    expect(chromeMock.windows.update).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, tabId: 42, windowId: AGENT_WINDOW });
  });

  it("REFUSES a tab in the user's window and changes nothing", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: USER_WINDOW });
    const switchTool = await tool("tabs_switch");
    const out = (await switchTool.run({ tabId: 42 }, ctx(1))) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("TOOL-FAILED");
    expect(String(out.error)).toContain("user's window");
    expect(String(out.error)).toContain("Do not retry");
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.windows.update).not.toHaveBeenCalled();
  });
});

describe("tabs_close", () => {
  it("closes one of the agent's tabs", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: AGENT_WINDOW });
    const closeTool = await tool("tabs_close");
    const out = (await closeTool.run({ tabId: 42 }, ctx(1))) as Record<string, unknown>;
    expect(chromeMock.tabs.remove).toHaveBeenCalledWith(42);
    expect(out).toMatchObject({ ok: true });
  });

  it("REFUSES to close a tab in the user's window", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: USER_WINDOW });
    const closeTool = await tool("tabs_close");
    const out = (await closeTool.run({ tabId: 42 }, ctx(1))) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
  });
});

describe("tabs_create", () => {
  it("always opens in the AGENT window, even from a tab elsewhere", async () => {
    chromeMock.tabs.create.mockResolvedValue({ id: 100 });
    const createTool = await tool("tabs_create");
    const out = (await createTool.run({ url: "http://x" }, ctx(999))) as Record<
      string,
      unknown
    >;
    expect(chromeMock.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://x", active: true, windowId: AGENT_WINDOW }),
    );
    expect(out).toEqual({ tabId: 100 });
  });

  it("creates the agent window when none is bound (never the focused one)", async () => {
    chromeMock.storage.session.get.mockResolvedValue({});
    chromeMock.windows.create.mockResolvedValue({ id: 21, focused: false });
    chromeMock.tabs.create.mockResolvedValue({ id: 101 });
    const { resetWindowScopeForTests } = await import(
      "../extension/src/background/window-scope"
    );
    resetWindowScopeForTests();
    const createTool = await tool("tabs_create");
    await createTool.run({ url: "http://x" }, ctx(999));
    expect(chromeMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ focused: false }),
    );
    const arg = chromeMock.tabs.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.windowId).toBe(21);
  });
});

describe("tabs_list", () => {
  it("lists only the agent window's tabs", async () => {
    chromeMock.tabs.query.mockResolvedValue([
      { id: 1, title: "A", url: "http://a", active: true, windowId: AGENT_WINDOW },
      { id: 2, title: "B", url: "http://b", active: false, windowId: AGENT_WINDOW },
    ]);
    const listTool = await tool("tabs_list");
    const rows = (await listTool.run({}, ctx(1))) as Record<string, unknown>[];
    expect(chromeMock.tabs.query).toHaveBeenCalledWith({ windowId: AGENT_WINDOW });
    expect(rows.map((r) => r.tabId)).toEqual([1, 2]);
    expect(rows.every((r) => r.window === "agent")).toBe(true);
  });

  it("hides the user's tabs unless the run was granted 'look outside'", async () => {
    chromeMock.tabs.query.mockImplementation(async (q: Record<string, unknown>) =>
      q.windowId === AGENT_WINDOW
        ? [{ id: 1, title: "A", url: "http://a", active: true, windowId: AGENT_WINDOW }]
        : [
            { id: 1, title: "A", url: "http://a", active: true, windowId: AGENT_WINDOW },
            { id: 5, title: "U", url: "http://u", active: true, windowId: USER_WINDOW },
          ],
    );
    const listTool = await tool("tabs_list");
    const without = (await listTool.run({}, ctx(1))) as Record<string, unknown>[];
    expect(without.map((r) => r.tabId)).toEqual([1]);

    const withPeek = (await listTool.run({}, ctx(1, { allowOutside: true }))) as Record<
      string,
      unknown
    >[];
    expect(withPeek.map((r) => r.tabId)).toEqual([1, 5]);
    expect(withPeek.at(-1)?.window).toBe("user");
  });
});