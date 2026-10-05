#!/usr/bin/env node
// Window isolation — the agent gets ONE window and cannot leave it.
//
// Design contract (docs/DEV.md → "Window isolation"):
//   W1 tabs_list shows only the agent window's tabs, every row marked "agent"
//   W2 tabs_switch / tabs_close REFUSE a tab in the user's window, and the
//      tracked tab does not move
//   W3 tabs_create always lands in the agent window, never the focused one
//   W4 trusted input (type) reaches the agent window's tab while another
//      window exists
//   W5 a trusted mouse stroke (click_at) does too — and NOTHING raises a
//      window: the raise counter stays 0 for the whole sequence
//   W6 the per-run "look outside" grant widens LISTING only: the user's tabs
//      appear marked "user" and still cannot be switched to
//   W7 closing the agent window mid-flight is recovered: the next tool call
//      creates a fresh one instead of failing
//
// Usage: node scripts/window-smoke.mjs   (run `npm run build` first)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";

const PORT = 9247;
const PROFILE = "/tmp/ba-window";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

function log(...args) {
  console.log("[window]", ...args);
}

class CdpPage {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.waiters = new Map();
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const w = this.waiters.get(msg.id);
      if (w) {
        this.waiters.delete(msg.id);
        w(msg);
      }
    };
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      new Promise((resolve) => this.waiters.set(id, resolve)),
      sleep(20_000).then(() => {
        throw new Error(`CDP call timed out: ${method}`);
      }),
    ]);
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(`eval failed: ${JSON.stringify(res.result.exceptionDetails).slice(0, 300)}`);
    }
    return res.result?.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function openPage(url) {
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: "PUT" }).then((r) =>
    r.json(),
  );
  const page = new CdpPage(created.webSocketDebuggerUrl);
  await page.open();
  await page.send("Page.enable");
  await page.send("Page.navigate", { url });
  for (let i = 0; i < 60; i++) {
    const ready = await page.eval("document.readyState");
    if (ready === "complete") break;
    await sleep(200);
  }
  return page;
}

const results = { pass: true, checks: [] };
function check(name, ok, detail = "") {
  results.checks.push({ name, ok, detail: String(detail).slice(0, 300) });
  if (!ok) results.pass = false;
  log(ok ? "PASS" : "FAIL", name, String(detail).slice(0, 200));
}

async function main() {
  const fixtures = startFixtureServers();
  spawn("rm", ["-rf", PROFILE]).on("exit", () => {});
  await sleep(300);
  const edge = spawn(
    "/usr/bin/microsoft-edge",
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${EXT_PATH}`,
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--headless=new",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    for (let i = 0; i < 60; i++) {
      if (
        await fetch(`http://127.0.0.1:${PORT}/json/version`)
          .then(() => true)
          .catch(() => false)
      ) {
        break;
      }
      await sleep(500);
    }

    const panel = await openPage(`chrome-extension://${extId}/sidepanel/index.html`);
    for (let i = 0; i < 40; i++) {
      if ((await panel.eval("typeof window.__ba")) === "object") break;
      await sleep(250);
    }
    const call = async (name, args = {}) =>
      JSON.parse(
        await panel.eval(
          `__ba.tool(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((r) => JSON.stringify(r))`,
        ),
      );
    const textOf = async (name, args = {}) =>
      panel.eval(
        `__ba.toolText(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((t) => String(t ?? ""))`,
      );
    const status = async () =>
      JSON.parse(await panel.eval("__ba.window().then((s) => JSON.stringify(s))"));
    const raiseCount = async () => panel.eval("__ba.raiseCount()");

    // ---------------------------------------------------------------- setup
    // The panel lives in the browser's first window — that one belongs to the
    // USER. A second window holds the fixture and becomes the agent's.
    const userWindowId = await panel.eval("chrome.windows.getCurrent().then((w) => w.id)");
    await panel.eval(
      `chrome.windows.create({ url: ${JSON.stringify(MAIN)}, focused: false }).then((w) => w.id)`,
    );
    const windowsNow = await panel.eval("chrome.windows.getAll().then((ws) => ws.length)");
    check("W0 a second window exists", windowsNow >= 2, `windows=${windowsNow}`);

    const agentWindowId = await (async () => {
      // The fixture tab needs a moment to commit its URL: poll rather than
      // reading once, or a slow start shows up as "no fixture window".
      for (let i = 0; i < 30; i++) {
        const id = await panel.eval(
          `chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => (x.url || "").startsWith(${JSON.stringify(MAIN)})); return t ? t.windowId : -1; })`,
        );
        if (id > 0) return id;
        await sleep(250);
      }
      return -1;
    })();
    check(
      "W0 the fixture window is not the panel's window",
      agentWindowId > 0 && agentWindowId !== userWindowId,
      `agent=${agentWindowId} user=${userWindowId}`,
    );
    if (agentWindowId <= 0) throw new Error("no fixture window to bind — cannot test isolation");
    await panel.eval(`__ba.bindWindow(${agentWindowId})`);
    const bound = await status();
    check("W0 the agent window is bound", bound?.windowId === agentWindowId, JSON.stringify(bound));
    await sleep(400);
    const barText = await panel.eval(
      `document.querySelector(".window-bar")?.textContent ?? ""`,
    );
    check(
      "W0 the panel shows where the agent works",
      barText.includes(`#${agentWindowId}`),
      barText.slice(0, 120),
    );

    const agentTabId = await panel.eval(
      `chrome.tabs.query({ windowId: ${agentWindowId} }).then((ts) => ts[0].id)`,
    );
    const panelTabId = await panel.eval(
      `chrome.tabs.query({ windowId: ${userWindowId} }).then((ts) => ts.find((t) => (t.url || "").startsWith("chrome-extension://")).id)`,
    );

    await call("tabs_switch", { tabId: agentTabId });
    await sleep(500);

    // ------------------------------------------------- W1: the whole world
    const rows = await call("tabs_list");
    const ids = (rows.payload ?? []).map((r) => r.tabId);
    check(
      "W1 tabs_list lists only the agent window's tabs",
      ids.includes(agentTabId) && !ids.includes(panelTabId),
      `ids=${JSON.stringify(ids)} panelTab=${panelTabId}`,
    );
    check(
      "W1 every row is marked as the agent's own window",
      (rows.payload ?? []).every((r) => r.window === "agent"),
      JSON.stringify(rows.payload ?? []).slice(0, 200),
    );

    // ------------------------------------------------ W2: the wall (writes)
    const before = await status();
    const deniedSwitch = await call("tabs_switch", { tabId: panelTabId });
    check(
      "W2 tabs_switch refuses a tab in the user's window",
      deniedSwitch.ok === false && String(deniedSwitch.error).includes("TOOL-FAILED"),
      String(deniedSwitch.error).slice(0, 200),
    );
    const deniedClose = await call("tabs_close", { tabId: panelTabId });
    check(
      "W2 tabs_close refuses it too",
      deniedClose.ok === false && String(deniedClose.error).includes("TOOL-FAILED"),
      String(deniedClose.error).slice(0, 160),
    );
    const stillAlive = await panel.eval(
      `chrome.tabs.get(${panelTabId}).then((t) => t.id).catch(() => -1)`,
    );
    check("W2 the user's tab is untouched", stillAlive === panelTabId, `id=${stillAlive}`);
    const after = await status();
    check(
      "W2 the tracked tab did not move",
      after.activeTabId === before.activeTabId && after.windowId === before.windowId,
      `${before.activeTabId} → ${after.activeTabId}`,
    );

    // --------------------------------------- W3: creates land in its window
    const created = await call("tabs_create", { url: `${MAIN}?created=1` });
    const createdWindow = await panel.eval(
      `chrome.tabs.get(${created.payload?.tabId}).then((t) => t.windowId).catch(() => -1)`,
    );
    check(
      "W3 tabs_create opens in the AGENT window",
      createdWindow === agentWindowId,
      `tab=${created.payload?.tabId} window=${createdWindow} agent=${agentWindowId}`,
    );

    // ---------------------------------------------- W4/W5: quiet, trusted input
    await call("tabs_switch", { tabId: agentTabId });
    await sleep(400);
    const snap = JSON.parse(
      await panel.eval(`__ba.runTool("snapshot", {}).then((s) => JSON.stringify(s))`),
    );
    const elements = snap?.elements ?? [];
    // The fixture's text input and its submit button share the name "Search";
    // the input comes first in document order.
    const qRef = elements.find((e) => e.name === "Search")?.ref;
    const addRef = elements.find((e) => e.name === "Add item")?.ref;
    check(
      "W4 the fixture snapshot has refs",
      Boolean(qRef && addRef),
      `refs=${elements.map((e) => `${e.ref}:${e.name}`).slice(0, 8).join(", ")}`,
    );

    await call("type", { ref: qRef, text: "quiet focus" });
    await sleep(600);
    const typed = await panel.eval(
      `chrome.scripting.executeScript({ target: { tabId: ${agentTabId} }, func: () => document.querySelector("#q")?.value }).then((r) => r[0]?.result ?? "")`,
    );
    check("W4 trusted typing reached the agent window's tab", typed === "quiet focus", `value=${typed}`);

    const itemsBefore = await panel.eval(
      `chrome.scripting.executeScript({ target: { tabId: ${agentTabId} }, func: () => document.querySelectorAll("#item-list li").length }).then((r) => r[0]?.result ?? -1)`,
    );
    await call("click_at", { ref: addRef });
    await sleep(700);
    const itemsAfter = await panel.eval(
      `chrome.scripting.executeScript({ target: { tabId: ${agentTabId} }, func: () => document.querySelectorAll("#item-list li").length }).then((r) => r[0]?.result ?? -1)`,
    );
    check(
      "W5 a trusted mouse stroke landed in that tab",
      itemsAfter === itemsBefore + 1,
      `items ${itemsBefore} → ${itemsAfter}`,
    );
    check("W5 nothing raised a window", (await raiseCount()) === 0, `raises=${await raiseCount()}`);

    // ------------------------------------------- W6: "look outside" is read-only
    await panel.eval("__ba.setScope(true)");
    await sleep(300);
    const peeked = await call("tabs_list");
    const peekRows = peeked.payload ?? [];
    check(
      "W6 the grant reveals the user's tabs, marked 'user'",
      peekRows.some((r) => r.window === "user" && r.tabId === panelTabId),
      JSON.stringify(peekRows.filter((r) => r.window === "user")).slice(0, 200),
    );
    const peekSwitch = await call("tabs_switch", { tabId: panelTabId });
    check(
      "W6 acting outside stays impossible even with the grant",
      peekSwitch.ok === false,
      String(peekSwitch.error).slice(0, 140),
    );
    await panel.eval("__ba.setScope(false)");

    // --------------------------------------------- W7: the window is replaced
    await panel.eval(`chrome.windows.remove(${agentWindowId}).then(() => true)`);
    await sleep(800);
    const gone = await status();
    check("W7 the closed window is no longer the agent's", gone.windowId !== agentWindowId, JSON.stringify(gone));
    const afterRecreate = await call("tabs_list");
    const fresh = await status();
    check(
      "W7 the next tool call opens a fresh agent window",
      afterRecreate.ok !== false && fresh.alive === true && fresh.windowId !== agentWindowId,
      JSON.stringify(fresh),
    );

    log(`\n${results.checks.filter((c) => c.ok).length}/${results.checks.length} checks passed`);
  } finally {
    edge.kill("SIGKILL");
    fixtures.close();
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[window] fatal:", err);
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
});