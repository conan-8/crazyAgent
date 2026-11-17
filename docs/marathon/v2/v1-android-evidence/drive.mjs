// V1-android lifecycle check against the REAL fake companion (real
// RemoteServer + RemoteHub + SessionController + watcher). Observes GET /state
// and the /events stream at each turn boundary. --expect-v1 asserts the fixed
// lifecycle; without it, records the pre-V1 baseline (G5 stale alerts).
// Usage: node drive.mjs [--expect-v1] [--out path] [--fake path-to-fake-script]
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
// Repo root relative to this evidence script (docs/marathon/v2/v1-android-evidence/).
const root = new URL('../../../..', import.meta.url).pathname
const fakePath = process.argv.includes('--fake') ? process.argv[process.argv.indexOf('--fake') + 1] : root + 'scripts/fake-remote-companion.mjs'
const { startFakeCompanion } = await import(pathToFileURL(fakePath).href)
const WebSocket = (await import(pathToFileURL(root + 'node_modules/ws/wrapper.mjs').href)).default

const expectV1 = process.argv.includes('--expect-v1')
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : root + 'docs/marathon/v2/v1-android-evidence/lifecycle-transcript.json'
const fake = await startFakeCompanion({ port: 0, tokenFile: root + '.dsh-home/v1-android-demo/fake-token' })
const base = `${fake.url}/remote/v1`
const headers = { authorization: `Bearer ${fake.token}`, 'content-type': 'application/json' }
const get = async path => (await fetch(`${base}${path}`, { headers })).json()
const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const frames = []
const ws = new WebSocket(`ws://127.0.0.1:${fake.server.port}/remote/v1/events`, { headers: { authorization: `Bearer ${fake.token}` } })
ws.on('message', data => frames.push(JSON.parse(data.toString())))
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (pred, what, ms = 45_000, from = 0) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const f = frames.slice(from).find(pred)
    if (f) return f
    await sleep(100)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const watchFrames = () => frames.filter(f => f.type === 'remote.watch').map(f => ({ seq: f.seq, id: f.body.id, kind: f.body.kind, state: f.body.state, reason: f.body.reason }))
const steps = {}
const results = []
const check = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const note = (name, value) => { steps[name] = value; console.log(`BASELINE ${name}:`, typeof value === 'string' ? value : JSON.stringify(value)) }
try {
  // A: mid-turn alert still open at a user stop -> closed at turn end.
  await post('/marathon', { enabled: true, clientCommandId: 'demo-on-a1' })
  steps.sendA = await post('/messages', { text: 'marathon-stuck lifecycle A', clientMessageId: 'demo-msg-a' })
  steps.alertA = await waitFor(f => f.type === 'remote.watch' && f.body.kind === 'TOOL_HANG' && f.body.state === 'open', 'alert A')
  steps.stateAtAlertA = await get('/state')
  steps.stopA = await post('/stop', { clientCommandId: 'demo-stop-a1' })
  await waitFor(f => f.type === 'chat.stopped', 'stopped A')
  await sleep(700)
  steps.stateAfterStopA = await get('/state')
  if (expectV1) {
    const closedA = frames.find(f => f.type === 'remote.watch' && f.body.state === 'closed' && f.body.id === steps.alertA.body.id)
    check('A: close frame for the open alert at turn end', closedA && closedA.body.reason === 'Turn ended.', JSON.stringify(closedA?.body ?? null))
    check('A: /state open alert cleared after stop', steps.stateAfterStopA.marathon.watch.open === null, JSON.stringify(steps.stateAfterStopA.marathon.watch.open))
  } else {
    note('A open after stop', steps.stateAfterStopA.marathon.watch.open)
    note('A closed frames', watchFrames().filter(f => f.state === 'closed').length)
  }

  // B: ended-incomplete left OPEN -> closed at the next turn start.
  await post('/new', { clientCommandId: 'demo-new-b1' })
  await post('/marathon', { enabled: true, clientCommandId: 'demo-on-b1' })
  steps.sendB = await post('/messages', { text: 'marathon-stuck lifecycle B', clientMessageId: 'demo-msg-b' })
  const markB = frames.length
  steps.endedB = await waitFor(f => f.type === 'remote.watch' && f.body.kind === 'ended-incomplete' && f.body.state === 'open', 'ended-incomplete B', 45_000, markB)
  steps.stateAtEndedB = await get('/state')
  steps.sendC = await post('/messages', { text: 'continue the work', clientMessageId: 'demo-msg-c' })
  steps.userC = await waitFor(f => f.type === 'chat.user' && f.body.clientMessageId === 'demo-msg-c', 'turn C user frame')
  await sleep(700)
  steps.stateDuringC = await get('/state')
  if (expectV1) {
    const closedC = frames.find(f => f.type === 'remote.watch' && f.body.state === 'closed' && f.body.id === steps.endedB.body.id && f.body.reason === 'A new turn started.')
    check('B: ended-incomplete closed at next turn start', !!closedC, JSON.stringify(closedC?.body ?? null))
    check('B: close frame precedes the new turn first frame', closedC && closedC.seq < steps.userC.seq, `closed seq ${closedC?.seq} vs user seq ${steps.userC.seq}`)
    check('B: no open alert during the new turn (amber never carries)', steps.stateDuringC.marathon.watch.open === null, JSON.stringify(steps.stateDuringC.marathon.watch.open))
  } else {
    note('B open during next turn', steps.stateDuringC.marathon.watch.open)
    note('B closed frames', watchFrames().filter(f => f.state === 'closed').length)
  }
  await waitFor(f => f.type === 'chat.done' && f.turnId === steps.userC.turnId, 'turn C done', 60_000)

  // C: ended-incomplete -> "It's fine" ack returns 200 and dismisses it.
  await post('/new', { clientCommandId: 'demo-new-c1' })
  await post('/marathon', { enabled: true, clientCommandId: 'demo-on-c1' })
  steps.sendD = await post('/messages', { text: 'marathon-stuck lifecycle C', clientMessageId: 'demo-msg-d' })
  const markC = frames.length
  steps.endedD = await waitFor(f => f.type === 'remote.watch' && f.body.kind === 'ended-incomplete' && f.body.state === 'open', 'ended-incomplete C', 45_000, markC)
  steps.stateAtEndedD = await get('/state')
  steps.ackC = await post('/marathon/watch/ack', { id: steps.endedD.body.id, clientCommandId: 'demo-ack-c1' })
  await sleep(700)
  steps.stateAfterAckC = await get('/state')
  if (expectV1) {
    check('C: ack on ended-incomplete returns 200', steps.ackC.status === 200 && steps.ackC.body.acknowledged === true, `status ${steps.ackC.status}`)
    const dismissed = frames.find(f => f.type === 'remote.watch' && f.body.id === steps.endedD.body.id && f.body.state === 'dismissed')
    check('C: dismissed frame arrives on the stream', !!dismissed, JSON.stringify(dismissed?.body ?? null))
    check('C: /state open cleared after ack', steps.stateAfterAckC.marathon.watch.open === null, JSON.stringify(steps.stateAfterAckC.marathon.watch.open))
  } else {
    note('C ack status', `${steps.ackC.status} ${steps.ackC.body?.error?.code ?? ''}`)
    note('C open after ack', steps.stateAfterAckC.marathon.watch.open)
  }
  steps.watchFrames = watchFrames()
  steps.watchPushes = fake.watchPushes
  writeFileSync(out, JSON.stringify({ expectV1, steps, results, frames }, null, 2))
  if (expectV1) {
    const failed = results.filter(r => !r.pass)
    console.log(failed.length === 0 ? 'ALL V1 LIFECYCLE CHECKS PASS' : `${failed.length} CHECKS FAILED`)
    process.exitCode = failed.length === 0 ? 0 : 1
  } else {
    console.log('BASELINE RECORDED')
  }
} finally {
  ws.close()
  await fake.stop()
}
