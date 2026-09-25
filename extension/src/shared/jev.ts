// Jev (TypeSafe "System One") wire types + pure request/response shaping.
//
// Jev is a decision model that works ALONGSIDE the selected chat provider —
// it never replaces it. It generates no text and requests no tools: you send
// a `state` plus a map of typed `questions` and get back one typed answer per
// question, all evaluated in parallel in a single request:
//   - noul   → probability a statement is true (0..1)
//   - choice → picked option + full probability distribution + confidence
//   - score  → position along an ordered rubric + confidence
// Pure — unit-tested. The fetch client lives in background/agent/jev.ts.
// Wire reference: https://docs.typesafe.ai/api (native) — see JevTransport
// below for the OpenRouter / OpenAI-compatible chat-completions transport.

import type { ThinkingLevel } from "./llm";

/** What Jev accepts as state: text, a list of texts, or structured data. */
export type JevState = string | string[] | Record<string, unknown>;

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  /** Optional descriptions of what yes (near 1) and no (near 0) mean. */
  criteria?: { true?: string; false?: string };
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option → rubric description; null when an option needs no detail. */
  criteria: Record<string, string | null>;
}

export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered level descriptions, low → high (2–10 levels). */
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResult {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { inputTokens: number; outputTokens: number };
}

export const JEV_DEFAULTS = {
  baseUrl: "https://api.typesafe.ai/v1",
  model: "jev-latest",
} as const;

/**
 * How the sidecar reaches a decision model:
 *
 *   - `typesafe` → TypeSafe's own endpoint, `POST {baseUrl}/systemone`
 *     (Jev proper: calibrated single-pass decisions).
 *   - `openai`   → any OpenAI-compatible chat endpoint (OpenRouter, OpenAI,
 *     a local vLLM…): the same typed questions are sent as ONE
 *     `POST {baseUrl}/chat/completions` with a strict JSON-Schema
 *     `response_format`, then parsed back into the same JevAnswer shapes.
 *
 * Why the second transport exists: OpenRouter lists TypeSafe as a provider but
 * routes no Jev model, and it does not implement `/systemone` at all — so an
 * OpenRouter key can only drive the sidecar through `openai`. The chat path is
 * functionally equivalent (same questions, same answer types, same fail-open
 * fallbacks) but is a full model round-trip: slower, and its probabilities are
 * model-estimated rather than calibrated.
 */
export type JevTransport = "typesafe" | "openai";

export const JEV_TRANSPORT_DEFAULTS: Record<JevTransport, { baseUrl: string; model: string }> = {
  typesafe: { baseUrl: JEV_DEFAULTS.baseUrl, model: JEV_DEFAULTS.model },
  // Cheapest structured-output model in OpenRouter's catalog; overridable.
  openai: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-20b" },
};

export const JEV_TRANSPORT_OPTIONS: { value: JevTransport; label: string }[] = [
  { value: "typesafe", label: "TypeSafe (Jev)" },
  { value: "openai", label: "OpenRouter / OpenAI-compatible" },
];

/** Anything unrecognised (including legacy absent values) means TypeSafe. */
export function normalizeJevTransport(value: unknown): JevTransport {
  return value === "openai" ? "openai" : "typesafe";
}

/** Endpoint + model defaults for a transport (used when a field is blank). */
export function jevDefaultsFor(transport: JevTransport): { baseUrl: string; model: string } {
  return JEV_TRANSPORT_DEFAULTS[transport];
}

/**
 * Request caps. Jev's jaggedness doc is explicit: large state full of
 * irrelevant detail degrades answers, so send only what the question needs —
 * these caps are the safety net, not the target.
 */
export const JEV_LIMITS = {
  maxStateChars: 24_000,
  maxStateItems: 100,
  maxQuestions: 20,
  maxChoiceOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
} as const;

export function clipJevText(text: string, max: number = JEV_LIMITS.maxStateChars): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

// ---------------- request shaping (pure) ----------------

export function buildSystemOneBody(
  state: JevState,
  questions: Record<string, JevQuestion>,
  model: string,
): Record<string, unknown> {
  return { model: model || JEV_DEFAULTS.model, state, questions };
}

/** Coerce arbitrary tool-call state into a bounded JevState. */
export function serializeJevState(state: unknown): JevState {
  if (typeof state === "string") return clipJevText(state);
  if (Array.isArray(state)) {
    return state
      .slice(0, JEV_LIMITS.maxStateItems)
      .map((item) => (typeof item === "string" ? clipJevText(item, 2_000) : item));
  }
  if (state && typeof state === "object") {
    const json = JSON.stringify(state);
    // Structured objects go through as-is under the budget; oversized ones
    // degrade to clipped JSON text rather than blowing the request up.
    if (json.length <= JEV_LIMITS.maxStateChars) return state as Record<string, unknown>;
    return clipJevText(json);
  }
  return String(state ?? "");
}

/**
 * Normalize the model-supplied `questions` array into the API's id-keyed map.
 * Bad questions are dropped with a per-question message; the valid ones still
 * go through (a partial answer beats a hard failure mid-run).
 */
export interface NormalizedQuestions {
  questions: Record<string, JevQuestion>;
  errors: string[];
  notes: string[];
}

export function normalizeJudgeQuestions(raw: unknown): NormalizedQuestions {
  const questions: Record<string, JevQuestion> = {};
  const errors: string[] = [];
  const notes: string[] = [];

  let entries: [string, unknown][];
  if (Array.isArray(raw)) {
    entries = raw.map((q, i) => {
      const id = (q as { id?: unknown })?.id;
      return [typeof id === "string" && id.trim() ? id.trim() : `q${i}`, q] as [string, unknown];
    });
  } else if (raw && typeof raw === "object") {
    entries = Object.entries(raw as Record<string, unknown>);
  } else {
    return { questions, errors: ["questions must be an array (or a map of id → question)"], notes };
  }

  if (entries.length > JEV_LIMITS.maxQuestions) {
    notes.push(
      `only the first ${JEV_LIMITS.maxQuestions} of ${entries.length} questions were sent (per-call cap)`,
    );
    entries = entries.slice(0, JEV_LIMITS.maxQuestions);
  }

  for (const [id, rawQ] of entries) {
    const q = (rawQ ?? {}) as Record<string, unknown>;
    const instructions = typeof q.instructions === "string" ? q.instructions.trim() : "";
    if (!instructions) {
      errors.push(`${id}: missing 'instructions' text`);
      continue;
    }
    if (id in questions) {
      errors.push(`${id}: duplicate question id`);
      continue;
    }
    switch (q.type) {
      case "noul": {
        const crit = (q.criteria ?? {}) as Record<string, unknown>;
        const criteria: { true?: string; false?: string } = {};
        if (typeof crit.true === "string") criteria.true = crit.true;
        if (typeof crit.false === "string") criteria.false = crit.false;
        questions[id] = Object.keys(criteria).length
          ? { type: "noul", instructions, criteria }
          : { type: "noul", instructions };
        break;
      }
      case "choice": {
        const map = normalizeChoiceCriteria(q.criteria);
        if (!map || Object.keys(map).length < 2) {
          errors.push(
            `${id}: choice needs 'criteria' with at least 2 options (a map of option → description, or an array of options)`,
          );
          continue;
        }
        questions[id] = { type: "choice", instructions, criteria: map };
        break;
      }
      case "score": {
        const levels = Array.isArray(q.criteria)
          ? q.criteria.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
          : [];
        if (
          levels.length < JEV_LIMITS.minScoreLevels ||
          levels.length > JEV_LIMITS.maxScoreLevels
        ) {
          errors.push(
            `${id}: score needs an ordered 'criteria' array of ${JEV_LIMITS.minScoreLevels}–${JEV_LIMITS.maxScoreLevels} level descriptions`,
          );
          continue;
        }
        questions[id] = { type: "score", instructions, criteria: levels };
        break;
      }
      default:
        errors.push(`${id}: type must be "noul", "choice" or "score" (got ${JSON.stringify(q.type)})`);
    }
  }
  return { questions, errors, notes };
}

function normalizeChoiceCriteria(
  raw: unknown,
): Record<string, string | null> | null {
  const out: Record<string, string | null> = {};
  if (Array.isArray(raw)) {
    for (const option of raw) {
      if (typeof option !== "string" || !option.trim()) continue;
      out[option.trim()] = null;
      if (Object.keys(out).length >= JEV_LIMITS.maxChoiceOptions) break;
    }
  } else if (raw && typeof raw === "object") {
    for (const [option, description] of Object.entries(raw as Record<string, unknown>)) {
      if (!option.trim()) continue;
      out[option.trim()] = typeof description === "string" ? description : null;
      if (Object.keys(out).length >= JEV_LIMITS.maxChoiceOptions) break;
    }
  } else {
    return null;
  }
  return Object.keys(out).length ? out : null;
}

// ---------------- response parsing (pure, tolerant) ----------------

export function parseSystemOneResponse(json: unknown): JevResult {
  const root = (json ?? {}) as Record<string, unknown>;
  const rawAnswers =
    root.answers && typeof root.answers === "object"
      ? (root.answers as Record<string, unknown>)
      : {};
  const answers: Record<string, JevAnswer> = {};
  for (const [id, raw] of Object.entries(rawAnswers)) {
    const answer = parseJevAnswer(raw);
    if (answer) answers[id] = answer; // malformed entries drop; the rest stand
  }
  const rawUsage = root.usage as Record<string, unknown> | undefined;
  const usage =
    rawUsage && typeof rawUsage === "object"
      ? {
          inputTokens: Number(rawUsage.input_tokens ?? 0),
          outputTokens: Number(rawUsage.output_tokens ?? 0),
        }
      : undefined;
  return {
    model: typeof root.model === "string" ? root.model : undefined,
    answers,
    usage,
  };
}

export function parseJevAnswer(raw: unknown): JevAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case "noul":
      return typeof a.noul === "number" && Number.isFinite(a.noul)
        ? { type: "noul", noul: a.noul }
        : null;
    case "choice":
      return typeof a.choice === "string"
        ? {
            type: "choice",
            choice: a.choice,
            probabilities: toNumberMap(a.probabilities),
            confidence: typeof a.confidence === "number" ? a.confidence : 0,
          }
        : null;
    case "score":
      return typeof a.score === "number" && Number.isFinite(a.score)
        ? {
            type: "score",
            score: a.score,
            legend: toStringMap(a.legend),
            probabilities: toNumberMap(a.probabilities),
            confidence: typeof a.confidence === "number" ? a.confidence : 0,
          }
        : null;
    default:
      return null;
  }
}

function toNumberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

function toStringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

// ---------------- chat-completions transport (OpenRouter et al.) ----------------
//
// Same questions, same answer types, different wire. The typed questions are
// flattened into a prompt and the answers are pinned by a strict JSON Schema
// generated from the question ids (so the model cannot invent ids or choice
// options). Everything here is pure; the fetch lives in background/agent/jev.ts.

/** Marker the request carries in `response_format.json_schema.name`. */
export const JEV_OPENAI_SCHEMA_NAME = "jev_answers";

/**
 * Output cap for one chat-transport decision. Generous on purpose: reasoning
 * models (the default `openai/gpt-oss-20b` among them) spend completion tokens
 * thinking before the JSON answer, so a tight cap truncates exactly the call
 * that needed the most deliberation. Still bounded — a runaway answer can't
 * cost more than a few hundredths of a cent.
 */
export const JEV_OPENAI_MAX_TOKENS = 4_096;

const JEV_CHAT_SYSTEM_PROMPT = [
  "You are Jev, a decision model. You never chat, explain, or produce prose:",
  "you evaluate a STATE against TYPED QUESTIONS and answer in JSON only.",
  "",
  "One answer per question id, shaped by the question's type:",
  '- noul   → {"type":"noul","noul":P}  P = probability (0..1) the statement is true.',
  '- choice → {"type":"choice","choice":O,"probabilities":{<every option>:P},"confidence":C}',
  "           O must be one of the listed options; probabilities must sum to ~1.",
  '- score  → {"type":"score","score":S,"confidence":C}  S = position on the',
  "           ordered rubric, counting from 0 for the first level.",
  "",
  "Rules: judge only from the STATE — never invent facts or use outside knowledge;",
  "keep probabilities honest (0.5 when genuinely unsure); confidence reflects how",
  "sure you are. Reply with a single JSON object and nothing else.",
].join("\n");

function schemaForQuestion(q: JevQuestion): Record<string, unknown> {
  switch (q.type) {
    case "noul":
      return {
        type: "object",
        additionalProperties: false,
        required: ["type", "noul"],
        // `enum` of one, not `const`: the OpenAI strict-mode subset that most
        // gateways (including OpenRouter) enforce does not support `const`.
        properties: { type: { enum: ["noul"] }, noul: { type: "number" } },
      };
    case "choice": {
      const options = Object.keys(q.criteria).filter((o) => o.trim());
      if (!options.length) {
        return {
          type: "object",
          additionalProperties: false,
          required: ["type", "choice", "probabilities", "confidence"],
          properties: {
            type: { enum: ["choice"] },
            choice: { type: "string" },
            probabilities: { type: "object" },
            confidence: { type: "number" },
          },
        };
      }
      return {
        type: "object",
        additionalProperties: false,
        required: ["type", "choice", "probabilities", "confidence"],
        properties: {
          type: { enum: ["choice"] },
          choice: { type: "string", enum: options },
          probabilities: {
            type: "object",
            additionalProperties: false,
            required: options,
            properties: Object.fromEntries(options.map((o) => [o, { type: "number" }])),
          },
          confidence: { type: "number" },
        },
      };
    }
    case "score":
      return {
        type: "object",
        additionalProperties: false,
        required: ["type", "score", "confidence"],
        properties: {
          type: { enum: ["score"] },
          score: { type: "number" },
          confidence: { type: "number" },
        },
      };
  }
}

/** Strict JSON Schema pinning one answer per known question id. */
export function buildJevAnswersSchema(
  questions: Record<string, JevQuestion>,
): Record<string, unknown> {
  const ids = Object.keys(questions);
  return {
    type: "object",
    additionalProperties: false,
    required: ["answers"],
    properties: {
      answers: {
        type: "object",
        additionalProperties: false,
        required: ids,
        properties: Object.fromEntries(ids.map((id) => [id, schemaForQuestion(questions[id]!)])),
      },
    },
  };
}

/**
 * The single user message: the state, then the questions as JSON on the last
 * line (the shape the mock server and any log reader can lift back out).
 */
export function buildOpenAiJevPrompt(
  state: JevState,
  questions: Record<string, JevQuestion>,
): string {
  const rendered = typeof state === "string" ? state : JSON.stringify(state, null, 2);
  return `state:\n${rendered}\n\nquestions:\n${JSON.stringify(questions, null, 2)}`;
}

export function buildOpenAiJevMessages(
  state: JevState,
  questions: Record<string, JevQuestion>,
): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: JEV_CHAT_SYSTEM_PROMPT },
    { role: "user", content: buildOpenAiJevPrompt(state, questions) },
  ];
}

export function buildOpenAiJevBody(
  state: JevState,
  questions: Record<string, JevQuestion>,
  model: string,
): Record<string, unknown> {
  return {
    model: model || JEV_TRANSPORT_DEFAULTS.openai.model,
    messages: buildOpenAiJevMessages(state, questions),
    // Greedy decoding: a decision model should not be creative.
    temperature: 0,
    max_tokens: JEV_OPENAI_MAX_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: JEV_OPENAI_SCHEMA_NAME,
        strict: true,
        schema: buildJevAnswersSchema(questions),
      },
    },
  };
}

/**
 * Pull the assistant text out of a chat completion. Tolerates the shapes
 * gateways actually return: fenced JSON, content parts, and reasoning models
 * that leave `content` empty and put everything in a reasoning field.
 */
export function extractChatCompletionText(json: unknown): string {
  const root = (json ?? {}) as Record<string, unknown>;
  const choice = (root.choices as Record<string, unknown>[] | undefined)?.[0];
  const message = ((choice?.message ?? choice?.delta) ?? {}) as Record<string, unknown>;
  let content: unknown = message.content;
  if (Array.isArray(content)) {
    content = content
      .map((part) =>
        typeof part === "string" ? part : ((part as Record<string, unknown>)?.text ?? ""),
      )
      .join("");
  }
  if (typeof content !== "string" || !content.trim()) {
    const reasoning = message.reasoning ?? message.reasoning_content;
    if (typeof reasoning === "string") content = reasoning;
  }
  return typeof content === "string" ? content : "";
}

/** Parse JSON out of model text, tolerating ```json fences and prose around it. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const candidates = [cleaned];
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start && (start > 0 || end < cleaned.length - 1)) {
    candidates.push(cleaned.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Parse a chat completion into a JevResult. Tolerant by design: a missing
 * `type` is inferred from the question, score legends are rebuilt locally from
 * the rubric we sent (the model is never asked to echo them), and malformed
 * answers drop while the valid ones stand.
 */
export function parseOpenAiJevResponse(
  json: unknown,
  questions: Record<string, JevQuestion>,
): JevResult {
  const root = (json ?? {}) as Record<string, unknown>;
  const parsed = extractJsonObject(extractChatCompletionText(root));
  const rawAnswers = extractAnswersMap(parsed);
  const answers: Record<string, JevAnswer> = {};
  for (const [id, raw] of Object.entries(rawAnswers)) {
    const question = questions[id];
    const shaped =
      raw && typeof raw === "object" && !("type" in (raw as object)) && question
        ? { ...(raw as Record<string, unknown>), type: question.type }
        : raw;
    let answer = parseJevAnswer(shaped);
    if (!answer) continue;
    if (answer.type === "score" && question?.type === "score") {
      const levels = question.criteria;
      const score = Math.min(Math.max(answer.score, 0), Math.max(levels.length - 1, 0));
      answer = {
        ...answer,
        score,
        legend: Object.keys(answer.legend).length
          ? answer.legend
          : Object.fromEntries(levels.map((level, i) => [String(i), level])),
      };
    }
    answers[id] = answer;
  }
  return { model: typeof root.model === "string" ? root.model : undefined, answers, usage: chatUsage(root) };
}

/** `{answers:{…}}` when present, else a bare id → answer map. */
function extractAnswersMap(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) return {};
  const nested = parsed.answers;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  // No wrapper: accept a top-level map as long as some value looks like an
  // answer (the malformed entries drop individually during parsing).
  const values = Object.values(parsed);
  const looksLikeAnswers = values.some(
    (v) => v && typeof v === "object" && "type" in (v as object),
  );
  return looksLikeAnswers ? parsed : {};
}

function chatUsage(root: Record<string, unknown>): JevResult["usage"] {
  const usage = root.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return undefined;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  return { inputTokens: Number(input ?? 0), outputTokens: Number(output ?? 0) };
}

/** Turn a status code into an explanation that names the actual cause. */
export function describeJevHttpError(
  status: number,
  transport: JevTransport = "typesafe",
): string {
  if (transport === "openai") {
    switch (status) {
      case 401:
        return "HTTP 401 — the endpoint rejected the API key. Check it in Settings → Fast decisions (Jev).";
      case 402:
        return "HTTP 402 — OpenRouter reports insufficient credits for this key.";
      case 403:
        return "HTTP 403 — the model or key is not permitted on this endpoint (check the model id and key limits).";
      case 404:
        return "HTTP 404 — no /chat/completions at that base URL. OpenRouter's is https://openrouter.ai/api/v1 (Jev's own /systemone is only served by TypeSafe).";
      case 422:
        return "HTTP 422 — the request failed validation (a question or the state was malformed).";
      case 429:
        return "HTTP 429 — rate limit or quota reached on this endpoint; retry shortly.";
      case 529:
        return "HTTP 529 — the endpoint is temporarily overloaded; retry shortly.";
      default:
        return `HTTP ${status} — Jev evaluation failed.`;
    }
  }
  switch (status) {
    case 401:
      return "HTTP 401 — TypeSafe rejected the Jev API key. Check it in Settings → Fast decisions (Jev).";
    case 422:
      return "HTTP 422 — the request failed validation (a question or the state was malformed).";
    case 429:
      return "HTTP 429 — Jev rate limit or quota reached; retry shortly.";
    case 529:
      return "HTTP 529 — TypeSafe is temporarily overloaded; retry shortly.";
    default:
      return `HTTP ${status} — Jev evaluation failed.`;
  }
}

// ---------------- presentation (pure) ----------------

const p2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** One compact line per answer — what the judge tool feeds back to the model. */
export function formatJevAnswerLine(id: string, answer: JevAnswer): string {
  switch (answer.type) {
    case "noul":
      return `${id}: ${p2(answer.noul)}`;
    case "choice": {
      const top = Object.entries(answer.probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([option, prob]) => `${option}=${p2(prob)}`)
        .join(", ");
      return `${id}: "${answer.choice}" (confidence ${p2(answer.confidence)}${top ? `; ${top}` : ""})`;
    }
    case "score": {
      const nearest = answer.legend[String(Math.round(answer.score))];
      return `${id}: ${p2(answer.score)} (confidence ${p2(answer.confidence)})${nearest ? ` ≈ "${nearest}"` : ""}`;
    }
  }
}

// ---------------- effort routing (pure mapping) ----------------

/** Choice criteria for grading how much work a task needs. */
export const JEV_COMPLEXITY_CRITERIA: Record<string, string> = {
  simple: "Direct lookup answerable from one page in a few steps",
  moderate: "Multi-step navigation, forms, or comparison across a few pages",
  complex: "Open-ended research, many steps, cross-site work, or an ambiguous goal",
};

const LEVEL_ORDER: ThinkingLevel[] = ["off", "low", "medium", "high"];

/**
 * Map Jev's complexity pick onto a thinking level, clamped so routing can
 * only ever LOWER effort within the user's chosen ceiling — never raise it.
 */
export function thinkingForComplexity(
  complexity: string | undefined,
  userLevel: ThinkingLevel,
): ThinkingLevel {
  const wanted: ThinkingLevel =
    complexity === "simple" ? "low" : complexity === "moderate" ? "medium" : userLevel;
  const cap = LEVEL_ORDER.indexOf(userLevel);
  const idx = LEVEL_ORDER.indexOf(wanted);
  if (cap <= 0 || idx < 0) return userLevel; // "off" (or unknown) — nothing to lower
  return LEVEL_ORDER[Math.min(idx, cap)]!;
}
