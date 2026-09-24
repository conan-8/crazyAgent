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
  /** Screenshot data URLs attached to this message (multimodal models). */
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
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  maxTokens?: number;
  /**
   * Ask the model to emit its reasoning ("thinking") before answering, at
   * the given effort level. Providers translate this per wire format; ones
   * without support ignore it rather than failing the turn.
   */
  thinking?: ThinkingLevel;
}

export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  /** Provider-reported usage when available (else the loop estimates). */
  usage?: { inputTokens: number; outputTokens: number };
  /** Streamed reasoning text, when the model emitted any. */
  reasoning?: string;
  /** Anthropic thinking-block signature, needed to replay it next turn. */
  reasoningSignature?: string;
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
