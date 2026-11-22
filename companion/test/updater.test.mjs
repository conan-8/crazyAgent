import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  IDLE_TICKS_BEFORE_INSTALL,
  UPDATE_EXIT_CODE,
  Updater,
  applyUpdate,
  checkEligibility,
  compareVersions,
  fetchLatestRelease,
  fetchReleaseTag,
  isReleaseRemote,
  parseVersion,
  readUpdateState,
  runCommand,
} from '../updater.mjs'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
}
const OFFICIAL = 'https://github.com/conan-8/crazyAgent.git'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A repository with release tags v2.3.0 and v2.4.0 on `main`. */
function makeUpstream(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crazyagent-upstream-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main')
  for (const version of ['2.3.0', '2.4.0']) {
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'crazyagent', version })}\n`)
    writeFileSync(join(dir, 'file.txt'), `content of ${version}\n`)
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `release ${version}`)
    git(dir, 'tag', `v${version}`)
  }
  return dir
}

/** An installation: a clone detached at v2.3.0 that does not have v2.4.0 yet. */
function makeInstall(t, upstream, { origin = OFFICIAL } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crazyagent-install-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', upstream)
  git(dir, 'fetch', '-q', '--no-tags', 'origin', 'refs/tags/v2.3.0:refs/tags/v2.3.0')
  git(dir, 'checkout', '-q', '--detach', 'v2.3.0')
  git(dir, 'remote', 'set-url', 'origin', origin)
  return dir
}

const withEnv = (command, args, options = {}) => runCommand(command, args, { ...options, env: options.env ?? GIT_ENV })

test('parseVersion and compareVersions accept release versions only', () => {
  assert.deepEqual(parseVersion('v2.4.0'), [2, 4, 0])
  assert.deepEqual(parseVersion('2.10.3'), [2, 10, 3])
  for (const bad of ['v2.1.0-beta', '2.4', 'latest', '', undefined, '2.4.0; rm -rf /']) assert.equal(parseVersion(bad), null)
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1)
  assert.equal(compareVersions('2.3.0', 'v2.3.0'), 0)
  assert.equal(compareVersions('2.2.0', '2.3.0'), -1)
  assert.equal(compareVersions('2.4.0-beta', '2.3.0'), null)
})

test('isReleaseRemote accepts only the official repository', () => {
  for (const url of [OFFICIAL, 'https://github.com/conan-8/crazyAgent', 'git@github.com:conan-8/crazyAgent.git', 'ssh://git@github.com/conan-8/crazyAgent.git']) {
    assert.equal(isReleaseRemote(url), true, url)
  }
  for (const url of ['https://github.com/someone/crazyAgent.git', 'https://github.com.evil.example/conan-8/crazyAgent.git', 'https://example.com/?https://github.com/conan-8/crazyAgent.git', '/tmp/local', '']) {
    assert.equal(isReleaseRemote(url), false, url)
  }
})

test('checkEligibility: a clean official checkout at the running tag is eligible', async t => {
  const install = makeInstall(t, makeUpstream(t))
  assert.deepEqual(await checkEligibility({ root: install, version: '2.3.0', run: withEnv }), { ok: true })
})

test('checkEligibility fails closed on forks, branches, other commits, and local edits', async t => {
  const upstream = makeUpstream(t)
  const reasonOf = async (root, version = '2.3.0') => {
    const result = await checkEligibility({ root, version, run: withEnv })
    assert.equal(result.ok, false)
    return result.reason
  }

  assert.match(await reasonOf(makeInstall(t, upstream, { origin: 'https://github.com/fork/crazyAgent.git' })), /origin is not/u)

  const onBranch = makeInstall(t, upstream)
  git(onBranch, 'checkout', '-q', '-b', 'work')
  assert.match(await reasonOf(onBranch), /on a branch/u)

  assert.match(await reasonOf(makeInstall(t, upstream), '2.2.0'), /not exactly at release tag v2\.2\.0/u)

  const edited = makeInstall(t, upstream)
  writeFileSync(join(edited, 'file.txt'), 'my local edit\n')
  assert.match(await reasonOf(edited), /local changes/u)

  const untrackedOnly = makeInstall(t, upstream)
  writeFileSync(join(untrackedOnly, 'notes.txt'), 'untracked files do not block updates\n')
  assert.deepEqual(await checkEligibility({ root: untrackedOnly, version: '2.3.0', run: withEnv }), { ok: true })

  const notARepo = mkdtempSync(join(tmpdir(), 'crazyagent-plain-'))
  t.after(() => rmSync(notARepo, { recursive: true, force: true }))
  assert.match(await reasonOf(notARepo), /not a Git checkout|not the root/u)
  assert.match(await reasonOf(makeInstall(t, upstream), 'dev'), /not a release version/u)
})

test('fetchLatestRelease returns a stable version and ignores drafts, pre-releases, and odd tags', async () => {
  const answer = body => ({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) })
  assert.equal(await fetchLatestRelease(answer({ tag_name: 'v2.4.0' })), '2.4.0')
  assert.equal(await fetchLatestRelease(answer({ tag_name: 'v2.4.0', prerelease: true })), null)
  assert.equal(await fetchLatestRelease(answer({ tag_name: 'v2.4.0', draft: true })), null)
  assert.equal(await fetchLatestRelease(answer({ tag_name: 'v2.5.0-beta' })), null)
  await assert.rejects(fetchLatestRelease({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) }), /HTTP 403/u)
  let seen
  await fetchLatestRelease({ fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({}) } } })
  assert.equal(seen.url, 'https://api.github.com/repos/conan-8/crazyAgent/releases/latest')
  assert.deepEqual(Object.keys(seen.init.headers).sort(), ['accept', 'user-agent'])
})

test('fetchReleaseTag fetches one tag without touching the working tree, and rejects a mislabelled tag', async t => {
  const upstream = makeUpstream(t)
  const install = makeInstall(t, upstream, { origin: upstream })
  assert.deepEqual(await fetchReleaseTag({ root: install, version: '2.4.0', run: withEnv }), { ok: true })
  assert.equal(git(install, 'rev-parse', 'v2.4.0^{commit}'), git(upstream, 'rev-parse', 'v2.4.0^{commit}'))
  assert.equal(readFileSync(join(install, 'file.txt'), 'utf8'), 'content of 2.3.0\n')
  assert.equal(git(install, 'status', '--porcelain'), '')

  git(upstream, 'tag', 'v2.5.0', 'v2.4.0')
  const wrong = await fetchReleaseTag({ root: install, version: '2.5.0', run: withEnv })
  assert.equal(wrong.ok, false)
  assert.match(wrong.reason, /does not contain version 2\.5\.0/u)
  const missing = await fetchReleaseTag({ root: install, version: '9.9.9', run: withEnv })
  assert.equal(missing.ok, false)
})

/** Real git, recorded stand-ins for npm and the setup script. */
function installRunner({ failAt = null } = {}) {
  const calls = []
  const run = async (command, args, options = {}) => {
    if (command === 'git') return withEnv(command, args, options)
    const name = command === 'npm' ? 'npm ci' : 'setup'
    const head = git(options.cwd, 'describe', '--tags', '--exact-match', 'HEAD')
    calls.push(`${name}@${head}`)
    return failAt === `${name}@${head}` ? { code: 1, stdout: '', stderr: `${name} exploded` } : { code: 0, stdout: '', stderr: '' }
  }
  return { calls, run }
}

test('applyUpdate checks the new tag out, then installs and runs setup', async t => {
  const upstream = makeUpstream(t)
  const install = makeInstall(t, upstream, { origin: upstream })
  await fetchReleaseTag({ root: install, version: '2.4.0', run: withEnv })
  const runner = installRunner()
  const result = await applyUpdate({ root: install, from: '2.3.0', to: '2.4.0', run: runner.run, platform: 'linux' })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(runner.calls, ['npm ci@v2.4.0', 'setup@v2.4.0'])
  assert.equal(readFileSync(join(install, 'file.txt'), 'utf8'), 'content of 2.4.0\n')
  assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf8')).version, '2.4.0')
})

test('applyUpdate restores the previous tag and its dependencies when the install fails', async t => {
  const upstream = makeUpstream(t)
  for (const failAt of ['npm ci@v2.4.0', 'setup@v2.4.0']) {
    const install = makeInstall(t, upstream, { origin: upstream })
    await fetchReleaseTag({ root: install, version: '2.4.0', run: withEnv })
    const runner = installRunner({ failAt })
    const result = await applyUpdate({ root: install, from: '2.3.0', to: '2.4.0', run: runner.run, platform: 'linux' })
    assert.equal(result.ok, false)
    assert.equal(result.rolledBack, true)
    assert.equal(result.stage, failAt.split('@')[0])
    assert.equal(runner.calls.at(-1), 'npm ci@v2.3.0')
    assert.equal(git(install, 'describe', '--tags', '--exact-match', 'HEAD'), 'v2.3.0')
    assert.equal(readFileSync(join(install, 'file.txt'), 'utf8'), 'content of 2.3.0\n')
  }
})

test('applyUpdate never forces: a conflicting local edit refuses the checkout and is kept', async t => {
  const upstream = makeUpstream(t)
  const install = makeInstall(t, upstream, { origin: upstream })
  await fetchReleaseTag({ root: install, version: '2.4.0', run: withEnv })
  writeFileSync(join(install, 'file.txt'), 'my local edit\n')
  const runner = installRunner()
  const result = await applyUpdate({ root: install, from: '2.3.0', to: '2.4.0', run: runner.run, platform: 'linux' })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'checkout')
  assert.deepEqual(runner.calls, [])
  assert.equal(readFileSync(join(install, 'file.txt'), 'utf8'), 'my local edit\n')
  assert.equal(git(install, 'describe', '--tags', '--exact-match', 'HEAD'), 'v2.3.0')
})

/** An Updater over a real install whose origin URL is official but whose fetches go to the local upstream. */
function makeUpdater(t, overrides = {}) {
  const upstream = makeUpstream(t)
  const install = overrides.install ?? makeInstall(t, upstream)
  const h = { install, upstream, now: 0, idle: true, exits: [], stopped: 0, applied: [], logs: [], events: [], latest: { tag_name: 'v2.4.0' }, fetches: 0 }
  const run = async (command, args, options = {}) => {
    // `git fetch origin` would reach GitHub; send it to the local upstream instead.
    if (command === 'git' && args[0] === 'fetch') return withEnv(command, args.map(arg => arg === 'origin' ? upstream : arg), options)
    return withEnv(command, args, options)
  }
  h.updater = new Updater({
    root: install,
    version: '2.3.0',
    stateFile: join(install, 'update-state.json'),
    supervised: true,
    isIdle: () => h.idle,
    beforeInstall: async () => { h.stopped += 1 },
    exit: code => { h.exits.push(code) },
    log: message => { h.logs.push(message) },
    record: (event, data) => { h.events.push({ event, data }) },
    run,
    fetchImpl: async () => {
      h.fetches += 1
      if (h.latest instanceof Error) throw h.latest
      return { ok: true, status: 200, json: async () => h.latest }
    },
    now: () => h.now,
    setRepeat: () => 'timer',
    clearRepeat: () => {},
    apply: async input => { h.applied.push(`${input.from}->${input.to}`); return h.applyResult ?? { ok: true } },
    ...overrides.options,
  })
  h.tickAt = async ms => { h.now = ms; await h.updater.tick() }
  return h
}

test('Updater: checks after the startup delay, waits for a long idle stretch, then installs and asks for a restart', async t => {
  const h = makeUpdater(t)
  await h.tickAt(FIRST_CHECK_DELAY_MS - 1)
  assert.equal(h.fetches, 0)
  assert.equal(h.updater.status().state, 'idle')

  await h.tickAt(FIRST_CHECK_DELAY_MS)
  assert.equal(h.updater.status().state, 'pending')
  assert.equal(h.updater.status().latest, '2.4.0')
  assert.equal(git(h.install, 'describe', '--tags', '--exact-match', 'HEAD'), 'v2.3.0')

  for (let i = 1; i < IDLE_TICKS_BEFORE_INSTALL; i += 1) await h.tickAt(h.now + 60_000)
  assert.deepEqual(h.applied, [])
  await h.tickAt(h.now + 60_000)
  assert.deepEqual(h.applied, ['2.3.0->2.4.0'])
  assert.equal(h.stopped, 1)
  assert.deepEqual(h.exits, [UPDATE_EXIT_CODE])
  assert.equal(readUpdateState(join(h.install, 'update-state.json')).last.to, '2.4.0')
})

test('Updater publishes sidebar state and restores the completed-update result after a restart', async t => {
  const h = makeUpdater(t)
  await h.tickAt(FIRST_CHECK_DELAY_MS)
  const published = h.events.find(item => item.event === 'update.state' && item.data.state === 'pending')
  assert.equal(published.data.latest, '2.4.0')
  assert.equal(published.data.last, null)
  for (let i = 0; i < IDLE_TICKS_BEFORE_INSTALL; i += 1) await h.tickAt(h.now + 60_000)
  const last = h.updater.status().last
  assert.equal(last.from, '2.3.0')
  assert.equal(last.to, '2.4.0')
  assert.equal(Number.isFinite(Date.parse(last.at)), true)

  const restarted = makeUpdater(t, { install: h.install, options: { version: '2.4.0' } })
  assert.deepEqual(restarted.updater.status().last, last)
})

test('Updater: a running turn, marathon, or any turn activity restarts the idle wait', async t => {
  const h = makeUpdater(t)
  await h.tickAt(FIRST_CHECK_DELAY_MS)
  for (let i = 1; i < IDLE_TICKS_BEFORE_INSTALL; i += 1) await h.tickAt(h.now + 60_000)
  h.idle = false
  await h.tickAt(h.now + 60_000)
  h.idle = true
  for (let i = 1; i < IDLE_TICKS_BEFORE_INSTALL; i += 1) await h.tickAt(h.now + 60_000)
  h.updater.noteActivity()
  for (let i = 1; i < IDLE_TICKS_BEFORE_INSTALL; i += 1) await h.tickAt(h.now + 60_000)
  assert.deepEqual(h.applied, [])
  assert.deepEqual(h.exits, [])
  await h.tickAt(h.now + 60_000)
  assert.deepEqual(h.applied, ['2.3.0->2.4.0'])
})

test('Updater: nothing newer, pre-releases, and failed checks install nothing and retry at the next interval', async t => {
  for (const latest of [{ tag_name: 'v2.3.0' }, { tag_name: 'v2.2.0' }, { tag_name: 'v3.0.0', prerelease: true }, new Error('offline')]) {
    const h = makeUpdater(t)
    h.latest = latest
    await h.tickAt(FIRST_CHECK_DELAY_MS)
    assert.equal(h.updater.status().state, latest instanceof Error ? 'error' : 'current')
    for (let i = 0; i < IDLE_TICKS_BEFORE_INSTALL + 2; i += 1) await h.tickAt(h.now + 60_000)
    assert.equal(h.fetches, 1)
    assert.deepEqual(h.applied, [])
    h.latest = { tag_name: 'v2.4.0' }
    await h.tickAt(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS)
    assert.equal(h.updater.status().state, 'pending')
  }
})

test('Updater: an ineligible checkout is never contacted about or moved', async t => {
  const upstream = makeUpstream(t)
  const install = makeInstall(t, upstream)
  git(install, 'checkout', '-q', '-b', 'main')
  const h = makeUpdater(t, { install })
  await h.tickAt(FIRST_CHECK_DELAY_MS)
  assert.equal(h.updater.status().state, 'ineligible')
  assert.equal(h.fetches, 0)
  for (let i = 0; i < IDLE_TICKS_BEFORE_INSTALL + 2; i += 1) await h.tickAt(h.now + 60_000)
  assert.deepEqual(h.applied, [])
})

test('Updater: a checkout edited after the tag was fetched is left alone', async t => {
  const h = makeUpdater(t)
  await h.tickAt(FIRST_CHECK_DELAY_MS)
  writeFileSync(join(h.install, 'file.txt'), 'edited while pending\n')
  for (let i = 0; i < IDLE_TICKS_BEFORE_INSTALL; i += 1) await h.tickAt(h.now + 60_000)
  assert.equal(h.updater.status().state, 'ineligible')
  assert.deepEqual(h.applied, [])
  assert.equal(h.stopped, 0)
  assert.deepEqual(h.exits, [])
})

test('Updater: without a supervisor the update is announced, not installed', async t => {
  const h = makeUpdater(t, { options: { supervised: false } })
  await h.tickAt(FIRST_CHECK_DELAY_MS)
  assert.equal(h.updater.status().state, 'available')
  for (let i = 0; i < IDLE_TICKS_BEFORE_INSTALL + 2; i += 1) await h.tickAt(h.now + 60_000)
  assert.deepEqual(h.applied, [])
  assert.throws(() => git(h.install, 'rev-parse', '--verify', '--quiet', 'refs/tags/v2.4.0'))
})

test('Updater: a failed install is recorded, restarts on the old version, and is not retried for a day', async t => {
  const h = makeUpdater(t)
  h.applyResult = { ok: false, stage: 'npm ci', error: 'boom', rolledBack: true }
  await h.tickAt(FIRST_CHECK_DELAY_MS)
  for (let i = 0; i < IDLE_TICKS_BEFORE_INSTALL; i += 1) await h.tickAt(h.now + 60_000)
  assert.deepEqual(h.exits, [UPDATE_EXIT_CODE])
  const failed = readUpdateState(join(h.install, 'update-state.json')).failed
  assert.equal(failed.version, '2.4.0')
  assert.equal(failed.rolledBack, true)

  // The restarted companion (old version) sees the same release again.
  const again = makeUpdater(t, { install: h.install })
  again.now = h.now
  await again.tickAt(h.now + FIRST_CHECK_DELAY_MS)
  assert.equal(again.updater.status().state, 'error')
  for (let i = 0; i < IDLE_TICKS_BEFORE_INSTALL + 2; i += 1) await again.tickAt(again.now + 60_000)
  assert.deepEqual(again.applied, [])
})

test('Updater: disabled does nothing at all', async t => {
  const h = makeUpdater(t, { options: { enabled: false, disabledReason: 'switched off' } })
  h.updater.start()
  await h.tickAt(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS)
  assert.equal(h.fetches, 0)
  assert.deepEqual(h.updater.status(), { state: 'disabled', reason: 'switched off', current: '2.3.0', latest: null, last: null, lastCheckAt: null })
})

test('Updater: checkNow checks immediately, retries failed cooldowns, and installNow validates idle state', async t => {
  const disabled = makeUpdater(t, { options: { enabled: false, disabledReason: 'switched off' } })
  const disabledRes = await disabled.updater.checkNow()
  assert.equal(disabledRes.ok, false)
  assert.equal(disabledRes.code, 'UPDATE_DISABLED')

  const h = makeUpdater(t)
  assert.equal((await h.updater.installNow()).code, 'UPDATE_NOT_READY')
  const checked = await h.updater.checkNow()
  assert.equal(checked.ok, true)
  assert.equal(checked.update.state, 'pending')
  assert.equal(checked.update.latest, '2.4.0')
  assert.equal(h.events.some(e => e.event === 'update.state' && e.data.state === 'checking'), true)

  h.idle = false
  assert.equal((await h.updater.installNow()).code, 'UPDATE_BUSY')
  h.idle = true
  const installed = await h.updater.installNow()
  assert.equal(installed.ok, true)
  assert.deepEqual(h.applied, ['2.3.0->2.4.0'])
  assert.deepEqual(h.exits, [UPDATE_EXIT_CODE])

  // Manual checkNow bypasses the 24-hour failed-version cooldown.
  const failHarness = makeUpdater(t)
  failHarness.applyResult = { ok: false, stage: 'npm ci', error: 'boom', rolledBack: true }
  await failHarness.tickAt(FIRST_CHECK_DELAY_MS)
  for (let i = 0; i < IDLE_TICKS_BEFORE_INSTALL; i += 1) await failHarness.tickAt(failHarness.now + 60_000)
  const retryHarness = makeUpdater(t, { install: failHarness.install })
  retryHarness.now = failHarness.now
  const forced = await retryHarness.updater.checkNow()
  assert.equal(forced.ok, true)
  assert.equal(forced.update.state, 'pending')
})
