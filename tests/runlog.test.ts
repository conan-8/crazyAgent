// Persistence layer for the run log (chrome.storage.local ring).
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRecords,
  deleteRecord,
  getRecord,
  listRecords,
  listSummaries,
  saveRecord,
} from "../extension/src/background/runlog";
import {
  LOG_KEY,
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
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
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

  it("round-trips a record under the log key", async () => {
    const rec = record("first", 100);
    await saveRecord(rec);
    expect(store.has(LOG_KEY)).toBe(true);
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

  it("caps the stored ring", async () => {
    for (let i = 0; i < LOG_MAX_RUNS + 3; i += 1) await saveRecord(record(`t${i}`, i));
    expect(await listRecords()).toHaveLength(LOG_MAX_RUNS);
  });

  it("summarizes stored records for the list view", async () => {
    await saveRecord(record("summarize me", 100));
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
  });

  it("returns null for an unknown id", async () => {
    expect(await getRecord("nope")).toBeNull();
  });
});