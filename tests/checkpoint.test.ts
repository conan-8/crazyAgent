import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
} from "../extension/src/background/checkpoint";
import type { Checkpoint } from "../extension/src/shared/protocol";

const store = new Map<string, unknown>();

beforeEach(() => {
  store.clear();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: async (key: string) =>
          store.has(key) ? { [key]: store.get(key) } : {},
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        remove: async (key: string) => {
          store.delete(key);
        },
      },
    },
  };
});

const cp: Checkpoint = {
  task: "demo",
  mode: "standard",
  demo: { steps: 3, intervalMs: 10 },
  stepIndex: 2,
  messages: [{ role: "user", content: "demo" }],
  startedAt: 1,
  updatedAt: 2,
  done: false,
};

describe("checkpoint", () => {
  it("round-trips a checkpoint", async () => {
    await saveCheckpoint(cp);
    expect(await loadCheckpoint()).toEqual(cp);
  });

  it("returns null when nothing is stored", async () => {
    expect(await loadCheckpoint()).toBeNull();
  });

  it("clears the stored checkpoint", async () => {
    await saveCheckpoint(cp);
    await clearCheckpoint();
    expect(await loadCheckpoint()).toBeNull();
  });

  it("overwrites an older checkpoint on save", async () => {
    await saveCheckpoint(cp);
    await saveCheckpoint({ ...cp, stepIndex: 5 });
    expect((await loadCheckpoint())?.stepIndex).toBe(5);
  });

  it("strips old screenshot bytes on save and keeps the newest", async () => {
    // A checkpoint saves every step; keeping every past capture made each save
    // heavier than the whole task. Only the newest few images are ever sent.
    const withImages: Checkpoint = {
      ...cp,
      messages: [
        { role: "user", content: "task" },
        ...Array.from({ length: 6 }, (_, i) => ({
          role: "tool" as const,
          toolCallId: `t${i}`,
          content: "shot",
          images: [`data:image/jpeg;base64,IMG${i}`],
        })),
      ],
    };
    await saveCheckpoint(withImages);
    const kept = ((await loadCheckpoint())?.messages ?? []).filter((m) => m.images?.length);
    expect(kept.length).toBe(4);
    // the newest survive; the live object keeps everything
    expect(kept.at(-1)?.images?.[0]).toContain("IMG5");
    expect(withImages.messages.filter((m) => m.images?.length).length).toBe(6);
  });
});
