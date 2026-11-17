#!/usr/bin/env node
/**
 * Real-extension check of the self-reload after an automatic update: a fresh
 * isolated Edge profile loads a temporary COPY of extension/, the copy's
 * manifest on disk is then moved to a newer version (what the companion's
 * update checkout does to a real installation), and the running extension must
 * reload itself onto it. The loaded version is read back from the new service
 * worker over CDP, independently of the code under test.
 *
 *   node scripts/edge-selfupdate-e2e.mjs            # headless
 *   HEADED=1 node scripts/edge-selfupdate-e2e.mjs   # visible window
 *
 * Takes about a minute and a half (two 30-second alarm ticks per reload).
 * It does not exercise the companion's Git/npm update or any model.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_BIN = process.env.EDGE_BIN ?? 'microsoft-edge'
const CDP_PORT = Number(process.env.CDP_PORT ?? 9349)
const CDP = `http://127.0.0.1:${CDP_PORT}`
const WORK_DIR = mkdtempSync(join(tmpdir(), 'ca-edge-selfupdate-'))
const USER_DIR = join(WORK_DIR, 'profile')
const EXTENSION_DIR = join(WORK_DIR, 'extension')
const MANIFEST = join(EXTENSION_DIR, 'manifest.json')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const extensionId = (() => {
  const hex = createHash('sha256').update(EXTENSION_DIR).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()

async function until(what, predicate, timeoutMs = 10_000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    assert.ok(Date.now() - started < timeoutMs, `timed out waiting for ${what}`)
    await sleep(250)
  }
}

async function evaluateInWorker(expression) {
  const list = await (await fetch(`${CDP}/json`)).json()
  const target = list.find(entry => entry.type === 'service_worker' && entry.url.includes(extensionId))
  if (!target) {
    if (process.env.DEBUG) process.stderr.write(`no worker for ${extensionId} among ${list.map(entry => entry.url).join(' ')}\n`)
    return undefined
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const reply = new Promise(resolve => ws.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.id === 1) resolve(message)
    }))
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    const message = await reply
    if (process.env.DEBUG) process.stderr.write(`worker reply: ${JSON.stringify(message).slice(0, 300)}\n`)
    return message.result?.exceptionDetails ? undefined : message.result?.result?.value
  } catch (error) {
    if (process.env.DEBUG) process.stderr.write(`worker probe: ${error}\n`)
    return undefined
  } finally {
    ws.close()
  }
}

const loadedVersion = () => evaluateInWorker('chrome.runtime.getManifest().version')
const storedState = () => evaluateInWorker(`chrome.storage.local.get('crazyagent.selfUpdate').then(v => v['crazyagent.selfUpdate'] ?? null)`)
function setDiskVersion(version) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  manifest.version = version
  manifest.version_name = version
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
}

const results = []
const pass = name => { results.push(name); process.stdout.write(`ok - ${name}\n`) }
let edge

async function run() {
  cpSync(join(ROOT, 'extension'), EXTENSION_DIR, { recursive: true })
  const original = JSON.parse(readFileSync(MANIFEST, 'utf8')).version
  const [major, minor, patch] = original.split('.').map(Number)
  const newer = `${major}.${minor}.${patch + 1}`
  const older = `${major}.${minor}.${Math.max(0, patch - 1)}`

  edge = spawn(EDGE_BIN, [
    `--user-data-dir=${USER_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    ...(process.env.HEADED ? [] : ['--headless=new']),
    'about:blank',
  ], { detached: true, stdio: 'ignore' })

  await until('Edge CDP', async () => { try { return (await fetch(`${CDP}/json/version`)).ok } catch { return false } }, 25_000)
  assert.equal(await until('the extension service worker', loadedVersion, 20_000), original)
  pass(`the copy loads as ${original}`)

  // Not newer: two alarm ticks pass and nothing reloads.
  if (older !== original) {
    setDiskVersion(older)
    await sleep(70_000)
    assert.equal(await loadedVersion(), original)
    assert.equal(await storedState(), null)
    pass(`an older version on disk (${older}) is ignored`)
  }

  setDiskVersion(newer)
  const changedAt = Date.now()
  await until(`the extension to reload onto ${newer}`, async () => (await loadedVersion()) === newer, 100_000)
  const state = await storedState()
  assert.equal(state?.reloadedFor, newer)
  pass(`a newer version on disk (${newer}) is loaded by a self-reload after ${((Date.now() - changedAt) / 1000).toFixed(0)} s`)

  await sleep(70_000)
  assert.equal(await loadedVersion(), newer)
  assert.equal((await storedState())?.reloadedAt, state.reloadedAt)
  pass('the reloaded extension stays put (no reload loop)')
}

let failed = false
try {
  await run()
  process.stdout.write(`\n${results.length} checks passed\n`)
} catch (error) {
  failed = true
  process.stderr.write(`\nFAILED after ${results.length} checks: ${error.stack ?? error}\n`)
} finally {
  // Only the process group this script started.
  if (edge?.pid) { try { process.kill(-edge.pid, 'SIGTERM') } catch { /* already gone */ } }
  await sleep(1_500)
  if (edge?.pid) { try { process.kill(-edge.pid, 'SIGKILL') } catch { /* already gone */ } }
  await sleep(300)
  rmSync(WORK_DIR, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
