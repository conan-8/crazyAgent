// Mutating-tool classification (consumed by the Jev risk gate) and token math
// for the live stats bar. Pure — unit-tested.

/** Tools that change page state — the Jev gate double-checks these. */
export const MUTATING_TOOLS = new Set([
  "click",
  "click_at",
  "type_at",
  "input_sequence",
  "drag_at",
  "type",
  "upload",
  "paste_image",
  "select",
  "key",
  "download",
  "evaluate_js",
  "network_mock",
  "network_rewrite",
  // Label-walked menu paths and the deterministic Docs operations click real
  // controls, so they gate exactly like any other action.
  "menu_path",
  "docs_op",
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
