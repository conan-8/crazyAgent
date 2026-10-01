// Persistence layer for chat conversations (per-conversation keys + summary
// index). The old single-array store re-serialized every stored thread —
// screenshots included — on every flush; these tests pin the new layout so
// the OOM regression cannot come back quietly.
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteConversation,
  getConversation,
  listConversationSummaries,
  saveConversation,
} from "../extension/src/background/conversations";
import { foldUser, forStorage, newConversation } from "../extension/src/shared/chat";

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

function conv(id: string, task: string, updatedAt: number) {
  const c = newConversation(id, task);
  foldUser(c, task);
  c.updatedAt = updatedAt;
  return c;
}

describe("conversation persistence", () => {
  it("round-trips a conversation under its own key", async () => {
    const c = conv("c1", "first thread", 100);
    await saveConversation(c);
    expect(store.has("baConv:c1")).toBe(true);
    expect(await getConversation("c1")).toMatchObject({ id: "c1", title: "first thread" });
    expect(await getConversation("nope")).toBeNull();
  });

  it("lists summaries newest-first from the index alone", async () => {
    const a = conv("a", "older", 100);
    const b = conv("b", "newer", 200);
    await saveConversation(a);
    await saveConversation(b);
    // Summaries must not require loading the stored threads.
    store.delete("baConv:a");
    store.delete("baConv:b");
    const list = await listConversationSummaries();
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    expect(list[0]).toMatchObject({ title: "newer", turns: 1 });
  });

  it("updates a conversation in place without duplicating it", async () => {
    const c = conv("c2", "thread", 100);
    await saveConversation(c);
    c.updatedAt = 300;
    foldUser(c, "follow-up");
    await saveConversation(c);
    const list = await listConversationSummaries();
    expect(list).toHaveLength(1);
    expect(list[0]!.turns).toBe(2);
    expect((await getConversation("c2"))?.turns).toHaveLength(2);
  });

  it("caps the archive and evicts the oldest thread's key", async () => {
    for (let i = 0; i < 51; i += 1) {
      await saveConversation(conv(`c${i}`, `thread ${i}`, i));
    }
    const list = await listConversationSummaries();
    expect(list).toHaveLength(50);
    expect(list.some((s) => s.id === "c0")).toBe(false);
    expect(store.has("baConv:c0")).toBe(false); // no orphan key left behind
    expect(await getConversation("c50")).not.toBeNull();
  });

  it("deletes a conversation and its index entry", async () => {
    await saveConversation(conv("d1", "doomed", 100));
    await deleteConversation("d1");
    expect(await getConversation("d1")).toBeNull();
    expect(await listConversationSummaries()).toEqual([]);
  });

  it("persists threads without screenshot bytes", async () => {
    const c = conv("img1", "vision run", 100);
    c.llm.push({ role: "tool", content: "x", images: ["data:image/jpeg;base64,BIG"] });
    await saveConversation(forStorage(c));
    const raw = JSON.stringify(store.get("baConv:img1"));
    expect(raw).not.toContain("base64,BIG");
  });
});
