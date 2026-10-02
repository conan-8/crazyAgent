// paste_image — deliver a staged capture (the image shelf) INTO a page:
// attach it to a file input, dispatch a synthetic paste/drop carrying the
// image File, or write the OS clipboard and send a trusted Ctrl+V. This is the
// "screenshot here → send it to the chat app there" pipe: bytes flow
// background → content script directly, never through the model's context
// (a base64 JPEG in a tool argument is ~500k tokens of pure cost), and never
// through a guessed disk path (the silent DOM.setFileInputFiles failure that
// burned a real run three uploads in a row).
//
// Route map:
//   via:"file"      → the existing content-script DataTransfer upload
//                     (works in any frame, incl. hidden inputs like Kimi's)
//   via:"paste"     → synthetic ClipboardEvent("paste") (+ DragEvent("drop")
//                     fallback in auto) — what chat composers listen for
//   via:"clipboard" → offscreen-document OS-clipboard write + trusted Ctrl+V
//                     through the CDP input pipeline (for apps that reject
//                     untrusted events)
//   via:"auto"      → file input targets attach; everything else gets paste
import type { ActionResult } from "../../content/actions";
import { safeBasename } from "../../shared/filenames";
import { failureTag } from "../../shared/tool-failure";
import { keyEventParams, parseKeyCombo } from "../../shared/trusted-input";
import { writeImageToClipboard } from "../clipboard";
import { getShelfImage } from "../shelf";
import { runContentAction } from "./content-action";
import { ensureTabActive } from "./trusted-input";
import { registerTool } from "./types";

interface PastePayload {
  route: string;
  file?: { name: string; size?: number; type?: string };
  events?: string[];
  handled?: boolean;
  targetTag?: string;
  keySent?: boolean;
  note?: string;
}

registerTool({
  name: "paste_image",
  description:
    "Deliver a staged image (any screenshot/view_image capture — they stage themselves as shot_N) INTO the current page: into a chat composer or dropzone as a paste (default), onto an <input type=\"file\"> ref as a proper attachment, or — via:'clipboard' — through the real OS clipboard plus a trusted Ctrl+V for apps that ignore synthetic events. The bytes never pass through your context and never touch disk. No ref = whatever the page has focused (click the composer first). Verify the app accepted it from the result (handled) and the next observation — do NOT re-capture or re-send blindly.",
  parameters: {
    type: "object",
    properties: {
      image: {
        type: "string",
        description: "Shelf id from a screenshot/view_image result, e.g. 'shot_3' (default: the most recent capture)",
      },
      ref: {
        type: "string",
        description: "Target element ref: a file input, a composer, or a dropzone. Omit for the currently focused element",
      },
      via: {
        type: "string",
        description: "'auto' (default) | 'paste' (synthetic paste/drop events) | 'file' (attach to an <input type=\"file\">) | 'clipboard' (OS clipboard + trusted Ctrl+V)",
      },
      send_key: {
        type: "boolean",
        description: "With via:'clipboard': also send Ctrl+V to the page (default true); false only fills the clipboard",
      },
      filename: {
        type: "string",
        description: "File name the page sees (default: the staged capture's name)",
      },
    },
  },
  sensitive: true,
  async run(args, ctx): Promise<ActionResult | PastePayload> {
    const wanted = typeof args.image === "string" && args.image.trim() ? args.image.trim() : undefined;
    const entry = await getShelfImage(wanted);
    if (!entry) {
      return {
        ok: false,
        error: `${failureTag("input")}: ${wanted ? `no staged image "${wanted}"` : "the image shelf is empty"} — take a screenshot first (every capture stages itself as shot_N and its result names the id), then paste_image it.`,
      };
    }
    const name =
      typeof args.filename === "string" && args.filename.trim()
        ? safeBasename(args.filename, "image").replace(/^$/, entry.name)
        : entry.name;
    const comma = entry.dataUrl.indexOf(",");
    const base64 = comma >= 0 ? entry.dataUrl.slice(comma + 1) : entry.dataUrl;
    const files = [{ name, mime: entry.mime, base64 }];
    const via = String(args.via ?? "auto").toLowerCase();
    const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : undefined;

    if (via === "clipboard") {
      const wrote = await writeImageToClipboard(entry.dataUrl);
      if (!wrote.ok) {
        return {
          ok: false,
          error: `${failureTag("tool")}: OS clipboard write failed: ${wrote.error} — retry ONCE with via:'paste' (synthetic paste event into the focused composer), or attach to an <input type="file"> ref with via:'file'. Do not keep retrying the clipboard.`,
        };
      }
      let keySent = false;
      if (args.send_key !== false) {
        await ensureTabActive(ctx.tabId, ctx.adapter);
        const parsed = parseKeyCombo("Control+v");
        if (parsed.ok) {
          try {
            await ctx.adapter.send(ctx.tabId, "Input.dispatchKeyEvent", keyEventParams(parsed.parsed, "down"));
            await ctx.adapter.send(ctx.tabId, "Input.dispatchKeyEvent", keyEventParams(parsed.parsed, "up"));
            keySent = true;
          } catch (err) {
            return {
              ok: false,
              error: `${failureTag("transport")}: the image is ON the OS clipboard, but sending Ctrl+V failed: ${String((err as Error)?.message ?? err)} — send \`key Control+v\` yourself once the target is focused, or use via:'paste'.`,
            };
          }
        }
      }
      return {
        route: "clipboard",
        file: { name, type: entry.mime },
        keySent,
        note: keySent
          ? "the image was written to the OS clipboard and a trusted Ctrl+V went to the focused element — LOOK at the next observation to confirm the app accepted it"
          : "the image is on the OS clipboard — focus the target and send `key Control+v` (trusted)",
      } satisfies PastePayload;
    }

    if (via === "file") {
      if (!ref) {
        return {
          ok: false,
          error: `${failureTag("input")}: via:'file' needs the ref of an <input type="file"> (find it in a snapshot) — or omit via to paste into the focused composer/dropzone.`,
        };
      }
      const res = await runContentAction(ctx.tabId, { action: "upload", ref, files });
      if (!res.ok) return res;
      const attached = ((res.data as { attached?: { name: string; size: number; type: string }[] })?.attached ?? [])[0];
      return {
        route: "file",
        file: attached ?? { name },
        handled: true,
        targetTag: "input",
        note: "attached to the file input with real input/change events",
      } satisfies PastePayload;
    }

    // auto | paste — the content action resolves the target (ref or
    // activeElement), delegates file inputs to the DataTransfer upload, and
    // falls back to a drop event when no paste handler consumed the image.
    const res = await runContentAction(ctx.tabId, {
      action: "pasteFiles",
      ref,
      files,
      mode: via === "paste" ? "paste" : "auto",
    });
    if (!res.ok) return res;
    const d = (res.data ?? {}) as {
      route?: string;
      events?: string[];
      handled?: boolean;
      targetTag?: string;
      files?: { name: string; size: number; type: string }[];
    };
    const notes: string[] = [];
    if (d.handled) {
      notes.push("a page handler consumed the event (defaultPrevented) — the app should be showing the attachment; verify in the next observation");
    } else {
      notes.push("WARNING: no handler consumed the paste — the app may ignore synthetic events; retry ONCE with via:'clipboard' (real OS clipboard + trusted Ctrl+V) after focusing the composer, or find an <input type=\"file\"> ref and use via:'file'");
    }
    return {
      route: d.route ?? "paste",
      events: d.events,
      handled: d.handled === true,
      targetTag: d.targetTag,
      file: d.files?.[0] ?? { name },
      note: notes.join("; "),
    } satisfies PastePayload;
  },
  present(payload) {
    const p = (payload ?? {}) as PastePayload;
    if (!p.route) return { text: JSON.stringify(payload ?? {}) };
    const file = p.file ? `${p.file.name}${p.file.size ? ` (${p.file.size} bytes)` : ""}` : "the staged image";
    const bits = [
      `pasted ${file} into the page via the ${p.route} route`,
      p.targetTag ? `target: <${p.targetTag}>` : null,
      p.events?.length ? `events: ${p.events.join(" + ")}` : null,
      p.route === "clipboard" ? (p.keySent ? "trusted Ctrl+V sent" : "clipboard filled, key not sent") : null,
      p.handled === undefined ? null : p.handled ? "a page handler consumed it" : "NOT consumed by any handler",
      p.note ?? null,
    ].filter(Boolean);
    return { text: bits.join(" — ") };
  },
});
