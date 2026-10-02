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
import { safeFilename, screenshotFilename } from "../../shared/filenames";
import { stageShelfImage } from "../shelf";
import { registerTool, type ToolContext } from "./types";

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
 * Rendering options for `formatSnapshot` — the perception tuning Claude in
 * Chrome has (cheap refs-only reads, hard caps): a long page used to explode
 * the context window because the render was unbounded.
 */
export interface SnapshotFormatOpts {
  /** "interactive" skips the (large) visible-text digest; refs only. */
  filter?: "all" | "interactive";
  /** Hard cap on the rendered text, with an explicit truncation note. */
  maxChars?: number;
  /** Scope the render to one frame id (from the snapshot's Frames: list). */
  frame?: number;
}

export const SNAPSHOT_DEFAULT_MAX_CHARS = 50_000;

/**
 * Cap rendered text and SAY SO. A silent clip is indistinguishable from a
 * short page, which is exactly how a model comes to believe it has seen
 * everything.
 */
export function truncateWithNote(text: string, max: number, what: string): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[${what} truncated at ${max} chars — raise max_chars for more, or use read_page for the full text]`;
}

/**
 * Render an input's value for the snapshot. A silent clip is worse than no
 * value at all: a real run stared at `value="…Read &amp;"` — a 40-char cut of
 * a longer string — and could not tell a truncated display from a literal
 * "&amp;" in the field, burning ~20 minutes re-typing a title. Truncated
 * values now say they were truncated, and how long the real value is.
 */
export function clipValue(value: string, max = 40): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}…[value truncated: ${value.length} chars total]`;
}

/**
 * Compact LLM-facing rendering of a snapshot: the main frame's URL, the text of
 * EVERY frame (main first, each labelled with its frame id and URL), a map of
 * the frames whose refs are addressable, and one note when the page paints its
 * content into a canvas that no tool can read.
 */
export function formatSnapshot(
  snap: AggregatedSnapshot,
  opts: SnapshotFormatOpts = {},
): string {
  const scoped = opts.frame === undefined;
  const elements = scoped
    ? snap.elements
    : snap.elements.filter((e) => e.frameId === opts.frame);
  const frames = scoped ? snap.frames : snap.frames.filter((f) => f.frameId === opts.frame);
  const lines = elements.map((e) => {
    const bits = [
      e.ref,
      e.tag + (e.type ? `[${e.type}]` : ""),
      `"${e.name}"`,
    ];
    if (e.disabled) bits.push("disabled");
    if (e.editable) bits.push("editable");
    if (e.value && e.tag !== "button") bits.push(`value="${clipValue(e.value)}"`);
    return bits.join(" ");
  });
  const parts = [
    `URL: ${frames.find((f) => f.frameId === 0)?.href ?? frames[0]?.href ?? ""}`,
  ];
  if (opts.filter !== "interactive") {
    parts.push(
      `Visible text: ${scoped ? snap.text || buildFrameText(snap) : frames[0]?.text ?? ""}`,
    );
  }
  const frameMap = formatFrameMap(scoped ? snap : { ...snap, frames });
  if (frameMap) parts.push(frameMap);
  const opaque = detectOpaqueSurface({
    canvases: frames.reduce((n, f) => n + (f.canvases ?? 0), 0),
    domTextChars: frames.reduce((n, f) => n + (f.textChars ?? 0), 0),
    frames: frames.length,
  });
  if (opaque) parts.push(opaque);
  parts.push(
    `Interactive elements (ref tag "name"):\n${lines.join("\n") || "(none in this frame)"}`,
  );
  return truncateWithNote(
    parts.join("\n"),
    opts.maxChars ?? SNAPSHOT_DEFAULT_MAX_CHARS,
    "snapshot",
  );
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

/**
 * Best-effort "you have to SEE this" capture. Whenever text perception comes
 * back empty — or a tool fails — one screenshot rides back with the result:
 * the model looks at the page instead of guessing, retrying blindly, or
 * concluding the page is empty. Never throws: a capture exists to help the
 * result, not to replace it.
 */
export async function captureBlindShot(
  adapter: ToolContext["adapter"],
  tabId: number,
): Promise<string | undefined> {
  try {
    const { dataUrl } = await adapter.screenshot(tabId);
    return await downscaleJpeg(dataUrl);
  } catch {
    return undefined;
  }
}

/** True when the text tools genuinely see nothing — not just a trimmed read. */
export function isBlind(snap: {
  elements: unknown[];
  text?: string;
}): boolean {
  return snap.elements.length === 0 && (snap.text ?? "").trim().length < 32;
}

/**
 * Human-readable identity of a tab ("tab 123 \"Title\" (url) captured
 * HH:MM:SS"), so every image an agent sees says WHICH page it shows. Never
 * throws — an unidentified shot is still a shot.
 */
export async function tabIdentity(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const at = new Date().toISOString().slice(11, 19);
    return `tab ${tabId} "${(tab.title ?? "").slice(0, 60)}" (${(tab.url ?? "").slice(0, 100)}) at ${at}`;
  } catch {
    return `tab ${tabId}`;
  }
}

const IMAGE_URL_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)($|\?)/i;

/**
 * Fetch an image straight to a data URL. The extension holds host permissions
 * for every origin, so this fetch is not subject to page CORS — the trick a
 * real run wasted a turn on before opening the file in its own tab.
 */
async function fetchImageDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!mime.startsWith("image/") && !IMAGE_URL_EXT.test(url)) return undefined;
    const buf = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    const chunk = 0x8_000;
    for (let i = 0; i < buf.length; i += chunk) {
      binary += String.fromCharCode(...buf.subarray(i, i + chunk));
    }
    return `data:${mime.startsWith("image/") ? mime : "image/png"};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}

/**
 * Last resort for hotlink-protected images: let the BROWSER load the URL in a
 * hidden tab (no CORS on a top-level image document) and capture what renders.
 */
async function shotOfUrl(
  ctx: ToolContext,
  url: string,
): Promise<string | undefined> {
  let tabId: number | undefined;
  try {
    tabId = (await chrome.tabs.create({ url, active: false })).id;
    if (tabId === undefined) return undefined;
    for (let i = 0; i < 20; i++) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const { dataUrl } = await ctx.adapter.screenshot(tabId);
    return await downscaleJpeg(dataUrl);
  } catch {
    return undefined;
  } finally {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => null);
  }
}

/**
 * Absolute path of a finished download, or undefined when it never settled.
 * A guessable "Downloads/q2.jpg" is what sent a real run attaching
 * "/root/Downloads/q2.jpg" three times — the browser profile's real download
 * directory is nobody's guess, so save_to_disk now reports the truth.
 */
async function finalDownloadPath(
  downloadId: number,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const items = await chrome.downloads.search({ id: downloadId });
      const item = items[0];
      if (item?.state === "complete") return item.filename || undefined;
      if (item?.state === "interrupted") return undefined;
    } catch {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return undefined;
}

/** A presentable filename for a viewed image (basename of the URL + mime ext). */
function imageNameFromUrl(url: string, mime: string): string {
  const ext = mime.includes("png")
    ? "png"
    : mime.includes("webp")
      ? "webp"
      : mime.includes("gif")
        ? "gif"
        : "jpg";
  let last = "";
  if (!url.startsWith("data:")) {
    try {
      last = decodeURIComponent(url.split("?")[0]!.split("/").pop() ?? "").slice(0, 80);
    } catch {
      last = "";
    }
  }
  return safeFilename(last, ext, "image");
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
      // The tab the agent is on (ctx.tabId) — not "whatever is focused",
      // which can be a different window entirely.
      const tab = await chrome.tabs.get(ctx.tabId).catch(() => undefined);
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
    "Capture the current page as a numbered list of interactive elements (clickable, typable) plus a digest of visible text. Elements are listed once per frame (cross-origin frames included, refs look like 'frameId#n'). Act on elements by ref with the action tools. On long pages use filter:'interactive' (refs only) or max_chars to keep the output manageable — a truncated output always ends with a truncation note.",
  parameters: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "'all' (default) = refs + visible text; 'interactive' = refs only",
      },
      max_chars: {
        type: "number",
        description: `Cap the rendered output (default ${SNAPSHOT_DEFAULT_MAX_CHARS}); a truncated output ends with an explicit note`,
      },
      frame: {
        type: "number",
        description: "Limit to one frame id (from the snapshot's Frames: list)",
      },
    },
  },
  async run(args, ctx) {
    const snap = await collectSnapshot(ctx.tabId);
    const format: SnapshotFormatOpts = {
      filter: args.filter === "interactive" ? "interactive" : "all",
      maxChars: typeof args.max_chars === "number" ? args.max_chars : undefined,
      frame: typeof args.frame === "number" ? args.frame : undefined,
    };
    // Nothing readable is not "an empty page" — it is this tool being blind.
    // Attach a screenshot so the model SEE the state instead of concluding
    // there is nothing there (a live run lost its first three turns exactly
    // here, staring at "(none in this frame)" while the page was on screen).
    const blindShot = isBlind(snap)
      ? await captureBlindShot(ctx.adapter, ctx.tabId)
      : undefined;
    return { ...snap, format, blindShot };
  },
  present(payload) {
    const p = payload as AggregatedSnapshot & {
      format?: SnapshotFormatOpts;
      blindShot?: string;
    };
    const text = formatSnapshot(p, p.format);
    return p.blindShot
      ? {
          text: `${text}\n\n[The text tools see NOTHING on this page — a screenshot is attached. LOOK at it before concluding anything about the page, and prefer acting on what it shows over retrying the text tools.]`,
          image: p.blindShot,
        }
      : { text };
  },
});

registerTool({
  name: "screenshot",
  description:
    "Capture a JPEG screenshot of the visible viewport. The image is ATTACHED to this result and you WILL see it — looking at it is the fastest way to resolve any confusion about what the page shows. Take one whenever you are confused, uncertain, or concerned — before guessing, before retrying a failing approach, and before reporting a blocker. Every capture also STAGES itself on the image shelf (shot_N): `paste_image` can then deliver those exact bytes into another page (chat composer, upload form, dropzone) with no disk and no paths. save_to_disk:true additionally writes the JPEG into the Downloads folder and reports its absolute path (SENSITIVE — confirmation required).",
  parameters: {
    type: "object",
    properties: {
      save_to_disk: {
        type: "boolean",
        description: "Also write the JPEG to the Downloads folder (confirmation required)",
      },
      filename: {
        type: "string",
        description: "File name for the saved image (default screenshot-<timestamp>.jpg)",
      },
    },
  },
  async run(args, ctx) {
    const { dataUrl } = await ctx.adapter.screenshot(ctx.tabId);
    const jpeg = await downscaleJpeg(dataUrl);
    // Stamp which tab/URL this image came from. A screenshot with no identity
    // is how a real run convinced itself the tool was returning stale caches
    // when it was actually capturing a different window's tab.
    const ident = await tabIdentity(ctx.tabId);
    // Downloads only ever gets a bare filename — never a path the model (or a
    // page that influenced it) could point at an arbitrary location.
    const filename = screenshotFilename(args.filename);
    // Stage the bytes on the shelf so a later paste_image/upload can deliver
    // them tool→tool — the model never has to carry (or re-type) base64, and
    // never has to guess where Downloads lives on this machine.
    const staged = await stageShelfImage({
      dataUrl: jpeg,
      mime: "image/jpeg",
      name: filename,
      tabId: ctx.tabId,
    });
    const shot = staged.id ? { id: staged.id, name: filename } : undefined;
    if (args.save_to_disk !== true) return { dataUrl: jpeg, ident, shot };
    const downloadId = await chrome.downloads.download({
      url: jpeg,
      filename,
      saveAs: false,
    });
    const path = await finalDownloadPath(downloadId);
    return { dataUrl: jpeg, saved: { downloadId, filename, path }, ident, shot };
  },
  present(payload) {
    const p = payload as {
      dataUrl: string;
      saved?: { downloadId: number; filename: string; path?: string };
      ident?: string;
      shot?: { id: string; name: string };
    };
    const where = p.ident ? ` of ${p.ident}` : "";
    const saved = p.saved
      ? ` and saved as ${p.saved.filename}${p.saved.path ? ` (${p.saved.path})` : ""}`
      : "";
    const staged = p.shot
      ? ` — staged as ${p.shot.id}: paste_image can deliver these exact bytes into another page (no disk, no paths)`
      : "";
    return {
      text: `[screenshot captured${where}${saved}${staged} — the image is attached below; look at it]`,
      image: p.dataUrl,
    };
  },
});

registerTool({
  name: "view_image",
  description:
    "Fetch an image by URL and ATTACH it to this result so you SEE it — one call replaces every pixel-archaeology workaround (canvas draws, color histograms, ASCII renders: NEVER do those). Use it for any image the page or network traffic points at: an <img> src, a PNG/SVG URL from network_read or evaluate_js, a CDN asset. The image below the result is the actual file, exactly as the server serves it.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Image URL (http(s) or data:) — e.g. an img src or a request URL from network_read",
      },
    },
    required: ["url"],
  },
  async run(args, ctx) {
    const url = String(args.url ?? "");
    let dataUrl = url.startsWith("data:image/")
      ? url
      : await fetchImageDataUrl(url);
    if (!dataUrl) dataUrl = await shotOfUrl(ctx, url);
    if (!dataUrl) {
      return {
        ok: false,
        error: `view_image could not fetch ${url.slice(0, 160)} — the server may block direct fetches; screenshot the page where the image renders instead`,
      };
    }
    const final = await downscaleJpeg(dataUrl);
    // Stage viewed images too: "fetch this image, then send it to the chat app"
    // is the same shelf→paste_image pipe as a screenshot.
    const mime = final.slice(5, Math.max(final.indexOf(";"), 5)) || "image/jpeg";
    const name = imageNameFromUrl(url, mime);
    const staged = await stageShelfImage({
      dataUrl: final,
      mime,
      name,
      tabId: ctx.tabId,
      sourceUrl: url.startsWith("data:") ? "" : url.slice(0, 500),
    });
    return {
      url,
      dataUrl: final,
      shot: staged.id ? { id: staged.id, name } : undefined,
    };
  },
  present(payload) {
    const p = payload as {
      url: string;
      dataUrl: string;
      shot?: { id: string; name: string };
    };
    const staged = p.shot ? ` — staged as ${p.shot.id} (paste_image can deliver it into another page)` : "";
    return {
      text: `[image attached: ${p.url.slice(0, 160)} — the image below is the file itself; look at it${staged}]`,
      image: p.dataUrl,
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
