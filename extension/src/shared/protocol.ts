// Shared wire types between the side panel, service worker, content scripts
// and (Phase 7) the native-messaging helper daemon. This file is the single
// cross-boundary contract for the extension.

export const PORT_NAME = "panel";

export type ControlMode = "standard" | "unlimited";

/** Run-log export encodings: JSON Lines for tooling, Markdown for reading. */
export type LogExportFormat = "jsonl" | "md";

import type { LlmMessage, LlmToolSpec, UpstreamInfo } from "./llm";
import type { Conversation, ConversationSummary } from "./chat";
import type { LogSummary, LogTurnRecord } from "./logging";
import type { Lesson, LessonCategory } from "./lessons";
import type { Skill } from "./skills";
export type { LlmMessage };
export type { Conversation, ConversationSummary };
export type { LogSummary, LogTurnRecord };
export type { Lesson, LessonCategory };
export type { Skill };

/** Parameters for the Phase 1 demo/echo task (also the mock harness hook). */
export interface DemoConfig {
  steps: number;
  intervalMs: number;
}

export interface RunAttachment {
  name: string;
  kind: "image" | "text";
  /** Data URL for images, raw content for text. */
  data: string;
}

/** Persisted after every step so a killed service worker can resume the run. */
export interface Checkpoint {
  task: string;
  mode: ControlMode;
  demo?: DemoConfig;
  /** Chat thread this run belongs to (history + follow-up context). */
  conversationId?: string;
  /**
   * The tab the agent is working on. Tool calls target this tab (not
   * "whatever happens to be focused"), and a resumed run picks the task back
   * up on the same page instead of an unrelated active tab.
   */
  tabId?: number;
  /**
   * The agent's own window. Window ids only mean anything inside one browser
   * session — which is exactly the lifetime of a checkpoint (session storage)
   * — and it lets a resume re-open the window when the user closed it. Absent
   * on checkpoints written before agent windows existed.
   */
  windowId?: number;
  /**
   * Per-run "look outside" grant: the user allowed READ-ONLY access to their
   * other windows' tabs for this task. Acting outside the agent window stays
   * impossible either way.
   */
  allowOutside?: boolean;
  stepIndex: number;
  messages: LlmMessage[];
  /** LLM tool specs frozen at run start (kept for faithful resume). */
  toolSpecs?: LlmToolSpec[];
  /**
   * The run's live todo list (last `todo_write` snapshot). Persisted so a
   * resumed run — or a panel reopened mid-run — restores the plan dropdown
   * without waiting for the model's next update.
   */
  todos?: TodoItem[];
  startedAt: number;
  updatedAt: number;
  done: boolean;
}

/** One entry of the agent's live plan (see the `todo_write` tool). */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/**
 * `blocked` exists because the failure ladder already tells the model to "mark
 * its todo item blocked" when a step is genuinely impossible — and until now
 * there was no such status, so the only honest move was to give up on the
 * whole run (run D quit at 12/32 with 19 items open, and the harness accepted
 * it as `done`). A blocked item is a COMPLETED decision: the run may end with
 * blocked items, never with silently abandoned ones.
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

/** Items that still owe the user something: not done, not declared impossible. */
export function openTodos(items: TodoItem[] | undefined): TodoItem[] {
  return (items ?? []).filter((t) => t.status === "pending" || t.status === "in_progress");
}

export type StepEvent =
  | {
      kind: "info";
      message: string;
      /**
       * This note is about the Jev sidecar (effort routing, fallback). The
       * panel folds it into a pink `Jev` note and the run log keeps it —
       * generic info stays transient.
       */
      jev?: boolean;
    }
  | { kind: "step_started"; stepIndex: number }
  | {
      kind: "tool_call";
      stepIndex: number;
      name: string;
      args: unknown;
      /** Madman mode: cuss-decorated display label for the tool card. */
      label?: string;
      /**
       * Jev sidecar: this call went through Jev (the `judge` tool). The panel
       * tints the card bright pink so a Jev-assisted step is visible at a
       * glance. Set from the tool name at emission time, not by the model.
       */
      jev?: boolean;
    }
  /** Madman mode: a mid-run exclamation shown between tool cards. */
  | { kind: "madman"; message: string }
  /**
   * The agent's live plan changed (whole-list replacement from `todo_write`).
   * The panel renders it as the dropdown at the top of the sidebar; the list
   * is always the COMPLETE current plan, never a delta.
   */
  | { kind: "todo_update"; items: TodoItem[] }
  /**
   * A concise progress report from the model between action sequences
   * (`progress_note`): what just landed, what comes next. The panel renders
   * it as a distinct bubble — the run's narration channel, replacing
   * per-action prose turns.
   */
  | { kind: "progress_note"; text: string }
  | {
      kind: "tool_result";
      stepIndex: number;
      name: string;
      result: string;
      ok: boolean;
      /** Screenshot thumbnail (data URL) for the panel viewer. */
      image?: string;
      /**
       * The Jev risk layer checked this mutating action and allowed it. The
       * panel marks the card with a small pink accent so silent risk checks
       * are visible; set by the executor, not by the model.
       */
      jevGate?: boolean;
      /**
       * Per-step effort routing (Jev Tier 1): the gate's verdict on how much
       * deliberation the NEXT decision needs, and on whether this action is
       * making progress. Rode the risk POST — zero extra round trips. The
       * loop consumes both once (next step) and drops them on any surprise.
       */
      jevEffort?: { choice: string; confidence: number };
      jevProgress?: { choice: string; confidence: number };
    }
  /** Live run statistics for the composer's stats bar. */
  | {
      kind: "usage";
      totalTokens: number;
      outputTokens: number;
      inputTokens: number;
      tokensPerSec: number;
      contextTokens: number;
      contextWindow: number;
      elapsedMs: number;
      /** Provider-reported prompt-cache read, when the endpoint reports one. */
      cachedInputTokens?: number;
    }
  /**
   * The step's LLM request just went on the wire (after checkpoint save,
   * history truncation and request build). The panel uses it to replace the
   * vague "Deciding next step" with what is actually happening — sending N
   * tokens, then waiting on the provider — and the first streamed delta of
   * the step ends the window. The log skips it (the turn_timing event that
   * follows carries the measured numbers).
   */
  | { kind: "llm_request_sent"; stepIndex: number; contextTokens: number }
  | { kind: "token_delta"; text: string }
  /** Streamed model reasoning ("thinking"); rendered in a collapsed block. */
  | { kind: "reasoning_delta"; text: string }
  /**
   * Per-step LLM timing split, emitted once per turn after the reply lands:
   * `ttftMs` is request-send → first streamed token (reasoning or text) —
   * the prefill/queue cost the caller waits in the "Deciding next step"
   * window — and `decodeMs` is first token → stream end. Together they say
   * whether a slow run is paying for input tokens (TTFT) or generated tokens
   * (decode), which no wall-clock duration can distinguish. The panel does
   * not render this; the run log and exports keep it.
   */
  | {
      kind: "turn_timing";
      stepIndex: number;
      ttftMs?: number;
      decodeMs?: number;
      reasoningChars: number;
      /**
       * The EFFECTIVE thinking level this step was sent with (after adaptive
       * lowering / Jev effort routing). The verification rig for routing:
       * reasoning chars per step vs this field is how the payoff is measured
       * — and how a gateway that silently ignores the knob is exposed.
       */
      thinking?: string;
      /** Who served the reply and how clean its stream was. */
      upstream?: UpstreamInfo;
      /** Calls dropped before execution (and before history) as malformed. */
      malformed?: MalformedCall[];
    }
  /**
   * Checkpoint health pulse, emitted after each per-step checkpoint save:
   * how much state the worker is carrying (history text chars, live image
   * count and bytes). The run log keeps these as a growth trace — when a
   * service worker dies silently (the record stays `running`, no error is
   * ever written), the last heartbeats are the only evidence of whether
   * memory was the cause. Sizes are deliberately approximate (string-length
   * sums, no re-serialization: measuring must not recreate the churn it
   * diagnoses).
   */
  | {
      kind: "heartbeat";
      stepIndex: number;
      historyChars: number;
      images: number;
      imageBytes: number;
    }
  | { kind: "need_confirm"; id: string; tool: string; summary: string; jev?: boolean }
  /**
   * Human handoff: a sign-in or CAPTCHA wall the agent must not fake its way
   * past. The run pauses until the user takes over — or says to continue.
   */
  | { kind: "need_human"; id: string; reason: string; url: string }
  /** `stats` are the final numbers, so the bar survives the run ending. */
  | { kind: "done"; summary: string; stats?: RunStats; outcome?: RunOutcome }
  | { kind: "error"; message: string };

/**
 * How a run ended. A user stop used to close as plain `done`, which made a
 * run the user aborted indistinguishable from one that finished.
 */
export type RunOutcome = "completed" | "stopped_by_user" | "capped" | "interrupted" | "error";

/** A tool call the harness refused to execute or keep, with the raw wire text. */
export interface MalformedCall {
  name: string;
  reason: string;
  /** Raw argument text as it arrived, clipped. */
  raw: string;
}

/** Cumulative numbers for one agent run. */
export interface RunStats {
  steps: number;
  totalTokens: number;
  outputTokens: number;
  inputTokens: number;
  tokensPerSec: number;
  contextTokens: number;
  contextWindow: number;
  elapsedMs: number;
  /** Reasoning tokens/text reported by the provider, when thinking was on. */
  reasoningChars?: number;
  /**
   * Jev per-step effort routing observability: how many steps a hint was
   * APPLIED to (lowered), how many it RAISED back toward the ceiling, and
   * how many were DROPPED by a surprise before use. The numbers that show
   * whether Tier 1 is paying or flapping.
   */
  effortApplied?: number;
  effortRaised?: number;
  effortDropped?: number;
  /**
   * The slice of `inputTokens` the provider served from its prompt cache.
   * This is the number that explains per-step latency: a cached prefix costs
   * no re-prefill, an uncached one re-reads the whole prompt. Undefined means
   * the provider never reported it — never "the cache missed".
   */
  cachedInputTokens?: number;
  /**
   * The fixed request prefix this run re-sent on every step: system prompt +
   * tool specs + lessons appendix. Multiplied by `steps`, it is the floor cost
   * an uncached run pays before any real work.
   */
  prefixTokens?: number;
  /**
   * True when the provider did not report usage and these numbers are the
   * loop's own estimate of the request it sent. Estimates must never render
   * as if they were provider truth (a run once logged "context 1.2M/128k").
   */
  usageEstimated?: boolean;
}

/** Panel → service worker, over the long-lived port. */
export type PortRequest =
  | { kind: "ping" }
  | {
      kind: "run";
      task: string;
      mode: ControlMode;
      demo?: DemoConfig;
      /** Continue an existing chat thread (multi-turn context). */
      conversationId?: string;
      /** File attachments (text inlined into the task, images to the model). */
      attachments?: RunAttachment[];
      /**
       * Per-run "look outside" grant, chosen by the USER in the composer. The
       * model can never set this: it widens READ-ONLY tab listing to the
       * user's other windows, and nothing else.
       */
      allowOutsideWindows?: boolean;
      /**
       * The window hosting the panel. Used only in "adopt" mode, where that
       * window IS the agent's window — the SW never has to guess which window
       * the user meant (chrome.tabs.query({currentWindow}) in a service worker
       * resolves to the last-focused window, which is exactly the ambiguity
       * that let a run observe the user's window in the first place).
       */
      panelWindowId?: number;
    }
  | { kind: "stop" }
  | { kind: "state" }
  /** Where the agent is allowed to work (see AgentWindowStatus). */
  | { kind: "window.status" }
  /** Adopt a window the user picked as the agent's own. */
  | { kind: "window.bind"; windowId: number }
  /** Forget the adopted window: the agent gets its own again. */
  | { kind: "window.reset" }
  /** User gesture: raise the agent's window (the ONLY path that focuses one). */
  | { kind: "window.reveal" }
  /** Move one of the user's tabs into the agent's window. */
  | { kind: "window.handover"; tabId: number }
  /**
   * Mid-run steering: a user message queued for the running agent. It lands
   * as a normal user turn the model sees on its next step — corrections,
   * extra context, "also do X" — without stopping the run.
   */
  | { kind: "run.input"; text: string }
  /** Chat history (conversation store). */
  | { kind: "history.list" }
  | { kind: "history.get"; conversationId: string }
  | { kind: "history.delete"; conversationId: string }
  | { kind: "history.rename"; conversationId: string; title: string }
  /** Run logs: timestamped per-turn chat + tool records, archived locally. */
  | { kind: "logs.list" }
  | { kind: "logs.get"; logId: string }
  | { kind: "logs.delete"; logId: string }
  | { kind: "logs.clear" }
  /** Export to a file on disk (panel triggers the download). */
  | { kind: "logs.export"; format: LogExportFormat; logId?: string }
  /**
   * Self-improvement ("coach") layer: review a finished run with a second
   * agent on the same model and keep what it learned about what works.
   */
  | { kind: "lessons.list" }
  | { kind: "lessons.review"; logId?: string }
  | {
      kind: "lessons.update";
      id: string;
      text?: string;
      pinned?: boolean;
      category?: LessonCategory;
    }
  | { kind: "lessons.delete"; id: string }
  | { kind: "lessons.clear" }
  | { kind: "lessons.export"; format: LogExportFormat }
  /** Skills (on-demand procedures): list, create, edit, delete. */
  | { kind: "skills.list" }
  | {
      kind: "skills.new";
      skill: {
        name: string;
        whenToUse: string;
        body: string;
        hosts?: string[];
        keywords?: string[];
        pinned?: boolean;
        sections?: { id: string; title: string; useWhen?: string; body: string }[];
      };
    }
  | {
      kind: "skills.update";
      id: string;
      patch?: {
        whenToUse?: string;
        body?: string;
        hosts?: string[];
        keywords?: string[];
        pinned?: boolean;
        sections?: { id: string; title: string; useWhen?: string; body: string }[];
      };
    }
  | { kind: "skills.delete"; id: string }
  /** Resolve a pending Phase 6 confirmation. */
  | { kind: "confirm.resolve"; id: string; allow: boolean; always?: boolean }
  /** Resolve a pending human handoff (sign-in / CAPTCHA wall). */
  | { kind: "human.resolve"; id: string; handled: boolean }
  /** Dev/test + Phase 4 loop: run one registered tool against a tab. */
  | {
      kind: "run_tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      tabId?: number;
      /** Route through the policy/handoff gate instead of raw execution. */
      gated?: boolean;
    }
  /**
   * Dev/test hook (scripts + e2e): simulate a browser that lets the worker
   * die — suppresses all keepalive wakeups so checkpoint/resume is testable.
   */
  | { kind: "test_suspend" }
  /**
   * Dev/test hook: stand in for the user's per-run "look outside" toggle when
   * a driver script calls tools directly (no run is active, so there is no
   * checkpoint to carry the grant). Never reachable by the model.
   */
  | { kind: "test_scope"; allowOutside: boolean };

export type PanelToSw = PortRequest | { type: "ping" };

/**
 * Where the agent is allowed to work, as the panel renders it. The agent gets
 * ONE window: everything it lists, reads, clicks or types lives there.
 */
export interface AgentWindowStatus {
  /** `own` = a window the agent created; `adopt` = a window the user picked. */
  mode: "own" | "adopt";
  /** The bound window, when one exists right now (window ids are per session). */
  windowId?: number;
  /** False when the bound window is gone — a run would create a fresh one. */
  alive: boolean;
  /** Tabs currently in the agent's window. */
  tabs: number;
  /** The tab a run would start on (the window's active tab). */
  activeTabId?: number;
  /**
   * How many times this session raised a browser window. Quiet mode (the
   * default) must keep this at 0 — it is what tests assert instead of trying
   * to observe OS focus.
   */
  raiseAttempts: number;
}

/** Service worker → panel. */
export type SwToPanel =
  | { type: "agent.event"; event: StepEvent }
  | { type: "agent.state"; running: boolean; checkpoint: Checkpoint | null }
  | { type: "pong"; from: "sw"; startedAt: number; ts: number }
  | { type: "window.status"; status: AgentWindowStatus }
  | {
      type: "tool_result";
      id: string;
      ok: boolean;
      payload?: unknown;
      /** Compact model-facing rendering (what the agent loop would send). */
      text?: string;
      error?: string;
    }
  | { type: "history.list"; conversations: ConversationSummary[] }
  | { type: "history.get"; conversation: Conversation | null }
  | { type: "logs.list"; logs: LogSummary[] }
  | { type: "logs.get"; log: LogTurnRecord | null }
  | { type: "lessons.list"; lessons: Lesson[] }
  | { type: "skills.list"; skills: Skill[]; error?: string }
  /**
   * Progress of one coach review. `started` is emitted for manual reviews so
   * the panel can show a spinner; auto reviews go straight to a terminal
   * status (the user asked for nothing, so there is nothing to spin).
   */
  | {
      type: "lessons.review";
      status: "started" | "added" | "empty" | "error";
      task?: string;
      source?: "auto" | "manual";
      added?: number;
      merged?: number;
      total?: number;
      message?: string;
    }
  | { type: "lessons.export"; format: LogExportFormat; filename: string; content: string }
  | {
      type: "logs.export";
      format: LogExportFormat;
      filename: string;
      content: string;
    };
