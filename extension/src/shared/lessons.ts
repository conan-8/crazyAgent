// Self-improvement layer ("the coach"): when a run ends — or when the user
// asks — a SECOND agent, driven by the SAME selected model, reviews what
// happened and writes durable lessons ("this failed, do it differently") into
// a per-profile log. Those lessons are folded back into the main agent's
// system prompt on later runs, so a failure paid for once is not repeated
// blindly.
//
// This file is the pure core: types, the run digest the coach reads, tolerant
// parsing of its answer, ranking/formatting for prompt injection and export.
// Storage lives in background/lessons.ts, the model call in
// background/agent/coach.ts, the wiring in background/sw.ts.
import type { LlmToolSpec } from "./llm";
import type { LogToolCall, LogTurnRecord } from "./logging";

/** chrome.storage.local key holding the per-profile lesson log. */
export const LESSONS_KEY = "baLessons";
/** Ring size — lessons are cheap and deduped, but unbounded growth is not. */
export const LESSONS_MAX = 300;

/** Hard caps on what one review may add, and on the shape of a lesson. */
export const LESSONS_PER_REVIEW_MAX = 6;
export const LESSON_TEXT_MAX_CHARS = 400;
export const LESSON_EVIDENCE_MAX_CHARS = 300;

/**
 * Prompt-injection budget. Lessons ride in a SEPARATE system block appended
 * after the cached base prompt, so this budget only bounds the uncached tail —
 * it must stay small enough to be negligible next to the base prompt.
 */
export const LESSON_PROMPT_MAX_ITEMS = 12;
export const LESSON_PROMPT_MAX_CHARS = 1_600;

/** Digest bounds — what the coach is allowed to see of a run. */
export const DIGEST_MAX_CHARS = 14_000;
const DIGEST_MAX_FAILURES = 12;
const DIGEST_FAILURE_CHARS = 320;
const DIGEST_MAX_TIMELINE = 40;
const DIGEST_SUMMARY_CHARS = 1_500;

export const LESSON_CATEGORIES = ["tool", "workflow", "site", "prompt", "other"] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

/** How the review was started: automatically at run end, or by the user. */
export type LessonSource = "auto" | "manual";

/** One learned lesson. */
export interface Lesson {
  id: string;
  /** When it was learned. */
  at: number;
  /** The task whose run produced it (context for the UI). */
  task: string;
  source: LessonSource;
  /** Run status at review time: done / stopped / error. */
  outcome: string;
  category: LessonCategory;
  /** The actionable one-liner the agent reads back. */
  text: string;
  /** What actually happened — the failure this came from. */
  evidence?: string;
  /** Tool the lesson is about, when it is tool-specific. */
  tool?: string;
  /** Site (hostname) the lesson is about, when it is site-specific. */
  host?: string;
  /** Pinned lessons always make the prompt block, however old they are. */
  pinned?: boolean;
  /** How many reviews have produced this same lesson (dedupe counter). */
  hits: number;
  /** Last run whose prompt carried it. */
  lastUsedAt?: number;
}

/** What the coach returns for one lesson, before it is stored. */
export interface LessonDraft {
  category: LessonCategory;
  text: string;
  evidence?: string;
  tool?: string;
  host?: string;
}

// ---- ids ----

let seq = 0;

/** Locally-unique, sortable id (no crypto dependency — usable in tests). */
export function newLessonId(): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `lesson_${Date.now().toString(36)}_${seq.toString(36)}_${rand}`;
}

// ---- normalization ----

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const t = collapse(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Dedupe key: wording- and punctuation-insensitive prefix of the lesson. */
export function lessonKey(text: string): string {
  return collapse(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 140);
}

const CATEGORY_ALIASES: Record<string, LessonCategory> = {
  tool: "tool",
  tools: "tool",
  tool_use: "tool",
  tooling: "tool",
  workflow: "workflow",
  process: "workflow",
  approach: "workflow",
  strategy: "workflow",
  site: "site",
  website: "site",
  domain: "site",
  page: "site",
  prompt: "prompt",
  instruction: "prompt",
  other: "other",
  general: "other",
  misc: "other",
};

export function normalizeCategory(raw: unknown): LessonCategory {
  if (typeof raw !== "string") return "other";
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  // Exact alias first, then the head of a compound ("site_specific" → "site").
  return (
    CATEGORY_ALIASES[key] ??
    CATEGORY_ALIASES[key.split("_")[0] ?? ""] ??
    "other"
  );
}

/** Reduce a URL/host string to a bare lowercase hostname. */
export function normalizeHost(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  const noScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = noScheme.split(/[/?#]/)[0] ?? "";
  const bare = host.replace(/^www\./, "").replace(/:\d+$/, "");
  return bare ? clip(bare, 80) : undefined;
}

/** Build the stored lesson from a validated draft plus run metadata. */
export function newLesson(
  draft: LessonDraft,
  meta: { task: string; source: LessonSource; outcome: string; at?: number },
): Lesson {
  return {
    id: newLessonId(),
    at: meta.at ?? Date.now(),
    task: clip(meta.task || "(untitled run)", 200),
    source: meta.source,
    outcome: meta.outcome,
    category: draft.category,
    text: clip(draft.text, LESSON_TEXT_MAX_CHARS),
    evidence: draft.evidence ? clip(draft.evidence, LESSON_EVIDENCE_MAX_CHARS) : undefined,
    tool: draft.tool ? clip(draft.tool, 40) : undefined,
    host: draft.host,
    hits: 1,
  };
}

/**
 * Merge freshly learned lessons into the stored ring. Newest first; a lesson
 * whose wording was already learned bumps `hits` instead of duplicating — and
 * keeps the STORED text, because the user may have edited it by hand.
 */
export function mergeLessons(
  all: Lesson[],
  incoming: Lesson[],
  max: number = LESSONS_MAX,
): { lessons: Lesson[]; added: number; merged: number } {
  const fresh: Lesson[] = [];
  let merged = 0;
  for (const lesson of incoming) {
    const key = lessonKey(lesson.text);
    // A lesson already on file (or already in this batch) is not duplicated.
    const existing = findLessonByKey(all, fresh, key);
    if (existing) {
      existing.hits += 1;
      // Evidence from the newest occurrence is the most concrete one.
      if (lesson.evidence) existing.evidence = lesson.evidence;
      merged += 1;
      continue;
    }
    fresh.push(lesson);
  }
  // New lessons lead, in the order the coach ranked them; the sort is stable,
  // so lessons learned in the same millisecond keep that order.
  const lessons = [...fresh, ...all].sort((a, b) => b.at - a.at);
  return { lessons: lessons.slice(0, max), added: fresh.length, merged };
}

function findLessonByKey(all: Lesson[], fresh: Lesson[], key: string): Lesson | undefined {
  return (
    all.find((l) => lessonKey(l.text) === key) ??
    fresh.find((l) => lessonKey(l.text) === key)
  );
}

// ---- reading a run ----

export interface FailedCall {
  name: string;
  args: string;
  error: string;
  count: number;
  tool?: LogToolCall;
}

function callArgText(call: LogToolCall): string {
  const args = collapse(call.args ?? "{}");
  return args.length > 120 ? `${args.slice(0, 119)}…` : args;
}

/** Every failed tool call in the run, with repeats collapsed into `count`. */
export function failedCalls(rec: LogTurnRecord): FailedCall[] {
  const out: FailedCall[] = [];
  for (const turn of rec.turns) {
    for (const call of turn.tools) {
      if (call.ok !== false) continue;
      const error = clip(call.result ?? "(no error text)", DIGEST_FAILURE_CHARS);
      const key = `${call.name}|${callArgText(call)}|${error}`;
      const existing = out.find((f) => `${f.name}|${f.args}|${f.error}` === key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      out.push({ name: call.name, args: callArgText(call), error, count: 1, tool: call });
    }
  }
  return out;
}

/** Failed calls that were attempted more than once — the agent looping. */
export function repeatedFailures(rec: LogTurnRecord): FailedCall[] {
  return failedCalls(rec).filter((f) => f.count > 1);
}

export interface ReviewTrigger {
  /** True when this run is worth a review. */
  review: boolean;
  /** Human-readable signals that made it worth reviewing. */
  reasons: string[];
}

/**
 * `stopped` is not a stored status: a run the user aborted (or that hit the
 * step budget) closes as `done` with a summary saying so — see loop.ts
 * `finish()`. The effective outcome is what a lesson should record.
 */
export function runWasStopped(rec: LogTurnRecord): boolean {
  const summary = [...rec.turns].reverse().find((t) => t.summary)?.summary ?? "";
  return /^stopped\b/i.test(summary.trim());
}

/** Outcome to record for a run: done / stopped / error. */
export function runOutcome(rec: LogTurnRecord): string {
  return runWasStopped(rec) ? "stopped" : rec.status;
}

/**
 * Should a finished run be reviewed automatically? Only runs that went wrong:
 * they carry the information worth learning from, and reviewing a clean run
 * would buy a model call per task for nothing. Pure — the caller adds the
 * user's settings and key checks.
 */
export function shouldAutoReview(rec: LogTurnRecord): ReviewTrigger {
  if (rec.status === "running") return { review: false, reasons: ["run is still open"] };
  if (!rec.turns.length) return { review: false, reasons: ["nothing was recorded"] };
  const reasons: string[] = [];
  if (rec.status === "error") reasons.push("the run ended with an error");
  if (runWasStopped(rec)) reasons.push("the run was stopped before finishing");
  const failed = failedCalls(rec);
  if (failed.length) reasons.push(`${failed.length} failed tool call(s)`);
  const repeated = repeatedFailures(rec);
  if (repeated.length) {
    const first = repeated[0]!;
    reasons.push(`'${first.name}' failed ${first.count}× with the same arguments (loop)`);
  }
  const errors = rec.turns.reduce((n, t) => n + t.errors.length, 0);
  if (errors && rec.status !== "error") reasons.push(`${errors} error event(s) mid-run`);
  return { review: reasons.length > 0, reasons };
}

/**
 * Compact, bounded transcript of a run for the coach: what was asked, how it
 * went, exactly which calls failed (with error text), any loops, and the final
 * answer. Pure and deterministic — no timestamps of its own.
 */
export function buildRunDigest(rec: LogTurnRecord): string {
  const lines: string[] = [];
  lines.push(`Task: ${clip(rec.task || "(untitled run)", 400)}`);
  const bits = [
    `outcome ${rec.status}`,
    `${rec.turns.length} step(s)`,
    `${rec.toolCalls} tool call(s)`,
  ];
  if (rec.durationMs !== undefined) bits.push(`${Math.round(rec.durationMs / 100) / 10}s`);
  if (rec.totalTokens !== undefined) bits.push(`${rec.totalTokens} tokens`);
  if (rec.resumed) bits.push("resumed after worker restart");
  lines.push(`Run: ${bits.join(" · ")}`);

  const failed = failedCalls(rec);
  if (failed.length) {
    lines.push("");
    lines.push(`Failures (${failed.length}):`);
    for (const f of failed.slice(0, DIGEST_MAX_FAILURES)) {
      const times = f.count > 1 ? ` — repeated ${f.count}×` : "";
      lines.push(`- ${f.name}(${f.args})${times}: ${f.error}`);
    }
    if (failed.length > DIGEST_MAX_FAILURES) {
      lines.push(`- …${failed.length - DIGEST_MAX_FAILURES} more failed call(s)`);
    }
  }

  const confirms = rec.turns.flatMap((t) =>
    t.confirmations.map((c) => `${c.tool}: ${clip(c.summary, 160)}`),
  );
  if (confirms.length) {
    lines.push("");
    lines.push("Confirmations requested:");
    for (const c of confirms.slice(0, 6)) lines.push(`- ${c}`);
  }

  const errors = rec.turns.flatMap((t) => t.errors.map((e) => clip(e.message, 240)));
  if (errors.length) {
    lines.push("");
    lines.push("Errors:");
    for (const e of errors.slice(0, 8)) lines.push(`- ${e}`);
  }

  lines.push("");
  lines.push("Steps:");
  let shown = 0;
  outer: for (const turn of rec.turns) {
    const calls = turn.tools.map((t) => {
      const status = t.ok === false ? "FAILED" : t.ok === true ? "ok" : "…";
      const fail = t.ok === false ? `: ${clip(t.result ?? "", 100)}` : "";
      const ms = t.durationMs !== undefined ? ` ${t.durationMs}ms` : "";
      return `${t.name} ${status}${fail}${ms}`;
    });
    const text = turn.text.trim() ? ` — said: ${clip(turn.text, 160)}` : "";
    const line = `- step ${turn.index + 1}: ${calls.length ? calls.join(", ") : "(no tools)"}${text}`;
    for (const chunk of wrapLine(line, 400)) {
      if (shown >= DIGEST_MAX_TIMELINE) {
        lines.push(`- …${rec.turns.length - turn.index - 1} more step(s)`);
        break outer;
      }
      lines.push(chunk);
      shown += 1;
    }
  }

  const finalText = [...rec.turns].reverse().find((t) => t.summary || t.text.trim());
  const answer = finalText?.summary?.trim() || finalText?.text.trim();
  if (answer) {
    lines.push("");
    lines.push(`Final answer: ${clip(answer, DIGEST_SUMMARY_CHARS)}`);
  }

  const out = lines.join("\n");
  return out.length > DIGEST_MAX_CHARS
    ? `${out.slice(0, DIGEST_MAX_CHARS)}\n…[digest truncated]`
    : out;
}

/** Soft-wrap a long digest line so the coach never reads one giant line. */
function wrapLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    out.push(rest.slice(0, max));
    rest = `  ${rest.slice(max)}`;
  }
  out.push(rest);
  return out;
}

// ---- parsing the coach's answer ----

/** The coach's only output channel: a tool call with the lessons it learned. */
export const LESSONS_TOOL_NAME = "record_lessons";
export const LESSONS_TOOL_SPEC: LlmToolSpec = {
  name: LESSONS_TOOL_NAME,
  description:
    "Record the durable lessons learned from this run. Call this exactly once with every lesson worth remembering, then stop.",
  parameters: {
    type: "object",
    properties: {
      lessons: {
        type: "array",
        description: `Up to ${LESSONS_PER_REVIEW_MAX} lessons. An empty array is a valid answer when the run taught nothing.`,
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description:
                "tool (how a tool must be called), workflow (approach/ordering), site (this website's quirks), prompt (misread instructions), other.",
            },
            text: {
              type: "string",
              description:
                "One imperative, reusable sentence telling the agent what to do next time. No run-specific ids or refs.",
            },
            evidence: {
              type: "string",
              description: "What actually happened — the concrete failure or success behind it.",
            },
            tool: { type: "string", description: "Tool name, when the lesson is tool-specific." },
            host: { type: "string", description: "Website hostname, when it is site-specific." },
          },
          required: ["text"],
        },
      },
    },
    required: ["lessons"],
  },
};

function tryJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Strip a fenced block, then fall back to the outermost object/array.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    trimmed,
    fenced?.[1]?.trim() ?? "",
    sliceBetween(trimmed, "{", "}"),
    sliceBetween(trimmed, "[", "]"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

function sliceBetween(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

function draftFrom(raw: unknown): LessonDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const text = typeof obj.text === "string" ? collapse(obj.text) : "";
  if (text.length < 8) return null;
  return {
    category: normalizeCategory(obj.category),
    text: clip(text, LESSON_TEXT_MAX_CHARS),
    evidence:
      typeof obj.evidence === "string" && obj.evidence.trim()
        ? clip(obj.evidence, LESSON_EVIDENCE_MAX_CHARS)
        : undefined,
    tool: typeof obj.tool === "string" && obj.tool.trim() ? clip(obj.tool, 40) : undefined,
    host: normalizeHost(obj.host),
  };
}

/**
 * Read lessons out of the coach's reply: a `record_lessons` tool call when the
 * provider emitted one, else strict-JSON-in-text (models that answer in prose
 * anyway). Anything unparseable yields no drafts and an error note — never a
 * fabricated lesson.
 */
export function parseLessonDrafts(input: {
  text?: string;
  toolArgs?: unknown;
}): { drafts: LessonDraft[]; errors: string[] } {
  const errors: string[] = [];
  const containers: unknown[] = [];
  if (input.toolArgs !== undefined) {
    const args = input.toolArgs;
    if (Array.isArray(args)) containers.push(args);
    else if (args && typeof args === "object") {
      const obj = args as Record<string, unknown>;
      containers.push(obj.lessons ?? obj.lesson ?? obj.items ?? obj);
    }
  }
  if (input.text) {
    const parsed = tryJson(input.text);
    if (Array.isArray(parsed)) containers.push(parsed);
    else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      containers.push(obj.lessons ?? obj.lesson ?? obj.items ?? obj);
    }
  }

  const drafts: LessonDraft[] = [];
  const seen = new Set<string>();
  for (const container of containers) {
    const list = Array.isArray(container) ? container : [container];
    for (const raw of list) {
      const draft = draftFrom(raw);
      if (!draft) {
        errors.push("skipped a lesson without usable text");
        continue;
      }
      const key = lessonKey(draft.text);
      if (seen.has(key)) continue;
      seen.add(key);
      drafts.push(draft);
      if (drafts.length >= LESSONS_PER_REVIEW_MAX) {
        if (list.length > LESSONS_PER_REVIEW_MAX) {
          errors.push(`kept the first ${LESSONS_PER_REVIEW_MAX} lessons`);
        }
        return { drafts, errors };
      }
    }
  }
  // Nothing usable anywhere: say so, so the caller can tell "taught nothing"
  // (a valid empty list) apart from "the reply was unreadable".
  if (!containers.length && input.text?.trim()) {
    errors.push("the reply carried no usable lesson list");
  }
  return { drafts, errors };
}

// ---- prompt injection ----

/**
 * Order lessons for a task: pinned first, then ones naming a host the task
 * mentions, then the most recent. Pure — the caller supplies the current task
 * text so a GitHub lesson surfaces on a GitHub task without any embedding call.
 */
export function rankLessonsForTask(
  lessons: Lesson[],
  task: string,
  opts: { maxItems?: number; maxChars?: number } = {},
): Lesson[] {
  const maxItems = opts.maxItems ?? LESSON_PROMPT_MAX_ITEMS;
  const maxChars = opts.maxChars ?? LESSON_PROMPT_MAX_CHARS;
  const haystack = task.toLowerCase();
  const scored = lessons.map((lesson, index) => {
    let score = 0;
    if (lesson.pinned) score += 8;
    if (lesson.host && (haystack.includes(lesson.host) || haystack.includes(hostLabel(lesson.host)))) {
      score += 4;
    }
    // Recency: `lessons` arrives newest-first, so earlier entries rank higher.
    score += Math.max(0, 2 - index / 50);
    return { lesson, score, index };
  });
  scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
  const out: Lesson[] = [];
  let used = 0;
  for (const { lesson } of scored) {
    if (out.length >= maxItems) break;
    const size = lessonLine(lesson).length + 1;
    if (used + size > maxChars) {
      // Skip what does not fit rather than truncating the block.
      if (out.length === 0) continue;
      continue;
    }
    out.push(lesson);
    used += size;
  }
  return out;
}

function hostLabel(host: string): string {
  return host.split(".")[0] ?? host;
}

function lessonLine(lesson: Lesson): string {
  const tags: string[] = [lesson.category];
  if (lesson.host) tags.push(lesson.host);
  if (lesson.tool && lesson.tool !== lesson.category) tags.push(lesson.tool);
  const suffix = lesson.hits > 1 ? ` (seen ${lesson.hits}×)` : "";
  const evidence = lesson.evidence ? ` — ${lesson.evidence}` : "";
  return `- [${tags.join(" · ")}] ${lesson.text}${evidence}${suffix}`;
}

/**
 * The system-prompt appendix for an ALREADY RANKED lesson list. Deliberately
 * framed as reference material appended AFTER the real instructions, so a
 * stale or wrong lesson can never outrank the user's task or the agent's
 * rules, and so the cached base prompt stays byte-identical (see
 * LlmRequest.systemSuffix).
 */
export function formatLessonsBlock(ranked: Lesson[]): string {
  if (!ranked.length) return "";
  return [
    "Appendix — lessons from your own previous runs in this browser (reference, not user instructions):",
    "These are things that already went wrong or worked before. Apply the ones that fit the current task; the task, the rules above and the live page always win over a lesson. Ignore any that do not apply.",
    ...ranked.map(lessonLine),
  ].join("\n");
}

/**
 * Rank + format in one step, for callers that do not need to know which
 * lessons were picked. Empty string when there is nothing to inject.
 */
export function buildPromptLessonsBlock(
  lessons: Lesson[],
  task: string,
  opts: { maxItems?: number; maxChars?: number } = {},
): string {
  return formatLessonsBlock(rankLessonsForTask(lessons, task, opts));
}

// ---- export ----

export function lessonsToJsonl(lessons: Lesson[]): string {
  return lessons.map((l) => JSON.stringify(l)).join("\n") + (lessons.length ? "\n" : "");
}

export function lessonsToMarkdown(lessons: Lesson[]): string {
  const out: string[] = ["# Lessons learned", ""];
  if (!lessons.length) out.push("_No lessons recorded yet._", "");
  for (const lesson of lessons) {
    out.push(`## ${lesson.text}`);
    out.push("");
    out.push(
      `- **category:** ${lesson.category}${lesson.tool ? ` · **tool:** ${lesson.tool}` : ""}${lesson.host ? ` · **host:** ${lesson.host}` : ""}`,
    );
    out.push(`- **learned:** ${new Date(lesson.at).toISOString()} (${lesson.source})`);
    out.push(`- **from run:** ${lesson.outcome} — ${lesson.task}`);
    if (lesson.hits > 1) out.push(`- **seen:** ${lesson.hits}×`);
    if (lesson.pinned) out.push("- **pinned:** yes");
    if (lesson.evidence) {
      out.push("");
      out.push(`> ${lesson.evidence}`);
    }
    out.push("");
  }
  return out.join("\n");
}