// Sensitive tools, gated behind confirmation by the policy layer.
import { registerTool } from "./types";

registerTool({
  name: "evaluate_js",
  description:
    "Evaluate JavaScript in the page's isolated extension world and return JSON-stringified results (SENSITIVE — requires user confirmation).",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "JavaScript expression to evaluate" },
    },
    required: ["expression"],
  },
  sensitive: true,
  async run(args, ctx) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId, frameIds: [0] },
      func: (expr: string) => {
        try {
          // eslint-disable-next-line no-eval
          const value = eval(expr);
          return { ok: true, value: JSON.stringify(value ?? null).slice(0, 4_000) };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
      args: [String(args.expression)],
    });
    return results[0]?.result ?? { ok: false, error: "no result" };
  },
});

registerTool({
  name: "download",
  description:
    "Download a URL via the browser's download manager (SENSITIVE — requires user confirmation).",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "URL to download" } },
    required: ["url"],
  },
  sensitive: true,
  async run(args) {
    const downloadId = await chrome.downloads.download({ url: String(args.url) });
    return { downloadId };
  },
});
