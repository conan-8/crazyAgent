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
        // Name WHAT was still busy and how recently: the model's next move
        // differs between "mutations 80ms ago" (keep waiting — or better, use
        // wait_for with stable_for_ms) and "nothing for 10s" (a real stall).
        finish(
          false,
          ready
            ? `timeout: page still busy (last mutation ${now - lastMutation}ms ago, last resource ${now - lastResource}ms ago — for streamed/progressive content use wait_for with stable_for_ms instead of polling settle)`
            : "timeout: still loading",
        );
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
