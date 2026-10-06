// Deterministic Google Docs operations — "know everything about the Docs
// interface" as EXECUTED code instead of prompt prose. A real 351-turn run
// kept re-deriving the same menu walks by pixel and kept missing ("the menu
// shifted", "page numbers landed in the header again"); every such procedure
// is a label walk + trusted keys + an effect check, which is what this file
// runs. Planning is pure and unit-tested (shared/docs-ops.ts); execution here
// uses the label-based content actions (clickByText / fillField / queryText)
// so nothing depends on coordinates, and every op verifies its own effect.
import { failureTag } from "../../shared/tool-failure";
import {
  DOCS_OPS,
  planDocsOp,
  type DialogFill,
  type MenuLabel,
  type VerifyPlan,
} from "../../shared/docs-ops";
import { runContentAction } from "./content-action";
import { fetchWorkspaceExport } from "./docs";
import { ensureTabActive, sendTrustedKey } from "./trusted-input";
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

/** Walk a whole menu path; stops at the first step that cannot be clicked. */
async function walkMenu(
  ctx: ToolContext,
  labels: MenuLabel[],
): Promise<{ ok: true; steps: string[] } | { ok: false; error: string; steps: string[] }> {
  const steps: string[] = [];
  for (const [i, label] of labels.entries()) {
    const out = await clickLabelStep(ctx, label);
    if (!out.ok) {
      return {
        ok: false,
        error: `step ${i + 1} ("${labelShown(label)}"): ${out.error}`,
        steps,
      };
    }
    steps.push(out.clicked);
    await sleep(BETWEEN_STEPS_MS);
  }
  return { ok: true, steps };
}

/** One real (CDP) key combo — the table picker and shortcuts need trusted keys. */
async function sendTrustedCombo(ctx: ToolContext, combo: string): Promise<void> {
  await sendTrustedKey(ctx.tabId, ctx.adapter, combo);
  await sleep(BETWEEN_STEPS_MS);
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
    "Click through a menu path BY LABEL in one call — replaces the open-menu / look / click-row turn chain and never guesses a coordinate. path: ['File','Page setup'], ['Insert','Break','Page break'], ['Format','Paragraph styles','Heading 2']. Each step waits up to ~2.4s for its row to appear, clicks the visible element whose text/aria-label matches, and the result lists every click; the walk stops at the first label it cannot find and reports how far it got. The fresh page observation rides the result like any action. Works on any web app's DOM menus (Google Workspace, Drive, school portals) — menus are DOM, so this is always safer than coordinate clicks.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "array",
        items: { type: "string" },
        description: "Menu labels from the bar down to the final row (2–6 entries)",
      },
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
    "Run ONE Google Docs UI operation deterministically — the interface knowledge is built in (exact menu routes, shortcuts, dialog fields), so one call replaces a multi-turn pixel hunt, and the op verifies its own effect. Ops: apply_style {style:'Title'|'Subtitle'|'Normal text'|'Heading 1'..'Heading 6'} (Heading 1-6 ride Ctrl+Alt+1..6); page_setup {size?:'Letter'|'A4'|…, margins?:inches for all four sides (e.g. 1) or {top,right,bottom,left}, orientation?:'portrait'|'landscape'} — at least one of the three; page_numbers {position:'footer'|'header'}; insert_table {rows:1..20, cols:1..20}. The caret/selection must already be where the op applies (click into the document first). The result lists the steps taken and a verification line ('verified:' / 'NOT VERIFIED:' — read it); the fresh observation rides along as with any action.",
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
        description: "apply_style: 'Title', 'Subtitle', 'Normal text', 'Heading 1'..'Heading 6'",
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
      case "menuThenKeys": {
        const w = await walkMenu(ctx, plan.labels);
        steps.push(...w.steps);
        if (!w.ok) return fail(w.error);
        await ensureTabActive(ctx.tabId, ctx.adapter);
        for (const combo of plan.combos) await sendTrustedCombo(ctx, combo);
        steps.push(`sent ${plan.combos.length} trusted key(s) to the grid picker`);
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
