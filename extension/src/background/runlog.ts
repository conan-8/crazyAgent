// Run-log persistence in chrome.storage.local. Kept separate from the
// conversation store on purpose: conversations hold the folded display view
// (capped at 50), while this holds the full timestamped record of every turn —
// tool args/results, durations, usage and errors — for local archival/export.
//
// Layout: one key per record (`baLog:<id>`) plus a small summary index
// (`baLogIndex`). The original single-array store rewrote the WHOLE archive
// (up to 200 records, tool results up to 8k chars each) on every flush —
// under load that was multi-megabyte deserialize/serialize churn several
// times a minute inside the worker, one of the OOM sources that crash-looped
// the extension. Per-key writes touch only the running record; list views
// read only the index.
import {
  LOG_KEY,
  LOG_MAX_RUNS,
  summarizeRecord,
  type LogSummary,
  type LogTurnRecord,
} from "../shared/logging";

const INDEX_KEY = "baLogIndex";

function keyFor(id: string): string {
  return `baLog:${id}`;
}

/** Serialize index read-modify-writes: overlapping flushes must not interleave. */
let queue: Promise<void> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** One-time split of the legacy `baRunLogs` array into per-record keys. */
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
  const out = await chrome.storage.local.get([LOG_KEY, INDEX_KEY]);
  const legacy = out[LOG_KEY] as LogTurnRecord[] | undefined;
  if (legacy === undefined) return;
  if (out[INDEX_KEY] !== undefined) {
    // A newer layout already exists — the legacy copy is stale residue.
    await chrome.storage.local.remove(LOG_KEY);
    return;
  }
  const sorted = [...legacy]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, LOG_MAX_RUNS);
  const writes: Record<string, unknown> = {
    [INDEX_KEY]: sorted.map(summarizeRecord),
  };
  for (const rec of sorted) writes[keyFor(rec.id)] = rec;
  await chrome.storage.local.set(writes);
  await chrome.storage.local.remove(LOG_KEY);
}

async function readIndex(): Promise<LogSummary[]> {
  const out = await chrome.storage.local.get(INDEX_KEY);
  return (out[INDEX_KEY] as LogSummary[] | undefined) ?? [];
}

/** Write one record (key + index entry), evicting the oldest beyond the cap. */
export async function saveRecord(rec: LogTurnRecord): Promise<void> {
  await ensureMigrated();
  await serialized(async () => {
    const index = await readIndex();
    const next = [summarizeRecord(rec), ...index.filter((s) => s.id !== rec.id)]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, LOG_MAX_RUNS);
    const evicted = index.filter((s) => !next.some((n) => n.id === s.id));
    const writes: Record<string, unknown> = { [INDEX_KEY]: next };
    // A record that sorts past the cap (e.g. one resumed with an ancient
    // startedAt) is not written at all — no orphan key without an index entry.
    if (next.some((n) => n.id === rec.id)) writes[keyFor(rec.id)] = rec;
    await chrome.storage.local.set(writes);
    if (evicted.length) {
      await chrome.storage.local.remove(evicted.map((s) => keyFor(s.id)));
    }
  });
}

/** Full records, newest-first. Export/review only — never a per-flush path. */
export async function listRecords(): Promise<LogTurnRecord[]> {
  await ensureMigrated();
  const index = await readIndex();
  if (!index.length) return [];
  const out = await chrome.storage.local.get(index.map((s) => keyFor(s.id)));
  const records: LogTurnRecord[] = [];
  for (const s of index) {
    const rec = out[keyFor(s.id)] as LogTurnRecord | undefined;
    if (rec) records.push(rec);
  }
  return records;
}

export async function listSummaries(): Promise<LogSummary[]> {
  await ensureMigrated();
  return readIndex();
}

export async function getRecord(id: string): Promise<LogTurnRecord | null> {
  await ensureMigrated();
  const key = keyFor(id);
  const out = await chrome.storage.local.get(key);
  return (out[key] as LogTurnRecord | undefined) ?? null;
}

/**
 * The still-open record for a conversation (resume after an SW kill), found
 * via the index — the old path loaded every archived run to scan for it.
 */
export async function findOpenRecord(
  conversationId: string | undefined,
): Promise<LogTurnRecord | null> {
  if (!conversationId) return null;
  const hit = (await listSummaries()).find(
    (s) => s.status === "running" && s.conversationId === conversationId,
  );
  return hit ? getRecord(hit.id) : null;
}

export async function deleteRecord(id: string): Promise<void> {
  await ensureMigrated();
  await serialized(async () => {
    const index = (await readIndex()).filter((s) => s.id !== id);
    await chrome.storage.local.set({ [INDEX_KEY]: index });
    await chrome.storage.local.remove(keyFor(id));
  });
}

export async function clearRecords(): Promise<void> {
  await ensureMigrated();
  await serialized(async () => {
    const index = await readIndex();
    await chrome.storage.local.set({ [INDEX_KEY]: [] });
    if (index.length) {
      await chrome.storage.local.remove(index.map((s) => keyFor(s.id)));
    }
  });
}
