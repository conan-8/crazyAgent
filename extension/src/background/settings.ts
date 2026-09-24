// Agent settings persisted in chrome.storage.local (personal-use key storage).
import type { ControlMode } from "../shared/protocol";
import type { AgentMode } from "../shared/modes";
import type { ThinkingLevel } from "../shared/llm";

/**
 * One saved connection: a credential plus the endpoint and model it belongs to.
 * Provider/base URL/model live here (not globally) so switching connection
 * switches the whole target and each one remembers its last-used model.
 */
export interface ApiKeyEntry {
  id: string;
  label: string;
  key: string;
  provider: "anthropic" | "openai-compatible";
  baseUrl: string;
  model: string;
}

export interface AgentSettings {
  /** Every saved connection; the active one is chosen by `activeKeyId`. */
  apiKeys: ApiKeyEntry[];
  /** Which entry in `apiKeys` the agent uses. */
  activeKeyId: string;
  /**
   * Below are the *resolved* values for the active connection. They are
   * derived from `apiKeys` on load and save, so every existing consumer can
   * keep reading `settings.apiKey` / `.provider` / `.baseUrl` / `.model`.
   */
  provider: "anthropic" | "openai-compatible";
  baseUrl: string;
  model: string;
  apiKey: string;
  mode: ControlMode;
  /** Attach screenshot data URLs for multimodal models. */
  sendScreenshots: boolean;
  /** DevTools port of the Unlimited-mode browser (helper daemon attaches). */
  cdpPort: number;
  /** Agent behavior mode (Auto / Plan / Build) — drives prompts and gating. */
  agentMode: AgentMode;
  /**
   * Max output tokens per model call. The agent's *step* count is unlimited;
   * this only bounds a single response, so it stays generous.
   */
  maxTokens: number;
  /** Model context window for the live usage bar. */
  contextWindow: number;
  /**
   * Reasoning effort ("thinking") level: off / low / medium / high. Each
   * provider translates it to its own knob (Anthropic budget tokens,
   * enable_thinking, reasoning_effort); unsupported providers ignore it.
   */
  thinking: ThinkingLevel;
  /**
   * Madman mode: the agent swears. Seeds a profane voice into the system
   * prompt (so replies and mid-run exclamations cuss) and decorates every
   * tool-call label with a cuss word. Off by default.
   */
  madman: boolean;
}

/** Defaults for a brand-new connection. */
export const CONNECTION_DEFAULTS = {
  provider: "openai-compatible" as const,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

export const DEFAULT_SETTINGS: AgentSettings = {
  apiKeys: [],
  activeKeyId: "",
  ...CONNECTION_DEFAULTS,
  apiKey: "",
  mode: "standard",
  sendScreenshots: true,
  cdpPort: 9222,
  agentMode: "auto",
  maxTokens: 8_192,
  contextWindow: 128_000,
  // Thinking on at the lowest level: a cheap reasoning block by default.
  thinking: "low",
  // Straight-laced by default; Madman mode is opt-in.
  madman: false,
};

const THINKING_VALUES: ThinkingLevel[] = ["off", "low", "medium", "high"];

/**
 * Migrate the legacy `thinking: boolean` (+ numeric `thinkingBudget`) into
 * the level dropdown, mapping a custom budget to its nearest level.
 */
export function migrateThinking(stored: {
  thinking?: unknown;
  thinkingBudget?: unknown;
}): ThinkingLevel {
  const raw = stored.thinking;
  if (typeof raw === "string" && (THINKING_VALUES as string[]).includes(raw)) {
    return raw as ThinkingLevel;
  }
  if (typeof raw !== "boolean") return DEFAULT_SETTINGS.thinking;
  if (!raw) return "off";
  const budget = typeof stored.thinkingBudget === "number" ? stored.thinkingBudget : 2_048;
  if (budget <= 1_536) return "low";
  if (budget <= 8_192) return "medium";
  return "high";
}

const KEY = "baSettings";

/** Stable-enough id for a new entry (crypto.randomUUID needs a secure ctx). */
export function newKeyId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `k_${rand}`;
}

/** Find the active connection, falling back to the first when the id is stale. */
export function activeConnection(settings: {
  apiKeys?: ApiKeyEntry[];
  activeKeyId?: string;
}): ApiKeyEntry | undefined {
  const keys = settings.apiKeys ?? [];
  if (!keys.length) return undefined;
  return keys.find((k) => k.id === settings.activeKeyId) ?? keys[0];
}

/** The active connection's secret (empty when nothing is configured). */
export function activeApiKey(settings: {
  apiKeys?: ApiKeyEntry[];
  activeKeyId?: string;
  apiKey?: string;
}): string {
  const active = activeConnection(settings);
  if (!active) return settings.apiKey ?? "";
  return active.key;
}

/** Build a complete entry, filling any gaps from the connection defaults. */
export function makeEntry(partial: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    id: partial.id ?? newKeyId(),
    label: partial.label ?? "Connection",
    key: partial.key ?? "",
    provider: partial.provider ?? CONNECTION_DEFAULTS.provider,
    baseUrl: partial.baseUrl ?? CONNECTION_DEFAULTS.baseUrl,
    model: partial.model ?? CONNECTION_DEFAULTS.model,
  };
}

/**
 * Normalise a stored/partial settings object:
 *  - migrate a legacy single `apiKey` (+ global provider/baseUrl/model) into one
 *    connection;
 *  - backfill missing per-entry fields from the old global values;
 *  - repair a dangling `activeKeyId`;
 *  - refresh the derived mirrors from the active entry.
 */
export function normalizeSettings(
  stored: Partial<AgentSettings> | undefined,
  defaults: AgentSettings = DEFAULT_SETTINGS,
): AgentSettings {
  const merged: AgentSettings = { ...defaults, ...(stored ?? {}) };
  const raw = Array.isArray(merged.apiKeys) ? merged.apiKeys : [];

  // Global provider/baseUrl/model were authoritative before profiles existed.
  const globals = {
    provider: merged.provider ?? CONNECTION_DEFAULTS.provider,
    baseUrl: merged.baseUrl ?? CONNECTION_DEFAULTS.baseUrl,
    model: merged.model ?? CONNECTION_DEFAULTS.model,
  };

  let keys: ApiKeyEntry[] = raw.map((k) =>
    makeEntry({ ...globals, ...(k ?? {}) }),
  );

  // Migrate a pre-existing single key into the list exactly once.
  const legacy = typeof stored?.apiKey === "string" ? stored.apiKey.trim() : "";
  if (!keys.length && legacy) {
    keys = [makeEntry({ ...globals, label: "Default", key: legacy })];
  }

  let activeKeyId = merged.activeKeyId ?? "";
  if (!keys.some((k) => k.id === activeKeyId)) {
    activeKeyId = keys[0]?.id ?? "";
  }

  const active = activeConnection({ apiKeys: keys, activeKeyId });
  // Drop the removed numeric budget if an old stored object still carries it.
  const rest: Record<string, unknown> = { ...merged };
  delete rest.thinkingBudget;
  return {
    ...(rest as unknown as AgentSettings),
    apiKeys: keys,
    activeKeyId,
    // Mirrors: the active connection is the single source of truth.
    provider: active?.provider ?? globals.provider,
    baseUrl: active?.baseUrl ?? globals.baseUrl,
    model: active?.model ?? globals.model,
    apiKey: activeApiKey({ apiKeys: keys, activeKeyId, apiKey: merged.apiKey }),
    // Legacy boolean thinking (+ budget) becomes the level dropdown.
    thinking: migrateThinking(merged),
    // Coerce: only a real `true` turns Madman mode on.
    madman: merged.madman === true,
  };
}

export async function loadSettings(): Promise<AgentSettings> {
  const out = await chrome.storage.local.get(KEY);
  return normalizeSettings(out[KEY] as Partial<AgentSettings> | undefined);
}

export async function saveSettings(settings: AgentSettings): Promise<void> {
  // Persist through the normaliser so the mirrors can never drift.
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [KEY]: normalized });
}