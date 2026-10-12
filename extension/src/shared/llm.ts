// LLM-layer types shared by the agent loop, the providers and checkpoints.

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Set when the model's arguments were not valid JSON. */
  invalidJson?: string;
}

export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Assistant messages: tool calls the model requested. */
  toolCalls?: ToolCall[];
  /**
   * Assistant messages: the reasoning ("thinking") block the model emitted.
   * Anthropic requires it — with its signature — replayed on the next turn
   * when extended thinking + tool use are combined.
   */
  thinking?: string;
  /** Cryptographic signature accompanying an Anthropic thinking block. */
  thinkingSignature?: string;
  /** Tool messages: which call this result answers. */
  toolCallId?: string;
  /**
   * Screenshot data URLs attached to this message. The model takes image
   * input, so these ALWAYS ride along — the provider shapers place them where
   * each wire accepts images (Anthropic: inside tool_result; OpenAI: a
   * trailing user message, since its tool role is text-only).
   */
  images?: string[];
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

/**
 * Reasoning effort for models that expose "thinking". One knob, translated
 * per provider: Anthropic gets a token budget, vLLM/DeepSeek-style servers
 * get `enable_thinking`, OpenAI reasoners get `reasoning_effort`.
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

export const THINKING_LEVELS: {
  value: ThinkingLevel;
  label: string;
  hint: string;
  /** Anthropic extended-thinking budget (tokens) for this level. */
  budget: number;
}[] = [
  { value: "off", label: "Off", hint: "No thinking — fastest", budget: 0 },
  { value: "low", label: "Low", hint: "Brief thinking — small delay", budget: 1_024 },
  { value: "medium", label: "Medium", hint: "Balanced thinking for complex tasks", budget: 4_096 },
  { value: "high", label: "High", hint: "Deep thinking — slowest, best for hard problems", budget: 16_384 },
];

export function thinkingBudgetFor(level: ThinkingLevel): number {
  return THINKING_LEVELS.find((l) => l.value === level)?.budget ?? 0;
}

export interface LlmRequest {
  system: string;
  /**
   * Per-run appendix (e.g. lessons learned from previous runs), sent as a
   * SEPARATE system block after `system`. Splitting it out keeps the base
   * prompt byte-stable, so provider prompt caching still hits on the expensive
   * prefix while the appendix changes from run to run. Providers without
   * block-level system prompts concatenate the two.
   */
  systemSuffix?: string;
  /**
   * Per-STEP volatile tail (the wall clock). Placed LAST — after the cached
   * `system`, the per-run `systemSuffix`, and (on the OpenAI wire) the whole
   * conversation — so it never invalidates a cached prefix. A run once carried
   * the clock inside the cached system block, so every one of its 112 steps
   * re-prefilled the entire prompt from byte zero.
   */
  systemVolatile?: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  maxTokens?: number;
  /**
   * Ask the model to emit its reasoning ("thinking") before answering, at
   * the given effort level. Providers translate this per wire format; ones
   * without support ignore it rather than failing the turn.
   */
  thinking?: ThinkingLevel;
  /** `false` asks for one JSON reply instead of SSE (fallback when the stream looks corrupt). */
  stream?: boolean;
}

/**
 * What the wire looked like for one reply: who served it, and how many lines
 * the reader could not use. A reader that drops `,"y":146` silently still
 * yields valid JSON — these counters are the only trace such a loss leaves.
 */
export interface UpstreamInfo {
  /** OpenRouter's `provider` field on chunks (the actual upstream host). */
  provider?: string;
  model?: string;
  /** First 24 chars of the response id. */
  id?: string;
  fingerprint?: string;
  streamed: boolean;
  /** Non-empty lines that were neither `data:`, an SSE field, nor a comment. */
  nonDataLines: number;
  /** `data:` payloads that never parsed, even joined with the next one. */
  badJsonLines: number;
  /** `data:` payloads that only parsed joined with the following line. */
  joinedLines: number;
  /** First few offending lines, clipped. */
  samples?: string[];
}

export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  /**
   * Provider-reported usage when available (else the loop estimates).
   *
   * `cachedInputTokens` is the slice of `inputTokens` the provider served from
   * its prompt cache (Anthropic `cache_read_input_tokens`, OpenAI/OpenRouter
   * `prompt_tokens_details.cached_tokens`). It answers the one question the
   * latency numbers cannot: how much of each step's ~8k-token prefix was
   * re-prefilled from scratch. Undefined means "the provider did not say" —
   * never "zero".
   */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** Streamed reasoning text, when the model emitted any. */
  reasoning?: string;
  /** Anthropic thinking-block signature, needed to replay it next turn. */
  reasoningSignature?: string;
  upstream?: UpstreamInfo;
  /** Raw argument text per tool-call id, exactly as it arrived on the wire. */
  rawArgs?: Record<string, string>;
}

export type LlmTextSink = (text: string) => void;
export type LlmReasoningSink = (text: string) => void;

export interface LlmClient {
  complete(
    req: LlmRequest,
    onText?: LlmTextSink,
    signal?: AbortSignal,
    onReasoning?: LlmReasoningSink,
  ): Promise<LlmResult>;
}

// ---------------- failure taxonomy ----------------

/**
 * Structured error code an LLM failure can carry to the UI. Only credit-shaped
 * failures get one; everything else stays plain text so BYO users see exactly
 * what they saw before.
 */
export type LlmErrorCode = "out_of_credits" | "credits_service_dry" | "key_revoked";

/** Why an HTTP-level LLM call failed, when the body lets us tell. */
export type LlmFailureKind = LlmErrorCode | "in_flight_budget" | "transient";

/**
 * An HTTP failure from the provider, classified. The `message` is byte-identical
 * to the plain `Error` it replaces (`LLM API error <status>: <detail>`), so
 * existing tests and log-grep habits keep working; the class only ADDS the
 * classification the loop and the panel need.
 */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly kind: LlmFailureKind,
    readonly retryAfterMs?: number,
  ) {
    super(`LLM API error ${status}: ${detail.slice(0, 300)}`);
    this.name = "LlmHttpError";
  }
}

/**
 * OpenRouter's 402 is three different failures, told apart only by
 * `error.metadata.limit_source`:
 *
 *   openrouter_key_limit        the customer's prepaid ceiling — terminal
 *   openrouter_credits          the ORG balance is dry — terminal, OUR fault
 *   openrouter_in_flight_budget reservation of input + max_tokens — TRANSIENT
 *
 * The in-flight variant is estimated against `max_tokens`, which this app sets
 * to 8,192 and doubles to 32,000 on truncation — a customer with money left can
 * hit it on a big-context step. Treating every 402 as "buy more credit" would
 * accuse them of being broke when they are not, so the split is not optional.
 * A non-OpenRouter 402 (generic OpenAI-compatible gateway) still classifies as
 * `out_of_credits`: 402 is a payment-required status everywhere.
 */
export function classifyLlmFailure(
  status: number,
  body: string,
  retryAfter?: string | null,
): { kind: LlmFailureKind; retryAfterMs?: number } {
  let source: string | undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { metadata?: { limit_source?: unknown } };
    };
    const raw = parsed?.error?.metadata?.limit_source;
    if (typeof raw === "string") source = raw;
  } catch {
    // Not JSON — a plain-text gateway error; the bare status classifies it.
  }
  let kind: LlmFailureKind;
  if (status === 402) {
    if (source === "openrouter_credits") kind = "credits_service_dry";
    else if (source === "openrouter_in_flight_budget") kind = "in_flight_budget";
    else kind = "out_of_credits";
  } else if (status === 401) {
    kind = "key_revoked";
  } else {
    kind = "transient";
  }
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  return retryAfterMs === undefined ? { kind } : { kind, retryAfterMs };
}

/** `Retry-After` in seconds (the only form we act on), → ms. */
function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1_000);
}

/**
 * True when retrying cannot help. Deliberately 402-only: some gateways 401
 * transiently during key rotation and the retry can save a run, so `key_revoked`
 * is a UI concern, not a loop one.
 */
export function isTerminalLlmError(err: unknown): boolean {
  return err instanceof LlmHttpError && (err.kind === "out_of_credits" || err.kind === "credits_service_dry");
}

/** The structured code an error should carry on the wire, if any. */
export function llmErrorCode(err: unknown): LlmErrorCode | undefined {
  if (!(err instanceof LlmHttpError)) return undefined;
  if (err.kind === "out_of_credits" || err.kind === "credits_service_dry" || err.kind === "key_revoked") {
    return err.kind;
  }
  return undefined;
}

/**
 * Prose for the `error` event. Credit-shaped failures get a sentence that names
 * the cause; everything else keeps the historical `LLM call failed: …` shape.
 */
export function llmFailureMessage(err: unknown): string {
  const detail = String((err as Error)?.message ?? err);
  if (err instanceof LlmHttpError) {
    if (err.kind === "out_of_credits") {
      return "LLM call failed: this key has no credit left (HTTP 402). Top it up, then send “continue” — this thread keeps its context.";
    }
    if (err.kind === "credits_service_dry") {
      return "LLM call failed: the credits service is out of funds (HTTP 402) — that one is on the service, not your key.";
    }
    if (err.kind === "key_revoked") {
      return "LLM call failed: the API key was rejected (HTTP 401) — it may have been disabled or replaced.";
    }
  }
  return `LLM call failed: ${detail}`;
}
