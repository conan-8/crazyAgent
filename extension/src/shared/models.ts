// Provider model discovery — the model menu lists what the configured key can
// actually call, fetched live from the provider's catalog endpoint.

export interface ModelsResult {
  models: string[];
  error?: string;
}

/** OpenAI-compatible: GET {base}/models → { data: [{ id }] } */
export function parseOpenAiModels(json: unknown): string[] {
  const data = (json as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m as { id?: string } | null)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Anthropic: GET {base}/models → { data: [{ id, display_name }] } */
export function parseAnthropicModels(json: unknown): string[] {
  const data = (json as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m as { id?: string } | null)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function fetchModelsFor(settings: {
  provider: "anthropic" | "openai-compatible";
  baseUrl: string;
  apiKey: string;
}): Promise<ModelsResult> {
  const base = settings.baseUrl.replace(/\/$/, "");
  const url = `${base}/models${settings.provider === "anthropic" ? "?limit=1000" : ""}`;
  const headers: Record<string, string> = {};
  if (settings.provider === "anthropic") {
    headers["x-api-key"] = settings.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${settings.apiKey}`;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { models: [], error: `model list failed (HTTP ${res.status}) — check the key and base URL` };
    }
    const json = await res.json();
    const models =
      settings.provider === "anthropic"
        ? parseAnthropicModels(json)
        : parseOpenAiModels(json);
    if (!models.length) {
      return { models: [], error: "provider returned no models" };
    }
    return { models };
  } catch (err) {
    return { models: [], error: `model list failed: ${String((err as Error)?.message ?? err)}` };
  }
}
