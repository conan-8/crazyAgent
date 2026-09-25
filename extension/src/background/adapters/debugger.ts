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

  constructor() {
    chrome.debugger.onDetach.addListener((source, reason) => {
      const tabId = (source as { tabId?: number }).tabId;
      if (tabId !== undefined && this.#attached.delete(tabId)) {
        // Enabled domains die with the session; forget them so a re-attach
        // re-enables Runtime (which is what keeps evaluate_js CSP-proof).
        for (const key of [...this.#enabled]) {
          if (key.startsWith(`${tabId}:`)) this.#enabled.delete(key);
        }
        for (const listener of this.#listeners) listener(tabId, reason);
      }
    });
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
