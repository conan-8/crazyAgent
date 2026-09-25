// Shared wire types between the side panel, service worker, content scripts
// and (Phase 7) the native-messaging helper daemon. This file is the single
// cross-boundary contract for the extension.

export const PORT_NAME = "panel";

export type ControlMode = "standard" | "unlimited";

/** Run-log export encodings: JSON Lines for tooling, Markdown for reading. */
export type LogExportFormat = "jsonl" | "md";

import type { LlmMessage, LlmToolSpec } from "./llm";
import type { Conversation, ConversationSummary } from "./chat";
import type { LogSummary, LogTurnRecord } from "./logging";
import type { Lesson, LessonCategory } from "./lessons";
export type { LlmMessage };
export type { Conversation, ConversationSummary };
export type { LogSummary, LogTurnRecord };
export type { Lesson, LessonCategory };

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
  stepIndex: number;
  messages: LlmMessage[];
  /** LLM tool specs frozen at run start (kept for faithful resume). */
  toolSpecs?: LlmToolSpec[];
  startedAt: number;
  updatedAt: number;
  done: boolean;
}

export type StepEvent =
  | { kind: "info"; message: string }
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
  | {
      kind: "tool_result";
      stepIndex: number;
      name: string;
      result: string;
      ok: boolean;
      /** Screenshot thumbnail (data URL) for the panel viewer. */
      image?: string;
    }
  /** Live run statistics for the composer's stats bar. */
  | {
      kind: "usage";
      totalTokens: number;
      outputTokens: number;
      tokensPerSec: number;
      contextTokens: number;
      contextWindow: number;
      elapsedMs: number;
    }
  | { kind: "token_delta"; text: string }
  /** Streamed model reasoning ("thinking"); rendered in a collapsed block. */
  | { kind: "reasoning_delta"; text: string }
  | { kind: "need_confirm"; id: string; tool: string; summary: string; jev?: boolean }
  /** `stats` are the final numbers, so the bar survives the run ending. */
  | { kind: "done"; summary: string; stats?: RunStats }
  | { kind: "error"; message: string };

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
    }
  | { kind: "stop" }
  | { kind: "state" }
  /** Chat history (conversation store). */
  | { kind: "history.list" }
  | { kind: "history.get"; conversationId: string }
  | { kind: "history.delete"; conversationId: string }
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
  /** Resolve a pending Phase 6 confirmation. */
  | { kind: "confirm.resolve"; id: string; allow: boolean; always?: boolean }
  /** Dev/test + Phase 4 loop: run one registered tool against a tab. */
  | {
      kind: "run_tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      tabId?: number;
    }
  /**
   * Dev/test hook (scripts + e2e): simulate a browser that lets the worker
   * die — suppresses all keepalive wakeups so checkpoint/resume is testable.
   */
  | { kind: "test_suspend" };

export type PanelToSw = PortRequest | { type: "ping" };

/** Service worker → panel. */
export type SwToPanel =
  | { type: "agent.event"; event: StepEvent }
  | { type: "agent.state"; running: boolean; checkpoint: Checkpoint | null }
  | { type: "pong"; from: "sw"; startedAt: number; ts: number }
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
