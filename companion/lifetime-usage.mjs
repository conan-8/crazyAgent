/**
 * Companion-owned lifetime agent-token totals. Stored beside the other durable
 * browser-agent state so companion restarts and release updates preserve them.
 * Watcher/judge usage remains separate and is not included.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isRecord } from './protocol.mjs'

const MAX_TRACKED_TURN_IDS = 256
const MAX_COUNT = Number.MAX_SAFE_INTEGER

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.min(MAX_COUNT, Math.floor(number)) : 0
}

function add(left, right) {
  return Math.min(MAX_COUNT, count(left) + count(right))
}

function timestamp(value, fallback = null) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback
}

function roundUsd(value) {
  return Math.round(value * 1e8) / 1e8
}

function validCost(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? roundUsd(number) : null
}

function costAmount(value) {
  return validCost(value) ?? 0
}

/**
 * Estimate USD cost for one turn from token counts and OpenRouter per-token rates.
 * `reasoningTokens` is already included in `outputTokens`, so it is not billed twice.
 */
export function estimateUsageCostUsd(usage, pricing) {
  if (!isRecord(pricing)) return 0
  const normalized = normalizeTokenUsage(usage)
  const promptRate = validCost(pricing.prompt)
  const completionRate = validCost(pricing.completion)
  if (promptRate === null && completionRate === null) return 0
  const cacheReadRate = validCost(pricing.cacheRead) ?? validCost(pricing.input_cache_read) ?? promptRate ?? 0
  const cacheWriteRate = validCost(pricing.cacheWrite) ?? validCost(pricing.input_cache_write) ?? promptRate ?? 0
  const total = normalized.inputTokens * (promptRate ?? 0)
    + normalized.outputTokens * (completionRate ?? 0)
    + normalized.cacheReadTokens * cacheReadRate
    + normalized.cacheWriteTokens * cacheWriteRate
  return costAmount(total)
}

/** Input/cache-read/cache-write/output are disjoint; reasoning is part of output. */
export function normalizeTokenUsage(value) {
  const usage = isRecord(value) ? value : {}
  const normalized = {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    reasoningTokens: Math.min(count(usage.reasoningTokens), count(usage.outputTokens)),
  }
  const componentTotal = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .reduce((total, key) => add(total, normalized[key]), 0)
  normalized.totalTokens = Math.max(count(usage.totalTokens), componentTotal)
  return normalized
}

function emptyState(now) {
  return {
    turns: 0,
    ...normalizeTokenUsage(),
    totalCostUsd: 0,
    startedAt: now().toISOString(),
    updatedAt: null,
    processedTurnIds: [],
  }
}

function readState(file, now) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return emptyState(now)
  }
  if (!isRecord(parsed) || parsed.version !== 1) return emptyState(now)
  const usage = normalizeTokenUsage(parsed)
  const processedTurnIds = Array.isArray(parsed.processedTurnIds)
    ? [...new Set(parsed.processedTurnIds.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 160))].slice(-MAX_TRACKED_TURN_IDS)
    : []
  return {
    turns: count(parsed.turns),
    ...usage,
    totalCostUsd: costAmount(parsed.totalCostUsd),
    startedAt: timestamp(parsed.startedAt, now().toISOString()),
    updatedAt: timestamp(parsed.updatedAt),
    processedTurnIds,
  }
}

export class LifetimeUsageStore {
  constructor({ file, now = () => new Date() }) {
    this.file = file
    this.now = now
    this.state = readState(file, now)
  }

  snapshot() {
    return {
      version: 1,
      turns: this.state.turns,
      inputTokens: this.state.inputTokens,
      outputTokens: this.state.outputTokens,
      cacheReadTokens: this.state.cacheReadTokens,
      cacheWriteTokens: this.state.cacheWriteTokens,
      reasoningTokens: this.state.reasoningTokens,
      totalTokens: this.state.totalTokens,
      totalCostUsd: this.state.totalCostUsd,
      startedAt: this.state.startedAt,
      updatedAt: this.state.updatedAt,
    }
  }

  record(turnId, value, options = {}) {
    const usage = normalizeTokenUsage(value)
    if (typeof turnId !== 'string' || turnId.length === 0 || turnId.length > 160
      || usage.totalTokens === 0 || this.state.processedTurnIds.includes(turnId)) {
      return { changed: false, usage: this.snapshot() }
    }
    const turnCost = validCost(options?.costUsd) ?? validCost(value?.costUsd) ?? estimateUsageCostUsd(usage, options?.pricing)
    const next = {
      turns: add(this.state.turns, 1),
      inputTokens: add(this.state.inputTokens, usage.inputTokens),
      outputTokens: add(this.state.outputTokens, usage.outputTokens),
      cacheReadTokens: add(this.state.cacheReadTokens, usage.cacheReadTokens),
      cacheWriteTokens: add(this.state.cacheWriteTokens, usage.cacheWriteTokens),
      reasoningTokens: add(this.state.reasoningTokens, usage.reasoningTokens),
      totalTokens: add(this.state.totalTokens, usage.totalTokens),
      totalCostUsd: roundUsd(this.state.totalCostUsd + (turnCost ?? 0)),
      startedAt: this.state.startedAt,
      updatedAt: this.now().toISOString(),
      processedTurnIds: [...this.state.processedTurnIds, turnId].slice(-MAX_TRACKED_TURN_IDS),
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { mode: 0o600 })
    try {
      chmodSync(temp, 0o600)
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    renameSync(temp, this.file)
    this.state = next
    return { changed: true, usage: this.snapshot() }
  }
}
