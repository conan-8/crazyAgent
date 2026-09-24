// LLM providers: Anthropic Messages API and any OpenAI-compatible
// /chat/completions endpoint, both with SSE streaming and tool calls.
// Pure request/response shaping is exported for unit tests.
import type {
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResult,
  LlmTextSink,
  ToolCall,
} from "../../shared/llm";
import type { AgentSettings } from "../settings";

const ANTHROPIC_VERSION = "2023-06-01";

// ---------------- request shaping (pure) ----------------

export function toAnthropicMessages(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "user") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const img of m.images ?? []) content.push(toAnthropicImage(img));
      out.push({ role: "user", content });
      i++;
    } else if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({
        role: "assistant",
        content: content.length ? content : [{ type: "text", text: "…" }],
      });
      i++;
    } else {
      // Consecutive tool results merge into one user message (API rule).
      const blocks: unknown[] = [];
      while (i < messages.length && messages[i]!.role === "tool") {
        const t = messages[i]!;
        blocks.push({
          type: "tool_result",
          tool_use_id: t.toolCallId ?? "",
          content: t.content,
          ...(t.content.startsWith("ERROR") ? { is_error: true } : {}),
        });
        i++;
      }
      out.push({ role: "user", content: blocks });
    }
  }
  return out;
}

function toAnthropicImage(dataUrl: string): unknown {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(0, comma); // data:image/jpeg;base64
  const data = dataUrl.slice(comma + 1);
  const mediaType = meta.slice("data:".length).split(";")[0] ?? "image/jpeg";
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

export function buildAnthropicBody(
  req: LlmRequest,
  model: string,
): Record<string, unknown> {
  return {
    model,
    max_tokens: req.maxTokens ?? 4_096,
    system: req.system,
    tools: req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
    messages: toAnthropicMessages(req.messages),
    stream: true,
  };
}

export function toOpenAiMessages(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const content: unknown[] = [{ type: "text", text: m.content || "(see attached)" }];
      for (const img of m.images ?? []) {
        content.push({ type: "image_url", image_url: { url: img } });
      }
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.args),
                },
              })),
            }
          : {}),
      });
    } else {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: m.content,
      });
    }
  }
  return out;
}

export function buildOpenAiBody(
  req: LlmRequest,
  model: string,
): Record<string, unknown> {
  return {
    model,
    max_tokens: req.maxTokens ?? 4_096,
    messages: [
      { role: "system", content: req.system },
      ...toOpenAiMessages(req.messages),
    ],
    tools: req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    stream: true,
    stream_options: { include_usage: true },
  };
}

// ---------------- SSE aggregation ----------------

export interface StreamAggregator {
  feed(line: string): void;
  result(): LlmResult;
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export function anthropicAggregator(onText?: LlmTextSink): StreamAggregator {
  const blocks = new Map<number, { kind: string; id?: string; name?: string; text: string }>();
  let stopReason = "";
  const agg: StreamAggregator = {
    text: "",
    feed(line) {
      if (!line.startsWith("data:")) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        return;
      }
      const type = event.type as string;
      if (type === "content_block_start") {
        const cb = event.content_block as { type: string; id?: string; name?: string };
        blocks.set(event.index as number, {
          kind: cb.type,
          id: cb.id,
          name: cb.name,
          text: "",
        });
      } else if (type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; partial_json?: string };
        const block = blocks.get(event.index as number);
        if (!block) return;
        if (delta.type === "text_delta" && delta.text) {
          block.text += delta.text;
          agg.text += delta.text;
          onText?.(delta.text);
        } else if (delta.type === "input_json_delta") {
          block.text += delta.partial_json ?? "";
        }
      } else if (type === "message_delta") {
        const delta = event.delta as { stop_reason?: string };
        if (delta.stop_reason) stopReason = delta.stop_reason;
        const usage = (event as { usage?: { input_tokens?: number; output_tokens?: number } })
          .usage;
        if (usage) {
          agg.usage = {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
          };
        }
      }
    },
    result() {
      const toolCalls: ToolCall[] = [];
      for (const block of blocks.values()) {
        if (block.kind !== "tool_use") continue;
        toolCalls.push(makeToolCall(block.id ?? "", block.name ?? "", block.text));
      }
      return { text: agg.text, toolCalls, stopReason, usage: agg.usage };
    },
  };
  return agg;
}

export function openAiAggregator(onText?: LlmTextSink): StreamAggregator {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let stopReason = "";
  const agg: StreamAggregator = {
    text: "",
    feed(line) {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      const choice = (event.choices as Record<string, unknown>[] | undefined)?.[0];
      if (!choice) return;
      const delta = (choice.delta ?? {}) as {
        content?: string | null;
        tool_calls?: Record<string, unknown>[];
      };
      if (delta.content) {
        agg.text += delta.content;
        onText?.(delta.content);
      }
      for (const chunk of delta.tool_calls ?? []) {
        const index = (chunk.index as number) ?? 0;
        const call = calls.get(index) ?? { id: "", name: "", args: "" };
        const fn = (chunk.function ?? {}) as { name?: string; arguments?: string };
        if (chunk.id) call.id = chunk.id as string;
        if (fn.name) call.name += fn.name;
        if (fn.arguments) call.args += fn.arguments;
        calls.set(index, call);
      }
      if (choice.finish_reason) stopReason = choice.finish_reason as string;
      const usage = (event as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }).usage;
      if (usage) {
        agg.usage = {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        };
      }
    },
    result() {
      const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, call]) => makeToolCall(call.id || `call_${index}`, call.name, call.args));
      return { text: agg.text, toolCalls, stopReason, usage: agg.usage };
    },
  };
  return agg;
}

function makeToolCall(id: string, name: string, argsText: string): ToolCall {
  try {
    const parsed = JSON.parse(argsText || "{}");
    return { id, name, args: parsed as Record<string, unknown> };
  } catch {
    return { id, name, args: {}, invalidJson: argsText };
  }
}

// ---------------- clients ----------------

async function readSse(
  res: Response,
  agg: StreamAggregator,
  signal?: AbortSignal,
): Promise<LlmResult> {
  if (!res.body) throw new Error(`empty stream (HTTP ${res.status})`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) agg.feed(line.trim());
  }
  return agg.result();
}

class AnthropicClient implements LlmClient {
  constructor(private settings: AgentSettings) {}

  async complete(req: LlmRequest, onText?: LlmTextSink, signal?: AbortSignal): Promise<LlmResult> {
    const res = await fetch(`${this.settings.baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.settings.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(buildAnthropicBody(req, this.settings.model)),
    });
    return readSse(res, anthropicAggregator(onText), signal);
  }
}

class OpenAiCompatClient implements LlmClient {
  constructor(private settings: AgentSettings) {}

  async complete(req: LlmRequest, onText?: LlmTextSink, signal?: AbortSignal): Promise<LlmResult> {
    const res = await fetch(`${this.settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify(buildOpenAiBody(req, this.settings.model)),
    });
    return readSse(res, openAiAggregator(onText), signal);
  }
}

export function createLlmClient(settings: AgentSettings): LlmClient {
  return settings.provider === "anthropic"
    ? new AnthropicClient(settings)
    : new OpenAiCompatClient(settings);
}
