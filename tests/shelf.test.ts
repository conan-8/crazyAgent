import { describe, expect, it } from "vitest";
import {
  emptyShelf,
  SHELF_CAP,
  SHELF_MAX_DATAURL_CHARS,
  shelfFind,
  shelfStage,
  shelfSummaries,
  type ShelfEntry,
} from "../extension/src/background/shelf";

function input(n: number, size = 64): Omit<ShelfEntry, "id"> {
  return {
    dataUrl: `data:image/jpeg;base64,${"A".repeat(size)}`,
    mime: "image/jpeg",
    name: `img-${n}.jpg`,
    sourceUrl: `https://example.com/${n}`,
    tabTitle: `tab ${n}`,
    tabId: n,
    at: 1_700_000_000_000 + n,
  };
}

describe("image shelf (pure core)", () => {
  it("stages with monotonic shot_N ids and keeps insertion order", () => {
    let s = emptyShelf();
    const a = shelfStage(s, input(1));
    expect(a.id).toBe("shot_1");
    s = a.state;
    const b = shelfStage(s, input(2));
    expect(b.id).toBe("shot_2");
    s = b.state;
    expect(s.entries.map((e) => e.id)).toEqual(["shot_1", "shot_2"]);
    expect(s.counter).toBe(2);
  });

  it("never mutates the input state", () => {
    const s = emptyShelf();
    shelfStage(s, input(1));
    expect(s.entries).toHaveLength(0);
    expect(s.counter).toBe(0);
  });

  it("evicts the oldest past the cap but keeps ids monotonic", () => {
    let s = emptyShelf();
    for (let i = 1; i <= SHELF_CAP + 3; i++) s = shelfStage(s, input(i)).state;
    expect(s.entries).toHaveLength(SHELF_CAP);
    expect(s.entries[0]!.id).toBe("shot_4");
    expect(s.entries.at(-1)!.id).toBe(`shot_${SHELF_CAP + 3}`);
    expect(s.counter).toBe(SHELF_CAP + 3);
  });

  it("rejects non-data-URLs and oversized captures without touching state", () => {
    const s = emptyShelf();
    const bad = shelfStage(s, { ...input(1), dataUrl: "https://example.com/x.jpg" });
    expect(bad.id).toBeUndefined();
    expect(bad.error).toMatch(/data URL/);
    const huge = shelfStage(s, {
      ...input(1),
      dataUrl: `data:image/jpeg;base64,${"A".repeat(SHELF_MAX_DATAURL_CHARS + 1)}`,
    });
    expect(huge.id).toBeUndefined();
    expect(huge.error).toMatch(/too large/);
    expect(s.entries).toHaveLength(0);
  });

  it("finds by exact id, by latest when omitted, and tolerates natural mis-guesses", () => {
    let s = emptyShelf();
    s = shelfStage(s, input(1)).state;
    s = shelfStage(s, input(2)).state;
    expect(shelfFind(s, "shot_1")?.name).toBe("img-1.jpg");
    expect(shelfFind(s)?.name).toBe("img-2.jpg"); // latest
    expect(shelfFind(s, "")?.name).toBe("img-2.jpg");
    expect(shelfFind(s, "SHOT_1")?.name).toBe("img-1.jpg");
    expect(shelfFind(s, "shot1")?.name).toBe("img-1.jpg");
    expect(shelfFind(s, "img_1")?.name).toBe("img-1.jpg");
    expect(shelfFind(s, "2")?.name).toBe("img-2.jpg");
    expect(shelfFind(s, "shot_99")).toBeUndefined();
    expect(shelfFind(emptyShelf())).toBeUndefined();
  });

  it("summaries carry identity but never bytes", () => {
    const s = shelfStage(emptyShelf(), input(7)).state;
    const sums = shelfSummaries(s);
    // id comes from the session counter, not the image's own index
    expect(sums[0]).toMatchObject({ id: "shot_1", name: "img-7.jpg", tabId: 7 });
    expect("dataUrl" in (sums[0] as Record<string, unknown>)).toBe(false);
  });
});
