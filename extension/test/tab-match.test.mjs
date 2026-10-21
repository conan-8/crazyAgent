import test from 'node:test'
import assert from 'node:assert/strict'
import { matchTabQuery } from '../sidepanel/browser.js'

const TABS = [
  { id: 1, index: 0, title: 'Build sidebar browser agent Phase 1', url: 'http://127.0.0.1:3080/', active: true },
  { id: 2, index: 1, title: 'Conan, Personal Statement - Google Docs', url: 'https://docs.google.com/document/d/abc/edit' },
  { id: 3, index: 2, title: 'Inbox (1,824) - yiconan885@gmail.com - Gmail', url: 'https://mail.google.com/mail/u/0/' },
  { id: 4, index: 3, title: 'DeepSeek Platform', url: 'https://platform.deepseek.com/usage', discarded: true },
]

test('matches title substrings case-insensitively', () => {
  assert.equal(matchTabQuery(TABS, 'personal statement').tab.id, 2)
  assert.equal(matchTabQuery(TABS, 'GMAIL').tab.id, 3)
})

test('matches URL substrings', () => {
  assert.equal(matchTabQuery(TABS, 'mail.google.com').tab.id, 3)
  assert.equal(matchTabQuery(TABS, 'docs.google.com').tab.id, 2)
})

test('prefers exact and prefix matches over mid-string matches', () => {
  const tabs = [
    { id: 10, index: 0, title: 'Docs archive', url: 'https://example.test/archive' },
    { id: 11, index: 1, title: 'Docs', url: 'https://docs.example.test/' },
  ]
  assert.equal(matchTabQuery(tabs, 'docs').tab.id, 11)
})

test('returns undefined for empty or unmatched queries', () => {
  assert.equal(matchTabQuery(TABS, ''), undefined)
  assert.equal(matchTabQuery(TABS, '   '), undefined)
  assert.equal(matchTabQuery(TABS, 'no such tab'), undefined)
})

test('reports how many tabs matched', () => {
  const result = matchTabQuery(TABS, 'google')
  assert.equal(result.matchCount, 2)
})
