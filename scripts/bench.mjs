#!/usr/bin/env node
/**
 * Measure local bridge round-trip overhead without Chrome or the model.
 * This isolates the companion WebSocket path from capture and inference time.
 */

import WebSocket from 'ws'
import { performance } from 'node:perf_hooks'
import { Bridge } from '../companion/bridge.mjs'

const token = 'bench-token'
const bridge = new Bridge({
  host: '127.0.0.1',
  port: 0,
  token,
  log: () => {},
  onChat: () => {},
  onNewChat: () => {},
})
await bridge.start()
const url = `ws://127.0.0.1:${bridge.port}/bridge`

function open(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => {
      ws.send(JSON.stringify({ v: 1, type: 'hello', role, token, version: 1 }))
      ws.once('message', data => {
        const message = JSON.parse(data.toString())
        if (message.type !== 'hello.ok') reject(new Error(`unexpected hello: ${message.type}`))
        else resolve(ws)
      })
    })
    ws.once('error', reject)
  })
}

const ui = await open('ui')
const tools = await open('tools')

ui.on('message', data => {
  const message = JSON.parse(data.toString())
  if (message.type !== 'browser.command') return
  ui.send(JSON.stringify({
    v: 1,
    type: 'browser.result',
    id: message.id,
    ok: true,
    result: { op: 'snapshot', tab: { id: 1 }, scroll: { y: 0 }, image: { data: 'AAAA', mimeType: 'image/jpeg' } },
  }))
})

const samples = []
const pending = new Map()
tools.on('message', data => {
  const message = JSON.parse(data.toString())
  if (message.type === 'browser.result') {
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve()
    }
  }
})

for (let i = 0; i < 200; i += 1) {
  const id = `bench-${i}`
  const started = performance.now()
  const done = new Promise(resolve => pending.set(id, resolve))
  tools.send(JSON.stringify({
    v: 1,
    type: 'browser.command',
    id,
    callId: `call-${i}`,
    command: { op: 'snapshot', args: { detail: 'normal' } },
  }))
  await done
  samples.push(performance.now() - started)
}

samples.sort((a, b) => a - b)
const percentile = p => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))]
const result = {
  samples: samples.length,
  p50Ms: Number(percentile(50).toFixed(2)),
  p95Ms: Number(percentile(95).toFixed(2)),
  p99Ms: Number(percentile(99).toFixed(2)),
  minMs: Number(samples[0].toFixed(2)),
  maxMs: Number(samples[samples.length - 1].toFixed(2)),
}
console.log(JSON.stringify(result, null, 2))

ui.close()
tools.close()
await bridge.stop()