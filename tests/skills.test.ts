import { describe, expect, it } from "vitest";
import {
  BUNDLED_SKILLS,
  formatSkillsCatalog,
  mergeSkills,
  normalizeSkillName,
  rankSkillsForTask,
  SKILL_BODY_MAX_CHARS,
  type Skill,
} from "../extension/src/shared/skills";

function userSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: "user-1",
    name: "my-skill",
    whenToUse: "when testing skills",
    body: "1. do the thing",
    source: "user",
    at: 1_000,
    ...over,
  };
}

describe("normalizeSkillName", () => {
  it("kebab-cases and trims", () => {
    expect(normalizeSkillName("  Invoice Upload!! ")).toBe("invoice-upload");
    expect(normalizeSkillName("a--b")).toBe("a-b");
    expect(normalizeSkillName("///")).toBe("");
  });
});

describe("rankSkillsForTask", () => {
  it("ranks host and keyword matches over unpinned strangers", () => {
    const skills = [
      userSkill({ id: "a", name: "unrelated", hosts: [], keywords: ["zebra"] }),
      BUNDLED_SKILLS.find((s) => s.name === "chat-relay")!,
      BUNDLED_SKILLS.find((s) => s.name === "graph-drag-widgets")!,
    ];
    const ranked = rankSkillsForTask(
      skills,
      "screenshot the question and send it to kimi, then plot the graph",
    );
    expect(ranked[0]!.name).toBe("chat-relay");
    expect(ranked.map((s) => s.name)).toContain("graph-drag-widgets");
    expect(ranked[ranked.length - 1]!.name).toBe("unrelated");
  });

  it("matches on the page URL, not just the task text", () => {
    const ranked = rankSkillsForTask(
      BUNDLED_SKILLS,
      "edit this thing",
      { url: "https://docs.google.com/document/d/xyz/edit" },
    );
    expect(ranked[0]!.name).toBe("canvas-doc-editors");
  });

  it("caps the catalog size", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      userSkill({ id: `s${i}`, name: `skill-${i}`, keywords: ["form"], pinned: true }),
    );
    expect(rankSkillsForTask(many, "form")).toHaveLength(10);
  });
});

describe("formatSkillsCatalog", () => {
  it("lists one line per skill with the use_skill instruction", () => {
    const cat = formatSkillsCatalog(BUNDLED_SKILLS);
    expect(cat).toContain("`use_skill`");
    for (const s of BUNDLED_SKILLS) {
      expect(cat).toContain(`- ${s.name} —`);
    }
  });

  it("is empty when there is nothing to list", () => {
    expect(formatSkillsCatalog([])).toBe("");
  });
});

describe("mergeSkills", () => {
  it("seeds bundled defaults into an empty store", () => {
    const { skills, changed } = mergeSkills([]);
    expect(changed).toBe(true);
    expect(skills).toHaveLength(BUNDLED_SKILLS.length);
  });

  it("refreshes a drifted bundled copy but never a user override", () => {
    const stale = BUNDLED_SKILLS.map((b) => ({ ...b, body: "old body" }));
    const refreshed = mergeSkills(stale);
    expect(refreshed.changed).toBe(true);
    const userEdited = stale.map((s) =>
      s.name === "chat-relay" ? { ...s, source: "user" as const } : s,
    );
    const kept = mergeSkills(userEdited);
    expect(
      kept.skills.find((s) => s.name === "chat-relay")!.body,
    ).toBe("old body");
    expect(
      kept.skills.find((s) => s.name === "canvas-doc-editors")!.body,
    ).toBe(BUNDLED_SKILLS.find((b) => b.name === "canvas-doc-editors")!.body);
  });

  it("is a no-op when the store already matches", () => {
    const { skills, changed } = mergeSkills([...BUNDLED_SKILLS]);
    expect(changed).toBe(false);
    expect(skills).toHaveLength(BUNDLED_SKILLS.length);
  });
});

describe("bundled skills sanity", () => {
  it("every body fits the budget and every name is kebab-case", () => {
    for (const s of BUNDLED_SKILLS) {
      expect(s.body.length).toBeLessThanOrEqual(SKILL_BODY_MAX_CHARS);
      expect(s.body.length).toBeGreaterThan(200);
      expect(normalizeSkillName(s.name)).toBe(s.name);
      expect(s.whenToUse.length).toBeGreaterThan(10);
    }
  });

  it("seeds the procedures the run log paid for", () => {
    expect(BUNDLED_SKILLS.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "canvas-doc-editors",
        "chat-relay",
        "graph-drag-widgets",
        "multi-step-forms",
      ]),
    );
    // The chat-relay procedure must teach the blocking wait, not polling.
    expect(
      BUNDLED_SKILLS.find((s) => s.name === "chat-relay")!.body,
    ).toContain("wait_for");
    // The graph procedure must teach calibrate-once + batched drags.
    expect(
      BUNDLED_SKILLS.find((s) => s.name === "graph-drag-widgets")!.body,
    ).toContain("drags");
  });
});
