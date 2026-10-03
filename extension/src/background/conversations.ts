// Conversation persistence (chat history) in chrome.storage.local.
//
// Layout: one key per conversation (`baConv:<id>`) plus a small summary index
// (`baConvIndex`). The original single-array store rewrote EVERY saved thread
// — screenshots and full LLM transcripts included — on every flush; under
// load that meant multi-megabyte deserialize/serialize cycles of the whole
// archive several times a minute inside the worker, which was the main
// OOM source crash-looping the extension. Per-key writes touch only the one
// thread that changed, and list views read only the kilobyte-sized index.
import { summarize, type Conversation, type ConversationSummary } from "../shared/chat";

/** Legacy single-array key (pre per-conversation layout); migrated on access. */
const LEGACY_KEY = "baConversations";
const INDEX_KEY = "baConvIndex";
const MAX = 50;

function keyFor(id: string): string {
  return `baConv:${id}`;
}

/**
 * Writes that touch the index run through one queue. Flushes can overlap
 * (timers, run-end, deletes); interleaved read-modify-writes of the index
 * would resurrect or drop entries at random.
 */
let queue: Promise<void> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** One-time split of the legacy array into per-conversation keys + index. */
let migrated: Promise<void> | null = null;
function ensureMigrated(): Promise<void> {
  // On failure the guard resets so the next access retries instead of caching
  // a rejected promise for the worker's lifetime.
  migrated ??= migrate().catch((err) => {
    migrated = null;
    throw err;
  });
  return migrated;
}

async function migrate(): Promise<void> {
  const out = await chrome.storage.local.get([LEGACY_KEY, INDEX_KEY]);
  const legacy = out[LEGACY_KEY] as Conversation[] | undefined;
  if (legacy === undefined) return;
  if (out[INDEX_KEY] !== undefined) {
    // A newer layout already exists — the legacy copy is stale residue.
    await chrome.storage.local.remove(LEGACY_KEY);
    return;
  }
  const sorted = [...legacy].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX);
  const writes: Record<string, unknown> = {
    [INDEX_KEY]: sorted.map(summarize),
  };
  for (const conv of sorted) writes[keyFor(conv.id)] = conv;
  await chrome.storage.local.set(writes);
  await chrome.storage.local.remove(LEGACY_KEY);
}

async function readIndex(): Promise<ConversationSummary[]> {
  const out = await chrome.storage.local.get(INDEX_KEY);
  return (out[INDEX_KEY] as ConversationSummary[] | undefined) ?? [];
}

/** Cheap list view: summaries only, never the stored threads themselves. */
export async function listConversationSummaries(): Promise<ConversationSummary[]> {
  await ensureMigrated();
  return readIndex();
}

export async function getConversation(id: string): Promise<Conversation | null> {
  await ensureMigrated();
  const key = keyFor(id);
  const out = await chrome.storage.local.get(key);
  return (out[key] as Conversation | undefined) ?? null;
}

export async function saveConversation(conv: Conversation): Promise<void> {
  await ensureMigrated();
  await serialized(async () => {
    const index = await readIndex();
    const next = [summarize(conv), ...index.filter((s) => s.id !== conv.id)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX);
    const evicted = index.filter((s) => !next.some((n) => n.id === s.id));
    const writes: Record<string, unknown> = { [INDEX_KEY]: next };
    // A thread that sorts past the cap (e.g. a resumed one with an ancient
    // updatedAt) is not written at all — no orphan key without an index entry.
    if (next.some((n) => n.id === conv.id)) writes[keyFor(conv.id)] = conv;
    await chrome.storage.local.set(writes);
    if (evicted.length) {
      await chrome.storage.local.remove(evicted.map((s) => keyFor(s.id)));
    }
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await ensureMigrated();
  await serialized(async () => {
    const index = (await readIndex()).filter((s) => s.id !== id);
    await chrome.storage.local.set({ [INDEX_KEY]: index });
    await chrome.storage.local.remove(keyFor(id));
  });
}

/**
 * Rename a stored thread: the title lives both in the summary index and on
 * the conversation itself, so both are rewritten in one serialized step.
 * No-op when the thread is unknown (e.g. renamed before its first save).
 */
export async function renameConversation(id: string, title: string): Promise<void> {
  await ensureMigrated();
  await serialized(async () => {
    const key = keyFor(id);
    const out = await chrome.storage.local.get(key);
    const conv = out[key] as Conversation | undefined;
    const index = await readIndex();
    const writes: Record<string, unknown> = {
      [INDEX_KEY]: index.map((s) => (s.id === id ? { ...s, title } : s)),
    };
    if (conv) writes[key] = { ...conv, title };
    await chrome.storage.local.set(writes);
  });
}
