// Background service worker: message bus, task runner, keepalive, resume.
// The Phase 4 agent loop replaces the echo task behind the same bus.
import {
  PORT_NAME,
  type Checkpoint,
  type ControlMode,
  type DemoConfig,
  type LlmMessage,
  type LogExportFormat,
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
import {
  clearLessons,
  deleteLesson,
  listLessons,
  markLessonsUsed,
  saveLessons,
  updateLesson,
} from "./lessons";
import {
  formatLessonsBlock,
  lessonsToJsonl,
  lessonsToMarkdown,
  rankLessonsForTask,
  shouldAutoReview,
} from "../shared/lessons";
import { learnFromRun } from "./agent/coach";
import {
  JEV_RISK_QUESTIONS,
  assess,
  assessWithJev,
  buildRiskState,
  toRiskAnswers,
  ConfirmGate,
  type ElementProbe,
} from "./policy";
import {
  createJevClient,
  routeThinkingByJev,
  setActiveJevClient,
  type JevClient,
} from "./agent/jev";
import { isMutating } from "../shared/modes";
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
import "./tools/jev"; // registers judge (Jev sidecar; offered only when configured)

const ALWAYS_KEY = "baPolicyAlways";

/**
 * Jev sidecar state for the current run. `currentJev` risk-checks mutating
 * actions the regex rules allowed; the judge tool reads the same client via
 * agent/jev's active-holder. Both are null when Jev is off — every path then
 * behaves exactly as before Jev existed.
 */
let currentJev: JevClient | null = null;
let jevFallbackNoted = false;
const JEV_GATE_TIMEOUT_MS = 2_000;

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

// ---- self-improvement ("coach"): lessons learned from finished runs ----
// A SECOND agent on the SAME model reviews a finished run and writes what it
// learned (what failed, what to do instead) into this profile's local lesson
// log; later runs read the relevant ones back in their system prompt. Every
// path here is best-effort and deliberately silent: the coach emits no
// StepEvents, so its activity never lands in the chat thread or the run
// archive, and a review that fails costs one call, never the run it reviewed.

/** Lessons the run that is currently executing received in its prompt. */
let injectedLessonIds: string[] = [];
/**
 * Reviews are chained: each one reads-modifies-writes the same storage key, so
 * a manual review landing during an auto review must not interleave with it.
 */
let reviewChain: Promise<void> = Promise.resolve();

function lessonFilename(format: LogExportFormat): string {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
  return `crazyagent-lessons-${stamp}.${format}`;
}

/**
 * Queue one review behind any other. `announce` marks user-triggered reviews,
 * which get a `started` status so the panel can show progress; auto reviews
 * only report their outcome.
 */
function queueReview(
  rec: LogTurnRecord,
  source: "auto" | "manual",
  announce: boolean,
): void {
  reviewChain = reviewChain
    .then(async () => {
      if (announce) {
        broadcast({ type: "lessons.review", status: "started", task: rec.task, source });
      }
      const settings = await loadSettings();
      if (!settings.apiKey) {
        broadcast({
          type: "lessons.review",
          status: "error",
          task: rec.task,
          source,
          message: "no API key configured — add one in Settings",
        });
        return;
      }
      const outcome = await learnFromRun({
        llm: createLlmClient(settings),
        record: rec,
        existing: await listLessons(),
        source,
        save: saveLessons,
      });
      broadcast({
        type: "lessons.review",
        status: outcome.status,
        task: rec.task,
        source,
        added: outcome.added,
        merged: outcome.merged,
        total: outcome.total,
        message:
          outcome.status === "error"
            ? outcome.message
            : outcome.notes.length
              ? outcome.notes.join("; ")
              : undefined,
      });
      if (outcome.status === "added") {
        broadcast({ type: "lessons.list", lessons: await listLessons() });
      }
    })
    .catch((err) => {
      broadcast({
        type: "lessons.review",
        status: "error",
        task: rec.task,
        source,
        message: String((err as Error)?.message ?? err),
      });
    });
}

/** Review runs that went wrong, unprompted — cheap, and exactly the ones worth
 * learning from. Clean runs are reviewed only when the user asks. */
async function maybeAutoReview(rec: LogTurnRecord): Promise<void> {
  if (!shouldAutoReview(rec).review) return;
  const settings = await loadSettings();
  if (!settings.learn.enabled || !settings.learn.auto) return;
  if (!settings.apiKey) return;
  queueReview(rec, "auto", false);
}

/** Post-run bookkeeping: usage stamps for injected lessons + auto review. */
function afterRun(rec: LogTurnRecord): void {
  const used = injectedLessonIds;
  injectedLessonIds = [];
  if (used.length) void markLessonsUsed(used);
  void maybeAutoReview(rec);
}

/** The run a manual review targets: the newest finished one by default. */
async function recordForReview(logId?: string): Promise<LogTurnRecord | null> {
  if (logId) return getRecord(logId);
  const records = await listRecords();
  return records.find((r) => r.status !== "running") ?? records[0] ?? null;
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
  injectedLessonIds = [];
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
      // Jev sidecar: built per run from settings; null when off/unconfigured.
      currentJev = createJevClient(settings.jev);
      setActiveJevClient(currentJev);
      jevFallbackNoted = false;
      const jevEnabled = currentJev !== null;
      // Lessons learned: the relevant ones ride in a separate, uncached system
      // block so the base prompt stays cache-stable across runs. Ranked here
      // (not in the loop) because these exact lessons are the ones we stamp as
      // "used" once the run is over.
      const rankedLessons = settings.learn.enabled
        ? rankLessonsForTask(await listLessons(), cp.task)
        : [];
      injectedLessonIds = rankedLessons.map((l) => l.id);
      const lessonsBlock = formatLessonsBlock(rankedLessons);
      // The judge tool only reaches the model when Jev can actually answer.
      // Specs freeze here, so the tool list stays byte-stable across the run's
      // steps (provider prompt caching) and across a checkpoint resume.
      cp.toolSpecs ??= [...toolRegistry.values()]
        .filter((t) => t.name !== "judge" || jevEnabled)
        .map(toLlmTool);
      // Auto effort routing: Jev grades the task and may LOWER the thinking
      // level for trivial work (never raises it; falls back on any failure).
      let thinking = settings.thinking;
      if (settings.autoThinking && currentJev) {
        const routed = await routeThinkingByJev(currentJev, cp.task, settings.thinking);
        thinking = routed.level;
        if (routed.complexity) {
          emit({
            kind: "info",
            message: `thinking: ${thinking} (task graded '${routed.complexity}' by Jev)`,
          });
        }
      }
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
        thinking,
        madman: settings.madman,
        judgeAvailable:
          jevEnabled && (cp.toolSpecs?.some((t) => t.name === "judge") ?? false),
        lessonsBlock,
        execute: (name, args) => executeToolGated(name, args),
      });
    }
  } catch (err) {
    emit({ kind: "error", message: String(err) });
  } finally {
    loopRunning = false;
    keepalive.stop();
    const finished = currentLog;
    await closeLogRecord();
    await clearCheckpoint();
    // Only after the run is fully closed and its record persisted: whatever the
    // coach does next must not appear in the record it is reviewing.
    if (finished) afterRun(finished);
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
  let risk = assess(name, args, probe);
  // Jev risk gate: mutating actions the regex rules allowed get one batched,
  // time-boxed decision call. Union-only — Jev can add a confirm, never drop
  // one — and any failure falls through to the deterministic verdict.
  if (risk.level === "allow" && isMutating(name) && currentJev && !stopRequested) {
    try {
      const result = await currentJev.decide(
        buildRiskState(currentTask, name, args, probe),
        JEV_RISK_QUESTIONS,
        { timeoutMs: JEV_GATE_TIMEOUT_MS },
      );
      risk = assessWithJev(risk, toRiskAnswers(result.answers), probe?.text ?? undefined);
    } catch (err) {
      if (!jevFallbackNoted) {
        jevFallbackNoted = true;
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          kind: "info",
          message: `Jev unavailable (${msg}) — continuing with rule-based policy only`,
        });
      }
    }
  }
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
    // Restore the task text too: history recording and Jev's risk state both
    // read it, and a resumed run never went through startRun.
    currentTask = cp.task;
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
    case "lessons.list": {
      port.postMessage({ type: "lessons.list", lessons: await listLessons() });
      break;
    }
    case "lessons.review": {
      const rec = await recordForReview(msg.logId);
      if (!rec) {
        broadcast({
          type: "lessons.review",
          status: "error",
          source: "manual",
          message: "no finished run to review yet — run a task first",
        });
        break;
      }
      queueReview(rec, "manual", true);
      break;
    }
    case "lessons.update": {
      await updateLesson(msg.id, {
        ...(msg.text !== undefined ? { text: msg.text } : {}),
        ...(msg.pinned !== undefined ? { pinned: msg.pinned } : {}),
        ...(msg.category !== undefined ? { category: msg.category } : {}),
      });
      port.postMessage({ type: "lessons.list", lessons: await listLessons() });
      break;
    }
    case "lessons.delete":
      await deleteLesson(msg.id);
      port.postMessage({ type: "lessons.list", lessons: await listLessons() });
      break;
    case "lessons.clear":
      await clearLessons();
      port.postMessage({ type: "lessons.list", lessons: [] });
      break;
    case "lessons.export": {
      const all = await listLessons();
      port.postMessage({
        type: "lessons.export",
        format: msg.format,
        filename: lessonFilename(msg.format),
        content: msg.format === "jsonl" ? lessonsToJsonl(all) : lessonsToMarkdown(all),
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
