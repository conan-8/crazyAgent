// Sensitive tools, gated behind confirmation by the policy layer.
import { CSP_BLOCKED_MARKER, failureTag } from "../../shared/tool-failure";
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
 * True when the failure is a Trusted-Types refusal: the page (Google
 * Docs/Sheets/Slides, other modern Google apps) enforces `require-trusted-
 * types-for 'script'`, so every HTML-string sink throws — "This document
 * requires 'TrustedHTML' assignment". A real run hit this four times with
 * DOMParser/innerHTML variants, each a full round trip, because the raw
 * TypeError reads like a coding mistake to fix rather than a policy that
 * never bends. The advice names the routes that DO work.
 */
export function isTrustedTypesBlocked(error: string): boolean {
  return (
    /requires 'Trusted/i.test(error) ||
    /TrustedHTML|TrustedScript|TrustedScriptURL/i.test(error) ||
    /Trusted Types/i.test(error)
  );
}

export const TRUSTED_TYPES_ADVICE = [
  "This page enforces Trusted Types: assigning or parsing HTML strings (innerHTML =, outerHTML =, DOMParser.parseFromString, insertAdjacentHTML, document.write) THROWS here — it is the page's security policy, not a mistake in the expression, and every variant of the same assignment fails identically. Do NOT retry it.",
  "To READ the document: use `docs_read` — it fetches the document's text/HTML outside the page (no in-page JS, immune to this policy). For one element's content: textContent / innerText / querySelector + JSON.stringify are unaffected. For structure checks on Google Docs, `docs_state` reports the applied formatting directly.",
].join("\n");

/**
 * Turn a raw CDP failure into something the model can act on. The bare CDP
 * message ("Evaluating a string as JavaScript violates…") reads like a dead
 * end — which is exactly how runs ended up looping on it — so the CSP case
 * gets the one retry that actually works spelled out, and the Trusted-Types
 * case gets the routes that bypass the policy entirely.
 */
export function describeEvalFailure(error: string): string {
  if (isTrustedTypesBlocked(error)) {
    return [`TRUSTED-TYPES-BLOCKED: ${error}`, TRUSTED_TYPES_ADVICE].join("\n");
  }
  if (!isCspBlocked(error)) return error;
  return [
    `${CSP_BLOCKED_MARKER}: this page's Content-Security-Policy forbids evaluating JavaScript (no 'unsafe-eval'), so this expression could not run.`,
    error,
    "Do NOT retry the same expression. Options, in order: (1) retry once with bypass_csp:true — that lifts this site's CSP for the tab; (2) use read_page / snapshot / click / type with element refs instead of JavaScript, which is unaffected by CSP; (3) if neither works, report the page as unreadable by script and stop.",
  ].join("\n");
}

/**
 * HTML-string sinks Trusted Types blocks — ASSIGNMENTS and parsers only.
 * Reading `.innerHTML` is legal on those pages and must not be screened out.
 */
const TRUSTED_TYPES_SINK_RE =
  /\b(?:innerHTML|outerHTML)\s*=[^=]|\bDOMParser\b|insertAdjacentHTML\s*\(|document\.write\s*\(|createContextualFragment/;

/** Hosts known to enforce Trusted Types (the Workspace editors). */
const TRUSTED_TYPES_HOST_RE = /^https:\/\/(?:docs|sheets|slides)\.google\.com\//;

/**
 * Pre-screen for the certain-refusal case: a blocked sink in the expression
 * AND a known Trusted-Types host. Saves the debugger round trip and lands the
 * advice BEFORE the model has seen a raw TypeError; the post-hoc rewrite in
 * describeEvalFailure still catches every other host and any pattern this
 * regex misses. Best-effort: an unreadable tab URL never blocks the call.
 */
export async function trustedTypesRefusal(
  tabId: number,
  expression: string,
): Promise<string | null> {
  if (!TRUSTED_TYPES_SINK_RE.test(expression)) return null;
  let url = "";
  try {
    url = (await chrome.tabs.get(tabId)).url ?? "";
  } catch {
    return null;
  }
  if (!TRUSTED_TYPES_HOST_RE.test(url)) return null;
  return `${failureTag("input")}: this expression assigns/parses HTML on a Trusted-Types page — it cannot run here.\n${TRUSTED_TYPES_ADVICE}`;
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
    // Strings pass through AS TEXT. JSON.stringify on a string result wraps
    // it in quotes and escapes every inner quote — and expressions commonly
    // return JSON.stringify(...), so the model received double-encoded soup
    // ("\"{\\\"value\\\":\\\"…&amp;…\\\"}\"") that wasted tokens and made a
    // literal "&" indistinguishable from an escaped one.
    if (typeof r.value === "string") return { ok: true, value: r.value.slice(0, 4_000) };
    return { ok: true, value: JSON.stringify(r.value ?? null).slice(0, 4_000) };
  }
  if (r.type === "undefined") return { ok: true, value: "null" };
  // Functions, symbols etc. don't serialize by value — fall back to their description.
  const described = r.description ?? r.type;
  return {
    ok: true,
    value: (typeof described === "string" ? described : JSON.stringify(described)).slice(0, 4_000),
  };
}

const EVAL_TIMEOUT_MS = 30_000;

/**
 * Evaluate through an adapter, preferring the path that enables `Runtime`
 * first: `Runtime.evaluate` only honours `allowUnsafeEvalBlockedByCSP` once
 * the domain is enabled, and without that a page with a strict CSP (Google
 * Docs, most school portals) refuses every expression — the failure this tool
 * used to report as an unusable CDP error.
 *
 * `frameId` addresses an iframe's execution context. Resolving it takes the
 * adapter's frame map (URL pairing) and, when that has gone stale, the
 * DOM-stamp join that survives navigations — both need `Runtime.enable` to
 * have announced the frame contexts, so enabling happens BEFORE resolution.
 * A frame that still cannot be resolved fails loudly with next steps; it never
 * silently evaluates in the wrong document.
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
  if (adapter.sendEnabled) {
    await adapter
      .sendEnabled<T>(tabId, "Runtime", "Runtime.enable", {})
      .catch(() => null);
  }
  const contextId = await adapter.contextIdForFrame?.(tabId, frameId);
  if (contextId === null || contextId === undefined) {
    throw new Error(
      `no execution context for frame ${frameId} — the frame map was refreshed and the frame still cannot be addressed (it may have navigated, been replaced, or have no document). Call \`frames\` once and retry with an id it reports; \`read_page\` / \`snapshot\` go through the content script and keep working on frames evaluate_js cannot reach`,
    );
  }
  return evaluate({ ...params, contextId });
}

registerTool({
  name: "evaluate_js",
  description:
    "Evaluate a JavaScript expression in a page's main world via the DevTools protocol and return the result as text (strings come back verbatim; other values JSON-stringified; promises are awaited). Works on most sites, including ones with a strict Content-Security-Policy. Runs in the top document by default; pass `frame` to run it inside an iframe instead (the frame ids and URLs are listed under 'Frames:' in every snapshot). Note this reads the DOM — it cannot read content drawn into a <canvas> (e.g. the Google Docs editor), where no tool except screenshot can see anything. If it ever comes back CSP-BLOCKED, retry ONCE with bypass_csp:true rather than repeating the same call, or switch to read_page / snapshot and the ref-based action tools, which are never affected by CSP.",
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
    const expression = String(args.expression);
    // Trusted-Types pre-screen: a blocked sink on a known enforcing host is a
    // certain refusal — answer with the working routes instead of spending a
    // debugger round trip on a guaranteed TypeError (see trustedTypesRefusal).
    const refusal = await trustedTypesRefusal(ctx.tabId, expression);
    if (refusal) return { ok: false, error: refusal };
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
          expression,
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
