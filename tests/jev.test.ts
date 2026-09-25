import { describe, expect, it } from "vitest";
import {
  JEV_DEFAULTS,
  JEV_LIMITS,
  JEV_OPENAI_SCHEMA_NAME,
  JEV_TRANSPORT_DEFAULTS,
  buildJevAnswersSchema,
  buildOpenAiJevBody,
  buildSystemOneBody,
  clipJevText,
  describeJevHttpError,
  extractChatCompletionText,
  formatJevAnswerLine,
  normalizeJevTransport,
  normalizeJudgeQuestions,
  parseJevAnswer,
  parseOpenAiJevResponse,
  parseSystemOneResponse,
  serializeJevState,
  thinkingForComplexity,
} from "../extension/src/shared/jev";
import {
  JEV_RISK_QUESTIONS,
  JEV_RISK_THRESHOLDS,
  assess,
  assessWithJev,
  buildRiskState,
  toRiskAnswers,
  type ElementProbe,
} from "../extension/src/background/policy";
import { DEFAULT_SETTINGS, normalizeSettings } from "../extension/src/background/settings";
import { createJevClient } from "../extension/src/background/agent/jev";
import { buildSystemPrompt } from "../extension/src/background/agent/prompts";
import type { JevAnswer } from "../extension/src/shared/jev";

// ---------------- wire shaping ----------------

describe("buildSystemOneBody", () => {
  it("produces the documented request shape", () => {
    const questions = { urgent: { type: "noul" as const, instructions: "Urgent?" } };
    expect(buildSystemOneBody("state text", questions, "jev-latest")).toEqual({
      model: "jev-latest",
      state: "state text",
      questions,
    });
  });

  it("falls back to the default model on an empty string", () => {
    expect(buildSystemOneBody("s", {}, "").model).toBe(JEV_DEFAULTS.model);
  });
});

// ---------------- chat-completions transport (OpenRouter et al.) ----------------

const MIXED_QUESTIONS = {
  relevant: { type: "noul" as const, instructions: "Is it relevant?" },
  best: {
    type: "choice" as const,
    instructions: "Which is best?",
    criteria: { "Item A": "cheap", "Item B": "fast" },
  },
  quality: {
    type: "score" as const,
    instructions: "How good?",
    criteria: ["bad", "ok", "great"],
  },
};

describe("normalizeJevTransport", () => {
  it("accepts openai and coerces everything else to typesafe", () => {
    expect(normalizeJevTransport("openai")).toBe("openai");
    expect(normalizeJevTransport("typesafe")).toBe("typesafe");
    expect(normalizeJevTransport(undefined)).toBe("typesafe");
    expect(normalizeJevTransport("")).toBe("typesafe");
    expect(normalizeJevTransport("OpenAI")).toBe("typesafe");
    expect(normalizeJevTransport({ transport: "openai" })).toBe("typesafe");
  });

  it("documents an OpenRouter default endpoint and a structured-output model", () => {
    expect(JEV_TRANSPORT_DEFAULTS.openai.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(JEV_TRANSPORT_DEFAULTS.openai.model).toContain("/");
    expect(JEV_TRANSPORT_DEFAULTS.typesafe).toEqual({
      baseUrl: JEV_DEFAULTS.baseUrl,
      model: JEV_DEFAULTS.model,
    });
  });
});

describe("buildJevAnswersSchema", () => {
  it("requires exactly one answer per question id and nothing else", () => {
    const schema = buildJevAnswersSchema(MIXED_QUESTIONS) as {
      additionalProperties: boolean;
      required: string[];
      properties: { answers: { required: string[]; additionalProperties: boolean } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["answers"]);
    expect(schema.properties.answers.required).toEqual(["relevant", "best", "quality"]);
    expect(schema.properties.answers.additionalProperties).toBe(false);
  });

  it("pins choice answers to the offered options (no invented choices)", () => {
    const schema = buildJevAnswersSchema(MIXED_QUESTIONS) as {
      properties: { answers: { properties: Record<string, { properties: Record<string, unknown> }> } };
    };
    const choice = schema.properties.answers.properties.best!.properties.choice as {
      enum: string[];
    };
    const probabilities = schema.properties.answers.properties.best!.properties
      .probabilities as { required: string[] };
    expect(choice.enum).toEqual(["Item A", "Item B"]);
    expect(probabilities.required).toEqual(["Item A", "Item B"]);
  });

  it("uses enum-of-one rather than const (strict-mode subset)", () => {
    const json = JSON.stringify(buildJevAnswersSchema(MIXED_QUESTIONS));
    expect(json).not.toContain('"const"');
    expect(json).toContain('"enum":["noul"]');
  });
});

describe("buildOpenAiJevBody", () => {
  it("is a strict structured-output chat request that names our schema", () => {
    const body = buildOpenAiJevBody("some state", MIXED_QUESTIONS, "openai/gpt-oss-20b") as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: { role: string; content: string }[];
      response_format: { type: string; json_schema: { name: string; strict: boolean } };
    };
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe(JEV_OPENAI_SCHEMA_NAME);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("carries the state and the questions in the user message", () => {
    const body = buildOpenAiJevBody(["a", "b"], MIXED_QUESTIONS, "m") as {
      messages: { content: string }[];
    };
    const user = body.messages[1]!.content;
    expect(user).toContain('"a"');
    // The trailing questions block is machine-readable (the mock relies on it).
    const json = JSON.parse(user.slice(user.indexOf("questions:") + "questions:".length));
    expect(Object.keys(json)).toEqual(["relevant", "best", "quality"]);
    expect(json.best.criteria).toEqual({ "Item A": "cheap", "Item B": "fast" });
  });

  it("falls back to the OpenRouter default model on an empty string", () => {
    expect(buildOpenAiJevBody("s", {}, "").model).toBe(JEV_TRANSPORT_DEFAULTS.openai.model);
  });
});

/** Wrap answer objects in a chat-completion envelope like a gateway would. */
function chatEnvelope(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    id: "gen-1",
    model: "openai/gpt-oss-20b",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) },
      },
    ],
    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
    ...extra,
  };
}

describe("extractChatCompletionText", () => {
  it("reads string content, content parts, and reasoning fallbacks", () => {
    expect(extractChatCompletionText(chatEnvelope("hello"))).toBe("hello");
    expect(
      extractChatCompletionText({
        choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }],
      }),
    ).toBe("ab");
    expect(
      extractChatCompletionText({
        choices: [{ message: { content: "", reasoning: '{"answers":{}}' } }],
      }),
    ).toBe('{"answers":{}}');
    expect(extractChatCompletionText({})).toBe("");
    expect(extractChatCompletionText(null)).toBe("");
  });
});

describe("parseOpenAiJevResponse", () => {
  it("parses all three answer types out of a chat completion", () => {
    const result = parseOpenAiJevResponse(
      chatEnvelope({
        answers: {
          relevant: { type: "noul", noul: 0.82 },
          best: {
            type: "choice",
            choice: "Item B",
            probabilities: { "Item A": 0.2, "Item B": 0.8 },
            confidence: 0.77,
          },
          quality: { type: "score", score: 2, confidence: 0.6 },
        },
      }),
      MIXED_QUESTIONS,
    );
    expect(result.model).toBe("openai/gpt-oss-20b");
    expect(result.answers.relevant).toEqual({ type: "noul", noul: 0.82 });
    expect(result.answers.best).toEqual({
      type: "choice",
      choice: "Item B",
      probabilities: { "Item A": 0.2, "Item B": 0.8 },
      confidence: 0.77,
    });
    // The model is never asked to echo the rubric — we rebuild the legend.
    expect(result.answers.quality).toEqual({
      type: "score",
      score: 2,
      legend: { "0": "bad", "1": "ok", "2": "great" },
      probabilities: {},
      confidence: 0.6,
    });
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
  });

  it("tolerates fenced JSON and prose around the object", () => {
    const fenced = "```json\n" + JSON.stringify({ answers: { relevant: { type: "noul", noul: 0.5 } } }) + "\n```";
    expect(parseOpenAiJevResponse(chatEnvelope(fenced), MIXED_QUESTIONS).answers.relevant).toEqual({
      type: "noul",
      noul: 0.5,
    });
    const prose = `Sure! ${JSON.stringify({ answers: { relevant: { type: "noul", noul: 0.1 } } })} Hope that helps.`;
    expect(parseOpenAiJevResponse(chatEnvelope(prose), MIXED_QUESTIONS).answers.relevant).toEqual({
      type: "noul",
      noul: 0.1,
    });
  });

  it("infers a missing type from the question and clamps out-of-range scores", () => {
    const result = parseOpenAiJevResponse(
      chatEnvelope({ answers: { relevant: { noul: 0.3 }, quality: { score: 9, confidence: 0.2 } } }),
      MIXED_QUESTIONS,
    );
    expect(result.answers.relevant).toEqual({ type: "noul", noul: 0.3 });
    expect((result.answers.quality as { score: number }).score).toBe(2); // clamped to the rubric
  });

  it("accepts a bare id → answer map and drops malformed entries", () => {
    const result = parseOpenAiJevResponse(
      chatEnvelope({ relevant: { type: "noul", noul: 0.4 }, junk: { nope: true } }),
      MIXED_QUESTIONS,
    );
    expect(Object.keys(result.answers)).toEqual(["relevant"]);
  });

  it("returns no answers (never throws) on garbage or empty content", () => {
    for (const bad of ["", "not json at all", "{}", "[]", "null"]) {
      const result = parseOpenAiJevResponse(chatEnvelope(bad), MIXED_QUESTIONS);
      expect(result.answers).toEqual({});
    }
    expect(parseOpenAiJevResponse(null, MIXED_QUESTIONS)).toEqual({
      model: undefined,
      answers: {},
      usage: undefined,
    });
  });
});

describe("serializeJevState", () => {
  it("clips oversized strings", () => {
    const out = serializeJevState("x".repeat(JEV_LIMITS.maxStateChars + 100));
    expect(typeof out).toBe("string");
    expect((out as string).endsWith("…[truncated]")).toBe(true);
    expect((out as string).length).toBeLessThanOrEqual(JEV_LIMITS.maxStateChars + 20);
  });

  it("caps arrays at the item limit and clips item strings", () => {
    const items = Array.from({ length: 150 }, (_, i) => `item ${i} ${"y".repeat(3000)}`);
    const out = serializeJevState(items) as string[];
    expect(out).toHaveLength(JEV_LIMITS.maxStateItems);
    expect(out[0]!.length).toBeLessThanOrEqual(2_000 + 20);
  });

  it("passes structured objects through under the budget", () => {
    const state = { task: "buy shoes", action: { tool: "click" } };
    expect(serializeJevState(state)).toBe(state);
  });

  it("degrades oversized objects to clipped JSON text", () => {
    const huge = { blob: "z".repeat(JEV_LIMITS.maxStateChars + 10) };
    const out = serializeJevState(huge);
    expect(typeof out).toBe("string");
    expect((out as string).endsWith("…[truncated]")).toBe(true);
  });

  it("stringifies primitives and null", () => {
    expect(serializeJevState(42)).toBe("42");
    expect(serializeJevState(null)).toBe("");
  });
});

describe("parseSystemOneResponse / parseJevAnswer", () => {
  it("parses the documented three-type response", () => {
    const json = {
      model: "jev-1.13.0",
      answers: {
        is_urgent: { type: "noul", noul: 0.95 },
        department: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.88, technical: 0.12 },
          confidence: 0.81,
        },
        frustration: {
          type: "score",
          score: 1.05,
          legend: { 0: "Calm", 1: "Frustrated", 2: "Very angry" },
          probabilities: { 0: 0.0, 1: 0.95, 2: 0.05 },
          confidence: 0.92,
        },
      },
      usage: { input_tokens: 296, output_tokens: 20 },
    };
    const parsed = parseSystemOneResponse(json);
    expect(parsed.model).toBe("jev-1.13.0");
    expect(parsed.answers.is_urgent).toEqual({ type: "noul", noul: 0.95 });
    expect(parsed.answers.department).toMatchObject({
      type: "choice",
      choice: "billing",
      confidence: 0.81,
    });
    expect(parsed.answers.frustration).toMatchObject({ type: "score", score: 1.05 });
    expect(parsed.usage).toEqual({ inputTokens: 296, outputTokens: 20 });
  });

  it("drops malformed answers but keeps the valid ones", () => {
    const parsed = parseSystemOneResponse({
      answers: {
        good: { type: "noul", noul: 0.4 },
        badNoul: { type: "noul", noul: "high" },
        badChoice: { type: "choice", probabilities: {} },
        unknown: { type: "wat", x: 1 },
      },
    });
    expect(Object.keys(parsed.answers)).toEqual(["good"]);
  });

  it("tolerates a missing/non-object payload entirely", () => {
    expect(parseSystemOneResponse(null).answers).toEqual({});
    expect(parseSystemOneResponse("nope").answers).toEqual({});
    expect(parseJevAnswer(undefined)).toBeNull();
  });

  it("defaults missing confidence to 0", () => {
    const a = parseJevAnswer({ type: "choice", choice: "x", probabilities: { x: 1 } });
    expect(a).toMatchObject({ confidence: 0 });
  });
});

describe("normalizeJudgeQuestions", () => {
  it("normalizes a valid mixed batch into the id-keyed map", () => {
    const out = normalizeJudgeQuestions([
      { id: "rel", type: "noul", instructions: "Relevant?" },
      {
        id: "best",
        type: "choice",
        instructions: "Which is best?",
        criteria: { a: "first", b: "second" },
      },
      {
        id: "sev",
        type: "score",
        instructions: "How severe?",
        criteria: ["mild", "bad", "awful"],
      },
    ]);
    expect(out.errors).toEqual([]);
    expect(Object.keys(out.questions)).toEqual(["rel", "best", "sev"]);
    expect(out.questions.rel).toEqual({ type: "noul", instructions: "Relevant?" });
    expect(out.questions.sev).toMatchObject({ criteria: ["mild", "bad", "awful"] });
  });

  it("accepts choice criteria as a plain option array (→ null descriptions)", () => {
    const out = normalizeJudgeQuestions([
      { id: "pick", type: "choice", instructions: "Pick one", criteria: ["a", "b"] },
    ]);
    expect(out.questions.pick).toMatchObject({ criteria: { a: null, b: null } });
  });

  it("assigns fallback ids and accepts an id-keyed map input", () => {
    const arr = normalizeJudgeQuestions([
      { type: "noul", instructions: "One?" },
      { type: "noul", instructions: "Two?" },
    ]);
    expect(Object.keys(arr.questions)).toEqual(["q0", "q1"]);
    const map = normalizeJudgeQuestions({ flag: { type: "noul", instructions: "F?" } });
    expect(Object.keys(map.questions)).toEqual(["flag"]);
  });

  it("rejects bad questions individually, keeping the valid ones", () => {
    const out = normalizeJudgeQuestions([
      { id: "ok", type: "noul", instructions: "Fine?" },
      { id: "noInstr", type: "noul" },
      { id: "oneOpt", type: "choice", instructions: "Pick", criteria: { a: "only" } },
      { id: "oneLevel", type: "score", instructions: "Rate", criteria: ["solo"] },
      { id: "manyLevels", type: "score", instructions: "Rate", criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) },
      { id: "badType", type: "vibe", instructions: "How?" },
    ]);
    expect(Object.keys(out.questions)).toEqual(["ok"]);
    expect(out.errors).toHaveLength(5);
    expect(out.errors.join(" ")).toContain("noInstr");
    expect(out.errors.join(" ")).toContain("at least 2 options");
    expect(out.errors.join(" ")).toContain("2–10");
    expect(out.errors.join(" ")).toContain("badType");
  });

  it("caps the batch with a note and rejects duplicate ids", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: i === 5 ? "dup" : `q${i}`,
      type: "noul",
      instructions: `Q${i}?`,
    }));
    many[6] = { id: "dup", type: "noul", instructions: "Again?" };
    const out = normalizeJudgeQuestions(many);
    expect(Object.keys(out.questions)).toHaveLength(JEV_LIMITS.maxQuestions - 1); // one dup dropped
    expect(out.notes.join(" ")).toContain("only the first 20");
    expect(out.errors.join(" ")).toContain("duplicate");
  });

  it("errors on a non-array/non-object input", () => {
    const out = normalizeJudgeQuestions("nonsense");
    expect(out.questions).toEqual({});
    expect(out.errors[0]).toContain("array");
  });
});

describe("formatJevAnswerLine", () => {
  it("formats noul, choice and score compactly", () => {
    expect(formatJevAnswerLine("rel", { type: "noul", noul: 0.94 })).toBe("rel: 0.94");
    const choice: JevAnswer = {
      type: "choice",
      choice: "b",
      probabilities: { a: 0.2, b: 0.8 },
      confidence: 0.6,
    };
    expect(formatJevAnswerLine("best", choice)).toBe(
      'best: "b" (confidence 0.60; b=0.80, a=0.20)',
    );
    const score: JevAnswer = {
      type: "score",
      score: 1.6,
      legend: { 0: "low", 1: "mid", 2: "high" },
      probabilities: { 0: 0, 1: 0.4, 2: 0.6 },
      confidence: 0.2,
    };
    // 1.6 rounds to level 2 → nearest legend description is "high".
    expect(formatJevAnswerLine("sev", score)).toBe('sev: 1.60 (confidence 0.20) ≈ "high"');
  });
});

describe("thinkingForComplexity", () => {
  it("lowers effort for simple/moderate tasks within the user's cap", () => {
    expect(thinkingForComplexity("simple", "high")).toBe("low");
    expect(thinkingForComplexity("moderate", "high")).toBe("medium");
    expect(thinkingForComplexity("moderate", "medium")).toBe("medium");
    expect(thinkingForComplexity("simple", "low")).toBe("low");
  });

  it("clamps at the user's ceiling (moderate under a low cap stays low)", () => {
    expect(thinkingForComplexity("moderate", "low")).toBe("low");
  });

  it("never raises effort and never leaves 'off'", () => {
    expect(thinkingForComplexity("complex", "high")).toBe("high");
    expect(thinkingForComplexity("complex", "off")).toBe("off");
    expect(thinkingForComplexity("simple", "off")).toBe("off");
  });

  it("falls back to the user level on unknown/missing grades", () => {
    expect(thinkingForComplexity(undefined, "high")).toBe("high");
    expect(thinkingForComplexity("wat", "medium")).toBe("medium");
  });
});

describe("describeJevHttpError", () => {
  it("names the actual cause per status", () => {
    expect(describeJevHttpError(401)).toContain("rejected the Jev API key");
    expect(describeJevHttpError(422)).toContain("validation");
    expect(describeJevHttpError(429)).toContain("rate limit");
    expect(describeJevHttpError(529)).toContain("overloaded");
    expect(describeJevHttpError(500)).toContain("HTTP 500");
  });

  it("names the gateway causes on the openai transport", () => {
    expect(describeJevHttpError(401, "openai")).toContain("rejected the API key");
    expect(describeJevHttpError(402, "openai")).toContain("insufficient credits");
    // The 404 must point at the real cause: OpenRouter serves no /systemone.
    expect(describeJevHttpError(404, "openai")).toContain("openrouter.ai/api/v1");
    expect(describeJevHttpError(404, "openai")).toContain("/systemone");
    expect(describeJevHttpError(429, "openai")).toContain("rate limit");
    expect(describeJevHttpError(500, "openai")).toContain("HTTP 500");
  });
});

// ---------------- policy integration ----------------

const upgradeProbe: ElementProbe = {
  tag: "button",
  type: "button",
  text: "Upgrade plan",
  inForm: false,
};

describe("JEV_RISK_QUESTIONS", () => {
  it("is one batched request of four literal noul questions", () => {
    expect(Object.keys(JEV_RISK_QUESTIONS).sort()).toEqual([
      "beyond_task",
      "credential",
      "irreversible",
      "purchase",
    ]);
    for (const q of Object.values(JEV_RISK_QUESTIONS)) {
      expect(q.type).toBe("noul");
      expect(q.instructions.length).toBeGreaterThan(30);
    }
  });
});

describe("assessWithJev — union-only merge", () => {
  const allow = { level: "allow" as const };

  it("never touches an existing regex confirm", () => {
    const base = assess("evaluate_js", { expression: "1+1" });
    expect(assessWithJev(base, { purchase: 0.01 }, "x")).toBe(base);
  });

  it("treats null/undefined answers as no signal", () => {
    expect(assessWithJev(allow, null)).toEqual(allow);
    expect(assessWithJev(allow, undefined)).toEqual(allow);
    expect(assessWithJev(allow, {})).toEqual(allow);
  });

  it("gates at the threshold and not one tick below", () => {
    expect(assessWithJev(allow, { purchase: 0.74 }).level).toBe("allow");
    const gated = assessWithJev(allow, { purchase: JEV_RISK_THRESHOLDS.purchase }, "Upgrade plan");
    expect(gated).toMatchObject({ level: "confirm", rule: "purchase" });
    expect((gated as { summary: string }).summary).toContain("Jev");
    expect((gated as { summary: string }).summary).toContain("75%");
    expect((gated as { summary: string }).summary).toContain("Upgrade plan");
  });

  it("maps credential → password and gates irreversible / beyond_task", () => {
    expect(assessWithJev(allow, { credential: 0.9 })).toMatchObject({ rule: "password" });
    expect(assessWithJev(allow, { irreversible: 0.7 })).toMatchObject({ rule: "irreversible" });
    expect(assessWithJev(allow, { beyondTask: 0.84 }).level).toBe("allow");
    expect(assessWithJev(allow, { beyondTask: 0.85 })).toMatchObject({ rule: "beyond_task" });
  });

  it("first match wins in priority order", () => {
    expect(
      assessWithJev(allow, { purchase: 0.9, credential: 0.99, irreversible: 0.99, beyondTask: 0.99 }),
    ).toMatchObject({ rule: "purchase" });
  });
});

describe("toRiskAnswers", () => {
  it("maps the question ids onto the risk shape", () => {
    const mapped = toRiskAnswers({
      purchase: { type: "noul", noul: 0.9 },
      credential: { type: "noul", noul: 0.1 },
      irreversible: { type: "noul", noul: 0.2 },
      beyond_task: { type: "noul", noul: 0.3 },
    });
    expect(mapped).toEqual({
      purchase: 0.9,
      credential: 0.1,
      irreversible: 0.2,
      beyondTask: 0.3,
    });
  });

  it("ignores missing ids and wrong answer types, passes null through", () => {
    const mapped = toRiskAnswers({
      purchase: { type: "choice", choice: "x", probabilities: {}, confidence: 0 },
    } as Record<string, JevAnswer>);
    expect(mapped?.purchase).toBeUndefined();
    expect(toRiskAnswers(null)).toBeNull();
  });
});

describe("buildRiskState", () => {
  it("stays small and literal: clipped task, digested args, probe summary", () => {
    const state = buildRiskState(
      "t".repeat(5_000),
      "type",
      { ref: "4", text: "s".repeat(500), submit: true, weird: { a: 1 } },
      upgradeProbe,
    ) as { task: string; action: { tool: string; args: Record<string, unknown> }; element: Record<string, unknown> };
    expect(state.task).toHaveLength(2_000);
    expect(state.action.tool).toBe("type");
    expect(String(state.action.args.text).length).toBeLessThanOrEqual(201);
    expect(state.action.args.submit).toBe(true);
    expect(state.element).toEqual({
      tag: "button",
      type: "button",
      text: "Upgrade plan",
      inForm: false,
    });
  });

  it("nulls the element without a probe", () => {
    const state = buildRiskState("t", "navigate", { url: "https://x.example" }, null) as {
      element: unknown;
    };
    expect(state.element).toBeNull();
  });
});

// ---------------- settings & client factory ----------------

describe("settings — jev block", () => {
  it("defaults to disabled with the documented endpoint", () => {
    const s = normalizeSettings(undefined);
    expect(s.jev).toEqual({
      enabled: false,
      transport: "typesafe",
      apiKey: "",
      baseUrl: JEV_DEFAULTS.baseUrl,
      model: JEV_DEFAULTS.model,
    });
    expect(s.autoThinking).toBe(false);
  });

  it("backfills partial stored blocks and coerces the toggles", () => {
    const s = normalizeSettings({
      jev: { enabled: true, apiKey: "tsk-1" } as never,
      autoThinking: "yes" as never,
    });
    expect(s.jev).toEqual({
      enabled: true,
      // Legacy blocks predate transports — they were TypeSafe-only.
      transport: "typesafe",
      apiKey: "tsk-1",
      baseUrl: JEV_DEFAULTS.baseUrl,
      model: JEV_DEFAULTS.model,
    });
    expect(s.autoThinking).toBe(false); // only a real true enables
  });

  it("resolves blank endpoint/model from the selected transport", () => {
    const s = normalizeSettings({
      jev: { enabled: true, transport: "openai", apiKey: "sk-or-1" } as never,
    });
    expect(s.jev).toEqual({
      enabled: true,
      transport: "openai",
      apiKey: "sk-or-1",
      baseUrl: JEV_TRANSPORT_DEFAULTS.openai.baseUrl,
      model: JEV_TRANSPORT_DEFAULTS.openai.model,
    });
  });

  it("coerces an unknown transport back to typesafe", () => {
    const s = normalizeSettings({
      jev: { enabled: true, transport: "gemini" as never, apiKey: "k" } as never,
    });
    expect(s.jev.transport).toBe("typesafe");
  });

  it("infers the chat transport for a legacy block already pointed at OpenRouter", () => {
    // Such a block could never have worked (OpenRouter has no /systemone), so
    // it is rescued rather than left 404-ing — and a blank model then resolves
    // from the inferred transport.
    const s = normalizeSettings({
      jev: {
        enabled: true,
        apiKey: "sk-or-legacy",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "",
      } as never,
    });
    expect(s.jev.transport).toBe("openai");
    expect(s.jev.model).toBe(JEV_TRANSPORT_DEFAULTS.openai.model);
    expect(s.jev.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("keeps an explicit transport even when the base URL looks like another", () => {
    const s = normalizeSettings({
      jev: {
        enabled: true,
        transport: "typesafe",
        apiKey: "k",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "jev-latest",
      } as never,
    });
    expect(s.jev.transport).toBe("typesafe");
  });

  it("survives a save/load round-trip", () => {
    const once = normalizeSettings({
      ...DEFAULT_SETTINGS,
      jev: {
        enabled: true,
        transport: "openai",
        apiKey: "sk-or-2",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "jev-mock",
      },
      autoThinking: true,
    });
    const twice = normalizeSettings(once);
    expect(twice.jev).toEqual(once.jev);
    expect(twice.jev.transport).toBe("openai");
    expect(twice.autoThinking).toBe(true);
  });
});

describe("createJevClient", () => {
  it("is null when disabled, missing, or keyless", () => {
    expect(createJevClient(undefined)).toBeNull();
    expect(createJevClient({ enabled: false, apiKey: "tsk-x" })).toBeNull();
    expect(createJevClient({ enabled: true, apiKey: "   " })).toBeNull();
  });

  it("builds a client when enabled with a key", () => {
    expect(createJevClient({ enabled: true, apiKey: "tsk-x" })).not.toBeNull();
  });

  it("defaults to the TypeSafe transport (legacy blocks keep working)", () => {
    const client = createJevClient({ enabled: true, apiKey: "tsk-x" });
    expect(client?.transport).toBe("typesafe");
    expect(client?.isChatTransport).toBe(false);
  });

  it("resolves the OpenRouter endpoint and model for the openai transport", () => {
    const client = createJevClient({
      enabled: true,
      transport: "openai",
      apiKey: "sk-or-x",
      baseUrl: "",
      model: "",
    });
    expect(client?.transport).toBe("openai");
    expect(client?.isChatTransport).toBe(true);
    // Blank fields resolve from the transport, not from TypeSafe.
    expect(JSON.stringify(client)).toContain(JEV_TRANSPORT_DEFAULTS.openai.baseUrl);
    expect(JSON.stringify(client)).toContain(JEV_TRANSPORT_DEFAULTS.openai.model);
  });
});

// ---------------- prompt integration ----------------

describe("buildSystemPrompt — judge rule", () => {
  it("stays byte-identical without the judge tool", () => {
    expect(buildSystemPrompt("t", "auto", false, false)).toBe(buildSystemPrompt("t", "auto"));
    expect(buildSystemPrompt("t", "auto")).not.toContain("`judge`");
  });

  it("adds the bulk-judgment rule when Jev is available", () => {
    const p = buildSystemPrompt("t", "auto", false, true);
    expect(p).toContain("ONE `judge` call");
    expect(p).toContain("keep counting, arithmetic and date comparisons");
  });

  it("coexists with madman mode", () => {
    const p = buildSystemPrompt("t", "auto", true, true);
    expect(p).toContain("`judge`");
    expect(p.toLowerCase()).toMatch(/fuck|shit|damn|hell|ass|crap|bloody/);
  });
});
