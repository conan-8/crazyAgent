// Action tools — route a ref to its frame and run the content-script action
// synthesizer there (works in cross-origin frames too, since the content
// script runs in every frame). `type`/`key` additionally choose between that
// synthesizer and trusted keystrokes through the browser's input pipeline:
// canvas document editors (Google Docs, Slides, Office on the web) only respond
// to the latter — see shared/trusted-input.ts.
import type { ActionResult } from "../../content/actions";
import { detectOpaqueSurface } from "../../shared/frames";
import { shouldUseTrustedInput, type InputHints } from "../../shared/trusted-input";
import { EXPECT_PROP } from "../../shared/expect";
import { failureTag } from "../../shared/tool-failure";
import type { ElementProbe } from "../policy";
import { runContentAction, parseRef } from "./content-action";
import { captureBlindShot, collectFramePairs, truncateWithNote } from "./perception";
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
    "Type text into the element with the given ref (replaces its value) — or, with NO ref, as real keystrokes at whatever is focused. Canvas document editors (Google Docs/Slides, Office on the web) are typed WITHOUT a ref: one call finds the editor's hidden typing sink and inserts the WHOLE string at the caret (real keystrokes — the only thing such editors respond to). A ref-less type NEVER reaches an unfocused field: with no text field focused it goes into the document body at the caret, so for a dialog or an iframe field (an image picker's search box, a find bar) take a snapshot first and pass that field's ref. Never type into a canvas editor character by character. select:'all' does Ctrl+A inside the same trusted sequence (atomic replace — the selection cannot be lost between calls). Set submit:true to submit the enclosing form afterwards. Pass trusted=true to force real keystrokes anywhere, trusted=false to force the DOM path (which needs a ref).",
  parameters: {
    type: "object",
    properties: {
      ...REF_PROP,
      text: { type: "string", description: "Text to enter (newlines become paragraph breaks)" },
      select: {
        type: "string",
        description: "'all' = select all (Ctrl+A) atomically right before typing — replaces the editor's content",
        enum: ["all"],
      },
      submit: { type: "boolean", description: "Submit the form after typing" },
      trusted: {
        type: "boolean",
        description:
          "true = send real keystrokes through the browser's input pipeline; false = synthesise DOM events. Omit to let the tool decide.",
      },
      ...EXPECT_PROP,
    },
    required: ["text"],
  },
  async run(args, ctx): Promise<ActionResult> {
    const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref : undefined;
    const text = String(args.text ?? "");
    const submit = Boolean(args.submit);
    const selectAll = args.select === "all";
    const explicit = typeof args.trusted === "boolean" ? args.trusted : undefined;
    if (!ref) {
      // No ref = the canvas-editor route: real keystrokes at the focused
      // target / editor sink. The DOM path has nothing to target without a ref.
      if (explicit === false) {
        return {
          ok: false,
          error: `${failureTag("input")}: \`type\` without a ref types real keystrokes at the focused target — pass trusted:true (or omit trusted), or give a ref for the DOM path.`,
        };
      }
      return runTrustedInput({
        tabId: ctx.tabId,
        adapter: ctx.adapter,
        text,
        submit,
        selectAll,
        reason:
          explicit === true
            ? "requested (trusted: true)"
            : "no ref: real keystrokes at the focused target / editor sink",
      });
    }
    const route = await decideInputRoute(ctx, ref, explicit);
    if (route.use) {
      return runTrustedInput({
        tabId: ctx.tabId,
        adapter: ctx.adapter,
        ref,
        text,
        submit,
        selectAll,
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
      ...EXPECT_PROP,
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

/**
 * Attach local paths through CDP's DOM world. The ref only exists in the
 * content script, so the input is tagged with a token there and looked up by
 * that token in CDP (`DOM.setFileInputFiles` needs a node). Only the top
 * document is reachable this way — an input inside an iframe takes the inline
 * `files` route instead, which runs in its own frame.
 */
async function uploadPaths(
  ctx: ToolContext,
  ref: string,
  paths: string[],
): Promise<unknown> {
  const token = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const marked = await runContentAction(ctx.tabId, { action: "uploadMark", ref, token });
  if (!marked.ok) return marked;
  try {
    const doc = await ctx.adapter.send<{ root: { nodeId: number } }>(
      ctx.tabId,
      "DOM.getDocument",
      { depth: 0 },
    );
    const found = await ctx.adapter.send<{ nodeId: number }>(ctx.tabId, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: `[data-ba-upload="${token}"]`,
    });
    if (!found.nodeId) {
      throw new Error(
        "the input is not in the top document (a file input inside an iframe) — pass files:[{name, text|base64}] instead of paths",
      );
    }
    await ctx.adapter.send(ctx.tabId, "DOM.setFileInputFiles", {
      files: paths,
      nodeId: found.nodeId,
    });
    // Verify the attach actually took. CDP reports success even for paths the
    // browser could not read — a real run "attached" a nonexistent
    // /root/Downloads/… file THREE times while the page saw nothing. A path the
    // browser cannot stat comes back as a 0-byte entry (or, once the page has
    // reset the input, as no entry at all), so both shapes fail loudly here.
    const readback = await runContentAction(ctx.tabId, { action: "filesOf", ref }).catch(
      () => null,
    );
    const data = readback?.data as
      | { count?: number; files?: { name: string; size: number }[] }
      | undefined;
    const count = data?.count;
    const empty = (data?.files ?? []).find((f) => f.size === 0);
    if (typeof count === "number" && (count !== paths.length || empty)) {
      const what = empty
        ? `${count} file(s), but ${empty.name} reads as 0 bytes`
        : `${count} of ${paths.length} file(s)`;
      return {
        ok: false,
        error:
          `${failureTag("input")}: the browser attached ${what} — it reads these paths itself, so they must exist on this machine exactly as written (a wrong Downloads directory is the usual culprit; a screenshot's real location is the absolute path in its save_to_disk result). ` +
          `To send a staged screenshot use paste_image — no disk, no paths; for content you hold, files:[{name, text|base64}].`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: `could not attach the file path(s): ${String((err as Error)?.message ?? err)} — the browser reads these paths itself, so they must exist on this machine; otherwise pass files:[{name, text|base64}]`,
    };
  } finally {
    await runContentAction(ctx.tabId, { action: "uploadMark", ref, token: "" }).catch(
      () => undefined,
    );
  }
  return {
    ok: true,
    data: { attached: paths.map((p) => ({ path: p })), via: "DOM.setFileInputFiles" },
  };
}

/**
 * The chooser-button flow. Some pages (Google Docs' "Upload from computer",
 * most styled uploaders) only create/reveal their file input when a button
 * opens the OS file picker — a native modal no tool can drive, and clicking
 * the button without help traps the run behind it. CDP can suppress the
 * dialog (Page.setInterceptFileChooserDialog), so: intercept → click the
 * trigger → the input now exists but no dialog does → set the files →
 * verify the attach took → ALWAYS disarm the interception, even on failure,
 * so the user's own future picker clicks are never silently swallowed.
 */
async function uploadViaTrigger(
  ctx: ToolContext,
  triggerRef: string,
  paths: string[],
): Promise<ActionResult> {
  const { adapter, tabId } = ctx;
  let intercepted = false;
  try {
    try {
      await adapter.send(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
      intercepted = true;
    } catch (err) {
      return {
        ok: false,
        error:
          `${failureTag("transport")}: this transport cannot suppress the OS file chooser ` +
          `(${String((err as Error)?.message ?? err)}) — the picker would open with no way to drive it. ` +
          `Attach to the file input's ref directly (hidden file inputs now have refs), or use paste_image via:'clipboard'.`,
      };
    }
    const clicked = await runContentAction(tabId, { action: "click", ref: triggerRef });
    if (!clicked.ok) return clicked;
    // A beat for the page to create/reveal its input in response to the click.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const doc = await adapter.send<{ root: { nodeId: number } }>(
      tabId,
      "DOM.getDocument",
      { depth: -1 },
    );
    const all = await adapter.send<{ nodeIds: number[] }>(tabId, "DOM.querySelectorAll", {
      nodeId: doc.root.nodeId,
      selector: "input[type=file]",
    });
    // Last in DOM order: the input a chooser click just created is appended
    // after any pre-existing ones.
    const nodeId = all.nodeIds?.[all.nodeIds.length - 1];
    if (!nodeId) {
      return {
        ok: false,
        error:
          `${failureTag("input")}: the chooser click produced no <input type="file"> in the top document — ` +
          `it may live in an iframe (snapshot the page and use that input's ref with upload), ` +
          `or the page uses a dropzone (use paste_image via:'clipboard').`,
      };
    }
    await adapter.send(tabId, "DOM.setFileInputFiles", { files: paths, nodeId });
    // Readback: CDP reports success even for paths the browser could not
    // read — verify the input's FileList, exactly like uploadPaths.
    const resolved = await adapter.send<{ object: { objectId: string } }>(
      tabId,
      "DOM.resolveNode",
      { nodeId },
    );
    const readback = await adapter.send<{ result: { value: unknown } }>(
      tabId,
      "Runtime.callFunctionOn",
      {
        objectId: resolved.object.objectId,
        functionDeclaration:
          "function(){ return Array.from(this.files ?? []).map((f) => ({ name: f.name, size: f.size })); }",
        returnByValue: true,
      },
    );
    const got = (readback?.result?.value ?? []) as { name: string; size: number }[];
    const empty = got.find((f) => f.size === 0);
    if (got.length !== paths.length || empty) {
      const what = empty
        ? `${got.length} file(s), but ${empty.name} reads as 0 bytes`
        : `${got.length} of ${paths.length} file(s)`;
      return {
        ok: false,
        error:
          `${failureTag("input")}: the browser attached ${what} — it reads these paths itself, so they ` +
          `must exist on this machine exactly as written (a wrong Downloads directory is the usual culprit).`,
      };
    }
    return {
      ok: true,
      data: {
        attached: got.map((f) => ({ path: f.name })),
        via: "intercepted file chooser + DOM.setFileInputFiles",
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `${failureTag("transport")}: the chooser-interception attach failed: ${String((err as Error)?.message ?? err)}`,
    };
  } finally {
    if (intercepted) {
      await adapter
        .send(tabId, "Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => undefined);
    }
  }
}

registerTool({
  name: "upload",
  description:
    "Attach file(s) from this device (or inline content) to the page. THREE targets: (1) `ref` of the file input — hidden file inputs now HAVE refs, so styled upload buttons' inputs are directly attachable; (2) `trigger_ref` of the button that opens the OS file picker (\"Upload from computer\") — the picker is suppressed via CDP and `paths` attach to the input the chooser targeted; (3) `files` for inline content you hold as text/base64 (needs `ref`, works in any frame). `paths` are absolute paths on this machine — the BROWSER reads them from disk (verified: a path it cannot read fails loudly). For SCREENSHOTS or viewed images use `paste_image` instead — staged bytes, no paths, no disk. SENSITIVE — confirmation required.",
  parameters: {
    type: "object",
    properties: {
      ...REF_PROP,
      trigger_ref: {
        type: "string",
        description:
          "Ref of the control that OPENS the file chooser (a styled Upload button). The click is intercepted — no OS dialog appears — and `paths` attach to the resulting input. Use with paths only.",
      },
      paths: {
        type: "array",
        description: "Absolute file paths to attach; the browser reads them from disk",
        items: { type: "string" },
      },
      files: {
        type: "array",
        description:
          "Inline files: [{name, mime?, text? | base64?}] — text for text files, base64 for binary",
        items: { type: "object" },
      },
    },
  },
  sensitive: true,
  async run(args, ctx) {
    const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : "";
    const triggerRef =
      typeof args.trigger_ref === "string" && args.trigger_ref.trim()
        ? args.trigger_ref.trim()
        : "";
    const paths = Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : [];
    const files = Array.isArray(args.files)
      ? (args.files as { name: string; mime?: string; text?: string; base64?: string }[])
      : [];
    if (!paths.length && !files.length) {
      return {
        ok: false,
        error: "nothing to attach — pass `files` (inline content) or `paths` (absolute paths)",
      };
    }
    if (!ref && !triggerRef) {
      return {
        ok: false,
        error: `${failureTag("input")}: upload needs a target — the file input's ref (hidden file inputs now have refs), or trigger_ref (the button that opens the OS chooser) together with paths`,
      };
    }
    if (triggerRef) {
      if (files.length) {
        return {
          ok: false,
          error: `${failureTag("input")}: trigger_ref attaches PATHS (the browser reads them from disk) — inline files need the file input's ref`,
        };
      }
      return uploadViaTrigger(ctx, triggerRef, paths);
    }
    const results: unknown[] = [];
    if (files.length) {
      results.push(await runContentAction(ctx.tabId, { action: "upload", ref, files }));
    }
    if (paths.length) {
      results.push(await uploadPaths(ctx, ref, paths));
    }
    const failed = results.find((r) => (r as ActionResult)?.ok === false) as
      | ActionResult
      | undefined;
    if (failed) return failed;
    return {
      attached: results.flatMap(
        (r) => ((r as ActionResult).data as { attached?: unknown[] })?.attached ?? [],
      ),
    };
  },
  present(payload) {
    const d = (payload ?? {}) as { attached?: { name?: string; path?: string }[] };
    const names = (d.attached ?? []).map((f) => f.name ?? f.path ?? "file");
    return { text: `attached ${names.length} file(s): ${names.join(", ")}` };
  },
});

registerTool({
  name: "read_page",
  description:
    "Extract visible text from the top document AND every iframe (lightweight; does not invalidate element refs). Each frame's text is labelled with its frame id and URL — use those ids with `evaluate_js frame:N` or as the `N#ref` prefix on action tools. Pass `ref` to read just one element's subtree (with `depth` to limit how deep the walk goes), and `max_chars` to cap output on long pages (a truncated read ends with a truncation note).",
  parameters: {
    type: "object",
    properties: {
      ...REF_PROP,
      depth: {
        type: "number",
        description: "With `ref`: how many levels below the element to read (default: whole subtree)",
      },
      max_chars: {
        type: "number",
        description: "Cap each read's text (default 50000); a truncated read says so",
      },
    },
  },
  async run(args, ctx) {
    const maxChars =
      typeof args.max_chars === "number" && args.max_chars > 0 ? args.max_chars : 50_000;
    // Scoped read: one element's subtree, through the content script that owns
    // the ref (works cross-origin, unlike a CDP evaluation).
    if (typeof args.ref === "string") {
      const ref = String(args.ref);
      const res = await runContentAction(ctx.tabId, {
        action: "readEl",
        ref,
        depth: typeof args.depth === "number" ? args.depth : undefined,
      });
      if (!res.ok) return res;
      const text = String((res.data as { text?: string })?.text ?? "");
      const pages = [
        {
          frameId: parseRef(ref).frameId,
          scopedTo: ref,
          href: "",
          title: "",
          text: truncateWithNote(text, maxChars, `read_page of ${ref}`),
          canvases: 0,
          textChars: text.length,
          instrumented: true,
        },
      ];
      // An empty read is the moment to LOOK: one screenshot rides back with it.
      const blindShot = text.trim()
        ? undefined
        : await captureBlindShot(ctx.adapter, ctx.tabId);
      return { pages, blindShot };
    }
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
    const pages = results.map((r) => {
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
        text: truncateWithNote(info?.text ?? "", maxChars, "read_page"),
        canvases: info?.canvases ?? 0,
        textChars: info?.textChars ?? 0,
        // A frame whose content script never ran returns null — that is NOT an
        // empty frame, and the distinction matters when deciding to retry.
        instrumented: info !== null,
      };
    });
    // Nothing readable anywhere is this tool being blind, not an empty page:
    // attach a screenshot so the model sees the state instead of guessing.
    const blindShot = pages.every((p) => !p.text.trim())
      ? await captureBlindShot(ctx.adapter, ctx.tabId)
      : undefined;
    return { pages, blindShot };
  },
  present(payload) {
    const p = payload as {
      pages: {
        frameId: number;
        href: string;
        text: string;
        canvases: number;
        textChars: number;
        instrumented: boolean;
        scopedTo?: string;
      }[];
      blindShot?: string;
    };
    const pages = p.pages ?? [];
    const body = pages
      .map((p) => {
        const head = p.scopedTo
          ? `--- ${p.scopedTo} ---`
          : `--- frame ${p.frameId} (${p.href || "no url"}) ---`;
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
    return {
      text: p.blindShot
        ? `${opaque ? `${body}\n\n${opaque}` : body}\n\n[The text tools see NOTHING on this page — a screenshot is attached. LOOK at it before concluding anything about the page.]`
        : opaque
          ? `${body}\n\n${opaque}`
          : body,
      image: p.blindShot,
    };
  },
});
