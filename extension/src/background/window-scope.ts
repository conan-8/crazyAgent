// Window scope — the agent's OWN browser window, and the wall around it.
//
// The agent used to bind its work to "the active tab of the focused window"
// (sw.ts agentTab), which with several windows open meant the USER's window:
// `tabs_list` listed every window, `tabs_switch` could hop into the user's
// tabs, and `ensureTabActive` raised whichever window it needed. So a run
// could not be left alone in one window while the user worked in another —
// and observation could silently follow the user's focus.
//
// This module is the single answer to "which window may the agent touch":
// it creates (or adopts) that window, hands out the tab the agent works on,
// and answers "is this tab mine?" for the tool wall in tools/tabs.ts.
//
// Window ids are only meaningful inside one browser session, and
// `chrome.storage.session` has exactly that lifetime: it survives service
// worker teardown (so a resume finds the same window) and is cleared on
// browser restart (when the id would be a lie). The in-memory mirror keeps the
// per-tool-call path free of extra round trips; `chrome.windows.onRemoved`
// invalidates it.
import { loadSettings, type AgentWindowMode } from "./settings";
import type { AgentWindowStatus } from "../shared/protocol";

const KEY = "agentWindow";

export interface WindowBinding {
  windowId: number;
  /** `created` = the agent made it; `adopted` = the user picked it. */
  kind: "created" | "adopted";
  at: number;
}

/** In-memory mirror of the stored binding (the common path pays nothing). */
let cached: number | undefined;
/** Raised-window counter: quiet mode must keep this at 0. */
let raises = 0;
/** Last status, so the panel can be refreshed without re-deriving everything. */
let listeners: ((windowId: number) => void)[] = [];

async function readBinding(): Promise<WindowBinding | null> {
  try {
    const out = await chrome.storage.session.get(KEY);
    return (out[KEY] as WindowBinding | undefined) ?? null;
  } catch {
    return null;
  }
}

async function writeBinding(binding: WindowBinding): Promise<void> {
  cached = binding.windowId;
  try {
    await chrome.storage.session.set({ [KEY]: binding });
  } catch {
    // Session storage unavailable: the in-memory binding still works for this
    // worker's lifetime. Never fail a run over bookkeeping.
  }
}

async function clearBinding(): Promise<void> {
  cached = undefined;
  try {
    await chrome.storage.session.remove(KEY);
  } catch {
    // see writeBinding
  }
}

/**
 * The agent's window, if one is bound and still alive. A stale id (the user
 * closed the window, or the browser restarted) is dropped rather than
 * returned — callers recreate instead of acting on a dead window.
 */
export async function resolveAgentWindow(): Promise<number | undefined> {
  if (cached !== undefined) return cached;
  const stored = await readBinding();
  if (!stored) return undefined;
  const alive = await chrome.windows.get(stored.windowId).catch(() => null);
  if (!alive) {
    await clearBinding();
    return undefined;
  }
  cached = stored.windowId;
  return cached;
}

/**
 * The window the agent works in, creating its own when none is bound. Created
 * WITHOUT focus (`focused:false`): the user asked to keep working in their own
 * window while a run proceeds, so a new window must never yank focus.
 */
export async function ensureAgentWindow(): Promise<number> {
  const existing = await resolveAgentWindow();
  if (existing !== undefined) return existing;
  const win = await chrome.windows.create({ url: "about:blank", focused: false });
  const windowId = win?.id;
  if (typeof windowId !== "number") {
    throw new Error(
      "could not create an agent window (chrome.windows.create returned no window id)",
    );
  }
  await writeBinding({ windowId, kind: "created", at: Date.now() });
  return windowId;
}

/** The stored binding as-is (no liveness check) — used for mode decisions. */
export async function agentWindowBinding(): Promise<WindowBinding | null> {
  return readBinding();
}

/** Adopt a window the user picked ("use this window for the agent"). */
export async function bindAgentWindow(
  windowId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win) {
    return { ok: false, error: `window ${windowId} does not exist` };
  }
  await writeBinding({ windowId, kind: "adopted", at: Date.now() });
  return { ok: true };
}

/** Forget an adopted window: the agent gets its own again on next use. */
export async function releaseAgentWindow(): Promise<void> {
  await clearBinding();
}

/** Forget the in-memory mirror (window closed / browser event). */
export function forgetAgentWindow(windowId?: number): void {
  if (windowId === undefined || cached === windowId) cached = undefined;
}

/**
 * Invalidate on window close and tell the service worker, so it can announce
 * the change (and so a run's next step recreates the window instead of acting
 * on a corpse). Safe to call once per worker start.
 */
export function initWindowScope(onGone?: (windowId: number) => void): void {
  listeners = onGone ? [onGone] : [];
  if (typeof chrome === "undefined" || !chrome.windows?.onRemoved) return;
  chrome.windows.onRemoved.addListener((windowId) => {
    const wasAgentWindow = cached === windowId;
    forgetAgentWindow(windowId);
    if (!wasAgentWindow) return;
    void clearBinding();
    for (const listener of listeners) listener(windowId);
  });
}

/**
 * Pages the agent can never act on (the browser's own UI, the extension's own
 * pages). They must never become a run's starting tab: in "adopt" mode the
 * agent works in the user's window, and the tab that happens to be active there
 * can easily be chrome://extensions or the panel itself.
 */
function unactable(url: string | undefined): boolean {
  const u = (url ?? "").toLowerCase();
  if (!u) return false;
  if (u === "about:blank") return false;
  return /^(chrome|edge|brave|opera|devtools|about|view-source|chrome-extension|extension|moz-extension):/.test(
    u,
  );
}

/**
 * A tab to work on, always inside the agent window: its active tab, or a fresh
 * blank one when the window is empty. Returns undefined only when the browser
 * refuses to give the agent any tab at all.
 */
export async function ensureAgentTab(): Promise<number | undefined> {
  const windowId = await ensureAgentWindow();
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  const chosen =
    tabs.find((t) => t.active && !unactable(t.url)) ??
    tabs.find((t) => !unactable(t.url)) ??
    tabs.find((t) => t.active) ??
    tabs[0];
  if (chosen?.id !== undefined) return chosen.id;
  const created = await chrome.tabs
    .create({ windowId, url: "about:blank", active: true })
    .catch(() => null);
  return created?.id;
}

/** Is this tab inside the agent's window? */
export async function tabInAgentWindow(tabId: number): Promise<boolean> {
  const windowId = await resolveAgentWindow();
  if (windowId === undefined) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab?.windowId === windowId;
}

/**
 * The tool wall. One message shape for every out-of-window refusal: it names
 * the layer, says the call cannot succeed, and gives the three real ways
 * forward — so the model changes approach instead of retrying (the failure
 * convention in shared/tool-failure.ts).
 */
export function outOfWindowMessage(tabId: number, tabWindowId?: number): string {
  return (
    `TOOL-FAILED: tab ${tabId} is in the user's window` +
    (tabWindowId !== undefined ? ` (window ${tabWindowId})` : "") +
    ", not in the agent's own window — you cannot see or act on tabs outside it. " +
    "Do not retry this call. Three ways forward: (1) ask the user to hand that tab over — " +
    'the panel has a "Hand this tab to the agent" button; (2) open the page yourself with ' +
    "tabs_create, which always opens in your own window; (3) if you only need to LOOK at which " +
    'tabs the user has open, tell the user to switch on "Look outside" for the run.'
  );
}

/** Refusal check for the tab tools; `{ok:true}` means the tab is fair game. */
export async function assertInAgentWindow(
  tabId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    return {
      ok: false,
      error: `TOOL-FAILED: tab ${tabId} no longer exists — take a fresh snapshot or call tabs_list to see your window's tabs.`,
    };
  }
  if (await tabInAgentWindow(tabId)) return { ok: true };
  return { ok: false, error: outOfWindowMessage(tabId, tab.windowId) };
}

/**
 * Move one of the user's tabs into the agent's window ("hand this tab to the
 * agent"). A MOVE, not a copy: the page keeps its state (scroll, form, media)
 * instead of being reloaded from its URL.
 */
export async function moveTabIntoAgentWindow(
  tabId: number,
): Promise<{ ok: true; tabId: number; windowId: number } | { ok: false; error: string }> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: `tab ${tabId} no longer exists` };
  const windowId = await ensureAgentWindow();
  if (tab.windowId === windowId) return { ok: true, tabId, windowId };
  const source = tab.windowId;
  if (typeof source === "number" && source !== chrome.windows.WINDOW_ID_NONE) {
    const siblings = await chrome.tabs.query({ windowId: source }).catch(() => []);
    // Taking the LAST tab out of a window closes that window. The user asked
    // for a tab to be handed over, not for their window to disappear.
    if (siblings.length <= 1) {
      await chrome.tabs.create({ windowId: source, active: true }).catch(() => null);
    }
  }
  try {
    await chrome.tabs.move(tabId, { windowId, index: -1 });
    await chrome.tabs.update(tabId, { active: true });
  } catch (err) {
    return {
      ok: false,
      error: `could not move tab ${tabId} into the agent window: ${String(
        (err as Error)?.message ?? err,
      )}`,
    };
  }
  return { ok: true, tabId, windowId };
}

/**
 * The ONLY place this extension focuses a browser window. Quiet mode (the
 * default) never calls it — a run must not steal the user's focus — so the
 * counter it bumps is what tests and smokes assert against. Callers are user
 * gestures only (the panel's "Bring it forward" button).
 */
export async function raiseWindow(
  windowId: number,
  _reason: string,
): Promise<boolean> {
  raises += 1;
  try {
    await chrome.windows.update(windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

/** How many windows this session has raised (0 in quiet mode). */
export function raiseAttempts(): number {
  return raises;
}

/**
 * The opt-out path for input: when the user turns "Never take focus" OFF, a
 * stroke that needs a frontmost window raises the AGENT's window first (never
 * the user's). Quiet mode — the default — never gets here, so the raise
 * counter stays 0 for every run that did not ask for it.
 */
export async function ensureWindowForInput(windowId: number): Promise<void> {
  const settings = await loadSettings().catch(() => null);
  if (settings?.agentWindow.quietFocus !== false) return;
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (win && !win.focused) {
    await raiseWindow(windowId, "input needs a frontmost window (quiet focus off)");
  }
}

/** Test seam: forget the cached binding and the raise counter. */
export function resetWindowScopeForTests(): void {
  cached = undefined;
  raises = 0;
}

/** What the panel renders: mode, window, tab count, raise counter. */
export async function windowStatus(): Promise<AgentWindowStatus> {
  const settings = await loadSettings().catch(() => null);
  const mode: AgentWindowMode = settings?.agentWindow.mode ?? "own";
  const windowId = await resolveAgentWindow();
  if (windowId === undefined) {
    return { mode, alive: false, tabs: 0, raiseAttempts: raises };
  }
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  const active = tabs.find((t) => t.active) ?? tabs[0];
  return {
    mode,
    windowId,
    alive: true,
    tabs: tabs.length,
    activeTabId: active?.id,
    raiseAttempts: raises,
  };
}