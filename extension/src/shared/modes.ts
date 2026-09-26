// Agent run preferences: modes (what the agent may do) and token math for the
// live stats bar. Pure — unit-tested.
//
// There is deliberately no effort/step-cap preset: the agent runs for as many
// steps as the task needs, stopping only when it answers, the user stops it,
// or an error aborts the run.

export type AgentMode = "auto" | "plan" | "build";

export const AGENT_MODES: Record<
  AgentMode,
  { label: string; hint: string }
> = {
  auto: { label: "Auto", hint: "Decide per step: answer or act" },
  plan: { label: "Plan", hint: "Read-only research, then a plan" },
  build: { label: "Build", hint: "Carry the task through to done" },
};

/** Tools that change page state — blocked in Plan mode. */
export const MUTATING_TOOLS = new Set([
  "click",
  "click_at",
  "drag_at",
  "type",
  "upload",
  "select",
  "key",
  "download",
  "evaluate_js",
  "network_mock",
  "network_rewrite",
]);

export function isMutating(tool: string): boolean {
  return MUTATING_TOOLS.has(tool);
}

/** Cheap token estimate (chars/4) — real usage replaces it when reported. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
