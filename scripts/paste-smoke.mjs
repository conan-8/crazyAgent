#!/usr/bin/env node
// Image shelf + paste_image — the "screenshot here → send it into another
// page there" pipe, proven against headless Edge and a chat-app-shaped
// fixture (contenteditable composer, Kimi-style hidden file input, dropzone).
//
//   P1  every screenshot stages itself as shot_N (the result names the id)
//   P2  paste_image via:'file' attaches the staged bytes to a hidden
//      <input type="file"> — real change event, right name/size/type, no disk
//   P3  paste_image (auto, no ref) delivers a synthetic paste into the
//      focused composer, and the consuming handler counts as handled
//   P4  a dropzone that ignores paste gets the drop fallback (route: drop)
//   P5  paste_image is gated under the SAME `upload` rule; denial delivers
//      nothing
//   P6  upload paths: a path the browser cannot read now FAILS LOUDLY with
//      the read-back count (the silent DOM.setFileInputFiles no-op that burned
//      a real run three uploads in a row)
//   P7  screenshot save_to_disk reports the ABSOLUTE path of the written file
//   P8  (best-effort) via:'clipboard' writes the OS clipboard through the
//      offscreen document and sends a trusted Ctrl+V — SKIPped with a note
//      when the headless environment refuses clipboard access
//   P9  an unknown shelf id fails INPUT-FAILED and says what to do
//
// Usage: node scripts/paste-smoke.mjs   (run `npm run build` first)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { startFixtureServers } from "./fixture-server.mjs";

const PORT = 9247;
const PROFILE = "/tmp/ba-paste";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

function log(...args) {
  console.log("[paste]", ...args);
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

const results = { pass: true, checks: [], skips: [] };
function check(name, ok, detail = "") {
  results.checks.push({ name, ok, detail: String(detail).slice(0, 300) });
  if (!ok) results.pass = false;
  log(ok ? "PASS" : "FAIL", name, String(detail).slice(0, 200));
}
function skip(name, why) {
  results.skips.push({ name, why: String(why).slice(0, 300) });
  log("SKIP", name, String(why).slice(0, 200));
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
    // Window isolation: these smokes drive tools against fixture tabs that live
    // in the browser's only window, so that window IS the agent's window.
    // Without this the agent would create its own second window and work there,
    // leaving every fixture assertion staring at about:blank.
    await panel.eval("chrome.windows.getCurrent().then((w) => __ba.bindWindow(w.id))");
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

    const activate = async (url) => {
      const page = await openPage(url);
      await sleep(1_500);
      const tabId = await panel.eval(
        `chrome.tabs.query({}).then((ts) => { const m = ts.filter((t) => !((t.url) || "").startsWith("chrome-extension://")); return m.length ? m[m.length - 1].id : -1; })`,
      );
      await panel.eval(`chrome.tabs.update(${tabId}, { active: true })`);
      await sleep(400);
      // Window isolation: switch the agent's tracked tab to this fixture.
      await call("tabs_switch", { tabId });
      await call("snapshot");
      return page;
    };

    const events = async () => JSON.parse(await panel.eval("JSON.stringify(__ba.events())"));
    const mark = async () => (await events()).length;
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

    const page = await activate(`${MAIN}/paste-target.html`);
    const pasteLog = async () => JSON.parse(await page.eval("JSON.stringify(window.__pasteLog)"));
    const snapText = await textOf("snapshot");
    const refOf = (re) => (snapText.match(re)?.[1] ?? "");
    const inputRef = refOf(/(\d+#\d+|\d+)\s+input\[file\][^\n]*"Attachment"/);
    const composerRef = refOf(/(\d+#\d+|\d+)\s+div\s+"Message"/);
    const zoneRef = refOf(/(\d+#\d+|\d+)\s+div\s+"Dropzone"/);
    if (!inputRef || !composerRef || !zoneRef) {
      throw new Error(
        `fixture refs not found in snapshot (input=${inputRef} composer=${composerRef} zone=${zoneRef}):\n${snapText.slice(0, 800)}`,
      );
    }

    // ============ P1: screenshots stage themselves ============
    const shotText = await textOf("screenshot");
    const shotId = shotText.match(/staged as (shot_\d+)/)?.[1] ?? "";
    check(
      "P1 screenshot stages the capture on the shelf and names the id",
      /^shot_\d+$/.test(shotId),
      shotText.slice(0, 220),
    );

    // ============ P2: via:'file' into the hidden input ============
    const toFile = await call("paste_image", { via: "file", ref: inputRef });
    const logP2 = await pasteLog();
    const change = logP2.find((e) => e.type === "change");
    check(
      "P2 paste_image via:'file' attaches the staged bytes to the hidden input (change event, real name/size/type)",
      toFile.ok === true &&
        toFile.payload?.route === "file" &&
        change?.files?.[0]?.type === "image/jpeg" &&
        /^screenshot-.*\.jpg$/.test(change?.files?.[0]?.name ?? "") &&
        change.files[0].size > 1000,
      `${JSON.stringify(toFile.payload ?? toFile.error).slice(0, 160)} | ${JSON.stringify(change ?? null).slice(0, 160)}`,
    );

    // ============ P3: auto paste into the focused composer ============
    await page.eval("document.getElementById('composer').focus(); 'focused'");
    const toComposer = await call("paste_image", { ref: composerRef });
    const logP3 = await pasteLog();
    const pasteEv = logP3.filter((e) => e.type === "paste").at(-1);
    check(
      "P3 paste_image delivers a synthetic paste into the composer; the consuming handler counts as handled",
      toComposer.ok === true &&
        toComposer.payload?.route === "paste" &&
        toComposer.payload?.handled === true &&
        pasteEv?.trusted === false &&
        pasteEv?.files?.[0]?.type === "image/jpeg",
      `${JSON.stringify(toComposer.payload ?? toComposer.error).slice(0, 160)} | ${JSON.stringify(pasteEv ?? null).slice(0, 160)}`,
    );

    // ============ P4: dropzone gets the drop fallback ============
    const toZone = await call("paste_image", { ref: zoneRef });
    const logP4 = await pasteLog();
    const dropEv = logP4.filter((e) => e.type === "drop").at(-1);
    check(
      "P4 a dropzone that ignores paste gets the drop fallback (route: drop)",
      toZone.ok === true &&
        toZone.payload?.route === "drop" &&
        toZone.payload?.handled === true &&
        toZone.payload?.events?.join("+") === "paste+drop" &&
        dropEv?.files?.[0]?.type === "image/jpeg",
      `${JSON.stringify(toZone.payload ?? toZone.error).slice(0, 160)} | ${JSON.stringify(dropEv ?? null).slice(0, 140)}`,
    );

    // ============ P5: gated under the upload rule ============
    const logBeforeP5 = (await pasteLog()).length;
    const markP5 = await mark();
    await fireGated("paste_image", { image: shotId, ref: composerRef });
    const confirmP5 = await waitForFrom(markP5, (e) => e.kind === "need_confirm", "paste confirm");
    await panel.eval(`__ba.resolveConfirm(${JSON.stringify(confirmP5.id)}, false, false); "ok"`);
    const gatedP5 = await pendingGated();
    const logAfterP5 = (await pasteLog()).length;
    check(
      "P5 paste_image is gated under the `upload` rule; denial delivers nothing",
      confirmP5.tool === "upload" &&
        /shot_/.test(confirmP5.summary ?? "") &&
        gatedP5?.ok === false &&
        logAfterP5 === logBeforeP5,
      `${confirmP5.tool}: ${confirmP5.summary} | ${JSON.stringify(gatedP5).slice(0, 100)}`,
    );

    // ============ P6: upload paths fails loudly on unreadable paths ============
    const missing = await call("upload", {
      ref: inputRef,
      paths: ["/nonexistent/ba-missing-file.jpg"],
    });
    check(
      "P6 upload paths: an unreadable path fails with the read-back evidence and points at paste_image",
      missing.ok === false &&
        /INPUT-FAILED/.test(missing.error ?? "") &&
        /(reads as 0 bytes|attached 0 of 1)/.test(missing.error ?? "") &&
        /paste_image/.test(missing.error ?? ""),
      String(missing.error ?? JSON.stringify(missing)).slice(0, 240),
    );

    // ============ P7: save_to_disk reports the absolute path ============
    const markP7 = await mark();
    await fireGated("screenshot", { save_to_disk: true });
    const confirmP7 = await waitForFrom(markP7, (e) => e.kind === "need_confirm", "save confirm");
    await panel.eval(`__ba.resolveConfirm(${JSON.stringify(confirmP7.id)}, true, false); "ok"`);
    const gatedP7 = await pendingGated();
    const savedPath = gatedP7?.payload?.saved?.path ?? "";
    check(
      "P7 save_to_disk reports the absolute path of the written file (and it exists)",
      gatedP7?.ok === true &&
        typeof savedPath === "string" &&
        savedPath.startsWith("/") &&
        existsSync(savedPath),
      `${JSON.stringify(gatedP7?.payload?.saved ?? gatedP7).slice(0, 200)} | exists=${savedPath ? existsSync(savedPath) : false}`,
    );

    // ============ P8: OS clipboard + trusted Ctrl+V (best-effort) ============
    await page.eval("document.getElementById('composer').focus(); 'focused'");
    const viaClipboard = await call("paste_image", { via: "clipboard", image: shotId });
    if (viaClipboard.ok === true) {
      await sleep(1_200);
      const logP8 = await pasteLog();
      const trustedPaste = logP8.find((e) => e.type === "paste" && e.trusted === true);
      if (trustedPaste?.files?.length) {
        check(
          "P8 via:'clipboard' writes the OS clipboard and a trusted Ctrl+V pastes the image",
          trustedPaste.files[0].type.startsWith("image/"),
          JSON.stringify(trustedPaste).slice(0, 200),
        );
      } else {
        skip(
          "P8 via:'clipboard' (trusted paste leg)",
          `clipboard write + Ctrl+V succeeded but no trusted paste with files reached the page (headless clipboard reads are commonly refused) — result: ${JSON.stringify(viaClipboard.payload).slice(0, 160)}`,
        );
      }
    } else {
      skip(
        "P8 via:'clipboard'",
        `OS clipboard unavailable in this environment: ${String(viaClipboard.error).slice(0, 200)}`,
      );
    }

    // ============ P9: unknown shelf id ============
    const unknown = await call("paste_image", { image: "shot_9999" });
    check(
      "P9 an unknown shelf id fails INPUT-FAILED and says what to do",
      unknown.ok === false &&
        /INPUT-FAILED/.test(unknown.error ?? "") &&
        /screenshot/.test(unknown.error ?? ""),
      String(unknown.error ?? "").slice(0, 220),
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
  console.error("[paste] fatal:", err);
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
});
