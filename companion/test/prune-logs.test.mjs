// Coverage for scripts/prune-logs.mjs (plan-temporary.md §D4) on synthetic folders.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listRuns, planPrune, runTime } from '../../scripts/prune-logs.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'prune-logs.mjs')
const DAY = 86_400_000
const NOW = Date.parse('2026-11-16T00:00:00.000Z')

function runName(daysAgo, id = 'abc123') {
  return `run-${new Date(NOW - daysAgo * DAY).toISOString().replace(/[:.]/g, '-')}-${id}`
}

test('runTime reads only well-formed run folder names', () => {
  assert.equal(runTime('run-2026-11-16T04-04-37-067Z-1de89c'), Date.parse('2026-11-16T04:04:37.067Z'))
  assert.equal(runTime('run-latest'), undefined)
  assert.equal(runTime('../run-2026-11-16T04-04-37-067Z-1de89c'), undefined)
  assert.equal(runTime('screenshots'), undefined)
})

test('planPrune keeps the newest N and everything younger than the minimum age', () => {
  const runs = [1, 5, 20, 30, 40, 50].map(days => ({ name: runName(days), time: NOW - days * DAY, bytes: 100 }))
  const plan = planPrune(runs, { now: NOW, keep: 3, minAgeDays: 14 })
  assert.deepEqual(plan.keep.map(run => run.time), [1, 5, 20].map(days => NOW - days * DAY))
  assert.deepEqual(plan.remove.map(run => run.time), [50, 40, 30].map(days => NOW - days * DAY), 'oldest first')

  const young = planPrune(runs, { now: NOW, keep: 1, minAgeDays: 25 })
  assert.equal(young.keep.length, 3, 'runs younger than the minimum age survive a small keep count')

  const single = planPrune([runs[5]], { now: NOW, keep: 1, minAgeDays: 0 })
  assert.equal(single.remove.length, 0, 'the newest run is never removed')
})

test('planPrune size cap removes old kept runs but never young ones', () => {
  const runs = [1, 2, 20, 30].map(days => ({ name: runName(days), time: NOW - days * DAY, bytes: 400 }))
  const plan = planPrune(runs, { now: NOW, keep: 10, minAgeDays: 14, maxBytes: 500 })
  assert.deepEqual(plan.keep.map(run => run.time), [1, 2].map(days => NOW - days * DAY), 'young runs stay even above the cap')
  assert.equal(plan.remove.length, 2)
})

test('the CLI is a dry run unless --apply, and deletes only run folders', t => {
  const logs = mkdtempSync(join(tmpdir(), 'ca-prune-'))
  t.after(() => rmSync(logs, { recursive: true, force: true }))
  const names = [0, 1, 400, 500].map((days, index) => {
    const name = `run-${new Date(Date.now() - days * DAY).toISOString().replace(/[:.]/g, '-')}-id${index}`
    mkdirSync(join(logs, name, 'screenshots'), { recursive: true })
    writeFileSync(join(logs, name, 'events.jsonl'), 'x'.repeat(10))
    writeFileSync(join(logs, name, 'screenshots', 'a.jpg'), 'y'.repeat(5))
    return name
  })
  mkdirSync(join(logs, 'not-a-run'))
  writeFileSync(join(logs, 'notes.txt'), 'keep me')
  assert.equal(listRuns(logs).find(run => run.name === names[0]).bytes, 15)

  const dry = execFileSync(process.execPath, [SCRIPT, '--logs', logs, '--keep', '1'], { encoding: 'utf8' })
  assert.match(dry, /would remove 2 runs/)
  assert.equal(readdirSync(logs).length, 6, 'a dry run deletes nothing')

  const applied = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--logs', logs, '--keep', '1', '--apply', '--json'], { encoding: 'utf8' }))
  assert.deepEqual(applied.removed.map(run => run.name).sort(), [names[2], names[3]].sort())
  assert.deepEqual(readdirSync(logs).sort(), [names[0], names[1], 'not-a-run', 'notes.txt'].sort())
  assert.ok(existsSync(join(logs, 'notes.txt')))
})
