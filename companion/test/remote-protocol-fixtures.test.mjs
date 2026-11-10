import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildFixtures, fixtureFiles } from '../../scripts/remote-protocol-fixtures.mjs'

test('committed Android protocol fixtures match the current RemoteHub output', () => {
  for (const file of fixtureFiles()) {
    let current = ''
    try {
      current = readFileSync(file.path, 'utf8')
    } catch {
      // Reported by the assertion below.
    }
    assert.equal(current, file.text, `${file.path} is stale; run node scripts/remote-protocol-fixtures.mjs`)
  }
})

test('fixtures start with a resync and then carry contiguous sequences', () => {
  for (const fixture of buildFixtures()) {
    assert.equal(fixture.frames[0].type, 'remote.resync', fixture.name)
    let seq = fixture.frames[0].seq
    for (const frame of fixture.frames.slice(1)) {
      seq += 1
      assert.equal(frame.seq, seq, `${fixture.name} sequence`)
    }
    assert.equal(fixture.final.latestSequence, seq, `${fixture.name} final sequence`)
  }
})
