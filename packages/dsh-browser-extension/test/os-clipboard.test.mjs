import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createOsClipboard, detectImageMime, detectOsClipboardBackend } from '../lib/os-clipboard.js'

const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
const VALID_GIF = Buffer.from('GIF89a012345', 'ascii')
const VALID_WEBP = Buffer.from('RIFF1234WEBP', 'ascii')

test('detectImageMime recognizes png, jpeg, gif, webp and rejects svg/html/short data', () => {
  assert.equal(detectImageMime(VALID_PNG), 'image/png')
  assert.equal(detectImageMime(VALID_JPEG), 'image/jpeg')
  assert.equal(detectImageMime(VALID_GIF), 'image/gif')
  assert.equal(detectImageMime(VALID_WEBP), 'image/webp')
  assert.equal(detectImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), undefined)
  assert.equal(detectImageMime(Buffer.from('hello')), undefined)
})

test('detectOsClipboardBackend selects wayland, xclip, macos, windows, or null', () => {
  assert.equal(detectOsClipboardBackend({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
    hasCommand: cmd => cmd === 'wl-copy' || cmd === 'wl-paste',
  }), 'wayland')
  assert.equal(detectOsClipboardBackend({
    platform: 'linux',
    env: { DISPLAY: ':0' },
    hasCommand: cmd => cmd === 'xclip',
  }), 'xclip')
  assert.equal(detectOsClipboardBackend({
    platform: 'linux',
    env: {},
    hasCommand: () => true,
  }), null)
  assert.equal(detectOsClipboardBackend({
    platform: 'darwin',
    env: {},
    hasCommand: cmd => cmd === 'osascript',
  }), 'macos')
  assert.equal(detectOsClipboardBackend({
    platform: 'win32',
    env: {},
    hasCommand: cmd => cmd === 'powershell.exe',
  }), 'windows')
})

function fakeSpawnChild() {
  const child = new EventEmitter()
  const written = []
  child.killed = false
  child.unreffed = false
  child.stdin = new EventEmitter()
  child.stdin.end = (data, cb) => {
    if (data !== undefined) written.push(Buffer.from(data))
    if (typeof cb === 'function') cb()
  }
  child.stderr = new EventEmitter()
  child.kill = () => { child.killed = true }
  child.unref = () => { child.unreffed = true }
  return { child, written }
}

test('wayland backend preserves, stages png with foreground holder, releases, and restores', async () => {
  const execCalls = []
  const spawnCalls = []
  const osClip = createOsClipboard({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    backend: 'wayland',
    settleMs: 5,
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args })
      if (args.includes('--list-types')) return cb(null, 'text/plain;charset=utf-8\n')
      if (args.includes('text/plain;charset=utf-8')) return cb(null, Buffer.from('prior text', 'utf8'))
      cb(null, '')
    },
    spawn: (cmd, args, opts) => {
      const fake = fakeSpawnChild()
      spawnCalls.push({ cmd, args, opts, ...fake })
      return fake.child
    },
  })

  assert.equal(osClip.isAvailable(), true)
  const saved = await osClip.preserve()
  assert.equal(saved.kind, 'bytes')
  assert.equal(saved.mimeType, 'text/plain;charset=utf-8')
  assert.equal(saved.data.toString('utf8'), 'prior text')

  const staged = await osClip.stagePng(VALID_PNG)
  assert.equal(staged.backend, 'wayland')
  assert.equal(spawnCalls[0].cmd, 'wl-copy')
  assert.deepEqual(spawnCalls[0].args, ['--foreground', '--type', 'image/png'])
  assert.deepEqual(Buffer.concat(spawnCalls[0].written), VALID_PNG)
  assert.equal(spawnCalls[0].child.unreffed, true)

  const restored = await osClip.restore(saved, staged)
  assert.equal(restored, true)
  assert.equal(spawnCalls[0].child.killed, true)
  assert.equal(spawnCalls[1].cmd, 'wl-copy')
  assert.deepEqual(spawnCalls[1].args, ['--type', 'text/plain;charset=utf-8'])
  assert.equal(spawnCalls[1].opts.detached, true)
  assert.equal(Buffer.concat(spawnCalls[1].written).toString('utf8'), 'prior text')
})

test('stagePng rejects non-PNG bytes before spawning any OS command', async () => {
  let spawned = false
  const osClip = createOsClipboard({
    platform: 'linux',
    backend: 'wayland',
    spawn: () => { spawned = true; return fakeSpawnChild().child },
  })
  await assert.rejects(() => osClip.stagePng(VALID_JPEG), /valid PNG/)
  assert.equal(spawned, false)
})

test('wayland backend surfaces early wl-copy exit as a staging error', async () => {
  const osClip = createOsClipboard({
    platform: 'linux',
    backend: 'wayland',
    settleMs: 50,
    spawn: () => {
      const fake = fakeSpawnChild()
      queueMicrotask(() => {
        fake.child.stderr.emit('data', Buffer.from('Failed to connect to compositor'))
        fake.child.emit('exit', 1, null)
      })
      return fake.child
    },
  })
  await assert.rejects(() => osClip.stagePng(VALID_PNG), /Failed to connect to compositor/)
})
