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
  type StepEvent,
  type SwToPanel,
} from "../shared/protocol";
import {
  foldEvent,
  foldUser,
  newConversation,
  type ChatBlock,
  type ChatTurn,
  type ToolCard,
} from "../shared/chat";
import {
  AGENT_MODES,
  formatElapsed,
  formatTokens,
  type AgentMode,
} from "../shared/modes";
import { THINKING_LEVELS } from "../shared/llm";
import { madmanExclamation } from "../shared/madman";
import {
  JEV_TRANSPORT_DEFAULTS,
  JEV_TRANSPORT_OPTIONS,
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
const listeners = new Set<(e: StepEvent) => void>();
let currentConv: Conversation | null = null;

let postPort: ((req: PortRequest) => void) | null = null;
const toolWaiters = new Map<
  string,
  (msg: { ok: boolean; payload?: unknown; error?: string }) => void
>();

function runTool(
  name: string,
  args: Record<string, unknown> = {},
  tabId?: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!postPort) {
      reject(new Error("port not connected"));
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    toolWaiters.set(id, (m) =>
      m.ok ? resolve(m.payload) : reject(new Error(m.error ?? "tool failed")),
    );
    postPort({ kind: "run_tool", id, name, args, tabId });
  });
}

function newLocalConversation(task: string): Conversation {
  const conv = newConversation(crypto.randomUUID(), task);
  currentConv = conv;
  return conv;
}

// ------------------------------ primitives ------------------------------

/** Brand mark: a glossy sphere whose colour field rotates (faster while working). */
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

function Aurora() {
  return (
    <div class="aurora" aria-hidden="true">
      <span class="blob blob-1" />
      <span class="blob blob-2" />
      <span class="blob blob-3" />
      <span class="grain" />
    </div>
  );
}

// ------------------------------ blocks ------------------------------

function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div
      class={`md${streaming ? " is-streaming" : ""}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
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
  evaluate_js: { icon: ICONS.code, done: "Evaluated", active: "Evaluating" },
  network_mock: { icon: ICONS.activity, done: "Mocked", active: "Mocking" },
  network_rewrite: { icon: ICONS.activity, done: "Rewrote", active: "Rewriting" },
  network_observe: { icon: ICONS.activity, done: "Observed", active: "Observing" },
  network_clear: { icon: ICONS.activity, done: "Cleared rules", active: "Clearing rules" },
  tabs_list: { icon: ICONS.window, done: "Listed tabs", active: "Listing tabs" },
  tabs_create: { icon: ICONS.window, done: "Opened tab", active: "Opening tab" },
  tabs_switch: { icon: ICONS.window, done: "Switched tab", active: "Switching tab" },
  tabs_close: { icon: ICONS.window, done: "Closed tab", active: "Closing tab" },
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
  const meta = TOOL_META[card.name];
  const state: ToolState = card.filled ? (card.ok ? "ok" : "err") : active ? "run" : "idle";
  const preview = useMemo(() => argPreview(card.args), [card.args]);
  const toggle = () => setOpen(!open);
  return (
    <div class={`card card-${state}${open ? " is-open" : ""}`}>
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
            <span class="tool-chip">{card.label ?? card.name}</span>
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
        <span class="chev">
          <Icon d={ICONS.chevron} size={12} />
        </span>
      </div>
      <Collapse open={open}>
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
      </Collapse>
    </div>
  );
}

/**
 * Model reasoning ("thinking"). Collapsed by default and auto-opened while it
 * is still streaming, so long reasoning never pushes the answer off-screen.
 */
function ReasoningBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const expanded = touched ? open : live;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
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
        <div class="reasoning-body">{text.trim()}</div>
      </Collapse>
    </div>
  );
}

function ConfirmCardView({
  id,
  tool,
  summary,
  onConfirm,
}: {
  id: string;
  tool: string;
  summary: string;
  onConfirm: (id: string, allow: boolean, always: boolean) => void;
}) {
  return (
    <div class="confirm-card" role="alertdialog" aria-label={`Allow ${tool}?`}>
      <div class="confirm-title">
        <span class="confirm-icon">
          <Icon d={ICONS.shield} size={14} />
        </span>
        <span>
          <span class="confirm-eyebrow">Needs your approval</span>
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
}: {
  tool: string;
  summary: string;
  decision?: Decision;
}) {
  const denied = decision === "deny";
  return (
    <div class={`card confirm-note${denied ? " is-denied" : ""}`} title={summary}>
      <div class="card-title">
        <span class="tool-icon note-icon">
          <Icon d={ICONS.shield} size={13} />
        </span>
        <span class="tool-text">
          <span class="tool-label">{decision ? DECISION_LABEL[decision] : "Approval"}</span>
          <span class="tool-chip">{tool}</span>
          <span class="tool-preview">{summary}</span>
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
}: {
  turn: ChatTurn;
  /** Last turn of the thread (confirm cards stay actionable). */
  live: boolean;
  /** This turn is being produced right now (spinners, caret, shimmer). */
  active: boolean;
  onZoom: (src: string) => void;
  onConfirm: (id: string, allow: boolean, always: boolean) => void;
  resolved: Map<string, Decision>;
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

  const answer = turn.blocks
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
              onConfirm={onConfirm}
            />
          ) : (
            <ConfirmNote
              key={i}
              tool={block.confirm.tool}
              summary={block.confirm.summary}
              decision={resolved.get(block.confirm.id)}
            />
          );
        }
        if (block.kind === "reasoning") {
          return <ReasoningBlock key={i} text={block.text} live={active && i === lastIndex} />;
        }
        return <Markdown key={i} text={block.text} streaming={active && i === lastIndex} />;
      })}
    </div>
  );
}

/** What the agent is doing right now, derived from the newest block. */
function activityLabel(conv: Conversation | null): string {
  const turn = conv?.turns[conv.turns.length - 1];
  if (!turn || turn.role !== "assistant") return "Getting started";
  const last = turn.blocks[turn.blocks.length - 1];
  if (!last) return "Thinking";
  if (last.kind === "tool") {
    return last.card.filled ? "Deciding next step" : (TOOL_META[last.card.name]?.active ?? "Working");
  }
  if (last.kind === "confirm") return "Waiting for approval";
  if (last.kind === "reasoning") return "Thinking";
  return "Writing";
}

function WorkingIndicator({ label }: { label: string }) {
  return (
    <div class="typing" role="status">
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

const MODE_ICONS: Record<AgentMode, string> = {
  auto: ICONS.sparkles,
  plan: ICONS.map,
  build: ICONS.wrench,
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
              <Switch
                checked={s.sendScreenshots}
                onChange={(v) => set("sendScreenshots", v)}
                title="Send screenshots"
                hint="Let the model see the page, not just its text"
              />
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
                        ? "Any OpenAI-compatible /chat/completions endpoint — use OpenRouter with your OpenRouter key. One model round-trip per decision (slower than TypeSafe, and probabilities are model-estimated)"
                        : "TypeSafe's own decision API — calibrated probabilities, answers in milliseconds (needs a console.typesafe.ai key)"
                    }
                    value={s.jev.transport}
                    options={JEV_TRANSPORT_OPTIONS}
                    onChange={(t) => set("jev", switchJevTransport(s.jev, t))}
                  />
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
                    hint="Let Jev grade each task and lower reasoning effort on trivial ones (never raises it)"
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
                <p class="log-confirm" key={c.id}>
                  ⚠ {clockTime(c.at)} — {c.tool}: {c.summary}
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
  { icon: ICONS.doc, title: "Summarize this page", task: "Summarize the current page" },
  {
    icon: ICONS.tag,
    title: "Find the best deal",
    task: "Find the cheapest option on this page and add it to the cart",
  },
  {
    icon: ICONS.form,
    title: "Fill out a form",
    task: "Fill this form with my details and review before submitting",
  },
  { icon: ICONS.layers, title: "Digest my tabs", task: "Summarize my open tabs" },
];

function Welcome({ onPick }: { onPick: (task: string) => void }) {
  return (
    <div class="welcome">
      <div class="hero-orb">
        <span class="hero-halo" />
        <span class="hero-ring ring-1" />
        <span class="hero-ring ring-2" />
        <Orb size={60} />
      </div>
      <h2 class="welcome-title">
        What should I <span class="grad-text">do</span> for you?
      </h2>
      <p class="welcome-sub">I navigate, click, type and read pages in your browser — just describe the task.</p>
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
  const [coachStatus, setCoachStatus] = useState<CoachStatus>({ state: "idle" });
  const [lessonBadge, setLessonBadge] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Map<string, Decision>>(new Map());
  const [openMenu, setOpenMenu] = useState<"mode" | "model" | null>(null);
  const [settings, setSettingsState] = useState<AgentSettings | null>(null);
  const [attachments, setAttachments] = useState<RunAttachment[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelListState, setModelListState] = useState<"idle" | "loading" | "error">("idle");
  const [modelListError, setModelListError] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [dragging, setDragging] = useState(false);
  const modelCacheRef = useRef<{ signature: string; models: string[] } | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const runStartRef = useRef(0);
  const dragDepth = useRef(0);
  const { scrollRef, contentRef, atBottom, scrollToBottom } = useStickToBottom<
    HTMLElement,
    HTMLDivElement
  >(running);
  const inputRef = useAutosize(taskText);

  const bump = () => setTick((t) => t + 1);
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
          eventBuffer.push(msg.event);
          if (msg.event.kind === "usage") {
            setUsage({
              totalTokens: msg.event.totalTokens,
              outputTokens: msg.event.outputTokens,
              tokensPerSec: msg.event.tokensPerSec,
              contextTokens: msg.event.contextTokens,
              contextWindow: msg.event.contextWindow,
              elapsedMs: msg.event.elapsedMs,
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
            });
            if (currentConv) foldEvent(currentConv, msg.event);
          } else if (currentConv) {
            foldEvent(currentConv, msg.event);
          }
          for (const listener of listeners) listener(msg.event);
          if (msg.event.kind === "done") setRunning(false);
          bump();
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
    };
    connectPort();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      postPort = null;
      portRef.current?.disconnect();
    };
  }, []);

  // Keepalive ping + run timer.
  useEffect(() => {
    if (!running) return;
    runStartRef.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      setPings((p) => p + 1);
      setElapsed(Date.now() - runStartRef.current);
      postPort?.({ kind: "ping" });
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (viewer) setViewer(null);
      else if (openMenu) setOpenMenu(null);
      else if (showSettings) setShowSettings(false);
      else if (showHistory) setShowHistory(false);
      else if (showLogs) setShowLogs(false);
      else if (showLessons) setShowLessons(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewer, openMenu, showSettings, showHistory, showLogs, showLessons]);

  // Accepts real-agent runs (string) and Phase 1 demo runs (demo object).
  const startRun = (
    taskOrDemo: string | DemoConfig,
    demoOrConvId?: DemoConfig | string,
  ) => {
    const isDemo = typeof taskOrDemo !== "string";
    eventBuffer.length = 0;
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
    });
  };

  const stop = () => postPort?.({ kind: "stop" });

  const resolveConfirm = (id: string, allow: boolean, always: boolean) => {
    setResolved((prev) => new Map(prev).set(id, !allow ? "deny" : always ? "always" : "once"));
    postPort?.({ kind: "confirm.resolve", id, allow, always });
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

  const newChat = () => {
    currentConv = null;
    setConv(null);
    setTaskText("");
    setShowHistory(false);
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
    state: () => ({ running, pings, swStartedAt, checkpoint }),
    events: () => [...eventBuffer],
    swPing: () => chrome.runtime.sendMessage({ type: "ping" }),
    queryState: () => chrome.runtime.sendMessage({ type: "state" }),
    onEvent: (cb: (e: StepEvent) => void) => listeners.add(cb),
    suspendKeepalive: () => postPort?.({ kind: "test_suspend" }),
    resolveConfirm,
    getSettings: () => loadSettings(),
    setSettings: (s: AgentSettings) => saveSettings(s).then(refreshSettings),
    // chat/history surface
    currentConversation: () => (currentConv ? structuredClone(currentConv) : null),
    conversations: () =>
      chrome.storage.local
        .get("baConversations")
        .then((r) => (r.baConversations as Conversation[]) ?? []),
    openConversation,
    deleteConversation,
    newChat,
    // run-log surface (timestamped per-turn chat + tool archive)
    logs: () =>
      chrome.storage.local
        .get("baRunLogs")
        .then((r) => (r.baRunLogs as LogTurnRecord[]) ?? []),
    logsUI: () => ({ open: showLogs, detail: logDetail?.id ?? null }),
    lessons: () =>
      chrome.storage.local
        .get("baLessons")
        .then((r) => (r.baLessons as Lesson[] | undefined) ?? []),
    lessonsUI: () => ({ open: showLessons, status: coachStatus, badge: lessonBadge }),
    reviewLessons,
    // control bar surface
    usage: () => usage,
    addAttachment: (a: RunAttachment) => setAttachments((prev) => [...prev, a].slice(0, 4)),
    attachments: () => attachments,
  };

  const sendTask = () => {
    const task = taskText.trim();
    if ((!task && !attachments.length) || running) return;
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

  const agentMode = settings?.agentMode ?? "auto";
  const modeLabel = AGENT_MODES[agentMode]?.label ?? "Auto";
  const modelLabel = settings?.model ?? "model";
  const lastTurnIndex = conv ? conv.turns.length - 1 : -1;
  const ctxWindow = usage?.contextWindow ?? settings?.contextWindow ?? 128_000;
  const ctxRatio = Math.min(1, (usage?.contextTokens ?? 0) / Math.max(1, ctxWindow));
  const filteredModels = modelFilter.trim()
    ? modelList.filter((m) => m.toLowerCase().includes(modelFilter.trim().toLowerCase()))
    : modelList;
  const canSend = Boolean(taskText.trim() || attachments.length);

  return (
    <div class={`shell${running ? " is-running" : ""}${conv ? " has-conv" : ""}`} {...dragHandlers}>
      <Aurora />

      <header class="topbar">
        <div class="brand">
          <Orb size={24} active={running} />
          <div class="brand-text">
            <span class="brand-name">crazyAgent</span>
            <span class="brand-sub" key={running ? "run" : "idle"}>
              {running ? (
                <span class="shimmer-text">Working · {formatElapsed(elapsed)}</span>
              ) : (
                <>
                  <span class="live-dot idle" />
                  Ready · {modeLabel}
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
        <span class="run-progress" aria-hidden="true" />
      </header>

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
                />
              ))
            )}
            {running ? <WorkingIndicator label={activityLabel(conv)} /> : null}
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

        <div class={`composer${running ? " is-running" : ""}`}>
          <span class="composer-glow" aria-hidden="true" />
          <textarea
            ref={inputRef}
            class="task-input"
            rows={1}
            placeholder={running ? "Working on it…" : "Ask crazyAgent to do anything on the web…"}
            value={taskText}
            disabled={running}
            onInput={(e) => setTaskText((e.target as HTMLTextAreaElement).value)}
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files?.length) {
                e.preventDefault();
                onFiles(files);
              }
            }}
            onKeyDown={(e) => {
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
              label={modeLabel}
              icon={MODE_ICONS[agentMode] ?? ICONS.sparkles}
              open={openMenu === "mode"}
              onToggle={() => setOpenMenu(openMenu === "mode" ? null : "mode")}
            >
              <div class="menu-head">Agent mode</div>
              {(Object.keys(AGENT_MODES) as AgentMode[]).map((m) => (
                <MenuItem
                  key={m}
                  active={agentMode === m}
                  icon={MODE_ICONS[m]}
                  title={AGENT_MODES[m].label}
                  hint={AGENT_MODES[m].hint}
                  onClick={() => pickSetting("agentMode", m)}
                />
              ))}
            </Popover>

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
              <span class="stat stat-tps">
                <Icon d={ICONS.bolt} size={11} /> {(usage?.tokensPerSec ?? 0).toFixed(1)} tok/s
              </span>
              <span class="stat stat-ctx" title="Context used">
                ctx {formatTokens(usage?.contextTokens ?? 0)}/{formatTokens(ctxWindow)}
                <span class="meter">
                  <span style={`transform:scaleX(${ctxRatio})`} />
                </span>
              </span>
            </>
          ) : (
            <>
              <span class="stat">
                <kbd>↵</kbd> run <kbd>⇧↵</kbd> newline
              </span>
              {usage ? (
                <span class="stat stat-last" title={lastRunTitle(usage)}>
                  last run {formatElapsed(usage.elapsedMs ?? 0)} ·{" "}
                  {formatTokens(usage.totalTokens)} tok ·{" "}
                  {(usage.tokensPerSec ?? 0).toFixed(1)} tok/s
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
