// Agent-window binding tests (background/window-scope.ts).
//
// This module is the single answer to "which window may the agent touch": it
// creates or adopts the agent's own window, hands out the tab a run works on,
// and enforces the wall the tab tools call into. The behaviours worth pinning:
//   - a new window is created UNFOCUSED (the user opted into working elsewhere)
//   - a stale binding (window closed / browser restarted) is dropped, not used
//   - quiet focus never raises a window; the counter proves it
//   - handing a tab over never closes the user's window on the way out
import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "agentWindow";

const chromeMock = {
  tabs: {
    get: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    query: vi.fn(),
    move: vi.fn(),
  },
  windows: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    onRemoved: { addListener: vi.fn() },
    WINDOW_ID_NONE: -1,
  },
  storage: {
    session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    local: { get: vi.fn() },
  },
};

async function scope() {
  const mod = await import("../extension/src/background/window-scope");
  mod.resetWindowScopeForTests();
  return mod;
}

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as { chrome?: unknown }).chrome = chromeMock;
  chromeMock.windows.WINDOW_ID_NONE = -1;
  chromeMock.storage.session.get.mockResolvedValue({});
  chromeMock.storage.session.set.mockResolvedValue(undefined);
  chromeMock.storage.session.remove.mockResolvedValue(undefined);
  // loadSettings() (used by windowStatus + ensureWindowForInput) reads
  // storage.local: an empty profile means the isolation defaults.
  chromeMock.storage.local.get.mockResolvedValue({});
});

describe("ensureAgentWindow", () => {
  it("creates its own window UNFOCUSED when nothing is bound", async () => {
    chromeMock.windows.create.mockResolvedValue({ id: 12 });
    const w = await scope();
    await expect(w.ensureAgentWindow()).resolves.toBe(12);
    expect(chromeMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ focused: false }),
    );
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({
      [KEY]: expect.objectContaining({ windowId: 12, kind: "created" }),
    });
  });

  it("reuses a bound window instead of creating another", async () => {
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12 });
    const w = await scope();
    await expect(w.ensureAgentWindow()).resolves.toBe(12);
    expect(chromeMock.windows.create).not.toHaveBeenCalled();
  });

  it("drops a stale binding and creates a fresh window", async () => {
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockRejectedValue(new Error("no such window"));
    chromeMock.windows.create.mockResolvedValue({ id: 30 });
    const w = await scope();
    await expect(w.resolveAgentWindow()).resolves.toBeUndefined();
    expect(chromeMock.storage.session.remove).toHaveBeenCalledWith(KEY);
    await expect(w.ensureAgentWindow()).resolves.toBe(30);
  });

  it("fails loudly when the browser refuses to hand out a window id", async () => {
    chromeMock.windows.create.mockResolvedValue({});
    const w = await scope();
    await expect(w.ensureAgentWindow()).rejects.toThrow(/no window id/);
  });
});

describe("adopt / release", () => {
  it("binds a window the user picked", async () => {
    chromeMock.windows.get.mockResolvedValue({ id: 4 });
    const w = await scope();
    await expect(w.bindAgentWindow(4)).resolves.toEqual({ ok: true });
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({
      [KEY]: expect.objectContaining({ windowId: 4, kind: "adopted" }),
    });
  });

  it("refuses a window that does not exist", async () => {
    chromeMock.windows.get.mockRejectedValue(new Error("gone"));
    const w = await scope();
    const out = await w.bindAgentWindow(4);
    expect(out.ok).toBe(false);
    expect(chromeMock.storage.session.set).not.toHaveBeenCalled();
  });

  it("releases the binding so the agent gets its own window again", async () => {
    const w = await scope();
    await w.releaseAgentWindow();
    expect(chromeMock.storage.session.remove).toHaveBeenCalledWith(KEY);
  });
});

describe("ensureAgentTab", () => {
  it("returns the window's active tab", async () => {
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12 });
    chromeMock.tabs.query.mockResolvedValue([
      { id: 1, windowId: 12, active: false },
      { id: 2, windowId: 12, active: true },
    ]);
    const w = await scope();
    await expect(w.ensureAgentTab()).resolves.toBe(2);
  });

  it("creates a blank tab when the window has none", async () => {
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12 });
    chromeMock.tabs.query.mockResolvedValue([]);
    chromeMock.tabs.create.mockResolvedValue({ id: 77 });
    const w = await scope();
    await expect(w.ensureAgentTab()).resolves.toBe(77);
    expect(chromeMock.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 12, active: true }),
    );
  });

  it("skips pages the agent can never act on when picking the starting tab", async () => {
    // "Adopt this window" mode works in the user's window, where the active
    // tab is easily chrome://extensions or the panel itself — never a page to
    // start a run on.
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12 });
    chromeMock.tabs.query.mockResolvedValue([
      { id: 1, windowId: 12, active: true, url: "chrome://extensions/" },
      {
        id: 2,
        windowId: 12,
        active: false,
        url: "chrome-extension://abc/sidepanel/index.html",
      },
      { id: 3, windowId: 12, active: false, url: "http://127.0.0.1:8790/" },
    ]);
    const w = await scope();
    await expect(w.ensureAgentTab()).resolves.toBe(3);
  });

  it("treats about:blank as a usable starting tab", async () => {
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12 });
    chromeMock.tabs.query.mockResolvedValue([
      { id: 9, windowId: 12, active: true, url: "about:blank" },
    ]);
    const w = await scope();
    await expect(w.ensureAgentTab()).resolves.toBe(9);
  });
});

describe("the wall", () => {
  beforeEach(() => {
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12 });
  });

  it("passes a tab inside the agent window", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 5, windowId: 12 });
    const w = await scope();
    await expect(w.assertInAgentWindow(5)).resolves.toEqual({ ok: true });
  });

  it("refuses a tab in the user's window with actionable, final wording", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 5, windowId: 99 });
    const w = await scope();
    const out = await w.assertInAgentWindow(5);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("TOOL-FAILED");
      expect(out.error).toContain("window 99");
      expect(out.error).toContain("Do not retry");
      expect(out.error).toContain("Hand this tab to the agent");
    }
  });
});

describe("moveTabIntoAgentWindow (hand-over)", () => {
  beforeEach(() => {
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12 });
    chromeMock.windows.create.mockResolvedValue({ id: 12 });
  });

  it("moves the tab and makes it active", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 5, windowId: 99 });
    chromeMock.tabs.query.mockResolvedValue([
      { id: 5, windowId: 99 },
      { id: 6, windowId: 99 },
    ]);
    const w = await scope();
    await expect(w.moveTabIntoAgentWindow(5)).resolves.toEqual({
      ok: true,
      tabId: 5,
      windowId: 12,
    });
    expect(chromeMock.tabs.move).toHaveBeenCalledWith(5, { windowId: 12, index: -1 });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(5, { active: true });
  });

  it("keeps the user's window alive when it held only that tab", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 5, windowId: 99 });
    chromeMock.tabs.query.mockResolvedValue([{ id: 5, windowId: 99 }]);
    chromeMock.tabs.create.mockResolvedValue({ id: 6 });
    const w = await scope();
    await w.moveTabIntoAgentWindow(5);
    // A replacement tab is created in the source window BEFORE the move, so
    // moving the last tab cannot close the window the user was working in.
    expect(chromeMock.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 99 }),
    );
    const createdBeforeMove =
      chromeMock.tabs.create.mock.invocationCallOrder[0]! <
      chromeMock.tabs.move.mock.invocationCallOrder[0]!;
    expect(createdBeforeMove).toBe(true);
  });

  it("is a no-op for a tab already in the agent window", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 5, windowId: 12 });
    const w = await scope();
    await expect(w.moveTabIntoAgentWindow(5)).resolves.toEqual({
      ok: true,
      tabId: 5,
      windowId: 12,
    });
    expect(chromeMock.tabs.move).not.toHaveBeenCalled();
  });
});

describe("focus policy", () => {
  it("quiet mode (the default) never raises a window", async () => {
    chromeMock.windows.get.mockResolvedValue({ id: 12, focused: false });
    const w = await scope();
    await w.ensureWindowForInput(12);
    expect(chromeMock.windows.update).not.toHaveBeenCalled();
    expect(w.raiseAttempts()).toBe(0);
  });

  it("raises the agent's own window only when quiet focus is off", async () => {
    chromeMock.storage.local.get.mockResolvedValue({
      baSettings: { agentWindow: { mode: "own", quietFocus: false } },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12, focused: false });
    chromeMock.windows.update.mockResolvedValue({});
    const w = await scope();
    await w.ensureWindowForInput(12);
    expect(chromeMock.windows.update).toHaveBeenCalledWith(12, { focused: true });
    expect(w.raiseAttempts()).toBe(1);
  });

  it("does not raise again when the window is already focused", async () => {
    chromeMock.storage.local.get.mockResolvedValue({
      baSettings: { agentWindow: { mode: "own", quietFocus: false } },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12, focused: true });
    const w = await scope();
    await w.ensureWindowForInput(12);
    expect(chromeMock.windows.update).not.toHaveBeenCalled();
  });
});

describe("windowStatus", () => {
  it("reports mode, window and tab count", async () => {
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12 });
    chromeMock.tabs.query.mockResolvedValue([
      { id: 1, windowId: 12, active: true },
      { id: 2, windowId: 12, active: false },
    ]);
    const w = await scope();
    await expect(w.windowStatus()).resolves.toEqual({
      mode: "own",
      windowId: 12,
      alive: true,
      tabs: 2,
      activeTabId: 1,
      raiseAttempts: 0,
    });
  });

  it("says so when no window exists yet", async () => {
    const w = await scope();
    await expect(w.windowStatus()).resolves.toEqual({
      mode: "own",
      alive: false,
      tabs: 0,
      raiseAttempts: 0,
    });
  });
});

describe("initWindowScope", () => {
  it("forgets the window when the browser reports it closed", async () => {
    chromeMock.storage.session.get.mockResolvedValue({
      [KEY]: { windowId: 12, kind: "created", at: 1 },
    });
    chromeMock.windows.get.mockResolvedValue({ id: 12 });
    const w = await scope();
    const seen: number[] = [];
    w.initWindowScope((id) => seen.push(id));
    await w.resolveAgentWindow();
    // Simulate chrome.windows.onRemoved firing for the agent's window.
    const listener = chromeMock.windows.onRemoved.addListener.mock.calls[0]![0] as (
      id: number,
    ) => void;
    listener(12);
    expect(seen).toEqual([12]);
    expect(chromeMock.storage.session.remove).toHaveBeenCalledWith(KEY);
    // The next resolve sees no binding — never the stale id.
    chromeMock.storage.session.get.mockResolvedValue({});
    await expect(w.resolveAgentWindow()).resolves.toBeUndefined();
  });
});