import { describe, expect, it } from "vitest";
import {
  describeHttpError,
  fetchModelsFor,
  isLocalEndpoint,
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

describe("endpoint helpers", () => {
  it("recognises local/self-hosted endpoints", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:8000/v1",
      "http://192.168.1.50:1234/v1",
      "http://10.0.0.5/v1",
      "http://172.16.4.4/v1",
      "http://box.local/v1",
    ]) {
      expect(isLocalEndpoint(url)).toBe(true);
    }
  });

  it("does not treat public endpoints as local", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
      "https://openrouter.ai/api/v1",
      // 172.32 is outside the private range
      "http://172.32.0.1/v1",
    ]) {
      expect(isLocalEndpoint(url)).toBe(false);
    }
  });

  it("handles a malformed base URL without throwing", () => {
    expect(isLocalEndpoint("not a url")).toBe(false);
  });

  it("names the real cause for each status", () => {
    expect(describeHttpError(401, "anthropic")).toContain("rejected the key");
    expect(describeHttpError(403, "openai-compatible")).toContain("not allowed");
    expect(describeHttpError(404, "openai-compatible")).toContain("base URL");
    expect(describeHttpError(429, "openai-compatible")).toContain("rate limited");
    expect(describeHttpError(500, "openai-compatible")).toContain("HTTP 500");
  });
});

describe("fetchModelsFor credential handling", () => {
  it("reports a missing key for a remote endpoint without calling it", async () => {
    const res = await fetchModelsFor({
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
    });
    expect(res.models).toEqual([]);
    expect(res.error).toContain("no API key");
  });

  it("does not require a key for a local endpoint", async () => {
    // No server is running, so this fails — but with a network error, NOT the
    // "no API key" message. Proves the local path skips the key requirement.
    const res = await fetchModelsFor({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "",
    });
    expect(res.error).not.toContain("no API key");
  });
});
