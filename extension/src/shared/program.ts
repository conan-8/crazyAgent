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
import { failureTag } from "./tool-failure";

/**
 * The tools a program may drive. Deliberately a small vocabulary: each entry
 * is either a deterministic primitive (docs_op, menu_path) or a cheap way to
 * place input/see state. `run_program` itself is absent — programs do not nest.
 */
export const PROGRAM_TOOLS = [
  "docs_op",
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
 * The longest run of consecutive steps allowed WITHOUT an `expect` (so an
 * expect is needed at least every third step). Verification is what lets the
 * executor advance WITHOUT the model, so a program that never promises
 * anything is just a batched tool call with extra steps.
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
    const args =
      o.args && typeof o.args === "object" && !Array.isArray(o.args)
        ? (o.args as Record<string, unknown>)
        : o.args === undefined
          ? {}
          : null;
    if (args === null) {
      return { ok: false, error: `${failureTag("input")}: steps[${i}].args must be an object` };
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
  const run = longestUnverifiedRun(steps);
  if (run > PROGRAM_MAX_UNVERIFIED_RUN) {
    return {
      ok: false,
      error:
        `${failureTag("input")}: ${run} steps in a row have no expect — never more than ${PROGRAM_MAX_UNVERIFIED_RUN} ` +
        "(and the LAST step always needs one), because the harness advances without the model only where it can check the result",
    };
  }
  if (!steps[steps.length - 1]!.expect) {
    return {
      ok: false,
      error:
        `${failureTag("input")}: the LAST step needs an expect — it is how the harness knows the program landed. ` +
        'Add expect:{pixel_changed:true} to a mutating step, or end with {tool:"assert", args:{}, expect:{…}}',
    };
  }
  let note: string | undefined;
  if (typeof rawNote === "string" && rawNote.trim()) {
    note = rawNote.trim().slice(0, PROGRAM_NOTE_MAX_CHARS);
  } else if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") {
    return { ok: false, error: `${failureTag("input")}: note must be a string` };
  }
  return { ok: true, program: { steps, note } };
}

/** The longest run of consecutive steps that promise nothing. */
export function longestUnverifiedRun(steps: ProgramStep[]): number {
  let longest = 0;
  let run = 0;
  for (const step of steps) {
    run = step.expect ? 0 : run + 1;
    if (run > longest) longest = run;
  }
  return longest;
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