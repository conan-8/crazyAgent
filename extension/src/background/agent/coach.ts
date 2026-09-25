// The coach — a SECOND agent that reviews a finished run and writes down what
// was learned, so the main agent stops repeating the same failure. It runs on
// the SAME selected model and connection as the chat agent (createLlmClient
// takes the same settings), but it is not a tool-calling browser agent: it
// gets one digest, one tool to answer with, and no access to the page.
//
// Everything here fails open. A coach that is slow, down or babbling must cost
// at most one wasted call — never the run it is reviewing, and never the
// user's stored lessons.
import type { LlmClient, LlmRequest, ThinkingLevel } from "../../shared/llm";
import type { LogTurnRecord } from "../../shared/logging";
import {
  LESSONS_PER_REVIEW_MAX,
  LESSONS_TOOL_NAME,
  LESSONS_TOOL_SPEC,
  buildRunDigest,
  mergeLessons,
  newLesson,
  parseLessonDrafts,
  runOutcome,
  type Lesson,
  type LessonDraft,
  type LessonSource,
} from "../../shared/lessons";

/**
 * One generous but bounded turn: the digest is already small, and the answer is
 * a handful of one-liners. `low` thinking keeps a review nearly free next to
 * the run it reviews.
 */
export const COACH_MAX_TOKENS = 1_600;
export const COACH_THINKING: ThinkingLevel = "low";
/** How many existing lessons the coach is shown (to avoid re-learning them). */
export const COACH_CONTEXT_LESSONS = 40;

export function buildCoachSystemPrompt(): string {
  return [
    "You are the Run Coach. A browser agent just finished a task; you review the record of that run and write down the lessons a future run must apply.",
    "",
    "You are given: the task, how the run ended, every failed tool call with its error, any loops, and the final answer. You do NOT see the page — never invent page details.",
    "",
    "What a good lesson is:",
    "- One imperative sentence that changes behaviour next time. Not a description of this run.",
    `- Reusable: no run-specific refs, ids, URLs or values that will be stale. At most ${LESSONS_PER_REVIEW_MAX} lessons.`,
    "- Specific: name the tool it is about, and the host when the problem is that website's quirk.",
    "- Grounded: only lessons supported by the record above. If the failure is not in the record, do not write it.",
    "- New: existing lessons are listed below. Do not restate them; record only what they miss.",
    "",
    "Do NOT record:",
    "- Lessons that merely repeat the agent's standing rules (look before acting, act by ref, verify effects).",
    "- Guesses about a site or a tool that the run did not actually demonstrate.",
    "- Secrets or personal data (passwords, tokens, card numbers, names, addresses).",
    "",
    "A run that went well, or a record too thin to be sure about, has an empty lesson list — that is a correct and common answer. A fabricated lesson is worse than no lesson.",
    "",
    `Answer by calling ${LESSONS_TOOL_NAME} exactly once. Do not reply in prose.`,
  ].join("\n");
}

/**
 * The coach's single input message: the run digest, plus the lessons already on
 * file so a review cannot re-learn them. Exported for tests — the prompt shape
 * is part of the contract with the model.
 */
export function buildCoachUserMessage(rec: LogTurnRecord, existing: Lesson[]): string {
  const parts = ["## Run under review", "", buildRunDigest(rec)];
  const known = existing.slice(0, COACH_CONTEXT_LESSONS);
  if (known.length) {
    parts.push(
      "",
      "## Lessons already on file (do not repeat these)",
      "",
      ...known.map((l) => `- [${l.category}] ${l.text}`),
    );
  }
  parts.push("", `## Your answer`, "", `Call ${LESSONS_TOOL_NAME} with the new lessons, or an empty list.`);
  return parts.join("\n");
}

export interface CoachReview {
  /** Newly learned lessons (not yet stored). */
  drafts: LessonDraft[];
  /** Non-fatal notes: unusable entries, truncated answers, parse misses. */
  errors: string[];
  /** Raw reply text, clipped — kept for the run/log troubleshooting path. */
  raw: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * One review turn on the selected model. Throws only on a failed LLM call (the
 * caller decides how loud to be); an unparseable answer comes back as zero
 * drafts with a note, because a bad review is not an error worth failing on.
 */
export async function reviewRun(opts: {
  llm: LlmClient;
  record: LogTurnRecord;
  existing: Lesson[];
  signal?: AbortSignal;
}): Promise<CoachReview> {
  const req: LlmRequest = {
    system: buildCoachSystemPrompt(),
    messages: [{ role: "user", content: buildCoachUserMessage(opts.record, opts.existing) }],
    tools: [LESSONS_TOOL_SPEC],
    maxTokens: COACH_MAX_TOKENS,
    thinking: COACH_THINKING,
  };
  const result = await opts.llm.complete(req, undefined, opts.signal);
  const call = result.toolCalls.find((c) => c.name === LESSONS_TOOL_NAME);
  const parsed = parseLessonDrafts({ text: result.text, toolArgs: call?.args });
  const errors = [...parsed.errors];
  if (call?.invalidJson !== undefined) errors.push("the lesson tool call had invalid JSON");
  return {
    drafts: parsed.drafts,
    errors,
    raw: result.text.slice(0, 2_000),
    usage: result.usage,
  };
}

export interface CoachOutcome {
  status: "added" | "empty" | "error";
  added: number;
  merged: number;
  total: number;
  drafts: LessonDraft[];
  notes: string[];
  message?: string;
}

/**
 * Review a run and store what it taught. Storage is injected (`existing` in,
 * `save` out) so this orchestration is unit-testable without chrome, and the
 * whole thing is fail-open: an LLM error returns `status: "error"` with the
 * message instead of throwing into the caller's run teardown.
 */
export async function learnFromRun(opts: {
  llm: LlmClient;
  record: LogTurnRecord;
  existing: Lesson[];
  source: LessonSource;
  save(lessons: Lesson[]): Promise<void>;
  signal?: AbortSignal;
}): Promise<CoachOutcome> {
  try {
    const review = await reviewRun({
      llm: opts.llm,
      record: opts.record,
      existing: opts.existing,
      signal: opts.signal,
    });
    if (!review.drafts.length) {
      return {
        status: "empty",
        added: 0,
        merged: 0,
        total: opts.existing.length,
        drafts: [],
        notes: review.errors,
      };
    }
    const learned = review.drafts.map((draft) =>
      newLesson(draft, {
        task: opts.record.task,
        source: opts.source,
        outcome: runOutcome(opts.record),
      }),
    );
    const mergedState = mergeLessons(opts.existing, learned);
    await opts.save(mergedState.lessons);
    return {
      status: "added",
      added: mergedState.added,
      merged: mergedState.merged,
      total: mergedState.lessons.length,
      drafts: review.drafts,
      notes: review.errors,
    };
  } catch (err) {
    return {
      status: "error",
      added: 0,
      merged: 0,
      total: opts.existing.length,
      drafts: [],
      notes: [],
      message: String((err as Error)?.message ?? err),
    };
  }
}