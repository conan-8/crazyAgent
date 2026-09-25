// LLM providers: Anthropic Messages API and any OpenAI-compatible
// /chat/completions endpoint, both with SSE streaming and tool calls.
// Pure request/response shaping is exported for unit tests.
import type {
  LlmClient,
  LlmMessage,
  LlmReasoningSink,
  LlmRequest,
  LlmResult,
  LlmTextSink,
  ToolCall,
} from "../../shared/llm";
import { thinkingBudgetFor } from "../../shared/llm";
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
      // Anthropic extended thinking + tool use: the thinking block (with its
      // signature) must lead the assistant turn and be replayed verbatim.
      // Guard on a non-empty signature — an unsigned thinking block is itself
      // rejected by the API, so omit it rather than send an invalid one.
      if (m.thinking && m.thinkingSignature) {
        content.push({
          type: "thinking",
          thinking: m.thinking,
          signature: m.thinkingSignature,
        });
      }
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

/** Anthropic models that predate extended thinking (would 400 on `thinking`). */
function anthropicSupportsThinking(model: string): boolean {
  return !/claude-(?:2|instant|3-5|3-(?:haiku|sonnet|opus))/i.test(model);
}

export function buildAnthropicBody(
  req: LlmRequest,
  model: string,
): Record<string, unknown> {
  const tools = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  // Prompt caching: tools and system are byte-stable across the run's steps,
  // so marking them ephemeral lets the API bill them as cache reads (~90%
  // cheaper) instead of re-processing the whole prefix every step.
  if (tools.length) {
    (tools[tools.length - 1] as Record<string, unknown>).cache_control = {
      type: "ephemeral",
    };
  }
  // The per-run appendix is its own block WITHOUT a cache breakpoint: the
  // cached prefix (base system + tools) stays reusable across runs while the
  // appendix changes freely.
  const system: unknown[] = [
    {
      type: "text",
      text: req.system,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (req.systemSuffix) system.push({ type: "text", text: req.systemSuffix });
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? 4_096,
    system,
    tools,
    messages: toAnthropicMessages(req.messages),
    stream: true,
  };
  const level = req.thinking ?? "off";
  if (level !== "off" && anthropicSupportsThinking(model)) {
    // Extended thinking requires max_tokens > thinking.budget_tokens, so lift
    // the cap when the level's budget would otherwise exceed it.
    const budget = thinkingBudgetFor(level);
    body.thinking = { type: "enabled", budget_tokens: budget };
    const cap = (body.max_tokens as number) ?? 4_096;
    if (cap <= budget) body.max_tokens = budget + 1_024;
    // Temperature is incompatible with extended thinking — omit it if set.
    delete body.temperature;
  }
  return body;
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

/** OpenAI's own reasoners (o-series, GPT-5) — the ones that take `reasoning_effort`. */
function isOpenAiReasoner(model: string): boolean {
  return /^(?:o\d|gpt-5)/i.test(model);
}

export function buildOpenAiBody(
  req: LlmRequest,
  model: string,
  opts: { baseUrl?: string } = {},
): Record<string, unknown> {
  // api.openai.com rejects unknown body params outright, so thinking knobs are
  // only sent there for models that support them; other gateways (OpenRouter,
  // vLLM, DeepSeek, Ollama, …) tolerate or honor the extra fields.
  const strictOpenAi = (opts.baseUrl ?? "").includes("api.openai.com");
  const reasoner = isOpenAiReasoner(model);
  const level = req.thinking ?? "off";
  const body: Record<string, unknown> = {
    model,
    // OpenAI reasoners require max_completion_tokens; everyone else max_tokens.
    [strictOpenAi && reasoner ? "max_completion_tokens" : "max_tokens"]:
      req.maxTokens ?? 4_096,
    messages: [
      // One system message on this wire: the appendix (lessons learned) is
      // appended to the base prompt, keeping the cacheable prefix first.
      { role: "system", content: req.systemSuffix ? `${req.system}\n\n${req.systemSuffix}` : req.system },
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
  if (level !== "off") {
    if (!strictOpenAi) {
      // vLLM/SGLang-style switch; most OpenAI-compatible servers ignore unknown
      // fields, and DeepSeek reasoners emit reasoning_content unprompted.
      body.enable_thinking = true;
      body.chat_template_kwargs = { enable_thinking: true };
      body.reasoning_effort = level;
    } else if (reasoner) {
      body.reasoning_effort = level;
    }
  }
  return body;
}

// ---------------- SSE aggregation ----------------

export interface StreamAggregator {
  feed(line: string): void;
  result(): LlmResult;
  text: string;
  /** Accumulated reasoning text, when the model streamed any. */
  reasoning?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export function anthropicAggregator(
  onText?: LlmTextSink,
  onReasoning?: LlmReasoningSink,
): StreamAggregator {
  const blocks = new Map<
    number,
    { kind: string; id?: string; name?: string; text: string; signature?: string }
  >();
  let stopReason = "";
  let reasoning = "";
  let signature = "";
  const agg: StreamAggregator = {
    text: "",
    get reasoning() {
      return reasoning;
    },
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
        const cb = event.content_block as {
          type: string;
          id?: string;
          name?: string;
          signature?: string;
        };
        blocks.set(event.index as number, {
          kind: cb.type,
          id: cb.id,
          name: cb.name,
          text: "",
          signature: cb.signature,
        });
      } else if (type === "content_block_delta") {
        const delta = event.delta as {
          type: string;
          text?: string;
          partial_json?: string;
          thinking?: string;
          signature?: string;
        };
        const block = blocks.get(event.index as number);
        if (!block) return;
        if (delta.type === "thinking_delta" && delta.thinking) {
          // Extended-thinking output: keep it out of `text` so it never
          // reaches the transcript as assistant prose.
          reasoning += delta.thinking;
          block.text += delta.thinking;
          onReasoning?.(delta.thinking);
        } else if (delta.type === "signature_delta" && delta.signature) {
          // Cryptographic signature for the thinking block — must be replayed
          // verbatim next turn or Anthropic rejects the tool-use continuation.
          signature += delta.signature;
          block.signature = (block.signature ?? "") + delta.signature;
        } else if (delta.type === "text_delta" && delta.text) {
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
      return {
        text: agg.text,
        toolCalls,
        stopReason,
        usage: agg.usage,
        reasoning: reasoning || undefined,
        reasoningSignature: signature || undefined,
      };
    },
  };
  return agg;
}

export function openAiAggregator(
  onText?: LlmTextSink,
  onReasoning?: LlmReasoningSink,
): StreamAggregator {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let stopReason = "";
  let reasoning = "";
  const agg: StreamAggregator = {
    text: "",
    get reasoning() {
      return reasoning;
    },
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
        // DeepSeek/vLLM use `reasoning_content`; OpenAI-style gateways vary.
        reasoning_content?: string | null;
        reasoning?: string | null;
      };
      const think = delta.reasoning_content ?? delta.reasoning;
      if (think) {
        reasoning += think;
        onReasoning?.(think);
      }
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
      return {
        text: agg.text,
        toolCalls,
        stopReason,
        usage: agg.usage,
        reasoning: reasoning || undefined,
      };
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

  async complete(
    req: LlmRequest,
    onText?: LlmTextSink,
    signal?: AbortSignal,
    onReasoning?: LlmReasoningSink,
  ): Promise<LlmResult> {
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
    return readSse(res, anthropicAggregator(onText, onReasoning), signal);
  }
}

class OpenAiCompatClient implements LlmClient {
  constructor(private settings: AgentSettings) {}

  async complete(
    req: LlmRequest,
    onText?: LlmTextSink,
    signal?: AbortSignal,
    onReasoning?: LlmReasoningSink,
  ): Promise<LlmResult> {
    const res = await fetch(`${this.settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify(
        buildOpenAiBody(req, this.settings.model, { baseUrl: this.settings.baseUrl }),
      ),
    });
    return readSse(res, openAiAggregator(onText, onReasoning), signal);
  }
}

export function createLlmClient(settings: AgentSettings): LlmClient {
  return settings.provider === "anthropic"
    ? new AnthropicClient(settings)
    : new OpenAiCompatClient(settings);
}
