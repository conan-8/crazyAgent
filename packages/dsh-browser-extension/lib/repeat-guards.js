/**
 * Repeat/loop guards and the Docs failure circuit, split out of index.js for
 * D1 (2026-11-16): a pure move with no behavior change. createCallGuard
 * fingerprints each call (canonicalJson) and refuses identical mutating
 * repeats past maxRepeatedCalls, identical observation repeats past
 * maxObservationRepeats, and unmodified navigation-key repeats past
 * maxNavigationRepeats; three consecutive failed Docs replacement attempts
 * open the DOCS_FAILURE_CIRCUIT for the rest of the turn. Fingerprints reset
 * with the session/user-message turn; internal continuation notices never
 * reset them. toolResultText flattens a durable tool result for the circuit's
 * docs.status readback and the provider's no-progress tracking.
 */

import { isRecord, normalizeKeyChord } from './validate.js'

/**
 * Canonical JSON for a tool-call fingerprint. Object keys are sorted so
 * `{b:2,a:1}` and `{a:1,b:2}` fingerprint as the same call.
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const json = JSON.stringify(value)
  return json === undefined ? 'null' : json
}

/**
 * Tools whose identical repeat is legitimate. These only observe, so repeating
 * one is how the agent watches a page change over time: a screenshot after an
 * async render, the same wait_for for text that appears late, a read_text after
 * scrolling. Counting those as loops blocked real work in the 2026-10-23 run —
 * `browser_screenshot {"detail":"fast"}` was refused at the third repeat while
 * the agent was verifying a Google Docs rename it had no other way to see.
 */
const OBSERVATION_TOOLS = new Set(['browser_screenshot', 'browser_read_text', 'browser_docs_read', 'browser_tabs', 'browser_places', 'browser_wait_for', 'browser_downloads'])

/**
 * Unmodified keys that only move focus, dismiss a surface, or move a caret.
 * Keys that commit, destroy, select, or use any modifier keep the strict
 * allowance because repeating them can edit the document.
 */
const NAVIGATION_KEYS = new Set([
  'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
])

/**
 * @param {string} toolName
 * @param {unknown} args
 * @returns {boolean}
 */
function isObservationCall(toolName, args) {
  return OBSERVATION_TOOLS.has(toolName)
    || (toolName === 'browser_table' && isRecord(args) && args.action === 'read')
    || (toolName === 'browser_docs_table' && isRecord(args) && args.action === 'read')
    || (toolName === 'browser_find' && isRecord(args) && args.reveal !== true)
}

/**
 * Whether a call is unmodified keyboard navigation. Composite chords and
 * explicit modifier arrays use the same normalization as tool execution.
 * @param {string} toolName
 * @param {unknown} args
 * @returns {boolean}
 */
function isNavigationKeyCall(toolName, args) {
  if (toolName !== 'browser_press_key' || !isRecord(args)) return false
  try {
    const normalized = normalizeKeyChord(args.key, args.modifiers)
    return NAVIGATION_KEYS.has(normalized.key)
      && (normalized.modifiers === undefined || normalized.modifiers.length === 0)
  } catch {
    return false
  }
}

/**
 * Guard against runaway repeats. There is deliberately NO per-turn call limit:
 * a real task (compiling ten university prompts, renaming ten document tabs)
 * legitimately needs dozens of round trips, and refusing call 81 threw away the
 * turn's working state — in the 2026-10-23 run the user had to say "continue"
 * five times, and every continuation restarted from a state the model could only
 * describe in words instead of verify, which is what let the document get
 * corrupted.
 *
 * What remains is a correctness guard, not a budget: an *identical* mutating
 * call repeated past `maxRepeatedCalls` is a bug (a double click, a re-typed
 * paragraph), while an identical observation call is normal and gets the much
 * larger `maxObservationRepeats`. Fingerprints reset with the session/user-message
 * turn, and a different successful mutation starts a new repeat series.
 * @param {{maxRepeatedCalls?: number, maxObservationRepeats?: number, maxNavigationRepeats?: number, logEvent: (type: string, data: unknown, severity?: string) => void}} options
 * @returns {{setTurn: (turn: unknown) => void, beginCall: (toolName: string, args: unknown) => void, endCall: (toolName: string, args: unknown, error: Error|undefined, result: Record<string, any>|undefined) => void}}
 */
function createCallGuard(options) {
  const maxRepeats = Number.isFinite(Number(options.maxRepeatedCalls))
    ? Math.max(1, Math.floor(Number(options.maxRepeatedCalls)))
    : 3
  const maxObservationRepeats = Number.isFinite(Number(options.maxObservationRepeats))
    ? Math.max(maxRepeats, Math.floor(Number(options.maxObservationRepeats)))
    : 30
  const maxNavigationRepeats = Number.isFinite(Number(options.maxNavigationRepeats))
    ? Math.max(maxRepeats, Math.floor(Number(options.maxNavigationRepeats)))
    : 10
  let turn = null
  /** call count for logs only — nothing is refused on it */
  let calls = 0
  let docsFailures = 0
  /** @type {Map<string, number>} */
  let observationFingerprints = new Map()
  /** @type {Map<string, number>} */
  let mutationFingerprints = new Map()
  let lastMutationFingerprint
  let lastMutationSucceeded = false

  /**
   * Start counting a new session/user-message turn, resetting repeat state.
   * @param {unknown} nextTurn
   */
  const setTurn = nextTurn => {
    if (nextTurn === undefined || nextTurn === null) return
    const key = String(nextTurn)
    if (key === turn) return
    turn = key
    calls = 0
    docsFailures = 0
    observationFingerprints = new Map()
    mutationFingerprints = new Map()
    lastMutationFingerprint = undefined
    lastMutationSucceeded = false
  }

  const docsReplacementCall = toolName => toolName === 'browser_docs_replace'

  const semanticCall = (toolName, args) => {
    const record = isRecord(args) ? args : {}
    const singleton = Array.isArray(record.edits) && record.edits.length === 1 && isRecord(record.edits[0])
      ? record.edits[0] : undefined
    if (toolName === 'browser_docs_replace' && singleton !== undefined) {
      return { toolName: 'browser_docs_replace_text', args: { text: singleton.text, replacement: singleton.replacement } }
    }
    if (toolName === 'browser_docs_format' && singleton !== undefined) {
      return { toolName: 'browser_docs_format', args: singleton }
    }
    return { toolName, args }
  }

  /**
   * Count one tool invocation and fail an identical mutating repeat.
   * @param {string} toolName
   * @param {unknown} args
   */
  const beginCall = (toolName, args) => {
    calls += 1
    const observation = isObservationCall(toolName, args)
    const navigation = !observation && isNavigationKeyCall(toolName, args)
    const limit = observation ? maxObservationRepeats : navigation ? maxNavigationRepeats : maxRepeats
    const semantic = semanticCall(toolName, args)
    const fingerprint = `${semantic.toolName}\u0000${canonicalJson(semantic.args)}`
    if (!observation && lastMutationSucceeded && fingerprint !== lastMutationFingerprint) mutationFingerprints.clear()
    const fingerprints = observation ? observationFingerprints : mutationFingerprints
    const repeats = (fingerprints.get(fingerprint) ?? 0) + 1
    fingerprints.set(fingerprint, repeats)
    if (!observation) {
      lastMutationFingerprint = fingerprint
      lastMutationSucceeded = false
    }
    if (repeats > limit) {
      options.logEvent('tool.loop.detected', { turn, tool: toolName, semanticTool: semantic.toolName, repeats: repeats - 1, max: limit, observation, navigation, args: canonicalJson(args).slice(0, 400) }, 'warn')
      if (semantic.toolName === 'browser_docs_replace_text') {
        throw new Error(`LOOP_DETECTED — the same Google Docs replacement was already attempted ${limit} times this turn without progress. Do not switch replacement tools, batching modes, or targets. Stop and report the requested edit as blocked.`)
      }
      throw new Error(observation
        ? `LOOP_DETECTED — ${toolName} was already called ${limit} times this turn with identical arguments and the page still shows nothing new. Change what you are looking for: pass different arguments (a different detail, offset, or wait condition), scroll or switch to the right tab first, or act on the page instead of observing it again.`
        : `LOOP_DETECTED — ${toolName} was already called ${limit} times this turn with identical arguments, and repeating it did not help. Change the arguments or approach (different label/point/strategy), read the page, or answer with what you have.`)
    }
    if (docsReplacementCall(toolName, args) && docsFailures >= 3) {
      options.logEvent('docs.failure.circuit', { turn, tool: toolName, failures: docsFailures, max: 3 }, 'warn')
      throw new Error('DOCS_FAILURE_CIRCUIT — three consecutive Docs replacement attempts failed. Do not try another target, tool, or canvas workaround. Stop and report the requested edit as blocked.')
    }
  }

  const endCall = (toolName, args, error, result) => {
    const record = isRecord(args) ? args : {}
    const edits = Array.isArray(record.edits) ? record.edits : []
    const manyAction = toolName === 'browser_docs_replace' && edits.length > 1 ? 'replace_many'
      : toolName === 'browser_docs_format' && (edits.length > 1 || edits.some(edit => isRecord(edit)
        && (edit.occurrence !== undefined || edit.color !== undefined || edit.highlight !== undefined))) ? 'format_many' : undefined
    const docsAction = result?.docs?.action ?? manyAction
    const docsStatus = result?.docs?.status ?? /(?:^|\n)docs\.status=([^\s]+)/u.exec(toolResultText(result))?.[1]
    const incompleteBatch = (docsAction === 'replace_many' && docsStatus !== 'completed')
      || (docsAction === 'format_many' && docsStatus !== 'completed' && docsStatus !== 'already_applied')
    if (!isObservationCall(toolName, args)) lastMutationSucceeded = !error && !incompleteBatch
    if (!docsReplacementCall(toolName, args)) return
    if (!error && !incompleteBatch) {
      docsFailures = 0
      return
    }
    docsFailures += 1
  }

  return { setTurn, beginCall, endCall }
}

/**
 * Plain text of one durable tool-result message, flattening nested blocks.
 * @param {unknown} message
 * @returns {string}
 */
function toolResultText(message) {
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  const parts = []
  const visit = blocks => {
    for (const block of blocks) {
      if (!isRecord(block)) continue
      if (typeof block.text === 'string') parts.push(block.text)
      else if (Array.isArray(block.content)) visit(block.content)
    }
  }
  visit(message.content)
  return parts.join('\n')
}

export { NAVIGATION_KEYS, createCallGuard, toolResultText }
