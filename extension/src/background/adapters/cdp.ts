// Unlimited-mode transport: bridges to the native-messaging helper daemon,
// which speaks full CDP to the browser (launched with --remote-debugging-port
// on a dedicated profile). chrome.debugger is never touched, so no debug
// banner appears. Tab→target resolution matches by URL (documented v1 limit).
import type { BrowserAdapter } from "./types";

interface RpcReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Set on unsolicited daemon→extension pushes (CDP events). */
  event?: string;
}

/** One forwarded CDP event (see `CdpAdapter.onCdpEvent`). */
export interface CdpEvent {
  targetId: string;
  method: string;
  params: unknown;
}

/** The daemon answered — with an application-level failure. Never retried. */
class RpcRemoteError extends Error {}
/** Transport failure (dead port, spawn issues). Reset + retry, respawning. */
class RpcTransportError extends Error {}

export class CdpAdapter implements BrowserAdapter {
  #native: chrome.runtime.Port | null = null;
  #pending = new Map<number, (reply: RpcReply) => void>();
  #nextId = 1;
  #cdpPort = 0;
  #targets = new Map<number, string>(); // tabId → CDP targetId
  /** `${targetId}:${domain}` pairs already enabled on this connection. */
  #enabled = new Set<string>();
  #eventListeners = new Set<(event: CdpEvent) => void>();

  /** Subscribe to forwarded CDP events (execution contexts, etc.). */
  onCdpEvent(listener: (event: CdpEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  async connect(cdpPort: number): Promise<void> {
    this.#cdpPort = cdpPort;
    if (this.#native) return;
    await new Promise<void>((resolve, reject) => {
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connectNative("browser_agent_helper");
      } catch (err) {
        reject(new Error(`helper daemon not installed: ${String(err)} — run helper/install.sh`));
        return;
      }
      this.#native = port;
      // The daemon says hello on start; that doubles as channel readiness.
      let helloResolve: (() => void) | null = null;
      const hello = new Promise<void>((res) => (helloResolve = res));
      const helloTimer = setTimeout(
        () => reject(new Error("helper daemon did not send its hello frame")),
        10_000,
      );
      port.onMessage.addListener((msg: RpcReply) => {
        if (msg.id === 0) {
          // Unsolicited pushes share id 0 with the hello frame.
          if (msg.event === "cdp") {
            for (const listener of this.#eventListeners) listener(msg.result as CdpEvent);
            return;
          }
          clearTimeout(helloTimer);
          helloResolve?.();
          return;
        }
        const waiter = this.#pending.get(msg.id);
        if (waiter) {
          this.#pending.delete(msg.id);
          waiter(msg);
        }
      });
      port.onDisconnect.addListener(() => {
        const reason =
          chrome.runtime.lastError?.message ?? "helper daemon disconnected";
        this.#native = null;
        clearTimeout(helloTimer);
        helloResolve?.();
        for (const [, waiter] of this.#pending) {
          waiter({ id: -1, ok: false, error: `transport: ${reason}` });
        }
        this.#pending.clear();
      });
      void hello.then(async () => {
        try {
          await this.#rpc("attach", { port: cdpPort });
          this.#targets.clear();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * RPC with self-healing: transport failures (dead port, host crash) force a
   * fresh native connection — which respawns the daemon — and retry. Remote
   * application errors surface immediately.
   */
  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.#native) await this.connect(this.#cdpPort);
      try {
        return await this.#post(method, params);
      } catch (err) {
        if (err instanceof RpcRemoteError) throw err;
        lastError = err as Error;
        this.#native = null; // next attempt respawns the daemon
        this.#targets.clear();
      }
    }
    throw lastError ?? new Error("helper RPC failed");
  }

  #post(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcTransportError(`helper RPC timeout: ${method}`));
      }, 35_000);
      this.#pending.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.ok) resolve(reply.result);
        else if (String(reply.error).startsWith("transport:")) {
          reject(new RpcTransportError(reply.error ?? "transport failure"));
        } else {
          reject(new RpcRemoteError(reply.error ?? "helper RPC failed"));
        }
      });
      const payload = { id, method, params };
      const tryPost = (attempt: number) => {
        const port = this.#native;
        if (!port) return; // disconnect handler rejects outstanding ids
        try {
          port.postMessage(payload);
        } catch (err) {
          if (attempt >= 30) {
            clearTimeout(timer);
            this.#pending.delete(id);
            reject(new RpcTransportError(String(err)));
          } else {
            setTimeout(() => tryPost(attempt + 1), 250);
          }
        }
      };
      tryPost(0);
    });
  }

  async #targetFor(tabId: number): Promise<string> {
    const cached = this.#targets.get(tabId);
    if (cached) return cached;
    const tab = await chrome.tabs.get(tabId);
    const targets = (await this.#rpc("targets", {})) as {
      targetId: string;
      type: string;
      url: string;
    }[];
    const match =
      targets.find((t) => t.type === "page" && t.url === tab.url) ??
      targets.find((t) => t.type === "page");
    if (!match) throw new Error(`no CDP target for tab ${tabId} (${tab.url})`);
    this.#targets.set(tabId, match.targetId);
    return match.targetId;
  }

  async send<T>(tabId: number, method: string, params?: object): Promise<T> {
    const targetId = await this.#targetFor(tabId);
    return this.#rpc("cdp", {
      targetId,
      cdpMethod: method,
      cdpParams: params ?? {},
    }) as Promise<T>;
  }

  /**
   * Like `send`, but enabled once per target. `Runtime.enable` is what makes
   * `Runtime.evaluate`'s CSP handling take effect (`allowUnsafeEvalBlockedByCSP`
   * is only honoured once the domain reports execution contexts), so the
   * evaluate path goes through here. Best-effort: a domain we cannot enable
   * must not fail the command that follows it.
   */
  async sendEnabled<T>(
    tabId: number,
    domain: string,
    method: string,
    params?: object,
  ): Promise<T> {
    const targetId = await this.#targetFor(tabId);
    const key = `${targetId}:${domain}`;
    if (!this.#enabled.has(key)) {
      this.#enabled.add(key);
      try {
        await this.#rpc("cdp", {
          targetId,
          cdpMethod: `${domain}.enable`,
          cdpParams: {},
        });
      } catch {
        this.#enabled.delete(key);
      }
    }
    return this.send<T>(tabId, method, params);
  }

  async screenshot(tabId: number): Promise<{ dataUrl: string }> {
    const res = await this.send<{ data: string }>(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
    });
    return { dataUrl: `data:image/jpeg;base64,${res.data}` };
  }

  async intercept(
    tabId: number,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const targetId = await this.#targetFor(tabId);
    return this.#rpc("intercept", { targetId, ...params });
  }

  /** Drop cached state (e.g. after a navigation or daemon restart). */
  reset(): void {
    this.#targets.clear();
  }
}
