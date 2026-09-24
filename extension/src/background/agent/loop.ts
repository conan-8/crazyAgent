// The agent loop: LLM tool-calling loop with per-step checkpointing,
// cooperative stop, argument validation feedback (max retries via streak
// reset), a hard step cap and history truncation. The Phase 1 echo task is
// the deterministic stand-in; this is the real thing behind the same bus.
import type {
  LlmClient,
  LlmMessage,
  LlmToolSpec,
  ToolCall,
} from "../../shared/llm";
import type { Checkpoint, RunStats, StepEvent } from "../../shared/protocol";
import { validateToolArgs } from "../tools/types";
import { estimateTokens, isMutating } from "../../shared/modes";
import { buildSystemPrompt } from "./prompts";

export type AgentOutcome = "completed" | "stopped" | "capped";

export interface ExecuteResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
  /** Screenshot data URL produced by this tool, if any. */
  image?: string;
  /** Pre-formatted compact text for the LLM (instead of raw JSON). */
  text?: string;
}

export interface LoopDeps {
  llm: LlmClient;
  emit(event: StepEvent): void;
  save(cp: Checkpoint): Promise<void>;
  shouldStop(): boolean;
  execute(name: string, args: Record<string, unknown>): Promise<ExecuteResult>;
  /**
   * Optional ceiling on agent steps. Omitted/Infinity means uncapped: the loop
   * runs until the model answers, the user stops it, or an error aborts it.
   */
  stepCap?: number;
  sendScreenshots: boolean;
  maxTokens?: number;
  /** "plan" blocks mutating tools; default "auto". */
  agentMode?: string;
  /** Model context window for the usage bar. */
  contextWindow?: number;
  /** Ask the model to emit reasoning before answering. */
  thinking?: boolean;
  /** Token budget for the thinking block, where the provider accepts one. */
  thinkingBudget?: number;
}

const MAX_RESULT_CHARS = 24_000;
const HISTORY_BUDGET_CHARS = 120_000;
const MAX_LIVE_IMAGES = 4;

export async function runAgentTask(
  cp: Checkpoint,
  deps: LoopDeps,
): Promise<AgentOutcome> {
  const tools: LlmToolSpec[] = cp.toolSpecs ?? [];
  const specsByName = new Map(tools.map((t) => [t.name, t]));
  const planOnly = deps.agentMode === "plan";
  const contextWindow = deps.contextWindow ?? 128_000;
  const runStartedAt = Date.now();
  let totalIn = 0;
  let totalOut = 0;
  let reasoningChars = 0;
  let lastStats: RunStats | undefined;
  let invalidStreak = 0;
  // Uncapped by default. `Infinity` keeps the loop condition identical to the
  // capped path, so there is one code path rather than two.
  const stepCap = deps.stepCap ?? Number.POSITIVE_INFINITY;

  for (let step = cp.stepIndex; step < stepCap; step++) {
    if (deps.shouldStop()) return finish(cp, deps, "stopped", lastStats);
    deps.emit({ kind: "step_started", stepIndex: step });

    let result;
    try {
      result = await deps.llm.complete(
        {
          system: buildSystemPrompt(cp.task, deps.agentMode ?? "auto"),
          messages: truncateHistory(cp.messages, HISTORY_BUDGET_CHARS),
          tools,
          maxTokens: deps.maxTokens,
          thinking: deps.thinking,
          thinkingBudget: deps.thinkingBudget,
        },
        (text) => deps.emit({ kind: "token_delta", text }),
        undefined,
        (text) => deps.emit({ kind: "reasoning_delta", text }),
      );
    } catch (err) {
      deps.emit({ kind: "error", message: `LLM call failed: ${String((err as Error)?.message ?? err)}` });
      return finish(cp, deps, "stopped", lastStats);
    }

    // Live usage for the stats bar: provider numbers when reported, else
    // a chars/4 estimate.
    const usage = result.usage ?? {
      inputTokens: estimateTokens(JSON.stringify(cp.messages)) ,
      outputTokens: estimateTokens(result.text + JSON.stringify(result.toolCalls)),
    };
    totalIn += usage.inputTokens;
    totalOut += usage.outputTokens;
    if (result.reasoning) reasoningChars += result.reasoning.length;
    const elapsedMs = Math.max(1, Date.now() - runStartedAt);
    const stats: RunStats = {
      steps: step + 1,
      inputTokens: totalIn,
      outputTokens: totalOut,
      totalTokens: totalIn + totalOut,
      tokensPerSec: Math.round((totalOut / elapsedMs) * 10_000) / 10,
      contextTokens: usage.inputTokens + usage.outputTokens,
      contextWindow,
      elapsedMs,
      reasoningChars: reasoningChars || undefined,
    };
    lastStats = stats;
    deps.emit({ kind: "usage", ...stats });

    cp.messages.push({
      role: "assistant",
      content: result.text,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
    });

    if (!result.toolCalls.length) {
      // Final answer — the task is done.
      cp.done = true;
      cp.updatedAt = Date.now();
      await deps.save(cp);
      deps.emit({
        kind: "done",
        summary: result.text.trim() || "task finished (no summary)",
        stats,
      });
      return "completed";
    }

    for (const call of result.toolCalls) {
      if (deps.shouldStop()) return finish(cp, deps, "stopped", lastStats);
      deps.emit({
        kind: "tool_call",
        stepIndex: step,
        name: call.name,
        args: call.args,
      });
      const outcome = await runOne(call, deps, step, specsByName, planOnly);
      cp.messages.push(outcome.message);
      deps.emit(outcome.event);
      invalidStreak = outcome.invalid ? invalidStreak + 1 : 0;
      if (invalidStreak >= 3) {
        deps.emit({
          kind: "error",
          message: "three consecutive invalid tool calls — aborting",
        });
        return finish(cp, deps, "stopped", lastStats);
      }
    }

    cp.stepIndex = step + 1;
    cp.updatedAt = Date.now();
    await deps.save(cp);
  }
  return finish(cp, deps, "capped", lastStats, stepCap);
}

async function runOne(
  call: ToolCall,
  deps: LoopDeps,
  stepIndex: number,
  specs: Map<string, LlmToolSpec>,
  planOnly: boolean,
): Promise<{ message: LlmMessage; event: StepEvent; invalid: boolean }> {
  if (call.invalidJson !== undefined) {
    const error = `ERROR: tool arguments were not valid JSON: ${call.invalidJson.slice(0, 200)}`;
    return {
      invalid: true,
      message: { role: "tool", toolCallId: call.id, content: error },
      event: {
        kind: "tool_result",
        stepIndex,
        name: call.name,
        result: error,
        ok: false,
      },
    };
  }
  // Validate against the frozen spec before touching the executor.
  const validation = validateToolArgs(specs.get(call.name), call.args);
  if (validation.error) {
    const error = validation.error;
    return {
      invalid: true,
      message: { role: "tool", toolCallId: call.id, content: error },
      event: { kind: "tool_result", stepIndex, name: call.name, result: error, ok: false },
    };
  }
  // Plan mode is strictly read-only: mutating tools never reach the page.
  if (planOnly && isMutating(call.name)) {
    const error = `planning mode is read-only: '${call.name}' is blocked — switch mode to Build or Auto to take actions`;
    return {
      invalid: false,
      message: { role: "tool", toolCallId: call.id, content: `ERROR: ${error}` },
      event: { kind: "tool_result", stepIndex, name: call.name, result: error, ok: false },
    };
  }
  try {
    const res = await deps.execute(call.name, call.args);
    if (!res.ok) {
      const error = res.error ?? "tool failed";
      return {
        invalid: error.includes("missing required") || error.includes("must be"),
        message: { role: "tool", toolCallId: call.id, content: `ERROR: ${error}` },
        event: { kind: "tool_result", stepIndex, name: call.name, result: error, ok: false },
      };
    }
    const image = res.image && deps.sendScreenshots ? res.image : undefined;
    const content =
      res.text ??
      clip(JSON.stringify(res.payload ?? null), MAX_RESULT_CHARS);
    return {
      invalid: false,
      message: {
        role: "tool",
        toolCallId: call.id,
        content,
        images: image ? [image] : undefined,
      },
      event: {
        kind: "tool_result",
        stepIndex,
        name: call.name,
        result: clip(content, 400),
        ok: true,
        image,
      },
    };
  } catch (err) {
    const error = String((err as Error)?.message ?? err);
    return {
      invalid: false,
      message: { role: "tool", toolCallId: call.id, content: `ERROR: ${error}` },
      event: { kind: "tool_result", stepIndex, name: call.name, result: error, ok: false },
    };
  }
}

function finish(
  cp: Checkpoint,
  deps: LoopDeps,
  outcome: AgentOutcome,
  stats?: RunStats,
  stepCap: number = Number.POSITIVE_INFINITY,
): AgentOutcome {
  cp.done = true;
  cp.updatedAt = Date.now();
  const summary =
    outcome === "capped"
      ? Number.isFinite(stepCap)
        ? `stopped: reached the ${stepCap}-step budget`
        : "stopped: reached the step budget"
      : outcome === "stopped"
        ? `stopped at step ${cp.stepIndex + 1}`
        : "completed";
  deps.emit({ kind: "done", summary, stats });
  return outcome;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/**
 * Keep only the newest messages under a character budget: old tool results
 * collapse to a note and only the most recent screenshots stay attached.
 */
export function truncateHistory(
  messages: LlmMessage[],
  budgetChars: number,
): LlmMessage[] {
  const out = messages.map((m) => ({ ...m }));
  let imagesSeen = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.images?.length) {
      imagesSeen += m.images.length;
      if (imagesSeen > MAX_LIVE_IMAGES) m.images = undefined;
    }
  }
  let total = out.reduce((sum, m) => sum + m.content.length, 0);
  for (let i = 0; i < out.length && total > budgetChars; i++) {
    const m = out[i]!;
    if (m.role === "tool" && m.content.length > 64) {
      total -= m.content.length - 64;
      m.content = "[older tool result omitted]";
      m.images = undefined;
    }
  }
  return out;
}
