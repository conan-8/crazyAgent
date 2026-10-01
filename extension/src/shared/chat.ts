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
  /**
   * The Jev risk layer checked this mutating action and allowed it — a small
   * pink accent (rail + dot) marks the card without the full Jev tint.
   */
  jevGate?: boolean;
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
  | { kind: "human"; human: HumanMarker }
  | {
      /** A one-line system note (only Jev-flagged info folds into chat). */
      kind: "note";
      text: string;
      /** Note is about the Jev sidecar — rendered pink with a `Jev` pill. */
      jev?: boolean;
    };

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
        block.card.jevGate = e.jevGate === true ? true : undefined;
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
    case "info":
      // Generic info stays activity noise — but Jev notes (effort routing,
      // sidecar fallback) are exactly what the user wants to see in pink.
      if (e.jev === true) {
        assistantTurn().blocks.push({ kind: "note", text: e.message, jev: true });
      }
      break;
    default:
      // step_started: activity noise, not chat content
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

/**
 * Storage trim: NO screenshot bytes are persisted — neither in the LLM
 * transcript nor on display cards. The panel shows captures live from the
 * event stream while a run is active; embedding them in the stored thread
 * grew the conversation store into tens of megabytes that every flush had to
 * re-serialize, which is what OOM-crash-looped the extension process under
 * load. Historical threads keep the tool cards, minus the image payload.
 */
export function forStorage(conv: Conversation): Conversation {
  return {
    ...conv,
    turns: conv.turns.map((t) => ({
      ...t,
      blocks: t.blocks.map((b) =>
        b.kind === "tool" && b.card.image !== undefined
          ? { kind: "tool" as const, card: { ...b.card, image: undefined } }
          : b,
      ),
    })),
    llm: conv.llm.map((m) => ({ ...m, images: undefined })),
  };
}

/**
 * In-place RAM trim: keep only the newest `keep` card screenshots in a folded
 * conversation and drop the older base64 payloads. Both live consumers (the
 * worker's persistence copy and the panel's display copy) fold every capture
 * into card state; without this a vision-heavy run grows the conversation —
 * and in the panel the decoded <img> bitmaps, several MB each — without bound
 * until the extension process is killed.
 */
export function trimCardImages(conv: Conversation, keep = 4): void {
  let seen = 0;
  for (let ti = conv.turns.length - 1; ti >= 0; ti--) {
    const blocks = conv.turns[ti]!.blocks;
    for (let bi = blocks.length - 1; bi >= 0; bi--) {
      const b = blocks[bi]!;
      if (b.kind !== "tool" || b.card.image === undefined) continue;
      seen += 1;
      if (seen > keep) b.card.image = undefined;
    }
  }
}
