// Agent settings persisted in chrome.storage.local (personal-use key storage).
import type { ControlMode } from "../shared/protocol";
import type { AgentMode, Effort } from "../shared/modes";

export interface AgentSettings {
  provider: "anthropic" | "openai-compatible";
  /** API base; /messages (anthropic) or /chat/completions (openai) is appended. */
  baseUrl: string;
  model: string;
  apiKey: string;
  mode: ControlMode;
  stepCap: number;
  /** Attach screenshot data URLs for multimodal models. */
  sendScreenshots: boolean;
  /** DevTools port of the Unlimited-mode browser (helper daemon attaches). */
  cdpPort: number;
  /** Agent behavior mode (Auto / Plan / Build) — drives prompts and gating. */
  agentMode: AgentMode;
  /** Effort preset — drives step and token budgets. */
  effort: Effort;
  /** Model context window for the live usage bar. */
  contextWindow: number;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
  mode: "standard",
  stepCap: 40,
  sendScreenshots: true,
  cdpPort: 9222,
  agentMode: "auto",
  effort: "balanced",
  contextWindow: 128_000,
};

const KEY = "baSettings";

export async function loadSettings(): Promise<AgentSettings> {
  const out = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(out[KEY] as Partial<AgentSettings> | undefined) };
}

export async function saveSettings(settings: AgentSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
