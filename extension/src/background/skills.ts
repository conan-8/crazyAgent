// Skill persistence in chrome.storage.local — mirrors lessons.ts: per-browser-
// profile store under its own key (`baSkills`), surviving worker teardown and
// browser restarts, never leaking between profiles. Bundled defaults are
// merged in on first read (and refreshed when the in-git default changes);
// user-created skills and user edits of bundled ones are never clobbered.
import {
  BUNDLED_SKILLS,
  SKILLS_KEY,
  SKILL_BODY_MAX_CHARS,
  SKILL_SECTION_MAX,
  SKILL_SECTION_MAX_CHARS,
  SKILL_WHEN_MAX_CHARS,
  mergeSkills,
  normalizeSkillName,
  type Skill,
  type SkillSection,
} from "../shared/skills";

async function loadAll(): Promise<Skill[]> {
  const out = await chrome.storage.local.get(SKILLS_KEY);
  const raw = out[SKILLS_KEY] as Skill[] | undefined;
  const stored = Array.isArray(raw) ? raw : [];
  const { skills, changed } = mergeSkills(stored);
  if (changed) await chrome.storage.local.set({ [SKILLS_KEY]: skills });
  return skills;
}

async function saveAll(skills: Skill[]): Promise<void> {
  await chrome.storage.local.set({ [SKILLS_KEY]: skills });
}

/** Every skill, user entries first (newest), then bundled. */
export async function listSkills(): Promise<Skill[]> {
  const all = await loadAll();
  const user = all
    .filter((s) => s.source === "user")
    .sort((a, b) => b.at - a.at);
  const bundled = all.filter((s) => s.source === "bundled");
  return [...user, ...bundled];
}

/**
 * The skill for `use_skill`, or null when the name is unknown. The
 * section-aware resolution (outline vs one section) lives in
 * `skillBodyOf` (shared/skills.ts); this just finds the skill.
 */
export async function getSkill(name: string): Promise<Skill | null> {
  const wanted = normalizeSkillName(String(name ?? ""));
  const all = await loadAll();
  return all.find((s) => s.name === wanted) ?? null;
}

/** The full body for `use_skill`, or null when the name is unknown. */
export async function getSkillBody(name: string): Promise<Skill | null> {
  return getSkill(name);
}

export interface SkillDraft {
  name: string;
  whenToUse: string;
  body: string;
  hosts?: string[];
  keywords?: string[];
  pinned?: boolean;
  sections?: SkillSection[];
}

/** Validate a draft; returns tool-error text or a storable skill. */
export function shapeSkillDraft(
  draft: SkillDraft,
  id: string,
  at: number,
): { error: string } | { skill: Skill } {
  const name = normalizeSkillName(draft.name ?? "");
  if (!name) return { error: "name must contain letters or digits" };
  const when = (draft.whenToUse ?? "").trim();
  if (!when) return { error: "whenToUse is required (one line: when this procedure applies)" };
  const body = (draft.body ?? "").trim();
  if (!body) return { error: "body is required (the procedure)" };
  if (body.length > SKILL_BODY_MAX_CHARS) {
    return { error: `body is ${body.length} chars — cap is ${SKILL_BODY_MAX_CHARS}` };
  }
  const sections = draft.sections?.length
    ? draft.sections
        .slice(0, SKILL_SECTION_MAX)
        .map((s) => ({
          id: normalizeSkillName(s.id),
          title: s.title,
          useWhen: s.useWhen,
          body: s.body.slice(0, SKILL_SECTION_MAX_CHARS),
        }))
        .filter((s) => s.id && s.title && s.body)
    : undefined;
  return {
    skill: {
      id,
      name,
      whenToUse: when.slice(0, SKILL_WHEN_MAX_CHARS + 40),
      hosts: draft.hosts?.filter(Boolean),
      keywords: draft.keywords?.filter(Boolean),
      body: sections && sections.length ? "" : body,
      sections: sections && sections.length ? sections : undefined,
      source: "user",
      pinned: draft.pinned === true || undefined,
      at,
    },
  };
}

/** Create a user skill (or overwrite one with the same name). */
export async function createSkill(draft: SkillDraft): Promise<{ error?: string; skill?: Skill }> {
  const at = Date.now();
  const shaped = shapeSkillDraft(draft, `user-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at);
  if ("error" in shaped) return { error: shaped.error };
  const all = await loadAll();
  const next = all.filter((s) => s.name !== shaped.skill.name);
  next.push(shaped.skill);
  await saveAll(next);
  return { skill: shaped.skill };
}

/** Edit a skill (user wording wins over bundled defaults). */
export async function updateSkill(
  id: string,
  patch: Partial<Pick<Skill, "whenToUse" | "body" | "hosts" | "keywords" | "pinned" | "sections">>,
): Promise<Skill | null> {
  const all = await loadAll();
  const skill = all.find((s) => s.id === id);
  if (!skill) return null;
  const next: Skill = { ...skill, source: "user" };
  if (typeof patch.whenToUse === "string" && patch.whenToUse.trim()) {
    next.whenToUse = patch.whenToUse.trim();
  }
  if (typeof patch.body === "string" && patch.body.trim()) next.body = patch.body.trim();
  if (patch.hosts !== undefined) next.hosts = patch.hosts.filter(Boolean);
  if (patch.keywords !== undefined) next.keywords = patch.keywords.filter(Boolean);
  if (patch.pinned !== undefined) next.pinned = patch.pinned || undefined;
  if (patch.sections !== undefined) {
    next.sections = patch.sections.length ? patch.sections : undefined;
    if (next.sections) next.body = "";
  }
  if (next.body.length > SKILL_BODY_MAX_CHARS) return null;
  await saveAll(all.map((s) => (s.id === id ? next : s)));
  return next;
}

export async function deleteSkill(id: string): Promise<void> {
  await saveAll((await loadAll()).filter((s) => s.id !== id));
}

/** Which skills a run's catalog carried (staleness bookkeeping). */
export async function markSkillsUsed(ids: string[], at: number = Date.now()): Promise<void> {
  if (!ids.length) return;
  const all = await loadAll();
  for (const skill of all) {
    if (ids.includes(skill.id)) skill.lastUsedAt = at;
  }
  await saveAll(all);
}

/** The bundled defaults, for tests and the smoke script. */
export { BUNDLED_SKILLS };
