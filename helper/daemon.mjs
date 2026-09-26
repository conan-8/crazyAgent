#!/usr/bin/env node
// Browser Agent helper daemon — native-messaging host + full-CDP bridge
// (Unlimited mode). Speaks 4-byte-LE-length-framed JSON on stdio (Chrome
// native messaging) and bridges to the browser's DevTools endpoint.
//
// RPC methods:
//   ping                       → { pong, ts }
//   attach   { port }          → connect to an existing DevTools endpoint
//   launch   { profileDir?, extensionId?, chromePath? }
//                              → spawn the dedicated automation browser
//   targets  {}                → page targets [{ targetId, url, title }]
//   cdp      { targetId, cdpMethod, cdpParams? }
//                              → raw CDP passthrough (cached per-target WS)
//   intercept { targetId, action, ... }
//        action "mock"   { urlPattern, status?, body }   fulfill matching reqs
//        action "rewrite"{ urlPattern, url?, headers? }  continue with edits
//        action "observe" {}                             record requests
//        action "list"    {}                             recorded requests
//        action "clear"   {}                             disable + reset
//   quit     {}                → exit (next RPC respawns the host)

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

let stdinBuffer = Buffer.alloc(0);
let cdpHttp = null; // e.g. http://127.0.0.1:9222
let spawnedBrowser = null;

// per-target state
const wsByTarget = new Map(); // targetId → WebSocket
const pendingByTarget = new Map(); // targetId → Map<rpcId, resolver>
const nextIdByTarget = new Map();
const rulesByTarget = new Map(); // targetId → { mocks: [], rewrites: [], observing: bool }
const requestLogByTarget = new Map();

function send(msg) {
  const json = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  process.stdout.write(head);
  process.stdout.write(json);
}

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  for (;;) {
    if (stdinBuffer.length < 4) return;
    const len = stdinBuffer.readUInt32LE(0);
    if (stdinBuffer.length < 4 + len) return;
    const raw = stdinBuffer.subarray(4, 4 + len).toString("utf8");
    stdinBuffer = stdinBuffer.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    void handle(msg);
  }
});

async function handle(msg) {
  try {
    const result = await dispatch(msg);
    send({ id: msg.id, ok: true, result });
    if (msg.method === "quit") process.exit(0);
  } catch (err) {
    send({ id: msg.id, ok: false, error: String(err?.message ?? err) });
  }
}

async function dispatch(msg) {
  switch (msg.method) {
    case "ping":
      return { pong: true, ts: Date.now(), pid: process.pid, cdpHttp };
    case "attach": {
      cdpHttp = `http://127.0.0.1:${msg.params.port}`;
      const res = await fetch(`${cdpHttp}/json/version`);
      if (!res.ok) throw new Error(`DevTools endpoint not reachable: ${res.status}`);
      const info = await res.json();
      rememberPort(msg.params.port);
      return { browser: info.Browser ?? "unknown" };
    }
    case "launch":
      return launch(msg.params ?? {});
    case "targets": {
      const list = await (await fetch(`${cdpHttp}/json`)).json();
      return list
        .filter((t) => t.type === "page" || t.type === "service_worker")
        .map((t) => ({ targetId: t.id, type: t.type, url: t.url, title: t.title ?? "" }));
    }
    case "cdp": {
      const { targetId, cdpMethod, cdpParams } = msg.params;
      return cdpSend(targetId, cdpMethod, cdpParams ?? {});
    }
    case "intercept":
      return intercept(msg.params);
    case "quit":
      return { quitting: true };
    default:
      throw new Error(`unknown method: ${msg.method}`);
  }
}

function rememberPort(port) {
  try {
    writeFileSync(
      `${process.env.HOME}/.config/browser-agent/daemon-state.json`,
      JSON.stringify({ port, ts: Date.now() }),
    );
  } catch {
    // state file is best-effort
  }
}

function launch({ profileDir, extensionId, unpackedDir, chromePath }) {
  const bin = chromePath || guessChrome();
  const args = [
    `--user-data-dir=${profileDir || `${process.env.HOME}/.config/browser-agent/profile`}`,
    "--remote-debugging-port=0",
    "--no-first-run",
  ];
  if (unpackedDir) args.push(`--load-extension=${unpackedDir}`);
  if (extensionId) args.push(`--silent-debugger-extension-id=${extensionId}`);
  spawnedBrowser = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((resolve, reject) => {
    let errText = "";
    spawnedBrowser.stderr.on("data", (chunk) => {
      errText += chunk.toString();
      const m = errText.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        cdpHttp = `http://127.0.0.1:${m[1]}`;
        rememberPort(Number(m[1]));
        resolve({ port: Number(m[1]), pid: spawnedBrowser.pid });
      }
    });
    spawnedBrowser.on("error", reject);
    setTimeout(() => reject(new Error(`browser launch failed: ${errText.slice(0, 300)}`)), 20_000);
  });
}

function guessChrome() {
  for (const bin of [
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(bin)) return bin;
  }
  return "/usr/bin/microsoft-edge";
}

// ---------------- CDP over WebSocket (one socket per target) ----------------

function getWs(targetId) {
  let ws = wsByTarget.get(targetId);
  if (ws && ws.readyState === 1) return ws;
  ws = new WebSocket(`${cdpHttp.replace("http", "ws")}/devtools/page/${targetId}`);
  wsByTarget.set(targetId, ws);
  pendingByTarget.set(targetId, new Map());
  nextIdByTarget.set(targetId, 0);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const pending = pendingByTarget.get(targetId);
    if (msg.id && pending?.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      void onCdpEvent(targetId, msg);
    }
  };
  ws.onclose = () => {
    wsByTarget.delete(targetId);
  };
  return ws;
}

function cdpSend(targetId, method, params) {
  return new Promise((resolve, reject) => {
    const ws = getWs(targetId);
    const id = (nextIdByTarget.get(targetId) ?? 0) + 1;
    nextIdByTarget.set(targetId, id);
    const pending = pendingByTarget.get(targetId);
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, 30_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result ?? {});
    });
    const payload = JSON.stringify({ id, method, params });
    // Node's WebSocket throws "Sent before connected." on send() before the
    // socket opens — wait for open (or fail cleanly on error).
    const fire = () => ws.send(payload);
    if (ws.readyState === 1) fire();
    else {
      ws.addEventListener("open", fire, { once: true });
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          if (pending.delete(id)) {
            reject(new Error(`CDP ws connection failed for target ${targetId}`));
          }
        },
        { once: true },
      );
    }
  });
}

// ---------------- network interception ----------------

async function ensureRules(targetId) {
  if (!rulesByTarget.has(targetId)) {
    rulesByTarget.set(targetId, { mocks: [], rewrites: [], observing: false });
    requestLogByTarget.set(targetId, []);
  }
  return rulesByTarget.get(targetId);
}

async function intercept(params) {
  const { targetId, action } = params;
  const rules = await ensureRules(targetId);
  switch (action) {
    case "mock": {
      rules.mocks.push({
        urlPattern: params.urlPattern,
        status: params.status ?? 200,
        body: params.body ?? "",
        contentType: params.contentType ?? "application/json",
      });
      await cdpSend(targetId, "Fetch.enable", {
        patterns: [{ urlPattern: "*" }],
      });
      return { mocks: rules.mocks.length };
    }
    case "rewrite": {
      rules.rewrites.push({
        urlPattern: params.urlPattern,
        url: params.url,
        headers: params.headers,
      });
      await cdpSend(targetId, "Fetch.enable", {
        patterns: [{ urlPattern: "*" }],
      });
      return { rewrites: rules.rewrites.length };
    }
    case "observe": {
      rules.observing = true;
      await cdpSend(targetId, "Network.enable", {});
      return { observing: true };
    }
    case "list":
      return { requests: requestLogByTarget.get(targetId) ?? [] };
    case "clear": {
      rules.mocks = [];
      rules.rewrites = [];
      rules.observing = false;
      requestLogByTarget.set(targetId, []);
      await cdpSend(targetId, "Fetch.disable", {}).catch(() => {});
      await cdpSend(targetId, "Network.disable", {}).catch(() => {});
      return { cleared: true };
    }
    default:
      throw new Error(`unknown intercept action: ${action}`);
  }
}

async function onCdpEvent(targetId, msg) {
  const rules = rulesByTarget.get(targetId);
  if (msg.method === "Network.requestWillBeSent" && rules?.observing) {
    requestLogByTarget.get(targetId)?.push({
      url: msg.params.request.url,
      method: msg.params.request.method,
      ts: Date.now(),
    });
  }
  if (msg.method === "Fetch.requestPaused") {
    const { requestId, request } = msg.params;
    const mock = rules?.mocks.find((m) => matchUrl(request.url, m.urlPattern));
    if (mock) {
      const body = Buffer.from(
        typeof mock.body === "string" ? mock.body : JSON.stringify(mock.body),
      ).toString("base64");
      await cdpSend(targetId, "Fetch.fulfillRequest", {
        requestId,
        responseCode: mock.status,
        responseHeaders: [{ name: "content-type", value: mock.contentType }],
        body,
      }).catch(() => {});
      return;
    }
    const rewrite = rules?.rewrites.find((r) => matchUrl(request.url, r.urlPattern));
    if (rewrite) {
      await cdpSend(targetId, "Fetch.continueRequest", {
        requestId,
        url: rewrite.url,
        headers: rewrite.headers
          ? Object.entries(rewrite.headers).map(([name, value]) => ({ name, value: String(value) }))
          : undefined,
      }).catch(() => {});
      return;
    }
    await cdpSend(targetId, "Fetch.continueRequest", { requestId }).catch(() => {});
  }
  // Forward execution-context events to the extension. `Runtime.evaluate` can
  // target a specific frame by execution context, and contexts are announced
  // only through these events — without them there is no way to run JS inside an
  // iframe, which is the Google Docs / embedded-Slides case.
  if (
    msg.method === "Runtime.executionContextCreated" ||
    msg.method === "Runtime.executionContextDestroyed" ||
    msg.method === "Runtime.executionContextsCleared" ||
    // Console + network capture (console_read / network_read). Deliberately a
    // closed list: everything else stays on the daemon's side of the wire.
    msg.method === "Runtime.consoleAPICalled" ||
    msg.method === "Runtime.exceptionThrown" ||
    msg.method === "Log.entryAdded" ||
    msg.method === "Network.requestWillBeSent" ||
    msg.method === "Network.responseReceived" ||
    msg.method === "Network.loadingFailed"
  ) {
    send({ id: 0, event: "cdp", result: { targetId, method: msg.method, params: msg.params } });
  }
}

function matchUrl(url, pattern) {
  // Minimal wildcard match: '*' anywhere.
  const rx = new RegExp(
    `^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
  );
  return rx.test(url);
}

send({ id: 0, ok: true, result: { started: true, pid: process.pid } });
