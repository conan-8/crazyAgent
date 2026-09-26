// Chrome Debugger (CDP) adapter — the Standard-mode transport. Wraps
// chrome.debugger attach/detach and sendCommand with lifecycle tracking and
// error classification (incl. the Chrome 155+ enterprise policy rejections).

export type DetachListener = (tabId: number, reason: string) => void;

/** Attach failures that policy makes permanent (Chrome 155+ managed browsers). */
export const POLICY_ERROR_SNIPPETS = [
  "Host access is restricted by policy.",
  "Screenshot capture is restricted by policy.",
] as const;

export class DebuggerAttachError extends Error {
  constructor(
    message: string,
    readonly policyBlocked: boolean,
  ) {
    super(message);
    this.name = "DebuggerAttachError";
  }
}

export class DebuggerAdapter {
  #attached = new Set<number>();
  /** `${tabId}:${domain}` pairs already enabled on this session. */
  #enabled = new Set<string>();
  #listeners = new Set<DetachListener>();
  /** Per-tab execution contexts: contextId (string key) → CDP frameId (hex). */
  #contexts = new Map<number, Map<string, string>>();
  #eventListeners = new Set<(tabId: number, method: string, params: unknown) => void>();
  /**
   * The join between the id space the AGENT sees and the one CDP uses.
   *
   * chrome.scripting reports frames as small integers (0, 9, 17 … — NOT
   * sequential: a second frame came back as 9 in testing), and refs are built
   * from those. CDP identifies frames by 32-hex-char strings, and its execution
   * contexts carry only the CDP form. The two are unrelated, so neither can be
   * derived from the other; the frames tool hands us the URL-paired lists and we
   * match on URL, which is the only key both sides share.
   */
  #framesByUrl = new Map<number, Map<string, number>>();
  #cdpFramesByUrl = new Map<number, Map<string, string>>();

  constructor() {
    chrome.debugger.onDetach.addListener((source, reason) => {
      const tabId = (source as { tabId?: number }).tabId;
      if (tabId !== undefined && this.#attached.delete(tabId)) {
        // Enabled domains die with the session; forget them so a re-attach
        // re-enables Runtime (which is what keeps evaluate_js CSP-proof).
        for (const key of [...this.#enabled]) {
          if (key.startsWith(`${tabId}:`)) this.#enabled.delete(key);
        }
        this.#contexts.delete(tabId);
        this.#framesByUrl.delete(tabId);
        this.#cdpFramesByUrl.delete(tabId);
        for (const listener of this.#listeners) listener(tabId, reason);
      }
    });
    // Execution contexts are how a frame becomes addressable for evaluation.
    chrome.debugger.onEvent.addListener((source, method, params) => {
      const tabId = (source as { tabId?: number }).tabId;
      if (tabId === undefined) return;
      this.#trackContext(tabId, method, params);
      for (const listener of this.#eventListeners) listener(tabId, method, params);
    });
  }

  #trackContext(tabId: number, method: string, params: unknown): void {
    const p = params as {
      context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } };
    };
    if (method === "Runtime.executionContextsCleared") {
      this.#contexts.delete(tabId);
      return;
    }
    if (method !== "Runtime.executionContextCreated") return;
    const id = p.context?.id;
    const cdpFrameId = p.context?.auxData?.frameId;
    // Only the default context of a frame is a useful evaluation target.
    if (id === undefined || !cdpFrameId || p.context?.auxData?.isDefault === false) return;
    const byId = this.#contexts.get(tabId) ?? new Map<string, string>();
    byId.set(String(id), cdpFrameId);
    this.#contexts.set(tabId, byId);
  }

  /**
   * Record the tab's frames in BOTH id spaces, paired by URL. The frames tool
   * collects `chrome.scripting` frame ids and the CDP frame tree together and
   * passes them here, because URL is the only key the two spaces share (their
   * ids are unrelated — verified: scripting reported frame `9` where CDP used a
   * 32-hex id).
   */
  mapFrames(
    tabId: number,
    pairs: { url: string; scriptingFrameId: number; cdpFrameId: string }[],
  ): void {
    const byUrl = new Map<string, number>();
    const cdpByUrl = new Map<string, string>();
    for (const { url, scriptingFrameId, cdpFrameId } of pairs) {
      if (url) byUrl.set(url, scriptingFrameId);
      if (url) cdpByUrl.set(url, cdpFrameId);
    }
    this.#framesByUrl.set(tabId, byUrl);
    this.#cdpFramesByUrl.set(tabId, cdpByUrl);
  }

  /** The CDP frameId behind a scripting frameId, by way of the frame's URL. */
  cdpFrameIdFor(tabId: number, scriptingFrameId: number): string | null {
    const byUrl = this.#framesByUrl.get(tabId);
    const cdpByUrl = this.#cdpFramesByUrl.get(tabId);
    if (!byUrl || !cdpByUrl) return null;
    for (const [url, id] of byUrl) {
      if (id === scriptingFrameId) return cdpByUrl.get(url) ?? null;
    }
    return null;
  }

  /** Subscribe to raw CDP events for a tab. */
  onCdpEvent(
    listener: (tabId: number, method: string, params: unknown) => void,
  ): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** BrowserAdapter's tab-resolved event subscription (same stream here). */
  onTabEvent(
    listener: (tabId: number, method: string, params: unknown) => void,
  ): () => void {
    return this.onCdpEvent(listener);
  }

  /**
   * The default execution context id of the frame with this scripting frameId,
   * or null when it cannot be resolved yet. Requires `Runtime.enable` first —
   * `sendEnabled` does that on the evaluate path.
   */
  contextIdForFrame(tabId: number, frameId: number): number | null {
    if (frameId === 0) return null; // main frame = the default context
    const cdpFrameId = this.cdpFrameIdFor(tabId, frameId);
    if (!cdpFrameId) return null;
    let newest: number | null = null;
    for (const [contextId, owningFrame] of this.#contexts.get(tabId) ?? []) {
      // A frame can be re-created by navigation; the highest id is the live one.
      if (owningFrame === cdpFrameId) newest = Math.max(newest ?? -1, Number(contextId));
    }
    return newest;
  }

  onDetach(listener: DetachListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isAttached(tabId: number): boolean {
    return this.#attached.has(tabId);
  }

  async attach(tabId: number): Promise<void> {
    if (this.#attached.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      this.#attached.add(tabId);
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      throw new DebuggerAttachError(
        message,
        POLICY_ERROR_SNIPPETS.some((snippet) => message.includes(snippet)),
      );
    }
  }

  async detach(tabId: number): Promise<void> {
    if (!this.#attached.delete(tabId)) return;
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // already detached (e.g. tab closed) — fine
    }
  }

  async send<T>(tabId: number, method: string, params?: object): Promise<T> {
    await this.attach(tabId);
    return (await chrome.debugger.sendCommand(
      { tabId },
      method,
      params,
    )) as T;
  }

  /**
   * Like `send`, but enabled once per tab. Some domains only apply their
   * settings while they are enabled — notably `Runtime`, whose CSP handling
   * for `Runtime.evaluate` is installed by `Runtime.enable`. Enabling is
   * idempotent on the browser side and this is best-effort: a domain that
   * cannot be enabled must not fail the command that follows it.
   */
  async sendEnabled<T>(
    tabId: number,
    domain: string,
    method: string,
    params?: object,
  ): Promise<T> {
    const key = `${tabId}:${domain}`;
    if (!this.#enabled.has(key)) {
      this.#enabled.add(key);
      try {
        await this.send(tabId, `${domain}.enable`, {});
      } catch {
        this.#enabled.delete(key); // let the next call try again
      }
    }
    return this.send<T>(tabId, method, params);
  }

  /** JPEG screenshot as a data URL. */
  async screenshot(tabId: number): Promise<{ dataUrl: string }> {
    const res = await this.send<{ data: string }>(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
    });
    return { dataUrl: `data:image/jpeg;base64,${res.data}` };
  }
}
