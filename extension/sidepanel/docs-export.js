const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRIES = 2
const MIN_EXPORT_INTERVAL_MS = 250
const exportQueues = new Map()
const exportCooldowns = new Map()
const exportAttempts = new Map()

function exportFailure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function docsDocumentId(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return undefined
    const match = /^\/document\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/u.exec(url.pathname)
    return match?.[1]
  } catch {
    return undefined
  }
}

export function docsExportUrl(value, format = 'html') {
  const id = docsDocumentId(value)
  if (!id || !['html', 'txt'].includes(format)) return undefined
  return `https://docs.google.com/document/d/${id}/export?format=${format}`
}

export function docsExportRetryDelayMs(retryAfter, attempt) {
  const seconds = retryAfter !== null && /^\s*\d+(?:\.\d+)?\s*$/u.test(retryAfter ?? '') ? Number(retryAfter) : Number.NaN
  if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(250, Math.round(seconds * 1_000)))
  return 1_200 * (attempt + 1)
}

async function performExport(tabUrl, format, io, target, coordinated) {
  const fetcher = io.fetch ?? fetch
  const sleep = io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = io.now ?? (() => Date.now())
  const timeoutMs = io.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = io.retries ?? DEFAULT_RETRIES
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (coordinated) exportAttempts.set(target, now())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(target, { credentials: 'include', redirect: 'follow', signal: controller.signal })
      if ([429, 503].includes(response.status)) {
        const delay = docsExportRetryDelayMs(response.headers?.get?.('retry-after') ?? null, attempt)
        if (coordinated) exportCooldowns.set(target, now() + delay)
        if (attempt < retries) {
          await sleep(delay)
          continue
        }
      }
      if (!response.ok) {
        const code = [401, 403].includes(response.status) ? 'DOCS_EXPORT_PERMISSION'
          : response.status === 404 ? 'DOCS_EXPORT_NOT_FOUND'
            : [429, 503].includes(response.status) ? 'DOCS_EXPORT_RATE_LIMIT' : 'DOCS_EXPORT_HTTP'
        throw exportFailure(code, `Docs export returned ${response.status}; no document mutation was attempted by this read`)
      }
      if (coordinated) exportCooldowns.delete(target)
      return { body: await response.text(), id: docsDocumentId(tabUrl), url: target }
    } catch (error) {
      if (error?.code?.startsWith('DOCS_')) throw error
      const timedOut = controller.signal.aborted
      throw exportFailure(timedOut ? 'DOCS_EXPORT_TIMEOUT' : 'DOCS_EXPORT_FAILED', `Docs export ${timedOut ? `timed out after ${timeoutMs}ms` : 'failed'}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  throw exportFailure('DOCS_EXPORT_FAILED', 'Docs export exhausted its bounded attempts')
}

export async function docsFetchExport(tabUrl, format = 'html', io = {}) {
  const target = docsExportUrl(tabUrl, format)
  if (!target) throw exportFailure('DOCS_EXPORT_URL_UNSUPPORTED', 'A supported https://docs.google.com/document/d/ URL is required')
  const coordinated = io.coordinate ?? !io.fetch
  if (!coordinated) return performExport(tabUrl, format, io, target, false)
  const now = io.now ?? (() => Date.now())
  const sleep = io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const previous = exportQueues.get(target) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    const lastAttempt = exportAttempts.get(target)
    const nextAttempt = lastAttempt === undefined ? 0 : lastAttempt + MIN_EXPORT_INTERVAL_MS
    const wait = Math.max(exportCooldowns.get(target) ?? 0, nextAttempt) - now()
    if (wait > 0) await sleep(wait)
    return performExport(tabUrl, format, io, target, true)
  })
  const gate = run.catch(() => {})
  exportQueues.set(target, gate)
  try {
    return await run
  } finally {
    if (exportQueues.get(target) === gate) exportQueues.delete(target)
  }
}
