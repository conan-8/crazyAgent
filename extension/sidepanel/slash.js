/**
 * Pure slash-command definitions and matching shared by the composer and its
 * unit tests.
 *
 * Dependency-free: no `chrome`, `navigator`, or DOM access. The composer owns
 * the menu rendering and command execution; this module only decides when a
 * draft is a slash token, which commands match, and how keyboard selection
 * moves.
 */

/**
 * Commands in display order. `usage` is also the unique trigger: typing the
 * slash plus a prefix of the name (e.g. `/n`) filters the menu.
 * @type {ReadonlyArray<{id: string, usage: string, description: string}>}
 */
export const SLASH_COMMANDS = Object.freeze([
  Object.freeze({ id: 'new', usage: '/new', description: 'Start a new chat' }),
  Object.freeze({ id: 'model', usage: '/model', description: 'Choose the model for your next turn' }),
  Object.freeze({ id: 'plan', usage: '/plan', description: 'Plan the next turn with a live checklist' }),
])

/** Longest command prefix that still counts as a slash draft (chars after `/`). */
export const SLASH_QUERY_MAX_CHARS = 24

const SLASH_DRAFT = new RegExp(`^\\/([a-z]{0,${SLASH_QUERY_MAX_CHARS}})$`, 'i')

/**
 * The command prefix a composer draft is filtering by, or null when the draft
 * is ordinary prose. Only a single-line leading slash with letters counts:
 * `/`, `/n`, `/new` trigger; `/new chat`, `/usr/local`, and `"/n"` do not.
 * @param {unknown} value
 * @returns {string | null} lowercased prefix ('' for a bare slash)
 */
export function slashQuery(value) {
  if (typeof value !== 'string') return null
  const match = SLASH_DRAFT.exec(value)
  return match ? match[1].toLowerCase() : null
}

/**
 * Commands whose name starts with the given prefix, in display order. A bare
 * slash matches every command.
 * @param {string} query lowercased prefix ('' matches all)
 * @returns {Array<{id: string, usage: string, description: string}>}
 */
export function matchSlashCommands(query) {
  const normalized = typeof query === 'string' ? query.toLowerCase() : ''
  if (normalized === '') return [...SLASH_COMMANDS]
  return SLASH_COMMANDS.filter(command => command.usage.slice(1).startsWith(normalized))
}

/**
 * Exact command for a draft, used when the user sends instead of choosing from
 * the menu (Send button or Enter with the menu already dismissed). Trailing
 * whitespace means prose, so `/new ` is not executed by accident.
 * @param {unknown} value
 * @returns {{id: string, usage: string, description: string} | null}
 */
export function resolveSlashCommand(value) {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase()
  return SLASH_COMMANDS.find(command => command.usage === normalized) ?? null
}

/**
 * Move a listbox selection by `delta` rows with wrapping, e.g. ArrowUp from
 * the first row lands on the last.
 * @param {number} index current index
 * @param {number} length number of rows
 * @param {number} delta rows to move (negative moves up)
 * @returns {number}
 */
export function nextSlashIndex(index, length, delta) {
  if (!Number.isInteger(length) || length <= 0) return 0
  const start = Number.isInteger(index) ? index : 0
  const step = Number.isInteger(delta) ? delta : 0
  return ((start + step) % length + length) % length
}