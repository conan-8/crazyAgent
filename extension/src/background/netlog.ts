// Console + network capture (both control modes).
//
// Claude in Chrome can read console output and network traffic; this closes
// that gap. The adapters already forward raw CDP events (`onTabEvent`), so the
// capture is just a per-tab ring buffer fed by Runtime/Log/Network events.
//
// Honest limit, stated in the tools' descriptions too: capture starts when a
// run starts (or when a read tool is first called), so messages emitted before
// that — including the page's own boot log — are not in the buffer. And in
// Standard mode, traffic of out-of-process iframes may not reach the tab's
// session at all. Neither is worked around; both are reported as what they are.

export interface ConsoleEntry {
  ts: number;
  level: string;
  text: string;
  url?: string;
  line?: number;
}

export interface NetEntry {
  ts: number;
  method: string;
  url: string;
  status?: number;
  mime?: string;
  ok?: boolean;
  error?: string;
}

export const NETLOG_MAX = 500;

type EventListener = (tabId: number, method: string, params: unknown) => void;

interface SubscribableAdapter {
  onTabEvent?(listener: EventListener): () => void;
}

function argText(args: { value?: unknown; description?: unknown }[] | undefined): string {
  return (args ?? [])
    .map((a) => {
      if (a.value !== undefined) {
        return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
      }
      return String(a.description ?? "");
    })
    .join(" ");
}

function push<T>(list: T[], entry: T): void {
  list.push(entry);
  if (list.length > NETLOG_MAX) list.splice(0, list.length - NETLOG_MAX);
}

/**
 * Per-tab console/network buffers. Pure with respect to Chrome APIs (events
 * arrive through `handle`), which is what makes it unit-testable.
 */
export class NetLog {
  #console = new Map<number, ConsoleEntry[]>();
  #network = new Map<number, NetEntry[]>();
  /** requestId → the request half of an in-flight exchange. */
  #inflight = new Map<string, NetEntry>();
  #unsub = new Map<SubscribableAdapter, () => void>();

  /**
   * Subscribe to an adapter's CDP events once and enable the domains capture
   * needs. Safe to call repeatedly.
   */
  async start(
    tabId: number,
    adapter: SubscribableAdapter & {
      sendEnabled?: <T>(tabId: number, domain: string, method: string, params?: object) => Promise<T>;
      send?: <T>(tabId: number, method: string, params?: object) => Promise<T>;
    },
  ): Promise<void> {
    if (!this.#unsub.has(adapter) && adapter.onTabEvent) {
      this.#unsub.set(adapter, adapter.onTabEvent((id, method, params) => this.handle(id, method, params)));
    }
    const enable = async (domain: string): Promise<void> => {
      try {
        if (adapter.sendEnabled) {
          await adapter.sendEnabled(tabId, domain, `${domain}.enable`, {});
        } else if (adapter.send) {
          await adapter.send(tabId, `${domain}.enable`, {});
        }
      } catch {
        // A domain that will not enable simply yields no entries; the read
        // tools say "nothing captured" rather than pretending the page is clean.
      }
    };
    await enable("Runtime");
    await enable("Log");
    await enable("Network");
  }

  handle(tabId: number, method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const type = String(p.type ?? "log");
        const stack = (p.stackTrace ?? {}) as {
          callFrames?: { url?: string; lineNumber?: number }[];
        };
        const frame = stack.callFrames?.[0];
        push(this.#consoleList(tabId), {
          ts: Date.now(),
          level: type,
          text: argText(p.args as { value?: unknown; description?: unknown }[]),
          url: frame?.url,
          line: frame?.lineNumber,
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const d = (p.exceptionDetails ?? {}) as {
          text?: string;
          exception?: { description?: string };
          url?: string;
          lineNumber?: number;
        };
        push(this.#consoleList(tabId), {
          ts: Date.now(),
          level: "error",
          text: String(d.exception?.description ?? d.text ?? "uncaught exception").slice(0, 2_000),
          url: d.url,
          line: d.lineNumber,
        });
        return;
      }
      case "Log.entryAdded": {
        const e = (p.entry ?? {}) as {
          source?: string;
          level?: string;
          text?: string;
          url?: string;
          lineNumber?: number;
        };
        push(this.#consoleList(tabId), {
          ts: Date.now(),
          level: String(e.level ?? e.source ?? "log"),
          text: String(e.text ?? "").slice(0, 2_000),
          url: e.url,
          line: e.lineNumber,
        });
        return;
      }
      case "Network.requestWillBeSent": {
        const req = (p.request ?? {}) as { method?: string; url?: string };
        this.#inflight.set(String(p.requestId ?? ""), {
          ts: Date.now(),
          method: String(req.method ?? "GET"),
          url: String(req.url ?? ""),
        });
        return;
      }
      case "Network.responseReceived": {
        const res = (p.response ?? {}) as {
          status?: number;
          mimeType?: string;
          url?: string;
        };
        const entry = this.#inflight.get(String(p.requestId ?? ""));
        if (entry) {
          this.#inflight.delete(String(p.requestId ?? ""));
          push(this.#networkList(tabId), {
            ...entry,
            status: typeof res.status === "number" ? res.status : undefined,
            mime: res.mimeType,
            ok: (res.status ?? 0) < 400,
          });
        }
        return;
      }
      case "Network.loadingFailed": {
        const entry = this.#inflight.get(String(p.requestId ?? ""));
        this.#inflight.delete(String(p.requestId ?? ""));
        push(
          this.#networkList(tabId),
          entry
            ? { ...entry, ok: false, error: String(p.errorText ?? "failed") }
            : {
                ts: Date.now(),
                method: "?",
                url: String(p.blockedReason ?? ""),
                ok: false,
                error: String(p.errorText ?? "failed"),
              },
        );
        return;
      }
      default:
        return;
    }
  }

  readConsole(tabId: number, opts: { level?: string; limit?: number } = {}): ConsoleEntry[] {
    let out = this.#consoleList(tabId);
    if (opts.level) {
      const want = opts.level.toLowerCase();
      out = out.filter((e) => e.level.toLowerCase() === want);
    }
    return opts.limit ? out.slice(-opts.limit) : out;
  }

  readNetwork(
    tabId: number,
    opts: { urlFilter?: string; limit?: number } = {},
  ): NetEntry[] {
    let out = this.#networkList(tabId);
    if (opts.urlFilter) {
      const needle = opts.urlFilter.toLowerCase();
      out = out.filter((e) => e.url.toLowerCase().includes(needle));
    }
    return opts.limit ? out.slice(-opts.limit) : out;
  }

  clear(tabId: number): void {
    this.#console.delete(tabId);
    this.#network.delete(tabId);
    this.#inflight.clear();
  }

  #consoleList(tabId: number): ConsoleEntry[] {
    let list = this.#console.get(tabId);
    if (!list) {
      list = [];
      this.#console.set(tabId, list);
    }
    return list;
  }

  #networkList(tabId: number): NetEntry[] {
    let list = this.#network.get(tabId);
    if (!list) {
      list = [];
      this.#network.set(tabId, list);
    }
    return list;
  }
}

export const netlog = new NetLog();
