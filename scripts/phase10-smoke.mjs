#!/usr/bin/env node
// Run-log verification driver.
// Proves: every real run is archived to chrome.storage.local with wall-clock
// per-turn timestamps and per-tool-call args/results/durations, the record
// closes on `done`, the panel's Run logs drawer lists it and renders the
// per-turn timeline, and JSONL/Markdown export produce parseable output.
// Usage: node scripts/phase10-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9235;
const PROFILE = "/tmp/ba-phase10";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const FIXTURE_PORT = Number(process.env.BA_FIXTURE_PORT ?? 8795);
const MAIN = `http://127.0.0.1:${FIXTURE_PORT}`;

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

const S_FLOW = [
  { text: "Navigating.", toolCalls: [{ name: "navigate", args: { url: `${MAIN}/docs.html` } }] },
  { text: "Reading.", toolCalls: [{ name: "read_page", args: {} }] },
  { text: "### Logged\n\nTask archived." },
];

function log(...args) {
  console.log("[phase10]", ...args);
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
  log(ok ? "PASS" : "FAIL", name, String(detail).slice(0, 200));
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
  const servers = startFixtureServers({
    mainPort: FIXTURE_PORT,
    framePort: FIXTURE_PORT + 1,
  });
  const mock = startMockLlm({ script: S_FLOW, port: 8793 });
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
    await panel.eval(`__ba.setSettings({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8793/v1",
      model: "mock-model",
      apiKey: "test-key",
      mode: "standard",
      stepCap: 40,
      sendScreenshots: false,
      cdpPort: 9222,
    }); "ok"`);

    // ---- L1: a real run is archived with timestamps and tool detail ----
    const startedAt = Date.now();
    await panel.eval(`__ba.runTask("Archive this run"); "started"`);
    await waitDone(panel);
    await sleep(600); // let the final flush land

    const logs = await panel.eval(`__ba.logs().then(l => JSON.stringify(l))`).then(JSON.parse);
    const rec = logs[0];
    const tools = rec?.turns?.flatMap((t) => t.tools) ?? [];

    check("L1 run archived to chrome.storage.local", logs.length === 1, `logs=${logs.length}`);
    check(
      "L2 record carries task, status and wall-clock span",
      rec?.task === "Archive this run" &&
        rec?.status === "done" &&
        rec?.startedAt >= startedAt - 5_000 &&
        typeof rec?.durationMs === "number" &&
        rec.durationMs >= 0,
      JSON.stringify({ task: rec?.task, status: rec?.status, durationMs: rec?.durationMs }),
    );
    check(
      "L3 per-turn timing recorded",
      rec?.turns?.length >= 1 &&
        rec.turns.every((t) => typeof t.startedAt === "number" && typeof t.endedAt === "number" && t.durationMs >= 0),
      JSON.stringify(rec?.turns?.map((t) => ({ i: t.index, d: t.durationMs }))),
    );
    check(
      "L4 tool calls logged with args, results, ok flag and duration",
      tools.length >= 2 &&
        tools.every(
          (t) =>
            typeof t.name === "string" &&
            typeof t.args === "string" &&
            typeof t.result === "string" &&
            typeof t.ok === "boolean" &&
            typeof t.at === "number" &&
            typeof t.durationMs === "number" &&
            t.durationMs >= 0,
        ) &&
        tools.some((t) => t.name === "navigate") &&
        tools.some((t) => t.name === "read_page"),
      JSON.stringify(tools.map((t) => ({ n: t.name, ok: t.ok, ms: t.durationMs }))),
    );
    check(
      "L5 assistant text and summary captured",
      rec?.turns?.some((t) => t.text.includes("Logged") || (t.summary ?? "").length > 0),
      JSON.stringify(rec?.turns?.map((t) => t.text?.slice(0, 40))),
    );

    // ---- L6: the panel lists it and renders the detail timeline ----
    await panel.eval(`(() => {
      document.querySelector('[data-tip="Run logs"]')?.click();
      return "clicked";
    })()`);
    await sleep(500);
    const listDom = await panel.eval(`JSON.stringify({
      open: __ba.logsUI().open,
      rows: document.querySelectorAll(".logs-view .hist-row").length,
      hasTask: document.querySelector(".logs-view")?.innerText.includes("Archive this run") ?? false,
    })`).then(JSON.parse);
    check(
      "L6 Run logs drawer lists the archived run",
      listDom.open === true && listDom.rows >= 1 && listDom.hasTask,
      JSON.stringify(listDom),
    );

    await panel.eval(`(() => {
      document.querySelector(".logs-view .hist-item")?.click();
      return "opened";
    })()`);
    await sleep(500);
    const detailDom = await panel.eval(`JSON.stringify({
      detail: __ba.logsUI().detail !== null,
      turns: document.querySelectorAll(".log-turn").length,
      tools: document.querySelectorAll(".log-tool").length,
      hasArgs: (document.querySelector(".logs-view")?.innerText ?? "").includes("docs.html"),
      hasTimes: /\\d{2}:\\d{2}:\\d{2}/.test(document.querySelector(".log-turn-head")?.innerText ?? ""),
    })`).then(JSON.parse);
    check(
      "L7 detail view renders per-turn timeline with times, tools and args",
      detailDom.detail === true &&
        detailDom.turns >= 1 &&
        detailDom.tools >= 2 &&
        detailDom.hasArgs &&
        detailDom.hasTimes,
      JSON.stringify(detailDom),
    );

    // ---- L8: exports are well-formed ----
    const exported = await panel.eval(`(async () => {
      // Exercise the export path through the same port the UI uses.
      return await new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "panel" });
        port.onMessage.addListener((msg) => {
          if (msg.type === "logs.export") { resolve(msg); port.disconnect(); }
        });
        port.postMessage({ kind: "logs.export", format: "jsonl" });
        setTimeout(() => resolve(null), 8000);
      });
    })()`);
    let parsed = null;
    if (exported?.content) {
      try {
        parsed = JSON.parse(exported.content.trim().split("\n")[0]);
      } catch {}
    }
    check(
      "L8 JSONL export is filename-stamped and parseable",
      Boolean(exported?.filename?.endsWith(".jsonl")) &&
        parsed?.task === "Archive this run" &&
        parsed?.turns?.[0]?.tools?.length >= 1,
      JSON.stringify({ filename: exported?.filename, task: parsed?.task }),
    );

    const mdExport = await panel.eval(`(async () => {
      return await new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "panel" });
        port.onMessage.addListener((msg) => {
          if (msg.type === "logs.export") { resolve(msg); port.disconnect(); }
        });
        port.postMessage({ kind: "logs.export", format: "md" });
        setTimeout(() => resolve(null), 8000);
      });
    })()`);
    check(
      "L9 Markdown export contains the turn timeline",
      Boolean(mdExport?.filename?.endsWith(".md")) &&
        mdExport.content.includes("# Archive this run") &&
        /## Turn 1/.test(mdExport.content) &&
        mdExport.content.includes("navigate"),
      JSON.stringify({ filename: mdExport?.filename, len: mdExport?.content?.length }),
    );

    panel.close();
  } finally {
    mock.close?.();
    edge.kill();
    servers.close?.();
  }

  console.log("\n[phase10] checks:");
  for (const c of results.checks) console.log(` ${c.ok ? "ok  " : "FAIL"} ${c.name}`);
  console.log(results.pass ? "\n[phase10] ALL CHECKS PASSED" : "\n[phase10] FAILURES PRESENT");
  process.exit(results.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[phase10] fatal:", err);
  process.exit(1);
});