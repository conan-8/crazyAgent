/**
 * DSH runtime lifecycle and SDK session ownership.
 *
 * The companion owns exactly one DeepSeekHarness subprocess and one active
 * HarnessSession. The harness is warmed at startup so the first user turn
 * does not pay profile boot; a transport failure resets it for the next turn.
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const require = createRequire(import.meta.url)

/** @returns {string} */
function resolveDshBin() {
  const packageFile = require.resolve('@deepseek-ai/dsh/package.json')
  const bin = join(dirname(packageFile), 'lib', 'bin.js')
  if (!existsSync(bin)) throw new Error(`DSH binary is missing at ${bin}`)
  return bin
}

export class DshRunner {
  /**
   * @param {{
   *   bridgeUrl: string,
   *   bridgeToken: string,
   *   dshHome: string,
   *   workspace: string,
   *   processCwd: string,
   *   patchFiles: string[],
   *   provider: string,
   *   model: string,
   *   reasoningEffort?: string,
   *   reasoningPolicy?: string,
   *   maxTokens: number,
   *   apiKey?: string,
   *   credentialsPath: string | undefined,
   *   log: (message: string) => void,
   *   harnessFactory?: (harnessOptions: Record<string, any>) => {
   *     start: () => Promise<void>,
   *     session: (id?: string) => any,
   *     resumeSession: (sessionId: string) => Promise<any>,
   *     close: () => Promise<void>,
   *   },
   * }} options
   */
  constructor(options) {
    this.options = options
    this.log = options.log
    /** @type {DeepSeekHarness | undefined} */
    this.harness = undefined
    /** @type {import('@deepseek-ai/dsh-sdk-client').HarnessSession | undefined} */
    this.session = undefined
    /** @type {Promise<void> | undefined} */
    this.startPromise = undefined
    this.started = false
    /** Session id to restore on the next start after an interrupt. */
    this.resumeSessionId = undefined
    /** Message from the most recent failed resume attempt (diagnostic). */
    this.lastResumeError = undefined
    /** True while a session.run() call is in flight. */
    this.activeRun = false
    /**
     * Bumped whenever the runtime is torn down on purpose (interrupt/reset).
     * A run() that fails after the epoch changed must not reset again — the
     * interrupt already owns the teardown and the resume intent.
     */
    this.stopEpoch = 0
    /** @type {Promise<void> | undefined} */
    this.stopPromise = undefined
  }

  get sessionId() {
    return this.session?.id
  }

  /**
   * Message from the last failed automatic resume, cleared when consumed.
   * @returns {string | undefined}
   */
  consumeResumeError() {
    const error = this.lastResumeError
    this.lastResumeError = undefined
    return error
  }

  async ensureStarted() {
    // A turn may begin right as a stop finishes (the UI sends chat.stopped
    // before the old run() rejection propagates); never start a runtime
    // alongside the one still being torn down.
    const stopping = this.stopPromise
    if (stopping !== undefined) await stopping.catch(() => {})
    if (this.started && this.harness !== undefined && this.session !== undefined) return
    if (this.startPromise !== undefined) {
      await this.startPromise
      return
    }
    this.startPromise = this.#start()
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  async #start() {
    const options = this.options
    const env = {
      ...process.env,
      DSH_BROWSER_BRIDGE_URL: options.bridgeUrl,
      DSH_BROWSER_BRIDGE_TOKEN: options.bridgeToken,
      ...options.apiKey ? { CRAZYAGENT_API_KEY: options.apiKey } : {},
      ...options.reasoningPolicy ? { CRAZYAGENT_REASONING_POLICY: options.reasoningPolicy } : {},
      ...options.credentialsPath === undefined ? {} : { CRAZYAGENT_CREDENTIALS_PATH: options.credentialsPath },
    }
    const harnessOptions = {
      profile: 'sdk-minimal',
      patches: options.patchFiles.map(path => resolve(path)),
      dshHome: resolve(options.dshHome),
      processCwd: resolve(options.processCwd),
      cwd: resolve(options.workspace),
      env,
      initializeTimeoutMs: 30_000,
      provider: options.provider,
      model: options.model,
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      maxTokens: options.maxTokens,
    }
    const harness = options.harnessFactory !== undefined
      ? options.harnessFactory(harnessOptions)
      : new DeepSeekHarness({ dshBin: resolveDshBin(), ...harnessOptions })
    try {
      await harness.start()
    } catch (error) {
      await harness.close().catch(() => {})
      throw error
    }
    this.harness = harness
    this.session = harness.session()
    this.started = true
    // After a user stop the runtime is new but the conversation is not: try to
    // restore the interrupted session before anyone uses this runner again.
    const resumeSessionId = this.resumeSessionId
    if (resumeSessionId !== undefined) {
      this.resumeSessionId = undefined
      try {
        this.session = await harness.resumeSession(resumeSessionId)
        this.lastResumeError = undefined
        this.log(`dsh: resumed session ${resumeSessionId}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.lastResumeError = message
        this.log(`dsh: could not resume session ${resumeSessionId}: ${message}; using a fresh session`)
      }
    }
    this.log(`dsh: ready (provider ${options.provider}, model ${options.model}, session ${this.session.id})`)
  }

  /**
   * @param {Array<Record<string, unknown>>} blocks
   * @param {(notification: { method: string, params: Record<string, unknown> }) => void} [onNotification]
   */
  async run(blocks, onNotification) {
    await this.ensureStarted()
    const session = this.session
    if (session === undefined) throw new Error('DSH session is not initialized')
    const stopEpoch = this.stopEpoch
    this.activeRun = true
    try {
      return await session.run(blocks, onNotification === undefined ? undefined : { onNotification })
    } catch (error) {
      // interrupt() already tore the runtime down; resetting here would also
      // drop the captured resumeSessionId, losing the conversation.
      if (this.stopEpoch !== stopEpoch) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/transport|closed|exited|disposed|spawn|initialize|handshake/iu.test(message)) {
        await this.reset()
      }
      throw error
    } finally {
      this.activeRun = false
    }
  }

  /**
   * Abort the active turn. DSH SDK 0.2.1-rc.2 exposes no turn-cancel RPC, so
   * the only reliable cancellation is tearing down the runtime subprocess:
   * the pending `session.run()` rejects with a transport-closed error. The
   * interrupted session id is remembered so the next `ensureStarted()` starts
   * a fresh runtime and resumes that conversation.
   *
   * Safe to call when idle: nothing is torn down and the current session is
   * kept. Returns `{sessionId, interrupted}`.
   * @returns {Promise<{sessionId: string | undefined, interrupted: boolean}>}
   */
  async interrupt() {
    const sessionId = this.sessionId
    const harness = this.harness
    if (harness === undefined || sessionId === undefined || !this.activeRun) {
      return { sessionId, interrupted: false }
    }
    this.stopEpoch += 1
    this.resumeSessionId = sessionId
    const stopping = this.#teardownHarness()
    this.stopPromise = stopping
    try {
      await stopping
      this.log(`dsh: interrupted session ${sessionId}; the next turn resumes it`)
      return { sessionId, interrupted: true }
    } finally {
      if (this.stopPromise === stopping) this.stopPromise = undefined
    }
  }

  /** Start a fresh DSH session without restarting the runtime. */
  async newSession() {
    // A new chat deliberately abandons the interrupted conversation, so do not
    // pay for (or log an error from) resuming it on the next start.
    this.resumeSessionId = undefined
    await this.ensureStarted()
    if (this.harness === undefined) throw new Error('DSH runtime is not available')
    this.resumeSessionId = undefined
    this.session = this.harness.session()
    return this.session.id
  }

  /**
   * Best-effort restoration of a persisted session after a companion restart.
   * @param {string} sessionId
   */
  async resume(sessionId) {
    if (this.harness === undefined) await this.ensureStarted()
    if (this.harness === undefined) throw new Error('DSH runtime is not available')
    this.session = await this.harness.resumeSession(sessionId)
    this.resumeSessionId = undefined
    return this.session.id
  }

  async reset() {
    this.resumeSessionId = undefined
    this.lastResumeError = undefined
    this.stopEpoch += 1
    await this.#teardownHarness()
  }

  async close() {
    await this.reset()
  }

  /**
   * Close the runtime without clearing the resume intent: interrupt() has
   * already captured the session id it wants the next start to restore.
   */
  async #teardownHarness() {
    const harness = this.harness
    this.harness = undefined
    this.session = undefined
    this.started = false
    if (harness !== undefined) {
      await harness.close().catch(error => this.log(`dsh: close failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
}