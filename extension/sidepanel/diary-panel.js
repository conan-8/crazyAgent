/**
 * Pure Diary state normalization, search/filter, URL/site parsing, and
 * activity formatting helpers shared by `app.js` and `extension/test/diary-panel.test.mjs`.
 *
 * Dependency-free: no `chrome`, `window`, or DOM access.
 */

export const DIARY_TITLE_MAX_CHARS = 80
export const DIARY_CONTENT_MAX_CHARS = 500
export const DIARY_MAX_SITES = 5

const CONTROL_CHARS_ALL = /[\u0000-\u001f\u007f]/u
const DISALLOWED_SCHEMES = /^(?:chrome|edge|file|javascript|data|about|chrome-extension|moz-extension|vbscript):/iu
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/u

const BARE_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'co.in', 'co.nz',
  'com.cn', 'com.tw', 'com.hk',
  'com.sg', 'co.kr', 'com.mx', 'co.za',
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidHostLabel(label) {
  return label.length >= 1
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
    && /^[a-z0-9-]+$/u.test(label)
}

function normalizeSitePattern(raw) {
  if (typeof raw !== 'string') return null
  let trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 255 || CONTROL_CHARS_ALL.test(trimmed) || /\s/u.test(trimmed)) {
    return null
  }
  if (DISALLOWED_SCHEMES.test(trimmed)) return null

  if (trimmed.includes('://')) {
    if (!/^https?:\/\//iu.test(trimmed)) return null
    trimmed = trimmed.replace(/^(https?:\/\/)\*\./iu, '$1')
  } else {
    if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:\/|$))/iu.test(trimmed)) return null
    if (trimmed.startsWith('*.')) trimmed = trimmed.slice(2)
    trimmed = `https://${trimmed}`
  }

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null

  const host = parsed.hostname.toLowerCase().replace(/\.+$/u, '').replace(/^www\./u, '')
  if (host.length === 0 || host.length > 253 || !/^[a-z0-9.-]+$/u.test(host)) return null
  if (host === 'localhost' || host === '127.0.0.1') return host
  if (IPV4_LITERAL.test(host)) return null

  const labels = host.split('.')
  if (labels.length < 2) return null
  if (labels.some(label => !isValidHostLabel(label))) return null
  const tld = labels.at(-1)
  if (!tld || (!/^[a-z]{2,}$/u.test(tld) && !/^xn--[a-z0-9-]{2,}$/u.test(tld))) return null
  if (BARE_PUBLIC_SUFFIXES.has(host)) return null

  return host
}

/**
 * Client-side preview parser matching companion `normalizeSiteList`.
 * @param {unknown} text
 * @returns {{sites: string[], invalid: string[], tooMany: boolean}}
 */
export function parseSitesInput(text) {
  const parts = Array.isArray(text)
    ? text.map(item => String(item ?? '').trim())
    : typeof text === 'string'
      ? text.split(/[\s,;]+/u).map(item => item.trim())
      : []

  const valid = []
  const seen = new Set()
  const invalid = []
  for (const part of parts) {
    if (!part) continue
    const normalized = normalizeSitePattern(part)
    if (normalized === null) {
      invalid.push(part.slice(0, 80))
      continue
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    valid.push(normalized)
  }
  return {
    sites: valid.slice(0, DIARY_MAX_SITES),
    invalid,
    tooMany: valid.length > DIARY_MAX_SITES,
  }
}

/**
 * Extract normalized HTTP(S) hostname from the active browser tab URL, or null
 * for browser-internal/file/empty URLs.
 * @param {unknown} url
 * @returns {string | null}
 */
export function siteFromTabUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/\.+$/u, '').replace(/^www\./u, '')
  return host.length > 0 ? host : null
}

function normalizeDiaryEntry(raw) {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return null
  const scope = raw.scope === 'site' ? 'site' : raw.scope === 'global' ? 'global' : null
  if (scope === null) return null
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (title.length === 0 || content.length === 0) return null
  const sites = scope === 'site' && Array.isArray(raw.sites)
    ? raw.sites.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim().toLowerCase())
    : []
  if (scope === 'site' && sites.length === 0) return null
  return {
    id: raw.id,
    scope,
    sites,
    title,
    content,
    enabled: raw.enabled !== false,
    source: raw.source === 'suggested' ? 'suggested' : 'manual',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

/**
 * Normalize a `diary.state` or `chat.hello.diary` payload.
 * @param {unknown} value
 * @returns {{version: number, entries: Array<Record<string, any>>, suppressedCount: number}}
 */
export function normalizeDiarySnapshot(value) {
  const snapshot = isRecord(value) ? value : {}
  const rawEntries = Array.isArray(snapshot.entries) ? snapshot.entries : []
  const entries = []
  const seen = new Set()
  for (const raw of rawEntries) {
    const entry = normalizeDiaryEntry(raw)
    if (entry === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  const suppressedCount = Number.isSafeInteger(snapshot.suppressedCount) && snapshot.suppressedCount >= 0
    ? snapshot.suppressedCount
    : 0
  return { version: 1, entries, suppressedCount }
}

/**
 * Normalize a `diary.suggestions` or `chat.hello.diarySuggestions` list.
 * @param {unknown} value
 * @returns {Array<Record<string, any>>}
 */
export function normalizeDiarySuggestions(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || seen.has(raw.id)) continue
    const scope = raw.scope === 'site' ? 'site' : raw.scope === 'global' ? 'global' : null
    if (scope === null) continue
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    const content = typeof raw.content === 'string' ? raw.content.trim() : ''
    if (title.length === 0 || content.length === 0) continue
    const sites = scope === 'site' && Array.isArray(raw.sites)
      ? raw.sites.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim().toLowerCase())
      : []
    if (scope === 'site' && sites.length === 0) continue
    const action = raw.action === 'update' ? 'update' : 'add'
    const replacesId = action === 'update' && typeof raw.replacesId === 'string' && raw.replacesId.length > 0
      ? raw.replacesId
      : null
    const prev = action === 'update' && isRecord(raw.previousEntry)
      ? {
          id: typeof raw.previousEntry.id === 'string' ? raw.previousEntry.id : replacesId ?? '',
          scope: raw.previousEntry.scope === 'site' ? 'site' : 'global',
          sites: Array.isArray(raw.previousEntry.sites) ? raw.previousEntry.sites.map(String) : [],
          title: typeof raw.previousEntry.title === 'string' ? raw.previousEntry.title : '',
          content: typeof raw.previousEntry.content === 'string' ? raw.previousEntry.content : '',
        }
      : null
    const question = typeof raw.question === 'string' && raw.question.trim().length > 0
      ? raw.question.trim()
      : `Save "${title}" to your Diary?`
    seen.add(raw.id)
    out.push({
      id: raw.id,
      action,
      replacesId,
      ...(prev ? { previousEntry: prev } : {}),
      scope,
      sites,
      title,
      content,
      question,
    })
  }
  return out
}

/**
 * Filter normalized Diary entries by scope and free-text query.
 * @param {Array<Record<string, any>>} entries
 * @param {{query?: string, scope?: 'all' | 'global' | 'site'}} [options]
 */
export function filterDiaryEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  const scope = options.scope === 'global' || options.scope === 'site' ? options.scope : 'all'
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''

  return list.filter(entry => {
    if (!entry) return false
    if (scope !== 'all' && entry.scope !== scope) return false
    if (!query) return true
    if (String(entry.title ?? '').toLowerCase().includes(query)) return true
    if (String(entry.content ?? '').toLowerCase().includes(query)) return true
    if (Array.isArray(entry.sites) && entry.sites.some(site => String(site).toLowerCase().includes(query))) return true
    return false
  })
}

/**
 * Format a compact plain-text line for `diary-applied` activity rows.
 * @param {Record<string, any>} frame
 * @returns {string}
 */
export function formatDiaryAppliedText(frame) {
  const host = typeof frame?.host === 'string' && frame.host.trim().length > 0 ? frame.host.trim() : ''
  const titles = Array.isArray(frame?.titles)
    ? frame.titles.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []
  const count = Number.isFinite(Number(frame?.count)) && Number(frame.count) > 0 ? Math.floor(Number(frame.count)) : 1
  const prefix = host ? `Diary (${host})` : 'Diary'
  const body = titles.length > 0 ? titles.join(', ') : `${count} ${count === 1 ? 'note' : 'notes'} applied`
  const full = `${prefix}: ${body}`
  return full.length > 160 ? `${full.slice(0, 159)}…` : full
}

/**
 * Merge newly applied diary entries into a turn's running list, deduplicating
 * by case-insensitive title and moving repeated entries to the end as latest.
 * @param {Array<{title: string, host: string, count?: number}>} existing
 * @param {Record<string, any>} frame
 */
export function mergeDiaryAppliedEntries(existing, frame) {
  const list = Array.isArray(existing) ? existing.map(item => ({ ...item })) : []
  const host = typeof frame?.host === 'string' && frame.host.trim().length > 0 ? frame.host.trim() : ''
  const titles = Array.isArray(frame?.titles)
    ? frame.titles.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []
  const count = Number.isFinite(Number(frame?.count)) && Number(frame.count) > 0 ? Math.floor(Number(frame.count)) : 1

  if (titles.length > 0) {
    for (const title of titles) {
      const key = title.toLowerCase()
      let prevHost = ''
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].title && list[i].title.toLowerCase() === key) {
          if (!prevHost && list[i].host) prevHost = list[i].host
          list.splice(i, 1)
        }
      }
      list.push({ title, host: host || prevHost })
    }
    return list
  }

  list.push({ title: '', host, count })
  return list
}

/**
 * Format a compact running-turn header pill + full tooltip from merged diary entries.
 * @param {Array<{title: string, host: string, count?: number}>} entries
 */
export function formatDiaryHeaderPill(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  if (list.length === 0) {
    return { visible: false, latest: '', overflow: 0, text: '', tooltip: '' }
  }

  const named = []
  let unnamedTotal = 0
  const lines = []
  for (const item of list) {
    if (item.title) {
      named.push(item)
      lines.push(item.host ? `${item.title} (${item.host})` : item.title)
    } else {
      const n = Number.isFinite(Number(item.count)) && Number(item.count) > 0 ? Math.floor(Number(item.count)) : 1
      unnamedTotal += n
      const label = `${n} ${n === 1 ? 'note' : 'notes'}`
      lines.push(item.host ? `${label} (${item.host})` : label)
    }
  }

  const total = named.length + unnamedTotal
  const latest = named.length > 0
    ? named[named.length - 1].title
    : `${total} ${total === 1 ? 'note' : 'notes'}`
  const overflow = named.length > 0 ? Math.max(0, total - 1) : 0
  const text = overflow > 0 ? `Diary · ${latest} +${overflow}` : `Diary · ${latest}`
  const tooltip = `Diary applied:\n${lines.map(line => `• ${line}`).join('\n')}`
  return { visible: true, latest, overflow, text, tooltip }
}
