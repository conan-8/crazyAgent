#!/usr/bin/env node
/**
 * Print the exact system prompt CrazyAgent sends to the model.
 *
 * The prompt is assembled from exactly two places:
 *   - `system-prompt.personaPrefix` in config/browser.patch.yml
 *   - the provider GUIDANCE constant in
 *     packages/dsh-browser-extension/lib/index.js
 *
 * DSH's harness identity and runtime-context sections are disabled, so nothing
 * else is added to the system message (tool JSON schemas are sent separately).
 *
 * Usage: npm run system-prompt [-- --json]
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = join(ROOT, 'config', 'browser.patch.yml')
const PROVIDER = join(ROOT, 'packages', 'dsh-browser-extension', 'lib', 'index.js')

/** @returns {string} */
function personaFromConfig() {
  const text = readFileSync(CONFIG, 'utf8')
  const match = /personaPrefix: \|-\n((?:[ ]{6}.*\n)+)/u.exec(text)
  if (match === null) throw new Error('config/browser.patch.yml: personaPrefix block not found')
  return match[1]
    .replace(/\n$/u, '')
    .split('\n')
    .map(line => line.replace(/^ {6}/u, ''))
    .join('\n')
}

/** @returns {string} */
function guidanceFromProvider() {
  const text = readFileSync(PROVIDER, 'utf8')
  const match = /const GUIDANCE = `([\s\S]*?)`\n/u.exec(text)
  if (match === null) throw new Error('provider GUIDANCE constant not found')
  return match[1]
}

const persona = personaFromConfig()
const guidance = guidanceFromProvider()
const prompt = `${persona}\n\n${guidance}`

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({
    chars: prompt.length,
    personaChars: persona.length,
    guidanceChars: guidance.length,
    prompt,
  }, null, 2)}\n`)
} else {
  process.stdout.write(`${prompt}\n`)
}