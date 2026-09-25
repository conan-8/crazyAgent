// Action tools — route a ref to its frame and run the content-script action
// synthesizer there (works in cross-origin frames too, since the content
// script runs in every frame).
import type { ActionResult } from "../../content/actions";
import { detectOpaqueSurface } from "../../shared/frames";
import type { ElementProbe } from "../policy";
import { collectFramePairs } from "./perception";
import { registerTool } from "./types";

function parseRef(ref: string): { frameId: number; localRef: string } {
  const hash = ref.indexOf("#");
  if (hash === -1) return { frameId: 0, localRef: ref };
  return {
    frameId: Number(ref.slice(0, hash)),
    localRef: ref.slice(hash + 1),
  };
}

async function runAction(
  tabId: number,
  req: Record<string, unknown>,
): Promise<ActionResult> {
  const ref = typeof req.ref === "string" ? req.ref : null;
  const frameId = ref ? parseRef(ref).frameId : 0;
  const payload = ref
    ? { ...req, ref: parseRef(ref).localRef }
    : req;
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (p: unknown) => {
      const g = globalThis as {
        __baActions?: { run(r: unknown): unknown };
      };
      return g.__baActions
        ? g.__baActions.run(p)
        : { ok: false, error: "actions-not-loaded" };
    },
    args: [payload],
  });
  return (results[0]?.result ?? { ok: false, error: "no result" }) as ActionResult;
}

/** Element introspection for the Phase 6 policy layer (no side effects). */
export async function probeElement(
  tabId: number,
  ref: string,
): Promise<ElementProbe | null> {
  const res = await runAction(tabId, { action: "probe", ref });
  return res.ok ? (res.data as ElementProbe) : null;
}

const REF_PROP = {
  ref: { type: "string", description: "Element ref from a snapshot, e.g. '12' or '9#2'" },
};

registerTool({
  name: "click",
  description: "Click the element with the given ref (scrolled into view first).",
  parameters: { type: "object", properties: { ...REF_PROP }, required: ["ref"] },
  run: (args, ctx) => runAction(ctx.tabId, { action: "click", ref: args.ref }),
});

registerTool({
  name: "type",
  description:
    "Type text into the element with the given ref (replaces its value). Set submit=true to submit the enclosing form afterwards.",
  parameters: {
    type: "object",
    properties: {
      ...REF_PROP,
      text: { type: "string", description: "Text to enter" },
      submit: { type: "boolean", description: "Submit the form after typing" },
    },
    required: ["ref", "text"],
  },
  run: (args, ctx) =>
    runAction(ctx.tabId, {
      action: "type",
      ref: args.ref,
      text: String(args.text ?? ""),
      submit: Boolean(args.submit),
    }),
});

registerTool({
  name: "select",
  description: "Choose an option (by value) in the select element with the given ref.",
  parameters: {
    type: "object",
    properties: {
      ...REF_PROP,
      value: { type: "string", description: "Option value to select" },
    },
    required: ["ref", "value"],
  },
  run: (args, ctx) =>
    runAction(ctx.tabId, {
      action: "select",
      ref: args.ref,
      value: String(args.value ?? ""),
    }),
});

registerTool({
  name: "key",
  description:
    "Press a key or combo on the given ref (or the focused element), e.g. 'Enter', 'Escape', 'Control+a', 'Shift+Tab'. Enter in a form field submits the form.",
  parameters: {
    type: "object",
    properties: {
      ...REF_PROP,
      key: { type: "string", description: "Key combo, e.g. 'Enter' or 'Control+a'" },
    },
    required: ["key"],
  },
  run: (args, ctx) =>
    runAction(ctx.tabId, {
      action: "key",
      ref: typeof args.ref === "string" ? args.ref : undefined,
      key: String(args.key ?? ""),
    }),
});

registerTool({
  name: "hover",
  description: "Hover the mouse over the element with the given ref.",
  parameters: { type: "object", properties: { ...REF_PROP }, required: ["ref"] },
  run: (args, ctx) => runAction(ctx.tabId, { action: "hover", ref: args.ref }),
});

registerTool({
  name: "scroll",
  description:
    "Scroll: to an element via ref, or the page by dx/dy pixels when no ref is given.",
  parameters: {
    type: "object",
    properties: {
      ...REF_PROP,
      dx: { type: "number", description: "Horizontal pixels (no ref)" },
      dy: { type: "number", description: "Vertical pixels (no ref)" },
    },
  },
  run: (args, ctx) =>
    runAction(ctx.tabId, {
      action: "scroll",
      ref: typeof args.ref === "string" ? args.ref : undefined,
      dx: typeof args.dx === "number" ? args.dx : 0,
      dy: typeof args.dy === "number" ? args.dy : 0,
    }),
});

registerTool({
  name: "read_page",
  description:
    "Extract visible text from the top document AND every iframe (lightweight; does not invalidate element refs). Each frame's text is labelled with its frame id and URL — use those ids with `evaluate_js frame:N` or as the `N#ref` prefix on action tools.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    // Refreshing the frame-id pairing here means `evaluate_js frame:N` works
    // right after the read the model just did, without an extra `frames` call.
    await collectFramePairs(ctx.tabId, ctx.adapter).catch(() => null);
    const results = await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId, allFrames: true },
      func: () => {
        const g = globalThis as {
          __baRegistry?: {
            read(): {
              href: string;
              title: string;
              text: string;
              canvases: number;
              textChars: number;
            };
          };
        };
        return g.__baRegistry ? g.__baRegistry.read() : null;
      },
    });
    return results.map((r) => {
      const info = r.result as {
        href?: string;
        title?: string;
        text?: string;
        canvases?: number;
        textChars?: number;
      } | null;
      return {
        frameId: r.frameId ?? 0,
        href: info?.href ?? "",
        title: info?.title ?? "",
        text: info?.text ?? "",
        canvases: info?.canvases ?? 0,
        textChars: info?.textChars ?? 0,
        // A frame whose content script never ran returns null — that is NOT an
        // empty frame, and the distinction matters when deciding to retry.
        instrumented: info !== null,
      };
    });
  },
  present(payload) {
    const pages = payload as {
      frameId: number;
      href: string;
      text: string;
      canvases: number;
      textChars: number;
      instrumented: boolean;
    }[];
    const body = pages
      .map((p) => {
        const head = `--- frame ${p.frameId} (${p.href || "no url"}) ---`;
        if (!p.instrumented) return `${head}\n[no content script in this frame — cannot be read]`;
        if (!p.text.trim() && p.canvases > 0) {
          return `${head}\n[content is drawn into ${p.canvases} <canvas> — unreadable by any tool; use screenshot]`;
        }
        return `${head}\n${p.text}`;
      })
      .join("\n");
    const opaque = detectOpaqueSurface({
      canvases: pages.reduce((n, p) => n + p.canvases, 0),
      domTextChars: pages.reduce((n, p) => n + p.textChars, 0),
      frames: pages.length,
    });
    return { text: opaque ? `${body}\n\n${opaque}` : body };
  },
});
