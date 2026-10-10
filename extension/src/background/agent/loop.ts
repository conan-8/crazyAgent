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
import { THINKING_LEVELS, thinkingBudgetFor } from "../../shared/llm";
import { JEV_EFFORT_CONFIDENCE, thinkingForEffort } from "../../shared/jev";
import {
  openTodos,
  type CallTimings,
  type Checkpoint,
  type MalformedCall,
  type RunStats,
  type StepEvent,
} from "../../shared/protocol";
import { missingTarget } from "../../shared/coords";
import { planDocsOp } from "../../shared/docs-ops";
import { validateToolArgs } from "../tools/types";
import { estimateTokens } from "../../shared/modes";
import { madmanExclamation, madmanLabel } from "../../shared/madman";
import { buildSystemPrompt, buildSystemVolatile } from "./prompts";

export type AgentOutcome = "completed" | "stopped" | "capped";

/**
 * The harness's own check of one action (Phase B effect verification + declared
 * expectations). Internal: it rides `ExecuteResult` so the program executor can
 * decide "advance or stop" without parsing result text, and it never reaches
 * the model or the panel as a field (its human-readable lines do, in `text`).
 */
export interface ActionVerify {
  /** Did the page/frame visibly change? */
  effect?: "changed" | "unchanged" | "unknown";
  /** Outcome of the step's declared `expect`, when it carried one. */
  expect?: "verified" | "failed" | "unverified";
  /** The verification line, for compact program reports. */
  expectDetail?: string;
  /** The harness re-aimed a coordinate click that had missed every control. */
  repaired?: boolean;
}

export interface ExecuteResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
  /** Screenshot data URL produced by this tool, if any. */
  image?: string;
  /** Pre-formatted compact text for the LLM (instead of raw JSON). */
  text?: string;
  /** The harness's structured verdict for this action (see ActionVerify). */
  verify?: ActionVerify;
  /**
   * The Jev risk layer checked this mutating action and allowed it. Passed
   * through to the tool_result event so the panel can mark the card.
   */
  jevGate?: boolean;
  /**
   * Jev per-step routing verdicts from this call's risk-gate POST (they ride
   * the same request — zero extra round trips). The loop consumes each once:
   * the effort hint shapes the NEXT step's thinking level, the progress
   * verdict may arm one coaching line. Both are dropped on any surprise.
   */
  jevEffort?: { choice: string; confidence: number };
  jevProgress?: { choice: string; confidence: number };
  /** Where this call's wall clock went (probe/gate/tool/observe/capture). */
  timings?: CallTimings;
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
  /**
   * The user's configured thinking level BEFORE any routing lowered it — the
   * ceiling per-step effort routing may raise back to (a "simple"-graded run
   * can hit a hard step). Omitted = `thinking` is already the ceiling.
   */
  thinkingCeiling?: ThinkingLevel;
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
   * Window isolation: the user granted THIS run read-only access to their
   * other windows' tabs ("look outside"), so the prompt says so while still
   * forbidding any action outside the agent window. See prompts.windowRules.
   */
  windowPeek?: boolean;
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
  /** Mid-stream silence ceiling (see STREAM_IDLE_MS); 0/Infinity disables. */
  streamIdleMs?: number;
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
 * Mid-stream silence guard: once tokens have started, an attempt that goes
 * this long without another delta is aborted and retried like a stall. The
 * TTFT guard stops watching at the first token, so a stream that died after
 * it (the 530s step of the 2026-10-08 run ended in a network error) had
 * nothing watching it at all.
 */
export const STREAM_IDLE_MS = 30_000;

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
 * Reasoning ceiling for a step sent at "off". Off is a request, not a
 * guarantee: on the 2026-10-08 endpoint the 14 steps sent at off still
 * streamed a median 8,416 reasoning chars (max 44,753), and with no cap at
 * off the loop's own "turn thinking off" fallback removed the only bound.
 * An endpoint that honours off never streams reasoning, so it never reaches
 * this.
 */
export const OFF_REASONING_CAP_CHARS = 8_192;

/** How much of a cut reasoning stream the re-ask is handed back. */
const SALVAGE_TAIL_CHARS = 1_500;

/** Reasoning at "off" past this marks the endpoint as ignoring the knob. */
const OFF_IGNORED_CHARS = 500;

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

/**
 * Confidence floor for acting on a Jev `progress` verdict. Higher than the
 * effort floor on purpose: the consequence here is a coaching line the model
 * reads mid-run, and a false "stuck" accusation on a working sequence is
 * more disruptive than a missed lowering.
 */
export const JEV_PROGRESS_CONFIDENCE = 0.7;

/** Rank of a thinking level in [off..high] — raise/lower bookkeeping. */
function levelRank(level: ThinkingLevel): number {
  return THINKING_LEVELS.findIndex((l) => l.value === level);
}

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
 * How many capped steps before thinking is switched off for the REST of the
 * run. Each cap costs a second round trip, so a model that overruns
 * every step is paying double to keep a habit that is not paying for itself;
 * after this many, the loop stops asking for thinking at all and says so.
 */
const MAX_REASONING_OVERRUNS = 3;

/**
 * How many times a "final" answer with unfinished plan items is bounced back
 * before the run is allowed to end with an honest unfinished summary. Two is
 * enough for a model that simply forgot to keep the plan current, and bounded
 * so a model that refuses to continue cannot hold the run hostage.
 */
const MAX_COMPLETION_NUDGES = 2;

/**
 * Consecutive turns carrying a malformed call before requests go out
 * non-streamed. A dropped SSE fragment can leave valid-but-incomplete JSON
 * (`,"y":146` vanishing keeps the object parseable), so a streaming fault
 * looks exactly like a model fault. The fallback both routes around it and,
 * logged per turn, tells the two apart.
 */
export const MALFORMED_STREAK_FALLBACK = 2;
/** Turns a fallback stays non-streamed before streaming is tried again. */
export const UNSTREAMED_TURNS = 8;
/** Whole-request ceiling when there is no delta stream to watch for stalls. */
export const UNSTREAMED_TIMEOUT_MS = 180_000;
/** First stall nudge after this many steps in a row where nothing executed… */
export const STALL_NUDGE_FIRST = 3;
/** …then again every this many. Nudges only: the run never ends on this. */
export const STALL_NUDGE_EVERY = 5;
const MALFORMED_RAW_CHARS = 300;

/** Example of a complete call for the tools whose target shape is not schema-enforced. */
const COMPLETE_CALL_EXAMPLE: Record<string, string> = {
  click_at: `click_at {"x": 412, "y": 233, "space": "screenshot"} or click_at {"ref": "e12"}`,
  hover_at: `hover_at {"x": 412, "y": 233, "space": "screenshot"}`,
  type_at: `type_at {"x": 412, "y": 233, "space": "screenshot", "text": "…"}`,
  element_at: `element_at {"x": 412, "y": 233, "space": "screenshot"}`,
  drag_at: `drag_at {"x": 100, "y": 200, "to_x": 300, "to_y": 200, "space": "screenshot"}`,
  docs_op: `docs_op {"op": "apply_style", "style": "Heading 1"}`,
};

/**
 * Why a call cannot run as sent, or null when it can. Pure — the loop drops
 * such calls BEFORE the assistant turn is committed, so a corrupted call never
 * becomes an example the model copies (7× `{op:'apply_style',cols:0}`, 35×
 * `{space,expect}` in one run) and never feeds the identical-call ban.
 */
export function precheckCall(call: ToolCall, specs: Map<string, LlmToolSpec>): string | null {
  if (call.invalidJson !== undefined) return "the arguments were not valid JSON";
  const spec = specs.get(call.name);
  if (!spec) return `there is no tool named '${call.name}'`;
  const validation = validateToolArgs(spec, call.args);
  if (validation.error) return validation.error.replace(/^ERROR:\s*/, "");
  const missing = missingTarget(call.name, call.args);
  if (missing) return `${missing} missing`;
  if (call.name === "docs_op") {
    const planned = planDocsOp(call.args.op, call.args);
    if (!planned.ok) return planned.error.replace(/^INPUT-FAILED:\s*/, "");
  }
  return null;
}

/** The in-band notice for calls that were dropped instead of executed. */
export function malformedHint(dropped: { call: ToolCall; reason: string }[]): string {
  const lines = dropped.map(({ call, reason }) => {
    const arrived =
      call.invalidJson !== undefined
        ? `unparseable arguments ${JSON.stringify(call.invalidJson.slice(0, 120))}`
        : `{${Object.keys(call.args).join(", ")}}`;
    const example = COMPLETE_CALL_EXAMPLE[call.name];
    return `- ${call.name} arrived as ${arrived} — ${reason}.${example ? ` Complete form: ${example}` : ""}`;
  });
  return (
    `[harness] ${dropped.length === 1 ? "This call was" : "These calls were"} NOT executed and NOT kept in history ` +
    `(your turn shows only the complete calls):\n${lines.join("\n")}\n` +
    "Re-issue with every argument present if it is still the right move."
  );
}

/** The escalating nudge after steps in a row where nothing executed. */
export function stallNudge(streak: number, recent: ToolCall[]): string {
  const echoed = recent
    .slice(-4)
    .map((c) => `- ${c.name} ${clip(c.invalidJson ?? JSON.stringify(c.args), 160)}`)
    .join("\n");
  return (
    `[harness] ${streak} steps in a row have executed nothing (each call was blocked, invalid or dropped). Your last calls:\n` +
    `${echoed || "- (none)"}\n` +
    "Before the next call: state in one sentence what the page shows right now. Then take a DIFFERENT route " +
    "(another tool, another control, a menu path by label) — or, if this item cannot be done, rewrite the plan " +
    'with todo_write marking it "blocked" with a one-line reason, and move to the next item.'
  );
}

export function shouldStallNudge(streak: number): boolean {
  return (
    streak === STALL_NUDGE_FIRST ||
    (streak > STALL_NUDGE_FIRST && (streak - STALL_NUDGE_FIRST) % STALL_NUDGE_EVERY === 0)
  );
}

/**
 * Steps without a todo_write, while the plan has open items, before the
 * harness asks for a plan update. A run that stops ticking its plan is
 * usually spiralling on one item (the 641s header-colour spiral never
 * touched the plan); the nudge makes it account for that item.
 */
export const TODO_STALE_STEPS = 30;

export function todoStaleNudge(open: { content: string }[], steps: number): string {
  const listed = open
    .slice(0, 5)
    .map((t) => `- ${t.content}`)
    .join("\n");
  const more = open.length > 5 ? `\n…and ${open.length - 5} more.` : "";
  return (
    `[harness] ${steps} steps since the plan was last updated, and it still has ${open.length} open item(s):\n` +
    `${listed}${more}\n` +
    "Update it now with todo_write: mark what is done (and verified), and if the current item is not " +
    'moving, mark it "blocked" with a one-line reason and go to the next one.'
  );
}
/**
 * Ceiling on the RAW checkpoint's message chars (see boundCheckpoint). Four
 * times the per-step budget, so the model's visible history is untouched in
 * the common case — this only ever bites on the long runs that used to die.
 */
const CHECKPOINT_MAX_CHARS = HISTORY_BUDGET_CHARS * 4;
/** Where a bound-triggered compaction trims to (hysteresis, like the view). */
const CHECKPOINT_COMPACT_CHARS = HISTORY_BUDGET_CHARS * 2;

/**
 * Bound the checkpoint by DROPPING its oldest messages.
 *
 * `truncateHistory` only elides content inside a COPY — that is the model's
 * per-step view. `cp.messages` itself kept every message of the whole run, so
 * each step re-mapped and re-serialized the lot, and memory grew without
 * limit: three field runs died silently at 1.83M / 2.54M / 2.74M chars (the
 * service worker stopped mid-turn — run E's turn 340 never ended and the run
 * sat "running" forever with nothing in the log to say why).
 *
 * The cut never starts on a `tool` message, so a tool result can never be
 * orphaned from the assistant call that produced it; a synthetic user line
 * records the drop in-band, because a silently shortened transcript is how a
 * model ends up "remembering" a document it can no longer see.
 */
export function boundCheckpoint(messages: LlmMessage[]): {
  messages: LlmMessage[];
  dropped: number;
} {
  const size = (m: LlmMessage): number =>
    m.content.length +
    (m.toolCalls?.reduce((sum, tc) => sum + JSON.stringify(tc.args ?? {}).length, 0) ?? 0) +
    (m.images?.length ?? 0) * IMAGE_CHARS_EQUIV;
  let total = 0;
  for (const m of messages) total += size(m);
  if (total <= CHECKPOINT_MAX_CHARS) return { messages, dropped: 0 };

  const target = CHECKPOINT_COMPACT_CHARS;
  let tail = 0;
  let cut = messages.length;
  while (cut > 0 && tail <= target) {
    cut--;
    tail += size(messages[cut]!);
  }
  while (cut < messages.length && messages[cut]!.role === "tool") cut++;
  const dropped = cut;
  if (dropped <= 0) return { messages, dropped: 0 };
  return {
    messages: [
      {
        role: "user",
        content:
          `[harness] ${dropped} older message(s) were compacted away to bound this run's memory. ` +
          "The task, the live plan (todos) and everything recent are intact — re-read the page or the " +
          "document if you need an older detail instead of assuming it.",
      },
      ...messages.slice(cut),
    ],
    dropped,
  };
}

/**
 * The reasoning ceiling for one step, in CHARACTERS. Derived from the level's
 * own token budget at the same chars/4 ratio the rest of the token math uses;
 * "off" gets OFF_REASONING_CAP_CHARS — never unbounded.
 */
export function reasoningCapChars(level: ThinkingLevel | undefined): number {
  const budget = thinkingBudgetFor(level ?? "off");
  return budget > 0 ? budget * 4 * REASONING_OVERRUN_FACTOR : OFF_REASONING_CAP_CHARS;
}

/**
 * The re-ask after a reasoning cut. It carries the tail of the thinking that
 * was cut, so the model acts on its own conclusions instead of re-deriving
 * them — on an endpoint that ignores "off", a bare re-ask just thinks again.
 */
function salvageNote(tail: string): string {
  return (
    "[harness] Your reasoning for this step ran past the limit and was cut. " +
    (tail.trim() ? `It ended with:\n<<<\n${tail.trim()}\n>>>\n` : "") +
    "Do not deliberate further: emit the next tool call(s) now, or the final answer if the task is done."
  );
}

/**
 * What the loop tells a model whose last reply carried no answer and no tool
 * call. It lands as an ordinary user turn, so it survives checkpointing and
 * the model sees its own dead end.
 */
function emptyReplyNudge(truncated: boolean, reasoningCut = false): string {
  return (
    "[harness] Your previous reply arrived EMPTY — no answer text and no tool calls" +
    (reasoningCut
      ? " (it reasoned past the limit twice and was cut both times — act without deliberating)"
      : truncated
        ? " (the output token limit cut it off mid-stream)"
        : "") +
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
 * Checkpoint health pulse for the run log: how much state the worker carries
 * (history text, live images and their bytes) at every per-step save. When a
 * service worker dies silently — the record stays `running`, no error is
 * ever written — the tail of this trace is the crash evidence: climbing
 * numbers point at memory, flat ones point elsewhere. String-length sums
 * only; measuring must not re-create the serialization churn it diagnoses.
 */
function emitHeartbeat(deps: LoopDeps, cp: Checkpoint): void {
  let historyChars = 0;
  let images = 0;
  let imageBytes = 0;
  for (const m of cp.messages) {
    historyChars += m.content?.length ?? 0;
    for (const img of m.images ?? []) {
      images += 1;
      imageBytes += img.length;
    }
  }
  deps.emit({
    kind: "heartbeat",
    stepIndex: cp.stepIndex,
    historyChars,
    images,
    imageBytes,
  });
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
  "docs_read", // SW-side export fetch — never touches the page at all
  "docs_state", // read-only DOM chrome queries — never touches page state
  "judge", // read-only external decision call — never touches page state
  "todo_write", // pure plan state (panel dropdown) — never touches page state
  "progress_note", // pure narration state (panel bubble) — never touches page state
]);

/**
 * Stuck-loop detection — ENFORCED, not advisory. A live run spent 15 turns
 * re-running a frame probe that failed identically every time, then 9 more on
 * a doomed workaround; another retried a failing clipboard paste "one more
 * time" twice, because a warning in a tool result is ignorable and the model
 * ignored it. Advice alone does not stop a grind, so the ladder has teeth:
 *
 *   1st failure of an exact call → ordinary error (+ the RETRY WARNING note
 *                                  when the same call had already run).
 *   2nd failure of the SAME call → the note announces that a third identical
 *                                  attempt will not be executed at all.
 *   3rd identical attempt        → `blocked` REFUSES it: the call never
 *                                  reaches the executor, and the refusal text
 *                                  carries the moves that break the loop
 *                                  (look at the page, change target/tool, or
 *                                  mark the item blocked and move on).
 *
 * Three failures of the same tool in a row (fresh args each time) still land
 * the STUCK note — a different symptom (the tool itself is dying) with a
 * different remedy (look at the page instead of re-aiming).
 *
 * Wait tools are exempt from the SUCCESS-repeat note only: re-issuing a wait
 * with the same arguments is legitimate (waiting on the next reply of the
 * same page), while their FAILURES still count toward the streak AND the
 * identical-call ban like any other tool's — a wait that timed out twice on
 * the same arguments times out a third time; a LONGER `timeout_ms` is a
 * different call and stays allowed.
 */
export interface StuckGuard {
  note(name: string, args: Record<string, unknown>, failed: boolean): string;
  /**
   * Pre-execution check: a refusal message when this EXACT call has already
   * failed twice in this run (the third identical attempt is not executed —
   * see the ladder above), or null when the call may proceed.
   */
  blocked(name: string, args: Record<string, unknown>): string | null;
  /**
   * Arm a ONE-SHOT coaching line (the Jev progress verdict) that rides the
   * next tool result — whatever else that result says — and is then cleared.
   * Same in-band channel as the repeat warnings: the model sees it at the
   * exact moment it matters, and no prompt prefix mutates.
   */
  coach(message: string): void;
}

const WAIT_LIKE_TOOLS = new Set(["wait_for", "wait_for_settle"]);

/** Failures of one exact call before the identical-call ban kicks in. */
export const IDENTICAL_FAIL_BAN = 2;

/** Stable identity of an exact call — the ban and the repeat notes key on it. */
function callKey(name: string, args: Record<string, unknown>): string {
  try {
    return `${name}:${JSON.stringify(args ?? {})}`;
  } catch {
    return `${name}:(unserializable)`;
  }
}

export function createStuckGuard(): StuckGuard {
  const streak = new Map<string, number>();
  const calls = new Map<string, number>();
  /** Failures per EXACT call — the identical-call ban's counter. */
  const fails = new Map<string, number>();
  let coachNote = "";
  return {
    coach(message) {
      coachNote = `\n\n[Jev progress check — ${message}]`;
    },
    blocked(name, args) {
      const n = fails.get(callKey(name, args)) ?? 0;
      if (n < IDENTICAL_FAIL_BAN) return null;
      return (
        `[BLOCKED — NOT EXECUTED: this exact ${name} call has already failed ${n} times in this run, ` +
        "so the harness refuses to run it again — a third identical attempt produces the identical " +
        "failure and only burns a step. Break the loop with a DIFFERENT move: take a screenshot or " +
        "snapshot to see what the page actually shows now; attack the same goal by another route " +
        "(a ref instead of coordinates or vice versa, the keyboard instead of the mouse, another " +
        "tool entirely); or — if this step is genuinely impossible — mark its todo item blocked, " +
        "note why in one line, and MOVE ON to the next item instead of sinking the run here.]"
      );
    },
    note(name, args, failed) {
      // The armed coaching line rides this result and is consumed once.
      const coach = coachNote;
      coachNote = "";
      const key = callKey(name, args);
      const repeats = (calls.get(key) ?? 0) + 1;
      calls.set(key, repeats);
      const failedTimes = failed ? (fails.get(key) ?? 0) + 1 : (fails.get(key) ?? 0);
      if (failed) fails.set(key, failedTimes);
      const n = failed ? (streak.get(name) ?? 0) + 1 : 0;
      streak.set(name, n);
      // The ban announcement rides the SECOND identical failure, so the model
      // learns one step early that the next repeat is dead.
      const banLine =
        failed && failedTimes >= IDENTICAL_FAIL_BAN
          ? ` This exact call has now failed ${failedTimes} times — a THIRD identical attempt will NOT be executed at all. Change something real: the target, the tool, or the plan.`
          : "";
      if (failed && repeats > 1) {
        return `${coach}\n\n[RETRY WARNING: this exact call has already failed in this run — repeating it will fail again. Do NOT run it again. Change the approach; if you are unsure what the page shows, take a screenshot and look at it.${banLine}]`;
      }
      if (failed && n >= 3) {
        return `${coach}\n\n[STUCK: ${name} has now failed ${n} times in a row. Do not retry it. Take a screenshot to SEE what the page actually shows, switch to read_page / snapshot / ref-based tools, or report the blocker and stop.${banLine}]`;
      }
      if (repeats >= 3 && !WAIT_LIKE_TOOLS.has(name)) {
        return `${coach}\n\n[This exact call has now run ${repeats} times and returns the same thing — vary the approach instead of polling it again. If you are unsure what you are seeing, take a screenshot.]`;
      }
      return coach;
    },
  };
}

/**
 * One LLM call with retry + backoff on transient failures (429/5xx/network),
 * and a ceiling on runaway reasoning.
 *
 * `reasoningCap` is a character count (0 = uncapped). Past it the stream is cut
 * and the call comes back `capped` with NO result, so the caller re-asks the
 * step rather than waiting out a 98-second soliloquy. That abort is ours, so
 * it is not a transient failure and burns no retry. `reasoningTail` is the end
 * of what the cut attempt thought, for the re-ask to act on.
 *
 * `cappedChars` is every reasoning char this call generated and threw away —
 * the cut attempt's AND any attempt that died mid-stream before a retry —
 * because it was generated and paid for either way.
 *
 * Two silence guards share the abort controller: TTFT (nothing at all within
 * `ttftStallMs`) and mid-stream idle (no delta for `streamIdleMs` after the
 * stream started). Both count as transient failures and burn a retry.
 *
 * Timing: each ATTEMPT stamps its own request-start and first-token time, and
 * the returned `ttftMs`/`decodeMs` describe the attempt whose reply survived
 * (a failed attempt that never produced a token reports neither).
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
  reasoningTail?: string;
  ttftMs?: number;
  decodeMs?: number;
}> {
  let lastErr: unknown;
  let discarded = 0;
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
    let tail = "";
    // A non-streamed reply has no deltas: the silence guards would abort every
    // request at TTFT_STALL_MS and the cap would only fire after the whole
    // reasoning was paid for. One whole-request timeout replaces all three.
    const unstreamed = req.stream === false;
    const cap = unstreamed ? 0 : reasoningCap;
    const stallMs = unstreamed ? UNSTREAMED_TIMEOUT_MS : (deps.ttftStallMs ?? TTFT_STALL_MS);
    const guardStall = Number.isFinite(stallMs) && stallMs > 0;
    const idleMs = deps.streamIdleMs ?? STREAM_IDLE_MS;
    const guardIdle = !unstreamed && Number.isFinite(idleMs) && idleMs > 0;
    const ctl =
      cap > 0 || guardStall || guardIdle ? new AbortController() : undefined;
    const attemptStart = Date.now();
    let firstDeltaAt = 0;
    let idled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    // One timer, re-armed on every delta: before the first token it is the
    // TTFT guard, after it the idle guard.
    const mark = (): void => {
      if (!firstDeltaAt) firstDeltaAt = Date.now();
      clearTimer();
      if (ctl && guardIdle && !capped) {
        timer = setTimeout(() => {
          idled = true;
          ctl.abort();
        }, idleMs);
      }
    };
    if (ctl && guardStall) {
      timer = setTimeout(() => {
        if (!firstDeltaAt) ctl.abort();
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
          tail = (tail + t).slice(-SALVAGE_TAIL_CHARS);
          // Reasoning streams BEFORE the answer on every wire we speak, so
          // cutting here loses nothing but the thinking itself.
          if (cap > 0 && ctl && !capped && chars > cap) {
            capped = true;
            clearTimer();
            ctl.abort();
          }
          onReasoning(t);
        },
      );
      clearTimer();
      if (capped) {
        return { capped: true, cappedChars: discarded + chars, reasoningTail: tail };
      }
      return {
        result,
        capped: false,
        cappedChars: discarded,
        ttftMs: firstDeltaAt ? firstDeltaAt - attemptStart : undefined,
        decodeMs: firstDeltaAt ? Date.now() - firstDeltaAt : undefined,
      };
    } catch (err) {
      clearTimer();
      // Cutting the stream can surface as a rejection out of the reader rather
      // than a graceful end. Either way this is the cap doing its job.
      if (capped) return { capped: true, cappedChars: discarded + chars, reasoningTail: tail };
      discarded += chars;
      if (ctl?.signal.aborted && !firstDeltaAt) {
        lastErr = new Error(
          unstreamed
            ? `no non-streamed reply within ${(stallMs / 1000).toFixed(0)}s, attempt aborted`
            : `stalled — no first token for ${(stallMs / 1000).toFixed(0)}s, attempt aborted`,
        );
      } else if (idled) {
        lastErr = new Error(
          `stream went silent for ${(idleMs / 1000).toFixed(0)}s mid-reply, attempt aborted`,
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
  // Times a final answer was bounced back because the plan still had open
  // items (see the completion gate below).
  let completionNudges = 0;
  // Turns in a row that carried a malformed call, and how many upcoming turns
  // go out non-streamed because of it (see MALFORMED_STREAK_FALLBACK).
  let malformedTurns = 0;
  let unstreamedLeft = 0;
  // Steps in a row where no call reached the executor, and the calls they made.
  let idleSteps = 0;
  let idleCalls: ToolCall[] = [];
  let stepsSinceTodo = 0;
  // Effective thinking level. Starts at the configured one and is dropped to
  // "off" for the rest of the run once the reasoning cap has tripped
  // MAX_REASONING_OVERRUNS times (see reasoningCapChars and the counter below).
  let thinking = deps.thinking;
  // Reasoning cuts this RUN has paid for — deliberately NOT reset by a healthy
  // step. The old rule counted cuts in a row, so runs E and F (14 and 11 cuts,
  // never three consecutively) kept paying a wasted round trip each time and
  // never reached the downgrade: at `low` that was ~20 extra minutes of decode
  // in E alone. The budget a step overruns is thrown away regardless (the step
  // is re-asked at "off"), so three wasted cuts mean this run's ceiling is not
  // buying anything.
  let overruns = 0;
  // Said once per run: a step at "off" that reasoned anyway.
  let offIgnoredNoted = false;
  // Adaptive per-step thinking (deps.adaptiveThinking): consecutive routine
  // steps so far, whether subsequent steps are currently sent with thinking
  // off, and whether the lowering has been announced (once per run, not once
  // per step — the info is a state change, not a heartbeat).
  let routineStreak = 0;
  let adaptiveRoutine = false;
  let adaptiveNoted = false;
  // Jev per-step effort routing (Tier 1): the freshest effort verdict from
  // the risk-gate POST, held for exactly ONE step (consumed at the top of the
  // next step, dropped on any surprise), plus the once-per-run announcement
  // flag and the counters that make the payoff measurable in run stats.
  // `jevRoutineSticky` is what makes a confident "routine" verdict buy a RUN
  // of cheap steps instead of one: the local adaptive streak needs reasoning
  // under ADAPTIVE_ROUTINE_MAX_REASONING_CHARS, which a model thinking at
  // `low` never produces — the catch-22 that kept E and F at 3.6s decode per
  // step for their whole lives. Same contract as the adaptive path: any
  // surprise (failure, navigation, overrun, steering, empty reply) clears it.
  let pendingEffort: { choice: string; confidence: number } | null = null;
  let jevRoutineSticky = false;
  let jevEffortNoted = false;
  let effortApplied = 0;
  let effortRaised = 0;
  let effortDropped = 0;
  const thinkingCeiling = deps.thinkingCeiling ?? deps.thinking;
  const dropEffortHint = (): void => {
    if (pendingEffort) {
      pendingEffort = null;
      effortDropped += 1;
    }
  };
  /** A surprise ends the cheap-mode a Jev routine verdict bought. */
  const endStickyRoutine = (): void => {
    jevRoutineSticky = false;
  };
  // The stable system prompt (rules + task) is byte-identical for the whole
  // run — built once. Only the clock is per-step, and it rides in
  // systemVolatile at the END of the request so provider prompt caching hits
  // on everything expensive (rules, tool specs, the growing conversation).
  const systemPrompt = buildSystemPrompt(
    cp.task,
    deps.madman === true,
    deps.judgeAvailable === true,
    deps.batchActions === true,
    deps.windowPeek === true,
  );
  const prefixTokens =
    estimateTokens(systemPrompt) +
    estimateTokens(deps.lessonsBlock || "") +
    estimateTokens(JSON.stringify(tools));

  for (let step = cp.stepIndex; step < stepCap; step++) {
    if (deps.shouldStop()) return finish(cp, deps, "stopped", lastStats);
    deps.emit({ kind: "step_started", stepIndex: step });

    // Mid-run steering: whatever the user typed since the last step lands as
    // normal user messages this call will see. Steering is a surprise: any
    // pending effort hint dies with it, and so does a Jev-bought cheap mode.
    for (const text of deps.takeUserInput?.() ?? []) {
      if (text.trim()) {
        cp.messages.push({ role: "user", content: text });
        dropEffortHint();
        endStickyRoutine();
      }
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
    const bounded = boundCheckpoint(cp.messages);
    if (bounded.dropped > 0) {
      cp.messages = bounded.messages;
      deps.emit({
        kind: "info",
        message: `run memory bounded: dropped ${bounded.dropped} old message(s) from the checkpoint (the per-step view is unchanged)`,
      });
    }
    const history = truncateHistory(cp.messages, HISTORY_BUDGET_CHARS, historyTokenBudget);
    // Effective thinking for THIS step, cheapest certain signal first:
    // Tier 1 — the Jev effort hint from the last gate POST, consumed once
    // here (whether or not it changes the level) and clamped to the ceiling.
    // Tier 0 — the adaptive streak (local) or a sticky Jev "routine" verdict.
    // Baseline — the run level. The overrun machinery and the reasoning cap
    // keep operating on the RUN level; a hinted-down step just generates less.
    let effectiveThinking: ThinkingLevel | undefined = thinking;
    if (pendingEffort) {
      const hint = pendingEffort;
      pendingEffort = null;
      const routed = thinkingForEffort(hint, thinking, thinkingCeiling);
      if (routed !== undefined && routed !== thinking) {
        if (levelRank(routed) > levelRank(thinking ?? "off")) {
          effortRaised += 1;
          // `deep` is the one raise: it ends any cheap-mode immediately.
          endStickyRoutine();
        } else {
          effortApplied += 1;
          if (hint.choice === "routine" && hint.confidence >= JEV_EFFORT_CONFIDENCE) {
            jevRoutineSticky = true;
          }
        }
        if (!jevEffortNoted) {
          jevEffortNoted = true;
          deps.emit({
            kind: "info",
            jev: true,
            message:
              `Jev effort routing: this step runs at '${routed}' (run level '${thinking ?? "off"}')` +
              " — routine steps skip thinking, the configured ceiling returns on any surprise",
          });
        }
        effectiveThinking = routed;
      }
    }
    if (
      effectiveThinking === thinking &&
      thinking !== "off" &&
      (jevRoutineSticky || (deps.adaptiveThinking === true && adaptiveRoutine))
    ) {
      effectiveThinking = "off";
    }
    const unstreamedTurn = unstreamedLeft > 0;
    if (unstreamedTurn) {
      unstreamedLeft -= 1;
      // No delta stream means no reasoning cap: a non-streamed turn must not
      // be able to think unbounded before anything can stop it.
      effectiveThinking = "off";
    }
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
      ...(unstreamedTurn ? { stream: false } : {}),
    };
    const onText = (text: string): void => deps.emit({ kind: "token_delta", text });
    let streamedReasoning = 0;
    const onReasoning = (text: string): void => {
      streamedReasoning += text.length;
      deps.emit({ kind: "reasoning_delta", text });
    };
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
    // Both the step and its salvage re-ask overran: handled by the empty-reply
    // gate below rather than ending the run.
    let doubleCut = false;
    // Timing of the attempt whose reply survived (see completeWithRetry).
    let ttftMs: number | undefined;
    let decodeMs: number | undefined;
    try {
      const first = await completeWithRetry(
        deps,
        request,
        onText,
        onReasoning,
        reasoningCapChars(effectiveThinking),
      );
      cappedChars = first.cappedChars;
      ttftMs = first.ttftMs;
      decodeMs = first.decodeMs;
      if (first.capped || !first.result) {
        // The model was still thinking when the ceiling came down. Re-ask the
        // SAME step at off, handing back the tail of what it thought: the run
        // needs an actionable reply, and the model's own conclusions are
        // cheaper to act on than to re-derive.
        overruns += 1;
        // A reasoning overrun is the opposite of routine — adaptive lowering
        // (if any) lifts immediately, and any pending effort hint dies: the
        // next step must think at the full run level.
        routineStreak = 0;
        adaptiveRoutine = false;
        dropEffortHint();
        endStickyRoutine();
        deps.emit({
          kind: "info",
          message:
            `reasoning overran the ${effectiveThinking && effectiveThinking !== "off" ? `${thinkingBudgetFor(effectiveThinking)}-token budget for '${effectiveThinking}'` : `${OFF_REASONING_CAP_CHARS.toLocaleString()}-char ceiling for 'off'`}` +
            ` — cut the stream at ~${Math.ceil(cappedChars / 4).toLocaleString()} tokens and re-asked the step with its conclusions and thinking off`,
        });
        if (overruns >= MAX_REASONING_OVERRUNS && thinking !== "off") {
          thinking = "off";
          deps.emit({
            kind: "info",
            message: `${MAX_REASONING_OVERRUNS} steps have now overrun the reasoning budget on this run — thinking is off for the rest of this run (each cut was re-asked at off anyway, so the ceiling was only buying wasted round trips)`,
          });
        }
        const second = await completeWithRetry(
          deps,
          {
            ...request,
            thinking: "off",
            messages: [
              ...request.messages,
              { role: "user", content: salvageNote(first.reasoningTail ?? "") },
            ],
          },
          onText,
          onReasoning,
          OFF_REASONING_CAP_CHARS,
        );
        cappedChars += second.cappedChars;
        ttftMs = second.ttftMs;
        decodeMs = second.decodeMs;
        if (second.result && !second.capped) {
          result = second.result;
        } else {
          doubleCut = true;
          result = { text: "", toolCalls: [], stopReason: "reasoning_cap" };
        }
      } else {
        // NOTE: `overruns` deliberately survives a healthy step — see its
        // declaration. A run that keeps paying for cuts it then throws away
        // does not become healthy just because one step happened to fit.
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

    // Precheck BEFORE anything is committed: a call that cannot run as sent is
    // dropped from the turn (see precheckCall). Recorded raw, as the provider
    // delivered it, so the log can say where the corruption came from.
    const dropped: { call: ToolCall; reason: string }[] = [];
    for (const call of result.toolCalls) {
      const reason = precheckCall(call, specsByName);
      if (reason !== null) dropped.push({ call, reason });
    }
    const malformed: MalformedCall[] = dropped.map(({ call, reason }) => ({
      name: call.name,
      reason,
      raw: clip(
        result.rawArgs?.[call.id] ?? call.invalidJson ?? JSON.stringify(call.args),
        MALFORMED_RAW_CHARS,
      ),
    }));

    // Per-step timing split, once per turn: TTFT (prefill/queue) vs decode.
    // The effective thinking level rides along — the verification rig for
    // effort routing: reasoning chars per step vs THIS field is how the
    // payoff is measured, and how a gateway that silently ignores the knob
    // is exposed (level off + reasoning chars > 0 = knob not honored).
    deps.emit({
      kind: "turn_timing",
      stepIndex: step,
      ttftMs,
      decodeMs,
      reasoningChars: result.reasoning?.length ?? 0,
      thinking: effectiveThinking,
      upstream: result.upstream,
      malformed: malformed.length ? malformed : undefined,
    });
    if (
      !offIgnoredNoted &&
      (effectiveThinking ?? "off") === "off" &&
      Math.max((result.reasoning?.length ?? 0) + cappedChars, streamedReasoning) > OFF_IGNORED_CHARS
    ) {
      offIgnoredNoted = true;
      deps.emit({
        kind: "info",
        message: `this endpoint ignores thinking:off — a step sent at off streamed ${Math.max((result.reasoning?.length ?? 0) + cappedChars, streamedReasoning).toLocaleString()} reasoning chars. Every step stays under the ${OFF_REASONING_CAP_CHARS.toLocaleString()}-char ceiling regardless`,
      });
    }

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
      effortApplied: effortApplied || undefined,
      effortRaised: effortRaised || undefined,
      effortDropped: effortDropped || undefined,
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
      if (doubleCut) {
        deps.emit({
          kind: "info",
          message: "the salvage re-ask overran the reasoning ceiling too — asking the model to act without deliberating",
        });
      } else if (truncated && maxTokens < MAX_OUTPUT_TOKENS) {
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
      cp.messages.push({ role: "user", content: emptyReplyNudge(truncated, doubleCut) });
      // An empty reply is a surprise by definition: the routine streak (and
      // any adaptive lowering) resets so the next step thinks at full level,
      // and any pending effort hint dies with it.
      routineStreak = 0;
      adaptiveRoutine = false;
      dropEffortHint();
      endStickyRoutine();
      cp.stepIndex = step + 1;
      cp.updatedAt = Date.now();
      capCheckpointImages(cp.messages);
      await deps.save(cp);
      emitHeartbeat(deps, cp);
      continue;
    }
    emptyReplies = 0;

    if (dropped.length) {
      malformedTurns += 1;
      deps.emit({
        kind: "info",
        message:
          `dropped ${dropped.length} malformed call(s) — ${dropped.map((d) => `${d.call.name}: ${d.reason}`).join("; ")} — ` +
          "not executed, not kept in history",
      });
      if (malformedTurns >= MALFORMED_STREAK_FALLBACK && unstreamedLeft === 0 && !unstreamedTurn) {
        unstreamedLeft = UNSTREAMED_TURNS;
        deps.emit({
          kind: "info",
          message:
            `${malformedTurns} turns in a row carried malformed tool calls — the next ${UNSTREAMED_TURNS} requests go out ` +
            "non-streamed (thinking off), to rule out a corrupted stream",
        });
      }
    } else {
      malformedTurns = 0;
    }
    const droppedIds = new Set(dropped.map((d) => d.call.id));
    const calls = result.toolCalls.filter((c) => !droppedIds.has(c.id));
    const hint = dropped.length ? malformedHint(dropped) : null;

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
    if (calls.length || result.text) {
      cp.messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: calls.length ? calls : undefined,
        // Persist reasoning only when Anthropic signed it: the signature marks a
        // thinking block that MUST be replayed on the tool-use continuation.
        // OpenAI/DeepSeek reasoning has no signature and is streamed live to the
        // UI only, so we don't bloat the checkpoint replaying it back.
        thinking: signedThinking,
        thinkingSignature: result.reasoningSignature || undefined,
      });
    }

    const noteIdle = (stepCalls: ToolCall[]): void => {
      idleSteps += 1;
      idleCalls = [...idleCalls, ...stepCalls].slice(-8);
      if (shouldStallNudge(idleSteps)) {
        cp.messages.push({ role: "user", content: stallNudge(idleSteps, idleCalls) });
        deps.emit({
          kind: "info",
          message: `${idleSteps} steps in a row executed nothing — nudging the model to re-read the page and change route`,
        });
      }
    };

    if (!calls.length && hint) {
      // Every call was dropped: this is not a final answer, whatever the text.
      cp.messages.push({ role: "user", content: hint });
      noteIdle(result.toolCalls);
      routineStreak = 0;
      adaptiveRoutine = false;
      dropEffortHint();
      endStickyRoutine();
      cp.stepIndex = step + 1;
      cp.updatedAt = Date.now();
      capCheckpointImages(cp.messages);
      await deps.save(cp);
      emitHeartbeat(deps, cp);
      continue;
    }

    if (!calls.length) {
      // Completion gate: a "final" answer while the live plan still owes work
      // is not a completion. Run D announced "12 of 32 verified, I need to
      // stop" and the run ended `done` with 19 items open — the user had to
      // type "continue then. why are you stopping if you can do it". The plan
      // (cp.todos, kept current by sw.ts on every todo_update) is the loop's
      // own record of what the run promised, so it gets a say here.
      //
      // The escape hatch is explicit and honest: mark items blocked (a status
      // the ladder has always told the model to use) and the run may end with
      // them. Bounded at MAX_COMPLETION_NUDGES so a stubborn model still stops.
      const open = openTodos(cp.todos);
      if (open.length > 0 && completionNudges < MAX_COMPLETION_NUDGES) {
        completionNudges += 1;
        const listed = open
          .slice(0, 8)
          .map((t) => `- ${t.content}`)
          .join("\n");
        const more = open.length > 8 ? `\n…and ${open.length - 8} more.` : "";
        cp.messages.push({
          role: "user",
          content:
            `[harness] Not finished — your own plan still has ${open.length} item(s) neither completed nor blocked:\n` +
            `${listed}${more}\n` +
            "An unfinished report is NOT a completion. Do the next item now. If an item is genuinely impossible " +
            'after real attempts, rewrite the plan with todo_write and mark that item "blocked" (one-line reason ' +
            "in its content), then carry on with the rest. Answer again only when every item is completed or " +
            `blocked. (Completion nudge ${completionNudges} of ${MAX_COMPLETION_NUDGES}.)`,
        });
        deps.emit({
          kind: "info",
          message: `final answer arrived with ${open.length} open plan item(s) — sending the model back to finish them or mark them blocked`,
        });
        cp.stepIndex = step + 1;
        cp.updatedAt = Date.now();
        await deps.save(cp);
        continue;
      }
      if (open.length > 0) {
        deps.emit({
          kind: "info",
          message:
            `finishing with ${open.length} plan item(s) still open after ${MAX_COMPLETION_NUDGES} completion nudges — ` +
            "the summary reports unfinished work",
        });
      }
      // Final answer — the task is done.
      cp.done = true;
      cp.updatedAt = Date.now();
      capCheckpointImages(cp.messages);
      await deps.save(cp);
      emitHeartbeat(deps, cp);
      deps.emit({
        kind: "done",
        summary: result.text.trim() || "task finished (no summary)",
        stats,
        outcome: "completed",
      });
      return "completed";
    }

    // Execute the batch: all-read-only batches run concurrently; anything
    // else stays sequential with a stop check between calls. Outcomes are
    // recorded in call order either way. There is deliberately NO cap on
    // steps that execute nothing: calls that cannot run are dropped before
    // they reach history (precheckCall), refused or invalid ones come back as
    // tool errors, and STALL_NUDGE_* escalates in-band — the run only ends on
    // a real answer, the step cap, an explicit stop, or the empty-reply bound.
    // Per-step outcome flags for the adaptive-thinking routine test.
    let stepFailed = false;
    let stepExecuted = false;
    // Freshest Jev routing verdicts from this step's gate calls (the LAST
    // stamped result wins — it saw the most recent page state). Cast
    // initializers: the assignments happen inside the record() closure, which
    // control-flow analysis cannot see — without the cast every read here
    // would narrow to null.
    let lastJevEffort = null as { choice: string; confidence: number } | null;
    let lastJevProgress = null as { choice: string; confidence: number } | null;
    const record = (outcome: {
      message: LlmMessage;
      event: StepEvent;
      invalid: boolean;
      executed: boolean;
    }): void => {
      cp.messages.push(outcome.message);
      deps.emit(outcome.event);
      if (outcome.executed) stepExecuted = true;
      if (outcome.event.kind === "tool_result") {
        if (outcome.event.jevEffort) lastJevEffort = outcome.event.jevEffort;
        if (outcome.event.jevProgress) lastJevProgress = outcome.event.jevProgress;
      }
      if (outcome.invalid || outcome.event.kind === "tool_result" && outcome.event.ok === false) {
        stepFailed = true;
      }
    };

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
      }
    }

    // After the tool results: the tool_use ↔ tool_result pairing stays intact.
    if (hint) {
      cp.messages.push({ role: "user", content: hint });
      stepFailed = true;
    }
    if (stepExecuted) {
      idleSteps = 0;
      idleCalls = [];
    } else {
      noteIdle(result.toolCalls);
    }

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

    // Jev Tier-1 consumption: the freshest effort verdict becomes the NEXT
    // step's one-shot hint — unless this step held a surprise (a failure or a
    // page-changing call), which drops any pending hint instead. These are
    // the same events that reset the adaptive streak: a hint never survives
    // one, so a wrong "routine" costs at most a single cheap step.
    // (Typed locals: the verdicts are assigned inside the record() closure,
    // which control-flow analysis cannot see.)
    const effortVerdict: { choice: string; confidence: number } | null = lastJevEffort;
    const progressVerdict: { choice: string; confidence: number } | null = lastJevProgress;
    if (stepFailed || calls.some((c) => PAGE_CHANGING_TOOLS.has(c.name))) {
      dropEffortHint();
      endStickyRoutine();
    } else if (effortVerdict) {
      pendingEffort = effortVerdict;
    }
    // Progress verdict → one coaching line riding the next tool result. Only
    // confident negatives act; "advancing" does nothing (praise is noise).
    // The guard's repeat warnings are string-equality based — this catches
    // the SEMANTIC loop they miss: same intent, varied coordinates.
    if (
      progressVerdict &&
      progressVerdict.confidence >= JEV_PROGRESS_CONFIDENCE &&
      (progressVerdict.choice === "stuck" || progressVerdict.choice === "treading_water")
    ) {
      guard.coach(
        progressVerdict.choice === "stuck"
          ? "the recent approach is not working — stop repeating it; look at the current page state, change strategy, or report the blocker"
          : "recent attempts are not changing the page state — vary the approach before trying again",
      );
    }

    if (calls.some((c) => c.name === "todo_write")) {
      stepsSinceTodo = 0;
    } else if (++stepsSinceTodo >= TODO_STALE_STEPS) {
      const open = openTodos(cp.todos);
      if (open.length > 0) {
        stepsSinceTodo = 0;
        cp.messages.push({ role: "user", content: todoStaleNudge(open, TODO_STALE_STEPS) });
        deps.emit({
          kind: "info",
          message: `${TODO_STALE_STEPS} steps without a plan update while ${open.length} item(s) are open — asking the model to update the plan`,
        });
      }
    }

    cp.stepIndex = step + 1;
    cp.updatedAt = Date.now();
    capCheckpointImages(cp.messages);
    await deps.save(cp);
    emitHeartbeat(deps, cp);
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
): Promise<{ message: LlmMessage; event: StepEvent; invalid: boolean; executed: boolean }> {
  if (call.invalidJson !== undefined) {
    const error = `ERROR: tool arguments were not valid JSON: ${call.invalidJson.slice(0, 200)}`;
    return {
      executed: false,
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
  // Identical-call ban (see createStuckGuard): an exact call that already
  // failed twice is REFUSED without touching the executor — the third
  // identical attempt would produce the identical failure and burn a full
  // round trip doing it. Not flagged `invalid` (the arguments are fine; the
  // plan behind them is what must change) — a blocked model should switch
  // approaches, not be told its call was malformed.
  const refusal = guard.blocked(call.name, call.args);
  if (refusal !== null) {
    return {
      executed: false,
      invalid: false,
      message: { role: "tool", toolCallId: call.id, content: refusal },
      event: {
        kind: "tool_result",
        stepIndex,
        name: call.name,
        result: refusal,
        ok: false,
      },
    };
  }
  // Validate against the frozen spec before touching the executor.
  const validation = validateToolArgs(specs.get(call.name), call.args);
  if (validation.error) {
    const error = validation.error;
    return {
      executed: false,
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
        executed: true,
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
          jevEffort: res.jevEffort,
          jevProgress: res.jevProgress,
          timings: res.timings,
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
      executed: true,
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
        jevEffort: res.jevEffort,
        jevProgress: res.jevProgress,
        timings: res.timings,
      },
    };
  } catch (err) {
    const error = String((err as Error)?.message ?? err);
    const content = `ERROR: ${error}${guard.note(call.name, call.args, true)}`;
    return {
      executed: true,
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
  deps.emit({
    kind: "done",
    summary,
    stats,
    outcome: outcome === "stopped" ? "stopped_by_user" : outcome,
  });
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
          // Underscored and phrased as harness metadata on purpose: a real run
          // copied `{"note":"args elided"}` out of its own history and sent it
          // back as a fresh todo_write call.
          tc.args = { _elided: "this older call's arguments were trimmed from history" };
        }
      }
    }
  }
  return out;
}
