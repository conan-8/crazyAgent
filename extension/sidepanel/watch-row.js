/**
 * Pure normalization and rendering for a marathon watch notice (§3.5).
 *
 * Dependency-free like plan-panel.js: no chrome/DOM globals beyond the owner
 * document passed in. A chat.watch row appears in the transcript with Stop /
 * Steer… / It's fine buttons while open, and collapses to a one-line summary on
 * recovery or dismissal. The row is ordinary transcript DOM, so it is saved in
 * history like every other row.
 */

export const WATCH_KIND_LABELS = Object.freeze({
  SILENT_STALL: 'Gone quiet',
  TOOL_HANG: 'Call not returning',
  EXECUTOR_DOWN: 'Executor disconnected',
  'ended-incomplete': 'Ended incomplete',
  // M4 judge verdicts (source 'watcher'/'both'); rendered with the same actions.
  stuck: 'May be stuck',
  blocked: 'Blocked',
  recovered: 'Recovered',
  info: 'Watch',
})

const OPEN_STATES = new Set(['open'])
const ACTIONABLE_KINDS = new Set(['SILENT_STALL', 'TOOL_HANG', 'EXECUTOR_DOWN', 'ended-incomplete', 'stuck', 'blocked'])

/**
 * Normalize a companion chat.watch frame, or null when malformed.
 * @param {unknown} frame
 * @returns {null | {id: string, turnId: string | null, kind: string, state: string, blocker: string | null, reason: string, signals: Array<{kind: string, level: string, detail: string}>, source: string, at: string | null}}
 */
export function watchNotice(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return null
  if (frame.type !== 'chat.watch') return null
  if (typeof frame.id !== 'string' || frame.id.length === 0) return null
  const kind = typeof frame.kind === 'string' ? frame.kind : 'info'
  const state = typeof frame.state === 'string' ? frame.state : 'open'
  const signals = Array.isArray(frame.signals)
    ? frame.signals
      .filter(signal => signal && typeof signal === 'object' && typeof signal.kind === 'string')
      .slice(0, 12)
      .map(signal => ({
        kind: signal.kind,
        level: typeof signal.level === 'string' ? signal.level : '',
        detail: typeof signal.detail === 'string' ? signal.detail.slice(0, 200) : '',
      }))
    : []
  return {
    id: frame.id,
    turnId: typeof frame.turnId === 'string' ? frame.turnId : null,
    kind,
    state,
    blocker: typeof frame.blocker === 'string' ? frame.blocker : null,
    reason: typeof frame.reason === 'string' ? frame.reason.slice(0, 500) : '',
    signals,
    source: frame.source === 'watcher' || frame.source === 'both' ? frame.source : 'heuristic',
    at: typeof frame.at === 'string' ? frame.at : null,
  }
}

/** True when the notice should show the action buttons (an open, actionable alert). */
export function watchIsActionable(notice) {
  return notice !== null && OPEN_STATES.has(notice.state) && ACTIONABLE_KINDS.has(notice.kind)
}

function element(document, tagName, className, text) {
  const node = document.createElement(tagName)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * Render a watch notice into `root`. Open actionable alerts get Stop / Steer… /
 * It's fine buttons; recovered/dismissed notices collapse to a summary line.
 * @param {HTMLElement} root
 * @param {ReturnType<typeof watchNotice>} notice
 * @param {{onStop?: () => void, onSteer?: () => void, onDismiss?: () => void}} [handlers]
 */
export function renderWatchRow(root, notice, handlers = {}) {
  root.classList.add('watch-row')
  root.dataset.watchId = notice.id
  root.dataset.watchKind = notice.kind
  root.dataset.watchState = notice.state
  root.setAttribute('role', 'status')
  root.replaceChildren()
  const actionable = watchIsActionable(notice)
  root.classList.toggle('collapsed', !actionable)
  root.classList.toggle('alert', actionable)

  const document = root.ownerDocument
  const head = element(document, 'div', 'watch-row-head')
  const badge = element(document, 'span', 'watch-row-badge', WATCH_KIND_LABELS[notice.kind] ?? 'Watch')
  const reason = element(document, 'span', 'watch-row-reason', notice.reason || (WATCH_KIND_LABELS[notice.kind] ?? 'Watch notice'))
  head.append(badge, reason)
  root.appendChild(head)

  if (!actionable) return

  if (notice.signals.length > 0) {
    const signals = element(document, 'ul', 'watch-row-signals')
    for (const signal of notice.signals.slice(0, 6)) {
      const item = element(document, 'li', 'watch-row-signal', `${signal.kind}${signal.detail ? ` — ${signal.detail}` : ''}`)
      signals.appendChild(item)
    }
    root.appendChild(signals)
  }

  const actions = element(document, 'div', 'watch-row-actions')
  const stop = element(document, 'button', 'watch-row-stop', 'Stop')
  stop.type = 'button'
  stop.title = 'Stop the current turn'
  if (typeof handlers.onStop === 'function') stop.addEventListener('click', handlers.onStop)
  const steer = element(document, 'button', 'watch-row-steer', 'Steer…')
  steer.type = 'button'
  steer.title = 'Send a steering message to the running turn'
  if (typeof handlers.onSteer === 'function') steer.addEventListener('click', handlers.onSteer)
  const dismiss = element(document, 'button', 'watch-row-dismiss', "It's fine")
  dismiss.type = 'button'
  dismiss.title = 'Dismiss this alert and snooze its kind for 15 minutes'
  if (typeof handlers.onDismiss === 'function') dismiss.addEventListener('click', handlers.onDismiss)
  actions.append(stop, steer, dismiss)
  root.appendChild(actions)
}
