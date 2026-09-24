#!/usr/bin/env node
// Phase 3 verification driver: action layer on the fixture site.
// Runs a canned script 3× — fill+submit login, interact with a re-rendering
// SPA list (live click + stale-ref behavior), and type inside a cross-origin
// iframe. Usage: node scripts/phase3-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";

const PORT = 9227;
const PROFILE = "/tmp/ba-phase3";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

function log(...args) {
  console.log("[phase3]", ...args);
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
  return page;
}

async function openPanel() {
  const page = await openPage(`chrome-extension://${extId}/sidepanel/index.html`);
  for (let i = 0; i < 40; i++) {
    if ((await page.eval("typeof window.__ba")) === "object") return page;
    await sleep(250);
    if (i === 39) throw new Error("panel page never became interactive");
  }
}

const results = { pass: true, checks: [] };
function check(name, ok, detail = "") {
  results.checks.push({ name, ok, detail: String(detail).slice(0, 300) });
  if (!ok) results.pass = false;
  log(ok ? "PASS" : "FAIL", name, String(detail).slice(0, 160));
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

    const panel = await openPanel();
    await openPage(`${MAIN}/index.html`);
    await sleep(1_200);
    const tabId = await panel.eval(
      `chrome.tabs.query({ url: "${MAIN}/*" }).then(ts => ts[0]?.id ?? -1)`,
    );

    const tool = (name, args = {}) =>
      panel
        .eval(
          `__ba.runTool(${JSON.stringify(name)}, ${JSON.stringify(args)}, ${tabId}).then(
            (r) => JSON.stringify(r ?? null),
            (e) => JSON.stringify({ ok: false, error: String(e.message) }),
          )`,
        )
        .then((s) => JSON.parse(s));
    const tabUrl = () =>
      panel.eval(`chrome.tabs.get(${tabId}).then(t => t.url)`);
    const tabTitle = () =>
      panel.eval(`chrome.tabs.get(${tabId}).then(t => t.title)`);
    const findRef = (snap, predicate) =>
      snap.elements.find(predicate)?.ref ?? null;

    for (let round = 1; round <= 3; round++) {
      const R = `R${round}`;

      // ---- login: fill + submit ----
      await tool("navigate", { url: `${MAIN}/login.html` });
      await sleep(800);
      await tool("wait_for_settle", { timeoutMs: 5000 });
      const loginSnap = await tool("snapshot");
      const userRef = findRef(loginSnap, (e) => e.name === "Username");
      const passRef = findRef(loginSnap, (e) => e.name === "Password");
      const btnRef = findRef(loginSnap, (e) => e.name === "Log in");
      check(`${R}1 login fields found in snapshot`, Boolean(userRef && passRef && btnRef));

      const t1 = await tool("type", { ref: userRef, text: "alice" });
      const t2 = await tool("type", { ref: passRef, text: "s3cret" });
      check(`${R}2 typed into both fields`, t1.ok && t2.ok, `${t1.error ?? ""} ${t2.error ?? ""}`);
      const c1 = await tool("click", { ref: btnRef });
      await sleep(800);
      await tool("wait_for_settle", { timeoutMs: 5000 });
      const url = await tabUrl();
      check(
        `${R}3 form submitted (URL navigated)`,
        c1.ok && url.includes("docs.html"),
        url,
      );

      // ---- SPA list: live click ----
      await tool("navigate", { url: `${MAIN}/spa.html` });
      await sleep(600);
      const spaSnap = await tool("snapshot");
      const row3 = findRef(spaSnap, (e) => e.name.startsWith("row 3 "));
      check(`${R}4 spa row found`, Boolean(row3));
      const c2 = await tool("click", { ref: row3 });
      await sleep(300);
      const title = await tabTitle();
      check(
        `${R}5 live click took effect`,
        c2.ok && title.includes("clicked 3"),
        `${title} / ${c2.error ?? "ok"}`,
      );

      // ---- SPA list: stale ref errors cleanly (texts change across renders) ----
      const staleSnap = await tool("snapshot");
      const row4 = findRef(staleSnap, (e) => e.name.startsWith("row 4 "));
      await sleep(2_200); // re-render destroys the element and changes its text
      const c3 = await tool("click", { ref: row4 });
      check(
        `${R}6 stale ref recovered or errored cleanly`,
        (c3.ok === true) || (c3.ok === false && String(c3.error).includes("stale or unknown ref")),
        `${c3.ok ? "recovered" : c3.error}`,
      );

      // ---- cross-origin iframe: type + click inside the frame ----
      await tool("navigate", { url: `${MAIN}/index.html` });
      await sleep(800);
      await tool("wait_for_settle", { timeoutMs: 5000 });
      const frameSnap = await tool("snapshot");
      const fInput = findRef(frameSnap, (e) => e.name === "frame input");
      const fBtn = findRef(frameSnap, (e) => e.name === "Frame button");
      check(`${R}7 frame elements found`, Boolean(fInput && fBtn), `${fInput} ${fBtn}`);
      const t3 = await tool("type", { ref: fInput, text: "hello there" });
      const c4 = await tool("click", { ref: fBtn });
      await sleep(300);
      const pages = await tool("read_page");
      const frameText = (pages ?? []).map((p) => p.text).join(" | ");
      check(
        `${R}8 iframe interaction applied`,
        t3.ok && c4.ok && frameText.includes("clicked hello there"),
        frameText.slice(0, 120),
      );
    }
    panel.close();
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
  console.error("[phase3] fatal:", err);
  process.exit(1);
});
