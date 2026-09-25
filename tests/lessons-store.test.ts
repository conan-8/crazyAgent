// Lesson persistence in chrome.storage.local (per-profile ring).
import { beforeEach, describe, expect, it } from "vitest";
import {
  addLessons,
  clearLessons,
  deleteLesson,
  listLessons,
  markLessonsUsed,
  saveLessons,
  updateLesson,
} from "../extension/src/background/lessons";
import { LESSONS_KEY, LESSONS_MAX, newLesson } from "../extension/src/shared/lessons";

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

function learned(text: string, at: number, host?: string) {
  return newLesson(
    { category: host ? "site" : "tool", text, host },
    { task: `${text} run`, source: "auto", outcome: "done", at },
  );
}

describe("lesson persistence", () => {
  it("returns an empty list before anything is saved", async () => {
    expect(await listLessons()).toEqual([]);
  });

  it("stores lessons under the lessons key, newest first", async () => {
    await addLessons([learned("older lesson here", 100)]);
    await addLessons([learned("newer lesson here", 200)]);
    expect(store.has(LESSONS_KEY)).toBe(true);
    expect((await listLessons()).map((l) => l.text)).toEqual([
      "newer lesson here",
      "older lesson here",
    ]);
  });

  it("dedupes by wording and reports what happened", async () => {
    await saveLessons([learned("Always re-snapshot after a stale ref", 100)]);
    const result = await addLessons([learned("always re-snapshot after a stale ref!", 200)]);
    expect(result).toEqual({ added: 0, merged: 1, total: 1 });
    expect((await listLessons())[0]!.hits).toBe(2);
  });

  it("caps the ring at LESSONS_MAX", async () => {
    await saveLessons(
      Array.from({ length: LESSONS_MAX }, (_, i) => learned(`lesson ${i} text`, 1_000 + i)),
    );
    await addLessons([learned("the newest lesson text", 99_999)]);
    const all = await listLessons();
    expect(all).toHaveLength(LESSONS_MAX);
    expect(all[0]!.text).toBe("the newest lesson text");
  });

  it("edits text and pin state, and refuses an unknown id", async () => {
    await addLessons([learned("original wording here", 100)]);
    const id = (await listLessons())[0]!.id;
    const updated = await updateLesson(id, { text: "  my own wording  ", pinned: true });
    expect(updated).toMatchObject({ text: "my own wording", pinned: true });
    const unpinned = await updateLesson(id, { pinned: false });
    expect(unpinned!.pinned).toBeUndefined();
    expect(await updateLesson("nope", { text: "x" })).toBeNull();
  });

  it("survives a round-trip through storage (edits are re-read, not cached)", async () => {
    await addLessons([learned("durable lesson text", 100)]);
    const id = (await listLessons())[0]!.id;
    await updateLesson(id, { text: "edited durable lesson" });
    expect((await listLessons())[0]!.text).toBe("edited durable lesson");
  });

  it("deletes one lesson and clears all", async () => {
    await addLessons([learned("first lesson text", 100), learned("second lesson text", 200)]);
    const [newest] = await listLessons();
    await deleteLesson(newest!.id);
    expect((await listLessons()).map((l) => l.text)).toEqual(["first lesson text"]);
    await clearLessons();
    expect(await listLessons()).toEqual([]);
  });

  it("stamps the lessons a run carried in its prompt", async () => {
    await addLessons([learned("used lesson text", 100), learned("other lesson text", 200)]);
    const [used, other] = await listLessons();
    await markLessonsUsed([used!.id], 5_000);
    const after = await listLessons();
    expect(after.find((l) => l.id === used!.id)!.lastUsedAt).toBe(5_000);
    expect(after.find((l) => l.id === other!.id)!.lastUsedAt).toBeUndefined();
  });

  it("tolerates a corrupted store value", async () => {
    store.set(LESSONS_KEY, "not an array");
    expect(await listLessons()).toEqual([]);
  });
});