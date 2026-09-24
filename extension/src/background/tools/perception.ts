// Perception tools: snapshot (per-frame element collection), screenshot,
// and wait_for_settle.
import type { ElementInfo, FrameSnapshot } from "../../content/registry";
import { registerTool } from "./types";

interface AggregatedSnapshot {
  frames: { frameId: number; href: string; title: string }[];
  elements: (ElementInfo & { ref: string; frameId: number })[];
  text: string;
}

registerTool({
  name: "snapshot",
  description:
    "Capture the current page as a numbered list of interactive elements (clickable, typable) plus a digest of visible text. Elements are listed once per frame (cross-origin frames included, refs look like 'frameId#n'). Act on elements by ref with the action tools.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx): Promise<AggregatedSnapshot> {
    const results = await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId, allFrames: true },
      func: () => {
        const g = globalThis as {
          __baRegistry?: { collect(): unknown };
        };
        return g.__baRegistry
          ? g.__baRegistry.collect()
          : { error: "registry-not-loaded" };
      },
    });
    const frames: AggregatedSnapshot["frames"] = [];
    const elements: AggregatedSnapshot["elements"] = [];
    let text = "";
    for (const result of results) {
      const frameId = result.frameId ?? 0;
      const snap = result.result as FrameSnapshot | { error: string } | null;
      if (!snap || "error" in snap) continue;
      frames.push({ frameId, href: snap.href, title: snap.title });
      if (frameId === 0) text = snap.text;
      for (const el of snap.elements) {
        elements.push({ ...el, ref: `${frameId}#${el.ref}`, frameId });
      }
    }
    return { frames, elements, text };
  },
  present(payload) {
    const snap = payload as AggregatedSnapshot;
    const lines = snap.elements.map((e) => {
      const bits = [
        e.ref,
        e.tag + (e.type ? `[${e.type}]` : ""),
        `"${e.name}"`,
      ];
      if (e.disabled) bits.push("disabled");
      if (e.editable) bits.push("editable");
      if (e.value && e.tag !== "button") bits.push(`value="${e.value.slice(0, 40)}"`);
      return bits.join(" ");
    });
    return {
      text: `URL: ${snap.frames[0]?.href ?? ""}\nVisible text: ${snap.text}\nInteractive elements (ref tag "name"):\n${lines.join("\n")}`,
    };
  },
});

registerTool({
  name: "screenshot",
  description:
    "Capture a JPEG screenshot of the visible viewport as a data URL. Use for visual understanding (multimodal models) or after actions to verify effects.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    return ctx.adapter.screenshot(ctx.tabId);
  },
  present(payload) {
    return {
      text: "[screenshot captured]",
      image: (payload as { dataUrl: string }).dataUrl,
    };
  },
});

registerTool({
  name: "wait_for_settle",
  description:
    "Wait until the page settles (no DOM mutations or network fetches for ~500ms) or the timeout elapses. Call after navigation or actions that trigger async updates.",
  parameters: {
    type: "object",
    properties: {
      timeoutMs: {
        type: "number",
        description: "Hard timeout in milliseconds (default 15000)",
      },
    },
  },
  async run(args, ctx) {
    const timeoutMs =
      typeof args.timeoutMs === "number" ? args.timeoutMs : 15_000;
    // Retry across page transitions: right after navigate the new content
    // script may not be injected yet ("receiving end does not exist").
    let lastError = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await chrome.tabs.sendMessage(
          ctx.tabId,
          { type: "ba/settle", timeoutMs },
          { frameId: 0 },
        );
      } catch (err) {
        lastError = String((err as Error)?.message ?? err);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`wait_for_settle could not reach the page: ${lastError}`);
  },
});
