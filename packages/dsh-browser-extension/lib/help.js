/**
 * agent_request_help: a structured "I am blocked and need the user" signal.
 *
 * The tool touches nothing in the browser. It sends the request to the
 * companion over the provider's own bridge connection as a `help-request`
 * activity, and the companion, not the model's final text, decides that the
 * chat is now waiting for the user. There is no pause/resume: the model is
 * told to end its turn.
 *
 * The request deliberately does not ride the durable `turn/end` session event:
 * DSH deep-freezes committed events, so a listener cannot annotate them.
 */

export const HELP_CATEGORIES = Object.freeze(['login', 'captcha', 'permission', 'ambiguous', 'error', 'other'])
export const HELP_REASON_MAX_CHARS = 500

export const AGENT_HELP_TOOL = Object.freeze({
  name: 'agent_request_help',
  rawName: 'agent_request_help',
  description: `Tell the user you are blocked and need them, then end your turn. Use it only when you cannot continue without the user: a login, CAPTCHA/2FA, payment or browser permission, a file picker, a choice only they can make, or an error you cannot work around. reason says what is blocking you and exactly what the user should do, in one or two plain sentences (max ${HELP_REASON_MAX_CHARS} characters) with no passwords or secrets. It takes no browser action and returns no view. After calling it, do not keep working on the blocked step: finish with a short final message. The user is notified when the turn ends and their reply continues this chat.`,
  inputSchema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'category'],
    properties: Object.freeze({
      reason: Object.freeze({ type: 'string', minLength: 1, maxLength: HELP_REASON_MAX_CHARS, description: 'What is blocking progress and what the user should do.' }),
      category: Object.freeze({ type: 'string', enum: HELP_CATEGORIES, description: 'The kind of blocker.' }),
    }),
  }),
})

function helpError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/**
 * Strict argument check; the provider schema is advisory for some routes.
 * @param {unknown} args
 * @returns {{reason: string, category: string}}
 */
export function parseHelpRequest(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw helpError('HELP_INVALID', 'agent_request_help takes {reason, category}')
  }
  const unknown = Object.keys(args).filter(key => key !== 'reason' && key !== 'category')
  if (unknown.length > 0) throw helpError('HELP_INVALID', `unknown field ${unknown[0]}`)
  const { reason, category } = /** @type {Record<string, unknown>} */ (args)
  if (typeof category !== 'string' || !HELP_CATEGORIES.includes(category)) {
    throw helpError('HELP_INVALID', `category must be one of ${HELP_CATEGORIES.join(', ')}`)
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw helpError('HELP_INVALID', 'reason must say what is blocking you and what the user should do')
  }
  const trimmed = reason.trim()
  if (trimmed.length > HELP_REASON_MAX_CHARS) {
    throw helpError('HELP_INVALID', `reason must be at most ${HELP_REASON_MAX_CHARS} characters`)
  }
  return { reason: trimmed, category }
}

/**
 * @param {{bridge: {
 *   activity: (activity: Record<string, unknown>) => boolean | void,
 *   logEvent: (type: string, data: Record<string, unknown>, severity?: string) => void,
 * }}} options
 */
export function createHelpRuntime({ bridge }) {
  return {
    /**
     * Tool body. Requires a calling session, so a request always belongs to a
     * running turn; the companion ties it to its own current turn ID.
     * @param {unknown} args
     * @param {{agent?: {session?: {id?: unknown}}}} exec
     */
    request(args, exec) {
      const request = parseHelpRequest(args)
      const sessionId = exec?.agent?.session?.id
      if (sessionId === undefined || sessionId === null) {
        throw helpError('HELP_NO_ACTIVE_TURN', 'agent_request_help can only be called from a running turn')
      }
      const delivered = bridge.activity({ kind: 'help-request', category: request.category, reason: request.reason }) === true
      // The reason is user-facing chat content, not diagnostics: log its size only.
      bridge.logEvent('help.requested', { sessionId: String(sessionId), category: request.category, reasonChars: request.reason.length, delivered }, delivered ? 'info' : 'warn')
      if (!delivered) {
        // Never claim the user will be notified when the signal did not leave.
        throw helpError('HELP_NOT_DELIVERED', 'the help request could not be sent to the companion; tell the user what you need in your final message instead')
      }
      return {
        content: [{
          type: 'text',
          text: `Help request recorded (${request.category}). The user will be told your reason when this turn ends, with a screenshot of the current page. Do not keep working on the blocked step. End your turn now with a short final message saying what you need.`,
        }],
        structuredContent: { recorded: true, category: request.category },
      }
    },
  }
}
