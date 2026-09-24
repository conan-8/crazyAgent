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

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  maxTokens?: number;
}

export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  /** Provider-reported usage when available (else the loop estimates). */
  usage?: { inputTokens: number; outputTokens: number };
}

export type LlmTextSink = (text: string) => void;

export interface LlmClient {
  complete(
    req: LlmRequest,
    onText?: LlmTextSink,
    signal?: AbortSignal,
  ): Promise<LlmResult>;
}
