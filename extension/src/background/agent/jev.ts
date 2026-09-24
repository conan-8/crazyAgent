// Jev client — the System-One sidecar that runs ALONGSIDE the selected chat
// provider (it is deliberately not an LlmClient: Jev answers typed questions,
// it never streams text or requests tools). One POST to {baseUrl}/systemone
// per decision point; every caller treats failure as "no Jev signal" and falls
// back to the deterministic path, so a run never depends on Jev being up.
import {
  JEV_COMPLEXITY_CRITERIA,
  JEV_DEFAULTS,
  buildSystemOneBody,
  describeJevHttpError,
  parseSystemOneResponse,
  thinkingForComplexity,
  type JevAnswer,
  type JevChoiceQuestion,
  type JevQuestion,
  type JevResult,
  type JevState,
} from "../../shared/jev";
import type { ThinkingLevel } from "../../shared/llm";

export interface JevClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
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

  async decide(
    state: JevState,
    questions: Record<string, JevQuestion>,
    opts: JevCallOptions = {},
  ): Promise<JevResult> {
    const timeoutMs = opts.timeoutMs ?? 8_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(
          buildSystemOneBody(state, questions, this.cfg.model || JEV_DEFAULTS.model),
        ),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new JevError(
          `${describeJevHttpError(res.status)}${detail ? ` ${detail.slice(0, 200)}` : ""}`,
          res.status,
        );
      }
      const json: unknown = await res.json().catch(() => null);
      return parseSystemOneResponse(json);
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

/** Null when the sidecar is off or unconfigured — callers skip Jev entirely. */
export function createJevClient(jev: {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
} | null | undefined): JevClient | null {
  if (!jev?.enabled) return null;
  const apiKey = (jev.apiKey ?? "").trim();
  if (!apiKey) return null;
  return new JevClient({
    apiKey,
    baseUrl: (jev.baseUrl ?? "").trim() || JEV_DEFAULTS.baseUrl,
    model: (jev.model ?? "").trim() || JEV_DEFAULTS.model,
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
