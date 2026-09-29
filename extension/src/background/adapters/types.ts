// The BrowserAdapter seam: both control modes expose the same surface, built
// on the same CDP commands. Standard mode = chrome.debugger; Unlimited mode =
// the native-messaging helper daemon (full CDP, no debug banner).
export interface BrowserAdapter {
  send<T>(tabId: number, method: string, params?: object): Promise<T>;
  /**
   * Like `send`, but enables `domain` on the session first (once per tab).
   * Required for commands whose behaviour only takes effect while their domain
   * is enabled — `Runtime.evaluate`'s CSP handling is the one that matters
   * here. Optional so a minimal adapter stays easy to implement.
   */
  sendEnabled?<T>(
    tabId: number,
    domain: string,
    method: string,
    params?: object,
  ): Promise<T>;
  /**
   * The default execution context id of the given scripting frame id, once the
   * Runtime domain has reported its contexts (via `sendEnabled`). Resolves to
   * null when the frame cannot be addressed at all — callers then fail the
   * evaluation with guidance rather than silently running in the wrong
   * document. May need round trips (the DOM-stamp join probes contexts).
   * Optional so minimal adapters stay simple.
   */
  contextIdForFrame?(
    tabId: number,
    frameId: number,
  ): Promise<number | null> | number | null;
  screenshot(tabId: number): Promise<{ dataUrl: string }>;
  /**
   * Subscribe to raw CDP events with a RESOLVED tab id — what console/network
   * capture needs. Optional: an adapter without it simply yields no captured
   * entries, and the read tools say so instead of returning a fake empty log.
   */
  onTabEvent?(listener: (tabId: number, method: string, params: unknown) => void): () => void;
  /** Network interception (Unlimited mode only). */
  intercept?(
    tabId: number,
    params: Record<string, unknown>,
  ): Promise<unknown>;
}
