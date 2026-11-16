import test from 'node:test'
import assert from 'node:assert/strict'
import { DshRunner } from '../dsh.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await sleep(5)
  }
}

function deferred() {
  const box = {}
  box.promise = new Promise((resolve, reject) => {
    box.resolve = resolve
    box.reject = reject
  })
  return box
}

/**
 * Minimal stand-in for DeepSeekHarness: sessions record runs as deferred
 * promises, close() rejects them like a real transport teardown, and resume
 * can be made to fail. No subprocess, timers, or disk access.
 */
class FakeHarness {
  /**
   * @param {string} name
   * @param {Set<string>} [store] shared persisted-session store; when given,
   *   resumeSession enforces the SDK contract: a target this runtime still
   *   owns rejects with 'already open or opening', and a target absent from
   *   the store rejects as missing. A fresh harness (new process) owns nothing.
   */
  constructor(name = 'fake', store = undefined) {
    this.name = name
    this.store = store
    this.openIds = new Set()
    this.started = false
    this.closed = false
    this.sessions = []
    this.runs = []
    this.resumed = []
    this.failResume = undefined
    this.closeCount = 0
  }

  #createSession(id) {
    const harness = this
    const session = {
      id,
      run(blocks, options) {
        const run = deferred()
        run.blocks = blocks
        run.options = options
        harness.runs.push(run)
        return run.promise
      },
    }
    this.sessions.push(session)
    this.openIds.add(id)
    this.store?.add(id)
    return session
  }

  async start() {
    this.started = true
  }

  session() {
    return this.#createSession(`${this.name}-session-${this.sessions.length + 1}`)
  }

  async resumeSession(sessionId) {
    this.resumed.push(sessionId)
    const failure = this.failResume instanceof Set
      ? (this.failResume.has(sessionId) ? 'session history is missing' : undefined)
      : this.failResume
    if (failure !== undefined) throw new Error(failure)
    if (this.openIds.has(sessionId)) throw new Error(`SDK session is already open or opening: ${sessionId}`)
    if (this.store !== undefined && !this.store.has(sessionId)) throw new Error(`session is missing or unreadable: ${sessionId}`)
    return this.#createSession(sessionId)
  }

  async close() {
    this.closed = true
    this.closeCount += 1
    for (const run of this.runs.splice(0)) run.reject(new Error('Transport closed: fake harness torn down'))
  }
}

function createRunner(harnessFactory) {
  return new DshRunner({
    bridgeUrl: 'ws://127.0.0.1:1/bridge',
    bridgeToken: 'test-token',
    dshHome: '/tmp/crazyagent-dsh-test-home',
    workspace: '/tmp/crazyagent-dsh-test-workspace',
    processCwd: '/tmp',
    patchFiles: [],
    provider: 'openrouter',
    model: 'fake/model',
    maxTokens: 1024,
    log: () => {},
    harnessFactory,
  })
}

/** Start one run and wait until the fake session has received it. */
async function startFakeRun(runner, harness, text = 'hello') {
  const promise = runner.run([{ type: 'text', text }])
  const guarded = promise.catch(error => error)
  await waitFor(() => harness.runs.length > 0)
  return { promise, guarded, run: harness.runs[0] }
}

test('interrupt during a run closes the runtime, rejects the run, and saves the session id', async () => {
  const harness = new FakeHarness('a')
  let current = harness
  const runner = createRunner(() => current)
  await runner.ensureStarted()
  const sessionId = runner.sessionId
  assert.equal(typeof sessionId, 'string')

  const { guarded } = await startFakeRun(runner, harness)
  assert.equal(runner.activeRun, true)

  const result = await runner.interrupt()
  assert.deepEqual(result, { sessionId, interrupted: true })
  const error = await guarded
  assert.match(error.message, /transport closed/i)

  assert.equal(harness.closed, true)
  assert.equal(runner.harness, undefined)
  assert.equal(runner.session, undefined)
  assert.equal(runner.sessionId, undefined)
  assert.equal(runner.resumeSessionId, sessionId)
  assert.equal(runner.activeRun, false)
})

test('the next start resumes the interrupted session and runs on it', async () => {
  const harnessA = new FakeHarness('a')
  let current = harnessA
  const runner = createRunner(() => current)
  await runner.ensureStarted()
  const sessionId = runner.sessionId
  const first = await startFakeRun(runner, harnessA)
  await runner.interrupt()
  await first.guarded

  const harnessB = new FakeHarness('b')
  current = harnessB
  await runner.ensureStarted()
  assert.deepEqual(harnessB.resumed, [sessionId])
  assert.equal(runner.sessionId, sessionId)
  assert.equal(runner.resumeSessionId, undefined)
  assert.equal(runner.consumeResumeError(), undefined)

  const nextRun = runner.run([{ type: 'text', text: 'again' }])
  const guardedNext = nextRun.catch(error => error)
  await waitFor(() => harnessB.runs.length > 0)
  assert.equal(harnessB.runs[0].blocks[0].text, 'again')
  harnessB.runs[0].resolve({ sessionId, finalResponse: 'ok', events: [] })
  const result = await guardedNext
  assert.equal(result.sessionId, sessionId)
  assert.equal(result.finalResponse, 'ok')
})

test('a failed resume falls back to the fresh session without throwing', async () => {
  const harnessA = new FakeHarness('a')
  let current = harnessA
  const runner = createRunner(() => current)
  await runner.ensureStarted()
  const interruptedId = runner.sessionId
  const first = await startFakeRun(runner, harnessA)
  await runner.interrupt()
  await first.guarded

  const harnessB = new FakeHarness('b')
  harnessB.failResume = 'session history is missing'
  current = harnessB
  await runner.ensureStarted()

  assert.deepEqual(harnessB.resumed, [interruptedId])
  assert.equal(runner.resumeSessionId, undefined)
  assert.notEqual(runner.sessionId, interruptedId)
  assert.equal(runner.sessionId, harnessB.sessions[0].id)
  assert.match(runner.consumeResumeError(), /session history is missing/)
  assert.equal(runner.consumeResumeError(), undefined)
})

test('interrupt when idle is a no-op and keeps the current runtime', async () => {
  const harness = new FakeHarness('a')
  const runner = createRunner(() => harness)

  assert.deepEqual(await runner.interrupt(), { sessionId: undefined, interrupted: false })
  assert.equal(harness.started, false, 'interrupt must not warm the runtime')

  await runner.ensureStarted()
  const sessionId = runner.sessionId
  const result = await runner.interrupt()
  assert.deepEqual(result, { sessionId, interrupted: false })
  assert.equal(harness.closed, false)
  assert.equal(runner.sessionId, sessionId)
  assert.equal(runner.resumeSessionId, undefined)
})

test('in-process resume of an earlier chat restarts the runtime and restores it (phone Continue)', async () => {
  const store = new Set()
  const harnessA = new FakeHarness('a', store)
  let current = harnessA
  const runner = createRunner(() => current)
  await runner.ensureStarted()
  const firstChat = runner.sessionId
  // New chat leaves the earlier SDK session open — the SDK has no per-session
  // close RPC, so the earlier chat stays 'already owned' in this process.
  const secondChat = await runner.newSession()
  assert.notEqual(secondChat, firstChat)
  assert.ok(harnessA.openIds.has(firstChat))

  const harnessB = new FakeHarness('b', store)
  current = harnessB
  const resumed = await runner.resume(firstChat)
  assert.equal(resumed, firstChat, 'resume returns the session ID string')
  assert.equal(runner.sessionId, firstChat)
  assert.equal(runner.session.id, firstChat, 'the restored session is the runner current session')
  assert.equal(harnessA.closed, true, 'the owning runtime was torn down')
  assert.ok(harnessB.resumed.includes(firstChat), 'the fresh runtime restored it from disk')
  assert.equal(runner.resumeSessionId, undefined)

  // The restored session runs prompts.
  const next = runner.run([{ type: 'text', text: 'continue the old chat' }])
  const guarded = next.catch(error => error)
  await waitFor(() => harnessB.runs.length > 0)
  harnessB.runs[0].resolve({ sessionId: firstChat, finalResponse: 'ok', events: [] })
  assert.equal((await guarded).sessionId, firstChat)
})

test('in-process resume of an unowned persisted session needs no restart', async () => {
  const store = new Set(['saved-chat'])
  const harness = new FakeHarness('a', store)
  const runner = createRunner(() => harness)
  await runner.ensureStarted()
  const current = runner.sessionId
  const resumed = await runner.resume('saved-chat')
  assert.equal(resumed, 'saved-chat')
  assert.equal(runner.sessionId, 'saved-chat')
  assert.equal(harness.closed, false, 'an unowned target resumes in place')
  assert.equal(harness.closeCount, 0)
  assert.notEqual(runner.sessionId, current)
})

test('a failed in-process restore keeps the current chat and rethrows', async () => {
  const store = new Set()
  const harnessA = new FakeHarness('a', store)
  let current = harnessA
  const runner = createRunner(() => current)
  await runner.ensureStarted()
  const firstChat = runner.sessionId
  const currentChat = await runner.newSession()

  const harnessB = new FakeHarness('b', store)
  harnessB.failResume = new Set([firstChat])
  current = harnessB
  await assert.rejects(() => runner.resume(firstChat), /session history is missing/)
  assert.equal(harnessA.closed, true)
  // The current chat is persisted, so it is restored on the fresh runtime.
  assert.equal(runner.sessionId, currentChat, 'the current chat survives the failed restore')
  assert.ok(harnessB.resumed.includes(currentChat))
})

test('the post-restart resume path still works and clears a pending interrupt intent', async () => {
  const store = new Set()
  const harnessA = new FakeHarness('a', store)
  let current = harnessA
  const runner = createRunner(() => current)
  await runner.ensureStarted()
  const saved = runner.sessionId
  const first = await startFakeRun(runner, harnessA)
  await runner.interrupt()
  await first.guarded
  assert.equal(runner.resumeSessionId, saved)

  // A fresh process (harness undefined) resumes the persisted chat directly.
  const harnessB = new FakeHarness('b', store)
  current = harnessB
  const resumed = await runner.resume(saved)
  assert.equal(resumed, saved)
  assert.equal(runner.sessionId, saved)
  assert.equal(runner.resumeSessionId, undefined, 'the explicit resume superseded the interrupt intent')
  assert.deepEqual(harnessB.resumed, [saved], 'no extra fresh-session resume attempt')
})

test('reset and close clear the saved resume state', async () => {
  const harnessA = new FakeHarness('a')
  let current = harnessA
  const runner = createRunner(() => current)
  await runner.ensureStarted()
  const first = await startFakeRun(runner, harnessA)
  await runner.interrupt()
  await first.guarded
  const firstResume = runner.resumeSessionId
  assert.equal(typeof firstResume, 'string')

  await runner.reset()
  assert.equal(runner.resumeSessionId, undefined)
  assert.equal(runner.harness, undefined)

  current = new FakeHarness('b')
  await runner.ensureStarted()
  const second = await startFakeRun(runner, current)
  await runner.interrupt()
  await second.guarded
  assert.equal(runner.resumeSessionId, current.sessions[0].id)
  await runner.close()
  assert.equal(runner.resumeSessionId, undefined)
  assert.equal(runner.harness, undefined)
})