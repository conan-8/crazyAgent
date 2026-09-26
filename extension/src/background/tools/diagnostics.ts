// Read-only diagnostics: the page's console and its network traffic.
//
// Claude in Chrome can read both; these close that gap. Capture starts when a
// run starts (and when either tool is first called), and only for what arrived
// after that — the tools say so in their descriptions and never present an
// empty buffer as "the page logged nothing".
import { netlog } from "../netlog";
import type { ToolContext } from "./types";
import { registerTool } from "./types";

/** Subscribe + enable the domains capture needs. Idempotent per adapter. */
export async function startNetlogCapture(
  tabId: number,
  adapter: ToolContext["adapter"],
): Promise<void> {
  await netlog.start(tabId, adapter);
}

const CAPTURE_NOTE =
  "Only what arrived since capture started (at run start) is listed — earlier output is not retrievable.";

registerTool({
  name: "console_read",
  description:
    `Read what the page has logged to the console (log/warn/error, uncaught exceptions, browser log entries), newest last. ${CAPTURE_NOTE} Use after a page misbehaves instead of guessing.`,
  parameters: {
    type: "object",
    properties: {
      level: {
        type: "string",
        description: "Filter by level: log, info, warning, error, debug (omit for all)",
      },
      limit: { type: "number", description: "Return at most this many, newest last (default 50)" },
      clear: { type: "boolean", description: "Clear the buffer after reading" },
    },
  },
  async run(args, ctx) {
    await startNetlogCapture(ctx.tabId, ctx.adapter);
    const entries = netlog.readConsole(ctx.tabId, {
      level: typeof args.level === "string" ? args.level : undefined,
      limit: typeof args.limit === "number" ? args.limit : 50,
    });
    if (args.clear === true) netlog.clear(ctx.tabId);
    return { entries, note: CAPTURE_NOTE };
  },
  present(payload) {
    const d = (payload ?? {}) as {
      entries?: { level: string; text: string; url?: string; line?: number }[];
      note?: string;
    };
    const entries = d.entries ?? [];
    if (!entries.length) {
      return { text: `(no console entries captured — ${d.note ?? ""})` };
    }
    return {
      text: entries
        .map((e) => `[${e.level}] ${e.text}${e.url ? ` (${e.url}:${(e.line ?? 0) + 1})` : ""}`)
        .join("\n"),
    };
  },
});

registerTool({
  name: "network_read",
  description:
    `Read the requests this tab has made and their status (method, URL, status, type), newest last. ${CAPTURE_NOTE} Read-only — mocking/rewriting traffic stays a separate, Unlimited-mode capability.`,
  parameters: {
    type: "object",
    properties: {
      url_filter: {
        type: "string",
        description: "Only URLs containing this substring (case-insensitive)",
      },
      limit: { type: "number", description: "Return at most this many, newest last (default 50)" },
      clear: { type: "boolean", description: "Clear the buffer after reading" },
    },
  },
  async run(args, ctx) {
    await startNetlogCapture(ctx.tabId, ctx.adapter);
    const entries = netlog.readNetwork(ctx.tabId, {
      urlFilter: typeof args.url_filter === "string" ? args.url_filter : undefined,
      limit: typeof args.limit === "number" ? args.limit : 50,
    });
    if (args.clear === true) netlog.clear(ctx.tabId);
    return { entries, note: CAPTURE_NOTE };
  },
  present(payload) {
    const d = (payload ?? {}) as {
      entries?: { method: string; url: string; status?: number; ok?: boolean; error?: string }[];
      note?: string;
    };
    const entries = d.entries ?? [];
    if (!entries.length) {
      return { text: `(no requests captured — ${d.note ?? ""})` };
    }
    return {
      text: entries
        .map((e) => `${e.method} ${e.url} → ${e.ok === false ? `FAILED (${e.error ?? "?"})` : e.status ?? "?"}`)
        .join("\n"),
    };
  },
});
