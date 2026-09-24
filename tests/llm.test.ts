import { describe, expect, it } from "vitest";
import {
  buildAnthropicBody,
  buildOpenAiBody,
  anthropicAggregator,
  openAiAggregator,
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
  system: string;
  tools: { name: string; input_schema: object; type?: string }[];
  messages: { role: string; content: unknown }[];
};

describe("provider request shaping", () => {
  it("builds an Anthropic body with tool_use/tool_result blocks and images", () => {
    const body = buildAnthropicBody(req, "m1") as unknown as ShapedBody;
    expect(body.model).toBe("m1");
    expect(body.system).toBe("sys");
    expect(body.tools[0]).toMatchObject({ name: "click", input_schema: expect.any(Object) });

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

  it("omits thinking by default", () => {
    const a = buildAnthropicBody(req, "m1") as Record<string, unknown>;
    const o = buildOpenAiBody(req, "m1") as Record<string, unknown>;
    expect(a.thinking).toBeUndefined();
    expect(o.enable_thinking).toBeUndefined();
  });

  it("enables Anthropic extended thinking with a budget", () => {
    const body = buildAnthropicBody(
      { ...req, thinking: true, thinkingBudget: 4096 },
      "m1",
    ) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    // max_tokens must exceed the thinking budget or the API rejects it.
    expect(body.max_tokens as number).toBeGreaterThan(4096);
  });

  it("leaves max_tokens alone when it already exceeds the budget", () => {
    const body = buildAnthropicBody(
      { ...req, thinking: true, thinkingBudget: 1024, maxTokens: 8192 },
      "m1",
    ) as Record<string, unknown>;
    expect(body.max_tokens).toBe(8192);
  });

  it("enables thinking on the OpenAI-compatible path", () => {
    const body = buildOpenAiBody({ ...req, thinking: true }, "m1") as Record<
      string,
      unknown
    >;
    expect(body.enable_thinking).toBe(true);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
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
      `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } })}`,
    ];
    for (const line of lines) agg.feed(line);
    const result = agg.result();
    expect(result.reasoning).toBe("Let me reason.");
    expect(thinking).toEqual(["Let me ", "reason."]);
    // Reasoning must never be appended to assistant prose.
    expect(result.text).toBe("Answer.");
    expect(texts).toEqual(["Answer."]);
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
