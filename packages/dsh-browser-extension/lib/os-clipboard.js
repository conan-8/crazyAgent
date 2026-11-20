/**
 * Host OS-clipboard staging for real binary image paste (e.g. Google Docs,
 * Slides, Gmail, Slack) when Chrome's side-panel Async Clipboard API is denied
 * because focus is in the web tab or the service worker is executing.
 *
 * Supported backends:
 * - Linux Wayland: wl-copy / wl-paste
 * - Linux X11:     xclip
 * - macOS:         osascript / pbpaste / pbcopy
 * - Windows:       powershell.exe (System.Windows.Forms.Clipboard)
 *
 * Preserved clipboard data stays strictly in memory on the host and is never
 * exposed to the model.
 */

import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { mkdtemp as nodeMkdtemp, rm as nodeRm, writeFile as nodeWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const OS_CLIPBOARD_MAX_BYTES = 25_000_000

/**
 * Inspect magic bytes of a downloaded image file. Only raster formats Chrome
 * can cleanly decode to PNG are accepted; SVGs and non-images return undefined.
 * @param {Buffer|Uint8Array} bytes
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|undefined}
 */
export function detectImageMime(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif'
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
}

function defaultHasCommand(name, env = process.env, platform = process.platform) {
  const pathVar = env.PATH || env.Path || ''
  const sep = platform === 'win32' ? ';' : ':'
  const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`)
      try {
        accessSync(candidate, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
        return true
      } catch {}
    }
  }
  return false
}

function runExecFile(execFileFn, cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileFn(cmd, args, options, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(typeof stderr === 'string' && stderr.trim()
          ? stderr.trim()
          : Buffer.isBuffer(stderr) && stderr.length > 0
            ? stderr.toString('utf8').trim()
            : error.message)
        err.code = error.code
        reject(err)
        return
      }
      resolve(stdout)
    })
  })
}

export function detectOsClipboardBackend(io = {}) {
  const platform = io.platform ?? process.platform
  const env = io.env ?? process.env
  const hasCommand = io.hasCommand ?? (name => defaultHasCommand(name, env, platform))
  if (platform === 'linux') {
    if (env.WAYLAND_DISPLAY && hasCommand('wl-copy') && hasCommand('wl-paste')) return 'wayland'
    if (env.DISPLAY && hasCommand('xclip')) return 'xclip'
    return null
  }
  if (platform === 'darwin') {
    return hasCommand('osascript') ? 'macos' : null
  }
  if (platform === 'win32') {
    return hasCommand('powershell.exe') || hasCommand('powershell') ? 'windows' : null
  }
  return null
}

function writeDetachedSpawn(spawnFn, cmd, args, data, env, settleMs = 150) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, {
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    })
    let settled = false
    let timer
    const done = fn => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { child.unref() } catch {}
      fn()
    }
    child.once('error', error => done(() => reject(error)))
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) done(() => resolve())
      else done(() => reject(new Error(`${cmd} exited with ${code ?? signal}`)))
    })
    child.stdin.once('error', error => done(() => reject(error)))
    child.stdin.end(data, () => {
      // wl-copy forks a daemon and exits 0 once stdin is read and the Wayland
      // selection is registered; xclip/others may stay alive, so bound the wait.
      timer = setTimeout(() => done(() => resolve()), settleMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  })
}

function stageForegroundHolder(spawnFn, cmd, args, data, env, settleMs) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, {
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let settled = false
    let timer
    let stderr = ''
    child.stderr?.on?.('data', chunk => {
      if (stderr.length < 1024) stderr += chunk.toString('utf8')
    })
    const finish = fn => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }
    child.once('error', error => finish(() => reject(error)))
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) {
        finish(() => resolve({ release: () => {} }))
      } else {
        finish(() => reject(new Error(`${cmd} exited early (${code ?? signal})${stderr.trim() ? `: ${stderr.trim()}` : ''}`)))
      }
    })
    child.stdin.once('error', error => finish(() => reject(error)))
    child.stdin.end(data, () => {
      timer = setTimeout(() => {
        try { child.stderr?.destroy?.() } catch {}
        try { child.unref() } catch {}
        finish(() => resolve({
          release: () => {
            try { child.stderr?.destroy?.() } catch {}
            try { child.kill('SIGTERM') } catch {}
          },
        }))
      }, settleMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  })
}

export function createOsClipboard(io = {}) {
  const platform = io.platform ?? process.platform
  const env = io.env ?? process.env
  const execFileFn = io.execFile ?? nodeExecFile
  const spawnFn = io.spawn ?? nodeSpawn
  const mkdtempFn = io.mkdtemp ?? nodeMkdtemp
  const writeFileFn = io.writeFile ?? nodeWriteFile
  const rmFn = io.rm ?? nodeRm
  const settleMs = Number.isFinite(Number(io.settleMs)) ? Math.max(0, Number(io.settleMs)) : 80
  const backend = io.backend !== undefined ? io.backend : detectOsClipboardBackend({ platform, env, hasCommand: io.hasCommand })

  function isAvailable() {
    return backend !== null
  }

  async function preserve() {
    if (!backend) throw new Error('No supported OS clipboard tool is available')
    if (backend === 'wayland') {
      let typesOut
      try {
        typesOut = await runExecFile(execFileFn, 'wl-paste', ['--list-types'], { env, encoding: 'utf8', timeout: 1_500 })
      } catch (error) {
        if (/nothing is copied|no selection|empty/iu.test(error?.message ?? '')) return { kind: 'empty', backend }
        throw error
      }
      const types = String(typesOut ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
      if (types.length === 0) return { kind: 'empty', backend }
      const mimeType = types.includes('image/png')
        ? 'image/png'
        : types.includes('text/plain;charset=utf-8')
          ? 'text/plain;charset=utf-8'
          : types.includes('text/plain')
            ? 'text/plain'
            : null
      if (!mimeType) return { kind: 'unsupported', backend, types: types.slice(0, 8) }
      const args = mimeType === 'image/png' ? ['--type', mimeType] : ['--no-newline', '--type', mimeType]
      const data = await runExecFile(execFileFn, 'wl-paste', args, { env, encoding: 'buffer', maxBuffer: OS_CLIPBOARD_MAX_BYTES, timeout: 2_500 })
      if (!Buffer.isBuffer(data) || data.length === 0) return { kind: 'empty', backend }
      return { kind: 'bytes', backend, mimeType, data }
    }
    if (backend === 'xclip') {
      let typesOut
      try {
        typesOut = await runExecFile(execFileFn, 'xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], { env, encoding: 'utf8', timeout: 1_500 })
      } catch {
        return { kind: 'empty', backend }
      }
      const types = String(typesOut ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
      const mimeType = types.includes('image/png')
        ? 'image/png'
        : types.includes('UTF8_STRING')
          ? 'UTF8_STRING'
          : types.includes('text/plain')
            ? 'text/plain'
            : null
      if (!mimeType) return { kind: 'empty', backend }
      const data = await runExecFile(execFileFn, 'xclip', ['-selection', 'clipboard', '-t', mimeType, '-o'], { env, encoding: 'buffer', maxBuffer: OS_CLIPBOARD_MAX_BYTES, timeout: 2_500 })
      if (!Buffer.isBuffer(data) || data.length === 0) return { kind: 'empty', backend }
      return { kind: 'bytes', backend, mimeType, data }
    }
    if (backend === 'macos') {
      const data = await runExecFile(execFileFn, 'pbpaste', [], { env, encoding: 'buffer', maxBuffer: OS_CLIPBOARD_MAX_BYTES, timeout: 2_000 })
      if (!Buffer.isBuffer(data) || data.length === 0) return { kind: 'empty', backend }
      return { kind: 'bytes', backend, mimeType: 'text/plain', data }
    }
    if (backend === 'windows') {
      const ps = defaultHasCommand('powershell.exe', env, platform) ? 'powershell.exe' : 'powershell'
      const text = await runExecFile(execFileFn, ps, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { env, encoding: 'utf8', maxBuffer: OS_CLIPBOARD_MAX_BYTES, timeout: 2_500 })
      if (!text) return { kind: 'empty', backend }
      return { kind: 'bytes', backend, mimeType: 'text/plain', data: Buffer.from(String(text), 'utf8') }
    }
    throw new Error(`Unsupported OS clipboard backend: ${backend}`)
  }

  async function stagePng(pngBuffer) {
    if (!backend) throw new Error('No supported OS clipboard tool is available')
    const buf = Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer)
    if (detectImageMime(buf) !== 'image/png') {
      throw new Error('OS clipboard staging requires valid PNG bytes')
    }
    if (backend === 'wayland') {
      const holder = await stageForegroundHolder(spawnFn, 'wl-copy', ['--foreground', '--type', 'image/png'], buf, env, settleMs)
      return { backend, release: holder.release }
    }
    if (backend === 'xclip') {
      await writeDetachedSpawn(spawnFn, 'xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i'], buf, env)
      return { backend, release: () => {} }
    }
    if (backend === 'macos') {
      const dir = await mkdtempFn(join(tmpdir(), 'crazyagent-clip-'))
      const file = join(dir, 'image.png')
      try {
        await writeFileFn(file, buf, { mode: 0o600 })
        await runExecFile(execFileFn, 'osascript', [
          '-e', 'on run argv',
          '-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)',
          '-e', 'end run',
          '--', file,
        ], { env, timeout: 3_000 })
      } finally {
        await rmFn(dir, { recursive: true, force: true }).catch(() => {})
      }
      return { backend, release: () => {} }
    }
    if (backend === 'windows') {
      const dir = await mkdtempFn(join(tmpdir(), 'crazyagent-clip-'))
      const file = join(dir, 'image.png')
      const ps = defaultHasCommand('powershell.exe', env, platform) ? 'powershell.exe' : 'powershell'
      try {
        await writeFileFn(file, buf, { mode: 0o600 })
        await runExecFile(execFileFn, ps, [
          '-NoProfile', '-NonInteractive', '-STA', '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile($env:CRAZYAGENT_CLIP_PNG); try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }',
        ], { env: { ...env, CRAZYAGENT_CLIP_PNG: file }, timeout: 5_000 })
      } finally {
        await rmFn(dir, { recursive: true, force: true }).catch(() => {})
      }
      return { backend, release: () => {} }
    }
    throw new Error(`Unsupported OS clipboard backend: ${backend}`)
  }

  async function restore(snapshot, staged) {
    try { staged?.release?.() } catch {}
    if (!backend || !snapshot || snapshot.kind === 'unsupported') return false
    if (backend === 'wayland') {
      if (snapshot.kind === 'empty') {
        await runExecFile(execFileFn, 'wl-copy', ['--clear'], { env, timeout: 1_500 })
        return true
      }
      if (snapshot.kind === 'bytes') {
        await writeDetachedSpawn(spawnFn, 'wl-copy', ['--type', snapshot.mimeType], snapshot.data, env)
        return true
      }
      return false
    }
    if (backend === 'xclip') {
      if (snapshot.kind === 'empty') {
        await writeDetachedSpawn(spawnFn, 'xclip', ['-selection', 'clipboard', '-i'], Buffer.alloc(0), env)
        return true
      }
      if (snapshot.kind === 'bytes') {
        await writeDetachedSpawn(spawnFn, 'xclip', ['-selection', 'clipboard', '-t', snapshot.mimeType, '-i'], snapshot.data, env)
        return true
      }
      return false
    }
    if (backend === 'macos') {
      await writeDetachedSpawn(spawnFn, 'pbcopy', [], snapshot.kind === 'bytes' ? snapshot.data : Buffer.alloc(0), env)
      return true
    }
    if (backend === 'windows') {
      const ps = defaultHasCommand('powershell.exe', env, platform) ? 'powershell.exe' : 'powershell'
      const cmd = snapshot.kind === 'bytes'
        ? 'Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:CRAZYAGENT_CLIP_RESTORE)))'
        : 'Set-Clipboard -Value $null'
      const restoreEnv = snapshot.kind === 'bytes'
        ? { ...env, CRAZYAGENT_CLIP_RESTORE: snapshot.data.toString('base64') }
        : env
      await runExecFile(execFileFn, ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { env: restoreEnv, timeout: 3_000 })
      return true
    }
    return false
  }

  return {
    backend,
    isAvailable,
    preserve,
    stagePng,
    restore,
  }
}
