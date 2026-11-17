import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const MANIFEST = join(ROOT, 'e2e/watch-corpus/manifest.json')

// V0 plumbing check: the manifest-driven replay runs end to end with a fake
// judge (no spend, no key). This is PLUMBING, not the gate — the fake judge
// always returns 'progressing', so deterministic hard signals can still alert
// on stuck windows and the gate may legitimately fail (exit 2). A crash (exit 1)
// or a malformed result is the failure this test catches.
test('watcher-eval --dry-run --split tune replays the corpus (plumbing, no spend)', () => {
  if (!existsSync(MANIFEST)) {
    // Corpus lives on the V0 branch; skip where it is not present.
    return
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const tuneCount = manifest.windows.filter(w => w.split === 'tune').length
  const out = join(mkdtempSync(join(tmpdir(), 'watcher-eval-plumbing-')), 'plumbing.json')
  const result = spawnSync(process.execPath, ['scripts/watcher-eval.mjs', '--dry-run', '--split', 'tune', '--repeat', '2', '--out', out], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  })
  assert.ok(result.status === 0 || result.status === 2, `dry-run must exit 0 (gate pass) or 2 (gate fail), got ${result.status}: ${result.stderr?.slice(-500)}`)
  const summary = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(summary.dryRun, true)
  assert.equal(summary.split, 'tune')
  assert.equal(summary.repeat, 2)
  assert.equal(summary.windows.length, tuneCount, 'every tune window scored')
  assert.ok(summary.groups?.all && typeof summary.groups.all.stability === 'number', 'stability present')
  assert.ok(typeof summary.groups.gatedAll.fineFalseAlertWorstRate === 'number', 'worst-case field present')
  for (const w of summary.windows) {
    assert.equal(w.repeats, 2)
    assert.ok(typeof w.meanFlagged === 'number' && typeof w.worstFlagged === 'boolean' && typeof w.stable === 'boolean')
  }
  // Dry-run spends nothing.
  assert.equal(summary.cost.totals.inputTokens, 0)
  assert.equal(summary.cost.totals.outputTokens, 0)
  assert.equal(summary.cost.totals.reasoningTokens, 0)
})
