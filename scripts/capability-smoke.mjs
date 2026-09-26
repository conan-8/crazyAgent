#!/usr/bin/env node
// Capability parity with Claude in Chrome — regression driver for the tools
// that close the functional gaps: coordinate input (click_at/hover_at/drag_at/
// element_at), file upload, console/network reading, screenshot-to-disk,
// snapshot/read_page tuning, and the login/CAPTCHA human handoff.
//
// Proves, against headless Edge and the real fixtures:
//   C1  element_at reports what is under a point (canvas hit, viewport size)
//   C2  click_at reaches PAINTED canvas buttons — and the events arrive
//       isTrusted:true (the browser's input pipeline, not synthesized)
//   C3  drag_at presses at the start, moves through a path, releases at the end
//   C4  hover_at moves the pointer to the point (trusted)
//   C5  an out-of-bounds point fails INPUT-FAILED with the viewport bounds
//   C6  click_at is gated like click: "Buy now" by coordinate raises the same
//       purchase confirmation, and a denial leaves the page untouched
//   U1  upload attaches inline files (name/size/type + input & change events)
//   U2  upload attaches a path via the CDP DOM route
//   U3  upload is always gated (new `upload` rule)
//   N1  console_read captures what the page logged after capture started
//   N2  network_read lists the page's requests with status
//   N3  an empty buffer says so instead of claiming the page was clean
//   P1  snapshot filter:'interactive' drops the text digest; max_chars caps
//       with an explicit truncation note
//   P2  read_page ref:X reads one subtree, scoped and capped
//   S1  screenshot save_to_disk is gated and lands a .jpg in Downloads
//   H1  a CAPTCHA pauses the run with need_human and resumes on the user
//   H2  a sign-in FORM (password field) hands off too — and the tool does NOT
//       run; a promo button on the very same login page is not blocked
//   H3  the tiny invisible-recaptcha badge on an ordinary page is NOT a captcha
//   H4  one handoff per wall per run (no repeat prompts)
//   V1  the Settings drawer names the build's commit (build stamp)
//
// Usage: node scripts/capability-smoke.mjs   (run `npm run build` first)
import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { startFixtureServers } from "./fixture-server.mjs";

const PORT = 9246;
const PROFILE = "/tmp/ba-capability";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

function log(...args) {
  console.log("[capability]", ...args);
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
    const call = async (name, args = {}) =>
      JSON.parse(
        await panel.eval(
          `__ba.tool(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((r) => JSON.stringify(r))`,
        ),
      );
    const textOf = async (name, args = {}) =>
      panel.eval(
        `__ba.toolText(${JSON.stringify(name)}, ${JSON.stringify(args)}).then((t) => String(t ?? ""))`,
      );

    /** Open a fixture as the active tab; keep its CDP handle for page-side reads. */
    const activate = async (url) => {
      const page = await openPage(url);
      await sleep(1_500);
      const tabId = await panel.eval(
        `chrome.tabs.query({}).then((ts) => { const m = ts.filter((t) => !((t.url) || "").startsWith("chrome-extension://")); return m.length ? m[m.length - 1].id : -1; })`,
      );
      await panel.eval(`chrome.tabs.update(${tabId}, { active: true })`);
      await sleep(400);
      // Refs only exist once a snapshot populated the registry — the same
      // look-then-act rule the agent follows.
      await call("snapshot");
      return page;
    };

    const events = async () => JSON.parse(await panel.eval("JSON.stringify(__ba.events())"));
    /** Index into the event buffer right now — search only what arrives after. */
    const mark = async () => (await events()).length;

    /**
     * Fire a GATED call without awaiting it (it may pause for a confirmation
     * or human). The promise lives on `window`, not on `__ba` — the panel
     * rebuilds `__ba` on every render, which would drop it mid-flight.
     */
    const fireGated = async (name, args) => {
      await panel.eval(
        `window.__baPendingGated = __ba.toolGated(${JSON.stringify(name)}, ${JSON.stringify(args)}); "fired"`,
      );
    };
    const pendingGated = async () =>
      JSON.parse(
        await panel.eval(`window.__baPendingGated.then((r) => JSON.stringify(r ?? null))`),
      );
    const waitForFrom = async (from, pred, what, ms = 15_000) => {
      for (let i = 0; i < ms / 100; i++) {
        const hit = (await events()).slice(from).find(pred);
        if (hit) return hit;
        await sleep(100);
      }
      throw new Error(`no ${what} within ${ms}ms`);
    };
    const countFrom = async (from, kind) =>
      (await events()).slice(from).filter((e) => e.kind === kind).length;

    // ================= C: coordinate input =================
    const board = await activate(`${MAIN}/canvas-click.html`);
    const rect = JSON.parse(
      await board.eval("JSON.stringify(document.getElementById('board').getBoundingClientRect())"),
    );
    const at = (cx, cy) => ({ x: Math.round(rect.left + cx), y: Math.round(rect.top + cy) });

    const hit = await call("element_at", at(120, 64));
    check(
      "C1 element_at reports a canvas pixel surface under a painted button",
      hit.ok === true && hit.payload?.hit?.canvas === true && hit.payload?.viewport?.width > 0,
      JSON.stringify(hit.payload).slice(0, 220),
    );

    const clicked = await call("click_at", at(120, 64));
    const canvasEvents = JSON.parse(
      await board.eval("document.getElementById('status').textContent"),
    );
    const clickEv = canvasEvents.find((e) => e.type === "click");
    check(
      "C2 click_at lands on the painted button (canvas coords 120,64)",
      clicked.ok === true && Math.abs(clickEv?.x - 120) <= 3 && Math.abs(clickEv?.y - 64) <= 3,
      JSON.stringify(canvasEvents).slice(0, 220),
    );
    check(
      "C2b the click travelled the browser's input pipeline (isTrusted:true)",
      clickEv?.trusted === true,
      JSON.stringify(clickEv),
    );

    const dragged = await call("drag_at", {
      x: at(320, 160).x,
      y: at(320, 160).y,
      to_x: at(420, 220).x,
      to_y: at(420, 220).y,
    });
    const dragEvents = JSON.parse(
      await board.eval("document.getElementById('status').textContent"),
    );
    const down = dragEvents.filter((e) => e.type === "down").at(-1);
    const up = dragEvents.filter((e) => e.type === "up").at(-1);
    const lastMove = await board.eval("document.getElementById('hover').textContent");
    check(
      "C3 drag_at presses at (320,160), moves and releases at (420,220)",
      dragged.ok === true &&
        Math.abs((down?.x ?? 0) - 320) <= 3 &&
        Math.abs((down?.y ?? 0) - 160) <= 3 &&
        Math.abs((up?.x ?? 0) - 420) <= 3 &&
        Math.abs((up?.y ?? 0) - 220) <= 3 &&
        /move 420,220/.test(lastMove),
      `down=${JSON.stringify(down)} up=${JSON.stringify(up)} hover=${lastMove}`,
    );

    const hovered = await call("hover_at", at(120, 150));
    const hoverText = await board.eval("document.getElementById('hover').textContent");
    check(
      "C4 hover_at moves the pointer to the point (trusted)",
      hovered.ok === true && /move 120,150 trusted=true/.test(hoverText),
      hoverText,
    );

    const out = await call("click_at", { x: 9_999, y: 9_999 });
    check(
      "C5 an out-of-bounds point fails INPUT-FAILED and names the viewport bounds",
      out.ok === false && /INPUT-FAILED/.test(out.error ?? "") && /viewport/.test(out.error ?? ""),
      String(out.error).slice(0, 220),
    );

    // Policy parity: the same click by coordinate must raise the same gate.
    const buyRect = JSON.parse(
      await board.eval("JSON.stringify(document.getElementById('buy').getBoundingClientRect())"),
    );
    const buyPoint = {
      x: Math.round(buyRect.left + buyRect.width / 2),
      y: Math.round(buyRect.top + buyRect.height / 2),
    };
    const markC = await mark();
    await fireGated("click_at", buyPoint);
    const confirmC = await waitForFrom(markC, (e) => e.kind === "need_confirm", "confirm");
    await panel.eval(`__ba.resolveConfirm(${JSON.stringify(confirmC.id)}, false, false); "ok"`);
    const gatedC = await pendingGated();
    const buyStatus = await board.eval("document.getElementById('status').textContent");
    check(
      "C6 click_at is gated exactly like click (purchase rule); denial leaves the page untouched",
      confirmC.tool === "purchase" &&
        /Buy now/.test(confirmC.summary ?? "") &&
        gatedC?.ok === false &&
        buyStatus !== "BUY_CLICKED",
      `${confirmC.tool}: ${confirmC.summary} | ${JSON.stringify(gatedC).slice(0, 120)}`,
    );

    // ================= U: upload =================
    const uploadPage = await activate(`${MAIN}/upload.html`);
    const inline = await call("upload", {
      ref: "1",
      files: [
        { name: "notes.txt", mime: "text/plain", text: "hello from the agent" },
        { name: "data.bin", mime: "application/octet-stream", base64: "AAECAw==" },
      ],
    });
    const list1 = await uploadPage.eval("document.getElementById('list').textContent");
    const evs1 = await uploadPage.eval("document.getElementById('events').textContent");
    check(
      "U1 upload attaches inline files and fires input + change",
      inline.ok === true &&
        /notes\.txt 20 /.test(list1) &&
        /data\.bin 4 /.test(list1) &&
        /input/.test(evs1) &&
        /change/.test(evs1),
      `${JSON.stringify(inline.payload ?? inline.error).slice(0, 200)} | ${list1} | ${evs1}`,
    );

    writeFileSync("/tmp/ba-upload-path.txt", "path-routed file contents");
    const viaPath = await call("upload", {
      ref: "1",
      paths: ["/tmp/ba-upload-path.txt"],
    });
    const list2 = await uploadPage.eval("document.getElementById('list').textContent");
    check(
      "U2 upload attaches an absolute path via the CDP DOM route",
      viaPath.ok === true && /ba-upload-path\.txt 25 /.test(list2),
      `${JSON.stringify(viaPath.payload ?? viaPath.error).slice(0, 200)} | ${list2}`,
    );

    const markU = await mark();
    await fireGated("upload", {
      ref: "1",
      files: [{ name: "gated.txt", mime: "text/plain", text: "x" }],
    });
    const confirmU = await waitForFrom(markU, (e) => e.kind === "need_confirm", "upload confirm");
    check(
      "U3 upload is always gated (new `upload` rule, names the file)",
      confirmU.tool === "upload" && /gated\.txt/.test(confirmU.summary ?? ""),
      `${confirmU.tool}: ${confirmU.summary}`,
    );
    await panel.eval(`__ba.resolveConfirm(${JSON.stringify(confirmU.id)}, false, false); "ok"`);
    await pendingGated();

    // ================= N: console + network =================
    await activate(`${MAIN}/console-net.html`);
    const empty = await call("console_read");
    await call("click", { ref: "1" }); // the fixture's "log + fetch" button
    await sleep(800);
    const consoleRead = await textOf("console_read");
    const networkRead = await textOf("network_read");
    const debugRead = await textOf("console_read", { level: "debug" });
    check(
      "N1 console_read captures what the page logged after capture started",
      /fixture-log-line/.test(consoleRead) &&
        /fixture-warn-line/.test(consoleRead) &&
        /fixture-error-line/.test(consoleRead),
      consoleRead.slice(0, 220),
    );
    check(
      "N3 an empty buffer says so instead of claiming the page was clean",
      (empty.payload?.entries ?? []).length === 0 && /no console entries captured/.test(debugRead),
      `${JSON.stringify(empty.payload?.entries ?? []).slice(0, 80)} | ${debugRead.slice(0, 120)}`,
    );
    check(
      "N2 network_read lists the page's requests with status",
      /index\.html.*200/.test(networkRead),
      networkRead.slice(0, 220),
    );

    // ================= P: perception tuning =================
    const snapCompact = await textOf("snapshot", { filter: "interactive" });
    const truncated = await textOf("snapshot", { max_chars: 80 });
    const scoped = await textOf("read_page", { ref: "1", max_chars: 200 });
    check(
      "P1 filter:'interactive' drops the visible-text digest",
      !snapCompact.includes("Visible text:") && /Interactive elements/.test(snapCompact),
      snapCompact.slice(0, 160),
    );
    check(
      "P1b max_chars caps the output with an explicit truncation note",
      truncated.length < 400 && /\[snapshot truncated at 80 chars/.test(truncated),
      truncated.slice(-120),
    );
    check(
      "P2 read_page ref:X reads just that subtree (no snapshot furniture)",
      /--- 1 ---/.test(scoped) && !scoped.includes("Interactive elements"),
      scoped.slice(0, 160),
    );

    // ================= S: screenshot to disk =================
    const markS = await mark();
    await fireGated("screenshot", { save_to_disk: true });
    const confirmS = await waitForFrom(markS, (e) => e.kind === "need_confirm", "screenshot confirm");
    await panel.eval(`__ba.resolveConfirm(${JSON.stringify(confirmS.id)}, true, false); "ok"`);
    const gatedS = await pendingGated();
    check(
      "S1 save_to_disk is gated (download rule) and lands a .jpg",
      confirmS.tool === "download" &&
        gatedS?.ok === true &&
        /^screenshot-.*\.jpg$/.test(gatedS?.payload?.saved?.filename ?? ""),
      `${confirmS.tool} | ${JSON.stringify(gatedS?.payload?.saved ?? gatedS).slice(0, 160)}`,
    );

    // ================= H: human handoff =================
    await activate(`${MAIN}/captcha.html`);
    const markH1 = await mark();
    await fireGated("click", { ref: "1" }); // Continue, under the captcha widget
    const humanH1 = await waitForFrom(markH1, (e) => e.kind === "need_human", "need_human");
    await panel.eval(`__ba.resolveHuman(${JSON.stringify(humanH1.id)}, true); "ok"`);
    const gatedH1 = await pendingGated();
    check(
      "H1 a CAPTCHA pauses the run with need_human and resumes on the user",
      /CAPTCHA/.test(humanH1.reason ?? "") &&
        gatedH1?.ok === true &&
        /user took over/.test(gatedH1?.text ?? ""),
      `${humanH1.reason} | ${String(gatedH1?.text ?? "").slice(0, 160)}`,
    );

    const loginPage = await activate(`${MAIN}/login.html`);
    const markH2 = await mark();
    await fireGated("type", { ref: "2", text: "hunter2" }); // the password field
    const confirmH2 = await waitForFrom(markH2, (e) => e.kind === "need_confirm", "password confirm");
    await panel.eval(`__ba.resolveConfirm(${JSON.stringify(confirmH2.id)}, true, false); "ok"`);
    const humanH2 = await waitForFrom(markH2, (e) => e.kind === "need_human", "need_human");
    await panel.eval(`__ba.resolveHuman(${JSON.stringify(humanH2.id)}, false); "ok"`);
    const gatedH2 = await pendingGated();
    const pwValue = await loginPage.eval("document.getElementById('password').value");
    check(
      "H2 typing into a sign-in form hands off — and the tool does NOT run",
      /sign-in/.test(humanH2.reason ?? "") &&
        /let you try/.test(gatedH2?.text ?? "") &&
        pwValue !== "hunter2",
      `${humanH2.reason} | pw=${JSON.stringify(pwValue)} | ${String(gatedH2?.text ?? "").slice(0, 120)}`,
    );

    const markH2b = await mark();
    await fireGated("click", { ref: "4" }); // "Upgrade plan" — same login page
    const gatedPromo = await pendingGated();
    check(
      "H2b a promo button on the very same login page is NOT blocked",
      gatedPromo?.ok === true && (await countFrom(markH2b, "need_human")) === 0,
      JSON.stringify(gatedPromo).slice(0, 160),
    );

    // One prompt per wall per run: the same login page must not ask again.
    const markH4 = await mark();
    await fireGated("type", { ref: "2", text: "again" });
    const confirmH4 = await waitForFrom(markH4, (e) => e.kind === "need_confirm", "confirm");
    await panel.eval(`__ba.resolveConfirm(${JSON.stringify(confirmH4.id)}, true, false); "ok"`);
    const gatedH4 = await pendingGated();
    check(
      "H4 one handoff per wall per run — the second attempt just runs",
      gatedH4?.ok === true && (await countFrom(markH4, "need_human")) === 0,
      `human events after mark: ${await countFrom(markH4, "need_human")}`,
    );

    await activate(`${MAIN}/console-net.html`);
    const markH3 = await mark();
    const badgeClick = await call("click", { ref: "1" });
    check(
      "H3 the tiny invisible-recaptcha badge is not a captcha (no handoff)",
      badgeClick.ok === true && (await countFrom(markH3, "need_human")) === 0,
      `human events: ${await countFrom(markH3, "need_human")}`,
    );

    // ================= V: build identity =================
    // The point of a stamped build: the loaded extension names its own commit,
    // so "am I on the right version?" is answerable from Settings (and from
    // chrome://extensions) instead of by faith.
    const headSha = execSync("git rev-parse --short=7 HEAD", {
      cwd: new URL("..", import.meta.url).pathname,
    })
      .toString()
      .trim();
    const distManifest = JSON.parse(
      readFileSync(new URL("../dist/manifest.json", import.meta.url), "utf8"),
    );
    await panel.eval(
      `(() => { [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "⚙")?.click(); return "opened"; })()`,
    );
    let versionLine = "";
    for (let i = 0; i < 20 && !versionLine; i++) {
      versionLine = await panel.eval(`document.querySelector(".version-line")?.textContent ?? ""`);
      if (!versionLine) await sleep(100);
    }
    check(
      "V1 Settings names the build's commit (and dist/manifest.json carries the same stamp)",
      versionLine.includes(headSha) &&
        String(distManifest.version_name ?? "").includes(headSha),
      `${versionLine} | manifest version_name=${distManifest.version_name}`,
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
  console.error("[capability] fatal:", err);
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
});
