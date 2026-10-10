// Deterministic Google Docs operations — "know everything about the Docs
// interface" as EXECUTED code instead of prompt prose. A real 351-turn run
// kept re-deriving the same menu walks by pixel and kept missing ("the menu
// shifted", "page numbers landed in the header again"); every such procedure
// is a label walk + trusted keys + an effect check, which is what this file
// runs. Planning is pure and unit-tested (shared/docs-ops.ts); execution here
// uses the label-based content actions (clickByText / fillField / queryText)
// and every op verifies its own effect. The one coordinate is the table size
// grid, which has no labels to click — and it reports its own size, so the aim
// is confirmed before the click commits.
import { EXPECT_PROP } from "../../shared/expect";
import { failureTag } from "../../shared/tool-failure";
import {
  DOCS_OPS,
  gridCellPoint,
  gridCellPx,
  parseGridStatus,
  planDocsOp,
  shouldRetryWalk,
  type DialogFill,
  type MenuLabel,
  type VerifyPlan,
} from "../../shared/docs-ops";
import type { MenuBarState, SelectorBox } from "../../content/actions";
import { runContentAction } from "./content-action";
import { sendStrokes } from "./coords";
import { fetchWorkspaceExport } from "./docs";
import { ensureTabActive, sendTrustedKey, sendTrustedText } from "./trusted-input";
import { registerTool, type ToolContext } from "./types";

/** Per-step budget: menus/dialog rows render in <300ms; this is generous. */
const STEP_BUDGET_MS = 2_400;
/** Polling beat while waiting for a step's target to appear. */
const POLL_MS = 150;
/** Beat between steps so the next row exists before it is looked for. */
const BETWEEN_STEPS_MS = 120;
/** Docs autosaves fast, but give the export a beat before verifying. */
const EXPORT_SETTLE_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelList(label: MenuLabel): string[] {
  return Array.isArray(label) ? label : [label];
}

function labelShown(label: MenuLabel): string {
  return labelList(label).join("' / '");
}

/**
 * Click one menu step: poll clickByText until the row exists (menus render
 * asynchronously) or the budget expires. A DISABLED row fails fast — polling
 * will not enable it.
 */
async function clickLabelStep(
  ctx: ToolContext,
  label: MenuLabel,
): Promise<{ ok: true; clicked: string } | { ok: false; error: string }> {
  const labels = labelList(label);
  const deadline = Date.now() + STEP_BUDGET_MS;
  let lastErr = `no clickable element matches ${JSON.stringify(labels)}`;
  for (;;) {
    const res = await runContentAction(ctx.tabId, { action: "clickByText", labels });
    if (res.ok) {
      const data = res.data as { clicked?: string } | undefined;
      return { ok: true, clicked: data?.clicked ?? labels[0]! };
    }
    lastErr = String(res.error ?? "click failed");
    if (/DISABLED/i.test(lastErr)) break;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  return { ok: false, error: lastErr };
}

/** Fill one dialog field, polling for the dialog to render it. */
async function fillFieldStep(
  ctx: ToolContext,
  fill: DialogFill,
): Promise<{ ok: true; filled: string } | { ok: false; error: string }> {
  const labels = labelList(fill.labels);
  const deadline = Date.now() + STEP_BUDGET_MS;
  let lastErr = `no field matches ${JSON.stringify(labels)}`;
  for (;;) {
    const res = await runContentAction(ctx.tabId, {
      action: "fillField",
      labels,
      value: fill.value,
      kind: fill.kind,
    });
    if (res.ok) {
      const data = res.data as { filled?: string } | undefined;
      return { ok: true, filled: data?.filled ?? labels[0]! };
    }
    lastErr = String(res.error ?? "fill failed");
    // These never improve by waiting: the field IS there and disagrees.
    if (/has no option|not a <select>/i.test(lastErr)) break;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  return { ok: false, error: lastErr };
}

/** One walk attempt, with the failing step kept for the retry decision. */
interface WalkAttempt {
  ok: boolean;
  steps: string[];
  /** 0-based index of the step that missed (only meaningful when !ok). */
  failedAt: number;
  /** The raw clickByText error, before the "step N (…)" wrapper. */
  rawError: string;
  /** The composed message the caller reports. */
  error: string;
}

async function walkOnce(ctx: ToolContext, labels: MenuLabel[]): Promise<WalkAttempt> {
  const steps: string[] = [];
  for (const [i, label] of labels.entries()) {
    const out = await clickLabelStep(ctx, label);
    if (!out.ok) {
      return {
        ok: false,
        steps,
        failedAt: i,
        rawError: out.error,
        error: `step ${i + 1} ("${labelShown(label)}"): ${out.error}`,
      };
    }
    steps.push(out.clicked);
    await sleep(BETWEEN_STEPS_MS);
  }
  return { ok: true, steps, failedAt: -1, rawError: "", error: "" };
}

/**
 * Bring the menu bar back when the app has hidden it, and say whether that
 * worked. Docs' full-screen mode leaves the bar in the DOM with every label
 * intact but its wrapper at display:none, so EVERY walk misses at step 1 —
 * indistinguishable from a renamed menu, and unfixable by retrying. One
 * Ctrl+Shift+F restores it (measured: the wrapper goes back to display:block
 * and the same walk then clicks Format ▸ Text). Only pressed when the bar is
 * actually detected as hidden, never on a plain miss.
 */
async function revealMenuBar(ctx: ToolContext): Promise<boolean> {
  const read = async (): Promise<MenuBarState | null> => {
    const res = await runContentAction(ctx.tabId, { action: "menuBarState" }).catch(() => null);
    return res?.ok ? ((res.data as MenuBarState | undefined) ?? null) : null;
  };
  const before = await read();
  if (!before || before.visible || !before.hiddenBar) return false;
  // The failed walk may have clicked a toolbar control whose label merely
  // STARTS with the menu's ("Insert" → "Insert image") and left a popup open;
  // clear it first, or the restored bar is still covered by it.
  await sendTrustedKey(ctx.tabId, ctx.adapter, "Escape").catch(() => undefined);
  await sendTrustedKey(ctx.tabId, ctx.adapter, "Control+Shift+f").catch(() => undefined);
  await sleep(BETWEEN_STEPS_MS * 3);
  const after = await read();
  return Boolean(after?.visible);
}

/**
 * Walk a whole menu path; stops at the first step that cannot be clicked.
 *
 * Two recoveries, each tried once. A HIDDEN MENU BAR (Docs full-screen) makes
 * every label miss, so it is restored first — it is the one failure no retry can
 * fix. Then a miss after step 1 gets the older recovery: Escape (closing a
 * stale open menu or a half-open submenu that made the walk see a closed one),
 * then a fresh walk from the top. Runs D and F both lost rows that were on
 * screen to exactly that desync; see shouldRetryWalk for why step-1 misses and
 * DISABLED rows are excluded from the Escape retry.
 */
export async function walkMenu(
  ctx: ToolContext,
  labels: MenuLabel[],
): Promise<{ ok: true; steps: string[] } | { ok: false; error: string; steps: string[] }> {
  const first = await walkOnce(ctx, labels);
  if (first.ok) return first;
  let attempt = first;
  if (await revealMenuBar(ctx)) {
    const restored = await walkOnce(ctx, labels);
    const note = "the menu bar was hidden (full-screen mode) — Ctrl+Shift+F brought it back";
    if (restored.ok) return { ok: true, steps: [note, ...restored.steps] };
    attempt = { ...restored, steps: [note, ...restored.steps] };
  }
  if (!shouldRetryWalk(attempt.failedAt, attempt.rawError)) {
    return { ok: false, error: attempt.error, steps: attempt.steps };
  }
  await sendTrustedKey(ctx.tabId, ctx.adapter, "Escape").catch(() => undefined);
  await sleep(BETWEEN_STEPS_MS * 2);
  const second = await walkOnce(ctx, labels);
  if (second.ok) {
    return { ok: true, steps: [...attempt.steps, "Escape (reset the menu)", ...second.steps] };
  }
  return {
    ok: false,
    error: `${second.error}; retried once after Escape — if the label is missing, use the visible rows named in the error`,
    steps: second.steps,
  };
}

/** One real (CDP) key combo — Docs ignores synthetic keys for shortcuts. */
async function sendTrustedCombo(ctx: ToolContext, combo: string): Promise<void> {
  await sendTrustedKey(ctx.tabId, ctx.adapter, combo);
  await sleep(BETWEEN_STEPS_MS);
}

/**
 * Drive the Insert ▸ Table size grid: aim at a cell, read the grid's own size
 * label back, and click only when it names the size that was asked for.
 *
 * The grid takes no keyboard input — arrows and Enter sent at it land in the
 * document instead (a probe came back with a stray empty paragraph and no
 * table), so this is the one op that aims at a position. Two passes at most:
 * the block the grid already has highlighted spans exactly the columns its
 * label names, which measures the real cell size instead of assuming one.
 */
const GRID_MOUSECATCHER = ".goog-dimension-picker-mousecatcher";
const GRID_STATUS = ".goog-dimension-picker-status";
const GRID_HIGHLIGHTED = ".goog-dimension-picker-highlighted";
/** Only the first aim's guess; the grid's own highlight replaces it. */
const GRID_GUESS_CELL_PX = 18;

async function gridBoxes(ctx: ToolContext): Promise<Map<string, SelectorBox>> {
  const res = await runContentAction(ctx.tabId, {
    action: "boxes",
    selectors: [GRID_MOUSECATCHER, GRID_STATUS, GRID_HIGHLIGHTED],
  }).catch(() => null);
  const boxes = res?.ok ? ((res.data as { boxes?: SelectorBox[] } | undefined)?.boxes ?? []) : [];
  return new Map(boxes.map((b) => [b.selector, b]));
}

async function pickGridSize(
  ctx: ToolContext,
  rows: number,
  cols: number,
): Promise<{ ok: true; steps: string[] } | { ok: false; error: string }> {
  let cell = GRID_GUESS_CELL_PX;
  let seen = "nothing readable";
  for (let pass = 0; pass < 2; pass++) {
    const boxes = await gridBoxes(ctx);
    const grid = boxes.get(GRID_MOUSECATCHER);
    if (!grid) {
      return {
        ok: false,
        error: `${failureTag("tool")}: the table size grid never appeared (${GRID_MOUSECATCHER} is not on screen) — the Insert ▸ Table submenu may have closed; re-run insert_table once`,
      };
    }
    const before = parseGridStatus(boxes.get(GRID_STATUS)?.text ?? "");
    const measured = before
      ? gridCellPx(boxes.get(GRID_HIGHLIGHTED)?.w ?? 0, before.cols)
      : null;
    if (measured) cell = measured;
    const at = gridCellPoint({ x: grid.x, y: grid.y }, cell, cols, rows);
    await sendStrokes(ctx, [{ type: "mouseMoved", x: at.x, y: at.y }]);
    await sleep(BETWEEN_STEPS_MS);
    const shown = parseGridStatus((await gridBoxes(ctx)).get(GRID_STATUS)?.text ?? "");
    seen = shown ? `${shown.cols} x ${shown.rows}` : "nothing readable";
    if (shown?.cols === cols && shown.rows === rows) {
      await sendStrokes(ctx, [
        { type: "mouseMoved", x: at.x, y: at.y },
        { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 },
        { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 },
      ]);
      return {
        ok: true,
        steps: [`aimed the size grid at (${at.x},${at.y}) — it reads "${seen}" — and clicked`],
      };
    }
  }
  return {
    ok: false,
    error: `${failureTag("tool")}: the size grid reads "${seen}", not ${cols} x ${rows}, so nothing was clicked (the visible grid is smaller than 20×20 — sizes beyond it cannot be picked this way). Re-run insert_table, or open Insert ▸ Table yourself and click the cell on a screenshot`,
  };
}

/**
 * The op's effect check — cheap, deterministic, and honest: when a check
 * cannot run or comes back negative, the result SAYS so instead of claiming
 * success (the "silent no-op discovered five turns later" class).
 */
async function verifyPlan(ctx: ToolContext, verify: VerifyPlan | undefined): Promise<string | undefined> {
  if (!verify) return undefined;
  try {
    switch (verify.check) {
      case "exportHtmlContains": {
        await sleep(EXPORT_SETTLE_MS);
        const out = await fetchWorkspaceExport(ctx.tabId, "html");
        if (!out.ok) return "unverified (the export read failed — check the attached screenshot)";
        return out.body.includes(verify.needle)
          ? `verified: ${verify.describe}`
          : `NOT VERIFIED: expected ${verify.describe} — look at the attached screenshot before continuing`;
      }
      case "toolbarStylesShows": {
        for (const selector of [
          '[aria-label^="Styles"]',
          ".kix-paragraphstyles-combobox",
          '[role="combobox"][aria-label]',
        ]) {
          const res = await runContentAction(ctx.tabId, { action: "queryText", selector });
          const text = String((res.data as { text?: string } | undefined)?.text ?? "");
          if (res.ok && text) {
            return text.toLowerCase().includes(verify.needle.toLowerCase())
              ? `verified: ${verify.describe}`
              : `NOT VERIFIED: the toolbar style box reads "${text.slice(0, 40)}", expected "${verify.needle}"`;
          }
        }
        return "unverified (the toolbar style box was not readable)";
      }
      case "dialogClosed": {
        const res = await runContentAction(ctx.tabId, {
          action: "queryText",
          selector: '[role="dialog"]',
        });
        if (!res.ok) return `verified: ${verify.describe}`;
        const text = String((res.data as { text?: string } | undefined)?.text ?? "").slice(0, 60);
        return `NOT VERIFIED: a dialog is still open ("${text}") — the confirm click may have missed`;
      }
    }
  } catch {
    return "unverified (the effect check errored)";
  }
}

registerTool({
  name: "menu_path",
  description:
    "Click through a menu path BY LABEL in one call — replaces the open-menu / look / click-row turn chain and never guesses a coordinate. path: ['File','Page setup'], ['Insert','Break','Page break'], ['Format','Paragraph styles','Heading 2']. Each step waits up to ~2.4s for its row to appear, clicks the visible element whose text/aria-label matches (menu arrows, accelerator suffixes and 'Updated' badges are ignored), and the result lists every click; the walk stops at the first label it cannot find, restores the menu bar if the app has hidden it (Docs full-screen mode — every label misses at step 1 then), retries once after Escape (which repairs a stale open menu), and on a miss NAMES the rows the open menu actually shows — read that list and correct the path instead of repeating it. The fresh page observation rides the result like any action. Works on any web app's DOM menus (Google Workspace, Drive, school portals) — menus are DOM, so this is always safer than coordinate clicks.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "array",
        items: { type: "string" },
        description: "Menu labels from the bar down to the final row (2–6 entries)",
      },
      ...EXPECT_PROP,
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const raw = Array.isArray(args.path) ? args.path : [];
    const path = raw
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    if (path.length < 2) {
      return {
        ok: false,
        error: `${failureTag("input")}: menu_path needs at least 2 labels (e.g. ["File","Page setup"])`,
      };
    }
    if (path.length > 6) {
      return { ok: false, error: `${failureTag("input")}: menu_path takes at most 6 labels` };
    }
    const out = await walkMenu(ctx, path);
    if (!out.ok) {
      return {
        ok: false,
        error: `${failureTag("tool")}: menu walk stopped — ${out.error}`,
        ...(out.steps.length ? { clicked: out.steps } : {}),
      };
    }
    return { clicked: out.steps, path: path.join(" ▸ ") };
  },
  present(payload) {
    const p = (payload ?? {}) as { clicked?: string[]; path?: string };
    return { text: `clicked ${p.path ?? ""}: ${(p.clicked ?? []).join(" → ")}` };
  },
});

registerTool({
  name: "docs_op",
  description:
    "Run ONE Google Docs UI operation deterministically — the interface knowledge is built in (exact menu routes read off the live 2026 Docs menu, shortcuts, dialog fields), so one call replaces a multi-turn pixel hunt, and the op verifies its own effect. Ops: apply_style {style:'Title'|'Subtitle'|'Normal text'|'Heading 1'..'Heading 6'} (Heading 1-6 ride Ctrl+Alt+1..6); page_setup {size?:'Letter'|'A4'|…, margins?:inches for all four sides (e.g. 1) or {top,right,bottom,left}, orientation?:'portrait'|'landscape'} — at least one of the three (NOT reliable yet: the dialog's size dropdown has been missed — read the verification line); page_numbers {position:'footer'|'header'} (Insert ▸ Page elements ▸ Page numbers); insert_table {rows:1..20, cols:1..20} (drives the size grid with the mouse and REFUSES unless the grid reports the size asked for — read its verification line, and confirm the table in docs_read outline before filling it); page_break (Ctrl+Enter); table_of_contents {style?:'linked'|'plain'|'dotted'}; equation {text:'E = mc^2'} (Insert ▸ Symbols ▸ Equation, then types the text). The caret/selection must already be where the op applies (click into the document first). The result lists the steps taken and a verification line ('verified:' / 'NOT VERIFIED:' — read it); the fresh observation rides along as with any action. If an op's menu row is missing, the error names the rows the open menu actually shows — read that list instead of re-trying the same path.",
  parameters: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: [...DOCS_OPS],
        description: "Which operation to run",
      },
      style: {
        type: "string",
        description:
          "apply_style: 'Title', 'Subtitle', 'Normal text', 'Heading 1'..'Heading 6'; table_of_contents: 'linked' (default), 'plain' or 'dotted'",
      },
      text: {
        type: "string",
        description: "equation: the equation to type into the equation box, e.g. 'E = mc^2'",
      },
      size: { type: "string", description: "page_setup: paper size, e.g. 'Letter', 'A4'" },
      margins: {
        type: ["number", "object"],
        description:
          "page_setup: margins in inches — one number for all four sides (1), or {top, right, bottom, left}",
      },
      orientation: {
        type: "string",
        enum: ["portrait", "landscape"],
        description: "page_setup: page orientation",
      },
      position: {
        type: "string",
        enum: ["footer", "header"],
        description: "page_numbers: 'footer' = bottom of page, 'header' = top",
      },
      rows: { type: "number", description: "insert_table: 1..20" },
      cols: { type: "number", description: "insert_table: 1..20" },
    },
    required: ["op"],
  },
  async run(args, ctx) {
    const planned = planDocsOp(args.op, args);
    if (!planned.ok) return { ok: false, error: planned.error };
    const { plan, op } = planned;
    const steps: string[] = [];
    const fail = (detail: string): { ok: false; error: string; steps?: string[] } => ({
      ok: false,
      error: `${failureTag("tool")}: ${plan.describe} — ${detail}`,
      ...(steps.length ? { steps } : {}),
    });
    switch (plan.kind) {
      case "keys": {
        await ensureTabActive(ctx.tabId, ctx.adapter);
        for (const combo of plan.combos) await sendTrustedCombo(ctx, combo);
        steps.push(`sent ${plan.combos.join(", ")} (trusted keys)`);
        break;
      }
      case "menu": {
        const w = await walkMenu(ctx, plan.labels);
        steps.push(...w.steps);
        if (!w.ok) return fail(w.error);
        break;
      }
      case "dialog": {
        const w = await walkMenu(ctx, plan.open);
        steps.push(...w.steps);
        if (!w.ok) return fail(w.error);
        for (const fill of plan.fill) {
          const out = await fillFieldStep(ctx, fill);
          if (!out.ok) {
            return fail(
              `field ${labelShown(fill.labels)} failed: ${out.error}. The dialog is still open — fill it by ref from the observation, or press Escape and retry`,
            );
          }
          steps.push(out.filled);
        }
        const c = await clickLabelStep(ctx, plan.confirm);
        if (!c.ok) {
          return fail(
            `confirm button (${labelShown(plan.confirm)}) failed: ${c.error}. The dialog is still open with the values filled`,
          );
        }
        steps.push(c.clicked);
        break;
      }
      case "menuThenGridPick": {
        const w = await walkMenu(ctx, plan.labels);
        steps.push(...w.steps);
        if (!w.ok) return fail(w.error);
        await ensureTabActive(ctx.tabId, ctx.adapter);
        const picked = await pickGridSize(ctx, plan.rows, plan.cols);
        if (!picked.ok) return fail(picked.error);
        steps.push(...picked.steps);
        break;
      }
      case "menuThenType": {
        const w = await walkMenu(ctx, plan.labels);
        steps.push(...w.steps);
        if (!w.ok) return fail(w.error);
        await ensureTabActive(ctx.tabId, ctx.adapter);
        await sendTrustedText(ctx.tabId, ctx.adapter, plan.text);
        steps.push(`typed "${plan.text}" into the editor box`);
        break;
      }
    }
    const verified = await verifyPlan(ctx, plan.verify);
    return {
      op,
      did: plan.describe,
      steps,
      ...(verified ? { verified } : {}),
    };
  },
  present(payload) {
    const p = (payload ?? {}) as {
      op?: string;
      did?: string;
      steps?: string[];
      verified?: string;
    };
    const trail = (p.steps ?? []).join(" → ");
    return {
      text: `${p.op ?? ""}: ${p.did ?? ""}${trail ? ` — ${trail}` : ""}${p.verified ? ` [${p.verified}]` : ""}`,
    };
  },
});
