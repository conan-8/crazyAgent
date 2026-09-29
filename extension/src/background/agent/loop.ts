// The agent loop: LLM tool-calling loop with per-step checkpointing,
// cooperative stop, argument validation feedback (max retries via streak
// reset), a hard step cap and history truncation. The Phase 1 echo task is
// the deterministic stand-in; this is the real thing behind the same bus.
import type {
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResult,
  LlmToolSpec,
  ThinkingLevel,
  ToolCall,
} from "../../shared/llm";
import type { Checkpoint, RunStats, StepEvent } from "../../shared/protocol";
import { validateToolArgs } from "../tools/types";
import { estimateTokens, isMutating } from "../../shared/modes";
import { madmanExclamation, madmanLabel } from "../../shared/madman";
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
  /**
   * The Jev risk layer checked this mutating action and allowed it. Passed
   * through to the tool_result event so the panel can mark the card.
   */
  jevGate?: boolean;
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
  maxTokens?: number;
  /** "plan" blocks mutating tools; default "auto". */
  agentMode?: string;
  /** Model context window for the usage bar. */
  contextWindow?: number;
  /** Reasoning effort level forwarded to the provider ("off" disables). */
  thinking?: ThinkingLevel;
  /** Madman mode: profane voice in the prompt + a cuss on every tool label. */
  madman?: boolean;
  /** Jev sidecar configured: the `judge` tool is in the spec list. */
  judgeAvailable?: boolean;
  /**
   * Per-run appendix for the system prompt (lessons learned from previous
   * runs). Sent as a separate, uncached system block — see LlmRequest.
   */
  lessonsBlock?: string;
  /**
   * Mid-run steering: user messages queued from the panel since the last
   * step. Drained before every LLM call and appended as ordinary user turns,
   * so corrections and additions reach the model without stopping the run.
   */
  takeUserInput?: () => string[];
}

const MAX_RESULT_CHARS = 24_000;
const HISTORY_BUDGET_CHARS = 120_000;
const MAX_LIVE_IMAGES = 4;
/**
 * Token accounting for truncation: system prompt + tool specs + margin that
 * never ride in `messages` but DO count against the context window, and the
 * approximate cost of one attached screenshot (chars-equivalent so one budget
 * math covers text and images).
 */
const CONTEXT_RESERVE_TOKENS = 20_000;
const IMAGE_CHARS_EQUIV = 6_000;
const TOOL_CALL_ARGS_KEEP_CHARS = 200;

/** Total attempts per LLM call (1 try + retries) and the backoff between them. */
const LLM_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Read-only tools that never touch page state — safe to execute concurrently
 * when the model batches several of them in one step. Anything else (actions,
 * navigation, gated tools) stays strictly sequential.
 */
const PARALLEL_SAFE = new Set([
  "snapshot",
  "read_page",
  "frames",
  "screenshot",
  "view_image",
  "wait_for_settle",
  "tabs_list",
  "network_observe",
  "judge", // read-only external decision call — never touches page state
]);

/**
 * Stuck-loop detection. A live run spent 15 turns re-running a frame probe
 * that failed identically every time, then 9 more on a doomed workaround —
 * nothing told the model it was grinding. Three failures of the same tool in a
 * row (or a literal re-run of a call that already failed) now land a note IN
 * the tool result, with the one move that breaks the loop: look at the page.
 */
export interface StuckGuard {
  note(name: string, args: Record<string, unknown>, failed: boolean): string;
}

export function createStuckGuard(): StuckGuard {
  const streak = new Map<string, number>();
  const calls = new Map<string, number>();
  return {
    note(name, args, failed) {
      let key: string;
      try {
        key = `${name}:${JSON.stringify(args ?? {})}`;
      } catch {
        key = `${name}:(unserializable)`;
      }
      const repeats = (calls.get(key) ?? 0) + 1;
      calls.set(key, repeats);
      const n = failed ? (streak.get(name) ?? 0) + 1 : 0;
      streak.set(name, n);
      if (failed && repeats > 1) {
        return `\n\n[RETRY WARNING: this exact call has already failed in this run — repeating it will fail again. Do NOT run it again. Change the approach; if you are unsure what the page shows, take a screenshot and look at it.]`;
      }
      if (failed && n >= 3) {
        return `\n\n[STUCK: ${name} has now failed ${n} times in a row. Do not retry it. Take a screenshot to SEE what the page actually shows, switch to read_page / snapshot / ref-based tools, or report the blocker and stop.]`;
      }
      if (repeats >= 3) {
        return `\n\n[This exact call has now run ${repeats} times and returns the same thing — vary the approach instead of polling it again. If you are unsure what you are seeing, take a screenshot.]`;
      }
      return "";
    },
  };
}

/** One LLM call with retry + backoff on transient failures (429/5xx/network). */
async function completeWithRetry(
  deps: LoopDeps,
  req: LlmRequest,
  onText: (t: string) => void,
  onReasoning: (t: string) => void,
): Promise<LlmResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < LLM_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!;
      deps.emit({
        kind: "info",
        message: `LLM call failed (${String((lastErr as Error)?.message ?? lastErr)}) — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${LLM_ATTEMPTS})`,
      });
      await new Promise((r) => setTimeout(r, delay));
      if (deps.shouldStop()) break;
    }
    try {
      return await deps.llm.complete(req, onText, undefined, onReasoning);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

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
  const guard = createStuckGuard();
  // Uncapped by default. `Infinity` keeps the loop condition identical to the
  // capped path, so there is one code path rather than two.
  const stepCap = deps.stepCap ?? Number.POSITIVE_INFINITY;
  // What history may occupy after system prompt, tool specs and the reply are
  // paid for — the old char-only budget let tool-call args balloon past the
  // window (a real run ended at 131k tokens in a 128k window).
  const historyTokenBudget = Math.max(
    4_000,
    contextWindow - (deps.maxTokens ?? 4_096) - CONTEXT_RESERVE_TOKENS,
  );

  for (let step = cp.stepIndex; step < stepCap; step++) {
    if (deps.shouldStop()) return finish(cp, deps, "stopped", lastStats);
    deps.emit({ kind: "step_started", stepIndex: step });

    // Mid-run steering: whatever the user typed since the last step lands as
    // normal user messages this call will see.
    for (const text of deps.takeUserInput?.() ?? []) {
      if (text.trim()) cp.messages.push({ role: "user", content: text });
    }

    const now = new Date();
    let result;
    try {
      result = await completeWithRetry(
        deps,
        {
          system: buildSystemPrompt(
            cp.task,
            deps.agentMode ?? "auto",
            deps.madman === true,
            deps.judgeAvailable === true,
            // Clock is read per step (not once per run) so a long run — or one
            // resumed from a checkpoint hours later — always sees the real time.
            now,
          ),
          systemSuffix: deps.lessonsBlock || undefined,
          messages: truncateHistory(cp.messages, HISTORY_BUDGET_CHARS, historyTokenBudget),
          tools,
          maxTokens: deps.maxTokens,
          thinking: deps.thinking,
        },
        (text) => deps.emit({ kind: "token_delta", text }),
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
      // Persist reasoning only when Anthropic signed it: the signature marks a
      // thinking block that MUST be replayed on the tool-use continuation.
      // OpenAI/DeepSeek reasoning has no signature and is streamed live to the
      // UI only, so we don't bloat the checkpoint replaying it back.
      thinking: result.reasoningSignature ? result.reasoning || undefined : undefined,
      thinkingSignature: result.reasoningSignature || undefined,
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

    // Execute the batch: all-read-only batches run concurrently; anything
    // else stays sequential with a stop check between calls. Outcomes are
    // recorded in call order either way.
    let aborted = false;
    const record = (outcome: {
      message: LlmMessage;
      event: StepEvent;
      invalid: boolean;
    }): void => {
      cp.messages.push(outcome.message);
      deps.emit(outcome.event);
      invalidStreak = outcome.invalid ? invalidStreak + 1 : 0;
      if (invalidStreak >= 3) {
        deps.emit({
          kind: "error",
          message: "three consecutive invalid tool calls — aborting",
        });
        aborted = true;
      }
    };

    const calls = result.toolCalls;
    const madman = deps.madman === true;
    // Madman mode: every tool call gets a cuss word we control, so the "every
    // tool call contains a cuss word" contract holds even when the model
    // forgets to swear. The exclamation lands once per step, before the calls.
    if (madman && calls.length) {
      deps.emit({
        kind: "madman",
        message: madmanExclamation(
          calls.map((c) => c.name).join(", ") || undefined,
          `step:${step}`,
        ),
      });
    }
    const announce = (call: ToolCall): void => {
      deps.emit({
        kind: "tool_call",
        stepIndex: step,
        name: call.name,
        args: call.args,
        label: madman ? madmanLabel(call.name, `${step}:${call.name}`) : undefined,
        // A `judge` call IS a Jev call — the sidecar answers it. Flagged here
        // from the tool name (not model-supplied), so the pink highlight in the
        // panel cannot be spoofed or missed.
        jev: call.name === "judge" ? true : undefined,
      });
    };
    const canParallel =
      calls.length > 1 &&
      calls.every(
        (c) => c.invalidJson === undefined && PARALLEL_SAFE.has(c.name),
      );
    if (canParallel) {
      for (const call of calls) announce(call);
      const outcomes = await Promise.all(
        calls.map((call) => runOne(call, deps, step, specsByName, planOnly, guard)),
      );
      for (const outcome of outcomes) record(outcome);
    } else {
      for (const call of calls) {
        if (deps.shouldStop()) return finish(cp, deps, "stopped", lastStats);
        announce(call);
        record(await runOne(call, deps, step, specsByName, planOnly, guard));
        if (aborted) break;
      }
    }
    if (aborted) return finish(cp, deps, "stopped", lastStats);

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
  guard: StuckGuard,
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
      const content = `ERROR: ${error}${guard.note(call.name, call.args, true)}`;
      return {
        invalid: error.includes("missing required") || error.includes("must be"),
        message: {
          role: "tool",
          toolCallId: call.id,
          content,
          // A failing tool may still have seen something — the harness attaches
          // a screenshot of the failure state, and the model should get it.
          images: res.image ? [res.image] : undefined,
        },
        event: {
          kind: "tool_result",
          stepIndex,
          name: call.name,
          result: content,
          ok: false,
          jevGate: res.jevGate === true ? true : undefined,
        },
      };
    }
    // Screenshots always ride with their tool result: the configured model
    // takes image input, and a silently dropped image is a blind model (this
    // is exactly how a run spent 10 minutes tracing a PNG by pixel statistics
    // instead of looking at it).
    const image = res.image;
    const content =
      (res.text ?? clip(JSON.stringify(res.payload ?? null), MAX_RESULT_CHARS)) +
      guard.note(call.name, call.args, false);
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
        jevGate: res.jevGate === true ? true : undefined,
      },
    };
  } catch (err) {
    const error = String((err as Error)?.message ?? err);
    const content = `ERROR: ${error}${guard.note(call.name, call.args, true)}`;
    return {
      invalid: false,
      message: { role: "tool", toolCallId: call.id, content },
      event: { kind: "tool_result", stepIndex, name: call.name, result: content, ok: false },
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
 * Keep only the newest messages under a budget: old tool results collapse to a
 * note, old tool-call arguments are elided, and only the most recent
 * screenshots stay attached.
 *
 * The budget counts what the API actually re-sends: message text, the JSON of
 * every tool call's arguments (a multi-KB `evaluate_js` expression is real
 * context whether or not it lives in `content`), and an estimate per attached
 * image. A char-only budget that ignored tool-call args is how a run ended up
 * sending 131k tokens into a 128k window.
 */
export function truncateHistory(
  messages: LlmMessage[],
  budgetChars: number,
  tokenBudget?: number,
): LlmMessage[] {
  const out = messages.map((m) => ({
    ...m,
    toolCalls: m.toolCalls?.map((tc) => ({ ...tc })),
  }));
  let imagesSeen = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.images?.length) {
      imagesSeen += m.images.length;
      if (imagesSeen > MAX_LIVE_IMAGES) m.images = undefined;
    }
  }
  const argsChars = (m: LlmMessage): number =>
    m.toolCalls?.reduce((sum, tc) => sum + JSON.stringify(tc.args ?? {}).length, 0) ?? 0;
  const size = (m: LlmMessage): number =>
    m.content.length + argsChars(m) + (m.images?.length ?? 0) * IMAGE_CHARS_EQUIV;
  let total = out.reduce((sum, m) => sum + size(m), 0);
  const cap = Math.min(budgetChars, tokenBudget ? tokenBudget * 4 : Number.POSITIVE_INFINITY);
  for (let i = 0; i < out.length && total > cap; i++) {
    const m = out[i]!;
    if (m.role === "tool" && m.content.length > 64) {
      total -= m.content.length - 64;
      m.content = "[older tool result omitted]";
      m.images = undefined;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        const len = JSON.stringify(tc.args ?? {}).length;
        // The id and name must survive (they pair with the tool result); the
        // arguments of an old call are dead weight the model never re-reads.
        if (len > TOOL_CALL_ARGS_KEEP_CHARS) {
          total -= len;
          tc.args = { note: "args elided" };
        }
      }
    }
  }
  return out;
}
