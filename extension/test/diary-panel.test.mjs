import test from 'node:test'
import assert from 'node:assert/strict'
import {
  filterDiaryEntries,
  formatDiaryAppliedText,
  formatDiaryHeaderPill,
  mergeDiaryAppliedEntries,
  normalizeDiarySnapshot,
  normalizeDiarySuggestions,
  parseSitesInput,
  siteFromTabUrl,
} from '../sidepanel/diary-panel.js'

test('diary-panel normalizes snapshots and suggestions defensively', () => {
  assert.deepEqual(normalizeDiarySnapshot(null), { version: 1, entries: [], suppressedCount: 0 })
  const snap = normalizeDiarySnapshot({
    entries: [
      { id: 'd1', scope: 'global', title: 'OTP', content: 'Check Gmail', enabled: true, source: 'manual' },
      { id: 'd1', scope: 'global', title: 'Duplicate', content: 'Ignored' },
      { id: 'bad', scope: 'site', sites: [], title: 'No sites', content: 'x' },
    ],
    suppressedCount: 3,
  })
  assert.equal(snap.entries.length, 1)
  assert.equal(snap.suppressedCount, 3)

  const sugs = normalizeDiarySuggestions([
    { id: 's1', action: 'add', scope: 'site', sites: ['Kimi.AI'], title: 'Kimi', content: 'Use alice@gmail.com', question: 'Save?' },
    { id: 's1', action: 'add', scope: 'global', title: 'Dup', content: 'Nope' },
    { id: 's2', action: 'update', replacesId: 'd1', previousEntry: { id: 'd1', scope: 'global', title: 'OTP', content: 'Old' }, scope: 'global', title: 'OTP', content: 'New', question: 'Update?' },
    { id: 'bad', scope: 'site', sites: [], title: 'Empty', content: 'x' },
  ])
  assert.equal(sugs.length, 2)
  assert.deepEqual(sugs[0].sites, ['kimi.ai'])
  assert.equal(sugs[1].previousEntry.content, 'Old')
})

test('diary-panel filters entries, parses sites, inspects tab URLs, and formats applied rows', () => {
  const entries = [
    { id: 'g1', scope: 'global', sites: [], title: 'Verification codes', content: 'Go to Gmail inbox' },
    { id: 's1', scope: 'site', sites: ['kimi.ai'], title: 'Kimi login', content: 'Use alice@gmail.com' },
  ]
  assert.equal(filterDiaryEntries(entries, { scope: 'global' }).length, 1)
  assert.equal(filterDiaryEntries(entries, { scope: 'site' }).length, 1)
  assert.equal(filterDiaryEntries(entries, { query: 'kimi' }).length, 1)
  assert.equal(filterDiaryEntries(entries, { query: 'gmail' }).length, 2)

  assert.equal(siteFromTabUrl('https://www.kimi.ai/chat'), 'kimi.ai')
  assert.equal(siteFromTabUrl('http://localhost:8080/a'), 'localhost')
  assert.equal(siteFromTabUrl('chrome://settings'), null)
  assert.equal(siteFromTabUrl('chrome-extension://abc/sidepanel/index.html'), null)
  assert.equal(siteFromTabUrl('file:///tmp/x.html'), null)

  assert.deepEqual(parseSitesInput('https://kimi.ai, *.chat.kimi.ai; edge://settings'), {
    sites: ['kimi.ai', 'chat.kimi.ai'],
    invalid: ['edge://settings'],
    tooMany: false,
  })

  assert.equal(formatDiaryAppliedText({ host: 'kimi.ai', titles: ['Kimi login'] }), 'Diary (kimi.ai): Kimi login')
  assert.equal(formatDiaryAppliedText({ count: 2, titles: ['OTP', 'Kimi'] }), 'Diary: OTP, Kimi')
})

test('diary-panel merges turn entries with deduplication and formats header pill', () => {
  assert.deepEqual(formatDiaryHeaderPill([]), { visible: false, latest: '', overflow: 0, text: '', tooltip: '' })

  let entries = mergeDiaryAppliedEntries([], { scope: 'turn-start', titles: ['Kimi login email'] })
  let pill = formatDiaryHeaderPill(entries)
  assert.equal(pill.visible, true)
  assert.equal(pill.latest, 'Kimi login email')
  assert.equal(pill.overflow, 0)
  assert.equal(pill.text, 'Diary · Kimi login email')
  assert.equal(pill.tooltip, 'Diary applied:\n• Kimi login email')

  // Multiple titles in one frame + mid-turn accumulation + case-insensitive deduplication
  entries = mergeDiaryAppliedEntries(entries, { scope: 'site', host: 'kimi.ai', titles: ['Verification codes', 'kimi login email', 'Concise style'] })
  pill = formatDiaryHeaderPill(entries)
  assert.equal(entries.length, 3)
  assert.equal(pill.latest, 'Concise style')
  assert.equal(pill.overflow, 2)
  assert.equal(pill.text, 'Diary · Concise style +2')
  assert.match(pill.tooltip, /^Diary applied:\n• Verification codes \(kimi\.ai\)\n• kimi login email \(kimi\.ai\)\n• Concise style \(kimi\.ai\)$/)

  // Fallback count-only frame without titles
  const countOnly = mergeDiaryAppliedEntries([], { scope: 'site', host: 'example.com', count: 3 })
  const countPill = formatDiaryHeaderPill(countOnly)
  assert.equal(countPill.latest, '3 notes')
  assert.equal(countPill.overflow, 0)
  assert.equal(countPill.text, 'Diary · 3 notes')
  assert.equal(countPill.tooltip, 'Diary applied:\n• 3 notes (example.com)')
})
