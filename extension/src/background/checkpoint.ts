// Checkpoint persistence. Session storage survives service-worker teardown
// (only browser restart / extension reload clears it), which is exactly the
// durability window this needs.
import type { Checkpoint } from "../shared/protocol";

const KEY = "checkpoint";

export async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  await chrome.storage.session.set({ [KEY]: cp });
}

export async function loadCheckpoint(): Promise<Checkpoint | null> {
  const out = await chrome.storage.session.get(KEY);
  return (out[KEY] as Checkpoint | undefined) ?? null;
}

export async function clearCheckpoint(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
