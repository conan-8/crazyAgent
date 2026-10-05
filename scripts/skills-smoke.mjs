#!/usr/bin/env node
// Skills (on-demand procedures) verification driver.
//
// Proves, against a real browser and the scripted mock LLM:
//   * a run's system prompt carries the one-line CATALOG (uncached appendix)
//     but NOT the full procedure bodies — the fixed prefix got slimmer;
//   * `use_skill` returns a bundled body as its tool result, and names the
//     catalog when asked for an unknown name;
//   * the drawer lists bundled skills, creates a user skill, and deletes it;
//   * a user skill outranks strangers for a matching task and its catalog
//     line rides the next run.
//
// Usage: node scripts/skills-smoke.mjs   (run `npm run build` first)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9241;
const PROFILE = "/tmp/ba-skills";
const LLM_PORT = 8799;
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";
const LLM = `http://127.0.0.1:${LLM_PORT}/v1`;

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

const TASK = "fill the invoice form on the fixture page";

function log(...args) {
  console.log("[skills]", ...args);
}

// ------------------------------ CDP plumbing ------------------------------

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

async function openPanel() {
  const page = await openPage(`chrome-extension://${extId}/sidepanel/index.html`);
  for (let i = 0; i < 40; i++) {
    if ((await page.eval("typeof window.__ba")) === "object") {
      // Window isolation: these smokes drive tools against fixture tabs that
      // live in the browser's only window, so that window IS the agent's
      // window. Without this the agent would create its own second window and
      // work there, leaving every fixture assertion staring at about:blank.
      await page.eval(
        "chrome.windows.getCurrent().then((w) => __ba.bindWindow(w.id))",
      );
      return page;
    }
    await sleep(250);
    if (i === 39) throw new Error("panel page never became interactive");
  }
}

// ------------------------------ assertions ------------------------------

const results = { pass: true, checks: [] };
function check(name, ok, detail = "") {
  results.checks.push({ name, ok, detail: String(detail).slice(0, 300) });
  if (!ok) results.pass = false;
  log(ok ? "PASS" : "FAIL", name, String(detail).slice(0, 160));
}

async function waitDone(panel, ms = 45_000) {
  for (let i = 0; i < ms / 100; i++) {
    const evs = await panel.eval("JSON.stringify(__ba.events())").then(JSON.parse);
    if (evs.some((e) => e.kind === "done" || e.kind === "error")) return evs;
    await sleep(100);
  }
  throw new Error("run did not finish in time");
}

async function pollUntil(probe, ms = 20_000, stepMs = 200) {
  for (let i = 0; i < ms / stepMs; i++) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

function systemOf(body) {
  if (!body) return "";
  if (Array.isArray(body.system)) return body.system.map((b) => b?.text ?? "").join("\n");
  const sys = (body.messages ?? []).find((m) => m?.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
}

async function configure(panel, patch) {
  await panel.eval(`(async () => {
    const s = await __ba.getSettings();
    Object.assign(s, ${JSON.stringify(patch)});
    await __ba.setSettings(s);
    return "ok";
  })()`);
  await sleep(200);
}

const skillsOf = (panel) =>
  panel.eval("__ba.skills().then((s) => JSON.stringify(s))").then(JSON.parse);

/** Raw port round-trip (the same path the drawer uses). */
function portRoundTrip(panel, message, wantType) {
  return panel.eval(`(async () => {
    const port = chrome.runtime.connect({ name: "panel" });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { port.disconnect(); resolve(null); }, 8000);
      port.onMessage.addListener((msg) => {
        if (msg.type === ${JSON.stringify(wantType)}) { clearTimeout(timer); resolve(msg); port.disconnect(); }
      });
      port.postMessage(${JSON.stringify(message)});
    });
  })()`);
}

// ------------------------------ the run ------------------------------

async function main() {
  const servers = startFixtureServers();
  const mock = startMockLlm({
    script: [{ text: "Nothing to do — catalog check only." }],
    port: LLM_PORT,
  });
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
    const panel = await openPanel();
    await openPage(`${MAIN}/index.html`);
    await sleep(1_200);
    await configure(panel, {
      apiKeys: [
        {
          id: "k1",
          label: "mock",
          key: "test-key",
          provider: "openai-compatible",
          baseUrl: LLM,
          model: "mock-model",
        },
      ],
      activeKeyId: "k1",
      mode: "standard",
      sendScreenshots: false,
    });

    // ---- S1: the catalog rides the run; the heavy bodies do not ----
    await panel.eval(`__ba.run(${JSON.stringify(TASK)}); "started"`);
    await waitDone(panel);
    const sys = systemOf(mock.requests().at(-1));
    check(
      "S1a the system prompt carries the skills catalog with the use_skill instruction",
      sys.includes("On-demand procedures") && sys.includes("`use_skill`"),
      sys.slice(-300),
    );
    check(
      "S1b the doc-editor procedure BODY left the fixed prefix",
      !sys.includes("No tool can read it") && !sys.includes("/export?format=txt"),
      `prefix length: ${sys.length}`,
    );
    check(
      "S1c the prompt still points at the migrated procedure",
      sys.includes("`use_skill name:canvas-doc-editors`"),
      "",
    );

    // ---- S2: use_skill returns the body; unknown names list the catalog ----
    // graph-drag-widgets is split into sections; request one explicitly.
    const body = await panel.eval(
      `__ba.toolText("use_skill", ${JSON.stringify({ name: "graph-drag-widgets", section: "calibrate" })})`,
    );
    check(
      "S2a use_skill returns a section's body when asked for one",
      String(body).includes("CALIBRATE ONCE") || String(body).includes("calibrate"),
      String(body).slice(0, 120),
    );
    const missing = await panel.eval(
      `__ba.toolText("use_skill", ${JSON.stringify({ name: "no-such-skill" })})`,
    );
    check(
      "S2b an unknown skill names the catalog instead of failing silently",
      String(missing).includes("no skill named") && String(missing).includes("graph-drag-widgets"),
      String(missing).slice(0, 140),
    );

    // ---- S3: the drawer lists bundled skills and creates a user skill ----
    await panel.eval(`document.querySelector('[data-tip="Skills (procedures)"]')?.click(); "ok"`);
    const rows = await pollUntil(() =>
      panel
        .eval(`document.querySelectorAll(".lessons-view .lesson-row").length`)
        .then((n) => (n >= 4 ? n : null)),
    );
    check(
      "S3a the Skills drawer lists the bundled procedures",
      rows !== null && rows >= 4,
      `rows: ${rows}`,
    );
    await portRoundTrip(
      panel,
      {
        kind: "skills.new",
        skill: {
          name: "invoice-upload",
          whenToUse: "uploading invoice PDFs to the fixture portal",
          body: "1. click Upload\n2. pick the file",
          keywords: ["invoice"],
        },
      },
      "skills.list",
    );
    const stored = await pollUntil(async () => {
      const list = await skillsOf(panel);
      return list.some((s) => s.name === "invoice-upload") ? list : null;
    });
    check(
      "S3b a user skill created through the port persists in the store",
      stored !== null,
      `skills: ${stored?.map((s) => s.name).join(", ")}`,
    );

    // ---- S4: the new skill rides the next matching run's catalog ----
    mock.setScript([{ text: "done" }]);
    await panel.eval(`__ba.run("upload the invoice pdf like before"); "started"`);
    await waitDone(panel);
    const sys2 = systemOf(mock.requests().at(-1));
    check(
      "S4a a matching user skill makes the next run's catalog",
      sys2.includes("- invoice-upload — uploading invoice PDFs"),
      sys2.slice(-300),
    );

    // ---- S5: delete through the port ----
    const all = await skillsOf(panel);
    const id = all.find((s) => s.name === "invoice-upload")?.id;
    await portRoundTrip(panel, { kind: "skills.delete", id }, "skills.list");
    const gone = await pollUntil(async () =>
      (await skillsOf(panel)).every((s) => s.name !== "invoice-upload") ? "gone" : null,
    );
    check("S5 deleting a skill removes it from the store", gone === "gone", String(gone));

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
  console.error("[skills] fatal:", err);
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
});
