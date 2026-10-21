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
  readLlmConfig,
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

test('mapModel keeps image chat models with tools and carries metadata', () => {
  const model = mapModel(RAW_VISION)
  assert.equal(model.id, 'vendor/vision-tools')
  assert.equal(model.contextWindow, 131072)
  assert.equal(model.maxTokens, 16384)
  assert.equal(model.pricing.prompt, 0.0000003)
  assert.equal(model.reasoning, true)
  assert.equal(mapModel({ ...RAW_VISION, architecture: { input_modalities: ['text'] } }), undefined)
  assert.equal(mapModel({ ...RAW_VISION, supported_parameters: ['temperature'] }), undefined)
  assert.equal(mapModel({ ...RAW_VISION, architecture: { ...RAW_VISION.architecture, output_modalities: ['image'] } }), undefined)
})

test('fetchModels filters and sorts a mocked OpenRouter catalog', async () => {
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
            { ...RAW_VISION, id: 'aaa/text-only', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
            { ...RAW_VISION, id: 'zzz/another-vision', name: 'ZZZ Another' },
          ],
        }
      },
    }
  }
  const models = await fetchModels('https://openrouter.ai/api/v1/', { fetchImpl })
  assert.equal(models.length, 2)
  assert.equal(models[0].id, 'vendor/vision-tools')
  assert.equal(models[1].id, 'zzz/another-vision')
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

test('buildLlmPatch targets the generated llm-pi-ai row and contains no key', () => {
  const model = mapModel(RAW_VISION)
  const config = buildLlmConfig('https://openrouter.ai/api/v1/', model)
  const patch = buildLlmPatch(config)
  assert.ok(!patch.includes('apiKey"') && !patch.includes('sk-or-'))
  const parsed = yaml.load(patch)
  assert.equal(parsed[0].id, 'llm-pi-ai')
  const provider = parsed[0].config.providers.openrouter
  assert.equal(provider.apiKeyEnv, 'CRAZYAGENT_API_KEY')
  assert.equal(provider.api, 'openai-completions')
  assert.equal(provider.baseURL, 'https://openrouter.ai/api/v1')
  assert.equal(provider.models[0].id, 'vendor/vision-tools')
  assert.deepEqual(provider.models[0].input, ['text', 'image'])
  assert.equal(provider.models[0].contextWindow, 131072)
  assert.equal(provider.compat.thinkingFormat, 'openrouter')
  assert.equal(provider.compat.supportsReasoningEffort, true)
  assert.equal(provider.models[0].reasoningEfforts.low, 'low')
  assert.equal(provider.models[0].reasoningEfforts.off, 'none')
})

test('llm config persists non-secret model metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crazyagent-openrouter-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'llm.json')
  const config = buildLlmConfig('https://openrouter.ai/api/v1', mapModel(RAW_VISION))
  writeLlmConfig(path, config)
  const loaded = readLlmConfig(path)
  assert.equal(loaded.provider, 'openrouter')
  assert.equal(loaded.model.id, 'vendor/vision-tools')
  assert.equal(loaded.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(loaded.model.reasoning, true)
  assert.ok(!JSON.stringify(loaded).includes('sk-or-'))
})
