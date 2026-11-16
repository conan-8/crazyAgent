#!/usr/bin/env node
/**
 * Print the exact system prompt crazyAgent sends to the model.
 *
 * The standing (non-Docs) prompt is assembled from exactly two places:
 *   - `system-prompt.personaPrefix` in config/browser.patch.yml
 *   - CORE_GUIDANCE in packages/dsh-browser-extension/lib/guidance.js
 *
 * D2 (2026-11-16): the Docs rules are a conditional <docs_mode> block appended
 * to the turn's first user prompt when a Docs tab is open at turn start (or
 * returned in the first Docs tool result of a turn that lacked it), so they
 * are NOT part of the standing system message. --json also reports the
 * combined Docs-turn size for the ceiling check.
 *
 * DSH's harness identity and runtime-context sections are disabled, so nothing
 * else is added to the system message (tool JSON schemas are sent separately).
 *
 * Usage: npm run system-prompt [-- --json]
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_GUIDANCE, DOCS_MODE_GUIDANCE } from '../packages/dsh-browser-extension/lib/guidance.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = join(ROOT, 'config', 'browser.patch.yml')

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

const persona = personaFromConfig()
const guidance = CORE_GUIDANCE
const prompt = `${persona}\n\n${guidance}`

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({
    chars: prompt.length,
    personaChars: persona.length,
    guidanceChars: guidance.length,
    docsModeChars: DOCS_MODE_GUIDANCE.length,
    docsTurnChars: prompt.length + 2 + DOCS_MODE_GUIDANCE.length,
    prompt,
  }, null, 2)}\n`)
} else {
  process.stdout.write(`${prompt}\n`)
}