import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assumeExpects,
  describeStep,
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

  it("assumes pixel_changed where a program promised nothing, and names the steps", () => {
    // This used to be a refusal, and the refusal cost two of the four
    // run_program failures in a 420-turn benchmark run — one of them on an
    // 8-step batch, which is exactly the batching the tool exists for.
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
    expect(gap.ok).toBe(true);
    // The third consecutive unverified mutating step is the one that gets it.
    if (gap.ok) expect(gap.program.assumedExpects).toEqual([3]);

    const noLast = parseProgram(
      [step("type", { text: "hi" }, { pixel_changed: true }), step("key", { key: "Enter" })],
      undefined,
      noArgs,
    );
    expect(noLast.ok).toBe(true);
    if (noLast.ok) {
      expect(noLast.program.assumedExpects).toEqual([1]);
      expect(noLast.program.steps[1]!.expect).toEqual({ pixel_changed: true });
    }

    // A program that writes its own expects is left exactly as written.
    const own = parseProgram(
      [step("type", { text: "hi" }, { text_landed: "hi" }), step("assert", {}, { text_landed: "hi" })],
      undefined,
      noArgs,
    );
    expect(own.ok && own.program.assumedExpects).toBeUndefined();
  });

  it("folds step arguments the model hoisted onto the step itself", () => {
    // {tool:"key", key:"Enter"} — six of seven run_program calls in one
    // archived run were refused for this shape alone.
    const out = parseProgram(
      [
        { tool: "key", key: "Control+Alt+2" },
        { tool: "type", text: "Section One", expect: { text_landed: "Section One" } },
      ],
      undefined,
      noArgs,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.program.steps[0]!.args).toEqual({ key: "Control+Alt+2" });
      expect(out.program.steps[1]!.args).toEqual({ text: "Section One" });
    }
    // A declared args object wins over a hoisted key of the same name.
    const both = parseProgram(
      [{ tool: "key", key: "Tab", args: { key: "Enter" } }, step("assert", {}, { text_landed: "x" })],
      undefined,
      noArgs,
    );
    expect(both.ok && both.program.steps[0]!.args).toEqual({ key: "Enter" });
  });

  it("caps the note and rejects a non-string one", () => {
    const long = "x".repeat(900);
    const out = parseProgram([step("assert", {}, { text_landed: "x" })], long, noArgs);
    expect(out.ok && out.program.note!.length).toBe(400);
    expect(parseProgram([step("assert", {}, { text_landed: "x" })], 5, noArgs).ok).toBe(false);
  });

  it("assumes expects only on mutating steps, and only where a run grew too long", () => {
    const keys = (n: number, withExpect = false) =>
      Array.from({ length: n }, () => ({
        tool: "key",
        args: {},
        ...(withExpect ? { expect: { text_landed: "x" } } : {}),
      })) as unknown as ProgramStep[];
    // Two unverified mutating steps are the model's own business…
    expect(assumeExpects(keys(2), 2)).toEqual([1]); // …but the last one is the program's promise.
    expect(assumeExpects([...keys(1, true), ...keys(2)], 2)).toEqual([2]);
    expect(assumeExpects([...keys(1, true), ...keys(3)], 2)).toEqual([3]);
    // Read-only steps neither need nor get an expect.
    expect(assumeExpects([{ tool: "docs_read", args: {} }] as unknown as ProgramStep[], 2)).toEqual([]);
    expect(
      assumeExpects(
        [
          { tool: "key", args: {} },
          { tool: "docs_read", args: {} },
        ] as unknown as ProgramStep[],
        2,
      ),
    ).toEqual([]);
  });

  it("lists the promises a program makes", () => {
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