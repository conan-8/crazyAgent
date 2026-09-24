// Task history (last outcomes), written by the worker on `done` events and
// shown in the panel for quick re-runs.
import type { StepEvent } from "../shared/protocol";

export interface HistoryEntry {
  task: string;
  summary: string;
  when: number;
}

const KEY = "baHistory";
const MAX = 20;

export async function recordHistory(
  task: string,
  event: Extract<StepEvent, { kind: "done" }>,
): Promise<void> {
  const out = await chrome.storage.local.get(KEY);
  const list = (out[KEY] as HistoryEntry[] | undefined) ?? [];
  list.unshift({ task, summary: event.summary, when: Date.now() });
  await chrome.storage.local.set({ [KEY]: list.slice(0, MAX) });
}

export async function listHistory(): Promise<HistoryEntry[]> {
  const out = await chrome.storage.local.get(KEY);
  return (out[KEY] as HistoryEntry[] | undefined) ?? [];
}
