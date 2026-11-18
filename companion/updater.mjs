/**
 * Automatic updates for a release installation.
 *
 * crazyAgent is installed as a Git checkout of a release tag, with the unpacked
 * extension loaded from that checkout. The updater moves such a checkout to the
 * newest published release while nothing is running:
 *
 *   1. about every six hours, ask GitHub for the latest release (no user data);
 *   2. fetch that one tag and confirm it carries the announced version;
 *   3. once the companion has been idle for a while, stop its servers, check
 *      the tag out, run `npm ci` and the setup script, and exit with
 *      UPDATE_EXIT_CODE so the supervisor (`npm run dev` or the service) starts
 *      the new version. The extension then reloads itself from the same
 *      checkout (extension/self-update.js).
 *
 * It fails closed. Nothing is touched unless the checkout is the official
 * repository, sits detached exactly on the tag of the running version, and has
 * no modified tracked files — so a development checkout on a branch, a fork,
 * or an installation with local edits is never updated. A failed install is
 * rolled back to the previous tag and that version is not retried for a day.
 * It never forces a checkout, resets, cleans, or deletes anything.
 */

import { execFile } from 'node:child_process'
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** EX_TEMPFAIL: "restart me". `scripts/dev.mjs` and the service both restart on it. */
export const UPDATE_EXIT_CODE = 75
export const RELEASE_REPO = 'conan-8/crazyAgent'
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`

export const TICK_MS = 60_000
export const FIRST_CHECK_DELAY_MS = 2 * 60_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000
/** Consecutive idle ticks (with no turn starting or ending) before installing. */
export const IDLE_TICKS_BEFORE_INSTALL = 10
export const FAILED_VERSION_RETRY_MS = 24 * 60 * 60_000

const GIT_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 15 * 60_000

/**
 * Strict release version: `2.4.0` or `v2.4.0`. Pre-releases and anything else
 * are not versions this updater moves to.
 * @param {unknown} text
 * @returns {[number, number, number] | null}
 */
export function parseVersion(text) {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/u.exec(String(text ?? '').trim())
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** @param {unknown} a @param {unknown} b @returns {number | null} null when either is not a release version */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/** @param {unknown} url */
export function isReleaseRemote(url) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)conan-8\/crazyagent(?:\.git)?\/?$/iu.test(String(url ?? '').trim())
}

/**
 * Run a command without a shell and never throw.
 * @param {string} command @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, shell?: boolean}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      shell: options.shell === true,
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error === null ? '' : String(error.message)) })
    })
  })
}

/** @param {{stdout: string, stderr: string}} result */
function lastLine(result) {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map(line => line.trim()).filter(Boolean)
  return (lines.at(-1) ?? 'no output').slice(0, 300)
}

/**
 * Whether this checkout may be updated automatically.
 * @param {{root: string, version: string, run?: typeof runCommand}} input
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkEligibility({ root, version, run = runCommand }) {
  if (parseVersion(version) === null) return { ok: false, reason: `running version "${version}" is not a release version` }
  const git = args => run('git', args, { cwd: root })

  const top = await git(['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return { ok: false, reason: 'not a Git checkout' }
  let sameRoot = false
  try {
    sameRoot = realpathSync(top.stdout.trim()) === realpathSync(root)
  } catch {
    sameRoot = false
  }
  if (!sameRoot) return { ok: false, reason: 'the installation is not the root of its Git checkout' }

  const remote = await git(['remote', 'get-url', 'origin'])
  if (remote.code !== 0 || !isReleaseRemote(remote.stdout)) return { ok: false, reason: `origin is not the ${RELEASE_REPO} repository` }

  const branch = await git(['symbolic-ref', '-q', 'HEAD'])
  if (branch.code === 0) return { ok: false, reason: 'the checkout is on a branch (development checkout), not a release tag' }

  const head = await git(['rev-parse', 'HEAD'])
  const tag = await git(['rev-parse', '--verify', '--quiet', `refs/tags/v${version}^{commit}`])
  if (head.code !== 0 || tag.code !== 0 || head.stdout.trim() !== tag.stdout.trim()) {
    return { ok: false, reason: `the checkout is not exactly at release tag v${version}` }
  }

  const status = await git(['status', '--porcelain', '--untracked-files=no'])
  if (status.code !== 0) return { ok: false, reason: 'git status failed' }
  if (status.stdout.trim().length > 0) return { ok: false, reason: 'the checkout has local changes to tracked files' }
  return { ok: true }
}

/**
 * The latest published (non-draft, non-pre-release) version, or null.
 * Sends no user data: a fixed URL and a generic client name.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [input]
 * @returns {Promise<string | null>}
 */
export async function fetchLatestRelease({ fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'crazyagent-updater' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`)
  const body = await response.json()
  if (body === null || typeof body !== 'object' || body.draft === true || body.prerelease === true) return null
  const parsed = parseVersion(body.tag_name)
  return parsed === null ? null : parsed.join('.')
}

/**
 * Fetch exactly one release tag and confirm it carries the announced version.
 * Changes no working-tree file.
 * @param {{root: string, version: string, run?: typeof runCommand}} input
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function fetchReleaseTag({ root, version, run = runCommand }) {
  const ref = `refs/tags/v${version}`
  const shallow = await run('git', ['rev-parse', '--is-shallow-repository'], { cwd: root })
  const depth = shallow.code === 0 && shallow.stdout.trim() === 'true' ? ['--depth', '1'] : []
  // No leading "+": an existing local tag that differs is an error, not overwritten.
  const fetched = await run('git', ['fetch', '--no-tags', ...depth, 'origin', `${ref}:${ref}`], { cwd: root })
  if (fetched.code !== 0) return { ok: false, reason: `git fetch failed: ${lastLine(fetched)}` }
  const manifest = await run('git', ['show', `${ref}:package.json`], { cwd: root })
  let tagged
  try {
    tagged = JSON.parse(manifest.stdout).version
  } catch {
    tagged = undefined
  }
  if (manifest.code !== 0 || tagged !== version) return { ok: false, reason: `tag v${version} does not contain version ${version}` }
  return { ok: true }
}

/**
 * Move the checkout from one release tag to another and reinstall. On a failed
 * install the previous tag and its dependencies are restored.
 * @param {{root: string, from: string, to: string, run?: typeof runCommand, log?: (message: string) => void,
 *   nodePath?: string, env?: NodeJS.ProcessEnv, platform?: string}} input
 * @returns {Promise<{ok: true} | {ok: false, stage: string, error: string, rolledBack: boolean}>}
 */
export async function applyUpdate({ root, from, to, run = runCommand, log = () => {}, nodePath = process.execPath, env = process.env, platform = process.platform }) {
  // A service may run with a PATH that lacks this Node's npm; put it first.
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const childEnv = { ...env, [pathKey]: `${dirname(nodePath)}${delimiter}${env[pathKey] ?? ''}` }
  const checkout = version => run('git', ['checkout', '--detach', `v${version}`], { cwd: root })
  const npmCi = () => platform === 'win32'
    ? run('npm ci', [], { cwd: root, env: childEnv, timeoutMs: INSTALL_TIMEOUT_MS, shell: true })
    : run('npm', ['ci'], { cwd: root, env: childEnv, timeoutMs: INSTALL_TIMEOUT_MS })
  const setup = () => run(nodePath, [join(root, 'scripts', 'setup.mjs')], { cwd: root, env: childEnv, timeoutMs: INSTALL_TIMEOUT_MS })

  log(`update: checking out v${to}`)
  const moved = await checkout(to)
  // A refused checkout changed nothing, so there is nothing to roll back.
  if (moved.code !== 0) return { ok: false, stage: 'checkout', error: lastLine(moved), rolledBack: false }

  let failure = null
  log('update: installing dependencies (npm ci)')
  const installed = await npmCi()
  if (installed.code !== 0) failure = { stage: 'npm ci', error: lastLine(installed) }
  if (failure === null) {
    log('update: running setup')
    const configured = await setup()
    if (configured.code !== 0) failure = { stage: 'setup', error: lastLine(configured) }
  }
  if (failure === null) return { ok: true }

  log(`update: ${failure.stage} failed (${failure.error}); restoring v${from}`)
  const back = await checkout(from)
  let rolledBack = back.code === 0
  if (rolledBack) {
    const restored = await npmCi()
    rolledBack = restored.code === 0
  }
  return { ok: false, ...failure, rolledBack }
}

/** @param {string} file */
export function readUpdateState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** @param {string} file @param {Record<string, unknown>} state */
export function writeUpdateState(file, state) {
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

function readLastUpdate(file) {
  const last = readUpdateState(file).last
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return null
  if (parseVersion(last.from) === null || parseVersion(last.to) === null) return null
  if (typeof last.at !== 'string' || !Number.isFinite(Date.parse(last.at))) return null
  return { from: String(last.from), to: String(last.to), at: last.at }
}

/**
 * Scheduler around the pure steps above. Every side effect is injected.
 *
 * status().state is one of:
 *   disabled   switched off (flag/env/test mode); `reason` says why
 *   idle       enabled, nothing found yet
 *   ineligible this checkout is not a clean release checkout; `reason` says why
 *   current    the latest release is already running
 *   pending    a newer release is fetched and waits for an idle companion
 *   available  a newer release exists but no supervisor would restart the
 *              companion, so it is only announced
 *   installing servers are stopped and the install is running
 *   error      the last check failed; it is retried at the next interval
 */
export class Updater {
  /**
   * @param {{
   *   root: string,
   *   version: string,
   *   stateFile: string,
   *   enabled?: boolean,
   *   disabledReason?: string,
   *   supervised?: boolean,
   *   isIdle: () => boolean,
   *   beforeInstall: () => Promise<void>,
   *   exit: (code: number) => void,
   *   log?: (message: string) => void,
   *   record?: (event: string, data: Record<string, unknown>) => void,
   *   run?: typeof runCommand,
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   setRepeat?: (fn: () => void, ms: number) => any,
   *   clearRepeat?: (timer: any) => void,
   *   apply?: typeof applyUpdate,
   * }} options
   */
  constructor(options) {
    this.options = options
    this.root = options.root
    this.version = options.version
    this.stateFile = options.stateFile
    this.supervised = options.supervised === true
    this.log = options.log ?? (() => {})
    this.record = options.record ?? (() => {})
    this.run = options.run ?? runCommand
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.now = options.now ?? (() => Date.now())
    this.apply = options.apply ?? applyUpdate
    this.state = options.enabled === false ? 'disabled' : 'idle'
    this.reason = options.enabled === false ? (options.disabledReason ?? 'switched off') : null
    /** @type {string | null} */
    this.latest = null
    /** @type {string | null} */
    this.pending = null
    this.last = readLastUpdate(options.stateFile)
    /** @type {number | null} */
    this.lastCheckAt = null
    this.nextCheckAt = this.now() + FIRST_CHECK_DELAY_MS
    this.idleTicks = 0
    this.busy = false
    this.timer = undefined
  }

  start() {
    if (this.state === 'disabled' || this.timer !== undefined) return
    const setRepeat = this.options.setRepeat ?? ((fn, ms) => {
      const timer = setInterval(fn, ms)
      timer.unref?.()
      return timer
    })
    this.timer = setRepeat(() => { void this.tick() }, TICK_MS)
  }

  stop() {
    if (this.timer === undefined) return
    ;(this.options.clearRepeat ?? (timer => clearInterval(timer)))(this.timer)
    this.timer = undefined
  }

  /** A turn started or ended: the idle wait starts over. */
  noteActivity() {
    this.idleTicks = 0
  }

  status() {
    return {
      state: this.state,
      reason: this.reason,
      current: this.version,
      latest: this.latest,
      last: this.last,
      lastCheckAt: this.lastCheckAt === null ? null : new Date(this.lastCheckAt).toISOString(),
    }
  }

  /** @param {string} state @param {string | null} [reason] */
  #set(state, reason = null) {
    const changed = this.state !== state || this.reason !== reason
    this.state = state
    this.reason = reason
    if (changed) this.record('update.state', this.status())
  }

  async tick() {
    if (this.state === 'disabled' || this.state === 'installing' || this.busy) return
    this.busy = true
    try {
      if (this.pending === null) {
        if (this.now() >= this.nextCheckAt) await this.#check()
        return
      }
      this.idleTicks = this.options.isIdle() ? this.idleTicks + 1 : 0
      if (this.idleTicks >= IDLE_TICKS_BEFORE_INSTALL) await this.#install(this.pending)
    } catch (error) {
      this.#set('error', error instanceof Error ? error.message : String(error))
    } finally {
      this.busy = false
    }
  }

  async #check() {
    this.lastCheckAt = this.now()
    this.nextCheckAt = this.lastCheckAt + CHECK_INTERVAL_MS
    const eligible = await checkEligibility({ root: this.root, version: this.version, run: this.run })
    if (!eligible.ok) {
      if (this.state !== 'ineligible') this.log(`update: automatic updates are inactive: ${eligible.reason}`)
      this.#set('ineligible', eligible.reason)
      return
    }
    let latest
    try {
      latest = await fetchLatestRelease({ fetchImpl: this.fetchImpl })
    } catch (error) {
      this.#set('error', `release check failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.latest = latest
    if (latest === null || compareVersions(latest, this.version) !== 1) {
      this.#set('current')
      return
    }
    const failed = readUpdateState(this.stateFile).failed
    if (failed !== null && typeof failed === 'object' && failed.version === latest
      && this.now() - Date.parse(String(failed.at)) < FAILED_VERSION_RETRY_MS) {
      this.#set('error', `v${latest} failed to install earlier (${String(failed.error)}); it is retried a day after the failure`)
      return
    }
    if (!this.supervised) {
      if (this.state !== 'available') this.log(`update: v${latest} is available. This companion was started without a supervisor, so it will not install it; start it with "npm run dev" for automatic updates.`)
      this.#set('available', 'no supervisor would restart the companion')
      return
    }
    const fetched = await fetchReleaseTag({ root: this.root, version: latest, run: this.run })
    if (!fetched.ok) {
      this.#set('error', fetched.reason)
      return
    }
    this.pending = latest
    this.idleTicks = 0
    this.log(`update: v${latest} is ready and will be installed once the companion has been idle for about ${Math.round(IDLE_TICKS_BEFORE_INSTALL * TICK_MS / 60_000)} minutes`)
    this.#set('pending')
  }

  /** @param {string} version */
  async #install(version) {
    // The checkout may have changed since the tag was fetched.
    const eligible = await checkEligibility({ root: this.root, version: this.version, run: this.run })
    if (!eligible.ok) {
      this.pending = null
      this.log(`update: v${version} was not installed: ${eligible.reason}`)
      this.#set('ineligible', eligible.reason)
      return
    }
    // Last look before the servers stop; nothing awaits between here and there.
    if (!this.options.isIdle()) {
      this.idleTicks = 0
      return
    }
    this.log(`update: installing v${version} (the companion restarts when it is done)`)
    this.#set('installing')
    this.stop()
    let result
    try {
      await this.options.beforeInstall()
      result = await this.apply({ root: this.root, from: this.version, to: version, run: this.run, log: this.log })
    } catch (error) {
      result = { ok: false, stage: 'install', error: error instanceof Error ? error.message : String(error), rolledBack: false }
    }
    const at = new Date(this.now()).toISOString()
    if (result.ok) this.last = { from: this.version, to: version, at }
    const previous = readUpdateState(this.stateFile)
    try {
      writeUpdateState(this.stateFile, result.ok
        ? { last: this.last }
        : { ...previous, failed: { version, at, stage: result.stage, error: result.error, rolledBack: result.rolledBack } })
    } catch {
      // The outcome is still on stderr.
    }
    this.log(result.ok
      ? `update: v${version} installed; restarting`
      : `update: v${version} failed at ${result.stage} (${result.error}); ${result.rolledBack ? `v${this.version} was restored` : `the checkout may need attention`}; restarting`)
    // The servers are already stopped either way, so the process always restarts.
    this.options.exit(UPDATE_EXIT_CODE)
  }
}
