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
  UpstreamInfo,
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
        // Screenshots ride INSIDE the tool_result block as image blocks —
        // dropping them here is what left the model blind to its own captures.
        const content = t.images?.length
          ? [
              { type: "text", text: t.content || "(screenshot attached)" },
              ...t.images.map(toAnthropicImage),
            ]
          : t.content;
        blocks.push({
          type: "tool_result",
          tool_use_id: t.toolCallId ?? "",
          content,
          ...(t.content.startsWith("ERROR") ? { is_error: true } : {}),
        });
        i++;
      }
      out.push({ role: "user", content: blocks });
    }
  }
  return mergeAdjacentRoles(out);
}

/**
 * Anthropic's wire wants strictly alternating roles, and the loop can leave
 * two same-role messages in a row: a dropped empty assistant turn, the
 * harness's "continue" nudge after a dead reply, or mid-run user steering all
 * produce runs like `tool results → user → user`. Merge adjacent same-role
 * messages (concatenating their content blocks) so those histories stay legal
 * here too — consecutive same-role messages are only free on the OpenAI wire.
 */
export function mergeAdjacentRoles(messages: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1] as
      | { role: string; content: unknown[] }
      | undefined;
    const cur = m as { role: string; content: unknown[] };
    if (
      prev &&
      prev.role === cur.role &&
      Array.isArray(prev.content) &&
      Array.isArray(cur.content)
    ) {
      prev.content = [...prev.content, ...cur.content];
      continue;
    }
    out.push(m);
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

/**
 * Anthropic tail: a rolling cache breakpoint on the last history block, then
 * the per-step volatile text (the clock) as the final block of the last user
 * message. The breakpoint makes each step's conversation a cached prefix for
 * the next step (only the new tail is re-prefilled); the clock rides AFTER it,
 * so a ticking clock can never invalidate the cache. The API requires
 * alternating roles and the last message at request time is user-role, so the
 * clock joins that message instead of starting a new one.
 */
export function applyAnthropicTail(
  messages: unknown[],
  volatile?: string,
): void {
  if (!messages.length) return;
  const last = messages[messages.length - 1] as { role: string; content: unknown };
  const blocks = Array.isArray(last.content)
    ? (last.content as Record<string, unknown>[])
    : null;
  if (blocks?.length) {
    blocks[blocks.length - 1]!.cache_control = { type: "ephemeral" };
  }
  if (!volatile) return;
  if (blocks && last.role === "user") {
    blocks.push({ type: "text", text: volatile });
  } else {
    messages.push({ role: "user", content: [{ type: "text", text: volatile }] });
  }
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
  const messages = toAnthropicMessages(req.messages);
  // Volatile per-step tail (clock) + rolling message breakpoint — see
  // applyAnthropicTail. NEVER fold the clock into the system blocks: it
  // changes every step and would miss the cache from byte zero.
  applyAnthropicTail(messages, req.systemVolatile);
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? 4_096,
    system,
    tools,
    messages,
    stream: req.stream !== false,
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
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "user") {
      const content: unknown[] = [{ type: "text", text: m.content || "(see attached)" }];
      for (const img of m.images ?? []) {
        content.push({ type: "image_url", image_url: { url: img } });
      }
      out.push({ role: "user", content });
      i++;
    } else if (m.role === "assistant") {
      // An assistant turn with neither text nor tool calls carries no
      // information, and OpenAI-compatible providers reject it outright
      // (DeepSeek: "The content field is a required field."; Moonshot:
      // "assistant must provide content, reasoning_content or tool_calls").
      // One such turn — e.g. a stored empty final answer — 400s EVERY later
      // request on the thread, so drop it at wire-build time. The resulting
      // consecutive user messages are legal on this wire.
      if (!m.content && !m.toolCalls?.length) {
        i++;
        continue;
      }
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
      i++;
    } else {
      // A run of tool results. The `tool` role is text-only on this wire, so
      // screenshots cannot ride on it: every image in the run is forwarded in
      // one trailing user message instead of being silently dropped (which is
      // exactly what left the model blind to its own screenshot calls).
      const images: string[] = [];
      while (i < messages.length && messages[i]!.role === "tool") {
        const t = messages[i]!;
        out.push({
          role: "tool",
          tool_call_id: t.toolCallId ?? "",
          content: t.content,
        });
        for (const img of t.images ?? []) images.push(img);
        i++;
      }
      if (images.length) {
        const content: unknown[] = [
          {
            type: "text",
            text: `[${images.length} screenshot${images.length > 1 ? "s" : ""} from the tool results above — attached as images; look at them]`,
          },
          ...images.map((img) => ({ type: "image_url", image_url: { url: img } })),
        ];
        out.push({ role: "user", content });
      }
    }
  }
  return out;
}

/** OpenAI's own reasoners (o-series, GPT-5) — the ones that take `reasoning_effort`. */
function isOpenAiReasoner(model: string): boolean {
  return /^(?:o\d|gpt-5)/i.test(model);
}

/**
 * Model families that take the EFFORT-style thinking knob. Everything else on
 * the openai-compatible wire gets the BUDGET-style knob: the number is what
 * actually bounds emission (`reasoning_effort` is advisory and the big servers
 * ignore it — an archived run asked for "low" and received 196,918 reasoning
 * tokens). ONE knob is ever sent: strict gateways reject the pair outright
 * ("'reasoning_effort' and 'thinking_budget' cannot be set simultaneously").
 */
const EFFORT_STYLE_MODELS = /^(?:o\d|gpt-5|gpt-oss|grok|kimi|moonshot)/i;

/** True when a provider error text is about the thinking knobs we sent. */
export function isThinkingKnobError(detail: string): boolean {
  return /reasoning_effort|thinking_budget|enable_thinking|chat_template_kwargs|\breasoning\b/i.test(detail);
}

/** Remove every thinking knob from a built body — the graceful-degradation
 *  retry: server-default thinking beats a 400 that kills the whole run. */
export function stripThinkingKnobs(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  delete out.reasoning_effort;
  delete out.thinking_budget;
  delete out.enable_thinking;
  delete out.chat_template_kwargs;
  delete out.reasoning;
  return out;
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
      // One stable system message on this wire: base rules + task (+ the
      // per-run lessons appendix). It is byte-stable for the whole run, so the
      // endpoint's automatic prefix cache covers it AND the entire growing
      // conversation below it.
      { role: "system", content: req.systemSuffix ? `${req.system}\n\n${req.systemSuffix}` : req.system },
      ...toOpenAiMessages(req.messages),
      // The per-step clock rides at the very END, after the conversation, so a
      // ticking clock never sits inside the cached prefix. (Putting it in the
      // leading system message — where it used to be — changed message[0] every
      // step and defeated caching for the whole request.)
      ...(req.systemVolatile
        ? [{ role: "system", content: req.systemVolatile }]
        : []),
    ],
    tools: req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    // Say batch-friendly out loud: without this flag several providers
    // default to one tool call per reply, and the measured cost of that habit
    // is the whole reason Fast-steps exists (a real run: 254 of 268 turns
    // carried exactly one call). The field is standard on this wire; unknown
    // fields are ignored by the servers that don't use it.
    parallel_tool_calls: true,
    ...(req.stream === false
      ? { stream: false }
      : { stream: true, stream_options: { include_usage: true } }),
  };
  if (!strictOpenAi) {
    // vLLM/SGLang-style switch; most OpenAI-compatible servers ignore unknown
    // fields, and DeepSeek reasoners emit reasoning_content unprompted.
    //
    // OFF HAS TO BE SAID, NOT OMITTED: a reasoner left alone thinks anyway, so
    // the old `if (level !== "off")` guard sent nothing for Off and the model
    // reasoned regardless of the setting. The switch is now emitted in both
    // directions.
    //
    // `thinking_budget` is the only knob on this wire that bounds HOW MUCH a
    // server emits. `reasoning_effort` stays for the gateways that map it, but
    // it is advisory and the big ones ignore it: an archived 68-minute run
    // asked for "low" (budget 1_024) and came back with 196,918 reasoning
    // tokens — 192× the request — because nothing on the wire carried the
    // number. Servers that don't know the field ignore it, and the loop's own
    // reasoning cap (REASONING_OVERRUN_FACTOR in agent/loop.ts) backstops the
    // ones that do.
    const thinking = level !== "off";
    body.enable_thinking = thinking;
    body.chat_template_kwargs = thinking
      ? { enable_thinking: true, thinking_budget: thinkingBudgetFor(level) }
      : { enable_thinking: false };
    if (thinking) {
      // Exactly ONE of the two top-level knobs — never both. A gateway that
      // knows both rejects the pair ("cannot be set simultaneously"), and a
      // gateway that knows neither ignores whichever one it gets.
      if (EFFORT_STYLE_MODELS.test(model)) body.reasoning_effort = level;
      else body.thinking_budget = thinkingBudgetFor(level);
    }
    // OpenRouter normalises reasoning through its own `reasoning` object and
    // drops the server-specific fields above.
    if ((opts.baseUrl ?? "").includes("openrouter.ai")) {
      body.reasoning = thinking
        ? { max_tokens: thinkingBudgetFor(level) }
        : { enabled: false };
    }
  } else if (reasoner && level !== "off") {
    body.reasoning_effort = level;
  }
  return body;
}

// ---------------- SSE aggregation ----------------

/**
 * OpenAI-compatible usage, where the cache counter is spelled three ways:
 * `prompt_tokens_details.cached_tokens` (OpenAI, OpenRouter, most gateways)
 * and `prompt_cache_hit_tokens` (DeepSeek's own naming). Absent stays
 * undefined — "the provider did not report cache" is not "the cache missed".
 */
export function parseOpenAiUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  prompt_cache_hit_tokens?: number | null;
}): StreamUsage {
  const details = usage.prompt_tokens_details;
  const cached =
    typeof details?.cached_tokens === "number"
      ? details.cached_tokens
      : typeof usage.prompt_cache_hit_tokens === "number"
        ? usage.prompt_cache_hit_tokens
        : undefined;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cachedInputTokens: cached,
  };
}

/** Provider usage as the aggregators accumulate it. */
export type StreamUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};

export interface StreamAggregator {
  feed(line: string): void;
  result(): LlmResult;
  text: string;
  /** Accumulated reasoning text, when the model streamed any. */
  reasoning?: string;
  usage?: StreamUsage;
}

const ANOMALY_SAMPLES = 6;
const ANOMALY_SAMPLE_CHARS = 200;
/** A held-back `data:` payload longer than this is junk, not half an event. */
const MAX_PENDING_PAYLOAD = 64_000;

/**
 * SSE line → JSON event, counting every line it cannot use instead of
 * dropping it silently. A `data:` payload that fails to parse is held and
 * retried joined with the next `data:` line (legal multi-line SSE). Bare
 * non-data fragments are recorded only — splicing them into JSON would be a
 * guess.
 */
export function createSseDecoder(): {
  decode(line: string): Record<string, unknown> | null;
  /** Call once at end of stream; folds a still-pending payload into the counts. */
  info(): UpstreamInfo;
} {
  const info: UpstreamInfo = {
    streamed: true,
    nonDataLines: 0,
    badJsonLines: 0,
    joinedLines: 0,
  };
  const samples: string[] = [];
  let pending = "";
  const sample = (kind: string, text: string): void => {
    if (samples.length < ANOMALY_SAMPLES) {
      samples.push(`${kind}: ${text.slice(0, ANOMALY_SAMPLE_CHARS)}`);
    }
  };
  const parse = (text: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const dropPending = (): void => {
    if (!pending) return;
    info.badJsonLines += 1;
    sample("bad-json", pending);
    pending = "";
  };
  return {
    decode(line) {
      if (!line) {
        // A blank line ends the SSE event; a payload still held is unusable.
        dropPending();
        return null;
      }
      if (line.startsWith(":")) return null;
      if (!line.startsWith("data:")) {
        if (/^(?:event|id|retry):/.test(line)) return null;
        info.nonDataLines += 1;
        sample("non-data", line);
        return null;
      }
      // Per the SSE spec only ONE leading space is stripped: trimming the tail
      // would eat the space at a split inside a JSON string.
      let payload = line.slice(5).replace(/\r$/, "");
      if (payload.startsWith(" ")) payload = payload.slice(1);
      if (payload.trim() === "[DONE]") {
        dropPending();
        return null;
      }
      if (pending) {
        // SSE joins multi-line data with "\n"; a split inside a JSON string
        // only parses joined bare. Either way the join is counted.
        const joined = parse(`${pending}\n${payload}`) ?? parse(`${pending}${payload}`);
        if (joined) {
          info.joinedLines += 1;
          sample("joined", pending);
          pending = "";
          return joined;
        }
        dropPending();
      }
      const event = parse(payload);
      if (event) return event;
      pending = payload.length > MAX_PENDING_PAYLOAD ? "" : payload;
      if (!pending) {
        info.badJsonLines += 1;
        sample("bad-json", payload);
      }
      return null;
    },
    info() {
      dropPending();
      return samples.length ? { ...info, samples: [...samples] } : { ...info };
    },
  };
}

/** Upstream identity fields an OpenAI-compatible chunk may carry. */
function noteOpenAiUpstream(info: UpstreamInfo, event: Record<string, unknown>): void {
  if (!info.provider && typeof event.provider === "string") info.provider = event.provider;
  if (!info.model && typeof event.model === "string") info.model = event.model;
  if (!info.id && typeof event.id === "string") info.id = event.id.slice(0, 24);
  if (!info.fingerprint && typeof event.system_fingerprint === "string") {
    info.fingerprint = event.system_fingerprint;
  }
}

/**
 * Anthropic splits usage across two events: `message_start` carries the input
 * side (including the prompt-cache counters) and `message_delta` carries the
 * final output count. MERGE rather than overwrite — a `message_delta` reports
 * output only, so the old overwrite path zeroed `inputTokens` on every real
 * Anthropic stream, and the cache counters live solely on `message_start`.
 *
 * `cachedInputTokens` stays undefined when the provider never mentions cache
 * fields (an uncached-capable endpoint) — never coerced to 0, which would read
 * as "the cache missed" instead of "nobody said".
 */
export function mergeAnthropicUsage(
  prev: StreamUsage | undefined,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
): StreamUsage {
  // Cache-read tokens are the ones that skipped re-prefill. Cache *creation*
  // is the opposite (paid at a premium to populate the cache), so it is
  // deliberately not folded in here.
  const cached =
    typeof usage.cache_read_input_tokens === "number"
      ? usage.cache_read_input_tokens
      : prev?.cachedInputTokens;
  return {
    inputTokens: usage.input_tokens ?? prev?.inputTokens ?? 0,
    outputTokens: usage.output_tokens ?? prev?.outputTokens ?? 0,
    cachedInputTokens: cached,
  };
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
  const sse = createSseDecoder();
  let messageId: string | undefined;
  let messageModel: string | undefined;
  const agg: StreamAggregator = {
    text: "",
    get reasoning() {
      return reasoning;
    },
    feed(line) {
      const event = sse.decode(line);
      if (!event) return;
      const type = event.type as string;
      if (type === "message_start") {
        const msg = event.message as { id?: unknown; model?: unknown } | undefined;
        if (typeof msg?.id === "string") messageId = msg.id.slice(0, 24);
        if (typeof msg?.model === "string") messageModel = msg.model;
        // The input side of usage — including the prompt-cache counters that
        // say how much of the ~8k-token prefix this step did NOT re-prefill.
        const usage = (
          event.message as
            | {
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number | null;
                  cache_creation_input_tokens?: number | null;
                };
              }
            | undefined
        )?.usage;
        if (usage) agg.usage = mergeAnthropicUsage(agg.usage, usage);
      } else if (type === "content_block_start") {
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
        const usage = (event as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number | null;
            cache_creation_input_tokens?: number | null;
          };
        }).usage;
        if (usage) agg.usage = mergeAnthropicUsage(agg.usage, usage);
      }
    },
    result() {
      const toolCalls: ToolCall[] = [];
      const rawArgs: Record<string, string> = {};
      for (const block of blocks.values()) {
        if (block.kind !== "tool_use") continue;
        const call = makeToolCall(block.id ?? "", block.name ?? "", block.text);
        toolCalls.push(call);
        rawArgs[call.id] = block.text;
      }
      return {
        text: agg.text,
        toolCalls,
        stopReason,
        usage: agg.usage,
        reasoning: reasoning || undefined,
        reasoningSignature: signature || undefined,
        upstream: { ...sse.info(), id: messageId, model: messageModel },
        rawArgs: toolCalls.length ? rawArgs : undefined,
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
  const sse = createSseDecoder();
  const upstream: UpstreamInfo = { streamed: true, nonDataLines: 0, badJsonLines: 0, joinedLines: 0 };
  const agg: StreamAggregator = {
    text: "",
    get reasoning() {
      return reasoning;
    },
    feed(line) {
      const event = sse.decode(line);
      if (!event) return;
      noteOpenAiUpstream(upstream, event);
      // The include_usage chunk usually carries `choices: []`, so usage is
      // read before the no-choice early return.
      const usage = (event as {
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number | null } | null;
          /** DeepSeek spells the same idea differently. */
          prompt_cache_hit_tokens?: number | null;
        } | null;
      }).usage;
      if (usage) agg.usage = parseOpenAiUsage(usage);
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
    },
    result() {
      const rawArgs: Record<string, string> = {};
      const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, call]) => {
          const tc = makeToolCall(call.id || `call_${index}`, call.name, call.args);
          rawArgs[tc.id] = call.args;
          return tc;
        });
      return {
        text: agg.text,
        toolCalls,
        stopReason,
        usage: agg.usage,
        reasoning: reasoning || undefined,
        upstream: { ...sse.info(), ...pickIdentity(upstream) },
        rawArgs: toolCalls.length ? rawArgs : undefined,
      };
    },
  };
  return agg;
}

function pickIdentity(u: UpstreamInfo): Partial<UpstreamInfo> {
  const out: Partial<UpstreamInfo> = {};
  if (u.provider) out.provider = u.provider;
  if (u.model) out.model = u.model;
  if (u.id) out.id = u.id;
  if (u.fingerprint) out.fingerprint = u.fingerprint;
  return out;
}

/** One non-streamed OpenAI-compatible reply → the same result shape. */
export function parseOpenAiReply(
  body: Record<string, unknown>,
  onText?: LlmTextSink,
  onReasoning?: LlmReasoningSink,
): LlmResult {
  const upstream: UpstreamInfo = { streamed: false, nonDataLines: 0, badJsonLines: 0, joinedLines: 0 };
  noteOpenAiUpstream(upstream, body);
  const choice = (body.choices as Record<string, unknown>[] | undefined)?.[0] ?? {};
  const message = (choice.message ?? {}) as {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
  };
  const text = message.content ?? "";
  const reasoning = message.reasoning_content ?? message.reasoning ?? "";
  if (reasoning) onReasoning?.(reasoning);
  if (text) onText?.(text);
  const rawArgs: Record<string, string> = {};
  const toolCalls = (message.tool_calls ?? []).map((tc, i) => {
    const args = tc.function?.arguments;
    const raw = typeof args === "string" ? args : JSON.stringify(args ?? {});
    const call = makeToolCall(tc.id || `call_${i}`, tc.function?.name ?? "", raw);
    rawArgs[call.id] = raw;
    return call;
  });
  const usage = body.usage as Parameters<typeof parseOpenAiUsage>[0] | undefined;
  return {
    text,
    toolCalls,
    stopReason: (choice.finish_reason as string | undefined) ?? "",
    usage: usage ? parseOpenAiUsage(usage) : undefined,
    reasoning: reasoning || undefined,
    upstream,
    rawArgs: toolCalls.length ? rawArgs : undefined,
  };
}

/** One non-streamed Anthropic Messages reply → the same result shape. */
export function parseAnthropicReply(
  body: Record<string, unknown>,
  onText?: LlmTextSink,
  onReasoning?: LlmReasoningSink,
): LlmResult {
  let text = "";
  let reasoning = "";
  let signature = "";
  const toolCalls: ToolCall[] = [];
  const rawArgs: Record<string, string> = {};
  for (const block of (body.content as Record<string, unknown>[] | undefined) ?? []) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "thinking") {
      reasoning += (block.thinking as string | undefined) ?? "";
      signature += (block.signature as string | undefined) ?? "";
    } else if (block.type === "tool_use") {
      const raw = JSON.stringify(block.input ?? {});
      const call = makeToolCall((block.id as string) ?? "", (block.name as string) ?? "", raw);
      toolCalls.push(call);
      rawArgs[call.id] = raw;
    }
  }
  if (reasoning) onReasoning?.(reasoning);
  if (text) onText?.(text);
  const usage = body.usage as Parameters<typeof mergeAnthropicUsage>[1] | undefined;
  return {
    text,
    toolCalls,
    stopReason: (body.stop_reason as string | undefined) ?? "",
    usage: usage ? mergeAnthropicUsage(undefined, usage) : undefined,
    reasoning: reasoning || undefined,
    reasoningSignature: signature || undefined,
    upstream: {
      streamed: false,
      nonDataLines: 0,
      badJsonLines: 0,
      joinedLines: 0,
      id: typeof body.id === "string" ? body.id.slice(0, 24) : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
    },
    rawArgs: toolCalls.length ? rawArgs : undefined,
  };
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
    // Only the CR of a CRLF goes: trimming would eat payload whitespace at a
    // split data line, and a whitespace-only line is an anomaly worth seeing.
    for (const line of lines) agg.feed(line.replace(/\r$/, ""));
  }
  // A final event without a trailing newline is still an event.
  buffer += decoder.decode();
  if (buffer.trim() && !signal?.aborted) agg.feed(buffer.replace(/\r$/, ""));
  return agg.result();
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
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
    if (req.stream === false) return parseAnthropicReply(await readJson(res), onText, onReasoning);
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
    const url = `${this.settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const init = (body: string) => ({
      method: "POST" as const,
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.apiKey}`,
      },
      body,
    });
    const built = buildOpenAiBody(req, this.settings.model, {
      baseUrl: this.settings.baseUrl,
    });
    let res = await fetch(url, init(JSON.stringify(built)));
    if (res.status === 400) {
      const detail = await res.text().catch(() => "");
      if (isThinkingKnobError(detail)) {
        // The gateway refused our thinking knobs — retry ONCE with every one
        // of them stripped. Server-default thinking beats a 400 that kills
        // the run; the loop's reasoning cap still backstops the output.
        res = await fetch(url, init(JSON.stringify(stripThinkingKnobs(built))));
      } else {
        throw new Error(`LLM API error 400: ${detail.slice(0, 300)}`);
      }
    }
    if (req.stream === false) return parseOpenAiReply(await readJson(res), onText, onReasoning);
    return readSse(res, openAiAggregator(onText, onReasoning), signal);
  }
}

export function createLlmClient(settings: AgentSettings): LlmClient {
  return settings.provider === "anthropic"
    ? new AnthropicClient(settings)
    : new OpenAiCompatClient(settings);
}
