import test from 'node:test'
import assert from 'node:assert/strict'
import { parseClipboardArgs } from '../sidepanel/browser.js'
import {
  CLIPBOARD_MAX_CHARS,
  CLIPBOARD_PREVIEW_CHARS,
  CLIPBOARD_READ_MAX_CHARS,
  CLIPBOARD_STORAGE_KEY,
  CLIPBOARD_TRUNCATION_MARKER,
  clipClipboardText,
  clipboardPreview,
  fitClipboardText,
  makeClipboardEntry,
  normalizeClipboardEntry,
} from '../sidepanel/clipboard.js'

/* ---------------------------------------------------------------- */
/* argument validation: fails before any page/storage access         */
/* ---------------------------------------------------------------- */

test('parseClipboardArgs defaults to the virtual clipboard', () => {
  const copy = parseClipboardArgs({ action: 'copy' })
  assert.equal(copy.action, 'copy')
  assert.equal(copy.target, 'virtual')
  assert.equal(copy.source, 'selection')
  assert.equal(copy.label, undefined)

  const paste = parseClipboardArgs({ action: 'paste' })
  assert.equal(paste.target, 'virtual')
  assert.equal(paste.mode, 'replace')
  assert.equal(paste.submit, false)
  assert.equal(paste.rich, true)
  assert.equal(paste.view, 'auto', 'paste defaults to the auto view')
  assert.notEqual(parseClipboardArgs({ action: 'read' }).view, 'auto', 'non-paste actions do not request a view')
  assert.equal(CLIPBOARD_STORAGE_KEY, 'crazyagent.clipboard')
})

test('parseClipboardArgs infers label source and echoes explicit targets', () => {
  const inferred = parseClipboardArgs({ action: 'copy', label: 9 })
  assert.equal(inferred.source, 'label')
  assert.equal(inferred.label, 9)

  const system = parseClipboardArgs({ action: 'read', target: 'system' })
  assert.equal(system.target, 'system')

  const paste = parseClipboardArgs({ action: 'paste', target: 'system', label: 4, mode: 'append', submit: true, view: 'none' })
  assert.deepEqual(
    { target: paste.target, label: paste.label, mode: paste.mode, submit: paste.submit, view: paste.view },
    { target: 'system', label: 4, mode: 'append', submit: true, view: 'none' },
  )

  assert.equal(parseClipboardArgs({ action: 'write', text: 'hello' }).text, 'hello')
})

test('parseClipboardArgs rejects bad actions, targets, sources, and fields', () => {
  const rejected = (args, code, pattern) => assert.throws(
    () => parseClipboardArgs(args),
    error => error.code === code && (pattern === undefined || pattern.test(error.message)),
    `${JSON.stringify(args)} should fail with ${code}`,
  )
  rejected({}, 'BAD_CLIPBOARD_ACTION', /copy, read, write, paste, clear/)
  rejected({ action: 'cut' }, 'BAD_CLIPBOARD_ACTION')
  rejected({ action: 'copy', target: 'disk' }, 'BAD_CLIPBOARD_TARGET', /virtual.*system/)
  rejected({ action: 'copy', source: 'clipboard' }, 'BAD_CLIPBOARD_SOURCE', /selection.*label/)
  rejected({ action: 'copy', source: 'label' }, 'BAD_LABEL', /requires a label/)
  rejected({ action: 'copy', source: 'selection', label: 3 }, 'BAD_LABEL', /only valid/)
  rejected({ action: 'paste', label: 0 }, 'BAD_LABEL', /positive integer/)
  rejected({ action: 'paste', label: 1.5 }, 'BAD_LABEL')
  rejected({ action: 'paste', mode: 'overwrite' }, 'BAD_MODE', /replace.*append/)
  rejected({ action: 'paste', rich: 'yes' }, 'BAD_RICH')
  rejected({ action: 'read', source: 'label' }, 'BAD_CLIPBOARD_SOURCE', /only valid for action "copy"/)
  rejected({ action: 'read', text: 42 }, 'BAD_TEXT', /string/)
  rejected({ action: 'write' }, 'BAD_TEXT', /string text/)
  rejected({ action: 'write', text: '' }, 'BAD_TEXT', /must not be empty/)
  rejected({ action: 'clear', target: 'system' }, 'BAD_CLIPBOARD_TARGET', /virtual clipboard only/)
})

/* ---------------------------------------------------------------- */
/* preview, truncation, and storage-entry normalization              */
/* ---------------------------------------------------------------- */

test('clipboardPreview collapses whitespace and keeps at most 200 chars', () => {
  assert.equal(clipboardPreview('  one\n\ntwo\tthree  '), 'one two three')
  assert.equal(clipboardPreview(''), '')
  assert.equal(clipboardPreview(undefined), '')
  const long = clipboardPreview('word '.repeat(400))
  assert.equal(long.length, CLIPBOARD_PREVIEW_CHARS)
  assert.match(long, /…$/)
  assert.equal(clipboardPreview('x'.repeat(500), 10), 'xxxxxxxxx…')
})

test('fitClipboardText caps text exactly at the limit with a visible marker', () => {
  const short = fitClipboardText('hello')
  assert.deepEqual(short, { text: 'hello', chars: 5, truncated: false, originalChars: 5 })

  const atLimit = fitClipboardText('x'.repeat(CLIPBOARD_MAX_CHARS))
  assert.equal(atLimit.truncated, false)
  assert.equal(atLimit.chars, CLIPBOARD_MAX_CHARS)

  const oversized = fitClipboardText('x'.repeat(CLIPBOARD_MAX_CHARS + 500))
  assert.equal(oversized.truncated, true)
  assert.equal(oversized.chars, CLIPBOARD_MAX_CHARS)
  assert.equal(oversized.text.length, CLIPBOARD_MAX_CHARS)
  assert.equal(oversized.originalChars, CLIPBOARD_MAX_CHARS + 500)
  assert.ok(oversized.text.endsWith(CLIPBOARD_TRUNCATION_MARKER), 'capped text says it was truncated')

  const tiny = fitClipboardText('abcdef', 4)
  assert.equal(tiny.truncated, true)
  assert.equal(tiny.text, CLIPBOARD_TRUNCATION_MARKER, 'a cap smaller than the marker still shows the marker')
  assert.equal(tiny.originalChars, 6)
})

test('clipClipboardText reports the read cap and the full length', () => {
  const clipped = clipClipboardText('y'.repeat(CLIPBOARD_READ_MAX_CHARS + 250))
  assert.equal(clipped.chars, CLIPBOARD_READ_MAX_CHARS)
  assert.equal(clipped.totalChars, CLIPBOARD_READ_MAX_CHARS + 250)
  assert.equal(clipped.truncated, true)
  assert.equal(clipped.offset, 0)
  assert.equal(clipClipboardText('short').truncated, false)
})

test('storage entries round-trip and reject corrupted values', () => {
  const entry = makeClipboardEntry({ text: 'selected text', source: 'selection', tabId: 7, url: 'https://example.test/', at: 123 })
  assert.deepEqual(entry, {
    text: 'selected text',
    chars: 13,
    source: 'selection',
    tabId: 7,
    url: 'https://example.test/',
    at: 123,
  })
  assert.deepEqual(normalizeClipboardEntry(entry), entry)

  const write = makeClipboardEntry({ text: 'written', source: 'write' })
  assert.equal(write.tabId, null)
  assert.equal(write.url, '')
  assert.ok(write.at > 0)

  assert.equal(normalizeClipboardEntry(undefined), undefined)
  assert.equal(normalizeClipboardEntry(null), undefined)
  assert.equal(normalizeClipboardEntry('text'), undefined)
  assert.equal(normalizeClipboardEntry([]), undefined)
  assert.equal(normalizeClipboardEntry({ chars: 3 }), undefined, 'an entry without text is unusable')

  const repaired = normalizeClipboardEntry({ text: 'z'.repeat(CLIPBOARD_MAX_CHARS + 20), source: 7, tabId: 'x', at: 'y' })
  assert.equal(repaired.chars, CLIPBOARD_MAX_CHARS)
  assert.equal(repaired.text.length, CLIPBOARD_MAX_CHARS)
  assert.equal(repaired.source, 'unknown')
  assert.equal(repaired.tabId, null)
  assert.equal(repaired.at, 0)
})