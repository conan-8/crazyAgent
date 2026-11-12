import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../settings.mjs'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crazyagent-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('missing, malformed, or foreign settings files fall back to off', t => {
  const dir = tempDir(t)
  const path = join(dir, 'settings.json')
  assert.deepEqual(readSettings(path), { confirmIrreversible: false })
  writeFileSync(path, 'not json')
  assert.deepEqual(readSettings(path), DEFAULT_SETTINGS)
  writeFileSync(path, '[]')
  assert.deepEqual(readSettings(path), DEFAULT_SETTINGS)
  writeFileSync(path, JSON.stringify({ confirmIrreversible: 'yes', other: true }))
  assert.deepEqual(readSettings(path), { confirmIrreversible: false })
})

test('writeSettings persists only the normalized boolean, atomically and owner-only', t => {
  const dir = tempDir(t)
  const path = join(dir, 'settings.json')
  assert.deepEqual(writeSettings(path, { confirmIrreversible: true }), { confirmIrreversible: true })
  assert.deepEqual(readSettings(path), { confirmIrreversible: true })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { confirmIrreversible: true })
  assert.equal(readFileSync(path, 'utf8').includes('other'), false)
  // A non-boolean never turns the flow on.
  writeSettings(path, { confirmIrreversible: 'true' })
  assert.deepEqual(readSettings(path), { confirmIrreversible: false })
  writeSettings(path, undefined)
  assert.deepEqual(readSettings(path), { confirmIrreversible: false })
  const mode = process.platform === 'win32' ? null : statSync(path).mode & 0o777
  if (mode !== null) assert.equal(mode, 0o600)
})
