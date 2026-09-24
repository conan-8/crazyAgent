// Perception tools: snapshot (per-frame element collection), screenshot,
// and wait_for_settle. The snapshot/settle primitives are exported so the
// agent runner can auto-attach a fresh observation after mutating actions.
import type { ElementInfo, FrameSnapshot } from "../../content/registry";
import { registerTool } from "./types";

export interface AggregatedSnapshot {
  frames: { frameId: number; href: string; title: string }[];
  elements: (ElementInfo & { ref: string; frameId: number })[];
  text: string;
}

/** Collect the per-frame element registry + text digest for a tab. */
export async function collectSnapshot(tabId: number): Promise<AggregatedSnapshot> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
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
}

/** Compact LLM-facing rendering of a snapshot. */
export function formatSnapshot(snap: AggregatedSnapshot): string {
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
  return `URL: ${snap.frames[0]?.href ?? ""}\nVisible text: ${snap.text}\nInteractive elements (ref tag "name"):\n${lines.join("\n")}`;
}

/**
 * Wait for the page to settle, retrying across navigations (right after a
 * navigate the new content script may not be injected yet — "receiving end
 * does not exist"). Shared by the tool and the auto-observation path.
 */
export async function settleTab(
  tabId: number,
  timeoutMs = 15_000,
  attempts = 20,
): Promise<unknown> {
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await chrome.tabs.sendMessage(
        tabId,
        { type: "ba/settle", timeoutMs },
        { frameId: 0 },
      );
    } catch (err) {
      lastError = String((err as Error)?.message ?? err);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`wait_for_settle could not reach the page: ${lastError}`);
}

/**
 * Downscale a JPEG data URL to at most `maxWidth` px wide (models downscale
 * larger images server-side anyway, so the extra pixels are pure upload
 * latency + token cost). Falls back to the original on any failure.
 */
export async function downscaleJpeg(
  dataUrl: string,
  maxWidth = 1_280,
  quality = 0.7,
): Promise<string> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    if (bmp.width <= maxWidth) {
      bmp.close();
      return dataUrl;
    }
    const scale = maxWidth / bmp.width;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let binary = "";
    const chunk = 0x8_000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch {
    return dataUrl; // never fail a screenshot over an optimization
  }
}

registerTool({
  name: "snapshot",
  description:
    "Capture the current page as a numbered list of interactive elements (clickable, typable) plus a digest of visible text. Elements are listed once per frame (cross-origin frames included, refs look like 'frameId#n'). Act on elements by ref with the action tools.",
  parameters: { type: "object", properties: {} },
  run: (_args, ctx) => collectSnapshot(ctx.tabId),
  present(payload) {
    return { text: formatSnapshot(payload as AggregatedSnapshot) };
  },
});

registerTool({
  name: "screenshot",
  description:
    "Capture a JPEG screenshot of the visible viewport as a data URL. Use for visual understanding (multimodal models) or after actions to verify effects.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    const { dataUrl } = await ctx.adapter.screenshot(ctx.tabId);
    return { dataUrl: await downscaleJpeg(dataUrl) };
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
    "Wait until the page settles (no DOM mutations or network fetches for ~500ms) or the timeout elapses. Action results already settle automatically — use this only to wait for longer async work.",
  parameters: {
    type: "object",
    properties: {
      timeoutMs: {
        type: "number",
        description: "Hard timeout in milliseconds (default 15000)",
      },
    },
  },
  run: (args, ctx) =>
    settleTab(ctx.tabId, typeof args.timeoutMs === "number" ? args.timeoutMs : 15_000),
});
