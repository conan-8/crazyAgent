#!/usr/bin/env node
// Canvas document editors (Google Docs / Slides shaped) — playbook driver.
//
// Why this exists: the agent was asked to type into a Google Doc and burned 20
// turns on it, concluding "Docs renders into a canvas, no refs to grab" while
// its tools failed one after another. Two things were wrong and both are pinned
// here:
//
//   1. Tool failures were reported as bare strings ("fetch failed"), so the
//      model could not tell a dead tab from a bad ref and retried blindly.
//   2. There was no procedure for a canvas editor: the document body has no DOM,
//      but typing DOES work through a hidden editable element that has a ref.
//
// Drives the real tools against the local canvas-editor fixture, which
// reproduces the Docs shape: pixels on a <canvas> + a hidden contenteditable
// sink in a separate frame.
//
// Usage: node scripts/docs-smoke.mjs   (run `npm run build` first)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";

const PORT = 9242;
const PROFILE = "/tmp/ba-docs";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

function log(...args) {
  console.log("[docs]", ...args);
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
    } catch {}
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
    const call = async (name, args = {}) => {
      const raw = await panel.eval(
        `__ba.tool(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((r) => JSON.stringify(r))`,
      );
      return JSON.parse(raw);
    };
    const textOf = async (name, args = {}) =>
      panel.eval(
        `__ba.toolText(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((t) => String(t ?? ""))`,
      );

    // The Docs-shaped page.
    await openPage(`${MAIN}/canvas-editor.html`);
    await sleep(2_000);
    const tabId = await panel.eval(
      `chrome.tabs.query({}).then((ts) => { const m = ts.filter((t) => !((t.url) || "").startsWith("chrome-extension://")); return m.length ? m[m.length - 1].id : -1; })`,
    );
    await panel.eval(`chrome.tabs.update(${tabId}, { active: true })`);
    await sleep(500);

    // ---- D1: the canvas surface is declared unreadable, not silently empty ----
    const snapText = await textOf("snapshot");
    check(
      "D1 a canvas document reports its body as unreadable",
      /renders its content into a <canvas>/.test(snapText) &&
        /cannot be read by any tool/.test(snapText),
      snapText.slice(0, 240),
    );

    // ---- D2: the hidden typing sink IS a ref, in its own frame ----
    const snap = await call("snapshot");
    const sink = snap.payload?.elements?.find((e) => e.editable && e.frameId !== 0);
    check(
      "D2 the hidden typing sink is exposed as an editable frame-scoped ref",
      Boolean(sink) && /^\d+#/.test(sink.ref) && sink.editable === true,
      JSON.stringify(sink ?? null).slice(0, 200),
    );

    // ---- D3: the playbook — type into the sink and the document receives it ----
    const typed = await call("type", { ref: sink.ref, text: "hello docs" });
    check(
      "D3 typing into the sink ref succeeds",
      typed.ok === true,
      JSON.stringify(typed).slice(0, 160),
    );
    await sleep(700);
    const status = await call("evaluate_js", {
      expression: "document.getElementById('status').textContent",
    });
    check(
      "D3b the document actually received the text (typed, not clicked)",
      status.ok === true && /typed: hello docs/.test(String(status.payload?.value ?? "")),
      JSON.stringify(status).slice(0, 180),
    );
    const words = (await textOf("snapshot")).match(/(\d+) words/)?.[0] ?? "";
    check(
      "D3c the page's own counter confirms the edit",
      words === "2 words",
      `counter: ${words}`,
    );

    // ---- D4: the top document genuinely cannot do this (so D3 was the sink) ----
    const blind = await call("evaluate_js", {
      expression: "document.querySelector('[contenteditable=true]') === null",
    });
    check(
      "D4 the top frame is blind to the sink, so D3 went through the frame ref",
      blind.ok === true && blind.payload?.value === "true",
      JSON.stringify(blind).slice(0, 160),
    );

    // ---- D5: toolbar refs still work on a canvas page ----
    const bold = snap.payload?.elements?.find((e) => e.name === "Bold");
    const clicked = await call("click", { ref: bold?.ref });
    const boldStatus = await call("evaluate_js", {
      expression: "document.getElementById('status').textContent",
    });
    check(
      "D5 toolbar refs work even though the document body has no DOM",
      clicked.ok === true && /bold toggled/.test(String(boldStatus.payload?.value ?? "")),
      JSON.stringify(boldStatus).slice(0, 160),
    );

    // ---- D6: the health probe names the layer when tools break ----
    const health = await textOf("page_health");
    check(
      "D6 page_health reports each layer as working",
      /tab access: ok/.test(health) &&
        /content-script injection: ok/.test(health) &&
        /debugger channel: ok/.test(health) &&
        /All layers respond/.test(health),
      health.replace(/\n/g, " | ").slice(0, 240),
    );

    // ---- D7: failures are classified, never a bare string ----
    const badRef = await call("click", { ref: "0#999" });
    const badRefText = String(badRef?.error ?? "");
    check(
      "D7 a bad ref comes back classified with a next move",
      badRef.ok === false &&
        /FRAME-FAILED|INJECTION-FAILED/.test(badRefText) &&
        /fresh snapshot/.test(badRefText),
      badRefText.replace(/\n/g, " ").slice(0, 240),
    );
    const badArgs = await call("click", {});
    check(
      "D7b a missing argument is classified as an input error",
      badArgs.ok === false && /INPUT-FAILED/.test(String(badArgs.error ?? "")),
      String(badArgs.error ?? "").slice(0, 200),
    );

    // ---- D8: no tool failure is ever reported as a bare, unclassified string ----
    const bare = await call("evaluate_js", { expression: "1+1", frame: 9999 });
    check(
      "D8 an unaddressable frame is classified, not a bare message",
      bare.ok === false && /FRAME-FAILED/.test(String(bare.error ?? "")),
      String(bare.error ?? "").slice(0, 200),
    );

    panel.close();
  } finally {
    edge.kill("SIGTERM");
    fixtures.close();
    spawn("rm", ["-rf", PROFILE]).on("exit", () => {});
    await sleep(500);
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[docs] fatal:", err);
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
});