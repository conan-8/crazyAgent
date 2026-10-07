// The `todo_write` tool: the agent's live, user-visible plan. Whole-list
// replacement — every call sends the COMPLETE current list (add, remove,
// reorder, re-status all happen by sending the new list), which keeps the
// wire event, the checkpoint and the panel dropdown trivially consistent.
// Pure state: never touches the page, so it is PARALLEL_SAFE (registered in
// the loop's set) and needs no confirmation gate.
import { failureTag } from "../../shared/tool-failure";
import type { TodoItem, TodoStatus } from "../../shared/protocol";
import { registerTool, type ToolContext } from "./types";

/** Hard caps: the dropdown is a glanceable strip, not a document. */
export const TODO_MAX_ITEMS = 40;
export const TODO_MAX_CONTENT_CHARS = 160;

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "blocked"];


/**
 * Validate and normalise one whole-list write. Pure so tests (and the tool)
 * share one definition of a well-formed list.
 */
export function normalizeTodos(
  raw: unknown,
): { items?: TodoItem[]; error?: string } {
  if (!Array.isArray(raw)) {
    return { error: `${failureTag("input")}: todos must be an array of {content, status}` };
  }
  if (raw.length > TODO_MAX_ITEMS) {
    return {
      error: `${failureTag("input")}: too many todos (${raw.length}) — the cap is ${TODO_MAX_ITEMS}; consolidate`,
    };
  }
  const items: TodoItem[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") {
      return { error: `${failureTag("input")}: todos[${i}] must be an object` };
    }
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== "string" || !content.trim()) {
      return { error: `${failureTag("input")}: todos[${i}].content must be a non-empty string` };
    }
    if (typeof status !== "string" || !STATUSES.includes(status as TodoStatus)) {
      return {
        error: `${failureTag("input")}: todos[${i}].status must be one of: ${STATUSES.join(", ")}`,
      };
    }
    items.push({
      content: content.trim().slice(0, TODO_MAX_CONTENT_CHARS),
      status: status as TodoStatus,
    });
  }
  return { items };
}

/** One-line summary of a list — the model-facing result of a write. */
export function summarizeTodos(items: TodoItem[]): string {
  if (!items.length) return "todo list cleared";
  const done = items.filter((t) => t.status === "completed").length;
  const blocked = items.filter((t) => t.status === "blocked").length;
  const active = items.find((t) => t.status === "in_progress");
  const parts = [`${done}/${items.length} done`];
  if (blocked) parts.push(`${blocked} blocked`);
  if (active) parts.push(`now: ${active.content}`);
  return `todos updated (${parts.join(", ")})`;
}

registerTool({
  name: "todo_write",
  description:
    "Update your live task list, shown to the user as a plan dropdown at the top of the panel WHILE the run is in progress. Sends the COMPLETE list every call (whole-list replacement): to add, remove, reorder or re-status an item, send the full new list of {content, status} with status one of pending | in_progress | completed | blocked. Use it for any multi-step task: write the plan first, keep exactly ONE item in_progress (the work the user sees you doing right now), mark items completed the moment they are done, and rewrite the list mid-run when the plan changes. Mark an item blocked (and put the one-line reason in its content) only when it is genuinely impossible after real attempts — an item left pending is NOT an acceptable way to end a run. Keep each item a short imperative line (<= ~60 chars). Not for trivial single-step tasks, and never two updates in a row without real work between them.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description:
          "The COMPLETE new list. Each entry: {content: string (short imperative line), status: 'pending' | 'in_progress' | 'completed' | 'blocked'}.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "What the task is — a short imperative line" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "blocked"],
              description:
                "pending (not started) | in_progress (being worked on now) | completed (done) | blocked (impossible after real attempts — say why in the content)",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async run(args, ctx: ToolContext) {
    const { items, error } = normalizeTodos(args.todos);
    if (error || !items) return { ok: false, error };
    // The panel dropdown, the checkpoint and the run log all fold this event.
    ctx.emit({ kind: "todo_update", items });
    return { ok: true, summary: summarizeTodos(items) };
  },
  present(payload) {
    // The model just sent the list — echo only the one-line confirmation, not
    // the items (they would double the call's history footprint for nothing).
    const p = (payload ?? {}) as { ok?: boolean; summary?: string; error?: string };
    if (p.ok === false) return { text: p.error ?? "todo_write failed" };
    return { text: p.summary ?? "todos updated" };
  },
});

/** Cap on one progress note — a couple of sentences, not a report. */
export const PROGRESS_NOTE_MAX_CHARS = 400;

/**
 * Validate/normalize one progress note. Pure so tests and the tool share one
 * definition: non-empty, capped, whitespace-collapsed at the edges.
 */
export function normalizeProgressNote(raw: unknown): { text?: string; error?: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      error: `${failureTag("input")}: progress_note needs a non-empty text string — one or two sentences: what just landed, what comes next`,
    };
  }
  const text = raw.trim().slice(0, PROGRESS_NOTE_MAX_CHARS);
  return { text };
}

registerTool({
  name: "progress_note",
  description:
    "Report progress to the user in ONE or two sentences — rendered as a distinct bubble in the panel (the run's narration channel). Send one when a logical sequence or todo item COMPLETES: 'Progress: <what just landed, with its key results>. Next: <what you are doing now>.' This REPLACES prose narration between actions — batch the work (input_sequence / menu_path / docs_op / multi-call steps), then note; never note twice in a row without real work between, and never for trivial single steps.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "One or two sentences: 'Progress: title and intro are in with formatting. Next: the table, then the image.' (≤400 chars)",
      },
    },
    required: ["text"],
  },
  async run(args, ctx: ToolContext) {
    const { text, error } = normalizeProgressNote(args.text);
    if (error || text === undefined) return { ok: false, error };
    // The panel bubble, the chat transcript and the run log all fold this
    // event; nothing touches the page.
    ctx.emit({ kind: "progress_note", text });
    return { ok: true, noted: text };
  },
  present(payload) {
    // Echo nothing beyond the confirmation: the note text already rides the
    // event to the panel, and the tool result stays small in history.
    const p = (payload ?? {}) as { ok?: boolean; error?: string };
    if (p.ok === false) return { text: p.error ?? "progress_note failed" };
    return { text: "progress noted" };
  },
});
