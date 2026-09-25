// Lesson persistence in chrome.storage.local — a per-browser-profile store,
// deliberately its own key (`baLessons`) next to the settings, conversations
// and run-log stores, so lessons survive worker teardown and browser restarts
// and never leak between browser profiles.
import {
  LESSONS_KEY,
  LESSONS_MAX,
  mergeLessons,
  type Lesson,
} from "../shared/lessons";

async function loadAll(): Promise<Lesson[]> {
  const out = await chrome.storage.local.get(LESSONS_KEY);
  const raw = out[LESSONS_KEY] as Lesson[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

async function saveAll(lessons: Lesson[]): Promise<void> {
  await chrome.storage.local.set({ [LESSONS_KEY]: lessons.slice(0, LESSONS_MAX) });
}

/**
 * Replace the whole store. Exported for the coach's `save` hook, which hands
 * over an already-merged list (merge itself is pure, in shared/lessons.ts).
 */
export async function saveLessons(lessons: Lesson[]): Promise<void> {
  await saveAll(lessons);
}

/** Every lesson, newest first. */
export async function listLessons(): Promise<Lesson[]> {
  return (await loadAll()).sort((a, b) => b.at - a.at);
}

/** Merge freshly learned lessons in (dedupe + ring cap). */
export async function addLessons(
  incoming: Lesson[],
): Promise<{ added: number; merged: number; total: number }> {
  const { lessons, added, merged } = mergeLessons(await loadAll(), incoming, LESSONS_MAX);
  await saveAll(lessons);
  return { added, merged, total: lessons.length };
}

/** Edit one lesson — the user owns the wording; reviews never clobber it. */
export async function updateLesson(
  id: string,
  patch: Partial<Pick<Lesson, "text" | "evidence" | "category" | "pinned">>,
): Promise<Lesson | null> {
  const all = await loadAll();
  const lesson = all.find((l) => l.id === id);
  if (!lesson) return null;
  if (typeof patch.text === "string" && patch.text.trim()) lesson.text = patch.text.trim();
  if (patch.evidence !== undefined) lesson.evidence = patch.evidence;
  if (patch.category !== undefined) lesson.category = patch.category;
  if (patch.pinned !== undefined) lesson.pinned = patch.pinned || undefined;
  await saveAll(all);
  return lesson;
}

export async function deleteLesson(id: string): Promise<void> {
  await saveAll((await loadAll()).filter((l) => l.id !== id));
}

export async function clearLessons(): Promise<void> {
  await saveAll([]);
}

/** Remember which lessons a run's prompt carried (staleness bookkeeping). */
export async function markLessonsUsed(ids: string[], at: number = Date.now()): Promise<void> {
  if (!ids.length) return;
  const all = await loadAll();
  for (const lesson of all) {
    if (ids.includes(lesson.id)) lesson.lastUsedAt = at;
  }
  await saveAll(all);
}