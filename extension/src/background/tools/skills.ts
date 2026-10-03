// The `use_skill` tool: load one full on-demand procedure. Read-only, so it
// is PARALLEL_SAFE (registered in the loop's set). The body arrives as the
// tool result — history-append, cache-safe: the byte-stable system prompt
// only ever carried the one-line catalog.
import { failureTag } from "../../shared/tool-failure";
import { skillBodyOf, type SkillSectionLite } from "../../shared/skills";
import { getSkill, listSkills } from "../skills";
import { registerTool, type ToolContext } from "./types";

registerTool({
  name: "use_skill",
  description:
    "Load one section of an on-demand procedure (skill) by name from the catalog in the system prompt's appendix. Call `use_skill name:x` first — the result is the OUTLINE (one line per section) if the skill is split, or the body directly if it is a single-section skill. Then call `use_skill name:x section:'<id>'` for just the section you need. The body arrives as the call's result and stays in context — call it ONCE before working the surface it describes, not before every step.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name exactly as the catalog lists it (e.g. 'graph-drag-widgets')",
      },
      section: {
        type: "string",
        description: "Optional: a section id from the outline. Omit to get the outline (or the body if the skill is single-section).",
      },
    },
    required: ["name"],
  },
  async run(args, _ctx: ToolContext) {
    const wanted = typeof args.name === "string" ? args.name : "";
    if (!wanted) {
      return { ok: false, error: `${failureTag("input")}: use_skill needs a name from the catalog` };
    }
    const skill = await getSkill(wanted);
    if (!skill) {
      const all = await listSkills();
      const catalog = all.map((s) => s.name).join(", ") || "(none installed)";
      return {
        ok: false,
        error: `${failureTag("input")}: no skill named '${wanted}' — available: ${catalog}`,
      };
    }
    const section = typeof args.section === "string" ? args.section : undefined;
    const resolved = skillBodyOf(skill, section);
    if ("error" in resolved) {
      return { ok: false, error: `${failureTag("input")}: ${resolved.error}` };
    }
    return {
      name: skill.name,
      whenToUse: skill.whenToUse,
      body: resolved.body,
      sections: resolved.sections,
    };
  },
  present(payload) {
    const p = (payload ?? {}) as {
      name?: string;
      whenToUse?: string;
      body?: string;
      sections?: SkillSectionLite[];
    };
    const header = `[skill: ${p.name ?? "?"} — ${p.whenToUse ?? ""}]`;
    if (!p.body && p.sections?.length) {
      // Outline-only result (no section asked for on a split skill).
      const lines = p.sections.map((o) => `- ${o.id} — ${o.title}${o.useWhen ? ` (${o.useWhen})` : ""}`);
      return { text: `${header} OUTLINE (pick a section to load):\n${lines.join("\n")}` };
    }
    return { text: `${header}\n\n${p.body ?? ""}` };
  },
});
