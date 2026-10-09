#!/usr/bin/env node
// Live plan (todo_write) verification driver: the REAL agent loop against a
// scripted mock LLM, watched through the REAL panel DOM. Proves: the plan
// strip appears under the topbar on the first update (without covering the
// run), it opens a full-width plan sheet and closes again, the strip tracks
// progress mid-run (whole-list replacements land live), the checkpoint
// carries the plan, and the run log keeps the final snapshot.
// Usage: node scripts/todo-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9248;
const LLM_PORT = 8798;
const PROFILE = "/tmp/ba-todo";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";
const LLM = `http://127.0.0.1:${LLM_PORT}/v1`;

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

// The scripted "model": plan first, work, re-plan as it goes, finish. One
// tool call per turn — the mock advances one script step per tool result.
const plan = (statuses) => ({
  name: "todo_write",
  args: {
    todos: [
      { content: "Open the docs page", status: statuses[0] },
      { content: "Read the page text", status: statuses[1] },
      { content: "Summarize findings", status: statuses[2] },
    ],
  },
});
const SCRIPT = [
  { text: "Planning the work.", toolCalls: [plan(["in_progress", "pending", "pending"])] },
  { delayMs: 2_000, text: "Opening the page.", toolCalls: [{ name: "navigate", args: { url: `${MAIN}/docs.html` } }] },
  { delayMs: 2_000, text: "Page open, moving on.", toolCalls: [plan(["completed", "in_progress", "pending"])] },
  { delayMs: 2_000, text: "Read it, wrapping up.", toolCalls: [plan(["completed", "completed", "completed"])] },
  { text: "Summary: the docs page contains Lorem ipsum dolor sit amet." },
];

function log(...args) {
  console.log("[todo-smoke]", ...args);
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
    if ((await page.eval("typeof window.__ba")) === "object") {
      // The fixture tab lives in the browser's only window, so that window IS
      // the agent's window (same trick the other smokes use).
      await page.eval(
        "chrome.windows.getCurrent().then((w) => __ba.bindWindow(w.id))",
      );
      return page;
    }
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

/** Poll a panel expression until it stops being null/false-y (or time out). */
async function pollUntil(fn, ms = 15_000) {
  for (let i = 0; i < ms / 150; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  return null;
}

/** The plan strip + sheet DOM state, as one JSON blob. */
const domOf = (panel) =>
  panel.eval(`(() => {
    const bar = document.querySelector(".todo-bar");
    if (!bar) return null;
    const sheet = document.querySelector('.sheet-layer[data-state="open"] .todo-sheet');
    return JSON.stringify({
      open: Boolean(sheet),
      fullWidth: sheet ? Math.abs(sheet.getBoundingClientRect().width - window.innerWidth) < 2 : null,
      count: bar.querySelector(".todo-count")?.textContent ?? "",
      current: bar.querySelector(".todo-current")?.textContent ?? "",
      items: [...(sheet?.querySelectorAll(".todo-item") ?? [])].map((li) => ({
        cls: [...li.classList].filter((c) => c.startsWith("is-"))[0] ?? "",
        text: li.querySelector(".todo-text")?.textContent ?? "",
      })),
    });
  })()`).then((s) => (s ? JSON.parse(s) : null));

async function waitDone(panel, ms = 40_000) {
  for (let i = 0; i < ms / 100; i++) {
    const evs = await panel.eval("JSON.stringify(__ba.events())").then(JSON.parse);
    if (evs.some((e) => e.kind === "done" || e.kind === "error")) return evs;
    await sleep(100);
  }
  throw new Error("run did not finish in time");
}

async function main() {
  const servers = startFixtureServers();
  const mock = startMockLlm({ script: SCRIPT, port: LLM_PORT });
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
    const tabId = await panel.eval(
      `chrome.tabs.query({ url: "${MAIN}/*" }).then(ts => ts[0]?.id ?? -1)`,
    );
    await panel.eval(`chrome.tabs.update(${tabId}, { active: true })`);

    // Point the agent at the mock LLM.
    await panel.eval(`(async () => {
      const s = await __ba.getSettings();
      Object.assign(s, ${JSON.stringify({
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
        learn: { enabled: false, auto: false },
      })});
      await __ba.setSettings(s);
      return "ok";
    })()`);
    await sleep(300);

    // T0 — the tool spec reaches the model (the plan is a first-class tool).
    await panel.eval(`__ba.runTask("Capture and summarize the docs page"); "started"`);

    // T1 — the first todo_update mounts the strip (0/3); the sheet stays shut
    // so the plan never covers the run uninvited.
    const first = await pollUntil(() => domOf(panel));
    check(
      "T1 plan strip appears on the first todo_update, sheet closed",
      Boolean(first) && first.open === false && first.count === "0/3",
      JSON.stringify(first),
    );
    check(
      "T1c the strip names the item in flight",
      first?.current === "Open the docs page",
      first?.current,
    );

    // T2 — clicking the strip opens the full-width plan sheet.
    await panel.eval(`document.querySelector(".todo-strip").click(); "clicked"`);
    const opened = await pollUntil(async () => {
      const d = await domOf(panel);
      return d?.open ? d : null;
    });
    check(
      "T2 clicking the strip opens a full-width plan sheet",
      opened?.open === true && opened.fullWidth === true,
      JSON.stringify(opened),
    );
    check(
      "T1b the sheet renders every item with status classes",
      Boolean(opened) &&
        opened.items.length === 3 &&
        opened.items[0].cls === "is-in_progress" &&
        opened.items[1].cls === "is-pending" &&
        opened.items[0].text === "Open the docs page",
      JSON.stringify(opened?.items),
    );
    await panel.eval(`document.querySelector(".todo-sheet .sheet-head button").click(); "closed"`);
    await sleep(400);
    const collapsed = await domOf(panel);
    check("T2b the sheet's close button dismisses it", collapsed?.open === false);

    // T3 — the next whole-list replacement lands live WITHOUT reopening the
    // sheet (the navigate turn's 2s delay keeps the run active).
    const progressed = await pollUntil(async () => {
      const d = await domOf(panel);
      return d && d.count === "1/3" ? d : null;
    });
    check(
      "T3 progress updates mid-run (1/3, item 2 in flight)",
      progressed?.count === "1/3" &&
        progressed.current === "Read the page text" &&
        progressed.open === false,
      JSON.stringify(progressed),
    );

    // T7 — the checkpoint carries the plan WHILE the run is live (it is
    // cleared when the run ends, so this must land before waitDone): a
    // panel reconnecting mid-run restores the dropdown from it.
    const cp = await pollUntil(async () => {
      const todos = await panel
        .eval(`__ba.queryState().then((s) => JSON.stringify(s.checkpoint?.todos ?? null))`)
        .then(JSON.parse);
      return Array.isArray(todos) && todos[0]?.status === "completed" ? todos : null;
    });
    check(
      "T7 the checkpoint persists the live plan (resume/reconnect path)",
      cp?.length === 3 &&
        cp[0].status === "completed" &&
        cp[1].status === "in_progress" &&
        cp[2].status === "pending",
      JSON.stringify(cp),
    );

    // Let the run finish: the final replacement marks everything done.
    const evs = await waitDone(panel);
    await pollUntil(async () => (await domOf(panel))?.count === "3/3");
    await panel.eval(`document.querySelector(".todo-strip").click(); "clicked"`);
    const final = await pollUntil(async () => {
      const d = await domOf(panel);
      return d && d.open && d.items.length ? d : null;
    });
    check(
      "T4 the finished run keeps its final plan (3/3, all done)",
      final?.count === "3/3" &&
        final.current === "All done" &&
        final.items.every((t) => t.cls === "is-completed"),
      JSON.stringify(final),
    );

    // T5 — the event stream carried whole-list replacements.
    const updates = evs.filter((e) => e.kind === "todo_update");
    check(
      "T5 three whole-list todo_update events streamed to the panel",
      updates.length === 3 &&
        updates[0].items.length === 3 &&
        updates[2].items.every((t) => t.status === "completed"),
      `updates: ${updates.length}`,
    );

    // T6 — the model saw the tool and got the compact confirmation back.
    const specs = mock.requests()[0]?.tools ?? [];
    check(
      "T6 todo_write rides the tool specs",
      specs.some((t) => (t.function ?? t).name === "todo_write"),
    );
    const confirmations = evs
      .filter((e) => e.kind === "tool_result" && e.name === "todo_write")
      .map((e) => e.result);
    check(
      "T6b the model-facing result is the one-line summary",
      confirmations.length === 3 &&
        confirmations[0].includes("0/3 done, now: Open the docs page") &&
        confirmations[2].includes("3/3 done"),
      JSON.stringify(confirmations),
    );

    // T8 — the run log keeps the final snapshot (flush is debounced: poll).
    const logged = await pollUntil(async () => {
      const logs = await panel
        .eval("__ba.logs().then((l) => JSON.stringify(l))")
        .then(JSON.parse);
      return logs[0]?.todos?.length ? logs[0].todos : null;
    });
    check(
      "T8 the run log stores the plan's final state",
      logged?.length === 3 && logged.every((t) => t.status === "completed"),
      JSON.stringify(logged ?? null),
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
  console.error("[todo-smoke] fatal:", err);
  process.exit(1);
});
