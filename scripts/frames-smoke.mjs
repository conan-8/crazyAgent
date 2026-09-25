#!/usr/bin/env node
// Iframe perception + frame-addressed evaluation — regression driver.
//
// Why this exists: a page's content is frequently NOT in the top document
// (Google Docs keeps it in a kix frame; school portals embed Docs/Slides in
// iframes). The old snapshot computed every frame's text and then kept only the
// main frame's, so the model could click a button inside an iframe but could not
// read a word of it — the failure mode behind a real run that burned dozens of
// turns on Schoology.
//
// Proves, against headless Edge and the real cross-origin fixture:
//   F1  an iframe's TEXT reaches the model through snapshot (not just read_page)
//   F2  the snapshot lists every frame with its id and URL, so refs are usable
//   F3  read_page labels frames and flags unreadable ones instead of faking ""
//   F4  evaluate_js runs INSIDE a frame via the frames tool's id mapping
//   F5  an unaddressable frame fails with a clear message, not a silent top-frame run
//   F6  canvas-only content is signalled as unreadable rather than looking empty
//   F7  a normal single-frame page is unaffected
//
// Usage: node scripts/frames-smoke.mjs   (run `npm run build` first)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { startFixtureServers } from "./fixture-server.mjs";

const PORT = 9241;
const PROFILE = "/tmp/ba-frames";
const CANVAS_PORT = 8807;
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

// A page whose ONLY content is painted into a canvas — the Google Docs shape.
const canvasServer = http.createServer((req, res) => {
  const which = new URL(req.url, "http://x").searchParams.get("v") ?? "canvas";
  res.writeHead(200, { "content-type": "text/html" });
  if (which === "canvas") {
    res.end(`<!doctype html><html><head><title>opaque</title></head><body>
      <canvas id="c" width="600" height="400"></canvas>
      <script>const x = document.getElementById("c").getContext("2d");
        x.fillStyle = "#fff"; x.fillRect(0,0,600,400);
        x.fillStyle = "#000"; x.font = "20px sans-serif"; x.fillText("DRAWN NOT DOM", 20, 40);</script>
      </body></html>`);
    return;
  }
  res.end(`<!doctype html><html><head><title>normal</title></head><body><h1>Ordinary page</h1><p>Plain DOM text here.</p></body></html>`);
});

function log(...args) {
  console.log("[frames]", ...args);
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
  canvasServer.listen(CANVAS_PORT, "127.0.0.1");
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
    const call = async (name, args = {}) =>
      JSON.parse(
        await panel.eval(
          `__ba.tool(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((r) => JSON.stringify(r))`,
        ),
      );
    /** The compact LLM-facing text a tool would hand the model. */
    const textOf = async (name, args = {}) =>
      panel.eval(
        `__ba.toolText(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((t) => String(t ?? ""))`,
      );

    const activate = async (url) => {
      await openPage(url);
      await sleep(2_000);
      const tabId = await panel.eval(
        `chrome.tabs.query({}).then((ts) => { const m = ts.filter((t) => !((t.url) || "").startsWith("chrome-extension://")); return m.length ? m[m.length - 1].id : -1; })`,
      );
      await panel.eval(`chrome.tabs.update(${tabId}, { active: true })`);
      await sleep(400);
      return tabId;
    };

    // ---------------- the cross-origin fixture ----------------
    await activate(`${MAIN}/index.html`);

    const snap = await call("snapshot");
    const snapshotText = await textOf("snapshot");
    check(
      "F1a the snapshot's text carries the IFRAME's content, not just the top document",
      snap.ok === true &&
        snapshotText.includes("Framed page (origin 8791)") &&
        snapshotText.includes("Fixture home"),
      snapshotText.slice(0, 240),
    );
    check(
      "F1b iframe text is labelled with its frame id and URL",
      /--- frame \d+ \(http:\/\/127\.0\.0\.1:8791\/framed\.html\) ---/.test(snapshotText),
      snapshotText.slice(0, 240),
    );
    check(
      "F2 the snapshot maps frame ids to URLs so refs like '9#2' are usable",
      /Frames:/.test(snapshotText) &&
        /frame \d+: 127\.0\.0\.1:8791/.test(snapshotText) &&
        /refs look like "\d+#n"/.test(snapshotText),
      snapshotText.slice(0, 300),
    );

    // The frame id the agent sees, taken from the refs themselves.
    const frameRef = snap.payload.elements.find((e) => e.ref.includes("#") && e.frameId !== 0)?.ref;
    const frameId = frameRef ? Number(frameRef.split("#")[0]) : -1;
    check(
      "F3 iframe elements still carry frame-scoped refs",
      frameId > 0,
      `ref: ${frameRef}`,
    );

    const frames = await call("frames");
    const frameText = await textOf("frames");
    check(
      "F4 the frames tool lists each frame with its URL and readability",
      frames.ok === true &&
        frameText.includes("/framed.html") &&
        /frame \d+:/.test(frameText) &&
        frames.payload.some((f) => f.frameId === frameId && f.instrumented === true),
      frameText.slice(0, 240),
    );

    // ---------------- frame-addressed evaluation ----------------
    // The embed's own script sets #frame-status when its button is clicked, so
    // reading that element proves the evaluation ran INSIDE the frame.
    const insideFrame = await call("evaluate_js", {
      expression: "document.getElementById('frame-status').textContent + '/' + location.port",
      frame: frameId,
    });
    check(
      "F5 evaluate_js runs INSIDE the iframe when given a frame id",
      insideFrame.ok === true &&
        insideFrame.payload?.ok === true &&
        insideFrame.payload.value.includes("8791"),
      JSON.stringify(insideFrame).slice(0, 220),
    );
    const topFrame = await call("evaluate_js", { expression: "location.port" });
    check(
      "F5b without a frame id it still evaluates in the top document",
      topFrame.ok === true && topFrame.payload?.value === '"8790"',
      JSON.stringify(topFrame).slice(0, 200),
    );
    const crossCheck = await call("evaluate_js", {
      expression: "document.getElementById('frame-status') === null",
    });
    check(
      "F5c the top document genuinely cannot see the frame's element (so F5 was real)",
      crossCheck.ok === true && crossCheck.payload?.value === "true",
      JSON.stringify(crossCheck).slice(0, 200),
    );
    const nowhere = await call("evaluate_js", { expression: "1+1", frame: 9999 });
    check(
      "F6 an unknown frame fails with a clear message instead of silently using the top frame",
      nowhere.ok === false && /no execution context for frame 9999/.test(JSON.stringify(nowhere)),
      JSON.stringify(nowhere).slice(0, 220),
    );

    // ---------------- read_page ----------------
    const read = await call("read_page");
    const readText = await textOf("read_page");
    check(
      "F7 read_page labels every frame with id and URL",
      read.ok === true &&
        /--- frame 0 \(/.test(readText) &&
        /--- frame \d+ \(http:\/\/127\.0\.0\.1:8791\/framed\.html\) ---/.test(readText),
      readText.slice(0, 260),
    );
    check(
      "F7b read_page reports instrumentation instead of pretending a frame is empty",
      read.payload.every((f) => typeof f.instrumented === "boolean") &&
        read.payload.some((f) => f.instrumented === true),
      JSON.stringify(read.payload.map((f) => [f.frameId, f.instrumented])).slice(0, 200),
    );

    // ---------------- canvas-only content is signalled, not silently empty ----------------
    await activate(`http://127.0.0.1:${CANVAS_PORT}/?v=canvas`);
    const canvasSnap = await textOf("snapshot");
    check(
      "F8 a canvas-rendered page is reported as unreadable rather than empty",
      /renders its content into a <canvas>/.test(canvasSnap) &&
        /cannot be read by any tool/.test(canvasSnap) &&
        /report that instead of retrying/.test(canvasSnap),
      canvasSnap.slice(0, 300),
    );
    const canvasRead = await textOf("read_page");
    check(
      "F8b read_page says the same thing for the canvas frame",
      /drawn into 1 <canvas>/.test(canvasRead),
      canvasRead.slice(0, 240),
    );

    // ---------------- a plain page is unaffected ----------------
    await activate(`http://127.0.0.1:${CANVAS_PORT}/?v=plain`);
    const plainSnap = await textOf("snapshot");
    check(
      "F9 an ordinary single-frame page renders exactly as before",
      plainSnap.includes("Ordinary page") &&
        plainSnap.includes("Plain DOM text here.") &&
        !plainSnap.includes("Frames:") &&
        !plainSnap.includes("<canvas>"),
      plainSnap.slice(0, 240),
    );

    panel.close();
  } finally {
    edge.kill("SIGTERM");
    canvasServer.close();
    fixtures.close();
    spawn("rm", ["-rf", PROFILE]).on("exit", () => {});
    await sleep(500);
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[frames] fatal:", err);
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
});