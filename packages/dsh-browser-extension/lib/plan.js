export const PLAN_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'blocked'])

export const PLAN_LIMITS = deepFreeze({
  maxItems: 40,
  maxContentChars: 160,
  maxReasonChars: 240,
  openSummaryItems: 8,
  staleAfterActivities: 6,
  maxStaleReminders: 2,
  maxCompletionNudges: 2,
})

export const BROWSER_PLAN_TOOL = deepFreeze({
  name: 'browser_plan',
  rawName: 'browser_plan',
  description: 'Replace the complete live plan for a multi-step task. This changes only plan state, never the page, and is not evidence that browser work succeeded. Send every item each time with expected_revision (initially 0, then the latest returned revision). Status is pending | in_progress | completed | blocked. Keep exactly one item in_progress while pending work remains; at most one is allowed otherwise. completed is a model report, not independent verification. blocked is an explicit terminal state after genuine attempts and permits an honest blocked stop; its content should say why. If user input is needed, send the unchanged complete list with user_input_needed:true, then stop and ask rather than marking actionable work complete or blocked just to finish. Open items may be removed or have their content rewritten only with acknowledge_open_removal:true and a specific reason; otherwise preserve them in the complete replacement. Do not send an unchanged list except with user_input_needed:true, and do not use this tool for trivial single-step tasks.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'expected_revision'],
    properties: {
      items: {
        type: 'array',
        maxItems: PLAN_LIMITS.maxItems,
        description: 'The COMPLETE replacement list in display order. Duplicate content is rejected so revisions have unambiguous item identity.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['content', 'status'],
          properties: {
            content: { type: 'string', minLength: 1, maxLength: PLAN_LIMITS.maxContentChars, description: 'A short, single-line imperative task. For blocked items, include the concise reason.' },
            status: { type: 'string', enum: PLAN_STATUSES },
          },
        },
      },
      expected_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'The current revision. A mismatch is refused instead of overwriting a newer plan.' },
      reason: { type: 'string', minLength: 1, maxLength: PLAN_LIMITS.maxReasonChars, description: 'Optional single-line audit reason. Required when removing or rewriting any pending/in_progress item.' },
      acknowledge_open_removal: { type: 'boolean', description: 'Must be true, together with reason, when the replacement omits or rewrites an open item. Does not apply to a retained item whose status changes.' },
      user_input_needed: { type: 'boolean', description: 'With true, declare an honest stop for user input. Requires the unchanged complete current plan and expected_revision; does not increment the revision or complete open work.' },
    },
  },
})

const STATE_VERSION = 1
const STATE_KEYS = [
  'version', 'revision', 'items', 'activitiesSinceRevision', 'activityCount',
  'staleReminderCount', 'lastStaleReminderActivity', 'completionNudges',
]
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value, allowed) {
  const keys = Object.keys(value)
  return keys.every(key => allowed.includes(key))
}

function stateError(message) {
  const error = new TypeError(`PLAN_STATE_INVALID: ${message}`)
  error.code = 'PLAN_STATE_INVALID'
  return error
}

function optionError(message) {
  const error = new TypeError(`PLAN_FINAL_OPTIONS_INVALID: ${message}`)
  error.code = 'PLAN_FINAL_OPTIONS_INVALID'
  return error
}

function validationError(code, message) {
  return { error: { code, message } }
}

function normalizeText(value, path, maxChars) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return validationError('PLAN_TEXT_INVALID', `${path} must be a non-empty string`)
  }
  if (value.length > maxChars) {
    return validationError('PLAN_TEXT_TOO_LONG', `${path} exceeds the ${maxChars}-character cap`)
  }
  if (CONTROL_CHARS.test(value)) {
    return validationError('PLAN_TEXT_SINGLE_LINE', `${path} must be a single line without control characters`)
  }
  return { text: value.trim() }
}

function normalizeItems(raw) {
  if (!Array.isArray(raw)) {
    return validationError('PLAN_ITEMS_INVALID', 'items must be an array of {content, status}')
  }
  if (raw.length > PLAN_LIMITS.maxItems) {
    return validationError('PLAN_TOO_MANY_ITEMS', `items has ${raw.length} entries; the cap is ${PLAN_LIMITS.maxItems}`)
  }
  const items = []
  const contents = new Set()
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return validationError('PLAN_ITEM_INVALID', `items[${index}] must be an object`)
    }
    if (!hasOnlyKeys(entry, ['content', 'status']) || !hasOwn(entry, 'content') || !hasOwn(entry, 'status')) {
      return validationError('PLAN_ITEM_FIELDS_INVALID', `items[${index}] requires exactly content and status; unknown or missing fields are refused`)
    }
    const content = normalizeText(entry.content, `items[${index}].content`, PLAN_LIMITS.maxContentChars)
    if (content.error) return content
    if (contents.has(content.text)) {
      return validationError('PLAN_DUPLICATE_ITEM', `items[${index}].content duplicates another item; give every item unique content`)
    }
    contents.add(content.text)
    if (typeof entry.status !== 'string' || !PLAN_STATUSES.includes(entry.status)) {
      return validationError('PLAN_STATUS_INVALID', `items[${index}].status must be one of: ${PLAN_STATUSES.join(', ')}`)
    }
    items.push({ content: content.text, status: entry.status })
  }
  const active = items.filter(item => item.status === 'in_progress').length
  if (active > 1) {
    return validationError('PLAN_MULTIPLE_IN_PROGRESS', 'at most one item may be in_progress')
  }
  if (active === 0 && items.some(item => item.status === 'pending')) {
    return validationError('PLAN_IN_PROGRESS_REQUIRED', 'one item must be in_progress while pending work remains')
  }
  return { items }
}

function cloneItems(items) {
  return items.map(item => ({ content: item.content, status: item.status }))
}

function assertPlanState(state) {
  if (!isRecord(state) || !hasOnlyKeys(state, STATE_KEYS) || STATE_KEYS.some(key => !hasOwn(state, key))) {
    throw stateError('expected a complete plan state created by this module')
  }
  if (state.version !== STATE_VERSION) throw stateError(`version must be ${STATE_VERSION}`)
  const normalized = normalizeItems(state.items)
  if (normalized.error) throw stateError(normalized.error.message)
  for (const [index, item] of state.items.entries()) {
    if (item.content !== normalized.items[index].content) throw stateError('items must contain normalized content')
  }
  for (const key of ['revision', 'activitiesSinceRevision', 'activityCount', 'lastStaleReminderActivity']) {
    if (!Number.isSafeInteger(state[key]) || state[key] < 0) throw stateError(`${key} must be a non-negative safe integer`)
  }
  for (const [key, maximum] of [['staleReminderCount', PLAN_LIMITS.maxStaleReminders], ['completionNudges', PLAN_LIMITS.maxCompletionNudges]]) {
    if (!Number.isSafeInteger(state[key]) || state[key] < 0 || state[key] > maximum) {
      throw stateError(`${key} must be an integer from 0 to ${maximum}`)
    }
  }
  if (state.activitiesSinceRevision > state.activityCount) throw stateError('activitiesSinceRevision cannot exceed activityCount')
  if (state.lastStaleReminderActivity > state.activityCount) throw stateError('lastStaleReminderActivity cannot exceed activityCount')
}

function increment(value) {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1)
}

function openItems(items) {
  return items.filter(item => item.status === 'pending' || item.status === 'in_progress')
}

function sameItems(left, right) {
  return left.length === right.length && left.every((item, index) =>
    item.content === right[index].content && item.status === right[index].status)
}

function failedReplacement(state, code, message) {
  return {
    ok: false,
    changed: false,
    state,
    error: { code, message },
    summary: summarizePlan(state),
  }
}

export function createPlanState() {
  return deepFreeze({
    version: STATE_VERSION,
    revision: 0,
    items: [],
    activitiesSinceRevision: 0,
    activityCount: 0,
    staleReminderCount: 0,
    lastStaleReminderActivity: 0,
    completionNudges: 0,
  })
}

export function summarizePlan(state) {
  assertPlanState(state)
  const pending = state.items.filter(item => item.status === 'pending').length
  const inProgress = state.items.filter(item => item.status === 'in_progress').length
  const completed = state.items.filter(item => item.status === 'completed').length
  const blocked = state.items.filter(item => item.status === 'blocked').length
  const open = openItems(state.items)
  const listedOpen = []
  for (const [index, item] of state.items.entries()) {
    if (item.status !== 'pending' && item.status !== 'in_progress') continue
    if (listedOpen.length >= PLAN_LIMITS.openSummaryItems) break
    listedOpen.push({ index: index + 1, content: item.content, status: item.status })
  }
  const active = state.items.find(item => item.status === 'in_progress')
  const counts = { pending, inProgress, completed, blocked, open: open.length }
  const parts = state.items.length === 0
    ? [`plan revision ${state.revision}: empty`, 'no open items']
    : [
        `plan revision ${state.revision}: ${completed}/${state.items.length} reported completed`,
        `${blocked} blocked`,
        open.length === 0 ? 'no open items' : `${open.length} open`,
      ]
  if (active) parts.push(`now: ${active.content}`)
  let text = parts.join('; ')
  if (listedOpen.length > 0) {
    text += `\nOpen items:\n${listedOpen.map(item => `- [${item.status}] ${item.content}`).join('\n')}`
    if (open.length > listedOpen.length) text += `\n…and ${open.length - listedOpen.length} more open item(s).`
  }
  return deepFreeze({
    revision: state.revision,
    total: state.items.length,
    counts,
    active: active ? { content: active.content, status: active.status } : null,
    openItems: listedOpen,
    omittedOpenItems: open.length - listedOpen.length,
    text,
  })
}

export function replacePlan(state, args) {
  assertPlanState(state)
  if (!isRecord(args)) return failedReplacement(state, 'PLAN_ARGUMENTS_INVALID', 'browser_plan arguments must be an object')
  const allowed = ['items', 'expected_revision', 'reason', 'acknowledge_open_removal']
  if (!hasOnlyKeys(args, allowed)) {
    return failedReplacement(state, 'PLAN_ARGUMENT_FIELDS_INVALID', `unknown browser_plan argument; allowed fields: ${allowed.join(', ')}`)
  }
  if (!hasOwn(args, 'items') || !hasOwn(args, 'expected_revision')) {
    return failedReplacement(state, 'PLAN_ARGUMENT_FIELDS_INVALID', 'items and expected_revision are required')
  }
  if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0) {
    return failedReplacement(state, 'PLAN_REVISION_INVALID', 'expected_revision must be a non-negative safe integer')
  }
  if (args.expected_revision !== state.revision) {
    return failedReplacement(state, 'PLAN_REVISION_CONFLICT', `expected_revision ${args.expected_revision} does not match current revision ${state.revision}; read the latest plan and retry without overwriting newer work`)
  }
  const normalized = normalizeItems(args.items)
  if (normalized.error) return failedReplacement(state, normalized.error.code, normalized.error.message)
  let reason = 'whole-list replacement'
  if (hasOwn(args, 'reason')) {
    const checked = normalizeText(args.reason, 'reason', PLAN_LIMITS.maxReasonChars)
    if (checked.error) return failedReplacement(state, checked.error.code, checked.error.message)
    reason = checked.text
  }
  let acknowledgeOpenRemoval = false
  if (hasOwn(args, 'acknowledge_open_removal')) {
    if (typeof args.acknowledge_open_removal !== 'boolean') {
      return failedReplacement(state, 'PLAN_ACK_INVALID', 'acknowledge_open_removal must be a boolean')
    }
    acknowledgeOpenRemoval = args.acknowledge_open_removal
  }
  if (sameItems(state.items, normalized.items)) {
    return failedReplacement(state, 'PLAN_UNCHANGED', 'the replacement is unchanged; do real work or change the plan before calling browser_plan again')
  }
  const nextContents = new Set(normalized.items.map(item => item.content))
  const removedOpenItems = openItems(state.items).filter(item => !nextContents.has(item.content))
  if (removedOpenItems.length > 0 && !acknowledgeOpenRemoval) {
    const names = removedOpenItems.slice(0, PLAN_LIMITS.openSummaryItems).map(item => item.content).join('; ')
    return failedReplacement(state, 'PLAN_OPEN_REMOVAL_REQUIRES_ACK', `the rewrite removes or rewrites ${removedOpenItems.length} open item(s): ${names}. Preserve them, move them to completed/blocked as honestly applicable, or set acknowledge_open_removal:true with a specific reason`)
  }
  if (removedOpenItems.length > 0 && !hasOwn(args, 'reason')) {
    return failedReplacement(state, 'PLAN_REWRITE_REASON_REQUIRED', 'a specific reason is required when removing or rewriting open items')
  }
  if (state.revision === Number.MAX_SAFE_INTEGER) {
    return failedReplacement(state, 'PLAN_REVISION_EXHAUSTED', 'the plan revision counter is exhausted; start a new turn-scoped plan')
  }
  const nextState = deepFreeze({
    ...state,
    revision: state.revision + 1,
    items: cloneItems(normalized.items),
    activitiesSinceRevision: 0,
  })
  const audit = deepFreeze({
    previousRevision: state.revision,
    revision: nextState.revision,
    reason,
    previousItems: cloneItems(state.items),
    items: cloneItems(nextState.items),
    removedOpenItems: cloneItems(removedOpenItems),
    openRemovalAcknowledged: removedOpenItems.length > 0 && acknowledgeOpenRemoval,
  })
  return { ok: true, changed: true, state: nextState, audit, summary: summarizePlan(nextState) }
}

export function recordPlanActivity(state) {
  assertPlanState(state)
  const activityCount = increment(state.activityCount)
  const activitiesSinceRevision = increment(state.activitiesSinceRevision)
  const summary = summarizePlan(state)
  const enoughNewActivity = activityCount - state.lastStaleReminderActivity >= PLAN_LIMITS.staleAfterActivities
  const shouldRemind = summary.counts.open > 0
    && activitiesSinceRevision >= PLAN_LIMITS.staleAfterActivities
    && enoughNewActivity
    && state.staleReminderCount < PLAN_LIMITS.maxStaleReminders
  const nextState = deepFreeze({
    ...state,
    items: cloneItems(state.items),
    activityCount,
    activitiesSinceRevision,
    staleReminderCount: state.staleReminderCount + (shouldRemind ? 1 : 0),
    lastStaleReminderActivity: shouldRemind ? activityCount : state.lastStaleReminderActivity,
  })
  if (!shouldRemind) return { state: nextState, reminder: null }
  const reminderCount = nextState.staleReminderCount
  const text = `[harness] Plan revision ${state.revision} is stale after ${activitiesSinceRevision} non-plan activities and still has ${summary.counts.open} open item(s). Continue the in-progress item and update browser_plan only when actual status or scope changes; do not rewrite it merely to clear this reminder. If work is genuinely impossible after real attempts, mark it blocked with the reason. Reported completion is not independent verification. (Stale-plan reminder ${reminderCount} of ${PLAN_LIMITS.maxStaleReminders}.)\n${summary.openItems.map(item => `- ${item.content}`).join('\n')}${summary.omittedOpenItems > 0 ? `\n…and ${summary.omittedOpenItems} more.` : ''}`
  return {
    state: nextState,
    reminder: deepFreeze({
      kind: 'stale-plan',
      revision: state.revision,
      reminder: reminderCount,
      maxReminders: PLAN_LIMITS.maxStaleReminders,
      openItemCount: summary.counts.open,
      omittedOpenItems: summary.omittedOpenItems,
      openItems: summary.openItems,
      text,
    }),
  }
}

export function decidePlanFinalAnswer(state, options = {}) {
  assertPlanState(state)
  if (!isRecord(options) || !hasOnlyKeys(options, ['aborted', 'userInputNeeded'])) {
    throw optionError('allowed fields are aborted and userInputNeeded')
  }
  for (const key of ['aborted', 'userInputNeeded']) {
    if (hasOwn(options, key) && typeof options[key] !== 'boolean') throw optionError(`${key} must be a boolean`)
  }
  const summary = summarizePlan(state)
  const decision = (action, reason, outcome, extra = {}) => ({
    state,
    action,
    reason,
    outcome,
    completionNudges: state.completionNudges,
    maxCompletionNudges: PLAN_LIMITS.maxCompletionNudges,
    summary,
    ...extra,
  })
  if (options.aborted === true) return decision('allow', 'aborted', 'aborted')
  if (options.userInputNeeded === true) return decision('ask_user', 'user-input-needed', 'user-input-needed')
  if (summary.counts.open === 0) {
    if (summary.total === 0) return decision('allow', 'no-plan', 'not-assessed')
    if (summary.counts.blocked > 0) return decision('allow', 'blocked-items', 'blocked')
    return decision('allow', 'reported-complete', 'reported-complete')
  }
  if (state.completionNudges >= PLAN_LIMITS.maxCompletionNudges) {
    return decision('allow', 'nudge-limit', 'unfinished')
  }
  const nextState = deepFreeze({
    ...state,
    items: cloneItems(state.items),
    completionNudges: state.completionNudges + 1,
  })
  const nudge = nextState.completionNudges
  const message = `[harness] Not finished: plan revision ${state.revision} still has ${summary.counts.open} item(s) pending or in_progress.\n${summary.openItems.map(item => `- ${item.content}`).join('\n')}${summary.omittedOpenItems > 0 ? `\n…and ${summary.omittedOpenItems} more.` : ''}\nDo the next item now. To change the plan, call browser_plan with the COMPLETE list and expected_revision:${state.revision}. Mark items completed only to report completion; that status is not independent verification. Mark an item blocked only after genuine attempts, and ask the user when input is needed. Do not erase open work: removal or content rewrites require explicit acknowledgement and a reason. Answer again only when every item is completed or blocked. (Completion nudge ${nudge} of ${PLAN_LIMITS.maxCompletionNudges}.)`
  return {
    state: nextState,
    action: 'nudge',
    reason: 'open-items',
    outcome: 'unfinished',
    completionNudges: nudge,
    maxCompletionNudges: PLAN_LIMITS.maxCompletionNudges,
    summary,
    message,
  }
}
