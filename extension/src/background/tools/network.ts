// Network tools — Unlimited mode only (helper daemon). `network_mock` and
// `network_rewrite` are sensitive and gated by the policy layer.
import { registerTool } from "./types";

function interceptOrThrow(
  adapter: { intercept?: (tabId: number, params: Record<string, unknown>) => Promise<unknown> },
  tabId: number,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!adapter.intercept) {
    return Promise.reject(
      new Error("network tools require Unlimited mode (helper daemon)"),
    );
  }
  return adapter.intercept(tabId, params);
}

registerTool({
  name: "network_mock",
  description:
    "Mock an API endpoint: requests whose URL matches the pattern are fulfilled with the given body (SENSITIVE — confirmation required). Unlimited mode only.",
  parameters: {
    type: "object",
    properties: {
      urlPattern: { type: "string", description: "Wildcard URL pattern, e.g. '*/api/data*'" },
      body: { type: "string", description: "Response body (JSON string)" },
      status: { type: "number", description: "HTTP status (default 200)" },
      contentType: { type: "string", description: "Content type (default application/json)" },
    },
    required: ["urlPattern", "body"],
  },
  sensitive: true,
  run: (args, ctx) =>
    interceptOrThrow(ctx.adapter, ctx.tabId, {
      action: "mock",
      urlPattern: String(args.urlPattern),
      body: String(args.body),
      status: typeof args.status === "number" ? args.status : 200,
      contentType: typeof args.contentType === "string" ? args.contentType : undefined,
    }),
});

registerTool({
  name: "network_rewrite",
  description:
    "Rewrite matching requests (redirect URL and/or headers) before they are sent (SENSITIVE — confirmation required). Unlimited mode only.",
  parameters: {
    type: "object",
    properties: {
      urlPattern: { type: "string", description: "Wildcard URL pattern to match" },
      url: { type: "string", description: "Replacement URL" },
      headers: { type: "object", description: "Replacement request headers" },
    },
    required: ["urlPattern"],
  },
  sensitive: true,
  run: (args, ctx) =>
    interceptOrThrow(ctx.adapter, ctx.tabId, {
      action: "rewrite",
      urlPattern: String(args.urlPattern),
      url: typeof args.url === "string" ? args.url : undefined,
      headers: args.headers,
    }),
});

registerTool({
  name: "network_observe",
  description:
    "Record network requests for this tab and return the log so far. Unlimited mode only.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    await interceptOrThrow(ctx.adapter, ctx.tabId, { action: "observe" });
    return interceptOrThrow(ctx.adapter, ctx.tabId, { action: "list" });
  },
  present(payload) {
    const reqs = (payload as { requests: { url: string; method: string }[] }).requests;
    return {
      text: reqs.map((r) => `${r.method} ${r.url}`).join("\n") || "(no requests)",
    };
  },
});

registerTool({
  name: "network_clear",
  description: "Remove all network mocks/rewrites and stop observing. Unlimited mode only.",
  parameters: { type: "object", properties: {} },
  run: (_args, ctx) => interceptOrThrow(ctx.adapter, ctx.tabId, { action: "clear" }),
});
