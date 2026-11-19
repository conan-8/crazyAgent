#!/usr/bin/env node
/**
 * One command for the real-extension regression gates (retired work plan Q5, archived in docs/HISTORY.md).
 *
 * Starts a fixture server (e2e/fixtures, with a request log) and ONE isolated
 * headless Edge with the unpacked extension, then runs every edge-*-e2e suite
 * that can run without a visible window or the running service, prints one
 * table, and cleans up only the PIDs it started.
 *
 *   node scripts/run-e2e-gates.mjs                 # all headless-capable suites
 *   node scripts/run-e2e-gates.mjs --only find --only work
 *   node scripts/run-e2e-gates.mjs --headed        # debugging: visible window
 *   node scripts/run-e2e-gates.mjs --json out.json
 *
 * Two suite classes:
 *   - attach: the suite drives the runner's Edge through CDP_URL and reads
 *     fixtures through FIXTURE_URL. It opens the side panel itself as a tab.
 *     Run sequentially: one executor at a time.
 *   - self: the suite spawns its OWN Edge, fixture server, and bridge. The
 *     runner only assigns a free CDP_PORT (and HEADLESS=1 where the suite
 *     opts in) and backstops cleanup through that port if the suite dies.
 *
 * Port and profile safety (AGENTS.md):
 *   - the fixture server prefers 17872 (some suites hardcode it) but NEVER
 *     takes it when another server already holds it; those suites are then
 *     skipped and listed with the reason.
 *   - the runner's Edge CDP port is a free port, never 9233, and its profile
 *     is a throwaway mkdtemp under /tmp — never ~/.cache/crazyagent/docs-profile
 *     (docs-fixer owns both) and never the user's normal profile.
 *   - only PIDs/PGIDs this process started are stopped; no pkill by path.
 *   - the running service (17871/17873) is never touched: suites that point
 *     the extension at the service bridge (tabs, log) are excluded.
 *
 * CI note: no GitHub Actions job is added. microsoft-edge is not preinstalled
 * on GitHub-hosted runners and verifying an install path would require a
 * push; this script is CI-ready (exit code + --json) if that is done later.
 *
 * A direct-executor gate: it does not evaluate model decisions.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp, listTargets, startEdge } from './model-eval.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES_DIR = join(ROOT, 'e2e', 'fixtures')
const PREFERRED_FIXTURE_PORT = 17872
const FORBIDDEN_CDP_PORTS = new Set([9233]) // docs-fixer's exclusive port
const DOCS_PROFILE = resolve(process.env.HOME ?? '', '.cache', 'crazyagent', 'docs-profile')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const nowIso = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// Suite registry
// ---------------------------------------------------------------------------

/**
 * class: 'attach' (runner's Edge) | 'self' (own Edge) | 'excluded'.
 * fixedFixturePort: the suite hardcodes this fixture port in places, so it
 *   can only run when the runner's fixture server holds exactly that port.
 * experimental: run, but a failure does not fail the gate; it moves the suite
 *   to the cannot-run-headless list with the observed reason.
 */
const SUITES = [
  { name: 'find', script: 'edge-find-e2e.mjs', class: 'attach', timeoutS: 180, note: 'RESOLVED 2026-11-16: window-size dependent, not a race — headless default 800x600 gives a 516px viewport and the labelled control sits at top 520 (below the fold; viewport-scoped labelling skips it by design). Suite now pins a 1280x900 page viewport via CDP Emulation; green at 800x600/1280x720/1280x900. Evidence: e2e/baselines/2026-11-16T09-40-02-000Z-q5-find-label-diagnosis.json' },
  { name: 'expect', script: 'edge-expect-e2e.mjs', class: 'attach', timeoutS: 180 },
  { name: 'table', script: 'edge-table-e2e.mjs', class: 'attach', timeoutS: 180 },
  { name: 'work', script: 'edge-work-e2e.mjs', class: 'attach', timeoutS: 240 },
  { name: 'chat', script: 'edge-chat-e2e.mjs', class: 'attach', timeoutS: 180 },
  { name: 'dialog', script: 'edge-dialog-e2e.mjs', class: 'attach', timeoutS: 180 },
  { name: 'files', script: 'edge-files-e2e.mjs', class: 'attach', timeoutS: 240 },
  { name: 'canvas', script: 'edge-canvas-e2e.mjs', class: 'attach', timeoutS: 240, fixedFixturePort: 17872, needsTab: 'canvas.html' },
  { name: 'advanced', script: 'edge-advanced-e2e.mjs', class: 'attach', timeoutS: 180, fixedFixturePort: 17872, needsTab: 'advanced.html' },
  { name: 'clipboard', script: 'edge-clipboard-e2e.mjs', class: 'attach', timeoutS: 240, experimental: true, note: 'system-clipboard paths need a real panel; suite SKIPs them when unavailable' },
  { name: 'background', script: 'edge-background-e2e.mjs', class: 'self', mode: 'headless', timeoutS: 180 },
  { name: 'drag', script: 'edge-drag-e2e.mjs', class: 'self', mode: 'headless', timeoutS: 300, env: { HEADLESS: '1' } },
  { name: 'cursor', script: 'edge-cursor-e2e.mjs', class: 'self', mode: 'headless', timeoutS: 180 },
]

const EXCLUDED = [
  { name: 'click', mode: 'headed', reason: 'stalls in its own setup without a visible window (2026-11-11 log); also hardcodes fixture port 17872' },
  { name: 'capture', mode: 'headed', reason: 'headed by design (minimizes a real OS window); on an idle/locked desktop the window never gains focus and its baseline assertion fails: image 2336x1282 != viewport 1168x688 x dpr 2 (debugger-infobar viewport accounting needs a painted, focused window). Bridge config is env-isolated (BRIDGE_URL/BRIDGE_TOKEN); rerun headed on an active desktop' },
  { name: 'tabs', mode: 'n/a', reason: 'points the extension at the RUNNING service bridge (ws://127.0.0.1:17871) with the service token; cannot run isolated without touching the service' },
  { name: 'log', mode: 'n/a', reason: 'same as tabs: drives the running service bridge with the service token' },
  { name: 'docs-table', mode: 'n/a', reason: 'live Google Docs: needs the signed-in profile ~/.cache/crazyagent/docs-profile on port 9233 (docs-fixer owns both)' },
  { name: 'find-live', mode: 'n/a', reason: 'live Google Docs: needs the signed-in profile and the service bridge port' },
  { name: 'table-live', mode: 'n/a', reason: 'live Google Docs: needs the signed-in profile' },
]

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

async function freePort() {
  for (;;) {
    const server = createNetServer()
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const { port } = server.address()
    await new Promise(resolveClose => server.close(resolveClose))
    if (!FORBIDDEN_CDP_PORTS.has(port)) return port
  }
}

/** True when nothing is listening on the port (bind test, then release). */
async function portFree(port) {
  const server = createNetServer()
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(port, '127.0.0.1', resolveListen)
    })
    return true
  } catch {
    return false
  } finally {
    await new Promise(resolveClose => server.close(resolveClose))
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

/**
 * Fixture server with a request log (method, path, time, body length — no
 * bodies: fixture content is synthetic and the suites check page state).
 * Prefers 17872 because canvas/advanced hardcode it; never takes a held port.
 */
async function startFixtureServer() {
  const requests = []
  const handle = (request, response) => {
    const chunks = []
    request.on('data', chunk => {
      chunks.push(chunk)
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 16 * 1024 * 1024) request.destroy()
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks)
      let pathname
      try {
        pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      } catch {
        response.writeHead(400).end('bad path')
        return
      }
      requests.push({ method: request.method, path: pathname, at: nowIso(), bodyLength: raw.length })
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ received: true, path: pathname, size: raw.length }))
        return
      }
      const relative = pathname === '/' ? 'click.html' : pathname.replace(/^\/+/u, '')
      const absolute = resolve(FIXTURES_DIR, relative)
      if (!absolute.startsWith(FIXTURES_DIR + sep) || !existsSync(absolute) || !statSync(absolute).isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end(`fixture not found: ${pathname}`)
        return
      }
      const ext = absolute.slice(absolute.lastIndexOf('.'))
      response.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      response.end(readFileSync(absolute))
    })
  }
  let port = (await portFree(PREFERRED_FIXTURE_PORT)) ? PREFERRED_FIXTURE_PORT : await freePort()
  const server = createServer(handle)
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(port, '127.0.0.1', resolveListen)
    })
  } catch {
    // Another server took the port between the probe and the bind.
    port = await freePort()
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(port, '127.0.0.1', resolveListen)
    })
  }
  // Also answer on ::1 so a localhost hostname resolves to this server too.
  const server6 = createServer(handle)
  await new Promise(resolveListen => {
    server6.once('error', () => resolveListen())
    server6.listen(port, '::1', resolveListen)
  })
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      await new Promise(resolveClose => server.close(resolveClose))
      await new Promise(resolveClose => server6.close(resolveClose))
    },
  }
}

/** Graceful browser shutdown through a CDP port this runner assigned. */
async function closeBrowserViaCdp(port) {
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) })).json()
    const connection = await connectCdp(version.webSocketDebuggerUrl)
    try {
      await connection.send('Browser.close')
    } finally {
      connection.close()
    }
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Suite execution
// ---------------------------------------------------------------------------

function countCases(stdout) {
  const pass = (stdout.match(/^PASS\b/gm) ?? []).length
  const ok = (stdout.match(/^ok - /gm) ?? []).length
  return pass + ok
}

/**
 * Run one suite as a child process. On timeout: SIGTERM (drag/capture handle
 * it and clean their own Edge), wait, SIGKILL, then backstop any self-launched
 * Edge through the CDP port we assigned. Only this child's PID is signalled.
 */
async function runSuite(spec, { env, timeoutS, logDir }) {
  const started = Date.now()
  const child = spawn(process.execPath, [join(ROOT, 'scripts', spec.script)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const CAP = 200_000
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-CAP) })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-CAP) })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 5_000).unref?.()
  }, timeoutS * 1_000)
  timer.unref?.()
  const code = await new Promise(resolveExit => {
    child.once('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)))
    child.once('error', () => resolveExit(1))
  })
  clearTimeout(timer)
  // Backstop: a killed self-suite may have left its own Edge running on the
  // port we assigned. Close it through that port only (never by path).
  if (spec.class === 'self' && env.CDP_PORT) {
    await closeBrowserViaCdp(Number(env.CDP_PORT))
  }
  if (logDir) {
    try {
      writeFileSync(join(logDir, `${spec.name}.stdout.log`), stdout)
      writeFileSync(join(logDir, `${spec.name}.stderr.log`), stderr)
    } catch { /* diagnostics are best effort */ }
  }
  const wallMs = Date.now() - started
  const tail = (timedOut ? stderr || stdout : stderr).split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400)
  return {
    name: spec.name,
    class: spec.class,
    result: timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL',
    cases: countCases(stdout),
    wallMs,
    exitCode: code,
    note: timedOut ? `exceeded ${timeoutS}s` : code !== 0 ? tail : (spec.note ?? ''),
    stdoutTail: stdout.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const options = { only: [], skip: [], headed: false, keep: false, timeoutS: null, json: null, logs: null, list: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${token} needs a value`)
      return next
    }
    if (token === '--only') options.only.push(value())
    else if (token === '--skip') options.skip.push(value())
    else if (token === '--headed') options.headed = true
    else if (token === '--keep') options.keep = true
    else if (token === '--timeout') options.timeoutS = Number(value())
    else if (token === '--json') options.json = value()
    else if (token === '--logs') options.logs = value()
    else if (token === '--list') options.list = true
    else if (token === '--help' || token === '-h') options.help = true
    else throw new Error(`unknown flag ${token}`)
  }
  if (options.timeoutS !== null && (!Number.isFinite(options.timeoutS) || options.timeoutS < 10)) {
    throw new Error('--timeout must be >= 10 seconds')
  }
  const known = new Set([...SUITES.map(suite => suite.name), ...EXCLUDED.map(suite => suite.name)])
  for (const name of [...options.only, ...options.skip]) {
    if (!known.has(name)) throw new Error(`unknown suite: ${name} (see --list)`)
  }
  return options
}

function printHelp() {
  process.stdout.write(`crazyAgent real-extension gate runner (Q5)

  node scripts/run-e2e-gates.mjs [--only <suite>] [--skip <suite>] [--headed]
                                 [--keep] [--timeout <s>] [--json <path>] [--list]

Runs the headless-capable edge-*-e2e suites against one isolated Edge and a
fixture server (17872 when free, else a free port). Self-launching suites get
their own free CDP ports. Prints one table; exit 1 on any non-experimental
failure. Never touches the running service, port 9233, or the docs profile.
`)
}

function pad(value, width) {
  return String(value ?? '').padEnd(width)
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return 0
  }
  if (options.list) {
    for (const suite of SUITES) process.stdout.write(`${pad(suite.name, 12)} ${pad(suite.class, 8)} ${suite.script}${suite.experimental ? '  (experimental)' : ''}\n`)
    for (const suite of EXCLUDED) process.stdout.write(`${pad(suite.name, 12)} excluded  ${suite.reason}\n`)
    return 0
  }

  const scratch = mkdtempSync(join(tmpdir(), 'ca-e2e-gates-'))
  const profileDir = join(scratch, 'edge-profile')
  if (options.logs) mkdirSync(options.logs, { recursive: true })
  if (resolve(profileDir) === DOCS_PROFILE || profileDir.startsWith(DOCS_PROFILE + sep)) {
    throw new Error('refusing to use the docs profile')
  }
  /** @type {Array<Record<string, any>>} */
  const results = []
  const cannotHeadless = [...EXCLUDED.map(suite => ({ name: suite.name, reason: suite.reason }))]
  let fixtureServer = null
  let edge = null
  let cdpPort = null
  const startedAt = nowIso()

  try {
    fixtureServer = await startFixtureServer()
    process.stdout.write(`fixture server: ${fixtureServer.baseUrl}${fixtureServer.port === PREFERRED_FIXTURE_PORT ? '' : ' (17872 held by another server)'}\n`)
    cdpPort = await freePort()
    // Confine every download to the runner's own temp folder. Two mechanisms:
    // (1) the profile preference, written BEFORE Edge starts — Edge 157 does
    // not let the CDP Browser.setDownloadBehavior override redirect downloads
    // started through the chrome.downloads API (the executor's path); they
    // land in the profile default ~/Downloads unless the profile itself says
    // otherwise (measured: files suite, 2026-11-16). (2) the CDP override on
    // the persistent browser connection, kept for navigational downloads.
    // DOWNLOAD_ROOT points the files suite's executor-side check at the same
    // folder. No suite can write into the user's real Downloads.
    const downloadsDir = join(scratch, 'Downloads')
    mkdirSync(downloadsDir, { recursive: true })
    mkdirSync(join(profileDir, 'Default'), { recursive: true })
    writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({
      download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true },
      savefile: { default_directory: downloadsDir },
    }))
    // startEdge keeps a browser-level CDP connection open for the whole run
    // (target bookkeeping, tab pre-open, and the download override below).
    edge = await startEdge({
      profileDir,
      cdpPort,
      initialUrl: 'about:blank',
      headed: options.headed,
      loadExtension: true,
      verbose: false,
    })
    await edge.browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsDir, eventsEnabled: false })
    process.stdout.write(`isolated Edge: CDP http://127.0.0.1:${cdpPort} (pid ${edge.child.pid}, ${options.headed ? 'headed' : 'headless'})\n\n`)

    const selected = SUITES.filter(suite =>
      (options.only.length === 0 || options.only.includes(suite.name)) && !options.skip.includes(suite.name))
    for (const spec of selected) {
      if (spec.fixedFixturePort && fixtureServer.port !== spec.fixedFixturePort) {
        const reason = `hardcodes fixture port ${spec.fixedFixturePort}, which is held by another server (runner used ${fixtureServer.port})`
        results.push({ name: spec.name, class: spec.class, mode: spec.class === 'attach' ? (options.headed ? 'headed' : 'headless') : (spec.mode ?? 'headless'), result: 'SKIP', cases: 0, wallMs: 0, note: reason })
        cannotHeadless.push({ name: spec.name, reason })
        process.stdout.write(`SKIP ${pad(spec.name, 12)} ${reason}\n`)
        continue
      }
      const env = spec.class === 'attach'
        ? { CDP_URL: `http://127.0.0.1:${cdpPort}`, FIXTURE_URL: fixtureServer.baseUrl, DOWNLOAD_ROOT: downloadsDir, ...(spec.env ?? {}) }
        : { CDP_PORT: String(await freePort()), ...(spec.env ?? {}) }
      // Some suites query for an already-open fixture tab instead of creating
      // one (canvas, advanced). Open it here so every suite is order-independent.
      if (spec.needsTab) {
        const targets = await listTargets(edge.cdpHttp)
        const present = targets.some(target => target.type === 'page' && String(target.url).includes(spec.needsTab))
        if (!present) {
          await edge.browser.send('Target.createTarget', { url: `${fixtureServer.baseUrl}/${spec.needsTab}`, background: true })
          await sleep(700)
        }
      }
      const timeoutS = options.timeoutS ?? spec.timeoutS
      const mode = spec.class === 'attach' ? (options.headed ? 'headed' : 'headless') : (spec.mode ?? 'headless')
      process.stdout.write(`RUN  ${pad(spec.name, 12)} (${spec.class}, ${mode}, timeout ${timeoutS}s)\n`)
      const result = await runSuite(spec, { env, timeoutS, logDir: options.logs })
      if (spec.experimental && result.result !== 'PASS') {
        cannotHeadless.push({ name: spec.name, reason: `experimental headless trial ${result.result}: ${result.note || result.stdoutTail}` })
        result.note = `experimental: ${result.note}`
      }
      result.mode = mode
      results.push(result)
      process.stdout.write(`${pad(result.result, 4)} ${pad(spec.name, 12)} cases ${pad(result.cases, 3)} ${(result.wallMs / 1000).toFixed(1)}s${result.note ? `  ${result.note}` : ''}\n`)
    }
  } finally {
    // Only this runner's own Edge process group, scoped to its throwaway profile.
    await edge?.stop().catch(() => {})
    await fixtureServer?.close().catch(() => {})
    if (!options.keep) {
      const resolved = resolve(scratch)
      if (resolved.startsWith(`${resolve(tmpdir())}${sep}`)) rmSync(resolved, { recursive: true, force: true })
    } else {
      process.stdout.write(`\nkept scratch: ${scratch}\n`)
    }
  }

  // --- One table -----------------------------------------------------------
  const widths = [12, 8, 9, 8, 6, 8, 80]
  const line = cells => cells.map((cell, index) => pad(String(cell ?? '').slice(0, widths[index]), widths[index])).join(' ')
  process.stdout.write(`\n${line(['suite', 'class', 'mode', 'result', 'cases', 'wall', 'note'])}\n`)
  process.stdout.write(`${line(widths.map(width => '-'.repeat(width)))}\n`)
  for (const result of results) {
    process.stdout.write(`${line([result.name, result.class, result.mode ?? '-', result.result, result.cases || '-', result.wallMs ? `${(result.wallMs / 1000).toFixed(1)}s` : '-', result.note])}\n`)
  }
  for (const suite of EXCLUDED) {
    if (!results.some(result => result.name === suite.name)) {
      process.stdout.write(`${line([suite.name, 'excluded', suite.mode ?? 'n/a', 'SKIP', '-', '-', suite.reason])}\n`)
    }
  }
  const passed = results.filter(result => result.result === 'PASS').length
  const failed = results.filter(result => result.result === 'FAIL' || result.result === 'TIMEOUT')
  const hardFailed = failed.filter(result => !SUITES.find(suite => suite.name === result.name)?.experimental)
  const skipped = results.filter(result => result.result === 'SKIP').length + EXCLUDED.filter(suite => !results.some(result => result.name === suite.name)).length
  process.stdout.write(`\n${passed} passed, ${hardFailed.length} failed, ${skipped} skipped/excluded (${failed.length - hardFailed.length} experimental non-pass)\n`)
  if (cannotHeadless.length > 0) {
    process.stdout.write('\ncannot run headless / excluded:\n')
    for (const entry of cannotHeadless) process.stdout.write(`  ${pad(entry.name, 12)} ${entry.reason}\n`)
  }
  process.stdout.write(`\nfixture requests logged: ${fixtureServer?.requests.length ?? 0}\n`)

  if (options.json) {
    writeFileSync(options.json, `${JSON.stringify({
      startedAt,
      finishedAt: nowIso(),
      headless: !options.headed,
      fixturePort: fixtureServer?.port ?? null,
      cdpPort,
      results,
      cannotHeadless,
      passed,
      failed: hardFailed.length,
      skipped,
    }, null, 2)}\n`)
    process.stdout.write(`JSON: ${options.json}\n`)
  }
  return hardFailed.length > 0 ? 1 : 0
}

main()
  .then(code => { process.exitCode = code })
  .catch(error => {
    process.stderr.write(`run-e2e-gates: ${error.message}\n`)
    process.exitCode = 1
  })
