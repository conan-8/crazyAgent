// The `use_skill` tool: load one full on-demand procedure. Read-only, so it
// is PARALLEL_SAFE (registered in the loop's set). The body arrives as the
// tool result — history-append, cache-safe: the byte-stable system prompt
// only ever carried the one-line catalog.
import { failureTag } from "../../shared/tool-failure";
import { getSkillBody, listSkills } from "../skills";
import { registerTool } from "./types";

registerTool({
  name: "use_skill",
  description:
    "Load one full on-demand procedure (skill) by name from the catalog in the system prompt's appendix. Its body arrives as this call's result — read it and follow it. Call it ONCE before working the surface it describes (canvas editors, chat relays, graph widgets, forms…), not before every step; you already have the body in context afterwards.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name exactly as the catalog lists it (e.g. 'graph-drag-widgets')",
      },
    },
    required: ["name"],
  },
  async run(args) {
    const wanted = typeof args.name === "string" ? args.name : "";
    if (!wanted) {
      return { ok: false, error: `${failureTag("input")}: use_skill needs a name from the catalog` };
    }
    const skill = await getSkillBody(wanted);
    if (!skill) {
      const all = await listSkills();
      const catalog = all.map((s) => s.name).join(", ") || "(none installed)";
      return {
        ok: false,
        error: `${failureTag("input")}: no skill named '${wanted}' — available: ${catalog}`,
      };
    }
    return {
      name: skill.name,
      whenToUse: skill.whenToUse,
      body: skill.body,
    };
  },
  present(payload) {
    const p = (payload ?? {}) as { name?: string; whenToUse?: string; body?: string };
    return {
      text: `[skill: ${p.name ?? "?"} — ${p.whenToUse ?? ""}]\n\n${p.body ?? ""}`,
    };
  },
});
