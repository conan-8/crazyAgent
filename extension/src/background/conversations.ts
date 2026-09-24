// Conversation persistence (chat history) in chrome.storage.local.
import type { Conversation } from "../shared/chat";

const KEY = "baConversations";
const MAX = 50;

async function loadAll(): Promise<Conversation[]> {
  const out = await chrome.storage.local.get(KEY);
  return (out[KEY] as Conversation[] | undefined) ?? [];
}

async function saveAll(conversations: Conversation[]): Promise<void> {
  const sorted = [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX);
  await chrome.storage.local.set({ [KEY]: sorted });
}

export async function listConversations(): Promise<Conversation[]> {
  return (await loadAll()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<Conversation | null> {
  return (await loadAll()).find((c) => c.id === id) ?? null;
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const all = await loadAll();
  const index = all.findIndex((c) => c.id === conv.id);
  if (index === -1) all.push(conv);
  else all[index] = conv;
  await saveAll(all);
}

export async function deleteConversation(id: string): Promise<void> {
  await saveAll((await loadAll()).filter((c) => c.id !== id));
}
