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
});
