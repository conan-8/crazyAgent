const MAX_COUNT = Number.MAX_SAFE_INTEGER

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.min(MAX_COUNT, Math.floor(number)) : 0
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

export function normalizeLifetimeUsage(value) {
  const usage = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const normalized = {
    turns: count(usage.turns),
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    reasoningTokens: Math.min(count(usage.reasoningTokens), count(usage.outputTokens)),
    totalTokens: 0,
    startedAt: timestamp(usage.startedAt),
    updatedAt: timestamp(usage.updatedAt),
  }
  const componentTotal = Math.min(MAX_COUNT, normalized.inputTokens + normalized.outputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens)
  normalized.totalTokens = Math.max(count(usage.totalTokens), componentTotal)
  return normalized
}

export function formatCompactTokenCount(value) {
  const tokens = count(value)
  if (tokens < 1000) return String(tokens)
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)
}

export function lifetimeUsageSegments(value) {
  const usage = normalizeLifetimeUsage(value)
  const segments = [
    { key: 'input', label: 'Uncached input', value: usage.inputTokens },
    { key: 'cache-read', label: 'Cached reads', value: usage.cacheReadTokens },
    { key: 'cache-write', label: 'Cache writes', value: usage.cacheWriteTokens },
    { key: 'output', label: 'Output', value: usage.outputTokens },
  ]
  return segments.map(segment => ({ ...segment, percent: usage.totalTokens > 0 ? Math.min(100, segment.value / usage.totalTokens * 100) : 0 }))
}
