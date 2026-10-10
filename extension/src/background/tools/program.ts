// The program executor — plan-as-data, run by the harness.
//
// One `run_program` call becomes N tool calls that never touch the model: each
// step is executed through the SAME gated path a direct call takes (policy
// gate, settle, observation, effect verdict, expectation check), and the
// executor stops at the first step whose promise does not hold. That stop is
// the whole point: the model is consulted at DIVERGENCE, not at every action
// (docs/LOOP-PLAN.md §2). It also means a program cannot do anything a single
// tool call could not — the gate sees every step.
//
// The pure half (vocabulary, caps, validation) is shared/program.ts.
import {
  describeStep,
  parseProgram,
  PROGRAM_MAX_STEPS,
  PROGRAM_MAX_UNVERIFIED_RUN,
  PROGRAM_TOOLS,
  type Program,
  type ProgramStep,
} from "../../shared/program";
import { failureTag } from "../../shared/tool-failure";
import type { ExecuteResult } from "../agent/loop";
import { registerTool, toolRegistry, validateToolArgs, type ToolContext } from "./types";
import { EXPECT_PROP } from "../../shared/expect";

/** How one step is run. Injected by sw.ts so this module stays importable in tests. */
export type ProgramStepRunner = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ExecuteResult>;

let runStep: ProgramStepRunner | null = null;

/** Wire the gated executor (sw.ts) — the same path a direct tool call takes. */
export function setProgramStepRunner(runner: ProgramStepRunner | null): void {
  runStep = runner;
}

/** What one step did, as the executor saw it. */
interface StepOutcome {
  index: number;
  step: ProgramStep;
  ok: boolean;
  /** True when the step's declared promise did not hold (or could not be checked). */
  diverged: boolean;
  line: string;
  image?: string;
}

/** One compact line for the result: what ran, and what the harness saw. */
function outcomeLine(index: number, step: ProgramStep, res: ExecuteResult): string {
  const where = `${index + 1}. ${describeStep(step)}`;
  if (!res.ok) return `${where} — FAILED: ${String(res.error ?? "the tool failed").slice(0, 220)}`;
  const check = res.verify;
  if (check?.expect === "verified") return `${where} — verified: ${check.expectDetail ?? "the promise held"}`;
  if (check?.expect === "failed") return `${where} — NOT VERIFIED: ${check.expectDetail ?? "the promise did not hold"}`;
  if (check?.expect === "unverified") return `${where} — ran, but the check was inconclusive: ${check.expectDetail ?? "not checkable"}`;
  if (check?.effect === "unchanged") return `${where} — ran, no visible change`;
  if (check?.effect === "changed") return `${where} — ran, the page changed`;
  return `${where} — ran`;
}

/** Steps run without the model; the report keeps them all legible. */
function report(program: Program, outcomes: StepOutcome[], stoppedAt?: number): string {
  const header =
    stoppedAt === undefined
      ? `program complete: ${program.steps.length} step(s), every promise held`
      : `program STOPPED at step ${stoppedAt + 1} of ${program.steps.length} — steps after it did NOT run`;
  const body = outcomes.map((o) => o.line).join("\n");
  // Named so the model learns to write its own expects instead of leaning on
  // the assumed one: pixel_changed only proves that SOMETHING moved.
  const assumed = program.assumedExpects?.length
    ? `\n[harness] step(s) ${program.assumedExpects.map((i) => i + 1).join(", ")} carried no expect — assumed pixel_changed, which only proves something moved. Where you know what should be true, say it: export_contains, text_landed, dialog, toolbar_style.`
    : "";
  return `${header}\n${body}${assumed}`;
}

/**
 * Run a validated program. Exported for tests (the tool below is the thin
 * registry wrapper); the runner is injected, so this is exercised without a
 * browser.
 */
export async function runProgramSteps(
  program: Program,
  ctx: Pick<ToolContext, "emit" | "stopping">,
): Promise<{ ok: boolean; text: string; image?: string; stoppedAt?: number }> {
  const outcomes: StepOutcome[] = [];
  let stoppedAt: number | undefined;
  let image: string | undefined;
  for (const [index, step] of program.steps.entries()) {
    if (ctx.stopping?.()) {
      outcomes.push({
        index,
        step,
        ok: false,
        diverged: true,
        line: `${index + 1}. ${describeStep(step)} — not run (the user stopped the run)`,
      });
      stoppedAt = index;
      break;
    }
    if (!runStep) {
      return {
        ok: false,
        text: `${failureTag("tool")}: the program executor is not wired (no step runner) — run the steps one at a time instead`,
      };
    }
    const args: Record<string, unknown> = { ...(step.args ?? {}) };
    if (step.expect) args.expect = step.expect;
    const res = await runStep(step.tool, args);
    const check = res.verify;
    const diverged = !res.ok || check?.expect === "failed";
    outcomes.push({
      index,
      step,
      ok: res.ok,
      diverged,
      line: outcomeLine(index, step, res),
      ...(res.image ? { image: res.image } : {}),
    });
    if (diverged) {
      stoppedAt = index;
      image = res.image;
      break;
    }
  }
  // The closing note rides the progress channel only when the program actually
  // landed: a note that claims completion for a stopped program is worse than
  // no note at all.
  if (program.note && stoppedAt === undefined) {
    ctx.emit({ kind: "progress_note", text: program.note });
  }
  const text = report(program, outcomes, stoppedAt);
  return {
    ok: stoppedAt === undefined,
    text: program.note && stoppedAt === undefined ? `${text}\n[progress noted]` : text,
    ...(image ? { image } : {}),
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
  };
}

registerTool({
  name: "run_program",
  description:
    `Run a SEQUENCE of tool steps in one call — the harness executes them back to back (settling and reading the page after each), so you spend one turn on a whole checklist item instead of one per action. Use it whenever you already know the route: fill the Page setup dialog, insert + verify a table, apply a style and type a value, walk a menu and check the result. Each step is {tool, args?, expect?}: tool is one of ${PROGRAM_TOOLS.join(", ")}; expect declares what that step must achieve (export_contains, toolbar_style, dialog, text_landed, pixel_changed) and is checked by the harness right after the step. 2-${PROGRAM_MAX_STEPS} steps. Put an expect wherever you know what should be true (export_contains, text_landed, dialog, toolbar_style, pixel_changed:true for "the page moved"); a step with none is given an assumed pixel_changed and the report names it, so write your own when you can. Each step's arguments go INSIDE args — {tool:'key', args:{key:'Enter'}}. PREFER THIS over one action per turn: it costs one round trip, one page observation and one policy check instead of N of each. The report lists every step and where it stopped; if a step diverges the program STOPS there — fix that step and send the rest as a new program. Optional note: one or two sentences for the user, shown when the whole program lands.`, 
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description:
          "The sequence, in order. Each: {tool, args?, expect?} — e.g. [{tool:'docs_op', args:{op:'insert_table',rows:3,cols:4}, expect:{export_contains:'<table'}}, {tool:'assert', args:{}, expect:{toolbar_style:'Normal text'}}]",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", description: "One of the program vocabulary tools" },
            args: { type: "object", description: "That tool's own arguments (same schema as calling it directly)" },
            expect: EXPECT_PROP.expect,
          },
          required: ["tool"],
        },
      },
      note: {
        type: "string",
        description:
          "Optional: 'Progress: <what just landed>. Next: <what's next>.' shown to the user when the program completes (≤400 chars)",
      },
    },
    required: ["steps"],
  },
  async run(args, ctx) {
    const parsed = parseProgram(args.steps, args.note, (tool, stepArgs) => {
      const spec = toolRegistry.get(tool);
      if (!spec) return `unknown tool "${tool}"`;
      return validateToolArgs(spec, stepArgs).error;
    });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const out = await runProgramSteps(parsed.program, ctx);
    if (!out.ok) {
      return {
        ok: false,
        error: `${failureTag("tool")}: ${out.text}`,
        ...(out.image ? { image: out.image } : {}),
      };
    }
    return { ok: true, steps: parsed.program.steps.length, text: out.text };
  },
  present(payload) {
    const p = (payload ?? {}) as { text?: string; error?: string };
    return { text: p.error ?? p.text ?? "program complete" };
  },
});

registerTool({
  name: "assert",
  description:
    "Check a promise about the CURRENT page without acting on it — a program's closing verification step, or a standalone 'is it actually there?' check. Its expect is evaluated exactly like an action's (export_contains, toolbar_style, dialog, text_landed): the result says verified: or NOT VERIFIED: with what was found. Note: pixel_changed compares the page to the previous observation, so it belongs on the step that CHANGED the page, not on an assert after it.",
  parameters: {
    type: "object",
    properties: { ...EXPECT_PROP },
    required: ["expect"],
  },
  async run(args) {
    if (!args.expect || typeof args.expect !== "object" || !Object.keys(args.expect).length) {
      return {
        ok: false,
        error: `${failureTag("input")}: assert needs an expect object naming what must be true (export_contains, toolbar_style, dialog, text_landed)`,
      };
    }
    return { ok: true, asserted: true };
  },
  present() {
    return { text: "checked the promise (see the verification line)" };
  },
});