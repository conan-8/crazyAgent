// Jev transports at the wire level: the real JevClient, a stubbed fetch.
//
// jev.test.ts covers the pure request/response *shaping*; this file proves the
// wiring end-to-end through the client: the right path per transport, the auth
// header, the strict JSON-Schema marker on the chat path, answers read back out
// of a chat completion the way a gateway returns them, and gateway failures
// mapped onto transport-aware JevErrors that callers fail open on.
//
// (The sockets are covered separately by scripts/jev-smoke.mjs, which drives
// the real extension in a real browser against the mock server.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  JEV_CHAT_MIN_TIMEOUT_MS,
  JevClient,
  JevError,
  createJevClient,
} from "../extension/src/background/agent/jev";
import { JEV_TRANSPORT_DEFAULTS, type JevQuestion } from "../extension/src/shared/jev";

const QUESTIONS: Record<string, JevQuestion> = {
  purchase: { type: "noul", instructions: "Does this complete a purchase?" },
  best: {
    type: "choice",
    instructions: "Which option is best?",
    criteria: { "Item A": "cheap", "Item B": "fast" },
  },
  quality: { type: "score", instructions: "How good is it?", criteria: ["bad", "ok", "great"] },
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The native TypeSafe payload: answers at the top level. */
function systemOnePayload(): unknown {
  return {
    model: "mock-jev",
    answers: {
      purchase: { type: "noul", noul: 0.93 },
      best: {
        type: "choice",
        choice: "Item B",
        probabilities: { "Item A": 0.1, "Item B": 0.9 },
        confidence: 0.8,
      },
      quality: { type: "score", score: 2, legend: { "2": "great" }, confidence: 0.7 },
    },
    usage: { input_tokens: 100, output_tokens: 0 },
  };
}

/** The chat payload: answers ride inside the assistant message; no legend. */
function chatPayload(): unknown {
  return {
    id: "gen-1",
    model: "openai/gpt-oss-20b",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            answers: {
              purchase: { type: "noul", noul: 0.93 },
              best: {
                type: "choice",
                choice: "Item B",
                probabilities: { "Item A": 0.1, "Item B": 0.9 },
                confidence: 0.8,
              },
              quality: { type: "score", score: 2, confidence: 0.7 },
            },
          }),
        },
      },
    ],
    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
  };
}

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: JSON.parse(String(init?.body ?? "{}")),
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function lastCall(): Call {
  const call = calls[calls.length - 1];
  if (!call) throw new Error("no request was made");
  return call;
}

describe("JevClient — typesafe transport (native /systemone)", () => {
  it("POSTs the documented body and parses the top-level answers", async () => {
    calls = [];
    respond = () => json(systemOnePayload());
    const client = createJevClient({
      enabled: true,
      apiKey: "tsk-mock",
      baseUrl: "https://api.typesafe.ai/v1/",
      model: "mock-jev",
    });
    expect(client).not.toBeNull();
    const result = await client!.decide("state text", QUESTIONS);

    expect(lastCall().url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(lastCall().method).toBe("POST");
    expect(lastCall().headers.authorization).toBe("Bearer tsk-mock");
    expect(lastCall().body).toEqual({
      model: "mock-jev",
      state: "state text",
      questions: QUESTIONS,
    });
    expect(result.answers.purchase).toEqual({ type: "noul", noul: 0.93 });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 0 });
  });
});

describe("JevClient — openai transport (OpenRouter /chat/completions)", () => {
  it("POSTs a strict structured-output chat request and parses the completion", async () => {
    calls = [];
    respond = () => json(chatPayload());
    const client = createJevClient({
      enabled: true,
      transport: "openai",
      apiKey: "sk-or-mock",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "", // blank → the OpenRouter default model
    });
    expect(client?.transport).toBe("openai");
    const result = await client!.decide(["item a", "item b"], QUESTIONS);

    const sent = lastCall();
    expect(sent.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent.headers.authorization).toBe("Bearer sk-or-mock");
    expect(sent.body.model).toBe(JEV_TRANSPORT_DEFAULTS.openai.model);
    expect(sent.body.temperature).toBe(0);

    const format = sent.body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean };
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("jev_answers");
    expect(format.json_schema.strict).toBe(true);

    const messages = sent.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1]!.content).toContain('"item a"');
    expect(messages[1]!.content).toContain("questions:");

    // Answers survive the round-trip, with the legend rebuilt from our rubric.
    expect(result.model).toBe("openai/gpt-oss-20b");
    expect(result.answers.purchase).toEqual({ type: "noul", noul: 0.93 });
    expect(result.answers.best).toEqual({
      type: "choice",
      choice: "Item B",
      probabilities: { "Item A": 0.1, "Item B": 0.9 },
      confidence: 0.8,
    });
    expect(result.answers.quality).toEqual({
      type: "score",
      score: 2,
      legend: { "0": "bad", "1": "ok", "2": "great" },
      probabilities: {},
      confidence: 0.7,
    });
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
  });
});

describe("JevClient — failure mapping (fail-open ergonomics)", () => {
  it("raises a transport-aware 404 naming the right base URL, not a raw fetch error", async () => {
    calls = [];
    respond = () => json({ error: { message: "no such route" } }, 404);
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "m",
      transport: "openai",
    });
    const err = await client.decide("s", QUESTIONS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).status).toBe(404);
    expect((err as Error).message).toContain("openrouter.ai/api/v1");
    // The gateway's own detail text is kept for debugging.
    expect((err as Error).message).toContain("no such route");
  });

  it("wraps a dead endpoint in a JevError so callers fall back", async () => {
    calls = [];
    respond = () => Promise.reject(new TypeError("fetch failed"));
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "m",
      transport: "openai",
    });
    const err = await client.decide("s", QUESTIONS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as Error).message).toContain("Jev call failed");
  });

  it("reports a timeout as a timeout (TypeSafe transport honours the caller's box)", async () => {
    calls = [];
    respond = (call) =>
      new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://api.typesafe.ai/v1",
      model: "m",
      transport: "typesafe",
    });
    const err = await client
      .decide("s", QUESTIONS, { timeoutMs: 20 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).timedOut).toBe(true);
    expect((err as Error).message).toContain("timed out after 20ms");
  });

  it("gives the chat transport a timeout floor above its caller's time-box", () => {
    // The risk gate allows 2s; a chat model needs longer than that to answer.
    expect(JEV_CHAT_MIN_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});