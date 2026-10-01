// Persistence layer for the run log (per-record keys + summary index in
// chrome.storage.local — the old single-array store rewrote the whole archive
// on every flush and OOM-crash-looped the extension under load).
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRecords,
  deleteRecord,
  findOpenRecord,
  getRecord,
  listRecords,
  listSummaries,
  saveRecord,
} from "../extension/src/background/runlog";
import {
  LOG_MAX_RUNS,
  foldLogEvent,
  newTurnRecord,
} from "../extension/src/shared/logging";

const store = new Map<string, unknown>();

beforeEach(() => {
  store.clear();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (store.has(k)) out[k] = store.get(k);
          }
          return out;
        },
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        },
      },
    },
  };
});

function record(task: string, at: number) {
  const rec = newTurnRecord(task, { conversationId: "c1", at });
  foldLogEvent(rec, { kind: "tool_call", stepIndex: 0, name: "click", args: {} }, at + 1);
  foldLogEvent(rec, { kind: "done", summary: "ok" }, at + 2);
  return rec;
}

describe("runlog persistence", () => {
  it("returns an empty list before anything is saved", async () => {
    expect(await listRecords()).toEqual([]);
  });

  it("stores each record under its own key plus an index entry", async () => {
    const rec = record("first", 100);
    await saveRecord(rec);
    expect(store.has(`baLog:${rec.id}`)).toBe(true);
    const index = store.get("baLogIndex") as { id: string }[];
    expect(index.map((s) => s.id)).toEqual([rec.id]);
    expect(await getRecord(rec.id)).toMatchObject({ task: "first", status: "done" });
  });

  it("lists records newest-first", async () => {
    await saveRecord(record("older", 100));
    await saveRecord(record("newer", 200));
    expect((await listRecords()).map((r) => r.task)).toEqual(["newer", "older"]);
  });

  it("updates a record in place rather than duplicating it", async () => {
    const rec = record("task", 100);
    await saveRecord(rec);
    foldLogEvent(rec, { kind: "tool_call", stepIndex: 1, name: "type", args: {} }, 150);
    await saveRecord(rec);
    const all = await listRecords();
    expect(all).toHaveLength(1);
    expect(all[0]!.toolCalls).toBe(2);
  });

  it("caps the stored ring and evicts the oldest record's key", async () => {
    let firstId = "";
    for (let i = 0; i < LOG_MAX_RUNS + 3; i += 1) {
      const rec = record(`t${i}`, i);
      if (i === 0) firstId = rec.id;
      await saveRecord(rec);
    }
    const all = await listRecords();
    expect(all).toHaveLength(LOG_MAX_RUNS);
    // Evicted records must not linger as orphan keys (that was the bloat).
    expect(store.has(`baLog:${firstId}`)).toBe(false);
  });

  it("summarizes stored records for the list view without loading them", async () => {
    const rec = record("summarize me", 100);
    await saveRecord(rec);
    store.delete(`baLog:${rec.id}`); // summaries must come from the index alone
    const summaries = await listSummaries();
    expect(summaries[0]).toMatchObject({ task: "summarize me", turns: 1, toolCalls: 1 });
  });

  it("deletes one record and clears the rest", async () => {
    const a = record("a", 100);
    const b = record("b", 200);
    await saveRecord(a);
    await saveRecord(b);
    await deleteRecord(a.id);
    expect(await getRecord(a.id)).toBeNull();
    expect(await listRecords()).toHaveLength(1);
    await clearRecords();
    expect(await listRecords()).toEqual([]);
    expect(store.has(`baLog:${b.id}`)).toBe(false);
  });

  it("returns null for an unknown id", async () => {
    expect(await getRecord("nope")).toBeNull();
  });

  it("finds the still-open record for a conversation via the index", async () => {
    const open = newTurnRecord("running task", { conversationId: "c9", at: 100 });
    await saveRecord(open);
    await saveRecord(record("finished", 200));
    const found = await findOpenRecord("c9");
    expect(found?.id).toBe(open.id);
    // Once it closes, it is no longer resumable.
    foldLogEvent(open, { kind: "done", summary: "ok" }, 300);
    await saveRecord(open);
    expect(await findOpenRecord("c9")).toBeNull();
    expect(await findOpenRecord(undefined)).toBeNull();
  });
});
