import { describe, expect, it } from "vitest";
import {
  buildAnthropicBody,
  buildOpenAiBody,
  toAnthropicMessages,
  anthropicAggregator,
  openAiAggregator,
  parseOpenAiUsage,
} from "../extension/src/background/agent/llm";
import type { LlmRequest } from "../extension/src/shared/llm";

const req: LlmRequest = {
  system: "sys",
  tools: [
    {
      name: "click",
      description: "click it",
      parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    },
  ],
  messages: [
    { role: "user", content: "do it", images: ["data:image/png;base64,QUJD"] },
    {
      role: "assistant",
      content: "on it",
      toolCalls: [{ id: "c1", name: "click", args: { ref: "1" } }],
    },
    { role: "tool", toolCallId: "c1", content: "clicked" },
    { role: "tool", toolCallId: "c2", content: "ERROR: boom" },
    { role: "assistant", content: "done" },
  ],
};

type ShapedBody = {
  model: string;
  system: { type: string; text: string; cache_control?: unknown }[];
  tools: { name: string; input_schema: object; cache_control?: unknown }[];
  messages: { role: string; content: unknown }[];
};

describe("provider request shaping", () => {
  it("drops a contentless assistant turn on the OpenAI wire", () => {
    // A stored empty final answer used to poison the thread forever: DeepSeek
    // 400s with "The content field is a required field.", Moonshot with
    // "assistant must provide content, reasoning_content or tool_calls".
    const poisoned: LlmRequest = {
      ...req,
      messages: [
        { role: "user", content: "first task" },
        { role: "assistant", content: "" },
        { role: "user", content: "follow-up" },
      ],
    };
    const body = buildOpenAiBody(poisoned, "m2") as unknown as ShapedBody;
    // system, user, user — the empty assistant is gone; consecutive user
    // messages are legal on this wire.
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
  });

  it("keeps an empty-text assistant turn that carries tool_calls", () => {
    const withCalls: LlmRequest = {
      ...req,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "click", args: { ref: "1" } }],
        },
        { role: "tool", toolCallId: "c1", content: "ok" },
      ],
    };
    const body = buildOpenAiBody(withCalls, "m2") as unknown as ShapedBody;
    const asst = body.messages[2] as unknown as {
      content: unknown;
      tool_calls?: unknown[];
    };
    // null content + tool_calls is the OpenAI idiom; the call must survive
    // (the following tool result pairs with it).
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.content).toBeNull();
  });

  it("gives a contentless assistant turn a placeholder on the Anthropic wire", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "" },
      { role: "user", content: "b" },
    ]) as { role: string; content: { type: string; text?: string }[] }[];
    // Anthropic requires alternating roles, so the empty turn is kept with a
    // minimal text block instead of being dropped.
    expect(out[1]!.role).toBe("assistant");
    expect(out[1]!.content).toEqual([{ type: "text", text: "…" }]);
  });

  it("merges adjacent same-role messages on the Anthropic wire", () => {
    // Tool results followed by the harness's "continue" nudge (or any user
    // steering) leave two user messages in a row; Anthropic's wire wants
    // alternating roles, so they merge into one message with both blocks.
    const out = toAnthropicMessages([
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "click", args: { ref: "1" } }],
      },
      { role: "tool", toolCallId: "c1", content: "ok" },
      { role: "user", content: "keep going" },
    ]) as { role: string; content: { type: string; text?: string }[] }[];
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // The merged tail keeps the tool_result first (Anthropic's rule) and the
    // nudge text after it.
    expect(out[2]!.content.map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect(out[2]!.content[1]!.text).toBe("keep going");
  });

  it("builds an Anthropic body with tool_use/tool_result blocks and images", () => {
    const body = buildAnthropicBody(req, "m1") as unknown as ShapedBody;
    expect(body.model).toBe("m1");
    // System is a cache-controlled block: stable prefix across steps.
    expect(body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.tools[0]).toMatchObject({ name: "click", input_schema: expect.any(Object) });
    // The last tool carries the cache breakpoint for the tools+system prefix.
    expect(body.tools[0]!.cache_control).toEqual({ type: "ephemeral" });

    const msgs = body.messages;
    // user with text + image
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toEqual([
      { type: "text", text: "do it" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ]);
    // assistant with text + tool_use
    const asst = msgs[1]!.content as Record<string, unknown>[];
    expect(asst[1]).toMatchObject({ type: "tool_use", id: "c1", name: "click", input: { ref: "1" } });
    // consecutive tool messages merge into ONE user message with two results
    expect(msgs[2]!.role).toBe("user");
    expect(msgs[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "clicked" },
      { type: "tool_result", tool_use_id: "c2", content: "ERROR: boom", is_error: true },
    ]);
  });

  it("builds an OpenAI body with tool_calls round-trip", () => {
    const body = buildOpenAiBody(req, "m2") as unknown as ShapedBody;
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "click" } });
    const msgs = body.messages;
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(msgs[1]!.content).toEqual([
      { type: "text", text: "do it" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
    expect(msgs[2]!.content).toBeDefined();
    const asst = msgs[2] as unknown as {
      tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[];
    };
    expect(asst.tool_calls).toEqual([
      {
        id: "c1",
        type: "function",
        function: { name: "click", arguments: '{"ref":"1"}' },
      },
    ]);
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "clicked" });
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "click" } });
  });

  // Regression: tool-result screenshots used to be silently DROPPED on both
  // wires — the model called screenshot and never saw the image. A real run
  // spent 10 minutes reconstructing a graph from PNG pixel statistics because
  // of this.
  const reqWithShot: LlmRequest = {
    system: "sys",
    tools: [],
    messages: [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "screenshot", args: {} }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        content: "[screenshot captured]",
        images: ["data:image/jpeg;base64,AAA"],
      },
    ],
  };

  it("carries tool-result screenshots inside the Anthropic tool_result block", () => {
    const body = buildAnthropicBody(reqWithShot, "m1") as unknown as ShapedBody;
    const toolUser = body.messages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as { type: string }[]).some((b) => b.type === "tool_result"),
    );
    const blocks = toolUser!.content as Record<string, unknown>[];
    expect(blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c1",
      content: [
        { type: "text", text: "[screenshot captured]" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "AAA" },
        },
      ],
    });
  });

  it("carries tool-result screenshots on the OpenAI wire in a trailing user message", () => {
    // The `tool` role is text-only there, so the image rides right after the
    // tool run instead of being dropped.
    const body = buildOpenAiBody(reqWithShot, "m2") as unknown as ShapedBody;
    const msgs = body.messages; // system, user, assistant(tool_calls), tool, user(images)
    expect(msgs[3]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "[screenshot captured]",
    });
    expect(msgs[4]!.role).toBe("user");
    expect(msgs[4]!.content).toEqual([
      { type: "text", text: expect.stringContaining("screenshot") },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
    ]);
  });

  it("omits thinking by default on the Anthropic wire", () => {
    const a = buildAnthropicBody(req, "m1") as Record<string, unknown>;
    expect(a.thinking).toBeUndefined();
  });

  it("SAYS thinking is off on the OpenAI wire instead of merely omitting it", () => {
    // A reasoner left alone emits reasoning_content unprompted, so Off has to
    // be transmitted explicitly — omitting the knob never turned it off.
    const o = buildOpenAiBody(req, "m1") as Record<string, unknown>;
    expect(o.enable_thinking).toBe(false);
    expect(o.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(o.reasoning_effort).toBeUndefined();
    expect(o.thinking_budget).toBeUndefined();
  });

  it("maps a thinking level to an Anthropic budget", () => {
    const body = buildAnthropicBody({ ...req, thinking: "medium" }, "m1") as Record<
      string,
      unknown
    >;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4_096 });
    // max_tokens must exceed the thinking budget or the API rejects it.
    expect(body.max_tokens as number).toBeGreaterThan(4_096);
  });

  it("leaves max_tokens alone when it already exceeds the budget", () => {
    const body = buildAnthropicBody(
      { ...req, thinking: "low", maxTokens: 8192 },
      "m1",
    ) as Record<string, unknown>;
    expect(body.max_tokens).toBe(8192);
  });

  it("skips thinking for Anthropic models that predate it", () => {
    const body = buildAnthropicBody(
      { ...req, thinking: "high" },
      "claude-3-5-sonnet-20241022",
    ) as Record<string, unknown>;
    expect(body.thinking).toBeUndefined();
  });

  it("maps a thinking level to the OpenAI-compatible knobs", () => {
    const body = buildOpenAiBody({ ...req, thinking: "high" }, "m1") as Record<
      string,
      unknown
    >;
    expect(body.enable_thinking).toBe(true);
    expect(body.chat_template_kwargs).toEqual({
      enable_thinking: true,
      thinking_budget: 16_384,
    });
    expect(body.reasoning_effort).toBe("high");
  });

  it("carries the level's BUDGET on the OpenAI wire, not just its name", () => {
    // `reasoning_effort` is advisory and the big endpoints ignore it: a run
    // that asked for "low" came back with 196,918 reasoning tokens, 192× the
    // 1,024 budget. The number itself has to travel.
    const low = buildOpenAiBody({ ...req, thinking: "low" }, "m1") as Record<
      string,
      unknown
    >;
    expect(low.thinking_budget).toBe(1_024);
    expect(low.chat_template_kwargs).toEqual({
      enable_thinking: true,
      thinking_budget: 1_024,
    });
    const medium = buildOpenAiBody({ ...req, thinking: "medium" }, "m1") as Record<
      string,
      unknown
    >;
    expect(medium.thinking_budget).toBe(4_096);
  });

  it("keeps thinking knobs away from strict OpenAI non-reasoners", () => {
    // api.openai.com 400s on unknown params — gpt-4o-mini must get none.
    const body = buildOpenAiBody(
      { ...req, thinking: "high" },
      "gpt-4o-mini",
      { baseUrl: "https://api.openai.com/v1" },
    ) as Record<string, unknown>;
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(4_096);
  });

  it("sends reasoning_effort (and max_completion_tokens) to OpenAI reasoners", () => {
    const body = buildOpenAiBody({ ...req, thinking: "low" }, "o4-mini", {
      baseUrl: "https://api.openai.com/v1",
    }) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("low");
    expect(body.enable_thinking).toBeUndefined();
    expect(body.max_completion_tokens).toBe(4_096);
    expect(body.max_tokens).toBeUndefined();
  });
});

describe("system prompt appendix (lessons learned)", () => {
  it("leaves the Anthropic system block untouched when unset", () => {
    const body = buildAnthropicBody(req, "m1") as unknown as ShapedBody;
    expect(body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("sends the appendix as a second, uncached block so the cached prefix survives", () => {
    const body = buildAnthropicBody(
      { ...req, systemSuffix: "APPENDIX — lessons" },
      "m1",
    ) as unknown as ShapedBody;
    expect(body.system).toHaveLength(2);
    // Base prompt keeps the single cache breakpoint; the per-run appendix
    // deliberately carries none, so it never invalidates the cached prefix.
    expect(body.system[0]).toEqual({
      type: "text",
      text: "sys",
      cache_control: { type: "ephemeral" },
    });
    expect(body.system[1]).toEqual({ type: "text", text: "APPENDIX — lessons" });
    expect(body.system[1]!.cache_control).toBeUndefined();
  });

  it("appends the appendix to the single OpenAI system message", () => {
    const withSuffix = buildOpenAiBody(
      { ...req, systemSuffix: "APPENDIX — lessons" },
      "m2",
    ) as unknown as ShapedBody;
    expect(withSuffix.messages[0]).toEqual({
      role: "system",
      content: "sys\n\nAPPENDIX — lessons",
    });
    const plain = buildOpenAiBody(req, "m2") as unknown as ShapedBody;
    expect(plain.messages[0]).toEqual({ role: "system", content: "sys" });
  });
});

describe("volatile per-step tail (the clock) and cache breakpoints", () => {
  // Regression: a run once carried the clock inside the cached system block,
  // so every one of its 112 steps re-prefilled the entire prompt from byte
  // zero. The clock now rides LAST on both wires, after everything stable.
  const clock = "Current date and time: 2026-09-30T01:02 (Tuesday, UTC-04:00)";

  // A request whose last message is a tool result (the normal mid-run shape).
  const reqEndingInTool: LlmRequest = {
    system: "sys",
    tools: [],
    messages: [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "screenshot", args: {} }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        content: "[screenshot captured]",
        images: ["data:image/jpeg;base64,AAA"],
      },
    ],
  };

  it("keeps the clock out of the Anthropic system blocks", () => {
    const body = buildAnthropicBody(
      { ...req, systemVolatile: clock },
      "m1",
    ) as unknown as ShapedBody;
    expect(body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    expect(JSON.stringify(body.system)).not.toContain("Current date and time");
  });

  it("appends the clock to the trailing user message on the Anthropic wire", () => {
    // The last message at request time is user-role (tool results); the API
    // forbids consecutive same-role messages, so the clock JOINS it.
    const body = buildAnthropicBody(
      { ...req, systemVolatile: clock },
      "m1",
    ) as unknown as ShapedBody;
    const msgs = body.messages;
    // The fixture ends with an assistant message, so the clock rides as a new
    // user message after it (alternation preserved).
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([{ type: "text", text: clock }]);
  });

  it("joins the clock onto a trailing tool_result message and marks the rolling breakpoint", () => {
    const body = buildAnthropicBody(
      { ...reqEndingInTool, systemVolatile: clock },
      "m1",
    ) as unknown as ShapedBody;
    const last = body.messages[body.messages.length - 1]!;
    const blocks = last.content as Record<string, unknown>[];
    // The tool_result block carries the rolling cache breakpoint…
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    // …and the clock is appended AFTER it, outside the cached prefix.
    expect(blocks[1]).toEqual({ type: "text", text: clock });
  });

  it("adds the rolling message breakpoint even without a volatile tail", () => {
    const body = buildAnthropicBody(req, "m1") as unknown as ShapedBody;
    const last = body.messages[body.messages.length - 1]!;
    const blocks = last.content as Record<string, unknown>[];
    expect(blocks[blocks.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("puts the clock in a trailing system message on the OpenAI wire", () => {
    const body = buildOpenAiBody(
      { ...req, systemVolatile: clock },
      "m2",
    ) as unknown as ShapedBody;
    const msgs = body.messages;
    // Leading system message stays byte-stable (no clock)…
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    // …and the clock rides at the very end, after the whole conversation, so
    // automatic prefix caching still covers everything before it.
    expect(msgs[msgs.length - 1]).toEqual({ role: "system", content: clock });
  });

  it("omits the trailing OpenAI clock message when there is no volatile tail", () => {
    const body = buildOpenAiBody(req, "m2") as unknown as ShapedBody;
    expect(
      body.messages.some((m) => m.role === "system" && String(m.content).includes("Current date")),
    ).toBe(false);
  });
});

describe("prompt-cache usage telemetry", () => {
  it("merges Anthropic message_start input + cache counters with the message_delta output", () => {
    const agg = anthropicAggregator();
    agg.feed(
      `data: ${JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 9_000,
            output_tokens: 1,
            cache_read_input_tokens: 8_000,
            cache_creation_input_tokens: 500,
          },
        },
      })}`,
    );
    // The delta reports output only — it must not zero the input side.
    agg.feed(
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 250 },
      })}`,
    );
    expect(agg.result().usage).toEqual({
      inputTokens: 9_000,
      outputTokens: 250,
      cachedInputTokens: 8_000,
    });
  });

  it("leaves cachedInputTokens undefined when Anthropic never reports cache fields", () => {
    const agg = anthropicAggregator();
    agg.feed(
      `data: ${JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 1_200, output_tokens: 1 } },
      })}`,
    );
    const usage = agg.result().usage;
    expect(usage?.inputTokens).toBe(1_200);
    // Absent is not zero: a silent endpoint must not render as "cache missed".
    expect(usage?.cachedInputTokens).toBeUndefined();
  });

  it("reads OpenAI prompt_tokens_details.cached_tokens", () => {
    const agg = openAiAggregator();
    agg.feed(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "hi" } }],
        usage: {
          prompt_tokens: 12_000,
          completion_tokens: 90,
          prompt_tokens_details: { cached_tokens: 11_000 },
        },
      })}`,
    );
    expect(agg.result().usage).toEqual({
      inputTokens: 12_000,
      outputTokens: 90,
      cachedInputTokens: 11_000,
    });
  });

  it("reads DeepSeek's prompt_cache_hit_tokens spelling", () => {
    const agg = openAiAggregator();
    agg.feed(
      `data: ${JSON.stringify({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 4_000, completion_tokens: 10, prompt_cache_hit_tokens: 3_500 },
      })}`,
    );
    expect(agg.result().usage?.cachedInputTokens).toBe(3_500);
  });

  it("prefers prompt_tokens_details over the DeepSeek spelling when both appear", () => {
    expect(
      parseOpenAiUsage({
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 80 },
        prompt_cache_hit_tokens: 20,
      }).cachedInputTokens,
    ).toBe(80);
  });

  it("reports no cache field at all when the endpoint is silent", () => {
    const usage = parseOpenAiUsage({ prompt_tokens: 700, completion_tokens: 12 });
    expect(usage.cachedInputTokens).toBeUndefined();
  });
});

describe("SSE aggregators", () => {
  it("aggregates an Anthropic stream with text and a tool_use", () => {
    const texts: string[] = [];
    const agg = anthropicAggregator((t) => texts.push(t));
    const lines = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "click", input: {} } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"ref":' } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"5"}' } })}`,
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}`,
    ];
    for (const line of lines) agg.feed(line);
    const result = agg.result();
    expect(result.text).toBe("Hi there");
    expect(texts).toEqual(["Hi ", "there"]);
    expect(result.toolCalls).toEqual([{ id: "t1", name: "click", args: { ref: "5" } }]);
    expect(result.stopReason).toBe("tool_use");
  });

  it("aggregates an OpenAI stream with chunked tool_calls and bad JSON", () => {
    const agg = openAiAggregator();
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Working" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "type", arguments: '{"text"' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'oops' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      `data: [DONE]`,
    ];
    for (const line of lines) agg.feed(line);
    const result = agg.result();
    expect(result.text).toBe("Working");
    expect(result.toolCalls).toEqual([
      { id: "c9", name: "type", args: {}, invalidJson: '{"text"oops' },
    ]);
  });

  it("captures Anthropic thinking_delta without leaking it into text", () => {
    const thinking: string[] = [];
    const texts: string[] = [];
    const agg = anthropicAggregator(
      (t) => texts.push(t),
      (t) => thinking.push(t),
    );
    const lines = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason." } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } })}`,
    ];
    for (const line of lines) agg.feed(line);
    const result = agg.result();
    expect(result.reasoning).toBe("Let me reason.");
    // The signature must be captured so the block can be replayed next turn.
    expect(result.reasoningSignature).toBe("sig-abc");
    expect(thinking).toEqual(["Let me ", "reason."]);
    // Reasoning must never be appended to assistant prose.
    expect(result.text).toBe("Answer.");
    expect(texts).toEqual(["Answer."]);
  });

  it("replays a signed thinking block ahead of tool_use for Anthropic", () => {
    const out = toAnthropicMessages([
      {
        role: "assistant",
        content: "working",
        thinking: "Let me reason.",
        thinkingSignature: "sig-abc",
        toolCalls: [{ id: "t1", name: "click", args: { ref: "5" } }],
      },
    ]) as { role: string; content: Record<string, unknown>[] }[];
    const content = out[0]!.content;
    expect(content[0]).toEqual({
      type: "thinking",
      thinking: "Let me reason.",
      signature: "sig-abc",
    });
    expect(content[1]).toEqual({ type: "text", text: "working" });
    expect(content[2]).toMatchObject({ type: "tool_use", id: "t1", name: "click" });
  });

  it("omits an unsigned thinking block rather than send an invalid one", () => {
    const out = toAnthropicMessages([
      { role: "assistant", content: "hi", thinking: "reason", toolCalls: [] },
    ]) as { content: Record<string, unknown>[] }[];
    expect(out[0]!.content.every((b) => b.type !== "thinking")).toBe(true);
  });

  it("captures OpenAI reasoning_content (DeepSeek/vLLM)", () => {
    const agg = openAiAggregator();
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "step 1 " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "step 2" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Final" } }] })}`,
      `data: [DONE]`,
    ];
    for (const line of lines) agg.feed(line);
    const result = agg.result();
    expect(result.reasoning).toBe("step 1 step 2");
    expect(result.text).toBe("Final");
  });

  it("omits reasoning when the model emitted none", () => {
    const agg = openAiAggregator();
    agg.feed(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}`);
    expect(agg.result().reasoning).toBeUndefined();
  });
});
