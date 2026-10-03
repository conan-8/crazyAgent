#!/usr/bin/env node
// Chat & history verification driver.
// Proves: chat bubbles (user/assistant) with collapsible tool cards, thread
// persistence to history, reopening a thread from the history overlay,
// multi-turn follow-ups carrying prior context to the LLM, new-chat thread
// separation, history deletion, and the composer's slash commands.
// Usage: node scripts/phase9-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9234;
const PROFILE = "/tmp/ba-phase9";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

const S_FLOW = [
  { text: "Navigating.", toolCalls: [{ name: "navigate", args: { url: `${MAIN}/docs.html` } }] },
  { text: "Settling.", toolCalls: [{ name: "wait_for_settle", args: { timeoutMs: 5000 } }] },
  { text: "Screenshot.", toolCalls: [{ name: "screenshot", args: {} }] },
  { text: "Reading.", toolCalls: [{ name: "read_page", args: {} }] },
  {
    text: "### Done\n\nDocs page captured with **bold** and `code`.\n\n- one\n- two",
  },
];

function log(...args) {
  console.log("[phase9]", ...args);
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
  const mock = startMockLlm({ script: S_FLOW, port: 8792 });
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
      baseUrl: "http://127.0.0.1:8792/v1",
      model: "mock-model",
      apiKey: "test-key",
      mode: "standard",
      stepCap: 40,
      sendScreenshots: true,
      cdpPort: 9222,
    }); "ok"`);

    // ---- H1: chat bubbles + tool cards render from a live run ----
    await panel.eval(`__ba.runTask("Summarize the docs page"); "started"`);
    await waitDone(panel);
    await sleep(300);
    const dom1 = await panel.eval(`JSON.stringify({
      users: document.querySelectorAll(".bubble-user").length,
      assistants: document.querySelectorAll(".bubble-assistant").length,
      cards: document.querySelectorAll(".card").length,
      hasText: document.body.innerText.includes("Docs page captured with"),
      hasTask: document.body.innerText.includes("Summarize the docs page"),
      mdBold: Boolean(document.querySelector(".md strong")),
      mdCode: Boolean(document.querySelector(".md code")),
      mdList: Boolean(document.querySelector(".md li")),
      mdHeading: Boolean(document.querySelector(".md h3")),
      answerBelowTools: (() => {
        const turn = document.querySelector(".bubble-assistant");
        const blocks = turn ? [...turn.children] : [];
        const lastMd = blocks.map((el) => el.classList.contains("md")).lastIndexOf(true);
        const firstCard = blocks.map((el) => el.classList.contains("card")).indexOf(true);
        return firstCard !== -1 && lastMd > firstCard;
      })(),
    })`).then(JSON.parse);
    check(
      "H1 chat bubbles, tool cards, rendered markdown below tools",
      dom1.users >= 1 && dom1.assistants >= 1 && dom1.cards >= 4 &&
        dom1.hasText && dom1.hasTask &&
        dom1.mdBold && dom1.mdCode && dom1.mdList && dom1.mdHeading &&
        dom1.answerBelowTools,
      JSON.stringify(dom1),
    );

    // ---- H2: thread persisted to history ----
    const convs1 = await panel.eval(`__ba.conversations().then(c => JSON.stringify(c))`).then(JSON.parse);
    const first = convs1[0];
    check(
      "H2 conversation persisted with turns and LLM context",
      convs1.length === 1 &&
        first?.title === "Summarize the docs page" &&
        first.turns.length >= 2 &&
        first.llm.length >= 2,
      `convs=${convs1.length} turns=${first?.turns?.length} llm=${first?.llm?.length}`,
    );

    // ---- H3: reopen the thread from the history overlay ----
    await panel.eval(`[...document.querySelectorAll(".topbar-actions button")].find(b => b.textContent.trim() === "History").click()`);
    await sleep(400);
    const histItems = await panel.eval(`document.querySelectorAll(".hist-item").length`);
    await panel.eval(`document.querySelector(".hist-item").click()`);
    // The sheet plays a ~300ms exit animation, so poll rather than assume.
    // 5s budget: inside `npm run verify` the box carries six prior browser
    // suites' worth of teardown, and a 2s window flaked under that load.
    let dom3 = { users: 0, overlayOpen: true };
    for (let i = 0; i < 50; i++) {
      dom3 = await panel.eval(`JSON.stringify({
        users: document.querySelectorAll(".bubble-user").length,
        overlayOpen: Boolean(document.querySelector(".history-view")),
      })`).then(JSON.parse);
      if (dom3.users >= 1 && !dom3.overlayOpen) break;
      await sleep(100);
    }
    check(
      "H3 history overlay reopens a thread",
      histItems >= 1 && dom3.users >= 1 && !dom3.overlayOpen,
      `items=${histItems} ${JSON.stringify(dom3)}`,
    );

    // ---- H4: follow-up turn continues the thread with prior context ----
    const firstId = await panel.eval(`__ba.currentConversation().then ? 0 : __ba.currentConversation().id`);
    await panel.eval(`__ba.runTask("Now expand the summary", ${JSON.stringify(firstId)}); "started"`);
    await waitDone(panel);
    const lastReq = mock.lastRequest();
    const reqText = JSON.stringify(lastReq?.messages ?? []);
    const convAfter = await panel.eval(`__ba.currentConversation().then ? 0 : JSON.stringify(__ba.currentConversation())`).then(JSON.parse);
    const userTurns = convAfter.turns.filter((t) => t.role === "user").map((t) => t.text);
    check(
      "H4 follow-up carries prior thread context to the LLM",
      reqText.includes("Summarize the docs page") &&
        reqText.includes("Now expand the summary") &&
        userTurns.length === 2,
      `users=${JSON.stringify(userTurns)}`,
    );

    // ---- H5: New chat opens a separate thread ----
    await panel.eval(`__ba.newChat(); "ok"`);
    await sleep(200);
    const welcome = await panel.eval(`Boolean(document.querySelector(".welcome"))`);
    await panel.eval(`__ba.runTask("Third task in a fresh thread"); "started"`);
    await waitDone(panel);
    const convs2 = await panel.eval(`__ba.conversations().then(c => JSON.stringify(c))`).then(JSON.parse);
    const fresh = convs2.find((c) => c.title === "Third task in a fresh thread");
    const continued = convs2.find((c) => c.title === "Summarize the docs page");
    check(
      "H5 new chat creates a separate thread",
      welcome === true && convs2.length === 2 && fresh && continued?.turns.filter((t) => t.role === "user").length === 2,
      `convs=${convs2.length} welcome=${welcome}`,
    );

    // ---- H6: delete from history ----
    await panel.eval(`__ba.deleteConversation(${JSON.stringify(fresh.id)}); "ok"`);
    await sleep(400);
    const convs3 = await panel.eval(`__ba.conversations().then(c => JSON.stringify(c))`).then(JSON.parse);
    check(
      "H6 history delete removes a thread",
      convs3.length === 1 && convs3[0]?.title === "Summarize the docs page",
      `convs=${convs3.length}`,
    );

    // ---- H7: control bar — live stats + model/attach ----
    mock.setScript(S_FLOW);
    await panel.eval(`__ba.runTask("Stats run"); "started"`);
    await sleep(900);
    const statsMid = await panel.eval(`JSON.stringify({
      timer: document.querySelector(".stat-timer")?.textContent ?? "",
      tokens: document.querySelector(".stat-tokens")?.textContent ?? "",
      noTps: !document.querySelector(".stat-tps"),
      ctx: document.querySelector(".stat-ctx")?.textContent ?? "",
    })`).then(JSON.parse);
    await waitDone(panel);
    const bar = await panel.eval(`JSON.stringify({
      hasModel: [...document.querySelectorAll(".chip-btn")].some((b) => b.textContent.includes("mock-model")),
      hasAttach: Boolean([...document.querySelectorAll("button")].find((b) => b.title === "Attach files")),
    })`).then(JSON.parse);
    // Reasoning effort is configured in Settings ("Reasoning effort"), not as
    // a control-bar chip — the bar carries model / attach. The tok/s stat was
    // removed: the bar shows timer, tokens and context only.
    check(
      "H7 control bar: live stats + model/attach",
      /\d:\d\d/.test(statsMid.timer) &&
        /tok/.test(statsMid.tokens) &&
        statsMid.noTps &&
        /ctx/.test(statsMid.ctx) &&
        bar.hasModel && bar.hasAttach,
      JSON.stringify({ statsMid, bar }),
    );

    // ---- H8: slash commands (autocomplete + /sessions /model /rename /new) ----
    const typeInput = (value) =>
      panel.eval(
        `(() => { const ta = document.querySelector('.task-input'); ta.focus(); ta.value = ${JSON.stringify(value)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`,
      );
    await typeInput("/");
    await sleep(300);
    const menuAll = await panel.eval(
      `document.querySelectorAll('.slash-menu .slash-item').length`,
    );
    await typeInput("/se");
    await sleep(250);
    const menuFiltered = await panel
      .eval(
        `JSON.stringify([...document.querySelectorAll('.slash-menu .slash-name')].map((e) => e.textContent))`,
      )
      .then(JSON.parse);
    check(
      "H8 slash autocomplete opens on / and filters while typing",
      menuAll === 4 &&
        menuFiltered.length === 1 &&
        menuFiltered[0].includes("sessions"),
      `all=${menuAll} filtered=${JSON.stringify(menuFiltered)}`,
    );

    // Enter on the selected row runs /sessions → the history sheet opens.
    await panel.eval(
      `(() => { const ta = document.querySelector('.task-input'); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()`,
    );
    await sleep(500);
    const histOpen = await panel.eval(
      `Boolean(document.querySelector('.history-view'))`,
    );
    await panel.eval(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
    await sleep(450);
    check(
      "H8b Enter runs /sessions (history sheet opens)",
      histOpen === true,
      `open=${histOpen}`,
    );

    // /model <name> switches the active connection's model (write-through).
    await panel.eval(`__ba.slash('/model other-model')`);
    await sleep(300);
    const modelAfter = await panel.eval(`__ba.getSettings().then((s) => s.model)`);
    await panel.eval(`__ba.slash('/model mock-model')`);
    await sleep(300);
    const modelBack = await panel.eval(`__ba.getSettings().then((s) => s.model)`);
    check(
      "H8c /model <name> switches the model",
      modelAfter === "other-model" && modelBack === "mock-model",
      `${modelAfter} → ${modelBack}`,
    );

    // /rename retitles the current thread in the view AND the store.
    await panel.eval(`__ba.slash('/rename Renamed by slash')`);
    await sleep(500);
    const titleLocal = await panel.eval(`__ba.currentConversation()?.title ?? ''`);
    const titleStored = await panel.eval(
      `__ba.conversations().then((cs) => cs.some((c) => c.title === 'Renamed by slash') ? 'found' : 'missing')`,
    );
    check(
      "H8d /rename retitles the thread (view + store)",
      titleLocal === "Renamed by slash" && titleStored === "found",
      `local=${titleLocal} stored=${titleStored}`,
    );

    // /new returns to the welcome screen.
    await panel.eval(`__ba.slash('/new')`);
    await sleep(300);
    const welcomeBack = await panel.eval(`Boolean(document.querySelector('.welcome'))`);
    check("H8e /new starts a new chat", welcomeBack === true, `welcome=${welcomeBack}`);

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
  console.error("[phase9] fatal:", err);
  process.exit(1);
});
