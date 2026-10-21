#!/usr/bin/env node
/** Request a debug-log export from a running companion and save the bundle. */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const token = readFileSync(join(ROOT, '.dsh-home', 'browser-agent', 'token'), 'utf8').trim()
const ws = new WebSocket('ws://127.0.0.1:17871/bridge', { maxPayload: 32 * 1024 * 1024 })
const started = Date.now()
const log = (...parts) => process.stderr.write(`[log-probe +${((Date.now() - started) / 1000).toFixed(1)}s] ${parts.join(' ')}\n`)

ws.on('open', () => {
  ws.send(JSON.stringify({ v: 1, type: 'hello', role: 'ui', token, version: 1 }))
})
ws.on('message', data => {
  const frame = JSON.parse(data.toString())
  if (frame.type === 'hello.ok') {
    log('paired; requesting stats')
    ws.send(JSON.stringify({ v: 1, type: 'log.stats' }))
    return
  }
  if (frame.type === 'chat.hello') {
    log('companion hello', JSON.stringify(frame.log))
    return
  }
  if (frame.type === 'log.stats.result') {
    log('stats', JSON.stringify({
      runId: frame.stats.runId,
      events: frame.stats.events,
      screenshots: frame.stats.screenshots,
      turns: frame.stats.turns,
      warnings: frame.stats.warnings,
      errors: frame.stats.errors,
      bytes: frame.stats.bytes,
      path: frame.stats.path,
      signals: frame.stats.recentSignals.length,
    }))
    log('requesting summary')
    ws.send(JSON.stringify({ v: 1, type: 'log.summary' }))
    return
  }
  if (frame.type === 'log.summary.result') {
    log('summary chars', frame.summary.length)
    writeFileSync('/tmp/crazyagent-export-summary.md', frame.summary)
    log('requesting export')
    ws.send(JSON.stringify({ v: 1, type: 'log.export', includeScreenshots: true, includeSession: true, requestId: 'probe-1' }))
    return
  }
  if (frame.type === 'log.export.result') {
    log('export', JSON.stringify({ ok: frame.ok, filename: frame.filename, sizeBytes: frame.sizeBytes, inline: frame.inline, path: frame.path, contents: frame.contents, sessionNote: frame.sessionNote }))
    if (frame.inline && frame.base64) {
      writeFileSync('/tmp/crazyagent-export.zip', Buffer.from(frame.base64, 'base64'))
      log('wrote /tmp/crazyagent-export.zip')
    }
    ws.close()
    setTimeout(() => process.exit(frame.ok ? 0 : 1), 150)
    return
  }
  if (frame.type === 'log.error') {
    log('ERROR', frame.message)
    ws.close()
    process.exit(1)
  }
  if (frame.type === 'chat.status') return
  log('unhandled', frame.type)
})
ws.on('error', error => { log('socket error', error.message); process.exit(2) })
setTimeout(() => { log('timeout'); process.exit(3) }, 30_000).unref()
