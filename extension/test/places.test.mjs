import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePlacesArgs, searchPlaces } from '../sidepanel/browser.js'

function fakeApi(overrides = {}) {
  const calls = []
  return {
    calls,
    topSites: {
      get: async () => {
        calls.push(['shortcuts'])
        return [
          { title: 'Project board', url: 'https://example.test/board' },
          { title: 'Browser settings', url: 'chrome://settings' },
          { title: 'Second', url: 'https://example.test/second' },
        ]
      },
    },
    bookmarks: {
      getTree: async () => {
        calls.push(['bookmarks.tree'])
        return [{ children: [
          { title: 'Folder', children: [{ title: 'Saved project', url: 'https://example.test/saved', dateAdded: 1700000000000 }] },
          { title: 'Unsafe', url: 'javascript:alert(1)' },
        ] }]
      },
      search: async query => {
        calls.push(['bookmarks.search', query])
        return [{ title: 'Saved project', url: 'https://example.test/saved', dateAdded: 1700000000000 }]
      },
    },
    history: {
      search: async request => {
        calls.push(['history.search', request])
        return [{ title: 'Recent project', url: 'https://example.test/recent', visitCount: 12, typedCount: 3, lastVisitTime: 1700000001000 }]
      },
    },
    ...overrides,
  }
}

test('parsePlacesArgs defaults to all sources and validates the bounded contract', () => {
  assert.deepEqual(parsePlacesArgs(), { query: '', sources: ['shortcuts', 'bookmarks', 'history'], limit: 8 })
  assert.deepEqual(parsePlacesArgs({ query: '  Mail  ', sources: ['history'], limit: 2 }), { query: 'Mail', sources: ['history'], limit: 2 })
  const invalid = [
    { query: 4 },
    { query: 'x'.repeat(201) },
    { sources: [] },
    { sources: ['history', 'history'] },
    { sources: ['other'] },
    { limit: 0 },
    { limit: 21 },
    { limit: 1.5 },
    { unknown: true },
  ]
  for (const args of invalid) assert.throws(() => parsePlacesArgs(args), error => error.code === 'BAD_PLACES')
})

test('searchPlaces reads all default sources, preserves order, caps per source, and filters unsafe URLs', async () => {
  const api = fakeApi()
  const result = await searchPlaces({ limit: 1 }, api)
  assert.equal(result.op, 'places.search')
  assert.deepEqual(result.sources, ['shortcuts', 'bookmarks', 'history'])
  assert.deepEqual(result.counts, { shortcuts: 1, bookmarks: 1, history: 1 })
  assert.deepEqual(result.places.map(place => place.url), [
    'https://example.test/board',
    'https://example.test/saved',
    'https://example.test/recent',
  ])
  assert.deepEqual(api.calls, [
    ['shortcuts'],
    ['bookmarks.tree'],
    ['history.search', { text: '', maxResults: 1 }],
  ])
  assert.equal(result.places[1].dateAdded, 1700000000000)
  assert.equal(result.places[2].visitCount, 12)
  assert.equal(result.places[2].typedCount, 3)
  assert.equal(result.places[2].lastVisitTime, 1700000001000)
  assert.ok(result.places.every(place => !place.url.startsWith('javascript:') && !place.url.startsWith('chrome:')))
})

test('searchPlaces applies queries locally to shortcuts and through bookmark/history search', async () => {
  const api = fakeApi()
  const result = await searchPlaces({ query: ' PrOjEcT ', sources: ['shortcuts', 'bookmarks', 'history'], limit: 2 }, api)
  assert.equal(result.query, 'PrOjEcT')
  assert.deepEqual(result.places.map(place => place.source), ['shortcuts', 'bookmarks', 'history'])
  assert.deepEqual(api.calls, [
    ['shortcuts'],
    ['bookmarks.search', 'PrOjEcT'],
    ['history.search', { text: 'PrOjEcT', maxResults: 2 }],
  ])
  assert.equal(result.places[0].title, 'Project board')
})

test('searchPlaces can return an empty result without inventing a destination', async () => {
  const api = fakeApi({
    topSites: { get: async () => [{ title: 'Other', url: 'https://other.test' }] },
  })
  const result = await searchPlaces({ query: 'missing', sources: ['shortcuts'] }, api)
  assert.deepEqual(result.places, [])
  assert.deepEqual(result.counts, { shortcuts: 0 })
})

test('searchPlaces rejects bad input before browser access and names unavailable sources', async () => {
  const api = fakeApi()
  await assert.rejects(searchPlaces({ sources: [] }, api), error => error.code === 'BAD_PLACES')
  assert.deepEqual(api.calls, [])
  const failing = fakeApi({
    history: { search: async () => { throw new Error('permission denied') } },
  })
  await assert.rejects(
    searchPlaces({ sources: ['history'] }, failing),
    error => error.code === 'PLACES_UNAVAILABLE' && /history: permission denied/.test(error.message),
  )
})
