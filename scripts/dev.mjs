#!/usr/bin/env node
/**
 * Start the local companion with the repository's Node process, and start it
 * again when it exits to finish an automatic update (exit code 75; see
 * companion/updater.mjs). Each start reads the companion from disk, so the
 * restarted process is the updated version.
 */

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPDATE_EXIT_CODE = 75
/** A companion that keeps asking for a restart this quickly is broken, not updating. */
const MIN_RESTART_INTERVAL_MS = 30_000
const MAX_QUICK_RESTARTS = 3

let child
let stopping = false
let quickRestarts = 0

function start() {
  const startedAt = Date.now()
  child = spawn(process.execPath, [join(ROOT, 'companion', 'index.mjs'), ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CRAZYAGENT_SUPERVISED: '1' },
  })
  child.on('exit', code => {
    if (code !== UPDATE_EXIT_CODE || stopping) process.exit(code ?? 0)
    quickRestarts = Date.now() - startedAt < MIN_RESTART_INTERVAL_MS ? quickRestarts + 1 : 0
    if (quickRestarts >= MAX_QUICK_RESTARTS) {
      process.stderr.write('[crazyagent] the companion asked to restart too often; giving up\n')
      process.exit(1)
    }
    process.stderr.write('[crazyagent] restarting the companion after an update\n')
    start()
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    child?.kill(signal)
  })
}
start()
