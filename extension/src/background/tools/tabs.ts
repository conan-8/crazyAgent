// Tab and navigation tools (chrome.tabs / history primitives).
//
// Window isolation lives here: the agent works inside ONE window (its own —
// background/window-scope.ts) and every tab tool enforces that. `tabs_list` is
// the only tool that can ever mention another window's tabs, and only when the
// user granted it for the run (read-only, marked `window:"user"`).
import { assertInAgentWindow, ensureAgentWindow, resolveAgentWindow } from "../window-scope";
import { registerTool } from "./types";

registerTool({
  name: "navigate",
  description:
    "Navigate the active tab to a URL. The result comes back already settled, with a fresh snapshot of the new page appended — read that instead of calling wait_for_settle or snapshot afterwards.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL" } },
    required: ["url"],
  },
  async run(args, ctx) {
    await chrome.tabs.update(ctx.tabId, { url: String(args.url) });
    return { ok: true };
  },
});

registerTool({
  name: "reload",
  description: "Reload the active tab.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    await chrome.tabs.reload(ctx.tabId);
    return { ok: true };
  },
});

registerTool({
  name: "back",
  description: "Go back in the active tab's history.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId, frameIds: [0] },
      func: () => history.go(-1),
    });
    return { ok: true };
  },
});

registerTool({
  name: "forward",
  description: "Go forward in the active tab's history.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId, frameIds: [0] },
      func: () => history.go(1),
    });
    return { ok: true };
  },
});

registerTool({
  name: "tabs_list",
  description:
    "List the tabs in your own window (id, title, url, active). This is your whole world: the user's other windows are not listed unless the user switched on 'look outside' for this run, in which case their tabs appear marked window:\"user\" and are READ-ONLY.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    const windowId = (await resolveAgentWindow()) ?? (await ensureAgentWindow());
    const mine = await chrome.tabs.query({ windowId });
    const rows: {
      tabId?: number;
      title: string;
      url: string;
      active: boolean;
      window: "agent" | "user";
    }[] = mine.map((t) => ({
      tabId: t.id,
      title: t.title ?? "",
      url: t.url ?? "",
      active: Boolean(t.active),
      window: "agent" as const,
    }));
    // "Look outside" (a per-run grant from the USER, never something the model
    // sets) widens LISTING only. Acting outside stays impossible: tabs_switch
    // and tabs_close enforce the wall themselves.
    if (ctx.scope?.allowOutside) {
      const others = (await chrome.tabs.query({})).filter(
        (t) => t.windowId !== windowId && t.id !== undefined,
      );
      for (const t of others) {
        rows.push({
          tabId: t.id,
          title: t.title ?? "",
          url: t.url ?? "",
          active: Boolean(t.active),
          window: "user",
        });
      }
    }
    return rows;
  },
});

registerTool({
  name: "tabs_create",
  description:
    "Open a new tab with a URL. It always opens in YOUR window and becomes the tab you work on, even if you are currently somewhere else.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL" } },
    required: ["url"],
  },
  async run(args) {
    // Forced into the agent window rather than inherited from the current tab:
    // a bare chrome.tabs.create lands in whatever window happens to be focused
    // (the USER's), and with several windows open the new tab is then
    // invisible to screenshots of the agent's window — a live run lost ten
    // minutes to exactly that.
    const windowId = await ensureAgentWindow();
    const tab = await chrome.tabs.create({
      url: String(args.url),
      active: true,
      windowId,
    });
    return { tabId: tab.id };
  },
});

registerTool({
  name: "tabs_close",
  description: "Close one of YOUR tabs by id.",
  parameters: {
    type: "object",
    properties: { tabId: { type: "number", description: "Tab id from tabs_list" } },
    required: ["tabId"],
  },
  async run(args) {
    const tabId = Number(args.tabId);
    const allowed = await assertInAgentWindow(tabId);
    if (!allowed.ok) return { ok: false, error: allowed.error };
    await chrome.tabs.remove(tabId);
    return { ok: true };
  },
});

registerTool({
  name: "tabs_switch",
  description:
    "Switch to one of YOUR tabs by id (this becomes the tab tools act on). Tabs in the user's windows cannot be switched to.",
  parameters: {
    type: "object",
    properties: { tabId: { type: "number", description: "Tab id from tabs_list" } },
    required: ["tabId"],
  },
  async run(args) {
    const tabId = Number(args.tabId);
    const allowed = await assertInAgentWindow(tabId);
    if (!allowed.ok) return { ok: false, error: allowed.error };
    // Activating the tab is all this does: it becomes the renderer the input
    // goes to (perception follows the tracked tab, not the focused window).
    // The window is deliberately NOT focused — a run must not steal the user's
    // focus while they work in another window (they opted into exactly that).
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    return { ok: true, tabId, windowId: tab.windowId };
  },
});
