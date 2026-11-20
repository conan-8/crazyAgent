import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])
const VALID_PNG_B64 = VALID_PNG.toString('base64')

async function startFixture(t, { respond, downloadsDir, osClipboard }) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => wss.once('listening', resolve))
  const { port } = wss.address()
  const commands = []
  wss.on('connection', ws => {
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString('utf8'))
      if (frame.type === 'hello') {
        ws.send(JSON.stringify({ v: 1, type: 'hello.ok', version: 1 }))
        return
      }
      if (frame.type === 'browser.command') {
        const op = frame.command?.op
        const args = frame.command?.args ?? {}
        commands.push({ op, args })
        const result = respond(op, args)
        ws.send(JSON.stringify({ v: 1, type: 'browser.result', id: frame.id, ok: true, result }))
      }
    })
  })
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger: { info: () => {} },
    browserUse: { register: () => () => {} },
    tools: {
      register: def => {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    systemPrompt: {
      getSectionOrder: () => 3000,
      section: () => () => {},
    },
    on: () => () => {},
    effect: fn => {
      const gen = fn()
      let step = gen.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = gen.next()
      }
      return () => {
        for (const d of disposers.splice(0).reverse()) d()
      }
    },
  }
  apply(ctx, {
    bridgeUrl: `ws://127.0.0.1:${port}/bridge`,
    downloadsDir,
    osClipboard,
  })
  t.after(async () => {
    for (const d of disposers.splice(0).reverse()) d()
    for (const ws of wss.clients) ws.terminate()
    await new Promise(resolve => wss.close(resolve))
  })
  return { tools, commands }
}

test('browser_clipboard copies Downloads images inside boundary and rejects non-images', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crazyagent-dl-clip-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'fjord.png'), VALID_PNG)
  await writeFile(join(dir, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

  const fx = await startFixture(t, {
    downloadsDir: dir,
    osClipboard: { isAvailable: () => false },
    respond: (_op, args) => ({
      op: 'clipboard',
      action: 'copy',
      clipboard: {
        target: 'virtual', system: false, kind: 'image', chars: 0,
        source: 'download', filename: args.filename, mimeType: 'image/png', width: 640, height: 400, bytes: VALID_PNG.length,
      },
    }),
  })
  const tool = fx.tools.get('browser_clipboard')
  const exec = { callId: 'c-dl', signal: new AbortController().signal }

  const copied = await tool.execute({ action: 'copy', source: 'download', filename: 'fjord.png' }, exec)
  assert.match(copied.content[0].text, /copied a 640x400 image\/png from Downloads file "fjord\.png" to the virtual clipboard/)
  assert.equal(fx.commands[0].args.source, 'download')
  assert.equal(fx.commands[0].args.mimeType, 'image/png')
  assert.equal(fx.commands[0].args.data, VALID_PNG_B64)

  await assert.rejects(
    () => tool.execute({ action: 'copy', source: 'download', filename: 'vector.svg' }, exec),
    /not a supported raster image/,
  )
  await assert.rejects(
    () => tool.execute({ action: 'copy', source: 'download', filename: '../etc/passwd' }, exec),
    /Downloads|traversal|relative/i,
  )
})

test('browser_clipboard image paste uses host OS clipboard staging when side panel is unfocused', async t => {
  const events = []
  const osClipboard = {
    isAvailable: () => true,
    preserve: async () => { events.push('preserve'); return { kind: 'bytes', mimeType: 'text/plain', data: Buffer.from('user-clip') } },
    stagePng: async buf => {
      events.push(`stage:${buf.length}`)
      return { backend: 'wayland', release: () => events.push('release') }
    },
    restore: async (snap, staged) => {
      staged.release()
      events.push(`restore:${snap.data.toString('utf8')}`)
      return true
    },
  }
  const fx = await startFixture(t, {
    osClipboard,
    respond: (_op, args) => {
      if (args.action === 'copy' && args.source === 'image') {
        return {
          op: 'clipboard', action: 'copy',
          clipboard: { target: 'virtual', system: false, kind: 'image', chars: 0, source: 'image', label: 12, mimeType: 'image/png', width: 800, height: 500, bytes: VALID_PNG.length },
        }
      }
      if (args.action === 'paste' && args.target === 'virtual' && args.osStage === true) {
        return {
          op: 'clipboard', action: 'paste', osStageNeeded: true,
          clipboard: { target: 'virtual', system: false, kind: 'image', chars: 0, rich: true, source: 'image', mimeType: 'image/png', width: 800, height: 500, bytes: VALID_PNG.length },
          image: { data: VALID_PNG_B64, mimeType: 'image/png', width: 800, height: 500, bytes: VALID_PNG.length },
        }
      }
      if (args.action === 'paste' && args.target === 'system' && args.rich === true) {
        events.push('trusted-ctrl-v')
        return {
          op: 'clipboard', action: 'paste', view: 'compact',
          tab: { id: 1, title: 'Feature Test Document - Google Docs', url: 'https://docs.google.com/document/d/abc/edit' },
          viewport: { width: 1162, height: 770 },
          scroll: { container: 'document', y: 0, maxY: 0, atTop: true, atBottom: true },
          pressed: { key: 'v', modifiers: ['ctrl'], trusted: true },
          pasted: { chars: null, mode: 'keys', via: 'keys', trusted: true, rich: true },
        }
      }
      throw new Error(`unexpected clipboard args: ${JSON.stringify(args)}`)
    },
  })
  const tool = fx.tools.get('browser_clipboard')
  const exec = { callId: 'c-os', signal: new AbortController().signal }

  const copied = await tool.execute({ action: 'copy', source: 'image', label: 12 }, exec)
  assert.match(copied.content[0].text, /copied a 800x500 image\/png from image label 12/)

  const pasted = await tool.execute({ action: 'paste', view: 'compact' }, exec)
  assert.match(pasted.content[0].text, /pasted the 800x500 image from the virtual clipboard into the focused element via one trusted Ctrl\+V/)
  assert.match(pasted.content[0].text, /previous system clipboard was restored/)
  assert.deepEqual(events, ['preserve', `stage:${VALID_PNG.length}`, 'trusted-ctrl-v', 'release', 'restore:user-clip'])
})
