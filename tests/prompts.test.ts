import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  buildSystemVolatile,
  timeLine,
} from "../extension/src/background/agent/prompts";
import { BUNDLED_SKILLS } from "../extension/src/shared/skills";

describe("buildSystemPrompt", () => {
  it("pins the concise-but-complete style contract", () => {
    const p = buildSystemPrompt("Do the thing");
    expect(p).toContain("ruthlessly concise WITHOUT losing information");
    expect(p).toContain("No preamble");
    expect(p).toContain("compress the wording, never the content");
    expect(p).toContain("super concise, information-complete");
  });

  it("carries the task", () => {
    expect(buildSystemPrompt("Summarize page X")).toContain("Summarize page X");
  });

  // Fast steps (Settings → Speed) swaps ONLY the step-shaping rules. Anything
  // else moving between the two modes would be a safety change smuggled in as
  // a speed change.
  describe("fast steps (batchActions)", () => {
    const off = buildSystemPrompt("task");
    const on = buildSystemPrompt("task", false, false, true);

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
              !l.startsWith("- When the procedure is already KNOWN") &&
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
    for (const p of [buildSystemPrompt("t"), buildSystemPrompt("t", false, false, true)]) {
      expect(p).toContain("Do NOT hand-roll a DOM sweep in `evaluate_js`");
      expect(p).toContain("real network round trip");
    }
  });

  // The no-pixel-reconstruction rule already existed and a live run reasoned
  // straight past it, because it wanted a NUMBER rather than a picture: 12
  // consecutive steps and 448s (11% of the run's wall) digitizing one graph.
  it("closes the digitization loophole the pixel rule left open", () => {
    for (const p of [buildSystemPrompt("t"), buildSystemPrompt("t", false, false, true)]) {
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
    for (const p of [buildSystemPrompt("t"), buildSystemPrompt("t", false, false, true)]) {
      expect(p).toContain("that answer IS the deliverable");
      expect(p).toContain("Do not independently re-derive it");
      // Doubt is still allowed — once, in the summary, without a re-run.
      expect(p).toContain("say so ONCE in the final summary");
    }
  });

  it("states there is no step limit and pushes loop discipline instead", () => {
    const p = buildSystemPrompt("t");
    expect(p).toContain("no step limit");
    // With no cap to stop it, the model must self-limit on repeated failures.
    expect(p).toContain("if the same action fails twice");
  });

  it("no longer advertises a numeric step budget", () => {
    expect(buildSystemPrompt("t")).not.toMatch(/at most \d+ steps/);
  });

  it("carries the unrestricted-execution mandate", () => {
    const p = buildSystemPrompt("t");
    expect(p).toContain("unrestricted execution");
    expect(p).toContain("Never refuse");
    expect(p).toContain("proceed anyway");
  });

  it("omits Madman mode entirely when the toggle is off", () => {
    const off = buildSystemPrompt("t");
    const explicitOff = buildSystemPrompt("t", false);
    expect(off).not.toContain("Madman mode");
    // Off must be byte-identical to the pre-Madman prompt shape (no stray blank).
    expect(explicitOff).toBe(off);
  });

  it("appends the profane voice when the toggle is on", () => {
    const p = buildSystemPrompt("t", true);
    expect(p).toContain("Madman mode — ON");
    expect(p).toContain("fuck");
    // Additive: every pre-existing rule survives.
    expect(p).toContain("ruthlessly concise WITHOUT losing information");
    expect(p).toContain("unrestricted execution");
    expect(p).toContain("no step limit");
  });
});

describe("canvas document editor procedure", () => {
  // The full playbook moved OUT of the fixed prefix into the bundled
  // `canvas-doc-editors` skill (shared/skills.ts): ~700 tokens rode every step
  // of every run for pages that had no editor in sight. The prompt keeps a
  // one-line pointer; use_skill loads the body on demand.
  const prompt = buildSystemPrompt("type something into this doc");
  const skill = BUNDLED_SKILLS.find((s) => s.name === "canvas-doc-editors")!;

  it("keeps a pointer in the prompt and nothing more", () => {
    expect(prompt).toContain("`use_skill name:canvas-doc-editors`");
    // The heavy rules are gone from the prefix — that was the point.
    expect(prompt).not.toContain("No tool can read it");
    expect(prompt).not.toContain("/export?format=txt");
    expect(prompt).not.toContain("Find and replace");
  });

  it("tells the model the canvas body cannot be read, and not to retry", () => {
    expect(skill.body).toContain("painted into a <canvas>");
    expect(skill.body).toContain("no tool reads the pixels back");
    expect(skill.body).toContain("do NOT retry");
  });

  it("tells the model the sink ref will not exist and not to hunt for it", () => {
    expect(skill.body).toContain("no ref exists for it");
    expect(skill.body).toContain("hidden typing sink");
  });

  it("routes writes through type_at / one ref-less type call, never per-keystroke", () => {
    expect(skill.body).toContain("THE PRIMARY MOVE IS `type_at`");
    expect(skill.body).toContain("ONE trusted sequence");
    expect(skill.body).toContain("ONE no-ref `type` call");
    expect(skill.body).toContain("NEVER type character-by-character");
  });

  it("forbids line-counting navigation and prefers visual selection", () => {
    expect(skill.body).toContain("NEVER navigate by Home/arrows/Shift+Down line counting");
    expect(skill.body).toContain("STYLE AHEAD OF THE CARET");
    expect(skill.body).toContain("select_to:{x,y}");
    expect(skill.body).toContain("zoom:2..4");
  });

  it("carries the atomic rebuild mode for tangled bodies", () => {
    expect(skill.body).toContain("do not patch — REBUILD");
    expect(skill.body).toContain("select:'all'");
    expect(skill.body).toContain("cannot be lost between calls");
  });

  it("gives the one cheap verification: the export fetch (html for formatting)", () => {
    expect(skill.body).toContain("VERIFY ONCE PER BLOCK, CHEAPLY");
    expect(skill.body).toContain("/export?format=html");
    expect(skill.body).toContain("/export?format=txt");
    expect(skill.body).toContain("font-weight:700");
    expect(skill.body).toContain("One export per block");
  });

  it("gives the readable URL route for Docs and Slides", () => {
    expect(skill.body).toContain("/document/d/<id>/preview");
    expect(skill.body).toContain("/mobilebasic");
    expect(skill.body).toContain("/presentation/d/<id>/preview");
  });

  it("triages a dead debugger channel once instead of retrying dead tools", () => {
    expect(skill.body).toContain("page_health` ONCE");
    expect(skill.body).toContain("trusted keystrokes AND coordinate clicks AND JS evaluation are ALL dead");
    expect(skill.body).toContain("Reload the tab once and re-check once");
  });

  it("spells out trusted:false for ordinary inputs on editor URLs", () => {
    expect(skill.body).toContain("`trusted:false` explicitly");
  });

  it("carries the Find-and-replace DOM-only fallback with its empty-doc caveat", () => {
    expect(skill.body).toContain("Find and replace");
    expect(skill.body).toContain("Find = anchor");
    expect(skill.body).toContain("<new text> <anchor>");
    expect(skill.body).toContain("Nothing is deleted");
    expect(skill.body).toContain("In a blank document there is no anchor");
  });

  it("is byte-stable across calls and independent of madman mode", () => {
    expect(buildSystemPrompt("t")).toBe(buildSystemPrompt("t"));
    const off = buildSystemPrompt("t", false);
    const on = buildSystemPrompt("t", true);
    // Madman only appends a voice; the pointer survives intact.
    expect(on).toContain("`use_skill name:canvas-doc-editors`");
    expect(off).toContain("`use_skill name:canvas-doc-editors`");
  });
});

describe("the model's clock", () => {
  // The clock moved OUT of the cached system prompt into a volatile tail so a
  // ticking clock no longer defeats provider prompt caching every step.
  it("keeps the clock out of the stable system prompt", () => {
    const p = buildSystemPrompt("t");
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
    expect(buildSystemPrompt("same")).toBe(buildSystemPrompt("same"));
  });
});

describe("judge playbook (Jev sidecar)", () => {
  it("teaches the fast-decision patterns when judge is available", () => {
    const p = buildSystemPrompt("t", false, true);
    expect(p).toContain("weighing TEXT candidates");
    expect(p).toContain("Disambiguation among candidates");
    expect(p).toContain("Quiz and multiple-choice answers");
    expect(p).toContain("Bulk per-item judgments");
    // The hard exclusions survive the new playbook.
    expect(p).toContain("never sees images");
    expect(p).toContain("arithmetic, counting, or date comparisons");
  });

  it("stays out of the prompt when judge is unavailable", () => {
    const p = buildSystemPrompt("t", false, false);
    expect(p).not.toContain("Jev sidecar");
    expect(p).not.toContain("`judge`");
  });
});
