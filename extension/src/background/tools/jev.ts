// The `judge` tool — the selected model's window onto the Jev sidecar. One
// call offloads bulk structured decisions (per-item yes/no filters, best-of
// picks, rubric scores) that would otherwise cost one slow LLM step per item.
// Registered unconditionally; sw.ts only offers it to the model when Jev is
// configured, and run() fails cleanly when the sidecar is off.
import {
  JEV_LIMITS,
  formatJevAnswerLine,
  normalizeJudgeQuestions,
  serializeJevState,
  type JevAnswer,
} from "../../shared/jev";
import { getActiveJevClient } from "../agent/jev";
import { registerTool } from "./types";

interface JudgePayload {
  answers: Record<string, JevAnswer>;
  errors?: string[];
  notes?: string[];
  usage?: { inputTokens: number; outputTokens: number };
}

registerTool({
  name: "judge",
  description:
    "Fast structured decisions about text or a list of items, via a decision model (Jev). Use ONE call for bulk per-item judgments — relevance filtering, picking the best option, rubric scores, yes/no checks over many items; all questions are evaluated in parallel, far faster than examining items one by one. Do NOT use it for arithmetic, counting, or date comparisons (do those yourself), and it never generates text. Every answer carries a probability/confidence — treat low-confidence answers as uncertain.",
  parameters: {
    type: "object",
    properties: {
      state: {
        description:
          "The content to judge: a string, an array of item strings (one per candidate), or a structured object. Send only what the questions need.",
      },
      questions: {
        type: "array",
        description:
          'Up to 20 questions, each { "id": string, "type": "noul" | "choice" | "score", "instructions": string, "criteria"? }. noul: yes/no statement → probability (optional criteria {"true": …, "false": …}). choice: pick one option → criteria is an option→description map or an array of option strings. score: rate on a rubric → criteria is an ordered array of 2–10 level descriptions. For a list of items ask one question per item, e.g. id "item_3": "Is `item_3` relevant to: …?"',
      },
    },
    required: ["state", "questions"],
  },
  async run(args) {
    const client = getActiveJevClient();
    if (!client) {
      return {
        ok: false,
        error: "judge requires Jev — enable it in Settings → Fast decisions (Jev)",
      };
    }
    const normalized = normalizeJudgeQuestions(args.questions);
    if (!Object.keys(normalized.questions).length) {
      return {
        ok: false,
        error: `no valid questions — ${normalized.errors.join("; ") || "empty question list"}`,
      };
    }
    const notes = [...normalized.notes];
    if (Array.isArray(args.state) && args.state.length > JEV_LIMITS.maxStateItems) {
      notes.push(
        `state clipped to the first ${JEV_LIMITS.maxStateItems} of ${args.state.length} items`,
      );
    }
    const state = serializeJevState(args.state);
    const result = await client.decideWithRetry(state, normalized.questions, {
      timeoutMs: 8_000,
    });
    const payload: JudgePayload = {
      answers: result.answers,
      errors: normalized.errors.length ? normalized.errors : undefined,
      notes: notes.length ? notes : undefined,
      usage: result.usage,
    };
    return payload;
  },
  present(payload) {
    const p = payload as JudgePayload;
    const lines = Object.entries(p.answers ?? {}).map(([id, answer]) =>
      formatJevAnswerLine(id, answer),
    );
    for (const note of p.notes ?? []) lines.push(`note: ${note}`);
    for (const err of p.errors ?? []) lines.push(`skipped: ${err}`);
    return { text: lines.length ? lines.join("\n") : "(no answers returned)" };
  },
});
