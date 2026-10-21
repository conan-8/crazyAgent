import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearKeyFile,
  readCredentialRef,
  readKeyFile,
  resolveApiKey,
  writeKeyFile,
} from '../credentials.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crazyagent-key-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manualKeyPath = join(root, 'browser-agent', 'api-key')
  const credentialsPath = join(root, '.dsh', '.credentials.yaml')
  await mkdir(join(root, '.dsh'), { recursive: true })
  await writeFile(credentialsPath, [
    'version: 1',
    'refs:',
    '  OPENROUTER_API_KEY: file-key-123',
    '  OTHER_KEY: other',
    'records: {}',
    '',
  ].join('\n'))
  return { root, manualKeyPath, credentialsPath }
}

test('prefers explicit environment, then stored key, then legacy env, then file', async t => {
  const { manualKeyPath, credentialsPath } = await fixture(t)

  assert.deepEqual(
    resolveApiKey({ env: { CRAZYAGENT_API_KEY: 'env-key', OPENROUTER_API_KEY: 'legacy' }, manualKeyPath, credentialsPath }),
    { apiKey: 'env-key', source: 'environment' },
  )

  writeKeyFile(manualKeyPath, 'stored-key')
  assert.deepEqual(
    resolveApiKey({ env: { OPENROUTER_API_KEY: 'legacy' }, manualKeyPath, credentialsPath }),
    { apiKey: 'stored-key', source: 'stored' },
  )
  assert.equal(await readKeyFile(manualKeyPath), 'stored-key')

  clearKeyFile(manualKeyPath)
  assert.equal(await readKeyFile(manualKeyPath), undefined)
  assert.deepEqual(
    resolveApiKey({ env: { OPENROUTER_API_KEY: 'legacy' }, manualKeyPath, credentialsPath }),
    { apiKey: 'legacy', source: 'legacy-environment' },
  )

  assert.deepEqual(
    resolveApiKey({ env: {}, manualKeyPath, credentialsPath }),
    { apiKey: 'file-key-123', source: 'credentials-file' },
  )
})

test('reads a ref from the credentials file and handles missing/invalid files', async t => {
  const { root, credentialsPath } = await fixture(t)
  assert.equal(readCredentialRef(credentialsPath, 'OPENROUTER_API_KEY'), 'file-key-123')
  assert.equal(readCredentialRef(credentialsPath, 'MISSING'), undefined)
  assert.equal(readCredentialRef(join(root, 'nope.yaml')), undefined)

  await writeFile(join(root, 'bad.yaml'), 'refs: [broken')
  assert.equal(readCredentialRef(join(root, 'bad.yaml')), undefined)

  assert.deepEqual(
    resolveApiKey({ env: {}, manualKeyPath: join(root, 'missing-key'), credentialsPath: join(root, 'missing.yaml') }),
    { apiKey: undefined, source: 'none' },
  )
})
