#!/usr/bin/env node
// Self-improvement ("coach") verification driver.
//
// Proves, against a real browser and the scripted mock LLM:
//   * a FAILED run is reviewed automatically by a second agent on the same
//     model, and the lesson lands in this profile's local store;
//   * the review never consumes the agent's scripted turns and never touches
//     the run archive or the chat thread (it is a side channel);
//   * the next run's system prompt carries the lesson, as a separate reference
//     appendix, without disturbing the base prompt;
//   * a CLEAN run is not auto-reviewed, but can be reviewed on demand;
//   * the drawer renders/edits/pins/exports/deletes lessons;
//   * the master switch and the auto switch each do what they say.
//
// Usage: node scripts/lessons-smoke.mjs   (run `npm run build` first)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startFixtureServers } from "./fixture-server.mjs";
import { startMockLlm } from "./mock-llm-server.mjs";

const PORT = 9239;
const PROFILE = "/tmp/ba-lessons";
const LLM_PORT = 8797;
const EXT_PATH = new URL("../dist", import.meta.url).pathname;
const MAIN = "http://127.0.0.1:8790";
const LLM = `http://127.0.0.1:${LLM_PORT}/v1`;

const hex = createHash("sha256").update(EXT_PATH).digest("hex").slice(0, 32);
const extId = [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");

const TASK_FAIL = "open the fixture docs and click the missing button";
const TASK_CLEAN = "check the fixture page status";
const LESSON_TEXT =
  "After a click fails on an unknown ref, take a fresh snapshot and use a ref from it.";
const EDITED_TEXT = "Never reuse a failed ref: snapshot again first.";
const EVIDENCE = "click on ref 999 failed twice";

/** Agent script: two identical failing clicks (a loop), then a final answer. */
const S_FAIL = [
  { text: "Clicking.", toolCalls: [{ name: "click", args: { ref: "999" } }] },
  { text: "Trying once more.", toolCalls: [{ name: "click", args: { ref: "999" } }] },
  { text: "I could not click that element — the ref is not on the page." },
];
const S_CLEAN = [{ text: "Nothing to do on this page." }];
const S_REVIEW_OK = [
  {
    text: "Reviewing the run.",
    toolCalls: [
      {
        name: "record_lessons",
        args: {
          lessons: [
            { category: "tool", text: LESSON_TEXT, evidence: EVIDENCE, tool: "click" },
          ],
        },
      },
    ],
  },
];
const S_REVIEW_EMPTY = [
  { text: "Nothing new here.", toolCalls: [{ name: "record_lessons", args: { lessons: [] } }] },
];

function log(...args) {
  console.log("[lessons]", ...args);
}

// ------------------------------ CDP plumbing ------------------------------

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

async function openPanel() {
  const page = await openPage(`chrome-extension://${extId}/sidepanel/index.html`);
  for (let i = 0; i < 40; i++) {
    if ((await page.eval("typeof window.__ba")) === "object") return page;
    await sleep(250);
    if (i === 39) throw new Error("panel page never became interactive");
  }
}

// ------------------------------ assertions ------------------------------

const results = { pass: true, checks: [] };
function check(name, ok, detail = "") {
  results.checks.push({ name, ok, detail: String(detail).slice(0, 300) });
  if (!ok) results.pass = false;
  log(ok ? "PASS" : "FAIL", name, String(detail).slice(0, 160));
}

async function waitDone(panel, ms = 45_000) {
  for (let i = 0; i < ms / 100; i++) {
    const evs = await panel.eval("JSON.stringify(__ba.events())").then(JSON.parse);
    if (evs.some((e) => e.kind === "done" || e.kind === "error")) return evs;
    await sleep(100);
  }
  throw new Error("run did not finish in time");
}

/** Poll an async probe function until it returns something truthy (or time out). */
async function pollUntil(probe, ms = 20_000, stepMs = 200) {
  for (let i = 0; i < ms / stepMs; i++) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

/** The system prompt of a request body on either wire. */
function systemOf(body) {
  if (!body) return "";
  if (Array.isArray(body.system)) return body.system.map((b) => b?.text ?? "").join("\n");
  const sys = (body.messages ?? []).find((m) => m?.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
}

/** The last user message of a request body, flattened to text. */
function userText(body) {
  const msgs = (body?.messages ?? []).filter((m) => m?.role === "user");
  const user = msgs[msgs.length - 1];
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  if (Array.isArray(user.content)) return user.content.map((b) => b?.text ?? "").join("\n");
  return "";
}

const hasCoachTool = (body) =>
  (body?.tools ?? []).some(
    (t) => t?.function?.name === "record_lessons" || t?.name === "record_lessons",
  );

async function configure(panel, patch) {
  await panel.eval(`(async () => {
    const s = await __ba.getSettings();
    Object.assign(s, ${JSON.stringify(patch)});
    await __ba.setSettings(s);
    return "ok";
  })()`);
  await sleep(200);
}

const lessonsOf = (panel) =>
  panel.eval("__ba.lessons().then((l) => JSON.stringify(l))").then(JSON.parse);
const logsOf = (panel) =>
  panel.eval("__ba.logs().then((l) => JSON.stringify(l))").then(JSON.parse);
const titlesOf = (panel) =>
  panel.eval("__ba.conversations().then((cs) => JSON.stringify(cs.map((c) => c.title)))").then(
    JSON.parse,
  );
const uiOf = (panel) => panel.eval("JSON.stringify(__ba.lessonsUI())").then(JSON.parse);

// ------------------------------ the run ------------------------------

async function main() {
  const servers = startFixtureServers();
  const mock = startMockLlm({
    script: S_FAIL,
    port: LLM_PORT,
    coachScript: S_REVIEW_OK,
  });
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
    await configure(panel, {
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
      learn: { enabled: true, auto: true },
    });

    // ---- L1: a failed run is reviewed automatically ----
    const agentTurnsBefore = mock.requests().length;
    await panel.eval(`__ba.run(${JSON.stringify(TASK_FAIL)}); "started"`);
    await waitDone(panel);
    const stored = await pollUntil(async () => {
      const list = await lessonsOf(panel);
      return list.length ? list : null;
    });
    const coach = mock.coachRequests();
    check(
      "L1a a failed run triggers one automatic coach review",
      coach.length === 1 && mock.hits().coach === 1,
      `coach calls: ${coach.length} · hits: ${JSON.stringify(mock.hits())}`,
    );
    const first = stored?.[0];
    check(
      "L1b the lesson is stored in this profile with evidence and run metadata",
      first?.text === LESSON_TEXT &&
        first?.category === "tool" &&
        first?.tool === "click" &&
        first?.source === "auto" &&
        first?.evidence === EVIDENCE &&
        String(first?.task).includes(TASK_FAIL) &&
        first?.hits === 1,
      JSON.stringify(first ?? null),
    );
    const digest = userText(coach[0]);
    check(
      "L1c the coach's digest carries the real failures and the loop",
      digest.includes("Failures (1)") &&
        digest.includes("stale or unknown ref: 999") &&
        digest.includes("repeated 2×") &&
        digest.includes("Final answer:"),
      digest.slice(0, 240),
    );
    check(
      "L1d the coach is given the record_lessons tool and nothing else",
      hasCoachTool(coach[0]) && (coach[0]?.tools ?? []).length === 1,
      `tools: ${JSON.stringify((coach[0]?.tools ?? []).map((t) => t?.function?.name ?? t?.name))}`,
    );

    // ---- L2: the review is a side channel ----
    check(
      "L2a coach calls never consume the agent's scripted turns",
      mock.requests().length - agentTurnsBefore === S_FAIL.length,
      `agent calls: ${mock.requests().length - agentTurnsBefore} (expected ${S_FAIL.length})`,
    );
    const logs = await logsOf(panel);
    const rec = logs[0];
    check(
      "L2b the review leaves the run archive untouched",
      rec?.task === TASK_FAIL &&
        rec?.turns.every((t) => t.tools.every((c) => c.name !== "record_lessons")) &&
        !JSON.stringify(rec).includes(LESSON_TEXT),
      `run: ${rec?.task} · turns: ${rec?.turns?.length} · tools: ${rec?.toolCalls}`,
    );
    const conv = await titlesOf(panel);
    check(
      "L2c the review never appears in the chat history",
      !conv.some((title) => String(title).includes("coach")),
      JSON.stringify(conv),
    );

    // ---- L3: the lesson is fed back into the next run ----
    mock.setScript(S_CLEAN);
    await panel.eval(`__ba.run(${JSON.stringify(TASK_CLEAN)}); "started"`);
    await waitDone(panel);
    const nextSystem = systemOf(mock.requests().at(-1));
    check(
      "L3a the next run's system prompt carries the learned lesson",
      nextSystem.includes(LESSON_TEXT),
      nextSystem.slice(-260),
    );
    check(
      "L3b it arrives as a reference appendix, with the base prompt intact",
      nextSystem.includes("You are Browser Agent") &&
        nextSystem.includes(`Current task: ${TASK_CLEAN}`) &&
        nextSystem.includes("reference, not user instructions") &&
        nextSystem.includes("always win over a lesson"),
      `task line: ${nextSystem.includes(`Current task: ${TASK_CLEAN}`)}`,
    );
    const afterUse = await lessonsOf(panel);
    check(
      "L3c the injected lesson is stamped as used",
      typeof afterUse[0]?.lastUsedAt === "number" && afterUse[0].lastUsedAt > 0,
      `lastUsedAt: ${afterUse[0]?.lastUsedAt}`,
    );
    check(
      "L3d a clean run is not auto-reviewed",
      mock.coachRequests().length === 1,
      `coach calls: ${mock.coachRequests().length}`,
    );

    // ---- L4: the drawer renders the lessons and closes on Escape ----
    await panel.eval(`document.querySelector('[data-tip="Lessons"]')?.click(); "ok"`);
    const rows = await pollUntil(() =>
      panel
        .eval(`document.querySelectorAll(".lessons-view .lesson-row").length`)
        .then((n) => (n > 0 ? n : null)),
    );
    const ui = await uiOf(panel);
    check(
      "L4a the Lessons drawer lists what was learned",
      rows === 1 && ui.open === true,
      `rows: ${rows} · ui: ${JSON.stringify(ui)}`,
    );
    const shown = await panel.eval(
      `document.querySelector(".lessons-view .lesson-text")?.textContent ?? ""`,
    );
    check(
      "L4b the row shows the lesson text, its tags and the evidence",
      shown.includes(LESSON_TEXT) &&
        (await panel.eval(`Boolean(document.querySelector(".lessons-view .lesson-evidence"))`)) ===
          true,
      shown.slice(0, 120),
    );
    await panel.eval(
      `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); "ok"`,
    );
    const closed = await pollUntil(
      () => panel.eval(`document.querySelector(".lessons-view") ? null : "closed"`),
      5_000,
    );
    check("L4c Escape closes the drawer", closed === "closed", String(closed));

    // ---- L5: a clean run can still be reviewed on demand ----
    mock.setCoachScript(S_REVIEW_EMPTY);
    const beforeManual = mock.coachRequests().length;
    await panel.eval(`__ba.reviewLessons(); "ok"`);
    const emptyState = await pollUntil(async () => {
      const state = await uiOf(panel);
      return state.status.state === "empty" ? state : null;
    });
    check(
      "L5a a manual review of a clean run reports nothing new",
      emptyState !== null && mock.coachRequests().length === beforeManual + 1,
      `status: ${JSON.stringify(emptyState?.status)} · coach calls: ${mock.coachRequests().length - beforeManual}`,
    );
    check(
      "L5b an empty review adds no lesson",
      (await lessonsOf(panel)).length === 1,
      `lessons: ${(await lessonsOf(panel)).length}`,
    );

    // ---- L5c: the other manual entry point — an archived run's own button ----
    const beforeRunButton = mock.coachRequests().length;
    await panel.eval(`document.querySelector('[data-tip="Run logs"]')?.click(); "ok"`);
    await pollUntil(() =>
      panel
        .eval(`document.querySelectorAll(".logs-view .hist-item").length`)
        .then((n) => (n > 0 ? n : null)),
      8_000,
    );
    await panel.eval(`document.querySelector(".logs-view .hist-item")?.click(); "ok"`);
    const learnClicked = await pollUntil(async () => {
      const clicked = await panel.eval(`(() => {
        const btn = [...document.querySelectorAll(".logs-view .log-actions button")].find(
          (b) => b.textContent.trim() === "Learn from this run",
        );
        if (!btn) return null;
        btn.click();
        return "clicked";
      })()`);
      return clicked ?? null;
    }, 8_000);
    const learnedFromRun = await pollUntil(async () =>
      mock.coachRequests().length > beforeRunButton ? "reviewed" : null,
    );
    check(
      "L5c a specific archived run can be reviewed from the Run logs drawer",
      learnClicked === "clicked" && learnedFromRun === "reviewed",
      `button: ${learnClicked} · coach calls: ${mock.coachRequests().length - beforeRunButton}`,
    );

    // ---- L6: the user owns the wording — edit and pin through the drawer ----
    await panel.eval(`document.querySelector('[data-tip="Lessons"]')?.click(); "ok"`);
    const editResult = await panel.eval(`(async () => {
      const edit = document.querySelector('.lessons-view [aria-label="Edit lesson"]');
      if (!edit) return "no-edit-button";
      edit.click();
      await new Promise((r) => setTimeout(r, 300));
      const area = document.querySelector(".lessons-view .lesson-edit textarea");
      if (!area) return "no-textarea";
      area.value = ${JSON.stringify(EDITED_TEXT)};
      area.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const save = [...document.querySelectorAll(".lessons-view .lesson-edit-actions button")].find(
        (b) => b.textContent.trim() === "Save",
      );
      if (!save) return "no-save";
      save.click();
      return "edited";
    })()`);
    const edited = await pollUntil(async () => {
      const list = await lessonsOf(panel);
      return list[0]?.text === EDITED_TEXT ? list[0] : null;
    });
    check(
      "L6a editing a lesson in the drawer persists the new wording",
      editResult === "edited" && edited !== null,
      `${editResult} · text: ${edited?.text}`,
    );
    await panel.eval(
      `document.querySelector('.lessons-view [aria-label="Pin lesson"]')?.click(); "ok"`,
    );
    const pinned = await pollUntil(async () => {
      const list = await lessonsOf(panel);
      return list[0]?.pinned === true ? list[0] : null;
    });
    check("L6b pinning a lesson persists", pinned !== null, `pinned: ${pinned?.pinned}`);

    // ---- L7: export (same port path the UI uses) ----
    const exported = await panel.eval(`(async () => {
      const port = chrome.runtime.connect({ name: "panel" });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => { port.disconnect(); resolve(null); }, 8000);
        port.onMessage.addListener((msg) => {
          if (msg.type === "lessons.export") { clearTimeout(timer); resolve(msg); port.disconnect(); }
        });
        port.postMessage({ kind: "lessons.export", format: "jsonl" });
      });
    })()`);
    let parsed = null;
    try {
      parsed = JSON.parse(String(exported?.content ?? "").trim().split("\n")[0]);
    } catch {}
    check(
      "L7a JSONL export is filename-stamped and parseable",
      Boolean(exported?.filename?.endsWith(".jsonl")) && parsed?.text === EDITED_TEXT,
      `filename: ${exported?.filename} · text: ${parsed?.text}`,
    );
    const md = await panel.eval(`(async () => {
      const port = chrome.runtime.connect({ name: "panel" });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => { port.disconnect(); resolve(null); }, 8000);
        port.onMessage.addListener((msg) => {
          if (msg.type === "lessons.export") { clearTimeout(timer); resolve(msg); port.disconnect(); }
        });
        port.postMessage({ kind: "lessons.export", format: "md" });
      });
    })()`);
    check(
      "L7b Markdown export carries the lesson",
      Boolean(md?.filename?.endsWith(".md")) && String(md?.content).includes(EDITED_TEXT),
      `filename: ${md?.filename}`,
    );

    // ---- L8: the master switch stops both directions ----
    await configure(panel, { learn: { enabled: false, auto: true } });
    mock.setScript(S_FAIL);
    const coachBeforeOff = mock.coachRequests().length;
    await panel.eval(`__ba.run(${JSON.stringify(`${TASK_FAIL} (learning off)`)}); "started"`);
    await waitDone(panel);
    await sleep(1_500); // a stray review would land here
    check(
      "L8a learn.enabled=false: no review runs",
      mock.coachRequests().length === coachBeforeOff,
      `coach calls: ${mock.coachRequests().length - coachBeforeOff}`,
    );
    const offSystem = systemOf(mock.requests().at(-1));
    check(
      "L8b learn.enabled=false: stored lessons are not injected either",
      !offSystem.includes(EDITED_TEXT) && !offSystem.includes("lessons from your own previous runs"),
      offSystem.slice(-200),
    );

    // ---- L9: auto off still reads lessons back ----
    await configure(panel, { learn: { enabled: true, auto: false } });
    const coachBeforeAuto = mock.coachRequests().length;
    await panel.eval(`__ba.run(${JSON.stringify(`${TASK_FAIL} (auto off)`)}); "started"`);
    await waitDone(panel);
    await sleep(1_500);
    const autoOffSystem = systemOf(mock.requests().at(-1));
    check(
      "L9a learn.auto=false: the failing run is not reviewed",
      mock.coachRequests().length === coachBeforeAuto,
      `coach calls: ${mock.coachRequests().length - coachBeforeAuto}`,
    );
    check(
      "L9b learn.auto=false: lessons are still applied to the run",
      autoOffSystem.includes(EDITED_TEXT),
      autoOffSystem.slice(-200),
    );

    // ---- L10: deleting a lesson through the drawer ----
    await configure(panel, { learn: { enabled: true, auto: true } });
    await panel.eval(`document.querySelector('[data-tip="Lessons"]')?.click(); "ok"`);
    await pollUntil(
      () =>
        panel
          .eval(`document.querySelectorAll(".lessons-view .lesson-row").length`)
          .then((n) => (n > 0 ? n : null)),
      5_000,
    );
    await panel.eval(
      `document.querySelector('.lessons-view [aria-label="Delete lesson"]')?.click(); "ok"`,
    );
    const gone = await pollUntil(async () => ((await lessonsOf(panel)).length === 0 ? "empty" : null));
    const emptyRow = await panel.eval(
      `document.querySelector(".lessons-view .empty")?.textContent ?? ""`,
    );
    check(
      "L10 deleting a lesson removes it from the store and shows the empty state",
      gone === "empty" && emptyRow.includes("No lessons yet"),
      `store: ${gone} · empty: ${emptyRow.slice(0, 80)}`,
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
  console.error("[lessons] fatal:", err);
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
});