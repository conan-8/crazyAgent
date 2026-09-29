// Checkpoint persistence. Session storage survives service-worker teardown
// (only browser restart / extension reload clears it), which is exactly the
// durability window this needs.
import type { LlmMessage } from "../shared/llm";
import type { Checkpoint } from "../shared/protocol";

const KEY = "checkpoint";

/**
 * Screenshots ride in tool messages as base64, and a checkpoint is saved after
 * EVERY step — keeping every past capture made each save heavier than the task
 * itself (megabytes of JSON re-serialized per step). The loop only ever sends
 * the newest few images in its requests anyway (MAX_LIVE_IMAGES in
 * agent/loop.ts), so store the same allowance and strip the rest.
 */
const MAX_STORED_IMAGES = 4;

/** Same checkpoint with old screenshot bytes stripped (copy — `cp` stays live). */
function stripOldImages(cp: Checkpoint): Checkpoint {
  let seen = 0;
  const messages: LlmMessage[] = [...cp.messages]
    .reverse()
    .map((m) => {
      if (!m.images?.length) return m;
      seen += m.images.length;
      return seen > MAX_STORED_IMAGES ? { ...m, images: undefined } : m;
    })
    .reverse();
  return { ...cp, messages };
}

export async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  await chrome.storage.session.set({ [KEY]: stripOldImages(cp) });
}

export async function loadCheckpoint(): Promise<Checkpoint | null> {
  const out = await chrome.storage.session.get(KEY);
  return (out[KEY] as Checkpoint | undefined) ?? null;
}

export async function clearCheckpoint(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
