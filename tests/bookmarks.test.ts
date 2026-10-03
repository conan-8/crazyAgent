// Bookmark / shortcut lookup tests. The "do my homework" path lives or dies
// on these results being right: the agent resolves an activity to a site by
// searching bookmarks (title, URL AND folder name — a "Science" folder must
// match "science") and the New Tab shortcuts, so a miss here sends the run to
// a search-engine detour instead of the class portal.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal chrome stub — bookmarks.ts touches chrome.bookmarks / chrome.topSites only.
const chromeMock = {
  bookmarks: { getTree: vi.fn() },
  topSites: { get: vi.fn() },
};

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as { chrome?: unknown }).chrome = chromeMock;
});

// Import AFTER the chrome stub exists (registerTool runs at import time).
async function tool(name: string) {
  await import("../extension/src/background/tools/bookmarks");
  const { toolRegistry } = await import("../extension/src/background/tools/types");
  const t = toolRegistry.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const TREE = [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        title: "Bookmarks bar",
        children: [
          {
            id: "2",
            title: "School",
            children: [
              { id: "3", title: "Mrs. Johnson", url: "https://classroom.google.com/c/AAA" },
              { id: "4", title: "Schoology", url: "https://schoology.example.com/course/1" },
            ],
          },
        ],
      },
      {
        id: "5",
        title: "Other bookmarks",
        children: [{ id: "6", title: "Games", url: "https://games.example.com" }],
      },
    ],
  },
];

const ctx = () =>
  ({ tabId: 1, adapter: { send: vi.fn(), screenshot: vi.fn() }, emit: vi.fn() }) as never;

describe("bookmarks_search", () => {
  it("matches title, URL and folder name", async () => {
    chromeMock.bookmarks.getTree.mockResolvedValue(TREE);
    const search = await tool("bookmarks_search");

    const byTitle = (await search.run({ query: "schoology" }, ctx())) as { matches: unknown[] };
    expect(byTitle.matches).toEqual([
      { title: "Schoology", url: "https://schoology.example.com/course/1", folder: "Bookmarks bar/School" },
    ]);

    // The bookmark is named "Mrs. Johnson" — only its URL and FOLDER can match.
    const byUrl = (await search.run({ query: "classroom" }, ctx())) as { matches: unknown[] };
    expect(byUrl.matches).toHaveLength(1);
    const byFolder = (await search.run({ query: "school" }, ctx())) as { matches: unknown[] };
    expect(byFolder.matches).toHaveLength(2);
  });

  it("caps results and reports the remainder", async () => {
    chromeMock.bookmarks.getTree.mockResolvedValue(TREE);
    const search = await tool("bookmarks_search");
    const out = (await search.run({ query: "e", limit: 1 }, ctx())) as Record<string, unknown>;
    // "Schoology", "Games" and "example.com" URLs carry an "e".
    expect((out.matches as unknown[]).length).toBe(1);
    expect(out.total).toBeGreaterThan(1);
    expect(out.truncated).toBe(true);
  });
});

describe("bookmarks_list", () => {
  it("flattens with folder paths and filters by folder", async () => {
    chromeMock.bookmarks.getTree.mockResolvedValue(TREE);
    const list = await tool("bookmarks_list");

    const all = (await list.run({}, ctx())) as { bookmarks: { folder: string }[]; total: number };
    expect(all.total).toBe(3);
    expect(all.bookmarks[0]).toMatchObject({ folder: "Bookmarks bar/School" });

    const school = (await list.run({ folder: "school" }, ctx())) as { bookmarks: unknown[]; total: number };
    expect(school.total).toBe(2);
    expect(school.bookmarks).toHaveLength(2);
  });
});

describe("topsites_list", () => {
  it("returns the New Tab shortcuts", async () => {
    chromeMock.topSites.get.mockResolvedValue([
      { title: "Classroom", url: "https://classroom.google.com" },
      { title: "Mail", url: "https://mail.google.com" },
    ]);
    const topsites = await tool("topsites_list");
    const out = (await topsites.run({ limit: 1 }, ctx())) as Record<string, unknown>;
    expect(out.sites).toEqual([{ title: "Classroom", url: "https://classroom.google.com" }]);
    expect(out.total).toBe(2);
    expect(chromeMock.topSites.get).toHaveBeenCalled();
  });
});
