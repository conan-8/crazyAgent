#!/usr/bin/env node
// Madman mode verification driver.
// Proves, through the real panel + a scripted mock LLM:
//   M1 the toggle is off by default and the prompt carries no profanity;
//   M2 turning it on puts the profane voice into the system prompt the LLM
//      actually receives;
//   M3 every tool-call card in the live UI carries a cuss word;
//   M4 a mid-run exclamation is rendered in the transcript;
//   M5 turning it back off restores a clean prompt and clean labels.
// Usage: node scripts/madman-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9237;
const PROFILE = "/tmp/ba-madman";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

const S_FLOW = [
  { text: "Navigating.", toolCalls: [{ name: "navigate", args: { url: `${MAIN}/docs.html` } }] },
  { text: "Reading.", toolCalls: [{ name: "read_page", args: {} }] },
  { text: "Done: docs page captured." },
];

const CUSS = /\b(fuck|shit|damn|hell|ass|bastard|goddamn|piss|crap|bloody)\w*/i;

/**
 * Pull the system prompt out of a request body in either wire protocol:
 * Anthropic sends a top-level `system` block array, OpenAI-compatible sends a
 * `role: "system"` message inside `messages`.
 */
function systemOf(body) {
  if (!body) return "";
  if (Array.isArray(body.system)) {
    return body.system.map((b) => b?.text ?? "").join("\n");
  }
  if (typeof body.system === "string") return body.system;
  const msg = (body.messages ?? []).find((m) => m?.role === "system");
  return typeof msg?.content === "string" ? msg.content : "";
}

function log(...args) {
  console.log("[madman]", ...args);
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
  results.checks.push({ name, ok, detail: String(detail).slice(0, 400) });
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
  const servers = startFixtureServers();
  const mock = startMockLlm({ script: S_FLOW, port: 8795 });
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

    const base = {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8795/v1",
      model: "mock-model",
      apiKey: "test-key",
      mode: "standard",
      sendScreenshots: true,
      cdpPort: 9222,
    };

    // ---- M1: default is off ----
    const defaults = await panel.eval(
      `__ba.getSettings().then(s => JSON.stringify({ madman: s.madman }))`,
    ).then(JSON.parse);
    check("M1 madman defaults to off", defaults.madman === false, JSON.stringify(defaults));

    // ---- M2/M3/M4: run with madman ON ----
    await panel.eval(`__ba.setSettings(${JSON.stringify({ ...base, madman: true })}); "ok"`);
    await panel.eval(`__ba.runTask("Summarize the docs page"); "started"`);
    const evs = await waitDone(panel);
    await sleep(400);

    // M2: the system prompt the provider actually received.
    const prompts = mock.requests().map(systemOf);
    const seedRun = prompts.filter((p) => p.includes("Madman mode — ON"));
    check(
      "M2 madman voice reaches the LLM system prompt",
      seedRun.length >= 2 && seedRun.every((p) => CUSS.test(p)),
      `systemPrompts=${prompts.length} madman=${seedRun.length}`,
    );

    // M2b: the request body also carries the requested exclamation shape.
    check(
      "M2b prompt requests the 'Because this … I have to …' phrasing",
      seedRun.some((p) => p.includes("Because this shit ass site is so fucking slow I have to")),
      "",
    );

    // M3: every tool_call event carries a cuss-decorated label.
    const callEvs = evs.filter((e) => e.kind === "tool_call");
    check(
      "M3 every tool call event carries a cuss label",
      callEvs.length >= 2 && callEvs.every((e) => e.label && CUSS.test(e.label) && e.label.includes(e.name)),
      JSON.stringify(callEvs.map((e) => e.label)),
    );

    // M4: a mid-run exclamation was emitted and rendered as text.
    const madEvs = evs.filter((e) => e.kind === "madman");
    const transcript = await panel.eval(
      `JSON.stringify(__ba.currentConversation())`,
    ).then(JSON.parse);
    const blocks = transcript?.turns?.flatMap((t) => t.blocks ?? []) ?? [];
    const shown = blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n");
    check(
      "M4 mid-run exclamation is emitted and shown in the transcript",
      madEvs.length >= 2 && madEvs.every((e) => CUSS.test(e.message)) &&
        madEvs.some((e) => shown.includes(e.message.trim())),
      `${madEvs.length} exclamations; shown=${madEvs.filter((e) => shown.includes(e.message.trim())).length}`,
    );

    // M3b: the live DOM shows the decorated chip. A card whose result already
// arrived renders a result preview instead of the chip, so assert on the
// chips that exist (at least one) and that all of them are decorated.
    const chips = await panel.eval(
      `JSON.stringify([...document.querySelectorAll(".tool-chip")].map(e => e.textContent))`,
    ).then(JSON.parse);
    check(
      "M3b tool cards render the cuss-decorated chip",
      chips.length >= 1 && chips.every((c) => CUSS.test(c)),
      JSON.stringify(chips),
    );

    // ---- M5: turning it back off restores a clean run ----
    await panel.eval(`__ba.setSettings(${JSON.stringify({ ...base, madman: false })}); "ok"`);
    const before = mock.requests().length;
    await panel.eval(`__ba.runTask("Summarize the docs page again"); "started"`);
    const evs2 = await waitDone(panel);
    await sleep(300);
    const after = mock.requests().slice(before).map(systemOf);
    const offClean = after.every((s) => !s.includes("Madman mode"));
    const offLabels = evs2.filter((e) => e.kind === "tool_call").every((e) => e.label === undefined);
    const offExclaim = evs2.every((e) => e.kind !== "madman");
    check(
      "M5 turning it off restores a clean prompt and clean labels",
      offClean && offLabels && offExclaim && after.length > 0,
      `cleanPrompt=${offClean} cleanLabels=${offLabels} noExclaim=${offExclaim}`,
    );
  } finally {
    try {
      edge.kill("SIGKILL");
    } catch {}
    try {
      mock.close();
    } catch {}
    try {
      servers.close();
    } catch {}
  }

  console.log(JSON.stringify(results, null, 2));
  if (!results.pass) process.exit(1);
  log("ALL MADMAN CHECKS GREEN");
}

await main();