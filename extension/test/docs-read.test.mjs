import test from 'node:test'
import assert from 'node:assert/strict'
import { docsRead } from '../sidepanel/browser.js'

const URL = 'https://docs.google.com/document/d/abc/edit'
const HTML = '<html><head><style>.title{font-size:28pt}</style></head><body><p class="title"><span>Heading</span></p><ul><li><span>one</span></li><li><span>two</span></li></ul><p></p></body></html>'

function fakeRead(options = {}) {
  const tab = { id: 7, url: URL }
  const calls = []
  let tabChecks = 0
  let snapshots = 0
  const io = {
    now: () => 1000,
    getWindowId: async () => 1,
    getActiveTab: async () => ({ ...tab }),
    getTab: async () => {
      tabChecks += 1
      return options.staleAfter === tabChecks ? { ...tab, url: 'https://example.com/stale' } : { ...tab }
    },
    fetchExport: async (url, format) => {
      calls.push({ url, format })
      return { body: format === 'txt' ? (options.text ?? 'Heading\none\ntwo\n') : HTML }
    },
    snapshot: async () => { snapshots += 1 },
  }
  return { io, calls, snapshots: () => snapshots }
}

test('Docs read returns an outline from export without a screenshot', async () => {
  const fake = fakeRead()
  const result = await docsRead({}, { action: 'read', format: 'outline' }, fake.io)
  assert.equal(result.docs.action, 'read')
  assert.equal(result.docs.status, 'completed')
  assert.equal(result.docs.verifiedBy, 'export')
  assert.match(result.docs.content, /TITLE: Heading/)
  assert.match(result.docs.content, /• one/)
  assert.match(result.docs.content, /\(empty line\)/)
  assert.deepEqual(fake.calls, [{ url: URL, format: 'html' }])
  assert.equal(fake.snapshots(), 0)
})

test('Docs read supports raw html and plain text exports', async () => {
  const html = fakeRead()
  const raw = await docsRead({}, { action: 'read', format: 'html' }, html.io)
  assert.equal(raw.docs.content, HTML)
  const text = fakeRead()
  const plain = await docsRead({}, { action: 'read', format: 'text' }, text.io)
  assert.equal(plain.docs.content, 'Heading\none\ntwo\n')
  assert.deepEqual(text.calls, [{ url: URL, format: 'txt' }])
})

test('Docs read bounds content and reports truncation', async () => {
  const fake = fakeRead()
  const result = await docsRead({}, { action: 'read', format: 'html', max_chars: 100 }, fake.io)
  assert.equal(result.docs.truncated, true)
  assert.equal(result.docs.chars, HTML.length)
  assert.ok(result.docs.content.startsWith(HTML.slice(0, 100)))
  assert.match(result.docs.content, /truncated \d+ characters/)
})

test('Docs read paginates distinct slices and reaches the exact tail', async () => {
  const text = `${'a'.repeat(100)}MIDDLE-MARKER${'z'.repeat(100)}`
  const fake = fakeRead({ text })
  const first = await docsRead({}, { action: 'read', format: 'text', max_chars: 100 }, fake.io)
  assert.equal(first.docs.offset, 0)
  assert.equal(first.docs.nextOffset, 100)
  assert.equal(first.docs.truncated, true)
  assert.doesNotMatch(first.docs.content, /MIDDLE-MARKER/)

  const second = await docsRead({}, { action: 'read', format: 'text', max_chars: 100, offset: first.docs.nextOffset }, fake.io)
  assert.equal(second.docs.offset, 100)
  assert.equal(second.docs.nextOffset, 200)
  assert.match(second.docs.content, /MIDDLE-MARKER/)
  assert.notEqual(second.docs.content, first.docs.content)

  const third = await docsRead({}, { action: 'read', format: 'text', max_chars: 100, offset: second.docs.nextOffset }, fake.io)
  assert.equal(third.docs.content, 'z'.repeat(13))
  assert.equal(third.docs.nextOffset, null)
  assert.equal(third.docs.truncated, false)

  const beyond = await docsRead({}, { action: 'read', format: 'text', offset: 999 }, fake.io)
  assert.equal(beyond.docs.content, '')
  assert.equal(beyond.docs.returned, 0)
  assert.equal(beyond.docs.nextOffset, null)
})

test('Docs read rejects a stale document after export', async () => {
  const fake = fakeRead({ staleAfter: 2 })
  await assert.rejects(docsRead({}, { action: 'read' }, fake.io), error => error.code === 'DOCS_STALE_TAB')
  assert.equal(fake.snapshots(), 0)
})

test('Docs read validates inputs before using the tab', async () => {
  const fake = fakeRead()
  await assert.rejects(docsRead({}, { action: 'read', format: 'pdf' }, fake.io), error => error.code === 'DOCS_BAD_DOCS_READ_FORMAT')
  await assert.rejects(docsRead({}, { action: 'read', max_chars: 99 }, fake.io), error => error.code === 'DOCS_BAD_DOCS_READ_CHARS')
  await assert.rejects(docsRead({}, { action: 'read', offset: -1 }, fake.io), error => error.code === 'DOCS_BAD_DOCS_READ_OFFSET')
  await assert.rejects(docsRead({}, { action: 'read', unexpected: true }, fake.io), error => error.code === 'DOCS_BAD_DOCS_READ_ARGUMENT')
  assert.equal(fake.calls.length, 0)
  assert.equal(fake.snapshots(), 0)
})
