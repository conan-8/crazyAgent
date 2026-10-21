#!/usr/bin/env node
/** Remove generated local state. Requires --yes because sessions/screenshots are deleted. */

import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const yes = process.argv.includes('--yes')

if (!yes) {
  process.stderr.write(`Refusing to delete ${join(ROOT, '.dsh-home')} without confirmation.

This removes the generated DSH profile, sessions, screenshot attachments, bridge
token, and debug logs. It does not touch ~/.dsh or your credentials.

Run: npm run clean -- --yes
`)
  process.exit(1)
}

for (const path of [join(ROOT, '.dsh-home'), join(ROOT, 'logs')]) {
  rmSync(path, { recursive: true, force: true })
  process.stdout.write(`removed ${path}\n`)
}
process.stdout.write('Run npm run setup before starting the companion again.\n')