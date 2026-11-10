/**
 * Pure rules for turns the side panel did not start itself (e.g. a prompt sent
 * from the phone through the companion's remote API).
 *
 * The companion sends `chat.user` only for non-panel origins; the panel renders
 * its own prompts locally when it sends them.
 */

/** Refusal codes that mean "another client holds the single turn slot". */
export const BUSY_REFUSAL_CODES = Object.freeze(['TURN_BUSY', 'TURN_STOPPING', 'SESSION_CHANGING'])

const ORIGIN_LABELS = Object.freeze({ remote: 'From phone' })
const MAX_IMAGES = 4

/**
 * Normalize a companion `chat.user` frame into what the panel renders, or
 * null when the frame is not a foreign prompt (malformed or panel-originated).
 * @param {unknown} frame
 * @returns {null | {turnId: string | null, origin: string, label: string, text: string, attachments: Array<{name: string}>}}
 */
export function foreignPrompt(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return null
  const record = /** @type {Record<string, unknown>} */ (frame)
  if (record.type !== 'chat.user') return null
  const origin = typeof record.origin === 'string' && record.origin.length > 0 ? record.origin : null
  if (origin === null || origin === 'ui') return null
  const text = typeof record.text === 'string' ? record.text : ''
  const count = Number.isInteger(record.imageCount) ? Math.min(Math.max(Number(record.imageCount), 0), MAX_IMAGES) : 0
  const label = ORIGIN_LABELS[origin] ?? `From ${origin}`
  return {
    turnId: typeof record.turnId === 'string' ? record.turnId : null,
    origin,
    label,
    text,
    // Only names are rendered; the image bytes stay with the companion.
    attachments: Array.from({ length: count }, (_, index) => ({ name: `${label.replace(/^From /u, '')} image ${index + 1}` })),
  }
}

/**
 * True when a chat.error refuses the panel's send because another client's
 * turn already holds the slot (not a model/runtime failure).
 * @param {unknown} frame
 */
export function isBusyRefusal(frame) {
  if (frame === null || typeof frame !== 'object') return false
  const code = /** @type {Record<string, unknown>} */ (frame).code
  return typeof code === 'string' && BUSY_REFUSAL_CODES.includes(code)
}

const HELP_LABELS = Object.freeze({
  login: 'Sign-in needed',
  captcha: 'CAPTCHA or verification needed',
  permission: 'Permission needed',
  ambiguous: 'Your decision needed',
  error: 'Blocked by an error',
  other: 'Your help needed',
})

/**
 * The agent's structured help request on a finished turn, as display text.
 * Null unless the frame carries the exact shape the companion commits; the
 * panel never infers a request from the answer text.
 * @param {unknown} frame
 * @returns {{label: string, reason: string, category: string} | null}
 */
export function helpNotice(frame) {
  if (frame === null || typeof frame !== 'object') return null
  const help = /** @type {Record<string, unknown>} */ (frame).help
  if (help === null || typeof help !== 'object') return null
  const { reason, category } = /** @type {Record<string, unknown>} */ (help)
  if (typeof reason !== 'string' || reason.trim().length === 0 || typeof category !== 'string') return null
  const label = Object.hasOwn(HELP_LABELS, category) ? HELP_LABELS[category] : HELP_LABELS.other
  return { label, reason: reason.trim().slice(0, 500), category }
}
