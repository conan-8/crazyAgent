/**
 * OpenRouter model catalog, configuration, and generated DSH patch.
 *
 * The companion fetches the full text-chat model list with image/tool
 * capability flags and writes a small llm-pi-ai overlay targeting the selected
 * model. The API key stays in the companion/DSH
 * environment and is never written to these files.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import yaml from 'js-yaml'

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
export const MODEL_CACHE_MS = 5 * 60 * 1000
export const RECOMMENDED_MODEL_ID = 'deepseek/deepseek-v4.1-flash-1017'
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const REASONING_POLICIES = ['auto', ...THINKING_LEVELS]

/** @param {unknown} value @returns {'auto'|'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'} */
export function normalizeReasoningEffort(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return REASONING_POLICIES.includes(text) ? text : 'auto'
}

/**
 * Filter and order effort values into canonical DSH thinking levels.
 * @param {unknown} efforts
 * @param {boolean} reasoning
 * @param {boolean} [mandatory]
 * @returns {Array<'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'>|undefined}
 */
function sanitizeEffortList(efforts, reasoning, mandatory = false) {
  if (reasoning !== true) return []
  if (!Array.isArray(efforts)) return undefined
  const picked = new Set()
  for (const item of efforts) {
    if (typeof item !== 'string') continue
    const normalized = item.trim().toLowerCase() === 'none' ? 'off' : item.trim().toLowerCase()
    if (normalized === 'off' && mandatory) continue
    if (THINKING_LEVELS.includes(normalized)) picked.add(normalized)
  }
  return THINKING_LEVELS.filter(level => picked.has(level))
}

/**
 * Normalize OpenRouter's per-model `reasoning` metadata into ordered DSH thinking levels.
 * Maps OpenRouter `'none'` to `'off'`, excludes `'off'` when reasoning is mandatory,
 * and returns `[]` for non-reasoning models.
 * @param {unknown} rawReasoning
 * @param {boolean} reasoning
 * @returns {Array<'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'>}
 */
export function normalizeSupportedEfforts(rawReasoning, reasoning) {
  if (reasoning !== true) return []
  const meta = rawReasoning && typeof rawReasoning === 'object' ? rawReasoning : null
  const mandatory = meta?.mandatory === true
  const normalized = sanitizeEffortList(meta?.supported_efforts, true, mandatory)
  if (normalized && normalized.length > 0) return normalized
  return mandatory ? ['low', 'medium', 'high'] : ['off', 'low', 'medium', 'high']
}

/** @param {'auto'|'off'|'low'|'medium'|'high'} policy */
export function baseEffortFor(policy) {
  return policy === 'auto' ? 'low' : policy
}

/** @param {unknown} value */
export function normalizeBaseUrl(value) {
  const text = typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_BASE_URL
  return text.replace(/\/+$/u, '')
}

function parsePrice(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * @param {Record<string, any>} raw
 * @returns {Record<string, any> | undefined}
 */
export function mapModel(raw) {
  if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  const inputs = Array.isArray(raw.architecture?.input_modalities) ? raw.architecture.input_modalities : []
  const outputs = Array.isArray(raw.architecture?.output_modalities) ? raw.architecture.output_modalities : []
  const modality = String(raw.architecture?.modality ?? '')
  const supportsImage = inputs.includes('image') || modality.includes('image')
  if (outputs.length > 0 && !outputs.includes('text')) return undefined
  const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined
  const supportsTools = parameters === undefined || parameters.includes('tools')
  const reasoning = parameters !== undefined
    && (parameters.includes('reasoning') || parameters.includes('reasoning_effort') || parameters.includes('include_reasoning'))

  const contextWindow = Number(raw.context_length) > 0 ? Math.round(Number(raw.context_length)) : 128_000
  const rawMax = Number(raw.top_provider?.max_completion_tokens ?? raw.max_completion_tokens)
  const maxTokens = Number.isFinite(rawMax) && rawMax > 0 ? Math.round(rawMax) : 8_192
  const prompt = parsePrice(raw.pricing?.prompt)
  const completion = parsePrice(raw.pricing?.completion)
  const cacheRead = parsePrice(raw.pricing?.input_cache_read)
  const cacheWrite = parsePrice(raw.pricing?.input_cache_write)
  const reasoningMandatory = raw.reasoning?.mandatory === true
  const reasoningEfforts = normalizeSupportedEfforts(raw.reasoning, reasoning)

  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.id,
    contextWindow,
    maxTokens,
    reasoning,
    reasoningEfforts,
    reasoningMandatory,
    imageInput: supportsImage,
    tools: supportsTools,
    pricing: {
      prompt,
      completion,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    description: typeof raw.description === 'string' ? raw.description.slice(0, 240) : undefined,
  }
}

/**
 * @param {string} baseUrl
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function fetchModels(baseUrl = DEFAULT_BASE_URL, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${normalizeBaseUrl(baseUrl)}/models`
  let response
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'crazyAgent',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
  } catch (error) {
    throw new Error(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`Model list returned HTTP ${response.status} from ${url}`)
  let body
  try {
    body = await response.json()
  } catch {
    throw new Error(`Model list from ${url} is not valid JSON`)
  }
  const data = Array.isArray(body?.data) ? body.data : []
  const models = data.map(mapModel).filter(Boolean)
  models.sort((a, b) => a.name.localeCompare(b.name))
  return models
}

/**
 * Validate an OpenRouter key against GET /key. A missing endpoint (404) is
 * tolerated for compatible gateways; 401/403 are rejected.
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function validateApiKey(baseUrl, apiKey, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${normalizeBaseUrl(baseUrl)}/key`
  let response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
  } catch (error) {
    throw new Error(`Could not validate the API key at ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status === 401 || response.status === 403) throw new Error('OpenRouter rejected the API key (401/403)')
  // 404/405 means the compatible gateway has no /key endpoint; treat it as
  // unvalidated rather than blocking a valid gateway on a server-side issue.
  return true
}

/** @param {string} baseUrl @param {Record<string, any>} model @param {string} [reasoningEffort] */
export function buildLlmConfig(baseUrl, model, reasoningEffort = 'auto') {
  const reasoning = model.reasoning === true
  const reasoningMandatory = reasoning && model.reasoningMandatory === true
  const reasoningEfforts = sanitizeEffortList(model.reasoningEfforts, reasoning, reasoningMandatory)
  return {
    provider: 'openrouter',
    baseUrl: normalizeBaseUrl(baseUrl),
    reasoningEffort: normalizeReasoningEffort(reasoningEffort),
    model: {
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning,
      ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
      ...(typeof model.reasoningMandatory === 'boolean' ? { reasoningMandatory } : {}),
      pricing: model.pricing,
    },
    updatedAt: new Date().toISOString(),
  }
}

/**
 * @param {Record<string, any>} model
 * @param {number | undefined} [requested]
 */
export function resolveRequestMaxTokens(model, requested) {
  const modelMaximum = Number(model.maxTokens) > 0 ? Math.round(Number(model.maxTokens)) : 8_192
  return requested === undefined ? modelMaximum : Math.min(requested, modelMaximum)
}

/** @param {string} path */
export function readLlmConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    if (parsed.provider !== 'openrouter') return undefined
    if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl.length === 0) return undefined
    if (!parsed.model || typeof parsed.model.id !== 'string' || parsed.model.id.length === 0) return undefined
    const reasoning = parsed.model.reasoning === true
    const reasoningMandatory = reasoning && parsed.model.reasoningMandatory === true
    const reasoningEfforts = sanitizeEffortList(parsed.model.reasoningEfforts, reasoning, reasoningMandatory)
    return {
      provider: 'openrouter',
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      reasoningEffort: normalizeReasoningEffort(parsed.reasoningEffort),
      model: {
        id: parsed.model.id,
        name: typeof parsed.model.name === 'string' ? parsed.model.name : parsed.model.id,
        contextWindow: Number(parsed.model.contextWindow) > 0 ? Math.round(Number(parsed.model.contextWindow)) : 128_000,
        maxTokens: Number(parsed.model.maxTokens) > 0 ? Math.round(Number(parsed.model.maxTokens)) : 8_192,
        reasoning,
        ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
        ...(typeof parsed.model.reasoningMandatory === 'boolean' ? { reasoningMandatory } : {}),
        pricing: parsed.model.pricing,
      },
      updatedAt: parsed.updatedAt,
    }
  } catch {
    return undefined
  }
}

/** @param {string} path @param {Record<string, any>} config */
export function writeLlmConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

/** @param {Record<string, any>} config */
export function buildLlmPatch(config) {
  const model = config.model
  const provider = {
    displayName: 'OpenRouter',
    apiKeyEnv: 'CRAZYAGENT_API_KEY',
    api: 'openai-completions',
    baseURL: normalizeBaseUrl(config.baseUrl),
    headers: {
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'crazyAgent',
    },
    // DSH has no infinite setting; its maximum prevents the five-minute
    // idle watchdog from cutting off slow reasoning. No HTTP timeout is set.
    streamIdleTimeoutMs: 2_147_483_647,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      ...(model.reasoning === true
        ? { supportsReasoningEffort: true, thinkingFormat: 'openrouter' }
        : { supportsReasoningEffort: false }),
    },
    models: [
      {
        id: model.id,
        name: model.name,
        contextWindow: Math.max(1_000, Math.round(model.contextWindow)),
        maxTokens: Math.max(1, Math.round(model.maxTokens)),
        input: ['text', 'image'],
        ...(model.reasoning === true
          ? {
            // `off` must be a wire spelling ("none"), not null: null means
            // "omit the field", which leaves the provider's default reasoning on.
            reasoningEfforts: {
              off: 'none',
              minimal: 'minimal',
              low: 'low',
              medium: 'medium',
              high: 'high',
              xhigh: 'xhigh',
              max: 'max',
            },
          }
          : {}),
      },
    ],
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    maxRequestImageBytes: 16_777_216,
  }
  const patch = [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          openrouter: provider,
        },
      },
    },
  ]
  return yaml.dump(patch, { lineWidth: 120, noRefs: true })
}

/** @param {string} path @param {Record<string, any>} config */
export function writeLlmPatch(path, config) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buildLlmPatch(config), 'utf8')
}

/**
 * @param {Record<string, any>[]} models
 * @param {string} id
 */
export function findModel(models, id) {
  return models.find(model => model.id === id)
}
