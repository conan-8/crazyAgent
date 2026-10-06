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
import type { RunStats, StepEvent, TodoItem } from "./protocol";

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
  /** Size of the attached image data URL in chars (~bytes) — the memory
   *  math a crash post-mortem needs; the bytes themselves never ride along. */
  imageBytes?: number;
  truncated?: boolean;
  /** This call went through the Jev sidecar (the `judge` tool). */
  jev?: boolean;
  /** The Jev risk layer checked this mutating action and allowed it. */
  jevGate?: boolean;
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
  /**
   * Human handoffs — sign-in walls and CAPTCHAs where the run paused for the
   * user. Optional: records archived before this field existed have none.
   */
  handoffs?: {
    at: number;
    id: string;
    reason: string;
    url: string;
    /** True when the user reported they handled it (vs. skipping). */
    handled?: boolean;
  }[];
  errors: { at: number; message: string }[];
  /**
   * Every `info` event of this turn, timestamped: LLM retries ("LLM call
   * failed — retrying…"), checkpoint resumes, reasoning-cap cuts, the
   * usage-silence note. These used to be dropped as telemetry noise — which
   * is why "the panel said API failed a few times, why?" was unanswerable
   * from the export. Jev notes keep their flag for the pink rendering;
   * `progress_note` events fold here too (flagged) — the run's narration.
   */
  notes?: { at: number; message: string; jev?: boolean; progress?: boolean }[];
  /**
   * Per-turn token usage (last `usage` event of the turn). The context
   * number is the growth curve that explains a run getting slower — and the
   * pressure that precedes an OOM death.
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    contextTokens: number;
    contextWindow: number;
    cachedInputTokens?: number;
  };
  /**
   * Jev sidecar notes (effort routing grade, fallback) — kept for records
   * archived before `notes` existed; new records fold Jev info into `notes`.
   */
  jevNotes?: { at: number; message: string }[];
  /** Final summary from the `done` event. */
  summary?: string;
  stats?: RunStats;
  /**
   * LLM timing split for this turn, when the loop measured it: time to first
   * streamed token (prefill/queue) and first token → stream end (decode).
   * Optional: records archived before this field existed have neither.
   */
  ttftMs?: number;
  decodeMs?: number;
  /**
   * The EFFECTIVE thinking level this turn was sent with (after adaptive
   * lowering / Jev effort routing). The verification rig for routing:
   * reasoning chars vs this field proves the payoff — and exposes a gateway
   * that silently ignores the knob (level "off" + reasoning chars > 0).
   */
  thinking?: string;
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
  /**
   * Provider wire and model this run used. Recorded because an exported log
   * was previously unattributable: per-step latency and cache behaviour are
   * properties of the endpoint, and "why was this run slow?" is unanswerable
   * without knowing which one it ran against.
   */
  provider?: string;
  model?: string;
  /**
   * The extension build that produced this record (manifest `version_name`,
   * e.g. "0.1.0 (c4e25b7)"). An exported log used to be unattributable to a
   * build — "did this run have the auto-screenshot fix?" was unanswerable.
   */
  build?: string;
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
  /**
   * True when the provider never reported usage and the token numbers are the
   * loop's own estimate. Estimates are labelled in every rendering so they are
   * never mistaken for provider truth.
   */
  tokensEstimated?: boolean;
  /** True when this record was reopened after a service-worker resume. */
  resumed?: boolean;
  /**
   * Checkpoint health pulses (one per step save): the worker's carried
   * state over time. On a silent service-worker death — the record stays
   * `running` with a half-written last turn and no error — the tail of this
   * trace is the crash evidence: flat sizes point elsewhere, climbing
   * imageBytes/historyChars point at memory.
   */
  heartbeats?: {
    at: number;
    step: number;
    historyChars: number;
    images: number;
    imageBytes: number;
  }[];
  /**
   * The agent's live plan — the LATEST `todo_update` snapshot (whole-list
   * replacement semantics, so last write wins). Optional: records archived
   * before the plan dropdown existed have none.
   */
  todos?: TodoItem[];
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
    provider?: string;
    model?: string;
    build?: string;
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
    provider: opts.provider,
    model: opts.model,
    build: opts.build,
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
    case "turn_timing": {
      // Last write wins (one event per step; the turn it lands in is the
      // current open one by construction).
      const turn = currentTurn(rec, at);
      if (e.ttftMs !== undefined) turn.ttftMs = e.ttftMs;
      if (e.decodeMs !== undefined) turn.decodeMs = e.decodeMs;
      if (e.thinking !== undefined) turn.thinking = e.thinking;
      break;
    }
    case "llm_request_sent":
      // Live-UI telemetry: the turn_timing event carries the measured result.
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
        if (e.image) {
          call.image = true;
          call.imageBytes = e.image.length;
        }
        call.jevGate = e.jevGate === true ? true : undefined;
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
    case "need_human": {
      const turn = currentTurn(rec, at);
      turn.handoffs = turn.handoffs ?? [];
      turn.handoffs.push({ at, id: e.id, reason: e.reason, url: e.url });
      break;
    }
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
        // Once any step had to estimate, the whole total is an estimate —
        // label it so a reader never trusts it as provider-reported.
        if (e.stats.usageEstimated) rec.tokensEstimated = true;
      }
      closeTurn(turn, at);
      rec.status = "done";
      rec.durationMs = Math.max(0, at - rec.startedAt);
      break;
    }
    case "info": {
      // EVERY info event is kept: LLM retries, checkpoint resumes,
      // reasoning-cap cuts, usage-silence notes. They used to be dropped
      // unless Jev-flagged — which is why "the panel showed API failures,
      // why?" was unanswerable from the export. Jev keeps its flag (and its
      // legacy field) for the pink rendering.
      const turn = currentTurn(rec, at);
      turn.notes = turn.notes ?? [];
      turn.notes.push({ at, message: e.message, jev: e.jev === true ? true : undefined });
      if (e.jev === true) {
        turn.jevNotes = turn.jevNotes ?? [];
        turn.jevNotes.push({ at, message: e.message });
      }
      break;
    }
    case "usage": {
      // The per-turn context number is the growth curve that explains a run
      // slowing down — and the pressure that precedes an OOM death. Cheap to
      // keep (five numbers per turn); the totals still arrive on `done`.
      const turn = currentTurn(rec, at);
      turn.usage = {
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        contextTokens: e.contextTokens,
        contextWindow: e.contextWindow,
        ...(e.cachedInputTokens !== undefined ? { cachedInputTokens: e.cachedInputTokens } : {}),
      };
      break;
    }
    case "heartbeat": {
      rec.heartbeats = rec.heartbeats ?? [];
      rec.heartbeats.push({
        at,
        step: e.stepIndex,
        historyChars: e.historyChars,
        images: e.images,
        imageBytes: e.imageBytes,
      });
      break;
    }
    case "todo_update":
      // Whole-list replacement: the newest snapshot IS the plan's final state.
      rec.todos = e.items;
      break;
    case "progress_note": {
      // The model's narration rides the same per-turn notes list as info
      // events (flagged, so exports and the panel can render it distinctly).
      const turn = currentTurn(rec, at);
      turn.notes = turn.notes ?? [];
      turn.notes.push({ at, message: e.text, progress: true });
      break;
    }
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

/** Compact byte size for the heartbeat trace. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
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
    if (rec.provider) out.push(`- **provider:** ${rec.provider}`);
    if (rec.model) out.push(`- **model:** ${rec.model}`);
    if (rec.build) out.push(`- **build:** ${rec.build}`);
    out.push(
      `- **status:** ${rec.status}${rec.resumed ? " (resumed after a service-worker restart)" : ""}${rec.status === "running" ? " — never closed: the worker died mid-run or the export caught it live" : ""}`,
    );
    out.push(`- **started:** ${iso(rec.startedAt)}`);
    out.push(`- **updated:** ${iso(rec.updatedAt)}`);
    out.push(`- **duration:** ${fmtDuration(rec.durationMs)}`);
    out.push(`- **turns:** ${rec.turns.length} · **tool calls:** ${rec.toolCalls}`);
    if (rec.totalTokens !== undefined) {
      out.push(
        `- **tokens:** ${rec.totalTokens}${rec.tokensEstimated ? " (estimated — the provider reported no usage)" : ""}`,
      );
    }
    if (rec.attachments?.length) {
      out.push(
        `- **attachments:** ${rec.attachments.map((a) => `${a.name} (${a.kind})`).join(", ")}`,
      );
    }
    // The plan's final state (last todo_write snapshot) — what the run ended
    // up doing, at a glance, without reading every turn.
    if (rec.todos?.length) {
      out.push("");
      out.push("**Plan (final state):**");
      out.push("");
      for (const t of rec.todos) {
        const mark =
          t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
        out.push(`- ${mark} ${t.content}`);
      }
    }
    out.push("");
    for (const turn of rec.turns) {
      out.push(
        `## Turn ${turn.index + 1} — ${iso(turn.startedAt)} (${fmtDuration(turn.durationMs)})`,
      );
      out.push("");
      // The timing split explains the duration: TTFT is what the caller waited
      // before anything streamed (prefill/queue), decode is generation. The
      // thinking level is the effort-routing verification rig.
      if (turn.ttftMs !== undefined || turn.decodeMs !== undefined || turn.thinking) {
        out.push(
          `_timing: ttft ${fmtDuration(turn.ttftMs)} · decode ${fmtDuration(turn.decodeMs)}${turn.thinking ? ` · thinking ${turn.thinking}` : ""}_`,
        );
      }
      if (turn.usage) {
        const u = turn.usage;
        const cached =
          u.cachedInputTokens !== undefined
            ? ` · cached ${u.cachedInputTokens.toLocaleString()}`
            : "";
        out.push(
          `_usage: context ${u.contextTokens.toLocaleString()}/${u.contextWindow.toLocaleString()} · in ${u.inputTokens.toLocaleString()} · out ${u.outputTokens.toLocaleString()}${cached}_`,
        );
      }
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
        const via = call.jev ? " · via Jev" : call.jevGate ? " · jev checked" : "";
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
        if (call.image) {
          const kb = call.imageBytes ? `, ${(call.imageBytes / 1024).toFixed(0)}KB base64` : "";
          out.push(`  - image: [screenshot attached${kb}]`);
        }
        out.push("");
      }
      for (const c of turn.confirmations) {
        const via = c.jev ? "Jev" : "rules";
        out.push(
          `- ⚠ confirmation requested at ${iso(c.at)} (${via}): ${c.tool} — ${c.summary}`,
        );
      }
      // New records keep every info event in `notes`; `jevNotes` renders only
      // for archives from before notes existed.
      if (turn.notes) {
        for (const n of turn.notes) {
          out.push(
            `- ${n.progress ? "📣 **Progress**" : n.jev ? "🧠 **Jev**" : "ℹ️ note"} at ${iso(n.at)}: ${n.message}`,
          );
        }
      } else {
        for (const n of turn.jevNotes ?? []) {
          out.push(`- 🧠 **Jev** at ${iso(n.at)}: ${n.message}`);
        }
      }
      for (const h of turn.handoffs ?? []) {
        out.push(
          `- 🖐 human handoff at ${iso(h.at)}: ${h.reason} — ${h.url}${h.handled ? " (user handled it)" : ""}`,
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
        const est = turn.stats.usageEstimated ? " (estimated)" : "";
        out.push(
          `_stats: ${turn.stats.steps} steps · ${turn.stats.totalTokens} tokens${est} (${turn.stats.outputTokens} out) · ${turn.stats.tokensPerSec.toFixed(1)} tok/s · context ${turn.stats.contextTokens}/${turn.stats.contextWindow}_`,
        );
        // Cache + prefix are what explain wall-clock: a step that re-prefills
        // its whole ~8k-token prefix pays for it on every round trip. Rendered
        // only when the provider actually reported a cache number.
        const cached = turn.stats.cachedInputTokens;
        if (cached !== undefined) {
          const pct = turn.stats.inputTokens
            ? Math.round((100 * cached) / turn.stats.inputTokens)
            : 0;
          out.push(
            `_cache: ${cached} of ${turn.stats.inputTokens} input tokens served from cache (${pct}%)_`,
          );
        }
        if (turn.stats.prefixTokens) {
          const floor = turn.stats.prefixTokens * turn.stats.steps;
          out.push(
            `_prefix: ${turn.stats.prefixTokens} tokens re-sent per step × ${turn.stats.steps} steps = ${floor} tokens of fixed cost_`,
          );
        }
        if (turn.stats.effortApplied || turn.stats.effortRaised || turn.stats.effortDropped) {
          out.push(
            `_effort routing: ${turn.stats.effortApplied ?? 0} step(s) lowered · ${turn.stats.effortRaised ?? 0} raised · ${turn.stats.effortDropped ?? 0} hint(s) dropped by a surprise_`,
          );
        }
      }
      out.push("");
    }
    // The checkpoint growth trace: one line of totals, and on a run that
    // never closed (silent worker death) the last few pulses verbatim — the
    // only evidence of what the worker was carrying when it died.
    const hbs = rec.heartbeats ?? [];
    if (hbs.length) {
      const first = hbs[0]!;
      const last = hbs[hbs.length - 1]!;
      const maxImg = hbs.reduce((m, h) => Math.max(m, h.imageBytes), 0);
      const maxHist = hbs.reduce((m, h) => Math.max(m, h.historyChars), 0);
      out.push(
        `_heartbeats: ${hbs.length} checkpoint saves · history ${fmtBytes(first.historyChars)}→${fmtBytes(last.historyChars)} (max ${fmtBytes(maxHist)}) · images ${first.images}→${last.images} (max ${fmtBytes(maxImg)})_`,
      );
      if (rec.status === "running") {
        out.push("");
        out.push("_last pulses before the worker died:_");
        for (const h of hbs.slice(-5)) {
          out.push(
            `- step ${h.step} at ${iso(h.at)}: history ${fmtBytes(h.historyChars)}, ${h.images} image(s) ${fmtBytes(h.imageBytes)}`,
          );
        }
      }
      out.push("");
    }
    out.push("---");
    out.push("");
  }
  return out.join("\n");
}