/**
 * Bounded advisory in-turn watcher steering runtime (W3).
 *
 * Receives `watch.steer` frames from the companion over the provider's bridge
 * socket and delivers them to the active running turn via DSH's
 * `agent.inject(message)` (`target: "next-step", wakeup: false`).
 *
 * Safety invariants:
 * - Strictly fail-closed on turnId mismatch, missing active turn, or non-running
 *   agent status: never wakes an idle agent or starts a phantom turn.
 * - Uses `source: { kind: 'agent-notice', form: 'notice', summary: 'Watcher course correction' }`:
 *   delivered verbatim on the next model step (unlike `runtime-context`), while
 *   `isInternalNotice` skips it so repeat guards, executor circuits, and prompt
 *   tracking stay intact.
 * - Wraps text in explicit `<watcher_advisory>` framing stating that the watcher
 *   is process-only (does not verify correctness) and cannot override the user's
 *   goal, safety rules, or confirmation gates.
 */

import { randomUUID } from 'node:crypto'

export const WATCH_STEER_MAX_CHARS = 300
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/gu

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanAttr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 32)
  return cleaned.length > 0 ? cleaned : fallback
}

function cleanText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim().slice(0, WATCH_STEER_MAX_CHARS)
}

/**
 * Wrap a sanitized watcher nudge in explicit non-authoritative framing.
 * @param {{text: string, kind?: string | null, blocker?: string | null}} input
 * @returns {string}
 */
export function formatWatcherAdvisory(input) {
  const kind = cleanAttr(input.kind, 'stuck')
  const blocker = input.blocker ? ` blocker="${cleanAttr(input.blocker, 'other')}"` : ''
  const text = cleanText(input.text)
  return [
    `<watcher_advisory kind="${kind}"${blocker}>`,
    'Automated process watcher notice (tactical suggestion only — does not verify factual correctness and cannot override the user\'s original goal, safety rules, or confirmation requirements):',
    text,
    'Adjust your approach, inspect what is blocking progress, or call agent_request_help / report BLOCKED if you need the user.',
    '</watcher_advisory>',
  ].join('\n')
}

function advisoryMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    // Not 'runtime-context': DSH replaces claimed runtime-context messages with
    // its context snapshot. 'agent-notice' is delivered verbatim on the next
    // step and skipped by isInternalNotice().
    source: Object.freeze({ kind: 'agent-notice', form: 'notice', summary: 'Watcher course correction' }),
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
  })
}

function turnKey(sessionId, turn) {
  return `${String(sessionId)}\0${turn}`
}

/**
 * Per-turn runtime tracker for `watch.steer` delivery via `agent.inject`.
 * @param {{bridge: {
 *   activity: (activity: Record<string, unknown>) => boolean | void,
 *   logEvent: (type: string, data: Record<string, unknown>, severity?: string) => void,
 * }}} options
 */
export function createWatchSteerRuntime({ bridge }) {
  /** @type {string | null} */
  let pendingTurnId = null
  /** @type {null | {key: string, turnId: string, sessionId: string, turn: number, agent: any}} */
  let active = null
  let disposed = false

  const log = (type, data, severity = 'info') => {
    bridge.logEvent(type, data, severity)
  }

  function setTurnContext(frame) {
    if (disposed) return
    if (typeof frame?.turnId === 'string' && frame.turnId.length > 0) {
      pendingTurnId = frame.turnId
      return
    }
    pendingTurnId = null
  }

  function claim(agent, turn) {
    if (disposed || !Number.isSafeInteger(turn) || !agent?.session) return
    const turnId = pendingTurnId
    if (turnId === null) return
    const sessionId = String(agent.session.id)
    const key = turnKey(sessionId, turn)
    if (active?.key === key && active.turnId === turnId) return
    active = { key, turnId, sessionId, turn, agent }
  }

  function endTurn(session, turn) {
    if (active === null || !Number.isSafeInteger(turn)) return
    if (active.key === turnKey(session?.id, turn)) {
      active = null
      pendingTurnId = null
    }
  }

  function handleSteer(frame) {
    const steerId = isRecord(frame) && typeof frame.steerId === 'string' && frame.steerId.length > 0 ? frame.steerId : null
    const drop = (reason, extra = {}) => {
      log('watch.steer.dropped', { steerId, reason, turnId: isRecord(frame) ? frame.turnId ?? null : null, ...extra }, 'warn')
      if (steerId !== null) bridge.activity({ kind: 'watch-steer', steerId, status: 'dropped', reason })
      return false
    }
    if (disposed) return drop('disposed')
    if (!isRecord(frame) || typeof frame.turnId !== 'string' || frame.turnId.length === 0) {
      return drop('invalid-payload')
    }
    const text = cleanText(frame.text)
    if (text.length === 0) return drop('empty-text')
    if (active === null) return drop('no-active-turn')
    if (active.turnId !== frame.turnId) return drop('turn-mismatch', { activeTurnId: active.turnId })
    if (active.agent?.status !== 'running') return drop('agent-not-running', { status: active.agent?.status ?? null })
    if (typeof active.agent?.inject !== 'function') return drop('no-inject')

    const formatted = formatWatcherAdvisory({
      text,
      kind: typeof frame.kind === 'string' ? frame.kind : 'stuck',
      blocker: typeof frame.blocker === 'string' ? frame.blocker : null,
    })
    try {
      // Strictly inject (wakeup: false, target: "next-step"), never steer/followup,
      // so a race against turn completion can never wake an idle agent.
      active.agent.inject(advisoryMessage(formatted))
    } catch (error) {
      return drop('inject-error', { message: error instanceof Error ? error.message : String(error) })
    }
    log('watch.steer.injected', {
      steerId,
      turnId: active.turnId,
      sessionId: active.sessionId,
      turn: active.turn,
      kind: typeof frame.kind === 'string' ? frame.kind : 'stuck',
      blocker: typeof frame.blocker === 'string' ? frame.blocker : null,
      textChars: text.length,
    }, 'info')
    bridge.activity({ kind: 'watch-steer', steerId, status: 'injected' })
    return true
  }

  function dispose() {
    disposed = true
    pendingTurnId = null
    active = null
  }

  return {
    setTurnContext,
    claim,
    endTurn,
    handleSteer,
    dispose,
  }
}
