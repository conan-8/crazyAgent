// Jev client — the System-One sidecar that runs ALONGSIDE the selected chat
// provider (it is deliberately not an LlmClient: Jev answers typed questions,
// it never streams text or requests tools). One POST per decision point:
//   - typesafe transport → {baseUrl}/systemone      (Jev proper)
//   - openai transport   → {baseUrl}/chat/completions (OpenRouter et al.)
// Every caller treats failure as "no Jev signal" and falls back to the
// deterministic path, so a run never depends on Jev being up.
import {
  JEV_COMPLEXITY_CRITERIA,
  buildOpenAiJevBody,
  buildSystemOneBody,
  describeJevHttpError,
  jevDefaultsFor,
  normalizeJevTransport,
  parseOpenAiJevResponse,
  parseSystemOneResponse,
  thinkingForComplexity,
  type JevAnswer,
  type JevChoiceQuestion,
  type JevQuestion,
  type JevResult,
  type JevState,
  type JevTransport,
} from "../../shared/jev";
import type { ThinkingLevel } from "../../shared/llm";

/**
 * Floor for the chat-completions transport. TypeSafe answers in milliseconds,
 * but a chat model is a full round-trip, so the callers' short time-boxes (the
 * risk gate allows 2s) would expire before a healthy answer could land. This
 * only widens the window Jev has to answer — a slow or dead endpoint still
 * resolves as "no Jev signal" and fails open exactly as before.
 */
export const JEV_CHAT_MIN_TIMEOUT_MS = 6_000;

export interface JevClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  transport: JevTransport;
}

export interface JevCallOptions {
  /** Hard timeout; the caller's fallback kicks in when it fires. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  constructor(private cfg: JevClientConfig) {}

  /** Which wire this client speaks. */
  get transport(): JevTransport {
    return this.cfg.transport;
  }

  /** True for the OpenRouter / OpenAI-compatible chat transport. */
  get isChatTransport(): boolean {
    return this.cfg.transport === "openai";
  }

  async decide(
    state: JevState,
    questions: Record<string, JevQuestion>,
    opts: JevCallOptions = {},
  ): Promise<JevResult> {
    const requested = opts.timeoutMs ?? 8_000;
    const timeoutMs = this.isChatTransport
      ? Math.max(requested, JEV_CHAT_MIN_TIMEOUT_MS)
      : requested;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort);
    const chat = this.isChatTransport;
    const model = this.cfg.model || jevDefaultsFor(this.cfg.transport).model;
    try {
      const res = await fetch(
        `${this.cfg.baseUrl.replace(/\/+$/, "")}${chat ? "/chat/completions" : "/systemone"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.cfg.apiKey}`,
            // OpenRouter attribution header (ignored by other gateways).
            ...(chat ? { "x-title": "crazyAgent" } : {}),
          },
          body: JSON.stringify(
            chat
              ? buildOpenAiJevBody(state, questions, model)
              : buildSystemOneBody(state, questions, model),
          ),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new JevError(
          `${describeJevHttpError(res.status, this.cfg.transport)}${detail ? ` ${detail.slice(0, 200)}` : ""}`,
          res.status,
        );
      }
      const json: unknown = await res.json().catch(() => null);
      return chat ? parseOpenAiJevResponse(json, questions) : parseSystemOneResponse(json);
    } catch (err) {
      if (err instanceof JevError) throw err;
      const timedOut = controller.signal.aborted && !opts.signal?.aborted;
      throw new JevError(
        timedOut
          ? `Jev call timed out after ${timeoutMs}ms`
          : `Jev call failed: ${String((err as Error)?.message ?? err)}`,
        undefined,
        timedOut,
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * One retry on transient failures (timeout / 429 / 5xx / 529) after a short
   * backoff — for latency-tolerant callers (the `judge` tool). The risk-gate
   * path uses plain `decide` and fails open instead of waiting twice.
   */
  async decideWithRetry(
    state: JevState,
    questions: Record<string, JevQuestion>,
    opts: JevCallOptions = {},
  ): Promise<JevResult> {
    try {
      return await this.decide(state, questions, opts);
    } catch (err) {
      const e = err as JevError;
      const transient =
        e?.timedOut === true ||
        (typeof e?.status === "number" && (e.status === 429 || e.status >= 500));
      if (!transient) throw err;
      await new Promise((r) => setTimeout(r, 500));
      return this.decide(state, questions, opts);
    }
  }
}

/**
 * Null when the sidecar is off or unconfigured — callers skip Jev entirely.
 * A blank baseUrl/model resolves to the selected transport's defaults, so
 * switching transport in Settings without editing those fields does the
 * obvious thing (TypeSafe's endpoint vs OpenRouter's).
 */
export function createJevClient(jev: {
  enabled?: boolean;
  transport?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
} | null | undefined): JevClient | null {
  if (!jev?.enabled) return null;
  const apiKey = (jev.apiKey ?? "").trim();
  if (!apiKey) return null;
  const transport = normalizeJevTransport(jev.transport);
  const defaults = jevDefaultsFor(transport);
  return new JevClient({
    apiKey,
    transport,
    baseUrl: (jev.baseUrl ?? "").trim() || defaults.baseUrl,
    model: (jev.model ?? "").trim() || defaults.model,
  });
}

// ---- run-scoped holder: sw.ts sets it per run; tools/jev.ts reads it ----
// (avoids a tools → sw import cycle; the tool errors cleanly when unset)
let activeClient: JevClient | null = null;

export function setActiveJevClient(client: JevClient | null): void {
  activeClient = client;
}

export function getActiveJevClient(): JevClient | null {
  return activeClient;
}

// ---- auto effort routing (intent-routing pattern) ----

const COMPLEXITY_QUESTION: JevChoiceQuestion = {
  type: "choice",
  instructions:
    "How much work will this browser task need? Judge from the task text alone.",
  criteria: JEV_COMPLEXITY_CRITERIA,
};

export interface RoutedThinking {
  level: ThinkingLevel;
  complexity?: string;
  confidence?: number;
}

/**
 * Grade the task and lower the thinking level for trivial work. Bounded: the
 * result never exceeds `userLevel`, and any failure returns it unchanged —
 * routing is an optimization, never a reason to stall or fail a run.
 */
export async function routeThinkingByJev(
  client: JevClient,
  task: string,
  userLevel: ThinkingLevel,
  timeoutMs = 2_000,
): Promise<RoutedThinking> {
  try {
    const result = await client.decide(
      task.slice(0, 4_000),
      { complexity: COMPLEXITY_QUESTION },
      { timeoutMs },
    );
    const answer: JevAnswer | undefined = result.answers.complexity;
    if (answer?.type !== "choice") return { level: userLevel };
    return {
      level: thinkingForComplexity(answer.choice, userLevel),
      complexity: answer.choice,
      confidence: answer.confidence,
    };
  } catch {
    return { level: userLevel };
  }
}
