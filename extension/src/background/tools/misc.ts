// Sensitive tools, gated behind confirmation by the policy layer.
import { registerTool } from "./types";

interface RemoteObject {
  type: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

export interface EvaluateResponse {
  result: RemoteObject;
  exceptionDetails?: { text?: string; exception?: RemoteObject };
}

export type EvalOutcome = { ok: true; value: string } | { ok: false; error: string };

/** Shape a CDP `Runtime.evaluate` response into the tool's JSON result. */
export function shapeEvalResult(res: EvaluateResponse): EvalOutcome {
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    return {
      ok: false,
      error: String(d.exception?.description ?? d.text ?? "evaluation failed").slice(0, 1_000),
    };
  }
  const r = res.result;
  // NaN, Infinity, -0 and bigints have no JSON form.
  if (r.unserializableValue !== undefined) return { ok: true, value: r.unserializableValue };
  if (r.value !== undefined) {
    return { ok: true, value: JSON.stringify(r.value ?? null).slice(0, 4_000) };
  }
  if (r.type === "undefined") return { ok: true, value: "null" };
  // Functions, symbols etc. don't serialize by value — fall back to their description.
  return { ok: true, value: JSON.stringify(r.description ?? r.type).slice(0, 4_000) };
}

const EVAL_TIMEOUT_MS = 30_000;

registerTool({
  name: "evaluate_js",
  description:
    "Evaluate a JavaScript expression in the page's main world via the DevTools protocol and return the JSON-stringified result (promises are awaited). Runs regardless of the page's Content-Security-Policy. Set bypass_csp to also disable the page's CSP for this tab (so injected <script> tags, inline handlers and fetches the CSP would block are allowed) — it covers documents loaded after the call, so reload or navigate for it to apply to the current page (SENSITIVE — requires user confirmation).",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "JavaScript expression to evaluate" },
      bypass_csp: {
        type: "boolean",
        description:
          "Disable the page's Content-Security-Policy for this tab (applies from the next load)",
      },
    },
    required: ["expression"],
  },
  sensitive: true,
  async run(args, ctx) {
    let cspBypass: string | undefined;
    if (args.bypass_csp === true) {
      await ctx.adapter.send(ctx.tabId, "Page.setBypassCSP", { enabled: true });
      cspBypass = "enabled for this tab; reload or navigate to lift the current document's CSP";
    }
    const res = await Promise.race([
      ctx.adapter.send<EvaluateResponse>(ctx.tabId, "Runtime.evaluate", {
        expression: String(args.expression),
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`evaluation did not settle within ${EVAL_TIMEOUT_MS / 1000}s`)),
          EVAL_TIMEOUT_MS,
        ),
      ),
    ]);
    const outcome = shapeEvalResult(res);
    return cspBypass ? { ...outcome, cspBypass } : outcome;
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
