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
/** Every `Input.insertText` payload — i.e. the phrase actually reaching the page. */
const inserted: string[] = [];
/** Does Control+f produce a find bar? Probe v10 S2 measured both states. */
let findBarOpen = true;
let carets: (Caret | null)[] = [];

/** The search field probe v10 measured: focused while the bar is open, and not
 *  laid out at all once it closes. The generated ids (c9, avWBGd-12) change per
 *  session, so the guard keys off the aria-label instead. */
const FIND_INPUT = 'input[aria-label="Find in document"]';

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
    async (
      _tab: number,
      method: string,
      params: { type?: string; key?: string; modifiers?: number; text?: string } | undefined,
    ) => {
      if (method === "Input.dispatchKeyEvent" && params?.type === "keyDown" && params) {
        keys.push(comboName(params));
      }
      if (method === "Input.insertText") inserted.push(String(params?.text ?? ""));
      return {};
    },
  ),
  screenshot: vi.fn(),
});

beforeEach(() => {
  vi.resetAllMocks();
  keys.length = 0;
  inserted.length = 0;
  findBarOpen = true;
  carets = [];
  (globalThis as { chrome?: unknown }).chrome = chromeMock;
  chromeMock.tabs.get.mockResolvedValue({ id: 1, windowId: 1, active: true });
  chromeMock.tabs.update.mockResolvedValue({});
  chromeMock.storage.session.get.mockResolvedValue({});
  chromeMock.storage.local.get.mockResolvedValue({});
  chromeMock.scripting.executeScript.mockImplementation(async (opts: { args?: unknown[] }) => {
    const req = (opts?.args?.[0] ?? {}) as { action?: string };
    // The find-bar guard asks for the search field's box. Answer from the
    // geometry probe v10 measured, so a closed bar really is closed.
    if (req.action === "boxes") {
      const boxes = findBarOpen ? [{ selector: FIND_INPUT, x: 1433, y: 137, w: 168, h: 24 }] : [];
      return [{ result: { ok: true, data: { boxes } } }];
    }
    // Each other call answers one caret read, in order — the sequence the
    // collapse sees.
    return [{ result: { ok: true, data: carets.shift() ?? null } }];
  });
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

describe("findBarCaret never types into a find bar that did not open", () => {
  // A 2026-10-10 run lost a paragraph this way: the document came back as
  // EXACTLY the phrase docs_locate had been asked to find, and a following
  // Control+z made it strictly worse ("M"), which is what proves the phrase had
  // been INSERTED rather than the text merely hidden. sendTrustedText sends real
  // keystrokes to whatever holds focus, so a swallowed Control+f — a menu,
  // dialog or toolbar dropdown in front — writes the query into the document,
  // replacing any live selection.
  const PHRASE = "Zebra quartz lantern melody";

  async function locate(barOpens: boolean) {
    findBarOpen = barOpens;
    carets = [box(597, 249)];
    const m = await import("../extension/src/background/tools/docs");
    const ctx = { tabId: 1, adapter: adapter(), emit: vi.fn() } as never;
    const out = await m.findBarCaret(ctx, PHRASE, 1, "before", { exportCount: false });
    return { keys: [...keys], inserted: [...inserted], out };
  }

  it("types NOTHING and reports a TOOL failure when Control+f is swallowed", async () => {
    const r = await locate(false);
    expect(r.inserted).toEqual([]);
    expect(r.out.barNeverOpened).toBe(true);
    expect(r.out.missing).toMatch(/did not open/);
    // It offered the bar a chance to appear, then cleaned up after itself.
    expect(r.keys[0]).toBe("Control+f");
    expect(r.keys).toContain("Escape");
    // No caret placement was attempted on a document it never searched.
    expect(r.keys).not.toContain("Home");
    expect(r.keys).not.toContain("ArrowLeft");
  });

  it("types the phrase once the bar is confirmed open", async () => {
    const r = await locate(true);
    // planTyping sends the first character as a lead key combo and the rest as
    // one insertText, so the phrase arrives in two pieces.
    expect(r.inserted).toEqual([PHRASE.slice(1)]);
    expect(r.keys.some((k) => k.toLowerCase().endsWith("z"))).toBe(true);
    expect(r.out.barNeverOpened).toBeUndefined();
  });
});
