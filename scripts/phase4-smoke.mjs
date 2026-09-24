#!/usr/bin/env node
// Phase 4 verification driver: the REAL agent loop against a scripted mock
// LLM over real HTTP/SSE, once per provider (OpenAI-compatible + Anthropic).
// Proves: streamed text, tool-call sequence, invalid-args feedback without
// execution, per-step checkpointing, final summary, checkpoint cleanup.
// Usage: node scripts/phase4-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9228;
const PROFILE = "/tmp/ba-phase4";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

// The scripted "model": one tool call per turn, one deliberate invalid call,
// a screenshot (image path), then a final summary.
const SCRIPT = [
  {
    text: "Opening the docs page.",
    toolCalls: [{ name: "navigate", args: { url: `${MAIN}/docs.html` } }],
  },
  {
    text: "Waiting for it to load.",
    toolCalls: [{ name: "wait_for_settle", args: { timeoutMs: 5000 } }],
  },
  {
    text: "Trying a click with deliberately missing arguments.",
    toolCalls: [{ name: "click", args: {} }],
  },
  {
    text: "Taking a screenshot.",
    toolCalls: [{ name: "screenshot", args: {} }],
  },
  {
    text: "Reading the page text.",
    toolCalls: [{ name: "read_page", args: {} }],
  },
  { text: "Summary: the docs page contains Lorem ipsum dolor sit amet." },
];

function log(...args) {
  console.log("[phase4]", ...args);
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
  const mock = startMockLlm({ script: SCRIPT, port: 8792 });
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

    for (const provider of ["openai-compatible", "anthropic"]) {
      const P = provider === "anthropic" ? "ANTH" : "OAI";
      const settings = {
        provider,
        baseUrl:
          provider === "anthropic"
            ? "http://127.0.0.1:8792/anthropic/v1"
            : "http://127.0.0.1:8792/v1",
        model: "mock-model",
        apiKey: "test-key",
        mode: "standard",
        stepCap: 40,
        sendScreenshots: true,
      };
      await panel.eval(
        `chrome.storage.local.set({ baSettings: ${JSON.stringify(settings)} }); "ok"`,
      );

      // Run the REAL agent loop.
      await panel.eval(
        `__ba.runTask("Open the docs page and summarize it."); "started"`,
      );

      // Mid-run checkpoint sample (the mock paces turns over ~3s).
      await sleep(1_500);
      const mid = JSON.parse(
        await panel.eval("__ba.queryState().then(s => JSON.stringify(s))"),
      );
      check(
        `${P}1 checkpoint advances mid-run`,
        (mid.checkpoint?.stepIndex ?? 0) >= 1,
        `stepIndex=${mid.checkpoint?.stepIndex}`,
      );

      // Wait for completion.
      let events = [];
      for (let i = 0; i < 150; i++) {
        events = await panel.eval("JSON.stringify(__ba.events())").then(JSON.parse);
        if (events.some((e) => e.kind === "done" || e.kind === "error")) break;
        await sleep(200);
      }

      const calls = events.filter((e) => e.kind === "tool_call");
      const names = calls.map((e) => e.name);
      check(
        `${P}2 tool-call sequence matches the script`,
        JSON.stringify(names) ===
          JSON.stringify(["navigate", "wait_for_settle", "click", "screenshot", "read_page"]),
        names.join(","),
      );

      const results3 = events.filter((e) => e.kind === "tool_result");
      const clickResult = results3.find((e) => e.name === "click");
      check(
        `${P}3 invalid args fed back without execution`,
        clickResult?.ok === false &&
          String(clickResult.result).includes("missing required parameter: ref"),
        clickResult?.result ?? "(none)",
      );
      check(
        `${P}4 screenshot tool succeeded (image path)`,
        results3.find((e) => e.name === "screenshot")?.ok === true,
      );

      const deltas = events.filter((e) => e.kind === "token_delta").length;
      check(`${P}5 text was streamed`, deltas >= 10, `token_delta x${deltas}`);

      const done = events.find((e) => e.kind === "done");
      check(
        `${P}6 final summary reported`,
        done?.summary.includes("Summary: the docs page contains Lorem ipsum"),
        done?.summary ?? "(none)",
      );

      await sleep(500);
      const after = JSON.parse(
        await panel.eval("__ba.queryState().then(s => JSON.stringify(s))"),
      );
      check(
        `${P}7 checkpoint cleared after completion`,
        after.checkpoint === null || after.checkpoint?.done === true,
        JSON.stringify(after.checkpoint)?.slice(0, 80) ?? "null",
      );
    }
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
  console.error("[phase4] fatal:", err);
  process.exit(1);
});
