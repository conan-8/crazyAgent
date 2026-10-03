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
import { thinkingBudgetFor } from "../../shared/llm";
import type { Checkpoint, RunStats, StepEvent } from "../../shared/protocol";
import { validateToolArgs } from "../tools/types";
import { estimateTokens } from "../../shared/modes";
import { madmanExclamation, madmanLabel } from "../../shared/madman";
import { buildSystemPrompt, buildSystemVolatile } from "./prompts";

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

/**
 * Where one tool call sits inside its step's batch.
 *
 * The executor uses this to defer the settle+snapshot observation to the LAST
 * call of a batch. Every page action used to pay its own settle and append its
 * own snapshot, even when the model had batched several actions into one step
 * and only ever reads the final page state — pure duplicated work on the
 * critical path between two LLM round trips.
 */
export interface ExecuteBatch {
  /** 0-based position within this step's tool calls. */
  index: number;
  /** Total tool calls in this step. */
  count: number;
}

export interface LoopDeps {
  llm: LlmClient;
  emit(event: StepEvent): void;
  save(cp: Checkpoint): Promise<void>;
  shouldStop(): boolean;
  execute(
    name: string,
    args: Record<string, unknown>,
    batch?: ExecuteBatch,
  ): Promise<ExecuteResult>;
  /**
   * Optional ceiling on agent steps. Omitted/Infinity means uncapped: the loop
   * runs until the model answers, the user stops it, or an error aborts it.
   */
  stepCap?: number;
  maxTokens?: number;
  /** Model context window for the usage bar. */
  contextWindow?: number;
  /** Reasoning effort level forwarded to the provider ("off" disables). */
  thinking?: ThinkingLevel;
  /** Madman mode: profane voice in the prompt + a cuss on every tool label. */
  madman?: boolean;
  /**
   * Fast steps: shape the prompt to batch one logical unit of work into a
   * single round trip and to stop spending a step re-verifying an action whose
   * result already carried a fresh observation. See STEP_RULES_BATCHED.
   */
  batchActions?: boolean;
  /**
   * Adaptive per-step thinking: lower the effective thinking level to "off"
   * for steps that follow a streak of routine ones, restoring the configured
   * level on the first surprise (see isRoutineStep). Requires the run level
   * to not already be "off".
   */
  adaptiveThinking?: boolean;
  /** Jev sidecar configured: the `judge` tool is in the spec list. */
  judgeAvailable?: boolean;
  /**
   * Per-run appendix for the system prompt (lessons learned from previous
   * runs). Sent as a separate, uncached system block — see LlmRequest.
   */
  lessonsBlock?: string;
  /**
   * Ceiling on how long an LLM attempt may stay silent before its first
   * token (see TTFT_STALL_MS). Override for tests; 0/Infinity disables the
   * guard. Defaults to TTFT_STALL_MS.
   */
  ttftStallMs?: number;
  /**
   * Mid-run steering: user messages queued from the panel since the last
   * step. Drained before every LLM call and appended as ordinary user turns,
   * so corrections and additions reach the model without stopping the run.
   */
  takeUserInput?: () => string[];
}

const MAX_RESULT_CHARS = 24_000;
const HISTORY_BUDGET_CHARS = 120_000;
/**
 * How many attached screenshots stay visible to the model.
 *
 * Cut from 4 to 2 on the numbers from an archived 68-minute run: images were
 * 1.87M of its 9.44M input tokens (21%), with a mean of 3.94 live per step —
 * the slot was effectively always full, so every step re-sent four captures to
 * answer a question about the newest one. Successive screenshots of the same
 * page supersede each other, and the stale ones are not free either: they are
 * exactly the "a screenshot showed a different page than the snapshot" conflict
 * BASE_RULES has to warn about.
 *
 * Fewer live images is also kinder to the provider's prefix cache. Retiring a
 * capture rewrites the message that carried it, and everything after that
 * re-prefills; with a shorter window the retired capture is a more RECENT one,
 * so the rewrite point sits later in the array and less is re-sent uncached.
 *
 * Two keeps the useful pair — what the page looks like now, and what it looked
 * like before the last action — at half the token cost.
 */
const MAX_LIVE_IMAGES = 2;
/**
 * Token accounting for truncation: system prompt + tool specs + margin that
 * never ride in `messages` but DO count against the context window, and the
 * approximate cost of one attached screenshot (chars-equivalent so one budget
 * math covers text and images).
 */
const CONTEXT_RESERVE_TOKENS = 20_000;
const IMAGE_CHARS_EQUIV = 6_000;
const TOOL_CALL_ARGS_KEEP_CHARS = 200;
/**
 * Compaction is QUANTIZED so the rewrite point JUMPS instead of creeping.
 *
 * A provider prefix cache matches on the longest byte-identical prefix of the
 * previous request, so what matters is where the FIRST difference sits. The
 * original sweep collapsed the single oldest message each time the budget was
 * crossed, which advanced the rewrite point by a message on practically every
 * step — the first difference stayed early in the array and the bulk of the
 * conversation re-prefilled every step, no matter how little was new.
 *
 * Snapping the point to a multiple of HISTORY_COMPACT_QUANTUM keeps it fixed
 * for several steps at a time, and each jump re-prefills only from that point
 * onward, which is always near the END of the history (it is derived from the
 * size budget). The cost of a jump is therefore bounded by the newest messages
 * rather than by the whole conversation.
 */
const HISTORY_COMPACT_QUANTUM = 8;
/**
 * Floor on how much history compaction will ever throw away. The size budget
 * normally keeps far more than this — `cut` below is derived from the target —
 * so this only binds when a handful of enormous messages would otherwise be
 * compacted away immediately, leaving the model blind to what it just did.
 */
const HISTORY_KEEP_RECENT = 4;
/**
 * Hysteresis: once compaction runs, it aims well under the cap, so the next
 * steps are untouched and their prefix stays byte-identical.
 */
const HISTORY_LOW_WATER = 0.6;
/**
 * Flat token estimate for one attached screenshot in the fallback usage math.
 * Counting a JPEG's base64 as chars/4 — what the old fallback did against the
 * UNTRUNCATED checkpoint (which keeps every image ever taken) — inflated a
 * real run's stats to "73.8M tokens, context 1.2M/128k": garbage that masked
 * everything the numbers should have shown.
 */
const IMAGE_TOKENS_ESTIMATE = 1_500;

/** Total attempts per LLM call (1 try + retries) and the backoff between them. */
const LLM_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Stall guard: abort an attempt that has produced NO token (reasoning or
 * text) within this many milliseconds and treat it as a transient failure,
 * so the existing retry path takes over. A real run sat 108s in one such
 * window on a 39-char reply — the connection was alive but silent, and
 * nothing was watching. The value is a ceiling for the common case, not a
 * target: healthy first tokens arrive in single-digit seconds.
 */
export const TTFT_STALL_MS = 25_000;

/**
 * Recovery budget for replies that carry no answer (see the non-answer gate
 * below). A reasoning model can burn its whole output budget on thinking and
 * stream back nothing at all; each such reply gets a re-prompt and — when it
 * was an output-limit truncation — a doubled output cap, until this many have
 * piled up in a row and the run stops honestly instead of claiming success.
 */
const MAX_EMPTY_REPLIES = 3;
/** Ceiling for the truncation-driven output-cap raise (providers cap output). */
const MAX_OUTPUT_TOKENS = 32_000;

/**
 * Client-side ceiling on ONE step's reasoning, as a multiple of the selected
 * thinking level's token budget (see `reasoningCapChars`).
 *
 * The wire cannot be trusted to enforce it. An archived 68-minute run asked for
 * `thinking: low` — a 1,024-token budget — and the model returned 196,918
 * reasoning tokens, 192× the request, because the OpenAI-compatible endpoint
 * ignores `reasoning_effort` and no budget ever reached it. Reasoning was 87% of
 * that run's output tokens and, at a measured 93 tok/s, roughly half its wall
 * clock; the 62 turns that thought for over 4,000 characters alone accounted
 * for 51% of it. Two turns ran to 98s each on ~9,000 tokens of thinking.
 *
 * So the loop counts reasoning deltas as they stream and cuts the connection at
 * a generous multiple of what was asked for, then re-asks the SAME step with
 * thinking off to get an actionable reply. The multiple is deliberately loose:
 * it is a tail-cutter for runaways, not a trimmer of ordinary thought, and a
 * provider that does honour its budget (Anthropic) can never reach it.
 */
const REASONING_OVERRUN_FACTOR = 3;

/**
 * How many consecutive steps in a row before a run level above "off" is
 * lowered for subsequent steps (adaptive thinking).
 */
export const ADAPTIVE_ROUTINE_STREAK = 3;
/**
 * Reasoning under this many characters counts as "barely thought about" for
 * the routine-step test. Heavy-reasoning steps median 31s against 7s for the
 * rest on the measured run — the streak must only count the cheap ones.
 */
export const ADAPTIVE_ROUTINE_MAX_REASONING_CHARS = 300;

/** Calls that (re)define where the agent is working — thinking comes back. */
const PAGE_CHANGING_TOOLS = new Set([
  "navigate",
  "reload",
  "back",
  "forward",
  "tabs_switch",
  "tabs_create",
  "tabs_close",
]);

/** What the loop observed about one finished step, for the routine test. */
export interface StepOutcomeState {
  /** Tool calls the step made (0 = answer-only or empty reply). */
  toolCalls: number;
  /** Any call failed or was invalid. */
  failed: boolean;
  /** The step's reasoning size (chars). */
  reasoningChars: number;
  /** A navigation/tab change rode the step. */
  pageChanging: boolean;
}

/**
 * The routine-step test for adaptive thinking: exactly one successful tool
 * call, barely any reasoning, nothing that moved the agent to a new page.
 * Anything richer keeps the configured thinking level — constructing a batch,
 * recovering from a failure and orienting on a fresh page are exactly the
 * moments deliberation pays for.
 */
export function isRoutineStep(s: StepOutcomeState): boolean {
  return (
    s.toolCalls === 1 &&
    !s.failed &&
    !s.pageChanging &&
    s.reasoningChars < ADAPTIVE_ROUTINE_MAX_REASONING_CHARS
  );
}

/**
 * How many capped steps in a row before thinking is switched off for the REST
 * of the run. Each cap costs a second round trip, so a model that overruns
 * every step is paying double to keep a habit that is not paying for itself;
 * after this many, the loop stops asking for thinking at all and says so.
 */
const MAX_REASONING_OVERRUNS = 3;

/**
 * The reasoning ceiling for one step, in CHARACTERS (0 = no cap). Derived from
 * the level's own token budget at the same chars/4 ratio the rest of the token
 * math uses, so one number means the same thing everywhere.
 */
export function reasoningCapChars(level: ThinkingLevel | undefined): number {
  const budget = thinkingBudgetFor(level ?? "off");
  return budget > 0 ? budget * 4 * REASONING_OVERRUN_FACTOR : 0;
}

/**
 * What the loop tells a model whose last reply carried no answer and no tool
 * call. It lands as an ordinary user turn, so it survives checkpointing and
 * the model sees its own dead end.
 */
function emptyReplyNudge(truncated: boolean): string {
  return (
    "[harness] Your previous reply arrived EMPTY — no answer text and no tool calls" +
    (truncated ? " (the output token limit cut it off mid-stream)" : "") +
    ". That is not a completion and the task is NOT done. Continue from where you " +
    "were: call the next tool, or — only if the work is genuinely complete — give " +
    "the final answer in plain text."
  );
}

/**
 * Free screenshot bytes the loop will never send again, IN PLACE on the raw
 * checkpoint. `truncateHistory` already strips all but the newest
 * MAX_LIVE_IMAGES images from every REQUEST VIEW — but the view is a copy, so
 * the checkpoint itself kept every capture ever taken alive in worker RAM for
 * the whole run (hundreds of KB of base64 each; a vision-heavy run reached
 * tens of megabytes and helped OOM-kill the extension process). Nothing the
 * model ever sees changes: dropped images were already invisible to it.
 */
export function capCheckpointImages(messages: LlmMessage[]): void {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!m.images?.length) continue;
    seen += m.images.length;
    if (seen > MAX_LIVE_IMAGES) m.images = undefined;
  }
}

/**
 * Estimate the tokens of a REQUEST VIEW of the history (what the provider is
 * actually sent), not the raw checkpoint: message text + tool-call args at
 * chars/4, attached images at a flat per-image estimate.
 */
export function estimateMessages(messages: LlmMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += m.content.length;
    for (const tc of m.toolCalls ?? []) chars += JSON.stringify(tc.args ?? {}).length;
    images += m.images?.length ?? 0;
  }
  // Same chars/4 heuristic as estimateTokens (which takes text, not a count).
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS_ESTIMATE;
}

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
  // A blocking wait never touches page state; several may run at once.
  "wait_for",
  "tabs_list",
  "bookmarks_search",
  "bookmarks_list",
  "topsites_list",
  "network_observe",
  "use_skill", // read-only storage lookup — never touches page state
  "judge", // read-only external decision call — never touches page state
]);

/**
 * Stuck-loop detection. A live run spent 15 turns re-running a frame probe
 * that failed identically every time, then 9 more on a doomed workaround —
 * nothing told the model it was grinding. Three failures of the same tool in a
 * row (or a literal re-run of a call that already failed) now land a note IN
 * the tool result, with the one move that breaks the loop: look at the page.
 *
 * Wait tools are exempt from the SUCCESS-repeat note only: re-issuing a wait
 * with the same arguments is legitimate (waiting on the next reply of the
 * same page), while their FAILURES still count toward the streak like any
 * other tool's.
 */
export interface StuckGuard {
  note(name: string, args: Record<string, unknown>, failed: boolean): string;
}

const WAIT_LIKE_TOOLS = new Set(["wait_for", "wait_for_settle"]);

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
      if (repeats >= 3 && !WAIT_LIKE_TOOLS.has(name)) {
        return `\n\n[This exact call has now run ${repeats} times and returns the same thing — vary the approach instead of polling it again. If you are unsure what you are seeing, take a screenshot.]`;
      }
      return "";
    },
  };
}

/**
 * One LLM call with retry + backoff on transient failures (429/5xx/network),
 * and a ceiling on runaway reasoning.
 *
 * `reasoningCap` is a character count (0 = uncapped). Past it the stream is cut
 * and the call comes back `capped` with NO result, so the caller re-asks the
 * step with thinking off rather than waiting out a 98-second soliloquy. That
 * abort is ours, so it is not a transient failure and burns no retry — but the
 * reasoning it did stream is reported back, because it was generated and paid
 * for, and the run's stats would understate the cost otherwise.
 *
 * Timing: each ATTEMPT stamps its own request-start and first-token time, and
 * the returned `ttftMs`/`decodeMs` describe the attempt whose reply survived
 * (a failed attempt that never produced a token reports neither). This is the
 * split that says whether a slow round trip is prefill/queue (TTFT — cut input
 * tokens) or decode (cut reasoning): wall-clock alone cannot tell them apart.
 */
async function completeWithRetry(
  deps: LoopDeps,
  req: LlmRequest,
  onText: (t: string) => void,
  onReasoning: (t: string) => void,
  reasoningCap = 0,
): Promise<{
  result?: LlmResult;
  capped: boolean;
  cappedChars: number;
  ttftMs?: number;
  decodeMs?: number;
}> {
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
    // Per attempt: the cut is only attributable to the attempt that made it.
    let capped = false;
    let chars = 0;
    const stallMs = deps.ttftStallMs ?? TTFT_STALL_MS;
    const guardStall = Number.isFinite(stallMs) && stallMs > 0;
    // One controller serves both cut paths (reasoning overrun, TTFT stall):
    // each is armed only when its ceiling exists, and either aborts the stream.
    const ctl = reasoningCap > 0 || guardStall ? new AbortController() : undefined;
    const attemptStart = Date.now();
    let firstDeltaAt = 0;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const clearStallTimer = (): void => {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };
    const mark = (): void => {
      if (!firstDeltaAt) {
        firstDeltaAt = Date.now();
        // First token landed — the stall guard's job is done for this attempt.
        clearStallTimer();
      }
    };
    if (ctl && guardStall) {
      stallTimer = setTimeout(() => {
        if (!firstDeltaAt) ctl!.abort();
      }, stallMs);
    }
    try {
      const result = await deps.llm.complete(
        req,
        (t) => {
          mark();
          onText(t);
        },
        ctl?.signal,
        (t) => {
          mark();
          chars += t.length;
          // Reasoning streams BEFORE the answer on every wire we speak, so
          // cutting here loses nothing but the thinking itself. (The explicit
          // cap check matters now that `ctl` can exist for the stall guard
          // alone: a 0 cap must never cut.)
          if (reasoningCap > 0 && ctl && !capped && chars > reasoningCap) {
            capped = true;
            clearStallTimer();
            ctl.abort();
          }
          onReasoning(t);
        },
      );
      clearStallTimer();
      return {
        result,
        capped,
        cappedChars: capped ? chars : 0,
        ttftMs: firstDeltaAt ? firstDeltaAt - attemptStart : undefined,
        decodeMs: firstDeltaAt ? Date.now() - firstDeltaAt : undefined,
      };
    } catch (err) {
      clearStallTimer();
      // Cutting the stream can surface as a rejection out of the reader rather
      // than a graceful end. Either way this is the cap doing its job.
      if (capped) return { capped: true, cappedChars: chars };
      if (ctl?.signal.aborted && !firstDeltaAt) {
        // The stall guard fired: the connection produced nothing at all within
        // the ceiling. That is a transient failure like any other — it burns a
        // retry and gets named for what it was, not left as a raw AbortError.
        lastErr = new Error(
          `stalled — no first token for ${(stallMs / 1000).toFixed(0)}s, attempt aborted`,
        );
      } else {
        lastErr = err;
      }
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
  const contextWindow = deps.contextWindow ?? 128_000;
  const runStartedAt = Date.now();
  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;
  let cachedEverReported = false;
  // Cache totals are only meaningful if EVERY step reported one: the figure is
  // rendered as a share of `inputTokens`, so a step that stayed silent would
  // silently deflate the percentage. Same rule as `usageEstimated` — a number
  // that cannot be trusted is not shown at all.
  let cachedAlwaysReported = true;
  let reasoningChars = 0;
  let usageEverEstimated = false;
  // Said once per run, not once per step: the first reply that arrives with no
  // provider usage is the story; the next 200 identical misses add nothing.
  let usageSilenceNoted = false;
  let lastStats: RunStats | undefined;
  let invalidStreak = 0;
  const guard = createStuckGuard();
  // Uncapped by default. `Infinity` keeps the loop condition identical to the
  // capped path, so there is one code path rather than two.
  const stepCap = deps.stepCap ?? Number.POSITIVE_INFINITY;
  // Effective output cap. It starts at the configured value and is raised when
  // a reply comes back truncated at the limit (a reasoning model happily spends
  // the whole budget thinking and streams no answer at all) — with a fallback
  // to the configured cap if the provider rejects the larger one.
  const baseMaxTokens = deps.maxTokens ?? 4_096;
  let maxTokens = baseMaxTokens;
  // Replies that carried no answer and no tool call, in a row. Bounded so a
  // model that keeps coming back empty stops honestly instead of looping.
  let emptyReplies = 0;
  // Effective thinking level. Starts at the configured one and is dropped to
  // "off" for the rest of the run once the reasoning cap has tripped
  // MAX_REASONING_OVERRUNS times in a row (see reasoningCapChars).
  let thinking = deps.thinking;
  // Consecutive steps whose reasoning had to be cut short.
  let overruns = 0;
  // Adaptive per-step thinking (deps.adaptiveThinking): consecutive routine
  // steps so far, whether subsequent steps are currently sent with thinking
  // off, and whether the lowering has been announced (once per run, not once
  // per step — the info is a state change, not a heartbeat).
  let routineStreak = 0;
  let adaptiveRoutine = false;
  let adaptiveNoted = false;
  // The stable system prompt (rules + task) is byte-identical for the whole
  // run — built once. Only the clock is per-step, and it rides in
  // systemVolatile at the END of the request so provider prompt caching hits
  // on everything expensive (rules, tool specs, the growing conversation).
  const systemPrompt = buildSystemPrompt(
    cp.task,
    deps.madman === true,
    deps.judgeAvailable === true,
    deps.batchActions === true,
  );
  const prefixTokens =
    estimateTokens(systemPrompt) +
    estimateTokens(deps.lessonsBlock || "") +
    estimateTokens(JSON.stringify(tools));

  for (let step = cp.stepIndex; step < stepCap; step++) {
    if (deps.shouldStop()) return finish(cp, deps, "stopped", lastStats);
    deps.emit({ kind: "step_started", stepIndex: step });

    // Mid-run steering: whatever the user typed since the last step lands as
    // normal user messages this call will see.
    for (const text of deps.takeUserInput?.() ?? []) {
      if (text.trim()) cp.messages.push({ role: "user", content: text });
    }

    const now = new Date();
    // What history may occupy after system prompt, tool specs and the reply are
    // paid for — the old char-only budget let tool-call args balloon past the
    // window (a real run ended at 131k tokens in a 128k window). Recomputed
    // per step because the output cap can grow after a truncation.
    const historyTokenBudget = Math.max(
      4_000,
      contextWindow - maxTokens - CONTEXT_RESERVE_TOKENS,
    );
    // One truncated view per step, used for BOTH the request and the fallback
    // usage estimate below — the estimate used to run against the raw
    // checkpoint (every screenshot ever taken, base64 counted as chars/4) and
    // reported absurdities like "context 1215933/128000".
    const history = truncateHistory(cp.messages, HISTORY_BUDGET_CHARS, historyTokenBudget);
    // Effective thinking for THIS step: the run level, lowered to "off" while
    // the adaptive streak says the work is routine (see isRoutineStep). The
    // overrun machinery and the reasoning cap keep operating on the run level.
    const effectiveThinking: ThinkingLevel | undefined =
      deps.adaptiveThinking === true && adaptiveRoutine && thinking !== "off"
        ? "off"
        : thinking;
    const request: LlmRequest = {
      system: systemPrompt,
      systemSuffix: deps.lessonsBlock || undefined,
      // Clock is read per step (not once per run) so a long run — or one
      // resumed from a checkpoint hours later — always sees the real time.
      // It is the request's volatile TAIL, never part of the cached prefix.
      systemVolatile: buildSystemVolatile(now),
      messages: history,
      tools,
      maxTokens,
      thinking: effectiveThinking,
    };
    const onText = (text: string): void => deps.emit({ kind: "token_delta", text });
    const onReasoning = (text: string): void =>
      deps.emit({ kind: "reasoning_delta", text });
    // The panel's "what is it doing" window starts here: everything before
    // this line was local bookkeeping, everything after is the provider's
    // queue + prefill + first token.
    deps.emit({
      kind: "llm_request_sent",
      stepIndex: step,
      contextTokens: prefixTokens + estimateMessages(history),
    });
    let result: LlmResult;
    // Reasoning generated by an attempt the cap cut short. Still generated,
    // still paid for, so it is counted even though its reply was thrown away.
    let cappedChars = 0;
    // Timing of the attempt whose reply survived (see completeWithRetry).
    let ttftMs: number | undefined;
    let decodeMs: number | undefined;
    try {
      const first = await completeWithRetry(
        deps,
        request,
        onText,
        onReasoning,
        reasoningCapChars(thinking),
      );
      cappedChars = first.cappedChars;
      ttftMs = first.ttftMs;
      decodeMs = first.decodeMs;
      if (first.capped || !first.result) {
        // The model was still thinking when the ceiling came down. Re-ask the
        // SAME step with thinking off: the run needs an actionable reply, and
        // one cheap round trip costs less than the rest of the soliloquy.
        overruns += 1;
        // A reasoning overrun is the opposite of routine — adaptive lowering
        // (if any) lifts immediately.
        routineStreak = 0;
        adaptiveRoutine = false;
        deps.emit({
          kind: "info",
          message:
            `reasoning overran the ${thinkingBudgetFor(thinking ?? "off")}-token budget for '${thinking ?? "off"}'` +
            ` — cut the stream at ~${Math.ceil(cappedChars / 4).toLocaleString()} tokens and re-asked the step with thinking off`,
        });
        if (overruns >= MAX_REASONING_OVERRUNS && thinking !== "off") {
          thinking = "off";
          overruns = 0;
          deps.emit({
            kind: "info",
            message: `${MAX_REASONING_OVERRUNS} steps in a row overran the reasoning budget — thinking is off for the rest of this run`,
          });
        }
        const second = await completeWithRetry(
          deps,
          { ...request, thinking: "off" },
          onText,
          onReasoning,
        );
        cappedChars += second.cappedChars;
        ttftMs = second.ttftMs;
        decodeMs = second.decodeMs;
        if (!second.result) throw new Error("reasoning cap tripped with thinking already off");
        result = second.result;
      } else {
        overruns = 0;
        result = first.result;
      }
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      if (maxTokens > baseMaxTokens) {
        // The raised output cap is the likely culprit: some providers 400 on
        // max_tokens above the model's own limit. Drop back to the configured
        // cap and run the step again rather than dying mid-task over a
        // recovery that was itself optional.
        maxTokens = baseMaxTokens;
        deps.emit({
          kind: "info",
          message: `LLM call failed (${message}) — retrying with the configured output cap ${baseMaxTokens}`,
        });
        continue;
      }
      deps.emit({ kind: "error", message: `LLM call failed: ${message}` });
      return finish(cp, deps, "stopped", lastStats);
    }

    // Per-step timing split, once per turn: TTFT (prefill/queue) vs decode.
    deps.emit({
      kind: "turn_timing",
      stepIndex: step,
      ttftMs,
      decodeMs,
      reasoningChars: result.reasoning?.length ?? 0,
    });

    // Live usage for the stats bar: provider numbers when reported, else an
    // estimate of what was actually SENT (the truncated request view; images
    // at a flat per-image cost). Estimated stats are flagged so the log never
    // renders them as provider truth.
    const estimated = result.usage === undefined;
    if (estimated && !usageSilenceNoted) {
      usageSilenceNoted = true;
      deps.emit({
        kind: "info",
        message:
          "the endpoint returned no usage despite stream_options.include_usage — token counts are the loop's own estimates and prompt-cache hits cannot be verified on this run",
      });
    }
    // Explicitly typed: the fallback carries no cache field, and an estimate
    // must never be mistaken for a provider-reported cache read.
    const usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } =
      result.usage ?? {
      inputTokens: prefixTokens + estimateMessages(history),
      outputTokens: estimateTokens(
        result.text + (result.reasoning ?? "") + JSON.stringify(result.toolCalls),
      ),
    };
    totalIn += usage.inputTokens;
    totalOut += usage.outputTokens;
    if (cappedChars) {
      // An attempt the reasoning cap cut short still generated these tokens and
      // still cost the wall clock; `usage` above only describes the reply that
      // survived. Counted here so a capped run never looks cheaper than it was.
      totalOut += Math.ceil(cappedChars / 4);
      reasoningChars += cappedChars;
    }
    if (usage.cachedInputTokens !== undefined) {
      totalCached += usage.cachedInputTokens;
      cachedEverReported = true;
    } else {
      cachedAlwaysReported = false;
    }
    if (estimated) usageEverEstimated = true;
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
      // Only meaningful when the provider actually reported one: a run on an
      // endpoint that stays silent shows no cache line, never "0% cached".
      cachedInputTokens:
        cachedEverReported && cachedAlwaysReported ? totalCached : undefined,
      prefixTokens,
      usageEstimated: usageEverEstimated || undefined,
    };
    lastStats = stats;
    deps.emit({ kind: "usage", ...stats });

    // Non-answer gate. A reply with no tool calls only ends the task when it
    // actually CONTAINED an answer: reasoning models routinely stream a long
    // thinking block and nothing else — often because the output limit cut the
    // stream mid-reasoning — and the loop used to read "no tool calls" as
    // "final answer" and close the run as `task finished (no summary)` while
    // the model was still mid-plan. That is the mid-run stop the user sees;
    // treat it as a hiccup and keep going instead.
    const truncated =
      result.stopReason === "length" || result.stopReason === "max_tokens";
    if (!result.toolCalls.length && (!result.text.trim() || truncated)) {
      emptyReplies += 1;
      if (emptyReplies > MAX_EMPTY_REPLIES) {
        deps.emit({
          kind: "error",
          message: `${emptyReplies} replies in a row carried no answer and no tool calls — stopping the run instead of pretending the task is done`,
        });
        return finish(cp, deps, "stopped", lastStats);
      }
      if (truncated && maxTokens < MAX_OUTPUT_TOKENS) {
        // The reply hit the output cap — almost always thinking, not the
        // answer. Give the next attempt more room instead of re-prompting the
        // model to repeat the same wall.
        maxTokens = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
        deps.emit({
          kind: "info",
          message: `reply was cut off at the output token limit — raising the cap to ${maxTokens} and continuing`,
        });
      } else {
        deps.emit({
          kind: "info",
          message: truncated
            ? `reply was cut off at the output limit (cap already ${maxTokens}) — asking the model to continue`
            : "the model returned an empty reply — asking it to continue",
        });
      }
      cp.messages.push({ role: "user", content: emptyReplyNudge(truncated) });
      // An empty reply is a surprise by definition: the routine streak (and
      // any adaptive lowering) resets so the next step thinks at full level.
      routineStreak = 0;
      adaptiveRoutine = false;
      cp.stepIndex = step + 1;
      cp.updatedAt = Date.now();
      capCheckpointImages(cp.messages);
      await deps.save(cp);
      continue;
    }
    emptyReplies = 0;

    const signedThinking = result.reasoningSignature
      ? result.reasoning || undefined
      : undefined;
    // An assistant turn with no text AND no tool calls is wire-invalid for
    // OpenAI-compatible providers and carries nothing (DeepSeek: "The content
    // field is a required field."; Moonshot: "assistant must provide content,
    // reasoning_content or tool_calls"), and one stored empty turn 400s EVERY
    // later request on the thread. The non-answer gate above now recovers from
    // those replies, so this is only a belt-and-braces guard; leave nothing
    // behind rather than a poisoned transcript. Signed thinking is only
    // replayable inside a tool-use continuation, so it does not justify
    // keeping a call-less empty turn.
    if (result.toolCalls.length || result.text) {
      cp.messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
        // Persist reasoning only when Anthropic signed it: the signature marks a
        // thinking block that MUST be replayed on the tool-use continuation.
        // OpenAI/DeepSeek reasoning has no signature and is streamed live to the
        // UI only, so we don't bloat the checkpoint replaying it back.
        thinking: signedThinking,
        thinkingSignature: result.reasoningSignature || undefined,
      });
    }

    if (!result.toolCalls.length) {
      // Final answer — the task is done.
      cp.done = true;
      cp.updatedAt = Date.now();
      capCheckpointImages(cp.messages);
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
    // Per-step outcome flags for the adaptive-thinking routine test.
    let stepFailed = false;
    const record = (outcome: {
      message: LlmMessage;
      event: StepEvent;
      invalid: boolean;
    }): void => {
      cp.messages.push(outcome.message);
      deps.emit(outcome.event);
      if (outcome.invalid || outcome.event.kind === "tool_result" && outcome.event.ok === false) {
        stepFailed = true;
      }
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
        calls.map((call, i) =>
          runOne(call, deps, step, specsByName, guard, {
            index: i,
            count: calls.length,
          }),
        ),
      );
      for (const outcome of outcomes) record(outcome);
    } else {
      for (const [i, call] of calls.entries()) {
        if (deps.shouldStop()) return finish(cp, deps, "stopped", lastStats);
        announce(call);
        record(
          await runOne(call, deps, step, specsByName, guard, {
            index: i,
            count: calls.length,
          }),
        );
        if (aborted) break;
      }
    }
    if (aborted) return finish(cp, deps, "stopped", lastStats);

    // Adaptive thinking: fold this step's outcome into the routine streak.
    // Only fully-routine steps extend it; anything else resets it AND restores
    // the configured level for the next step.
    if (deps.adaptiveThinking === true) {
      const outcome: StepOutcomeState = {
        toolCalls: calls.length,
        failed: stepFailed,
        reasoningChars: result.reasoning?.length ?? 0,
        pageChanging: calls.some((c) => PAGE_CHANGING_TOOLS.has(c.name)),
      };
      routineStreak = isRoutineStep(outcome) ? routineStreak + 1 : 0;
      const lower = routineStreak >= ADAPTIVE_ROUTINE_STREAK && thinking !== "off";
      if (lower && !adaptiveRoutine) {
        adaptiveRoutine = true;
        if (!adaptiveNoted) {
          adaptiveNoted = true;
          deps.emit({
            kind: "info",
            message:
              `adaptive thinking: ${routineStreak} routine steps in a row — sending routine steps with thinking off ` +
              "(the configured level returns on the first failure, navigation, empty reply or overrun)",
          });
        }
      } else if (!lower) {
        adaptiveRoutine = false;
      }
    }

    cp.stepIndex = step + 1;
    cp.updatedAt = Date.now();
    capCheckpointImages(cp.messages);
    await deps.save(cp);
  }
  return finish(cp, deps, "capped", lastStats, stepCap);
}

async function runOne(
  call: ToolCall,
  deps: LoopDeps,
  stepIndex: number,
  specs: Map<string, LlmToolSpec>,
  guard: StuckGuard,
  batch: ExecuteBatch,
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
  try {
    const res = await deps.execute(call.name, call.args, batch);
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
 *
 * Compaction is QUANTIZED, because a request prefix that shifts every step
 * costs far more than the tokens it saves. Messages are only ever shrunk, never
 * removed (an assistant tool-call must keep its matching tool result or the
 * wire is invalid), shrinking is monotone, and it happens only when the budget
 * has been crossed — after which the sweep runs well past the mark, so the next
 * steps send a byte-identical prefix and the provider's cache can hit. The
 * newest HISTORY_KEEP_RECENT messages are never touched.
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
  const size = (m: LlmMessage): number =>
    m.content.length +
    (m.toolCalls?.reduce((sum, tc) => sum + JSON.stringify(tc.args ?? {}).length, 0) ?? 0) +
    (m.images?.length ?? 0) * IMAGE_CHARS_EQUIV;
  const cap = Math.min(budgetChars, tokenBudget ? tokenBudget * 4 : Number.POSITIVE_INFINITY);
  const total = out.reduce((sum, m) => sum + size(m), 0);
  // Under budget: hand the history back untouched. This is the common case, and
  // the one that has to stay byte-stable for prompt caching to pay off.
  if (total <= cap) return out;

  // Over budget. Find where keeping must start for the tail to fit the
  // low-water target, then SNAP that point to a quantum so it holds still for
  // several steps and then jumps, instead of following the history one message
  // at a time. Rounding up collapses a little more than strictly needed, which
  // is the hysteresis that keeps the next steps untouched.
  const target = cap * HISTORY_LOW_WATER;
  let tail = 0;
  let cut = out.length;
  while (cut > 0 && tail <= target) {
    cut--;
    tail += size(out[cut]!);
  }
  const q = HISTORY_COMPACT_QUANTUM;
  const keepFrom = Math.max(
    0,
    Math.min(Math.ceil(cut / q) * q, out.length - HISTORY_KEEP_RECENT),
  );

  for (let i = 0; i < keepFrom; i++) {
    const m = out[i]!;
    if (m.role === "tool" && m.content.length > 64) {
      m.content = "[older tool result omitted]";
      m.images = undefined;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        // The id and name must survive (they pair with the tool result); the
        // arguments of an old call are dead weight the model never re-reads.
        if (JSON.stringify(tc.args ?? {}).length > TOOL_CALL_ARGS_KEEP_CHARS) {
          tc.args = { note: "args elided" };
        }
      }
    }
  }
  return out;
}
