// Programs — plan-as-data. The loop's unit of work was one UI action per model
// round trip, and the 2026-10-06 field runs priced that: 65-74 % of wall clock
// was the model deciding single actions and 24-49 % of turns produced no
// document progress (docs/LOOP-PLAN.md §0). A program is the fix at the
// source: the model compiles ONE checklist item into a sequence of typed
// steps, the harness runs them back to back with per-step settle + effect
// verification, and the model is consulted only when a step diverges.
//
// This module is the PURE half: the step vocabulary, the caps that bound a bad
// program's blast radius, and validation that catches a malformed step BEFORE
// anything runs (the same class of schema error that cost one archived run four
// turns on the identical input_sequence mistake). Execution lives in
// background/tools/program.ts.
import { parseExpect, type StepExpect } from "./expect";
import { isMutating } from "./modes";
import { failureTag } from "./tool-failure";

/**
 * The tools a program may drive. Deliberately a small vocabulary: each entry
 * is either a deterministic primitive (docs_op, menu_path) or a cheap way to
 * place input/see state. `run_program` itself is absent — programs do not nest.
 */
export const PROGRAM_TOOLS = [
  "docs_op",
  "docs_table",
  "menu_path",
  "click",
  "click_at",
  "hover_at",
  "key",
  "type",
  "type_at",
  "docs_locate",
  "docs_read",
  "docs_state",
  "scroll",
  "wait_for",
  "screenshot",
  "assert",
] as const;
export type ProgramTool = (typeof PROGRAM_TOOLS)[number];

/**
 * Hard cap on steps. A bad program's cost is bounded by this: the executor
 * stops at the first divergence, so 12 is the most it can lose on one
 * round trip — still far cheaper than 12 model turns.
 */
export const PROGRAM_MAX_STEPS = 12;
/**
 * How many consecutive MUTATING steps may carry no expect of their own before
 * the harness attaches its weakest one (`pixel_changed`) — see assumeExpects.
 * Verification is what lets the executor advance WITHOUT the model, so a
 * program that promises nothing is given a promise rather than refused:
 * refusing an 8-step batch just sends the model back to eight round trips.
 */
export const PROGRAM_MAX_UNVERIFIED_RUN = 2;
/** The closing note rides the progress-note event; same cap as that tool. */
export const PROGRAM_NOTE_MAX_CHARS = 400;

export interface ProgramStep {
  tool: ProgramTool;
  args?: Record<string, unknown>;
  /** What this step promises; checked by the harness right after it settles. */
  expect?: StepExpect;
}

export interface Program {
  steps: ProgramStep[];
  /** One or two sentences for the user, emitted when the program completes. */
  note?: string;
  /** 0-based indexes of the steps the harness gave an ASSUMED expect (see
   *  assumeExpects) — reported back so the model learns to write its own. */
  assumedExpects?: number[];
}

/** Argument validation, injected so this module stays pure (no tool registry). */
export type ValidateStepArgs = (tool: string, args: Record<string, unknown>) => string | undefined;

export type ProgramParse =
  | { ok: true; program: Program }
  | { ok: false; error: string };

/**
 * Validate a whole program: the vocabulary, the caps, each step's arguments
 * (through the tool's own JSON schema) and each step's expectation. Every
 * failure is reported before execution, so a malformed program costs one turn
 * instead of a half-executed sequence.
 */
export function parseProgram(
  rawSteps: unknown,
  rawNote: unknown,
  validateArgs: ValidateStepArgs,
): ProgramParse {
  if (!Array.isArray(rawSteps)) {
    return {
      ok: false,
      error: `${failureTag("input")}: steps must be an array of {tool, args?, expect?} (2-${PROGRAM_MAX_STEPS} entries)`,
    };
  }
  if (!rawSteps.length) {
    return { ok: false, error: `${failureTag("input")}: a program needs at least one step` };
  }
  if (rawSteps.length > PROGRAM_MAX_STEPS) {
    return {
      ok: false,
      error: `${failureTag("input")}: ${rawSteps.length} steps is over the ${PROGRAM_MAX_STEPS}-step program cap — split it into two programs (each is one round trip)`,
    };
  }
  const steps: ProgramStep[] = [];
  for (const [i, raw] of rawSteps.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `${failureTag("input")}: steps[${i}] must be an object {tool, args?, expect?}` };
    }
    const o = raw as Record<string, unknown>;
    const tool = String(o.tool ?? "");
    if (!(PROGRAM_TOOLS as readonly string[]).includes(tool)) {
      return {
        ok: false,
        error: `${failureTag("input")}: steps[${i}].tool "${tool}" is not in the program vocabulary — use one of: ${PROGRAM_TOOLS.join(", ")}`,
      };
    }
    const declared =
      o.args && typeof o.args === "object" && !Array.isArray(o.args)
        ? (o.args as Record<string, unknown>)
        : o.args === undefined
          ? {}
          : null;
    if (declared === null) {
      return { ok: false, error: `${failureTag("input")}: steps[${i}].args must be an object` };
    }
    // The model routinely hoists a step's arguments onto the step itself —
    // {tool:"key", key:"Enter"} instead of {tool:"key", args:{key:"Enter"}} —
    // which cost six of seven run_program calls in one archived run. Fold them
    // in rather than refusing a program that meant the right thing.
    const args: Record<string, unknown> = { ...declared };
    for (const [k, v] of Object.entries(o)) {
      if (k === "tool" || k === "args" || k === "expect" || k in args) continue;
      args[k] = v;
    }
    const parsedExpect = parseExpect(o.expect);
    if (!parsedExpect.ok) {
      return { ok: false, error: `${failureTag("input")}: steps[${i}] (${tool}): ${parsedExpect.error}` };
    }
    // Validate the EFFECTIVE arguments — the executor merges the step's expect
    // into them (that is how the gated path checks it), so a tool that requires
    // `expect` (assert) must not be rejected here for "missing" it.
    const argError = validateArgs(tool, {
      ...args,
      ...(parsedExpect.expect ? { expect: parsedExpect.expect } : {}),
    });
    if (argError) {
      return { ok: false, error: `${failureTag("input")}: steps[${i}] (${tool}): ${argError}` };
    }
    steps.push({
      tool: tool as ProgramTool,
      args,
      ...(parsedExpect.expect ? { expect: parsedExpect.expect } : {}),
    });
  }
  // A program that promised nothing used to be REFUSED here, which sent the
  // model back to one action per turn — the exact cost programs exist to
  // remove. Two of the four run_program failures in a 420-turn benchmark run
  // were that refusal, one of them on an 8-step batch. The harness now attaches
  // its weakest real check to the steps that need one and reports which it
  // assumed, so a step that changed nothing still fails — and the model still
  // learns to write its own expects.
  const assumedExpects = assumeExpects(steps, PROGRAM_MAX_UNVERIFIED_RUN);
  let note: string | undefined;
  if (typeof rawNote === "string" && rawNote.trim()) {
    note = rawNote.trim().slice(0, PROGRAM_NOTE_MAX_CHARS);
  } else if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") {
    return { ok: false, error: `${failureTag("input")}: note must be a string` };
  }
  return {
    ok: true,
    program: { steps, note, ...(assumedExpects.length ? { assumedExpects } : {}) },
  };
}

/**
 * Give the harness's weakest real check — `pixel_changed` — to the mutating
 * steps that would otherwise run unverified, and return their indexes.
 *
 * Read-only steps are skipped: a `docs_read` or `screenshot` cannot silently
 * fail to change anything, and its own output is the check. A mutating step
 * gets an assumed expect when it would end a run longer than `maxRun`, or when
 * it is the program's last step — so the program always ends on something the
 * harness can verify.
 */
export function assumeExpects(steps: ProgramStep[], maxRun: number): number[] {
  const assumed: number[] = [];
  let run = 0;
  for (const [i, step] of steps.entries()) {
    if (!isMutating(step.tool)) continue;
    if (step.expect) {
      run = 0;
      continue;
    }
    run += 1;
    if (run > maxRun || i === steps.length - 1) {
      step.expect = { pixel_changed: true };
      assumed.push(i);
      run = 0;
    }
  }
  return assumed;
}

/** One line naming a step, for the result and the run log. */
export function describeStep(step: ProgramStep): string {
  const args = step.args ?? {};
  const keys = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== "");
  const shown = keys
    .slice(0, 3)
    .map((k) => {
      const v = args[k];
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${text && text.length > 32 ? `${text.slice(0, 32)}…` : text}`;
    })
    .join(" ");
  return `${step.tool}${shown ? ` ${shown}` : ""}`;
}

/** Everything a program promises, in order — the run log's checklist. */
export function programExpectations(program: Program): string[] {
  return program.steps
    .map((s, i) => (s.expect ? `${i + 1}. ${s.tool}: ${Object.keys(s.expect).join(", ")}` : ""))
    .filter(Boolean);
}