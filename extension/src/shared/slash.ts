// Composer slash commands: the command table plus the pure parse/match
// helpers shared by the panel UI and its tests.
//
// A message whose first word is a known `/command` is intercepted before it
// can become an agent task; anything else (including unknown `/words`) is
// sent as ordinary task text.

export interface SlashCommand {
  /** Command word without the slash. */
  name: string;
  /** Argument placeholder shown in the autocomplete row, if any. */
  hint?: string;
  description: string;
  /**
   * Command wants an argument: autocomplete inserts "/name " and waits
   * instead of firing immediately (execution with an empty arg is still
   * defined per command — e.g. /model opens the picker).
   */
  takesArg: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", description: "Start a new chat", takesArg: false },
  {
    name: "model",
    hint: "[name]",
    description: "Pick a model — with a name, switch straight to it",
    takesArg: true,
  },
  { name: "sessions", description: "Browse and reopen past sessions", takesArg: false },
  {
    name: "rename",
    hint: "<title>",
    description: "Rename the current session",
    takesArg: true,
  },
];

export interface SlashParse {
  /** Command word, lowercased, without the slash. */
  command: string;
  /** Everything after the first space, trimmed ("" when absent). */
  arg: string;
  /** Whether `command` is one of SLASH_COMMANDS. */
  known: boolean;
}

/**
 * Parse composer text as a slash command. Returns null when the text is not
 * command-shaped (no leading "/"). Unknown commands still parse — callers
 * decide whether to execute (known) or fall through to a normal task send.
 */
export function parseSlash(text: string): SlashParse | null {
  const t = text.trimStart();
  if (!t.startsWith("/")) return null;
  const m = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return null;
  const command = (m[1] ?? "").toLowerCase();
  const arg = (m[2] ?? "").trim();
  return { command, arg, known: SLASH_COMMANDS.some((c) => c.name === command) };
}

/**
 * Autocomplete candidates while the command word is being typed. Returns []
 * once the text contains a space (the user is writing the argument or an
 * ordinary message) or when nothing matches.
 */
export function matchSlash(typed: string): SlashCommand[] {
  const t = typed.trimStart();
  if (!t.startsWith("/") || /\s/.test(t)) return [];
  const q = t.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}
