import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'

async function bridge(t, respond) {
  const server = new WebSocketServer({ port: 0, path: '/bridge' })
  await new Promise(resolve => server.once('listening', resolve))
  const commands = []
  const logEvents = []
  server.on('connection', ws => {
    ws.once('message', () => {
      ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
      ws.on('message', data => {
        const message = JSON.parse(data.toString())
        if (message.type === 'log.event') {
          logEvents.push(message.event)
          return
        }
        if (message.type !== 'browser.command') return
        const args = message.command?.args ?? {}
        const op = message.command?.op
        commands.push({ op, args })
        Promise.resolve(respond(op, args)).then(result => {
          ws.send(JSON.stringify({ v: 1, type: 'browser.result', id: message.id, ok: true, result }))
        }).catch(error => {
          ws.send(JSON.stringify({ v: 1, type: 'browser.result', id: message.id, ok: false, error: { code: error.code, message: error.message } }))
        })
      })
    })
  })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  const address = server.address()
  return { commands, logEvents, url: `ws://127.0.0.1:${address.port}/bridge` }
}

function context() {
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger: { info: () => {} },
    browserUse: { register: () => () => {} },
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
    on: () => () => {},
    effect: fn => {
      const iterator = fn()
      let step = iterator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = iterator.next()
      }
      return () => { for (const dispose of disposers.reverse()) dispose() }
    },
  }
  return { ctx, tools, dispose: () => { for (const dispose of disposers.reverse()) dispose() } }
}

async function setup(t, respond) {
  const parent = await mkdtemp(join(tmpdir(), 'crazyagent-file-tools-'))
  await mkdir(join(parent, 'Downloads'))
  // The provider reports resolved real paths, so compare against the resolved
  // root: a symlinked tmpdir (e.g. macOS /var -> /private/var) must not fail.
  const root = await realpath(join(parent, 'Downloads'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const fakeBridge = await bridge(t, respond)
  const fake = context()
  apply(fake.ctx, { bridgeUrl: fakeBridge.url, bridgeToken: 'test', requestTimeoutMs: 2_000, downloadsDir: root })
  t.after(() => fake.dispose())
  return { ...fakeBridge, root, parent, tools: fake.tools }
}

const exec = { callId: 'file-call', signal: new AbortController().signal }

test('provider chains a verified download into an upload with a Downloads-only envelope', async t => {
  const { tools, commands, root } = await setup(t, async (op, args) => {
    if (op === 'download') {
      await writeFile(join(root, 'report.txt'), 'report')
      return { op, view: 'none', download: { status: 'complete', path: join(root, 'report.txt'), size: 6, mime: 'text/plain', finalUrl: args.url } }
    }
    return {
      op,
      view: 'none',
      screenshotSkipped: true,
      tab: { id: 7, title: 'Fixture', url: 'https://example.test/upload' },
      upload: { status: 'attached', filename: 'report.txt', size: 6, mime: 'text/plain', input: { index: 1, name: 'Attachment' } },
    }
  })
  const downloaded = await tools.get('browser_download').execute({ url: 'https://example.test/report.txt', filename: 'report.txt' }, exec)
  assert.match(downloaded.content[0].text, /downloaded "report\.txt" · 6 bytes/)
  assert.match(downloaded.content[0].text, /pass filename:"report\.txt" to browser_upload/)
  assert.deepEqual(commands[0], {
    op: 'download',
    args: { url: 'https://example.test/report.txt', filename: 'report.txt', root, timeout_ms: 30_000 },
  })
  const uploaded = await tools.get('browser_upload').execute({ filename: 'report.txt', name: '  Attach\n file  ', view: 'none' }, exec)
  assert.match(uploaded.content[0].text, /attached "report\.txt" · 6 bytes/)
  assert.match(uploaded.content[0].text, /verified by file-input readback/)
  assert.match(uploaded.content[0].text, /server submission\/persistence is not/)
  assert.deepEqual(commands[1], {
    op: 'upload',
    args: { filename: 'report.txt', path: join(root, 'report.txt'), root, size: 6, name: 'Attach file', view: 'none' },
  })
})

test('provider rejects invalid targets and paths before bridge traffic', async t => {
  const { tools, commands, root } = await setup(t, () => { throw new Error('unexpected browser call') })
  await writeFile(join(root, 'report.txt'), 'report')
  const download = tools.get('browser_download')
  for (const args of [
    {},
    { url: 'https://example.test/a', label: 2 },
    { url: 'file:///tmp/a' },
    { url: 'https://example.test/a', filename: '../escape' },
    { url: 'https://example.test/a', timeout_ms: 999 },
  ]) await assert.rejects(download.execute(args, exec))
  const upload = tools.get('browser_upload')
  for (const args of [
    { filename: 'missing.txt' },
    { filename: join(root, 'report.txt') },
    { filename: '../escape.txt' },
    { filename: 'report.txt', label: 2, input: 1 },
    { filename: 'report.txt', name: '   ' },
  ]) await assert.rejects(upload.execute(args, exec))
  assert.equal(commands.length, 0)
})

test('provider refuses outside downloads and ambiguous upload readback', async t => {
  const { tools, parent, root } = await setup(t, op => {
    if (op === 'download') return { op, download: { path: join(parent, 'outside.txt'), size: 7, finalUrl: 'https://example.test/outside' } }
    return { op, view: 'none', upload: { status: 'attached', filename: 'report.txt', size: 999, input: {} } }
  })
  await writeFile(join(parent, 'outside.txt'), 'outside')
  await writeFile(join(root, 'report.txt'), 'report')
  await assert.rejects(
    tools.get('browser_download').execute({ url: 'https://example.test/outside' }, exec),
    error => error.code === 'DOWNLOADS_OUTSIDE_FOLDER',
  )
  await assert.rejects(
    tools.get('browser_upload').execute({ filename: 'report.txt' }, exec),
    /assignment may have succeeded.*inspect the page/,
  )
})

test('Downloads search recovers plus-encoded names and upload errors return exact alternatives', async t => {
  const { tools, commands, root } = await setup(t, op => ({
    op,
    view: 'none',
    screenshotSkipped: true,
    upload: { status: 'attached', filename: 'Chapter+2+Review+Package-Oct25.docx', size: 6, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', input: { index: 1 } },
  }))
  await writeFile(join(root, 'Chapter+2+Review+Package-Oct25.docx'), 'review')
  const listed = await tools.get('browser_downloads').execute({ query: 'chapter 2 review', limit: 5 }, exec)
  assert.match(listed.content[0].text, /Chapter\+2\+Review\+Package-Oct25\.docx/)
  assert.equal(commands.length, 0, 'read-only listing does not need the browser bridge')
  await assert.rejects(
    tools.get('browser_upload').execute({ filename: 'Chapter 2 Review Package-Oct25.docx' }, exec),
    /Possible actual filename\(s\): "Chapter\+2\+Review\+Package-Oct25\.docx"/,
  )
  assert.equal(commands.length, 0)
  const uploaded = await tools.get('browser_upload').execute({ filename: 'Chapter+2+Review+Package-Oct25.docx', view: 'none' }, exec)
  assert.match(uploaded.content[0].text, /attached "Chapter\+2\+Review\+Package-Oct25\.docx" · 6 bytes/)
  assert.equal(commands[0].args.path, join(root, 'Chapter+2+Review+Package-Oct25.docx'))
})

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for condition')
}

test('empty, whitespace, or invalid downloadsDir never blocks provider registration', async t => {
  const fakeBridge = await bridge(t, () => { throw new Error('unexpected browser call') })
  const parent = await mkdtemp(join(tmpdir(), 'crazyagent-file-tools-config-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  for (const downloadsDir of ['', '   ']) {
    const fake = context()
    apply(fake.ctx, { bridgeUrl: fakeBridge.url, bridgeToken: 'test', requestTimeoutMs: 500, downloadsDir })
    assert.equal(fake.tools.size, 34, `downloadsDir ${JSON.stringify(downloadsDir)} must not remove tools`)
    fake.dispose()
  }
  // A syntactically invalid value falls back to the default with a warned
  // event instead of failing plugin setup.
  const rejectedFake = context()
  apply(rejectedFake.ctx, { bridgeUrl: fakeBridge.url, bridgeToken: 'test', requestTimeoutMs: 500, downloadsDir: 'relative/Downloads' })
  t.after(() => rejectedFake.dispose())
  assert.equal(rejectedFake.tools.size, 34)
  await waitFor(() => fakeBridge.logEvents.some(event => event.type === 'downloads.config.rejected'))
  const rejected = fakeBridge.logEvents.find(event => event.type === 'downloads.config.rejected')
  assert.equal(rejected.data.configured, 'relative/Downloads')
  assert.equal(rejected.severity, 'warn')
  // An absolute but missing folder still registers everything and fails closed
  // per call with the precise code.
  const missingFake = context()
  apply(missingFake.ctx, { bridgeUrl: fakeBridge.url, bridgeToken: 'test', requestTimeoutMs: 500, downloadsDir: join(parent, 'missing-downloads') })
  t.after(() => missingFake.dispose())
  assert.equal(missingFake.tools.size, 34)
  await assert.rejects(
    missingFake.tools.get('browser_downloads').execute({}, exec),
    error => error.code === 'DOWNLOADS_FOLDER_UNAVAILABLE',
  )
})

test('browser_downloads finds a file saved under a relative subdirectory path', async t => {
  const { tools, commands, root } = await setup(t, () => { throw new Error('unexpected browser call') })
  await mkdir(join(root, 'reports', 'q1'), { recursive: true })
  await writeFile(join(root, 'reports', 'q1', 'nested.txt'), 'nested')
  const listed = await tools.get('browser_downloads').execute({ query: 'nested.txt', limit: 5 }, exec)
  assert.match(listed.content[0].text, /reports\/q1\/nested\.txt/)
  assert.equal(commands.length, 0, 'read-only listing does not need the browser bridge')
  const listing = tools.get('browser_downloads')
  assert.doesNotMatch(listing.description, /Does not recurse/)
  assert.match(listing.description, /subdirectories up to 3 levels/)
  // The label parameter describes both supported target shapes: a direct link
  // downloaded by href and a Download control clicked through Chrome.
  const label = tools.get('browser_download').parameters.properties.label.description
  assert.match(label, /Download control/)
  assert.match(label, /downloaded by its resolved http\(s\) href/)
  assert.match(label, /clicked and the resulting Chrome download is verified/)
})
