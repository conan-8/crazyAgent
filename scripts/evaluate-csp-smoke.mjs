#!/usr/bin/env node
// evaluate_js vs Content-Security-Policy — regression driver.
//
// Why this exists: the agent used to evaluate JS by injecting `eval()` into the
// page's ISOLATED world via chrome.scripting. A site whose CSP omits
// 'unsafe-eval' (Google Docs, Schoology, most school portals) refuses that, and
// the run would burn turns retrying it — the log this was written from shows
// 7/7 evaluate_js calls failing with exactly that EvalError. `evaluate_js` now
// runs over CDP in the page's MAIN world, which is not subject to that gate.
//
// The old path is reproduced here side by side so this can never silently come
// back: if someone re-implements evaluate_js on top of executeScript+eval, the
// OLD-path check below starts passing and the whole point is gone.
//
// Usage: node scripts/evaluate-csp-smoke.mjs   (run `npm run build` first)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";

const PORT = 9240;
const PROFILE = "/tmp/ba-eval-csp";
const CSP_PORT = 8806;
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
/** The directive shape Google Docs actually serves (taken from a user's run log). */
const DOCS_CSP =
  "script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:*";
/** A deliberately hostile policy: nonce-only, strict-dynamic, no unsafe-eval. */
const STRICT_CSP = "default-src 'self'; script-src 'nonce-abc123' 'strict-dynamic'; object-src 'none'";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

const PAGE = `<!doctype html><html><head><title>csp fixture</title></head>
<body><h1 id="title">docs-like page</h1><p id="body">readable body text</p>
<button id="b">Press</button></body></html>`;

const server = http.createServer((req, res) => {
  const which = new URL(req.url, "http://x").searchParams.get("csp") ?? "docs";
  const headers = { "content-type": "text/html" };
  if (which === "docs") headers["content-security-policy"] = DOCS_CSP;
  if (which === "strict") headers["content-security-policy"] = STRICT_CSP;
  if (which === "meta") {
    // CSP declared by <meta> instead of a header — the shape Docs' HTML views use.
    res.writeHead(200, headers);
    res.end(
      PAGE.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${DOCS_CSP}">`),
    );
    return;
  }
  res.writeHead(200, headers);
  res.end(PAGE);
});

function log(...args) {
  console.log("[eval-csp]", ...args);
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
  server.listen(CSP_PORT, "127.0.0.1");
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
    const call = async (name, args) =>
      JSON.parse(
        await panel.eval(`__ba.tool(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((r) => JSON.stringify(r))`),
      );

    for (const variant of ["docs", "strict", "meta", "plain"]) {
      await openPage(`http://127.0.0.1:${CSP_PORT}/?csp=${variant}`);
      await sleep(1_000);
      const tabId = await panel.eval(
        `chrome.tabs.query({}).then((ts) => { const m = ts.filter((t) => !((t.url) || "").startsWith("chrome-extension://")); return m.length ? m[m.length - 1].id : -1; })`,
      );
      await panel.eval(`chrome.tabs.update(${tabId}, { active: true })`);
      await sleep(400);

      // 1) The tool evaluates a real DOM read on a CSP-protected page.
      const read = await call("evaluate_js", {
        expression: "document.getElementById('title').textContent + '|' + document.getElementById('body').textContent",
      });
      check(
        `E1 evaluate_js reads the DOM under CSP=${variant}`,
        read?.ok === true && read.payload?.value?.includes("docs-like page|readable body text"),
        JSON.stringify(read).slice(0, 200),
      );

      // 2) A promise is awaited (Docs work is usually async).
      const async = await call("evaluate_js", {
        expression: "Promise.resolve(document.querySelectorAll('button').length)",
      });
      check(
        `E2 promises are awaited under CSP=${variant}`,
        async?.ok === true && async.payload?.value === "1",
        JSON.stringify(async).slice(0, 160),
      );

      // 3) A genuine JS error still surfaces as a JS error. Note this arrives as
      //    a rejected tool call (`ok:false` at the tool level) whose message
      //    carries the thrown TypeError — the CSP marker must NOT be on it, or
      //    the model would chase a CSP retry for an ordinary bug in its code.
      const boom = await call("evaluate_js", { expression: "null.boom" });
      const boomText = `${boom?.error ?? ""}${JSON.stringify(boom?.payload ?? "")}`;
      check(
        `E3 a real JS error is reported as a JS error under CSP=${variant}`,
        boom?.ok === false &&
          /TypeError/.test(boomText) &&
          !/CSP-BLOCKED/.test(boomText),
        JSON.stringify(boom).slice(0, 200),
      );

      // 4) The old implementation is still refuted here. This runs the OLD
      //    evaluate_js implementation verbatim (executeScript + eval in the
      //    isolated world) so the fixture provably still reproduces the bug the
      //    tool was fixed for: whatever the page's own policy, the EXTENSION's
      //    CSP (script-src 'self') refuses eval in its isolated world. If this
      //    ever stops being refused, this regression test has gone stale.
      const isolated = await panel.eval(`(async () => {
        const r = await chrome.scripting.executeScript({
          target: { tabId: ${tabId}, frameIds: [0] },
          func: (expr) => { try { return { ok: true, value: String(eval(expr)) }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } },
          args: ["1+1"],
        });
        return JSON.stringify(r[0]?.result ?? null);
      })()`);
      const isolatedResult = JSON.parse(isolated);
      check(
        `E4 the old isolated-world eval() is refused even under CSP=${variant}`,
        isolatedResult?.ok === false &&
          /unsafe-eval|Content Security Policy/i.test(isolatedResult.error ?? ""),
        JSON.stringify(isolatedResult).slice(0, 200),
      );
    }

    // 5) The plain (no-CSP) page keeps working — the fix must not be a special case.
    const plainPage = await openPage(`http://127.0.0.1:${CSP_PORT}/?csp=plain`);
    await sleep(800);
    const plainTab = await panel.eval(
      `chrome.tabs.query({}).then((ts) => { const m = ts.filter((t) => !((t.url) || "").startsWith("chrome-extension://")); return m.length ? m[m.length - 1].id : -1; })`,
    );
    await panel.eval(`chrome.tabs.update(${plainTab}, { active: true })`);
    await sleep(400);
    const plain = await call("evaluate_js", { expression: "'no-csp ok'" });
    check(
      "E5 a page without CSP is unaffected",
      plain?.ok === true && plain.payload?.value === '"no-csp ok"',
      JSON.stringify(plain).slice(0, 160),
    );

    // 6) bypass_csp still lifts the policy for the tab (the documented escape hatch).
    const bypass = await call("evaluate_js", { expression: "'ok'", bypass_csp: true });
    check(
      "E6 bypass_csp still reports the tab as bypassed",
      bypass?.ok === true && typeof bypass.payload?.cspBypass === "string",
      JSON.stringify(bypass).slice(0, 200),
    );

    plainPage.close();
    panel.close();
  } finally {
    edge.kill("SIGTERM");
    server.close();
    spawn("rm", ["-rf", PROFILE]).on("exit", () => {});
    await sleep(500);
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[eval-csp] fatal:", err);
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
});