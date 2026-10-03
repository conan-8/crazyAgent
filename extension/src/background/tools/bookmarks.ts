// Bookmark and shortcut lookups (chrome.bookmarks / chrome.topSites) — the
// "where does this live?" sense. A task like "do my homework" names an
// ACTIVITY, not a URL: the site it means (Google Classroom, Schoology, the
// class page) is usually already open as a tab, sitting in the bookmarks bar,
// or one of the New Tab shortcuts. These tools let the agent find it there
// instead of detouring through a search engine.
//
// All three are read-only and never touch page state, so the agent loop runs
// them concurrently (see PARALLEL_SAFE in agent/loop.ts).
import { registerTool } from "./types";

interface BmNode {
  id: string;
  title?: string;
  url?: string;
  children?: BmNode[];
}

interface BmHit {
  title: string;
  url: string;
  /** Folder path like "Bookmarks bar/School" — the folder is often the clue. */
  folder: string;
}

/** Safety cap on what we walk out of the tree before slicing the output. */
const FLATTEN_CAP = 5_000;

/** Flatten the bookmark tree to {title, url, folder} rows, depth-first. */
export function flattenBookmarks(nodes: BmNode[] | undefined, folder: string, out: BmHit[] = []): BmHit[] {
  for (const n of nodes ?? []) {
    if (out.length >= FLATTEN_CAP) return out;
    if (n.url) out.push({ title: n.title ?? "", url: n.url, folder });
    if (n.children?.length) {
      const path = n.title ? (folder ? `${folder}/${n.title}` : n.title) : folder;
      flattenBookmarks(n.children, path, out);
    }
  }
  return out;
}

/**
 * Case-insensitive substring match over title, URL and FOLDER path — a
 * bookmark named "Mrs. Johnson" inside a "Science" folder still matches
 * "science", which is exactly the miss that sends the agent to a search page.
 */
export function matchBookmarks(hits: BmHit[], query: string): BmHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return hits;
  return hits.filter(
    (h) =>
      h.title.toLowerCase().includes(q) ||
      h.url.toLowerCase().includes(q) ||
      h.folder.toLowerCase().includes(q),
  );
}

/** Clamp a caller-supplied limit into [1, max], defaulting to `fallback`. */
function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

registerTool({
  name: "bookmarks_search",
  description:
    "Search the user's bookmarks by keyword (matches title, URL and folder name). Use it to find where a site the task names lives — e.g. 'classroom', 'schoology', 'math' — before guessing a URL or searching the web.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keyword to match against bookmark titles, URLs and folders" },
      limit: { type: "number", description: "Max matches to return (default 20, max 100)" },
    },
    required: ["query"],
  },
  async run(args) {
    const limit = clampLimit(args.limit, 20, 100);
    const tree = await chrome.bookmarks.getTree();
    const hits = matchBookmarks(flattenBookmarks(tree as BmNode[], ""), String(args.query ?? ""));
    return {
      matches: hits.slice(0, limit),
      total: hits.length,
      ...(hits.length > limit ? { truncated: true, note: `${hits.length - limit} more matches not shown — raise limit to see them.` } : {}),
    };
  },
});

registerTool({
  name: "bookmarks_list",
  description:
    "List bookmarks (title, url, folder path), optionally only from folders whose path matches `folder`. Use when no keyword is obvious yet — 'what school stuff do I have bookmarked?' — then navigate to the right URL.",
  parameters: {
    type: "object",
    properties: {
      folder: { type: "string", description: "Optional substring filter on the folder path (e.g. 'School')" },
      limit: { type: "number", description: "Max rows to return (default 200, max 500)" },
    },
  },
  async run(args) {
    const limit = clampLimit(args.limit, 200, 500);
    const tree = await chrome.bookmarks.getTree();
    let hits = flattenBookmarks(tree as BmNode[], "");
    const folder = String(args.folder ?? "").trim();
    if (folder) {
      const f = folder.toLowerCase();
      hits = hits.filter((h) => h.folder.toLowerCase().includes(f));
    }
    return {
      bookmarks: hits.slice(0, limit),
      total: hits.length,
      ...(hits.length > limit ? { truncated: true, note: `${hits.length - limit} more bookmarks not shown — raise limit or narrow folder.` } : {}),
    };
  },
});

registerTool({
  name: "topsites_list",
  description:
    "List the user's New Tab shortcuts / most-visited sites (title, url). Another place a frequently used site lives — check with tabs_list and bookmarks_search when a task names a site indirectly.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max sites to return (default 20, max 50)" },
    },
  },
  async run(args) {
    const limit = clampLimit(args.limit, 20, 50);
    const sites = await chrome.topSites.get();
    return {
      sites: sites.slice(0, limit).map((s) => ({ title: s.title ?? "", url: s.url ?? "" })),
      total: sites.length,
    };
  },
});
