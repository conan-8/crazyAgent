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

/** Local/self-hosted endpoints (ollama, vLLM, LM Studio) need no API key. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local") ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

/** Turn a status code into an explanation that names the actual cause. */
export function describeHttpError(
  status: number,
  provider: "anthropic" | "openai-compatible",
): string {
  const name = provider === "anthropic" ? "Anthropic" : "the provider";
  switch (status) {
    case 401:
      return `HTTP 401 — ${name} rejected the key for this connection. Check the key and that the connection is the active one.`;
    case 403:
      return `HTTP 403 — the key is valid but not allowed to list models (often a restricted or project-scoped key). You can still type a model name manually.`;
    case 404:
      return `HTTP 404 — no /models endpoint at this base URL. Check for a missing or extra path segment (e.g. /v1).`;
    case 429:
      return `HTTP 429 — rate limited or out of quota. The key is fine; try again shortly.`;
    default:
      return `HTTP ${status} — model list request failed. Check the base URL and key.`;
  }
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
  // A local/self-hosted endpoint legitimately needs no credential; don't invent
  // a failure for it, and don't send a stray "Bearer " header.
  const needsKey = !isLocalEndpoint(base);
  if (needsKey && !settings.apiKey.trim()) {
    return {
      models: [],
      error: "no API key set for this connection — add one in Settings",
    };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      // Say what actually failed: 401/403 is the key, 404 is usually the URL,
      // 429 is quota. The old catch-all blamed the key for all of them.
      return { models: [], error: describeHttpError(res.status, settings.provider) };
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
