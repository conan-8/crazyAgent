// Structured run logging: every StepEvent the worker emits is also appended to
// an ordered, wall-clock-stamped log. Two consumers, one pure core:
//
//   * the worker appends live records to `chrome.storage.local` (survives SW
//     teardown and browser restarts — unlike the conversation store, which
//     keeps only the folded display view), and
//   * the panel renders a timeline and exports JSONL/Markdown to disk.
//
// Records are keyed per *turn* (one user message → one assistant run), so a
// thread reads as an ordered list of turns, each with its own start/end time,
// duration, tool calls with args+results, token usage and final answer.
import type { RunStats, StepEvent } from "./protocol";

export const LOG_KEY = "baRunLogs";
/** Ring size for the persisted log store (oldest runs evicted first). */
export const LOG_MAX_RUNS = 200;
/** Tool results are truncated to keep the log store small. */
export const LOG_RESULT_MAX_CHARS = 8_000;

/** One tool invocation with its (possibly not-yet-arrived) result. */
export interface LogToolCall {
  /** 0-based index within the turn, i.e. call order. */
  index: number;
  name: string;
  /** Madman mode display label, when decorated. */
  label?: string;
  args: string;
  at: number;
  /** Filled in by the matching tool_result. */
  result?: string;
  ok?: boolean;
  finishedAt?: number;
  /** Milliseconds the tool took, once its result landed. */
  durationMs?: number;
  /** Screenshot bytes are recorded as a marker, never inline (log size). */
  image?: boolean;
  truncated?: boolean;
  /** This call went through the Jev sidecar (the `judge` tool). */
  jev?: boolean;
}

/** Everything that happened inside one assistant turn, in arrival order. */
export interface LogTurn {
  /** 0-based index within the run/thread. */
  index: number;
  /** Provider generation for this turn, when the loop reported it. */
  generation?: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /** Visible assistant prose, concatenated across token_delta events. */
  text: string;
  /** Streamed reasoning ("thinking"), concatenated. */
  reasoning: string;
  tools: LogToolCall[];
  /** Madman-mode exclamations, kept as their own timestamped lines. */
  exclamations: { at: number; message: string }[];
  /** Sensitive actions that paused for user confirmation. */
  confirmations: {
    at: number;
    id: string;
    tool: string;
    summary: string;
    /** Jev raised this confirmation rather than the keyword rules. */
    jev?: boolean;
  }[];
  errors: { at: number; message: string }[];
  /** Final summary from the `done` event. */
  summary?: string;
  stats?: RunStats;
}

/** One logged user message: the task plus metadata, and the turns it spawned. */
export interface LogTurnRecord {
  id: string;
  conversationId?: string;
  /** The user's message that opened this turn. */
  task: string;
  attachments?: { name: string; kind: "image" | "text" }[];
  /** Stable correlation id, also used to match resumed runs. */
  runId: string;
  mode?: string;
  startedAt: number;
  updatedAt: number;
  /** `running` until a done/error event closes it, then `done`/`stopped`. */
  status: "running" | "done" | "error";
  turns: LogTurn[];
  /** Wall-clock totals for the whole record. */
  durationMs?: number;
  /** Sum of every tool call in the record. */
  toolCalls: number;
  totalTokens?: number;
  /** True when this record was reopened after a service-worker resume. */
  resumed?: boolean;
}

let seq = 0;
/** Locally-unique, sortable id (no crypto dependency — usable in tests). */
function newId(prefix: string): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${rand}`;
}

export function newTurnRecord(
  task: string,
  opts: {
    conversationId?: string;
    mode?: string;
    attachments?: { name: string; kind: "image" | "text" }[];
    at?: number;
  } = {},
): LogTurnRecord {
  const at = opts.at ?? Date.now();
  return {
    id: newId("log"),
    conversationId: opts.conversationId,
    task,
    attachments: opts.attachments?.length ? opts.attachments : undefined,
    runId: newId("run"),
    mode: opts.mode,
    startedAt: at,
    updatedAt: at,
    status: "running",
    turns: [],
    toolCalls: 0,
  };
}

function currentTurn(rec: LogTurnRecord, at: number): LogTurn {
  const last = rec.turns[rec.turns.length - 1];
  // Reuse the open turn; a closed one (step boundary / done / error) starts a
  // new turn so each step's prose and tools stay grouped under their own step.
  if (last && last.endedAt === undefined) return last;
  const turn: LogTurn = {
    index: rec.turns.length,
    startedAt: at,
    text: "",
    reasoning: "",
    tools: [],
    exclamations: [],
    confirmations: [],
    errors: [],
  };
  rec.turns.push(turn);
  return turn;
}

function closeTurn(turn: LogTurn, at: number): void {
  turn.endedAt = at;
  turn.durationMs = Math.max(0, at - turn.startedAt);
}

/** Append one StepEvent to a record. Pure apart from `at` defaulting to now. */
export function foldLogEvent(
  rec: LogTurnRecord,
  e: StepEvent,
  at: number = Date.now(),
): void {
  rec.updatedAt = at;
  switch (e.kind) {
    case "step_started": {
      // A step boundary opens the next turn only once the previous one has
      // content; otherwise the opening step would create an empty turn.
      const last = rec.turns[rec.turns.length - 1];
      if (last && (last.text || last.reasoning || last.tools.length)) {
        closeTurn(last, at);
      }
      const turn = currentTurn(rec, at);
      turn.generation = e.stepIndex;
      break;
    }
    case "token_delta":
      currentTurn(rec, at).text += e.text;
      break;
    case "reasoning_delta":
      currentTurn(rec, at).reasoning += e.text;
      break;
    case "tool_call": {
      const turn = currentTurn(rec, at);
      turn.tools.push({
        index: turn.tools.length,
        name: e.name,
        label: e.label,
        args: safeJson(e.args),
        at,
        jev: e.jev === true ? true : undefined,
      });
      rec.toolCalls += 1;
      break;
    }
    case "tool_result": {
      // Results arrive in call order: fill the first unfilled call.
      const turn = currentTurn(rec, at);
      const call = turn.tools.find((t) => t.ok === undefined && t.result === undefined);
      if (call) {
        const full = e.result ?? "";
        call.truncated = full.length > LOG_RESULT_MAX_CHARS;
        call.result = call.truncated
          ? `${full.slice(0, LOG_RESULT_MAX_CHARS)}…[truncated ${full.length - LOG_RESULT_MAX_CHARS} chars]`
          : full;
        call.ok = e.ok;
        call.finishedAt = at;
        call.durationMs = Math.max(0, at - call.at);
        if (e.image) call.image = true;
      }
      break;
    }
    case "madman":
      currentTurn(rec, at).exclamations.push({ at, message: e.message });
      break;
    case "need_confirm":
      currentTurn(rec, at).confirmations.push({
        at,
        id: e.id,
        tool: e.tool,
        summary: e.summary,
        jev: e.jev === true ? true : undefined,
      });
      break;
    case "error": {
      const turn = currentTurn(rec, at);
      turn.errors.push({ at, message: e.message });
      closeTurn(turn, at);
      rec.status = "error";
      rec.durationMs = Math.max(0, at - rec.startedAt);
      break;
    }
    case "done": {
      const turn = currentTurn(rec, at);
      turn.summary = e.summary;
      if (e.stats) {
        turn.stats = e.stats;
        rec.totalTokens = (rec.totalTokens ?? 0) + e.stats.totalTokens;
      }
      closeTurn(turn, at);
      rec.status = "done";
      rec.durationMs = Math.max(0, at - rec.startedAt);
      break;
    }
    case "info":
    case "usage":
      // Activity/telemetry noise: the panel shows it live, the log skips it
      // (token totals already arrive on `done`).
      break;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

/** Append a record to the ring, replacing an existing one with the same id. */
export function appendRecord(
  all: LogTurnRecord[],
  rec: LogTurnRecord,
  max: number = LOG_MAX_RUNS,
): LogTurnRecord[] {
  const without = all.filter((r) => r.id !== rec.id);
  return [rec, ...without]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, max);
}

/** Find the still-open record to attach a resumed run to, if any. */
export function findResumable(
  all: LogTurnRecord[],
  conversationId: string | undefined,
): LogTurnRecord | null {
  if (!conversationId) return null;
  const open = all.find(
    (r) => r.conversationId === conversationId && r.status === "running",
  );
  return open ?? null;
}

// ---- export formats -------------------------------------------------------

export interface LogSummary {
  id: string;
  task: string;
  conversationId?: string;
  startedAt: number;
  updatedAt: number;
  status: LogTurnRecord["status"];
  turns: number;
  toolCalls: number;
  durationMs?: number;
  totalTokens?: number;
}

export function summarizeRecord(rec: LogTurnRecord): LogSummary {
  return {
    id: rec.id,
    task: rec.task,
    conversationId: rec.conversationId,
    startedAt: rec.startedAt,
    updatedAt: rec.updatedAt,
    status: rec.status,
    turns: rec.turns.length,
    toolCalls: rec.toolCalls,
    durationMs: rec.durationMs,
    totalTokens: rec.totalTokens,
  };
}

/** ISO timestamp without relying on a timezone-specific formatting locale. */
export function iso(ts: number | undefined): string {
  return ts === undefined ? "" : new Date(ts).toISOString();
}

/** One JSONL line per record — the archival format (append-friendly). */
export function toJsonl(records: LogTurnRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1_000) return `${ms}ms`;
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

/** Human-readable transcript: turns in order, tools nested with timings. */
export function toMarkdown(records: LogTurnRecord[]): string {
  const out: string[] = [];
  for (const rec of records) {
    out.push(`# ${rec.task || "(untitled run)"}`);
    out.push("");
    out.push(`- **id:** \`${rec.id}\``);
    if (rec.conversationId) out.push(`- **conversation:** \`${rec.conversationId}\``);
    if (rec.mode) out.push(`- **mode:** ${rec.mode}`);
    out.push(`- **status:** ${rec.status}`);
    out.push(`- **started:** ${iso(rec.startedAt)}`);
    out.push(`- **updated:** ${iso(rec.updatedAt)}`);
    out.push(`- **duration:** ${fmtDuration(rec.durationMs)}`);
    out.push(`- **turns:** ${rec.turns.length} · **tool calls:** ${rec.toolCalls}`);
    if (rec.totalTokens !== undefined) out.push(`- **tokens:** ${rec.totalTokens}`);
    if (rec.attachments?.length) {
      out.push(
        `- **attachments:** ${rec.attachments.map((a) => `${a.name} (${a.kind})`).join(", ")}`,
      );
    }
    out.push("");
    for (const turn of rec.turns) {
      out.push(
        `## Turn ${turn.index + 1} — ${iso(turn.startedAt)} (${fmtDuration(turn.durationMs)})`,
      );
      out.push("");
      if (turn.reasoning.trim()) {
        out.push("<details><summary>reasoning</summary>");
        out.push("");
        out.push("```text");
        out.push(turn.reasoning.trim());
        out.push("```");
        out.push("");
        out.push("</details>");
        out.push("");
      }
      for (const ex of turn.exclamations) {
        out.push(`> ${iso(ex.at)} — ${ex.message}`);
      }
      if (turn.exclamations.length) out.push("");
      for (const call of turn.tools) {
        const status = call.ok === false ? "✗" : call.ok === true ? "✓" : "…";
        // Jev provenance is recorded, not inferred — it survives export.
        const via = call.jev ? " · via Jev" : "";
        out.push(
          `- **${status} ${call.name}** (call ${call.index + 1}, ${iso(call.at)}, ${fmtDuration(call.durationMs)}${via})`,
        );
        out.push("  - args: `" + call.args.replace(/`/g, "\\`") + "`");
        if (call.result !== undefined) {
          out.push("  - result:");
          out.push("");
          out.push("    ```text");
          for (const line of call.result.split("\n")) out.push(`    ${line}`);
          out.push("    ```");
        }
        if (call.image) out.push("  - image: [screenshot captured]");
        out.push("");
      }
      for (const c of turn.confirmations) {
        const via = c.jev ? "Jev" : "rules";
        out.push(
          `- ⚠ confirmation requested at ${iso(c.at)} (${via}): ${c.tool} — ${c.summary}`,
        );
      }
      for (const err of turn.errors) {
        out.push(`- ⚠ error at ${iso(err.at)}: ${err.message}`);
      }
      if (turn.text.trim()) {
        out.push("");
        out.push(turn.text.trim());
      }
      if (turn.summary && turn.summary !== turn.text.trim()) {
        out.push("");
        out.push(`**Summary:** ${turn.summary}`);
      }
      if (turn.stats) {
        out.push("");
        out.push(
          `_stats: ${turn.stats.steps} steps · ${turn.stats.totalTokens} tokens (${turn.stats.outputTokens} out) · ${turn.stats.tokensPerSec.toFixed(1)} tok/s · context ${turn.stats.contextTokens}/${turn.stats.contextWindow}_`,
        );
      }
      out.push("");
    }
    out.push("---");
    out.push("");
  }
  return out.join("\n");
}