// Tab and navigation tools (chrome.tabs / history primitives).
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
  description: "List open tabs (id, title, url, active).",
  parameters: { type: "object", properties: {} },
  async run() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      tabId: t.id,
      title: t.title ?? "",
      url: t.url ?? "",
      active: Boolean(t.active),
    }));
  },
});

registerTool({
  name: "tabs_create",
  description: "Open a new tab with a URL and switch to it.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL" } },
    required: ["url"],
  },
  async run(args, ctx) {
    // Create in the SAME window as the tab the agent is working on. A bare
    // chrome.tabs.create lands in whatever window happens to be focused, and
    // with several windows open the new tab is then invisible to screenshots
    // of the agent's window (a live run lost ten minutes to exactly that).
    const current = await chrome.tabs.get(ctx.tabId).catch(() => null);
    const tab = await chrome.tabs.create({
      url: String(args.url),
      active: true,
      ...(current ? { windowId: current.windowId } : {}),
    });
    return { tabId: tab.id };
  },
});

registerTool({
  name: "tabs_close",
  description: "Close a tab by id.",
  parameters: {
    type: "object",
    properties: { tabId: { type: "number", description: "Tab id from tabs_list" } },
    required: ["tabId"],
  },
  async run(args) {
    await chrome.tabs.remove(Number(args.tabId));
    return { ok: true };
  },
});

registerTool({
  name: "tabs_switch",
  description: "Switch to a tab by id (this becomes the tab tools act on).",
  parameters: {
    type: "object",
    properties: { tabId: { type: "number", description: "Tab id from tabs_list" } },
    required: ["tabId"],
  },
  async run(args) {
    const tabId = Number(args.tabId);
    // Activating the tab is not enough when it lives in a different window:
    // perception (screenshots, snapshots) follows the FOCUSED window, so a
    // switch that leaves focus elsewhere silently keeps observing the old
    // page. Focus the tab's window too — that is what a user switching tabs
    // actually does.
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined && tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => null);
    }
    return { ok: true, tabId, windowId: tab.windowId };
  },
});
