import { describe, expect, it } from "vitest";
import {
  activeApiKey,
  activeConnection,
  DEFAULT_SETTINGS,
  makeEntry,
  normalizeSettings,
  type ApiKeyEntry,
} from "../extension/src/background/settings";

const k = (
  id: string,
  label: string,
  key: string,
  rest: Partial<ApiKeyEntry> = {},
): ApiKeyEntry =>
  makeEntry({
    id,
    label,
    key,
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    ...rest,
  });

const ANTHROPIC = {
  provider: "anthropic" as const,
  baseUrl: "https://api.anthropic.com/v1",
  model: "claude-sonnet-4",
};
const LOCAL = {
  provider: "openai-compatible" as const,
  baseUrl: "http://localhost:11434/v1",
  model: "qwen3:32b",
};

describe("activeApiKey / activeConnection", () => {
  it("returns the active entry's secret", () => {
    const keys = [k("a", "work", "sk-work"), k("b", "personal", "sk-personal")];
    expect(activeApiKey({ apiKeys: keys, activeKeyId: "b" })).toBe("sk-personal");
  });

  it("falls back to the first key when activeKeyId is dangling", () => {
    const keys = [k("a", "work", "sk-work"), k("b", "personal", "sk-personal")];
    expect(activeApiKey({ apiKeys: keys, activeKeyId: "gone" })).toBe("sk-work");
  });

  it("returns the legacy mirror when there are no entries", () => {
    expect(activeApiKey({ apiKeys: [], activeKeyId: "", apiKey: "sk-legacy" })).toBe(
      "sk-legacy",
    );
  });

  it("returns empty string when nothing is configured", () => {
    expect(activeApiKey({})).toBe("");
  });

  it("exposes the whole active connection, not just the secret", () => {
    const keys = [k("a", "work", "sk-work"), k("b", "anthropic", "sk-ant", ANTHROPIC)];
    expect(activeConnection({ apiKeys: keys, activeKeyId: "b" })).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
  });
});

describe("per-connection switching", () => {
  const keys = [
    k("a", "openai", "sk-openai"),
    k("b", "anthropic", "sk-ant", ANTHROPIC),
    k("c", "local", "", LOCAL),
  ];

  it("resolves provider/baseUrl/model from the active connection", () => {
    const s = normalizeSettings({ apiKeys: keys, activeKeyId: "b" });
    expect(s.provider).toBe("anthropic");
    expect(s.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(s.model).toBe("claude-sonnet-4");
    expect(s.apiKey).toBe("sk-ant");
  });

  it("switching connection switches the whole target", () => {
    const first = normalizeSettings({ apiKeys: keys, activeKeyId: "a" });
    expect(first.model).toBe("gpt-4o-mini");

    const switched = normalizeSettings({ ...first, activeKeyId: "c" });
    expect(switched.provider).toBe("openai-compatible");
    expect(switched.baseUrl).toBe("http://localhost:11434/v1");
    expect(switched.model).toBe("qwen3:32b");
    // A keyless local endpoint must not inherit another connection's secret.
    expect(switched.apiKey).toBe("");
  });

  it("remembers each connection's own model when switching back", () => {
    const a = normalizeSettings({ apiKeys: keys, activeKeyId: "a" });
    const b = normalizeSettings({ ...a, activeKeyId: "b" });
    const back = normalizeSettings({ ...b, activeKeyId: "a" });
    expect(back.model).toBe("gpt-4o-mini");
    expect(b.model).toBe("claude-sonnet-4");
  });

  it("keeps edits to one connection from touching another", () => {
    const s = normalizeSettings({ apiKeys: keys, activeKeyId: "b" });
    const edited = normalizeSettings({
      ...s,
      apiKeys: s.apiKeys.map((e) =>
        e.id === "b" ? { ...e, model: "claude-opus-4" } : e,
      ),
    });
    expect(edited.model).toBe("claude-opus-4");
    expect(edited.apiKeys.find((e) => e.id === "a")!.model).toBe("gpt-4o-mini");
  });
});

describe("normalizeSettings migration", () => {
  it("migrates a legacy single apiKey plus globals into one connection", () => {
    const s = normalizeSettings({
      apiKey: "sk-legacy",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4",
    });
    expect(s.apiKeys).toHaveLength(1);
    expect(s.apiKeys[0]).toMatchObject({
      key: "sk-legacy",
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(s.activeKeyId).toBe(s.apiKeys[0]!.id);
    expect(s.apiKey).toBe("sk-legacy");
    expect(s.model).toBe("claude-sonnet-4");
  });

  it("backfills missing per-entry fields from the old globals", () => {
    // A connection saved before per-entry provider/baseUrl/model existed.
    const legacyEntry = { id: "old", label: "Old", key: "sk-old" } as ApiKeyEntry;
    const s = normalizeSettings({
      apiKeys: [legacyEntry],
      activeKeyId: "old",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4",
    });
    expect(s.apiKeys[0]).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4",
    });
  });

  it("does not duplicate the legacy key when a list already exists", () => {
    const s = normalizeSettings({
      apiKey: "sk-legacy",
      apiKeys: [k("a", "work", "sk-work")],
      activeKeyId: "a",
    });
    expect(s.apiKeys).toHaveLength(1);
    expect(s.apiKey).toBe("sk-work");
  });

  it("leaves an empty legacy key as an empty list", () => {
    const s = normalizeSettings({ apiKey: "" });
    expect(s.apiKeys).toEqual([]);
    expect(s.activeKeyId).toBe("");
    expect(s.apiKey).toBe("");
  });

  it("repairs a dangling activeKeyId to the first entry", () => {
    const s = normalizeSettings({
      apiKeys: [k("a", "work", "sk-work"), k("b", "personal", "sk-personal")],
      activeKeyId: "deleted",
    });
    expect(s.activeKeyId).toBe("a");
    expect(s.apiKey).toBe("sk-work");
  });

  it("applies defaults for a fresh install", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("preserves unrelated settings", () => {
    const s = normalizeSettings({
      thinking: true,
      maxTokens: 4096,
      apiKeys: [k("a", "work", "sk-work")],
      activeKeyId: "a",
    });
    expect(s.thinking).toBe(true);
    expect(s.maxTokens).toBe(4096);
  });

  it("is idempotent — re-normalising does not grow the list", () => {
    const once = normalizeSettings({ apiKey: "sk-legacy" });
    const twice = normalizeSettings(once);
    expect(twice.apiKeys).toHaveLength(1);
    expect(twice.apiKeys[0]!.key).toBe("sk-legacy");
    expect(twice.activeKeyId).toBe(once.activeKeyId);
    expect(twice.model).toBe(once.model);
  });

  it("survives a malformed apiKeys value", () => {
    const s = normalizeSettings({
      apiKeys: "not-an-array" as unknown as ApiKeyEntry[],
    });
    expect(Array.isArray(s.apiKeys)).toBe(true);
    expect(s.apiKeys).toEqual([]);
  });
});

describe("makeEntry", () => {
  it("fills every field from the defaults", () => {
    const e = makeEntry();
    expect(e.id).toMatch(/^k_/);
    expect(e.provider).toBe("openai-compatible");
    expect(e.baseUrl).toBe("https://api.openai.com/v1");
    expect(e.model).toBe("gpt-4o-mini");
  });

  it("keeps provided fields and generates a unique id", () => {
    const a = makeEntry({ label: "one" });
    const b = makeEntry({ label: "two" });
    expect(a.id).not.toBe(b.id);
    expect(a.label).toBe("one");
  });
});