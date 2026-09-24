#!/usr/bin/env node
// Mock LLM server speaking BOTH wire protocols over real HTTP + SSE:
//   POST …/chat/completions  (OpenAI-compatible, streamed tool_calls)
//   POST …/messages          (Anthropic Messages, streamed tool_use blocks)
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

export function startMockLlm({ script, port = 8792 }) {
  let activeScript = script;
  const hits = { openai: 0, anthropic: 0 };
  let lastBody = null;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {}
    const kind = String(req.url).includes("chat/completions") ? "openai" : "anthropic";
    hits[kind]++;
    lastBody = body;
    const turn = countToolResults(body, kind);
    const step = activeScript[Math.min(turn, activeScript.length - 1)];
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
    setScript(s) {
      activeScript = s;
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
