import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { LogStore } from '../log-store.mjs'

const SECRET = 'secret-token-value'
const IMAGE_BYTES = Buffer.from('fake-jpeg-bytes-for-log-test')
const IMAGE_B64 = IMAGE_BYTES.toString('base64')

async function makeStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'crazyagent-log-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshHome = join(root, '.dsh-home')
  const sessionId = 'session-test'
  const sessionDir = join(dshHome, 'sessions', '--project--', sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl'), '{"type":"session"}\n{"type":"assistant/message"}\n')
  const store = new LogStore({
    root: join(root, 'logs'),
    runId: 'run-test',
    secret: SECRET,
    meta: {
      provider: 'test-provider',
      model: 'test-model',
      dshHome,
      bridgeUrl: 'ws://127.0.0.1:1/bridge',
      companionVersion: '0.1.0',
      patchFile: '/tmp/browser.patch.yml',
    },
  })
  await store.init()
  return { store, root, sessionId, sessionDir }
}

test('records, redacts, saves screenshots, and exports a bundle', async t => {
  const { store, sessionId } = await makeStore(t)
  store.sessionStart(sessionId)
  store.updateContext({ extensionVersion: '0.1.0', userAgent: 'test-agent', settings: { tokenLength: 18 } })
  store.turnStart('turn-1', 'What is on this page?', { autoCapture: true, provider: 'test-provider', model: 'test-model' })

  store.recordBridge({
    direction: 'in',
    role: 'ui',
    frame: {
      v: 1,
      type: 'log.event',
      event: {
        source: 'extension',
        type: 'settings.save',
        severity: 'info',
        time: Date.now(),
        data: { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: SECRET, tokenLength: 18, apiKey: 'sk-or-v1-test-secret', note: `token ${SECRET}` },
      },
    },
  })

  store.recordBridge({
    direction: 'out',
    role: 'ui',
    frame: {
      v: 1,
      type: 'browser.command',
      id: 'cmd-1',
      callId: 'call-1',
      turnId: 'turn-1',
      command: { op: 'snapshot', args: { detail: 'normal' } },
    },
  })
  store.recordBridge({
    direction: 'in',
    role: 'ui',
    frame: {
      v: 1,
      type: 'browser.result',
      id: 'cmd-1',
      callId: 'call-1',
      turnId: 'turn-1',
      ok: true,
      result: {
        op: 'snapshot',
        tab: { id: 1, title: 'Test page', url: 'https://example.com/report?token=hidden&x=1' },
        viewport: { width: 100, height: 100, dpr: 1 },
        scroll: { y: 0, maxY: 200, container: 'document' },
        image: { data: IMAGE_B64, mimeType: 'image/jpeg', width: 10, height: 10, bytes: IMAGE_BYTES.length, cssPerImagePixel: 10 },
        captureMs: 12,
        encodeMs: 3,
        totalMs: 20,
      },
    },
  })

  store.assistant('turn-1', 'The page says ALPHA-MARKER.')
  store.toolCall('turn-1', { callId: 'call-1', name: 'browser_screenshot', args: { detail: 'normal' } })
  store.toolResult('turn-1', { callId: 'call-1', ok: true, text: 'tab 1 Test page', durationMs: 25 })
  store.turnEnd('turn-1', {
    ok: true,
    finalText: 'The page says ALPHA-MARKER.',
    timings: { totalMs: 1234, autoCaptureMs: 20, firstEventMs: 50, toolCalls: 1 },
    usage: { inputTokens: 100, outputTokens: 10 },
  })
  await store.flush()

  const events = await readFile(store.eventsPath, 'utf8')
  assert.ok(!events.includes(SECRET), 'pairing token must not be in events.jsonl')
  assert.ok(!events.includes('sk-or-v1-test-secret'), 'OpenRouter key must not be in events.jsonl')
  assert.ok(!events.includes(IMAGE_B64), 'inline image base64 must not be in events.jsonl')
  assert.ok(events.includes('[redacted]'))
  assert.ok(events.includes('ALPHA-MARKER'))
  assert.ok(events.includes('inline-image-data') === false, 'browser result image was replaced before generic sanitize')

  assert.equal(store.screenshotFiles.length, 1)
  const screenshotPath = join(store.screenshotsDir, store.screenshotFiles[0].name)
  assert.ok(existsSync(screenshotPath))
  assert.deepEqual(await readFile(screenshotPath), IMAGE_BYTES)

  const summary = store.summary()
  assert.match(summary, /What is on this page\?/)
  assert.match(summary, /ALPHA-MARKER/)
  assert.match(summary, /screenshots\//)
  assert.match(summary, /browser_screenshot/)
  assert.match(summary, /Test page/)

  const stats = store.stats()
  assert.ok(stats.events >= 8)
  assert.equal(stats.screenshots, 1)
  assert.equal(stats.turns, 1)

  const exported = await store.exportBundle({ includeScreenshots: true, includeSession: true })
  assert.equal(exported.ok, true)
  assert.equal(exported.inline, true)
  assert.ok(exported.base64.length > 0)
  const files = unzipSync(Buffer.from(exported.base64, 'base64'))
  assert.ok(files['summary.md'])
  assert.ok(files['events.jsonl'])
  assert.ok(files['summary.json'])
  assert.ok(files['environment.json'])
  assert.ok(files['manifest.json'])
  assert.ok(files['dsh-session.jsonl'])
  assert.ok(Object.keys(files).some(name => name.startsWith('screenshots/')))

  const exportedSummary = strFromU8(files['summary.md'])
  assert.match(exportedSummary, /ALPHA-MARKER/)
  const exportedManifest = JSON.parse(strFromU8(files['manifest.json']))
  assert.equal(exportedManifest.runId, 'run-test')
  assert.equal(exportedManifest.stats.screenshots, 1)
  assert.ok(!JSON.stringify(exportedManifest).includes(SECRET))
  assert.ok(!strFromU8(files['events.jsonl']).includes(SECRET))

  await store.close()
  const finalEvents = await readFile(store.eventsPath, 'utf8')
  assert.ok(finalEvents.includes('run.stop'))
})

test('a user-aborted turn records TURN_STOPPED, not TURN_FAILED', async t => {
  const { store, sessionId } = await makeStore(t)
  store.sessionStart(sessionId)
  store.turnStart('turn-3', 'stop me', {})
  store.turnEnd('turn-3', { ok: false, aborted: true, reason: 'user', timings: { totalMs: 42 } })
  await store.flush()
  const events = await readFile(store.eventsPath, 'utf8')
  assert.ok(events.includes('TURN_STOPPED'), 'aborted turn should emit TURN_STOPPED')
  assert.ok(!events.includes('TURN_FAILED'), 'aborted turn must not be reported as a failure')
  const summary = store.summary()
  assert.match(summary, /stopped by user/i)
  await store.close()
})

test('omits screenshots and the DSH session when asked', async t => {
  const { store, sessionId } = await makeStore(t)
  store.sessionStart(sessionId)
  store.turnStart('turn-2', 'hello', {})
  store.recordBridge({
    direction: 'in',
    role: 'ui',
    frame: {
      v: 1,
      type: 'browser.result',
      id: 'cmd-2',
      turnId: 'turn-2',
      ok: false,
      error: { code: 'PROTECTED_PAGE', message: 'Chrome blocks screenshots here' },
    },
  })
  store.turnEnd('turn-2', { ok: false, error: 'no capture', timings: { totalMs: 20 } })
  await store.flush()
  const exported = await store.exportBundle({ includeScreenshots: false, includeSession: false })
  const files = unzipSync(Buffer.from(exported.base64, 'base64'))
  assert.ok(!Object.keys(files).some(name => name.startsWith('screenshots/')))
  assert.ok(!Object.keys(files).some(name => name.startsWith('dsh-session')))
  const manifest = JSON.parse(strFromU8(files['manifest.json']))
  assert.equal(manifest.includeScreenshots, false)
  assert.equal(manifest.includeSession, false)
  const summary = strFromU8(files['summary.md'])
  assert.match(summary, /PROTECTED_PAGE|no capture|TURN_FAILED/)
})
