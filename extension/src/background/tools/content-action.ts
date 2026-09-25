// The content-script bridge: refs are `frameId#localRef`, and every action runs
// inside the frame that owns the ref (the content script is in every frame, so
// this works cross-origin where CDP evaluation would need a context id).
//
// Split out of tools/actions.ts so the trusted-input driver can focus a sink in
// its own frame without importing the tool module (which imports it back).
import type { ActionResult } from "../../content/actions";

export function parseRef(ref: string): { frameId: number; localRef: string } {
  const hash = ref.indexOf("#");
  if (hash === -1) return { frameId: 0, localRef: ref };
  return {
    frameId: Number(ref.slice(0, hash)),
    localRef: ref.slice(hash + 1),
  };
}

export function makeRef(frameId: number, localRef: string): string {
  return frameId ? `${frameId}#${localRef}` : localRef;
}

/**
 * Run one action in the frame that owns `req.ref`. A ref without a frame prefix
 * means the top frame (0).
 */
export async function runContentAction(
  tabId: number,
  req: Record<string, unknown>,
): Promise<ActionResult> {
  const ref = typeof req.ref === "string" ? req.ref : null;
  const frameId = ref ? parseRef(ref).frameId : 0;
  const payload = ref ? { ...req, ref: parseRef(ref).localRef } : req;
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (p: unknown) => {
      const g = globalThis as {
        __baActions?: { run(r: unknown): unknown };
      };
      return g.__baActions
        ? g.__baActions.run(p)
        : { ok: false, error: "actions-not-loaded" };
    },
    args: [payload],
  });
  return (results[0]?.result ?? { ok: false, error: "no result" }) as ActionResult;
}
