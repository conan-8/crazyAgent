#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9248'
const FIXTURES = join(process.cwd(), 'e2e', 'fixtures')
const extensionId = (() => {
  const hex = createHash('sha256').update(join(process.cwd(), 'extension')).digest('hex').slice(0, 32)
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('')
})()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const list = async () => (await fetch(`${CDP}/json`)).json()

async function connect(url) {
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let seq = 0
  const pending = new Map()
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    }
  })
  return {
    send(method, params = {}) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { ws.close() },
  }
}

const received = []
const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/upload') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const headerEnd = body.indexOf('\r\n\r\n')
      const header = body.subarray(0, headerEnd).toString('utf8')
      const filename = /filename="([^"]*)"/u.exec(header)?.[1]
      const contentStart = headerEnd + 4
      const contentEnd = body.indexOf('\r\n--', contentStart)
      if (!filename || headerEnd < 0 || contentEnd < 0) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false }))
        return
      }
      const content = body.subarray(contentStart, contentEnd)
      received.push({ filename, content })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, filename, size: content.length }))
      return
    }
    if (url.pathname === '/payload.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="payload.txt"' })
      res.end(await readFile(join(FIXTURES, 'payload.txt')))
      return
    }
    const files = { '/files.html': 'files.html', '/frame-files.html': 'frame-files.html' }
    const filename = files[url.pathname]
    if (filename) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(await readFile(join(FIXTURES, filename)))
      return
    }
    if (url.pathname === '/cross-origin-files.html') {
      // Parent page is opened from 127.0.0.1 while the frame loads from
      // localhost: a different site, so Edge site-isolates the frame into its
      // own OOPIF target that the tab-level debugger DOM tree cannot see.
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>CrazyAgent Cross-Origin File Fixture</title>
<style>body { font: 15px/1.5 system-ui, sans-serif; margin: 24px; } iframe { width: 100%; height: 150px; border: 1px solid #aaa; }</style></head>
<body>
  <h1>Cross-origin file frame fixture</h1>
  <iframe src="http://localhost:${address.port}/frame-files.html" title="Cross-origin file frame"></iframe>
  <pre id="state">idle</pre>
</body>
</html>`)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })().catch(error => {
    res.writeHead(500)
    res.end(String(error))
  })
})
// Bind every interface so both http://127.0.0.1 and http://localhost reach this
// server; that hostname difference is what makes the fixture frame cross-site.
await new Promise(resolve => server.listen(0, resolve))
const address = server.address()
assert.ok(address?.port > 0, 'fixture server did not report a port')
const BASE = `http://127.0.0.1:${address.port}`
const CROSS_ORIGIN_FRAME = `http://localhost:${address.port}/frame-files.html`
const parent = await mkdtemp(join(tmpdir(), 'crazyagent-files-e2e-'))
const ROOT = process.env.DOWNLOAD_ROOT ?? join(parent, 'Downloads')
await mkdir(ROOT, { recursive: true })

let panel
try {
  const version = await (await fetch(`${CDP}/json/version`)).json()
  const browser = await connect(version.webSocketDebuggerUrl)
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: ROOT })
  const targets = await list()
  let panelTarget = targets.find(target => target.type === 'page' && target.url.includes('/sidepanel/index.html'))
  if (!panelTarget) {
    const created = await browser.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel/index.html`, background: true })
    await sleep(800)
    panelTarget = (await list()).find(target => target.id === created.targetId)
  }
  browser.close()
  assert.ok(panelTarget, 'side panel target not found')
  panel = await connect(panelTarget.webSocketDebuggerUrl)
  await panel.send('Runtime.enable')

  async function evaluate(expression) {
    const result = await panel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }

  const fixture = await evaluate(`(async () => {
    const tab = await chrome.tabs.create({ url: '${BASE}/files.html?run=' + Date.now(), active: true })
    await new Promise(resolve => setTimeout(resolve, 800))
    return { id: tab.id }
  })()`)
  assert.ok(fixture?.id, 'fixture tab created')
  const prefix = `const mod = await import('./browser.js')
    const tabId = ${fixture.id}
    const settings = { ...mod.DEFAULT_SETTINGS }
    const root = ${JSON.stringify(ROOT)}
  `

  await evaluate(`(async () => { ${prefix}; await mod.beginDebuggerRun() })()`)

  const direct = await evaluate(`(async () => { ${prefix}
    const result = await mod.execute('download', { url: '${BASE}/payload.txt', filename: 'crazyagent-e2e.txt', root, timeout_ms: 10000 }, settings)
    return result.download
  })()`)
  const payload = await readFile(join(FIXTURES, 'payload.txt'))
  assert.equal(direct.status, 'complete')
  assert.deepEqual(await readFile(direct.path), payload)
  assert.equal(direct.size, payload.length)
  console.log('PASS direct URL download completed and independently matched the source bytes')

  const linked = await evaluate(`(async () => { ${prefix}
    const view = await mod.execute('snapshot', {}, settings)
    const label = view.labels.find(item => item.text === 'Download payload')?.id
    if (!label) throw new Error('Download link was not labelled')
    const result = await mod.execute('download', { label, filename: 'crazyagent-e2e.txt', root, timeout_ms: 10000 }, settings)
    return result.download
  })()`)
  assert.notEqual(linked.path, direct.path, 'filename collision must not overwrite the first file')
  assert.deepEqual(await readFile(linked.path), payload)
  assert.deepEqual(await readFile(direct.path), payload)
  console.log('PASS labelled-link download used a collision-safe second file')

  const dynamic = await evaluate(`(async () => { ${prefix}
    const view = await mod.execute('snapshot', {}, settings)
    const label = view.labels.find(item => item.text === 'Download viewer payload')?.id
    if (!label) throw new Error('Dynamic download button was not labelled')
    const result = await mod.execute('download', { label, root, timeout_ms: 10000 }, settings)
    return result.download
  })()`)
  assert.equal(dynamic.status, 'complete')
  assert.equal(dynamic.linkText, 'Download viewer payload')
  assert.match(dynamic.path, /Viewer\+Payload(?: \(\d+\))?\.txt$/)
  assert.deepEqual(await readFile(dynamic.path), payload)
  console.log('PASS dynamic viewer button download was captured and independently verified')

  const ambiguous = await evaluate(`(async () => { ${prefix}
    try {
      await mod.execute('upload', { filename: 'crazyagent-e2e.txt', path: ${JSON.stringify(direct.path)}, root, size: ${payload.length}, view: 'none' }, settings)
      return { code: 'NO_ERROR' }
    } catch (error) { return { code: error.code, message: error.message } }
  })()`)
  assert.equal(ambiguous.code, 'UPLOAD_TARGET_AMBIGUOUS')
  assert.match(ambiguous.message, /input:1/)
  console.log('PASS multiple file inputs fail closed with explicit choices')

  const hidden = await evaluate(`(async () => { ${prefix}
    const view = await mod.execute('snapshot', {}, settings)
    const label = view.labels.find(item => item.text === 'Choose hidden attachment')?.id
    if (!label) throw new Error('Hidden input label was not visible')
    const result = await mod.execute('upload', { filename: 'crazyagent-e2e.txt', path: ${JSON.stringify(direct.path)}, root, size: ${payload.length}, label, view: 'none' }, settings)
    const state = (await chrome.scripting.executeScript({ target: { tabId }, func: () => ({
      text: document.getElementById('state').textContent,
      files: document.getElementById('hidden-file').files.length,
      marked: document.querySelectorAll('[data-crazyagent-upload]').length,
    }) }))[0].result
    return { upload: result.upload, state }
  })()`)
  assert.equal(hidden.upload.status, 'attached')
  assert.equal(hidden.state.text, `attached:hidden-file:crazyagent-e2e.txt:${payload.length}`)
  assert.equal(hidden.state.files, 1)
  assert.equal(hidden.state.marked, 0)
  console.log('PASS associated label assigned a hidden input and cleaned its marker')

  const visible = await evaluate(`(async () => { ${prefix}
    const view = await mod.execute('snapshot', {}, settings)
    const label = view.labels.find(item => item.text === 'Visible attachment')?.id
    if (!label) throw new Error('Visible file input was not labelled')
    let clickError
    try { await mod.execute('click', { label, view: 'none' }, settings) }
    catch (error) { clickError = error.code }
    const result = await mod.execute('upload', { filename: 'crazyagent-e2e.txt', path: ${JSON.stringify(direct.path)}, root, size: ${payload.length}, label, view: 'none' }, settings)
    const text = (await chrome.scripting.executeScript({ target: { tabId }, func: () => document.getElementById('state').textContent }))[0].result
    return { clickError, upload: result.upload, text }
  })()`)
  assert.equal(visible.clickError, 'FILE_INPUT')
  assert.equal(visible.upload.status, 'attached')
  assert.equal(visible.text, `attached:visible-file:crazyagent-e2e.txt:${payload.length}`)
  console.log('PASS visible file input is labelled, picker clicks are guarded, and upload readback succeeds')

  await evaluate(`(async () => { ${prefix}
    const view = await mod.execute('snapshot', {}, settings)
    const label = view.labels.find(item => item.text === 'Send attachment')?.id
    if (!label) throw new Error('Send button was not labelled')
    await mod.execute('click', { label, view: 'none' }, settings)
  })()`)
  for (let index = 0; index < 50 && received.length === 0; index += 1) await sleep(50)
  assert.equal(received.length, 1)
  assert.equal(received[0].filename, 'crazyagent-e2e.txt')
  assert.deepEqual(received[0].content, payload)
  console.log('PASS receiving server independently matched the multipart filename and payload bytes')

  const shadow = await evaluate(`(async () => { ${prefix}
    const result = await mod.execute('upload', { filename: 'crazyagent-e2e.txt', path: ${JSON.stringify(direct.path)}, root, size: ${payload.length}, name: 'Shadow attachment', view: 'none' }, settings)
    const state = (await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const input = document.getElementById('shadow-host').shadowRoot.querySelector('input')
      return { name: input.files[0]?.name, size: input.files[0]?.size, marked: input.hasAttribute('data-crazyagent-upload') }
    } }))[0].result
    return { upload: result.upload, state }
  })()`)
  assert.equal(shadow.upload.status, 'attached')
  assert.deepEqual(shadow.state, { name: 'crazyagent-e2e.txt', size: payload.length, marked: false })
  console.log('PASS exact-name upload reached an open shadow-root input')

  const framed = await evaluate(`(async () => { ${prefix}
    const result = await mod.execute('upload', { filename: 'crazyagent-e2e.txt', path: ${JSON.stringify(direct.path)}, root, size: ${payload.length}, name: 'Frame attachment', view: 'none' }, settings)
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    const frame = frames.find(item => item.url.includes('frame-files.html'))
    const state = (await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, func: () => {
      const input = document.getElementById('frame-file')
      return { name: input.files[0]?.name, size: input.files[0]?.size, marked: input.hasAttribute('data-crazyagent-upload'), text: document.getElementById('frame-state').textContent }
    } }))[0].result
    return { upload: result.upload, state }
  })()`)
  assert.equal(framed.upload.status, 'attached')
  assert.deepEqual(framed.state, {
    name: 'crazyagent-e2e.txt', size: payload.length, marked: false, text: `attached:crazyagent-e2e.txt:${payload.length}`,
  })
  console.log('PASS exact-name upload reached an iframe input')

  // Cross-origin/OOPIF frame: discovery can inject into the frame and finds the
  // input, but the tab-level CDP DOM tree cannot see the frame's document, so
  // CDP assignment cannot work. It must fail closed with the distinct
  // UPLOAD_FRAME_UNSUPPORTED code instead of misleading UPLOAD_STALE, and must
  // not assign or leave a marker in the page.
  const cross = await evaluate(`(async () => { ${prefix}
    const crossTab = await chrome.tabs.create({ url: '${BASE}/cross-origin-files.html?run=' + Date.now(), active: true })
    const deadline = Date.now() + 10000
    let frame
    while (Date.now() < deadline) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: crossTab.id })
      frame = frames.find(item => item.frameId !== 0 && item.url === ${JSON.stringify(CROSS_ORIGIN_FRAME)})
      if (frame) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!frame) throw new Error('cross-origin frame did not load')
    await new Promise(resolve => setTimeout(resolve, 300))
    // Independent OOPIF proof: mark the input exactly like setFileInputByToken
    // does and show that the tab-level DOM.getDocument cannot see that node.
    await chrome.scripting.executeScript({ target: { tabId: crossTab.id, frameIds: [frame.frameId] }, func: () => {
      document.getElementById('frame-file').setAttribute('data-crazyagent-upload', 'oopif-probe')
    } })
    let domProbe
    try {
      await chrome.debugger.attach({ tabId: crossTab.id }, '1.3')
      const tree = await chrome.debugger.sendCommand({ tabId: crossTab.id }, 'DOM.getDocument', { depth: -1, pierce: true })
      const count = (() => {
        let total = 0
        const visit = node => {
          const attributes = Array.isArray(node?.attributes) ? node.attributes : []
          for (let index = 0; index + 1 < attributes.length; index += 2) {
            if (attributes[index] === 'data-crazyagent-upload' && attributes[index + 1] === 'oopif-probe') total += 1
          }
          for (const child of node?.children ?? []) visit(child)
          for (const shadow of node?.shadowRoots ?? []) visit(shadow)
          if (node?.contentDocument) visit(node.contentDocument)
        }
        visit(tree.root)
        return total
      })()
      domProbe = { ok: true, markedNodesVisibleToTabSession: count }
    } catch (error) {
      domProbe = { ok: false, message: error.message }
    } finally {
      await chrome.debugger.detach({ tabId: crossTab.id }).catch(() => {})
      await chrome.scripting.executeScript({ target: { tabId: crossTab.id, frameIds: [frame.frameId] }, func: () => {
        document.getElementById('frame-file').removeAttribute('data-crazyagent-upload')
      } }).catch(() => {})
    }
    let upload
    try {
      await mod.execute('upload', { filename: 'crazyagent-e2e.txt', path: ${JSON.stringify(direct.path)}, root, size: ${payload.length}, name: 'Frame attachment', view: 'none' }, settings)
      upload = { code: 'NO_ERROR' }
    } catch (error) {
      upload = { code: error.code, message: error.message, mutationPossible: error.mutationPossible }
    }
    const state = (await chrome.scripting.executeScript({ target: { tabId: crossTab.id, frameIds: [frame.frameId] }, func: () => {
      const input = document.getElementById('frame-file')
      return { files: input.files.length, marked: input.hasAttribute('data-crazyagent-upload'), text: document.getElementById('frame-state').textContent }
    } }))[0].result
    return { frameId: frame.frameId, frameUrl: frame.url, domProbe, upload, state }
  })()`)
  assert.equal(cross.domProbe.ok, true, `tab-level DOM probe failed: ${cross.domProbe.message ?? ''}`)
  assert.equal(cross.domProbe.markedNodesVisibleToTabSession, 0, 'the tab-level CDP DOM tree must not see the cross-origin frame input (OOPIF)')
  assert.equal(cross.upload.code, 'UPLOAD_FRAME_UNSUPPORTED', `cross-origin upload must fail closed with the distinct frame code: ${cross.upload.code} ${cross.upload.message ?? ''}`)
  assert.notEqual(cross.upload.code, 'UPLOAD_STALE', 'the cross-origin failure must not surface as a misleading stale view')
  assert.match(cross.upload.message, /cross-origin \(site-isolated\) iframe/)
  assert.match(cross.upload.message, /No file was assigned/)
  assert.match(cross.upload.message, /Do not retry/)
  assert.equal(cross.upload.mutationPossible, undefined, 'a refused frame assignment is not a possible mutation')
  assert.deepEqual(cross.state, { files: 0, marked: false, text: 'idle' })
  console.log(`PASS cross-origin frame ${cross.frameId} (${cross.frameUrl}) fails closed with UPLOAD_FRAME_UNSUPPORTED; tab-level CDP DOM saw ${cross.domProbe.markedNodesVisibleToTabSession} marked nodes and the page assigned nothing`)

  console.log('\nALL FILE TRANSFER CHECKS PASSED')
} finally {
  if (panel) {
    await panel.send('Runtime.evaluate', { expression: "(async () => { const mod = await import('./browser.js'); await mod.endDebuggerRun() })()", awaitPromise: true }).catch(() => {})
    panel.close()
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(parent, { recursive: true, force: true })
}
