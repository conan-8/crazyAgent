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
  #listeners = new Set<DetachListener>();

  constructor() {
    chrome.debugger.onDetach.addListener((source, reason) => {
      const tabId = (source as { tabId?: number }).tabId;
      if (tabId !== undefined && this.#attached.delete(tabId)) {
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

  /** JPEG screenshot as a data URL. */
  async screenshot(tabId: number): Promise<{ dataUrl: string }> {
    const res = await this.send<{ data: string }>(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
    });
    return { dataUrl: `data:image/jpeg;base64,${res.data}` };
  }
}
