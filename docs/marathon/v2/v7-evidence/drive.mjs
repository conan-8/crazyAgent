// V7 gate: POST /push/test against the REAL fake companion (real RemoteServer
// + RemoteHub + SessionController; no FCM key -> explicit not-configured).
// Independent surface: HTTP responses only. Isolated port 0 + own token.
import { pathToFileURL } from 'node:url'
// Repo root relative to this evidence script (docs/marathon/v2/v7-evidence/).
const root = new URL('../../../..', import.meta.url).pathname
const { startFakeCompanion } = await import(pathToFileURL(root + 'scripts/fake-remote-companion.mjs').href)
import { writeFileSync } from 'node:fs'
const fake = await startFakeCompanion({ port: 0, tokenFile: root + '.dsh-home/v7-demo/fake-token' })
const base = `${fake.url}/remote/v1`
const headers = { authorization: `Bearer ${fake.token}`, 'content-type': 'application/json' }
const post = async (path, body, auth = true) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: auth ? headers : { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const results = []
const check = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const steps = {}
try {
  steps.unauth = await post('/push/test', { clientCommandId: 'cmd-test-0001' }, false)
  check('unauthenticated refused', steps.unauth.status === 401, `status ${steps.unauth.status}`)
  steps.badId = await post('/push/test', { clientCommandId: 'short' })
  check('bad client id refused', steps.badId.status === 422 && steps.badId.body.error.code === 'INVALID_CLIENT_ID', `status ${steps.badId.status}`)
  steps.first = await post('/push/test', { clientCommandId: 'cmd-test-0001' })
  check('no FCM key -> explicit not-configured 200', steps.first.status === 200 && steps.first.body.skipped === 'not-configured', JSON.stringify(steps.first.body))
  check('answer shape {sent,failed,pruned,skipped}', [0, 0, 0].every((n, i) => steps.first.body[['sent', 'failed', 'pruned'][i]] === n), JSON.stringify(steps.first.body))
  steps.replay = await post('/push/test', { clientCommandId: 'cmd-test-0001' })
  check('idempotent replay cached', steps.replay.status === 200 && steps.replay.body.replayed === true && steps.replay.body.skipped === 'not-configured', JSON.stringify(steps.replay.body))
  steps.second = await post('/push/test', { clientCommandId: 'cmd-test-0002' })
  check('second distinct id within the minute -> 429', steps.second.status === 429 && steps.second.body.error.code === 'RATE_LIMITED', `status ${steps.second.status}`)
  steps.wrongMethod = await fetch(`${base}/push/test`, { headers })
  check('GET refused', steps.wrongMethod.status === 405, `status ${steps.wrongMethod.status}`)
  writeFileSync(root + 'docs/marathon/v2/v7-evidence/fake-companion-push-test.json', JSON.stringify({ steps, results }, null, 2))
  const failed = results.filter(r => !r.pass)
  console.log(failed.length === 0 ? 'ALL V7 ROUTE CHECKS PASS' : `${failed.length} CHECKS FAILED`)
  process.exitCode = failed.length === 0 ? 0 : 1
} finally {
  await fake.stop()
}
