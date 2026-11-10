import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REMOTE_TOKEN_PATTERN,
  createRemoteTokenSource,
  remoteTokenMatches,
  resolveRemoteToken,
} from '../remote-token.mjs'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crazyagent-remote-token-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('creates a 0600 64-hex token once and reuses it', t => {
  const path = join(tempDir(t), 'nested', 'remote-token')
  const first = resolveRemoteToken(path)
  assert.equal(first.created, true)
  assert.match(first.token, REMOTE_TOKEN_PATTERN)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  const second = resolveRemoteToken(path)
  assert.deepEqual(second, { token: first.token, created: false, rotated: false })
})

test('rotation replaces the token', t => {
  const path = join(tempDir(t), 'remote-token')
  const { token } = resolveRemoteToken(path)
  const rotated = resolveRemoteToken(path, { rotate: true })
  assert.equal(rotated.rotated, true)
  assert.notEqual(rotated.token, token)
  assert.equal(readFileSync(path, 'utf8'), rotated.token)
})

test('an invalid stored token is replaced rather than trusted', t => {
  const path = join(tempDir(t), 'remote-token')
  writeFileSync(path, 'short')
  const result = resolveRemoteToken(path)
  assert.match(result.token, REMOTE_TOKEN_PATTERN)
  assert.equal(result.created, true)
})

test('constant-time match rejects empty, non-string, and length mismatches', () => {
  const token = 'a'.repeat(64)
  assert.equal(remoteTokenMatches(token, token), true)
  assert.equal(remoteTokenMatches(`${token}0`, token), false)
  assert.equal(remoteTokenMatches('', token), false)
  assert.equal(remoteTokenMatches(undefined, token), false)
  assert.equal(remoteTokenMatches(token, ''), false)
})

test('token source picks up rotation and fails closed when the file disappears', t => {
  const path = join(tempDir(t), 'remote-token')
  let now = 0
  const source = createRemoteTokenSource(path, { checkIntervalMs: 100, now: () => now })
  assert.equal(source(), undefined)
  const { token } = resolveRemoteToken(path)
  now += 50
  assert.equal(source(), undefined, 'cached until the interval elapses')
  now += 100
  assert.equal(source(), token)
  const rotated = resolveRemoteToken(path, { rotate: true }).token
  now += 200
  assert.equal(source(), rotated)
  rmSync(path)
  now += 200
  assert.equal(source(), undefined)
})
