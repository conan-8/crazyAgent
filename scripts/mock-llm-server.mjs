#!/usr/bin/env node
// Mock LLM server speaking BOTH wire protocols over real HTTP + SSE:
//   POST …/chat/completions  (OpenAI-compatible, streamed tool_calls)
//   POST …/messages          (Anthropic Messages, streamed tool_use blocks)
// Plus the TypeSafe Jev decision endpoint (plain JSON):
//   POST …/systemone         (noul/choice/score answers, scripted overrides)
// Plus the Jev chat-completions transport (OpenRouter et al.), recognised by
// the `response_format.json_schema.name === "jev_answers"` marker and answered
// with a non-streaming completion whose content is the same answers JSON.
// The scripted "model" advances one turn per completed tool result already in
// the conversation, so runs are stateless and replayable.
import http from "node:http";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const splitText = (text, size) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
};

function countToolResults(body, kind) {
  if (kind === "openai") {
    return (body.messages ?? []).filter((m) => m.role === "tool").length;
  }
  let n = 0;
  for (const m of body.messages ?? []) {
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block.type === "tool_result") n++;
    }
  }
  return n;
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function sseEvent(res, name, obj) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`);
}

async function streamOpenAi(res, step, turn) {
  sse(res, { choices: [{ delta: { role: "assistant", content: "" } }] });
  for (const chunk of splitText(step.text ?? "", 8)) {
    sse(res, { choices: [{ delta: { content: chunk } }] });
    await delay(60);
  }
  if (step.toolCalls?.length) {
    let idx = 0;
    for (const tc of step.toolCalls) {
      const argsStr = tc.invalidArgs ?? JSON.stringify(tc.args ?? {});
      sse(res, {
        choices: [{ delta: { tool_calls: [{ index: idx, id: `call_${turn}_${idx}`, function: { name: tc.name, arguments: "" } }] } }],
      });
      for (const piece of splitText(argsStr, 12)) {
        sse(res, { choices: [{ delta: { tool_calls: [{ index: idx, function: { arguments: piece } }] } }] });
        await delay(40);
      }
      idx++;
    }
    sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  } else {
    sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
  }
  res.write("data: [DONE]\n\n");
}

async function streamAnthropic(res, step, turn) {
  sseEvent(res, "message_start", {
    type: "message_start",
    message: { id: `msg_${turn}`, role: "assistant" },
  });
  let index = 0;
  if (step.text) {
    sseEvent(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    for (const chunk of splitText(step.text, 8)) {
      sseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: chunk },
      });
      await delay(60);
    }
    sseEvent(res, "content_block_stop", { type: "content_block_stop", index });
    index++;
  }
  let ti = 0;
  for (const tc of step.toolCalls ?? []) {
    sseEvent(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `toolu_${turn}_${ti}`, name: tc.name, input: {} },
    });
    const argsStr = tc.invalidArgs ?? JSON.stringify(tc.args ?? {});
    for (const piece of splitText(argsStr, 12)) {
      sseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: piece },
      });
      await delay(40);
    }
    sseEvent(res, "content_block_stop", { type: "content_block_stop", index });
    index++;
    ti++;
  }
  sseEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: step.toolCalls?.length ? "tool_use" : "end_turn" },
  });
  sseEvent(res, "message_stop", { type: "message_stop" });
}

/** Canned Jev answer per question type (deliberately boring: noul 0.05). */
function defaultJevAnswer(q) {
  if (q.type === "noul") return { type: "noul", noul: 0.05 };
  if (q.type === "choice") {
    const options = Object.keys(q.criteria ?? {});
    const first = options[0] ?? "";
    const rest = options.length > 1 ? 0.1 / (options.length - 1) : 0;
    const probabilities = Object.fromEntries(
      options.map((o, i) => [o, i === 0 ? 0.9 : rest]),
    );
    return { type: "choice", choice: first, probabilities, confidence: 0.9 };
  }
  const levels = Array.isArray(q.criteria) ? q.criteria : [];
  return {
    type: "score",
    score: 0,
    legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
    probabilities: levels.length ? { 0: 1 } : {},
    confidence: 1,
  };
}

/**
 * The coach (self-improvement reviewer) is recognised structurally, by the one
 * tool only it sends — the main agent never has `record_lessons`. Its calls are
 * answered from `coachScript` and logged SEPARATELY, so a review that fires
 * after a failed run can never consume a scripted agent turn or show up in
 * `requests()`/`lastRequest()` (which existing smokes assert on).
 */
const COACH_TOOL = "record_lessons";

function isCoachCall(body) {
  return (body?.tools ?? []).some(
    (t) => t?.function?.name === COACH_TOOL || t?.name === COACH_TOOL,
  );
}

/** Default coach answer: a review that learns nothing (explicit empty list). */
const DEFAULT_COACH_SCRIPT = [
  { toolCalls: [{ name: COACH_TOOL, args: { lessons: [] } }] },
];

export function startMockLlm({ script, port = 8792, jevScript = null, coachScript = null }) {
  let activeScript = script;
  /**
   * Jev overrides: null (typed defaults), "fail" (503s), or a map of
   * question id → answer fields merged over the default for that type.
   */
  let activeJevScript = jevScript;
  /** Scripted turns for coach reviews (one step per completed tool result). */
  let activeCoachScript = coachScript ?? DEFAULT_COACH_SCRIPT;
  const hits = { openai: 0, anthropic: 0, jev: 0, coach: 0 };
  let lastBody = null;
  let lastJevBody = null;
  let lastCoachBody = null;
  /** Which wire the last Jev call used: "systemone" | "chat" | null. */
  let lastJevTransport = null;
  /** Every request body seen, in order — lets a smoke assert prompt content. */
  const bodies = [];
  /** Coach review bodies, kept out of `bodies` on purpose (see isCoachCall). */
  const coachBodies = [];

  /** Canned/overridden answers for one questions map. */
  const answerFor = (questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions ?? {})) {
      const override = activeJevScript?.[id];
      answers[id] = override ? { type: q.type, ...override } : defaultJevAnswer(q);
    }
    return answers;
  };

  /**
   * The chat transport carries the questions inside the prompt (that is the
   * whole point of the prompt shape): lift the trailing `questions:` JSON back
   * out so the same scripted overrides drive both wires.
   */
  const questionsFromChat = (body) => {
    const messages = body?.messages ?? [];
    const user = [...messages].reverse().find((m) => m?.role === "user");
    const text = typeof user?.content === "string" ? user.content : "";
    const at = text.lastIndexOf("questions:");
    if (at === -1) return {};
    try {
      return JSON.parse(text.slice(at + "questions:".length));
    } catch {
      return {};
    }
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {}
    const url = String(req.url);
    // Jev (TypeSafe System-One) decision endpoint — plain JSON, no SSE.
    if (url.includes("systemone")) {
      hits.jev++;
      lastJevBody = body;
      lastJevTransport = "systemone";
      if (activeJevScript === "fail") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "mock jev overloaded" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model ?? "mock-jev",
          answers: answerFor(body.questions),
          usage: { input_tokens: 100, output_tokens: 0 },
        }),
      );
      return;
    }
    // Jev over the chat-completions transport (OpenRouter et al.), recognised
    // by our structured-output schema marker so it never collides with the
    // agent's own streaming chat calls.
    if (
      url.includes("chat/completions") &&
      body?.response_format?.json_schema?.name === "jev_answers"
    ) {
      hits.jev++;
      lastJevBody = body;
      lastJevTransport = "chat";
      if (activeJevScript === "fail") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "mock jev overloaded" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-mock-jev",
          model: body.model ?? "mock-jev",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({ answers: answerFor(questionsFromChat(body)) }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
      return;
    }
    const kind = url.includes("chat/completions") ? "openai" : "anthropic";
    // A coach review is a real model call on the same wire, but it is not part
    // of any smoke's agent script: answer it from its own script and keep it
    // out of the agent request log.
    const coach = isCoachCall(body);
    const scriptFor = coach ? activeCoachScript : activeScript;
    const turn = countToolResults(body, kind);
    const step = scriptFor[Math.min(turn, scriptFor.length - 1)];
    if (coach) {
      hits.coach++;
      lastCoachBody = body;
      coachBodies.push(body);
    } else {
      hits[kind]++;
      lastBody = body;
      bodies.push(body);
    }
    if (step.delayMs) await delay(step.delayMs);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (kind === "openai") await streamOpenAi(res, step, turn);
    else await streamAnthropic(res, step, turn);
    res.end();
  });
  server.listen(port, "127.0.0.1");
  return {
    server,
    hits: () => ({ ...hits }),
    lastRequest: () => lastBody,
    /** All request bodies seen so far, in order. */
    requests: () => bodies,
    lastJevRequest: () => lastJevBody,
    /** "systemone" | "chat" | null — which Jev wire the last call used. */
    lastJevTransport: () => lastJevTransport,
    /** Last coach (lesson review) body — never the agent's own request. */
    lastCoachRequest: () => lastCoachBody,
    /** Every coach review body, in order. */
    coachRequests: () => coachBodies,
    setScript(s) {
      activeScript = s;
    },
    setCoachScript(s) {
      activeCoachScript = s ?? DEFAULT_COACH_SCRIPT;
    },
    setJevScript(s) {
      activeJevScript = s;
    },
    close: () => server.close(),
  };
}

// Direct execution: `node scripts/mock-llm-server.mjs` (echo demo script).
if (process.argv[1] === new URL(import.meta.url).pathname) {
  startMockLlm({
    script: [{ text: "Mock LLM is running. Give me a script." }],
  });
  console.log("mock LLM on http://127.0.0.1:8792");
}
