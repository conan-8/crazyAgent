#!/usr/bin/env node
// Phase 7 verification driver: Unlimited mode.
// Proves: helper daemon install + native-messaging wiring, agent task driven
// through CdpAdapter (screenshot over full CDP — chrome.debugger untouched,
// therefore no debug banner), network mock + rewrite + observe, and clean
// daemon crash recovery (killed host respawns on the next RPC).
// Usage: node scripts/phase7-smoke.mjs
import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9231;
const PROFILE = "/tmp/ba-phase7";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

const S_SHOT = [
  { text: "Taking a screenshot through the helper.", toolCalls: [{ name: "screenshot", args: {} }] },
  { text: "Captured via the helper daemon." },
];

function log(...args) {
  console.log("[phase7]", ...args);
}

class CdpPage {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.waiters = new Map();
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const w = this.waiters.get(msg.id);
      if (w) { this.waiters.delete(msg.id); w(msg); }
    };
  }
  async open() { await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      new Promise((resolve) => this.waiters.set(id, resolve)),
      sleep(15_000).then(() => { throw new Error(`CDP timeout: ${method}`); }),
    ]);
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 300));
    return res.result?.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function openPage(url) {
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: "PUT" }).then((r) => r.json());
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

async function waitDone(panel, ms = 30_000) {
  for (let i = 0; i < ms / 100; i++) {
    const evs = await panel.eval("JSON.stringify(__ba.events())").then(JSON.parse);
    if (evs.some((e) => e.kind === "done" || e.kind === "error")) return evs;
    await sleep(100);
  }
  throw new Error("run did not finish in time");
}

async function main() {
  const servers = startFixtureServers();
  const mock = startMockLlm({ script: S_SHOT, port: 8792 });

  // Install the native-messaging host for Edge (the product's install.sh).
  execSync(`sh helper/install.sh ${extId}`, { cwd: new URL("..", import.meta.url).pathname });

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
    await panel.eval(`chrome.tabs.update(${tabId}, { active: true })`);

    // Unlimited mode + helper daemon, mock LLM for the scripted run.
    await panel.eval(`__ba.setSettings({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8792/v1",
      model: "mock-model",
      apiKey: "test-key",
      mode: "unlimited",
      stepCap: 40,
      sendScreenshots: true,
      cdpPort: ${PORT},
    }); "ok"`);

    // ---- U1: agent task through CdpAdapter (screenshot over full CDP) ----
    await panel.eval(`__ba.runTask("Take a screenshot."); "started"`);
    const evs = await waitDone(panel);
    const shotResult = evs.find((e) => e.kind === "tool_result" && e.name === "screenshot");
    check(
      "U1 task driven through CdpAdapter (daemon screenshot)",
      evs.some((e) => e.kind === "done" && e.summary.includes("Captured via the helper daemon")) &&
        shotResult?.ok === true &&
        typeof shotResult.image === "string" &&
        shotResult.image.startsWith("data:image/jpeg;base64,"),
      `ok=${shotResult?.ok} err=${shotResult?.result ?? ""} image=${String(shotResult?.image).slice(0, 24)}`,
    );

    // ---- U2: network mock intercepts and fulfills the API call ----
    await panel.eval(`__ba.tool("network_mock", {
      urlPattern: "*/api/data*",
      body: '{"value":"MOCKED-VALUE"}',
    }).then(r => JSON.stringify(r))`);
    await panel.eval(`__ba.tool("navigate", { url: "${MAIN}/api.html" })`);
    await sleep(700);
    await panel.eval(`__ba.tool("wait_for_settle", { timeoutMs: 5000 })`);
    const pagesMock = await panel.eval(`__ba.tool("read_page", {}).then(r => JSON.stringify(r))`);
    check(
      "U2 network mock fulfills the API response",
      pagesMock.includes("value: MOCKED-VALUE"),
      pagesMock.slice(0, 120),
    );

    // ---- U3: network rewrite redirects the request; observe records it ----
    await panel.eval(`__ba.tool("network_clear", {})`);
    await panel.eval(`__ba.tool("network_observe", {})`);
    await panel.eval(`__ba.tool("network_rewrite", {
      urlPattern: "*/api/data",
      url: "${MAIN}/api/alt",
    }).then(r => JSON.stringify(r))`);
    await panel.eval(`__ba.tool("navigate", { url: "${MAIN}/api.html" })`);
    await sleep(700);
    await panel.eval(`__ba.tool("wait_for_settle", { timeoutMs: 5000 })`);
    const pagesRewrite = await panel.eval(`__ba.tool("read_page", {}).then(r => JSON.stringify(r))`);
    const observed = await panel.eval(`__ba.tool("network_observe", {}).then(r => JSON.stringify(r))`);
    check(
      "U3 network rewrite redirects matching requests",
      pagesRewrite.includes("value: ALT"),
      pagesRewrite.slice(0, 120),
    );
    check(
      "U3b observe records network requests",
      observed.includes("/api/"),
      observed.slice(0, 160),
    );

    // ---- U4: kill the daemon; the next RPC respawns it cleanly ----
    try {
      execSync("pkill -9 -f 'helper/[d]aemon.mjs'");
    } catch {}
    await sleep(500);
    const shot2 = await panel
      .eval(`__ba.tool("screenshot", {}).then(
        (r) => JSON.stringify(r),
        (e) => JSON.stringify({ error: String(e.message) }),
      )`)
      .then(JSON.parse);
    check(
      "U4 daemon crash recovers on the next RPC",
      ((shot2?.payload ?? shot2)?.dataUrl ?? "").startsWith("data:image/jpeg"),
      JSON.stringify(shot2).slice(0, 120),
    );

    // ---- U5: network tools refuse politely in Standard mode ----
    await panel.eval(`__ba.setSettings({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8792/v1",
      model: "mock-model",
      apiKey: "test-key",
      mode: "standard",
      stepCap: 40,
      sendScreenshots: true,
      cdpPort: ${PORT},
    }); "ok"`);
    const netErr = await panel
      .eval(`__ba.tool("network_mock", { urlPattern: "*x*", body: "{}" }).catch(e => JSON.stringify({ error: String(e.message) }))`)
      .then((s) => (typeof s === "string" ? JSON.parse(s) : s));
    check(
      "U5 network tools refuse in Standard mode",
      String(netErr?.error ?? JSON.stringify(netErr)).includes("Unlimited mode"),
      JSON.stringify(netErr).slice(0, 120),
    );

    panel.close();
  } finally {
    edge.kill("SIGTERM");
    mock.close();
    servers.close();
    spawn("rm", ["-rf", PROFILE]).on("exit", () => {});
    await sleep(500);
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[phase7] fatal:", err);
  process.exit(1);
});
