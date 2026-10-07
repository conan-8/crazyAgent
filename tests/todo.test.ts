// The live plan: `todo_write` validation, the emitted `todo_update` event,
// the run-log fold and the prompt rule that makes the model use it.
import { describe, expect, it } from "vitest";
import {
  PROGRESS_NOTE_MAX_CHARS,
  TODO_MAX_CONTENT_CHARS,
  TODO_MAX_ITEMS,
  normalizeProgressNote,
  normalizeTodos,
  summarizeTodos,
} from "../extension/src/background/tools/todo";
import { openTodos } from "../extension/src/shared/protocol";
import { toolRegistry } from "../extension/src/background/tools/types";
import "../extension/src/background/tools/todo"; // registers todo_write
import { foldLogEvent, newTurnRecord, toMarkdown } from "../extension/src/shared/logging";
import { buildSystemPrompt } from "../extension/src/background/agent/prompts";
import type { StepEvent, TodoItem } from "../extension/src/shared/protocol";
import type { ToolContext } from "../extension/src/background/tools/types";

/** Minimal ToolContext: todo_write never touches the page. */
function stubContext(): { ctx: ToolContext; events: StepEvent[] } {
  const events: StepEvent[] = [];
  const ctx = {
    tabId: 1,
    adapter: {} as ToolContext["adapter"],
    emit: (e: StepEvent) => events.push(e),
  };
  return { ctx, events };
}

describe("normalizeTodos", () => {
  it("accepts a well-formed whole list", () => {
    const { items, error } = normalizeTodos([
      { content: "Open the form", status: "completed" },
      { content: "Fill the fields", status: "in_progress" },
      { content: "Submit", status: "pending" },
    ]);
    expect(error).toBeUndefined();
    expect(items).toEqual([
      { content: "Open the form", status: "completed" },
      { content: "Fill the fields", status: "in_progress" },
      { content: "Submit", status: "pending" },
    ]);
  });

  it("accepts an empty list (the plan was cleared)", () => {
    expect(normalizeTodos([]).items).toEqual([]);
  });

  it("trims and caps item content", () => {
    const long = "x".repeat(TODO_MAX_CONTENT_CHARS + 50);
    const { items } = normalizeTodos([{ content: `  ${long}  `, status: "pending" }]);
    expect(items?.[0]?.content).toHaveLength(TODO_MAX_CONTENT_CHARS);
  });

  it("rejects non-arrays, bad statuses and blank content", () => {
    expect(normalizeTodos("nope").error).toContain("INPUT-FAILED");
    expect(normalizeTodos([{ content: "a", status: "done" }]).error).toContain("status");
    expect(normalizeTodos([{ content: "  ", status: "pending" }]).error).toContain("content");
    expect(normalizeTodos([null]).error).toContain("object");
  });

  it("caps the list length", () => {
    const many = Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => ({
      content: `step ${i}`,
      status: "pending" as const,
    }));
    expect(normalizeTodos(many).error).toContain(String(TODO_MAX_ITEMS));
    expect(normalizeTodos(many.slice(0, TODO_MAX_ITEMS)).error).toBeUndefined();
  });

  it("accepts 'blocked' and reports it in the summary", () => {
    // The failure ladder has always told the model to mark an item blocked;
    // until now there was no such status, so an honest stop was impossible.
    const { items, error } = normalizeTodos([
      { content: "Insert the image (host blocks uploads)", status: "blocked" },
      { content: "Write the title", status: "completed" },
      { content: "Add the table", status: "pending" },
    ]);
    expect(error).toBeUndefined();
    expect(items!.map((t) => t.status)).toEqual(["blocked", "completed", "pending"]);
    const summary = summarizeTodos(items!);
    expect(summary).toContain("1/3 done");
    expect(summary).toContain("1 blocked");
    // A blocked item is a decision, not a debt: it does not hold the run open.
    expect(openTodos(items!)).toHaveLength(1);
    expect(openTodos(items!)[0]!.content).toBe("Add the table");
  });
});

describe("summarizeTodos", () => {
  it("reports progress and the item in flight", () => {
    const items: TodoItem[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
      { content: "c", status: "in_progress" },
      { content: "d", status: "pending" },
    ];
    expect(summarizeTodos(items)).toBe("todos updated (2/4 done, now: c)");
  });

  it("handles empty and no-active lists", () => {
    expect(summarizeTodos([])).toBe("todo list cleared");
    expect(summarizeTodos([{ content: "a", status: "pending" }])).toBe(
      "todos updated (0/1 done)",
    );
  });
});

describe("todo_write tool", () => {
  it("is registered and not sensitive (no confirmation gate)", () => {
    const tool = toolRegistry.get("todo_write");
    expect(tool).toBeDefined();
    expect(tool?.sensitive).toBeFalsy();
  });

  it("emits a whole-list todo_update event and returns a one-line summary", async () => {
    const tool = toolRegistry.get("todo_write")!;
    const { ctx, events } = stubContext();
    const payload = (await tool.run(
      {
        todos: [
          { content: "Find the site", status: "completed" },
          { content: "Log in", status: "in_progress" },
        ],
      },
      ctx,
    )) as { ok: boolean; summary: string };
    expect(payload.ok).toBe(true);
    expect(payload.summary).toBe("todos updated (1/2 done, now: Log in)");
    expect(events).toEqual([
      {
        kind: "todo_update",
        items: [
          { content: "Find the site", status: "completed" },
          { content: "Log in", status: "in_progress" },
        ],
      },
    ]);
  });

  it("rejects a malformed list without emitting", async () => {
    const tool = toolRegistry.get("todo_write")!;
    const { ctx, events } = stubContext();
    const payload = (await tool.run(
      { todos: [{ content: "x", status: "finished" }] },
      ctx,
    )) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("INPUT-FAILED");
    expect(events).toHaveLength(0);
  });

  it("presents a compact model-facing result (never the echoed list)", () => {
    const tool = toolRegistry.get("todo_write")!;
    const text = tool.present?.({ ok: true, summary: "todos updated (1/2 done)" })?.text;
    expect(text).toBe("todos updated (1/2 done)");
  });
});

describe("run log fold", () => {
  it("keeps the latest plan snapshot (last write wins) and exports it", () => {
    const rec = newTurnRecord("task", { mode: "standard", at: 1_000 });
    foldLogEvent(
      rec,
      { kind: "todo_update", items: [{ content: "a", status: "in_progress" }] },
      1_100,
    );
    foldLogEvent(
      rec,
      {
        kind: "todo_update",
        items: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
        ],
      },
      1_200,
    );
    expect(rec.todos).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ]);
    const md = toMarkdown([rec]);
    expect(md).toContain("**Plan (final state):**");
    expect(md).toContain("- [x] a");
    expect(md).toContain("- [ ] b");
  });

  it("renders the in-progress mark in the export", () => {
    const rec = newTurnRecord("task", { mode: "standard", at: 1_000 });
    foldLogEvent(
      rec,
      { kind: "todo_update", items: [{ content: "now", status: "in_progress" }] },
      1_100,
    );
    expect(toMarkdown([rec])).toContain("- [~] now");
  });
});

describe("system prompt", () => {
  it("teaches the model the visible-plan contract", () => {
    const p = buildSystemPrompt("Do a multi-step thing");
    expect(p).toContain("Visible plan (`todo_write`)");
    expect(p).toContain("exactly ONE item `in_progress`");
    expect(p).toContain("whole list");
  });

  it("teaches the progress-note contract: batch the work, then report", () => {
    const p = buildSystemPrompt("Do a multi-step thing");
    expect(p).toContain("Progress reports (`progress_note`)");
    expect(p).toContain("Progress: <what just landed");
    expect(p).toContain("never two notes in a row without real work between");
  });
});

describe("normalizeProgressNote", () => {
  it("trims and caps the note", () => {
    const long = "x".repeat(PROGRESS_NOTE_MAX_CHARS + 100);
    const { text } = normalizeProgressNote(`  ${long}  `);
    expect(text?.length).toBe(PROGRESS_NOTE_MAX_CHARS);
  });

  it("rejects empty and non-string notes with tool-error text", () => {
    expect(normalizeProgressNote("").error).toContain("INPUT-FAILED");
    expect(normalizeProgressNote("   ").error).toContain("INPUT-FAILED");
    expect(normalizeProgressNote(42).error).toContain("INPUT-FAILED");
  });
});

describe("progress_note tool", () => {
  it("is registered and not sensitive (pure narration, no gate)", () => {
    const tool = toolRegistry.get("progress_note");
    expect(tool).toBeDefined();
    expect(tool?.sensitive).toBeFalsy();
  });

  it("emits the progress_note event and confirms compactly", async () => {
    const tool = toolRegistry.get("progress_note")!;
    const { ctx, events } = stubContext();
    const note = "Progress: title and intro are in. Next: the table.";
    const payload = (await tool.run({ text: note }, ctx)) as { ok: boolean; noted: string };
    expect(payload.ok).toBe(true);
    expect(payload.noted).toBe(note);
    expect(events).toEqual([{ kind: "progress_note", text: note }]);
    // The model-facing result stays small — the text rides the event, not history.
    expect(tool.present?.({ ok: true, noted: note })?.text).toBe("progress noted");
  });

  it("rejects an empty note without emitting", async () => {
    const tool = toolRegistry.get("progress_note")!;
    const { ctx, events } = stubContext();
    const payload = (await tool.run({ text: "  " }, ctx)) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("INPUT-FAILED");
    expect(events).toHaveLength(0);
  });
});

describe("progress notes in the run log", () => {
  it("folds into the turn's notes, flagged, and renders in the export", () => {
    const rec = newTurnRecord("task", { mode: "standard", at: 1_000 });
    foldLogEvent(
      rec,
      { kind: "progress_note", text: "Progress: title is in. Next: the table." },
      1_100,
    );
    expect(rec.turns[0]?.notes).toEqual([
      { at: 1_100, message: "Progress: title is in. Next: the table.", progress: true },
    ]);
    const md = toMarkdown([rec]);
    expect(md).toContain("📣 **Progress**");
    expect(md).toContain("Next: the table.");
  });
});
