// Perception tools: snapshot (per-frame element collection), screenshot,
// and wait_for_settle. The snapshot/settle primitives are exported so the
// agent runner can auto-attach a fresh observation after mutating actions.
import type { ElementInfo, FrameSnapshot } from "../../content/registry";
import {
  buildFrameText,
  detectOpaqueSurface,
  formatFrameMap,
  orderFrames,
  type AggregatedSnapshot,
  type FrameSnapshotLike,
} from "../../shared/frames";
import { registerTool } from "./types";

export type { AggregatedSnapshot };

export interface FramePair {
  url: string;
  scriptingFrameId: number;
  cdpFrameId: string;
}

/** One flat frame entry as the model sees it. */
export interface FrameInfo {
  frameId: number;
  url: string;
  title: string;
  /** False when the content script could not run there (chrome://, PDF, …). */
  instrumented: boolean;
  /** True when this frame's text was rendered in the snapshot. */
  hasText: boolean;
}

/**
 * Pair the two frame-id spaces the browser exposes, by URL.
 *
 * chrome.scripting reports frames as small integers (0, 9, 17 — NOT sequential)
 * and refs are built from those; CDP uses 32-hex-char ids, and only CDP's
 * execution contexts (which is what makes a frame evaluable) carry the CDP form.
 * Neither id can be derived from the other, so we collect both and pair on URL,
 * the one key they share.
 */
export async function collectFramePairs(
  tabId: number,
  adapter: {
    send<T>(tabId: number, method: string, params?: object): Promise<T>;
    mapFrames?(tabId: number, pairs: FramePair[]): void;
  },
): Promise<{ pairs: FramePair[]; scripting: { frameId: number; href: string }[] }> {
  const scripting = (
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href,
    })
  ).map((r) => ({ frameId: r.frameId ?? 0, href: String(r.result ?? "") }));

  let cdpFrames: { id: string; url: string }[] = [];
  try {
    const tree = await adapter.send<{ frameTree?: CdpFrameNode }>(tabId, "Page.getFrameTree", {});
    cdpFrames = flattenFrameTree(tree?.frameTree);
  } catch {
    cdpFrames = []; // frames still usable for refs/text without CDP ids
  }

  const cdpByUrl = new Map(cdpFrames.map((f) => [f.url, f.id]));
  const pairs: FramePair[] = scripting.map((f) => ({
    url: f.href,
    scriptingFrameId: f.frameId,
    cdpFrameId: cdpByUrl.get(f.href) ?? "",
  }));
  adapter.mapFrames?.(tabId, pairs);
  return { pairs, scripting };
}

interface CdpFrameNode {
  frame?: { id?: string; url?: string };
  childFrames?: CdpFrameNode[];
}

/** The CDP frame tree, flattened depth-first (parents before children). */
export function flattenFrameTree(
  node: CdpFrameNode | undefined,
): { id: string; url: string }[] {
  const out: { id: string; url: string }[] = [];
  const walk = (n: CdpFrameNode | undefined): void => {
    if (!n?.frame?.id) return;
    out.push({ id: n.frame.id, url: n.frame.url ?? "" });
    for (const child of n.childFrames ?? []) walk(child);
  };
  walk(node);
  return out;
}

/**
 * The model-facing frame list: every addressable frame with its id, URL and
 * whether we can read it. This is what turns "refs like 9#12 exist" into "frame
 * 9 is the embedded doc, and I can evaluate in it".
 */
export function describeFrames(
  scripting: { frameId: number; href: string; title?: string; instrumented: boolean; textChars: number }[],
): FrameInfo[] {
  return orderFrames(
    scripting.map((f) => ({
      frameId: f.frameId,
      href: f.href,
      title: f.title ?? "",
      text: "",
    })),
  ).map((f) => {
    const source = scripting.find((s) => s.frameId === f.frameId);
    return {
      frameId: f.frameId,
      url: f.href,
      title: f.title,
      instrumented: source?.instrumented ?? false,
      hasText: (source?.textChars ?? 0) > 0,
    };
  });
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
  const frames: FrameSnapshotLike[] = [];
  const elements: AggregatedSnapshot["elements"] = [];
  for (const result of results) {
    const frameId = result.frameId ?? 0;
    const snap = result.result as FrameSnapshot | { error: string } | null;
    if (!snap || "error" in snap) continue;
    frames.push({ ...snap, frameId });
    for (const el of snap.elements) {
      elements.push({ ...el, ref: `${frameId}#${el.ref}`, frameId });
    }
  }
  // Every frame's text is kept (main first) — see shared/frames.ts. The old
  // version assigned only frame 0's, so a page whose content lives in an iframe
  // (Docs, school portals) looked empty to the model.
  const snapshot: AggregatedSnapshot = { frames: orderFrames(frames), elements, text: "" };
  // `text` is the frame-assembled digest (main + labelled iframes) so every
  // consumer — the tool payload, the auto-observation path, driver scripts —
  // gets the same complete picture.
  snapshot.text = buildFrameText(snapshot);
  return snapshot;
}

/**
 * Compact LLM-facing rendering of a snapshot: the main frame's URL, the text of
 * EVERY frame (main first, each labelled with its frame id and URL), a map of
 * the frames whose refs are addressable, and one note when the page paints its
 * content into a canvas that no tool can read.
 */
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
  const parts = [
    `URL: ${snap.frames.find((f) => f.frameId === 0)?.href ?? snap.frames[0]?.href ?? ""}`,
    `Visible text: ${snap.text || buildFrameText(snap)}`,
  ];
  const frameMap = formatFrameMap(snap);
  if (frameMap) parts.push(frameMap);
  const opaque = detectOpaqueSurface({
    canvases: snap.frames.reduce((n, f) => n + (f.canvases ?? 0), 0),
    domTextChars: snap.frames.reduce((n, f) => n + (f.textChars ?? 0), 0),
    frames: snap.frames.length,
  });
  if (opaque) parts.push(opaque);
  parts.push(`Interactive elements (ref tag "name"):\n${lines.join("\n")}`);
  return parts.join("\n");
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
  name: "page_health",
  description:
    "Quick check that the tools can actually reach the current tab, reporting which layer works: content script injection, tab access, and the debugger channel used by screenshot / evaluate_js. Call this when several tools in a row fail, instead of retrying them one by one — it tells you whether the problem is the page or the connection to it.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    const report = {
      url: "",
      injection: "unknown" as string,
      frames: 0,
      tabAccess: "unknown" as string,
      debuggerChannel: "unknown" as string,
      advice: "",
    };
    try {
      const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      report.url = tab?.url ?? "";
      report.tabAccess = tab ? "ok" : "no active tab";
    } catch (err) {
      report.tabAccess = String((err as Error)?.message ?? err);
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: ctx.tabId, allFrames: true },
        func: () => location.href,
      });
      report.frames = results.length;
      report.injection = results.length ? "ok" : "no frames";
    } catch (err) {
      report.injection = String((err as Error)?.message ?? err).slice(0, 200);
    }
    try {
      await ctx.adapter.send(ctx.tabId, "Page.getFrameTree", {});
      report.debuggerChannel = "ok";
    } catch (err) {
      report.debuggerChannel = String((err as Error)?.message ?? err).slice(0, 200);
    }
    const broken: string[] = [];
    if (report.injection !== "ok") broken.push("content scripts cannot run in this page");
    if (report.debuggerChannel !== "ok") broken.push("the debugger channel to the tab is down");
    report.advice = broken.length
      ? `Do NOT keep retrying tools. ${broken.join("; ")}. Reload the tab (or switch away and back) and check again; if the page is chrome://, a PDF viewer or an extension page, it cannot be automated.`
      : "All layers respond — a tool that failed was failing for its own reason (bad ref, CSP, or a frame you cannot address), not because the page is unreachable.";
    return report;
  },
  present(payload) {
    const r = payload as Record<string, string | number>;
    return {
      text: [
        `url: ${r.url || "(none)"}`,
        `tab access: ${r.tabAccess}`,
        `content-script injection: ${r.injection} (${r.frames} frame(s))`,
        `debugger channel: ${r.debuggerChannel}`,
        "",
        String(r.advice),
      ].join("\n"),
    };
  },
});

registerTool({
  name: "frames",
  description:
    "List every frame of the current page: its frame id, URL, title and whether it can be read. Use this when content seems to be missing from the snapshot — embedded documents, slide decks and portals that frame their tools live in frames, and their text is in the snapshot's `Visible text` while this list tells you which id maps to which URL (for `evaluate_js frame:N` and for `N#ref` action refs).",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    const { scripting } = await collectFramePairs(ctx.tabId, ctx.adapter);
    // One cheap read per frame tells us which are actually instrumented.
    const reads = await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId, allFrames: true },
      func: () => {
        const g = globalThis as {
          __baRegistry?: { read(): { href: string; title: string; textChars: number } };
        };
        return g.__baRegistry ? g.__baRegistry.read() : null;
      },
    });
    const byFrame = new Map(
      reads.map((r) => [
        r.frameId ?? 0,
        r.result as { href: string; title: string; textChars: number } | null,
      ]),
    );
    return describeFrames(
      scripting.map((f) => {
        const info = byFrame.get(f.frameId);
        return {
          frameId: f.frameId,
          href: info?.href || f.href,
          title: info?.title ?? "",
          instrumented: info != null,
          textChars: info?.textChars ?? 0,
        };
      }),
    );
  },
  present(payload) {
    const frames = payload as FrameInfo[];
    if (!frames.length) return { text: "no frames found" };
    return {
      text: frames
        .map((f) => {
          const state = !f.instrumented
            ? "not readable (no content script)"
            : f.hasText
              ? "readable"
              : "empty";
          const title = f.title ? ` "${f.title}"` : "";
          return `- frame ${f.frameId}: ${f.url || "(no url)"}${title} — ${state}`;
        })
        .join("\n"),
    };
  },
});

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
