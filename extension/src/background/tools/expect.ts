// The IO half of step expectations: run the checks `shared/expect.ts` parsed,
// and answer with the same honest vocabulary `docs_op` already uses
// ("verified:" / "NOT VERIFIED:" / "unverified (…)") so a model that learned to
// read one op's result can read every action's.
//
// Every check is cheap and deterministic: the Workspace export HTML (cached by
// the browser, one fetch), the toolbar style box, a [role=dialog] presence
// test, the digest text already in hand, and the frame verdict the caller
// computed from the before/after captures.
import type { BrowserAdapter } from "../adapters/types";
import { describeExpect, type StepExpect } from "../../shared/expect";
import type { EffectVerdict } from "../../shared/frame-diff";
import { fetchWorkspaceExport } from "./docs";
import { runContentAction } from "./content-action";

/** Docs autosaves fast, but give the export a beat before reading it. */
const EXPORT_SETTLE_MS = 900;

/** The toolbar paragraph-style box, newest DOM first (the same selector list
 *  docs_op's own verification uses — two verifiers must not disagree). */
const STYLE_BOX_SELECTORS = [
  '[aria-label^="Styles"]',
  ".kix-paragraphstyles-combobox",
  '[role="combobox"][aria-label]',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ExpectContext {
  tabId: number;
  adapter: BrowserAdapter;
  expect: StepExpect;
  /** The digest taken after the action, when the page had one. */
  observationText?: string | null;
  /** The frame/digest verdict for this action, when one was computed. */
  verdict?: EffectVerdict | null;
}

/** True when the line reports a FAILED promise (callers may then repair). */
export function expectFailed(line: string | undefined): boolean {
  return typeof line === "string" && line.startsWith("NOT VERIFIED");
}

/**
 * Check one expectation. Returns undefined when there is nothing to check;
 * otherwise a `verified:` / `NOT VERIFIED:` / `unverified (…)` line naming the
 * promises that did and did not hold.
 */
export async function checkStepExpect(ctx: ExpectContext): Promise<string | undefined> {
  const { expect } = ctx;
  if (!expect || !Object.keys(expect).length) return undefined;
  const good: string[] = [];
  const bad: string[] = [];
  const unknown: string[] = [];
  const wants = describeExpect(expect);

  if (expect.pixel_changed !== undefined) {
    const verdict = ctx.verdict?.verdict ?? "unknown";
    if (verdict === "unknown") unknown.push(wants[0] ?? "the frame comparison");
    else if (verdict === "changed" === expect.pixel_changed) {
      good.push(expect.pixel_changed ? "the frame visibly changed" : "the frame did not change");
    } else {
      bad.push(
        expect.pixel_changed
          ? "the frame did NOT change — the action was a no-op or missed, but you promised a visible effect"
          : "the frame DID change, but you promised it would not",
      );
    }
  }

  if (expect.text_landed !== undefined) {
    const hay = ctx.observationText ?? "";
    if (!hay) unknown.push(`the page text containing "${expect.text_landed}" (no digest was read)`);
    else if (hay.toLowerCase().includes(expect.text_landed.toLowerCase())) {
      good.push(`the page text contains "${expect.text_landed}"`);
    } else {
      bad.push(`the page text does NOT contain "${expect.text_landed}"`);
    }
  }

  if (expect.dialog !== undefined) {
    try {
      const res = await runContentAction(ctx.tabId, {
        action: "queryText",
        selector: '[role="dialog"]',
      });
      const open = res.ok;
      if (open === (expect.dialog === "open")) good.push(`the dialog is ${expect.dialog}`);
      else bad.push(`the dialog is ${open ? "still open" : "not open"}, but you expected it ${expect.dialog}`);
    } catch {
      unknown.push(`whether a dialog is ${expect.dialog}`);
    }
  }

  if (expect.toolbar_style !== undefined) {
    let read: string | null = null;
    for (const selector of STYLE_BOX_SELECTORS) {
      const res = await runContentAction(ctx.tabId, { action: "queryText", selector });
      const text = String((res.data as { text?: string } | undefined)?.text ?? "");
      if (res.ok && text) {
        read = text;
        break;
      }
    }
    if (read === null) unknown.push(`the toolbar style box reading "${expect.toolbar_style}" (not readable)`);
    else if (read.toLowerCase().includes(expect.toolbar_style.toLowerCase())) {
      good.push(`the toolbar style box reads "${expect.toolbar_style}"`);
    } else {
      bad.push(`the toolbar style box reads "${read.slice(0, 40)}", expected "${expect.toolbar_style}"`);
    }
  }

  if (expect.export_contains !== undefined) {
    try {
      await sleep(EXPORT_SETTLE_MS);
      const out = await fetchWorkspaceExport(ctx.tabId, "html");
      if (!out.ok) unknown.push(`the export containing "${expect.export_contains}" (the export read failed)`);
      else if (out.body.includes(expect.export_contains)) {
        good.push(`the exported HTML contains "${expect.export_contains}"`);
      } else {
        bad.push(`the exported HTML does NOT contain "${expect.export_contains}"`);
      }
    } catch {
      unknown.push(`the export containing "${expect.export_contains}" (the export read errored)`);
    }
  }

  if (bad.length) {
    return `NOT VERIFIED: ${bad.join("; ")}${good.length ? ` (held: ${good.join("; ")})` : ""} — look at the attached observation before choosing the next move`;
  }
  if (good.length) return `verified: ${good.join("; ")}`;
  return `unverified (could not check: ${unknown.join("; ")})`;
}