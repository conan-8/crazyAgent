#!/usr/bin/env node
/**
 * One-time local setup:
 *   1. initialize the .dsh-home sdk-minimal profile with the pinned DSH CLI
 *   2. make the profile able to resolve the provider and its DSH dependencies
 *   3. verify the browser overlay composes
 *
 * The npm-distributed dsh CLI intentionally rejects `dsh plugin` management, so
 * this script links the local packages into the profile's node_modules directly.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = resolve(process.env.CRAZYAGENT_DSH_HOME ?? join(ROOT, '.dsh-home'))
const PROFILE = 'sdk-minimal'
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const DSH_BIN = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const PATCH = join(ROOT, 'config', 'browser.patch.yml')
const PLUGIN_DIR = join(ROOT, 'packages', 'dsh-browser-extension')
const PROFILE_DEPS = ['dsh-browser-use', 'dsh-llm-pi-ai', 'dsh-credentials-local']
const CREDENTIALS = resolve(process.env.CRAZYAGENT_CREDENTIALS_PATH ?? join(homedir(), '.dsh', '.credentials.yaml'))

function log(message) {
  process.stderr.write(`[setup] ${message}\n`)
}

function fail(message) {
  log(`error: ${message}`)
  process.exit(1)
}

function runDsh(args, env = {}) {
  return spawnSync(process.execPath, [DSH_BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  })
}

/** @param {string} target @param {string} linkPath */
function link(target, linkPath) {
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(target, linkPath, 'dir')
}

if (!existsSync(DSH_BIN)) fail(`DSH is not installed at ${DSH_BIN}; run npm install`)
if (!existsSync(PLUGIN_DIR)) fail(`plugin package is missing at ${PLUGIN_DIR}`)
if (!existsSync(PATCH)) fail(`profile patch is missing at ${PATCH}`)

mkdirSync(join(DSH_HOME, 'workspace'), { recursive: true })
mkdirSync(join(DSH_HOME, 'browser-agent'), { recursive: true })

log(`harness home: ${DSH_HOME}`)
if (!existsSync(join(PROFILE_DIR, 'package.json'))) {
  log(`initializing ${PROFILE} profile...`)
  const init = runDsh(['--profile', PROFILE, '--dump-config'])
  if (init.status !== 0) {
    fail(`profile initialization failed:\n${init.stderr || init.stdout || 'no output'}`)
  }
} else {
  log(`${PROFILE} profile already exists`)
}

const scopeDir = join(PROFILE_DIR, 'node_modules', '@deepseek-ai')
mkdirSync(scopeDir, { recursive: true })
for (const dependency of PROFILE_DEPS) {
  const target = join(ROOT, 'node_modules', '@deepseek-ai', dependency)
  if (!existsSync(target)) fail(`missing root dependency ${target}; run npm install`)
  link(target, join(scopeDir, dependency))
  log(`linked ${dependency}`)
}
link(PLUGIN_DIR, join(PROFILE_DIR, 'node_modules', 'dsh-browser-extension'))
log('linked dsh-browser-extension')

log('checking plugin imports...')
const importCheck = spawnSync(process.execPath, [
  '--input-type=module',
  '-e',
  `import(${JSON.stringify(pathToFileURL(join(PLUGIN_DIR, 'lib', 'index.js')).href)}).then(m => { if (typeof m.apply !== 'function') process.exit(3) }).catch(error => { console.error(error); process.exit(2) })`,
], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
if (importCheck.status !== 0) {
  fail(`plugin import failed:\n${importCheck.stderr || importCheck.stdout || 'no output'}`)
}
log('plugin imports cleanly')

log('checking composed profile...')
const check = runDsh(['--profile', PROFILE, '--patch', PATCH, '--dump-config'], {
  DSH_BROWSER_BRIDGE_URL: 'ws://127.0.0.1:17871/bridge',
  DSH_BROWSER_BRIDGE_TOKEN: 'setup-check',
  CRAZYAGENT_CREDENTIALS_PATH: CREDENTIALS,
})
if (check.status !== 0) {
  fail(`profile composition failed:\n${check.stderr || check.stdout || 'no output'}`)
}
log('profile composes with config/browser.patch.yml')

if (!existsSync(CREDENTIALS)) {
  log(`note: no DSH credential file at ${CREDENTIALS}`)
  log('      enter your OpenRouter API key in the side panel Settings after loading the extension')
}

process.stdout.write(`
CrazyAgent setup complete.

Next:
  1. npm run dev
  2. Open chrome://extensions, enable Developer mode, Load unpacked -> extension/
  3. Click the CrazyAgent toolbar icon and paste the pairing token
  4. Enter your OpenRouter API key, click Refresh models, select an image-capable model, and Save
  5. Visit a normal website and ask "What is on this page?"

The companion is local-only (127.0.0.1). Screenshots are sent to the configured
model provider; see README.md for the Phase 1 limits.
`)