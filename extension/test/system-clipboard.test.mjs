import test from 'node:test'
import assert from 'node:assert/strict'
import {
  preserveSystemClipboard,
  restoreSystemClipboard,
  writeImageToSystemClipboard,
} from '../sidepanel/system-clipboard.js'

class FakeClipboardItem {
  constructor(entries) {
    this.entries = entries
    this.types = Object.keys(entries)
  }

  async getType(type) {
    return this.entries[type]
  }
}

const png = new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' })
const text = value => new Blob([value], { type: 'text/plain' })

test('image paste handoff preserves and restores every previous clipboard format', async () => {
  const previous = new FakeClipboardItem({ 'text/plain': text('private old clipboard'), 'image/png': png })
  const writes = []
  const api = {
    read: async () => [previous],
    write: async items => writes.push(items),
    writeText: async value => writes.push(value),
  }
  const snapshot = await preserveSystemClipboard(api, FakeClipboardItem)
  assert.equal(snapshot.items.length, 1)
  assert.deepEqual(snapshot.items[0].map(entry => entry.type), ['text/plain', 'image/png'])

  await writeImageToSystemClipboard({ mimeType: 'image/png', data: 'iVBORw==' }, api, FakeClipboardItem)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0][0].types, ['image/png'])
  assert.equal(await writes[0][0].entries['image/png'].text(), await png.text())

  await restoreSystemClipboard(snapshot, api, FakeClipboardItem)
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[1][0].types, ['text/plain', 'image/png'])
  assert.equal(await writes[1][0].entries['text/plain'].text(), 'private old clipboard')
  assert.equal(await writes[1][0].entries['image/png'].text(), await png.text())
})

test('an empty previous clipboard is restored to empty text', async () => {
  const writes = []
  const api = {
    read: async () => [],
    write: async () => assert.fail('empty restore should use writeText'),
    writeText: async value => writes.push(value),
  }
  const snapshot = await preserveSystemClipboard(api, FakeClipboardItem)
  await restoreSystemClipboard(snapshot, api, FakeClipboardItem)
  assert.deepEqual(writes, [''])
})

test('preservation fails before image staging when the old clipboard cannot be read', async () => {
  let writeCalls = 0
  const api = {
    read: async () => { throw new DOMException('Document is not focused', 'NotAllowedError') },
    write: async () => { writeCalls += 1 },
  }
  await assert.rejects(
    () => preserveSystemClipboard(api, FakeClipboardItem),
    error => error.code === 'CLIPBOARD_PRESERVE_FAILED' && /preserving the previous clipboard/.test(error.message),
  )
  assert.equal(writeCalls, 0)
})

test('preservation has a bounded memory budget and image writes require PNG', async () => {
  const api = {
    read: async () => [new FakeClipboardItem({ 'image/png': { size: 25_000_001 } })],
    write: async () => assert.fail('oversized preservation must not stage an image'),
  }
  await assert.rejects(() => preserveSystemClipboard(api, FakeClipboardItem), error => error.code === 'CLIPBOARD_PRESERVE_FAILED')
  await assert.rejects(
    () => writeImageToSystemClipboard({ mimeType: 'image/jpeg', data: 'AAAA' }, api, FakeClipboardItem),
    error => error.code === 'BAD_CLIPBOARD_IMAGE',
  )
})

test('async clipboard denial is reported without an offscreen or native fallback', async () => {
  const api = {
    write: async () => { throw new DOMException('Document is not focused', 'NotAllowedError') },
  }
  await assert.rejects(
    () => writeImageToSystemClipboard({ mimeType: 'image/png', data: 'iVBORw==' }, api, FakeClipboardItem),
    error => error.code === 'CLIPBOARD_DENIED' && /Document is not focused/.test(error.message),
  )
})
