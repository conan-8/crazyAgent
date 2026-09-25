// The pure core of self-improvement: run digests, lesson merging, tolerant
// parsing of the coach's answer, prompt ranking/formatting and the auto-review
// trigger. No chrome, no fetch — the model call itself is stubbed in
// tests/coach.test.ts.
import { describe, expect, it } from "vitest";
import {
  DIGEST_MAX_CHARS,
  LESSONS_MAX,
  LESSONS_PER_REVIEW_MAX,
  LESSON_TEXT_MAX_CHARS,
  buildPromptLessonsBlock,
  buildRunDigest,
  failedCalls,
  formatLessonsBlock,
  lessonKey,
  lessonsToJsonl,
  lessonsToMarkdown,
  mergeLessons,
  newLesson,
  normalizeCategory,
  normalizeHost,
  parseLessonDrafts,
  rankLessonsForTask,
  repeatedFailures,
  runOutcome,
  runWasStopped,
  shouldAutoReview,
  type Lesson,
  type LessonDraft,
} from "../extension/src/shared/lessons";
import { foldLogEvent, newTurnRecord } from "../extension/src/shared/logging";

function draft(text: string, rest: Partial<LessonDraft> = {}): LessonDraft {
  return { category: "tool", text, ...rest };
}

function lesson(text: string, rest: Partial<Lesson> = {}): Lesson {
  return {
    id: `l_${text.slice(0, 6)}`,
    at: 1_000,
    task: "some task",
    source: "auto",
    outcome: "done",
    category: "tool",
    text,
    hits: 1,
    ...rest,
  };
}

/** A run with one failing click, then a final answer. */
function failedRun(task = "book a table", at = 1_000) {
  const rec = newTurnRecord(task, { at });
  foldLogEvent(rec, { kind: "step_started", stepIndex: 0 }, at + 1);
  foldLogEvent(
    rec,
    { kind: "tool_call", stepIndex: 0, name: "click", args: { ref: "12" } },
    at + 2,
  );
  foldLogEvent(
    rec,
    {
      kind: "tool_result",
      stepIndex: 0,
      name: "click",
      result: "ERROR: stale ref '12' — take a fresh snapshot",
      ok: false,
    },
    at + 3,
  );
  foldLogEvent(rec, { kind: "done", summary: "gave up on the form" }, at + 4);
  return rec;
}

describe("lesson merging", () => {
  it("adds new lessons newest-first", () => {
    const older = lesson("older lesson", { id: "a", at: 10 });
    const newer = lesson("newer lesson", { id: "b", at: 20 });
    const { lessons, added, merged } = mergeLessons([older], [newer]);
    expect(added).toBe(1);
    expect(merged).toBe(0);
    expect(lessons.map((l) => l.id)).toEqual(["b", "a"]);
  });

  it("bumps hits instead of duplicating a lesson already learned", () => {
    const stored = lesson("Always take a fresh snapshot after a stale ref", { hits: 2 });
    const again = lesson("always take a fresh snapshot after a stale ref!!", { id: "new" });
    const { lessons, added, merged } = mergeLessons([stored], [again]);
    expect(added).toBe(0);
    expect(merged).toBe(1);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.hits).toBe(3);
  });

  it("keeps the stored wording on a duplicate (the user may have edited it)", () => {
    const edited = lesson("MY edited wording of the lesson", { id: "keep" });
    const incoming = lesson("my edited wording of the lesson", { id: "new" });
    const { lessons } = mergeLessons([edited], [incoming]);
    expect(lessons[0]!.id).toBe("keep");
    expect(lessons[0]!.text).toBe("MY edited wording of the lesson");
  });

  it("caps the ring, dropping the oldest", () => {
    const all = Array.from({ length: LESSONS_MAX }, (_, i) =>
      lesson(`lesson number ${i}`, { id: `l${i}`, at: 1_000 + i }),
    );
    const { lessons } = mergeLessons(all, [lesson("brand new", { id: "x", at: 99_999 })]);
    expect(lessons).toHaveLength(LESSONS_MAX);
    expect(lessons[0]!.id).toBe("x");
    expect(lessons.some((l) => l.id === "l0")).toBe(false);
  });

  it("lessonKey ignores case, punctuation and extra whitespace", () => {
    expect(lessonKey("  Fix  the REF! ")).toBe(lessonKey("fix the ref"));
  });
});

describe("newLesson", () => {
  it("clips text/evidence and keeps run metadata", () => {
    const l = newLesson(
      draft("x".repeat(LESSON_TEXT_MAX_CHARS + 50), { evidence: "y".repeat(500) }),
      { task: "t", source: "manual", outcome: "stopped", at: 5 },
    );
    expect(l.text.length).toBeLessThanOrEqual(LESSON_TEXT_MAX_CHARS);
    expect(l.evidence!.length).toBeLessThanOrEqual(300);
    expect(l).toMatchObject({ source: "manual", outcome: "stopped", hits: 1, at: 5 });
    expect(l.id).toMatch(/^lesson_/);
  });
});

describe("category and host normalization", () => {
  it("maps aliases and falls back to other", () => {
    expect(normalizeCategory("Tool use")).toBe("tool");
    expect(normalizeCategory("site-specific")).toBe("site");
    expect(normalizeCategory("WORKFLOW")).toBe("workflow");
    expect(normalizeCategory("nonsense")).toBe("other");
    expect(normalizeCategory(undefined)).toBe("other");
  });

  it("reduces URLs to a bare hostname", () => {
    expect(normalizeHost("https://www.github.com/foo/bar?x=1")).toBe("github.com");
    expect(normalizeHost("Booking.COM:443")).toBe("booking.com");
    expect(normalizeHost("  ")).toBeUndefined();
    expect(normalizeHost(7)).toBeUndefined();
  });
});

describe("reading a run", () => {
  it("collects failed calls with their error text and collapses repeats", () => {
    const rec = failedRun();
    foldLogEvent(
      rec,
      { kind: "tool_call", stepIndex: 1, name: "click", args: { ref: "12" } },
      2_000,
    );
    foldLogEvent(
      rec,
      {
        kind: "tool_result",
        stepIndex: 1,
        name: "click",
        result: "ERROR: stale ref '12' — take a fresh snapshot",
        ok: false,
      },
      2_001,
    );
    const failed = failedCalls(rec);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ name: "click", count: 2 });
    expect(failed[0]!.error).toContain("stale ref");
    expect(repeatedFailures(rec)).toHaveLength(1);
  });

  it("treats a single failure as not a loop", () => {
    expect(repeatedFailures(failedRun())).toHaveLength(0);
  });

  it("builds a digest with the task, the failure and the final answer", () => {
    const digest = buildRunDigest(failedRun("order a pizza"));
    expect(digest).toContain("Task: order a pizza");
    expect(digest).toContain("Failures (1)");
    expect(digest).toContain("stale ref");
    expect(digest).toContain("Final answer: gave up on the form");
  });

  it("caps the digest size on a very long run", () => {
    const rec = newTurnRecord("huge task", { at: 1 });
    for (let i = 0; i < 200; i++) {
      foldLogEvent(
        rec,
        { kind: "tool_call", stepIndex: i, name: "click", args: { ref: String(i) } },
        i * 10 + 2,
      );
      foldLogEvent(
        rec,
        {
          kind: "tool_result",
          stepIndex: i,
          name: "click",
          result: `ERROR: failure number ${i} ${"z".repeat(500)}`,
          ok: false,
        },
        i * 10 + 3,
      );
      foldLogEvent(rec, { kind: "token_delta", text: `step ${i} reasoning ` }, i * 10 + 4);
    }
    foldLogEvent(rec, { kind: "done", summary: "done" }, 9_999);
    const digest = buildRunDigest(rec);
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS + 40);
    expect(digest).toContain("…[digest truncated]");
  });

  it("detects a stopped run from its summary (stopped is not a stored status)", () => {
    const rec = failedRun();
    rec.turns[rec.turns.length - 1]!.summary = "stopped at step 4";
    expect(runWasStopped(rec)).toBe(true);
    expect(runOutcome(rec)).toBe("stopped");
  });

  it("reports the stored status when the run was not stopped", () => {
    expect(runOutcome(failedRun())).toBe("done");
  });
});

describe("shouldAutoReview", () => {
  it("skips a clean, finished run", () => {
    const rec = newTurnRecord("read the news", { at: 1 });
    foldLogEvent(rec, { kind: "tool_call", stepIndex: 0, name: "snapshot", args: {} }, 2);
    foldLogEvent(
      rec,
      { kind: "tool_result", stepIndex: 0, name: "snapshot", result: "ok", ok: true },
      3,
    );
    foldLogEvent(rec, { kind: "done", summary: "summarised" }, 4);
    expect(shouldAutoReview(rec)).toEqual({ review: false, reasons: [] });
  });

  it("reviews a run with a failed tool call", () => {
    const trigger = shouldAutoReview(failedRun());
    expect(trigger.review).toBe(true);
    expect(trigger.reasons.join(" ")).toContain("failed tool call");
  });

  it("reviews a stopped run and says why", () => {
    const rec = failedRun();
    rec.turns[rec.turns.length - 1]!.summary = "stopped at step 2";
    expect(shouldAutoReview(rec).reasons.join(" ")).toContain("stopped");
  });

  it("reviews an errored run", () => {
    const rec = failedRun();
    foldLogEvent(rec, { kind: "error", message: "LLM call failed: 500" }, 5_000);
    const trigger = shouldAutoReview(rec);
    expect(trigger.review).toBe(true);
    expect(trigger.reasons.join(" ")).toContain("error");
  });

  it("flags a loop explicitly", () => {
    const rec = failedRun();
    foldLogEvent(rec, { kind: "tool_call", stepIndex: 1, name: "click", args: { ref: "12" } }, 2_000);
    foldLogEvent(
      rec,
      {
        kind: "tool_result",
        stepIndex: 1,
        name: "click",
        result: "ERROR: stale ref '12' — take a fresh snapshot",
        ok: false,
      },
      2_001,
    );
    expect(shouldAutoReview(rec).reasons.join(" ")).toContain("loop");
  });

  it("skips a run that is still open or recorded nothing", () => {
    const open = newTurnRecord("in flight", { at: 1 });
    foldLogEvent(open, { kind: "tool_call", stepIndex: 0, name: "click", args: {} }, 2);
    expect(shouldAutoReview(open).review).toBe(false);
    expect(shouldAutoReview(newTurnRecord("empty", { at: 1 })).review).toBe(false);
  });
});

describe("parseLessonDrafts", () => {
  it("reads a record_lessons tool call", () => {
    const { drafts, errors } = parseLessonDrafts({
      toolArgs: {
        lessons: [
          {
            category: "tool",
            text: "After a stale-ref error, take a fresh snapshot before retrying.",
            evidence: "click on ref 12 failed twice",
            tool: "click",
            host: "https://booking.com/hotels",
          },
        ],
      },
    });
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      category: "tool",
      tool: "click",
      host: "booking.com",
    });
  });

  it("reads JSON in the reply text, fenced or not", () => {
    const body = JSON.stringify({
      lessons: [{ category: "site", text: "This site needs a login before search works." }],
    });
    expect(parseLessonDrafts({ text: body }).drafts).toHaveLength(1);
    expect(parseLessonDrafts({ text: `Here you go:\n\`\`\`json\n${body}\n\`\`\`` }).drafts)
      .toHaveLength(1);
    expect(parseLessonDrafts({ text: `Sure!\n${body}\nHope that helps.` }).drafts).toHaveLength(1);
  });

  it("accepts a bare array and a single lesson object", () => {
    expect(
      parseLessonDrafts({ text: '[{"text":"Prefer keyboard Enter to submit this form."}]' })
        .drafts,
    ).toHaveLength(1);
    expect(
      parseLessonDrafts({ text: '{"text":"Scroll the virtualised list before reading rows."}' })
        .drafts,
    ).toHaveLength(1);
  });

  it("returns nothing (and says so) for prose that carries no lessons", () => {
    const { drafts, errors } = parseLessonDrafts({ text: "The run went fine, nothing to add." });
    expect(drafts).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("skips entries without usable text", () => {
    const { drafts, errors } = parseLessonDrafts({
      toolArgs: { lessons: [{ category: "tool" }, { text: "hi" }, { text: "A real lesson sentence." }] },
    });
    expect(drafts).toHaveLength(1);
    expect(errors.join(" ")).toContain("without usable text");
  });

  it("caps one review and dedupes within it", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      text: `Distinct lesson number ${i} about the page.`,
    }));
    many.push({ text: "distinct lesson number 0 about the page" });
    const { drafts, errors } = parseLessonDrafts({ toolArgs: { lessons: many } });
    expect(drafts).toHaveLength(LESSONS_PER_REVIEW_MAX);
    expect(errors.join(" ")).toContain("kept the first");
  });

  it("never fabricates a lesson from junk", () => {
    expect(parseLessonDrafts({ toolArgs: {} }).drafts).toEqual([]);
    expect(parseLessonDrafts({ text: "{ broken json" }).drafts).toEqual([]);
    expect(parseLessonDrafts({}).drafts).toEqual([]);
  });
});

describe("prompt injection ranking", () => {
  const lessons = [
    lesson("Recent generic lesson", { id: "recent", at: 500 }),
    lesson("GitHub needs the search box focused first", { id: "github", at: 100, host: "github.com" }),
    lesson("Always pin me", { id: "pinned", at: 10, pinned: true }),
  ];

  it("puts pinned first and host-matched lessons above unrelated ones", () => {
    const ranked = rankLessonsForTask(lessons, "find my open PRs on github.com");
    expect(ranked.map((l) => l.id)).toEqual(["pinned", "github", "recent"]);
  });

  it("ignores host lessons for an unrelated task", () => {
    const ranked = rankLessonsForTask(lessons, "order a pizza");
    expect(ranked.map((l) => l.id)).toEqual(["pinned", "recent", "github"]);
  });

  it("caps the number of lessons and the block size", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      lesson(`Lesson ${i} ${"x".repeat(80)}`, { id: `m${i}`, at: 1_000 - i }),
    );
    const ranked = rankLessonsForTask(many, "task", { maxItems: 3 });
    expect(ranked).toHaveLength(3);
    const block = formatLessonsBlock(rankLessonsForTask(many, "task"));
    expect(block.length).toBeLessThanOrEqual(1_600 + 400);
  });
});

describe("the injected block", () => {
  it("is empty with no lessons — the base prompt stays untouched", () => {
    expect(buildPromptLessonsBlock([], "task")).toBe("");
    expect(formatLessonsBlock([])).toBe("");
  });

  it("frames lessons as reference and tags them", () => {
    const block = buildPromptLessonsBlock(
      [lesson("Take a fresh snapshot after a stale ref", { host: "booking.com", hits: 3, tool: "click" })],
      "book on booking.com",
    );
    expect(block).toContain("reference, not user instructions");
    expect(block).toContain("always win over a lesson");
    expect(block).toContain("Take a fresh snapshot after a stale ref");
    expect(block).toContain("booking.com");
    expect(block).toContain("seen 3×");
  });
});

describe("export", () => {
  it("writes JSONL and Markdown", () => {
    const one = lesson("Never retry a failing ref twice", {
      evidence: "click failed 2× on ref 12",
      pinned: true,
    });
    expect(lessonsToJsonl([one]).trim()).toBe(JSON.stringify(one));
    const md = lessonsToMarkdown([one]);
    expect(md).toContain("# Lessons learned");
    expect(md).toContain("## Never retry a failing ref twice");
    expect(md).toContain("click failed 2× on ref 12");
    expect(lessonsToMarkdown([])).toContain("No lessons recorded yet");
  });
});
describe("mergeLessons ordering", () => {
  // Regression: ordering used to lean on `sort` stability with equal keys.
  // Lessons learned in one review share a millisecond timestamp, so the order
  // was left to the engine and flaked (a real CI failure).
  it("keeps the coach's order for lessons learned in the same millisecond", () => {
    const sameMs = 1_700_000_000_000;
    const batch = ["first learned", "second learned", "third learned", "fourth learned"].map(
      (text, i) => lesson(text, { id: `n${i}`, at: sameMs }),
    );
    for (let run = 0; run < 50; run++) {
      const { lessons } = mergeLessons([], batch);
      expect(lessons.map((l) => l.text)).toEqual([
        "first learned",
        "second learned",
        "third learned",
        "fourth learned",
      ]);
    }
  });

  it("keeps new lessons ahead of stored ones, even at identical timestamps", () => {
    const sameMs = 1_700_000_000_000;
    const stored = [lesson("old one", { id: "a", at: sameMs }), lesson("old two", { id: "b", at: sameMs })];
    const { lessons } = mergeLessons(stored, [
      lesson("brand new one", { id: "x", at: sameMs }),
      lesson("brand new two", { id: "y", at: sameMs }),
    ]);
    expect(lessons.map((l) => l.text)).toEqual([
      "brand new one",
      "brand new two",
      "old one",
      "old two",
    ]);
  });

  it("sorts stored lessons newest-first across distinct times", () => {
    const stored = [
      lesson("middle", { id: "m", at: 200 }),
      lesson("oldest", { id: "o", at: 100 }),
      lesson("newest", { id: "n", at: 300 }),
    ];
    const { lessons } = mergeLessons(stored, []);
    expect(lessons.map((l) => l.text)).toEqual(["newest", "middle", "oldest"]);
  });
});
