#!/usr/bin/env node
// Phase 1 verification driver. Launches Edge with the built extension and
// drives the panel page over CDP to prove:
//   A) keepalive — a running task survives SW idle teardown (worker
//      `startedAt` stays constant across minutes of idle), and
//   B) checkpoint/resume — after the SW is left to die (keepalive suspended,
//      panel closed), reopening the panel resumes the task from its
//      checkpoint in a NEW worker instance.
// Usage: node scripts/phase1-smoke.mjs [quick|full]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "quick";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_PATH = path.join(root, "dist");
const PORT = 9224;
const PROFILE = "/tmp/ba-phase1";

// Scenario parameters
const A = mode === "full"
  ? { steps: 20, intervalMs: 30_000, watchMs: 620_000, sampleMs: 75_000 } // the real 10-min task
  : { steps: 20, intervalMs: 5_000, watchMs: 45_000, sampleMs: 30_000 };
const B = { steps: 20, intervalMs: 40_000 };

function log(...args) {
  console.log("[phase1]", ...args);
}

async function cdpGet(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  return res.json();
}

// Unpacked extension IDs are the first 16 bytes of sha256(abs path of the
// extension dir), hex-mapped to a–p. Deterministic, so no target probing
// (the SW target is only visible while the worker is awake).
function deriveExtensionId(absExtPath) {
  const hex = createHash("sha256").update(absExtPath).digest("hex").slice(0, 32);
  return [...hex]
    .map((c) => String.fromCharCode(parseInt(c, 16) + 97))
    .join("");
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
      throw new Error(`eval failed: ${JSON.stringify(res.result.exceptionDetails)}`);
    }
    return res.result?.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function openPanelPage(extId) {
  // Edge's /json/new ignores the url param, so: fresh tab, then CDP navigate.
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new`, {
    method: "PUT",
  }).then((r) => r.json());
  const page = new CdpPage(created.webSocketDebuggerUrl);
  await page.open();
  await page.send("Page.enable");
  await page.send("Page.navigate", {
    url: `chrome-extension://${extId}/sidepanel/index.html`,
  });
  for (let i = 0; i < 40; i++) {
    const ready = await page.eval("typeof window.__ba");
    if (ready === "object") break;
    await sleep(250);
    if (i === 39) throw new Error("panel page never became interactive");
  }
  return { page, targetId: created.id };
}

async function closeTarget(targetId) {
  await fetch(`http://127.0.0.1:${PORT}/json/close/${targetId}`).catch(() => {});
}

/** Stop the task and wait until the worker confirms the run has ended. */
async function stopAndWait(page) {
  await page.eval(`__ba.stop(); "stopped"`).catch(() => {});
  for (let i = 0; i < 60; i++) {
    const st = JSON.parse(
      await page.eval("__ba.queryState().then(s => JSON.stringify(s))"),
    );
    if (!st.running) return;
    await sleep(500);
  }
  throw new Error("task did not stop within 30s");
}

const results = { pass: true, checks: [] };
function check(name, ok, detail = "") {
  results.checks.push({ name, ok, detail });
  if (!ok) results.pass = false;
  log(ok ? "PASS" : "FAIL", name, detail);
}

async function main() {
  spawn("rm", ["-rf", PROFILE]).on("exit", async () => {});
  await sleep(300); // let the profile cleanup land
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
    { stdio: "ignore", detached: false },
  );
  try {
    // Wait for the CDP endpoint to come up.
    let up = false;
    for (let i = 0; i < 60; i++) {
      up = await fetch(`http://127.0.0.1:${PORT}/json/version`)
        .then(() => true)
        .catch(() => false);
      if (up) break;
      await sleep(500);
    }
    if (!up) throw new Error("browser CDP endpoint never came up");

    const extId = deriveExtensionId(EXT_PATH);
    log("extension id:", extId);

    // ---------- Scenario A: keepalive ----------
    log(`scenario A: ${A.steps} steps × ${A.intervalMs}ms, watching ${A.watchMs}ms`);
    log("A: opening panel page…");
    let { page, targetId } = await openPanelPage(extId);
    log("A: panel page ready; reading worker id…");
    const before = await page.eval("__ba.swPing().then(r => r.startedAt)");
    log(`A: worker startedAt=${before}; starting task…`);
    await page.eval(
      `__ba.onEvent(() => {}); __ba.run({ steps: ${A.steps}, intervalMs: ${A.intervalMs} }); "started"`,
    );
    await sleep(A.sampleMs);
    const freshA = JSON.parse(
      await page.eval("__ba.queryState().then(s => JSON.stringify(s))"),
    );
    check(
      "A3 checkpoint advanced during the run",
      (freshA.checkpoint?.stepIndex ?? 0) >= 1,
      `stepIndex=${freshA.checkpoint?.stepIndex}`,
    );
    await sleep(A.watchMs - A.sampleMs);
    const ping = await page.eval("__ba.swPing().then(r => r.startedAt)");
    const pings = await page.eval("__ba.state().pings");
    check(
      "A1 worker survived idle teardown during the run",
      ping === before,
      `startedAt ${before} → ${ping}`,
    );
    check(
      "A2 panel keepalive pings were delivered",
      pings >= Math.floor((A.watchMs - 1) / 20_000),
      `pings=${pings}`,
    );
    await stopAndWait(page);
    page.close();
    await closeTarget(targetId);

    // ---------- Scenario B: teardown + checkpoint/resume ----------
    log("scenario B: suspend keepalive, kill worker, verify resume");
    log("B: opening panel page…");
    ({ page, targetId } = await openPanelPage(extId));
    log("B: starting long task…");
    const oldStartedAt = await page.eval("__ba.swPing().then(r => r.startedAt)");
    await page.eval(`__ba.run({ steps: ${B.steps}, intervalMs: ${B.intervalMs} }); "started"`);
    await sleep(3_000);
    await page.eval(`__ba.suspendKeepalive(); "suspended"`);
    page.close();
    await closeTarget(targetId); // no pings, no alarms → SW dies ~30s idle
    log("panel closed; waiting for worker teardown…");
    await sleep(45_000);

    log("B: reopening panel page…");
    ({ page, targetId } = await openPanelPage(extId));
    log("B: collecting resume evidence…");
    await sleep(3_000);
    const parsedB = JSON.parse(
      await page.eval(
        "JSON.stringify(__ba.events())",
      ),
    );
    const stateB = JSON.parse(
      await page.eval("__ba.queryState().then(s => JSON.stringify(s))"),
    );
    const newStartedAt = await page.eval("__ba.swPing().then(r => r.startedAt)");
    check(
      "B1 worker really died and a fresh one started",
      newStartedAt !== oldStartedAt,
      `startedAt ${oldStartedAt} → ${newStartedAt}`,
    );
    check(
      "B2 task resumed from its checkpoint",
      parsedB.some((e) => e.kind === "info" && e.message.includes("resumed from checkpoint")),
      JSON.stringify(parsedB.slice(0, 3)),
    );
    const idxAfterResume = stateB.checkpoint?.stepIndex ?? 0;
    await sleep(50_000);
    const later = JSON.parse(
      await page.eval("__ba.queryState().then(s => JSON.stringify(s))"),
    );
    check(
      "B3 resumed task keeps making progress",
      (later.checkpoint?.stepIndex ?? 0) > idxAfterResume,
      `stepIndex ${idxAfterResume} → ${later.checkpoint?.stepIndex}`,
    );
    await stopAndWait(page);
    page.close();
    await closeTarget(targetId);
  } finally {
    edge.kill("SIGTERM");
    await sleep(1_000);
    spawn("rm", ["-rf", PROFILE]).on("exit", () => {});
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[phase1] fatal:", err);
  process.exit(1);
});
