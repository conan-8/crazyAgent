// Step expectations — the model (or, later, a compiled `run_program`) declares
// what SUCCESS looks like for one action, and the harness answers with a
// deterministic check instead of leaving the model to squint at a screenshot.
//
// Priced from the 2026-10-06 field runs: `docs_op` was the only tool that
// verified its own effect (export needle / toolbar style / dialog closed) and
// the difference showed — its insert_table printed NOT VERIFIED twice and then
// `verified:` on the third try, while everything else was checked by eye five
// turns later ("Title style didn't apply (toolbar still shows Normal text)",
// "paste didn't land", "table text didn't land", "fill didn't apply"). This
// module is the vocabulary the rest of the harness can share: pure parsing,
// describing and gate decisions; the IO half lives in background/tools/expect.ts.
import { failureTag } from "./tool-failure";

/**
 * What one action promises. Every field is optional; an empty object means "no
 * promise" (do not check).
 */
export interface StepExpect {
  /** The exported document HTML must contain this text (Workspace docs). */
  export_contains?: string;
  /** The toolbar paragraph-style box must read this (canvas editors). */
  toolbar_style?: string;
  /** A [role="dialog"] must be present ("open") or gone ("closed"). */
  dialog?: "open" | "closed";
  /** The page text / snapshot taken after the action must contain this. */
  text_landed?: string;
  /** Whether the frame must have changed: true = must, false = must not. */
  pixel_changed?: boolean;
}

export const EXPECT_KEYS = [
  "export_contains",
  "toolbar_style",
  "dialog",
  "text_landed",
  "pixel_changed",
] as const;

export type ExpectParse =
  | { ok: true; expect?: StepExpect }
  | { ok: false; error: string };

const SHAPE_HINT =
  'expect must be an object like {"export_contains":"<table"}, {"toolbar_style":"Heading 1"}, ' +
  '{"dialog":"closed"}, {"text_landed":"Feature Test Document"} or {"pixel_changed":true}';

/**
 * Validate one `expect` argument. Unknown keys are rejected (with the list of
 * real ones) rather than ignored: a typo'd expectation that silently does
 * nothing is worse than no expectation at all.
 */
export function parseExpect(raw: unknown): ExpectParse {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${failureTag("input")}: ${SHAPE_HINT}` };
  }
  const o = raw as Record<string, unknown>;
  const expect: StepExpect = {};
  for (const [key, value] of Object.entries(o)) {
    if (value === undefined || value === null || value === "") continue;
    // A whitespace-only needle would match everything — treat it as absent
    // rather than as a promise the check cannot honestly keep.
    if (typeof value === "string" && !value.trim()) continue;
    switch (key) {
      case "export_contains":
      case "toolbar_style":
      case "text_landed": {
        if (typeof value !== "string") {
          return { ok: false, error: `${failureTag("input")}: expect.${key} must be a string` };
        }
        expect[key] = value;
        break;
      }
      case "dialog": {
        if (value !== "open" && value !== "closed") {
          return {
            ok: false,
            error: `${failureTag("input")}: expect.dialog must be "open" or "closed"`,
          };
        }
        expect.dialog = value;
        break;
      }
      case "pixel_changed": {
        if (typeof value !== "boolean") {
          return { ok: false, error: `${failureTag("input")}: expect.pixel_changed must be true or false` };
        }
        expect.pixel_changed = value;
        break;
      }
      default: {
        return {
          ok: false,
          error: `${failureTag("input")}: unknown expect key "${key}" — valid keys: ${EXPECT_KEYS.join(", ")}. ${SHAPE_HINT}`,
        };
      }
    }
  }
  return Object.keys(expect).length ? { ok: true, expect } : { ok: true };
}

/** How many checks an expectation asks for (callers can skip the IO when 0). */
export function expectCheckCount(expect: StepExpect | undefined): number {
  return expect ? Object.keys(expect).length : 0;
}

/** Whether evaluating this expectation needs the Workspace export (slow, and
 *  only meaningful on a document/sheet/slides tab). */
export function expectNeedsWorkspaceExport(expect: StepExpect | undefined): boolean {
  return expect?.export_contains !== undefined || expect?.toolbar_style !== undefined;
}

/** The model-facing description of what was promised ("export contains \"<table\""). */
export function describeExpect(expect: StepExpect): string[] {
  const parts: string[] = [];
  if (expect.export_contains !== undefined) {
    parts.push(`the exported HTML contains "${expect.export_contains}"`);
  }
  if (expect.toolbar_style !== undefined) {
    parts.push(`the toolbar style box reads "${expect.toolbar_style}"`);
  }
  if (expect.dialog !== undefined) {
    parts.push(`the dialog is ${expect.dialog}`);
  }
  if (expect.text_landed !== undefined) {
    parts.push(`the page text contains "${expect.text_landed}"`);
  }
  if (expect.pixel_changed !== undefined) {
    parts.push(expect.pixel_changed ? "the frame visibly changed" : "the frame did NOT change");
  }
  return parts;
}

/**
 * The JSON-schema fragment action tools spread into their parameters. Kept
 * compact on purpose: tool specs ride the cached prefix of EVERY request, so
 * the vocabulary is named once here and the long-form explanation lives in
 * docs/DEV.md.
 */
export const EXPECT_PROP = {
  expect: {
    type: "object",
    description:
      "Declare what success looks like; the harness checks it right after the action settles and reports verified:/NOT VERIFIED: in this result (no follow-up verification turn). Keys: export_contains (Workspace export HTML), toolbar_style, dialog ('open'|'closed'), text_landed, pixel_changed (bool).",
    properties: {
      export_contains: { type: "string", description: "The exported document HTML must contain this" },
      toolbar_style: { type: "string", description: "The toolbar paragraph-style box must read this" },
      dialog: { type: "string", enum: ["open", "closed"], description: "A dialog must be present/gone" },
      text_landed: { type: "string", description: "The page text must contain this" },
      pixel_changed: { type: "boolean", description: "true = the frame must change, false = must not" },
    },
  },
} as const;

/** One-line "expected X" for the result text. */
export function describeExpectLine(expect: StepExpect): string {
  return describeExpect(expect).join("; ");
}