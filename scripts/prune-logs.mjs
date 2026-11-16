#!/usr/bin/env node
/**
 * Retention for companion run logs (retired work plan §D4, archived in docs/HISTORY.md).
 *
 * Each companion run writes a `run-<ISO time>-<id>` folder under
 * `.dsh-home/browser-agent/logs/`; nothing ever removed them. This script
 * lists (default) or deletes (`--apply`) the oldest run folders.
 *
 * Rule: a run is kept when it is among the newest `--keep` runs (default 40)
 * OR younger than `--min-age-days` (default 14). With `--max-gb N`, runs that
 * the rule would keep only by count are still removed, oldest first, until the
 * kept set fits in N GiB; a run younger than the minimum age is never removed.
 * The newest run is never removed (it may belong to the running companion).
 *
 * Usage:
 *   node scripts/prune-logs.mjs                # dry run: print what would go
 *   node scripts/prune-logs.mjs --apply        # delete
 *   node scripts/prune-logs.mjs --keep 20 --min-age-days 7 --max-gb 1 [--logs DIR] [--json]
 *
 * Only directories named `run-…` directly inside the logs directory are
 * considered. Nothing is printed from inside a run.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAY_MS = 86_400_000
const RUN_NAME = /^run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[A-Za-z0-9]+$/u

/** @param {string} name @returns {number | undefined} start time in ms from the folder name */
export function runTime(name) {
  const match = RUN_NAME.exec(name)
  if (match === null) return undefined
  const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isFinite(time) ? time : undefined
}

/**
 * Decide which runs to remove. Pure: no filesystem access.
 * @param {Array<{name: string, time: number, bytes: number}>} runs
 * @param {{now: number, keep: number, minAgeDays: number, maxBytes?: number}} options
 * @returns {{keep: typeof runs, remove: typeof runs}}
 */
export function planPrune(runs, { now, keep, minAgeDays, maxBytes }) {
  const sorted = [...runs].sort((a, b) => b.time - a.time)
  const young = run => now - run.time < minAgeDays * DAY_MS
  const kept = []
  const removed = []
  sorted.forEach((run, index) => {
    if (index === 0 || index < keep || young(run)) kept.push(run)
    else removed.push(run)
  })
  if (maxBytes !== undefined) {
    let total = kept.reduce((sum, run) => sum + run.bytes, 0)
    for (let index = kept.length - 1; index > 0 && total > maxBytes; index -= 1) {
      const run = kept[index]
      if (young(run)) continue
      kept.splice(index, 1)
      removed.push(run)
      total -= run.bytes
    }
  }
  removed.sort((a, b) => a.time - b.time)
  return { keep: kept, remove: removed }
}

/** @param {string} dir @returns {number} total bytes of regular files below dir */
function dirBytes(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirBytes(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

/** @param {string} logsDir */
export function listRuns(logsDir) {
  if (!fs.existsSync(logsDir)) return []
  const runs = []
  for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const time = runTime(entry.name)
    if (time === undefined) continue
    runs.push({ name: entry.name, time, bytes: dirBytes(path.join(logsDir, entry.name)) })
  }
  return runs
}

function gib(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function parseArgs(argv) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const options = { logs: path.join(root, '.dsh-home', 'browser-agent', 'logs'), keep: 40, minAgeDays: 14, maxGb: undefined, apply: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const number = () => {
      const value = Number(argv[index += 1])
      if (!Number.isFinite(value) || value < 0) throw new Error(`${arg} needs a non-negative number`)
      return value
    }
    if (arg === '--apply') options.apply = true
    else if (arg === '--json') options.json = true
    else if (arg === '--logs') options.logs = path.resolve(String(argv[index += 1] ?? ''))
    else if (arg === '--keep') options.keep = Math.max(1, Math.floor(number()))
    else if (arg === '--min-age-days') options.minAgeDays = number()
    else if (arg === '--max-gb') options.maxGb = number()
    else throw new Error(`unknown argument ${arg}`)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const runs = listRuns(options.logs)
  const plan = planPrune(runs, {
    now: Date.now(),
    keep: options.keep,
    minAgeDays: options.minAgeDays,
    maxBytes: options.maxGb === undefined ? undefined : options.maxGb * 1024 ** 3,
  })
  const bytes = list => list.reduce((sum, run) => sum + run.bytes, 0)
  if (options.apply) {
    for (const run of plan.remove) {
      const target = path.join(options.logs, run.name)
      // Re-check the name right before deleting: only run folders, only here.
      if (path.dirname(target) !== options.logs || runTime(run.name) === undefined) continue
      fs.rmSync(target, { recursive: true, force: true })
    }
  }
  if (options.json) {
    console.log(JSON.stringify({ logs: options.logs, applied: options.apply, kept: plan.keep.length, keptBytes: bytes(plan.keep), removed: plan.remove.map(run => ({ name: run.name, bytes: run.bytes })) }, null, 2))
    return
  }
  console.log(`${options.logs}: ${runs.length} runs, ${gib(bytes(runs))}`)
  console.log(`rule: keep newest ${options.keep}, anything younger than ${options.minAgeDays} days${options.maxGb === undefined ? '' : `, at most ${options.maxGb} GiB`}`)
  for (const run of plan.remove) console.log(`  ${options.apply ? 'removed' : 'would remove'} ${run.name}  ${gib(run.bytes)}`)
  console.log(`${options.apply ? 'removed' : 'would remove'} ${plan.remove.length} runs (${gib(bytes(plan.remove))}); keeping ${plan.keep.length} (${gib(bytes(plan.keep))})`)
  if (!options.apply && plan.remove.length > 0) console.log('dry run: add --apply to delete')
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
