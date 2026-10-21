#!/usr/bin/env node
/**
 * Fake side panel for headless integration checks.
 *
 * Connects as the `ui` role, answers browser commands with a local JPEG and
 * synthetic metadata, sends one prompt, and prints the conversation until the
 * turn ends. This exercises the companion, the DSH provider, image admission,
 * and the model loop without Chrome.
 *
 * Usage:
 *   node scripts/fake-ui.mjs [--image /path.jpg] [--prompt "..."] [--port 17871]
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const port = Number(arg('port', process.env.CRAZYAGENT_PORT ?? 17871))
const token = process.env.CRAZYAGENT_TOKEN ?? readFileSync(join(ROOT, '.dsh-home', 'browser-agent', 'token'), 'utf8').trim()
const imagePath = arg('image', join(homedir(), 'Downloads', '1015-600x400.jpg'))
const prompt = arg('prompt', 'Describe the current view in one short sentence. Then call browser_scroll with direction "down" once and report the new scroll position from the tool result.')
const image = readFileSync(imagePath)
const imageData = image.toString('base64')
const imageWidth = 600
const imageHeight = 400
const started = Date.now()

const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { maxPayload: 32 * 1024 * 1024 })
let prompted = false

function log(...parts) {
  process.stderr.write(`[fake-ui +${((Date.now() - started) / 1000).toFixed(1)}s] ${parts.join(' ')}\n`)
}

function snapshot() {
  return {
    op: 'snapshot',
    tab: { id: 1, title: 'Fake Test Page', url: 'https://example.test/page', windowId: 1, status: 'complete' },
    viewport: { width: 1280, height: 720, dpr: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 2400, container: 'document', pageHeight: 3120, pageWidth: 1280, atTop: true, atBottom: false },
    image: {
      data: imageData,
      mimeType: 'image/jpeg',
      width: imageWidth,
      height: imageHeight,
      bytes: image.length,
      cssPerImagePixel: 1280 / imageWidth,
    },
    captureMs: 12,
    encodeMs: 3,
    totalMs: 18,
  }
}

function scrollResult() {
  return {
    ...snapshot(),
    op: 'scroll',
    scroll: { x: 0, y: 612, maxX: 0, maxY: 2400, container: 'document', pageHeight: 3120, pageWidth: 1280, atTop: false, atBottom: false },
    moved: { dx: 0, dy: 612 },
    requestedPixels: 612,
    container: 'document',
  }
}

function tabs() {
  return {
    op: 'tabs.list',
    windowId: 1,
    tabs: [
      { id: 1, index: 0, title: 'Fake Test Page', url: 'https://example.test/page', active: true, pinned: false, audible: false, status: 'complete', discarded: false },
      { id: 2, index: 1, title: 'Second Tab', url: 'https://example.test/two', active: false, pinned: false, audible: false, status: 'complete', discarded: false },
      { id: 3, index: 2, title: 'Third Tab', url: 'https://example.test/three', active: false, pinned: false, audible: false, status: 'complete', discarded: false },
    ],
  }
}

ws.on('open', () => {
  log('connected')
  ws.send(JSON.stringify({ v: 1, type: 'hello', role: 'ui', token, version: 1 }))
})

ws.on('message', data => {
  let frame
  try {
    frame = JSON.parse(data.toString())
  } catch {
    return
  }
  if (frame.type === 'hello.ok') {
    log('paired')
    return
  }
  if (frame.type === 'chat.hello') {
    log(`companion model ${frame.provider}/${frame.model} dsh=${frame.dsh?.state}`)
    if (!prompted) {
      prompted = true
      setTimeout(() => {
        log('sending prompt')
        ws.send(JSON.stringify({ v: 1, type: 'chat.send', text: prompt, autoCapture: true }))
      }, 500)
    }
    return
  }
  if (frame.type === 'chat.status') {
    log(`status: ${frame.status}${frame.tool ? ` (${frame.tool})` : ''}`)
    return
  }
  if (frame.type === 'chat.assistant') {
    log(`assistant: ${String(frame.text).replace(/\s+/g, ' ').slice(0, 500)}`)
    return
  }
  if (frame.type === 'chat.tool_call') {
    log(`tool call: ${frame.name} ${String(frame.args).slice(0, 300)}`)
    return
  }
  if (frame.type === 'chat.tool_result') {
    log(`tool result (${frame.ok ? 'ok' : 'fail'}): ${String(frame.text).replace(/\s+/g, ' ').slice(0, 300)}`)
    return
  }
  if (frame.type === 'chat.error') {
    log(`ERROR: ${frame.message}`)
    ws.close()
    process.exit(1)
  }
  if (frame.type === 'chat.done') {
    log(`DONE session=${frame.sessionId} timings=${JSON.stringify(frame.timings)}`)
    console.log(frame.text)
    ws.close()
    setTimeout(() => process.exit(0), 200)
    return
  }
  if (frame.type === 'browser.command') {
    const op = frame.command?.op
    log(`browser command: ${op}`)
    let result
    if (op === 'snapshot') result = snapshot()
    else if (op === 'scroll') result = scrollResult()
    else if (op === 'tabs.list') result = tabs()
    else if (op === 'tabs.activate') result = snapshot()
    else {
      ws.send(JSON.stringify({ v: 1, type: 'browser.result', id: frame.id, ok: false, error: { code: 'BAD_OP', message: `unknown op ${op}` } }))
      return
    }
    ws.send(JSON.stringify({ v: 1, type: 'browser.result', id: frame.id, ok: true, result }))
    return
  }
  if (frame.type === 'pong') return
  log(`unhandled frame: ${frame.type}`)
})

ws.on('close', (code, reason) => {
  log(`closed ${code} ${reason.toString()}`)
})

ws.on('error', error => {
  log(`socket error: ${error.message}`)
})

setTimeout(() => {
  log('timeout after 180s')
  process.exit(2)
}, 180_000).unref()