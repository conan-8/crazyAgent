#!/usr/bin/env node
// Phase 5+6 verification driver.
// Phase 5: configure settings through the real drawer UI, run a task from the
// task input, watch tool cards live, stop mid-run from the UI, and see a
// provider switch take effect without reload.
// Phase 6: confirmation flow — deny → cancellation the model can work around,
// allow once → proceeds, always allow → subsequent runs never prompt.
// Usage: node scripts/phase56-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9229;
const PROFILE = "/tmp/ba-phase56";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

const typePw = { name: "type", args: { ref: "2", text: "hunter2" } };

const S_FLOW = [
  { text: "Navigating.", toolCalls: [{ name: "navigate", args: { url: `${MAIN}/docs.html` } }] },
  { text: "Settling.", toolCalls: [{ name: "wait_for_settle", args: { timeoutMs: 5000 } }] },
  { text: "Screenshot.", toolCalls: [{ name: "screenshot", args: {} }] },
  { text: "Reading.", toolCalls: [{ name: "read_page", args: {} }] },
  { text: "Done: docs page captured." },
];
const S_STOP = [
  { delayMs: 2_000, text: "Slow start.", toolCalls: [{ name: "navigate", args: { url: `${MAIN}/docs.html` } }] },
  { text: "Done: finished." },
];
const S_GATE = [
  { text: "Navigating to login.", toolCalls: [{ name: "navigate", args: { url: `${MAIN}/login.html` } }] },
  { text: "Settling.", toolCalls: [{ name: "wait_for_settle", args: { timeoutMs: 5000 } }] },
  { text: "Looking at the form.", toolCalls: [{ name: "snapshot", args: {} }] },
  { text: "Entering the password now.", toolCalls: [{ ...typePw }] },
  { text: "FINAL_SENTINEL" }, // replaced per scenario
];

function log(...args) {
  console.log("[phase56]", ...args);
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

/** Wait for the run to hit a need_confirm and resolve it per `choice`. */
async function driveConfirm(panel, choice) {
  const resolved = new Set();
  for (let i = 0; i < 200; i++) {
    const evs = await panel.eval("JSON.stringify(__ba.events())").then(JSON.parse);
    const pending = evs.find(
      (e) => e.kind === "need_confirm" && !resolved.has(e.id),
    );
    if (pending) {
      resolved.add(pending.id);
      await panel.eval(
        `__ba.resolveConfirm(${JSON.stringify(pending.id)}, ${choice.allow}, ${choice.always}); "ok"`,
      );
      return "confirm";
    }
    if (evs.some((e) => e.kind === "done")) return "done";
    await sleep(100);
  }
  throw new Error("no confirm/done within 20s");
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

    // ================= Phase 5: UI-driven flow =================

    // P1 — configure settings through the drawer UI (DOM interactions).
    await panel.eval(`
      (() => {
        const setVal = (el, v) => {
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        const buttons = [...document.querySelectorAll("button")];
        buttons.find((b) => b.textContent.trim() === "⚙").click();
        return "opened";
      })()
    `);
    const drawerReady = await panel.eval(`(async () => {
      for (let i = 0; i < 20; i++) {
        if (document.querySelectorAll(".drawer input").length >= 4) return "ready";
        await new Promise((r) => setTimeout(r, 100));
      }
      return document.querySelector(".drawer")?.innerHTML ?? "(no drawer)";
    })()`);
    check("P5-0 settings drawer renders its fields", drawerReady === "ready", drawerReady.slice(0, 120));
    // Connections start empty, so the drawer shows "Add connection" and no card
    // exists yet. Create one, expand it, then address fields by their visible
    // label — positional `inputs[n]` indexing silently hit the global fields
    // ("Context window", "Max output / call") once this layout landed.
    await panel.eval(`
      (() => {
        const drawer = document.querySelector(".drawer");
        if (!drawer.querySelector(".key-label-btn")) drawer.querySelector(".keys-add")?.click();
        return "added";
      })()
    `);
    let expanded = "no-card";
    for (let i = 0; i < 20; i++) {
      const hasCard = await panel.eval(`Boolean(document.querySelector(".drawer .key-label-btn"))`);
      if (hasCard) {
        // A new card starts collapsed — open it so its fields mount.
        await panel.eval(`
          (() => {
            const d = document.querySelector(".drawer");
            if (!d.querySelector(".key-body")) d.querySelector(".key-label-btn")?.click();
            return "toggled";
          })()
        `);
      }
      expanded = await panel.eval(
        `document.querySelector(".drawer .key-body") ? "open" : "closed"`,
      );
      if (expanded === "open") break;
      await sleep(150);
    }
    check("P5-0b connection card expands to reveal its fields", expanded === "open", expanded);
    // Set field values first; Preact state flushes on a later tick, so the
    // Save click MUST be a separate step or it saves the stale defaults.
    // Fill one field per tick. Each handler calls patch(), which rebuilds the
// keys array from the closure captured at render time — firing all three
// input events in one synchronous block makes them read the same stale
// array, so only the last write survives.
    const setField = (label, value) =>
      panel.eval(`
        (() => {
          const scope = document.querySelector(".drawer .key-body")
            ?? document.querySelector(".drawer");
          const f = [...scope.querySelectorAll(".field")].find(
            (f) => f.querySelector("span")?.textContent?.trim() === ${JSON.stringify(label)},
          );
          const el = f?.querySelector("input");
          if (!el) return "missing";
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return "ok";
        })()
      `);
    const rBase = await setField("Base URL", "http://127.0.0.1:8792/v1");
    await sleep(150);
    const rModel = await setField("Model", "mock-model");
    await sleep(150);
    const rKey = await setField("API key", "test-key");
    await sleep(150);
    const filled = rBase === "ok" && rModel === "ok" && rKey === "ok"
      ? "filled"
      : `missing:${rBase}/${rModel}/${rKey}`;
    await panel.eval(`
      (() => {
        const selects = document.querySelector(".drawer").querySelectorAll("select");
        selects[0].value = "openai-compatible";
        selects[0].dispatchEvent(new Event("change", { bubbles: true }));
        return "provider set";
      })()
    `);
    check("P5-0c connection fields addressed by label", filled === "filled", filled.slice(0, 200));
    await sleep(200);
    await panel.eval(`
      [...document.querySelector(".drawer").querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Save")
        .click()
    `);
    await sleep(400);
    const saved = await panel.eval("__ba.getSettings().then(s => JSON.stringify(s))").then(JSON.parse);
    check(
      "P5-1 settings configured through the drawer UI",
      saved.provider === "openai-compatible" &&
        saved.baseUrl === "http://127.0.0.1:8792/v1" &&
        saved.model === "mock-model" &&
        saved.apiKey === "test-key",
      `${saved.provider} ${saved.model}`,
    );

    // P2 — run a task typed into the task input; tool cards appear live.
    mock.setScript(S_FLOW);
    await panel.eval(`
      (() => {
        const input = document.querySelector(".task-input");
        input.value = "Capture the docs page";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return "typed";
      })()
    `);
    await sleep(150);
    await panel.eval(`
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Run")
        .click()
    `);
    let cardsSeen = 0;
    for (let i = 0; i < 50; i++) {
      cardsSeen = Math.max(
        cardsSeen,
        await panel.eval("document.querySelectorAll('.card').length"),
      );
      const running = await panel.eval("__ba.queryState().then(s => s.running)");
      if (!running && i > 5) break;
      await sleep(150);
    }
    const evsFlow = await waitDone(panel);
    check(
      "P5-2 task ran from the UI with live tool cards",
      cardsSeen >= 4 &&
        evsFlow.some((e) => e.kind === "done" && e.summary.includes("docs page captured")) &&
        !evsFlow.some((e) => e.kind === "error"),
      `cards=${cardsSeen}`,
    );

    // P3 — Stop button halts a run mid-flight.
    // Chat UX: the composer continues the open thread and clears the input on
    // send — like a real user, start a fresh thread and re-type the task.
    mock.setScript(S_STOP);
    await panel.eval(`__ba.newChat(); "ok"`);
    await panel.eval(`
      (() => {
        const input = document.querySelector(".task-input");
        input.value = "Stop me midway";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return "typed";
      })()
    `);
    await sleep(150);
    await panel.eval(`
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Run")
        .click()
    `);
    await sleep(700);
    await panel.eval(`
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Stop")
        .click()
    `);
    const evsStop = await waitDone(panel, 8_000);
    check(
      "P5-3 Stop button halts the run",
      evsStop.some((e) => e.kind === "done" && e.summary.includes("stopped")) &&
        !evsStop.some((e) => e.kind === "error"),
      evsStop.at(-1)?.summary ?? "",
    );

    // P4 — provider switch takes effect without reload.
    const anthBefore = mock.hits().anthropic;
    mock.setScript(S_FLOW);
    await panel.eval(`
      (() => {
        if (document.querySelector(".drawer")) return "already-open";
        [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "⚙").click();
        return "opened";
      })()
    `);
    await sleep(300);
    await panel.eval(`
      (() => {
        const setSel = (el, v) => {
          el.value = v;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const setVal = (el, v) => {
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        const drawer = document.querySelector(".drawer");
        setSel(drawer.querySelectorAll("select")[0], "anthropic");
        setVal(drawer.querySelectorAll("input")[0], "http://127.0.0.1:8792/anthropic/v1");
        return "filled";
      })()
    `);
    await sleep(200);
    await panel.eval(`
      [...document.querySelector(".drawer").querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Save")
        .click()
    `);
    await sleep(300);
    await panel.eval(`__ba.runTask("Capture the docs page again"); "started"`);
    await waitDone(panel);
    check(
      "P5-4 provider switch effective without reload",
      mock.hits().anthropic > anthBefore,
      `anthropic hits ${anthBefore} → ${mock.hits().anthropic}`,
    );

    // ================= Phase 6: confirmation flow =================

    // P5 — deny: cancellation the model can work around.
    mock.setScript([
      ...S_GATE.slice(0, 4),
      { text: "Understood — I stopped and will not enter the password." },
    ]);
    await panel.eval(`__ba.runTask("Log in with my saved password"); "started"`);
    const kind1 = await driveConfirm(panel, { allow: false, always: false });
    const evsDeny = await waitDone(panel);
    const deniedResult = evsDeny.find((e) => e.kind === "tool_result" && e.name === "type");
    check(
      "P6-1 password typing prompts for confirmation",
      kind1 === "confirm",
    );
    check(
      "P6-2 deny returns a cancellation the model can work around",
      deniedResult?.ok === false &&
        String(deniedResult.result).includes("denied") &&
        evsDeny.some((e) => e.kind === "done" && e.summary.includes("Understood")),
      deniedResult?.result ?? "",
    );

    // P6 — allow once: proceeds exactly once.
    mock.setScript([
      ...S_GATE.slice(0, 4),
      { text: "Done: password entered." },
    ]);
    await panel.eval(`__ba.runTask("Log in again"); "started"`);
    const kind2 = await driveConfirm(panel, { allow: true, always: false });
    const evsOnce = await waitDone(panel);
    check(
      "P6-3 allow once proceeds",
      kind2 === "confirm" &&
        evsOnce.some((e) => e.kind === "tool_result" && e.name === "type" && e.ok === true),
    );

    // P7 — always allow: persisted, so the next run never prompts.
    await panel.eval(`__ba.runTask("Log in a third time"); "started"`);
    const kind3 = await driveConfirm(panel, { allow: true, always: true });
    await waitDone(panel);
    await panel.eval(`__ba.runTask("Log in a fourth time"); "started"`);
    const evs4 = await waitDone(panel);
    const prompts4 = evs4.filter((e) => e.kind === "need_confirm").length;
    check(
      "P6-4 always-allow persists and suppresses future prompts",
      kind3 === "confirm" &&
        prompts4 === 0 &&
        evs4.some((e) => e.kind === "tool_result" && e.name === "type" && e.ok === true),
      `prompts on suppressed run: ${prompts4}`,
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
  console.error("[phase56] fatal:", err);
  process.exit(1);
});
