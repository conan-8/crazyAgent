/**
 * Companion-owned Diary store, persisted atomically under
 * `.dsh-home/browser-agent/diary.json` with owner-only permissions.
 *
 * Stores reusable user preferences, personal facts (such as preferred emails),
 * and website-specific instructions/workflows. Rejects likely secrets (passwords,
 * API keys, one-time codes, SSNs, card numbers) and prompt-injection payloads.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { isRecord } from './protocol.mjs'
import {
  DIARY_CONTENT_MAX_CHARS,
  DIARY_MAX_ENTRIES,
  DIARY_MAX_SITES_PER_ENTRY,
  DIARY_MAX_SUGGESTIONS_PER_TURN,
  DIARY_MAX_SUPPRESSED,
  DIARY_QUESTION_MAX_CHARS,
  DIARY_TITLE_MAX_CHARS,
  DIARY_VERSION,
  containsLikelySecret,
  formatDiaryPromptBlock,
  hasPromptInjection,
  hostnameFromUrl,
  matchDiaryForTurn,
  normalizeSiteList,
  normalizeSitePattern,
  promptMentionsSite,
  sanitizeDiaryText,
  siteMatchesHost,
  suggestionFingerprint,
} from '../packages/dsh-browser-extension/lib/diary.js'

export {
  DIARY_CONTENT_MAX_CHARS,
  DIARY_MAX_ENTRIES,
  DIARY_MAX_SITES_PER_ENTRY,
  DIARY_MAX_SUGGESTIONS_PER_TURN,
  DIARY_MAX_SUPPRESSED,
  DIARY_QUESTION_MAX_CHARS,
  DIARY_TITLE_MAX_CHARS,
  DIARY_VERSION,
  containsLikelySecret,
  formatDiaryPromptBlock,
  hasPromptInjection,
  hostnameFromUrl,
  matchDiaryForTurn,
  normalizeSiteList,
  normalizeSitePattern,
  promptMentionsSite,
  sanitizeDiaryText,
  siteMatchesHost,
  suggestionFingerprint,
}

function emptyState() {
  return { version: DIARY_VERSION, entries: [], suppressed: [] }
}

function normalizeIso(value, fallback) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback
}

function cloneEntry(entry) {
  return {
    id: entry.id,
    scope: entry.scope,
    sites: [...entry.sites],
    title: entry.title,
    content: entry.content,
    enabled: entry.enabled !== false,
    source: entry.source === 'suggested' ? 'suggested' : 'manual',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

function normalizeStoredEntry(raw, fallbackIso) {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 80) return null
  const scope = raw.scope === 'site' ? 'site' : raw.scope === 'global' ? 'global' : null
  if (scope === null) return null
  const sites = scope === 'site' ? normalizeSiteList(raw.sites).sites : []
  if (scope === 'site' && sites.length === 0) return null
  const title = sanitizeDiaryText(raw.title, DIARY_TITLE_MAX_CHARS)
  const content = sanitizeDiaryText(raw.content, DIARY_CONTENT_MAX_CHARS, { multiline: true })
  if (title.length === 0 || content.length === 0) return null
  if (containsLikelySecret(title) || containsLikelySecret(content)) return null
  if (hasPromptInjection(title) || hasPromptInjection(content)) return null
  const createdAt = normalizeIso(raw.createdAt, fallbackIso)
  const updatedAt = normalizeIso(raw.updatedAt, createdAt)
  return {
    id: raw.id,
    scope,
    sites,
    title,
    content,
    enabled: raw.enabled !== false,
    source: raw.source === 'suggested' ? 'suggested' : 'manual',
    createdAt,
    updatedAt,
  }
}

function normalizeSuppressedItem(raw, fallbackIso) {
  if (!isRecord(raw) || typeof raw.key !== 'string' || raw.key.length === 0 || raw.key.length > 700) return null
  const scope = raw.scope === 'site' ? 'site' : 'global'
  const sites = scope === 'site' ? normalizeSiteList(raw.sites).sites : []
  const summary = sanitizeDiaryText(raw.summary, 140)
  if (summary.length === 0) return null
  return {
    key: raw.key,
    scope,
    sites,
    summary,
    suppressedAt: normalizeIso(raw.suppressedAt, fallbackIso),
  }
}

function validateEntryInput({ scope, sites, title, content, enabled = true, source = 'manual' }) {
  if (scope !== 'global' && scope !== 'site') {
    return { ok: false, code: 'INVALID_SCOPE', error: 'Diary scope must be "global" or "site".' }
  }
  let normalizedSites = []
  if (scope === 'site') {
    const parsedSites = normalizeSiteList(sites)
    if (parsedSites.invalid.length > 0) {
      return {
        ok: false,
        code: 'INVALID_SITES',
        error: `Invalid website domain${parsedSites.invalid.length === 1 ? '' : 's'}: ${parsedSites.invalid.slice(0, 3).join(', ')}. Use hostnames like kimi.ai or mail.google.com.`,
      }
    }
    if (parsedSites.tooMany) {
      return {
        ok: false,
        code: 'INVALID_SITES',
        error: `At most ${DIARY_MAX_SITES_PER_ENTRY} websites are allowed per diary entry.`,
      }
    }
    if (parsedSites.sites.length === 0) {
      return {
        ok: false,
        code: 'INVALID_SITES',
        error: 'Enter at least one valid website domain (for example, kimi.ai) for a site entry.',
      }
    }
    normalizedSites = parsedSites.sites
  }

  const cleanTitle = sanitizeDiaryText(title, DIARY_TITLE_MAX_CHARS)
  if (cleanTitle.length === 0) {
    return { ok: false, code: 'INVALID_TITLE', error: 'Title is required.' }
  }
  const cleanContent = sanitizeDiaryText(content, DIARY_CONTENT_MAX_CHARS, { multiline: true })
  if (cleanContent.length === 0) {
    return { ok: false, code: 'INVALID_CONTENT', error: 'Note text is required.' }
  }
  if (containsLikelySecret(cleanTitle) || containsLikelySecret(cleanContent)) {
    return {
      ok: false,
      code: 'SECRET_REJECTED',
      error: "Don't store passwords, API keys, one-time verification codes, SSNs, or card numbers in the Diary.",
    }
  }
  if (hasPromptInjection(cleanTitle) || hasPromptInjection(cleanContent)) {
    return {
      ok: false,
      code: 'INJECTION_REJECTED',
      error: 'Diary entries cannot include instructions to override safety, confirmation, or system rules.',
    }
  }

  return {
    ok: true,
    value: {
      scope,
      sites: normalizedSites,
      title: cleanTitle,
      content: cleanContent,
      enabled: enabled !== false,
      source: source === 'suggested' ? 'suggested' : 'manual',
    },
  }
}

function readState(file, now, log) {
  if (!existsSync(file)) return emptyState()
  const fallbackIso = now().toISOString()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    backupCorruptFile(file, log)
    return emptyState()
  }
  if (!isRecord(parsed) || parsed.version !== DIARY_VERSION || !Array.isArray(parsed.entries)) {
    backupCorruptFile(file, log)
    return emptyState()
  }

  const entries = []
  const seenIds = new Set()
  for (const raw of parsed.entries) {
    if (entries.length >= DIARY_MAX_ENTRIES) break
    const normalized = normalizeStoredEntry(raw, fallbackIso)
    if (normalized === null || seenIds.has(normalized.id)) continue
    seenIds.add(normalized.id)
    entries.push(normalized)
  }

  const suppressed = []
  const seenKeys = new Set()
  if (Array.isArray(parsed.suppressed)) {
    for (const raw of parsed.suppressed) {
      const normalized = normalizeSuppressedItem(raw, fallbackIso)
      if (normalized === null || seenKeys.has(normalized.key)) continue
      seenKeys.add(normalized.key)
      suppressed.push(normalized)
    }
  }

  return {
    version: DIARY_VERSION,
    entries,
    suppressed: suppressed.slice(-DIARY_MAX_SUPPRESSED),
  }
}

function backupCorruptFile(file, log) {
  try {
    const backup = `${file}.corrupt`
    copyFileSync(file, backup)
    try {
      chmodSync(backup, 0o600)
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    log(`diary: corrupt file backed up to ${backup}`)
  } catch {
    log('diary: corrupt file could not be read; starting empty')
  }
}

function writeAtomic(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(temp, 0o600)
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  renameSync(temp, file)
}

export class DiaryStore {
  /**
   * @param {{file: string, now?: () => Date, log?: (message: string) => void}} options
   */
  constructor({ file, now = () => new Date(), log = () => {} }) {
    this.file = file
    this.now = now
    this.log = log
    this.state = readState(file, now, log)
  }

  snapshot() {
    return {
      version: DIARY_VERSION,
      entries: this.state.entries.map(cloneEntry),
      suppressedCount: this.state.suppressed.length,
    }
  }

  listEnabledSiteEntries() {
    return this.state.entries
      .filter(entry => entry.enabled !== false && entry.scope === 'site' && entry.sites.length > 0)
      .map(entry => ({
        id: entry.id,
        sites: [...entry.sites],
        title: entry.title,
        content: entry.content,
      }))
  }

  /**
   * Bounded view for the post-run suggestion extractor (includes disabled
   * entries so paused items aren't suggested again as brand new).
   * @param {string[]} [visitedHosts]
   */
  listForExtractor(visitedHosts = []) {
    const hosts = Array.isArray(visitedHosts)
      ? visitedHosts.map(host => normalizeSitePattern(host)).filter(Boolean)
      : []
    const siteMatches = []
    const globals = []
    for (const entry of this.state.entries) {
      if (entry.scope === 'global') {
        globals.push(cloneEntry(entry))
      } else if (entry.scope === 'site' && hosts.some(host => entry.sites.some(site => siteMatchesHost(site, host) || siteMatchesHost(host, site)))) {
        siteMatches.push(cloneEntry(entry))
      }
    }
    const existing = [...siteMatches, ...globals].slice(0, 40)
    const suppressed = this.state.suppressed.slice(-25).map(item => ({
      scope: item.scope,
      sites: [...item.sites],
      summary: item.summary,
    }))
    return { existing, suppressed }
  }

  /**
   * @param {{scope?: unknown, sites?: unknown, title?: unknown, content?: unknown, enabled?: unknown, source?: unknown}} input
   */
  create(input) {
    if (this.state.entries.length >= DIARY_MAX_ENTRIES) {
      return {
        ok: false,
        code: 'DIARY_LIMIT_REACHED',
        error: `Diary is full (${DIARY_MAX_ENTRIES} entries max). Delete an old entry before adding another.`,
      }
    }
    const checked = validateEntryInput(input ?? {})
    if (!checked.ok) return checked

    const timestamp = this.now().toISOString()
    const entry = {
      id: `diary-${randomBytes(6).toString('hex')}`,
      ...checked.value,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const next = {
      version: DIARY_VERSION,
      entries: [entry, ...this.state.entries],
      suppressed: this.state.suppressed,
    }
    writeAtomic(this.file, next)
    this.state = next
    return { ok: true, entry: cloneEntry(entry) }
  }

  /**
   * @param {unknown} id
   * @param {Record<string, unknown>} patch
   */
  update(id, patch) {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, code: 'NOT_FOUND', error: 'Diary entry not found.' }
    }
    const index = this.state.entries.findIndex(entry => entry.id === id)
    if (index < 0) {
      return { ok: false, code: 'NOT_FOUND', error: 'Diary entry not found.' }
    }
    const existing = this.state.entries[index]
    const merged = {
      scope: isRecord(patch) && patch.scope !== undefined ? patch.scope : existing.scope,
      sites: isRecord(patch) && patch.sites !== undefined ? patch.sites : existing.sites,
      title: isRecord(patch) && patch.title !== undefined ? patch.title : existing.title,
      content: isRecord(patch) && patch.content !== undefined ? patch.content : existing.content,
      enabled: isRecord(patch) && patch.enabled !== undefined ? patch.enabled === true : existing.enabled,
      source: existing.source,
    }
    const checked = validateEntryInput(merged)
    if (!checked.ok) return checked

    const updated = {
      ...existing,
      ...checked.value,
      updatedAt: this.now().toISOString(),
    }
    const entries = [...this.state.entries]
    entries[index] = updated
    const next = {
      version: DIARY_VERSION,
      entries,
      suppressed: this.state.suppressed,
    }
    writeAtomic(this.file, next)
    this.state = next
    return { ok: true, entry: cloneEntry(updated) }
  }

  /** @param {unknown} id */
  remove(id) {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, code: 'NOT_FOUND', error: 'Diary entry not found.' }
    }
    const index = this.state.entries.findIndex(entry => entry.id === id)
    if (index < 0) {
      return { ok: false, code: 'NOT_FOUND', error: 'Diary entry not found.' }
    }
    const entries = this.state.entries.filter(entry => entry.id !== id)
    const next = {
      version: DIARY_VERSION,
      entries,
      suppressed: this.state.suppressed,
    }
    writeAtomic(this.file, next)
    this.state = next
    return { ok: true }
  }

  /** @param {{scope?: unknown, sites?: unknown, title?: unknown, content?: unknown}} candidate */
  suppress(candidate) {
    const key = suggestionFingerprint(candidate ?? {})
    const scope = candidate?.scope === 'site' ? 'site' : 'global'
    const sites = scope === 'site' ? normalizeSiteList(candidate?.sites ?? []).sites : []
    const title = sanitizeDiaryText(candidate?.title ?? '', DIARY_TITLE_MAX_CHARS)
    const content = sanitizeDiaryText(candidate?.content ?? '', DIARY_CONTENT_MAX_CHARS)
    const summary = sanitizeDiaryText(title && content ? `${title}: ${content}` : (title || content), 140)
    if (!summary) return { ok: false }
    const item = {
      key,
      scope,
      sites,
      summary,
      suppressedAt: this.now().toISOString(),
    }
    const filtered = this.state.suppressed.filter(existing => existing.key !== key)
    const next = {
      version: DIARY_VERSION,
      entries: this.state.entries,
      suppressed: [...filtered, item].slice(-DIARY_MAX_SUPPRESSED),
    }
    writeAtomic(this.file, next)
    this.state = next
    return { ok: true }
  }

  /** @param {{scope?: unknown, sites?: unknown, title?: unknown, content?: unknown}} candidate */
  isSuppressed(candidate) {
    const key = suggestionFingerprint(candidate ?? {})
    return this.state.suppressed.some(item => item.key === key)
  }

  clearSuppressed() {
    const cleared = this.state.suppressed.length
    if (cleared === 0) return { ok: true, cleared: 0 }
    const next = {
      version: DIARY_VERSION,
      entries: this.state.entries,
      suppressed: [],
    }
    writeAtomic(this.file, next)
    this.state = next
    return { ok: true, cleared }
  }
}
