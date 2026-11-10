import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_PLAN_TOOL,
  PLAN_LIMITS,
  PLAN_STATUSES,
  createPlanState,
  decidePlanFinalAnswer,
  recordPlanActivity,
  replacePlan,
  summarizePlan,
} from '../lib/plan.js'

const task = (content, status = 'pending') => ({ content, status })
const openItems = () => [
  task('Inspect current state', 'in_progress'),
  task('Apply the requested change'),
  task('Check the resulting state'),
]

function accepted(state, items, extra = {}) {
  const result = replacePlan(state, { items, expected_revision: state.revision, ...extra })
  assert.equal(result.ok, true, result.error?.message)
  assert.equal(result.changed, true)
  return result
}

function openPlan() {
  return accepted(createPlanState(), openItems()).state
}

function activities(state, count) {
  let current = state
  const reminders = []
  for (let index = 0; index < count; index += 1) {
    const result = recordPlanActivity(current)
    current = result.state
    if (result.reminder) reminders.push(result.reminder)
  }
  return { state: current, reminders }
}

test('browser_plan schema is bounded, strict, and exclusive', () => {
  assert.equal(BROWSER_PLAN_TOOL.name, 'browser_plan')
  assert.equal(BROWSER_PLAN_TOOL.rawName, 'browser_plan')
  assert.equal(BROWSER_PLAN_TOOL.parallelSafe, undefined)
  assert.equal(BROWSER_PLAN_TOOL.call, undefined, 'the isolated module supplies schema/state, not provider wiring')
  const schema = BROWSER_PLAN_TOOL.inputSchema
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['items', 'expected_revision'])
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'acknowledge_open_removal', 'expected_revision', 'items', 'reason', 'user_input_needed',
  ])
  assert.equal(schema.properties.items.maxItems, 40)
  assert.equal(schema.properties.items.items.additionalProperties, false)
  assert.deepEqual(schema.properties.items.items.required, ['content', 'status'])
  assert.equal(schema.properties.items.items.properties.content.maxLength, 160)
  assert.deepEqual(schema.properties.items.items.properties.status.enum, PLAN_STATUSES)
  assert.equal(schema.properties.reason.maxLength, 240)
  assert.equal(schema.properties.user_input_needed.type, 'boolean')
  assert.match(BROWSER_PLAN_TOOL.description, /not independent verification/)
  assert.match(BROWSER_PLAN_TOOL.description, /never the page/)
  assert.match(BROWSER_PLAN_TOOL.description, /unchanged complete list with user_input_needed:true/)
  assert.ok(Object.isFrozen(BROWSER_PLAN_TOOL))
  assert.ok(Object.isFrozen(schema.properties.items.items.properties.status.enum))
})

test('a new state is empty, immutable, and explicit about no plan', () => {
  const state = createPlanState()
  assert.ok(Object.isFrozen(state))
  assert.deepEqual(state.items, [])
  assert.equal(state.revision, 0)
  assert.equal(state.completionNudges, 0)
  assert.deepEqual(summarizePlan(state).counts, {
    pending: 0, inProgress: 0, completed: 0, blocked: 0, open: 0,
  })
  assert.equal(summarizePlan(state).text, 'plan revision 0: empty; no open items')
  const final = decidePlanFinalAnswer(state)
  assert.equal(final.action, 'allow')
  assert.equal(final.reason, 'no-plan')
  assert.equal(final.outcome, 'not-assessed')
  assert.equal(final.state, state)
})

test('a valid whole-list replacement normalizes text and returns revision/open summaries', () => {
  const initial = createPlanState()
  const result = accepted(initial, [
    task('  Inspect current state  ', 'in_progress'),
    task('Apply the requested change'),
  ], { reason: '  Break down the request  ' })
  assert.notEqual(result.state, initial)
  assert.equal(initial.revision, 0)
  assert.deepEqual(initial.items, [])
  assert.equal(result.state.revision, 1)
  assert.equal(result.state.activitiesSinceRevision, 0)
  assert.deepEqual(result.state.items, [
    task('Inspect current state', 'in_progress'),
    task('Apply the requested change'),
  ])
  assert.equal(result.audit.previousRevision, 0)
  assert.equal(result.audit.revision, 1)
  assert.equal(result.audit.reason, 'Break down the request')
  assert.deepEqual(result.audit.previousItems, [])
  assert.deepEqual(result.audit.items, result.state.items)
  assert.deepEqual(result.audit.removedOpenItems, [])
  assert.equal(result.audit.openRemovalAcknowledged, false)
  assert.deepEqual(result.summary.counts, {
    pending: 1, inProgress: 1, completed: 0, blocked: 0, open: 2,
  })
  assert.deepEqual(result.summary.active, task('Inspect current state', 'in_progress'))
  assert.equal(result.summary.openItems.length, 2)
  assert.deepEqual(result.summary.openItems.map(item => item.index), [1, 2])
  assert.match(result.summary.text, /plan revision 1: 0\/2 reported completed/)
  assert.match(result.summary.text, /2 open; now: Inspect current state/)
  assert.match(result.summary.text, /\[pending\] Apply the requested change/)
})

test('strict argument, item, text, and revision validation leaves state untouched', () => {
  const state = createPlanState()
  const completed = [task('Report the result', 'completed')]
  const cases = [
    [null, 'PLAN_ARGUMENTS_INVALID'],
    [[], 'PLAN_ARGUMENTS_INVALID'],
    ['items', 'PLAN_ARGUMENTS_INVALID'],
    [{ items: [], expected_revision: 0, extra: true }, 'PLAN_ARGUMENT_FIELDS_INVALID'],
    [{ items: [] }, 'PLAN_ARGUMENT_FIELDS_INVALID'],
    [{ expected_revision: 0 }, 'PLAN_ARGUMENT_FIELDS_INVALID'],
    [{ items: [], expected_revision: -1 }, 'PLAN_REVISION_INVALID'],
    [{ items: [], expected_revision: 1.5 }, 'PLAN_REVISION_INVALID'],
    [{ items: [], expected_revision: '0' }, 'PLAN_REVISION_INVALID'],
    [{ items: completed, expected_revision: 1 }, 'PLAN_REVISION_CONFLICT'],
    [{ items: {}, expected_revision: 0 }, 'PLAN_ITEMS_INVALID'],
    [{ items: Array.from({ length: 41 }, (_, index) => task(`Task ${index}`)), expected_revision: 0 }, 'PLAN_TOO_MANY_ITEMS'],
    [{ items: [null], expected_revision: 0 }, 'PLAN_ITEM_INVALID'],
    [{ items: [[]], expected_revision: 0 }, 'PLAN_ITEM_INVALID'],
    [{ items: [{ content: 'Missing status' }], expected_revision: 0 }, 'PLAN_ITEM_FIELDS_INVALID'],
    [{ items: [{ status: 'pending' }], expected_revision: 0 }, 'PLAN_ITEM_FIELDS_INVALID'],
    [{ items: [{ ...task('Work', 'in_progress'), verified: true }], expected_revision: 0 }, 'PLAN_ITEM_FIELDS_INVALID'],
    [{ items: [task('', 'completed')], expected_revision: 0 }, 'PLAN_TEXT_INVALID'],
    [{ items: [task('   ', 'completed')], expected_revision: 0 }, 'PLAN_TEXT_INVALID'],
    [{ items: [task(42, 'completed')], expected_revision: 0 }, 'PLAN_TEXT_INVALID'],
    [{ items: [task('x'.repeat(161), 'completed')], expected_revision: 0 }, 'PLAN_TEXT_TOO_LONG'],
    [{ items: [task('two\nlines', 'completed')], expected_revision: 0 }, 'PLAN_TEXT_SINGLE_LINE'],
    [{ items: [task('Work', 'done')], expected_revision: 0 }, 'PLAN_STATUS_INVALID'],
    [{ items: [task('Work', 'COMPLETED')], expected_revision: 0 }, 'PLAN_STATUS_INVALID'],
    [{ items: completed, expected_revision: 0, reason: '' }, 'PLAN_TEXT_INVALID'],
    [{ items: completed, expected_revision: 0, reason: 'x'.repeat(241) }, 'PLAN_TEXT_TOO_LONG'],
    [{ items: completed, expected_revision: 0, reason: 'two\nlines' }, 'PLAN_TEXT_SINGLE_LINE'],
    [{ items: completed, expected_revision: 0, acknowledge_open_removal: 'true' }, 'PLAN_ACK_INVALID'],
  ]
  for (const [args, code] of cases) {
    const result = replacePlan(state, args)
    assert.equal(result.ok, false, code)
    assert.equal(result.changed, false, code)
    assert.equal(result.error.code, code, result.error.message)
    assert.equal(result.state, state, code)
    assert.equal(result.summary.revision, 0, code)
  }
  assert.deepEqual(state, createPlanState())
})

test('pending work needs one active item and multiple active items fail closed', () => {
  const state = createPlanState()
  const multiple = replacePlan(state, {
    items: [task('One', 'in_progress'), task('Two', 'in_progress')], expected_revision: 0,
  })
  assert.equal(multiple.error.code, 'PLAN_MULTIPLE_IN_PROGRESS')
  const none = replacePlan(state, {
    items: [task('One'), task('Two', 'blocked')], expected_revision: 0,
  })
  assert.equal(none.error.code, 'PLAN_IN_PROGRESS_REQUIRED')
  assert.equal(none.state, state)
  assert.equal(accepted(state, [task('One', 'in_progress')]).state.items.length, 1)
  assert.equal(accepted(state, [task('One', 'completed')]).summary.counts.open, 0)
  assert.equal(accepted(state, [task('One', 'blocked')]).summary.counts.open, 0)
})

test('duplicate item identity and unchanged replacements are refused', () => {
  const state = openPlan()
  const duplicate = replacePlan(state, {
    items: [task('Same', 'in_progress'), task('Same')], expected_revision: state.revision,
  })
  assert.equal(duplicate.error.code, 'PLAN_DUPLICATE_ITEM')
  assert.equal(duplicate.state, state)
  const unchanged = replacePlan(state, {
    items: openItems(), expected_revision: state.revision, reason: 'A different reason is still no work',
  })
  assert.equal(unchanged.error.code, 'PLAN_UNCHANGED')
  assert.equal(unchanged.state, state)
  assert.equal(state.revision, 1)
})

test('reordering is a revision but stale expected revisions cannot overwrite it', () => {
  const state = openPlan()
  const reordered = accepted(state, [openItems()[1], openItems()[0], openItems()[2]])
  assert.equal(reordered.state.revision, 2)
  assert.deepEqual(reordered.state.items.map(item => item.content), [
    'Apply the requested change', 'Inspect current state', 'Check the resulting state',
  ])
  const stale = replacePlan(reordered.state, {
    items: [task('Replacement', 'in_progress')], expected_revision: state.revision,
  })
  assert.equal(stale.error.code, 'PLAN_REVISION_CONFLICT')
  assert.equal(stale.state, reordered.state)
  assert.deepEqual(reordered.state.items, reordered.audit.items)
})

test('omitting or rewriting open work requires both acknowledgement and a reason', () => {
  const state = openPlan()
  const rewritten = [task('Apply the requested change', 'in_progress'), openItems()[2]]
  const refused = replacePlan(state, { items: rewritten, expected_revision: state.revision })
  assert.equal(refused.error.code, 'PLAN_OPEN_REMOVAL_REQUIRES_ACK')
  assert.match(refused.error.message, /Inspect current state/)
  assert.equal(refused.state, state)
  const reasonless = replacePlan(state, {
    items: rewritten, expected_revision: state.revision, acknowledge_open_removal: true,
  })
  assert.equal(reasonless.error.code, 'PLAN_REWRITE_REASON_REQUIRED')
  assert.equal(reasonless.state, state)
  const result = accepted(state, rewritten, {
    acknowledge_open_removal: true,
    reason: 'User narrowed the scope to the requested change',
  })
  assert.equal(result.state.revision, 2)
  assert.deepEqual(result.audit.previousItems, openItems())
  assert.deepEqual(result.audit.removedOpenItems, [openItems()[0]])
  assert.equal(result.audit.openRemovalAcknowledged, true)
  assert.equal(result.audit.reason, 'User narrowed the scope to the requested change')
})

test('clearing open work is destructive, while clearing terminal items is auditable without acknowledgement', () => {
  const state = openPlan()
  const cleared = replacePlan(state, { items: [], expected_revision: state.revision })
  assert.equal(cleared.error.code, 'PLAN_OPEN_REMOVAL_REQUIRES_ACK')
  assert.equal(cleared.state, state)
  const terminal = accepted(createPlanState(), [
    task('Finished work', 'completed'), task('Unavailable work', 'blocked'),
  ]).state
  const result = accepted(terminal, [], { reason: 'Archive the terminal plan' })
  assert.deepEqual(result.audit.removedOpenItems, [])
  assert.equal(result.audit.openRemovalAcknowledged, false)
  assert.deepEqual(result.state.items, [])
})

test('retained open items may report completion or blockage without removal acknowledgement', () => {
  const state = openPlan()
  const progressed = accepted(state, [
    task('Inspect current state', 'completed'),
    task('Apply the requested change', 'in_progress'),
    task('Check the resulting state'),
  ])
  assert.deepEqual(progressed.audit.removedOpenItems, [])
  const stopped = accepted(progressed.state, [
    task('Inspect current state', 'completed'),
    task('Apply the requested change', 'blocked'),
    task('Check the resulting state', 'blocked'),
  ])
  assert.equal(stopped.summary.counts.open, 0)
  assert.equal(stopped.summary.counts.completed, 1)
  assert.equal(stopped.summary.counts.blocked, 2)
  assert.equal(stopped.summary.text.includes('verified'), false)
  assert.deepEqual(Object.keys(stopped.state.items[0]), ['content', 'status'])
})

test('open-item summaries are bounded and completion remains model-reported', () => {
  const items = Array.from({ length: 10 }, (_, index) =>
    task(`Task ${index + 1}`, index === 0 ? 'in_progress' : 'pending'))
  const result = accepted(createPlanState(), items)
  assert.equal(result.summary.counts.open, 10)
  assert.equal(result.summary.openItems.length, PLAN_LIMITS.openSummaryItems)
  assert.equal(result.summary.omittedOpenItems, 2)
  assert.match(result.summary.text, /… and|…and/)
  assert.match(result.summary.text, /2 more open item/)
  const completed = accepted(result.state, items.map(item => task(item.content, 'completed')))
  assert.match(completed.summary.text, /10\/10 reported completed/)
  assert.doesNotMatch(completed.summary.text, /verified|verification/)
  assert.equal(completed.state.items.every(item => !('verified' in item)), true)
})

test('maximum item and content bounds are accepted without truncation', () => {
  const longContent = `Start ${'x'.repeat(154)}`
  assert.equal(longContent.length, PLAN_LIMITS.maxContentChars)
  const items = Array.from({ length: PLAN_LIMITS.maxItems }, (_, index) =>
    task(index === 0 ? longContent : `Task ${index}`, index === 0 ? 'in_progress' : 'pending'))
  const result = accepted(createPlanState(), items, { reason: 'r'.repeat(PLAN_LIMITS.maxReasonChars) })
  assert.equal(result.state.items.length, PLAN_LIMITS.maxItems)
  assert.equal(result.state.items[0].content, longContent)
  assert.equal(result.audit.reason.length, PLAN_LIMITS.maxReasonChars)
})

test('stale reminders wait for six activities, are spaced, and stop at two', () => {
  const state = openPlan()
  const firstFive = activities(state, 5)
  assert.equal(firstFive.reminders.length, 0)
  assert.equal(firstFive.state.activitiesSinceRevision, 5)
  assert.equal(state.activityCount, 0, 'activity transitions do not mutate the input state')
  const sixth = recordPlanActivity(firstFive.state)
  assert.equal(sixth.reminder.kind, 'stale-plan')
  assert.equal(sixth.reminder.reminder, 1)
  assert.equal(sixth.reminder.maxReminders, 2)
  assert.equal(sixth.reminder.openItemCount, 3)
  assert.match(sixth.reminder.text, /Stale-plan reminder 1 of 2/)
  assert.match(sixth.reminder.text, /Reported completion is not independent verification/)
  const nextFive = activities(sixth.state, 5)
  assert.equal(nextFive.reminders.length, 0)
  const twelfth = recordPlanActivity(nextFive.state)
  assert.equal(twelfth.reminder.reminder, 2)
  assert.equal(twelfth.state.staleReminderCount, 2)
  const later = activities(twelfth.state, 30)
  assert.equal(later.reminders.length, 0)
  assert.equal(later.state.staleReminderCount, 2)
  assert.equal(later.state.activityCount, 42)
})

test('plan revisions reset stale elapsed work but never reset the reminder budget', () => {
  const state = openPlan()
  const first = activities(state, 6)
  assert.equal(first.reminders.length, 1)
  const revised = accepted(first.state, [...openItems(), task('Report the outcome')]).state
  assert.equal(revised.activitiesSinceRevision, 0)
  assert.equal(revised.staleReminderCount, 1)
  assert.equal(revised.completionNudges, 0)
  const second = activities(revised, 6)
  assert.equal(second.reminders.length, 1)
  assert.equal(second.reminders[0].reminder, 2)
  const revisedAgain = accepted(second.state, [
    ...openItems(), task('Report the outcome'), task('Record assumptions'),
  ]).state
  const later = activities(revisedAgain, 12)
  assert.equal(later.reminders.length, 0)
  assert.equal(later.state.staleReminderCount, 2)
})

test('empty and terminal plans never produce stale reminders', () => {
  const empty = activities(createPlanState(), 20)
  assert.equal(empty.reminders.length, 0)
  assert.equal(empty.state.activityCount, 20)
  const terminal = accepted(createPlanState(), [
    task('Finished', 'completed'), task('Blocked for a stated reason', 'blocked'),
  ]).state
  const result = activities(terminal, 20)
  assert.equal(result.reminders.length, 0)
  assert.equal(result.state.staleReminderCount, 0)
})

test('open final answers receive exactly two nudges before an unfinished stop is allowed', () => {
  const state = openPlan()
  const first = decidePlanFinalAnswer(state)
  assert.equal(first.action, 'nudge')
  assert.equal(first.reason, 'open-items')
  assert.equal(first.outcome, 'unfinished')
  assert.equal(first.completionNudges, 1)
  assert.equal(first.state.revision, state.revision)
  assert.equal(state.completionNudges, 0)
  assert.match(first.message, /expected_revision:1/)
  assert.match(first.message, /Do not erase open work/)
  assert.match(first.message, /not independent verification/)
  assert.match(first.message, /Completion nudge 1 of 2/)
  const second = decidePlanFinalAnswer(first.state)
  assert.equal(second.action, 'nudge')
  assert.equal(second.completionNudges, 2)
  assert.match(second.message, /Completion nudge 2 of 2/)
  const third = decidePlanFinalAnswer(second.state)
  assert.equal(third.action, 'allow')
  assert.equal(third.reason, 'nudge-limit')
  assert.equal(third.outcome, 'unfinished')
  assert.equal(third.completionNudges, 2)
  assert.equal(third.state, second.state)
  assert.equal(third.message, undefined)
  assert.equal(decidePlanFinalAnswer(third.state).completionNudges, 2)
})

test('plan rewrites do not reset the two-completion-nudge budget', () => {
  const state = openPlan()
  const first = decidePlanFinalAnswer(state)
  const revised = accepted(first.state, [
    task('Inspect current state'),
    task('Apply the requested change', 'in_progress'),
    task('Check the resulting state'),
  ]).state
  assert.equal(revised.completionNudges, 1)
  const second = decidePlanFinalAnswer(revised)
  assert.equal(second.action, 'nudge')
  assert.equal(second.completionNudges, 2)
  const revisedAgain = accepted(second.state, [
    task('Inspect current state', 'in_progress'),
    task('Apply the requested change'),
    task('Check the resulting state'),
    task('Report the outcome'),
  ]).state
  const final = decidePlanFinalAnswer(revisedAgain)
  assert.equal(final.action, 'allow')
  assert.equal(final.reason, 'nudge-limit')
  assert.equal(final.outcome, 'unfinished')
})

test('reported-complete and blocked terminal plans allow honest final outcomes', () => {
  const completed = accepted(createPlanState(), [task('Finished', 'completed')]).state
  const completeDecision = decidePlanFinalAnswer(completed)
  assert.equal(completeDecision.action, 'allow')
  assert.equal(completeDecision.reason, 'reported-complete')
  assert.equal(completeDecision.outcome, 'reported-complete')
  assert.notEqual(completeDecision.outcome, 'verified')
  const blocked = accepted(createPlanState(), [
    task('Finished', 'completed'), task('Needs unavailable permission', 'blocked'),
  ]).state
  const blockedDecision = decidePlanFinalAnswer(blocked)
  assert.equal(blockedDecision.action, 'allow')
  assert.equal(blockedDecision.reason, 'blocked-items')
  assert.equal(blockedDecision.outcome, 'blocked')
  assert.equal(blockedDecision.completionNudges, 0)
})

test('a nudge followed by reported completion permits a final answer without more nudges', () => {
  const state = accepted(createPlanState(), [task('Only task', 'in_progress')]).state
  const nudged = decidePlanFinalAnswer(state)
  assert.equal(nudged.action, 'nudge')
  const completed = accepted(nudged.state, [task('Only task', 'completed')]).state
  const final = decidePlanFinalAnswer(completed)
  assert.equal(final.action, 'allow')
  assert.equal(final.outcome, 'reported-complete')
  assert.equal(final.completionNudges, 1)
})

test('user-input-needed and aborted stops bypass open-work nudges without consuming budget', () => {
  const state = openPlan()
  const userInput = decidePlanFinalAnswer(state, { userInputNeeded: true })
  assert.equal(userInput.action, 'ask_user')
  assert.equal(userInput.reason, 'user-input-needed')
  assert.equal(userInput.outcome, 'user-input-needed')
  assert.equal(userInput.state, state)
  assert.equal(userInput.completionNudges, 0)
  const aborted = decidePlanFinalAnswer(state, { aborted: true, userInputNeeded: true })
  assert.equal(aborted.action, 'allow')
  assert.equal(aborted.reason, 'aborted')
  assert.equal(aborted.outcome, 'aborted')
  assert.equal(aborted.state, state)
  assert.equal(decidePlanFinalAnswer(state).completionNudges, 1)
})

test('final-gate options are strict and malformed restored states fail closed', () => {
  const state = openPlan()
  for (const options of [null, [], { unknown: true }, { aborted: 'true' }, { userInputNeeded: 1 }]) {
    assert.throws(() => decidePlanFinalAnswer(state, options), { code: 'PLAN_FINAL_OPTIONS_INVALID' })
  }
  const restored = JSON.parse(JSON.stringify(state))
  assert.equal(decidePlanFinalAnswer(restored, { userInputNeeded: true }).action, 'ask_user')
  const invalidStates = [
    {},
    { ...restored, extra: true },
    { ...restored, version: 2 },
    { ...restored, revision: -1 },
    { ...restored, items: [task('One', 'in_progress'), task('Two', 'in_progress')] },
    { ...restored, items: [task('  unnormalized  ', 'completed')] },
    { ...restored, completionNudges: 3 },
    { ...restored, staleReminderCount: 3 },
    { ...restored, activitiesSinceRevision: restored.activityCount + 1 },
    { ...restored, lastStaleReminderActivity: restored.activityCount + 1 },
  ]
  for (const invalid of invalidStates) {
    assert.throws(() => summarizePlan(invalid), { code: 'PLAN_STATE_INVALID' })
  }
})

test('activity and nudge transitions do not freeze or mutate JSON-restored input items', () => {
  const restored = JSON.parse(JSON.stringify(openPlan()))
  const snapshot = JSON.stringify(restored)
  const activity = recordPlanActivity(restored)
  assert.equal(JSON.stringify(restored), snapshot)
  assert.equal(Object.isFrozen(restored.items), false)
  assert.notEqual(activity.state.items, restored.items)
  assert.ok(Object.isFrozen(activity.state.items))
  const final = decidePlanFinalAnswer(restored)
  assert.equal(final.action, 'nudge')
  assert.equal(JSON.stringify(restored), snapshot)
  assert.equal(Object.isFrozen(restored.items), false)
  assert.notEqual(final.state.items, restored.items)
  assert.ok(Object.isFrozen(final.state.items))
})

test('JSON snapshots integrate without sharing mutable item or audit references', () => {
  const initial = JSON.parse(JSON.stringify(openPlan()))
  const initialSnapshot = JSON.stringify(initial)
  const args = {
    items: [task('Inspect current state', 'completed'), task('Apply the requested change', 'in_progress'), task('Check the resulting state')],
    expected_revision: initial.revision,
    reason: 'Inspection reported complete',
  }
  const argsSnapshot = JSON.stringify(args)
  const result = replacePlan(initial, args)
  assert.equal(result.ok, true, result.error?.message)
  assert.equal(JSON.stringify(initial), initialSnapshot)
  assert.equal(JSON.stringify(args), argsSnapshot)
  assert.notEqual(result.state.items, initial.items)
  assert.notEqual(result.audit.items, result.state.items)
  assert.notEqual(result.audit.previousItems, initial.items)
  assert.ok(Object.isFrozen(result.state))
  assert.ok(Object.isFrozen(result.state.items))
  assert.ok(Object.isFrozen(result.audit))
  args.items[0].content = 'Changed after the call'
  assert.equal(result.state.items[0].content, 'Inspect current state')
  assert.equal(result.audit.items[0].content, 'Inspect current state')
})
