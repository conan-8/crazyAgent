#!/usr/bin/env node
// Jev sidecar verification driver ("fast decisions").
// A: judge tool round-trip — the scripted model calls `judge`, the mock Jev
//    endpoint answers, typed results reach the tool card.
// B: risk gating — a click the regex rules ALLOW ("Upgrade plan") is flagged
//    by Jev (purchase=0.95) and gated; deny → cancellation the model sees.
// C: auto effort routing — Jev grades the task 'simple', thinking drops from
//    the user's 'high' to 'low' and the provider request carries it.
// D: fail-open — Jev endpoint unreachable: one info event, run proceeds on
//    the rule-based policy, no confirm, no error.
// E: OpenRouter transport — the same judge round-trip over the OpenAI-compatible
//    /chat/completions wire, pinned by the strict `jev_answers` schema marker.
// Usage: node scripts/jev-smoke.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9238;
const PROFILE = "/tmp/ba-jev";
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";
const LLM = "http://127.0.0.1:8796/v1";

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

const S_JUDGE = [
  {
    text: "Judging items.",
    toolCalls: [
      {
        name: "judge",
        args: {
          state: [
            "red running shoes size 10 — $42",
            "gardening blog: how to prune roses",
          ],
          questions: [
            {
              id: "item_0",
              type: "noul",
              instructions: "Is `item_0` a product listing for footwear?",
            },
            {
              id: "best",
              type: "choice",
              instructions: "Which item is more relevant to buying shoes?",
              criteria: { item_0: "shoe listing", item_1: "gardening blog" },
            },
          ],
        },
      },
    ],
  },
  { text: "JUDGE_DONE" },
];

const S_GATE = [
  { text: "Looking.", toolCalls: [{ name: "snapshot", args: {} }] },
  { text: "Clicking upgrade.", toolCalls: [{ name: "click", args: { ref: "4" } }] },
  { text: "GATE_DONE" },
];

const S_ROUTE = [{ text: "ROUTED_DONE" }];

// Navigate is NOT mutating per shared/modes (plan mode allows it for
// research), so the fail-open scenario uses a click — a mutating action the
// regex rules allow — to exercise the gate path against a dead endpoint.
const S_FALLBACK = [
  { text: "Looking.", toolCalls: [{ name: "snapshot", args: {} }] },
  { text: "Clicking upgrade.", toolCalls: [{ name: "click", args: { ref: "4" } }] },
  { text: "FALLBACK_DONE" },
];

function log(...args) {
  console.log("[jev]", ...args);
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

/** Patch the stored settings through the panel hook (normalizer runs on save). */
async function configure(panel, patch) {
  await panel.eval(`(async () => {
    const s = await __ba.getSettings();
    Object.assign(s, ${JSON.stringify(patch)});
    await __ba.setSettings(s);
    return "ok";
  })()`);
  await sleep(200);
}

const BASE_SETTINGS = {
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
  thinking: "high",
  autoThinking: false,
  jev: { enabled: true, apiKey: "tsk-mock", baseUrl: LLM, model: "mock-jev" },
};

async function main() {
  const servers = startFixtureServers();
  const mock = startMockLlm({ script: S_JUDGE, port: 8796 });
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
    await openPage(`${MAIN}/login.html`);
    await sleep(1_200);
    const tabId = await panel.eval(
      `chrome.tabs.query({ url: "${MAIN}/*" }).then(ts => ts[0]?.id ?? -1)`,
    );
    await panel.eval(`chrome.tabs.update(${tabId}, { active: true })`);
    await configure(panel, BASE_SETTINGS);
    const cfg = await panel
      .eval("__ba.getSettings().then(s => JSON.stringify({jev: s.jev, autoThinking: s.autoThinking, model: s.model}))")
      .then(JSON.parse);
    check(
      "J0 settings accept the Jev block",
      cfg.jev?.enabled === true && cfg.jev?.model === "mock-jev" && cfg.model === "mock-model",
      JSON.stringify(cfg),
    );

    // ============ A: judge tool round-trip ============
    mock.setJevScript(null);
    await panel.eval(`__ba.runTask("Pick the shoe listing"); "started"`);
    const evsA = await waitDone(panel);
    const judgeResult = evsA.find((e) => e.kind === "tool_result" && e.name === "judge");
    const jevReqA = mock.lastJevRequest();
    const chatReqA = mock.lastRequest();
    check(
      "J1 judge offered to the model when Jev is configured",
      (chatReqA?.tools ?? []).some((t) => t?.function?.name === "judge"),
      `tools: ${(chatReqA?.tools ?? []).map((t) => t?.function?.name).join(",")}`,
    );
    check(
      "J2 judge returns typed Jev answers",
      mock.hits().jev >= 1 &&
        judgeResult?.ok === true &&
        String(judgeResult?.result).includes("item_0: 0.05") &&
        String(judgeResult?.result).includes('best: "item_0"'),
      judgeResult?.result ?? "(no judge result)",
    );
    check(
      "J3 judge request carried the questions map",
      jevReqA?.questions?.item_0?.type === "noul" &&
        jevReqA?.questions?.best?.type === "choice" &&
        jevReqA?.model === "mock-jev",
      JSON.stringify(Object.keys(jevReqA?.questions ?? {})),
    );
    check(
      "J4 run finished cleanly after judge",
      evsA.some((e) => e.kind === "done" && e.summary.includes("JUDGE_DONE")) &&
        !evsA.some((e) => e.kind === "error"),
    );

    // ============ B: Jev risk gate on a regex-allowed click ============
    mock.setScript(S_GATE);
    mock.setJevScript({ purchase: { noul: 0.95 } });
    await panel.eval(`__ba.runTask("Upgrade my account"); "started"`);
    const kindB = await driveConfirm(panel, { allow: false, always: false });
    const evsB = await waitDone(panel);
    const confirmB = evsB.find((e) => e.kind === "need_confirm");
    const jevReqB = mock.lastJevRequest();
    const deniedB = evsB.find((e) => e.kind === "tool_result" && e.name === "click");
    check(
      "J5 regex-allowed click gated by Jev (purchase 0.95)",
      kindB === "confirm" &&
        confirmB?.tool === "purchase" &&
        String(confirmB?.summary).includes("Jev") &&
        String(confirmB?.summary).includes("95%"),
      confirmB ? `${confirmB.tool}: ${confirmB.summary}` : "(no confirm)",
    );
    check(
      "J6 gate state is small and literal (task/action/element)",
      jevReqB?.state?.action?.tool === "click" &&
        jevReqB?.state?.element?.text === "Upgrade plan" &&
        jevReqB?.state?.task === "Upgrade my account" &&
        Object.keys(jevReqB?.questions ?? {}).sort().join(",") ===
          "beyond_task,credential,irreversible,purchase",
      JSON.stringify(jevReqB?.state ?? {}).slice(0, 200),
    );
    check(
      "J7 deny returns a cancellation and the run completes",
      deniedB?.ok === false &&
        String(deniedB?.result).includes("denied") &&
        evsB.some((e) => e.kind === "done" && e.summary.includes("GATE_DONE")),
      deniedB?.result ?? "",
    );

    // ============ C: auto effort routing ============
    mock.setScript(S_ROUTE);
    mock.setJevScript({ complexity: { choice: "simple", confidence: 0.9 } });
    await configure(panel, { autoThinking: true });
    await panel.eval(`__ba.runTask("What is the capital of France?"); "started"`);
    const evsC = await waitDone(panel);
    const infoC = evsC.find(
      (e) => e.kind === "info" && /thinking:/.test(e.message ?? ""),
    );
    const chatReqC = mock.lastRequest();
    check(
      "J8 simple task routes thinking high → low",
      infoC?.message === "thinking: low (task graded 'simple' by Jev)" &&
        chatReqC?.reasoning_effort === "low",
      `${infoC?.message ?? "(no routing info)"} | reasoning_effort=${chatReqC?.reasoning_effort}`,
    );

    // ============ D: fail-open when Jev is unreachable ============
    mock.setScript(S_FALLBACK);
    mock.setJevScript(null);
    await configure(panel, {
      autoThinking: false,
      jev: { ...BASE_SETTINGS.jev, baseUrl: "http://127.0.0.1:8799/v1" },
    });
    await panel.eval(`__ba.runTask("Open the docs page"); "started"`);
    const evsD = await waitDone(panel);
    const infoD = evsD.find(
      (e) => e.kind === "info" && /Jev unavailable/.test(e.message ?? ""),
    );
    check(
      "J9 unreachable Jev fails open with one info event",
      infoD &&
        !evsD.some((e) => e.kind === "need_confirm") &&
        !evsD.some((e) => e.kind === "error") &&
        evsD.some((e) => e.kind === "done" && e.summary.includes("FALLBACK_DONE")),
      infoD?.message ?? "(no fallback info)",
    );

    // ============ E: OpenRouter transport (Jev over /chat/completions) ============
    // Same questions and the same features, but the sidecar now speaks the
    // OpenAI-compatible wire — which is the only way an OpenRouter key (or any
    // non-TypeSafe endpoint) can drive it.
    mock.setScript(S_JUDGE);
    mock.setJevScript({ item_0: { noul: 0.42 } });
    await configure(panel, {
      jev: {
        ...BASE_SETTINGS.jev,
        transport: "openai",
        apiKey: "sk-or-mock",
        model: "mock-jev-chat",
      },
    });
    await panel.eval(`__ba.runTask("Pick the shoe listing"); "started"`);
    const evsE = await waitDone(panel);
    const judgeE = evsE.find((e) => e.kind === "tool_result" && e.name === "judge");
    const jevReqE = mock.lastJevRequest();
    const formatE = jevReqE?.response_format ?? {};
    check(
      "J10 openai transport speaks /chat/completions with the strict schema marker",
      mock.lastJevTransport() === "chat" &&
        formatE?.type === "json_schema" &&
        formatE?.json_schema?.name === "jev_answers" &&
        formatE?.json_schema?.strict === true &&
        jevReqE?.model === "mock-jev-chat" &&
        (jevReqE?.messages ?? []).some((m) => m.role === "system") &&
        (jevReqE?.messages ?? []).some(
          (m) => m.role === "user" && String(m.content).includes("questions:"),
        ),
      `${mock.lastJevTransport()} | ${JSON.stringify(formatE).slice(0, 160)}`,
    );
    check(
      "J11 judge answers flow back through the chat transport",
      judgeE?.ok === true && String(judgeE?.result).includes("item_0: 0.42"),
      judgeE?.result ?? "(no judge result)",
    );
    check(
      "J12 the agent's own chat stream is untouched by the Jev chat call",
      (mock.lastRequest()?.tools ?? []).some((t) => t?.function?.name === "judge") &&
        evsE.some((e) => e.kind === "done" && e.summary.includes("JUDGE_DONE")),
      `tools: ${(mock.lastRequest()?.tools ?? []).map((t) => t?.function?.name).join(",")}`,
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
  console.error("[jev] fatal:", err);
  process.exit(1);
});
