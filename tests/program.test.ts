import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeStep,
  longestUnverifiedRun,
  PROGRAM_MAX_STEPS,
  PROGRAM_TOOLS,
  parseProgram,
  programExpectations,
  type ProgramStep,
} from "../extension/src/shared/program";
import {
  runProgramSteps,
  setProgramStepRunner,
} from "../extension/src/background/tools/program";
import type { ExecuteResult } from "../extension/src/background/agent/loop";

/** No argument validation for the pure tests (that is the injected half). */
const noArgs = () => undefined;

const step = (tool: string, args?: Record<string, unknown>, expect?: Record<string, unknown>) =>
  ({ tool, ...(args ? { args } : {}), ...(expect ? { expect } : {}) }) as unknown;

describe("parseProgram", () => {
  it("accepts a well-formed program and keeps args and expectations", () => {
    const out = parseProgram(
      [
        step("docs_op", { op: "insert_table", rows: 4, cols: 3 }, { export_contains: "<table" }),
        step("assert", {}, { toolbar_style: "Normal text" }),
      ],
      "Progress: table in. Next: the header colour.",
      noArgs,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.program.steps).toHaveLength(2);
      expect(out.program.steps[0]!.args).toEqual({ op: "insert_table", rows: 4, cols: 3 });
      expect(out.program.steps[0]!.expect).toEqual({ export_contains: "<table" });
      expect(out.program.note).toContain("table in");
    }
  });

  it("rejects a non-array, an empty program and one over the cap", () => {
    expect(parseProgram("nope", undefined, noArgs).ok).toBe(false);
    expect(parseProgram([], undefined, noArgs).ok).toBe(false);
    const tooMany = Array.from({ length: PROGRAM_MAX_STEPS + 1 }, () =>
      step("assert", {}, { text_landed: "x" }),
    );
    const out = parseProgram(tooMany, undefined, noArgs);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("over the");
  });

  it("rejects an unknown tool with the whole vocabulary (a typo costs one turn, not a run)", () => {
    const out = parseProgram([step("input_sequance", {}, { text_landed: "x" })], undefined, noArgs);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("steps[0].tool");
      for (const tool of PROGRAM_TOOLS) expect(out.error).toContain(tool);
    }
  });

  it("surfaces a step's own argument error WITH its index", () => {
    const out = parseProgram(
      [step("key", { key: "Enter" }, { pixel_changed: true }), step("docs_op", { op: "apply_style" }, { text_landed: "x" })],
      undefined,
      (tool, args) => (tool === "docs_op" && !args.style ? "docs_op needs a style" : undefined),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("steps[1] (docs_op)");
      expect(out.error).toContain("needs a style");
    }
  });

  it("rejects a malformed expect on a step", () => {
    const out = parseProgram([step("assert", {}, { pxiel_changed: true })], undefined, noArgs);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("unknown expect key");
  });

  it("demands an expect on the last step, and never two steps in a row without one", () => {
    const noLast = parseProgram(
      [step("type", { text: "hi" }, { pixel_changed: true }), step("key", { key: "Enter" })],
      undefined,
      noArgs,
    );
    expect(noLast.ok).toBe(false);
    if (!noLast.ok) expect(noLast.error).toContain("LAST step needs an expect");

    const gap = parseProgram(
      [
        step("type", { text: "hi" }, { pixel_changed: true }),
        step("key", { key: "Enter" }),
        step("key", { key: "Tab" }),
        step("key", { key: "Tab" }),
        step("assert", {}, { text_landed: "hi" }),
      ],
      undefined,
      noArgs,
    );
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.error).toContain("have no expect");
    // Two unverified steps in a row are allowed; three are not.
    const two = parseProgram(
      [
        step("type", { text: "hi" }, { pixel_changed: true }),
        step("key", { key: "Enter" }),
        step("key", { key: "Tab" }),
        step("assert", {}, { text_landed: "hi" }),
      ],
      undefined,
      noArgs,
    );
    expect(two.ok).toBe(true);
  });

  it("caps the note and rejects a non-string one", () => {
    const long = "x".repeat(900);
    const out = parseProgram([step("assert", {}, { text_landed: "x" })], long, noArgs);
    expect(out.ok && out.program.note!.length).toBe(400);
    expect(parseProgram([step("assert", {}, { text_landed: "x" })], 5, noArgs).ok).toBe(false);
  });

  it("measures the longest unverified run and lists the promises", () => {
    const steps = [
      { tool: "type", args: {}, expect: { pixel_changed: true } },
      { tool: "key", args: {} },
      { tool: "key", args: {} },
      { tool: "assert", args: {}, expect: { text_landed: "x" } },
    ] as unknown as ProgramStep[];
    expect(longestUnverifiedRun(steps)).toBe(2);
    expect(longestUnverifiedRun([{ tool: "key", args: {}, expect: { text_landed: "x" } }] as ProgramStep[])).toBe(0);
    const program = {
      steps: [
        { tool: "type", args: {}, expect: { pixel_changed: true } },
        { tool: "assert", args: {}, expect: { text_landed: "hi" } },
      ] as ProgramStep[],
    };
    expect(programExpectations(program)).toEqual([
      "1. type: pixel_changed",
      "2. assert: text_landed",
    ]);
  });

  it("describes a step compactly, eliding long values", () => {
    const line = describeStep({
      tool: "type",
      args: { text: "x".repeat(80), submit: true },
    } as ProgramStep);
    expect(line.startsWith("type text=")).toBe(true);
    expect(line.length).toBeLessThan(80);
    expect(line).toContain("…");
  });
});

describe("runProgramSteps", () => {
  const ctx = () => ({ emit: vi.fn(), stopping: () => false });

  afterEach(() => setProgramStepRunner(null));

  const program = (steps: unknown[], note?: string) => {
    const out = parseProgram(steps, note, noArgs);
    if (!out.ok) throw new Error(out.error);
    return out.program;
  };

  it("runs every step, reports each one, and emits the closing note once", async () => {
    const seen: string[] = [];
    setProgramStepRunner(async (name, args) => {
      seen.push(`${name}:${JSON.stringify(args.expect ?? null)}`);
      return { ok: true, verify: { effect: "changed", expect: "verified", expectDetail: "verified: the page changed" } };
    });
    const emit = vi.fn();
    const out = await runProgramSteps(
      program(
        [
          step("type", { text: "hello" }, { pixel_changed: true }),
          step("assert", {}, { text_landed: "hello" }),
        ],
        "Progress: typed. Next: nothing.",
      ),
      { emit, stopping: () => false },
    );
    expect(out.ok).toBe(true);
    expect(out.text).toContain("program complete: 2 step(s)");
    expect(out.text).toContain("1. type text=hello — verified");
    expect(out.text).toContain("2. assert — verified");
    expect(out.text).toContain("[progress noted]");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      kind: "progress_note",
      text: "Progress: typed. Next: nothing.",
    });
    // The declared expect rode the step's args — that is what the gated path checks.
    expect(seen[0]).toContain('"pixel_changed":true');
  });

  it("STOPS at the first step whose promise fails, and runs nothing after it", async () => {
    const ran: number[] = [];
    let n = 0;
    setProgramStepRunner(async () => {
      n += 1;
      ran.push(n);
      return n === 1
        ? { ok: true, verify: { expect: "verified", expectDetail: "verified: it landed" } }
        : { ok: true, verify: { expect: "failed", expectDetail: "NOT VERIFIED: the frame did NOT change" } };
    });
    const emit = vi.fn();
    const out = await runProgramSteps(
      program([
        step("type", { text: "a" }, { pixel_changed: true }),
        step("key", { key: "Enter" }, { pixel_changed: true }),
        step("assert", {}, { text_landed: "a" }),
      ]),
      { emit, stopping: () => false },
    );
    expect(out.ok).toBe(false);
    expect(out.stoppedAt).toBe(1);
    expect(out.text).toContain("program STOPPED at step 2 of 3");
    expect(out.text).toContain("NOT VERIFIED");
    expect(out.text).not.toContain("3. assert");
    expect(ran).toEqual([1, 2]);
    // A note that claims completion for a stopped program would be a lie.
    expect(emit).not.toHaveBeenCalled();
  });

  it("stops on a tool failure and shows its error", async () => {
    setProgramStepRunner(async () => ({ ok: false, error: "INPUT-FAILED: nope" }));
    const out = await runProgramSteps(
      program([step("menu_path", { path: ["Insert", "Table"] }, { pixel_changed: true })]),
      { emit: vi.fn(), stopping: () => false },
    );
    expect(out.ok).toBe(false);
    expect(out.text).toContain("FAILED: INPUT-FAILED: nope");
  });

  it("treats a repaired step as verified (the harness fixed it, so the program continues)", async () => {
    setProgramStepRunner(async () => ({
      ok: true,
      verify: { effect: "unchanged", expect: "verified", expectDetail: "verified: the frame visibly changed", repaired: true },
    }));
    const out = await runProgramSteps(
      program([step("click_at", { x: 10, y: 20 }, { pixel_changed: true })]),
      { emit: vi.fn(), stopping: () => false },
    );
    expect(out.ok).toBe(true);
    expect(out.text).toContain("verified");
  });

  it("stops between steps when the user asks", async () => {
    const runner = vi.fn(async () => ({ ok: true }) as ExecuteResult);
    setProgramStepRunner(runner);
    const out = await runProgramSteps(
      program([
        step("type", { text: "a" }, { pixel_changed: true }),
        step("key", { key: "Enter" }, { pixel_changed: true }),
      ]),
      { emit: vi.fn(), stopping: () => true },
    );
    expect(out.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(out.text).toContain("the user stopped the run");
  });

  it("says so when no runner is wired instead of pretending to work", async () => {
    const out = await runProgramSteps(
      program([step("type", { text: "a" }, { pixel_changed: true })]),
      { emit: vi.fn(), stopping: () => false },
    );
    expect(out.ok).toBe(false);
    expect(out.text).toContain("executor is not wired");
  });
});