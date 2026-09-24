// Run-log persistence in chrome.storage.local. Kept separate from
// `baConversations` on purpose: conversations hold the folded display view
// (capped at 50), while this holds the full timestamped record of every turn —
// tool args/results, durations, usage and errors — for local archival/export.
import {
  LOG_KEY,
  LOG_MAX_RUNS,
  appendRecord,
  type LogSummary,
  type LogTurnRecord,
  summarizeRecord,
} from "../shared/logging";

async function loadAll(): Promise<LogTurnRecord[]> {
  const out = await chrome.storage.local.get(LOG_KEY);
  return (out[LOG_KEY] as LogTurnRecord[] | undefined) ?? [];
}

async function saveAll(records: LogTurnRecord[]): Promise<void> {
  await chrome.storage.local.set({ [LOG_KEY]: records });
}

/** Write one record, evicting the oldest beyond the cap. */
export async function saveRecord(rec: LogTurnRecord): Promise<void> {
  await saveAll(appendRecord(await loadAll(), rec, LOG_MAX_RUNS));
}

export async function listRecords(): Promise<LogTurnRecord[]> {
  return (await loadAll()).sort((a, b) => b.startedAt - a.startedAt);
}

export async function listSummaries(): Promise<LogSummary[]> {
  return (await listRecords()).map(summarizeRecord);
}

export async function getRecord(id: string): Promise<LogTurnRecord | null> {
  return (await loadAll()).find((r) => r.id === id) ?? null;
}

export async function deleteRecord(id: string): Promise<void> {
  await saveAll((await loadAll()).filter((r) => r.id !== id));
}

export async function clearRecords(): Promise<void> {
  await saveAll([]);
}