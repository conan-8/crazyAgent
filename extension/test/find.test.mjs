import test from 'node:test'
import assert from 'node:assert/strict'
import { executeFind, parseFindArgs } from '../sidepanel/find.js'

function match(localIndex, overrides = {}) {
  return {
    localIndex,
    snippet: `match ${localIndex + 1}`,
    source: 'text',
    tag: 'p',
    role: '',
    signature: `signature-${localIndex}`,
    inViewport: false,
    ...overrides,
  }
}

function fakeIo(overrides = {}) {
  const tab = { id: 7, title: 'Find fixture', url: 'https://example.test/find' }
  const calls = []
  return {
    calls,
    getActiveTab: async () => tab,
    assertCapturable: async () => {},
    canvasEditorForUrl: () => undefined,
    runInAllFrames: async () => [{ frameId: 0, result: { matches: [match(0)], scannedNodes: 10, truncated: false } }],
    runInFrame: async () => ({ ok: true, inViewport: true, moved: true }),
    invalidateCoordinates: async id => { calls.push(['invalidate', id]) },
    snapshot: async () => ({ op: 'snapshot', view: 'full', image: { data: 'AAAA', mimeType: 'image/jpeg' } }),
    tabSummary: value => ({ id: value.id, title: value.title, url: value.url }),
    ...overrides,
  }
}

test('find arguments normalize queries and validate the bounded contract', () => {
  assert.deepEqual(parseFindArgs({ query: '  silver\n key  ' }), { query: 'silver key', occurrence: undefined, reveal: false })
  assert.deepEqual(parseFindArgs({ query: 'key', occurrence: 'last', reveal: true }), { query: 'key', occurrence: 'last', reveal: true })
  const invalid = [
    {}, { query: '' }, { query: '   ' }, { query: 4 }, { query: 'x'.repeat(201) },
    { query: 'key', occurrence: 0 }, { query: 'key', occurrence: 1.5 }, { query: 'key', occurrence: 'all' },
    { query: 'key', reveal: 'yes' }, { query: 'key', surprise: true }, null, [],
  ]
  for (const args of invalid) assert.throws(() => parseFindArgs(args), error => error.code === 'BAD_FIND')
})

test('find search combines frames, maps existing labels, and stays text-only', async () => {
  const io = fakeIo({
    runInAllFrames: async () => [
      { frameId: 2, result: { matches: [match(0, { label: 3, source: 'accessible-name' })], scannedNodes: 5 } },
      { frameId: 0, result: { matches: [match(0, { label: 4 }), match(1)], scannedNodes: 12 } },
    ],
  })
  const result = await executeFind({ query: 'match' }, io)
  assert.equal(result.view, 'none')
  assert.equal(result.screenshotSkipped, true)
  assert.equal(result.find.matchCount, 3)
  assert.equal(result.find.countExact, true)
  assert.deepEqual(result.matches.map(item => item.occurrence), [1, 2, 3])
  assert.equal(result.matches[0].label, 4)
  assert.equal(result.matches[2].label, 200003)
  assert.equal(result.matches[2].frame, 2)
  assert.equal(result.image, undefined)
})

test('find occurrence selects one result without scrolling', async () => {
  const io = fakeIo({
    runInAllFrames: async () => [{ frameId: 0, result: { matches: [match(0), match(1), match(2)] } }],
  })
  const result = await executeFind({ query: 'match', occurrence: 2 }, io)
  assert.equal(result.find.occurrence, 2)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].snippet, 'match 2')
  assert.equal(io.calls.length, 0)
  await assert.rejects(executeFind({ query: 'match', occurrence: 4 }, io), error => error.code === 'FIND_OCCURRENCE_NOT_FOUND')
})

test('ambiguous or truncated reveal never scrolls or guesses a target', async () => {
  const duplicates = fakeIo({
    runInAllFrames: async () => [{ frameId: 0, result: { matches: [match(0), match(1)] } }],
  })
  await assert.rejects(executeFind({ query: 'match', reveal: true }, duplicates), error => error.code === 'FIND_AMBIGUOUS')
  assert.equal(duplicates.calls.length, 0)
  const truncated = fakeIo({
    runInAllFrames: async () => [{ frameId: 0, result: { matches: [match(0)], truncated: true } }],
  })
  await assert.rejects(executeFind({ query: 'match', reveal: true }, truncated), error => error.code === 'FIND_REFINE_QUERY')
  await assert.rejects(executeFind({ query: 'match', occurrence: 'last' }, truncated), error => error.code === 'FIND_REFINE_QUERY')
  assert.equal(truncated.calls.length, 0)
})

test('explicit reveal revalidates, invalidates coordinates, and returns a fresh view', async () => {
  const io = fakeIo({
    runInAllFrames: async () => [{ frameId: 0, result: { matches: [match(0), match(1)] } }],
    runInFrame: async (...args) => {
      io.calls.push(['reveal', args[1], args[3][0]])
      return { ok: true, inViewport: true, moved: true }
    },
  })
  const result = await executeFind({ query: 'match', occurrence: 2, reveal: true }, io)
  assert.equal(result.op, 'find')
  assert.equal(result.view, 'full')
  assert.equal(result.find.occurrence, 2)
  assert.equal(result.find.revealed, true)
  assert.equal(result.reveal.inViewport, true)
  assert.deepEqual(io.calls[0], ['reveal', 0, {
    mode: 'reveal', query: 'match', localIndex: 1, signature: 'signature-1', maxMatches: 200, maxNodes: 20_000,
  }])
  assert.deepEqual(io.calls[1], ['invalidate', 7])
})

test('reveal invalidates old coordinates even when the target becomes stale', async () => {
  const io = fakeIo({ runInFrame: async () => ({ ok: false, code: 'FIND_STALE', message: 'changed' }) })
  await assert.rejects(executeFind({ query: 'match', reveal: true }, io), error => error.code === 'FIND_STALE')
  assert.deepEqual(io.calls, [['invalidate', 7]])
})

test('find refuses known canvas editors before page access', async () => {
  let accessed = false
  const io = fakeIo({
    canvasEditorForUrl: () => 'Google Docs',
    runInAllFrames: async () => { accessed = true; return [] },
  })
  await assert.rejects(executeFind({ query: 'match' }, io), error => error.code === 'FIND_CANVAS_UNSUPPORTED')
  assert.equal(accessed, false)
})

test('find detects active-tab changes before reveal', async () => {
  let reads = 0
  const io = fakeIo({
    getActiveTab: async () => reads++ === 0
      ? { id: 7, title: 'Original', url: 'https://example.test/find' }
      : { id: 8, title: 'Other', url: 'https://example.test/other' },
  })
  await assert.rejects(executeFind({ query: 'match', reveal: true }, io), error => error.code === 'FIND_STALE_TAB')
  assert.equal(io.calls.length, 0)
})
