import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import {
  buildLlmConfig,
  buildLlmPatch,
  fetchModels,
  mapModel,
  normalizeReasoningEffort,
  normalizeSupportedEfforts,
  readLlmConfig,
  resolveRequestMaxTokens,
  validateApiKey,
  writeLlmConfig,
} from '../openrouter.mjs'

const RAW_VISION = {
  id: 'vendor/vision-tools',
  name: 'Vendor Vision Tools',
  context_length: 131072,
  top_provider: { max_completion_tokens: 16384 },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'], modality: 'text+image->text' },
  supported_parameters: ['tools', 'temperature', 'reasoning', 'reasoning_effort'],
  pricing: { prompt: '0.0000003', completion: '0.0000012' },
}

test('mapModel carries metadata and image/tool capabilities for the full text-chat catalog', () => {
  const model = mapModel(RAW_VISION)
  assert.equal(model.id, 'vendor/vision-tools')
  assert.equal(model.contextWindow, 131072)
  assert.equal(model.maxTokens, 16384)
  assert.equal(model.pricing.prompt, 0.0000003)
  assert.equal(model.reasoning, true)
  assert.equal(model.imageInput, true)
  assert.equal(model.tools, true)
  assert.equal(mapModel({ ...RAW_VISION, architecture: { input_modalities: ['text'] } }).imageInput, false)
  assert.equal(mapModel({ ...RAW_VISION, supported_parameters: ['temperature'] }).tools, false)
  assert.equal(mapModel({ ...RAW_VISION, architecture: { ...RAW_VISION.architecture, output_modalities: ['image'] } }), undefined)
  assert.deepEqual(mapModel({
    ...RAW_VISION,
    pricing: {
      prompt: '0.000003',
      completion: '0.000015',
      input_cache_read: '0.0000003',
      input_cache_write: '0.00000375',
    },
  }).pricing, {
    prompt: 0.000003,
    completion: 0.000015,
    cacheRead: 0.0000003,
    cacheWrite: 0.00000375,
  })
})

test('fetchModels returns and sorts every text-chat model with capability flags', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            RAW_VISION,
            { ...RAW_VISION, id: 'aaa/text-only', name: 'AAA Text Only', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
            { ...RAW_VISION, id: 'zzz/another-vision', name: 'ZZZ Another' },
          ],
        }
      },
    }
  }
  const models = await fetchModels('https://openrouter.ai/api/v1/', { fetchImpl })
  assert.equal(models.length, 3)
  assert.equal(models[0].id, 'aaa/text-only')
  assert.equal(models[0].imageInput, false)
  assert.equal(models[1].id, 'vendor/vision-tools')
  assert.equal(models[2].id, 'zzz/another-vision')
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models')
})

test('validateApiKey rejects 401/403 and tolerates a missing /key endpoint', async () => {
  await assert.rejects(
    validateApiKey('https://openrouter.ai/api/v1', 'bad', {
      fetchImpl: async () => ({ ok: false, status: 401 }),
    }),
    /401\/403/,
  )
  assert.equal(
    await validateApiKey('https://gateway.test/v1', 'key', {
      fetchImpl: async () => ({ ok: false, status: 404 }),
    }),
    true,
  )
})

test('request output cap defaults to the model maximum and preserves explicit lower overrides', () => {
  const model = { maxTokens: 131_072 }
  assert.equal(resolveRequestMaxTokens(model), 131_072)
  assert.equal(resolveRequestMaxTokens(model, 8_192), 8_192)
  assert.equal(resolveRequestMaxTokens(model, 200_000), 131_072)
})

test('buildLlmPatch targets the generated llm-pi-ai row and contains no key', () => {
  const model = mapModel(RAW_VISION)
  const config = buildLlmConfig('https://openrouter.ai/api/v1/', model)
  assert.equal(config.reasoningEffort, 'auto')
  const patch = buildLlmPatch(config)
  assert.ok(!patch.includes('apiKey"') && !patch.includes('sk-or-'))
  const parsed = yaml.load(patch)
  assert.equal(parsed[0].id, 'llm-pi-ai')
  const provider = parsed[0].config.providers.openrouter
  assert.equal(provider.apiKeyEnv, 'CRAZYAGENT_API_KEY')
  assert.equal(provider.api, 'openai-completions')
  assert.equal(provider.baseURL, 'https://openrouter.ai/api/v1')
  assert.equal(provider.streamIdleTimeoutMs, 2_147_483_647)
  assert.equal('timeoutMs' in provider, false)
  assert.equal(provider.models[0].id, 'vendor/vision-tools')
  assert.deepEqual(provider.models[0].input, ['text', 'image'])
  assert.equal(provider.models[0].contextWindow, 131072)
  assert.equal(provider.compat.thinkingFormat, 'openrouter')
  assert.equal(provider.compat.supportsReasoningEffort, true)
  assert.equal(provider.models[0].reasoningEfforts.low, 'low')
  assert.equal(provider.models[0].reasoningEfforts.off, 'none')
  assert.equal(provider.models[0].reasoningEfforts.minimal, 'minimal')
  assert.equal(provider.models[0].reasoningEfforts.xhigh, 'xhigh')
  assert.equal(provider.models[0].reasoningEfforts.max, 'max')
})

test('llm config persists non-secret model metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crazyagent-openrouter-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'llm.json')
  const model = mapModel({
    ...RAW_VISION,
    reasoning: { mandatory: true, supported_efforts: ['max', 'high', 'none', 'low'] },
  })
  const config = buildLlmConfig('https://openrouter.ai/api/v1', model, 'max')
  writeLlmConfig(path, config)
  const loaded = readLlmConfig(path)
  assert.equal(loaded.provider, 'openrouter')
  assert.equal(loaded.model.id, 'vendor/vision-tools')
  assert.equal(loaded.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(loaded.model.reasoning, true)
  assert.equal(loaded.reasoningEffort, 'max')
  assert.deepEqual(loaded.model.reasoningEfforts, ['low', 'high', 'max'])
  assert.equal(loaded.model.reasoningMandatory, true)
  assert.ok(!JSON.stringify(loaded).includes('sk-or-'))
})

test('normalizeSupportedEfforts maps none to off, honors mandatory, orders levels, and falls back', () => {
  assert.deepEqual(
    normalizeSupportedEfforts({ mandatory: false, supported_efforts: ['max', 'high', 'low', 'none'] }, true),
    ['off', 'low', 'high', 'max'],
  )
  assert.deepEqual(
    normalizeSupportedEfforts({ mandatory: true, supported_efforts: ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'] }, true),
    ['minimal', 'low', 'medium', 'high', 'xhigh'],
  )
  assert.deepEqual(normalizeSupportedEfforts(undefined, true), ['off', 'low', 'medium', 'high'])
  assert.deepEqual(normalizeSupportedEfforts({ mandatory: true }, true), ['low', 'medium', 'high'])
  assert.deepEqual(normalizeSupportedEfforts({ supported_efforts: ['high', 'low'] }, false), [])

  const mapped = mapModel({
    ...RAW_VISION,
    reasoning: { mandatory: false, supported_efforts: ['max', 'medium', 'none'] },
  })
  assert.deepEqual(mapped.reasoningEfforts, ['off', 'medium', 'max'])
  assert.equal(mapped.reasoningMandatory, false)
})

test('normalizeReasoningEffort accepts extended explicit levels', () => {
  for (const level of ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeReasoningEffort(level), level)
  }
  assert.equal(normalizeReasoningEffort('MAX'), 'max')
  assert.equal(normalizeReasoningEffort('unknown'), 'auto')
})
