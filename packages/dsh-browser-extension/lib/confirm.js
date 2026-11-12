/**
 * agent_request_confirmation: the opt-in "ask before an irreversible action"
 * signal (plan B9a). Registered only for turns where the companion's
 * `confirmIrreversible` setting is on, the same conditional way `browser_plan`
 * is registered only for explicitly armed /plan turns. The standing tool count
 * is unchanged.
 *
 * Like agent_request_help, the tool touches nothing in the browser. It sends a
 * `confirm-request` activity over the provider's own bridge connection; the
 * companion, not the model's final text, decides that the chat is now waiting
 * for the user's Approve/Deny. There is no pause/resume: the model is told to
 * end its turn, and the answer arrives as the next turn.
 *
 * The request deliberately does not ride the durable `turn/end` session event:
 * DSH deep-freezes committed events, so a listener cannot annotate them.
 */

import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'

export const CONFIRM_ACTION_MAX_CHARS = 200
export const CONFIRM_TARGET_MAX_CHARS = 200

export const AGENT_CONFIRM_TOOL = Object.freeze({
  name: 'agent_request_confirmation',
  rawName: 'agent_request_confirmation',
  description: `Ask the user to approve or deny one irreversible action, then end your turn. Available only because the user enabled "Ask before submitting, sending, paying, or deleting". Use it before an action that submits for grading or review, sends a message, pays or places an order, deletes, or publishes. action says what will happen (max ${CONFIRM_ACTION_MAX_CHARS} characters, for example "Submit the assignment for grading"); target names the control or page (max ${CONFIRM_TARGET_MAX_CHARS} characters). It takes no browser action and returns no view. After calling it, do not perform the action in this turn: finish with a short final message. The user's Approve or Deny arrives as the next turn; only an approve for the same action authorizes it.`,
  inputSchema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['action', 'target'],
    properties: Object.freeze({
      action: Object.freeze({ type: 'string', minLength: 1, maxLength: CONFIRM_ACTION_MAX_CHARS, description: 'What will happen, in one plain sentence.' }),
      target: Object.freeze({ type: 'string', minLength: 1, maxLength: CONFIRM_TARGET_MAX_CHARS, description: 'The control or page the action applies to.' }),
    }),
  }),
})

function confirmError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/**
 * Strict argument check; the provider schema is advisory for some routes.
 * @param {unknown} args
 * @returns {{action: string, target: string}}
 */
export function parseConfirmRequest(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw confirmError('CONFIRM_INVALID', 'agent_request_confirmation takes {action, target}')
  }
  const unknown = Object.keys(args).filter(key => key !== 'action' && key !== 'target')
  if (unknown.length > 0) throw confirmError('CONFIRM_INVALID', `unknown field ${unknown[0]}`)
  const { action, target } = /** @type {Record<string, unknown>} */ (args)
  if (typeof action !== 'string' || action.trim().length === 0) {
    throw confirmError('CONFIRM_INVALID', 'action must say what will happen, for example "Submit the assignment for grading"')
  }
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw confirmError('CONFIRM_INVALID', 'target must name the control or page, for example "Submit for Grading button"')
  }
  const trimmedAction = action.trim()
  const trimmedTarget = target.trim()
  if (trimmedAction.length > CONFIRM_ACTION_MAX_CHARS) {
    throw confirmError('CONFIRM_INVALID', `action must be at most ${CONFIRM_ACTION_MAX_CHARS} characters`)
  }
  if (trimmedTarget.length > CONFIRM_TARGET_MAX_CHARS) {
    throw confirmError('CONFIRM_INVALID', `target must be at most ${CONFIRM_TARGET_MAX_CHARS} characters`)
  }
  return { action: trimmedAction, target: trimmedTarget }
}

function turnKey(sessionId, turn) {
  return `${String(sessionId)}\0${turn}`
}

/**
 * Conditional per-turn registration, mirroring plan-runtime: the companion
 * arms a turn with a `confirm.mode` frame, the tool is registered when that
 * turn claims the agent, and it is retired at turn end.
 * @param {{ctx: any, bridge: {
 *   activity: (activity: Record<string, unknown>) => boolean | void,
 *   logEvent: (type: string, data: Record<string, unknown>, severity?: string) => void,
 * }}} options
 */
export function createConfirmRuntime({ ctx, bridge }) {
  let pendingTurnId = null
  let active = null
  let disposed = false

  const log = (type, data, severity = 'info') => {
    bridge.logEvent(type, data, severity)
  }

  function cleanup(entry, reason) {
    if (active === entry) active = null
    if (!entry.unregister) return
    try {
      entry.unregister()
    } catch (error) {
      log('confirm.mode.cleanup_error', {
        turnId: entry.turnId,
        message: error instanceof Error ? error.message : String(error),
      }, 'warn')
    }
    entry.unregister = null
    if (reason) log('confirm.mode.ended', { turnId: entry.turnId, reason })
  }

  function setMode(frame) {
    if (disposed) return
    if (frame?.enabled !== true || typeof frame.turnId !== 'string' || frame.turnId.length === 0) {
      pendingTurnId = null
      return
    }
    if (active?.turnId === frame.turnId) return
    pendingTurnId = frame.turnId
  }

  /**
   * Tool body. Requires a calling session, so a request always belongs to a
   * running turn; the companion ties it to its own current turn ID.
   * @param {unknown} args
   * @param {{agent?: {session?: {id?: unknown}}}} exec
   */
  function request(args, exec) {
    const request = parseConfirmRequest(args)
    const sessionId = exec?.agent?.session?.id
    if (sessionId === undefined || sessionId === null) {
      throw confirmError('CONFIRM_NO_ACTIVE_TURN', 'agent_request_confirmation can only be called from a running turn')
    }
    const delivered = bridge.activity({ kind: 'confirm-request', action: request.action, target: request.target }) === true
    // Action and target are user-facing chat content, not diagnostics: log sizes only.
    bridge.logEvent('confirm.requested', { sessionId: String(sessionId), actionChars: request.action.length, targetChars: request.target.length, delivered }, delivered ? 'info' : 'warn')
    if (!delivered) {
      // Never claim the user will be asked when the signal did not leave.
      throw confirmError('CONFIRM_NOT_DELIVERED', 'the confirmation request could not be sent to the companion; tell the user what you were about to do in your final message instead, and do not perform the action')
    }
    return {
      content: [{
        type: 'text',
        text: `Confirmation request recorded. The user will be asked to approve or deny "${request.action}" when this turn ends, with a screenshot of the current page. Do not perform the action in this turn. End your turn now with a short final message saying what you are asking to do.`,
      }],
      structuredContent: { recorded: true },
    }
  }

  function claim(agent, turn) {
    if (disposed || pendingTurnId === null || !Number.isSafeInteger(turn) || !agent?.session) return
    const sessionId = String(agent.session.id)
    if (active?.key === turnKey(sessionId, turn)) {
      pendingTurnId = null
      return
    }
    if (active) cleanup(active, 'superseded')
    const turnId = pendingTurnId
    pendingTurnId = null
    const entry = { key: turnKey(sessionId, turn), turnId, sessionId, turn, unregister: null }
    try {
      const definition = createMcpToolDefinition(ctx, {
        ...AGENT_CONFIRM_TOOL,
        call: (args, exec) => request(args, exec),
      })
      entry.unregister = ctx.tools.register(definition)
      active = entry
      log('confirm.mode.started', { turnId, sessionId, turn })
    } catch (error) {
      log('confirm.mode.error', {
        turnId,
        sessionId,
        turn,
        message: error instanceof Error ? error.message : String(error),
      }, 'error')
    }
  }

  function endTurn(session, turn) {
    if (active?.key !== turnKey(session?.id, turn)) return
    cleanup(active)
  }

  function dispose() {
    disposed = true
    pendingTurnId = null
    if (active) cleanup(active)
  }

  return Object.freeze({ setMode, claim, endTurn, dispose })
}
