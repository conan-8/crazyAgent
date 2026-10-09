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
  { value: "off", label: "Off", hint: "No reasoning block — fastest", budget: 0 },
  { value: "low", label: "Low", hint: "Brief reasoning — small latency cost", budget: 1_024 },
  { value: "medium", label: "Medium", hint: "Balanced reasoning for multi-step tasks", budget: 4_096 },
  { value: "high", label: "High", hint: "Deep reasoning — slowest, best on hard tasks", budget: 16_384 },
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
