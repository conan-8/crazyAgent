// Agent settings persisted in chrome.storage.local (personal-use key storage).
import type { ControlMode } from "../shared/protocol";
import type { AgentMode } from "../shared/modes";

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
  /** Ask the model to emit its reasoning before answering. */
  thinking: boolean;
  /** Token budget for the thinking block, where the provider accepts one. */
  thinkingBudget: number;
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
  thinking: false,
  thinkingBudget: 2_048,
};

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
  return {
    ...merged,
    apiKeys: keys,
    activeKeyId,
    // Mirrors: the active connection is the single source of truth.
    provider: active?.provider ?? globals.provider,
    baseUrl: active?.baseUrl ?? globals.baseUrl,
    model: active?.model ?? globals.model,
    apiKey: activeApiKey({ apiKeys: keys, activeKeyId, apiKey: merged.apiKey }),
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