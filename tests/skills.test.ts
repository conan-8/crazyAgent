import { describe, expect, it } from "vitest";
import {
  BUNDLED_SKILLS,
  formatSkillsCatalog,
  mergeSkills,
  normalizeSkillName,
  rankSkillsForTask,
  skillBodyOf,
  skillMatchesUrl,
  skillOutline,
  SKILL_BODY_MAX_CHARS,
  SKILL_SECTION_MAX,
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


describe("skill sections", () => {
  const graph = BUNDLED_SKILLS.find((s) => s.name === "graph-drag-widgets")!;

  it("every bundled multi-section skill has a title and body per section", () => {
    for (const s of BUNDLED_SKILLS) {
      for (const sec of s.sections ?? []) {
        expect(sec.id).toBeTruthy();
        expect(sec.title).toBeTruthy();
        expect(sec.body.length).toBeGreaterThan(40);
      }
      if ((s.sections ?? []).length > 1) expect(s.sections!.length).toBeLessThanOrEqual(SKILL_SECTION_MAX);
    }
  });

  it("skillOutline exposes the catalog-facing shape", () => {
    const outline = skillOutline(graph);
    expect(outline.length).toBeGreaterThan(1);
    expect(outline.map((o) => o.id)).toContain("calibrate");
    expect(outline.map((o) => o.id)).toContain("batch-drag");
  });

  it("skillBodyOf returns the outline (error) for a multi-section skill with no section", () => {
    const res = skillBodyOf(graph);
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error).toContain("calibrate");
      expect(res.error).toContain("batch-drag");
    }
  });

  it("skillBodyOf returns just one section when asked, with the outline attached", () => {
    const res = skillBodyOf(graph, "batch-drag");
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.body).toContain("drags");
      expect(res.sections.length).toBeGreaterThan(1);
    }
  });

  it("skillBodyOf normalizes section ids and reports unknown sections", () => {
    const normalized = skillBodyOf(graph, "BATCH_DRAG");
    expect("error" in normalized).toBe(false);
    const bad = skillBodyOf(graph, "nope");
    expect("error" in bad).toBe(true);
    if ("error" in bad) expect(bad.error).toContain("no section");
  });

  it("single-section skills return their body directly (no extra round trip)", () => {
    const one: Skill = {
      id: "one", name: "one", whenToUse: "w", body: "the body",
      sections: [{ id: "only", title: "Only", body: "the body" }],
      source: "user", at: 1,
    };
    const res = skillBodyOf(one);
    expect("error" in res).toBe(false);
    if (!("error" in res)) expect(res.body).toBe("the body");
    // Even without an explicit section arg.
    const res2 = skillBodyOf(one, "only");
    expect("error" in res2).toBe(false);
    if (!("error" in res2)) expect(res2.body).toBe("the body");
  });
});

describe("host pinning", () => {
  it("skillMatchesUrl matches on hostname substrings", () => {
    const docs = BUNDLED_SKILLS.find((s) => s.name === "canvas-doc-editors")!;
    expect(skillMatchesUrl(docs, "https://docs.google.com/document/d/x/edit")).toBe(true);
    expect(skillMatchesUrl(docs, "https://kimi.ai/chat")).toBe(false);
  });

  it("host-matching skills are pinned to the top of the catalog with a you-are-on note", () => {
    const cat = formatSkillsCatalog(rankSkillsForTask(BUNDLED_SKILLS, "do the thing"), {
      url: "https://docs.google.com/document/d/x/edit",
    });
    expect(cat).toContain("you are on docs.google.com");
    expect(cat).toContain("canvas-doc-editors");
    // The matching skill line comes before the others.
    const lines = cat.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("canvas-doc-editors");
  });

  it("catalog lists section ids so the model knows the shape before loading", () => {
    const cat = formatSkillsCatalog(rankSkillsForTask(BUNDLED_SKILLS, "plot the graph"), {});
    expect(cat).toContain("· sections: calibrate, derive, batch-drag, verify");
  });

  it("catalog mentions the section protocol", () => {
    const cat = formatSkillsCatalog(rankSkillsForTask(BUNDLED_SKILLS, "do the thing"), {});
    expect(cat).toContain("ask for one `section`");
  });
});
