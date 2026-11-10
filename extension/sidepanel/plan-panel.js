export const PLAN_PANEL_LIMITS = Object.freeze({
  items: 50,
  textChars: 240,
})

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked'])
const STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  blocked: 'Blocked',
})

function boundedText(value) {
  const characters = []
  for (const character of value) {
    if (characters.length === PLAN_PANEL_LIMITS.textChars) {
      return `${characters.slice(0, -1).join('')}…`
    }
    characters.push(character)
  }
  return characters.join('')
}

function normalizeText(value) {
  if (typeof value !== 'string') return null
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return text ? boundedText(text) : null
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return null
  const items = []
  for (const valueItem of value) {
    if (!valueItem || typeof valueItem !== 'object' || !STATUSES.has(valueItem.status)) return null
    const content = normalizeText(valueItem.content)
    if (content === null) return null
    items.push({ content, status: valueItem.status })
  }
  return items
}

function sameItems(left, right) {
  return left.length === right.length && left.every((item, index) => (
    item.content === right[index].content && item.status === right[index].status
  ))
}

function makeState(items, expanded) {
  const frozenItems = Object.freeze(items.map(item => Object.freeze({ ...item })))
  const total = frozenItems.length
  const done = frozenItems.filter(item => item.status === 'completed').length
  const blocked = frozenItems.filter(item => item.status === 'blocked').length
  const currentIndex = frozenItems.findIndex(item => item.status === 'in_progress')
  const current = currentIndex < 0 ? null : Object.freeze({
    index: currentIndex,
    content: frozenItems[currentIndex].content,
    status: 'in_progress',
  })
  return Object.freeze({
    visible: total > 0,
    expanded: total > 0 && expanded,
    items: frozenItems,
    total,
    done,
    blocked,
    current,
    progress: total === 0 ? 0 : done / total,
  })
}

/**
 * Create the state for one plan panel. `update` accepts a complete array of
 * `{content, status}` items and returns `{accepted, changed, state}`. Invalid
 * updates leave the last valid state untouched. Call `reset` for a new chat or
 * turn so the next non-empty plan can auto-open once.
 */
export function createPlanPanelModel() {
  let state = makeState([], false)
  let autoOpened = false

  return Object.freeze({
    update(value) {
      const items = normalizeItems(value)
      if (items === null) return Object.freeze({ accepted: false, changed: false, state })

      let expanded = items.length === 0 ? false : state.expanded
      if (items.length > 0 && !autoOpened) {
        expanded = true
        autoOpened = true
      }
      const changed = !sameItems(state.items, items) || expanded !== state.expanded
      if (changed) state = makeState(items, expanded)
      return Object.freeze({ accepted: true, changed, state })
    },

    toggle() {
      if (!state.visible) return state
      state = makeState(state.items, !state.expanded)
      return state
    },

    reset() {
      autoOpened = false
      state = makeState([], false)
      return state
    },

    getState() {
      return state
    },
  })
}

const detailIds = new WeakMap()
let nextDetailId = 1

function detailId(root) {
  if (!detailIds.has(root)) {
    detailIds.set(root, `plan-panel-items-${nextDetailId}`)
    nextDetailId += 1
  }
  return detailIds.get(root)
}

function element(document, tagName, className, text) {
  const node = document.createElement(tagName)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * Render a model state into `root` using its owner document. `onToggle` should
 * call the model's `toggle` method and render the returned state. Rendering is
 * capped at PLAN_PANEL_LIMITS.items rows; counts still describe the full plan.
 */
export function renderPlanPanel(root, state, { onToggle } = {}) {
  root.classList.add('plan-panel')
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', 'Agent plan')
  root.replaceChildren()
  root.hidden = !state.visible
  if (!state.visible) return

  const document = root.ownerDocument
  const detailsId = detailId(root)
  const toggle = element(document, 'button', 'plan-panel-toggle')
  toggle.type = 'button'
  toggle.title = state.expanded ? 'Collapse plan' : 'Expand plan'
  toggle.setAttribute('aria-expanded', String(state.expanded))
  toggle.setAttribute('aria-controls', detailsId)

  const heading = element(document, 'span', 'plan-panel-heading', 'Plan')
  const count = element(document, 'span', 'plan-panel-count', `${state.done}/${state.total} done`)
  const blocked = element(document, 'span', 'plan-panel-blocked', `${state.blocked} blocked`)
  blocked.hidden = state.blocked === 0
  const currentText = state.current
    ? `Current: ${state.current.content}`
    : state.done === state.total ? 'All items completed' : 'No item in progress'
  const current = element(document, 'span', 'plan-panel-current', currentText)
  const progress = element(document, 'progress', 'plan-panel-progress', `${state.done}/${state.total}`)
  progress.max = state.total
  progress.value = state.done
  progress.setAttribute('aria-label', `${state.done} of ${state.total} plan items completed`)
  toggle.append(heading, count, blocked, current, progress)
  if (typeof onToggle === 'function') toggle.addEventListener('click', onToggle)

  const details = element(document, 'div', 'plan-panel-details')
  details.id = detailsId
  details.hidden = !state.expanded
  const list = element(document, 'ol', 'plan-panel-list')
  list.setAttribute('aria-label', 'Plan items')

  const renderedItems = state.items.slice(0, PLAN_PANEL_LIMITS.items)
  for (const item of renderedItems) {
    const row = element(document, 'li', `plan-panel-item plan-panel-item--${item.status}`)
    row.dataset.status = item.status
    if (item.status === 'in_progress') row.setAttribute('aria-current', 'step')
    const status = element(document, 'span', 'plan-panel-item-status', STATUS_LABELS[item.status])
    const content = element(document, 'span', 'plan-panel-item-content', item.content)
    row.append(status, content)
    list.appendChild(row)
  }

  const omitted = state.total - renderedItems.length
  if (omitted > 0) {
    list.appendChild(element(
      document,
      'li',
      'plan-panel-overflow',
      `${omitted} more plan ${omitted === 1 ? 'item' : 'items'} not shown`,
    ))
  }
  details.appendChild(list)
  root.append(toggle, details)
}
