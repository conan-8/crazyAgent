// Tool-failure classification.
//
// A real run reported tool failures as the bare string "fetch failed" — a
// thrown `TypeError`'s message, with nothing saying WHICH layer failed. The
// model could not tell a dead tab from a CSP refusal from a worker problem, so
// it retried the same call until it gave up. Every failure now names its layer
// and (where we have one) the next move.
//
// Pure: takes an unknown thrown value or a tool's own error string, returns
// something worth showing a model. Unit-tested in tests/tool-failure.test.ts.

/** Which layer a tool failure came from. */
export type FailureLayer =
  | "transport" // the debugger/daemon connection to the tab
  | "injection" // the content script could not run in the page
  | "csp" // the page refused script evaluation
  | "frame" // a frame could not be addressed
  | "input" // the model's arguments were wrong
  | "tool" // the tool itself refused (its own {ok:false,error})
  | "unknown";

export interface ToolFailure {
  layer: FailureLayer;
  /** The original message, always preserved. */
  detail: string;
  /** The message a caller shows the model: layered, with a next move. */
  message: string;
}

const KNOWN_LAYERS: FailureLayer[] = [
  "transport",
  "injection",
  "csp",
  "frame",
  "input",
  "tool",
];

/**
 * Marker `evaluate_js` uses for its own CSP refusals. It carries more specific
 * guidance than the generic classifier (which expression to retry, with which
 * argument), so a message already carrying it is never re-wrapped.
 */
export const CSP_BLOCKED_MARKER = "CSP-BLOCKED";

/**
 * Stable, greppable prefix so a driver script (and the user reading a run log)
 * can tell at a glance which layer failed.
 */
export function failureTag(layer: FailureLayer): string {
  return `${layer.toUpperCase()}-FAILED`;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    // `String(err)` on an Error gives "Error: msg" — prefer the bare message.
    return err.message || err.name || "error";
  }
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; reason?: unknown };
    if (typeof e.message === "string") return e.message;
    if (typeof e.reason === "string") return e.reason;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err ?? "unknown error");
}

/**
 * Append guidance, unless the original message already says it. Chrome's own
 * stale-ref error ends with "take a fresh snapshot", and repeating that made
 * the advice read as noise ("… take a fresh snapshot — take a fresh snapshot
 * (or call frames) …").
 */
function withAdvice(layer: FailureLayer, detail: string, advice: string): string {
  const tag = failureTag(layer);
  if (detail.includes(tag)) return detail;
  const adviceText = advice.toLowerCase();
  // Phrases the tool already supplied; only add what is missing.
  const already = ["take a fresh snapshot", "fresh snapshot", "bypass_csp", "retry"].filter((p) =>
    detail.toLowerCase().includes(p) && adviceText.includes(p),
  );
  if (already.length && already.length >= 2) return `${tag}: ${detail}`;
  return `${tag}: ${detail} — ${advice}`;
}

/**
 * Classify by the message the browser actually gave us. Order matters: the
 * most specific, actionable signatures are tested first (a Chrome error can
 * name both a transport and an injection problem).
 */
export function classifyFailure(input: unknown): ToolFailure {
  const detail = messageOf(input);
  const text = detail.toLowerCase();

  // --- the model's own arguments -------------------------------------------
  if (/missing required parameter|must be a (number|string|boolean)/.test(text)) {
    return {
      layer: "input",
      detail,
      message: withAdvice("input", detail, "fix the arguments and call again."),
    };
  }

  // --- page refused evaluation --------------------------------------------
  if (/unsafe-eval|content security policy|evalerror/.test(text)) {
    return {
      layer: "csp",
      detail,
      message: withAdvice(
        "csp",
        detail,
        "retry ONCE with bypass_csp, or use read_page / snapshot / ref-based actions, which CSP does not affect.",
      ),
    };
  }

  // --- a frame could not be addressed -------------------------------------
  if (/no execution context for frame|stale or unknown ref|take a fresh snapshot/.test(text)) {
    return {
      layer: "frame",
      detail,
      message: withAdvice(
        "frame",
        detail,
        "get the current frame ids and refs with snapshot or frames, then retry with those.",
      ),
    };
  }

  // --- the content script is not there ------------------------------------
  if (
    /receiving end does not exist|could not establish connection|no content script|registry-not-loaded|actions-not-loaded|extension context invalidated/.test(
      text,
    )
  ) {
    return {
      layer: "injection",
      detail,
      message: withAdvice(
        "injection",
        detail,
        "the content script is not running in that page (a chrome:// page, the PDF viewer, a page still loading, or a frame the script cannot enter). Navigate to a normal http(s) page, wait for load, or report the page as unreadable. Do not retry the same call.",
      ),
    };
  }

  // --- the debugger/daemon connection -------------------------------------
  // `fetch failed` is a generic TypeError from a rejected fetch; in this worker
  // it is what a broken devtools/native-messaging hop looks like.
  if (
    /another debugger is already attached|debugger is not attached|not attached to the tab|target closed|no cdp target|helper daemon|native messaging|cdp timeout|inspection failed|devtools/i.test(
      text,
    ) ||
    /^fetch failed$|networkerror|failed to fetch|err_connection/.test(text)
  ) {
    return {
      layer: "transport",
      detail,
      message: withAdvice(
        "transport",
        detail,
        "the connection to the tab's debugger failed, so this is a transport problem, not a problem with the page. Do NOT retry the same call repeatedly: reload the tab (or switch away and back), then try a plain read_page to confirm the link is back. If it keeps failing, report it.",
      ),
    };
  }

  if (/^tool failed$|^no result$|^unknown tool/.test(text)) {
    return { layer: "tool", detail, message: `${failureTag("tool")}: ${detail}` };
  }

  return {
    layer: "unknown",
    detail,
    message: `${failureTag("unknown")}: ${detail}`,
  };
}

/** True when a message already carries one of our layer tags. */
export function isClassified(message: string): boolean {
  return (
    message.includes(CSP_BLOCKED_MARKER) ||
    KNOWN_LAYERS.some((layer) => message.includes(failureTag(layer)))
  );
}

/**
 * Message for a tool result. Tools that already produced a classified message
 * (evaluate_js tags CSP refusals itself) are passed through untouched so the
 * specific guidance is never replaced by the generic one.
 */
export function describeToolFailure(input: unknown): string {
  const detail = messageOf(input);
  if (isClassified(detail)) return detail;
  return classifyFailure(input).message;
}