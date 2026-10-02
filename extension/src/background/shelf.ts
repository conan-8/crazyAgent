// The image shelf: captures staged by `screenshot` / `view_image`, held in the
// background so later tools (`paste_image`, and any future byte consumer) can
// pipe image bytes tool→tool. Two lessons made this a module of its own:
//
//   - Image bytes must never round-trip through the MODEL's context — a
//     base64 JPEG is ~500k tokens of pure cost, which is why `upload files:[…]`
//     was never a realistic route for "send this screenshot to the chat app".
//   - Disk paths invite silent wrong-path failures: a real run saved a
//     screenshot to Downloads, guessed "/root/Downloads/…", and
//     DOM.setFileInputFiles "succeeded" three times with input.files empty.
//     The shelf keeps the bytes themselves, addressed by a short id the model
//     CAN carry ("shot_3"), with no filesystem in the loop.
//
// The pure core (entries + ring cap + lookup) is unit-tested in
// tests/shelf.test.ts; the storage mirror keeps the shelf alive across MV3
// worker teardowns within the browser session (chrome.storage.session —
// RAM-only, exactly like the run checkpoint; screenshot bytes never reach
// persistent storage).

export interface ShelfEntry {
  /** Model-facing id, e.g. "shot_3" — monotonic within the session. */
  id: string;
  dataUrl: string;
  mime: string;
  /** Filename a page will see when the image is attached/pasted. */
  name: string;
  sourceUrl: string;
  tabTitle: string;
  tabId: number;
  at: number;
}

/** Shelf metadata WITHOUT bytes — safe to render or log. */
export type ShelfSummary = Omit<ShelfEntry, "dataUrl">;

export const SHELF_CAP = 8;
/** ~12M chars of data URL ≈ 9 MB of bytes; larger captures are not staged. */
export const SHELF_MAX_DATAURL_CHARS = 12_000_000;

export interface ShelfState {
  entries: ShelfEntry[];
  counter: number;
}

export function emptyShelf(): ShelfState {
  return { entries: [], counter: 0 };
}

/**
 * Stage one image: assign the next id, append, evict the oldest past the cap.
 * Returns a NEW state (the input is never mutated) so callers can diff/rollback.
 */
export function shelfStage(
  state: ShelfState,
  input: Omit<ShelfEntry, "id">,
): { state: ShelfState; id?: string; error?: string } {
  if (!input.dataUrl || !input.dataUrl.startsWith("data:")) {
    return { state, error: "not a data URL — nothing to stage" };
  }
  if (input.dataUrl.length > SHELF_MAX_DATAURL_CHARS) {
    return { state, error: "image too large to stage (> 9 MB decoded)" };
  }
  const counter = state.counter + 1;
  const id = `shot_${counter}`;
  const entries = [...state.entries, { ...input, id }];
  return {
    state: { entries: entries.slice(-SHELF_CAP), counter },
    id,
  };
}

/**
 * Look up a staged image. No id = the most recent capture (the overwhelmingly
 * common case: "screenshot, then send it"). Unknown ids resolve to undefined —
 * the caller says what IS on the shelf instead of guessing.
 */
export function shelfFind(state: ShelfState, id?: string): ShelfEntry | undefined {
  if (!state.entries.length) return undefined;
  const wanted = (id ?? "").trim().toLowerCase();
  if (!wanted) return state.entries[state.entries.length - 1];
  // Tolerate the natural mis-guesses: "3", "#3", "shot3", "img_3".
  const normalized = wanted.replace(/^(shot|img)[_\s-]*#?/, "").replace(/^#/, "");
  return (
    state.entries.find((e) => e.id.toLowerCase() === wanted) ??
    state.entries.find((e) => e.id === `shot_${normalized}`)
  );
}

export function shelfSummaries(state: ShelfState): ShelfSummary[] {
  return state.entries.map(({ dataUrl: _dataUrl, ...rest }) => rest);
}

// ---------------- persistence mirror (chrome.storage.session) ----------------

const KEY = "baShelf";

let cache: ShelfState | null = null;
let loading: Promise<ShelfState> | null = null;

function isState(v: unknown): v is ShelfState {
  const s = v as ShelfState | null;
  return !!s && Array.isArray(s.entries) && typeof s.counter === "number";
}

async function load(): Promise<ShelfState> {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    try {
      const stored = await chrome.storage.session.get(KEY);
      cache = isState(stored[KEY]) ? (stored[KEY] as ShelfState) : emptyShelf();
    } catch {
      cache = emptyShelf(); // storage unavailable — RAM-only shelf still works
    }
    return cache;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function save(state: ShelfState): Promise<void> {
  cache = state;
  try {
    await chrome.storage.session.set({ [KEY]: state });
  } catch {
    // the RAM cache is the source of truth for this worker's lifetime
  }
}

export interface StageInput {
  dataUrl: string;
  mime: string;
  name: string;
  tabId?: number;
  sourceUrl?: string;
  tabTitle?: string;
}

/**
 * Stage an image, filling in identity from the tab it came from (best effort —
 * an unnamed capture is still a capture). Returns the assigned id, or an error
 * when the bytes are not stageable.
 */
export async function stageShelfImage(
  input: StageInput,
): Promise<{ id?: string; error?: string }> {
  let sourceUrl = input.sourceUrl ?? "";
  let tabTitle = input.tabTitle ?? "";
  if (typeof input.tabId === "number" && (!sourceUrl || !tabTitle)) {
    try {
      const tab = await chrome.tabs.get(input.tabId);
      sourceUrl = sourceUrl || (tab.url ?? "");
      tabTitle = tabTitle || (tab.title ?? "");
    } catch {
      // tab gone — stage with whatever identity we have
    }
  }
  const state = await load();
  const staged = shelfStage(state, {
    dataUrl: input.dataUrl,
    mime: input.mime,
    name: input.name,
    sourceUrl,
    tabTitle,
    tabId: input.tabId ?? -1,
    at: Date.now(),
  });
  if (!staged.id) return { error: staged.error ?? "could not stage the image" };
  await save(staged.state);
  return { id: staged.id };
}

/** Fetch a staged image by id (default: most recent). */
export async function getShelfImage(id?: string): Promise<ShelfEntry | undefined> {
  return shelfFind(await load(), id);
}

/** Metadata of everything staged — never includes bytes. */
export async function listShelf(): Promise<ShelfSummary[]> {
  return shelfSummaries(await load());
}
