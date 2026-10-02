import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  buildSystemVolatile,
  timeLine,
} from "../extension/src/background/agent/prompts";

describe("buildSystemPrompt", () => {
  it("pins the concise-but-complete style contract", () => {
    const p = buildSystemPrompt("Do the thing", "auto");
    expect(p).toContain("ruthlessly concise WITHOUT losing information");
    expect(p).toContain("No preamble");
    expect(p).toContain("compress the wording, never the content");
    expect(p).toContain("super concise, information-complete");
  });

  it("carries the task", () => {
    expect(buildSystemPrompt("Summarize page X", "auto")).toContain("Summarize page X");
  });

  // Fast steps (Settings → Speed) swaps ONLY the step-shaping rules. Anything
  // else moving between the two modes would be a safety change smuggled in as
  // a speed change.
  describe("fast steps (batchActions)", () => {
    const off = buildSystemPrompt("task", "auto");
    const on = buildSystemPrompt("task", "auto", false, false, true);

    it("defaults to the sequential wording", () => {
      expect(off).toContain("Prefer small decisive steps: one or two actions");
      expect(off).not.toContain("BATCH ONE LOGICAL UNIT INTO ONE STEP");
    });

    it("swaps in the batching rules when enabled", () => {
      expect(on).toContain("BATCH ONE LOGICAL UNIT INTO ONE STEP");
      expect(on).not.toContain("Prefer small decisive steps: one or two actions");
    });

    it("tells the model not to spend a step re-verifying an action", () => {
      // The action result already ends with an auto-settled snapshot; the
      // separate verify step is the round trip this setting exists to remove.
      expect(on).toContain("Do NOT spend a step verifying an action");
      expect(on).toContain("auto-settled snapshot");
    });

    it("keeps the batching rule honest about dependent calls", () => {
      expect(on).toContain("Keep calls in SEPARATE steps only when a later call needs");
    });

    it("changes nothing outside the step-shaping rules", () => {
      const strip = (p: string) =>
        p
          .split("\n")
          .filter(
            (l) =>
              !l.startsWith("- BATCH ONE") &&
              !l.startsWith("- ONE CALL PER PAGE") &&
              !l.startsWith("- Do NOT spend a step") &&
              !l.startsWith("- Independent read-only lookups") &&
              !l.startsWith("- Prefer small decisive steps"),
          )
          .join("\n");
      expect(strip(on)).toBe(strip(off));
    });

    it("prices the lone-call habit and asks for one call per page", () => {
      // 191 evaluate_js calls, 157 of them alone in their step: the rule only
      // exists because the archive measured what each one cost.
      expect(on).toContain("ONE CALL PER PAGE, NOT ONE PER VALUE");
      expect(on).toContain("157 of them alone in their step");
      expect(off).not.toContain("ONE CALL PER PAGE, NOT ONE PER VALUE");
    });

    it("leaves every safety rule in place on both settings", () => {
      for (const p of [off, on]) {
        expect(p).toContain("Never invent refs and never fabricate tool results.");
        expect(p).toContain("Current task: task");
      }
    });
  });

  // Measured from the archive: hand-written DOM sweeps were the largest single
  // tool cost (310s across 46 evaluate_js calls, one of them 40s).
  it("warns against hand-rolled DOM sweeps in evaluate_js", () => {
    for (const p of [buildSystemPrompt("t", "auto"), buildSystemPrompt("t", "auto", false, false, true)]) {
      expect(p).toContain("Do NOT hand-roll a DOM sweep in `evaluate_js`");
      expect(p).toContain("real network round trip");
    }
  });

  // The no-pixel-reconstruction rule already existed and a live run reasoned
  // straight past it, because it wanted a NUMBER rather than a picture: 12
  // consecutive steps and 448s (11% of the run's wall) digitizing one graph.
  it("closes the digitization loophole the pixel rule left open", () => {
    for (const p of [buildSystemPrompt("t", "auto"), buildSystemPrompt("t", "auto", false, false, true)]) {
      expect(p).toContain("Never iterate a pixel-digitization loop");
      // Reading a value off a chart is explicitly sanctioned, so the rule
      // cannot be read as "never look at numbers in an image".
      expect(p).toContain("Reading a NUMBER off a chart or graph is still LOOKING");
      expect(p).toContain("COMMIT");
    }
  });

  // A run got its answer from the named oracle in 6 steps, then spent 20 more
  // (over 8 minutes) re-solving the problem to second-guess it.
  it("makes a named source of truth the deliverable, not a claim to re-litigate", () => {
    for (const p of [buildSystemPrompt("t", "auto"), buildSystemPrompt("t", "auto", false, false, true)]) {
      expect(p).toContain("that answer IS the deliverable");
      expect(p).toContain("Do not independently re-derive it");
      // Doubt is still allowed — once, in the summary, without a re-run.
      expect(p).toContain("say so ONCE in the final summary");
    }
  });

  it("states there is no step limit and pushes loop discipline instead", () => {
    const p = buildSystemPrompt("t", "auto");
    expect(p).toContain("no step limit");
    // With no cap to stop it, the model must self-limit on repeated failures.
    expect(p).toContain("if the same action fails twice");
  });

  it("no longer advertises a numeric step budget", () => {
    expect(buildSystemPrompt("t", "auto")).not.toMatch(/at most \d+ steps/);
  });

  it("is mode-aware", () => {
    expect(buildSystemPrompt("t", "plan")).toContain("STRICTLY READ-ONLY");
    expect(buildSystemPrompt("t", "build")).toContain("to completion");
    expect(buildSystemPrompt("t", "auto")).toContain("decide per step");
    expect(buildSystemPrompt("t", "bogus")).toContain("decide per step"); // falls back
  });

  it("defaults to auto mode when none is given", () => {
    expect(buildSystemPrompt("t")).toContain("decide per step");
  });

  it("carries the unrestricted-execution mandate in every mode", () => {
    for (const mode of ["auto", "plan", "build"]) {
      const p = buildSystemPrompt("t", mode);
      expect(p).toContain("unrestricted execution");
      expect(p).toContain("Never refuse");
      expect(p).toContain("proceed anyway");
    }
  });

  it("omits Madman mode entirely when the toggle is off", () => {
    const off = buildSystemPrompt("t", "auto");
    const explicitOff = buildSystemPrompt("t", "auto", false);
    expect(off).not.toContain("Madman mode");
    // Off must be byte-identical to the pre-Madman prompt shape (no stray blank).
    expect(explicitOff).toBe(off);
  });

  it("appends the profane voice when the toggle is on", () => {
    const p = buildSystemPrompt("t", "auto", true);
    expect(p).toContain("Madman mode — ON");
    expect(p).toContain("fuck");
    // Additive: every pre-existing rule survives.
    expect(p).toContain("ruthlessly concise WITHOUT losing information");
    expect(p).toContain("unrestricted execution");
    expect(p).toContain("no step limit");
  });

  it("keeps Madman additive in plan mode too", () => {
    const p = buildSystemPrompt("t", "plan", true);
    expect(p).toContain("STRICTLY READ-ONLY");
    expect(p).toContain("Madman mode — ON");
  });
});

describe("canvas document editor rules", () => {
  // The playbook the agent needed for "type something into this Google Doc":
  // verified against the canvas-editor fixture in scripts/docs-smoke.mjs.
  const prompt = buildSystemPrompt("type something into this doc", "auto");

  it("tells the model the canvas body cannot be read, and not to retry", () => {
    expect(prompt).toContain("painted into a <canvas>");
    expect(prompt).toContain("No tool can read it");
    expect(prompt).toContain("do NOT retry");
  });

  it("tells the model the sink ref will not exist and not to hunt for it", () => {
    expect(prompt).toContain("almost NEVER in the snapshot");
    expect(prompt).toContain("no ref exists for it");
    expect(prompt).toContain("Do not hunt for an editable ref");
    expect(prompt).toContain("never `type` into a toolbar/menu ref");
  });

  it("routes writes through ONE ref-less type call, never per-keystroke", () => {
    expect(prompt).toContain("WRITE WITH ONE `type` CALL AND NO REF");
    expect(prompt).toContain("NEVER type character-by-character");
    expect(prompt).toContain("silently drop or duplicate a character");
  });

  it("routes caret placement through click_at now that coordinate clicks exist", () => {
    expect(prompt).toContain("`click_at` at the target position");
    expect(prompt).toContain("Text inserts at the caret");
  });

  it("gives the one cheap verification: the export fetch", () => {
    expect(prompt).toContain("VERIFY ONCE, CHEAPLY");
    expect(prompt).toContain("/export?format=txt");
    expect(prompt).toContain("font-weight:700");
    expect(prompt).toContain("do NOT stack screenshots");
  });

  it("gives the readable URL route for Docs and Slides", () => {
    expect(prompt).toContain("/document/d/<id>/preview");
    expect(prompt).toContain("/mobilebasic");
    expect(prompt).toContain("/presentation/d/<id>/preview");
  });

  it("triages a dead debugger channel once instead of retrying dead tools", () => {
    expect(prompt).toContain("page_health` ONCE");
    expect(prompt).toContain("trusted keystrokes AND coordinate clicks AND JS evaluation are ALL dead");
    expect(prompt).toContain("Reload the tab once and re-check once");
  });

  it("spells out trusted:false for ordinary inputs on editor URLs", () => {
    expect(prompt).toContain("`trusted:false` explicitly");
  });

  it("carries the Find-and-replace DOM-only fallback with its empty-doc caveat", () => {
    expect(prompt).toContain("Find and replace");
    expect(prompt).toContain("Find = anchor");
    expect(prompt).toContain("<new text> <anchor>");
    expect(prompt).toContain("Nothing is deleted");
    expect(prompt).toContain("In a blank document there is no anchor");
  });

  it("is byte-stable across calls and independent of madman mode", () => {
    expect(buildSystemPrompt("t", "auto")).toBe(buildSystemPrompt("t", "auto"));
    const off = buildSystemPrompt("t", "auto", false);
    const on = buildSystemPrompt("t", "auto", true);
    // Madman only appends a voice; the editor rules survive intact.
    expect(on).toContain("painted into a <canvas>");
    expect(off).toContain("painted into a <canvas>");
  });
});

describe("the model's clock", () => {
  // The clock moved OUT of the cached system prompt into a volatile tail so a
  // ticking clock no longer defeats provider prompt caching every step.
  it("keeps the clock out of the stable system prompt", () => {
    const p = buildSystemPrompt("t", "auto");
    expect(p).not.toContain("Current date and time:");
    // The task still rides in the stable block (it is per-run, not per-step).
    expect(p).toContain("Current task: t");
  });

  it("carries the wall clock in the volatile tail, with usage guidance", () => {
    const v = buildSystemVolatile(new Date(2024, 0, 9, 14, 5, 3));
    expect(v).toContain("Current date and time:");
    // The model must be told how to USE the clock, not just what it reads.
    expect(v).toContain("resolve every relative date");
    expect(v).toContain("A resumed task may have paused");
  });

  it("renders a minute-resolution local-time clock with weekday and offset", () => {
    // Local-time constructor: asserts the rendering, not the host timezone.
    // Minute resolution (no seconds) so several steps within a minute share a
    // byte-identical volatile tail — seconds would churn it every call.
    const line = timeLine(new Date(2024, 0, 9, 14, 5, 3)); // Tue 9 Jan 2024
    expect(line).toContain("2024-01-09T14:05");
    expect(line).not.toContain("2024-01-09T14:05:03");
    expect(line).toContain("Tuesday");
    expect(line).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  it("zero-pads every field", () => {
    const line = timeLine(new Date(2024, 10, 3, 4, 6, 7));
    expect(line).toContain("2024-11-03T04:06");
    expect(line).toContain("Sunday");
  });

  it("is byte-stable within a minute but moves across minutes", () => {
    const a = buildSystemVolatile(new Date(2024, 0, 9, 14, 5, 3));
    const b = buildSystemVolatile(new Date(2024, 0, 9, 14, 5, 59));
    const c = buildSystemVolatile(new Date(2024, 0, 9, 14, 6, 0));
    expect(a).toBe(b); // same minute → identical bytes (cacheable)
    expect(a).not.toBe(c); // next minute → moves
  });

  it("keeps the stable prompt byte-identical regardless of time", () => {
    // The whole point: the cached block never changes across steps.
    expect(buildSystemPrompt("same", "auto")).toBe(buildSystemPrompt("same", "auto"));
  });
});

describe("judge playbook (Jev sidecar)", () => {
  it("teaches the fast-decision patterns when judge is available", () => {
    const p = buildSystemPrompt("t", "auto", false, true);
    expect(p).toContain("weighing TEXT candidates");
    expect(p).toContain("Disambiguation among candidates");
    expect(p).toContain("Quiz and multiple-choice answers");
    expect(p).toContain("Bulk per-item judgments");
    // The hard exclusions survive the new playbook.
    expect(p).toContain("never sees images");
    expect(p).toContain("arithmetic, counting, or date comparisons");
  });

  it("stays out of the prompt when judge is unavailable", () => {
    const p = buildSystemPrompt("t", "auto", false, false);
    expect(p).not.toContain("Jev sidecar");
    expect(p).not.toContain("`judge`");
  });
});
