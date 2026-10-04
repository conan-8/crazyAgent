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
import { sameObservation } from "../shared/observation";
import { runEchoTask } from "./tasks/echo";
import { DebuggerAdapter } from "./adapters/debugger";
import { CdpAdapter } from "./adapters/cdp";
import type { BrowserAdapter } from "./adapters/types";
import { toolRegistry, toLlmTool, validateToolArgs } from "./tools/types";
import { runAgentTask, type ExecuteBatch, type ExecuteResult } from "./agent/loop";
import { createLlmClient } from "./agent/llm";
import { loadSettings } from "./settings";
import { recordHistory } from "./history";
import {
  deleteConversation,
  getConversation,
  listConversationSummaries,
  renameConversation,
  saveConversation,
} from "./conversations";
import {
  foldEvent,
  foldUser,
  forStorage,
  newConversation,
  trimCardImages,
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
  findOpenRecord,
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
  createSkill,
  deleteSkill,
  listSkills,
  markSkillsUsed,
  updateSkill,
} from "./skills";
import { formatSkillsCatalog, rankSkillsForTask } from "../shared/skills";
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
import { describeToolFailure } from "../shared/tool-failure";
import { handoffMessage } from "../shared/handoff";
import { detectAuthWall, HumanGate } from "./handoff";
import { probeElement } from "./tools/actions";
import { probeElementAt } from "./tools/coords";
import {
  captureBlindShot,
  collectSnapshot,
  formatSnapshot,
  settleTab,
  tabIdentity,
} from "./tools/perception";
import "./tools/perception"; // registers snapshot / screenshot / wait_for_settle / wait_for
import "./tools/actions"; // registers click / type / select / key / hover / scroll / read_page
import "./tools/paste"; // registers paste_image (staged-capture delivery)
import "./tools/tabs"; // registers navigate / reload / back / forward / tabs_*
import "./tools/bookmarks"; // registers bookmarks_search / bookmarks_list / topsites_list
import "./tools/misc"; // registers evaluate_js / download (sensitive)
import "./tools/coords"; // registers click_at / hover_at / drag_at / element_at
import "./tools/skills"; // registers use_skill (on-demand procedures)
import "./tools/diagnostics"; // registers console_read / network_read
import { startNetlogCapture } from "./tools/diagnostics";
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
  // Unattended runs fail fast instead of idling 2 minutes per gated action
  // (see currentUnattended). Attended runs keep the default.
  timeoutMs: () => (currentUnattended ? UNATTENDED_CONFIRM_TIMEOUT_MS : undefined),
});
void gate.ready();

/**
 * Human handoff (sign-in / CAPTCHA walls). Separate from the confirm gate:
 * this one is not about risk, it is about a step no agent can honestly do.
 * Only in-page actions are checked — navigating AWAY from a wall is exactly
 * what the agent should do.
 */
const humanGate = new HumanGate(emit);

/** In-page acting tools — the ones that must not fire against a wall. */
const HANDOFF_CHECK_TOOLS = new Set([
  "click",
  "click_at",
  "drag_at",
  "type",
  "key",
  "select",
]);

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

/**
 * Unattended runs: nobody is there to click confirmation cards, so the gate
 * fails fast (~15 s) with text that tells the model the route is unavailable,
 * instead of idling the full 2 minutes and leaving the model to guess why
 * nothing happened (a live run then avoided the cheap gated route entirely
 * and burned 40 minutes on workarounds).
 */
let currentUnattended = false;
const UNATTENDED_CONFIRM_TIMEOUT_MS = 15_000;

/**
 * The tab the agent is working on, tracked explicitly instead of resolved
 * per call as "active tab of the focused window". With several windows open
 * that query silently followed the USER's focus, so tools and screenshots
 * could observe a different page than the one the agent was acting on — a
 * live run lost ~10 minutes to screenshots of a tab it had left behind.
 * Updated by tabs_create / tabs_switch / tabs_close; falls back to the
 * active tab when unset or closed.
 */
let agentTabId: number | undefined;

/** The tab tools should act on right now. */
async function agentTab(): Promise<number | undefined> {
  if (agentTabId !== undefined) {
    const alive = await chrome.tabs.get(agentTabId).catch(() => null);
    if (alive) return agentTabId;
    agentTabId = undefined;
  }
  agentTabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  return agentTabId;
}

/** Remember the agent's tab on the checkpoint so a resume continues on the same page. */
function noteAgentTab(tabId: number | undefined): void {
  agentTabId = tabId;
  if (currentCp && currentCp.tabId !== tabId) currentCp.tabId = tabId;
}

/**
 * Mid-run steering: messages the panel queued for the running agent. Drained
 * by the loop before every LLM call, so the model sees them as ordinary user
 * turns — corrections and additions without stopping the run.
 */
const pendingUserInputs: string[] = [];

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

/**
 * Streamed deltas arrive per SSE chunk — broadcasting one browser message and
 * one panel re-render per chunk is what made the UI (and with it the browser)
 * stutter during long answers. Coalesce for a few ms; every other event
 * flushes the buffer first, so ordering stays exact.
 */
const DELTA_COALESCE_MS = 80;
let deltaText = "";
let deltaReasoning = "";
let deltaTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDeltaFlush(): void {
  if (deltaTimer) return;
  deltaTimer = setTimeout(() => {
    deltaTimer = null;
    flushDeltas();
  }, DELTA_COALESCE_MS);
}

function flushDeltas(): void {
  if (deltaTimer) {
    clearTimeout(deltaTimer);
    deltaTimer = null;
  }
  if (deltaText) {
    const text = deltaText;
    deltaText = "";
    emitNow({ kind: "token_delta", text });
  }
  if (deltaReasoning) {
    const text = deltaReasoning;
    deltaReasoning = "";
    emitNow({ kind: "reasoning_delta", text });
  }
}

function emitNow(event: StepEvent): void {
  broadcast({ type: "agent.event", event });
  if (currentConv) {
    foldEvent(currentConv, event);
    // The folded conversation is the worker's persistence copy — cap the
    // screenshots it holds (the panel keeps its own, separately capped, for
    // display). Unbounded base64 accumulation here was an OOM source.
    trimCardImages(currentConv, 4);
    scheduleConvFlush();
  }
  if (currentLog) {
    foldLogEvent(currentLog, event);
    scheduleLogFlush();
  }
  if (event.kind === "done") {
    void recordHistory(currentTask, event);
  }
}

function emit(event: StepEvent): void {
  if (event.kind === "token_delta") {
    deltaText += event.text;
    scheduleDeltaFlush();
    return;
  }
  if (event.kind === "reasoning_delta") {
    deltaReasoning += event.text;
    scheduleDeltaFlush();
    return;
  }
  flushDeltas();
  emitNow(event);
}
let currentTask = "";

// ---- structured run log (timestamped per turn, archived locally) ----
let currentLog: LogTurnRecord | null = null;
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Token deltas arrive per chunk — flushing on each would hammer storage.
 * Everything is debounced to one write per second: with the per-record
 * storage layout a flush rewrites the whole RUNNING record (tool results up
 * to 8k chars each), so an immediate write on every tool event was both
 * unnecessary and, under load, a churn source. Durability is bounded by the
 * 1s window; run-end flushes explicitly (closeLogRecord / flushConv).
 */
function scheduleLogFlush(): void {
  if (!currentLog) return;
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

/**
 * Provider/model stamp for a log record. Without it an exported log cannot be
 * attributed: per-step latency and prompt-cache behaviour are properties of the
 * endpoint, so "why was this run slow?" is unanswerable after the fact. Failing
 * to read settings must never block the record — an unstamped run still logs.
 */
async function connectionStamp(): Promise<{ provider?: string; model?: string }> {
  try {
    const s = await loadSettings();
    return { provider: s.provider || undefined, model: s.model || undefined };
  } catch {
    return {};
  }
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
    ...(await connectionStamp()),
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
/** Skills whose catalog lines this run's appendix carried. */
let injectedSkillIds: string[] = [];
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

/** Post-run bookkeeping: usage stamps for injected lessons/skills + auto review. */
function afterRun(rec: LogTurnRecord): void {
  const used = injectedLessonIds;
  injectedLessonIds = [];
  if (used.length) void markLessonsUsed(used);
  const usedSkills = injectedSkillIds;
  injectedSkillIds = [];
  if (usedSkills.length) void markSkillsUsed(usedSkills);
  void maybeAutoReview(rec);
}

/** The run a manual review targets: the newest finished one by default. */
async function recordForReview(logId?: string): Promise<LogTurnRecord | null> {
  if (logId) return getRecord(logId);
  // Index-first: picking the newest finished run must not load the archive.
  const sums = await listSummaries();
  const pick = sums.find((s) => s.status !== "running") ?? sums[0];
  return pick ? getRecord(pick.id) : null;
}

// ---- chat conversation (history) for the current run ----
let currentConv: Conversation | null = null;
let currentCp: Checkpoint | null = null;
let convFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleConvFlush(): void {
  if (!currentConv) return;
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
  injectedSkillIds = [];
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
      // Unattended runs make the confirm gate fail fast (see currentUnattended).
      currentUnattended = settings.unattended === true;
      // Jev sidecar: built per run from settings; null when off/unconfigured.
      currentJev = createJevClient(settings.jev);
      setActiveJevClient(currentJev);
      jevFallbackNoted = false;
      const jevEnabled = currentJev !== null;
      // One quiet line when the sidecar rides along; wire/transport details
      // stay in Settings rather than itemised in the transcript.
      if (jevEnabled) {
        emit({ kind: "info", message: "Jev is active", jev: true });
      }
      // Lessons learned: the relevant ones ride in a separate, uncached system
      // block so the base prompt stays cache-stable across runs. Ranked here
      // (not in the loop) because these exact lessons are the ones we stamp as
      // "used" once the run is over.
      const rankedLessons = settings.learn.enabled
        ? rankLessonsForTask(await listLessons(), cp.task)
        : [];
      injectedLessonIds = rankedLessons.map((l) => l.id);
      const lessonsBlock = formatLessonsBlock(rankedLessons);
      // Skills catalog: one line per on-demand procedure, frozen at run start
      // (byte-stable for the whole run — it rides the same uncached appendix
      // as the lessons). Full bodies load via use_skill as tool results, so
      // the cached prefix never mutates mid-run.
      const rankedSkills = rankSkillsForTask(await listSkills(), cp.task);
      injectedSkillIds = rankedSkills.map((s) => s.id);
      const skillsCatalog = formatSkillsCatalog(rankedSkills);
      const appendix = [lessonsBlock, skillsCatalog].filter(Boolean).join("\n\n");
      // The judge tool only reaches the model when Jev can actually answer.
      // Specs freeze here, so the tool list stays byte-stable across the run's
      // steps (provider prompt caching) and across a checkpoint resume.
      cp.toolSpecs ??= [...toolRegistry.values()]
        .filter((t) => t.name !== "judge" || jevEnabled)
        .map(toLlmTool);
      // Auto effort routing: Jev grades the task and may LOWER the thinking
      // level for trivial work (never raises it; falls back on any failure).
      // Silent by design — "Jev is active" above is the only run-start note.
      let thinking = settings.thinking;
      if (settings.autoThinking && currentJev) {
        const routed = await routeThinkingByJev(currentJev, cp.task, settings.thinking);
        thinking = routed.level;
      }
      await runAgentTask(cp, {
        llm: createLlmClient(settings),
        emit,
        save: saveCheckpoint,
        shouldStop: () => stopRequested,
        // No stepCap: the agent runs until it answers, the user stops it, or
        // an error aborts it.
        maxTokens: settings.maxTokens,
        contextWindow: settings.contextWindow,
        thinking,
        madman: settings.madman,
        batchActions: settings.batchActions === true,
        adaptiveThinking: settings.adaptiveThinking === true,
        judgeAvailable:
          jevEnabled && (cp.toolSpecs?.some((t) => t.name === "judge") ?? false),
        lessonsBlock: appendix || undefined,
        takeUserInput: () => {
          const inputs = pendingUserInputs.splice(0);
          // The conversation keeps its own transcript for display/history.
          for (const text of inputs) {
            if (currentConv) foldUser(currentConv, text);
          }
          if (inputs.length) scheduleConvFlush();
          return inputs;
        },
        execute: (name, args, batch) => executeToolGated(name, args, batch),
      });
    }
  } catch (err) {
    emit({ kind: "error", message: String(err) });
  } finally {
    loopRunning = false;
    keepalive.stop();
    // Release the debugger: a session left attached keeps Runtime interception
    // on the user's tab and the debug banner up — real, persistent browser lag
    // for a run that is already over. The next run re-attaches on demand.
    void debuggerAdapter.detachAll();
    const finished = currentLog;
    await closeLogRecord();
    // Final conversation state must survive the run: the debounced flush may
    // still be pending when the worker is about to go idle.
    if (convFlushTimer) {
      clearTimeout(convFlushTimer);
      convFlushTimer = null;
    }
    await flushConv();
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

/**
 * Cap on one auto-observation. This text is re-sent on every subsequent step
 * of the run inside the cached prefix, so its size is not a one-off cost: at
 * 12k chars the observations alone filled the history budget in ~10 actions
 * and forced the truncator to start rewriting the front of the conversation.
 * The model acts on refs and a short text digest; the rest was ballast.
 */
const OBSERVATION_MAX_CHARS = 6_000;

/**
 * Last full observation per tab, for the unchanged-page collapse: a canvas
 * editor's chrome snapshot repeats thousands of tokens per keystroke, and the
 * model gains nothing from a byte-identical dump.
 */
const lastObservations = new Map<number, string>();

/**
 * Tools whose whole output is a page observation — the ones the dedupe below
 * applies to. Actions are deliberately absent: their result carries the action's
 * own outcome, which is never redundant.
 */
const OBSERVATION_ONLY_TOOLS = new Set(["snapshot", "read_page"]);

/**
 * The last explicit perception text handed to the model, per tab. Kept
 * separate from `lastObservations` (which holds the auto-observation text and
 * drives the unchanged-page collapse for canvas editors): mixing the two would
 * let a `snapshot filter:'interactive'` overwrite the default-format text that
 * per-keystroke collapse depends on.
 */
const lastPerceptionText = new Map<number, string>();

/** A digest cut off mid-page cannot be compared safely — the tail is unseen. */
function isTruncatedObservation(text: string): boolean {
  return text.includes("[truncated");
}

/**
 * Collapse a perception result that is identical (modulo the volatile
 * time/save-state flap) to the observation the model just received.
 *
 * Returns null when there is nothing to collapse — a changed page, an image
 * result, a failure, or no prior read for this tab — so the caller falls
 * through to the real result. A collapse is safe by construction: the snapshot
 * was taken fresh, so this reports a genuinely unchanged page, never a guess.
 * Truncated digests are never collapsed, because two pages that agree only on
 * their first N characters are not the same page.
 */
function collapseRepeatObservation(
  name: string,
  res: ExecuteResult,
  tabId: number | undefined,
): ExecuteResult | null {
  if (!OBSERVATION_ONLY_TOOLS.has(name) || !res.ok || tabId === undefined) return null;
  // A blind-page screenshot is the only way the model can see anything here.
  if (res.image) return null;
  const text = res.text;
  if (!text || text.length < 200) return null;
  const prev = lastPerceptionText.get(tabId);
  // Record what the model is being shown either way, so the NEXT identical
  // read collapses even when this one was the first of its kind.
  lastPerceptionText.set(tabId, text);
  if (
    !prev ||
    isTruncatedObservation(prev) ||
    isTruncatedObservation(text) ||
    !sameObservation(prev, text)
  ) {
    return null;
  }
  return {
    ...res,
    text: "[page unchanged since your last observation — the refs you already have are still current; act on them instead of re-reading the page]",
    // The panel card should not render a multi-KB dump the model never read.
    payload: { unchanged: true },
  };
}

/** Best-effort settle + compact snapshot after an action; null on failure. */
async function observeAfterAction(
  tabId: number,
  settleMs = 10_000,
): Promise<string | null> {
  try {
    // Shorter reachability budget than the manual tool: fail fast on pages
    // where the content script can never run (chrome://, PDF viewer, …).
    await settleTab(tabId, settleMs, 8).catch(() => null);
    const snap = await collectSnapshot(tabId);
    if (!snap.frames.length) return null;
    const text = formatSnapshot(snap);
    const prev = lastObservations.get(tabId);
    lastObservations.set(tabId, text);
    if (prev && sameObservation(prev, text)) {
      return "[page unchanged since the previous observation]";
    }
    return text.length > OBSERVATION_MAX_CHARS
      ? `${text.slice(0, OBSERVATION_MAX_CHARS)}…[truncated]`
      : text;
  } catch {
    return null; // observation is an optimization — never fail the action
  }
}

/**
 * When a tool fails, the model's next move depends on SEEING the page — a real
 * run retried a dead frame probe six times and then reconstructed a graph from
 * PNG pixel statistics because no failure ever showed it the screen. One
 * best-effort screenshot now rides back with every failure.
 */
async function withFailureShot(
  name: string,
  res: ExecuteResult,
  tabId: number | undefined,
): Promise<ExecuteResult> {
  if (name === "screenshot" || tabId === undefined || stopRequested) return res;
  const shot = await captureBlindShot(await adapterForMode(), tabId);
  if (!shot) return res;
  // Name the tab the shot came from: an unidentified image is exactly what
  // left a real run convinced its screenshot tool was returning stale caches
  // (it was looking at a different tab).
  const label = await tabIdentity(tabId);
  return {
    ...res,
    error: `${res.error ?? "tool failed"}\n[screenshot attached — ${label} — this is what the page looked like when the call failed; LOOK at it before choosing your next move]`,
    image: shot,
  };
}

/** Policy-gated executor used by the agent loop (Phase 6). */
async function executeToolGated(
  name: string,
  args: Record<string, unknown>,
  batch?: ExecuteBatch,
): Promise<ExecuteResult> {
  let probe: ElementProbe | null = null;
  // `click_at`/`type_at`/`drag_at` carry a point instead of a ref; the probe
  // then comes from whatever sits under that point, so coordinate actions
  // are gated exactly like ref-based ones.
  const needsProbe =
    name === "type" ||
    name === "click" ||
    name === "key" ||
    name === "click_at" ||
    name === "type_at" ||
    name === "drag_at";
  const tabId = await agentTab();
  if (needsProbe && tabId !== undefined) {
    probe =
      typeof args.ref === "string"
        ? await probeElement(tabId, args.ref).catch(() => null)
        : await probeElementAt(tabId, args).catch(() => null);
  }
  let risk = assess(name, args, probe);
  // Jev risk gate: mutating actions the regex rules allowed get one batched,
  // time-boxed decision call. Union-only — Jev can add a confirm, never drop
  // one — and any failure falls through to the deterministic verdict. A
  // completed check is stamped on the result (`jevGate`) so the panel can
  // mark the card pink — the check itself is otherwise invisible.
  let jevChecked = false;
  if (risk.level === "allow" && isMutating(name) && currentJev && !stopRequested) {
    try {
      const result = await currentJev.decide(
        buildRiskState(currentTask, name, args, probe),
        JEV_RISK_QUESTIONS,
        { timeoutMs: JEV_GATE_TIMEOUT_MS },
      );
      jevChecked = true;
      risk = assessWithJev(risk, toRiskAnswers(result.answers), probe?.text ?? undefined);
    } catch (err) {
      if (!jevFallbackNoted) {
        jevFallbackNoted = true;
        const msg = err instanceof Error ? err.message : String(err);
        // The endpoint said it outright: a decisions model was asked to chat.
        // Name the fix instead of leaving a raw 400 in the transcript.
        const hint = /chat\/completions|decisions (model|endpoint)/i.test(msg)
          ? " — set the Jev endpoint to 'TypeSafe (Jev)': decision models never answer on /chat/completions"
          : "";
        emit({
          kind: "info",
          message: `Jev unavailable (${msg})${hint} — continuing with rule-based policy only`,
          jev: true,
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
  // Human handoff: acting on a sign-in wall or a CAPTCHA is where a run goes
  // wrong — the model retries the impossible, or "completes" a task that never
  // happened. One prompt per wall per run; read-only tools are never gated.
  if (HANDOFF_CHECK_TOOLS.has(name) && tabId !== undefined) {
    const wall = await detectAuthWall(tabId, currentTask, probe).catch(() => null);
    if (wall && !humanGate.alreadySeen(wall.url)) {
      const { handled } = await humanGate.request(wall.reason, wall.url);
      // In-band: the tool does NOT run against the wall, and the model is told
      // exactly what happened so it re-looks instead of retrying blindly.
      return { ok: true, text: handoffMessage(wall.reason, handled) };
    }
  }
  const res = await executeTool(name, args);
  if (jevChecked) res.jevGate = true;
  // A failure is exactly the "concerned" moment: show the page, don't guess.
  if (!res.ok) return withFailureShot(name, res, tabId);
  // Tab moves redefine which tab the agent works on for every later call —
  // tracked explicitly (and checkpointed) so perception can never drift to
  // "whatever window the user happens to focus".
  if (name === "tabs_create") {
    const created = (res.payload as { tabId?: number } | undefined)?.tabId;
    if (typeof created === "number") noteAgentTab(created);
  } else if (name === "tabs_switch" && Number.isFinite(Number(args.tabId))) {
    noteAgentTab(Number(args.tabId));
  } else if (name === "tabs_close" && Number(args.tabId) === agentTabId) {
    noteAgentTab(undefined);
  }
  if (!AUTO_OBSERVE_TOOLS.has(name) || stopRequested) {
    // Redundant-observation guard. Actions already return a fresh observation,
    // and a model that ignores that (or re-checks out of habit) used to receive
    // the identical multi-thousand-token page dump again — the exact text that
    // fills the history budget and forces the truncator to rewrite the front of
    // the conversation. The capture still happens (so nothing can be stale);
    // only the duplicate TEXT is collapsed, and an image result is never
    // collapsed because a blind shot is the model's only way to see.
    const deduped = collapseRepeatObservation(name, res, tabId);
    return deduped ?? res;
  }
  // Defer the settle+snapshot to the LAST call of a batch. When the model
  // batches several actions into one step, only the final page state is ever
  // read: observing after each intermediate action pays a full settle and
  // re-sends a snapshot the very next action invalidates. The intermediate
  // call still reports its own result, so nothing is hidden from the model.
  if (batch && batch.index < batch.count - 1) {
    const done = res.text ?? JSON.stringify(res.payload ?? null);
    return {
      ...res,
      text: `${done}\n\n[action applied — the page observation for this step follows after the last call]`,
    };
  }
  // Observe whichever tab the agent is on NOW — tabs_create/tabs_switch moved it.
  const obsTabId = (await agentTab()) ?? tabId;
  if (obsTabId === undefined) return res;
  // Keystroke-level edits on canvas editors never go "quiet" (the editor keeps
  // painting and saving), so a full settle budget there is pure dead time —
  // ~10 s per key/type call in a live run. Submit-ish actions keep the budget.
  const settles =
    (name === "type" && args.submit !== true) ||
    (name === "key" && !/enter/i.test(String(args.key ?? "")))
      ? 3_500
      : 10_000;
  const observation = await observeAfterAction(obsTabId, settles);
  if (stopRequested) return res;
  const base = res.text ?? JSON.stringify(res.payload ?? null);
  if (!observation || observation.trim().length < 32) {
    // The action landed but the text tools see nothing: attach a screenshot so
    // the model verifies with its eyes instead of assuming nothing happened.
    const shot = await captureBlindShot(await adapterForMode(), obsTabId);
    const label = shot ? await tabIdentity(obsTabId) : "";
    return shot
      ? {
          ...res,
          text: `${base}\n\n--- page after action ---\n[The text tools see nothing on ${label} — screenshot attached. LOOK at it to verify what the action did.]`,
          image: shot,
        }
      : res;
  }
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
    return { ok: false, error: describeToolFailure(validation.error.replace(/^ERROR: /, "")) };
  }
  const targetTabId = tabId ?? (await agentTab());
  if (targetTabId === undefined) {
    return { ok: false, error: describeToolFailure("no active tab") };
  }
  try {
    const adapter = await adapterForMode();
    const payload = await tool.run(args, {
      tabId: targetTabId,
      adapter,
      emit,
      // Blocking tools (waits) check this between polls so Stop lands fast.
      stopping: () => stopRequested,
    });
    // Action-style tools resolve with { ok: false, error } instead of throwing.
    if (
      payload &&
      typeof payload === "object" &&
      (payload as { ok?: boolean }).ok === false
    ) {
      return {
        ok: false,
        error: describeToolFailure((payload as { error?: unknown }).error ?? "tool failed"),
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
    // Name the layer that failed and the next move. A bare "fetch failed" here
    // is what left a real run retrying a dead call 20 times.
    return { ok: false, error: describeToolFailure(err) };
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
  // Steered input belongs to the run it was typed for — never leak it into
  // the next one.
  pendingUserInputs.length = 0;
  humanGate.reset();
  // The agent starts on the tab the user is looking at; from here on every
  // tool call targets THIS tracked tab (see agentTab), not "whatever window
  // happens to be focused later".
  agentTabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  // Console/network capture starts with the run, so the read tools see this
  // run's traffic instead of an empty buffer. Observability extra: best
  // effort, never able to fail or slow a run.
  void (async () => {
    try {
      if (agentTabId !== undefined) {
        await startNetlogCapture(agentTabId, await adapterForMode());
      }
    } catch {
      // no capture on this transport — console_read/network_read say so
    }
  })();

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
    tabId: agentTabId,
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
    // Restore the tab the run was driving so the resume continues on the same
    // page instead of latching onto whatever tab is focused now.
    agentTabId = cp.tabId;
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
      const open = await findOpenRecord(cp.conversationId);
      if (open) {
        open.resumed = true;
        currentLog = open;
      } else {
        currentLog = newTurnRecord(cp.task, {
          conversationId: cp.conversationId,
          mode: cp.mode,
          ...(await connectionStamp()),
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
      // Summaries straight from the index — listing history must never
      // deserialize every stored thread.
      port.postMessage({
        type: "history.list",
        conversations: await listConversationSummaries(),
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
      port.postMessage({
        type: "history.list",
        conversations: await listConversationSummaries(),
      });
      break;
    }
    case "history.rename": {
      // The live thread object feeds every later flush — retitle it too, or
      // the next save would overwrite the rename with the old title.
      const title = String((msg as { title?: unknown }).title ?? "")
        .trim()
        .slice(0, 80);
      if (title) {
        if (currentConv?.id === msg.conversationId) currentConv.title = title;
        await renameConversation(msg.conversationId, title);
        port.postMessage({
          type: "history.list",
          conversations: await listConversationSummaries(),
        });
      }
      break;
    }
    case "run.input": {
      // Mid-run steering: queue it; the loop appends it as a user message
      // before its next model call. Without a run there is nothing to steer.
      const text = String((msg as { text?: unknown }).text ?? "").trim();
      if (text && loopRunning) pendingUserInputs.push(text);
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
    case "skills.list":
      port.postMessage({ type: "skills.list", skills: await listSkills() });
      break;
    case "skills.new": {
      const made = await createSkill(msg.skill);
      port.postMessage({
        type: "skills.list",
        skills: await listSkills(),
        ...(made.error ? { error: made.error } : {}),
      });
      break;
    }
    case "skills.update": {
      if (msg.patch) await updateSkill(msg.id, msg.patch);
      port.postMessage({ type: "skills.list", skills: await listSkills() });
      break;
    }
    case "skills.delete":
      await deleteSkill(msg.id);
      port.postMessage({ type: "skills.list", skills: await listSkills() });
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
    case "human.resolve":
      humanGate.resolve(msg.id, msg.handled);
      break;
    case "run_tool": {
      // `gated` routes through the policy + handoff gate (what the agent loop
      // uses); without it the call is raw execution, as before.
      const res = msg.gated
        ? await executeToolGated(msg.name, msg.args ?? {})
        : await executeTool(msg.name, msg.args ?? {}, msg.tabId);
      port.postMessage({
        type: "tool_result",
        id: msg.id,
        ok: res.ok,
        payload: res.payload,
        // The compact rendering the agent loop would hand the model. Driver
        // scripts assert on `text` when what matters is what the model actually
        // reads (e.g. whether iframe content reached the snapshot).
        text: res.text,
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
  .catch((err) => console.error("[crazyAgent] setPanelBehavior failed", err));
