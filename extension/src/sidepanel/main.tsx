// Side panel — chat interface with a full control bar (mode / model,
// live run stats, attachments). Assistant turns are ordered blocks: tool
// activity streams in as a timeline, the rendered-markdown answer lands below
// it. Threads persist to history with multi-turn context.
// Test hooks stay on window.__ba (phase smokes rely on the stable surface).
import { render, type ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  PORT_NAME,
  type AgentWindowStatus,
  type Checkpoint,
  type Conversation,
  type ConversationSummary,
  type DemoConfig,
  type LogExportFormat,
  type LogSummary,
  type LogTurnRecord,
  type Lesson,
  type PortRequest,
  type RunAttachment,
  type Skill,
  type StepEvent,
  type SwToPanel,
  type TodoItem,
} from "../shared/protocol";
import {
  foldEvent,
  foldUser,
  newConversation,
  trimCardImages,
  type ChatBlock,
  type ChatTurn,
  type ToolCard,
} from "../shared/chat";
import { formatElapsed, formatTokens } from "../shared/modes";
import {
  matchSlash,
  parseSlash,
  SLASH_COMMANDS,
  type SlashCommand,
} from "../shared/slash";
import { THINKING_LEVELS } from "../shared/llm";
import { madmanExclamation } from "../shared/madman";
import { versionLabel } from "../shared/version";
import {
  JEV_TRANSPORT_DEFAULTS,
  JEV_TRANSPORT_OPTIONS,
  isJevDecisionsModel,
  type JevTransport,
} from "../shared/jev";
import {
  fetchModelsFor,
} from "../shared/models";
import {
  loadSettings,
  saveSettings,
  makeEntry,
  normalizeSettings,
  activeApiKey,
  activeConnection,
  CONNECTION_DEFAULTS,
  type AgentSettings,
  type ApiKeyEntry,
  type JevSettings,
} from "../background/settings";
import { Icon, ICONS } from "./icons";
import { Collapse, useAutosize, usePresence, useStickToBottom } from "./motion";

const app = document.getElementById("app");
if (!app) throw new Error("#app missing");

marked.setOptions({ gfm: true, breaks: true });

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "p", "br", "strong", "em", "del", "s",
  "code", "pre", "ul", "ol", "li", "blockquote", "a", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
];

function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title"],
  });
}

// ---- shared state for test hooks (outside React for stable identities) ----
const eventBuffer: StepEvent[] = [];

/**
 * Events are buffered for the whole run and every smoke reads them back with
 * `JSON.stringify(__ba.events())`. A `tool_result` carries the full base64
 * screenshot, so buffering them verbatim pinned every capture of a vision-heavy
 * run in the panel's heap — the trim that keeps the transcript small was undone
 * here. Keep just the head of the data URL: enough for a caller to assert one
 * was attached and what kind, not enough to decode.
 */
function bufferedEvent(e: StepEvent): StepEvent {
  if (e.kind !== "tool_result" || !e.image) return e;
  return { ...e, image: e.image.slice(0, 64) };
}
const listeners = new Set<(e: StepEvent) => void>();
let currentConv: Conversation | null = null;

let postPort: ((req: PortRequest) => void) | null = null;
const toolWaiters = new Map<
  string,
  (msg: { ok: boolean; payload?: unknown; text?: string; error?: string }) => void
>();

function runTool(
  name: string,
  args: Record<string, unknown> = {},
  tabId?: number,
): Promise<unknown> {
  return runToolFull(name, args, tabId).then((m) => m.payload);
}

/**
 * Like `runTool`, but also hands back the compact rendering the agent loop
 * would send the model. Driver scripts use this when what matters is what the
 * model actually reads (e.g. whether iframe content reached the snapshot).
 */
function runToolFull(
  name: string,
  args: Record<string, unknown> = {},
  tabId?: number,
  gated = false,
): Promise<{ payload?: unknown; text?: string }> {
  return new Promise((resolve, reject) => {
    if (!postPort) {
      reject(new Error("port not connected"));
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    toolWaiters.set(id, (m) =>
      m.ok ? resolve({ payload: m.payload, text: m.text }) : reject(new Error(m.error ?? "tool failed")),
    );
    postPort({ kind: "run_tool", id, name, args, tabId, gated });
  });
}

function newLocalConversation(task: string): Conversation {
  const conv = newConversation(crypto.randomUUID(), task);
  currentConv = conv;
  return conv;
}

// ------------------------------ primitives ------------------------------

/** Brand mark: an ember circle that, while the agent works, morphs through
 *  shapes (triangle, square, star, hexagon…) with intermittent rotation. */
function Orb({ size = 22, active = false, class: cls = "" }: { size?: number; active?: boolean; class?: string }) {
  return (
    <span
      class={`orb ${active ? "orb-active" : ""} ${cls}`}
      style={`--orb:${size}px`}
      aria-hidden="true"
    />
  );
}

/** Icon-only button with a styled tooltip; `label` is its (hidden) text. */
function IconButton({
  icon,
  tip,
  label,
  onClick,
  class: cls = "",
  tipAlign = "center",
}: {
  icon: string;
  tip: string;
  label?: string;
  onClick: () => void;
  class?: string;
  tipAlign?: "center" | "end";
}) {
  return (
    <button
      class={`btn-icon ${cls}`}
      onClick={onClick}
      aria-label={tip}
      data-tip={tip}
      data-tip-align={tipAlign}
    >
      <Icon d={icon} size={15} />
      {label ? <span class="vh" aria-hidden="true">{label}</span> : null}
    </button>
  );
}

// ------------------------------ blocks ------------------------------

function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  // Parse+sanitize is the expensive part of a render, and a whole run folds into
  // ONE assistant turn — so without this every streamed token re-parsed the
  // markdown of every block the run had produced so far. Memoizing on `text`
  // leaves only the block currently being written to.
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      class={`md${streaming ? " is-streaming" : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Per-tool glyph plus past/present-tense verbs for the activity timeline. */
const TOOL_META: Record<string, { icon: string; done: string; active: string }> = {
  navigate: { icon: ICONS.globe, done: "Navigated", active: "Navigating" },
  back: { icon: ICONS.arrowLeft, done: "Went back", active: "Going back" },
  forward: { icon: ICONS.arrowRight, done: "Went forward", active: "Going forward" },
  reload: { icon: ICONS.reload, done: "Reloaded", active: "Reloading" },
  screenshot: { icon: ICONS.camera, done: "Captured", active: "Capturing" },
  read_page: { icon: ICONS.doc, done: "Read", active: "Reading" },
  snapshot: { icon: ICONS.eye, done: "Inspected", active: "Inspecting" },
  wait_for_settle: { icon: ICONS.clock, done: "Waited", active: "Waiting" },
  click: { icon: ICONS.pointer, done: "Clicked", active: "Clicking" },
  type: { icon: ICONS.keyboard, done: "Typed", active: "Typing" },
  select: { icon: ICONS.list, done: "Selected", active: "Selecting" },
  key: { icon: ICONS.command, done: "Pressed", active: "Pressing" },
  hover: { icon: ICONS.cursor, done: "Hovered", active: "Hovering" },
  scroll: { icon: ICONS.updown, done: "Scrolled", active: "Scrolling" },
  download: { icon: ICONS.download, done: "Downloaded", active: "Downloading" },
  upload: { icon: ICONS.upload, done: "Attached files", active: "Attaching files" },
  paste_image: { icon: ICONS.upload, done: "Pasted image", active: "Pasting image" },
  evaluate_js: { icon: ICONS.code, done: "Evaluated", active: "Evaluating" },
  judge: { icon: ICONS.sparkles, done: "Judged", active: "Judging" },
  network_mock: { icon: ICONS.activity, done: "Mocked", active: "Mocking" },
  network_rewrite: { icon: ICONS.activity, done: "Rewrote", active: "Rewriting" },
  network_observe: { icon: ICONS.activity, done: "Observed", active: "Observing" },
  network_clear: { icon: ICONS.activity, done: "Cleared rules", active: "Clearing rules" },
  tabs_list: { icon: ICONS.window, done: "Listed tabs", active: "Listing tabs" },
  tabs_create: { icon: ICONS.window, done: "Opened tab", active: "Opening tab" },
  tabs_switch: { icon: ICONS.window, done: "Switched tab", active: "Switching tab" },
  tabs_close: { icon: ICONS.window, done: "Closed tab", active: "Closing tab" },
  bookmarks_search: { icon: ICONS.search, done: "Searched bookmarks", active: "Searching bookmarks" },
  bookmarks_list: { icon: ICONS.list, done: "Listed bookmarks", active: "Listing bookmarks" },
  topsites_list: { icon: ICONS.layers, done: "Listed shortcuts", active: "Listing shortcuts" },
};

function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The one argument that says what a call did (URL host, typed text, ref…). */
function argPreview(args: string): string {
  const a = parseArgs(args);
  if (!a) return "";
  if (typeof a.url === "string") {
    try {
      const u = new URL(a.url);
      return u.host + (u.pathname !== "/" ? u.pathname : "");
    } catch {
      return a.url;
    }
  }
  for (const k of ["text", "value", "query", "key", "ref", "selector", "direction", "pattern", "urlPattern", "expression", "tabId"]) {
    const v = a[k];
    if (typeof v === "string" && v) return k === "text" || k === "value" ? `“${v}”` : v;
    if (typeof v === "number") return k === "tabId" ? `tab ${v}` : String(v);
  }
  return "";
}

function prettyArgs(args: string): string {
  const a = parseArgs(args);
  return a ? JSON.stringify(a, null, 2) : args;
}

type ToolState = "run" | "ok" | "err" | "idle";

function StatusGlyph({ state }: { state: ToolState }) {
  if (state === "run") return <span class="status-glyph spinner" aria-label="running" />;
  if (state === "idle") return <span class="status-glyph glyph-idle" aria-label="not run" />;
  return (
    <span class={`status-glyph glyph-${state}`} aria-label={state === "ok" ? "done" : "failed"}>
      <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
        <path pathLength={1} d={state === "ok" ? "M5 12.5l4.5 4.5L19 7.5" : "M7 7l10 10M17 7 7 17"} />
      </svg>
    </span>
  );
}

function ToolRow({
  card,
  active,
  onZoom,
}: {
  card: ToolCard;
  active: boolean;
  onZoom: (src: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // A card's detail body carries the pretty-printed args JSON and up to 8k of
  // result text. JSX children are evaluated whether or not Collapse mounts
  // them, so every collapsed card in the run was re-parsing and re-creating its
  // whole body on every render of the transcript. Build it once, on first open;
  // keep it mounted after that so collapsing still animates.
  const [seen, setSeen] = useState(false);
  const meta = TOOL_META[card.name];
  const state: ToolState = card.filled ? (card.ok ? "ok" : "err") : active ? "run" : "idle";
  const preview = useMemo(() => argPreview(card.args), [card.args]);
  const jev = card.jev === true;
  // Silent Jev risk checks get a subtle mark (rail + dot); the full pink tint
  // stays reserved for calls Jev actually answered (judge) or escalated.
  const gate = card.jevGate === true && !jev;
  const toggle = () => {
    setOpen(!open);
    if (!open) setSeen(true);
  };
  return (
    <div class={`card card-${state}${jev ? " card-jev" : ""}${gate ? " card-gate-jev" : ""}${open ? " is-open" : ""}`}>
      <div
        class="card-title"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span class="tool-icon">
          <Icon d={meta?.icon ?? ICONS.tool} size={13} />
        </span>
        <span class="tool-text">
          <span class="tool-label">
            {state === "run" ? (meta?.active ?? "Running") : (meta?.done ?? "Ran")}
          </span>
          {preview ? (
            <span class="tool-preview">{preview}</span>
          ) : (
            <span class={`tool-chip${jev ? " is-jev" : ""}`}>
              {jev ? "Jev · " : ""}
              {card.label ?? card.name}
            </span>
          )}
        </span>
        {card.image ? (
          <button
            class="thumb-mini"
            onClick={(e) => {
              e.stopPropagation();
              onZoom(card.image!);
            }}
            aria-label="View screenshot"
          >
            <img src={card.image} alt="" />
          </button>
        ) : null}
        <StatusGlyph state={state} />
        {card.jevGate === true ? (
          <span
            class="jev-dot"
            title="risk-checked by Jev — allowed"
            aria-label="risk-checked by Jev"
          />
        ) : null}
        <span class="chev">
          <Icon d={ICONS.chevron} size={12} />
        </span>
      </div>
      <Collapse open={open}>
        {seen ? (
          <div class="card-detail">
            {card.args && card.args !== "{}" ? (
              <div class="card-section">
                <span class="card-k">{card.name}</span>
                <pre class="card-body">{prettyArgs(card.args)}</pre>
              </div>
            ) : null}
            {card.result ? (
              <div class="card-section">
                <span class="card-k">{card.ok ? "result" : "error"}</span>
                <pre class="card-body card-result">{card.result}</pre>
              </div>
            ) : null}
            {card.image ? (
              <img class="thumb" src={card.image} alt="Screenshot" onClick={() => onZoom(card.image!)} />
            ) : null}
          </div>
        ) : null}
      </Collapse>
    </div>
  );
}

/**
 * Word counts for reasoning blocks, cached on the block object. The collapsed
 * header shows a live count, so it is recomputed on every render — a full
 * whitespace split of the whole thought, per frame. Reasoning blocks only ever
 * grow by appending, so count the new tail and carry the running total instead;
 * anything else (a thread loaded from history) counts once and is then cached.
 */
const reasoningWordCounts = new WeakMap<
  object,
  { len: number; words: number; midWord: boolean }
>();

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function reasoningWords(block: object, text: string): number {
  const seen = reasoningWordCounts.get(block);
  let words: number;
  if (seen && text.length >= seen.len) {
    const tail = text.slice(seen.len);
    const added = countWords(tail);
    // A tail continuing the previous partial word adds no new word of its own.
    words = seen.words + (added && seen.midWord && !/^\s/.test(tail) ? added - 1 : added);
  } else {
    words = countWords(text);
  }
  reasoningWordCounts.set(block, {
    len: text.length,
    words,
    midWord: text.length > 0 && !/\s$/.test(text),
  });
  return words;
}

/**
 * Model reasoning ("thinking"). Collapsed by default and auto-opened while it
 * is still streaming, so long reasoning never pushes the answer off-screen.
 */
function ReasoningBlock({
  block,
  live,
}: {
  block: Extract<ChatBlock, { kind: "reasoning" }>;
  live: boolean;
}) {
  const text = block.text;
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const expanded = touched ? open : live;
  // Same latch Collapse keeps: the body stays mounted through the collapse so
  // it animates instead of snapping — but a block that was never opened never
  // builds its (potentially huge) text node at all.
  const [seen, setSeen] = useState(expanded);
  useEffect(() => {
    if (expanded && !seen) setSeen(true);
  }, [expanded, seen]);
  const words = reasoningWords(block, text);
  return (
    <div class={`reasoning${live ? " is-live" : ""}${expanded ? " is-open" : ""}`}>
      <button
        class="reasoning-head"
        onClick={() => {
          setTouched(true);
          setOpen(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span class="reasoning-icon">
          <Icon d={ICONS.bulb} size={12} />
        </span>
        <span class={live ? "shimmer-text" : ""}>{live ? "Thinking" : "Thought process"}</span>
        <span class="reasoning-meta">
          {words} words
          <span class="chev">
            <Icon d={ICONS.chevron} size={11} />
          </span>
        </span>
      </button>
      <Collapse open={expanded}>
        {expanded || seen ? <div class="reasoning-body">{text.trim()}</div> : null}
      </Collapse>
    </div>
  );
}

function ConfirmCardView({
  id,
  tool,
  summary,
  jev,
  onConfirm,
}: {
  id: string;
  tool: string;
  summary: string;
  jev?: boolean;
  onConfirm: (id: string, allow: boolean, always: boolean) => void;
}) {
  return (
    <div
      class={`confirm-card${jev ? " is-jev" : ""}`}
      role="alertdialog"
      aria-label={`Allow ${tool}?`}
    >
      <div class="confirm-title">
        <span class="confirm-icon">
          <Icon d={ICONS.shield} size={14} />
        </span>
        <span>
          <span class="confirm-eyebrow">
            {jev ? "Jev flagged this — needs your approval" : "Needs your approval"}
          </span>
          <span class="confirm-tool">{tool}</span>
        </span>
      </div>
      <div class="confirm-summary">{summary}</div>
      <div class="confirm-actions">
        <button class="btn-primary" onClick={() => onConfirm(id, true, false)}>
          Allow once
        </button>
        <button class="btn-soft" onClick={() => onConfirm(id, true, true)}>Always allow</button>
        <button class="btn-danger" onClick={() => onConfirm(id, false, false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

type Decision = "once" | "always" | "deny";

const DECISION_LABEL: Record<Decision, string> = {
  once: "Allowed",
  always: "Always allowed",
  deny: "Denied",
};

/** A settled approval, drawn as a timeline step. */
function ConfirmNote({
  tool,
  summary,
  decision,
  jev,
}: {
  tool: string;
  summary: string;
  decision?: Decision;
  jev?: boolean;
}) {
  const denied = decision === "deny";
  return (
    <div
      class={`card confirm-note${denied ? " is-denied" : ""}${jev ? " card-jev" : ""}`}
      title={summary}
    >
      <div class="card-title">
        <span class="tool-icon note-icon">
          <Icon d={ICONS.shield} size={13} />
        </span>
        <span class="tool-text">
          <span class="tool-label">{decision ? DECISION_LABEL[decision] : "Approval"}</span>
          <span class={`tool-chip${jev ? " is-jev" : ""}`}>
            {jev ? "Jev · " : ""}
            {tool}
          </span>
          <span class="tool-preview">{summary}</span>
        </span>
      </div>
    </div>
  );
}

/** The agent hit a sign-in wall or CAPTCHA and paused for a human. */
function HumanCardView({
  id,
  reason,
  url,
  onHuman,
}: {
  id: string;
  reason: string;
  url: string;
  onHuman: (id: string, handled: boolean) => void;
}) {
  return (
    <div
      class="confirm-card is-human"
      role="alertdialog"
      aria-label="The agent needs you to take over"
    >
      <div class="confirm-title">
        <span class="confirm-icon">
          <Icon d={ICONS.key} size={14} />
        </span>
        <span>
          <span class="confirm-eyebrow">Your turn — the agent paused</span>
          <span class="confirm-tool">human handoff</span>
        </span>
      </div>
      <div class="confirm-summary">{reason}</div>
      <div class="confirm-summary confirm-url" title={url}>
        {url}
      </div>
      <div class="confirm-actions">
        <button class="btn-primary" onClick={() => onHuman(id, true)}>
          I've handled it — continue
        </button>
        <button class="btn-soft" onClick={() => onHuman(id, false)}>
          Skip — let the agent try
        </button>
      </div>
    </div>
  );
}

/** A settled handoff, drawn as a timeline step. */
function HumanNote({
  reason,
  url,
  handled,
}: {
  reason: string;
  url: string;
  handled?: boolean;
}) {
  return (
    <div class="card confirm-note is-human-note" title={url}>
      <div class="card-title">
        <span class="tool-icon note-icon">
          <Icon d={ICONS.key} size={13} />
        </span>
        <span class="tool-text">
          <span class="tool-label">{handled ? "You took over" : "Handoff skipped"}</span>
          <span class="tool-chip">human handoff</span>
          <span class="tool-preview">{reason}</span>
        </span>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      class={`copy-btn${copied ? " is-copied" : ""}`}
      aria-label="Copy answer"
      data-tip={copied ? "Copied" : "Copy"}
      data-tip-align="end"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      <Icon d={copied ? ICONS.check : ICONS.copy} size={12} />
    </button>
  );
}

function TurnView({
  turn,
  live,
  active,
  onZoom,
  onConfirm,
  resolved,
  onHuman,
  humanResolved,
}: {
  turn: ChatTurn;
  /** Last turn of the thread (confirm cards stay actionable). */
  live: boolean;
  /** This turn is being produced right now (spinners, caret, shimmer). */
  active: boolean;
  onZoom: (src: string) => void;
  onConfirm: (id: string, allow: boolean, always: boolean) => void;
  resolved: Map<string, Decision>;
  onHuman: (id: string, handled: boolean) => void;
  humanResolved: Map<string, boolean>;
}) {
  if (turn.role === "user") {
    return (
      <div class="bubble bubble-user">
        {turn.text}
        {turn.attachments?.length ? (
          <div class="attach-strip">
            {turn.attachments.map((a) => (
              <span key={a.name} class="attach-chip">
                <Icon d={a.kind === "image" ? ICONS.image : ICONS.clip} size={11} />
                {a.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // Only a finished turn needs the copy text: the live one re-renders on every
  // streamed token, and joining all of its blocks each time is pure waste.
  const answer = active
    ? ""
    : turn.blocks
        .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
        .map((b) => b.text)
        .join("\n\n")
        .trim();
  const lastIndex = turn.blocks.length - 1;

  return (
    <div class={`bubble bubble-assistant${active ? " is-active" : ""}`}>
      <div class="assistant-badge">
        <Orb size={16} active={active} />
        <span class="assistant-name">crazyAgent</span>
        <span class="assistant-time">
          {new Date(turn.when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </span>
        {answer && !active ? <CopyButton text={answer} /> : null}
      </div>
      {turn.blocks.map((block: ChatBlock, i: number) => {
        if (block.kind === "tool") {
          return <ToolRow key={i} card={block.card} active={active} onZoom={onZoom} />;
        }
        if (block.kind === "confirm") {
          const pending = live && !resolved.has(block.confirm.id);
          return pending ? (
            <ConfirmCardView
              key={i}
              id={block.confirm.id}
              tool={block.confirm.tool}
              summary={block.confirm.summary}
              jev={block.confirm.jev}
              onConfirm={onConfirm}
            />
          ) : (
            <ConfirmNote
              key={i}
              tool={block.confirm.tool}
              summary={block.confirm.summary}
              decision={resolved.get(block.confirm.id)}
              jev={block.confirm.jev}
            />
          );
        }
        if (block.kind === "human") {
          const pending = live && !humanResolved.has(block.human.id);
          return pending ? (
            <HumanCardView
              key={i}
              id={block.human.id}
              reason={block.human.reason}
              url={block.human.url}
              onHuman={onHuman}
            />
          ) : (
            <HumanNote
              key={i}
              reason={block.human.reason}
              url={block.human.url}
              handled={humanResolved.get(block.human.id)}
            />
          );
        }
        if (block.kind === "reasoning") {
          return <ReasoningBlock key={i} block={block} live={active && i === lastIndex} />;
        }
        if (block.kind === "note") {
          // Jev sidecar notes: pink line with a `Jev` pill (never colour alone).
          // Progress notes: the model's own narration between sequences — its
          // own accented bubble with a `Progress` pill, so a run reads as
          // "work … report … work … report" at a glance.
          return (
            <p
              key={i}
              class={`info-line${block.jev ? " is-jev" : ""}${block.progress ? " is-progress" : ""}`}
            >
              {block.jev ? <span class="jev-pill">Jev</span> : null}
              {block.progress ? <span class="progress-pill">Progress</span> : null}
              {block.text}
            </p>
          );
        }
        return <Markdown key={i} text={block.text} streaming={active && i === lastIndex} />;
      })}
    </div>
  );
}

/** What the agent is doing right now, derived from the newest block. */
function activityLabel(
  conv: Conversation | null,
  awaiting?: { at: number; contextTokens: number } | null,
  nowMs?: number,
): string {
  const turn = conv?.turns[conv.turns.length - 1];
  if (!turn || turn.role !== "assistant") return "Getting started";
  const last = turn.blocks[turn.blocks.length - 1];
  // The request is on the wire and nothing has streamed back: this is the
  // provider's queue + prefill of the context we just sent, not local work —
  // say so, with the size of the send and how long it has been.
  const waitingOnModel =
    awaiting && (!last || (last.kind === "tool" && last.card.filled));
  if (waitingOnModel && awaiting) {
    const secs = Math.max(0, Math.round(((nowMs ?? Date.now()) - awaiting.at) / 1000));
    const k = Math.round(awaiting.contextTokens / 1000);
    return `Sent ${k}k tokens · waiting for model ${secs}s`;
  }
  if (!last) return "Thinking";
  if (last.kind === "tool") {
    return last.card.filled ? "Deciding next step" : (TOOL_META[last.card.name]?.active ?? "Working");
  }
  if (last.kind === "confirm") return "Waiting for approval";
  if (last.kind === "human") return "Waiting for you";
  if (last.kind === "reasoning") return "Thinking";
  return "Writing";
}

/** True while the Jev sidecar is the thing actually running right now. */
function jevActivity(conv: Conversation | null): boolean {
  const turn = conv?.turns[conv.turns.length - 1];
  if (!turn || turn.role !== "assistant") return false;
  const last = turn.blocks[turn.blocks.length - 1];
  return last?.kind === "tool" && last.card.jev === true && !last.card.filled;
}

function WorkingIndicator({ label, jev }: { label: string; jev?: boolean }) {
  return (
    <div class={`typing${jev ? " is-jev" : ""}`} role="status">
      <span class="typing-orbit">
        <span />
        <span />
        <span />
      </span>
      <span class="shimmer-text" key={label}>
        {label}…
      </span>
    </div>
  );
}

// ------------------------------ popover menu ------------------------------

function Popover({
  label,
  icon,
  open,
  onToggle,
  right,
  children,
}: {
  label: string;
  icon: string;
  open: boolean;
  onToggle: () => void;
  right?: boolean;
  children: ComponentChildren;
}) {
  const presence = usePresence(open, 180);
  return (
    <span class={`pop ${right ? "pop-right" : ""}`}>
      <button
        class={`chip-btn ${open ? "chip-open" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Icon d={icon} size={12} />
        <span class="chip-label">{label}</span>
        <span class="chev">
          <Icon d={ICONS.chevron} size={10} />
        </span>
      </button>
      {presence.mounted ? (
        <div class="menu" role="menu" data-state={presence.state}>
          {children}
        </div>
      ) : null}
    </span>
  );
}

function MenuItem({
  active,
  title,
  hint,
  icon,
  onClick,
}: {
  active: boolean;
  title: string;
  hint?: string;
  icon?: string;
  onClick: () => void;
}) {
  return (
    <button
      class={`menu-item ${active ? "menu-active" : ""}`}
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
    >
      {icon ? (
        <span class="menu-icon">
          <Icon d={icon} size={13} />
        </span>
      ) : null}
      <span class="menu-text">
        <span class="menu-title">{title}</span>
        {hint ? <span class="menu-hint">{hint}</span> : null}
      </span>
      <span class="menu-check">
        <Icon d={ICONS.check} size={12} stroke={2.2} />
      </span>
    </button>
  );
}

/** Per-command icon for the autocomplete rows. */
const SLASH_ICONS: Record<string, string> = {
  new: ICONS.compose,
  model: ICONS.cpu,
  sessions: ICONS.history,
  rename: ICONS.tag,
};

// ------------------------------ sheets ------------------------------

/** Slide-over panel with a dimmed backdrop; plays its exit before unmounting. */
function Sheet({
  open,
  side,
  onClose,
  class: cls,
  label,
  children,
}: {
  open: boolean;
  side: "left" | "right";
  onClose: () => void;
  class: string;
  label: string;
  children: ComponentChildren;
}) {
  const presence = usePresence(open, 300);
  if (!presence.mounted) return null;
  return (
    <div class={`sheet-layer sheet-${side}`} data-state={presence.state}>
      <div class="sheet-backdrop" onClick={onClose} />
      <aside class={`sheet ${cls}`} role="dialog" aria-label={label}>
        {children}
      </aside>
    </div>
  );
}

function SheetHead({ title, sub, icon, onClose }: { title: string; sub: string; icon: string; onClose: () => void }) {
  return (
    <header class="sheet-head">
      <span class="sheet-icon">
        <Icon d={icon} size={15} />
      </span>
      <div class="sheet-titles">
        <h2>{title}</h2>
        <p>{sub}</p>
      </div>
      <IconButton icon={ICONS.close} tip="Close" onClick={onClose} tipAlign="end" />
    </header>
  );
}

// ------------------------------ settings ------------------------------

/** Mask a secret for at-a-glance identification without revealing it. */
function maskKey(key: string): string {
  if (!key) return "(empty)";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Connection manager: saved credentials, each bound to its own provider, base
 * URL and model. Exactly one is active; the active row is expanded and edited
 * inline, the rest stay compact so a long list stays readable.
 */
function KeyManager({
  keys,
  activeId,
  onSelect,
  onChange,
}: {
  keys: ApiKeyEntry[];
  activeId: string;
  onSelect: (id: string) => void;
  onChange: (keys: ApiKeyEntry[]) => void;
}) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleIn = (
    setter: (fn: (prev: Set<string>) => Set<string>) => void,
    id: string,
  ) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const patch = (id: string, field: keyof ApiKeyEntry, value: string) => {
    onChange(keys.map((k) => (k.id === id ? { ...k, [field]: value } : k)));
  };

  const add = () => {
    const entry = makeEntry({
      label: `Connection ${keys.length + 1}`,
      ...CONNECTION_DEFAULTS,
    });
    onChange([...keys, entry]);
    onSelect(entry.id);
    setExpanded((prev) => new Set(prev).add(entry.id));
  };

  const remove = (id: string) => {
    const next = keys.filter((k) => k.id !== id);
    onChange(next);
    // Deleting the active connection promotes the first remaining one.
    if (id === activeId) onSelect(next[0]?.id ?? "");
  };

  return (
    <div class="keys">
      {keys.length === 0 ? (
        <p class="keys-empty">
          No connections yet — add one to pick a provider, endpoint and model.
        </p>
      ) : null}
      {keys.map((k) => {
        const active = k.id === activeId;
        // The active row is always open; others open on demand.
        const open = active || expanded.has(k.id);
        const anthropic = k.provider === "anthropic";
        return (
          <div class={`key-row ${active ? "key-active" : ""}`} key={k.id}>
            <div class="key-head">
              <label class="key-pick" title="Use this connection">
                <input
                  type="radio"
                  name="activeKey"
                  checked={active}
                  onChange={() => onSelect(k.id)}
                />
                <span class="radio-dot" />
              </label>
              <span class={`provider-badge ${anthropic ? "pb-anthropic" : "pb-openai"}`}>
                {anthropic ? "A" : "O"}
              </span>
              <button
                class="key-label-btn"
                onClick={() => toggleIn(setExpanded, k.id)}
                aria-expanded={open}
              >
                <span class="key-name">{k.label || "(unnamed)"}</span>
                <span class="key-summary">
                  {anthropic ? "Anthropic" : "OpenAI-compatible"} · {k.model || "no model"}
                </span>
              </button>
              <button
                class="btn-icon btn-icon-sm key-del"
                onClick={() => remove(k.id)}
                aria-label="Delete connection"
                data-tip="Delete"
                data-tip-align="end"
              >
                <Icon d={ICONS.trash} size={13} />
              </button>
            </div>
            <Collapse open={open}>
              <div class="key-body">
                <label class="field">
                  <span>Label</span>
                  <input
                    value={k.label}
                    placeholder="e.g. work / openrouter"
                    onInput={(e) => patch(k.id, "label", (e.target as HTMLInputElement).value)}
                  />
                </label>
                <label class="field">
                  <span>API key</span>
                  <span class="input-affix">
                    <input
                      type={revealed.has(k.id) ? "text" : "password"}
                      value={k.key}
                      placeholder="sk-…"
                      onInput={(e) => patch(k.id, "key", (e.target as HTMLInputElement).value)}
                    />
                    <button
                      class="affix-btn"
                      onClick={(e) => {
                        e.preventDefault();
                        toggleIn(setRevealed, k.id);
                      }}
                      aria-label={revealed.has(k.id) ? "Hide key" : "Reveal key"}
                    >
                      <Icon d={revealed.has(k.id) ? ICONS.eyeOff : ICONS.eye} size={13} />
                    </button>
                  </span>
                  <small class="key-mask">{maskKey(k.key)}</small>
                </label>
                <div class="field-grid">
                  <label class="field">
                    <span>Provider</span>
                    <select
                      value={k.provider}
                      onChange={(e) =>
                        patch(k.id, "provider", (e.target as HTMLSelectElement).value)
                      }
                    >
                      <option value="openai-compatible">OpenAI-compatible</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Model</span>
                    <input
                      value={k.model}
                      placeholder="gpt-4o-mini"
                      onInput={(e) => patch(k.id, "model", (e.target as HTMLInputElement).value)}
                    />
                  </label>
                </div>
                <label class="field">
                  <span>Base URL</span>
                  <input
                    value={k.baseUrl}
                    placeholder="https://api.openai.com/v1"
                    onInput={(e) => patch(k.id, "baseUrl", (e.target as HTMLInputElement).value)}
                  />
                </label>
              </div>
            </Collapse>
          </div>
        );
      })}
      <button class="btn-dashed keys-add" onClick={add}>
        <Icon d={ICONS.plus} size={13} /> Add connection
      </button>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <label class="switch-row">
      <span class="switch-text">
        <span>{title}</span>
        <small>{hint}</small>
      </span>
      <span class="switch">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        />
        <span class="switch-track">
          <span class="switch-thumb" />
        </span>
      </span>
    </label>
  );
}

function SelectRow<T extends string>({
  title,
  hint,
  value,
  options,
  onChange,
}: {
  title: string;
  hint: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="switch-row select-row">
      <span class="switch-text">
        <span>{title}</span>
        <small>{hint}</small>
      </span>
      <select
        value={value}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function NumberField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: number;
  fallback: number;
  onChange: (v: number) => void;
}) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="number"
        value={String(value)}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value) || fallback)}
      />
    </label>
  );
}

/**
 * Switching Jev transport moves the endpoint/model to the new transport's
 * defaults when the current values are still the other transport's defaults
 * (or blank) — the pair travels together, but a hand-typed endpoint is never
 * clobbered.
 */
function switchJevTransport(jev: JevSettings, transport: JevTransport): JevSettings {
  const next = JEV_TRANSPORT_DEFAULTS[transport];
  const prev = JEV_TRANSPORT_DEFAULTS[jev.transport] ?? JEV_TRANSPORT_DEFAULTS.typesafe;
  const untouched = (value: string, fallback: string): boolean =>
    !value.trim() || value.trim() === fallback;
  return {
    ...jev,
    transport,
    baseUrl: untouched(jev.baseUrl, prev.baseUrl) ? next.baseUrl : jev.baseUrl,
    model: untouched(jev.model, prev.model) ? next.model : jev.model,
  };
}

/**
 * One window gesture, sent to the worker that owns the binding. Exported to
 * the settings body too: the mode dropdown and these buttons are two views of
 * the SAME state, so choosing "A window I pick" must bind this window (and
 * choosing "Its own window" must release it) or the pair would drift apart.
 */
async function windowAction(
  type: "window.bind" | "window.reset" | "window.reveal",
): Promise<AgentWindowStatus | null> {
  const payload: Record<string, unknown> = { type };
  if (type === "window.bind") {
    // THIS window: the one hosting the panel. The worker never guesses.
    const win = await chrome.windows.getCurrent().catch(() => null);
    if (win?.id === undefined) return null;
    payload.windowId = win.id;
  }
  const res = await chrome.runtime.sendMessage(payload).catch(() => undefined);
  return (res as { status?: AgentWindowStatus } | undefined)?.status ?? null;
}

/**
 * Window-isolation controls: which window the agent works in, plus the three
 * user gestures around it. The service worker owns the binding, so every
 * button here is a message + a re-read — the panel never keeps its own idea of
 * "the agent window" that could drift from the worker's.
 */
function AgentWindowControls({ onMode }: { onMode?: (mode: "own" | "adopt") => void }) {
  const [status, setStatus] = useState<AgentWindowStatus | null>(null);
  const read = () =>
    void chrome.runtime
      .sendMessage({ type: "window.status" })
      .then((r) => {
        const s = (r as { status?: AgentWindowStatus } | undefined)?.status;
        if (s) setStatus(s);
      })
      .catch(() => undefined);
  useEffect(read, []);
  // Every gesture keeps the SETTING and the BINDING in step (the mode dropdown
  // is the third view of the same state) — otherwise the next run could start
  // in a window the user no longer chose.
  const act = (type: "window.bind" | "window.reset" | "window.reveal") => {
    void windowAction(type).then((s) => {
      if (s) setStatus(s);
    });
    if (type === "window.bind") onMode?.("adopt");
    if (type === "window.reset") onMode?.("own");
  };
  return (
    <div class="window-controls">
      <p class="window-state">
        {status?.alive
          ? `Working in window #${status.windowId} · ${status.tabs} tab${status.tabs === 1 ? "" : "s"}`
          : "No agent window yet — it opens on the next run"}
        {status && status.raiseAttempts > 0
          ? ` · brought forward ${status.raiseAttempts}× by you`
          : ""}
      </p>
      <div class="window-buttons">
        <button class="btn-ghost" onClick={() => act("window.bind")}>
          Use this window for the agent
        </button>
        <button class="btn-ghost" onClick={() => act("window.reset")}>
          Give it its own window
        </button>
        <button
          class="btn-ghost"
          disabled={!status?.alive}
          onClick={() => act("window.reveal")}
        >
          Bring it forward
        </button>
      </div>
    </div>
  );
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<AgentSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void loadSettings().then(setS);
  }, []);
  const set = <K extends keyof AgentSettings>(k: K, v: AgentSettings[K]) => {
    // Functional update: multiple field edits batch correctly.
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));
    setSaved(false);
  };
  return (
    <>
      <SheetHead title="Settings" sub="Connections, runtime and behaviour" icon={ICONS.sliders} onClose={onClose} />
      {!s ? (
        <div class="sheet-body">
          <div class="skeleton" />
          <div class="skeleton" />
          <div class="skeleton short" />
        </div>
      ) : (
        <>
          <div class="sheet-body">
            <section class="set-group" style="--i:0">
              <h3 class="set-title">
                <Icon d={ICONS.key} size={12} /> Connections
              </h3>
              <KeyManager
                keys={s.apiKeys}
                activeId={s.activeKeyId}
                onSelect={(id) => {
                  // Re-resolve every mirror: switching connection also switches the
                  // provider, base URL and model the agent will use. Persist it too, so
                  // the composer never runs against a stale connection while the
                  // drawer is still open.
                  setS((prev) => {
                    if (!prev) return prev;
                    const next = normalizeSettings({ ...prev, activeKeyId: id });
                    void saveSettings(next);
                    return next;
                  });
                  setSaved(true);
                }}
                onChange={(keys) => {
                  setS((prev) => (prev ? normalizeSettings({ ...prev, apiKeys: keys }) : prev));
                  setSaved(false);
                }}
              />
            </section>

            <section class="set-group" style="--i:1">
              <h3 class="set-title">
                <Icon d={ICONS.cpu} size={12} /> Control transport
              </h3>
              <div class="segmented" data-index={s.mode === "unlimited" ? 1 : 0} role="radiogroup">
                <span class="seg-glider" />
                <button
                  role="radio"
                  aria-checked={s.mode === "standard"}
                  class={s.mode === "standard" ? "on" : ""}
                  onClick={() => set("mode", "standard")}
                >
                  <b>Standard</b>
                  <small>chrome.debugger</small>
                </button>
                <button
                  role="radio"
                  aria-checked={s.mode === "unlimited"}
                  class={s.mode === "unlimited" ? "on" : ""}
                  onClick={() => set("mode", "unlimited")}
                >
                  <b>Unlimited</b>
                  <small>helper daemon</small>
                </button>
              </div>
              {s.mode === "unlimited" ? (
                <NumberField label="CDP port" value={s.cdpPort} fallback={9222} onChange={(v) => set("cdpPort", v)} />
              ) : null}
            </section>

            <section class="set-group" style="--i:2">
              <h3 class="set-title">
                <Icon d={ICONS.gauge} size={12} /> Model limits
              </h3>
              <div class="field-grid">
                <NumberField
                  label="Context window"
                  value={s.contextWindow}
                  fallback={128000}
                  onChange={(v) => set("contextWindow", v)}
                />
                <NumberField
                  label="Max output / call"
                  value={s.maxTokens}
                  fallback={8192}
                  onChange={(v) => set("maxTokens", v)}
                />
              </div>
            </section>

            <section class="set-group" style="--i:3">
              <h3 class="set-title">
                <Icon d={ICONS.bolt} size={12} /> Behaviour
              </h3>
              <SelectRow
                title="Reasoning effort"
                hint={
                  THINKING_LEVELS.find((l) => l.value === s.thinking)?.hint ??
                  "Let the model think before acting"
                }
                value={s.thinking}
                options={THINKING_LEVELS.map(({ value, label }) => ({ value, label }))}
                onChange={(v) => set("thinking", v)}
              />
              <Switch
                checked={s.unattended}
                onChange={(v) => set("unattended", v)}
                title="Unattended runs"
                hint="Nobody will click confirmations: sensitive actions fail fast (~15s) with a clear 'route unavailable' note instead of idling 2 minutes. Nothing is auto-approved"
              />
              <Switch
                checked={s.batchActions}
                onChange={(v) => set("batchActions", v)}
                title="Fast steps"
                hint="Batch one logical unit of work (a form, a key sequence, a menu walk) into a single step and skip re-verifying actions that already returned a fresh snapshot. Fewer, fuller round trips — each one costs several seconds of fixed latency. Safety gates are unchanged"
              />
              <Switch
                checked={s.adaptiveThinking === true}
                onChange={(v) => set("adaptiveThinking", v)}
                title="Skip thinking on routine steps"
                hint="After a few consecutive routine steps (one successful call, little reasoning, no navigation), later steps are sent with thinking off until something surprising happens — a failure, a navigation, an empty reply — which restores the configured level immediately"
              />
              <div class="field-grid">
                <button
                  class="btn-ghost"
                  title="Turn on the speed profile for relay-style work: thinking off, fast steps on, routine-step thinking skipped"
                  onClick={() => {
                    set("thinking", "off");
                    set("batchActions", true);
                    set("adaptiveThinking", true);
                  }}
                >
                  Relay (fast) preset
                </button>
              </div>
            </section>

            <section class="set-group" style="--i:4">
              <h3 class="set-title">
                <Icon d={ICONS.bolt} size={12} /> Madman mode
              </h3>
              <Switch
                checked={s.madman}
                onChange={(v) => set("madman", v)}
                title="Unleash the profanity"
                hint="Every tool call carries a cuss word; replies and mid-run exclamations swear"
              />
              {s.madman ? (
                <p class="madman-preview">
                  {madmanExclamation("scroll the whole list by hand", "preview")}
                </p>
              ) : null}
            </section>

            <section class="set-group" style="--i:5">
              <h3 class="set-title">
                <Icon d={ICONS.sparkles} size={12} /> Fast decisions (Jev)
              </h3>
              <Switch
                checked={s.jev.enabled}
                onChange={(v) => set("jev", { ...s.jev, enabled: v })}
                title="Enable Jev"
                hint="A decision model working alongside your selected model: risk checks on sensitive actions, a judge tool for bulk decisions, optional effort routing"
              />
              {s.jev.enabled ? (
                <>
                  <SelectRow
                    title="Jev endpoint"
                    hint={
                      s.jev.transport === "openai"
                        ? "Chat wire (/chat/completions) for CHAT models used as judges (e.g. openai/gpt-oss-20b) — one model round-trip per decision. A real Jev model (typesafe/jev-*) always rides the /systemone decisions wire instead"
                        : "The System One decisions wire (/systemone) — calibrated probabilities, answers in milliseconds. Works with a console.typesafe.ai key, or an OpenRouter key at https://openrouter.ai/api/v1"
                    }
                    value={s.jev.transport}
                    options={JEV_TRANSPORT_OPTIONS}
                    onChange={(t) => set("jev", switchJevTransport(s.jev, t))}
                  />
                  {s.jev.transport === "openai" &&
                  isJevDecisionsModel(s.jev.model ?? "") ? (
                    <p class="info-line is-jev">
                      <span class="jev-pill">Jev</span>
                      {(s.jev.model ?? "").trim()} is a decisions model — it rides
                      the /systemone decisions wire automatically (chat/completions
                      can never answer it)
                    </p>
                  ) : null}
                  <label class="field">
                    <span>
                      {s.jev.transport === "openai" ? "OpenRouter API key" : "TypeSafe API key"}
                    </span>
                    <input
                      type="password"
                      value={s.jev.apiKey}
                      placeholder={
                        s.jev.transport === "openai"
                          ? "openrouter.ai/keys"
                          : "console.typesafe.ai/keys"
                      }
                      onInput={(e) =>
                        set("jev", {
                          ...s.jev,
                          apiKey: (e.target as HTMLInputElement).value,
                        })
                      }
                    />
                  </label>
                  <Switch
                    checked={s.autoThinking}
                    onChange={(v) => set("autoThinking", v)}
                    title="Auto effort"
                    hint="Let Jev grade each task AND each step (from the risk-check it already runs) and lower reasoning effort on routine work — never above your configured level, restored on any surprise (on by default)"
                  />
                  <div class="field-grid">
                    <label class="field">
                      <span>Base URL</span>
                      <input
                        value={s.jev.baseUrl}
                        placeholder={JEV_TRANSPORT_DEFAULTS[s.jev.transport].baseUrl}
                        onInput={(e) =>
                          set("jev", {
                            ...s.jev,
                            baseUrl: (e.target as HTMLInputElement).value,
                          })
                        }
                      />
                    </label>
                    <label class="field">
                      <span>Model</span>
                      <input
                        value={s.jev.model}
                        placeholder={JEV_TRANSPORT_DEFAULTS[s.jev.transport].model}
                        onInput={(e) =>
                          set("jev", {
                            ...s.jev,
                            model: (e.target as HTMLInputElement).value,
                          })
                        }
                      />
                    </label>
                  </div>
                </>
              ) : null}
            </section>

            <section class="set-group" style="--i:6">
              <h3 class="set-title">
                <Icon d={ICONS.bulb} size={12} /> Self-improvement
              </h3>
              <Switch
                checked={s.learn.enabled}
                onChange={(v) => set("learn", { ...s.learn, enabled: v })}
                title="Learn from my runs"
                hint="A second agent on the same model writes down failures and what to do instead; later runs read those lessons back"
              />
              <Switch
                checked={s.learn.auto}
                onChange={(v) => set("learn", { ...s.learn, auto: v })}
                title="Review failed runs automatically"
                hint="Runs that errored, were stopped, or looped on a failing call get reviewed without asking; clean runs are reviewed only from the Lessons drawer"
              />
            </section>

            <section class="set-group" style="--i:7">
              <h3 class="set-title">
                <Icon d={ICONS.window} size={12} /> Agent window
              </h3>
              <SelectRow
                title="Where the agent works"
                hint="Its own window, created once and reused, or one you pick. Either way it can only see and act inside that window — your other windows are out of reach, and it never takes your focus."
                value={s.agentWindow.mode}
                options={[
                  { value: "own", label: "Its own window" },
                  { value: "adopt", label: "A window I pick" },
                ]}
                onChange={(v) => {
                  set("agentWindow", { ...s.agentWindow, mode: v });
                  // The setting and the binding are one state: picking a mode
                  // also performs it, so the next run cannot start in a window
                  // the user no longer chose.
                  void windowAction(v === "adopt" ? "window.bind" : "window.reset");
                }}
              />
              <Switch
                checked={s.agentWindow.quietFocus}
                onChange={(v) => set("agentWindow", { ...s.agentWindow, quietFocus: v })}
                title="Never take focus"
                hint="Keystrokes reach the page through CDP focus emulation, so the agent's window never jumps in front of yours while you work. Turn this off only if a site refuses input while its window is in the background: the agent will then raise its OWN window before typing, never yours."
              />
              <AgentWindowControls
                onMode={(mode) => {
                  // The binding changes the moment the button is pressed, so the
                  // setting is persisted right away too: leaving it unsaved
                  // until the Save button would let the next run resolve the
                  // mismatch by opening a window the user did not pick.
                  const next = { ...s, agentWindow: { ...s.agentWindow, mode } };
                  setS(next);
                  setSaved(false);
                  void saveSettings({ ...next, apiKey: activeApiKey(next) }).then(() =>
                    setSaved(true),
                  );
                }}
              />
            </section>
          </div>
          <div class="version-line">
            {versionLabel({
              version: chrome.runtime.getManifest().version,
              stamp: chrome.runtime.getManifest().version_name,
            })}
          </div>
          <footer class="sheet-foot">
            <span class={`save-state${saved ? " is-saved" : ""}`}>
              <span class="save-dot">
                <Icon d={ICONS.check} size={10} stroke={2.6} />
              </span>
              {saved ? "Saved · applies on next run" : "Unsaved changes apply on next run"}
            </span>
            <button
              class="btn-primary"
              onClick={() => {
                // Re-resolve the mirror here too: selecting a different key does not
                // touch `apiKey` directly, so it could otherwise be saved stale.
                void saveSettings({
                  ...s,
                  apiKey: activeApiKey(s),
                }).then(() => setSaved(true));
              }}
            >
              Save
            </button>
          </footer>
        </>
      )}
    </>
  );
}

// ------------------------------ history ------------------------------

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function dayBucket(ts: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ts >= start.getTime()) return "Today";
  if (ts >= start.getTime() - day) return "Yesterday";
  if (ts >= start.getTime() - 7 * day) return "Previous 7 days";
  return "Older";
}

function HistoryBody({
  items,
  currentId,
  onOpen,
  onDelete,
  onClose,
}: {
  items: ConversationSummary[];
  currentId: string | undefined;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();
  const visible = q ? items.filter((h) => h.title.toLowerCase().includes(q)) : items;
  const groups: { label: string; rows: ConversationSummary[] }[] = [];
  for (const h of visible) {
    const label = dayBucket(h.updatedAt);
    const g = groups[groups.length - 1];
    if (g?.label === label) g.rows.push(h);
    else groups.push({ label, rows: [h] });
  }
  let n = 0;
  return (
    <>
      <SheetHead
        title="History"
        sub={`${items.length} conversation${items.length === 1 ? "" : "s"}`}
        icon={ICONS.history}
        onClose={onClose}
      />
      <div class="sheet-search">
        <Icon d={ICONS.search} size={13} />
        <input
          placeholder="Search conversations"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="sheet-body hist-body">
        {items.length === 0 ? (
          <div class="empty">
            <span class="empty-icon">
              <Icon d={ICONS.chat} size={20} />
            </span>
            <b>No conversations yet</b>
            <p class="hint">Your tasks will show up here.</p>
          </div>
        ) : visible.length === 0 ? (
          <div class="empty">
            <b>No matches</b>
            <p class="hint">Nothing matches “{query}”.</p>
          </div>
        ) : (
          groups.map((g) => (
            <div class="hist-group" key={g.label}>
              <h3 class="hist-label">{g.label}</h3>
              {g.rows.map((h) => (
                <div
                  class={`hist-row${h.id === currentId ? " is-current" : ""}${removing.has(h.id) ? " is-removing" : ""}`}
                  key={h.id}
                  style={`--i:${Math.min(n++, 12)}`}
                >
                  <button class="hist-item" onClick={() => onOpen(h.id)}>
                    <span class="hist-title">{h.title || "Untitled"}</span>
                    <span class="hist-meta">
                      {relativeTime(h.updatedAt)} · {h.turns} turn{h.turns === 1 ? "" : "s"}
                    </span>
                  </button>
                  <button
                    class="btn-icon btn-icon-sm hist-del"
                    onClick={() => {
                      setRemoving((prev) => new Set(prev).add(h.id));
                      setTimeout(() => onDelete(h.id), 240);
                    }}
                    aria-label="Delete conversation"
                    data-tip="Delete"
                    data-tip-align="end"
                  >
                    <Icon d={ICONS.trash} size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ------------------------------ run logs ------------------------------

/** "1.2s" / "2m03s" — compact per-turn durations for the log timeline. */
function shortDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1_000) return `${ms}ms`;
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
}

function clockTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A local copy of the log JSONL/Markdown, written to the Downloads folder. */
function downloadLog(filename: string, content: string): void {
  const type =
    filename.endsWith(".jsonl") ? "application/x-ndjson" : "text/markdown";
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function LogsBody({
  logs,
  detail,
  onOpen,
  onBack,
  onDelete,
  onClear,
  onExport,
  onLearn,
  onClose,
}: {
  logs: LogSummary[];
  detail: LogTurnRecord | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onExport: (format: LogExportFormat, logId?: string) => void;
  onLearn: (logId: string) => void;
  onClose: () => void;
}) {
  if (detail) {
    return (
      <>
        <SheetHead
          title="Run detail"
          sub={`${detail.turns.length} turn${detail.turns.length === 1 ? "" : "s"} · ${detail.toolCalls} tool call${detail.toolCalls === 1 ? "" : "s"} · ${shortDuration(detail.durationMs)}`}
          icon={ICONS.history}
          onClose={onClose}
        />
        <div class="log-actions">
          <button class="btn-ghost" onClick={onBack}>
            ← All runs
          </button>
          <button class="btn-ghost" onClick={() => onExport("jsonl", detail.id)}>
            Export JSONL
          </button>
          <button class="btn-ghost" onClick={() => onExport("md", detail.id)}>
            Export MD
          </button>
          <button class="btn-ghost" onClick={() => onLearn(detail.id)}>
            Learn from this run
          </button>
        </div>
        <div class="sheet-body log-body">
          <p class="log-task">{detail.task || "Untitled run"}</p>
          <p class="log-meta">
            {isoLocal(detail.startedAt)} · {detail.status} · {detail.mode ?? "—"}
            {detail.resumed ? " · resumed" : ""}
          </p>
          {detail.turns.map((turn) => (
            <div class="log-turn" key={turn.index}>
              <div class="log-turn-head">
                <b>Turn {turn.index + 1}</b>
                <span>
                  {clockTime(turn.startedAt)} · {shortDuration(turn.durationMs)}
                </span>
              </div>
              {turn.reasoning.trim() ? (
                <details class="log-reasoning">
                  <summary>reasoning</summary>
                  <pre>{turn.reasoning.trim()}</pre>
                </details>
              ) : null}
              {turn.exclamations.map((ex, i) => (
                <p class="log-exclaim" key={i}>
                  {clockTime(ex.at)} — {ex.message}
                </p>
              ))}
              {turn.tools.map((call) => (
                <div class="log-tool" key={call.index}>
                  <div class="log-tool-head">
                    <span class={call.ok === false ? "log-fail" : "log-ok"}>
                      {call.ok === false ? "✗" : call.ok === true ? "✓" : "…"}
                    </span>
                    <b>{call.label ?? call.name}</b>
                    {call.jev ? <span class="jev-pill">JEV</span> : null}
                    <span class="log-tool-time">
                      {clockTime(call.at)} · {shortDuration(call.durationMs)}
                    </span>
                  </div>
                  <pre class="log-pre">{call.args}</pre>
                  {call.result !== undefined ? (
                    <pre class="log-pre log-pre-result">{call.result}</pre>
                  ) : null}
                  {call.image ? <p class="log-meta">[screenshot captured]</p> : null}
                </div>
              ))}
              {turn.confirmations.map((c) => (
                <p class={`log-confirm${c.jev ? " is-jev" : ""}`} key={c.id}>
                  ⚠ {clockTime(c.at)} {c.jev ? <span class="jev-pill">JEV</span> : null}—{" "}
                  {c.tool}: {c.summary}
                </p>
              ))}
              {turn.errors.map((err, i) => (
                <p class="log-confirm" key={i}>
                  ⚠ {clockTime(err.at)} — {err.message}
                </p>
              ))}
              {turn.text.trim() ? <div class="log-text">{turn.text.trim()}</div> : null}
              {turn.summary && turn.summary !== turn.text.trim() ? (
                <p class="log-summary">
                  <b>Summary:</b> {turn.summary}
                </p>
              ) : null}
              {turn.stats ? (
                <p class="log-meta">
                  {turn.stats.steps} steps · {turn.stats.totalTokens} tokens (
                  {turn.stats.outputTokens} out) · {turn.stats.tokensPerSec.toFixed(1)} tok/s
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <SheetHead
        title="Run logs"
        sub={`${logs.length} logged run${logs.length === 1 ? "" : "s"}`}
        icon={ICONS.history}
        onClose={onClose}
      />
      <div class="log-actions">
        <button class="btn-ghost" onClick={() => onExport("jsonl")}>
          Export all JSONL
        </button>
        <button class="btn-ghost" onClick={() => onExport("md")}>
          Export all MD
        </button>
        <button class="btn-ghost log-clear" onClick={onClear}>
          Clear
        </button>
      </div>
      <div class="sheet-body hist-body">
        {logs.length === 0 ? (
          <div class="empty">
            <span class="empty-icon">
              <Icon d={ICONS.history} size={20} />
            </span>
            <b>No runs logged yet</b>
            <p class="hint">
              Every task is archived locally with per-turn times, tool calls and
              results.
            </p>
          </div>
        ) : (
          logs.map((log, i) => (
            <div class="hist-row" key={log.id} style={`--i:${Math.min(i, 12)}`}>
              <button class="hist-item" onClick={() => onOpen(log.id)}>
                <span class="hist-title">
                  {log.status === "running" ? "● " : ""}
                  {log.task || "Untitled run"}
                </span>
                <span class="hist-meta">
                  {relativeTime(log.startedAt)} · {log.turns} turn
                  {log.turns === 1 ? "" : "s"} · {log.toolCalls} tool
                  {log.toolCalls === 1 ? "" : "s"} · {shortDuration(log.durationMs)}
                </span>
              </button>
              <button
                class="btn-icon btn-icon-sm hist-del"
                onClick={() => onDelete(log.id)}
                aria-label="Delete log"
                data-tip="Delete"
                data-tip-align="end"
              >
                <Icon d={ICONS.trash} size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function isoLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ------------------------------ lessons (coach) ------------------------------

/** Progress of the last coach review, for the drawer's status line. */
type CoachStatus = {
  state: "idle" | "running" | "added" | "empty" | "error";
  message?: string;
};

/**
 * The lessons drawer: what the second (coach) agent learned from past runs.
 * The list is the agent's own reference material — editable and removable
 * here, because the user owns what it is allowed to remember.
 */
function SkillsBody({
  skills,
  error,
  onNew,
  onUpdate,
  onDelete,
  onClose,
}: {
  skills: Skill[];
  error?: string;
  onNew: (skill: {
    name: string;
    whenToUse: string;
    body: string;
    hosts?: string[];
    keywords?: string[];
  }) => void;
  onUpdate: (id: string, patch: { pinned?: boolean; whenToUse?: string; body?: string }) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newWhen, setNewWhen] = useState("");
  const [newBody, setNewBody] = useState("");

  return (
    <>
      <SheetHead
        title="Skills"
        sub={`${skills.length} on-demand procedure${skills.length === 1 ? "" : "s"} — the agent loads them with use_skill when the task matches`}
        icon={ICONS.doc}
        onClose={onClose}
      />
      <div class="lesson-actions">
        <button class="btn-soft" onClick={() => setCreating((c) => !c)}>
          <Icon d={ICONS.plus} size={12} />
          {creating ? "Cancel" : "New skill"}
        </button>
      </div>
      {error ? <p class="lesson-status is-error">{error}</p> : null}
      {creating ? (
        <div class="lesson-edit sheet-pad">
          <input
            placeholder="name (kebab-case, e.g. invoice-upload)"
            value={newName}
            onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
          />
          <input
            placeholder="when to use it (one line — this is the catalog line)"
            value={newWhen}
            onInput={(e) => setNewWhen((e.target as HTMLInputElement).value)}
          />
          <textarea
            rows={8}
            placeholder="the full procedure (markdown) — what to do, in order, with the exact tool calls"
            value={newBody}
            onInput={(e) => setDraftBodySafe(setNewBody, e)}
          />
          <div class="lesson-edit-actions">
            <button
              class="btn-soft"
              disabled={!newName.trim() || !newWhen.trim() || !newBody.trim()}
              onClick={() => {
                onNew({ name: newName.trim(), whenToUse: newWhen.trim(), body: newBody.trim() });
                setCreating(false);
                setNewName("");
                setNewWhen("");
                setNewBody("");
              }}
            >
              Create
            </button>
            <button class="btn-ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div class="sheet-body hist-body">
        {skills.length === 0 ? (
          <div class="empty">
            <span class="empty-icon">
              <Icon d={ICONS.doc} size={20} />
            </span>
            <b>No skills</b>
            <p class="hint">
              Skills are full procedures the agent loads on demand — the catalog
              line rides every run's prompt appendix, the body only when used.
              Bundled ones appear after the service worker loads once.
            </p>
          </div>
        ) : (
          skills.map((skill, i) => (
            <div class="hist-row lesson-row" key={skill.id} style={`--i:${Math.min(i, 12)}`}>
              <div class="lesson-item">
                <div class="lesson-tags">
                  <span class="lesson-tag">{skill.name}</span>
                  <span class="lesson-tag is-soft">{skill.source}</span>
                  {skill.pinned ? <span class="lesson-tag is-pin">pinned</span> : null}
                  {skill.hosts?.map((h) => (
                    <span class="lesson-tag" key={h}>
                      {h}
                    </span>
                  ))}
                </div>
                {editing === skill.id ? (
                  <div class="lesson-edit">
                    <textarea
                      value={draftBody}
                      onInput={(e) => setDraftBodySafe(setDraftBody, e)}
                    />
                    <div class="lesson-edit-actions">
                      <button
                        class="btn-soft"
                        onClick={() => {
                          if (draftBody.trim()) onUpdate(skill.id, { body: draftBody.trim() });
                          setEditing(null);
                        }}
                      >
                        Save
                      </button>
                      <button class="btn-ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p class="lesson-text">{skill.whenToUse}</p>
                    {skill.sections?.length ? (
                      <details>
                        <summary class="hint">
                          {skill.sections.length} sections ({skill.sections.reduce((n, s) => n + s.body.length, 0).toLocaleString()} chars)
                        </summary>
                        {skill.sections.map((sec) => (
                          <div key={sec.id} class="skill-section">
                            <div class="skill-section-head">
                              <code>{sec.id}</code> — <b>{sec.title}</b>
                              {sec.useWhen ? <span class="hint"> · {sec.useWhen}</span> : null}
                            </div>
                            <pre class="skill-body">{sec.body}</pre>
                          </div>
                        ))}
                      </details>
                    ) : (
                      <details>
                        <summary class="hint">body ({skill.body.length.toLocaleString()} chars)</summary>
                        <pre class="skill-body">{skill.body}</pre>
                      </details>
                    )}
                  </>
                )}
                <div class="lesson-actions row-actions">
                  <button
                    class="btn-ghost"
                    onClick={() => onUpdate(skill.id, { pinned: !skill.pinned })}
                  >
                    {skill.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    class="btn-ghost"
                    onClick={() => {
                      setEditing(skill.id);
                      setDraftBody(skill.body);
                    }}
                  >
                    Edit
                  </button>
                  <button class="btn-ghost" onClick={() => onDelete(skill.id)}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function setDraftBodySafe(
  set: (v: string) => void,
  e: { target: EventTarget | null },
): void {
  set((e.target as HTMLTextAreaElement).value);
}

function LessonsBody({
  lessons,
  status,
  onReview,
  onUpdate,
  onDelete,
  onClear,
  onExport,
  onClose,
}: {
  lessons: Lesson[];
  status: CoachStatus;
  onReview: () => void;
  onUpdate: (id: string, patch: { text?: string; pinned?: boolean }) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onExport: (format: LogExportFormat) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (lesson: Lesson) => {
    setEditing(lesson.id);
    setDraft(lesson.text);
  };
  const commitEdit = (id: string) => {
    const text = draft.trim();
    if (text) onUpdate(id, { text });
    setEditing(null);
  };

  return (
    <>
      <SheetHead
        title="Lessons"
        sub={`${lessons.length} lesson${lessons.length === 1 ? "" : "s"} learned in this browser profile`}
        icon={ICONS.bulb}
        onClose={onClose}
      />
      <div class="lesson-actions">
        <button
          class="btn-soft"
          onClick={onReview}
          disabled={status.state === "running"}
        >
          <Icon d={ICONS.sparkles} size={12} />
          {status.state === "running" ? "Reviewing…" : "Review latest run"}
        </button>
        <span class="toolbar-spacer" />
        <button class="btn-ghost" onClick={() => onExport("jsonl")}>
          Export JSONL
        </button>
        <button class="btn-ghost" onClick={() => onExport("md")}>
          Export MD
        </button>
        <button class="btn-ghost" onClick={onClear} disabled={!lessons.length}>
          Clear
        </button>
      </div>
      {status.state !== "idle" && status.message ? (
        <p
          class={`lesson-status${status.state === "error" ? " is-error" : ""}${status.state === "running" ? " is-running" : ""}`}
        >
          {status.message}
        </p>
      ) : null}
      <div class="sheet-body hist-body">
        {lessons.length === 0 ? (
          <div class="empty">
            <span class="empty-icon">
              <Icon d={ICONS.bulb} size={20} />
            </span>
            <b>No lessons yet</b>
            <p class="hint">
              After a run fails — or whenever you press Review — a second agent on
              the same model writes down what went wrong and what to do instead.
              Later runs read these back, so the same mistake is not repeated.
            </p>
          </div>
        ) : (
          lessons.map((lesson, i) => (
            <div
              class="hist-row lesson-row"
              key={lesson.id}
              style={`--i:${Math.min(i, 12)}`}
            >
              <div class="lesson-item">
                <div class="lesson-tags">
                  <span class="lesson-tag">{lesson.category}</span>
                  {lesson.host ? (
                    <span class="lesson-tag">{lesson.host}</span>
                  ) : null}
                  {lesson.tool ? (
                    <span class="lesson-tag">{lesson.tool}</span>
                  ) : null}
                  <span class="lesson-tag is-soft">
                    {lesson.source}
                    {lesson.hits > 1 ? ` · seen ${lesson.hits}×` : ""}
                  </span>
                  {lesson.pinned ? (
                    <span class="lesson-tag is-pin">pinned</span>
                  ) : null}
                </div>
                {editing === lesson.id ? (
                  <div class="lesson-edit">
                    <textarea
                      value={draft}
                      onInput={(e) =>
                        setDraft((e.target as HTMLTextAreaElement).value)
                      }
                    />
                    <div class="lesson-edit-actions">
                      <button class="btn-soft" onClick={() => commitEdit(lesson.id)}>
                        Save
                      </button>
                      <button class="btn-ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p class="lesson-text">{lesson.text}</p>
                )}
                {lesson.evidence ? (
                  <p class="lesson-evidence">{lesson.evidence}</p>
                ) : null}
                <p class="lesson-meta">
                  {relativeTime(lesson.at)} · from a {lesson.outcome} run:{" "}
                  {lesson.task || "untitled"}
                </p>
              </div>
              <div class="lesson-tools">
                <button
                  class="btn-icon btn-icon-sm"
                  onClick={() => onUpdate(lesson.id, { pinned: !lesson.pinned })}
                  aria-label={lesson.pinned ? "Unpin lesson" : "Pin lesson"}
                  data-tip={lesson.pinned ? "Unpin" : "Pin"}
                  data-tip-align="end"
                >
                  <Icon d={ICONS.tag} size={13} />
                </button>
                <button
                  class="btn-icon btn-icon-sm"
                  onClick={() => startEdit(lesson)}
                  aria-label="Edit lesson"
                  data-tip="Edit"
                  data-tip-align="end"
                >
                  <Icon d={ICONS.doc} size={13} />
                </button>
                <button
                  class="btn-icon btn-icon-sm hist-del"
                  onClick={() => onDelete(lesson.id)}
                  aria-label="Delete lesson"
                  data-tip="Delete"
                  data-tip-align="end"
                >
                  <Icon d={ICONS.trash} size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ------------------------------ welcome ------------------------------

const SUGGESTIONS = [
  {
    icon: ICONS.check,
    title: "Complete the task at hand",
    task: "Complete the task on the current page",
  },
  {
    icon: ICONS.form,
    title: "Fill out the form",
    task: "Fill out the form on the current page",
  },
  {
    icon: ICONS.search,
    title: "Research something",
    task: "Research ______ and summarize what you find",
  },
  {
    icon: ICONS.clock,
    title: "Check upcoming tasks",
    task: "Check the current page for upcoming tasks and list them",
  },
];

function Welcome({ onPick }: { onPick: (task: string) => void }) {
  return (
    <div class="welcome">
      <div class="hero-orb">
        <Orb size={44} />
      </div>
      <h2 class="welcome-title">
        What can I <span class="grad-text">do</span> for you?
      </h2>
      <p class="welcome-sub">I can click, type and use your browser FOR you.</p>
      <div class="suggestions">
        {SUGGESTIONS.map((s, i) => (
          <button key={s.task} class="chip" style={`--i:${i}`} onClick={() => onPick(s.task)}>
            <span class="chip-icon">
              <Icon d={s.icon} size={14} />
            </span>
            <span class="chip-text">
              <b>{s.title}</b>
              <small>{s.task}</small>
            </span>
            <span class="chip-arrow">
              <Icon d={ICONS.arrowRight} size={13} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------ viewer ------------------------------

function ImageViewer({ src, onClose }: { src: string | null; onClose: () => void }) {
  const presence = usePresence(Boolean(src), 240);
  const last = useRef(src);
  if (src) last.current = src;
  if (!presence.mounted || !last.current) return null;
  return (
    <div class="viewer" data-state={presence.state} onClick={onClose}>
      <img src={last.current} alt="Screenshot" />
      <button class="viewer-close" aria-label="Close">
        <Icon d={ICONS.close} size={16} />
      </button>
    </div>
  );
}

// ------------------------------ plan dropdown ------------------------------

/**
 * The agent's live todo list (`todo_write`), rendered as a dropdown anchored
 * under the topbar. Updates arrive mid-run as whole-list replacements; the
 * collapsed strip always shows progress + the item in flight, expanding
 * reveals every row. `pulse` remounts the count on each update so the arrival
 * animation replays — a mid-run change is visible without stealing a click.
 */
function TodoBar({
  items,
  open,
  pulse,
  running,
  onToggle,
}: {
  items: TodoItem[];
  open: boolean;
  pulse: number;
  running: boolean;
  onToggle: () => void;
}) {
  if (!items.length) return null;
  const done = items.filter((t) => t.status === "completed").length;
  const blocked = items.filter((t) => t.status === "blocked").length;
  const current = items.find((t) => t.status === "in_progress");
  const ratio = done / items.length;
  const headline = current
    ? current.content
    : done === items.length
      ? "All done"
      : blocked
        ? `${items.length - done - blocked} left · ${blocked} blocked`
        : `${items.length - done} left`;
  return (
    <div class={`todo-bar${open ? " is-open" : ""}${running ? "" : " is-idle"}`}>
      <button
        class="todo-strip"
        onClick={onToggle}
        aria-expanded={open}
        aria-label="Agent plan"
        title="The agent's live plan — it updates this itself while it works"
      >
        <span class="todo-ic">
          <Icon d={ICONS.list} size={13} />
        </span>
        <span class="todo-count" key={pulse}>
          {done}/{items.length}
        </span>
        <span class="todo-meter" aria-hidden="true">
          <span style={`transform:scaleX(${ratio})`} />
        </span>
        <span class="todo-current">{headline}</span>
        <span class={`todo-chev${open ? " is-open" : ""}`}>
          <Icon d={ICONS.chevron} size={13} />
        </span>
      </button>
      <Collapse open={open}>
        <ul class="todo-list">
          {items.map((t, i) => (
            <li key={`${i}-${t.content}`} class={`todo-item is-${t.status}`}>
              <span class="todo-mark">
                {t.status === "completed" ? (
                  <Icon d={ICONS.check} size={11} stroke={2.6} />
                ) : t.status === "blocked" ? (
                  <Icon d={ICONS.close} size={10} stroke={2.6} />
                ) : t.status === "in_progress" ? (
                  <span class="todo-dot" />
                ) : (
                  <span class="todo-ring" />
                )}
              </span>
              <span class="todo-text">{t.content}</span>
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

// ------------------------------ app ------------------------------

/** Hover text for the "last:" summary — the details that don't fit inline. */
function lastRunTitle(u: UsageStats): string {
  const parts = [
    `steps: ${u.steps ?? "—"}`,
    `input: ${formatTokens(Math.max(0, u.totalTokens - u.outputTokens))}`,
    `output: ${formatTokens(u.outputTokens)}`,
    `context: ${formatTokens(u.contextTokens)} / ${formatTokens(u.contextWindow)}`,
  ];
  if (u.reasoningChars) parts.push(`reasoning: ${u.reasoningChars} chars`);
  if (u.cachedInputTokens !== undefined) {
    const pct = u.inputTokens ? Math.round((100 * u.cachedInputTokens) / u.inputTokens) : 0;
    parts.push(`cached input: ${formatTokens(u.cachedInputTokens)} (${pct}% of input)`);
  }
  return parts.join("\n");
}

interface UsageStats {
  totalTokens: number;
  outputTokens: number;
  tokensPerSec: number;
  contextTokens: number;
  contextWindow: number;
  /** Kept so the bar still reads correctly once the run has ended. */
  elapsedMs?: number;
  steps?: number;
  reasoningChars?: number;
  /**
   * Input tokens the provider served from its prompt cache, when it reports
   * one. Shown because a step's ~8k-token prefix is re-sent every round trip:
   * a low cache hit rate is the difference between a 7s and a 35s step.
   */
  cachedInputTokens?: number;
  inputTokens?: number;
}

function App() {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [, setTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [pings, setPings] = useState(0);
  const [swStartedAt, setSwStartedAt] = useState<number | null>(null);
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [taskText, setTaskText] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<ConversationSummary[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<LogSummary[]>([]);
  const [logDetail, setLogDetail] = useState<LogTurnRecord | null>(null);
  const [showLessons, setShowLessons] = useState(false);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsError, setSkillsError] = useState<string | undefined>();
  /**
   * Set while the step's LLM request is on the wire and nothing has streamed
   * back — the activity label uses it to say WHAT the wait is (context sent,
   * provider queue/prefill) instead of the vague "Deciding next step". A ref
   * twin exists because the port listener is bound once and closes over state.
   */
  const [awaitingModel, setAwaitingModel] = useState<{
    at: number;
    contextTokens: number;
  } | null>(null);
  const awaitingModelRef = useRef<{ at: number; contextTokens: number } | null>(null);
  const [coachStatus, setCoachStatus] = useState<CoachStatus>({ state: "idle" });
  const [lessonBadge, setLessonBadge] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Map<string, Decision>>(new Map());
  const [humanResolved, setHumanResolved] = useState<Map<string, boolean>>(new Map());
  const [openMenu, setOpenMenu] = useState<"model" | null>(null);
  /** Selected row in the slash-command autocomplete (clamped at render). */
  const [slashIdx, setSlashIdx] = useState(0);
  const [settings, setSettingsState] = useState<AgentSettings | null>(null);
  const [attachments, setAttachments] = useState<RunAttachment[]>([]);
  /**
   * Window isolation: which window the agent may work in, and the per-run
   * "look outside" grant the user can flip before pressing Run. The status
   * comes from the service worker (it owns the binding); this panel only
   * renders it and sends the two user gestures (bind / hand over a tab).
   */
  const [agentWindow, setAgentWindow] = useState<AgentWindowStatus | null>(null);
  const [allowOutside, setAllowOutside] = useState(false);
  /**
   * The agent's live plan (`todo_write` → `todo_update` events). Whole-list
   * replacements; the dropdown under the topbar renders it. `todoPulse`
   * replays the count's arrival animation on every mid-run change, and the
   * auto-open ref makes only the FIRST update of a run open the dropdown —
   * later ones never steal it back from a user who collapsed it.
   */
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoOpen, setTodoOpen] = useState(false);
  const [todoPulse, setTodoPulse] = useState(0);
  const todoAutoOpened = useRef(false);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelListState, setModelListState] = useState<"idle" | "loading" | "error">("idle");
  const [modelListError, setModelListError] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [dragging, setDragging] = useState(false);
  /**
   * Shared-element handoff: when a chat starts from the welcome screen, the
   * hero orb shrinks and flies into the first assistant badge instead of
   * vanishing and reappearing smaller. Holds the hero's last rect while a
   * ghost orb is in flight (see the orbFly effect).
   */
  const [orbFly, setOrbFly] = useState<{ x: number; y: number; w: number } | null>(null);
  const orbFlyRef = useRef<HTMLSpanElement | null>(null);
  const modelCacheRef = useRef<{ signature: string; models: string[] } | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  /** The window hosting this panel — "adopt this window" mode names it. */
  const panelWindowRef = useRef<number | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const runStartRef = useRef(0);
  const dragDepth = useRef(0);
  const { scrollRef, contentRef, atBottom, scrollToBottom } = useStickToBottom<
    HTMLElement,
    HTMLDivElement
  >(running);
  const inputRef = useAutosize(taskText);

  /**
   * Re-render the transcript. Streamed deltas arrive one per token (100+/s on a
   * fast decode) and each one used to force a full re-render of the live turn —
   * every tool card of the run re-diffed per token, which is what made a long
   * run feel like it was crawling. Throttled: render at once when idle (so a
   * confirm card or a finished answer appears immediately), coalesce the rest
   * into one render per window, and always fire the trailing edge so the final
   * state lands.
   *
   * `immediate` skips the throttle. Structural events (a tool card appearing, a
   * confirm prompt, the run finishing) are low-frequency AND are what a caller
   * or the user is waiting on, so they paint on arrival; only the per-token
   * deltas — the ones that arrive 100+/s — are worth coalescing.
   */
  const RENDER_WINDOW_MS = 50;
  const lastRenderAt = useRef(0);
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bump = (immediate?: boolean) => {
    const wait = immediate ? 0 : RENDER_WINDOW_MS - (Date.now() - lastRenderAt.current);
    if (wait <= 0) {
      if (renderTimer.current) {
        clearTimeout(renderTimer.current);
        renderTimer.current = null;
      }
      lastRenderAt.current = Date.now();
      setTick((t) => t + 1);
      return;
    }
    if (renderTimer.current) return;
    renderTimer.current = setTimeout(() => {
      renderTimer.current = null;
      lastRenderAt.current = Date.now();
      setTick((t) => t + 1);
    }, wait);
  };
  useEffect(
    () => () => {
      if (renderTimer.current) clearTimeout(renderTimer.current);
    },
    [],
  );
  const refreshSettings = () => void loadSettings().then(setSettingsState);

  // The settings drawer writes to the same storage key; pick those writes up so
  // switching connection there immediately repoints the composer and model menu.
  useEffect(() => {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && changes.baSettings) refreshSettings();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    refreshSettings();
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const connectPort = () => {
      if (disposed) return;
      const port = chrome.runtime.connect({ name: PORT_NAME });
      portRef.current = port;
      // Chrome can briefly reject posts while a channel is being established
      // ("Sent before connected" — SW wakeups, native cold starts): retry.
      postPort = (req) => {
        const tryPost = (attempt: number) => {
          try {
            port.postMessage(req);
          } catch {
            if (attempt < 12 && !disposed) {
              setTimeout(() => tryPost(attempt + 1), 200);
            }
          }
        };
        tryPost(0);
      };
      port.onMessage.addListener((msg: SwToPanel) => {
        if (msg.type === "agent.event") {
          eventBuffer.push(bufferedEvent(msg.event));
          if (msg.event.kind === "usage") {
            setUsage({
              totalTokens: msg.event.totalTokens,
              outputTokens: msg.event.outputTokens,
              tokensPerSec: msg.event.tokensPerSec,
              contextTokens: msg.event.contextTokens,
              contextWindow: msg.event.contextWindow,
              elapsedMs: msg.event.elapsedMs,
              inputTokens: msg.event.inputTokens,
              cachedInputTokens: msg.event.cachedInputTokens,
            });
          } else if (msg.event.kind === "done" && msg.event.stats) {
            // Freeze the final numbers so the bar persists after the run.
            const s = msg.event.stats;
            setUsage({
              totalTokens: s.totalTokens,
              outputTokens: s.outputTokens,
              tokensPerSec: s.tokensPerSec,
              contextTokens: s.contextTokens,
              contextWindow: s.contextWindow,
              elapsedMs: s.elapsedMs,
              steps: s.steps,
              reasoningChars: s.reasoningChars,
              inputTokens: s.inputTokens,
              cachedInputTokens: s.cachedInputTokens,
            });
            if (currentConv) {
              foldEvent(currentConv, msg.event);
              // Cap the screenshots the panel holds: every mounted <img> keeps
              // a multi-MB decoded bitmap alive in the extension process, and
              // a vision-heavy run used to accumulate ALL of them until the
              // process was OOM-killed (the extension vanished from the bar).
              trimCardImages(currentConv, 6);
            }
          } else if (msg.event.kind === "llm_request_sent") {
            // The "what is it doing" window: the request is on the wire and
            // nothing has streamed back yet. Ends at the first delta below.
            const awaiting = {
              at: Date.now(),
              contextTokens: msg.event.contextTokens,
            };
            awaitingModelRef.current = awaiting;
            setAwaitingModel(awaiting);
          } else if (
            (msg.event.kind === "token_delta" || msg.event.kind === "reasoning_delta") &&
            awaitingModelRef.current
          ) {
            awaitingModelRef.current = null;
            setAwaitingModel(null);
          } else if (msg.event.kind === "todo_update") {
            // The plan is UI state, not chat content — foldEvent never sees
            // it (the todo_write tool card already rides the transcript).
            setTodos(msg.event.items);
            setTodoPulse((p) => p + 1);
            if (msg.event.items.length && !todoAutoOpened.current) {
              todoAutoOpened.current = true;
              setTodoOpen(true);
            }
          } else if (currentConv) {
            foldEvent(currentConv, msg.event);
            // Only a tool_result can attach a screenshot — trimming on every
            // event walked every block of the whole run, per streamed token.
            if (msg.event.kind === "tool_result") trimCardImages(currentConv, 6);
          }
          for (const listener of listeners) listener(msg.event);
          if (msg.event.kind === "done") {
            setRunning(false);
            awaitingModelRef.current = null;
            setAwaitingModel(null);
          }
          // Deltas are the only high-volume events; everything else is a state
          // change a caller (or the user) is waiting to see, so it paints now.
          const streaming =
            msg.event.kind === "token_delta" || msg.event.kind === "reasoning_delta";
          bump(!streaming);
        } else if (msg.type === "pong") {
          setSwStartedAt(msg.startedAt);
        } else if (msg.type === "tool_result") {
          const waiter = toolWaiters.get(msg.id);
          if (waiter) {
            toolWaiters.delete(msg.id);
            waiter(msg);
          }
        } else if (msg.type === "agent.state") {
          setRunning(msg.running);
          setCheckpoint(msg.checkpoint);
          // A panel (re)connecting mid-run restores the live plan from the
          // checkpoint. An idle worker's finished run does NOT resurrect its
          // plan bar — the panel that watched the run keeps its own copy.
          if (msg.running || (msg.checkpoint && !msg.checkpoint.done)) {
            setTodos(msg.checkpoint?.todos ?? []);
          }
        } else if (msg.type === "window.status") {
          // Where the agent may work. Broadcast by the worker on connect, after
          // every change (bind / reset / handover / window closed) and at run
          // start, so this line can never show a window that is gone.
          setAgentWindow(msg.status);
        } else if (msg.type === "history.list") {
          setHistoryList(msg.conversations);
        } else if (msg.type === "history.get" && msg.conversation) {
          currentConv = msg.conversation;
          setConv(msg.conversation);
          setShowHistory(false);
        } else if (msg.type === "logs.list") {
          setLogs(msg.logs);
        } else if (msg.type === "logs.get") {
          setLogDetail(msg.log);
        } else if (msg.type === "logs.export") {
          downloadLog(msg.filename, msg.content);
        } else if (msg.type === "lessons.list") {
          setLessons(msg.lessons);
        } else if (msg.type === "skills.list") {
          setSkills(msg.skills);
          setSkillsError(msg.error);
        } else if (msg.type === "lessons.review") {
          // The coach runs in the worker: surface its progress in the drawer,
          // never in the chat thread (reviews are not part of the user's task).
          const status: CoachStatus =
            msg.status === "started"
              ? { state: "running", message: "The coach is reading the last run…" }
              : msg.status === "added"
                ? {
                    state: "added",
                    message: `Learned ${msg.added ?? 0} new lesson${(msg.added ?? 0) === 1 ? "" : "s"}${msg.merged ? ` (${msg.merged} already known)` : ""}.`,
                  }
                : msg.status === "empty"
                  ? {
                      state: "empty",
                      message: msg.message || "Nothing new to learn from that run.",
                    }
                  : { state: "error", message: msg.message || "Review failed." };
          setCoachStatus(status);
          // Never yank the drawer open mid-conversation: mark the toolbar
          // button instead, and let the user look when they want to.
          if (msg.status === "added") setLessonBadge(true);
        } else if (msg.type === "lessons.export") {
          downloadLog(msg.filename, msg.content);
        }
      });
      port.onDisconnect.addListener(() => {
        if (!disposed) retryTimer = setTimeout(connectPort, 500);
      });
      postPort({ kind: "state" });
      postPort({ kind: "ping" });
      postPort({ kind: "window.status" });
    };
    connectPort();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      postPort = null;
      portRef.current?.disconnect();
    };
  }, []);

  // The window this panel lives in. "Adopt this window" mode names it
  // explicitly, so the worker never has to guess (chrome.tabs.query with
  // currentWindow inside a service worker means "last-focused window", which
  // is exactly how a run ends up observing the user's window).
  useEffect(() => {
    void chrome.windows
      .getCurrent()
      .then((w) => {
        panelWindowRef.current = w.id;
      })
      .catch(() => undefined);
  }, []);

  // Keepalive ping + run timer.
  useEffect(() => {
    if (!running) return;
    runStartRef.current = Date.now();
    setElapsed(0);
    // The display ticks every second; the port ping (which resets the SW's
    // ~30s idle teardown and doubles as a resume probe) only needs to ride
    // every 5th tick — pinging at 1s was pure churn under load.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      setPings((p) => p + 1);
      setElapsed(Date.now() - runStartRef.current);
      if (ticks % 5 === 1) postPort?.({ kind: "ping" });
    }, 1_000);
    return () => clearInterval(timer);
  }, [running]);

  // A thread opened from history starts at its newest turn.
  useEffect(() => {
    if (conv) scrollToBottom(false);
  }, [conv?.id]);

  // Popovers close on any outside press; Escape peels back one layer at a time.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".pop")) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [openMenu]);

  // Orb handoff flight: the assistant turn (and its badge orb) only mounts
  // once the first run event arrives. A MutationObserver wakes the flight the
  // moment it does (timer-polled as a backstop — no rAF: it starves in
  // background documents), then the ghost hero orb shrinks into place while
  // the real badge orb hides until landing. The hide is an INLINE opacity,
  // not a class: Preact re-diffs the class prop on every streamed event and
  // would wipe a manually added class. Landing fires from the animation's
  // finish event AND a timer backstop (animation events need rendering
  // steps, which can stall), with a small corrective hop for scroll drift
  // during the flight. If the welcome comes back (new chat) or no badge
  // shows within a few seconds, the ghost is dropped quietly.
  useEffect(() => {
    if (!orbFly) return;
    const from = orbFly;
    let cancelled = false;
    let settled = false;
    let timer = 0;
    const started = performance.now();
    const mo = new MutationObserver(attempt);

    function land(badge: HTMLElement) {
      const el = orbFlyRef.current;
      if (!el) {
        if (!cancelled) setOrbFly(null);
        return;
      }
      settled = true;
      mo.disconnect();
      clearTimeout(timer);
      const to = badge.getBoundingClientRect();
      badge.style.opacity = "0";
      let revealed = false;
      const reveal = () => {
        if (revealed) return;
        revealed = true;
        badge.style.opacity = "";
        if (!cancelled) setOrbFly(null);
      };
      const anim = el.animate(
        [
          {
            left: `${from.x}px`,
            top: `${from.y}px`,
            width: `${from.w}px`,
            height: `${from.w}px`,
          },
          {
            left: `${to.left}px`,
            top: `${to.top}px`,
            width: `${to.width}px`,
            height: `${to.height}px`,
          },
        ],
        { duration: 560, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "forwards" },
      );
      const finish = () => {
        // The transcript may have scrolled mid-flight: hop the last few px
        // if the badge drifted from where the ghost landed.
        const now = badge.getBoundingClientRect();
        const g = el.getBoundingClientRect();
        if (Math.abs(now.x - g.x) + Math.abs(now.y - g.y) > 4) {
          const hop = el.animate(
            [
              { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width}px`, height: `${g.height}px` },
              {
                left: `${now.x}px`,
                top: `${now.y}px`,
                width: `${now.width}px`,
                height: `${now.height}px`,
              },
            ],
            { duration: 140, easing: "ease-out", fill: "forwards" },
          );
          hop.onfinish = reveal;
          setTimeout(reveal, 300);
        } else {
          reveal();
        }
      };
      anim.onfinish = finish;
      // Finish events only fire on rendering steps; the timer guarantees the
      // handoff completes even when those stall (occluded/headless documents).
      setTimeout(finish, 810);
    }

    function attempt() {
      if (cancelled || settled) return;
      if (document.querySelector(".welcome")) {
        settled = true;
        mo.disconnect();
        clearTimeout(timer);
        setOrbFly(null);
        return;
      }
      const badge = document.querySelector(".assistant-badge .orb") as HTMLElement | null;
      if (badge) {
        land(badge);
        return;
      }
      if (performance.now() - started > 6000) {
        settled = true;
        mo.disconnect();
        setOrbFly(null);
      }
    }

    mo.observe(document.body, { childList: true, subtree: true });
    timer = window.setTimeout(function poll() {
      attempt();
      if (!cancelled && !settled) timer = window.setTimeout(poll, 50);
    }, 50);
    attempt();

    return () => {
      cancelled = true;
      settled = true;
      mo.disconnect();
      clearTimeout(timer);
    };
  }, [orbFly]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (viewer) setViewer(null);
      else if (openMenu) setOpenMenu(null);
      else if (showSettings) setShowSettings(false);
      else if (showHistory) setShowHistory(false);
      else if (showLogs) setShowLogs(false);
      else if (showLessons) setShowLessons(false);
      else if (showSkills) setShowSkills(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewer, openMenu, showSettings, showHistory, showLogs, showLessons, showSkills]);

  // Accepts real-agent runs (string) and Phase 1 demo runs (demo object).
  const startRun = (
    taskOrDemo: string | DemoConfig,
    demoOrConvId?: DemoConfig | string,
  ) => {
    const isDemo = typeof taskOrDemo !== "string";
    eventBuffer.length = 0;
    // A fresh run starts with no plan: clear the previous run's list and let
    // the first todo_update open the dropdown again.
    setTodos([]);
    setTodoOpen(false);
    todoAutoOpened.current = false;
    // Grab the hero orb before the welcome unmounts: a ghost clone flies from
    // this rect into the first assistant badge once it mounts (orbFly effect).
    // Skipped under reduced motion — the badge simply appears.
    const hero = document.querySelector(".hero-orb .orb") as HTMLElement | null;
    if (hero && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const r = hero.getBoundingClientRect();
      setOrbFly({ x: r.left, y: r.top, w: r.width });
    }
    setRunning(true);
    setUsage(null);
    scrollToBottom(false);
    if (isDemo) {
      const demo = taskOrDemo as DemoConfig;
      currentConv = newLocalConversation("demo task");
      foldUser(currentConv, "demo task");
      setConv(currentConv);
      postPort?.({ kind: "run", task: "demo task", mode: "standard", demo });
      return;
    }
    const task = taskOrDemo;
    const conversationId =
      typeof demoOrConvId === "string"
        ? demoOrConvId
        : (conv?.id ?? newLocalConversation(task).id);
    if (!currentConv || currentConv.id !== conversationId) {
      const local = newLocalConversation(task);
      local.id = conversationId;
      currentConv = local;
    }
    const attach = attachments.slice();
    setAttachments([]);
    foldUser(currentConv, task, attach);
    setConv(currentConv);
    setTaskText("");
    postPort?.({
      kind: "run",
      task,
      mode: "standard",
      conversationId,
      attachments: attach.length ? attach : undefined,
      // Window isolation: the per-run read-only grant, and which window this
      // panel is in (used only when the settings say the agent works in the
      // user's window rather than its own).
      allowOutsideWindows: allowOutside || undefined,
      panelWindowId: panelWindowRef.current,
    });
  };

  /** Move the tab the user is looking at into the agent's window. */
  const handOverCurrentTab = () => {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (tab?.id === undefined) return;
        postPort?.({ kind: "window.handover", tabId: tab.id });
      })
      .catch(() => undefined);
  };

  const stop = () => postPort?.({ kind: "stop" });

  const resolveConfirm = (id: string, allow: boolean, always: boolean) => {
    setResolved((prev) => new Map(prev).set(id, !allow ? "deny" : always ? "always" : "once"));
    postPort?.({ kind: "confirm.resolve", id, allow, always });
  };

  const resolveHuman = (id: string, handled: boolean) => {
    setHumanResolved((prev) => new Map(prev).set(id, handled));
    postPort?.({ kind: "human.resolve", id, handled });
  };

  const openHistory = () => {
    setShowSettings(false);
    setShowLogs(false);
    setShowHistory(true);
    postPort?.({ kind: "history.list" });
  };

  const openConversation = (id: string) =>
    postPort?.({ kind: "history.get", conversationId: id });

  const deleteConversation = (id: string) =>
    postPort?.({ kind: "history.delete", conversationId: id });

  const openLogs = () => {
    setShowSettings(false);
    setShowHistory(false);
    setLogDetail(null);
    setShowLogs(true);
    postPort?.({ kind: "logs.list" });
  };

  const openLog = (id: string) => postPort?.({ kind: "logs.get", logId: id });

  const deleteLog = (id: string) => {
    if (logDetail?.id === id) setLogDetail(null);
    postPort?.({ kind: "logs.delete", logId: id });
  };

  const clearLogs = () => {
    setLogDetail(null);
    postPort?.({ kind: "logs.clear" });
  };

  const exportLogs = (format: LogExportFormat, logId?: string) =>
    postPort?.({ kind: "logs.export", format, logId });

  const openLessons = () => {
    setShowSettings(false);
    setShowHistory(false);
    setShowLogs(false);
    setShowLessons(true);
    setLessonBadge(false);
    postPort?.({ kind: "lessons.list" });
  };

  const reviewLessons = () => postPort?.({ kind: "lessons.review" });

  const updateLesson = (id: string, patch: { text?: string; pinned?: boolean }) =>
    postPort?.({ kind: "lessons.update", id, ...patch });

  const deleteLesson = (id: string) => postPort?.({ kind: "lessons.delete", id });

  const clearLessons = () => postPort?.({ kind: "lessons.clear" });

  const exportLessons = (format: LogExportFormat) =>
    postPort?.({ kind: "lessons.export", format });

  const openSkills = () => {
    setShowSettings(false);
    setShowHistory(false);
    setShowLogs(false);
    setShowLessons(false);
    setShowSkills(true);
    postPort?.({ kind: "skills.list" });
  };

  const newSkill = (skill: {
    name: string;
    whenToUse: string;
    body: string;
    hosts?: string[];
    keywords?: string[];
  }) => postPort?.({ kind: "skills.new", skill });

  const updateSkill = (id: string, patch: { pinned?: boolean; whenToUse?: string; body?: string }) =>
    postPort?.({ kind: "skills.update", id, patch });

  const deleteSkill = (id: string) => postPort?.({ kind: "skills.delete", id });

  const newChat = () => {
    currentConv = null;
    setConv(null);
    setTaskText("");
    setShowHistory(false);
    setTodos([]);
    setTodoOpen(false);
    todoAutoOpened.current = false;
    inputRef.current?.focus();
  };

  const pickSetting = <K extends keyof AgentSettings>(k: K, v: AgentSettings[K]) => {
    if (!settings) return;
    let next = { ...settings, [k]: v };
    // Provider/base URL/model belong to the active connection: write through to
    // the entry, or the normaliser would overwrite the edit on save.
    if (k === "model" || k === "provider" || k === "baseUrl") {
      next = {
        ...next,
        apiKeys: next.apiKeys.map((entry) =>
          entry.id === next.activeKeyId ? { ...entry, [k]: v } : entry,
        ),
      };
    }
    setSettingsState(next);
    void saveSettings(next);
    setOpenMenu(null);
  };

  // The model menu lists what the active connection can actually call — fetched
  // live from the provider's catalog, cached per provider/key/baseURL.
  const loadModels = async () => {
    if (!settings) return;
    // Read the active connection directly rather than trusting the derived
    // mirrors: those can lag a connection switch by one save, which sent the
    // previous connection's key and surfaced as a bogus "key not valid".
    const conn = activeConnection(settings);
    const creds = conn
      ? { provider: conn.provider, baseUrl: conn.baseUrl, apiKey: conn.key }
      : {
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
        };
    const signature = `${creds.provider}|${creds.baseUrl}|${creds.apiKey}`;
    if (modelCacheRef.current?.signature === signature) {
      setModelList(modelCacheRef.current.models);
      setModelListState("idle");
      return;
    }
    setModelListState("loading");
    const result = await fetchModelsFor(creds);
    if (result.models.length) {
      modelCacheRef.current = { signature, models: result.models };
      setModelList(result.models);
      setModelListState("idle");
    } else {
      setModelList([]);
      setModelListState("error");
      setModelListError(result.error ?? "could not load models");
    }
  };

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files).slice(0, 4)) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result ?? "");
        const isImage = file.type.startsWith("image/");
        setAttachments((prev) => [
          ...prev,
          {
            name: file.name,
            kind: isImage ? ("image" as const) : ("text" as const),
            data: isImage ? data : data.slice(0, 20_000),
          },
        ].slice(0, 4));
      };
      if (file.type.startsWith("image/")) reader.readAsDataURL(file);
      else reader.readAsText(file);
    }
  };

  // ---- stable test surface (phase smokes + e2e) ----
  (window as unknown as { __ba: unknown }).__ba = {
    run: startRun,
    /** Fresh thread unless a conversationId is given (then: multi-turn). */
    runTask: (task: string, conversationId?: string) => {
      // Explicit fresh id — setConv is async, so don't infer from state here.
      startRun(task, conversationId ?? crypto.randomUUID());
    },
    stop,
    runTool,
    /** Non-rejecting tool runner for driver scripts: { ok, payload?, error? }. */
    tool: (name: string, args?: Record<string, unknown>, tabId?: number) =>
      runTool(name, args, tabId).then(
        (payload) => ({ ok: true, payload }),
        (err) => ({ ok: false, error: String((err as Error)?.stack ?? err) }),
      ),
    /** The model-facing text of one tool run (non-rejecting). */
    toolText: (name: string, args?: Record<string, unknown>, tabId?: number) =>
      runToolFull(name, args, tabId).then(
        (r) => r.text ?? "",
        (err) => `ERROR: ${String((err as Error)?.message ?? err)}`,
      ),
    /** Gated execution — policy confirms and human handoff apply (driver scripts). */
    toolGated: (name: string, args?: Record<string, unknown>, tabId?: number) =>
      runToolFull(name, args, tabId, true).then(
        (r) => ({ ok: true, payload: r.payload, text: r.text }),
        (err) => ({ ok: false, error: String((err as Error)?.message ?? err) }),
      ),
    state: () => ({ running, pings, swStartedAt, checkpoint }),
    events: () => [...eventBuffer],
    swPing: () => chrome.runtime.sendMessage({ type: "ping" }),
    queryState: () => chrome.runtime.sendMessage({ type: "state" }),
    /**
     * Window isolation (driver scripts): where the agent is allowed to work,
     * bind a window the fixture lives in, hand a tab over, and the raise
     * counter a quiet-mode run must leave at 0.
     */
    window: () =>
      chrome.runtime
        .sendMessage({ type: "window.status" })
        .then((r) => (r as { status?: AgentWindowStatus } | undefined)?.status ?? null),
    bindWindow: async (windowId: number) => {
      const status = await chrome.runtime
        .sendMessage({ type: "window.bind", windowId })
        .then((r) => (r as { status?: AgentWindowStatus } | undefined)?.status ?? null);
      // Same semantics as the user's "Use this window for the agent" button:
      // adopting a window IS choosing the adopt mode, so the setting and the
      // binding cannot drift apart.
      const s = await loadSettings();
      await saveSettings({ ...s, agentWindow: { ...s.agentWindow, mode: "adopt" } });
      return status;
    },
    resetWindow: () =>
      chrome.runtime
        .sendMessage({ type: "window.reset" })
        .then((r) => (r as { status?: AgentWindowStatus } | undefined)?.status ?? null),
    raiseCount: () =>
      chrome.runtime
        .sendMessage({ type: "window.status" })
        .then((r) => (r as { status?: AgentWindowStatus } | undefined)?.status?.raiseAttempts ?? 0),
    handover: (tabId: number) => postPort?.({ kind: "window.handover", tabId }),
    /** Driver-script twin of the composer's per-run "look outside" toggle. */
    setScope: (allowOutside: boolean) => postPort?.({ kind: "test_scope", allowOutside }),
    onEvent: (cb: (e: StepEvent) => void) => listeners.add(cb),
    suspendKeepalive: () => postPort?.({ kind: "test_suspend" }),
    resolveConfirm,
    resolveHuman,
    getSettings: () => loadSettings(),
    setSettings: (s: AgentSettings) => saveSettings(s).then(refreshSettings),
    // chat/history surface
    currentConversation: () => (currentConv ? structuredClone(currentConv) : null),
    /**
     * All stored threads, newest-first — same shape the smokes have always
     * seen, but assembled from the per-conversation keys via the summary
     * index (the legacy single `baConversations` array no longer exists).
     */
    conversations: async (): Promise<Conversation[]> => {
      const head = await chrome.storage.local.get("baConvIndex");
      const index = (head.baConvIndex as ConversationSummary[] | undefined) ?? [];
      if (!index.length) return [];
      const keys = index.map((s) => `baConv:${s.id}`);
      const out = await chrome.storage.local.get(keys);
      return keys.flatMap((k) => {
        const c = out[k] as Conversation | undefined;
        return c ? [c] : [];
      });
    },
    openConversation,
    deleteConversation,
    newChat,
    slash: (text: string) => runSlash(text),
    // run-log surface (timestamped per-turn chat + tool archive)
    /** All archived run records, newest-first, via the summary index. */
    logs: async (): Promise<LogTurnRecord[]> => {
      const head = await chrome.storage.local.get("baLogIndex");
      const index = (head.baLogIndex as LogSummary[] | undefined) ?? [];
      if (!index.length) return [];
      const keys = index.map((s) => `baLog:${s.id}`);
      const out = await chrome.storage.local.get(keys);
      return keys.flatMap((k) => {
        const r = out[k] as LogTurnRecord | undefined;
        return r ? [r] : [];
      });
    },
    logsUI: () => ({ open: showLogs, detail: logDetail?.id ?? null }),
    lessons: () =>
      chrome.storage.local
        .get("baLessons")
        .then((r) => (r.baLessons as Lesson[] | undefined) ?? []),
    lessonsUI: () => ({ open: showLessons, status: coachStatus, badge: lessonBadge }),
    reviewLessons,
    // skills surface (on-demand procedures)
    skills: () =>
      chrome.storage.local
        .get("baSkills")
        .then((r) => (r.baSkills as Skill[] | undefined) ?? []),
    skillsUI: () => ({ open: showSkills }),
    // control bar surface
    usage: () => usage,
    addAttachment: (a: RunAttachment) => setAttachments((prev) => [...prev, a].slice(0, 4)),
    attachments: () => attachments,
  };

  // ------------------------------ slash commands ------------------------------

  /** Focus the composer with the caret at the end (after programmatic text). */
  const focusInputEnd = () => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  /**
   * Execute a known slash command from raw composer text. Returns true when
   * the text was consumed as a command; unknown `/words` fall through and
   * are sent as an ordinary task.
   */
  const runSlash = (text: string): boolean => {
    const p = parseSlash(text);
    if (!p || !p.known) return false;
    switch (p.command) {
      case "new":
        newChat();
        return true;
      case "sessions":
        setTaskText("");
        if (!showHistory) openHistory();
        return true;
      case "model": {
        setTaskText("");
        if (!p.arg) {
          // Bare /model: open the picker.
          setOpenMenu("model");
          setModelFilter("");
          void loadModels();
          return true;
        }
        // Named: exact catalog match wins, then substring; with no catalog
        // loaded yet take the name as-is (model ids are free-form strings).
        const q = p.arg.toLowerCase();
        const hit =
          modelList.find((m) => m.toLowerCase() === q) ??
          modelList.find((m) => m.toLowerCase().includes(q));
        if (hit) {
          pickSetting("model", hit);
        } else if (modelList.length) {
          // No match: open the picker pre-filtered rather than switch blind.
          setOpenMenu("model");
          setModelFilter(p.arg);
          void loadModels();
        } else {
          pickSetting("model", p.arg);
        }
        return true;
      }
      case "rename": {
        if (!p.arg) {
          // Nothing to rename to: leave the command waiting for its title.
          setTaskText("/rename ");
          focusInputEnd();
          return true;
        }
        if (!currentConv) {
          setTaskText("");
          return true;
        }
        const title = p.arg.slice(0, 80);
        // Mutate in place — the state object IS currentConv, so later folds
        // keep working — then re-render. The worker persists the new title
        // (and retitles its own live copy so the next flush cannot revert it).
        currentConv.title = title;
        bump();
        postPort?.({ kind: "history.rename", conversationId: currentConv.id, title });
        setTaskText("");
        return true;
      }
      default:
        return false;
    }
  };

  /**
   * Autocomplete row activation. `execute` (Enter/click) runs the command —
   * except a bare /rename, which needs a title and completes instead. Tab
   * always completes the word without running anything.
   */
  const completeSlash = (cmd: SlashCommand, execute: boolean) => {
    setSlashIdx(0);
    if (!execute || (cmd.takesArg && cmd.name === "rename")) {
      setTaskText(`/${cmd.name}${cmd.takesArg ? " " : ""}`);
      focusInputEnd();
      return;
    }
    runSlash(`/${cmd.name}`);
  };

  const sendTask = () => {
    const task = taskText.trim();
    if (!task && !attachments.length) return;
    if (running) {
      // Mid-run steering: queue the message for the running agent — it lands
      // as a normal user turn the model sees on its next step. Text only; a
      // new task (with attachments) is one Stop away. Slash commands are an
      // idle affordance: mid-run text always steers literally.
      if (!task) return;
      postPort?.({ kind: "run.input", text: task });
      if (currentConv) foldUser(currentConv, task);
      bump();
      setTaskText("");
      return;
    }
    if (!attachments.length && runSlash(task)) return;
    startRun(task || "(see attachments)");
  };

  // Markdown links open in a new browser tab, never inside the panel.
  const onTranscriptClick = (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest?.("a[href]");
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) void chrome.tabs.create({ url: href });
  };

  // Drag-and-drop anywhere on the panel attaches files.
  const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
  const dragHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      onFiles(e.dataTransfer?.files ?? null);
    },
  };

  const pickSuggestion = (task: string) => {
    setTaskText(task);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(task.length, task.length);
    });
  };

  const modelLabel = settings?.model ?? "model";
  const lastTurnIndex = conv ? conv.turns.length - 1 : -1;
  const ctxWindow = usage?.contextWindow ?? settings?.contextWindow ?? 128_000;
  const ctxRatio = Math.min(1, (usage?.contextTokens ?? 0) / Math.max(1, ctxWindow));
  const filteredModels = modelFilter.trim()
    ? modelList.filter((m) => m.toLowerCase().includes(modelFilter.trim().toLowerCase()))
    : modelList;
  // Slash autocomplete: candidates while the command word is being typed
  // (matchSlash hides the menu once a space — the argument — appears).
  const slashMatches = matchSlash(taskText);
  const slashSel = Math.min(slashIdx, Math.max(0, slashMatches.length - 1));
  const canSend = Boolean(taskText.trim() || attachments.length);

  return (
    <div class={`shell${running ? " is-running" : ""}${conv ? " has-conv" : ""}`} {...dragHandlers}>
      <span class="window-glow" aria-hidden="true" />
      {orbFly ? (
        <span
          ref={orbFlyRef}
          class="orb orb-fly"
          aria-hidden="true"
          style={`left:${orbFly.x}px;top:${orbFly.y}px;width:${orbFly.w}px;height:${orbFly.w}px;--orb:${orbFly.w}px`}
        />
      ) : null}

      <header class="topbar">
        <div class="brand">
          <div class="brand-text">
            <span class="brand-name">crazyAgent</span>
            <span class="brand-sub" key={running ? "run" : "idle"}>
              {running ? (
                <span class="shimmer-text">Working · {formatElapsed(elapsed)}</span>
              ) : (
                <>
                  <span class="live-dot idle" />
                  Ready
                </>
              )}
            </span>
          </div>
        </div>
        <nav class="topbar-actions">
          <IconButton icon={ICONS.compose} tip="New chat" label="New chat" onClick={newChat} />
          <IconButton
            icon={ICONS.history}
            tip="History"
            label="History"
            class={showHistory ? "is-on" : ""}
            onClick={() => (showHistory ? setShowHistory(false) : openHistory())}
          />
          <IconButton
            icon={ICONS.logs}
            tip="Run logs"
            label="Run logs"
            class={showLogs ? "is-on" : ""}
            onClick={() => (showLogs ? setShowLogs(false) : openLogs())}
          />
          <span class={`badge-wrap${lessonBadge ? " has-badge" : ""}`}>
            <IconButton
              icon={ICONS.bulb}
              tip="Lessons"
              label="Lessons"
              class={showLessons ? "is-on" : ""}
              onClick={() => (showLessons ? setShowLessons(false) : openLessons())}
            />
          </span>
          <IconButton
            icon={ICONS.doc}
            tip="Skills (procedures)"
            label="Skills"
            class={showSkills ? "is-on" : ""}
            onClick={() => (showSkills ? setShowSkills(false) : openSkills())}
          />
          <IconButton
            icon={ICONS.settings}
            tip="Settings"
            label="⚙"
            tipAlign="end"
            class={showSettings ? "is-on" : ""}
            onClick={() => {
              setShowHistory(false);
              setShowLogs(false);
              setShowSettings(!showSettings);
            }}
          />
        </nav>
      </header>

      <TodoBar
        items={todos}
        open={todoOpen}
        pulse={todoPulse}
        running={running}
        onToggle={() => setTodoOpen((o) => !o)}
      />

      <div class="stage">
        <main class="transcript" ref={scrollRef} onClick={onTranscriptClick}>
          <div class="transcript-inner" ref={contentRef}>
            {!conv ? (
              <Welcome onPick={pickSuggestion} />
            ) : (
              conv.turns.map((turn, i) => (
                <TurnView
                  key={i}
                  turn={turn}
                  live={running || i === lastTurnIndex}
                  active={running && i === lastTurnIndex}
                  onZoom={(src) => setViewer(src)}
                  onConfirm={resolveConfirm}
                  resolved={resolved}
                  onHuman={resolveHuman}
                  humanResolved={humanResolved}
                />
              ))
            )}
            {running ? (
              <WorkingIndicator
                label={activityLabel(conv, awaitingModel, Date.now())}
                jev={jevActivity(conv)}
              />
            ) : null}
          </div>
        </main>
        <button
          class={`jump${!atBottom && conv ? " is-visible" : ""}`}
          onClick={() => scrollToBottom()}
          tabIndex={!atBottom && conv ? 0 : -1}
        >
          <Icon d={ICONS.arrowDown} size={12} /> Latest
        </button>
      </div>

      <footer class="composer-wrap">
        {/* Window isolation, visible where runs start: which window the agent
            works in, a hand-over for the page you are looking at, and the
            per-run read-only grant. The agent itself can never widen its own
            scope — only these controls can. */}
        <div class="window-bar">
          <span
            class={`window-chip${agentWindow?.alive ? " is-live" : ""}`}
            title={
              agentWindow?.alive
                ? `The agent works only inside this window (${agentWindow.tabs} tab${agentWindow.tabs === 1 ? "" : "s"}). Your other windows are invisible to it.`
                : "The agent gets its own window the moment a run starts. Yours stays untouched."
            }
          >
            <Icon d={ICONS.window} size={11} />
            <span class="window-chip-text">
              {agentWindow?.alive
                ? `${agentWindow.mode === "adopt" ? "this window" : "own window"} #${agentWindow.windowId} · ${agentWindow.tabs} tab${agentWindow.tabs === 1 ? "" : "s"}`
                : "own window · opens on Run"}
            </span>
          </span>
          {agentWindow?.alive && agentWindow.mode === "own" ? (
            <button
              class="window-btn"
              title="Move this tab into the agent's window so the agent can work on it — the page keeps its state (scroll, form, logins)"
              onClick={handOverCurrentTab}
            >
              Hand this tab to the agent
            </button>
          ) : null}
          <label
            class={`window-toggle${allowOutside ? " is-on" : ""}`}
            title="For THIS run only: let the agent LIST your other windows' tabs (titles and URLs) when a task needs them. It still cannot click, type or read page content outside its own window."
          >
            <input
              type="checkbox"
              checked={allowOutside}
              onChange={(e) => setAllowOutside((e.target as HTMLInputElement).checked)}
            />
            <Icon d={ICONS.eye} size={11} />
            <span>Look outside</span>
          </label>
        </div>
        {attachments.length ? (
          <div class="draft-strip">
            {attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} class="attach-chip draft-chip">
                {a.kind === "image" ? (
                  <img class="attach-thumb" src={a.data} alt="" />
                ) : (
                  <Icon d={ICONS.clip} size={11} />
                )}
                <span class="attach-name">{a.name}</span>
                <button
                  class="chip-x"
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  <Icon d={ICONS.close} size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div class="composer">
          {slashMatches.length ? (
            <div class="slash-menu" role="listbox" aria-label="Slash commands">
              {slashMatches.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  class={`slash-item${i === slashSel ? " is-sel" : ""}`}
                  role="option"
                  aria-selected={i === slashSel}
                  onMouseDown={(e) => {
                    // preventDefault keeps the textarea focused through the click.
                    e.preventDefault();
                    completeSlash(c, true);
                  }}
                  onMouseEnter={() => setSlashIdx(i)}
                >
                  <span class="slash-icon">
                    <Icon d={SLASH_ICONS[c.name] ?? ICONS.command} size={13} />
                  </span>
                  <span class="slash-name">
                    /{c.name}
                    {c.hint ? <em> {c.hint}</em> : null}
                  </span>
                  <span class="slash-desc">{c.description}</span>
                  {i === slashSel ? <span class="slash-enter">↵</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            class="task-input"
            rows={1}
            placeholder={
              running
                ? "Steer the agent — it reads this on its next step…"
                : "Ask crazyAgent to do anything on the web…"
            }
            value={taskText}
            onInput={(e) => {
              setTaskText((e.target as HTMLTextAreaElement).value);
              setSlashIdx(0);
            }}
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files?.length) {
                e.preventDefault();
                onFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (slashMatches.length) {
                const sel = slashMatches[slashSel]!;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const dir = e.key === "ArrowDown" ? 1 : -1;
                  setSlashIdx(
                    (slashSel + dir + slashMatches.length) % slashMatches.length,
                  );
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  completeSlash(sel, true);
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  completeSlash(sel, false);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendTask();
              }
            }}
          />
          <div class="toolbar">
            <button
              class="btn-icon attach-btn"
              title="Attach files"
              onClick={() => fileRef.current?.click()}
            >
              <Icon d={ICONS.plus} size={16} />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.txt,.md,.json,.csv,.log,.html"
              style="display:none"
              onChange={(e) => {
                onFiles((e.target as HTMLInputElement).files);
                (e.target as HTMLInputElement).value = "";
              }}
            />

            <Popover
              label={modelLabel}
              icon={ICONS.cpu}
              open={openMenu === "model"}
              onToggle={() => {
                const next = openMenu === "model" ? null : "model";
                setOpenMenu(next);
                setModelFilter("");
                if (next) void loadModels();
              }}
            >
              <div class="menu-head">Model</div>
              {modelListState === "idle" && modelList.length > 8 ? (
                <div class="menu-search">
                  <Icon d={ICONS.search} size={12} />
                  <input
                    placeholder="Filter models"
                    value={modelFilter}
                    onInput={(e) => setModelFilter((e.target as HTMLInputElement).value)}
                  />
                </div>
              ) : null}
              <div class="menu-scroll">
                {modelListState === "loading" ? (
                  <div class="menu-note">
                    <span class="spinner" /> Loading models for this key…
                  </div>
                ) : modelListState === "error" ? (
                  <div class="menu-note menu-error">{modelListError}</div>
                ) : (
                  filteredModels.map((m) => (
                    <MenuItem
                      key={m}
                      active={settings?.model === m}
                      title={m}
                      onClick={() => pickSetting("model", m)}
                    />
                  ))
                )}
                {modelListState === "idle" && settings?.model && !modelList.includes(settings.model) ? (
                  <MenuItem
                    active
                    title={settings.model}
                    hint="current (not in this key's catalog)"
                    onClick={() => setOpenMenu(null)}
                  />
                ) : null}
              </div>
            </Popover>

            <span class="toolbar-spacer" />

            <button
              class={`btn-icon send${running ? " stop" : ""}`}
              onClick={running ? stop : sendTask}
              disabled={!running && !canSend}
              aria-label={running ? "Stop" : "Run"}
            >
              <span class="send-icons">
                <Icon d={ICONS.send} size={16} stroke={2.2} class="i-send" />
                <Icon d={ICONS.stop} size={12} fill class="i-stop" />
              </span>
              <span class="vh">{running ? "Stop" : "Run"}</span>
            </button>
          </div>
        </div>

        <div class="status">
          {running ? (
            <>
              <span class="stat stat-timer">
                <Icon d={ICONS.clock} size={11} /> {formatElapsed(elapsed)}
              </span>
              <span class="stat stat-tokens">
                <Icon d={ICONS.activity} size={11} /> {formatTokens(usage?.totalTokens ?? 0)} tok
              </span>
              <span class="stat stat-ctx" title="Context used">
                ctx {formatTokens(usage?.contextTokens ?? 0)}/{formatTokens(ctxWindow)}
                <span class="meter">
                  <span style={`transform:scaleX(${ctxRatio})`} />
                </span>
              </span>
              {/* Only when the endpoint reports a cache number — a silent
                  provider shows nothing rather than a misleading 0%. */}
              {usage?.cachedInputTokens !== undefined && (
                <span
                  class="stat stat-cache"
                  title="Input tokens served from the provider's prompt cache"
                >
                  cache{" "}
                  {usage.inputTokens
                    ? Math.round((100 * usage.cachedInputTokens) / usage.inputTokens)
                    : 0}
                  %
                </span>
              )}
            </>
          ) : (
            <>
              <span class="stat">
                <kbd>↵</kbd> run <kbd>⇧↵</kbd> newline
              </span>
              <span class="stat">
                <kbd>/</kbd> commands
              </span>
              {usage ? (
                <span class="stat stat-last" title={lastRunTitle(usage)}>
                  last run {formatElapsed(usage.elapsedMs ?? 0)} ·{" "}
                  {formatTokens(usage.totalTokens)} tok
                </span>
              ) : null}
              {checkpoint && !checkpoint.done ? (
                <span class="stat">checkpoint @ step {checkpoint.stepIndex + 1}</span>
              ) : null}
            </>
          )}
        </div>
      </footer>

      <Sheet
        open={showHistory}
        side="left"
        class="history-view"
        label="History"
        onClose={() => setShowHistory(false)}
      >
        <HistoryBody
          items={historyList}
          currentId={conv?.id}
          onOpen={openConversation}
          onDelete={deleteConversation}
          onClose={() => setShowHistory(false)}
        />
      </Sheet>

      <Sheet
        open={showLogs}
        side="left"
        class="history-view logs-view"
        label="Run logs"
        onClose={() => {
          setShowLogs(false);
          setLogDetail(null);
        }}
      >
        <LogsBody
          logs={logs}
          detail={logDetail}
          onOpen={openLog}
          onBack={() => setLogDetail(null)}
          onDelete={deleteLog}
          onClear={clearLogs}
          onExport={exportLogs}
          onLearn={(logId) => postPort?.({ kind: "lessons.review", logId })}
          onClose={() => {
            setShowLogs(false);
            setLogDetail(null);
          }}
        />
      </Sheet>

      <Sheet
        open={showLessons}
        side="left"
        class="history-view lessons-view"
        label="Lessons"
        onClose={() => setShowLessons(false)}
      >
        <LessonsBody
          lessons={lessons}
          status={coachStatus}
          onReview={reviewLessons}
          onUpdate={updateLesson}
          onDelete={deleteLesson}
          onClear={clearLessons}
          onExport={exportLessons}
          onClose={() => setShowLessons(false)}
        />
      </Sheet>

      <Sheet
        open={showSkills}
        side="left"
        class="history-view lessons-view"
        label="Skills"
        onClose={() => setShowSkills(false)}
      >
        <SkillsBody
          skills={skills}
          error={skillsError}
          onNew={newSkill}
          onUpdate={updateSkill}
          onDelete={deleteSkill}
          onClose={() => setShowSkills(false)}
        />
      </Sheet>

      <Sheet
        open={showSettings}
        side="right"
        class="drawer"
        label="Settings"
        onClose={() => setShowSettings(false)}
      >
        <SettingsBody onClose={() => setShowSettings(false)} />
      </Sheet>

      <ImageViewer src={viewer} onClose={() => setViewer(null)} />

      <div class={`dropzone${dragging ? " is-visible" : ""}`} aria-hidden="true">
        <div class="dropzone-inner">
          <Icon d={ICONS.upload} size={22} />
          <b>Drop to attach</b>
          <small>Images and text files · up to 4</small>
        </div>
      </div>
    </div>
  );
}

render(<App />, app);
