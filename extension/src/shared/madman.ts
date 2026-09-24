// Madman mode: the agent swears. Off by default; a single toggle in Settings
// turns the whole run profane. Pure — unit-tested, no chrome/DOM access.
//
// Two halves, deliberately kept apart:
//  - `madmanPromptSection()` is appended to the system prompt so the *model*
//    writes its replies and mid-run exclamations in character. This is the part
//    that produces the "Because this shit ass site is so fucking slow I have to
//    …" narration, so it has to be instruction, not string substitution.
//  - `madmanLabel()` / `madmanExclamation()` decorate tool calls
//    deterministically, so the panel shows a cuss on every card even when the
//    model forgets to swear.

/** Words safe to drop straight into a label or a sentence. */
export const MADMAN_WORDS = [
  "fuck",
  "shit",
  "damn",
  "hell",
  "ass",
  "bastard",
  "goddamn",
  "piss",
  "crap",
  "bloody",
  "sonofabitch",
  "dipshit",
] as const;

/**
 * The house style for mid-run exclamations. The `{action}` slot is what makes
 * the requested "Because this shit ass site is so fucking slow I have to …"
 * shape fall out naturally instead of being hard-coded per situation.
 */
export const MADMAN_EXCLAMATION_TEMPLATES = [
  "Because this shit ass site is so fucking slow I have to {action}.",
  "This goddamn page is fighting me, so I have to {action}.",
  "Holy shit, of course it broke — {action} like it's my fucking job.",
  "For fuck's sake, {action} — this site can go to hell.",
  "This absolute bastard of a page won't cooperate, so {action}.",
  "Christ on a bike, {action}. Every fucking time.",
] as const;

/** Deterministic string hash → 32-bit int (FNV-1a). */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pick a word from `MADMAN_WORDS` for a key. Stable per key: the same tool
 * call always gets the same word, so re-rendering a card never flickers.
 */
export function madmanWord(key: string): string {
  const words = MADMAN_WORDS;
  return words[hash(key) % words.length]!;
}

/**
 * Decorate a tool-call label with a cuss word — the "every tool call contains
 * a cuss word" requirement, enforced by us rather than hoped for from the
 * model. Idempotent: a label that already swears is left alone.
 */
export function madmanLabel(name: string, key?: string): string {
  const base = name.trim() || "tool";
  if (madmanHasProfanity(base)) return base;
  return `${base} (${madmanWord(key ?? base)})`;
}

/**
 * Build a mid-run exclamation. With an `action` this lands in the requested
 * "Because this shit ass site is so fucking slow I have to …" shape; without
 * one it degrades to a standalone outburst.
 */
export function madmanExclamation(action?: string, key?: string): string {
  const clean = action?.trim().replace(/[.!?]+$/, "");
  if (!clean) {
    const bare = [
      "This shit is taking forever.",
      "Fucking hell, this page.",
      "For fuck's sake.",
      "Goddamn it, of course.",
    ];
    return bare[hash(key ?? "bare") % bare.length]!;
  }
  const templates = MADMAN_EXCLAMATION_TEMPLATES;
  const tpl = templates[hash(key ?? clean) % templates.length]!;
  return tpl.replace("{action}", clean.toLowerCase());
}

/** Does this text already carry profanity? Cheap guard against double-dipping. */
export function madmanHasProfanity(text: string): boolean {
  const t = text.toLowerCase();
  return MADMAN_WORDS.some((w) => new RegExp(`\\b${w}`, "i").test(t));
}

/**
 * The Madman section of the system prompt. It is appended (not swapped in) so
 * every existing guarantee — the mandate, the style contract, plan-mode
 * read-only — survives untouched; only the voice changes.
 */
export const MADMAN_PROMPT = [
  "Madman mode — ON:",
  "- Voice: you are the user's foul-mouthed friend who is very good at this and completely out of patience. Swear freely — fuck, shit, damn, hell, ass, bastard, goddamn. Every tool call you narrate carries at least one curse word.",
  "- When something is slow, flaky, bloated, or fights back, say so in the middle of the run, out loud, in that voice — e.g. \"Because this shit ass site is so fucking slow I have to scroll the whole goddamn list manually.\" Exclaim it; do not bury it in a status line.",
  "- Keep every other rule: still ruthlessly concise, still no refusals, still plan mode is read-only. The swearing changes the tone, NOT the facts, the numbers, the links, or the answer.",
  "- Profanity is seasoning, not the meal: never let it replace information, and never swear *instead of* reporting a failure. If you are blocked, cuss AND say exactly what blocked you.",
  "- Do not apologize for the language, do not add a content note, do not offer a clean version. Just talk like that.",
].join("\n");

/** Compose the prompt suffix for madman on/off. Empty string when off. */
export function madmanPromptSection(enabled: boolean): string {
  return enabled ? MADMAN_PROMPT : "";
}