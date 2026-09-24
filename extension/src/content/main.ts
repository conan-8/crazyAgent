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
        void waitForSettle(m.timeoutMs ?? 15_000).then(sendResponse);
        return true;
      }
      return false;
    },
  );
}
