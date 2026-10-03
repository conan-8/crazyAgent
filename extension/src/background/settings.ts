// Agent settings persisted in chrome.storage.local (personal-use key storage).
import type { ControlMode } from "../shared/protocol";
import type { ThinkingLevel } from "../shared/llm";
import { JEV_TRANSPORT_DEFAULTS, normalizeJevTransport, type JevTransport } from "../shared/jev";

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

/**
 * Jev sidecar config. Deliberately NOT an ApiKeyEntry connection: Jev is a
 * decision model that works alongside the selected chat model (risk gating,
 * the `judge` tool, effort routing) — it can never drive the agent loop itself.
 */
export interface JevSettings {
  enabled: boolean;
  /**
   * `typesafe` (native /systemone — real Jev) or `openai` (any OpenAI-compatible
   * /chat/completions endpoint, e.g. OpenRouter with your OpenRouter key).
   */
  transport: JevTransport;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Self-improvement ("coach") config. `enabled` is the master switch for the
 * whole loop — lessons are read back into the system prompt AND new ones are
 * written after a run. `auto` additionally reviews runs that went wrong
 * without being asked; manual reviews work either way.
 */
export interface LearnSettings {
  enabled: boolean;
  auto: boolean;
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
  /** DevTools port of the Unlimited-mode browser (helper daemon attaches). */
  cdpPort: number;
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
   * Fast steps: prompt the agent to put one logical unit of work (a form, a
   * key sequence, a menu walk) into a SINGLE step as multiple tool calls, and
   * to stop spending a step re-verifying an action whose result already ended
   * with a fresh snapshot.
   *
   * This is a real tradeoff, not a pure win: batching means less mid-sequence
   * adaptation, which is why it is a switch. Safety is unaffected — every rule,
   * the confirmation gate and the risk policy are identical, and each gated
   * action still confirms on its own. On by default: the archived run logs
   * measured 1.04 tool calls per turn at ~7.5s of fixed cost per round trip,
   * so the sequential habit was the single largest cost in a run.
   */
  batchActions: boolean;
  /**
   * Adaptive per-step thinking: after a few consecutive ROUTINE steps (one
   * successful tool call, barely any reasoning, no page navigation), the loop
   * sends subsequent steps with thinking OFF until something surprising
   * happens — a failure, an empty reply, a navigation, a reasoning overrun —
   * at which point the configured level is restored immediately. Never raises
   * thinking, never applies when the run level is already "off". Off by
   * default: it is a latency/robustness tradeoff the user should choose.
   */
  adaptiveThinking: boolean;
  /**
   * Madman mode: the agent swears. Seeds a profane voice into the system
   * prompt (so replies and mid-run exclamations cuss) and decorates every
   * tool-call label with a cuss word. Off by default.
   */
  madman: boolean;
  /**
   * Unattended runs: nobody is around to click confirmation cards, so the
   * gate fails fast (~15 s) with an explicit "this route is unavailable"
   * instead of idling the full 2 minutes. Safety is unchanged — gated
   * actions are still never auto-approved. Off by default.
   */
  unattended: boolean;
  /**
   * Jev (TypeSafe System-One) decision-model sidecar. Works alongside the
   * selected chat model — never replaces it. Off until a key is set; the
   * agent run never depends on Jev being reachable.
   */
  jev: JevSettings;
  /**
   * Let Jev grade each task's complexity at run start and LOWER the reasoning
   * effort for trivial tasks (never raises it above `thinking`). Requires
   * `jev.enabled`. On by default from settings rev 2 — the routing call is
   * tiny and fail-open; the switch is a real opt-out.
   */
  autoThinking: boolean;
  /**
   * Settings schema revision, stamped by the normaliser. Absent (or 1) means
   * the object was saved before one-time default migrations existed.
   */
  rev?: number;
  /**
   * Self-improvement: a second agent (same model) reviews finished runs and
   * writes lessons into this profile's local log, which later runs read back.
   * On by default — auto-review only fires on runs that failed.
   */
  learn: LearnSettings;
}

/** Defaults for a brand-new connection. */
export const CONNECTION_DEFAULTS = {
  provider: "openai-compatible" as const,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

/** Bumped when a default change needs a one-time migration of stored profiles. */
const SETTINGS_REV = 2;

export const DEFAULT_SETTINGS: AgentSettings = {
  apiKeys: [],
  activeKeyId: "",
  ...CONNECTION_DEFAULTS,
  apiKey: "",
  mode: "standard",
  cdpPort: 9222,
  maxTokens: 8_192,
  contextWindow: 128_000,
  // Thinking on at the lowest level: a cheap reasoning block by default.
  thinking: "low",
  // Batch one logical unit per step: the measured round-trip cost made the
  // one-action-then-verify habit the biggest single term in a run.
  batchActions: true,
  // Adaptive per-step thinking off by default: the run-level switch (plus
  // Jev's auto routing) covers most users; this trims the remaining per-step
  // thinking on steady routines and restores on the first surprise.
  adaptiveThinking: false,
  // Straight-laced by default; Madman mode is opt-in.
  madman: false,
  // Attended by default: confirmations wait the full timeout for a human.
  unattended: false,
  // Jev sidecar off until the user pastes a key (TypeSafe, or OpenRouter for
  // the chat-completions transport).
  jev: {
    enabled: false,
    transport: "typesafe",
    apiKey: "",
    baseUrl: JEV_TRANSPORT_DEFAULTS.typesafe.baseUrl,
    model: JEV_TRANSPORT_DEFAULTS.typesafe.model,
  },
  // Auto effort routing on by default: one tiny fail-open Jev call per run
  // that can only LOWER thinking. The switch turns it off.
  autoThinking: true,
  rev: SETTINGS_REV,
  // Self-improvement on by default: lessons already learned are applied to
  // later runs, and runs that failed are reviewed automatically.
  learn: { enabled: true, auto: true },
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

/**
 * Legacy blocks carry no `transport`. They were written when TypeSafe was the
 * only option — except one case worth rescuing: a stored baseUrl pointing at
 * OpenRouter could never have worked (no /systemone there), so it is inferred
 * as the chat transport and starts working instead of 404-ing. An explicit
 * `transport` always wins.
 */
function inferJevTransport(raw: Partial<JevSettings>): JevTransport {
  if (raw.transport !== undefined) return normalizeJevTransport(raw.transport);
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.toLowerCase() : "";
  return baseUrl.includes("openrouter.ai") ? "openai" : "typesafe";
}

/** Backfill/coerce a stored Jev block (missing or partial → safe defaults). */
export function normalizeJev(stored: unknown): JevSettings {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Partial<JevSettings>;
  const transport = inferJevTransport(raw);
  const defaults = JEV_TRANSPORT_DEFAULTS[transport];
  return {
    // Only a real `true` enables the sidecar; anything else stays off.
    enabled: raw.enabled === true,
    transport,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    baseUrl:
      typeof raw.baseUrl === "string" && raw.baseUrl.trim()
        ? raw.baseUrl.trim()
        : defaults.baseUrl,
    model:
      typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : defaults.model,
  };
}

/** Backfill/coerce a stored coach block. Unlike Jev this ships ON: only an
 * explicit `false` turns either switch off, so older stored settings (which
 * have no `learn` block at all) get the feature rather than silently losing
 * it. */
export function normalizeLearn(stored: unknown): LearnSettings {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Partial<LearnSettings>;
  return { enabled: raw.enabled !== false, auto: raw.auto !== false };
}

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
  // The rev that matters is the STORED one: absent means the profile predates
  // default migrations and needs their one-time flips.
  const rev = typeof stored?.rev === "number" ? stored.rev : 1;
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
  // Drop the removed numeric budget if an old stored object still carries it,
  // and the removed agent-mode picker's key likewise.
  const rest: Record<string, unknown> = { ...merged };
  delete rest.thinkingBudget;
  delete rest.agentMode;
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
    // Same for unattended runs — an explicit opt-in, never inferred.
    unattended: merged.unattended === true,
    // Fast steps is NEW, so no stored profile carries it: absent means "take
    // the default (on)", and only an explicit `false` turns it off. Unlike
    // autoThinking there is no old default artifact to migrate around.
    batchActions: merged.batchActions !== false,
    adaptiveThinking: merged.adaptiveThinking === true,
    // Jev sidecar: backfill partial stored objects; coerce the toggles.
    jev: normalizeJev(merged.jev),
    // Auto effort routing is on from rev 2. Before that the default `false`
    // was normalised INTO every saved profile, so a stored `false` from a
    // rev-1 profile is the old default artifact, not an opt-out — flipped
    // once here. From rev 2 on, an explicit `false` is honoured as a real
    // opt-out.
    autoThinking: merged.autoThinking !== false || rev < 2,
    rev: SETTINGS_REV,
    // Coach: on unless explicitly disabled (see normalizeLearn).
    learn: normalizeLearn(merged.learn),
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