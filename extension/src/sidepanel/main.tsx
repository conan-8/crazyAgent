// Side panel — chat interface with a full control bar (mode / model,
// live run stats, attachments). Assistant turns are ordered blocks: tool
// activity streams in, the rendered-markdown answer lands below it. Threads
// persist to history with multi-turn context.
// Test hooks stay on window.__ba (phase smokes rely on the stable surface).
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  PORT_NAME,
  type Checkpoint,
  type Conversation,
  type ConversationSummary,
  type DemoConfig,
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
} from "../background/settings";

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

// ------------------------------ icons ------------------------------

function Icon({ children, size = 14 }: { children: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={children} />
    </svg>
  );
}
const ICONS = {
  send: "M12 19V5M5 12l7-7 7 7",
  plus: "M12 5v14M5 12h14",
  history: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  gear: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  close: "M18 6 6 18M6 6l12 12",
  chevron: "M6 9l6 6 6-6",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z",
  tool: "M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4z",
  check: "M20 6 9 17l-5-5",
  warn: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  stop: "M7 7h10v10H7z",
  clip: "M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.18 5.18L9.63 17.6a1.83 1.83 0 0 1-2.59-2.59l8.49-8.48",
  mode: "M4 6h16M4 12h10M4 18h7",
  chip: "M4 4h16v16H4zM9 9h6v6H9z",
  gauge: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 7v5l3 3",
  brain: "M12 5a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 6 0v-1a3 3 0 0 0 0-6V8a3 3 0 0 0-3-3z",
};

// ------------------------------ blocks ------------------------------

function Markdown({ text }: { text: string }) {
  return (
    <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
  );
}

// Reference-style human labels for activity rows.
const TOOL_LABELS: Record<string, string> = {
  navigate: "Navigated",
  screenshot: "Captured",
  read_page: "Read",
  snapshot: "Inspected",
  wait_for_settle: "Waited",
  click: "Clicked",
  type: "Typed",
  select: "Selected",
  key: "Pressed",
  hover: "Hovered",
  scroll: "Scrolled",
  reload: "Reloaded",
  download: "Downloaded",
  evaluate_js: "Evaluated",
  network_mock: "Mocked",
  network_rewrite: "Rewrote",
  network_observe: "Observed",
};

function ToolRow({ card, onZoom }: { card: ToolCard; onZoom: (src: string) => void }) {
  const status = !card.filled ? "…" : card.ok ? "✓" : "✗";
  return (
    <details class={`card ${card.filled && !card.ok ? "card-err" : ""}`}>
      <summary class="card-title">
        <span class="tool-name">
          <Icon size={12}>{ICONS.tool}</Icon>
          {TOOL_LABELS[card.name] ?? "Ran"}
          <span class="tool-chip">{card.name}</span>
        </span>
        <span class={`tool-badge ${card.filled ? (card.ok ? "ok" : "err") : ""}`}>
          {status}
        </span>
      </summary>
      <div class="card-body">{card.args}</div>
      {card.result ? <div class="card-body card-result">{card.result}</div> : null}
      {card.image ? (
        <img class="thumb" src={card.image} onClick={() => onZoom(card.image!)} />
      ) : null}
    </details>
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
    <div class="reasoning">
      <button
        class="reasoning-head"
        onClick={() => {
          setTouched(true);
          setOpen(!expanded);
        }}
        aria-expanded={expanded}
      >
        <Icon size={11}>{ICONS.brain}</Icon>
        <span>{live ? "Thinking…" : "Thought"}</span>
        <span class="reasoning-meta">
          {words} words
          <span class={`chev ${expanded ? "chev-open" : ""}`}>
            <Icon size={10}>{ICONS.chevron}</Icon>
          </span>
        </span>
      </button>
      {expanded ? <div class="reasoning-body">{text.trim()}</div> : null}
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
    <div class="confirm-card">
      <div class="confirm-title">
        <Icon>{ICONS.warn}</Icon> {tool}
      </div>
      <div class="confirm-summary">{summary}</div>
      <div class="row confirm-actions">
        <button class="btn-primary" onClick={() => onConfirm(id, true, false)}>
          Allow once
        </button>
        <button onClick={() => onConfirm(id, true, true)}>Always allow</button>
        <button class="btn-danger" onClick={() => onConfirm(id, false, false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  live,
  onZoom,
  onConfirm,
  resolved,
}: {
  turn: ChatTurn;
  live: boolean;
  onZoom: (src: string) => void;
  onConfirm: (id: string, allow: boolean, always: boolean) => void;
  resolved: Set<string>;
}) {
  if (turn.role === "user") {
    return (
      <div class="bubble bubble-user">
        {turn.text}
        {turn.attachments?.length ? (
          <div class="attach-strip">
            {turn.attachments.map((a) => (
              <span key={a.name} class="attach-chip">
                <Icon size={10}>{ICONS.clip}</Icon>
                {a.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div class="bubble bubble-assistant">
      <div class="assistant-badge">
        <span class="spark">
          <Icon size={11}>{ICONS.spark}</Icon>
        </span>
        Agent
      </div>
      {turn.blocks.map((block: ChatBlock, i: number) => {
        if (block.kind === "tool") {
          return <ToolRow key={i} card={block.card} onZoom={onZoom} />;
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
            <div key={i} class="confirm-note">
              <Icon size={11}>{ICONS.check}</Icon> {block.confirm.tool} — {block.confirm.summary}
            </div>
          );
        }
        if (block.kind === "reasoning") {
          return <ReasoningBlock key={i} text={block.text} live={live} />;
        }
        return <Markdown key={i} text={block.text} />;
      })}
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
  children: preact.ComponentChildren;
}) {
  return (
    <span class={`pop ${right ? "pop-right" : ""}`}>
      <button class={`chip-btn ${open ? "chip-open" : ""}`} onClick={onToggle}>
        <Icon size={12}>{icon}</Icon>
        <span class="chip-label">{label}</span>
        <span class="chev">
          <Icon size={10}>{ICONS.chevron}</Icon>
        </span>
      </button>
      {open ? <div class="menu">{children}</div> : null}
    </span>
  );
}

function MenuItem({
  active,
  title,
  hint,
  onClick,
}: {
  active: boolean;
  title: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button class={`menu-item ${active ? "menu-active" : ""}`} onClick={onClick}>
      <span class="menu-title">
        {active ? <Icon size={11}>{ICONS.check}</Icon> : <span class="menu-dot" />}
        {title}
      </span>
      {hint ? <span class="menu-hint">{hint}</span> : null}
    </button>
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
          No connections saved yet — add one to pick a provider, endpoint and model.
        </p>
      ) : null}
      {keys.map((k) => {
        const active = k.id === activeId;
        // The active row is always open; others open on demand.
        const open = active || expanded.has(k.id);
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
              </label>
              <button
                class="key-label-btn"
                onClick={() => toggleIn(setExpanded, k.id)}
                title={open ? "Collapse" : "Expand"}
              >
                <span class={`chev ${open ? "chev-open" : ""}`}>
                  <Icon size={10}>{ICONS.chevron}</Icon>
                </span>
                {k.label || "(unnamed)"}
                <span class="key-summary">
                  {k.provider === "anthropic" ? "Anthropic" : "OpenAI-compat"} ·{" "}
                  {k.model || "no model"}
                </span>
              </button>
              <div class="key-actions">
                <button
                  class="btn-icon"
                  onClick={() => remove(k.id)}
                  title="Delete connection"
                >
                  <Icon size={12}>{ICONS.trash}</Icon>
                </button>
              </div>
            </div>
            {open ? (
              <div class="key-body">
                <label class="key-field">
                  <span>Label</span>
                  <input
                    value={k.label}
                    placeholder="e.g. work / openrouter"
                    onInput={(e) => patch(k.id, "label", (e.target as HTMLInputElement).value)}
                  />
                </label>
                <label class="key-field">
                  <span>API key</span>
                  <input
                    type={revealed.has(k.id) ? "text" : "password"}
                    value={k.key}
                    placeholder="sk-…"
                    onInput={(e) => patch(k.id, "key", (e.target as HTMLInputElement).value)}
                  />
                </label>
                <div class="key-field-inline">
                  <span class="key-mask">{maskKey(k.key)}</span>
                  <button
                    class="btn-icon"
                    onClick={() => toggleIn(setRevealed, k.id)}
                    title={revealed.has(k.id) ? "Hide" : "Reveal"}
                  >
                    {revealed.has(k.id) ? "🙈" : "👁"}
                  </button>
                </div>
                <label class="key-field">
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
                <label class="key-field">
                  <span>Base URL</span>
                  <input
                    value={k.baseUrl}
                    placeholder="https://api.openai.com/v1"
                    onInput={(e) => patch(k.id, "baseUrl", (e.target as HTMLInputElement).value)}
                  />
                </label>
                <label class="key-field">
                  <span>Model</span>
                  <input
                    value={k.model}
                    placeholder="gpt-4o-mini"
                    onInput={(e) => patch(k.id, "model", (e.target as HTMLInputElement).value)}
                  />
                </label>
              </div>
            ) : null}
          </div>
        );
      })}
      <button class="btn-ghost keys-add" onClick={add}>
        <Icon size={12}>{ICONS.plus}</Icon> Add connection
      </button>
    </div>
  );
}

function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<AgentSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void loadSettings().then(setS);
  }, []);
  if (!s) return <div class="drawer">loading…</div>;
  const set = <K extends keyof AgentSettings>(k: K, v: AgentSettings[K]) => {
    // Functional update: multiple field edits batch correctly.
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));
    setSaved(false);
  };
  return (
    <div class="drawer">
      <div class="row spread">
        <h2>Settings</h2>
        <button class="btn-icon" onClick={onClose} title="Close">
          <Icon>{ICONS.close}</Icon>
        </button>
      </div>
      <label>Connections</label>
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
      <label>Control transport</label>
      <select
        value={s.mode}
        onChange={(e) =>
          set("mode", (e.target as HTMLSelectElement).value as AgentSettings["mode"])
        }
      >
        <option value="standard">Standard (chrome.debugger)</option>
        <option value="unlimited">Unlimited (helper daemon)</option>
      </select>
      <label>Context window (tokens)</label>
      <input
        type="number"
        value={String(s.contextWindow)}
        onInput={(e) => set("contextWindow", Number((e.target as HTMLInputElement).value) || 128000)}
      />
      <label>Max output tokens per call</label>
      <input
        type="number"
        value={String(s.maxTokens)}
        onInput={(e) => set("maxTokens", Number((e.target as HTMLInputElement).value) || 8192)}
      />
      <label>CDP port (Unlimited mode)</label>
      <input
        type="number"
        value={String(s.cdpPort)}
        onInput={(e) => set("cdpPort", Number((e.target as HTMLInputElement).value) || 9222)}
      />
      <label class="inline">
        <input
          type="checkbox"
          checked={s.sendScreenshots}
          onChange={(e) => set("sendScreenshots", (e.target as HTMLInputElement).checked)}
        />
        Send screenshots to the model
      </label>
      <label class="inline">
        <input
          type="checkbox"
          checked={s.thinking}
          onChange={(e) => set("thinking", (e.target as HTMLInputElement).checked)}
        />
        Thinking / reasoning (slower, better on hard tasks)
      </label>
      {s.thinking ? (
        <>
          <label>Thinking budget (tokens)</label>
          <input
            type="number"
            value={String(s.thinkingBudget)}
            onInput={(e) =>
              set("thinkingBudget", Number((e.target as HTMLInputElement).value) || 2048)
            }
          />
        </>
      ) : null}
      <div class="row">
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
        {saved ? <span class="hint">saved — effective on next run</span> : null}
      </div>
    </div>
  );
}

// ------------------------------ app ------------------------------

const SUGGESTIONS = [
  "Summarize the current page",
  "Find the cheapest option on this page and add it to the cart",
  "Fill this form with my details and review before submitting",
];

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
  const [viewer, setViewer] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<"mode" | "model" | null>(null);
  const [settings, setSettingsState] = useState<AgentSettings | null>(null);
  const [attachments, setAttachments] = useState<RunAttachment[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelListState, setModelListState] = useState<"idle" | "loading" | "error">("idle");
  const [modelListError, setModelListError] = useState("");
  const modelCacheRef = useRef<{ signature: string; models: string[] } | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const runStartRef = useRef(0);

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

  // Auto-scroll the transcript to the newest content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  });

  // Accepts real-agent runs (string) and Phase 1 demo runs (demo object).
  const startRun = (
    taskOrDemo: string | DemoConfig,
    demoOrConvId?: DemoConfig | string,
  ) => {
    const isDemo = typeof taskOrDemo !== "string";
    eventBuffer.length = 0;
    setRunning(true);
    setUsage(null);
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
    setResolved((prev) => new Set(prev).add(id));
    postPort?.({ kind: "confirm.resolve", id, allow, always });
  };

  const openHistory = () => {
    setShowHistory(true);
    postPort?.({ kind: "history.list" });
  };

  const openConversation = (id: string) =>
    postPort?.({ kind: "history.get", conversationId: id });

  const deleteConversation = (id: string) =>
    postPort?.({ kind: "history.delete", conversationId: id });

  const newChat = () => {
    currentConv = null;
    setConv(null);
    setTaskText("");
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

  const modeLabel = AGENT_MODES[settings?.agentMode ?? "auto"]?.label ?? "Auto";
  const modelLabel = settings?.model ?? "model";
  const streaming =
    running &&
    conv &&
    conv.turns.length > 0 &&
    conv.turns[conv.turns.length - 1]?.role === "assistant";

  return (
    <div class="shell">
      <header class="topbar">
        <nav class="row topbar-actions">
          <button class="btn-ghost" onClick={newChat} title="New chat">
            <Icon>{ICONS.plus}</Icon> New chat
          </button>
          <button class="btn-ghost" onClick={openHistory} title="History">
            <Icon>{ICONS.history}</Icon> History
          </button>
          <button
            class="btn-icon"
            onClick={() => setShowSettings(!showSettings)}
            title="Settings"
          >
            ⚙
          </button>
        </nav>
      </header>

      {showSettings ? <SettingsDrawer onClose={() => setShowSettings(false)} /> : null}

      {showHistory ? (
        <div class="history-view">
          <div class="row spread">
            <h2>Chat history</h2>
            <button class="btn-icon" onClick={() => setShowHistory(false)}>
              <Icon>{ICONS.close}</Icon>
            </button>
          </div>
          {historyList.length === 0 ? (
            <p class="hint">no conversations yet</p>
          ) : (
            historyList.map((h) => (
              <div class="hist-row" key={h.id}>
                <button class="hist-item" onClick={() => openConversation(h.id)}>
                  <span class="hist-title">{h.title}</span>
                  <span class="hist-meta">
                    {new Date(h.updatedAt).toLocaleString()} · {h.turns} turns
                  </span>
                </button>
                <button
                  class="btn-icon hist-del"
                  onClick={() => deleteConversation(h.id)}
                  title="Delete"
                >
                  <Icon>{ICONS.trash}</Icon>
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}

      <main class="transcript" ref={scrollRef} onClick={onTranscriptClick}>
        {!conv ? (
          <div class="welcome">
            <div class="welcome-glow" />
            <span class="spark big">
              <Icon size={24}>{ICONS.spark}</Icon>
            </span>
            <h2>What should I do in your browser?</h2>
            <p class="hint">I can navigate, click, type, and read pages — just ask.</p>
            <div class="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} class="chip" onClick={() => setTaskText(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          conv.turns.map((turn, i) => (
            <TurnView
              key={i}
              turn={turn}
              live={running || i === conv.turns.length - 1}
              onZoom={(src) => setViewer(src)}
              onConfirm={resolveConfirm}
              resolved={resolved}
            />
          ))
        )}
        {streaming ? (
          <div class="typing">
            <span class="dot" />
            <span class="dot" />
            <span class="dot" />
          </div>
        ) : null}
      </main>

      <footer class="composer-wrap">
        {attachments.length ? (
          <div class="draft-strip">
            {attachments.map((a, i) => (
              <span key={`${a.name}-${i}`} class="attach-chip">
                <Icon size={10}>{ICONS.clip}</Icon>
                {a.name}
                <button
                  class="chip-x"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  <Icon size={9}>{ICONS.close}</Icon>
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div class="composer">
          <textarea
            class="task-input"
            rows={2}
            placeholder="Describe what to build"
            value={taskText}
            disabled={running}
            onInput={(e) => setTaskText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendTask();
              }
            }}
          />
          <div class="toolbar toolbar-1">
            <button
              class="btn-icon"
              title="Attach files"
              onClick={() => fileRef.current?.click()}
            >
              <Icon>{ICONS.plus}</Icon>
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
              icon={ICONS.mode}
              open={openMenu === "mode"}
              onToggle={() => setOpenMenu(openMenu === "mode" ? null : "mode")}
            >
              {(Object.keys(AGENT_MODES) as AgentMode[]).map((m) => (
                <MenuItem
                  key={m}
                  active={(settings?.agentMode ?? "auto") === m}
                  title={AGENT_MODES[m].label}
                  hint={AGENT_MODES[m].hint}
                  onClick={() => pickSetting("agentMode", m)}
                />
              ))}
            </Popover>

            <Popover
              label={modelLabel}
              icon={ICONS.chip}
              open={openMenu === "model"}
              onToggle={() => {
                const next = openMenu === "model" ? null : "model";
                setOpenMenu(next);
                if (next) void loadModels();
              }}
            >
              {modelListState === "loading" ? (
                <div class="menu-note">loading models for this key…</div>
              ) : modelListState === "error" ? (
                <div class="menu-note menu-error">{modelListError}</div>
              ) : (
                modelList.map((m) => (
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
            </Popover>
          </div>

          <div class="toolbar toolbar-2">
            <button
              class="btn-icon"
              title="Settings"
              onClick={() => setShowSettings(!showSettings)}
            >
              <Icon>{ICONS.gear}</Icon>
            </button>

            <span class="toolbar-spacer" />

            {running ? (
              <button class="btn-icon send stop" onClick={stop} title="Stop">
                <Icon>{ICONS.stop}</Icon>
                <span class="vh">Stop</span>
              </button>
            ) : (
              <button
                class="btn-icon send"
                onClick={sendTask}
                disabled={!taskText.trim() && !attachments.length}
                title="Run"
              >
                <Icon>{ICONS.send}</Icon>
                <span class="vh">Run</span>
              </button>
            )}
          </div>
        </div>

        <div class="status">
          {running ? (
            <>
              <span class="stat stat-timer">⏱ {formatElapsed(elapsed)}</span>
              <span class="sep">·</span>
              <span class="stat stat-tokens">
                △ {formatTokens(usage?.totalTokens ?? 0)} tok
              </span>
              <span class="sep">·</span>
              <span class="stat stat-tps">
                {(usage?.tokensPerSec ?? 0).toFixed(1)} tok/s
              </span>
              <span class="sep">·</span>
              <span class="stat stat-ctx">
                ctx {formatTokens(usage?.contextTokens ?? 0)}/
                {formatTokens(usage?.contextWindow ?? settings?.contextWindow ?? 128_000)}
              </span>
            </>
          ) : (
            <>
              <span class="live-dot idle" /> idle · {modeLabel} · unlimited steps
              {usage ? (
                <>
                  <span class="sep">·</span>
                  <span class="stat stat-last" title={lastRunTitle(usage)}>
                    last: {formatElapsed(usage.elapsedMs ?? 0)} ·{" "}
                    {formatTokens(usage.totalTokens)} tok ·{" "}
                    {(usage.tokensPerSec ?? 0).toFixed(1)} tok/s
                  </span>
                </>
              ) : null}
              {checkpoint && !checkpoint.done
                ? ` · checkpoint @ step ${checkpoint.stepIndex + 1}`
                : ""}
            </>
          )}
        </div>
      </footer>

      {viewer ? (
        <div class="viewer" onClick={() => setViewer(null)}>
          <img src={viewer} />
        </div>
      ) : null}
    </div>
  );
}

render(<App />, app);
