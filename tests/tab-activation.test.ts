// Tab activation for trusted input (background/tools/trusted-input.ts).
//
// Input only reaches the ACTIVE tab's render widget — but "front" is now a
// tab-level fact, not a window-level one: a run works in the agent's own
// window while the user works in another, so activation must never raise a
// window. The renderer's own focus state comes from CDP focus emulation
// instead, and the two things worth pinning are exactly that pair:
//   - chrome.tabs.update({active:true}) when (and only when) the tab is behind
//   - Emulation.setFocusEmulationEnabled once per tab, best-effort
//   - NO chrome.windows.update({focused:true}), ever, on this path
import { beforeEach, describe, expect, it, vi } from "vitest";

const chromeMock = {
  tabs: { get: vi.fn(), update: vi.fn() },
  windows: { get: vi.fn(), update: vi.fn() },
  storage: {
    session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    local: { get: vi.fn() },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as { chrome?: unknown }).chrome = chromeMock;
  chromeMock.tabs.update.mockResolvedValue({});
  chromeMock.storage.session.get.mockResolvedValue({});
  chromeMock.storage.local.get.mockResolvedValue({});
});

async function mod() {
  const m = await import("../extension/src/background/tools/trusted-input");
  m.resetInputCachesForTests();
  return m;
}

type FakeAdapter = { send: ReturnType<typeof vi.fn>; screenshot: ReturnType<typeof vi.fn> };
const adapter = (): FakeAdapter => ({
  send: vi.fn().mockResolvedValue({}),
  screenshot: vi.fn(),
});

describe("ensureTabActive", () => {
  it("activates a background tab, emulates focus, and never raises a window", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: 7, active: false });
    const m = await mod();
    const a = adapter();
    await m.ensureTabActive(42, a as never);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(a.send).toHaveBeenCalledWith(42, "Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
    // The regression this whole feature exists for: the user's window keeps
    // focus while the agent works.
    expect(chromeMock.windows.update).not.toHaveBeenCalled();
    expect(chromeMock.windows.get).not.toHaveBeenCalled();
  });

  it("does not re-activate a tab that is already front", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: 7, active: true });
    const m = await mod();
    await m.ensureTabActive(42, adapter() as never);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it("emulates focus only once per tab", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: 7, active: true });
    const m = await mod();
    const first = adapter();
    await m.ensureTabActive(42, first as never);
    const second = adapter();
    // A different tab forces a fresh activation check (the cache is per tab).
    chromeMock.tabs.get.mockResolvedValue({ id: 43, windowId: 7, active: true });
    await m.ensureTabActive(43, second as never);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
    // Same tab again: no second command.
    chromeMock.tabs.get.mockResolvedValue({ id: 43, windowId: 7, active: true });
    const third = adapter();
    await m.ensureTabActive(43, third as never);
    expect(third.send).not.toHaveBeenCalled();
  });

  it("survives a transport that refuses focus emulation", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: 7, active: true });
    const m = await mod();
    const a: FakeAdapter = {
      send: vi.fn().mockRejectedValue(new Error("not supported")),
      screenshot: vi.fn(),
    };
    await expect(m.ensureTabActive(42, a as never)).resolves.toBeUndefined();
    expect(chromeMock.windows.update).not.toHaveBeenCalled();
  });

  it("survives a tab that vanished (the next call reports it)", async () => {
    chromeMock.tabs.get.mockRejectedValue(new Error("gone"));
    const m = await mod();
    await expect(m.ensureTabActive(42, adapter() as never)).resolves.toBeUndefined();
  });
});