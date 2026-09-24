import { describe, expect, it } from "vitest";
import {
  fetchModelsFor,
  parseAnthropicModels,
  parseOpenAiModels,
} from "../extension/src/shared/models";

describe("provider model discovery", () => {
  it("parses OpenAI-compatible model lists", () => {
    expect(
      parseOpenAiModels({ data: [{ id: "gpt-4o" }, { id: "deepseek-chat" }, { id: "" }] }),
    ).toEqual(["gpt-4o", "deepseek-chat"]);
    expect(parseOpenAiModels({})).toEqual([]);
    expect(parseOpenAiModels(null)).toEqual([]);
  });

  it("parses Anthropic model lists", () => {
    expect(
      parseAnthropicModels({
        data: [
          { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" },
          { id: "claude-opus-4-1", display_name: "Claude Opus 4.1" },
        ],
      }),
    ).toEqual(["claude-sonnet-4-5", "claude-opus-4-1"]);
    expect(parseAnthropicModels({ data: "oops" })).toEqual([]);
  });

  it("reports friendly errors instead of throwing", async () => {
    const result = await fetchModelsFor({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k",
    });
    expect(result.models).toEqual([]);
    expect(result.error).toContain("model list failed");
  });
});
