// Content script entry (runs in all frames on all URLs). Registers the
// element registry and action synthesizer in this frame's isolated world —
// shared with code later injected via chrome.scripting.executeScript (same
// world) — and serves settle/ping requests. Injection is idempotent.

import { Actions } from "./actions";
import { ElementRegistry } from "./registry";
import { waitForSettle } from "./settle";

interface BaGlobal {
  __baContentLoaded?: boolean;
  __baRegistry?: ElementRegistry;
  __baActions?: Actions;
}

const g = globalThis as BaGlobal;

// One shared in-flight settle: the worker owns the real deadline now (see
// settleTab) and may abandon a request, but a coalesced detector means an
// abandoned poll is reused by the next request instead of stacking another
// MutationObserver + interval on a throttled, continuously-repainting tab.
let inFlightSettle: Promise<unknown> | null = null;

if (!g.__baContentLoaded) {
  g.__baContentLoaded = true;
  g.__baRegistry = new ElementRegistry();
  g.__baActions = new Actions(g.__baRegistry);

  chrome.runtime.onMessage.addListener(
    (msg: unknown, _sender, sendResponse) => {
      const m = msg as { type?: string; timeoutMs?: number } | null;
      if (m?.type === "ping") {
        sendResponse({ type: "pong", from: "content", href: location.href });
      } else if (m?.type === "ba/settle") {
        if (!inFlightSettle) {
          inFlightSettle = waitForSettle(m.timeoutMs ?? 15_000).finally(() => {
            inFlightSettle = null;
          });
        }
        void inFlightSettle.then(sendResponse);
        return true;
      }
      return false;
    },
  );
}
