// Sensitive tools, gated behind confirmation by the policy layer.
import { CSP_BLOCKED_MARKER } from "../../shared/tool-failure";
import type { ToolContext } from "./types";
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

/**
 * True when a failed evaluation was refused by the PAGE's Content-Security-
 * Policy rather than by the expression itself. Chrome raises an `EvalError`
 * whose text names the `unsafe-eval` directive; the agent needs to tell this
 * apart from a plain JS error, because the fix is different (retry once with
 * `bypass_csp`, or stop trying to evaluate here at all).
 */
export function isCspBlocked(error: string): boolean {
  return (
    /unsafe-eval/i.test(error) ||
    /Content Security Policy/i.test(error) ||
    /EvalError/i.test(error)
  );
}

/**
 * Turn a raw CDP failure into something the model can act on. The bare CDP
 * message ("Evaluating a string as JavaScript violates…") reads like a dead
 * end — which is exactly how runs ended up looping on it — so the CSP case
 * gets the one retry that actually works spelled out.
 */
export function describeEvalFailure(error: string): string {
  if (!isCspBlocked(error)) return error;
  return [
    `${CSP_BLOCKED_MARKER}: this page's Content-Security-Policy forbids evaluating JavaScript (no 'unsafe-eval'), so this expression could not run.`,
    error,
    "Do NOT retry the same expression. Options, in order: (1) retry once with bypass_csp:true — that lifts this site's CSP for the tab; (2) use read_page / snapshot / click / type with element refs instead of JavaScript, which is unaffected by CSP; (3) if neither works, report the page as unreadable by script and stop.",
  ].join("\n");
}

/** Shape a CDP `Runtime.evaluate` response into the tool's JSON result. */
export function shapeEvalResult(res: EvaluateResponse): EvalOutcome {
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    const raw = String(d.exception?.description ?? d.text ?? "evaluation failed").slice(0, 1_000);
    return { ok: false, error: describeEvalFailure(raw) };
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

/**
 * Evaluate through an adapter, preferring the path that enables `Runtime`
 * first: `Runtime.evaluate` only honours `allowUnsafeEvalBlockedByCSP` once
 * the domain is enabled, and without that a page with a strict CSP (Google
 * Docs, most school portals) refuses every expression — the failure this tool
 * used to report as an unusable CDP error.
 *
 * `frameId` addresses an iframe's execution context when the adapter can
 * resolve one (enabling Runtime is what populates its context table). The main
 * frame — and any frame we cannot resolve — evaluates in the tab's default
 * context.
 */
async function evaluateVia<T extends EvaluateResponse>(
  adapter: ToolContext["adapter"],
  tabId: number,
  params: Record<string, unknown>,
  frameId?: number,
): Promise<T> {
  const evaluate = (extra: Record<string, unknown>) =>
    adapter.sendEnabled
      ? adapter.sendEnabled<T>(tabId, "Runtime", "Runtime.evaluate", extra)
      : adapter.send<T>(tabId, "Runtime.evaluate", extra);
  if (!frameId) return evaluate(params);
  if (adapter.sendEnabled && adapter.contextIdForFrame?.(tabId, frameId) == null) {
    // Enabling Runtime is what makes the browser announce frame contexts.
    await adapter
      .sendEnabled<T>(tabId, "Runtime", "Runtime.enable", {})
      .catch(() => null);
  }
  const contextId = adapter.contextIdForFrame?.(tabId, frameId);
  if (contextId === null || contextId === undefined) {
    throw new Error(
      `no execution context for frame ${frameId} — the frame may have navigated or still be loading; take a fresh snapshot to see the current frames`,
    );
  }
  return evaluate({ ...params, contextId });
}

registerTool({
  name: "evaluate_js",
  description:
    "Evaluate a JavaScript expression in a page's main world via the DevTools protocol and return the JSON-stringified result (promises are awaited). Works on most sites, including ones with a strict Content-Security-Policy. Runs in the top document by default; pass `frame` to run it inside an iframe instead (the frame ids and URLs are listed under 'Frames:' in every snapshot). Note this reads the DOM — it cannot read content drawn into a <canvas> (e.g. the Google Docs editor), where no tool except screenshot can see anything. If it ever comes back CSP-BLOCKED, retry ONCE with bypass_csp:true rather than repeating the same call, or switch to read_page / snapshot and the ref-based action tools, which are never affected by CSP.",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "JavaScript expression to evaluate" },
      frame: {
        type: "number",
        description:
          "CDP frame id to evaluate in (0 or omitted = top document). Frame ids appear in the snapshot's 'Frames:' list — use it to read inside an iframe.",
      },
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
    const frameId = typeof args.frame === "number" ? args.frame : undefined;
    const res = await Promise.race([
      evaluateVia<EvaluateResponse>(
        ctx.adapter,
        ctx.tabId,
        {
          expression: String(args.expression),
          awaitPromise: true,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: true,
        },
        frameId,
      ),
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
