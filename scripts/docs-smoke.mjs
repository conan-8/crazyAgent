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
// A third thing was wrong and is pinned here now: the sink fixture accepted
// synthesised DOM events, so the smoke passed while the real editor would not
// have moved. A canvas editor keeps its model in JavaScript and only responds to
// the browser's editing pipeline, so `type`/`key` now send real keystrokes over
// CDP `Input.*` when they detect one (shared/trusted-input.ts) — and the fixture
// rejects and counts anything untrusted, which is what D3a..D3f assert. D9 keeps
// the honest other half: an ordinary input still takes the DOM path.
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

/**
 * evaluate_js hands back its value already JSON-stringified, so an expression
 * that itself returns JSON.stringify(...) arrives double-encoded. Unwrap both
 * layers; anything that is not an object becomes {}.
 */
function jsonOf(res) {
  let value = res?.payload?.value;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value && typeof value === "object" ? value : {};
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
    // The fixture's sink is STRICT: its document model (kept in the parent
    // frame, painted only into the canvas) accepts what a real editing pipeline
    // produces — trusted `beforeinput`/`keydown` — and counts everything else as
    // a rejection. So D3 passing means `type` really sent keystrokes through the
    // browser's input pipeline; D3f pins that the DOM-synthesising path cannot
    // edit the document.
    const typed = await call("type", { ref: sink.ref, text: "hello docs" });
    check(
      "D3 typing into the sink ref succeeds",
      typed.ok === true,
      JSON.stringify(typed).slice(0, 200),
    );
    check(
      "D3a it went as trusted keystrokes with focus verified, not as DOM events",
      typed.payload?.data?.mode === "trusted" && typed.payload?.data?.focusHeld === true,
      JSON.stringify(typed.payload ?? typed.error ?? null).slice(0, 260),
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

    // ---- D3d: a newline goes as a real Enter key, so paragraphs are paragraphs ----
    const para = await call("type", { ref: sink.ref, text: "\nsecond line" });
    await sleep(600);
    const modelRes = await call("evaluate_js", {
      expression:
        "JSON.stringify({p: window.__doc.paragraphs, w: document.getElementById('wordcount').textContent})",
    });
    const model = jsonOf(modelRes);
    check(
      "D3d a newline starts a new paragraph in the document model",
      para.ok === true &&
        Array.isArray(model.p) &&
        model.p.length === 2 &&
        model.p[1] === "second line" &&
        model.w === "4 words",
      JSON.stringify(model).slice(0, 220),
    );

    // ---- D3e: an editor shortcut reaches the model — only real keys do this ----
    const boldKey = await call("key", { ref: sink.ref, key: "Control+b" });
    await sleep(500);
    const boldAfterKey = await call("evaluate_js", {
      expression: "document.getElementById('status').textContent",
    });
    check(
      "D3e Ctrl+B reaches the editor model as a trusted shortcut",
      boldKey.ok === true &&
        boldKey.payload?.data?.mode === "trusted" &&
        /bold toggled/.test(String(boldAfterKey.payload?.value ?? "")),
      `${JSON.stringify(boldKey.payload ?? boldKey.error ?? null).slice(0, 160)} | status: ${String(boldAfterKey.payload?.value ?? "")}`,
    );

    // ---- D3f: the DOM-synthesising path is rejected, and the fixture says so ----
    // Reached through the top document (same-origin fixture) rather than
    // `evaluate_js frame:N`, so this asserts the sink's strictness and nothing
    // else — in-frame evaluation has its own coverage in frames-smoke.mjs.
    const synthetic = await call("evaluate_js", {
      expression: `(() => {
        const s = document.querySelector('iframe.docs-texteventtarget-iframe')
          .contentDocument.getElementById('sink');
        s.focus();
        s.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, cancelable:true, inputType:'insertText', data:'FAKE'}));
        s.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:'FAKE'}));
        return JSON.stringify({sinkText: s.textContent});
      })()`,
    });
    await sleep(500);
    const afterSynthetic = jsonOf(
      await call("evaluate_js", {
        expression:
          "JSON.stringify({p: window.__doc.paragraphs, r: document.getElementById('rejected').textContent, w: document.getElementById('wordcount').textContent})",
      }),
    );
    check(
      "D3f synthetic DOM events cannot edit the document and are counted as rejected",
      Array.isArray(afterSynthetic.p) &&
        afterSynthetic.p.length === 2 &&
        !JSON.stringify(afterSynthetic.p).includes("FAKE") &&
        /^[1-9]\d* rejected$/.test(String(afterSynthetic.r ?? "")) &&
        afterSynthetic.w === "4 words",
      `${JSON.stringify(afterSynthetic).slice(0, 220)} | synthetic call: ${String(synthetic.payload?.value ?? synthetic.error ?? "").slice(0, 120)}`,
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

    // ---- D9: an ordinary page keeps the DOM typing path (no hijack) ----
    // Trusted keystrokes are for canvas editors only: they insert at the caret
    // instead of replacing a value, which would break normal form filling.
    await call("navigate", { url: `${MAIN}/login.html` });
    await sleep(1500);
    const loginSnap = await call("snapshot");
    const username = loginSnap.payload?.elements?.find((e) => e.name === "Username");
    const domTyped = await call("type", { ref: username?.ref, text: "alice" });
    const domValue = await call("evaluate_js", {
      expression: "document.getElementById('username').value",
    });
    check(
      "D9 typing into a normal input still uses the DOM path and replaces the value",
      Boolean(username) &&
        domTyped.ok === true &&
        domTyped.payload?.data?.mode !== "trusted" &&
        domTyped.payload?.data?.value === "alice" &&
        String(domValue.payload?.value ?? "").includes("alice"),
      `ref: ${username?.ref} | result: ${JSON.stringify(domTyped.payload ?? domTyped.error ?? null).slice(0, 160)} | value: ${String(domValue.payload?.value ?? "")}`,
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