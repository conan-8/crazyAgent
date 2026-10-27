import test from 'node:test'
import assert from 'node:assert/strict'
import { docsDocumentId, docsExportRetryDelayMs, docsExportUrl, docsFetchExport } from '../sidepanel/docs-export.js'

const URL = 'https://docs.google.com/document/d/abc_123-X/edit?tab=t.0#heading=h.test'

function response(status, body = '', retryAfter) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => retryAfter ?? null },
    text: async () => body,
  }
}

test('Docs export accepts only exact document URLs and html/txt formats', () => {
  assert.equal(docsDocumentId(URL), 'abc_123-X')
  assert.equal(docsDocumentId('https://docs.google.com/spreadsheets/d/abc/edit'), undefined)
  assert.equal(docsDocumentId('https://example.com/document/d/abc/edit'), undefined)
  assert.equal(docsDocumentId('not a url'), undefined)
  assert.equal(docsExportUrl(URL, 'html'), 'https://docs.google.com/document/d/abc_123-X/export?format=html')
  assert.equal(docsExportUrl(URL, 'txt'), 'https://docs.google.com/document/d/abc_123-X/export?format=txt')
  assert.equal(docsExportUrl(URL, 'pdf'), undefined)
})

test('Docs export retry delay bounds Retry-After and uses growing backoff', () => {
  assert.equal(docsExportRetryDelayMs('2', 0), 2000)
  assert.equal(docsExportRetryDelayMs('0', 0), 250)
  assert.equal(docsExportRetryDelayMs('99', 0), 5000)
  assert.equal(docsExportRetryDelayMs(null, 0), 1200)
  assert.equal(docsExportRetryDelayMs(null, 1), 2400)
})

test('Docs export retries only bounded transient statuses and returns the body', async () => {
  const calls = []
  const sleeps = []
  const responses = [response(429, '', '0.3'), response(503), response(200, '<html>ok</html>')]
  const result = await docsFetchExport(URL, 'html', {
    fetch: async (url, options) => {
      calls.push({ url, options })
      return responses.shift()
    },
    sleep: async ms => sleeps.push(ms),
  })
  assert.equal(result.body, '<html>ok</html>')
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [300, 2400])
  assert.equal(calls[0].options.credentials, 'include')
  assert.equal(calls[0].options.redirect, 'follow')
})

test('Docs export does not retry permission failures', async () => {
  let calls = 0
  await assert.rejects(docsFetchExport(URL, 'html', {
    fetch: async () => { calls += 1; return response(403) },
  }), error => error.code === 'DOCS_EXPORT_PERMISSION')
  assert.equal(calls, 1)
})

test('Docs export stops after bounded transient retries', async () => {
  let calls = 0
  await assert.rejects(docsFetchExport(URL, 'html', {
    fetch: async () => { calls += 1; return response(429) },
    sleep: async () => {},
  }), error => error.code === 'DOCS_EXPORT_RATE_LIMIT')
  assert.equal(calls, 3)
})

test('Docs export has a bounded fetch and body-read timeout', async () => {
  await assert.rejects(docsFetchExport(URL, 'html', {
    timeoutMs: 5,
    fetch: async (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  }), error => error.code === 'DOCS_EXPORT_TIMEOUT' && /5ms/.test(error.message))
})

test('Docs export serializes concurrent requests and spaces successive calls', async () => {
  let now = 0
  const events = []
  const responses = [response(429, '', '0.3'), response(200, '<html>first</html>'), response(200, '<html>second</html>')]
  const io = {
    coordinate: true,
    now: () => now,
    sleep: async ms => { events.push(`sleep:${ms}`); now += ms },
    fetch: async () => { events.push('fetch'); return responses.shift() },
  }
  const [first, second] = await Promise.all([
    docsFetchExport(URL, 'html', io),
    docsFetchExport(URL, 'html', io),
  ])
  assert.equal(first.body, '<html>first</html>')
  assert.equal(second.body, '<html>second</html>')
  assert.deepEqual(events, ['fetch', 'sleep:300', 'fetch', 'sleep:250', 'fetch'])
})

test('Docs export shares a cooldown after the final rate-limit failure', async () => {
  let now = 0
  const sleeps = []
  const responses = [response(429, '', '2'), response(429, '', '2'), response(429, '', '2'), response(200, '<html>recovered</html>')]
  const io = {
    coordinate: true,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms },
    fetch: async () => responses.shift(),
  }
  const otherUrl = URL.replace('abc_123-X', 'other_456-Y')
  await assert.rejects(docsFetchExport(otherUrl, 'html', io), error => error.code === 'DOCS_EXPORT_RATE_LIMIT')
  const recovered = await docsFetchExport(otherUrl, 'html', io)
  assert.equal(recovered.body, '<html>recovered</html>')
  assert.deepEqual(sleeps, [2000, 2000, 2000])
})
