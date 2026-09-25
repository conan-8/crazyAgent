#!/usr/bin/env node
// Phase 2 verification driver: perception on the fixture site.
// Proves: snapshot aggregates main frame + cross-origin iframe + shadow DOM,
// screenshot returns real image data, wait_for_settle distinguishes calm from
// busy pages, and collections survive SPA re-renders.
// Usage: node scripts/phase2-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";

const PORT = 9226;
const PROFILE = "/tmp/ba-phase2";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

function log(...args) {
  console.log("[phase2]", ...args);
}

class CdpPage {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.waiters = new Map();
  }
  async open() {
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const waiter = this.waiters.get(msg.id);
      if (waiter) {
        this.waiters.delete(msg.id);
        waiter(msg);
      }
    };
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
      sleep(15_000).then(() => {
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
      throw new Error(
        `eval failed: ${JSON.stringify(res.result.exceptionDetails).slice(0, 300)}`,
      );
    }
    return res.result?.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function openPage(url) {
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new`, {
    method: "PUT",
  }).then((r) => r.json());
  const page = new CdpPage(created.webSocketDebuggerUrl);
  await page.open();
  await page.send("Page.enable");
  await page.send("Page.navigate", { url });
  return { page, targetId: created.id };
}

async function openPanel() {
  const opened = await openPage(`chrome-extension://${extId}/sidepanel/index.html`);
  for (let i = 0; i < 40; i++) {
    if ((await opened.page.eval("typeof window.__ba")) === "object") return opened;
    await sleep(250);
    if (i === 39) throw new Error("panel page never became interactive");
  }
}

const results = { pass: true, checks: [] };
function check(name, ok, detail = "") {
  results.checks.push({ name, ok, detail: String(detail).slice(0, 400) });
  if (!ok) results.pass = false;
  log(ok ? "PASS" : "FAIL", name, String(detail).slice(0, 200));
}

async function main() {
  const servers = startFixtureServers();
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
      if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true).catch(() => false)) break;
      await sleep(500);
    }

    const { page: panel } = await openPanel();
    const { page: tab } = await openPage(`${MAIN}/index.html`);
    await sleep(1_500); // content script injection + fixture JS

    const tabId = await panel.eval(
      `chrome.tabs.query({ url: "${MAIN}/*" }).then(ts => ts[0]?.id ?? -1)`,
    );
    check("S0 fixture tab bound to a chrome tabId", tabId > 0, `tabId=${tabId}`);

    // ---- snapshot: multi-frame + shadow DOM ----
    const snap = await panel.eval(
      `__ba.runTool("snapshot", {}, ${tabId}).then(s => JSON.stringify(s))`,
    ).then(JSON.parse);

    check(
      "S1 snapshot sees main frame and cross-origin iframe",
      snap.frames.length === 2,
      `frames=${JSON.stringify(snap.frames.map((f) => f.href))}`,
    );
    const names = snap.elements.map((e) => e.name);
    for (const expected of [
      "Docs",
      "Search",
      "All",
      "Add item",
      "delete item 1",
      "shadow input",
      "Shadow button",
      "frame input",
      "Frame button",
    ]) {
      check(`S2 snapshot lists "${expected}"`, names.includes(expected), `names=${names.length}`);
    }
    const frameEls = snap.elements.filter((e) => e.frameId !== 0);
    check(
      "S3 iframe elements carry frame-scoped refs",
      frameEls.length >= 2 && frameEls.every((e) => e.ref.includes("#")),
      `frameEls=${frameEls.map((e) => e.ref).join(",")}`,
    );
    check(
      "S4 snapshot includes visible text digest",
      snap.text.includes("Fixture home"),
      snap.text.slice(0, 60),
    );
    check(
      "S4b snapshot text includes the IFRAME's text too, labelled with its frame id",
      snap.text.includes("Framed page (origin 8791)") &&
        /--- frame \d+ \(http:\/\/127\.0\.0\.1:8791\/framed\.html\) ---/.test(snap.text),
      snap.text.slice(-160),
    );

    // ---- screenshot ----
    const shot = await panel.eval(`__ba.runTool("screenshot", {}, ${tabId})`);
    check(
      "S5 screenshot returns JPEG data URL",
      typeof shot?.dataUrl === "string" &&
        shot.dataUrl.startsWith("data:image/jpeg;base64,") &&
        shot.dataUrl.length > 5_000,
      `len=${shot?.dataUrl?.length ?? 0}`,
    );

    // ---- settle: calm page settles fast ----
    const settle1 = await panel.eval(
      `__ba.runTool("wait_for_settle", { timeoutMs: 5000 }, ${tabId}).then(s => JSON.stringify(s))`,
    ).then(JSON.parse);
    check(
      "S6 wait_for_settle: calm page settles",
      settle1.settled === true,
      `${settle1.reason} @ ${settle1.elapsedMs}ms`,
    );

    // ---- SPA re-render: snapshot twice, elements stay collectable ----
    await tab.send("Page.navigate", { url: `${MAIN}/spa.html` });
    await sleep(2_500); // at least one re-render happens
    const spa1 = await panel.eval(
      `__ba.runTool("snapshot", {}, ${tabId}).then(s => JSON.stringify(s))`,
    ).then(JSON.parse);
    await sleep(2_000); // another re-render
    const spa2 = await panel.eval(
      `__ba.runTool("snapshot", {}, ${tabId}).then(s => JSON.stringify(s))`,
    ).then(JSON.parse);
    check(
      "S7 SPA re-render: both snapshots see the 5 row buttons",
      spa1.elements.filter((e) => e.name.startsWith("row ")).length === 5 &&
        spa2.elements.filter((e) => e.name.startsWith("row ")).length === 5,
      `${spa1.elements.length} → ${spa2.elements.length} els`,
    );

    // ---- settle: continuously busy page does not settle ----
    await tab.send("Page.navigate", { url: `${MAIN}/spa.html?fast=1` });
    await sleep(800);
    const settle2 = await panel.eval(
      `__ba.runTool("wait_for_settle", { timeoutMs: 2000 }, ${tabId}).then(s => JSON.stringify(s))`,
    ).then(JSON.parse);
    check(
      "S8 wait_for_settle: busy page stays unsettled",
      settle2.settled === false,
      settle2.reason,
    );

    // ---- login page: form fields with types ----
    await tab.send("Page.navigate", { url: `${MAIN}/login.html` });
    await sleep(1_200);
    const login = await panel.eval(
      `__ba.runTool("snapshot", {}, ${tabId}).then(s => JSON.stringify(s))`,
    ).then(JSON.parse);
    const user = login.elements.find((e) => e.name === "Username");
    const pass = login.elements.find((e) => e.name === "Password");
    check(
      "S9 login form fields collected with types",
      user?.type === "text" && pass?.type === "password",
      `user=${user?.type} pass=${pass?.type}`,
    );

    panel.close();
    tab.close();
  } finally {
    edge.kill("SIGTERM");
    servers.close();
    spawn("rm", ["-rf", PROFILE]).on("exit", () => {});
    await sleep(500);
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[phase2] fatal:", err);
  process.exit(1);
});
