// One-time migration of the legacy single-array stores (`baRunLogs`,
// `baConversations`) into the per-record/per-conversation key layout. Both
// modules cache their migration promise per worker lifetime, so this lives in
// its own file: a fresh module registry sees the seeded legacy keys.
import { beforeEach, describe, expect, it } from "vitest";
import { listRecords, listSummaries } from "../extension/src/background/runlog";
import {
  getConversation,
  listConversationSummaries,
} from "../extension/src/background/conversations";
import { LOG_KEY, foldLogEvent, newTurnRecord } from "../extension/src/shared/logging";
import { foldUser, newConversation } from "../extension/src/shared/chat";

const store = new Map<string, unknown>();

const legacyRec = newTurnRecord("old run", { conversationId: "c1", at: 100 });
foldLogEvent(legacyRec, { kind: "done", summary: "ok" }, 101);
const legacyConv = newConversation("c1", "old thread");
foldUser(legacyConv, "old thread");

beforeEach(() => {
  store.clear();
  // Seed the pre-refactor layout before any store call triggers migration.
  store.set(LOG_KEY, [legacyRec]);
  store.set("baConversations", [legacyConv]);
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

describe("legacy store migration", () => {
  it("splits the legacy run-log array into per-record keys + index", async () => {
    const records = await listRecords();
    expect(records.map((r) => r.task)).toEqual(["old run"]);
    expect(store.has(`baLog:${legacyRec.id}`)).toBe(true);
    expect((await listSummaries()).map((s) => s.id)).toEqual([legacyRec.id]);
    // The legacy blob is gone — nothing re-reads the whole archive anymore.
    expect(store.has(LOG_KEY)).toBe(false);
  });

  it("splits the legacy conversation array into per-thread keys + index", async () => {
    const summaries = await listConversationSummaries();
    expect(summaries.map((s) => s.id)).toEqual(["c1"]);
    expect(await getConversation("c1")).toMatchObject({ title: "old thread" });
    expect(store.has("baConversations")).toBe(false);
  });
});
