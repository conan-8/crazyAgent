// Background service worker: message bus, task runner, keepalive, resume.
// The Phase 4 agent loop replaces the echo task behind the same bus.
import {
  PORT_NAME,
  type Checkpoint,
  type ControlMode,
  type DemoConfig,
  type LlmMessage,
  type PortRequest,
  type RunAttachment,
  type StepEvent,
  type SwToPanel,
} from "../shared/protocol";
import {
  clearCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
} from "./checkpoint";
import { Keepalive } from "./keepalive";
import { runEchoTask } from "./tasks/echo";
import { DebuggerAdapter } from "./adapters/debugger";
import { CdpAdapter } from "./adapters/cdp";
import type { BrowserAdapter } from "./adapters/types";
import { toolRegistry, toLlmTool, validateToolArgs } from "./tools/types";
import { runAgentTask, type ExecuteResult } from "./agent/loop";
import { createLlmClient } from "./agent/llm";
import { loadSettings } from "./settings";
import { recordHistory } from "./history";
import {
  deleteConversation,
  getConversation,
  listConversations,
  saveConversation,
} from "./conversations";
import {
  foldEvent,
  foldUser,
  forStorage,
  newConversation,
  summarize,
  type Conversation,
} from "../shared/chat";
import {
  foldLogEvent,
  newTurnRecord,
  toJsonl,
  toMarkdown,
  type LogTurnRecord,
} from "../shared/logging";
import {
  clearRecords,
  deleteRecord,
  getRecord,
  listRecords,
  listSummaries,
  saveRecord,
} from "./runlog";
import { assess, ConfirmGate, type ElementProbe } from "./policy";
import { probeElement } from "./tools/actions";
import {
  collectSnapshot,
  formatSnapshot,
  settleTab,
} from "./tools/perception";
import "./tools/perception"; // registers snapshot / screenshot / wait_for_settle
import "./tools/actions"; // registers click / type / select / key / hover / scroll / read_page
import "./tools/tabs"; // registers navigate / reload / back / forward / tabs_*
import "./tools/misc"; // registers evaluate_js / download (sensitive)
import "./tools/network"; // registers network_* (Unlimited mode)

const ALWAYS_KEY = "baPolicyAlways";

const gate = new ConfirmGate({
  emit,
  loadAlways: async () => {
    const out = await chrome.storage.local.get(ALWAYS_KEY);
    return new Set((out[ALWAYS_KEY] as string[] | undefined) ?? []);
  },
  saveAlways: async (always) => {
    await chrome.storage.local.set({ [ALWAYS_KEY]: [...always] });
  },
});
void gate.ready();

const debuggerAdapter = new DebuggerAdapter();
const cdpAdapter = new CdpAdapter();

/** Standard mode uses chrome.debugger; Unlimited mode the helper daemon. */
async function adapterForMode(): Promise<BrowserAdapter> {
  const settings = await loadSettings();
  if (settings.mode !== "unlimited") return debuggerAdapter;
  await cdpAdapter.connect(settings.cdpPort);
  return cdpAdapter;
}

/** Identity of this SW instance — lets tests detect teardown/restart. */
const startedAt = Date.now();

const ports = new Set<chrome.runtime.Port>();
let loopRunning = false;
let stopRequested = false;

/** Resolvers of in-flight step waits, woken early when stop is requested. */
const stopWaiters = new Set<() => void>();

function signalStop(): void {
  for (const waiter of stopWaiters) waiter();
  stopWaiters.clear();
}

/** Step wait, interruptible by stop (keeps the Stop button responsive). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      stopWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (stopRequested) {
      finish();
      return;
    }
    stopWaiters.add(finish);
  });
}

function broadcast(msg: SwToPanel): void {
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch {
      ports.delete(port);
    }
  }
}

function emit(event: StepEvent): void {
  broadcast({ type: "agent.event", event });
  if (currentConv) {
    foldEvent(currentConv, event);
    scheduleConvFlush(event.kind === "token_delta");
  }
  if (currentLog) {
    foldLogEvent(currentLog, event);
    scheduleLogFlush(event.kind === "token_delta");
  }
  if (event.kind === "done") {
    void recordHistory(currentTask, event);
  }
}
let currentTask = "";

// ---- structured run log (timestamped per turn, archived locally) ----
let currentLog: LogTurnRecord | null = null;
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Token deltas arrive per chunk — flushing on each would hammer storage.
 * Everything else (tool calls/results, confirmations, done) flushes at once so
 * the log survives a service-worker kill mid-turn.
 */
function scheduleLogFlush(deferred: boolean): void {
  if (!currentLog) return;
  if (!deferred) {
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    void flushLog();
    return;
  }
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null;
      void flushLog();
    }, 1_000);
  }
}

async function flushLog(): Promise<void> {
  const rec = currentLog;
  if (!rec) return;
  await saveRecord(rec);
}

/** Open a fresh log record for a new run. */
async function openLogRecord(
  task: string,
  mode: ControlMode,
  conversationId: string | undefined,
  attachments: RunAttachment[] | undefined,
): Promise<void> {
  currentLog = newTurnRecord(task, {
    conversationId,
    mode,
    attachments: attachments?.map((a) => ({ name: a.name, kind: a.kind })),
  });
  await flushLog();
}

/** Close the active record (done/error already set status via foldLogEvent). */
async function closeLogRecord(): Promise<void> {
  const rec = currentLog;
  if (!rec) return;
  if (rec.status === "running") {
    // Stopped by the user, or the loop returned without a terminal event.
    rec.status = "done";
    rec.durationMs = Math.max(0, Date.now() - rec.startedAt);
  }
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  await flushLog();
}

// ---- chat conversation (history) for the current run ----
let currentConv: Conversation | null = null;
let currentCp: Checkpoint | null = null;
let convFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleConvFlush(deferred: boolean): void {
  if (!currentConv) return;
  if (!deferred) {
    void flushConv();
    return;
  }
  if (!convFlushTimer) {
    convFlushTimer = setTimeout(() => {
      convFlushTimer = null;
      void flushConv();
    }, 1_000);
  }
}

async function flushConv(): Promise<void> {
  const conv = currentConv;
  if (!conv) return;
  if (currentCp?.conversationId === conv.id) {
    conv.llm = currentCp.messages;
  }
  await saveConversation(forStorage(conv));
}

const keepalive = new Keepalive(() => {
  void maybeResume("alarm");
});

async function runFrom(cp: Checkpoint): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  currentCp = cp;
  keepalive.start();
  try {
    if (cp.demo) {
      await runEchoTask(cp, {
        emit,
        save: saveCheckpoint,
        shouldStop: () => stopRequested,
        sleep,
      });
    } else {
      const settings = await loadSettings();
      cp.toolSpecs ??= [...toolRegistry.values()].map(toLlmTool);
      await runAgentTask(cp, {
        llm: createLlmClient(settings),
        emit,
        save: saveCheckpoint,
        shouldStop: () => stopRequested,
        // No stepCap: the agent runs until it answers, the user stops it, or
        // an error aborts it.
        maxTokens: settings.maxTokens,
        agentMode: settings.agentMode,
        contextWindow: settings.contextWindow,
        sendScreenshots: settings.sendScreenshots,
        thinking: settings.thinking,
        madman: settings.madman,
        execute: (name, args) => executeToolGated(name, args),
      });
    }
  } catch (err) {
    emit({ kind: "error", message: String(err) });
  } finally {
    loopRunning = false;
    keepalive.stop();
    await closeLogRecord();
    await clearCheckpoint();
  }
}

/**
 * Page-affecting actions whose result gets an automatic settle + fresh
 * snapshot appended — "action + observation" in one round-trip, so the model
 * no longer has to call wait_for_settle + snapshot after every step.
 */
const AUTO_OBSERVE_TOOLS = new Set([
  "click",
  "type",
  "select",
  "key",
  "hover",
  "scroll",
  "navigate",
  "reload",
  "back",
  "forward",
  "tabs_create",
  "tabs_switch",
]);

const OBSERVATION_MAX_CHARS = 12_000;

/** Best-effort settle + compact snapshot after an action; null on failure. */
async function observeAfterAction(tabId: number): Promise<string | null> {
  try {
    // Shorter reachability budget than the manual tool: fail fast on pages
    // where the content script can never run (chrome://, PDF viewer, …).
    await settleTab(tabId, 10_000, 8).catch(() => null);
    const snap = await collectSnapshot(tabId);
    if (!snap.frames.length) return null;
    const text = formatSnapshot(snap);
    return text.length > OBSERVATION_MAX_CHARS
      ? `${text.slice(0, OBSERVATION_MAX_CHARS)}…[truncated]`
      : text;
  } catch {
    return null; // observation is an optimization — never fail the action
  }
}

/** Policy-gated executor used by the agent loop (Phase 6). */
async function executeToolGated(
  name: string,
  args: Record<string, unknown>,
): Promise<ExecuteResult> {
  let probe: ElementProbe | null = null;
  const needsProbe = name === "type" || name === "click" || name === "key";
  const tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (needsProbe && typeof args.ref === "string" && tabId !== undefined) {
    probe = await probeElement(tabId, args.ref).catch(() => null);
  }
  const risk = assess(name, args, probe);
  if (risk.level === "confirm") {
    const outcome = await gate.request(risk);
    if (!outcome.allow) {
      return { ok: false, error: outcome.reason };
    }
  }
  const res = await executeTool(name, args);
  if (!res.ok || !AUTO_OBSERVE_TOOLS.has(name) || stopRequested) return res;
  // Observe whichever tab is active NOW — tabs_create/tabs_switch moved it.
  const obsTabId =
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ??
    tabId;
  if (obsTabId === undefined) return res;
  const observation = await observeAfterAction(obsTabId);
  if (!observation || stopRequested) return res;
  const base = res.text ?? JSON.stringify(res.payload ?? null);
  return {
    ...res,
    text: `${base}\n\n--- page after action (auto-settled, fresh snapshot) ---\n${observation}`,
  };
}

/** Timestamped export filename, e.g. crazyagent-logs-2026-05-04T09-30-00.jsonl. */
function logFilename(format: "jsonl" | "md", count: number): string {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
  const suffix = count === 1 ? "" : `-x${count}`;
  return `crazyagent-logs-${stamp}${suffix}.${format}`;
}

/** Shared tool executor (agent loop + dev run_tool channel). */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  tabId?: number,
): Promise<ExecuteResult> {
  const tool = toolRegistry.get(name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  const validation = validateToolArgs(tool, args);
  if (validation.error) {
    return { ok: false, error: validation.error.replace(/^ERROR: /, "") };
  }
  const targetTabId =
    tabId ??
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (targetTabId === undefined) return { ok: false, error: "no active tab" };
  try {
    const adapter = await adapterForMode();
    const payload = await tool.run(args, { tabId: targetTabId, adapter, emit });
    // Action-style tools resolve with { ok: false, error } instead of throwing.
    if (
      payload &&
      typeof payload === "object" &&
      (payload as { ok?: boolean }).ok === false
    ) {
      return {
        ok: false,
        error: String((payload as { error?: string }).error ?? "tool failed"),
      };
    }
    const presented = tool.present?.(payload);
    return {
      ok: true,
      payload,
      text: presented?.text,
      image: presented?.image,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

async function startRun(
  task: string,
  mode: ControlMode,
  demo?: DemoConfig,
  conversationId?: string,
  attachments?: RunAttachment[],
): Promise<void> {
  if (loopRunning) {
    emit({ kind: "info", message: "a task is already running" });
    return;
  }
  currentTask = task;
  // Reset the stop flag BEFORE any await — a stop that lands during setup
  // must not be clobbered later (real race: Run then Stop within ms).
  stopRequested = false;

  // Fold attachments into the user message: text is inlined, images ride
  // along as multimodal blocks (capped).
  const textParts = (attachments ?? [])
    .filter((a) => a.kind === "text")
    .map((a) => `\n\n--- attached: ${a.name} ---\n${a.data.slice(0, 20_000)}`);
  const taskWithFiles = `${task}${textParts.join("")}`;
  const images = (attachments ?? [])
    .filter((a) => a.kind === "image")
    .map((a) => a.data)
    .slice(0, 4);

  // Chat thread: continue an existing conversation (with its LLM context as
  // prior turns) or open a fresh one. Demo runs skip history entirely.
  let seedMessages: LlmMessage[] = [
    { role: "user", content: taskWithFiles, images: images.length ? images : undefined },
  ];
  if (demo) {
    currentConv = null;
  } else {
    const prior = conversationId ? await getConversation(conversationId) : null;
    currentConv =
      prior ?? newConversation(conversationId ?? crypto.randomUUID(), task);
    if (prior) {
      seedMessages = [
        ...prior.llm,
        {
          role: "user",
          content: taskWithFiles,
          images: images.length ? images : undefined,
        },
      ];
    }
    foldUser(currentConv, task, attachments);
  }

  const cp: Checkpoint = {
    task,
    mode,
    demo,
    conversationId: currentConv?.id,
    stepIndex: 0,
    messages: seedMessages,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    done: false,
  };
  // Demo/echo runs are UI smoke, not real work — keep them out of the archive.
  if (demo) currentLog = null;
  else await openLogRecord(task, mode, currentConv?.id, attachments);
  await saveCheckpoint(cp);
  await runFrom(cp);
}

/** Resume an unfinished task after SW teardown (idempotent). */
async function maybeResume(trigger: string): Promise<void> {
  if (loopRunning) return;
  const cp = await loadCheckpoint();
  if (cp && !cp.done) {
    currentCp = cp;
    stopRequested = false;
    if (cp.conversationId && !cp.demo) {
      currentConv =
        (await getConversation(cp.conversationId)) ??
        newConversation(cp.conversationId, cp.task);
    }
    // Continue the still-open log record when this run already had one, so a
    // worker teardown doesn't split one task into two archive entries.
    if (cp.demo) {
      currentLog = null;
    } else {
      const open = (await listRecords()).find(
        (r) => r.status === "running" && r.conversationId === cp.conversationId,
      );
      if (open) {
        open.resumed = true;
        currentLog = open;
      } else {
        currentLog = newTurnRecord(cp.task, {
          conversationId: cp.conversationId,
          mode: cp.mode,
          at: cp.startedAt,
        });
      }
    }
    emit({
      kind: "info",
      message: `resumed from checkpoint (step ${cp.stepIndex + 1}) — trigger: ${trigger}`,
    });
    void runFrom(cp);
  }
}

async function handleRequest(
  port: chrome.runtime.Port,
  msg: PortRequest,
): Promise<void> {
  switch (msg.kind) {
    case "ping":
      port.postMessage({
        type: "pong",
        from: "sw",
        startedAt,
        ts: Date.now(),
      } satisfies SwToPanel);
      void maybeResume("panel-ping");
      break;
    case "run":
      void startRun(msg.task, msg.mode, msg.demo, msg.conversationId, msg.attachments);
      break;
    case "history.list": {
      const conversations = await listConversations();
      port.postMessage({
        type: "history.list",
        conversations: conversations.map(summarize),
      });
      break;
    }
    case "history.get": {
      const conversation = await getConversation(msg.conversationId);
      port.postMessage({ type: "history.get", conversation });
      break;
    }
    case "history.delete": {
      // Never let a pending flush resurrect a deleted thread.
      if (currentConv?.id === msg.conversationId) {
        currentConv = null;
        if (convFlushTimer) {
          clearTimeout(convFlushTimer);
          convFlushTimer = null;
        }
      }
      await deleteConversation(msg.conversationId);
      const conversations = await listConversations();
      port.postMessage({
        type: "history.list",
        conversations: conversations.map(summarize),
      });
      break;
    }
    case "stop":
      stopRequested = true;
      signalStop();
      break;
    case "logs.list": {
      port.postMessage({ type: "logs.list", logs: await listSummaries() });
      break;
    }
    case "logs.get": {
      port.postMessage({ type: "logs.get", log: await getRecord(msg.logId) });
      break;
    }
    case "logs.delete":
      await deleteRecord(msg.logId);
      port.postMessage({ type: "logs.list", logs: await listSummaries() });
      break;
    case "logs.clear":
      await clearRecords();
      port.postMessage({ type: "logs.list", logs: [] });
      break;
    case "logs.export": {
      // Fold the live record in first so an in-flight run exports as-is.
      if (currentLog) await flushLog();
      const records = msg.logId
        ? [(await getRecord(msg.logId))].filter((r): r is LogTurnRecord => r !== null)
        : await listRecords();
      port.postMessage({
        type: "logs.export",
        format: msg.format,
        filename: logFilename(msg.format, records.length),
        content: msg.format === "jsonl" ? toJsonl(records) : toMarkdown(records),
      });
      break;
    }
    case "state": {
      const checkpoint = await loadCheckpoint();
      port.postMessage({
        type: "agent.state",
        running: loopRunning,
        checkpoint,
      } satisfies SwToPanel);
      break;
    }
    case "test_suspend":
      keepalive.suspend();
      emit({ kind: "info", message: "keepalive suspended (test hook)" });
      break;
    case "confirm.resolve":
      gate.resolve(msg.id, msg.allow, msg.always ?? false);
      break;
    case "run_tool": {
      const res = await executeTool(msg.name, msg.args ?? {}, msg.tabId);
      port.postMessage({
        type: "tool_result",
        id: msg.id,
        ok: res.ok,
        payload: res.payload,
        error: res.error,
      });
      break;
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  port.onMessage.addListener((msg: PortRequest) => {
    void handleRequest(port, msg);
  });
  port.onDisconnect.addListener(() => ports.delete(port));
  void maybeResume("panel-connect");
});

// Smoke/compat endpoint (also used by the phase verification scripts).
chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { type?: string } | null;
  if (m?.type === "ping") {
    sendResponse({ type: "pong", from: "sw", startedAt, ts: Date.now() });
    void maybeResume("send-message-ping");
  } else if (m?.type === "state") {
    void loadCheckpoint().then((checkpoint) => {
      sendResponse({ type: "agent.state", running: loopRunning, checkpoint });
    });
    return true; // async response
  }
  return false;
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[browser-agent] setPanelBehavior failed", err));
