// Pure half of the `wait_for` tool: argument shaping and condition
// evaluation. Kept free of Chrome APIs so the semantics are unit-testable —
// the polling loop in tools/perception.ts only supplies observations.
//
// Why this tool exists: a real relay run burned 23 turns × ~12s of round
// trip polling a chat page whose streamed reply was still growing — each
// poll is a full LLM step that learns only "not done yet". One blocking
// call that resolves when the condition holds moves that wait off the
// model's critical path entirely.

/** How long between condition polls (the page read itself is ~ms). */
export const WAIT_POLL_MS = 1_000;
/** Default and ceiling for `timeout_ms`. A timeout is a RESULT, never an error. */
export const WAIT_DEFAULT_TIMEOUT_MS = 60_000;
export const WAIT_MAX_TIMEOUT_MS = 300_000;
/** Cap on the page text compared per poll — stability, not full digestion. */
export const WAIT_TEXT_MAX_CHARS = 40_000;

/** One shaped wait condition. All provided predicates must hold (AND). */
export interface WaitCondition {
  /** Literal substring to wait for. */
  text?: string;
  /** `text` written as /regex/ with optional flags. */
  textRegex?: { source: string; flags: string };
  /** Wait until this substring is ABSENT (was present or not — either way). */
  textGone?: string;
  /** CSS selector that must appear. */
  selector?: string;
  /** CSS selector that must be gone. */
  selectorGone?: string;
  /** Also require the observed text to have been unchanged for this long. */
  stableForMs?: number;
  /** Scripting frame id (from the snapshot's Frames: list); default: all frames. */
  frame?: number;
  timeoutMs: number;
}

/** What one poll of the page saw. */
export interface WaitObservation {
  text: string;
  /** Selector presence; null when no selector was asked for or it is invalid. */
  selectorPresent: boolean | null;
}

export type WaitSpec = { error: string } | { cond: WaitCondition };

/** `/pattern/flags` → matcher; anything else stays a literal substring. */
export function compileWaitText(
  text: string,
): { regex?: RegExp; literal?: string } | { error: string } {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(text);
  if (!m) return { literal: text };
  try {
    return { regex: new RegExp(m[1]!, m[2]) };
  } catch {
    return { error: `text is shaped like /regex/ but does not compile: ${text.slice(0, 120)}` };
  }
}

export function parseWaitArgs(args: Record<string, unknown>): WaitSpec {
  const cond: WaitCondition = {
    timeoutMs: WAIT_DEFAULT_TIMEOUT_MS,
  };
  if (typeof args.text === "string" && args.text.length) {
    const compiled = compileWaitText(args.text);
    if ("error" in compiled) return { error: compiled.error };
    if (compiled.literal !== undefined) cond.text = compiled.literal;
    else cond.textRegex = { source: compiled.regex!.source, flags: compiled.regex!.flags };
  }
  // Snake-case tool args → camelCase condition fields.
  const stringKeys = {
    text_gone: "textGone",
    selector: "selector",
    selector_gone: "selectorGone",
  } as const;
  for (const [arg, field] of Object.entries(stringKeys)) {
    const v = args[arg];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.length) {
      return { error: `${arg} must be a non-empty string` };
    }
    cond[field] = v;
  }
  if (typeof args.frame === "number" && Number.isFinite(args.frame)) {
    cond.frame = args.frame;
  }
  for (const key of ["stable_for_ms", "timeout_ms"] as const) {
    const v = args[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { error: `${key} must be a non-negative number` };
    }
    if (key === "stable_for_ms") cond.stableForMs = v;
    else cond.timeoutMs = Math.min(Math.max(v, 0), WAIT_MAX_TIMEOUT_MS);
  }
  if (cond.text === undefined && cond.textRegex === undefined && cond.textGone === undefined &&
    cond.selector === undefined && cond.selectorGone === undefined && cond.stableForMs === undefined) {
    return {
      error:
        "wait_for needs at least one condition: text, text_gone, selector, selector_gone, or stable_for_ms",
    };
  }
  return { cond };
}

export interface WaitEval {
  /** All predicates hold on this observation. */
  ok: boolean;
  /** ±120 chars around the first text match, when there was one. */
  excerpt?: string;
  /** Names of predicates that did not hold (for the timeout report). */
  unmet: string[];
}

function findText(cond: WaitCondition, text: string): { found: boolean; at: number; length: number } {
  if (cond.textRegex) {
    const re = new RegExp(cond.textRegex.source, cond.textRegex.flags);
    const m = re.exec(text);
    return m ? { found: true, at: m.index, length: Math.max(m[0].length, 1) } : { found: false, at: 0, length: 0 };
  }
  const needle = cond.text ?? "";
  const at = text.indexOf(needle);
  return at >= 0 ? { found: true, at, length: needle.length } : { found: false, at: 0, length: 0 };
}

/**
 * Evaluate the condition against one observation. `stableMs` is how long the
 * observed text has been unchanged; `stableForMs` participates here so the
 AND-semantics live in exactly one place.
 */
export function evalWaitCondition(
  cond: WaitCondition,
  obs: WaitObservation,
  stableMs = Number.POSITIVE_INFINITY,
): WaitEval {
  const unmet: string[] = [];
  let hit: { found: boolean; at: number; length: number } | undefined;
  if (cond.text !== undefined || cond.textRegex !== undefined) {
    hit = findText(cond, obs.text);
    if (!hit.found) unmet.push("text");
  }
  if (cond.textGone !== undefined && obs.text.includes(cond.textGone)) {
    unmet.push("text_gone");
  }
  if (cond.selector !== undefined) {
    if (obs.selectorPresent !== true) unmet.push("selector");
  }
  if (cond.selectorGone !== undefined) {
    if (obs.selectorPresent === true) unmet.push("selector_gone");
    // null (invalid/unevaluable) counts as gone: querySelector would throw.
  }
  if (cond.stableForMs !== undefined && stableMs < cond.stableForMs) {
    unmet.push(`stable_for_ms (${Math.round(stableMs)}/${cond.stableForMs}ms)`);
  }
  const ok = unmet.length === 0;
  let excerpt: string | undefined;
  if (hit?.found) {
    const from = Math.max(0, hit.at - 120);
    excerpt = obs.text.slice(from, Math.min(obs.text.length, hit.at + hit.length + 240)).trim();
  }
  return { ok, excerpt, unmet };
}
