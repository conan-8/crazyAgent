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
import { screenshotToViewportPoint, type ShotMapping } from "../../shared/coords";
import { failureTag } from "../../shared/tool-failure";
import {
  evalWaitCondition,
  parseWaitArgs,
  WAIT_POLL_MS,
  type WaitObservation,
} from "../../shared/wait";
import { stageShelfImage } from "../shelf";
import { ensureAgentWindow, resolveAgentWindow } from "../window-scope";
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
 * latency + token cost). Falls back to the original on any failure. The
 * `Info` variant also reports the resulting image dimensions — the mapping
 * the coordinate tools need to turn "pixels of the image you are looking
 * at" into viewport CSS px (see `space:"screenshot"` on click_at).
 */
export async function downscaleJpegInfo(
  dataUrl: string,
  maxWidth = 1_280,
  quality = 0.7,
): Promise<{ dataUrl: string; width: number; height: number }> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    if (bmp.width <= maxWidth) {
      const out = { dataUrl, width: bmp.width, height: bmp.height };
      bmp.close();
      return out;
    }
    const scale = maxWidth / bmp.width;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl, width: 0, height: 0 };
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let binary = "";
    const chunk = 0x8_000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { dataUrl: `data:image/jpeg;base64,${btoa(binary)}`, width: w, height: h };
  } catch {
    return { dataUrl, width: 0, height: 0 }; // never fail a screenshot over an optimization
  }
}

export async function downscaleJpeg(
  dataUrl: string,
  maxWidth = 1_280,
  quality = 0.7,
): Promise<string> {
  return (await downscaleJpegInfo(dataUrl, maxWidth, quality)).dataUrl;
}

/**
 * What the latest viewport capture of a tab looks like: image dimensions
 * (after downscaling) plus, for FULL captures, the viewport's CSS dimensions
 * at capture time, and for REGION captures the exact CSS rect the crop
 * covers. The coordinate tools use it to convert `space:"screenshot"` points —
 * the model points at the image it is looking at (full or zoomed crop), the
 * tool does the scaling.
 */
export interface ViewportShotInfo {
  imageW: number;
  imageH: number;
  viewportCssW?: number;
  viewportCssH?: number;
  /** Region shots: the viewport CSS rect this crop covers. Absent = full viewport. */
  crop?: { x: number; y: number; w: number; h: number };
  at: number;
}

const viewportShots = new Map<number, ViewportShotInfo>();

export function viewportShotInfo(tabId: number): ViewportShotInfo | undefined {
  return viewportShots.get(tabId);
}

/**
 * The mapping of the LATEST capture of a tab — what `space:"screenshot"`
 * coordinates resolve against. Region shots carry their own absolute rect
 * (no live viewport needed); full shots resolve against the freshest CDP
 * layout metrics with the capture-time dims as fallback.
 */
export async function viewportShotMapping(
  tabId: number,
  adapter: ToolContext["adapter"],
): Promise<ShotMapping | undefined> {
  const shot = viewportShotInfo(tabId);
  if (!shot) return undefined;
  if (shot.crop) {
    return {
      imageW: shot.imageW,
      imageH: shot.imageH,
      rectX: shot.crop.x,
      rectY: shot.crop.y,
      rectW: shot.crop.w,
      rectH: shot.crop.h,
    };
  }
  const fresh = await layoutViewportCss(tabId, adapter).catch(() => undefined);
  const width = fresh?.width ?? shot.viewportCssW;
  const height = fresh?.height ?? shot.viewportCssH;
  if (typeof width !== "number" || typeof height !== "number") return undefined;
  return {
    imageW: shot.imageW,
    imageH: shot.imageH,
    rectX: 0,
    rectY: 0,
    rectW: width,
    rectH: height,
  };
}

/** The visible viewport's CSS dimensions via CDP layout metrics — works
 *  without a content script, so the coordinate tools can convert and
 *  bounds-check even on pages the registry never reached. */
export async function layoutViewportCss(
  tabId: number,
  adapter: ToolContext["adapter"],
): Promise<{ width: number; height: number; scrollX: number; scrollY: number } | undefined> {
  try {
    const m = (await adapter.send(tabId, "Page.getLayoutMetrics", {})) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const width = m?.cssVisualViewport?.clientWidth ?? m?.cssLayoutViewport?.clientWidth;
    const height = m?.cssVisualViewport?.clientHeight ?? m?.cssLayoutViewport?.clientHeight;
    if (typeof width !== "number" || typeof height !== "number") return undefined;
    return {
      width,
      height,
      scrollX: m?.cssVisualViewport?.pageX ?? 0,
      scrollY: m?.cssVisualViewport?.pageY ?? 0,
    };
  } catch {
    return undefined;
  }
}

/** Downscale a viewport capture and record its mapping info for the
 *  coordinate tools. Every viewport capture (screenshot, blind shot) goes
 *  through here so `space:"screenshot"` always has fresh dims. A `crop` says
 *  the capture covers only that viewport CSS rect (a zoom/region shot). */
async function recordViewportShot(
  tabId: number,
  adapter: ToolContext["adapter"],
  dataUrl: string,
  crop?: { x: number; y: number; w: number; h: number },
): Promise<{ dataUrl: string; shot: ViewportShotInfo }> {
  const vp = await layoutViewportCss(tabId, adapter);
  const maxWidth = crop ? 1_600 : 1_280;
  const quality = crop ? 0.8 : 0.7;
  const { dataUrl: jpeg, width, height } = await downscaleJpegInfo(dataUrl, maxWidth, quality);
  const shot: ViewportShotInfo = {
    imageW: width,
    imageH: height,
    viewportCssW: vp?.width,
    viewportCssH: vp?.height,
    ...(crop ? { crop } : {}),
    at: Date.now(),
  };
  if (width > 0 && height > 0) viewportShots.set(tabId, shot);
  return { dataUrl: jpeg, shot };
}

/**
 * Crop a region (viewport CSS rect) out of a full capture at NATIVE
 * resolution — a zoom shot. Small regions arrive effectively 2× sharper than
 * the same area inside a downscaled full-page shot, which is exactly the
 * precision `type_at` needs on text (rows ~19px apart). Falls back to the
 * original image on any failure.
 */
async function cropJpeg(
  dataUrl: string,
  crop: { x: number; y: number; w: number; h: number },
  vpW: number,
  vpH: number,
  maxWidth = 1_600,
  quality = 0.8,
): Promise<{ dataUrl: string; width: number; height: number }> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = bmp.width / vpW; // image px per CSS px (device pixel ratio)
    const sx = Math.max(0, Math.round(crop.x * scale));
    const sy = Math.max(0, Math.round(crop.y * scale));
    const sw = Math.max(1, Math.min(Math.round(bmp.width - sx), Math.round(crop.w * scale)));
    const sh = Math.max(1, Math.min(Math.round(bmp.height - sy), Math.round(crop.h * scale)));
    let w = sw;
    let h = sh;
    if (w > maxWidth) {
      h = Math.max(1, Math.round((h * maxWidth) / w));
      w = maxWidth;
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl, width: 0, height: 0 };
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let binary = "";
    const chunk = 0x8_000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { dataUrl: `data:image/jpeg;base64,${btoa(binary)}`, width: w, height: h };
  } catch {
    return { dataUrl, width: 0, height: 0 };
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
    return (await recordViewportShot(tabId, adapter, dataUrl)).dataUrl;
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
    // Inside the agent's own window: a bare create lands in whatever window is
    // focused (the USER's), which both breaks the isolation promise and leaves
    // the capture invisible to the run's own screenshots.
    const windowId = (await resolveAgentWindow()) ?? (await ensureAgentWindow());
    tabId = (await chrome.tabs.create({ url, active: false, windowId })).id;
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

/**
 * Resolve the screenshot tool's optional region/zoom args to a clamped
 * viewport-CSS rect. `zoom:N` crops the center of the viewport at 1/N — the
 * "Zoomed in" step precision clicking needs (text rows ~19px apart deserve a
 * sharper look than a downscaled full-page JPEG). An explicit region is x/y
 * + w/h in any coordinate space (viewport CSS px, page px, or 'screenshot'
 * pixels of the PREVIOUS capture — crop a crop). Returns undefined for a
 * full capture, or a tool-error string when the values are unusable.
 */
async function resolveCropRect(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<{ x: number; y: number; w: number; h: number } | undefined | string> {
  const hasRegion =
    typeof args.x === "number" &&
    typeof args.y === "number" &&
    typeof args.w === "number" &&
    typeof args.h === "number";
  const zoom = typeof args.zoom === "number" ? args.zoom : undefined;
  if (!hasRegion && zoom === undefined) return undefined;
  const vp = await layoutViewportCss(ctx.tabId, ctx.adapter).catch(() => undefined);
  if (!vp) {
    return `${failureTag("input")}: could not measure the viewport for the crop — retry without region/zoom`;
  }
  if (zoom !== undefined && (!Number.isFinite(zoom) || zoom < 1 || zoom > 8)) {
    return `${failureTag("input")}: zoom must be a number between 1 and 8`;
  }
  if (zoom !== undefined && !hasRegion) {
    const w = vp.width / zoom;
    const h = vp.height / zoom;
    return { x: (vp.width - w) / 2, y: (vp.height - h) / 2, w, h };
  }
  let x = args.x as number;
  let y = args.y as number;
  let w = args.w as number;
  let h = args.h as number;
  if (![x, y, w, h].every(Number.isFinite) || w < 8 || h < 8) {
    return `${failureTag("input")}: region needs finite x/y and w/h of at least 8 px`;
  }
  const space =
    args.space === "page" ? "page" : args.space === "screenshot" ? "screenshot" : "viewport";
  if (space === "page") {
    x -= vp.scrollX;
    y -= vp.scrollY;
  } else if (space === "screenshot") {
    const mapping = await viewportShotMapping(ctx.tabId, ctx.adapter);
    if (!mapping) {
      return `${failureTag("input")}: space:'screenshot' for a region needs an existing capture of this tab — take one first`;
    }
    const pt = screenshotToViewportPoint({ x, y }, mapping);
    w = (w * mapping.rectW) / mapping.imageW;
    h = (h * mapping.rectH) / mapping.imageH;
    x = pt.x;
    y = pt.y;
  }
  // Clamp to the viewport.
  x = Math.min(Math.max(0, x), Math.max(0, vp.width - 8));
  y = Math.min(Math.max(0, y), Math.max(0, vp.height - 8));
  w = Math.min(w, vp.width - x);
  h = Math.min(h, vp.height - y);
  if (w < 8 || h < 8) {
    return `${failureTag("input")}: region is smaller than 8×8 px after clamping to the viewport`;
  }
  return { x, y, w, h };
}

registerTool({
  name: "screenshot",
  description:
    "Capture a JPEG screenshot of the visible viewport. The image is ATTACHED to this result and you WILL see it — looking at it is the fastest way to resolve any confusion about what the page shows. Take one whenever you are confused, uncertain, or concerned — before guessing, before retrying a failing approach, and before reporting a blocker. PRECISION: pass zoom:2..4 for a sharper centered crop before exact coordinate work (placing a caret on a text line, table grids, resize handles), or x/y/w/h (+ space) for any region — crops arrive at native resolution and space:'screenshot' coordinates then resolve against the crop. The result reports the image's pixel dimensions: point at anything you see with type_at/click_at/hover_at/drag_at using space:'screenshot' and x/y in image pixels — the tool converts to viewport coordinates for you. Every capture also STAGES itself on the image shelf (shot_N): `paste_image` can then deliver those exact bytes into another page (chat composer, upload form, dropzone) with no disk and no paths. save_to_disk:true additionally writes the JPEG into the Downloads folder and reports its absolute path (SENSITIVE — confirmation required).",
  parameters: {
    type: "object",
    properties: {
      zoom: {
        type: "number",
        description:
          "Zoom factor 1..8: capture only the center of the viewport at 1/zoom, at native (sharper) resolution — the 'zoom in before precise clicks' step",
      },
      x: { type: "number", description: "Region left edge (see `space`; with w/h, captures that rect)" },
      y: { type: "number", description: "Region top edge (see `space`)" },
      w: { type: "number", description: "Region width in the same space as x/y (min 8)" },
      h: { type: "number", description: "Region height in the same space as x/y (min 8)" },
      space: {
        type: "string",
        description:
          "Region coordinate space: 'viewport' (default, CSS px), 'page', or 'screenshot' (pixels of the PREVIOUS capture — crop a crop)",
      },
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
    const crop = await resolveCropRect(ctx, args);
    if (typeof crop === "string") return { ok: false, error: crop };
    let jpeg: string;
    let shotInfo: ViewportShotInfo;
    if (crop) {
      const vp = await layoutViewportCss(ctx.tabId, ctx.adapter).catch(() => undefined);
      const out = await cropJpeg(dataUrl, crop, vp?.width ?? 0, vp?.height ?? 0);
      if (out.width === 0) {
        // A failed crop is a full capture, never a failed screenshot.
        const rec = await recordViewportShot(ctx.tabId, ctx.adapter, dataUrl);
        jpeg = rec.dataUrl;
        shotInfo = rec.shot;
      } else {
        shotInfo = {
          imageW: out.width,
          imageH: out.height,
          viewportCssW: vp?.width,
          viewportCssH: vp?.height,
          crop,
          at: Date.now(),
        };
        viewportShots.set(ctx.tabId, shotInfo);
        jpeg = out.dataUrl;
      }
    } else {
      const rec = await recordViewportShot(ctx.tabId, ctx.adapter, dataUrl);
      jpeg = rec.dataUrl;
      shotInfo = rec.shot;
    }
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
    // The image→viewport mapping, so the model can point at what it sees:
    // type_at/click_at space:'screenshot' takes x/y in THIS image's pixels.
    const coords =
      shotInfo.imageW > 0
        ? shotInfo.crop
          ? { image: { width: shotInfo.imageW, height: shotInfo.imageH }, crop: shotInfo.crop }
          : {
              image: { width: shotInfo.imageW, height: shotInfo.imageH },
              ...(typeof shotInfo.viewportCssW === "number"
                ? { viewport_css: { width: shotInfo.viewportCssW, height: shotInfo.viewportCssH } }
                : {}),
            }
        : undefined;
    if (args.save_to_disk !== true) return { dataUrl: jpeg, ident, shot, coords };
    const downloadId = await chrome.downloads.download({
      url: jpeg,
      filename,
      saveAs: false,
    });
    const path = await finalDownloadPath(downloadId);
    return { dataUrl: jpeg, saved: { downloadId, filename, path }, ident, shot, coords };
  },
  present(payload) {
    const p = payload as {
      dataUrl: string;
      saved?: { downloadId: number; filename: string; path?: string };
      ident?: string;
      shot?: { id: string; name: string };
      coords?: {
        image: { width: number; height: number };
        crop?: { x: number; y: number; w: number; h: number };
      };
    };
    const where = p.ident ? ` of ${p.ident}` : "";
    const saved = p.saved
      ? ` and saved as ${p.saved.filename}${p.saved.path ? ` (${p.saved.path})` : ""}`
      : "";
    const staged = p.shot
      ? ` — staged as ${p.shot.id}: paste_image can deliver these exact bytes into another page (no disk, no paths)`
      : "";
    const dims = p.coords
      ? p.coords.crop
        ? ` — CROP of viewport CSS rect (${Math.round(p.coords.crop.x)},${Math.round(p.coords.crop.y)} ${Math.round(p.coords.crop.w)}×${Math.round(p.coords.crop.h)}), native-resolution image ${p.coords.image.width}×${p.coords.image.height} px: type_at/click_at with space:'screenshot' now point into THIS crop`
        : ` — the image is ${p.coords.image.width}×${p.coords.image.height} px; type_at/click_at/hover_at/drag_at with space:'screenshot' take x/y in these image pixels and convert for you`
      : "";
    return {
      text: `[screenshot captured${where}${saved}${staged}${dims} — the image is attached below; look at it]`,
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
    "Wait until the page settles (no DOM mutations or network fetches for ~500ms) or the timeout elapses. Action results already settle automatically — use this only to wait for longer async work. NOT for streamed/progressive content (a chat reply still streaming): mutations can pause longer than the quiet window while the answer is still growing — use `wait_for` with stable_for_ms for that.",
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

/**
 * What one poll of the page (or one frame of it) saw for the wait conditions.
 * Injected fresh each poll — no dependency on the registry content script,
 * so this works on any injectable frame the moment it exists.
 */
async function readWaitObservation(
  tabId: number,
  frame: number | undefined,
  selector: string | undefined,
): Promise<WaitObservation | null> {
  let results: { frameId?: number; result?: unknown }[];
  try {
    results = await chrome.scripting.executeScript({
      target: frame !== undefined ? { tabId, frameIds: [frame] } : { tabId, allFrames: true },
      // NOTE: this function is SERIALIZED into the page — it must not close
      // over anything from the service worker (constants included).
      func: (sel: string | null) => {
        let selectorPresent: boolean | null = null;
        if (sel !== null) {
          try {
            selectorPresent = document.querySelector(sel) !== null;
          } catch {
            selectorPresent = null; // invalid selector in THIS document
          }
        }
        const text = (document.body?.innerText ?? "").slice(0, 40_000);
        return { text, selectorPresent };
      },
      args: [selector ?? null],
    });
  } catch {
    return null; // not injectable (chrome://, gone tab, dead frame)
  }
  if (!results?.length) return null;
  const parts = results
    .map((r) => r.result as WaitObservation | null)
    .filter((p): p is WaitObservation => !!p);
  if (!parts.length) return null;
  return {
    text: parts.map((p) => p.text).join("\n"),
    selectorPresent:
      selector === undefined
        ? null
        : parts.some((p) => p.selectorPresent === true),
  };
}

registerTool({
  name: "wait_for",
  description:
    "Block until a condition holds on the page, then return the matched text in the SAME call — one call replaces whole poll loops of wait_for_settle + read_page. Waiting on a remote assistant's streamed reply = ONE wait_for with stable_for_ms (text stops changing) and a generous timeout_ms. Conditions combine (AND): text appears (substring or /regex/), text_gone, selector appears, selector_gone, stable_for_ms. A timeout is a NORMAL result (matched:false), never an error — read the returned page tail and decide.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Wait until this substring appears (or /regex/ with flags)",
      },
      text_gone: {
        type: "string",
        description: "Wait until this substring is no longer on the page",
      },
      selector: {
        type: "string",
        description: "CSS selector that must appear",
      },
      selector_gone: {
        type: "string",
        description: "CSS selector that must disappear (a spinner, an overlay)",
      },
      stable_for_ms: {
        type: "number",
        description:
          "Additionally require the page text to have been unchanged for this many ms — the right condition for streamed replies that arrive gradually (1500–3000 works well)",
      },
      frame: {
        type: "number",
        description: "Frame id from the snapshot's Frames: list (default: all frames)",
      },
      timeout_ms: {
        type: "number",
        description: `Give up after this many ms (default 60000, cap 300000)`,
      },
    },
  },
  async run(args, ctx) {
    const shaped = parseWaitArgs(args);
    if ("error" in shaped) return { ok: false, error: `${failureTag("input")}: ${shaped.error}` };
    const cond = shaped.cond;
    const startedAt = Date.now();
    let lastText = "";
    let lastChangeAt = startedAt;
    let first = true;
    let lastObs: WaitObservation | null = null;
    let reachFailures = 0;
    // Poll until matched, timeout or user stop. A short unreachable stretch
    // (navigation in flight, frame reloading) is retried like settleTab does;
    // a long one reports honestly instead of hanging to the timeout.
    for (;;) {
      const obs = await readWaitObservation(ctx.tabId, cond.frame, cond.selector ?? cond.selectorGone);
      if (!obs) {
        reachFailures++;
        if (reachFailures > 10) {
          return {
            matched: false,
            waitedMs: Date.now() - startedAt,
            unreachable: true,
            note: "the page (or frame) could not be read for ~10 polls — it may have navigated away or be a non-injectable page",
          };
        }
      } else {
        reachFailures = 0;
        lastObs = obs;
        if (first || obs.text !== lastText) {
          lastText = obs.text;
          lastChangeAt = Date.now();
          first = false;
        }
        const stableMs = Date.now() - lastChangeAt;
        const evalRes = evalWaitCondition(cond, obs, stableMs);
        if (evalRes.ok) {
          return {
            matched: true,
            waitedMs: Date.now() - startedAt,
            stableMs: Math.round(stableMs),
            excerpt: evalRes.excerpt,
          };
        }
      }
      const waited = Date.now() - startedAt;
      if (waited >= cond.timeoutMs) {
        return {
          matched: false,
          timedOut: true,
          waitedMs: waited,
          unmet: (() => {
            const probe = evalWaitCondition(
              cond,
              lastObs ?? { text: "", selectorPresent: null },
              Date.now() - lastChangeAt,
            );
            return probe.unmet;
          })(),
          pageTail: lastText.slice(-600).trim(),
        };
      }
      if (ctx.stopping?.()) {
        return { matched: false, stopped: true, waitedMs: waited };
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }
  },
  present(payload) {
    const p = (payload ?? {}) as {
      matched?: boolean;
      waitedMs?: number;
      timedOut?: boolean;
      stopped?: boolean;
      unreachable?: boolean;
      unmet?: string[];
      excerpt?: string;
      pageTail?: string;
      stableMs?: number;
    };
    const secs = ((p.waitedMs ?? 0) / 1000).toFixed(1);
    if (p.stopped) return { text: `[wait_for] stopped by the user after ${secs}s` };
    if (p.unreachable) return { text: `[wait_for] could not read the page after ${secs}s` };
    if (p.matched) {
      return {
        text: `[wait_for] matched after ${secs}s${p.stableMs !== undefined ? ` (text stable ${p.stableMs}ms)` : ""}:\n${p.excerpt ?? "(condition without text — selector/stability)"}`,
      };
    }
    return {
      text: `[wait_for] timed out after ${secs}s — still unmet: ${(p.unmet ?? []).join(", ") || "?"}. Page tail:\n${p.pageTail ?? "(no text read)"}`,
    };
  },
});
