import test from 'node:test'
import assert from 'node:assert/strict'
import { executeDownload, executeUpload, parseDownloadArgs, parseUploadArgs, pathInsideRoot } from '../sidepanel/files.js'

const ROOT = '/tmp/crazyagent-files/Downloads'
const PATH = `${ROOT}/report.txt`
const BASE_UPLOAD = { filename: 'report.txt', path: PATH, root: ROOT, size: 4, view: 'none' }

function uploadIo(overrides = {}) {
  const tab = { id: 7, title: 'Upload fixture', url: 'https://example.test/upload' }
  const calls = []
  const io = {
    calls,
    setCalls: 0,
    getActiveTab: async () => tab,
    assertCapturable: async () => {},
    runInAllFrames: async () => [{ frameId: 0, result: { inputs: [{ localIndex: 0, name: 'Attachment', signature: 'one', accept: '', multiple: false, disabled: false }] } }],
    runInFrame: async (_tabId, _frameId, _func, args) => {
      const request = args[0]
      calls.push(request)
      if (request.mode === 'cleanup') return { ok: true }
      if (request.mode === 'verify') return { ok: true, files: [{ name: 'report.txt', size: 4, type: 'text/plain' }] }
      return { ok: true, localIndex: 0, name: 'Attachment', signature: 'one' }
    },
    setFileInput: async (_tabId, token, path) => { io.setCalls += 1; calls.push({ mode: 'set', token, path }) },
    actionView: async () => ({ mode: 'none', payload: { view: 'none', screenshotSkipped: true } }),
    resolveLabelTarget: () => undefined,
    ...overrides,
  }
  return io
}

test('path confinement handles POSIX and Windows roots without allowing escapes', () => {
  assert.equal(pathInsideRoot(ROOT, PATH), true)
  assert.equal(pathInsideRoot(ROOT, `${ROOT}/nested/file.txt`), true)
  assert.equal(pathInsideRoot(ROOT, '/tmp/crazyagent-files/other.txt'), false)
  assert.equal(pathInsideRoot(ROOT, `${ROOT}/../other.txt`), false)
  assert.equal(pathInsideRoot(ROOT, 'report.txt'), false)
  assert.equal(pathInsideRoot('C:\\Users\\me\\Downloads', 'c:\\users\\me\\downloads\\report.txt'), true)
  assert.equal(pathInsideRoot('C:\\Users\\me\\Downloads', 'C:\\Users\\me\\other\\report.txt'), false)
})

test('download and upload arguments enforce bounded contracts', () => {
  assert.deepEqual(parseDownloadArgs({ url: 'https://example.test/file', root: ROOT }), {
    url: 'https://example.test/file', label: undefined, filename: undefined, root: ROOT, timeoutMs: 30_000,
  })
  assert.deepEqual(parseUploadArgs(BASE_UPLOAD), { ...BASE_UPLOAD, label: undefined, name: undefined, input: undefined })
  for (const args of [
    {}, { url: 'https://example.test/file', label: 2, root: ROOT }, { url: 'file:///tmp/a', root: ROOT },
    { url: 'https://example.test/file', root: ROOT, filename: '../escape' },
    { url: 'https://example.test/file', root: ROOT, timeout_ms: 999 },
  ]) assert.throws(() => parseDownloadArgs(args))
  for (const args of [
    { ...BASE_UPLOAD, path: '/tmp/outside.txt' },
    { ...BASE_UPLOAD, filename: '../report.txt' },
    { ...BASE_UPLOAD, filename: 'other.txt' },
    { ...BASE_UPLOAD, size: -1 },
    { ...BASE_UPLOAD, label: 2, input: 1 },
    { ...BASE_UPLOAD, view: 'fresh' },
  ]) assert.throws(() => parseUploadArgs(args))
})

test('download waits for the completed file and returns text-only evidence', async () => {
  const calls = []
  const tab = { id: 7, title: 'Fixture', url: 'https://example.test/' }
  const result = await executeDownload({ url: 'https://example.test/report.txt', root: ROOT }, {
    getActiveTab: async () => tab,
    assertCapturable: async () => {},
    download: async request => {
      calls.push(request)
      return { path: PATH, size: 4, mime: 'text/plain', finalUrl: request.url }
    },
    tabSummary: value => ({ id: value.id, url: value.url }),
  })
  assert.equal(calls[0].timeoutMs, 30_000)
  assert.equal(result.download.status, 'complete')
  assert.equal(result.download.path, PATH)
  assert.equal(result.image, undefined)
  assert.equal(result.view, 'none')
})

test('label downloads revalidate the link and active tab before starting', async () => {
  const tab = { id: 7, title: 'Fixture', url: 'https://example.test/' }
  let downloads = 0
  const io = {
    getActiveTab: async () => tab,
    assertCapturable: async () => {},
    resolveLabelTarget: () => ({ frameId: 2, localId: 4 }),
    runInFrame: async (_tabId, frameId, _func, args) => ({ ok: frameId === 2 && args[0] === 4, url: 'https://example.test/report.txt', text: 'Report' }),
    download: async () => { downloads += 1; return { path: PATH, size: 4 } },
    tabSummary: value => ({ id: value.id }),
  }
  const result = await executeDownload({ label: 200004, root: ROOT }, io)
  assert.equal(result.download.label, 200004)
  assert.equal(result.download.linkText, 'Report')
  assert.equal(downloads, 1)
})

test('dynamic download controls use the click-event path and reject filename overrides', async () => {
  const tab = { id: 7, title: 'Fixture', url: 'https://example.test/' }
  const calls = []
  const io = {
    getActiveTab: async () => tab,
    assertCapturable: async () => {},
    resolveLabelTarget: () => ({ frameId: 2, localId: 14 }),
    runInFrame: async () => ({ ok: true, click: true, text: 'Download' }),
    downloadClick: async request => { calls.push(request); return { path: PATH, size: 4, finalUrl: 'blob:https://example.test/id' } },
    download: async () => { throw new Error('direct download must not run') },
    tabSummary: value => ({ id: value.id }),
  }
  const result = await executeDownload({ label: 200014, root: ROOT }, io)
  assert.deepEqual(calls, [{ label: 200014, root: ROOT, timeoutMs: 30_000 }])
  assert.equal(result.download.linkText, 'Download')
  await assert.rejects(executeDownload({ label: 200014, root: ROOT, filename: 'forced.txt' }, io), error => error.code === 'BAD_DOWNLOAD_FILENAME')
  assert.equal(calls.length, 1)
})

test('upload selects a unique hidden input and verifies the attached file', async () => {
  const io = uploadIo()
  const result = await executeUpload(BASE_UPLOAD, io)
  assert.equal(io.setCalls, 1)
  assert.equal(result.upload.status, 'attached')
  assert.equal(result.upload.verifiedBy, 'file-input-readback')
  assert.equal(result.upload.filename, 'report.txt')
  assert.equal(result.upload.size, 4)
  assert.equal(io.calls.at(-1).mode, 'cleanup')
})

test('upload resolves an exact accessible name across frames', async () => {
  const io = uploadIo({
    runInAllFrames: async () => [
      { frameId: 2, result: { inputs: [{ localIndex: 0, name: 'Resume', signature: 'resume', disabled: false, crossOrigin: false }] } },
      { frameId: 0, result: { inputs: [{ localIndex: 0, name: 'Attachment', signature: 'attachment', disabled: false, crossOrigin: false }] } },
    ],
  })
  const result = await executeUpload({ ...BASE_UPLOAD, name: 'Resume' }, io)
  assert.equal(result.upload.input.frame, 2)
  assert.equal(result.upload.input.index, 2)
  assert.equal(io.calls[0].localIndex, 0)
  assert.equal(io.calls[0].signature, 'resume')
})

test('upload refuses a discovered input inside a cross-origin frame before assignment', async () => {
  const io = uploadIo({
    runInAllFrames: async () => [{ frameId: 5, result: { inputs: [
      { localIndex: 0, name: 'Frame attachment', signature: 'frame', disabled: false, crossOrigin: true },
    ] } }],
  })
  await assert.rejects(executeUpload({ ...BASE_UPLOAD, name: 'Frame attachment' }, io), error => {
    assert.equal(error.code, 'UPLOAD_FRAME_UNSUPPORTED')
    assert.equal(error.mutationPossible, undefined)
    assert.match(error.message, /cross-origin \(site-isolated\) iframe/)
    assert.match(error.message, /No file was assigned/)
    assert.match(error.message, /Do not retry/)
    assert.match(error.message, /same-origin/)
    assert.match(error.message, /cross-origin-unsupported/)
    return true
  })
  assert.equal(io.setCalls, 0)
  assert.equal(io.calls.length, 0, 'no probe, prepare, or cleanup may run after the refusal')
})

test('upload reports an unsupported cross-origin frame from the label probe', async () => {
  const io = uploadIo({
    resolveLabelTarget: () => ({ frameId: 4, localId: 9 }),
    runInFrame: async (_tabId, _frameId, _func, args) => {
      io.calls.push(args[0])
      return { ok: false, code: 'UPLOAD_FRAME_UNSUPPORTED', message: 'cross-origin frame; no file was assigned' }
    },
  })
  await assert.rejects(executeUpload({ ...BASE_UPLOAD, label: 9 }, io), error => {
    assert.equal(error.code, 'UPLOAD_FRAME_UNSUPPORTED')
    assert.equal(error.mutationPossible, undefined)
    return true
  })
  assert.equal(io.setCalls, 0)
  assert.equal(io.calls.some(request => request.mode === 'cleanup'), false, 'nothing was marked, so no cleanup is needed')
})

test('upload maps a non-top-frame token lookup miss to UPLOAD_FRAME_UNSUPPORTED', async () => {
  const io = uploadIo({
    runInAllFrames: async () => [{ frameId: 5, result: { inputs: [
      { localIndex: 0, name: 'Frame attachment', signature: 'frame', disabled: false, crossOrigin: false },
    ] } }],
    runInFrame: async (_tabId, _frameId, _func, args) => {
      const request = args[0]
      io.calls.push(request)
      if (request.mode === 'cleanup') return { ok: true }
      return { ok: true, localIndex: 0, name: 'Frame attachment', crossOrigin: false }
    },
    setFileInput: async () => {
      const error = new Error('Expected one marked file input, found 0; no file was assigned.')
      error.code = 'UPLOAD_STALE'
      error.mutationPossible = false
      throw error
    },
  })
  await assert.rejects(executeUpload(BASE_UPLOAD, io), error => {
    assert.equal(error.code, 'UPLOAD_FRAME_UNSUPPORTED')
    assert.equal(error.mutationPossible, false)
    assert.equal(error.frameId, 5)
    assert.match(error.message, /found in frame 5/)
    assert.match(error.message, /No file was assigned/)
    assert.match(error.message, /Do not retry/)
    assert.doesNotMatch(error.message, /may have succeeded/)
    return true
  })
  assert.equal(io.calls.at(-1).mode, 'cleanup')
})

test('ambiguous inputs fail before assignment and return explicit choices', async () => {
  const io = uploadIo({
    runInAllFrames: async () => [{ frameId: 0, result: { inputs: [
      { localIndex: 0, name: 'Images', signature: 'one', disabled: false },
      { localIndex: 1, name: 'Documents', signature: 'two', disabled: false },
    ] } }],
  })
  await assert.rejects(executeUpload(BASE_UPLOAD, io), error => {
    assert.equal(error.code, 'UPLOAD_TARGET_AMBIGUOUS')
    assert.match(error.message, /input:1/)
    assert.match(error.message, /input:2/)
    return true
  })
  assert.equal(io.setCalls, 0)
  assert.equal(io.calls.length, 0)
})

test('readback failure reports possible mutation and still cleans the marker', async () => {
  const io = uploadIo({
    runInFrame: async (_tabId, _frameId, _func, args) => {
      const request = args[0]
      io.calls.push(request)
      if (request.mode === 'cleanup') return { ok: true }
      if (request.mode === 'verify') return { ok: false, code: 'UPLOAD_READBACK_FAILED', message: 'mismatch' }
      return { ok: true, localIndex: 0, name: 'Attachment' }
    },
  })
  await assert.rejects(executeUpload(BASE_UPLOAD, io), error => {
    assert.equal(error.code, 'UPLOAD_READBACK_FAILED')
    assert.equal(error.mutationPossible, true)
    assert.match(error.message, /do not retry blindly|inspect the page/)
    return true
  })
  assert.equal(io.calls.at(-1).mode, 'cleanup')
})

test('target preparation failures cannot assign a file', async () => {
  const io = uploadIo({
    runInFrame: async (_tabId, _frameId, _func, args) => {
      io.calls.push(args[0])
      return { ok: false, code: 'UPLOAD_STALE', message: 'changed' }
    },
  })
  await assert.rejects(executeUpload(BASE_UPLOAD, io), error => error.code === 'UPLOAD_STALE' && error.mutationPossible !== true)
  assert.equal(io.setCalls, 0)
})
