// Page-settle detector: resolves when the DOM has been quiet and no network
// resources have been fetched for `quietMs`, bounded by a hard timeout.

export interface SettleResult {
  settled: boolean;
  reason: string;
  elapsedMs: number;
}

export function waitForSettle(
  timeoutMs = 15_000,
  quietMs = 500,
): Promise<SettleResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let lastMutation = started;
    let lastResource = started;

    const mo = new MutationObserver(() => {
      lastMutation = Date.now();
    });
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver(() => {
        lastResource = Date.now();
      });
      // Resource timing is per-document, so page fetch/XHR are visible here
      // even though this runs in the isolated world.
      po.observe({ type: "resource", buffered: true });
    } catch {
      po = null; // not critical — DOM quiet alone is a usable signal
    }

    const poll = setInterval(() => {
      const now = Date.now();
      const quiet =
        now - lastMutation > quietMs && now - lastResource > quietMs;
      const ready = document.readyState !== "loading";
      if (quiet && ready) {
        finish(true, "settled");
      } else if (now - started > timeoutMs) {
        finish(false, ready ? "timeout: page still busy" : "timeout: still loading");
      }
    }, 100);

    function finish(settled: boolean, reason: string): void {
      clearInterval(poll);
      mo.disconnect();
      po?.disconnect();
      resolve({ settled, reason, elapsedMs: Date.now() - started });
    }
  });
}
