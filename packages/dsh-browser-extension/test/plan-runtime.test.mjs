import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlanRuntime } from '../lib/plan-runtime.js'

const task = (content, status = 'pending') => ({ content, status })
const openItems = () => [
  task('Inspect current state', 'in_progress'),
  task('Apply the requested change'),
  task('Verify the resulting state'),
]

function fixture(t) {
  const tools = new Map()
  const activities = []
  const logEvents = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  const bridge = {
    activity: frame => activities.push(frame),
    logEvent: (type, data, severity) => logEvents.push({ type, data, severity }),
  }
  const session = { id: 'session-1' }
  const steered = []
  const agent = {
    session,
    steer: message => steered.push(message),
  }
  const runtime = createPlanRuntime({ ctx, bridge })
  t.after(() => runtime.dispose())
  return { tools, activities, logEvents, session, agent, steered, runtime }
}

function activate(fake, turnId = 'turn-companion-1', seed = undefined) {
  fake.runtime.setMode({ enabled: true, turnId, ...(seed === undefined ? {} : { seed }) })
  fake.runtime.claim(fake.agent, 1)
  assert.equal(fake.tools.has('browser_plan'), true)
}

async function callPlan(fake, args, callId = `plan-${Math.random()}`) {
  fake.runtime.observeToolCall(fake.session, {
    turn: 1,
    callId,
    name: 'browser_plan',
    arguments: JSON.stringify(args),
  })
  let result
  let error
  try {
    result = await fake.tools.get('browser_plan').execute(args, {
      agent: fake.agent,
      callId,
      signal: new AbortController().signal,
    })
  } catch (caught) {
    error = caught
  }
  fake.runtime.observeToolResult(fake.session, {
    turn: 1,
    message: {
      toolCallId: callId,
      content: result?.content ?? [{ type: 'text', text: error?.message ?? 'failed' }],
      isError: error !== undefined,
    },
  })
  return { result, error }
}

function nonPlanResult(fake, index, turn = 1) {
  fake.runtime.observeToolResult(fake.session, {
    turn,
    message: {
      toolCallId: `browser-${turn}-${index}`,
      content: [{ type: 'text', text: 'browser work attempted' }],
      isError: false,
    },
  })
}

async function flushSteering() {
  await Promise.resolve()
  await Promise.resolve()
}

test('normal turns never register browser_plan and planned turns clean it up', t => {
  const fake = fixture(t)
  fake.runtime.claim(fake.agent, 1)
  assert.equal(fake.tools.has('browser_plan'), false)

  fake.runtime.setMode({ enabled: false, turnId: 'ordinary' })
  fake.runtime.claim(fake.agent, 1)
  assert.equal(fake.tools.has('browser_plan'), false)

  activate(fake)
  assert.deepEqual(fake.logEvents.at(-1).data, {
    turnId: 'turn-companion-1', sessionId: 'session-1', turn: 1, revision: 0, seeded: false,
  })
  fake.runtime.setMode({ enabled: true, turnId: 'turn-companion-1' })
  fake.runtime.claim(fake.agent, 1)
  assert.equal(fake.tools.size, 1)

  const data = { turn: 1 }
  fake.runtime.endTurn(fake.session, 1, data)
  assert.equal(data.planOutcome, 'not-assessed')
  assert.equal(data.planRevision, 0)
  assert.equal(fake.tools.has('browser_plan'), false)

  fake.runtime.claim(fake.agent, 2)
  assert.equal(fake.tools.has('browser_plan'), false)
})

test('the registered tool applies guarded revisions and emits structured live updates', async t => {
  const fake = fixture(t)
  activate(fake)
  const initial = await callPlan(fake, { items: openItems(), expected_revision: 0 }, 'plan-initial')
  assert.equal(initial.error, undefined)
  assert.equal(initial.result.structuredContent.revision, 1)
  assert.deepEqual(initial.result.structuredContent.counts, {
    pending: 2, inProgress: 1, completed: 0, blocked: 0, open: 3,
  })
  assert.match(initial.result.content[0].text, /model-reported, not independent verification/)
  assert.deepEqual(fake.activities.at(-1), {
    kind: 'plan', revision: 1, items: openItems(), awaitingUser: false,
  })

  const stale = await callPlan(fake, { items: [task('Replacement', 'in_progress')], expected_revision: 0 })
  assert.match(stale.error?.message, /PLAN_REVISION_CONFLICT/)
  const unchanged = await callPlan(fake, { items: openItems(), expected_revision: 1 })
  assert.match(unchanged.error?.message, /PLAN_UNCHANGED/)
  const removal = await callPlan(fake, {
    items: [task('Apply the requested change', 'in_progress')], expected_revision: 1,
  })
  assert.match(removal.error?.message, /PLAN_OPEN_REMOVAL_REQUIRES_ACK/)

  const progressed = await callPlan(fake, {
    items: [
      task('Inspect current state', 'completed'),
      task('Apply the requested change', 'in_progress'),
      task('Verify the resulting state'),
    ],
    expected_revision: 1,
  })
  assert.equal(progressed.error, undefined)
  assert.equal(progressed.result.structuredContent.revision, 2)
  assert.equal(fake.activities.at(-1).revision, 2)
  assert.equal(fake.activities.filter(frame => frame.kind === 'plan').length, 2)
})

test('non-plan results trigger bounded stale reminders while plan results do not count', async t => {
  const fake = fixture(t)
  activate(fake)
  await callPlan(fake, { items: openItems(), expected_revision: 0 }, 'plan-initial')

  for (let index = 0; index < 5; index += 1) nonPlanResult(fake, index)
  await flushSteering()
  assert.equal(fake.steered.length, 0)
  nonPlanResult(fake, 5)
  await flushSteering()
  assert.equal(fake.steered.length, 1)
  assert.match(fake.steered[0].content[0].text, /Stale-plan reminder 1 of 2/)
  // 'agent-notice', never 'runtime-context': the DSH loop replaces a claimed
  // runtime-context message with its context snapshot, so the nudge text
  // would never reach the model.
  assert.equal(fake.steered[0].source.kind, 'agent-notice')

  for (let index = 6; index < 11; index += 1) nonPlanResult(fake, index)
  await flushSteering()
  assert.equal(fake.steered.length, 1)
  nonPlanResult(fake, 11)
  await flushSteering()
  assert.equal(fake.steered.length, 2)
  assert.match(fake.steered[1].content[0].text, /Stale-plan reminder 2 of 2/)
  for (let index = 12; index < 30; index += 1) nonPlanResult(fake, index)
  await flushSteering()
  assert.equal(fake.steered.length, 2)
})

test('open work receives two final nudges before an unfinished outcome is allowed', async t => {
  const fake = fixture(t)
  activate(fake)
  await callPlan(fake, { items: openItems(), expected_revision: 0 }, 'plan-initial')
  const signal = new AbortController().signal

  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), true)
  assert.equal(fake.steered.length, 1)
  assert.match(fake.steered[0].content[0].text, /Completion nudge 1 of 2/)
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), true)
  assert.equal(fake.steered.length, 2)
  assert.match(fake.steered[1].content[0].text, /Completion nudge 2 of 2/)
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), false)
  assert.equal(fake.steered.length, 2)

  const data = { turn: 1 }
  fake.runtime.endTurn(fake.session, 1, data)
  assert.equal(data.planOutcome, 'unfinished')
  assert.equal(data.planRevision, 1)
  assert.deepEqual(data.planCounts, {
    pending: 2, inProgress: 1, completed: 0, blocked: 0, open: 3,
  })
  assert.equal(fake.tools.has('browser_plan'), false)
})

test('reported completion permits the normal downstream final checks', async t => {
  const fake = fixture(t)
  activate(fake)
  await callPlan(fake, {
    items: [task('Only task', 'in_progress')], expected_revision: 0,
  }, 'plan-initial')
  await callPlan(fake, {
    items: [task('Only task', 'completed')], expected_revision: 1,
  }, 'plan-complete')
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal: new AbortController().signal }), false)
  const data = { turn: 1 }
  fake.runtime.endTurn(fake.session, 1, data)
  assert.equal(data.planOutcome, 'reported-complete')
  assert.equal(data.planRevision, 2)
})

test('an unchanged plan can explicitly wait for user input without completion nudges', async t => {
  const fake = fixture(t)
  activate(fake)
  await callPlan(fake, { items: openItems(), expected_revision: 0 }, 'plan-initial')

  const changed = await callPlan(fake, {
    items: [task('Different work', 'in_progress')], expected_revision: 1, user_input_needed: true,
  })
  assert.match(changed.error?.message, /PLAN_WAIT_UNCHANGED_REQUIRED/)
  const invalid = await callPlan(fake, {
    items: openItems(), expected_revision: 1, user_input_needed: 'true',
  })
  assert.match(invalid.error?.message, /PLAN_WAIT_INVALID/)

  const waiting = await callPlan(fake, {
    items: openItems(), expected_revision: 1, user_input_needed: true,
  }, 'plan-wait')
  assert.equal(waiting.error, undefined)
  assert.equal(waiting.result.structuredContent.revision, 1)
  assert.match(waiting.result.content[0].text, /waiting for user input/i)
  assert.equal(fake.activities.at(-1).awaitingUser, true)
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal: new AbortController().signal }), true)
  assert.equal(fake.steered.length, 0)

  const data = { turn: 1 }
  fake.runtime.endTurn(fake.session, 1, data)
  assert.equal(data.planOutcome, 'user-input-needed')
  assert.equal(data.planRevision, 1)
})

test('waiting for user input requires an actual plan and disposal retires the tool', async t => {
  const fake = fixture(t)
  activate(fake)
  const empty = await callPlan(fake, { items: [], expected_revision: 0, user_input_needed: true })
  assert.match(empty.error?.message, /PLAN_WAIT_REQUIRES_PLAN/)
  fake.runtime.dispose()
  assert.equal(fake.tools.has('browser_plan'), false)
  fake.runtime.setMode({ enabled: true, turnId: 'disposed' })
  fake.runtime.claim(fake.agent, 2)
  assert.equal(fake.tools.has('browser_plan'), false)
})

/* ------------------------------------------------------------------ */
/* M2: carried-plan seeding and the seeded-but-untouched rule          */
/* ------------------------------------------------------------------ */

test('a valid seed starts the turn at the carried revision with fresh budgets', async t => {
  const fake = fixture(t)
  activate(fake, 'turn-carried', { revision: 4, items: openItems() })
  assert.deepEqual(fake.logEvents.at(-1).data, {
    turnId: 'turn-carried', sessionId: 'session-1', turn: 1, revision: 4, seeded: true,
  })
  // The model continues from the carried revision, not from 0.
  const conflict = await callPlan(fake, { items: openItems(), expected_revision: 0 })
  assert.match(conflict.error?.message, /PLAN_REVISION_CONFLICT/)
  assert.match(conflict.error?.message, /current revision 4/)
  const progressed = await callPlan(fake, {
    items: [task('Inspect current state', 'completed'), task('Apply the requested change', 'in_progress'), task('Verify the resulting state')],
    expected_revision: 4,
  }, 'plan-continue')
  assert.equal(progressed.error, undefined)
  assert.equal(progressed.result.structuredContent.revision, 5)
  assert.deepEqual(fake.activities.at(-1), {
    kind: 'plan',
    revision: 5,
    items: [task('Inspect current state', 'completed'), task('Apply the requested change', 'in_progress'), task('Verify the resulting state')],
    awaitingUser: false,
  })
})

test('an invalid seed falls back to an empty plan and logs plan.seed.rejected', async t => {
  const fake = fixture(t)
  activate(fake, 'turn-bad-seed', { revision: 4, items: [task('One', 'in_progress'), task('Two', 'in_progress')] })
  const rejected = fake.logEvents.find(event => event.type === 'plan.seed.rejected')
  assert.ok(rejected, 'the rejection is logged')
  assert.equal(rejected.severity, 'warn')
  assert.deepEqual(fake.logEvents.at(-1).data, {
    turnId: 'turn-bad-seed', sessionId: 'session-1', turn: 1, revision: 0, seeded: false,
  })
  // Fail closed: the model starts at revision 0 and recovers from there.
  const created = await callPlan(fake, { items: openItems(), expected_revision: 0 }, 'plan-fresh')
  assert.equal(created.error, undefined)
  assert.equal(created.result.structuredContent.revision, 1)
})

test('V4: an accepted seed emits exactly ONE seeded plan activity immediately', async t => {
  const fake = fixture(t)
  const items = openItems()
  activate(fake, 'turn-seed-visible', { revision: 4, items })
  // Before any browser_plan call, the seed is visible as one activity.
  assert.equal(fake.activities.length, 1, 'exactly one activity on accepted claim')
  assert.deepEqual(fake.activities[0], { kind: 'plan', revision: 4, items, awaitingUser: false, seeded: true })
})

test('V4: a rejected seed emits NO plan activity (ledger and model see the same empty plan)', async t => {
  const fake = fixture(t)
  // Duplicate contents make seedPlanState reject the seed.
  activate(fake, 'turn-seed-rejected', { revision: 4, items: [task('One', 'in_progress'), task('One', 'in_progress')] })
  assert.ok(fake.logEvents.some(e => e.type === 'plan.seed.rejected'), 'seed rejected')
  assert.equal(fake.activities.length, 0, 'no activity for a rejected seed')
})

test('a seeded but untouched turn allows the answer with not-assessed', async t => {
  const fake = fixture(t)
  activate(fake, 'turn-untouched', { revision: 4, items: openItems() })
  const signal = new AbortController().signal
  // No browser_plan call, no tool results: an unrelated quick question.
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), false)
  assert.equal(fake.steered.length, 0, 'no nudge about the old plan')
  const data = { turn: 1 }
  fake.runtime.endTurn(fake.session, 1, data)
  assert.equal(data.planOutcome, 'not-assessed')
  assert.equal(data.planRevision, 4)
  const final = fake.logEvents.filter(event => event.type === 'plan.final').at(-1)
  assert.equal(final.data.reason, 'seeded-untouched')
})

test('any tool activity on a seeded turn restores the ordinary nudge path', async t => {
  const fake = fixture(t)
  activate(fake, 'turn-touched', { revision: 4, items: openItems() })
  nonPlanResult(fake, 0)
  const signal = new AbortController().signal
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), true)
  assert.match(fake.steered[0].content[0].text, /Completion nudge 1 of 2/)
  assert.match(fake.steered[0].content[0].text, /expected_revision:4/)
})

test('a browser_plan call on a seeded turn also restores the ordinary nudge path', async t => {
  const fake = fixture(t)
  activate(fake, 'turn-plan-call', { revision: 4, items: openItems() })
  // An unchanged-list call is refused (PLAN_UNCHANGED) but still counts as a
  // plan call: the model engaged with the plan, so nudges apply again.
  const unchanged = await callPlan(fake, { items: openItems(), expected_revision: 4 }, 'plan-unchanged')
  assert.match(unchanged.error?.message, /PLAN_UNCHANGED/)
  const signal = new AbortController().signal
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), true)
  assert.match(fake.steered[0].content[0].text, /Completion nudge 1 of 2/)
})

test('an aborted seeded turn still reports aborted, not seeded-untouched', async t => {
  const fake = fixture(t)
  activate(fake, 'turn-aborted', { revision: 4, items: openItems() })
  const controller = new AbortController()
  controller.abort()
  // Aborted stops bypass the seeded-untouched rule and keep the aborted outcome.
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal: controller.signal }), true)
  assert.equal(fake.steered.length, 0)
  const data = { turn: 1 }
  fake.runtime.endTurn(fake.session, 1, data)
  assert.equal(data.planOutcome, 'aborted')
  const final = fake.logEvents.filter(event => event.type === 'plan.final').at(-1)
  assert.equal(final.data.reason, 'aborted')
})

test('accepted revisions refill stretch budgets inside the runtime too', async t => {
  const fake = fixture(t)
  activate(fake)
  await callPlan(fake, { items: openItems(), expected_revision: 0 }, 'plan-initial')
  const signal = new AbortController().signal
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), true)
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), true)
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), false)
  assert.equal(fake.steered.length, 2)
  // An accepted revision refills: two more nudges are allowed this turn.
  await callPlan(fake, {
    items: [task('Inspect current state', 'completed'), task('Apply the requested change', 'in_progress'), task('Verify the resulting state')],
    expected_revision: 1,
  }, 'plan-revise')
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), true)
  assert.match(fake.steered[2].content[0].text, /Completion nudge 1 of 2 this stretch; 3 of 12 this turn/)
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), true)
  assert.equal(fake.runtime.stopping({ agent: fake.agent, turn: 1, signal }), false)
  assert.equal(fake.steered.length, 4)
})
