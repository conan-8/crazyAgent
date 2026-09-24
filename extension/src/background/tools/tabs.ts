// Tab and navigation tools (chrome.tabs / history primitives).
import { registerTool } from "./types";

registerTool({
  name: "navigate",
  description: "Navigate the active tab to a URL. Follow with wait_for_settle.",
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
  async run(args) {
    const tab = await chrome.tabs.create({ url: String(args.url), active: true });
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
    await chrome.tabs.update(Number(args.tabId), { active: true });
    return { ok: true };
  },
});
