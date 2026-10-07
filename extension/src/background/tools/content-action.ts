// The content-script bridge: refs are `frameId#localRef`, and every action runs
// inside the frame that owns the ref (the content script is in every frame, so
// this works cross-origin where CDP evaluation would need a context id).
//
// Split out of tools/actions.ts so the trusted-input driver can focus a sink in
// its own frame without importing the tool module (which imports it back).
//
// Self-healing bridge (from the 2026-10-06 field test): an extension reload
// leaves ALREADY-OPEN tabs without the content script — main.js only runs on a
// fresh document — while the debugger channel keeps working, so click_at /
// screenshot / evaluate_js / docs_locate stay healthy and every content-script
// action (click by ref, key, scroll, menu_path, input_sequence) fails with
// "actions-not-loaded". Run F lost ~40 turns to exactly that, and the generic
// injection probe in page_health still said "ok", so the model concluded the
// tools were broken and abandoned label walks for raw DOM clicks. The bridge is
// therefore repaired on demand: inject the bundle (idempotent — main.ts guards
// on __baContentLoaded) and retry the action once.
import type { ActionResult } from "../../content/actions";

/** The built bundle, spelled exactly as extension/manifest.json declares it. */
const CONTENT_SCRIPT_FILE = "content/main.js";

/** `chrome.scripting` without assuming the global exists (unit tests). */
function scriptingApi(): typeof chrome.scripting | undefined {
  try {
    return typeof chrome !== "undefined" ? chrome.scripting : undefined;
  } catch {
    return undefined;
  }
}

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

/** Whether the action bridge is present in `frameId` right now. */
export async function probeContentBridge(tabId: number, frameId = 0): Promise<boolean> {
  const scripting = scriptingApi();
  if (!scripting?.executeScript) return false;
  try {
    const results = await scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => Boolean((globalThis as { __baActions?: unknown }).__baActions),
    });
    return results[0]?.result === true;
  } catch {
    return false;
  }
}

/**
 * Inject the content-script bundle into `frameId` and report whether the bridge
 * took. Idempotent, and silent on failure — callers use the boolean, never an
 * exception (a page that cannot be injected is a page that cannot be injected).
 */
export async function ensureContentBridge(tabId: number, frameId = 0): Promise<boolean> {
  const scripting = scriptingApi();
  if (!scripting?.executeScript) return false;
  try {
    await scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch {
    return false;
  }
  return probeContentBridge(tabId, frameId);
}

/**
 * Run one action in the frame that owns `req.ref`. A ref without a frame prefix
 * means the top frame (0). An explicit `frameId` overrides the routing for
 * ref-less requests that still belong to a frame (frame-local coordinates).
 *
 * A missing bridge is repaired once and the action retried; the successful
 * result is marked `repaired` so the run log can tell a healed call from a
 * healthy one, and a still-broken call says what to use instead.
 */
export async function runContentAction(
  tabId: number,
  req: Record<string, unknown>,
  frameId?: number,
): Promise<ActionResult> {
  const ref = typeof req.ref === "string" ? req.ref : null;
  const target = frameId ?? (ref ? parseRef(ref).frameId : 0);
  const payload = ref ? { ...req, ref: parseRef(ref).localRef } : req;
  const attempt = async (): Promise<ActionResult> => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [target] },
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
  };
  const first = await attempt();
  if (first.ok || first.error !== "actions-not-loaded") return first;
  // Missing bridge: inject the bundle and retry, or say plainly which tools do
  // still work so the model stops retrying a layer that is dead in this frame.
  if (!(await ensureContentBridge(tabId, target))) {
    return {
      ...first,
      error:
        `${first.error}: the content-script bridge is missing in this frame and could not be repaired — ` +
        `prefer the debugger-backed tools (snapshot, click_at, screenshot, docs_read) for this page`,
    };
  }
  const second = await attempt();
  if (second.ok) return { ...second, repaired: true };
  return {
    ...second,
    error:
      `${second.error ?? "action failed"}; the harness re-injected the content script and the call still failed — ` +
      `prefer the debugger-backed tools (snapshot, click_at, screenshot, docs_read) for this page`,
  };
}