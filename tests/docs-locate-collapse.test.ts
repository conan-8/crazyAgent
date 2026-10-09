// The find-bar collapse behind docs_locate's caret modes
// (background/tools/docs.ts `collapseToMatch`).
//
// This key sequence has been wrong twice, and both times only a live Google Doc
// showed it: first when a bare ArrowLeft stepped out of a table cell, then when
// the repaired version returned WITHOUT its final step toward and left every
// caret one character inside the match (mPid, aHaa, zzTz — and docs_table's
// before-table route typed six values into the paragraph above the table).
// Pinning the sequence per case turns the next regression into a unit-test
// failure instead of another probe run.
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Caret {
  x: number;
  y: number;
  width: number;
  height: number;
  scrollTop: number;
  source: string;
}

const box = (x: number, y: number, height = 17): Caret => ({
  x,
  y,
  width: 2,
  height,
  scrollTop: 0,
  source: "kix-cursor-caret",
});

const keys: string[] = [];
let carets: (Caret | null)[] = [];

const chromeMock = {
  tabs: { get: vi.fn(), update: vi.fn() },
  windows: { get: vi.fn(), update: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }, local: { get: vi.fn() } },
  scripting: { executeScript: vi.fn() },
};

/** CDP splits a combo into `key` + a modifier bitfield; put it back together. */
function comboName(p: { key?: string; modifiers?: number }): string {
  const mods = p.modifiers ?? 0;
  return (
    (mods & 2 ? "Control+" : "") +
    (mods & 8 ? "Shift+" : "") +
    (mods & 1 ? "Alt+" : "") +
    String(p.key ?? "")
  );
}

const adapter = () => ({
  send: vi.fn(
    async (_tab: number, method: string, params: { type?: string; key?: string; modifiers?: number } | undefined) => {
      if (method === "Input.dispatchKeyEvent" && params?.type === "keyDown" && params) {
        keys.push(comboName(params));
      }
      return {};
    },
  ),
  screenshot: vi.fn(),
});

beforeEach(() => {
  vi.resetAllMocks();
  keys.length = 0;
  carets = [];
  (globalThis as { chrome?: unknown }).chrome = chromeMock;
  chromeMock.tabs.get.mockResolvedValue({ id: 1, windowId: 1, active: true });
  chromeMock.tabs.update.mockResolvedValue({});
  chromeMock.storage.session.get.mockResolvedValue({});
  chromeMock.storage.local.get.mockResolvedValue({});
  // Each call answers one caret read, in order — the sequence the collapse sees.
  chromeMock.scripting.executeScript.mockImplementation(async () => [
    { result: { ok: true, data: carets.shift() ?? null } },
  ]);
});

async function collapse(side: "before" | "after", reads: (Caret | null)[]) {
  carets = [...reads];
  const m = await import("../extension/src/background/tools/docs");
  const ctx = { tabId: 1, adapter: adapter(), emit: vi.fn() } as never;
  const repaired = await m.collapseToMatch(ctx, "aaa", 1, side);
  return { keys: [...keys], repaired };
}

describe("collapseToMatch, no cell edge involved", () => {
  it("ends on the match START for caret:'before' — the keystroke that went missing", async () => {
    // One character apart on one line: step toward, step back, step toward.
    const out = await collapse("before", [box(583, 249), box(591, 249)]);
    expect(out.keys).toEqual(["ArrowLeft", "ArrowRight", "ArrowLeft"]);
    expect(out.repaired).toBe(false);
  });

  it("ends on the match END for caret:'after'", async () => {
    const out = await collapse("after", [box(600, 249), box(592, 249)]);
    expect(out.keys).toEqual(["ArrowRight", "ArrowLeft", "ArrowRight"]);
    expect(out.repaired).toBe(false);
  });

  it("does nothing extra when the editor exposes no caret", async () => {
    const out = await collapse("before", [null]);
    expect(out.keys).toEqual(["ArrowLeft"]);
    expect(out.repaired).toBe(false);
  });
});

describe("collapseToMatch at a table cell edge", () => {
  it("stops at the step back when the arrow jumped sideways into the next cell", async () => {
    // Measured: leaving a second-column cell moved the caret 134px on ONE line.
    const out = await collapse("before", [box(566, 323), box(700, 323)]);
    expect(out.keys).toEqual(["ArrowLeft", "ArrowRight"]);
    expect(out.repaired).toBe(true);
  });

  it("re-finds and presses Home when the arrow left the table vertically", async () => {
    // Paragraph above the table at y=257, the table's first row at y=282.
    const out = await collapse("before", [box(536, 257), box(543, 282), box(543, 282)]);
    expect(out.keys.slice(0, 2)).toEqual(["ArrowLeft", "ArrowRight"]);
    expect(out.keys).toContain("Control+f");
    expect(out.keys.at(-2)).toBe("Escape");
    expect(out.keys.at(-1)).toBe("Home");
    expect(out.repaired).toBe(true);
  });

  it("walks back to the match when the crossing was a wrapped line, not a cell", async () => {
    // Home lands on the match's own line (y=300), which is NOT the line the
    // crossing reached (y=325): the match begins at a wrap, so the first
    // collapse was right and End+ArrowLeft restores it.
    const out = await collapse("before", [box(500, 300), box(500, 325), box(400, 300)]);
    expect(out.keys.slice(-2)).toEqual(["End", "ArrowLeft"]);
    expect(out.repaired).toBe(true);
  });

  it("stops at the step back for caret:'after' as well", async () => {
    const out = await collapse("after", [box(700, 323), box(566, 323)]);
    expect(out.keys).toEqual(["ArrowRight", "ArrowLeft"]);
    expect(out.repaired).toBe(true);
  });

  it("ends on End for caret:'after' when the arrow left the table vertically", async () => {
    // A cell's own line end IS the match end, so no wrap check is needed here.
    const out = await collapse("after", [box(640, 282), box(640, 314)]);
    expect(out.keys).toContain("Control+f");
    expect(out.keys.at(-2)).toBe("Escape");
    expect(out.keys.at(-1)).toBe("End");
    expect(out.repaired).toBe(true);
  });
});
