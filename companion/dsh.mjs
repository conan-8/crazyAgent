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
  }

  get sessionId() {
    return this.session?.id
  }

  async ensureStarted() {
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
    const harness = new DeepSeekHarness({
      dshBin: resolveDshBin(),
      profile: 'sdk-minimal',
      patches: options.patchFiles.map(path => resolve(path)),
      dshHome: resolve(options.dshHome),
      processCwd: resolve(options.processCwd),
      cwd: resolve(options.workspace),
      env,
      initializeTimeoutMs: 30_000,
      provider: options.provider,
      model: options.model,
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: /** @type {any} */ (options.reasoningEffort) },
      maxTokens: options.maxTokens,
    })
    try {
      await harness.start()
    } catch (error) {
      await harness.close().catch(() => {})
      throw error
    }
    this.harness = harness
    this.session = harness.session()
    this.started = true
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
    try {
      return await session.run(blocks, onNotification === undefined ? undefined : { onNotification })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/transport|closed|exited|disposed|spawn|initialize|handshake/iu.test(message)) {
        await this.reset()
      }
      throw error
    }
  }

  /** Start a fresh DSH session without restarting the runtime. */
  async newSession() {
    await this.ensureStarted()
    if (this.harness === undefined) throw new Error('DSH runtime is not available')
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
    return this.session.id
  }

  async reset() {
    const harness = this.harness
    this.harness = undefined
    this.session = undefined
    this.started = false
    if (harness !== undefined) {
      await harness.close().catch(error => this.log(`dsh: close failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  async close() {
    await this.reset()
  }
}