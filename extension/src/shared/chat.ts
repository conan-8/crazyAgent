// Conversation model for the chat UI. Turns fold from the same StepEvent
// stream both sides already share (panel folds for live display, the worker
// folds for persistence) — one pure reducer, two consumers. Assistant content
// is an ordered list of blocks (text / tool / confirm) so the final answer
// naturally lands below the tool activity. `llm` carries the raw transcript so
// follow-up turns can continue with real context.
import type { LlmMessage } from "./llm";
import type { StepEvent } from "./protocol";

export interface ToolCard {
  name: string;
  /** Madman mode: cuss-decorated display label; falls back to `name`. */
  label?: string;
  args: string;
  result: string;
  ok: boolean;
  image?: string;
  /**
   * This call went through the Jev sidecar (the `judge` tool). The panel tints
   * the card bright pink so Jev-assisted steps stand out in the timeline.
   */
  jev?: boolean;
  /** fold bookkeeping: whether a tool_result already filled this card */
  filled?: boolean;
}

export interface ConfirmMarker {
  id: string;
  tool: string;
  summary: string;
  /** Jev raised this confirmation (not the regex rules) — pink highlight. */
  jev?: boolean;
}

/** A pause for the human: sign-in wall or CAPTCHA. */
export interface HumanMarker {
  id: string;
  reason: string;
  url: string;
  /** Set once the user answered (so a re-render shows the outcome). */
  handled?: boolean;
}

export type ChatBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; card: ToolCard }
  | { kind: "confirm"; confirm: ConfirmMarker }
  | { kind: "human"; human: HumanMarker };

export interface ChatTurn {
  role: "user" | "assistant";
  /** User turns: the message text. Assistant turns use `blocks`. */
  text: string;
  when: number;
  blocks: ChatBlock[];
  /** Attachment names shown as chips on user turns. */
  attachments?: { name: string; kind: "image" | "text" }[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
  /** Raw LLM transcript of the whole thread (follow-up context). */
  llm: LlmMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: number;
}

export function newConversation(id: string, task: string): Conversation {
  const now = Date.now();
  return {
    id,
    title: task.slice(0, 60),
    createdAt: now,
    updatedAt: now,
    turns: [],
    llm: [],
  };
}

export function foldUser(
  conv: Conversation,
  text: string,
  attachments?: { name: string; kind: "image" | "text" }[],
): void {
  conv.turns.push({
    role: "user",
    text,
    when: Date.now(),
    blocks: [],
    attachments: attachments?.length ? attachments : undefined,
  });
  conv.updatedAt = Date.now();
}

export function foldEvent(conv: Conversation, e: StepEvent): void {
  const lastTurn = (): ChatTurn | undefined => conv.turns[conv.turns.length - 1];
  const assistantTurn = (): ChatTurn => {
    const last = lastTurn();
    if (last && last.role === "assistant") return last;
    const turn: ChatTurn = {
      role: "assistant",
      text: "",
      when: Date.now(),
      blocks: [],
    };
    conv.turns.push(turn);
    return turn;
  };
  const appendText = (turn: ChatTurn, chunk: string): void => {
    const lastBlock = turn.blocks[turn.blocks.length - 1];
    if (lastBlock?.kind === "text") lastBlock.text += chunk;
    else turn.blocks.push({ kind: "text", text: chunk });
  };

  switch (e.kind) {
    case "token_delta":
      appendText(assistantTurn(), e.text);
      break;
    case "reasoning_delta": {
      // Coalesce consecutive thinking chunks into one collapsible block.
      const turn = assistantTurn();
      const lastBlock = turn.blocks[turn.blocks.length - 1];
      if (lastBlock?.kind === "reasoning") lastBlock.text += e.text;
      else turn.blocks.push({ kind: "reasoning", text: e.text });
      break;
    }
    case "tool_call":
      assistantTurn().blocks.push({
        kind: "tool",
        card: {
          name: e.name,
          // Madman mode decorates the label; `name` stays raw for matching.
          label: e.label,
          args: JSON.stringify(e.args ?? {}),
          result: "",
          ok: true,
          jev: e.jev === true ? true : undefined,
        },
      });
      break;
    case "tool_result": {
      const blocks = lastTurn()?.blocks ?? [];
      // Results arrive in call order — fill the first unfilled tool card.
      const block = blocks.find(
        (b) => b.kind === "tool" && !b.card.filled,
      ) as { kind: "tool"; card: ToolCard } | undefined;
      if (block) {
        block.card.result = e.result;
        block.card.ok = e.ok;
        block.card.image = e.image;
        block.card.filled = true;
      }
      break;
    }
    case "need_confirm":
      assistantTurn().blocks.push({
        kind: "confirm",
        confirm: {
          id: e.id,
          tool: e.tool,
          summary: e.summary,
          jev: e.jev === true ? true : undefined,
        },
      });
      break;
    case "need_human":
      assistantTurn().blocks.push({
        kind: "human",
        human: { id: e.id, reason: e.reason, url: e.url },
      });
      break;
    case "madman":
      // Mid-run exclamation — its own line, so it reads as an outburst
      // between the tool cards rather than merging into the running answer.
      appendText(assistantTurn(), `${e.message}\n`);
      break;
    case "done": {
      // The streamed answer already carries the summary — only fill a blank.
      const turn = assistantTurn();
      const hasText = turn.blocks.some(
        (b) => b.kind === "text" && b.text.trim(),
      );
      if (!hasText) turn.blocks.push({ kind: "text", text: e.summary });
      break;
    }
    case "error":
      appendText(assistantTurn(), `⚠ ${e.message}\n`);
      break;
    default:
      // info / step_started: activity noise, not chat content
      break;
  }
  conv.updatedAt = Date.now();
}

export function summarize(conv: Conversation): ConversationSummary {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    turns: conv.turns.length,
  };
}

/** Storage trim: screenshot bytes live on display cards, not in LLM context. */
export function forStorage(conv: Conversation): Conversation {
  return {
    ...conv,
    turns: conv.turns.map((t) => ({ ...t })),
    llm: conv.llm.map((m) => ({ ...m, images: undefined })),
  };
}
