// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  foldEvent,
  foldUser,
  forStorage,
  newConversation,
  summarize,
  type ChatBlock,
} from "../extension/src/shared/chat";

const texts = (blocks: ChatBlock[]): string[] =>
  blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text);

describe("conversation folding", () => {
  it("folds a run into ordered blocks: narration, tools, answer last", () => {
    const conv = newConversation("c1", "Summarize the docs page");
    foldUser(conv, "Summarize the docs page");
    foldEvent(conv, { kind: "token_delta", text: "Looking " });
    foldEvent(conv, { kind: "token_delta", text: "around." });
    foldEvent(conv, { kind: "tool_call", stepIndex: 0, name: "navigate", args: { url: "x" } });
    foldEvent(conv, {
      kind: "tool_result",
      stepIndex: 0,
      name: "navigate",
      result: "ok",
      ok: true,
    });
    foldEvent(conv, { kind: "tool_call", stepIndex: 0, name: "screenshot", args: {} });
    foldEvent(conv, {
      kind: "tool_result",
      stepIndex: 0,
      name: "screenshot",
      result: "[screenshot captured]",
      ok: true,
      image: "data:image/jpeg;base64,AAA",
    });
    foldEvent(conv, { kind: "token_delta", text: "## Answer" });
    foldEvent(conv, { kind: "done", summary: "All done." });

    expect(conv.title).toBe("Summarize the docs page");
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[0]).toMatchObject({ role: "user", text: "Summarize the docs page" });

    const blocks = conv.turns[1]!.blocks;
    // arrival order preserved; the answer lands BELOW the tool activity
    expect(blocks.map((b) => b.kind)).toEqual(["text", "tool", "tool", "text"]);
    expect(texts(blocks)).toEqual(["Looking around.", "## Answer"]);
    const toolBlocks = blocks.filter((b) => b.kind === "tool") as Extract<
      ChatBlock,
      { kind: "tool" }
    >[];
    expect(toolBlocks[0]?.card).toMatchObject({ name: "navigate", filled: true, result: "ok" });
    expect(toolBlocks[1]?.card.image).toBe("data:image/jpeg;base64,AAA");
  });

  it("uses the done summary when no text streamed", () => {
    const conv = newConversation("c2", "t");
    foldUser(conv, "t");
    foldEvent(conv, { kind: "tool_call", stepIndex: 0, name: "snapshot", args: {} });
    foldEvent(conv, { kind: "tool_result", stepIndex: 0, name: "snapshot", result: "r", ok: true });
    foldEvent(conv, { kind: "done", summary: "stopped at step 2" });
    expect(texts(conv.turns[1]!.blocks)).toEqual(["stopped at step 2"]);
  });

  it("does not duplicate the streamed answer on done", () => {
    const conv = newConversation("c2b", "t");
    foldUser(conv, "t");
    foldEvent(conv, { kind: "token_delta", text: "final answer" });
    foldEvent(conv, { kind: "done", summary: "final answer" });
    expect(texts(conv.turns[1]!.blocks)).toEqual(["final answer"]);
  });

  it("folds confirmations into their own blocks", () => {
    const conv = newConversation("c3", "t");
    foldUser(conv, "t");
    foldEvent(conv, { kind: "need_confirm", id: "cf1", tool: "password", summary: "pw" });
    expect(conv.turns[1]?.blocks[0]).toMatchObject({
      kind: "confirm",
      confirm: { id: "cf1", tool: "password" },
    });
    foldEvent(conv, { kind: "error", message: "boom" });
    expect(texts(conv.turns[1]!.blocks)[0]).toContain("⚠ boom");
  });

  it("ignores activity noise (step_started/info)", () => {
    const conv = newConversation("c4", "t");
    foldUser(conv, "t");
    foldEvent(conv, { kind: "step_started", stepIndex: 0 });
    foldEvent(conv, { kind: "info", message: "resumed" });
    foldEvent(conv, { kind: "done", summary: "fin" });
    expect(conv.turns).toHaveLength(2);
  });

  it("separates same-named tool cards", () => {
    const conv = newConversation("c5", "t");
    foldUser(conv, "t");
    foldEvent(conv, { kind: "tool_call", stepIndex: 0, name: "click", args: { ref: "1" } });
    foldEvent(conv, { kind: "tool_call", stepIndex: 0, name: "click", args: { ref: "2" } });
    foldEvent(conv, { kind: "tool_result", stepIndex: 0, name: "click", result: "first", ok: true });
    foldEvent(conv, { kind: "tool_result", stepIndex: 0, name: "click", result: "second", ok: true });
    const cards = conv.turns[1]!.blocks.filter((b) => b.kind === "tool") as Extract<
      ChatBlock,
      { kind: "tool" }
    >[];
    // results fill FIFO: "first" answers the ref1 call, "second" the ref2 call
    expect(cards[0]?.card.result).toBe("first");
    expect(cards[1]?.card.result).toBe("second");
  });

  it("summarizes and strips images for storage", () => {
    const conv = newConversation("c6", "task title");
    foldUser(conv, "task title");
    conv.llm.push({ role: "tool", content: "x", images: ["data:image/jpeg;base64,BIG"] });
    const summary = summarize(conv);
    expect(summary).toMatchObject({ id: "c6", title: "task title", turns: 1 });
    const stored = forStorage(conv);
    expect(stored.llm[0]?.images).toBeUndefined();
    expect(conv.llm[0]?.images).toHaveLength(1); // original untouched
  });
});
