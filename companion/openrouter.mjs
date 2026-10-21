/**
 * OpenRouter model catalog, configuration, and generated DSH patch.
 *
 * The companion fetches the public model list, filters to chat models that
 * accept images and support tool calls, and writes a small llm-pi-ai overlay
 * targeting the selected model. The API key stays in the companion/DSH
 * environment and is never written to these files.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import yaml from 'js-yaml'

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
export const MODEL_CACHE_MS = 5 * 60 * 1000
export const RECOMMENDED_MODEL_ID = 'deepseek/deepseek-v4.1-flash-1017'
export const REASONING_POLICIES = ['auto', 'off', 'low', 'medium', 'high']

/** @param {unknown} value @returns {'auto'|'off'|'low'|'medium'|'high'} */
export function normalizeReasoningEffort(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return REASONING_POLICIES.includes(text) ? text : 'auto'
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
  if (!supportsImage) return undefined
  if (outputs.length > 0 && !outputs.includes('text')) return undefined
  const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined
  if (parameters !== undefined && !parameters.includes('tools')) return undefined
  const reasoning = parameters !== undefined
    && (parameters.includes('reasoning') || parameters.includes('reasoning_effort') || parameters.includes('include_reasoning'))

  const contextWindow = Number(raw.context_length) > 0 ? Math.round(Number(raw.context_length)) : 128_000
  const rawMax = Number(raw.top_provider?.max_completion_tokens ?? raw.max_completion_tokens)
  const maxTokens = Number.isFinite(rawMax) && rawMax > 0 ? Math.round(rawMax) : 8_192
  const prompt = Number(raw.pricing?.prompt)
  const completion = Number(raw.pricing?.completion)
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.id,
    contextWindow,
    maxTokens,
    reasoning,
    pricing: {
      prompt: Number.isFinite(prompt) ? prompt : undefined,
      completion: Number.isFinite(completion) ? completion : undefined,
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
        'X-Title': 'CrazyAgent',
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
  return {
    provider: 'openrouter',
    baseUrl: normalizeBaseUrl(baseUrl),
    reasoningEffort: normalizeReasoningEffort(reasoningEffort),
    model: {
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning === true,
      pricing: model.pricing,
    },
    updatedAt: new Date().toISOString(),
  }
}

/** @param {string} path */
export function readLlmConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    if (parsed.provider !== 'openrouter') return undefined
    if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl.length === 0) return undefined
    if (!parsed.model || typeof parsed.model.id !== 'string' || parsed.model.id.length === 0) return undefined
    return {
      provider: 'openrouter',
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      reasoningEffort: normalizeReasoningEffort(parsed.reasoningEffort),
      model: {
        id: parsed.model.id,
        name: typeof parsed.model.name === 'string' ? parsed.model.name : parsed.model.id,
        contextWindow: Number(parsed.model.contextWindow) > 0 ? Math.round(Number(parsed.model.contextWindow)) : 128_000,
        maxTokens: Number(parsed.model.maxTokens) > 0 ? Math.round(Number(parsed.model.maxTokens)) : 8_192,
        reasoning: parsed.model.reasoning === true,
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
      'X-Title': 'CrazyAgent',
    },
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
