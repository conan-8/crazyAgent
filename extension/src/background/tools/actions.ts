// Action tools — route a ref to its frame and run the content-script action
// synthesizer there (works in cross-origin frames too, since the content
// script runs in every frame). `type`/`key` additionally choose between that
// synthesizer and trusted keystrokes through the browser's input pipeline:
// canvas document editors (Google Docs, Slides, Office on the web) only respond
// to the latter — see shared/trusted-input.ts.
import type { ActionResult } from "../../content/actions";
import { detectOpaqueSurface } from "../../shared/frames";
import { shouldUseTrustedInput, type InputHints } from "../../shared/trusted-input";
import type { ElementProbe } from "../policy";
import { runContentAction } from "./content-action";
import { collectFramePairs } from "./perception";
import { focusTarget, runTrustedInput } from "./trusted-input";
import { registerTool, type ToolContext } from "./types";

/** Element introspection for the Phase 6 policy layer (no side effects). */
export async function probeElement(
  tabId: number,
  ref: string,
): Promise<ElementProbe | null> {
  const res = await runContentAction(tabId, { action: "probe", ref });
  return res.ok ? (res.data as ElementProbe) : null;
}

/**
 * The route a `type`/`key` call takes. One content-script round trip both
 * focuses the target (which the content-script path needs anyway) and reports
 * the frame's shape — a hidden 1px editable inside a canvas page is a document
 * editor's sink, and only real keystrokes reach it.
 *
 * A failed inspection is NOT an error here: it just leaves the decision to the
 * explicit flag, and the action itself will report the real failure.
 */
async function decideInputRoute(
  ctx: ToolContext,
  ref: string | undefined,
  explicit: boolean | undefined,
): Promise<{ use: boolean; reason: string }> {
  // No ref = whatever the frame already has focused (a `key` call).
  const inspected = await focusTarget(ctx.tabId, ref ?? "").catch(() => null);
  const hints: InputHints = {
    explicit,
    ...(inspected && "hints" in inspected ? inspected.hints : {}),
  };
  return shouldUseTrustedInput(hints);
}

const REF_PROP = {
  ref: { type: "string", description: "Element ref from a snapshot, e.g. '12' or '9#2'" },
};

registerTool({
  name: "click",
  description: "Click the element with the given ref (scrolled into view first).",
  parameters: { type: "object", properties: { ...REF_PROP }, required: ["ref"] },
  run: (args, ctx) => runContentAction(ctx.tabId, { action: "click", ref: args.ref }),
});

registerTool({
  name: "type",
  description:
    "Type text into the element with the given ref (replaces its value). Set submit=true to submit the enclosing form afterwards. For canvas document editors (Google Docs/Slides, Office on the web) type into the editor's hidden text sink; the tool detects those and sends real keystrokes, which insert at the caret instead of replacing a value. Pass trusted=true to force real keystrokes anywhere, trusted=false to force the DOM path.",
  parameters: {
    type: "object",
    properties: {
      ...REF_PROP,
      text: { type: "string", description: "Text to enter (newlines become paragraph breaks)" },
      submit: { type: "boolean", description: "Submit the form after typing" },
      trusted: {
        type: "boolean",
        description:
          "true = send real keystrokes through the browser's input pipeline; false = synthesise DOM events. Omit to let the tool decide.",
      },
    },
    required: ["ref", "text"],
  },
  async run(args, ctx): Promise<ActionResult> {
    const ref = String(args.ref ?? "");
    const text = String(args.text ?? "");
    const submit = Boolean(args.submit);
    const explicit = typeof args.trusted === "boolean" ? args.trusted : undefined;
    const route = await decideInputRoute(ctx, ref, explicit);
    if (route.use) {
      return runTrustedInput({
        tabId: ctx.tabId,
        adapter: ctx.adapter,
        ref,
        text,
        submit,
        reason: route.reason,
      });
    }
    return runContentAction(ctx.tabId, { action: "type", ref, text, submit });
  },
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
    runContentAction(ctx.tabId, {
      action: "select",
      ref: args.ref,
      value: String(args.value ?? ""),
    }),
});

registerTool({
  name: "key",
  description:
    "Press a key or combo on the given ref (or the focused element), e.g. 'Enter', 'Escape', 'Control+a', 'Shift+Tab'. Enter in a form field submits the form. In canvas document editors (Google Docs/Slides) this sends real keystrokes, so editor shortcuts work: 'Control+b' bold, 'Control+i' italic, 'Control+Alt+1' heading, 'Control+Home' to the start. Pass trusted=true to force real keystrokes anywhere, trusted=false to force the DOM path.",
  parameters: {
    type: "object",
    properties: {
      ...REF_PROP,
      key: { type: "string", description: "Key combo, e.g. 'Enter' or 'Control+a'" },
      trusted: {
        type: "boolean",
        description:
          "true = send the key through the browser's input pipeline; false = dispatch DOM key events. Omit to let the tool decide.",
      },
    },
    required: ["key"],
  },
  async run(args, ctx): Promise<ActionResult> {
    const key = String(args.key ?? "");
    const ref = typeof args.ref === "string" ? args.ref : undefined;
    const explicit = typeof args.trusted === "boolean" ? args.trusted : undefined;
    const route = await decideInputRoute(ctx, ref, explicit);
    if (route.use) {
      return runTrustedInput({
        tabId: ctx.tabId,
        adapter: ctx.adapter,
        ref,
        key,
        reason: route.reason,
      });
    }
    return runContentAction(ctx.tabId, { action: "key", ref, key });
  },
});

registerTool({
  name: "hover",
  description: "Hover the mouse over the element with the given ref.",
  parameters: { type: "object", properties: { ...REF_PROP }, required: ["ref"] },
  run: (args, ctx) => runContentAction(ctx.tabId, { action: "hover", ref: args.ref }),
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
    runContentAction(ctx.tabId, {
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
