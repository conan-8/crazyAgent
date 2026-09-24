// The BrowserAdapter seam: both control modes expose the same surface, built
// on the same CDP commands. Standard mode = chrome.debugger; Unlimited mode =
// the native-messaging helper daemon (full CDP, no debug banner).
export interface BrowserAdapter {
  send<T>(tabId: number, method: string, params?: object): Promise<T>;
  screenshot(tabId: number): Promise<{ dataUrl: string }>;
  /** Network interception (Unlimited mode only). */
  intercept?(
    tabId: number,
    params: Record<string, unknown>,
  ): Promise<unknown>;
}
